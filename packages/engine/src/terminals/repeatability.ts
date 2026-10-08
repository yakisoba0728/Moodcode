import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEngine, type EngineOptions } from "../engine.js";
import { PosixPtyBackend } from "./backend.js";
import { validatePtyDiagnostics, validatePtyOutcome } from "./diagnostics.js";
import type {
  PtyCapability,
  PtyDiagnostics,
  PtyOutcome,
  PtyProcess,
  TerminalOwner,
  TerminalRecord,
} from "./types.js";

export const PTY_REPEATABILITY_SCENARIOS = [
  "normal-exit",
  "input-resize",
  "cancel",
  "supervisor-death",
  "ipc-disconnect",
] as const;
export type PtyRepeatabilityScenario =
  (typeof PTY_REPEATABILITY_SCENARIOS)[number];
type Presence = {
  pid: number;
  presence: "present" | "absent" | "unknown";
  errorCode?: string;
};
type TerminalEvidence = Pick<
  TerminalRecord,
  "id" | "state" | "cleanupConfirmed" | "exitCode" | "reason" | "diagnostics"
>;
type SupervisorEvent = {
  kind: "exit" | "close" | "disconnect" | "stdout-eof";
  elapsedMs: number;
  exitCode?: number | null;
  signal?: string | null;
};
export interface PtyRepeatabilityCase {
  schemaVersion: 1;
  scenario: PtyRepeatabilityScenario;
  iteration: number;
  status: "running" | "passed" | "failed" | "unsupported";
  evidencePath: string;
  engineSqlitePath: string;
  terminalSqlitePath: string;
  startedAt: string;
  durationMs?: number;
  capability?: PtyCapability;
  backendOutcome?: PtyOutcome;
  nativePid?: number;
  terminal?: TerminalEvidence;
  supervisor: {
    pid: number | null;
    result?: PtyOutcome;
    events: SupervisorEvent[];
  };
  processSnapshot: { pid: number; ppid: number; pgid: number }[];
  beforeClosePresence?: { pids: Presence[]; groups: Presence[] };
  afterClosePresence?: { pids: Presence[]; groups: Presence[] };
  persistence?: {
    sqliteMatches: boolean;
    restartMatches: boolean;
    historyOnly: boolean;
    terminalSqliteSha256: string;
  };
  replay?: {
    bytes: number;
    sha256: string;
    tty: boolean;
    input: boolean;
    resize: boolean;
  };
  engineClosed: boolean;
  emergencyCancel?: { requested: true; outcome?: PtyOutcome };
  errors: { phase: string; code: string; message: string }[];
}

function errorData(error: unknown, phase: string) {
  const item = error as { code?: unknown; message?: unknown };
  return {
    phase,
    code: typeof item?.code === "string" ? item.code.slice(0, 128) : "UNKNOWN",
    message:
      typeof item?.message === "string"
        ? item.message.slice(0, 1024)
        : String(error).slice(0, 1024),
  };
}
function evidence(record: TerminalRecord): TerminalEvidence {
  return {
    id: record.id,
    state: record.state,
    cleanupConfirmed: record.cleanupConfirmed,
    exitCode: record.exitCode,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.diagnostics ? { diagnostics: record.diagnostics } : {}),
  };
}
export function writePtyRepeatabilityCase(data: PtyRepeatabilityCase): void {
  const temporary = `${data.evidencePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, data.evidencePath);
}
function presence(pid: number): Presence {
  try {
    process.kill(pid, 0);
    return { pid, presence: "present" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return {
      pid,
      presence: code === "ESRCH" ? "absent" : "unknown",
      errorCode: code,
    };
  }
}
function observedProcesses(pids: number[]) {
  const output = childProcess.execFileSync(
    "/bin/ps",
    ["-o", "pid=,ppid=,pgid=", "-p", pids.join(",")],
    {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 8192,
    },
  );
  const rows = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
      assert.ok(
        [pid, ppid, pgid].every(
          (value) => Number.isSafeInteger(value) && value! > 1,
        ),
      );
      assert.ok(pids.includes(pid!));
      return { pid: pid!, ppid: ppid!, pgid: pgid! };
    });
  assert.equal(
    rows.length,
    pids.length,
    "Every actual fixture PID must have a readiness snapshot",
  );
  return rows;
}
async function bounded<T>(
  operation: Promise<T>,
  ms: number,
  phase: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      operation,
      ...(signal
        ? [
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
            }),
          ]
        : []),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error(`PTY repeatability deadline: ${phase}`), {
                code: "PTY_REPEATABILITY_TIMEOUT",
              }),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
async function until(
  check: () => boolean,
  ms: number,
  phase: string,
  signal?: AbortSignal,
) {
  const deadline = performance.now() + ms;
  for (;;) {
    signal?.throwIfAborted();
    if (check()) return;
    if (performance.now() >= deadline)
      throw Object.assign(new Error(`PTY repeatability deadline: ${phase}`), {
        code: "PTY_REPEATABILITY_TIMEOUT",
      });
    await new Promise<void>((done) => setTimeout(done, 3));
  }
}

export function assertPtyRepeatabilityOutcome(
  scenario: PtyRepeatabilityScenario,
  record: TerminalEvidence,
  outcome: PtyOutcome,
  diagnostics: PtyDiagnostics,
): void {
  assert.deepEqual(validatePtyOutcome(outcome), outcome);
  assert.deepEqual(validatePtyDiagnostics(diagnostics), diagnostics);
  assert.deepEqual(record.diagnostics, diagnostics);
  assert.equal(record.cleanupConfirmed, outcome.cleanupConfirmed);
  assert.equal(record.exitCode, outcome.exitCode);
  assert.equal(record.reason ?? null, outcome.reason ?? null);
  assert.equal(diagnostics.source.platform, process.platform);
  assert.ok(diagnostics.source.terminalPid! > 1);
  assert.ok(diagnostics.source.supervisorPid! > 1);
  assert.equal(diagnostics.supervisorExit.observed, true);
  if (scenario === "supervisor-death" || scenario === "ipc-disconnect") {
    assert.equal(record.state, "uncertain");
    assert.equal(outcome.cleanupConfirmed, false);
    assert.equal(outcome.reason, "supervisor_lost");
    assert.equal(diagnostics.cleanup.path, "backend-fallback");
    assert.equal(diagnostics.cleanup.groupSnapshot, "unavailable");
    assert.ok(
      diagnostics.events.some((item) => item.kind === "supervisor-lost"),
    );
    if (scenario === "supervisor-death")
      assert.equal(diagnostics.supervisorExit.signal, "SIGKILL");
    return;
  }
  assert.equal(outcome.cleanupConfirmed, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(diagnostics.nativeExit.observed, true);
  assert.equal(diagnostics.supervisorExit.closeObserved, true);
  assert.equal(diagnostics.supervisorExit.exitCode, 0);
  assert.equal(diagnostics.supervisorExit.signal, null);
  if (scenario === "cancel") {
    assert.equal(record.state, "cancelled");
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.reason, "cancel");
    assert.equal(diagnostics.cleanup.groupSnapshot, "observed");
    assert.equal(diagnostics.cleanup.path, "group-cleanup");
  } else {
    assert.equal(record.state, "completed");
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.exitCode, 0);
    assert.equal(diagnostics.nativeExit.exitCode, 0);
    assert.ok(
      diagnostics.nativeExit.signal === 0 ||
        diagnostics.nativeExit.signal === null,
    );
  }
}

export async function runPtyRepeatabilityCase(input: {
  scenario: PtyRepeatabilityScenario;
  iteration: number;
  directory: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PtyRepeatabilityCase> {
  assert.ok(PTY_REPEATABILITY_SCENARIOS.includes(input.scenario));
  assert.ok(Number.isSafeInteger(input.iteration) && input.iteration >= 1);
  assert.ok(
    Number.isSafeInteger(input.timeoutMs) &&
      input.timeoutMs >= 1000 &&
      input.timeoutMs <= 15_000,
  );
  const directory = resolve(input.directory),
    started = performance.now();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const data: PtyRepeatabilityCase = {
    schemaVersion: 1,
    scenario: input.scenario,
    iteration: input.iteration,
    status: "running",
    evidencePath: join(directory, "case.json"),
    engineSqlitePath: join(directory, "engine.sqlite"),
    terminalSqlitePath: join(directory, "artifacts", "terminals.sqlite"),
    startedAt: new Date().toISOString(),
    supervisor: { pid: null, events: [] },
    processSnapshot: [],
    engineClosed: false,
    errors: [],
  };
  const save = () => writePtyRepeatabilityCase(data);
  const native = new PosixPtyBackend();
  data.capability = await native.capability();
  save();
  if (!data.capability.available) {
    data.status = "unsupported";
    data.durationMs = performance.now() - started;
    save();
    return data;
  }
  let supervisor: ChildProcess | undefined;
  const originalFork = childProcess.fork;
  childProcess.fork = ((...args: Parameters<typeof childProcess.fork>) => {
    const child = Reflect.apply(
      originalFork,
      childProcess,
      args,
    ) as ChildProcess;
    if (/[/\\]terminals[/\\]supervisor\.(ts|js)$/.test(String(args[0]))) {
      assert.equal(
        supervisor,
        undefined,
        "A scenario owns one original supervisor",
      );
      supervisor = child;
      data.supervisor.pid = child.pid ?? null;
      const note = (
        kind: SupervisorEvent["kind"],
        exitCode?: number | null,
        signal?: string | null,
      ) => {
        assert.ok(data.supervisor.events.length < 32);
        data.supervisor.events.push({
          kind,
          elapsedMs: performance.now() - started,
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
        save();
      };
      child.once("exit", (code, signal) => note("exit", code, signal));
      child.once("close", (code, signal) => note("close", code, signal));
      child.once("disconnect", () => note("disconnect"));
      child.stdout?.once("end", () => note("stdout-eof"));
      child.on("message", (packet: unknown) => {
        if (
          !packet ||
          typeof packet !== "object" ||
          (packet as { type?: unknown }).type !== "result"
        )
          return;
        try {
          data.supervisor.result = validatePtyOutcome(
            (packet as { outcome?: unknown }).outcome,
          );
        } catch (error) {
          data.errors.push(errorData(error, "supervisor-result"));
        }
        save();
      });
      save();
    }
    return child;
  }) as typeof childProcess.fork;
  syncBuiltinESMExports();
  const owner: TerminalOwner = {
    authority: "user",
    workspaceId: "repeatability_workspace",
    sessionId: "repeatability_session",
  };
  const root = join(directory, "workspace");
  mkdirSync(root, { mode: 0o700 });
  let originalProcess: PtyProcess | undefined;
  const options: EngineOptions = {
    dbPath: data.engineSqlitePath,
    artifactDir: join(directory, "artifacts"),
    providers: [],
    ptyBackend: {
      capability: () => native.capability(),
      async spawn(request, output) {
        const process = await native.spawn(
          { ...request, maxDurationMs: input.timeoutMs },
          output,
        );
        originalProcess = process;
        data.nativePid = process.pid;
        save();
        void process.closed.then((outcome) => {
          data.backendOutcome = structuredClone(outcome);
          save();
        });
        return process;
      },
    },
  };
  let engine: ReturnType<typeof createEngine> | undefined,
    terminalId: string | undefined;
  let pids: number[] = [],
    groups: number[] = [];
  const observePresence = () => ({
    pids: pids.map(presence),
    groups: groups.map((pid) => presence(-pid)),
  });
  let phase = "engine-create";
  try {
    engine = createEngine(options);
    const createdAt = new Date().toISOString();
    engine.store.putWorkspace({
      id: owner.workspaceId,
      root,
      gitRoot: root,
      branch: null,
      createdAt,
    });
    engine.store.createSession({
      id: owner.sessionId,
      workspaceId: owner.workspaceId,
      title: "Native PTY repeatability",
      createdAt,
    });
    const script =
      input.scenario === "cancel"
        ? 'test -t 0 || exit 9; sleep 60 & printf "PIDS:%s:%s\\n" "$$" "$!"; wait'
        : input.scenario === "input-resize"
          ? 'test -t 0 || exit 9; printf "PIDS:%s\\n" "$$"; read first; stty size; read second; printf "REPLY:%s:%s\\n" "$first" "$second"'
          : 'test -t 0 || exit 9; printf "PIDS:%s\\n" "$$"; read answer; printf "NORMAL_DONE\\n"; exit 0';
    phase = "terminal-create";
    const terminal = await bounded(
      engine.terminals.create({
        owner,
        file: "/bin/sh",
        args: ["-c", script],
        cols: 80,
        rows: 24,
      }),
      input.timeoutMs,
      phase,
      input.signal,
    );
    terminalId = terminal.id;
    const text = () =>
      engine!.terminals
        .replay(terminal.id, owner)
        .output.map((item) => item.data)
        .join("");
    phase = "native-readiness";
    await until(
      () => /PIDS:\d+(?::\d+)?[\r\n]/.test(text()),
      input.timeoutMs,
      phase,
      input.signal,
    );
    pids = /PIDS:(\d+)(?::(\d+))?/
      .exec(text())!
      .slice(1)
      .filter(Boolean)
      .map(Number);
    data.processSnapshot = observedProcesses(pids);
    groups = [...new Set(data.processSnapshot.map((item) => item.pgid))];
    assert.equal(data.processSnapshot[0]!.ppid, data.supervisor.pid);
    assert.equal(data.processSnapshot[0]!.pgid, pids[0]);
    save();
    phase = "scenario-operation";
    if (input.scenario === "supervisor-death")
      assert.equal(supervisor!.kill("SIGKILL"), true);
    else if (input.scenario === "ipc-disconnect") supervisor!.disconnect();
    else if (input.scenario === "cancel")
      await bounded(
        engine.terminals.cancel(terminal.id, owner),
        input.timeoutMs,
        phase,
        input.signal,
      );
    else {
      if (input.scenario === "input-resize")
        await bounded(
          engine.terminals.resize(terminal.id, owner, 100, 40),
          input.timeoutMs,
          phase,
          input.signal,
        );
      await bounded(
        engine.terminals.write(
          terminal.id,
          owner,
          input.scenario === "input-resize" ? "one\rtwo\r" : "finish\r",
        ),
        input.timeoutMs,
        phase,
        input.signal,
      );
    }
    phase = "terminal-close";
    await until(
      () =>
        !["running", "starting"].includes(
          engine!.terminals.get(terminal.id, owner).state,
        ),
      input.timeoutMs,
      phase,
      input.signal,
    );
    data.terminal = evidence(engine.terminals.get(terminal.id, owner));
    const output = text();
    data.replay = {
      bytes: Buffer.byteLength(output),
      sha256: createHash("sha256").update(output).digest("hex"),
      tty: pids.length > 0,
      input: output.includes("NORMAL_DONE") || output.includes("REPLY:one:two"),
      resize: /40\s+100/.test(output),
    };
    data.beforeClosePresence = observePresence();
    save();
    phase = "outcome-check";
    assert.ok(
      data.backendOutcome,
      "The original backend.closed outcome must be retained",
    );
    assert.ok(
      data.terminal.diagnostics,
      "The original terminal diagnostics must be retained",
    );
    assert.equal(data.terminal.diagnostics.source.terminalPid, pids[0]);
    assert.equal(
      data.terminal.diagnostics.source.supervisorPid,
      data.supervisor.pid,
    );
    assertPtyRepeatabilityOutcome(
      input.scenario,
      data.terminal,
      data.backendOutcome,
      data.terminal.diagnostics,
    );
    if (!["supervisor-death", "ipc-disconnect"].includes(input.scenario)) {
      assert.ok(
        data.supervisor.result,
        "Original supervisor result delivery must be observed",
      );
      const { diagnostics: _backendDiagnostics, ...backendResult } =
        data.backendOutcome;
      const { diagnostics: _supervisorDiagnostics, ...supervisorResult } =
        data.supervisor.result;
      assert.deepEqual(supervisorResult, backendResult);
      assert.deepEqual(
        data.supervisor.result.diagnostics?.nativeExit,
        data.terminal.diagnostics.nativeExit,
      );
    }
    if (input.scenario === "input-resize") {
      assert.equal(data.replay.input, true);
      assert.equal(data.replay.resize, true);
    }
    if (input.scenario === "normal-exit") assert.equal(data.replay.input, true);
    phase = "physical-absence";
    await until(
      () =>
        [...pids, ...groups.map((pid) => -pid)].every(
          (pid) => presence(pid).presence === "absent",
        ),
      input.timeoutMs,
      phase,
      input.signal,
    );
    data.beforeClosePresence = observePresence();
    save();
  } catch (error) {
    if (engine && terminalId && !data.terminal) {
      try {
        data.terminal = evidence(engine.terminals.get(terminalId, owner));
      } catch {
        /* Preserve the original failure. */
      }
    }
    data.beforeClosePresence = observePresence();
    data.errors.push(errorData(error, phase));
    data.status = "failed";
    save();
  } finally {
    phase = "engine-close";
    if (engine) {
      try {
        await bounded(engine.close(), 8000, phase);
        data.engineClosed = true;
      } catch (error) {
        data.errors.push(errorData(error, phase));
      }
    }
    if (!data.engineClosed && originalProcess && !data.backendOutcome) {
      data.emergencyCancel = { requested: true };
      try {
        data.emergencyCancel.outcome = await bounded(
          originalProcess.cancel(),
          4000,
          "original-cancel",
        );
      } catch (error) {
        data.errors.push(errorData(error, "original-cancel"));
      }
    }
    data.afterClosePresence = observePresence();
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
    save();
  }
  if (data.engineClosed && data.terminal) {
    let reopened: ReturnType<typeof createEngine> | undefined;
    try {
      phase = "sqlite-restart";
      const db = new DatabaseSync(data.terminalSqlitePath, { readOnly: true });
      let stored: TerminalEvidence;
      try {
        const row = db
          .prepare("SELECT payload FROM terminals WHERE id=?")
          .get(data.terminal.id);
        assert.ok(row);
        stored = evidence(
          JSON.parse(String(row.payload)).record as TerminalRecord,
        );
      } finally {
        db.close();
      }
      assert.deepEqual(stored, data.terminal);
      reopened = createEngine({ ...options, ptyBackend: native });
      assert.deepEqual(
        evidence(reopened.terminals.get(data.terminal.id, owner)),
        data.terminal,
      );
      assert.throws(
        () =>
          reopened!.terminals.captureReadSource(
            data.terminal!.id,
            owner,
            "0".repeat(64),
          ),
        (error: unknown) =>
          (error as { code?: string }).code === "JOB_SOURCE_HISTORY_ONLY",
      );
      await assert.rejects(
        reopened.terminals.write(data.terminal.id, owner, "never replay\r"),
        (error: unknown) =>
          (error as { code?: string }).code === "TERMINAL_CLOSED",
      );
      data.persistence = {
        sqliteMatches: true,
        restartMatches: true,
        historyOnly: true,
        terminalSqliteSha256: createHash("sha256")
          .update(readFileSync(data.terminalSqlitePath))
          .digest("hex"),
      };
    } catch (error) {
      data.errors.push(errorData(error, phase));
    } finally {
      if (reopened) {
        try {
          await bounded(reopened.close(), 8000, "restart-close");
        } catch (error) {
          data.errors.push(errorData(error, "restart-close"));
        }
      }
    }
  }
  data.status = data.errors.length ? "failed" : "passed";
  data.durationMs = performance.now() - started;
  save();
  return data;
}
