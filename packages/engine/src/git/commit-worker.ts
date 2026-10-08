/** Root-owned supervisor. IPC disconnect cancels the entire Git/hook process group. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireExecutionLock,
  type ExecutionLock,
} from "../tools/command/execution-lock.js";
import {
  cleanupGroup,
  groupExists,
  createCommandEnvironment,
} from "../tools/command/process-control.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  repositoryPin,
  fileBytes,
  inspectCommit,
  indexProjection,
} from "./commit-preview.js";
import {
  gitSha,
  type GitCommitPreview,
  type GitCommitOutcome,
} from "./types.js";
interface Input {
  preview: GitCommitPreview;
  executionLockPath: string;
  artifactDir: string;
}
let input: Input | undefined,
  lock: ExecutionLock | undefined,
  running = false,
  stopped = false,
  group: number | null = null,
  controller = new AbortController();
const send = (message: object) => {
  if (process.connected) process.send?.(message);
};
process.on("disconnect", () => {
  stopped = true;
  controller.abort();
  if (!running) {
    lock?.release(true);
    process.exit(0);
  }
});
process.on("message", (message: any) => {
  if (message?.type === "init" && !input) {
    input = message.input;
    try {
      lock = acquireExecutionLock(input!.executionLockPath);
      send({ type: "ready", supervisorPid: process.pid });
    } catch {
      send({ type: "init-failed" });
      process.exit(1);
    }
  } else if (message?.type === "stop") {
    stopped = true;
    controller.abort();
    if (!running) {
      lock?.release(true);
      process.disconnect?.();
    }
  } else if (message?.type === "start" && input && !running) {
    running = true;
    void execute(input).then(
      (outcome) => {
        try {
          lock?.release(outcome.cleanupConfirmed);
        } catch {
          outcome.cleanupConfirmed = false;
          outcome.errorCode = "GIT_COMMIT_LOCK_UNCERTAIN";
        }
        send({ type: "result", outcome });
        process.disconnect?.();
      },
      () => {
        try {
          lock?.release(false);
        } catch {}
        send({ type: "lost" });
        process.disconnect?.();
      },
    );
  }
});
async function execute(i: Input): Promise<GitCommitOutcome> {
  const p = i.preview,
    root = p.repository.root,
    start = Date.now();
  let dir = "",
    stdout = "",
    stderr = "",
    cancelled = false,
    timedOut = false,
    cleanup = true,
    started = false,
    exitCode: number | null = null,
    signal: string | null = null,
    errorCode: string | null = null,
    commitPid: number | null = null,
    observedBytes = 0;
  async function git(
    args: string[],
    stdin?: Buffer,
    commit = false,
    realIndex = false,
  ): Promise<number> {
    if (controller.signal.aborted) throw Error("cancelled");
    const env = createCommandEnvironment();
    for (const k of Object.keys(env))
      if (k.toUpperCase().startsWith("GIT_")) delete env[k];
    Object.assign(env, {
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      ...(realIndex ? {} : { GIT_INDEX_FILE: join(dir, "index") }),
    });
    const child = spawn(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        root,
        ...args,
      ],
      { env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let closed = false,
      stopping: Promise<boolean> | undefined;
    const stop = () => {
      if (!stopping)
        stopping = child.pid
          ? cleanupGroup(child.pid, () => closed)
          : Promise.resolve(closed);
    };
    if (child.pid) {
      group = child.pid;
      lock!.recordGroup(group);
      if (commit) {
        started = true;
        commitPid = group;
        send({ type: "started", pid: group });
      }
    }
    const timer = setTimeout(
        () => {
          timedOut = true;
          stop();
        },
        Math.max(1, p.timeoutMs - (Date.now() - start)),
      ),
      abort = () => {
        cancelled = true;
        stop();
      };
    controller.signal.addEventListener("abort", abort, { once: true });
    const output = (stream: "stdout" | "stderr", b: Buffer) => {
      observedBytes += b.length;
      if (observedBytes > p.maxOutputBytes) {
        errorCode = "GIT_COMMIT_OUTPUT_LIMIT";
        stop();
        return;
      }
      if (stream === "stdout") stdout += b.toString("utf8");
      else stderr += b.toString("utf8");
    };
    child.stdout.on("data", (b: Buffer) => output("stdout", b));
    child.stderr.on("data", (b: Buffer) => output("stderr", b));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    await new Promise<void>((resolve) => {
      child.once("error", () => {
        errorCode = "GIT_COMMIT_SPAWN_FAILED";
      });
      child.once("close", (code, sig) => {
        closed = true;
        if (commit) {
          exitCode = code;
          signal = sig;
        }
        resolve();
      });
    });
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
    if (child.pid && groupExists(child.pid)) stop();
    if (stopping) cleanup = (await stopping) && cleanup;
    if (child.pid && groupExists(child.pid)) cleanup = false;
    group = null;
    if (cancelled || timedOut || errorCode || !cleanup) throw Error("stopped");
    return commit ? (exitCode ?? 1) : (child.exitCode ?? 1);
  }
  try {
    dir = await mkdtemp(join(i.artifactDir, "git-commit-"));
    const actual = await repositoryPin(root, controller.signal);
    if (knowledgeHash(actual) !== knowledgeHash(p.repository))
      throw Error("stale");
    for (const e of p.entries) {
      const b = await fileBytes(root, e.path);
      if ((b === null ? null : gitSha(b)) !== e.fileSha256)
        throw Error("stale");
    }
    if ((await git(["read-tree", p.repository.head])) !== 0)
      throw Error("prepare");
    for (const e of p.entries)
      if (p.selection === "working-tree" && e.oid) {
        const b = await fileBytes(root, e.path);
        if (!b || gitSha(b) !== e.fileSha256) throw Error("stale");
        const old = stdout;
        stdout = "";
        if (
          (await git(["hash-object", "-w", "--stdin", "--no-filters"], b)) !==
            0 ||
          stdout.trim() !== e.oid
        )
          throw Error("prepare");
        stdout = old;
      }
    const updates = Buffer.from(
      p.entries
        .map(
          (e) =>
            `${e.oid ? e.mode : "0"} ${e.oid ?? "0".repeat(p.repository.head.length)}\t${e.path}\0`,
        )
        .join(""),
    );
    if ((await git(["update-index", "-z", "--index-info"], updates)) !== 0)
      throw Error("prepare");
    if (
      knowledgeHash(await repositoryPin(root, controller.signal)) !==
      knowledgeHash(p.repository)
    )
      throw Error("stale");
    await writeFile(join(dir, "message"), p.message, { mode: 0o600 });
    await git(
      [
        "commit",
        "--no-gpg-sign",
        "--cleanup=verbatim",
        "--file",
        join(dir, "message"),
      ],
      undefined,
      true,
    );
    if (p.selection === "working-tree") {
      const committed = await inspectCommit(root);
      if (
        committed.parent !== p.repository.head ||
        committed.tree !== p.expectedTree ||
        committed.message !== p.message ||
        (await repositoryPin(root)).indexSha256 !== p.repository.indexSha256
      )
        throw Error("stale");
      if (
        (await git(
          ["update-index", "-z", "--index-info"],
          updates,
          false,
          true,
        )) !== 0
      )
        throw Error("index");
    }
  } catch (e) {
    errorCode ??= timedOut
      ? "GIT_COMMIT_TIMEOUT"
      : cancelled || stopped
        ? "CANCELLED"
        : started
          ? "GIT_COMMIT_FAILED"
          : String(e).includes("stale")
            ? "GIT_COMMIT_STALE"
            : "GIT_COMMIT_PREPARE_FAILED";
  }
  let indexAfterProjectionSha256: string | null = null;
  try {
    indexAfterProjectionSha256 = await indexProjection(root);
  } catch {
    errorCode ??= "GIT_COMMIT_CHECKPOINT_FAILED";
  }
  let afterRepository: Awaited<ReturnType<typeof repositoryPin>> | null = null;
  const selectedAfter: { path: string; fileSha256: string | null }[] = [];
  try {
    afterRepository = await repositoryPin(root);
    for (const e of p.entries) {
      const bytes = await fileBytes(root, e.path);
      selectedAfter.push({
        path: e.path,
        fileSha256: bytes === null ? null : gitSha(bytes),
      });
    }
  } catch {
    errorCode ??= "GIT_COMMIT_CHECKPOINT_FAILED";
  }
  let actual: Awaited<ReturnType<typeof inspectCommit>> | null = null;
  try {
    actual = await inspectCommit(root);
  } catch {
    errorCode ??= "GIT_COMMIT_OBSERVATION_FAILED";
  }
  if (dir)
    await rm(dir, { recursive: true, force: true }).catch(() => {
      errorCode ??= "GIT_COMMIT_ARTIFACT_CLEANUP_FAILED";
    });
  return {
    exitCode,
    signal,
    cancelled,
    timedOut,
    cleanupConfirmed: cleanup,
    started,
    groupPid: commitPid,
    supervisorPid: process.pid,
    indexAfterSha256: afterRepository?.indexSha256 ?? null,
    indexAfterProjectionSha256,
    selectedAfter,
    stdout,
    stderr,
    beforeHead: p.repository.head,
    afterHead: actual?.head ?? null,
    parent: actual?.parent ?? null,
    tree: actual?.tree ?? null,
    message: actual?.message ?? null,
    errorCode,
  };
}
