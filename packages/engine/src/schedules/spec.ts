import { EngineError, type JsonObject } from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import {
  QUEUE_TARGET_LIMITS,
  validateQueueTarget,
} from "../runner/queue-target.js";
import {
  validateWorkflowObjectSchema,
  validateWorkflowValue,
} from "../workflows/spec.js";
import type {
  ScheduleSpec,
  ScheduleTargetPin,
  ScheduleTrigger,
} from "./types.js";

export const SCHEDULE_LIMITS = Object.freeze({
  specBytes: 32768,
  promptBytes: 8192,
  webhookBytes: 8192,
  inputBytes: 32768,
  tools: QUEUE_TARGET_LIMITS.tools,
  concurrency: 8,
  due: 32,
  windowDays: 366,
  graceMs: 86400000,
});
export function scheduleError(code = "INVALID_SCHEDULE_SPEC"): never {
  throw new EngineError(
    code,
    "Schedules require bounded immutable definitions and explicit original host admission",
  );
}
export function scheduleJson<T>(
  input: T,
  cap: number = SCHEDULE_LIMITS.specBytes,
): T {
  try {
    const result = immutableKnowledgeJson(input);
    if (Buffer.byteLength(JSON.stringify(result)) > cap)
      scheduleError("SCHEDULE_LIMIT");
    return result;
  } catch (error) {
    if (error instanceof EngineError && error.code.startsWith("SCHEDULE_"))
      throw error;
    return scheduleError();
  }
}
export function scheduleObject(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const value = scheduleJson(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    scheduleError();
  const record = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    scheduleError();
  return record;
}
export function scheduleIdentifier(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input))
    scheduleError();
  return input;
}
function externalId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input ||
    Buffer.byteLength(input) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(input) ||
    Buffer.from(input).toString("utf8") !== input
  )
    scheduleError();
  return input;
}
export function scheduleSha(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input))
    scheduleError();
  return input;
}
export function scheduleInteger(
  input: unknown,
  max = Number.MAX_SAFE_INTEGER,
  min = 0,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < min ||
    input > max
  )
    scheduleError();
  return input;
}
export function scheduleTimestamp(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length !== 24 ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input ||
    input < "2000-01-01T00:00:00.000Z" ||
    input >= "2100-01-01T00:00:00.000Z"
  )
    scheduleError("SCHEDULE_TIME_INVALID");
  return input;
}
function text(input: unknown, cap: number, empty = false): string {
  if (
    typeof input !== "string" ||
    (!empty && !input) ||
    input.includes("\0") ||
    Buffer.byteLength(input) > cap ||
    Buffer.from(input).toString("utf8") !== input
  )
    scheduleError("SCHEDULE_LIMIT");
  return input;
}
export function validateSchedulePrompt(input: unknown): string {
  return text(input, SCHEDULE_LIMITS.promptBytes);
}

/** Validated serialized scope still conveys no runtime owner, time, approval or lease authority. */
export function validateScheduleTarget(input: unknown): ScheduleTargetPin {
  return validateQueueTarget(input);
}
function trigger(input: unknown): ScheduleTrigger {
  const kind = scheduleObject(
    input,
    ["kind"],
    [
      "at",
      "time",
      "timezone",
      "timezoneDataVersion",
      "fold",
      "gap",
      "secretReference",
      "bodySchema",
    ],
  ).kind;
  if (kind === "absolute") {
    const value = scheduleObject(input, ["kind", "at"]);
    return { kind, at: scheduleTimestamp(value.at) };
  }
  if (kind === "daily") {
    const value = scheduleObject(input, [
      "kind",
      "time",
      "timezone",
      "timezoneDataVersion",
      "fold",
      "gap",
    ]);
    if (
      typeof value.time !== "string" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.time) ||
      typeof value.timezone !== "string" ||
      value.timezone.length > 64 ||
      !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(value.timezone) ||
      !["earlier", "later", "both", "skip"].includes(String(value.fold)) ||
      value.gap !== "skip"
    )
      scheduleError("SCHEDULE_TRIGGER_INVALID");
    try {
      if (
        new Intl.DateTimeFormat("en", {
          timeZone: value.timezone,
        }).resolvedOptions().timeZone !== value.timezone
      )
        scheduleError("SCHEDULE_TIMEZONE_INVALID");
    } catch {
      scheduleError("SCHEDULE_TIMEZONE_INVALID");
    }
    return {
      kind,
      time: value.time,
      timezone: value.timezone,
      timezoneDataVersion: externalId(value.timezoneDataVersion),
      fold: value.fold as "earlier" | "later" | "both" | "skip",
      gap: "skip",
    };
  }
  if (kind === "webhook") {
    const value = scheduleObject(input, [
      "kind",
      "secretReference",
      "bodySchema",
    ]);
    let bodySchema: ScheduleTrigger & { kind: "webhook" };
    try {
      bodySchema = {
        kind,
        secretReference: externalId(value.secretReference),
        bodySchema: validateWorkflowObjectSchema(value.bodySchema),
      };
    } catch {
      return scheduleError("SCHEDULE_WEBHOOK_SCHEMA_INVALID");
    }
    return bodySchema;
  }
  return scheduleError("SCHEDULE_TRIGGER_INVALID");
}
export function validateScheduleSpec(input: unknown): ScheduleSpec {
  const value = scheduleObject(
    input,
    [
      "schemaVersion",
      "id",
      "description",
      "enabled",
      "startsAt",
      "endsAt",
      "prompt",
      "target",
      "trigger",
      "misfire",
      "concurrency",
    ],
    ["sha256"],
  );
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean")
    scheduleError();
  const startsAt = scheduleTimestamp(value.startsAt),
    endsAt = value.endsAt === null ? null : scheduleTimestamp(value.endsAt),
    selected = trigger(value.trigger);
  if (
    (endsAt !== null && endsAt < startsAt) ||
    (selected.kind === "absolute" &&
      (selected.at < startsAt || (endsAt !== null && selected.at > endsAt)))
  )
    scheduleError("SCHEDULE_TIME_INVALID");
  const misfire = scheduleObject(value.misfire, ["mode", "graceMs"]);
  if (!["skip", "latest", "catch-up"].includes(String(misfire.mode)))
    scheduleError("SCHEDULE_MISFIRE_INVALID");
  const definition = scheduleJson({
    schemaVersion: 1 as const,
    id: scheduleIdentifier(value.id),
    description: text(value.description, 4096, true),
    enabled: value.enabled,
    startsAt,
    endsAt,
    prompt: validateSchedulePrompt(value.prompt),
    target: validateScheduleTarget(value.target),
    trigger: selected,
    misfire: {
      mode: misfire.mode as "skip" | "latest" | "catch-up",
      graceMs: scheduleInteger(misfire.graceMs, SCHEDULE_LIMITS.graceMs),
    },
    concurrency: scheduleInteger(
      value.concurrency,
      SCHEDULE_LIMITS.concurrency,
      1,
    ),
  });
  const sha256 = knowledgeHash(definition);
  if (value.sha256 !== undefined && scheduleSha(value.sha256) !== sha256)
    scheduleError("SCHEDULE_SPEC_STALE");
  return scheduleJson({ ...definition, sha256 });
}
export function validateScheduleWebhookData(
  input: unknown,
  schedule: ScheduleSpec,
): JsonObject {
  const spec = validateScheduleSpec(schedule);
  if (spec.trigger.kind !== "webhook")
    scheduleError("SCHEDULE_TRIGGER_INVALID");
  const data = scheduleJson(input, SCHEDULE_LIMITS.webhookBytes);
  try {
    return scheduleJson(
      validateWorkflowValue(spec.trigger.bodySchema, data) as JsonObject,
      SCHEDULE_LIMITS.webhookBytes,
    );
  } catch {
    return scheduleError("SCHEDULE_WEBHOOK_DATA_INVALID");
  }
}
