/** Build a private, text-only Claude Code session from the approved messages. */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ForkRecord, SourceMessage } from './types.mjs';

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Not supported on every platform. */ }
}

/** Claude Code names a project directory after its working directory. */
export function claudeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function prepareClaudeFork(messages: readonly SourceMessage[], directory: string): {
  record: Extract<ForkRecord, { provider: 'claude' }>;
} {
  const workspace = join(directory, 'workspace');
  privateDir(workspace);
  const cwd = realpathSync(workspace);
  const configDir = join(directory, 'claude-config');
  const project = join(configDir, 'projects', claudeProjectName(cwd));
  privateDir(configDir);
  privateDir(join(configDir, 'projects'));
  privateDir(project);

  const sessionId = randomUUID();
  let parentUuid: string | null = null;
  const lines = messages.map(({ role, text, timestamp }) => {
    const uuid: string = randomUUID();
    const record = {
      parentUuid, isSidechain: false, userType: 'external', cwd, sessionId,
      type: role, uuid, timestamp: timestamp ?? new Date().toISOString(),
      message: {
        role, content: [{ type: 'text', text }],
        ...(role === 'assistant' && { id: `msg_${uuid}`, type: 'message', stop_reason: 'end_turn', stop_sequence: null }),
      },
    };
    parentUuid = uuid;
    return JSON.stringify(record);
  });
  writeFileSync(join(project, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  return { record: { provider: 'claude', sessionId, configDir, cwd } };
}
