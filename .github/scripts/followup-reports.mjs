import assert from "node:assert/strict";

const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const PTY_SCENARIOS = [
  "normal-exit",
  "input-resize",
  "cancel",
  "supervisor-death",
  "ipc-disconnect",
];
const RECOVERY_EVENTS = [
  "tool.recovery_frontier",
  "message.part.interrupted",
  "turn.uncertain",
  "session.paused",
  "session.document.updated",
];

export function validatePtyRepeatabilityReport(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "native-pty-repeatability");
  assert.equal(report.status, "passed");
  assert.equal(report.nativeQualified, true);
  assert.equal(report.runtime, "compiled");
  assert.equal(report.noLive, true);
  assert.equal(report.liveProviderRequests, 0);
  assert.equal(report.credentialsRead, false);
  assert.equal(report.identityStable, true);
  assert.equal(report.retainedEvidence, true);
  assert.ok(integer(report.requestedIterations, 3, 32));
  assert.deepEqual(report.requestedScenarios, PTY_SCENARIOS);
  assert.equal(
    report.completedCases,
    report.requestedIterations * PTY_SCENARIOS.length,
  );
  assert.equal(report.cases.length, report.completedCases);
  assert.equal(report.sourceIdentity.runtime, "compiled");
  assert.ok(sha(report.sourceIdentity.sourceSha256));
  assert.ok(report.sourceIdentity.files.length > 0);
  assert.deepEqual(report.historicalRpty01, {
    causeConfirmed: false,
    reproduced: false,
    resolved: false,
  });
  const seen = new Set();
  for (const item of report.cases) {
    assert.ok(
      PTY_SCENARIOS.includes(item.scenario) &&
        integer(item.iteration, 1, report.requestedIterations),
    );
    const key = `${item.iteration}:${item.scenario}`;
    assert.ok(!seen.has(key));
    seen.add(key);
    assert.equal(item.status, "passed");
    assert.equal(item.engineClosed, true);
    assert.equal(item.worker.exitCode, 0);
    assert.equal(item.worker.signal, null);
    assert.equal(item.worker.timedOut, false);
    assert.deepEqual(item.errors, []);
    assert.ok(integer(item.nativePid, 2));
    assert.equal(item.terminal.diagnostics.authority, "observation-only");
    assert.equal(item.persistence.sqliteMatches, true);
    assert.equal(item.persistence.restartMatches, true);
    assert.equal(item.persistence.historyOnly, true);
    assert.ok(sha(item.persistence.terminalSqliteSha256));
    const uncertain = ["supervisor-death", "ipc-disconnect"].includes(
      item.scenario,
    );
    assert.equal(
      item.terminal.state,
      uncertain
        ? "uncertain"
        : item.scenario === "cancel"
          ? "cancelled"
          : "completed",
    );
    assert.equal(item.terminal.cleanupConfirmed, !uncertain);
    assert.equal(item.backendOutcome.cleanupConfirmed, !uncertain);
    assert.ok(
      item.afterClosePresence.pids.length > 0 &&
        item.afterClosePresence.groups.length > 0,
    );
    for (const observation of [
      ...item.afterClosePresence.pids,
      ...item.afterClosePresence.groups,
    ])
      assert.equal(observation.presence, "absent");
  }
  return report;
}

export function validatePersistentSoakReport(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "engine-persistent-soak");
  assert.equal(report.passed, true);
  assert.equal(report.supported, true);
  assert.equal(report.noLive, true);
  assert.equal(report.source.runtime, "compiled");
  assert.ok(sha(report.source.sourceSha256) && sha(report.source.cliSha256));
  assert.equal(report.summary.sourceStable, true);
  assert.ok(integer(report.durationMs, 1000, 28_800_000));
  assert.ok(report.summary.activeDurationMs >= report.durationMs);
  assert.equal(report.summary.engineInstances, 3);
  const load = report.load,
    crash = report.crashCheckpoint,
    cleanup = report.cleanup;
  assert.ok(integer(load.cycles, 3, report.maxCycles));
  assert.ok(
    integer(load.inputs, 16, report.maxInputs) &&
      integer(load.inputBytes, 0, report.maxInputBytes),
  );
  assert.ok(
    load.completedCommands >= 1 &&
      load.cancelledCommands === 1 &&
      load.textCycles >= 1,
  );
  assert.ok(sha(load.cycleEvidenceSha256));
  assert.equal(load.commands, load.jobs.length + 1);
  assert.equal(load.cancellation.physicalCleanupConfirmed, true);
  assert.equal(load.cancellation.nativeCleanupConfirmed, false);
  assert.equal(load.cancellation.resumeOutcome, "cleanup-pending");
  assert.equal(report.gracefulCheckpoint.noAutomaticReplay, true);
  assert.deepEqual(
    report.gracefulCheckpoint.before,
    report.gracefulCheckpoint.after,
  );
  assert.equal(crash.jobState, "uncertain");
  assert.equal(crash.completion, null);
  assert.equal(crash.pendingInputState, "pending");
  assert.equal(crash.cancelledInputState, "cancelled");
  assert.equal(crash.noAutomaticReplay, true);
  assert.equal(crash.recoveredProviderCalls, 0);
  assert.equal(crash.processLaunches, load.commands);
  assert.equal(crash.tokens, null);
  assert.equal(crash.cost, null);
  assert.ok(
    sha(crash.originalSourceSha256) && sha(crash.originalApprovalFingerprint),
  );
  assert.deepEqual(crash.after, crash.retained);
  for (const [table, count] of Object.entries(crash.before.counts))
    assert.equal(
      crash.after.counts[table],
      count + (table === "session_events" ? 5 : 0),
    );
  assert.deepEqual(
    crash.recoveryEvents.map((event) => event.type),
    RECOVERY_EVENTS,
  );
  for (const field of [
    "workerExited",
    "recoveryEngineClosed",
    "commandPidAbsent",
    "commandGroupAbsent",
    "physicalCleanupConfirmed",
  ])
    assert.equal(cleanup[field], true);
  assert.deepEqual(cleanup.ownedLiveSurvivors, []);
  assert.equal(cleanup.emergencyCleanupUsed, false);
  assert.equal(cleanup.nativeCleanupConfirmed, false);
  assert.equal(cleanup.databaseRemoved, false);
  assert.equal(
    cleanup.retainedReason,
    "expected-uncertain-command-no-recovery-acknowledgment",
  );
  assert.ok(
    typeof cleanup.retainedEvidencePath === "string" &&
      cleanup.retainedEvidencePath.length > 0,
  );
  assert.ok(
    report.samples.length >= 8 && report.samples.length <= report.maxSamples,
  );
  let elapsed = -1;
  for (const sample of report.samples) {
    assert.ok(sample.elapsedMs >= elapsed);
    elapsed = sample.elapsedMs;
    assert.ok(integer(sample.memory.rss, 1) && integer(sample.memory.heapUsed));
    assert.ok(
      integer(sample.descriptors.count) &&
        sample.descriptors.source !== "unavailable",
    );
    assert.ok(
      integer(sample.processes.liveDescendants) &&
        sample.processes.truncated === false,
    );
    assert.ok(
      integer(sample.sqlite.primaryBytes, 1) &&
        integer(sample.sqlite.counts.runs),
    );
    assert.ok(
      integer(sample.artifacts.bytes) &&
        sha(sample.artifacts.pathsAndSizesSha256),
    );
  }
  return report;
}
