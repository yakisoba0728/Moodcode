import { EngineError } from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
  validateBinding,
} from "../knowledge/validation.js";
import type {
  AgentMessage,
  TeamMailboxCursor,
  TeamMemberOwnerProof,
  TeamMemberRevision,
  TeamOperationReceipt,
  TeamRecord,
  TeamTaskRevision,
} from "./types.js";
export const TEAM_LIMITS = Object.freeze({
  rowBytes: 65536,
  messageBytes: 4096,
  pageBytes: 65536,
  deliveryPageBytes: 49152,
  pageItems: 64,
  teams: 8,
  members: 32,
  tasks: 128,
  pendingMessages: 256,
  pendingBytes: 1048576,
  ttlMs: 3600000,
  owners: 32,
  frontierBytes: 1048576,
});
export function teamError(code = "INVALID_TEAM"): never {
  throw new EngineError(
    code,
    "Team records require exact workspace, membership generation and native ownership",
  );
}
/** Immutable knowledge JSON within a serialized byte bound; walker errors propagate unless onInvalid maps them. */
export function boundedTeamJson<T>(
  value: T,
  maximum: number,
  onLimit: () => never,
  onInvalid?: () => never,
): T {
  let result: T;
  try {
    result = immutableKnowledgeJson(value);
  } catch (error) {
    if (!onInvalid) throw error;
    return onInvalid();
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maximum) onLimit();
  return result;
}
export function teamJson<T>(value: T): T {
  return boundedTeamJson(
    value,
    TEAM_LIMITS.rowBytes,
    () => teamError("TEAM_LIMIT"),
    () => teamError("INVALID_TEAM"),
  );
}
export function teamObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const r = teamJson(value);
  if (!r || typeof r !== "object" || Array.isArray(r)) teamError();
  const record = r as Record<string, unknown>;
  if (
    required.some((k) => !Object.hasOwn(record, k)) ||
    Object.keys(record).some(
      (k) => !required.includes(k) && !optional.includes(k),
    )
  )
    teamError();
  return record;
}
export function teamId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    teamError();
  return value;
}
export function teamInteger(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  )
    teamError("TEAM_LIMIT");
  return value as number;
}
export function teamSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) teamError();
  return value;
}
export function teamDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    teamError();
  return value;
}
export function teamText(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    teamError("TEAM_LIMIT");
  return value;
}
export function teamHash<T extends object>(
  value: T,
): T & { readonly sha256: string } {
  return teamJson({ ...value, sha256: knowledgeHash(value) });
}
export function teamCheckHash(r: Record<string, unknown>): void {
  const { sha256, ...body } = r;
  if (teamSha(sha256) !== knowledgeHash(body)) teamError("TEAM_HASH_MISMATCH");
}
export function validateTeam(value: unknown): TeamRecord {
  const r = teamObject(value, [
    "id",
    "workspaceId",
    "revision",
    "binding",
    "status",
    "expiresAt",
    "createdAt",
    "updatedAt",
    "archiveSha256",
    "sha256",
  ]);
  teamId(r.id);
  teamId(r.workspaceId);
  if (!teamInteger(r.revision)) teamError();
  const binding = validateBinding(r.binding);
  if (
    binding.workspaceId !== r.workspaceId ||
    !["active", "closed", "paused-import"].includes(r.status as string) ||
    (r.status === "paused-import") !== (r.archiveSha256 !== null)
  )
    teamError();
  if (r.archiveSha256 !== null) teamSha(r.archiveSha256);
  for (const k of ["expiresAt", "createdAt", "updatedAt"]) teamDate(r[k]);
  teamCheckHash(r);
  return r as unknown as TeamRecord;
}
export function validateTeamOwner(value: unknown): TeamMemberOwnerProof {
  const r = teamObject(value, [
    "kind",
    "workspaceId",
    "sessionId",
    "runId",
    "rootSessionId",
    "rootRunId",
    "childTaskId",
    "childTaskFingerprint",
    "childStorageSha256",
    "worktreeId",
    "ownerEpoch",
    "cleanup",
    "sha256",
  ]);
  for (const k of [
    "workspaceId",
    "sessionId",
    "runId",
    "rootSessionId",
    "rootRunId",
    "ownerEpoch",
  ])
    teamId(r[k]);
  if (
    !["root", "child"].includes(r.kind as string) ||
    !["live", "confirmed", "unknown"].includes(r.cleanup as string)
  )
    teamError();
  for (const k of [
    "childTaskId",
    "childTaskFingerprint",
    "childStorageSha256",
    "worktreeId",
  ])
    if (r.kind === "root" ? r[k] !== null : r[k] === null) teamError();
  if (r.kind === "child") {
    teamId(r.childTaskId);
    teamId(r.worktreeId);
    teamSha(r.childTaskFingerprint);
    teamSha(r.childStorageSha256);
  } else if (r.sessionId !== r.rootSessionId || r.runId !== r.rootRunId)
    teamError();
  teamCheckHash(r);
  return r as unknown as TeamMemberOwnerProof;
}
export function validateTeamMember(value: unknown): TeamMemberRevision {
  const r = teamObject(value, [
    "id",
    "workspaceId",
    "teamId",
    "memberId",
    "generation",
    "revision",
    "previousId",
    "role",
    "permissions",
    "owner",
    "status",
    "expiresAt",
    "createdAt",
    "sha256",
  ]);
  for (const k of ["id", "workspaceId", "teamId", "memberId"]) teamId(r[k]);
  if (!teamInteger(r.generation) || !teamInteger(r.revision)) teamError();
  if (r.previousId !== null) teamId(r.previousId);
  if (
    (r.revision === 1) !== (r.previousId === null) ||
    !["coordinator", "worker", "observer"].includes(r.role as string) ||
    !["active", "retired", "uncertain"].includes(r.status as string)
  )
    teamError();
  const p = teamObject(r.permissions, [
    "send",
    "receive",
    "claimTasks",
    "manageTasks",
  ]);
  if (
    Object.values(p).some((v) => typeof v !== "boolean") ||
    (r.role === "observer" && (p.send || p.claimTasks || p.manageTasks)) ||
    (r.role !== "coordinator" && p.manageTasks)
  )
    teamError("TEAM_PERMISSION");
  validateTeamOwner(r.owner);
  teamDate(r.expiresAt);
  teamDate(r.createdAt);
  teamCheckHash(r);
  return r as unknown as TeamMemberRevision;
}
export function validateTeamTask(value: unknown): TeamTaskRevision {
  const r = teamObject(value, [
    "id",
    "workspaceId",
    "teamId",
    "taskId",
    "revision",
    "previousId",
    "title",
    "description",
    "dependencies",
    "state",
    "owner",
    "expiresAt",
    "createdAt",
    "sha256",
  ]);
  for (const k of ["id", "workspaceId", "teamId", "taskId"]) teamId(r[k]);
  if (
    !teamInteger(r.revision) ||
    (r.revision === 1) !== (r.previousId === null)
  )
    teamError();
  if (r.previousId !== null) teamId(r.previousId);
  teamText(r.title, 512);
  teamText(r.description, 4096);
  if (
    !Array.isArray(r.dependencies) ||
    r.dependencies.length > 32 ||
    !["pending", "claimed", "completed", "cancelled"].includes(
      r.state as string,
    )
  )
    teamError();
  const seen = new Set<string>();
  for (const d of r.dependencies) {
    const p = teamObject(d, ["taskId", "revisionId", "sha256"]);
    if (teamId(p.taskId) === r.taskId || seen.has(p.taskId as string))
      teamError();
    seen.add(p.taskId as string);
    teamId(p.revisionId);
    teamSha(p.sha256);
  }
  if (r.owner !== null) {
    const o = teamObject(r.owner, [
      "memberId",
      "generation",
      "memberRevisionId",
      "memberSha256",
    ]);
    teamId(o.memberId);
    teamId(o.memberRevisionId);
    if (!teamInteger(o.generation)) teamError();
    teamSha(o.memberSha256);
  }
  if (
    ["claimed", "completed"].includes(r.state as string) !==
    (r.owner !== null)
  )
    teamError();
  teamDate(r.expiresAt);
  teamDate(r.createdAt);
  teamCheckHash(r);
  return r as unknown as TeamTaskRevision;
}
export function validateAgentMessage(value: unknown): AgentMessage {
  const r = teamObject(value, [
    "id",
    "workspaceId",
    "teamId",
    "senderMemberId",
    "senderGeneration",
    "senderRevisionId",
    "recipientMemberId",
    "recipientGeneration",
    "recipientRevisionId",
    "seq",
    "text",
    "bytes",
    "requestId",
    "requestSha256",
    "expiresAt",
    "createdAt",
    "sha256",
  ]);
  for (const k of [
    "id",
    "workspaceId",
    "teamId",
    "senderMemberId",
    "senderRevisionId",
    "recipientMemberId",
    "recipientRevisionId",
    "requestId",
  ])
    teamId(r[k]);
  for (const k of ["senderGeneration", "recipientGeneration", "seq"])
    if (!teamInteger(r[k])) teamError();
  if (Buffer.byteLength(teamText(r.text, 4096)) !== teamInteger(r.bytes, 4096))
    teamError();
  teamSha(r.requestSha256);
  teamDate(r.expiresAt);
  teamDate(r.createdAt);
  teamCheckHash(r);
  return r as unknown as AgentMessage;
}
export function validateTeamCursor(value: unknown): TeamMailboxCursor {
  const r = teamObject(value, [
    "workspaceId",
    "teamId",
    "memberId",
    "generation",
    "revision",
    "admittedSeq",
    "claimedSeq",
    "pendingDeliveryId",
    "sha256",
  ]);
  for (const k of ["workspaceId", "teamId", "memberId"]) teamId(r[k]);
  if (
    !teamInteger(r.generation) ||
    !teamInteger(r.revision) ||
    teamInteger(r.claimedSeq) > teamInteger(r.admittedSeq)
  )
    teamError();
  if (r.pendingDeliveryId !== null) teamId(r.pendingDeliveryId);
  teamCheckHash(r);
  return r as unknown as TeamMailboxCursor;
}
export function validateTeamReceipt(value: unknown): TeamOperationReceipt {
  const r = teamObject(
    value,
    [
      "id",
      "workspaceId",
      "teamId",
      "actorId",
      "actorGeneration",
      "requestId",
      "requestSha256",
      "operation",
      "recordId",
      "recordSha256",
      "createdAt",
      "sha256",
    ],
    ["claimProof"],
  );
  for (const k of [
    "id",
    "workspaceId",
    "teamId",
    "actorId",
    "requestId",
    "recordId",
  ])
    teamId(r[k]);
  teamInteger(r.actorGeneration);
  teamSha(r.requestSha256);
  teamSha(r.recordSha256);
  if (
    ![
      "create",
      "member",
      "send",
      "claim-mailbox",
      "task",
      "claim-task",
    ].includes(r.operation as string)
  )
    teamError();
  teamDate(r.createdAt);
  if ((r.operation === "claim-mailbox") !== (r.claimProof !== undefined))
    teamError("TEAM_SCOPE_MISMATCH");
  if (r.claimProof !== undefined) {
    const proof = teamObject(r.claimProof, [
      "before",
      "after",
      "messageIds",
      "memberRevisionId",
      "pageSha256",
    ]);
    const before = validateTeamCursor(proof.before),
      after = validateTeamCursor(proof.after);
    teamId(proof.memberRevisionId);
    teamSha(proof.pageSha256);
    if (
      !Array.isArray(proof.messageIds) ||
      !proof.messageIds.length ||
      proof.messageIds.length > 64 ||
      new Set(proof.messageIds).size !== proof.messageIds.length
    )
      teamError();
    for (const message of proof.messageIds) teamId(message);
    if (
      before.workspaceId !== r.workspaceId ||
      after.workspaceId !== r.workspaceId ||
      before.teamId !== r.teamId ||
      after.teamId !== r.teamId ||
      before.memberId !== r.actorId ||
      after.memberId !== r.actorId ||
      before.generation !== r.actorGeneration ||
      after.generation !== r.actorGeneration ||
      before.pendingDeliveryId !== null ||
      after.pendingDeliveryId !== null ||
      after.admittedSeq !== before.admittedSeq ||
      after.revision !== before.revision + 1 ||
      after.claimedSeq !== before.claimedSeq + proof.messageIds.length ||
      after.sha256 !== r.recordSha256 ||
      proof.pageSha256 !== r.recordId
    )
      teamError("TEAM_SCOPE_MISMATCH");
  }
  teamCheckHash(r);
  return r as unknown as TeamOperationReceipt;
}
