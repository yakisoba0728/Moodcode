import type { JsonObject, RunConfigInput } from "@moodcode/contracts";
import type { WorkflowSpecInput } from "../workflows/types.js";
import type { WorkflowStartPreview } from "../workflows/host.js";
import type { WorkflowChildEvidence } from "../workflows/effect-evidence.js";
import type {
  WorkflowChildCompletionProof,
  WorkflowInstanceRevision,
} from "../workflows/reducer.js";
export interface CodingCaseInput {
  readonly id: string;
  readonly spec: WorkflowSpecInput;
  readonly stageWorktrees: Readonly<Record<string, string>>;
  readonly sourcePaths: readonly string[];
}
export interface CodingBatchLimits {
  readonly concurrency: number;
  readonly maxDurationMs: number;
  readonly maxSourceBytes: number;
  readonly maxEvidenceBytes: number;
  readonly maxExportBytes: number;
  readonly maxTokens: number;
  readonly maxCostMicros: number;
  readonly costPerRequestMicros: number;
}
export interface CodingBatchInput {
  readonly workspaceId: string;
  readonly rootSessionId: string;
  readonly parentRunId: string;
  readonly groupId: string;
  readonly cases: readonly CodingCaseInput[];
  readonly limits: CodingBatchLimits;
}
export interface CodingSourcePin {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly sha256: string;
}
export interface CodingBatchPreview {
  readonly version: 1;
  readonly input: CodingBatchInput;
  readonly previews: readonly WorkflowStartPreview[];
  readonly sources: readonly CodingSourcePin[];
  readonly configSha256: string;
  readonly catalogueSha256: string;
  readonly reservedTokens: number;
  readonly reservedCostMicros: number;
  readonly sha256: string;
}
export type CodingCaseState =
  | "pending"
  | "running"
  | "verified"
  | "failed"
  | "skipped"
  | "cancelled"
  | "uncertain";
export interface BatchCaseReceipt {
  readonly version: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly groupId: string;
  readonly caseId: string;
  readonly sourceSha256: string;
  readonly instance: WorkflowInstanceRevision;
  readonly reviewer: WorkflowChildEvidence;
  readonly completion: WorkflowChildCompletionProof;
  readonly editorSha256: string;
  readonly validatorSha256: string;
  readonly sha256: string;
}
export interface CodingAttemptGroup {
  readonly version: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly parentRunId: string;
  readonly groupId: string;
  readonly revision: number;
  readonly previousSha256: string | null;
  readonly requestId: string;
  readonly preview: CodingBatchPreview;
  readonly state:
    | "running"
    | "ready"
    | "completed"
    | "cancelled"
    | "uncertain"
    | "paused-import";
  readonly cases: readonly {
    id: string;
    instanceId: string;
    state: CodingCaseState;
    stage: number;
    errorCode: string | null;
    receiptSha256: string | null;
  }[];
  readonly usage: {
    requests: number;
    reservedTokens: number;
    chargedCostMicros: number;
    measuredInputTokens: number | null;
    measuredOutputTokens: number | null;
    unknownUsageRequests: number;
  };
  readonly selection: SelectionReceipt | null;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface SelectionReceipt {
  readonly revision: number;
  readonly requestId: string;
  readonly caseId: string;
  readonly caseSha256: string;
  readonly editorSha256: string;
  readonly validatorSha256: string;
  readonly state: "selected" | "merged" | "uncertain";
  readonly mergeSha256: string | null;
  readonly sha256: string;
}
export interface CodingSelectionPreview {
  readonly version: 1;
  readonly workspaceId: string;
  readonly groupId: string;
  readonly groupSha256: string;
  readonly expectedRevision: number;
  readonly caseId: string;
  readonly caseSha256: string;
  readonly editorSha256: string;
  readonly validatorSha256: string;
  readonly head: string;
  readonly sha256: string;
}
export interface CodingStartInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly approved: boolean;
  readonly preview: CodingBatchPreview;
  readonly signal?: AbortSignal;
}
export interface CodingGroupMutation {
  readonly workspaceId: string;
  readonly groupId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly approved: boolean;
  readonly signal?: AbortSignal;
}
export interface CodingDeliveryInput {
  readonly workspaceId: string;
  readonly groupId: string;
  readonly requestId: string;
  readonly expectedRevision: 0;
  readonly approved: boolean;
  readonly target: object;
  readonly signal?: AbortSignal;
}
export interface CodingEvidenceExport {
  readonly version: 1;
  readonly group: CodingAttemptGroup;
  readonly cases: readonly BatchCaseReceipt[];
  readonly sha256: string;
}
export type CodingConfig = RunConfigInput;
export const codingData = (v: unknown) => v as JsonObject;
