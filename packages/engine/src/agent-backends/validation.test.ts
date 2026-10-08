import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { normalizeSubmitInput } from "@moodcode/contracts/validation";
import { knowledgeHash } from "../knowledge/validation.js";
import type { AgentBackendSpecInput, AgentBackendTargetPin } from "./types.js";
import {
  AGENT_BACKEND_LIMITS,
  agentBackendJson,
  validateAgentBackendLaunch,
  validateAgentBackendSpec,
  validateAgentBackendTarget,
} from "./validation.js";

function target(): AgentBackendTargetPin {
  const config = normalizeSubmitInput({
    sessionId: "session-local",
    requestId: "validate",
    prompt: "Inspect repository.",
    config: {
      providerId: "acp:local-reader",
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
    workspaceId: "workspace-local",
    sessionId: "session-local",
    workspaceBindingSha256: "a".repeat(64),
    capabilitiesSha256: "b".repeat(64),
    catalogueSha256: "c".repeat(64),
    profile: null,
    config,
    runConfigSha256: knowledgeHash(config),
    tools: ["read_file", "search_files"],
    allocation: {
      maxTurns: 2,
      maxToolCalls: 3,
      maxOutputBytes: 8192,
      maxDurationMs: 6000,
    },
  };
}
function definition(): AgentBackendSpecInput {
  return {
    schemaVersion: 1,
    id: "local-reader",
    description: "Explicit host selected ACP v1 stdio reader",
    protocol: "acp",
    protocolVersion: 1,
    contextOwner: "engine",
    launch: {
      kind: "stdio",
      command: "/usr/bin/node",
      args: ["/workspace/peer.mjs"],
      cwd: "/workspace",
      sourceFiles: ["/workspace/peer.mjs"],
      envReferences: [],
    },
    credentialReference: null,
    endpointAudience: "local:reader",
    target: target(),
  };
}
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

test("backend definition canonically pins normalized config, complete budgets, exact allocation and null profile", () => {
  const first = validateAgentBackendSpec(definition()),
    second = validateAgentBackendSpec({
      ...definition(),
      target: { ...target(), tools: ["search_files", "read_file"] },
    });
  assert.equal(first.sha256, second.sha256);
  assert.equal(
    first.target.runConfigSha256,
    knowledgeHash(first.target.config),
  );
  assert.equal(first.target.profile, null);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.target.config.budgets));
  assert.deepEqual(first.launch.sourceFiles, ["/workspace/peer.mjs"]);
  assert.deepEqual(validateAgentBackendSpec(first), first);
});
test("config digest and immutable spec digest reject mutation without creating replacement authority", () => {
  const value = validateAgentBackendSpec(definition());
  assert.throws(
    () => validateAgentBackendSpec({ ...value, description: "changed" }),
    fails("AGENT_BACKEND_HASH_MISMATCH"),
  );
  assert.throws(
    () =>
      validateAgentBackendTarget({
        ...target(),
        runConfigSha256: "d".repeat(64),
      }),
    fails("AGENT_BACKEND_CONFIG_INCOMPLETE"),
  );
});
test("backend provider identity must match its immutable definition and launch validates independently for ORIGINAL capture", () => {
  const value = definition(),
    pin = target(),
    config = { ...pin.config, providerId: "acp:other" };
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...value,
        target: { ...pin, config, runConfigSha256: knowledgeHash(config) },
      }),
    fails("AGENT_BACKEND_PROVIDER_MISMATCH"),
  );
  assert.deepEqual(validateAgentBackendLaunch(value.launch), value.launch);
  assert.ok(Object.isFrozen(validateAgentBackendLaunch(value.launch)));
});
test("incomplete budget/config defaults and allocation expansion are rejected", () => {
  const pin = target();
  assert.throws(
    () =>
      validateAgentBackendTarget({
        ...pin,
        config: { ...pin.config, budgets: {} },
      }),
    fails("AGENT_BACKEND_CONFIG_INCOMPLETE"),
  );
  assert.throws(
    () =>
      validateAgentBackendTarget({
        ...pin,
        allocation: { ...pin.allocation, maxToolCalls: 4 },
      }),
    fails("AGENT_BACKEND_ALLOCATION_MISMATCH"),
  );
  assert.throws(
    () =>
      validateAgentBackendTarget({
        ...pin,
        allocation: { ...pin.allocation, maxNestedTasks: 3 },
      }),
    fails("INVALID_AGENT_BACKEND"),
  );
});
test("profile null and exact registered profile revision cannot be interchanged", () => {
  const pin = target(),
    config = {
      ...pin.config,
      agentProfileId: "reader-profile",
      agentProfileRevision: "d".repeat(64),
    };
  const profiled = {
    ...pin,
    config,
    runConfigSha256: knowledgeHash(config),
    profile: { id: "reader-profile", revision: "d".repeat(64) },
  };
  assert.deepEqual(
    validateAgentBackendTarget(profiled).profile,
    profiled.profile,
  );
  assert.throws(
    () => validateAgentBackendTarget({ ...profiled, profile: null }),
    fails("AGENT_BACKEND_PROFILE_MISMATCH"),
  );
  assert.throws(
    () =>
      validateAgentBackendTarget({
        ...profiled,
        profile: { ...profiled.profile, revision: "e".repeat(64) },
      }),
    fails("AGENT_BACKEND_PROFILE_MISMATCH"),
  );
});
test("unsupported protocol/context/transport, incomplete load and caller identity fields fail exact validation", () => {
  const value = definition();
  assert.throws(
    () => validateAgentBackendSpec({ ...value, protocolVersion: 2 }),
    fails("ACP_VERSION_UNSUPPORTED"),
  );
  assert.throws(
    () => validateAgentBackendSpec({ ...value, contextOwner: "external" }),
    fails("AGENT_BACKEND_CONTEXT_UNSUPPORTED"),
  );
  assert.throws(
    () => validateAgentBackendSpec({ ...value, contextOwner: "agent" }),
    fails("INVALID_AGENT_BACKEND"),
  );
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...value,
        launch: { ...value.launch, kind: "http" },
      }),
    fails("AGENT_BACKEND_TRANSPORT_UNSUPPORTED"),
  );
  for (const extra of [
    { actor: "owner" },
    { approval: true },
    { connectionEpoch: 1 },
    { environment: { TOKEN: "raw" } },
  ])
    assert.throws(
      () => validateAgentBackendSpec({ ...value, ...extra }),
      fails("INVALID_AGENT_BACKEND"),
    );
});
test("launch tuples require canonical absolute files, unique sources and preserve argument order", () => {
  const value = definition();
  for (const command of [
    "node",
    "/workspace/../usr/bin/node",
    "/usr/bin/node\n",
  ])
    assert.throws(
      () =>
        validateAgentBackendSpec({
          ...value,
          launch: { ...value.launch, command },
        }),
      fails("AGENT_BACKEND_PATH_INVALID"),
    );
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...value,
        launch: {
          ...value.launch,
          sourceFiles: ["/workspace/peer.mjs", "/workspace/peer.mjs"],
        },
      }),
    fails("INVALID_AGENT_BACKEND"),
  );
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...value,
        launch: {
          ...value.launch,
          args: Array.from({ length: 65 }, () => "a"),
        },
      }),
    fails("AGENT_BACKEND_LIMIT"),
  );
  assert.notEqual(
    validateAgentBackendSpec({
      ...value,
      launch: { ...value.launch, args: ["a", "b"] },
    }).sha256,
    validateAgentBackendSpec({
      ...value,
      launch: { ...value.launch, args: ["b", "a"] },
    }).sha256,
  );
});
test("only host credential references and exact endpoint audience can be serialized", () => {
  const value = definition(),
    ref = { id: "host:reader", audience: value.endpointAudience };
  const normalized = validateAgentBackendSpec({
    ...value,
    credentialReference: ref,
    launch: {
      ...value.launch,
      envReferences: [{ name: "READ_TOKEN", reference: ref }],
    },
  });
  assert.deepEqual(normalized.credentialReference, ref);
  assert.equal(JSON.stringify(normalized).includes("authorization"), false);
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...value,
        credentialReference: { ...ref, token: "raw" },
      }),
    fails("INVALID_AGENT_BACKEND"),
  );
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...value,
        credentialReference: { ...ref, id: "token:raw" },
      }),
    fails("AGENT_BACKEND_CREDENTIAL_INVALID"),
  );
  assert.throws(
    () =>
      validateAgentBackendSpec({
        ...value,
        credentialReference: { ...ref, audience: "other:peer" },
      }),
    fails("AGENT_BACKEND_CREDENTIAL_AUDIENCE_MISMATCH"),
  );
});
test("getters, proxies, serializers, sparse arrays and cycles are rejected without evaluation", () => {
  let accessed = 0;
  const getter = Object.defineProperty({ ...definition() }, "target", {
    enumerable: true,
    get() {
      accessed++;
      return target();
    },
  });
  const proxy = new Proxy(definition(), {
    ownKeys() {
      accessed++;
      throw new Error("executed");
    },
  });
  const serial = {
    ...definition(),
    toJSON() {
      accessed++;
      return definition();
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [getter, proxy, serial, Array(2), cycle])
    assert.throws(
      () => agentBackendJson(value),
      fails("INVALID_AGENT_BACKEND", "AGENT_BACKEND_LIMIT"),
    );
  assert.equal(accessed, 0);
});
test("bounded UTF-8 and deep data reject malformed strings and oversized/deep graphs", () => {
  assert.throws(
    () => validateAgentBackendSpec({ ...definition(), description: "\ud800" }),
    fails("AGENT_BACKEND_LIMIT"),
  );
  assert.throws(
    () =>
      agentBackendJson({ body: "a".repeat(AGENT_BACKEND_LIMITS.frameBytes) }),
    fails("AGENT_BACKEND_LIMIT"),
  );
  let deep: unknown = {};
  for (let i = 0; i < 15; i++) deep = { data: deep };
  assert.throws(() => agentBackendJson(deep), fails("AGENT_BACKEND_LIMIT"));
});
