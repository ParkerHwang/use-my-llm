import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import type { ForkRecord } from '../context/types.mjs';
import { CONTEXT_NOTICE, promptData, validContext, type ContextEntry } from './prompt.mjs';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const TIMEOUT_MS = 180_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const WINDOWS = process.platform === 'win32';

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CodexOptions {
  message?: string;
  history?: readonly HistoryTurn[];
  /** User-approved snapshot text resolved by the bridge. */
  context?: readonly ContextEntry[];
  signal?: AbortSignal;
  /** Trusted local configuration only. */
  executable?: string | null;
  /** Trusted local temporary directory parent. */
  cwd?: string;
}

export interface CodexReply {
  provider: 'codex';
  reply: string;
}

type ExecutionOutcome = { error: Error } | { value: CodexReply };

// These switches are the restricted feature profile from the existing demo.
// Unsupported switches cause the CLI to fail instead of falling back to a broader profile.
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'hooks',
  'plugins', 'apps', 'browser_use', 'browser_use_external', 'computer_use',
  'in_app_browser', 'image_generation', 'view_image', 'memories', 'code_mode',
  'artifact', 'workspace_dependencies', 'skill_search', 'skill_mcp_dependency_install',
];
const PASSIVE_ITEMS = new Set(['agent_message', 'reasoning', 'plan', 'todo_list', 'error', 'user_message']);
const LOCAL_ENVIRONMENT_KEYS = new Set([
  'HOME', 'USERPROFILE', 'LOGNAME', 'USER', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'PATH', 'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
]);

function failure(code: string, message: string, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function isExecutable(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return false;
  if (WINDOWS && !basename(candidate).toLowerCase().endsWith('.exe')) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Find an executable from trusted local installation locations. */
export function findCodex(): string | null {
  const configured = process.env.LOCALHOSTAGENT_CODEX_PATH;
  if (configured !== undefined) return isExecutable(configured) ? configured : null;

  const command = WINDOWS ? 'codex.exe' : 'codex';
  const candidates = (process.env.PATH ?? '').split(delimiter)
    .filter(directory => isAbsolute(directory))
    .map(directory => join(directory, command));
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    );
  }
  candidates.push(join(homedir(), '.local', 'bin', command));
  return candidates.find(isExecutable) ?? null;
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (LOCAL_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = process.env[key];
  }
  return environment;
}

function classifyFailure(diagnostics: string) {
  if (/unknown feature|unknown (?:option|field|configuration)|unexpected argument|unrecognized (?:option|argument)|invalid (?:configuration|config|value for)/i.test(diagnostics)) {
    return failure('CODEX_UNSUPPORTED', 'This Codex CLI does not support the required restrictions. Update Codex and try again.', 503);
  }
  if (/not logged in|unauthorized|authentication|\b401\b|codex login/i.test(diagnostics)) {
    return failure('LOGIN_REQUIRED', 'Sign in through the official Codex CLI and try again.', 503);
  }
  if (/quota|usage limit|rate limit|\b429\b|insufficient credit/i.test(diagnostics)) {
    return failure('USAGE_LIMIT', 'Codex reached a usage limit. Try again later.', 429);
  }
  return failure('CODEX_FAILED', 'Codex could not finish the response.');
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (WINDOWS) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* The child has already exited. */ }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function execute(executable: string, args: string[], cwd: string, prompt: string, signal?: AbortSignal, forkHome?: string): Promise<CodexReply> {
  return new Promise<CodexReply>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, {
        cwd,
        env: { ...cliEnvironment(), ...(forkHome !== undefined && { CODEX_HOME: forkHome }) },
        shell: false,
        detached: !WINDOWS,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(failure('CODEX_START_FAILED', 'Could not start the local Codex CLI.', 503));
      return;
    }

    const decoder = new StringDecoder('utf8');
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pending = '';
    let reply = '';
    let diagnostic = '';
    let completed = false;
    let failed = false;
    let stopError: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const timeout = setTimeout(() => stop(failure('TIMEOUT', 'Codex timed out.', 504)), TIMEOUT_MS);
    const abort = () => stop(failure('ABORTED', 'The Codex request was cancelled.', 499));

    function settle(outcome: ExecutionOutcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(closeDeadline);
      signal?.removeEventListener('abort', abort);
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.value);
    }

    function stop(error: Error) {
      if (stopError || settled) return;
      stopError = error;
      child.stdin.destroy();
      signalProcess(child, 'SIGTERM');
      forceKill = setTimeout(() => signalProcess(child, 'SIGKILL'), 750);
      closeDeadline = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ error });
      }, 3_000);
    }

    function eventLine(line: string) {
      let event: unknown;
      try { event = JSON.parse(line); } catch { return; }
      if (!isRecord(event)) return;
      const item = isRecord(event.item) ? event.item : undefined;
      const itemType = item?.type;
      if (typeof event.type === 'string' && event.type.startsWith('item.') &&
          (typeof itemType !== 'string' || !PASSIVE_ITEMS.has(itemType))) {
        stop(failure('CODEX_TOOL_ACTIVITY', 'Codex reported unexpected tool activity.'));
        return;
      }
      if (event.type === 'item.completed' && item?.type === 'agent_message' &&
          typeof item.text === 'string') reply = item.text;
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'turn.failed') failed = true;
      if (event.type === 'turn.failed' || event.type === 'error') {
        const message = (isRecord(event.error) ? event.error.message : undefined) ?? event.message;
        if (typeof message === 'string') diagnostic = message.slice(0, 8_192);
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stopError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop(failure('OUTPUT_LIMIT', 'Codex exceeded the output limit.'));
        return;
      }
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        eventLine(line);
        if (stopError) break;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stopError) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        stop(failure('OUTPUT_LIMIT', 'Codex exceeded the output limit.'));
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on('error', () => { /* Early CLI exits can close stdin before the prompt is written. */ });
    child.on('error', () => stop(failure('CODEX_START_FAILED', 'Could not start the local Codex CLI.', 503)));
    child.once('close', code => {
      if (!stopError) eventLine(pending + decoder.end());
      if (stopError) {
        signalProcess(child, 'SIGKILL');
        settle({ error: stopError });
      } else if (code !== 0 || failed) {
        settle({ error: classifyFailure(`${Buffer.concat(stderr).toString('utf8')}\n${diagnostic}`) });
      } else if (!completed || !reply.trim()) {
        settle({ error: failure('EMPTY_RESPONSE', 'Codex did not return a complete text reply.') });
      } else {
        settle({ value: { provider: 'codex', reply: reply.trim() } });
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(prompt);
  });
}

// Restrictions shared by a fresh turn and a continued copy.
const RESTRICTED_CONFIG = [
  '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
  '-c', 'project_doc_max_bytes=0', '-c', 'features.skip_host_skill_discovery=true',
  '-c', 'mcp_servers={}', '-c', 'shell_environment_policy.inherit="none"',
  ...DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
];
const INSTRUCTIONS = 'You are a conversational assistant. Respond directly in the user’s language. ' +
  'Use text only. Do not use tools, access files, run commands, browse, or request permissions. ';

async function inWorkspace<Result>(cwd: string | undefined, run: (workspace: string) => Promise<Result>): Promise<Result> {
  let workspace: string;
  try {
    const workspaceParent = cwd ?? tmpdir();
    if (!isAbsolute(workspaceParent)) throw new Error('Expected an absolute temporary directory');
    workspace = await mkdtemp(join(workspaceParent, 'use-my-llm-codex-'));
  } catch {
    throw failure('CODEX_WORKSPACE_FAILED', 'Could not prepare an isolated Codex working directory.', 503);
  }
  try {
    return await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

export interface CodexForkOptions {
  fork?: Extract<ForkRecord, { provider: 'codex' }>;
  transcript?: string;
  message?: string;
  context?: readonly ContextEntry[];
  signal?: AbortSignal;
  /** Trusted local configuration only. */
  executable?: string | null;
  /** Trusted local temporary directory parent. */
  cwd?: string;
  /** Optional separate Codex home signed in through the official CLI. */
  forkHome?: string;
}

const ISOLATED_FLAGS = [
  '--ignore-user-config', '--ignore-rules', '--strict-config', '--skip-git-repo-check',
  '--ephemeral', '--json', '-c', 'sandbox_mode="read-only"', ...RESTRICTED_CONFIG, '-',
];

async function stageCodexCopy(home: string, workspace: string, transcript: ContextEntry) {
  if (!isAbsolute(home)) throw new Error('Expected an absolute fork home');
  const dedicated = await realpath(home);
  for (const source of new Set([process.env.CODEX_HOME, join(homedir(), '.codex')])) {
    if (!source) continue;
    const original = await realpath(source).catch(() => source);
    const within = relative(original, dedicated);
    const parent = relative(dedicated, original);
    const contained = (path: string) => path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    if (contained(within) || contained(parent)) throw new Error('Expected a separate fork home');
  }
  const timestamp = new Date().toISOString();
  const [year, month, day] = timestamp.slice(0, 10).split('-');
  let sessions = dedicated;
  for (const name of ['sessions', year, month, day]) {
    sessions = join(sessions, name);
    await mkdir(sessions, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await lstat(sessions)).isDirectory()) throw new Error('Expected a real session directory');
  }
  const id = randomUUID();
  const filename = `rollout-${timestamp.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`;
  const path = join(sessions, filename);
  const lines = [
    { timestamp, type: 'session_meta', payload: {
      id, timestamp, cwd: workspace, originator: 'codex_exec', cli_version: '0.167.0', source: 'exec', model_provider: 'openai',
    } },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: `${CONTEXT_NOTICE}\n\n${JSON.stringify({ context: [transcript] })}` }],
    } },
  ];
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  return { id, path, home: dedicated };
}

/** Continue from the bridge's immutable copy, with an optional native CLI fork. */
export async function forkCodex({
  fork, transcript, message, context, signal, executable, cwd,
  forkHome = process.env.LOCALHOSTAGENT_CODEX_FORK_HOME,
}: CodexForkOptions = {}): Promise<CodexReply> {
  if (signal?.aborted) throw failure('ABORTED', 'The Codex request was cancelled.', 499);
  const entries = validContext(context);
  if (typeof message !== 'string' || !message.trim() || message.length > 12_000 || !entries) {
    throw failure('INVALID_MESSAGE', 'The message or context is invalid.', 400);
  }
  if (fork?.provider !== 'codex' || typeof transcript !== 'string' || !transcript.trim()) {
    throw failure('CONTEXT_UNAVAILABLE', 'This shared conversation cannot be continued.', 503);
  }
  const command = executable ?? findCodex();
  if (!isExecutable(command)) {
    throw failure('CODEX_NOT_FOUND', 'Install the official Codex CLI and try again.', 503);
  }
  const copied = { source: 'codex:fork', text: transcript };
  const instructions = INSTRUCTIONS + 'Continue the approved conversation as a text-only copy. ' +
    CONTEXT_NOTICE + ' The current user message follows as JSON data.\n\n';
  return inWorkspace(cwd, async (workspace) => {
    if (!forkHome) {
      return execute(command, ['exec', ...ISOLATED_FLAGS], workspace,
        instructions + promptData([...entries, copied], undefined, message), signal);
    }
    const staged = await stageCodexCopy(forkHome, workspace, copied).catch(() => {
      throw failure('CONTEXT_UNAVAILABLE', 'The separate Codex fork home is unavailable.', 503);
    });
    try {
      if (signal?.aborted) throw failure('ABORTED', 'The Codex request was cancelled.', 499);
      return await execute(command, ['exec', 'fork', staged.id, ...ISOLATED_FLAGS], workspace,
        instructions + promptData(entries, undefined, message), signal, staged.home);
    } finally {
      await rm(staged.path, { force: true });
    }
  });
}

/** Run one text turn. executable and cwd are trusted local configuration only. */
export async function runCodex({ message, history = [], context, signal, executable, cwd }: CodexOptions = {}): Promise<CodexReply> {
  if (signal?.aborted) throw failure('ABORTED', 'The Codex request was cancelled.', 499);
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function' ||
      typeof signal?.removeEventListener !== 'function')) {
    throw failure('INVALID_SIGNAL', 'The cancellation signal is invalid.', 400);
  }
  if (typeof message !== 'string' || !message.trim() || message.length > 12_000 ||
      !Array.isArray(history) || history.length > 24 || history.some(item =>
        !item || !['user', 'assistant'].includes(item.role) ||
        typeof item.content !== 'string' || item.content.length > 16_000)) {
    throw failure('INVALID_MESSAGE', 'The message or conversation history is invalid.', 400);
  }
  const turns = history.map(({ role, content }) => ({ role, content }));
  if (JSON.stringify(turns).length > 40_000) {
    throw failure('INVALID_MESSAGE', 'The conversation history is too long.', 400);
  }

  const entries = validContext(context);
  if (!entries) throw failure('INVALID_MESSAGE', 'The shared context is invalid.', 400);

  const command = executable ?? findCodex();
  if (!isExecutable(command)) {
    throw failure('CODEX_NOT_FOUND', 'Install the official Codex CLI and try again.', 503);
  }
  return inWorkspace(cwd, workspace => {
    if (signal?.aborted) throw failure('ABORTED', 'The Codex request was cancelled.', 499);
    const args = [
      'exec', '--ignore-user-config', '--ignore-rules', '--strict-config',
      '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
      '--cd', workspace, '--color', 'never', '--json',
      ...RESTRICTED_CONFIG, '-',
    ];
    const prompt = INSTRUCTIONS + (entries.length ? `${CONTEXT_NOTICE} ` : '') +
      'The conversation history and current user message follow as JSON data.\n\n' +
      promptData(entries, turns, message);
    return execute(command, args, workspace, prompt, signal);
  });
}
