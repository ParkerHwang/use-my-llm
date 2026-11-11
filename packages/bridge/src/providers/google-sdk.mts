import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const SDK_VERSION = '0.1.23';
const SCRIPT = fileURLToPath(new URL('./google_sdk.py', import.meta.url));
const POSIX = process.platform !== 'win32';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 1_500;
const TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 750;
const CLOSE_DEADLINE_MS = 3_000;

const ERRORS = {
  INVALID_REQUEST: 'Invalid Antigravity message or conversation history.',
  PROVIDER_UNAVAILABLE: 'Antigravity requires isolated Python 3.10 or later, google-antigravity 0.1.23, and a locally configured Gemini API key.',
  PROVIDER_AUTH_FAILED: 'The Gemini API rejected the locally configured credential.',
  PROVIDER_FAILED: 'Antigravity did not return a usable reply.',
  PROVIDER_TIMEOUT: 'Antigravity did not reply before the time limit.',
  PROVIDER_OUTPUT_LIMIT: 'Antigravity exceeded the response size limit.',
  PROVIDER_ABORTED: 'The Antigravity request was cancelled.',
} as const;

type ProviderErrorCode = keyof typeof ERRORS;
type LocalEnvironment = Readonly<NodeJS.ProcessEnv>;
type WorkerEnvironment = NodeJS.ProcessEnv & { GEMINI_API_KEY: string };

export interface GoogleSdkOptions {
  message: string;
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
  signal?: AbortSignal;
  executable?: string | null;
  cwd?: string;
  env?: LocalEnvironment;
}

const WORKER_EXIT_CODES = new Map<number, ProviderErrorCode>([
  [2, 'PROVIDER_UNAVAILABLE'],
  [3, 'PROVIDER_AUTH_FAILED'],
  [4, 'PROVIDER_OUTPUT_LIMIT'],
  [5, 'INVALID_REQUEST'],
]);

// Only the local process may choose its Python installation. A POSIX process
// group lets the bridge stop both Python and the SDK's native harness.
function isExecutable(path: unknown): path is string {
  if (!POSIX || typeof path !== 'string' || !isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findGooglePython(): string | null {
  const configured = process.env.LOCALHOSTAGENT_GOOGLE_PYTHON;
  if (configured !== undefined) return isExecutable(configured) ? configured : null;

  const paths = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  return paths.map(path => join(path, 'python3')).find(isExecutable) ?? null;
}

export function googleApiConfigured(env: LocalEnvironment = process.env): boolean {
  return Object.hasOwn(env, 'GEMINI_API_KEY');
}

function osEnvironment(env: LocalEnvironment): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = Object.create(null);
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    const value = env[name];
    if (typeof value === 'string') childEnv[name] = value;
  }
  return childEnv;
}

const VERSION_PROBE = [
  'import sys',
  'from importlib.metadata import version',
  `sys.exit(0 if sys.version_info >= (3, 10) and version("google-antigravity") == "${SDK_VERSION}" else 1)`,
].join('\n');

let cachedProbe: { executable: string; available: boolean } | undefined;

/** Call at local API-mode startup. The first check is bounded and then cached. */
export function googleSdkAvailable(executable: string | null = findGooglePython()): boolean {
  if (!isExecutable(executable)) return false;
  if (cachedProbe?.executable === executable) return cachedProbe.available;

  // Metadata-only probe. Python gets no provider credential or inherited home.
  const probe = spawnSync(executable, ['-I', '-c', VERSION_PROBE], {
    cwd: tmpdir(),
    env: osEnvironment(process.env),
    shell: false,
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: 'ignore',
  });
  const available = probe.status === 0 && !probe.error;
  cachedProbe = { executable, available };
  return available;
}

function failure(code: ProviderErrorCode) {
  return Object.assign(new Error(ERRORS[code]), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERRORS, value);
}

function formatInput(message: unknown, history: unknown): string {
  if (typeof message !== 'string' || !message.trim() || message.length > 12_000 ||
      !Array.isArray(history) || history.length > 24) {
    throw failure('INVALID_REQUEST');
  }
  const transcript = history.map((item: unknown) => {
    if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant') ||
        typeof item.content !== 'string' || item.content.length > 16_000) {
      throw failure('INVALID_REQUEST');
    }
    return { role: item.role, content: item.content };
  });
  const input = JSON.stringify({ message, history: transcript });
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES || JSON.stringify(transcript).length > 40_000) {
    throw failure('INVALID_REQUEST');
  }
  return input;
}

function readReply(output: readonly Buffer[], apiKey: string): string {
  let response: unknown;
  try {
    response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)));
  } catch {
    throw failure('PROVIDER_FAILED');
  }
  if (!isRecord(response) || typeof response.reply !== 'string' || Object.keys(response).length !== 1 ||
      !response.reply.trim() || response.reply.includes(apiKey)) {
    throw failure('PROVIDER_FAILED');
  }
  return response.reply;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* The process already exited. */ }
  }
}

function execute(
  executable: string,
  cwd: string,
  input: string,
  signal: AbortSignal | undefined,
  env: WorkerEnvironment,
): Promise<string> {
  if (signal?.aborted) throw failure('PROVIDER_ABORTED');
  let child: ChildProcessByStdio<Writable, Readable, null>;
  try {
    child = spawn(executable, ['-I', SCRIPT], {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    throw failure('PROVIDER_UNAVAILABLE');
  }

  return new Promise<string>((resolve, reject) => {
    const output: Buffer[] = [];
    let outputBytes = 0;
    let stopError: ReturnType<typeof failure> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    function finish(result: { error: unknown } | { reply: string }) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(closeDeadline);
      signal?.removeEventListener('abort', abort);
      if ('error' in result) reject(result.error);
      else resolve(result.reply);
    }

    function stop(code: ProviderErrorCode) {
      if (stopError || settled) return;
      stopError = failure(code);
      child.stdin.destroy();
      signalGroup(child, 'SIGTERM');
      forceKill = setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      closeDeadline = setTimeout(() => {
        child.stdout.destroy();
        child.unref();
        finish({ error: stopError });
      }, CLOSE_DEADLINE_MS);
    }

    const abort = () => stop('PROVIDER_ABORTED');
    const timeout = setTimeout(() => stop('PROVIDER_TIMEOUT'), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stopError) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) stop('PROVIDER_OUTPUT_LIMIT');
      else output.push(chunk);
    });
    child.stdout.on('error', () => stop('PROVIDER_FAILED'));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // A worker rejecting its configuration can exit before reading stdin.
      if (error.code !== 'EPIPE') stop('PROVIDER_FAILED');
    });
    child.once('error', () => stop('PROVIDER_UNAVAILABLE'));
    child.once('close', exitCode => {
      if (stopError) {
        // Python may exit from SIGTERM before its native harness does.
        signalGroup(child, 'SIGKILL');
        finish({ error: stopError });
        return;
      }
      if (exitCode !== 0) {
        signalGroup(child, 'SIGKILL');
        const code = exitCode === null ? undefined : WORKER_EXIT_CODES.get(exitCode);
        finish({ error: failure(code ?? 'PROVIDER_FAILED') });
        return;
      }
      try {
        finish({ reply: readReply(output, env.GEMINI_API_KEY) });
      } catch (error) {
        finish({ error });
      }
    });

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else child.stdin.end(input);
  });
}

/** `executable`, `cwd` and `env` belong to the trusted local bridge. */
export async function runGoogleSdk(
  options: GoogleSdkOptions,
): Promise<{ provider: 'antigravity'; reply: string }> {
  const { message, history = [], signal, executable = findGooglePython(), cwd, env = process.env }:
    Partial<GoogleSdkOptions> = options === undefined ? {} : options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('INVALID_REQUEST');
  if (signal?.aborted) throw failure('PROVIDER_ABORTED');
  const input = formatInput(message, history);
  if (!isExecutable(executable) || !googleApiConfigured(env)) throw failure('PROVIDER_UNAVAILABLE');
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    throw failure('INVALID_REQUEST');
  }

  // Read the credential only for an explicitly enabled request. It stays in
  // this process and the SDK child environment, outside argv and stdin.
  const apiKey = env.GEMINI_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw failure('PROVIDER_UNAVAILABLE');

  let root: string | undefined;
  try {
    root = await mkdtemp(join(cwd ?? tmpdir(), 'use-my-llm-google-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const data = join(root, 'data');
    const temporary = join(root, 'tmp');
    const sessions = join(root, 'sessions');
    for (const directory of [home, workspace, data, temporary, sessions]) {
      await mkdir(directory, { mode: 0o700 });
    }
    const childEnv = {
      ...osEnvironment(env),
      HOME: home,
      USERPROFILE: home,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      GEMINI_API_KEY: apiKey,
    };
    const reply = await execute(executable, workspace, input, signal, childEnv);
    return { provider: 'antigravity', reply };
  } catch (error) {
    if (isRecord(error) && isProviderErrorCode(error.code)) throw failure(error.code);
    throw failure('PROVIDER_FAILED');
  } finally {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}
