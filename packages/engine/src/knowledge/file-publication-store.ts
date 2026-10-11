import { randomUUID } from "node:crypto";
import {
  isImportedKnowledgeUncertaintyResolved,
  resolvedImportedKnowledgeOwners,
} from "./import-recovery-store.js";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { types } from "node:util";
import { sealRecord, verifySealed } from "../shared/canonical.js";
import {
  guardedWrite,
  type GuardedWriteOptions,
} from "../storage/transaction.js";
import {
  identifier,
  integer,
  knowledgeError as filePublicationError,
  knowledgeHash,
  knowledgeHostRecord,
  sameKnowledge as equal,
  sha256,
  stamp,
  validateBinding,
  validateCandidate,
} from "./validation.js";
import {
  filePublicationJson,
  fileFields,
  fileDigest,
  filePath,
  fileText,
  sameFileHead,
  validateFilePhysicalObservation,
  validateKnowledgeFileTarget,
  validatePrepareKnowledgeFilePublication,
  validateFilePublicationCheckpoint,
  candidateMatchesFileTarget,
  isCompletedFileEvidence,
  revokesCompletedPublish,
  KNOWLEDGE_FILE_PUBLICATION_LIMITS,
  KNOWLEDGE_FILE_REQUEST_FIELDS,
} from "./file-publication-validation.js";
import type { KnowledgeHostBinding } from "./types.js";
import type {
  CompleteKnowledgeFilePublication,
  FilePhysicalObservation,
  FilePublicationCheckpoint,
  KnowledgeFileCheckpointRecord,
  KnowledgeFileHead,
  KnowledgeFileObservationRevision,
  KnowledgeFilePublicationArchiveData,
  KnowledgeFilePublicationArchiveRow,
  KnowledgeFilePublicationCapture,
  KnowledgeFilePublicationCommitResult,
  KnowledgeFilePublicationListOptions,
  KnowledgeFilePublicationPage,
  KnowledgeFilePublicationReceipt,
  KnowledgeFilePublicationRecord,
  KnowledgeFilePublicationStoragePorts,
  KnowledgeFilePublicationTable,
  KnowledgeFileRecoveryAcknowledgment,
  KnowledgeFileRecoveryPreview,
  KnowledgeFileTarget,
  KnowledgeFileWorkspaceBarrier,
  PrepareKnowledgeFilePublication,
  PrepareKnowledgeFilePublicationResult,
  UncertainKnowledgeFilePublication,
} from "./file-publication-types.js";

export const KNOWLEDGE_FILE_PUBLICATION_TABLES = Object.freeze([
  "knowledge_file_observations",
  "knowledge_file_heads",
  "knowledge_file_publications",
  "knowledge_file_checkpoints",
  "knowledge_file_publication_receipts",
  "knowledge_file_recovery_acknowledgments",
  "knowledge_file_workspace_barriers",
] as const);
/** Migration fragment; the authoritative schema version belongs to root storage. */
export const KNOWLEDGE_FILE_PUBLICATION_SCHEMA_SQL = `
CREATE TABLE knowledge_file_observations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,path TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),previous_id TEXT,publication_id TEXT,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(workspace_id,id),UNIQUE(workspace_id,path,revision),FOREIGN KEY(workspace_id,previous_id) REFERENCES knowledge_file_observations(workspace_id,id),FOREIGN KEY(workspace_id,publication_id) REFERENCES knowledge_file_publications(workspace_id,id)) STRICT;
CREATE TABLE knowledge_file_heads(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,path TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),observation_id TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(workspace_id,path),FOREIGN KEY(workspace_id,observation_id) REFERENCES knowledge_file_observations(workspace_id,id)) STRICT;
CREATE TABLE knowledge_file_publications(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,request_id TEXT NOT NULL,path TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('publish','revoke')),candidate_id TEXT NOT NULL,generation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','completed','cancelled','uncertain')),revision INTEGER NOT NULL CHECK(revision>0),data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=1048576),UNIQUE(workspace_id,id),UNIQUE(workspace_id,request_id),FOREIGN KEY(workspace_id,candidate_id) REFERENCES knowledge_candidates(workspace_id,id),FOREIGN KEY(workspace_id,generation_id) REFERENCES knowledge_generations(workspace_id,id)) STRICT;
CREATE TABLE knowledge_file_checkpoints(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,publication_id TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=1048576),UNIQUE(workspace_id,id),UNIQUE(workspace_id,publication_id),FOREIGN KEY(workspace_id,publication_id) REFERENCES knowledge_file_publications(workspace_id,id)) STRICT;
CREATE TABLE knowledge_file_publication_receipts(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,request_id TEXT NOT NULL,publication_id TEXT NOT NULL,checkpoint_id TEXT NOT NULL,target_revision_id TEXT NOT NULL,data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),UNIQUE(workspace_id,id),UNIQUE(workspace_id,request_id),UNIQUE(workspace_id,publication_id),FOREIGN KEY(workspace_id,publication_id) REFERENCES knowledge_file_publications(workspace_id,id),FOREIGN KEY(workspace_id,checkpoint_id) REFERENCES knowledge_file_checkpoints(workspace_id,id),FOREIGN KEY(workspace_id,target_revision_id) REFERENCES knowledge_file_observations(workspace_id,id)) STRICT;
CREATE TABLE knowledge_file_recovery_acknowledgments(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,request_id TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN ('acknowledge','resume')),data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=1048576),UNIQUE(workspace_id,id),UNIQUE(workspace_id,request_id)) STRICT;
CREATE TABLE knowledge_file_workspace_barriers(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>0),state TEXT NOT NULL CHECK(state IN ('blocked','pending-resume','clear')),data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),CHECK(id=workspace_id)) STRICT;
CREATE INDEX knowledge_file_publication_workspace_page ON knowledge_file_publications(workspace_id,id);
CREATE INDEX knowledge_file_publication_active ON knowledge_file_publications(workspace_id,state);
CREATE INDEX knowledge_file_observation_page ON knowledge_file_observations(workspace_id,path,id);
`;

type Row = Record<string, unknown> & {
  id: string;
  workspace_id: string;
  data: string;
};
const id = (prefix: string) => prefix + "_" + randomUUID().replaceAll("-", "");
export const maxBytes = (table: KnowledgeFilePublicationTable) =>
  [
    "knowledge_file_publications",
    "knowledge_file_checkpoints",
    "knowledge_file_recovery_acknowledgments",
  ].includes(table)
    ? KNOWLEDGE_FILE_PUBLICATION_LIMITS.checkpointBytes
    : KNOWLEDGE_FILE_PUBLICATION_LIMITS.rowBytes;
const signed = <T extends object>(value: T): T & { readonly sha256: string } =>
  sealRecord(value, (sealed) =>
    filePublicationJson(
      sealed,
      KNOWLEDGE_FILE_PUBLICATION_LIMITS.checkpointBytes,
    ),
  );
const targetOf = (r: KnowledgeFileObservationRevision): KnowledgeFileTarget =>
  filePublicationJson({
    workspaceId: r.workspaceId,
    path: r.path,
    revision: r.revision,
    observationId: r.id,
    observationSha256: r.observationSha256,
    observation: r.observation,
  });
function recordHash(v: Record<string, unknown>): void {
  fileDigest(v.sha256);
  verifySealed(v, () =>
    filePublicationError(
      "KNOWLEDGE_FILE_HASH_MISMATCH",
      "Native file publication hash differs from its immutable record",
    ),
  );
}
const WRITE: GuardedWriteOptions = {
  join: true,
  innerAsyncCheck: false,
  required: () =>
    filePublicationError(
      "KNOWLEDGE_FILE_TRANSACTION_REQUIRED",
      "Native file publication requires exactly one primary transaction",
    ),
  detached: () =>
    filePublicationError(
      "KNOWLEDGE_FILE_TRANSACTION_REQUIRED",
      "Native file publication cannot detach a transaction",
    ),
};
type FrontierField =
  | "dispatchedAt"
  | "completedAt"
  | "checkpointId"
  | "targetRevisionId"
  | "cleanupConfirmed"
  | "errorCode";
/** Per owner state: null must be null, "set" must be non-null, true must be true, "boolean" must be explicit. */
const FRONTIER: Readonly<
  Record<
    KnowledgeFilePublicationRecord["state"],
    Readonly<Partial<Record<FrontierField, null | "set" | true | "boolean">>>
  >
> = Object.freeze({
  prepared: {
    dispatchedAt: null,
    completedAt: null,
    checkpointId: null,
    targetRevisionId: null,
    cleanupConfirmed: null,
    errorCode: null,
  },
  dispatched: {
    dispatchedAt: "set",
    completedAt: null,
    checkpointId: null,
    targetRevisionId: null,
    cleanupConfirmed: null,
    errorCode: null,
  },
  completed: {
    dispatchedAt: "set",
    completedAt: "set",
    checkpointId: "set",
    targetRevisionId: "set",
    cleanupConfirmed: true,
    errorCode: null,
  },
  cancelled: {
    dispatchedAt: null,
    completedAt: "set",
    checkpointId: null,
    targetRevisionId: null,
    cleanupConfirmed: true,
    errorCode: "set",
  },
  uncertain: {
    completedAt: "set",
    targetRevisionId: null,
    cleanupConfirmed: "boolean",
    errorCode: "set",
  },
});
/** SQL columns that mirror top-level body keys; publication producer ids mirror provenance instead. */
const COLUMNS: Readonly<
  Record<KnowledgeFilePublicationTable, Readonly<Record<string, string>>>
> = Object.freeze({
  knowledge_file_observations: {
    path: "path",
    revision: "revision",
    previous_id: "previousId",
    publication_id: "publicationId",
  },
  knowledge_file_heads: {
    path: "path",
    revision: "revision",
    observation_id: "observationId",
  },
  knowledge_file_publications: {
    request_id: "requestId",
    path: "path",
    operation: "operation",
    state: "state",
    revision: "revision",
  },
  knowledge_file_checkpoints: { publication_id: "publicationId" },
  knowledge_file_publication_receipts: {
    request_id: "requestId",
    publication_id: "publicationId",
    checkpoint_id: "checkpointId",
    target_revision_id: "targetRevisionId",
  },
  knowledge_file_recovery_acknowledgments: {
    request_id: "requestId",
    operation: "operation",
  },
  knowledge_file_workspace_barriers: { revision: "revision", state: "state" },
});
export function validateKnowledgeFilePublicationArchiveRow(
  input: KnowledgeFilePublicationArchiveRow,
): KnowledgeFilePublicationArchiveRow {
  const envelope = filePublicationJson(
    input,
    KNOWLEDGE_FILE_PUBLICATION_LIMITS.checkpointBytes + 4096,
  );
  fileFields(envelope, ["table", "key", "workspaceId", "data"]);
  if (!KNOWLEDGE_FILE_PUBLICATION_TABLES.includes(envelope.table))
    filePublicationError(
      "INVALID_KNOWLEDGE_FILE_TABLE",
      "Unknown native file publication table",
    );
  identifier(envelope.key);
  identifier(envelope.workspaceId);
  const v = envelope.data as unknown as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v))
    filePublicationError(
      "INVALID_KNOWLEDGE_FILE_PUBLICATION",
      "Native file publication row must be an object",
    );
  identifier(v.id);
  identifier(v.workspaceId);
  if (
    v.id !== envelope.key ||
    v.workspaceId !== envelope.workspaceId ||
    Buffer.byteLength(JSON.stringify(v)) > maxBytes(envelope.table)
  )
    filePublicationError(
      "KNOWLEDGE_FILE_SCOPE_MISMATCH",
      "File publication archive scope/size differs",
    );
  recordHash(v);
  switch (envelope.table) {
    case "knowledge_file_publications": {
      fileFields(v, [
        ...KNOWLEDGE_FILE_REQUEST_FIELDS,
        "id",
        "runtimeEpoch",
        "revision",
        "requestSha256",
        "state",
        "createdAt",
        "updatedAt",
        "dispatchedAt",
        "completedAt",
        "checkpointId",
        "targetRevisionId",
        "cleanupConfirmed",
        "errorCode",
        "sha256",
      ]);
      const request = Object.fromEntries(
        KNOWLEDGE_FILE_REQUEST_FIELDS.map((key) => [key, v[key]]),
      );
      validatePrepareKnowledgeFilePublication(request);
      fileDigest(v.requestSha256);
      if (knowledgeHash(request) !== v.requestSha256)
        filePublicationError(
          "KNOWLEDGE_FILE_HASH_MISMATCH",
          "Native file owner original request changed",
        );
      identifier(v.runtimeEpoch);
      if (
        integer(v.revision) < 1 ||
        ![
          "prepared",
          "dispatched",
          "completed",
          "cancelled",
          "uncertain",
        ].includes(String(v.state))
      )
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PUBLICATION",
          "Invalid native file owner state",
        );
      stamp(v.createdAt);
      stamp(v.updatedAt);
      if (Date.parse(v.updatedAt as string) < Date.parse(v.createdAt as string))
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PUBLICATION",
          "File owner timestamps moved backwards",
        );
      for (const name of ["dispatchedAt", "completedAt"] as const)
        if (v[name] !== null) stamp(v[name]);
      for (const name of [
        "checkpointId",
        "targetRevisionId",
        "errorCode",
      ] as const)
        if (v[name] !== null) identifier(v[name]);
      if (![null, true, false].includes(v.cleanupConfirmed as null | boolean))
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PUBLICATION",
          "Native file cleanup must be explicit or unknown",
        );
      for (const [name, rule] of Object.entries(
        FRONTIER[v.state as KnowledgeFilePublicationRecord["state"]],
      ))
        if (
          rule === "set"
            ? v[name] === null
            : rule === "boolean"
              ? typeof v[name] !== "boolean"
              : v[name] !== rule
        )
          filePublicationError(
            "INVALID_KNOWLEDGE_FILE_PUBLICATION",
            "File owner state contradicts its durable frontier",
          );
      break;
    }
    case "knowledge_file_observations": {
      fileFields(v, [
        "id",
        "workspaceId",
        "path",
        "revision",
        "observationId",
        "observationSha256",
        "observation",
        "previousId",
        "publicationId",
        "createdAt",
        "sha256",
      ]);
      validateKnowledgeFileTarget({
        workspaceId: v.workspaceId,
        path: v.path,
        revision: v.revision,
        observationId: v.observationId,
        observationSha256: v.observationSha256,
        observation: v.observation,
      });
      if (
        v.observationId !== v.id ||
        integer(v.revision) < 1 ||
        (v.revision === 1) !== (v.previousId === null)
      )
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PUBLICATION",
          "Observation revision lacks exact predecessor",
        );
      if (v.previousId !== null) identifier(v.previousId);
      if (v.publicationId !== null) identifier(v.publicationId);
      stamp(v.createdAt);
      break;
    }
    case "knowledge_file_heads":
      fileFields(v, [
        "id",
        "workspaceId",
        "path",
        "revision",
        "observationId",
        "sha256",
      ]);
      filePath(v.path);
      if (
        integer(v.revision) < 1 ||
        v.id !== knowledgeHash([v.workspaceId, v.path])
      )
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PUBLICATION",
          "Invalid file observation head",
        );
      identifier(v.observationId);
      break;
    case "knowledge_file_checkpoints": {
      fileFields(v, [
        "id",
        "workspaceId",
        "publicationId",
        "before",
        "after",
        "beforeContent",
        "afterContent",
        "effects",
        "cleanupConfirmed",
        "createdAt",
        "sha256",
      ]);
      identifier(v.publicationId);
      const before = validateFilePhysicalObservation(v.before);
      const after =
        v.after === null ? null : validateFilePhysicalObservation(v.after);
      validateFilePublicationCheckpoint(v.effects);
      stamp(v.createdAt);
      if (
        before.binding.workspaceId !== v.workspaceId ||
        (after &&
          (after.path !== before.path ||
            after.binding.workspaceId !== v.workspaceId)) ||
        typeof v.cleanupConfirmed !== "boolean"
      )
        filePublicationError(
          "KNOWLEDGE_FILE_SCOPE_MISMATCH",
          "Checkpoint owner/physical scope differs",
        );
      if (
        (v.beforeContent !== null &&
          (sha256(
            fileText(
              v.beforeContent,
              KNOWLEDGE_FILE_PUBLICATION_LIMITS.beforeBytes,
            ),
          ) !== before.sha256 ||
            Buffer.byteLength(v.beforeContent as string) !== before.bytes)) ||
        (v.afterContent !== null &&
          (!after ||
            sha256(
              fileText(
                v.afterContent,
                KNOWLEDGE_FILE_PUBLICATION_LIMITS.bodyBytes,
              ),
            ) !== after.sha256 ||
            Buffer.byteLength(v.afterContent as string) !== after.bytes))
      )
        filePublicationError(
          "KNOWLEDGE_FILE_HASH_MISMATCH",
          "Checkpoint text differs from its physical hashes",
        );
      break;
    }
    case "knowledge_file_publication_receipts":
      fileFields(v, [
        "id",
        "workspaceId",
        "requestId",
        "requestSha256",
        "publicationId",
        "checkpointId",
        "targetRevisionId",
        "operation",
        "createdAt",
        "sha256",
      ]);
      for (const key of [
        "requestId",
        "publicationId",
        "checkpointId",
        "targetRevisionId",
      ])
        identifier(v[key]);
      fileDigest(v.requestSha256);
      if (!["publish", "revoke"].includes(String(v.operation)))
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PUBLICATION",
          "Invalid receipt operation",
        );
      stamp(v.createdAt);
      break;
    case "knowledge_file_recovery_acknowledgments":
      fileFields(v, [
        "id",
        "workspaceId",
        "requestId",
        "operation",
        "binding",
        "frontierSha256",
        "ownerIds",
        "ownerHashes",
        "reason",
        "createdAt",
        "sha256",
      ]);
      identifier(v.requestId);
      if (
        !["acknowledge", "resume"].includes(String(v.operation)) ||
        validateBinding(v.binding).workspaceId !== v.workspaceId ||
        !Array.isArray(v.ownerIds) ||
        !Array.isArray(v.ownerHashes) ||
        v.ownerIds.length > KNOWLEDGE_FILE_PUBLICATION_LIMITS.owners ||
        v.ownerIds.length !== v.ownerHashes.length
      )
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PUBLICATION",
          "Invalid file recovery acknowledgment",
        );
      fileDigest(v.frontierSha256);
      fileText(v.reason, KNOWLEDGE_FILE_PUBLICATION_LIMITS.reasonBytes);
      stamp(v.createdAt);
      for (const [index, owner] of v.ownerHashes.entries()) {
        fileFields(owner, ["id", "sha256"]);
        identifier(owner.id);
        fileDigest(owner.sha256);
        if (owner.id !== v.ownerIds[index])
          filePublicationError(
            "INVALID_KNOWLEDGE_FILE_PUBLICATION",
            "Recovery owner IDs/hashes differ",
          );
      }
      break;
    case "knowledge_file_workspace_barriers":
      fileFields(v, [
        "id",
        "workspaceId",
        "revision",
        "state",
        "binding",
        "frontierSha256",
        "acknowledgmentId",
        "updatedAt",
        "sha256",
      ]);
      if (
        v.id !== v.workspaceId ||
        integer(v.revision) < 1 ||
        !["blocked", "pending-resume", "clear"].includes(String(v.state)) ||
        validateBinding(v.binding).workspaceId !== v.workspaceId
      )
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PUBLICATION",
          "Invalid file recovery barrier",
        );
      fileDigest(v.frontierSha256);
      if (v.acknowledgmentId !== null) identifier(v.acknowledgmentId);
      stamp(v.updatedAt);
      break;
  }
  return envelope;
}
export function decode(
  row: Row,
  table: KnowledgeFilePublicationTable,
): KnowledgeFilePublicationArchiveData {
  let data: KnowledgeFilePublicationArchiveData;
  try {
    data = JSON.parse(row.data) as KnowledgeFilePublicationArchiveData;
  } catch {
    return filePublicationError(
      "KNOWLEDGE_FILE_RECORD_INVALID",
      "Native file publication contains malformed bounded JSON",
    );
  }
  const value = validateKnowledgeFilePublicationArchiveRow({
    table,
    key: row.id,
    workspaceId: row.workspace_id,
    data,
  }).data;
  const body = value as unknown as Record<string, unknown>;
  for (const [column, key] of Object.entries(COLUMNS[table]))
    if (Object.hasOwn(row, column) && row[column] !== body[key])
      filePublicationError(
        "KNOWLEDGE_FILE_SCOPE_MISMATCH",
        "File publication SQL metadata disagrees with its body",
      );
  if (table === "knowledge_file_publications") {
    const record = value as KnowledgeFilePublicationRecord;
    if (
      row.candidate_id !== record.provenance.candidateId ||
      row.generation_id !== record.provenance.generationId
    )
      filePublicationError(
        "KNOWLEDGE_FILE_SCOPE_MISMATCH",
        "File owner native producer metadata differs",
      );
  }
  return value;
}

/** Native owner scope is workspace-only; this storage never fabricates a coding Run or Tool. */
export class KnowledgeFilePublicationStorage {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgeFilePublicationStoragePorts;
  readonly #epoch = id("file_epoch");
  readonly #captures = new WeakMap<object, KnowledgeFilePublicationRecord>();
  readonly #live = new Set<object>();
  readonly #previews = new WeakMap<
    object,
    {
      readonly binding: KnowledgeHostBinding;
      readonly frontierSha256: string;
      readonly barrierRevision: number;
    }
  >();
  constructor(db: DatabaseSync, ports: KnowledgeFilePublicationStoragePorts) {
    if (
      !ports ||
      typeof ports !== "object" ||
      types.isProxy(ports) ||
      Reflect.ownKeys(ports).some(
        (key) =>
          typeof key !== "string" ||
          !("value" in Object.getOwnPropertyDescriptor(ports, key)!),
      )
    )
      filePublicationError(
        "INVALID_KNOWLEDGE_FILE_PORTS",
        "File publication ports must be explicit host callbacks",
      );
    for (const name of [
      "writeTx",
      "getWorkspace",
      "checkBinding",
      "getCandidate",
      "assertCommitCurrent",
    ] as const)
      if (typeof ports[name] !== "function")
        filePublicationError(
          "INVALID_KNOWLEDGE_FILE_PORTS",
          "Missing native file publication host callback",
        );
    if (ports.now !== undefined && typeof ports.now !== "function")
      filePublicationError(
        "INVALID_KNOWLEDGE_FILE_PORTS",
        "Invalid native file publication clock",
      );
    if (
      ports.beforeRecoveryDecision !== undefined &&
      typeof ports.beforeRecoveryDecision !== "function"
    )
      filePublicationError(
        "INVALID_KNOWLEDGE_FILE_PORTS",
        "Invalid native recovery decision callback",
      );
    this.#db = db;
    this.#ports = Object.freeze({ ...ports });
  }
  private now(): number {
    const n = this.#ports.now?.() ?? Date.now();
    integer(n, 8_640_000_000_000_000);
    return n;
  }
  private write<T>(operation: () => T): T {
    return guardedWrite(this.#db, this.#ports, operation, WRITE);
  }
  private binding(workspaceId: string): KnowledgeHostBinding {
    identifier(workspaceId);
    const workspace = filePublicationJson(
        this.#ports.getWorkspace(workspaceId),
      ),
      binding = validateBinding(this.#ports.checkBinding(workspaceId));
    if (
      !workspace ||
      typeof workspace !== "object" ||
      workspace.id !== workspaceId ||
      workspace.root !== binding.root ||
      binding.workspaceId !== workspaceId
    )
      filePublicationError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Native file owner workspace binding changed",
      );
    return binding;
  }
  private assertBinding(binding: KnowledgeHostBinding): void {
    if (!equal(this.binding(binding.workspaceId), binding))
      filePublicationError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Native file publication belongs to another physical workspace/storage",
      );
  }
  private row(
    table: KnowledgeFilePublicationTable,
    where: string,
    parameters: readonly SQLInputValue[],
  ): Row | undefined {
    return rawRow(this.#db, table, where, parameters, {
      limit: "File publication body exceeds its bounded metadata read",
      changed: "File publication row changed during bounded read",
    });
  }
  private get<T extends KnowledgeFilePublicationArchiveData>(
    table: KnowledgeFilePublicationTable,
    where: string,
    ...parameters: string[]
  ): T | undefined {
    parameters.forEach(identifier);
    const row = this.row(table, where, parameters);
    return row ? (decode(row, table) as T) : undefined;
  }
  private check(
    table: KnowledgeFilePublicationTable,
    record: KnowledgeFilePublicationArchiveData,
  ): void {
    validateKnowledgeFilePublicationArchiveRow({
      table,
      key: record.id,
      workspaceId: record.workspaceId,
      data: record,
    });
  }
  private insert(
    table: KnowledgeFilePublicationTable,
    record: KnowledgeFilePublicationArchiveData,
    extra: Readonly<Record<string, SQLInputValue>> = {},
  ): void {
    this.check(table, record);
    const body = record as unknown as Record<string, SQLInputValue>,
      columns: Record<string, SQLInputValue> = { ...extra };
    for (const [column, key] of Object.entries(COLUMNS[table]))
      columns[column] = body[key] as SQLInputValue;
    const names = Object.keys(columns);
    this.#db
      .prepare(
        `INSERT INTO ${table}(id,workspace_id,${names.join(",")},data) VALUES(${"?,".repeat(names.length + 2)}?)`,
      )
      .run(
        record.id,
        record.workspaceId,
        ...Object.values(columns),
        JSON.stringify(record),
      );
  }
  getOwner(
    workspaceId: string,
    publicationId: string,
  ): KnowledgeFilePublicationRecord | undefined {
    return this.get(
      "knowledge_file_publications",
      "workspace_id=? AND id=?",
      workspaceId,
      publicationId,
    );
  }
  getReceipt(
    workspaceId: string,
    requestId: string,
  ): KnowledgeFilePublicationReceipt | undefined {
    return this.get(
      "knowledge_file_publication_receipts",
      "workspace_id=? AND request_id=?",
      workspaceId,
      requestId,
    );
  }
  getObservation(
    workspaceId: string,
    observationId: string,
  ): KnowledgeFileObservationRevision | undefined {
    return this.get(
      "knowledge_file_observations",
      "workspace_id=? AND id=?",
      workspaceId,
      observationId,
    );
  }
  getCheckpoint(
    workspaceId: string,
    checkpointId: string,
  ): KnowledgeFileCheckpointRecord | undefined {
    return this.get(
      "knowledge_file_checkpoints",
      "workspace_id=? AND id=?",
      workspaceId,
      checkpointId,
    );
  }
  getCurrentTarget(
    workspaceId: string,
    path: string,
  ): KnowledgeFileTarget | undefined {
    identifier(workspaceId);
    filePath(path);
    const row = this.row("knowledge_file_heads", "workspace_id=? AND path=?", [
      workspaceId,
      path,
    ]);
    if (!row) return undefined;
    const head = decode(row, "knowledge_file_heads") as KnowledgeFileHead;
    const revision = this.getObservation(workspaceId, head.observationId);
    if (
      !revision ||
      revision.revision !== head.revision ||
      revision.path !== path ||
      head.id !== knowledgeHash([workspaceId, path])
    )
      filePublicationError(
        "KNOWLEDGE_FILE_RECORD_CONFLICT",
        "File target head differs from its immutable observation",
      );
    return targetOf(revision);
  }
  private insertObservation(
    binding: KnowledgeHostBinding,
    observation: FilePhysicalObservation,
    current: KnowledgeFileTarget | undefined,
    publicationId: string | null,
  ): KnowledgeFileObservationRevision {
    const observationId = id("file_observation"),
      revision = (current?.revision ?? 0) + 1;
    const row: KnowledgeFileObservationRevision = signed({
      id: observationId,
      workspaceId: binding.workspaceId,
      path: observation.path,
      revision,
      observationId,
      observationSha256: knowledgeHash(observation),
      observation,
      previousId: current?.observationId ?? null,
      publicationId,
      createdAt: new Date(this.now()).toISOString(),
    });
    this.insert("knowledge_file_observations", row);
    const head: KnowledgeFileHead = signed({
      id: knowledgeHash([row.workspaceId, row.path]),
      workspaceId: row.workspaceId,
      path: row.path,
      revision: row.revision,
      observationId: row.id,
    });
    if (current) {
      this.check("knowledge_file_heads", head);
      const saved = this.#db
        .prepare(
          "UPDATE knowledge_file_heads SET revision=?,observation_id=?,data=? WHERE workspace_id=? AND path=? AND revision=? AND observation_id=?",
        )
        .run(
          row.revision,
          row.id,
          JSON.stringify(head),
          row.workspaceId,
          row.path,
          current.revision,
          current.observationId,
        );
      if (Number(saved.changes) !== 1)
        filePublicationError(
          "KNOWLEDGE_FILE_TARGET_STALE",
          "Actual file head changed before its monotonic revision CAS",
        );
    } else this.insert("knowledge_file_heads", head);
    return row;
  }
  captureTarget(
    inputBinding: KnowledgeHostBinding,
    inputObservation: FilePhysicalObservation,
  ): KnowledgeFileTarget {
    const binding = validateBinding(inputBinding),
      observation = validateFilePhysicalObservation(inputObservation);
    if (!equal(binding, observation.binding))
      filePublicationError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Physical observation belongs to another host binding",
      );
    return this.write(() => {
      this.assertBinding(binding);
      const current = this.getCurrentTarget(
        binding.workspaceId,
        observation.path,
      );
      if (current && sameFileHead(current.observation, observation))
        return current;
      // Only a target never observed present and never published can remain zero.
      if (!current && !observation.present)
        return filePublicationJson({
          workspaceId: binding.workspaceId,
          path: observation.path,
          revision: 0,
          observationId: null,
          observationSha256: knowledgeHash(observation),
          observation,
        });
      if (
        this.#db
          .prepare(
            "SELECT 1 FROM knowledge_file_publications WHERE workspace_id=? AND path=? AND state IN ('prepared','dispatched') LIMIT 1",
          )
          .get(binding.workspaceId, observation.path)
      )
        filePublicationError(
          "KNOWLEDGE_FILE_BUSY",
          "File target cannot advance while a publication owns it",
        );
      return targetOf(
        this.insertObservation(binding, observation, current, null),
      );
    });
  }
  findRequest(
    input: PrepareKnowledgeFilePublication,
  ): KnowledgeFilePublicationRecord | undefined {
    const request = validatePrepareKnowledgeFilePublication(input);
    const row = this.row(
      "knowledge_file_publications",
      "workspace_id=? AND request_id=?",
      [request.workspaceId, request.requestId],
    );
    if (!row) return undefined;
    const record = decode(
      row,
      "knowledge_file_publications",
    ) as KnowledgeFilePublicationRecord;
    if (record.requestSha256 !== knowledgeHash(request))
      filePublicationError(
        "KNOWLEDGE_FILE_REQUEST_CONFLICT",
        "Request identity is already bound to another immutable file publication",
      );
    return record;
  }
  private currentTarget(record: PrepareKnowledgeFilePublication): void {
    const current = this.getCurrentTarget(record.workspaceId, record.path);
    if (
      record.expectedTarget.revision === 0
        ? current !== undefined
        : !current || !equal(current, record.expectedTarget)
    )
      filePublicationError(
        "KNOWLEDGE_FILE_TARGET_STALE",
        "Original approved target revision was replaced",
      );
  }
  private candidate(record: PrepareKnowledgeFilePublication): void {
    const candidate = validateCandidate(
      this.#ports.getCandidate(
        record.workspaceId,
        record.provenance.candidateId,
      ),
    );
    if (
      candidate.workspaceId !== record.workspaceId ||
      candidate.sha256 !== record.provenance.candidateSha256 ||
      candidate.generationOwnerId !== record.provenance.generationId ||
      candidate.planId !== record.provenance.planId ||
      candidate.trustRevisionId !== record.provenance.trustRevisionId ||
      !equal(candidate.binding, record.binding) ||
      candidate.target.kind !== "workspace-file" ||
      candidate.target.path !== record.path
    )
      filePublicationError(
        "KNOWLEDGE_FILE_PROVENANCE_CHANGED",
        "File publication lacks its exact original native candidate",
      );
    if (record.operation === "publish") {
      if (
        candidate.body !== record.body ||
        candidate.bodySha256 !== record.bodySha256 ||
        !candidateMatchesFileTarget(candidate, record.expectedTarget)
      )
        filePublicationError(
          "KNOWLEDGE_FILE_TARGET_STALE",
          "Candidate target/body differs from its exact approved preimage",
        );
    } else {
      const previous = this.getOwner(
        record.workspaceId,
        record.existingPublicationId!,
      );
      if (!previous || !revokesCompletedPublish(previous, record))
        filePublicationError(
          "KNOWLEDGE_FILE_TARGET_STALE",
          "Revocation does not remove the exact current completed file publication",
        );
      this.getCommitted(record.workspaceId, previous.id);
    }
  }
  prepare(
    input: PrepareKnowledgeFilePublication,
  ): PrepareKnowledgeFilePublicationResult {
    const request = validatePrepareKnowledgeFilePublication(input),
      existing = this.findRequest(request);
    if (existing) return { kind: "duplicate", record: existing };
    if (this.#live.size >= KNOWLEDGE_FILE_PUBLICATION_LIMITS.owners)
      filePublicationError(
        "KNOWLEDGE_FILE_LIMIT",
        "Release original native file owner captures",
      );
    const result = this.write(
      (): { created: boolean; record: KnowledgeFilePublicationRecord } => {
        const duplicate = this.findRequest(request);
        if (duplicate) return { created: false, record: duplicate };
        this.assertBinding(request.binding);
        this.currentTarget(request);
        this.candidate(request);
        if (this.hasBlocker(request.workspaceId))
          filePublicationError(
            "KNOWLEDGE_FILE_RECOVERY_REQUIRED",
            "Workspace file effects are not settled",
          );
        const now = this.now();
        if (
          now >= request.deadline ||
          now >= Date.parse(request.expiresAt) ||
          request.deadline > now + 30000
        )
          filePublicationError(
            "KNOWLEDGE_FILE_EXPIRED",
            "File publication must preserve its bounded original deadline",
          );
        const time = new Date(now).toISOString();
        const record: KnowledgeFilePublicationRecord = signed({
          ...request,
          id: id("file_publication"),
          runtimeEpoch: this.#epoch,
          revision: 1,
          requestSha256: knowledgeHash(request),
          state: "prepared" as const,
          createdAt: time,
          updatedAt: time,
          dispatchedAt: null,
          completedAt: null,
          checkpointId: null,
          targetRevisionId: null,
          cleanupConfirmed: null,
          errorCode: null,
        });
        this.insert("knowledge_file_publications", record, {
          candidate_id: record.provenance.candidateId,
          generation_id: record.provenance.generationId,
        });
        return { created: true, record };
      },
    );
    if (!result.created) return { kind: "duplicate", record: result.record };
    const capture: KnowledgeFilePublicationCapture = Object.freeze({
      workspaceId: result.record.workspaceId,
      publicationId: result.record.id,
      runtimeEpoch: this.#epoch,
    });
    this.#captures.set(capture, result.record);
    this.#live.add(capture);
    return { kind: "created", record: result.record, capture };
  }
  private owned(
    capture: KnowledgeFilePublicationCapture,
  ): KnowledgeFilePublicationRecord {
    if (
      !capture ||
      typeof capture !== "object" ||
      types.isProxy(capture) ||
      !this.#live.has(capture)
    )
      filePublicationError(
        "KNOWLEDGE_FILE_CAPTURE_INVALID",
        "File publication capture is copied, foreign, released or never issued",
      );
    const issued = this.#captures.get(capture)!;
    const record = this.getOwner(issued.workspaceId, issued.id);
    if (
      !record ||
      record.runtimeEpoch !== this.#epoch ||
      record.sha256 !== issued.sha256
    )
      filePublicationError(
        "KNOWLEDGE_FILE_CAPTURE_STALE",
        "Native file owner changed outside its original capture",
      );
    return record;
  }
  private save(
    previous: KnowledgeFilePublicationRecord,
    next: KnowledgeFilePublicationRecord,
  ): void {
    this.check("knowledge_file_publications", next);
    const written = this.#db
      .prepare(
        "UPDATE knowledge_file_publications SET state=?,revision=?,data=? WHERE workspace_id=? AND id=? AND state=? AND revision=? AND data=?",
      )
      .run(
        next.state,
        next.revision,
        JSON.stringify(next),
        previous.workspaceId,
        previous.id,
        previous.state,
        previous.revision,
        JSON.stringify(previous),
      );
    if (Number(written.changes) !== 1)
      filePublicationError(
        "KNOWLEDGE_FILE_CAPTURE_STALE",
        "Native file publication CAS was replaced",
      );
  }
  private modified(
    previous: KnowledgeFilePublicationRecord,
    patch: Partial<KnowledgeFilePublicationRecord>,
  ): KnowledgeFilePublicationRecord {
    const { sha256: ignored, ...body } = previous;
    return signed({
      ...body,
      ...patch,
      revision: previous.revision + 1,
      updatedAt: new Date(
        Math.max(this.now(), Date.parse(previous.updatedAt)),
      ).toISOString(),
    });
  }
  private expired(r: KnowledgeFilePublicationRecord): boolean {
    const now = this.now();
    return now >= r.deadline || now >= Date.parse(r.expiresAt);
  }
  dispatch(
    capture: KnowledgeFilePublicationCapture,
  ): KnowledgeFilePublicationRecord {
    const record = this.write(() => {
      const current = this.owned(capture);
      if (current.state !== "prepared")
        filePublicationError(
          "KNOWLEDGE_FILE_DISPATCH_INVALID",
          "Only the original prepared owner can dispatch once",
        );
      this.assertBinding(current.binding);
      this.currentTarget(current);
      this.candidate(current);
      if (this.expired(current))
        filePublicationError(
          "KNOWLEDGE_FILE_EXPIRED",
          "Original approved file operation expired",
        );
      if (this.#ports.assertCommitCurrent(current, "dispatch") !== undefined)
        filePublicationError(
          "KNOWLEDGE_FILE_ASYNC_PORT",
          "File currentness must execute in the same primary transaction",
        );
      this.owned(capture);
      this.currentTarget(current);
      this.assertBinding(current.binding);
      if (this.expired(current))
        filePublicationError(
          "KNOWLEDGE_FILE_EXPIRED",
          "File approval expired during validation",
        );
      const next = this.modified(current, {
        state: "dispatched",
        dispatchedAt: new Date(this.now()).toISOString(),
      });
      this.save(current, next);
      return next;
    });
    this.#captures.set(capture, record);
    return record;
  }
  getCommitted(
    workspaceId: string,
    publicationId: string,
  ): KnowledgeFilePublicationCommitResult {
    const publication = this.getOwner(workspaceId, publicationId);
    if (
      !publication ||
      publication.state !== "completed" ||
      !publication.checkpointId ||
      !publication.targetRevisionId
    )
      filePublicationError(
        "KNOWLEDGE_FILE_NOT_COMPLETED",
        "File publication has no completed historical receipt",
      );
    const checkpoint = this.getCheckpoint(
        workspaceId,
        publication.checkpointId,
      ),
      target = this.getObservation(workspaceId, publication.targetRevisionId),
      receipt = this.getReceipt(workspaceId, publication.requestId);
    if (
      !checkpoint ||
      !target ||
      !receipt ||
      !isCompletedFileEvidence(publication, checkpoint, target, receipt)
    )
      filePublicationError(
        "KNOWLEDGE_FILE_EVIDENCE_INVALID",
        "Completed native file receipt/checkpoint/target tuple differs",
      );
    return Object.freeze({ publication, target, checkpoint, receipt });
  }
  complete(
    capture: KnowledgeFilePublicationCapture,
    input: CompleteKnowledgeFilePublication,
  ): KnowledgeFilePublicationCommitResult {
    const v = filePublicationJson(input);
    fileFields(v, ["after", "checkpoint", "cleanup"]);
    const after = validateFilePhysicalObservation(v.after),
      checkpoint = validateFilePublicationCheckpoint(v.checkpoint);
    fileFields(v.cleanup, ["confirmed", "reason"]);
    if (
      v.cleanup.confirmed !== true ||
      checkpoint.partial ||
      (v.cleanup.reason !== null && typeof v.cleanup.reason !== "string")
    )
      filePublicationError(
        "KNOWLEDGE_FILE_CLEANUP_UNCERTAIN",
        "Only exact confirmed physical effects can complete",
      );
    const previous = this.owned(capture);
    if (previous.state === "completed")
      return this.getCommitted(previous.workspaceId, previous.id);
    const result = this.write(() => {
      const record = this.owned(capture);
      if (record.state !== "dispatched")
        filePublicationError(
          "KNOWLEDGE_FILE_COMPLETION_INVALID",
          "Completion requires the original durable dispatch intent",
        );
      if (
        after.path !== record.path ||
        !equal(after.binding, record.binding) ||
        (record.operation === "publish"
          ? !after.present ||
            after.sha256 !== record.bodySha256 ||
            after.bytes !== Buffer.byteLength(record.body!)
          : after.present)
      )
        filePublicationError(
          "KNOWLEDGE_FILE_POSTIMAGE_MISMATCH",
          "Actual postimage differs from the approved exact effect",
        );
      this.assertBinding(record.binding);
      this.currentTarget(record);
      this.candidate(record);
      if (this.#ports.assertCommitCurrent(record, "complete") !== undefined)
        filePublicationError(
          "KNOWLEDGE_FILE_ASYNC_PORT",
          "File completion currentness cannot detach from its SQL transaction",
        );
      this.owned(capture);
      this.currentTarget(record);
      this.assertBinding(record.binding);
      const time = new Date(this.now()).toISOString(),
        saved = this.insertCheckpoint(
          record,
          after,
          record.operation === "publish" ? record.body : null,
          checkpoint,
          true,
          time,
        );
      const target = this.insertObservation(
        record.binding,
        after,
        this.getCurrentTarget(record.workspaceId, record.path),
        record.id,
      );
      const completed = this.modified(record, {
        state: "completed",
        completedAt: time,
        checkpointId: saved.id,
        targetRevisionId: target.id,
        cleanupConfirmed: true,
        errorCode: null,
      });
      this.save(record, completed);
      const receipt: KnowledgeFilePublicationReceipt = signed({
        id: id("file_receipt"),
        workspaceId: record.workspaceId,
        requestId: record.requestId,
        requestSha256: record.requestSha256,
        publicationId: record.id,
        checkpointId: saved.id,
        targetRevisionId: target.id,
        operation: record.operation,
        createdAt: time,
      });
      this.insert("knowledge_file_publication_receipts", receipt);
      return Object.freeze({
        publication: completed,
        target,
        checkpoint: saved,
        receipt,
      });
    });
    this.#captures.set(capture, result.publication);
    return result;
  }
  private insertCheckpoint(
    owner: KnowledgeFilePublicationRecord,
    after: FilePhysicalObservation | null,
    afterContent: string | null,
    effects: FilePublicationCheckpoint,
    cleanupConfirmed: boolean,
    createdAt: string,
  ): KnowledgeFileCheckpointRecord {
    const checkpoint: KnowledgeFileCheckpointRecord = signed({
      id: id("file_checkpoint"),
      workspaceId: owner.workspaceId,
      publicationId: owner.id,
      before: owner.expectedTarget.observation,
      after,
      beforeContent: owner.beforeContent,
      afterContent,
      effects,
      cleanupConfirmed,
      createdAt,
    });
    this.insert("knowledge_file_checkpoints", checkpoint);
    return checkpoint;
  }
  cancel(
    capture: KnowledgeFilePublicationCapture,
    errorCode = "KNOWLEDGE_FILE_CANCELLED_NOT_DISPATCHED",
  ): KnowledgeFilePublicationRecord {
    identifier(errorCode);
    const result = this.write(() => {
      const old = this.owned(capture);
      if (old.state === "cancelled") return old;
      if (old.state !== "prepared")
        filePublicationError(
          "KNOWLEDGE_FILE_DISPATCHED",
          "A dispatched file owner cannot be cancelled as effect-free",
        );
      const next = this.modified(old, {
        state: "cancelled",
        completedAt: new Date(this.now()).toISOString(),
        cleanupConfirmed: true,
        errorCode,
      });
      this.save(old, next);
      return next;
    });
    this.#captures.set(capture, result);
    return result;
  }
  uncertain(
    capture: KnowledgeFilePublicationCapture,
    input: UncertainKnowledgeFilePublication,
  ): KnowledgeFilePublicationRecord {
    const v = filePublicationJson(input);
    fileFields(v, ["errorCode"], ["after", "checkpoint", "cleanupConfirmed"]);
    identifier(v.errorCode);
    if (v.after !== undefined && v.after !== null)
      validateFilePhysicalObservation(v.after);
    if (v.checkpoint !== undefined)
      validateFilePublicationCheckpoint(v.checkpoint);
    if (
      v.cleanupConfirmed !== undefined &&
      typeof v.cleanupConfirmed !== "boolean"
    )
      filePublicationError(
        "INVALID_KNOWLEDGE_FILE_PUBLICATION",
        "Uncertain cleanup must be explicit",
      );
    const result = this.write(() => {
      const old = this.owned(capture);
      if (old.state === "uncertain") return old;
      if (!["prepared", "dispatched"].includes(old.state))
        filePublicationError(
          "KNOWLEDGE_FILE_TERMINAL",
          "Terminal file owner cannot be rewritten",
        );
      let checkpointId: string | null = null;
      if (v.checkpoint !== undefined) {
        const after = v.after ?? null;
        if (
          after &&
          (after.path !== old.path || !equal(after.binding, old.binding))
        )
          filePublicationError(
            "KNOWLEDGE_FILE_SCOPE_MISMATCH",
            "Uncertain observation belongs to another owner",
          );
        checkpointId = this.insertCheckpoint(
          old,
          after,
          null,
          v.checkpoint,
          v.cleanupConfirmed ?? false,
          new Date(this.now()).toISOString(),
        ).id;
      }
      const next = this.modified(old, {
        state: "uncertain",
        completedAt: new Date(this.now()).toISOString(),
        checkpointId,
        cleanupConfirmed: v.cleanupConfirmed ?? false,
        errorCode: v.errorCode,
      });
      this.save(old, next);
      this.block(next.workspaceId, next.binding);
      return next;
    });
    this.#captures.set(capture, result);
    return result;
  }
  release(capture: KnowledgeFilePublicationCapture): void {
    try {
      const owner = this.owned(capture);
      if (owner.state === "prepared") this.cancel(capture);
      else if (owner.state === "dispatched")
        this.uncertain(capture, {
          errorCode: "KNOWLEDGE_FILE_OWNER_RELEASED_UNSETTLED",
          cleanupConfirmed: false,
        });
    } finally {
      this.#captures.delete(capture);
      this.#live.delete(capture);
    }
  }
  private barrier(
    workspaceId: string,
  ): KnowledgeFileWorkspaceBarrier | undefined {
    return this.get(
      "knowledge_file_workspace_barriers",
      "workspace_id=?",
      workspaceId,
    );
  }
  private setBarrier(
    workspaceId: string,
    binding: KnowledgeHostBinding,
    state: KnowledgeFileWorkspaceBarrier["state"],
    frontierSha256: string,
    acknowledgmentId: string | null,
  ): KnowledgeFileWorkspaceBarrier {
    const previous = this.barrier(workspaceId),
      next: KnowledgeFileWorkspaceBarrier = signed({
        id: workspaceId,
        workspaceId,
        revision: (previous?.revision ?? 0) + 1,
        state,
        binding,
        frontierSha256,
        acknowledgmentId,
        updatedAt: new Date(this.now()).toISOString(),
      });
    this.check("knowledge_file_workspace_barriers", next);
    this.#db
      .prepare(
        "INSERT INTO knowledge_file_workspace_barriers(id,workspace_id,revision,state,data) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,data=excluded.data",
      )
      .run(next.id, workspaceId, next.revision, state, JSON.stringify(next));
    return next;
  }
  private block(workspaceId: string, binding: KnowledgeHostBinding): void {
    this.setBarrier(
      workspaceId,
      binding,
      "blocked",
      fileFrontier(this.#db, workspaceId).sha256,
      null,
    );
  }
  hasBlocker(workspaceId: string): boolean {
    identifier(workspaceId);
    return hasKnowledgeFilePublicationBlocker(this.#db, workspaceId);
  }
  recoverInterruptedOwners(unsafePreparedIds: readonly string[] = []): {
    readonly cancelled: number;
    readonly uncertain: number;
  } {
    const unsafe = filePublicationJson(unsafePreparedIds);
    if (
      !Array.isArray(unsafe) ||
      unsafe.length > KNOWLEDGE_FILE_PUBLICATION_LIMITS.owners ||
      new Set(unsafe).size !== unsafe.length
    )
      filePublicationError(
        "INVALID_KNOWLEDGE_FILE_RECOVERY",
        "Unsafe original prepared owner IDs must be bounded/unique",
      );
    unsafe.forEach(identifier);
    let cancelled = 0,
      uncertain = 0;
    let after = "";
    for (;;) {
      const rows = this.#db
        .prepare(
          "SELECT id,workspace_id FROM knowledge_file_publications WHERE state IN ('prepared','dispatched') AND id>? ORDER BY id LIMIT 16",
        )
        .all(after);
      if (!rows.length) break;
      if (cancelled + uncertain + rows.length > 4096)
        filePublicationError(
          "KNOWLEDGE_FILE_RECOVERY_LIMIT",
          "Native file recovery sweep exceeds its bounded owner count",
        );
      this.write(() => {
        for (const row of rows) {
          const old = this.getOwner(String(row.workspace_id), String(row.id));
          if (
            !old ||
            old.runtimeEpoch === this.#epoch ||
            !["prepared", "dispatched"].includes(old.state)
          )
            continue;
          const unknown = old.state === "dispatched" || unsafe.includes(old.id),
            next = this.modified(old, {
              state: unknown ? "uncertain" : "cancelled",
              completedAt: new Date(this.now()).toISOString(),
              cleanupConfirmed: !unknown,
              errorCode: unknown
                ? "KNOWLEDGE_FILE_INTERRUPTED_UNCERTAIN"
                : "KNOWLEDGE_FILE_INTERRUPTED_NOT_DISPATCHED",
            });
          this.save(old, next);
          if (unknown) {
            uncertain++;
            this.block(old.workspaceId, old.binding);
          } else cancelled++;
        }
      });
      after = String(rows.at(-1)!.id);
    }
    return Object.freeze({ cancelled, uncertain });
  }
  listPublications(
    workspaceId: string,
    input: KnowledgeFilePublicationListOptions = {},
  ): KnowledgeFilePublicationPage<KnowledgeFilePublicationRecord> {
    const table = "knowledge_file_publications";
    identifier(workspaceId);
    const options = filePublicationJson(input);
    fileFields(options, [], ["after", "limit", "maxBytes"]);
    const after = options.after === undefined ? "" : identifier(options.after),
      limit = integer(
        options.limit ?? KNOWLEDGE_FILE_PUBLICATION_LIMITS.pageRows,
        KNOWLEDGE_FILE_PUBLICATION_LIMITS.pageRows,
      ),
      cap = integer(
        options.maxBytes ?? KNOWLEDGE_FILE_PUBLICATION_LIMITS.pageBytes,
        KNOWLEDGE_FILE_PUBLICATION_LIMITS.pageBytes,
      );
    if (limit < 1 || cap < 128)
      filePublicationError(
        "KNOWLEDGE_FILE_PAGE_LIMIT",
        "File publication pages require bounded positive row/byte limits",
      );
    if (
      after &&
      !this.#db
        .prepare(`SELECT id FROM ${table} WHERE workspace_id=? AND id=?`)
        .get(workspaceId, after)
    )
      filePublicationError(
        "KNOWLEDGE_FILE_PAGE_CURSOR",
        "Page cursor must belong to this exact workspace",
      );
    const metadata = this.#db
      .prepare(
        `SELECT id,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?`,
      )
      .all(workspaceId, after, limit + 1);
    const items: KnowledgeFilePublicationRecord[] = [];
    let bytes = 0;
    for (const row of metadata.slice(0, limit)) {
      const size = Number(row.bytes);
      if (!Number.isSafeInteger(size) || size < 2 || size > maxBytes(table))
        filePublicationError(
          "KNOWLEDGE_FILE_READ_LIMIT",
          "File publication page row exceeds its native cap",
        );
      if (bytes + size > cap) {
        if (!items.length)
          filePublicationError(
            "KNOWLEDGE_FILE_PAGE_LIMIT",
            "One native record cannot fit the requested whole-record page",
          );
        break;
      }
      const body = this.row(table, "workspace_id=? AND id=?", [
        workspaceId,
        String(row.id),
      ]);
      if (!body)
        filePublicationError(
          "KNOWLEDGE_FILE_RECORD_CHANGED",
          "Selected file publication vanished",
        );
      items.push(decode(body, table) as KnowledgeFilePublicationRecord);
      bytes += size;
    }
    return filePublicationJson(
      {
        items,
        next:
          metadata.length > items.length ? (items.at(-1)?.id ?? null) : null,
        bytes,
      },
      KNOWLEDGE_FILE_PUBLICATION_LIMITS.pageBytes,
    );
  }
  previewRecovery(workspaceId: string): KnowledgeFileRecoveryPreview {
    const binding = this.binding(workspaceId),
      frontier = fileFrontier(this.#db, workspaceId),
      barrier = this.barrier(workspaceId);
    const preview: KnowledgeFileRecoveryPreview = signed({
      workspaceId,
      binding,
      runtimeEpoch: this.#epoch,
      barrierRevision: barrier?.revision ?? 0,
      frontierSha256: frontier.sha256,
      owners: frontier.owners,
    });
    this.#previews.set(preview, {
      binding,
      frontierSha256: preview.frontierSha256,
      barrierRevision: preview.barrierRevision,
    });
    return preview;
  }
  private decision(
    input: {
      readonly workspaceId: string;
      readonly requestId: string;
      readonly approved: true;
      readonly preview: KnowledgeFileRecoveryPreview;
      readonly reason: string;
    },
    operation: "acknowledge" | "resume",
  ): KnowledgeFileRecoveryAcknowledgment {
    const fields = knowledgeHostRecord(
      input,
      ["workspaceId", "requestId", "approved", "preview", "reason"],
      [],
      "INVALID_KNOWLEDGE_FILE_RECOVERY",
      "Recovery needs an original host preview",
      "Recovery input rejects executable or unknown properties",
    );
    const preview = fields.preview as KnowledgeFileRecoveryPreview,
      owned = this.#previews.get(preview);
    if (
      !owned ||
      types.isProxy(preview) ||
      preview.runtimeEpoch !== this.#epoch
    )
      filePublicationError(
        "KNOWLEDGE_FILE_RECOVERY_PREVIEW_INVALID",
        "Recovery preview is copied, foreign or never issued",
      );
    const raw = filePublicationJson({
      workspaceId: fields.workspaceId,
      requestId: fields.requestId,
      approved: fields.approved,
      reason: fields.reason,
    });
    const request = {
      workspaceId: identifier(raw.workspaceId),
      requestId: identifier(raw.requestId),
      approved: raw.approved,
      reason: fileText(
        raw.reason,
        KNOWLEDGE_FILE_PUBLICATION_LIMITS.reasonBytes,
      ),
    };
    if (
      !request.reason.trim() ||
      request.approved !== true ||
      request.workspaceId !== preview.workspaceId
    )
      filePublicationError(
        "INVALID_KNOWLEDGE_FILE_RECOVERY",
        "Explicit exact workspace recovery approval and reason are required",
      );
    return this.write(() => {
      const duplicate = this.row(
        "knowledge_file_recovery_acknowledgments",
        "workspace_id=? AND request_id=?",
        [request.workspaceId, request.requestId],
      );
      if (duplicate) {
        const previous = decode(
          duplicate,
          "knowledge_file_recovery_acknowledgments",
        ) as KnowledgeFileRecoveryAcknowledgment;
        if (
          previous.operation !== operation ||
          previous.frontierSha256 !== preview.frontierSha256 ||
          previous.reason !== request.reason ||
          !equal(previous.binding, preview.binding)
        )
          filePublicationError(
            "KNOWLEDGE_FILE_REQUEST_CONFLICT",
            "Recovery request ID belongs to another exact decision",
          );
        return previous;
      }
      this.assertBinding(owned.binding);
      const frontier = fileFrontier(this.#db, request.workspaceId),
        barrier = this.barrier(request.workspaceId);
      if (
        frontier.sha256 !== owned.frontierSha256 ||
        (barrier?.revision ?? 0) !== owned.barrierRevision
      )
        filePublicationError(
          "KNOWLEDGE_FILE_RECOVERY_STALE",
          "Native file recovery frontier changed after preview",
        );
      if (
        operation === "acknowledge" &&
        (!frontier.owners.length ||
          frontier.owners.some((owner) => owner.state !== "uncertain"))
      )
        filePublicationError(
          "KNOWLEDGE_FILE_RECOVERY_UNSETTLED",
          "Only original uncertain file owners can be acknowledged; active effects remain blocked",
        );
      if (
        operation === "resume" &&
        (!barrier ||
          barrier.state !== "pending-resume" ||
          frontier.owners.length)
      )
        filePublicationError(
          "KNOWLEDGE_FILE_RECOVERY_STALE",
          "Explicit resume requires the acknowledged empty native frontier",
        );
      if (
        this.#ports.beforeRecoveryDecision?.(request.workspaceId, operation) !==
        undefined
      )
        filePublicationError(
          "KNOWLEDGE_FILE_ASYNC_PORT",
          "Recovery decisions require synchronous primary transaction validation",
        );
      this.assertBinding(owned.binding);
      if (
        fileFrontier(this.#db, request.workspaceId).sha256 !==
          frontier.sha256 ||
        (this.barrier(request.workspaceId)?.revision ?? 0) !==
          owned.barrierRevision
      )
        filePublicationError(
          "KNOWLEDGE_FILE_RECOVERY_STALE",
          "Recovery callback changed the original frontier",
        );
      const owners = frontier.owners.map((owner) => ({
        id: owner.id,
        sha256: owner.sha256,
      }));
      const receipt: KnowledgeFileRecoveryAcknowledgment = signed({
        id: id("file_recovery"),
        workspaceId: request.workspaceId,
        requestId: request.requestId,
        operation,
        binding: owned.binding,
        frontierSha256: frontier.sha256,
        ownerIds: owners.map((owner) => owner.id),
        ownerHashes: owners,
        reason: request.reason,
        createdAt: new Date(this.now()).toISOString(),
      });
      this.insert("knowledge_file_recovery_acknowledgments", receipt);
      this.setBarrier(
        request.workspaceId,
        owned.binding,
        operation === "acknowledge" ? "pending-resume" : "clear",
        fileFrontier(this.#db, request.workspaceId).sha256,
        receipt.id,
      );
      return receipt;
    });
  }
  acknowledge(
    input: Parameters<KnowledgeFilePublicationStorage["decision"]>[0],
  ): KnowledgeFileRecoveryAcknowledgment {
    return this.decision(input, "acknowledge");
  }
  resume(
    input: Parameters<KnowledgeFilePublicationStorage["decision"]>[0],
  ): KnowledgeFileRecoveryAcknowledgment {
    return this.decision(input, "resume");
  }
}

export function rawRow(
  db: DatabaseSync,
  table: KnowledgeFilePublicationTable,
  where: string,
  parameters: readonly SQLInputValue[],
  messages = {
    limit: "Native file evidence body exceeds its metadata cap",
    changed: "Native file evidence changed during its bounded read",
  },
): Row | undefined {
  const metadata = db
    .prepare(
      `SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE ${where}`,
    )
    .get(...parameters);
  if (!metadata) return undefined;
  if (
    !Number.isSafeInteger(metadata.bytes) ||
    Number(metadata.bytes) < 2 ||
    Number(metadata.bytes) > maxBytes(table)
  )
    filePublicationError("KNOWLEDGE_FILE_READ_LIMIT", messages.limit);
  const row = db
    .prepare(`SELECT * FROM ${table} WHERE ${where}`)
    .get(...parameters) as Row | undefined;
  if (
    !row ||
    row.id !== metadata.id ||
    row.workspace_id !== metadata.workspace_id ||
    Buffer.byteLength(row.data) !== metadata.bytes
  )
    filePublicationError("KNOWLEDGE_FILE_RECORD_CHANGED", messages.changed);
  return row;
}
const UNRESOLVED_FILE_OWNERS_SQL = `WITH resolved AS MATERIALIZED (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.sha256') AS sha256 FROM json_each(?2))
SELECT f.id,length(CAST(f.data AS BLOB)) AS bytes FROM knowledge_file_publications f WHERE f.workspace_id=?1 AND f.state IN ('prepared','dispatched','uncertain')
 AND NOT (f.state='uncertain' AND EXISTS (SELECT 1 FROM resolved r WHERE r.id=f.id AND r.sha256=CASE WHEN json_valid(f.data) THEN json_extract(f.data,'$.sha256') END)) ORDER BY f.id LIMIT ${KNOWLEDGE_FILE_PUBLICATION_LIMITS.owners + 1}`;
function fileFrontier(
  db: DatabaseSync,
  workspaceId: string,
): {
  readonly owners: readonly KnowledgeFilePublicationRecord[];
  readonly sha256: string;
} {
  identifier(workspaceId);
  const resolved: { readonly id: string; readonly sha256: string }[] = [
    ...resolvedImportedKnowledgeOwners(db, workspaceId, "file"),
  ];
  for (const metadata of db
    .prepare(
      "SELECT id FROM knowledge_file_recovery_acknowledgments WHERE workspace_id=? AND operation='acknowledge' ORDER BY id",
    )
    .iterate(workspaceId)) {
    const row = rawRow(
      db,
      "knowledge_file_recovery_acknowledgments",
      "workspace_id=? AND id=?",
      [workspaceId, String(metadata.id)],
    )!;
    const ack = decode(
      row,
      "knowledge_file_recovery_acknowledgments",
    ) as KnowledgeFileRecoveryAcknowledgment;
    resolved.push(...ack.ownerHashes);
  }
  const rows = db
    .prepare(UNRESOLVED_FILE_OWNERS_SQL)
    .all(workspaceId, JSON.stringify(resolved));
  if (
    rows.length > KNOWLEDGE_FILE_PUBLICATION_LIMITS.owners ||
    rows.reduce((sum, row) => sum + Number(row.bytes), 0) >
      KNOWLEDGE_FILE_PUBLICATION_LIMITS.pageBytes
  )
    filePublicationError(
      "KNOWLEDGE_FILE_RECOVERY_LIMIT",
      "File effect frontier exceeds its original bounded native read",
    );
  const owners: KnowledgeFilePublicationRecord[] = [];
  for (const metadata of rows) {
    const row = rawRow(
      db,
      "knowledge_file_publications",
      "workspace_id=? AND id=?",
      [workspaceId, String(metadata.id)],
    )!;
    const owner = decode(
      row,
      "knowledge_file_publications",
    ) as KnowledgeFilePublicationRecord;
    owners.push(owner);
  }
  return Object.freeze({
    owners: Object.freeze(owners),
    sha256: knowledgeHash(
      owners.map((owner) => ({ id: owner.id, sha256: owner.sha256 })),
    ),
  });
}
export function hasKnowledgeFilePublicationBlocker(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  identifier(workspaceId);
  const barrier = rawRow(
    db,
    "knowledge_file_workspace_barriers",
    "workspace_id=?",
    [workspaceId],
  );
  if (barrier) {
    const value = decode(barrier, "knowledge_file_workspace_barriers") as KnowledgeFileWorkspaceBarrier;
    if (value.state !== "clear" && !isImportedKnowledgeUncertaintyResolved(db, workspaceId, "file-barrier", value.id, value.sha256)) return true;
  }
  return fileFrontier(db, workspaceId).owners.length > 0;
}
