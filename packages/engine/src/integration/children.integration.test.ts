import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEngine, type EngineOptions } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
import { EngineError } from "@moodcode/contracts";
import type { ChildBudget } from "../child-tasks/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "child condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function releaseOrAbort(
  release: ReturnType<typeof deferred>,
  signal: AbortSignal,
) {
  let abort!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    abort = resolve;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([release.promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function sameConsumableBudget(actual: ChildBudget, expected: ChildBudget) {
  for (const key of ["turns", "toolCalls", "outputBytes"] as const)
    assert.equal(actual[key], expected[key], `Unexpected ${key} reservation`);
}
async function fixture(
  t: test.TestContext,
  provider: ProviderAdapter,
  options: Partial<EngineOptions> = {},
) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-real-children-")),
    ),
    repository = join(root, "repo");
  await mkdir(repository);
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(repository, "file.txt"), "before\n");
  execFileSync("git", ["-C", repository, "add", "file.txt"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const engine = createEngine({
    ...options,
    dbPath: join(root, "engine.sqlite"),
    providers: [provider],
    defaults: { providerId: provider.id, modelId: "fixture", mode: "build" },
  });
  t.after(async () => {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await engine.dispatch({
    schemaVersion: 1,
    commandId: "open",
    type: "workspace.open",
    payload: { path: repository },
  });
  assert.equal(workspace.ok, true);
  const session = await engine.dispatch({
    schemaVersion: 1,
    commandId: "session",
    type: "session.create",
    payload: { workspaceId: (workspace.result as { id: string }).id },
  });
  assert.equal(session.ok, true);
  return {
    engine,
    root,
    repository,
    sessionId: (session.result as { id: string }).id,
  };
}
test("actual isolated child inherits profile, consumes parent reservation, joins duplicate request and delivers one durable input", async (t) => {
  const release = deferred(),
    childEntered = deferred(),
    parentEntered = deferred();
  let children = 0;
  const provider: ProviderAdapter = {
    id: "fixture",
    async *streamTurn(request) {
      if (request.messages.some((message) => message.content === "parent")) {
        parentEntered.resolve();
        yield { type: "progress" };
        await release.promise;
      } else {
        children++;
        childEntered.resolve();
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ["read_file"],
        );
        assert.ok(
          request.messages.some(
            (message) => message.content === "Observe current files.",
          ),
        );
      }
      yield { type: "text.delta", delta: "Observed fixture task." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const f = await fixture(t, provider, {
    agentProfiles: [
      {
        id: "review",
        description: "review",
        instructions: "Observe current files.",
        tools: ["read_file"],
        turnAllowance: 8,
      },
    ],
  });
  t.after(release.resolve);
  const worktree = await f.engine.createWorktree(f.sessionId, "prepare");
  const submitted = await f.engine.dispatchSession({
    schemaVersion: 2,
    commandId: "parent",
    type: "input.accept",
    payload: {
      sessionId: f.sessionId,
      requestId: "parent",
      prompt: "parent",
      delivery: "queue",
      config: { agentProfileId: "review" },
    },
  });
  assert.equal(submitted.ok, true);
  await until(() =>
    f.engine.store
      .getSnapshot(f.sessionId)
      .runs.some((run) => run.state === "running"),
  );
  await parentEntered.promise;
  const parent = f.engine.store.getSnapshot(f.sessionId).runs[0]!,
    before = f.engine.coordinator.getRemainingChildBudget(parent.id);
  const request = {
    sessionId: f.sessionId,
    requestId: "child",
    parentRunId: parent.id,
    worktreeId: worktree.id,
    prompt: "child",
    tools: ["read_file"],
    allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 },
  };
  const [one, duplicate] = await Promise.all([
    f.engine.startChildTask(request),
    f.engine.startChildTask(request),
  ]);
  assert.equal(one.id, duplicate.id);
  await childEntered.promise;
  const outcome = await f.engine.children.tasks.wait(f.sessionId, one.id);
  assert.equal(outcome.state, "completed");
  assert.equal(children, 1);
  const after = f.engine.coordinator.getRemainingChildBudget(parent.id);
  assert.equal(after.turns, before.turns - 2);
  assert.equal(after.toolCalls, before.toolCalls - 1);
  assert.equal(after.outputBytes, before.outputBytes - 4096);
  await assert.rejects(
    f.engine.startChildTask({ ...request, tools: ["run_command"] }),
    (error: unknown) =>
      error instanceof EngineError && error.code === "CHILD_REQUEST_CONFLICT",
  );
  f.engine.scheduler.pause(f.sessionId);
  const [delivery, repeated] = await Promise.all([
    f.engine.children.tasks.deliver(f.sessionId, one.id),
    f.engine.children.tasks.deliver(f.sessionId, one.id),
  ]);
  assert.equal(delivery.inputId, repeated.inputId);
  const pending = f.engine.store.pendingInputs(f.sessionId, undefined, 10);
  assert.equal(pending.length, 1);
  assert.ok(pending[0]!.prompt.startsWith("[Moodcode child observation v1]"));
  assert.equal(
    await readFile(join(f.repository, "file.txt"), "utf8"),
    "before\n",
  );
  release.resolve();
  assert.equal((await f.engine.waitForRun(parent.id)).state, "completed");
  const usage = f.engine.coordinator.getRunUsage(parent.id);
  assert.equal(usage.turns, 1);
  assert.equal(usage.toolCalls, 0);
});
test("parent cancellation aborts the actual child provider and releases its worktree only after cleanup", async (t) => {
  const childEntered = deferred();
  let childAborted = false;
  const provider: ProviderAdapter = {
    id: "fixture",
    async *streamTurn(request, signal) {
      const child = request.messages.some(
        (message) => message.content === "child",
      );
      yield { type: "progress" };
      await new Promise<void>((resolve) => {
        const abort = () => {
          if (child) childAborted = true;
          resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        if (child) childEntered.resolve();
      });
    },
  };
  const f = await fixture(t, provider),
    worktree = await f.engine.createWorktree(f.sessionId, "prepare");
  const receipt = f.engine.scheduler.submitLegacy({
    sessionId: f.sessionId,
    requestId: "parent",
    prompt: "parent",
    config: f.engine.getCapabilities().defaults,
  });
  await until(() => f.engine.store.getRun(receipt.runId).state === "running");
  const child = await f.engine.startChildTask({
    sessionId: f.sessionId,
    requestId: "child",
    parentRunId: receipt.runId,
    worktreeId: worktree.id,
    prompt: "child",
    tools: ["read_file"],
    allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 },
  });
  await childEntered.promise;
  f.engine.coordinator.cancel(receipt.runId);
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, "cancelled");
  const outcome = await f.engine.children.tasks.wait(f.sessionId, child.id);
  assert.equal(outcome.state, "cancelled");
  assert.equal(childAborted, true);
  assert.equal(
    f.engine.children.worktrees.get(f.sessionId, worktree.id).ownerId,
    undefined,
  );
  assert.ok(f.engine.store.getSessionControl(f.sessionId).paused);
});

test("actual invalid worktree and oversized prompt admissions consume no parent allocation or provider dispatch", async (t) => {
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const provider: ProviderAdapter = {
    id: "fixture",
    async *streamTurn(_request, signal) {
      calls++;
      entered.resolve();
      yield { type: "progress" };
      await releaseOrAbort(release, signal);
      yield { type: "finish", reason: "stop" };
    },
  };
  const f = await fixture(t, provider),
    worktree = await f.engine.createWorktree(f.sessionId, "prepared");
  t.after(release.resolve);
  const receipt = f.engine.scheduler.submitLegacy({
    sessionId: f.sessionId,
    requestId: "parent",
    prompt: "parent",
    config: f.engine.getCapabilities().defaults,
  });
  await entered.promise;
  const request = {
    sessionId: f.sessionId,
    parentRunId: receipt.runId,
    requestId: "bad-worktree",
    worktreeId: "missing-worktree",
    prompt: "child",
    tools: ["read_file"],
    allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 },
  };
  for (const [value, errorCode] of [
    [request, "WORKTREE_NOT_FOUND"],
    [
      {
        ...request,
        requestId: "oversized",
        worktreeId: worktree.id,
        prompt: "x".repeat(32769),
      },
      "INVALID_CHILD_INPUT",
    ],
  ] as const) {
    const started = Date.now(),
      before = f.engine.coordinator.getRemainingChildBudget(receipt.runId);
    await assert.rejects(
      f.engine.startChildTask(value),
      (error) => error instanceof EngineError && error.code === errorCode,
    );
    const after = f.engine.coordinator.getRemainingChildBudget(receipt.runId);
    sameConsumableBudget(after, before);
    assert.ok(after.durationMs <= before.durationMs);
    assert.ok(
      after.durationMs >= before.durationMs - (Date.now() - started) - 25,
      "Only elapsed wall clock time may reduce duration",
    );
  }
  assert.equal(calls, 1);
  assert.equal(f.engine.children.tasks.list(f.sessionId).length, 0);
  assert.equal(
    f.engine.children.worktrees.get(f.sessionId, worktree.id).ownerId,
    undefined,
  );
  assert.equal(
    f.engine.store.getSessionDocument(f.sessionId, "engine.child_tasks"),
    null,
  );
  release.resolve();
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
});

test("actual child can split a full parent allocation and deliver grandchild results after its own engine closes", async (t) => {
  const parentEntered = deferred(),
    childEntered = deferred(),
    parentRelease = deferred(),
    childRelease = deferred();
  const calls = { parent: 0, child: 0, grandchild: 0 };
  const provider: ProviderAdapter = {
    id: "fixture",
    async *streamTurn(request, signal) {
      const prompt = request.messages.findLast(
        (message) => message.role === "user",
      )?.content;
      if (prompt === "parent") {
        calls.parent++;
        parentEntered.resolve();
        yield { type: "progress" };
        await releaseOrAbort(parentRelease, signal);
      } else if (prompt === "child") {
        calls.child++;
        childEntered.resolve();
        yield { type: "progress" };
        await releaseOrAbort(childRelease, signal);
        yield { type: "text.delta", delta: "Child settled." };
      } else if (prompt === "grandchild") {
        calls.grandchild++;
        yield { type: "text.delta", delta: "Grandchild observation." };
      } else assert.fail(`Unexpected provider input ${prompt}`);
      yield { type: "finish", reason: "stop" };
    },
  };
  const f = await fixture(t, provider),
    childWorktree = await f.engine.createWorktree(
      f.sessionId,
      "child-worktree",
    );
  const grandchildWorktree = await f.engine.prepareChildWorktree(
    f.sessionId,
    childWorktree.id,
    "grandchild-worktree",
  );
  assert.equal(grandchildWorktree.baseRoot, childWorktree.root);
  t.after(parentRelease.resolve);
  t.after(childRelease.resolve);
  const receipt = f.engine.scheduler.submitLegacy({
    sessionId: f.sessionId,
    requestId: "parent",
    prompt: "parent",
    config: f.engine.getCapabilities().defaults,
  });
  await parentEntered.promise;
  const before = f.engine.coordinator.getRemainingChildBudget(receipt.runId);
  // Allocate every consumable unit. Wall-clock duration keeps headroom for the
  // asynchronous worktree verification before live parent reservation.
  const allocation = {
    ...before,
    durationMs: Math.min(15000, before.durationMs - 1000),
  };
  const child = await f.engine.startChildTask({
    sessionId: f.sessionId,
    requestId: "child",
    parentRunId: receipt.runId,
    worktreeId: childWorktree.id,
    prompt: "child",
    tools: ["read_file"],
    allocation,
  });
  await childEntered.promise;
  await until(
    () =>
      f.engine.children.tasks.get(f.sessionId, child.id).state === "running",
  );
  const actualChild = f.engine.children.tasks.get(f.sessionId, child.id);
  assert.ok(actualChild.childRunId);
  const rootReserved = f.engine.coordinator.getRemainingChildBudget(
    receipt.runId,
  );
  assert.equal(rootReserved.turns, 0);
  assert.equal(rootReserved.toolCalls, 0);
  assert.equal(rootReserved.outputBytes, 0);
  const childBefore = f.engine.children.remainingBudget(f.sessionId, child.id),
    grandchildAllocation = {
      turns: 2,
      toolCalls: 1,
      outputBytes: 1024,
      durationMs: 3000,
    };
  const grandchild = await f.engine.startChildTask({
    sessionId: f.sessionId,
    requestId: "grandchild",
    parentTaskId: child.id,
    parentRunId: actualChild.childRunId,
    worktreeId: grandchildWorktree.id,
    prompt: "grandchild",
    tools: ["read_file"],
    allocation: grandchildAllocation,
  });
  const outcome = await f.engine.children.tasks.wait(
    f.sessionId,
    grandchild.id,
  );
  assert.equal(outcome.state, "completed");
  assert.equal(outcome.depth, 2);
  assert.equal(outcome.rootRunId, receipt.runId);
  assert.equal(outcome.parentRunId, actualChild.childRunId);
  assert.equal(outcome.outcome?.content, "Grandchild observation.");
  assert.equal(outcome.outcome?.usage.turns, 1);
  const childAfter = f.engine.children.remainingBudget(f.sessionId, child.id);
  for (const key of ["turns", "toolCalls", "outputBytes"] as const)
    assert.equal(childAfter[key], childBefore[key] - grandchildAllocation[key]);
  sameConsumableBudget(
    f.engine.coordinator.getRemainingChildBudget(receipt.runId),
    rootReserved,
  );
  childRelease.resolve();
  assert.equal(
    (await f.engine.children.tasks.wait(f.sessionId, child.id)).state,
    "completed",
  );
  assert.throws(
    () => f.engine.children.remainingBudget(f.sessionId, child.id),
    (error) =>
      error instanceof EngineError && error.code === "CHILD_OWNER_UNAVAILABLE",
  );
  f.engine.scheduler.pause(f.sessionId);
  const [delivered, repeated] = await Promise.all([
    f.engine.children.tasks.deliver(f.sessionId, grandchild.id),
    f.engine.children.tasks.deliver(f.sessionId, grandchild.id),
  ]);
  assert.equal(delivered.inputId, repeated.inputId);
  assert.ok(delivered.inputId);
  const pending = f.engine.store.pendingInputs(f.sessionId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.id, delivered.inputId);
  assert.equal(pending[0]!.sessionId, f.sessionId);
  assert.deepEqual(
    pending[0]!.config,
    f.engine.store.getRun(receipt.runId).config,
  );
  assert.ok(pending[0]!.prompt.includes(grandchild.id));
  assert.ok(pending[0]!.prompt.includes("Grandchild observation."));
  assert.equal(
    f.engine.children.worktrees.get(f.sessionId, childWorktree.id).ownerId,
    undefined,
  );
  assert.equal(
    f.engine.children.worktrees.get(f.sessionId, grandchildWorktree.id).ownerId,
    undefined,
  );
  assert.deepEqual(calls, { parent: 1, child: 1, grandchild: 1 });
  parentRelease.resolve();
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
});

test("new actual child inherits the current parent path-specific denial and never observes denied file content", async (t) => {
  const parentEntered = deferred(),
    parentRelease = deferred();
  let denied = "";
  const provider: ProviderAdapter = {
    id: "fixture",
    async *streamTurn(request, signal) {
      const prompt = request.messages.findLast(
        (message) => message.role === "user",
      )?.content;
      if (prompt === "policy-parent") {
        parentEntered.resolve();
        yield { type: "progress" };
        await releaseOrAbort(parentRelease, signal);
        yield { type: "finish", reason: "stop" };
        return;
      }
      assert.equal(prompt, "policy-child");
      if (request.turnIndex === 0) {
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ["read_file"],
        );
        yield {
          type: "tool.call",
          call: {
            id: "denied-read",
            name: "read_file",
            input: { path: "file.txt" },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        denied =
          request.messages.findLast((message) => message.role === "tool")
            ?.content ?? "";
        assert.ok(denied.includes("TOOL_POLICY_DENIED"));
        assert.ok(!denied.includes("before"));
        yield {
          type: "text.delta",
          delta: "Read denied by inherited live policy.",
        };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const f = await fixture(t, provider),
    worktree = await f.engine.createWorktree(f.sessionId, "policy-worktree");
  t.after(parentRelease.resolve);
  const receipt = f.engine.scheduler.submitLegacy({
    sessionId: f.sessionId,
    requestId: "policy-parent",
    prompt: "policy-parent",
    config: f.engine.getCapabilities().defaults,
  });
  await parentEntered.promise;
  const version = f.engine.toolRuntime.policy.version;
  f.engine.toolRuntime.policy.replace([
    { tool: "read_file", resource: "path:file.txt", decision: "deny" },
  ]);
  assert.ok(f.engine.toolRuntime.policy.version > version);
  const child = await f.engine.startChildTask({
    sessionId: f.sessionId,
    requestId: "policy-child",
    parentRunId: receipt.runId,
    worktreeId: worktree.id,
    prompt: "policy-child",
    tools: ["read_file"],
    allocation: { turns: 3, toolCalls: 1, outputBytes: 4096, durationMs: 5000 },
  });
  const outcome = await f.engine.children.tasks.wait(f.sessionId, child.id);
  assert.equal(outcome.state, "completed");
  assert.equal(outcome.outcome?.usage.toolCalls, 1);
  assert.ok(denied.includes("TOOL_POLICY_DENIED"));
  assert.equal(f.engine.children.approvals(f.sessionId, child.id).length, 0);
  assert.equal(
    await readFile(join(worktree.root, "file.txt"), "utf8"),
    "before\n",
  );
  parentRelease.resolve();
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
});
