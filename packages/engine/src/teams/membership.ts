import { randomUUID } from "node:crypto";
import { knowledgeHash, validateBinding } from "../knowledge/validation.js";
import type { TeamStorage } from "./store.js";
import type {
  CreateTeamInput,
  RegisterTeamMemberInput,
  TeamMemberRevision,
  TeamRecord,
} from "./types.js";
import {
  TEAM_LIMITS,
  teamError,
  teamHash,
  teamId,
  teamInteger,
  teamObject,
  teamSha,
  validateTeam,
  validateTeamCursor,
  validateTeamMember,
  validateTeamOwner,
} from "./validation.js";
export function createTeam(s: TeamStorage, input: CreateTeamInput) {
  const r = teamObject(
    input,
    ["workspaceId", "requestId", "expiresAt"],
    ["teamId"],
  );
  const ws = teamId(r.workspaceId),
    request = teamId(r.requestId),
    team =
      r.teamId === undefined
        ? `team_${knowledgeHash({ workspaceId: ws, requestId: request }).slice(0, 32)}`
        : teamId(r.teamId),
    sha = knowledgeHash(r);
  const duplicate = s.receipt(ws, team, "host", 0, request, sha);
  if (duplicate) {
    const record = s.readRevision(ws, duplicate.recordId) as TeamRecord;
    if (record.sha256 !== duplicate.recordSha256)
      teamError("TEAM_SCOPE_MISMATCH");
    return Object.freeze({ record, receipt: duplicate, duplicate: true });
  }
  return s.tx(() => {
    if (s.getTeam(ws, team)) teamError("TEAM_EXISTS");
    const count = s.db
      .prepare(
        "SELECT count(*) AS n FROM team_state_heads WHERE workspace_id=? AND kind='team'",
      )
      .get(ws)!.n;
    if (Number(count) >= TEAM_LIMITS.teams) teamError("TEAM_LIMIT");
    const binding = validateBinding(s.ports.checkBinding(ws)),
      workspace = s.ports.getWorkspace(ws);
    if (
      binding.workspaceId !== ws ||
      workspace.id !== ws ||
      workspace.root !== binding.root
    )
      teamError("TEAM_BINDING_STALE");
    const now = s.stamp(),
      record = validateTeam(
        teamHash({
          id: team,
          workspaceId: ws,
          revision: 1,
          binding,
          status: "active",
          expiresAt: s.expiry(r.expiresAt as string),
          createdAt: now,
          updatedAt: now,
          archiveSha256: null,
        }),
      );
    const row = s.append("team", team, record, undefined),
      receipt = s.putReceipt(
        ws,
        team,
        "host",
        0,
        request,
        sha,
        "create",
        row,
        record.sha256,
      );
    return Object.freeze({ record, receipt, duplicate: false });
  });
}
export function registerMember(
  s: TeamStorage,
  original: object,
  input: RegisterTeamMemberInput,
) {
  const r = teamObject(input, [
    "workspaceId",
    "teamId",
    "memberId",
    "requestId",
    "expectedRevision",
    "role",
    "permissions",
    "expiresAt",
    "ownerSha256",
  ]);
  for (const k of ["workspaceId", "teamId", "memberId", "requestId"])
    teamId(r[k]);
  teamInteger(r.expectedRevision);
  teamSha(r.ownerSha256);
  const sha = knowledgeHash(r),
    duplicate = s.receipt(
      r.workspaceId as string,
      r.teamId as string,
      "host",
      0,
      r.requestId as string,
      sha,
    );
  if (duplicate) {
    const record = s.readRevision(
      r.workspaceId as string,
      duplicate.recordId,
    ) as TeamMemberRevision;
    if (!record || record.sha256 !== duplicate.recordSha256)
      teamError("TEAM_SCOPE_MISMATCH");
    return Object.freeze({ record, receipt: duplicate, duplicate: true });
  }
  return s.tx(() => {
    const team = s.activeTeam(r.workspaceId as string, r.teamId as string),
      prior = s.getMember(team.workspaceId, team.id, r.memberId as string);
    if ((prior?.revision ?? 0) !== r.expectedRevision) teamError("TEAM_STALE");
    if (
      prior &&
      (prior.status !== "retired" || prior.owner.cleanup !== "confirmed")
    )
      teamError("TEAM_OWNER_UNSETTLED");
    if (
      prior &&
      s.db
        .prepare(
          "SELECT 1 AS blocked FROM team_deliveries WHERE team_id=? AND member_id=? AND generation=? AND state IN ('prepared','dispatched','uncertain') LIMIT 1",
        )
        .get(team.id, prior.memberId, prior.generation)
    )
      teamError("TEAM_DELIVERY_UNCERTAIN");
    if (
      !prior &&
      Number(
        s.db
          .prepare(
            "SELECT count(*) AS n FROM team_state_heads WHERE team_id=? AND kind='member'",
          )
          .get(team.id)!.n,
      ) >= 32
    )
      teamError("TEAM_LIMIT");
    const owner = validateTeamOwner(s.ports.readMemberOwner(original));
    s.assertOwnerUnquarantined(team.workspaceId, owner);
    if (owner.sha256 !== r.ownerSha256) teamError("TEAM_REQUEST_CONFLICT");
    if (
      owner.cleanup !== "live" ||
      (owner.kind === "root" && owner.workspaceId !== team.workspaceId)
    )
      teamError("TEAM_OWNER_STALE");
    const record = validateTeamMember(
      teamHash({
        id: randomUUID(),
        workspaceId: team.workspaceId,
        teamId: team.id,
        memberId: r.memberId,
        generation: (prior?.generation ?? 0) + 1,
        revision: (prior?.revision ?? 0) + 1,
        previousId: prior?.id ?? null,
        role: r.role,
        permissions: r.permissions,
        owner,
        status: "active",
        expiresAt: s.expiry(r.expiresAt as string, team.expiresAt),
        createdAt: s.stamp(),
      }),
    );
    const result = s.ports.assertMemberOwnerCurrent(original, record);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      teamError("TEAM_OWNER_INVALID");
    }
    s.expiry(record.expiresAt, team.expiresAt);
    s.append("member", record.memberId, record, prior);
    const cursor = validateTeamCursor(
      teamHash({
        workspaceId: record.workspaceId,
        teamId: record.teamId,
        memberId: record.memberId,
        generation: record.generation,
        revision: 1,
        admittedSeq: 0,
        claimedSeq: 0,
        pendingDeliveryId: null,
      }),
    );
    s.db
      .prepare(
        "INSERT INTO team_mailbox_cursors(workspace_id,team_id,member_id,generation,revision,admitted_seq,claimed_seq,pending_delivery_id,data) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        cursor.workspaceId,
        cursor.teamId,
        cursor.memberId,
        cursor.generation,
        1,
        0,
        0,
        null,
        JSON.stringify(cursor),
      );
    const receipt = s.putReceipt(
      record.workspaceId,
      record.teamId,
      "host",
      0,
      r.requestId as string,
      sha,
      "member",
      record.id,
      record.sha256,
    );
    return Object.freeze({ record, receipt, duplicate: false });
  });
}
export function retireMember(
  s: TeamStorage,
  original: object,
  input: {
    workspaceId: string;
    teamId: string;
    memberId: string;
    generation: number;
    expectedRevision: number;
    requestId: string;
  },
) {
  const r = teamObject(input, [
      "workspaceId",
      "teamId",
      "memberId",
      "generation",
      "expectedRevision",
      "requestId",
    ]),
    ws = teamId(r.workspaceId),
    team = teamId(r.teamId),
    member = teamId(r.memberId),
    generation = teamInteger(r.generation),
    request = teamId(r.requestId),
    sha = knowledgeHash(r);
  const duplicate = s.receipt(ws, team, "host", 0, request, sha);
  if (duplicate) {
    const record = s.readRevision(ws, duplicate.recordId) as TeamMemberRevision;
    return Object.freeze({ record, receipt: duplicate, duplicate: true });
  }
  return s.tx(() => {
    s.activeTeam(ws, team);
    const prior = s.getMember(ws, team, member);
    if (
      !prior ||
      prior.generation !== generation ||
      prior.revision !== r.expectedRevision ||
      prior.status !== "active"
    )
      teamError("TEAM_STALE");
    const owner = validateTeamOwner(s.ports.readMemberOwner(original));
    const { sha256: _old, cleanup: _before, ...a } = prior.owner,
      { sha256: _new, cleanup: _after, ...b } = owner;
    if (knowledgeHash(a) !== knowledgeHash(b)) teamError("TEAM_OWNER_STALE");
    s.ports.assertMemberOwnerCurrent(original, prior);
    const { sha256, ...body } = prior,
      record = validateTeamMember(
        teamHash({
          ...body,
          id: randomUUID(),
          revision: prior.revision + 1,
          previousId: prior.id,
          status: owner.cleanup === "unknown" ? "uncertain" : "retired",
          owner,
          createdAt: s.stamp(),
        }),
      );
    s.append("member", member, record, prior);
    return Object.freeze({
      record,
      receipt: s.putReceipt(
        ws,
        team,
        "host",
        0,
        request,
        sha,
        "member",
        record.id,
        record.sha256,
      ),
      duplicate: false,
    });
  });
}
