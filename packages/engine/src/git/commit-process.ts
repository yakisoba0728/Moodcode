import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCommandEnvironment } from "../tools/command/process-control.js";
import {
  gitCommitError,
  type GitCommitPreview,
  type GitCommitOutcome,
} from "./types.js";
export interface OwnedGitProcess {
  readonly supervisorPid: number;
  start(): Promise<GitCommitOutcome>;
  stop(): void;
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
  const environment = createCommandEnvironment();
  for (const key of Object.keys(environment))
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  const child = fork(module, [], {
    cwd: artifactDir,
    env: environment,
    execArgv,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let settled = false,
    ready = false,
    result: GitCommitOutcome | undefined,
    closed = false,
    resolveReady!: () => void,
    rejectReady!: (e: unknown) => void,
    resolveResult!: (v: GitCommitOutcome) => void,
    resolveClosed!: () => void,
    observationFailure = false,
    rejectResult!: (e: unknown) => void;
  const closedPromise = new Promise<void>((yes) => {
    resolveClosed = yes;
  });
  const readiness = new Promise<void>((yes, no) => {
      resolveReady = yes;
      rejectReady = no;
    }),
    completion = new Promise<GitCommitOutcome>((yes, no) => {
      resolveResult = yes;
      rejectResult = no;
    });
  void completion.catch(() => {});
  const stop = () => {
    if (child.connected) child.send({ type: "stop" });
  };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    stop();
    if (!ready) rejectReady(new Error("Git supervisor admission timed out"));
  }, 5000);
  const lost = () => {
    if (closed) return;
    closed = true;
    resolveClosed();
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (!ready) rejectReady(new Error("Git supervisor unavailable"));
    if (!settled) {
      settled = true;
      result
        ? resolveResult({
            ...result,
            ...(observationFailure
              ? { errorCode: "GIT_COMMIT_PROCESS_RECORD_FAILED" }
              : {}),
          })
        : rejectResult(new Error("Git supervisor outcome was lost"));
    }
  };
  child.on("message", (message: any) => {
    if (message?.type === "ready") {
      ready = true;
      clearTimeout(timer);
      resolveReady();
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
    await readiness;
  } catch {
    stop();
    await closedPromise;
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
      return completion;
    },
    stop,
    async stopAndJoin() {
      stop();
      await closedPromise;
    },
  };
}
