# @localhost-agent-sdk/bridge

A loopback-only bridge for LocalHostAgent SDK. It accepts website requests only after local approval of an exact origin, and uses the locally configured provider mode to generate text.

After installation, run `localhost-agent`. The default port is `127.0.0.1:43189`; `--port` and repeatable `--allow-origin` are local configuration options. The user must separately install and sign into the official Codex CLI. Optional `--enable-claude-api` and `--enable-antigravity-api` require separately configured API credentials and may incur charges; they do not reuse consumer desktop subscriptions. Run `localhost-agent --help` for options.

See the repository's [README](../../README.md), [security guidance](../../SECURITY.md), and [protocol](../../docs/PROTOCOL.md). This is a developer preview, not a general-purpose sandbox. MIT licensed; provider software and services have separate terms.
