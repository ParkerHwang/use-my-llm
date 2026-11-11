/** Read-only file helpers shared by the local source readers. */
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import * as zlib from 'node:zlib';
import { ContextError, type SourceMessage } from '../types.mjs';

/** Largest original this bridge will open. Larger files are skipped. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const HEAD_BYTES = 1536 * 1024;

type Decompress = (data: Buffer, options?: { maxOutputLength?: number }) => Buffer;
// Zstandard arrived in Node.js 22.15. Older runtimes skip compressed rollouts.
const zstdDecompress = (zlib as { zstdDecompressSync?: Decompress }).zstdDecompressSync;

export function zstdSupported(): boolean {
  return typeof zstdDecompress === 'function';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function clip(value: string, length: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

export function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  // Second-resolution epochs appear in a few formats.
  const input = typeof value === 'number' && value < 1e11 ? value * 1000 : value;
  const time = new Date(input).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Directory entries, or an empty list when the directory is missing or unreadable. */
export function entries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function fileSize(path: string): number | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

export function fileMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Read a whole text file, transparently decompressing `.zst`. Returns null when it cannot be read. */
export function readText(path: string): string | null {
  const size = fileSize(path);
  if (size === null || size > MAX_SOURCE_BYTES) return null;
  try {
    let data: Buffer = readFileSync(path);
    if (path.endsWith('.zst')) {
      if (!zstdDecompress) return null;
      data = zstdDecompress(data, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    }
    return data.toString('utf8');
  } catch {
    return null;
  }
}

/** Read only the start of a text file. Compressed files are decompressed in full. */
export function readHead(path: string, bytes = HEAD_BYTES): string | null {
  if (path.endsWith('.zst')) {
    const whole = readText(path);
    return whole === null ? null : whole.slice(0, bytes);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Parse JSON Lines. Unparseable lines (including a truncated final line) are skipped. */
export function jsonLines(raw: string): unknown[] {
  const values: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch { /* Skip. */ }
  }
  return values;
}

/**
 * Resolve `path` and require that it lies inside one of `roots`.
 * Local references travel through the picker, so they are checked again here.
 */
export function containedPath(path: string, roots: readonly string[]): string {
  const invalid = () => new ContextError('INVALID_REFERENCE', 'The selected item is no longer available.');
  if (!isAbsolute(path) || path.includes('\0')) throw invalid();
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw invalid();
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    const inside = relative(realRoot, real);
    if (inside && !inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)) return real;
  }
  throw invalid();
}

export function firstUserPrompt(messages: readonly SourceMessage[]): string {
  return messages.find((message) => message.role === 'user')?.text ?? '';
}

export function previewOf(messages: readonly SourceMessage[]): string {
  return clip(messages.slice(0, 4).map((message) => `${message.role}: ${message.text}`).join(' · '), 400);
}

/** Render a message range as plain text for a snapshot. */
export function renderMessages(messages: readonly SourceMessage[]): string {
  return messages.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`).join('\n\n');
}
