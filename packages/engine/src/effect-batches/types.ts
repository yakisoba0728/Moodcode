import type { JsonObject } from "@moodcode/contracts";
export interface PreparedResourceClaim {
  readonly version: 1;
  readonly producer: "physical-patch";
  readonly workspaceId: string;
  readonly root: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly sourceSha256: string;
  readonly physicalPinsSha256: string;
  readonly files: readonly {
    path: string;
    device: string;
    inode: string;
    beforeHash: string;
    afterHash: string;
  }[];
  readonly parents: readonly { path: string; device: string; inode: string }[];
  readonly sha256: string;
}
export type EffectMemberState =
  | "proposed"
  | "prepared"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "uncertain";
export interface EffectBatchMember {
  readonly providerCallId: string;
  readonly toolCallId: string | null;
  readonly toolName: string;
  readonly fingerprint: string | null;
  readonly claim: PreparedResourceClaim | null;
  readonly wave: number;
  readonly state: EffectMemberState;
  readonly approvalId: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly cleanupConfirmed: boolean | null;
  readonly checkpointIds: readonly string[];
  readonly outputBytes: number;
  readonly outputSha256: string | null;
  readonly checkpointSha256: readonly string[];
  readonly errorCode: string | null;
}
export interface EffectBatchRecord {
  readonly version: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly revision: number;
  readonly previousSha256: string | null;
  readonly state:
    | "preparing"
    | "prepared"
    | "running"
    | "completed"
    | "partial"
    | "uncertain"
    | "paused-import";
  readonly configSha256: string;
  readonly catalogueSha256: string;
  readonly budget: {
    toolCalls: number;
    outputBytes: number;
    artifactBytes: number;
    durationMs: number;
  };
  readonly mode: "parallel" | "serial";
  readonly fallback: readonly string[];
  readonly members: readonly EffectBatchMember[];
  readonly lockEpoch: string | null;
  readonly lockReleased: boolean;
  readonly lockOwnerPid: number | null;
  readonly executionLockPath: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export const effectBatchData = (value: unknown) => value as JsonObject;
