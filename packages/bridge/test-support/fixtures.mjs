// Made-up local data in each app's on-disk format, for tests only.
// Every name, path, prompt and "secret" here is invented. Nothing is copied
// from a real conversation, and secret-shaped strings are assembled at run
// time so that no credential-like literal exists in the repository.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';

export const ZSTD = typeof zlib.zstdCompressSync === 'function';

export const SECRETS = {
  anthropic: `sk-${'ant'}-${'Zq7'.repeat(12)}`,
  openai: `sk-${'proj'}-${'Ab3'.repeat(12)}`,
  github: `gh${'p'}_${'Kd9'.repeat(12)}`,
  aws: `AK${'IA'}${'Q7WERTY2UIOP3ASD'}`,
  jwt: `ey${'J'}hbGciOiJIUzI1NiJ9.ey${'J'}zdWIiOiJmaXh0dXJlIn0.${'c2ln'.repeat(6)}`,
  password: 'correct-horse-battery',
  privateKey: `-----BEGIN ${'RSA PRIVATE'} KEY-----\nTUlJRXZnSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2d3Z2dTa0FnRUFBb0lCQVFD\n-----END ${'RSA PRIVATE'} KEY-----`,
};

export const IDS = {
  codexPlain: '11111111-1111-4111-8111-111111111111',
  codexZst: '22222222-2222-4222-8222-222222222222',
  codexArchived: '33333333-3333-4333-8333-333333333333',
  claude: '44444444-4444-4444-8444-444444444444',
  claudeOther: '55555555-5555-4555-8555-555555555555',
};

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

const lines = (values) => `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;

function codexMessage(role, text, { provenance = 'user', phase } = {}) {
  return {
    timestamp: '2026-01-02T03:04:06.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      ...(phase && { phase }),
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
      ...(role === 'user' && {
        internal_chat_message_metadata_passthrough: { content_item_metadata: [{ provenance: { type: provenance } }] },
      }),
    },
  };
}

/** A fake CODEX_HOME. Returns the paths the tests refer to. */
export function codexFixture(root, { project = join(root, 'lighthouse-app') } = {}) {
  const home = join(root, 'codex-home');
  const rollout = [
    { timestamp: '2026-01-02T03:04:05.000Z', type: 'session_meta', payload: { id: IDS.codexPlain, cwd: project, timestamp: '2026-01-02T03:04:05.000Z', originator: 'codex_exec', cli_version: '0.167.0', source: 'exec', model_provider: 'openai', base_instructions: { text: 'fixture base instructions' }, a_field_from_the_future: { nested: true } } },
    { timestamp: '2026-01-02T03:04:05.100Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    codexMessage('developer', 'fixture developer instructions that must not be shared'),
    codexMessage('user', '<environment_context>\n  <cwd>/fixture</cwd>\n</environment_context>', { provenance: 'harness' }),
    codexMessage('user', 'How should the lighthouse keeper schedule the lamp rotation?'),
    { timestamp: '2026-01-02T03:04:07.000Z', type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'fixture-opaque', summary: [] } },
    { timestamp: '2026-01-02T03:04:07.500Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'fixture tool output that must not be shared' } },
    codexMessage('assistant', 'Rotate the lamp every twelve seconds and log each sweep.', { phase: 'final_answer' }),
    codexMessage('user', `Store the deploy key ${SECRETS.openai} in the lamp config. password = "${SECRETS.password}"`),
    codexMessage('assistant', 'Keep that key out of the repository.', { phase: 'final_answer' }),
    { type: 'a_record_type_from_the_future', payload: { anything: 1 } },
  ];
  const plain = write(join(home, 'sessions', '2026', '01', '02', `rollout-2026-01-02T03-04-05-${IDS.codexPlain}.jsonl`), `${lines(rollout)}{"truncated":`);

  const compressedLines = lines([
    { timestamp: '2026-02-03T04:05:06.000Z', type: 'session_meta', payload: { id: IDS.codexZst, cwd: project, timestamp: '2026-02-03T04:05:06.000Z' } },
    codexMessage('user', 'Draft a tide table for the harbour notice board.'),
    codexMessage('assistant', 'High tide at 06:10 and 18:35; low tide at 12:20.', { phase: 'final_answer' }),
  ]);
  const compressed = ZSTD
    ? write(join(home, 'sessions', '2026', '02', '03', `rollout-2026-02-03T04-05-06-${IDS.codexZst}_${IDS.codexArchived}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(compressedLines)))
    : null;

  // An older rollout shape: bare metadata first, then event messages only.
  const archived = write(join(home, 'archived_sessions', `rollout-2025-12-24T10-00-00-${IDS.codexArchived}.jsonl`), lines([
    { id: IDS.codexArchived, timestamp: '2025-12-24T10:00:00.000Z', instructions: null },
    { timestamp: '2025-12-24T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Which rope is best for the mooring line?' } },
    { timestamp: '2025-12-24T10:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Use three-strand nylon for stretch.' } },
  ]));

  write(join(home, 'session_index.jsonl'), lines([
    { id: IDS.codexPlain, thread_name: 'Private thread name: lamp rotation', updated_at: '2026-01-02T03:05:00Z' },
  ]));
  write(join(home, 'memories_v2', 'memory_summary.md'), '# Memory\nThe keeper prefers metric units.\n');
  write(join(home, 'memories_v2', 'rollout_summaries', 'lamp.md'), 'The lamp rotation was set to twelve seconds.\n');
  write(join(home, 'memories_v2', '.git', 'ignored.md'), 'must not be listed\n');
  write(join(home, 'memories', 'MEMORY.md'), 'Legacy memory: the foghorn is tested on Fridays.\n');
  write(join(home, 'AGENTS.md'), '# Global instructions\nAlways answer in short sentences.\n');
  write(join(home, 'auth.json'), '{"fixture":"never read by the bridge"}');
  write(join(project, 'AGENTS.md'), '# Project instructions\nUse nautical terms.\n');
  return { home, project, plain, compressed, archived };
}

function claudeLine(type, content, extra = {}) {
  return {
    type,
    uuid: `${type}-${Math.random().toString(16).slice(2)}`,
    parentUuid: null,
    sessionId: IDS.claude,
    cwd: '/fixture/orchard',
    isSidechain: false,
    timestamp: '2026-03-04T05:06:07.000Z',
    message: { role: type, content },
    ...extra,
  };
}

/** A fake Claude Code config directory. */
export function claudeCodeFixture(root, { project = join(root, 'orchard') } = {}) {
  const home = join(root, 'claude-home');
  const directory = join(home, 'projects', '-fixture-orchard');
  const session = write(join(directory, `${IDS.claude}.jsonl`), lines([
    { type: 'session-owner', sessionId: IDS.claude, accountUuid: 'fixture-account', organizationUuid: 'fixture-org' },
    { type: 'attachment', uuid: 'att-1', parentUuid: null, sessionId: IDS.claude, cwd: project, isSidechain: false, attachment: { type: 'session_context', context: { userEmail: 'keeper@fixture.invalid' } }, rendered: [{ content: 'keeper@fixture.invalid' }] },
    claudeLine('user', 'When should the apple trees be pruned?', { cwd: project }),
    claudeLine('assistant', [
      { type: 'thinking', thinking: 'fixture thinking that must not be shared' },
      { type: 'text', text: 'Prune in late winter while the trees are dormant.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/fixture/secret.txt' } },
    ], { cwd: project }),
    claudeLine('user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'fixture tool result that must not be shared' }], { cwd: project }),
    claudeLine('user', '<command-name>/clear</command-name>', { cwd: project }),
    claudeLine('user', 'sidechain prompt that must not be shared', { isSidechain: true, cwd: project }),
    claudeLine('user', 'meta prompt that must not be shared', { isMeta: true, cwd: project }),
    claudeLine('user', `Here is the registry token ${SECRETS.github} <system-reminder>fixture reminder</system-reminder>`, { cwd: project }),
    claudeLine('assistant', [{ type: 'text', text: 'Do not paste tokens into chat.' }], { cwd: project }),
    { type: 'custom-title', sessionId: IDS.claude, customTitle: 'Private title: orchard pruning' },
    { type: 'a-record-type-from-the-future', sessionId: IDS.claude, payload: [1, 2, 3] },
  ]));
  write(join(directory, `${IDS.claudeOther}.jsonl`), lines([
    claudeLine('user', 'How many beehives fit along the south wall?', { sessionId: IDS.claudeOther, cwd: project }),
    claudeLine('assistant', [{ type: 'text', text: 'Six hives with two metres between them.' }], { sessionId: IDS.claudeOther, cwd: project }),
  ]));
  write(join(directory, 'memory', 'MEMORY.md'), '- [Orchard layout](layout.md) — rows run north to south\n');
  write(join(directory, 'memory', 'layout.md'), 'The orchard has nine rows running north to south.\n');
  write(join(home, 'CLAUDE.md'), '# Global\nPrefer British spelling.\n');
  write(join(project, 'CLAUDE.md'), '# Orchard project\nMeasure in metres.\n');
  write(join(home, '.credentials.json'), '{"fixture":"never read by the bridge"}');
  return { home, project, session };
}

let crcTable;
function crc32(data) {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Write a small ZIP. Members are deflated unless `store` is set. */
export function writeZip(path, members, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(members)) {
    const data = Buffer.from(content);
    const body = store ? data : zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(members).length, 8);
  end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return write(path, Buffer.concat([...locals, directory, end]));
}

/** A fake Claude data export ZIP in the documented layout. */
export function claudeExportFixture(root) {
  return writeZip(join(root, 'claude-export.zip'), {
    'users.json': JSON.stringify([{ uuid: 'fixture-user', full_name: 'Fixture Person', email_address: 'person@fixture.invalid' }]),
    'conversations.json': JSON.stringify([
      {
        uuid: 'fixture-conversation-1', name: 'Bread proofing times', created_at: '2026-04-01T08:00:00Z', updated_at: '2026-04-01T08:10:00Z',
        chat_messages: [
          { uuid: 'm1', sender: 'human', text: 'How long should sourdough proof overnight?', content: [{ type: 'text', text: 'How long should sourdough proof overnight?' }], created_at: '2026-04-01T08:00:00Z', attachments: [{ file_name: 'starter-notes.txt', extracted_content: `Starter fed at 9pm. api_key=${SECRETS.anthropic}` }] },
          { uuid: 'm2', sender: 'assistant', text: '', content: [{ type: 'text', text: 'Eight to twelve hours in the fridge.' }, { type: 'tool_use', name: 'fixture_tool' }], created_at: '2026-04-01T08:01:00Z' },
          { uuid: 'm3', sender: 'a-sender-from-the-future', text: 'ignored' },
        ],
      },
      { uuid: 'fixture-conversation-2', name: '', created_at: '2026-04-02T08:00:00Z', updated_at: '2026-04-02T08:00:00Z', chat_messages: [{ sender: 'human', text: 'What is a good rye ratio?' }, { sender: 'assistant', text: 'Thirty percent rye keeps the crumb open.' }] },
      { uuid: 'fixture-empty', name: 'Empty', chat_messages: [] },
      'not-an-object',
    ]),
    'projects.json': JSON.stringify([{ uuid: 'fixture-project', name: 'Bakery', prompt_template: 'Answer as a patient baker.', docs: [{ uuid: 'd1', filename: 'oven.md', content: 'The deck oven runs twenty degrees hot.' }] }]),
    'memories.json': JSON.stringify([{ conversations_memory: 'Bakes on weekends and prefers grams.', project_memories: { 'fixture-project': 'The bakery opens at seven.' } }]),
    'a-file-from-the-future.json': '{"unknown":true}',
  });
}

/** A fake Claude-3p application data directory. */
export function claude3pFixture(root) {
  const directory = join(root, 'Claude-3p');
  const sessions = join(directory, 'local-agent-mode-sessions', 'fixture-account', 'fixture-org');
  write(join(sessions, 'local_fixture-one.json'), JSON.stringify({
    sessionId: 'local_fixture-one', cliSessionId: IDS.claude, cwd: '/fixture/garden', title: 'Compost plan',
    createdAt: 1767225600000, lastActivityAt: 1767229200000, unknownFutureField: { a: 1 },
    postTurnSummary: { summary: 'Agreed to turn the compost weekly.' },
  }));
  write(join(sessions, 'local_fixture-one', '.claude', 'projects', '-fixture-garden', `${IDS.claude}.jsonl`), lines([
    claudeLine('user', 'How often should compost be turned?'),
    claudeLine('assistant', [{ type: 'text', text: 'Turn it once a week.' }]),
  ]));
  write(join(sessions, 'local_fixture-two.json'), JSON.stringify({
    sessionId: 'local_fixture-two', title: 'Seed order',
    messages: [{ role: 'user', content: 'Which seeds for spring?' }, { role: 'assistant', content: [{ type: 'text', text: 'Peas and broad beans.' }] }],
  }));
  write(join(sessions, 'local_fixture-broken.json'), '{ this is not json');
  write(join(directory, 'memory', 'garden.md'), 'The greenhouse faces east.\n');
  // Things the bridge must never open.
  write(join(directory, 'Cookies'), 'fixture-cookie-store');
  write(join(directory, 'IndexedDB', 'store.leveldb'), 'fixture-indexeddb');
  write(join(directory, 'memory', 'session-token.md'), 'fixture-token-file');
  return { directory };
}

/** A fake ~/.gemini with both Antigravity application directories. */
export function antigravityFixture(root) {
  const gemini = join(root, 'gemini');
  const app = join(gemini, 'antigravity');
  write(join(app, 'knowledge', 'tram-timetable', 'metadata.json'), JSON.stringify({ title: 'Tram timetable', summary: 'Weekday and weekend tram frequencies.', updated_at: '2026-05-06T07:08:09Z', a_new_field: [] }));
  write(join(app, 'knowledge', 'tram-timetable', 'artifacts', 'weekday.md'), '# Weekday\nTrams run every eight minutes.\n');
  write(join(app, 'knowledge', 'tram-timetable', 'artifacts', 'notes.bin'), Buffer.from([0, 1, 2, 3]));
  write(join(app, 'knowledge', 'broken-item', 'metadata.json'), '{ not json');
  write(join(app, 'knowledge', 'broken-item', 'artifacts', 'route.md'), 'Line 4 ends at the harbour.\n');
  const brain = join(app, 'brain', 'fixture-brain-1');
  write(join(brain, '.system_generated', 'logs', 'transcript.jsonl'), lines([
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', step_index: 0, created_at: '2026-05-06T07:00:00Z', content: 'Plan a tram route from the museum to the harbour.' },
    { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 1, created_at: '2026-05-06T07:00:05Z', tool_calls: [{ name: 'fixture_tool', args: { Path: '/fixture' } }] },
    { type: 'GENERIC', source: 'MODEL', step_index: 2, content: 'fixture tool output that must not be shared' },
    { type: 'PLANNER_RESPONSE', source: 'MODEL', step_index: 3, created_at: '2026-05-06T07:00:09Z', content: 'Take line 4 and change at Market Square.' },
    { type: 'A_STEP_TYPE_FROM_THE_FUTURE', content: 'ignored' },
  ]));
  write(join(brain, 'implementation_plan.md'), '# Plan\n1. Survey the stops.\n');
  write(join(brain, '.system_generated', 'hidden.md'), 'must not be listed\n');
  write(join(app, 'conversations', 'fixture.db'), Buffer.from([9, 9, 9]));
  write(join(app, 'agyhub_summaries_proto.pb'), Buffer.from([8, 8, 8]));
  write(join(gemini, 'antigravity-ide', 'knowledge', 'ferry', 'artifacts', 'crossing.md'), 'The ferry crosses every half hour.\n');
  write(join(gemini, 'antigravity-ide', 'brain', 'fixture-brain-2', 'transcript.jsonl'), lines([
    { type: 'USER_INPUT', content: 'When is the last ferry?' },
    { type: 'PLANNER_RESPONSE', content: 'The last ferry leaves at 23:15.' },
  ]));
  return { gemini };
}

/** Every fake location in one temporary root. */
export function allFixtures(root) {
  const codex = codexFixture(root);
  const claude = claudeCodeFixture(root);
  const zip = claudeExportFixture(root);
  const desktop = claude3pFixture(root);
  const antigravity = antigravityFixture(root);
  const dataDir = join(root, 'bridge-data');
  return {
    codex, claude, zip, desktop, antigravity, dataDir,
    locations: { codexHome: codex.home, claudeHome: claude.home, claude3pDir: desktop.directory, geminiDir: antigravity.gemini, dataDir },
  };
}
