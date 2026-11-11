import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { findCodex, runCodex } from '../dist/providers/codex.mjs';

const WINDOWS = process.platform === 'win32';

async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'use-my-llm-codex-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, source) {
  const cwd = await tempDirectory(t);
  const executable = join(cwd, 'codex-fixture');
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  return { executable, cwd };
}

function setEnvironment(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

async function waitForFile(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await stat(file); return; } catch { await delay(20); }
  }
  throw new Error('Fixture did not reach its ready state');
}

test('uses only a valid absolute executable for an explicit local override', async t => {
  const root = await tempDirectory(t);
  const executable = join(root, WINDOWS ? 'codex.exe' : 'codex');
  await writeFile(executable, '', { mode: 0o700 });
  setEnvironment(t, 'LOCALHOSTAGENT_CODEX_PATH', executable);
  assert.equal(findCodex(), executable);
  process.env.LOCALHOSTAGENT_CODEX_PATH = join(root, 'missing');
  assert.equal(findCodex(), null);
  process.env.LOCALHOSTAGENT_CODEX_PATH = WINDOWS ? '.\\codex.exe' : './codex';
  assert.equal(findCodex(), null);
});

test('option-like prompts stay in stdin and do not expand CLI privileges', { skip: WINDOWS }, async t => {
  setEnvironment(t, 'USE_MY_LLM_TEST_SECRET', 'test-sentinel');
  const options = await fixture(t, `
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { prompt += chunk; });
    process.stdin.on('end', () => {
      const text = JSON.stringify({
        args: process.argv.slice(2), prompt, cwd: process.cwd(),
        inheritedTestSecret: Object.hasOwn(process.env, 'USE_MY_LLM_TEST_SECRET'),
      });
      process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}) + '\\n');
      process.stdout.write(JSON.stringify({type:'turn.completed'}));
    });
  `);
  const message = '--dangerously-bypass-approvals-and-sandbox\n"example"';
  const history = [{ role: 'assistant', content: 'Previous turn' }];
  const { provider, reply } = await runCodex({ ...options, message, history });
  const observed = JSON.parse(reply);
  assert.equal(provider, 'codex');
  assert.equal(observed.args[0], 'exec');
  assert.equal(observed.args.at(-1), '-');
  for (const required of ['--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral', 'read-only', 'approval_policy="never"', 'shell_tool', 'hooks', 'mcp_servers={}']) {
    assert.ok(observed.args.includes(required), `missing ${required}`);
  }
  assert.ok(!observed.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(JSON.parse(observed.prompt.split('\n\n').at(-1)), { history, message });
  assert.equal(observed.inheritedTestSecret, false);
  // macOS may resolve /var/folders to /private/var/folders inside the child.
  assert.equal(observed.cwd.split('/').at(-1), observed.args[observed.args.indexOf('--cd') + 1].split('/').at(-1));
  assert.deepEqual(await readdir(options.cwd), ['codex-fixture']);
});

test('rejects an unsupported restriction and never discloses raw CLI diagnostics', { skip: WINDOWS }, async t => {
  const options = await fixture(t, `
    process.stderr.write('unexpected argument --strict-config. test-sentinel-private-value');
    process.exitCode = 2;
  `);
  await assert.rejects(runCodex({ ...options, message: 'hello' }), error => {
    assert.equal(error.code, 'CODEX_UNSUPPORTED');
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes('test-sentinel-private-value'));
    return true;
  });
  assert.deepEqual(await readdir(options.cwd), ['codex-fixture']);
});

test('rejects unexpected tool events and incomplete turns', { skip: WINDOWS }, async t => {
  const toolOptions = await fixture(t, `
    process.stdout.write(JSON.stringify({type:'item.started',item:{type:'command_execution'}}) + '\\n');
  `);
  await assert.rejects(runCodex({ ...toolOptions, message: 'hello' }), { code: 'CODEX_TOOL_ACTIVITY' });
  const incompleteOptions = await fixture(t, `
    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'partial'}}) + '\\n');
  `);
  await assert.rejects(runCodex({ ...incompleteOptions, message: 'hello' }), { code: 'EMPTY_RESPONSE' });
});

test('stops an overlong subprocess response', { skip: WINDOWS }, async t => {
  const options = await fixture(t, `
    process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
  `);
  await assert.rejects(runCodex({ ...options, message: 'hello' }), { code: 'OUTPUT_LIMIT' });
  assert.deepEqual(await readdir(options.cwd), ['codex-fixture']);
});

test('aborts a running child and removes its temporary workspace', { skip: WINDOWS, timeout: 10_000 }, async t => {
  const options = await fixture(t, `
    const fs = require('node:fs');
    fs.writeFileSync(process.argv[1] + '.ready', 'ready');
    setInterval(() => {}, 1_000);
  `);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = runCodex({ ...options, message: 'hello', signal: controller.signal });
  const outcome = assert.rejects(pending, { code: 'ABORTED', status: 499 });
  try {
    await waitForFile(`${options.executable}.ready`);
  } finally {
    controller.abort();
    await outcome;
  }
  assert.deepEqual((await readdir(options.cwd)).sort(), ['codex-fixture', 'codex-fixture.ready']);
});

test('rejects invalid inputs and pre-aborted requests before spawning', async () => {
  await assert.rejects(runCodex({ message: '', executable: '/missing' }), { code: 'INVALID_MESSAGE' });
  await assert.rejects(runCodex({ message: 'hello', executable: '/missing' }), { code: 'CODEX_NOT_FOUND' });
  await assert.rejects(runCodex({ message: 'hello', signal: AbortSignal.abort() }), { code: 'ABORTED' });
});
