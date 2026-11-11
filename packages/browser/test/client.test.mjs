// Mocked tests: every browser API and the bridge are in-process fakes.
// Nothing here talks to a real bridge, a real browser or a provider CLI.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createClient, DEFAULT_BRIDGE_URL, UseMyLlmError, PROVIDERS } from '../dist/index.js';

const ORIGIN = 'https://app.example';
const PAGE = `${ORIGIN}/app?view=chat`;
const SERVICE = 'localhost-agent-sdk';
// Fake values that only exist inside these tests.
const TOKEN = 'test-token-A_0123456789abcdefghijklmnop';
const TOKEN_B = 'test-token-B_zyxwvutsrqponmlkjihgfedcba';
const ATTACKER_TOKEN = 'attacker-token_0123456789abcdefghijkl';

// ---------------------------------------------------------------- fakes

function createStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => {
      map.set(String(key), String(value));
    },
    removeItem: (key) => {
      map.delete(String(key));
    },
    values: () => [...map.values()],
    get size() {
      return map.size;
    },
  };
}

/** One browser tab: a location, its history and its own sessionStorage. */
function createBrowser(href, { sessionStorage = createStorage() } = {}) {
  let url = new URL(href);
  const navigations = [];
  const location = {
    get href() {
      return url.href;
    },
    get origin() {
      return url.origin;
    },
    get hash() {
      return url.hash;
    },
    assign(next) {
      navigations.push(String(next));
    },
    replace(next) {
      url = new URL(String(next), url);
    },
  };
  const history = {
    state: { scroll: 42 },
    replaced: [],
    replaceState(state, _unused, next) {
      const resolved = new URL(String(next), url);
      if (resolved.origin !== url.origin) throw new Error('SecurityError');
      this.replaced.push({ state, url: resolved.href });
      url = resolved;
    },
  };
  return {
    location,
    history,
    sessionStorage,
    navigations,
    /** Simulates the tab landing on a new URL (e.g. the bridge's 303 redirect). */
    arrive(next) {
      url = new URL(next);
    },
    get href() {
      return url.href;
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch stand-in that records every request the client makes. */
function createBridge(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      path: new URL(String(url)).pathname,
      init,
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

/** Mock of the v1 bridge HTTP API with a revocable token set. */
function bridgeHandler({ tokens = new Set([TOKEN]), chat } = {}) {
  return (call) => {
    const auth = call.headers.Authorization;
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const authed = bearer !== null && tokens.has(bearer);
    if (call.path === '/v1/status') {
      return json(
        authed
          ? {
              service: SERVICE,
              version: 1,
              connected: true,
              providers: [
                { id: 'codex', available: true },
                { id: 'claude', available: false },
                { id: 'antigravity', available: false },
              ],
            }
          : { service: SERVICE, version: 1, connected: false },
      );
    }
    if (!authed) return json({ error: { code: 'unauthorized', message: 'Invalid or expired token.' } }, 401);
    if (call.path === '/v1/chat') {
      return chat ? chat(call) : json({ provider: call.body.provider, reply: `echo:${call.body.message}` });
    }
    if (call.path === '/v1/disconnect') {
      tokens.delete(bearer);
      return json({ disconnected: true });
    }
    return json({ error: { code: 'not_found', message: 'Not found.' } }, 404);
  };
}

/** A request that never answers until its signal aborts, like a slow provider. */
function hang(signal) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function setup({ href = PAGE, handler = bridgeHandler(), bridgeUrl, storage, now, overrides = {} } = {}) {
  const browser = createBrowser(href, { sessionStorage: storage });
  const bridge = createBridge(handler);
  const client = createClient({
    bridgeUrl,
    fetch: bridge.fetch,
    location: browser.location,
    history: browser.history,
    sessionStorage: browser.sessionStorage,
    crypto: globalThis.crypto,
    now,
    ...overrides,
  });
  return { browser, bridge, client };
}

/** Simulates the bridge's post-approval redirect back to the validated callback. */
function approve(browser, { token = TOKEN, fragment } = {}) {
  const pairUrl = new URL(browser.navigations.at(-1));
  const returnUrl = pairUrl.searchParams.get('return_url');
  const nonce = pairUrl.searchParams.get('nonce');
  const hash = fragment ? fragment(nonce) : `#localhostagent_token=${token}&localhostagent_nonce=${nonce}`;
  browser.arrive(`${returnUrl}${hash}`);
  return { pairUrl, returnUrl, nonce };
}

async function pairAndComplete(ctx, { token = TOKEN, returnUrl } = {}) {
  await ctx.client.pair(returnUrl === undefined ? undefined : { returnUrl });
  approve(ctx.browser, { token });
  return ctx.client.completePairing();
}

function assertNoLeak(error, ...secrets) {
  const text = `${error.name} ${error.code} ${error.message} ${error.stack} ${JSON.stringify(error)}`;
  for (const secret of secrets) assert.ok(!text.includes(secret), 'error must not contain the token');
}

async function rejectsWithCode(promise, code, check) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof UseMyLlmError, `expected UseMyLlmError, got ${error}`);
    assert.equal(error.code, code);
    assertNoLeak(error, TOKEN, TOKEN_B, ATTACKER_TOKEN);
    check?.(error);
    return true;
  });
}

// ---------------------------------------------------------------- bridge URL

test('uses the default loopback bridge and accepts another loopback port', async () => {
  assert.equal(DEFAULT_BRIDGE_URL, 'http://127.0.0.1:43189');
  assert.deepEqual([...PROVIDERS], ['codex', 'claude', 'antigravity']);

  const byDefault = setup();
  await byDefault.client.status();
  assert.equal(byDefault.bridge.calls[0].url, 'http://127.0.0.1:43189/v1/status');

  const custom = setup({ bridgeUrl: 'http://127.0.0.1:50123/' });
  await custom.client.status();
  assert.equal(custom.bridge.calls[0].url, 'http://127.0.0.1:50123/v1/status');
});

test('rejects any bridgeUrl that is not exactly http://127.0.0.1:<port>', () => {
  const rejected = [
    'https://bridge.evil.example',
    'https://127.0.0.1:43189',
    'http://localhost:43189',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:043189',
    'http://127.0.0.1:43189/v1',
    'http://127.0.0.1:43189?x=1',
    'http://127.0.0.1:43189#x',
    'http://127.0.0.1:43189@evil.example',
    'http://user:pw@127.0.0.1:43189',
    'http://127.0.0.1.evil.example:43189',
    'http://127.0.0.1:43189.evil.example',
    'http://[::1]:43189',
    'http://0.0.0.0:43189',
    'http://127.1:43189',
    'http://2130706433:43189',
    '//127.0.0.1:43189',
    ' http://127.0.0.1:43189',
    'http://127.0.0.1:43189\n',
    'HTTP://127.0.0.1:43189',
    '',
    null,
    43189,
    new URL('http://127.0.0.1:43189'),
  ];
  let fetched = 0;
  for (const bridgeUrl of rejected) {
    assert.throws(
      () => createClient({ bridgeUrl, fetch: () => (fetched += 1) }),
      (error) => error instanceof UseMyLlmError && error.code === 'invalid_bridge_url',
      `expected ${String(bridgeUrl)} to be rejected`,
    );
  }
  assert.equal(fetched, 0);
});

// ---------------------------------------------------------------- pair()

test('pair() navigates to the bridge with the exact origin, a fragment-less return URL and a fresh nonce', async () => {
  const ctx = setup({ href: `${PAGE}#section-2` });
  await ctx.client.pair();

  assert.equal(ctx.browser.navigations.length, 1);
  assert.equal(ctx.bridge.calls.length, 0, 'pairing is a navigation, never a fetch');
  const pairUrl = new URL(ctx.browser.navigations[0]);
  assert.equal(`${pairUrl.origin}${pairUrl.pathname}`, 'http://127.0.0.1:43189/v1/pair');
  assert.deepEqual([...pairUrl.searchParams.keys()], ['origin', 'return_url', 'nonce']);
  assert.equal(pairUrl.searchParams.get('origin'), ORIGIN);
  assert.equal(pairUrl.searchParams.get('return_url'), PAGE);
  assert.match(pairUrl.searchParams.get('nonce'), /^[0-9a-f]{64}$/);
  assert.equal(pairUrl.hash, '');

  await ctx.client.pair();
  const second = new URL(ctx.browser.navigations[1]).searchParams.get('nonce');
  assert.notEqual(second, pairUrl.searchParams.get('nonce'));
});

test('pair() resolves a same-origin returnUrl and keeps its path and query', async () => {
  const ctx = setup();
  await ctx.client.pair({ returnUrl: '/callback?step=2&x=a%20b' });
  const pairUrl = new URL(ctx.browser.navigations[0]);
  assert.equal(pairUrl.searchParams.get('return_url'), `${ORIGIN}/callback?step=2&x=a%20b`);
});

test('pair() rejects return URLs on another origin or with credentials, without navigating', async () => {
  const rejected = [
    'https://evil.example/callback',
    '//evil.example/callback',
    'https://app.example.evil.example/callback',
    'http://app.example/callback',
    'https://app.example:8443/callback',
    'https://user:pw@app.example/callback',
    'javascript:alert(1)',
    'data:text/html,hi',
    42,
    null,
  ];
  for (const returnUrl of rejected) {
    const ctx = setup();
    await rejectsWithCode(ctx.client.pair({ returnUrl }), 'invalid_return_url');
    assert.equal(ctx.browser.navigations.length, 0, `navigated for ${String(returnUrl)}`);
    assert.equal(ctx.browser.sessionStorage.size, 0);
  }
});

test('pair() only runs on https origins or loopback development origins with a port', async () => {
  for (const href of ['http://example.com/app', 'http://localhost/app', 'http://192.168.0.5:3000/', 'file:///tmp/index.html']) {
    const ctx = setup({ href });
    await rejectsWithCode(ctx.client.pair(), 'invalid_origin');
    assert.equal(ctx.browser.navigations.length, 0, `navigated from ${href}`);
    assert.equal(ctx.browser.sessionStorage.size, 0);
  }
  for (const href of ['http://localhost:5173/app', 'http://127.0.0.1:8080/']) {
    const ctx = setup({ href });
    await ctx.client.pair();
    const pairUrl = new URL(ctx.browser.navigations[0]);
    assert.equal(pairUrl.searchParams.get('origin'), new URL(href).origin);
  }
});

test('pair() fails closed without a secure random source or without sessionStorage', async () => {
  const noCrypto = setup({ overrides: { crypto: {} } });
  await rejectsWithCode(noCrypto.client.pair(), 'environment_unavailable');
  assert.equal(noCrypto.browser.navigations.length, 0);

  const brokenCrypto = setup({ overrides: { crypto: { getRandomValues: (bytes) => bytes } } });
  await rejectsWithCode(brokenCrypto.client.pair(), 'environment_unavailable');
  assert.equal(brokenCrypto.browser.navigations.length, 0);

  const storage = createStorage();
  storage.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const noStorage = setup({ storage });
  await rejectsWithCode(noStorage.client.pair(), 'storage_unavailable');
  assert.equal(noStorage.browser.navigations.length, 0);
});

test('pair() never persists a stale callback fragment that may hold a token', async () => {
  const ctx = setup({ href: `${PAGE}#localhostagent_token=${TOKEN}&localhostagent_nonce=${'a'.repeat(64)}` });
  await ctx.client.pair();
  assert.ok(!ctx.browser.sessionStorage.values().join('\n').includes(TOKEN));
  assert.ok(!ctx.browser.navigations[0].includes(TOKEN));
});

// ---------------------------------------------------------------- completePairing()

test('completePairing() scrubs the fragment synchronously, restores the old one and stores only the token', async () => {
  const ctx = setup({ href: `${PAGE}#section-2` });
  await ctx.client.pair();
  approve(ctx.browser);
  assert.ok(ctx.browser.href.includes(TOKEN), 'precondition: the callback URL carries the token');

  const pending = ctx.client.completePairing();
  // Checked before awaiting anything: the token is already out of the URL.
  assert.equal(ctx.browser.href, `${PAGE}#section-2`);
  assert.deepEqual(ctx.browser.history.replaced, [{ state: { scroll: 42 }, url: `${PAGE}#section-2` }]);

  assert.deepEqual(await pending, { paired: true });
  assert.deepEqual(ctx.browser.sessionStorage.values(), [TOKEN]);
  assert.equal(ctx.bridge.calls.length, 0, 'completePairing performs no network I/O');

  const status = await ctx.client.status();
  assert.equal(status.connected, true);
  assert.equal(ctx.bridge.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test('completePairing() restores the fragment of an explicit returnUrl and leaves no fragment when there was none', async () => {
  const withFragment = setup();
  assert.deepEqual(await pairAndComplete(withFragment, { returnUrl: '/callback?step=2#resume' }), { paired: true });
  assert.equal(withFragment.browser.href, `${ORIGIN}/callback?step=2#resume`);

  const without = setup();
  assert.deepEqual(await pairAndComplete(without), { paired: true });
  assert.equal(without.browser.href, PAGE);
});

test('completePairing() is a no-op when the URL carries no callback', async () => {
  const ctx = setup({ href: `${PAGE}#section-2` });
  assert.deepEqual(await ctx.client.completePairing(), { paired: false, reason: 'no_callback' });
  assert.equal(ctx.browser.href, `${PAGE}#section-2`);
  assert.equal(ctx.browser.history.replaced.length, 0);
  assert.equal(ctx.browser.sessionStorage.size, 0);
});

test('completePairing() rejects a nonce mismatch, stores nothing and cannot be retried', async () => {
  const ctx = setup({ href: `${PAGE}#section-2` });
  await ctx.client.pair();
  const { nonce, returnUrl } = approve(ctx.browser, {
    fragment: () => `#localhostagent_token=${ATTACKER_TOKEN}&localhostagent_nonce=${'f'.repeat(64)}`,
  });

  await rejectsWithCode(ctx.client.completePairing(), 'pairing_nonce_mismatch');
  assert.equal(ctx.browser.href, `${PAGE}#section-2`, 'the fragment is scrubbed even on failure');
  assert.equal(ctx.browser.sessionStorage.size, 0);

  // The pending nonce is single-use: even the genuine callback is refused afterwards.
  ctx.browser.arrive(`${returnUrl}#localhostagent_token=${TOKEN}&localhostagent_nonce=${nonce}`);
  await rejectsWithCode(ctx.client.completePairing(), 'pairing_not_pending');
  assert.equal(ctx.browser.sessionStorage.size, 0);
  assert.ok(!ctx.browser.href.includes('localhostagent'));
});

test('completePairing() only accepts the nonce of the latest pair() call', async () => {
  const ctx = setup();
  await ctx.client.pair();
  const firstNonce = new URL(ctx.browser.navigations[0]).searchParams.get('nonce');
  await ctx.client.pair();
  approve(ctx.browser, { fragment: () => `#localhostagent_token=${TOKEN}&localhostagent_nonce=${firstNonce}` });
  await rejectsWithCode(ctx.client.completePairing(), 'pairing_nonce_mismatch');
  assert.equal(ctx.browser.sessionStorage.size, 0);
});

test('completePairing() rejects tampered callback fragments', async () => {
  const cases = {
    'missing nonce': () => `#localhostagent_token=${TOKEN}`,
    'missing token': (nonce) => `#localhostagent_nonce=${nonce}`,
    'duplicate token': (nonce) =>
      `#localhostagent_token=${TOKEN}&localhostagent_token=${ATTACKER_TOKEN}&localhostagent_nonce=${nonce}`,
    'extra parameter': (nonce) =>
      `#localhostagent_token=${TOKEN}&localhostagent_nonce=${nonce}&next=https://evil.example`,
    'unknown sdk parameter': (nonce) => `#localhostagent_token=${TOKEN}&localhostagent_origin=${nonce}`,
    'malformed encoding': (nonce) => `#localhostagent_token=%E0%A4%A&localhostagent_nonce=${nonce}`,
    'token too short': (nonce) => `#localhostagent_token=short&localhostagent_nonce=${nonce}`,
    'token with whitespace': (nonce) =>
      `#localhostagent_token=${encodeURIComponent('tok en-with-space-0123456789abcdef')}&localhostagent_nonce=${nonce}`,
    'valueless token': (nonce) => `#localhostagent_token&localhostagent_nonce=${nonce}`,
  };
  for (const [name, fragment] of Object.entries(cases)) {
    const ctx = setup();
    await ctx.client.pair();
    approve(ctx.browser, { fragment });
    await rejectsWithCode(ctx.client.completePairing(), 'invalid_callback');
    assert.ok(!ctx.browser.href.includes('localhostagent'), `${name}: fragment must be scrubbed`);
    assert.equal(ctx.browser.sessionStorage.size, 0, `${name}: nothing may be stored`);
  }
});

test('completePairing() rejects a callback that was never requested and keeps the existing session', async () => {
  const ctx = setup();
  assert.deepEqual(await pairAndComplete(ctx), { paired: true });

  // Session fixation attempt: an attacker links the user to a callback URL carrying their own token.
  ctx.browser.arrive(`${PAGE}#localhostagent_token=${ATTACKER_TOKEN}&localhostagent_nonce=${'0'.repeat(64)}`);
  await rejectsWithCode(ctx.client.completePairing(), 'pairing_not_pending');
  assert.equal(ctx.browser.href, PAGE);
  assert.deepEqual(ctx.browser.sessionStorage.values(), [TOKEN]);

  // Replaying the genuine, already-used callback is refused as well.
  const replay = setup();
  await replay.client.pair();
  const { returnUrl, nonce } = approve(replay.browser);
  assert.deepEqual(await replay.client.completePairing(), { paired: true });
  replay.browser.arrive(`${returnUrl}#localhostagent_token=${ATTACKER_TOKEN}&localhostagent_nonce=${nonce}`);
  await rejectsWithCode(replay.client.completePairing(), 'pairing_not_pending');
  assert.deepEqual(replay.browser.sessionStorage.values(), [TOKEN]);
});

test('completePairing() rejects an expired pairing attempt', async () => {
  let clock = 1_700_000_000_000;
  const ctx = setup({ now: () => clock });
  await ctx.client.pair();
  clock += 10 * 60 * 1000 + 1;
  approve(ctx.browser);
  await rejectsWithCode(ctx.client.completePairing(), 'pairing_expired');
  assert.equal(ctx.browser.href, PAGE);
  assert.equal(ctx.browser.sessionStorage.size, 0);

  const fresh = setup({ now: () => clock });
  await fresh.client.pair();
  clock += 10 * 60 * 1000;
  approve(fresh.browser);
  assert.deepEqual(await fresh.client.completePairing(), { paired: true });
});

test('completePairing() falls back to location.replace and fails closed when the URL cannot be cleaned', async () => {
  const blockedHistory = {
    state: null,
    replaceState() {
      throw new Error('blocked');
    },
  };

  const fallback = setup({ overrides: { history: blockedHistory } });
  await fallback.client.pair();
  approve(fallback.browser);
  assert.deepEqual(await fallback.client.completePairing(), { paired: true });
  assert.ok(!fallback.browser.href.includes('localhostagent'));
  assert.ok(fallback.browser.href.startsWith(PAGE), 'path and query survive the fallback');

  const stuck = setup({ overrides: { history: blockedHistory } });
  stuck.browser.location.replace = () => {
    throw new Error('blocked');
  };
  await stuck.client.pair();
  approve(stuck.browser);
  await rejectsWithCode(stuck.client.completePairing(), 'callback_cleanup_failed');
  assert.equal(stuck.browser.sessionStorage.size, 0, 'a token that could not be scrubbed is not adopted');
});

// ---------------------------------------------------------------- status()

test('status() without a session sends no credentials and reports disconnected', async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.client.status(), { service: SERVICE, version: 1, connected: false, providers: [] });
  const [call] = ctx.bridge.calls;
  assert.equal(call.init.method, 'GET');
  assert.equal('Authorization' in call.headers, false);
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.targetAddressSpace, 'loopback');
  assert.equal(call.init.referrerPolicy, 'no-referrer');
});

test('status() reports providers for a paired tab and ignores malformed provider entries', async () => {
  const handler = () =>
    json({
      service: SERVICE,
      version: 1,
      connected: true,
      providers: [
        { id: 'codex', available: true },
        { id: 'claude', available: false },
        { id: 'shell', available: true },
        { id: 'antigravity', available: 'yes' },
        null,
      ],
    });
  const ctx = setup({ handler });
  await pairAndComplete(ctx);
  assert.deepEqual(await ctx.client.status(), {
    service: SERVICE,
    version: 1,
    connected: true,
    providers: [
      { id: 'codex', available: true },
      { id: 'claude', available: false },
    ],
  });
});

test('status() drops a token the bridge no longer accepts', async () => {
  const tokens = new Set([TOKEN]);
  const ctx = setup({ handler: bridgeHandler({ tokens }) });
  await pairAndComplete(ctx);
  assert.equal((await ctx.client.status()).connected, true);

  tokens.delete(TOKEN); // expired or revoked on the bridge
  assert.equal((await ctx.client.status()).connected, false);
  assert.equal(ctx.browser.sessionStorage.size, 0);

  await ctx.client.status();
  assert.equal('Authorization' in ctx.bridge.calls.at(-1).headers, false, 'the dead token is not sent again');
});

test('status() rejects responses that do not come from a v1 bridge', async () => {
  const responses = [
    json({ service: 'something-else', version: 1, connected: false }),
    json({ service: SERVICE, version: 2, connected: false }),
    json({ service: SERVICE, version: 1, connected: 'yes' }),
    json({ service: SERVICE, version: 1, connected: true, providers: [] }), // "connected" without any credentials
    json([1, 2, 3]),
    new Response('<html>not json</html>', { status: 200 }),
    { ok: true, status: 200, redirected: true, json: async () => ({ service: SERVICE, version: 1, connected: false }) },
  ];
  for (const response of responses) {
    const ctx = setup({ handler: () => response });
    await rejectsWithCode(ctx.client.status(), 'invalid_response');
  }
});

test('status() reports an unreachable bridge without leaking details', async () => {
  const ctx = setup({
    handler: () => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
    },
  });
  await pairAndComplete(ctx);
  await rejectsWithCode(ctx.client.status(), 'bridge_unreachable', (error) => {
    assert.equal(error.status, undefined);
    assert.equal(error.cause, undefined);
  });
  assert.deepEqual(ctx.browser.sessionStorage.values(), [TOKEN], 'a network failure does not end the session');
});

// ---------------------------------------------------------------- chat()

test('generate() enables a one-shot website feature without sending prior chat history', async () => {
  const ctx = setup();
  await pairAndComplete(ctx);
  const result = await ctx.client.generate({ provider: 'codex', input: 'Summarize: one two three', cwd: '/etc' });
  assert.deepEqual(result, { provider: 'codex', output: 'echo:Summarize: one two three' });
  assert.deepEqual(ctx.bridge.calls.at(-1).body, { provider: 'codex', message: 'Summarize: one two three', history: [] });
  await rejectsWithCode(ctx.client.generate({ provider: 'codex', input: '' }), 'invalid_request');
});

test('chat() sends only the contract fields with a bearer header and returns the reply', async () => {
  const ctx = setup();
  await pairAndComplete(ctx);
  const result = await ctx.client.chat({
    provider: 'claude',
    message: 'hello',
    history: [
      { role: 'user', content: 'earlier question', cwd: '/etc' },
      { role: 'assistant', content: 'earlier answer' },
    ],
    // None of these may ever reach the bridge.
    cwd: '/tmp',
    executable: '/bin/sh',
    args: ['--dangerous'],
    env: { SECRET: '1' },
  });
  assert.deepEqual(result, { provider: 'claude', reply: 'echo:hello' });

  const call = ctx.bridge.calls.at(-1);
  assert.equal(call.url, 'http://127.0.0.1:43189/v1/chat');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.redirect, 'error');
  assert.ok(!call.url.includes(TOKEN));
  assert.deepEqual(call.body, {
    provider: 'claude',
    message: 'hello',
    history: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ],
  });

  await ctx.client.chat({ provider: 'codex', message: 'no history' });
  assert.deepEqual(ctx.bridge.calls.at(-1).body, { provider: 'codex', message: 'no history', history: [] });
});

test('chat() validates provider, message and history before any request is made', async () => {
  const ctx = setup();
  await pairAndComplete(ctx);
  const chat = (input) => ctx.client.chat(input);

  for (const provider of ['gpt', 'CLAUDE', '../../bin/sh', '', undefined, 7]) {
    await rejectsWithCode(chat({ provider, message: 'hi' }), 'unsupported_provider');
  }
  for (const message of ['', '   ', undefined, 42, ['hi']]) {
    await rejectsWithCode(chat({ provider: 'codex', message }), 'invalid_request');
  }
  const badHistories = [
    'earlier',
    [{ role: 'system', content: 'x' }],
    [{ role: 'user', content: 5 }],
    [{ role: 'user' }],
    ['user: hi'],
    [null],
  ];
  for (const history of badHistories) {
    await rejectsWithCode(chat({ provider: 'codex', message: 'hi', history }), 'invalid_request');
  }
  await rejectsWithCode(chat({ provider: 'codex', message: 'hi', signal: {} }), 'invalid_request');
  await rejectsWithCode(chat(undefined), 'invalid_request');
  assert.equal(ctx.bridge.calls.length, 0);
});

test('chat() refuses to run without a paired session', async () => {
  const ctx = setup();
  await rejectsWithCode(ctx.client.chat({ provider: 'codex', message: 'hi' }), 'not_paired');
  assert.equal(ctx.bridge.calls.length, 0);
});

test('chat() rejects oversized requests locally and surfaces the bridge size limit', async () => {
  const ctx = setup();
  await pairAndComplete(ctx);
  await rejectsWithCode(ctx.client.chat({ provider: 'codex', message: 'x'.repeat(1024 * 1024) }), 'request_too_large');
  await rejectsWithCode(
    ctx.client.chat({
      provider: 'codex',
      message: 'hi',
      history: Array.from({ length: 64 }, () => ({ role: 'user', content: 'y'.repeat(32 * 1024) })),
    }),
    'request_too_large',
  );
  assert.equal(ctx.bridge.calls.length, 0);

  const limited = setup({
    handler: bridgeHandler({
      chat: () => json({ error: { code: 'payload_too_large', message: 'Request body too large.' } }, 413),
    }),
  });
  await pairAndComplete(limited);
  await rejectsWithCode(limited.client.chat({ provider: 'codex', message: 'hi' }), 'payload_too_large', (error) => {
    assert.equal(error.status, 413);
    assert.equal(error.message, 'Request body too large.');
  });
});

test('chat() fails closed when the provider is unavailable and keeps the session', async () => {
  const ctx = setup({
    handler: bridgeHandler({
      chat: () => json({ error: { code: 'provider_unavailable', message: 'claude is not available.' } }, 503),
    }),
  });
  await pairAndComplete(ctx);
  await rejectsWithCode(ctx.client.chat({ provider: 'claude', message: 'hi' }), 'provider_unavailable', (error) => {
    assert.equal(error.status, 503);
  });
  assert.deepEqual(ctx.browser.sessionStorage.values(), [TOKEN]);
});

test('chat() with an expired token ends the session and never echoes the token', async () => {
  const tokens = new Set([TOKEN]);
  const handler = (call) => {
    if (call.path === '/v1/chat' && !tokens.has(TOKEN)) {
      // A badly behaved bridge that echoes the credential back in both fields.
      return json({ error: { code: TOKEN, message: `Token ${TOKEN} has expired (${TOKEN}).` } }, 401);
    }
    return bridgeHandler({ tokens })(call);
  };
  const ctx = setup({ handler });
  await pairAndComplete(ctx);
  tokens.delete(TOKEN);

  await rejectsWithCode(ctx.client.chat({ provider: 'codex', message: 'hi' }), 'bridge_error', (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Token [redacted] has expired ([redacted]).');
  });
  assert.equal(ctx.browser.sessionStorage.size, 0);

  const before = ctx.bridge.calls.length;
  await rejectsWithCode(ctx.client.chat({ provider: 'codex', message: 'hi' }), 'not_paired');
  assert.equal(ctx.bridge.calls.length, before);
});

test('chat() rejects malformed bridge replies and non-envelope errors', async () => {
  const bad = [
    () => json({ provider: 'claude', reply: 'answered by someone else' }),
    () => json({ provider: 'codex' }),
    () => json({ provider: 'codex', reply: { text: 'x' } }),
    () => new Response('ok', { status: 200 }),
  ];
  for (const chat of bad) {
    const ctx = setup({ handler: bridgeHandler({ chat }) });
    await pairAndComplete(ctx);
    await rejectsWithCode(ctx.client.chat({ provider: 'codex', message: 'hi' }), 'invalid_response');
  }

  const ctx = setup({ handler: bridgeHandler({ chat: () => new Response('<h1>Bad gateway</h1>', { status: 502 }) }) });
  await pairAndComplete(ctx);
  await rejectsWithCode(ctx.client.chat({ provider: 'codex', message: 'hi' }), 'bridge_error', (error) => {
    assert.equal(error.status, 502);
  });
});

test('chat() can be cancelled with an AbortSignal and the session survives', async () => {
  const ctx = setup({ handler: bridgeHandler({ chat: (call) => hang(call.init.signal) }) });
  await pairAndComplete(ctx);

  const controller = new AbortController();
  const outcome = rejectsWithCode(
    ctx.client.chat({ provider: 'codex', message: 'slow', signal: controller.signal }),
    'aborted',
  );
  assert.equal(ctx.bridge.calls.length, 1);
  controller.abort();
  await outcome;
  assert.equal(ctx.bridge.calls[0].init.signal.aborted, true, 'the underlying request was cancelled');
  assert.deepEqual(ctx.browser.sessionStorage.values(), [TOKEN]);

  await rejectsWithCode(
    ctx.client.chat({ provider: 'codex', message: 'never sent', signal: AbortSignal.abort() }),
    'aborted',
  );
  assert.equal(ctx.bridge.calls.length, 1);
});

// ---------------------------------------------------------------- disconnect()

test('disconnect() revokes this session on the bridge and forgets the token', async () => {
  const tokens = new Set([TOKEN]);
  const ctx = setup({ handler: bridgeHandler({ tokens }) });
  await pairAndComplete(ctx);

  assert.deepEqual(await ctx.client.disconnect(), { disconnected: true });
  const call = ctx.bridge.calls.at(-1);
  assert.equal(call.url, 'http://127.0.0.1:43189/v1/disconnect');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(tokens.has(TOKEN), false);
  assert.equal(ctx.browser.sessionStorage.size, 0);

  // Already disconnected: nothing to revoke, nothing sent.
  const before = ctx.bridge.calls.length;
  assert.deepEqual(await ctx.client.disconnect(), { disconnected: true });
  assert.equal(ctx.bridge.calls.length, before);
  await rejectsWithCode(ctx.client.chat({ provider: 'codex', message: 'hi' }), 'not_paired');
});

test('disconnect() cancels in-flight chats and never delivers a late reply', async () => {
  const hanging = setup({ handler: bridgeHandler({ chat: (call) => hang(call.init.signal) }) });
  await pairAndComplete(hanging);
  const cancelled = rejectsWithCode(hanging.client.chat({ provider: 'codex', message: 'slow' }), 'disconnected');
  assert.deepEqual(await hanging.client.disconnect(), { disconnected: true });
  await cancelled;
  assert.equal(hanging.bridge.calls[0].init.signal.aborted, true);

  // A bridge that ignores the abort and answers anyway.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const late = setup({
    handler: bridgeHandler({
      chat: async () => {
        await gate;
        return json({ provider: 'codex', reply: 'late reply' });
      },
    }),
  });
  await pairAndComplete(late);
  const dropped = rejectsWithCode(late.client.chat({ provider: 'codex', message: 'slow' }), 'disconnected');
  await late.client.disconnect();
  release();
  await dropped;
});

test('disconnect() clears the local session even when the bridge cannot confirm revocation', async () => {
  const handler = (call) => {
    if (call.path === '/v1/disconnect') throw new TypeError('fetch failed');
    return bridgeHandler()(call);
  };
  const ctx = setup({ handler });
  await pairAndComplete(ctx);
  await rejectsWithCode(ctx.client.disconnect(), 'bridge_unreachable');
  assert.equal(ctx.browser.sessionStorage.size, 0);

  const alreadyRevoked = setup({ handler: bridgeHandler({ tokens: new Set() }) });
  await pairAndComplete(alreadyRevoked);
  assert.deepEqual(await alreadyRevoked.client.disconnect(), { disconnected: true });
  assert.equal(alreadyRevoked.browser.sessionStorage.size, 0);
});

// ---------------------------------------------------------------- isolation and exposure

test('sessions are isolated per tab, per origin and per bridge', async () => {
  const tabA = setup();
  await pairAndComplete(tabA);

  // Another tab of the same site has its own sessionStorage: no session, nothing sent.
  const tabB = setup();
  await rejectsWithCode(tabB.client.chat({ provider: 'codex', message: 'hi' }), 'not_paired');
  assert.equal((await tabB.client.status()).connected, false);
  assert.equal('Authorization' in tabB.bridge.calls[0].headers, false);

  // Another origin cannot adopt tab A's callback: it never issued that nonce.
  const other = setup({ href: 'https://other.example/' });
  await tabA.client.pair();
  const nonce = new URL(tabA.browser.navigations.at(-1)).searchParams.get('nonce');
  other.browser.arrive(`https://other.example/#localhostagent_token=${TOKEN}&localhostagent_nonce=${nonce}`);
  await rejectsWithCode(other.client.completePairing(), 'pairing_not_pending');
  assert.equal(other.browser.sessionStorage.size, 0);
  assert.equal(other.browser.href, 'https://other.example/');

  // Even inside one tab, a token issued by one bridge is never sent to another bridge port.
  const otherBridge = createBridge(bridgeHandler());
  const otherPort = createClient({
    bridgeUrl: 'http://127.0.0.1:50123',
    fetch: otherBridge.fetch,
    location: tabA.browser.location,
    history: tabA.browser.history,
    sessionStorage: tabA.browser.sessionStorage,
    crypto: globalThis.crypto,
  });
  await rejectsWithCode(otherPort.chat({ provider: 'codex', message: 'hi' }), 'not_paired');
  await otherPort.status();
  assert.equal(otherBridge.calls.length, 1);
  assert.equal('Authorization' in otherBridge.calls[0].headers, false);
});

test('disconnect() in one session neither cancels nor revokes another session', async () => {
  const tokens = new Set([TOKEN, TOKEN_B]);
  const handler = () => bridgeHandler({ tokens, chat: (call) => hang(call.init.signal) });
  const tabA = setup({ handler: handler() });
  const tabB = setup({ handler: handler() });
  await pairAndComplete(tabA, { token: TOKEN });
  await pairAndComplete(tabB, { token: TOKEN_B });

  const chatA = rejectsWithCode(tabA.client.chat({ provider: 'codex', message: 'a' }), 'disconnected');
  const controllerB = new AbortController();
  let settledB = false;
  const chatB = tabB.client
    .chat({ provider: 'codex', message: 'b', signal: controllerB.signal })
    .finally(() => {
      settledB = true;
    });
  const outcomeB = rejectsWithCode(chatB, 'aborted');

  await tabA.client.disconnect();
  await chatA;
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(settledB, false, "tab B's chat is still running");
  assert.equal(tabB.bridge.calls.at(-1).init.signal.aborted, false);
  assert.deepEqual(tabB.browser.sessionStorage.values(), [TOKEN_B]);
  assert.deepEqual([...tokens], [TOKEN_B], 'only the disconnecting session was revoked');

  controllerB.abort();
  await outcomeB;
});

test('the token is not reachable from the client object, request URLs or the console', async (t) => {
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  for (const method of methods) t.mock.method(console, method, () => {});

  const tokens = new Set([TOKEN]);
  const ctx = setup({ href: `${PAGE}#section-2`, handler: bridgeHandler({ tokens }) });
  await pairAndComplete(ctx);

  assert.ok(Object.isFrozen(ctx.client));
  assert.deepEqual(Object.keys(ctx.client).sort(), ['chat', 'completePairing', 'disconnect', 'generate', 'pair', 'status']);
  for (const value of Object.values(ctx.client)) assert.equal(typeof value, 'function');
  assert.ok(!JSON.stringify(ctx.client).includes(TOKEN));

  await ctx.client.status();
  await ctx.client.chat({ provider: 'codex', message: 'hi' });
  tokens.delete(TOKEN);
  await rejectsWithCode(ctx.client.chat({ provider: 'codex', message: 'hi' }), 'unauthorized');
  await ctx.client.disconnect();

  for (const call of ctx.bridge.calls) {
    assert.ok(!call.url.includes(TOKEN), 'tokens travel in the Authorization header only');
    assert.ok(!(call.init.body ?? '').includes(TOKEN));
  }
  for (const navigation of ctx.browser.navigations) assert.ok(!navigation.includes(TOKEN));
  assert.ok(!ctx.browser.href.includes(TOKEN));
  for (const method of methods) {
    assert.equal(console[method].mock.callCount(), 0, `console.${method} was called`);
  }
});
