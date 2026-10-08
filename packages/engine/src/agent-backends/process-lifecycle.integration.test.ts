import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { groupExists } from "../tools/command/process-control.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
import { backendFixture, backendUntil } from "./fixtures/backend.js";
import type { BackendConnectionProof } from "./process.js";
import type { AgentBackendStorage } from "./store.js";

test("actual killed supervisor cannot leave its original peer running or falsely confirm durable cleanup", async (t) => {
  const f = await backendFixture(t, { mode: "hold" });
  f.register();
  const { done } = await f.submit();
  await backendUntil(
    () => f.logs().some((line) => line.message?.method === "session/prompt"),
    "The actual peer did not receive its held prompt",
  );
  const processes = Reflect.get(f.engine, "backendProcesses") as {
    active: Set<{ child: ChildProcess; proof: BackendConnectionProof }>;
  };
  assert.equal(processes.active.size, 1);
  const processState = [...processes.active][0]!;
  assert.ok(processState.child.pid);
  assert.equal(groupExists(processState.proof.processId), true);
  process.kill(processState.child.pid!, "SIGKILL");
  const run = await done;
  assert.equal(run.state, "failed");
  assert.equal(
    groupExists(processState.proof.processId),
    false,
    "The original peer group must be terminated after supervisor loss",
  );
  const request = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!,
    connection = f.engine.inspectAgentBackendConnections(f.workspace.id)[0]!;
  assert.equal(request.state, "uncertain");
  assert.equal(request.terminal, null);
  assert.equal(connection.state, "uncertain");
  assert.equal(connection.disposal?.cleanupConfirmed, false);
  const cleanup = f.engine.store.getAttemptCleanup(request.owner.attemptId);
  assert.equal(cleanup.state, "uncertain");
  assert.equal(
    inspectExecutionLock(Reflect.get(f.engine, "executionLockPath") as string)
      .status,
    "uncertain",
  );
});

test("closed remote generator cannot convert a persistent native disposal receipt failure into confirmed Attempt cleanup", async (t) => {
  const f = await backendFixture(t);
  f.register();
  const native = Reflect.get(f.engine, "backendRecords") as AgentBackendStorage;
  const original = native.disposeConnection.bind(native);
  native.disposeConnection = () => {
    throw new EngineError(
      "BACKEND_DISPOSAL_RECEIPT_FAILED",
      "Actual native disposal receipt injection",
    );
  };
  try {
    const { done } = await f.submit();
    const run = await done;
    assert.equal(run.state, "failed");
    const request = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!,
      connection = f.engine.inspectAgentBackendConnections(f.workspace.id)[0]!;
    assert.equal(request.state, "uncertain");
    assert.equal(request.terminal, null);
    assert.equal(connection.disposal, null);
    assert.equal(
      groupExists(connection.proof.processId),
      false,
      "The actual peer still has confirmed physical termination",
    );
    assert.equal(
      f.engine.store.getAttemptCleanup(request.owner.attemptId).state,
      "uncertain",
    );
    assert.equal(
      f.logs().filter((line) => line.message?.method === "session/prompt")
        .length,
      1,
    );
  } finally {
    native.disposeConnection = original;
  }
});
