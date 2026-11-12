// Protocol v1.1 over HTTP: a website sees and sends opaque handles only.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { share } from '../dist/context/service.mjs';
import { listSources } from '../dist/context/sources/index.mjs';
import { createContextStore } from '../dist/context/store.mjs';
import { createBridge } from '../dist/server.mjs';
import { allFixtures, IDS, SECRETS } from '../test-support/fixtures.mjs';

const SITE_A = 'https://alpha.example';
const SITE_B = 'https://beta.example';
const PROVIDERS = [
  { id: 'codex', available: true },
  { id: 'claude', available: true },
  { id: 'antigravity', available: false },
];

async function setup(t, { withStore = true, providerStatuses = PROVIDERS, providerRun } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'use-my-llm-v11-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = allFixtures(root);
  const store = createContextStore({ dataDir: fixtures.dataDir });
  const calls = [];
  const bridge = createBridge({
    port: 0,
    getProviders: () => providerStatuses,
    runProvider: async (request) => {
      calls.push(request);
      return providerRun ? providerRun(request) : { provider: request.provider, reply: 'ok' };
    },
    ...(withStore && { context: store }),
  });
  const address = await bridge.listen();
  t.after(() => bridge.close());
  const base = `http://127.0.0.1:${address.port}`;

  async function connect(origin) {
    const query = new URLSearchParams({ origin, return_url: `${origin}/app`, nonce: 'valid_nonce_01234567890123456789' });
    const page = await (await fetch(`${base}/v1/pair?${query}`)).text();
    const csrf = page.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1];
    const approved = await fetch(`${base}/v1/pair/approve`, {
      method: 'POST', redirect: 'manual', headers: { Origin: base }, body: new URLSearchParams({ csrf, decision: 'allow' }),
    });
    return new URLSearchParams(new URL(approved.headers.get('location')).hash.slice(1)).get('localhostagent_token');
  }
  const headers = (origin, token) => ({ Origin: origin, Authorization: `Bearer ${token}` });
  const get = (path, origin, token) => fetch(`${base}${path}`, { headers: headers(origin, token) });
  const chat = (origin, token, body) => fetch(`${base}/v1/chat`, {
    method: 'POST', headers: { ...headers(origin, token), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const item = (app, match) => listSources(fixtures.locations, { apps: [app] }).items.find(match);
  const grant = (origin, options) => share({ origin, ...options }, { locations: fixtures.locations, store }).meta;
  return { ...fixtures, store, calls, base, connect, get, chat, item, grant };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}

test('a paired website lists only its own handles and the bridge advertises v1.1', async (t) => {
  const { connect, get, grant, item, base } = await setup(t);
  const tokenA = await connect(SITE_A);
  const tokenB = await connect(SITE_B);
  assert.deepEqual(await (await get('/v1/context', SITE_A, tokenA)).json(), { contexts: [] });

  const memory = item('codex', (entry) => entry.kind === 'memory').ref;
  const meta = grant(SITE_A, { ref: memory });
  const listed = await (await get('/v1/context', SITE_A, tokenA)).json();
  assert.deepEqual(listed, {
    contexts: [{ handle: meta.handle, app: 'codex', kind: 'memory', label: 'Codex memory', bytes: meta.bytes, createdAt: meta.createdAt }],
  });
  assert.deepEqual(await (await get('/v1/context', SITE_B, tokenB)).json(), { contexts: [] });

  const status = await (await get('/v1/status', SITE_A, tokenA)).json();
  assert.equal(status.version, 1);
  assert.equal(status.protocol, '1.1');
  assert.equal(status.context, true);

  await expectError(await fetch(`${base}/v1/context`, { headers: { Origin: SITE_A } }), 401, 'UNAUTHORIZED');
  await expectError(await get('/v1/context', SITE_B, tokenA), 401, 'UNAUTHORIZED');
  const preflight = await fetch(`${base}/v1/context`, {
    method: 'OPTIONS', headers: { Origin: SITE_A, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
});

test('selected text reaches the provider as quoted context and each use is logged without content', async (t) => {
  const { connect, chat, grant, item, calls, store, dataDir } = await setup(t);
  const token = await connect(SITE_A);
  const session = item('codex', (entry) => entry.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref;
  const excerpt = grant(SITE_A, { ref: session, from: 1, to: 3 });
  const memory = grant(SITE_A, { ref: item('claude-code', (entry) => entry.title === 'layout.md').ref });

  const response = await chat(SITE_A, token, { provider: 'claude', message: 'Summarise what I shared.', context: [excerpt.handle, memory.handle] });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const [request] = calls;
  assert.deepEqual(Object.keys(request).sort(), ['context', 'history', 'message', 'provider', 'signal']);
  assert.deepEqual(request.context.map(({ source }) => source), ['codex:messages', 'claude-code:memory']);
  assert.match(request.context[0].text, /^User: How should the lighthouse keeper schedule the lamp rotation\?/);
  assert.equal(request.context[0].text.includes(SECRETS.openai), false);
  assert.equal(request.context[1].text, 'The orchard has nine rows running north to south.\n');
  // Nothing the provider receives identifies the original session or file.
  const delivered = JSON.stringify(request.context);
  for (const hidden of [IDS.codexPlain, 'Private thread name', 'rollout-', 'layout.md', excerpt.handle]) {
    assert.equal(delivered.includes(hidden), false, hidden);
  }

  // A Claude Code memory sent through Claude and a Codex excerpt sent through Claude are both logged.
  const log = store.readLog();
  assert.deepEqual(log.map(({ origin, provider, snapshot, bytes }) => ({ origin, provider, snapshot, bytes })), [
    { origin: SITE_A, provider: 'claude', snapshot: excerpt.id, bytes: excerpt.bytes },
    { origin: SITE_A, provider: 'claude', snapshot: memory.id, bytes: memory.bytes },
  ]);
  const raw = readFileSync(join(dataDir, 'context', 'access.jsonl'), 'utf8');
  for (const hidden of ['lighthouse', 'orchard', excerpt.handle, 'Summarise']) assert.equal(raw.includes(hidden), false, hidden);

  // A request without context is exactly a v1 request and is not logged.
  await chat(SITE_A, token, { provider: 'codex', message: 'Hello' });
  assert.deepEqual(Object.keys(calls[1]).sort(), ['history', 'message', 'provider', 'signal']);
  assert.equal(store.readLog().length, 2);
});

test('another website cannot use, probe or revoke-survive a handle', async (t) => {
  const { connect, chat, get, grant, item, calls, store } = await setup(t);
  const tokenA = await connect(SITE_A);
  const tokenB = await connect(SITE_B);
  const ref = item('codex', (entry) => entry.kind === 'memory').ref;
  const forA = grant(SITE_A, { ref });
  grant(SITE_B, { ref: item('codex', (entry) => entry.kind === 'instructions').ref });

  // The other site's real handle and a made-up one fail identically.
  const stolen = await chat(SITE_B, tokenB, { provider: 'codex', message: 'Use it', context: [forA.handle] });
  const guessed = await chat(SITE_B, tokenB, { provider: 'codex', message: 'Use it', context: [`ctx_${'q'.repeat(43)}`] });
  assert.equal(stolen.status, 403);
  assert.deepEqual(await stolen.json(), await guessed.json());
  assert.equal(calls.length, 0);
  assert.equal(store.readLog().length, 0);

  assert.equal((await chat(SITE_A, tokenA, { provider: 'codex', message: 'Use it', context: [forA.handle] })).status, 200);
  store.revokeOrigin(SITE_A);
  await expectError(await chat(SITE_A, tokenA, { provider: 'codex', message: 'Use it', context: [forA.handle] }), 403, 'CONTEXT_DENIED');
  assert.deepEqual(await (await get('/v1/context', SITE_A, tokenA)).json(), { contexts: [] });
  assert.equal((await (await get('/v1/context', SITE_B, tokenB)).json()).contexts.length, 1);
  assert.equal(calls.length, 1);
});

test('ids, names and paths are never accepted in place of a handle', async (t) => {
  const { connect, chat, grant, item, calls, codex } = await setup(t);
  const token = await connect(SITE_A);
  const session = item('codex', (entry) => entry.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref;
  const { handle } = grant(SITE_A, { ref: session, from: 1, to: 1 });
  const invalid = [
    { context: [IDS.codexPlain] },
    { context: ['Private thread name: lamp rotation'] },
    { context: [codex.plain] },
    { context: [session] },
    { context: [{ source: 'x', text: 'inline text is not accepted' }] },
    { context: 'ctx' },
    { context: [handle, handle] },
    { context: Array.from({ length: 9 }, (_, index) => `ctx_${String(index).repeat(43)}`) },
    { continue: IDS.codexPlain },
    { continue: handle, context: [handle] },
    { continue: handle, history: [{ role: 'user', content: 'earlier' }] },
  ];
  for (const extra of invalid) {
    await expectError(await chat(SITE_A, token, { provider: 'codex', message: 'Hi', ...extra }), 400, 'INVALID_CONTEXT');
  }
  await expectError(await chat(SITE_A, token, { provider: 'codex', message: 'Hi', sessionId: IDS.codexPlain }), 400, 'INVALID_REQUEST');
  await expectError(await chat(SITE_A, token, { provider: 'codex', message: 'Hi', path: codex.plain }), 400, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('a conversation copy is continued only through continue, and only with its own provider', async (t) => {
  const { connect, chat, get, grant, item, calls, store, claude } = await setup(t);
  const token = await connect(SITE_A);
  const codexSession = item('codex', (entry) => entry.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref;
  const fork = grant(SITE_A, { ref: codexSession, fork: true });
  const text = grant(SITE_A, { ref: codexSession, from: 1, to: 1 });
  const claudeFork = grant(SITE_A, { ref: item('claude-code', (entry) => entry.ref.endsWith(`${IDS.claude}.jsonl`)).ref, fork: true });

  const listed = (await (await get('/v1/context', SITE_A, token)).json()).contexts;
  assert.deepEqual(listed.map(({ kind, provider, label }) => ({ kind, provider, label })), [
    { kind: 'fork', provider: 'codex', label: 'Codex conversation (continue as a copy)' },
    { kind: 'messages', provider: undefined, label: 'Codex conversation excerpt (1 message)' },
    { kind: 'fork', provider: 'claude', label: 'Claude Code conversation (continue as a copy)' },
  ]);
  assert.equal(JSON.stringify(listed).includes(IDS.codexPlain), false);
  assert.equal(JSON.stringify(listed).includes(IDS.claude), false);

  await expectError(await chat(SITE_A, token, { provider: 'codex', message: 'Go on', context: [fork.handle] }), 400, 'INVALID_CONTEXT');
  await expectError(await chat(SITE_A, token, { provider: 'codex', message: 'Go on', continue: text.handle }), 400, 'INVALID_CONTEXT');
  await expectError(await chat(SITE_A, token, { provider: 'claude', message: 'Go on', continue: fork.handle }), 400, 'CONTEXT_PROVIDER_MISMATCH');
  assert.equal(calls.length, 0);

  assert.equal((await chat(SITE_A, token, { provider: 'codex', message: 'Go on', continue: fork.handle, context: [text.handle] })).status, 200);
  assert.equal(calls[0].fork.provider, 'codex');
  assert.deepEqual(calls[0].fork, { provider: 'codex' });
  assert.match(calls[0].forkTranscript, /User: How should the lighthouse keeper/);
  assert.equal(calls[0].forkTranscript.includes(SECRETS.openai), false);
  assert.deepEqual(calls[0].context.map(({ source }) => source), ['codex:messages']);
  assert.deepEqual(calls[0].history, []);

  assert.equal((await chat(SITE_A, token, { provider: 'claude', message: 'Go on', continue: claudeFork.handle })).status, 200);
  assert.equal(calls[1].fork.provider, 'claude');
  assert.equal(calls[1].fork.configDir.startsWith(store.directory), true, 'the copy lives in bridge-only storage');
  assert.equal(calls[1].fork.configDir.startsWith(claude.home), false);
  assert.deepEqual(store.readLog().map(({ provider, snapshot }) => `${provider}:${snapshot}`), [
    `codex:${text.id}`, `codex:${fork.id}`, `claude:${claudeFork.id}`,
  ]);
});

test('continuation-only availability keeps ordinary inference disabled and uses frozen text', async (t) => {
  const providerStatuses = [{ id: 'antigravity', available: false, continuationAvailable: true }];
  const { connect, get, chat, item, grant, calls } = await setup(t, { providerStatuses });
  const token = await connect(SITE_A);
  const status = await (await get('/v1/status', SITE_A, token)).json();
  assert.deepEqual(status.providers.find(({ id }) => id === 'antigravity'), providerStatuses[0]);
  const source = item('antigravity', (entry) => entry.kind === 'session');
  const fork = grant(SITE_A, { ref: source.ref, fork: true });
  await expectError(await chat(SITE_A, token, { provider: 'antigravity', message: 'Start' }), 503, 'PROVIDER_UNAVAILABLE');
  assert.equal(calls.length, 0);
  const response = await chat(SITE_A, token, { provider: 'antigravity', message: 'Go on', continue: fork.handle });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].fork, { provider: 'antigravity' });
  assert.match(calls[0].forkTranscript, /^User: /);
});

test('revoking a share while inference is running suppresses the late reply', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { connect, chat, item, grant, store } = await setup(t, {
    providerRun: async ({ provider }) => {
      started.resolve();
      await release.promise;
      return { provider, reply: 'private fixture reply' };
    },
  });
  const token = await connect(SITE_A);
  const snapshot = grant(SITE_A, { ref: item('codex', (entry) => entry.kind === 'memory').ref });
  const pending = chat(SITE_A, token, { provider: 'codex', message: 'Summarize', context: [snapshot.handle] });
  await started.promise;
  assert.equal(store.revokeOrigin(SITE_A), true);
  release.resolve();
  await expectError(await pending, 403, 'CONTEXT_DENIED');
});

test('a bridge without a context store refuses every handle and does not advertise v1.1', async (t) => {
  const { connect, chat, get, calls } = await setup(t, { withStore: false });
  const token = await connect(SITE_A);
  assert.deepEqual(await (await get('/v1/context', SITE_A, token)).json(), { contexts: [] });
  const status = await (await get('/v1/status', SITE_A, token)).json();
  assert.equal('protocol' in status, false);
  await expectError(await chat(SITE_A, token, { provider: 'codex', message: 'Hi', context: [`ctx_${'a'.repeat(43)}`] }), 403, 'CONTEXT_DENIED');
  assert.equal(calls.length, 0);
});

test('a request cannot attach more shared text than the per-request limit', async (t) => {
  const { connect, chat, calls, store } = await setup(t);
  const token = await connect(SITE_A);
  const handles = [1, 2, 3].map((index) => store.grant(SITE_A, { app: 'codex', kind: 'memory', label: `Part ${index}`, text: 'x'.repeat(150_000) }).handle);
  assert.equal((await chat(SITE_A, token, { provider: 'codex', message: 'Hi', context: handles.slice(0, 2) })).status, 200);
  await expectError(await chat(SITE_A, token, { provider: 'codex', message: 'Hi', context: handles }), 413, 'CONTEXT_TOO_LARGE');
  assert.equal(calls.length, 1);
});
