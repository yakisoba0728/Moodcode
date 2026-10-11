import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash, validateBinding } from "../knowledge/validation.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { sha256Hex } from "../shared/canonical.js";
import { casReplace, guardedWrite } from "../storage/transaction.js";
import { workspaceWritePath } from "../workspace/index.js";
import { assertNotThenable, proposalChecks } from "./validation.js";
import type {
  PreparedProposalSourceSnapshot,
  ProposalSourceManifest,
  ProposalSourceOperation,
} from "./source-capture.js";
import type {
  AppendProposalRevisionResult,
  BeginProposalCaptureResult,
  PreparedProposalCapture,
  ProposalBlobHeader,
  ProposalBlobReference,
  ProposalCaptureInput,
  ProposalListOptions,
  ProposalPage,
  ProposalRevision,
  ProposalSelection,
  ProposalSet,
  ProposalStoragePorts,
  ProposalTable,
} from "./types.js";

export const PROPOSAL_LIMITS = Object.freeze({
  files: 128,
  fileBytes: 1_048_576,
  totalBytes: 8_388_608,
  revisionBytes: 262_144,
  headerBytes: 65_536,
  pageRows: 64,
  pageBytes: 65_536,
  handles: 128,
});
export const PROPOSAL_TABLES: readonly ProposalTable[] = Object.freeze([
  "proposal_revisions",
  "proposal_heads",
  "proposal_blobs",
]);
export const PROPOSAL_SCHEMA_SQL = `
CREATE TABLE proposal_revisions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), proposal_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1), previous_id TEXT REFERENCES proposal_revisions(id),
 request_id TEXT NOT NULL, request_sha256 TEXT NOT NULL,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=262144),
 UNIQUE(workspace_id,proposal_id,revision), UNIQUE(workspace_id,request_id), UNIQUE(workspace_id,id)
) STRICT;
CREATE TABLE proposal_heads (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), revision INTEGER NOT NULL CHECK(revision>=1),
 revision_id TEXT NOT NULL, data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),
 FOREIGN KEY(workspace_id,revision_id) REFERENCES proposal_revisions(workspace_id,id), UNIQUE(workspace_id,id)
) STRICT;
CREATE TABLE proposal_blobs (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), proposal_id TEXT NOT NULL,
 revision_id TEXT NOT NULL, operation_index INTEGER NOT NULL CHECK(operation_index>=0 AND operation_index<128),
 role TEXT NOT NULL CHECK(role IN ('before','after')), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=1048576),
 header_sha256 TEXT NOT NULL, data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),
 content BLOB NOT NULL CHECK(length(content)=bytes),
 FOREIGN KEY(workspace_id,revision_id) REFERENCES proposal_revisions(workspace_id,id), UNIQUE(revision_id,operation_index,role)
) STRICT;
CREATE INDEX proposal_workspace_heads ON proposal_heads(workspace_id,id);
CREATE INDEX proposal_revision_history ON proposal_revisions(workspace_id,proposal_id,revision);
CREATE INDEX proposal_blob_owner ON proposal_blobs(workspace_id,revision_id,operation_index,role);
`;

function fail(
  code = "INVALID_PROPOSAL",
  message = "Proposal requires bounded exact native ownership",
): never {
  throw new EngineError(code, message);
}
function transactionRequired(): never {
  return fail("PROPOSAL_TRANSACTION_REQUIRED");
}
const {
  id,
  integer: number,
  sha: hash,
  stamp,
  exact,
  json,
  seal: signed,
  verify: checkHash,
  decoded,
} = proposalChecks({
  fail,
  limitCode: "PROPOSAL_LIMIT",
  hashCode: "PROPOSAL_HASH_MISMATCH",
  rowCode: "INVALID_PROPOSAL_ROW",
  maxBytes: PROPOSAL_LIMITS.revisionBytes,
  maxNodes: 40_000,
  maxDepth: 20,
  maxItems: 256,
});
function relative(value: unknown): string {
  workspaceWritePath(
    value,
    "INVALID_PROPOSAL_PATH",
    "Proposal paths must be bounded workspace-relative paths outside Git metadata and dependencies",
  );
  return value as string;
}
function content(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > PROPOSAL_LIMITS.fileBytes ||
    Buffer.from(value).toString("utf8") !== value ||
    value.includes("\0")
  )
    fail("PROPOSAL_LIMIT");
  return value;
}
/** The normalized request digest is safe to compute before any physical source capture. */
export function normalizeProposalCaptureInput(
  input: unknown,
): ProposalCaptureInput {
  const r = exact(
    json(input, PROPOSAL_LIMITS.totalBytes * 6 + PROPOSAL_LIMITS.revisionBytes),
    ["workspaceId", "requestId", "expectedHeadRevision", "operations"],
    ["proposalId"],
  );
  id(r.workspaceId);
  id(r.requestId);
  number(r.expectedHeadRevision);
  if (r.proposalId !== undefined) id(r.proposalId);
  if (
    !Array.isArray(r.operations) ||
    !r.operations.length ||
    r.operations.length > PROPOSAL_LIMITS.files
  )
    fail("PROPOSAL_LIMIT");
  const paths: string[] = [];
  let bytes = 0;
  for (const raw of r.operations) {
    const op = exact(raw, ["path", "expectedSha256", "after"]);
    const path = relative(op.path);
    if (op.expectedSha256 !== null) hash(op.expectedSha256);
    const after = content(op.after);
    if (op.expectedSha256 === null && after === null) fail();
    if (
      paths.some(
        (p) =>
          p === path.toLowerCase() ||
          p.startsWith(path.toLowerCase() + "/") ||
          path.toLowerCase().startsWith(p + "/"),
      )
    )
      fail("PROPOSAL_PATH_CONFLICT");
    paths.push(path.toLowerCase());
    bytes += after === null ? 0 : Buffer.byteLength(after);
  }
  if (bytes > PROPOSAL_LIMITS.totalBytes) fail("PROPOSAL_LIMIT");
  if (r.proposalId === undefined && r.expectedHeadRevision !== 0)
    fail("PROPOSAL_STALE");
  return r as unknown as ProposalCaptureInput;
}
export function proposalRequestFingerprint(input: unknown): string {
  const r = normalizeProposalCaptureInput(input);
  return knowledgeHash({
    workspaceId: r.workspaceId,
    requestId: r.requestId,
    proposalId: r.proposalId ?? null,
    expectedHeadRevision: r.expectedHeadRevision,
    operations: r.operations,
  });
}

function physical(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,32}$/u.test(value)) fail();
  return value;
}
function pin(value: unknown): void {
  const r = exact(value, [
    "path",
    "device",
    "inode",
    "mode",
    "mtimeNs",
    "ctimeNs",
  ]);
  if (r.path !== ".") relative(r.path);
  physical(r.device);
  physical(r.inode);
  physical(r.mtimeNs);
  physical(r.ctimeNs);
  number(r.mode, 0o777);
}
/** The manifest hashes physical metadata and before/after digests, never raw bodies. */
export function validateProposalSourceManifest(
  value: unknown,
  binding: KnowledgeHostBinding,
): ProposalSourceManifest {
  const r = exact(json(value), [
    "projection",
    "rootPin",
    "files",
    "fileCount",
    "totalBytes",
    "sha256",
  ]);
  if (
    r.projection !== "proposal-selected-files-v1" ||
    !Array.isArray(r.files) ||
    !r.files.length ||
    r.files.length > PROPOSAL_LIMITS.files
  )
    fail();
  pin(r.rootPin);
  if ((r.rootPin as Record<string, unknown>).path !== ".") fail();
  number(r.fileCount, PROPOSAL_LIMITS.files);
  number(r.totalBytes, PROPOSAL_LIMITS.totalBytes);
  const root = r.rootPin as Record<string, unknown>;
  if (root.device !== binding.rootDevice || root.inode !== binding.rootInode)
    fail("PROPOSAL_SCOPE_MISMATCH");
  const paths: string[] = [];
  let bytes = 0;
  for (const raw of r.files) {
    const f = exact(raw, [
      "path",
      "beforeSha256",
      "beforeBytes",
      "afterSha256",
      "afterBytes",
      "device",
      "inode",
      "mode",
      "mtimeNs",
      "ctimeNs",
      "parentPins",
      "missingParents",
    ]);
    const selected = relative(f.path);
    if (
      paths.some(
        (p) =>
          p === selected.toLowerCase() ||
          p.startsWith(selected.toLowerCase() + "/") ||
          selected.toLowerCase().startsWith(p + "/"),
      )
    )
      fail("PROPOSAL_PATH_CONFLICT");
    paths.push(selected.toLowerCase());
    for (const key of ["beforeSha256", "afterSha256"])
      if (f[key] !== null) hash(f[key]);
    number(f.beforeBytes, PROPOSAL_LIMITS.fileBytes);
    number(f.afterBytes, PROPOSAL_LIMITS.fileBytes);
    if (f.beforeSha256 === null) {
      if (
        f.beforeBytes !== 0 ||
        ["device", "inode", "mode", "mtimeNs", "ctimeNs"].some(
          (k) => f[k] !== null,
        )
      )
        fail();
    } else {
      physical(f.device);
      physical(f.inode);
      physical(f.mtimeNs);
      physical(f.ctimeNs);
      number(f.mode, 0o777);
    }
    if (
      (f.afterSha256 === null && f.afterBytes !== 0) ||
      (f.beforeSha256 === null && f.afterSha256 === null)
    )
      fail();
    if (
      !Array.isArray(f.parentPins) ||
      !f.parentPins.length ||
      f.parentPins.length > 64 ||
      !Array.isArray(f.missingParents) ||
      f.missingParents.length > 64
    )
      fail("PROPOSAL_LIMIT");
    const ancestors = selected
      .split("/")
      .slice(0, -1)
      .map((_, i) =>
        selected
          .split("/")
          .slice(0, i + 1)
          .join("/"),
      );
    const expected = [".", ...ancestors];
    const seen: string[] = [];
    for (const p of f.parentPins) {
      pin(p);
      seen.push((p as Record<string, unknown>).path as string);
    }
    for (const p of f.missingParents) seen.push(relative(p));
    if (
      seen.length !== expected.length ||
      seen.some((p, i) => p !== expected[i]) ||
      knowledgeHash(f.parentPins[0]) !== knowledgeHash(root)
    )
      fail();
    bytes += (f.beforeBytes as number) + (f.afterBytes as number);
  }
  if (bytes !== r.totalBytes || r.files.length !== r.fileCount)
    fail("PROPOSAL_HASH_MISMATCH");
  const { sha256: expected, ...manifest } = r;
  if (
    hash(expected) !==
    knowledgeHash({ binding: validateBinding(binding), ...manifest })
  )
    fail("PROPOSAL_HASH_MISMATCH");
  return r as unknown as ProposalSourceManifest;
}
export function validateProposalBlobHeader(value: unknown): ProposalBlobHeader {
  const r = exact(json(value, PROPOSAL_LIMITS.headerBytes), [
    "id",
    "workspaceId",
    "proposalId",
    "revisionId",
    "operationIndex",
    "role",
    "sha256",
    "bytes",
    "headerSha256",
    "createdAt",
  ]);
  for (const key of ["id", "workspaceId", "proposalId", "revisionId"])
    id(r[key]);
  number(r.operationIndex, PROPOSAL_LIMITS.files - 1);
  if (r.role !== "before" && r.role !== "after") fail();
  hash(r.sha256);
  number(r.bytes, PROPOSAL_LIMITS.fileBytes);
  stamp(r.createdAt);
  const { headerSha256: expected, ...body } = r;
  if (hash(expected) !== knowledgeHash(body)) fail("PROPOSAL_HASH_MISMATCH");
  return r as unknown as ProposalBlobHeader;
}
function reference(value: unknown): ProposalBlobReference {
  const r = exact(value, [
    "id",
    "workspaceId",
    "proposalId",
    "revisionId",
    "operationIndex",
    "role",
    "sha256",
    "bytes",
    "headerSha256",
  ]);
  for (const key of ["id", "workspaceId", "proposalId", "revisionId"])
    id(r[key]);
  number(r.operationIndex, PROPOSAL_LIMITS.files - 1);
  if (r.role !== "before" && r.role !== "after") fail();
  hash(r.sha256);
  hash(r.headerSha256);
  number(r.bytes, PROPOSAL_LIMITS.fileBytes);
  return r as unknown as ProposalBlobReference;
}
export function validateProposalRevision(value: unknown): ProposalRevision {
  const r = exact(json(value), [
    "schemaVersion",
    "id",
    "workspaceId",
    "proposalId",
    "revision",
    "previousId",
    "requestId",
    "requestInputSha256",
    "requestedProposalId",
    "expectedHeadRevision",
    "binding",
    "sourceManifest",
    "sourceManifestSha256",
    "files",
    "totalBytes",
    "createdAt",
    "sha256",
  ]);
  if (r.schemaVersion !== 1) fail();
  for (const key of ["id", "workspaceId", "proposalId", "requestId"])
    id(r[key]);
  number(r.revision);
  number(r.expectedHeadRevision);
  if (
    (r.revision as number) < 1 ||
    (r.revision === 1) !== (r.previousId === null)
  )
    fail();
  if (r.previousId !== null) id(r.previousId);
  const binding = validateBinding(r.binding);
  if (binding.workspaceId !== r.workspaceId) fail("PROPOSAL_SCOPE_MISMATCH");
  hash(r.requestInputSha256);
  if (
    r.requestedProposalId !== null &&
    id(r.requestedProposalId) !== r.proposalId
  )
    fail("PROPOSAL_SCOPE_MISMATCH");
  if (r.revision !== 1 && r.requestedProposalId === null)
    fail("PROPOSAL_SCOPE_MISMATCH");
  stamp(r.createdAt);
  number(r.totalBytes, PROPOSAL_LIMITS.totalBytes);
  const manifest = validateProposalSourceManifest(r.sourceManifest, binding);
  if (
    manifest.sha256 !== hash(r.sourceManifestSha256) ||
    manifest.totalBytes !== r.totalBytes ||
    !Array.isArray(r.files) ||
    r.files.length !== manifest.fileCount
  )
    fail("PROPOSAL_HASH_MISMATCH");
  const blobIds = new Set<string>();
  for (const [i, raw] of r.files.entries()) {
    const f = exact(raw, ["path", "operation", "before", "after"]);
    const source = manifest.files[i]!;
    if (
      relative(f.path) !== source.path ||
      (f.before === null && f.after === null)
    )
      fail();
    if (
      f.operation !==
      (f.before === null ? "create" : f.after === null ? "delete" : "update")
    )
      fail();
    for (const role of ["before", "after"] as const) {
      const blob = f[role],
        sha = source[role === "before" ? "beforeSha256" : "afterSha256"],
        bytes = source[role === "before" ? "beforeBytes" : "afterBytes"];
      if (blob === null) {
        if (sha !== null || bytes !== 0) fail();
        continue;
      }
      const ref = reference(blob);
      if (
        ref.workspaceId !== r.workspaceId ||
        ref.proposalId !== r.proposalId ||
        ref.revisionId !== r.id ||
        ref.operationIndex !== i ||
        ref.role !== role ||
        ref.sha256 !== sha ||
        ref.bytes !== bytes ||
        blobIds.has(ref.id)
      )
        fail("PROPOSAL_SCOPE_MISMATCH");
      blobIds.add(ref.id);
    }
  }
  checkHash(r);
  return r as unknown as ProposalRevision;
}
export function validateProposalSet(value: unknown): ProposalSet {
  const r = exact(
    json(value, PROPOSAL_LIMITS.headerBytes),
    [
      "schemaVersion",
      "id",
      "workspaceId",
      "revisionId",
      "revisionSha256",
      "headRevision",
      "status",
      "archiveSha256",
      "updatedAt",
      "sha256",
    ],
    ["applySettlement"],
  );
  if (r.schemaVersion !== 1) fail();
  for (const key of ["id", "workspaceId", "revisionId"]) id(r[key]);
  if (number(r.headRevision) < 1) fail();
  hash(r.revisionSha256);
  stamp(r.updatedAt);
  if (
    ![
      "pending",
      "cancelled",
      "paused-import",
      "applied",
      "partial",
      "uncertain",
    ].includes(r.status as string) ||
    (r.status === "paused-import") !== (r.archiveSha256 !== null)
  )
    fail();
  if (r.archiveSha256 !== null) hash(r.archiveSha256);
  const terminal = ["applied", "partial", "uncertain"].includes(
    r.status as string,
  );
  if (
    (terminal !== Object.hasOwn(r, "applySettlement") &&
      r.status !== "paused-import") ||
    (Object.hasOwn(r, "applySettlement") &&
      ["pending", "cancelled"].includes(r.status as string))
  )
    fail();
  if (Object.hasOwn(r, "applySettlement")) {
    const p = exact(r.applySettlement, [
      "ownerId",
      "ownerSha256",
      "checkpointId",
      "checkpointSha256",
      "receiptId",
      "state",
      "cleanupConfirmed",
    ]);
    id(p.ownerId);
    hash(p.ownerSha256);
    hash(p.checkpointSha256);
    if (
      id(p.checkpointId) !== p.ownerId ||
      id(p.receiptId) !== p.ownerId ||
      !["completed", "partial", "uncertain"].includes(p.state as string) ||
      typeof p.cleanupConfirmed !== "boolean" ||
      (p.state !== "uncertain" && p.cleanupConfirmed !== true) ||
      (terminal && r.status !== (p.state === "completed" ? "applied" : p.state))
    )
      fail();
  }
  checkHash(r);
  return r as unknown as ProposalSet;
}

function load(
  db: DatabaseSync,
  table: "proposal_heads" | "proposal_revisions",
  ws: string,
  key: string,
  mismatch: () => never = () => fail("PROPOSAL_SCOPE_MISMATCH"),
): Record<string, unknown> | undefined {
  const columns =
    table === "proposal_heads"
      ? "id,workspace_id,revision,revision_id"
      : "id,workspace_id,proposal_id,revision,previous_id,request_id,request_sha256";
  const metadata = db
    .prepare(
      `SELECT ${columns},length(CAST(data AS BLOB)) AS data_bytes FROM ${table} WHERE workspace_id=? AND id=?`,
    )
    .get(ws, key) as Record<string, unknown> | undefined;
  if (!metadata) return undefined;
  const maximum =
    table === "proposal_heads"
      ? PROPOSAL_LIMITS.headerBytes
      : PROPOSAL_LIMITS.revisionBytes;
  number(metadata.data_bytes, maximum);
  const stored = db
    .prepare(
      `SELECT data FROM ${table} WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))<=?`,
    )
    .get(ws, key, maximum) as { data: string } | undefined;
  if (!stored) fail("PROPOSAL_STALE");
  const data =
    table === "proposal_heads"
      ? validateProposalSet(decoded(stored.data, maximum))
      : validateProposalRevision(decoded(stored.data, maximum));
  if (
    data.id !== metadata.id ||
    data.workspaceId !== metadata.workspace_id ||
    ("headRevision" in data ? data.headRevision : data.revision) !==
      metadata.revision
  )
    mismatch();
  if ("headRevision" in data) {
    if (data.revisionId !== metadata.revision_id) mismatch();
  } else if (
    data.proposalId !== metadata.proposal_id ||
    data.previousId !== metadata.previous_id ||
    data.requestId !== metadata.request_id ||
    data.requestInputSha256 !== metadata.request_sha256
  )
    mismatch();
  return data as unknown as Record<string, unknown>;
}
/** The bounded current head whose columns match its body; mismatch replaces the scope error. */
export function readProposalHead(
  db: DatabaseSync,
  ws: string,
  key: string,
  mismatch?: () => never,
): ProposalSet | undefined {
  return load(db, "proposal_heads", ws, key, mismatch) as unknown as
    ProposalSet | undefined;
}
/** Replaces the head only while its row still holds exactly previous. */
export function advanceProposalHead(
  db: DatabaseSync,
  previous: ProposalSet,
  next: ProposalSet,
  stale: () => never,
): void {
  casReplace(
    db,
    {
      table: "proposal_heads",
      key: { workspace_id: previous.workspaceId, id: previous.id },
      set: { revision: next.headRevision, revision_id: next.revisionId },
      fence: { revision: previous.headRevision },
      previous,
    },
    next,
    stale,
  );
}
function revisionAt(
  db: DatabaseSync,
  ws: string,
  key: string,
): ProposalRevision | undefined {
  return load(db, "proposal_revisions", ws, key) as unknown as
    ProposalRevision | undefined;
}
interface Owned {
  readonly input: ProposalCaptureInput;
  readonly before: ProposalSet | undefined;
}
export class ProposalStorage {
  readonly #owned = new WeakMap<object, Owned>();
  readonly #live = new Set<PreparedProposalCapture>();
  constructor(
    readonly db: DatabaseSync,
    readonly ports: ProposalStoragePorts,
  ) {}
  #tx<T>(operation: () => T): T {
    return guardedWrite(this.db, this.ports, operation, {
      join: false,
      innerAsyncCheck: true,
      required: transactionRequired,
    });
  }
  #binding(ws: string): KnowledgeHostBinding {
    const workspace = this.ports.getWorkspace(ws),
      binding = validateBinding(this.ports.checkBinding(ws));
    if (
      !workspace ||
      workspace.id !== ws ||
      binding.workspaceId !== ws ||
      workspace.root !== binding.root
    )
      fail("PROPOSAL_SCOPE_MISMATCH");
    return binding;
  }
  #time(): string {
    const now = this.ports.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
      fail();
    return new Date(now).toISOString();
  }
  findRequest(input: ProposalCaptureInput): ProposalSelection | undefined {
    const normalized = normalizeProposalCaptureInput(input),
      fingerprint = proposalRequestFingerprint(normalized);
    const key = this.db
      .prepare(
        "SELECT id FROM proposal_revisions WHERE workspace_id=? AND request_id=?",
      )
      .get(normalized.workspaceId, normalized.requestId) as
      { id: string } | undefined;
    if (!key) return undefined;
    const revision = this.getRevision(normalized.workspaceId, key.id)!;
    if (revision.requestInputSha256 !== fingerprint)
      fail("PROPOSAL_REQUEST_CONFLICT");
    const set = this.getSet(normalized.workspaceId, revision.proposalId);
    if (!set) fail("PROPOSAL_SCOPE_MISMATCH");
    return Object.freeze({ set, revision });
  }
  beginCapture(input: ProposalCaptureInput): BeginProposalCaptureResult {
    const normalized = normalizeProposalCaptureInput(input),
      duplicate = this.findRequest(normalized);
    if (duplicate) return Object.freeze({ kind: "duplicate", ...duplicate });
    if (this.#live.size >= PROPOSAL_LIMITS.handles)
      fail("PROPOSAL_CAPTURE_LIMIT");
    const before = normalized.proposalId
      ? this.getSet(normalized.workspaceId, normalized.proposalId)
      : undefined;
    if (
      (before?.status !== "pending" && before !== undefined) ||
      normalized.expectedHeadRevision !== (before?.headRevision ?? 0)
    )
      fail(
        before?.status === "paused-import"
          ? "PROPOSAL_IMPORTED_PAUSED"
          : "PROPOSAL_STALE",
      );
    if (normalized.proposalId) {
      const global = this.db
        .prepare("SELECT workspace_id FROM proposal_heads WHERE id=?")
        .get(normalized.proposalId) as { workspace_id: string } | undefined;
      if (global && global.workspace_id !== normalized.workspaceId)
        fail("PROPOSAL_SCOPE_MISMATCH");
    }
    const binding = this.#binding(normalized.workspaceId);
    const capture = json(
      {
        workspaceId: normalized.workspaceId,
        requestId: normalized.requestId,
        proposalId: normalized.proposalId ?? randomUUID(),
        revisionId: randomUUID(),
        expectedHeadRevision: normalized.expectedHeadRevision,
        binding,
        requestInputSha256: proposalRequestFingerprint(normalized),
      },
      PROPOSAL_LIMITS.headerBytes,
    ) as PreparedProposalCapture;
    this.#owned.set(capture, { input: normalized, before });
    this.#live.add(capture);
    return Object.freeze({ kind: "created", capture });
  }
  appendRevision(
    capture: PreparedProposalCapture,
    source: object,
  ): AppendProposalRevisionResult {
    const owned = this.#owned.get(capture);
    if (!owned || !this.#live.has(capture)) fail("PROPOSAL_CAPTURE_REQUIRED");
    const duplicate = this.findRequest(owned.input);
    if (duplicate) return Object.freeze({ kind: "duplicate", ...duplicate });
    const snapshot = json(
      this.ports.readSourceCapture(source),
      PROPOSAL_LIMITS.totalBytes * 6 + PROPOSAL_LIMITS.revisionBytes,
    ) as PreparedProposalSourceSnapshot;
    const data = exact(snapshot, [
      "schemaVersion",
      "binding",
      "manifest",
      "operations",
    ]);
    if (
      data.schemaVersion !== 1 ||
      knowledgeHash(validateBinding(data.binding)) !==
        knowledgeHash(capture.binding)
    )
      fail("PROPOSAL_SCOPE_MISMATCH");
    const manifest = validateProposalSourceManifest(
      data.manifest,
      capture.binding,
    );
    if (
      !Array.isArray(data.operations) ||
      data.operations.length !== owned.input.operations.length ||
      manifest.fileCount !== data.operations.length
    )
      fail("PROPOSAL_SCOPE_MISMATCH");
    for (const [i, raw] of data.operations.entries()) {
      const op = exact(raw, ["path", "before", "after"]),
        wanted = owned.input.operations[i]!,
        pin = manifest.files[i]!;
      const before = content(op.before),
        after = content(op.after);
      if (
        op.path !== wanted.path ||
        pin.path !== wanted.path ||
        after !== wanted.after ||
        pin.beforeSha256 !== wanted.expectedSha256 ||
        pin.beforeSha256 !== (before === null ? null : sha256Hex(before)) ||
        pin.afterSha256 !== (after === null ? null : sha256Hex(after)) ||
        pin.beforeBytes !== (before === null ? 0 : Buffer.byteLength(before)) ||
        pin.afterBytes !== (after === null ? 0 : Buffer.byteLength(after))
      )
        fail("PROPOSAL_HASH_MISMATCH");
    }
    return this.#tx(() => {
      const raced = this.findRequest(owned.input);
      if (raced) return Object.freeze({ kind: "duplicate", ...raced });
      if (
        knowledgeHash(this.#binding(capture.workspaceId)) !==
        knowledgeHash(capture.binding)
      )
        fail("PROPOSAL_STALE");
      const before = this.getSet(capture.workspaceId, capture.proposalId);
      const global = this.db
        .prepare("SELECT workspace_id FROM proposal_heads WHERE id=?")
        .get(capture.proposalId) as { workspace_id: string } | undefined;
      if (global && global.workspace_id !== capture.workspaceId)
        fail("PROPOSAL_SCOPE_MISMATCH");
      if (
        (before?.sha256 ?? null) !== (owned.before?.sha256 ?? null) ||
        before?.headRevision !== owned.before?.headRevision ||
        (before && before.status !== "pending")
      )
        fail("PROPOSAL_STALE");
      assertNotThenable(
        this.ports.assertSourcesCurrent(capture, source),
        transactionRequired,
      );
      const createdAt = this.#time(),
        headers: ProposalBlobHeader[] = [];
      const files = snapshot.operations.map((op, i) => {
        function blob(
          role: "before" | "after",
          body: string | null,
        ): ProposalBlobReference | null {
          if (body === null) return null;
          const unsigned = {
            id: randomUUID(),
            workspaceId: capture.workspaceId,
            proposalId: capture.proposalId,
            revisionId: capture.revisionId,
            operationIndex: i,
            role,
            sha256: sha256Hex(body),
            bytes: Buffer.byteLength(body),
            createdAt,
          };
          const header = validateProposalBlobHeader({
            ...unsigned,
            headerSha256: knowledgeHash(unsigned),
          });
          headers.push(header);
          const { createdAt: _, ...ref } = header;
          return Object.freeze(ref);
        }
        const beforeBlob = blob("before", op.before),
          afterBlob = blob("after", op.after);
        return Object.freeze({
          path: op.path,
          operation:
            beforeBlob === null
              ? ("create" as const)
              : afterBlob === null
                ? ("delete" as const)
                : ("update" as const),
          before: beforeBlob,
          after: afterBlob,
        });
      });
      const previous = before
        ? this.getRevision(capture.workspaceId, before.revisionId)
        : undefined;
      const revision = validateProposalRevision(
        signed({
          schemaVersion: 1,
          id: capture.revisionId,
          workspaceId: capture.workspaceId,
          proposalId: capture.proposalId,
          revision: (previous?.revision ?? 0) + 1,
          previousId: previous?.id ?? null,
          requestId: capture.requestId,
          requestInputSha256: capture.requestInputSha256,
          requestedProposalId: owned.input.proposalId ?? null,
          expectedHeadRevision: capture.expectedHeadRevision,
          binding: capture.binding,
          sourceManifest: manifest,
          sourceManifestSha256: manifest.sha256,
          files,
          totalBytes: manifest.totalBytes,
          createdAt,
        }),
      );
      this.db
        .prepare(
          "INSERT INTO proposal_revisions(id,workspace_id,proposal_id,revision,previous_id,request_id,request_sha256,data) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          revision.id,
          revision.workspaceId,
          revision.proposalId,
          revision.revision,
          revision.previousId,
          revision.requestId,
          revision.requestInputSha256,
          JSON.stringify(revision),
        );
      for (const header of headers) {
        const body = snapshot.operations[header.operationIndex]![header.role]!;
        this.ports.blobs.put(header, body);
        const actual = this.ports.blobs.get(header.workspaceId, header.id);
        if (
          !actual ||
          knowledgeHash(validateProposalBlobHeader(actual)) !==
            knowledgeHash(header)
        )
          fail("PROPOSAL_BLOB_MISMATCH");
        const { createdAt: _createdAt, ...actualReference } = header;
        if (exactBlob(this.db, actualReference, createdAt) !== body)
          fail("PROPOSAL_BLOB_MISMATCH");
      }
      assertNotThenable(
        this.ports.assertSourcesCurrent(capture, source),
        transactionRequired,
      );
      if (
        knowledgeHash(this.#binding(capture.workspaceId)) !==
        knowledgeHash(capture.binding)
      )
        fail("PROPOSAL_STALE");
      const set = validateProposalSet(
        signed({
          schemaVersion: 1,
          id: capture.proposalId,
          workspaceId: capture.workspaceId,
          revisionId: revision.id,
          revisionSha256: revision.sha256,
          headRevision: (before?.headRevision ?? 0) + 1,
          status: "pending",
          archiveSha256: null,
          updatedAt: createdAt,
        }),
      );
      if (before)
        advanceProposalHead(this.db, before, set, () => fail("PROPOSAL_STALE"));
      else
        this.db
          .prepare(
            "INSERT INTO proposal_heads(id,workspace_id,revision,revision_id,data) VALUES(?,?,?,?,?)",
          )
          .run(
            set.id,
            set.workspaceId,
            set.headRevision,
            set.revisionId,
            JSON.stringify(set),
          );
      return Object.freeze({ kind: "created" as const, set, revision });
    });
  }
  release(capture: PreparedProposalCapture): void {
    if (this.#owned.has(capture)) {
      this.#owned.delete(capture);
      this.#live.delete(capture);
    }
  }
  getSet(ws: string, key: string): ProposalSet | undefined {
    return readProposalHead(this.db, id(ws), id(key));
  }
  getRevision(ws: string, key: string): ProposalRevision | undefined {
    return revisionAt(this.db, id(ws), id(key));
  }
  getSelection(ws: string, key: string): ProposalSelection | undefined {
    const set = this.getSet(ws, key);
    if (!set || set.status !== "pending") return undefined;
    const revision = this.getRevision(ws, set.revisionId);
    if (
      !revision ||
      revision.proposalId !== set.id ||
      revision.sha256 !== set.revisionSha256
    )
      fail("PROPOSAL_SCOPE_MISMATCH");
    return Object.freeze({ set, revision });
  }
  #page<T>(
    keys: readonly { id: string }[],
    options: ProposalListOptions,
    read: (key: string) => T | undefined,
  ): ProposalPage<T> {
    const detached = exact(
      json(options, PROPOSAL_LIMITS.headerBytes),
      [],
      ["after", "limit", "maxBytes"],
    );
    if (detached.after !== undefined) id(detached.after);
    const limit =
        detached.limit === undefined
          ? PROPOSAL_LIMITS.pageRows
          : number(detached.limit, PROPOSAL_LIMITS.pageRows),
      maximum =
        detached.maxBytes === undefined
          ? PROPOSAL_LIMITS.pageBytes
          : number(detached.maxBytes, PROPOSAL_LIMITS.pageBytes);
    if (!limit || !maximum) fail("PROPOSAL_LIMIT");
    const items: T[] = [];
    let next: string | null = null;
    function measured(selected: readonly T[], cursor: string | null): number {
      const result = { items: selected, next: cursor, bytes: 0 };
      result.bytes = Buffer.byteLength(JSON.stringify(result));
      result.bytes = Buffer.byteLength(JSON.stringify(result));
      return result.bytes;
    }
    for (const [index, key] of keys.entries()) {
      if (items.length === limit) {
        next = keys[items.length - 1]!.id;
        break;
      }
      const item = read(key.id);
      if (!item) fail("PROPOSAL_STALE");
      const cursor = index < keys.length - 1 ? key.id : null;
      if (measured([...items, item], cursor) > maximum) {
        if (!items.length) fail("PROPOSAL_PAGE_LIMIT");
        next = keys[items.length - 1]!.id;
        break;
      }
      items.push(item);
    }
    const bytes = measured(items, next);
    if (bytes > maximum) fail("PROPOSAL_PAGE_LIMIT");
    return Object.freeze({ items: Object.freeze(items), next, bytes });
  }
  listSets(
    ws: string,
    options: ProposalListOptions = {},
  ): ProposalPage<ProposalSet> {
    id(ws);
    const o = exact(
      json(options, PROPOSAL_LIMITS.headerBytes),
      [],
      ["after", "limit", "maxBytes"],
    );
    if (o.after !== undefined) id(o.after);
    const keys = this.db
      .prepare(
        "SELECT id FROM proposal_heads WHERE workspace_id=? AND id>? ORDER BY id LIMIT 65",
      )
      .all(ws, o.after === undefined ? "" : id(o.after)) as { id: string }[];
    return this.#page(keys, options, (key) => this.getSet(ws, key));
  }
}

/** Import changes only the current head. Historical revisions and blob receipts remain exact. */
export function pauseImportedProposals(
  db: DatabaseSync,
  ws: string,
  archiveSha256: string,
): void {
  id(ws);
  hash(archiveSha256);
  if (!db.isTransaction) fail("PROPOSAL_TRANSACTION_REQUIRED");
  const keys = db
    .prepare("SELECT id FROM proposal_heads WHERE workspace_id=? ORDER BY id")
    .iterate(ws) as Iterable<{ id: string }>;
  for (const { id: key } of keys) {
    const old = readProposalHead(db, ws, key)!;
    const { sha256: _, ...body } = old;
    const current = validateProposalSet(
      signed({
        ...body,
        headRevision: old.headRevision + 1,
        status: "paused-import",
        archiveSha256,
      }),
    );
    db.prepare(
      "UPDATE proposal_heads SET revision=?,data=? WHERE workspace_id=? AND id=? AND revision=?",
    ).run(
      current.headRevision,
      JSON.stringify(current),
      ws,
      key,
      old.headRevision,
    );
  }
}

function exactBlob(
  db: DatabaseSync,
  ref: ProposalBlobReference,
  createdAt: string,
): string {
  const row = db
    .prepare(
      "SELECT id,workspace_id,proposal_id,revision_id,operation_index,role,sha256,bytes,header_sha256,length(CAST(data AS BLOB)) AS data_bytes,length(content) AS content_bytes FROM proposal_blobs WHERE workspace_id=? AND id=?",
    )
    .get(ref.workspaceId, ref.id) as Record<string, unknown> | undefined;
  if (!row) fail("PROPOSAL_BLOB_MISSING");
  number(row.data_bytes, PROPOSAL_LIMITS.headerBytes);
  number(row.content_bytes, PROPOSAL_LIMITS.fileBytes);
  if (
    row.id !== ref.id ||
    row.workspace_id !== ref.workspaceId ||
    row.proposal_id !== ref.proposalId ||
    row.revision_id !== ref.revisionId ||
    row.operation_index !== ref.operationIndex ||
    row.role !== ref.role ||
    row.sha256 !== ref.sha256 ||
    row.bytes !== ref.bytes ||
    row.header_sha256 !== ref.headerSha256 ||
    row.content_bytes !== ref.bytes
  )
    fail("PROPOSAL_SCOPE_MISMATCH");
  const raw = db
    .prepare(
      "SELECT data FROM proposal_blobs WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))<=?",
    )
    .get(ref.workspaceId, ref.id, PROPOSAL_LIMITS.headerBytes) as
    { data: string } | undefined;
  if (!raw) fail("PROPOSAL_STALE");
  const header = validateProposalBlobHeader(
    decoded(raw.data, PROPOSAL_LIMITS.headerBytes),
  );
  const { createdAt: actualCreatedAt, ...reference } = header;
  if (
    actualCreatedAt !== createdAt ||
    knowledgeHash(reference) !== knowledgeHash(ref)
  )
    fail("PROPOSAL_SCOPE_MISMATCH");
  const loaded = db
    .prepare(
      "SELECT content FROM proposal_blobs WHERE workspace_id=? AND id=? AND length(content)=? AND length(content)<=?",
    )
    .get(ref.workspaceId, ref.id, ref.bytes, PROPOSAL_LIMITS.fileBytes) as
    { content: Uint8Array } | undefined;
  if (
    !loaded ||
    !(loaded.content instanceof Uint8Array) ||
    loaded.content.byteLength !== ref.bytes
  )
    fail("PROPOSAL_BLOB_MISMATCH");
  const bytes = Buffer.from(loaded.content),
    text = bytes.toString("utf8");
  if (
    bytes.includes(0) ||
    !Buffer.from(text).equals(bytes) ||
    sha256Hex(text) !== ref.sha256
  )
    fail("PROPOSAL_BLOB_MISMATCH");
  return text;
}
/** Bounded semantic inspection reads metadata before every row/BLOB and never rebinds history. */
export function validateProposalDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  for (const row of db
    .prepare("SELECT id,workspace_id FROM proposal_revisions ORDER BY id")
    .iterate() as Iterable<{ id: string; workspace_id: string }>) {
    check();
    const r = revisionAt(db, id(row.workspace_id), id(row.id))!;
    if (r.expectedHeadRevision !== r.revision - 1)
      fail("PROPOSAL_SCOPE_MISMATCH");
    if (r.previousId !== null) {
      const previous = revisionAt(db, r.workspaceId, r.previousId);
      if (
        !previous ||
        previous.proposalId !== r.proposalId ||
        previous.revision !== r.revision - 1 ||
        knowledgeHash(previous.binding) !== knowledgeHash(r.binding) ||
        Date.parse(previous.createdAt) > Date.parse(r.createdAt)
      )
        fail("PROPOSAL_SCOPE_MISMATCH");
    }
    const set = readProposalHead(db, r.workspaceId, r.proposalId);
    if (!set) fail("PROPOSAL_HEAD_MISSING");
    const operations: ProposalSourceOperation[] = [];
    for (const file of r.files) {
      check();
      if (file.before !== null) exactBlob(db, file.before, r.createdAt);
      const after =
        file.after === null ? null : exactBlob(db, file.after, r.createdAt);
      operations.push({
        path: file.path,
        expectedSha256: file.before?.sha256 ?? null,
        after,
      });
    }
    const request = {
      workspaceId: r.workspaceId,
      requestId: r.requestId,
      ...(r.requestedProposalId === null
        ? {}
        : { proposalId: r.requestedProposalId }),
      expectedHeadRevision: r.expectedHeadRevision,
      operations,
    };
    if (proposalRequestFingerprint(request) !== r.requestInputSha256)
      fail("PROPOSAL_HASH_MISMATCH");
  }
  for (const row of db
    .prepare("SELECT id,workspace_id FROM proposal_heads ORDER BY id")
    .iterate() as Iterable<{ id: string; workspace_id: string }>) {
    check();
    const h = readProposalHead(db, id(row.workspace_id), id(row.id))!,
      r = revisionAt(db, h.workspaceId, h.revisionId);
    const latest = db
      .prepare(
        "SELECT id,revision FROM proposal_revisions WHERE workspace_id=? AND proposal_id=? ORDER BY revision DESC LIMIT 1",
      )
      .get(h.workspaceId, h.id) as { id: string; revision: number } | undefined;
    if (
      !r ||
      r.proposalId !== h.id ||
      r.sha256 !== h.revisionSha256 ||
      latest?.id !== r.id ||
      latest.revision !== r.revision ||
      h.headRevision < r.revision ||
      (h.status === "pending" && h.headRevision !== r.revision) ||
      (h.status === "paused-import" && h.headRevision <= r.revision)
    )
      fail("PROPOSAL_SCOPE_MISMATCH");
  }
  for (const row of db
    .prepare(
      "SELECT id,workspace_id,revision_id,operation_index,role FROM proposal_blobs ORDER BY id",
    )
    .iterate() as Iterable<{
    id: string;
    workspace_id: string;
    revision_id: string;
    operation_index: number;
    role: string;
  }>) {
    check();
    const r = revisionAt(db, id(row.workspace_id), id(row.revision_id));
    const i = number(row.operation_index, PROPOSAL_LIMITS.files - 1);
    if (!r || (row.role !== "before" && row.role !== "after"))
      fail("PROPOSAL_SCOPE_MISMATCH");
    const ref = r.files[i]?.[row.role];
    if (!ref || ref.id !== row.id) fail("PROPOSAL_BLOB_ORPHAN");
    exactBlob(db, ref, r.createdAt);
  }
}
