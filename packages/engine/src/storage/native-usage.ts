import {
  EngineError,
  type AttemptUsageRecord,
  type ProviderUsageSnapshot,
} from "@moodcode/contracts";
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
export function putAttemptUsage(
  native: NativeSessionStorage,
  attemptId: string,
  snapshot: AttemptUsageSnapshot,
): AttemptUsageRecord {
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
    if (
      (merged.cachedInputTokens !== undefined &&
        merged.inputTokens !== undefined &&
        merged.cachedInputTokens > merged.inputTokens) ||
      (merged.reasoningOutputTokens !== undefined &&
        merged.outputTokens !== undefined &&
        merged.reasoningOutputTokens > merged.outputTokens)
    )
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
