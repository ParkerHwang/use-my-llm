import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeApiConfigured, runClaudeApi } from '../dist/providers/claude-api.mjs';

const FIXTURE_KEY = 'synthetic-anthropic-key';
const ENV = { ANTHROPIC_API_KEY: FIXTURE_KEY };

function messageResponse(content) {
  return Response.json({ type: 'message', role: 'assistant', content });
}

function assertSafeError(code) {
  return error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error), /synthetic-anthropic-key|private-fixture-detail/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('sends text history to the fixed API using only locally configured credentials', async () => {
  let observed;
  const fetchImpl = async (url, options) => {
    observed = { url, options };
    return messageResponse([
      { type: 'thinking', thinking: 'private-fixture-detail' },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', world!' },
    ]);
  };

  const reply = await runClaudeApi({
    message: 'Continue',
    history: [
      { role: 'user', content: 'Hello', tools: [{ name: 'ignored' }] },
      { role: 'assistant', content: 'Hi' },
    ],
    env: {
      ...ENV,
      ANTHROPIC_BASE_URL: 'https://fixture.example',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-alternate-token',
    },
    model: 'request-selected-model',
    endpoint: 'https://fixture.example',
    apiKey: 'request-selected-key',
    workspaceId: 'wrkspc_requestSelected',
    fetchImpl,
  });

  assert.deepEqual(reply, { provider: 'claude', reply: 'Hello, world!' });
  assert.equal(observed.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(observed.options.method, 'POST');
  assert.equal(observed.options.redirect, 'error');
  assert.equal(observed.options.credentials, 'omit');
  assert.deepEqual(observed.options.headers, {
    Authorization: `Bearer ${FIXTURE_KEY}`,
    'anthropic-version': '2026-10-21',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(observed.options.body), {
    model: 'claude-haiku-5-5',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Continue' },
    ],
  });
});

test('uses a model and workspace selected in local environment configuration', async () => {
  const fetchImpl = async (_url, options) => {
    assert.equal(JSON.parse(options.body).model, 'claude-sonnet-5-5');
    assert.equal(options.headers['anthropic-workspace-id'], 'wrkspc_localFixture');
    return messageResponse([{ type: 'text', text: 'Done' }]);
  };
  assert.deepEqual(await runClaudeApi({
    message: 'Hi',
    env: {
      ...ENV,
      LOCALHOSTAGENT_CLAUDE_MODEL: 'claude-sonnet-5-5',
      LOCALHOSTAGENT_CLAUDE_WORKSPACE_ID: 'wrkspc_localFixture',
    },
    fetchImpl,
  }), { provider: 'claude', reply: 'Done' });
});

test('checks local availability without reading the API key value', () => {
  assert.equal(claudeApiConfigured({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth' }), false);
  assert.equal(claudeApiConfigured({
    get ANTHROPIC_API_KEY() { assert.fail('availability must not read the credential'); },
  }), true);
});

test('rejects missing credentials, malformed local settings and invalid input before fetching', async () => {
  const fetchImpl = async () => assert.fail('invalid configuration or input must not call fetch');
  for (const env of [
    {},
    { ANTHROPIC_API_KEY: ' ' },
    { ...ENV, LOCALHOSTAGENT_CLAUDE_MODEL: 'bad model' },
    { ...ENV, LOCALHOSTAGENT_CLAUDE_WORKSPACE_ID: 'wrkspc_fixture\r\nInjected: header' },
  ]) {
    await assert.rejects(runClaudeApi({ message: 'hello', env, fetchImpl }), {
      code: 'PROVIDER_UNAVAILABLE',
    });
  }
  for (const input of [
    { message: ' ' },
    { message: 'hi', history: [{ role: 'tool', content: 'forbidden role' }] },
    { message: 'a'.repeat(12_001) },
    { message: 'hi', history: Array.from({ length: 6 }, () => ({ role: 'user', content: 'a'.repeat(16_000) })) },
  ]) {
    await assert.rejects(runClaudeApi({ ...input, env: ENV, fetchImpl }), {
      code: 'INVALID_REQUEST',
    });
  }
});

test('maps auth status and upstream failures without forwarding error details', async () => {
  for (const [status, code] of [
    [401, 'PROVIDER_AUTH_FAILED'], [403, 'PROVIDER_AUTH_FAILED'], [429, 'PROVIDER_FAILED'],
  ]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull() { assert.fail('upstream failure body must not be read'); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const fetchImpl = async () => new Response(body, { status, statusText: 'private-fixture-detail' });
    await assert.rejects(runClaudeApi({ message: 'hello', env: ENV, fetchImpl }), assertSafeError(code));
    assert.equal(cancelled, true);
  }

  const fetchImpl = async () => { throw new Error(`private-fixture-detail ${FIXTURE_KEY}`); };
  await assert.rejects(runClaudeApi({ message: 'hello', env: ENV, fetchImpl }), assertSafeError('PROVIDER_FAILED'));
});

test('rejects malformed or empty replies and does not relay credentials', async () => {
  const responses = [
    () => new Response('private-fixture-detail'),
    () => messageResponse([{ type: 'tool_use', input: { private: FIXTURE_KEY } }]),
    () => messageResponse([{ type: 'text', text: FIXTURE_KEY.slice(0, 9) }, { type: 'text', text: FIXTURE_KEY.slice(9) }]),
  ];
  for (const create of responses) {
    await assert.rejects(runClaudeApi({ message: 'hello', env: ENV, fetchImpl: async () => create() }),
      assertSafeError('PROVIDER_FAILED'));
  }
});

test('bounds received bytes even when no content length is supplied', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const fetchImpl = async () => new Response(body);
  await assert.rejects(runClaudeApi({ message: 'hello', env: ENV, fetchImpl }), {
    code: 'PROVIDER_OUTPUT_LIMIT',
  });
  assert.equal(cancelled, true);
});

test('pre-aborted requests do not read credentials or call fetch', async () => {
  await assert.rejects(runClaudeApi({
    message: 'hello',
    env: {
      get ANTHROPIC_API_KEY() { assert.fail('cancelled request must not read the credential'); },
    },
    signal: AbortSignal.abort(),
    fetchImpl: async () => assert.fail('cancelled request must not call fetch'),
  }), { code: 'PROVIDER_ABORTED' });
});

test('cancellation stops reading a stalled response body', { timeout: 5000 }, async () => {
  let startedReading;
  let cancelled = false;
  const reading = new Promise(resolve => { startedReading = resolve; });
  const body = new ReadableStream({
    pull() { startedReading(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const controller = new AbortController();
  const pending = runClaudeApi({
    message: 'hello', env: ENV, signal: controller.signal,
    fetchImpl: async () => new Response(body),
  });
  const aborted = assert.rejects(pending, { code: 'PROVIDER_ABORTED' });
  await reading;
  controller.abort(new Error(`private-fixture-detail ${FIXTURE_KEY}`));
  await aborted;
  assert.equal(cancelled, true);
});

test('times out while waiting for the API without exposing the abort reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error(`private-fixture-detail ${FIXTURE_KEY}`)), {
      once: true,
    });
  });
  const pending = runClaudeApi({ message: 'hello', env: ENV, fetchImpl });
  const timedOut = assert.rejects(pending, assertSafeError('PROVIDER_TIMEOUT'));
  t.mock.timers.tick(180_000);
  await timedOut;
});
