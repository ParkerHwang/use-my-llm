# Claude auth and local context verification

Recorded on 2026-11-12 for PR #7 (`feat/local-context-sharing`). This records evidence, not a claim that every real-account scenario succeeded.

## Disconnect fix and successful real continuation

Follow-up on 2026-11-12. Parker retained the explicit opt-in subscription mode. PR #7 remains open for review.

- Disconnect now runs official logout before clearing the saved mode. A failed logout returns a nonzero exit, preserves the mode, and explicitly says the login may still be active with a retry command. The native failure alert gives the same state and retry guidance.
- Added mock CLI regression tests for a failed logout preserving the saved file and synthetic login, a successful retry removing that login before disabling Claude, and an unavailable CLI preserving the saved mode.
- The opt-in real continuation test now goes through the bridge provider registry, checks original hashes during cleanup even after failure, and uses a fixed success diagnostic with an exact marker assertion. Cleanup revokes the grant before removing the temporary store.

### Real account verification on this Mac

Official Claude Code 2.1.321 signed in through `node packages/bridge/dist/cli.mjs claude-auth connect`, which invokes `claude auth login --claudeai` in `~/.use-my-llm/claude-subscription`. The official browser authorization completed. The check used no cookie scraping, direct Keychain access, token extraction, or alternate credential injection.

```sh
USE_MY_LLM_REAL_CLI=1 USE_MY_LLM_REAL_CLAUDE_LOGIN=1 \
  node --test --test-name-pattern='real Claude subscription' \
  packages/bridge/test/real-cli.test.mjs
```

The live run also set `LOCALHOSTAGENT_CLAUDE_PATH` to a private temporary observation wrapper. It forwarded arguments, environment, stdin and output to the installed official binary, recording generation output privately so a failure could be diagnosed without a second provider request. It supplied no credentials or model output. The recorded invocation included `--safe-mode`, `--resume`, and `--fork-session`.

The request ran at **2026-11-11 23:39:12–23:39:15 UTC**, or **2026-11-12 08:39:12–08:39:15 KST**. One real local Claude Code session was discovered, approved for `https://alpha.example`, frozen as a redacted bridge-owned copy, resolved from its grant, and continued through `createProviderRegistry().runProvider()`. The provider exited 0 and returned exactly `CLAUDE_COPY_OK`. The focused test passed, including grant revocation. There was no 429 in this run.

The final test-only logging and cleanup changes followed that successful live request. The privately recorded successful envelope also passed the final exact-marker assertion. Provider, registry, auth and continuation behavior were unchanged by those test-only edits.

Before sign-in and after official disconnect, a private SHA-256 manifest covered every regular file under `~/.claude` plus `~/.claude.json`. Both manifests contained **33 files**, with **zero added, removed or changed entries**. Both manifest hashes were `e93a887cf8f98143e0c47bf1eebd104d8179010aeafb025669a4991a0bf33d9b`. The direct `~/.claude.json` hash before and after was `6d538bcbb5d115fdd39cd70d5dfa78197aefbadd60f448f4fc7c6ff13ecfa525`. The focused test's independent whole-tree digest was also unchanged, `b5eb5c71af474b5b404c1ba96a82565bda4bed53200c64866078da453683d081`.

Official disconnect succeeded at the end. Bridge status reported `mode=null`, `connected=false`; a separate official subscription readiness probe also returned false. Tokens and original transcript contents were excluded from the verification report.

### Local checks and remaining coverage

| Check | Follow-up result |
| --- | --- |
| `npm ci` | Passed, zero reported vulnerabilities. |
| `npm test` | Passed, 168 tests passed, six opt-in real checks skipped, zero failures. |
| Bridge and browser `npx tsc --noEmit -p .../tsconfig.json` | Both passed. |
| `swiftc -typecheck -parse-as-library .../Launcher.swift .../ContextPicker.swift` | Passed. |
| `python3 packages/desktop-macos/build.py --output dist/disconnect-verification` | Passed, current bridge and Swift sources packaged and ad-hoc signed. |
| Native menu Connect/Disconnect | **Not exercised end to end.** The preview launched and started its bridge, but computer automation timed out accessing the windowless menu app and SystemUIServer. Official connect/disconnect were exercised through the CLI. The task-created installed preview was quit and removed. |
| CI | Final branch-head results are available in the checks on [PR #7](https://github.com/ParkerHwang/use-my-llm/pull/7). |

Mock verification covers logout failure/retry, missing CLI, credential environment separation, concurrent continuation and the existing context/protocol regressions. Real verification covers official subscription login, successful continuation of a real local session copy, preservation of originals across the entire login/continuation/logout cycle, grant revocation, and final official signed-out state. Real logout failure was simulated by the regression tests. The native failure alert was typechecked and packaged, with interactive behavior still unverified.

## Earlier verification at `3bed49d`

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

At `3bed49d`, a successful reply while continuing a real Claude Code session was unverified because of the real account's 429 plan limit. The follow-up above records the subsequent successful real continuation. The native menu and Terminal handoff were compiled and statically reviewed; that exact native interaction remains unverified end to end. Live Desktop cloud history is not exposed; local supported files and official export imports are the supported sources. Managed administrator policy remains a documented CLI restriction boundary.

## Files touched

- Auth, provider and protocol: `packages/bridge/src/claude-auth.mts`, `src/cli.mts`, `src/providers/claude.mts`, `src/providers/index.mts`, `src/server.mts`; `packages/browser/src/index.ts`.
- Context readers: `packages/bridge/src/context/sources/{claude-code,claude-desktop,util}.mts`.
- Tests: `packages/bridge/test/{claude-auth,claude-context-work,claude,context-providers,real-cli,server}.test.mjs`; `packages/browser/test/client.test.mjs`.
- Native app: `packages/desktop-macos/src/{Launcher,ContextPicker}.swift`, `packages/desktop-macos/build.py`.
- Documentation: root `README.md`, `SECURITY.md`, `docs/PROTOCOL.md`, this report, and README files under `packages/{bridge,browser,desktop-macos}`.
