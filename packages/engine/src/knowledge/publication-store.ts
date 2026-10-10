import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { KnowledgeTarget } from "./types.js";
import type {
  KnowledgePublicationArchiveData,
  KnowledgePublicationArchiveRow,
  KnowledgePublicationCapture,
  KnowledgePublicationCommitResult,
  KnowledgePublicationListOptions,
  KnowledgePublicationPage,
  KnowledgePublicationProvenance,
  KnowledgePublicationReceipt,
  KnowledgePublicationRecord,
  KnowledgePublicationStoragePorts,
  KnowledgePublicationTable,
  PrepareKnowledgePublication,
  PrepareKnowledgePublicationResult,
  WorkspaceDocumentHead,
  WorkspaceDocumentRevision,
} from "./publication-types.js";
import {
  identifier,
  immutableKnowledgeJson,
  integer,
  knowledgeError,
  knowledgeHash,
  sha256,
  stamp,
  validateBinding,
  validateCandidate,
} from "./validation.js";

export const KNOWLEDGE_PUBLICATION_TABLES = Object.freeze([
  "knowledge_publications",
  "workspace_document_revisions",
  "workspace_document_heads",
  "knowledge_publication_receipts",
] as const);
export const KNOWLEDGE_PUBLICATION_SCHEMA_SQL = `
CREATE TABLE knowledge_publications (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('publish','revoke')),
 document_key TEXT NOT NULL, candidate_id TEXT NOT NULL REFERENCES knowledge_candidates(id),
 generation_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','completed','cancelled')),
 revision INTEGER NOT NULL CHECK(revision>0), document_revision_id TEXT,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536), UNIQUE(workspace_id,id), UNIQUE(workspace_id,request_id),
 FOREIGN KEY(workspace_id,generation_id) REFERENCES knowledge_generations(workspace_id,id),
 FOREIGN KEY(workspace_id,document_revision_id) REFERENCES workspace_document_revisions(workspace_id,id)
) STRICT;
CREATE TABLE workspace_document_revisions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 document_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), previous_revision_id TEXT,
 publication_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536), UNIQUE(workspace_id,id),
 UNIQUE(workspace_id,document_key,revision), UNIQUE(workspace_id,publication_id),
 FOREIGN KEY(workspace_id,previous_revision_id) REFERENCES workspace_document_revisions(workspace_id,id),
 FOREIGN KEY(workspace_id,publication_id) REFERENCES knowledge_publications(workspace_id,id)
) STRICT;
CREATE TABLE workspace_document_heads (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 document_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), revision_id TEXT NOT NULL,
 publication_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536), UNIQUE(workspace_id,document_key),
 FOREIGN KEY(workspace_id,revision_id) REFERENCES workspace_document_revisions(workspace_id,id),
 FOREIGN KEY(workspace_id,publication_id) REFERENCES knowledge_publications(workspace_id,id)
) STRICT;
CREATE TABLE knowledge_publication_receipts (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('publish','revoke')),
 publication_id TEXT NOT NULL, document_revision_id TEXT NOT NULL,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536), UNIQUE(workspace_id,request_id), UNIQUE(workspace_id,publication_id),
 FOREIGN KEY(workspace_id,publication_id) REFERENCES knowledge_publications(workspace_id,id),
 FOREIGN KEY(workspace_id,document_revision_id) REFERENCES workspace_document_revisions(workspace_id,id)
) STRICT;
CREATE INDEX knowledge_publication_workspace_page ON knowledge_publications(workspace_id,id);
CREATE INDEX workspace_document_revision_page ON workspace_document_revisions(workspace_id,document_key,id);
CREATE INDEX knowledge_publication_receipt_page ON knowledge_publication_receipts(workspace_id,id);
`;

type Row = {
  id: string;
  workspace_id: string;
  data: string;
  request_id?: string;
  operation?: string;
  document_key?: string;
  candidate_id?: string;
  generation_id?: string;
  state?: string;
  revision?: number;
  document_revision_id?: string | null;
  previous_revision_id?: string | null;
  publication_id?: string;
  status?: string;
  revision_id?: string;
};
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
const MAX_APPROVAL_MS = 300_000;
const COLUMNS: Readonly<Record<KnowledgePublicationTable, readonly string[]>> =
  Object.freeze({
    knowledge_publications: [
      "request_id",
      "operation",
      "document_key",
      "candidate_id",
      "generation_id",
      "state",
      "revision",
      "document_revision_id",
    ],
    workspace_document_revisions: [
      "document_key",
      "revision",
      "previous_revision_id",
      "publication_id",
      "status",
    ],
    workspace_document_heads: [
      "document_key",
      "revision",
      "revision_id",
      "publication_id",
      "status",
    ],
    knowledge_publication_receipts: [
      "request_id",
      "operation",
      "publication_id",
      "document_revision_id",
    ],
  });
function readRow(
  db: DatabaseSync,
  table: KnowledgePublicationTable,
  where: string,
  parameters: readonly SQLInputValue[],
): Row | undefined {
  const row = db
    .prepare(
      `SELECT id,workspace_id,${COLUMNS[table].join(",")},length(CAST(data AS BLOB)) AS data_bytes,CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND 65536 THEN data END AS data FROM ${table} WHERE ${where}`,
    )
    .get(...parameters) as (Row & { data_bytes: number }) | undefined;
  if (
    row &&
    (!Number.isSafeInteger(row.data_bytes) ||
      row.data_bytes < 1 ||
      row.data_bytes > 65536 ||
      typeof row.data !== "string")
  )
    knowledgeError(
      "KNOWLEDGE_PUBLICATION_LIMIT",
      "Native publication body exceeds its metadata-checked read bound",
    );
  return row;
}
function exact(
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
function boundedText(value: unknown, maximum = 16384): string {
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
function hashed<T extends object>(body: T): T & { readonly sha256: string } {
  return immutableKnowledgeJson({ ...body, sha256: knowledgeHash(body) });
}
function modified<T extends { sha256: string }>(record: T, patch: object): T {
  const { sha256: _old, ...body } = record;
  return hashed({ ...body, ...patch }) as unknown as T;
}
function hashValid(record: { sha256: string }): void {
  digest(record.sha256);
  const { sha256: expected, ...body } = record;
  if (knowledgeHash(body) !== expected)
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Publication row differs from its immutable hash",
    );
  if (Buffer.byteLength(JSON.stringify(record)) > 61440)
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
function validatePublication(value: unknown): KnowledgePublicationRecord {
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
function validateDocument(value: unknown): WorkspaceDocumentRevision {
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
function headFor(document: WorkspaceDocumentRevision): WorkspaceDocumentHead {
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
function validateHead(value: unknown): WorkspaceDocumentHead {
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
function validateReceipt(value: unknown): KnowledgePublicationReceipt {
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
function decode(
  row: Row,
  table: KnowledgePublicationTable,
): KnowledgePublicationArchiveData {
  if (Buffer.byteLength(row.data) > 65536)
    knowledgeError(
      "KNOWLEDGE_PUBLICATION_LIMIT",
      "Stored publication row exceeds its byte bound",
    );
  const record = validateKnowledgePublicationArchiveRow({
    table,
    key: row.id,
    workspaceId: row.workspace_id,
    data: JSON.parse(row.data),
  }).data;
  const fields = {
    request_id: "requestId",
    operation: "operation",
    document_key: "documentKey",
    state: "state",
    revision: "revision",
    document_revision_id: "documentRevisionId",
    previous_revision_id: "previousRevisionId",
    publication_id: "publicationId",
    status: "status",
    revision_id: "revisionId",
  } as const;
  for (const [column, field] of Object.entries(fields))
    if (
      Object.hasOwn(row, column) &&
      (record as unknown as Record<string, unknown>)[field] !==
        row[column as keyof Row]
    )
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Publication indexed columns disagree with their exact native body",
      );
  if (
    "provenance" in record &&
    ((row.candidate_id !== undefined &&
      row.candidate_id !== record.provenance.candidateId) ||
      (row.generation_id !== undefined &&
        row.generation_id !== record.provenance.generationId))
  )
    knowledgeError(
      "KNOWLEDGE_RECORD_CONFLICT",
      "Native publication provenance columns disagree",
    );
  return record;
}

/** SQL-only workspace documents. The native owner never manufactures a Session or invokes tools. */
export class KnowledgePublicationStorage {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgePublicationStoragePorts;
  readonly #epoch = randomUUID();
  readonly #owners = new WeakMap<object, KnowledgePublicationRecord>();
  readonly #live = new Set<object>();
  constructor(db: DatabaseSync, ports: KnowledgePublicationStoragePorts) {
    for (const key of [
      "writeTx",
      "getWorkspace",
      "checkBinding",
      "getCandidate",
      "assertCommitCurrent",
    ] as const)
      if (!ports || typeof ports[key] !== "function")
        knowledgeError(
          "INVALID_KNOWLEDGE_PUBLICATION_PORTS",
          "Native publication requires synchronous host and transaction ports",
        );
    if (ports.now !== undefined && typeof ports.now !== "function")
      knowledgeError(
        "INVALID_KNOWLEDGE_PUBLICATION_PORTS",
        "Publication clock must be callable",
      );
    this.#db = db;
    this.#ports = Object.freeze({ ...ports });
    Object.freeze(this);
  }
  private write<T>(operation: () => T): T {
    let entered = false;
    const result = this.#ports.writeTx(() => {
      if (entered || !this.#db.isTransaction)
        knowledgeError(
          "KNOWLEDGE_TRANSACTION_REQUIRED",
          "Publication writes require one primary SQL transaction",
        );
      entered = true;
      const value = operation();
      if (value && typeof value === "object" && "then" in value)
        knowledgeError(
          "KNOWLEDGE_ASYNC_PORT",
          "Publication transaction cannot cross an await",
        );
      return value;
    });
    if (!entered || (result && typeof result === "object" && "then" in result))
      knowledgeError(
        "KNOWLEDGE_TRANSACTION_REQUIRED",
        "Host publication transaction did not execute synchronously",
      );
    return result;
  }
  private now(floor = 0): number {
    const value = this.#ports.now?.() ?? Date.now();
    integer(value, 8640000000000000);
    return Math.max(floor, value);
  }
  private binding(workspaceId: string): ReturnType<typeof validateBinding> {
    identifier(workspaceId);
    const workspace = immutableKnowledgeJson(
        this.#ports.getWorkspace(workspaceId),
      ),
      bound = validateBinding(this.#ports.checkBinding(workspaceId));
    if (
      workspace.id !== workspaceId ||
      bound.workspaceId !== workspaceId ||
      workspace.root !== bound.root
    )
      knowledgeError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Publication workspace physical root disagrees",
      );
    return bound;
  }
  private assertBinding(binding: PrepareKnowledgePublication["binding"]): void {
    if (
      knowledgeHash(this.binding(binding.workspaceId)) !==
      knowledgeHash(binding)
    )
      knowledgeError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Publication was captured under another workspace/storage binding",
      );
  }
  getPublication(workspaceId: string, id: string): KnowledgePublicationRecord {
    identifier(workspaceId);
    identifier(id);
    const row = readRow(
      this.#db,
      "knowledge_publications",
      "workspace_id=? AND id=?",
      [workspaceId, id],
    );
    return row
      ? (decode(row, "knowledge_publications") as KnowledgePublicationRecord)
      : knowledgeError(
          "KNOWLEDGE_NOT_FOUND",
          "Native publication does not exist in this workspace",
        );
  }
  getDocumentHead(
    workspaceId: string,
    key: string,
  ): WorkspaceDocumentHead | undefined {
    identifier(workspaceId);
    identifier(key);
    const row = readRow(
      this.#db,
      "workspace_document_heads",
      "workspace_id=? AND document_key=?",
      [workspaceId, key],
    );
    return row
      ? (decode(row, "workspace_document_heads") as WorkspaceDocumentHead)
      : undefined;
  }
  getDocumentRevision(
    workspaceId: string,
    id: string,
  ): WorkspaceDocumentRevision | undefined {
    identifier(workspaceId);
    identifier(id);
    const row = readRow(
      this.#db,
      "workspace_document_revisions",
      "workspace_id=? AND id=?",
      [workspaceId, id],
    );
    return row
      ? (decode(
          row,
          "workspace_document_revisions",
        ) as WorkspaceDocumentRevision)
      : undefined;
  }
  getCurrentDocument(
    workspaceId: string,
    key: string,
  ): WorkspaceDocumentRevision | undefined {
    const head = this.getDocumentHead(workspaceId, key);
    if (!head) return undefined;
    const document =
      this.getDocumentRevision(workspaceId, head.revisionId) ??
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Current document head has no actual revision",
      );
    if (knowledgeHash(head) !== knowledgeHash(headFor(document)))
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Current document head differs from its exact revision",
      );
    return document;
  }
  captureDocumentTarget(
    workspaceId: string,
    key: string,
  ): Extract<KnowledgeTarget, { kind: "workspace-document" }> {
    identifier(workspaceId);
    identifier(key);
    const current = this.getCurrentDocument(workspaceId, key);
    return Object.freeze({
      kind: "workspace-document",
      key,
      revision: current?.revision ?? 0,
      sha256: current?.bodySha256 ?? null,
    });
  }
  /** Receipt lookup is by the host's exact requestId, rather than the random receipt row ID. */
  getReceipt(
    workspaceId: string,
    requestId: string,
  ): KnowledgePublicationReceipt | undefined {
    identifier(workspaceId);
    identifier(requestId);
    const row = readRow(
      this.#db,
      "knowledge_publication_receipts",
      "workspace_id=? AND request_id=?",
      [workspaceId, requestId],
    );
    return row
      ? (decode(
          row,
          "knowledge_publication_receipts",
        ) as KnowledgePublicationReceipt)
      : undefined;
  }
  /** The returned head describes this historical commit; the current head is a separate getter. */
  getCommitted(
    workspaceId: string,
    id: string,
  ): KnowledgePublicationCommitResult {
    const publication = this.getPublication(workspaceId, id);
    if (publication.state !== "completed" || !publication.documentRevisionId)
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_INCOMPLETE",
        "Only completed publication has an applied document and receipt",
      );
    const document =
      this.getDocumentRevision(workspaceId, publication.documentRevisionId) ??
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Completed publication has no document revision",
      );
    const receipt =
      this.getReceipt(workspaceId, publication.requestId) ??
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Completed publication has no exact receipt",
      );
    if (
      document.publicationId !== publication.id ||
      document.documentKey !== publication.documentKey ||
      document.body !== publication.body ||
      document.bodySha256 !== publication.bodySha256 ||
      document.revision !== publication.expectedHeadRevision + 1 ||
      knowledgeHash(document.binding) !== knowledgeHash(publication.binding) ||
      knowledgeHash(document.provenance) !==
        knowledgeHash(publication.provenance) ||
      document.status !==
        (publication.operation === "publish" ? "active" : "revoked") ||
      receipt.publicationId !== publication.id ||
      receipt.documentRevisionId !== document.id ||
      receipt.requestSha256 !== publication.requestSha256 ||
      receipt.operation !== publication.operation
    )
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Historical completed publication tuple is inconsistent",
      );
    return Object.freeze({
      publication,
      document,
      head: headFor(document),
      receipt,
    });
  }
  findRequest(
    input: PrepareKnowledgePublication,
  ): KnowledgePublicationRecord | undefined {
    const request = validatePrepareKnowledgePublication(input),
      fingerprint = knowledgeHash(request),
      receipt = this.getReceipt(request.workspaceId, request.requestId);
    const row = receipt
      ? undefined
      : readRow(
          this.#db,
          "knowledge_publications",
          "workspace_id=? AND request_id=?",
          [request.workspaceId, request.requestId],
        );
    const record = receipt
      ? this.getCommitted(request.workspaceId, receipt.publicationId)
          .publication
      : row
        ? (decode(row, "knowledge_publications") as KnowledgePublicationRecord)
        : undefined;
    if (!record) return undefined;
    if (
      record.requestSha256 !== fingerprint ||
      (receipt && receipt.requestSha256 !== fingerprint)
    )
      knowledgeError(
        "KNOWLEDGE_REQUEST_CONFLICT",
        "Publication request ID already describes another exact approval",
      );
    this.assertBinding(record.binding);
    return record;
  }
  private candidateBody(request: PrepareKnowledgePublication): string {
    const input =
      this.#ports.getCandidate(
        request.workspaceId,
        request.provenance.candidateId,
      ) ??
      knowledgeError(
        "KNOWLEDGE_NOT_FOUND",
        "Publication requires an actual immutable pending candidate",
      );
    const candidate = validateCandidate(input);
    if (
      candidate.workspaceId !== request.workspaceId ||
      candidate.sha256 !== request.provenance.candidateSha256 ||
      candidate.generationOwnerId !== request.provenance.generationId ||
      candidate.planId !== request.provenance.planId ||
      candidate.trustRevisionId !== request.provenance.trustRevisionId ||
      knowledgeHash(candidate.binding) !== knowledgeHash(request.binding)
    )
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_PROVENANCE_CHANGED",
        "Publication candidate differs from its exact original approval",
      );
    if (candidate.target.kind !== "workspace-document")
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_TARGET_UNSUPPORTED",
        "Only native workspace-document publication is implemented",
      );
    if (candidate.target.key !== request.documentKey)
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_PROVENANCE_CHANGED",
        "Candidate was generated for another document key",
      );
    if (
      request.operation === "publish" &&
      (candidate.target.revision !== request.expectedHeadRevision ||
        candidate.target.sha256 !== request.expectedHeadSha256 ||
        candidate.bodySha256 !== request.bodySha256)
    )
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_PROVENANCE_CHANGED",
        "Candidate target preimage or body changed before publication",
      );
    return request.operation === "publish" ? candidate.body : "";
  }
  prepare(
    input: PrepareKnowledgePublication,
  ): PrepareKnowledgePublicationResult {
    const request = validatePrepareKnowledgePublication(input);
    const duplicate = this.findRequest(request);
    if (duplicate) return { kind: "duplicate", record: duplicate };
    if (this.#live.size >= 128)
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_LIMIT",
        "Release original approval captures before preparing more",
      );
    const result = this.write(() => {
      const duplicate = this.findRequest(request);
      if (duplicate) return { kind: "duplicate" as const, record: duplicate };
      this.assertBinding(request.binding);
      const body = this.candidateBody(request);
      if (request.operation === "revoke") {
        const previous = this.getPublication(
          request.workspaceId,
          request.existingPublicationId!,
        );
        if (
          previous.state !== "completed" ||
          previous.operation !== "publish" ||
          previous.sha256 !== request.existingPublicationSha256 ||
          previous.documentKey !== request.documentKey ||
          previous.documentRevisionId !== request.expectedHeadRevisionId ||
          knowledgeHash(previous.provenance) !==
            knowledgeHash(request.provenance)
        )
          knowledgeError(
            "KNOWLEDGE_PUBLICATION_PROVENANCE_CHANGED",
            "Revoke must pin the exact original active publication",
          );
      }
      const now = this.now();
      if (
        Date.parse(request.expiresAt) <= now ||
        Date.parse(request.expiresAt) > now + MAX_APPROVAL_MS
      )
        knowledgeError(
          "KNOWLEDGE_PUBLICATION_EXPIRED",
          "Approval requires one bounded original future deadline",
        );
      const value = validatePublication(
        hashed({
          ...request,
          id: randomUUID(),
          requestSha256: knowledgeHash(request),
          runtimeEpoch: this.#epoch,
          revision: 1,
          state: "prepared" as const,
          body,
          documentRevisionId: null,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          errorCode: null,
        }),
      );
      this.assertBinding(request.binding);
      this.#db
        .prepare(
          "INSERT INTO knowledge_publications(id,workspace_id,request_id,operation,document_key,candidate_id,generation_id,state,revision,document_revision_id,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          value.id,
          value.workspaceId,
          value.requestId,
          value.operation,
          value.documentKey,
          value.provenance.candidateId,
          value.provenance.generationId,
          value.state,
          value.revision,
          value.documentRevisionId,
          JSON.stringify(value),
        );
      return { kind: "created" as const, record: value };
    });
    if (result.kind === "duplicate") return result;
    const record = result.record,
      capture = Object.freeze({
        workspaceId: record.workspaceId,
        publicationId: record.id,
        runtimeEpoch: this.#epoch,
      });
    this.#owners.set(capture, record);
    this.#live.add(capture);
    return { kind: "created", capture, record };
  }
  private owned(
    capture: KnowledgePublicationCapture,
  ): KnowledgePublicationRecord {
    if (!capture || typeof capture !== "object" || !this.#live.has(capture))
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_HANDLE_INVALID",
        "Publication approval is foreign, copied or released",
      );
    return (
      this.#owners.get(capture) ??
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_HANDLE_INVALID",
        "Publication approval was never issued",
      )
    );
  }
  private active(
    capture: KnowledgePublicationCapture,
  ): KnowledgePublicationRecord {
    const issued = this.owned(capture),
      record = this.getPublication(issued.workspaceId, issued.id);
    if (
      record.sha256 !== issued.sha256 ||
      record.runtimeEpoch !== this.#epoch ||
      record.state !== "prepared"
    )
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_STALE",
        "Publication owner epoch or terminal fence changed",
      );
    return record;
  }
  private save(
    previous: KnowledgePublicationRecord,
    next: KnowledgePublicationRecord,
  ): void {
    validatePublication(next);
    const result = this.#db
      .prepare(
        "UPDATE knowledge_publications SET state=?,revision=?,document_revision_id=?,data=? WHERE workspace_id=? AND id=? AND state=? AND revision=? AND data=?",
      )
      .run(
        next.state,
        next.revision,
        next.documentRevisionId,
        JSON.stringify(next),
        previous.workspaceId,
        previous.id,
        previous.state,
        previous.revision,
        JSON.stringify(previous),
      );
    if (result.changes !== 1)
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_STALE",
        "Publication native owner CAS failed",
      );
  }
  private expectedHead(
    record: KnowledgePublicationRecord,
  ): WorkspaceDocumentHead | undefined {
    const current = this.getCurrentDocument(
        record.workspaceId,
        record.documentKey,
      ),
      head = this.getDocumentHead(record.workspaceId, record.documentKey);
    if (
      (head?.revision ?? 0) !== record.expectedHeadRevision ||
      (head?.bodySha256 ?? null) !== record.expectedHeadSha256 ||
      (head?.revisionId ?? null) !== record.expectedHeadRevisionId
    )
      knowledgeError(
        "KNOWLEDGE_DOCUMENT_REVISION_CONFLICT",
        "Document head changed since the original approval preview",
      );
    if (
      record.operation === "revoke" &&
      (!head ||
        head.status !== "active" ||
        head.publicationId !== record.existingPublicationId ||
        current?.status !== "active")
    )
      knowledgeError(
        "KNOWLEDGE_DOCUMENT_REVISION_CONFLICT",
        "Only the exact current active document can be revoked",
      );
    return head;
  }
  commit(
    capture: KnowledgePublicationCapture,
  ): KnowledgePublicationCommitResult {
    const issued = this.owned(capture);
    if (issued.state === "completed")
      return this.getCommitted(issued.workspaceId, issued.id);
    const result = this.write(() => {
      const record = this.active(capture);
      const receipt = this.getReceipt(record.workspaceId, record.requestId);
      if (receipt) {
        if (
          receipt.requestSha256 !== record.requestSha256 ||
          receipt.publicationId !== record.id
        )
          knowledgeError(
            "KNOWLEDGE_REQUEST_CONFLICT",
            "Exact approval receipt belongs to another native owner",
          );
        return this.getCommitted(record.workspaceId, record.id);
      }
      this.assertBinding(record.binding);
      if (this.now() >= Date.parse(record.expiresAt))
        knowledgeError(
          "KNOWLEDGE_PUBLICATION_EXPIRED",
          "Original approval deadline elapsed",
        );
      if (this.candidateBody(record) !== record.body)
        knowledgeError(
          "KNOWLEDGE_PUBLICATION_PROVENANCE_CHANGED",
          "Publication body changed after the original owner capture",
        );
      if (this.#ports.assertCommitCurrent(record) !== undefined)
        knowledgeError(
          "KNOWLEDGE_ASYNC_PORT",
          "Publication freshness and historical producer checks must be synchronous",
        );
      this.active(capture);
      this.assertBinding(record.binding);
      if (this.now() >= Date.parse(record.expiresAt))
        knowledgeError(
          "KNOWLEDGE_PUBLICATION_EXPIRED",
          "Approval expired during current provenance checks",
        );
      if (this.candidateBody(record) !== record.body)
        knowledgeError(
          "KNOWLEDGE_PUBLICATION_PROVENANCE_CHANGED",
          "Candidate changed while checking publication authority",
        );
      const previous = this.expectedHead(record);
      if (record.expectedHeadRevision === Number.MAX_SAFE_INTEGER)
        knowledgeError(
          "KNOWLEDGE_PUBLICATION_LIMIT",
          "Document history revision limit reached",
        );
      if (record.operation === "revoke") {
        const origin = this.getPublication(
          record.workspaceId,
          record.existingPublicationId!,
        );
        if (
          origin.sha256 !== record.existingPublicationSha256 ||
          origin.state !== "completed" ||
          origin.documentRevisionId !== record.expectedHeadRevisionId
        )
          knowledgeError(
            "KNOWLEDGE_PUBLICATION_PROVENANCE_CHANGED",
            "Original active publication changed during revoke approval",
          );
      }
      const time = new Date(
          this.now(Date.parse(record.updatedAt)),
        ).toISOString(),
        document = validateDocument(
          hashed({
            id: randomUUID(),
            workspaceId: record.workspaceId,
            documentKey: record.documentKey,
            revision: record.expectedHeadRevision + 1,
            previousRevisionId: previous?.revisionId ?? null,
            publicationId: record.id,
            status: record.operation === "publish" ? "active" : "revoked",
            binding: record.binding,
            provenance: record.provenance,
            body: record.body,
            bodySha256: record.bodySha256,
            createdAt: time,
          }),
        ),
        head = validateHead(headFor(document)),
        publication = modified(record, {
          revision: record.revision + 1,
          state: "completed",
          documentRevisionId: document.id,
          updatedAt: time,
          errorCode: null,
        }),
        receiptValue = validateReceipt(
          hashed({
            id: randomUUID(),
            workspaceId: record.workspaceId,
            requestId: record.requestId,
            requestSha256: record.requestSha256,
            publicationId: record.id,
            documentRevisionId: document.id,
            operation: record.operation,
            createdAt: time,
          }),
        );
      this.#db
        .prepare(
          "INSERT INTO workspace_document_revisions(id,workspace_id,document_key,revision,previous_revision_id,publication_id,status,data) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          document.id,
          document.workspaceId,
          document.documentKey,
          document.revision,
          document.previousRevisionId,
          document.publicationId,
          document.status,
          JSON.stringify(document),
        );
      if (previous) {
        const changed = this.#db
          .prepare(
            "UPDATE workspace_document_heads SET revision=?,revision_id=?,publication_id=?,status=?,data=? WHERE id=? AND workspace_id=? AND document_key=? AND revision=? AND revision_id=? AND data=?",
          )
          .run(
            head.revision,
            head.revisionId,
            head.publicationId,
            head.status,
            JSON.stringify(head),
            previous.id,
            record.workspaceId,
            record.documentKey,
            previous.revision,
            previous.revisionId,
            JSON.stringify(previous),
          );
        if (changed.changes !== 1)
          knowledgeError(
            "KNOWLEDGE_DOCUMENT_REVISION_CONFLICT",
            "Document head compare-and-set lost its original revision",
          );
      } else
        this.#db
          .prepare(
            "INSERT INTO workspace_document_heads(id,workspace_id,document_key,revision,revision_id,publication_id,status,data) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            head.id,
            head.workspaceId,
            head.documentKey,
            head.revision,
            head.revisionId,
            head.publicationId,
            head.status,
            JSON.stringify(head),
          );
      this.save(record, publication);
      this.#db
        .prepare(
          "INSERT INTO knowledge_publication_receipts(id,workspace_id,request_id,operation,publication_id,document_revision_id,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          receiptValue.id,
          receiptValue.workspaceId,
          receiptValue.requestId,
          receiptValue.operation,
          receiptValue.publicationId,
          receiptValue.documentRevisionId,
          JSON.stringify(receiptValue),
        );
      return Object.freeze({
        publication,
        document,
        head,
        receipt: receiptValue,
      });
    });
    this.#owners.set(capture, result.publication);
    return result;
  }
  cancel(
    capture: KnowledgePublicationCapture,
    errorCode = "KNOWLEDGE_PUBLICATION_CANCELLED",
  ): KnowledgePublicationRecord {
    identifier(errorCode);
    const record = this.write(() => {
      const previous = this.active(capture);
      const next = modified(previous, {
        state: "cancelled",
        revision: previous.revision + 1,
        updatedAt: new Date(
          this.now(Date.parse(previous.updatedAt)),
        ).toISOString(),
        errorCode,
      });
      this.save(previous, next);
      return next;
    });
    this.#owners.set(capture, record);
    return record;
  }
  release(capture: KnowledgePublicationCapture): void {
    const issued = this.owned(capture);
    try {
      const current = this.getPublication(issued.workspaceId, issued.id);
      if (current.state === "prepared") this.cancel(capture);
    } finally {
      this.#owners.delete(capture);
      this.#live.delete(capture);
    }
  }
  recoverInterruptedOwners(): { cancelled: number } {
    let cancelled = 0;
    for (;;) {
      const ids = this.#db
        .prepare(
          "SELECT id,workspace_id FROM knowledge_publications WHERE state='prepared' AND json_extract(data,'$.runtimeEpoch')<>? ORDER BY id LIMIT 16",
        )
        .all(this.#epoch) as { id: string; workspace_id: string }[];
      if (!ids.length) break;
      if (cancelled + ids.length > 4096)
        knowledgeError(
          "KNOWLEDGE_PUBLICATION_LIMIT",
          "Interrupted publication recovery reached its bounded sweep",
        );
      const count = this.write(() => {
        let changed = 0;
        for (const id of ids) {
          const old = this.getPublication(id.workspace_id, id.id);
          if (old.state !== "prepared" || old.runtimeEpoch === this.#epoch)
            continue;
          this.save(
            old,
            modified(old, {
              state: "cancelled",
              revision: old.revision + 1,
              updatedAt: new Date(
                this.now(Date.parse(old.updatedAt)),
              ).toISOString(),
              errorCode: "KNOWLEDGE_PUBLICATION_INTERRUPTED_NOT_APPLIED",
            }),
          );
          changed++;
        }
        return changed;
      });
      cancelled += count;
    }
    return { cancelled };
  }
  listPublications(
    workspaceId: string,
    options: KnowledgePublicationListOptions = {},
  ): KnowledgePublicationPage<KnowledgePublicationRecord> {
    return this.page(
      "knowledge_publications",
      workspaceId,
      undefined,
      options,
    ) as KnowledgePublicationPage<KnowledgePublicationRecord>;
  }
  listDocumentRevisions(
    workspaceId: string,
    key: string,
    options: KnowledgePublicationListOptions = {},
  ): KnowledgePublicationPage<WorkspaceDocumentRevision> {
    identifier(key);
    return this.page(
      "workspace_document_revisions",
      workspaceId,
      key,
      options,
    ) as KnowledgePublicationPage<WorkspaceDocumentRevision>;
  }
  private page(
    table: KnowledgePublicationTable,
    workspaceId: string,
    key: string | undefined,
    options: KnowledgePublicationListOptions,
  ): KnowledgePublicationPage<KnowledgePublicationArchiveData> {
    identifier(workspaceId);
    const value = immutableKnowledgeJson(options);
    exact(value, [], ["after", "limit", "maxBytes"]);
    if (value.after !== undefined) identifier(value.after);
    const limit = integer(value.limit ?? 32, 32),
      maxBytes = integer(value.maxBytes ?? 1048576, 1048576);
    if (!limit || !maxBytes)
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_LIMIT",
        "Publication pages need positive bounded row/byte budgets",
      );
    const params: SQLInputValue[] = [
      workspaceId,
      value.after === undefined ? "" : identifier(value.after),
    ];
    if (key !== undefined) params.push(key);
    params.push(limit + 1);
    const metadata = this.#db
      .prepare(
        `SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE workspace_id=? AND id>? ${key === undefined ? "" : "AND document_key=?"} ORDER BY id LIMIT ?`,
      )
      .iterate(...params) as Iterable<{
      id: string;
      workspace_id: string;
      bytes: number;
    }>;
    const items: KnowledgePublicationArchiveData[] = [];
    let bytes = 0,
      next: string | null = null;
    for (const row of metadata) {
      if (items.length === limit) {
        next = items.at(-1)!.id;
        break;
      }
      if (
        !Number.isSafeInteger(row.bytes) ||
        row.bytes < 1 ||
        row.bytes > 65536
      )
        knowledgeError(
          "KNOWLEDGE_PUBLICATION_LIMIT",
          "Native page row exceeds its metadata-checked bound",
        );
      if (bytes + row.bytes > maxBytes) {
        if (!items.length)
          knowledgeError(
            "KNOWLEDGE_PUBLICATION_LIMIT",
            "First publication row exceeds page bytes",
          );
        next = items.at(-1)!.id;
        break;
      }
      const loaded =
        readRow(this.#db, table, "workspace_id=? AND id=?", [
          workspaceId,
          row.id,
        ]) ??
        knowledgeError(
          "KNOWLEDGE_RECORD_CONFLICT",
          "Publication page row changed during bounded read",
        );
      if (Buffer.byteLength(loaded.data) !== row.bytes)
        knowledgeError(
          "KNOWLEDGE_RECORD_CONFLICT",
          "Publication page metadata changed",
        );
      items.push(decode(loaded, table));
      bytes += row.bytes;
    }
    return Object.freeze({ items: Object.freeze(items), next, bytes });
  }
}
