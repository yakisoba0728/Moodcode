import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { normalizeSubmitInput } from "@moodcode/contracts/validation";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  encodeAcpV1Message,
  negotiateAcpV1Capabilities,
  parseAcpV1Message,
  validateAcpV1Request,
  validateAcpV1Result,
  validateAcpV1SessionUpdate,
} from "./protocol.js";
import type {
  AgentBackendSessionLoad,
  AgentBackendSpecInput,
  AgentBackendTargetPin,
} from "./types.js";
import {
  AGENT_BACKEND_LIMITS,
  validateAgentBackendSpec,
} from "./validation.js";

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

function source(): AgentBackendSessionLoad {
  // These pins are DATA for schema tests; they are not a live load capability.
  return {
    sourceBackendId: "original-reader",
    sourceBackendRevisionId: "backend-revision-original",
    sourceRequestId: "request-original",
    sourceRequestRevisionId: "request-revision-original",
    sourceRequestSha256: "d".repeat(64),
    sourceConnectionId: "connection-original",
    sourceConnectionRevisionId: "connection-revision-original",
    sourceConnectionSha256: "e".repeat(64),
    remoteSessionId: "peer/session-original",
  };
}

function definition(contextOwner: "engine" | "agent"): AgentBackendSpecInput {
  const config = normalizeSubmitInput({
    sessionId: "local-session",
    requestId: "schema-validation",
    prompt: "Continue this conversation.",
    config: {
      providerId: "acp:loaded-reader",
      modelId: "host/model",
      mode: "plan",
      limits: {
        maxTurns: 2,
        maxToolCalls: 3,
        maxOutputBytes: 8192,
        maxDurationMs: 6000,
      },
      budgets: {},
    },
  }).config as AgentBackendTargetPin["config"];
  return {
    schemaVersion: 1,
    id: "loaded-reader",
    description: "Explicit host-selected ACP v1 context owner",
    protocol: "acp",
    protocolVersion: 1,
    contextOwner,
    ...(contextOwner === "agent" ? { sessionLoad: source() } : {}),
    launch: {
      kind: "stdio",
      command: "/usr/bin/node",
      args: ["/workspace/peer.mjs"],
      cwd: "/workspace",
      sourceFiles: ["/workspace/peer.mjs"],
      envReferences: [],
    },
    credentialReference: null,
    endpointAudience: "local:conversation-peer",
    target: {
      workspaceId: "local-workspace",
      sessionId: "local-session",
      workspaceBindingSha256: "a".repeat(64),
      capabilitiesSha256: "b".repeat(64),
      catalogueSha256: "c".repeat(64),
      profile: null,
      config,
      runConfigSha256: knowledgeHash(config),
      tools: ["read_file"],
      allocation: {
        maxTurns: 2,
        maxToolCalls: 3,
        maxOutputBytes: 8192,
        maxDurationMs: 6000,
      },
    },
  };
}

test("v1 load preserves requested opaque session and cwd, without acquiring MCP or extra roots", () => {
  const params = {
    sessionId: "peer/session-original",
    cwd: "/workspace",
    mcpServers: [],
  };
  const request = {
    jsonrpc: "2.0",
    id: "load-original",
    method: "session/load",
    params,
  };
  assert.deepEqual(validateAcpV1Request("session/load", params), params);
  assert.deepEqual(parseAcpV1Message(encodeAcpV1Message(request)), request);
  for (const invalid of [
    { cwd: "/workspace", mcpServers: [] },
    { ...params, sessionId: "" },
    { ...params, sessionId: "peer\nforeign" },
    { ...params, cwd: "workspace" },
    { ...params, cwd: "/workspace/../other" },
    { ...params, additionalDirectories: ["/outside"] },
    { ...params, replayFrom: { type: "start" } },
  ]) {
    assert.throws(
      () => validateAcpV1Request("session/load", invalid),
      fails(
        "INVALID_AGENT_BACKEND",
        "AGENT_BACKEND_LIMIT",
        "AGENT_BACKEND_PATH_INVALID",
      ),
    );
  }
  assert.throws(
    () =>
      validateAcpV1Request("session/load", {
        ...params,
        mcpServers: [{ name: "remote" }],
      }),
    fails("ACP_MCP_UNSUPPORTED"),
  );
});

test("empty load result is session readiness, and cannot substitute for a new-session identity or prompt completion", () => {
  assert.deepEqual(validateAcpV1Result("session/load", {}), {});
  assert.deepEqual(
    validateAcpV1Result("session/load", { _meta: { display: "history" } }),
    { _meta: { display: "history" } },
  );
  for (const result of [
    { sessionId: "peer/replacement" },
    { stopReason: "end_turn" },
    { messageId: "v2-ack" },
    { modes: { currentModeId: "build", availableModes: [] } },
    { configOptions: [] },
    { permission: "allow_always" },
  ]) {
    assert.throws(
      () => validateAcpV1Result("session/load", result),
      fails("INVALID_AGENT_BACKEND"),
    );
  }
  assert.throws(
    () => validateAcpV1Result("session/prompt", {}),
    fails("INVALID_AGENT_BACKEND"),
  );
  assert.throws(
    () => validateAcpV1Result("session/new", {}),
    fails("INVALID_AGENT_BACKEND"),
  );
});

test("advertised load cannot change existing engine-owned defaults or imply local effect support", () => {
  const remote = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  };
  const defaults = negotiateAcpV1Capabilities(remote);
  const reader = negotiateAcpV1Capabilities(remote, { readTextFile: true });
  assert.equal(defaults.contextOwner, "engine");
  assert.equal(defaults.loadSession, false);
  assert.equal(reader.contextOwner, "engine");
  assert.equal(reader.loadSession, false);
  assert.equal(reader.readTextFile, true);
  assert.equal(reader.writeTextFile, false);
  assert.equal(reader.terminal, false);
  const agent = negotiateAcpV1Capabilities(remote, {
    contextOwner: "agent",
    loadSession: true,
  });
  assert.equal(agent.contextOwner, "agent");
  assert.equal(agent.loadSession, true);
  assert.equal(agent.readTextFile, false);
  assert.equal(agent.writeTextFile, false);
  assert.equal(agent.terminal, false);
  assert.notEqual(defaults.sha256, agent.sha256);
  assert.ok(Object.isFrozen(agent));
});

test("explicit load is a boolean host/peer intersection, with no auth or version fallback", () => {
  const host = { contextOwner: "agent" as const, loadSession: true };
  for (const agentCapabilities of [{}, { loadSession: false }]) {
    assert.equal(
      negotiateAcpV1Capabilities(
        { protocolVersion: 1, agentCapabilities },
        host,
      ).loadSession,
      false,
    );
  }
  for (const loadSession of [1, "true", null]) {
    assert.throws(
      () =>
        negotiateAcpV1Capabilities(
          { protocolVersion: 1, agentCapabilities: { loadSession } },
          host,
        ),
      fails("ACP_INVALID_MESSAGE"),
    );
    assert.throws(
      () =>
        negotiateAcpV1Capabilities(
          { protocolVersion: 1, agentCapabilities: { loadSession: true } },
          { ...host, loadSession } as never,
        ),
      fails("ACP_INVALID_MESSAGE"),
    );
  }
  assert.throws(
    () =>
      negotiateAcpV1Capabilities(
        { protocolVersion: 2, agentCapabilities: { loadSession: true } },
        host,
      ),
    fails("ACP_VERSION_UNSUPPORTED"),
  );
  assert.throws(
    () =>
      negotiateAcpV1Capabilities(
        {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "sign-in", name: "Sign in" }],
        },
        host,
      ),
    fails("ACP_AUTH_UNSUPPORTED"),
  );
});

test("historical user/assistant chunks keep opaque grouping and repeated content without fabricating native identity", () => {
  const chunks = [
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
  ].map((kind) => ({
    sessionId: "peer/session-original",
    update: {
      sessionUpdate: kind,
      messageId: "opaque/message",
      content: { type: "text", text: "Repeated historical text." },
    },
  }));
  for (const chunk of chunks) {
    const first = validateAcpV1SessionUpdate(chunk);
    const repeated = validateAcpV1SessionUpdate(chunk);
    assert.deepEqual(first, chunk);
    assert.deepEqual(repeated, first);
    assert.notEqual(first, repeated);
    assert.ok(Object.isFrozen(first.update));
    assert.throws(
      () =>
        validateAcpV1SessionUpdate({
          ...chunk,
          update: { ...chunk.update, nativeToolId: "tool-history" },
        }),
      fails("INVALID_AGENT_BACKEND"),
    );
  }
  assert.throws(
    () =>
      validateAcpV1SessionUpdate({
        ...chunks[0],
        update: {
          ...chunks[0]!.update,
          content: {
            type: "text",
            text: "x".repeat(AGENT_BACKEND_LIMITS.chunkBytes + 1),
          },
        },
      }),
    fails("AGENT_BACKEND_LIMIT"),
  );
  const wire =
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"peer/session-original","sessionId":"peer/foreign","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"history"}}}}';
  assert.throws(() => parseAcpV1Message(wire), fails("ACP_DUPLICATE_KEY"));
});

test("engine-owned registration stays load-free, while agent-owned load requires a separate explicit alias", () => {
  const engine = validateAgentBackendSpec(definition("engine"));
  assert.equal(engine.contextOwner, "engine");
  assert.equal(Object.hasOwn(engine, "sessionLoad"), false);
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...definition("engine"),
        sessionLoad: source(),
      }),
    fails("AGENT_BACKEND_CONTEXT_UNSUPPORTED"),
  );
  const { sessionLoad: _source, ...withoutSource } = definition("agent");
  assert.throws(
    () => validateAgentBackendSpec(withoutSource),
    fails("INVALID_AGENT_BACKEND", "AGENT_BACKEND_CONTEXT_UNSUPPORTED"),
  );
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...definition("agent"),
        sessionLoad: { ...source(), sourceBackendId: "loaded-reader" },
      }),
    fails("AGENT_BACKEND_LOAD_ALIAS_REQUIRED"),
  );
  const agent = validateAgentBackendSpec(definition("agent"));
  assert.equal(agent.contextOwner, "agent");
  assert.deepEqual(agent.sessionLoad, source());
  assert.ok(Object.isFrozen(agent.sessionLoad));
  assert.notEqual(agent.sha256, engine.sha256);
});

test("signed load preimage binds every source identity and both native revision hashes", () => {
  const signed = validateAgentBackendSpec(definition("agent"));
  assert.deepEqual(validateAgentBackendSpec(structuredClone(signed)), signed);
  for (const field of Object.keys(
    source(),
  ) as (keyof AgentBackendSessionLoad)[]) {
    const replacement = field.endsWith("Sha256")
      ? "f".repeat(64)
      : `changed-${field}`;
    assert.throws(
      () =>
        validateAgentBackendSpec({
          ...signed,
          sessionLoad: { ...signed.sessionLoad, [field]: replacement },
        }),
      fails("AGENT_BACKEND_HASH_MISMATCH"),
    );
  }
  const { sessionLoad: _selection, ...withoutLoad } = signed;
  assert.throws(
    () => validateAgentBackendSpec({ ...withoutLoad, contextOwner: "engine" }),
    fails("AGENT_BACKEND_HASH_MISMATCH"),
  );
});

test("source schema cannot contain approval, replay authority, extra owner fields, missing tuple pins or invalid hashes", () => {
  const base = definition("agent");
  for (const extra of [
    { approved: true },
    { ownerEpoch: "recovered" },
    { replayCursor: 1 },
    { history: [] },
  ]) {
    assert.throws(
      () =>
        validateAgentBackendSpec({
          ...base,
          sessionLoad: { ...source(), ...extra },
        }),
      fails("INVALID_AGENT_BACKEND"),
    );
  }
  for (const field of Object.keys(source())) {
    const missing: Record<string, unknown> = { ...source() };
    delete missing[field];
    assert.throws(
      () => validateAgentBackendSpec({ ...base, sessionLoad: missing }),
      fails("INVALID_AGENT_BACKEND"),
    );
  }
  for (const digest of ["", "a".repeat(63), "A".repeat(64), "not-a-hash"]) {
    assert.throws(
      () =>
        validateAgentBackendSpec({
          ...base,
          sessionLoad: { ...source(), sourceRequestSha256: digest },
        }),
      fails("INVALID_AGENT_BACKEND"),
    );
    assert.throws(
      () =>
        validateAgentBackendSpec({
          ...base,
          sessionLoad: { ...source(), sourceConnectionSha256: digest },
        }),
      fails("INVALID_AGENT_BACKEND"),
    );
  }
});

test("validation snapshots caller DATA and refuses lazy source descriptors without invoking traps", () => {
  const input = definition("agent");
  const selected = validateAgentBackendSpec(input);
  const before = selected.sha256;
  const mutable = input.sessionLoad as {
    -readonly [K in keyof AgentBackendSessionLoad]: AgentBackendSessionLoad[K];
  };
  mutable.remoteSessionId = "peer/foreign";
  assert.equal(selected.sessionLoad?.remoteSessionId, "peer/session-original");
  assert.equal(selected.sha256, before);
  let traps = 0;
  const accessor = Object.defineProperty({ ...source() }, "remoteSessionId", {
    enumerable: true,
    get() {
      traps++;
      return "peer/foreign";
    },
  });
  const proxy = new Proxy(source(), {
    ownKeys() {
      traps++;
      return [];
    },
    get() {
      traps++;
      return undefined;
    },
  });
  const serializer = {
    ...source(),
    toJSON() {
      traps++;
      return source();
    },
  };
  for (const sessionLoad of [accessor, proxy, serializer]) {
    assert.throws(
      () => validateAgentBackendSpec({ ...definition("agent"), sessionLoad }),
      fails("INVALID_AGENT_BACKEND"),
    );
  }
  assert.equal(traps, 0);
  assert.throws(
    () =>
      validateAgentBackendSpec({ ...selected, sessionLoad: input.sessionLoad }),
    fails("AGENT_BACKEND_HASH_MISMATCH"),
  );
});
