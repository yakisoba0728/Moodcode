import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { jobInvoke } from "./job.js";
import {
  ownedDeliveryCounts,
  ownedDeliveryFixture,
} from "./owned-command-delivery.js";
import type { OwnedCommandDeliveryTargetProof } from "../owned-command-result.js";

const boundary = process.argv[2];
assert.ok(boundary === "before-commit" || boundary === "after-commit");
const cleanups: Array<() => void | Promise<void>> = [];
// This adapter records test cleanup only; all execution/approval/storage proofs are issued by the real Root.
const scope = {
  after(fn: () => void | Promise<void>) {
    cleanups.push(fn);
  },
} as unknown as TestContext;
const f = await ownedDeliveryFixture(scope);
try {
  const settled = await f.complete(),
    target = f.capture(),
    before = ownedDeliveryCounts(f.dbPath),
    requestId = randomUUID();
  const proof = jobInvoke<OwnedCommandDeliveryTargetProof>(
    f.engine,
    "readOwnedCommandJobDeliveryTarget",
    target,
  );
  const database = Reflect.get(f.engine.store, "db") as {
    readonly isTransaction: boolean;
  };
  let stopped = false;
  const stop = () => {
    assert.equal(stopped, false);
    stopped = true;
    assert.equal(database.isTransaction, boundary === "before-commit");
    assert.ok(process.send);
    process.send({
      type: "ready",
      boundary,
      transactionOpen: database.isTransaction,
      base: f.base,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      jobId: f.jobId,
      sourceRunId: f.receipt.runId,
      sourcePid: f.pid,
      settledSha256: settled.sha256,
      before,
      config: f.targetConfig,
      request: {
        workspaceId: f.workspace.id,
        jobId: f.jobId,
        requestId,
        expectedRevision: 0,
        targetSha256: proof.sha256,
      },
    });
    process.kill(process.pid, "SIGSTOP");
  };
  if (boundary === "before-commit") {
    const original = f.engine.store.acceptInput;
    Reflect.set(
      f.engine.store,
      "acceptInput",
      (...args: Parameters<typeof original>) => {
        const result = Reflect.apply(original, f.engine.store, args);
        if (args[0].requestId.startsWith("owned-command-result:")) stop();
        return result;
      },
    );
  } else {
    const original = f.engine.scheduler.wake;
    Reflect.set(
      f.engine.scheduler,
      "wake",
      (...args: Parameters<typeof original>) => {
        stop();
        return Reflect.apply(original, f.engine.scheduler, args);
      },
    );
  }
  f.deliver(target, requestId);
  assert.fail(
    "Actual owned result did not reach the selected transaction boundary",
  );
} finally {
  for (const cleanup of cleanups) await cleanup();
}
