# LocalHostAgent SDK for macOS

The menu bar app starts the LocalHostAgent SDK bridge on `127.0.0.1:43189`. It supports Apple Silicon and macOS 13.5 or later.

1. Unzip the app and open **LocalHostAgent SDK.app**. When possible, the first launch copies the app into your `~/Applications` folder and starts that copy.
2. Select the LocalHostAgent menu bar item to see whether the bridge is running. If it stopped, check whether another instance is using port `43189` and select **Start Bridge** to try again.
3. Return to the website you want to connect and use its pairing flow. The app can be started by `localhostagent://start`. The website still needs your approval on the local pairing page.

The app includes Node.js and the bridge. Install and sign in to any available provider CLI separately. The menu bar status reports the bridge listener. Provider availability is reported by the bridge after pairing. Quit the app from the menu bar to stop the bridge and revoke its in-memory sessions.

To update an existing app, quit it and replace your copy in Applications with the new version. First-launch installation preserves any copy already installed there.

## Build a local preview

On an Apple Silicon Mac, install Node.js 22 or later, Python 3.10 or later and the Xcode Command Line Tools. From the repository root, run:

```sh
npm ci
npm run build --workspace @localhost-agent-sdk/bridge
python3 packages/desktop-macos/build.py
```

Build the bridge before packaging; the app includes only the compiled runtime and Python worker, not TypeScript sources, development dependencies, source maps, or local configuration. The packaging step rejects missing runtime files, symbolic links in the bridge output, and runtime dependencies. The app includes the repository license and Node.js license.

The build creates `dist/desktop-macos/LocalHostAgent SDK.app` and `dist/desktop-macos/LocalHostAgentSDK-macos-arm64.zip`. To build again, choose a new directory with `--output`. The build downloads the Apple Silicon Node.js 24.22.2 archive and verifies it against the pinned release SHA-256. You can supply the same archive locally with `--node-archive`. The bundle includes Node.js's license. [Node.js release checksums](https://nodejs.org/en/blog/release/v24.22.2#shasums)

The generated ZIP is ad-hoc signed for local development. Developer ID signing, notarization, and a first-launch check on a downloaded copy are separate release steps.

## Integration

The executable starts the bundled `Contents/Resources/node` with `Contents/Resources/app/packages/bridge/dist/cli.mjs`. The app treats the child as ready only after it emits the exact line `LOCALHOST_AGENT_READY http://127.0.0.1:43189`. The `localhostagent://start` link carries no site or provider parameters. [Browser-to-bridge protocol](../../docs/PROTOCOL.md)

The bundle includes the Google SDK adapter's `dist/providers/google_sdk.py` worker. The menu bar app starts the bridge with its default configuration. To use the optional Antigravity API adapter, start the bridge from a terminal with `--enable-antigravity-api` and configure Python and Gemini authentication locally.
