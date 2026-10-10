import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonObject } from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import type { ToolContext } from "../ports.js";
import type { TeamMemberRevision, TeamTaskRevision } from "./types.js";
import { TeamWorkflowBoard, teamBoardKind } from "./workflow-board.js";

const sha = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function member(
  memberId: string,
  role: "coordinator" | "worker",
  rootSessionId: string,
) {
  return {
    workspaceId: "workspace",
    teamId: "team",
    memberId,
    generation: 1,
    role,
    permissions: {
      send: true,
      receive: true,
      claimTasks: true,
      manageTasks: role === "coordinator",
    },
    owner: { rootSessionId, sha256: sha(`${memberId}-owner`) },
    sha256: sha(memberId),
  } as unknown as TeamMemberRevision;
}
function context(sessionId: string, toolCallId: string) {
  return {
    sessionId,
    runId: `${sessionId}-run`,
    turnId: `${sessionId}-turn`,
    attemptId: `${sessionId}-attempt`,
    toolCallId,
  } as ToolContext;
}

test("a coordinator in another root session reviews the claimant's board document in the claimant's root session", () => {
  const coordinator = member("coordinator", "coordinator", "session-a"),
    worker = member("worker", "worker", "session-b"),
    members = new Map([coordinator, worker].map((m) => [m.memberId, m])),
    task = {
      id: "task-revision",
      workspaceId: "workspace",
      teamId: "team",
      taskId: "shared-task",
      revision: 2,
      title: "Shared task",
      description: "Claimed from another root session",
      dependencies: [],
      state: "claimed",
      owner: {
        memberId: worker.memberId,
        generation: worker.generation,
        memberRevisionId: "worker-revision",
        memberSha256: worker.sha256,
      },
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      sha256: sha("task"),
    } as unknown as TeamTaskRevision,
    documents = new Map<string, { revision: number; data: JsonObject }>(),
    completed: unknown[] = [];
  const engine = {
    getTeamTask: () => task,
    getTeamMember: (_ws: string, _team: string, memberId: string) =>
      members.get(memberId),
    readTeamTaskPage: () => ({
      tasks: [task],
      hasMore: false,
      nextTaskId: null,
    }),
    store: {
      getSessionDocument: (sessionId: string, kind: string) =>
        documents.get(`${sessionId}/${kind}`) ?? null,
      commitTeamWorkflow(
        sessionId: string,
        kind: string,
        revision: number,
        data: JsonObject,
        effect: () => void,
      ) {
        const key = `${sessionId}/${kind}`;
        assert.equal(documents.get(key)?.revision ?? 0, revision);
        effect();
        documents.set(key, { revision: revision + 1, data });
      },
    },
  } as unknown as MoodcodeEngine;
  const board = new TeamWorkflowBoard(engine, (input) => completed.push(input)),
    kind = teamBoardKind("team", "shared-task");
  const submitted = board.invoke(
    worker,
    "submit_team_task",
    {
      requestId: "worker-submit",
      taskId: "shared-task",
      expectedRevision: 2,
      text: "Submitted from root session B.",
    },
    context("session-b", "submit-call"),
    sha("submit-request"),
    sha("submit-approval"),
  );
  const review = {
    requestId: "coordinator-review",
    taskId: "shared-task",
    expectedRevision: 2,
    submissionId: submitted.submissionId as string,
    verdict: "accept",
    text: "Reviewed from root session A.",
  };
  assert.equal(
    board.prepare(coordinator, "review_team_task", review).submissionId,
    submitted.submissionId,
  );
  const reviewed = board.invoke(
    coordinator,
    "review_team_task",
    review,
    context("session-a", "review-call"),
    sha("review-request"),
    sha("review-approval"),
  );
  assert.equal(reviewed.state, "reviewed");
  assert.equal(documents.has(`session-a/${kind}`), false);
  const stored = documents.get(`session-b/${kind}`)!;
  assert.equal(stored.revision, 2);
  assert.equal(stored.data.rootSessionId, "session-b");
  assert.deepEqual(completed, [
    {
      workspaceId: "workspace",
      teamId: "team",
      memberId: "worker",
      generation: 1,
      taskId: "shared-task",
      expectedRevision: 2,
      requestId: `review-accept:${submitted.submissionId}`,
    },
  ]);
  const workflow = (
    board.read(coordinator).tasks as { workflow: JsonObject }[]
  )[0]!.workflow as { state: string; latest: { review: JsonObject } };
  assert.equal(workflow.state, "reviewed");
  assert.equal(workflow.latest.review.verdict, "accept");
});
