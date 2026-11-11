# LocalHostAgent SDK

Add AI features such as summarization, drafting, or analysis to a website through a bridge running on the visitor's own computer. The bridge asks the person to approve the website's exact origin; the browser SDK then sends text requests to the local bridge without receiving provider credentials. Your application owns its interface and decides how the resulting text is used.

**Developer preview.** The existing Codex Connect demo proved a local Codex round trip. This repository is a new implementation and must be evaluated independently. It currently implements request/response text chat; it does not resume conversations in the user's existing desktop app. A webpage cannot silently install or launch a native program: the user must install and start the bridge and approve the website.

## Provider modes

| Provider ID | Connection | Default | Important limitation |
| --- | --- | --- | --- |
| `codex` | Locally installed official Codex CLI and its own login | Enabled if found | CLI support, login and compatible safety flags must be verified on the user's machine. |
| `claude` | Direct official Anthropic Messages API from the local bridge | Off; explicit API opt-in | Requires the user's Anthropic API key; billed separately. Does **not** reuse Claude Desktop/Code subscription login. |
| `antigravity` | Google Antigravity Python SDK with Gemini Developer API | Off; explicit API opt-in | Requires a separate API key and SDK; does **not** reuse the Antigravity desktop login. API usage may be billed. |

The Antigravity ACP transport is exploratory and is not exposed to websites. The project does not intermediate Claude or Antigravity consumer subscription credentials. The API modes use provider-hosted models; the bridge runs locally, but inference is not necessarily on-device. Provider-specific integrations are subject to their current terms and account eligibility.

## Try the example from source

Requirements: Node.js 22 or newer, and an installed and authenticated [Codex CLI](https://developers.openai.com/codex/quickstart). The SDK and bridge are authored in TypeScript and compiled to JavaScript for use. No provider credentials are sent to the website.

```sh
git clone https://github.com/ParkerHwang/LocalHostAgentSDK.git
cd LocalHostAgentSDK
npm install
npm run build
node packages/bridge/dist/cli.mjs
```

In another terminal, start the small example website:

```sh
node examples/vanilla/server.mjs
```

Open `http://127.0.0.1:5173/` in a browser on the same computer, select **Connect AI**, and approve the exact origin on the local approval page. Paste text and select **Summarize** to exercise an AI feature in an ordinary web page. Each summary is a fresh request and does not use an existing desktop conversation.

The Mac menu bar app is an optional convenience for Apple Silicon macOS 13.5 or later; see [its build and installation instructions](packages/desktop-macos/README.md). A Node-based bridge can also be run from the command line on other platforms; platform and provider compatibility still require testing.

## Use the browser client

The TypeScript package source is in [`packages/browser`](packages/browser); its build generates JavaScript and TypeScript declarations. After building a local checkout, a bundler-based website can install it with `npm install /path/to/LocalHostAgentSDK/packages/browser`; it is not yet published to the npm registry. The example uses the compiled JavaScript module without a bundler.

```js
import { createClient } from '@localhost-agent-sdk/browser';

const client = createClient();
await client.completePairing(); // on page load, before other app code uses the URL

// In a user-click handler, check local access and start pairing if necessary:
connectButton.addEventListener('click', async () => {
  const state = await client.status(); // may ask for browser local-network access
  if (!state.connected) await client.pair(); // navigates away and returns to this page
});

// After pairing, use AI from your website's own feature:
summarizeButton.addEventListener('click', async () => {
  const { output } = await client.generate({
    provider: 'codex',
    input: `Summarize the following text:\n\n${articleInput.value}`,
  });
  summaryElement.textContent = output;
});
```

`pair()` navigates the current tab. `completePairing()` validates a tab-scoped nonce, removes the callback fragment and stores the short-lived session in `sessionStorage`. Start the first `status()` request from a user action so browsers can ask for loopback access. `generate()` runs a single self-contained operation; `chat()` is also available for an application that supplies its own history. The methods are documented in the [TypeScript source](packages/browser/src/index.ts) and generated declarations. The bridge supports multiple explicitly approved origins and an optional local `--allow-origin` allowlist. The exact wire contract is in [PROTOCOL.md](docs/PROTOCOL.md).

## Optional provider API modes

These are explicit local opt-ins. They do not use consumer subscription credentials from desktop apps. Keep API keys out of web pages, repositories, browser storage and shared logs. Set them securely in the environment of the local bridge process before starting it.

- **Claude:** configure `ANTHROPIC_API_KEY` locally, then start the bridge with `--enable-claude-api`. `LOCALHOSTAGENT_CLAUDE_MODEL` optionally selects a model locally. For an API key not scoped to a workspace, configure `LOCALHOSTAGENT_CLAUDE_WORKSPACE_ID` locally as required by Anthropic. This uses Anthropic's Messages API and may incur API charges. It does not use Claude Desktop or Claude Code login.
- **Antigravity:** in a dedicated Python 3.10+ virtual environment, install `google-antigravity==0.1.23`; configure `GEMINI_API_KEY` and set `LOCALHOSTAGENT_GOOGLE_PYTHON` to that environment's absolute Python path. Start the bridge with `--enable-antigravity-api`. The SDK runs locally with a new conversation and a Gemini API key; it does not use the installed desktop session. This path is limited to POSIX platforms while process-tree cancellation on Windows remains unverified.

Neither provider API path has been tested against a live paid account in this repository yet. A provider shown as available has the required local setup detected; it does not mean credentials, model access or billing have been verified.

## Safety and scope

The bridge binds only to `127.0.0.1`, validates the exact website origin, uses per-origin short-lived sessions and requires local user approval. Web requests cannot choose executables, command-line flags, local paths or provider credentials. Approved websites can submit prompts and receive responses, so approve only websites you trust. The provider configurations aim to disable tools and inherited customizations; this is a developer preview, and that behavior must be verified for each supported CLI/SDK version. It is not a general-purpose security sandbox or a guarantee that every provider can never access local data.

Run tests after installing Node.js:

```sh
npm test
```

The project is MIT licensed. Provider software, SDK dependencies, accounts and services remain subject to their respective licenses and terms.
