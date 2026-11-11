# Security

use-my-llm is a developer preview. The browser and bridge communicate on loopback; each website origin requires explicit local approval. A paired website can submit prompts and receive the resulting text, so users should approve only websites they trust.

The web API does not accept executable paths, shell commands, working directories, environment variables, provider credentials, or model configuration. The bridge bounds request sizes and session lifetimes, uses separate per-origin sessions, and attempts to stop provider work when a session is revoked or the bridge exits.

## Shared context

Sharing starts off for every origin. Use the menu-bar picker or the terminal picker to choose the exact website and review the selected content. Approval stores a read-only snapshot of the selected text with its SHA-256 digest. The bridge uses private directories and requests 0600 file permissions on POSIX. Known secret formats are redacted before saving, including common tokens, private key blocks and environment assignments. Review the redacted text since secret detection is best effort.

The bridge resolves opaque handles only for the origin that owns them. Original session IDs, paths and titles stay local. Text from an approved share can be sent to the selected provider and may be quoted in the reply. Choosing another provider sends the same material to that company. The local access log contains the timestamp, origin, provider, snapshot ID and byte count. It omits prompt text, content and handles.

Use **Shared Context → Manage Sharing** or `use-my-llm context revoke --origin ORIGIN` to remove a website's snapshots and local copies. Revocation cannot recall data already sent to a provider or website. Importing a Claude export creates a private local catalog before sharing, and revocation leaves that catalog available to the local user.

## Provider restrictions

Codex and Claude Code continuation use approved text only. Codex's optional native fork creates a temporary rollout under a separate Codex home. The CLI can write its usual bookkeeping there. Claude Code uses an isolated config directory and a locally supplied `ANTHROPIC_API_KEY`. Subscription authentication is excluded.

Provider tool restrictions depend on the installed CLI or SDK version. They are defense in depth. Run the bridge as your normal user and keep the listener on loopback.

Antigravity ACP continuation is disabled by default. The local `--unsafe-enable-antigravity-acp` flag is experimental and requires an `agy` build that supports ACP. It starts a new session with the approved, redacted transcript as quoted data. Live ACP session IDs are available only for local discovery. The bridge denies ACP permission requests and does not provide file or terminal services. It cannot disable or contain all of the agent's internal tools. A tool may act before the bridge sees an update and cancels. The new session may persist in Antigravity. Revoking the handle removes bridge data and stops future requests through that grant. Enable this mode only where your Antigravity account permits the integration and you accept these limits.

Do not include tokens, API keys, private prompts, or personal files in public issues. If the repository has GitHub private vulnerability reporting enabled, use it for sensitive reports; otherwise contact a maintainer privately before publishing exploit details.
