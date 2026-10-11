import { EngineError } from "@moodcode/contracts";
export const BACKEND_CONNECTION_STATES = [
  "launched",
  "initialized",
  "session-ready",
  "closing",
  "closed",
  "uncertain",
  "paused-import",
] as const;
export type BackendConnectionState = (typeof BACKEND_CONNECTION_STATES)[number];
export const BACKEND_REQUEST_STATES = [
  "prepared",
  "dispatching",
  "dispatched",
  "completed",
  "failed",
  "cancelled",
  "uncertain",
  "paused-import",
] as const;
export type BackendRequestState = (typeof BACKEND_REQUEST_STATES)[number];
export const BACKEND_EFFECT_STATES = [
  "prepared",
  "completed",
  "failed",
  "denied",
  "interrupted",
  "uncertain",
  "paused-import",
] as const;
export type BackendEffectState = (typeof BACKEND_EFFECT_STATES)[number];
export const SETTLED_REQUEST_STATES: readonly BackendRequestState[] = [
  "completed",
  "failed",
  "cancelled",
];
export const SETTLED_EFFECT_STATES: readonly BackendEffectState[] = [
  "completed",
  "failed",
  "denied",
  "interrupted",
];
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
type KindStates = Partial<Record<BackendJournalKind, readonly string[]>>;
const PREPARED_OR_SETTLED = ["prepared", ...SETTLED_EFFECT_STATES];
/** States an operation may keep unchanged, checked before the lifecycle table. */
const SAME_STATE: ReadonlyMap<string, KindStates> = new Map([
  ["negotiate", { connection: ["initialized"] }],
  ["load-intent", { connection: ["initialized"] }],
  [
    "cancel-wire",
    { request: ["prepared", "dispatching", "dispatched", "uncertain"] },
  ],
  ["bind-effect", { "client-effect": PREPARED_OR_SETTLED }],
  ["terminal-control", { "client-effect": PREPARED_OR_SETTLED }],
  ["effect-ack", { "client-effect": ["prepared"] }],
  ["permission", { "client-effect": ["prepared"] }],
  ["delivery", { "client-effect": SETTLED_EFFECT_STATES }],
  ["observe", { connection: ["launched", "initialized", "session-ready"] }],
]);
/** States an operation may reach once the lifecycle table admits the move. */
const TARGETS: ReadonlyMap<string, KindStates> = new Map([
  ["dispatch-intent", { request: ["dispatching"] }],
  ["dispatch", { request: ["dispatched"] }],
  ["settle", { request: SETTLED_REQUEST_STATES }],
  ["settle-read", { "client-effect": SETTLED_EFFECT_STATES }],
  ["observe", { connection: ["initialized", "session-ready"] }],
  ["dispose", { connection: ["closed", "uncertain"] }],
]);
/** Targets of administrative and uncertainty operations on any kind. */
const ANY_KIND_TARGETS: ReadonlyMap<string, string> = new Map([
  ["pause-import", "paused-import"],
  ["recover", "uncertain"],
  ["uncertain", "uncertain"],
]);
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
  if (before === after && SAME_STATE.get(operation)?.[kind]?.includes(after))
    return;
  if (
    operation === "load-ready" &&
    kind === "connection" &&
    before === "initialized" &&
    after === "session-ready"
  )
    return;
  const table =
    kind === "connection"
      ? connections
      : kind === "request"
        ? requests
        : effects;
  if (!table[after]?.includes(before!)) invalid();
  if (
    ANY_KIND_TARGETS.get(operation) === after ||
    TARGETS.get(operation)?.[kind]?.includes(after)
  )
    return;
  invalid();
}
function invalid(): never {
  throw new EngineError(
    "BACKEND_TRANSITION_INVALID",
    "Backend journal transition is not supported",
  );
}
