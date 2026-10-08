import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { groupExists } from "../tools/command/process-control.js";
import {
  backendCommand,
  backendFixture,
  backendUntil,
} from "./fixtures/backend.js";

test("actual owned stdio peer reads through one native Attempt and settles only after confirmed disposal", async (t) => {
  const f = await backendFixture(t);
  f.register();
  const { runId, done } = await f.submit();
  const run = await done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  const requests = f.engine.inspectAgentBackendRequests(f.workspace.id),
    effects = f.engine.inspectAgentBackendEffects(f.workspace.id),
    connections = f.engine.inspectAgentBackendConnections(f.workspace.id);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.state, "completed");
  assert.equal(effects.length, 1);
  assert.equal(effects[0]!.state, "completed");
  assert.ok(effects[0]!.delivery);
  assert.equal(
    effects[0]!.completion?.content,
    "Actual native read line one.\nActual native read line two.\n",
  );
  assert.equal(connections.length, 1);
  assert.equal(connections[0]!.state, "closed");
  assert.equal(connections[0]!.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(connections[0]!.proof.processId), false);
  const turns = f.engine.store.listTurns(runId),
    attempts = f
      .rows("provider_attempts")
      .filter((row) => row.run_id === runId),
    tools = f.engine.store.getSnapshot(f.session.id).tools;
  assert.equal(turns.length, 1);
  assert.equal(attempts.length, 1);
  assert.equal(tools.length, 1);
  assert.equal(effects[0]!.completion?.turnId, turns[0]!.id);
  assert.equal(effects[0]!.completion?.attemptId, String(attempts[0]!.id));
  assert.equal(effects[0]!.completion?.toolCallId, tools[0]!.id);
  assert.equal(
    f.engine.store
      .listParts(turns[0]!.id)
      .filter((part) => part.type === "tool").length,
    1,
  );
  assert.equal(
    f.logs().filter((line) => line.message?.method === "session/prompt").length,
    1,
  );
  const readResponse = f
    .logs()
    .find(
      (line) => line.message?.id === "native-read" && "result" in line.message!,
    );
  assert.deepEqual(readResponse?.message?.result, {
    content: effects[0]!.completion!.content,
  });
});

test("default-off and copied target cannot register a backend or spawn its process", async (t) => {
  const off = await backendFixture(t, { enabled: false });
  assert.deepEqual(off.engine.inspectAgentBackends(off.workspace.id), []);
  assert.throws(
    () => off.target(),
    (error: unknown) =>
      error instanceof EngineError && error.code === "AGENT_BACKENDS_DISABLED",
  );
  assert.deepEqual(off.logs(), []);
  const f = await backendFixture(t),
    captured = f.target();
  assert.throws(
    () =>
      f.engine.registerAgentBackend(
        { ...captured.original },
        {
          workspaceId: f.workspace.id,
          requestId: "copied",
          expectedRevision: 0,
          spec: f.spec(captured.pin),
        },
      ),
    (error: unknown) =>
      error instanceof EngineError &&
      error.code === "BACKEND_ORIGINAL_REQUIRED",
  );
  assert.deepEqual(f.engine.inspectAgentBackends(f.workspace.id), []);
  assert.deepEqual(f.logs(), []);
});

test("exact native approval is awaited while the same remote prompt remains open", async (t) => {
  const f = await backendFixture(t, {
    toolPolicy: [{ tool: "read_file", decision: "ask" }],
  });
  f.register();
  const { done } = await f.submit();
  await backendUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((approval) => approval.status === "pending"),
    "Native client read did not request exact approval",
  );
  const approval = f.engine.store
    .getSnapshot(f.session.id)
    .approvals.find((item) => item.status === "pending")!;
  assert.equal(
    f.logs().filter((line) => line.message?.method === "session/prompt").length,
    1,
  );
  assert.equal(
    f
      .logs()
      .some(
        (line) =>
          line.message?.id === "native-read" && "result" in line.message!,
      ),
    false,
  );
  await backendCommand(f.engine, "approval.decide", {
    approvalId: approval.id,
    decision: "allow",
    fingerprint: approval.fingerprint,
  });
  assert.equal((await done).state, "completed");
  assert.equal(
    f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!.completion?.state,
    "completed",
  );
  assert.equal(f.engine.store.listTurns(approval.runId).length, 1);
  assert.equal(
    f.logs().filter((line) => line.message?.method === "session/prompt").length,
    1,
  );
});

test("native denial returns a failed client response with no successful content", async (t) => {
  const f = await backendFixture(t, {
    toolPolicy: [{ tool: "read_file", decision: "ask" }],
  });
  f.register();
  const { done } = await f.submit();
  await backendUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((approval) => approval.status === "pending"),
    "Native denied read did not request approval",
  );
  const approval = f.engine.store
    .getSnapshot(f.session.id)
    .approvals.find((item) => item.status === "pending")!;
  await backendCommand(f.engine, "approval.decide", {
    approvalId: approval.id,
    decision: "deny",
    fingerprint: approval.fingerprint,
  });
  assert.equal((await done).state, "completed");
  const effect = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(effect.state, "denied");
  assert.equal(effect.completion?.content, null);
  assert.ok(effect.delivery);
  const response = f
    .logs()
    .find(
      (line) => line.message?.id === "native-read" && "error" in line.message!,
    );
  assert.ok(response?.message?.error);
  assert.equal(response?.message?.result, undefined);
});

test("cancelling a held actual prompt confirms process cleanup without claiming remote completion", async (t) => {
  const f = await backendFixture(t, { mode: "hold" });
  f.register();
  const { runId, done } = await f.submit();
  await backendUntil(
    () => f.logs().some((line) => line.message?.method === "session/prompt"),
    "Actual held peer did not receive prompt",
  );
  f.engine.coordinator.cancel(runId);
  const run = await done;
  assert.equal(run.state, "cancelled");
  const request = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!,
    connection = f.engine.inspectAgentBackendConnections(f.workspace.id)[0]!;
  assert.equal(request.state, "uncertain");
  assert.equal(request.terminal, null);
  assert.equal(connection.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(connection.proof.processId), false);
});

test("EOF and a v2 message acknowledgement never count as ACP v1 prompt completion", async (t) => {
  for (const mode of ["eof", "ack"]) {
    const f = await backendFixture(t, { mode });
    f.register();
    const { done } = await f.submit();
    assert.equal((await done).state, "failed");
    const request = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
    assert.equal(request.state, "uncertain");
    assert.equal(request.terminal, null);
    assert.equal(
      f.logs().filter((line) => line.message?.method === "session/prompt")
        .length,
      1,
    );
    const connection = f.engine.inspectAgentBackendConnections(
      f.workspace.id,
    )[0]!;
    assert.equal(connection.disposal?.cleanupConfirmed, true);
    assert.equal(groupExists(connection.proof.processId), false);
  }
});

test("protocol v2 negotiation is rejected before any prompt or native client effect", async (t) => {
  const f = await backendFixture(t, { mode: "v2" });
  f.register();
  const { done } = await f.submit();
  assert.equal((await done).state, "failed");
  assert.equal(
    f.logs().filter((line) => line.message?.method === "session/prompt").length,
    0,
  );
  assert.deepEqual(f.engine.inspectAgentBackendRequests(f.workspace.id), []);
  assert.deepEqual(f.engine.inspectAgentBackendEffects(f.workspace.id), []);
});

test("unsupported remote write requests receive no local tool or filesystem effect", async (t) => {
  const f = await backendFixture(t, { mode: "unsupported" });
  f.register();
  const { done } = await f.submit();
  assert.equal((await done).state, "completed");
  assert.deepEqual(f.engine.store.getSnapshot(f.session.id).tools, []);
  assert.deepEqual(f.engine.inspectAgentBackendEffects(f.workspace.id), []);
  assert.equal(existsSync(join(f.root, "forbidden.txt")), false);
  assert.ok(
    f
      .logs()
      .find(
        (line) =>
          line.message?.id === "unsupported-write" && "error" in line.message!,
      ),
  );
});

test("reusing a remote RPC read identity cannot execute a second native read", async (t) => {
  const f = await backendFixture(t, { mode: "duplicate-read" });
  f.register();
  const { done } = await f.submit();
  assert.equal((await done).state, "failed");
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 1);
  assert.equal(f.engine.inspectAgentBackendEffects(f.workspace.id).length, 1);
  assert.equal(
    f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!.state,
    "uncertain",
  );
});

test("partial native read remains a native completed tool and returns only an explicit remote error", async (t) => {
  const f = await backendFixture(t, { mode: "partial" });
  f.register();
  const { done } = await f.submit();
  assert.equal((await done).state, "completed");
  const effect = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(effect.completion?.state, "completed");
  assert.equal(effect.completion?.content, null);
  assert.equal(effect.completion?.errorCode, "BACKEND_CLIENT_READ_PARTIAL");
  assert.ok(
    f
      .logs()
      .find(
        (line) =>
          line.message?.id === "native-read" && "error" in line.message!,
      ),
  );
  assert.equal(
    f
      .logs()
      .some(
        (line) =>
          line.message?.id === "native-read" && "result" in line.message!,
      ),
    false,
  );
});
