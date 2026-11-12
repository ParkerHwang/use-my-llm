/**
 * Shared types and limits for user-selected local context (protocol v1.1).
 *
 * Nothing in this module is reachable from a website. Websites only ever see
 * the opaque handle and coarse metadata in {@link PublicContext}.
 */

export type SourceApp = 'codex' | 'claude-code' | 'claude-desktop' | 'antigravity';
export type SourceKind = 'session' | 'memory' | 'instructions' | 'knowledge';
export type SnapshotKind = 'messages' | 'memory' | 'instructions' | 'knowledge' | 'fork';
export type ForkProvider = 'codex' | 'claude' | 'antigravity';

export const SOURCE_APPS: readonly SourceApp[] = ['codex', 'claude-code', 'claude-desktop', 'antigravity'];

/** One snapshot may hold at most this much redacted text. */
export const MAX_SNAPSHOT_BYTES = 200_000;
/** One request may reference at most this many handles and this much text. */
export const MAX_CONTEXT_HANDLES = 8;
export const MAX_CONTEXT_BYTES = 400_000;
export const HANDLE_PATTERN = /^ctx_[A-Za-z0-9_-]{43}$/;

export interface SourceMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

/** A selectable local item. `ref` is a local-only reference and may contain a path. */
export interface SourceItem {
  ref: string;
  app: SourceApp;
  kind: SourceKind;
  /** Display grouping, usually the working directory or project name. */
  project: string;
  title: string;
  /** ISO 8601 timestamp when known. */
  date: string | null;
  firstPrompt: string;
  preview: string;
  /** A provider that can continue this session as a copy, when one exists. */
  forkProvider?: ForkProvider;
}

export interface LoadedSource {
  item: SourceItem;
  /** Present for sessions. */
  messages?: SourceMessage[];
  /** Present for memory, instruction and knowledge items. */
  text?: string;
  /** Local-only details needed to continue the session as a copy. */
  fork?: ForkSeed;
}

/** What a reader knows about a forkable session before the user approves anything. */
export type ForkSeed =
  | { provider: 'codex' }
  | { provider: 'claude' }
  | { provider: 'antigravity' };

/** Private fork details kept with a grant. Never sent to a website. */
export type ForkRecord =
  | { provider: 'codex' }
  | { provider: 'claude'; sessionId: string; configDir: string; cwd: string }
  | { provider: 'antigravity' };

/** The only context shape a provider adapter receives. */
export interface ContextEntry {
  /** Coarse label such as `codex:messages`. Never a path, id or thread name. */
  source: string;
  text: string;
}

/** The only context metadata a website receives. */
export interface PublicContext {
  handle: string;
  app: SourceApp;
  kind: SnapshotKind;
  label: string;
  bytes: number;
  createdAt: string;
  /** Present on fork handles: the only provider that can continue it. */
  provider?: ForkProvider;
}

export interface ResolvedContext {
  /** Snapshot id for the access log. Not the handle. */
  id: string;
  kind: SnapshotKind;
  entry: ContextEntry;
  bytes: number;
  fork?: ForkRecord;
}

export class ContextError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
