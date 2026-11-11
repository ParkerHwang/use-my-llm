import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findGooglePython, googleApiConfigured, googleSdkAvailable, runGoogleSdk,
} from '../dist/providers/google-sdk.mjs';

const testPosix = process.platform === 'win32' ? test.skip : test;
const SCRIPT = fileURLToPath(new URL('../dist/providers/google_sdk.py', import.meta.url));
const MODULE = new URL('../dist/providers/google-sdk.mjs', import.meta.url).href;
const KEY = 'synthetic-gemini-test-credential';
const TEST_ENV = {
  GEMINI_API_KEY: KEY,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
};

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fakePython(t, script) {
  const cwd = await temporaryDirectory(t, 'use-my-llm-fake-python-');
  const executable = join(cwd, 'fake-python.mjs');
  await writeFile(executable, `#!/usr/bin/env node\n${script}\n`, { mode: 0o700 });
  return { cwd, executable };
}

test('checks key configuration without retrieving its value', () => {
  const env = { get GEMINI_API_KEY() { assert.fail('Do not retrieve the key to check availability'); } };
  assert.equal(googleApiConfigured(env), true);
  assert.equal(googleApiConfigured({ GOOGLE_API_KEY: 'another-credential' }), false);
});

testPosix('uses a credential-free isolated SDK metadata probe and caches the result', async t => {
  const { executable } = await fakePython(t, `
    import { appendFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(process.argv[1] + '.probes', 'probe\\n');
    const metadataCheck = args[0] === '-I' && args[1] === '-c' && args.length === 3
      && args[2].includes('importlib.metadata') && args[2].includes('0.1.23');
    const hasCredentials = ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS']
      .some(name => Object.hasOwn(process.env, name));
    process.exitCode = metadataCheck && !hasCredentials ? 0 : 1;
  `);
  const parent = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { googleSdkAvailable } from ${JSON.stringify(MODULE)};
    assert.equal(googleSdkAvailable(process.argv[1]), true);
    assert.equal(googleSdkAvailable(process.argv[1]), true);
  `, executable], { env: TEST_ENV, stdio: 'ignore', timeout: 5_000 });
  assert.equal(parent.status, 0);
  assert.equal(await readFile(`${executable}.probes`, 'utf8'), 'probe\n');
  const unavailable = await fakePython(t, 'process.exitCode = 1;');
  assert.equal(googleSdkAvailable(unavailable.executable), false);
});

testPosix('sends text on stdin with a fresh home and an API-key-only environment', async t => {
  const { cwd, executable } = await fakePython(t, `
    import { existsSync } from 'node:fs';
    import { dirname, join } from 'node:path';
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const root = dirname(process.cwd());
    const forbidden = ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE',
      'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_API_KEY',
      'HTTPS_PROXY', 'PYTHONPATH', 'XDG_CONFIG_HOME'];
    const observed = {
      args: process.argv.slice(2), input, cwd: process.cwd(), home: process.env.HOME,
      dataAndSessions: existsSync(join(root, 'data')) && existsSync(join(root, 'sessions')),
      credentialPresent: Object.hasOwn(process.env, 'GEMINI_API_KEY'),
      unexpected: forbidden.filter(name => Object.hasOwn(process.env, name)),
    };
    process.stdout.write(JSON.stringify({ reply: JSON.stringify(observed) }));
  `);
  const message = '--vertex=True\n그대로 전달할 텍스트';
  const history = [{ role: 'assistant', content: 'Earlier reply', executable: '/ignored' }];
  const env = {
    ...TEST_ENV, HOME: '/ambient-home', GOOGLE_GENAI_USE_VERTEXAI: 'true',
    GOOGLE_GENAI_USE_ENTERPRISE: 'true', GOOGLE_APPLICATION_CREDENTIALS: '/ambient-adc',
    GOOGLE_CLOUD_PROJECT: 'ambient-project', GOOGLE_API_KEY: 'synthetic-other-key',
    HTTPS_PROXY: 'http://127.0.0.1:1', PYTHONPATH: '/ambient-modules',
    XDG_CONFIG_HOME: '/ambient-config',
  };
  const response = await runGoogleSdk({ executable, cwd, message, history, env });
  const observed = JSON.parse(response.reply);
  assert.equal(response.provider, 'antigravity');
  assert.deepEqual(observed.args, ['-I', SCRIPT]);
  assert.deepEqual(observed.input, { message, history: [{ role: 'assistant', content: 'Earlier reply' }] });
  assert.equal(observed.credentialPresent, true);
  assert.deepEqual(observed.unexpected, []);
  assert.equal(isAbsolute(observed.cwd), true);
  assert.equal(basename(observed.cwd), 'workspace');
  assert.equal(basename(observed.home), 'home');
  assert.equal(basename(dirname(observed.cwd)), basename(dirname(observed.home)));
  assert.equal(observed.dataAndSessions, true);
  await assert.rejects(access(observed.cwd), { code: 'ENOENT' });
  assert.deepEqual(await readdir(cwd), ['fake-python.mjs']);
});

testPosix('maps an SDK authentication error without echoing stdout or stderr', async t => {
  const { cwd, executable } = await fakePython(t, `
    for await (const chunk of process.stdin) {}
    process.stderr.write(process.env.GEMINI_API_KEY + ' private-provider-stderr');
    process.stdout.write('private-provider-stdout');
    process.exitCode = 3;
  `);
  await assert.rejects(runGoogleSdk({ executable, cwd, message: 'hello', env: TEST_ENV }), error => {
    assert.equal(error.code, 'PROVIDER_AUTH_FAILED');
    assert.doesNotMatch(String(error), /private-provider|synthetic-gemini/);
    return true;
  });
  assert.deepEqual(await readdir(cwd), ['fake-python.mjs']);
});

testPosix('rejects a malformed reply and a reply containing the credential', async t => {
  const malformed = await fakePython(t, `process.stdout.write('fixture log rather than JSON');`);
  await assert.rejects(runGoogleSdk({ ...malformed, message: 'hello', env: TEST_ENV }), {
    code: 'PROVIDER_FAILED',
  });
  const leaking = await fakePython(t, `process.stdout.write(JSON.stringify({ reply: process.env.GEMINI_API_KEY }));`);
  await assert.rejects(runGoogleSdk({ ...leaking, message: 'hello', env: TEST_ENV }), error => {
    assert.equal(error.code, 'PROVIDER_FAILED');
    assert.doesNotMatch(String(error), /synthetic-gemini/);
    return true;
  });
});

testPosix('limits the response size and removes its temporary files on failure', async t => {
  const { cwd, executable } = await fakePython(t, `process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 97));`);
  await assert.rejects(runGoogleSdk({ cwd, executable, message: 'hello', env: TEST_ENV }), {
    code: 'PROVIDER_OUTPUT_LIMIT',
  });
  assert.deepEqual(await readdir(cwd), ['fake-python.mjs']);
});

testPosix('cancels an active worker that ignores graceful termination', { timeout: 10_000 }, async t => {
  const { cwd, executable } = await fakePython(t, `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    writeFileSync(process.argv[1] + '.ready', String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const cancelled = assert.rejects(runGoogleSdk({ cwd, executable, message: 'hello',
    signal: controller.signal, env: TEST_ENV }), { code: 'PROVIDER_ABORTED' });
  let pid;
  try {
    const deadline = Date.now() + 5_000;
    while (!pid && Date.now() < deadline) {
      pid = Number(await readFile(`${executable}.ready`, 'utf8').catch(() => ''));
      if (!pid) await delay(10);
    }
    assert.ok(pid, 'The synthetic worker should reach the ready state');
  } finally {
    controller.abort();
    await cancelled;
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual((await readdir(cwd)).sort(), ['fake-python.mjs', 'fake-python.mjs.ready']);
});

testPosix('requires a configured Gemini key before starting a worker', async t => {
  const { cwd, executable } = await fakePython(t, `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.argv[1] + '.unexpected-launch', 'started');
  `);
  const env = { PATH: TEST_ENV.PATH, GOOGLE_API_KEY: 'synthetic-alternate-credential' };
  await assert.rejects(runGoogleSdk({ cwd, executable, message: 'hello', env }), {
    code: 'PROVIDER_UNAVAILABLE',
  });
  await assert.rejects(access(`${executable}.unexpected-launch`), { code: 'ENOENT' });
});

const SDK_MOCK = `
import importlib.metadata
import json
import os
import runpy
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

script, mode = sys.argv[1:]
importlib.metadata.version = lambda _: '0.1.22' if mode == 'wrong-version' else '0.1.23'
for name in ('google', 'google.antigravity', 'google.antigravity.hooks', 'google.antigravity.hooks.policy'):
    sys.modules[name] = ModuleType(name)
    sys.modules[name].__path__ = []

sdk = sys.modules['google.antigravity']
sdk.CapabilitiesConfig = lambda **fields: SimpleNamespace(**fields)
def make_config(**fields):
    if mode == 'unsafe-default':
        fields['capabilities'].enabled_tools = ['run_command']
    return SimpleNamespace(**fields)
sdk.LocalAgentConfig = make_config
sys.modules['google.antigravity.hooks.policy'].deny = lambda tool: ('deny', tool)

class TestAuthError(Exception):
    status_code = 403

class Agent:
    def __init__(self, config):
        assert config.capabilities.enabled_tools == []
        assert config.capabilities.enable_subagents is False
        assert config.policies == [('deny', '*')]
        assert config.vertex is False
        assert config.api_key == os.environ['GEMINI_API_KEY']
        assert not config.tools and not config.mcp_servers and not config.skills_paths
        assert config.workspaces == [str(Path.cwd().resolve())]
        assert Path(config.app_data_dir).is_dir() and Path(config.save_dir).is_dir()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def chat(self, prompt):
        assert json.loads(prompt) == {'message': '안녕', 'history': []}
        print(os.environ['GEMINI_API_KEY'])
        if mode == 'auth':
            raise TestAuthError('synthetic private provider diagnostic')
        return self

    async def text(self):
        return '테스트 응답'

sdk.Agent = Agent
runpy.run_path(script, run_name='__main__')
`;

testPosix('Python worker enforces the SDK version and tool policy with a synthetic SDK', async t => {
  const executable = findGooglePython();
  const version = executable && spawnSync(executable, ['-I', '-c',
    'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], {
    env: {}, stdio: 'ignore', timeout: 1_500,
  });
  if (version?.status !== 0) { t.skip('Python 3.10 or later is needed for the synthetic SDK test'); return; }

  const root = await temporaryDirectory(t, 'use-my-llm-google-');
  const cwd = join(root, 'workspace');
  const home = join(root, 'home');
  for (const path of [cwd, home, join(root, 'sessions'), join(root, 'data')]) await mkdir(path);
  for (const [mode, expected] of [['ok', 0], ['wrong-version', 2], ['unsafe-default', 2], ['auth', 3]]) {
    const child = spawnSync(executable, ['-I', '-c', SDK_MOCK, SCRIPT, mode], {
      cwd,
      env: { HOME: home, GEMINI_API_KEY: KEY },
      input: JSON.stringify({ message: '안녕', history: [] }),
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(child.status, expected, mode);
    assert.doesNotMatch(child.stderr ?? '', /synthetic|private provider/);
    if (mode === 'ok') assert.deepEqual(JSON.parse(child.stdout), { reply: '테스트 응답' });
    else assert.equal(child.stdout, '');
  }
});
