/** One entry point over the per-app local readers. */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { defaultDataDir } from '../store.mjs';
import { SOURCE_APPS, type LoadedSource, type SourceApp, type SourceItem } from '../types.mjs';
import { listAntigravity, loadAntigravity } from './antigravity.mjs';
import { listClaudeCode, loadClaudeCode } from './claude-code.mjs';
import { listClaudeDesktop, loadClaudeDesktop } from './claude-desktop.mjs';
import { listCodex, loadCodex } from './codex.mjs';

/** Where each app keeps its local data. Trusted local configuration only. */
export interface SourceLocations {
  codexHome: string;
  claudeHome: string;
  claude3pDir: string;
  geminiDir: string;
  dataDir: string;
}

function absolute(value: string | undefined): string | undefined {
  return value !== undefined && isAbsolute(value) ? value : undefined;
}

function claude3pDirectory(env: NodeJS.ProcessEnv, home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude-3p');
  if (process.platform === 'win32') {
    return join(absolute(env.LOCALAPPDATA) ?? join(home, 'AppData', 'Local'), 'Claude-3p');
  }
  return join(home, '.config', 'Claude-3p');
}

export function defaultLocations(env: NodeJS.ProcessEnv = process.env): SourceLocations {
  const home = homedir();
  return {
    codexHome: absolute(env.CODEX_HOME) ?? join(home, '.codex'),
    claudeHome: absolute(env.CLAUDE_CONFIG_DIR) ?? join(home, '.claude'),
    claude3pDir: claude3pDirectory(env, home),
    geminiDir: join(home, '.gemini'),
    dataDir: defaultDataDir(env),
  };
}

export interface ListOptions {
  apps?: readonly SourceApp[];
  detailLimit?: number;
  limit?: number;
}

export interface SourceListing {
  items: SourceItem[];
  /** Apps whose reader failed. The others are still listed. */
  failed: SourceApp[];
}

export function listSources(locations: SourceLocations, { apps = SOURCE_APPS, detailLimit, limit }: ListOptions = {}): SourceListing {
  const items: SourceItem[] = [];
  const failed: SourceApp[] = [];
  const options = { ...locations, ...(detailLimit !== undefined && { detailLimit }), ...(limit !== undefined && { limit }) };
  const readers: Record<SourceApp, () => SourceItem[]> = {
    codex: () => listCodex(options),
    'claude-code': () => listClaudeCode(options),
    'claude-desktop': () => listClaudeDesktop(options),
    antigravity: () => listAntigravity(options),
  };
  for (const app of SOURCE_APPS) {
    if (!apps.includes(app)) continue;
    try {
      items.push(...readers[app]());
    } catch {
      failed.push(app);
    }
  }
  return { items, failed };
}

export function loadSource(ref: string, locations: SourceLocations): LoadedSource {
  const app = ref.split(':', 1)[0];
  if (app === 'codex') return loadCodex(ref, locations);
  if (app === 'claude-code') return loadClaudeCode(ref, locations);
  if (app === 'claude-desktop') return loadClaudeDesktop(ref, locations);
  if (app === 'antigravity') return loadAntigravity(ref, locations);
  throw new Error('Unknown item.');
}
