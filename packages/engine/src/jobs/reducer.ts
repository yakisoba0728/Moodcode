import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import type {
  JobOutputCursor,
  JobOutputPage,
  TerminalClosedOutcomeProof,
} from "./types.js";
import type { CommandJob, JobDelivery, JobRecord } from "./store.js";
export const JOB_STATES = [
  "attached",
  "completed",
  "failed",
  "cancelled",
  "uncertain",
  "paused-import",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const JOB_DELIVERY_STATES = [
  "prepared",
  "dispatching",
  "accepted",
  "cancelled",
  "uncertain",
  "paused-import",
] as const;
export type JobDeliveryState = (typeof JOB_DELIVERY_STATES)[number];
export type JobJournalKind = "job" | "output" | "delivery";
export function fail(code = "JOB_DATABASE_INVALID"): never {
  throw new EngineError(
    code,
    "Job journal proof or lifecycle does not match its native history",
  );
}
/** Allowed [kind, before, after, operation] tuples; pause-import is checked separately. */
const ALLOWED = new Set(
  (
    [
      ["output", null, "recorded", "output"],
      ["job", null, "attached", "attach"],
      ["job", "attached", "attached", "output"],
      ["job", "attached", "completed", "settle"],
      ["job", "attached", "failed", "settle"],
      ["job", "attached", "cancelled", "settle"],
      ["job", "attached", "uncertain", "settle"],
      ["job", "attached", "cancelled", "cancel-watch"],
      ["job", "attached", "uncertain", "recover"],
      ["delivery", null, "prepared", "delivery-prepare"],
      ["delivery", "prepared", "dispatching", "delivery-intent"],
      ["delivery", "prepared", "cancelled", "delivery-cancel"],
      ["delivery", "prepared", "uncertain", "recover"],
      ["delivery", "dispatching", "accepted", "delivery-accepted"],
      ["delivery", "dispatching", "uncertain", "recover"],
      ["delivery", "dispatching", "uncertain", "delivery-uncertain"],
      ["delivery", "uncertain", "accepted", "delivery-reconcile"],
    ] as const
  ).map((tuple) => JSON.stringify(tuple)),
);
export function assertJobTransition(
  kind: JobJournalKind,
  before: string | null,
  after: string,
  operation: string,
): void {
  if (
    ALLOWED.has(JSON.stringify([kind, before, after, operation])) ||
    (before !== null &&
      after === "paused-import" &&
      operation === "pause-import" &&
      kind !== "output")
  )
    return;
  throw new EngineError(
    "JOB_TRANSITION_INVALID",
    "Job journal transition is not supported",
  );
}
export function settledJobState(outcome: TerminalClosedOutcomeProof): JobState {
  return ["uncertain", "interrupted"].includes(outcome.state) ||
    !outcome.cleanupConfirmed
    ? "uncertain"
    : outcome.cancelled || outcome.timedOut
      ? "cancelled"
      : outcome.exitCode === 0
        ? "completed"
        : "failed";
}
export function assertOutputProgress(
  cursor: JobOutputCursor | null,
  page: JobOutputPage,
): void {
  const expected = cursor
      ? { seq: cursor.eventSeq, offset: cursor.byteOffset }
      : { seq: 1, offset: 0 },
    first = page.fragments[0];
  if (
    cursor &&
    page.snapshotSha256 !== cursor.snapshotSha256 &&
    cursor.eventSeq <= cursor.throughSeq
  )
    fail("JOB_OUTPUT_STALE");
  if (page.gap) {
    if (
      page.gap.fromSeq !== expected.seq ||
      page.gap.fromByteOffset !== expected.offset
    )
      fail("JOB_OUTPUT_STALE");
  } else if (first) {
    if (first.seq !== expected.seq || first.byteOffset !== expected.offset)
      fail("JOB_OUTPUT_STALE");
  } else if (
    page.nextCursor.eventSeq !== expected.seq ||
    page.nextCursor.byteOffset !== expected.offset
  )
    fail("JOB_OUTPUT_STALE");
}
function stable(before: JobRecord, after: JobRecord): void {
  for (const k of [
    "kind",
    "entityId",
    "workspaceId",
    "sessionId",
    "terminalId",
    "sourceSha256",
    "ownerEpoch",
    "source",
    "owner",
  ] as const)
    if (knowledgeHash(before[k]) !== knowledgeHash(after[k])) fail();
}
export function semantic(
  before: JobRecord | undefined,
  after: JobRecord,
  op: string,
): void {
  assertJobTransition(after.kind, before?.state ?? null, after.state, op);
  if (before) stable(before, after);
  if (after.kind === "job") {
    const b = before as CommandJob | undefined;
    if (!b) {
      if (
        after.sourceRevisionId !== after.id ||
        after.cursor !== null ||
        after.lastOutputId !== null ||
        after.outcome !== null ||
        after.errorCode !== null
      )
        fail();
      return;
    }
    if (after.sourceRevisionId !== b.sourceRevisionId) fail();
    if (op === "output") {
      if (
        !after.cursor ||
        !after.lastOutputId ||
        after.outcome !== b.outcome ||
        after.errorCode !== null
      )
        fail();
    } else if (op === "settle") {
      if (
        !after.outcome ||
        after.cursor?.sha256 !== b.cursor?.sha256 ||
        after.lastOutputId !== b.lastOutputId
      )
        fail();
      if (after.state !== settledJobState(after.outcome)) fail();
    } else if (op === "cancel-watch") {
      if (
        after.outcome !== null ||
        knowledgeHash(after.cursor) !== knowledgeHash(b.cursor) ||
        after.lastOutputId !== b.lastOutputId
      )
        fail();
    } else if (["recover", "pause-import"].includes(op)) {
      if (
        knowledgeHash({
          ...b,
          state: after.state,
          id: after.id,
          revision: after.revision,
          previousId: after.previousId,
          lastReceiptId: after.lastReceiptId,
          createdAt: after.createdAt,
          errorCode: after.errorCode,
          sha256: after.sha256,
        }) !== knowledgeHash(after)
      )
        fail();
    }
  }
  if (after.kind === "delivery") {
    const b = before as JobDelivery | undefined;
    if (!b) {
      if (
        after.inputRequestId !== null ||
        after.prompt !== null ||
        after.accepted !== null
      )
        fail();
      return;
    }
    for (const k of [
      "jobId",
      "settledRevisionId",
      "settledSha256",
      "target",
    ] as const)
      if (knowledgeHash(b[k]) !== knowledgeHash(after[k])) fail();
    if (op === "delivery-intent") {
      if (
        !after.inputRequestId ||
        after.prompt === null ||
        after.accepted !== null
      )
        fail();
    } else if (["delivery-accepted", "delivery-reconcile"].includes(op)) {
      if (
        !after.accepted ||
        after.inputRequestId !== b.inputRequestId ||
        after.prompt !== b.prompt
      )
        fail();
    } else if (
      after.inputRequestId !== b.inputRequestId ||
      after.prompt !== b.prompt ||
      knowledgeHash(after.accepted) !== knowledgeHash(b.accepted)
    )
      fail();
  }
}
