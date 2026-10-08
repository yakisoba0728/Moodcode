import assert from "node:assert/strict";
import test from "node:test";
import { failure, readDatabase } from "./fixtures/engine-team.js";
import { nativeTeam, workerPermissions } from "./fixtures/native-team.js";

test("native board revisions and request receipts add only team data, with exact original claim/completion ownership and no provider or tool dispatch", async (t) => {
  const f = await nativeTeam(t),
    { member } = await f.child(),
    before = f.codingCounts(),
    requests = structuredClone(f.requests),
    base = {
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: f.coordinator.memberId,
      generation: f.coordinator.generation,
      taskId: "actual-task",
      requestId: "board-create",
      expectedRevision: 0,
      title: "Actual metadata task",
      description:
        "This board record is data; it does not prove physical verification.",
      dependencies: [] as string[],
      expiresAt: f.expiresAt,
    },
    created = f.engine.putTeamTask(base);
  assert.equal(created.record.state, "pending");
  assert.equal(created.record.revision, 1);
  assert.equal(created.receipt.recordSha256, created.record.sha256);
  assert.deepEqual(
    f.engine.getTeamTask(f.workspace.id, f.created.record.id, "actual-task"),
    created.record,
  );
  const duplicate = f.engine.putTeamTask(base);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.receipt, created.receipt);
  assert.throws(
    () => f.engine.putTeamTask({ ...base, title: "Same ID changed body" }),
    failure("TEAM_REQUEST_CONFLICT"),
  );
  const claimed = f.engine.claimTeamTask({
    workspaceId: f.workspace.id,
    teamId: f.created.record.id,
    taskId: "actual-task",
    memberId: member.memberId,
    generation: member.generation,
    requestId: "board-claim",
    expectedRevision: created.record.revision,
  });
  assert.equal(claimed.record.state, "claimed");
  assert.equal(claimed.record.owner?.memberRevisionId, member.id);
  assert.equal(claimed.record.owner?.memberSha256, member.sha256);
  assert.throws(
    () =>
      f.engine.completeTeamTask({
        workspaceId: f.workspace.id,
        teamId: f.created.record.id,
        taskId: "actual-task",
        memberId: f.coordinator.memberId,
        generation: f.coordinator.generation,
        requestId: "foreign-completion",
        expectedRevision: claimed.record.revision,
      }),
    failure("TEAM_STALE"),
  );
  const completed = f.engine.completeTeamTask({
    workspaceId: f.workspace.id,
    teamId: f.created.record.id,
    taskId: "actual-task",
    memberId: member.memberId,
    generation: member.generation,
    requestId: "board-complete",
    expectedRevision: claimed.record.revision,
  });
  assert.equal(completed.record.state, "completed");
  assert.equal(completed.record.previousId, claimed.record.id);
  assert.deepEqual(f.codingCounts(), before);
  assert.deepEqual(f.requests, requests);
  assert.equal(
    f.engine.listTeamTasks(f.workspace.id, f.created.record.id).length,
    1,
  );
});

test("same native task head admits one worker claim and rejects the competing exact old revision without renewing either child budget", async (t) => {
  const f = await nativeTeam(t),
    first = await f.child("worker-a"),
    second = await f.child("worker-b"),
    task = f.engine.putTeamTask({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: f.coordinator.memberId,
      generation: f.coordinator.generation,
      taskId: "racing-task",
      requestId: "racing-create",
      expectedRevision: 0,
      title: "Competing metadata claim",
      description: "Only one original member wins the native revision CAS.",
      dependencies: [],
      expiresAt: f.expiresAt,
    }),
    budgets = [first, second].map((v) =>
      v.child.coordinator.getRemainingChildBudget(v.member.owner.runId),
    ),
    requests = structuredClone(f.requests),
    claim = {
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      taskId: "racing-task",
      memberId: first.member.memberId,
      generation: first.member.generation,
      requestId: "winner",
      expectedRevision: task.record.revision,
    };
  const winner = f.engine.claimTeamTask(claim);
  assert.equal(winner.record.owner?.memberId, first.member.memberId);
  assert.throws(
    () =>
      f.engine.claimTeamTask({
        ...claim,
        memberId: second.member.memberId,
        generation: second.member.generation,
        requestId: "loser",
      }),
    failure("TEAM_STALE"),
  );
  const duplicate = f.engine.claimTeamTask(claim);
  assert.deepEqual(duplicate.receipt, winner.receipt);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(f.requests, requests);
  for (const [index, v] of [first, second].entries())
    for (const key of ["turns", "toolCalls", "outputBytes"] as const)
      assert.equal(
        v.child.coordinator.getRemainingChildBudget(v.member.owner.runId)[key],
        budgets[index]![key],
      );
});

test("task dependency head pins become stale after actual completed revision and require a new explicit task revision", async (t) => {
  const f = await nativeTeam(t),
    { member } = await f.child(),
    put = (
      taskId: string,
      requestId: string,
      dependencies: string[] = [],
      expectedRevision = 0,
    ) =>
      f.engine.putTeamTask({
        workspaceId: f.workspace.id,
        teamId: f.created.record.id,
        memberId: f.coordinator.memberId,
        generation: f.coordinator.generation,
        taskId,
        requestId,
        expectedRevision,
        title: taskId,
        description: "Exact native dependency revision data.",
        dependencies,
        expiresAt: f.expiresAt,
      }),
    dependency = put("dependency", "dep-create"),
    blocked = put("dependent", "dependent-create", ["dependency"]);
  const act = (
    taskId: string,
    requestId: string,
    expectedRevision: number,
  ) => ({
    workspaceId: f.workspace.id,
    teamId: f.created.record.id,
    taskId,
    memberId: member.memberId,
    generation: member.generation,
    requestId,
    expectedRevision,
  });
  assert.throws(
    () => f.engine.claimTeamTask(act("dependent", "before-dep", 1)),
    failure("TEAM_DEPENDENCY"),
  );
  const claimed = f.engine.claimTeamTask(
      act("dependency", "dep-claim", dependency.record.revision),
    ),
    completed = f.engine.completeTeamTask(
      act("dependency", "dep-complete", claimed.record.revision),
    );
  assert.equal(completed.record.state, "completed");
  assert.throws(
    () => f.engine.claimTeamTask(act("dependent", "old-pin", 1)),
    failure("TEAM_DEPENDENCY"),
  );
  const revised = put(
    "dependent",
    "dependent-refresh",
    ["dependency"],
    blocked.record.revision,
  );
  assert.equal(revised.record.dependencies[0]!.revisionId, completed.record.id);
  assert.equal(revised.record.dependencies[0]!.sha256, completed.record.sha256);
  assert.equal(
    f.engine.claimTeamTask(act("dependent", "new-pin", revised.record.revision))
      .record.state,
    "claimed",
  );
});

test("board role denial, cyclic/self dependency and stale revision reject without native head, message or coding effects", async (t) => {
  const f = await nativeTeam(t),
    { member } = await f.child("observer-worker", {
      ...workerPermissions,
      claimTasks: false,
    }),
    base = {
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: member.memberId,
      generation: member.generation,
      taskId: "forbidden-task",
      requestId: "worker-manage",
      expectedRevision: 0,
      title: "Forbidden task",
      description: "No management permission.",
      dependencies: [] as string[],
      expiresAt: f.expiresAt,
    },
    before = f.codingCounts();
  assert.throws(() => f.engine.putTeamTask(base), failure("TEAM_PERMISSION"));
  const created = f.engine.putTeamTask({
    ...base,
    memberId: f.coordinator.memberId,
    generation: f.coordinator.generation,
    requestId: "coordinator-create",
  });
  assert.throws(
    () =>
      f.engine.claimTeamTask({
        workspaceId: f.workspace.id,
        teamId: f.created.record.id,
        taskId: created.record.taskId,
        memberId: member.memberId,
        generation: member.generation,
        requestId: "no-claim",
        expectedRevision: created.record.revision,
      }),
    failure("TEAM_PERMISSION"),
  );
  assert.throws(
    () =>
      f.engine.putTeamTask({
        ...base,
        memberId: f.coordinator.memberId,
        generation: f.coordinator.generation,
        requestId: "self-dependent",
        expectedRevision: created.record.revision,
        dependencies: [created.record.taskId],
      }),
    failure("TEAM_DEPENDENCY"),
  );
  assert.throws(
    () =>
      f.engine.putTeamTask({
        ...base,
        memberId: f.coordinator.memberId,
        generation: f.coordinator.generation,
        requestId: "stale-revise",
      }),
    failure("TEAM_STALE"),
  );
  assert.deepEqual(
    f.engine.getTeamTask(
      f.workspace.id,
      f.created.record.id,
      created.record.taskId,
    ),
    created.record,
  );
  assert.deepEqual(f.codingCounts(), before);
});

test("confirmed closed original child can retire into immutable history and a new actual child receives a separate member generation with old pages denied", async (t) => {
  const f = await nativeTeam(t),
    first = await f.child("renewable-worker");
  f.send(
    first.member.memberId,
    first.member.generation,
    "Old generation data.",
    "old-generation-message",
  );
  const oldPage = f.read(first.member.memberId, first.member.generation),
    oldRun = first.member.owner.runId;
  f.childReleases[0]!.resolve();
  assert.equal(
    (await f.engine.children.tasks.wait(f.session.id, first.task.id)).state,
    "completed",
  );
  const retired = f.engine.retireTeamMember({
    workspaceId: f.workspace.id,
    teamId: f.created.record.id,
    memberId: first.member.memberId,
    generation: first.member.generation,
    expectedRevision: first.member.revision,
    requestId: "retire-confirmed",
  });
  assert.equal(retired.record.status, "retired");
  assert.equal(retired.record.owner.cleanup, "confirmed");
  assert.equal(retired.record.previousId, first.member.id);
  // A second actual child has a fresh original execution and its own unconsumed producer gate.
  const second = await f.startChild(),
    preview = f.engine.previewTeamMember({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: first.member.memberId,
      expectedRevision: retired.record.revision,
      role: "worker",
      permissions: workerPermissions,
      expiresAt: f.expiresAt,
      rootSessionId: f.session.id,
      childTaskId: second.task.id,
    }),
    joined = f.engine.joinTeamMember({
      workspaceId: f.workspace.id,
      requestId: "renew-confirmed-member",
      approved: true,
      preview,
    });
  assert.equal(joined.record.generation, first.member.generation + 1);
  assert.notEqual(joined.record.owner.runId, oldRun);
  assert.equal(joined.record.owner.childTaskId, second.task.id);
  assert.throws(
    () =>
      f.engine.claimAgentMailbox({
        workspaceId: f.workspace.id,
        requestId: "old-generation-claim",
        page: oldPage,
        expectedCursorRevision: oldPage.cursor.revision,
      }),
    failure("TEAM_STALE", "TEAM_OWNER_STALE", "TEAM_MEMBER_INACTIVE"),
  );
  assert.equal(
    readDatabase(
      f.dbPath,
      (db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM team_messages WHERE recipient_member_id=? AND recipient_generation=?",
          )
          .get(first.member.memberId, first.member.generation)!.n,
    ),
    1,
  );
});
