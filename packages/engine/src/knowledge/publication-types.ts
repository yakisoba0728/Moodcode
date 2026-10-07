import type {
  KnowledgeCandidate,
  KnowledgeHostBinding,
  KnowledgeListOptions,
  KnowledgePage,
} from "./types.js";

/** Historical completed producer pins; freshness of its original target is not publication evidence. */
export interface KnowledgePublicationProvenance {
  readonly candidateId: string;
  readonly candidateSha256: string;
  readonly generationId: string;
  readonly generationSha256: string;
  readonly attemptId: string;
  readonly attemptSha256: string;
  readonly planId: string;
  readonly planSha256: string;
  readonly trustRevisionId: string;
  readonly trustRevisionSha256: string;
}
export interface PrepareKnowledgePublication {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly operation: "publish" | "revoke";
  readonly binding: KnowledgeHostBinding;
  readonly documentKey: string;
  readonly expectedHeadRevision: number;
  readonly expectedHeadSha256: string | null;
  readonly expectedHeadRevisionId: string | null;
  readonly provenance: KnowledgePublicationProvenance;
  /** Revoke pins the actual current completed publication; publish sets both fields to null. */
  readonly existingPublicationId: string | null;
  readonly existingPublicationSha256: string | null;
  readonly bodySha256: string;
  /** Original approval deadline; rereading, retrying and restart never extend it. */
  readonly expiresAt: string;
}
export interface KnowledgePublicationRecord extends PrepareKnowledgePublication {
  readonly id: string;
  readonly requestSha256: string;
  readonly runtimeEpoch: string;
  readonly revision: number;
  readonly state: "prepared" | "completed" | "cancelled";
  readonly body: string;
  readonly documentRevisionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode: string | null;
  readonly sha256: string;
}
export interface WorkspaceDocumentRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly documentKey: string;
  /** Every publish and revoke increments history. Revocation never recreates revision zero. */
  readonly revision: number;
  readonly previousRevisionId: string | null;
  readonly publicationId: string;
  readonly status: "active" | "revoked";
  readonly binding: KnowledgeHostBinding;
  readonly provenance: KnowledgePublicationProvenance;
  readonly body: string;
  readonly bodySha256: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface WorkspaceDocumentHead {
  readonly id: string;
  readonly workspaceId: string;
  readonly documentKey: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly publicationId: string;
  readonly status: "active" | "revoked";
  readonly bodySha256: string;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface KnowledgePublicationReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly publicationId: string;
  readonly documentRevisionId: string;
  readonly operation: "publish" | "revoke";
  readonly createdAt: string;
  readonly sha256: string;
}
/** Only the original exact object issued by one native instance can approve a prepared owner. */
export interface KnowledgePublicationCapture {
  readonly workspaceId: string;
  readonly publicationId: string;
  readonly runtimeEpoch: string;
}
export type PrepareKnowledgePublicationResult =
  | {
      readonly kind: "created";
      readonly capture: KnowledgePublicationCapture;
      readonly record: KnowledgePublicationRecord;
    }
  | { readonly kind: "duplicate"; readonly record: KnowledgePublicationRecord };
export interface KnowledgePublicationCommitResult {
  readonly publication: KnowledgePublicationRecord;
  readonly document: WorkspaceDocumentRevision;
  readonly head: WorkspaceDocumentHead;
  readonly receipt: KnowledgePublicationReceipt;
}
export interface KnowledgePublicationStoragePorts {
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
  /** Exact producer/provenance and, for publish, current trust/source validation in the same primary SQL TX. */
  readonly assertCommitCurrent: (record: KnowledgePublicationRecord) => void;
  readonly now?: () => number;
}
export type KnowledgePublicationTable =
  | "workspace_document_revisions"
  | "workspace_document_heads"
  | "knowledge_publications"
  | "knowledge_publication_receipts";
export type KnowledgePublicationArchiveData =
  | WorkspaceDocumentRevision
  | WorkspaceDocumentHead
  | KnowledgePublicationRecord
  | KnowledgePublicationReceipt;
export interface KnowledgePublicationArchiveRow {
  readonly table: KnowledgePublicationTable;
  readonly key: string;
  readonly workspaceId: string;
  readonly data: KnowledgePublicationArchiveData;
}
export type KnowledgePublicationListOptions = KnowledgeListOptions;
export type KnowledgePublicationPage<T> = KnowledgePage<T>;
