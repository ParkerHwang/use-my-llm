import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ForkRecord } from '../context/types.mjs';
import { CONTEXT_NOTICE, promptData, validContext, type ContextEntry } from './prompt.mjs';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 750;
const POSIX = process.platform !== 'win32';

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeOptions {
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
  '--bare',
  '--input-format', 'text',
  '--output-format', 'json',
  '--restricted',
  '--safe-mode',
  '--tools', '',
  '--disallowedTools', '*',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--permission-prompts', 'none',
  '--no-chrome',
  '--no-session-persistence',
];

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ERRORS = {
  CONTEXT_UNAVAILABLE: 'This shared conversation cannot be continued.',
  INVALID_REQUEST: 'Invalid Claude message or conversation history.',
  PROVIDER_UNAVAILABLE: 'Local Claude Code requires an executable and a locally configured API key.',
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
  const paths = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  paths.push(join(homedir(), '.local', 'bin'));
  return paths.map(path => join(path, name)).find(isExecutable) ?? null;
}

export function claudeApiKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.hasOwn(env, 'ANTHROPIC_API_KEY');
}

function apiOnlyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = Object.create(null);
  for (const name of CHILD_ENV_KEYS) {
    if (Object.hasOwn(env, name)) childEnv[name] = env[name];
  }
  if (typeof childEnv.ANTHROPIC_API_KEY !== 'string' || !childEnv.ANTHROPIC_API_KEY) {
    throw failure('PROVIDER_UNAVAILABLE');
  }
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
): Promise<string> {
  if (signal?.aborted) throw failure('PROVIDER_ABORTED');
  let child: ChildProcessByStdio<Writable, Readable, null>;
  try {
    child = spawn(executable, [...PRINT_ARGS, ...extraArgs], {
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

export interface ClaudeForkOptions {
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
 * API key mode only: `--bare` never reads OAuth or keychain credentials, and
 * the child environment carries `ANTHROPIC_API_KEY` and nothing else that
 * could select a subscription login. Without a key this fails closed.
 */
export async function forkClaude({
  fork, message, context, signal, executable = findClaude(), env = process.env,
}: ClaudeForkOptions = {}): Promise<ClaudeReply> {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('INVALID_REQUEST');
  if (signal?.aborted) throw failure('PROVIDER_ABORTED');
  const input = formatPrompt(message, undefined, context);
  if (fork?.provider !== 'claude' || !SESSION_ID.test(fork.sessionId)
    || !isAbsolute(fork.configDir) || !isAbsolute(fork.cwd)) throw failure('CONTEXT_UNAVAILABLE');
  if (!isExecutable(executable)) throw failure('PROVIDER_UNAVAILABLE');
  const childEnv = apiOnlyEnvironment(env);
  childEnv.CLAUDE_CONFIG_DIR = fork.configDir;
  try {
    if (!statSync(fork.cwd).isDirectory()) throw new Error('missing');
  } catch {
    throw failure('CONTEXT_UNAVAILABLE');
  }
  const reply = await execute(executable, fork.cwd, input, signal, childEnv, ['--resume', fork.sessionId, '--fork-session']);
  return { provider: 'claude', reply };
}

export async function runClaude({
  message, history = [], context, signal, executable = findClaude(), cwd, env = process.env,
}: ClaudeOptions = {}): Promise<ClaudeReply> {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('INVALID_REQUEST');
  if (signal?.aborted) throw failure('PROVIDER_ABORTED');
  const input = formatPrompt(message, history, context);
  if (!isExecutable(executable)) throw failure('PROVIDER_UNAVAILABLE');
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    throw failure('INVALID_REQUEST');
  }
  const childEnv = apiOnlyEnvironment(env);

  let temporary: string | undefined;
  if (cwd === undefined) {
    try {
      temporary = await mkdtemp(join(tmpdir(), 'use-my-llm-claude-'));
    } catch {
      throw failure('PROVIDER_FAILED');
    }
  }

  try {
    const reply = await execute(executable, cwd ?? temporary, input, signal, childEnv);
    return { provider: 'claude', reply };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}
