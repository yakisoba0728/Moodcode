import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, rmSync } from "node:fs";
import { verifyEngineResilience, resolveResilienceOptions } from "./index.js";
import { iterationSeed, scenarioAt } from "./options.js";
import { bounded, createFixture, newBase, POSIX_SUPPORTED } from "./fixture.js";

test("resilience plans never replace unknown outcome tests with short iterations", () => {
  assert.deepEqual(resolveResilienceOptions(), {
    profile: "quick",
    iterations: 3,
    seed: 20261009,
    boundaryTimeoutMs: 10000,
  });
  assert.equal(
    resolveResilienceOptions({ profile: "extended" }).iterations,
    12,
  );
  assert.throws(() => resolveResilienceOptions({ iterations: 2 }));
  assert.throws(() => resolveResilienceOptions({ iterations: 61 }));
  assert.deepEqual([0, 1, 2, 3].map(scenarioAt), [
    "complete",
    "cancel",
    "root-sigkill",
    "complete",
  ]);
  assert.equal(iterationSeed(0, 0), iterationSeed(0, 0));
  assert.notEqual(iterationSeed(0, 0), iterationSeed(0, 1));
});

test(
  "a real Engine close failure keeps the actual fixture DB instead of reporting cleanup success or deleting evidence",
  {
    skip: !POSIX_SUPPORTED,
    timeout: 30000,
  },
  async () => {
    const base = newBase();
    const f = await createFixture(base, 73, 10000);
    const close = f.engine.close.bind(f.engine);
    try {
      f.finish();
      await bounded(
        f.engine.scheduler.waitForSession(f.session.id),
        10000,
        "fault fixture settlement",
      );
      const failure = new Error("Injected failure after genuine Engine close");
      f.engine.close = async () => {
        await close();
        throw failure;
      };
      await assert.rejects(f.cleanup(true), (error) => error === failure);
      assert.equal(existsSync(f.dbPath), true);
    } finally {
      f.engine.close = close;
      await f.cleanup(false);
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  "actual native approval/queue/command/cancel/reopen/SIGKILL compound soak preserves cleanup and refuses replay",
  {
    skip: !POSIX_SUPPORTED,
    timeout: 90000,
  },
  async () => {
    const report = await verifyEngineResilience({ profile: "quick", seed: 47 });
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.results.length, 3);
    assert.equal(report.summary.processLaunches, 3);
    assert.equal(report.summary.cleanupFailures, 0);
    assert.equal(report.noLive, true);
    for (const result of report.results) {
      assert.equal(result.passed && result.noReplay, true);
      assert.equal(
        result.cleanup.engineClosed &&
          result.cleanup.physicalGroupAbsent &&
          result.cleanup.databaseRemoved,
        true,
      );
      assert.equal(result.cleanup.retainedEvidencePath, null);
      assert.equal(result.native!.tokens, null);
      assert.equal(result.native!.cost, null);
      assert.equal(result.native!.cancelledInputState, "cancelled");
      assert.equal(result.providerCalls.command <= 2, true);
      assert.equal(result.native!.beforeReopen.counts.tools, 1);
    }
    const killed = report.results[2]!;
    assert.equal(killed.native!.job.state, "uncertain");
    assert.equal(killed.native!.job.completionSha256, null);
    assert.equal(killed.native!.resumeOutcome, "cleanup-pending");
    assert.equal(killed.providerCalls.reopened, 0);
    assert.equal(
      existsSync(
        killed.cleanup.retainedEvidencePath ??
          "/__resilience_success_has_no_retained_path__",
      ),
      false,
    );
  },
);
