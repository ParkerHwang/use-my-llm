/**
 * Prepare bridge-only material for continuing a shared session as a copy.
 *
 * Everything here runs once, when the user approves. Afterwards the provider
 * adapters work only from what was recorded or copied at that moment.
 */
import { chmodSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactDeep } from './redact.mjs';
import { isRecord, jsonLines, readText } from './sources/util.mjs';
import { ContextError, type ForkRecord, type ForkSeed } from './types.mjs';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Records without a place in the message chain that a resumed copy still uses.
const KEPT_WITHOUT_UUID = new Set(['summary', 'custom-title', 'ai-title']);
// Attachments that hold account identifiers rather than conversation content.
const SCRUBBED_ATTACHMENTS = new Set(['session_context', 'credential_org']);

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Not supported on every platform. */ }
}

/** Claude Code names a project directory after its working directory. */
export function claudeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Copy one Claude Code session into a `CLAUDE_CONFIG_DIR` that only the bridge
 * uses for this website. Secrets are redacted, account records are dropped,
 * and the copy is rebased onto an empty bridge-only working directory.
 */
export function prepareClaudeFork(sourcePath: string, sessionId: string, directory: string): {
  record: Extract<ForkRecord, { provider: 'claude' }>;
  bytes: number;
  redactions: number;
} {
  if (!SESSION_ID.test(sessionId)) throw new ContextError('INVALID_REFERENCE', 'This session cannot be continued.');
  const raw = readText(sourcePath);
  if (raw === null) throw new ContextError('INVALID_REFERENCE', 'This session cannot be read.');
  const workspace = join(directory, 'workspace');
  privateDir(workspace);
  const cwd = realpathSync(workspace);
  const configDir = join(directory, 'claude-config');
  const project = join(configDir, 'projects', claudeProjectName(cwd));
  privateDir(configDir);
  privateDir(join(configDir, 'projects'));
  privateDir(project);

  const tally = { count: 0 };
  const lines: string[] = [];
  for (const line of jsonLines(raw)) {
    if (!isRecord(line) || line.isSidechain === true) continue;
    if (typeof line.uuid !== 'string' && !KEPT_WITHOUT_UUID.has(String(line.type))) continue;
    const copy = redactDeep(line, tally) as Record<string, unknown>;
    if (typeof copy.cwd === 'string') copy.cwd = cwd;
    if (isRecord(copy.attachment) && SCRUBBED_ATTACHMENTS.has(String(copy.attachment.type))) {
      copy.attachment = { type: copy.attachment.type };
      delete copy.rendered;
    }
    lines.push(JSON.stringify(copy));
  }
  if (!lines.length) throw new ContextError('EMPTY_SELECTION', 'This session has nothing to continue.');
  const body = `${lines.join('\n')}\n`;
  writeFileSync(join(project, `${sessionId}.jsonl`), body, { mode: 0o600, flag: 'wx' });
  return { record: { provider: 'claude', sessionId, configDir, cwd }, bytes: Buffer.byteLength(body), redactions: tally.count };
}

/**
 * Record what identifies a Codex session for `codex exec fork`. The rollout is
 * not copied: the Codex CLI resolves the id itself, with `--ephemeral`. Size
 * and modification time let the adapter refuse a session that changed later.
 */
export function prepareCodexFork(seed: Extract<ForkSeed, { provider: 'codex' }>): {
  record: Extract<ForkRecord, { provider: 'codex' }>;
  bytes: number;
} {
  if (!SESSION_ID.test(seed.sessionId)) throw new ContextError('INVALID_REFERENCE', 'This session cannot be continued.');
  let stats;
  try {
    stats = statSync(seed.path);
  } catch {
    throw new ContextError('INVALID_REFERENCE', 'This session cannot be read.');
  }
  return {
    record: { provider: 'codex', sessionId: seed.sessionId, path: seed.path, size: stats.size, mtimeMs: stats.mtimeMs },
    bytes: stats.size,
  };
}
