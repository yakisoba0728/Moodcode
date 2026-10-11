import { verifySealed } from "../shared/canonical.js";
import type {
  KnowledgePublicationArchiveData,
  KnowledgePublicationArchiveRow,
  KnowledgePublicationProvenance,
  KnowledgePublicationReceipt,
  KnowledgePublicationRecord,
  PrepareKnowledgePublication,
  WorkspaceDocumentHead,
  WorkspaceDocumentRevision,
} from "./publication-types.js";
import {
  identifier,
  immutableKnowledgeJson,
  integer,
  KNOWLEDGE_LIMITS,
  knowledgeError,
  knowledgeHash,
  sha256,
  stamp,
  validateBinding,
  withKnowledgeHash as hashed,
} from "./validation.js";

const INPUT_FIELDS = [
  "workspaceId",
  "requestId",
  "operation",
  "binding",
  "documentKey",
  "expectedHeadRevision",
  "expectedHeadSha256",
  "expectedHeadRevisionId",
  "provenance",
  "existingPublicationId",
  "existingPublicationSha256",
  "bodySha256",
  "expiresAt",
] as const;
const PROVENANCE_FIELDS = [
  "candidateId",
  "candidateSha256",
  "generationId",
  "generationSha256",
  "attemptId",
  "attemptSha256",
  "planId",
  "planSha256",
  "trustRevisionId",
  "trustRevisionSha256",
] as const;
export const MAX_APPROVAL_MS = 300_000;
export function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Expected a plain publication object",
    );
  const actual = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Publication fields do not match their exact bounded contract",
    );
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Publication hashes must be lowercase SHA-256",
    );
  return value as string;
}
function boundedText(
  value: unknown,
  maximum = KNOWLEDGE_LIMITS.bodyBytes,
): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > maximum ||
    Buffer.from(value).toString("utf8") !== value ||
    value.includes("\u0000")
  )
    knowledgeError(
      "KNOWLEDGE_PUBLICATION_LIMIT",
      "Publication text must be bounded valid UTF-8",
    );
  return value as string;
}
function hashValid(record: { sha256: string }): void {
  digest(record.sha256);
  verifySealed(record, () =>
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Publication row differs from its immutable hash",
    ),
  );
  if (
    Buffer.byteLength(JSON.stringify(record)) >
    KNOWLEDGE_LIMITS.rowBytes - 4_096
  )
    knowledgeError(
      "KNOWLEDGE_PUBLICATION_LIMIT",
      "Publication row must leave room for its archive envelope",
    );
}
function provenance(value: unknown): KnowledgePublicationProvenance {
  const p = immutableKnowledgeJson(value);
  exact(p, PROVENANCE_FIELDS);
  for (const key of PROVENANCE_FIELDS)
    key.endsWith("Sha256") ? digest(p[key]) : identifier(p[key]);
  return p as unknown as KnowledgePublicationProvenance;
}
function inputShape(value: Record<string, unknown>): void {
  identifier(value.workspaceId);
  identifier(value.requestId);
  identifier(value.documentKey);
  if (!["publish", "revoke"].includes(String(value.operation)))
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Publication requires an explicit publish or revoke operation",
    );
  const b = validateBinding(value.binding);
  if (b.workspaceId !== value.workspaceId)
    knowledgeError(
      "KNOWLEDGE_SCOPE_MISMATCH",
      "Publication binding belongs to another workspace",
    );
  provenance(value.provenance);
  const revision = integer(value.expectedHeadRevision);
  if (value.expectedHeadSha256 !== null) digest(value.expectedHeadSha256);
  if (value.expectedHeadRevisionId !== null)
    identifier(value.expectedHeadRevisionId);
  if (
    (revision === 0) !== (value.expectedHeadSha256 === null) ||
    (revision === 0) !== (value.expectedHeadRevisionId === null)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Only a genuinely absent document may have revision zero",
    );
  digest(value.bodySha256);
  stamp(value.expiresAt);
  if (value.operation === "publish") {
    if (
      value.existingPublicationId !== null ||
      value.existingPublicationSha256 !== null
    )
      knowledgeError(
        "INVALID_KNOWLEDGE_PUBLICATION",
        "Publish cannot claim an unrelated revoke owner",
      );
  } else {
    identifier(value.existingPublicationId);
    digest(value.existingPublicationSha256);
    if (revision === 0 || value.bodySha256 !== sha256(""))
      knowledgeError(
        "INVALID_KNOWLEDGE_PUBLICATION",
        "Revoke needs an actual existing revision and exact empty output",
      );
  }
}
export function validatePrepareKnowledgePublication(
  value: unknown,
): PrepareKnowledgePublication {
  const r = immutableKnowledgeJson(value);
  exact(r, INPUT_FIELDS);
  inputShape(r);
  return r as unknown as PrepareKnowledgePublication;
}
export function validatePublication(
  value: unknown,
): KnowledgePublicationRecord {
  const r = immutableKnowledgeJson(value);
  exact(r, [
    ...INPUT_FIELDS,
    "id",
    "requestSha256",
    "runtimeEpoch",
    "revision",
    "state",
    "body",
    "documentRevisionId",
    "createdAt",
    "updatedAt",
    "errorCode",
    "sha256",
  ]);
  inputShape(r);
  identifier(r.id);
  identifier(r.runtimeEpoch);
  digest(r.requestSha256);
  if (
    !integer(r.revision) ||
    !["prepared", "completed", "cancelled"].includes(String(r.state))
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Unknown native publication state",
    );
  boundedText(r.body);
  if (sha256(r.body as string) !== r.bodySha256)
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Publication body does not describe its original approved output",
    );
  stamp(r.createdAt);
  stamp(r.updatedAt);
  if (
    Date.parse(r.updatedAt as string) < Date.parse(r.createdAt as string) ||
    Date.parse(r.expiresAt as string) <= Date.parse(r.createdAt as string) ||
    Date.parse(r.expiresAt as string) >
      Date.parse(r.createdAt as string) + MAX_APPROVAL_MS
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Original publication approval time frontier is invalid",
    );
  if (r.documentRevisionId !== null) identifier(r.documentRevisionId);
  if (r.errorCode !== null) identifier(r.errorCode);
  if (
    (r.state === "completed") !== (r.documentRevisionId !== null) ||
    (r.state === "completed" && r.errorCode !== null) ||
    (r.state === "prepared" && r.errorCode !== null) ||
    (r.state === "cancelled" && r.errorCode === null)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Publication terminal state disagrees with its receipt authority",
    );
  if (
    (r.operation === "publish" && !(r.body as string).trim()) ||
    (r.operation === "revoke" && r.body !== "")
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Publish retains exact nonempty candidate text; revoke retains no active text",
    );
  const request: Record<string, unknown> = {};
  for (const key of INPUT_FIELDS) request[key] = r[key];
  if (knowledgeHash(request) !== r.requestSha256)
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Publication approval fingerprint changed",
    );
  hashValid(r as unknown as KnowledgePublicationRecord);
  return r as unknown as KnowledgePublicationRecord;
}
export function validateDocument(value: unknown): WorkspaceDocumentRevision {
  const r = immutableKnowledgeJson(value);
  exact(r, [
    "id",
    "workspaceId",
    "documentKey",
    "revision",
    "previousRevisionId",
    "publicationId",
    "status",
    "binding",
    "provenance",
    "body",
    "bodySha256",
    "createdAt",
    "sha256",
  ]);
  for (const key of ["id", "workspaceId", "documentKey", "publicationId"])
    identifier(r[key]);
  if (!integer(r.revision) || !["active", "revoked"].includes(String(r.status)))
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Invalid document history status or revision",
    );
  if (r.previousRevisionId !== null) identifier(r.previousRevisionId);
  if ((r.revision === 1) !== (r.previousRevisionId === null))
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Document revision predecessor is inconsistent",
    );
  if (validateBinding(r.binding).workspaceId !== r.workspaceId)
    knowledgeError(
      "KNOWLEDGE_SCOPE_MISMATCH",
      "Document binding belongs to another workspace",
    );
  provenance(r.provenance);
  boundedText(r.body);
  digest(r.bodySha256);
  if (
    sha256(r.body as string) !== r.bodySha256 ||
    (r.status === "revoked" && r.body !== "") ||
    (r.status === "active" && !(r.body as string).trim())
  )
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Document body differs from its active/revoked history",
    );
  stamp(r.createdAt);
  hashValid(r as unknown as WorkspaceDocumentRevision);
  return r as unknown as WorkspaceDocumentRevision;
}
export function workspaceDocumentHeadId(
  workspaceId: string,
  key: string,
): string {
  identifier(workspaceId);
  identifier(key);
  return knowledgeHash({ workspaceId, documentKey: key });
}
export function workspaceDocumentHeadFor(
  document: WorkspaceDocumentRevision,
): WorkspaceDocumentHead {
  return hashed({
    id: workspaceDocumentHeadId(document.workspaceId, document.documentKey),
    workspaceId: document.workspaceId,
    documentKey: document.documentKey,
    revision: document.revision,
    revisionId: document.id,
    publicationId: document.publicationId,
    status: document.status,
    bodySha256: document.bodySha256,
    updatedAt: document.createdAt,
  });
}
export function validateHead(value: unknown): WorkspaceDocumentHead {
  const r = immutableKnowledgeJson(value);
  exact(r, [
    "id",
    "workspaceId",
    "documentKey",
    "revision",
    "revisionId",
    "publicationId",
    "status",
    "bodySha256",
    "updatedAt",
    "sha256",
  ]);
  for (const key of [
    "id",
    "workspaceId",
    "documentKey",
    "revisionId",
    "publicationId",
  ])
    identifier(r[key]);
  if (
    !integer(r.revision) ||
    !["active", "revoked"].includes(String(r.status)) ||
    r.id !==
      workspaceDocumentHeadId(r.workspaceId as string, r.documentKey as string)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Document head must reference one positive historical revision",
    );
  digest(r.bodySha256);
  stamp(r.updatedAt);
  hashValid(r as unknown as WorkspaceDocumentHead);
  return r as unknown as WorkspaceDocumentHead;
}
export function validateReceipt(value: unknown): KnowledgePublicationReceipt {
  const r = immutableKnowledgeJson(value);
  exact(r, [
    "id",
    "workspaceId",
    "requestId",
    "requestSha256",
    "publicationId",
    "documentRevisionId",
    "operation",
    "createdAt",
    "sha256",
  ]);
  for (const key of [
    "id",
    "workspaceId",
    "requestId",
    "publicationId",
    "documentRevisionId",
  ])
    identifier(r[key]);
  digest(r.requestSha256);
  if (!["publish", "revoke"].includes(String(r.operation)))
    knowledgeError(
      "INVALID_KNOWLEDGE_PUBLICATION",
      "Unknown publication receipt operation",
    );
  stamp(r.createdAt);
  hashValid(r as unknown as KnowledgePublicationReceipt);
  return r as unknown as KnowledgePublicationReceipt;
}
export function validateKnowledgePublicationArchiveRow(
  value: unknown,
): KnowledgePublicationArchiveRow {
  const r = immutableKnowledgeJson(value);
  exact(r, ["table", "key", "workspaceId", "data"]);
  identifier(r.key);
  identifier(r.workspaceId);
  let body: KnowledgePublicationArchiveData;
  switch (r.table) {
    case "knowledge_publications":
      body = validatePublication(r.data);
      break;
    case "workspace_document_revisions":
      body = validateDocument(r.data);
      break;
    case "workspace_document_heads":
      body = validateHead(r.data);
      break;
    case "knowledge_publication_receipts":
      body = validateReceipt(r.data);
      break;
    default:
      return knowledgeError(
        "INVALID_KNOWLEDGE_PUBLICATION",
        "Unknown native publication archive table",
      );
  }
  if (body.id !== r.key || body.workspaceId !== r.workspaceId)
    knowledgeError(
      "KNOWLEDGE_SCOPE_MISMATCH",
      "Publication archive key and workspace disagree",
    );
  return r as unknown as KnowledgePublicationArchiveRow;
}
