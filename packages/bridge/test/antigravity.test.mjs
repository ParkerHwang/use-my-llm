import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  antigravityAvailable,
  runAntigravity,
  runAntigravityAcp,
} from "../dist/providers/antigravity.mjs";

const cwd = resolve("mock-acp-working-directory");
const text = "Return a short greeting.";
const sessionId = "mock-session";

function mockTransport(onPrompt, { protocolVersion = 1 } = {}) {
  // Preserve writes as distinct chunks to exercise fragmented UTF-8 frames.
  const incoming = new PassThrough({ objectMode: true });
  const sent = [];
  let closeCount = 0;
  const frame = (message) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";
  const emit = (message) => incoming.write(frame(message));
  const reply = (request, result) => emit({ id: request.id, result });

  const transport = {
    incoming,
    send(line) {
      assert.equal(line.endsWith("\n"), true);
      assert.equal(line.split("\n").length, 2);
      const message = JSON.parse(line);
      sent.push(message);
      if (message.method === "initialize") reply(message, { protocolVersion });
      if (message.method === "session/new") reply(message, { sessionId });
      if (message.method === "session/prompt") {
        onPrompt(message, { emit, reply, incoming, frame });
      }
    },
    close() {
      closeCount++;
      incoming.destroy();
    },
  };
  return { transport, sent, closeCount: () => closeCount };
}

function update(session, kind, value) {
  return {
    method: "session/update",
    params: {
      sessionId: session,
      update: { sessionUpdate: kind, content: { type: "text", text: value } },
    },
  };
}

function permission(options, session = sessionId) {
  return {
    id: "permission-request",
    method: "session/request_permission",
    params: { sessionId: session, options },
  };
}

function assertCancelled(sent) {
  assert.deepEqual(sent.at(-1), {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  });
}

test("the public Antigravity adapter fails closed without accessing a transport", async () => {
  assert.equal(antigravityAvailable(), false);
  await assert.rejects(runAntigravity({
    get transport() { assert.fail("The public adapter accessed a transport"); },
  }), { code: "PROVIDER_UNAVAILABLE" });
});

test("ACP v1 only gathers text chunks from its own session", async () => {
  const mock = mockTransport((prompt, { reply, incoming, frame }) => {
    incoming.write(
      frame(update("other-session", "agent_message_chunk", "foreign")) +
      frame(update(sessionId, "agent_thought_chunk", "thought")) +
      frame(update(sessionId, "tool_call_update", "tool output")) +
      frame(update(sessionId, "agent_message_chunk", "안녕")),
    );
    const bytes = Buffer.from(frame(update(sessionId, "agent_message_chunk", " 👋")));
    const split = bytes.indexOf(Buffer.from("👋")) + 1;
    incoming.write(bytes.subarray(0, split));
    incoming.write(bytes.subarray(split));
    reply(prompt, { stopReason: "end_turn" });
  });

  assert.deepEqual(await runAntigravityAcp({ transport: mock.transport, cwd, text }), {
    provider: "antigravity",
    reply: "안녕 👋",
  });
  assert.deepEqual(mock.sent.map(({ method }) => method), ["initialize", "session/new", "session/prompt"]);
  assert.equal(mock.sent[0].params.protocolVersion, 1);
  assert.deepEqual(mock.sent[0].params.clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.deepEqual(mock.sent[1].params, { cwd, mcpServers: [] });
  assert.deepEqual(mock.sent[2].params, { sessionId, prompt: [{ type: "text", text }] });
  assert.equal(mock.closeCount(), 1);
});

test("ACP rejects offered tool permissions and answers other client methods with method-not-found", async () => {
  const mock = mockTransport((prompt, { emit, reply }) => {
    emit({ id: "file-request", method: "fs/read_text_file", params: { sessionId } });
    emit(permission([
      { kind: "allow_always", optionId: "always" },
      { kind: "reject_once", optionId: "deny" },
    ]));
    emit(update(sessionId, "agent_message_chunk", "Hello"));
    reply(prompt, { stopReason: "end_turn" });
  });

  await runAntigravityAcp({ transport: mock.transport, cwd, text });
  assert.deepEqual(mock.sent.find(({ id }) => id === "file-request").error, {
    code: -32601, message: "Method not found",
  });
  assert.deepEqual(mock.sent.find(({ id }) => id === "permission-request").result, {
    outcome: { outcome: "selected", optionId: "deny" },
  });
});

test("ACP cancels a turn if the agent offers no unambiguous rejection", async () => {
  const mock = mockTransport((_, { emit }) => emit(permission([
    { kind: "reject_once", optionId: "duplicate" },
    { kind: "allow_once", optionId: "duplicate" },
  ])));
  await assert.rejects(runAntigravityAcp({ transport: mock.transport, cwd, text }), {
    code: "PROVIDER_ABORTED",
  });
  assert.deepEqual(mock.sent.find(({ id }) => id === "permission-request").result, {
    outcome: { outcome: "cancelled" },
  });
  assertCancelled(mock.sent);
});

test("ACP does not continue with a different protocol version", async () => {
  const mock = mockTransport(() => assert.fail("The prompt was sent"), { protocolVersion: 2 });
  await assert.rejects(runAntigravityAcp({ transport: mock.transport, cwd, text }), {
    code: "PROVIDER_FAILED",
  });
  assert.deepEqual(mock.sent.map(({ method }) => method), ["initialize"]);
});

test("ACP does not accept a partial reply on a non-end_turn stop reason", async () => {
  const mock = mockTransport((prompt, { emit, reply }) => {
    emit(update(sessionId, "agent_message_chunk", "partial"));
    reply(prompt, { stopReason: "max_tokens" });
  });
  await assert.rejects(runAntigravityAcp({ transport: mock.transport, cwd, text }), {
    code: "PROVIDER_FAILED",
  });
});

test("abort sends session/cancel during the turn and closes the transport", async () => {
  const controller = new AbortController();
  const mock = mockTransport(() => queueMicrotask(() => controller.abort()));
  await assert.rejects(runAntigravityAcp({
    transport: mock.transport, cwd, text, signal: controller.signal,
  }), { code: "PROVIDER_ABORTED" });
  assertCancelled(mock.sent);
  assert.equal(mock.closeCount(), 1);
});

test("timeout sends session/cancel during a stalled turn", async () => {
  const mock = mockTransport(() => {});
  await assert.rejects(runAntigravityAcp({
    transport: mock.transport, cwd, text, timeoutMs: 100,
  }), { code: "PROVIDER_TIMEOUT" });
  assertCancelled(mock.sent);
  assert.equal(mock.closeCount(), 1);
});

test("ACP hides errors reported by the transport", async () => {
  const mock = mockTransport((_, { incoming }) => incoming.destroy(new Error("private agent details")));
  await assert.rejects(runAntigravityAcp({ transport: mock.transport, cwd, text }), {
    code: "PROVIDER_FAILED",
    message: "Antigravity ACP did not complete the request.",
  });
  assert.equal(mock.closeCount(), 1);
});

test("ACP stops on oversized reply text and unterminated frames", async (t) => {
  await t.test("reply byte limit", async () => {
    const mock = mockTransport((_, { emit }) => {
      emit(update(sessionId, "agent_message_chunk", "한".repeat(22_000)));
    });
    await assert.rejects(runAntigravityAcp({ transport: mock.transport, cwd, text }), {
      code: "PROVIDER_OUTPUT_LIMIT",
    });
    assertCancelled(mock.sent);
  });
  await t.test("line byte limit without newline", async () => {
    const mock = mockTransport((_, { incoming }) => {
      incoming.write(Buffer.alloc(256 * 1024 + 1, "x"));
    });
    await assert.rejects(runAntigravityAcp({ transport: mock.transport, cwd, text }), {
      code: "PROVIDER_OUTPUT_LIMIT",
    });
    assertCancelled(mock.sent);
  });
});
