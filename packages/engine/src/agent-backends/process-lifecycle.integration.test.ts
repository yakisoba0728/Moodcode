import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { groupExists } from "../tools/command/process-control.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
import { backendFixture, backendUntil } from "./fixtures/backend.js";
import type {
  BackendConnectionProof,
  OwnedBackendProcesses,
} from "./process.js";
import type { AgentBackendStorage } from "./store.js";
import type { AcpV1Message } from "./types.js";

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

test("a peer that never starts reports its start failure and releases the shared execution lock", async (t) => {
  const f = await backendFixture(t);
  const command = join(f.root, "not-executable");
  writeFileSync(command, "#!/bin/sh\n", { mode: 0o644 });
  f.register({ ...f.launch, command, args: [] });
  const { runId, done } = await f.submit();
  const run = await done;
  assert.equal(run.state, "failed");
  assert.equal(run.error?.code, "BACKEND_PROCESS_START_FAILED");
  assert.equal(
    inspectExecutionLock(Reflect.get(f.engine, "executionLockPath") as string)
      .status,
    "available",
  );
  const attempt = f
    .rows("provider_attempts")
    .find((row) => row.run_id === runId)!;
  assert.notEqual(
    f.engine.store.getAttemptCleanup(String(attempt.id)).state,
    "uncertain",
  );
  assert.deepEqual(f.engine.inspectAgentBackendConnections(f.workspace.id), []);
});

test("a frame burst beyond the receive queue threshold is delivered in order through backpressure", async (t) => {
  const f = await backendFixture(t, { mode: "burst" });
  f.register();
  const { runId, done } = await f.submit();
  const run = await done;
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  const text = f.engine.store
    .listTurns(runId)
    .flatMap((turn) => f.engine.store.listParts(turn.id))
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  assert.equal(
    text,
    Array.from({ length: 200 }, (_, index) => `${index},`).join(""),
  );
  const connection = f.engine.inspectAgentBackendConnections(
    f.workspace.id,
  )[0]!;
  assert.equal(connection.disposal?.cleanupConfirmed, true);
});

test("a turn failing while its receive queue is paused still confirms process cleanup", async (t) => {
  const f = await backendFixture(t, { mode: "burst-foreign" });
  f.register();
  const { done } = await f.submit();
  const run = await done;
  assert.equal(run.state, "failed");
  assert.equal(run.error?.code, "BACKEND_REMOTE_SESSION_INVALID");
  const connection = f.engine.inspectAgentBackendConnections(
    f.workspace.id,
  )[0]!;
  assert.equal(connection.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(connection.proof.processId), false);
  assert.equal(
    inspectExecutionLock(Reflect.get(f.engine, "executionLockPath") as string)
      .status,
    "available",
  );
});

test("an aborted write keeps the transport write lock until its IPC receipt settles", async (t) => {
  const f = await backendFixture(t, { mode: "hold" });
  f.register();
  const { runId, done } = await f.submit();
  await backendUntil(
    () => f.logs().some((line) => line.message?.method === "session/prompt"),
    "The actual peer did not receive its held prompt",
  );
  const processes = Reflect.get(
    f.engine,
    "backendProcesses",
  ) as OwnedBackendProcesses;
  const state = [
    ...(Reflect.get(processes, "active") as Set<{
      handle: object;
      child: ChildProcess;
    }>),
  ][0]!;
  const send = state.child.send.bind(state.child);
  const dispatched: unknown[] = [];
  let release: (() => void) | undefined;
  state.child.send = ((
    packet: { type?: string },
    callback: (error: Error | null) => void,
  ) => {
    if (packet.type !== "write") return send(packet, callback);
    dispatched.push(packet);
    if (dispatched.length > 1) return send(packet, callback);
    // Delay the supervisor receipt to model a peer that is slow to read stdin.
    release = () => send(packet, callback);
    return true;
  }) as typeof state.child.send;
  const notice = (text: string): AcpV1Message => ({
    jsonrpc: "2.0",
    method: "fixture/notice",
    params: { text },
  });
  const aborted = new AbortController();
  const first = processes.write(state.handle, notice("first"), aborted.signal);
  await backendUntil(
    () => release !== undefined,
    "The first write was not sent",
  );
  aborted.abort(new EngineError("CANCELLED", "Fixture write abort"));
  await assert.rejects(first, { code: "CANCELLED" });
  const second = processes.write(
    state.handle,
    notice("second"),
    AbortSignal.timeout(5_000),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dispatched.length, 1, "The next write waits for the receipt");
  release!();
  processes.releaseWrite(await second);
  assert.equal(dispatched.length, 2);
  processes.assertConnectionCurrent(state.handle);
  f.engine.coordinator.cancel(runId);
  assert.equal((await done).state, "cancelled");
});
