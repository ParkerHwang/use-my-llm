# LocalHostAgent SDK

**v0.1.0 developer preview** — Add AI features such as summarization, drafting, rewriting, or text analysis to your own website through a local bridge running on the visitor's computer.

Instead of building a stand-alone chat app or collecting provider API keys on your server, your website asks the visitor to approve your exact web origin on a local pairing page. Once paired, the browser client sends text requests over `127.0.0.1` to the local bridge and returns plain-text output that your application renders in its own UI.

- **Built for website features, not a chat-app clone:** Each call is a fresh request/response operation (`generate()` or `chat()` with app-supplied history). It does not read or resume existing conversations in the visitor's desktop apps.
- **No provider credentials in the browser:** The bridge protocol does not send provider API keys, CLI tokens, executable paths, or local configuration to your website.
- **Local bridge, remote inference:** The bridge runs on `127.0.0.1`, while model inference runs on the configured provider's service.
- **Explicit per-website approval:** A webpage cannot silently install or launch a native program, and every exact website origin (`https://...`, `http://localhost:<port>`, or `http://127.0.0.1:<port>`) must be approved locally by the user.

---

## How it works

1. **The user runs the local bridge** — either from the command line (`localhost-agent`) or via the macOS Apple Silicon menu bar app.
2. **Your website checks status and requests pairing** — on a user click, your page calls `client.status()` and, if not yet connected, `client.pair()`.
3. **The user approves the exact origin** — `pair()` navigates the tab to the bridge's local approval screen (`http://127.0.0.1:43189/v1/pair...`). After clicking **Allow connection**, the user is redirected back to your page.
4. **Your page completes pairing and runs AI features** — `client.completePairing()` verifies a tab-scoped nonce, scrubs the URL fragment immediately, and stores a short-lived bearer token in `sessionStorage`. Your UI can then call `client.generate()` or `client.chat()`.

---

## Provider modes and verification status

Providers are configured locally on the visitor's machine. Websites can only request a provider ID (`codex`, `claude`, or `antigravity`); they cannot choose executables, CLI flags, models, or credentials.

| Provider ID | How it connects | Default state | Credentials & billing | Verification status |
| --- | --- | --- | --- | --- |
| `codex` | Locally installed official [Codex CLI](https://developers.openai.com/codex/quickstart) (`codex exec`) | Enabled when `codex` is found locally | Uses the user's local Codex CLI authentication (`codex login`), subject to their account limits and terms | Real website-to-Codex round trip tested end to end on one Mac |
| `claude` | Direct HTTPS requests from the local bridge to the Anthropic Messages API | Off (`--enable-claude-api` required) | Requires `ANTHROPIC_API_KEY` in the bridge environment; **does not** reuse Claude Desktop or Claude Code subscription login; may incur API charges | Tested with mocked/unit tests only; **not** live-tested with paid credentials |
| `antigravity` | Local Python worker using `google-antigravity==0.1.23` and the Gemini Developer API (POSIX only) | Off (`--enable-antigravity-api` required) | Requires `GEMINI_API_KEY` plus the Google Python SDK; **does not** reuse Antigravity desktop login; may incur API charges | Tested with mocked/unit tests only; **not** live-tested with paid credentials |

> **Note on provider availability:** When `status()` reports `available: true`, it means the bridge detected the required local binary or environment setup. It does not guarantee that the user's login, API key, quota, or billing is active.
>
> **Note on Antigravity ACP:** An exploratory ACP transport exists in the codebase for internal testing, but it is disabled and not exposed to websites because tool containment and consumer-account policy fit have not been established.

---

## Quick start: run the example from source

### Prerequisites

- **Node.js 22 or newer**
- **Codex CLI** installed and authenticated locally (`codex login`) if you want to run a live request with the default provider

### 1. Build and start the local bridge

```sh
git clone https://github.com/ParkerHwang/LocalHostAgentSDK.git
cd LocalHostAgentSDK
npm install
npm run build
node packages/bridge/dist/cli.mjs
```

When ready, the bridge prints:

```text
LOCALHOST_AGENT_READY http://127.0.0.1:43189
```

### 2. Start the example website

In a second terminal:

```sh
node examples/vanilla/server.mjs
```

Open `http://127.0.0.1:5173/` in a browser on the same computer:

1. Click **Connect AI** (running the first loopback check inside a click handler lets the browser display its local-network permission prompt if needed).
2. Approve `http://127.0.0.1:5173` on the local bridge page.
3. Paste text and click **Summarize**. Each summary is a standalone request and does not touch existing desktop conversations.

---

## Add the SDK to your website

### Installation

Packages are distributed as **[GitHub v0.1.0 release assets](https://github.com/ParkerHwang/LocalHostAgentSDK/releases/tag/v0.1.0)** and built from source. They are **not published on npm**.

- **From a local checkout:** after running `npm run build`, install the browser package into your web project:
  ```sh
  npm install /path/to/LocalHostAgentSDK/packages/browser
  ```
- **From GitHub Releases:** download the browser package archive from the [v0.1.0 release page](https://github.com/ParkerHwang/LocalHostAgentSDK/releases/tag/v0.1.0) and install it with `npm install ./localhost-agent-sdk-browser-0.1.0.tgz` (or serve the compiled ESM module directly, as shown in [`examples/vanilla`](examples/vanilla)).

### Browser usage

[`@localhost-agent-sdk/browser`](packages/browser) is a dependency-free ES module with TypeScript declarations.

```ts
import { createClient } from '@localhost-agent-sdk/browser';

const client = createClient();

// 1. Call on page load before application routing reads or mutates location.hash.
// If returning from the local approval page, this verifies the tab nonce,
// removes the #localhostagent_... fragment synchronously, and saves the token in sessionStorage.
await client.completePairing();

// 2. Trigger the first status() / pair() call from a user gesture so the browser
// can prompt for local loopback access if required.
connectButton.addEventListener('click', async () => {
  const state = await client.status();
  if (!state.connected) {
    await client.pair(); // Navigates this tab to the local approval page and returns here
    return;
  }
  console.log('Available providers:', state.providers);
});

// 3. Run a self-contained AI feature for your website.
summarizeButton.addEventListener('click', async () => {
  const { output } = await client.generate({
    provider: 'codex',
    input: `Summarize the following text clearly and concisely:\n\n${articleInput.value}`,
  });
  summaryOutput.textContent = output;
});

// 4. Optional: revoke the current tab's session when finished.
disconnectButton.addEventListener('click', async () => {
  await client.disconnect();
});
```

### Public client API

Full types and error codes are in [`packages/browser/src/index.ts`](packages/browser/src/index.ts) and [`docs/PROTOCOL.md`](docs/PROTOCOL.md):

- `createClient(options?)` — Creates a client bound to `http://127.0.0.1:43189` by default. Any `bridgeUrl` that is not `http://127.0.0.1:<port>` throws `invalid_bridge_url`.
- `client.completePairing()` — Validates and consumes the `#localhostagent_token=...&localhostagent_nonce=...` callback fragment on page load. Restores any pre-pairing URL fragment. Returns `{ paired: true }` or `{ paired: false, reason: 'no_callback' }`.
- `client.status()` — Queries `GET /v1/status`. Returns `{ service: 'localhost-agent-sdk', version: 1, connected: boolean, providers: [{ id, available }] }`.
- `client.pair({ returnUrl? })` — Navigates the current tab to the bridge's approval page for this exact origin. `returnUrl` defaults to `location.href` and must share the exact same origin.
- `client.generate({ provider, input, signal? })` — Sends a single self-contained text request with no prior history and returns `{ provider, output }`.
- `client.chat({ provider, message, history?, signal? })` — Sends a request/response turn with optional caller-managed `history` (`Array<{ role: 'user' | 'assistant', content: string }>`), returning `{ provider, reply }`. Does not stream.
- `client.disconnect()` — Aborts in-flight requests from this client, clears the tab's `sessionStorage` token, and calls `POST /v1/disconnect` on the bridge.

---

## Running the local bridge

### Option A: Node CLI (macOS, Linux, Windows)

After building the repository (`npm run build`), run `node packages/bridge/dist/cli.mjs` (or the `localhost-agent` bin from [`packages/bridge`](packages/bridge)):

```sh
node packages/bridge/dist/cli.mjs [--port 43189] [--allow-origin https://app.example.com ...] [--enable-claude-api] [--enable-antigravity-api]
```

- `--port PORT` — Loopback port between `1024` and `65535` (default `43189`). If changed, pass `bridgeUrl: 'http://127.0.0.1:<port>'` to `createClient()`.
- `--allow-origin ORIGIN` — Repeatable optional allowlist of exact origins. When set, the bridge refuses pairing and requests from any other origin even if a user navigates to the pairing URL.

### Option B: macOS menu bar app (Apple Silicon preview)

For macOS 13.5 or later on Apple Silicon (`arm64`), an optional menu bar app bundles Node.js and starts the bridge with default settings on `127.0.0.1:43189` (and registers the `localhostagent://start` URL scheme, which carries no site or provider parameters).

- **Download:** Get `LocalHostAgentSDK-macos-arm64.zip` from the [v0.1.0 release assets](https://github.com/ParkerHwang/LocalHostAgentSDK/releases/tag/v0.1.0) and see [`packages/desktop-macos/README.md`](packages/desktop-macos/README.md) for installation and local packaging instructions.
- **Verification note:** The release archive is Developer ID signed, notarized by Apple, and checked with Gatekeeper on the build Mac, but a downloaded first launch on a separate clean Mac has not yet been verified.

---

## Optional API-key provider modes

By default, only `codex` is enabled (when the Codex CLI is installed). `claude` and `antigravity` require explicit local opt-in flags and user-supplied API keys.

Keep API keys only in the local bridge process environment — never in website code, browser storage, URLs, or repositories.

### Claude (`--enable-claude-api`)

Calls Anthropic's official Messages API (`https://api.anthropic.com/v1/messages`) directly from the local bridge. It **does not** reuse Claude Desktop or Claude Code subscription logins, and usage may be billed by Anthropic.

```sh
export ANTHROPIC_API_KEY="your-api-key"
# Optional: override default model (claude-haiku-5-5)
export LOCALHOSTAGENT_CLAUDE_MODEL="claude-haiku-5-5"
# Optional: required by Anthropic if your API key is not scoped to a workspace
export LOCALHOSTAGENT_CLAUDE_WORKSPACE_ID="wrkspc_..."

node packages/bridge/dist/cli.mjs --enable-claude-api
```

### Antigravity (`--enable-antigravity-api`, POSIX only)

Runs an isolated Python worker using `google-antigravity==0.1.23` and a Gemini Developer API key. It **does not** reuse the Antigravity desktop app's login or existing conversations, and usage may be billed by Google. This mode is currently restricted to POSIX platforms (macOS/Linux) because process-group cancellation on Windows has not been verified.

```sh
python3 -m venv ~/.venvs/localhostagent-google
~/.venvs/localhostagent-google/bin/pip install "google-antigravity==0.1.23"

export GEMINI_API_KEY="your-gemini-api-key"
export LOCALHOSTAGENT_GOOGLE_PYTHON="$HOME/.venvs/localhostagent-google/bin/python3"

node packages/bridge/dist/cli.mjs --enable-antigravity-api
```

Neither the Claude API mode nor the Antigravity API mode has been tested against a live paid account in this repository.

---

## Security model and limitations

See [`SECURITY.md`](SECURITY.md) and [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for details.

- **Loopback-only listener and client:** The bridge binds exclusively to `127.0.0.1` and checks the `Host` header. The browser SDK refuses any non-loopback `bridgeUrl` and never follows HTTP redirects, preventing bearer tokens from being sent to remote hosts.
- **Origin-scoped, short-lived sessions:** Pairing rejects a present `Sec-Fetch-Dest` header unless it is `document` (requests without that header are accepted) and uses a one-time CSRF token on the local approval form. Tokens default to a 30-minute TTL, are stored in tab-scoped `sessionStorage`, and are checked against the exact `Origin` header on every request.
- **Constrained request surface:** Websites can submit only `{ provider, message, history }` within strict byte and turn limits. Websites cannot pass binary paths, working directories, environment variables, CLI flags, or model names.
- **Defense-in-depth tool restrictions, not a guaranteed sandbox:** The Codex and Antigravity adapters use temporary directories and pass flags/configs intended to disable tools, shell execution, file access, MCP servers, and inherited user configs (for example, `codex exec --sandbox read-only` with disabled tool features, and `CapabilitiesConfig(enabled_tools=[], enable_subagents=False)` with `deny("*")` for `google-antigravity`). However, these restrictions depend on the exact CLI or SDK version installed on the user's machine. This preview is **not** a general-purpose security sandbox and does not guarantee that a provider can never access local data.
- **Trust boundary:** Approved websites can submit prompts using the visitor's configured provider and receive the generated text. Users should approve only websites they trust, and should not run the bridge as an administrator or expose it beyond `127.0.0.1`.

---

## Development and testing

Build all workspaces and run the unit and integration test suite (requires Node.js 22+):

```sh
npm test
```

## License

MIT License — see [`LICENSE`](LICENSE). Provider CLIs, SDKs, accounts, and hosted model services are governed by their respective licenses, terms of service, and billing policies.
