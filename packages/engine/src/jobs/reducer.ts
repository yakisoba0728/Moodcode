import { EngineError } from "@moodcode/contracts";
export type JobState =
  | "attached"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "paused-import";
export type JobDeliveryState =
  | "prepared"
  | "dispatching"
  | "accepted"
  | "cancelled"
  | "uncertain"
  | "paused-import";
export type JobJournalKind = "job" | "output" | "delivery";
export function assertJobTransition(
  kind: JobJournalKind,
  before: string | null,
  after: string,
  operation: string,
): void {
  if (
    kind === "output" &&
    before === null &&
    after === "recorded" &&
    operation === "output"
  )
    return;
  if (kind === "job") {
    if (before === null && after === "attached" && operation === "attach")
      return;
    if (before === "attached" && after === "attached" && operation === "output")
      return;
    if (
      before === "attached" &&
      operation === "settle" &&
      ["completed", "failed", "cancelled", "uncertain"].includes(after)
    )
      return;
    if (
      before === "attached" &&
      after === "cancelled" &&
      operation === "cancel-watch"
    )
      return;
    if (
      before === "attached" &&
      after === "uncertain" &&
      operation === "recover"
    )
      return;
  }
  if (kind === "delivery") {
    if (
      before === null &&
      after === "prepared" &&
      operation === "delivery-prepare"
    )
      return;
    if (
      before === "prepared" &&
      after === "dispatching" &&
      operation === "delivery-intent"
    )
      return;
    if (
      before === "prepared" &&
      after === "cancelled" &&
      operation === "delivery-cancel"
    )
      return;
    if (
      before === "prepared" &&
      after === "uncertain" &&
      operation === "recover"
    )
      return;
    if (
      before === "dispatching" &&
      after === "accepted" &&
      operation === "delivery-accepted"
    )
      return;
    if (
      before === "dispatching" &&
      after === "uncertain" &&
      ["recover", "delivery-uncertain"].includes(operation)
    )
      return;
    if (
      before === "uncertain" &&
      after === "accepted" &&
      operation === "delivery-reconcile"
    )
      return;
  }
  if (
    before !== null &&
    after === "paused-import" &&
    operation === "pause-import" &&
    kind !== "output"
  )
    return;
  throw new EngineError(
    "JOB_TRANSITION_INVALID",
    "Job journal transition is not supported",
  );
}
