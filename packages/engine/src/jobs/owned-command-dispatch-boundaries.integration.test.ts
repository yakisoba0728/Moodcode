import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Run } from "@moodcode/contracts";
import { ownedDeliveryFixture } from "./fixtures/owned-command-delivery.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 25_000,
};

type Fixture = Awaited<ReturnType<typeof ownedDeliveryFixture>>;
function sourceHistory(f: Fixture) {
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    return {
      legacy: db
        .prepare("SELECT * FROM events WHERE run_id=? ORDER BY seq")
        .all(f.receipt.runId),
      native: db
        .prepare("SELECT * FROM session_events WHERE run_id=? ORDER BY seq")
        .all(f.receipt.runId),
    };
  } finally {
    db.close();
  }
}

const changes: {
  name: string;
  candidate(run: Run, f: Fixture): Run;
}[] = [
  {
    name: "full configuration",
    candidate: (run) => ({
      ...run,
      config: {
        ...run.config,
        mode: run.config.mode === "build" ? "plan" : "build",
      },
    }),
  },
  {
    name: "result prompt",
    candidate: (run) => ({ ...run, prompt: "Changed at actual dispatch" }),
  },
  {
    name: "source Run identity",
    candidate: (run, f) => ({ ...run, id: f.receipt.runId }),
  },
];

for (const change of changes) {
  test(
    `actual owned-result dispatch rejects changed ${change.name} before a third provider entry`,
    posix,
    async (t) => {
      const f = await ownedDeliveryFixture(t),
        settled = await f.complete(),
        delivery = f.deliver(f.capture()).record,
        accepted = f.engine.store.getInput(delivery.accepted.inputId),
        source = sourceHistory(f);
      assert.equal(accepted.state, "pending");
      assert.equal(f.providerEntries(), 2);
      assert.equal(settled.completion?.outcome.cleanupConfirmed, true);
      assert.throws(
        () => process.kill(f.pid, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );

      // Alter only the argument to the genuine trusted boundary after real promotion.
      // The persisted Run and its original admission are never modified or invented.
      const options = Reflect.get(f.engine.coordinator, "options") as {
          beforeProviderDispatch?: (run: Run) => void;
        },
        original = options.beforeProviderDispatch;
      assert.equal(typeof original, "function");
      let boundaryCalls = 0,
        genuineRunId: string | undefined;
      options.beforeProviderDispatch = (run) => {
        if (run.inputId !== accepted.id) return original!(run);
        boundaryCalls++;
        genuineRunId = run.id;
        const promoted = f.engine.store.getInput(accepted.id);
        assert.equal(promoted.state, "promoted");
        assert.equal(promoted.runId, run.id);
        assert.notEqual(run.id, f.receipt.runId);
        original!(change.candidate(run, f));
      };
      t.after(() => {
        options.beforeProviderDispatch = original;
      });

      f.engine.scheduler.resume(f.session.id);
      await f.engine.waitForSession(f.session.id);
      assert.equal(boundaryCalls, 1);
      assert.ok(genuineRunId);
      const consumed = f.engine.store.getRun(genuineRunId);
      assert.equal(consumed.state, "failed");
      assert.equal(consumed.error?.code, "COMMAND_JOB_INPUT_INVALID");
      assert.equal(consumed.inputId, accepted.id);
      assert.equal(consumed.prompt, accepted.prompt);
      assert.deepEqual(consumed.config, accepted.config);
      assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 2);
      assert.equal(f.providerEntries(), 2);
      assert.deepEqual(sourceHistory(f), source);
      assert.equal(f.settled().sha256, settled.sha256);
      assert.equal(f.engine.store.getRun(f.receipt.runId).state, "completed");
      const persisted = f.engine.store.getInput(accepted.id);
      assert.equal(persisted.state, "promoted");
      assert.equal(persisted.runId, consumed.id);
      assert.equal(persisted.prompt, accepted.prompt);
      assert.deepEqual(persisted.config, accepted.config);
    },
  );
}
