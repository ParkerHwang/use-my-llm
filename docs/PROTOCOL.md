# use-my-llm: browser-to-local bridge contract (v1)

This is the implementation contract for the initial developer preview. The bridge is a separately installed local process. It must never expose an arbitrary command runner, accept executable paths or configuration from a website, read provider credentials into JavaScript, or claim to resume a desktop app's existing chats.

- Browser-facing base URL defaults to `http://127.0.0.1:43189`; only loopback IP `127.0.0.1` and a numeric valid port are accepted by the client. The bridge binds to loopback and validates Host.
- A website origin must be an exact `https://` origin (or `http://localhost:<port>` / `http://127.0.0.1:<port>` for local development). No wildcard origins, embedded credentials, or opaque/null origins.
- The user explicitly approves each website origin on a page served by the local bridge. Tokens are high-entropy, short-lived, scoped to exactly that origin and revocable. Browser sessions keep tokens in sessionStorage, not localStorage, URLs or logs. Never accept website-provided executable or working-directory paths.

## HTTP API

All error responses: `{ "error": { "code": "...", "message": "..." } }` and non-2xx status.

`GET /v1/status`: returns `{ "service": "localhost-agent-sdk", "version": 1, "connected": false }` without a valid bearer token. With a valid bearer for the exact Origin it returns `connected: true` and `providers: [{"id":"codex"|"claude"|"antigravity", "available": boolean}]`. The server may reflect a syntactically valid Origin for CORS preflight/status; authorization is always independently enforced on protected requests. No wildcards.

`GET /v1/pair?origin=<exact-origin>&return_url=<same-origin-absolute-url>&nonce=<random>`: top-level browser navigation, not fetch. The bridge validates origin, callback URL and nonce, shows a local approval page with exact origin and explicit Allow action. The callback must be HTTPS or loopback HTTP and have the exact origin provided, without embedded credentials or fragments. After local POST approval, 303 to the validated callback with fragment `#localhostagent_token=<token>&localhostagent_nonce=<nonce>`. A strict local Origin check and one-time CSRF value are required; apply Referrer-Policy `same-origin` to the local approval page, `no-referrer` to the redirect, and CSP `form-action` only self plus approved origin.

`POST /v1/chat`: protected exact Origin + `Authorization: Bearer <token>` + JSON `{ "provider": "codex"|"claude"|"antigravity", "message": "...", "history": [{"role":"user"|"assistant", "content":"..."}] }`. Returns `{ "provider": "...", "reply": "..." }`. Service applies explicit size limits and executes only locally configured official provider adapter. It must fail closed if a provider is unsupported/unavailable. Requests must never let a website select binary path, local files, process environment, CLI flags or working directory. Initial interface is request/response; no streaming claims.

`POST /v1/disconnect`: protected exact Origin + bearer; revokes only this session and cancels only its own work. Returns `{ "disconnected": true }`. Invalid requests from other origins must not revoke valid tokens.

## Browser package

A dependency-free JavaScript ESM module and `.d.ts`, usable in a browser or bundled web app. `createClient(options?)` uses default loopback base above. Expose `pair({returnUrl?})`, `completePairing()`, `status()`, `generate({provider,input,signal?})`, `chat({provider,message,history?,signal?})`, and `disconnect()`. `generate` is a single self-contained text operation returning `{provider, output}` and sends no history; `chat` remains available when an application chooses to provide its own history. A pair request navigates away; after returning, `completePairing()` verifies a tab-scoped nonce, removes the fragment promptly before any async I/O, rejects mismatch, stores only the token in sessionStorage and reports success/failure. Preserve existing same-origin callback path/query and restore the pre-existing fragment from sessionStorage. Do not allow a website-supplied remote bridge URL that can receive a bearer token. Browser APIs and fetch should be injectable for meaningful isolated tests. Do not leak tokens in thrown errors, URL query strings, or console.

## Verification and claims

Tests must cover valid pairing, tampered callback/origin/nonce, expired tokens, cross-origin token isolation, disconnect cancellation, oversized request rejection, and provider-unavailable behavior. Distinguish mocked tests, actual locally installed CLI calls, and browser end-to-end tests. Any AI tool sandbox restrictions and vendor account/terms limitations must be reported accurately; command/path access must not be exposed just because a model says it won't use a tool. Only claim actual providers and login modes that were tested and are permitted.
