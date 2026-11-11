/**
 * `use-my-llm context …`: the local control surface for shared context.
 *
 * It runs as the local user, never over the network. The menu-bar picker
 * calls these subcommands with `--json`; `context pick` is the interactive
 * fallback for people who run the bridge from a terminal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { agyAcpAvailable, findAgy, listAntigravityAcpSessions, spawnAgyAcp } from '../providers/antigravity.mjs';
import { parseOrigin } from '../server.mjs';
import { CONSENT_LINES, planShare, share, type ShareOptions, type SharePlan } from './service.mjs';
import { importClaudeExport } from './sources/claude-desktop.mjs';
import { defaultLocations, listSources, loadSource, type SourceLocations } from './sources/index.mjs';
import { clip } from './sources/util.mjs';
import { createContextStore, type ContextStore } from './store.mjs';
import { ContextError, SOURCE_APPS, type SourceApp, type SourceItem } from './types.mjs';

export const CONTEXT_HELP = `use-my-llm context: share local conversations and memory with a website you choose

Usage:
  use-my-llm context pick                                   Interactive picker for a terminal
  use-my-llm context sources [--app APP] [--limit N] [--antigravity-acp] [--json]
  use-my-llm context preview --ref REF [--json]
  use-my-llm context plan  --origin ORIGIN --ref REF [--from N] [--to N] [--fork] [--label TEXT] [--json]
  use-my-llm context share --origin ORIGIN --ref REF [--from N] [--to N] [--fork] [--label TEXT] --yes [--json]
  use-my-llm context grants [--json]
  use-my-llm context revoke --origin ORIGIN [--snapshot ID] [--json]
  use-my-llm context enable|disable --origin ORIGIN
  use-my-llm context import-claude-export --file EXPORT.zip [--json]
  use-my-llm context log [--json]
  use-my-llm context consent [--json]

APP is one of: ${SOURCE_APPS.join(', ')}.
Nothing is shared until you run "share" (or approve in "pick"). Sharing is off for every website by default.
`;

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Present only for an interactive terminal. */
  ask?: (question: string) => Promise<string>;
  interactive: boolean;
}

interface Flags {
  values: Map<string, string>;
  switches: Set<string>;
}

const VALUE_FLAGS = new Set(['app', 'limit', 'ref', 'origin', 'from', 'to', 'label', 'snapshot', 'file']);
const SWITCH_FLAGS = new Set(['json', 'fork', 'yes', 'antigravity-acp']);

function usage(message: string): ContextError {
  return new ContextError('USAGE', message);
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { values: new Map(), switches: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) throw usage(`Unexpected argument: ${raw}`);
    const name = raw.slice(2);
    if (SWITCH_FLAGS.has(name)) flags.switches.add(name);
    else if (VALUE_FLAGS.has(name)) {
      const value = argv[index + 1];
      if (value === undefined) throw usage(`Missing value for --${name}.`);
      flags.values.set(name, value);
      index += 1;
    } else throw usage(`Unknown option: ${raw}`);
  }
  return flags;
}

function required(flags: Flags, name: string): string {
  const value = flags.values.get(name);
  if (!value) throw usage(`--${name} is required.`);
  return value;
}

function originOf(flags: Flags): string {
  const origin = parseOrigin(required(flags, 'origin'));
  if (!origin) throw usage('--origin must be an exact https origin, or http://localhost:<port> / http://127.0.0.1:<port>.');
  return origin;
}

function integer(flags: Flags, name: string): number | undefined {
  const value = flags.values.get(name);
  if (value === undefined) return undefined;
  if (!/^\d{1,7}$/.test(value)) throw usage(`--${name} must be a whole number.`);
  return Number(value);
}

function shareOptions(flags: Flags): ShareOptions {
  const from = integer(flags, 'from');
  const to = integer(flags, 'to');
  const label = flags.values.get('label');
  return {
    origin: originOf(flags),
    ref: required(flags, 'ref'),
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    ...(flags.switches.has('fork') && { fork: true }),
    ...(label !== undefined && { label }),
  };
}

/** What the picker shows for a plan. The redacted text is included so it can be reviewed. */
function planView(plan: SharePlan) {
  return {
    app: plan.app, kind: plan.kind, label: plan.label, bytes: plan.bytes, redactions: plan.redactions,
    redactionKinds: plan.redactionKinds, messageCount: plan.messageCount ?? null,
    from: plan.from ?? null, to: plan.to ?? null, provider: plan.provider ?? null, text: plan.text,
  };
}

async function acpItems(io: Io): Promise<SourceItem[]> {
  const executable = findAgy();
  if (!executable || !agyAcpAvailable(executable)) {
    io.err('This agy build has no "acp" subcommand, so Antigravity conversations cannot be listed for continuation.\n');
    return [];
  }
  const workspace = mkdtempSync(join(tmpdir(), 'use-my-llm-agy-list-'));
  try {
    const sessions = await listAntigravityAcpSessions({ transport: spawnAgyAcp(executable, workspace), cwd: workspace });
    return sessions.map((session) => ({
      ref: `antigravity:acp:${session.sessionId}`, app: 'antigravity' as const, kind: 'session' as const,
      project: session.cwd || 'ACP', title: session.title || 'Antigravity conversation', date: session.updatedAt,
      firstPrompt: '', preview: 'Continue through ACP. No local text is copied.', forkProvider: 'antigravity' as const,
    }));
  } catch {
    io.err('Antigravity did not return a conversation list through ACP.\n');
    return [];
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function sources(flags: Flags, locations: SourceLocations, io: Io): Promise<SourceItem[]> {
  const app = flags.values.get('app');
  if (app !== undefined && !SOURCE_APPS.some((id) => id === app)) throw usage(`--app must be one of: ${SOURCE_APPS.join(', ')}.`);
  const limit = integer(flags, 'limit');
  const listing = listSources(locations, {
    ...(app !== undefined && { apps: [app as SourceApp] }),
    ...(limit !== undefined && { limit }),
  });
  for (const failed of listing.failed) io.err(`Could not read ${failed} data. Other apps are still listed.\n`);
  const items = listing.items;
  if (flags.switches.has('antigravity-acp') && (app === undefined || app === 'antigravity')) {
    items.push(...await acpItems(io));
  }
  return items;
}

function describe(item: SourceItem): string {
  const date = item.date ? item.date.slice(0, 10) : '          ';
  const detail = item.firstPrompt && item.firstPrompt !== item.title ? ` — ${clip(item.firstPrompt, 60)}` : '';
  return `${date}  [${item.kind}] ${clip(item.title, 70)}${detail}`;
}

function grantsView(store: ContextStore) {
  // Handles and private fork details stay out of local listings too.
  return store.origins().map(({ origin, enabled, snapshots }) => ({
    origin,
    enabled,
    snapshots: snapshots.map(({ id, app, kind, label, createdAt, bytes, redactions, fork }) => ({
      id, app, kind, label, createdAt, bytes, redactions, provider: fork?.provider ?? null,
    })),
  }));
}

async function choose(ask: (question: string) => Promise<string>, io: Io, title: string, options: readonly string[]): Promise<number | null> {
  const PAGE = 20;
  let start = 0;
  for (;;) {
    io.out(`\n${title}\n`);
    options.slice(start, start + PAGE).forEach((option, index) => io.out(`  ${String(start + index + 1).padStart(3)}. ${option}\n`));
    const more = start + PAGE < options.length;
    const answer = (await ask(`Number${more ? ', "n" for more' : ''}${start ? ', "p" for previous' : ''}, or Enter to cancel: `)).trim().toLowerCase();
    if (!answer) return null;
    if (answer === 'n' && more) start += PAGE;
    else if (answer === 'p' && start) start -= PAGE;
    else if (/^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= options.length) return Number(answer) - 1;
    else io.out('Not one of the listed numbers.\n');
  }
}

/** Interactive picker for a terminal. Shares nothing unless the final question is answered "yes". */
async function pick(flags: Flags, locations: SourceLocations, store: ContextStore, io: Io): Promise<number> {
  const ask = io.ask;
  if (!io.interactive || !ask) {
    throw usage('"context pick" needs an interactive terminal. Use "context sources" and "context share" in scripts.');
  }
  io.out('Share local context with a website. Nothing leaves this computer until you confirm.\n');
  const known = store.origins().map(({ origin }) => origin);
  let origin: string | null = null;
  while (!origin) {
    const hint = known.length ? ` (already shared with: ${known.join(', ')})` : '';
    const answer = (await ask(`Website origin, for example https://app.example.com${hint}: `)).trim();
    if (!answer) return 1;
    origin = parseOrigin(answer);
    if (!origin) io.out('Enter an exact origin such as https://app.example.com or http://localhost:5173.\n');
  }

  const appIndex = await choose(ask, io, 'Which app?', SOURCE_APPS);
  if (appIndex === null) return 1;
  flags.values.set('app', SOURCE_APPS[appIndex]);
  const items = await sources(flags, locations, io);
  if (!items.length) {
    io.out('Nothing to share was found for this app.\n');
    return 1;
  }
  const projects = [...new Set(items.map((item) => item.project || '(no project)'))];
  const projectIndex = projects.length > 1 ? await choose(ask, io, 'Which project?', projects) : 0;
  if (projectIndex === null) return 1;
  const inProject = items.filter((item) => (item.project || '(no project)') === projects[projectIndex]);
  const itemIndex = await choose(ask, io, 'Which item?', inProject.map(describe));
  if (itemIndex === null) return 1;
  const item = inProject[itemIndex];

  const options: ShareOptions = { origin, ref: item.ref };
  const isAcp = item.ref.startsWith('antigravity:acp:');
  const loaded = isAcp ? undefined : loadSource(item.ref, locations);
  if (isAcp) options.fork = true;
  if (loaded?.messages) {
    io.out(`\n${loaded.messages.length} messages:\n`);
    loaded.messages.forEach((message, index) => io.out(`  ${String(index + 1).padStart(3)}. ${message.role.padEnd(9)} ${clip(message.text, 90)}\n`));
    const forkHint = loaded.fork ? ', or "fork" to let the site continue the whole session as a copy' : '';
    for (;;) {
      const answer = (await ask(`Range such as 3-10, "all"${forkHint}: `)).trim().toLowerCase();
      if (!answer) return 1;
      const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(answer);
      if (answer === 'fork' && loaded.fork) options.fork = true;
      else if (match) Object.assign(options, { from: Number(match[1]), to: Number(match[2] ?? match[1]) });
      else if (answer !== 'all') {
        io.out('Enter a range, "all"' + (loaded.fork ? ' or "fork"' : '') + '.\n');
        continue;
      }
      break;
    }
  }

  const plan = planShare(options, locations);
  io.out(`\nThis will be shared with ${origin}:\n  ${plan.label}\n`);
  if (plan.kind === 'fork') {
    io.out(`  The site can continue this whole ${plan.messageCount ?? ''} message conversation through ${plan.provider}, as a copy.\n`);
    if (plan.provider === 'claude') {
      io.out('  Continuing uses your ANTHROPIC_API_KEY only. A Claude subscription login is never used.\n');
    }
  } else {
    io.out(`  ${plan.bytes} bytes${plan.redactions ? `, ${plan.redactions} secret-like value${plan.redactions === 1 ? '' : 's'} redacted` : ''}\n\n`);
    io.out(`${plan.text.length > 1500 ? `${plan.text.slice(0, 1500)}\n… (${plan.text.length - 1500} more characters)` : plan.text}\n`);
  }
  io.out(`\n${CONSENT_LINES.map((line) => `  • ${line}`).join('\n')}\n\n`);
  if ((await ask('Type "yes" to share: ')).trim().toLowerCase() !== 'yes') {
    io.out('Nothing was shared.\n');
    return 1;
  }
  const { meta } = share(options, { locations, store });
  io.out(`Shared. Revoke any time with: use-my-llm context revoke --origin ${origin}\n(snapshot ${meta.id})\n`);
  return 0;
}

/** Run one `context` subcommand. Returns the process exit code. */
export async function runContextCommand(
  argv: readonly string[],
  {
    io: output, locations = defaultLocations(), store = createContextStore({ dataDir: locations.dataDir }),
  }: { io?: Partial<Io>; locations?: SourceLocations; store?: ContextStore } = {},
): Promise<number> {
  let reader: Interface | undefined;
  const interactive = output?.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const io: Io = {
    out: output?.out ?? ((text) => { process.stdout.write(text); }),
    err: output?.err ?? ((text) => { process.stderr.write(text); }),
    interactive,
    ask: output?.ask ?? (interactive
      ? (question) => (reader ??= createInterface({ input: process.stdin, output: process.stdout })).question(question)
      : undefined),
  };
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      io.out(CONTEXT_HELP);
      return 0;
    }
    const flags = parseFlags(rest);
    const json = flags.switches.has('json');
    const print = (value: unknown, text: () => string) => io.out(json ? `${JSON.stringify(value)}\n` : text());

    if (command === 'pick') return await pick(flags, locations, store, io);

    if (command === 'consent') {
      print({ lines: CONSENT_LINES }, () => `${CONSENT_LINES.join('\n')}\n`);
    } else if (command === 'sources') {
      const items = await sources(flags, locations, io);
      print({ items }, () => items.length
        ? `${items.map((item) => `${item.app.padEnd(15)} ${describe(item)}\n    ${item.ref}`).join('\n')}\n`
        : 'Nothing to share was found.\n');
    } else if (command === 'preview') {
      const loaded = loadSource(required(flags, 'ref'), locations);
      // A preview is a local view of the user's own data. It is not redacted and not stored.
      print({
        item: loaded.item,
        forkProvider: loaded.fork?.provider ?? null,
        messages: loaded.messages?.map((message, index) => ({ index: index + 1, ...message })) ?? null,
        text: loaded.text ?? null,
      }, () => loaded.messages
        ? `${loaded.messages.map((message, index) => `${String(index + 1).padStart(3)}. ${message.role}: ${clip(message.text, 200)}`).join('\n')}\n`
        : `${loaded.text ?? ''}\n`);
    } else if (command === 'plan') {
      const plan = planShare(shareOptions(flags), locations);
      print({ plan: planView(plan), consent: CONSENT_LINES }, () =>
        `${plan.label}\n${plan.bytes} bytes, ${plan.redactions} redaction(s)\n\n${plan.text}\n\n${CONSENT_LINES.join('\n')}\n`);
    } else if (command === 'share') {
      const options = shareOptions(flags);
      if (!flags.switches.has('yes')) {
        if (!io.interactive || !io.ask) throw usage('Sharing needs explicit approval. Show the consent text, then pass --yes.');
        const plan = planShare(options, locations);
        io.out(`Share "${plan.label}" (${plan.bytes} bytes) with ${options.origin}?\n${CONSENT_LINES.map((line) => `  • ${line}`).join('\n')}\n`);
        if ((await io.ask('Type "yes" to share: ')).trim().toLowerCase() !== 'yes') {
          io.out('Nothing was shared.\n');
          return 1;
        }
      }
      const { meta, plan } = share(options, { locations, store });
      print({
        shared: { id: meta.id, origin: options.origin, app: meta.app, kind: meta.kind, label: meta.label, bytes: meta.bytes, redactions: meta.redactions, provider: plan.provider ?? null },
      }, () => `Shared "${meta.label}" with ${options.origin} (snapshot ${meta.id}).\n`);
    } else if (command === 'grants') {
      const grants = grantsView(store);
      print({ origins: grants }, () => grants.length
        ? `${grants.map((grant) => `${grant.origin}${grant.enabled ? '' : ' (sharing off)'}\n${grant.snapshots.map((snapshot) => `  ${snapshot.id}  ${snapshot.label}  ${snapshot.bytes} bytes`).join('\n')}`).join('\n')}\n`
        : 'Nothing is shared with any website.\n');
    } else if (command === 'revoke') {
      const origin = originOf(flags);
      const snapshot = flags.values.get('snapshot');
      const revoked = snapshot === undefined ? store.revokeOrigin(origin) : store.revokeSnapshot(origin, snapshot);
      print({ revoked }, () => revoked ? 'Revoked. The snapshots and any conversation copies were deleted.\n' : 'Nothing was shared there.\n');
    } else if (command === 'enable' || command === 'disable') {
      const changed = store.setEnabled(originOf(flags), command === 'enable');
      print({ changed }, () => changed ? `Sharing is now ${command === 'enable' ? 'on' : 'off'} for this website.\n` : 'Nothing was shared there.\n');
    } else if (command === 'import-claude-export') {
      const file = required(flags, 'file');
      if (!isAbsolute(file)) throw usage('--file must be an absolute path.');
      const summary = importClaudeExport(file, locations);
      print({ imported: summary }, () =>
        `Imported ${summary.conversations} conversation(s), ${summary.memories} memory item(s) and ${summary.documents} document(s).\n`);
    } else if (command === 'log') {
      const entries = store.readLog();
      print({ entries }, () => entries.length
        ? `${entries.map((entry) => `${entry.ts}  ${entry.origin}  ${entry.provider}  ${entry.snapshot}  ${entry.bytes} bytes`).join('\n')}\n`
        : 'No shared context has been used.\n');
    } else {
      throw usage(`Unknown context command: ${command}`);
    }
    return 0;
  } catch (error) {
    // Messages here are written by this program. Raw file-system errors are not echoed.
    const message = error instanceof ContextError
      ? error.message
      : error instanceof Error && typeof (error as { code?: unknown }).code !== 'string'
        ? error.message
        : error instanceof Error && ['INVALID_ZIP', 'INVALID_EXPORT'].includes(String((error as { code?: unknown }).code))
          ? error.message
          : 'The request could not be completed.';
    if (argv.includes('--json')) io.out(`${JSON.stringify({ error: { code: error instanceof ContextError ? error.code : 'FAILED', message } })}\n`);
    else io.err(`${message}\n`);
    return error instanceof ContextError && error.code === 'USAGE' ? 2 : 1;
  } finally {
    reader?.close();
  }
}
