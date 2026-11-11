/**
 * Turns a local selection into a per-website grant.
 *
 * `planShare` reads and redacts but writes nothing, so the picker can show
 * exactly what would be stored. `share` is the single place where selected
 * text leaves an app's own files, and it runs only after explicit approval.
 */
import { prepareClaudeFork, prepareCodexFork } from './fork.mjs';
import { redactSecrets } from './redact.mjs';
import { loadSource, type SourceLocations } from './sources/index.mjs';
import { renderMessages } from './sources/util.mjs';
import type { ContextStore, SnapshotMeta } from './store.mjs';
import {
  ContextError, MAX_SNAPSHOT_BYTES,
  type ForkProvider, type ForkSeed, type SnapshotKind, type SourceApp, type SourceItem, type SourceMessage,
} from './types.mjs';

/** Shown, in full, before anything is shared. The picker and the terminal use the same text. */
export const CONSENT_LINES: readonly string[] = [
  'The site can read whatever you share.',
  'If you send it to a different provider, the content goes to that company. '
    + 'For example, sending a Claude conversation through Codex sends it to OpenAI.',
  'Known secret formats are redacted first, but redaction is best effort. Review the preview before sharing.',
];

const APP_NAMES: Record<SourceApp, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  antigravity: 'Antigravity',
};

const ACP_REF = 'antigravity:acp:';

export interface ShareOptions {
  origin: string;
  ref: string;
  /** 1-based inclusive message range. Defaults to the whole conversation. */
  from?: number;
  to?: number;
  /** Share the whole session as a copy the provider can continue. */
  fork?: boolean;
  /** Optional name the website will see instead of the generic one. */
  label?: string;
}

export interface SharePlan {
  app: SourceApp;
  kind: SnapshotKind;
  /** What the website will see. Never a thread name, session id or path. */
  label: string;
  /** Redacted text that would be stored. Empty for a continuable copy. */
  text: string;
  bytes: number;
  redactions: number;
  redactionKinds: string[];
  messageCount?: number;
  from?: number;
  to?: number;
  provider?: ForkProvider;
  /** Local display details for the picker only. */
  item: SourceItem;
}

interface Prepared {
  plan: SharePlan;
  seed?: ForkSeed;
}

function cleanLabel(label: string | undefined, fallback: string): string {
  const cleaned = (label ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  return cleaned || fallback;
}

function range(messages: readonly SourceMessage[], from: number | undefined, to: number | undefined): [number, number] {
  const first = from ?? 1;
  const last = to ?? messages.length;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > messages.length) {
    throw new ContextError('INVALID_RANGE', `Pick a message range between 1 and ${messages.length}.`);
  }
  return [first, last];
}

function prepare(options: ShareOptions, locations: SourceLocations): Prepared {
  if (options.ref.startsWith(ACP_REF)) {
    // Listed through ACP: there is no local text, only a conversation to continue.
    const sessionId = options.ref.slice(ACP_REF.length);
    if (!options.fork || !sessionId || sessionId.length > 1024) {
      throw new ContextError('INVALID_REFERENCE', 'An ACP conversation can only be shared as a continuable copy.');
    }
    const item: SourceItem = {
      ref: options.ref, app: 'antigravity', kind: 'session', project: 'ACP', title: 'Antigravity conversation',
      date: null, firstPrompt: '', preview: '', forkProvider: 'antigravity',
    };
    return {
      plan: {
        app: 'antigravity', kind: 'fork', label: cleanLabel(options.label, 'Antigravity conversation (continue)'),
        text: '', bytes: 0, redactions: 0, redactionKinds: [], provider: 'antigravity', item,
      },
      seed: { provider: 'antigravity', sessionId },
    };
  }

  const loaded = loadSource(options.ref, locations);
  const { item } = loaded;
  const name = APP_NAMES[item.app];
  if (options.fork) {
    if (!loaded.fork || !loaded.messages?.length) {
      throw new ContextError('NOT_FORKABLE', 'This item cannot be continued as a copy.');
    }
    return {
      plan: {
        app: item.app, kind: 'fork', label: cleanLabel(options.label, `${name} conversation (continue as a copy)`),
        text: '', bytes: 0, redactions: 0, redactionKinds: [], messageCount: loaded.messages.length,
        provider: loaded.fork.provider, item,
      },
      seed: loaded.fork,
    };
  }

  let raw: string;
  let kind: SnapshotKind;
  let fallback: string;
  let selection: Pick<SharePlan, 'messageCount' | 'from' | 'to'> = {};
  if (loaded.messages) {
    if (!loaded.messages.length) throw new ContextError('EMPTY_SELECTION', 'This conversation has no readable messages.');
    const [first, last] = range(loaded.messages, options.from, options.to);
    raw = renderMessages(loaded.messages.slice(first - 1, last));
    kind = 'messages';
    selection = { messageCount: last - first + 1, from: first, to: last };
    fallback = `${name} conversation excerpt (${selection.messageCount} message${selection.messageCount === 1 ? '' : 's'})`;
  } else {
    raw = loaded.text ?? '';
    kind = item.kind === 'session' ? 'messages' : item.kind;
    fallback = `${name} ${kind === 'messages' ? 'conversation summary' : kind}`;
  }
  const redacted = redactSecrets(raw);
  const bytes = Buffer.byteLength(redacted.text);
  if (!redacted.text.trim()) throw new ContextError('EMPTY_SELECTION', 'The selection is empty.');
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new ContextError('SELECTION_TOO_LARGE', `The selection is ${bytes} bytes. The limit is ${MAX_SNAPSHOT_BYTES}. Pick a smaller range.`);
  }
  return {
    plan: {
      app: item.app, kind, label: cleanLabel(options.label, fallback), text: redacted.text, bytes,
      redactions: redacted.count, redactionKinds: redacted.kinds, ...selection, item,
    },
  };
}

/** Read and redact the selection without storing anything. */
export function planShare(options: ShareOptions, locations: SourceLocations): SharePlan {
  return prepare(options, locations).plan;
}

/** Store the approved selection for one website. Call only after explicit approval. */
export function share(
  options: ShareOptions,
  { locations, store }: { locations: SourceLocations; store: ContextStore },
): { meta: SnapshotMeta; plan: SharePlan } {
  const { plan, seed } = prepare(options, locations);
  const meta = store.grant(options.origin, {
    app: plan.app,
    kind: plan.kind,
    label: plan.label,
    text: plan.text,
    redactions: plan.redactions,
    ...(seed && {
      prepareFork: (directory: string) => {
        if (seed.provider === 'codex') return prepareCodexFork(seed);
        if (seed.provider === 'claude') return prepareClaudeFork(seed.path, seed.sessionId, directory);
        return { record: { provider: 'antigravity' as const, sessionId: seed.sessionId } };
      },
    }),
  });
  return { meta, plan };
}
