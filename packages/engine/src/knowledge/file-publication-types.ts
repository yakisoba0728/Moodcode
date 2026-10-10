import type {
  KnowledgeCandidate,
  KnowledgeHostBinding,
  KnowledgeListOptions,
  KnowledgePage,
} from "./types.js";
import type { KnowledgePublicationProvenance } from "./publication-types.js";

export interface FileParentPin {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}
export interface FilePhysicalObservation {
  readonly binding: KnowledgeHostBinding;
  readonly path: string;
  readonly present: boolean;
  readonly sha256: string | null;
  readonly bytes: number;
  readonly device: string | null;
  readonly inode: string | null;
  readonly mode: number | null;
  readonly mtimeNs: string | null;
  readonly ctimeNs: string | null;
  readonly parentPins: readonly FileParentPin[];
  readonly missingParents: readonly string[];
}
export interface KnowledgeFileTarget {
  readonly workspaceId: string;
  readonly path: string;
  readonly revision: number;
  readonly observationId: string | null;
  readonly observationSha256: string;
  readonly observation: FilePhysicalObservation;
}
export interface KnowledgeFileObservationRevision extends KnowledgeFileTarget {
  readonly id: string;
  readonly previousId: string | null;
  readonly publicationId: string | null;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface FilePublicationCheckpoint {
  readonly createdParents: readonly string[];
  readonly createdFiles: readonly string[];
  readonly removedFiles: readonly string[];
  readonly replacedFiles: readonly string[];
  readonly partial: boolean;
}
export interface KnowledgeFileCheckpointRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly publicationId: string;
  readonly before: FilePhysicalObservation;
  readonly after: FilePhysicalObservation | null;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
  readonly effects: FilePublicationCheckpoint;
  readonly cleanupConfirmed: boolean;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface PrepareKnowledgeFilePublication {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly operation: "publish" | "revoke";
  readonly binding: KnowledgeHostBinding;
  readonly path: string;
  readonly expectedTarget: KnowledgeFileTarget;
  readonly provenance: KnowledgePublicationProvenance;
  readonly existingPublicationId: string | null;
  readonly existingPublicationSha256: string | null;
  readonly body: string | null;
  readonly bodySha256: string | null;
  readonly beforeContent: string | null;
  readonly expiresAt: string;
  readonly deadline: number;
}
export interface KnowledgeFilePublicationRecord extends PrepareKnowledgeFilePublication {
  readonly id: string;
  readonly runtimeEpoch: string;
  readonly revision: number;
  readonly requestSha256: string;
  readonly state:
    "prepared" | "dispatched" | "completed" | "cancelled" | "uncertain";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
  readonly checkpointId: string | null;
  readonly targetRevisionId: string | null;
  readonly cleanupConfirmed: boolean | null;
  readonly errorCode: string | null;
  readonly sha256: string;
}
export interface KnowledgeFilePublicationReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly publicationId: string;
  readonly checkpointId: string;
  readonly targetRevisionId: string;
  readonly operation: "publish" | "revoke";
  readonly createdAt: string;
  readonly sha256: string;
}
export interface KnowledgeFilePublicationCapture {
  readonly workspaceId: string;
  readonly publicationId: string;
  readonly runtimeEpoch: string;
}
export type PrepareKnowledgeFilePublicationResult =
  | {
      readonly kind: "created";
      readonly record: KnowledgeFilePublicationRecord;
      readonly capture: KnowledgeFilePublicationCapture;
    }
  | {
      readonly kind: "duplicate";
      readonly record: KnowledgeFilePublicationRecord;
    };
export interface CompleteKnowledgeFilePublication {
  readonly after: FilePhysicalObservation;
  readonly checkpoint: FilePublicationCheckpoint;
  readonly cleanup: {
    readonly confirmed: boolean;
    readonly reason: string | null;
  };
}
export interface UncertainKnowledgeFilePublication {
  readonly after?: FilePhysicalObservation | null;
  readonly checkpoint?: FilePublicationCheckpoint;
  readonly cleanupConfirmed?: boolean;
  readonly errorCode: string;
}
export interface KnowledgeFilePublicationCommitResult {
  readonly publication: KnowledgeFilePublicationRecord;
  readonly target: KnowledgeFileObservationRevision;
  readonly checkpoint: KnowledgeFileCheckpointRecord;
  readonly receipt: KnowledgeFilePublicationReceipt;
}
export interface KnowledgeFileRecoveryPreview {
  readonly workspaceId: string;
  readonly binding: KnowledgeHostBinding;
  readonly runtimeEpoch: string;
  readonly barrierRevision: number;
  readonly frontierSha256: string;
  readonly owners: readonly KnowledgeFilePublicationRecord[];
  readonly sha256: string;
}
export interface KnowledgeFileRecoveryAcknowledgment {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly operation: "acknowledge" | "resume";
  readonly binding: KnowledgeHostBinding;
  readonly frontierSha256: string;
  readonly ownerIds: readonly string[];
  readonly reason: string;
  readonly createdAt: string;
  readonly sha256: string;
  readonly ownerHashes: readonly {
    readonly id: string;
    readonly sha256: string;
  }[];
}
export interface KnowledgeFileWorkspaceBarrier {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly state: "blocked" | "pending-resume" | "clear";
  readonly binding: KnowledgeHostBinding;
  readonly frontierSha256: string;
  readonly acknowledgmentId: string | null;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface KnowledgeFilePublicationStoragePorts {
  readonly writeTx: <T>(operation: () => T) => T;
  readonly getWorkspace: (workspaceId: string) => {
    readonly id: string;
    readonly root: string;
  };
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly getCandidate: (
    workspaceId: string,
    candidateId: string,
  ) => KnowledgeCandidate | undefined;
  readonly assertCommitCurrent: (
    record: KnowledgeFilePublicationRecord,
    phase: "dispatch" | "complete",
  ) => void;
  readonly now?: () => number;
  readonly beforeRecoveryDecision?: (
    workspaceId: string,
    operation: "acknowledge" | "resume",
  ) => void;
}
export type KnowledgeFilePublicationTable =
  | "knowledge_file_observations"
  | "knowledge_file_heads"
  | "knowledge_file_publications"
  | "knowledge_file_checkpoints"
  | "knowledge_file_publication_receipts"
  | "knowledge_file_recovery_acknowledgments"
  | "knowledge_file_workspace_barriers";
export interface KnowledgeFileHead {
  readonly id: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly revision: number;
  readonly observationId: string;
  readonly sha256: string;
}
export type KnowledgeFilePublicationArchiveData =
  | KnowledgeFileObservationRevision
  | KnowledgeFileHead
  | KnowledgeFilePublicationRecord
  | KnowledgeFileCheckpointRecord
  | KnowledgeFilePublicationReceipt
  | KnowledgeFileRecoveryAcknowledgment
  | KnowledgeFileWorkspaceBarrier;
export interface KnowledgeFilePublicationArchiveRow {
  readonly table: KnowledgeFilePublicationTable;
  readonly key: string;
  readonly workspaceId: string;
  readonly data: KnowledgeFilePublicationArchiveData;
}
export type KnowledgeFilePublicationListOptions = KnowledgeListOptions;
export type KnowledgeFilePublicationPage<T> = KnowledgePage<T>;
