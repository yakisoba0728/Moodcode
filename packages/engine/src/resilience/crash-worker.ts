import assert from "node:assert/strict";
import { createFixture, nativeSnapshot } from "./fixture.js";

// Launched only by the resilience parent in its owned, already-created tmp dir.
if (process.argv[2] === "--resilience-crash-worker") {
  const [base, seed, timeout] = process.argv.slice(3);
  assert.ok(base && seed && timeout && process.send);
  const f = await createFixture(base, Number(seed), Number(timeout));
  process.once("disconnect", () => {
    void f.cleanup(false).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  process.send({
    type: "ready",
    workspaceId: f.workspace.id,
    sessionId: f.session.id,
    runId: f.runId,
    job: f.job,
    pid: f.actualPid,
    groupPid: f.actualGroupPid,
    config: f.config,
    commandText: f.commandText,
    queuedInputId: f.queued.inputId,
    cancelledInputId: f.cancelled.inputId,
    providerCalls: f.local.calls(),
    before: nativeSnapshot(f.dbPath),
  });
  // No timeout-only readiness, mocked ToolContext or fabricated native completion.
  await new Promise<never>(() => {});
}
