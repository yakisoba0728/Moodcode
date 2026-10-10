import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash, validateBinding } from "../knowledge/validation.js";
import { validateProposalRevision, validateProposalSet } from "./store.js";

import type {
  PrepareProposalApply,
  PrepareProposalApplyResult,
  ProposalApplyCapture,
  ProposalApplyCheckpoint,
  ProposalApplyGuard,
  ProposalApplyHistory,
  ProposalApplyOwner,
  ProposalApplyReceipt,
  ProposalApplyRecoveryDecision,
  ProposalApplyRecoveryPreview,
  ProposalApplyStoragePorts,
  ProposalApplyTable,
  ProposalEffectBlobReference,
  ProposalPhysicalOutcome,
} from "./apply-types.js";

const PROPOSAL_APPLY_LIMITS = Object.freeze({
  files: 32,
  fileBytes: 1_048_576,
  totalBytes: 4_194_304,
  rowBytes: 65_536,
  checkpointBytes: 262_144,
  handles: 128,
  frontierOwners: 32,
  frontierBytes: 1_048_576,
});
export const PROPOSAL_APPLY_TABLES: readonly ProposalApplyTable[] =
  Object.freeze([
    "proposal_apply_owners",
    "proposal_apply_checkpoints",
    "proposal_effect_blobs",
    "proposal_apply_receipts",
    "proposal_apply_recovery_decisions",
  ]);
export const PROPOSAL_APPLY_SCHEMA_SQL = `
CREATE TABLE proposal_apply_owners (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),proposal_id TEXT NOT NULL REFERENCES proposal_heads(id),
 revision_id TEXT NOT NULL REFERENCES proposal_revisions(id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','completed','partial','cancelled','uncertain')),revision INTEGER NOT NULL CHECK(revision>=1),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(workspace_id,request_id),UNIQUE(revision_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE proposal_apply_checkpoints (
 id TEXT PRIMARY KEY REFERENCES proposal_apply_owners(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),owner_id TEXT NOT NULL REFERENCES proposal_apply_owners(id),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=262144),CHECK(id=owner_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE proposal_effect_blobs (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),owner_id TEXT NOT NULL REFERENCES proposal_apply_owners(id),
 checkpoint_id TEXT NOT NULL REFERENCES proposal_apply_checkpoints(id),file_index INTEGER NOT NULL CHECK(file_index>=0 AND file_index<32),
 sha256 TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=1048576),header_sha256 TEXT NOT NULL,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),content BLOB NOT NULL CHECK(length(content)=bytes)
) STRICT, WITHOUT ROWID;
CREATE TABLE proposal_apply_receipts (
 id TEXT PRIMARY KEY REFERENCES proposal_apply_owners(id),workspace_id TEXT NOT NULL REFERENCES workspaces(id),owner_id TEXT NOT NULL REFERENCES proposal_apply_owners(id),
 request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),CHECK(id=owner_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE proposal_apply_recovery_decisions (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),revision INTEGER NOT NULL CHECK(revision>=1),operation TEXT NOT NULL CHECK(operation IN ('acknowledge','resume')),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(workspace_id,revision)
) STRICT, WITHOUT ROWID;
`;

function fail(
  code = "INVALID_PROPOSAL_APPLY",
  message = "Proposal apply requires exact native original ownership and observed effect proof",
): never {
  throw new EngineError(code, message);
}
function id(v: unknown): string {
  if (
    typeof v !== "string" ||
    !v ||
    Buffer.byteLength(v) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(v)
  )
    fail();
  return v;
}
function count(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max)
    fail();
  return v as number;
}
function digest(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/u.test(v)) fail();
  return v;
}
function utc(v: unknown): string {
  if (
    typeof v !== "string" ||
    v.length !== 24 ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    fail();
  return v;
}
function bodyHash(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}
function immutable<T>(
  input: T,
  maximum: number = PROPOSAL_APPLY_LIMITS.rowBytes,
): T {
  let nodes = 0,
    bytes = 0;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 12_000 || depth > 16) fail("PROPOSAL_APPLY_LIMIT");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      if (bytes > maximum || Buffer.from(value).toString("utf8") !== value)
        fail("PROPOSAL_APPLY_LIMIT");
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (
      !value ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      seen.has(value)
    )
      fail();
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (
      array
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    )
      fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some((k) => typeof k !== "string") ||
      Object.values(descriptors).some((d) => !Object.hasOwn(d, "value"))
    )
      fail();
    seen.add(value);
    let result: unknown;
    if (array) {
      if (
        value.length > 128 ||
        Object.keys(descriptors).length !== value.length + 1 ||
        Array.from(
          { length: value.length },
          (_, i) => descriptors[String(i)],
        ).some((d) => !d?.enumerable)
      )
        fail();
      result = Array.from({ length: value.length }, (_, i) =>
        visit(descriptors[String(i)]!.value, depth + 1),
      );
    } else {
      const target: Record<string, unknown> = {};
      for (const [k, d] of Object.entries(descriptors)) {
        if (!d.enumerable || k === "__proto__") fail();
        bytes += Buffer.byteLength(k);
        target[k] = visit(d.value, depth + 1);
      }
      result = target;
    }
    seen.delete(value);
    return Object.freeze(result);
  }
  const result = visit(input, 0) as T;
  if (Buffer.byteLength(JSON.stringify(result)) > maximum)
    fail("PROPOSAL_APPLY_LIMIT");
  return result;
}
function fields(
  v: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  const r = v as Record<string, unknown>;
  if (
    Object.keys(r).length !== required.length ||
    Object.keys(r).some((k) => !required.includes(k))
  )
    fail();
  return r;
}
function signed<T extends object>(
  v: T,
  maximum: number = PROPOSAL_APPLY_LIMITS.rowBytes,
): T & { sha256: string } {
  return immutable({ ...v, sha256: knowledgeHash(v) }, maximum);
}
function checkHash(r: Record<string, unknown>): void {
  const { sha256, ...v } = r;
  if (digest(sha256) !== knowledgeHash(v)) fail("PROPOSAL_APPLY_HASH_MISMATCH");
}
const inputFields = [
  "workspaceId",
  "proposalId",
  "revisionId",
  "revisionSha256",
  "sourceManifestSha256",
  "beforeHead",
  "binding",
  "previewSha256",
  "expiresAt",
  "deadline",
  "requestId",
  "requestSha256",
] as const;
function validatePrepareProposalApply(
  value: unknown,
): PrepareProposalApply {
  const r = fields(immutable(value), inputFields);
  for (const k of ["workspaceId", "proposalId", "revisionId", "requestId"])
    id(r[k]);
  for (const k of [
    "revisionSha256",
    "sourceManifestSha256",
    "previewSha256",
    "requestSha256",
  ])
    digest(r[k]);
  utc(r.expiresAt);
  count(r.deadline, 8_640_000_000_000_000);
  const binding = validateBinding(r.binding),
    head = validateProposalSet(r.beforeHead);
  if (
    binding.workspaceId !== r.workspaceId ||
    head.workspaceId !== r.workspaceId ||
    head.id !== r.proposalId ||
    head.revisionId !== r.revisionId ||
    head.revisionSha256 !== r.revisionSha256 ||
    head.status !== "pending"
  )
    fail("PROPOSAL_APPLY_STALE");
  const { requestSha256, ...input } = r;
  if (knowledgeHash(input) !== requestSha256)
    fail("PROPOSAL_APPLY_HASH_MISMATCH");
  return r as unknown as PrepareProposalApply;
}
function validateProposalApplyOwner(value: unknown): ProposalApplyOwner {
  const r = fields(immutable(value), [
    ...inputFields,
    "id",
    "runtimeEpoch",
    "revision",
    "state",
    "createdAt",
    "updatedAt",
    "dispatchedAt",
    "checkpointId",
    "checkpointSha256",
    "guardSha256",
    "cleanupConfirmed",
    "errorCode",
    "sha256",
  ]);
  const input = Object.fromEntries(inputFields.map((k) => [k, r[k]]));
  validatePrepareProposalApply(input);
  id(r.id);
  id(r.runtimeEpoch);
  if (
    count(r.revision) < 1 ||
    ![
      "prepared",
      "dispatched",
      "completed",
      "partial",
      "cancelled",
      "uncertain",
    ].includes(r.state as string)
  )
    fail();
  utc(r.createdAt);
  utc(r.updatedAt);
  if (r.dispatchedAt !== null) utc(r.dispatchedAt);
  for (const k of ["checkpointId", "errorCode"]) if (r[k] !== null) id(r[k]);
  for (const k of ["checkpointSha256", "guardSha256"])
    if (r[k] !== null) digest(r[k]);
  if (
    (r.checkpointId === null) !== (r.checkpointSha256 === null) ||
    (r.checkpointId !== null && r.checkpointId !== r.id) ||
    (r.cleanupConfirmed !== null && typeof r.cleanupConfirmed !== "boolean")
  )
    fail();
  if (
    (r.state === "prepared" &&
      (r.dispatchedAt !== null ||
        r.checkpointId !== null ||
        r.cleanupConfirmed !== null)) ||
    (r.state === "dispatched" &&
      (r.dispatchedAt === null || r.guardSha256 === null)) ||
    (r.state === "completed" &&
      (r.checkpointId === null ||
        r.cleanupConfirmed !== true ||
        r.errorCode !== null)) ||
    (r.state === "partial" &&
      (r.checkpointId === null || r.cleanupConfirmed !== true)) ||
    (r.state === "cancelled" &&
      (r.dispatchedAt !== null ||
        r.checkpointId !== null ||
        r.guardSha256 !== null ||
        r.cleanupConfirmed !== true)) ||
    (r.state === "uncertain" && typeof r.cleanupConfirmed !== "boolean")
  )
    fail();
  checkHash(r);
  return r as unknown as ProposalApplyOwner;
}
function decoded(v: unknown, maximum: number): unknown {
  if (typeof v !== "string" || Buffer.byteLength(v) > maximum)
    fail("PROPOSAL_APPLY_LIMIT");
  try {
    return JSON.parse(v);
  } catch {
    fail("INVALID_PROPOSAL_APPLY_ROW");
  }
}
function readRow(
  db: DatabaseSync,
  table: ProposalApplyTable,
  ws: string,
  key: string,
): unknown | undefined {
  const max =
    table === "proposal_apply_checkpoints"
      ? PROPOSAL_APPLY_LIMITS.checkpointBytes
      : PROPOSAL_APPLY_LIMITS.rowBytes;
  const meta = db
    .prepare(
      `SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE workspace_id=? AND id=?`,
    )
    .get(ws, key);
  if (!meta) return undefined;
  count(meta.bytes, max);
  const row = db
    .prepare(
      `SELECT data FROM ${table} WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))<=?`,
    )
    .get(ws, key, max);
  if (!row) fail("PROPOSAL_APPLY_STALE");
  return decoded(row.data, max);
}
function validateProposalApplyGuard(value: unknown): ProposalApplyGuard {
  const r = fields(immutable(value), [
    "id",
    "workspaceId",
    "ownerId",
    "binding",
    "lock",
    "marker",
    "sha256",
  ]);
  if (id(r.id) !== id(r.ownerId)) fail();
  id(r.workspaceId);
  if (validateBinding(r.binding).workspaceId !== r.workspaceId) fail();
  const lock = fields(r.lock, ["path", "device", "inode"]),
    marker = fields(r.marker, ["ownerPid", "groupPid", "active", "updatedAt"]);
  if (
    typeof lock.path !== "string" ||
    !lock.path.startsWith("/") ||
    Buffer.byteLength(lock.path) > 4096 ||
    lock.path.includes("\0") ||
    typeof lock.device !== "string" ||
    !/^\d{1,32}$/u.test(lock.device) ||
    typeof lock.inode !== "string" ||
    !/^\d{1,32}$/u.test(lock.inode) ||
    count(marker.ownerPid) < 1 ||
    marker.groupPid !== null ||
    marker.active !== true ||
    typeof marker.updatedAt !== "string" ||
    Buffer.byteLength(marker.updatedAt) > 128 ||
    !Number.isFinite(Date.parse(marker.updatedAt))
  )
    fail();
  checkHash(r);
  return r as unknown as ProposalApplyGuard;
}
function image(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value) > PROPOSAL_APPLY_LIMITS.fileBytes ||
    Buffer.from(value).toString("utf8") !== value
  )
    fail("PROPOSAL_APPLY_LIMIT");
  return value;
}
function validateProposalApplyCheckpoint(
  value: unknown,
): ProposalApplyCheckpoint {
  const r = fields(immutable(value, PROPOSAL_APPLY_LIMITS.checkpointBytes), [
    "id",
    "workspaceId",
    "ownerId",
    "revisionId",
    "files",
    "createdParentCount",
    "createdParents",
    "createdParentsComplete",
    "complete",
    "partial",
    "producerCleanupConfirmed",
    "errorCode",
    "warnings",
    "createdAt",
    "sha256",
  ]);
  if (id(r.id) !== id(r.ownerId)) fail();
  id(r.workspaceId);
  id(r.revisionId);
  utc(r.createdAt);
  count(r.createdParentCount);
  for (const k of [
    "createdParentsComplete",
    "complete",
    "partial",
    "producerCleanupConfirmed",
  ])
    if (typeof r[k] !== "boolean") fail();
  if (r.errorCode !== null) id(r.errorCode);
  if (
    !Array.isArray(r.files) ||
    !r.files.length ||
    r.files.length > PROPOSAL_APPLY_LIMITS.files ||
    !Array.isArray(r.createdParents) ||
    r.createdParents.length > 16 ||
    !Array.isArray(r.warnings) ||
    r.warnings.length > 64 ||
    r.createdParents.length > (r.createdParentCount as number) ||
    (r.createdParentsComplete &&
      r.createdParents.length !== r.createdParentCount)
  )
    fail();
  for (const text of [...r.createdParents, ...r.warnings])
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > 4096 ||
      text.includes("\0")
    )
      fail("PROPOSAL_APPLY_LIMIT");
  for (const file of r.files) {
    const f = fields(file, [
      "path",
      "attempted",
      "mayHaveChanged",
      "before",
      "after",
      "observationComplete",
    ]);
    id(f.path);
    for (const k of ["attempted", "mayHaveChanged", "observationComplete"])
      if (typeof f[k] !== "boolean") fail();
    if (
      (!f.attempted && f.mayHaveChanged) ||
      (!f.observationComplete && f.after !== null)
    )
      fail();
    for (const key of ["before", "after"])
      if (f[key] !== null) {
        const ref = f[key] as Record<string, unknown>;
        id(ref.id);
        id(ref.workspaceId);
        if (ref.workspaceId !== r.workspaceId)
          fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
        digest(ref.sha256);
        count(ref.bytes, PROPOSAL_APPLY_LIMITS.fileBytes);
        digest(ref.headerSha256);
      }
  }
  checkHash(r);
  return r as unknown as ProposalApplyCheckpoint;
}
function validateProposalApplyReceipt(
  value: unknown,
): ProposalApplyReceipt {
  const r = fields(immutable(value), [
    "id",
    "workspaceId",
    "ownerId",
    "requestId",
    "requestSha256",
    "revisionId",
    "revisionSha256",
    "checkpointId",
    "checkpointSha256",
    "beforeHead",
    "afterHead",
    "state",
    "cleanupConfirmed",
    "createdAt",
    "sha256",
  ]);
  if (id(r.id) !== id(r.ownerId) || id(r.checkpointId) !== r.id) fail();
  for (const k of ["workspaceId", "requestId", "revisionId"]) id(r[k]);
  for (const k of ["requestSha256", "revisionSha256", "checkpointSha256"])
    digest(r[k]);
  utc(r.createdAt);
  const before = validateProposalSet(r.beforeHead),
    after = validateProposalSet(r.afterHead);
  const proof = after.applySettlement;
  if (
    !["completed", "partial", "uncertain"].includes(r.state as string) ||
    typeof r.cleanupConfirmed !== "boolean" ||
    (r.state !== "uncertain" && r.cleanupConfirmed !== true) ||
    before.status !== "pending" ||
    after.workspaceId !== r.workspaceId ||
    before.workspaceId !== r.workspaceId ||
    before.id !== after.id ||
    before.revisionId !== r.revisionId ||
    after.revisionId !== r.revisionId ||
    before.revisionSha256 !== r.revisionSha256 ||
    after.revisionSha256 !== r.revisionSha256 ||
    after.headRevision !== before.headRevision + 1 ||
    after.status !== (r.state === "completed" ? "applied" : r.state) ||
    !proof ||
    proof.receiptId !== r.id ||
    proof.state !== r.state ||
    proof.checkpointSha256 !== r.checkpointSha256 ||
    proof.cleanupConfirmed !== r.cleanupConfirmed
  )
    fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
  checkHash(r);
  return r as unknown as ProposalApplyReceipt;
}
interface Owned {
  readonly original: object;
  readonly epoch: string;
}
export class ProposalApplyStorage {
  readonly #epoch = randomUUID();
  readonly #owned = new WeakMap<object, Owned>();
  readonly #live = new Set<ProposalApplyCapture>();
  readonly #previews = new WeakMap<
    object,
    { readonly fingerprint: string; readonly phase: "acknowledge" | "resume" }
  >();
  constructor(
    readonly db: DatabaseSync,
    readonly ports: ProposalApplyStoragePorts,
  ) {}
  #tx<T>(operation: () => T): T {
    let entries = 0;
    const result = this.ports.writeTx(() => {
      if (++entries !== 1 || !this.db.isTransaction)
        fail("PROPOSAL_APPLY_TRANSACTION_REQUIRED");
      const result = operation();
      if (result && typeof result === "object" && "then" in result)
        fail("PROPOSAL_APPLY_TRANSACTION_REQUIRED");
      return result;
    });
    if (
      entries !== 1 ||
      (result && typeof result === "object" && "then" in result)
    )
      fail("PROPOSAL_APPLY_TRANSACTION_REQUIRED");
    return result;
  }
  #now(): number {
    const now = this.ports.now?.() ?? Date.now();
    return count(now, 8_640_000_000_000_000);
  }
  #owner(capture: ProposalApplyCapture): {
    record: ProposalApplyOwner;
    owned: Owned;
  } {
    const owned = this.#owned.get(capture);
    if (!owned || !this.#live.has(capture) || owned.epoch !== this.#epoch)
      fail("PROPOSAL_APPLY_CAPTURE_REQUIRED");
    const record = this.getOwner(capture.workspaceId, capture.ownerId);
    if (
      !record ||
      record.runtimeEpoch !== capture.runtimeEpoch ||
      record.runtimeEpoch !== this.#epoch
    )
      fail("PROPOSAL_APPLY_STALE");
    return { record, owned };
  }
  getOwner(ws: string, key: string): ProposalApplyOwner | undefined {
    const data = readRow(this.db, "proposal_apply_owners", id(ws), id(key));
    if (data === undefined) return undefined;
    const owner = validateProposalApplyOwner(data);
    const meta = this.db
      .prepare(
        "SELECT proposal_id,revision_id,request_id,request_sha256,state,revision FROM proposal_apply_owners WHERE workspace_id=? AND id=?",
      )
      .get(ws, key)!;
    if (
      owner.id !== key ||
      owner.workspaceId !== ws ||
      owner.proposalId !== meta.proposal_id ||
      owner.revisionId !== meta.revision_id ||
      owner.requestId !== meta.request_id ||
      owner.requestSha256 !== meta.request_sha256 ||
      owner.state !== meta.state ||
      owner.revision !== meta.revision
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    return owner;
  }
  #update(
    owner: ProposalApplyOwner,
    patch: Partial<ProposalApplyOwner>,
  ): ProposalApplyOwner {
    const { sha256: _, ...body } = owner;
    const updated = validateProposalApplyOwner(
      signed({
        ...body,
        ...patch,
        revision: owner.revision + 1,
        updatedAt: new Date(this.#now()).toISOString(),
      }),
    );
    const result = this.db
      .prepare(
        "UPDATE proposal_apply_owners SET state=?,revision=?,data=? WHERE workspace_id=? AND id=? AND revision=? AND data=?",
      )
      .run(
        updated.state,
        updated.revision,
        JSON.stringify(updated),
        owner.workspaceId,
        owner.id,
        owner.revision,
        JSON.stringify(owner),
      );
    if (result.changes !== 1) fail("PROPOSAL_APPLY_STALE");
    return updated;
  }
  #current(record: ProposalApplyOwner): void {
    if (
      knowledgeHash(
        validateBinding(this.ports.checkBinding(record.workspaceId)),
      ) !== knowledgeHash(record.binding) ||
      this.#now() >= record.deadline ||
      this.#now() >= Date.parse(record.expiresAt)
    )
      fail("PROPOSAL_APPLY_STALE");
    const head = this.ports.getHead(record.workspaceId, record.proposalId),
      revision = this.ports.getRevision(record.workspaceId, record.revisionId);
    if (
      !head ||
      head.sha256 !== record.beforeHead.sha256 ||
      !revision ||
      validateProposalRevision(revision).sha256 !== record.revisionSha256 ||
      revision.sourceManifestSha256 !== record.sourceManifestSha256
    )
      fail("PROPOSAL_APPLY_STALE");
  }
  getCheckpoint(ws: string, key: string): ProposalApplyCheckpoint | undefined {
    const data = readRow(
      this.db,
      "proposal_apply_checkpoints",
      id(ws),
      id(key),
    );
    if (data === undefined) return undefined;
    const value = validateProposalApplyCheckpoint(data);
    const meta = this.db
      .prepare(
        "SELECT owner_id FROM proposal_apply_checkpoints WHERE workspace_id=? AND id=?",
      )
      .get(ws, key);
    if (
      value.id !== key ||
      value.ownerId !== key ||
      value.workspaceId !== ws ||
      meta?.owner_id !== value.ownerId
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    return value;
  }
  getReceipt(ws: string, key: string): ProposalApplyReceipt | undefined {
    const data = readRow(this.db, "proposal_apply_receipts", id(ws), id(key));
    if (data === undefined) return undefined;
    const value = validateProposalApplyReceipt(data);
    const meta = this.db
      .prepare(
        "SELECT owner_id,request_id,request_sha256 FROM proposal_apply_receipts WHERE workspace_id=? AND id=?",
      )
      .get(ws, key);
    if (
      value.id !== key ||
      value.ownerId !== key ||
      value.workspaceId !== ws ||
      meta?.owner_id !== value.ownerId ||
      meta.request_id !== value.requestId ||
      meta.request_sha256 !== value.requestSha256
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    return value;
  }
  getHistory(ws: string, key: string): ProposalApplyHistory | undefined {
    const owner = this.getOwner(ws, key);
    if (!owner) return undefined;
    const checkpoint = this.getCheckpoint(ws, key) ?? null,
      receipt = this.getReceipt(ws, key) ?? null;
    if (
      (owner.checkpointId !== null) !== (checkpoint !== null) ||
      (["completed", "partial"].includes(owner.state) && receipt === null)
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    if (
      (checkpoint &&
        (checkpoint.sha256 !== owner.checkpointSha256 ||
          checkpoint.revisionId !== owner.revisionId)) ||
      (receipt &&
        (receipt.checkpointSha256 !== checkpoint?.sha256 ||
          receipt.requestSha256 !== owner.requestSha256 ||
          receipt.requestId !== owner.requestId ||
          receipt.revisionSha256 !== owner.revisionSha256 ||
          receipt.cleanupConfirmed !== owner.cleanupConfirmed ||
          receipt.beforeHead.sha256 !== owner.beforeHead.sha256 ||
          receipt.revisionId !== owner.revisionId ||
          receipt.afterHead.applySettlement?.ownerSha256 !== owner.sha256 ||
          receipt.state !== owner.state))
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    const rawHead = this.db
      .prepare(
        "SELECT data FROM proposal_heads WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))<=65536",
      )
      .get(ws, owner.proposalId);
    if (!rawHead) fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    const head = validateProposalSet(decoded(rawHead.data, 65536));
    if (receipt && head.applySettlement?.ownerId !== owner.id)
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    if (head.applySettlement?.ownerId === owner.id) {
      if (
        !receipt ||
        knowledgeHash(head.applySettlement) !==
          knowledgeHash(receipt.afterHead.applySettlement)
      )
        fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
      if (
        head.status === "paused-import"
          ? head.headRevision <= receipt.afterHead.headRevision
          : head.sha256 !== receipt.afterHead.sha256
      )
        fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    }
    return Object.freeze({ owner, checkpoint, receipt });
  }
  getRequest(ws: string, requestId: string): ProposalApplyHistory | undefined {
    id(ws);
    id(requestId);
    const row = this.db
      .prepare(
        "SELECT id FROM proposal_apply_owners WHERE workspace_id=? AND request_id=?",
      )
      .get(ws, requestId);
    return row ? this.getHistory(ws, id(row.id)) : undefined;
  }
  findRequest(input: {
    workspaceId: string;
    requestId: string;
    requestSha256: string;
  }): ProposalApplyHistory | undefined {
    const r = fields(immutable(input), [
      "workspaceId",
      "requestId",
      "requestSha256",
    ]);
    const result = this.getRequest(id(r.workspaceId), id(r.requestId));
    if (result && result.owner.requestSha256 !== digest(r.requestSha256))
      fail("PROPOSAL_APPLY_REQUEST_CONFLICT");
    digest(r.requestSha256);
    return result;
  }
  prepare(
    original: object,
    input: PrepareProposalApply,
  ): PrepareProposalApplyResult {
    const normalized = validatePrepareProposalApply(input),
      duplicate = this.findRequest({
        workspaceId: normalized.workspaceId,
        requestId: normalized.requestId,
        requestSha256: normalized.requestSha256,
      });
    if (duplicate)
      return Object.freeze({ kind: "duplicate", history: duplicate });
    if (this.#live.size >= PROPOSAL_APPLY_LIMITS.handles)
      fail("PROPOSAL_APPLY_CAPACITY");
    const observed = immutable(
      this.ports.readApprovedCapture(original, normalized),
    );
    const { requestId: _, requestSha256: __, ...pins } = normalized;
    if (knowledgeHash(observed) !== knowledgeHash(pins))
      fail("PROPOSAL_APPLY_CAPTURE_REQUIRED");
    return this.#tx(() => {
      const raced = this.findRequest({
        workspaceId: normalized.workspaceId,
        requestId: normalized.requestId,
        requestSha256: normalized.requestSha256,
      });
      if (raced)
        return Object.freeze({ kind: "duplicate" as const, history: raced });
      const revision = this.ports.getRevision(
        normalized.workspaceId,
        normalized.revisionId,
      );
      if (
        !revision ||
        validateProposalRevision(revision).sha256 !== normalized.revisionSha256
      )
        fail("PROPOSAL_APPLY_STALE");
      if (
        revision.files.length > PROPOSAL_APPLY_LIMITS.files ||
        revision.totalBytes > PROPOSAL_APPLY_LIMITS.totalBytes
      )
        fail("PROPOSAL_APPLY_UNSUPPORTED_LIMIT");
      if (
        this.db
          .prepare("SELECT id FROM proposal_apply_owners WHERE revision_id=?")
          .get(normalized.revisionId)
      )
        fail(
          "PROPOSAL_APPLY_REVISION_USED",
          "A proposal revision is never applied twice, even when an earlier attempt changed no file; append a new revision to apply again",
        );
      const ownerId = randomUUID(),
        capture = immutable({
          workspaceId: normalized.workspaceId,
          ownerId,
          runtimeEpoch: this.#epoch,
        }) as ProposalApplyCapture;
      const createdAt = new Date(this.#now()).toISOString();
      const owner = validateProposalApplyOwner(
        signed({
          ...normalized,
          id: ownerId,
          runtimeEpoch: this.#epoch,
          revision: 1,
          state: "prepared",
          createdAt,
          updatedAt: createdAt,
          dispatchedAt: null,
          checkpointId: null,
          checkpointSha256: null,
          guardSha256: null,
          cleanupConfirmed: null,
          errorCode: null,
        }),
      );
      this.#current(owner);
      if (owner.deadline - this.#now() > 90_000) fail("PROPOSAL_APPLY_LIMIT");
      this.ports.assertCurrent(original, capture, "prepare");
      this.db
        .prepare(
          "INSERT INTO proposal_apply_owners(id,workspace_id,proposal_id,revision_id,request_id,request_sha256,state,revision,data) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          owner.id,
          owner.workspaceId,
          owner.proposalId,
          owner.revisionId,
          owner.requestId,
          owner.requestSha256,
          owner.state,
          owner.revision,
          JSON.stringify(owner),
        );
      this.#owned.set(capture, { original, epoch: this.#epoch });
      this.#live.add(capture);
      return Object.freeze({ kind: "created" as const, capture, owner });
    });
  }
  /** Reserves the guard row and claims it in one transaction, so a failed claim leaves no guard. */
  claim(capture: ProposalApplyCapture, reserveGuard: () => object): object {
    return this.#tx(() => {
      const { record, owned } = this.#owner(capture);
      if (record.state !== "prepared" || record.guardSha256 !== null)
        fail("PROPOSAL_APPLY_STALE");
      this.#current(record);
      this.ports.assertCurrent(owned.original, capture, "prepare");
      const originalGuard = reserveGuard();
      const guard = validateProposalApplyGuard(
        this.ports.readExecutionGuard(capture, originalGuard),
      );
      if (
        guard.ownerId !== record.id ||
        guard.workspaceId !== record.workspaceId ||
        knowledgeHash(guard.binding) !== knowledgeHash(record.binding) ||
        this.ports.getExecutionGuard(record.workspaceId, record.id)?.sha256 !==
          guard.sha256
      )
        fail("PROPOSAL_APPLY_GUARD_INVALID");
      this.#update(record, { guardSha256: guard.sha256 });
      return originalGuard;
    });
  }
  dispatch(capture: ProposalApplyCapture): ProposalApplyOwner {
    return this.#tx(() => {
      const { record, owned } = this.#owner(capture);
      if (record.state !== "prepared" || record.guardSha256 === null)
        fail("PROPOSAL_APPLY_STALE");
      this.#current(record);
      this.ports.assertCurrent(owned.original, capture, "dispatch");
      const guard = this.ports.getExecutionGuard(record.workspaceId, record.id);
      if (
        !guard ||
        validateProposalApplyGuard(guard).sha256 !== record.guardSha256
      )
        fail("PROPOSAL_APPLY_GUARD_INVALID");
      return this.#update(record, {
        state: "dispatched",
        dispatchedAt: new Date(this.#now()).toISOString(),
      });
    });
  }
  checkpoint(
    capture: ProposalApplyCapture,
    originalResult: object,
  ): ProposalApplyCheckpoint {
    const { record } = this.#owner(capture);
    if (record.state !== "dispatched" || record.checkpointId !== null)
      fail("PROPOSAL_APPLY_STALE");
    const result = immutable(
      this.ports.readPhysicalResult(capture, originalResult),
      PROPOSAL_APPLY_LIMITS.totalBytes * 6 +
        PROPOSAL_APPLY_LIMITS.checkpointBytes,
    ) as ProposalPhysicalOutcome;
    const r = fields(result, [
      "files",
      "createdParentCount",
      "createdParents",
      "createdParentsComplete",
      "cleanupConfirmed",
      "errorCode",
      "warnings",
    ]);
    if (
      !Array.isArray(r.files) ||
      !Array.isArray(r.createdParents) ||
      !Array.isArray(r.warnings)
    )
      fail();
    const revision = this.ports.getRevision(
      record.workspaceId,
      record.revisionId,
    );
    if (
      !revision ||
      r.files.length !== revision.files.length ||
      validateProposalRevision(revision).sha256 !== record.revisionSha256
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    let total = 0,
      seenUnattempted = false;
    const effectBodies: {
      ref: ProposalEffectBlobReference;
      body: string;
      createdAt: string;
    }[] = [];
    const createdAt = new Date(this.#now()).toISOString();
    const files = r.files.map((raw, i) => {
      const f = fields(raw, [
          "path",
          "attempted",
          "mayHaveChanged",
          "before",
          "beforeSha256",
          "after",
          "afterSha256",
          "observationComplete",
        ]),
        expected = revision.files[i]!;
      if (
        f.path !== expected.path ||
        typeof f.attempted !== "boolean" ||
        typeof f.mayHaveChanged !== "boolean" ||
        typeof f.observationComplete !== "boolean" ||
        (!f.attempted && f.mayHaveChanged) ||
        (seenUnattempted && f.attempted)
      )
        fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
      if (!f.attempted) seenUnattempted = true;
      const before = image(f.before),
        after = image(f.after);
      if (
        f.beforeSha256 !== (before === null ? null : bodyHash(before)) ||
        f.beforeSha256 !== (expected.before?.sha256 ?? null) ||
        (!f.observationComplete &&
          (after !== null || f.afterSha256 !== null)) ||
        (f.observationComplete &&
          f.afterSha256 !== (after === null ? null : bodyHash(after)))
      )
        fail("PROPOSAL_APPLY_HASH_MISMATCH");
      total +=
        (before === null ? 0 : Buffer.byteLength(before)) +
        (after === null ? 0 : Buffer.byteLength(after));
      if (total > PROPOSAL_APPLY_LIMITS.totalBytes)
        fail("PROPOSAL_APPLY_LIMIT");
      let ref: ProposalEffectBlobReference | typeof expected.after = null;
      if (after !== null) {
        if (
          expected.after !== null &&
          f.afterSha256 === expected.after.sha256 &&
          Buffer.byteLength(after) === expected.after.bytes
        )
          ref = expected.after;
        else {
          const unsigned = {
            id: randomUUID(),
            workspaceId: record.workspaceId,
            ownerId: record.id,
            checkpointId: record.id,
            fileIndex: i,
            sha256: bodyHash(after),
            bytes: Buffer.byteLength(after),
            createdAt,
          };
          ref = immutable({
            ...unsigned,
            headerSha256: knowledgeHash(unsigned),
          }) as ProposalEffectBlobReference;
          const { createdAt: _time, ...reference } =
            ref as ProposalEffectBlobReference & { createdAt: string };
          ref = reference;
          effectBodies.push({ ref, body: after, createdAt });
        }
      }
      return Object.freeze({
        path: expected.path,
        attempted: f.attempted,
        mayHaveChanged: f.mayHaveChanged,
        before: expected.before,
        after: ref,
        observationComplete: f.observationComplete,
      });
    });
    const complete = files.every((f) => f.observationComplete),
      partial =
        !complete ||
        files.some(
          (f, i) =>
            !f.attempted ||
            (f.after?.sha256 ?? null) !==
              (revision.files[i]!.after?.sha256 ?? null),
        ) ||
        result.errorCode !== null;
    const checkpoint = validateProposalApplyCheckpoint(
      signed(
        {
          id: record.id,
          workspaceId: record.workspaceId,
          ownerId: record.id,
          revisionId: record.revisionId,
          files,
          createdParentCount: result.createdParentCount,
          createdParents: result.createdParents,
          createdParentsComplete: result.createdParentsComplete,
          complete,
          partial,
          producerCleanupConfirmed: result.cleanupConfirmed,
          errorCode: result.errorCode,
          warnings: result.warnings,
          createdAt,
        },
        PROPOSAL_APPLY_LIMITS.checkpointBytes,
      ),
    );
    return this.#tx(() => {
      const current = this.#owner(capture).record;
      if (
        current.sha256 !== record.sha256 ||
        current.state !== "dispatched" ||
        current.checkpointId !== null
      )
        fail("PROPOSAL_APPLY_STALE");
      this.db
        .prepare(
          "INSERT INTO proposal_apply_checkpoints(id,workspace_id,owner_id,data) VALUES(?,?,?,?)",
        )
        .run(
          checkpoint.id,
          checkpoint.workspaceId,
          checkpoint.ownerId,
          JSON.stringify(checkpoint),
        );
      for (const { ref, body, createdAt } of effectBodies) {
        const header = { ...ref, createdAt };
        this.db
          .prepare(
            "INSERT INTO proposal_effect_blobs(id,workspace_id,owner_id,checkpoint_id,file_index,sha256,bytes,header_sha256,data,content) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            ref.id,
            ref.workspaceId,
            ref.ownerId,
            ref.checkpointId,
            ref.fileIndex,
            ref.sha256,
            ref.bytes,
            ref.headerSha256,
            JSON.stringify(header),
            Buffer.from(body),
          );
      }
      this.#update(current, {
        checkpointId: checkpoint.id,
        checkpointSha256: checkpoint.sha256,
      });
      return checkpoint;
    });
  }
  settle(
    capture: ProposalApplyCapture,
    originalCleanup: object,
  ): ProposalApplyHistory {
    return this.#tx(() => {
      const { record } = this.#owner(capture);
      if (
        record.state !== "dispatched" ||
        record.checkpointId === null ||
        record.guardSha256 === null
      )
        fail("PROPOSAL_APPLY_STALE");
      const checkpoint = this.getCheckpoint(
        record.workspaceId,
        record.checkpointId,
      );
      if (!checkpoint || checkpoint.sha256 !== record.checkpointSha256)
        fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
      const cleanup = fields(
        immutable(this.ports.assertCleanup(capture, originalCleanup)),
        ["confirmed", "guardSha256"],
      );
      if (
        typeof cleanup.confirmed !== "boolean" ||
        cleanup.guardSha256 !== record.guardSha256
      )
        fail("PROPOSAL_APPLY_GUARD_INVALID");
      const confirmed =
          cleanup.confirmed && checkpoint.producerCleanupConfirmed,
        state =
          !confirmed || !checkpoint.complete
            ? "uncertain"
            : checkpoint.partial
              ? "partial"
              : "completed";
      const owner = this.#update(record, {
        state,
        cleanupConfirmed: confirmed,
        errorCode:
          state === "completed"
            ? null
            : (checkpoint.errorCode ??
              (state === "uncertain"
                ? "PROPOSAL_APPLY_UNCERTAIN"
                : "PROPOSAL_APPLY_PARTIAL")),
      });
      const actualHead = this.ports.getHead(
        owner.workspaceId,
        owner.proposalId,
      );
      if (!actualHead || actualHead.sha256 !== owner.beforeHead.sha256)
        fail("PROPOSAL_APPLY_STALE");
      const createdAt = new Date(this.#now()).toISOString(),
        { sha256: _head, ...old } = actualHead;
      const afterHead = validateProposalSet(
        signed({
          ...old,
          headRevision: actualHead.headRevision + 1,
          status: state === "completed" ? "applied" : state,
          updatedAt: createdAt,
          applySettlement: {
            ownerId: owner.id,
            ownerSha256: owner.sha256,
            checkpointId: checkpoint.id,
            checkpointSha256: checkpoint.sha256,
            receiptId: owner.id,
            state,
            cleanupConfirmed: confirmed,
          },
        }),
      );
      const receipt = validateProposalApplyReceipt(
        signed({
          id: owner.id,
          workspaceId: owner.workspaceId,
          ownerId: owner.id,
          requestId: owner.requestId,
          requestSha256: owner.requestSha256,
          revisionId: owner.revisionId,
          revisionSha256: owner.revisionSha256,
          checkpointId: checkpoint.id,
          checkpointSha256: checkpoint.sha256,
          beforeHead: owner.beforeHead,
          afterHead,
          state,
          cleanupConfirmed: confirmed,
          createdAt,
        }),
      );
      this.db
        .prepare(
          "INSERT INTO proposal_apply_receipts(id,workspace_id,owner_id,request_id,request_sha256,data) VALUES(?,?,?,?,?,?)",
        )
        .run(
          receipt.id,
          receipt.workspaceId,
          receipt.ownerId,
          receipt.requestId,
          receipt.requestSha256,
          JSON.stringify(receipt),
        );
      const changed = this.db
        .prepare(
          "UPDATE proposal_heads SET revision=?,data=? WHERE workspace_id=? AND id=? AND revision=? AND data=?",
        )
        .run(
          afterHead.headRevision,
          JSON.stringify(afterHead),
          owner.workspaceId,
          owner.proposalId,
          actualHead.headRevision,
          JSON.stringify(actualHead),
        );
      if (changed.changes !== 1) fail("PROPOSAL_APPLY_STALE");
      return Object.freeze({ owner, checkpoint, receipt });
    });
  }
  cancelPrepared(
    capture: ProposalApplyCapture,
    errorCode = "PROPOSAL_APPLY_CANCELLED",
  ): ProposalApplyOwner {
    return this.#tx(() => {
      const { record } = this.#owner(capture);
      if (
        record.state !== "prepared" ||
        record.guardSha256 !== null ||
        this.ports.getExecutionGuard(record.workspaceId, record.id) !==
          undefined
      )
        fail("PROPOSAL_APPLY_GUARD_PENDING");
      return this.#update(record, {
        state: "cancelled",
        cleanupConfirmed: true,
        errorCode: id(errorCode),
      });
    });
  }
  uncertain(
    capture: ProposalApplyCapture,
    errorCode: string,
  ): ProposalApplyOwner {
    return this.#tx(() => {
      const { record } = this.#owner(capture);
      if (!["prepared", "dispatched"].includes(record.state)) return record;
      return this.#update(record, {
        state: "uncertain",
        cleanupConfirmed: false,
        errorCode: id(errorCode),
      });
    });
  }
  release(capture: ProposalApplyCapture): void {
    if (!this.#owned.has(capture)) return;
    try {
      const record = this.getOwner(capture.workspaceId, capture.ownerId);
      if (
        record &&
        record.runtimeEpoch === this.#epoch &&
        ["prepared", "dispatched"].includes(record.state)
      ) {
        if (
          record.state === "prepared" &&
          record.guardSha256 === null &&
          !this.ports.getExecutionGuard(record.workspaceId, record.id)
        )
          this.cancelPrepared(capture);
        else this.uncertain(capture, "PROPOSAL_APPLY_OWNER_RELEASED");
      }
    } finally {
      this.#owned.delete(capture);
      this.#live.delete(capture);
    }
  }
  recoverInterruptedOwners(): void {
    this.#tx(() => {
      for (const row of this.db
        .prepare(
          "SELECT id,workspace_id FROM proposal_apply_owners WHERE state IN ('prepared','dispatched') ORDER BY id",
        )
        .iterate()) {
        const record = this.getOwner(id(row.workspace_id), id(row.id))!;
        const guard = this.ports.getExecutionGuard(
          record.workspaceId,
          record.id,
        );
        if (
          guard &&
          (validateProposalApplyGuard(guard).ownerId !== record.id ||
            knowledgeHash(guard.binding) !== knowledgeHash(record.binding))
        )
          fail("PROPOSAL_APPLY_GUARD_INVALID");
        const uncertain =
          record.state === "dispatched" ||
          guard !== undefined ||
          record.guardSha256 !== null;
        this.#update(record, {
          state: uncertain ? "uncertain" : "cancelled",
          guardSha256: record.guardSha256 ?? guard?.sha256 ?? null,
          cleanupConfirmed: !uncertain,
          errorCode: uncertain
            ? "PROPOSAL_APPLY_INTERRUPTED"
            : "PROPOSAL_APPLY_NOT_DISPATCHED",
        });
      }
    });
  }
  hasBlocker(workspaceId: string): boolean {
    return hasProposalApplyBlocker(this.db, id(workspaceId));
  }
  previewRecovery(workspaceId: string): ProposalApplyRecoveryPreview {
    id(workspaceId);
    const binding = validateBinding(this.ports.checkBinding(workspaceId)),
      latest = latestDecision(this.db, workspaceId),
      owners = frontier(this.db, workspaceId, this.ports.getExecutionGuard);
    for (const pin of owners) {
      const owner = this.getOwner(workspaceId, pin.id)!;
      if (knowledgeHash(owner.binding) !== knowledgeHash(binding))
        fail("PROPOSAL_APPLY_RECOVERY_BINDING_UNSUPPORTED");
    }
    const value = immutable({
      workspaceId,
      binding,
      revision: latest?.revision ?? 0,
      frontierSha256: knowledgeHash({ workspaceId, owners }),
      owners,
    }) as ProposalApplyRecoveryPreview;
    this.#previews.set(value, {
      fingerprint: knowledgeHash(value),
      phase: latest?.operation === "acknowledge" ? "resume" : "acknowledge",
    });
    return value;
  }
  #decision(
    preview: ProposalApplyRecoveryPreview,
    input: { requestId: string; reason: string; approved: true },
    operation: "acknowledge" | "resume",
  ): ProposalApplyRecoveryDecision {
    const owned = this.#previews.get(preview);
    if (!owned) fail("PROPOSAL_APPLY_RECOVERY_PREVIEW_REQUIRED");
    const r = fields(immutable(input), ["requestId", "reason", "approved"]);
    id(r.requestId);
    if (
      r.approved !== true ||
      typeof r.reason !== "string" ||
      !r.reason ||
      Buffer.byteLength(r.reason) > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(r.reason)
    )
      fail();
    const duplicate = this.db
      .prepare(
        "SELECT id FROM proposal_apply_recovery_decisions WHERE workspace_id=? AND json_extract(data,'$.requestId')=? AND length(CAST(data AS BLOB))<=65536",
      )
      .get(preview.workspaceId, id(r.requestId));
    if (duplicate) {
      const old = validateProposalApplyRecoveryDecision(
        readRow(
          this.db,
          "proposal_apply_recovery_decisions",
          preview.workspaceId,
          id(duplicate.id),
        ),
      );
      if (
        old.operation !== operation ||
        old.reason !== r.reason ||
        old.frontierSha256 !== preview.frontierSha256 ||
        knowledgeHash(old.binding) !== knowledgeHash(preview.binding)
      )
        fail("PROPOSAL_APPLY_REQUEST_CONFLICT");
      return old;
    }
    if (
      owned.phase !== operation ||
      owned.fingerprint !== knowledgeHash(preview)
    )
      fail("PROPOSAL_APPLY_RECOVERY_STALE");
    return this.#tx(() => {
      const current = frontier(
          this.db,
          preview.workspaceId,
          this.ports.getExecutionGuard,
        ),
        latest = latestDecision(this.db, preview.workspaceId);
      if (
        (latest?.revision ?? 0) !== preview.revision ||
        knowledgeHash({ workspaceId: preview.workspaceId, owners: current }) !==
          preview.frontierSha256 ||
        knowledgeHash(
          validateBinding(this.ports.checkBinding(preview.workspaceId)),
        ) !== knowledgeHash(preview.binding) ||
        (operation === "resume" && latest?.operation !== "acknowledge") ||
        (operation === "acknowledge" && latest?.operation === "acknowledge")
      )
        fail("PROPOSAL_APPLY_RECOVERY_STALE");
      if (!current.length) fail("PROPOSAL_APPLY_RECOVERY_NOT_REQUIRED");
      for (const pin of current) {
        const owner = this.getOwner(preview.workspaceId, pin.id)!;
        if (
          owner.state !== "uncertain" ||
          knowledgeHash(owner.binding) !== knowledgeHash(preview.binding)
        )
          fail("PROPOSAL_APPLY_RECOVERY_STALE");
      }
      const result = this.ports.beforeRecoveryDecision?.(
        preview.workspaceId,
        operation,
        preview,
      ) as unknown;
      if (result && typeof result === "object" && "then" in result)
        fail("PROPOSAL_APPLY_TRANSACTION_REQUIRED");
      const decision = validateProposalApplyRecoveryDecision(
        signed({
          id: randomUUID(),
          workspaceId: preview.workspaceId,
          requestId: r.requestId,
          operation,
          revision: preview.revision + 1,
          binding: preview.binding,
          frontierSha256: preview.frontierSha256,
          owners: current,
          reason: r.reason,
          createdAt: new Date(this.#now()).toISOString(),
        }),
      );
      this.db
        .prepare(
          "INSERT INTO proposal_apply_recovery_decisions(id,workspace_id,revision,operation,data) VALUES(?,?,?,?,?)",
        )
        .run(
          decision.id,
          decision.workspaceId,
          decision.revision,
          decision.operation,
          JSON.stringify(decision),
        );
      return decision;
    });
  }
  acknowledge(
    preview: ProposalApplyRecoveryPreview,
    input: { requestId: string; reason: string; approved: true },
  ): ProposalApplyRecoveryDecision {
    return this.#decision(preview, input, "acknowledge");
  }
  resume(
    preview: ProposalApplyRecoveryPreview,
    input: { requestId: string; reason: string; approved: true },
  ): ProposalApplyRecoveryDecision {
    return this.#decision(preview, input, "resume");
  }
}

function validateProposalApplyRecoveryDecision(
  value: unknown,
): ProposalApplyRecoveryDecision {
  const r = fields(immutable(value), [
    "id",
    "workspaceId",
    "requestId",
    "operation",
    "revision",
    "binding",
    "frontierSha256",
    "owners",
    "reason",
    "createdAt",
    "sha256",
  ]);
  id(r.id);
  id(r.workspaceId);
  id(r.requestId);
  utc(r.createdAt);
  if (
    count(r.revision) < 1 ||
    !["acknowledge", "resume"].includes(r.operation as string) ||
    validateBinding(r.binding).workspaceId !== r.workspaceId ||
    typeof r.reason !== "string" ||
    !r.reason ||
    Buffer.byteLength(r.reason) > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(r.reason) ||
    !Array.isArray(r.owners) ||
    !r.owners.length ||
    r.owners.length > PROPOSAL_APPLY_LIMITS.frontierOwners
  )
    fail();
  const ids = new Set<string>();
  for (const pin of r.owners) {
    const p = fields(pin, ["id", "sha256", "checkpointSha256", "guardSha256"]);
    if (ids.has(id(p.id))) fail();
    ids.add(p.id as string);
    digest(p.sha256);
    for (const key of ["checkpointSha256", "guardSha256"])
      if (p[key] !== null) digest(p[key]);
  }
  if (
    digest(r.frontierSha256) !==
    knowledgeHash({ workspaceId: r.workspaceId, owners: r.owners })
  )
    fail("PROPOSAL_APPLY_HASH_MISMATCH");
  checkHash(r);
  return r as unknown as ProposalApplyRecoveryDecision;
}
function latestDecision(
  db: DatabaseSync,
  ws: string,
): ProposalApplyRecoveryDecision | undefined {
  const key = db
    .prepare(
      "SELECT id,revision,operation FROM proposal_apply_recovery_decisions WHERE workspace_id=? ORDER BY revision DESC LIMIT 1",
    )
    .get(ws);
  if (!key) return undefined;
  const value = validateProposalApplyRecoveryDecision(
    readRow(db, "proposal_apply_recovery_decisions", ws, id(key.id)),
  );
  if (value.revision !== key.revision || value.operation !== key.operation)
    fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
  return value;
}
function rawGuard(
  db: DatabaseSync,
  ws: string,
  ownerId: string,
): ProposalApplyGuard | undefined {
  const meta = db
    .prepare(
      "SELECT length(CAST(data AS BLOB)) AS bytes FROM proposal_apply_execution_guards WHERE workspace_id=? AND owner_id=?",
    )
    .get(ws, ownerId);
  if (!meta) return undefined;
  count(meta.bytes, PROPOSAL_APPLY_LIMITS.rowBytes);
  const row = db
    .prepare(
      "SELECT data FROM proposal_apply_execution_guards WHERE workspace_id=? AND owner_id=? AND length(CAST(data AS BLOB))<=65536",
    )
    .get(ws, ownerId);
  if (!row) fail("PROPOSAL_APPLY_GUARD_INVALID");
  return validateProposalApplyGuard(
    decoded(row.data, PROPOSAL_APPLY_LIMITS.rowBytes),
  );
}
type ResumePin = {
  readonly pin: ProposalApplyRecoveryPreview["owners"][number];
  readonly binding: string;
};
function resumePins(db: DatabaseSync, ws: string): Map<string, ResumePin[]> {
  const pins = new Map<string, ResumePin[]>();
  for (const row of db
    .prepare(
      "SELECT id FROM proposal_apply_recovery_decisions WHERE workspace_id=? AND operation='resume' ORDER BY revision",
    )
    .iterate(ws)) {
    const decision = validateProposalApplyRecoveryDecision(
        readRow(db, "proposal_apply_recovery_decisions", ws, id(row.id)),
      ),
      binding = knowledgeHash(decision.binding);
    for (const pin of decision.owners)
      pins.set(pin.id, [...(pins.get(pin.id) ?? []), { pin, binding }]);
  }
  return pins;
}
function resolved(
  db: DatabaseSync,
  owner: ProposalApplyOwner,
  guard: ProposalApplyGuard | undefined,
  pins: ReadonlyMap<string, readonly ResumePin[]>,
  resumable: Map<string, boolean>,
): boolean {
  let open = resumable.get(owner.proposalId);
  if (open === undefined) {
    const head = db
      .prepare(
        "SELECT data,length(CAST(data AS BLOB)) AS bytes FROM proposal_heads WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))<=65536",
      )
      .get(owner.workspaceId, owner.proposalId);
    open =
      !!head &&
      validateProposalSet(decoded(head.data, 65536)).status !== "paused-import";
    resumable.set(owner.proposalId, open);
  }
  if (!open) return false;
  const binding = knowledgeHash(owner.binding);
  return (pins.get(owner.id) ?? []).some(
    ({ pin, binding: pinned }) =>
      pin.sha256 === owner.sha256 &&
      pin.checkpointSha256 === owner.checkpointSha256 &&
      pin.guardSha256 === (guard?.sha256 ?? owner.guardSha256) &&
      pinned === binding,
  );
}
function frontier(
  db: DatabaseSync,
  ws: string,
  getGuard: (ws: string, id: string) => ProposalApplyGuard | undefined = (
    ws,
    key,
  ) => rawGuard(db, ws, key),
): ProposalApplyRecoveryPreview["owners"] {
  const resumed = resumePins(db, ws),
    resumable = new Map<string, boolean>();
  let bytes = 0;
  const pins: ProposalApplyRecoveryPreview["owners"][number][] = [];
  for (const row of db
    .prepare(
      "SELECT id,length(CAST(data AS BLOB)) AS bytes FROM proposal_apply_owners WHERE workspace_id=? AND state IN ('prepared','dispatched','uncertain') ORDER BY id",
    )
    .iterate(ws)) {
    const size = count(row.bytes, PROPOSAL_APPLY_LIMITS.rowBytes),
      owner = validateProposalApplyOwner(
        readRow(db, "proposal_apply_owners", ws, id(row.id)),
      ),
      guard = getGuard(ws, owner.id);
    if (guard) validateProposalApplyGuard(guard);
    if (
      owner.state === "uncertain" &&
      resolved(db, owner, guard, resumed, resumable)
    )
      continue;
    bytes += size;
    if (bytes > PROPOSAL_APPLY_LIMITS.frontierBytes)
      fail("PROPOSAL_APPLY_RECOVERY_LIMIT");
    pins.push({
      id: owner.id,
      sha256: owner.sha256,
      checkpointSha256: owner.checkpointSha256,
      guardSha256: guard?.sha256 ?? owner.guardSha256,
    });
    if (pins.length > PROPOSAL_APPLY_LIMITS.frontierOwners)
      fail("PROPOSAL_APPLY_RECOVERY_LIMIT");
  }
  return immutable(pins);
}
export function hasProposalApplyBlocker(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  id(workspaceId);
  const latest = latestDecision(db, workspaceId);
  return (
    latest?.operation === "acknowledge" || frontier(db, workspaceId).length > 0
  );
}
export function pauseImportedProposalApplies(
  db: DatabaseSync,
  workspaceId: string,
  archiveSha256: string,
): void {
  id(workspaceId);
  digest(archiveSha256);
  if (!db.isTransaction) fail("PROPOSAL_APPLY_TRANSACTION_REQUIRED");
  for (const row of db
    .prepare(
      "SELECT id FROM proposal_apply_owners WHERE workspace_id=? ORDER BY id",
    )
    .iterate(workspaceId)) {
    const owner = validateProposalApplyOwner(
      readRow(db, "proposal_apply_owners", workspaceId, id(row.id)),
    );
    const head = db
      .prepare(
        "SELECT data FROM proposal_heads WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))<=65536",
      )
      .get(workspaceId, owner.proposalId);
    if (!head) fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    const paused = validateProposalSet(decoded(head.data, 65536));
    if (
      paused.status !== "paused-import" ||
      paused.archiveSha256 !== archiveSha256
    )
      fail("PROPOSAL_APPLY_IMPORT_PAUSE_REQUIRED");
  }
}
/** Metadata-first native cross-row graph validation never grants a producer capability. */
export function validateProposalApplyDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  const storage = new ProposalApplyStorage(db, {
    writeTx: (operation) => operation(),
    checkBinding: () => fail(),
    getRevision: (ws, key) => {
      const meta = db
        .prepare(
          "SELECT length(CAST(data AS BLOB)) AS bytes FROM proposal_revisions WHERE workspace_id=? AND id=?",
        )
        .get(ws, key);
      if (!meta) return undefined;
      count(meta.bytes, 262144);
      return validateProposalRevision(
        decoded(
          db
            .prepare(
              "SELECT data FROM proposal_revisions WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))<=262144",
            )
            .get(ws, key)?.data,
          262144,
        ),
      );
    },
    getHead: () => undefined,
    readApprovedCapture: () => fail(),
    assertCurrent: () => fail(),
    readPhysicalResult: () => fail(),
    readExecutionGuard: () => fail(),
    getExecutionGuard: (ws, key) => rawGuard(db, ws, key),
    assertCleanup: () => fail(),
  });
  for (const row of db
    .prepare("SELECT id,workspace_id FROM proposal_apply_owners ORDER BY id")
    .iterate()) {
    check();
    const history = storage.getHistory(id(row.workspace_id), id(row.id))!,
      owner = history.owner,
      revision = storage.ports.getRevision(owner.workspaceId, owner.revisionId);
    if (
      !revision ||
      revision.sha256 !== owner.revisionSha256 ||
      revision.proposalId !== owner.proposalId ||
      revision.sourceManifestSha256 !== owner.sourceManifestSha256 ||
      knowledgeHash(revision.binding) !== knowledgeHash(owner.binding) ||
      revision.files.length > 32 ||
      revision.totalBytes > 4_194_304
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    const guard = rawGuard(db, owner.workspaceId, owner.id);
    if (owner.guardSha256 !== null && guard?.sha256 !== owner.guardSha256)
      fail("PROPOSAL_APPLY_GUARD_INVALID");
    const checkpoint = history.checkpoint;
    if (checkpoint) {
      if (checkpoint.files.length !== revision.files.length)
        fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
      const complete = checkpoint.files.every(
        (file) => file.observationComplete,
      );
      const partial =
        !complete ||
        checkpoint.errorCode !== null ||
        checkpoint.files.some(
          (file, index) =>
            !file.attempted ||
            (file.after?.sha256 ?? null) !==
              (revision.files[index]!.after?.sha256 ?? null),
        );
      let unattempted = false;
      for (const file of checkpoint.files) {
        if (!file.attempted) unattempted = true;
        else if (unattempted) fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
      }
      if (
        checkpoint.complete !== complete ||
        checkpoint.partial !== partial ||
        (owner.state === "completed" &&
          (partial ||
            !complete ||
            !checkpoint.producerCleanupConfirmed ||
            owner.cleanupConfirmed !== true ||
            owner.errorCode !== null)) ||
        (owner.state === "partial" &&
          (!partial ||
            !complete ||
            !checkpoint.producerCleanupConfirmed ||
            owner.cleanupConfirmed !== true))
      )
        fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
      for (const [fileIndex, file] of checkpoint.files.entries()) {
        const original = revision.files[fileIndex]!;
        if (
          file.path !== original.path ||
          knowledgeHash(file.before) !== knowledgeHash(original.before)
        )
          fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
        if (file.after && "ownerId" in file.after) {
          const ref = file.after;
          if (
            ref.ownerId !== owner.id ||
            ref.checkpointId !== checkpoint.id ||
            ref.fileIndex !== fileIndex
          )
            fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
          const meta = db
            .prepare(
              "SELECT workspace_id,owner_id,checkpoint_id,file_index,sha256,bytes,header_sha256,length(CAST(data AS BLOB)) AS data_bytes,length(content) AS content_bytes FROM proposal_effect_blobs WHERE id=?",
            )
            .get(ref.id);
          if (!meta) fail("PROPOSAL_APPLY_BLOB_MISSING");
          count(meta.data_bytes, 65536);
          count(meta.content_bytes, 1_048_576);
          if (
            meta.workspace_id !== owner.workspaceId ||
            meta.owner_id !== owner.id ||
            meta.checkpoint_id !== checkpoint.id ||
            meta.file_index !== fileIndex ||
            meta.sha256 !== ref.sha256 ||
            meta.bytes !== ref.bytes ||
            meta.header_sha256 !== ref.headerSha256 ||
            meta.content_bytes !== ref.bytes
          )
            fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
          const raw = db
            .prepare(
              "SELECT data,content FROM proposal_effect_blobs WHERE id=? AND length(CAST(data AS BLOB))<=65536 AND length(content)<=1048576",
            )
            .get(ref.id)!;
          const header = fields(immutable(decoded(raw.data, 65536)), [
            "id",
            "workspaceId",
            "ownerId",
            "checkpointId",
            "fileIndex",
            "sha256",
            "bytes",
            "headerSha256",
            "createdAt",
          ]);
          const { headerSha256, ...body } = header;
          if (
            knowledgeHash(body) !== headerSha256 ||
            knowledgeHash({ ...ref, createdAt: checkpoint.createdAt }) !==
              knowledgeHash(header) ||
            !(raw.content instanceof Uint8Array) ||
            Buffer.byteLength(Buffer.from(raw.content).toString("utf8")) !==
              ref.bytes ||
            bodyHash(Buffer.from(raw.content).toString("utf8")) !== ref.sha256
          )
            fail("PROPOSAL_APPLY_HASH_MISMATCH");
        } else if (
          file.after &&
          knowledgeHash(file.after) !== knowledgeHash(original.before) &&
          knowledgeHash(file.after) !== knowledgeHash(original.after)
        )
          fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
      }
    }
  }
  for (const row of db
    .prepare(
      "SELECT id,workspace_id,owner_id,checkpoint_id,file_index FROM proposal_effect_blobs ORDER BY id",
    )
    .iterate()) {
    check();
    const checkpoint = storage.getCheckpoint(
      id(row.workspace_id),
      id(row.checkpoint_id),
    );
    const owner = storage.getOwner(id(row.workspace_id), id(row.owner_id));
    const ref = checkpoint?.files[count(row.file_index, 31)]?.after;
    if (
      !owner ||
      !checkpoint ||
      !ref ||
      !("ownerId" in ref) ||
      ref.id !== row.id ||
      ref.ownerId !== owner.id ||
      ref.checkpointId !== checkpoint.id ||
      ref.fileIndex !== row.file_index
    )
      fail("PROPOSAL_APPLY_BLOB_ORPHAN");
  }
  for (const row of db
    .prepare(
      "SELECT id,workspace_id FROM proposal_apply_checkpoints ORDER BY id",
    )
    .iterate()) {
    check();
    if (!storage.getOwner(id(row.workspace_id), id(row.id)))
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    storage.getCheckpoint(id(row.workspace_id), id(row.id));
  }
  for (const row of db
    .prepare("SELECT id,workspace_id FROM proposal_apply_receipts ORDER BY id")
    .iterate()) {
    check();
    if (!storage.getOwner(id(row.workspace_id), id(row.id)))
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    storage.getReceipt(id(row.workspace_id), id(row.id));
  }
  for (const row of db
    .prepare(
      "SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM proposal_heads ORDER BY id",
    )
    .iterate()) {
    check();
    count(row.bytes, 65536);
    const raw = db
      .prepare(
        "SELECT data FROM proposal_heads WHERE id=? AND length(CAST(data AS BLOB))<=65536",
      )
      .get(id(row.id));
    if (!raw) fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    const head = validateProposalSet(decoded(raw.data, 65536));
    if (head.id !== row.id || head.workspaceId !== row.workspace_id)
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    if (head.applySettlement) {
      const history = storage.getHistory(
        head.workspaceId,
        head.applySettlement.ownerId,
      );
      if (
        !history?.receipt ||
        history.owner.proposalId !== head.id ||
        history.owner.revisionId !== head.revisionId ||
        history.receipt.afterHead.applySettlement?.ownerId !==
          head.applySettlement.ownerId
      )
        fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    }
  }
  for (const row of db
    .prepare(
      "SELECT id,workspace_id,revision,operation FROM proposal_apply_recovery_decisions ORDER BY workspace_id,revision",
    )
    .iterate()) {
    check();
    const decision = validateProposalApplyRecoveryDecision(
      readRow(
        db,
        "proposal_apply_recovery_decisions",
        id(row.workspace_id),
        id(row.id),
      ),
    );
    if (
      decision.revision !== row.revision ||
      decision.operation !== row.operation
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    for (const pin of decision.owners) {
      const owner = storage.getOwner(decision.workspaceId, pin.id);
      if (
        !owner ||
        owner.sha256 !== pin.sha256 ||
        owner.state !== "uncertain" ||
        owner.checkpointSha256 !== pin.checkpointSha256 ||
        (rawGuard(db, decision.workspaceId, owner.id)?.sha256 ??
          owner.guardSha256) !== pin.guardSha256
      )
        fail("PROPOSAL_APPLY_RECOVERY_STALE");
    }
  }
}
