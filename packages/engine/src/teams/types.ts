import type { KnowledgeHostBinding } from "../knowledge/types.js";

export type TeamStatus = "active" | "closed" | "paused-import";
export type TeamMemberStatus = "active" | "retired" | "uncertain";
export type TeamRole = "coordinator" | "worker" | "observer";
export interface TeamPermissions {
  readonly send: boolean;
  readonly receive: boolean;
  readonly claimTasks: boolean;
  readonly manageTasks: boolean;
}
export interface TeamRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly binding: KnowledgeHostBinding;
  readonly status: TeamStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archiveSha256: string | null;
  readonly sha256: string;
}
/** Description of an actual owned execution, authenticated only by the host's original handle. */
export interface TeamMemberOwnerProof {
  readonly kind: "root" | "child";
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly rootSessionId: string;
  readonly rootRunId: string;
  readonly childTaskId: string | null;
  readonly childTaskFingerprint: string | null;
  readonly childStorageSha256: string | null;
  readonly worktreeId: string | null;
  readonly ownerEpoch: string;
  readonly cleanup: "live" | "confirmed" | "unknown";
  readonly sha256: string;
}
export interface TeamMemberRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly revision: number;
  readonly previousId: string | null;
  readonly role: TeamRole;
  readonly permissions: TeamPermissions;
  readonly owner: TeamMemberOwnerProof;
  readonly status: TeamMemberStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface TeamTaskRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly title: string;
  readonly description: string;
  readonly dependencies: readonly {
    readonly taskId: string;
    readonly revisionId: string;
    readonly sha256: string;
  }[];
  readonly state: "pending" | "claimed" | "completed" | "cancelled";
  readonly owner: {
    readonly memberId: string;
    readonly generation: number;
    readonly memberRevisionId: string;
    readonly memberSha256: string;
  } | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export type TeamStateRevision =
  TeamRecord | TeamMemberRevision | TeamTaskRevision;
export interface AgentMessage {
  readonly id: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly senderMemberId: string;
  readonly senderGeneration: number;
  readonly senderRevisionId: string;
  readonly recipientMemberId: string;
  readonly recipientGeneration: number;
  readonly recipientRevisionId: string;
  readonly seq: number;
  readonly text: string;
  readonly bytes: number;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface TeamOperationReceipt {
  readonly claimProof?: {
    readonly before: TeamMailboxCursor;
    readonly after: TeamMailboxCursor;
    readonly messageIds: readonly string[];
    readonly memberRevisionId: string;
    readonly pageSha256: string;
  };
  readonly id: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly actorId: string;
  readonly actorGeneration: number;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly operation:
    "create" | "member" | "send" | "claim-mailbox" | "task" | "claim-task";
  readonly recordId: string;
  readonly recordSha256: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface TeamMailboxCursor {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly revision: number;
  readonly admittedSeq: number;
  readonly claimedSeq: number;
  readonly pendingDeliveryId: string | null;
  readonly sha256: string;
}
export interface TeamMailboxPage {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly memberRevisionId: string;
  readonly memberSha256: string;
  readonly cursor: TeamMailboxCursor;
  readonly messages: readonly AgentMessage[];
  readonly bytes: number;
  readonly hasMore: boolean;
  readonly sha256: string;
}
export interface TeamClaimReceipt {
  readonly receipt: TeamOperationReceipt;
  readonly cursor: TeamMailboxCursor;
  readonly messages: readonly AgentMessage[];
  readonly duplicate: boolean;
}
export interface TeamDeliveryCapture {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly deliveryId: string;
  readonly runtimeEpoch: string;
}
export interface TeamDeliveryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly memberRevisionId: string;
  readonly memberSha256: string;
  readonly owner: TeamMemberOwnerProof;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly runtimeEpoch: string;
  readonly state:
    "prepared" | "dispatched" | "delivered" | "cancelled" | "uncertain";
  readonly revision: number;
  readonly page: TeamMailboxPage;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode: string | null;
  readonly sha256: string;
}
export interface TeamAcceptedInputProof {
  readonly sessionId: string;
  readonly runId: string;
  readonly inputId: string;
  readonly requestId: string;
  readonly inputSha256: string;
  readonly admittedSeq: number;
  readonly delivery: "steer" | "queue";
}
export interface TeamDeliveryReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly deliveryId: string;
  readonly deliverySha256: string;
  readonly memberId: string;
  readonly generation: number;
  readonly messagesSha256: string;
  readonly input: TeamAcceptedInputProof;
  readonly cursor: TeamMailboxCursor;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface TeamStoragePorts {
  writeTx<T>(operation: () => T): T;
  getWorkspace(workspaceId: string): {
    readonly id: string;
    readonly root: string;
  };
  checkBinding(workspaceId: string): KnowledgeHostBinding;
  readMemberOwner(original: object): TeamMemberOwnerProof;
  assertMemberOwnerCurrent(original: object, member: TeamMemberRevision): void;
  assertRecipientCurrent(member: TeamMemberRevision): void;
  readAcceptedInput(
    capture: TeamDeliveryCapture,
    original: object,
  ): TeamAcceptedInputProof;
  now?(): number;
}
export interface CreateTeamInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly teamId?: string;
  readonly expiresAt: string;
}
export interface RegisterTeamMemberInput {
  readonly ownerSha256: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly role: TeamRole;
  readonly permissions: TeamPermissions;
  readonly expiresAt: string;
}
export interface SendAgentMessageInput {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly senderMemberId: string;
  readonly senderGeneration: number;
  readonly recipientMemberId: string;
  readonly recipientGeneration: number;
  readonly requestId: string;
  readonly text: string;
  readonly expiresAt: string;
}
export interface PutTeamTaskInput {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly generation: number;
  readonly taskId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly title: string;
  readonly description: string;
  readonly dependencies: readonly string[];
  readonly expiresAt: string;
}
export interface TeamRequestResult<T> {
  readonly record: T;
  readonly receipt: TeamOperationReceipt;
  readonly duplicate: boolean;
}
