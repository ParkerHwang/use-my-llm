import { CONTEXT_NOTICE, validContext, type ContextEntry } from './prompt.mjs';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const DEFAULT_MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const TIMEOUT = Symbol('Claude API timeout');

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeApiOptions {
  message?: string;
  history?: readonly HistoryTurn[];
  /** User-approved snapshot text resolved by the bridge. */
  context?: readonly ContextEntry[];
  signal?: AbortSignal;
  /** Trusted local configuration only. */
  env?: NodeJS.ProcessEnv;
  /** Trusted local configuration only. */
  fetchImpl?: typeof globalThis.fetch;
}

export interface ClaudeApiReply {
  provider: 'claude';
  reply: string;
}

const ERRORS = {
  INVALID_REQUEST: 'Invalid Claude message or conversation history.',
  PROVIDER_UNAVAILABLE: 'Claude requires a valid local model setting and an Anthropic API key.',
  PROVIDER_AUTH_FAILED: 'The Claude API rejected the locally configured credential.',
  PROVIDER_FAILED: 'The Claude API did not return a usable reply.',
  PROVIDER_TIMEOUT: 'The Claude API did not reply before the time limit.',
  PROVIDER_OUTPUT_LIMIT: 'The Claude API exceeded the response size limit.',
  PROVIDER_ABORTED: 'The Claude request was cancelled.',
};

class ClaudeApiError extends Error {
  readonly code: keyof typeof ERRORS;

  constructor(code: keyof typeof ERRORS) {
    super(ERRORS[code]);
    this.code = code;
  }
}

export function claudeApiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.hasOwn(env, 'ANTHROPIC_API_KEY');
}

function localModel(env: NodeJS.ProcessEnv): string {
  const model = Object.hasOwn(env, 'LOCALHOSTAGENT_CLAUDE_MODEL')
    ? env.LOCALHOSTAGENT_CLAUDE_MODEL
    : DEFAULT_MODEL;
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {
    throw new ClaudeApiError('PROVIDER_UNAVAILABLE');
  }
  return model;
}

function localWorkspaceId(env: NodeJS.ProcessEnv): string | undefined {
  const workspaceId = env.LOCALHOSTAGENT_CLAUDE_WORKSPACE_ID;
  if (workspaceId === undefined) return undefined;
  // Anthropic validates workspace IDs. Restrict the local value to safe header characters.
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(workspaceId)) {
    throw new ClaudeApiError('PROVIDER_UNAVAILABLE');
  }
  return workspaceId;
}

function requestBody(
  model: string, message: string | undefined, history: readonly HistoryTurn[], context?: readonly ContextEntry[],
): string {
  const entries = validContext(context);
  if (!entries) throw new ClaudeApiError('INVALID_REQUEST');
  if (typeof message !== 'string' || !message.trim() || message.length > 12_000 ||
      !Array.isArray(history) || history.length > 24) {
    throw new ClaudeApiError('INVALID_REQUEST');
  }
  const messages: HistoryTurn[] = [];
  for (const turn of history) {
    if (!turn || !['user', 'assistant'].includes(turn.role) ||
        typeof turn.content !== 'string' || turn.content.length > 16_000) {
      throw new ClaudeApiError('INVALID_REQUEST');
    }
    if (turn.content.trim()) messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: message });
  // The size limit covers what the website wrote; approved context has its own limit.
  if (Buffer.byteLength(JSON.stringify({ model, max_tokens: MAX_TOKENS, messages })) > MAX_INPUT_BYTES) {
    throw new ClaudeApiError('INVALID_REQUEST');
  }
  return JSON.stringify({
    model,
    max_tokens: MAX_TOKENS,
    // Shared context travels as quoted JSON data, apart from the conversation turns.
    ...(entries.length && { system: `${CONTEXT_NOTICE}\n\n${JSON.stringify({ context: entries })}` }),
    messages,
  });
}

function discard(stream: { cancel(): Promise<unknown> } | null) {
  if (stream) void stream.cancel().catch(() => {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readReply(response: Response, signal: AbortSignal, apiKey: string): Promise<string> {
  if (!response.body) throw new ClaudeApiError('PROVIDER_FAILED');
  if (Number(response.headers.get('content-length')) > MAX_OUTPUT_BYTES) {
    discard(response.body);
    throw new ClaudeApiError('PROVIDER_OUTPUT_LIMIT');
  }

  const reader = response.body.getReader();
  const abort = () => discard(reader);
  const chunks: Buffer[] = [];
  let bytes = 0;
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        discard(reader);
        throw new ClaudeApiError('PROVIDER_OUTPUT_LIMIT');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }

  const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!isRecord(envelope) || envelope.type !== 'message' || envelope.role !== 'assistant' ||
      !Array.isArray(envelope.content)) {
    throw new ClaudeApiError('PROVIDER_FAILED');
  }
  const content: unknown[] = envelope.content;
  const reply = content
    .flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('');
  if (!reply.trim() || reply.includes(apiKey)) throw new ClaudeApiError('PROVIDER_FAILED');
  return reply;
}

// env and fetchImpl are trusted local process configuration. The bridge passes
// only conversation content and a cancellation signal from the request path.
export async function runClaudeApi({
  message, history = [], context, signal, env = process.env, fetchImpl = globalThis.fetch,
}: ClaudeApiOptions = {}): Promise<ClaudeApiReply> {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new ClaudeApiError('INVALID_REQUEST');
  if (signal?.aborted) throw new ClaudeApiError('PROVIDER_ABORTED');

  const deadline = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = requestBody(localModel(env), message, history, context);
    const apiKey = claudeApiConfigured(env) ? env.ANTHROPIC_API_KEY : undefined;
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) {
      throw new ClaudeApiError('PROVIDER_UNAVAILABLE');
    }
    const workspaceId = localWorkspaceId(env);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': API_VERSION,
      'Content-Type': 'application/json',
    };
    if (workspaceId !== undefined) headers['anthropic-workspace-id'] = workspaceId;

    timeout = setTimeout(() => deadline.abort(TIMEOUT), TIMEOUT_MS);
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      signal: requestSignal,
      headers,
      body,
    });
    if (!response.ok) {
      discard(response.body);
      const authFailure = response.status === 401 || response.status === 403;
      throw new ClaudeApiError(authFailure ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_FAILED');
    }
    const reply = await readReply(response, requestSignal, apiKey);
    requestSignal.throwIfAborted();
    return { provider: 'claude', reply };
  } catch (error) {
    if (requestSignal.aborted) {
      throw new ClaudeApiError(requestSignal.reason === TIMEOUT ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ABORTED');
    }
    if (error instanceof ClaudeApiError) throw error;
    throw new ClaudeApiError('PROVIDER_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}
