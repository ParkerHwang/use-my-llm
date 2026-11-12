/**
 * Turns a local selection into a per-website grant.
 *
 * `planShare` reads and redacts but writes nothing, so the picker can show
 * exactly what would be stored. `share` is the single place where selected
 * text leaves an app's own files, and it runs only after explicit approval.
 */
import { prepareClaudeFork } from './fork.mjs';
import { redactSecrets } from './redact.mjs';
import { loadSource, type SourceLocations } from './sources/index.mjs';
import { renderMessages } from './sources/util.mjs';
import { sha256, type ContextStore, type SnapshotMeta } from './store.mjs';
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
  /** Redacted text that would be stored. */
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
  messages?: SourceMessage[];
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

function redactMessages(messages: readonly SourceMessage[]) {
  const kinds = new Set<string>();
  let count = 0;
  const redacted = messages.map((message) => {
    const result = redactSecrets(message.text);
    count += result.count;
    for (const kind of result.kinds) kinds.add(kind);
    return { ...message, text: result.text };
  });
  return { messages: redacted, text: renderMessages(redacted), count, kinds: [...kinds].sort() };
}

function prepare(options: ShareOptions, locations: SourceLocations): Prepared {
  if (options.ref.startsWith(ACP_REF)) {
    throw new ContextError('NOT_FORKABLE', 'Live ACP sessions cannot be shared. Choose a local transcript to share a frozen copy.');
  }
  const loaded = loadSource(options.ref, locations);
  const { item } = loaded;
  const name = APP_NAMES[item.app];
  if (options.fork) {
    if (!loaded.fork || !loaded.messages?.length) {
      throw new ContextError('NOT_FORKABLE', 'This item cannot be continued as a copy.');
    }
    if (options.from !== undefined || options.to !== undefined) {
      throw new ContextError('INVALID_RANGE', 'A conversation copy includes the whole conversation.');
    }
    const { messages, text, count, kinds } = redactMessages(loaded.messages);
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_SNAPSHOT_BYTES) {
      throw new ContextError('SELECTION_TOO_LARGE', 'This conversation is too large to copy. Share a message range instead.');
    }
    return {
      plan: {
        app: item.app, kind: 'fork', label: cleanLabel(options.label, `${name} conversation (continue as a copy)`),
        text, bytes, redactions: count, redactionKinds: kinds, messageCount: messages.length,
        provider: loaded.fork.provider, item,
      },
      seed: loaded.fork,
      messages,
    };
  }

  let redacted: ReturnType<typeof redactSecrets>;
  let kind: SnapshotKind;
  let fallback: string;
  let selection: Pick<SharePlan, 'messageCount' | 'from' | 'to'> = {};
  if (loaded.messages) {
    if (!loaded.messages.length) throw new ContextError('EMPTY_SELECTION', 'This conversation has no readable messages.');
    const [first, last] = range(loaded.messages, options.from, options.to);
    redacted = redactMessages(loaded.messages.slice(first - 1, last));
    kind = 'messages';
    selection = { messageCount: last - first + 1, from: first, to: last };
    fallback = `${name} conversation excerpt (${selection.messageCount} message${selection.messageCount === 1 ? '' : 's'})`;
  } else {
    redacted = redactSecrets(loaded.text ?? '');
    kind = item.kind === 'session' ? 'messages' : item.kind;
    fallback = `${name} ${kind === 'messages' ? 'conversation summary' : kind}`;
  }
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

/** Binds approval to the target and the text shown in the review. */
export function shareFingerprint(options: ShareOptions, plan: SharePlan): string {
  return sha256(JSON.stringify([options.origin, options.ref, plan.kind, plan.label, plan.text]));
}

/** Store the approved selection for one website. Call only after explicit approval. */
export function share(
  options: ShareOptions,
  { locations, store, expected }: { locations: SourceLocations; store: ContextStore; expected?: string },
): { meta: SnapshotMeta; plan: SharePlan } {
  const { plan, seed, messages } = prepare(options, locations);
  if (expected !== undefined && shareFingerprint(options, plan) !== expected) {
    throw new ContextError('SELECTION_CHANGED', 'The selection changed. Review it again before sharing.');
  }
  const meta = store.grant(options.origin, {
    app: plan.app,
    kind: plan.kind,
    label: plan.label,
    text: plan.text,
    redactions: plan.redactions,
    ...(seed && {
      prepareFork: (directory: string) => seed.provider === 'claude'
        ? prepareClaudeFork(messages ?? [], directory)
        : { record: seed },
    }),
  });
  return { meta, plan };
}
