import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createPersistentFixture } from "./persistent-fixture.js";
import {
  assertPersistentRecoveryEvidence,
  persistentNativeDigest,
} from "./persistent-native.js";
import { newBase, POSIX_SUPPORTED, PROFILES } from "./fixture.js";
import { createEngine } from "../engine.js";
import { ScriptedProvider } from "../provider/scripted.js";
import {
  resolvePersistentSoakOptions,
  verifyEnginePersistentSoak,
} from "./persistent.js";

test("persistent load bounds reserve mandatory native cases and never turn a long profile into isolated iterations", () => {
  const quick = resolvePersistentSoakOptions(),
    long = resolvePersistentSoakOptions({ profile: "long" });
  assert.equal(quick.durationMs, 1000);
  assert.equal(quick.maxCycles, 6);
  assert.equal(long.durationMs, 1800000);
  assert.equal(long.maxCycles, 10000);
  assert.equal(
    resolvePersistentSoakOptions({ durationMs: 28800000 }).durationMs,
    28800000,
  );
  for (const input of [
    { durationMs: 28800001 },
    { durationMs: NaN },
    { maxCycles: 2 },
    { maxInputs: 15 },
    { maxSamples: 257 },
    { seed: -1 },
    { maxInputBytes: 1024 },
    { iterations: 60 },
  ])
    assert.throws(() => resolvePersistentSoakOptions(input));
});

test(
  "same worker builds real queue/steer history, retains cancelled native authority, then SIGKILL recovery retains exact unknown debt",
  { skip: !POSIX_SUPPORTED, timeout: 45000 },
  async () => {
    const report = await verifyEnginePersistentSoak({
      durationMs: 1500,
      maxCycles: 3,
      maxInputs: 16,
      maxSamples: 12,
      seed: 67,
    });
    assert.equal(
      report.passed,
      true,
      JSON.stringify({ failure: report.failure, cleanup: report.cleanup }),
    );
    assert.equal(report.load!.cycles, 3);
    assert.equal(report.load!.textCycles, 1);
    assert.equal(report.load!.inputs, 16);
    assert.equal(report.load!.inputBytes, 16384);
    assert.equal(report.load!.completedCommands, 1);
    assert.equal(report.load!.cancelledCommands, 1);
    assert.equal(report.load!.commands, 3);
    assert.ok(report.summary.activeDurationMs >= 1500);
    assert.equal(report.summary.engineInstances, 3);
    assert.deepEqual(
      report.gracefulCheckpoint!.before,
      report.gracefulCheckpoint!.after,
    );
    assert.equal(report.crashCheckpoint!.jobState, "uncertain");
    assert.equal(report.crashCheckpoint!.completion, null);
    assert.equal(report.crashCheckpoint!.recoveredProviderCalls, 0);
    assert.equal(report.crashCheckpoint!.processLaunches, 3);
    assert.equal(report.crashCheckpoint!.tokens, null);
    assert.equal(report.crashCheckpoint!.cost, null);
    assert.deepEqual(
      report.crashCheckpoint!.after,
      report.crashCheckpoint!.retained,
    );
    assert.ok(report.load!.cancellation);
    assert.notEqual(
      report.load!.cancellation!.workspaceId,
      report.load!.workspaceId,
    );
    assert.equal(report.load!.cancellation!.resumeOutcome, "cleanup-pending");
    assert.equal(
      report.cleanup.workerExited &&
        report.cleanup.recoveryEngineClosed &&
        report.cleanup.physicalCleanupConfirmed,
      true,
    );
    assert.equal(report.cleanup.nativeCleanupConfirmed, false);
    assert.equal(report.cleanup.databaseRemoved, false);
    assert.equal(report.cleanup.emergencyCleanupUsed, false);
    assert.equal(report.cleanup.ownedLiveSurvivors.length, 0);
    assert.equal(
      existsSync(join(report.cleanup.retainedEvidencePath, "engine.sqlite")),
      true,
    );
    assert.deepEqual(
      persistentNativeDigest(
        join(report.cleanup.retainedEvidencePath, "engine.sqlite"),
      ),
      report.crashCheckpoint!.retained,
    );
    const provider = new ScriptedProvider();
    const reopened = createEngine({
      dbPath: join(report.cleanup.retainedEvidencePath, "engine.sqlite"),
      artifactDir: join(report.cleanup.retainedEvidencePath, "artifacts"),
      providers: [provider],
      agentProfiles: PROFILES,
      jobs: true,
    });
    try {
      const nativeJob = reopened.getOwnedCommandJob(
        report.load!.workspaceId,
        report.crashCheckpoint!.originalJobId,
      )!;
      const originalEvents = report.crashCheckpoint!.recoveryEvents;
      assertPersistentRecoveryEvidence(
        reopened,
        nativeJob.source,
        report.crashCheckpoint!.originalProposalPartId,
        originalEvents,
        nativeJob.jobId,
      );
      for (const field of [
        "toolCallId",
        "attemptId",
        "proposalPartId",
        "callbackEntry",
      ]) {
        const forged = structuredClone(originalEvents);
        (forged[0]!.payload.frontier as Record<string, unknown>)[field] =
          "different-owner";
        assert.throws(() =>
          assertPersistentRecoveryEvidence(
            reopened,
            nativeJob.source,
            report.crashCheckpoint!.originalProposalPartId,
            forged,
            nativeJob.jobId,
          ),
        );
      }
      assert.equal(provider.callCount, 0);
    } finally {
      await reopened.close();
    }
    assert.deepEqual(
      persistentNativeDigest(
        join(report.cleanup.retainedEvidencePath, "engine.sqlite"),
      ),
      report.crashCheckpoint!.retained,
    );
    const workerSamples = report.samples.filter(
      (sample) =>
        sample.phase !== "recovery-host-before-close" &&
        sample.phase !== "recovery-host-after-close",
    );
    assert.equal(new Set(workerSamples.map((sample) => sample.pid)).size, 1);
    assert.ok(
      workerSamples.some((sample) => sample.engineInstance === 1) &&
        workerSamples.some((sample) => sample.engineInstance === 2),
    );
    assert.ok(
      report.samples.length <= 12 &&
        workerSamples.at(-1)!.sqlite.counts.session_inputs! >
          workerSamples[0]!.sqlite.counts.session_inputs!,
    );
    for (const sample of report.samples) {
      assert.ok(sample.memory.rss > 0 && sample.descriptors.count > 0);
      assert.ok(sample.sqlite.primaryBytes > 0);
    }
  },
);

test(
  "an input ceiling stops effects while the actual same Engine observation still lasts the requested duration",
  { skip: !POSIX_SUPPORTED, timeout: 45000 },
  async () => {
    const report = await verifyEnginePersistentSoak({
      profile: "long",
      durationMs: 1500,
      maxCycles: 100,
      maxInputs: 16,
      maxInputBytes: 16384,
      maxSamples: 12,
      seed: 71,
    });
    assert.equal(
      report.passed,
      true,
      JSON.stringify({ failure: report.failure, cleanup: report.cleanup }),
    );
    assert.equal(report.load!.cycles, 3);
    assert.equal(report.load!.inputs, 16);
    assert.ok(report.summary.activeDurationMs >= 1500);
    assert.ok(
      report.samples.filter((sample) => sample.phase === "timed").length >= 1,
    );
    assert.equal(report.crashCheckpoint!.recoveredProviderCalls, 0);
  },
);

test(
  "a real Engine close failure retains the actual committed native fixture rather than producing deletion or a green cleanup",
  { skip: !POSIX_SUPPORTED, timeout: 30000 },
  async () => {
    const base = newBase(),
      f = await createPersistentFixture(
        base,
        resolvePersistentSoakOptions({ maxCycles: 3 }),
      );
    const engine = f.engine(),
      close = engine.close.bind(engine);
    try {
      await f.cycle(0, "complete");
      const failure = new Error("Injected failure after actual Engine close");
      engine.close = async () => {
        await close();
        throw failure;
      };
      await assert.rejects(f.close(), (error) => error === failure);
      assert.equal(existsSync(f.dbPath), true);
      assert.equal(persistentNativeDigest(f.dbPath).counts.tools, 1);
    } finally {
      engine.close = close;
      await f.close();
      rmSync(base, { recursive: true, force: true });
    }
  },
);
