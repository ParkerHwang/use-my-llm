/**
 * Read-only reader for Antigravity's local knowledge and conversation artifacts.
 *
 *   <geminiDir>/antigravity/      and  <geminiDir>/antigravity-ide/
 *     knowledge/<item>/metadata.json
 *     knowledge/<item>/artifacts/*.md
 *     brain/<id>/**.md                               (plans, walkthroughs, task lists)
 *     brain/<id>/.system_generated/logs/transcript.jsonl
 *
 * The on-disk format changes often. Unknown files, fields and record types are
 * skipped, and a problem with one item never stops the others from loading.
 * Binary stores (`conversations/*.db`, `*.pb`) are not opened.
 */
import { basename, join, sep } from 'node:path';
import type { LoadedSource, SourceItem, SourceMessage } from '../types.mjs';
import {
  clip, containedPath, entries, fileMtime, firstUserPrompt, isRecord, isoDate, jsonLines,
  previewOf, readHead, readText, text,
} from './util.mjs';

const APP_DIRS = ['antigravity', 'antigravity-ide'];
const TRANSCRIPT_NAMES = ['transcript.jsonl', 'transcript_full.jsonl'];

export interface AntigravitySourceOptions {
  geminiDir: string;
  detailLimit?: number;
  limit?: number;
}

function roots(geminiDir: string): string[] {
  return APP_DIRS.map((name) => join(geminiDir, name));
}

export function parseTranscript(raw: string): SourceMessage[] {
  const messages: SourceMessage[] = [];
  for (const line of jsonLines(raw)) {
    if (!isRecord(line)) continue;
    const body = text(line.content).trim();
    if (!body) continue;
    // Tool steps and other record types are not conversation text.
    const role = line.type === 'USER_INPUT' ? 'user' : line.type === 'PLANNER_RESPONSE' ? 'assistant' : null;
    if (!role) continue;
    const timestamp = isoDate(line.created_at) ?? undefined;
    messages.push({ role, text: body, ...(timestamp && { timestamp }) });
  }
  return messages;
}

function findTranscript(brain: string): string | null {
  for (const directory of [join(brain, '.system_generated', 'logs'), brain]) {
    for (const name of TRANSCRIPT_NAMES) {
      const path = join(directory, name);
      if (fileMtime(path)) return path;
    }
  }
  return null;
}

function markdownFiles(root: string, depth: number): string[] {
  const files: string[] = [];
  for (const entry of entries(root)) {
    if (entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path);
    else if (entry.isDirectory() && depth > 0) files.push(...markdownFiles(path, depth - 1));
  }
  return files;
}

function knowledgeMetadata(directory: string): { title: string; summary: string; date: string | null } {
  const fallback = { title: basename(directory), summary: '', date: null };
  const raw = readText(join(directory, 'metadata.json'));
  if (raw === null) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return fallback;
    return {
      title: text(value.title) || text(value.name) || fallback.title,
      summary: text(value.summary) || text(value.description),
      date: isoDate(value.updated_at) ?? isoDate(value.updatedAt) ?? isoDate(value.lastAccessed)
        ?? isoDate(value.created_at) ?? isoDate(value.createdAt),
    };
  } catch {
    return fallback;
  }
}

export function listAntigravity({ geminiDir, detailLimit = 40, limit = 300 }: AntigravitySourceOptions): SourceItem[] {
  const items: SourceItem[] = [];
  for (const root of roots(geminiDir)) {
    const app = basename(root);

    for (const entry of entries(join(root, 'knowledge'))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = join(root, 'knowledge', entry.name);
      const metadata = knowledgeMetadata(directory);
      for (const path of markdownFiles(join(directory, 'artifacts'), 2)) {
        items.push({
          ref: `antigravity:knowledge:${path}`, app: 'antigravity', kind: 'knowledge',
          project: `${app} · ${metadata.title}`, title: basename(path), date: metadata.date,
          firstPrompt: '', preview: clip(metadata.summary || (readHead(path, 4096) ?? ''), 400),
        });
      }
    }

    const brains = entries(join(root, 'brain'))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(root, 'brain', entry.name));
    const withTranscript = brains
      .map((brain) => ({ brain, transcript: findTranscript(brain) }))
      .sort((a, b) => fileMtime(b.transcript ?? b.brain) - fileMtime(a.transcript ?? a.brain))
      .slice(0, limit);
    withTranscript.forEach(({ brain, transcript }, index) => {
      if (transcript) {
        let firstPrompt = '';
        let preview = '';
        if (index < detailLimit) {
          const messages = parseTranscript(readHead(transcript) ?? '');
          firstPrompt = clip(firstUserPrompt(messages), 200);
          preview = previewOf(messages);
        }
        items.push({
          ref: `antigravity:brain:${transcript}`, app: 'antigravity', kind: 'session', project: app,
          title: firstPrompt ? clip(firstPrompt, 80) : 'Antigravity conversation',
          date: new Date(fileMtime(transcript)).toISOString(), firstPrompt, preview, forkProvider: 'antigravity',
        });
      }
      for (const path of markdownFiles(brain, 2)) {
        items.push({
          ref: `antigravity:artifact:${path}`, app: 'antigravity', kind: 'knowledge',
          project: `${app} · conversation artifacts`, title: basename(path),
          date: new Date(fileMtime(path)).toISOString(), firstPrompt: '', preview: clip(readHead(path, 4096) ?? '', 400),
        });
      }
    });
  }
  return items;
}

export function loadAntigravity(ref: string, { geminiDir }: AntigravitySourceOptions): LoadedSource {
  const [, kind, ...rest] = ref.split(':');
  const requested = rest.join(':');
  if (kind === 'brain') {
    const path = containedPath(requested, roots(geminiDir).map((root) => join(root, 'brain')));
    const raw = TRANSCRIPT_NAMES.includes(basename(path)) ? readText(path) : null;
    if (raw === null) throw new Error('This Antigravity conversation cannot be read.');
    const messages = parseTranscript(raw);
    const firstPrompt = clip(firstUserPrompt(messages), 200);
    return {
      item: {
        ref, app: 'antigravity', kind: 'session', project: '', title: clip(firstPrompt, 80) || 'Antigravity conversation',
        date: new Date(fileMtime(path)).toISOString(), firstPrompt, preview: previewOf(messages), forkProvider: 'antigravity',
      },
      messages,
      fork: { provider: 'antigravity' },
    };
  }
  if (kind === 'knowledge' || kind === 'artifact') {
    const folder = kind === 'knowledge' ? 'knowledge' : 'brain';
    const path = containedPath(requested, roots(geminiDir).map((root) => join(root, folder)));
    // Dot-directories hold generated logs and uploads, not artifacts.
    const inside = path.slice(path.lastIndexOf(`${sep}${folder}${sep}`) + 1);
    if (!path.toLowerCase().endsWith('.md') || inside.split(sep).some((part) => part.startsWith('.'))) {
      throw new Error('Not an artifact file.');
    }
    const body = readText(path);
    if (body === null) throw new Error('This file cannot be read.');
    return {
      item: {
        ref, app: 'antigravity', kind: 'knowledge', project: '', title: basename(path), date: null,
        firstPrompt: '', preview: clip(body, 400),
      },
      text: body,
    };
  }
  throw new Error('Unknown Antigravity item.');
}
