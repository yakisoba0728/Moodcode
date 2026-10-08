import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EngineError, type RunConfig } from "@moodcode/contracts";
import { createEngine, type MoodcodeEngine } from "../engine.js";
import type { OwnedCommandJobRecord } from "../jobs/owned-command-records.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
import { cleanupGroup, groupExists } from "../tools/command/process-control.js";
import {
  bounded,
  fixturePaths,
  hash,
  localProviders,
  nativeSnapshot,
  pidAbsent,
  PROFILES,
  until,
} from "./fixture.js";
import {
  failureOf,
  jobSummary,
  resultBase,
  type IterationResult,
} from "./scenarios.js";

interface Ready {
  type: "ready";
  workspaceId: string;
  sessionId: string;
  runId: string;
  job: OwnedCommandJobRecord;
  pid: number;
  groupPid: number;
  config: RunConfig;
  commandText: string;
  queuedInputId: string;
  cancelledInputId: string;
  providerCalls: { command: number; observer: number };
  before: ReturnType<typeof nativeSnapshot>;
}
export async function runCrashScenario(
  base: string,
  iteration: number,
  seed: number,
  timeoutMs: number,
): Promise<IterationResult> {
  const result = resultBase(iteration, seed, "root-sigkill");
  const started = performance.now();
  const paths = fixturePaths(base);
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const child = fork(
    fileURLToPath(new URL(`./crash-worker.${extension}`, import.meta.url)),
    ["--resilience-crash-worker", base, String(seed), String(timeoutMs)],
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
  let ready: Ready | undefined,
    engine: MoodcodeEngine | undefined,
    exited = false;
  let diagnostics = Buffer.alloc(0);
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
  // Attach a rejection handler while waiting for the separately bounded readiness event.
  void ended.catch(() => {});
  let verified = false;
  try {
    ready = await bounded(
      new Promise<Ready>((yes, no) => {
        child.once("message", (message: unknown) => {
          if (!message || typeof message !== "object") {
            no(new Error("Invalid readiness message"));
            return;
          }
          const image = message as Ready;
          if (
            image.type !== "ready" ||
            !Number.isSafeInteger(image.pid) ||
            image.pid < 1 ||
            !Number.isSafeInteger(image.groupPid) ||
            image.groupPid < 1
          ) {
            no(new Error("Actual crash worker returned invalid readiness"));
            return;
          }
          yes(image);
        });
        child.once("exit", () =>
          no(
            new Error(
              `Worker exited before native readiness; diagnostic SHA ${hash([...diagnostics])}`,
            ),
          ),
        );
        child.once("error", no);
      }),
      timeoutMs,
      "SIGKILL worker native readiness",
    );
    assert.equal(ready.job.state, "running");
    result.providerCalls = { ...ready.providerCalls, reopened: 0 };
    result.processLaunches = 1;
    assert.equal(ready.providerCalls.command, 1);
    assert.equal(ready.providerCalls.observer, 0);
    assert.equal(groupExists(ready.groupPid), true);
    assert.equal(pidAbsent(ready.pid), false);
    const launches = () =>
      readFileSync(paths.launches, "utf8").trim().split("\n").length;
    assert.equal(launches(), 1);
    result.boundariesMs.admission = Math.round(performance.now() - started);
    assert.equal(child.kill("SIGKILL"), true);
    await bounded(ended, timeoutMs, "actual Root SIGKILL");
    // Physical cleanup is an observation; it does not become a native completion receipt.
    await until(
      () => pidAbsent(ready!.pid) && !groupExists(ready!.groupPid),
      timeoutMs,
      "actual supervisor cleanup after SIGKILL",
    );
    await until(
      () =>
        inspectExecutionLock(paths.dbPath + ".effects.sqlite").status ===
        "available",
      timeoutMs,
      "supervisor releases effect lock without marker reset",
    );
    result.boundariesMs.settlement = Math.round(performance.now() - started);
    const local = localProviders(ready.commandText);
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
    );
    assert.ok(restored);
    assert.equal(restored.state, "uncertain");
    assert.equal(restored.completion, null);
    assert.equal(restored.source.sha256, ready.job.source.sha256);
    assert.equal(engine.store.getRun(ready.runId).state === "completed", false);
    const afterReopen = nativeSnapshot(paths.dbPath);
    assert.deepEqual(afterReopen.counts, ready.before.counts);
    assert.equal(engine.store.getInput(ready.queuedInputId).state, "pending");
    assert.equal(
      engine.store.getInput(ready.cancelledInputId).state,
      "cancelled",
    );
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
    await bounded(
      engine.scheduler.wake(ready.sessionId),
      timeoutMs,
      "paused recovered session wake",
    );
    assert.deepEqual(local.calls(), { command: 0, observer: 0 });
    assert.deepEqual(nativeSnapshot(paths.dbPath).counts, afterReopen.counts);
    assert.equal(launches(), 1);
    const metrics = engine.store.getNativeMetrics(ready.sessionId);
    assert.equal(metrics.attemptUsage.inputTokens.tokens, null);
    assert.equal(metrics.attemptUsage.outputTokens.tokens, null);
    assert.equal(metrics.attempts.retries, 0);
    result.providerCalls = { ...ready.providerCalls, reopened: 0 };
    result.processLaunches = launches();
    result.noReplay = true;
    result.native = {
      beforeReopen: ready.before,
      afterReopen,
      job: jobSummary(restored),
      sourceRunState: engine.store.getRun(ready.runId).state,
      sourceConfigSha256: hash(engine.store.getRun(ready.runId).config),
      measuredUsage: null,
      unknownTokenAttempts: metrics.attemptUsage.attemptsWithoutUsage,
      tokens: null,
      cost: null,
      pendingInputState: "pending",
      cancelledInputState: "cancelled",
      resumeOutcome: "cleanup-pending",
    };
    verified = true;
  } catch (error) {
    result.failure = failureOf(error);
  } finally {
    try {
      if (!exited) {
        child.kill("SIGKILL");
        await bounded(ended, timeoutMs, "failed crash worker termination");
      }
      if (engine)
        await bounded(engine.close(), timeoutMs, "recovered Engine close");
      // On a failed readiness path, inspect only this private fixture's exact worker marker.
      const inspection = existsSync(paths.dbPath + ".effects.sqlite")
        ? inspectExecutionLock(paths.dbPath + ".effects.sqlite")
        : null;
      const marker = inspection?.marker;
      const group =
        ready?.groupPid ??
        (marker && marker.ownerPid === child.pid ? marker.groupPid : null);
      if (group && groupExists(group))
        assert.equal(await cleanupGroup(group), true);
      if (ready)
        assert.equal(
          pidAbsent(ready.pid) && !groupExists(ready.groupPid),
          true,
        );
      else if (
        inspection &&
        inspection.status !== "available" &&
        inspection.status !== "not_initialized"
      )
        throw new Error(
          "Failed crash setup lacks a confirmed physical cleanup scope",
        );
      result.cleanup.engineClosed = true;
      result.cleanup.physicalGroupAbsent = true;
      if (verified) {
        rmSync(base, { recursive: true, force: true });
        result.cleanup.databaseRemoved = true;
      }
    } catch (error) {
      result.failure = failureOf(error);
      verified = false;
    }
    if (!verified) result.cleanup.retainedEvidencePath = base;
    result.passed = verified;
    result.durationMs = Math.round(performance.now() - started);
  }
  return result;
}
