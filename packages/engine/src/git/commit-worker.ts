/** Root-owned supervisor. IPC disconnect cancels the entire Git/hook process group. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireExecutionLock,
  type ExecutionLock,
} from "../tools/command/execution-lock.js";
import { cleanupGroup, groupExists } from "../tools/command/process-control.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { NO_AUTO_MAINTENANCE } from "../worktrees/safe-checkout.js";
import {
  repositoryPin,
  fileBytes,
  fileSha,
  inspectCommit,
  indexProjection,
} from "./commit-preview.js";
import {
  gitSha,
  gitFreeEnvironment,
  GIT_COMMIT_LIMITS,
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
class StaleError extends Error {}
const send = (message: object) => {
  if (process.connected) process.send?.(message);
};
/** Receipt fields outside the preview and outcome, plus later outcome error codes. */
const RECEIPT_RESERVE_BYTES = 2048;
const escapedBytes = (text: string) =>
  Buffer.byteLength(JSON.stringify(text)) - 2;
/** Keeps output within `room` JSON-escaped bytes so the receipt passes commitJson. */
function retain(text: string, room: number): string {
  const clean = text.replaceAll("\0", "");
  if (escapedBytes(clean) <= room) return clean;
  let kept = "";
  for (const ch of clean) {
    room -= escapedBytes(ch);
    if (room < 0) break;
    kept += ch;
  }
  return kept;
}
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
      send({ type: "ready" });
    } catch {
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
  /** Returns the call's own stdout; `capture` also keeps it out of the outcome. */
  async function git(
    args: string[],
    options: {
      stdin?: Buffer;
      commit?: boolean;
      realIndex?: boolean;
      capture?: boolean;
    } = {},
  ): Promise<{ code: number; stdout: string }> {
    if (controller.signal.aborted) throw Error("cancelled");
    const {
      stdin,
      commit = false,
      realIndex = false,
      capture = false,
    } = options;
    const env = Object.assign(gitFreeEnvironment(), {
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
        ...NO_AUTO_MAINTENANCE,
        "-C",
        root,
        ...args,
      ],
      { env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let closed = false,
      own = "",
      stopping: Promise<boolean> | undefined;
    const stop = () => {
      if (!stopping)
        stopping = child.pid
          ? cleanupGroup(child.pid, () => closed)
          : Promise.resolve(closed);
    };
    if (child.pid) {
      group = child.pid;
      try {
        lock!.recordGroup(group);
      } catch {
        cleanup = false;
        stop();
      }
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
      const text = b.toString("utf8");
      if (stream === "stderr") stderr += text;
      else {
        own += text;
        if (!capture) stdout += text;
      }
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
    return {
      code: commit ? (exitCode ?? 1) : (child.exitCode ?? 1),
      stdout: own,
    };
  }
  async function gitText(args: string[], stdin?: Buffer) {
    const r = await git(args, { stdin, capture: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }
  try {
    dir = await mkdtemp(join(i.artifactDir, "git-commit-"));
    const actual = await repositoryPin(root, controller.signal);
    if (knowledgeHash(actual) !== knowledgeHash(p.repository))
      throw new StaleError();
    for (const e of p.entries)
      if ((await fileSha(root, e.path)) !== e.fileSha256)
        throw new StaleError();
    if ((await git(["read-tree", p.repository.head])).code !== 0)
      throw Error("prepare");
    for (const e of p.entries)
      if (p.selection === "working-tree" && e.oid) {
        const b = await fileBytes(root, e.path);
        if (!b || gitSha(b) !== e.fileSha256) throw new StaleError();
        if (
          (await gitText(
            ["hash-object", "-w", "--stdin", "--no-filters"],
            b,
          )) !== e.oid
        )
          throw Error("prepare");
      }
    const updates = Buffer.from(
      p.entries
        .map(
          (e) =>
            `${e.oid ? e.mode : "0"} ${e.oid ?? "0".repeat(p.repository.head.length)}\t${e.path}\0`,
        )
        .join(""),
    );
    if (
      (await git(["update-index", "-z", "--index-info"], { stdin: updates }))
        .code !== 0
    )
      throw Error("prepare");
    if ((await gitText(["write-tree"])) !== p.expectedTree)
      throw new StaleError();
    if (
      knowledgeHash(await repositoryPin(root, controller.signal)) !==
      knowledgeHash(p.repository)
    )
      throw new StaleError();
    await writeFile(join(dir, "message"), p.message, { mode: 0o600 });
    await git(
      [
        "commit",
        "--no-gpg-sign",
        "--cleanup=verbatim",
        "--file",
        join(dir, "message"),
      ],
      { commit: true },
    );
    if (p.selection === "working-tree") {
      const committed = await inspectCommit(root);
      if (
        committed.parent !== p.repository.head ||
        committed.tree !== p.expectedTree ||
        committed.message !== p.message ||
        (await repositoryPin(root)).indexSha256 !== p.repository.indexSha256
      )
        throw new StaleError();
      if (
        (
          await git(["update-index", "-z", "--index-info"], {
            stdin: updates,
            realIndex: true,
          })
        ).code !== 0
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
          : e instanceof StaleError
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
    for (const e of p.entries)
      selectedAfter.push({
        path: e.path,
        fileSha256: await fileSha(root, e.path),
      });
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
  const outcome: GitCommitOutcome = {
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
    stdout: "",
    stderr: "",
    beforeHead: p.repository.head,
    afterHead: actual?.head ?? null,
    parent: actual?.parent ?? null,
    tree: actual?.tree ?? null,
    message: actual?.message ?? null,
    errorCode,
  };
  let room = Math.min(
    p.maxOutputBytes,
    GIT_COMMIT_LIMITS.recordBytes -
      RECEIPT_RESERVE_BYTES -
      Buffer.byteLength(JSON.stringify({ preview: p, outcome })),
  );
  outcome.stdout = retain(stdout, room);
  room -= escapedBytes(outcome.stdout);
  outcome.stderr = retain(stderr, room);
  return outcome;
}
