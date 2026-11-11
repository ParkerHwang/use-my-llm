// Browser SDK + bridge + permission store, end to end with made-up local data.
// The provider is a stub: this test never starts a real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runContextCommand } from '../packages/bridge/dist/context/cli.mjs';
import { createContextStore } from '../packages/bridge/dist/context/store.mjs';
import { createBridge } from '../packages/bridge/dist/server.mjs';
import { createClient } from '../packages/browser/dist/index.js';
import { allFixtures, IDS, SECRETS } from '../packages/bridge/test-support/fixtures.mjs';

function tab(origin, port) {
  let current = new URL(`${origin}/app`);
  let navigation;
  const saved = new Map();
  const client = createClient({
    bridgeUrl: `http://127.0.0.1:${port}`,
    fetch: (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, Origin: origin } }),
    location: { get href() { return current.href; }, get origin() { return current.origin; }, get hash() { return current.hash; }, assign(url) { navigation = url; }, replace(url) { current = new URL(url, current); } },
    history: { state: null, replaceState(_state, _title, url) { current = new URL(url, current); } },
    sessionStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: (key) => saved.delete(key) },
    crypto: webcrypto,
  });
  return {
    client,
    async pair(localOrigin) {
      await client.pair();
      const page = await (await fetch(navigation, { headers: { 'Sec-Fetch-Dest': 'document' } })).text();
      const csrf = page.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1];
      const answer = await fetch(`${localOrigin}/v1/pair/approve`, {
        method: 'POST', redirect: 'manual', headers: { Origin: localOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, decision: 'allow' }),
      });
      current = new URL(answer.headers.get('location'));
      assert.deepEqual(await client.completePairing(), { paired: true });
    },
  };
}

test('a user shares part of a local conversation with one website, which another website cannot use', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'use-my-llm-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { locations } = allFixtures(root);
  const store = createContextStore({ dataDir: locations.dataDir });
  const requests = [];
  const bridge = createBridge({
    port: 0,
    context: store,
    getProviders: () => [{ id: 'codex', available: true }],
    runProvider: async (request) => { requests.push(request); return { provider: request.provider, reply: 'A summary of what you shared.' }; },
  });
  const { port } = await bridge.listen();
  t.after(() => bridge.close());
  const localOrigin = `http://127.0.0.1:${port}`;
  const first = tab('https://first.example', port);
  const second = tab('https://second.example', port);
  await first.pair(localOrigin);
  await second.pair(localOrigin);

  // Before the user shares anything, a paired website sees nothing.
  assert.equal((await first.client.status()).context, true);
  assert.deepEqual(await first.client.contexts(), []);

  // The user picks two messages of a Claude Code session, locally, for the first website only.
  const cli = async (...argv) => {
    let out = '';
    const code = await runContextCommand(argv, { locations, store, io: { out: (text) => { out += text; }, err: () => {}, interactive: false } });
    assert.equal(code, 0, out);
    return JSON.parse(out);
  };
  const session = (await cli('sources', '--app', 'claude-code', '--json')).items.find((item) => item.ref.endsWith(`${IDS.claude}.jsonl`));
  await cli('share', '--origin', 'https://first.example', '--ref', session.ref, '--from', '2', '--to', '3', '--yes', '--json');

  const shared = await first.client.contexts();
  assert.equal(shared.length, 1);
  assert.deepEqual({ ...shared[0], handle: null, createdAt: null, bytes: null }, {
    handle: null, app: 'claude-code', kind: 'messages', label: 'Claude Code conversation excerpt (2 messages)', bytes: null, createdAt: null,
  });
  assert.deepEqual(await second.client.contexts(), []);

  // A Claude conversation sent through Codex: the provider gets the redacted excerpt as quoted context.
  const result = await first.client.generate({ provider: 'codex', input: 'Summarise this.', context: [shared[0].handle] });
  assert.deepEqual(result, { provider: 'codex', output: 'A summary of what you shared.' });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].context.map(({ source }) => source), ['claude-code:messages']);
  assert.match(requests[0].context[0].text, /^Assistant: Prune in late winter/);
  assert.equal(requests[0].context[0].text.includes(SECRETS.github), false);
  assert.match(requests[0].context[0].text, /\[REDACTED:github-token\]/);

  // The second website holds a valid session but the handle is not its own.
  await assert.rejects(second.client.generate({ provider: 'codex', input: 'Summarise this.', context: [shared[0].handle] }), { code: 'CONTEXT_DENIED' });
  assert.equal(requests.length, 1);

  const log = (await cli('log', '--json')).entries;
  assert.deepEqual(log.map(({ origin, provider }) => ({ origin, provider })), [{ origin: 'https://first.example', provider: 'codex' }]);

  // Revoking from the local side takes effect on the next request.
  await cli('revoke', '--origin', 'https://first.example', '--json');
  assert.deepEqual(await first.client.contexts(), []);
  await assert.rejects(first.client.generate({ provider: 'codex', input: 'Summarise this.', context: [shared[0].handle] }), { code: 'CONTEXT_DENIED' });
  assert.equal((await first.client.status()).connected, true, 'the pairing itself is untouched');
});
