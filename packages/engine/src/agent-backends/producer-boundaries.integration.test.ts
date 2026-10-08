import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import test from "node:test";
import {
  EngineError,
  type InputReceipt,
  type JsonObject,
  type RunReceipt,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { groupExists } from "../tools/command/process-control.js";
import {
  backendCommand,
  backendFixture,
  backendUntil,
} from "./fixtures/backend.js";

const failure =
  (...codes: string[]) =>
  (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.ok(
      codes.includes(error.code),
      `Expected ${codes.join("|")}; received ${error.code}`,
    );
    return true;
  };

test("registered script drift before queued provider admission creates no peer, prompt, effect or fabricated terminal", async (t) => {
  const f = await backendFixture(t);
  f.register();
  await backendCommand(f.engine, "session.pause", { sessionId: f.session.id });
  const receipt = await backendCommand<InputReceipt>(f.engine, "input.accept", {
    sessionId: f.session.id,
    requestId: randomUUID(),
    prompt: "Use only the exact registered source.",
    config: f.config as unknown as JsonObject,
    delivery: "queue",
  });
  const input = f.engine.store.getInput(receipt.inputId);
  assert.equal(f.engine.store.getInput(input.id).state, "pending");
  assert.deepEqual(f.logs(), []);
  appendFileSync(
    f.peerPath,
    "\n// Source changed after ORIGINAL registration.\n",
  );
  await backendCommand(f.engine, "session.resume", { sessionId: f.session.id });
  await backendUntil(
    () => Boolean(f.engine.store.getInput(input.id).runId),
    "Actual queued input was not promoted",
  );
  const runId = f.engine.store.getInput(input.id).runId!,
    run = await f.engine.waitForRun(runId);
  assert.equal(run.state, "failed");
  assert.deepEqual(f.logs(), []);
  assert.deepEqual(f.engine.inspectAgentBackendConnections(f.workspace.id), []);
  assert.deepEqual(f.engine.inspectAgentBackendRequests(f.workspace.id), []);
  assert.deepEqual(f.engine.inspectAgentBackendEffects(f.workspace.id), []);
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 0);
  assert.equal(
    f.rows("provider_attempts").filter((row) => row.run_id === runId).length,
    1,
  );
  await f.engine.waitForSession(f.session.id);
  assert.deepEqual(f.logs(), []);
  assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 1);
});

test("public registration rejects executable DTOs and changed genuine target/config/tools/credential source before SQL or process effects", async (t) => {
  const f = await backendFixture(t),
    captured = f.target(),
    spec = f.spec(captured.pin),
    before = f.rows("backend_revisions");
  let traps = 0;
  const input = () => ({
    workspaceId: f.workspace.id,
    requestId: randomUUID(),
    expectedRevision: 0,
    spec,
  });
  const getter = Object.defineProperty(input(), "spec", {
    enumerable: true,
    get() {
      traps++;
      throw new Error("DTO accessor invoked");
    },
  });
  const proxy = new Proxy(input(), {
    ownKeys() {
      traps++;
      throw new Error("DTO proxy invoked");
    },
    get() {
      traps++;
      throw new Error("DTO proxy invoked");
    },
  });
  for (const executable of [getter, proxy])
    assert.throws(
      () => f.engine.registerAgentBackend(captured.original, executable),
      failure("INVALID_AGENT_BACKEND"),
    );
  assert.equal(traps, 0);
  assert.deepEqual(f.rows("backend_revisions"), before);
  assert.deepEqual(f.logs(), []);
  const changedConfig = {
    ...captured.pin.config,
    modelId: "changed-host-model",
  };
  const changed = [
    {
      ...spec,
      target: { ...captured.pin, workspaceBindingSha256: "d".repeat(64) },
    },
    {
      ...spec,
      target: {
        ...captured.pin,
        config: changedConfig,
        runConfigSha256: knowledgeHash(changedConfig),
      },
    },
    { ...spec, target: { ...captured.pin, tools: [] } },
    {
      ...spec,
      credentialReference: {
        id: "host:unselected",
        audience: spec.endpointAudience,
      },
    },
    {
      ...spec,
      credentialReference: {
        id: "host:unselected",
        audience: "different-peer",
      },
    },
  ];
  for (const replacement of changed) {
    assert.throws(
      () =>
        f.engine.registerAgentBackend(captured.original, {
          ...input(),
          spec: replacement,
        }),
      failure(
        "BACKEND_TARGET_STALE",
        "AGENT_BACKEND_CREDENTIAL_AUDIENCE_MISMATCH",
      ),
    );
    assert.deepEqual(f.rows("backend_revisions"), before);
    assert.deepEqual(f.rows("backend_heads"), []);
    assert.deepEqual(f.logs(), []);
    assert.equal(traps, 0);
  }
  const valid = f.engine.registerAgentBackend(captured.original, input());
  assert.equal(valid.record.enabled, true);
  assert.equal(f.engine.inspectAgentBackends(f.workspace.id).length, 1);
  assert.deepEqual(f.logs(), []);
  f.engine.releaseAgentBackendTarget(captured.original);
});

test("second adapter entry with the exact same original native Attempt cannot launch another process", async (t) => {
  const f = await backendFixture(t);
  f.register();
  const providers = Reflect.get(f.engine, "runtimeProviders") as Map<
      string,
      ProviderAdapter
    >,
    actual = providers.get(f.config.providerId)!;
  assert.ok(actual);
  let checked = false,
    originalRequest: TurnRequest | undefined,
    providerEntries = 0,
    adapterFailure: unknown;
  const wrapper: ProviderAdapter = {
    id: actual.id,
    inputModalities: actual.inputModalities,
    retryableHttpStatuses: actual.retryableHttpStatuses,
    streamTurn(request, signal) {
      providerEntries++;
      originalRequest = request;
      const first = actual.streamTurn(request, signal)[Symbol.asyncIterator]();
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              let item: IteratorResult<ProviderEvent>;
              try {
                item = await first.next();
              } catch (error) {
                adapterFailure = error;
                throw error;
              }
              if (!checked && !item.done && item.value.type === "progress") {
                checked = true;
                f.engine.coordinator.assertProviderRequest(request, "dispatch");
                const duplicate = actual
                  .streamTurn(request, signal)
                  [Symbol.asyncIterator]();
                await assert.rejects(
                  duplicate.next(),
                  failure(
                    "BACKEND_ATTEMPT_ALREADY_BOUND",
                    "BACKEND_ATTEMPT_ALREADY_LAUNCHED",
                  ),
                );
                await duplicate.return?.();
                f.engine.coordinator.assertProviderRequest(request, "dispatch");
              }
              return item;
            },
            return: async (value?: unknown) =>
              first.return
                ? first.return(value)
                : { done: true as const, value: undefined },
          };
        },
      };
    },
  };
  providers.set(actual.id, wrapper);
  t.after(() => providers.set(actual.id, actual));
  const { runId, done } = await f.submit();
  const run = await done;
  assert.equal(
    run.state,
    "completed",
    adapterFailure instanceof Error
      ? (adapterFailure.stack ?? adapterFailure.message)
      : JSON.stringify(run),
  );
  assert.equal(checked, true);
  assert.ok(originalRequest);
  assert.equal(providerEntries, 1);
  assert.equal(f.logs().filter((row) => row.type === "started").length, 1);
  assert.equal(
    f.logs().filter((row) => row.message?.method === "session/prompt").length,
    1,
  );
  assert.equal(
    f.engine.inspectAgentBackendConnections(f.workspace.id).length,
    1,
  );
  assert.equal(f.engine.inspectAgentBackendRequests(f.workspace.id).length, 1);
  assert.equal(f.engine.inspectAgentBackendEffects(f.workspace.id).length, 1);
  assert.equal(
    f.rows("provider_attempts").filter((row) => row.run_id === runId).length,
    1,
  );
});

test("closing an Engine with an active peer confirms physical cleanup and preserves durable uncertainty on default-off reopen", async (t) => {
  const f = await backendFixture(t, { mode: "hold" });
  f.register();
  const { runId, done } = await f.submit();
  await backendUntil(
    () => f.logs().some((row) => row.message?.method === "session/prompt"),
    "Actual peer did not receive its held prompt",
  );
  const original = f.engine.inspectAgentBackendConnections(f.workspace.id)[0]!;
  assert.ok(original.proof.processId > 0);
  assert.equal(groupExists(original.proof.processId), true);
  await f.engine.close();
  assert.equal((await done).state, "cancelled");
  assert.equal(groupExists(original.proof.processId), false);
  const preserved = f.rows("backend_revisions"),
    logs = f.logs();
  const reopened = createEngine({ ...f.configuration, agentBackends: false });
  f.engines.add(reopened);
  const requests = reopened.inspectAgentBackendRequests(f.workspace.id),
    connections = reopened.inspectAgentBackendConnections(f.workspace.id);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.state, "uncertain");
  assert.equal(requests[0]!.terminal, null);
  assert.equal(connections.length, 1);
  assert.equal(connections[0]!.disposal?.cleanupConfirmed, true);
  assert.equal(connections[0]!.state, "closed");
  assert.equal(reopened.store.hasUncertainAgentBackend(f.workspace.id), true);
  assert.equal(reopened.store.hasUncertainWorkspace(f.workspace.id), true);
  assert.deepEqual(f.rows("backend_revisions"), preserved);
  assert.deepEqual(f.logs(), logs);
  const { agentProfileId: _profile, ...legacyConfig } = f.config;
  const reply = await reopened.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: "run.submit",
    payload: {
      sessionId: f.session.id,
      requestId: randomUUID(),
      prompt: "Must remain held by the original uncertain backend.",
      config: {
        ...legacyConfig,
        providerId: "scripted",
      } as unknown as JsonObject,
    },
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.error?.code, "CLEANUP_PENDING");
  assert.equal(reopened.store.getSnapshot(f.session.id).runs.length, 1);
  assert.equal(reopened.store.getRun(runId).state, "cancelled");
  assert.deepEqual(f.logs(), logs);
});
