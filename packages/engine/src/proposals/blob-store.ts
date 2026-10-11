import type { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import { parseJsonOr, plainRecord, recordGuards } from "../shared/data.js";
import type {
  ProposalBlobHeader,
  ProposalBlobPage,
  ProposalBlobReadOptions,
  ProposalBlobReference,
  ProposalBlobStoragePort,
  ProposalRevision,
} from "./types.js";
import {
  proposalBlobContent,
  readProposalBlobContent,
  readProposalBlobRow,
  validateProposalBlobHeader,
  validateProposalBlobReference,
  validateProposalRevision,
  type ProposalBlobChecks,
} from "./store.js";

const MAX_FILE = 1_048_576,
  MAX_REVISION = 262_144,
  MAX_PAGE = 65_536;
function fail(code = "INVALID_PROPOSAL_BLOB"): never {
  throw new EngineError(
    code,
    "Proposal blobs require exact native revision ownership and bounded complete content",
  );
}
function hashMismatch(): never {
  return fail("PROPOSAL_BLOB_HASH_MISMATCH");
}
const checks: ProposalBlobChecks = Object.freeze({
  ...recordGuards({ json: immutableKnowledgeJson, fail: () => fail() }),
  fail,
  decoded: (data: unknown) => parseJsonOr(String(data), () => fail()),
  hashCode: "PROPOSAL_BLOB_HASH_MISMATCH",
  scopeCode: "PROPOSAL_BLOB_SCOPE_MISMATCH",
});
const { id, integer: count } = checks;
function reference(header: ProposalBlobHeader): ProposalBlobReference {
  const { createdAt: _stamp, ...result } = header;
  return Object.freeze(result);
}

/** Actual primary SQL blobs, independently owned by native ProposalRevision rows. */
export class ProposalBlobStorage implements ProposalBlobStoragePort {
  #validatedOwner?: {
    readonly workspaceId: string;
    readonly revisionId: string;
    readonly data: string;
    readonly revision: ProposalRevision;
  };
  constructor(readonly db: DatabaseSync) {}
  private transaction(): void {
    if (!this.db.isTransaction) fail("PROPOSAL_TRANSACTION_REQUIRED");
  }
  /** Revalidates the owning revision unless its row text is the one validated last. */
  private assertRevisionOwner(ref: ProposalBlobReference): void {
    const row = this.db
      .prepare(
        "SELECT id,workspace_id,proposal_id,revision,request_id,request_sha256,previous_id,length(CAST(data AS BLOB)) AS data_bytes FROM proposal_revisions WHERE workspace_id=? AND id=?",
      )
      .get(ref.workspaceId, ref.revisionId);
    if (!row || count(row.data_bytes, MAX_REVISION) < 1)
      fail("PROPOSAL_BLOB_OWNER_MISSING");
    const raw = this.db
      .prepare(
        "SELECT data FROM proposal_revisions WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(ref.workspaceId, ref.revisionId, row.data_bytes!);
    if (
      typeof raw?.data !== "string" ||
      Buffer.byteLength(raw.data) !== row.data_bytes
    )
      fail();
    const last = this.#validatedOwner,
      revision =
        last?.workspaceId === ref.workspaceId &&
        last.revisionId === ref.revisionId &&
        last.data === raw.data
          ? last.revision
          : validateProposalRevision(parseJsonOr(raw.data, () => fail()));
    this.#validatedOwner = {
      workspaceId: ref.workspaceId,
      revisionId: ref.revisionId,
      data: raw.data,
      revision,
    };
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
  put(input: ProposalBlobHeader, body: string): void {
    const header = validateProposalBlobHeader(input, checks);
    if (
      typeof body !== "string" ||
      Buffer.byteLength(body) > MAX_FILE ||
      Buffer.from(body).toString("utf8") !== body ||
      body.includes("\0")
    )
      fail();
    const raw = proposalBlobContent(Buffer.from(body), header, hashMismatch);
    this.transaction();
    this.assertRevisionOwner(reference(header));
    const existing = readProposalBlobRow(
      this.db,
      header.workspaceId,
      header.id,
      checks,
    );
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
    const header = readProposalBlobRow(this.db, workspaceId, blobId, checks);
    if (header) this.assertRevisionOwner(reference(header));
    return header;
  }
  private readContent(ref: ProposalBlobReference): Buffer {
    const header = readProposalBlobRow(
      this.db,
      ref.workspaceId,
      ref.id,
      checks,
    );
    if (!header || knowledgeHash(reference(header)) !== knowledgeHash(ref))
      fail("PROPOSAL_BLOB_SCOPE_MISMATCH");
    this.assertRevisionOwner(ref);
    return readProposalBlobContent(this.db, ref, hashMismatch);
  }
  read(
    input: ProposalBlobReference,
    options: ProposalBlobReadOptions = {},
  ): ProposalBlobPage {
    const ref = validateProposalBlobReference(
      immutableKnowledgeJson(input),
      checks,
    );
    plainRecord(options, [], ["offset", "limit"], () => fail());
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
    const ref = validateProposalBlobReference(
      immutableKnowledgeJson(input),
      checks,
    );
    this.transaction();
    return this.readContent(ref).toString("utf8");
  }
}
