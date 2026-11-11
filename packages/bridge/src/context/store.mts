/**
 * Per-website permission store for user-selected context.
 *
 * Layout under `<dataDir>/context` (directories 0700, files 0600):
 *   grants.json                       per-origin list of snapshot metadata
 *   snapshots/<originKey>/<id>.json   redacted read-only snapshot text
 *   forks/<originKey>/<id>/           bridge-only material for a continued copy
 *   access.jsonl                      timestamp, origin, provider, snapshot, bytes
 *
 * A text snapshot keeps no reference to the file it was taken from, and
 * nothing here re-reads an original after approval. The one recorded path is
 * a Codex session shared as a continuable copy: the Codex CLI resolves that
 * session by id, and the adapter compares only its size and modification
 * time so later additions are refused rather than shared.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  ContextError, HANDLE_PATTERN, MAX_CONTEXT_BYTES, MAX_CONTEXT_HANDLES, MAX_SNAPSHOT_BYTES,
  type ForkRecord, type PublicContext, type ResolvedContext, type SnapshotKind, type SourceApp,
} from './types.mjs';

const GRANTS_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 10_000;

export interface SnapshotMeta {
  id: string;
  handle: string;
  app: SourceApp;
  kind: SnapshotKind;
  label: string;
  createdAt: string;
  bytes: number;
  sha256: string;
  redactions: number;
  fork?: ForkRecord;
}

interface OriginGrant {
  enabled: boolean;
  snapshots: SnapshotMeta[];
}

interface GrantsFile {
  version: number;
  origins: Record<string, OriginGrant>;
}

export interface GrantInput {
  app: SourceApp;
  kind: SnapshotKind;
  label: string;
  /** Already redacted text. */
  text: string;
  redactions?: number;
  /**
   * Called with a new bridge-only directory before the grant is recorded.
   * Returns the private fork details to keep with the grant, and the size
   * of what will be continued.
   */
  prepareFork?: (directory: string) => { record: ForkRecord; bytes?: number; redactions?: number };
}

export interface AccessLogEntry {
  ts: string;
  origin: string;
  provider: string;
  snapshot: string;
  bytes: number;
}

export interface ContextStore {
  readonly directory: string;
  grant(origin: string, input: GrantInput): SnapshotMeta;
  /** Metadata a website may see. Empty when sharing is off for the origin. */
  list(origin: string): PublicContext[];
  /** Resolve handles for exactly this origin, or throw `CONTEXT_DENIED`. */
  resolve(origin: string, handles: readonly string[]): ResolvedContext[];
  /** Local view for the menu and CLI. */
  origins(): Array<{ origin: string; enabled: boolean; snapshots: SnapshotMeta[] }>;
  setEnabled(origin: string, enabled: boolean): boolean;
  revokeSnapshot(origin: string, id: string): boolean;
  /** Deletes the origin's snapshots and fork material together. */
  revokeOrigin(origin: string): boolean;
  logAccess(entry: Omit<AccessLogEntry, 'ts'>): void;
  readLog(limit?: number): AccessLogEntry[];
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LOCALHOSTAGENT_DATA_DIR;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new ContextError('INVALID_DATA_DIR', 'LOCALHOSTAGENT_DATA_DIR must be an absolute path.');
    return configured;
  }
  return join(homedir(), '.use-my-llm');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function originKey(origin: string): string {
  return createHash('sha256').update(origin, 'utf8').digest('hex').slice(0, 32);
}

function token(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // mkdir honours the umask and leaves existing directories unchanged.
  try { chmodSync(path, 0o700); } catch { /* Not supported on every platform. */ }
}

function writePrivate(path: string, data: string): void {
  const temporary = `${path}.${token(6)}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function denied(): ContextError {
  // One message for unknown, revoked, disabled and other-origin handles.
  return new ContextError('CONTEXT_DENIED', 'This context is not shared with this website.');
}

export function createContextStore({
  dataDir = defaultDataDir(),
  now = Date.now,
}: { dataDir?: string; now?: () => number } = {}): ContextStore {
  if (!isAbsolute(dataDir)) throw new ContextError('INVALID_DATA_DIR', 'The data directory must be an absolute path.');
  const directory = join(dataDir, 'context');
  const grantsPath = join(directory, 'grants.json');
  const lockPath = join(directory, 'grants.lock');
  const logPath = join(directory, 'access.jsonl');
  const snapshotDir = (origin: string) => join(directory, 'snapshots', originKey(origin));
  const forkDir = (origin: string) => join(directory, 'forks', originKey(origin));

  function ensure(): void {
    privateDir(dataDir);
    privateDir(directory);
  }

  function read(): GrantsFile {
    let raw: string;
    try {
      raw = readFileSync(grantsPath, 'utf8');
    } catch {
      return { version: GRANTS_VERSION, origins: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A damaged grants file shares nothing.
      return { version: GRANTS_VERSION, origins: {} };
    }
    if (!isRecord(parsed) || parsed.version !== GRANTS_VERSION || !isRecord(parsed.origins)) {
      return { version: GRANTS_VERSION, origins: {} };
    }
    const origins: Record<string, OriginGrant> = {};
    for (const [origin, grant] of Object.entries(parsed.origins)) {
      if (!isRecord(grant) || !Array.isArray(grant.snapshots)) continue;
      const snapshots = grant.snapshots.filter((item): item is SnapshotMeta =>
        isRecord(item) && typeof item.id === 'string' && ID_PATTERN.test(item.id)
        && typeof item.handle === 'string' && HANDLE_PATTERN.test(item.handle)
        && typeof item.sha256 === 'string' && typeof item.bytes === 'number'
        && typeof item.app === 'string' && typeof item.kind === 'string'
        && typeof item.label === 'string' && typeof item.createdAt === 'string');
      origins[origin] = { enabled: grant.enabled === true, snapshots };
    }
    return { version: GRANTS_VERSION, origins };
  }

  /** Serialise writers: the CLI, the menu-bar helper and the bridge are separate processes. */
  function update<Result>(change: (grants: GrantsFile) => Result): Result {
    ensure();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lockPath, 'wx', 0o600));
        break;
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
        } catch { /* The other writer just finished. */ }
        if (Date.now() > deadline) throw new ContextError('STORE_BUSY', 'The context store is busy. Try again.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      const grants = read();
      const result = change(grants);
      writePrivate(grantsPath, `${JSON.stringify(grants, null, 2)}\n`);
      return result;
    } finally {
      rmSync(lockPath, { force: true });
    }
  }

  function grant(origin: string, input: GrantInput): SnapshotMeta {
    const bytes = Buffer.byteLength(input.text);
    if (!input.text.trim() && input.kind !== 'fork') {
      throw new ContextError('EMPTY_SELECTION', 'The selection is empty.');
    }
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new ContextError('SELECTION_TOO_LARGE', `The selection is larger than ${MAX_SNAPSHOT_BYTES} bytes. Pick a smaller range.`);
    }
    ensure();
    const id = token(16);
    const meta: SnapshotMeta = {
      id,
      handle: `ctx_${token(32)}`,
      app: input.app,
      kind: input.kind,
      label: input.label.slice(0, 120),
      createdAt: new Date(now()).toISOString(),
      bytes,
      sha256: sha256(input.text),
      redactions: input.redactions ?? 0,
    };
    let forkPath: string | undefined;
    try {
      if (input.prepareFork) {
        privateDir(join(directory, 'forks'));
        privateDir(forkDir(origin));
        forkPath = join(forkDir(origin), id);
        privateDir(forkPath);
        const prepared = input.prepareFork(forkPath);
        meta.fork = prepared.record;
        meta.bytes = prepared.bytes ?? meta.bytes;
        meta.redactions += prepared.redactions ?? 0;
      }
      privateDir(join(directory, 'snapshots'));
      privateDir(snapshotDir(origin));
      writePrivate(join(snapshotDir(origin), `${id}.json`), JSON.stringify({
        id, origin, app: meta.app, kind: meta.kind, createdAt: meta.createdAt, sha256: meta.sha256, text: input.text,
      }));
      update((grants) => {
        const entry = grants.origins[origin] ?? { enabled: true, snapshots: [] };
        // Sharing something with a site is the explicit opt-in for that site.
        entry.enabled = true;
        entry.snapshots.push(meta);
        grants.origins[origin] = entry;
      });
    } catch (error) {
      rmSync(join(snapshotDir(origin), `${id}.json`), { force: true });
      if (forkPath) rmSync(forkPath, { recursive: true, force: true });
      throw error;
    }
    return meta;
  }

  function list(origin: string): PublicContext[] {
    const entry = read().origins[origin];
    if (!entry?.enabled) return [];
    return entry.snapshots.map((meta) => ({
      handle: meta.handle,
      app: meta.app,
      kind: meta.kind,
      label: meta.label,
      bytes: meta.bytes,
      createdAt: meta.createdAt,
      ...(meta.fork && { provider: meta.fork.provider }),
    }));
  }

  function resolve(origin: string, handles: readonly string[]): ResolvedContext[] {
    if (!Array.isArray(handles) || handles.length > MAX_CONTEXT_HANDLES + 1
      || new Set(handles).size !== handles.length
      || handles.some((handle) => typeof handle !== 'string' || !HANDLE_PATTERN.test(handle))) {
      throw denied();
    }
    if (!handles.length) return [];
    const entry = read().origins[origin];
    if (!entry?.enabled) throw denied();
    let total = 0;
    return handles.map((handle) => {
      // The lookup is scoped to this origin's own list, so a handle that
      // belongs to another website is indistinguishable from an unknown one.
      const meta = entry.snapshots.find((item) => item.handle === handle);
      if (!meta) throw denied();
      let text: unknown;
      try {
        const stored: unknown = JSON.parse(readFileSync(join(snapshotDir(origin), `${meta.id}.json`), 'utf8'));
        text = isRecord(stored) && stored.origin === origin ? stored.text : undefined;
      } catch {
        throw denied();
      }
      if (typeof text !== 'string' || sha256(text) !== meta.sha256) throw denied();
      total += meta.bytes;
      if (total > MAX_CONTEXT_BYTES) {
        throw new ContextError('CONTEXT_TOO_LARGE', 'The selected context is too large for one request.');
      }
      return {
        id: meta.id,
        kind: meta.kind,
        entry: { source: `${meta.app}:${meta.kind}`, text },
        bytes: meta.bytes,
        ...(meta.fork && { fork: meta.fork }),
      };
    });
  }

  function origins() {
    return Object.entries(read().origins).map(([origin, entry]) => ({ origin, ...entry }));
  }

  function setEnabled(origin: string, enabled: boolean): boolean {
    return update((grants) => {
      const entry = grants.origins[origin];
      if (!entry) return false;
      entry.enabled = enabled;
      return true;
    });
  }

  function revokeSnapshot(origin: string, id: string): boolean {
    if (!ID_PATTERN.test(id)) return false;
    const removed = update((grants) => {
      const entry = grants.origins[origin];
      const index = entry?.snapshots.findIndex((item) => item.id === id) ?? -1;
      if (!entry || index === -1) return false;
      entry.snapshots.splice(index, 1);
      return true;
    });
    if (removed) {
      rmSync(join(snapshotDir(origin), `${id}.json`), { force: true });
      rmSync(join(forkDir(origin), id), { recursive: true, force: true });
    }
    return removed;
  }

  function revokeOrigin(origin: string): boolean {
    const removed = update((grants) => {
      if (!grants.origins[origin]) return false;
      delete grants.origins[origin];
      return true;
    });
    // Remove the files even when the record was already gone.
    rmSync(snapshotDir(origin), { recursive: true, force: true });
    rmSync(forkDir(origin), { recursive: true, force: true });
    return removed;
  }

  function logAccess(entry: Omit<AccessLogEntry, 'ts'>): void {
    ensure();
    // Metadata only. Content, handles, labels and paths never reach this file.
    const line: AccessLogEntry = {
      ts: new Date(now()).toISOString(),
      origin: entry.origin,
      provider: entry.provider,
      snapshot: entry.snapshot,
      bytes: entry.bytes,
    };
    appendFileSync(logPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  function readLog(limit = 200): AccessLogEntry[] {
    let raw: string;
    try {
      raw = readFileSync(logPath, 'utf8');
    } catch {
      return [];
    }
    const entries: AccessLogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value) && typeof value.ts === 'string' && typeof value.origin === 'string'
          && typeof value.provider === 'string' && typeof value.snapshot === 'string'
          && typeof value.bytes === 'number') {
          entries.push({ ts: value.ts, origin: value.origin, provider: value.provider, snapshot: value.snapshot, bytes: value.bytes });
        }
      } catch { /* Skip a damaged line. */ }
    }
    return entries.slice(-limit);
  }

  return { directory, grant, list, resolve, origins, setEnabled, revokeSnapshot, revokeOrigin, logAccess, readLog };
}
