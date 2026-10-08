import type { KnowledgeHostBinding } from "../knowledge/types.js";
import type {
  PreparedProposalSourceSnapshot,
  ProposalSourceManifest,
  ProposalSourceOperation,
} from "./source-capture.js";

export interface ProposalCaptureInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly proposalId?: string;
  readonly expectedHeadRevision: number;
  readonly operations: readonly ProposalSourceOperation[];
}
/** Only the exact original native capture may publish a revision and its SQL blobs. */
export interface PreparedProposalCapture {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly expectedHeadRevision: number;
  readonly binding: KnowledgeHostBinding;
  readonly requestInputSha256: string;
}
export type ProposalBlobRole = "before" | "after";
export interface ProposalBlobOwner {
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly operationIndex: number;
  readonly role: ProposalBlobRole;
}
export interface ProposalBlobReference extends ProposalBlobOwner {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly headerSha256: string;
}
export interface ProposalBlobHeader extends ProposalBlobReference {
  readonly createdAt: string;
}
export interface ProposalFileEntry {
  readonly path: string;
  readonly operation: "create" | "update" | "delete";
  readonly before: ProposalBlobReference | null;
  readonly after: ProposalBlobReference | null;
}
export interface ProposalRevision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly requestId: string;
  readonly requestInputSha256: string;
  readonly requestedProposalId: string | null;
  readonly expectedHeadRevision: number;
  readonly binding: KnowledgeHostBinding;
  readonly sourceManifest: ProposalSourceManifest;
  readonly sourceManifestSha256: string;
  readonly files: readonly ProposalFileEntry[];
  readonly totalBytes: number;
  readonly createdAt: string;
  readonly sha256: string;
}
/** Current pointer only; append history never changes when import pauses this head. */
export interface ProposalSet {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly headRevision: number;
  readonly status:
    | "pending"
    | "cancelled"
    | "paused-import"
    | "applied"
    | "partial"
    | "uncertain";
  readonly applySettlement?: {
    readonly ownerId: string;
    readonly ownerSha256: string;
    readonly checkpointId: string;
    readonly checkpointSha256: string;
    readonly receiptId: string;
    readonly state: "completed" | "partial" | "uncertain";
    readonly cleanupConfirmed: boolean;
  };
  readonly archiveSha256: string | null;
  readonly updatedAt: string;
  readonly sha256: string;
}
export type BeginProposalCaptureResult =
  | { readonly kind: "created"; readonly capture: PreparedProposalCapture }
  | {
      readonly kind: "duplicate";
      readonly set: ProposalSet;
      readonly revision: ProposalRevision;
    };
export interface AppendProposalRevisionResult {
  readonly kind: "created" | "duplicate";
  readonly set: ProposalSet;
  readonly revision: ProposalRevision;
}
export interface ProposalSelection {
  readonly set: ProposalSet;
  readonly revision: ProposalRevision;
}
export interface ProposalRevisionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly requestId: string;
  readonly requestInputSha256: string;
  readonly sourceManifestSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface ProposalListOptions {
  readonly after?: string;
  readonly limit?: number;
  readonly maxBytes?: number;
}
export interface ProposalPage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
  readonly bytes: number;
}
export interface ProposalBlobReadOptions {
  readonly offset?: number;
  readonly limit?: number;
}
export interface ProposalBlobPage {
  readonly reference: ProposalBlobReference;
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly nextOffset: number | null;
}
export interface ProposalBlobStoragePort {
  /** Requires the actual revision row and exact referenced header in the same primary TX. */
  readonly put: (header: ProposalBlobHeader, content: string) => void;
  readonly get: (
    workspaceId: string,
    blobId: string,
  ) => ProposalBlobHeader | undefined;
  readonly read: (
    reference: ProposalBlobReference,
    options?: ProposalBlobReadOptions,
  ) => ProposalBlobPage;
}
export interface ProposalStoragePorts {
  readonly writeTx: <T>(operation: () => T) => T;
  readonly getWorkspace: (workspaceId: string) => {
    readonly id: string;
    readonly root: string;
  };
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly readSourceCapture: (
    originalSource: object,
  ) => PreparedProposalSourceSnapshot;
  readonly assertSourcesCurrent: (
    originalNative: PreparedProposalCapture,
    originalSource: object,
  ) => void;
  readonly blobs: ProposalBlobStoragePort;
  readonly now?: () => number;
}
export type ProposalTable =
  "proposal_revisions" | "proposal_heads" | "proposal_blobs";
