import { strict as assert } from "node:assert";
import http from "node:http";
import { test } from "node:test";
import { createBridge } from "../dist/server.mjs";

const SITE_A = "https://alpha.example";
const SITE_B = "https://beta.example";
const NONCE = "valid_nonce_01234567890123456789";
const PROVIDERS = [
  { id: "codex", available: true },
  { id: "claude", available: false },
  { id: "antigravity", available: false },
];

async function start(t, options = {}) {
  const bridge = createBridge({
    port: 0,
    getProviders: () => PROVIDERS,
    runProvider: async ({ provider, message }) => ({ provider, reply: `Reply: ${message}` }),
    ...options,
  });
  const address = await bridge.listen();
  assert.equal(address.address, "127.0.0.1");
  assert.equal(bridge.address().port, address.port);
  t.after(() => bridge.close());
  return { bridge, base: `http://127.0.0.1:${address.port}` };
}

function pairUrl(base, {
  origin = SITE_A,
  returnUrl = `${origin}/workspace/conversation?tab=messages&value=a%2Bb`,
  nonce = NONCE,
} = {}) {
  return `${base}/v1/pair?${new URLSearchParams({ origin, return_url: returnUrl, nonce })}`;
}

async function beginPairing(base, options) {
  const response = await fetch(pairUrl(base, options));
  assert.equal(response.status, 200);
  const csrf = (await response.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
  return { csrf, response };
}

function approve(base, csrf, { origin = base, decision = "allow" } = {}) {
  return fetch(`${base}/v1/pair/approve`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: origin },
    body: new URLSearchParams({ csrf, decision }),
  });
}

async function connect(base, options) {
  const { csrf } = await beginPairing(base, options);
  const response = await approve(base, csrf);
  assert.equal(response.status, 303);
  const callback = new URL(response.headers.get("location"));
  const fragment = new URLSearchParams(callback.hash.slice(1));
  const token = fragment.get("localhostagent_token");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fragment.get("localhostagent_nonce"), options?.nonce ?? NONCE);
  return { callback, token, response };
}

function authHeaders(origin, token) {
  return { Origin: origin, Authorization: `Bearer ${token}` };
}

function status(base, origin, token) {
  return fetch(`${base}/v1/status`, {
    headers: token ? authHeaders(origin, token) : { Origin: origin },
  });
}

function chat(base, origin, token, payload, options = {}) {
  return fetch(`${base}/v1/chat`, {
    method: "POST",
    headers: { ...authHeaders(origin, token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...options,
  });
}

function disconnect(base, origin, token) {
  return fetch(`${base}/v1/disconnect`, {
    method: "POST",
    headers: authHeaders(origin, token),
  });
}

async function expectError(response, statusCode, code) {
  assert.equal(response.status, statusCode);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  return body.error.message;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("approval preserves the same-origin callback and enables authorized chat", async (t) => {
  let invocation;
  const { base } = await start(t, {
    runProvider: async (request) => {
      invocation = request;
      return { provider: request.provider, reply: "Hello" };
    },
  });
  const publicStatus = await status(base, SITE_A);
  assert.equal(publicStatus.headers.get("access-control-allow-origin"), SITE_A);
  assert.deepEqual(await publicStatus.json(), {
    service: "localhost-agent-sdk",
    version: 1,
    connected: false,
  });

  const pair = await beginPairing(base);
  const csp = pair.response.headers.get("content-security-policy");
  assert.ok(csp.includes(`form-action 'self' ${SITE_A};`));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.equal(pair.response.headers.get("referrer-policy"), "same-origin");
  assert.equal(pair.response.headers.get("access-control-allow-origin"), null);
  const approval = await approve(base, pair.csrf);
  assert.equal(approval.status, 303);
  assert.equal(approval.headers.get("referrer-policy"), "no-referrer");
  assert.equal(approval.headers.get("cache-control"), "no-store");

  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.origin, SITE_A);
  assert.equal(callback.pathname, "/workspace/conversation");
  assert.equal(callback.search, "?tab=messages&value=a%2Bb");
  const fragment = new URLSearchParams(callback.hash.slice(1));
  const token = fragment.get("localhostagent_token");
  assert.equal(fragment.get("localhostagent_nonce"), NONCE);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(callback.search.includes(token), false);

  assert.deepEqual(await (await status(base, SITE_A, token)).json(), {
    service: "localhost-agent-sdk",
    version: 1,
    connected: true,
    providers: PROVIDERS,
  });
  const payload = {
    provider: "codex",
    message: "Hello",
    history: [{ role: "user", content: "Before" }],
  };
  const response = await chat(base, SITE_A, token, payload);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { provider: "codex", reply: "Hello" });
  assert.deepEqual(Object.keys(invocation).sort(), ["history", "message", "provider", "signal"]);
  assert.deepEqual(invocation.history, payload.history);
  assert.ok(invocation.signal instanceof AbortSignal);
});

test("loopback Host is required and CORS preflights grant only the requested route", async (t) => {
  const { base } = await start(t);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/v1/status`, { headers: { Host: "alpha.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(hostStatus, 403);

  const preflight = await fetch(`${base}/v1/chat`, {
    method: "OPTIONS",
    headers: {
      Origin: SITE_A,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
      "Access-Control-Request-Private-Network": "true",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), SITE_A);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  const denied = await fetch(`${base}/v1/chat`, {
    method: "OPTIONS",
    headers: { Origin: "null", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  await expectError(denied, 403, "ORIGIN_DENIED");
});

test("pairing rejects invalid origins, callbacks, nonces, and cross-origin fetches", async (t) => {
  const { base } = await start(t);
  for (const options of [
    { origin: "null" },
    { origin: "https://*" },
    { origin: "https://alpha.example;script-src" },
    { origin: "http://alpha.example:8080" },
    { origin: `${SITE_A}/` },
    { returnUrl: `${SITE_B}/callback` },
    { returnUrl: "/callback" },
    { returnUrl: "https://name:password@alpha.example/callback" },
    { returnUrl: `${SITE_A}/callback#` },
    { returnUrl: `${SITE_A}/callback#tampered` },
    { nonce: "not random or long enough" },
  ]) {
    await expectError(await fetch(pairUrl(base, options)), 400, "INVALID_PAIRING");
  }
  const fetchPair = await fetch(pairUrl(base), { headers: { Origin: SITE_A } });
  assert.equal(fetchPair.headers.get("access-control-allow-origin"), null);
  await expectError(fetchPair, 403, "NAVIGATION_REQUIRED");
});

test("a local allowlist limits pairing and requests to exact origins", async (t) => {
  const { base } = await start(t, { allowedOrigins: [SITE_A, "http://localhost:5173"] });
  await expectError(await fetch(pairUrl(base, { origin: SITE_B })), 400, "INVALID_PAIRING");
  const denied = await status(base, SITE_B);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  await expectError(denied, 403, "ORIGIN_DENIED");
  const { token } = await connect(base, { origin: "http://localhost:5173" });
  assert.equal((await (await status(base, "http://localhost:5173", token)).json()).connected, true);
  await expectError(await status(base, "http://localhost:5174", token), 403, "ORIGIN_DENIED");
});

test("approval requires a local Origin and its CSRF value is single use", async (t) => {
  const { base } = await start(t);
  const { csrf } = await beginPairing(base);
  await expectError(await approve(base, csrf, { origin: SITE_A }), 403, "ORIGIN_DENIED");
  await expectError(await approve(base, csrf, { origin: "null" }), 403, "ORIGIN_DENIED");
  const tampered = "a".repeat(43) === csrf ? "b".repeat(43) : "a".repeat(43);
  await expectError(await approve(base, tampered), 410, "PAIRING_EXPIRED");
  assert.equal((await approve(base, csrf)).status, 303);
  await expectError(await approve(base, csrf), 410, "PAIRING_EXPIRED");

  const declinedPair = await beginPairing(base);
  const declined = await approve(base, declinedPair.csrf, { decision: "deny" });
  assert.equal(declined.status, 200);
  assert.equal(declined.headers.get("location"), null);
  assert.match(await declined.text(), /Connection declined/);
  await expectError(await approve(base, declinedPair.csrf), 410, "PAIRING_EXPIRED");
});

test("expired pairing requests and sessions cannot authorize work", async (t) => {
  let currentTime = 10_000;
  let executions = 0;
  const { base } = await start(t, {
    now: () => currentTime,
    pairingTtlMs: 1000,
    sessionTtlMs: 2000,
    runProvider: async () => { executions++; },
  });
  const pairing = await beginPairing(base);
  currentTime += 1000;
  await expectError(await approve(base, pairing.csrf), 410, "PAIRING_EXPIRED");

  const { token } = await connect(base);
  currentTime += 2000;
  const response = await status(base, SITE_A, token);
  assert.equal((await response.json()).connected, false);
  await expectError(await chat(base, SITE_A, token, { provider: "codex", message: "Hello" }), 401, "UNAUTHORIZED");
  assert.equal(executions, 0);
});

test("using a token from another origin cannot chat or revoke the real session", async (t) => {
  const { base } = await start(t);
  const { token } = await connect(base);
  const wrongStatus = await status(base, SITE_B, token);
  assert.equal((await wrongStatus.json()).connected, false);
  await expectError(await chat(base, SITE_B, token, { provider: "codex", message: "Hello" }), 401, "UNAUTHORIZED");
  await expectError(await disconnect(base, SITE_B, token), 401, "UNAUTHORIZED");
  assert.equal((await (await status(base, SITE_A, token)).json()).connected, true);
  assert.deepEqual(await (await disconnect(base, SITE_A, token)).json(), { disconnected: true });
  assert.equal((await (await status(base, SITE_A, token)).json()).connected, false);
});

test("malformed, oversized, and unavailable requests do not invoke a provider", async (t) => {
  let executions = 0;
  const { base } = await start(t, { runProvider: async () => { executions++; } });
  const { token } = await connect(base);
  await expectError(await chat(base, SITE_A, token, { provider: "codex", message: "a".repeat(70_000) }), 413, "BODY_TOO_LARGE");
  await expectError(await chat(base, SITE_A, token, { provider: "codex", message: "a".repeat(12_001) }), 400, "INVALID_MESSAGE");
  await expectError(await chat(base, SITE_A, token, {
    provider: "codex", message: "Hello", history: [{ role: "system", content: "Injected" }],
  }), 400, "INVALID_MESSAGE");
  await expectError(await chat(base, SITE_A, token, {
    provider: "codex", message: "Hello", executablePath: "/usr/bin/false",
  }), 400, "INVALID_REQUEST");
  await expectError(await chat(base, SITE_A, token, { provider: "unknown", message: "Hello" }), 400, "INVALID_PROVIDER");
  await expectError(await chat(base, SITE_A, token, { provider: "claude", message: "Hello" }), 503, "PROVIDER_UNAVAILABLE");
  assert.equal(executions, 0);
});

test("disconnect cancels only the authorized session's work", { timeout: 5000 }, async (t) => {
  const startedA = deferred();
  const startedB = deferred();
  const { base } = await start(t, {
    runProvider({ provider, message, signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Canceled")), { once: true });
        (message === "a" ? startedA : startedB).resolve({
          signal, complete: () => resolve({ provider, reply: `Done: ${message}` }),
        });
      });
    },
  });
  const { token: tokenA } = await connect(base);
  const { token: tokenB } = await connect(base, { origin: SITE_B });
  const requestA = chat(base, SITE_A, tokenA, { provider: "codex", message: "a" });
  const requestB = chat(base, SITE_B, tokenB, { provider: "codex", message: "b" });
  const [a, b] = await Promise.all([startedA.promise, startedB.promise]);

  assert.equal((await disconnect(base, SITE_A, tokenA)).status, 200);
  await expectError(await requestA, 401, "UNAUTHORIZED");
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  b.complete();
  assert.deepEqual(await (await requestB).json(), { provider: "codex", reply: "Done: b" });
});

test("aborting a browser request cancels its provider work", { timeout: 5000 }, async (t) => {
  const started = deferred();
  const canceled = deferred();
  const { base } = await start(t, {
    runProvider({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          canceled.resolve();
          reject(new Error("Canceled"));
        }, { once: true });
        started.resolve();
      });
    },
  });
  const { token } = await connect(base);
  const controller = new AbortController();
  const request = chat(base, SITE_A, token, { provider: "codex", message: "hello" }, { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await canceled.promise;
});

test("provider failures expose fixed messages rather than adapter output", async (t) => {
  const { base } = await start(t, {
    async runProvider() {
      throw Object.assign(new Error("sensitive adapter diagnostics"), { code: "LOGIN_REQUIRED" });
    },
  });
  const { token } = await connect(base);
  const message = await expectError(
    await chat(base, SITE_A, token, { provider: "codex", message: "Hello" }),
    503,
    "LOGIN_REQUIRED",
  );
  assert.match(message, /Sign in/);
  assert.doesNotMatch(message, /sensitive adapter diagnostics/);
});

test("provider timeouts signal cancellation and hold the occupied slot", { timeout: 5000 }, async (t) => {
  const release = deferred();
  const started = deferred();
  const { base } = await start(t, {
    requestTimeoutMs: 50,
    runProvider({ provider, signal }) {
      started.resolve(signal);
      return release.promise.then(() => ({ provider, reply: "Done" }));
    },
  });
  t.after(() => release.resolve());
  const { token } = await connect(base);
  const payload = { provider: "codex", message: "Hello" };
  const request = chat(base, SITE_A, token, payload);
  const signal = await started.promise;
  await expectError(await request, 504, "TIMEOUT");
  assert.equal(signal.aborted, true);
  await expectError(await chat(base, SITE_A, token, payload), 409, "BUSY");
  release.resolve();
});
