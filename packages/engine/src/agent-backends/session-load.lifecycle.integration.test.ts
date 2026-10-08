import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  EngineError,
  type JsonObject,
  type RunConfig,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { groupExists } from "../tools/command/process-control.js";
import type {
  AgentBackendSessionLoad,
  AgentBackendSpecInput,
} from "./types.js";
import {
  backendCommand,
  backendFixture,
  backendUntil,
} from "./fixtures/backend.js";
import { sessionLoadLifecyclePeer } from "./fixtures/session-load-lifecycle-peer.js";

function code(expected: string) {
  return (error: unknown) =>
    error instanceof EngineError && error.code === expected;
}
async function lifecycleFixture(t: TestContext) {
  const f = await backendFixture(t, {
    mode: "lifecycle",
    tools: ["read_file", "apply_patch", "run_command"],
    toolPolicy: [{ tool: "run_command", decision: "ask" }],
    engine: { jobs: true, agentBackendClientEffects: true },
  });
  writeFileSync(f.peerPath, sessionLoadLifecyclePeer);
  const registered = f.register();
  const first = await f.submit("SOURCE_NATIVE_USER_INPUT");
  assert.equal((await first.done).state, "completed");
  const source = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
  const connection = f.engine.inspectAgentBackendConnections(
    f.workspace.id,
  )[0]!;
  assert.equal(source.state, "completed");
  assert.equal(connection.state, "closed");
  assert.equal(connection.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(connection.proof.processId), false);
  const sourceTuple: AgentBackendSessionLoad = {
    sourceBackendId: f.backendId,
    sourceBackendRevisionId: registered.result.record.id,
    sourceRequestId: source.remoteRequestId,
    sourceRequestRevisionId: source.id,
    sourceRequestSha256: source.sha256,
    sourceConnectionId: connection.connectionId,
    sourceConnectionRevisionId: connection.id,
    sourceConnectionSha256: connection.sha256,
    remoteSessionId: source.remoteSessionId,
  };
  function capture(alias: string, engine = f.engine, tuple = sourceTuple) {
    const config = { ...f.config, providerId: `acp:${alias}` };
    const original = engine.captureAgentBackendTarget({
      backendId: alias,
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      config,
      launch: f.launch,
      credentialReference: null,
      endpointAudience: "local-fixture",
      contextOwner: "agent",
      sessionLoad: tuple,
    });
    const pin = engine.readAgentBackendTarget(original);
    const spec: AgentBackendSpecInput = {
      ...f.spec(pin),
      id: alias,
      contextOwner: "agent",
      sessionLoad: tuple,
    };
    return { original, pin, spec, config };
  }
  function register(alias: string, mode: string) {
    writeFileSync(join(f.root, "load-mode.txt"), mode);
    const captured = capture(alias);
    const result = f.engine.registerAgentBackend(captured.original, {
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      expectedRevision: 0,
      spec: captured.spec,
    });
    return { ...captured, result };
  }
  async function submit(config: RunConfig, prompt = "LOAD_CURRENT_USER_INPUT") {
    const accepted = await backendCommand<{ inputId: string }>(
      f.engine,
      "input.accept",
      {
        sessionId: f.session.id,
        requestId: randomUUID(),
        prompt,
        config: config as unknown as JsonObject,
        delivery: "queue",
      },
    );
    await backendUntil(
      () => Boolean(f.engine.store.getInput(accepted.inputId).runId),
      "Actual load input did not promote",
    );
    const runId = f.engine.store.getInput(accepted.inputId).runId!;
    return { accepted, runId, done: f.engine.coordinator.waitForRun(runId) };
  }
  return {
    ...f,
    first,
    source,
    connection,
    sourceTuple,
    capture,
    registerLoad: register,
    submitLoad: submit,
  };
}

test("fresh explicit alias loads the genuine completed remote session and keeps replay out of current Tool/Part output", async (t) => {
  const f = await lifecycleFixture(t);
  const binding = f.registerLoad("lifecycle-loaded", "positive");
  const current = await f.submitLoad(binding.config);
  const run = await current.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  const connections = f.engine.inspectAgentBackendConnections(f.workspace.id);
  const loaded = connections.find(
    (value) => value.backendId === binding.spec.id,
  )!;
  const requests = f.engine.inspectAgentBackendRequests(f.workspace.id);
  const request = requests.find((value) => value.owner.runId === run.id)!;
  assert.equal(loaded.remoteSessionId, f.source.remoteSessionId);
  assert.notEqual(loaded.connectionId, f.connection.connectionId);
  assert.notEqual(request.owner.attemptId, f.source.owner.attemptId);
  assert.equal(loaded.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(loaded.proof.processId), false);
  assert.equal(request.state, "completed");
  assert.equal(request.owner.providerId, binding.config.providerId);
  assert.deepEqual(
    f.engine
      .inspectAgentBackendRequests(f.workspace.id)
      .find((value) => value.remoteRequestId === f.source.remoteRequestId),
    f.source,
  );
  const loadWire = f
    .logs()
    .filter(
      (value) =>
        value.type === "received" && value.message?.method === "session/load",
    );
  assert.equal(loadWire.length, 1);
  assert.equal(
    (loadWire[0]!.message!.params as { sessionId: string }).sessionId,
    f.source.remoteSessionId,
  );
  assert.equal(
    f
      .logs()
      .filter(
        (value) =>
          value.type === "received" && value.message?.method === "session/new",
      ).length,
    1,
  );
  const prompts = f
    .logs()
    .filter(
      (value) =>
        value.type === "received" && value.message?.method === "session/prompt",
    );
  assert.equal(prompts.length, 2);
  assert.ok(
    JSON.stringify(prompts[1]!.message).includes("LOAD_CURRENT_USER_INPUT"),
  );
  assert.equal(
    JSON.stringify(prompts[1]!.message).includes("SOURCE_NATIVE_USER_INPUT"),
    false,
  );
  const snapshot = f.engine.store.getSnapshot(f.session.id);
  const messages = snapshot.messages.filter((value) => value.runId === run.id);
  assert.ok(
    messages.some(
      (value) =>
        value.role === "assistant" &&
        value.content.includes("LOADED_CURRENT_ANSWER"),
    ),
  );
  assert.equal(
    messages.some((value) => value.content.includes("HISTORICAL_")),
    false,
  );
  const tools = snapshot.tools.filter((value) => value.runId === run.id);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "read_file");
  assert.equal(tools[0]!.state, "completed");
  assert.equal(snapshot.approvals.length, 0);
  const turns = f.engine.store.listTurns(run.id);
  assert.equal(turns.length, 1);
  assert.equal(
    f.engine.store
      .listParts(turns[0]!.id)
      .filter((value) => value.type === "tool").length,
    1,
  );
  assert.equal(existsSync(join(f.root, "historical-command.txt")), false);
  assert.throws(
    () => f.capture(binding.spec.id),
    code("BACKEND_LOAD_ALIAS_USED"),
  );
});

test("cancel during actual load joins the original process and never falls back to new or prompt", async (t) => {
  const f = await lifecycleFixture(t);
  const binding = f.registerLoad("lifecycle-cancel", "hold-load");
  const current = await f.submitLoad(binding.config);
  await backendUntil(
    () =>
      f.engine
        .inspectAgentBackendConnections(f.workspace.id)
        .some(
          (value) =>
            value.backendId === binding.spec.id &&
            value.sessionLoad?.replayHashes.length === 3,
        ),
    "Actual original load replay did not commit before cancellation",
  );
  f.engine.coordinator.cancel(current.runId);
  const run = await current.done;
  assert.equal(run.state, "cancelled", JSON.stringify(run));
  const loaded = f.engine
    .inspectAgentBackendConnections(f.workspace.id)
    .find((value) => value.backendId === binding.spec.id)!;
  assert.equal(loaded.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(loaded.proof.processId), false);
  assert.equal(loaded.sessionLoad?.state, "uncertain");
  assert.equal(loaded.state, "uncertain");
  assert.equal(loaded.errorCode, "BACKEND_LOAD_UNCERTAIN");
  assert.equal(f.engine.store.hasUncertainAgentBackend(f.workspace.id), true);
  const attempt = f
    .rows("provider_attempts")
    .find((row) => row.run_id === run.id)!;
  assert.equal(
    f.engine.store.getAttemptCleanup(String(attempt.id), f.session.id)
      .cleanupConfirmed,
    true,
  );
  assert.equal(
    f
      .logs()
      .filter(
        (value) =>
          value.type === "received" && value.message?.method === "session/new",
      ).length,
    1,
  );
  assert.equal(
    f
      .logs()
      .filter(
        (value) =>
          value.type === "received" &&
          value.message?.method === "session/prompt",
      ).length,
    1,
  );
  assert.equal(f.engine.inspectAgentBackendRequests(f.workspace.id).length, 1);
  assert.equal(
    f.engine.store
      .getSnapshot(f.session.id)
      .tools.filter((value) => value.runId === run.id).length,
    0,
  );
  assert.deepEqual(
    f.engine.inspectAgentBackendRequests(f.workspace.id)[0],
    f.source,
  );
});

test("false load capability fails without sending load, replacement new, or current prompt", async (t) => {
  const f = await lifecycleFixture(t);
  const binding = f.registerLoad("lifecycle-unsupported", "false-capability");
  const current = await f.submitLoad(binding.config);
  const run = await current.done;
  assert.equal(run.state, "failed", JSON.stringify(run));
  assert.equal(run.error?.code, "ACP_LOAD_UNSUPPORTED");
  assert.equal(
    f
      .logs()
      .some(
        (value) =>
          value.type === "received" && value.message?.method === "session/load",
      ),
    false,
  );
  assert.equal(
    f
      .logs()
      .filter(
        (value) =>
          value.type === "received" && value.message?.method === "session/new",
      ).length,
    1,
  );
  assert.equal(
    f
      .logs()
      .filter(
        (value) =>
          value.type === "received" &&
          value.message?.method === "session/prompt",
      ).length,
    1,
  );
  const loaded = f.engine
    .inspectAgentBackendConnections(f.workspace.id)
    .find((value) => value.backendId === binding.spec.id)!;
  assert.equal(loaded.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(loaded.proof.processId), false);
});

for (const mode of ["effect-write", "effect-terminal", "effect-permission"]) {
  test(`actual ${mode} RPC during load is rejected without native tool, approval, file or process effect`, async (t) => {
    const f = await lifecycleFixture(t);
    const binding = f.registerLoad(`lifecycle-${mode}`, mode);
    const current = await f.submitLoad(binding.config);
    const run = await current.done;
    assert.equal(run.state, "failed", JSON.stringify(run));
    assert.equal(run.error?.code, "ACP_LOAD_EFFECT_UNSUPPORTED");
    const snapshot = f.engine.store.getSnapshot(f.session.id);
    assert.equal(
      snapshot.tools.filter((value) => value.runId === run.id).length,
      0,
    );
    assert.equal(snapshot.approvals.length, 0);
    assert.equal(f.engine.inspectOwnedCommandJobs(f.workspace.id).length, 0);
    assert.equal(existsSync(join(f.root, "forbidden-loaded-write.txt")), false);
    assert.equal(existsSync(join(f.root, "forbidden-loaded-pid.txt")), false);
    assert.equal(f.engine.inspectAgentBackendEffects(f.workspace.id).length, 1);
    assert.equal(
      f
        .logs()
        .filter(
          (value) =>
            value.type === "received" &&
            value.message?.method === "session/prompt",
        ).length,
      1,
    );
    const loaded = f.engine
      .inspectAgentBackendConnections(f.workspace.id)
      .find((value) => value.backendId === binding.spec.id)!;
    assert.equal(loaded.disposal?.cleanupConfirmed, true);
    assert.equal(groupExists(loaded.proof.processId), false);
  });
}

test("copied Original, changed genuine source and reused source alias cannot activate a load binding", async (t) => {
  const f = await lifecycleFixture(t);
  const captured = f.capture("lifecycle-copy");
  assert.throws(
    () =>
      f.engine.registerAgentBackend(
        { ...captured.original },
        {
          workspaceId: f.workspace.id,
          requestId: randomUUID(),
          expectedRevision: 0,
          spec: captured.spec,
        },
      ),
    code("BACKEND_ORIGINAL_REQUIRED"),
  );
  assert.throws(
    () => f.capture(f.backendId),
    code("AGENT_BACKEND_LOAD_ALIAS_REQUIRED"),
  );
  assert.throws(
    () =>
      f.capture("lifecycle-foreign", f.engine, {
        ...f.sourceTuple,
        sourceRequestSha256: "0".repeat(64),
      }),
    code("BACKEND_LOAD_SOURCE_INVALID"),
  );
  assert.equal(f.engine.inspectAgentBackends(f.workspace.id).length, 1);
  assert.equal(f.logs().filter((value) => value.type === "started").length, 1);
});

test("reopened and imported completed remote history cannot issue a fresh load grant or replay any prompt", async (t) => {
  const f = await lifecycleFixture(t);
  await f.engine.close();
  const beforeLogs = f.logs();
  const reopened = createEngine(f.configuration);
  f.engines.add(reopened);
  assert.throws(
    () => f.capture("lifecycle-reopened", reopened),
    code("BACKEND_LOAD_SOURCE_INVALID"),
  );
  assert.deepEqual(f.logs(), beforeLogs);
  await reopened.close();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, "lifecycle-archive"),
  });
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(f.base, "lifecycle-import"),
  });
  const restored = createEngine({
    ...f.configuration,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
  });
  f.engines.add(restored);
  assert.equal(
    restored.inspectAgentBackendRequests(f.workspace.id)[0]!.state,
    "paused-import",
  );
  assert.equal(
    restored.getCapabilities().providerIds.includes(f.config.providerId),
    false,
  );
  assert.throws(
    () => f.capture("lifecycle-imported", restored),
    code("BACKEND_LOAD_SOURCE_INVALID"),
  );
  await restored.waitForSession(f.session.id);
  assert.deepEqual(f.logs(), beforeLogs);
  assert.equal(restored.inspectAgentBackends(f.workspace.id).length, 1);
});
