import type { Workspace } from "@moodcode/contracts";
import type {
  KnowledgeGenerationAttempt,
  KnowledgeGenerationRecord,
} from "./generation-types.js";
import type {
  KnowledgePublicationRecord,
  KnowledgePublicationReceipt,
  WorkspaceDocumentHead,
  WorkspaceDocumentRevision,
} from "./publication-types.js";
import type {
  KnowledgeCandidate,
  KnowledgeGenerationPlan,
  KnowledgeHostBinding,
  KnowledgeSourceManifest,
  TrustRevision,
  TrustSourcePin,
} from "./types.js";

export interface KnowledgeContextProfile {
  readonly id: string;
  readonly revision: string;
}
/** Host-only selection; neither a model response nor repository instructions can register it. */
export interface KnowledgeContextPolicy {
  readonly documentKeys: readonly string[];
  readonly slotBytes: number;
  readonly profiles?: readonly KnowledgeContextProfile[];
}
export interface KnowledgeContextBudget {
  readonly slotBytes: number;
  readonly maxContextBytes: number;
  readonly reservedBytes: number;
  /** Actual complete base transcript plus earlier supplemental message charges. */
  readonly requiredMessagesBytes: number;
  readonly contextWindow: number | null;
  readonly outputTokens: number;
}
export interface KnowledgeContextOwner {
  readonly sessionId: string;
  readonly runId: string | null;
  readonly profile: KnowledgeContextProfile | null;
}
export interface KnowledgeContextRequest {
  readonly workspace: Workspace;
  readonly policy: KnowledgeContextPolicy;
  readonly budget: KnowledgeContextBudget;
  readonly owner: KnowledgeContextOwner;
  readonly signal: AbortSignal;
}
export type KnowledgeContextOmissionReason =
  | "missing"
  | "revoked"
  | "stale"
  | "expired"
  | "paused"
  | "untrusted"
  | "profile-not-selected"
  | "context-budget";
export interface KnowledgeContextOmission {
  readonly documentKey: string;
  readonly reason: KnowledgeContextOmissionReason;
}
export interface KnowledgeContextDocumentManifest {
  readonly documentKey: string;
  readonly documentRevisionId: string;
  readonly documentRevision: number;
  readonly documentSha256: string;
  readonly bodySha256: string;
  readonly publicationId: string;
  readonly publicationSha256: string;
  readonly receiptId: string;
  readonly receiptSha256: string;
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
  readonly sourceManifestSha256: string;
  readonly sourceTextSha256: string;
  readonly sourcePinCount: number;
  readonly candidateExpiresAt: string;
  readonly planExpiresAt: string;
  readonly trustExpiresAt: string | null;
}
/** Only these actual returned supplemental messages may be consumed by ContextPlan. */
export interface PreparedKnowledgeContribution {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly authority: "read-only";
  readonly trust: "host-approved-data";
  readonly coverage: "host-selected-document-keys";
  readonly workspaceId: string;
  readonly owner: KnowledgeContextOwner;
  readonly policySha256: string;
  readonly bindingSha256: string;
  readonly documents: readonly KnowledgeContextDocumentManifest[];
  readonly omissions: readonly KnowledgeContextOmission[];
  readonly complete: boolean;
  readonly messages: readonly {
    readonly role: "assistant";
    readonly content: string;
  }[];
  readonly reservations: {
    readonly envelopeBytes: number;
    readonly outputTokens: number;
    readonly slotBytes: number;
    readonly availableBytes: number;
    readonly contributedBytes: number;
  };
  readonly inputEstimate: {
    readonly tokens: null;
    readonly utf8ByteUpperBound: number;
    readonly estimated: true;
    readonly source: "utf8-byte-upper-bound";
    readonly contextWindow: number | null;
  };
}
export interface KnowledgeContextSourcePort {
  prepare(
    request: KnowledgeContextRequest,
  ): Promise<PreparedKnowledgeContribution>;
  assertFresh(
    contribution: PreparedKnowledgeContribution,
    signal: AbortSignal,
  ): Promise<void>;
  release(contribution: PreparedKnowledgeContribution): void;
}
/** All getters return actual primary-store DTOs; no reconstructed Session document substitutes. */
export interface KnowledgeContextSourcePorts {
  readonly readTx: <T>(operation: () => T) => T;
  readonly getWorkspace: (workspaceId: string) => Workspace;
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly assertOwnerCurrent: (
    workspaceId: string,
    owner: KnowledgeContextOwner,
  ) => void;
  readonly isPaused: (workspaceId: string) => boolean;
  readonly getDocumentHead: (
    workspaceId: string,
    key: string,
  ) => WorkspaceDocumentHead | undefined;
  readonly getDocumentRevision: (
    workspaceId: string,
    revisionId: string,
  ) => WorkspaceDocumentRevision | undefined;
  readonly getPublication: (
    workspaceId: string,
    publicationId: string,
  ) => KnowledgePublicationRecord | undefined;
  readonly getReceipt: (
    workspaceId: string,
    requestId: string,
  ) => KnowledgePublicationReceipt | undefined;
  readonly getCandidate: (
    workspaceId: string,
    candidateId: string,
  ) => KnowledgeCandidate | undefined;
  readonly getGeneration: (
    workspaceId: string,
    generationId: string,
  ) => KnowledgeGenerationRecord;
  readonly getAttempt: (
    workspaceId: string,
    attemptId: string,
  ) => KnowledgeGenerationAttempt;
  readonly getPlan: (
    workspaceId: string,
    planId: string,
  ) => KnowledgeGenerationPlan | undefined;
  readonly getTrust: (workspaceId: string) => TrustRevision | undefined;
  readonly getTrustRevision: (
    workspaceId: string,
    revisionId: string,
  ) => TrustRevision | undefined;
  readonly assertTrustSourcesCurrent: (
    binding: KnowledgeHostBinding,
    sources: readonly TrustSourcePin[],
  ) => void;
  readonly assertSourcesCurrent: (
    binding: KnowledgeHostBinding,
    source: KnowledgeSourceManifest,
  ) => void;
  readonly now?: () => number;
}
