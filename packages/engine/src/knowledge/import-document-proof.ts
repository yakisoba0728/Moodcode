import type { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import {
  readKnowledgePublicationHistory,
  type KnowledgePublicationHistory,
} from "./publication-history.js";
import {
  validateKnowledgePublicationArchiveRow,
  workspaceDocumentHeadId,
} from "./publication-store.js";
import { validateKnowledgeGenerationArchiveRow } from "./generation-store.js";
import type {
  KnowledgeGenerationAttempt,
  KnowledgeGenerationRecord,
} from "./generation-types.js";
import type {
  KnowledgePublicationReceipt,
  KnowledgePublicationRecord,
  WorkspaceDocumentHead,
  WorkspaceDocumentRevision,
} from "./publication-types.js";
import type {
  KnowledgeCandidate,
  KnowledgeGenerationPlan,
  TrustRevision,
} from "./types.js";
import {
  identifier,
  knowledgeHash,
  validateKnowledgeArchiveRow,
} from "./validation.js";

/** A bounded observation of actual primary rows, never an input supplied by a host approval DTO. */
export interface KnowledgeImportDocumentProof {
  readonly head: WorkspaceDocumentHead;
  readonly document: WorkspaceDocumentRevision;
  readonly publication: KnowledgePublicationRecord;
  readonly receipt: KnowledgePublicationReceipt;
  readonly history: KnowledgePublicationHistory;
  readonly currentTrust: TrustRevision | null;
}

export function readKnowledgeImportDocumentProof(
  db: DatabaseSync,
  workspaceId: string,
  documentKey: string,
): KnowledgeImportDocumentProof | undefined {
  identifier(workspaceId);
  identifier(documentKey);
  if (!db.isTransaction)
    throw new EngineError(
      "KNOWLEDGE_TRANSACTION_REQUIRED",
      "Import document proof requires the actual primary read transaction",
    );
  let observedBytes = 0;
  const fail = (): never => {
    throw new EngineError(
      "KNOWLEDGE_IMPORT_EVIDENCE_INVALID",
      "Native imported document proof is missing, oversized or disagrees with its indexed owner",
    );
  };
  const row = (
    table: string,
    id: string,
    optional = false,
  ): Record<string, unknown> | undefined => {
    const header = db
      .prepare(
        `SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE id=? AND workspace_id=?`,
      )
      .get(id, workspaceId);
    if (!header) return optional ? undefined : fail();
    const bytes = Number(header.bytes);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 65_536 ||
      observedBytes + bytes > 1_048_576
    )
      fail();
    observedBytes += bytes;
    const native = db
      .prepare(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`)
      .get(id, workspaceId)!;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(String(native.data)) as Record<string, unknown>;
    } catch {
      return fail();
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.workspaceId !== workspaceId ||
      (value.id ?? value.workspaceId) !== id
    )
      fail();
    const columns = {
      request_id: "requestId",
      document_key: "documentKey",
      revision: "revision",
      revision_id: "revisionId",
      publication_id: "publicationId",
      document_revision_id: "documentRevisionId",
      previous_revision_id: "previousRevisionId",
      status: "status",
      state: "state",
      operation: "operation",
      plan_id: "planId",
      generation_id: "generationId",
      trust_revision_id: "trustRevisionId",
      generation_owner_id: "generationOwnerId",
    };
    for (const [column, field] of Object.entries(columns))
      if (
        Object.hasOwn(native, column) &&
        Object.hasOwn(value, field) &&
        native[column] !== value[field]
      )
        fail();
    if (
      Object.hasOwn(native, "candidate_id") &&
      native.candidate_id !==
        (value.provenance as Record<string, unknown> | undefined)?.candidateId
    )
      fail();
    return value;
  };
  const pub = <T>(
    table:
      | "workspace_document_heads"
      | "workspace_document_revisions"
      | "knowledge_publications"
      | "knowledge_publication_receipts",
    id: string,
    optional = false,
  ): T | undefined => {
    const data = row(table, id, optional);
    return data
      ? (validateKnowledgePublicationArchiveRow({
          table,
          key: id,
          workspaceId,
          data,
        }).data as T)
      : undefined;
  };
  const legacy = <T>(
    table:
      | "knowledge_candidates"
      | "knowledge_generation_plans"
      | "workspace_trust_revisions",
    id: string,
  ): T =>
    validateKnowledgeArchiveRow({
      table,
      key: id,
      workspaceId,
      data: row(table, id),
    }).data as T;
  const head = pub<WorkspaceDocumentHead>(
    "workspace_document_heads",
    workspaceDocumentHeadId(workspaceId, documentKey),
    true,
  );
  if (!head) return undefined;
  const document = pub<WorkspaceDocumentRevision>(
    "workspace_document_revisions",
    head.revisionId,
  )!;
  const publication = pub<KnowledgePublicationRecord>(
    "knowledge_publications",
    document.publicationId,
  )!;
  const receiptHeader = db
    .prepare(
      "SELECT id FROM knowledge_publication_receipts WHERE workspace_id=? AND request_id=?",
    )
    .get(workspaceId, publication.requestId);
  if (!receiptHeader || typeof receiptHeader.id !== "string") return fail();
  const receipt = pub<KnowledgePublicationReceipt>(
    "knowledge_publication_receipts",
    receiptHeader.id,
  )!;
  const history = readKnowledgePublicationHistory(
    {
      getCandidate: (id, key) => {
        if (id !== workspaceId) fail();
        return legacy<KnowledgeCandidate>("knowledge_candidates", key);
      },
      getPlan: (id, key) => {
        if (id !== workspaceId) fail();
        return legacy<KnowledgeGenerationPlan>(
          "knowledge_generation_plans",
          key,
        );
      },
      getGeneration: (id, key) => {
        if (id !== workspaceId) fail();
        return validateKnowledgeGenerationArchiveRow({
          table: "knowledge_generations",
          key,
          workspaceId,
          data: row("knowledge_generations", key),
        }).data as KnowledgeGenerationRecord;
      },
      getAttempt: (id, key) => {
        if (id !== workspaceId) fail();
        return validateKnowledgeGenerationArchiveRow({
          table: "knowledge_generation_attempts",
          key,
          workspaceId,
          data: row("knowledge_generation_attempts", key),
        }).data as KnowledgeGenerationAttempt;
      },
      getTrustRevision: (id, key) => {
        if (id !== workspaceId) fail();
        return legacy<TrustRevision>("workspace_trust_revisions", key);
      },
    },
    workspaceId,
    publication.provenance.candidateId,
  );
  const trustHeader = db
    .prepare(
      "SELECT id,revision,revision_id FROM workspace_trust_heads WHERE workspace_id=?",
    )
    .get(workspaceId);
  let currentTrust: TrustRevision | null = null;
  if (trustHeader) {
    const rawHead = row("workspace_trust_heads", workspaceId)!;
    validateKnowledgeArchiveRow({
      table: "workspace_trust_heads",
      key: workspaceId,
      workspaceId,
      data: rawHead,
    });
    currentTrust = legacy<TrustRevision>(
      "workspace_trust_revisions",
      String(rawHead.revisionId),
    );
    if (
      trustHeader.id !== workspaceId ||
      currentTrust.revision !== trustHeader.revision ||
      currentTrust.id !== trustHeader.revision_id
    )
      fail();
  }
  const p = publication.provenance;
  if (
    head.documentKey !== documentKey ||
    document.documentKey !== documentKey ||
    head.revisionId !== document.id ||
    head.revision !== document.revision ||
    head.status !== document.status ||
    head.publicationId !== publication.id ||
    document.publicationId !== publication.id ||
    head.bodySha256 !== document.bodySha256 ||
    head.updatedAt !== document.createdAt ||
    publication.state !== "completed" ||
    publication.operation !== "publish" ||
    document.status !== "active" ||
    publication.documentRevisionId !== document.id ||
    publication.documentKey !== documentKey ||
    publication.body !== document.body ||
    publication.bodySha256 !== document.bodySha256 ||
    publication.updatedAt !== document.createdAt ||
    publication.expectedHeadRevision + 1 !== document.revision ||
    publication.expectedHeadRevisionId !== document.previousRevisionId ||
    Date.parse(publication.updatedAt) >= Date.parse(publication.expiresAt) ||
    knowledgeHash(publication.binding) !== knowledgeHash(document.binding) ||
    knowledgeHash(p) !== knowledgeHash(document.provenance) ||
    receipt.publicationId !== publication.id ||
    receipt.documentRevisionId !== document.id ||
    receipt.requestId !== publication.requestId ||
    receipt.requestSha256 !== publication.requestSha256 ||
    receipt.operation !== "publish" ||
    receipt.createdAt !== document.createdAt ||
    p.candidateId !== history.candidate.id ||
    p.candidateSha256 !== history.candidate.sha256 ||
    p.generationId !== history.generation.id ||
    p.generationSha256 !== history.generation.sha256 ||
    p.attemptId !== history.attempt.id ||
    p.attemptSha256 !== history.attempt.sha256 ||
    p.planId !== history.plan.id ||
    p.planSha256 !== history.plan.sha256 ||
    p.trustRevisionId !== history.trust.id ||
    p.trustRevisionSha256 !== history.trust.sha256 ||
    knowledgeHash(document.binding) !==
      knowledgeHash(history.candidate.binding) ||
    history.candidate.body !== document.body ||
    history.candidate.target.kind !== "workspace-document" ||
    history.candidate.target.key !== documentKey ||
    history.candidate.target.revision !== publication.expectedHeadRevision ||
    history.candidate.target.sha256 !== publication.expectedHeadSha256 ||
    history.candidate.expiresAt !== history.plan.expiresAt
  )
    fail();
  return Object.freeze({
    head,
    document,
    publication,
    receipt,
    history,
    currentTrust,
  });
}
