import type { EngineBudgets, JsonObject, RunConfig } from "@moodcode/contracts";
import type { WorkflowObjectSchema } from "../workflows/types.js";

/** Serialized pins are data. The root producer separately authenticates ORIGINAL handles. */
export interface ScheduleTargetPin {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly workspaceBindingSha256: string;
  readonly capabilitiesSha256: string;
  readonly catalogueSha256: string;
  readonly profile: { readonly id: string; readonly revision: string } | null;
  readonly config: RunConfig & { budgets: EngineBudgets };
  readonly runConfigSha256: string;
  readonly tools: readonly string[];
  readonly delivery: "queue";
  readonly allocation: {
    readonly maxTurns: number;
    readonly maxToolCalls: number;
    readonly maxOutputBytes: number;
    readonly maxDurationMs: number;
  };
}
export type ScheduleTarget = ScheduleTargetPin;
export type ScheduleTrigger =
  | { readonly kind: "absolute"; readonly at: string }
  | {
      readonly kind: "daily";
      readonly time: string;
      readonly timezone: string;
      readonly timezoneDataVersion: string;
      readonly fold: "earlier" | "later" | "both" | "skip";
      readonly gap: "skip";
    }
  | {
      readonly kind: "webhook";
      readonly secretReference: string;
      readonly bodySchema: WorkflowObjectSchema;
    };
export interface ScheduleSpecInput {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly prompt: string;
  readonly target: ScheduleTargetPin;
  readonly trigger: ScheduleTrigger;
  readonly misfire: {
    readonly mode: "skip" | "latest" | "catch-up";
    readonly graceMs: number;
  };
  readonly concurrency: number;
}
export interface ScheduleSpec extends ScheduleSpecInput {
  readonly sha256: string;
}
export interface ScheduleDueCursor {
  readonly schemaVersion: 1;
  readonly scheduleSha256: string;
  readonly highWatermark: string | null;
  readonly through: string | null;
}
/** Deterministic proposed input identity; this candidate cannot dispatch or reacquire a lease. */
export interface ScheduleOccurrenceCandidate {
  readonly schemaVersion: 1;
  readonly authority: "advisory-data";
  readonly scheduleId: string;
  readonly scheduleSha256: string;
  readonly occurrenceId: string;
  readonly inputRequestId: string;
  readonly triggerKey: string;
  readonly scheduledAt: string;
  readonly data: JsonObject;
  readonly dataSha256: string;
  readonly sha256: string;
}
export interface ScheduleDueBatch {
  readonly occurrences: readonly ScheduleOccurrenceCandidate[];
  readonly nextCursor: ScheduleDueCursor;
  readonly hasMore: boolean;
  readonly clockRollback: boolean;
  readonly omittedCount: number;
  readonly executionAuthority: false;
}
