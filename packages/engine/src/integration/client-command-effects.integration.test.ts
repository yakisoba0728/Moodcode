import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  batchFixture,
  patch,
  until,
} from "../effect-batches/fixtures/batch.js";
import { teamFixture } from "../teams/fixtures/engine-team.js";

test("resource batch opt-in preserves native profile denial and provider continuation", async (t) => {
  for (const enabled of [false, true]) {
    const f = await batchFixture(t, {
      enabled,
      profileTools: ["read_file"],
      calls: [patch("outside-profile", "a.txt", "a", "A")],
    });
    const receipt = await f.submit();
    const run = await f.engine.coordinator.waitForRun(receipt.runId);
    const native = f.engine.store.getSnapshot(f.session.id);
    assert.equal(run.state, "completed");
    assert.equal(native.tools.length, 1);
    assert.equal(native.tools[0]!.state, "denied");
    assert.equal(native.approvals.length, 0);
    assert.equal(f.entries(), 2);
    assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "a");
  }
});

test(
  "Root client effects, lifetime and batches preserve ordinary readonly child admission",
  { timeout: 30000 },
  async (t) => {
    const f = await teamFixture(t, {
      engine: {
        jobs: true,
        hostCommands: true,
        commandLifetimes: true,
        agentBackends: true,
        agentBackendClientEffects: true,
        effectBatches: true,
      },
    });
    await f.startParent();
    const starting = f.startChild();
    void starting.catch(() => {});
    await until(
      () =>
        f.engine.children.tasks
          .list(f.session.id)
          .some((x) => ["running", "failed", "uncertain"].includes(x.state)),
      "Actual child admission or failure must be observable",
    );
    const actual = f.engine.children.tasks.list(f.session.id)[0]!;
    assert.equal(actual.state, "running", JSON.stringify(actual));
    const child = await starting;
    f.childRelease.resolve();
    const task = await f.engine.children.tasks.wait(
      f.session.id,
      child.task.id,
    );
    assert.equal(task.state, "completed");
    assert.ok(task.childRunId);
    assert.ok(f.requests.length > 1);
    assert.equal(child.child.commandLifetimeCapability().available, false);
    assert.equal(
      child.child
        .getCapabilities()
        .tools.some((x) => x.name === "run_command_job"),
      false,
    );
    f.parentRelease.resolve();
  },
);
