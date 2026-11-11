/** Local-only Claude settings and the official CLI's own authentication flow. */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultDataDir } from './context/store.mjs';
import { findClaude } from './providers/claude.mjs';

export type ClaudeAuthMode = 'api-key' | 'subscription';
export function claudeSubscriptionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultDataDir(env), 'claude-subscription');
}
export function readClaudeAuthMode(env: NodeJS.ProcessEnv = process.env): ClaudeAuthMode | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(defaultDataDir(env), 'claude-auth.json'), 'utf8'));
    if (value && typeof value === 'object' && 'mode' in value && (value.mode === 'api-key' || value.mode === 'subscription')) return value.mode;
  } catch { /* Missing or malformed local configuration disables Claude. */ }
  return null;
}
export function writeClaudeAuthMode(mode: ClaudeAuthMode | null, env: NodeJS.ProcessEnv = process.env): void {
  const directory = defaultDataDir(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.claude-auth-${randomUUID()}.json`);
  writeFileSync(temporary, JSON.stringify({ mode }) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, join(directory, 'claude-auth.json'));
}

/** Never inherit API credentials, OAuth environment tokens, routing, or loaders. */
export function claudeLoginEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USERPROFILE', 'PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  result.CLAUDE_CONFIG_DIR = claudeSubscriptionDirectory(env);
  return result;
}

function subscriptionStatus(output: string): boolean {
  try {
    const status: unknown = JSON.parse(output);
    return Boolean(status && typeof status === 'object' && 'loggedIn' in status && status.loggedIn === true
      && 'authMethod' in status && status.authMethod === 'claude.ai');
  } catch { return false; }
}

/** Nonblocking readiness probe for the long-running HTTP bridge. */
export function probeClaudeSubscription(env: NodeJS.ProcessEnv = process.env, executable = findClaude()): Promise<boolean> {
  if (!executable) return Promise.resolve(false);
  return new Promise(resolve => {
    execFile(executable, ['auth', 'status', '--json'], {
      env: claudeLoginEnvironment(env), cwd: claudeSubscriptionDirectory(env),
      encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024,
    }, (error, stdout) => resolve(!error && subscriptionStatus(stdout)));
  });
}

export function claudeSubscriptionConnected(env: NodeJS.ProcessEnv = process.env, executable = findClaude()): boolean {
  if (!executable) return false;
  try {
    const output = execFileSync(executable, ['auth', 'status', '--json'], {
      env: claudeLoginEnvironment(env), cwd: claudeSubscriptionDirectory(env),
      encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return subscriptionStatus(output);
  } catch { return false; }
}

async function officialAuth(action: 'login' | 'logout', env: NodeJS.ProcessEnv): Promise<boolean> {
  const executable = findClaude();
  if (!executable) return false;
  const directory = claudeSubscriptionDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return new Promise(resolve => {
    // The official interactive flow owns credential storage. The bridge never captures tokens.
    const child = spawn(executable, ['auth', action, ...(action === 'login' ? ['--claudeai'] : [])], {
      env: claudeLoginEnvironment(env), cwd: directory, stdio: action === 'login' ? 'inherit' : 'ignore', shell: false,
    });
    child.once('error', () => resolve(false));
    child.once('close', code => resolve(code === 0));
  });
}

function printStatus(env: NodeJS.ProcessEnv) {
  const mode = readClaudeAuthMode(env);
  process.stdout.write(JSON.stringify({ mode, connected: mode === 'subscription' ? claudeSubscriptionConnected(env) : mode === 'api-key' && Boolean(env.ANTHROPIC_API_KEY), cliAvailable: Boolean(findClaude()) }) + '\n');
}

export async function runClaudeAuthCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, value, ...rest] = args;
  if (rest.length || (command !== 'mode' && value !== undefined && value !== '--json')) {
    process.stderr.write('Invalid Claude auth command.\n'); return 1;
  }
  if (command === 'status') {
    printStatus(env);
    return 0;
  }
  if (command === 'mode' && ['api-key', 'subscription', 'off'].includes(value ?? '')) {
    writeClaudeAuthMode(value === 'off' ? null : value as ClaudeAuthMode, env);
    printStatus(env);
    return 0;
  }
  if (command === 'connect') {
    if (!await officialAuth('login', env) || !claudeSubscriptionConnected(env)) {
      process.stderr.write('Claude subscription sign-in did not complete.\n'); return 1;
    }
    writeClaudeAuthMode('subscription', env);
    process.stdout.write('Claude subscription connected. Usage counts against your Claude plan limits.\n');
    return 0;
  }
  if (command === 'disconnect') {
    if (!await officialAuth('logout', env)) {
      process.stderr.write('Official Claude subscription logout did not complete. The saved Claude mode is unchanged and the bridge login may still be active. Retry with "use-my-llm claude-auth disconnect".\n'); return 1;
    }
    writeClaudeAuthMode(null, env);
    printStatus(env); return 0;
  }
  process.stderr.write('Usage: use-my-llm claude-auth <status|connect|disconnect|mode api-key|mode subscription|mode off>\n');
  return 1;
}
