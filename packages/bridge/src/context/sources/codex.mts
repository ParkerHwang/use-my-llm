/**
 * Read-only reader for the Codex CLI's local data.
 *
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
 *   $CODEX_HOME/archived_sessions/rollout-*.jsonl[.zst]
 *   $CODEX_HOME/memories_v2/ or memories/   (Markdown files)
 *   $CODEX_HOME/AGENTS.md and <project>/AGENTS.md
 *
 * Only user and assistant message text is extracted. Reasoning, tool calls,
 * tool output and harness-injected context are left out.
 */
import { basename, isAbsolute, join } from 'node:path';
import type { LoadedSource, SourceItem, SourceMessage } from '../types.mjs';
import {
  clip, containedPath, entries, fileSize, firstUserPrompt, isRecord, isoDate, jsonLines,
  previewOf, readHead, readText, text,
} from './util.mjs';

const ROLLOUT = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[_-][0-9a-f-]+)?\.jsonl(?:\.zst)?$/;
const MEMORY_DIRS = ['memories_v2', 'memories'];
const SKIPPED_DIRS = new Set(['.git', '.codex-baseline', 'node_modules']);
// Text that the harness adds on the user's behalf rather than the user typing it.
const INJECTED = /^\s*<(?:environment_context|user_instructions|turn_aborted|permissions|system|collaboration_mode|user_shell_command|subagent_notification)\b|^\s*# AGENTS\.md/;

export interface CodexSourceOptions {
  codexHome: string;
  /** Sessions whose first prompt and working directory are read while listing. */
  detailLimit?: number;
  limit?: number;
}

interface RolloutFile {
  path: string;
  id: string;
  date: string | null;
}

interface ParsedRollout {
  id: string | null;
  cwd: string;
  date: string | null;
  messages: SourceMessage[];
}

function rolloutFiles(codexHome: string): RolloutFile[] {
  const found: RolloutFile[] = [];
  const visit = (directory: string, depth: number) => {
    for (const entry of entries(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3 && /^\d{2,4}$/.test(entry.name)) visit(path, depth + 1);
        continue;
      }
      const match = entry.isFile() ? ROLLOUT.exec(entry.name) : null;
      if (match) {
        found.push({ path, id: match[5], date: isoDate(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`) });
      }
    }
  };
  visit(join(codexHome, 'sessions'), 0);
  visit(join(codexHome, 'archived_sessions'), 0);
  return found.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

function contentText(content: unknown, onlyUserAuthored: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const provenance = Array.isArray(onlyUserAuthored) ? onlyUserAuthored : null;
  const parts: string[] = [];
  content.forEach((part, index) => {
    if (!isRecord(part) || typeof part.text !== 'string') return;
    if (!['input_text', 'output_text', 'text', 'Text'].includes(text(part.type))) return;
    // Newer rollouts label each content item. Keep only what the user wrote.
    const origin = provenance?.[index];
    if (isRecord(origin) && isRecord(origin.provenance) && typeof origin.provenance.type === 'string'
      && origin.provenance.type !== 'user') return;
    parts.push(part.text);
  });
  return parts.join('\n').trim();
}

export function parseRollout(raw: string): ParsedRollout {
  const result: ParsedRollout = { id: null, cwd: '', date: null, messages: [] };
  const fallback: SourceMessage[] = [];
  for (const line of jsonLines(raw)) {
    if (!isRecord(line)) continue;
    const payload = isRecord(line.payload) ? line.payload : undefined;
    const timestamp = isoDate(line.timestamp) ?? undefined;
    if (line.type === 'session_meta' && payload) {
      result.id ??= text(payload.id) || null;
      result.cwd ||= text(payload.cwd);
      result.date ??= isoDate(payload.timestamp) ?? timestamp ?? null;
    } else if (line.type === undefined && typeof line.id === 'string' && result.id === null) {
      // Early rollouts start with a bare metadata object.
      result.id = line.id;
      result.date = isoDate(line.timestamp);
    } else if (line.type === 'turn_context' && payload) {
      result.cwd ||= text(payload.cwd);
    } else if (line.type === 'response_item' && payload?.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const passthrough = isRecord(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough.content_item_metadata
        : undefined;
      const body = contentText(payload.content, role === 'user' ? passthrough : undefined);
      if (!body || (role === 'user' && INJECTED.test(body))) continue;
      result.messages.push({ role, text: body, ...(timestamp && { timestamp }) });
    } else if (line.type === 'event_msg' && payload) {
      const role = payload.type === 'user_message' ? 'user' : payload.type === 'agent_message' ? 'assistant' : null;
      const body = text(payload.message).trim();
      if (role && body && !(role === 'user' && INJECTED.test(body))) {
        fallback.push({ role, text: body, ...(timestamp && { timestamp }) });
      }
    }
  }
  if (!result.messages.length) result.messages = fallback;
  return result;
}

/** Thread names from the optional local index. Used only for display in the local picker. */
function threadNames(codexHome: string): Map<string, string> {
  const names = new Map<string, string>();
  const raw = readText(join(codexHome, 'session_index.jsonl'));
  if (raw === null) return names;
  for (const line of jsonLines(raw)) {
    if (isRecord(line) && typeof line.id === 'string' && typeof line.thread_name === 'string') {
      names.set(line.id, line.thread_name);
    }
  }
  return names;
}

function memoryFiles(root: string, depth = 0): string[] {
  const files: string[] = [];
  for (const entry of entries(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < 3 && !SKIPPED_DIRS.has(entry.name)) files.push(...memoryFiles(path, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
}

function textItem(ref: string, kind: 'memory' | 'instructions', project: string, path: string): SourceItem | null {
  if (fileSize(path) === null) return null;
  const head = readHead(path, 4096) ?? '';
  return {
    ref, app: 'codex', kind, project, title: basename(path), date: null,
    firstPrompt: '', preview: clip(head, 400),
  };
}

export function listCodex({ codexHome, detailLimit = 40, limit = 300 }: CodexSourceOptions): SourceItem[] {
  const items: SourceItem[] = [];
  const names = threadNames(codexHome);
  const projects = new Set<string>();
  rolloutFiles(codexHome).slice(0, limit).forEach((file, index) => {
    let title = names.get(file.id) ?? '';
    let project = '';
    let firstPrompt = '';
    let preview = '';
    // The file name carries local time. The session's own timestamp is exact when it was read.
    let date = file.date;
    if (index < detailLimit) {
      const head = readHead(file.path);
      if (head !== null) {
        const parsed = parseRollout(head);
        date = parsed.date ?? date;
        project = parsed.cwd;
        firstPrompt = clip(firstUserPrompt(parsed.messages), 200);
        preview = previewOf(parsed.messages);
        if (parsed.cwd) projects.add(parsed.cwd);
      }
    }
    title ||= firstPrompt ? clip(firstPrompt, 80) : 'Codex conversation';
    items.push({
      ref: `codex:session:${file.path}`, app: 'codex', kind: 'session', project, title,
      date, firstPrompt, preview, forkProvider: 'codex',
    });
  });

  for (const directory of MEMORY_DIRS) {
    const root = join(codexHome, directory);
    for (const path of memoryFiles(root)) {
      const item = textItem(`codex:memory:${path}`, 'memory', directory, path);
      if (item) items.push({ ...item, title: path.slice(root.length + 1) });
    }
  }

  const global = textItem(`codex:instructions:${join(codexHome, 'AGENTS.md')}`, 'instructions', 'Global', join(codexHome, 'AGENTS.md'));
  if (global) items.push(global);
  for (const project of projects) {
    const path = join(project, 'AGENTS.md');
    const item = textItem(`codex:instructions:${path}`, 'instructions', project, path);
    if (item) items.push(item);
  }
  return items;
}

function instructionPath(path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || basename(path) !== 'AGENTS.md') {
    throw new Error('Not an AGENTS.md file.');
  }
  return path;
}

export function loadCodex(ref: string, { codexHome }: CodexSourceOptions): LoadedSource {
  const [, kind, ...rest] = ref.split(':');
  const requested = rest.join(':');
  if (kind === 'session') {
    const path = containedPath(requested, [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]);
    const match = ROLLOUT.exec(basename(path));
    const raw = match ? readText(path) : null;
    if (!match || raw === null) throw new Error('This Codex session cannot be read.');
    const parsed = parseRollout(raw);
    const id = parsed.id ?? match[5];
    const firstPrompt = clip(firstUserPrompt(parsed.messages), 200);
    return {
      item: {
        ref, app: 'codex', kind: 'session', project: parsed.cwd,
        title: threadNames(codexHome).get(id) ?? (clip(firstPrompt, 80) || 'Codex conversation'),
        date: parsed.date, firstPrompt, preview: previewOf(parsed.messages), forkProvider: 'codex',
      },
      messages: parsed.messages,
      fork: { provider: 'codex' },
    };
  }
  if (kind === 'memory' || kind === 'instructions') {
    // Project instruction files live outside CODEX_HOME, so they are matched by name instead.
    const path = kind === 'memory'
      ? containedPath(requested, MEMORY_DIRS.map((directory) => join(codexHome, directory)))
      : instructionPath(requested);
    if (!path.toLowerCase().endsWith('.md')) throw new Error('Not a Markdown file.');
    const body = readText(path);
    if (body === null) throw new Error('This file cannot be read.');
    return {
      item: {
        ref, app: 'codex', kind, project: '', title: basename(path), date: null,
        firstPrompt: '', preview: clip(body, 400),
      },
      text: body,
    };
  }
  throw new Error('Unknown Codex item.');
}
