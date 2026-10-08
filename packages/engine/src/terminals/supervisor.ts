import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createCommandEnvironment,
  cleanupGroup,
  groupExists,
} from "../tools/command/process-control.js";
import {
  TERMINAL_LIMITS,
  type PtySpawnInput,
  type PtyOutcome,
} from "./types.js";
import type { IPty } from "node-pty";

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
  send({ type: "result", outcome }, () => {
    if (process.connected) process.disconnect?.();
    if (disconnected || outputPaused) process.stdout.destroy();
    else process.stdout.end();
    clearTimeout(deadline);
    process.exitCode = outcome.cleanupConfirmed ? 0 : 1;
  });
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
    const rows = stdout.trim().split("\n");
    if (rows.length > 65_536) return undefined;
    const byPid = new Map<number, { parent: number; group: number }>();
    const children = new Map<number, number[]>();
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields.length !== 3) return undefined;
      const [child, parent, group] = fields.map(Number);
      if (
        ![child, parent, group].every(Number.isSafeInteger) ||
        child! <= 0 ||
        parent! < 0 ||
        group! <= 0 ||
        byPid.has(child!)
      )
        return undefined;
      byPid.set(child!, { parent: parent!, group: group! });
      const siblings = children.get(parent!) ?? [];
      siblings.push(child!);
      children.set(parent!, siblings);
    }
    // The native PTY leader is a direct child and owns its fresh process group.
    const leader = byPid.get(pid);
    if (!leader || leader.parent !== process.pid || leader.group !== pid)
      return undefined;
    const groups = new Set<number>([pid]),
      visited = new Set<number>();
    const pending = [pid];
    for (let at = 0; at < pending.length; at++) {
      const child = pending[at]!;
      if (visited.has(child) || pending.length > 8192) return undefined;
      visited.add(child);
      const group = byPid.get(child)!.group;
      if (group <= 1 || group === process.pid) return undefined;
      groups.add(group);
      pending.push(...(children.get(child) ?? []));
    }
    return [...groups];
  } catch {
    return undefined;
  }
}
const stop = (
  reason: "cancel" | "timeout" | "parent_lost" | "descendants",
): Promise<PtyOutcome> => {
  if (cleanup) return cleanup;
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
    } catch {
      /* Every observed group is independently cleaned below. */
    }
    const results = await Promise.all(
      (groups ?? [terminal.pid]).map((group) =>
        cleanupGroup(
          group,
          group === terminal!.pid ? () => exited : () => true,
        ).catch(() => false),
      ),
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
        if (cleanup) return;
        if (terminal && groupExists(terminal.pid)) {
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
