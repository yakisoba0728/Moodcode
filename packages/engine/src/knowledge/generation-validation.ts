import { verifySealed } from "../shared/canonical.js";
import type { KnowledgeCandidate } from "./types.js";
import type {
  KnowledgeGenerationArchiveRow,
  KnowledgeGenerationAttempt,
  KnowledgeGenerationCleanup,
  KnowledgeGenerationRecord,
  KnowledgeGenerationRecoveryAcknowledgment,
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
  sameKnowledge,
  sha256,
  stamp,
  validateBinding,
  validateUsage,
} from "./validation.js";

export const KNOWLEDGE_GENERATION_TABLES = Object.freeze([
  "knowledge_generations",
  "knowledge_generation_attempts",
  "knowledge_generation_recovery_acknowledgments",
  "knowledge_generation_workspace_barriers",
] as const);
/** SQL columns that mirror native generation body fields. */
export const KNOWLEDGE_GENERATION_COLUMNS: Readonly<
  Record<KnowledgeGenerationTable, Readonly<Record<string, string>>>
> = Object.freeze({
  knowledge_generations: {
    plan_id: "planId",
    request_id: "requestId",
    state: "state",
    revision: "revision",
  },
  knowledge_generation_attempts: {
    generation_id: "generationId",
    plan_id: "planId",
    state: "state",
    revision: "revision",
  },
  knowledge_generation_recovery_acknowledgments: {
    request_id: "requestId",
    operation: "operation",
  },
  knowledge_generation_workspace_barriers: {
    state: "state",
    revision: "revision",
  },
});
export const ACTIVE = new Set([
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
export function exact(
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
function checkHash(record: { readonly sha256: string }): void {
  assertKnowledgeGenerationDigest(record.sha256);
  verifySealed(record, () =>
    knowledgeError(
      "KNOWLEDGE_HASH_MISMATCH",
      "Native generation record hash does not match its exact body",
    ),
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
export function text(value: unknown, maximum: number): string {
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
export function cleanup(value: unknown): KnowledgeGenerationCleanup {
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
export function validateRecord(value: unknown): KnowledgeGenerationRecord {
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
    !sameKnowledge(r.budget, budget)
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
    r.attemptId === null &&
    [
      "dispatched",
      "streaming",
      "output-finished",
      "completed",
      "uncertain",
    ].includes(r.state)
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
export function validateAttempt(value: unknown): KnowledgeGenerationAttempt {
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
export function validateAck(
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
export function validateBarrier(
  value: unknown,
): KnowledgeGenerationWorkspaceBarrier {
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
/** The attempt shares its generation's id, plan, runtime epoch and state. */
export function attemptBelongsTo(
  g: KnowledgeGenerationRecord,
  a: KnowledgeGenerationAttempt,
): boolean {
  return (
    a.generationId === g.id &&
    a.planId === g.planId &&
    a.runtimeEpoch === g.runtimeEpoch &&
    a.state === g.state
  );
}
/** Candidate plan, request and body hash match the generation and its attempt. */
export function candidateMatchesOutput(
  candidate: Pick<
    KnowledgeCandidate,
    "planId" | "bodySha256" | "requestSha256"
  >,
  g: KnowledgeGenerationRecord,
  a: KnowledgeGenerationAttempt,
): boolean {
  return (
    candidate.planId === g.planId &&
    candidate.bodySha256 === a.outputSha256 &&
    candidate.requestSha256 === g.logicalRequestSha256
  );
}
