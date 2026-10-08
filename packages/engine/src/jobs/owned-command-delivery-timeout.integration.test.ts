import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { jobCommand, jobInvoke } from "./fixtures/job.js";
import {
  ownedDeliveryCounts,
  ownedDeliveryFixture,
} from "./fixtures/owned-command-delivery.js";
import {
  formatOwnedCommandJobResult,
  type OwnedCommandDeliveryTargetProof,
} from "./owned-command-result.js";

test(
  "an actual timed-out owned command delivers its known cancelled outcome without changing the terminal source Run or execution budgets",
  {
    skip: !["darwin", "linux", "freebsd"].includes(process.platform),
    timeout: 20_000,
  },
  async (t) => {
    const f = await ownedDeliveryFixture(t, { timeoutMs: 500 });
    // Do not release the held Node command: the actual internal command timeout owns termination.
    const run = await f.engine.waitForRun(f.receipt.runId),
      settled = f.settled();
    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "TOOL_TIMEOUT");
    assert.equal(settled.state, "cancelled");
    assert.ok(settled.completion);
    assert.equal(settled.completion.outcome.timedOut, true);
    assert.equal(settled.completion.outcome.cleanupConfirmed, true);
    assert.equal(
      Object.hasOwn(settled.completion, "observationFailure"),
      false,
    );
    assert.throws(
      () => process.kill(f.pid, 0),
      (failure) => (failure as NodeJS.ErrnoException).code === "ESRCH",
    );
    const tool = f.engine.store.getToolCall(settled.source.toolCallId);
    assert.equal(tool.state, "failed");
    const part = f.engine.store
      .listParts(settled.source.turnId)
      .find(
        (p) => p.type === "tool" && p.toolCallId === settled.source.toolCallId,
      );
    assert.equal(part?.state, "failed");
    await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
    const sourceEvents = () => {
      const db = new DatabaseSync(f.dbPath, { readOnly: true });
      try {
        return db
          .prepare("SELECT * FROM session_events WHERE run_id=? ORDER BY seq")
          .all(run.id);
      } finally {
        db.close();
      }
    };
    const originalEvents = sourceEvents(),
      before = ownedDeliveryCounts(f.dbPath),
      target = f.capture();
    const proof = jobInvoke<OwnedCommandDeliveryTargetProof>(
      f.engine,
      "readOwnedCommandJobDeliveryTarget",
      target,
    );
    assert.equal(proof.settled.sha256, settled.sha256);
    assert.equal(proof.target.profile?.id, f.targetConfig.agentProfileId);
    assert.deepEqual(
      structuredClone(proof.target.config.budgets),
      f.targetConfig.budgets,
    );
    assert.deepEqual(
      structuredClone(proof.target.config.limits),
      f.targetConfig.limits,
    );
    const delivered = f.deliver(target);
    assert.equal(delivered.kind, "accepted");
    assert.equal(
      delivered.record.prompt,
      formatOwnedCommandJobResult(settled, proof),
    );
    const data = JSON.parse(
      delivered.record.prompt.split("\n").slice(1).join("\n"),
    ) as {
      state: string;
      outcome: { timedOut: boolean; cleanupConfirmed: boolean };
    };
    assert.equal(data.state, "cancelled");
    assert.equal(data.outcome.timedOut, true);
    assert.equal(data.outcome.cleanupConfirmed, true);
    assert.equal(
      f.engine.store.getInput(delivered.record.accepted.inputId).state,
      "pending",
    );
    assert.equal(ownedDeliveryCounts(f.dbPath).inputs, before.inputs + 1);
    assert.equal(ownedDeliveryCounts(f.dbPath).turns, before.turns);
    assert.deepEqual(sourceEvents(), originalEvents);
    assert.deepEqual(f.engine.store.getRun(run.id), run);
    assert.equal(f.providerEntries(), 1);
  },
);
