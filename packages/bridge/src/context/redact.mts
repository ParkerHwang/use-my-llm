/**
 * Secret redaction applied before any selected text is stored or shared.
 *
 * This is a best-effort filter for well-known credential shapes. It prefers
 * removing too much over too little, and it is not a guarantee: users are
 * still told that a website can read whatever they share.
 */

export interface RedactionResult {
  text: string;
  /** Number of replaced spans. */
  count: number;
  /** Distinct kinds that were replaced, for display in the picker. */
  kinds: string[];
}

type Rule = readonly [kind: string, pattern: RegExp, replacement?: string];

const SECRET_NAME =
  '(?:secret|passw(?:or)?d|passphrase|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|token)';

const RULES: readonly Rule[] = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['slack-token', /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['authorization', /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [REDACTED:authorization]'],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED:url-credentials]@'],
  // NAME=value, NAME: value and "name": "value" where the name looks secret.
  [
    'assignment',
    new RegExp(
      `((?:^|[\\s"'\`{,;(])(?:export\\s+)?["']?[A-Za-z0-9_.-]*${SECRET_NAME}["']?\\s*[:=]\\s*)` +
        `("[^"\\n]{8,}"|'[^'\\n]{8,}'|[^\\s"',;]{8,})`,
      'gim',
    ),
    '$1[REDACTED:assignment]',
  ],
];

const ENV_LINE = /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]{2,}=)(\S.*)$/;

/** A run of three or more KEY=value lines is treated as pasted .env content. */
function redactEnvBlocks(text: string, tally: Map<string, number>): string {
  const lines = text.split('\n');
  let start = -1;
  const flush = (end: number) => {
    if (start !== -1 && end - start >= 3) {
      for (let index = start; index < end; index += 1) {
        const match = ENV_LINE.exec(lines[index]);
        if (match && !match[2].startsWith('[REDACTED:')) {
          lines[index] = `${match[1]}[REDACTED:env]`;
          tally.set('env', (tally.get('env') ?? 0) + 1);
        }
      }
    }
    start = -1;
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (ENV_LINE.test(lines[index])) {
      if (start === -1) start = index;
    } else {
      flush(index);
    }
  }
  flush(lines.length);
  return lines.join('\n');
}

export function redactSecrets(input: string): RedactionResult {
  const tally = new Map<string, number>();
  let text = input;
  for (const [kind, pattern, replacement] of RULES) {
    text = text.replace(pattern, (...args: unknown[]) => {
      // A value that an earlier rule already replaced is not counted twice.
      if (kind === 'assignment' && String(args[2]).replace(/^["']/, '').startsWith('[REDACTED:')) return String(args[0]);
      tally.set(kind, (tally.get(kind) ?? 0) + 1);
      if (replacement === undefined) return `[REDACTED:${kind}]`;
      // Expand $1-style groups by hand: a replacement function receives the groups.
      return replacement.replace(/\$(\d)/g, (_match, group: string) => String(args[Number(group)] ?? ''));
    });
  }
  text = redactEnvBlocks(text, tally);
  let count = 0;
  for (const value of tally.values()) count += value;
  return { text, count, kinds: [...tally.keys()].sort() };
}

/** Redact every string inside a parsed JSON value. Keys are left unchanged. */
export function redactDeep(value: unknown, tally = { count: 0 }): unknown {
  if (typeof value === 'string') {
    const result = redactSecrets(value);
    tally.count += result.count;
    return result.text;
  }
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, tally));
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = redactDeep(item, tally);
    return copy;
  }
  return value;
}
