import type { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import {
  knowledgePublicationProvenance,
  readKnowledgePublicationHistory,
  type KnowledgePublicationHistory,
} from "./publication-history.js";
import {
  completedPublicationMismatch,
  validateKnowledgePublicationArchiveRow,
  workspaceDocumentHeadFor,
  workspaceDocumentHeadId,
} from "./publication-validation.js";
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
  sameKnowledge as same,
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

export function assertImportedDocumentChain(
  chain: Omit<KnowledgeImportDocumentProof, "currentTrust">,
  documentKey: string,
  fail: () => never,
): void {
  const { head, document, publication, receipt, history } = chain;
  if (
    head.documentKey !== documentKey ||
    head.status !== "active" ||
    !same(head, workspaceDocumentHeadFor(document)) ||
    publication.state !== "completed" ||
    publication.operation !== "publish" ||
    completedPublicationMismatch(publication, document, receipt) ||
    !same(document.binding, history.candidate.binding) ||
    !same(document.provenance, knowledgePublicationProvenance(history)) ||
    history.candidate.body !== document.body ||
    history.candidate.bodySha256 !== document.bodySha256 ||
    history.candidate.target.kind !== "workspace-document" ||
    history.candidate.target.key !== documentKey ||
    history.candidate.target.revision !== publication.expectedHeadRevision ||
    history.candidate.target.sha256 !== publication.expectedHeadSha256 ||
    history.candidate.expiresAt !== history.plan.expiresAt
  )
    fail();
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
  const coreRow = <T>(table: string, id: string): T =>
    validateKnowledgeArchiveRow({
      table,
      key: id,
      workspaceId,
      data: row(table, id),
    }).data as T;
  const scoped =
    <T>(table: string) =>
    (id: string, key: string): T =>
      (id === workspaceId ? row(table, key) : fail()) as T;
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
      getCandidate: scoped<KnowledgeCandidate>("knowledge_candidates"),
      getPlan: scoped<KnowledgeGenerationPlan>("knowledge_generation_plans"),
      getGeneration: scoped<KnowledgeGenerationRecord>("knowledge_generations"),
      getAttempt: scoped<KnowledgeGenerationAttempt>(
        "knowledge_generation_attempts",
      ),
      getTrustRevision: scoped<TrustRevision>("workspace_trust_revisions"),
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
    const trustHead = coreRow<{ revisionId: string }>(
      "workspace_trust_heads",
      workspaceId,
    );
    currentTrust = coreRow<TrustRevision>(
      "workspace_trust_revisions",
      trustHead.revisionId,
    );
    if (
      trustHeader.id !== workspaceId ||
      currentTrust.revision !== trustHeader.revision ||
      currentTrust.id !== trustHeader.revision_id
    )
      fail();
  }
  assertImportedDocumentChain(
    { head, document, publication, receipt, history },
    documentKey,
    fail,
  );
  return Object.freeze({
    head,
    document,
    publication,
    receipt,
    history,
    currentTrust,
  });
}
