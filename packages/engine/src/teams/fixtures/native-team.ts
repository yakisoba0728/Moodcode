import type { TestContext } from "node:test";
import type { TeamPermissions, TeamRole } from "../types.js";
import { teamFixture, type TeamFixtureOptions } from "./engine-team.js";

export const coordinatorPermissions: TeamPermissions = {
  send: true,
  receive: true,
  claimTasks: true,
  manageTasks: true,
};
export const workerPermissions: TeamPermissions = {
  send: true,
  receive: true,
  claimTasks: true,
  manageTasks: false,
};
export async function nativeTeam(
  t: TestContext,
  options: TeamFixtureOptions = {},
) {
  const f = await teamFixture(t, {
      ...options,
      engine: { ...options.engine, teams: true },
    }),
    parent = await f.startParent(),
    expiresAt = new Date(Date.now() + 60000).toISOString();
  const input = {
      workspaceId: f.workspace.id,
      requestId: "actual-team-create",
      teamId: "actual-native-team",
      expiresAt,
    },
    created = f.engine.createTeam(input);
  function join(
    memberId: string,
    role: TeamRole,
    permissions: TeamPermissions,
    childTaskId?: string,
    expectedRevision = 0,
  ) {
    const preview = f.engine.previewTeamMember({
      workspaceId: f.workspace.id,
      teamId: created.record.id,
      memberId,
      expectedRevision,
      role,
      permissions,
      expiresAt,
      rootSessionId: f.session.id,
      ...(childTaskId ? { childTaskId } : {}),
    });
    return {
      preview,
      result: f.engine.joinTeamMember({
        workspaceId: f.workspace.id,
        requestId: `actual-team-join-${memberId}-${expectedRevision}`,
        approved: true,
        preview,
      }),
    };
  }
  const coordinator = join(
    "actual-coordinator",
    "coordinator",
    coordinatorPermissions,
  ).result.record;
  async function child(
    memberId = "actual-worker",
    permissions = workerPermissions,
  ) {
    const execution = await f.startChild();
    const admitted = join(memberId, "worker", permissions, execution.task.id);
    return { ...execution, ...admitted, member: admitted.result.record };
  }
  function send(
    recipientMemberId: string,
    recipientGeneration: number,
    text = "Actual untrusted native message.",
    requestId = "actual-message",
  ) {
    return f.engine.sendAgentMessage({
      workspaceId: f.workspace.id,
      teamId: created.record.id,
      senderMemberId: coordinator.memberId,
      senderGeneration: coordinator.generation,
      recipientMemberId,
      recipientGeneration,
      requestId,
      text,
      expiresAt,
    });
  }
  function read(memberId: string, generation: number, limit?: number) {
    return f.engine.readAgentMailbox({
      workspaceId: f.workspace.id,
      teamId: created.record.id,
      memberId,
      generation,
      ...(limit === undefined ? {} : { limit }),
    });
  }
  return {
    ...f,
    parent,
    expiresAt,
    created,
    createInput: input,
    coordinator,
    join,
    child,
    send,
    read,
  };
}
