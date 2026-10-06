import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_LIMITS, type Checkpoint } from "@moodcode/contracts";
import { SqliteStore } from "../storage/index.js";
import { openWorkspace } from "../workspace/index.js";
import { WorktreeManager } from "../worktrees/index.js";
import {
  ChildTaskManager,
  type ChildTaskHost,
  type ChildStart,
  type ChildOutcome,
} from "./index.js";
import { createChildMergeTool } from "./merge.js";
import type { ToolContext } from "../ports.js";
const fresh = () => new AbortController();
const code = (expected: string) => (e: unknown) => {
  assert.equal((e as { code: string }).code, expected);
  return true;
};
const outcome = (state: ChildOutcome["state"] = "completed"): ChildOutcome => ({
  state,
  content: "child result",
  usage: { turns: 1, toolCalls: 0, outputBytes: 12 },
});
async function fixture(t: test.TestContext, host: ChildTaskHost) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moodcode-child-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  await writeFile(join(repo, "a"), "base");
  execFileSync("git", ["-C", repo, "add", "a"]);
  execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);
  const store = new SqliteStore(join(root, "state.sqlite"));
  const workspace = await openWorkspace(repo);
  store.putWorkspace(workspace);
  store.createSession({
    id: "s",
    workspaceId: workspace.id,
    title: "fixture",
    createdAt: new Date().toISOString(),
  });
  const worktrees = new WorktreeManager({
    directory: join(root, "managed"),
    documents: store,
  });
  const worktree = await worktrees.create(
    { sessionId: "s", requestId: "wt", workspace },
    fresh().signal,
  );
  const manager = new ChildTaskManager({
    documents: store,
    worktrees,
    host,
    cleanupTimeoutMs: 30,
  });
  t.after(async () => {
    await manager.close().catch(() => {});
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const input: ChildStart = {
    sessionId: "s",
    requestId: "child",
    parentRunId: "parent",
    worktreeId: worktree.id,
    prompt: "fixture task",
    allowedTools: ["read_file", "patch_files"],
    requestedTools: ["read_file"],
    remainingBudget: {
      turns: 4,
      toolCalls: 4,
      outputBytes: 1024,
      durationMs: 10_000,
    },
    allocation: { turns: 2, toolCalls: 2, outputBytes: 512, durationMs: 4000 },
  };
  return { root, repo, store, workspace, worktrees, worktree, manager, input };
}
function completedHost(): ChildTaskHost {
  return {
    async start({ task }) {
      return {
        runId: `run_${task.id}`,
        async wait() {
          return outcome();
        },
        async cancel() {},
      };
    },
    async acceptResult() {
      return { inputId: "input-result" };
    },
  };
}
test("child dispatch reserves bounded parent authority and durable request id avoids duplicate execution", async (t) => {
  let calls = 0;
  const host = completedHost();
  const original = host.start;
  host.start = async (request) => {
    calls++;
    assert.deepEqual(request.task.toolNames, ["read_file"]);
    assert.equal(request.task.budget.turns, 2);
    assert.notEqual(request.workspace.root, request.task.worktreeId);
    return original(request);
  };
  const { manager, input, store, worktrees } = await fixture(t, host);
  const task = await manager.start(input, fresh().signal);
  assert.equal((await manager.wait("s", task.id)).state, "completed");
  assert.equal((await manager.start(input, fresh().signal)).id, task.id);
  const restarted = new ChildTaskManager({ documents: store, worktrees, host });
  assert.equal((await restarted.start(input, fresh().signal)).id, task.id);
  assert.equal(calls, 1);
  await assert.rejects(
    restarted.start({ ...input, prompt: "changed" }, fresh().signal),
    code("CHILD_REQUEST_CONFLICT"),
  );
});
test("tool escalation and shared sibling budget overflow fail before host dispatch", async (t) => {
  let calls = 0;
  const host = completedHost();
  const start = host.start;
  host.start = async (r) => {
    calls++;
    return start(r);
  };
  const { manager, input, worktrees, workspace } = await fixture(t, host);
  await assert.rejects(
    manager.start(
      { ...input, requestedTools: ["run_command"] },
      fresh().signal,
    ),
    code("CHILD_TOOL_ESCALATION"),
  );
  const first = await manager.start(input, fresh().signal);
  await manager.wait("s", first.id);
  const secondWt = await worktrees.create(
    { sessionId: "s", requestId: "wt-2", workspace },
    fresh().signal,
  );
  const second = await manager.start(
    { ...input, requestId: "child-2", worktreeId: secondWt.id },
    fresh().signal,
  );
  await manager.wait("s", second.id);
  await assert.rejects(
    manager.start({ ...input, requestId: "child-3" }, fresh().signal),
    code("CHILD_BUDGET_EXCEEDED"),
  );
  assert.equal(calls, 2);
});
test("parent cancellation waits for owned child cancel and reports observed terminal outcome", async (t) => {
  let settle!: (v: ChildOutcome) => void;
  let cancelled = 0;
  const done = new Promise<ChildOutcome>((resolve) => {
    settle = resolve;
  });
  const host = completedHost();
  host.start = async ({ signal }) => {
    signal.addEventListener("abort", () => settle(outcome("cancelled")), {
      once: true,
    });
    return {
      runId: "owned",
      wait: () => done,
      async cancel() {
        cancelled++;
        settle(outcome("cancelled"));
      },
    };
  };
  const { manager, input } = await fixture(t, host);
  const parent = fresh();
  const task = await manager.start(input, parent.signal);
  await new Promise((resolve) => setImmediate(resolve));
  parent.abort();
  const final = await manager.wait("s", task.id);
  assert.equal(final.state, "cancelled");
  assert.ok(cancelled >= 1);
  assert.equal(final.outcome?.state, "cancelled");
});
test("non-cooperative dispatch records uncertainty and late-owned handle is still cancelled", async (t) => {
  let resolveStart!: (v: Awaited<ReturnType<ChildTaskHost["start"]>>) => void;
  let cancelled = false;
  const host = completedHost();
  host.start = () =>
    new Promise((resolve) => {
      resolveStart = resolve;
    });
  const { manager, input, worktrees, worktree } = await fixture(t, host);
  const parent = fresh();
  const task = await manager.start(input, parent.signal);
  await new Promise((resolve) => setImmediate(resolve));
  parent.abort();
  assert.equal((await manager.wait("s", task.id)).state, "uncertain");
  await assert.rejects(
    worktrees.cleanup("s", worktree.id, fresh().signal),
    code("WORKTREE_BUSY"),
  );
  await assert.rejects(manager.close(), code("CHILD_CLEANUP_UNCERTAIN"));
  resolveStart({
    runId: "late-owned",
    async cancel() {
      cancelled = true;
    },
    async wait() {
      return outcome("cancelled");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
test("result delivery retry reuses durable input id and restart never automatically dispatches", async (t) => {
  const ids: string[] = [];
  let fail = true;
  const host = completedHost();
  host.acceptResult = async (r) => {
    ids.push(r.requestId);
    if (fail) {
      fail = false;
      throw new Error("fixture receipt loss");
    }
    return { inputId: "already-admitted" };
  };
  const { manager, input, store, worktrees } = await fixture(t, host);
  const task = await manager.start(input, fresh().signal);
  await manager.wait("s", task.id);
  await assert.rejects(manager.deliver("s", task.id));
  assert.equal(manager.get("s", task.id).deliveryState, "pending");
  const restarted = new ChildTaskManager({ documents: store, worktrees, host });
  assert.equal(
    (await restarted.deliver("s", task.id)).inputId,
    "already-admitted",
  );
  await restarted.deliver("s", task.id);
  assert.deepEqual(ids, [`child-result:${task.id}`, `child-result:${task.id}`]);
  const saved = store.getSessionDocument("s", "engine.child_tasks")!;
  (saved.data.tasks as unknown as { state: string }[])[0]!.state = "running";
  store.putSessionDocument(
    "s",
    "engine.child_tasks",
    saved.revision,
    saved.data,
  );
  assert.equal(restarted.recover("s")[0]?.state, "uncertain");
});
test("child merge creates an approved preimage-checked patch and preserves conflicting parent edits", async (t) => {
  const { manager, input, worktrees, worktree, workspace, repo, root } =
    await fixture(t, completedHost());
  const task = await manager.start(input, fresh().signal);
  await manager.wait("s", task.id);
  await writeFile(join(worktree.root, "a"), "child edit");
  await writeFile(join(worktree.root, "new"), "child new");
  const checkpoints: Checkpoint[] = [];
  const context: ToolContext = {
    workspace,
    sessionId: "s",
    runId: "parent",
    toolCallId: "merge-call",
    signal: fresh().signal,
    limits: { ...DEFAULT_LIMITS },
    artifactDir: root,
    recordCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  };
  const tool = createChildMergeTool(manager, worktrees);
  await writeFile(join(repo, "a"), "parent edit");
  await assert.rejects(
    tool.prepare({ childTaskId: task.id }, context),
    code("PATCH_PREIMAGE_MISMATCH"),
  );
  assert.equal(await readFile(join(repo, "a"), "utf8"), "parent edit");
  await writeFile(join(repo, "a"), "base");
  const prepared = await tool.prepare({ childTaskId: task.id }, context);
  assert.equal(prepared.requiresApproval, true);
  assert.equal(prepared.preview.childTaskId, task.id);
  await tool.execute(prepared, context);
  assert.equal(await readFile(join(repo, "a"), "utf8"), "child edit");
  assert.equal(await readFile(join(repo, "new"), "utf8"), "child new");
  assert.equal(checkpoints[0]?.files.length, 2);
});
test("live and uncertain child owners block worktree cleanup until observed execution settles", async (t) => {
  let settle!: (outcome: ChildOutcome) => void;
  const done = new Promise<ChildOutcome>((resolve) => {
    settle = resolve;
  });
  const host = completedHost();
  host.start = async ({ task }) => ({
    runId: `run_${task.id}`,
    wait: () => done,
    async cancel() {
      settle(outcome("cancelled"));
    },
  });
  const { manager, input, worktrees, worktree } = await fixture(t, host);
  const task = await manager.start(input, fresh().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worktrees.get("s", worktree.id).ownerId, task.id);
  await assert.rejects(
    worktrees.cleanup("s", worktree.id, fresh().signal),
    code("WORKTREE_BUSY"),
  );
  settle(outcome());
  await manager.wait("s", task.id);
  assert.equal(worktrees.get("s", worktree.id).ownerId, undefined);
  await worktrees.cleanup("s", worktree.id, fresh().signal);
});
test("nested children inherit exact live parent authority and depth cap before dispatch", async (t) => {
  const settles: (() => void)[] = [];
  const host = completedHost();
  host.start = async ({ task }) => {
    let settle!: (outcome: ChildOutcome) => void;
    const done = new Promise<ChildOutcome>((resolve) => {
      settle = resolve;
    });
    const stop = () => settle(outcome("cancelled"));
    settles.push(stop);
    return {
      runId: `run_${task.id}`,
      wait: () => done,
      async cancel() {
        stop();
      },
    };
  };
  const { manager, input, workspace, worktrees } = await fixture(t, host);
  const first = await manager.start(input, fresh().signal);
  await new Promise((resolve) => setImmediate(resolve));
  const childWt = await worktrees.create(
    { sessionId: "s", requestId: "nested-wt", workspace },
    fresh().signal,
  );
  const allocated = {
    turns: 1,
    toolCalls: 0,
    outputBytes: 100,
    durationMs: 1000,
  };
  const nested: ChildStart = {
    ...input,
    requestId: "nested",
    parentTaskId: first.id,
    parentRunId: `run_${first.id}`,
    worktreeId: childWt.id,
    remainingBudget: input.allocation,
    allocation: allocated,
  };
  const second = await manager.start(nested, fresh().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.depth, 2);
  const thirdWt = await worktrees.create(
    { sessionId: "s", requestId: "third-wt", workspace },
    fresh().signal,
  );
  const thirdInput = {
    ...nested,
    requestId: "third",
    parentTaskId: second.id,
    parentRunId: `run_${second.id}`,
    worktreeId: thirdWt.id,
    remainingBudget: allocated,
  };
  const third = await manager.start(thirdInput, fresh().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(third.depth, 3);
  await assert.rejects(
    manager.start(
      {
        ...thirdInput,
        requestId: "too-deep",
        parentTaskId: third.id,
        parentRunId: `run_${third.id}`,
      },
      fresh().signal,
    ),
    code("CHILD_TASK_LIMIT"),
  );
  assert.equal(settles.length, 3);
  for (const stop of settles) stop();
  await Promise.all(
    [first, second, third].map((task) => manager.wait("s", task.id)),
  );
});
