import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import {
  ContextError, HANDLE_PATTERN, MAX_CONTEXT_HANDLES,
  type ContextEntry, type ForkRecord, type PublicContext, type ResolvedContext,
} from "./context/types.mjs";

const HOST = "127.0.0.1";
const PROVIDERS = ["codex", "claude", "antigravity"] as const;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 64;
const MAX_SESSIONS = 64;
const MAX_ACTIVE = 4;
// Adapters use a bounded TERM/KILL sequence. Leave time for that sequence
// and workspace cleanup before the Mac launcher’s four-second deadline.
const SHUTDOWN_DRAIN_MS = 3_500;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export type ProviderId = typeof PROVIDERS[number];

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  provider: ProviderId;
  message: string;
  history: ChatTurn[];
  /** Opaque context handles (protocol v1.1). */
  context: string[];
  /** Opaque handle of a session shared as a continuable copy (protocol v1.1). */
  continueHandle?: string;
}

export interface ProviderRequest {
  provider: ProviderId;
  message: string;
  history: ChatTurn[];
  /** User-approved snapshot text, already resolved by the bridge. Present only when a request uses v1.1 context. */
  context?: ContextEntry[];
  /** Private details of a user-approved session copy to continue. */
  fork?: ForkRecord;
  signal: AbortSignal;
}

/** The part of the per-website permission store that the bridge uses. */
export interface ContextAccess {
  list(origin: string): PublicContext[];
  resolve(origin: string, handles: readonly string[]): ResolvedContext[];
  logAccess(entry: { origin: string; provider: string; snapshot: string; bytes: number }): void;
}

export interface ProviderReply {
  provider: ProviderId;
  reply: string;
}

export interface ProviderStatus {
  id: ProviderId;
  available: boolean;
}

export interface BridgeOptions {
  runProvider: (request: ProviderRequest) => ProviderReply | Promise<ProviderReply>;
  getProviders: () => readonly ProviderStatus[];
  port?: number;
  now?: () => number;
  sessionTtlMs?: number;
  pairingTtlMs?: number;
  requestTimeoutMs?: number;
  allowedOrigins?: readonly string[];
  /** Enables protocol v1.1 context handles. Without it every handle is refused. */
  context?: ContextAccess;
}

export interface Bridge {
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
  address(): AddressInfo | null;
}

interface PendingPairing {
  origin: string;
  callback: URL;
  nonce: string;
  expiresAt: number;
}

interface Session {
  origin: string;
  expiresAt: number;
  active: AbortController | null;
  attempts: number[];
}

type ExecutionOutcome = { kind: "reply"; result: ProviderReply } | { kind: "error"; error: unknown };

const PROVIDER_ERRORS = new Map<string, readonly [number, string]>([
  ["CODEX_NOT_FOUND", [503, "The Codex CLI is not installed."]],
  ["CODEX_UNSUPPORTED", [503, "This Codex CLI version is not supported."]],
  ["LOGIN_REQUIRED", [503, "Sign in using the provider's official local application."]],
  ["USAGE_LIMIT", [429, "The provider's usage limit was reached."]],
  ["CODEX_FAILED", [502, "Codex could not complete the request."]],
  ["OUTPUT_LIMIT", [502, "The provider returned too much output."]],
  ["EMPTY_RESPONSE", [502, "The provider returned an empty response."]],
  ["ABORTED", [409, "The request was canceled."]],
  ["TIMEOUT", [504, "The provider did not reply in time."]],
  ["INVALID_MESSAGE", [400, "The message or history is invalid."]],
  ["PROVIDER_UNAVAILABLE", [503, "This provider is unavailable."]],
  // Reserve 401 for bridge-session failures: an upstream credential failure
  // must not cause the browser SDK to discard an otherwise valid pairing.
  ["PROVIDER_AUTH_FAILED", [502, "The provider rejected its local API credential."]],
  ["PROVIDER_FAILED", [502, "The provider could not complete the request."]],
  ["PROVIDER_TIMEOUT", [504, "The provider did not reply in time."]],
  ["PROVIDER_OUTPUT_LIMIT", [502, "The provider returned too much output."]],
  ["PROVIDER_ABORTED", [409, "The request was canceled."]],
  ["INVALID_REQUEST", [400, "The request is invalid."]],
  ["CONTEXT_STALE", [409, "The shared conversation changed after it was shared. Share it again from the local bridge."]],
  ["CONTEXT_UNAVAILABLE", [503, "This shared conversation cannot be continued with the current local configuration."]],
  ["PROVIDER_TOOL_ACTIVITY", [502, "The provider attempted tool activity, so the reply was discarded."]],
]);

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

function secret() {
  return randomBytes(32).toString("base64url");
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function html(res: ServerResponse, title: string, content: string, origin?: string): void {
  // Chrome enforces form-action on the redirect from an HTML form submission.
  // Its Origin header is also affected by the submitting page's Referrer-Policy.
  const formAction = origin ? `'self' ${origin}` : "'none'";
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": origin ? "same-origin" : "no-referrer",
    "X-Frame-Options": "DENY",
  });
  res.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 1rem system-ui, sans-serif; margin: 8vh auto; padding: 0 1.25rem; max-width: 34rem; line-height: 1.6; color-scheme: light dark; }
  .origin { overflow-wrap: anywhere; font: 1rem ui-monospace, monospace; padding: .8rem; border: 1px solid currentColor; border-radius: .5rem; }
  button { font: inherit; cursor: pointer; margin: .5rem .5rem .5rem 0; padding: .4rem .8rem; }
</style>
<main><h1>${title}</h1>${content}</main>
</html>`);
}

function approvalPage(res: ServerResponse, origin: string, csrf: string): void {
  html(res, "Connect this website?", `
    <p class="origin">${escapeHtml(origin)}</p>
    <p>Allow this website to send chat requests to agents enabled in your local bridge? Requests can use your provider account and usage allowance.</p>
    <form method="POST" action="/v1/pair/approve">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit" name="decision" value="allow">Allow connection</button>
      <button type="submit" name="decision" value="deny">Decline</button>
    </form>
    <p>The website can disconnect at any time. Closing the bridge ends its access.</p>
  `, origin);
}

/** Accept only an exact https origin, or http://localhost:<port> / http://127.0.0.1:<port>. */
export function parseOrigin(origin: unknown): string | null {
  if (typeof origin !== "string" || origin.length > 300) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.port === "0") return null;
    if (url.protocol === "http:") {
      return ["localhost", HOST].includes(url.hostname) ? origin : null;
    }
    if (url.protocol !== "https:") return null;
    // The value also becomes a CSP host-source. URL parsing alone accepts
    // punctuation that could otherwise change the meaning of that directive.
    const safeHost = /^[a-z0-9.-]+$/.test(url.hostname)
      || (url.hostname.startsWith("[") && isIP(url.hostname.slice(1, -1)) === 6);
    return safeHost ? origin : null;
  } catch {
    return null;
  }
}

function parseCallback(raw: unknown, origin: string): URL | null {
  if (typeof raw !== "string" || raw.length > 4096 || /[#\\\s\u0000-\u001f\u007f]/u.test(raw)) {
    return null;
  }
  const authority = raw.match(/^https?:\/\/([^/?#]+)/u)?.[1];
  if (!authority || authority.includes("@")) return null;
  try {
    const url = new URL(raw);
    return url.origin === origin && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function headers(req: IncomingMessage, name: string): string[] {
  return req.headersDistinct[name] ?? [];
}

function header(req: IncomingMessage, name: string): string | undefined {
  const values = headers(req, name);
  return values.length === 1 ? values[0] : undefined;
}

function cors(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
}

function preflight(req: IncomingMessage, res: ServerResponse, origin: string | null, method: string): void {
  if (!origin) return fail(res, 403, "ORIGIN_DENIED", "This website origin is not allowed.");
  if (header(req, "access-control-request-method") !== method) {
    return fail(res, 403, "METHOD_DENIED", "This preflight method is not allowed.");
  }
  const requestedHeaders = header(req, "access-control-request-headers");
  if (headers(req, "access-control-request-headers").length > 1
    || requestedHeaders?.split(",").some((item) => !["authorization", "content-type"].includes(item.trim().toLowerCase()))) {
    return fail(res, 403, "HEADERS_DENIED", "This preflight header is not allowed.");
  }
  res.setHeader("Access-Control-Allow-Methods", method);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (header(req, "access-control-request-private-network") === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network");
  res.writeHead(204);
  res.end();
}

async function readBody(req: IncomingMessage, res: ServerResponse, limit: number, contentType: string): Promise<string> {
  const actualType = header(req, "content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (actualType !== contentType) {
    throw new RequestError(415, "CONTENT_TYPE", "The request content type is not supported.");
  }
  if (Number(header(req, "content-length")) > limit) {
    res.setHeader("Connection", "close");
    throw new RequestError(413, "BODY_TOO_LARGE", "The request body is too large.");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      res.setHeader("Connection", "close");
      throw new RequestError(413, "BODY_TOO_LARGE", "The request body is too large.");
    }
    chunks.push(chunk);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new RequestError(400, "INVALID_BODY", "The request body must be UTF-8.");
  }
}

function exactParams(params: URLSearchParams, names: readonly string[]): boolean {
  const keys = [...params.keys()];
  return keys.length === names.length && names.every((name) => params.getAll(name).length === 1);
}

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function isProviderId(value: unknown): value is ProviderId {
  return PROVIDERS.some((id) => id === value);
}

function isChatTurn(entry: unknown): entry is ChatTurn {
  return hasOnlyKeys(entry, ["role", "content"])
    && (entry.role === "user" || entry.role === "assistant")
    && typeof entry.content === "string" && entry.content.length <= 16_000;
}

function parseChat(raw: string): ChatRequest {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new RequestError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  if (!hasOnlyKeys(body, ["provider", "message", "history", "context", "continue"])) {
    throw new RequestError(400, "INVALID_REQUEST", "Only provider, message, history, context, and continue are accepted.");
  }
  const { provider, message, history = [], context = [], continue: continueHandle } = body;
  if (!isProviderId(provider)) {
    throw new RequestError(400, "INVALID_PROVIDER", "Select a supported provider ID.");
  }
  if (typeof message !== "string" || !message.trim() || message.length > 12_000
    || !Array.isArray(history) || history.length > 24 || JSON.stringify(history).length > 40_000
    || !history.every(isChatTurn)) {
    throw new RequestError(400, "INVALID_MESSAGE", "The message or history is invalid.");
  }
  // Websites refer to shared context only by opaque handle. Ids, names and
  // paths are never accepted here.
  const isHandle = (value: unknown): value is string => typeof value === "string" && HANDLE_PATTERN.test(value);
  if (!Array.isArray(context) || context.length > MAX_CONTEXT_HANDLES || !context.every(isHandle)
    || new Set(context).size !== context.length
    || (continueHandle !== undefined && (!isHandle(continueHandle) || context.includes(continueHandle)))) {
    throw new RequestError(400, "INVALID_CONTEXT", "The context handles are invalid.");
  }
  if (continueHandle !== undefined && history.length) {
    throw new RequestError(400, "INVALID_CONTEXT", "A continued conversation cannot also carry history.");
  }
  return { provider, message, history, context, ...(continueHandle !== undefined && { continueHandle }) };
}

function allowAttempt(attempts: number[], now: number, max: number, window: number): boolean {
  while (attempts.length && attempts[0] <= now - window) attempts.shift();
  if (attempts.length >= max) return false;
  attempts.push(now);
  return true;
}

function duration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be a positive duration in milliseconds.`);
  }
}

/**
 * Create a loopback-only use-my-llm v1 bridge. Trusted local code supplies
 * the provider runner and synchronous availability list. Runners should honor
 * AbortSignal to stop their own work when the request or session ends.
 */
export function createBridge({
  port = 43189,
  runProvider,
  getProviders,
  now = Date.now,
  sessionTtlMs = 30 * MINUTE,
  pairingTtlMs = 2 * MINUTE,
  requestTimeoutMs = 3 * MINUTE,
  allowedOrigins,
  context: contextAccess,
}: BridgeOptions): Bridge {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("Invalid bridge port.");
  if (typeof runProvider !== "function" || typeof getProviders !== "function" || typeof now !== "function") {
    throw new TypeError("runProvider, getProviders, and now must be functions.");
  }
  duration(sessionTtlMs, "sessionTtlMs");
  duration(pairingTtlMs, "pairingTtlMs");
  duration(requestTimeoutMs, "requestTimeoutMs");
  if (contextAccess !== undefined && (typeof contextAccess?.list !== "function"
    || typeof contextAccess.resolve !== "function" || typeof contextAccess.logAccess !== "function")) {
    throw new TypeError("context must provide list, resolve, and logAccess.");
  }
  if (allowedOrigins !== undefined
    && (!Array.isArray(allowedOrigins) || allowedOrigins.some((origin) => !parseOrigin(origin)))) {
    throw new TypeError("allowedOrigins must contain exact supported origins.");
  }
  const allowlist = allowedOrigins === undefined ? null : new Set(allowedOrigins);
  const pending = new Map<string, PendingPairing>();
  const sessions = new Map<string, Session>();
  // Track executions even when the corresponding session has been revoked.
  const executions = new Set<Promise<ExecutionOutcome>>();
  const pairAttempts: number[] = [];
  const chatAttempts: number[] = [];
  let listenPromise: Promise<AddressInfo> | undefined;
  let closePromise: Promise<void> | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;

  function allowedOrigin(raw: unknown): string | null {
    const origin = parseOrigin(raw);
    return origin && (!allowlist || allowlist.has(origin)) ? origin : null;
  }

  function revoke(token: string, session: Session): void {
    sessions.delete(token);
    session.active?.abort("session-ended");
  }

  function expire() {
    const time = now();
    for (const [csrf, pair] of pending) if (pair.expiresAt <= time) pending.delete(csrf);
    for (const [token, session] of sessions) if (session.expiresAt <= time) revoke(token, session);
  }

  function authenticate(req: IncomingMessage, origin: string | null) {
    const auth = header(req, "authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
    const token = auth?.[1];
    if (!token || !origin) return null;
    const session = sessions.get(token);
    if (!session || session.origin !== origin) return null;
    if (session.expiresAt <= now()) {
      revoke(token, session);
      return null;
    }
    return { token, session };
  }

  function providers(): ProviderStatus[] {
    const list = getProviders();
    if (!Array.isArray(list)) throw new TypeError("getProviders must return an array.");
    return PROVIDERS.map((id) => ({
      id,
      available: list.some((item) => item?.id === id && item.available === true),
    }));
  }

  function pair(req: IncomingMessage, res: ServerResponse, url: URL, localOrigin: string): void {
    const fetchDestination = header(req, "sec-fetch-dest");
    const requestOrigin = header(req, "origin");
    if ((fetchDestination && fetchDestination !== "document")
      || (headers(req, "origin").length && requestOrigin !== localOrigin)) {
      return fail(res, 403, "NAVIGATION_REQUIRED", "Open the approval page in a browser tab.");
    }
    if (!exactParams(url.searchParams, ["origin", "return_url", "nonce"])) {
      return fail(res, 400, "INVALID_PAIRING", "The pairing request is invalid.");
    }
    const origin = allowedOrigin(url.searchParams.get("origin"));
    const callback = origin && parseCallback(url.searchParams.get("return_url"), origin);
    const nonce = url.searchParams.get("nonce");
    if (!origin || !callback || !nonce || !NONCE.test(nonce)) {
      return fail(res, 400, "INVALID_PAIRING", "The website, return URL, or nonce is invalid.");
    }
    if (pending.size >= MAX_PENDING || !allowAttempt(pairAttempts, now(), 30, MINUTE)) {
      return fail(res, 429, "RATE_LIMIT", "Too many pairing attempts. Wait and try again.");
    }
    const csrf = secret();
    pending.set(csrf, { origin, callback, nonce, expiresAt: now() + pairingTtlMs });
    approvalPage(res, origin, csrf);
  }

  async function approve(req: IncomingMessage, res: ServerResponse, localOrigin: string): Promise<void> {
    if (header(req, "origin") !== localOrigin) {
      return fail(res, 403, "ORIGIN_DENIED", "Use the local approval page to connect.");
    }
    const body = new URLSearchParams(await readBody(req, res, 4096, "application/x-www-form-urlencoded"));
    const csrf = body.get("csrf");
    const decision = body.get("decision");
    if (!exactParams(body, ["csrf", "decision"]) || !csrf || !KEY.test(csrf) || (decision !== "allow" && decision !== "deny")) {
      return fail(res, 400, "INVALID_APPROVAL", "The approval form is invalid.");
    }
    const entry = pending.get(csrf);
    pending.delete(csrf);
    if (!entry || entry.expiresAt <= now()) {
      return fail(res, 410, "PAIRING_EXPIRED", "Start a new connection from the website.");
    }
    if (decision === "deny") {
      return html(res, "Connection declined", `<p><a href="${escapeHtml(entry.callback.href)}">Return to the website</a></p>`);
    }
    if (sessions.size >= MAX_SESSIONS) {
      return fail(res, 429, "SESSION_LIMIT", "Disconnect an existing session before pairing again.");
    }
    const token = secret();
    sessions.set(token, { origin: entry.origin, expiresAt: now() + sessionTtlMs, active: null, attempts: [] });
    entry.callback.hash = new URLSearchParams({
      localhostagent_token: token,
      localhostagent_nonce: entry.nonce,
    }).toString();
    res.writeHead(303, { Location: entry.callback.href, "Referrer-Policy": "no-referrer" });
    res.end();
  }

  /**
   * Turn a request's handles into approved snapshot text for exactly this
   * origin. A handle that is unknown, revoked or owned by another website is
   * refused with one indistinguishable error.
   */
  function resolveContext(request: ChatRequest, origin: string): { used: ResolvedContext[]; entries: ContextEntry[]; fork?: ForkRecord } {
    const handles = request.continueHandle ? [...request.context, request.continueHandle] : request.context;
    if (!handles.length) return { used: [], entries: [] };
    if (!contextAccess) throw new RequestError(403, "CONTEXT_DENIED", "This context is not shared with this website.");
    let used: ResolvedContext[];
    try {
      used = contextAccess.resolve(origin, handles);
    } catch (error) {
      if (error instanceof ContextError && error.code === "CONTEXT_TOO_LARGE") {
        throw new RequestError(413, "CONTEXT_TOO_LARGE", "The selected context is too large for one request.");
      }
      throw new RequestError(403, "CONTEXT_DENIED", "This context is not shared with this website.");
    }
    const continued = request.continueHandle ? used[used.length - 1] : undefined;
    const attached = continued ? used.slice(0, -1) : used;
    if (attached.some((item) => item.kind === "fork") || (continued && (continued.kind !== "fork" || !continued.fork))) {
      throw new RequestError(400, "INVALID_CONTEXT", "Use context for shared text and continue for a shared conversation copy.");
    }
    if (continued?.fork && continued.fork.provider !== request.provider) {
      throw new RequestError(400, "CONTEXT_PROVIDER_MISMATCH", "This conversation copy can only be continued with its own provider.");
    }
    return {
      used,
      entries: attached.map((item) => item.entry),
      ...(continued?.fork && { fork: continued.fork }),
    };
  }

  async function chat(req: IncomingMessage, res: ServerResponse, origin: string | null): Promise<void> {
    const request = parseChat(await readBody(req, res, MAX_REQUEST_BYTES, "application/json"));
    // Reading a request body is asynchronous. Recheck authentication immediately
    // before dispatch so a disconnect during the read cannot start new work.
    const auth = authenticate(req, origin);
    if (!auth) return fail(res, 401, "UNAUTHORIZED", "Connect this website again.");
    const { token, session } = auth;
    if (res.destroyed) return;
    if (session.active || executions.size >= MAX_ACTIVE) {
      return fail(res, 409, "BUSY", "Wait for an active request to finish.");
    }
    if (!providers().find(({ id }) => id === request.provider)?.available) {
      return fail(res, 503, "PROVIDER_UNAVAILABLE", "This provider is unavailable.");
    }
    const shared = resolveContext(request, session.origin);
    const time = now();
    if (!allowAttempt(session.attempts, time, 30, HOUR) || !allowAttempt(chatAttempts, time, 120, HOUR)) {
      return fail(res, 429, "RATE_LIMIT", "The bridge request limit was reached. Try again later.");
    }

    const controller = new AbortController();
    session.active = controller;
    const onClose = () => controller.abort("client-closed");
    res.once("close", onClose);
    const timeUntilExpiry = Math.max(1, session.expiresAt - time);
    const timer = setTimeout(() => controller.abort(
      timeUntilExpiry <= requestTimeoutMs ? "session-ended" : "timeout",
    ), Math.min(requestTimeoutMs, timeUntilExpiry));
    timer.unref();

    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<{ kind: "aborted" }>((resolve) => {
      onAbort = () => resolve({ kind: "aborted" });
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const execution: Promise<ExecutionOutcome> = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        // Metadata only: which snapshot left the machine, for which site and provider.
        for (const item of shared.used) {
          contextAccess?.logAccess({ origin: session.origin, provider: request.provider, snapshot: item.id, bytes: item.bytes });
        }
        return runProvider({
          provider: request.provider,
          message: request.message,
          history: request.history,
          ...(shared.entries.length && { context: shared.entries }),
          ...(shared.fork && { fork: shared.fork }),
          signal: controller.signal,
        });
      })
      .then<ExecutionOutcome, ExecutionOutcome>(
        (result) => ({ kind: "reply", result }),
        (error: unknown) => ({ kind: "error", error }),
      )
      .finally(() => {
        // An adapter that ignores cancellation still occupies its slot until
        // it settles. Otherwise aborted HTTP clients could keep spawning work.
        session.active = null;
        executions.delete(execution);
      });
    executions.add(execution);

    try {
      const outcome = await Promise.race([execution, interrupted]);
      if (controller.signal.aborted || outcome.kind === "aborted") {
        if (controller.signal.reason === "client-closed") return;
        if (controller.signal.reason === "timeout") {
          return fail(res, 504, "TIMEOUT", "The provider did not reply in time.");
        }
        if (session.expiresAt <= now()) revoke(token, session);
        return fail(res, 401, "UNAUTHORIZED", "Connect this website again.");
      }
      if (!authenticate(req, origin)) return fail(res, 401, "UNAUTHORIZED", "Connect this website again.");
      if (outcome.kind === "error") {
        const error = outcome.error;
        if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
          const known = PROVIDER_ERRORS.get(error.code);
          if (known) return fail(res, known[0], error.code, known[1]);
        }
        return fail(res, 502, "PROVIDER_FAILED", "The provider could not complete the request.");
      }
      const reply = outcome.result?.reply;
      if (outcome.result?.provider !== request.provider || typeof reply !== "string" || !reply.trim()) {
        return fail(res, 502, "INVALID_PROVIDER_RESPONSE", "The provider returned an invalid response.");
      }
      if (Buffer.byteLength(reply) > MAX_REPLY_BYTES) {
        return fail(res, 502, "OUTPUT_LIMIT", "The provider returned too much output.");
      }
      return json(res, 200, { provider: request.provider, reply });
    } finally {
      clearTimeout(timer);
      res.removeListener("close", onClose);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (closePromise) return fail(res, 503, "CLOSING", "The bridge is closing.");
    const address = server.address();
    if (!address || typeof address === "string") return fail(res, 503, "CLOSING", "The bridge is closing.");
    const local = new URL(`http://${HOST}:${address.port}`);
    if (header(req, "host") !== local.host) {
      return fail(res, 403, "INVALID_HOST", "Use the bridge's loopback address.");
    }
    if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) {
      return fail(res, 400, "INVALID_URL", "The request URL is invalid.");
    }
    const localOrigin = local.origin;
    const url = new URL(req.url, localOrigin);
    expire();

    if (url.pathname === "/v1/pair" || url.pathname === "/v1/pair/approve") {
      const method = url.pathname === "/v1/pair" ? "GET" : "POST";
      if (req.method !== method) {
        res.setHeader("Allow", method);
        return fail(res, 405, "METHOD_NOT_ALLOWED", "This method is not allowed.");
      }
      return method === "GET" ? pair(req, res, url, localOrigin) : approve(req, res, localOrigin);
    }

    const methods: Readonly<Record<string, "GET" | "POST" | undefined>> = {
      "/v1/status": "GET",
      "/v1/chat": "POST",
      "/v1/context": "GET",
      "/v1/disconnect": "POST",
    };
    const method = methods[url.pathname];
    if (!method) return fail(res, 404, "NOT_FOUND", "This endpoint does not exist.");

    const origin = allowedOrigin(header(req, "origin"));
    if (origin) cors(res, origin);
    if (req.method === "OPTIONS") return preflight(req, res, origin, method);
    if (headers(req, "origin").length && !origin) {
      return fail(res, 403, "ORIGIN_DENIED", "This website origin is not allowed.");
    }
    if (req.method !== method) {
      res.setHeader("Allow", `${method}, OPTIONS`);
      return fail(res, 405, "METHOD_NOT_ALLOWED", "This method is not allowed.");
    }

    const auth = authenticate(req, origin);
    if (url.pathname === "/v1/status") {
      return json(res, 200, {
        service: "localhost-agent-sdk",
        version: 1,
        connected: Boolean(auth),
        ...(auth && { providers: providers() }),
        // Advertised only by a bridge that has a context store configured.
        ...(auth && contextAccess && { protocol: "1.1", context: true }),
      });
    }
    if (!auth) return fail(res, 401, "UNAUTHORIZED", "Connect this website again.");
    if (url.pathname === "/v1/context") {
      // Only what this exact origin was given: opaque handles and coarse metadata.
      return json(res, 200, { contexts: contextAccess ? contextAccess.list(auth.session.origin) : [] });
    }
    if (url.pathname === "/v1/disconnect") {
      revoke(auth.token, auth.session);
      return json(res, 200, { disconnected: true });
    }
    return chat(req, res, origin);
  }

  const server = createServer({
    requestTimeout: 15_000,
    headersTimeout: 5_000,
    connectionsCheckingInterval: 1_000,
    maxHeaderSize: 8_192,
  }, (req, res) => {
    handle(req, res).catch((error) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      if (error instanceof RequestError) return fail(res, error.status, error.code, error.message);
      return fail(res, 500, "INTERNAL_ERROR", "The bridge could not complete the request.");
    });
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 64;

  function listen(): Promise<AddressInfo> {
    if (closePromise) return Promise.reject(new Error("The bridge is closed."));
    listenPromise ??= new Promise<AddressInfo>((resolve, reject) => {
      function onError(error: Error) {
        server.removeListener("listening", onListening);
        listenPromise = undefined;
        reject(error);
      }
      function onListening() {
        server.removeListener("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The bridge did not open a TCP listener."));
          return;
        }
        cleanupTimer = setInterval(expire, 5_000);
        cleanupTimer.unref();
        resolve(address);
      }
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ port, host: HOST, exclusive: true });
    });
    return listenPromise;
  }

  async function drainExecutions(): Promise<void> {
    if (!executions.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
    });
    try {
      await Promise.race([Promise.allSettled(executions), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      try { await listenPromise; } catch { /* No listener to stop. */ }
      clearInterval(cleanupTimer);
      pending.clear();
      for (const [token, session] of sessions) revoke(token, session);
      const closingServer = new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      // A listener failure must not skip the adapter cleanup window.
      try {
        await closingServer;
      } finally {
        await drainExecutions();
      }
    })();
    return closePromise;
  }

  return {
    listen,
    close,
    address() {
      const address = server.address();
      return typeof address === "string" ? null : address;
    },
  };
}
