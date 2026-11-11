import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;

const messages = {
  INVALID_REQUEST: "Invalid Antigravity ACP request.",
  PROVIDER_ABORTED: "The Antigravity ACP request was cancelled.",
  PROVIDER_FAILED: "Antigravity ACP did not complete the request.",
  PROVIDER_OUTPUT_LIMIT: "Antigravity ACP exceeded its output limit.",
  PROVIDER_TIMEOUT: "The Antigravity ACP request timed out.",
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
}

interface PendingRequest {
  id: number;
  method: "initialize" | "session/new" | "session/prompt";
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exercise one ACP v1 text turn through an injected transport. The caller owns
 * the transport and supplies a dedicated absolute working directory.
 * This protocol implementation provides no containment for agent-owned tools.
 */
export async function runAntigravityAcp(
  options: AntigravityAcpOptions,
): Promise<{ provider: "antigravity"; reply: string }> {
  const { transport, cwd, text, signal, timeoutMs = 90_000 }: Partial<AntigravityAcpOptions> =
    options === undefined ? {} : options;
  if (
    typeof transport?.incoming?.[Symbol.asyncIterator] !== "function" ||
    typeof transport.send !== "function" ||
    typeof transport.close !== "function" ||
    typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0") ||
    typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > MAX_PROMPT_BYTES ||
    (signal != null && (typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")) ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
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

  function request(method: PendingRequest["method"], params: Record<string, unknown>): Promise<unknown> {
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
      clientInfo: { name: "localhost-agent-sdk", version: "0.1.0" },
    });
    if (!isRecord(init) || init.protocolVersion !== 1) throw providerError("PROVIDER_FAILED");
    const session = await request("session/new", { cwd, mcpServers: [] });
    const id = isRecord(session) ? session.sessionId : undefined;
    if (typeof id !== "string" || !id || id.length > 1024) {
      throw providerError("PROVIDER_FAILED");
    }
    sessionId = id;
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
