import assert from "node:assert/strict";
import test from "node:test";
import {
  EngineError,
  type JsonObject,
  type ProviderToolCall,
  type ToolCallRecord,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ToolContext } from "../ports.js";
import type { TeamMemberRevision } from "./types.js";
import {
  MODEL_TEAM_TOOL_NAMES,
  modelToolsFixture,
  modelToolsCommand,
  untilModelTools,
  type ModelToolsEngine,
} from "./fixtures/model-tools.js";

interface BindingInput {
  rootSessionId: string;
  teamId: string;
  memberId: string;
  generation: number;
  childTaskId?: string;
  recipientAliases?: string[];
}
function bind(engine: ModelToolsEngine, input: BindingInput): object {
  const method = Reflect.get(engine, "bindTeamModelTools");
  assert.equal(
    typeof method,
    "function",
    "Actual public Engine must bind the model actor",
  );
  return Reflect.apply(method, engine, [input]) as object;
}
function release(engine: ModelToolsEngine, binding: object): void {
  const method = Reflect.get(engine, "releaseTeamModelTools");
  assert.equal(typeof method, "function");
  Reflect.apply(method, engine, [binding]);
}
function bindMember(
  f: Awaited<ReturnType<typeof modelToolsFixture>>,
  teamId: string,
  member: TeamMemberRevision,
  recipientAliases: string[] = [],
  childTaskId?: string,
) {
  return bind(f.engine, {
    rootSessionId: f.session.id,
    teamId,
    memberId: member.memberId,
    generation: member.generation,
    recipientAliases,
    ...(childTaskId ? { childTaskId } : {}),
  });
}
function call(name: string, input: JsonObject, id = name): ProviderToolCall {
  return { id, name, input };
}
function tool(
  f: Awaited<ReturnType<typeof modelToolsFixture>>,
  name: string,
  index = 0,
  engine = f.engine,
  sessionId = f.session.id,
): ToolCallRecord {
  const record = engine.store
    .getSnapshot(sessionId)
    .tools.filter((item) => item.name === name)[index];
  assert.ok(record, `Native ${name} tool record must exist`);
  return record;
}
function output(
  f: Awaited<ReturnType<typeof modelToolsFixture>>,
  name: string,
  index = 0,
  engine = f.engine,
  sessionId = f.session.id,
) {
  const record = tool(f, name, index, engine, sessionId);
  assert.equal(
    record.state,
    "completed",
    record.error ?? record.output ?? "Actual tool must complete",
  );
  assert.ok(record.output);
  return JSON.parse(record.output) as JsonObject;
}
async function finish(
  f: Awaited<ReturnType<typeof modelToolsFixture>>,
  runId: string,
  nextTurn = 1,
) {
  await f.rootTurns.entered(nextTurn);
  f.rootTurns.release(nextTurn);
  assert.equal((await f.engine.waitForRun(runId)).state, "completed");
}
function putTask(
  f: Awaited<ReturnType<typeof modelToolsFixture>>,
  teamId: string,
  coordinator: TeamMemberRevision,
  taskId = "actual-model-task",
) {
  return f.engine.putTeamTask({
    workspaceId: f.workspace.id,
    teamId,
    taskId,
    memberId: coordinator.memberId,
    generation: coordinator.generation,
    requestId: `put-${taskId}`,
    expectedRevision: 0,
    title: "Actual model task",
    description:
      "A metadata task does not grant file effects or verification authority.",
    dependencies: [],
    expiresAt: f.expiresAt,
  }).record;
}

test("default-off team model tools stay outside the actual catalogue and an opted-in unbound Run has no team effects", async (t) => {
  const disabled = await modelToolsFixture(t, { modelTools: false });
  for (const name of MODEL_TEAM_TOOL_NAMES)
    assert.ok(
      !disabled.engine
        .getCapabilities()
        .tools.some((item) => item.name === name),
    );
  const f = await modelToolsFixture(t),
    parent = await f.startParent(),
    before = f.teamCounts(),
    request = await f.rootTurns.entered(0);
  for (const name of MODEL_TEAM_TOOL_NAMES)
    assert.ok(
      request.tools.some((item) => item.name === name),
      name,
    );
  f.rootTurns.release(0, [
    call("send_agent_message", {
      requestId: "unbound",
      recipient: "unbound",
      text: "No host actor was selected.",
    }),
  ]);
  await finish(f, parent.runId);
  assert.deepEqual(f.teamCounts(), before);
  const rejected = tool(f, "send_agent_message");
  assert.equal(rejected.state, "failed");
  assert.match(
    rejected.output ?? rejected.error ?? "",
    /TEAM_MODEL|TEAM_OWNER|TEAM_TOOL/,
  );
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
});

test("actual coordinator model send requires the exact native approval and returns one durable message receipt without renewing the Run", async (t) => {
  const f = await modelToolsFixture(t),
    parent = await f.startParent(),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator"),
    target = f.join(team.id, "target", "worker");
  const binding = bindMember(f, team.id, coordinator, ["target"]),
    before = f.teamCounts(),
    config = structuredClone(f.engine.store.getRun(parent.runId).config),
    remaining = f.engine.coordinator.getRemainingChildBudget(parent.runId);
  f.rootTurns.release(0, [
    call("send_agent_message", {
      requestId: "model-send",
      recipient: "target",
      text: "Actual provider-bound untrusted message.",
    }),
  ]);
  const approval = await f.pendingApproval();
  assert.equal(approval.toolName, "send_agent_message");
  assert.equal(approval.runId, parent.runId);
  assert.deepEqual(f.teamCounts(), before);
  assert.equal(typeof approval.preview.teamModelRequestFingerprint, "string");
  await f.decide(approval);
  await f.rootTurns.entered(1);
  const page = f.engine.readAgentMailbox({
    workspaceId: f.workspace.id,
    teamId: team.id,
    memberId: target.memberId,
    generation: target.generation,
  });
  // Native historical sender ownership remains the original actual coordinator, even after the Run completed.
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0]!.senderMemberId, coordinator.memberId);
  assert.equal(page.messages[0]!.senderRevisionId, coordinator.id);
  assert.equal(page.messages[0]!.recipientRevisionId, target.id);
  assert.equal(
    page.messages[0]!.text,
    "Actual provider-bound untrusted message.",
  );
  const result = output(f, "send_agent_message");
  assert.match(JSON.stringify(result), new RegExp(page.messages[0]!.id));
  assert.equal(f.teamCounts().team_messages, Number(before.team_messages) + 1);
  assert.deepEqual(f.engine.store.getRun(parent.runId).config, config);
  const usage = f.engine.coordinator.getRunUsage(parent.runId);
  assert.equal(usage.toolCalls, 1);
  assert.equal(usage.turns, 2);
  assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 1);
  assert.equal(remaining.toolCalls, 24);
  f.engine.releaseAgentMailboxPage(page);
  await finish(f, parent.runId);
  release(f.engine, binding);
});

test("read mailbox freezes the approved native prefix while later messages remain unread and unclaimed", async (t) => {
  const f = await modelToolsFixture(t, {
      engine: { toolPolicy: [{ tool: "read_agent_mailbox", decision: "ask" }] },
    }),
    parent = await f.startParent(),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator"),
    observer = f.join(team.id, "observer", "observer");
  bindMember(f, team.id, observer);
  const first = f.send(
    team.id,
    coordinator,
    observer,
    "first",
    "First complete original native mailbox body.",
  );
  f.rootTurns.release(0, [call("read_agent_mailbox", { limit: 1 })]);
  const approval = await f.pendingApproval();
  const second = f.send(
    team.id,
    coordinator,
    observer,
    "second",
    "Added after exact approval preparation.",
  );
  const before = f.teamCounts();
  await f.decide(approval);
  await finish(f, parent.runId);
  const result = JSON.stringify(output(f, "read_agent_mailbox"));
  assert.ok(result.includes(first.text));
  assert.ok(!result.includes(second.text));
  assert.deepEqual(f.teamCounts(), before);
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 1);
  assert.equal(f.engine.coordinator.getRunUsage(parent.runId).toolCalls, 1);
  assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 1);
});

test("actual worker alias claims and completes one native task without borrowing same-owner coordinator permissions", async (t) => {
  const f = await modelToolsFixture(t),
    parent = await f.startParent(),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator"),
    worker = f.join(team.id, "worker", "worker"),
    task = putTask(f, team.id, coordinator);
  assert.equal(worker.owner.sha256, coordinator.owner.sha256);
  bindMember(f, team.id, worker);
  f.rootTurns.release(0, [
    call("claim_team_task", {
      requestId: "model-claim",
      taskId: task.taskId,
      expectedRevision: task.revision,
    }),
  ]);
  await f.decide(await f.pendingApproval());
  await f.rootTurns.entered(1);
  const claimed = f.engine.getTeamTask(f.workspace.id, team.id, task.taskId)!;
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.owner?.memberId, worker.memberId);
  assert.equal(claimed.owner?.memberRevisionId, worker.id);
  assert.equal(claimed.owner?.memberSha256, worker.sha256);
  f.rootTurns.release(1, [
    call("complete_team_task", {
      requestId: "model-complete",
      taskId: task.taskId,
      expectedRevision: claimed.revision,
    }),
  ]);
  await f.decide(await f.pendingApproval());
  await finish(f, parent.runId, 2);
  const completed = f.engine.getTeamTask(f.workspace.id, team.id, task.taskId)!;
  assert.equal(completed.state, "completed");
  assert.equal(completed.owner?.memberId, worker.memberId);
  assert.equal(completed.previousId, claimed.id);
  output(f, "claim_team_task");
  output(f, "complete_team_task");
  assert.equal(f.engine.coordinator.getRunUsage(parent.runId).toolCalls, 2);
  assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 1);
});

test("same actual owner observer and receive-only worker aliases cannot borrow a coordinator send or task claim", async (t) => {
  for (const role of ["observer", "worker"] as const) {
    const f = await modelToolsFixture(t),
      parent = await f.startParent(),
      team = f.createTeam(),
      coordinator = f.join(team.id, "coordinator"),
      restricted = f.join(team.id, "restricted", role, undefined, {
        send: false,
        claimTasks: false,
      }),
      target = f.join(team.id, "target", "worker"),
      task = putTask(f, team.id, coordinator);
    assert.equal(restricted.owner.sha256, coordinator.owner.sha256);
    bindMember(f, team.id, restricted, ["target"]);
    const before = f.teamCounts();
    f.rootTurns.release(0, [
      call("send_agent_message", {
        requestId: "forbidden-send",
        recipient: target.memberId,
        text: "Cannot borrow another alias role.",
      }),
      call("claim_team_task", {
        requestId: "forbidden-claim",
        taskId: task.taskId,
        expectedRevision: task.revision,
      }),
    ]);
    await finish(f, parent.runId);
    assert.deepEqual(f.teamCounts(), before);
    for (const name of ["send_agent_message", "claim_team_task"]) {
      const record = tool(f, name);
      assert.equal(record.state, "failed");
      assert.match(
        record.output ?? record.error ?? "",
        /TEAM_MODEL|TEAM_PERMISSION|TEAM_ROLE/,
      );
    }
    assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
  }
});

test("provider actor/member/generation/workspace fields cannot override the host-selected actor and out-of-scope recipients have zero effects", async (t) => {
  const f = await modelToolsFixture(t),
    parent = await f.startParent(),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator");
  f.join(team.id, "target", "worker");
  f.join(team.id, "other-target", "worker");
  bindMember(f, team.id, coordinator, ["target"]);
  const before = f.teamCounts();
  const fields = [
    "workspaceId",
    "teamId",
    "memberId",
    "generation",
    "senderMemberId",
    "senderGeneration",
    "actor",
    "owner",
  ];
  const calls = fields.map((field, index) =>
    call(
      "send_agent_message",
      {
        requestId: `identity-${index}`,
        recipient: "target",
        text: "Exact host identity only.",
        [field]: field.toLowerCase().includes("generation")
          ? 999
          : "caller-descriptive-identity",
      },
      `identity-${field}`,
    ),
  );
  calls.push(
    call(
      "send_agent_message",
      {
        requestId: "outside-recipient",
        recipient: "other-target",
        text: "A real same-owner member still needs exact host recipient scope.",
      },
      "outside-recipient",
    ),
  );
  f.rootTurns.release(0, calls);
  await finish(f, parent.runId);
  assert.deepEqual(f.teamCounts(), before);
  const records = f.engine.store.getSnapshot(f.session.id).tools;
  assert.equal(records.length, calls.length);
  assert.ok(records.every((record) => record.state === "failed"));
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
  for (const record of records.slice(0, fields.length))
    assert.match(
      record.output ?? record.error ?? "",
      /INVALID_TEAM_MODEL_INPUT/,
    );
});

test("actual denied, cancelled and released approval owners cannot dispatch native messages", async (t) => {
  for (const decision of ["deny", "cancel", "release"] as const) {
    const f = await modelToolsFixture(t),
      parent = await f.startParent(),
      team = f.createTeam(),
      coordinator = f.join(team.id, "coordinator");
    f.join(team.id, "target", "worker");
    const binding = bindMember(f, team.id, coordinator, ["target"]),
      before = f.teamCounts();
    f.rootTurns.release(0, [
      call("send_agent_message", {
        requestId: `model-${decision}`,
        recipient: "target",
        text: "No native effect is allowed after this owner boundary.",
      }),
    ]);
    const approval = await f.pendingApproval();
    if (decision === "cancel") {
      await modelToolsCommand(f.engine, "run.cancel", { runId: parent.runId });
      assert.equal(
        (await f.engine.waitForRun(parent.runId)).state,
        "cancelled",
      );
    } else {
      if (decision === "release") release(f.engine, binding);
      await f.decide(approval, decision === "deny" ? "deny" : "allow");
      await finish(f, parent.runId);
    }
    assert.deepEqual(f.teamCounts(), before);
    const record = tool(f, "send_agent_message");
    assert.ok(
      ["denied", "interrupted", "failed"].includes(record.state),
      record.state,
    );
    assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 1);
  }
});

test("actual original ToolContext authenticates native Turn and Attempt while an identical copied tuple cannot prepare or dispatch", async (t) => {
  const f = await modelToolsFixture(t),
    captured: ToolContext[] = [],
    coordinator = f.engine.coordinator as unknown as {
      assertTeamToolContext(
        context: ToolContext,
        phase: "prepare" | "execute",
      ): void;
    };
  assert.equal(typeof coordinator.assertTeamToolContext, "function");
  const original = coordinator.assertTeamToolContext.bind(coordinator);
  coordinator.assertTeamToolContext = (context, phase) => {
    original(context, phase);
    if (phase === "prepare") captured.push(context);
  };
  const parent = await f.startParent(),
    team = f.createTeam(),
    member = f.join(team.id, "coordinator");
  f.join(team.id, "target", "worker");
  bindMember(f, team.id, member, ["target"]);
  f.rootTurns.release(0, [
    call("send_agent_message", {
      requestId: "context-original",
      recipient: "target",
      text: "Original provider-owned tool context.",
    }),
  ]);
  const approval = await f.pendingApproval();
  assert.ok(captured.length);
  const context = captured[0]!,
    before = f.teamCounts();
  assert.equal(context.runId, parent.runId);
  assert.equal(context.sessionId, f.session.id);
  assert.equal(context.toolCallId, approval.toolCallId);
  assert.ok(context.turnId);
  assert.ok(context.attemptId);
  assert.equal(f.engine.store.getTurn(context.turnId).runId, parent.runId);
  assert.equal(
    f.engine.store.getAttempt(context.attemptId).turnId,
    context.turnId,
  );
  for (const phase of ["prepare", "execute"] as const)
    assert.throws(
      () => original({ ...context }, phase),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.match(error.code, /TEAM|TOOL_CONTEXT/);
        return true;
      },
    );
  assert.deepEqual(f.teamCounts(), before);
  await f.decide(approval);
  await finish(f, parent.runId);
  assert.equal(f.teamCounts().team_messages, Number(before.team_messages) + 1);
});

test("actual child has no inherited team model catalogue or authority and closed or reopened owners cannot regain a model binding", async (t) => {
  const f = await modelToolsFixture(t, { worktreeCount: 1 }),
    parent = await f.startParent(),
    child = await f.startChild(),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator"),
    childMember = f.join(team.id, "child-worker", "worker", child.task.id);
  bindMember(f, team.id, coordinator, ["child-worker"]);
  const request = await child.turns.entered(0);
  assert.equal(
    f.engine.children.tasks.get(f.session.id, child.task.id).state,
    "running",
  );
  assert.equal(request.runId, child.task.childRunId);
  for (const name of MODEL_TEAM_TOOL_NAMES)
    assert.ok(!request.tools.some((item) => item.name === name));
  assert.throws(
    () =>
      child.child.createTeam({
        workspaceId: childMember.owner.workspaceId,
        requestId: "child-inherited",
        teamId: "child-inherited",
        expiresAt: f.expiresAt,
      }),
    (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.match(error.code, /DISABLED/);
      return true;
    },
  );
  const before = f.teamCounts();
  child.turns.release(0, [call("read_agent_mailbox", {})]);
  await child.turns.entered(1);
  assert.match(
    tool(f, "read_agent_mailbox", 0, child.child, childMember.owner.sessionId)
      .output ?? "",
    /TOOL_NOT_ALLOWED|TOOL_NOT_FOUND/,
  );
  child.turns.release(1);
  const outcome = await f.engine.children.tasks.wait(
    f.session.id,
    child.task.id,
  );
  assert.equal(outcome.state, "completed");
  assert.deepEqual(f.teamCounts(), before);
  await f.engine.close();
  const reopened = createEngine(f.configuration);
  f.engines.add(reopened);
  assert.equal(reopened.getTeam(f.workspace.id, team.id)?.id, team.id);
  assert.throws(
    () =>
      bind(reopened, {
        rootSessionId: f.session.id,
        teamId: team.id,
        memberId: coordinator.memberId,
        generation: coordinator.generation,
      }),
    (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.match(error.code, /TEAM|PARENT|RUN_USAGE/);
      return true;
    },
  );
  assert.equal(reopened.store.getRun(parent.runId).state, "cancelled");
});

test("explicitly scoped actual child consumes native mailbox, sends and settles its own task within the original reserved budget", async (t) => {
  const f = await modelToolsFixture(t, {
    worktreeCount: 1,
    childTools: [...MODEL_TEAM_TOOL_NAMES, "read_file"],
  });
  const parent = await f.startParent(),
    initialBudget = f.engine.coordinator.getRemainingChildBudget(parent.runId),
    child = await f.startChild(),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator"),
    worker = f.join(team.id, "actual-child-worker", "worker", child.task.id),
    task = putTask(f, team.id, coordinator, "actual-child-task");
  bindMember(f, team.id, worker, [coordinator.memberId], child.task.id);
  const message = f.send(
    team.id,
    coordinator,
    worker,
    "child-mailbox-message",
    "Original native root message to this actual child.",
  );
  const request = await child.turns.entered(0);
  for (const name of MODEL_TEAM_TOOL_NAMES)
    assert.ok(request.tools.some((item) => item.name === name));
  assert.equal(
    f.engine.children.tasks.get(f.session.id, child.task.id).state,
    "running",
  );
  const childConfig = structuredClone(
      child.child.store.getRun(worker.owner.runId).config,
    ),
    beforeInputs = child.child.store.listInputs(worker.owner.sessionId).inputs
      .length;
  assert.equal(childConfig.limits.maxTurns, 6);
  assert.equal(childConfig.limits.maxToolCalls, 8);
  child.turns.release(0, [call("read_agent_mailbox", { limit: 1 })]);
  await child.turns.entered(1);
  assert.match(
    JSON.stringify(
      output(f, "read_agent_mailbox", 0, child.child, worker.owner.sessionId),
    ),
    new RegExp(message.id),
  );
  child.turns.release(1, [
    call("send_agent_message", {
      requestId: "child-native-send",
      recipient: coordinator.memberId,
      text: "Actual isolated worker observation.",
    }),
  ]);
  const sendApproval = await f.pendingApproval(
    child.child,
    worker.owner.sessionId,
  );
  assert.equal(sendApproval.runId, worker.owner.runId);
  await f.decide(sendApproval, "allow", child.child);
  await child.turns.entered(2);
  const rootPage = f.engine.readAgentMailbox({
    workspaceId: f.workspace.id,
    teamId: team.id,
    memberId: coordinator.memberId,
    generation: coordinator.generation,
  });
  assert.equal(rootPage.messages.length, 1);
  assert.equal(rootPage.messages[0]!.senderRevisionId, worker.id);
  assert.equal(
    rootPage.messages[0]!.text,
    "Actual isolated worker observation.",
  );
  f.engine.releaseAgentMailboxPage(rootPage);
  child.turns.release(2, [
    call("claim_team_task", {
      requestId: "child-native-claim",
      taskId: task.taskId,
      expectedRevision: task.revision,
    }),
  ]);
  await f.decide(
    await f.pendingApproval(child.child, worker.owner.sessionId),
    "allow",
    child.child,
  );
  await child.turns.entered(3);
  const claimed = f.engine.getTeamTask(f.workspace.id, team.id, task.taskId)!;
  assert.equal(claimed.owner?.memberRevisionId, worker.id);
  assert.equal(claimed.state, "claimed");
  child.turns.release(3, [
    call("complete_team_task", {
      requestId: "child-native-complete",
      taskId: task.taskId,
      expectedRevision: claimed.revision,
    }),
  ]);
  await f.decide(
    await f.pendingApproval(child.child, worker.owner.sessionId),
    "allow",
    child.child,
  );
  await child.turns.entered(4);
  assert.equal(
    f.engine.getTeamTask(f.workspace.id, team.id, task.taskId)?.state,
    "completed",
  );
  for (const name of MODEL_TEAM_TOOL_NAMES)
    output(f, name, 0, child.child, worker.owner.sessionId);
  assert.deepEqual(
    child.child.store.getRun(worker.owner.runId).config,
    childConfig,
  );
  assert.equal(
    child.child.store.listInputs(worker.owner.sessionId).inputs.length,
    beforeInputs,
  );
  const currentParentBudget = f.engine.coordinator.getRemainingChildBudget(
    parent.runId,
  );
  assert.equal(currentParentBudget.turns, initialBudget.turns - 6);
  assert.equal(currentParentBudget.toolCalls, initialBudget.toolCalls - 8);
  assert.equal(
    currentParentBudget.outputBytes,
    initialBudget.outputBytes - 65536,
  );
  child.turns.release(4);
  const outcome = await f.engine.children.tasks.wait(
    f.session.id,
    child.task.id,
  );
  assert.equal(outcome.state, "completed");
  assert.equal(outcome.outcome?.usage.toolCalls, 4);
  assert.equal(outcome.outcome?.usage.turns, 5);
  assert.equal(outcome.deliveryState, "none");
  assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 1);
});

test("a read-only actual profile cannot invoke unadvertised team mutations even when its host actor is a coordinator", async (t) => {
  const f = await modelToolsFixture(t, {
      allowedTools: ["read_agent_mailbox"],
    }),
    parent = await f.startParent(),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator");
  f.join(team.id, "target", "worker");
  bindMember(f, team.id, coordinator, ["target"]);
  const request = await f.rootTurns.entered(0);
  assert.deepEqual(
    request.tools.map((item) => item.name),
    ["read_agent_mailbox"],
  );
  const before = f.teamCounts();
  f.rootTurns.release(0, [
    call("send_agent_message", {
      requestId: "profile-escape",
      recipient: "target",
      text: "The host role does not widen the original profile catalogue.",
    }),
  ]);
  await finish(f, parent.runId);
  assert.deepEqual(f.teamCounts(), before);
  assert.match(
    tool(f, "send_agent_message").output ?? "",
    /TOOL_NOT_ALLOWED|TOOL_NOT_FOUND/,
  );
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
});

test("insufficient original output budget rejects model team preparation before an approval or native mutation", async (t) => {
  const f = await modelToolsFixture(t),
    parent = await f.startParent({ limits: { maxOutputBytes: 512 } }),
    team = f.createTeam(),
    coordinator = f.join(team.id, "coordinator");
  f.join(team.id, "target", "worker");
  bindMember(f, team.id, coordinator, ["target"]);
  const before = f.teamCounts();
  f.rootTurns.release(0, [
    call("send_agent_message", {
      requestId: "output-limit",
      recipient: "target",
      text: "The original native budget must be sufficient for a complete receipt.",
    }),
  ]);
  await finish(f, parent.runId);
  assert.deepEqual(f.teamCounts(), before);
  assert.match(
    tool(f, "send_agent_message").output ?? "",
    /TEAM_MODEL_OUTPUT_LIMIT/,
  );
  assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
  assert.equal(
    f.engine.store.getRun(parent.runId).config.limits.maxOutputBytes,
    512,
  );
});
