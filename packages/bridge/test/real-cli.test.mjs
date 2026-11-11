// Opt-in checks against the provider CLIs installed on this computer.
//
// These are skipped unless USE_MY_LLM_REAL_CLI=1, because they start real
// binaries and reach the providers' servers. Each test says what it needs.
// They only ever read made-up fixtures, except the last two Codex tests,
// which need a real login and are enabled separately.
//
//   USE_MY_LLM_REAL_CLI=1                      real binaries, made-up data, no login needed
//   USE_MY_LLM_REAL_CODEX_LOGIN=1              also send one real Codex request (uses your Codex allowance)
//   USE_MY_LLM_REAL_CODEX_FORK=<session-id>    also continue one of your own Codex sessions as an ephemeral copy
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { share } from '../dist/context/service.mjs';
import { listSources } from '../dist/context/sources/index.mjs';
import { createContextStore } from '../dist/context/store.mjs';
import { agyAcpAvailable, findAgy } from '../dist/providers/antigravity.mjs';
import { findClaude, forkClaude } from '../dist/providers/claude.mjs';
import { findCodex, forkCodex, runCodex } from '../dist/providers/codex.mjs';
import { allFixtures, IDS } from '../test-support/fixtures.mjs';

const ENABLED = process.env.USE_MY_LLM_REAL_CLI === '1';
const SITE = 'https://alpha.example';
const codex = ENABLED ? findCodex() : null;
const claude = ENABLED ? (process.env.LOCALHOSTAGENT_CLAUDE_PATH ?? findClaude()) : null;
const agy = ENABLED ? findAgy() : null;
const off = 'set USE_MY_LLM_REAL_CLI=1 to run against installed CLIs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'use-my-llm-real-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = allFixtures(root);
  const store = createContextStore({ dataDir: fixtures.dataDir });
  const item = (app, match) => listSources(fixtures.locations, { apps: [app] }).items.find(match);
  const grant = (options) => share({ origin: SITE, ...options }, { locations: fixtures.locations, store }).meta;
  return { root, ...fixtures, store, item, grant };
}

/** Hash the session files only. Codex keeps its own logs and caches elsewhere in its home. */
function sessionFiles(home) {
  const hash = createHash('sha256');
  const names = [];
  for (const directory of ['sessions', 'archived_sessions']) {
    const root = join(home, directory);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
      const path = join(entry.parentPath, entry.name);
      names.push(path);
      if (entry.isFile()) hash.update(path).update(readFileSync(path));
    }
  }
  return { digest: hash.update(names.sort().join('\n')).digest('hex'), count: names.length };
}

function withEnvironment(t, values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('real Codex CLI: fork loads a made-up session, accepts every restriction, and leaves session files unchanged',
  { skip: !ENABLED ? off : !codex ? 'the Codex CLI is not installed' : false, timeout: 180_000 }, async (t) => {
    const { root, codex: fixture, store, item, grant } = setup(t);
    // A home with no login: the CLI must get as far as the provider and be refused there.
    withEnvironment(t, { CODEX_HOME: fixture.home });
    const meta = grant({ ref: item('codex', (entry) => entry.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref, fork: true });
    const [{ fork }] = store.resolve(SITE, [meta.handle]);
    const before = sessionFiles(fixture.home);
    await assert.rejects(forkCodex({ fork, executable: codex, cwd: root, message: 'Reply with the single word: ok' }), (error) => {
      // CODEX_UNSUPPORTED would mean a rejected flag; CODEX_FAILED would mean the session did not load.
      assert.equal(error.code, 'LOGIN_REQUIRED', `unexpected ${error.code}`);
      return true;
    });
    assert.deepEqual(sessionFiles(fixture.home), before, 'no rollout was added or changed');
  });

test('real Codex CLI with your login: shared context is used in a reply',
  { skip: !ENABLED ? off : !codex ? 'the Codex CLI is not installed' : process.env.USE_MY_LLM_REAL_CODEX_LOGIN !== '1' ? 'needs a Codex login; set USE_MY_LLM_REAL_CODEX_LOGIN=1' : false, timeout: 240_000 }, async (t) => {
    const { root } = setup(t);
    const before = sessionFiles(join(homedir(), '.codex'));
    const { reply } = await runCodex({
      executable: codex, cwd: root,
      message: 'What colour is the harbour master’s door according to the shared context? Answer with one word.',
      context: [{ source: 'codex:memory', text: 'Made-up fact for a test: the harbour master’s door is painted vermilion.' }],
    });
    assert.match(reply, /vermilion/i);
    assert.deepEqual(sessionFiles(join(homedir(), '.codex')), before, 'an ephemeral turn adds no session file');
  });

test('real Codex CLI with your login: one of your sessions is continued as a copy and no session file changes',
  { skip: !ENABLED ? off : !codex ? 'the Codex CLI is not installed' : !process.env.USE_MY_LLM_REAL_CODEX_FORK ? 'needs a Codex login and a session id in USE_MY_LLM_REAL_CODEX_FORK' : false, timeout: 300_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'use-my-llm-real-fork-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const locations = { codexHome: home, claudeHome: join(root, 'none'), claude3pDir: join(root, 'none'), geminiDir: join(root, 'none'), dataDir: join(root, 'data') };
    const store = createContextStore({ dataDir: locations.dataDir });
    const session = listSources(locations, { apps: ['codex'], detailLimit: 0, limit: 5000 }).items
      .find((entry) => entry.kind === 'session' && entry.ref.includes(process.env.USE_MY_LLM_REAL_CODEX_FORK));
    assert.ok(session, 'the session id was not found under the Codex home');
    const { meta } = share({ origin: SITE, ref: session.ref, fork: true }, { locations, store });
    const [{ fork }] = store.resolve(SITE, [meta.handle]);
    const before = sessionFiles(home);
    const { reply } = await forkCodex({ fork, executable: codex, cwd: root, message: 'Reply with exactly this text and nothing else: FORK_OK' });
    assert.match(reply, /FORK_OK/);
    // Only the outcome is reported. The reply text of a real conversation is never printed.
    const after = sessionFiles(home);
    assert.equal(after.count, before.count, 'no session file was added or removed');
    assert.equal(after.digest, before.digest, 'every session file has the same content');
  });

test('real Claude Code CLI: the bridge-only copy is found by --resume --fork-session, and only an API key is tried',
  { skip: !ENABLED ? off : !claude ? 'Claude Code is not installed (set LOCALHOSTAGENT_CLAUDE_PATH)' : false, timeout: 180_000 }, async (t) => {
    const { root, store, item, grant, dataDir } = setup(t);
    const meta = grant({ ref: item('claude-code', (entry) => entry.ref.endsWith(`${IDS.claude}.jsonl`)).ref, fork: true });
    const [{ fork }] = store.resolve(SITE, [meta.handle]);
    // A made-up key: Anthropic must refuse it. Reaching that refusal shows the copy was loaded
    // and that no stored subscription login was used instead.
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), ANTHROPIC_API_KEY: 'fixture-key-that-anthropic-will-refuse' };
    const args = ['--print', '--bare', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--resume', fork.sessionId, '--fork-session'];
    let output;
    try {
      output = execFileSync(claude, args, { cwd: fork.cwd, env: { ...env, CLAUDE_CONFIG_DIR: fork.configDir }, input: 'Reply with the single word: ok', encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    assert.doesNotMatch(output, /No conversation found/i, 'the copied session must be found');
    assert.match(output, /invalid api key|authentication|401|x-api-key|API key/i, 'the only credential tried is the API key');
    await assert.rejects(forkClaude({ fork, executable: claude, env, message: 'Reply with the single word: ok' }), { code: 'PROVIDER_FAILED' });
    // Nothing was written back next to the copy.
    const project = join(fork.configDir, 'projects');
    assert.equal(readdirSync(project, { recursive: true }).filter((name) => String(name).endsWith('.jsonl')).length, 1);
    assert.ok(dataDir);
  });

test('real agy CLI: report whether this build has the acp subcommand',
  { skip: !ENABLED ? off : !agy ? 'agy is not installed' : false }, (t) => {
    const available = agyAcpAvailable(agy);
    t.diagnostic(`agy acp available: ${available}`);
    if (!available) t.skip('this agy build has no "acp" subcommand, so ACP listing and continuation cannot be exercised here');
  });
