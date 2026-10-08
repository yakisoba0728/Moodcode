import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { AGENT_BACKEND_LIMITS } from "./validation.js";
import {
  encodeAcpV1Message,
  negotiateAcpV1Capabilities,
  parseAcpV1Message,
  validateAcpV1InitializeParams,
  validateAcpV1Request,
  validateAcpV1Result,
  validateAcpV1SessionUpdate,
} from "./protocol.js";
const fails =
  (...codes: string[]) =>
  (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.ok(
      codes.includes(error.code),
      `Expected ${codes.join("|")}; got ${error.code}`,
    );
    return true;
  };

test("official ACP v1 initialize/new/prompt/result/cancel DTOs roundtrip as immutable newline-delimited JSON-RPC", () => {
  const params = {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "moodcode", version: "0.1.0" },
  };
  assert.deepEqual(validateAcpV1Request("initialize", params), params);
  assert.deepEqual(
    validateAcpV1Request("session/new", { cwd: "/workspace", mcpServers: [] }),
    { cwd: "/workspace", mcpServers: [] },
  );
  assert.deepEqual(
    validateAcpV1Request("session/prompt", {
      sessionId: "peer/session",
      prompt: [{ type: "text", text: "Inspect.\nReport." }],
    }),
    {
      sessionId: "peer/session",
      prompt: [{ type: "text", text: "Inspect.\nReport." }],
    },
  );
  assert.deepEqual(
    validateAcpV1Result("session/prompt", { stopReason: "end_turn" }),
    { stopReason: "end_turn" },
  );
  const message = {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "peer/session" },
  };
  const encoded = encodeAcpV1Message(message);
  assert.equal(encoded.split("\n").length, 2);
  assert.deepEqual(parseAcpV1Message(encoded), message);
  assert.ok(Object.isFrozen(parseAcpV1Message(encoded)));
});
test("ACP v2 initialize and acknowledgement-shaped prompt results cannot imply v1 completion", () => {
  assert.throws(
    () =>
      validateAcpV1Result("initialize", {
        protocolVersion: 2,
        agentCapabilities: {},
      }),
    fails("ACP_VERSION_UNSUPPORTED"),
  );
  assert.throws(
    () => validateAcpV1Result("session/prompt", { messageId: "accepted" }),
    fails("INVALID_AGENT_BACKEND"),
  );
  assert.throws(
    () => validateAcpV1Result("session/prompt", { stopReason: "running" }),
    fails("ACP_COMPLETION_INVALID"),
  );
});
test("negotiation is a protocol intersection requiring explicit local read support and never grants remote flags", () => {
  const remote = {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { fork: {}, resume: {} },
    },
    authMethods: [],
  };
  const defaulted = negotiateAcpV1Capabilities(remote),
    reader = negotiateAcpV1Capabilities(remote, { readTextFile: true });
  assert.equal(defaulted.readTextFile, false);
  assert.equal(reader.readTextFile, true);
  assert.equal(reader.writeTextFile, false);
  assert.equal(reader.terminal, false);
  assert.equal(reader.loadSession, false);
  assert.notEqual(defaulted.sha256, reader.sha256);
  assert.ok(Object.isFrozen(reader));
  assert.throws(
    () =>
      negotiateAcpV1Capabilities({
        ...remote,
        authMethods: [{ id: "login", name: "Sign in" }],
      }),
    fails("ACP_AUTH_UNSUPPORTED"),
  );
});
test("write/terminal/MCP/load and unsupported content are typed before any effect port", () => {
  for (const method of [
    "fs/write_text_file",
    "terminal/create",
    "terminal/wait_for_exit",
  ])
    assert.throws(
      () => validateAcpV1Request(method, {}),
      fails("ACP_EFFECT_UNSUPPORTED"),
    );
  assert.throws(
    () => validateAcpV1Request("session/load", {}),
    fails("ACP_METHOD_UNSUPPORTED"),
  );
  assert.throws(
    () =>
      validateAcpV1Request("session/new", {
        cwd: "/workspace",
        mcpServers: [{ name: "untrusted" }],
      }),
    fails("ACP_MCP_UNSUPPORTED"),
  );
  assert.throws(
    () =>
      validateAcpV1InitializeParams({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
      }),
    fails("ACP_EFFECT_UNSUPPORTED"),
  );
  assert.throws(
    () =>
      validateAcpV1Request("session/prompt", {
        sessionId: "peer",
        prompt: [{ type: "image", data: "base64" }],
      }),
    fails("INVALID_AGENT_BACKEND", "ACP_CONTENT_UNSUPPORTED"),
  );
});
test("read RPC maps absolute paths and 1-based inclusive ranges without silent clamping", () => {
  const request = {
    sessionId: "peer",
    path: "/workspace/readme.md",
    line: 2,
    limit: 3,
  };
  assert.deepEqual(validateAcpV1Request("fs/read_text_file", request), request);
  assert.deepEqual(
    validateAcpV1Request("fs/read_text_file", {
      sessionId: "peer",
      path: "/workspace/readme.md",
      line: null,
      limit: null,
    }),
    {
      sessionId: "peer",
      path: "/workspace/readme.md",
      line: null,
      limit: null,
    },
  );
  for (const extra of [
    { line: 0 },
    { limit: 0 },
    { limit: 2001 },
    { line: Number.MAX_SAFE_INTEGER, limit: 2 },
  ])
    assert.throws(
      () => validateAcpV1Request("fs/read_text_file", { ...request, ...extra }),
      fails("AGENT_BACKEND_LIMIT"),
    );
  assert.throws(
    () =>
      validateAcpV1Request("fs/read_text_file", {
        ...request,
        path: "readme.md",
      }),
    fails("AGENT_BACKEND_PATH_INVALID"),
  );
  assert.throws(
    () =>
      validateAcpV1Request("fs/read_text_file", { ...request, actor: "owner" }),
    fails("INVALID_AGENT_BACKEND"),
  );
});
test("text notifications retain repeated chunks as data and tool statuses cannot mint native effect receipts", () => {
  const update = {
    sessionId: "peer",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "same" },
    },
  };
  assert.deepEqual(
    validateAcpV1SessionUpdate(update),
    validateAcpV1SessionUpdate(update),
  );
  const observation = {
    sessionId: "peer",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "rpc/1",
      status: "completed",
      rawOutput: { approved: true, cleanupConfirmed: true },
    },
  };
  assert.deepEqual(validateAcpV1SessionUpdate(observation), observation);
  assert.throws(
    () =>
      validateAcpV1SessionUpdate({
        sessionId: "peer",
        update: { sessionUpdate: "state_update", state: "idle" },
      }),
    fails("ACP_UPDATE_UNSUPPORTED"),
  );
});
test("JSON-RPC identity accepts bounded string/integer IDs and rejects conflicting envelopes", () => {
  for (const id of [0, 3, "request/1"])
    assert.deepEqual(
      parseAcpV1Message(
        JSON.stringify({ jsonrpc: "2.0", id, result: { content: "read" } }),
      ),
      { jsonrpc: "2.0", id, result: { content: "read" } },
    );
  for (const id of [null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        parseAcpV1Message(JSON.stringify({ jsonrpc: "2.0", id, result: {} })),
      fails("AGENT_BACKEND_LIMIT", "INVALID_AGENT_BACKEND"),
    );
  for (const body of [
    {
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: -1, message: "failed" },
    },
    { jsonrpc: "2.0", method: "session/cancel", id: 1, result: {}, params: {} },
    { jsonrpc: "2.0", result: {} },
    { jsonrpc: "1.0", id: 1, result: {} },
  ])
    assert.throws(
      () => parseAcpV1Message(JSON.stringify(body)),
      fails("ACP_INVALID_MESSAGE", "INVALID_AGENT_BACKEND"),
    );
  assert.deepEqual(
    parseAcpV1Message(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"invalid"}}',
    ),
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid" } },
  );
});
test("duplicate top-level/nested/escaped keys are rejected rather than silently replacing source bytes", () => {
  for (const input of [
    '{"jsonrpc":"2.0","id":1,"id":2,"result":{}}',
    '{"jsonrpc":"2.0","id":1,"result":{"content":"a","content":"b"}}',
    '{"jsonrpc":"2.0","id":1,"result":{"content":"a","cont\\u0065nt":"b"}}',
  ])
    assert.throws(() => parseAcpV1Message(input), fails("ACP_DUPLICATE_KEY"));
});
test("JSONL framing rejects batches, embedded newlines, malformed UTF-8, oversized frames and deep graphs", () => {
  const valid = '{"jsonrpc":"2.0","id":1,"result":{}}';
  assert.deepEqual(parseAcpV1Message(valid + "\r\n"), parseAcpV1Message(valid));
  assert.throws(
    () => parseAcpV1Message(valid + "\n" + valid),
    fails("ACP_INVALID_FRAME"),
  );
  assert.throws(
    () => parseAcpV1Message("[" + valid + "]"),
    fails("INVALID_AGENT_BACKEND"),
  );
  assert.throws(
    () => parseAcpV1Message(new Uint8Array([0xc3, 0x28])),
    fails("ACP_INVALID_UTF8"),
  );
  assert.throws(
    () => parseAcpV1Message(" ".repeat(AGENT_BACKEND_LIMITS.frameBytes + 1)),
    fails("AGENT_BACKEND_LIMIT"),
  );
  let nested: unknown = {};
  for (let i = 0; i < 13; i++) nested = { data: nested };
  assert.throws(
    () =>
      parseAcpV1Message(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: nested }),
      ),
    fails("AGENT_BACKEND_LIMIT"),
  );
});
test("peer metadata is immutable bounded advisory data and cannot extend exact effect parameters", () => {
  const body = {
    sessionId: "peer",
    path: "/workspace/file.txt",
    _meta: { approved: true, connectionEpoch: 99 },
  };
  assert.deepEqual(validateAcpV1Request("fs/read_text_file", body), body);
  assert.throws(
    () =>
      validateAcpV1Request("fs/read_text_file", {
        ...body,
        _meta: { body: "a".repeat(8193) },
      }),
    fails("AGENT_BACKEND_LIMIT"),
  );
  let accessed = 0;
  const input = Object.defineProperty({ jsonrpc: "2.0", id: 1 }, "result", {
    enumerable: true,
    get() {
      accessed++;
      return {};
    },
  });
  assert.throws(
    () => encodeAcpV1Message(input),
    fails("INVALID_AGENT_BACKEND"),
  );
  assert.equal(accessed, 0);
});
test("read responses and streamed text have explicit byte bounds and every supported stop reason remains distinct", () => {
  for (const stopReason of [
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ])
    assert.deepEqual(validateAcpV1Result("session/prompt", { stopReason }), {
      stopReason,
    });
  assert.throws(
    () =>
      validateAcpV1Result("fs/read_text_file", { content: "a".repeat(32769) }),
    fails("AGENT_BACKEND_LIMIT"),
  );
  assert.throws(
    () =>
      validateAcpV1SessionUpdate({
        sessionId: "peer",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "a".repeat(16385) },
        },
      }),
    fails("AGENT_BACKEND_LIMIT"),
  );
});
