import type { DatabaseSync } from "node:sqlite";
import {
  decode,
  KNOWLEDGE_FILE_PUBLICATION_TABLES,
  maxBytes,
  rawRow,
} from "./file-publication-store.js";
import type {
  KnowledgeFileCheckpointRecord,
  KnowledgeFileHead,
  KnowledgeFileObservationRevision,
  KnowledgeFilePublicationArchiveData,
  KnowledgeFilePublicationReceipt,
  KnowledgeFilePublicationRecord,
  KnowledgeFilePublicationTable,
  KnowledgeFileRecoveryAcknowledgment,
  KnowledgeFileWorkspaceBarrier,
} from "./file-publication-types.js";
import {
  candidateMatchesFileTarget,
  isCompletedFileEvidence,
  revokesCompletedPublish,
} from "./file-publication-validation.js";
import type {
  KnowledgeGenerationAttempt,
  KnowledgeGenerationRecord,
} from "./generation-types.js";
import {
  knowledgePublicationProvenance,
  readKnowledgePublicationHistory,
} from "./publication-history.js";
import type {
  KnowledgeCandidate,
  KnowledgeGenerationPlan,
  TrustRevision,
} from "./types.js";
import {
  knowledgeError as filePublicationError,
  knowledgeHash,
  sameKnowledge as equal,
} from "./validation.js";

/** Streaming metadata-first semantic archive validation; no filesystem effect or rebind. */
export function validateKnowledgeFilePublicationDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  let rows = 0,
    bytes = 0;
  const requireRow = <T extends KnowledgeFilePublicationArchiveData>(
    table: KnowledgeFilePublicationTable,
    workspaceId: string,
    recordId: string,
  ): T => {
    check();
    const row = rawRow(db, table, "workspace_id=? AND id=?", [
      workspaceId,
      recordId,
    ]);
    if (!row)
      filePublicationError(
        "KNOWLEDGE_FILE_EVIDENCE_INVALID",
        "Native file relation refers to a missing workspace-scoped record",
      );
    return decode(row, table) as T;
  };
  const historical = <T>(
    table: string,
    workspaceId: string,
    recordId: string,
  ): T => {
    check();
    const metadata = db
      .prepare(
        `SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE workspace_id=? AND id=?`,
      )
      .get(workspaceId, recordId);
    if (
      !metadata ||
      !Number.isSafeInteger(metadata.bytes) ||
      Number(metadata.bytes) < 2 ||
      Number(metadata.bytes) > 65536
    )
      filePublicationError(
        "KNOWLEDGE_FILE_EVIDENCE_INVALID",
        "Historical producer relation is missing or exceeds its original native row cap",
      );
    const row = db
      .prepare(`SELECT data FROM ${table} WHERE workspace_id=? AND id=?`)
      .get(workspaceId, recordId);
    if (
      !row ||
      typeof row.data !== "string" ||
      Buffer.byteLength(row.data) !== metadata.bytes
    )
      filePublicationError(
        "KNOWLEDGE_FILE_RECORD_CHANGED",
        "Historical producer changed during bounded file validation",
      );
    try {
      return JSON.parse(row.data) as T;
    } catch {
      return filePublicationError(
        "KNOWLEDGE_FILE_RECORD_INVALID",
        "Historical native producer contains malformed bounded JSON",
      );
    }
  };
  const requireCompleted = (owner: KnowledgeFilePublicationRecord): void => {
    if (
      owner.state !== "completed" ||
      owner.checkpointId === null ||
      owner.targetRevisionId === null
    )
      filePublicationError(
        "KNOWLEDGE_FILE_EVIDENCE_INVALID",
        "File receipt requires its completed owner",
      );
    const checkpoint = requireRow<KnowledgeFileCheckpointRecord>(
        "knowledge_file_checkpoints",
        owner.workspaceId,
        owner.checkpointId,
      ),
      target = requireRow<KnowledgeFileObservationRevision>(
        "knowledge_file_observations",
        owner.workspaceId,
        owner.targetRevisionId,
      );
    const receiptRow = rawRow(
      db,
      "knowledge_file_publication_receipts",
      "workspace_id=? AND publication_id=?",
      [owner.workspaceId, owner.id],
    );
    if (!receiptRow)
      filePublicationError(
        "KNOWLEDGE_FILE_EVIDENCE_INVALID",
        "Completed file owner has no exact receipt",
      );
    const receipt = decode(
      receiptRow,
      "knowledge_file_publication_receipts",
    ) as KnowledgeFilePublicationReceipt;
    if (!isCompletedFileEvidence(owner, checkpoint, target, receipt))
      filePublicationError(
        "KNOWLEDGE_FILE_EVIDENCE_INVALID",
        "File receipt/checkpoint/target differs from the exact completed native approval",
      );
  };
  for (const table of KNOWLEDGE_FILE_PUBLICATION_TABLES) {
    for (const metadata of db
      .prepare(
        `SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM ${table} ORDER BY id`,
      )
      .iterate()) {
      check();
      const size = Number(metadata.bytes);
      if (
        ++rows > 65536 ||
        !Number.isSafeInteger(size) ||
        size < 2 ||
        size > maxBytes(table) ||
        (bytes += size) > 67108864
      )
        filePublicationError(
          "KNOWLEDGE_FILE_READ_LIMIT",
          "File publication validation exceeds its streaming row/byte cap",
        );
      const workspaceId = String(metadata.workspace_id),
        value = requireRow(table, workspaceId, String(metadata.id));
      if (table === "knowledge_file_observations") {
        const observation = value as KnowledgeFileObservationRevision;
        if (
          !db
            .prepare(
              "SELECT id FROM knowledge_file_heads WHERE workspace_id=? AND path=?",
            )
            .get(workspaceId, observation.path)
        )
          filePublicationError(
            "KNOWLEDGE_FILE_EVIDENCE_INVALID",
            "Native physical observation has no current workspace head",
          );
        if (observation.previousId !== null) {
          const previous = requireRow<KnowledgeFileObservationRevision>(
            table,
            workspaceId,
            observation.previousId,
          );
          if (
            previous.path !== observation.path ||
            previous.revision + 1 !== observation.revision
          )
            filePublicationError(
              "KNOWLEDGE_FILE_EVIDENCE_INVALID",
              "File observation predecessor is not the exact prior monotonic revision",
            );
        }
        if (observation.publicationId !== null) {
          const owner = requireRow<KnowledgeFilePublicationRecord>(
            "knowledge_file_publications",
            workspaceId,
            observation.publicationId,
          );
          if (
            owner.state !== "completed" ||
            owner.targetRevisionId !== observation.id
          )
            filePublicationError(
              "KNOWLEDGE_FILE_EVIDENCE_INVALID",
              "Published observation lacks its exact completed owner",
            );
        }
      } else if (table === "knowledge_file_heads") {
        const head = value as KnowledgeFileHead,
          current = requireRow<KnowledgeFileObservationRevision>(
            "knowledge_file_observations",
            workspaceId,
            head.observationId,
          );
        const latest = db
          .prepare(
            "SELECT id,revision FROM knowledge_file_observations WHERE workspace_id=? AND path=? ORDER BY revision DESC LIMIT 1",
          )
          .get(workspaceId, head.path);
        if (
          current.path !== head.path ||
          current.revision !== head.revision ||
          latest?.id !== current.id
        )
          filePublicationError(
            "KNOWLEDGE_FILE_EVIDENCE_INVALID",
            "File head is not the exact latest monotonic observation",
          );
      } else if (table === "knowledge_file_publications") {
        const owner = value as KnowledgeFilePublicationRecord;
        const history = readKnowledgePublicationHistory(
          {
            getCandidate: (ws, id) =>
              historical<KnowledgeCandidate>("knowledge_candidates", ws, id),
            getPlan: (ws, id) =>
              historical<KnowledgeGenerationPlan>(
                "knowledge_generation_plans",
                ws,
                id,
              ),
            getGeneration: (ws, id) =>
              historical<KnowledgeGenerationRecord>(
                "knowledge_generations",
                ws,
                id,
              ),
            getAttempt: (ws, id) =>
              historical<KnowledgeGenerationAttempt>(
                "knowledge_generation_attempts",
                ws,
                id,
              ),
            getTrustRevision: (ws, id) =>
              historical<TrustRevision>("workspace_trust_revisions", ws, id),
          },
          workspaceId,
          owner.provenance.candidateId,
        );
        if (
          !equal(knowledgePublicationProvenance(history), owner.provenance) ||
          !equal(history.candidate.binding, owner.binding) ||
          history.candidate.target.kind !== "workspace-file" ||
          history.candidate.target.path !== owner.path
        )
          filePublicationError(
            "KNOWLEDGE_FILE_EVIDENCE_INVALID",
            "File owner historical producer pins differ",
          );
        if (
          owner.operation === "publish" &&
          (history.candidate.body !== owner.body ||
            history.candidate.bodySha256 !== owner.bodySha256 ||
            !candidateMatchesFileTarget(
              history.candidate,
              owner.expectedTarget,
            ))
        )
          filePublicationError(
            "KNOWLEDGE_FILE_EVIDENCE_INVALID",
            "File owner candidate differs from its approved preimage/body",
          );
        if (owner.operation === "revoke") {
          const original = requireRow<KnowledgeFilePublicationRecord>(
            "knowledge_file_publications",
            workspaceId,
            owner.existingPublicationId!,
          );
          if (!revokesCompletedPublish(original, owner))
            filePublicationError(
              "KNOWLEDGE_FILE_EVIDENCE_INVALID",
              "Revocation lacks the exact completed active postimage",
            );
        }
        if (owner.state === "completed") requireCompleted(owner);
        else if (
          db
            .prepare(
              "SELECT 1 FROM knowledge_file_publication_receipts WHERE workspace_id=? AND publication_id=?",
            )
            .get(workspaceId, owner.id) ||
          owner.targetRevisionId !== null
        )
          filePublicationError(
            "KNOWLEDGE_FILE_EVIDENCE_INVALID",
            "Incomplete file owner cannot have a successful effect receipt",
          );
      } else if (table === "knowledge_file_checkpoints") {
        const checkpoint = value as KnowledgeFileCheckpointRecord,
          owner = requireRow<KnowledgeFilePublicationRecord>(
            "knowledge_file_publications",
            workspaceId,
            checkpoint.publicationId,
          );
        if (
          owner.checkpointId !== checkpoint.id ||
          !["completed", "uncertain"].includes(owner.state) ||
          !equal(checkpoint.before, owner.expectedTarget.observation) ||
          checkpoint.beforeContent !== owner.beforeContent ||
          checkpoint.cleanupConfirmed !== owner.cleanupConfirmed
        )
          filePublicationError(
            "KNOWLEDGE_FILE_EVIDENCE_INVALID",
            "Effect checkpoint lacks its exact native owner",
          );
      } else if (table === "knowledge_file_publication_receipts")
        requireCompleted(
          requireRow<KnowledgeFilePublicationRecord>(
            "knowledge_file_publications",
            workspaceId,
            (value as KnowledgeFilePublicationReceipt).publicationId,
          ),
        );
      else if (table === "knowledge_file_recovery_acknowledgments") {
        const ack = value as KnowledgeFileRecoveryAcknowledgment;
        for (const pin of ack.ownerHashes) {
          const owner = requireRow<KnowledgeFilePublicationRecord>(
            "knowledge_file_publications",
            workspaceId,
            pin.id,
          );
          if (owner.state !== "uncertain" || owner.sha256 !== pin.sha256)
            filePublicationError(
              "KNOWLEDGE_FILE_EVIDENCE_INVALID",
              "Recovery acknowledgment rewrites or mismatches an original uncertain owner",
            );
        }
        if (
          ack.frontierSha256 !== knowledgeHash(ack.ownerHashes) ||
          (ack.operation === "resume" && ack.ownerHashes.length)
        )
          filePublicationError(
            "KNOWLEDGE_FILE_EVIDENCE_INVALID",
            "Recovery decision frontier is not exact",
          );
      } else {
        const barrier = value as KnowledgeFileWorkspaceBarrier;
        if (barrier.acknowledgmentId !== null) {
          const ack = requireRow<KnowledgeFileRecoveryAcknowledgment>(
            "knowledge_file_recovery_acknowledgments",
            workspaceId,
            barrier.acknowledgmentId,
          );
          if (
            (barrier.state === "pending-resume"
              ? ack.operation !== "acknowledge"
              : barrier.state === "clear"
                ? ack.operation !== "resume"
                : true) ||
            !equal(ack.binding, barrier.binding)
          )
            filePublicationError(
              "KNOWLEDGE_FILE_EVIDENCE_INVALID",
              "Workspace barrier does not describe its exact explicit recovery decision",
            );
        } else if (barrier.state !== "blocked")
          filePublicationError(
            "KNOWLEDGE_FILE_EVIDENCE_INVALID",
            "A resumed workspace requires its original decision receipt",
          );
      }
    }
  }
}
