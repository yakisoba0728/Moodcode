import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { forkFixture, forkCounts } from "./fork.js";
const boundary = process.argv[2];
assert.ok(boundary === "before-commit" || boundary === "after-commit");
const cleanups: (() => void | Promise<void>)[] = [];
const f = await forkFixture({
  after: (fn: () => void | Promise<void>) => cleanups.push(fn),
} as unknown as TestContext);
try {
  const original = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "crash-fork",
    }),
    preview = f.engine.readForkPreview(original),
    counts = forkCounts(f.dbPath),
    requestId = "crash-fork-request",
    db = Reflect.get(f.engine.store, "db") as { isTransaction: boolean };
  const stop = () => {
    assert.equal(db.isTransaction, boundary === "before-commit");
    process.send!({
      type: "ready",
      boundary,
      transactionOpen: db.isTransaction,
      base: f.base,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      workspaceId: f.workspace.id,
      sourceSessionId: f.session.id,
      targetSessionId: preview.targetSessionId,
      sourceRunId: f.first!.runId,
      counts,
      config: f.config,
      requestId,
      approvalFingerprint: preview.sha256,
    });
    process.kill(process.pid, "SIGSTOP");
  };
  if (boundary === "before-commit") {
    const accept = f.engine.store.acceptInput.bind(f.engine.store);
    f.engine.store.acceptInput = (input) => {
      const receipt = accept(input);
      if (input.requestId.startsWith("fork:")) stop();
      return receipt;
    };
  } else {
    const wake = f.engine.scheduler.wake.bind(f.engine.scheduler);
    f.engine.scheduler.wake = (sessionId) => {
      if (sessionId === preview.targetSessionId) stop();
      return wake(sessionId);
    };
  }
  f.engine.forkConversationView({
    preview: original,
    requestId,
    approved: true,
    approvalFingerprint: preview.sha256,
  });
  assert.fail("Actual fork did not reach crash boundary");
} catch (error) {
  process.send?.({
    type: "error",
    message: error instanceof Error ? error.stack : String(error),
  });
  for (const cleanup of cleanups) await cleanup();
  process.exitCode = 1;
}
