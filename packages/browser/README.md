# @use-my-llm/browser

TypeScript-first, dependency-free browser client for use-my-llm. A local bridge must be running on the visitor's computer. The visitor approves the exact website origin before it can send requests. The website never receives provider credentials.

```ts
import { createClient } from '@use-my-llm/browser';

const client = createClient();
await client.completePairing(); // on page load
const state = await client.status();
// In response to a user click, call client.pair() if !state.connected.
const result = await client.generate({ provider: 'codex', input: 'Summarize: …' });
console.log(result.output);
```

`pair()` navigates this tab to a local approval screen and then returns to your page. `generate()` performs an independent text operation. `chat()` is available when an application supplies its own history. `disconnect()` revokes the tab's session. See the repository's [protocol](../../docs/PROTOCOL.md) and [example](../../examples/vanilla) for complete setup and error handling.

Consumer Claude and Antigravity desktop subscriptions are not reused by this preview. Optional official API-key modes have separate prerequisites and may incur provider charges. MIT licensed; provider services and dependencies have their own terms.
