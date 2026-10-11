import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import { pidPresence } from "../shared/runtime.js";
import {
  TERMINAL_LIMITS,
  type PtyDiagnosticEvent,
  type PtyDiagnostics,
  type PtyOutcome,
} from "./types.js";

export const PTY_DIAGNOSTIC_LIMITS = Object.freeze({
  bytes: 16_384,
  events: 32,
  groups: 32,
  groupCount: 8192,
});
const eventKinds = new Set(
  Object.keys({
    started: true,
    "native-exit": true,
    "group-probe": true,
    "group-snapshot": true,
    "group-cleanup": true,
    signal: true,
    "supervisor-exit": true,
    "supervisor-close": true,
    "supervisor-lost": true,
    "invalid-diagnostics": true,
    error: true,
  } satisfies Record<PtyDiagnosticEvent["kind"], true>),
);
const eventKeys = [
  "seq",
  "kind",
  "pid",
  "groupPid",
  "exitCode",
  "exitSignal",
  "signal",
  "errorCode",
  "presence",
  "confirmed",
  "groupCount",
];
function fail(): never {
  throw new EngineError(
    "PTY_DIAGNOSTICS_INVALID",
    "Terminal diagnostics are invalid or exceed their bounded observation format",
  );
}
function record(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)))
    fail();
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const d = descriptors[key]!;
    if (!d.enumerable || !("value" in d)) fail();
    result[key] = d.value;
  }
  if (required.some((key) => !Object.hasOwn(result, key))) fail();
  return result;
}
function array(value: unknown, limit: number): unknown[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit
  )
    fail();
  const d = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(d).length !== value.length + 1) fail();
  const result: unknown[] = [];
  for (let at = 0; at < value.length; at++) {
    const item = d[String(at)];
    if (!item?.enumerable || !("value" in item)) fail();
    result.push(item.value);
  }
  return result;
}
const inRange = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max;
const isPid = (value: unknown): value is number =>
  inRange(value, 2, 2_147_483_647);
const isCode = (value: unknown): value is number =>
  inRange(value, -2_147_483_648, 2_147_483_647);
const isLabel = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
function integer(value: unknown, min: number, max: number): number {
  if (!inRange(value, min, max)) fail();
  return value;
}
function pid(value: unknown): number | null {
  if (value !== null && !isPid(value)) fail();
  return value;
}
function code(value: unknown): number | null {
  if (value !== null && !isCode(value)) fail();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}
function label(value: unknown): string {
  if (!isLabel(value)) fail();
  return value;
}

export const terminalSizeValid = (cols: unknown, rows: unknown): boolean =>
  inRange(cols, 1, TERMINAL_LIMITS.maxCols) &&
  inRange(rows, 1, TERMINAL_LIMITS.maxRows);

export const unobservedPtyOutcome = (
  reason: string,
  cleanupConfirmed = false,
  cancelled = false,
): PtyOutcome => ({
  exitCode: null,
  cancelled,
  timedOut: false,
  cleanupConfirmed,
  reason,
});

/** Strict bounded DATA parser. A valid checksum/shape never restores process ownership. */
export function validatePtyDiagnostics(value: unknown): PtyDiagnostics {
  const v = record(value, [
    "version",
    "authority",
    "source",
    "nativeExit",
    "supervisorExit",
    "outcome",
    "cleanup",
    "events",
    "eventsDropped",
  ]);
  if (v.version !== 1 || v.authority !== "observation-only") fail();
  const s = record(v.source, [
    "platform",
    "supervisorPid",
    "terminalPid",
    "originalGroupPid",
  ]);
  const n = record(v.nativeExit, ["observed", "exitCode", "signal"]);
  const b = record(v.supervisorExit, [
    "observed",
    "closeObserved",
    "exitCode",
    "signal",
  ]);
  const o = record(v.outcome, [
    "exitCode",
    "cancelled",
    "timedOut",
    "cleanupConfirmed",
    "reason",
  ]);
  const c = record(v.cleanup, [
    "path",
    "groupSnapshot",
    "groupCount",
    "sampledGroups",
    "groupsTruncated",
  ]);
  if (
    typeof c.path !== "string" ||
    !["none", "group-cleanup", "backend-fallback"].includes(c.path) ||
    typeof c.groupSnapshot !== "string" ||
    !["not-requested", "observed", "unavailable"].includes(c.groupSnapshot)
  )
    fail();
  const groups = array(c.sampledGroups, PTY_DIAGNOSTIC_LIMITS.groups).map(
    (value) => pid(value)!,
  );
  if (
    groups.some((group) => group === null) ||
    new Set(groups).size !== groups.length
  )
    fail();
  const groupCount = integer(c.groupCount, 0, PTY_DIAGNOSTIC_LIMITS.groupCount),
    truncated = bool(c.groupsTruncated);
  if (
    groups.length !== Math.min(groupCount, PTY_DIAGNOSTIC_LIMITS.groups) ||
    truncated !== groupCount > groups.length
  )
    fail();
  const events = array(v.events, PTY_DIAGNOSTIC_LIMITS.events).map(
    (value, at) => {
      const e = record(value, eventKeys, ["seq", "kind"]);
      if (typeof e.kind !== "string" || !eventKinds.has(e.kind)) fail();
      integer(e.seq, at + 1, at + 1);
      for (const key of ["pid", "groupPid"])
        if (Object.hasOwn(e, key) && pid(e[key]) === null) fail();
      for (const key of ["exitCode", "exitSignal"])
        if (Object.hasOwn(e, key)) code(e[key]);
      for (const key of ["signal", "errorCode"])
        if (Object.hasOwn(e, key)) label(e[key]);
      if (
        Object.hasOwn(e, "presence") &&
        (typeof e.presence !== "string" ||
          !["present", "absent", "unknown"].includes(e.presence))
      )
        fail();
      if (Object.hasOwn(e, "confirmed")) bool(e.confirmed);
      if (Object.hasOwn(e, "groupCount"))
        integer(e.groupCount, 0, PTY_DIAGNOSTIC_LIMITS.groupCount);
      return e as unknown as PtyDiagnosticEvent;
    },
  );
  const result: PtyDiagnostics = {
    version: 1,
    authority: "observation-only",
    source: {
      platform: label(s.platform),
      supervisorPid: pid(s.supervisorPid),
      terminalPid: pid(s.terminalPid),
      originalGroupPid: pid(s.originalGroupPid),
    },
    nativeExit: {
      observed: bool(n.observed),
      exitCode: code(n.exitCode),
      signal: code(n.signal),
    },
    supervisorExit: {
      observed: bool(b.observed),
      closeObserved: bool(b.closeObserved),
      exitCode: code(b.exitCode),
      signal: b.signal === null ? null : label(b.signal),
    },
    outcome: {
      exitCode: code(o.exitCode),
      cancelled: bool(o.cancelled),
      timedOut: bool(o.timedOut),
      cleanupConfirmed: bool(o.cleanupConfirmed),
      reason: o.reason === null ? null : label(o.reason),
    },
    cleanup: {
      path: c.path as PtyDiagnostics["cleanup"]["path"],
      groupSnapshot:
        c.groupSnapshot as PtyDiagnostics["cleanup"]["groupSnapshot"],
      groupCount,
      sampledGroups: groups,
      groupsTruncated: truncated,
    },
    events,
    eventsDropped: integer(v.eventsDropped, 0, Number.MAX_SAFE_INTEGER),
  };
  if (
    !result.nativeExit.observed &&
    (result.nativeExit.exitCode !== null || result.nativeExit.signal !== null)
  )
    fail();
  if (
    !result.supervisorExit.observed &&
    (result.supervisorExit.exitCode !== null ||
      result.supervisorExit.signal !== null)
  )
    fail();
  if (result.supervisorExit.closeObserved && !result.supervisorExit.observed)
    fail();
  if (
    result.source.originalGroupPid !== null &&
    result.source.originalGroupPid !== result.source.terminalPid
  )
    fail();
  if (Buffer.byteLength(JSON.stringify(result)) > PTY_DIAGNOSTIC_LIMITS.bytes)
    fail();
  return result;
}

export function ptyDiagnosticErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || types.isProxy(error))
    return "UNKNOWN";
  const code = Object.getOwnPropertyDescriptor(error, "code");
  return code && "value" in code && isLabel(code.value)
    ? code.value
    : "UNKNOWN";
}

/** Same conservative decision as groupExists; EPERM is observed as unknown, never absent. */
export function observePtyGroupExists(
  groupPid: number,
  recorder: PtyDiagnosticRecorder,
): boolean {
  const { presence, error } = pidPresence(groupPid, { group: true });
  if (presence === "alive") {
    recorder.note({ kind: "group-probe", groupPid, presence: "present" });
    return true;
  }
  const errorCode = ptyDiagnosticErrorCode(error);
  recorder.note({ kind: "group-probe", groupPid, presence, errorCode });
  if (presence === "absent") return false;
  if (errorCode === "EPERM") return true;
  throw error;
}

/** Strict supervisor result parser; corrupt observations cannot stand in for a closed result. */
export function validatePtyOutcome(value: unknown): PtyOutcome {
  const v = record(
    value,
    [
      "exitCode",
      "cancelled",
      "timedOut",
      "cleanupConfirmed",
      "reason",
      "diagnostics",
    ],
    ["exitCode", "cancelled", "timedOut", "cleanupConfirmed"],
  );
  const result: PtyOutcome = {
    exitCode: code(v.exitCode),
    cancelled: bool(v.cancelled),
    timedOut: bool(v.timedOut),
    cleanupConfirmed: bool(v.cleanupConfirmed),
    ...(Object.hasOwn(v, "reason") ? { reason: label(v.reason) } : {}),
  };
  if (Object.hasOwn(v, "diagnostics")) {
    const diagnostics = validatePtyDiagnostics(v.diagnostics);
    if (
      diagnostics.outcome.exitCode !== result.exitCode ||
      diagnostics.outcome.cancelled !== result.cancelled ||
      diagnostics.outcome.timedOut !== result.timedOut ||
      diagnostics.outcome.cleanupConfirmed !== result.cleanupConfirmed ||
      diagnostics.outcome.reason !== (result.reason ?? null)
    )
      fail();
    result.diagnostics = diagnostics;
  }
  return result;
}

/** Captures only actual observation metadata, never command arguments, environment or output. */
export class PtyDiagnosticRecorder {
  private data: PtyDiagnostics;
  constructor(
    platform: string,
    supervisorPid: number | null,
    previous?: PtyDiagnostics,
  ) {
    this.data = previous
      ? validatePtyDiagnostics(previous)
      : {
          version: 1,
          authority: "observation-only",
          source: {
            platform,
            supervisorPid,
            terminalPid: null,
            originalGroupPid: null,
          },
          nativeExit: { observed: false, exitCode: null, signal: null },
          supervisorExit: {
            observed: false,
            closeObserved: false,
            exitCode: null,
            signal: null,
          },
          outcome: {
            exitCode: null,
            cancelled: false,
            timedOut: false,
            cleanupConfirmed: false,
            reason: null,
          },
          cleanup: {
            path: "none",
            groupSnapshot: "not-requested",
            groupCount: 0,
            sampledGroups: [],
            groupsTruncated: false,
          },
          events: [],
          eventsDropped: 0,
        };
    this.data.source.supervisorPid = supervisorPid;
  }
  started(terminalPid: number): void {
    this.data.source.terminalPid = terminalPid;
    this.note({ kind: "started", pid: terminalPid });
  }
  note(event: Omit<PtyDiagnosticEvent, "seq">): void {
    if (this.data.events.length === PTY_DIAGNOSTIC_LIMITS.events) {
      this.data.eventsDropped++;
      return;
    }
    this.data.events.push({ seq: this.data.events.length + 1, ...event });
  }
  nativeExit(exitCode: number, signal: number | null): void {
    this.data.nativeExit = { observed: true, exitCode, signal };
    this.note({ kind: "native-exit", exitCode, exitSignal: signal });
  }
  supervisorExit(
    exitCode: number | null,
    signal: string | null,
    closeObserved = true,
  ): void {
    this.data.supervisorExit = {
      observed: true,
      closeObserved,
      exitCode,
      signal,
    };
    this.note({
      kind: closeObserved ? "supervisor-close" : "supervisor-exit",
      exitCode,
      ...(signal ? { signal } : {}),
    });
  }
  groupSnapshot(
    groups: readonly number[] | undefined,
    path: "group-cleanup" | "backend-fallback",
  ): void {
    if (groups && groups.length > PTY_DIAGNOSTIC_LIMITS.groupCount) {
      this.note({ kind: "error", errorCode: "DIAGNOSTIC_GROUP_LIMIT" });
      groups = undefined;
    }
    this.data.cleanup = {
      path,
      groupSnapshot: groups === undefined ? "unavailable" : "observed",
      groupCount: groups?.length ?? 0,
      sampledGroups: [...(groups ?? [])].slice(0, PTY_DIAGNOSTIC_LIMITS.groups),
      groupsTruncated: (groups?.length ?? 0) > PTY_DIAGNOSTIC_LIMITS.groups,
    };
    if (groups?.includes(this.data.source.terminalPid!))
      this.data.source.originalGroupPid = this.data.source.terminalPid;
    this.note({
      kind: "group-snapshot",
      groupCount: groups?.length ?? 0,
      confirmed: groups !== undefined,
    });
  }
  snapshot(outcome: PtyOutcome): PtyDiagnostics {
    this.data.outcome = {
      exitCode: outcome.exitCode,
      cancelled: outcome.cancelled,
      timedOut: outcome.timedOut,
      cleanupConfirmed: outcome.cleanupConfirmed,
      reason: outcome.reason ?? null,
    };
    try {
      return validatePtyDiagnostics(this.data);
    } catch {
      // Collection failure loses metadata, not the outcome: emit a bounded fallback while strict readers still reject untrusted payloads.
      const { nativeExit, supervisorExit } = this.data;
      const safePid = (value: number | null) => (isPid(value) ? value : null);
      const safeCode = (value: number | null) => (isCode(value) ? value : null);
      const safeLabel = (value: string | null) =>
        isLabel(value) ? value : null;
      return {
        version: 1,
        authority: "observation-only",
        source: {
          platform: safeLabel(this.data.source.platform) ?? "unknown",
          supervisorPid: safePid(this.data.source.supervisorPid),
          terminalPid: safePid(this.data.source.terminalPid),
          originalGroupPid: null,
        },
        nativeExit: {
          observed: nativeExit.observed,
          exitCode: nativeExit.observed ? safeCode(nativeExit.exitCode) : null,
          signal: nativeExit.observed ? safeCode(nativeExit.signal) : null,
        },
        supervisorExit: {
          observed: supervisorExit.observed,
          closeObserved: supervisorExit.closeObserved,
          exitCode: supervisorExit.observed
            ? safeCode(supervisorExit.exitCode)
            : null,
          signal: supervisorExit.observed
            ? safeLabel(supervisorExit.signal)
            : null,
        },
        outcome: {
          exitCode: safeCode(outcome.exitCode),
          cancelled: outcome.cancelled === true,
          timedOut: outcome.timedOut === true,
          cleanupConfirmed: outcome.cleanupConfirmed === true,
          reason: safeLabel(outcome.reason ?? null),
        },
        cleanup: {
          path: this.data.cleanup.path,
          groupSnapshot: "unavailable",
          groupCount: 0,
          sampledGroups: [],
          groupsTruncated: false,
        },
        events: [
          {
            seq: 1,
            kind: "invalid-diagnostics",
            errorCode: "DIAGNOSTIC_CAPTURE_INVALID",
          },
        ],
        eventsDropped: Math.min(
          Number.MAX_SAFE_INTEGER,
          this.data.events.length + this.data.eventsDropped,
        ),
      };
    }
  }
}
