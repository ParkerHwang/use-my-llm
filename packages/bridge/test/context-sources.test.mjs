import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importClaudeExport, removeClaudeImport } from '../dist/context/sources/claude-desktop.mjs';
import { listSources, loadSource } from '../dist/context/sources/index.mjs';
import { openZip } from '../dist/context/zip.mjs';
import { allFixtures, IDS, SECRETS, writeZip, ZSTD } from '../test-support/fixtures.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'use-my-llm-sources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, ...allFixtures(root) };
}

/** Hash every file under a directory, to prove a reader changed nothing. */
function fingerprint(directory) {
  const hash = createHash('sha256');
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else hash.update(full).update(readFileSync(full)).update(String(statSync(full).mtimeMs));
    }
  };
  visit(directory);
  return hash.digest('hex');
}

const texts = (loaded) => loaded.messages.map((message) => `${message.role}: ${message.text}`);

test('Codex rollouts yield only what the user and assistant wrote', (t) => {
  const { locations, codex } = setup(t);
  const before = fingerprint(codex.home);
  const { items, failed } = listSources(locations, { apps: ['codex'] });
  assert.deepEqual(failed, []);
  const sessions = items.filter((item) => item.kind === 'session');
  assert.equal(sessions.length, ZSTD ? 3 : 2);
  const plain = sessions.find((item) => item.ref.endsWith(`${IDS.codexPlain}.jsonl`));
  assert.equal(plain.project, codex.project);
  assert.equal(plain.date, '2026-01-02T03:04:05.000Z');
  assert.equal(plain.firstPrompt, 'How should the lighthouse keeper schedule the lamp rotation?');
  assert.equal(plain.forkProvider, 'codex');

  const loaded = loadSource(plain.ref, locations);
  assert.deepEqual(texts(loaded).slice(0, 2), [
    'user: How should the lighthouse keeper schedule the lamp rotation?',
    'assistant: Rotate the lamp every twelve seconds and log each sweep.',
  ]);
  assert.equal(loaded.messages.length, 4);
  const everything = JSON.stringify(loaded);
  for (const hidden of ['developer instructions', 'environment_context', 'fixture tool output', 'fixture-opaque', 'base instructions']) {
    assert.equal(everything.includes(hidden), false, hidden);
  }
  assert.deepEqual(loaded.fork, { provider: 'codex' });
  assert.equal(fingerprint(codex.home), before, 'reading must not change the Codex home');
});

test('compressed and archived Codex rollouts are read, including the older event format', { skip: !ZSTD && 'this Node.js has no Zstandard support' }, (t) => {
  const { locations } = setup(t);
  const sessions = listSources(locations, { apps: ['codex'] }).items.filter((item) => item.kind === 'session');
  const compressed = sessions.find((item) => item.ref.endsWith('.jsonl.zst'));
  assert.equal(compressed.firstPrompt, 'Draft a tide table for the harbour notice board.');
  assert.deepEqual(texts(loadSource(compressed.ref, locations)), [
    'user: Draft a tide table for the harbour notice board.',
    'assistant: High tide at 06:10 and 18:35; low tide at 12:20.',
  ]);
  const archived = sessions.find((item) => item.ref.includes('archived_sessions'));
  assert.deepEqual(texts(loadSource(archived.ref, locations)), [
    'user: Which rope is best for the mooring line?',
    'assistant: Use three-strand nylon for stretch.',
  ]);
});

test('Codex memories and AGENTS.md files are selectable one at a time', (t) => {
  const { locations, codex } = setup(t);
  const items = listSources(locations, { apps: ['codex'] }).items;
  const memories = items.filter((item) => item.kind === 'memory').map((item) => `${item.project}/${item.title}`).sort();
  assert.deepEqual(memories, ['memories/MEMORY.md', 'memories_v2/memory_summary.md', `memories_v2/${join('rollout_summaries', 'lamp.md')}`]);
  const instructions = items.filter((item) => item.kind === 'instructions');
  assert.deepEqual(instructions.map((item) => item.project).sort(), ['Global', codex.project].sort());
  const project = instructions.find((item) => item.project === codex.project);
  assert.equal(loadSource(project.ref, locations).text, '# Project instructions\nUse nautical terms.\n');
  // A reference cannot be pointed at credentials or any other file.
  assert.throws(() => loadSource(`codex:memory:${join(codex.home, 'auth.json')}`, locations));
  assert.throws(() => loadSource(`codex:session:${join(codex.home, 'auth.json')}`, locations));
  assert.throws(() => loadSource(`codex:instructions:${join(codex.home, 'auth.json')}`, locations));
  assert.throws(() => loadSource('codex:memory:../../etc/passwd', locations));
});

test('Claude Code sessions skip tools, thinking, sidechains, meta and local commands', (t) => {
  const { locations, claude } = setup(t);
  const before = fingerprint(claude.home);
  const items = listSources(locations, { apps: ['claude-code'] }).items;
  const session = items.find((item) => item.ref.endsWith(`${IDS.claude}.jsonl`));
  assert.equal(session.title, 'Private title: orchard pruning');
  assert.equal(session.project, claude.project);
  assert.equal(session.forkProvider, 'claude');
  const loaded = loadSource(session.ref, locations);
  assert.deepEqual(texts(loaded), [
    'user: When should the apple trees be pruned?',
    'assistant: Prune in late winter while the trees are dormant.',
    `user: Here is the registry token ${SECRETS.github}`,
    'assistant: Do not paste tokens into chat.',
  ]);
  assert.deepEqual(loaded.fork, { provider: 'claude' });
  assert.deepEqual(items.filter((item) => item.kind === 'memory').map((item) => item.title), ['MEMORY.md', 'layout.md']);
  assert.deepEqual(items.filter((item) => item.kind === 'instructions').map((item) => item.project).sort(), ['Global', claude.project].sort());
  assert.throws(() => loadSource(`claude-code:memory:${join(claude.home, '.credentials.json')}`, locations));
  assert.throws(() => loadSource(`claude-code:instructions:${join(claude.home, '.credentials.json')}`, locations));
  assert.equal(fingerprint(claude.home), before, 'reading must not change the Claude home');
});

test('a Claude export ZIP is imported once, redacted, and then listed without the ZIP', (t) => {
  const { locations, zip, dataDir } = setup(t);
  const summary = importClaudeExport(zip, locations);
  assert.deepEqual({ ...summary, id: null }, { id: null, conversations: 2, documents: 2, memories: 2, redactions: 1, skipped: ['a-file-from-the-future.json'] });
  rmSync(zip);

  const items = listSources(locations, { apps: ['claude-desktop'] }).items.filter((item) => item.ref.includes(':import:'));
  assert.deepEqual(items.filter((item) => item.kind === 'session').map((item) => item.title), ['What is a good rye ratio?', 'Bread proofing times']);
  const conversation = loadSource(items.find((item) => item.title === 'Bread proofing times').ref, locations);
  assert.equal(conversation.messages.length, 2);
  assert.match(conversation.messages[0].text, /starter-notes\.txt/);
  assert.equal(conversation.messages[0].text.includes(SECRETS.anthropic), false);
  assert.equal(conversation.messages[1].text, 'Eight to twelve hours in the fridge.');
  assert.equal(conversation.fork, undefined);
  assert.equal(loadSource(items.find((item) => item.kind === 'memory' && item.title === 'Memory').ref, locations).text, 'Bakes on weekends and prefers grams.');
  assert.equal(loadSource(items.find((item) => item.title === 'oven.md').ref, locations).text, 'The deck oven runs twenty degrees hot.');

  const stored = join(dataDir, 'context', 'imports', 'claude-desktop', `${summary.id}.json`);
  if (process.platform !== 'win32') assert.equal(statSync(stored).mode & 0o777, 0o600);
  const raw = readFileSync(stored, 'utf8');
  assert.equal(raw.includes('person@fixture.invalid'), false, 'users.json is not imported');
  assert.equal(raw.includes(SECRETS.anthropic), false);
  assert.equal(removeClaudeImport(summary.id, locations), true);
  assert.equal(listSources(locations, { apps: ['claude-desktop'] }).items.some((item) => item.ref.includes(':import:')), false);
});

test('the ZIP reader rejects archives that are not a plain, intact export', (t) => {
  const { root, locations } = setup(t);
  const notZip = join(root, 'not-a-zip.zip');
  writeFileSync(notZip, 'plain text that is long enough to hold a directory record');
  assert.throws(() => importClaudeExport(notZip, locations), { code: 'INVALID_ZIP' });
  const other = writeZip(join(root, 'other.zip'), { 'readme.txt': 'hello' });
  assert.throws(() => importClaudeExport(other, locations), { code: 'INVALID_EXPORT' });

  const stored = writeZip(join(root, 'stored.zip'), { 'conversations.json': '[]', 'nested/dir/../../escape.json': '{}' }, { store: true });
  const archive = openZip(stored);
  t.after(() => archive.close());
  assert.equal(archive.read(archive.entries[0], 1024).toString(), '[]');
  assert.throws(() => archive.read(archive.entries[0], 1), { code: 'INVALID_ZIP' });
  const damaged = readFileSync(stored);
  damaged[damaged.indexOf(Buffer.from('[]'))] = 0x7b;
  writeFileSync(join(root, 'damaged.zip'), damaged);
  const broken = openZip(join(root, 'damaged.zip'));
  t.after(() => broken.close());
  assert.throws(() => broken.read(broken.entries[0], 1024), { code: 'INVALID_ZIP' });
});

test('Claude Desktop 3P sessions and memory are read, and browser storage is never opened', (t) => {
  const { locations, desktop } = setup(t);
  const items = listSources(locations, { apps: ['claude-desktop'] }).items;
  assert.deepEqual(items.map((item) => `${item.kind}:${item.title}`).sort(), ['memory:garden.md', 'session:Compost plan', 'session:Seed order']);
  assert.deepEqual(texts(loadSource(items.find((item) => item.title === 'Compost plan').ref, locations)), [
    'user: How often should compost be turned?',
    'assistant: Turn it once a week.',
  ]);
  assert.deepEqual(texts(loadSource(items.find((item) => item.title === 'Seed order').ref, locations)), [
    'user: Which seeds for spring?',
    'assistant: Peas and broad beans.',
  ]);
  assert.equal(loadSource(items.find((item) => item.kind === 'memory').ref, locations).text, 'The greenhouse faces east.\n');
  assert.equal(JSON.stringify(items).includes('fixture-cookie-store'), false);
  for (const forbidden of ['Cookies', join('IndexedDB', 'store.leveldb'), join('memory', 'session-token.md')]) {
    assert.throws(() => loadSource(`claude-desktop:3p-memory:${join(desktop.directory, forbidden)}`, locations), forbidden);
    assert.throws(() => loadSource(`claude-desktop:3p-session:${join(desktop.directory, forbidden)}`, locations), forbidden);
  }
});

test('Antigravity knowledge and brain artifacts load from both app directories and survive unknown data', (t) => {
  const { locations, antigravity } = setup(t);
  const before = fingerprint(antigravity.gemini);
  const { items, failed } = listSources(locations, { apps: ['antigravity'] });
  assert.deepEqual(failed, []);
  assert.deepEqual(items.map((item) => `${item.kind}:${item.title}`).sort(), [
    'knowledge:crossing.md', 'knowledge:implementation_plan.md', 'knowledge:route.md', 'knowledge:weekday.md',
    'session:Plan a tram route from the museum to the harbour.', 'session:When is the last ferry?',
  ]);
  const weekday = items.find((item) => item.title === 'weekday.md');
  assert.equal(weekday.project, 'antigravity · Tram timetable');
  assert.equal(weekday.date, '2026-05-06T07:08:09.000Z');
  assert.equal(weekday.preview, 'Weekday and weekend tram frequencies.');
  assert.equal(items.find((item) => item.title === 'route.md').project, 'antigravity · broken-item');
  assert.equal(loadSource(weekday.ref, locations).text, '# Weekday\nTrams run every eight minutes.\n');
  assert.deepEqual(texts(loadSource(items.find((item) => item.title.startsWith('Plan a tram')).ref, locations)), [
    'user: Plan a tram route from the museum to the harbour.',
    'assistant: Take line 4 and change at Market Square.',
  ]);
  assert.equal(items.filter((item) => item.kind === 'session').every((item) => item.forkProvider === 'antigravity'), true);
  assert.equal(items.filter((item) => item.kind === 'knowledge').every((item) => item.forkProvider === undefined), true);
  assert.throws(() => loadSource(`antigravity:artifact:${join(antigravity.gemini, 'antigravity', 'brain', 'fixture-brain-1', '.system_generated', 'hidden.md')}`, locations));
  assert.throws(() => loadSource(`antigravity:brain:${join(antigravity.gemini, 'antigravity', 'conversations', 'fixture.db')}`, locations));
  assert.equal(fingerprint(antigravity.gemini), before);
});

test('one unreadable app does not stop the others, and missing directories list nothing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'use-my-llm-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = join(root, 'missing');
  const locations = { codexHome: missing, claudeHome: missing, claude3pDir: missing, geminiDir: missing, dataDir: missing };
  assert.deepEqual(listSources(locations), { items: [], failed: [] });
  assert.throws(() => loadSource('unknown:thing', locations));
});
