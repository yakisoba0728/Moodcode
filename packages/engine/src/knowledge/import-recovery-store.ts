import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "./types.js";
import {
  immutableKnowledgeJson,
  knowledgeHash,
  validateBinding,
  validateKnowledgeArchiveRow,
} from "./validation.js";
import type {
  KnowledgeImportRecoveryTable,
  KnowledgeImportRecoveryArchiveRow,
  KnowledgeImportRecoveryData,
  KnowledgeImportFrontier,
  KnowledgeImportFrontierHead,
  KnowledgeImportFrontierView,
  KnowledgeImportRecoveryDecision,
  ImportedKnowledgeDocumentActivation,
  ImportedKnowledgeDocumentActivationHead,
  ImportedKnowledgeDocumentProof,
  KnowledgeImportRecoveryPreview,
  PrepareKnowledgeImportRecoveryPreview,
  CommitKnowledgeImportRecovery,
  KnowledgeImportRecoveryCommitResult,
  KnowledgeImportRecoveryStoragePorts,
  SeedKnowledgeImportFrontier,
  KnowledgeImportUncertaintyPin,
  KnowledgeImportUncertaintyKind,
} from "./import-recovery-types.js";

export const KNOWLEDGE_IMPORT_RECOVERY_TABLES: readonly KnowledgeImportRecoveryTable[] =
  Object.freeze([
    "knowledge_import_frontiers",
    "knowledge_import_frontier_heads",
    "knowledge_import_recovery_decisions",
    "knowledge_import_document_activations",
    "knowledge_import_document_activation_heads",
  ]);
export const KNOWLEDGE_IMPORT_RECOVERY_SCHEMA_SQL = `
CREATE TABLE knowledge_import_frontiers (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), import_id TEXT NOT NULL UNIQUE,
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536), UNIQUE(workspace_id,id)
) STRICT;
CREATE TABLE knowledge_import_frontier_heads (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id), frontier_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=0), data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),
 FOREIGN KEY(workspace_id,frontier_id) REFERENCES knowledge_import_frontiers(workspace_id,id)
) STRICT;
CREATE TABLE knowledge_import_recovery_decisions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), frontier_id TEXT NOT NULL,
 request_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('acknowledge','resume','activate','deactivate')),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536), UNIQUE(workspace_id,request_id), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,frontier_id) REFERENCES knowledge_import_frontiers(workspace_id,id)
) STRICT;
CREATE TABLE knowledge_import_document_activations (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), frontier_id TEXT NOT NULL,
 document_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), decision_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','inactive')), data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,document_key,revision),
 FOREIGN KEY(workspace_id,frontier_id) REFERENCES knowledge_import_frontiers(workspace_id,id),
 FOREIGN KEY(workspace_id,decision_id) REFERENCES knowledge_import_recovery_decisions(workspace_id,id)
) STRICT;
CREATE TABLE knowledge_import_document_activation_heads (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), document_key TEXT NOT NULL,
 activation_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536), UNIQUE(workspace_id,document_key),
 FOREIGN KEY(workspace_id,activation_id) REFERENCES knowledge_import_document_activations(workspace_id,id)
) STRICT;
CREATE INDEX knowledge_import_decision_workspace ON knowledge_import_recovery_decisions(workspace_id,id);
CREATE INDEX knowledge_import_activation_workspace ON knowledge_import_document_activations(workspace_id,document_key,revision);
`;

export const KNOWLEDGE_IMPORT_RECOVERY_LIMITS = Object.freeze({
  rowBytes: 65_536,
  frontierBytes: 16_777_216,
  frontierRows: 65_536,
  handles: 128,
  previewMs: 90_000,
  uncertaintyPins: 256,
});
type ObjectData = Record<string, unknown>;
type BeforeRead = (table: KnowledgeImportRecoveryTable, id: string) => void;
function fail(
  code = "INVALID_KNOWLEDGE_IMPORT_RECOVERY",
  message = "Invalid bounded native knowledge import recovery data",
): never {
  throw new EngineError(code, message);
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
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail();
  return value;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail();
  return value as number;
}
function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail();
  return value;
}
function object(value: unknown, keys: readonly string[]): ObjectData {
  const result = immutableKnowledgeJson(value);
  if (!result || typeof result !== "object" || Array.isArray(result)) fail();
  const found = Object.keys(result);
  if (found.length !== keys.length || found.some((key) => !keys.includes(key)))
    fail();
  return result as ObjectData;
}
function hashCheck(value: ObjectData): void {
  const { sha256, ...body } = value;
  if (digest(sha256) !== knowledgeHash(body))
    fail("KNOWLEDGE_IMPORT_RECOVERY_HASH_MISMATCH");
}
function signed<T>(body: T): T & { readonly sha256: string } {
  return immutableKnowledgeJson({ ...body, sha256: knowledgeHash(body) });
}
function same(a: unknown, b: unknown): boolean {
  return knowledgeHash(a) === knowledgeHash(b);
}
function sameRoot(a: KnowledgeHostBinding, b: KnowledgeHostBinding): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.root === b.root &&
    a.rootDevice === b.rootDevice &&
    a.rootInode === b.rootInode
  );
}
function scope(binding: unknown, workspaceId: unknown): KnowledgeHostBinding {
  const actual = validateBinding(binding);
  if (actual.workspaceId !== workspaceId)
    fail("KNOWLEDGE_IMPORT_RECOVERY_SCOPE_MISMATCH");
  return actual;
}
const proofKeys = [
  "documentKey",
  "headRevision",
  "headSha256",
  "documentRevisionId",
  "documentSha256",
  "publicationId",
  "publicationSha256",
  "receiptId",
  "receiptSha256",
  "provenanceSha256",
  "sourceManifestSha256",
  "originalBinding",
  "currentTrustId",
  "currentTrustRevision",
  "currentTrustSha256",
  "expiresAt",
];
function proof(
  value: unknown,
  workspaceId: string,
): ImportedKnowledgeDocumentProof {
  const p = object(value, proofKeys);
  id(p.documentKey);
  if (count(p.headRevision) < 1) fail();
  for (const key of ["documentRevisionId", "publicationId", "receiptId"])
    id(p[key]);
  for (const key of [
    "headSha256",
    "documentSha256",
    "publicationSha256",
    "receiptSha256",
    "provenanceSha256",
    "sourceManifestSha256",
  ])
    digest(p[key]);
  scope(p.originalBinding, workspaceId);
  if (p.currentTrustId === null) {
    if (p.currentTrustRevision !== null || p.currentTrustSha256 !== null)
      fail();
  } else {
    id(p.currentTrustId);
    if (count(p.currentTrustRevision) < 1) fail();
    digest(p.currentTrustSha256);
  }
  if (p.expiresAt !== null) date(p.expiresAt);
  return p as unknown as ImportedKnowledgeDocumentProof;
}
const seedKeys = [
  "workspaceId",
  "importId",
  "archiveSha256",
  "sourcePrimaryLogicalSha256",
  "sourceStorageBindingSha256",
  "originalBinding",
  "pauseSha256",
];
function seed(value: unknown): SeedKnowledgeImportFrontier {
  const s = object(value, seedKeys);
  id(s.workspaceId);
  id(s.importId);
  for (const key of [
    "archiveSha256",
    "sourcePrimaryLogicalSha256",
    "sourceStorageBindingSha256",
    "pauseSha256",
  ])
    digest(s[key]);
  if (s.originalBinding !== null) scope(s.originalBinding, s.workspaceId);
  return s as unknown as SeedKnowledgeImportFrontier;
}
const uncertaintyTables = Object.freeze({
  generation: "knowledge_generations",
  file: "knowledge_file_publications",
  "generation-barrier": "knowledge_generation_workspace_barriers",
  "file-barrier": "knowledge_file_workspace_barriers",
  "generation-attempt": "knowledge_generation_attempts",
  "file-guard": "knowledge_file_execution_guards",
});
function pins(value: unknown): readonly KnowledgeImportUncertaintyPin[] {
  if (
    !Array.isArray(value) ||
    value.length > KNOWLEDGE_IMPORT_RECOVERY_LIMITS.uncertaintyPins
  )
    fail();
  const seen = new Set<string>();
  for (const item of value) {
    const pin = object(item, ["kind", "id", "sha256"]);
    if (
      typeof pin.kind !== "string" ||
      !Object.hasOwn(uncertaintyTables, pin.kind)
    )
      fail();
    id(pin.id);
    digest(pin.sha256);
    const key = `${pin.kind}:${pin.id}`;
    if (seen.has(key)) fail();
    seen.add(key);
  }
  return value as readonly KnowledgeImportUncertaintyPin[];
}
/** Archive validation is pure and does not rebind historical source, trust or effect evidence. */
export function validateKnowledgeImportRecoveryArchiveRow(
  input: KnowledgeImportRecoveryArchiveRow,
): KnowledgeImportRecoveryArchiveRow {
  const row = object(input, ["table", "key", "workspaceId", "data"]);
  if (
    !KNOWLEDGE_IMPORT_RECOVERY_TABLES.includes(
      row.table as KnowledgeImportRecoveryTable,
    )
  )
    fail();
  id(row.key);
  id(row.workspaceId);
  const d = row.data as ObjectData;
  let value: ObjectData;
  switch (row.table) {
    case "knowledge_import_frontiers":
      value = object(d, [
        ...seedKeys,
        "id",
        "nativeFrontierSha256",
        "uncertainties",
        "importedAt",
        "sha256",
      ]);
      seed(Object.fromEntries(seedKeys.map((key) => [key, value[key]])));
      digest(value.nativeFrontierSha256);
      pins(value.uncertainties);
      date(value.importedAt);
      break;
    case "knowledge_import_frontier_heads":
      value = object(d, [
        "id",
        "workspaceId",
        "frontierId",
        "frontierSha256",
        "revision",
        "state",
        "acknowledgeDecisionId",
        "resumeDecisionId",
        "updatedAt",
        "sha256",
      ]);
      id(value.frontierId);
      digest(value.frontierSha256);
      count(value.revision);
      if (value.id !== value.workspaceId)
        fail("KNOWLEDGE_IMPORT_RECOVERY_SCOPE_MISMATCH");
      date(value.updatedAt);
      if (
        !["paused", "acknowledged", "resumed"].includes(value.state as string)
      )
        fail();
      for (const key of ["acknowledgeDecisionId", "resumeDecisionId"])
        if (value[key] !== null) id(value[key]);
      if (
        (value.state === "paused" &&
          (value.revision !== 0 ||
            value.acknowledgeDecisionId !== null ||
            value.resumeDecisionId !== null)) ||
        (value.state === "acknowledged" &&
          (value.acknowledgeDecisionId === null ||
            value.resumeDecisionId !== null)) ||
        (value.state === "resumed" && value.resumeDecisionId === null)
      )
        fail();
      break;
    case "knowledge_import_recovery_decisions":
      value = object(d, [
        "id",
        "workspaceId",
        "requestId",
        "requestSha256",
        "operation",
        "frontierId",
        "frontierSha256",
        "pauseSha256",
        "binding",
        "previewSha256",
        "currentFrontierSha256",
        "uncertaintyPinsSha256",
        "reason",
        "documentProof",
        "activationId",
        "createdAt",
        "sha256",
      ]);
      id(value.requestId);
      id(value.frontierId);
      scope(value.binding, value.workspaceId);
      date(value.createdAt);
      for (const key of [
        "requestSha256",
        "frontierSha256",
        "pauseSha256",
        "previewSha256",
        "currentFrontierSha256",
        "uncertaintyPinsSha256",
      ])
        digest(value[key]);
      reason(value.reason);
      if (
        value.requestSha256 !==
        knowledgeHash({
          previewSha256: value.previewSha256,
          requestId: value.requestId,
          approved: true,
          reason: value.reason,
        })
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_HASH_MISMATCH");
      if (
        !["acknowledge", "resume", "activate", "deactivate"].includes(
          value.operation as string,
        )
      )
        fail();
      if (value.operation === "activate" || value.operation === "deactivate") {
        proof(value.documentProof, String(value.workspaceId));
        id(value.activationId);
      } else if (value.documentProof !== null || value.activationId !== null)
        fail();
      break;
    case "knowledge_import_document_activations":
      value = object(d, [
        "id",
        "workspaceId",
        "documentKey",
        "frontierId",
        "frontierSha256",
        "resumeDecisionSha256",
        "decisionId",
        "binding",
        "revision",
        "previousId",
        "state",
        "proof",
        "createdAt",
        "sha256",
      ]);
      id(value.documentKey);
      id(value.frontierId);
      id(value.decisionId);
      scope(value.binding, value.workspaceId);
      digest(value.frontierSha256);
      digest(value.resumeDecisionSha256);
      date(value.createdAt);
      if (
        count(value.revision) < 1 ||
        (value.revision === 1) !== (value.previousId === null)
      )
        fail();
      if (value.previousId !== null) id(value.previousId);
      if (
        !["active", "inactive"].includes(value.state as string) ||
        proof(value.proof, String(value.workspaceId)).documentKey !==
          value.documentKey
      )
        fail();
      if (
        value.state === "active" &&
        (proof(value.proof, String(value.workspaceId)).currentTrustId ===
          null ||
          proof(value.proof, String(value.workspaceId)).expiresAt === null)
      )
        fail();
      if (
        value.state === "active" &&
        Date.parse(proof(value.proof, String(value.workspaceId)).expiresAt!) <=
          Date.parse(String(value.createdAt))
      )
        fail();
      break;
    case "knowledge_import_document_activation_heads":
      value = object(d, [
        "id",
        "workspaceId",
        "documentKey",
        "revision",
        "activationId",
        "activationSha256",
        "updatedAt",
        "sha256",
      ]);
      id(value.documentKey);
      id(value.activationId);
      if (count(value.revision) < 1) fail();
      digest(value.activationSha256);
      date(value.updatedAt);
      break;
    default:
      return fail();
  }
  if (id(value.id) !== row.key || id(value.workspaceId) !== row.workspaceId)
    fail("KNOWLEDGE_IMPORT_RECOVERY_SCOPE_MISMATCH");
  hashCheck(value);
  return row as unknown as KnowledgeImportRecoveryArchiveRow;
}
function reason(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail();
  return value;
}
function exists(db: DatabaseSync, table: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
    .get(table);
}
function raw(
  db: DatabaseSync,
  table: string,
  key: string,
  workspaceId: string,
  maximum = 65_536,
): { header: Record<string, unknown>; data: string } | undefined {
  if (!exists(db, table)) return undefined;
  const extra: Record<string, string> = {
    knowledge_import_frontiers: "import_id",
    knowledge_import_frontier_heads: "frontier_id,revision",
    knowledge_import_recovery_decisions: "frontier_id,request_id,operation",
    knowledge_import_document_activations:
      "frontier_id,document_key,revision,decision_id,state",
    knowledge_import_document_activation_heads:
      "document_key,activation_id,revision",
  };
  const header = db
    .prepare(
      `SELECT id,workspace_id,${extra[table] ? `${extra[table]},` : ""}length(CAST(data AS BLOB)) AS body_bytes FROM ${table} WHERE id=? AND workspace_id=?`,
    )
    .get(key, workspaceId) as Record<string, unknown> | undefined;
  if (!header) return undefined;
  const bytes = Number(header.body_bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 2 || bytes > maximum)
    fail("KNOWLEDGE_IMPORT_RECOVERY_READ_LIMIT");
  const body = db
    .prepare(
      `SELECT CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data FROM ${table} WHERE id=? AND workspace_id=?`,
    )
    .get(maximum, key, workspaceId);
  if (typeof body?.data !== "string" || Buffer.byteLength(body.data) !== bytes)
    fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
  return { header, data: body.data };
}
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  }
}
function read<T extends KnowledgeImportRecoveryData>(
  db: DatabaseSync,
  table: KnowledgeImportRecoveryTable,
  key: string,
  ws: string,
  beforeRead?: BeforeRead,
): T | undefined {
  beforeRead?.(table, key);
  const row = raw(db, table, key, ws);
  if (!row) return undefined;
  const value = validateKnowledgeImportRecoveryArchiveRow({
    table,
    key,
    workspaceId: ws,
    data: parsed(row.data) as KnowledgeImportRecoveryData,
  }).data;
  const h = row.header;
  if (
    (table === "knowledge_import_frontiers" &&
      h.import_id !== (value as KnowledgeImportFrontier).importId) ||
    (table === "knowledge_import_frontier_heads" &&
      (h.frontier_id !== (value as KnowledgeImportFrontierHead).frontierId ||
        h.revision !== (value as KnowledgeImportFrontierHead).revision)) ||
    (table === "knowledge_import_recovery_decisions" &&
      (h.frontier_id !==
        (value as KnowledgeImportRecoveryDecision).frontierId ||
        h.request_id !== (value as KnowledgeImportRecoveryDecision).requestId ||
        h.operation !==
          (value as KnowledgeImportRecoveryDecision).operation)) ||
    (table === "knowledge_import_document_activations" &&
      (h.frontier_id !==
        (value as ImportedKnowledgeDocumentActivation).frontierId ||
        h.document_key !==
          (value as ImportedKnowledgeDocumentActivation).documentKey ||
        h.revision !==
          (value as ImportedKnowledgeDocumentActivation).revision ||
        h.decision_id !==
          (value as ImportedKnowledgeDocumentActivation).decisionId ||
        h.state !== (value as ImportedKnowledgeDocumentActivation).state)) ||
    (table === "knowledge_import_document_activation_heads" &&
      (h.document_key !==
        (value as ImportedKnowledgeDocumentActivationHead).documentKey ||
        h.activation_id !==
          (value as ImportedKnowledgeDocumentActivationHead).activationId ||
        h.revision !==
          (value as ImportedKnowledgeDocumentActivationHead).revision))
  )
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  return value as T;
}
function pause(
  db: DatabaseSync,
  ws: string,
): { archiveSha256: string; sha256: string } | undefined {
  const row = raw(db, "knowledge_import_pauses", ws, ws);
  if (!row) return undefined;
  const data = validateKnowledgeArchiveRow({
    table: "knowledge_import_pauses",
    key: ws,
    workspaceId: ws,
    data: parsed(row.data) as never,
  }).data as { archiveSha256: string };
  return { archiveSha256: data.archiveSha256, sha256: knowledgeHash(data) };
}
function frontier(
  db: DatabaseSync,
  ws: string,
  beforeRead?: BeforeRead,
): KnowledgeImportFrontierView | undefined {
  const head = read<KnowledgeImportFrontierHead>(
    db,
    "knowledge_import_frontier_heads",
    ws,
    ws,
    beforeRead,
  );
  if (!head) return undefined;
  const f = read<KnowledgeImportFrontier>(
    db,
    "knowledge_import_frontiers",
    head.frontierId,
    ws,
    beforeRead,
  );
  if (!f || f.sha256 !== head.frontierSha256)
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  const p = pause(db, ws);
  if (!p || p.sha256 !== f.pauseSha256 || p.archiveSha256 !== f.archiveSha256)
    fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
  return Object.freeze({ frontier: f, head });
}
function resumeDecision(
  db: DatabaseSync,
  view: KnowledgeImportFrontierView,
  beforeRead?: BeforeRead,
): KnowledgeImportRecoveryDecision | undefined {
  if (view.head.state !== "resumed" || !view.head.resumeDecisionId)
    return undefined;
  const d = read<KnowledgeImportRecoveryDecision>(
    db,
    "knowledge_import_recovery_decisions",
    view.head.resumeDecisionId,
    view.frontier.workspaceId,
    beforeRead,
  );
  if (
    !d ||
    d.operation !== "resume" ||
    d.frontierId !== view.frontier.id ||
    d.frontierSha256 !== view.frontier.sha256 ||
    d.pauseSha256 !== view.frontier.pauseSha256 ||
    d.uncertaintyPinsSha256 !== knowledgeHash(view.frontier.uncertainties)
  )
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  if (view.frontier.uncertainties.length && !view.head.acknowledgeDecisionId)
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  if (view.head.acknowledgeDecisionId) {
    const ack = read<KnowledgeImportRecoveryDecision>(
      db,
      "knowledge_import_recovery_decisions",
      view.head.acknowledgeDecisionId,
      view.frontier.workspaceId,
      beforeRead,
    );
    if (
      !ack ||
      ack.operation !== "acknowledge" ||
      ack.frontierId !== view.frontier.id ||
      ack.frontierSha256 !== view.frontier.sha256 ||
      ack.pauseSha256 !== view.frontier.pauseSha256 ||
      ack.uncertaintyPinsSha256 !== d.uncertaintyPinsSha256 ||
      !same(ack.binding, d.binding) ||
      ack.createdAt > d.createdAt
    )
      fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  }
  return d;
}
function activationHeadId(ws: string, key: string): string {
  return knowledgeHash({ workspaceId: ws, documentKey: key });
}
function currentActivation(
  db: DatabaseSync,
  ws: string,
  key: string,
  beforeRead?: BeforeRead,
): ImportedKnowledgeDocumentActivation | undefined {
  const head = read<ImportedKnowledgeDocumentActivationHead>(
    db,
    "knowledge_import_document_activation_heads",
    activationHeadId(ws, key),
    ws,
    beforeRead,
  );
  if (!head) return undefined;
  const value = read<ImportedKnowledgeDocumentActivation>(
    db,
    "knowledge_import_document_activations",
    head.activationId,
    ws,
    beforeRead,
  );
  if (
    !value ||
    value.documentKey !== key ||
    value.sha256 !== head.activationSha256 ||
    value.revision !== head.revision
  )
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  return value;
}
/** Raw historical pause remains immutable; only an exact current native resume decision permits use. */
export function isKnowledgeImportPaused(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  id(workspaceId);
  if (!pause(db, workspaceId)) return false;
  const view = frontier(db, workspaceId);
  return !view || !resumeDecision(db, view);
}
export function readActiveKnowledgeImportActivation(
  db: DatabaseSync,
  workspaceId: string,
  documentKey: string,
  beforeRead?: BeforeRead,
): ImportedKnowledgeDocumentActivation | undefined {
  id(workspaceId);
  id(documentKey);
  const view = frontier(db, workspaceId, beforeRead);
  if (!view) return undefined;
  const resumed = resumeDecision(db, view, beforeRead);
  if (!resumed) return undefined;
  const active = currentActivation(db, workspaceId, documentKey, beforeRead);
  if (
    !active ||
    active.state !== "active" ||
    active.frontierId !== view.frontier.id ||
    active.frontierSha256 !== view.frontier.sha256 ||
    active.resumeDecisionSha256 !== resumed.sha256 ||
    !same(active.binding, resumed.binding)
  )
    return undefined;
  const decision = read<KnowledgeImportRecoveryDecision>(
    db,
    "knowledge_import_recovery_decisions",
    active.decisionId,
    workspaceId,
    beforeRead,
  );
  if (
    !decision ||
    decision.operation !== "activate" ||
    decision.activationId !== active.id ||
    decision.frontierId !== active.frontierId ||
    decision.frontierSha256 !== active.frontierSha256 ||
    !same(decision.binding, active.binding) ||
    !same(decision.documentProof, active.proof) ||
    decision.createdAt !== active.createdAt
  )
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  return active;
}
function originalPinCurrent(
  db: DatabaseSync,
  ws: string,
  pin: KnowledgeImportUncertaintyPin,
): boolean {
  const row = raw(
    db,
    uncertaintyTables[pin.kind],
    pin.id,
    ws,
    pin.kind === "file" ? 1_048_576 : 65_536,
  );
  if (!row) return false;
  const data = parsed(row.data) as ObjectData;
  if (
    !data ||
    typeof data !== "object" ||
    data.workspaceId !== ws ||
    (data.id ??
      (pin.kind === "generation-barrier" ? data.workspaceId : undefined)) !==
      pin.id
  )
    return false;
  const { sha256, ...body } = data;
  if (typeof sha256 !== "string" || knowledgeHash(body) !== sha256)
    return false;
  return (
    sha256 === pin.sha256 &&
    (pin.kind.endsWith("barrier")
      ? data.state !== "clear"
      : pin.kind === "file-guard"
        ? true
        : data.state === "uncertain")
  );
}
function acknowledgedImportPins(
  db: DatabaseSync,
  workspaceId: string,
): readonly KnowledgeImportUncertaintyPin[] | undefined {
  const view = frontier(db, workspaceId);
  if (!view || !resumeDecision(db, view) || !view.head.acknowledgeDecisionId)
    return undefined;
  const ack = read<KnowledgeImportRecoveryDecision>(
    db,
    "knowledge_import_recovery_decisions",
    view.head.acknowledgeDecisionId,
    workspaceId,
  );
  if (
    !ack ||
    ack.operation !== "acknowledge" ||
    ack.frontierId !== view.frontier.id ||
    ack.frontierSha256 !== view.frontier.sha256 ||
    ack.uncertaintyPinsSha256 !== knowledgeHash(view.frontier.uncertainties)
  )
    return undefined;
  return view.frontier.uncertainties;
}
/** Only unchanged originally imported uncertainty is resolved; later owners are never covered. */
export function isImportedKnowledgeUncertaintyResolved(
  db: DatabaseSync,
  workspaceId: string,
  kind: KnowledgeImportUncertaintyKind,
  ownerId: string,
  sha256: string,
): boolean {
  id(workspaceId);
  id(ownerId);
  digest(sha256);
  if (!Object.hasOwn(uncertaintyTables, kind)) fail();
  const pins = acknowledgedImportPins(db, workspaceId);
  return (
    !!pins?.some(
      (p) => p.kind === kind && p.id === ownerId && p.sha256 === sha256,
    ) &&
    pins
      .filter(
        (p) =>
          !p.kind.endsWith("barrier") || (p.kind === kind && p.id === ownerId),
      )
      .every((p) => originalPinCurrent(db, workspaceId, p))
  );
}
/** The owner pins of one kind that isImportedKnowledgeUncertaintyResolved accepts, read once per frontier. */
export function resolvedImportedKnowledgeOwners(
  db: DatabaseSync,
  workspaceId: string,
  kind: "generation" | "file",
): readonly KnowledgeImportUncertaintyPin[] {
  id(workspaceId);
  const pins = acknowledgedImportPins(db, workspaceId) ?? [],
    owners = pins.filter((p) => p.kind === kind);
  return owners.length &&
    pins
      .filter((p) => !p.kind.endsWith("barrier"))
      .every((p) => originalPinCurrent(db, workspaceId, p))
    ? owners
    : [];
}

const historicalTables = Object.freeze([
  "workspace_trust_revisions",
  "workspace_trust_heads",
  "knowledge_generation_plans",
  "knowledge_candidates",
  "knowledge_request_receipts",
  "knowledge_import_pauses",
  "knowledge_generations",
  "knowledge_generation_attempts",
  "knowledge_generation_recovery_acknowledgments",
  "knowledge_generation_workspace_barriers",
  "workspace_document_revisions",
  "workspace_document_heads",
  "knowledge_publications",
  "knowledge_publication_receipts",
  "knowledge_file_observations",
  "knowledge_file_heads",
  "knowledge_file_publications",
  "knowledge_file_checkpoints",
  "knowledge_file_publication_receipts",
  "knowledge_file_recovery_acknowledgments",
  "knowledge_file_workspace_barriers",
  "knowledge_file_execution_guards",
]);
function nativeFrontier(
  db: DatabaseSync,
  ws: string,
  includeRecovery = true,
  check: () => void = () => {},
): string {
  const hash = createHash("sha256");
  let bytes = 0,
    rows = 0;
  for (const table of [
    ...historicalTables,
    ...(includeRecovery ? KNOWLEDGE_IMPORT_RECOVERY_TABLES : []),
  ]) {
    if (!exists(db, table)) continue;
    hash.update(JSON.stringify(table));
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name))
      .filter((key) => key !== "data");
    for (const header of db
      .prepare(
        `SELECT ${columns.join(",")},length(CAST(data AS BLOB)) AS body_bytes FROM ${table} WHERE workspace_id=? ORDER BY id`,
      )
      .iterate(ws)) {
      check();
      const size = Number(header.body_bytes);
      bytes += size;
      rows++;
      const maximum = [
        "knowledge_file_publications",
        "knowledge_file_checkpoints",
        "knowledge_file_recovery_acknowledgments",
      ].includes(table)
        ? 1_048_576
        : 65_536;
      if (
        !Number.isSafeInteger(size) ||
        size < 2 ||
        size > maximum ||
        rows > KNOWLEDGE_IMPORT_RECOVERY_LIMITS.frontierRows ||
        bytes > KNOWLEDGE_IMPORT_RECOVERY_LIMITS.frontierBytes
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_READ_LIMIT");
      if (
        typeof header.id !== "string" ||
        Buffer.byteLength(header.id) > 256 ||
        header.workspace_id !== ws
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
      const row = raw(db, table, header.id, ws, maximum);
      if (!row) fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
      hash.update(JSON.stringify(header));
      hash.update(row.data);
    }
  }
  return hash.digest("hex");
}
function captureUncertainties(
  db: DatabaseSync,
  ws: string,
): readonly KnowledgeImportUncertaintyPin[] {
  const result: KnowledgeImportUncertaintyPin[] = [];
  for (const [kind, table] of Object.entries(uncertaintyTables) as [
    KnowledgeImportUncertaintyKind,
    string,
  ][]) {
    if (!exists(db, table)) continue;
    const condition = kind.endsWith("barrier")
      ? "state!='clear'"
      : kind === "file-guard"
        ? "publication_id IN (SELECT id FROM knowledge_file_publications WHERE workspace_id=? AND state='uncertain')"
        : kind === "generation-attempt"
          ? "generation_id IN (SELECT id FROM knowledge_generations WHERE workspace_id=? AND state='uncertain')"
          : "state='uncertain'";
    const params =
      kind === "file-guard" || kind === "generation-attempt" ? [ws, ws] : [ws];
    for (const header of db
      .prepare(
        `SELECT id,length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE workspace_id=? AND ${condition} ORDER BY id`,
      )
      .iterate(...params)) {
      if (result.length >= KNOWLEDGE_IMPORT_RECOVERY_LIMITS.uncertaintyPins)
        fail("KNOWLEDGE_IMPORT_RECOVERY_READ_LIMIT");
      const row = raw(
        db,
        table,
        id(header.id),
        ws,
        kind === "file" ? 1_048_576 : 65_536,
      );
      if (!row) fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
      const data = parsed(row.data) as ObjectData;
      if (
        !data ||
        typeof data !== "object" ||
        (data.id ??
          (kind === "generation-barrier" ? data.workspaceId : undefined)) !==
          header.id ||
        data.workspaceId !== ws
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
      const { sha256, ...body } = data;
      if (digest(sha256) !== knowledgeHash(body))
        fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
      result.push(
        Object.freeze({ kind, id: String(header.id), sha256: String(sha256) }),
      );
    }
  }
  return Object.freeze(result);
}
function validatePreview(value: unknown): KnowledgeImportRecoveryPreview {
  const p = object(value, [
    "workspaceId",
    "operation",
    "frontierId",
    "frontierSha256",
    "pauseSha256",
    "binding",
    "currentFrontierSha256",
    "expectedHeadSha256",
    "expectedHeadRevision",
    "expectedActivationId",
    "expectedActivationSha256",
    "expectedActivationRevision",
    "resumeDecisionSha256",
    "uncertaintyPinsSha256",
    "documentProof",
    "expiresAt",
    "sha256",
  ]);
  id(p.workspaceId);
  id(p.frontierId);
  scope(p.binding, p.workspaceId);
  count(p.expectedHeadRevision);
  count(p.expectedActivationRevision);
  date(p.expiresAt);
  for (const key of [
    "frontierSha256",
    "pauseSha256",
    "currentFrontierSha256",
    "expectedHeadSha256",
    "uncertaintyPinsSha256",
  ])
    digest(p[key]);
  if (p.expectedActivationId === null) {
    if (
      p.expectedActivationSha256 !== null ||
      p.expectedActivationRevision !== 0
    )
      fail();
  } else {
    id(p.expectedActivationId);
    digest(p.expectedActivationSha256);
    if (count(p.expectedActivationRevision) < 1) fail();
  }
  if (p.resumeDecisionSha256 !== null) digest(p.resumeDecisionSha256);
  if (p.operation === "activate" || p.operation === "deactivate") {
    proof(p.documentProof, String(p.workspaceId));
    digest(p.resumeDecisionSha256);
  } else if (
    !["acknowledge", "resume"].includes(p.operation as string) ||
    p.documentProof !== null ||
    p.expectedActivationId !== null
  )
    fail();
  hashCheck(p);
  return p as unknown as KnowledgeImportRecoveryPreview;
}
function result(
  db: DatabaseSync,
  decision: KnowledgeImportRecoveryDecision,
): KnowledgeImportRecoveryCommitResult {
  const view = frontier(db, decision.workspaceId);
  if (!view) fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  const activation = decision.activationId
    ? read<ImportedKnowledgeDocumentActivation>(
        db,
        "knowledge_import_document_activations",
        decision.activationId,
        decision.workspaceId,
      )
    : null;
  if (decision.activationId && !activation)
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  return Object.freeze({
    decision,
    activation: activation ?? null,
    frontier: view,
  });
}
/** One native primary-database owner. No Run, producer dispatch or historical cleanup record is manufactured. */
export class KnowledgeImportRecoveryStorage {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgeImportRecoveryStoragePorts;
  readonly #captures = new WeakMap<
    KnowledgeImportRecoveryPreview,
    { used: boolean }
  >();
  readonly #live = new Set<KnowledgeImportRecoveryPreview>();
  constructor(db: DatabaseSync, ports: KnowledgeImportRecoveryStoragePorts) {
    if (!ports || typeof ports !== "object" || types.isProxy(ports))
      fail("INVALID_KNOWLEDGE_IMPORT_RECOVERY_PORTS");
    const descriptors = Object.getOwnPropertyDescriptors(ports);
    for (const key of [
      "writeTx",
      "getWorkspace",
      "checkBinding",
      "assertCommitCurrent",
    ])
      if (typeof descriptors[key]?.value !== "function")
        fail("INVALID_KNOWLEDGE_IMPORT_RECOVERY_PORTS");
    if (
      (descriptors.now && !Object.hasOwn(descriptors.now, "value")) ||
      (descriptors.now && typeof descriptors.now.value !== "function")
    )
      fail("INVALID_KNOWLEDGE_IMPORT_RECOVERY_PORTS");
    this.#db = db;
    this.#ports = Object.freeze({
      writeTx: ports.writeTx.bind(ports),
      getWorkspace: ports.getWorkspace.bind(ports),
      checkBinding: ports.checkBinding.bind(ports),
      assertCommitCurrent: ports.assertCommitCurrent.bind(ports),
      ...(ports.now ? { now: ports.now.bind(ports) } : {}),
    });
  }
  private tx<T>(operation: () => T): T {
    if (this.#db.isTransaction) return operation();
    let entered = 0;
    const output = this.#ports.writeTx(() => {
      if (++entered !== 1 || !this.#db.isTransaction)
        fail("KNOWLEDGE_IMPORT_RECOVERY_TRANSACTION_REQUIRED");
      return operation();
    });
    if (
      entered !== 1 ||
      (output &&
        typeof output === "object" &&
        typeof Reflect.get(output, "then") === "function")
    )
      fail("KNOWLEDGE_IMPORT_RECOVERY_TRANSACTION_REQUIRED");
    return output;
  }
  private now(): number {
    const now = this.#ports.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0)
      fail("INVALID_KNOWLEDGE_IMPORT_RECOVERY_CLOCK");
    return now;
  }
  private stamp(...floors: (string | undefined)[]): string {
    let time = this.now();
    for (const floor of floors)
      if (floor !== undefined) time = Math.max(time, Date.parse(floor));
    return new Date(time).toISOString();
  }
  private binding(ws: string): KnowledgeHostBinding {
    const binding = scope(this.#ports.checkBinding(ws), ws),
      workspace = this.#ports.getWorkspace(ws);
    if (
      !workspace ||
      typeof workspace !== "object" ||
      types.isProxy(workspace) ||
      Object.getOwnPropertyDescriptor(workspace, "id")?.value !== ws ||
      Object.getOwnPropertyDescriptor(workspace, "root")?.value !== binding.root
    )
      fail("KNOWLEDGE_IMPORT_RECOVERY_BINDING_MISMATCH");
    return binding;
  }
  seedImport(input: SeedKnowledgeImportFrontier): KnowledgeImportFrontier {
    const request = seed(input);
    return this.tx(() => {
      const p = pause(this.#db, request.workspaceId);
      if (
        !p ||
        p.sha256 !== request.pauseSha256 ||
        p.archiveSha256 !== request.archiveSha256
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
      const existing = this.#db
        .prepare(
          "SELECT id,workspace_id FROM knowledge_import_frontiers WHERE import_id=?",
        )
        .get(request.importId);
      if (existing) {
        const old = read<KnowledgeImportFrontier>(
          this.#db,
          "knowledge_import_frontiers",
          String(existing.id),
          String(existing.workspace_id),
        );
        if (
          !old ||
          seedKeys.some(
            (key) =>
              !same(
                old[key as keyof KnowledgeImportFrontier],
                request[key as keyof SeedKnowledgeImportFrontier],
              ),
          )
        )
          fail("KNOWLEDGE_IMPORT_RECOVERY_REQUEST_CONFLICT");
        return old;
      }
      if (
        !this.#db
          .prepare("SELECT id FROM workspaces WHERE id=?")
          .get(request.workspaceId)
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_SCOPE_MISMATCH");
      const record = signed({
        ...request,
        id: randomUUID(),
        nativeFrontierSha256: nativeFrontier(
          this.#db,
          request.workspaceId,
          false,
        ),
        uncertainties: captureUncertainties(this.#db, request.workspaceId),
        importedAt: this.stamp(),
      }) as KnowledgeImportFrontier;
      const head = signed({
        id: request.workspaceId,
        workspaceId: request.workspaceId,
        frontierId: record.id,
        frontierSha256: record.sha256,
        revision: 0,
        state: "paused" as const,
        acknowledgeDecisionId: null,
        resumeDecisionId: null,
        updatedAt: record.importedAt,
      });
      this.#db
        .prepare(
          "INSERT INTO knowledge_import_frontiers(id,workspace_id,import_id,data) VALUES(?,?,?,?)",
        )
        .run(
          record.id,
          record.workspaceId,
          record.importId,
          JSON.stringify(record),
        );
      this.#db
        .prepare(
          "INSERT INTO knowledge_import_frontier_heads(id,workspace_id,frontier_id,revision,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET frontier_id=excluded.frontier_id,revision=excluded.revision,data=excluded.data",
        )
        .run(
          head.id,
          head.workspaceId,
          head.frontierId,
          head.revision,
          JSON.stringify(head),
        );
      return record;
    });
  }
  getFrontier(workspaceId: string): KnowledgeImportFrontierView | undefined {
    id(workspaceId);
    return frontier(this.#db, workspaceId);
  }
  getResumeDecision(
    workspaceId: string,
  ): KnowledgeImportRecoveryDecision | undefined {
    const view = this.getFrontier(workspaceId);
    return view ? resumeDecision(this.#db, view) : undefined;
  }
  getActivation(
    workspaceId: string,
    documentKey: string,
  ): ImportedKnowledgeDocumentActivation | undefined {
    id(workspaceId);
    id(documentKey);
    return currentActivation(this.#db, workspaceId, documentKey);
  }
  findRequest(
    workspaceId: string,
    requestId: string,
  ): KnowledgeImportRecoveryDecision | undefined {
    id(workspaceId);
    id(requestId);
    const row = this.#db
      .prepare(
        "SELECT id FROM knowledge_import_recovery_decisions WHERE workspace_id=? AND request_id=?",
      )
      .get(workspaceId, requestId);
    return row
      ? read<KnowledgeImportRecoveryDecision>(
          this.#db,
          "knowledge_import_recovery_decisions",
          String(row.id),
          workspaceId,
        )
      : undefined;
  }
  preview(
    input: PrepareKnowledgeImportRecoveryPreview,
  ): KnowledgeImportRecoveryPreview {
    if (
      !input ||
      typeof input !== "object" ||
      types.isProxy(input) ||
      Array.isArray(input)
    )
      fail();
    const keys = [
      "workspaceId",
      "operation",
      "expiresAt",
      ...(Object.getOwnPropertyDescriptor(input ?? {}, "documentProof")
        ? ["documentProof"]
        : []),
    ];
    const request = object(input, keys);
    const ws = id(request.workspaceId);
    if (
      !["acknowledge", "resume", "activate", "deactivate"].includes(
        request.operation as string,
      )
    )
      fail();
    date(request.expiresAt);
    if (this.#live.size >= KNOWLEDGE_IMPORT_RECOVERY_LIMITS.handles)
      fail("KNOWLEDGE_IMPORT_RECOVERY_LIMIT");
    const captured = this.tx(() => {
      const view = this.getFrontier(ws);
      if (!view) fail("KNOWLEDGE_IMPORT_RECOVERY_NOT_IMPORTED");
      const binding = this.binding(ws);
      if (
        view.frontier.originalBinding &&
        !sameRoot(binding, view.frontier.originalBinding)
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_ROOT_RELOCATION_UNSUPPORTED");
      const now = this.now(),
        expiresAt = String(request.expiresAt);
      if (
        Date.parse(expiresAt) <= now ||
        Date.parse(expiresAt) > now + KNOWLEDGE_IMPORT_RECOVERY_LIMITS.previewMs
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_EXPIRED");
      let documentProof: ImportedKnowledgeDocumentProof | null = null,
        activation: ImportedKnowledgeDocumentActivation | undefined,
        resume: KnowledgeImportRecoveryDecision | undefined;
      if (
        request.operation === "activate" ||
        request.operation === "deactivate"
      ) {
        documentProof = proof(request.documentProof, ws);
        resume = resumeDecision(this.#db, view);
        if (!resume || !same(resume.binding, binding))
          fail("KNOWLEDGE_IMPORT_RECOVERY_NOT_RESUMED");
        activation = this.getActivation(ws, documentProof.documentKey);
        if (request.operation === "activate") {
          if (!sameRoot(binding, documentProof.originalBinding))
            fail("KNOWLEDGE_IMPORT_RECOVERY_ROOT_RELOCATION_UNSUPPORTED");
          if (
            documentProof.currentTrustId === null ||
            documentProof.expiresAt === null ||
            Date.parse(documentProof.expiresAt) <= now
          )
            fail("KNOWLEDGE_IMPORT_RECOVERY_EXPIRED");
        } else if (
          !activation ||
          activation.state !== "active" ||
          activation.frontierId !== view.frontier.id ||
          !same(activation.binding, binding) ||
          !same(activation.proof, documentProof)
        )
          fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
      } else if (request.documentProof !== undefined) fail();
      if (
        request.operation === "resume" &&
        view.frontier.uncertainties.length &&
        !view.head.acknowledgeDecisionId
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_ACK_REQUIRED");
      const value = signed({
        workspaceId: ws,
        operation: request.operation,
        frontierId: view.frontier.id,
        frontierSha256: view.frontier.sha256,
        pauseSha256: view.frontier.pauseSha256,
        binding,
        currentFrontierSha256: nativeFrontier(this.#db, ws),
        expectedHeadSha256: view.head.sha256,
        expectedHeadRevision: view.head.revision,
        expectedActivationId: activation?.id ?? null,
        expectedActivationSha256: activation?.sha256 ?? null,
        expectedActivationRevision: activation?.revision ?? 0,
        resumeDecisionSha256: resume?.sha256 ?? null,
        uncertaintyPinsSha256: knowledgeHash(view.frontier.uncertainties),
        documentProof,
        expiresAt,
      });
      return validatePreview(value);
    });
    this.#captures.set(captured, { used: false });
    this.#live.add(captured);
    return captured;
  }
  commit(
    preview: KnowledgeImportRecoveryPreview,
    input: CommitKnowledgeImportRecovery,
  ): KnowledgeImportRecoveryCommitResult {
    const request = object(input, ["requestId", "approved", "reason"]);
    id(request.requestId);
    if (request.approved !== true)
      fail("KNOWLEDGE_IMPORT_RECOVERY_APPROVAL_REQUIRED");
    reason(request.reason);
    const p = validatePreview(preview);
    const fingerprint = knowledgeHash({
      previewSha256: p.sha256,
      requestId: request.requestId,
      approved: true,
      reason: request.reason,
    });
    const duplicate = this.findRequest(
      p.workspaceId,
      String(request.requestId),
    );
    if (duplicate) {
      if (duplicate.requestSha256 !== fingerprint)
        fail("KNOWLEDGE_IMPORT_RECOVERY_REQUEST_CONFLICT");
      return result(this.#db, duplicate);
    }
    const owner = this.#captures.get(preview);
    if (!owner || owner.used || !this.#live.has(preview))
      fail("KNOWLEDGE_IMPORT_RECOVERY_CAPTURE_INVALID");
    const committed = this.tx(() => {
      const raced = this.findRequest(p.workspaceId, String(request.requestId));
      if (raced) {
        if (raced.requestSha256 !== fingerprint)
          fail("KNOWLEDGE_IMPORT_RECOVERY_REQUEST_CONFLICT");
        return result(this.#db, raced);
      }
      this.assertFresh(preview);
      const proofResult = this.#ports.assertCommitCurrent(preview);
      if (proofResult !== undefined)
        fail("INVALID_KNOWLEDGE_IMPORT_RECOVERY_PORTS");
      this.assertFresh(preview);
      const view = this.getFrontier(p.workspaceId)!;
      const prior = p.documentProof
        ? this.getActivation(p.workspaceId, p.documentProof.documentKey)
        : undefined;
      // A resumed head's updatedAt is its resume decision time.
      const timestamp = this.stamp(
        view.head.updatedAt,
        view.frontier.importedAt,
        prior?.createdAt,
      );
      if (
        p.operation === "activate" &&
        Date.parse(timestamp) >= Date.parse(p.documentProof!.expiresAt!)
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_EXPIRED");
      const activationId = p.documentProof ? randomUUID() : null;
      const decision = signed({
        id: randomUUID(),
        workspaceId: p.workspaceId,
        requestId: String(request.requestId),
        requestSha256: fingerprint,
        operation: p.operation,
        frontierId: p.frontierId,
        frontierSha256: p.frontierSha256,
        pauseSha256: p.pauseSha256,
        binding: p.binding,
        previewSha256: p.sha256,
        currentFrontierSha256: p.currentFrontierSha256,
        uncertaintyPinsSha256: p.uncertaintyPinsSha256,
        reason: String(request.reason),
        documentProof: p.documentProof,
        activationId,
        createdAt: timestamp,
      }) as KnowledgeImportRecoveryDecision;
      this.#db
        .prepare(
          "INSERT INTO knowledge_import_recovery_decisions(id,workspace_id,frontier_id,request_id,operation,data) VALUES(?,?,?,?,?,?)",
        )
        .run(
          decision.id,
          decision.workspaceId,
          decision.frontierId,
          decision.requestId,
          decision.operation,
          JSON.stringify(decision),
        );
      let activation: ImportedKnowledgeDocumentActivation | null = null;
      if (p.operation === "acknowledge" || p.operation === "resume") {
        const { sha256: _prior, ...prior } = view.head;
        const actual = signed({
          ...prior,
          revision: view.head.revision + 1,
          state:
            p.operation === "resume"
              ? ("resumed" as const)
              : ("acknowledged" as const),
          acknowledgeDecisionId:
            p.operation === "acknowledge"
              ? decision.id
              : view.head.acknowledgeDecisionId,
          resumeDecisionId: p.operation === "resume" ? decision.id : null,
          updatedAt: timestamp,
        });
        const changed = this.#db
          .prepare(
            "UPDATE knowledge_import_frontier_heads SET revision=?,data=? WHERE id=? AND frontier_id=? AND revision=? AND data=?",
          )
          .run(
            actual.revision,
            JSON.stringify(actual),
            p.workspaceId,
            p.frontierId,
            p.expectedHeadRevision,
            JSON.stringify(view.head),
          );
        if (Number(changed.changes) !== 1)
          fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
      } else {
        activation = signed({
          id: activationId!,
          workspaceId: p.workspaceId,
          documentKey: p.documentProof!.documentKey,
          frontierId: p.frontierId,
          frontierSha256: p.frontierSha256,
          resumeDecisionSha256: p.resumeDecisionSha256!,
          decisionId: decision.id,
          binding: p.binding,
          revision: p.expectedActivationRevision + 1,
          previousId: p.expectedActivationId,
          state:
            p.operation === "activate"
              ? ("active" as const)
              : ("inactive" as const),
          proof: p.documentProof!,
          createdAt: timestamp,
        }) as ImportedKnowledgeDocumentActivation;
        this.#db
          .prepare(
            "INSERT INTO knowledge_import_document_activations(id,workspace_id,frontier_id,document_key,revision,decision_id,state,data) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            activation.id,
            activation.workspaceId,
            activation.frontierId,
            activation.documentKey,
            activation.revision,
            activation.decisionId,
            activation.state,
            JSON.stringify(activation),
          );
        const head = signed({
          id: activationHeadId(p.workspaceId, activation.documentKey),
          workspaceId: p.workspaceId,
          documentKey: activation.documentKey,
          revision: activation.revision,
          activationId: activation.id,
          activationSha256: activation.sha256,
          updatedAt: timestamp,
        });
        if (p.expectedActivationId === null)
          this.#db
            .prepare(
              "INSERT INTO knowledge_import_document_activation_heads(id,workspace_id,document_key,activation_id,revision,data) VALUES(?,?,?,?,?,?)",
            )
            .run(
              head.id,
              head.workspaceId,
              head.documentKey,
              head.activationId,
              head.revision,
              JSON.stringify(head),
            );
        else {
          const changed = this.#db
            .prepare(
              "UPDATE knowledge_import_document_activation_heads SET activation_id=?,revision=?,data=? WHERE id=? AND activation_id=? AND revision=?",
            )
            .run(
              head.activationId,
              head.revision,
              JSON.stringify(head),
              head.id,
              p.expectedActivationId,
              p.expectedActivationRevision,
            );
          if (Number(changed.changes) !== 1)
            fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
        }
      }
      return Object.freeze({
        decision,
        activation,
        frontier: this.getFrontier(p.workspaceId)!,
      });
    });
    owner.used = true;
    return committed;
  }
  private assertFresh(p: KnowledgeImportRecoveryPreview): void {
    if (this.now() >= Date.parse(p.expiresAt))
      fail("KNOWLEDGE_IMPORT_RECOVERY_EXPIRED");
    const view = this.getFrontier(p.workspaceId);
    if (
      !view ||
      view.frontier.id !== p.frontierId ||
      view.frontier.sha256 !== p.frontierSha256 ||
      view.head.sha256 !== p.expectedHeadSha256 ||
      view.head.revision !== p.expectedHeadRevision ||
      !same(this.binding(p.workspaceId), p.binding) ||
      nativeFrontier(this.#db, p.workspaceId) !== p.currentFrontierSha256 ||
      knowledgeHash(view.frontier.uncertainties) !== p.uncertaintyPinsSha256
    )
      fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
    if (
      !view.frontier.uncertainties
        .filter(
          (pin) =>
            p.operation === "acknowledge" || !pin.kind.endsWith("barrier"),
        )
        .every((pin) => originalPinCurrent(this.#db, p.workspaceId, pin))
    )
      fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
    if (p.documentProof) {
      const actual = this.getActivation(
        p.workspaceId,
        p.documentProof.documentKey,
      );
      if (
        (actual?.id ?? null) !== p.expectedActivationId ||
        (actual?.sha256 ?? null) !== p.expectedActivationSha256 ||
        (actual?.revision ?? 0) !== p.expectedActivationRevision
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
      if (
        p.operation === "activate" &&
        (p.documentProof.expiresAt === null ||
          this.now() >= Date.parse(p.documentProof.expiresAt))
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_EXPIRED");
      const resumed = resumeDecision(this.#db, view);
      if (
        resumed?.sha256 !== p.resumeDecisionSha256 ||
        !same(resumed.binding, p.binding)
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_STALE");
    }
  }
  release(preview: KnowledgeImportRecoveryPreview): void {
    if (!this.#captures.has(preview))
      fail("KNOWLEDGE_IMPORT_RECOVERY_CAPTURE_INVALID");
    this.#captures.delete(preview);
    this.#live.delete(preview);
  }
}

function graphProof(
  db: DatabaseSync,
  ws: string,
  p: ImportedKnowledgeDocumentProof,
): void {
  const load = (table: string, key: string): ObjectData => {
    const row = raw(db, table, key, ws);
    if (!row) fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
    const value = parsed(row.data) as ObjectData;
    if (
      !value ||
      typeof value !== "object" ||
      value.id !== key ||
      value.workspaceId !== ws
    )
      fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
    const { sha256, ...body } = value;
    if (digest(sha256) !== knowledgeHash(body))
      fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
    return value;
  };
  const document = load("workspace_document_revisions", p.documentRevisionId),
    publication = load("knowledge_publications", p.publicationId),
    receipt = load("knowledge_publication_receipts", p.receiptId);
  if (
    document.sha256 !== p.documentSha256 ||
    document.documentKey !== p.documentKey ||
    document.revision !== p.headRevision ||
    document.status !== "active" ||
    document.publicationId !== p.publicationId ||
    !same(document.binding, p.originalBinding) ||
    publication.sha256 !== p.publicationSha256 ||
    publication.state !== "completed" ||
    publication.operation !== "publish" ||
    publication.documentRevisionId !== document.id ||
    receipt.sha256 !== p.receiptSha256 ||
    receipt.operation !== "publish" ||
    receipt.publicationId !== publication.id ||
    receipt.documentRevisionId !== document.id ||
    knowledgeHash(publication.provenance) !== p.provenanceSha256 ||
    !same(publication.provenance, document.provenance)
  )
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  const head = signed({
    id: activationHeadId(ws, p.documentKey),
    workspaceId: ws,
    documentKey: p.documentKey,
    revision: document.revision,
    revisionId: document.id,
    publicationId: publication.id,
    status: document.status,
    bodySha256: document.bodySha256,
    updatedAt: document.createdAt,
  });
  if (head.sha256 !== p.headSha256) fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  const provenance = publication.provenance as ObjectData;
  const candidate = load("knowledge_candidates", id(provenance.candidateId));
  if (
    candidate.sha256 !== provenance.candidateSha256 ||
    knowledgeHash(candidate.source) !== p.sourceManifestSha256
  )
    fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  if (p.currentTrustId !== null) {
    const trust = load("workspace_trust_revisions", p.currentTrustId);
    if (
      trust.sha256 !== p.currentTrustSha256 ||
      trust.revision !== p.currentTrustRevision ||
      trust.decision !== "allow"
    )
      fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
  }
}
/** Streaming bounded row and relationship validation; historical target/source freshness is not reevaluated. */
export function validateKnowledgeImportRecoveryDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  let rows = 0,
    bytes = 0;
  for (const table of KNOWLEDGE_IMPORT_RECOVERY_TABLES) {
    if (!exists(db, table)) continue;
    for (const header of db
      .prepare(
        `SELECT id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM ${table} ORDER BY id`,
      )
      .iterate()) {
      check();
      const size = Number(header.bytes);
      bytes += size;
      if (
        ++rows > KNOWLEDGE_IMPORT_RECOVERY_LIMITS.frontierRows ||
        !Number.isSafeInteger(size) ||
        size < 2 ||
        size > 65_536 ||
        bytes > KNOWLEDGE_IMPORT_RECOVERY_LIMITS.frontierBytes
      )
        fail("KNOWLEDGE_IMPORT_RECOVERY_READ_LIMIT");
      const ws = id(header.workspace_id),
        key = id(header.id),
        row = read(db, table, key, ws)!;
      if (table === "knowledge_import_frontier_heads") {
        const view = frontier(db, ws);
        if (!view) fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        if (view.head.state === "resumed") resumeDecision(db, view);
        if (view.head.acknowledgeDecisionId) {
          const ack = read<KnowledgeImportRecoveryDecision>(
            db,
            "knowledge_import_recovery_decisions",
            view.head.acknowledgeDecisionId,
            ws,
          );
          if (
            !ack ||
            ack.operation !== "acknowledge" ||
            ack.frontierId !== view.frontier.id ||
            ack.frontierSha256 !== view.frontier.sha256 ||
            ack.pauseSha256 !== view.frontier.pauseSha256 ||
            ack.uncertaintyPinsSha256 !==
              knowledgeHash(view.frontier.uncertainties) ||
            ack.createdAt > view.head.updatedAt
          )
            fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        }
      } else if (table === "knowledge_import_recovery_decisions") {
        const d = row as KnowledgeImportRecoveryDecision,
          f = read<KnowledgeImportFrontier>(
            db,
            "knowledge_import_frontiers",
            d.frontierId,
            ws,
          );
        if (
          !f ||
          f.sha256 !== d.frontierSha256 ||
          f.pauseSha256 !== d.pauseSha256 ||
          d.uncertaintyPinsSha256 !== knowledgeHash(f.uncertainties) ||
          f.importedAt > d.createdAt
        )
          fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        if (d.documentProof) {
          graphProof(db, ws, d.documentProof);
          const a = read<ImportedKnowledgeDocumentActivation>(
            db,
            "knowledge_import_document_activations",
            d.activationId!,
            ws,
          );
          if (
            !a ||
            a.decisionId !== d.id ||
            !same(a.proof, d.documentProof) ||
            a.frontierId !== d.frontierId ||
            !same(a.binding, d.binding) ||
            (d.operation === "activate") !== (a.state === "active")
          )
            fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        }
      } else if (table === "knowledge_import_document_activations") {
        const a = row as ImportedKnowledgeDocumentActivation,
          f = read<KnowledgeImportFrontier>(
            db,
            "knowledge_import_frontiers",
            a.frontierId,
            ws,
          ),
          d = read<KnowledgeImportRecoveryDecision>(
            db,
            "knowledge_import_recovery_decisions",
            a.decisionId,
            ws,
          );
        if (
          !f ||
          f.sha256 !== a.frontierSha256 ||
          !d ||
          d.activationId !== a.id ||
          d.frontierId !== a.frontierId ||
          !same(d.binding, a.binding) ||
          !same(d.documentProof, a.proof) ||
          d.createdAt !== a.createdAt ||
          (d.operation === "activate") !== (a.state === "active")
        )
          fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        if (a.previousId) {
          const prior = read<ImportedKnowledgeDocumentActivation>(
            db,
            "knowledge_import_document_activations",
            a.previousId,
            ws,
          );
          if (
            !prior ||
            prior.documentKey !== a.documentKey ||
            prior.revision + 1 !== a.revision ||
            prior.createdAt > a.createdAt
          )
            fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        }
        const resume = db
          .prepare(
            "SELECT id FROM knowledge_import_recovery_decisions WHERE workspace_id=? AND frontier_id=? AND operation='resume' AND json_extract(data,'$.sha256')=? LIMIT 2",
          )
          .all(ws, a.frontierId, a.resumeDecisionSha256);
        if (resume.length !== 1) fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        const r = read<KnowledgeImportRecoveryDecision>(
          db,
          "knowledge_import_recovery_decisions",
          String(resume[0]!.id),
          ws,
        )!;
        if (!same(r.binding, a.binding) || r.createdAt > a.createdAt)
          fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        graphProof(db, ws, a.proof);
      } else if (table === "knowledge_import_document_activation_heads") {
        const h = row as ImportedKnowledgeDocumentActivationHead;
        const a = currentActivation(db, ws, h.documentKey);
        if (!a || activationHeadId(ws, h.documentKey) !== h.id)
          fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
        const later = db
          .prepare(
            "SELECT id FROM knowledge_import_document_activations WHERE workspace_id=? AND document_key=? AND revision>? LIMIT 1",
          )
          .get(ws, h.documentKey, h.revision);
        if (later) fail("KNOWLEDGE_IMPORT_RECOVERY_CORRUPT");
      }
    }
  }
}
