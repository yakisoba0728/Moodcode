import type { DatabaseSync } from "node:sqlite";
import {
  createKnowledgeGraphReader,
  KNOWLEDGE_PRODUCER_COLUMNS,
  type KnowledgeGraphFault,
} from "./archive-graph.js";
import {
  KNOWLEDGE_PUBLICATION_COLUMNS,
  KNOWLEDGE_PUBLICATION_TABLES,
} from "./publication-store.js";
import {
  completedPublicationMismatch,
  validateKnowledgePublicationArchiveRow,
  workspaceDocumentHeadFor,
} from "./publication-validation.js";
import {
  KNOWLEDGE_GENERATION_COLUMNS,
  validateKnowledgeGenerationArchiveRow,
} from "./generation-validation.js";
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
const COLUMNS: Readonly<Record<Table, Readonly<Record<string, string>>>> =
  Object.freeze({
    ...KNOWLEDGE_PUBLICATION_COLUMNS,
    ...KNOWLEDGE_PRODUCER_COLUMNS,
    knowledge_generations: KNOWLEDGE_GENERATION_COLUMNS.knowledge_generations,
    knowledge_generation_attempts:
      KNOWLEDGE_GENERATION_COLUMNS.knowledge_generation_attempts,
  });
const FAULTS: Readonly<Record<KnowledgeGraphFault, string>> = {
  bound: "Publication graph row exceeds its bound before body loading",
  changed: "Publication graph row changed during bounded reading",
  json: "Publication graph row is not JSON",
  columns: "Publication graph indexed columns differ from the actual row",
  multiple: "Exact publication relation resolves to multiple rows",
  missing: "Publication references a missing original workspace record",
};
function invalid(message: string): never {
  return knowledgeError("KNOWLEDGE_PUBLICATION_RELATION_INVALID", message);
}

/** Historical graph validation only: no freshness check, owner capture, activation or replay. */
export function validateKnowledgePublicationDatabase(
  db: DatabaseSync,
  check: () => void,
): void {
  const { headers, read, one, exact } = createKnowledgeGraphReader<Table>(
    db,
    check,
    {
      columns: COLUMNS,
      validate: (row) =>
        (KNOWLEDGE_PUBLICATION_TABLES.includes(
          row.table as KnowledgePublicationTable,
        )
          ? validateKnowledgePublicationArchiveRow(row)
          : row.table === "knowledge_generations" ||
              row.table === "knowledge_generation_attempts"
            ? validateKnowledgeGenerationArchiveRow(row)
            : validateKnowledgeArchiveRow(row)
        ).data,
      invalid: (fault) => invalid(FAULTS[fault]),
    },
  );
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
    )
      invalid(
        "Publication provenance differs from the original completed producer and immutable candidate",
      );
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
      completedPublicationMismatch(publication, doc, receipt)
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
    if (!same(head, workspaceDocumentHeadFor(doc)))
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
