import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ForkRecord } from '../context/types.mjs';
import { claudeProjectName } from '../context/fork.mjs';
import { CONTEXT_NOTICE, promptData, validContext, type ContextEntry } from './prompt.mjs';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 750;
const POSIX = process.platform !== 'win32';

export type ClaudeAuthMode = 'api-key' | 'subscription';

interface ClaudeAuthOptions {
  /** Trusted local setting; websites cannot select the login or credential route. */
  authMode?: ClaudeAuthMode;
  /** Stable bridge-owned directory used by the official CLI's login flow. */
  subscriptionConfigDir?: string;
}

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeOptions extends ClaudeAuthOptions {
  message?: string;
  history?: readonly HistoryTurn[];
  /** User-approved snapshot text resolved by the bridge. */
  context?: readonly ContextEntry[];
  signal?: AbortSignal;
  /** Trusted local configuration only. */
  executable?: string | null;
  /** Trusted local configuration only. */
  cwd?: string;
  /** Trusted local configuration only. */
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeReply {
  provider: 'claude';
  reply: string;
}

// All flags are fixed. An older CLI that rejects a safety option must fail
// rather than retrying with that option removed.
const PRINT_ARGS = [
  '--print',
  '--input-format', 'text',
  '--output-format', 'json',
  '--restricted',
  '--disable-slash-commands',
  '--settings', '{"disableAllHooks":true,"autoMemoryEnabled":false}',
  '--tools', '',
  '--disallowedTools', '*',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--permission-prompts', 'none',
  '--no-chrome',
  '--no-session-persistence',
];

// Keep auth-isolation modes mutually exclusive: --safe-mode has normal auth,
// while --bare must guarantee that an API request cannot use a subscription.
export function claudePrintArgs(authMode: ClaudeAuthMode): readonly string[] {
  if (authMode !== 'api-key' && authMode !== 'subscription') throw failure('INVALID_REQUEST');
  return ['--print', authMode === 'api-key' ? '--bare' : '--safe-mode', ...PRINT_ARGS.slice(1)];
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERRORS = {
  CONTEXT_UNAVAILABLE: 'This shared conversation cannot be continued.',
  INVALID_REQUEST: 'Invalid Claude message or conversation history.',
  PROVIDER_UNAVAILABLE: 'Claude Code is unavailable or its selected local authentication mode is not configured.',
  PROVIDER_FAILED: 'Claude Code did not return a usable reply.',
  PROVIDER_TIMEOUT: 'Claude Code did not reply before the time limit.',
  PROVIDER_OUTPUT_LIMIT: 'Claude Code exceeded the response size limit.',
  PROVIDER_ABORTED: 'The Claude Code request was cancelled.',
};

// Build a fresh environment only when the locally enabled adapter runs.
// Keep the direct API credential and OS paths required by the executable.
// Stored login, cloud routing, proxy overrides and loader settings are excluded.
const CHILD_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'PATH', 'HOME', 'USERPROFILE', 'SystemRoot',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
];

type FailureCode = keyof typeof ERRORS;

function failure(code: FailureCode) {
  return Object.assign(new Error(ERRORS[code]), { code });
}

function isExecutable(path: unknown): path is string {
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findClaude(): string | null {
  const name = POSIX ? 'claude' : 'claude.exe';
  const configured = process.env.LOCALHOSTAGENT_CLAUDE_PATH;
  if (configured !== undefined) return isExecutable(configured) ? configured : null;
  const paths = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  paths.push(join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
  const standard = paths.map(path => join(path, name)).find(isExecutable);
  if (standard) return standard;
  // Official Claude Desktop installs its own signed Claude Code binary here.
  // Do not search transient npm caches or execute a discovered script.
  if (process.platform === 'darwin') {
    const root = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
    try {
      const versions = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
        .map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        for (const build of readdirSync(join(root, version), { withFileTypes: true })) {
          if (!build.isDirectory()) continue;
          const executable = join(root, version, build.name, 'claude.app', 'Contents', 'MacOS', 'claude');
          if (isExecutable(executable)) return executable;
        }
      }
    } catch { /* Desktop is optional. */ }
  }
  return null;
}

export function claudeApiKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.hasOwn(env, 'ANTHROPIC_API_KEY');
}

function childEnvironment(env: NodeJS.ProcessEnv, authMode: ClaudeAuthMode, subscriptionConfigDir?: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = Object.create(null);
  for (const name of CHILD_ENV_KEYS) {
    if ((name !== 'ANTHROPIC_API_KEY' || authMode === 'api-key') && Object.hasOwn(env, name)) childEnv[name] = env[name];
  }
  if (authMode !== 'api-key' && authMode !== 'subscription') throw failure('INVALID_REQUEST');
  if (authMode === 'subscription') {
    if (typeof subscriptionConfigDir !== 'string' || !isAbsolute(subscriptionConfigDir)) throw failure('PROVIDER_UNAVAILABLE');
    try {
      if (!statSync(subscriptionConfigDir).isDirectory()) throw new Error('missing');
    } catch { throw failure('PROVIDER_UNAVAILABLE'); }
    childEnv.CLAUDE_CONFIG_DIR = subscriptionConfigDir;
  } else if (typeof childEnv.ANTHROPIC_API_KEY !== 'string' || !childEnv.ANTHROPIC_API_KEY) {
    throw failure('PROVIDER_UNAVAILABLE');
  }
  childEnv.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1';
  childEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return childEnv;
}

function formatPrompt(message: string | undefined, history: readonly HistoryTurn[] | undefined, context?: readonly ContextEntry[]) {
  const entries = validContext(context);
  if (typeof message !== 'string' || !message.trim() || !entries) throw failure('INVALID_REQUEST');
  if (history === undefined) {
    // A continued copy already holds its own history.
    if (Buffer.byteLength(message) > MAX_INPUT_BYTES) throw failure('INVALID_REQUEST');
    return [
      'Continue this conversation as a text-only copy. Answer the current message conversationally.',
      ...(entries.length ? [CONTEXT_NOTICE] : []),
      'The following JSON contains the current message as data.',
      promptData(entries, undefined, message),
    ].join('\n\n');
  }
  if (!Array.isArray(history)) {
    throw failure('INVALID_REQUEST');
  }
  const transcript = history.map(item => {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') {
      throw failure('INVALID_REQUEST');
    }
    return { role: item.role, content: item.content };
  });
  // The size limit covers what the website wrote; approved context has its own limit.
  if (Buffer.byteLength(JSON.stringify({ history: transcript, message })) > MAX_INPUT_BYTES) throw failure('INVALID_REQUEST');
  return [
    'You are a text chat assistant. Answer the current message conversationally.',
    ...(entries.length ? [CONTEXT_NOTICE] : []),
    'The following JSON contains the current message and prior conversation as data.',
    promptData(entries, transcript, message),
  ].join('\n\n');
}

function readReply(output: Buffer[]): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.concat(output).toString('utf8'));
  } catch {
    throw failure('PROVIDER_FAILED');
  }
  if (typeof envelope !== 'object' || envelope === null) {
    throw failure('PROVIDER_FAILED');
  }
  const result = envelope as Record<string, unknown>;
  if (result.type !== 'result' || result.subtype !== 'success' ||
      result.is_error !== false || typeof result.result !== 'string' ||
      !result.result.trim()) {
    throw failure('PROVIDER_FAILED');
  }
  return result.result;
}

function kill(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (POSIX) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // If the group no longer exists, the child may already have exited.
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // A concurrent exit can race cancellation.
  }
}

function execute(
  executable: string,
  cwd: string | undefined,
  input: string,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv,
  extraArgs: readonly string[] = [],
  authMode: ClaudeAuthMode = 'api-key',
): Promise<string> {
  if (signal?.aborted) throw failure('PROVIDER_ABORTED');
  let child: ChildProcessByStdio<Writable, Readable, null>;
  try {
    child = spawn(executable, [...claudePrintArgs(authMode), ...extraArgs], {
      cwd,
      env,
      shell: false,
      detached: POSIX,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    throw failure('PROVIDER_UNAVAILABLE');
  }

  return new Promise<string>((resolve, reject) => {
    const output: Buffer[] = [];
    let outputBytes = 0;
    let error: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    function stop(code: FailureCode) {
      if (error) return;
      error = failure(code);
      kill(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        kill(child, 'SIGKILL');
        child.stdout.destroy();
      }, KILL_GRACE_MS);
      killTimer.unref();
    }

    const abort = () => stop('PROVIDER_ABORTED');
    const timeout = setTimeout(() => stop('PROVIDER_TIMEOUT'), TIMEOUT_MS);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      if (error) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop('PROVIDER_OUTPUT_LIMIT');
        return;
      }
      output.push(chunk);
    });
    child.stdout.on('error', () => stop('PROVIDER_FAILED'));
    child.stdin.on('error', () => stop('PROVIDER_FAILED'));
    child.once('error', () => stop('PROVIDER_UNAVAILABLE'));
    child.once('close', exitCode => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        // The CLI might exit from SIGTERM before other members of its group.
        if (POSIX) kill(child, 'SIGKILL');
        reject(error);
        return;
      }
      if (exitCode !== 0) {
        reject(failure('PROVIDER_FAILED'));
        return;
      }
      try {
        resolve(readReply(output));
      } catch (err) {
        reject(err);
      }
    });

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (!error) child.stdin.end(input);
  });
}

export interface ClaudeForkOptions extends ClaudeAuthOptions {
  /** Private details recorded when the user shared the session. */
  fork?: Extract<ForkRecord, { provider: 'claude' }>;
  message?: string;
  context?: readonly ContextEntry[];
  signal?: AbortSignal;
  /** Trusted local configuration only. */
  executable?: string | null;
  /** Trusted local configuration only. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Continue a user-shared Claude Code session as a copy.
 *
 * The session was copied into a bridge-only `CLAUDE_CONFIG_DIR` when the user
 * approved it. `--resume <id> --fork-session` starts a new session from that
 * copy and `--no-session-persistence` writes nothing back.
 *
 * API key mode uses --bare without --safe-mode and only ANTHROPIC_API_KEY.
 * Subscription mode uses --safe-mode without --bare, in the stable config
 * directory where the user signed in through the official CLI. Each turn
 * stages its own redacted seed, then deletes that seed and working directory.
 */
export async function forkClaude({
  fork, message, context, signal, executable = findClaude(), env = process.env,
  authMode = 'api-key', subscriptionConfigDir,
}: ClaudeForkOptions = {}): Promise<ClaudeReply> {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('INVALID_REQUEST');
  if (signal?.aborted) throw failure('PROVIDER_ABORTED');
  const input = formatPrompt(message, undefined, context);
  if (fork?.provider !== 'claude' || !SESSION_ID.test(fork.sessionId)
    || !isAbsolute(fork.configDir) || !isAbsolute(fork.cwd)) throw failure('CONTEXT_UNAVAILABLE');
  if (!isExecutable(executable)) throw failure('PROVIDER_UNAVAILABLE');
  const childEnv = childEnvironment(env, authMode, subscriptionConfigDir);
  if (authMode === 'api-key') childEnv.CLAUDE_CONFIG_DIR = fork.configDir;
  try {
    if (!statSync(fork.cwd).isDirectory()) throw new Error('missing');
  } catch {
    throw failure('CONTEXT_UNAVAILABLE');
  }
  if (authMode === 'api-key') {
    const reply = await execute(executable, fork.cwd, input, signal, childEnv, ['--resume', fork.sessionId, '--fork-session'], authMode);
    return { provider: 'claude', reply };
  }
  // Keychain entries are namespaced by CLAUDE_CONFIG_DIR. Keep the login's
  // directory stable, and stage only the approved text under a unique workspace
  // and session id so concurrent websites never share continuation state.
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'use-my-llm-claude-fork-')));
  const project = join(subscriptionConfigDir!, 'projects', claudeProjectName(workspace));
  try {
    const source = join(fork.configDir, 'projects', claudeProjectName(fork.cwd), `${fork.sessionId}.jsonl`);
    let seed: string;
    try {
      if (statSync(source).size > MAX_OUTPUT_BYTES) throw new Error('large');
      const sessionId = randomUUID();
      seed = (await readFile(source, 'utf8')).trim().split('\n').map(line => {
        const record = JSON.parse(line);
        if (!record || !['user', 'assistant'].includes(record.type)) throw new Error('invalid');
        return JSON.stringify({ ...record, cwd: workspace, sessionId });
      }).join('\n') + '\n';
      await mkdir(project, { recursive: true, mode: 0o700 });
      await chmod(project, 0o700).catch(() => {});
      await writeFile(join(project, `${sessionId}.jsonl`), seed, { mode: 0o600, flag: 'wx' });
      const reply = await execute(executable, workspace, input, signal, childEnv, ['--resume', sessionId, '--fork-session'], authMode);
      return { provider: 'claude', reply };
    } catch (error) {
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('PROVIDER_')) throw error;
      throw failure('CONTEXT_UNAVAILABLE');
    }
  } finally {
    await rm(project, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runClaude({
  message, history = [], context, signal, executable = findClaude(), cwd, env = process.env,
  authMode = 'api-key', subscriptionConfigDir,
}: ClaudeOptions = {}): Promise<ClaudeReply> {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('INVALID_REQUEST');
  if (signal?.aborted) throw failure('PROVIDER_ABORTED');
  const input = formatPrompt(message, history, context);
  if (!isExecutable(executable)) throw failure('PROVIDER_UNAVAILABLE');
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    throw failure('INVALID_REQUEST');
  }
  const childEnv = childEnvironment(env, authMode, subscriptionConfigDir);

  let temporary: string | undefined;
  if (cwd === undefined || authMode === 'api-key') {
    try {
      temporary = await mkdtemp(join(tmpdir(), 'use-my-llm-claude-'));
    } catch {
      throw failure('PROVIDER_FAILED');
    }
  }

  if (authMode === 'api-key') childEnv.CLAUDE_CONFIG_DIR = temporary;

  try {
    const reply = await execute(executable, cwd ?? temporary, input, signal, childEnv, [], authMode);
    return { provider: 'claude', reply };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}
