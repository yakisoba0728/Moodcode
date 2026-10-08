import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { observedJobGroupsFromSnapshot } from "./job-groups.js";
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
} from "./diagnostics.js";

// A detached supervisor owns the PTY. Losing engine IPC closes the process
// group even when the engine itself was killed and cannot run a finally block.
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
const currentOutcome = (): PtyOutcome => ({
  exitCode,
  cancelled: currentReason !== undefined && currentReason !== "descendants",
  timedOut: currentReason === "timeout",
  cleanupConfirmed: false,
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
// A PTY shell creates job-control groups outside its original process group.
// Observe their actual ancestry before the shell disappears; a HUP relay alone
// cannot prove cleanup when the shell is stopped or cannot run its handler.
async function observedJobGroups(
  pid: number,
): Promise<readonly number[] | undefined> {
  try {
    const { stdout } = await inspectProcesses(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid="],
      {
        encoding: "utf8",
        timeout: 750,
        maxBuffer: 2_097_152,
        env: createCommandEnvironment(),
      },
    );
    const groups = observedJobGroupsFromSnapshot(stdout, pid, process.pid);
    diagnostics.groupSnapshot(groups, "group-cleanup");
    if (!groups)
      diagnostics.note({
        kind: "error",
        errorCode: "PROCESS_SNAPSHOT_UNCONFIRMED",
      });
    send({
      type: "diagnostics",
      diagnostics: diagnostics.snapshot(currentOutcome()),
    });
    return groups;
  } catch (error) {
    diagnostics.groupSnapshot(undefined, "group-cleanup");
    diagnostics.note({
      kind: "error",
      errorCode: ptyDiagnosticErrorCode(error),
    });
    send({
      type: "diagnostics",
      diagnostics: diagnostics.snapshot(currentOutcome()),
    });
    return undefined;
  }
}
const stop = (
  reason: "cancel" | "timeout" | "parent_lost" | "descendants",
): Promise<PtyOutcome> => {
  if (cleanup) return cleanup;
  currentReason = reason;
  cleanup = (async () => {
    if (!terminal)
      return {
        exitCode,
        cancelled: reason !== "descendants",
        timedOut: reason === "timeout",
        cleanupConfirmed: !starting,
        reason,
      };
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
    const results = await Promise.all(
      (groups ?? [terminal.pid]).map(async (group) => {
        const confirmed = await cleanupGroup(
          group,
          group === terminal!.pid ? () => exited : () => true,
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
    const confirmed = groups !== undefined && results.every(Boolean);
    return {
      exitCode,
      cancelled: reason !== "descendants",
      timedOut: reason === "timeout",
      cleanupConfirmed: confirmed,
      reason,
    };
  })();
  void cleanup.then(finish);
  return cleanup;
};
process.on("disconnect", () => {
  disconnected = true;
  void stop("parent_lost");
});
process.on("SIGTERM", () => {
  void stop("cancel");
});
process.on("SIGINT", () => {
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
      !Number.isSafeInteger(input.cols) ||
      input.cols < 1 ||
      input.cols > TERMINAL_LIMITS.maxCols ||
      !Number.isSafeInteger(input.rows) ||
      input.rows < 1 ||
      input.rows > TERMINAL_LIMITS.maxRows ||
      !Number.isSafeInteger(input.maxDurationMs) ||
      input.maxDurationMs < 1 ||
      input.maxDurationMs > TERMINAL_LIMITS.maxDurationMs
    ) {
      finish({
        exitCode: null,
        cancelled: false,
        timedOut: false,
        cleanupConfirmed: true,
        reason: "invalid_start",
      });
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
        send({
          type: "diagnostics",
          diagnostics: diagnostics.snapshot(currentOutcome()),
        });
        if (cleanup) return;
        const present = terminal
          ? observePtyGroupExists(terminal.pid, diagnostics)
          : false;
        if (terminal && present) {
          void stop("descendants");
          return;
        }
        finish({
          exitCode,
          cancelled: false,
          timedOut: false,
          cleanupConfirmed: true,
        });
      });
      timer = setTimeout(() => {
        void stop("timeout");
      }, input.maxDurationMs);
      send({ type: "started", pid: terminal.pid });
    } catch {
      starting = false;
      finish({
        exitCode: null,
        cancelled: false,
        timedOut: false,
        cleanupConfirmed: true,
        reason: "pty_unavailable",
      });
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
        if (
          !Number.isSafeInteger(packet.cols) ||
          packet.cols! < 1 ||
          packet.cols! > TERMINAL_LIMITS.maxCols ||
          !Number.isSafeInteger(packet.rows) ||
          packet.rows! < 1 ||
          packet.rows! > TERMINAL_LIMITS.maxRows
        ) {
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
