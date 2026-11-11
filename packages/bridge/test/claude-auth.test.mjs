import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { claudeLoginEnvironment, claudeSubscriptionConnected, claudeSubscriptionDirectory, readClaudeAuthMode, writeClaudeAuthMode } from '../dist/claude-auth.mjs';
import { createProviderRegistry } from '../dist/providers/index.mjs';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'use-my-llm-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, env: { LOCALHOSTAGENT_DATA_DIR: directory, HOME: directory, PATH: [dirname(process.execPath), process.env.PATH].join(delimiter) } };
}

test('failed official logout preserves mode and login, and a successful retry clears both', { skip: process.platform === 'win32' }, t => {
  const { directory, env } = setup(t);
  const executable = join(directory, 'claude');
  const login = join(claudeSubscriptionDirectory(env), 'fixture-login');
  const retry = join(directory, 'retry');
  mkdirSync(claudeSubscriptionDirectory(env));
  writeFileSync(login, 'synthetic login state');
  writeClaudeAuthMode('subscription', env);
  const savedMode = readFileSync(join(directory, 'claude-auth.json'), 'utf8');
  writeFileSync(executable, `#!/usr/bin/env node
    const fs = await import('node:fs');
    const assert = (await import('node:assert/strict')).default;
    assert.deepEqual(process.argv.slice(2), ['auth', 'logout']);
    assert.equal(process.cwd(), fs.realpathSync(${JSON.stringify(claudeSubscriptionDirectory(env))}));
    assert.equal(fs.realpathSync(process.env.CLAUDE_CONFIG_DIR), process.cwd());
    assert.equal(fs.readFileSync(${JSON.stringify(join(directory, 'claude-auth.json'))}, 'utf8'), ${JSON.stringify(savedMode)});
    if (!fs.existsSync(${JSON.stringify(retry)})) process.exit(1);
    fs.unlinkSync(${JSON.stringify(login)});
  `, { mode: 0o700 });
  const options = { env: { ...env, LOCALHOSTAGENT_CLAUDE_PATH: executable }, encoding: 'utf8', stdio: 'pipe' };
  const command = [fileURLToPath(new URL('../dist/cli.mjs', import.meta.url)), 'claude-auth', 'disconnect'];
  assert.throws(() => execFileSync(process.execPath, command, options), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /logout did not complete/);
    assert.match(error.stderr, /mode is unchanged/);
    assert.match(error.stderr, /login may still be active/);
    assert.match(error.stderr, /Retry with "use-my-llm claude-auth disconnect"/);
    assert.equal(error.stdout, '');
    return true;
  });
  assert.equal(readFileSync(join(directory, 'claude-auth.json'), 'utf8'), savedMode);
  assert.equal(existsSync(login), true);
  writeFileSync(retry, 'retry');
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, command, options)), { mode: null, connected: false, cliAvailable: true });
  assert.equal(readClaudeAuthMode(env), null);
  assert.equal(existsSync(login), false);
});

test('disconnect preserves the saved mode when the official CLI is unavailable', t => {
  const { directory, env } = setup(t);
  writeClaudeAuthMode('subscription', env);
  assert.throws(() => execFileSync(process.execPath,
    [fileURLToPath(new URL('../dist/cli.mjs', import.meta.url)), 'claude-auth', 'disconnect'],
    { env: { ...env, LOCALHOSTAGENT_CLAUDE_PATH: join(directory, 'missing-claude') }, encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /logout did not complete/);
    return true;
  });
  assert.equal(readClaudeAuthMode(env), 'subscription');
});

test('saved Claude mode is explicit, private and malformed settings fail closed', t => {
  const { directory, env } = setup(t);
  assert.equal(readClaudeAuthMode(env), null);
  writeClaudeAuthMode('subscription', env);
  assert.equal(readClaudeAuthMode(env), 'subscription');
  if (process.platform !== 'win32') assert.equal(statSync(join(directory, 'claude-auth.json')).mode & 0o777, 0o600);
  writeClaudeAuthMode('api-key', env);
  assert.equal(readClaudeAuthMode(env), 'api-key');
  writeClaudeAuthMode(null, env);
  assert.equal(readClaudeAuthMode(env), null);
  writeFileSync(join(directory, 'claude-auth.json'), '{broken');
  assert.equal(readClaudeAuthMode(env), null);
});

test('official login environment excludes every alternate credential and routing override', t => {
  const { env } = setup(t);
  const clean = claudeLoginEnvironment({ ...env, ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://example.com', NODE_OPTIONS: '--require bad', CLAUDE_CONFIG_DIR: '/original' });
  assert.deepEqual(Object.keys(clean).sort(), ['CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
  assert.equal(clean.CLAUDE_CONFIG_DIR, claudeSubscriptionDirectory(env));
  assert.equal(JSON.stringify(clean).includes('secret'), false);
});

test('subscription status trusts only official subscription login and suppresses account details', { skip: process.platform === 'win32' }, t => {
  const { directory, env } = setup(t);
  mkdirSync(claudeSubscriptionDirectory(env));
  const executable = join(directory, 'claude');
  for (const [authMethod, loggedIn, expected] of [['claude.ai', true, true], ['api_key', true, false], ['oauth_token', true, false], ['claude.ai', false, false]]) {
    writeFileSync(executable, `#!/usr/bin/env node\nconsole.log(JSON.stringify({loggedIn:${loggedIn},authMethod:${JSON.stringify(authMethod)},email:'private@example.com',token:'secret'}));\n`, { mode: 0o700 });
    assert.equal(claudeSubscriptionConnected(env, executable), expected);
  }
  writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("invalid");\n');
  assert.equal(claudeSubscriptionConnected(env, executable), false);
});

test('legacy API flag and explicit launch mode override saved subscription choice', t => {
  const { env } = setup(t);
  writeClaudeAuthMode('subscription', env);
  const apiEnv = { ...env, ANTHROPIC_API_KEY: 'synthetic' };
  const registry = createProviderRegistry({ enableClaudeApi: true, env: apiEnv });
  assert.deepEqual(registry.getProviders().find(p => p.id === 'claude'), { id: 'claude', available: true, authMode: 'api-key' });
  writeClaudeAuthMode(null, env);
  const saved = createProviderRegistry({ env: apiEnv });
  assert.deepEqual(saved.getProviders().find(p => p.id === 'claude'), { id: 'claude', available: false });
  writeClaudeAuthMode('api-key', env);
  assert.equal(saved.getProviders().find(p => p.id === 'claude').authMode, 'api-key');
  assert.equal(saved.getProviders().find(p => p.id === 'claude').available, true);
});

test('bridge readiness probe stays nonblocking and subscription registry uses the CLI route', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const { directory, env } = setup(t);
  const release = join(directory, 'release');
  const executable = join(directory, 'claude');
  mkdirSync(claudeSubscriptionDirectory(env));
  writeFileSync(executable, `#!/usr/bin/env node
    if (process.argv[2] === 'auth') {
      const fs = await import('node:fs');
      while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 10));
      console.log(JSON.stringify({ loggedIn:true, authMethod:'claude.ai' }));
    } else {
      for await (const chunk of process.stdin) {}
      console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify(process.argv.slice(2))}));
    }
  `, { mode: 0o700 });
  const old = process.env.LOCALHOSTAGENT_CLAUDE_PATH;
  process.env.LOCALHOSTAGENT_CLAUDE_PATH = executable;
  t.after(() => { if (old === undefined) delete process.env.LOCALHOSTAGENT_CLAUDE_PATH; else process.env.LOCALHOSTAGENT_CLAUDE_PATH = old; });
  writeClaudeAuthMode('subscription', env);
  const registry = createProviderRegistry({ env: { ...env, ANTHROPIC_API_KEY: 'must-not-be-used' } });
  assert.equal(registry.getProviders().find(p => p.id === 'claude').available, false);
  // A synchronous probe cannot complete: its child waits for this post-return write.
  writeFileSync(release, 'continue');
  const { reply } = await registry.runProvider({ provider: 'claude', message: 'Hi', history: [] });
  const args = JSON.parse(reply);
  assert.equal(args.includes('--safe-mode'), true);
  assert.equal(args.includes('--bare'), false);
});
