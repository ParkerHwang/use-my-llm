import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runContextCommand } from '../dist/context/cli.mjs';
import { createContextStore } from '../dist/context/store.mjs';
import { allFixtures, IDS, SECRETS } from '../test-support/fixtures.mjs';

const SITE = 'https://alpha.example';
const CLI = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'use-my-llm-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = allFixtures(root);
  const store = createContextStore({ dataDir: fixtures.dataDir });
  /** Run one subcommand in-process and capture what it prints. */
  async function run(argv, { answers, interactive = false } = {}) {
    let out = '';
    let err = '';
    const queue = [...(answers ?? [])];
    const questions = [];
    const code = await runContextCommand(argv, {
      locations: fixtures.locations,
      store,
      io: {
        out: (text) => { out += text; },
        err: (text) => { err += text; },
        interactive,
        ...(interactive && { ask: async (question) => { questions.push(question); out += question; return queue.shift() ?? ''; } }),
      },
    });
    return { code, out, err, questions, json: () => JSON.parse(out) };
  }
  return { root, ...fixtures, store, run };
}

test('sources, preview and plan show the selection without sharing anything', async (t) => {
  const { run, store, dataDir, codex } = setup(t);
  const listed = (await run(['sources', '--app', 'codex', '--json'])).json().items;
  const session = listed.find((item) => item.ref.endsWith(`${IDS.codexPlain}.jsonl`));
  assert.equal(session.title, 'Private thread name: lamp rotation', 'the local picker may show the thread name');
  assert.equal(session.project, codex.project);
  assert.equal(session.firstPrompt, 'How should the lighthouse keeper schedule the lamp rotation?');
  assert.equal(typeof session.preview, 'string');

  const preview = (await run(['preview', '--ref', session.ref, '--json'])).json();
  assert.deepEqual(preview.messages.map(({ index, role }) => `${index}:${role}`), ['1:user', '2:assistant', '3:user', '4:assistant']);
  assert.equal(preview.forkProvider, 'codex');

  const plan = (await run(['plan', '--origin', SITE, '--ref', session.ref, '--from', '3', '--to', '3', '--json'])).json();
  assert.equal(plan.plan.redactions, 2);
  assert.equal(plan.plan.text.includes(SECRETS.openai), false);
  assert.equal(plan.consent[0], 'The site can read whatever you share.');
  assert.match(plan.consent[1], /the content goes to that company/);

  assert.equal((await run(['consent'])).out.startsWith('The site can read whatever you share.\n'), true);
  assert.deepEqual(store.origins(), []);
  assert.equal(existsSync(dataDir), false);
});

test('a native picker approval rejects a changed selection and binds the website', async (t) => {
  const { run, store } = setup(t);
  const memory = (await run(['sources', '--app', 'codex', '--json'])).json().items.find((item) => item.kind === 'memory');
  const plan = (await run(['plan', '--origin', SITE, '--ref', memory.ref, '--json'])).json().plan;
  const flags = ['--ref', memory.ref, '--yes', '--expect', plan.fingerprint, '--json'];
  const other = await run(['share', '--origin', 'https://beta.example', ...flags]);
  assert.equal(other.json().error.code, 'SELECTION_CHANGED');
  appendFileSync(memory.ref.slice('codex:memory:'.length), '\nChanged after the review.');
  const changed = await run(['share', '--origin', SITE, ...flags]);
  assert.equal(changed.json().error.code, 'SELECTION_CHANGED');
  assert.deepEqual(store.origins(), []);
  const updated = (await run(['plan', '--origin', SITE, '--ref', memory.ref, '--json'])).json().plan;
  const approved = await run(['share', '--origin', SITE, '--ref', memory.ref, '--yes', '--expect', updated.fingerprint, '--json']);
  assert.equal(approved.code, 0);
  assert.equal(store.list(SITE).length, 1);
});

test('terminal previews display transcript control characters without interpreting them', async (t) => {
  const { run } = setup(t);
  const memory = (await run(['sources', '--app', 'codex', '--json'])).json().items.find((item) => item.kind === 'memory');
  const unsafe = 'Line\u001b[2J\u202e\n';
  appendFileSync(memory.ref.slice('codex:memory:'.length), unsafe);
  const displayed = await run(['plan', '--origin', SITE, '--ref', memory.ref]);
  assert.ok(displayed.out.includes('Line\\u001b[2J\\u202e\n'));
  assert.equal(displayed.out.includes(unsafe), false);
  const machine = await run(['plan', '--origin', SITE, '--ref', memory.ref, '--json']);
  assert.ok(machine.json().plan.text.includes(unsafe));
  const interactive = await run(['share', '--origin', SITE, '--ref', memory.ref, '--json'], {
    interactive: true, answers: ['no'],
  });
  assert.equal(interactive.code, 1);
  assert.ok(interactive.out.includes('Line\\u001b[2J\\u202e\n'));
  assert.equal(interactive.out.includes(unsafe), false);
});

test('share needs explicit approval, then grants, lists, logs and revokes', async (t) => {
  const { run, store } = setup(t);
  const memory = (await run(['sources', '--app', 'claude-code', '--json'])).json().items.find((item) => item.title === 'layout.md').ref;

  const refused = await run(['share', '--origin', SITE, '--ref', memory]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /explicit approval/);
  const declined = await run(['share', '--origin', SITE, '--ref', memory], { interactive: true, answers: ['no'] });
  assert.equal(declined.code, 1);
  assert.match(declined.out, /The site can read whatever you share\./);
  assert.deepEqual(store.origins(), []);

  const shared = (await run(['share', '--origin', SITE, '--ref', memory, '--label', 'Orchard notes', '--yes', '--json'])).json().shared;
  assert.deepEqual({ ...shared, id: null }, { id: null, origin: SITE, app: 'claude-code', kind: 'memory', label: 'Orchard notes', bytes: 50, redactions: 0, provider: null });

  const grants = (await run(['grants', '--json'])).json().origins;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].snapshots[0].id, shared.id);
  assert.equal(JSON.stringify(grants).includes('ctx_'), false, 'handles are not printed');

  assert.equal((await run(['disable', '--origin', SITE])).code, 0);
  assert.deepEqual(store.list(SITE), []);
  assert.equal((await run(['enable', '--origin', SITE])).code, 0);
  assert.equal(store.list(SITE).length, 1);

  store.logAccess({ origin: SITE, provider: 'codex', snapshot: shared.id, bytes: 50 });
  assert.equal((await run(['log', '--json'])).json().entries[0].snapshot, shared.id);

  assert.deepEqual((await run(['revoke', '--origin', SITE, '--json'])).json(), { revoked: true });
  assert.deepEqual((await run(['revoke', '--origin', SITE, '--json'])).json(), { revoked: false });
  assert.deepEqual(store.origins(), []);
});

test('invalid origins, references and options are refused with a clear message', async (t) => {
  const { run, codex } = setup(t);
  for (const origin of ['http://alpha.example', 'https://alpha.example/path', 'null', 'https://*.example']) {
    const result = await run(['share', '--origin', origin, '--ref', 'codex:memory:/x', '--yes']);
    assert.equal(result.code, 2, origin);
  }
  assert.equal((await run(['share', '--origin', SITE, '--ref', `codex:memory:${join(codex.home, 'auth.json')}`, '--yes'])).code, 1);
  assert.equal((await run(['sources', '--app', 'notes'])).code, 2);
  assert.equal((await run(['sources', '--path', '/tmp'])).code, 2);
  assert.equal((await run(['frobnicate'])).code, 2);
  assert.equal((await run(['pick'])).code, 2, 'the picker needs a terminal');
  const failure = (await run(['plan', '--origin', SITE, '--ref', 'codex:session:/nope', '--json'])).json();
  assert.equal(failure.error.code, 'INVALID_REFERENCE');
  assert.match((await run(['help'])).out, /use-my-llm context pick/);
});

test('a Claude export ZIP is imported from the command line', async (t) => {
  const { run, zip } = setup(t);
  const imported = (await run(['import-claude-export', '--file', zip, '--json'])).json().imported;
  assert.deepEqual({ conversations: imported.conversations, memories: imported.memories, documents: imported.documents }, { conversations: 2, memories: 2, documents: 2 });
  const items = (await run(['sources', '--app', 'claude-desktop', '--json'])).json().items;
  assert.equal(items.some((item) => item.title === 'Bread proofing times'), true);
  assert.equal((await run(['import-claude-export', '--file', 'relative.zip'])).code, 2);
  assert.equal((await run(['import-claude-export', '--file', join(zip, 'missing.zip'), '--json'])).json().error.code, 'FAILED');
});

test('the terminal picker walks from website to approval and shares only on "yes"', async (t) => {
  const { run, store } = setup(t);
  // origin, app 1 (codex), project, item, range, approval
  const projects = (await run(['sources', '--app', 'codex', '--json'])).json().items;
  const projectNames = [...new Set(projects.map((item) => item.project || '(no project)'))];
  const project = projectNames.findIndex((name) => name.endsWith('lighthouse-app')) + 1;
  const inProject = projects.filter((item) => item.project === projectNames[project - 1]);
  const session = inProject.findIndex((item) => item.ref.endsWith(`${IDS.codexPlain}.jsonl`)) + 1;

  const cancelled = await run(['pick'], { interactive: true, answers: ['not an origin', SITE, '1', String(project), String(session), '1-2', 'nope'] });
  assert.equal(cancelled.code, 1);
  assert.match(cancelled.out, /Enter an exact origin/);
  assert.match(cancelled.out, /4 messages:/);
  assert.match(cancelled.out, /The site can read whatever you share\./);
  assert.match(cancelled.out, /sending a Claude conversation through Codex sends it to OpenAI/);
  assert.match(cancelled.out, /Nothing was shared\./);
  assert.deepEqual(store.origins(), []);

  const approved = await run(['pick'], { interactive: true, answers: [SITE, '1', String(project), String(session), '1-2', 'yes'] });
  assert.equal(approved.code, 0);
  assert.deepEqual(store.list(SITE).map(({ kind, label }) => ({ kind, label })), [{ kind: 'messages', label: 'Codex conversation excerpt (2 messages)' }]);

  const forked = await run(['pick'], { interactive: true, answers: [SITE, '1', String(project), String(session), 'fork', 'yes'] });
  assert.equal(forked.code, 0);
  assert.match(forked.out, /continue this whole 4 message conversation through codex, as a copy/);
  assert.equal(store.list(SITE).at(-1).provider, 'codex');
});

test('the installed command routes "context" without starting a listener', async (t) => {
  const { locations } = setup(t);
  const env = { ...process.env, LOCALHOSTAGENT_DATA_DIR: locations.dataDir, CODEX_HOME: locations.codexHome, CLAUDE_CONFIG_DIR: locations.claudeHome };
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, 'context', 'sources', '--app', 'codex', '--json'], { env });
  assert.equal(JSON.parse(stdout).items.some((item) => item.ref.endsWith(`${IDS.codexPlain}.jsonl`)), true);
  const help = await promisify(execFile)(process.execPath, [CLI, '--help'], { env });
  assert.match(help.stdout, /use-my-llm context <command>/);
  assert.match(help.stdout, /--unsafe-enable-antigravity-acp/);
  await assert.rejects(promisify(execFile)(process.execPath, [CLI, 'context', 'share', '--origin', SITE, '--ref', 'codex:memory:/x'], { env }), { code: 2 });
});
