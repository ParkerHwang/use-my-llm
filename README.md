# use-my-llm

**v0.1.0 developer preview** — Add AI features such as summarization, drafting, rewriting, or text analysis to your own website through a local bridge running on the visitor's computer.

Instead of building a stand-alone chat app or collecting provider API keys on your server, your website asks the visitor to approve your exact web origin on a local pairing page. Once paired, the browser client sends text requests over `127.0.0.1` to the local bridge and returns plain-text output that your application renders in its own UI.

- **Local context by choice:** A site can use selected conversation excerpts, memory, instruction files, or conversation copies when the visitor separately shares them through the local picker.
- **No provider credentials in the browser:** The bridge protocol does not send provider API keys, CLI tokens, executable paths, or local configuration to your website.
- **Local bridge, remote inference:** The bridge runs on `127.0.0.1`, while model inference runs on the configured provider's service.
- **Explicit per-website approval:** A webpage cannot silently install or launch a native program, and every exact website origin (`https://...`, `http://localhost:<port>`, or `http://127.0.0.1:<port>`) must be approved locally by the user.

---

## How it works

1. **The user runs the local bridge** — either from the command line (`use-my-llm`) or via the macOS Apple Silicon menu bar app.
2. **Your website checks status and requests pairing** — on a user click, your page calls `client.status()` and, if not yet connected, `client.pair()`.
3. **The user approves the exact origin** — `pair()` navigates the tab to the bridge's local approval screen (`http://127.0.0.1:43189/v1/pair...`). After clicking **Allow connection**, the user is redirected back to your page.
4. **Your page completes pairing and runs AI features** — `client.completePairing()` verifies a tab-scoped nonce, scrubs the URL fragment immediately, and stores a short-lived bearer token in `sessionStorage`. Your UI can then call `client.generate()` or `client.chat()`.

---

## Provider modes and verification status

Providers are configured locally on the visitor's machine. Websites can only request a provider ID (`codex`, `claude`, or `antigravity`); they cannot choose executables, CLI flags, models, or credentials.

| Provider ID | How it connects | Default state | Credentials & billing | Verification status |
| --- | --- | --- | --- | --- |
| `codex` | Locally installed official [Codex CLI](https://developers.openai.com/codex/quickstart) (`codex exec`) | Enabled when `codex` is found locally | Uses the user's local Codex CLI authentication (`codex login`), subject to their account limits and terms | Real website-to-Codex round trip tested end to end on one Mac |
| `claude` | Subscription: official Claude Code CLI. API key: Anthropic Messages API, plus Claude Code CLI for approved conversation copies | Off until a mode is selected locally | Subscription uses the official CLI OAuth sign-in in a bridge-owned config directory and counts against the user’s Claude plan limits. API-key mode uses `ANTHROPIC_API_KEY` and may incur API charges | See the verification commands below; a detected login alone does not prove a model request succeeded |
| `antigravity` | Local Python worker using `google-antigravity==0.1.23` and the Gemini Developer API (POSIX only) | Off (`--enable-antigravity-api` required) | Requires `GEMINI_API_KEY` plus the Google Python SDK; **does not** reuse Antigravity desktop login; may incur API charges | Tested with mocked/unit tests only; **not** live-tested with paid credentials |

> **Note on provider availability:** When `status()` reports `available: true`, it means the bridge detected the required local binary or environment setup. It does not guarantee that the user's login, API key, quota, or billing is active.
>
> **Antigravity ACP:** Experimental continuation is off by default. The optional local flag requires a compatible `agy acp` build. It starts a new session from the approved transcript and has tool and persistence limits. See [Security](SECURITY.md).

---

## Quick start: run the example from source

### Prerequisites

- **Node.js 22 or newer**
- **Codex CLI** installed and authenticated locally (`codex login`) if you want to run a live request with the default provider

### 1. Build and start the local bridge

```sh
git clone https://github.com/ParkerHwang/use-my-llm.git
cd use-my-llm
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

Packages are distributed as **[GitHub v0.1.0 release assets](https://github.com/ParkerHwang/use-my-llm/releases/tag/v0.1.0)** and built from source. They are **not published on npm**.

- **From a local checkout:** after running `npm run build`, install the browser package into your web project:
  ```sh
  npm install /path/to/use-my-llm/packages/browser
  ```
- **From GitHub Releases:** download the browser package archive from the [v0.1.0 release page](https://github.com/ParkerHwang/use-my-llm/releases/tag/v0.1.0) and install it with `npm install ./use-my-llm-browser-0.1.0.tgz` (or serve the compiled ESM module directly, as shown in [`examples/vanilla`](examples/vanilla)). The package installs as `@use-my-llm/browser`.

### Browser usage

[`@use-my-llm/browser`](packages/browser) is a dependency-free ES module with TypeScript declarations.

```ts
import { createClient } from '@use-my-llm/browser';

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
- `client.status()` — Queries `GET /v1/status`. Returns `{ service: 'localhost-agent-sdk', version: 1, connected: boolean, providers: [{ id, available, authMode? }] }`.
- `client.pair({ returnUrl? })` — Navigates the current tab to the bridge's approval page for this exact origin. `returnUrl` defaults to `location.href` and must share the exact same origin.
- `client.generate({ provider, input, context?, signal? })` — Sends a single self-contained text request with no prior history and returns `{ provider, output }`.
- `client.chat({ provider, message, history?, context?, continue?, signal? })` — Sends a request/response turn with optional caller-managed `history` (`Array<{ role: 'user' | 'assistant', content: string }>`), returning `{ provider, reply }`. Does not stream.
- `client.contexts()` — Lists the paired site's locally approved context handles.
- `client.disconnect()` — Aborts in-flight requests from this client, clears the tab's `sessionStorage` token, and calls `POST /v1/disconnect` on the bridge.

---

## Running the local bridge

### Option A: Node CLI (macOS, Linux, Windows)

After building the repository (`npm run build`), run `node packages/bridge/dist/cli.mjs` (or the `use-my-llm` bin from [`packages/bridge`](packages/bridge); `localhost-agent` starts the same bridge):

```sh
node packages/bridge/dist/cli.mjs [--port 43189] [--allow-origin https://app.example.com ...] [--enable-claude-api] [--enable-antigravity-api]
```

- `--port PORT` — Loopback port between `1024` and `65535` (default `43189`). If changed, pass `bridgeUrl: 'http://127.0.0.1:<port>'` to `createClient()`.
- `--allow-origin ORIGIN` — Repeatable optional allowlist of exact origins. When set, the bridge refuses pairing and requests from any other origin even if a user navigates to the pairing URL.

### Option B: macOS menu bar app (Apple Silicon preview)

For macOS 13.5 or later on Apple Silicon (`arm64`), an optional menu bar app bundles Node.js and starts the bridge with default settings on `127.0.0.1:43189` (and registers the `localhostagent://start` URL scheme, which carries no site or provider parameters).

- **Download:** Get `use-my-llm-macos-arm64.zip` from the [v0.1.0 release assets](https://github.com/ParkerHwang/use-my-llm/releases/tag/v0.1.0) and see [`packages/desktop-macos/README.md`](packages/desktop-macos/README.md) for installation and local packaging instructions. The app in that archive is **use-my-llm.app**.
- **Verification note:** The release archive is Developer ID signed, notarized by Apple, and checked with Gatekeeper on the build Mac, but a downloaded first launch on a separate clean Mac has not yet been verified.

---

## Share local context

On macOS, choose **Shared Context…** from the menu bar. In a terminal, run `use-my-llm context pick` (use `context sources --app antigravity --antigravity-acp` to list live ACP session metadata locally). Enter the website's exact origin, choose an item, and review the redacted text before approving. Use **Manage Sharing…** or `use-my-llm context revoke --origin https://app.example.com` to remove a site's access and delete its snapshots and local copies. Context can be selected before or after the site pairs.

| Source | Items you can select |
| --- | --- |
| Codex | Sessions, archived and Zstandard rollouts (Node.js 22.15+ for Zstandard), memory, and `AGENTS.md` |
| Claude Code | Sessions, auto memory, user/project `CLAUDE.md`, selected safe preferences, and selectable project metadata and referenced text files |
| Claude Desktop | Official export ZIP imported locally, or readable conversation and memory files from Claude Desktop in 3P mode |
| Antigravity | Local knowledge and brain transcripts or artifacts, where the installed version stores them as supported text formats |

After pairing, a website can call `client.contexts()` to get approved handles and pass them in `context` to `client.generate()` or `client.chat()`. A conversation-copy handle goes in `client.chat({ provider, message, continue: handle })`. See the [protocol](docs/PROTOCOL.md#shared-context-v11).

Codex continues from the approved transcript with the standard local CLI login. To use the CLI's native `exec fork` with the approved copy, sign into a separate, private Codex home using the official CLI and set `LOCALHOSTAGENT_CODEX_FORK_HOME` to that directory when starting the bridge. The bridge never stages a fork in your original Codex home. Claude Code continuation requires an official Claude Code executable and either the locally connected subscription or API-key mode. Subscription sign-in is separate from the user’s original Claude configuration; no existing credential is extracted or copied. The Desktop ZIP and 3P readers share text. They do not open a Desktop chat.

## Claude authentication modes

By default, only `codex` is enabled when installed. Select Claude’s mode locally; websites cannot select or switch it. Install the official [Claude Code CLI](https://code.claude.com/docs/en/overview) separately.

### Claude subscription

From the menu bar choose **Connect Claude Subscription…**, or run:

```sh
node packages/bridge/dist/cli.mjs claude-auth connect
node packages/bridge/dist/cli.mjs claude-auth status
node packages/bridge/dist/cli.mjs
```

`connect` starts the official CLI’s interactive `claude auth login` flow. Complete the browser sign-in with your Claude subscription. The bridge keeps this login in its own `CLAUDE_CONFIG_DIR` under its private data directory; it does not read cookies, extract Keychain credentials, or copy the login from your original Claude home. The official CLI manages its own credentials. Subscription requests count against your Claude plan’s usage limits and remain subject to Anthropic’s account terms.

Subscription inference runs without `--bare`. It uses an isolated working directory and fixed CLI restrictions to disable tools, MCP and inherited user/project configuration. Managed administrator policy may still apply; see [Security](SECURITY.md). Approved session continuation uses `--resume` and `--fork-session` with a redacted text-only copy. Each request starts from the approved snapshot; it does not modify or grant live access to the original session or project folder. Separately select memory, instructions and project files in **Shared Context…** to include those materials. Signing in alone shares nothing.

Use `claude-auth mode api-key` to switch to API-key mode, `claude-auth mode subscription` to switch back to an existing bridge login, or `claude-auth mode off` to disable Claude. `claude-auth disconnect` runs the official logout for the bridge’s subscription and disables Claude. Disconnecting does not revoke existing context grants; revoke those separately through **Manage Sharing…**. Existing v1 calls, Codex and Antigravity are unchanged.

### Claude API key

The explicit startup option `--claude-auth-mode subscription|api-key` overrides the saved mode. The existing `--enable-claude-api` startup flag remains supported and also overrides the saved mode; the explicit mode flag takes precedence if both are provided. Restart without startup overrides for menu-bar mode changes to control that process. Alternatively persist the mode with `use-my-llm claude-auth mode api-key`. API-key continuation uses `--bare` without `--safe-mode` and excludes subscription credentials from its child environment. Invalid keys fail instead of falling back to a subscription.

## Optional API-key provider modes

Antigravity remains a separate local opt-in with a user-supplied API key.

Keep API keys only in the local bridge process environment — never in website code, browser storage, URLs, or repositories.

### Claude (`--enable-claude-api`)

Calls Anthropic's official Messages API (`https://api.anthropic.com/v1/messages`) directly from the local bridge. In API-key mode it **does not** reuse Claude Desktop or Claude Code subscription logins, and usage may be billed by Anthropic.

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
python3 -m venv ~/.venvs/use-my-llm-google
~/.venvs/use-my-llm-google/bin/pip install "google-antigravity==0.1.23"

export GEMINI_API_KEY="your-gemini-api-key"
export LOCALHOSTAGENT_GOOGLE_PYTHON="$HOME/.venvs/use-my-llm-google/bin/python3"

node packages/bridge/dist/cli.mjs --enable-antigravity-api
```

The default test suite uses synthetic fixtures and mock credentials. Real-account verification is opt-in; a successful mock test does not establish subscription access, billing or quota availability.

---

## Security model and limitations

See [`SECURITY.md`](SECURITY.md) and [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for details.

- **Loopback-only listener and client:** The bridge binds exclusively to `127.0.0.1` and checks the `Host` header. The browser SDK refuses any non-loopback `bridgeUrl` and never follows HTTP redirects, preventing bearer tokens from being sent to remote hosts.
- **Origin-scoped, short-lived sessions:** Pairing rejects a present `Sec-Fetch-Dest` header unless it is `document` (requests without that header are accepted) and uses a one-time CSRF token on the local approval form. Tokens default to a 30-minute TTL, are stored in tab-scoped `sessionStorage`, and are checked against the exact `Origin` header on every request.
- **Constrained request surface:** Websites can submit only `{ provider, message, history?, context?, continue? }` within strict byte and turn limits. Websites cannot pass binary paths, working directories, environment variables, CLI flags, or model names.
- **Defense-in-depth tool restrictions, not a guaranteed sandbox:** The Codex and Antigravity adapters use temporary directories and pass flags/configs intended to disable tools, shell execution, file access, MCP servers, and inherited user configs (for example, `codex exec --sandbox read-only` with disabled tool features, and `CapabilitiesConfig(enabled_tools=[], enable_subagents=False)` with `deny("*")` for `google-antigravity`). However, these restrictions depend on the exact CLI or SDK version installed on the user's machine. This preview is **not** a general-purpose security sandbox and does not guarantee that a provider can never access local data.
- **Trust boundary:** Approved websites can submit prompts using the visitor's configured provider and receive the generated text. Users should approve only websites they trust, and should not run the bridge as an administrator or expose it beyond `127.0.0.1`.

---

## Development and testing

Build all workspaces and run the unit and integration test suite (requires Node.js 22+):

```sh
npm ci
npm test
npx tsc -p packages/bridge/tsconfig.json --noEmit
npx tsc -p packages/browser/tsconfig.json --noEmit
```

Opt-in real CLI tests are in `packages/bridge/test/real-cli.test.mjs`. They can reach provider servers and consume account allowance. Use the test file’s documented environment switches; report successful authenticated replies separately from fixture-based tests. Claude authentication requires a CLI build supporting the fixed restriction flags; unsupported builds fail closed. The official [CLI reference](https://code.claude.com/docs/en/cli-reference) describes the current flags.

## License

MIT License — see [`LICENSE`](LICENSE). Provider CLIs, SDKs, accounts, and hosted model services are governed by their respective licenses, terms of service, and billing policies.
