import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import type {
  ProposalBlobHeader,
  ProposalBlobPage,
  ProposalBlobReadOptions,
  ProposalBlobReference,
  ProposalBlobStoragePort,
} from "./types.js";
import { validateProposalRevision } from "./store.js";

const MAX_FILE = 1_048_576,
  MAX_HEADER = 65_536,
  MAX_REVISION = 262_144,
  MAX_PAGE = 65_536;
function fail(code = "INVALID_PROPOSAL_BLOB"): never {
  throw new EngineError(
    code,
    "Proposal blobs require exact native revision ownership and bounded complete content",
  );
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail();
  return value;
}
function count(value: unknown, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  )
    fail();
  return value as number;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail();
  return value;
}
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const result = immutableKnowledgeJson(value);
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== keys.length ||
    Object.keys(result).some((key) => !keys.includes(key))
  )
    fail();
  return result as Record<string, unknown>;
}
const REFERENCE = [
  "id",
  "workspaceId",
  "proposalId",
  "revisionId",
  "operationIndex",
  "role",
  "sha256",
  "bytes",
  "headerSha256",
] as const;
export function validateProposalBlobReference(
  value: unknown,
): ProposalBlobReference {
  const result = fields(value, REFERENCE);
  for (const key of ["id", "workspaceId", "proposalId", "revisionId"])
    id(result[key]);
  count(result.operationIndex, 127);
  count(result.bytes, MAX_FILE);
  hash(result.sha256);
  hash(result.headerSha256);
  if (result.role !== "before" && result.role !== "after") fail();
  return result as unknown as ProposalBlobReference;
}
export function validateProposalBlobHeader(value: unknown): ProposalBlobHeader {
  const result = fields(value, [...REFERENCE, "createdAt"]);
  const { createdAt, ...reference } = result;
  validateProposalBlobReference(reference);
  if (
    typeof createdAt !== "string" ||
    createdAt.length !== 24 ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  )
    fail();
  const { headerSha256, ...unsigned } = result;
  if (knowledgeHash(unsigned) !== headerSha256)
    fail("PROPOSAL_BLOB_HASH_MISMATCH");
  return result as unknown as ProposalBlobHeader;
}
function reference(header: ProposalBlobHeader): ProposalBlobReference {
  const { createdAt: _stamp, ...result } = header;
  return Object.freeze(result);
}
function content(value: unknown, expected: ProposalBlobReference): Buffer {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== expected.bytes ||
    value.byteLength > MAX_FILE
  )
    fail("PROPOSAL_BLOB_HASH_MISMATCH");
  const buffer = Buffer.from(value);
  if (
    createHash("sha256").update(buffer).digest("hex") !== expected.sha256 ||
    !Buffer.from(buffer.toString("utf8")).equals(buffer) ||
    buffer.includes(0)
  )
    fail("PROPOSAL_BLOB_HASH_MISMATCH");
  return buffer;
}
function rowHeader(
  db: DatabaseSync,
  workspaceId: string,
  blobId: string,
): ProposalBlobHeader | undefined {
  const row = db
    .prepare(
      "SELECT id,workspace_id,proposal_id,revision_id,operation_index,role,sha256,bytes,header_sha256,length(CAST(data AS BLOB)) AS data_bytes,length(content) AS content_bytes FROM proposal_blobs WHERE workspace_id=? AND id=?",
    )
    .get(workspaceId, blobId);
  if (!row) return undefined;
  const dataBytes = count(row.data_bytes, MAX_HEADER),
    bodyBytes = count(row.content_bytes, MAX_FILE);
  if (dataBytes < 1 || bodyBytes !== count(row.bytes, MAX_FILE)) fail();
  const body = db
    .prepare(
      "SELECT data FROM proposal_blobs WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))=? AND length(content)=?",
    )
    .get(workspaceId, blobId, dataBytes, bodyBytes);
  if (
    typeof body?.data !== "string" ||
    Buffer.byteLength(body.data) !== dataBytes
  )
    fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.data);
  } catch {
    fail();
  }
  const header = validateProposalBlobHeader(parsed);
  if (
    header.id !== row.id ||
    header.workspaceId !== row.workspace_id ||
    header.proposalId !== row.proposal_id ||
    header.revisionId !== row.revision_id ||
    header.operationIndex !== row.operation_index ||
    header.role !== row.role ||
    header.sha256 !== row.sha256 ||
    header.bytes !== row.bytes ||
    header.headerSha256 !== row.header_sha256
  )
    fail("PROPOSAL_BLOB_SCOPE_MISMATCH");
  return header;
}
function assertRevisionOwner(
  db: DatabaseSync,
  ref: ProposalBlobReference,
): void {
  const row = db
    .prepare(
      "SELECT id,workspace_id,proposal_id,revision,request_id,request_sha256,previous_id,length(CAST(data AS BLOB)) AS data_bytes FROM proposal_revisions WHERE workspace_id=? AND id=?",
    )
    .get(ref.workspaceId, ref.revisionId);
  if (!row || count(row.data_bytes, MAX_REVISION) < 1)
    fail("PROPOSAL_BLOB_OWNER_MISSING");
  const raw = db
    .prepare(
      "SELECT data FROM proposal_revisions WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))=?",
    )
    .get(ref.workspaceId, ref.revisionId, row.data_bytes!);
  if (
    typeof raw?.data !== "string" ||
    Buffer.byteLength(raw.data) !== row.data_bytes
  )
    fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    fail();
  }
  const revision = validateProposalRevision(parsed);
  if (
    row.id !== revision.id ||
    row.workspace_id !== revision.workspaceId ||
    row.proposal_id !== revision.proposalId ||
    row.revision !== revision.revision ||
    row.request_id !== revision.requestId ||
    row.request_sha256 !== revision.requestInputSha256 ||
    row.previous_id !== revision.previousId ||
    revision.proposalId !== ref.proposalId
  )
    fail("PROPOSAL_BLOB_SCOPE_MISMATCH");
  const file = revision.files[ref.operationIndex];
  if (!file || knowledgeHash(file[ref.role]) !== knowledgeHash(ref))
    fail("PROPOSAL_BLOB_OWNER_MISSING");
}

/** Actual primary SQL blobs, independently owned by native ProposalRevision rows. */
export class ProposalBlobStorage implements ProposalBlobStoragePort {
  constructor(readonly db: DatabaseSync) {}
  private transaction(): void {
    if (!this.db.isTransaction) fail("PROPOSAL_TRANSACTION_REQUIRED");
  }
  put(input: ProposalBlobHeader, body: string): void {
    const header = validateProposalBlobHeader(input);
    if (
      typeof body !== "string" ||
      Buffer.byteLength(body) > MAX_FILE ||
      Buffer.from(body).toString("utf8") !== body ||
      body.includes("\0")
    )
      fail();
    const raw = content(Buffer.from(body), header);
    this.transaction();
    assertRevisionOwner(this.db, reference(header));
    const existing = rowHeader(this.db, header.workspaceId, header.id);
    if (existing) {
      if (
        knowledgeHash(existing) !== knowledgeHash(header) ||
        !this.readContent(header).equals(raw)
      )
        fail("PROPOSAL_BLOB_CONFLICT");
      return;
    }
    this.db
      .prepare(
        "INSERT INTO proposal_blobs(id,workspace_id,proposal_id,revision_id,operation_index,role,sha256,bytes,header_sha256,data,content) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        header.id,
        header.workspaceId,
        header.proposalId,
        header.revisionId,
        header.operationIndex,
        header.role,
        header.sha256,
        header.bytes,
        header.headerSha256,
        JSON.stringify(header),
        raw,
      );
  }
  get(workspaceId: string, blobId: string): ProposalBlobHeader | undefined {
    id(workspaceId);
    id(blobId);
    this.transaction();
    const header = rowHeader(this.db, workspaceId, blobId);
    if (header) assertRevisionOwner(this.db, reference(header));
    return header;
  }
  private readContent(ref: ProposalBlobReference): Buffer {
    const header = rowHeader(this.db, ref.workspaceId, ref.id);
    if (!header || knowledgeHash(reference(header)) !== knowledgeHash(ref))
      fail("PROPOSAL_BLOB_SCOPE_MISMATCH");
    assertRevisionOwner(this.db, ref);
    const row = this.db
      .prepare(
        "SELECT content FROM proposal_blobs WHERE workspace_id=? AND id=? AND length(content)=?",
      )
      .get(ref.workspaceId, ref.id, ref.bytes);
    return content(row?.content, ref);
  }
  read(
    input: ProposalBlobReference,
    options: ProposalBlobReadOptions = {},
  ): ProposalBlobPage {
    const ref = validateProposalBlobReference(input);
    if (
      !options ||
      typeof options !== "object" ||
      types.isProxy(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    )
      fail();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== "string" ||
          !["offset", "limit"].includes(key) ||
          !descriptors[key]!.enumerable ||
          !Object.hasOwn(descriptors[key]!, "value"),
      )
    )
      fail();
    const offset = count(options.offset ?? 0, ref.bytes),
      limit = count(options.limit ?? MAX_PAGE, MAX_PAGE);
    if (!limit) fail();
    this.transaction();
    const full = this.readContent(ref),
      end = Math.min(full.length, offset + limit);
    return Object.freeze({
      reference: ref,
      bytes: Uint8Array.from(full.subarray(offset, end)),
      offset,
      nextOffset: end < full.length ? end : null,
    });
  }
  /** Loads the whole bounded blob text; callers bound which blobs they load (overlay context slot, approved apply preview). */
  readText(input: ProposalBlobReference): string {
    const ref = validateProposalBlobReference(input);
    this.transaction();
    return this.readContent(ref).toString("utf8");
  }
}
