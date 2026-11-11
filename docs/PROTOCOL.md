# use-my-llm: browser-to-local bridge contract (v1.1)

This is the implementation contract for the initial developer preview. The bridge is a separately installed local process. It must never expose an arbitrary command runner, accept executable paths or configuration from a website, or expose provider credentials to a website. Existing conversations and memory may be used only through a separate local approval for selected context. Pairing alone grants no context access.

- Browser-facing base URL defaults to `http://127.0.0.1:43189`; only loopback IP `127.0.0.1` and a numeric valid port are accepted by the client. The bridge binds to loopback and validates Host.
- A website origin must be an exact `https://` origin (or `http://localhost:<port>` / `http://127.0.0.1:<port>` for local development). No wildcard origins, embedded credentials, or opaque/null origins.
- The user explicitly approves each website origin on a page served by the local bridge. Tokens are high-entropy, short-lived, scoped to exactly that origin and revocable. Browser sessions keep tokens in sessionStorage, not localStorage, URLs or logs. Never accept website-provided executable or working-directory paths.

## HTTP API

All error responses: `{ "error": { "code": "...", "message": "..." } }` and non-2xx status.

`GET /v1/status`: returns `{ "service": "localhost-agent-sdk", "version": 1, "connected": false }` without a valid bearer token. With a valid bearer for the exact Origin it returns `connected: true` and `providers: [{"id":"codex"|"claude"|"antigravity", "available": boolean}]`. The server may reflect a syntactically valid Origin for CORS preflight/status; authorization is always independently enforced on protected requests. No wildcards.

`GET /v1/pair?origin=<exact-origin>&return_url=<same-origin-absolute-url>&nonce=<random>`: top-level browser navigation, not fetch. The bridge validates origin, callback URL and nonce, shows a local approval page with exact origin and explicit Allow action. The callback must be HTTPS or loopback HTTP and have the exact origin provided, without embedded credentials or fragments. After local POST approval, 303 to the validated callback with fragment `#localhostagent_token=<token>&localhostagent_nonce=<nonce>`. A strict local Origin check and one-time CSRF value are required; apply Referrer-Policy `same-origin` to the local approval page, `no-referrer` to the redirect, and CSP `form-action` only self plus approved origin.

`POST /v1/chat`: protected exact Origin + `Authorization: Bearer <token>` + JSON `{ "provider": "codex"|"claude"|"antigravity", "message": "...", "history": [{"role":"user"|"assistant", "content":"..."}] }`. Returns `{ "provider": "...", "reply": "..." }`. Service applies explicit size limits and executes only locally configured official provider adapter. It must fail closed if a provider is unsupported/unavailable. Requests must never let a website select binary path, local files, process environment, CLI flags or working directory. Initial interface is request/response; no streaming claims.

`POST /v1/disconnect`: protected exact Origin + bearer; revokes only this session and cancels only its own work. Returns `{ "disconnected": true }`. Invalid requests from other origins must not revoke valid tokens.

## Shared context (v1.1)

A paired website discovers support through `protocol: "1.1"` and `context: true` on authenticated `GET /v1/status`. The existing `version: 1` and `/v1` routes remain compatible. A client can continue to use them without shared context.

- `GET /v1/context` requires the exact Origin and bearer token. It returns `{ "contexts": [...] }` for that origin. Entries include an opaque `handle`, source `app`, `kind`, `label`, `bytes`, and `createdAt`. Conversation copies also include their continuation `provider`. An origin starts with no shared items.
- `POST /v1/chat` accepts an optional `context` array of up to eight distinct text handles and a separate optional `continue` handle for a conversation copy. A copy must use its own provider and cannot be combined with website-supplied history. Each call starts one turn from the approved copy. The bridge accepts up to 400,000 bytes of approved context per turn. Unknown, revoked, disabled and other-origin handles all return `403 CONTEXT_DENIED`.
- Listing returns metadata only. A website can request inference over an approved item and receive output that quotes or reveals it. The consent UI says “The site can read whatever you share.” and “If you send it to a different provider, the content goes to that company.”
- The website cannot list local sources, select files, open the picker, import an export, approve a share, or revoke another origin's grants. Source paths, original session IDs and original thread titles are not returned as metadata. Text snapshots are resolved from the bridge's own copy. Adapters pass them as quoted prompt data with `{"context":[{"source":"codex:memory","text":"..."}]}`.
- Local approval writes a redacted snapshot with a content hash. Origin revocation invalidates its handles and removes its local snapshots and conversation copies. This does not recall prompts already sent or output already delivered. A separate local access log records timestamp, origin, provider, snapshot ID and byte count.
- Codex continues a frozen copy of approved text. With a separate configured Codex home it stages the copy for `codex exec fork --ephemeral`. Claude Code continues a redacted text-only session copy with API-key authentication. Experimental Antigravity ACP continuation starts a new session from approved transcript text. A status entry with `continuationAvailable: true` and `available: false` supports only continuation. See [Security](../SECURITY.md).

## Browser package

A dependency-free JavaScript ESM module and `.d.ts`, usable in a browser or bundled web app. `createClient(options?)` uses default loopback base above. Expose `pair({returnUrl?})`, `completePairing()`, `status()`, `generate({provider,input,signal?})`, `chat({provider,message,history?,signal?})`, and `disconnect()`. `generate` is a single self-contained text operation returning `{provider, output}` and sends no history; `chat` remains available when an application chooses to provide its own history. A pair request navigates away; after returning, `completePairing()` verifies a tab-scoped nonce, removes the fragment promptly before any async I/O, rejects mismatch, stores only the token in sessionStorage and reports success/failure. Preserve existing same-origin callback path/query and restore the pre-existing fragment from sessionStorage. Do not allow a website-supplied remote bridge URL that can receive a bearer token. Browser APIs and fetch should be injectable for meaningful isolated tests. Do not leak tokens in thrown errors, URL query strings, or console.

`contexts()` lists the current origin's approved metadata. Pass text handles in `generate({ provider, input, context? })` or `chat({ provider, message, context? })`. To continue a copy, call `chat({ provider, message, continue: handle })`.

## Verification and claims

Tests must cover valid pairing, tampered callback/origin/nonce, expired tokens, cross-origin token isolation, disconnect cancellation, oversized request rejection, and provider-unavailable behavior. Distinguish mocked tests, actual locally installed CLI calls, and browser end-to-end tests. Any AI tool sandbox restrictions and vendor account/terms limitations must be reported accurately; command/path access must not be exposed just because a model says it won't use a tool. Only claim actual providers and login modes that were tested and are permitted.
