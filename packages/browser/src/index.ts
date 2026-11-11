/**
 * use-my-llm: browser client for the local bridge (protocol v1, with the v1.1 shared-context additions).
 *
 * Dependency-free ESM. See docs/PROTOCOL.md for the contract this implements.
 *
 * Security posture (everything fails closed):
 * - The bridge URL must be exactly `http://127.0.0.1:<port>`; a website can
 *   never point the client (and therefore a bearer token) at a remote host.
 * - Tokens live only in sessionStorage (tab + origin scoped), are never put in
 *   URLs, thrown errors or the console, and are not reachable from the client
 *   object.
 * - The pairing callback fragment is removed synchronously, before any other
 *   work, and is only accepted when it matches the nonce this tab generated.
 */

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:43189';
export const PROVIDERS = Object.freeze(['codex', 'claude', 'antigravity'] as const);
export type ProviderId = (typeof PROVIDERS)[number];

/** Error codes produced by the client itself. The bridge's own `error.code` values are passed through as-is. */
export type ClientErrorCode =
  | 'invalid_options'
  | 'invalid_bridge_url'
  | 'invalid_origin'
  | 'invalid_return_url'
  | 'invalid_request'
  | 'invalid_callback'
  | 'invalid_response'
  | 'environment_unavailable'
  | 'storage_unavailable'
  | 'callback_cleanup_failed'
  | 'pairing_not_pending'
  | 'pairing_expired'
  | 'pairing_nonce_mismatch'
  | 'not_paired'
  | 'unsupported_provider'
  | 'request_too_large'
  | 'aborted'
  | 'disconnected'
  | 'bridge_unreachable'
  | 'bridge_error';

interface BrowserApis {
  location: Pick<Location, 'href' | 'origin' | 'hash' | 'assign' | 'replace'>;
  history: Pick<History, 'state' | 'replaceState'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  crypto: Pick<Crypto, 'getRandomValues'>;
}

export interface ClientOptions extends Partial<BrowserApis> {
  /**
   * Base URL of the local bridge. Must be exactly `http://127.0.0.1:<port>`;
   * any other host, scheme, path or embedded credentials throws
   * `invalid_bridge_url`. Defaults to {@link DEFAULT_BRIDGE_URL}.
   */
  bridgeUrl?: string;
  /** Injectable browser APIs (default: the globals). Intended for tests. */
  fetch?: typeof globalThis.fetch;
  /** Clock in milliseconds, used only for pairing-attempt expiry. */
  now?: () => number;
}

export interface PairOptions {
  /**
   * Where the bridge sends the user back after approval. Must resolve to this
   * page's exact origin (relative URLs are resolved against the current page).
   * Defaults to the current page. Its path and query are preserved; a fragment
   * is kept in this tab and restored by `completePairing()`.
   */
  returnUrl?: string;
}

export type PairingResult =
  /** The callback was verified and the session token stored for this tab. */
  | { paired: true }
  /** The current URL carries no pairing callback; nothing was changed. */
  | { paired: false; reason: 'no_callback' };

export interface ProviderStatus {
  id: ProviderId;
  available: boolean;
}

export interface BridgeStatus {
  service: 'localhost-agent-sdk';
  version: 1;
  /** `true` only when the bridge accepted this tab's token for this origin. */
  connected: boolean;
  /** Empty unless `connected` is `true`. */
  providers: ProviderStatus[];
  /** Present, and `true`, only when the connected bridge supports shared context (protocol v1.1). */
  context?: true;
}

/**
 * Something the user chose, on their own computer, to share with this website.
 * The handle is opaque: it carries no session id, thread name or file path,
 * and it only works for this website's origin.
 */
export interface SharedContext {
  handle: string;
  /** The app the content came from. */
  app: 'codex' | 'claude-code' | 'claude-desktop' | 'antigravity';
  /** `fork` is a whole conversation the named provider can continue as a copy. */
  kind: 'messages' | 'memory' | 'instructions' | 'knowledge' | 'fork';
  /** A generic description, or a name the user typed when sharing. */
  label: string;
  bytes: number;
  createdAt: string;
  /** Present on `fork` handles: the only provider that can continue it. */
  provider?: ProviderId;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  provider: ProviderId;
  message: string;
  history?: readonly ChatMessage[];
  /**
   * Handles from `contexts()` to attach as quoted reference material. The
   * content is sent to the selected provider's company.
   */
  context?: readonly string[];
  /**
   * A `fork` handle from `contexts()`: continue that shared conversation as a
   * copy. Requires the handle's own provider and no `history`.
   */
  continue?: string;
  /** Aborting rejects the call with code `aborted`. */
  signal?: AbortSignal | null;
}

export interface ChatResult {
  provider: ProviderId;
  reply: string;
}

export interface GenerateOptions {
  provider: ProviderId;
  /** Text input for one self-contained AI operation. */
  input: string;
  /** Handles from `contexts()` to attach as quoted reference material. */
  context?: readonly string[];
  signal?: AbortSignal | null;
}

export interface GenerateResult {
  provider: ProviderId;
  output: string;
}

export interface DisconnectResult {
  disconnected: true;
}

export interface UseMyLlmClient {
  /**
   * Starts pairing by navigating this tab to the bridge's local approval page.
   * The page unloads on success; the promise rejects if pairing cannot start
   * (`invalid_origin`, `invalid_return_url`, `environment_unavailable`,
   * `storage_unavailable`).
   */
  pair(options?: PairOptions): Promise<void>;
  /**
   * Call on page load. If the URL carries a pairing callback, the fragment is
   * removed synchronously (the pre-pairing fragment is restored) and the
   * callback is checked against the nonce this tab generated. Rejects, without
   * storing anything, on any mismatch (`pairing_nonce_mismatch`,
   * `pairing_not_pending`, `pairing_expired`, `invalid_callback`,
   * `callback_cleanup_failed`). Performs no network I/O.
   */
  completePairing(): Promise<PairingResult>;
  /**
   * Queries the bridge. A token the bridge no longer accepts is dropped from
   * this tab. Rejects with `bridge_unreachable` when the bridge is not running.
   */
  status(): Promise<BridgeStatus>;
  /**
   * Lists what the user has shared with this website's origin. Empty until the
   * user shares something from the local bridge; a website cannot request or
   * browse local conversations itself. Rejects with `not_paired` when this tab
   * has no session.
   */
  contexts(): Promise<SharedContext[]>;
  /** Run one self-contained text operation. Uses no previous conversation unless `context` handles are given. */
  generate(options: GenerateOptions): Promise<GenerateResult>;
  /**
   * Sends one request/response chat turn (no streaming). Rejects with
   * `not_paired` when this tab has no session, with the bridge's own error
   * code (and `status`) when the bridge refuses, and with `aborted` /
   * `disconnected` when cancelled.
   */
  chat(options: ChatOptions): Promise<ChatResult>;
  /**
   * Cancels this client's in-flight chats, forgets this tab's token, then asks
   * the bridge to revoke it. The local session is always cleared; the promise
   * rejects if the bridge could not confirm the revocation.
   */
  disconnect(): Promise<DisconnectResult>;
}

interface PendingPairing {
  nonce: string;
  origin: string;
  fragment: string;
  createdAt: number;
}

type CancelReason = 'aborted' | 'disconnected';

interface RequestOptions {
  token?: string | null;
  body?: string;
  signal?: AbortSignal;
  cancelReason?: () => CancelReason | null;
}

interface ActiveRequest {
  controller: AbortController;
  reason: CancelReason | null;
}

const SERVICE_NAME = 'localhost-agent-sdk';
const PROTOCOL_VERSION = 1;

const PARAM_PREFIX = 'localhostagent_';
const TOKEN_PARAM = 'localhostagent_token';
const NONCE_PARAM = 'localhostagent_nonce';
const STORAGE_PREFIX = 'localhostagent.v1';

const NONCE_BYTES = 32;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 500;

const BRIDGE_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/;
const HOSTNAME_PATTERN = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])$/;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
// Visible ASCII only, so a token is always safe inside an Authorization header.
const TOKEN_PATTERN = /^[\x21-\x7e]{16,4096}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const HANDLE_PATTERN = /^ctx_[A-Za-z0-9_-]{43}$/;
const MAX_CONTEXT_HANDLES = 8;
const CONTEXT_APPS = ['codex', 'claude-code', 'claude-desktop', 'antigravity'] as const;
const CONTEXT_KINDS = ['messages', 'memory', 'instructions', 'knowledge', 'fork'] as const;

/**
 * Client errors have fixed messages or sanitized messages from the local bridge.
 */
export class UseMyLlmError extends Error {
  override readonly name: 'UseMyLlmError';
  /** A {@link ClientErrorCode}, or the `error.code` returned by the bridge. */
  readonly code: ClientErrorCode | (string & {});
  /** HTTP status, present only when the bridge answered with a non-2xx response. */
  declare readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'UseMyLlmError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function fail(code: string, message: string, status?: number): UseMyLlmError {
  return new UseMyLlmError(code, message, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is ProviderId {
  return PROVIDERS.some((provider) => provider === value);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function redact(text: string, token: string | null): string {
  return token ? text.split(token).join('[redacted]') : text;
}

function normalizeBridgeUrl(value: unknown): string {
  if (value === undefined) return DEFAULT_BRIDGE_URL;
  const match = typeof value === 'string' ? BRIDGE_URL_PATTERN.exec(value) : null;
  if (!match || Number(match[1]) > 65535) {
    throw fail(
      'invalid_bridge_url',
      'bridgeUrl must be exactly http://127.0.0.1:<port>; remote or non-loopback bridges are not allowed.',
    );
  }
  return `http://127.0.0.1:${match[1]}`;
}

/** Exact https origin, or http://localhost:<port> / http://127.0.0.1:<port>. */
function assertWebOrigin(origin: unknown): string {
  const invalid = () =>
    fail(
      'invalid_origin',
      'This page origin cannot pair: it must be an https origin, or http://localhost:<port> / http://127.0.0.1:<port>.',
    );
  if (typeof origin !== 'string' || origin === 'null') throw invalid();
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw invalid();
  }
  // Round-tripping rejects paths, queries, fragments, credentials and non-canonical forms.
  if (parsed.origin !== origin || parsed.username || parsed.password) throw invalid();
  if (!HOSTNAME_PATTERN.test(parsed.hostname)) throw invalid();
  if (parsed.protocol === 'https:') return origin;
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol === 'http:' && loopback && parsed.port !== '') return origin;
  throw invalid();
}

function hashOf(location: BrowserApis['location']): string {
  return typeof location.hash === 'string' ? location.hash : '';
}

function parseFragment(hash: string): Array<[string, string | null]> {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (body === '') return [];
  return body.split('&').map<[string, string | null]>((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [part, null] : [part.slice(0, index), part.slice(index + 1)];
  });
}

/** The bridge callback fragment is exactly one token and one nonce; anything else is tampering. */
function readCallback(hash: string): { token: string; nonce: string } {
  const invalid = () => fail('invalid_callback', 'The pairing callback was malformed and has been discarded.');
  const params = parseFragment(hash);
  if (params.length !== 2) throw invalid();
  let token: string | undefined;
  let nonce: string | undefined;
  for (const [key, raw] of params) {
    if (raw === null) throw invalid();
    let value;
    try {
      value = decodeURIComponent(raw);
    } catch {
      throw invalid();
    }
    if (key === TOKEN_PARAM && token === undefined) token = value;
    else if (key === NONCE_PARAM && nonce === undefined) nonce = value;
    else throw invalid();
  }
  if (token === undefined || nonce === undefined) throw invalid();
  return { token, nonce };
}

function validateChatInput(input: ChatOptions): { provider: ProviderId; body: string; signal: AbortSignal | null } {
  const invalid = (message: string) => fail('invalid_request', message);
  if (!isRecord(input)) throw invalid('chat() requires an options object.');
  const { provider, message, history, signal, context, continue: continued } = input;
  if (!isProvider(provider)) {
    throw fail('unsupported_provider', `provider must be one of: ${PROVIDERS.join(', ')}.`);
  }
  if (typeof message !== 'string' || message.trim() === '') {
    throw invalid('message must be a non-empty string.');
  }
  const cleanHistory: ChatMessage[] = [];
  if (history !== undefined) {
    if (!Array.isArray(history)) throw invalid('history must be an array.');
    for (const entry of history as readonly unknown[]) {
      if (!isRecord(entry) || (entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.content !== 'string') {
        throw invalid('history entries must be { role: "user" | "assistant", content: string }.');
      }
      cleanHistory.push({ role: entry.role, content: entry.content });
    }
  }
  if (signal !== undefined && signal !== null) {
    if (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
      throw invalid('signal must be an AbortSignal.');
    }
  }
  const handles: string[] = [];
  if (context !== undefined) {
    if (!Array.isArray(context) || context.length > MAX_CONTEXT_HANDLES) {
      throw invalid(`context must be an array of at most ${MAX_CONTEXT_HANDLES} handles from contexts().`);
    }
    for (const handle of context as readonly unknown[]) {
      if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle) || handles.includes(handle)) {
        throw invalid('context entries must be distinct handles returned by contexts().');
      }
      handles.push(handle);
    }
  }
  if (continued !== undefined) {
    if (typeof continued !== 'string' || !HANDLE_PATTERN.test(continued) || handles.includes(continued)) {
      throw invalid('continue must be a fork handle returned by contexts().');
    }
    if (cleanHistory.length) throw invalid('continue cannot be combined with history.');
  }
  // Only whitelisted fields are ever serialized: no paths, flags, env or other caller-supplied keys.
  // Shared context is referred to by opaque handle only.
  const body = JSON.stringify({
    provider,
    message,
    history: cleanHistory,
    ...(handles.length && { context: handles }),
    ...(continued !== undefined && { continue: continued }),
  });
  if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) {
    throw fail('request_too_large', `The chat request exceeds the ${MAX_REQUEST_BYTES}-byte client limit.`);
  }
  return { provider, body, signal: signal ?? null };
}

function cancelError(reason: CancelReason): UseMyLlmError {
  return reason === 'disconnected'
    ? fail('disconnected', 'The chat request was cancelled because this session was disconnected.')
    : fail('aborted', 'The chat request was aborted.');
}

export function createClient(options: ClientOptions = {}): UseMyLlmClient {
  if (!isRecord(options)) throw fail('invalid_options', 'createClient() options must be an object.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw fail('invalid_options', 'options.fetch must be a function.');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw fail('invalid_options', 'options.now must be a function.');
  }

  const bridgeUrl = normalizeBridgeUrl(options.bridgeUrl);
  const tokenKey = `${STORAGE_PREFIX}.token:${bridgeUrl}`;
  const pendingKey = `${STORAGE_PREFIX}.pairing:${bridgeUrl}`;
  const now = options.now ?? Date.now;
  /** In-flight chat requests owned by this client only. */
  const active = new Set<ActiveRequest>();

  // Browser APIs are resolved lazily so createClient() is safe to call during SSR.
  function browserApi<Name extends keyof BrowserApis>(name: Name): BrowserApis[Name] {
    let value: BrowserApis[Name] | undefined;
    try {
      const overrides: Partial<BrowserApis> = options;
      const globals: BrowserApis = globalThis;
      value = overrides[name] ?? globals[name];
    } catch {
      value = undefined;
    }
    if (value === undefined || value === null) {
      throw fail('environment_unavailable', `${name} is not available in this environment.`);
    }
    return value;
  }

  const fetchImpl: typeof globalThis.fetch =
    (options.fetch as typeof globalThis.fetch | undefined) ??
    ((input, init) => {
      if (typeof globalThis.fetch !== 'function') {
        throw fail('environment_unavailable', 'fetch is not available in this environment.');
      }
      return globalThis.fetch(input, init);
    });

  function storage<Result>(operation: (store: BrowserApis['sessionStorage']) => Result): Result {
    try {
      return operation(browserApi('sessionStorage'));
    } catch {
      throw fail('storage_unavailable', 'sessionStorage is not available, so no session can be kept.');
    }
  }

  function readToken() {
    const value = storage((store) => store.getItem(tokenKey));
    return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
  }

  /** Drops the stored token only if it is still the one the failed request used. */
  function forgetToken(token: string): void {
    try {
      storage((store) => {
        if (store.getItem(tokenKey) === token) store.removeItem(tokenKey);
      });
    } catch {
      // Best effort: the bridge has already rejected this token.
    }
  }

  /** Pending pairing state is single-use: it is removed as soon as it is read. */
  function takePending(): PendingPairing | null {
    const raw = storage((store) => store.getItem(pendingKey));
    if (typeof raw !== 'string') return null;
    storage((store) => store.removeItem(pendingKey));
    let pending: unknown;
    try {
      pending = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isRecord(pending)) return null;
    const { nonce, origin, fragment, createdAt } = pending;
    if (
      typeof nonce !== 'string' ||
      !NONCE_PATTERN.test(nonce) ||
      typeof origin !== 'string' ||
      typeof fragment !== 'string' ||
      (fragment !== '' && !fragment.startsWith('#')) ||
      fragment.includes(PARAM_PREFIX) ||
      typeof createdAt !== 'number' ||
      !Number.isFinite(createdAt)
    ) return null;
    return { nonce, origin, fragment, createdAt };
  }

  function createNonce() {
    const crypto = browserApi('crypto');
    const unavailable = () =>
      fail('environment_unavailable', 'A cryptographically secure random source is required for pairing.');
    if (typeof crypto.getRandomValues !== 'function') throw unavailable();
    const bytes = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(bytes);
    if (bytes.every((byte) => byte === 0)) throw unavailable();
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return hex;
  }

  /** Replaces the callback fragment (and its history entry) with the pre-pairing fragment. */
  function scrubFragment(location: BrowserApis['location'], fragment: string): void {
    const href = String(location.href);
    const hashIndex = href.indexOf('#');
    // Absolute and same-document: path and query are preserved exactly.
    const base = hashIndex === -1 ? href : href.slice(0, hashIndex);
    const attempts = [
      () => {
        const history = browserApi('history');
        history.replaceState(history.state ?? null, '', `${base}${fragment}`);
      },
      // A bare "#" keeps this a fragment navigation, so the page is not reloaded.
      () => location.replace(`${base}${fragment || '#'}`),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch {
        continue;
      }
      if (!hashOf(location).includes(PARAM_PREFIX)) return;
    }
    throw fail('callback_cleanup_failed', 'The pairing callback could not be removed from the URL; pairing was abandoned.');
  }

  async function request(
    method: 'GET' | 'POST',
    path: '/v1/status' | '/v1/chat' | '/v1/context' | '/v1/disconnect',
    { token = null, body, signal, cancelReason }: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const throwIfCancelled = () => {
      const reason = cancelReason?.();
      if (reason) throw cancelError(reason);
    };
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    // Chromium's Local Network Access uses this hint for HTTPS → loopback.
    // The current TypeScript DOM definitions may not yet include it.
    const init: RequestInit & { targetAddressSpace: 'loopback' } = {
      method,
      headers,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      // Never follow redirects: a bearer token must only ever reach the loopback bridge.
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      targetAddressSpace: 'loopback',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = body;
    }
    if (signal) init.signal = signal;

    let response: Response;
    try {
      response = await fetchImpl(`${bridgeUrl}${path}`, init);
    } catch {
      throwIfCancelled();
      throw fail('bridge_unreachable', 'The local bridge could not be reached. Is it installed and running?');
    }
    throwIfCancelled();
    const invalidResponse = () => fail('invalid_response', 'The local bridge returned an unexpected response.');
    if (!response || typeof response !== 'object' || response.redirected) throw invalidResponse();

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    throwIfCancelled();

    if (!response.ok) {
      // 401 means the token is expired, revoked or not valid for this origin: stop using it.
      if (response.status === 401 && token) forgetToken(token);
      const detail: Record<string, unknown> = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
      const code =
        typeof detail.code === 'string' && ERROR_CODE_PATTERN.test(detail.code) && !(token && detail.code.includes(token))
          ? detail.code
          : 'bridge_error';
      const message =
        typeof detail.message === 'string' && detail.message !== ''
          ? redact(detail.message, token).slice(0, MAX_ERROR_MESSAGE_LENGTH)
          : `The local bridge rejected the request (HTTP ${response.status}).`;
      throw fail(code, message, response.status);
    }
    if (!isRecord(payload)) throw invalidResponse();
    return payload;
  }

  async function pair(pairOptions: PairOptions = {}): Promise<void> {
    if (!isRecord(pairOptions)) throw fail('invalid_request', 'pair() options must be an object.');
    const location = browserApi('location');
    const origin = assertWebOrigin(location.origin);

    const { returnUrl } = pairOptions;
    const invalidReturnUrl = () =>
      fail('invalid_return_url', 'returnUrl must be a URL on this exact origin without embedded credentials.');
    if (returnUrl !== undefined && typeof returnUrl !== 'string') throw invalidReturnUrl();
    let target: URL;
    try {
      target = new URL(returnUrl === undefined ? String(location.href) : returnUrl, String(location.href));
    } catch {
      throw invalidReturnUrl();
    }
    if (target.origin !== origin || target.username || target.password) throw invalidReturnUrl();

    // The bridge only accepts fragment-less callbacks. Keep the fragment in this tab and
    // restore it after pairing; never persist a stale callback fragment (it may hold a token).
    const fragment = target.hash.includes(PARAM_PREFIX) ? '' : target.hash;
    target.hash = '';

    const nonce = createNonce();
    storage((store) =>
      store.setItem(pendingKey, JSON.stringify({ nonce, origin, fragment, createdAt: now() })),
    );

    const pairUrl =
      `${bridgeUrl}/v1/pair?origin=${encodeURIComponent(origin)}` +
      `&return_url=${encodeURIComponent(target.href)}&nonce=${nonce}`;
    try {
      // Top-level navigation, not fetch: approval happens on a page served by the bridge.
      location.assign(pairUrl);
    } catch {
      try {
        storage((store) => store.removeItem(pendingKey));
      } catch {
        // Ignore: the pending record expires on its own.
      }
      throw fail('environment_unavailable', 'Navigation to the local bridge was blocked.');
    }
  }

  /** Synchronous on purpose: the fragment is gone before the caller's next line runs. */
  function completePairingNow(): PairingResult {
    const location = browserApi('location');
    const hash = hashOf(location);
    if (!hash.includes(PARAM_PREFIX)) return { paired: false, reason: 'no_callback' };

    let pending: PendingPairing | null = null;
    let storageError: unknown = null;
    try {
      pending = takePending();
    } catch (error) {
      storageError = error;
    }
    // Scrub first, validate afterwards: the token leaves the URL even when pairing is rejected.
    scrubFragment(location, pending ? pending.fragment : '');
    if (storageError) throw storageError;

    if (!pending) {
      throw fail('pairing_not_pending', 'No pairing was started from this tab; the callback was discarded.');
    }
    if (location.origin !== pending.origin) {
      throw fail('invalid_callback', 'The pairing callback arrived on a different origin and was discarded.');
    }
    const age = now() - pending.createdAt;
    if (!(age >= 0 && age <= PAIRING_TTL_MS)) {
      throw fail('pairing_expired', 'The pairing attempt expired; start pairing again.');
    }
    const callback = readCallback(hash);
    if (!safeEqual(callback.nonce, pending.nonce)) {
      throw fail('pairing_nonce_mismatch', 'The pairing callback did not match this tab; it was discarded.');
    }
    if (!TOKEN_PATTERN.test(callback.token)) {
      throw fail('invalid_callback', 'The pairing callback was malformed and has been discarded.');
    }
    storage((store) => store.setItem(tokenKey, callback.token));
    return { paired: true };
  }

  async function completePairing(): Promise<PairingResult> {
    return completePairingNow();
  }

  async function status(): Promise<BridgeStatus> {
    let token: string | null = null;
    try {
      token = readToken();
    } catch {
      // Without storage there is no session; an unauthenticated probe is still meaningful.
    }
    const payload = await request('GET', '/v1/status', { token });
    const invalidResponse = () => fail('invalid_response', 'The local bridge returned an unexpected response.');
    if (
      payload.service !== SERVICE_NAME ||
      payload.version !== PROTOCOL_VERSION ||
      typeof payload.connected !== 'boolean'
    ) {
      throw invalidResponse();
    }
    if (!payload.connected) {
      // The bridge no longer honours this token (expired or revoked).
      if (token) forgetToken(token);
      return { service: SERVICE_NAME, version: PROTOCOL_VERSION, connected: false, providers: [] };
    }
    if (!token || !Array.isArray(payload.providers)) throw invalidResponse();
    const providers: ProviderStatus[] = [];
    for (const entry of payload.providers as unknown[]) {
      if (isRecord(entry) && isProvider(entry.id) && typeof entry.available === 'boolean') {
        providers.push({ id: entry.id, available: entry.available });
      }
    }
    return {
      service: SERVICE_NAME,
      version: PROTOCOL_VERSION,
      connected: true,
      providers,
      ...(payload.context === true && { context: true as const }),
    };
  }

  async function contexts(): Promise<SharedContext[]> {
    const token = readToken();
    if (!token) throw fail('not_paired', 'This tab is not paired with the local bridge; call pair() first.');
    const payload = await request('GET', '/v1/context', { token });
    if (!Array.isArray(payload.contexts)) {
      throw fail('invalid_response', 'The local bridge returned an unexpected response.');
    }
    const shared: SharedContext[] = [];
    for (const entry of payload.contexts as unknown[]) {
      if (
        !isRecord(entry) ||
        typeof entry.handle !== 'string' ||
        !HANDLE_PATTERN.test(entry.handle) ||
        !CONTEXT_APPS.some((app) => app === entry.app) ||
        !CONTEXT_KINDS.some((kind) => kind === entry.kind) ||
        typeof entry.label !== 'string' ||
        typeof entry.bytes !== 'number' ||
        typeof entry.createdAt !== 'string'
      ) continue;
      shared.push({
        handle: entry.handle,
        app: entry.app as SharedContext['app'],
        kind: entry.kind as SharedContext['kind'],
        label: entry.label,
        bytes: entry.bytes,
        createdAt: entry.createdAt,
        ...(isProvider(entry.provider) && { provider: entry.provider }),
      });
    }
    return shared;
  }

  async function chat(chatOptions: ChatOptions): Promise<ChatResult> {
    const { provider, body, signal } = validateChatInput(chatOptions);
    if (signal?.aborted) throw cancelError('aborted');
    const token = readToken();
    if (!token) throw fail('not_paired', 'This tab is not paired with the local bridge; call pair() first.');

    const entry: ActiveRequest = { controller: new AbortController(), reason: null };
    const onAbort = () => {
      entry.reason ??= 'aborted';
      entry.controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    active.add(entry);
    try {
      const payload = await request('POST', '/v1/chat', {
        token,
        body,
        signal: entry.controller.signal,
        cancelReason: () => entry.reason,
      });
      if (payload.provider !== provider || typeof payload.reply !== 'string') {
        throw fail('invalid_response', 'The local bridge returned an unexpected response.');
      }
      return { provider, reply: payload.reply };
    } finally {
      active.delete(entry);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  // A one-shot text operation for embedding AI features into an existing page.
  // The local transport still uses the same approved /v1/chat endpoint.
  async function generate(options: GenerateOptions): Promise<GenerateResult> {
    if (!isRecord(options)) throw fail('invalid_request', 'generate() requires an options object.');
    const result = await chat({
      provider: options.provider,
      message: options.input,
      signal: options.signal,
      ...(options.context !== undefined && { context: options.context }),
    });
    return { provider: result.provider, output: result.reply };
  }

  async function disconnect(): Promise<DisconnectResult> {
    // Cancel only this client's own work.
    for (const entry of active) {
      entry.reason ??= 'disconnected';
      entry.controller.abort();
    }
    const token = readToken();
    // End the local session first so it is gone even if the bridge cannot be reached.
    storage((store) => {
      store.removeItem(pendingKey);
      store.removeItem(tokenKey);
    });
    if (!token) return { disconnected: true };

    let payload: Record<string, unknown>;
    try {
      payload = await request('POST', '/v1/disconnect', { token, body: '{}' });
    } catch (error) {
      // The bridge already considers this token invalid: nothing left to revoke.
      if (error instanceof UseMyLlmError && error.status === 401) return { disconnected: true };
      throw error;
    }
    if (payload.disconnected !== true) {
      throw fail('invalid_response', 'The local bridge returned an unexpected response.');
    }
    return { disconnected: true };
  }

  return Object.freeze({ pair, completePairing, status, contexts, generate, chat, disconnect });
}
