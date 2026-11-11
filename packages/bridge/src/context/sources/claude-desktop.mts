/**
 * Read-only readers for Claude Desktop data that the user can reach officially.
 *
 * (a) A data export ZIP (Settings > Privacy > Export Data). The archive is
 *     parsed once into a redacted, bridge-owned import file; the ZIP itself is
 *     not kept or referenced afterwards.
 * (b) Third-party-inference ("3P") local files:
 *       <Claude-3p>/local-agent-mode-sessions/.../local_*.json
 *       <Claude-3p>/memory/
 *
 * This module never calls claude.ai, and never opens the app's cookies,
 * session tokens, IndexedDB or any other browser storage.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { redactDeep } from '../redact.mjs';
import type { LoadedSource, SourceItem, SourceMessage } from '../types.mjs';
import { openZip } from '../zip.mjs';
import { parseClaudeSession } from './claude-code.mjs';
import {
  clip, containedPath, entries, fileMtime, firstUserPrompt, isRecord, isoDate, previewOf, readText, text,
} from './util.mjs';

const IMPORT_VERSION = 1;
const IMPORT_ID = /^[A-Za-z0-9_-]{16}$/;
const MAX_MEMBER_BYTES = 512 * 1024 * 1024;
const MAX_IMPORT_CONVERSATIONS = 20_000;
const SESSION_FILE = /^local_[A-Za-z0-9_-]+\.json$/;
// Names under the 3P directory that must never be opened, whatever else changes.
const FORBIDDEN = /^(?:cookies|cookies-journal|indexeddb|local storage|session storage|webstorage|network|.*token.*|.*credential.*)$/i;

export interface ClaudeDesktopSourceOptions {
  /** Bridge data directory. Imports live under `<dataDir>/context/imports/claude-desktop`. */
  dataDir: string;
  /** The Claude-3p application data directory for this platform. */
  claude3pDir: string;
  limit?: number;
}

interface ImportedConversation { title: string; date: string | null; messages: SourceMessage[] }
interface ImportedText { title: string; project: string; text: string }
interface ImportFile {
  version: number;
  importedAt: string;
  conversations: ImportedConversation[];
  documents: ImportedText[];
  memories: ImportedText[];
}

export interface ImportSummary {
  id: string;
  conversations: number;
  documents: number;
  memories: number;
  redactions: number;
  /** Members that were present but not understood, by base name. */
  skipped: string[];
}

function importsDir(dataDir: string): string {
  return join(dataDir, 'context', 'imports', 'claude-desktop');
}

function messageText(message: Record<string, unknown>): string {
  const blocks = Array.isArray(message.content)
    ? message.content.flatMap((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    : [];
  let body = (blocks.join('\n') || text(message.text)).trim();
  // Pasted attachments carry their extracted text in the export.
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (isRecord(attachment) && typeof attachment.extracted_content === 'string' && attachment.extracted_content.trim()) {
        body += `\n\n[Attachment: ${text(attachment.file_name) || 'file'}]\n${attachment.extracted_content}`;
      }
    }
  }
  return body.trim();
}

function parseConversations(value: unknown): ImportedConversation[] {
  if (!Array.isArray(value)) return [];
  const conversations: ImportedConversation[] = [];
  for (const conversation of value.slice(0, MAX_IMPORT_CONVERSATIONS)) {
    if (!isRecord(conversation) || !Array.isArray(conversation.chat_messages)) continue;
    const messages: SourceMessage[] = [];
    for (const message of conversation.chat_messages) {
      if (!isRecord(message)) continue;
      const role = message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
      const body = messageText(message);
      if (!role || !body) continue;
      const timestamp = isoDate(message.created_at) ?? undefined;
      messages.push({ role, text: body, ...(timestamp && { timestamp }) });
    }
    if (!messages.length) continue;
    conversations.push({
      title: text(conversation.name) || clip(firstUserPrompt(messages), 80) || 'Claude conversation',
      date: isoDate(conversation.updated_at) ?? isoDate(conversation.created_at),
      messages,
    });
  }
  return conversations;
}

function parseProjects(value: unknown): ImportedText[] {
  if (!Array.isArray(value)) return [];
  const documents: ImportedText[] = [];
  for (const project of value) {
    if (!isRecord(project)) continue;
    const name = text(project.name) || 'Project';
    if (typeof project.prompt_template === 'string' && project.prompt_template.trim()) {
      documents.push({ title: 'Project instructions', project: name, text: project.prompt_template });
    }
    if (!Array.isArray(project.docs)) continue;
    for (const document of project.docs) {
      if (isRecord(document) && typeof document.content === 'string' && document.content.trim()) {
        documents.push({ title: text(document.filename) || 'Document', project: name, text: document.content });
      }
    }
  }
  return documents;
}

function parseMemories(value: unknown): ImportedText[] {
  const memories: ImportedText[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!isRecord(entry)) continue;
    if (typeof entry.conversations_memory === 'string' && entry.conversations_memory.trim()) {
      memories.push({ title: 'Memory', project: 'Global', text: entry.conversations_memory });
    }
    if (isRecord(entry.project_memories)) {
      Object.values(entry.project_memories).forEach((memory, index) => {
        if (typeof memory === 'string' && memory.trim()) {
          memories.push({ title: `Project memory ${index + 1}`, project: 'Projects', text: memory });
        }
      });
    }
  }
  return memories;
}

/** Parse an official export ZIP into a redacted import the picker can list. */
export function importClaudeExport(zipPath: string, { dataDir }: Pick<ClaudeDesktopSourceOptions, 'dataDir'>): ImportSummary {
  const archive = openZip(zipPath);
  const parsed: Record<string, unknown> = {};
  const skipped: string[] = [];
  try {
    for (const entry of archive.entries) {
      const name = basename(entry.name);
      if (entry.name.endsWith('/') || !name.toLowerCase().endsWith('.json')) continue;
      if (!['conversations.json', 'projects.json', 'memories.json'].includes(name)) {
        // users.json and anything unknown is neither needed nor copied.
        if (name !== 'users.json') skipped.push(name);
        continue;
      }
      try {
        parsed[name] = JSON.parse(archive.read(entry, MAX_MEMBER_BYTES).toString('utf8'));
      } catch {
        skipped.push(name);
      }
    }
  } finally {
    archive.close();
  }
  if (!('conversations.json' in parsed) && !('projects.json' in parsed) && !('memories.json' in parsed)) {
    throw Object.assign(new Error('This ZIP does not look like a Claude data export.'), { code: 'INVALID_EXPORT' });
  }

  const tally = { count: 0 };
  const data: ImportFile = {
    version: IMPORT_VERSION,
    importedAt: new Date().toISOString(),
    conversations: redactDeep(parseConversations(parsed['conversations.json']), tally) as ImportedConversation[],
    documents: redactDeep(parseProjects(parsed['projects.json']), tally) as ImportedText[],
    memories: redactDeep(parseMemories(parsed['memories.json']), tally) as ImportedText[],
  };
  const id = randomBytes(12).toString('base64url');
  const directory = importsDir(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${id}.tmp`);
  writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(directory, `${id}.json`));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return {
    id,
    conversations: data.conversations.length,
    documents: data.documents.length,
    memories: data.memories.length,
    redactions: tally.count,
    skipped,
  };
}

export function removeClaudeImport(id: string, { dataDir }: Pick<ClaudeDesktopSourceOptions, 'dataDir'>): boolean {
  if (!IMPORT_ID.test(id)) return false;
  const path = join(importsDir(dataDir), `${id}.json`);
  try {
    readFileSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

function readImport(dataDir: string, id: string): ImportFile | null {
  if (!IMPORT_ID.test(id)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(join(importsDir(dataDir), `${id}.json`), 'utf8'));
    if (!isRecord(value) || value.version !== IMPORT_VERSION) return null;
    return {
      version: IMPORT_VERSION,
      importedAt: text(value.importedAt),
      conversations: Array.isArray(value.conversations) ? value.conversations as ImportedConversation[] : [],
      documents: Array.isArray(value.documents) ? value.documents as ImportedText[] : [],
      memories: Array.isArray(value.memories) ? value.memories as ImportedText[] : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3P local files

interface LocalSession {
  title: string;
  cwd: string;
  date: string | null;
  messages: SourceMessage[];
  summary: string;
}

function embeddedMessages(value: unknown): SourceMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: SourceMessage[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const label = text(entry.role) || text(entry.sender) || text(entry.type);
    const role = /^(?:user|human)$/i.test(label) ? 'user' : /^assistant$/i.test(label) ? 'assistant' : null;
    const content = entry.content ?? entry.text ?? entry.message;
    const body = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.flatMap((block) => isRecord(block) && typeof block.text === 'string' ? [block.text] : []).join('\n')
        : '';
    if (role && body.trim()) messages.push({ role, text: body.trim() });
  }
  return messages;
}

function transcriptFor(sessionPath: string, cliSessionId: string): string | null {
  // Some builds keep the Claude Code transcript in a directory beside the metadata file.
  let root: string;
  try { root = containedPath(sessionPath.replace(/\.json$/, ''), [dirname(sessionPath)]); }
  catch { return null; }
  const visit = (directory: string, depth: number): string | null => {
    for (const entry of entries(directory)) {
      if (FORBIDDEN.test(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === `${cliSessionId}.jsonl`) {
        try { return containedPath(path, [root]); } catch { continue; }
      }
      if (entry.isDirectory() && depth < 6) {
        const found = visit(path, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return cliSessionId ? visit(root, 0) : null;
}

export function parseLocalSession(path: string): LocalSession | null {
  const raw = readText(path);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  // The format changes between releases, so every field is optional.
  let messages: SourceMessage[] = [];
  for (const key of ['messages', 'transcript', 'conversation', 'turns']) {
    messages = embeddedMessages(value[key]);
    if (messages.length) break;
  }
  if (!messages.length) {
    const transcript = transcriptFor(path, text(value.cliSessionId));
    const body = transcript ? readText(transcript) : null;
    if (body !== null) messages = parseClaudeSession(body).messages;
  }
  const summaryParts: string[] = [];
  if (isRecord(value.postTurnSummary)) {
    for (const part of Object.values(value.postTurnSummary)) {
      if (typeof part === 'string' && part.trim()) summaryParts.push(part.trim());
    }
  }
  if (typeof value.initialMessage === 'string') summaryParts.unshift(value.initialMessage.trim());
  return {
    title: text(value.title) || clip(firstUserPrompt(messages), 80) || 'Claude Desktop session',
    cwd: text(value.cwd) || text(value.originCwd),
    date: isoDate(value.lastActivityAt) ?? isoDate(value.createdAt) ?? new Date(fileMtime(path)).toISOString(),
    messages,
    summary: summaryParts.join('\n\n'),
  };
}

function localSessionFiles(root: string, depth = 0): string[] {
  const files: string[] = [];
  for (const entry of entries(root)) {
    if (FORBIDDEN.test(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isFile() && SESSION_FILE.test(entry.name)) files.push(path);
    else if (entry.isDirectory() && depth < 3) files.push(...localSessionFiles(path, depth + 1));
  }
  return files;
}

function memoryFiles(root: string, depth = 0): string[] {
  const files: string[] = [];
  for (const entry of entries(root)) {
    if (FORBIDDEN.test(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (entry.isFile() && /\.(?:md|txt)$/i.test(entry.name)) files.push(path);
    else if (entry.isDirectory() && depth < 3) files.push(...memoryFiles(path, depth + 1));
  }
  return files;
}

export function listClaudeDesktop({ dataDir, claude3pDir, limit = 300 }: ClaudeDesktopSourceOptions): SourceItem[] {
  const items: SourceItem[] = [];
  for (const entry of entries(importsDir(dataDir))) {
    const id = entry.isFile() && entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
    const data = readImport(dataDir, id);
    if (!data) continue;
    const project = `Export imported ${data.importedAt.slice(0, 10)}`;
    data.conversations
      .map((conversation, index) => ({ conversation, index }))
      .sort((a, b) => (b.conversation.date ?? '').localeCompare(a.conversation.date ?? ''))
      .slice(0, limit)
      .forEach(({ conversation, index }) => items.push({
        ref: `claude-desktop:import:${id}:c${index}`, app: 'claude-desktop', kind: 'session', project,
        title: conversation.title, date: conversation.date,
        firstPrompt: clip(firstUserPrompt(conversation.messages), 200), preview: previewOf(conversation.messages),
      }));
    data.memories.forEach((memory, index) => items.push({
      ref: `claude-desktop:import:${id}:m${index}`, app: 'claude-desktop', kind: 'memory',
      project: `${project} · ${memory.project}`, title: memory.title, date: null, firstPrompt: '', preview: clip(memory.text, 400),
    }));
    data.documents.forEach((document, index) => items.push({
      ref: `claude-desktop:import:${id}:d${index}`, app: 'claude-desktop', kind: 'knowledge',
      project: `${project} · ${document.project}`, title: document.title, date: null, firstPrompt: '', preview: clip(document.text, 400),
    }));
  }

  const sessionsRoot = join(claude3pDir, 'local-agent-mode-sessions');
  localSessionFiles(sessionsRoot)
    .sort((a, b) => fileMtime(b) - fileMtime(a))
    .slice(0, limit)
    .forEach((path) => {
      const session = parseLocalSession(path);
      if (!session || (!session.messages.length && !session.summary)) return;
      items.push({
        ref: `claude-desktop:3p-session:${path}`, app: 'claude-desktop', kind: 'session',
        project: session.cwd || '3P local sessions', title: session.title, date: session.date,
        firstPrompt: clip(firstUserPrompt(session.messages), 200),
        preview: session.messages.length ? previewOf(session.messages) : clip(session.summary, 400),
      });
    });
  const memoryRoot = join(claude3pDir, 'memory');
  for (const path of memoryFiles(memoryRoot)) {
    items.push({
      ref: `claude-desktop:3p-memory:${path}`, app: 'claude-desktop', kind: 'memory', project: '3P memory',
      title: path.slice(memoryRoot.length + 1), date: null, firstPrompt: '', preview: clip(readText(path) ?? '', 400),
    });
  }
  return items;
}

function localPath(requested: string, root: string): string {
  const path = containedPath(requested, [root]);
  if (relative(root, path).split(sep).some(part => FORBIDDEN.test(part))) throw new Error('Not a shareable local file.');
  return path;
}

export function loadClaudeDesktop(ref: string, { dataDir, claude3pDir }: ClaudeDesktopSourceOptions): LoadedSource {
  const [, kind, ...rest] = ref.split(':');
  if (kind === 'import') {
    const [id, member = ''] = rest;
    const data = readImport(dataDir, id ?? '');
    const index = Number(member.slice(1));
    if (!data || !Number.isInteger(index) || index < 0) throw new Error('This import is no longer available.');
    const base = { ref, app: 'claude-desktop' as const, project: 'Claude export', firstPrompt: '' };
    if (member[0] === 'c' && data.conversations[index]) {
      const conversation = data.conversations[index];
      return {
        item: {
          ...base, kind: 'session', title: conversation.title, date: conversation.date,
          firstPrompt: clip(firstUserPrompt(conversation.messages), 200), preview: previewOf(conversation.messages),
        },
        messages: conversation.messages,
      };
    }
    const entry = member[0] === 'm' ? data.memories[index] : member[0] === 'd' ? data.documents[index] : undefined;
    if (!entry) throw new Error('This import is no longer available.');
    return {
      item: { ...base, kind: member[0] === 'm' ? 'memory' : 'knowledge', title: entry.title, date: null, preview: clip(entry.text, 400) },
      text: entry.text,
    };
  }
  const requested = rest.join(':');
  if (kind === '3p-session') {
    const path = localPath(requested, join(claude3pDir, 'local-agent-mode-sessions'));
    const session = SESSION_FILE.test(basename(path)) ? parseLocalSession(path) : null;
    if (!session) throw new Error('This session cannot be read.');
    const item: SourceItem = {
      ref, app: 'claude-desktop', kind: 'session', project: session.cwd, title: session.title, date: session.date,
      firstPrompt: clip(firstUserPrompt(session.messages), 200),
      preview: session.messages.length ? previewOf(session.messages) : clip(session.summary, 400),
    };
    // Without a readable transcript, the session's own summary is the selectable text.
    return session.messages.length ? { item, messages: session.messages } : { item, text: session.summary };
  }
  if (kind === '3p-memory') {
    const path = localPath(requested, join(claude3pDir, 'memory'));
    if (!/\.(?:md|txt)$/i.test(path) || FORBIDDEN.test(basename(path)) || FORBIDDEN.test(basename(dirname(path)))) {
      throw new Error('Not a memory file.');
    }
    const body = readText(path);
    if (body === null) throw new Error('This file cannot be read.');
    return {
      item: {
        ref, app: 'claude-desktop', kind: 'memory', project: '3P memory', title: basename(path), date: null,
        firstPrompt: '', preview: clip(body, 400),
      },
      text: body,
    };
  }
  throw new Error('Unknown Claude Desktop item.');
}
