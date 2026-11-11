import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { claudeApiKeyConfigured, runClaude } from '../dist/providers/claude.mjs';

const testPosix = process.platform === 'win32' ? test.skip : test;
const TEST_ENV = {
  ANTHROPIC_API_KEY: 'synthetic-api-key',
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
};

async function fakeClaude(t, script) {
  const directory = await mkdtemp(join(tmpdir(), 'use-my-llm-fake-claude-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const executable = join(directory, 'fake-claude.mjs');
  await writeFile(executable, `#!/usr/bin/env node\n${script}\n`, { mode: 0o700 });
  return { directory, executable };
}

testPosix('passes a conversation through stdin using fixed restricted flags and a disposable cwd', async t => {
  const { executable } = await fakeClaude(t, `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString('utf8');
    const excluded = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'HTTPS_PROXY'];
    const result = JSON.stringify({
      args: process.argv.slice(2), input, cwd: process.cwd(),
      apiKeyPresent: Object.hasOwn(process.env, 'ANTHROPIC_API_KEY'),
      unexpectedEnv: excluded.filter(name => Object.hasOwn(process.env, name)),
    });
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result }));
  `);
  const message = '--model example & literal text\nsecond line';
  const history = [{ role: 'assistant', content: 'Earlier reply' }];
  const env = {
    ...TEST_ENV,
    ANTHROPIC_AUTH_TOKEN: 'synthetic-alternate-auth',
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    CLAUDE_CODE_USE_BEDROCK: '1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
  };
  const response = await runClaude({ executable, message, history, env });

  assert.equal(response.provider, 'claude');
  const observed = JSON.parse(response.reply);
  assert.deepEqual(observed.args, [
    '--print', '--bare', '--input-format', 'text', '--output-format', 'json',
    '--restricted', '--disable-slash-commands',
    '--settings', '{"disableAllHooks":true,"autoMemoryEnabled":false}',
    '--tools', '', '--disallowedTools', '*',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-prompts', 'none', '--no-chrome', '--no-session-persistence',
  ]);
  const transcript = JSON.parse(observed.input.split('\n\n').at(-1));
  assert.deepEqual(transcript, { history, message });
  assert.equal(observed.apiKeyPresent, true);
  assert.deepEqual(observed.unexpectedEnv, []);
  assert.equal(isAbsolute(observed.cwd), true);
  await assert.rejects(access(observed.cwd), { code: 'ENOENT' });
});

testPosix('keeps CLI stdout and stderr out of public errors', async t => {
  const { executable } = await fakeClaude(t, `
    for await (const chunk of process.stdin) {}
    console.error('fixture-stderr-private');
    console.log('fixture-stdout-private');
    process.exitCode = 1;
  `);
  await assert.rejects(runClaude({ executable, message: 'hello', env: TEST_ENV }), err => {
    assert.equal(err.code, 'PROVIDER_FAILED');
    assert.doesNotMatch(String(err), /fixture-(stdout|stderr)-private/);
    return true;
  });
});

testPosix('rejects an error envelope even when the CLI process exits successfully', async t => {
  const { executable } = await fakeClaude(t, `
    for await (const chunk of process.stdin) {}
    console.log(JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'fixture-diagnostic-private',
    }));
  `);
  await assert.rejects(runClaude({ executable, message: 'hello', env: TEST_ENV }), err => {
    assert.equal(err.code, 'PROVIDER_FAILED');
    assert.doesNotMatch(String(err), /fixture-diagnostic-private/);
    return true;
  });
});

testPosix('ends a CLI run that exceeds the stdout size limit', async t => {
  const { executable } = await fakeClaude(t, `
    for await (const chunk of process.stdin) {}
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  `);
  await assert.rejects(runClaude({ executable, message: 'hello', env: TEST_ENV }), {
    code: 'PROVIDER_OUTPUT_LIMIT',
  });
});

testPosix('cancels an active child that ignores graceful termination', async t => {
  const { directory, executable } = await fakeClaude(t, `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync('started.pid', String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const pending = runClaude({ executable, cwd: directory, message: 'hello', signal: controller.signal, env: TEST_ENV });
  const cancelled = assert.rejects(pending, { code: 'PROVIDER_ABORTED' });
  const marker = join(directory, 'started.pid');
  let pid;

  try {
    const deadline = Date.now() + 5000;
    while (!pid && Date.now() < deadline) {
      pid = Number(await readFile(marker, 'utf8').catch(() => ''));
      if (!pid) await delay(10);
    }
    assert.ok(pid, 'fake CLI process should have started');
  } finally {
    controller.abort();
    await cancelled;
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('rejects invalid input, relative executable paths and pre-cancelled requests', async () => {
  await assert.rejects(runClaude({ message: 'hello', history: [{ role: 'tool', content: 'x' }], env: TEST_ENV }), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(runClaude({ message: 'a'.repeat(64 * 1024), executable: 'claude', env: TEST_ENV }), {
    code: 'INVALID_REQUEST',
  });
  await assert.rejects(runClaude({ message: 'hello', executable: 'claude', env: TEST_ENV }), {
    code: 'PROVIDER_UNAVAILABLE',
  });
  await assert.rejects(runClaude({ message: 'hello', signal: AbortSignal.abort(), env: TEST_ENV }), {
    code: 'PROVIDER_ABORTED',
  });
});

testPosix('requires the direct API credential before spawning a process', async t => {
  const { directory, executable } = await fakeClaude(t, `
    import { writeFileSync } from 'node:fs';
    writeFileSync('unexpected-launch', 'launched');
  `);
  const env = { PATH: TEST_ENV.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth' };
  assert.equal(claudeApiKeyConfigured(env), false);
  await assert.rejects(runClaude({ executable, cwd: directory, message: 'hello', env }), {
    code: 'PROVIDER_UNAVAILABLE',
  });
  await assert.rejects(access(join(directory, 'unexpected-launch')), { code: 'ENOENT' });
});

test('checks key configuration without retrieving its value', () => {
  const env = {
    get ANTHROPIC_API_KEY() {
      assert.fail('key value must not be read to check availability');
    },
  };
  assert.equal(claudeApiKeyConfigured(env), true);
});


testPosix('subscription uses the CLI login in its fixed config dir and excludes all injected credentials', async t => {
  const { directory, executable } = await fakeClaude(t, `
    for await (const chunk of process.stdin) {}
    const excluded = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR_INJECT', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK'];
    const result = JSON.stringify({ args: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR,
      excluded: excluded.filter(key => Object.hasOwn(process.env, key)),
      attachments: process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS });
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result }));
  `);
  const subscriptionConfigDir = join(directory, 'bridge-subscription');
  await mkdir(subscriptionConfigDir);
  const result = await runClaude({ executable, message: 'Hello', authMode: 'subscription', subscriptionConfigDir,
    env: { ...TEST_ENV, CLAUDE_CONFIG_DIR: join(directory, 'original'),
      ANTHROPIC_AUTH_TOKEN: 'do-not-use', CLAUDE_CODE_OAUTH_TOKEN: 'do-not-use',
      ANTHROPIC_BASE_URL: 'https://do-not-use.invalid', CLAUDE_CODE_USE_BEDROCK: '1' } });
  const observed = JSON.parse(result.reply);
  assert.equal(observed.configDir, subscriptionConfigDir);
  assert.equal(observed.args.includes('--bare'), false);
  assert.equal(observed.args.includes('--safe-mode'), true);
  assert.equal(observed.args.includes('--restricted'), true);
  assert.deepEqual(observed.excluded, []);
  assert.equal(observed.attachments, '1');
});

testPosix('subscription fails closed without an existing absolute bridge login directory', async t => {
  const { executable } = await fakeClaude(t, `throw new Error('must not run');`);
  for (const subscriptionConfigDir of [undefined, 'relative', join(tmpdir(), 'missing-use-my-llm-subscription')]) {
    await assert.rejects(runClaude({ executable, message: 'Hello', authMode: 'subscription', subscriptionConfigDir, env: TEST_ENV }), {
      code: 'PROVIDER_UNAVAILABLE',
    });
  }
  await assert.rejects(runClaude({ executable, message: 'Hello', authMode: 'unexpected', env: TEST_ENV }), {
    code: 'INVALID_REQUEST',
  });
});
