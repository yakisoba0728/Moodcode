import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEngine } from "../../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import type { DiagnosticExecutionObservation } from "../execution-observation-types.js";
import { DiagnosticExecutionObservationStorage } from "../execution-observation-store.js";
import { inspectExecutionLock } from "../../tools/command/execution-lock.js";
import {
  CHANGED,
  ORIGINAL,
  digest,
  dispatch,
  stop,
  until,
} from "./execution-observation.js";

const [dbPath, artifactDir, workspaceId, sessionId, readyPath, boundary] =
  process.argv.slice(2);
if (
  !dbPath ||
  !artifactDir ||
  !workspaceId ||
  !sessionId ||
  !readyPath ||
  !["dispatched", "produced"].includes(boundary ?? "")
)
  throw new Error("Exact actual observation crash fixture arguments required");
const provider: ProviderAdapter = {
  id: "actual-execution-observation",
  async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    if (request.turnIndex === 0) {
      yield {
        type: "tool.call",
        call: {
          id: "crash-original-patch",
          name: "apply_patch",
          input: {
            changes: [
              {
                path: "source.ts",
                expectedHash: digest(ORIGINAL),
                content: CHANGED,
              },
            ],
          },
        },
      };
      yield { type: "finish", reason: "tool_calls" };
    } else yield stop;
  },
};
const engine = createEngine({
  dbPath,
  artifactDir,
  providers: [provider],
  diagnosticObservations: true,
  defaults: {
    providerId: provider.id,
    modelId: "fixture",
    mode: "build",
    limits: { maxTurns: 3, maxDurationMs: 12000 },
  },
});
const db = Reflect.get(engine.store, "db");
assert.ok(db instanceof DatabaseSync);
const originalExec = db.exec;
const originalSettle = DiagnosticExecutionObservationStorage.prototype.settle;
if (boundary === "produced")
  DiagnosticExecutionObservationStorage.prototype.settle = function (capture) {
    const row = db
      .prepare("SELECT data FROM diagnostic_execution_observations WHERE id=?")
      .get(capture.observationId);
    assert.ok(row);
    const actual = JSON.parse(
      String(row.data),
    ) as DiagnosticExecutionObservation;
    assert.equal(actual.state, "dispatched");
    assert.equal(
      engine.store.getToolCall(actual.toolCallId).state,
      "completed",
    );
    const workspace = engine.store.getWorkspace(workspaceId);
    assert.equal(
      readFileSync(join(workspace.root, "source.ts"), "utf8"),
      CHANGED,
    );
    assert.equal(
      engine.store
        .listCheckpoints(actual.runId)
        .filter((value) => value.toolCallId === actual.toolCallId).length,
      1,
    );
    const lockPath = Reflect.get(engine, "executionLockPath");
    assert.equal(typeof lockPath, "string");
    assert.equal(inspectExecutionLock(lockPath as string).status, "available");
    assert.equal(actual.effectEpochDispatch, actual.effectEpochBefore + 1);
    writeFileSync(
      `${readyPath}.temporary`,
      JSON.stringify({
        boundary,
        observationId: actual.id,
        runId: actual.runId,
        toolCallId: actual.toolCallId,
        epoch: actual.effectEpochDispatch,
      }),
    );
    renameSync(`${readyPath}.temporary`, readyPath);
    process.kill(process.pid, "SIGKILL");
    return originalSettle.call(this, capture);
  };
db.exec = (sql) => {
  originalExec.call(db, sql);
  if (boundary !== "dispatched" || sql.trim().toUpperCase() !== "COMMIT")
    return;
  const row = db
    .prepare(
      "SELECT data FROM diagnostic_execution_observations WHERE workspace_id=? AND state=? ORDER BY ordinal DESC LIMIT 1",
    )
    .get(workspaceId, "dispatched");
  if (!row) return;
  const actual = JSON.parse(String(row.data)) as DiagnosticExecutionObservation;
  if (actual.toolName !== "apply_patch") return;
  const checkpoint = engine.store
    .listCheckpoints(actual.runId)
    .find((value) => value.toolCallId === actual.toolCallId);
  if (checkpoint) return;
  const workspace = engine.store.getWorkspace(workspaceId);
  assert.equal(
    readFileSync(join(workspace.root, "source.ts"), "utf8"),
    ORIGINAL,
  );
  assert.equal(actual.effectEpochDispatch, actual.effectEpochBefore + 1);
  assert.equal(actual.state, "dispatched");
  assert.equal(engine.store.getToolCall(actual.toolCallId).state, "running");
  const descriptor = {
    boundary,
    observationId: actual.id,
    runId: actual.runId,
    toolCallId: actual.toolCallId,
    epoch: actual.effectEpochDispatch,
  };
  writeFileSync(`${readyPath}.temporary`, JSON.stringify(descriptor));
  renameSync(`${readyPath}.temporary`, readyPath);
  process.kill(process.pid, "SIGKILL");
};
try {
  const submitted = await dispatch<{ runId: string }>(engine, "run.submit", {
    sessionId,
    requestId: "actual-observation-crash-request",
    prompt: "Original native crash boundary",
    config: {},
  });
  await until(
    () => engine.store.listPendingRunApprovals(submitted.runId).length === 1,
  );
  const approval = engine.store.listPendingRunApprovals(submitted.runId)[0]!;
  await dispatch(engine, "approval.decide", {
    approvalId: approval.id,
    fingerprint: approval.fingerprint,
    decision: "allow",
  });
  await engine.waitForRun(submitted.runId);
  throw new Error("Actual SQL/physical crash boundary was not observed");
} finally {
  db.exec = originalExec;
  DiagnosticExecutionObservationStorage.prototype.settle = originalSettle;
  await engine.close();
}
