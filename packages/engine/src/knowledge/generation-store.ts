import { randomUUID } from "node:crypto";
import {
  isImportedKnowledgeUncertaintyResolved,
  resolvedImportedKnowledgeOwners,
} from "./import-recovery-store.js";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  KnowledgeGenerationPlan,
  KnowledgeHostBinding,
  KnowledgeUsage,
} from "./types.js";
import type {
  CreateKnowledgeGeneration,
  CreateKnowledgeGenerationResult,
  KnowledgeGenerationArchiveRow,
  KnowledgeGenerationAttempt,
  KnowledgeGenerationAttemptCapture,
  KnowledgeGenerationCapture,
  KnowledgeGenerationCleanup,
  KnowledgeGenerationEvidence,
  KnowledgeGenerationObservation,
  KnowledgeGenerationRecord,
  KnowledgeGenerationRecoveryAcknowledgment,
  KnowledgeGenerationRecoveryPreview,
  KnowledgeGenerationRecoveryResult,
  KnowledgeGenerationSettlement,
  KnowledgeGenerationStoragePorts,
  KnowledgeGenerationTable,
  KnowledgeGenerationWorkspaceBarrier,
} from "./generation-types.js";
import {
  normalizeKnowledgeGenerationBudget,
  assertKnowledgeGenerationDigest,
} from "./generation-budget.js";
import {
  identifier,
  immutableKnowledgeJson,
  integer,
  knowledgeError,
  knowledgeHash,
  sha256,
  stamp,
  validateBinding,
  validateGenerationPlan,
  validateUsage,
} from "./validation.js";

export const KNOWLEDGE_GENERATION_TABLES = Object.freeze([
  "knowledge_generations",
  "knowledge_generation_attempts",
  "knowledge_generation_recovery_acknowledgments",
  "knowledge_generation_workspace_barriers",
] as const);
/** Migration fragment only; it does not change the authoritative schema version. */
export const KNOWLEDGE_GENERATION_SCHEMA_SQL = `
CREATE TABLE knowledge_generations (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 plan_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536), UNIQUE(workspace_id,id), UNIQUE(workspace_id,request_id),
 FOREIGN KEY(workspace_id,plan_id) REFERENCES knowledge_generation_plans(workspace_id,id)
) STRICT;
CREATE TABLE knowledge_generation_attempts (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 generation_id TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,generation_id) REFERENCES knowledge_generations(workspace_id,id),
 FOREIGN KEY(workspace_id,plan_id) REFERENCES knowledge_generation_plans(workspace_id,id)
) STRICT;
CREATE TABLE knowledge_generation_recovery_acknowledgments (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('acknowledge','resume')),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536), UNIQUE(workspace_id,request_id), UNIQUE(workspace_id,id)
) STRICT;
CREATE TABLE knowledge_generation_workspace_barriers (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('blocked','pending-resume','clear')), revision INTEGER NOT NULL CHECK(revision > 0),
 data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536), CHECK(id=workspace_id)
) STRICT;
CREATE INDEX knowledge_generation_workspace_page ON knowledge_generations(workspace_id,id);
CREATE INDEX knowledge_generation_active ON knowledge_generations(workspace_id,state);
CREATE INDEX knowledge_generation_attempt_workspace_page ON knowledge_generation_attempts(workspace_id,id);
`;

const ACTIVE = new Set([
  "prepared",
  "dispatched",
  "streaming",
  "output-finished",
]);
const STATES = new Set([
  ...ACTIVE,
  "completed",
  "failed",
  "cancelled",
  "uncertain",
]);
const UNKNOWN_USAGE: KnowledgeUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
});
const MAX_READ_BYTES = 1_048_576;
type Row = {
  id: string;
  workspace_id: string;
  data: string;
  state?: string;
  revision?: number;
  plan_id?: string;
  generation_id?: string;
  request_id?: string;
  operation?: string;
};
type GenHandle = { record: KnowledgeGenerationRecord };
type AttemptHandle = {
  record: KnowledgeGenerationAttempt;
  owner: KnowledgeGenerationCapture;
};
function exact(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Expected a plain native generation record",
    );
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Host generation fields do not match their bounded contract",
    );
}
function hashRecord<T extends object>(
  body: T,
): T & { readonly sha256: string } {
  return immutableKnowledgeJson({ ...body, sha256: knowledgeHash(body) });
}
function updated<T extends { readonly sha256: string }>(
  record: T,
  patch: object,
): T {
  const { sha256: _old, ...body } = record;
  return hashRecord({ ...body, ...patch }) as unknown as T;
}
function checkHash(record: { readonly sha256: string }): void {
  assertKnowledgeGenerationDigest(record.sha256);
  const { sha256: expected, ...body } = record;
  if (knowledgeHash(body) !== expected)
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Native generation record hash does not match its exact body",
    );
  if (Buffer.byteLength(JSON.stringify(record)) > 61_440)
    knowledgeError(
      "KNOWLEDGE_GENERATION_LIMIT",
      "Native record must leave space for its bounded archive envelope",
    );
}
function checkState(value: unknown): void {
  if (typeof value !== "string" || !STATES.has(value))
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Unknown native generation state",
    );
}
function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > maximum ||
    Buffer.from(value).toString("utf8") !== value
  )
    knowledgeError(
      "KNOWLEDGE_GENERATION_LIMIT",
      "Native generation text must be bounded valid UTF-8",
    );
  return value as string;
}
function nullableIdentifier(value: unknown): void {
  if (value !== null) identifier(value);
}
function cleanup(value: unknown): KnowledgeGenerationCleanup {
  const result = immutableKnowledgeJson(value) as KnowledgeGenerationCleanup;
  if (!result || typeof result !== "object")
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Native cleanup requires an explicit observation",
    );
  exact(result, ["confirmed", "method", "reason"]);
  if (
    typeof result.confirmed !== "boolean" ||
    ![
      "iterator-complete",
      "iterator-return",
      "not-dispatched",
      "unknown",
    ].includes(result.method) ||
    (result.confirmed && result.method === "unknown")
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Cleanup method and confirmation disagree",
    );
  if (result.reason !== null) text(result.reason, 2_048);
  if (Buffer.byteLength(JSON.stringify(result)) > 4_096)
    knowledgeError(
      "KNOWLEDGE_GENERATION_LIMIT",
      "Cleanup observation exceeds its bound",
    );
  return result;
}
function validateRecord(value: unknown): KnowledgeGenerationRecord {
  const r = immutableKnowledgeJson(value) as KnowledgeGenerationRecord;
  exact(r, [
    "id",
    "workspaceId",
    "planId",
    "planSha256",
    "requestId",
    "createSha256",
    "binding",
    "providerId",
    "modelId",
    "logicalRequestSha256",
    "logicalRequestBytes",
    "budget",
    "budgetSha256",
    "runtimeEpoch",
    "revision",
    "state",
    "attemptId",
    "candidate",
    "createdAt",
    "updatedAt",
    "deadline",
    "errorCode",
    "sha256",
  ]);
  for (const v of [
    r.id,
    r.workspaceId,
    r.planId,
    r.requestId,
    r.providerId,
    r.modelId,
    r.runtimeEpoch,
  ])
    identifier(v);
  for (const v of [
    r.planSha256,
    r.createSha256,
    r.logicalRequestSha256,
    r.budgetSha256,
  ])
    assertKnowledgeGenerationDigest(v);
  const b = validateBinding(r.binding);
  if (b.workspaceId !== r.workspaceId)
    knowledgeError(
      "KNOWLEDGE_SCOPE_MISMATCH",
      "Native generation binding has another workspace",
    );
  const budget = normalizeKnowledgeGenerationBudget(r.budget);
  if (
    knowledgeHash(budget) !== r.budgetSha256 ||
    knowledgeHash(r.budget) !== knowledgeHash(budget)
  )
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Original generation budget hash changed",
    );
  if (!integer(r.revision) || !integer(r.logicalRequestBytes, 262_144))
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Native revision and logical request size must be positive",
    );
  checkState(r.state);
  nullableIdentifier(r.attemptId);
  nullableIdentifier(r.errorCode);
  stamp(r.createdAt);
  stamp(r.updatedAt);
  integer(r.deadline, 8_640_000_000_000_000);
  if (
    Date.parse(r.updatedAt) < Date.parse(r.createdAt) ||
    r.deadline <= Date.parse(r.createdAt) ||
    r.deadline > Date.parse(r.createdAt) + budget.maxDurationMs
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Native original deadlines or time frontier changed",
    );
  exact(r.candidate, ["state", "candidateId", "reason"]);
  if (r.candidate.state === "recorded") {
    identifier(r.candidate.candidateId);
    if (r.candidate.reason !== null || r.state !== "completed")
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Only completed output may refer to a candidate",
      );
  } else if (r.candidate.state === "withheld") {
    text(r.candidate.reason, 2_048);
    if (!r.candidate.reason || r.candidate.candidateId !== null)
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Withheld native output needs a bounded reason",
      );
  } else if (
    r.candidate.state !== "pending" ||
    r.candidate.candidateId !== null ||
    r.candidate.reason !== null
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Unknown native candidate state",
    );
  if (
    (r.state === "completed" && r.attemptId === null) ||
    (["dispatched", "streaming", "output-finished", "uncertain"].includes(
      r.state,
    ) &&
      r.attemptId === null)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Dispatched or completed native work needs its actual attempt",
    );
  checkHash(r);
  if (r.state === "completed" && r.errorCode !== null)
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Completed native output cannot retain a failure code",
    );
  return r;
}
function validateAttempt(value: unknown): KnowledgeGenerationAttempt {
  const r = immutableKnowledgeJson(value) as KnowledgeGenerationAttempt;
  exact(r, [
    "id",
    "workspaceId",
    "generationId",
    "planId",
    "runtimeEpoch",
    "revision",
    "state",
    "exactDispatchSha256",
    "exactDispatchBytes",
    "createdAt",
    "updatedAt",
    "dispatchedAt",
    "output",
    "outputSha256",
    "outputBytes",
    "observedTextBytes",
    "outputTruncated",
    "observationBytes",
    "events",
    "usage",
    "providerRequestId",
    "finishReason",
    "streamDone",
    "cleanup",
    "errorCode",
    "sha256",
  ]);
  for (const v of [
    r.id,
    r.workspaceId,
    r.generationId,
    r.planId,
    r.runtimeEpoch,
  ])
    identifier(v);
  assertKnowledgeGenerationDigest(r.exactDispatchSha256);
  assertKnowledgeGenerationDigest(r.outputSha256);
  if (!integer(r.revision) || !integer(r.exactDispatchBytes, 262_144))
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Attempt revision and exact request bytes must be positive",
    );
  checkState(r.state);
  stamp(r.createdAt);
  stamp(r.updatedAt);
  if (r.dispatchedAt !== null) stamp(r.dispatchedAt);
  text(r.output, 16_384);
  integer(r.outputBytes, 16_384);
  integer(r.observedTextBytes);
  integer(r.observationBytes);
  integer(r.events);
  if (
    Buffer.byteLength(r.output) !== r.outputBytes ||
    sha256(r.output) !== r.outputSha256 ||
    r.observedTextBytes < r.outputBytes ||
    typeof r.outputTruncated !== "boolean" ||
    (!r.outputTruncated && r.observedTextBytes !== r.outputBytes)
  )
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Retained native output and actual byte charge disagree",
    );
  validateUsage(r.usage);
  if (Buffer.byteLength(JSON.stringify(r.usage)) > 4_096)
    knowledgeError(
      "KNOWLEDGE_GENERATION_LIMIT",
      "Native usage exceeds its bound",
    );
  nullableIdentifier(r.providerRequestId);
  nullableIdentifier(r.errorCode);
  if (
    (r.finishReason !== null && r.finishReason !== "stop") ||
    typeof r.streamDone !== "boolean"
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Unknown native finish observation",
    );
  if (r.cleanup !== null) cleanup(r.cleanup);
  if (
    Date.parse(r.updatedAt) < Date.parse(r.createdAt) ||
    (r.dispatchedAt !== null &&
      Date.parse(r.dispatchedAt) < Date.parse(r.createdAt))
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Attempt time frontier moved backwards",
    );
  if (
    (r.state === "prepared" && r.dispatchedAt !== null) ||
    ([
      "dispatched",
      "streaming",
      "output-finished",
      "completed",
      "uncertain",
    ].includes(r.state) &&
      r.dispatchedAt === null)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Attempt dispatch state does not match its durable intent",
    );
  if (
    r.state === "completed" &&
    (!r.streamDone ||
      r.finishReason !== "stop" ||
      !r.cleanup?.confirmed ||
      r.cleanup.method !== "iterator-complete" ||
      !r.output.trim() ||
      r.outputTruncated)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Completed output requires stop, actual iterator done and confirmed cleanup",
    );
  if (
    (r.state === "uncertain" && r.cleanup?.confirmed) ||
    (["failed", "cancelled"].includes(r.state) && !r.cleanup?.confirmed) ||
    (ACTIVE.has(r.state) && r.cleanup !== null)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Terminal state and cleanup authority disagree",
    );
  checkHash(r);
  if (r.state === "completed" && r.errorCode !== null)
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Completed native attempt cannot retain a failure code",
    );
  return r;
}
function validateAck(
  value: unknown,
): KnowledgeGenerationRecoveryAcknowledgment {
  const r = immutableKnowledgeJson(
    value,
  ) as KnowledgeGenerationRecoveryAcknowledgment;
  exact(r, [
    "id",
    "workspaceId",
    "requestId",
    "operation",
    "requestSha256",
    "binding",
    "runtimeEpoch",
    "expectedBarrierRevision",
    "frontierSha256",
    "generations",
    "reason",
    "createdAt",
    "sha256",
  ]);
  for (const v of [r.id, r.workspaceId, r.requestId, r.runtimeEpoch])
    identifier(v);
  assertKnowledgeGenerationDigest(r.requestSha256);
  assertKnowledgeGenerationDigest(r.frontierSha256);
  stamp(r.createdAt);
  integer(r.expectedBarrierRevision);
  if (
    validateBinding(r.binding).workspaceId !== r.workspaceId ||
    !Array.isArray(r.generations) ||
    r.generations.length > 128 ||
    !["acknowledge", "resume"].includes(r.operation)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Recovery acknowledgment scope or selection is invalid",
    );
  const seen = new Set<string>();
  for (const pin of r.generations) {
    exact(pin, ["id", "sha256"]);
    identifier(pin.id);
    assertKnowledgeGenerationDigest(pin.sha256);
    if (seen.has(pin.id))
      knowledgeError("INVALID_KNOWLEDGE_GENERATION", "Duplicate recovery pin");
    seen.add(pin.id);
  }
  if (r.operation === "acknowledge") {
    if (
      !r.generations.length ||
      r.reason === null ||
      !text(r.reason, 2_048).trim()
    )
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Recovery needs an explicit host reason and exact selected records",
      );
  } else if (r.generations.length || r.reason !== null)
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Resume must not masquerade as producer cleanup",
    );
  checkHash(r);
  return r;
}
function validateBarrier(value: unknown): KnowledgeGenerationWorkspaceBarrier {
  const r = immutableKnowledgeJson(
    value,
  ) as KnowledgeGenerationWorkspaceBarrier;
  exact(r, [
    "workspaceId",
    "revision",
    "state",
    "frontierSha256",
    "updatedAt",
    "sha256",
  ]);
  identifier(r.workspaceId);
  if (
    !integer(r.revision) ||
    !["blocked", "pending-resume", "clear"].includes(r.state)
  )
    knowledgeError(
      "INVALID_KNOWLEDGE_GENERATION",
      "Invalid workspace recovery barrier",
    );
  assertKnowledgeGenerationDigest(r.frontierSha256);
  stamp(r.updatedAt);
  checkHash(r);
  return r;
}
export function validateKnowledgeGenerationArchiveRow(
  value: unknown,
): KnowledgeGenerationArchiveRow {
  const row = immutableKnowledgeJson(value) as KnowledgeGenerationArchiveRow;
  exact(row, ["table", "key", "workspaceId", "data"]);
  identifier(row.key);
  identifier(row.workspaceId);
  let data: KnowledgeGenerationArchiveRow["data"];
  switch (row.table) {
    case "knowledge_generations":
      data = validateRecord(row.data);
      break;
    case "knowledge_generation_attempts":
      data = validateAttempt(row.data);
      break;
    case "knowledge_generation_recovery_acknowledgments":
      data = validateAck(row.data);
      break;
    case "knowledge_generation_workspace_barriers":
      data = validateBarrier(row.data);
      break;
    default:
      return knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Unknown native archive table",
      );
  }
  if (
    data.workspaceId !== row.workspaceId ||
    ("id" in data ? data.id : data.workspaceId) !== row.key
  )
    knowledgeError(
      "KNOWLEDGE_SCOPE_MISMATCH",
      "Native archive key and scope disagree",
    );
  return row;
}
function decode(
  row: Row,
  table: KnowledgeGenerationTable,
): KnowledgeGenerationArchiveRow["data"] {
  if (Buffer.byteLength(row.data) > 65_536)
    knowledgeError(
      "KNOWLEDGE_GENERATION_LIMIT",
      "Stored native row exceeds its bound",
    );
  const value = validateKnowledgeGenerationArchiveRow({
    table,
    key: row.id,
    workspaceId: row.workspace_id,
    data: JSON.parse(row.data),
  }).data;
  if (
    ("state" in value &&
      row.state !== undefined &&
      row.state !== value.state) ||
    ("revision" in value &&
      row.revision !== undefined &&
      row.revision !== value.revision) ||
    ("planId" in value &&
      row.plan_id !== undefined &&
      row.plan_id !== value.planId) ||
    ("generationId" in value &&
      row.generation_id !== undefined &&
      row.generation_id !== value.generationId) ||
    ("requestId" in value &&
      row.request_id !== undefined &&
      row.request_id !== value.requestId) ||
    ("operation" in value &&
      row.operation !== undefined &&
      row.operation !== value.operation)
  )
    knowledgeError(
      "KNOWLEDGE_RECORD_CONFLICT",
      "Native indexed columns disagree with their authoritative body",
    );
  return value;
}
function boundedRows(
  db: DatabaseSync,
  sql: string,
  args: readonly SQLInputValue[],
  maximumBytes = MAX_READ_BYTES,
): Row[] {
  const metadata = db
    .prepare(
      `SELECT count(*) AS rows,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM (${sql})`,
    )
    .get(...args) as { rows: number; bytes: number };
  if (metadata.rows > 128 || metadata.bytes > maximumBytes)
    knowledgeError(
      "KNOWLEDGE_GENERATION_LIMIT",
      "Native row projection exceeds its metadata-checked read bound",
    );
  return db.prepare(sql).all(...args) as Row[];
}
const BINDING_FIELDS = [
  "workspaceId",
  "root",
  "rootDevice",
  "rootInode",
  "storageBindingSha256",
];
const UNRESOLVED_GENERATIONS_SQL = `WITH acknowledged AS MATERIALIZED (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.sha256') AS sha256,${BINDING_FIELDS.map((key) => `json_extract(value,'$.binding.${key}') AS ${key}`).join(",")} FROM json_each(?2)),
imported AS MATERIALIZED (SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.sha256') AS sha256 FROM json_each(?3))
SELECT g.* FROM knowledge_generations g WHERE g.workspace_id=?1 AND (g.state IN ('prepared','dispatched','streaming','output-finished') OR (g.state='uncertain'
 AND NOT EXISTS (SELECT 1 FROM acknowledged k WHERE k.id=g.id AND k.sha256=json_extract(g.data,'$.sha256') AND ${BINDING_FIELDS.map((key) => `k.${key}=json_extract(g.data,'$.binding.${key}')`).join(" AND ")})
 AND NOT EXISTS (SELECT 1 FROM imported i WHERE i.id=g.id AND i.sha256=json_extract(g.data,'$.sha256')))) ORDER BY g.id LIMIT 129`;
/** Active and unresolved uncertain generations; validated acknowledgment and import pins exclude resolved history before the bounded read. */
function unresolvedGenerations(
  db: DatabaseSync,
  workspaceId: string,
): { rows: Row[]; generations: KnowledgeGenerationRecord[] } {
  const acknowledged: { id: string; sha256: string; binding: KnowledgeHostBinding }[] = [];
  for (const row of db
    .prepare(
      "SELECT * FROM knowledge_generation_recovery_acknowledgments WHERE workspace_id=? AND operation='acknowledge' ORDER BY id",
    )
    .iterate(workspaceId) as Iterable<Row>) {
    const ack = decode(
      row,
      "knowledge_generation_recovery_acknowledgments",
    ) as KnowledgeGenerationRecoveryAcknowledgment;
    for (const pin of ack.generations)
      acknowledged.push({ ...pin, binding: ack.binding });
  }
  const rows = boundedRows(db, UNRESOLVED_GENERATIONS_SQL, [
    workspaceId,
    JSON.stringify(acknowledged),
    JSON.stringify(
      resolvedImportedKnowledgeOwners(db, workspaceId, "generation"),
    ),
  ]);
  return {
    rows,
    generations: rows.map(
      (row) =>
        decode(row, "knowledge_generations") as KnowledgeGenerationRecord,
    ),
  };
}
/** Pure persisted predicate available before host adapters are installed. Corrupt records fail closed. */
export function hasKnowledgeGenerationBlocker(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  identifier(workspaceId);
  const barrier = db
    .prepare(
      "SELECT * FROM knowledge_generation_workspace_barriers WHERE workspace_id=?",
    )
    .get(workspaceId) as Row | undefined;
  if (barrier) {
    const value = decode(barrier, "knowledge_generation_workspace_barriers") as KnowledgeGenerationWorkspaceBarrier;
    if (value.state !== "clear" && !isImportedKnowledgeUncertaintyResolved(db, workspaceId, "generation-barrier", value.workspaceId, value.sha256)) return true;
  }
  return unresolvedGenerations(db, workspaceId).generations.length > 0;
}

export class KnowledgeGenerationStorage {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgeGenerationStoragePorts;
  readonly #epoch = randomUUID();
  readonly #owners = new WeakMap<object, GenHandle>();
  readonly #attempts = new WeakMap<object, AttemptHandle>();
  readonly #liveOwners = new Set<object>();
  readonly #liveAttempts = new Set<object>();
  readonly #previews = new WeakMap<
    object,
    KnowledgeGenerationRecoveryPreview
  >();
  readonly #livePreviews = new Map<
    string,
    KnowledgeGenerationRecoveryPreview
  >();
  constructor(db: DatabaseSync, ports: KnowledgeGenerationStoragePorts) {
    for (const key of [
      "writeTx",
      "getWorkspace",
      "getPlan",
      "checkBinding",
      "assertPlanCurrent",
    ] as const)
      if (!ports || typeof ports[key] !== "function")
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION_PORTS",
          "Native generation needs synchronous host and transaction ports",
        );
    if (ports.now !== undefined && typeof ports.now !== "function")
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION_PORTS",
        "Native generation clock must be callable",
      );
    this.#db = db;
    this.#ports = Object.freeze({ ...ports });
    Object.freeze(this);
  }
  private write<T>(operation: () => T): T {
    let entered = false;
    const result = this.#ports.writeTx(() => {
      if (entered || !this.#db.isTransaction)
        knowledgeError(
          "KNOWLEDGE_TRANSACTION_REQUIRED",
          "Native write must run once inside its exact database transaction",
        );
      entered = true;
      const result = operation();
      if (result && typeof result === "object" && "then" in result)
        knowledgeError(
          "KNOWLEDGE_ASYNC_PORT",
          "Native writes cannot cross an await",
        );
      return result;
    });
    if (!entered || (result && typeof result === "object" && "then" in result))
      knowledgeError(
        "KNOWLEDGE_TRANSACTION_REQUIRED",
        "Host transaction must synchronously execute its operation",
      );
    return result;
  }
  private now(floor = 0): number {
    const value = this.#ports.now?.() ?? Date.now();
    integer(value, 8_640_000_000_000_000);
    return Math.max(floor, value);
  }
  private binding(workspaceId: string): KnowledgeHostBinding {
    identifier(workspaceId);
    const workspace = immutableKnowledgeJson(
      this.#ports.getWorkspace(workspaceId),
    );
    const binding = validateBinding(this.#ports.checkBinding(workspaceId));
    if (
      workspace.id !== workspaceId ||
      binding.workspaceId !== workspaceId ||
      workspace.root !== binding.root
    )
      knowledgeError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Current workspace host binding disagrees",
      );
    return binding;
  }
  private assertBinding(binding: KnowledgeHostBinding): void {
    if (
      knowledgeHash(this.binding(binding.workspaceId)) !==
      knowledgeHash(binding)
    )
      knowledgeError(
        "KNOWLEDGE_BINDING_MISMATCH",
        "Native operation was captured under another physical root or storage binding",
      );
  }
  private plan(workspaceId: string, planId: string): KnowledgeGenerationPlan {
    const plan =
      this.#ports.getPlan(workspaceId, planId) ??
      knowledgeError(
        "KNOWLEDGE_NOT_FOUND",
        "Native operation has no actual pending plan",
      );
    const result = validateGenerationPlan(plan);
    if (result.workspaceId !== workspaceId || result.id !== planId)
      knowledgeError(
        "KNOWLEDGE_SCOPE_MISMATCH",
        "Native operation plan scope disagrees",
      );
    return result;
  }
  private fresh(record: KnowledgeGenerationRecord): void {
    this.assertBinding(record.binding);
    const plan = this.plan(record.workspaceId, record.planId);
    if (plan.sha256 !== record.planSha256)
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Native original plan changed",
      );
    if (this.#ports.assertPlanCurrent(plan) !== undefined)
      knowledgeError(
        "KNOWLEDGE_ASYNC_PORT",
        "Plan freshness must be synchronous",
      );
    this.assertBinding(record.binding);
    if (
      this.plan(record.workspaceId, record.planId).sha256 !== record.planSha256
    )
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Plan changed while validating native owner",
      );
    if (this.now() >= record.deadline)
      knowledgeError(
        "KNOWLEDGE_GENERATION_DEADLINE",
        "Original host generation deadline elapsed",
      );
  }
  private owned(capture: KnowledgeGenerationCapture): GenHandle {
    if (
      !capture ||
      typeof capture !== "object" ||
      !this.#liveOwners.has(capture)
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_HANDLE_INVALID",
        "Generation owner is foreign, copied or released",
      );
    return (
      this.#owners.get(capture) ??
      knowledgeError(
        "KNOWLEDGE_GENERATION_HANDLE_INVALID",
        "Generation owner was never issued",
      )
    );
  }
  private attempted(
    owner: KnowledgeGenerationCapture,
    capture: KnowledgeGenerationAttemptCapture,
  ): AttemptHandle {
    if (
      !capture ||
      typeof capture !== "object" ||
      !this.#liveAttempts.has(capture)
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_HANDLE_INVALID",
        "Attempt owner is foreign, copied or released",
      );
    const value =
      this.#attempts.get(capture) ??
      knowledgeError(
        "KNOWLEDGE_GENERATION_HANDLE_INVALID",
        "Attempt owner was never issued",
      );
    if (value.owner !== owner)
      knowledgeError(
        "KNOWLEDGE_GENERATION_HANDLE_INVALID",
        "Attempt belongs to another original generation capture",
      );
    return value;
  }
  private active(
    capture: KnowledgeGenerationCapture,
    attempt?: KnowledgeGenerationAttemptCapture,
  ): {
    generation: KnowledgeGenerationRecord;
    attempt: KnowledgeGenerationAttempt | null;
  } {
    const state = this.owned(capture),
      generation = this.getGeneration(
        state.record.workspaceId,
        state.record.id,
      );
    if (
      generation.sha256 !== state.record.sha256 ||
      generation.runtimeEpoch !== this.#epoch ||
      !ACTIVE.has(generation.state)
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_STALE",
        "Native owner epoch or terminal fence changed",
      );
    if (!attempt) return { generation, attempt: null };
    const issued = this.attempted(capture, attempt),
      record = this.getAttempt(generation.workspaceId, issued.record.id);
    if (
      record.sha256 !== issued.record.sha256 ||
      record.generationId !== generation.id ||
      record.planId !== generation.planId ||
      record.state !== generation.state ||
      record.id !== generation.attemptId ||
      record.runtimeEpoch !== this.#epoch ||
      !ACTIVE.has(record.state)
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_STALE",
        "Native attempt epoch or terminal fence changed",
      );
    return { generation, attempt: record };
  }
  getGeneration(
    workspaceId: string,
    generationId: string,
  ): KnowledgeGenerationRecord {
    identifier(workspaceId);
    identifier(generationId);
    const row = this.#db
      .prepare(
        "SELECT * FROM knowledge_generations WHERE workspace_id=? AND id=?",
      )
      .get(workspaceId, generationId) as Row | undefined;
    return row
      ? (decode(row, "knowledge_generations") as KnowledgeGenerationRecord)
      : knowledgeError(
          "KNOWLEDGE_NOT_FOUND",
          "Native generation does not exist in this workspace",
        );
  }
  getAttempt(
    workspaceId: string,
    attemptId: string,
  ): KnowledgeGenerationAttempt {
    identifier(workspaceId);
    identifier(attemptId);
    const row = this.#db
      .prepare(
        "SELECT * FROM knowledge_generation_attempts WHERE workspace_id=? AND id=?",
      )
      .get(workspaceId, attemptId) as Row | undefined;
    return row
      ? (decode(
          row,
          "knowledge_generation_attempts",
        ) as KnowledgeGenerationAttempt)
      : knowledgeError(
          "KNOWLEDGE_NOT_FOUND",
          "Native attempt does not exist in this workspace",
        );
  }
  private request(input: CreateKnowledgeGeneration): CreateKnowledgeGeneration {
    const r = immutableKnowledgeJson(input);
    exact(r, [
      "workspaceId",
      "planId",
      "requestId",
      "budget",
      "logicalRequestSha256",
      "logicalRequestBytes",
    ]);
    identifier(r.workspaceId);
    identifier(r.planId);
    identifier(r.requestId);
    assertKnowledgeGenerationDigest(r.logicalRequestSha256);
    if (!integer(r.logicalRequestBytes, 262_144))
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Logical request size must be positive",
      );
    return immutableKnowledgeJson({
      ...r,
      budget: normalizeKnowledgeGenerationBudget(r.budget),
    });
  }
  findRequest(
    input: CreateKnowledgeGeneration,
  ): KnowledgeGenerationRecord | undefined {
    const request = this.request(input);
    const row = this.#db
      .prepare(
        "SELECT * FROM knowledge_generations WHERE workspace_id=? AND request_id=?",
      )
      .get(request.workspaceId, request.requestId) as Row | undefined;
    if (!row) return undefined;
    const record = decode(
      row,
      "knowledge_generations",
    ) as KnowledgeGenerationRecord;
    this.assertBinding(record.binding);
    const plan = this.plan(record.workspaceId, record.planId);
    if (
      plan.sha256 !== record.planSha256 ||
      plan.providerId !== record.providerId ||
      plan.modelId !== record.modelId ||
      plan.requestSha256 !== record.logicalRequestSha256 ||
      plan.requestBytes !== record.logicalRequestBytes
    )
      knowledgeError(
        "KNOWLEDGE_RECORD_CONFLICT",
        "Stored native owner and original logical plan disagree",
      );
    if (
      record.createSha256 !== knowledgeHash(request) ||
      record.planId !== request.planId
    )
      knowledgeError(
        "KNOWLEDGE_REQUEST_CONFLICT",
        "Native generation request ID was used for different exact input",
      );
    return record;
  }
  create(input: CreateKnowledgeGeneration): CreateKnowledgeGenerationResult {
    const request = this.request(input);
    if (this.#liveOwners.size >= 128)
      knowledgeError(
        "KNOWLEDGE_GENERATION_LIMIT",
        "Release original host captures before admitting more",
      );
    const result = this.write(() => {
      const duplicate = this.findRequest(request);
      if (duplicate) return { kind: "duplicate" as const, record: duplicate };
      if (
        this.#db
          .prepare("SELECT id FROM knowledge_generations WHERE plan_id=?")
          .get(request.planId)
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_PLAN_USED",
          "A pending plan already has its original native owner; a new producer needs a new plan",
        );
      if (this.hasBlocker(request.workspaceId))
        knowledgeError(
          "KNOWLEDGE_GENERATION_BLOCKED",
          "Workspace native host generation is active or quarantined",
        );
      const plan = this.plan(request.workspaceId, request.planId),
        binding = this.binding(request.workspaceId);
      if (
        knowledgeHash(binding) !== knowledgeHash(plan.binding) ||
        plan.requestSha256 !== request.logicalRequestSha256 ||
        plan.requestBytes !== request.logicalRequestBytes ||
        request.budget.maxOutputBytes > plan.maxOutputBytes
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_BINDING_MISMATCH",
          "Native generation differs from its exact host plan",
        );
      if (this.#ports.assertPlanCurrent(plan) !== undefined)
        knowledgeError(
          "KNOWLEDGE_ASYNC_PORT",
          "Plan freshness must be synchronous",
        );
      const now = this.now(),
        deadline = Math.min(
          now + request.budget.maxDurationMs,
          Date.parse(plan.expiresAt),
        );
      if (deadline <= now)
        knowledgeError("KNOWLEDGE_EXPIRED", "Generation plan already expired");
      const record = validateRecord(
        hashRecord({
          id: randomUUID(),
          workspaceId: request.workspaceId,
          planId: plan.id,
          planSha256: plan.sha256,
          requestId: request.requestId,
          createSha256: knowledgeHash(request),
          binding,
          providerId: plan.providerId,
          modelId: plan.modelId,
          logicalRequestSha256: request.logicalRequestSha256,
          logicalRequestBytes: request.logicalRequestBytes,
          budget: request.budget,
          budgetSha256: knowledgeHash(request.budget),
          runtimeEpoch: this.#epoch,
          revision: 1,
          state: "prepared" as const,
          attemptId: null,
          candidate: {
            state: "pending" as const,
            candidateId: null,
            reason: null,
          },
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          deadline,
          errorCode: null,
        }),
      );
      this.assertBinding(binding);
      if (
        this.plan(request.workspaceId, plan.id).sha256 !== plan.sha256 ||
        this.hasBlocker(request.workspaceId)
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Native frontier changed while checking admission",
        );
      this.#db
        .prepare(
          "INSERT INTO knowledge_generations(id,workspace_id,plan_id,request_id,state,revision,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          record.id,
          record.workspaceId,
          record.planId,
          record.requestId,
          record.state,
          record.revision,
          JSON.stringify(record),
        );
      return { kind: "created" as const, record };
    });
    if (result.kind === "duplicate") return result;
    const capture = Object.freeze({
      workspaceId: result.record.workspaceId,
      generationId: result.record.id,
      runtimeEpoch: this.#epoch,
    });
    this.#owners.set(capture, { record: result.record });
    this.#liveOwners.add(capture);
    return { ...result, capture };
  }
  private saveGeneration(
    previous: KnowledgeGenerationRecord,
    next: KnowledgeGenerationRecord,
  ): void {
    validateRecord(next);
    const result = this.#db
      .prepare(
        "UPDATE knowledge_generations SET state=?,revision=?,data=? WHERE id=? AND workspace_id=? AND revision=? AND data=?",
      )
      .run(
        next.state,
        next.revision,
        JSON.stringify(next),
        previous.id,
        previous.workspaceId,
        previous.revision,
        JSON.stringify(previous),
      );
    if (result.changes !== 1)
      knowledgeError(
        "KNOWLEDGE_GENERATION_STALE",
        "Native generation CAS failed",
      );
  }
  private saveAttempt(
    previous: KnowledgeGenerationAttempt,
    next: KnowledgeGenerationAttempt,
  ): void {
    validateAttempt(next);
    const result = this.#db
      .prepare(
        "UPDATE knowledge_generation_attempts SET state=?,revision=?,data=? WHERE id=? AND workspace_id=? AND revision=? AND data=?",
      )
      .run(
        next.state,
        next.revision,
        JSON.stringify(next),
        previous.id,
        previous.workspaceId,
        previous.revision,
        JSON.stringify(previous),
      );
    if (result.changes !== 1)
      knowledgeError("KNOWLEDGE_GENERATION_STALE", "Native attempt CAS failed");
  }
  prepareAttempt(
    capture: KnowledgeGenerationCapture,
    input: { id: string; sha256: string; bytes: number },
  ): {
    capture: KnowledgeGenerationAttemptCapture;
    record: KnowledgeGenerationAttempt;
  } {
    const value = immutableKnowledgeJson(input);
    exact(value, ["id", "sha256", "bytes"]);
    identifier(value.id);
    assertKnowledgeGenerationDigest(value.sha256);
    if (!integer(value.bytes, 262_144))
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Exact dispatch size must be positive",
      );
    const result = this.write(() => {
      const { generation } = this.active(capture);
      if (generation.state !== "prepared" || generation.attemptId !== null)
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Only one original attempt may be prepared",
        );
      this.fresh(generation);
      this.active(capture);
      const time = new Date(
        this.now(Date.parse(generation.updatedAt)),
      ).toISOString();
      const record = validateAttempt(
        hashRecord({
          id: value.id,
          workspaceId: generation.workspaceId,
          generationId: generation.id,
          planId: generation.planId,
          runtimeEpoch: this.#epoch,
          revision: 1,
          state: "prepared" as const,
          exactDispatchSha256: value.sha256,
          exactDispatchBytes: value.bytes,
          createdAt: time,
          updatedAt: time,
          dispatchedAt: null,
          output: "",
          outputSha256: sha256(""),
          outputBytes: 0,
          observedTextBytes: 0,
          outputTruncated: false,
          observationBytes: 0,
          events: 0,
          usage: UNKNOWN_USAGE,
          providerRequestId: null,
          finishReason: null,
          streamDone: false,
          cleanup: null,
          errorCode: null,
        }),
      );
      const next = updated(generation, {
        attemptId: record.id,
        revision: generation.revision + 1,
        updatedAt: time,
      });
      this.#db
        .prepare(
          "INSERT INTO knowledge_generation_attempts(id,workspace_id,generation_id,plan_id,state,revision,data) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          record.id,
          record.workspaceId,
          record.generationId,
          record.planId,
          record.state,
          record.revision,
          JSON.stringify(record),
        );
      this.saveGeneration(generation, next);
      return { record, generation: next };
    });
    this.owned(capture).record = result.generation;
    const attempt = Object.freeze({
      workspaceId: result.record.workspaceId,
      generationId: result.record.generationId,
      attemptId: result.record.id,
      runtimeEpoch: this.#epoch,
    });
    this.#attempts.set(attempt, { record: result.record, owner: capture });
    this.#liveAttempts.add(attempt);
    return { capture: attempt, record: result.record };
  }

  private remember(
    owner: KnowledgeGenerationCapture,
    attempt: KnowledgeGenerationAttemptCapture,
    result: {
      generation: KnowledgeGenerationRecord;
      attempt: KnowledgeGenerationAttempt;
    },
  ): void {
    this.owned(owner).record = result.generation;
    this.attempted(owner, attempt).record = result.attempt;
  }
  dispatch(
    owner: KnowledgeGenerationCapture,
    attempt: KnowledgeGenerationAttemptCapture,
  ): KnowledgeGenerationRecord {
    const result = this.write(() => {
      const current = this.active(owner, attempt),
        old = current.attempt!;
      if (
        current.generation.state !== "prepared" ||
        old.state !== "prepared" ||
        old.dispatchedAt !== null
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Only an original undispatched attempt may enter its provider",
        );
      this.fresh(current.generation);
      this.active(owner, attempt);
      const time = new Date(
        this.now(Date.parse(current.generation.updatedAt)),
      ).toISOString();
      const nextAttempt = updated(old, {
        state: "dispatched",
        revision: old.revision + 1,
        dispatchedAt: time,
        updatedAt: time,
      });
      const next = updated(current.generation, {
        state: "dispatched",
        revision: current.generation.revision + 1,
        updatedAt: time,
      });
      this.saveAttempt(old, nextAttempt);
      this.saveGeneration(current.generation, next);
      return { generation: next, attempt: nextAttempt };
    });
    this.remember(owner, attempt, result);
    return result.generation;
  }
  observe(
    owner: KnowledgeGenerationCapture,
    attempt: KnowledgeGenerationAttemptCapture,
    input: KnowledgeGenerationObservation,
  ): KnowledgeGenerationAttempt {
    const value = immutableKnowledgeJson(input);
    exact(
      value,
      ["observationBytes"],
      [
        "textDelta",
        "textBytes",
        "outputTruncated",
        "usage",
        "providerRequestId",
        "finishReason",
        "streamDone",
        "eventCount",
      ],
    );
    integer(value.observationBytes);
    if (value.textDelta !== undefined) text(value.textDelta, 16_384);
    if (value.textBytes !== undefined) integer(value.textBytes);
    if (
      (value.outputTruncated !== undefined && value.outputTruncated !== true) ||
      (value.streamDone !== undefined && value.streamDone !== true) ||
      (value.finishReason !== undefined && value.finishReason !== "stop")
    )
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Unsupported native stream observation",
      );
    if (value.providerRequestId !== undefined)
      identifier(value.providerRequestId);
    if (value.usage !== undefined) validateUsage(value.usage);
    if (value.eventCount !== undefined) integer(value.eventCount);
    const result = this.write(() => {
      const current = this.active(owner, attempt),
        old = current.attempt!,
        g = current.generation;
      if (old.dispatchedAt === null || old.streamDone)
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Observation must belong to the original dispatched, unfinished iterator",
        );
      if (
        old.outputTruncated ||
        old.observationBytes > g.budget.maxObservationBytes ||
        old.events > g.budget.maxEvents ||
        old.observedTextBytes > g.budget.maxOutputBytes
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_LIMIT",
          "Original native observation budget was already exceeded",
        );
      const delta = value.textDelta ?? "",
        retained = Buffer.byteLength(delta),
        charge = value.textBytes ?? retained;
      if (
        charge < retained ||
        (charge !== retained && value.outputTruncated !== true) ||
        (value.textBytes !== undefined && value.textDelta === undefined)
      )
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION",
          "Actual output charge must describe this retained delta",
        );
      if (
        old.finishReason !== null &&
        (value.textDelta !== undefined || value.finishReason !== undefined)
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Text or another finish cannot follow the original terminal finish",
        );
      if (
        value.streamDone &&
        (value.textDelta !== undefined ||
          value.finishReason !== undefined ||
          value.usage !== undefined ||
          value.providerRequestId !== undefined)
      )
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION",
          "Iterator done is a separate final observation",
        );
      const output = old.output + delta;
      if (Buffer.byteLength(output) > g.budget.maxOutputBytes)
        knowledgeError(
          "KNOWLEDGE_GENERATION_LIMIT",
          "Retained native output exceeds its original budget",
        );
      const observedTextBytes = integer(old.observedTextBytes + charge),
        observationBytes = integer(
          old.observationBytes + value.observationBytes,
        ),
        events = value.eventCount ?? old.events + (value.streamDone ? 0 : 1);
      if (
        events < old.events ||
        events > old.events + 1 ||
        (value.streamDone && events !== old.events)
      )
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION",
          "Native event frontier must count one actual provider event and no synthetic done event",
        );
      let usage = old.usage;
      if (value.usage !== undefined) {
        const supplied = validateUsage(value.usage);
        for (const key of Object.keys(usage) as (keyof KnowledgeUsage)[])
          if (
            usage[key] !== null &&
            (supplied[key] === null || supplied[key]! < usage[key]!)
          )
            knowledgeError(
              "INVALID_KNOWLEDGE_GENERATION",
              "Native cumulative usage cannot lose or decrease a known observation",
            );
        usage = supplied;
      }
      if (
        old.providerRequestId !== null &&
        value.providerRequestId !== undefined &&
        value.providerRequestId !== old.providerRequestId
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_BINDING_MISMATCH",
          "Provider request identity changed within one native attempt",
        );
      const time = new Date(this.now(Date.parse(g.updatedAt))).toISOString(),
        state =
          value.finishReason !== undefined || old.finishReason !== null
            ? "output-finished"
            : "streaming";
      const nextAttempt = updated(old, {
        state,
        revision: old.revision + 1,
        updatedAt: time,
        output,
        outputSha256: sha256(output),
        outputBytes: Buffer.byteLength(output),
        observedTextBytes,
        outputTruncated: old.outputTruncated || value.outputTruncated === true,
        observationBytes,
        events,
        usage,
        providerRequestId: value.providerRequestId ?? old.providerRequestId,
        finishReason: value.finishReason ?? old.finishReason,
        streamDone: value.streamDone ?? old.streamDone,
      });
      const next = updated(g, {
        state,
        revision: g.revision + 1,
        updatedAt: time,
      });
      this.saveAttempt(old, nextAttempt);
      this.saveGeneration(g, next);
      return { generation: next, attempt: nextAttempt };
    });
    this.remember(owner, attempt, result);
    return result.attempt;
  }
  settle(
    owner: KnowledgeGenerationCapture,
    attempt: KnowledgeGenerationAttemptCapture,
    input: KnowledgeGenerationSettlement,
  ): KnowledgeGenerationRecord {
    const value = immutableKnowledgeJson(input);
    exact(value, ["state", "cleanup"], ["errorCode", "candidate"]);
    if (
      !["completed", "failed", "cancelled", "uncertain"].includes(value.state)
    )
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Native settlement must be terminal",
      );
    const observedCleanup = cleanup(value.cleanup);
    if (value.errorCode !== undefined) identifier(value.errorCode);
    if (value.candidate !== undefined) {
      exact(
        value.candidate,
        ["state"],
        value.candidate.state === "withheld" ? ["reason"] : [],
      );
      if (
        value.candidate.state !== "pending" &&
        value.candidate.state !== "withheld"
      )
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION",
          "Unknown settlement candidate state",
        );
      if (
        value.candidate.state === "withheld" &&
        !text(value.candidate.reason, 2_048).trim()
      )
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION",
          "Withheld output requires a reason",
        );
    }
    const result = this.write(() => {
      const current = this.active(owner, attempt),
        old = current.attempt!,
        g = current.generation;
      let state = value.state;
      if (!observedCleanup.confirmed) state = "uncertain";
      if (
        old.dispatchedAt === null &&
        observedCleanup.method !== "not-dispatched"
      )
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION",
          "An attempt without dispatch intent cannot assert provider cleanup",
        );
      if (state === "uncertain" && old.dispatchedAt === null)
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION",
          "Never-dispatched native work cannot acquire invented uncertainty",
        );
      if (
        state === "completed" &&
        (!old.streamDone ||
          old.finishReason !== "stop" ||
          !old.output.trim() ||
          old.outputTruncated ||
          old.observedTextBytes > g.budget.maxOutputBytes ||
          old.observationBytes > g.budget.maxObservationBytes ||
          old.events > g.budget.maxEvents ||
          observedCleanup.method !== "iterator-complete" ||
          this.now() >= g.deadline)
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_INCOMPLETE",
          "Successful native output requires stop, actual iterator done, confirmed cleanup and the original budget",
        );
      if (
        (state === "completed" && value.errorCode !== undefined) ||
        (state !== "completed" && value.candidate?.state === "pending") ||
        (state === "uncertain" && observedCleanup.confirmed)
      )
        knowledgeError(
          "INVALID_KNOWLEDGE_GENERATION",
          "Terminal outcome cannot confer inconsistent output authority",
        );
      const time = new Date(this.now(Date.parse(g.updatedAt))).toISOString(),
        errorCode =
          state === "completed"
            ? null
            : (value.errorCode ??
              (state === "uncertain"
                ? "CLEANUP_UNCERTAIN"
                : "KNOWLEDGE_GENERATION_FAILED")),
        candidate =
          state === "completed" && value.candidate?.state !== "withheld"
            ? { state: "pending" as const, candidateId: null, reason: null }
            : {
                state: "withheld" as const,
                candidateId: null,
                reason:
                  value.candidate?.state === "withheld"
                    ? value.candidate.reason
                    : errorCode!,
              };
      const nextAttempt = updated(old, {
        state,
        revision: old.revision + 1,
        updatedAt: time,
        cleanup: observedCleanup,
        errorCode,
      });
      const next = updated(g, {
        state,
        revision: g.revision + 1,
        updatedAt: time,
        errorCode,
        candidate,
      });
      this.saveAttempt(old, nextAttempt);
      this.saveGeneration(g, next);
      if (state === "uncertain") this.setBarrier(g.workspaceId, "blocked");
      return { generation: next, attempt: nextAttempt };
    });
    this.remember(owner, attempt, result);
    return result.generation;
  }
  failPrepared(
    owner: KnowledgeGenerationCapture,
    errorCode: string,
  ): KnowledgeGenerationRecord {
    identifier(errorCode);
    const result = this.write(() => {
      const { generation: g } = this.active(owner);
      if (g.state !== "prepared")
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Only work without provider intent may fail as prepared",
        );
      const time = new Date(this.now(Date.parse(g.updatedAt))).toISOString(),
        state = errorCode.includes("CANCEL") ? "cancelled" : "failed";
      let attempt: KnowledgeGenerationAttempt | null = null;
      if (g.attemptId) {
        const old = this.getAttempt(g.workspaceId, g.attemptId);
        if (old.state !== "prepared" || old.dispatchedAt !== null)
          knowledgeError(
            "KNOWLEDGE_GENERATION_STALE",
            "Prepared failure cannot erase provider intent",
          );
        attempt = updated(old, {
          state,
          revision: old.revision + 1,
          updatedAt: time,
          cleanup: { confirmed: true, method: "not-dispatched", reason: null },
          errorCode,
        });
        this.saveAttempt(old, attempt);
      }
      const next = updated(g, {
        state,
        revision: g.revision + 1,
        updatedAt: time,
        errorCode,
        candidate: { state: "withheld", candidateId: null, reason: errorCode },
      });
      this.saveGeneration(g, next);
      return { generation: next, attempt };
    });
    this.owned(owner).record = result.generation;
    for (const capture of this.#liveAttempts) {
      const a = this.#attempts.get(capture);
      if (a?.owner === owner && result.attempt) a.record = result.attempt;
    }
    return result.generation;
  }
  markCandidate(
    workspaceId: string,
    generationId: string,
    input:
      | { state: "recorded"; candidateId: string }
      | { state: "withheld"; reason: string },
  ): KnowledgeGenerationRecord {
    const value = immutableKnowledgeJson(input);
    exact(
      value,
      value.state === "recorded"
        ? ["state", "candidateId"]
        : ["state", "reason"],
    );
    if (value.state === "recorded") identifier(value.candidateId);
    else if (value.state !== "withheld" || !text(value.reason, 2_048).trim())
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Native candidate decision must be bounded exact data",
      );
    return this.write(() => {
      const g = this.getGeneration(workspaceId, generationId);
      if (g.state !== "completed")
        knowledgeError(
          "KNOWLEDGE_GENERATION_INCOMPLETE",
          "Only native completed output has a candidate disposition",
        );
      const candidate =
        value.state === "recorded"
          ? {
              state: "recorded" as const,
              candidateId: value.candidateId,
              reason: null,
            }
          : {
              state: "withheld" as const,
              candidateId: null,
              reason: value.reason,
            };
      if (knowledgeHash(candidate) === knowledgeHash(g.candidate)) return g;
      if (g.candidate.state === "recorded")
        knowledgeError(
          "KNOWLEDGE_RECORD_CONFLICT",
          "A recorded immutable candidate cannot be replaced or erased",
        );
      if (value.state === "recorded") {
        const plan = this.plan(workspaceId, g.planId);
        this.readEvidence(plan, g.id);
        const raw = this.#db
          .prepare(
            "SELECT data FROM knowledge_candidates WHERE workspace_id=? AND id=? AND generation_owner_id=?",
          )
          .get(workspaceId, value.candidateId, g.id) as
          { data: string } | undefined;
        if (!raw || Buffer.byteLength(raw.data) > 65_536)
          knowledgeError(
            "KNOWLEDGE_RECORD_CONFLICT",
            "Native candidate must already exist under this actual owner",
          );
        const body = JSON.parse(raw.data) as {
          planId: string;
          bodySha256: string;
          requestSha256: string;
          body: string;
        };
        const a = this.getAttempt(workspaceId, g.attemptId!);
        if (
          body.planId !== g.planId ||
          body.bodySha256 !== a.outputSha256 ||
          body.requestSha256 !== g.logicalRequestSha256 ||
          body.body !== a.output
        )
          knowledgeError(
            "KNOWLEDGE_RECORD_CONFLICT",
            "Actual candidate does not match exact native output",
          );
      }
      const next = updated(g, {
        revision: g.revision + 1,
        updatedAt: new Date(this.now(Date.parse(g.updatedAt))).toISOString(),
        candidate,
      });
      this.saveGeneration(g, next);
      return next;
    });
  }
  readEvidence(
    planInput: KnowledgeGenerationPlan,
    ownerId: string,
  ): KnowledgeGenerationEvidence {
    const plan = validateGenerationPlan(planInput),
      g = this.getGeneration(plan.workspaceId, ownerId);
    this.assertBinding(g.binding);
    const stored = this.plan(plan.workspaceId, plan.id);
    if (
      plan.id !== g.planId ||
      plan.sha256 !== g.planSha256 ||
      stored.sha256 !== plan.sha256 ||
      plan.requestSha256 !== g.logicalRequestSha256 ||
      plan.requestBytes !== g.logicalRequestBytes
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_BINDING_MISMATCH",
        "Native owner does not describe this exact current plan",
      );
    if (this.#ports.assertPlanCurrent(plan) !== undefined)
      knowledgeError(
        "KNOWLEDGE_ASYNC_PORT",
        "Evidence freshness must be synchronous",
      );
    this.assertBinding(g.binding);
    if (g.state !== "completed" || g.attemptId === null)
      knowledgeError(
        "KNOWLEDGE_GENERATION_INCOMPLETE",
        "Only actual completed native owners provide candidate evidence",
      );
    const a = this.getAttempt(plan.workspaceId, g.attemptId);
    if (
      a.state !== "completed" ||
      a.generationId !== g.id ||
      a.planId !== g.planId ||
      a.runtimeEpoch !== g.runtimeEpoch ||
      !a.streamDone ||
      a.finishReason !== "stop" ||
      !a.cleanup?.confirmed ||
      a.outputTruncated ||
      a.outputBytes > g.budget.maxOutputBytes ||
      a.observationBytes > g.budget.maxObservationBytes ||
      a.events > g.budget.maxEvents
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_BINDING_MISMATCH",
        "Native output and cleanup do not belong to the original owner",
      );
    return immutableKnowledgeJson({
      ownerId: g.id,
      planId: g.planId,
      workspaceId: g.workspaceId,
      bindingSha256: knowledgeHash(g.binding),
      requestSha256: g.logicalRequestSha256,
      providerId: g.providerId,
      modelId: g.modelId,
      outputSha256: a.outputSha256,
      outputBytes: a.outputBytes,
      toolCount: 0 as const,
      completed: true as const,
      cleanupConfirmed: true as const,
      usage: a.usage,
    });
  }
  private abandon(owner: KnowledgeGenerationCapture): void {
    const issued = this.owned(owner),
      g = this.getGeneration(issued.record.workspaceId, issued.record.id);
    if (!ACTIVE.has(g.state)) return;
    if (g.state === "prepared") {
      this.failPrepared(owner, "KNOWLEDGE_GENERATION_CANCELLED");
      return;
    }
    const result = this.write(() => {
      const current = this.getGeneration(g.workspaceId, g.id);
      if (!ACTIVE.has(current.state)) return null;
      if (
        current.sha256 !== issued.record.sha256 ||
        current.runtimeEpoch !== this.#epoch
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Cannot abandon another epoch native owner",
        );
      const a = this.getAttempt(g.workspaceId, current.attemptId!);
      const time = new Date(
          this.now(Date.parse(current.updatedAt)),
        ).toISOString(),
        errorCode = "KNOWLEDGE_GENERATION_SETTLEMENT_UNCERTAIN";
      const nextAttempt = updated(a, {
        state: "uncertain",
        revision: a.revision + 1,
        updatedAt: time,
        cleanup: { confirmed: false, method: "unknown", reason: errorCode },
        errorCode,
      });
      const next = updated(current, {
        state: "uncertain",
        revision: current.revision + 1,
        updatedAt: time,
        errorCode,
        candidate: { state: "withheld", candidateId: null, reason: errorCode },
      });
      this.saveAttempt(a, nextAttempt);
      this.saveGeneration(current, next);
      this.setBarrier(g.workspaceId, "blocked");
      return { generation: next, attempt: nextAttempt };
    });
    if (result) {
      issued.record = result.generation;
      for (const capture of this.#liveAttempts) {
        const a = this.#attempts.get(capture);
        if (a?.owner === owner) a.record = result.attempt;
      }
    }
  }
  release(owner: KnowledgeGenerationCapture): void {
    this.owned(owner);
    this.abandon(owner);
    this.#liveOwners.delete(owner);
    this.#owners.delete(owner);
  }
  releaseAttempt(attempt: KnowledgeGenerationAttemptCapture): void {
    if (
      !attempt ||
      typeof attempt !== "object" ||
      !this.#liveAttempts.has(attempt)
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_HANDLE_INVALID",
        "Attempt capture is foreign or released",
      );
    const a = this.#attempts.get(attempt)!;
    this.abandon(a.owner);
    this.#liveAttempts.delete(attempt);
    this.#attempts.delete(attempt);
  }
  hasBlocker(workspaceId: string): boolean {
    return hasKnowledgeGenerationBlocker(this.#db, workspaceId);
  }
  getBarrier(
    workspaceId: string,
  ): KnowledgeGenerationWorkspaceBarrier | undefined {
    identifier(workspaceId);
    const row = this.#db
      .prepare(
        "SELECT * FROM knowledge_generation_workspace_barriers WHERE workspace_id=?",
      )
      .get(workspaceId) as Row | undefined;
    return row
      ? (decode(
          row,
          "knowledge_generation_workspace_barriers",
        ) as KnowledgeGenerationWorkspaceBarrier)
      : undefined;
  }
  private frontier(workspaceId: string): {
    generations: KnowledgeGenerationRecord[];
    attempts: KnowledgeGenerationAttempt[];
    sha256: string;
  } {
    const { rows, generations } = unresolvedGenerations(this.#db, workspaceId);
    let readBytes = rows.reduce((n, row) => n + Buffer.byteLength(row.data), 0);
    const attempts: KnowledgeGenerationAttempt[] = [];
    for (const generation of generations)
      if (generation.attemptId) {
        const projected = boundedRows(
          this.#db,
          "SELECT * FROM knowledge_generation_attempts WHERE workspace_id=? AND id=?",
          [workspaceId, generation.attemptId],
          MAX_READ_BYTES - readBytes,
        );
        if (!projected.length)
          knowledgeError(
            "KNOWLEDGE_RECORD_CONFLICT",
            "Native frontier has no actual attempt",
          );
        readBytes += Buffer.byteLength(projected[0]!.data);
        const attempt = decode(
          projected[0]!,
          "knowledge_generation_attempts",
        ) as KnowledgeGenerationAttempt;
        if (
          attempt.generationId !== generation.id ||
          attempt.planId !== generation.planId ||
          attempt.runtimeEpoch !== generation.runtimeEpoch ||
          attempt.state !== generation.state
        )
          knowledgeError(
            "KNOWLEDGE_RECORD_CONFLICT",
            "Recovery native generation and attempt frontiers disagree",
          );
        attempts.push(attempt);
      }
    if (
      Buffer.byteLength(JSON.stringify({ generations, attempts })) >
      MAX_READ_BYTES
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_LIMIT",
        "Native recovery projection exceeds its byte budget",
      );
    return {
      generations,
      attempts,
      sha256: knowledgeHash({
        generations: generations.map((g) => ({ id: g.id, sha256: g.sha256 })),
        attempts: attempts.map((a) => ({ id: a.id, sha256: a.sha256 })),
      }),
    };
  }
  private setBarrier(
    workspaceId: string,
    state: KnowledgeGenerationWorkspaceBarrier["state"],
  ): KnowledgeGenerationWorkspaceBarrier {
    const previous = this.getBarrier(workspaceId),
      frontier = this.frontier(workspaceId);
    const next = validateBarrier(
      hashRecord({
        workspaceId,
        revision: (previous?.revision ?? 0) + 1,
        state,
        frontierSha256: frontier.sha256,
        updatedAt: new Date(
          this.now(previous ? Date.parse(previous.updatedAt) : 0),
        ).toISOString(),
      }),
    );
    if (previous) {
      const result = this.#db
        .prepare(
          "UPDATE knowledge_generation_workspace_barriers SET state=?,revision=?,data=? WHERE workspace_id=? AND revision=? AND data=?",
        )
        .run(
          next.state,
          next.revision,
          JSON.stringify(next),
          workspaceId,
          previous.revision,
          JSON.stringify(previous),
        );
      if (result.changes !== 1)
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Workspace recovery barrier CAS failed",
        );
    } else
      this.#db
        .prepare(
          "INSERT INTO knowledge_generation_workspace_barriers(id,workspace_id,state,revision,data) VALUES(?,?,?,?,?)",
        )
        .run(
          workspaceId,
          workspaceId,
          next.state,
          next.revision,
          JSON.stringify(next),
        );
    return next;
  }
  recoverInterruptedOwners(): {
    recovered: number;
    cancelled: number;
    uncertain: number;
  } {
    const summary = { recovered: 0, cancelled: 0, uncertain: 0 };
    for (;;) {
      const ids = this.#db
        .prepare(
          "SELECT id,workspace_id FROM knowledge_generations WHERE state IN ('prepared','dispatched','streaming','output-finished') AND json_extract(data,'$.runtimeEpoch')<>? ORDER BY id LIMIT 16",
        )
        .all(this.#epoch) as { id: string; workspace_id: string }[];
      if (!ids.length) break;
      if (summary.recovered + ids.length > 4_096)
        knowledgeError(
          "KNOWLEDGE_GENERATION_LIMIT",
          "Interrupted native owner sweep reached its bound",
        );
      const batch = this.write(() => {
        const counts = { recovered: 0, cancelled: 0, uncertain: 0 };
        for (const id of ids) {
          const g = this.getGeneration(id.workspace_id, id.id);
          if (!ACTIVE.has(g.state) || g.runtimeEpoch === this.#epoch) continue;
          const a = g.attemptId
            ? this.getAttempt(g.workspaceId, g.attemptId)
            : null;
          if (
            a &&
            (a.generationId !== g.id ||
              a.planId !== g.planId ||
              a.runtimeEpoch !== g.runtimeEpoch ||
              a.state !== g.state)
          )
            knowledgeError(
              "KNOWLEDGE_RECORD_CONFLICT",
              "Interrupted native attempt scope differs from its owner",
            );
          if (!a && g.state !== "prepared")
            knowledgeError(
              "KNOWLEDGE_RECORD_CONFLICT",
              "Dispatched native generation has no original attempt",
            );
          const intended = a?.dispatchedAt !== null && a !== null,
            state = intended ? "uncertain" : "cancelled",
            errorCode = intended
              ? "KNOWLEDGE_GENERATION_INTERRUPTED_UNCERTAIN"
              : "KNOWLEDGE_GENERATION_INTERRUPTED_NOT_DISPATCHED",
            time = new Date(this.now(Date.parse(g.updatedAt))).toISOString();
          if (a)
            this.saveAttempt(
              a,
              updated(a, {
                state,
                revision: a.revision + 1,
                updatedAt: time,
                errorCode,
                cleanup: {
                  confirmed: !intended,
                  method: intended ? "unknown" : "not-dispatched",
                  reason: errorCode,
                },
              }),
            );
          this.saveGeneration(
            g,
            updated(g, {
              state,
              revision: g.revision + 1,
              updatedAt: time,
              errorCode,
              candidate: {
                state: "withheld",
                candidateId: null,
                reason: errorCode,
              },
            }),
          );
          if (intended) this.setBarrier(g.workspaceId, "blocked");
          counts.recovered++;
          counts[state]++;
        }
        return counts;
      });
      summary.recovered += batch.recovered;
      summary.cancelled += batch.cancelled;
      summary.uncertain += batch.uncertain;
    }
    return summary;
  }
  getRecoveryPreview(workspaceId: string): KnowledgeGenerationRecoveryPreview {
    identifier(workspaceId);
    const previous = this.#livePreviews.get(workspaceId);
    if (!previous && this.#livePreviews.size >= 128)
      knowledgeError(
        "KNOWLEDGE_GENERATION_LIMIT",
        "Recovery preview capture limit reached",
      );
    const binding = this.binding(workspaceId),
      frontier = this.frontier(workspaceId),
      barrier = this.getBarrier(workspaceId);
    if (frontier.generations.some((g) => ACTIVE.has(g.state)))
      knowledgeError(
        "KNOWLEDGE_GENERATION_ACTIVE",
        "Active original native work must settle before host recovery",
      );
    if (!frontier.generations.length)
      knowledgeError(
        "KNOWLEDGE_GENERATION_RECOVERY_EMPTY",
        "No unresolved native generation is available to acknowledge",
      );
    for (const g of frontier.generations)
      if (knowledgeHash(g.binding) !== knowledgeHash(binding))
        knowledgeError(
          "KNOWLEDGE_BINDING_MISMATCH",
          "Recovery cannot acknowledge another physical source or storage binding",
        );
    const body = {
      workspaceId,
      runtimeEpoch: this.#epoch,
      binding,
      barrierRevision: barrier?.revision ?? 0,
      frontierSha256: frontier.sha256,
      generations: Object.freeze(frontier.generations),
      attempts: Object.freeze(frontier.attempts),
    };
    const preview = Object.freeze({ ...body, sha256: knowledgeHash(body) });
    if (Buffer.byteLength(JSON.stringify(preview)) > MAX_READ_BYTES)
      knowledgeError(
        "KNOWLEDGE_GENERATION_LIMIT",
        "Native recovery preview exceeds its bounded projection",
      );
    if (previous) this.releaseRecoveryPreview(previous);
    this.#previews.set(preview, preview);
    this.#livePreviews.set(workspaceId, preview);
    return preview;
  }
  private receipt(
    workspaceId: string,
    requestId: string,
    fingerprint: string,
  ): KnowledgeGenerationRecoveryAcknowledgment | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM knowledge_generation_recovery_acknowledgments WHERE workspace_id=? AND request_id=?",
      )
      .get(workspaceId, requestId) as Row | undefined;
    if (!row) return undefined;
    const ack = decode(
      row,
      "knowledge_generation_recovery_acknowledgments",
    ) as KnowledgeGenerationRecoveryAcknowledgment;
    if (ack.requestSha256 !== fingerprint)
      knowledgeError(
        "KNOWLEDGE_REQUEST_CONFLICT",
        "Recovery request ID was used with another exact host decision",
      );
    return ack;
  }
  private insertAck(ack: KnowledgeGenerationRecoveryAcknowledgment): void {
    validateAck(ack);
    this.#db
      .prepare(
        "INSERT INTO knowledge_generation_recovery_acknowledgments(id,workspace_id,request_id,operation,data) VALUES(?,?,?,?,?)",
      )
      .run(
        ack.id,
        ack.workspaceId,
        ack.requestId,
        ack.operation,
        JSON.stringify(ack),
      );
  }
  acknowledgeRecovery(
    preview: KnowledgeGenerationRecoveryPreview,
    input: { requestId: string; reason: string },
  ): KnowledgeGenerationRecoveryResult {
    if (
      !preview ||
      typeof preview !== "object" ||
      this.#previews.get(preview) !== preview
    )
      knowledgeError(
        "KNOWLEDGE_GENERATION_HANDLE_INVALID",
        "Recovery requires its original instance-owned preview",
      );
    const value = immutableKnowledgeJson(input);
    exact(value, ["requestId", "reason"]);
    identifier(value.requestId);
    if (!text(value.reason, 2_048).trim())
      knowledgeError(
        "INVALID_KNOWLEDGE_GENERATION",
        "Host recovery acknowledgment needs a reason",
      );
    const fingerprint = knowledgeHash({
      operation: "acknowledge",
      previewSha256: preview.sha256,
      ...value,
    });
    const result = this.write(() => {
      this.assertBinding(preview.binding);
      const duplicate = this.receipt(
        preview.workspaceId,
        value.requestId,
        fingerprint,
      );
      if (duplicate)
        return {
          acknowledgment: duplicate,
          barrier:
            this.getBarrier(preview.workspaceId) ??
            knowledgeError(
              "KNOWLEDGE_RECORD_CONFLICT",
              "Recovery receipt has no workspace barrier",
            ),
        };
      const frontier = this.frontier(preview.workspaceId),
        barrier = this.getBarrier(preview.workspaceId);
      if (
        preview.runtimeEpoch !== this.#epoch ||
        frontier.sha256 !== preview.frontierSha256 ||
        (barrier?.revision ?? 0) !== preview.barrierRevision ||
        frontier.generations.some((g) => g.state !== "uncertain")
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Native recovery frontier changed after host preview",
        );
      const acknowledgment = validateAck(
        hashRecord({
          id: randomUUID(),
          workspaceId: preview.workspaceId,
          requestId: value.requestId,
          operation: "acknowledge" as const,
          requestSha256: fingerprint,
          binding: preview.binding,
          runtimeEpoch: this.#epoch,
          expectedBarrierRevision: preview.barrierRevision,
          frontierSha256: preview.frontierSha256,
          generations: preview.generations.map((g) => ({
            id: g.id,
            sha256: g.sha256,
          })),
          reason: value.reason,
          createdAt: new Date(this.now()).toISOString(),
        }),
      );
      this.insertAck(acknowledgment);
      const next = this.setBarrier(
        preview.workspaceId,
        this.frontier(preview.workspaceId).generations.length
          ? "blocked"
          : "pending-resume",
      );
      return { acknowledgment, barrier: next };
    });
    return result;
  }
  resumeWorkspace(input: {
    workspaceId: string;
    requestId: string;
    expectedRevision: number;
    expectedFrontierSha256: string;
  }): KnowledgeGenerationRecoveryResult {
    const value = immutableKnowledgeJson(input);
    exact(value, [
      "workspaceId",
      "requestId",
      "expectedRevision",
      "expectedFrontierSha256",
    ]);
    identifier(value.workspaceId);
    identifier(value.requestId);
    integer(value.expectedRevision);
    assertKnowledgeGenerationDigest(value.expectedFrontierSha256);
    const fingerprint = knowledgeHash({ operation: "resume", ...value });
    return this.write(() => {
      const binding = this.binding(value.workspaceId),
        duplicate = this.receipt(
          value.workspaceId,
          value.requestId,
          fingerprint,
        );
      if (duplicate) {
        if (knowledgeHash(duplicate.binding) !== knowledgeHash(binding))
          knowledgeError(
            "KNOWLEDGE_BINDING_MISMATCH",
            "Resume receipt belongs to another physical binding",
          );
        return {
          acknowledgment: duplicate,
          barrier:
            this.getBarrier(value.workspaceId) ??
            knowledgeError(
              "KNOWLEDGE_RECORD_CONFLICT",
              "Resume receipt has no barrier",
            ),
        };
      }
      const frontier = this.frontier(value.workspaceId),
        barrier = this.getBarrier(value.workspaceId);
      if (
        !barrier ||
        barrier.state !== "pending-resume" ||
        barrier.revision !== value.expectedRevision ||
        barrier.frontierSha256 !== value.expectedFrontierSha256 ||
        frontier.sha256 !== value.expectedFrontierSha256 ||
        frontier.generations.length
      )
        knowledgeError(
          "KNOWLEDGE_GENERATION_STALE",
          "Explicit resume needs the exact acknowledged empty native frontier",
        );
      const acknowledgment = validateAck(
        hashRecord({
          id: randomUUID(),
          workspaceId: value.workspaceId,
          requestId: value.requestId,
          operation: "resume" as const,
          requestSha256: fingerprint,
          binding,
          runtimeEpoch: this.#epoch,
          expectedBarrierRevision: barrier.revision,
          frontierSha256: frontier.sha256,
          generations: [],
          reason: null,
          createdAt: new Date(this.now()).toISOString(),
        }),
      );
      this.insertAck(acknowledgment);
      return {
        acknowledgment,
        barrier: this.setBarrier(value.workspaceId, "clear"),
      };
    });
  }
  releaseRecoveryPreview(preview: KnowledgeGenerationRecoveryPreview): void {
    if (!preview || this.#previews.get(preview) !== preview)
      knowledgeError(
        "KNOWLEDGE_GENERATION_HANDLE_INVALID",
        "Recovery preview is foreign or released",
      );
    this.#livePreviews.delete(preview.workspaceId);
    this.#previews.delete(preview);
  }
}
