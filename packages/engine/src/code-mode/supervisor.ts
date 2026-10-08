import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cleanupGroup } from "../tools/command/process-control.js";
let worker: ChildProcessWithoutNullStreams | undefined,
  closed = false,
  finishing: Promise<void> | undefined;
let exitCode: number | null = null,
  signal: NodeJS.Signals | null = null;
const send = (value: object) => {
  if (process.connected)
    try {
      process.send?.(value);
    } catch {}
};
function stop(): Promise<void> {
  return (finishing ??= (async () => {
    worker?.stdout.resume();
    worker?.stderr.resume();
    let cleanupConfirmed = !worker;
    try {
      if (worker?.pid)
        cleanupConfirmed = await cleanupGroup(worker.pid, () => closed);
    } catch {
      cleanupConfirmed = false;
    }
    send({ type: "closed", cleanupConfirmed, exitCode, signal });
    setTimeout(() => process.exit(cleanupConfirmed ? 0 : 1), 50);
  })());
}
process.on("disconnect", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.stdout.on("error", () => void stop());
process.stderr.on("error", () => void stop());
function forward(stream: "stdout" | "stderr", bytes: Buffer): void {
  if (finishing) return;
  const source = worker?.[stream];
  if (!process[stream].write(bytes)) {
    source?.pause();
    process[stream].once("drain", () => source?.resume());
  }
}
process.on("message", (packet: unknown) => {
  if (!packet || typeof packet !== "object" || finishing) return;
  const value = packet as Record<string, any>;
  if (value.type === "stop") {
    void stop();
    return;
  }
  if (value.type === "init" && !worker) {
    try {
      if (
        typeof value.command !== "string" ||
        !Array.isArray(value.args) ||
        typeof value.cwd !== "string"
      )
        throw new Error();
      worker = spawn(value.command, value.args, {
        cwd: value.cwd,
        env: { PATH: "/usr/bin:/bin" },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      worker.stdout.on("data", (bytes: Buffer) => forward("stdout", bytes));
      worker.stderr.on("data", (bytes: Buffer) => forward("stderr", bytes));
      worker.stdin.on("error", () => void stop());
      worker.once("spawn", () => send({ type: "started", pid: worker!.pid }));
      worker.once("error", () => {
        send({ type: "failed" });
        void stop();
      });
      worker.once("close", (code, exitSignal) => {
        closed = true;
        exitCode = code;
        signal = exitSignal;
        void stop();
      });
    } catch {
      send({ type: "failed" });
      void stop();
    }
    return;
  }
  if (
    value.type === "write" &&
    worker &&
    typeof value.text === "string" &&
    Buffer.byteLength(value.text) <= 65536
  ) {
    worker.stdin.write(value.text, (error) => {
      if (error) {
        send({ type: "failed" });
        void stop();
      } else
        send({
          type: "written",
          id: value.id,
          bytes: Buffer.byteLength(value.text),
        });
    });
  }
});
