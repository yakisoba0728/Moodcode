import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { groupExists } from "../tools/command/process-control.js";
import {
  EngineError,
  type InputReceipt,
  type JsonObject,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { OwnedCommandJobRecord } from "../jobs/owned-command-records.js";
import {
  bounded,
  command,
  createFixture,
  FixtureAdmissionFailure,
  hash,
  localProviders,
  nativeSnapshot,
  pidAbsent,
  PROFILES,
  until,
  type ResilienceFixture,
} from "./fixture.js";
import type { ResilienceScenario } from "./options.js";

export interface IterationResult {
  iteration: number;
  seed: number;
  scenario: ResilienceScenario;
  passed: boolean;
  durationMs: number;
  boundariesMs: Record<string, number>;
  providerCalls: { command: number; observer: number; reopened: number };
  processLaunches: number;
  noReplay: boolean;
  cleanup: {
    engineClosed: boolean;
    physicalGroupAbsent: boolean;
    databaseRemoved: boolean;
    retainedEvidencePath: string | null;
  };
  native: null | {
    beforeReopen: ReturnType<typeof nativeSnapshot>;
    afterReopen: ReturnType<typeof nativeSnapshot>;
    job: {
      jobId: string;
      state: string;
      sha256: string;
      completionSha256: string | null;
    };
    sourceRunState: string;
    sourceConfigSha256: string;
    measuredUsage: {
      turns: number;
      toolCalls: number;
      outputBytes: number;
    } | null;
    unknownTokenAttempts: number;
    tokens: null;
    cost: null;
    pendingInputState: string;
    cancelledInputState: string;
    resumeOutcome: "resumed" | "cleanup-pending";
  };
  failure: null | { name: string; code: string | null; message: string };
}
export function resultBase(
  iteration: number,
  seed: number,
  scenario: ResilienceScenario,
): IterationResult {
  return {
    iteration,
    seed,
    scenario,
    passed: false,
    durationMs: 0,
    boundariesMs: {},
    providerCalls: { command: 0, observer: 0, reopened: 0 },
    processLaunches: 0,
    noReplay: false,
    cleanup: {
      engineClosed: false,
      physicalGroupAbsent: false,
      databaseRemoved: false,
      retainedEvidencePath: null,
    },
    native: null,
    failure: null,
  };
}
export function failureOf(error: unknown): IterationResult["failure"] {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    code: error instanceof EngineError ? error.code : null,
    message: (error instanceof Error
      ? error.message
      : "Resilience check failed"
    ).slice(0, 512),
  };
}
export function jobSummary(job: OwnedCommandJobRecord) {
  return {
    jobId: job.jobId,
    state: job.state,
    sha256: job.sha256,
    completionSha256: job.completion ? hash(job.completion) : null,
  };
}
export async function runLocalScenario(
  base: string,
  iteration: number,
  seed: number,
  scenario: "complete" | "cancel",
  timeoutMs: number,
): Promise<IterationResult> {
  const result = resultBase(iteration, seed, scenario);
  const started = performance.now();
  let fixture: ResilienceFixture | undefined;
  let verified = false;
  let admissionCleanupConfirmed = false;
  try {
    fixture = await createFixture(base, seed, timeoutMs);
    result.boundariesMs.admission = Math.round(performance.now() - started);
    const f = fixture;
    result.providerCalls = { ...f.local.calls(), reopened: 0 };
    result.processLaunches = f.launchCount();
    const sourceConfigSha256 = hash(f.engine.store.getRun(f.runId).config);
    assert.equal(f.launchCount(), 1);
    if (scenario === "complete") {
      f.finish();
      assert.equal(
        (
          await bounded(
            f.engine.waitForRun(f.runId),
            timeoutMs,
            "source completion",
          )
        ).state,
        "completed",
      );
      await bounded(
        f.engine.scheduler.waitForSession(f.session.id),
        timeoutMs,
        "queued observer settles",
      );
      const queued = f.engine.store.getInput(f.queued.inputId);
      assert.equal(queued.state, "promoted");
      assert.ok(queued.runId && queued.runId !== f.runId);
      assert.equal(f.engine.store.getRun(queued.runId).state, "completed");
      assert.equal(f.local.calls().observer, 1);
    } else {
      await bounded(
        f.engine.cancelOwnedCommandJob({
          workspaceId: f.workspace.id,
          jobId: f.job.jobId,
          requestId: "resilience-active-cancel",
          expectedRevision: f.job.revision,
        }),
        timeoutMs,
        "actual running cancellation",
      );
      assert.equal(
        (
          await bounded(
            f.engine.waitForRun(f.runId),
            timeoutMs,
            "source cancellation settlement",
          )
        ).state,
        "cancelled",
      );
      assert.equal(f.engine.store.getInput(f.queued.inputId).state, "pending");
      assert.equal(f.local.calls().observer, 0);
      assert.equal(f.engine.store.getSessionControl(f.session.id).paused, true);
    }
    await until(
      () => pidAbsent(f.actualPid) && !groupExists(f.actualGroupPid),
      timeoutMs,
      "actual command cleanup",
    );
    const job = f.engine.getOwnedCommandJob(f.workspace.id, f.job.jobId);
    assert.ok(job, "Native owned command history must exist");
    const tool = f.engine.store.getToolCall(job.source.toolCallId);
    const part = f.engine.store
      .listParts(job.source.turnId)
      .find((p) => p.type === "tool" && p.toolCallId === tool.id);
    assert.ok(part && part.type === "tool");
    assert.equal(part.runId, f.runId);
    assert.equal(part.providerCallId, "resilience-owned-command");
    const originalCleanup = f.engine.getAttemptCleanup(
      f.session.id,
      job.source.attemptId,
    );
    assert.equal(originalCleanup.cleanupConfirmed, true);
    assert.equal(originalCleanup.runId, f.runId);
    assert.equal(originalCleanup.turnId, job.source.turnId);
    if (scenario === "complete") {
      assert.equal(job.state, "completed");
      assert.equal(tool.state, "completed");
      assert.equal(part.state, "completed");
      assert.equal(job.completion!.outcome.cleanupConfirmed, true);
      assert.equal(job.completion!.outcome.started, true);
      assert.equal(job.completion!.outcome.exitCode, 0);
      assert.equal(job.completion!.checkpoint.toolCallId, tool.id);
      assert.equal(job.completion!.checkpoint.runId, f.runId);
      assert.ok(
        job.completion!.stdout.artifactBytes <=
          f.config.budgets!.maxArtifactBytes,
      );
      assert.ok(
        job.completion!.stdout.observedBytes <=
          f.config.budgets!.maxProducerBytes,
      );
      assert.equal(
        createHash("sha256")
          .update(readFileSync(job.completion!.stdout.path))
          .digest("hex"),
        job.completion!.stdout.sha256,
      );
    } else {
      assert.ok(["cancelled", "uncertain"].includes(job.state));
      if (job.state === "cancelled") {
        assert.equal(job.completion!.outcome.cleanupConfirmed, true);
        assert.equal(job.completion!.outcome.cancelled, true);
      }
      assert.equal(part.state === "completed", false);
    }
    assert.equal(
      hash(f.engine.store.getRun(f.runId).config),
      sourceConfigSha256,
    );
    const measuredUsage = f.engine.coordinator.getRunUsage(f.runId);
    assert.ok(measuredUsage.turns <= f.config.limits.maxTurns);
    assert.equal(measuredUsage.toolCalls, 1);
    assert.ok(measuredUsage.outputBytes <= f.config.limits.maxOutputBytes);
    const metrics = f.engine.store.getNativeMetrics(f.session.id);
    assert.equal(metrics.attemptUsage.attemptsWithUsage, 0);
    assert.equal(metrics.attemptUsage.inputTokens.tokens, null);
    assert.equal(metrics.attemptUsage.outputTokens.tokens, null);
    assert.ok(metrics.attemptUsage.attemptsWithoutUsage >= 1);
    assert.equal(metrics.attempts.retries, 0);
    for (const turn of f.engine.store.listTurns(f.runId)) {
      assert.equal(turn.inputIds.includes(f.accepted.inputId), true);
    }
    assert.equal(f.engine.store.getInput(f.cancelled.inputId).runId, undefined);
    // No producer side effect may occur on a durable duplicate, including after completion.
    const originalCounts = nativeSnapshot(f.dbPath).counts;
    const duplicate = await command<InputReceipt>(
      f.engine,
      "input.accept",
      f.queuedInput as unknown as JsonObject,
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.inputId, f.queued.inputId);
    assert.deepEqual(nativeSnapshot(f.dbPath).counts, originalCounts);
    await command(f.engine, "session.pause", { sessionId: f.session.id });
    result.providerCalls = { ...f.local.calls(), reopened: 0 };
    result.processLaunches = f.launchCount();
    result.boundariesMs.settlement = Math.round(performance.now() - started);
    await bounded(f.engine.close(), timeoutMs, "first Engine close");
    const beforeReopen = nativeSnapshot(f.dbPath);
    const reopenedProviders = localProviders(f.commandText);
    const reopened = createEngine({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      providers: reopenedProviders.providers,
      defaults: f.config,
      agentProfiles: PROFILES,
      // Jobs stays default-off; readonly native history still must validate.
    });
    f.engines.add(reopened);
    const restored = reopened.getOwnedCommandJob(f.workspace.id, job.jobId);
    assert.ok(restored);
    assert.equal(restored.source.sha256, job.source.sha256);
    assert.equal(restored.state, job.state);
    const afterReopen = nativeSnapshot(f.dbPath);
    if (scenario === "complete")
      assert.equal(
        afterReopen.recordsSha256,
        beforeReopen.recordsSha256,
        "Healthy terminal native history cannot change merely on reopen",
      );
    let resumeOutcome: "resumed" | "cleanup-pending" = "resumed";
    if (restored.state === "uncertain") {
      assert.throws(
        () => reopened.scheduler.resume(f.session.id),
        (e) => e instanceof EngineError && e.code === "CLEANUP_PENDING",
      );
      resumeOutcome = "cleanup-pending";
    } else {
      reopened.scheduler.resume(f.session.id);
      await bounded(
        reopened.scheduler.waitForSession(f.session.id),
        timeoutMs,
        "explicit resumed queue",
      );
    }
    const calls = reopenedProviders.calls();
    // In the known-cancelled alternative only the original queued observer can run;
    // unknown cancellation never grants replay or clears quarantine.
    assert.equal(calls.command, 0);
    assert.equal(
      calls.observer,
      scenario === "cancel" && resumeOutcome === "resumed" ? 1 : 0,
    );
    result.providerCalls.reopened = calls.command + calls.observer;
    assert.equal(f.launchCount(), 1);
    assert.equal(
      readFileSync(f.root + "/preserved.txt", "utf8"),
      `Seed ${seed}\n`,
    );
    if (calls.observer === 0)
      assert.deepEqual(nativeSnapshot(f.dbPath).counts, afterReopen.counts);
    assert.equal(
      reopened.store.getInput(f.cancelled.inputId).state,
      "cancelled",
    );
    result.native = {
      beforeReopen,
      afterReopen,
      job: jobSummary(restored),
      sourceRunState: reopened.store.getRun(f.runId).state,
      sourceConfigSha256,
      measuredUsage,
      unknownTokenAttempts: metrics.attemptUsage.attemptsWithoutUsage,
      tokens: null,
      cost: null,
      pendingInputState: reopened.store.getInput(f.queued.inputId).state,
      cancelledInputState: reopened.store.getInput(f.cancelled.inputId).state,
      resumeOutcome,
    };
    result.noReplay = true;
    verified = true;
  } catch (error) {
    admissionCleanupConfirmed =
      error instanceof FixtureAdmissionFailure && error.cleanupConfirmed;
    result.failure = failureOf(
      error instanceof FixtureAdmissionFailure ? error.original : error,
    );
  } finally {
    try {
      if (fixture) await fixture.cleanup(verified);
      result.cleanup.engineClosed = !!fixture || admissionCleanupConfirmed;
      result.cleanup.physicalGroupAbsent =
        !!fixture || admissionCleanupConfirmed;
      result.cleanup.databaseRemoved = verified;
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
