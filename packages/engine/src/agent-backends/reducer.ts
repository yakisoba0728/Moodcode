import { EngineError } from "@moodcode/contracts";
export type BackendConnectionState =
  | "launched"
  | "initialized"
  | "session-ready"
  | "closing"
  | "closed"
  | "uncertain"
  | "paused-import";
export type BackendRequestState =
  | "prepared"
  | "dispatching"
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "paused-import";
export type BackendEffectState =
  | "prepared"
  | "completed"
  | "failed"
  | "denied"
  | "interrupted"
  | "uncertain"
  | "paused-import";
export type BackendJournalKind =
  "backend" | "connection" | "request" | "client-effect";
const connections: Record<string, readonly string[]> = {
  initialized: ["launched"],
  "session-ready": ["initialized"],
  closing: ["launched", "initialized", "session-ready"],
  closed: ["launched", "initialized", "session-ready", "closing"],
  uncertain: ["launched", "initialized", "session-ready", "closing"],
  "paused-import": [
    "launched",
    "initialized",
    "session-ready",
    "closing",
    "closed",
    "uncertain",
  ],
};
const requests: Record<string, readonly string[]> = {
  dispatching: ["prepared"],
  dispatched: ["dispatching"],
  completed: ["dispatched"],
  failed: ["dispatched"],
  cancelled: ["dispatched"],
  uncertain: ["prepared", "dispatching", "dispatched"],
  "paused-import": [
    "prepared",
    "dispatching",
    "dispatched",
    "completed",
    "failed",
    "cancelled",
    "uncertain",
  ],
};
const effects: Record<string, readonly string[]> = {
  completed: ["prepared"],
  failed: ["prepared"],
  denied: ["prepared"],
  interrupted: ["prepared"],
  uncertain: ["prepared"],
  "paused-import": [
    "prepared",
    "completed",
    "failed",
    "denied",
    "interrupted",
    "uncertain",
  ],
};
/** This only validates persistent lifecycle semantics, never authenticates an external runtime. */
export function assertBackendTransition(
  kind: BackendJournalKind,
  before: string | null,
  after: string,
  operation: string,
): void {
  if (kind === "backend") {
    if (!["register", "disable", "pause-import"].includes(operation)) invalid();
    return;
  }
  if (before === null) {
    if (
      (kind === "connection" && after === "launched" && operation === "open") ||
      (kind === "request" && after === "prepared" && operation === "prepare") ||
      (kind === "client-effect" &&
        after === "prepared" &&
        operation === "prepare-read")
    )
      return;
    invalid();
  }
  if (
    ["negotiate", "load-intent"].includes(operation) &&
    kind === "connection" &&
    before === "initialized" &&
    after === before
  )
    return;
  if (
    operation === "load-ready" &&
    kind === "connection" &&
    before === "initialized" &&
    after === "session-ready"
  )
    return;
  if (
    operation === "cancel-wire" &&
    kind === "request" &&
    before === after &&
    ["prepared", "dispatching", "dispatched", "uncertain"].includes(after)
  )
    return;
  if (
    ["bind-effect", "terminal-control"].includes(operation) &&
    kind === "client-effect" &&
    before === after &&
    ["prepared", "completed", "failed", "denied", "interrupted"].includes(after)
  )
    return;
  if (
    operation === "effect-ack" &&
    kind === "client-effect" &&
    before === "prepared" &&
    after === "prepared"
  )
    return;
  if (
    operation === "permission" &&
    kind === "client-effect" &&
    before === "prepared" &&
    after === "prepared"
  )
    return;
  if (
    operation === "delivery" &&
    kind === "client-effect" &&
    before === after &&
    ["completed", "failed", "denied", "interrupted"].includes(after)
  )
    return;
  if (
    operation === "observe" &&
    kind === "connection" &&
    before === after &&
    ["launched", "initialized", "session-ready"].includes(after)
  )
    return;
  const table =
    kind === "connection"
      ? connections
      : kind === "request"
        ? requests
        : effects;
  if (!table[after]?.includes(before!)) invalid();
  if (operation === "pause-import" && after === "paused-import") return;
  if (operation === "recover" && after === "uncertain") return;
  if (
    kind === "request" &&
    ((operation === "dispatch-intent" && after === "dispatching") ||
      (operation === "dispatch" && after === "dispatched") ||
      (operation === "settle" &&
        ["completed", "failed", "cancelled"].includes(after)))
  )
    return;
  if (
    kind === "client-effect" &&
    operation === "settle-read" &&
    ["completed", "failed", "denied", "interrupted"].includes(after)
  )
    return;
  if (
    kind === "connection" &&
    operation === "observe" &&
    ["initialized", "session-ready"].includes(after)
  )
    return;
  if (
    kind === "connection" &&
    operation === "dispose" &&
    ["closed", "uncertain"].includes(after)
  )
    return;
  if (operation === "uncertain" && after === "uncertain") return;
  invalid();
}
function invalid(): never {
  throw new EngineError(
    "BACKEND_TRANSITION_INVALID",
    "Backend journal transition is not supported",
  );
}
