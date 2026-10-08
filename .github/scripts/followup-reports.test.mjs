import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePersistentSoakReport,
  validatePtyRepeatabilityReport,
} from "./followup-reports.mjs";

const SHA = "a".repeat(64);
const SCENARIOS = [
  "normal-exit",
  "input-resize",
  "cancel",
  "supervisor-death",
  "ipc-disconnect",
];
function ptyFixture() {
  const cases = [1, 2, 3].flatMap((iteration) =>
    SCENARIOS.map((scenario) => {
      const fault = ["supervisor-death", "ipc-disconnect"].includes(scenario);
      return {
        iteration,
        scenario,
        status: "passed",
        engineClosed: true,
        nativePid: 1234,
        worker: { exitCode: 0, signal: null, timedOut: false },
        errors: [],
        terminal: {
          state: fault
            ? "uncertain"
            : scenario === "cancel"
              ? "cancelled"
              : "completed",
          cleanupConfirmed: !fault,
          diagnostics: { authority: "observation-only" },
        },
        backendOutcome: { cleanupConfirmed: !fault },
        persistence: {
          sqliteMatches: true,
          restartMatches: true,
          historyOnly: true,
          terminalSqliteSha256: SHA,
        },
        afterClosePresence: {
          pids: [{ presence: "absent" }],
          groups: [{ presence: "absent" }],
        },
      };
    }),
  );
  return {
    schemaVersion: 1,
    kind: "native-pty-repeatability",
    status: "passed",
    nativeQualified: true,
    runtime: "compiled",
    noLive: true,
    liveProviderRequests: 0,
    credentialsRead: false,
    identityStable: true,
    retainedEvidence: true,
    requestedIterations: 3,
    requestedScenarios: SCENARIOS,
    completedCases: 15,
    cases,
    sourceIdentity: { runtime: "compiled", sourceSha256: SHA, files: [{}] },
    historicalRpty01: {
      causeConfirmed: false,
      reproduced: false,
      resolved: false,
    },
  };
}
function soakFixture() {
  const before = {
    counts: { runs: 7, session_events: 100 },
    recordsSha256: SHA,
  };
  const after = { ...before, counts: { runs: 7, session_events: 105 } };
  return {
    schemaVersion: 1,
    kind: "engine-persistent-soak",
    passed: true,
    supported: true,
    noLive: true,
    source: { runtime: "compiled", sourceSha256: SHA, cliSha256: SHA },
    durationMs: 1000,
    maxCycles: 6,
    maxInputs: 28,
    maxInputBytes: 65536,
    maxSamples: 8,
    summary: { sourceStable: true, activeDurationMs: 1001, engineInstances: 3 },
    load: {
      cycles: 3,
      inputs: 16,
      inputBytes: 16384,
      completedCommands: 1,
      cancelledCommands: 1,
      textCycles: 1,
      commands: 3,
      jobs: [{}, {}],
      cycleEvidenceSha256: SHA,
      cancellation: {
        physicalCleanupConfirmed: true,
        nativeCleanupConfirmed: false,
        resumeOutcome: "cleanup-pending",
      },
    },
    gracefulCheckpoint: { before, after: before, noAutomaticReplay: true },
    crashCheckpoint: {
      before,
      after,
      retained: after,
      jobState: "uncertain",
      completion: null,
      pendingInputState: "pending",
      cancelledInputState: "cancelled",
      noAutomaticReplay: true,
      recoveredProviderCalls: 0,
      processLaunches: 3,
      tokens: null,
      cost: null,
      originalSourceSha256: SHA,
      originalApprovalFingerprint: SHA,
      recoveryEvents: [
        "tool.recovery_frontier",
        "message.part.interrupted",
        "turn.uncertain",
        "session.paused",
        "session.document.updated",
      ].map((type) => ({ type })),
    },
    cleanup: {
      workerExited: true,
      recoveryEngineClosed: true,
      commandPidAbsent: true,
      commandGroupAbsent: true,
      physicalCleanupConfirmed: true,
      ownedLiveSurvivors: [],
      emergencyCleanupUsed: false,
      nativeCleanupConfirmed: false,
      databaseRemoved: false,
      retainedReason: "expected-uncertain-command-no-recovery-acknowledgment",
      retainedEvidencePath: "/fixture",
    },
    samples: Array.from({ length: 8 }, (_, elapsedMs) => ({
      elapsedMs,
      memory: { rss: 1024, heapUsed: 512 },
      descriptors: { count: 3, source: "fixture-observation" },
      processes: { liveDescendants: 0, truncated: false },
      sqlite: { primaryBytes: 4096, counts: { runs: 7 } },
      artifacts: { bytes: 0, pathsAndSizesSha256: SHA },
    })),
  };
}
function mutation(validator, factory, edits) {
  for (const edit of edits) {
    const report = factory();
    edit(report);
    assert.throws(() => validator(report));
  }
}

test("PTY report gate requires full case coverage, compiled native evidence and retained uncertainty", () => {
  assert.equal(validatePtyRepeatabilityReport(ptyFixture()).completedCases, 15);
  mutation(validatePtyRepeatabilityReport, ptyFixture, [
    (p) => {
      p.nativeQualified = false;
    },
    (p) => {
      p.runtime = "source";
    },
    (p) => {
      p.credentialsRead = true;
    },
    (p) => {
      p.cases[1] = p.cases[0];
    },
    (p) => {
      p.cases[0].worker.timedOut = true;
    },
    (p) => {
      p.cases[3].terminal.cleanupConfirmed = true;
    },
    (p) => {
      p.cases[0].afterClosePresence.pids[0].presence = "unknown";
    },
    (p) => {
      p.cases[3].afterClosePresence.groups[0].presence = "present";
    },
    (p) => {
      p.cases[4].afterClosePresence.pids = [];
    },
    (p) => {
      p.cases[4].persistence.restartMatches = false;
    },
    (p) => {
      p.historicalRpty01.resolved = true;
    },
  ]);
});

test("persistent gate rejects short runs, replay, lost recovery rows, unknown erasure and absent resource observations", () => {
  assert.equal(validatePersistentSoakReport(soakFixture()).durationMs, 1000);
  mutation(validatePersistentSoakReport, soakFixture, [
    (p) => {
      p.summary.activeDurationMs = 900;
    },
    (p) => {
      p.load.cycles = 2;
    },
    (p) => {
      p.load.inputs = 15;
    },
    (p) => {
      p.source.runtime = "source";
    },
    (p) => {
      p.crashCheckpoint.recoveredProviderCalls = 1;
    },
    (p) => {
      p.crashCheckpoint.after.counts.runs++;
    },
    (p) => {
      p.crashCheckpoint.recoveryEvents.pop();
    },
    (p) => {
      p.cleanup.databaseRemoved = true;
    },
    (p) => {
      p.cleanup.nativeCleanupConfirmed = true;
    },
    (p) => {
      p.cleanup.emergencyCleanupUsed = true;
    },
    (p) => {
      p.samples[0].descriptors.count = null;
    },
    (p) => {
      p.samples[3].elapsedMs = -1;
    },
  ]);
});
