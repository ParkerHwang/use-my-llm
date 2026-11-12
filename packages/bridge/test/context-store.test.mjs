import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planShare, share, CONSENT_LINES } from '../dist/context/service.mjs';
import { listSources } from '../dist/context/sources/index.mjs';
import { createContextStore } from '../dist/context/store.mjs';
import { allFixtures, IDS, SECRETS } from '../test-support/fixtures.mjs';

const SITE_A = 'https://alpha.example';
const SITE_B = 'https://beta.example';
const POSIX = process.platform !== 'win32';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'use-my-llm-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = allFixtures(root);
  const store = createContextStore({ dataDir: fixtures.dataDir, now: () => Date.parse('2026-06-01T00:00:00Z') });
  const refs = (app) => listSources(fixtures.locations, { apps: [app] }).items;
  return { root, ...fixtures, store, refs };
}

function everyFile(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test('sharing is off by default and the consent text states both disclosures', (t) => {
  const { store, dataDir } = setup(t);
  assert.deepEqual(store.list(SITE_A), []);
  assert.deepEqual(store.origins(), []);
  assert.throws(() => store.resolve(SITE_A, [`ctx_${'a'.repeat(43)}`]), { code: 'CONTEXT_DENIED' });
  assert.equal(existsSync(dataDir), false, 'reading an empty store creates nothing');
  assert.equal(CONSENT_LINES[0], 'The site can read whatever you share.');
  assert.match(CONSENT_LINES[1], /^If you send it to a different provider, the content goes to that company\./);
  assert.match(CONSENT_LINES[1], /sending a Claude conversation through Codex sends it to OpenAI/);
});

test('a message range is redacted, stored privately with its hash, and never re-read from the original', (t) => {
  const { store, locations, dataDir, codex, refs } = setup(t);
  const ref = refs('codex').find((item) => item.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref;

  // Planning shows exactly what would be stored and writes nothing.
  const plan = planShare({ origin: SITE_A, ref, from: 2, to: 3 }, locations);
  assert.equal(plan.kind, 'messages');
  assert.equal(plan.label, 'Codex conversation excerpt (2 messages)');
  assert.equal(plan.text.includes(SECRETS.openai), false);
  assert.equal(plan.text.includes(SECRETS.password), false);
  assert.equal(plan.redactions, 2);
  assert.match(plan.text, /^Assistant: Rotate the lamp every twelve seconds/);
  assert.equal(existsSync(dataDir), false);

  const { meta } = share({ origin: SITE_A, ref, from: 2, to: 3 }, { locations, store });
  assert.match(meta.handle, /^ctx_[A-Za-z0-9_-]{43}$/);
  assert.equal(meta.sha256, createHash('sha256').update(plan.text).digest('hex'));
  assert.equal(meta.bytes, Buffer.byteLength(plan.text));

  const files = everyFile(dataDir);
  assert.equal(files.length, 2);
  if (POSIX) {
    for (const file of files) assert.equal(statSync(file).mode & 0o777, 0o600, file);
    assert.equal(statSync(join(dataDir, 'context')).mode & 0o777, 0o700);
  }
  const onDisk = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.equal(onDisk.includes(SECRETS.openai), false);
  // The stored record does not point back at where the text came from.
  for (const hidden of [codex.home, IDS.codexPlain, 'Private thread name', 'rollout-']) {
    assert.equal(onDisk.includes(hidden), false, hidden);
  }

  // After approval the original can change or disappear without any effect.
  rmSync(codex.home, { recursive: true, force: true });
  const [resolved] = store.resolve(SITE_A, [meta.handle]);
  assert.deepEqual(resolved.entry, { source: 'codex:messages', text: plan.text });
  assert.equal(resolved.id, meta.id);
});

test('what a website can list has no session id, thread name, title or path', (t) => {
  const { store, locations, refs, claude, codex } = setup(t);
  const session = refs('claude-code').find((item) => item.ref.endsWith(`${IDS.claude}.jsonl`));
  share({ origin: SITE_A, ref: session.ref }, { locations, store });
  share({ origin: SITE_A, ref: refs('codex').find((item) => item.kind === 'instructions' && item.project === 'Global').ref }, { locations, store });
  share({ origin: SITE_A, ref: refs('claude-code').find((item) => item.title === 'layout.md').ref, label: '  Orchard\u0007 layout  ' }, { locations, store });

  const listed = store.list(SITE_A);
  assert.deepEqual(listed.map(({ app, kind, label }) => ({ app, kind, label })), [
    { app: 'claude-code', kind: 'messages', label: 'Claude Code conversation excerpt (4 messages)' },
    { app: 'codex', kind: 'instructions', label: 'Codex instructions' },
    { app: 'claude-code', kind: 'memory', label: 'Orchard  layout' },
  ]);
  for (const entry of listed) {
    assert.deepEqual(Object.keys(entry).sort(), ['app', 'bytes', 'createdAt', 'handle', 'kind', 'label']);
  }
  const visible = JSON.stringify(listed);
  for (const hidden of [IDS.claude, 'Private title', claude.home, codex.home, 'AGENTS.md', 'layout.md', '.jsonl']) {
    assert.equal(visible.includes(hidden), false, hidden);
  }
});

test('a handle works only for the website it was shared with', (t) => {
  const { store, locations, refs } = setup(t);
  const ref = refs('codex').find((item) => item.kind === 'memory').ref;
  const forA = share({ origin: SITE_A, ref }, { locations, store }).meta;
  const forB = share({ origin: SITE_B, ref }, { locations, store }).meta;
  assert.notEqual(forA.handle, forB.handle);
  assert.equal(store.resolve(SITE_A, [forA.handle]).length, 1);
  assert.throws(() => store.resolve(SITE_B, [forA.handle]), { code: 'CONTEXT_DENIED' });
  assert.throws(() => store.resolve(SITE_A, [forB.handle]), { code: 'CONTEXT_DENIED' });
  assert.throws(() => store.resolve('https://gamma.example', [forA.handle]), { code: 'CONTEXT_DENIED' });
  // Malformed, duplicated and guessed handles are refused the same way.
  for (const bad of [[forA.handle, forA.handle], ['ctx_short'], [`ctx_${'z'.repeat(43)}`], [forA.id], ['../grants.json']]) {
    assert.throws(() => store.resolve(SITE_A, bad), { code: 'CONTEXT_DENIED' });
  }
});

test('a tampered snapshot or grants file shares nothing', (t) => {
  const { store, locations, refs, dataDir } = setup(t);
  const { meta } = share({ origin: SITE_A, ref: refs('codex').find((item) => item.kind === 'memory').ref }, { locations, store });
  const [snapshot] = everyFile(join(dataDir, 'context', 'snapshots'));
  const stored = JSON.parse(readFileSync(snapshot, 'utf8'));
  writeFileSync(snapshot, JSON.stringify({ ...stored, text: `${stored.text} plus something the user never approved` }));
  assert.throws(() => store.resolve(SITE_A, [meta.handle]), { code: 'CONTEXT_DENIED' });
  writeFileSync(join(dataDir, 'context', 'grants.json'), '{ damaged');
  assert.deepEqual(store.list(SITE_A), []);
});

test('revoking a website deletes its snapshots and conversation copies together', (t) => {
  const { store, locations, refs, dataDir } = setup(t);
  const session = refs('claude-code').find((item) => item.ref.endsWith(`${IDS.claude}.jsonl`)).ref;
  const text = share({ origin: SITE_A, ref: session, from: 1, to: 1 }, { locations, store }).meta;
  const fork = share({ origin: SITE_A, ref: session, fork: true }, { locations, store }).meta;
  const other = share({ origin: SITE_B, ref: session, from: 1, to: 1 }, { locations, store }).meta;
  assert.equal(everyFile(join(dataDir, 'context', 'forks')).length, 1);
  assert.equal(everyFile(join(dataDir, 'context', 'snapshots')).length, 3);

  // Sharing can be switched off without deleting, then back on.
  assert.equal(store.setEnabled(SITE_A, false), true);
  assert.deepEqual(store.list(SITE_A), []);
  assert.throws(() => store.resolve(SITE_A, [text.handle]), { code: 'CONTEXT_DENIED' });
  assert.equal(store.setEnabled(SITE_A, true), true);
  assert.equal(store.list(SITE_A).length, 2);

  // One item.
  assert.equal(store.revokeSnapshot(SITE_A, text.id), true);
  assert.throws(() => store.resolve(SITE_A, [text.handle]), { code: 'CONTEXT_DENIED' });
  assert.equal(store.resolve(SITE_A, [fork.handle]).length, 1);

  // The whole website.
  assert.equal(store.revokeOrigin(SITE_A), true);
  assert.equal(store.revokeOrigin(SITE_A), false);
  assert.deepEqual(store.list(SITE_A), []);
  assert.throws(() => store.resolve(SITE_A, [fork.handle]), { code: 'CONTEXT_DENIED' });
  assert.equal(everyFile(join(dataDir, 'context', 'forks')).length, 0);
  const left = everyFile(join(dataDir, 'context', 'snapshots'));
  assert.equal(left.length, 1);
  assert.equal(store.resolve(SITE_B, [other.handle]).length, 1, 'another website is unaffected');
  assert.deepEqual(store.origins().map(({ origin }) => origin), [SITE_B]);
});

test('approving one item cannot reactivate paused shares', (t) => {
  const { store, locations, refs } = setup(t);
  const [first, second] = refs('codex').filter((item) => item.kind === 'memory');
  const { meta } = share({ origin: SITE_A, ref: first.ref }, { locations, store });
  assert.equal(store.setEnabled(SITE_A, false), true);
  assert.throws(() => share({ origin: SITE_A, ref: second.ref }, { locations, store }), { code: 'SHARING_DISABLED' });
  assert.throws(() => store.resolve(SITE_A, [meta.handle]), { code: 'CONTEXT_DENIED' });
  assert.equal(store.origins()[0].snapshots.length, 1);
});

test('excerpt redaction detects a three-line environment block at the start of a message', (t) => {
  const { store, locations, codex, refs } = setup(t);
  appendFileSync(codex.plain, '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'AAA=synthetic1\nBBB=synthetic2\nCCC=synthetic3' }],
  } }) + '\n');
  const ref = refs('codex').find((item) => item.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref;
  const { meta } = share({ origin: SITE_A, ref, from: 5 }, { locations, store });
  const [resolved] = store.resolve(SITE_A, [meta.handle]);
  assert.equal(meta.redactions, 3);
  assert.equal(resolved.entry.text, 'User: AAA=[REDACTED:env]\nBBB=[REDACTED:env]\nCCC=[REDACTED:env]');
});

test('the access log holds only timestamp, origin, provider, snapshot and byte count', (t) => {
  const { store, locations, refs, dataDir } = setup(t);
  const { meta } = share({ origin: SITE_A, ref: refs('codex').find((item) => item.kind === 'memory').ref }, { locations, store });
  const [used] = store.resolve(SITE_A, [meta.handle]);
  store.logAccess({ origin: SITE_A, provider: 'codex', snapshot: used.id, bytes: used.bytes, text: used.entry.text, handle: meta.handle });
  const raw = readFileSync(join(dataDir, 'context', 'access.jsonl'), 'utf8');
  assert.deepEqual(raw.trim().split('\n').map((line) => JSON.parse(line)), [
    { ts: '2026-06-01T00:00:00.000Z', origin: SITE_A, provider: 'codex', snapshot: meta.id, bytes: meta.bytes },
  ]);
  assert.equal(raw.includes(meta.handle), false);
  assert.equal(raw.includes('metric units'), false);
  if (POSIX) assert.equal(statSync(join(dataDir, 'context', 'access.jsonl')).mode & 0o777, 0o600);
  assert.deepEqual(store.readLog(), [{ ts: '2026-06-01T00:00:00.000Z', origin: SITE_A, provider: 'codex', snapshot: meta.id, bytes: meta.bytes }]);
});

test('selections that are empty, out of range or too large are refused before anything is stored', (t) => {
  const { store, locations, refs, root, dataDir } = setup(t);
  const session = refs('codex').find((item) => item.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref;
  for (const range of [{ from: 0 }, { from: 3, to: 2 }, { to: 99 }, { from: 1.5 }]) {
    assert.throws(() => share({ origin: SITE_A, ref: session, ...range }, { locations, store }), { code: 'INVALID_RANGE' });
  }
  const big = join(locations.codexHome, 'memories', 'big.md');
  writeFileSync(big, 'tide '.repeat(60_000));
  assert.throws(() => share({ origin: SITE_A, ref: `codex:memory:${big}` }, { locations, store }), { code: 'SELECTION_TOO_LARGE' });
  const blank = join(locations.codexHome, 'memories', 'blank.md');
  writeFileSync(blank, '  \n');
  assert.throws(() => share({ origin: SITE_A, ref: `codex:memory:${blank}` }, { locations, store }), { code: 'EMPTY_SELECTION' });
  // A live ACP reference has no frozen transcript that the user can review.
  assert.throws(() => share({ origin: SITE_A, ref: 'antigravity:acp:fixture-session', fork: true }, { locations, store }), { code: 'NOT_FORKABLE' });
  assert.equal(existsSync(join(dataDir, 'context', 'snapshots')), false);
  assert.ok(root);
});
