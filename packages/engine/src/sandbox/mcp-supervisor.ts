import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cleanupGroup } from "../tools/command/process-control.js";
/** Root's IPC lifetime owns the real restricted server and every descendant. No workspace or DB I/O here. */
let child: ChildProcessWithoutNullStreams | undefined;
let started = false,
  stopped = false,
  exitCode: number | null = null;
const send = (value: object) => {
  try {
    if (process.connected) process.send?.(value);
  } catch {}
};
let finishPromise: Promise<void> | undefined;
function finish() {
  return (finishPromise ??= (async () => {
    stopped = true;
    const pid = child?.pid;
    const cleanupConfirmed = pid ? await cleanupGroup(pid) : !started;
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    send({ type: "result", outcome: { exitCode, cleanupConfirmed, started } });
    process.stdin.destroy();
    process.stdout.end();
    process.stderr.end();
    setTimeout(() => process.exit(cleanupConfirmed ? 0 : 1), 50);
  })().catch(() => {
    send({
      type: "result",
      outcome: { exitCode, cleanupConfirmed: false, started },
    });
    process.exit(1);
  }));
}
process.on("disconnect", () => {
  void finish();
});
process.on("SIGTERM", () => {
  void finish();
});
process.on("SIGINT", () => {
  void finish();
});
process.on("message", (value: unknown) => {
  if (!value || typeof value !== "object") return;
  const p = value as {
    type?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    profile?: string;
  };
  if (p.type === "stop") {
    void finish();
    return;
  }
  if (
    p.type !== "init" ||
    started ||
    stopped ||
    typeof p.command !== "string" ||
    typeof p.cwd !== "string" ||
    typeof p.profile !== "string" ||
    !Array.isArray(p.args) ||
    p.args.length > 64 ||
    p.args.some(
      (a) =>
        typeof a !== "string" ||
        Buffer.byteLength(a) > 8192 ||
        a.includes("\0"),
    ) ||
    Buffer.byteLength(p.profile) > 32768
  )
    return;
  if (!process.connected) {
    void finish();
    return;
  }
  started = true;
  child = spawn(
    "/usr/bin/sandbox-exec",
    ["-p", p.profile, p.command, ...p.args],
    {
      cwd: p.cwd,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: p.cwd,
        LANG: "en_US.UTF-8",
      },
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const effect = child;
  process.stdin.pipe(effect.stdin);
  effect.stdout.pipe(process.stdout, { end: false });
  effect.stderr.pipe(process.stderr, { end: false });
  effect.stdin.on("error", () => {
    void finish();
  });
  effect.once("spawn", () => {
    send({ type: "started", pid: effect.pid });
  });
  effect.once("error", () => {
    void finish();
  });
  effect.once("exit", (code) => {
    exitCode = code;
    void finish();
  });
  effect.stdout.once("end", () => {
    void finish();
  });
});
if (!process.connected) void finish();
