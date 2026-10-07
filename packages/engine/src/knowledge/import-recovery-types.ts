import type { KnowledgeHostBinding } from "./types.js";

export type KnowledgeImportRecoveryOperation =
  "acknowledge" | "resume" | "activate" | "deactivate";
export type KnowledgeImportUncertaintyKind =
  | "generation"
  | "file"
  | "generation-barrier"
  | "file-barrier"
  | "generation-attempt"
  | "file-guard";
export interface KnowledgeImportUncertaintyPin {
  readonly kind: KnowledgeImportUncertaintyKind;
  readonly id: string;
  readonly sha256: string;
}
export interface SeedKnowledgeImportFrontier {
  readonly workspaceId: string;
  readonly importId: string;
  readonly archiveSha256: string;
  readonly sourcePrimaryLogicalSha256: string;
  readonly sourceStorageBindingSha256: string;
  readonly originalBinding: KnowledgeHostBinding | null;
  readonly pauseSha256: string;
}
export interface KnowledgeImportFrontier extends SeedKnowledgeImportFrontier {
  readonly id: string;
  readonly nativeFrontierSha256: string;
  readonly uncertainties: readonly KnowledgeImportUncertaintyPin[];
  readonly importedAt: string;
  readonly sha256: string;
}
export interface KnowledgeImportFrontierHead {
  readonly id: string;
  readonly workspaceId: string;
  readonly frontierId: string;
  readonly frontierSha256: string;
  readonly revision: number;
  readonly state: "paused" | "acknowledged" | "resumed";
  readonly acknowledgeDecisionId: string | null;
  readonly resumeDecisionId: string | null;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface KnowledgeImportFrontierView {
  readonly frontier: KnowledgeImportFrontier;
  readonly head: KnowledgeImportFrontierHead;
}
export interface ImportedKnowledgeDocumentProof {
  readonly documentKey: string;
  readonly headRevision: number;
  readonly headSha256: string;
  readonly documentRevisionId: string;
  readonly documentSha256: string;
  readonly publicationId: string;
  readonly publicationSha256: string;
  readonly receiptId: string;
  readonly receiptSha256: string;
  readonly provenanceSha256: string;
  readonly sourceManifestSha256: string;
  readonly originalBinding: KnowledgeHostBinding;
  readonly currentTrustId: string | null;
  readonly currentTrustRevision: number | null;
  readonly currentTrustSha256: string | null;
  readonly expiresAt: string | null;
}
export interface PrepareKnowledgeImportRecoveryPreview {
  readonly workspaceId: string;
  readonly operation: KnowledgeImportRecoveryOperation;
  readonly documentProof?: ImportedKnowledgeDocumentProof;
  readonly expiresAt: string;
}
/** Exact original instance-owned preview is required; descriptive copies authorize nothing. */
export interface KnowledgeImportRecoveryPreview {
  readonly workspaceId: string;
  readonly operation: KnowledgeImportRecoveryOperation;
  readonly frontierId: string;
  readonly frontierSha256: string;
  readonly pauseSha256: string;
  readonly binding: KnowledgeHostBinding;
  readonly currentFrontierSha256: string;
  readonly expectedHeadSha256: string;
  readonly expectedHeadRevision: number;
  readonly expectedActivationId: string | null;
  readonly expectedActivationSha256: string | null;
  readonly expectedActivationRevision: number;
  readonly resumeDecisionSha256: string | null;
  readonly uncertaintyPinsSha256: string;
  readonly documentProof: ImportedKnowledgeDocumentProof | null;
  readonly expiresAt: string;
  readonly sha256: string;
}
export interface CommitKnowledgeImportRecovery {
  readonly requestId: string;
  readonly approved: true;
  readonly reason: string;
}
export interface KnowledgeImportRecoveryDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly operation: KnowledgeImportRecoveryOperation;
  readonly frontierId: string;
  readonly frontierSha256: string;
  readonly pauseSha256: string;
  readonly binding: KnowledgeHostBinding;
  readonly previewSha256: string;
  readonly currentFrontierSha256: string;
  readonly uncertaintyPinsSha256: string;
  readonly reason: string;
  readonly documentProof: ImportedKnowledgeDocumentProof | null;
  readonly activationId: string | null;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface ImportedKnowledgeDocumentActivation {
  readonly id: string;
  readonly workspaceId: string;
  readonly documentKey: string;
  readonly frontierId: string;
  readonly frontierSha256: string;
  readonly resumeDecisionSha256: string;
  readonly decisionId: string;
  readonly binding: KnowledgeHostBinding;
  readonly revision: number;
  readonly previousId: string | null;
  readonly state: "active" | "inactive";
  readonly proof: ImportedKnowledgeDocumentProof;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface ImportedKnowledgeDocumentActivationHead {
  readonly id: string;
  readonly workspaceId: string;
  readonly documentKey: string;
  readonly revision: number;
  readonly activationId: string;
  readonly activationSha256: string;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface KnowledgeImportRecoveryCommitResult {
  readonly decision: KnowledgeImportRecoveryDecision;
  readonly activation: ImportedKnowledgeDocumentActivation | null;
  readonly frontier: KnowledgeImportFrontierView;
}
export interface KnowledgeImportRecoveryStoragePorts {
  readonly writeTx: <T>(operation: () => T) => T;
  readonly getWorkspace: (workspaceId: string) => {
    readonly id: string;
    readonly root: string;
  };
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  /** Synchronous actual graph/source/trust/uncertainty validation inside this exact primary TX. */
  readonly assertCommitCurrent: (
    preview: KnowledgeImportRecoveryPreview,
  ) => void;
  readonly now?: () => number;
}
export type KnowledgeImportRecoveryTable =
  | "knowledge_import_frontiers"
  | "knowledge_import_frontier_heads"
  | "knowledge_import_recovery_decisions"
  | "knowledge_import_document_activations"
  | "knowledge_import_document_activation_heads";
export type KnowledgeImportRecoveryData =
  | KnowledgeImportFrontier
  | KnowledgeImportFrontierHead
  | KnowledgeImportRecoveryDecision
  | ImportedKnowledgeDocumentActivation
  | ImportedKnowledgeDocumentActivationHead;
export interface KnowledgeImportRecoveryArchiveRow {
  readonly table: KnowledgeImportRecoveryTable;
  readonly key: string;
  readonly workspaceId: string;
  readonly data: KnowledgeImportRecoveryData;
}
