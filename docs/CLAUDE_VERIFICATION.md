# Claude auth and local context verification

Recorded on 2026-11-12 for PR #7 (`feat/local-context-sharing`). This records evidence, not a claim that every real-account scenario succeeded.

## Implementation

- Local persisted `subscription` / `api-key` modes, plus off; startup overrides preserve `--enable-claude-api` compatibility.
- Official CLI `auth login --claudeai`, `auth status --json`, and `auth logout` in a stable bridge-owned config directory. No cookie scraping, direct Keychain access or token extraction.
- Subscription calls use `--safe-mode` without `--bare`. API continuation uses `--bare` without `--safe-mode`; ordinary API calls retain the direct Messages API route. There is no subscription fallback.
- Both protocol serializers expose only the coarse Claude `authMode`. Background readiness probing does not block unrelated providers.
- Existing approved session, memory, instructions and Desktop sources remain available. New selectable sources cover allowlisted preferences, project-folder names, and recent referenced local text artifacts. These use the existing preview, masking, site-bound frozen snapshots, revocation and access log.
- Native menu includes connect, disconnect, API-key selection, off and mode display. Subscription usage counts against the account's Claude plan limits.

## Commands and results

| Check | Result |
| --- | --- |
| `npm ci && npm test` | Passed initial integrated suite: 165 passed, six opt-in real checks skipped. |
| `npm test` after nonblocking readiness fix | Passed final suite: 166 passed, six skipped, zero failures (172 tests). |
| `npx tsc --noEmit -p packages/bridge/tsconfig.json` | Passed. |
| `npx tsc --noEmit -p packages/browser/tsconfig.json` | Passed. |
| `swiftc -typecheck -parse-as-library packages/desktop-macos/src/Launcher.swift packages/desktop-macos/src/ContextPicker.swift` | Passed. |
| `swiftc -parse-as-library packages/desktop-macos/src/Launcher.swift packages/desktop-macos/src/ContextPicker.swift -o /tmp/use-my-llm-launcher-check` | Passed linked native compilation. |
| `python3 packages/desktop-macos/build.py --output dist/claude-subscription-preview` | Passed; created ad-hoc signed app and ZIP. |
| Packaged Node + CLI `claude-auth status`, then bridge on isolated port 43279 | Passed; auth module loads, exact readiness line and HTTP status verified, process stopped. |
| `USE_MY_LLM_REAL_CLI=1 node --test --test-name-pattern='real Claude Code CLI' packages/bridge/test/real-cli.test.mjs` | Passed against installed official CLI 2.1.321. Exact production API flags loaded the copy, rejected the invalid API key, and left originals unchanged. |
| `node packages/bridge/dist/cli.mjs claude-auth connect` | Real official browser OAuth succeeded; status reported subscription connected. |
| `USE_MY_LLM_REAL_CLI=1 USE_MY_LLM_REAL_CLAUDE_LOGIN=1 node --test --test-name-pattern='real Claude subscription' packages/bridge/test/real-cli.test.mjs` | Failed with provider error. No successful model reply. |
| Exact subscription resume/fork diagnostic using a synthetic seed | Reached provider; `noConversationFound=false`, HTTP 429, `usage_limit_reached`. The account's five-hour allowance was exhausted. No repeated success attempts after diagnosis. |
| `node packages/bridge/dist/cli.mjs claude-auth disconnect` and subsequent status | Real official logout succeeded; bridge mode off and disconnected. Left signed out after verification. |
| Before/after original-file hashes | All 33 files under `~/.claude`, plus `~/.claude.json` in the manifest, unchanged; zero changed entries. Manifest SHA-256: `3edc611034f3bd1fb939aab9419ea290c97ff29558670229ca0f40f50590e466`. |
| `git diff --check` | Passed. |

The hash manifest held only local filenames and hashes in a private temporary file; no original content or account credentials were committed. CI results are attached to the pushed head of [PR #7](https://github.com/ParkerHwang/use-my-llm/pull/7).

## Evidence limits and follow-up

Real verified: official subscription login/logout, account authentication, exact API invalid-key rejection, synthetic copied-session loading through resume/fork, original-file preservation, packaged listener startup.

Mock/fixture verified: successful subscription generation and concurrent continuation, credential-environment separation, opaque-mode serialization, frozen context masking, cross-site denial, revoke/access-log behavior, project-file containment, safe preferences, Desktop 3P handling, and existing v1/Codex/Antigravity regression behavior. Independent code and security reviews reported no remaining implementation findings after the readiness fix.

A successful reply while continuing a real Claude Code session remains unverified because of the real account's 429 plan limit. After the allowance resets, connect again and rerun the focused subscription test above. The native menu and Terminal handoff were compiled and statically reviewed; that exact native interaction was not exercised end to end. Live Desktop cloud history is not exposed; local supported files and official export imports are the supported sources. Managed administrator policy remains a documented CLI restriction boundary.

## Files touched

- Auth, provider and protocol: `packages/bridge/src/claude-auth.mts`, `src/cli.mts`, `src/providers/claude.mts`, `src/providers/index.mts`, `src/server.mts`; `packages/browser/src/index.ts`.
- Context readers: `packages/bridge/src/context/sources/{claude-code,claude-desktop,util}.mts`.
- Tests: `packages/bridge/test/{claude-auth,claude-context-work,claude,context-providers,real-cli,server}.test.mjs`; `packages/browser/test/client.test.mjs`.
- Native app: `packages/desktop-macos/src/{Launcher,ContextPicker}.swift`, `packages/desktop-macos/build.py`.
- Documentation: root `README.md`, `SECURITY.md`, `docs/PROTOCOL.md`, this report, and README files under `packages/{bridge,browser,desktop-macos}`.
