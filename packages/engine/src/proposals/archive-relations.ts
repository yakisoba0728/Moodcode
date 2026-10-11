import type { DatabaseSync } from "node:sqlite";
import { knowledgeHash } from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";
import {
  PROPOSAL_APPLY_LIMITS,
  assertAttemptedPrefix,
  checkpointShape,
  proposalApplyChecks,
  readApplyCheckpoint,
  readApplyDecision,
  readApplyHistory,
  readApplyOwner,
  readApplyReceipt,
} from "./apply-store.js";
import {
  PROPOSAL_APPLY_GUARD_BYTES,
  PROPOSAL_APPLY_GUARD_TABLE,
  proposalApplyGuardChecks,
  readProposalApplyGuard,
  validateProposalApplyGuard,
} from "./execution-guards.js";
import type { ProposalSourceOperation } from "./source-capture.js";
import {
  PROPOSAL_LIMITS,
  proposalRequestFingerprint,
  proposalStoreChecks,
  readProposalBlob,
  readProposalHead,
  readProposalRevision,
} from "./store.js";

const proposal = proposalStoreChecks;
const {
  id,
  integer: count,
  exact: fields,
  json: immutable,
  decoded,
} = proposalApplyChecks;
const fail: (code?: string) => never = proposalApplyChecks.fail,
  failProposal: (code?: string) => never = proposalStoreChecks.fail,
  failGuard: () => never = proposalApplyGuardChecks.fail;
function scopeMismatch(): never {
  return fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
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
    const r = readProposalRevision(
      db,
      proposal.id(row.workspace_id),
      proposal.id(row.id),
    )!;
    if (r.expectedHeadRevision !== r.revision - 1)
      failProposal("PROPOSAL_SCOPE_MISMATCH");
    if (r.previousId !== null) {
      const previous = readProposalRevision(db, r.workspaceId, r.previousId);
      if (
        !previous ||
        previous.proposalId !== r.proposalId ||
        previous.revision !== r.revision - 1 ||
        knowledgeHash(previous.binding) !== knowledgeHash(r.binding) ||
        Date.parse(previous.createdAt) > Date.parse(r.createdAt)
      )
        failProposal("PROPOSAL_SCOPE_MISMATCH");
    }
    const set = readProposalHead(db, r.workspaceId, r.proposalId);
    if (!set) failProposal("PROPOSAL_HEAD_MISSING");
    const operations: ProposalSourceOperation[] = [];
    for (const file of r.files) {
      check();
      if (file.before !== null) readProposalBlob(db, file.before, r.createdAt);
      const after =
        file.after === null
          ? null
          : readProposalBlob(db, file.after, r.createdAt);
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
      failProposal("PROPOSAL_HASH_MISMATCH");
  }
  for (const row of db
    .prepare("SELECT id,workspace_id FROM proposal_heads ORDER BY id")
    .iterate() as Iterable<{ id: string; workspace_id: string }>) {
    check();
    const h = readProposalHead(
        db,
        proposal.id(row.workspace_id),
        proposal.id(row.id),
      )!,
      r = readProposalRevision(db, h.workspaceId, h.revisionId);
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
      failProposal("PROPOSAL_SCOPE_MISMATCH");
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
    const r = readProposalRevision(
      db,
      proposal.id(row.workspace_id),
      proposal.id(row.revision_id),
    );
    const i = proposal.integer(row.operation_index, PROPOSAL_LIMITS.files - 1);
    if (!r || (row.role !== "before" && row.role !== "after"))
      failProposal("PROPOSAL_SCOPE_MISMATCH");
    const ref = r.files[i]?.[row.role];
    if (!ref || ref.id !== row.id) failProposal("PROPOSAL_BLOB_ORPHAN");
    readProposalBlob(db, ref, r.createdAt);
  }
}
/** Metadata-first native cross-row graph validation. */
export function validateProposalApplyDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  for (const row of db
    .prepare("SELECT id,workspace_id FROM proposal_apply_owners ORDER BY id")
    .iterate()) {
    check();
    const history = readApplyHistory(db, id(row.workspace_id), id(row.id))!,
      owner = history.owner,
      revision = readProposalRevision(
        db,
        owner.workspaceId,
        owner.revisionId,
        scopeMismatch,
      );
    if (
      !revision ||
      revision.sha256 !== owner.revisionSha256 ||
      revision.proposalId !== owner.proposalId ||
      revision.sourceManifestSha256 !== owner.sourceManifestSha256 ||
      knowledgeHash(revision.binding) !== knowledgeHash(owner.binding) ||
      revision.files.length > PROPOSAL_APPLY_LIMITS.files ||
      revision.totalBytes > PROPOSAL_APPLY_LIMITS.totalBytes
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    const guard = readProposalApplyGuard(
      db,
      owner.workspaceId,
      owner.id,
      proposalApplyChecks,
    );
    if (owner.guardSha256 !== null && guard?.sha256 !== owner.guardSha256)
      fail("PROPOSAL_APPLY_GUARD_INVALID");
    const checkpoint = history.checkpoint;
    if (checkpoint) {
      if (checkpoint.files.length !== revision.files.length)
        fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
      const { complete, partial } = checkpointShape(
        checkpoint.files,
        revision.files,
        checkpoint.errorCode,
      );
      assertAttemptedPrefix(checkpoint.files);
      if (
        checkpoint.complete !== complete ||
        checkpoint.partial !== partial ||
        (owner.state === "completed" &&
          (partial || !complete || !checkpoint.producerCleanupConfirmed)) ||
        (owner.state === "partial" &&
          (!partial || !complete || !checkpoint.producerCleanupConfirmed))
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
          count(meta.data_bytes, PROPOSAL_APPLY_LIMITS.rowBytes);
          count(meta.content_bytes, PROPOSAL_APPLY_LIMITS.fileBytes);
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
              "SELECT data,content FROM proposal_effect_blobs WHERE id=? AND length(CAST(data AS BLOB))<=? AND length(content)<=?",
            )
            .get(
              ref.id,
              PROPOSAL_APPLY_LIMITS.rowBytes,
              PROPOSAL_APPLY_LIMITS.fileBytes,
            )!;
          const header = fields(
            immutable(decoded(raw.data, PROPOSAL_APPLY_LIMITS.rowBytes)),
            [
              "id",
              "workspaceId",
              "ownerId",
              "checkpointId",
              "fileIndex",
              "sha256",
              "bytes",
              "headerSha256",
              "createdAt",
            ],
          );
          const { headerSha256, ...body } = header;
          if (
            knowledgeHash(body) !== headerSha256 ||
            knowledgeHash({ ...ref, createdAt: checkpoint.createdAt }) !==
              knowledgeHash(header) ||
            !(raw.content instanceof Uint8Array) ||
            Buffer.byteLength(Buffer.from(raw.content).toString("utf8")) !==
              ref.bytes ||
            sha256Hex(Buffer.from(raw.content).toString("utf8")) !== ref.sha256
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
    const checkpoint = readApplyCheckpoint(
      db,
      id(row.workspace_id),
      id(row.checkpoint_id),
    );
    const owner = readApplyOwner(db, id(row.workspace_id), id(row.owner_id));
    const ref =
      checkpoint?.files[count(row.file_index, PROPOSAL_APPLY_LIMITS.files - 1)]
        ?.after;
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
    if (!readApplyOwner(db, id(row.workspace_id), id(row.id)))
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    readApplyCheckpoint(db, id(row.workspace_id), id(row.id));
  }
  for (const row of db
    .prepare("SELECT id,workspace_id FROM proposal_apply_receipts ORDER BY id")
    .iterate()) {
    check();
    if (!readApplyOwner(db, id(row.workspace_id), id(row.id)))
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    readApplyReceipt(db, id(row.workspace_id), id(row.id));
  }
  for (const row of db
    .prepare("SELECT id,workspace_id FROM proposal_heads ORDER BY id")
    .iterate()) {
    check();
    const head =
      readProposalHead(db, id(row.workspace_id), id(row.id), scopeMismatch) ??
      scopeMismatch();
    if (head.applySettlement) {
      const history = readApplyHistory(
        db,
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
    const decision = readApplyDecision(db, id(row.workspace_id), id(row.id));
    if (
      decision.revision !== row.revision ||
      decision.operation !== row.operation
    )
      fail("PROPOSAL_APPLY_SCOPE_MISMATCH");
    for (const pin of decision.owners) {
      const owner = readApplyOwner(db, decision.workspaceId, pin.id);
      if (
        !owner ||
        owner.sha256 !== pin.sha256 ||
        owner.state !== "uncertain" ||
        owner.checkpointSha256 !== pin.checkpointSha256 ||
        (readProposalApplyGuard(
          db,
          decision.workspaceId,
          owner.id,
          proposalApplyChecks,
        )?.sha256 ?? owner.guardSha256) !== pin.guardSha256
      )
        fail("PROPOSAL_APPLY_RECOVERY_STALE");
    }
  }
}
export function validateProposalApplyExecutionGuards(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  for (const header of db
    .prepare(
      `SELECT id,workspace_id,owner_id,lock_path,marker_owner_pid,marker_updated_at,length(CAST(data AS BLOB)) AS bytes FROM ${PROPOSAL_APPLY_GUARD_TABLE} ORDER BY id`,
    )
    .iterate()) {
    check();
    if (Number(header.bytes) > PROPOSAL_APPLY_GUARD_BYTES) failGuard();
    const guard = validateProposalApplyGuard(
      proposalApplyGuardChecks.decoded(
        db
          .prepare(`SELECT data FROM ${PROPOSAL_APPLY_GUARD_TABLE} WHERE id=?`)
          .get(String(header.id))?.data,
        PROPOSAL_APPLY_GUARD_BYTES,
      ),
    );
    if (
      guard.id !== header.id ||
      guard.workspaceId !== header.workspace_id ||
      guard.ownerId !== header.owner_id ||
      guard.lock.path !== header.lock_path ||
      guard.marker.ownerPid !== header.marker_owner_pid ||
      guard.marker.updatedAt !== header.marker_updated_at
    )
      failGuard();
    const owner = db
      .prepare(
        "SELECT workspace_id,json_extract(data,'$.binding') AS binding FROM proposal_apply_owners WHERE id=?",
      )
      .get(guard.ownerId);
    if (
      !owner ||
      owner.workspace_id !== guard.workspaceId ||
      knowledgeHash(JSON.parse(String(owner.binding))) !==
        knowledgeHash(guard.binding)
    )
      failGuard();
  }
}
