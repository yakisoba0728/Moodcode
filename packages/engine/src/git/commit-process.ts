import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  gitCommitError,
  gitFreeEnvironment,
  type GitCommitPreview,
  type GitCommitOutcome,
} from "./types.js";
export interface OwnedGitProcess {
  readonly supervisorPid: number;
  start(): Promise<GitCommitOutcome>;
  stopAndJoin(): Promise<void>;
}
export async function openGitCommitProcess(
  preview: GitCommitPreview,
  executionLockPath: string,
  artifactDir: string,
  signal: AbortSignal,
  onStarted: (pid: number) => void,
): Promise<OwnedGitProcess> {
  const module = fileURLToPath(
    new URL(
      `./commit-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url,
    ),
  );
  const execArgv = import.meta.url.endsWith(".ts")
    ? ["--import", fileURLToPath(import.meta.resolve("tsx"))]
    : [];
  const child = fork(module, [], {
    cwd: artifactDir,
    env: gitFreeEnvironment(),
    execArgv,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let settled = false,
    ready = false,
    result: GitCommitOutcome | undefined,
    closed = false,
    observationFailure = false;
  const closing = Promise.withResolvers<void>(),
    readiness = Promise.withResolvers<void>(),
    completion = Promise.withResolvers<GitCommitOutcome>();
  void completion.promise.catch(() => {});
  const stop = () => {
    if (child.connected) child.send({ type: "stop" });
  };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    stop();
    if (!ready)
      readiness.reject(new Error("Git supervisor admission timed out"));
  }, 5000);
  const lost = () => {
    if (closed) return;
    closed = true;
    closing.resolve();
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (!ready) readiness.reject(new Error("Git supervisor unavailable"));
    if (!settled) {
      settled = true;
      result
        ? completion.resolve({
            ...result,
            ...(observationFailure
              ? { errorCode: "GIT_COMMIT_PROCESS_RECORD_FAILED" }
              : {}),
          })
        : completion.reject(new Error("Git supervisor outcome was lost"));
    }
  };
  child.on("message", (message: any) => {
    if (message?.type === "ready") {
      ready = true;
      clearTimeout(timer);
      readiness.resolve();
    } else if (message?.type === "started") {
      try {
        onStarted(message.pid);
      } catch {
        observationFailure = true;
        stop();
      }
    } else if (message?.type === "result") {
      result = message.outcome;
    }
  });
  child.once("exit", lost);
  child.once("error", lost);
  child.send({
    type: "init",
    input: { preview, executionLockPath, artifactDir },
  });
  try {
    await readiness.promise;
  } catch {
    stop();
    await closing.promise;
    gitCommitError("GIT_COMMIT_PROCESS_UNAVAILABLE");
  }
  let started = false;
  return {
    supervisorPid: child.pid!,
    start() {
      if (started) gitCommitError("GIT_COMMIT_ALREADY_DISPATCHED");
      started = true;
      child.send({ type: "start" });
      if (signal.aborted) stop();
      return completion.promise;
    },
    async stopAndJoin() {
      stop();
      await closing.promise;
    },
  };
}
