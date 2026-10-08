import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  acquireExecutionLock,
  type ExecutionLock,
} from "../tools/command/execution-lock.js";
import { cleanupGroup } from "../tools/command/process-control.js";

// IPC disappearance is the root's liveness signal, including SIGKILL. The peer
// owns a separate process group, so descendants must disappear before release.
let peer: ChildProcessWithoutNullStreams | undefined;
let lock: ExecutionLock | undefined;
let closed = false;
let disconnected = !process.connected;
let finishing: Promise<void> | undefined;
let exitCode: number | null = null;
let exitSignal: NodeJS.Signals | null = null;
let writing = false;
const stops = new AbortController();

function send(packet: object): void {
  if (!process.connected) return;
  try {
    process.send?.(packet);
  } catch {
    /* Disconnect cleanup owns the peer. */
  }
}

function stop(): Promise<void> {
  return (finishing ??= (async () => {
    stops.abort();
    peer?.stdout.resume();
    peer?.stderr.resume();
    let cleanupConfirmed = !peer;
    try {
      if (peer?.pid !== undefined)
        cleanupConfirmed = await cleanupGroup(peer.pid, () => closed);
      else if (peer) cleanupConfirmed = closed;
    } catch {
      cleanupConfirmed = false;
    }
    try {
      lock?.release(cleanupConfirmed);
    } catch {
      cleanupConfirmed = false;
    }
    send({ type: "result", cleanupConfirmed, exitCode, signal: exitSignal });
    const exit = (): void => process.exit(cleanupConfirmed ? 0 : 1);
    const timeout = setTimeout(exit, 250);
    process.stdout.end(() =>
      process.stderr.end(() => {
        clearTimeout(timeout);
        exit();
      }),
    );
  })());
}

function forward(stream: "stdout" | "stderr", bytes: Buffer): void {
  if (finishing || disconnected) return;
  const source = peer?.[stream],
    sink = process[stream];
  if (sink.write(bytes)) return;
  source?.pause();
  const resume = (): void => {
    sink.removeListener("drain", resume);
    sink.removeListener("close", resume);
    stops.signal.removeEventListener("abort", resume);
    source?.resume();
  };
  sink.once("drain", resume);
  sink.once("close", resume);
  stops.signal.addEventListener("abort", resume, { once: true });
  if (stops.signal.aborted) resume();
}

process.on("disconnect", () => {
  disconnected = true;
  void stop();
});
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.stdout.on("error", () => void stop());
process.stderr.on("error", () => void stop());
process.on("message", (packet: unknown) => {
  if (!packet || typeof packet !== "object" || finishing) return;
  const value = packet as Record<string, unknown>;
  if (value.type === "stop") {
    void stop();
    return;
  }
  if (value.type === "init" && !peer) {
    const launch = value.launch as
      | {
          command?: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
          executionLockPath?: string;
        }
      | undefined;
    if (
      !launch ||
      typeof launch.command !== "string" ||
      !Array.isArray(launch.args) ||
      typeof launch.cwd !== "string" ||
      !launch.env ||
      typeof launch.executionLockPath !== "string"
    ) {
      send({ type: "failure", code: "BACKEND_PROCESS_START_FAILED" });
      void stop();
      return;
    }
    try {
      lock = acquireExecutionLock(launch.executionLockPath);
      peer = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      peer.stdout.on("data", (bytes: Buffer) => forward("stdout", bytes));
      peer.stderr.on("data", (bytes: Buffer) => forward("stderr", bytes));
      peer.stdin.on("error", () => {
        send({ type: "failure", code: "BACKEND_PIPE_CLOSED" });
        void stop();
      });
      peer.on("error", () => {
        send({ type: "failure", code: "BACKEND_PROCESS_START_FAILED" });
        void stop();
      });
      peer.once("spawn", () => {
        try {
          if (peer?.pid === undefined) throw new Error();
          lock?.recordGroup(peer.pid);
          send({ type: "started", pid: peer.pid });
          if (disconnected) void stop();
        } catch {
          send({ type: "failure", code: "BACKEND_PROCESS_START_FAILED" });
          void stop();
        }
      });
      peer.once("exit", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
      });
      peer.once("close", (code, signal) => {
        closed = true;
        exitCode = code;
        exitSignal = signal;
        if (!finishing) {
          // Even an orderly leader exit can leave descendants in the group.
          void stop();
        }
      });
    } catch {
      send({ type: "failure", code: "BACKEND_PROCESS_START_FAILED" });
      void stop();
    }
    return;
  }
  if (
    value.type === "write" &&
    peer &&
    Number.isSafeInteger(value.ordinal) &&
    typeof value.text === "string" &&
    Buffer.byteLength(value.text) <= 65_537 &&
    !writing
  ) {
    writing = true;
    peer.stdin.write(value.text, (error) => {
      writing = false;
      if (error) {
        send({ type: "failure", code: "BACKEND_PIPE_WRITE_FAILED" });
        void stop();
      } else
        send({
          type: "written",
          ordinal: value.ordinal,
          bytes: Buffer.byteLength(value.text as string),
        });
    });
  } else if (value.type === "write") {
    send({ type: "failure", code: "BACKEND_PIPE_WRITE_FAILED" });
    void stop();
  }
});
if (disconnected) void stop();
