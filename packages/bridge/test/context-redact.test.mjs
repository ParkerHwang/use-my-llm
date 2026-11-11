import assert from 'node:assert/strict';
import test from 'node:test';
import { redactDeep, redactSecrets } from '../dist/context/redact.mjs';
import { SECRETS } from '../test-support/fixtures.mjs';

test('known credential formats are replaced before text is stored', () => {
  const input = [
    `anthropic ${SECRETS.anthropic}`,
    `openai ${SECRETS.openai}`,
    `github ${SECRETS.github}`,
    `aws ${SECRETS.aws}`,
    `jwt ${SECRETS.jwt}`,
    `Authorization: Bearer ${'t0k3n'.repeat(6)}`,
    `clone https://deploy:${SECRETS.password}@git.fixture.invalid/repo.git`,
    SECRETS.privateKey,
  ].join('\n');
  const result = redactSecrets(input);
  for (const secret of [SECRETS.anthropic, SECRETS.openai, SECRETS.github, SECRETS.aws, SECRETS.jwt, 't0k3n'.repeat(6), SECRETS.password]) {
    assert.equal(result.text.includes(secret), false, `still contains ${secret.slice(0, 6)}…`);
  }
  assert.equal(result.text.includes('TUlJRXZn'), false);
  assert.equal(result.text.includes('git.fixture.invalid/repo.git'), true);
  assert.equal(result.count >= 8, true);
  for (const kind of ['anthropic-key', 'openai-key', 'github-token', 'aws-key', 'jwt', 'authorization', 'url-credentials', 'private-key']) {
    assert.equal(result.kinds.includes(kind), true, kind);
  }
});

test('secret-looking assignments and pasted .env blocks lose their values but keep their names', () => {
  const env = ['DATABASE_URL=postgres://fixture/db', 'SESSION_SECRET=abcdefgh12345678', 'FEATURE_FLAG=on', 'PORT=8080'].join('\n');
  const result = redactSecrets(`config:\n  "client_secret": "s3cr3t-value-123",\n  password = hunter2hunter2\n${env}\nDone.`);
  assert.equal(result.text.includes('s3cr3t-value-123'), false);
  assert.equal(result.text.includes('hunter2hunter2'), false);
  assert.equal(result.text.includes('postgres://fixture/db'), false);
  assert.equal(result.text.includes('abcdefgh12345678'), false);
  assert.match(result.text, /"client_secret": \[REDACTED:assignment\]/);
  assert.match(result.text, /^DATABASE_URL=\[REDACTED:env\]$/m);
  assert.match(result.text, /^PORT=\[REDACTED:env\]$/m);
  assert.equal(result.text.endsWith('Done.'), true);
});

test('ordinary prose and code are left alone', () => {
  const input = 'The token ring network used max_tokens: 1024 and the author: Jane wrote "password rules" in chapter 3.\nconst total = price * count;';
  assert.deepEqual(redactSecrets(input), { text: input, count: 0, kinds: [] });
});

test('redactDeep rewrites every string value and leaves structure and keys intact', () => {
  const tally = { count: 0 };
  const value = redactDeep({ id: 7, nested: [{ note: `key ${SECRETS.anthropic}` }, null, true], [SECRETS.aws]: 'kept as a key' }, tally);
  assert.deepEqual(value, { id: 7, nested: [{ note: 'key [REDACTED:anthropic-key]' }, null, true], [SECRETS.aws]: 'kept as a key' });
  assert.equal(tally.count, 1);
});
