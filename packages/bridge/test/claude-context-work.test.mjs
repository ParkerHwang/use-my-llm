import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { listSources, loadSource } from '../dist/context/sources/index.mjs';
import { planShare, share } from '../dist/context/service.mjs';
import { createContextStore } from '../dist/context/store.mjs';
import { allFixtures, SECRETS } from '../test-support/fixtures.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'use-my-llm-claude-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, ...allFixtures(root) };
}
function reference(session, project, path, extra = {}) {
  appendFileSync(session, `${JSON.stringify({ type: 'assistant', cwd: project, message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Write', input: { file_path: path } },
  ] }, ...extra })}\n`);
}
function workRef(kind, session, path = null) {
  return `claude-code:${kind}:${Buffer.from(JSON.stringify([session, path])).toString('base64url')}`;
}

test('project files are separately approved frozen snapshots with masking, origin binding, revocation and access logs', t => {
  const { locations, claude, dataDir } = setup(t);
  const path = join(claude.project, 'pruning.md');
  const original = `# Plan\nPrune in February. Token: ${SECRETS.github}\n`;
  writeFileSync(path, original);
  reference(claude.session, claude.project, path);
  const items = listSources(locations, { apps: ['claude-code'] }).items;
  const folder = items.find(item => item.title === 'Project folder (names only)');
  assert.equal(folder.kind, 'knowledge');
  const folderText = loadSource(folder.ref, locations).text;
  assert.match(folderText, /pruning\.md/);
  assert.equal(folderText.includes('Prune in February'), false, 'folder selection includes names only');
  const artifact = items.find(item => item.title === 'pruning.md');
  assert.equal(artifact.kind, 'knowledge');
  const origin = 'https://work.example';
  const plan = planShare({ origin, ref: artifact.ref }, locations);
  assert.match(plan.text, /Prune in February/);
  assert.equal(plan.text.includes(SECRETS.github), false);
  assert.equal(readFileSync(path, 'utf8'), original);
  const store = createContextStore({ dataDir });
  assert.deepEqual(store.list(origin), []);
  const { meta } = share({ origin, ref: artifact.ref }, { locations, store });
  writeFileSync(path, 'Changed after approval.');
  const [resolved] = store.resolve(origin, [meta.handle]);
  assert.equal(resolved.entry.text, plan.text, 'requests never reread project files');
  assert.throws(() => store.resolve('https://other.example', [meta.handle]), { code: 'CONTEXT_DENIED' });
  store.logAccess({ origin, provider: 'claude', snapshot: resolved.id, bytes: resolved.bytes });
  const log = readFileSync(join(dataDir, 'context', 'access.jsonl'), 'utf8');
  assert.equal(log.includes(path), false);
  assert.equal(log.includes('Prune in February'), false);
  assert.equal(store.revokeSnapshot(origin, meta.id), true);
  assert.throws(() => store.resolve(origin, [meta.handle]), { code: 'CONTEXT_DENIED' });
});

test('artifact references must come from a session and stay inside its project; secrets, binary and oversized files are excluded', t => {
  const { root, locations, claude } = setup(t);
  const outside = join(root, 'outside.md');
  const ordinary = join(claude.project, 'ordinary.md');
  const privatePath = join(claude.project, '.env.json');
  const oversized = join(claude.project, 'large.txt');
  const binary = join(claude.project, 'binary.txt');
  writeFileSync(outside, 'Outside project.');
  writeFileSync(ordinary, 'Not referenced in the session.');
  writeFileSync(privatePath, 'Secret.');
  writeFileSync(oversized, 'a'.repeat(65 * 1024));
  writeFileSync(binary, Buffer.from([0, 1, 2]));
  for (const path of [outside, privatePath, oversized, binary]) reference(claude.session, claude.project, path);
  for (const path of [outside, ordinary, privatePath, oversized, binary]) {
    assert.throws(() => loadSource(workRef('artifact', claude.session, path), locations));
  }
  const titles = listSources(locations, { apps: ['claude-code'] }).items.map(item => item.title);
  for (const title of ['outside.md', '.env.json', 'large.txt']) assert.equal(titles.includes(title), false);
  assert.throws(() => loadSource(workRef('project', outside), locations));
  if (process.platform !== 'win32') {
    const link = join(claude.project, 'linked.md');
    symlinkSync(outside, link);
    reference(claude.session, claude.project, link);
    assert.throws(() => loadSource(workRef('artifact', claude.session, link), locations));
    const hiddenLink = join(claude.project, 'public-notes.md');
    symlinkSync(privatePath, hiddenLink);
    reference(claude.session, claude.project, hiddenLink);
    assert.throws(() => loadSource(workRef('artifact', claude.session, hiddenLink), locations));
  }
});

test('Claude preferences allowlist omits accounts, auth, hooks, MCP, environment and unknown fields', t => {
  const { locations, claude } = setup(t);
  writeFileSync(join(dirname(claude.home), '.claude.json'), JSON.stringify({
    theme: 'dark', verbose: true, language: 'English', oauthAccount: { emailAddress: 'private@example.test', accessToken: 'opaque-private-token' },
    apiKey: 'opaque-key', mcpServers: { command: 'do-not-run' }, hooks: ['do-not-run'], env: { PRIVATE: 'no' },
    projects: { [claude.project]: { trust: true } }, unknownFutureField: 'no',
  }));
  const items = listSources(locations, { apps: ['claude-code'] }).items;
  const item = items.find(item => item.ref === 'claude-code:preferences');
  assert.equal(item.kind, 'instructions');
  const loaded = loadSource(item.ref, locations);
  assert.deepEqual(JSON.parse(loaded.text), { theme: 'dark', verbose: true, language: 'English' });
  assert.equal(JSON.stringify(item).includes('private@example.test'), false);
  const unrelated = join(claude.project, 'unrelated', 'CLAUDE.md');
  mkdirSync(dirname(unrelated));
  writeFileSync(unrelated, 'Not a known project.');
  assert.throws(() => loadSource(`claude-code:instructions:${unrelated}`, locations));
});

test('Desktop refuses forbidden ancestor directories and transcript directories symlinked outside 3P data', t => {
  const { root, locations, desktop } = setup(t);
  const forbidden = join(desktop.directory, 'memory', 'credentials', 'nested');
  mkdirSync(forbidden, { recursive: true });
  const path = join(forbidden, 'notes.md');
  writeFileSync(path, 'Must not become memory.');
  assert.throws(() => loadSource(`claude-desktop:3p-memory:${path}`, locations));
  if (process.platform === 'win32') return;
  const outside = join(root, 'other-transcripts');
  mkdirSync(outside);
  const id = '11111111-1111-1111-1111-111111111111';
  writeFileSync(join(outside, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'outside transcript' } })}\n`);
  const directory = join(desktop.directory, 'local-agent-mode-sessions');
  writeFileSync(join(directory, 'local_symlink.json'), JSON.stringify({ cliSessionId: id, title: 'Escaped transcript' }));
  symlinkSync(outside, join(directory, 'local_symlink'), 'dir');
  const items = listSources(locations, { apps: ['claude-desktop'] }).items;
  assert.equal(items.some(item => item.title === 'Escaped transcript'), false);
});


test('recent referenced files are discovered beyond the bounded session preview', t => {
  const { locations, claude } = setup(t);
  const artifact = join(claude.project, 'recent.md');
  writeFileSync(artifact, 'The latest project artifact.');
  appendFileSync(claude.session, `${JSON.stringify({ type: 'progress', payload: 'x'.repeat(2048) })}\n`.repeat(1000));
  reference(claude.session, claude.project, artifact);
  const item = listSources(locations, { apps: ['claude-code'] }).items.find(item => item.title === 'recent.md');
  assert.ok(item, 'recent artifact must be found even when it is absent from the session head');
  assert.match(loadSource(item.ref, locations).text, /The latest project artifact/);
});
