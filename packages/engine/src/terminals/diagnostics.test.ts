import assert from "node:assert/strict";
import test from "node:test";
import { groupExists } from "../tools/command/process-control.js";
import {
  observePtyGroupExists,
  PtyDiagnosticRecorder,
  PTY_DIAGNOSTIC_LIMITS,
  validatePtyDiagnostics,
  validatePtyOutcome,
} from "./diagnostics.js";
import type { PtyOutcome } from "./types.js";

const outcome: PtyOutcome = {
  exitCode: 0,
  cancelled: false,
  timedOut: false,
  cleanupConfirmed: true,
};
const invalid = (error: unknown) =>
  (error as { code?: string }).code === "PTY_DIAGNOSTICS_INVALID";
function sample() {
  const recorder = new PtyDiagnosticRecorder("darwin", 200);
  recorder.started(300);
  recorder.nativeExit(0, null);
  recorder.supervisorExit(0, null);
  return recorder.snapshot(outcome);
}

test("bounded diagnostics distinguish native exit, backend close and unobserved original PGID", () => {
  const data = sample();
  assert.deepEqual(validatePtyDiagnostics(data), data);
  assert.equal(data.source.originalGroupPid, null);
  assert.deepEqual(data.nativeExit, {
    observed: true,
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(data.supervisorExit, {
    observed: true,
    closeObserved: true,
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(validatePtyOutcome({ ...outcome, diagnostics: data }), {
    ...outcome,
    diagnostics: data,
  });
  data.source.terminalPid = 999;
  assert.equal(sample().source.terminalPid, 300);
});

test("retained events and group sample are bounded while actual count and truncation remain explicit", () => {
  const recorder = new PtyDiagnosticRecorder("linux", 200);
  recorder.started(300);
  recorder.groupSnapshot(
    Array.from({ length: 100 }, (_, at) => 300 + at),
    "group-cleanup",
  );
  for (let at = 0; at < 100; at++)
    recorder.note({
      kind: "group-cleanup",
      groupPid: 300 + at,
      confirmed: false,
    });
  const data = recorder.snapshot({
    ...outcome,
    cleanupConfirmed: false,
    reason: "cancel",
  });
  assert.equal(data.source.originalGroupPid, 300);
  assert.equal(data.cleanup.groupCount, 100);
  assert.equal(data.cleanup.sampledGroups.length, 32);
  assert.equal(data.cleanup.groupsTruncated, true);
  assert.equal(data.events.length, 32);
  assert.equal(data.eventsDropped, 70);
  assert.ok(
    Buffer.byteLength(JSON.stringify(data)) <= PTY_DIAGNOSTIC_LIMITS.bytes,
  );
  assert.equal(data.outcome.cleanupConfirmed, false);
});

test("descriptor-safe parser rejects getters, proxies, toJSON, hidden fields and sparse arrays with zero traps", () => {
  let traps = 0;
  const getter = sample();
  Object.defineProperty(getter.source, "terminalPid", {
    enumerable: true,
    get() {
      traps++;
      return 300;
    },
  });
  const proxy = new Proxy(sample(), {
    get() {
      traps++;
      throw new Error("trap");
    },
    ownKeys() {
      traps++;
      return [];
    },
    getPrototypeOf() {
      traps++;
      return null;
    },
  });
  const toJSON = {
    ...sample(),
    toJSON() {
      traps++;
      return {};
    },
  };
  const hidden = sample();
  Object.defineProperty(hidden, "argv", {
    value: ["private"],
    enumerable: false,
  });
  const sparse = sample();
  sparse.events = new Array(2);
  const nested = sample();
  nested.events = new Proxy([], {
    get() {
      traps++;
      return 0;
    },
  });
  for (const candidate of [getter, proxy, toJSON, hidden, sparse, nested])
    assert.throws(() => validatePtyDiagnostics(candidate), invalid);
  assert.equal(traps, 0);
});

test("JSON corruption, oversized untrusted fields, nonfinite IDs and contradictory supervisor outcomes fail closed", () => {
  for (const mutate of [
    (data: ReturnType<typeof sample>) => {
      data.source.terminalPid = Number.NaN;
    },
    (data: ReturnType<typeof sample>) => {
      data.source.originalGroupPid = 0;
    },
    (data: ReturnType<typeof sample>) => {
      data.source.originalGroupPid = 999;
    },
    (data: ReturnType<typeof sample>) => {
      data.events = Array.from({ length: 33 }, (_, at) => ({
        seq: at + 1,
        kind: "error" as const,
      }));
    },
    (data: ReturnType<typeof sample>) => {
      data.events[0]!.seq = 2;
    },
    (data: ReturnType<typeof sample>) => {
      data.nativeExit.observed = false;
    },
    (data: ReturnType<typeof sample>) => {
      data.cleanup.sampledGroups = [300];
    },
    (data: ReturnType<typeof sample>) => {
      Object.assign(data, { output: "x".repeat(65_536) });
    },
    (data: ReturnType<typeof sample>) => {
      Object.assign(data.events[0]!, { environment: "x".repeat(65_536) });
    },
  ]) {
    const data = sample();
    mutate(data);
    assert.throws(() => validatePtyDiagnostics(data), invalid);
  }
  assert.throws(
    () =>
      validatePtyOutcome({
        ...outcome,
        cleanupConfirmed: false,
        diagnostics: sample(),
      }),
    invalid,
  );
  assert.throws(
    () =>
      validatePtyOutcome({
        ...outcome,
        reason: "cancel",
        diagnostics: sample(),
      }),
    invalid,
  );
  assert.throws(
    () => validatePtyOutcome({ ...outcome, output: "not an outcome" }),
    invalid,
  );
});

test("private capture overflow loses only diagnostic detail and keeps the genuine native outcome", () => {
  const recorder = new PtyDiagnosticRecorder("darwin", 200);
  recorder.started(300);
  recorder.nativeExit(0, null);
  recorder.groupSnapshot(
    Array.from({ length: 8193 }, (_, at) => 300 + at),
    "group-cleanup",
  );
  let data = recorder.snapshot(outcome);
  assert.equal(data.cleanup.groupSnapshot, "unavailable");
  assert.equal(data.source.originalGroupPid, null);
  assert.ok(
    data.events.some((event) => event.errorCode === "DIAGNOSTIC_GROUP_LIMIT"),
  );
  assert.deepEqual(data.outcome, { ...outcome, reason: null });
  recorder.note({ kind: "error", errorCode: "x".repeat(65) });
  data = recorder.snapshot(outcome);
  assert.deepEqual(validatePtyDiagnostics(data), data);
  assert.deepEqual(data.outcome, { ...outcome, reason: null });
  assert.equal(data.nativeExit.observed, true);
  assert.equal(data.events[0]!.errorCode, "DIAGNOSTIC_CAPTURE_INVALID");
});

test("EPERM remains unknown and conservatively present; ESRCH alone observes absence; unexpected errors still throw", () => {
  const original = process.kill;
  try {
    for (const code of [undefined, "ESRCH", "EPERM", "EIO"]) {
      process.kill = (() => {
        if (code) throw Object.assign(new Error("probe"), { code });
        return true;
      }) as typeof process.kill;
      const recorder = new PtyDiagnosticRecorder(process.platform, 200);
      if (code === "EIO") {
        assert.throws(() => groupExists(300), { code: "EIO" });
        assert.throws(() => observePtyGroupExists(300, recorder), {
          code: "EIO",
        });
      } else
        assert.equal(observePtyGroupExists(300, recorder), groupExists(300));
      const data = recorder.snapshot({ ...outcome, cleanupConfirmed: false });
      assert.equal(
        data.events[0]!.presence,
        code === "ESRCH" ? "absent" : code ? "unknown" : "present",
      );
      assert.equal(data.outcome.cleanupConfirmed, false);
      assert.equal(data.source.originalGroupPid, null);
    }
  } finally {
    process.kill = original;
  }
});
