import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import type { WorkflowStartPreview } from "./host.js";
import type { WorkflowInstanceRevision } from "./reducer.js";
import type { WorkflowRequestResult, WorkflowSpecRevision } from "./store.js";
import type { WorkflowSpecInput } from "./types.js";
import {
  workflowFixture,
  workflowInvoke,
  workflowUntil,
} from "./fixtures/workflow.js";

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
type InstanceResult = WorkflowRequestResult<WorkflowInstanceRevision>;
const code =
  (...codes: string[]) =>
  (error: unknown) => {
    assert.ok(error instanceof EngineError, String(error));
    assert.ok(
      codes.includes(error.code),
      `Expected ${codes.join("/")}, received ${error.code}: ${error.message}`,
    );
    return true;
  };
function register(
  f: Fixture,
  spec: WorkflowSpecInput,
  requestId = "register",
  expectedRevision = 0,
) {
  return workflowInvoke<WorkflowRequestResult<WorkflowSpecRevision>>(
    f.engine,
    "registerWorkflow",
    { workspaceId: f.workspace.id, requestId, expectedRevision, spec },
  );
}
async function preview(
  f: Fixture,
  spec: WorkflowSpecInput,
  registered = register(f, spec),
  parameters = { question: "Observe the exact readonly source." },
) {
  const parent = await f.startParent();
  return workflowInvoke<Promise<WorkflowStartPreview>>(
    f.engine,
    "previewWorkflowStart",
    {
      workspaceId: f.workspace.id,
      rootSessionId: f.session.id,
      parentRunId: parent.runId,
      workflowId: spec.id,
      expectedSpecRevision: registered.record.revision,
      parameters,
      stageWorktrees: f.stageWorktrees(spec),
    },
  );
}
function start(
  f: Fixture,
  selected: WorkflowStartPreview,
  requestId = "start",
) {
  return workflowInvoke<InstanceResult>(f.engine, "startWorkflow", {
    workspaceId: f.workspace.id,
    requestId,
    approved: true,
    preview: selected,
  });
}
function inspect(f: Fixture, instanceId: string) {
  return workflowInvoke<WorkflowInstanceRevision>(
    f.engine,
    "inspectWorkflow",
    f.workspace.id,
    instanceId,
  );
}
function stage(
  f: Fixture,
  instance: WorkflowInstanceRevision,
  stageId = "plan",
  requestId = `start:${stageId}`,
) {
  return workflowInvoke<Promise<InstanceResult>>(
    f.engine,
    "startWorkflowStage",
    {
      workspaceId: f.workspace.id,
      instanceId: instance.instanceId,
      stageId,
      requestId,
      expectedRevision: instance.revision,
      approved: true,
    },
  );
}
function observe(
  f: Fixture,
  instance: WorkflowInstanceRevision,
  stageId = "plan",
  requestId = `observe:${stageId}`,
) {
  return workflowInvoke<Promise<InstanceResult>>(
    f.engine,
    "observeWorkflowStage",
    {
      workspaceId: f.workspace.id,
      instanceId: instance.instanceId,
      stageId,
      requestId,
      expectedRevision: instance.revision,
    },
  );
}

test(
  "workflow capability is opt-in and copied/released previews cannot approve native instances",
  { timeout: 20000 },
  async (t) => {
    const disabled = await workflowFixture(t, {
      workflows: false,
      worktreeCount: 0,
    });
    const disabledSpec = await disabled.spec(),
      beforeDisabled = disabled.counts();
    assert.throws(
      () => register(disabled, disabledSpec),
      code("WORKFLOWS_DISABLED"),
    );
    assert.deepEqual(disabled.counts(), beforeDisabled);
    const f = await workflowFixture(t),
      spec = await f.spec(),
      selected = await preview(f, spec),
      before = f.counts();
    assert.equal(selected.owner.profile, null);
    assert.equal(selected.automaticParentDelivery, false);
    assert.throws(
      () => start(f, structuredClone(selected)),
      code("WORKFLOW_PREVIEW_STALE"),
    );
    assert.throws(
      () =>
        workflowInvoke(f.engine, "startWorkflow", {
          workspaceId: f.workspace.id,
          requestId: "deny",
          approved: false,
          preview: selected,
        }),
      code("WORKFLOW_APPROVAL_REQUIRED"),
    );
    workflowInvoke(f.engine, "releaseWorkflowStartPreview", selected);
    assert.throws(() => start(f, selected), code("WORKFLOW_PREVIEW_STALE"));
    assert.deepEqual(f.counts(), before);
    assert.equal(f.children.length, 0);
  },
);

test(
  "actual readonly child result commits a native join receipt with measured usage and zero parent input",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t, { childRead: true }),
      spec = await f.spec(),
      selected = await preview(f, spec),
      parent = await f.startParent(),
      before = f.counts(),
      budget = f.engine.coordinator.getRemainingChildBudget(parent.runId);
    const created = start(f, selected),
      admitted = await stage(f, created.record),
      child = await f.waitChild();
    assert.equal(admitted.record.stages[0]!.state, "running");
    assert.equal(
      child.task.childRunId,
      admitted.record.stages[0]!.child!.childRunId,
    );
    assert.equal(child.task.parentRunId, parent.runId);
    assert.deepEqual(child.task.toolNames, ["read_file"]);
    assert.ok(
      child.child.store
        .getSnapshot(admitted.record.stages[0]!.child!.childSessionId)
        .tools.every((tool) => tool.name === "read_file"),
    );
    assert.throws(
      () =>
        workflowInvoke(child.child, "registerWorkflow", {
          workspaceId: admitted.record.stages[0]!.child!.childWorkspaceId,
          requestId: "child-inherit",
          expectedRevision: 0,
          spec,
        }),
      code("WORKFLOWS_DISABLED"),
    );
    child.release.resolve();
    const settled = await observe(f, admitted.record);
    assert.equal(settled.receipt.operation, "settle");
    assert.equal(settled.receipt.afterSha256, settled.record.sha256);
    assert.equal(settled.record.state, "completed");
    assert.deepEqual(settled.record.result, {
      observation: "Actual readonly child 0 completed.",
    });
    assert.ok(settled.record.stages[0]!.outcomeSha256);
    assert.equal(f.counts().inputs, before.inputs);
    assert.equal(f.counts().session_inputs, before.session_inputs);
    const after = f.engine.coordinator.getRemainingChildBudget(parent.runId);
    assert.equal(after.turns, budget.turns - spec.stages[0]!.allocation.turns);
    assert.equal(
      after.toolCalls,
      budget.toolCalls - spec.stages[0]!.allocation.toolCalls,
    );
    assert.equal(
      after.outputBytes,
      budget.outputBytes - spec.stages[0]!.allocation.outputBytes,
    );
    assert.equal(
      (await f.engine.children.tasks.wait(f.session.id, child.task.id)).outcome!
        .usage.toolCalls,
      1,
    );
    assert.equal(
      f.engine.children.worktrees.get(f.session.id, child.worktree.id).ownerId,
      undefined,
    );
    assert.equal(
      execFileSync(
        "git",
        ["-C", child.worktree.root, "status", "--porcelain"],
        { encoding: "utf8" },
      ),
      "",
    );
  },
);

test(
  "public start and simultaneous stage retries clone their receipts and reserve only one real child",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t),
      spec = await f.spec(),
      selected = await preview(f, spec),
      parent = await f.startParent(),
      created = start(f, selected),
      original = structuredClone(created);
    (created.record.parameters as Record<string, unknown>).question =
      "Caller mutation";
    const retry = start(f, selected);
    assert.deepEqual(retry.record, original.record);
    assert.equal(retry.duplicate, true);
    const budget = f.engine.coordinator.getRemainingChildBudget(parent.runId),
      operation = stage(f, original.record),
      duplicate = stage(f, original.record),
      [first, second] = await Promise.all([operation, duplicate]);
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(f.children.length, 1);
    assert.equal(f.engine.children.tasks.list(f.session.id).length, 1);
    const admitted = structuredClone(first),
      after = f.engine.coordinator.getRemainingChildBudget(parent.runId);
    (first.record.parameters as Record<string, unknown>).question =
      "Caller changes cached stage response";
    const third = await stage(f, original.record);
    assert.deepEqual(third.record, admitted.record);
    const afterRetry = f.engine.coordinator.getRemainingChildBudget(
      parent.runId,
    );
    for (const key of ["turns", "toolCalls", "outputBytes"] as const)
      assert.equal(afterRetry[key], after[key]);
    assert.equal(after.turns, budget.turns - spec.stages[0]!.allocation.turns);
    await assert.rejects(
      stage(f, { ...original.record, revision: original.record.revision + 1 }),
      code("WORKFLOW_REQUEST_CONFLICT"),
    );
    (await f.waitChild()).release.resolve();
    assert.equal((await observe(f, admitted.record)).record.state, "completed");
  },
);

test(
  "actual profile, model, catalogue and remaining budget reject unsupported stage escalation before dispatch",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t, { profile: true }),
      baseline = await f.spec(),
      run = await f.startParent();
    assert.ok(baseline.stages[0]!.profile);
    const cases: [
      string,
      Partial<WorkflowSpecInput["stages"][number]>,
      string,
    ][] = [
      [
        "editor",
        { role: "editor", tools: ["apply_patch"] },
        "WORKFLOW_ROLE_UNSUPPORTED",
      ],
      [
        "validator",
        { role: "validator", tools: ["read_file"] },
        "WORKFLOW_ROLE_UNSUPPORTED",
      ],
      [
        "other-model",
        {
          model: {
            providerId: baseline.stages[0]!.model.providerId,
            modelId: "other-model",
          },
        },
        "WORKFLOW_PROFILE_MODEL_UNSUPPORTED",
      ],
      [
        "other-profile",
        { profile: null },
        "WORKFLOW_PROFILE_MODEL_UNSUPPORTED",
      ],
      [
        "missing-tool",
        { tools: ["search_files"] },
        "WORKFLOW_STAGE_TOOL_ESCALATION",
      ],
      [
        "budget",
        { allocation: { ...baseline.stages[0]!.allocation, turns: 20 } },
        "WORKFLOW_BUDGET_EXCEEDED",
      ],
    ];
    for (const [id, override, expected] of cases) {
      const spec = await f.spec(
          [{ id: "plan", ...override }],
          `unsupported:${id}`,
        ),
        registered = register(f, spec, `register:${id}`),
        before = f.counts(),
        remaining = f.engine.coordinator.getRemainingChildBudget(run.runId);
      await assert.rejects(preview(f, spec, registered), code(expected));
      assert.deepEqual(f.counts(), before);
      assert.equal(
        f.engine.coordinator.getRemainingChildBudget(run.runId).turns,
        remaining.turns,
      );
      assert.equal(f.children.length, 0);
    }
    const valid = await preview(f, baseline),
      created = start(f, valid),
      admitted = await stage(f, created.record),
      child = await f.waitChild();
    assert.equal(
      child.child.store.getRun(child.task.childRunId!).config.agentProfileId,
      baseline.stages[0]!.profile!.id,
    );
    child.release.resolve();
    assert.equal((await observe(f, admitted.record)).record.state, "completed");
  },
);

test(
  "a stale registered spec and changed physical worktree invalidate approved previews without native instance writes",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t),
      spec = await f.spec(),
      registered = register(f, spec),
      selected = await preview(f, spec, registered);
    register(
      f,
      { ...spec, description: "A later explicit host revision" },
      "register:next",
      registered.record.revision,
    );
    const before = f.counts();
    assert.throws(() => start(f, selected), code("WORKFLOW_SPEC_STALE"));
    assert.deepEqual(f.counts(), before);
    workflowInvoke(f.engine, "releaseWorkflowStartPreview", selected);
    const fresh = await preview(
        f,
        spec,
        workflowInvoke(f.engine, "registerWorkflow", {
          workspaceId: f.workspace.id,
          requestId: "register:latest",
          expectedRevision: 2,
          spec,
        }),
      ),
      worktree = f.worktrees[0]!,
      moved = `${worktree.root}.temporary`;
    renameSync(worktree.root, moved);
    mkdirSync(worktree.root);
    try {
      const snapshot = f.counts();
      assert.throws(() => start(f, fresh), code("WORKFLOW_WORKTREE_STALE"));
      assert.deepEqual(f.counts(), snapshot);
    } finally {
      rmSync(worktree.root, { recursive: true });
      renameSync(moved, worktree.root);
    }
    assert.equal(f.children.length, 0);
  },
);

test(
  "changing the actual parent tool policy after preview invalidates the pinned catalogue before instance creation",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t),
      spec = await f.spec(),
      selected = await preview(f, spec);
    f.engine.toolRuntime.policy.replace([
      { tool: "read_file", decision: "deny" },
    ]);
    const before = f.counts();
    assert.throws(() => start(f, selected), code("TOOL_CATALOGUE_STALE"));
    assert.deepEqual(f.counts(), before);
    assert.equal(f.children.length, 0);
  },
);

test(
  "actual worktree Git HEAD source drift before a stage creates no durable dispatch intent or child",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t),
      spec = await f.spec(),
      selected = await preview(f, spec),
      created = start(f, selected),
      worktree = f.worktrees[0]!;
    writeFileSync(
      join(worktree.root, "seed.txt"),
      "Changed source after preview.\n",
    );
    execFileSync("git", ["-C", worktree.root, "add", "seed.txt"]);
    execFileSync("git", [
      "-C",
      worktree.root,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Host changed baseline",
    ]);
    const before = f.counts();
    await assert.rejects(
      stage(f, created.record),
      code("WORKFLOW_WORKTREE_STALE"),
    );
    assert.deepEqual(f.counts(), before);
    assert.equal(
      inspect(f, created.record.instanceId).stages[0]!.state,
      "ready",
    );
    assert.equal(f.children.length, 0);
  },
);

test(
  "all joins pass only committed predecessor result DATA into the next real readonly child",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t),
      spec = await f.spec([
        { id: "plan" },
        { id: "review", role: "advisory-reviewer", dependsOn: ["plan"] },
      ]),
      created = start(f, await preview(f, spec));
    assert.equal(created.record.stages[1]!.state, "blocked");
    await assert.rejects(
      stage(f, created.record, "review", "blocked:review"),
      code(
        "WORKFLOW_STAGE_NOT_READY",
        "WORKFLOW_STAGE_STATE_INVALID",
        "WORKFLOW_STAGE_STALE",
      ),
    );
    const admitted = await stage(f, created.record),
      child = await f.waitChild();
    child.release.resolve();
    const first = await observe(f, admitted.record),
      second = await stage(f, first.record, "review"),
      reviewer = await f.waitChild(1),
      request = f.requests.find(
        (item) => item.runId === reviewer.task.childRunId,
      )!;
    const prompt = request.messages.find(
      (message) => message.role === "user",
    )!.content;
    assert.ok(prompt.includes('"authority":"advisory-data"'));
    assert.ok(prompt.includes('"stageId":"plan"'));
    assert.ok(
      prompt.includes('"observation":"Actual readonly child 0 completed."'),
    );
    assert.ok(prompt.includes(first.record.stages[0]!.resultSha256!));
    reviewer.release.resolve();
    const joined = await observe(f, second.record, "review");
    assert.equal(joined.record.state, "completed");
    assert.deepEqual(joined.record.result, {
      observation: "Actual readonly child 1 completed.",
    });
    assert.equal(f.children.length, 2);
  },
);

test(
  "any joins pin the first accepted completion even when an earlier spec dependency completes later",
  { timeout: 25000 },
  async (t) => {
    const f = await workflowFixture(t, { worktreeCount: 3 }),
      spec = await f.spec([
        { id: "first" },
        { id: "second" },
        {
          id: "review",
          role: "advisory-reviewer",
          join: "any",
          dependsOn: ["first", "second"],
        },
      ]),
      created = start(f, await preview(f, spec));
    const a = await stage(f, created.record, "first"),
      b = await stage(f, a.record, "second"),
      firstChild = await f.waitChild(0),
      secondChild = await f.waitChild(1);
    secondChild.release.resolve();
    const acceptedB = await observe(f, b.record, "second");
    assert.deepEqual(
      acceptedB.record.stages.find((item) => item.stageId === "review")!
        .selectedDependencies,
      ["second"],
    );
    firstChild.release.resolve();
    const acceptedA = await observe(f, acceptedB.record, "first");
    assert.deepEqual(
      acceptedA.record.stages.find((item) => item.stageId === "review")!
        .selectedDependencies,
      ["second"],
    );
    const review = await stage(f, acceptedA.record, "review"),
      reviewer = await f.waitChild(2),
      prompt = f.requests
        .find((item) => item.runId === reviewer.task.childRunId)!
        .messages.find((message) => message.role === "user")!.content;
    const data = JSON.parse(
      prompt.split("[Moodcode workflow advisory DATA v1]\n")[1]!,
    );
    assert.deepEqual(
      data.dependencies.map((item: { stageId: string }) => item.stageId),
      ["second"],
    );
    assert.equal(
      data.dependencies[0].value.observation,
      "Actual readonly child 1 completed.",
    );
    reviewer.release.resolve();
    assert.equal(
      (await observe(f, review.record, "review")).record.state,
      "completed",
    );
  },
);

test(
  "malformed actual child output remains unjoined and cannot replay the same stage or reset allocation",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t, {
        childResults: ["This is not a JSON object."],
      }),
      spec = await f.spec(),
      parent = await f.startParent(),
      created = start(f, await preview(f, spec)),
      admitted = await stage(f, created.record),
      child = await f.waitChild();
    child.release.resolve();
    await assert.rejects(
      observe(f, admitted.record),
      code("WORKFLOW_RESULT_INVALID"),
    );
    await workflowUntil(
      () =>
        f.engine.children.tasks.get(f.session.id, child.task.id).state ===
        "completed",
      "Actual malformed child still completed and closed",
    );
    const current = inspect(f, created.record.instanceId),
      remaining = f.engine.coordinator.getRemainingChildBudget(parent.runId);
    assert.equal(current.state, "running");
    assert.equal(current.result, null);
    assert.equal(current.stages[0]!.result, null);
    await assert.rejects(
      stage(f, current, "plan", "new-request"),
      code(
        "WORKFLOW_STAGE_NOT_READY",
        "WORKFLOW_STAGE_STATE_INVALID",
        "WORKFLOW_STAGE_STALE",
      ),
    );
    assert.equal(f.children.length, 1);
    assert.equal(
      f.engine.coordinator.getRemainingChildBudget(parent.runId).turns,
      remaining.turns,
    );
    assert.equal(
      f.engine.coordinator.getRemainingChildBudget(parent.runId).outputBytes,
      remaining.outputBytes,
    );
  },
);

for (const [name, output, expected] of [
  [
    "schema-mismatched",
    { unapprovedResultField: "Actual child JSON lacks required observation" },
    "WORKFLOW_SCHEMA_MISMATCH",
  ],
  [
    "truncated",
    { observation: "Observed".repeat(600) },
    "WORKFLOW_RESULT_INCOMPLETE",
  ],
] as const)
  test(
    `actual ${name} child result cannot join or grant parent delivery`,
    { timeout: 20000 },
    async (t) => {
      const f = await workflowFixture(t, { childResults: [output] }),
        spec = await f.spec(),
        created = start(f, await preview(f, spec)),
        admitted = await stage(f, created.record),
        child = await f.waitChild(),
        before = f.counts();
      child.release.resolve();
      await assert.rejects(observe(f, admitted.record), code(expected));
      const current = inspect(f, created.record.instanceId);
      assert.equal(current.result, null);
      assert.equal(current.stages[0]!.result, null);
      assert.equal(f.counts().inputs, before.inputs);
      assert.equal(f.counts().session_inputs, before.session_inputs);
      assert.equal(f.children.length, 1);
    },
  );

test(
  "workflow host input accessors and proxy previews never invoke caller traps or dispatch a child",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowFixture(t),
      spec = await f.spec(),
      selected = await preview(f, spec),
      created = start(f, selected),
      before = f.counts();
    let traps = 0;
    const input = {
      workspaceId: f.workspace.id,
      instanceId: created.record.instanceId,
      stageId: "plan",
      requestId: "accessor",
      expectedRevision: created.record.revision,
      approved: true,
    };
    Object.defineProperty(input, "signal", {
      enumerable: true,
      get() {
        traps++;
        throw Error("Caller signal accessor executed");
      },
    });
    await assert.rejects(
      workflowInvoke<Promise<InstanceResult>>(
        f.engine,
        "startWorkflowStage",
        input,
      ),
      code("INVALID_WORKFLOW_INPUT"),
    );
    await assert.rejects(
      workflowInvoke<Promise<InstanceResult>>(
        f.engine,
        "observeWorkflowStage",
        input,
      ),
      code("INVALID_WORKFLOW_INPUT"),
    );
    const proxy = new Proxy(selected, {
      get() {
        traps++;
        throw Error("Caller preview proxy executed");
      },
    });
    assert.throws(
      () => start(f, proxy, "proxy"),
      code("WORKFLOW_PREVIEW_STALE"),
    );
    assert.equal(traps, 0);
    assert.deepEqual(f.counts(), before);
    assert.equal(f.children.length, 0);
  },
);
