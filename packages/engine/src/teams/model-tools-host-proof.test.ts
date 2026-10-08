import assert from "node:assert/strict";
import test from "node:test";
import type { ToolContext } from "../ports.js";
import { modelToolsFixture } from "./fixtures/model-tools.js";

for (const field of ["signal", "workspace-root"] as const) {
  test(`actual original model tool context rejects a ${field} accessor before invoking it or saving a message`, async (t) => {
    const f = await modelToolsFixture(t),
      parent = await f.startParent(),
      team = f.createTeam(),
      actor = f.join(team.id, "coordinator");
    f.join(team.id, "target", "worker");
    f.engine.bindTeamModelTools({
      rootSessionId: f.session.id,
      teamId: team.id,
      memberId: actor.memberId,
      generation: actor.generation,
      recipientAliases: ["target"],
    });
    let traps = 0,
      originalExecutions = 0;
    const coordinator = f.engine.coordinator,
      original = coordinator.assertTeamToolContext.bind(coordinator);
    coordinator.assertTeamToolContext = (context: ToolContext, phase) => {
      if (phase !== "execute") return original(context, phase);
      originalExecutions++;
      const target = field === "signal" ? context : context.workspace,
        key = field === "signal" ? "signal" : "root",
        descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      assert.ok(descriptor && Object.hasOwn(descriptor, "value"));
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get() {
          traps++;
          return descriptor.value;
        },
      });
      try {
        original(context, phase);
      } finally {
        Object.defineProperty(target, key, descriptor);
      }
    };
    f.rootTurns.release(0, [
      {
        id: `original-${field}`,
        name: "send_agent_message",
        input: {
          requestId: `original-${field}`,
          recipient: "target",
          text: "An accessor cannot preserve original producer authority.",
        },
      },
    ]);
    const approval = await f.pendingApproval(),
      before = f.teamCounts();
    await f.decide(approval);
    await f.rootTurns.entered(1);
    f.rootTurns.release(1);
    assert.equal((await f.engine.waitForRun(parent.runId)).state, "completed");
    assert.ok(
      originalExecutions > 0,
      "The actual original executing context must reach its producer check",
    );
    assert.equal(traps, 0);
    assert.deepEqual(f.teamCounts(), before);
    const tool = f.engine.store.getToolCall(approval.toolCallId);
    assert.equal(tool.state, "failed");
    assert.match(tool.output ?? tool.error ?? "", /TEAM_MODEL_OWNER_STALE/);
    assert.equal(f.engine.store.getApproval(approval.id).status, "allowed");
  });
}

test("an approved actual model claim cannot consume a task revision replaced while approval was pending", async (t) => {
  const f = await modelToolsFixture(t),
    parent = await f.startParent(),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator"),
    worker = f.join(team.id, "worker", "worker");
  const request = {
    workspaceId: f.workspace.id,
    teamId: team.id,
    memberId: coordinator.memberId,
    generation: coordinator.generation,
    taskId: "task-with-current-revision",
    title: "First actual task",
    description: "The approved claim pins this complete native revision.",
    dependencies: [],
    expiresAt: f.expiresAt,
  };
  const task = f.engine.putTeamTask({
    ...request,
    requestId: "create-proof-task",
    expectedRevision: 0,
  }).record;
  f.engine.bindTeamModelTools({
    rootSessionId: f.session.id,
    teamId: team.id,
    memberId: worker.memberId,
    generation: worker.generation,
  });
  f.rootTurns.release(0, [
    {
      id: "claim-stale-task",
      name: "claim_team_task",
      input: {
        requestId: "claim-stale-task",
        taskId: task.taskId,
        expectedRevision: task.revision,
      },
    },
  ]);
  const approval = await f.pendingApproval();
  const replacement = f.engine.putTeamTask({
    ...request,
    requestId: "replace-proof-task",
    expectedRevision: task.revision,
    title: "New actual task revision",
  }).record;
  const before = f.teamCounts();
  assert.equal(replacement.revision, task.revision + 1);
  await f.decide(approval);
  await f.rootTurns.entered(1);
  f.rootTurns.release(1);
  assert.equal((await f.engine.waitForRun(parent.runId)).state, "completed");
  assert.deepEqual(f.teamCounts(), before);
  assert.deepEqual(
    f.engine.getTeamTask(f.workspace.id, team.id, task.taskId),
    replacement,
  );
  const tool = f.engine.store.getToolCall(approval.toolCallId);
  assert.equal(tool.state, "failed");
  assert.match(tool.output ?? tool.error ?? "", /TEAM_MODEL_TASK_STALE/);
  assert.equal(f.engine.store.getApproval(approval.id).status, "allowed");
});
