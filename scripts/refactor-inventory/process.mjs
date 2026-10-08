import { spawn, spawnSync } from "node:child_process";
import { devNull } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const TOOL_ROOT = dirname(dirname(WORKER_PATH));

function safeEnvironment() {
  return {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export function git(root, args, timeoutMs, optional = false) {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: root,
    env: safeEnvironment(),
    encoding: "utf8",
    timeout: Math.max(1, timeoutMs),
    maxBuffer: 8388608,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    if (optional && !result.error && result.status === 128) return null;
    throw new Error(`git-${args[0]}-${result.error?.code ?? result.status}`);
  }
  return result.stdout;
}

/** Worker lifetime also bounds synchronous native compiler requests. */
export function analyze(sources, options, timeoutMs) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      cwd: TOOL_ROOT,
      env: safeEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = [];
    let bytes = 0,
      errorBytes = 0,
      failure = null;
    const stop = (reason) => {
      failure ??= reason;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Process may have exited between output and the bound check. */
      }
    };
    const timer = setTimeout(
      () => stop("ast-worker-timeout"),
      Math.max(1, timeoutMs),
    );
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > options.maxReportBytes) stop("ast-worker-output-bound");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes > 4096) stop("ast-worker-stderr-bound");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`ast-worker-${error.code}`));
    });
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        reject(new Error(failure ?? `ast-worker-exit-${code}`));
      } else {
        try {
          accept(JSON.parse(Buffer.concat(output).toString("utf8")));
        } catch {
          reject(new Error("ast-worker-invalid-json"));
        }
      }
    });
    child.stdin.end(
      JSON.stringify({ sources, timeoutMs: Math.max(1, timeoutMs - 25) }),
    );
  });
}
