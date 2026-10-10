import type {
  KnowledgeGenerationEvidence,
  KnowledgeGenerationPlan,
  KnowledgeHostBinding,
  KnowledgeUsage,
} from "./types.js";

/** One original host operation budget. It never borrows a coding Run budget. */
export interface KnowledgeGenerationBudget {
  readonly maxDurationMs: number;
  readonly providerRequestTimeoutMs: number;
  readonly inactivityTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxObservationBytes: number;
  readonly maxEvents: number;
  readonly maxAttempts: 1;
}
export type KnowledgeGenerationState =
  | "prepared"
  | "dispatched"
  | "streaming"
  | "output-finished"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";
export interface KnowledgeGenerationCleanup {
  readonly confirmed: boolean;
  readonly method:
    "iterator-complete" | "iterator-return" | "not-dispatched" | "unknown";
  readonly reason: string | null;
}
export type KnowledgeGenerationCandidateState =
  | {
      readonly state: "pending";
      readonly candidateId: null;
      readonly reason: null;
    }
  | {
      readonly state: "recorded";
      readonly candidateId: string;
      readonly reason: null;
    }
  | {
      readonly state: "withheld";
      readonly candidateId: null;
      readonly reason: string;
    };
export interface KnowledgeGenerationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly planId: string;
  readonly planSha256: string;
  readonly requestId: string;
  readonly createSha256: string;
  readonly binding: KnowledgeHostBinding;
  readonly providerId: string;
  readonly modelId: string;
  readonly logicalRequestSha256: string;
  readonly logicalRequestBytes: number;
  readonly budget: KnowledgeGenerationBudget;
  readonly budgetSha256: string;
  readonly runtimeEpoch: string;
  readonly revision: number;
  readonly state: KnowledgeGenerationState;
  readonly attemptId: string | null;
  readonly candidate: KnowledgeGenerationCandidateState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadline: number;
  readonly errorCode: string | null;
  readonly sha256: string;
}
export interface KnowledgeGenerationAttempt {
  readonly id: string;
  readonly workspaceId: string;
  readonly generationId: string;
  readonly planId: string;
  readonly runtimeEpoch: string;
  readonly revision: number;
  readonly state: KnowledgeGenerationState;
  readonly exactDispatchSha256: string;
  readonly exactDispatchBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatchedAt: string | null;
  readonly output: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly observedTextBytes: number;
  readonly outputTruncated: boolean;
  readonly observationBytes: number;
  readonly events: number;
  readonly usage: KnowledgeUsage;
  readonly providerRequestId: string | null;
  readonly finishReason: "stop" | null;
  readonly streamDone: boolean;
  readonly cleanup: KnowledgeGenerationCleanup | null;
  readonly errorCode: string | null;
  readonly sha256: string;
}
/** Identity is checked through instance-owned weak maps; copying either object loses authority. */
export interface KnowledgeGenerationCapture {
  readonly workspaceId: string;
  readonly generationId: string;
  readonly runtimeEpoch: string;
}
export interface KnowledgeGenerationAttemptCapture {
  readonly workspaceId: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly runtimeEpoch: string;
}
export interface CreateKnowledgeGeneration {
  readonly workspaceId: string;
  readonly planId: string;
  readonly requestId: string;
  readonly budget: KnowledgeGenerationBudget;
  readonly logicalRequestSha256: string;
  readonly logicalRequestBytes: number;
}
export type CreateKnowledgeGenerationResult =
  | {
      readonly kind: "created";
      readonly capture: KnowledgeGenerationCapture;
      readonly record: KnowledgeGenerationRecord;
    }
  | { readonly kind: "duplicate"; readonly record: KnowledgeGenerationRecord };
export interface KnowledgeGenerationObservation {
  readonly textDelta?: string;
  /** Actual delta charge, including bytes discarded to keep the retained output bounded. */
  readonly textBytes?: number;
  readonly outputTruncated?: true;
  readonly usage?: KnowledgeUsage;
  readonly providerRequestId?: string;
  readonly finishReason?: "stop";
  /** The real iterator returned done, independently of an earlier finish event. */
  readonly streamDone?: true;
  /** Cumulative actual provider events; a synthetic iterator-done observation adds no event. */
  readonly eventCount?: number;
  readonly observationBytes: number;
}
export interface KnowledgeGenerationSettlement {
  readonly state: "completed" | "failed" | "cancelled" | "uncertain";
  readonly errorCode?: string;
  readonly cleanup: KnowledgeGenerationCleanup;
  readonly candidate?:
    | { readonly state: "pending" }
    | { readonly state: "withheld"; readonly reason: string };
}
export interface KnowledgeGenerationRecoveryPin {
  readonly id: string;
  readonly sha256: string;
}
export interface KnowledgeGenerationRecoveryPreview {
  readonly workspaceId: string;
  readonly runtimeEpoch: string;
  readonly binding: KnowledgeHostBinding;
  readonly barrierRevision: number;
  readonly frontierSha256: string;
  readonly generations: readonly KnowledgeGenerationRecord[];
  readonly attempts: readonly KnowledgeGenerationAttempt[];
  readonly sha256: string;
}
export interface KnowledgeGenerationRecoveryAcknowledgment {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly operation: "acknowledge" | "resume";
  readonly requestSha256: string;
  readonly binding: KnowledgeHostBinding;
  readonly runtimeEpoch: string;
  readonly expectedBarrierRevision: number;
  readonly frontierSha256: string;
  readonly generations: readonly KnowledgeGenerationRecoveryPin[];
  readonly reason: string | null;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface KnowledgeGenerationWorkspaceBarrier {
  readonly workspaceId: string;
  readonly revision: number;
  readonly state: "blocked" | "pending-resume" | "clear";
  readonly frontierSha256: string;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface KnowledgeGenerationRecoveryResult {
  readonly acknowledgment: KnowledgeGenerationRecoveryAcknowledgment;
  readonly barrier: KnowledgeGenerationWorkspaceBarrier;
}
export interface KnowledgeGenerationStoragePorts {
  readonly writeTx: <T>(operation: () => T) => T;
  readonly getWorkspace: (workspaceId: string) => {
    readonly id: string;
    readonly root: string;
  };
  readonly getPlan: (
    workspaceId: string,
    planId: string,
  ) => KnowledgeGenerationPlan | undefined;
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly assertPlanCurrent: (plan: KnowledgeGenerationPlan) => void;
  readonly now?: () => number;
}
export type KnowledgeGenerationTable =
  | "knowledge_generations"
  | "knowledge_generation_attempts"
  | "knowledge_generation_recovery_acknowledgments"
  | "knowledge_generation_workspace_barriers";
export type KnowledgeGenerationArchiveData =
  | KnowledgeGenerationRecord
  | KnowledgeGenerationAttempt
  | KnowledgeGenerationRecoveryAcknowledgment
  | KnowledgeGenerationWorkspaceBarrier;
export interface KnowledgeGenerationArchiveRow {
  readonly table: KnowledgeGenerationTable;
  readonly key: string;
  readonly workspaceId: string;
  readonly data: KnowledgeGenerationArchiveData;
}
export type { KnowledgeGenerationEvidence };
