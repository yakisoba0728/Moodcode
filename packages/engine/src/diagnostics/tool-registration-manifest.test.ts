import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { ToolPolicy } from "../permission/policy.js";
import type { ToolDefinition } from "../ports.js";
import {
  ScopedToolRuntime,
  type ToolRegistrationCapture,
} from "../tools/runtime/index.js";
import { createToolRegistrationManifest } from "./tool-registration-manifest.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture() {
  const calls = { prepare: 0, execute: 0, revalidate: 0, evaluate: 0 };
  const source: ToolDefinition = {
    name: "host_tool",
    description: "private-description-한글",
    effectClass: "write",
    inputSchema: {
      type: "object",
      properties: { private_key: { type: "string" } },
    },
    async prepare() {
      calls.prepare++;
      throw new Error("Unexpected prepare");
    },
    async execute() {
      calls.execute++;
      throw new Error("Unexpected producer");
    },
  };
  const policy = new ToolPolicy([{ tool: source.name, decision: "deny" }]);
  const evaluate = policy.evaluate.bind(policy);
  policy.evaluate = (input) => {
    calls.evaluate++;
    return evaluate(input);
  };
  const runtime = new ScopedToolRuntime({ policy });
  const revoke = runtime.register("engine", source, {
    effect: "write",
    exactApproval: true,
    async revalidate() {
      calls.revalidate++;
    },
  });
  return { source, policy, runtime, revoke, calls };
}

test("original registration inspector exposes only frozen bounded hashes and does not evaluate policy or invoke handlers", () => {
  const f = fixture();
  f.runtime.catalogue = () => {
    throw new Error("Inspector cannot materialize catalogue");
  };
  const manifest = f.runtime.inspectToolRegistration("engine", "host_tool");
  assert.equal(manifest.projection, "tool-registration-manifest-v1");
  assert.equal(manifest.authority, "observation-only");
  assert.equal(
    manifest.schemaSha256,
    hash('{"properties":{"private_key":{"type":"string"}},"type":"object"}'),
  );
  assert.equal(
    manifest.schemaBytes,
    Buffer.byteLength(JSON.stringify(f.source.inputSchema)),
  );
  assert.equal(manifest.descriptionSha256, hash(f.source.description));
  assert.equal(
    manifest.descriptionBytes,
    Buffer.byteLength(f.source.description),
  );
  assert.equal(manifest.effectClass, "write");
  assert.equal(manifest.exactApproval, true);
  assert.equal(manifest.policyRevision, f.policy.version);
  assert.equal(manifest.registrationRevision, 1);
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 2048);
  assert.ok(!JSON.stringify(manifest).includes("private-description"));
  assert.ok(!JSON.stringify(manifest).includes("private_key"));
  const { manifestSha256, ...body } = manifest;
  assert.equal(manifestSha256, hash(JSON.stringify(body)));
  assert.deepEqual(
    f.runtime.inspectToolRegistration("engine", "host_tool"),
    manifest,
  );
  assert.deepEqual(f.calls, {
    prepare: 0,
    execute: 0,
    revalidate: 0,
    evaluate: 0,
  });
});

test("post-registration source mutation and hostile replacement getters cannot change original captured descriptors", () => {
  const f = fixture(),
    before = f.runtime.inspectToolRegistration("engine", "host_tool");
  f.source.inputSchema.type = "array";
  f.source.effectClass = "network";
  let getters = 0;
  for (const key of ["description", "inputSchema", "prepare", "execute"])
    Object.defineProperty(f.source, key, {
      configurable: true,
      get() {
        getters++;
        throw new Error("Mutable source accessor");
      },
    });
  assert.deepEqual(
    f.runtime.inspectToolRegistration("engine", "host_tool"),
    before,
  );
  assert.equal(getters, 0);
  assert.deepEqual(f.calls, {
    prepare: 0,
    execute: 0,
    revalidate: 0,
    evaluate: 0,
  });
});

test("current registry and policy revisions change projection identity while same-entry identity remains pinned", () => {
  const f = fixture(),
    before = f.runtime.inspectToolRegistration("engine", "host_tool");
  f.runtime.register("other", { ...f.source, name: "another_tool" });
  const added = f.runtime.inspectToolRegistration("engine", "host_tool");
  assert.equal(added.registryRevision, before.registryRevision + 1);
  assert.equal(added.registrationSha256, before.registrationSha256);
  assert.notEqual(added.manifestSha256, before.manifestSha256);
  f.policy.replace([{ tool: "host_tool", decision: "allow" }]);
  const changed = f.runtime.inspectToolRegistration("engine", "host_tool");
  assert.equal(changed.registrationRevision, before.registrationRevision);
  assert.notEqual(changed.policyRevision, before.policyRevision);
  assert.notEqual(changed.manifestSha256, added.manifestSha256);
  f.revoke();
  assert.throws(
    () => f.runtime.inspectToolRegistration("engine", "host_tool"),
    code("TOOL_NOT_FOUND"),
  );
  f.runtime.register("engine", f.source, {
    effect: "write",
    exactApproval: true,
  });
  const replacement = f.runtime.inspectToolRegistration("engine", "host_tool");
  assert.equal(replacement.schemaSha256, before.schemaSha256);
  assert.notEqual(replacement.registrationSha256, before.registrationSha256);
  assert.ok(replacement.registrationRevision > before.registrationRevision);
  assert.equal(before.registryRevision, 1);
  assert.deepEqual(f.calls, {
    prepare: 0,
    execute: 0,
    revalidate: 0,
    evaluate: 0,
  });
});

test("exact producer scope is required and composed catalogue visibility grants no inspector or producer authority", () => {
  const f = fixture();
  f.runtime.setIncludedScopes("parent", ["engine"]);
  assert.throws(
    () => f.runtime.inspectToolRegistration("parent", "host_tool"),
    code("TOOL_NOT_FOUND"),
  );
  const manifest = f.runtime.inspectToolRegistration("engine", "host_tool");
  const catalogue = f.runtime.catalogue("engine");
  assert.throws(
    () =>
      f.runtime.assertRegistrationCurrent(
        catalogue,
        manifest as unknown as ToolRegistrationCapture,
      ),
    code("TOOL_PRODUCER_MISMATCH"),
  );
  assert.throws(
    () => f.runtime.inspectToolRegistration("engine", "invented_tool"),
    code("TOOL_NOT_FOUND"),
  );
  assert.equal(f.calls.prepare, 0);
  assert.equal(f.calls.execute, 0);
  assert.equal(f.calls.revalidate, 0);
});

test("malformed scalar selection rejects before private registry reads or coercion", () => {
  const f = fixture();
  const scopes = Reflect.get(f.runtime, "scopes") as Map<string, unknown>;
  const original = scopes.get.bind(scopes);
  let reads = 0,
    coercions = 0;
  scopes.get = (key) => {
    reads++;
    return original(key);
  };
  const hostile = {
    toString() {
      coercions++;
      throw new Error("Selection coercion");
    },
  };
  for (const invalid of [
    "",
    "bad/name",
    "a".repeat(129),
    null,
    hostile,
    Symbol("name"),
  ]) {
    assert.throws(
      () => f.runtime.inspectToolRegistration(invalid as string, "host_tool"),
      code("INVALID_TOOL_REGISTRATION"),
    );
    assert.throws(
      () => f.runtime.inspectToolRegistration("engine", invalid as string),
      code("INVALID_TOOL_REGISTRATION"),
    );
  }
  assert.equal(reads, 0);
  assert.equal(coercions, 0);
  assert.equal(f.calls.evaluate, 0);
});

test("detached manifest builder rejects accessors, proxies, malformed hashes and unbounded data without invoking them", () => {
  const manifest = fixture().runtime.inspectToolRegistration(
    "engine",
    "host_tool",
  );
  const {
    schemaVersion: _version,
    projection: _projection,
    authority: _authority,
    manifestSha256: _hash,
    ...observation
  } = manifest;
  let getters = 0,
    traps = 0;
  const hostile = { ...observation };
  Object.defineProperty(hostile, "schemaSha256", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("Metadata getter");
    },
  });
  assert.throws(
    () => createToolRegistrationManifest(hostile),
    code("INVALID_TOOL_REGISTRATION_MANIFEST"),
  );
  assert.throws(
    () =>
      createToolRegistrationManifest(
        new Proxy(observation, {
          ownKeys() {
            traps++;
            throw new Error("Proxy trap");
          },
        }),
      ),
    code("INVALID_TOOL_REGISTRATION_MANIFEST"),
  );
  for (const data of [
    null,
    [],
    { ...observation, schemaSha256: "wrong" },
    { ...observation, schemaBytes: 65_537 },
    { ...observation, registrationRevision: 0 },
    { ...observation, exactApproval: "true" },
    { ...observation, extra: true },
  ])
    assert.throws(
      () => createToolRegistrationManifest(data as never),
      code("INVALID_TOOL_REGISTRATION_MANIFEST"),
    );
  assert.equal(getters, 0);
  assert.equal(traps, 0);
  assert.deepEqual(createToolRegistrationManifest(observation), manifest);
});

test("actual Engine host inspector preserves private tool arrays and exposes current policy/revocation without provider effects", async (t) => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "moodcode-registration-inspector-")),
  );
  const f = fixture(),
    policy = new ToolPolicy(),
    tools = [f.source];
  let providers = 0;
  const engine = createEngine({
    dbPath: join(directory, "engine.sqlite"),
    artifactDir: join(directory, "artifacts"),
    tools,
    toolPolicyInstance: policy,
    providers: [
      {
        id: "inspection",
        async *streamTurn() {
          providers++;
          throw new Error("Provider invocation prohibited");
        },
      },
    ],
    defaults: { providerId: "inspection", modelId: "fixture", mode: "plan" },
  });
  t.after(async () => {
    await engine.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const before = engine.inspectToolRegistration("host_tool");
  tools.length = 0;
  f.source.description = "changed external description";
  assert.deepEqual(engine.inspectToolRegistration("host_tool"), before);
  policy.replace([{ tool: "host_tool", decision: "deny" }]);
  const denied = engine.inspectToolRegistration("host_tool");
  assert.notEqual(denied.policyRevision, before.policyRevision);
  assert.equal(denied.registrationSha256, before.registrationSha256);
  engine.toolRuntime.clearScope("engine");
  assert.throws(
    () => engine.inspectToolRegistration("host_tool"),
    code("TOOL_NOT_FOUND"),
  );
  assert.equal(providers, 0);
  assert.equal(f.calls.prepare, 0);
  assert.equal(f.calls.execute, 0);
  assert.equal(f.calls.revalidate, 0);
  await engine.close();
  assert.throws(
    () => engine.inspectToolRegistration("host_tool"),
    code("ENGINE_CLOSED"),
  );
});
