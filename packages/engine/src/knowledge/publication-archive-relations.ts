import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  KNOWLEDGE_PUBLICATION_TABLES,
  validateKnowledgePublicationArchiveRow,
} from "./publication-store.js";
import { validateKnowledgeGenerationArchiveRow } from "./generation-store.js";
import type {
  KnowledgeGenerationAttempt,
  KnowledgeGenerationRecord,
} from "./generation-types.js";
import type {
  KnowledgePublicationProvenance,
  KnowledgePublicationReceipt,
  KnowledgePublicationRecord,
  KnowledgePublicationTable,
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
  knowledgeError,
  sameKnowledge as same,
  validateKnowledgeArchiveRow,
} from "./validation.js";

type Table =
  | KnowledgePublicationTable
  | "knowledge_candidates"
  | "knowledge_generation_plans"
  | "workspace_trust_revisions"
  | "knowledge_generations"
  | "knowledge_generation_attempts";
type Header = {
  id: string;
  workspace_id: string;
  bytes: number;
  [key: string]: SQLInputValue;
};
const ROW_BYTES = 65_536;
const COLUMNS: Readonly<Record<Table, Readonly<Record<string, string>>>> = {
  knowledge_publications: {
    request_id: "requestId",
    operation: "operation",
    document_key: "documentKey",
    candidate_id: "provenance.candidateId",
    generation_id: "provenance.generationId",
    state: "state",
    revision: "revision",
    document_revision_id: "documentRevisionId",
  },
  workspace_document_revisions: {
    document_key: "documentKey",
    revision: "revision",
    previous_revision_id: "previousRevisionId",
    publication_id: "publicationId",
    status: "status",
  },
  workspace_document_heads: {
    document_key: "documentKey",
    revision: "revision",
    revision_id: "revisionId",
    publication_id: "publicationId",
    status: "status",
  },
  knowledge_publication_receipts: {
    request_id: "requestId",
    operation: "operation",
    publication_id: "publicationId",
    document_revision_id: "documentRevisionId",
  },
  knowledge_candidates: {
    plan_id: "planId",
    trust_revision_id: "trustRevisionId",
    generation_owner_id: "generationOwnerId",
  },
  knowledge_generation_plans: { trust_revision_id: "trustRevisionId" },
  workspace_trust_revisions: { revision: "revision" },
  knowledge_generations: {
    plan_id: "planId",
    request_id: "requestId",
    state: "state",
    revision: "revision",
  },
  knowledge_generation_attempts: {
    generation_id: "generationId",
    plan_id: "planId",
    state: "state",
    revision: "revision",
  },
};
function invalid(message: string): never {
  return knowledgeError("KNOWLEDGE_PUBLICATION_RELATION_INVALID", message);
}

/** Historical graph validation only: no freshness check, owner capture, activation or replay. */
export function validateKnowledgePublicationDatabase(
  db: DatabaseSync,
  check: () => void,
): void {
  function headers(
    table: Table,
    where = "",
    params: readonly SQLInputValue[] = [],
  ): Iterable<Header> {
    check();
    return db
      .prepare(
        `SELECT id,workspace_id,${Object.keys(COLUMNS[table]).join(",")},length(CAST(data AS BLOB)) AS bytes FROM ${table} ${where}`,
      )
      .iterate(...params) as Iterable<Header>;
  }
  function read<T>(table: Table, header: Header): T {
    check();
    identifier(header.id);
    identifier(header.workspace_id);
    if (
      !Number.isSafeInteger(header.bytes) ||
      header.bytes < 1 ||
      header.bytes > ROW_BYTES
    )
      invalid("Publication graph row exceeds its bound before body loading");
    const row = db
      .prepare(
        `SELECT CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${ROW_BYTES} THEN data END AS data FROM ${table} WHERE workspace_id=? AND id=?`,
      )
      .get(header.workspace_id, header.id);
    if (
      !row ||
      typeof row.data !== "string" ||
      Buffer.byteLength(row.data) !== header.bytes
    )
      invalid("Publication graph row changed during bounded reading");
    check();
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      return invalid("Publication graph row is not JSON");
    }
    const wrapper = {
      table,
      key: header.id,
      workspaceId: header.workspace_id,
      data: parsed,
    };
    const data = (KNOWLEDGE_PUBLICATION_TABLES.includes(
      table as KnowledgePublicationTable,
    )
      ? validateKnowledgePublicationArchiveRow(wrapper).data
      : table === "knowledge_generations" ||
          table === "knowledge_generation_attempts"
        ? validateKnowledgeGenerationArchiveRow(wrapper).data
        : validateKnowledgeArchiveRow(wrapper).data) as unknown as Record<
      string,
      unknown
    >;
    for (const [column, field] of Object.entries(COLUMNS[table])) {
      const value = field
        .split(".")
        .reduce<unknown>(
          (current, key) =>
            current && typeof current === "object"
              ? (current as Record<string, unknown>)[key]
              : undefined,
          data,
        );
      if (header[column] !== value)
        invalid("Publication graph indexed columns differ from the actual row");
    }
    return data as T;
  }
  function one<T>(
    table: Table,
    where: string,
    params: readonly SQLInputValue[],
  ): T | undefined {
    let result: T | undefined;
    for (const header of headers(table, `WHERE ${where} LIMIT 2`, params)) {
      if (result !== undefined)
        invalid("Exact publication relation resolves to multiple rows");
      result = read<T>(table, header);
    }
    return result;
  }
  function exact<T>(table: Table, workspaceId: string, id: string): T {
    return (
      one<T>(table, "workspace_id=? AND id=?", [workspaceId, id]) ??
      invalid("Publication references a missing original workspace record")
    );
  }
  function provenance(
    workspaceId: string,
    pins: KnowledgePublicationProvenance,
  ): KnowledgeCandidate {
    const candidate = exact<KnowledgeCandidate>(
      "knowledge_candidates",
      workspaceId,
      pins.candidateId,
    );
    const generation = exact<KnowledgeGenerationRecord>(
      "knowledge_generations",
      workspaceId,
      pins.generationId,
    );
    const attempt = exact<KnowledgeGenerationAttempt>(
      "knowledge_generation_attempts",
      workspaceId,
      pins.attemptId,
    );
    const plan = exact<KnowledgeGenerationPlan>(
      "knowledge_generation_plans",
      workspaceId,
      pins.planId,
    );
    const trust = exact<TrustRevision>(
      "workspace_trust_revisions",
      workspaceId,
      pins.trustRevisionId,
    );
    if (
      candidate.sha256 !== pins.candidateSha256 ||
      generation.sha256 !== pins.generationSha256 ||
      attempt.sha256 !== pins.attemptSha256 ||
      plan.sha256 !== pins.planSha256 ||
      trust.sha256 !== pins.trustRevisionSha256 ||
      candidate.generationOwnerId !== generation.id ||
      candidate.planId !== plan.id ||
      candidate.trustRevisionId !== trust.id ||
      generation.attemptId !== attempt.id ||
      attempt.generationId !== generation.id ||
      generation.planId !== plan.id ||
      attempt.planId !== plan.id ||
      generation.state !== "completed" ||
      generation.candidate.state !== "recorded" ||
      generation.candidate.candidateId !== candidate.id ||
      attempt.state !== "completed" ||
      attempt.output !== candidate.body ||
      attempt.outputSha256 !== candidate.bodySha256 ||
      attempt.outputTruncated ||
      attempt.finishReason !== "stop" ||
      !attempt.streamDone ||
      attempt.cleanup?.confirmed !== true ||
      !same(candidate.usage, attempt.usage) ||
      !same(candidate.binding, plan.binding) ||
      !same(candidate.source, plan.source) ||
      !same(candidate.target, plan.target) ||
      trust.decision !== "allow" ||
      candidate.trustRevision !== trust.revision
    ) {
      invalid(
        "Publication provenance differs from the original completed producer and immutable candidate",
      );
    }
    return candidate;
  }
  function checkPublication(publication: KnowledgePublicationRecord): void {
    const candidate = provenance(
      publication.workspaceId,
      publication.provenance,
    );
    if (
      !same(publication.binding, candidate.binding) ||
      candidate.target.kind !== "workspace-document" ||
      candidate.target.key !== publication.documentKey
    )
      invalid("Publication scope differs from its original candidate");
    if (
      publication.operation === "publish" &&
      (publication.body !== candidate.body ||
        publication.bodySha256 !== candidate.bodySha256 ||
        publication.expectedHeadRevision !== candidate.target.revision ||
        publication.expectedHeadSha256 !== candidate.target.sha256)
    )
      invalid(
        "Published output or target preimage differs from its approved candidate",
      );
    const doc = one<WorkspaceDocumentRevision>(
      "workspace_document_revisions",
      "workspace_id=? AND publication_id=?",
      [publication.workspaceId, publication.id],
    );
    const receipt = one<KnowledgePublicationReceipt>(
      "knowledge_publication_receipts",
      "workspace_id=? AND publication_id=?",
      [publication.workspaceId, publication.id],
    );
    if (publication.state !== "completed") {
      if (doc || receipt)
        invalid(
          "Uncommitted publication acquired a document or effect receipt",
        );
      return;
    }
    if (
      !doc ||
      !receipt ||
      doc.id !== publication.documentRevisionId ||
      doc.documentKey !== publication.documentKey ||
      doc.revision !== publication.expectedHeadRevision + 1 ||
      doc.previousRevisionId !== publication.expectedHeadRevisionId ||
      doc.body !== publication.body ||
      doc.bodySha256 !== publication.bodySha256 ||
      doc.status !==
        (publication.operation === "publish" ? "active" : "revoked") ||
      !same(doc.binding, publication.binding) ||
      !same(doc.provenance, publication.provenance) ||
      receipt.documentRevisionId !== doc.id ||
      receipt.requestId !== publication.requestId ||
      receipt.operation !== publication.operation ||
      receipt.requestSha256 !== publication.requestSha256 ||
      receipt.createdAt !== doc.createdAt ||
      doc.createdAt !== publication.updatedAt ||
      Date.parse(doc.createdAt) < Date.parse(publication.createdAt) ||
      Date.parse(doc.createdAt) >= Date.parse(publication.expiresAt)
    )
      invalid(
        "Completed publication does not match its original atomic document and receipt",
      );
    if (publication.expectedHeadRevision === 0) {
      if (
        doc.previousRevisionId !== null ||
        publication.expectedHeadSha256 !== null
      )
        invalid("Initial publication claims a fabricated document preimage");
    } else {
      const previous = exact<WorkspaceDocumentRevision>(
        "workspace_document_revisions",
        publication.workspaceId,
        publication.expectedHeadRevisionId!,
      );
      if (
        previous.documentKey !== doc.documentKey ||
        previous.revision !== doc.revision - 1 ||
        previous.bodySha256 !== publication.expectedHeadSha256 ||
        !same(previous.binding, doc.binding) ||
        Date.parse(previous.createdAt) > Date.parse(doc.createdAt)
      )
        invalid("Publication predecessor or exact CAS preimage is invalid");
      if (publication.operation === "revoke") {
        const original = exact<KnowledgePublicationRecord>(
          "knowledge_publications",
          publication.workspaceId,
          publication.existingPublicationId!,
        );
        if (
          previous.status !== "active" ||
          previous.publicationId !== original.id ||
          original.state !== "completed" ||
          original.operation !== "publish" ||
          original.sha256 !== publication.existingPublicationSha256 ||
          original.documentRevisionId !== previous.id ||
          !same(original.provenance, publication.provenance)
        )
          invalid(
            "Revocation does not reduce the exact previous active publication",
          );
      }
    }
  }
  for (const header of headers("knowledge_publications"))
    checkPublication(
      read<KnowledgePublicationRecord>("knowledge_publications", header),
    );
  for (const header of headers("workspace_document_revisions")) {
    const doc = read<WorkspaceDocumentRevision>(
      "workspace_document_revisions",
      header,
    );
    const owner = exact<KnowledgePublicationRecord>(
      "knowledge_publications",
      doc.workspaceId,
      doc.publicationId,
    );
    if (owner.state !== "completed" || owner.documentRevisionId !== doc.id)
      invalid("Document revision has no exact completed publication owner");
    const head = one<WorkspaceDocumentHead>(
      "workspace_document_heads",
      "workspace_id=? AND document_key=?",
      [doc.workspaceId, doc.documentKey],
    );
    if (!head || head.revision < doc.revision)
      invalid("Document history has a missing or regressed head");
  }
  for (const header of headers("workspace_document_heads")) {
    const head = read<WorkspaceDocumentHead>(
      "workspace_document_heads",
      header,
    );
    const doc = exact<WorkspaceDocumentRevision>(
      "workspace_document_revisions",
      head.workspaceId,
      head.revisionId,
    );
    if (
      head.documentKey !== doc.documentKey ||
      head.revision !== doc.revision ||
      head.publicationId !== doc.publicationId ||
      head.status !== doc.status ||
      head.bodySha256 !== doc.bodySha256 ||
      head.updatedAt !== doc.createdAt
    )
      invalid("Document head differs from its actual latest revision");
    check();
    const latest = db
      .prepare(
        "SELECT max(revision) AS revision FROM workspace_document_revisions WHERE workspace_id=? AND document_key=?",
      )
      .get(head.workspaceId, head.documentKey);
    if (latest?.revision !== head.revision)
      invalid(
        "Document head silently omits a newer published or revoked revision",
      );
  }
  for (const header of headers("knowledge_publication_receipts")) {
    const receipt = read<KnowledgePublicationReceipt>(
      "knowledge_publication_receipts",
      header,
    );
    const publication = exact<KnowledgePublicationRecord>(
      "knowledge_publications",
      receipt.workspaceId,
      receipt.publicationId,
    );
    if (
      publication.state !== "completed" ||
      publication.requestId !== receipt.requestId ||
      publication.requestSha256 !== receipt.requestSha256 ||
      publication.documentRevisionId !== receipt.documentRevisionId ||
      publication.operation !== receipt.operation
    )
      invalid(
        "Publication receipt refers to an unrelated or unfinished effect",
      );
  }
}
