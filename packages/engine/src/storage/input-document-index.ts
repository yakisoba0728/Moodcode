import { types } from 'node:util';
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { EngineError, type InputDocumentAttachment } from "@moodcode/contracts";
import { attachment, DEFAULT_DOCUMENT_LIMITS } from "../documents/validation.js";

interface IndexBounds {
  maxDocuments: number;
  maxRefs: number;
  maxJsonBytes: number;
}
const LIMITS: Readonly<IndexBounds> = Object.freeze({
  maxDocuments: 64,
  maxRefs: 2048,
  maxJsonBytes: 4_194_304,
});
const DOCUMENT_BYTES = 262_144;
const OWNER_BYTES = 16_384;
export interface InputDocumentIndexOptions {
  maxDocuments?: number;
  maxRefs?: number;
  maxJsonBytes?: number;
  signal?: AbortSignal;
}
export interface InputDocumentIndexReport {
  scope: "primary-database-only";
  observedAt: string;
  complete: boolean;
  totalDocuments: number;
  sampledDocuments: number;
  invalidDocuments: number;
  omittedDocuments: number;
  invalidReferences: number;
  omittedReferences: number | null;
  sampledJsonBytes: number;
  documents: Array<{
    sessionId: string;
    workspaceId: string;
    workspaceRoot: string;
    revision: number;
    referenceCount: number;
  }>;
  refs: Array<
    InputDocumentAttachment & { sessionId: string; workspaceId: string }
  >;
  documentIds: string[];
  declaredBytes: number | null;
  limits: { maxDocuments: number; maxRefs: number; maxJsonBytes: number };
  reasons: string[];
  coverage: {
    source: "session_documents.input_documents";
    ownerValidation: "joined-session-workspace-and-stored-payload";
    bytes: "UTF-8 sampled JSON and declared unique reference bytes";
    sql: "bounded metadata/payload rows; document count may scan primary headers";
    childDatabases: "not-read";
    childBlobs: "not-read";
    filesystem: "not-read";
    physicalReadBytes: null;
  };
}
function cancel(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new EngineError(
      "CANCELLED",
      "Input document index inspection was cancelled",
    );
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !types.isProxy(value) && value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function root(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 4096 &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}
function options(value: InputDocumentIndexOptions): {
  bounds: typeof LIMITS;
  signal?: AbortSignal;
} {
  if (!plain(value))
    throw new EngineError(
      "INVALID_DOCUMENT_INDEX_OPTIONS",
      "Document index options must be plain bounded data",
    );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !["maxDocuments", "maxRefs", "maxJsonBytes", "signal"].includes(key) ||
        !Object.hasOwn(descriptors[key]!, "value"),
    )
  ) {
    throw new EngineError(
      "INVALID_DOCUMENT_INDEX_OPTIONS",
      "Document index options must be plain bounded data",
    );
  }
  const bounds = { ...LIMITS };
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const number =
      descriptors[key]?.value === undefined
        ? LIMITS[key]
        : descriptors[key]!.value;
    if (!Number.isSafeInteger(number) || number < 1 || number > LIMITS[key])
      throw new EngineError(
        "INVALID_DOCUMENT_INDEX_OPTIONS",
        "Document index bounds exceed supported limits",
      );
    bounds[key] = number;
  }
  const signal = descriptors.signal?.value;
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new EngineError(
      "INVALID_DOCUMENT_INDEX_OPTIONS",
      "Document index signal must be an AbortSignal",
    );
  return { bounds, signal };
}

/** Inspect only primary document indexes. Completeness never certifies a blob or safe deletion. */
export function inspectInputDocumentIndex(
  database: DatabaseSync,
  input: InputDocumentIndexOptions = {},
): InputDocumentIndexReport {
  const { bounds, signal } = options(input);
  cancel(signal);
  const totalDocuments = Number(
    database
      .prepare(
        "SELECT count(*) AS total FROM session_documents WHERE kind='input_documents'",
      )
      .get()?.total,
  );
  const metadata = database
    .prepare(
      `SELECT CAST(d.rowid AS TEXT) AS document_id,
    CASE WHEN d.revision BETWEEN 1 AND 9007199254740991 THEN d.revision ELSE 0 END AS revision,
    length(CAST(d.data AS BLOB)) AS document_bytes,length(CAST(d.session_id AS BLOB)) AS session_id_bytes,
    length(CAST(s.data AS BLOB)) AS session_bytes,length(CAST(w.data AS BLOB)) AS workspace_bytes,
    length(CAST(s.workspace_id AS BLOB)) AS workspace_id_bytes,length(CAST(w.root AS BLOB)) AS root_bytes,
    s.id IS NOT NULL AS has_session,w.id IS NOT NULL AS has_workspace
    FROM session_documents d LEFT JOIN sessions s ON s.id=d.session_id LEFT JOIN workspaces w ON w.id=s.workspace_id
    WHERE d.kind='input_documents' ORDER BY d.session_id LIMIT ?`,
    )
    .all(bounds.maxDocuments);
  cancel(signal);
  const documents: InputDocumentIndexReport["documents"] = [],
    refs: InputDocumentIndexReport["refs"] = [],
    documentIds = new Set<string>(),
    reasons = new Set<string>();
  let invalidDocuments = 0,
    invalidReferences = 0,
    omittedDocuments = totalDocuments - metadata.length,
    omittedReferences: number | null = omittedDocuments ? null : 0,
    sampledJsonBytes = 0;
  if (omittedDocuments) reasons.add("document-limit");
  const omitRefs = (count: number | null) => {
    if (count === null || omittedReferences === null) omittedReferences = null;
    else omittedReferences += count;
  };
  for (const meta of metadata) {
    cancel(signal);
    if (
      !['document_bytes','session_id_bytes','session_bytes','workspace_bytes','workspace_id_bytes','root_bytes'].every(key => Number.isSafeInteger(meta[key]) && Number(meta[key]) >= 0) ||
      !meta.has_session ||
      !meta.has_workspace ||
      Number(meta.session_id_bytes) > 256 ||
      Number(meta.workspace_id_bytes) > 256 ||
      Number(meta.root_bytes) > 4096 ||
      Number(meta.document_bytes) > DOCUMENT_BYTES ||
      Number(meta.session_bytes) > OWNER_BYTES ||
      Number(meta.workspace_bytes) > OWNER_BYTES ||
      !Number.isSafeInteger(meta.revision) ||
      Number(meta.revision) < 1
    ) {
      invalidDocuments++;
      omitRefs(null);
      reasons.add("invalid-or-oversized-owner-document");
      continue;
    }
    const bytes =
      Number(meta.document_bytes) +
      Number(meta.session_bytes) +
      Number(meta.workspace_bytes);
    if (sampledJsonBytes + bytes > bounds.maxJsonBytes) {
      omittedDocuments++;
      omitRefs(null);
      reasons.add("json-byte-limit");
      continue;
    }
    const row = database
      .prepare(
        `SELECT d.session_id,s.workspace_id,w.root,d.data,s.data AS session_data,w.data AS workspace_data
      FROM session_documents d JOIN sessions s ON s.id=d.session_id JOIN workspaces w ON w.id=s.workspace_id
      WHERE d.rowid=? AND d.kind='input_documents'
      AND length(CAST(d.data AS BLOB))=? AND length(CAST(s.data AS BLOB))=? AND length(CAST(w.data AS BLOB))=?
      AND length(CAST(d.session_id AS BLOB))=? AND length(CAST(s.workspace_id AS BLOB))=? AND length(CAST(w.root AS BLOB))=? AND d.revision=?`,
      )
      .get(String(meta.document_id),Number(meta.document_bytes),Number(meta.session_bytes),Number(meta.workspace_bytes),Number(meta.session_id_bytes),Number(meta.workspace_id_bytes),Number(meta.root_bytes),Number(meta.revision));
    sampledJsonBytes += bytes;
    if (!row) {
      invalidDocuments++;
      omitRefs(null);
      reasons.add("missing-owner-document");
      continue;
    }
    let count: number | null = null;
    try {
      const data: unknown = JSON.parse(String(row.data)),
        session: unknown = JSON.parse(String(row.session_data)),
        workspace: unknown = JSON.parse(String(row.workspace_data));
      if (plain(data) && Array.isArray(data.documents))
        count = data.documents.length;
      if (
        !plain(data) ||
        Object.keys(data).length !== 3 ||
        Object.keys(data).some(
          (key) => !["version", "owner", "documents"].includes(key),
        ) ||
        data.version !== 1 ||
        !plain(data.owner) ||
        Object.keys(data.owner).length !== 3 ||
        !Array.isArray(data.documents) ||
        !plain(session) ||
        !plain(workspace) ||
        !id(row.session_id) ||
        !id(row.workspace_id) ||
        !root(row.root) ||
        session.id !== row.session_id ||
        session.workspaceId !== row.workspace_id ||
        workspace.id !== row.workspace_id ||
        workspace.root !== row.root ||
        data.owner.sessionId !== row.session_id ||
        data.owner.workspaceId !== row.workspace_id ||
        data.owner.workspaceRoot !== row.root
      ) {
        throw new EngineError(
          "INVALID_DOCUMENT_INDEX_OWNER",
          "Document index ownership is inconsistent",
        );
      }
      if (data.documents.length > DEFAULT_DOCUMENT_LIMITS.maxSessionDocuments)
        throw new EngineError(
          "INVALID_DOCUMENT_INDEX_COUNT",
          "Document index reference count exceeds its session budget",
        );
      const items: InputDocumentAttachment[] = [],
        ids = new Set<string>();
      let invalid = 0;
      for (const value of data.documents) {
        try {
          const ref = attachment(value);
          if (ids.has(ref.id) || documentIds.has(ref.id))
            throw new EngineError(
              "DUPLICATE_DOCUMENT_INDEX_ID",
              "Document index ID is not unique",
            );
          ids.add(ref.id);
          items.push(ref);
        } catch {
          invalid++;
        }
      }
      invalidReferences += invalid;
      if (
        invalid ||
        items.reduce((total, ref) => total + ref.bytes, 0) >
          DEFAULT_DOCUMENT_LIMITS.maxSessionBytes
      )
        throw new EngineError(
          "INVALID_DOCUMENT_INDEX_REFERENCES",
          "Document index references are inconsistent",
        );
      documents.push({
        sessionId: row.session_id,
        workspaceId: row.workspace_id,
        workspaceRoot: row.root,
        revision: Number(meta.revision),
        referenceCount: items.length,
      });
      for (const ref of items) {
        if (refs.length >= bounds.maxRefs) {
          omitRefs(1);
          reasons.add("reference-limit");
          continue;
        }
        refs.push({
          ...ref,
          sessionId: row.session_id,
          workspaceId: row.workspace_id,
        });
        documentIds.add(ref.id);
      }
    } catch (error) {
      invalidDocuments++;
      omitRefs(count);
      reasons.add(
        error instanceof EngineError
          ? error.code.toLowerCase().replaceAll("_", "-")
          : "corrupt-document-index-json",
      );
    }
  }
  cancel(signal);
  return {
    scope: "primary-database-only",
    observedAt: new Date().toISOString(),
    complete:
      omittedDocuments === 0 &&
      invalidDocuments === 0 &&
      omittedReferences === 0 &&
      invalidReferences === 0,
    totalDocuments,
    sampledDocuments: metadata.length,
    invalidDocuments,
    omittedDocuments,
    invalidReferences,
    omittedReferences,
    sampledJsonBytes,
    documents,
    refs,
    documentIds: [...documentIds],
    declaredBytes: refs.reduce((total, ref) => total + ref.bytes, 0),
    limits: bounds,
    reasons: [...reasons],
    coverage: {
      source: "session_documents.input_documents",
      ownerValidation: "joined-session-workspace-and-stored-payload",
      bytes: "UTF-8 sampled JSON and declared unique reference bytes",
      sql: "bounded metadata/payload rows; document count may scan primary headers",
      childDatabases: "not-read",
      childBlobs: "not-read",
      filesystem: "not-read",
      physicalReadBytes: null,
    },
  };
}
