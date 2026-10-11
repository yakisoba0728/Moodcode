import type { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import { KnowledgeFilePublicationStorage } from "./file-publication-store.js";
import { KnowledgeGenerationStorage } from "./generation-store.js";
import { KnowledgeImportRecoveryStorage } from "./import-recovery-store.js";
import type {
  KnowledgeImportRecoveryStoragePorts,
  SeedKnowledgeImportFrontier,
} from "./import-recovery-types.js";
import { KnowledgePublicationStorage } from "./publication-store.js";
import { writeKnowledgeImportPause } from "./store.js";
import type { TrustRevision } from "./types.js";
import {
  knowledgeHash,
  validateBinding,
  validateKnowledgeArchiveRow,
} from "./validation.js";

export type KnowledgeImportOrigin = Pick<
  SeedKnowledgeImportFrontier,
  "importId" | "sourcePrimaryLogicalSha256" | "sourceStorageBindingSha256"
>;
type WorkspaceRead = KnowledgeImportRecoveryStoragePorts["getWorkspace"];

function paused(message: string): never {
  throw new EngineError("KNOWLEDGE_IMPORT_PAUSED", message);
}

/** Pauses an imported workspace's knowledge inside the caller's import transaction without rebinding its original physical trust. */
export function quarantineImportedKnowledge(
  db: DatabaseSync,
  workspaceId: string,
  archiveSha256: string,
  origin: KnowledgeImportOrigin | undefined,
  getWorkspace: WorkspaceRead,
): void {
  if (origin) {
    // Imported runtime capabilities are absent. Persist the ordinary native
    // interrupted-owner transition before pinning recovery; this performs
    // no provider dispatch, target write, marker removal or source rebinding.
    const denied = (): never =>
      paused("Archive quarantine cannot dispatch or approve an effect");
    const base = {
      writeTx: <T>(operation: () => T): T => operation(),
      getWorkspace,
      checkBinding: denied,
    };
    new KnowledgeGenerationStorage(db, {
      ...base,
      getPlan: denied,
      assertPlanCurrent: denied,
    }).recoverInterruptedOwners();
    new KnowledgePublicationStorage(db, {
      ...base,
      getCandidate: denied,
      assertCommitCurrent: denied,
    }).recoverInterruptedOwners();
    const guardHeaders = db
      .prepare(
        "SELECT g.publication_id FROM knowledge_file_execution_guards g JOIN knowledge_file_publications p ON p.workspace_id=g.workspace_id AND p.id=g.publication_id WHERE p.state='prepared' ORDER BY g.id LIMIT 129",
      )
      .all();
    if (guardHeaders.length > 128)
      throw new EngineError(
        "KNOWLEDGE_IMPORT_LIMIT",
        "Imported physical effect guards exceed the native quarantine cap",
      );
    new KnowledgeFilePublicationStorage(db, {
      ...base,
      getCandidate: denied,
      assertCommitCurrent: denied,
    }).recoverInterruptedOwners(
      guardHeaders.map((row) => String(row.publication_id)),
    );
  }
  const pause = writeKnowledgeImportPause(
    db,
    workspaceId,
    archiveSha256,
    new Date().toISOString(),
  );
  if (!origin) return;
  // The physical workspace can be absent at import. Preserve an actual
  // historical root pin when available instead of inventing old inode proof.
  const trustHead = db
    .prepare(
      "SELECT revision_id FROM workspace_trust_heads WHERE workspace_id=?",
    )
    .get(workspaceId);
  const trust = trustHead
    ? db
        .prepare(
          "SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes,substr(data,1,65537) AS data FROM workspace_trust_revisions WHERE id=? AND workspace_id=?",
        )
        .get(String(trustHead.revision_id), workspaceId)
    : undefined;
  if (trust && (Number(trust.bytes) < 1 || Number(trust.bytes) > 65_536))
    throw new EngineError(
      "KNOWLEDGE_IMPORT_LIMIT",
      "Historical workspace binding exceeds the import read cap",
    );
  const raw = trust
    ? (validateKnowledgeArchiveRow({
        table: "workspace_trust_revisions",
        key: trust.id,
        workspaceId,
        data: JSON.parse(String(trust.data)),
      }).data as TrustRevision)
    : undefined;
  const originalBinding = raw ? validateBinding(raw.binding) : null;
  if (
    originalBinding &&
    originalBinding.root !== getWorkspace(workspaceId).root
  )
    throw new EngineError(
      "KNOWLEDGE_IMPORT_BINDING_MISMATCH",
      "Historical workspace root differs from the imported workspace",
    );
  new KnowledgeImportRecoveryStorage(db, {
    writeTx: (operation) => operation(),
    getWorkspace,
    checkBinding: () =>
      paused("Archive seeding grants no physical binding authority"),
    assertCommitCurrent: () =>
      paused("Archive seeding grants no recovery approval"),
  }).seedImport({
    workspaceId,
    archiveSha256,
    ...origin,
    originalBinding,
    pauseSha256: knowledgeHash(pause),
  });
}
