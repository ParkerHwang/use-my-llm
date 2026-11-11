# Security

LocalHostAgent is a developer preview. The browser and bridge communicate on loopback; each website origin requires explicit local approval. A paired website can submit prompts and receive the resulting text, so users should approve only websites they trust.

The web API does not accept executable paths, shell commands, working directories, environment variables, provider credentials, or model configuration. The bridge bounds request sizes and session lifetimes, uses separate per-origin sessions, and attempts to stop provider work when a session is revoked or the bridge exits.

Provider tool restrictions depend on the installed CLI or SDK version. They are defense in depth, not a claim that all local resources are inaccessible. The experimental Antigravity ACP transport is not exposed to websites because its effective internal-tool restrictions and consumer-account policy fit have not been established. Do not run the bridge as an administrator or bind it to a public interface.

Do not include tokens, API keys, private prompts, or personal files in public issues. If the repository has GitHub private vulnerability reporting enabled, use it for sensitive reports; otherwise contact a maintainer privately before publishing exploit details.
