import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EngineError } from "@moodcode/contracts";
import { createEngine, type MoodcodeEngine } from "../engine.js";
import type { OwnedCommandJobRecord } from "../jobs/owned-command-records.js";
import {
  assertIdentityStable,
  digest,
  environment,
  sourceRuntimeIdentity,
} from "../evaluation/runtime.js";
import { groupExists } from "../tools/command/process-control.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
import {
  bounded,
  fixturePaths,
  hash,
  newBase,
  pidAbsent,
  POSIX_SUPPORTED,
  PROFILES,
  until,
} from "./fixture.js";
import {
  persistentProviders,
  type PersistentFixture,
} from "./persistent-fixture.js";
import {
  persistentNativeDigest,
  assertPersistentRecoveryEvidence,
  persistentRecoveryEvents,
  processRows,
  samplePersistentResources,
  type PersistentResourceSample,
} from "./persistent-native.js";
import {
  resolvePersistentSoakOptions,
  type PersistentSoakOptions,
} from "./persistent-options.js";
import { failureOf } from "./scenarios.js";
import type { runPersistentLoad } from "./persistent-worker.js";
export { resolvePersistentSoakOptions } from "./persistent-options.js";
export type { PersistentSoakOptions } from "./persistent-options.js";

interface Ready extends Awaited<ReturnType<PersistentFixture["crashReady"]>> {
  type: "crash-ready";
  summary: ReturnType<PersistentFixture["summary"]>;
  checkpoint: Awaited<ReturnType<PersistentFixture["checkpoint"]>>;
  samples: PersistentResourceSample[];
  activeDurationMs: number;
  observation: Awaited<ReturnType<typeof runPersistentLoad>>["observation"];
  lastCycleElapsedMs: number;
  loadStoppedBy: string;
  engineInstances: number;
}
export async function verifyEnginePersistentSoak(
  options: PersistentSoakOptions = {},
) {
  const resolved = resolvePersistentSoakOptions(options),
    started = performance.now();
  const base = newBase(),
    paths = fixturePaths(base),
    extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const source = await sourceRuntimeIdentity();
  const cliUrl = new URL(
    "../../../../scripts/verify-engine-persistent-soak.mjs",
    import.meta.url,
  );
  const cliSha256 = digest(readFileSync(cliUrl));
  const result = {
    schemaVersion: 1,
    kind: "engine-persistent-soak",
    timestamp: new Date().toISOString(),
    passed: false,
    supported: POSIX_SUPPORTED,
    noLive: true,
    ...resolved,
    runtime: environment(),
    source: {
      ...source,
      files: source.files.map((pin) => ({
        path: pin.path,
        bytes: pin.bytes,
        sha256: pin.sha256,
      })),
      cliSha256,
    },
    samples: [] as PersistentResourceSample[],
    load: null as null | Ready["summary"],
    gracefulCheckpoint: null as null | Ready["checkpoint"],
    crashCheckpoint: null as null | {
      originalJobId: string;
      originalProposalPartId: string;
      originalSourceSha256: string;
      originalApprovalId: string;
      originalApprovalFingerprint: string;
      before: Ready["before"];
      after: Ready["before"];
      retained: Ready["before"];
      jobState: string;
      completion: null;
      sourceRunState: string;
      providerCleanupState: string;
      providerCleanupConfirmed: boolean | null;
      pendingInputState: string;
      cancelledInputState: string;
      noAutomaticReplay: boolean;
      recoveredProviderCalls: number;
      processLaunches: number;
      tokens: null;
      cost: null;
      unknownTokenAttempts: number;
      recoveryEvents: ReturnType<typeof persistentRecoveryEvents>;
    },
    cleanup: {
      workerExited: false,
      recoveryEngineClosed: false,
      commandPidAbsent: false,
      commandGroupAbsent: false,
      ownedLiveSurvivors: [] as number[],
      physicalCleanupConfirmed: false,
      nativeCleanupConfirmed: null as boolean | null,
      emergencyCleanupUsed: false,
      databaseRemoved: false,
      retainedEvidencePath: base,
      retainedReason: "verification-failure",
    },
    summary: {
      activeDurationMs: 0,
      observation: null as null | Ready["observation"],
      lastCycleElapsedMs: 0,
      loadStoppedBy: null as null | string,
      durationMs: 0,
      engineInstances: 0,
      sourceStable: false,
      workerGrowth: null as null | {
        rssDeltaBytes: number;
        heapUsedDeltaBytes: number;
        descriptorDelta: number;
        descriptorPeak: number;
        liveDescendantPeak: number;
        sqliteDeltaBytes: number;
        artifactDeltaBytes: number;
        sampledWorkerDurationMs: number;
      },
    },
    failure: null as ReturnType<typeof failureOf>,
    limitations: [
      "Same Engine and session accumulate native history until an explicit graceful checkpoint; the second instance continues that history before the final process crash.",
      "POSIX owned run_command only; Windows JobObject, PTY, external providers and GUI have separate verification boundaries.",
      "Samples describe measured resource growth; no leak-rate or absolute performance SLA is inferred.",
      "After mandatory native cases settle, load is paced across a measured observation window of at least the requested duration; reaching an input ceiling stops new input while observation continues.",
      "Successful crash verification retains uncertain native SQLite/artifacts; physical process absence never grants recovery authority or automatic replay.",
    ],
  };
  if (!POSIX_SUPPORTED) {
    result.failure = failureOf(
      new Error("Persistent soak requires POSIX process evidence"),
    );
    return result;
  }
  let engine: MoodcodeEngine | undefined,
    ready: Ready | undefined,
    exited = false;
  let diagnostics = Buffer.alloc(0);
  const child = fork(
    fileURLToPath(new URL(`./persistent-worker.${extension}`, import.meta.url)),
    ["--persistent-soak-worker", base, JSON.stringify(resolved)],
    {
      silent: true,
      execArgv:
        extension === "ts"
          ? [
              "--import",
              fileURLToPath(
                new URL(
                  "../../../../node_modules/tsx/dist/loader.mjs",
                  import.meta.url,
                ),
              ),
            ]
          : [],
    },
  );
  const capture = (data: Buffer) => {
    diagnostics = Buffer.concat([diagnostics, data]).subarray(-32768);
  };
  child.stdout!.on("data", capture);
  child.stderr!.on("data", capture);
  const ended = new Promise<void>((yes, no) => {
    child.once("error", no);
    child.once("exit", () => {
      exited = true;
      yes();
    });
  });
  void ended.catch(() => {});
  let verified = false;
  try {
    ready = await bounded(
      new Promise<Ready>((yes, no) => {
        child.on("message", (message: unknown) => {
          const value = message as
            | Ready
            | { type: "progress"; sample: PersistentResourceSample }
            | {
                type: "failure";
                failure: ReturnType<typeof failureOf>;
                summary: Ready["summary"] | null;
              };
          if (value?.type === "progress") {
            if (result.samples.length >= resolved.maxSamples - 2) {
              no(new Error("Worker exceeded finite sample ceiling"));
              return;
            }
            result.samples.push(value.sample);
          } else if (value?.type === "failure") {
            result.load = value.summary;
            no(new Error(value.failure?.message ?? "Persistent worker failed"));
          } else if (value?.type === "crash-ready") yes(value);
        });
        child.once("error", no);
        child.once("exit", () =>
          no(
            new Error(
              `Persistent worker exited before crash checkpoint; diagnostic SHA ${hash([...diagnostics])}`,
            ),
          ),
        );
      }),
      resolved.durationMs + resolved.boundaryTimeoutMs * 12 + 30000,
      "persistent duration and crash checkpoint",
    );
    assert.ok(
      Number.isSafeInteger(ready.pid) &&
        ready.pid > 0 &&
        Number.isSafeInteger(ready.groupPid) &&
        ready.groupPid > 0,
    );
    assert.equal(ready.job.state, "running");
    assert.ok(groupExists(ready.groupPid) && !pidAbsent(ready.pid));
    assert.ok(ready.activeDurationMs >= resolved.durationMs);
    assert.ok(
      Object.values(ready.observation).every(Number.isFinite) &&
        ready.observation.startedElapsedMs >= 0 &&
        ready.observation.durationMs >= resolved.durationMs &&
        ready.observation.endedElapsedMs -
          ready.observation.startedElapsedMs ===
          ready.observation.durationMs &&
        ready.activeDurationMs === Math.round(ready.observation.endedElapsedMs),
      "Persistent observation window did not cover the requested duration",
    );
    assert.ok(
      ready.summary.cycles >= 3 && ready.summary.cycles <= resolved.maxCycles,
    );
    assert.ok(
      ready.summary.inputs <= resolved.maxInputs &&
        ready.summary.inputBytes <= resolved.maxInputBytes,
    );
    assert.ok(
      ready.summary.completedCommands >= 1 &&
        ready.summary.cancelledCommands >= 1 &&
        ready.summary.textCycles >= 1 &&
        ready.summary.commands <= 91,
    );
    result.load = ready.summary;
    result.gracefulCheckpoint = ready.checkpoint;
    result.summary.activeDurationMs = ready.activeDurationMs;
    result.summary.observation = ready.observation;
    result.summary.engineInstances = ready.engineInstances + 1;
    result.summary.lastCycleElapsedMs = ready.lastCycleElapsedMs;
    result.summary.loadStoppedBy = ready.loadStoppedBy;
    assert.deepEqual(result.samples, ready.samples);
    assert.equal(child.kill("SIGKILL"), true);
    await bounded(
      ended,
      resolved.boundaryTimeoutMs,
      "persistent worker actual SIGKILL",
    );
    await until(
      () => pidAbsent(ready!.pid) && !groupExists(ready!.groupPid),
      resolved.boundaryTimeoutMs,
      "persistent supervisor physical cleanup",
    );
    await until(
      () =>
        inspectExecutionLock(paths.dbPath + ".effects.sqlite").status ===
        "available",
      resolved.boundaryTimeoutMs,
      "persistent effect owner release",
    );
    const local = persistentProviders(ready.commandText);
    engine = createEngine({
      dbPath: paths.dbPath,
      artifactDir: paths.artifactDir,
      providers: local.providers,
      defaults: ready.config,
      agentProfiles: PROFILES,
      jobs: true,
    });
    const restored = engine.getOwnedCommandJob(
      ready.workspaceId,
      ready.job.jobId,
    )!;
    assert.ok(restored);
    assert.equal(restored.state, "uncertain");
    assert.equal(restored.completion, null);
    result.cleanup.nativeCleanupConfirmed = false;
    assert.equal(restored.source.sha256, ready.job.source.sha256);
    const after = persistentNativeDigest(paths.dbPath);
    const recoveryEvents = persistentRecoveryEvents(
      paths.dbPath,
      ready.before.counts.session_events!,
    );
    assert.deepEqual(
      recoveryEvents.map((event) => event.type),
      [
        "tool.recovery_frontier",
        "message.part.interrupted",
        "turn.uncertain",
        "session.paused",
        "session.document.updated",
      ],
    );
    for (const event of recoveryEvents)
      assert.equal(event.sessionId, ready.sessionId);
    for (const event of recoveryEvents.slice(0, 3))
      assert.equal(event.runId, ready.runId);
    assertPersistentRecoveryEvidence(
      engine,
      ready.job.source,
      ready.proposalPartId,
      recoveryEvents,
      ready.job.jobId,
    );
    assert.deepEqual(after.counts, {
      ...ready.before.counts,
      session_events: ready.before.counts.session_events! + 5,
    });
    assert.equal(engine.store.getRun(ready.runId).state === "completed", false);
    assert.equal(engine.store.getInput(ready.queuedInputId).state, "pending");
    assert.equal(
      engine.store.getInput(ready.cancelledInputId).state,
      "cancelled",
    );
    for (const job of ready.summary.jobs) {
      const restoredJob: OwnedCommandJobRecord = engine.getOwnedCommandJob(
        job.workspaceId,
        job.jobId,
      )!;
      assert.equal(restoredJob.sha256, job.sha256);
      assert.equal(restoredJob.state, job.state);
      assert.equal(restoredJob.source.sha256, job.sourceSha256);
    }
    assert.throws(
      () =>
        engine!.captureOwnedCommandJobOutput({
          workspaceId: ready!.workspaceId,
          jobId: ready!.job.jobId,
        }),
      (e) => e instanceof EngineError,
    );
    assert.throws(
      () => engine!.scheduler.resume(ready!.sessionId),
      (e) => e instanceof EngineError && e.code === "CLEANUP_PENDING",
    );
    const cancelled = ready.summary.cancellation!;
    assert.ok(cancelled);
    assert.equal(
      engine.store.getInput(cancelled.queuedInputId).state,
      "pending",
    );
    assert.equal(
      engine.store.getInput(cancelled.steerInputId).state,
      "pending",
    );
    assert.equal(
      engine.store.getInput(cancelled.cancelledInputId).state,
      "cancelled",
    );
    assert.throws(
      () => engine!.scheduler.resume(cancelled.sessionId),
      (e) => e instanceof EngineError && e.code === "CLEANUP_PENDING",
    );
    assert.equal(
      pidAbsent(cancelled.pid) && !groupExists(cancelled.groupPid),
      true,
    );
    await bounded(
      engine.scheduler.wake(ready.sessionId),
      resolved.boundaryTimeoutMs,
      "recovered paused soak wake",
    );
    assert.deepEqual(local.calls(), { command: 0, observer: 0 });
    assert.deepEqual(persistentNativeDigest(paths.dbPath), after);
    const launches = readFileSync(paths.launches, "utf8")
      .trim()
      .split("\n").length;
    assert.equal(launches, ready.summary.commands);
    assert.equal(
      readFileSync(paths.root + "/preserved.txt", "utf8"),
      `Persistent seed ${resolved.seed}\n`,
    );
    const metrics = engine.store.getNativeMetrics(ready.sessionId),
      cleanup = engine.getAttemptCleanup(
        ready.sessionId,
        restored.source.attemptId,
      );
    const sourceRunState = engine.store.getRun(ready.runId).state;
    assert.equal(metrics.attemptUsage.inputTokens.tokens, null);
    assert.equal(metrics.attemptUsage.outputTokens.tokens, null);
    assert.equal(metrics.attempts.retries, 0);
    result.samples.push(
      samplePersistentResources(
        paths.dbPath,
        paths.artifactDir,
        "recovery-host-before-close",
        performance.now() - started,
        result.summary.engineInstances,
        ready.summary.cycles,
      ),
    );
    await bounded(
      engine.close(),
      resolved.boundaryTimeoutMs,
      "recovery Engine close",
    );
    result.cleanup.recoveryEngineClosed = true;
    const retained = persistentNativeDigest(paths.dbPath);
    assert.deepEqual(retained, after);
    result.crashCheckpoint = {
      originalJobId: restored.jobId,
      originalProposalPartId: ready.proposalPartId,
      originalSourceSha256: restored.source.sha256,
      originalApprovalId: restored.source.approvalId,
      originalApprovalFingerprint: restored.source.approvalFingerprint,
      before: ready.before,
      after,
      retained,
      jobState: restored.state,
      completion: null,
      sourceRunState,
      providerCleanupState: cleanup.state,
      providerCleanupConfirmed: cleanup.cleanupConfirmed,
      pendingInputState: "pending",
      cancelledInputState: "cancelled",
      noAutomaticReplay: true,
      recoveredProviderCalls: 0,
      processLaunches: launches,
      tokens: null,
      cost: null,
      unknownTokenAttempts: metrics.attemptUsage.attemptsWithoutUsage,
      recoveryEvents,
    };
    assertIdentityStable(source, await sourceRuntimeIdentity());
    assert.equal(cliSha256, digest(readFileSync(cliUrl)));
    result.summary.sourceStable = true;
    result.cleanup.nativeCleanupConfirmed = false;
    result.cleanup.retainedReason =
      "expected-uncertain-command-no-recovery-acknowledgment";
    verified = true;
  } catch (error) {
    result.failure = failureOf(error);
  } finally {
    try {
      if (!exited) {
        child.kill("SIGKILL");
        await bounded(
          ended,
          resolved.boundaryTimeoutMs,
          "failed persistent worker termination",
        );
      }
      result.cleanup.workerExited = exited;
      if (engine && !result.cleanup.recoveryEngineClosed) {
        await bounded(
          engine.close(),
          resolved.boundaryTimeoutMs,
          "failed recovery Engine close",
        );
        result.cleanup.recoveryEngineClosed = true;
      }
      const inspection = existsSync(paths.dbPath + ".effects.sqlite")
        ? inspectExecutionLock(paths.dbPath + ".effects.sqlite")
        : null;
      const marker = inspection?.marker;
      const groupPid =
        ready?.groupPid ??
        (marker && marker.ownerPid === child.pid ? marker.groupPid : null);
      if (groupPid && groupExists(groupPid)) {
        throw new Error(
          "Historical command group still exists; retained evidence does not grant signal authority",
        );
      }
      if (ready) {
        result.cleanup.commandPidAbsent = pidAbsent(ready.pid);
        result.cleanup.commandGroupAbsent = !groupExists(ready.groupPid);
        const known = new Set(
          ready.samples.find((sample) => sample.phase === "crash-ready")
            ?.processes.pids ?? [],
        );
        result.cleanup.ownedLiveSurvivors = processRows()
          .filter((row) => known.has(row.pid) && !row.state.startsWith("Z"))
          .map((row) => row.pid);
        assert.equal(
          result.cleanup.commandPidAbsent && result.cleanup.commandGroupAbsent,
          true,
        );
        assert.equal(result.cleanup.ownedLiveSurvivors.length, 0);
        result.cleanup.physicalCleanupConfirmed = true;
        result.samples.push(
          samplePersistentResources(
            paths.dbPath,
            paths.artifactDir,
            "recovery-host-after-close",
            performance.now() - started,
            result.summary.engineInstances,
            ready.summary.cycles,
          ),
        );
      }
    } catch (error) {
      result.failure = failureOf(error);
      verified = false;
    }
    if (result.samples.length > resolved.maxSamples) {
      result.failure = failureOf(
        new Error("Persistent sample ceiling exceeded"),
      );
      verified = false;
    }
    const workerSamples = result.samples.filter(
      (sample) => sample.pid === child.pid,
    );
    if (workerSamples.length > 1) {
      const first = workerSamples[0]!,
        last = workerSamples.at(-1)!;
      const databaseBytes = (sample: PersistentResourceSample) =>
        sample.sqlite.primaryBytes +
        sample.sqlite.walBytes +
        sample.sqlite.shmBytes +
        sample.sqlite.effectsBytes;
      result.summary.workerGrowth = {
        rssDeltaBytes: last.memory.rss - first.memory.rss,
        heapUsedDeltaBytes: last.memory.heapUsed - first.memory.heapUsed,
        descriptorDelta: last.descriptors.count - first.descriptors.count,
        descriptorPeak: Math.max(
          ...workerSamples.map((sample) => sample.descriptors.count),
        ),
        liveDescendantPeak: Math.max(
          ...workerSamples.map((sample) => sample.processes.liveDescendants),
        ),
        sqliteDeltaBytes: databaseBytes(last) - databaseBytes(first),
        artifactDeltaBytes: last.artifacts.bytes - first.artifacts.bytes,
        sampledWorkerDurationMs: last.elapsedMs - first.elapsedMs,
      };
    }
    result.passed =
      verified &&
      result.cleanup.physicalCleanupConfirmed &&
      result.cleanup.recoveryEngineClosed;
    result.summary.durationMs = Math.round(performance.now() - started);
  }
  return result;
}
