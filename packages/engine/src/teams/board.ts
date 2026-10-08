import { randomUUID } from "node:crypto";
import { knowledgeHash } from "../knowledge/validation.js";
import type { TeamStorage } from "./store.js";
import type { PutTeamTaskInput, TeamTaskRevision } from "./types.js";
import {
  teamError,
  teamHash,
  teamId,
  teamInteger,
  teamObject,
  validateTeamTask,
} from "./validation.js";
export function putTask(
  s: TeamStorage,
  original: object,
  input: PutTeamTaskInput,
) {
  const r = teamObject(input, [
    "workspaceId",
    "teamId",
    "memberId",
    "generation",
    "taskId",
    "requestId",
    "expectedRevision",
    "title",
    "description",
    "dependencies",
    "expiresAt",
  ]);
  for (const k of ["workspaceId", "teamId", "memberId", "taskId", "requestId"])
    teamId(r[k]);
  teamInteger(r.expectedRevision);
  const generation = teamInteger(r.generation);
  const ws = r.workspaceId as string,
    team = r.teamId as string,
    task = r.taskId as string,
    request = r.requestId as string,
    sha = knowledgeHash(r);
  const duplicate = s.receipt(
    ws,
    team,
    r.memberId as string,
    generation,
    request,
    sha,
  );
  if (duplicate)
    return Object.freeze({
      record: s.readRevision(ws, duplicate.recordId) as TeamTaskRevision,
      receipt: duplicate,
      duplicate: true,
    });
  return s.tx(() => {
    const member = s.activeMember(
      original,
      ws,
      team,
      r.memberId as string,
      generation,
    );
    if (!member.permissions.manageTasks) teamError("TEAM_PERMISSION");
    const current = s.getTask(ws, team, task);
    if (
      (current?.revision ?? 0) !== r.expectedRevision ||
      current?.state === "claimed" ||
      current?.state === "completed"
    )
      teamError("TEAM_STALE");
    if (
      !current &&
      Number(
        s.db
          .prepare(
            "SELECT count(*) AS n FROM team_state_heads WHERE team_id=? AND kind='task'",
          )
          .get(team)!.n,
      ) >= 128
    )
      teamError("TEAM_LIMIT");
    if (!Array.isArray(r.dependencies) || r.dependencies.length > 32)
      teamError("TEAM_LIMIT");
    const deps = r.dependencies.map((value) => {
      const id = teamId(value),
        dep = s.getTask(ws, team, id);
      if (id === task || !dep) teamError("TEAM_DEPENDENCY");
      return { taskId: id, revisionId: dep.id, sha256: dep.sha256 };
    });
    if (new Set(deps.map((d) => d.taskId)).size !== deps.length)
      teamError("TEAM_DEPENDENCY");
    const record = validateTeamTask(
      teamHash({
        id: randomUUID(),
        workspaceId: ws,
        teamId: team,
        taskId: task,
        revision: (current?.revision ?? 0) + 1,
        previousId: current?.id ?? null,
        title: r.title,
        description: r.description,
        dependencies: deps,
        state: "pending",
        owner: null,
        expiresAt: s.expiry(
          r.expiresAt as string,
          s.activeTeam(ws, team).expiresAt,
        ),
        createdAt: s.stamp(),
      }),
    );
    s.append("task", task, record, current);
    return Object.freeze({
      record,
      receipt: s.putReceipt(
        ws,
        team,
        member.memberId,
        member.generation,
        request,
        sha,
        "task",
        record.id,
        record.sha256,
      ),
      duplicate: false,
    });
  });
}
type ClaimInput = {
  workspaceId: string;
  teamId: string;
  memberId: string;
  generation: number;
  taskId: string;
  requestId: string;
  expectedRevision: number;
};
export function claimTask(s: TeamStorage, original: object, input: ClaimInput) {
  const r = teamObject(input, [
      "workspaceId",
      "teamId",
      "memberId",
      "generation",
      "taskId",
      "requestId",
      "expectedRevision",
    ]),
    ws = teamId(r.workspaceId),
    team = teamId(r.teamId),
    memberId = teamId(r.memberId),
    taskId = teamId(r.taskId),
    request = teamId(r.requestId),
    generation = teamInteger(r.generation),
    sha = knowledgeHash(r),
    dup = s.receipt(ws, team, memberId, generation, request, sha);
  if (dup)
    return Object.freeze({
      record: s.readRevision(ws, dup.recordId) as TeamTaskRevision,
      receipt: dup,
      duplicate: true,
    });
  return s.tx(() => {
    const m = s.activeMember(original, ws, team, memberId, generation),
      prior = s.getTask(ws, team, taskId);
    if (!m.permissions.claimTasks) teamError("TEAM_PERMISSION");
    if (
      !prior ||
      prior.revision !== r.expectedRevision ||
      prior.state !== "pending" ||
      Date.parse(prior.expiresAt) <= s.now()
    )
      teamError("TEAM_STALE");
    for (const d of prior.dependencies) {
      const actual = s.getTask(ws, team, d.taskId);
      if (
        !actual ||
        actual.id !== d.revisionId ||
        actual.sha256 !== d.sha256 ||
        actual.state !== "completed"
      )
        teamError("TEAM_DEPENDENCY");
    }
    const { sha256, ...body } = prior,
      record = validateTeamTask(
        teamHash({
          ...body,
          id: randomUUID(),
          revision: prior.revision + 1,
          previousId: prior.id,
          state: "claimed",
          owner: {
            memberId,
            generation,
            memberRevisionId: m.id,
            memberSha256: m.sha256,
          },
          createdAt: s.stamp(),
        }),
      );
    s.append("task", taskId, record, prior);
    return Object.freeze({
      record,
      receipt: s.putReceipt(
        ws,
        team,
        memberId,
        generation,
        request,
        sha,
        "claim-task",
        record.id,
        record.sha256,
      ),
      duplicate: false,
    });
  });
}
export function completeTask(
  s: TeamStorage,
  original: object,
  input: ClaimInput,
) {
  const r = teamObject(input, [
      "workspaceId",
      "teamId",
      "memberId",
      "generation",
      "taskId",
      "requestId",
      "expectedRevision",
    ]),
    ws = teamId(r.workspaceId),
    team = teamId(r.teamId),
    member = teamId(r.memberId),
    generation = teamInteger(r.generation),
    request = teamId(r.requestId),
    sha = knowledgeHash({ ...r, operation: "complete" }),
    dup = s.receipt(ws, team, member, generation, request, sha);
  if (dup)
    return Object.freeze({
      record: s.readRevision(ws, dup.recordId) as TeamTaskRevision,
      receipt: dup,
      duplicate: true,
    });
  return s.tx(() => {
    const actual = s.activeMember(original, ws, team, member, generation),
      prior = s.getTask(ws, team, teamId(r.taskId));
    if (
      !prior ||
      prior.revision !== r.expectedRevision ||
      prior.state !== "claimed" ||
      prior.owner?.memberRevisionId !== actual.id ||
      prior.owner.memberSha256 !== actual.sha256
    )
      teamError("TEAM_STALE");
    const { sha256, ...body } = prior,
      record = validateTeamTask(
        teamHash({
          ...body,
          id: randomUUID(),
          revision: prior.revision + 1,
          previousId: prior.id,
          state: "completed",
          createdAt: s.stamp(),
        }),
      );
    s.append("task", record.taskId, record, prior);
    return Object.freeze({
      record,
      receipt: s.putReceipt(
        ws,
        team,
        member,
        generation,
        request,
        sha,
        "task",
        record.id,
        record.sha256,
      ),
      duplicate: false,
    });
  });
}
