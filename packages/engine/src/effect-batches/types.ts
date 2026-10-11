import type { PreparedResourceClaim } from "../tools/runtime/claims.js";
export const EFFECT_MEMBER_STATES = Object.freeze([
  "proposed",
  "prepared",
  "running",
  "completed",
  "failed",
  "denied",
  "cancelled",
  "uncertain",
] as const);
export type EffectMemberState = (typeof EFFECT_MEMBER_STATES)[number];
export const EFFECT_BATCH_STATES = Object.freeze([
  "preparing",
  "prepared",
  "running",
  "completed",
  "partial",
  "uncertain",
  "paused-import",
] as const);
export type EffectBatchState = (typeof EFFECT_BATCH_STATES)[number];
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
  readonly state: EffectBatchState;
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
