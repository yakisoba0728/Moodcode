import type { KnowledgeHostBinding } from "../knowledge/types.js";
import type {
  ProposalBlobReference,
  ProposalRevision,
  ProposalSet,
} from "./types.js";
import type { ExecutionLockMarker } from "../tools/command/execution-lock.js";

export interface ProposalApplyPins {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly sourceManifestSha256: string;
  readonly beforeHead: ProposalSet;
  readonly binding: KnowledgeHostBinding;
  readonly previewSha256: string;
  readonly expiresAt: string;
  readonly deadline: number;
}
export interface PrepareProposalApply extends ProposalApplyPins {
  readonly requestId: string;
  readonly requestSha256: string;
}
export interface ProposalApplyCapture {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly runtimeEpoch: string;
}
export type ProposalApplyState =
  | "prepared"
  | "dispatched"
  | "completed"
  | "partial"
  | "cancelled"
  | "uncertain";
export interface ProposalApplyOwner extends PrepareProposalApply {
  readonly id: string;
  readonly runtimeEpoch: string;
  readonly revision: number;
  readonly state: ProposalApplyState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatchedAt: string | null;
  readonly checkpointId: string | null;
  readonly checkpointSha256: string | null;
  readonly guardSha256: string | null;
  readonly cleanupConfirmed: boolean | null;
  readonly errorCode: string | null;
  readonly sha256: string;
}
export interface ProposalApplyGuard {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly binding: KnowledgeHostBinding;
  readonly lock: {
    readonly path: string;
    readonly device: string;
    readonly inode: string;
  };
  readonly marker: ExecutionLockMarker;
  readonly sha256: string;
}
export interface ProposalAppliedFileObservation {
  readonly path: string;
  readonly attempted: boolean;
  readonly mayHaveChanged: boolean;
  readonly before: string | null;
  readonly beforeSha256: string | null;
  readonly after: string | null;
  readonly afterSha256: string | null;
  readonly observationComplete: boolean;
}
/** Issued only by the root physical producer's original-result reader. */
export interface ProposalPhysicalOutcome {
  readonly files: readonly ProposalAppliedFileObservation[];
  readonly createdParentCount: number;
  readonly createdParents: readonly string[];
  readonly createdParentsComplete: boolean;
  readonly cleanupConfirmed: boolean;
  readonly errorCode: string | null;
  readonly warnings: readonly string[];
}
export interface ProposalEffectBlobReference {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly checkpointId: string;
  readonly fileIndex: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly headerSha256: string;
}
export interface ProposalApplyCheckpointFile {
  readonly path: string;
  readonly attempted: boolean;
  readonly mayHaveChanged: boolean;
  readonly before: ProposalBlobReference | null;
  readonly after: ProposalBlobReference | ProposalEffectBlobReference | null;
  readonly observationComplete: boolean;
}
export interface ProposalApplyCheckpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly revisionId: string;
  readonly files: readonly ProposalApplyCheckpointFile[];
  readonly createdParentCount: number;
  readonly createdParents: readonly string[];
  readonly createdParentsComplete: boolean;
  readonly complete: boolean;
  readonly partial: boolean;
  readonly producerCleanupConfirmed: boolean;
  readonly errorCode: string | null;
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly sha256: string;
}
export interface ProposalApplyReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly checkpointId: string;
  readonly checkpointSha256: string;
  readonly beforeHead: ProposalSet;
  readonly afterHead: ProposalSet;
  readonly state: "completed" | "partial" | "uncertain";
  readonly cleanupConfirmed: boolean;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface ProposalApplyHistory {
  readonly owner: ProposalApplyOwner;
  readonly checkpoint: ProposalApplyCheckpoint | null;
  readonly receipt: ProposalApplyReceipt | null;
}
export type PrepareProposalApplyResult =
  | {
      readonly kind: "created";
      readonly capture: ProposalApplyCapture;
      readonly owner: ProposalApplyOwner;
    }
  | { readonly kind: "duplicate"; readonly history: ProposalApplyHistory };
export interface ProposalApplyCleanup {
  readonly confirmed: boolean;
  readonly guardSha256: string;
}
export interface ProposalApplyRecoveryPreview {
  readonly workspaceId: string;
  readonly binding: KnowledgeHostBinding;
  readonly revision: number;
  readonly frontierSha256: string;
  readonly owners: readonly {
    readonly id: string;
    readonly sha256: string;
    readonly checkpointSha256: string | null;
    readonly guardSha256: string | null;
  }[];
}
export interface ProposalApplyRecoveryDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly operation: "acknowledge" | "resume";
  readonly revision: number;
  readonly binding: KnowledgeHostBinding;
  readonly frontierSha256: string;
  readonly owners: ProposalApplyRecoveryPreview["owners"];
  readonly reason: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface ProposalApplyStoragePorts {
  readonly writeTx: <T>(operation: () => T) => T;
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly getRevision: (
    workspaceId: string,
    id: string,
  ) => ProposalRevision | undefined;
  readonly getHead: (
    workspaceId: string,
    id: string,
  ) => ProposalSet | undefined;
  readonly readApprovedCapture: (
    original: object,
    input: PrepareProposalApply,
  ) => ProposalApplyPins;
  readonly assertCurrent: (
    original: object,
    capture: ProposalApplyCapture,
    phase: "prepare" | "dispatch",
  ) => void;
  readonly readPhysicalResult: (
    capture: ProposalApplyCapture,
    originalResult: object,
  ) => ProposalPhysicalOutcome;
  readonly readExecutionGuard: (
    capture: ProposalApplyCapture,
    originalGuard: object,
  ) => ProposalApplyGuard;
  readonly getExecutionGuard: (
    workspaceId: string,
    ownerId: string,
  ) => ProposalApplyGuard | undefined;
  readonly assertCleanup: (
    capture: ProposalApplyCapture,
    originalCleanup: object,
  ) => ProposalApplyCleanup;
  readonly beforeRecoveryDecision?: (
    workspaceId: string,
    operation: "acknowledge" | "resume",
    preview: ProposalApplyRecoveryPreview,
  ) => void;
  readonly now?: () => number;
}
export type ProposalApplyTable =
  | "proposal_apply_owners"
  | "proposal_apply_checkpoints"
  | "proposal_effect_blobs"
  | "proposal_apply_receipts"
  | "proposal_apply_recovery_decisions";
