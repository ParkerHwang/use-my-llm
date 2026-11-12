// Opt-in checks against the provider CLIs installed on this computer.
//
// These are skipped unless USE_MY_LLM_REAL_CLI=1, because they start real
// binaries and reach the providers' servers. Each test says what it needs.
// Most checks read made-up fixtures. The Claude subscription check explicitly
// opts into reading and continuing a copy of a real local Claude Code session.
//
//   USE_MY_LLM_REAL_CLI=1                      real binaries, made-up data, no login needed
//   USE_MY_LLM_REAL_CODEX_LOGIN=1              also send one real Codex request (uses your Codex allowance)
//   LOCALHOSTAGENT_CODEX_FORK_HOME=/path      optionally test a separate, already signed-in Codex home
//   USE_MY_LLM_REAL_CLAUDE_LOGIN=1            continue a real Claude session using the bridge subscription login
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { share } from '../dist/context/service.mjs';
import { listSources } from '../dist/context/sources/index.mjs';
import { claudeSubscriptionConnected, claudeSubscriptionDirectory } from '../dist/claude-auth.mjs';
import { defaultLocations } from '../dist/context/sources/index.mjs';
import { createContextStore } from '../dist/context/store.mjs';
import { agyAcpAvailable, findAgy } from '../dist/providers/antigravity.mjs';
import { findClaude, forkClaude, claudePrintArgs } from '../dist/providers/claude.mjs';
import { createProviderRegistry } from '../dist/providers/index.mjs';
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

test('real Codex CLI: fork loads a made-up session, accepts every restriction, and leaves session files unchanged',
  { skip: !ENABLED ? off : !codex ? 'the Codex CLI is not installed' : false, timeout: 180_000 }, async (t) => {
    const { root, codex: fixture, store, item, grant } = setup(t);
    // A home with no login: the CLI must get as far as the provider and be refused there.
    const forkHome = join(root, 'fork-home');
    mkdirSync(forkHome);
    const meta = grant({ ref: item('codex', (entry) => entry.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref, fork: true });
    const [{ fork, entry }] = store.resolve(SITE, [meta.handle]);
    const before = sessionFiles(fixture.home);
    await assert.rejects(forkCodex({ fork, transcript: entry.text, forkHome, executable: codex, cwd: root, message: 'Reply with the single word: ok' }), (error) => {
      // CODEX_UNSUPPORTED would mean a rejected flag; CODEX_FAILED would mean the session did not load.
      assert.equal(error.code, 'LOGIN_REQUIRED', `unexpected ${error.code}`);
      return true;
    });
    assert.deepEqual(sessionFiles(fixture.home), before, 'no rollout was added or changed');
    assert.equal(readdirSync(join(forkHome, 'sessions'), { recursive: true }).some(name => name.endsWith('.jsonl')), false);
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

test('real Codex CLI with a separate login: a synthetic conversation is continued as a copy',
  { skip: !ENABLED ? off : !codex ? 'the Codex CLI is not installed' : process.env.USE_MY_LLM_REAL_CODEX_LOGIN !== '1' || !process.env.LOCALHOSTAGENT_CODEX_FORK_HOME ? 'needs opt-in and a separate signed-in LOCALHOSTAGENT_CODEX_FORK_HOME' : false, timeout: 240_000 }, async (t) => {
    const { root, codex: fixture, store, item, grant } = setup(t);
    const meta = grant({ ref: item('codex', (entry) => entry.ref.endsWith(`${IDS.codexPlain}.jsonl`)).ref, fork: true });
    const [{ fork, entry }] = store.resolve(SITE, [meta.handle]);
    const before = sessionFiles(fixture.home);
    const { reply } = await forkCodex({
      fork, transcript: entry.text, executable: codex, cwd: root,
      message: 'Reply with exactly this text and nothing else: FORK_OK',
    });
    assert.match(reply, /FORK_OK/);
    assert.deepEqual(sessionFiles(fixture.home), before);
  });

test('real Claude Code CLI: the bridge-only copy is found by --resume --fork-session, and only an API key is tried',
  { skip: !ENABLED ? off : !claude ? 'Claude Code is not installed (set LOCALHOSTAGENT_CLAUDE_PATH)' : false, timeout: 180_000 }, async (t) => {
    const { root, store, item, grant, dataDir } = setup(t);
    const meta = grant({ ref: item('claude-code', (entry) => entry.ref.endsWith(`${IDS.claude}.jsonl`)).ref, fork: true });
    const [{ fork }] = store.resolve(SITE, [meta.handle]);
    // A made-up key: Anthropic must refuse it. Reaching that refusal shows the copy was loaded
    // and that no stored subscription login was used instead.
    const env = { PATH: process.env.PATH, HOME: homedir(), ANTHROPIC_API_KEY: 'fixture-key-that-anthropic-will-refuse', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const args = [...claudePrintArgs('api-key'), '--resume', fork.sessionId, '--fork-session'];
    const before = claudeOriginalHash();
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
    assert.deepEqual(claudeOriginalHash(), before, 'original Claude files are unchanged');
  });

test('real agy CLI: report whether this build has the acp subcommand',
  { skip: !ENABLED ? off : !agy ? 'agy is not installed' : false }, (t) => {
    const available = agyAcpAvailable(agy);
    t.diagnostic(`agy acp available: ${available}`);
    if (!available) t.skip('this agy build has no "acp" subcommand, so ACP listing and continuation cannot be exercised here');
  });

/** Whole original Claude tree plus ~/.claude.json; never print names or file contents. */
function claudeOriginalHash() {
  const hash = createHash('sha256');
  let count = 0;
  const directory = join(homedir(), '.claude');
  if (existsSync(directory)) {
    const files = readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
    for (const path of files) { hash.update(path).update(readFileSync(path)); count++; }
  }
  const config = join(homedir(), '.claude.json');
  if (existsSync(config)) { hash.update(config).update(readFileSync(config)); count++; }
  return { digest: hash.digest('hex'), count };
}

test('real Claude subscription: continues a real approved session copy and preserves original data',
  { skip: !ENABLED ? off : !claude ? 'Claude Code is not installed' : process.env.USE_MY_LLM_REAL_CLAUDE_LOGIN !== '1'
    ? 'needs bridge subscription sign-in and USE_MY_LLM_REAL_CLAUDE_LOGIN=1' : false, timeout: 240_000 }, async t => {
    assert.equal(claudeSubscriptionConnected(process.env, claude), true, 'sign in with use-my-llm claude-auth connect first');
    const before = claudeOriginalHash();
    const root = mkdtempSync(join(tmpdir(), 'use-my-llm-real-session-'));
    const locations = { ...defaultLocations(), claudeHome: join(homedir(), '.claude'), dataDir: root };
    const store = createContextStore({ dataDir: root });
    t.after(() => {
      try { store.revokeOrigin(SITE); }
      finally {
        rmSync(root, { recursive: true, force: true });
        const after = claudeOriginalHash();
        assert.deepEqual(after, before, 'all original Claude files are byte-for-byte unchanged, including after failure');
        t.diagnostic(`Original Claude SHA-256 before=${before.digest} after=${after.digest}, files=${after.count}.`);
      }
    });
    const sessions = listSources(locations, { apps: ['claude-code'] }).items.filter(item => item.kind === 'session');
    let meta;
    for (const item of sessions) {
      try { meta = share({ origin: SITE, ref: item.ref, fork: true }, { locations, store }).meta; break; }
      catch (error) { if (!['SELECTION_TOO_LARGE', 'NOT_FORKABLE'].includes(error.code)) throw error; }
    }
    assert.ok(meta, 'a readable real Claude session must exist');
    const [{ fork }] = store.resolve(SITE, [meta.handle]);
    const registry = createProviderRegistry();
    const { reply } = await registry.runProvider({ provider: 'claude', fork, history: [],
      message: 'Reply with exactly CLAUDE_COPY_OK and nothing else.' });
    assert.ok(reply.trim() === 'CLAUDE_COPY_OK', 'the reply must contain only the expected verification marker');
    assert.deepEqual(claudeOriginalHash(), before, 'all original Claude files are byte-for-byte unchanged');
    store.revokeOrigin(SITE);
    assert.throws(() => store.resolve(SITE, [meta.handle]), { code: 'CONTEXT_DENIED' });
    t.diagnostic('Real approved session copy returned the expected verification marker through the bridge provider registry.');
  });
