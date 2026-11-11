import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const MAX_ACP_PROMPT_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;

const MAX_LISTED_SESSIONS = 500;
// Session modes that only plan or answer. One is selected when the agent offers it.
const READ_ONLY_MODE = /^(?:plan|ask|chat|read[-_]?only)$/i;

const messages = {
  CONTEXT_UNAVAILABLE: "This Antigravity conversation cannot be continued as a copy.",
  INVALID_REQUEST: "Invalid Antigravity ACP request.",
  PROVIDER_ABORTED: "The Antigravity ACP request was cancelled.",
  PROVIDER_FAILED: "Antigravity ACP did not complete the request.",
  PROVIDER_OUTPUT_LIMIT: "Antigravity ACP exceeded its output limit.",
  PROVIDER_TIMEOUT: "The Antigravity ACP request timed out.",
  PROVIDER_TOOL_ACTIVITY: "Antigravity attempted tool activity, so the reply was discarded.",
  PROVIDER_UNAVAILABLE: "Antigravity is disabled until tool isolation is verified.",
} as const;

type ProviderErrorCode = keyof typeof messages;

function providerError(code: ProviderErrorCode) {
  return Object.assign(new Error(messages[code]), { code });
}

export function antigravityAvailable(): false {
  return false;
}

export async function runAntigravity(): Promise<never> {
  throw providerError("PROVIDER_UNAVAILABLE");
}

export interface AcpTransport {
  incoming: AsyncIterable<Uint8Array | string>;
  /** Write one newline-terminated JSON-RPC frame. */
  send(line: string): void | Promise<void>;
  /** Stop the transport and release its resources. */
  close(): void | Promise<void>;
}

export interface AntigravityAcpOptions {
  transport: AcpTransport;
  cwd: string;
  text: string;
  signal?: AbortSignal | null;
  timeoutMs?: number;
  /** Continue this existing conversation instead of starting a new one. */
  sessionId?: string;
  /**
   * Permit `session/resume` or `session/load` when the agent cannot fork.
   * Both continue the original conversation in place instead of a copy.
   */
  allowInPlace?: boolean;
  /** Discard the reply and cancel as soon as the agent reports a tool call. */
  failOnToolActivity?: boolean;
}

type AcpMethod =
  | "initialize" | "session/new" | "session/prompt" | "session/list"
  | "session/fork" | "session/resume" | "session/load" | "session/set_mode";

interface PendingRequest {
  id: number;
  method: AcpMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the agent says it can do with existing sessions. */
function sessionCapabilities(init: unknown): { list: boolean; fork: boolean; resume: boolean; load: boolean } {
  const agent = isRecord(init) && isRecord(init.agentCapabilities) ? init.agentCapabilities : {};
  const session = isRecord(agent.sessionCapabilities) ? agent.sessionCapabilities : {};
  const offered = (name: string) => session[name] !== undefined && session[name] !== null && session[name] !== false;
  return { list: offered("list"), fork: offered("fork"), resume: offered("resume"), load: agent.loadSession === true };
}

/** A planning or answer-only mode to switch to, when the agent advertises one that is not already active. */
function readOnlyMode(session: unknown): string | null {
  const modes = isRecord(session) && isRecord(session.modes) ? session.modes : undefined;
  if (!modes || !Array.isArray(modes.availableModes)) return null;
  const available: unknown[] = modes.availableModes;
  const match = available.find((mode): mode is { id: string } =>
    isRecord(mode) && typeof mode.id === "string" && mode.id.length <= 128 && READ_ONLY_MODE.test(mode.id));
  return match && match.id !== modes.currentModeId ? match.id : null;
}

/**
 * Exercise one ACP v1 text turn through an injected transport. The caller owns
 * the transport and supplies a dedicated absolute working directory.
 * This protocol implementation provides no containment for agent-owned tools.
 */
export async function runAntigravityAcp(
  options: AntigravityAcpOptions,
): Promise<{ provider: "antigravity"; reply: string }> {
  const {
    transport, cwd, text, signal, timeoutMs = 90_000, sessionId: continued, allowInPlace = false,
    failOnToolActivity = false,
  }: Partial<AntigravityAcpOptions> = options === undefined ? {} : options;
  if (
    typeof transport?.incoming?.[Symbol.asyncIterator] !== "function" ||
    typeof transport.send !== "function" ||
    typeof transport.close !== "function" ||
    typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0") ||
    typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > MAX_ACP_PROMPT_BYTES ||
    (signal != null && (typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")) ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    (continued !== undefined && (typeof continued !== "string" || !continued || continued.length > 1024))
  ) {
    throw providerError("INVALID_REQUEST");
  }

  const wire = transport;
  let pending: PendingRequest | undefined;
  let failure: ReturnType<typeof providerError> | undefined;
  let finished = false;
  let nextId = 0;
  let sessionId: string | undefined;
  let replyBytes = 0;
  const replyParts: string[] = [];

  function send(payload: Record<string, unknown>) {
    return wire.send(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
  }

  function fail(code: ProviderErrorCode, { cancel = false } = {}) {
    if (finished || failure) return;
    failure = providerError(code);
    if (cancel && pending?.method === "session/prompt") {
      // Cancellation is best effort when the wire has failed or closed.
      try {
        Promise.resolve(send({ method: "session/cancel", params: { sessionId } })).catch(() => {});
      } catch {}
    }
    const request = pending;
    pending = undefined;
    request?.reject(failure);
  }

  function request(method: AcpMethod, params: Record<string, unknown>): Promise<unknown> {
    if (failure) return Promise.reject(failure);
    return new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      pending = { id, method, resolve, reject };
      try {
        Promise.resolve(send({ id, method, params })).catch(() => fail("PROVIDER_FAILED"));
      } catch {
        fail("PROVIDER_FAILED");
      }
    });
  }

  async function receiveAgentRequest(frame: Record<string, unknown>) {
    const { id, method, params } = frame;
    if (!(typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id)))) {
      fail("PROVIDER_FAILED", { cancel: true });
      return;
    }
    if (method !== "session/request_permission") {
      await send({ id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    const ownTurn = pending?.method === "session/prompt" && isRecord(params) && params.sessionId === sessionId;
    const options: unknown[] = ownTurn && isRecord(params) && Array.isArray(params.options)
      ? params.options
      : [];
    const rejection = options.find((option): option is { kind: "reject_once"; optionId: string } =>
      isRecord(option) && option.kind === "reject_once" &&
      typeof option.optionId === "string" && option.optionId.length > 0);
    const canReject = rejection &&
      options.filter((option) => isRecord(option) && option.optionId === rejection.optionId).length === 1;
    const outcome = canReject
      ? { outcome: "selected", optionId: rejection.optionId }
      : { outcome: "cancelled" };
    await send({ id, result: { outcome } });
    if (ownTurn && !canReject) fail("PROVIDER_ABORTED", { cancel: true });
  }

  function receive(frame: unknown) {
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
      fail("PROVIDER_FAILED", { cancel: true });
      return;
    }
    if (typeof frame.method === "string") {
      if (Object.hasOwn(frame, "id")) {
        return receiveAgentRequest(frame);
      }
      if (frame.method !== "session/update" ||
          pending?.method !== "session/prompt" ||
          !isRecord(frame.params) || frame.params.sessionId !== sessionId) return;
      const update = frame.params.update;
      if (failOnToolActivity && isRecord(update) &&
          (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")) {
        // The tool may already have run. The reply is withheld either way.
        fail("PROVIDER_TOOL_ACTIVITY", { cancel: true });
        return;
      }
      if (!isRecord(update) || update.sessionUpdate !== "agent_message_chunk" ||
          !isRecord(update.content) || update.content.type !== "text" ||
          typeof update.content.text !== "string") return;
      const chunk = update.content.text;
      replyBytes += Buffer.byteLength(chunk);
      if (replyBytes > MAX_REPLY_BYTES) {
        fail("PROVIDER_OUTPUT_LIMIT", { cancel: true });
        return;
      }
      replyParts.push(chunk);
      return;
    }
    if (!pending || frame.id !== pending.id) return;
    if (Object.hasOwn(frame, "error") || !Object.hasOwn(frame, "result")) {
      fail("PROVIDER_FAILED", { cancel: true });
      return;
    }
    const request = pending;
    pending = undefined;
    if (request.method === "session/prompt") finished = true;
    request.resolve(frame.result);
  }

  async function readFrames() {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let fragments: Buffer[] = [];
    let lineBytes = 0;
    let wireBytes = 0;
    try {
      for await (const chunk of wire.incoming) {
        if (finished || failure) return;
        if (!(chunk instanceof Uint8Array) && typeof chunk !== "string") {
          fail("PROVIDER_FAILED", { cancel: true });
          return;
        }
        wireBytes += Buffer.byteLength(chunk);
        if (wireBytes > MAX_WIRE_BYTES) {
          fail("PROVIDER_OUTPUT_LIMIT", { cancel: true });
          return;
        }
        const bytes = typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let start = 0;
        while (start < bytes.length) {
          const newline = bytes.indexOf(10, start);
          const stop = newline === -1 ? bytes.length : newline;
          lineBytes += stop - start;
          if (lineBytes > MAX_LINE_BYTES) {
            fail("PROVIDER_OUTPUT_LIMIT", { cancel: true });
            return;
          }
          const fragment = bytes.subarray(start, stop);
          if (fragment.length) fragments.push(fragment);
          if (newline === -1) break;
          const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, lineBytes);
          fragments = [];
          lineBytes = 0;
          await receive(JSON.parse(decoder.decode(line)));
          if (finished || failure) return;
          start = newline + 1;
        }
      }
      fail("PROVIDER_FAILED");
    } catch {
      fail("PROVIDER_FAILED", { cancel: true });
    }
  }

  const abort = () => fail("PROVIDER_ABORTED", { cancel: true });
  const timer = setTimeout(() => fail("PROVIDER_TIMEOUT", { cancel: true }), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw providerError("PROVIDER_ABORTED");
    void readFrames();
    const init = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "use-my-llm", version: "0.1.0" },
    });
    if (!isRecord(init) || init.protocolVersion !== 1) throw providerError("PROVIDER_FAILED");
    let session: unknown;
    if (continued === undefined) {
      session = await request("session/new", { cwd, mcpServers: [] });
      const id = isRecord(session) ? session.sessionId : undefined;
      if (typeof id !== "string" || !id || id.length > 1024) {
        throw providerError("PROVIDER_FAILED");
      }
      sessionId = id;
    } else {
      const capabilities = sessionCapabilities(init);
      if (capabilities.fork) {
        // A copy: the agent creates a new session from the original's history.
        session = await request("session/fork", { sessionId: continued, cwd, mcpServers: [] });
        const id = isRecord(session) ? session.sessionId : undefined;
        if (typeof id !== "string" || !id || id.length > 1024 || id === continued) {
          throw providerError("PROVIDER_FAILED");
        }
        sessionId = id;
      } else if (allowInPlace && (capabilities.resume || capabilities.load)) {
        // History replayed by session/load arrives before the prompt and is ignored.
        session = await request(capabilities.resume ? "session/resume" : "session/load",
          { sessionId: continued, cwd, mcpServers: [] });
        sessionId = continued;
      } else {
        throw providerError("CONTEXT_UNAVAILABLE");
      }
    }
    const mode = readOnlyMode(session);
    if (mode) await request("session/set_mode", { sessionId, modeId: mode });
    const turn = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    const stopReason = isRecord(turn) ? turn.stopReason : undefined;
    if (stopReason === "cancelled") throw providerError("PROVIDER_ABORTED");
    const reply = replyParts.join("");
    if (stopReason !== "end_turn" || !reply.trim()) throw providerError("PROVIDER_FAILED");
    return { provider: "antigravity", reply };
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    try {
      Promise.resolve(wire.close()).catch(() => {});
    } catch {}
  }
}

export interface AcpSessionSummary {
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string | null;
}

/**
 * List conversations through ACP `session/list`. Returns an empty list when
 * the agent does not advertise the capability. No session is opened and no
 * prompt is sent.
 */
export async function listAntigravityAcpSessions(
  { transport, cwd, signal, timeoutMs = 15_000 }: Pick<AntigravityAcpOptions, "transport" | "cwd" | "signal" | "timeoutMs">,
): Promise<AcpSessionSummary[]> {
  if (typeof transport?.incoming?.[Symbol.asyncIterator] !== "function" || typeof transport.send !== "function" ||
      typeof transport.close !== "function" || typeof cwd !== "string" || !isAbsolute(cwd) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw providerError("INVALID_REQUEST");
  }
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  let closed: Error | undefined;
  const stop = (error: Error) => {
    closed ??= error;
    for (const entry of waiting.values()) entry.reject(closed);
    waiting.clear();
  };
  const send = (payload: Record<string, unknown>) => transport.send(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
  const call = (method: AcpMethod, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    if (closed) return reject(closed);
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    Promise.resolve().then(() => send({ id, method, params })).catch(() => stop(providerError("PROVIDER_FAILED")));
  });
  const reader = (async () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    let bytes = 0;
    try {
      for await (const chunk of transport.incoming) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_WIRE_BYTES) return stop(providerError("PROVIDER_OUTPUT_LIMIT"));
        buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          const frame: unknown = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (!isRecord(frame)) continue;
          if (typeof frame.method === "string") {
            // Nothing the agent asks for is granted while listing.
            if (Object.hasOwn(frame, "id")) await send({ id: frame.id, error: { code: -32601, message: "Method not found" } });
            continue;
          }
          const entry = typeof frame.id === "number" ? waiting.get(frame.id) : undefined;
          if (!entry) continue;
          waiting.delete(frame.id as number);
          if (Object.hasOwn(frame, "error")) entry.reject(providerError("PROVIDER_FAILED"));
          else entry.resolve(frame.result);
        }
      }
      stop(providerError("PROVIDER_FAILED"));
    } catch {
      stop(providerError("PROVIDER_FAILED"));
    }
  })();
  const abort = () => stop(providerError("PROVIDER_ABORTED"));
  const timer = setTimeout(() => stop(providerError("PROVIDER_TIMEOUT")), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw providerError("PROVIDER_ABORTED");
    const init = await call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "use-my-llm", version: "0.1.0" },
    });
    if (!isRecord(init) || init.protocolVersion !== 1) throw providerError("PROVIDER_FAILED");
    if (!sessionCapabilities(init).list) return [];
    const sessions: AcpSessionSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20 && sessions.length < MAX_LISTED_SESSIONS; page += 1) {
      const result = await call("session/list", cursor === undefined ? {} : { cursor });
      const entries: unknown[] = isRecord(result) && Array.isArray(result.sessions) ? result.sessions : [];
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.sessionId !== "string" || !entry.sessionId || entry.sessionId.length > 1024) continue;
        const updated = typeof entry.updatedAt === "string" ? Date.parse(entry.updatedAt) : NaN;
        sessions.push({
          sessionId: entry.sessionId,
          title: typeof entry.title === "string" ? entry.title.slice(0, 200) : "",
          cwd: typeof entry.cwd === "string" ? entry.cwd : "",
          updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null,
        });
      }
      cursor = isRecord(result) && typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return sessions.slice(0, MAX_LISTED_SESSIONS);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    stop(providerError("PROVIDER_ABORTED"));
    try {
      Promise.resolve(transport.close()).catch(() => {});
    } catch {}
    await reader.catch(() => {});
  }
}

function isExecutable(path: unknown): path is string {
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Find the official `agy` CLI from trusted local installation locations. */
export function findAgy(): string | null {
  const configured = process.env.LOCALHOSTAGENT_AGY_PATH;
  if (configured !== undefined) return isExecutable(configured) ? configured : null;
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  const directories = (process.env.PATH ?? "").split(delimiter).filter((directory) => isAbsolute(directory));
  directories.push(join(homedir(), ".gemini", "bin"), join(homedir(), ".local", "bin"));
  return directories.map((directory) => join(directory, name)).find(isExecutable) ?? null;
}

let acpProbe: { executable: string; available: boolean } | undefined;

/** Whether this `agy` build has the `acp` subcommand. Probed once with `agy help acp`; no session is started. */
export function agyAcpAvailable(executable: string | null = findAgy()): boolean {
  if (!isExecutable(executable)) return false;
  if (acpProbe?.executable === executable) return acpProbe.available;
  const probe = spawnSync(executable, ["help", "acp"], {
    shell: false, timeout: 5_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  });
  const available = probe.status === 0 && !probe.error && !/unknown subcommand/i.test(`${probe.stdout}${probe.stderr}`);
  acpProbe = { executable, available };
  return available;
}

/**
 * Start `agy acp` as a child process and expose it as an {@link AcpTransport}.
 *
 * This does not contain the agent's own tools. The caller must only use it
 * behind the explicit local opt-in documented in SECURITY.md.
 */
export function spawnAgyAcp(executable: string, cwd: string): AcpTransport {
  if (!isExecutable(executable) || !isAbsolute(cwd)) throw providerError("PROVIDER_UNAVAILABLE");
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "USERPROFILE", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "LOCALAPPDATA", "APPDATA"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  const child = spawn(executable, ["acp"], {
    cwd, env: environment, shell: false, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.on("error", () => { /* The agent exited first. */ });
  child.on("error", () => child.stdout.destroy());
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* Already exited. */ }
    }
  };
  let closed = false;
  return {
    incoming: child.stdout,
    send(line) {
      if (!closed && child.stdin.writable) child.stdin.write(line);
    },
    close() {
      if (closed) return;
      closed = true;
      child.stdin.destroy();
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), 750).unref();
    },
  };
}
