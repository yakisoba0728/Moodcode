import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  analyzeJobGroupsFromSnapshot,
  sessionGroupsFromSnapshot,
} from "./job-groups.js";
import {
  createCommandEnvironment,
  cleanupGroup,
} from "../tools/command/process-control.js";
import {
  TERMINAL_LIMITS,
  type PtySpawnInput,
  type PtyOutcome,
} from "./types.js";
import type { IPty } from "node-pty";
import {
  PtyDiagnosticRecorder,
  ptyDiagnosticErrorCode,
  observePtyGroupExists,
  terminalSizeValid,
  unobservedPtyOutcome,
} from "./diagnostics.js";

// A detached supervisor owns the PTY: losing engine IPC closes the group even when a killed engine cannot run finally blocks.
let terminal: IPty | undefined;
let starting = false,
  exited = false,
  finished = false,
  disconnected = !process.connected;
let timer: ReturnType<typeof setTimeout> | undefined;
let cleanup: Promise<PtyOutcome> | undefined;
let exitCode: number | null = null;
let outputPaused = false;
const diagnostics = new PtyDiagnosticRecorder(process.platform, process.pid);
let currentReason: PtyOutcome["reason"];
const currentOutcome = (cleanupConfirmed: boolean): PtyOutcome => ({
  exitCode,
  cancelled: currentReason !== undefined && currentReason !== "descendants",
  timedOut: currentReason === "timeout",
  cleanupConfirmed,
  ...(currentReason ? { reason: currentReason } : {}),
});
const send = (packet: object, done?: () => void): void => {
  try {
    if (process.connected && process.send) process.send(packet, () => done?.());
    else done?.();
  } catch {
    done?.();
  }
};
const sendDiagnostics = (): void =>
  send({
    type: "diagnostics",
    diagnostics: diagnostics.snapshot(currentOutcome(false)),
  });
const finish = (outcome: PtyOutcome): void => {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  const deadline = setTimeout(
    () => process.exit(outcome.cleanupConfirmed ? 0 : 1),
    250,
  );
  send(
    {
      type: "result",
      outcome: { ...outcome, diagnostics: diagnostics.snapshot(outcome) },
    },
    () => {
      if (process.connected) process.disconnect?.();
      if (disconnected || outputPaused) process.stdout.destroy();
      else process.stdout.end();
      clearTimeout(deadline);
      process.exitCode = outcome.cleanupConfirmed ? 0 : 1;
    },
  );
};
const inspectProcesses = promisify(execFile);
const snapshotOptions = {
  encoding: "utf8",
  timeout: 750,
  maxBuffer: 2_097_152,
  env: createCommandEnvironment(),
} as const;
// PTY job control creates groups outside the original one; observe their ancestry before the shell exits, since a HUP relay cannot prove cleanup.
async function observedJobGroups(
  pid: number,
): Promise<readonly number[] | undefined> {
  try {
    const { stdout } = await inspectProcesses(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid="],
      snapshotOptions,
    );
    const analysis = analyzeJobGroupsFromSnapshot(stdout, pid, process.pid);
    const groups = analysis.groups;
    diagnostics.groupSnapshot(groups, "group-cleanup");
    if (!groups) {
      diagnostics.note({
        kind: "error",
        errorCode: "PROCESS_SNAPSHOT_UNCONFIRMED",
      });
      diagnostics.note({ kind: "error", errorCode: analysis.errorCode });
    }
    sendDiagnostics();
    return groups;
  } catch (error) {
    diagnostics.groupSnapshot(undefined, "group-cleanup");
    diagnostics.note({
      kind: "error",
      errorCode: ptyDiagnosticErrorCode(error),
    });
    sendDiagnostics();
    return undefined;
  }
}
// After native exit the session id still names every remaining PTY member, job-control groups included; macOS ps has no sid, so only the original group is observed there.
const sessionIds = process.platform !== "darwin";
async function sessionGroups(
  sid: number,
): Promise<readonly number[] | undefined> {
  try {
    const { stdout } = await inspectProcesses(
      "/bin/ps",
      ["-axo", "pid=,pgid=,sid="],
      snapshotOptions,
    );
    const groups = sessionGroupsFromSnapshot(stdout, sid, process.pid);
    if (!groups)
      diagnostics.note({
        kind: "error",
        errorCode: "PROCESS_SNAPSHOT_UNCONFIRMED",
      });
    return groups;
  } catch (error) {
    diagnostics.note({
      kind: "error",
      errorCode: ptyDiagnosticErrorCode(error),
    });
    return undefined;
  }
}
async function cleanGroups(
  groups: readonly number[],
  leader: number,
): Promise<boolean> {
  const results = await Promise.all(
    groups.map(async (group) => {
      const confirmed = await cleanupGroup(
        group,
        group === leader ? () => exited : () => true,
      ).catch((error) => {
        diagnostics.note({
          kind: "error",
          groupPid: group,
          errorCode: ptyDiagnosticErrorCode(error),
        });
        return false;
      });
      diagnostics.note({ kind: "group-cleanup", groupPid: group, confirmed });
      return confirmed;
    }),
  );
  return results.every(Boolean);
}
const stop = (
  reason: "cancel" | "timeout" | "parent_lost" | "descendants",
): Promise<PtyOutcome> => {
  if (cleanup) return cleanup;
  currentReason = reason;
  cleanup = (async () => {
    if (!terminal) return currentOutcome(!starting);
    // Release any paused output before waiting for the native PTY close event.
    try {
      terminal.resume();
    } catch {
      /* Native exit may already have closed it. */
    }
    const groups = await observedJobGroups(terminal.pid);
    try {
      terminal.kill("SIGHUP");
      diagnostics.note({ kind: "signal", pid: terminal.pid, signal: "SIGHUP" });
    } catch (error) {
      diagnostics.note({
        kind: "signal",
        pid: terminal.pid,
        signal: "SIGHUP",
        errorCode: ptyDiagnosticErrorCode(error),
      });
      /* Every observed group is independently cleaned below. */
    }
    const confirmed =
      (await cleanGroups(groups ?? [terminal.pid], terminal.pid)) &&
      groups !== undefined;
    return currentOutcome(confirmed);
  })();
  void cleanup.then(finish);
  return cleanup;
};
const settleExit = (pid: number): void => {
  const present = observePtyGroupExists(pid, diagnostics);
  const exit = { exitCode, cancelled: false, timedOut: false };
  if (!sessionIds) {
    if (present) void stop("descendants");
    else finish({ ...exit, cleanupConfirmed: true });
    return;
  }
  cleanup = (async () => {
    const groups = await sessionGroups(pid);
    if (groups?.length === 0) return { ...exit, cleanupConfirmed: true };
    diagnostics.groupSnapshot(groups, "group-cleanup");
    const cleaned = await cleanGroups(groups ?? (present ? [pid] : []), pid);
    const remaining = groups && cleaned ? await sessionGroups(pid) : undefined;
    return {
      ...exit,
      cleanupConfirmed: remaining?.length === 0,
      reason: "descendants",
    };
  })();
  void cleanup.then(finish);
};
process.on("disconnect", () => {
  disconnected = true;
  void stop("parent_lost");
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void stop("cancel");
  });
process.stdout.on("error", () => {
  disconnected = true;
  void stop("parent_lost");
});
process.stdout.on("drain", () => {
  outputPaused = false;
  if (!cleanup && !finished)
    try {
      terminal?.resume();
    } catch {
      void stop("descendants");
    }
});

process.on("message", async (message: unknown) => {
  if (finished || !message || typeof message !== "object") return;
  const packet = message as {
    type?: string;
    input?: PtySpawnInput;
    id?: number;
    data?: string;
    cols?: number;
    rows?: number;
  };
  if (packet.type === "stop") {
    void stop("cancel");
    return;
  }
  if (packet.type === "start" && !starting) {
    const input = packet.input;
    if (
      !input ||
      typeof input.file !== "string" ||
      !Array.isArray(input.args) ||
      typeof input.cwd !== "string" ||
      !terminalSizeValid(input.cols, input.rows) ||
      !Number.isSafeInteger(input.maxDurationMs) ||
      input.maxDurationMs < 1 ||
      input.maxDurationMs > TERMINAL_LIMITS.maxDurationMs
    ) {
      finish(unobservedPtyOutcome("invalid_start", true));
      return;
    }
    starting = true;
    try {
      const pty = await import("node-pty");
      if (disconnected || cleanup) {
        starting = false;
        return;
      }
      terminal = pty.spawn(input.file, input.args, {
        name: "xterm-256color",
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env: createCommandEnvironment() as Record<string, string>,
      });
      diagnostics.started(terminal.pid);
      terminal.onData((data) => {
        if (finished || disconnected || cleanup) return;
        if (!process.stdout.write(data)) {
          outputPaused = true;
          terminal?.pause();
        }
      });
      terminal.onExit((event) => {
        exited = true;
        exitCode = event.exitCode;
        diagnostics.nativeExit(
          event.exitCode,
          Number.isSafeInteger(event.signal) ? event.signal! : null,
        );
        sendDiagnostics();
        if (!cleanup) settleExit(terminal!.pid);
      });
      timer = setTimeout(() => {
        void stop("timeout");
      }, input.maxDurationMs);
      send({ type: "started", pid: terminal.pid });
    } catch {
      starting = false;
      finish(unobservedPtyOutcome("pty_unavailable", true));
    }
    return;
  }
  if (packet.type === "write" || packet.type === "resize") {
    const reply = (code?: string) =>
      send({ type: "ack", id: packet.id, ...(code ? { code } : {}) });
    if (!terminal || exited || cleanup || !Number.isSafeInteger(packet.id)) {
      reply("TERMINAL_CLOSED");
      return;
    }
    try {
      if (packet.type === "write") {
        if (
          typeof packet.data !== "string" ||
          Buffer.byteLength(packet.data) > TERMINAL_LIMITS.maxWriteBytes
        ) {
          reply("INVALID_TERMINAL_INPUT");
          return;
        }
        terminal.write(packet.data);
      } else {
        if (!terminalSizeValid(packet.cols, packet.rows)) {
          reply("INVALID_TERMINAL_INPUT");
          return;
        }
        terminal.resize(packet.cols!, packet.rows!);
      }
      reply();
    } catch {
      reply("TERMINAL_IO_FAILED");
    }
  }
});
send({ type: "ready" });
if (disconnected) void stop("parent_lost");
