// Mocked tests for the protocol v1.1 shared-context additions.
// Nothing here talks to a real bridge, a real browser or a provider CLI.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createClient, UseMyLlmError } from '../dist/index.js';

const ORIGIN = 'https://app.example';
const BRIDGE = 'http://127.0.0.1:43189';
const TOKEN = 'test-token-A_0123456789abcdefghijklmnop';
const HANDLE = `ctx_${'A1b2C3d4'.repeat(5)}abc`;
const OTHER = `ctx_${'Z9y8X7w6'.repeat(5)}xyz`;
const FORK = `ctx_${'F0rkF0rk'.repeat(5)}_-0`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A paired tab talking to an in-process fake bridge. */
function paired(handler, { token = TOKEN } = {}) {
  const calls = [];
  const saved = new Map(token ? [[`localhostagent.v1.token:${BRIDGE}`, token]] : []);
  const client = createClient({
    fetch: async (url, init = {}) => {
      const call = { path: new URL(String(url)).pathname, method: init.method, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) };
      calls.push(call);
      return handler(call);
    },
    location: { href: `${ORIGIN}/app`, origin: ORIGIN, hash: '', assign() {}, replace() {} },
    history: { state: null, replaceState() {} },
    sessionStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: (key) => saved.delete(key) },
    crypto: globalThis.crypto,
  });
  return { client, calls, saved };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof UseMyLlmError);
    assert.equal(error.code, code);
    return true;
  });
}

test('contexts() returns only well-formed entries with opaque handles', async () => {
  const { client, calls } = paired(() => json({
    contexts: [
      { handle: HANDLE, app: 'codex', kind: 'messages', label: 'Codex conversation excerpt (2 messages)', bytes: 120, createdAt: '2026-06-01T00:00:00.000Z' },
      { handle: FORK, app: 'claude-code', kind: 'fork', label: 'Claude Code conversation (continue as a copy)', bytes: 900, createdAt: '2026-06-01T00:00:00.000Z', provider: 'claude', sessionId: 'must be dropped', path: '/must/be/dropped' },
      { handle: 'not-a-handle', app: 'codex', kind: 'memory', label: 'x', bytes: 1, createdAt: 'x' },
      { handle: OTHER, app: 'unknown-app', kind: 'memory', label: 'x', bytes: 1, createdAt: 'x' },
      { handle: OTHER, app: 'codex', kind: 'unknown-kind', label: 'x', bytes: 1, createdAt: 'x' },
      null,
    ],
  }));
  assert.deepEqual(await client.contexts(), [
    { handle: HANDLE, app: 'codex', kind: 'messages', label: 'Codex conversation excerpt (2 messages)', bytes: 120, createdAt: '2026-06-01T00:00:00.000Z' },
    { handle: FORK, app: 'claude-code', kind: 'fork', label: 'Claude Code conversation (continue as a copy)', bytes: 900, createdAt: '2026-06-01T00:00:00.000Z', provider: 'claude' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v1/context');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test('contexts() needs a paired tab and rejects a malformed reply', async () => {
  const unpaired = paired(() => json({ contexts: [] }), { token: null });
  await rejects(unpaired.client.contexts(), 'not_paired');
  assert.equal(unpaired.calls.length, 0);
  await rejects(paired(() => json({ contexts: 'nope' })).client.contexts(), 'invalid_response');
  const expired = paired(() => json({ error: { code: 'UNAUTHORIZED', message: 'Connect this website again.' } }, 401));
  await rejects(expired.client.contexts(), 'UNAUTHORIZED');
  assert.equal(expired.saved.size, 0, 'a rejected token is forgotten');
});

test('chat() and generate() send handles only, and only when asked', async () => {
  const { client, calls } = paired((call) => json({ provider: call.body.provider, reply: 'ok' }));
  await client.chat({ provider: 'codex', message: 'Hello' });
  assert.deepEqual(calls[0].body, { provider: 'codex', message: 'Hello', history: [] });

  await client.chat({ provider: 'codex', message: 'Use these', context: [HANDLE, OTHER] });
  assert.deepEqual(calls[1].body, { provider: 'codex', message: 'Use these', history: [], context: [HANDLE, OTHER] });

  await client.chat({ provider: 'claude', message: 'Go on', continue: FORK, context: [HANDLE] });
  assert.deepEqual(calls[2].body, { provider: 'claude', message: 'Go on', history: [], context: [HANDLE], continue: FORK });

  assert.deepEqual(await client.generate({ provider: 'codex', input: 'Summarise', context: [HANDLE] }), { provider: 'codex', output: 'ok' });
  assert.deepEqual(calls[3].body, { provider: 'codex', message: 'Summarise', history: [], context: [HANDLE] });
});

test('anything that is not a handle is rejected before a request is made', async () => {
  const { client, calls } = paired(() => json({ provider: 'codex', reply: 'ok' }));
  const base = { provider: 'codex', message: 'Hi' };
  for (const context of [
    'ctx', [42], ['11111111-1111-4111-8111-111111111111'], ['/Users/someone/.codex/sessions/rollout.jsonl'],
    [{ source: 'x', text: 'inline' }], [HANDLE, HANDLE], Array.from({ length: 9 }, (_, index) => `ctx_${String(index).repeat(43)}`),
  ]) {
    await rejects(client.chat({ ...base, context }), 'invalid_request');
  }
  await rejects(client.chat({ ...base, continue: 'thread name' }), 'invalid_request');
  await rejects(client.chat({ ...base, continue: HANDLE, context: [HANDLE] }), 'invalid_request');
  await rejects(client.chat({ ...base, continue: FORK, history: [{ role: 'user', content: 'earlier' }] }), 'invalid_request');
  await rejects(client.generate({ provider: 'codex', input: 'Hi', context: ['nope'] }), 'invalid_request');
  assert.equal(calls.length, 0);
});

test('bridge refusals for shared context surface with their code and keep the session', async () => {
  const { client, saved } = paired(() => json({ error: { code: 'CONTEXT_DENIED', message: 'This context is not shared with this website.' } }, 403));
  await assert.rejects(client.chat({ provider: 'codex', message: 'Hi', context: [HANDLE] }), (error) => {
    assert.equal(error.code, 'CONTEXT_DENIED');
    assert.equal(error.status, 403);
    assert.equal(error.message.includes(HANDLE), false);
    return true;
  });
  assert.equal(saved.size, 1);
});

test('status() reports context support only when the bridge advertises it', async () => {
  const providers = [{ id: 'codex', available: true }];
  const v11 = paired(() => json({ service: 'localhost-agent-sdk', version: 1, connected: true, providers, protocol: '1.1', context: true }));
  assert.deepEqual(await v11.client.status(), { service: 'localhost-agent-sdk', version: 1, connected: true, providers, context: true });
  const v1 = paired(() => json({ service: 'localhost-agent-sdk', version: 1, connected: true, providers }));
  assert.deepEqual(await v1.client.status(), { service: 'localhost-agent-sdk', version: 1, connected: true, providers });
});
