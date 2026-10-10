import {
  EngineError,
  type AttemptUsageRecord,
  type ProviderUsageSnapshot,
} from "@moodcode/contracts";
import { readEvidenceBody } from "./evidence-read.js";
import { NativeSessionStorage, storedJson } from "./native.js";

export const ATTEMPT_USAGE_SCHEMA = `CREATE TABLE attempt_usage (
  attempt_id TEXT PRIMARY KEY REFERENCES provider_attempts(id),
  session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id),
  turn_id TEXT NOT NULL REFERENCES session_turns(id), revision INTEGER NOT NULL CHECK(revision>0),
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=4096)
) STRICT;
CREATE INDEX attempt_usage_session ON attempt_usage(session_id);`;
export type AttemptUsageSnapshot = ProviderUsageSnapshot;
export type { AttemptUsageRecord };
const fields = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningOutputTokens",
] as const;
/** Null and undefined counts are unknown and never exceed their inclusive total. */
export function exceedsInclusiveTotals(usage: {
  [K in (typeof fields)[number]]?: number | null;
}): boolean {
  const exceeds = (part?: number | null, total?: number | null) =>
    part != null && total != null && part > total;
  return (
    exceeds(usage.cachedInputTokens, usage.inputTokens) ||
    exceeds(usage.reasoningOutputTokens, usage.outputTokens)
  );
}
function usageSnapshot(snapshot: unknown): AttemptUsageSnapshot {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(snapshot))
  )
    throw new EngineError(
      "INVALID_ATTEMPT_USAGE",
      "Usage must be a plain token snapshot",
    );
  const usage: AttemptUsageSnapshot = {};
  for (const key of Reflect.ownKeys(snapshot)) {
    const descriptor = Object.getOwnPropertyDescriptor(snapshot, key)!;
    if (
      typeof key !== "string" ||
      !(fields as readonly string[]).includes(key) ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "number" ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0
    )
      throw new EngineError(
        "INVALID_ATTEMPT_USAGE",
        "Observed tokens must be plain nonnegative safe integers",
      );
    usage[key as keyof AttemptUsageSnapshot] = descriptor.value;
  }
  return usage;
}
/** Call inside an evidence read: the stored record must match its SQL owner and Attempt. */
export function readAttemptUsage(
  native: NativeSessionStorage,
  attemptId: string,
): AttemptUsageRecord | null {
  const row = native.database
    .prepare(
      "SELECT u.session_id,u.run_id,u.turn_id,u.revision,length(CAST(u.data AS BLOB)) AS bytes,a.session_id AS attempt_session_id,a.run_id AS attempt_run_id,a.turn_id AS attempt_turn_id FROM attempt_usage u JOIN provider_attempts a ON a.id=u.attempt_id WHERE u.attempt_id=?",
    )
    .get(attemptId);
  if (!row) return null;
  if (
    row.session_id !== row.attempt_session_id ||
    row.run_id !== row.attempt_run_id ||
    row.turn_id !== row.attempt_turn_id
  )
    throw new EngineError(
      "RECORD_SCOPE_MISMATCH",
      "Stored usage belongs to another owner",
    );
  const raw = readEvidenceBody(
    native.database,
    { table: "attempt_usage", key: attemptId },
    { expectedBytes: Number(row.bytes), maxBytes: 4096 },
  );
  const record = JSON.parse(String(raw)) as AttemptUsageRecord;
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join() !==
      "attemptId,observedAt,revision,runId,sessionId,turnId,usage" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    record.revision !== row.revision ||
    typeof record.observedAt !== "string" ||
    !Number.isFinite(Date.parse(record.observedAt)) ||
    exceedsInclusiveTotals(usageSnapshot(record.usage))
  )
    throw new EngineError(
      "INVALID_ATTEMPT_USAGE",
      "Stored usage record is invalid",
    );
  if (
    record.attemptId !== attemptId ||
    record.sessionId !== row.session_id ||
    record.runId !== row.run_id ||
    record.turnId !== row.turn_id
  )
    throw new EngineError(
      "RECORD_SCOPE_MISMATCH",
      "Stored usage belongs to another owner",
    );
  return record;
}
export function putAttemptUsage(
  native: NativeSessionStorage,
  attemptId: string,
  snapshot: AttemptUsageSnapshot,
): AttemptUsageRecord {
  const usage = usageSnapshot(snapshot);
  const owner = native.database
    .prepare(
      "SELECT session_id,run_id,turn_id,state FROM provider_attempts WHERE id=?",
    )
    .get(attemptId);
  if (!owner)
    throw new EngineError("ATTEMPT_NOT_FOUND", "Usage attempt was not found");
  return native.write(String(owner.session_id), () => {
    const attempt = native.database
      .prepare(
        "SELECT session_id,run_id,turn_id,state FROM provider_attempts WHERE id=?",
      )
      .get(attemptId)!;
    const run = native.scopeRun(
      String(attempt.session_id),
      String(attempt.run_id),
    );
    const turn = native.database
      .prepare("SELECT session_id,run_id FROM session_turns WHERE id=?")
      .get(String(attempt.turn_id));
    if (
      !turn ||
      turn.session_id !== attempt.session_id ||
      turn.run_id !== attempt.run_id
    )
      throw new EngineError(
        "RECORD_SCOPE_MISMATCH",
        "Usage attempt and Turn have inconsistent owners",
      );
    const row = native.database
      .prepare(
        "SELECT session_id,run_id,turn_id,data FROM attempt_usage WHERE attempt_id=?",
      )
      .get(attemptId);
    const prior = row
      ? (JSON.parse(String(row.data)) as AttemptUsageRecord)
      : undefined;
    if (
      row &&
      (row.session_id !== attempt.session_id ||
        row.run_id !== attempt.run_id ||
        row.turn_id !== attempt.turn_id ||
        prior!.attemptId !== attemptId ||
        prior!.sessionId !== attempt.session_id ||
        prior!.runId !== attempt.run_id ||
        prior!.turnId !== attempt.turn_id)
    )
      throw new EngineError(
        "RECORD_SCOPE_MISMATCH",
        "Stored usage belongs to another owner",
      );
    const merged: AttemptUsageSnapshot = { ...prior?.usage, ...usage };
    if (prior && fields.every((key) => prior.usage[key] === merged[key]))
      return prior;
    if (
      !["dispatched", "streaming"].includes(String(attempt.state)) ||
      !["created", "running", "awaiting_approval"].includes(run.state)
    )
      throw new EngineError(
        "ATTEMPT_USAGE_IMMUTABLE",
        "Usage can only change during a live dispatched attempt",
      );
    for (const key of fields)
      if (prior?.usage[key] !== undefined && merged[key]! < prior.usage[key]!)
        throw new EngineError(
          "ATTEMPT_USAGE_REGRESSION",
          "Usage observations cannot decrease",
        );
    if (exceedsInclusiveTotals(merged))
      throw new EngineError(
        "INVALID_ATTEMPT_USAGE",
        "Usage breakdown cannot exceed inclusive totals",
      );
    const revision = (prior?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision))
      throw new EngineError(
        "REVISION_EXHAUSTED",
        "Usage revision exhausted the safe integer range",
      );
    const record: AttemptUsageRecord = {
      attemptId,
      sessionId: String(attempt.session_id),
      runId: String(attempt.run_id),
      turnId: String(attempt.turn_id),
      revision,
      usage: merged,
      observedAt: new Date().toISOString(),
    };
    native.database
      .prepare(
        "INSERT INTO attempt_usage(attempt_id,session_id,run_id,turn_id,revision,data) VALUES(?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
      )
      .run(
        attemptId,
        record.sessionId,
        record.runId,
        record.turnId,
        revision,
        JSON.stringify(record),
      );
    native.appendEvent(
      record.sessionId,
      "provider.attempt.usage",
      { observation: storedJson(record) },
      { runId: record.runId, turnId: record.turnId, attemptId },
    );
    return record;
  });
}
