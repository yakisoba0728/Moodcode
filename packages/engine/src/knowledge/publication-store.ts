import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  guardedWrite,
  type GuardedWriteOptions,
} from "../storage/transaction.js";
import { fieldAt } from "./archive-graph.js";
import type { KnowledgeTarget } from "./types.js";
import type {
  KnowledgePublicationArchiveData,
  KnowledgePublicationCapture,
  KnowledgePublicationCommitResult,
  KnowledgePublicationListOptions,
  KnowledgePublicationPage,
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
  completedPublicationMismatch,
  exact,
  MAX_APPROVAL_MS,
  validateDocument,
  validateHead,
  validateKnowledgePublicationArchiveRow,
  validatePrepareKnowledgePublication,
  validatePublication,
  validateReceipt,
  workspaceDocumentHeadFor,
} from "./publication-validation.js";
import {
  identifier,
  immutableKnowledgeJson,
  integer,
  KNOWLEDGE_LIMITS,
  knowledgeError,
  knowledgeHash,
  resealKnowledge as modified,
  sameKnowledge,
  validateBinding,
  validateCandidate,
  withKnowledgeHash as hashed,
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
  [column: string]: SQLInputValue;
};
/** SQL columns that mirror publication body fields, as dotted body paths. */
export const KNOWLEDGE_PUBLICATION_COLUMNS: Readonly<
  Record<KnowledgePublicationTable, Readonly<Record<string, string>>>
> = Object.freeze({
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
});
function readRow(
  db: DatabaseSync,
  table: KnowledgePublicationTable,
  where: string,
  parameters: readonly SQLInputValue[],
): Row | undefined {
  const row = db
    .prepare(
      `SELECT id,workspace_id,${Object.keys(KNOWLEDGE_PUBLICATION_COLUMNS[table]).join(",")},length(CAST(data AS BLOB)) AS data_bytes,CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${KNOWLEDGE_LIMITS.rowBytes} THEN data END AS data FROM ${table} WHERE ${where}`,
    )
    .get(...parameters) as (Row & { data_bytes: number }) | undefined;
  if (
    row &&
    (!Number.isSafeInteger(row.data_bytes) ||
      row.data_bytes < 1 ||
      row.data_bytes > KNOWLEDGE_LIMITS.rowBytes ||
      typeof row.data !== "string")
  )
    knowledgeError(
      "KNOWLEDGE_PUBLICATION_LIMIT",
      "Native publication body exceeds its metadata-checked read bound",
    );
  return row;
}
function decode(
  row: Row,
  table: KnowledgePublicationTable,
): KnowledgePublicationArchiveData {
  if (Buffer.byteLength(row.data) > KNOWLEDGE_LIMITS.rowBytes)
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
  for (const [column, path] of Object.entries(
    KNOWLEDGE_PUBLICATION_COLUMNS[table],
  ))
    if (Object.hasOwn(row, column) && fieldAt(record, path) !== row[column])
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Publication indexed columns disagree with their exact native body",
      );
  return record;
}

const WRITE: GuardedWriteOptions = {
  join: false,
  innerAsyncCheck: true,
  required: () =>
    knowledgeError(
      "KNOWLEDGE_TRANSACTION_REQUIRED",
      "Publication writes require one primary SQL transaction",
    ),
  async: () =>
    knowledgeError(
      "KNOWLEDGE_ASYNC_PORT",
      "Publication transaction cannot cross an await",
    ),
  detached: () =>
    knowledgeError(
      "KNOWLEDGE_TRANSACTION_REQUIRED",
      "Host publication transaction did not execute synchronously",
    ),
};

/** SQL-only workspace documents. The native owner never manufactures a Session or invokes tools. */
export class KnowledgePublicationStorage {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgePublicationStoragePorts;
  readonly #epoch = randomUUID();
  readonly #owners = new Map<object, KnowledgePublicationRecord>();
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
    return guardedWrite(this.#db, this.#ports, operation, WRITE);
  }
  private now(floor = 0): number {
    const value = this.#ports.now?.() ?? Date.now();
    integer(value, 8_640_000_000_000_000);
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
    if (!sameKnowledge(this.binding(binding.workspaceId), binding))
      knowledgeError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Publication was captured under another workspace/storage binding",
      );
  }
  private find<T extends KnowledgePublicationArchiveData>(
    table: KnowledgePublicationTable,
    column: "id" | "document_key" | "request_id",
    workspaceId: string,
    value: string,
  ): T | undefined {
    identifier(workspaceId);
    identifier(value);
    const row = readRow(this.#db, table, `workspace_id=? AND ${column}=?`, [
      workspaceId,
      value,
    ]);
    return row ? (decode(row, table) as T) : undefined;
  }
  /** Throws KNOWLEDGE_NOT_FOUND when the publication does not exist. */
  getPublication(workspaceId: string, id: string): KnowledgePublicationRecord {
    return (
      this.find<KnowledgePublicationRecord>(
        "knowledge_publications",
        "id",
        workspaceId,
        id,
      ) ??
      knowledgeError(
        "KNOWLEDGE_NOT_FOUND",
        "Native publication does not exist in this workspace",
      )
    );
  }
  getDocumentHead(
    workspaceId: string,
    key: string,
  ): WorkspaceDocumentHead | undefined {
    return this.find(
      "workspace_document_heads",
      "document_key",
      workspaceId,
      key,
    );
  }
  getDocumentRevision(
    workspaceId: string,
    id: string,
  ): WorkspaceDocumentRevision | undefined {
    return this.find("workspace_document_revisions", "id", workspaceId, id);
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
    if (!sameKnowledge(head, workspaceDocumentHeadFor(document)))
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
  getReceipt(
    workspaceId: string,
    requestId: string,
  ): KnowledgePublicationReceipt | undefined {
    return this.find(
      "knowledge_publication_receipts",
      "request_id",
      workspaceId,
      requestId,
    );
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
    if (completedPublicationMismatch(publication, document, receipt))
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Historical completed publication tuple is inconsistent",
      );
    return Object.freeze({
      publication,
      document,
      head: workspaceDocumentHeadFor(document),
      receipt,
    });
  }
  findRequest(
    input: PrepareKnowledgePublication,
  ): KnowledgePublicationRecord | undefined {
    const request = validatePrepareKnowledgePublication(input),
      fingerprint = knowledgeHash(request),
      receipt = this.getReceipt(request.workspaceId, request.requestId);
    const record = receipt
      ? this.getCommitted(request.workspaceId, receipt.publicationId)
          .publication
      : this.find<KnowledgePublicationRecord>(
          "knowledge_publications",
          "request_id",
          request.workspaceId,
          request.requestId,
        );
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
      !sameKnowledge(candidate.binding, request.binding)
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
    if (this.#owners.size >= KNOWLEDGE_LIMITS.handles)
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
          !sameKnowledge(previous.provenance, request.provenance)
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
      this.insert("knowledge_publications", value);
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
    return { kind: "created", capture, record };
  }
  private owned(
    capture: KnowledgePublicationCapture,
  ): KnowledgePublicationRecord {
    if (!capture || typeof capture !== "object" || !this.#owners.has(capture))
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_HANDLE_INVALID",
        "Publication approval is foreign, copied or released",
      );
    return this.#owners.get(capture)!;
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
  private insert(
    table: KnowledgePublicationTable,
    record: KnowledgePublicationArchiveData,
  ): void {
    const columns = Object.entries(KNOWLEDGE_PUBLICATION_COLUMNS[table]);
    this.#db
      .prepare(
        `INSERT INTO ${table}(id,workspace_id,${columns.map(([column]) => column).join(",")},data) VALUES(${"?,".repeat(columns.length + 2)}?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        ...columns.map(([, path]) => fieldAt(record, path) as SQLInputValue),
        JSON.stringify(record),
      );
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
      const time = new Date(
        this.now(Date.parse(record.updatedAt)),
      ).toISOString();
      if (Date.parse(time) >= Date.parse(record.expiresAt))
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
      const document = validateDocument(
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
        head = validateHead(workspaceDocumentHeadFor(document)),
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
      this.insert("workspace_document_revisions", document);
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
      } else this.insert("workspace_document_heads", head);
      this.save(record, publication);
      this.insert("knowledge_publication_receipts", receiptValue);
      return Object.freeze({
        publication,
        document,
        head,
        receipt: receiptValue,
      });
    });
    this.refresh(capture, result.publication);
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
    this.refresh(capture, record);
    return record;
  }
  /** A capture released while its write ran stays released. */
  private refresh(
    capture: KnowledgePublicationCapture,
    record: KnowledgePublicationRecord,
  ): void {
    if (this.#owners.has(capture)) this.#owners.set(capture, record);
  }
  release(capture: KnowledgePublicationCapture): void {
    const issued = this.owned(capture);
    try {
      const current = this.getPublication(issued.workspaceId, issued.id);
      if (current.state === "prepared") this.cancel(capture);
    } finally {
      this.#owners.delete(capture);
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
      cancelled += this.write(() => {
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
    const after = value.after === undefined ? "" : identifier(value.after);
    const limit = integer(
        value.limit ?? KNOWLEDGE_LIMITS.pageRows,
        KNOWLEDGE_LIMITS.pageRows,
      ),
      maxBytes = integer(
        value.maxBytes ?? KNOWLEDGE_LIMITS.pageBytes,
        KNOWLEDGE_LIMITS.pageBytes,
      );
    if (!limit || !maxBytes)
      knowledgeError(
        "KNOWLEDGE_PUBLICATION_LIMIT",
        "Publication pages need positive bounded row/byte budgets",
      );
    const params: SQLInputValue[] = [workspaceId, after];
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
        row.bytes > KNOWLEDGE_LIMITS.rowBytes
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
