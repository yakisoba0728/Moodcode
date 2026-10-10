/** These records describe host operations; none manufactures a Session or Run owner. */
export interface KnowledgeHostBinding {
  readonly workspaceId: string;
  readonly root: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly storageBindingSha256: string;
}
export interface TrustSourcePin {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly device: string;
  readonly inode: string;
}
export interface TrustRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly requestId: string;
  readonly decision: 'allow' | 'deny';
  readonly binding: KnowledgeHostBinding;
  readonly sources: readonly TrustSourcePin[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly sha256: string;
}
export interface SetWorkspaceTrust {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly decision: 'allow' | 'deny';
  readonly binding: KnowledgeHostBinding;
  readonly sources: readonly TrustSourcePin[];
  readonly expiresAt: string | null;
}
export type KnowledgeSourcePin =
  | { readonly kind: 'message'; readonly sessionId: string; readonly runId: string | null; readonly messageId: string; readonly sha256: string }
  | { readonly kind: 'file'; readonly path: string; readonly sha256: string; readonly bytes: number; readonly device: string; readonly inode: string };
export interface KnowledgeSourceManifest {
  readonly projection: 'host-selected-text-v1';
  /** Exact allowlisted source text supplied to the future tool-free extractor. */
  readonly sha256: string;
  readonly bytes: number;
  readonly pins: readonly KnowledgeSourcePin[];
}
export type KnowledgeTarget =
  | { readonly kind: 'workspace-document'; readonly key: string; readonly revision: number; readonly sha256: string | null }
  | { readonly kind: 'workspace-file'; readonly path: string; readonly revision: number; readonly sha256: string | null; readonly device: string | null; readonly inode: string | null };
export interface PrepareKnowledgeGeneration {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly binding: KnowledgeHostBinding;
  readonly expectedTrustRevision: number;
  readonly source: KnowledgeSourceManifest;
  readonly target: KnowledgeTarget;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestSha256: string;
  readonly requestBytes: number;
  readonly maxOutputBytes: number;
  readonly expiresAt: string;
}
/** A pending plan is not a provider dispatch, cleanup record, or generation outcome. */
export interface KnowledgeGenerationPlan extends PrepareKnowledgeGeneration {
  readonly id: string;
  readonly trustRevisionId: string;
  readonly state: 'pending';
  readonly toolCount: 0;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface KnowledgeUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
}
/** Only the trusted host generation-owner port supplies this evidence. */
export interface KnowledgeGenerationEvidence {
  readonly ownerId: string;
  readonly planId: string;
  readonly workspaceId: string;
  readonly bindingSha256: string;
  readonly requestSha256: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly outputSha256: string;
  readonly outputBytes: number;
  readonly toolCount: 0;
  readonly completed: true;
  readonly cleanupConfirmed: true;
  readonly usage: KnowledgeUsage;
}
/** Descriptive fields alone confer no authority. KnowledgeStorage owns the object identity. */
export interface KnowledgeGenerationHandle {
  readonly planId: string;
  readonly ownerId: string;
}
export interface KnowledgeCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly planId: string;
  readonly generationOwnerId: string;
  readonly binding: KnowledgeHostBinding;
  readonly trustRevisionId: string;
  readonly trustRevision: number;
  readonly source: KnowledgeSourceManifest;
  readonly target: KnowledgeTarget;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestSha256: string;
  readonly usage: KnowledgeUsage;
  readonly toolCount: 0;
  readonly cleanupConfirmed: true;
  readonly state: 'pending';
  readonly body: string;
  readonly bodySha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sha256: string;
}
export type KnowledgeCandidateSummary = Omit<KnowledgeCandidate, 'body'>;
export interface KnowledgePage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
  readonly bytes: number;
}
export interface KnowledgeListOptions { readonly after?: string; readonly limit?: number; readonly maxBytes?: number }
export interface KnowledgeTrustHead { readonly workspaceId: string; readonly revision: number; readonly revisionId: string }
export interface KnowledgeRequestReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly bindingSha256: string;
  readonly requestId: string;
  readonly operation: 'set-trust' | 'prepare-generation' | 'append-candidate';
  readonly requestSha256: string;
  readonly recordId: string;
}
export interface KnowledgeImportPause {
  readonly workspaceId: string;
  readonly archiveSha256: string;
  readonly createdAt: string;
  readonly state: 'paused';
}
export type KnowledgeStorageTable = 'workspace_trust_revisions' | 'workspace_trust_heads' | 'knowledge_generation_plans' | 'knowledge_candidates' | 'knowledge_request_receipts' | 'knowledge_import_pauses';
export type KnowledgeArchiveData = TrustRevision | KnowledgeTrustHead | KnowledgeGenerationPlan | KnowledgeCandidate | KnowledgeRequestReceipt | KnowledgeImportPause;
export interface KnowledgeArchiveRow {
  readonly table: KnowledgeStorageTable;
  readonly key: string;
  readonly workspaceId: string;
  readonly data: KnowledgeArchiveData;
}
export interface KnowledgeStoragePorts {
  /** Must synchronously open one write transaction on this exact database. */
  readonly writeTx: <T>(operation: () => T) => T;
  readonly getWorkspace: (workspaceId: string) => { readonly id: string; readonly root: string };
  /** Verifies the current physical workspace root and database/artifact identity. */
  readonly checkHostBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly assertTrustSourcesCurrent: (binding: KnowledgeHostBinding, sources: readonly TrustSourcePin[]) => void;
  readonly assertSourcesCurrent: (binding: KnowledgeHostBinding, source: KnowledgeSourceManifest) => void;
  readonly assertTargetCurrent: (binding: KnowledgeHostBinding, target: KnowledgeTarget) => void;
  /** Absent until native host generation ownership exists: candidates cannot be appended. */
  readonly readGenerationEvidence?: (plan: KnowledgeGenerationPlan, ownerId: string) => KnowledgeGenerationEvidence;
  readonly now?: () => number;
}
