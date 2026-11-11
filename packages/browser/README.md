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

## Use context the visitor shared

After pairing, check `(await client.status()).context` for protocol v1.1 support. `contexts()` returns the current site's approved items as metadata and opaque handles. Let the visitor choose which item to use in your feature.

```ts
const status = await client.status();
const available = status.context ? await client.contexts() : [];
const textItems = available.filter(item => item.kind !== 'fork');
// Display textItems in your UI and call this with the selected handle.
async function summarize(handle: string) {
  return client.generate({
    provider: 'codex',
    input: 'Summarize the selected material.',
    context: [handle],
  });
}

// For an item with kind: 'fork', use the provider returned with that item.
async function continueCopy(item: (typeof available)[number], message: string) {
  if (item.kind !== 'fork' || !item.provider) throw new Error('Choose a conversation copy.');
  return client.chat({ provider: item.provider, message, continue: item.handle });
}
```

Each continuation starts one turn from the approved copy. If a provider reports `continuationAvailable: true` with `available: false`, enable only continuation for that provider.

The visitor creates and revokes shares locally through the menu-bar picker or `use-my-llm context pick`. A revoked or other-origin handle returns `CONTEXT_DENIED`. Handle listing is available only after pairing. The provider can include shared text in its reply, and selecting another provider sends the material to that company.

Claude inference requires Anthropic API-key mode. The standard Antigravity inference route requires a Gemini API key. Experimental ACP continuation is a separate local opt-in with its own [requirements](../../SECURITY.md#provider-restrictions). MIT licensed; provider services and dependencies have their own terms.
