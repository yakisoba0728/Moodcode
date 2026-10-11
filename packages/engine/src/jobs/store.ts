import { types as nodeTypes } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import { knowledgeHash } from "../knowledge/validation.js";
import { requestIdentity } from "../storage/native-schema.js";
import { readBoundedBody } from "../storage/evidence-read.js";
import {
  assertRevisionLink,
  createRevisionJournal,
  type RevisionJournal,
  type RevisionJournalProfile,
} from "../storage/revision-journal.js";
import { validateQueueTarget } from "../runner/queue-target.js";
import type {
  JobAcceptedInputProof,
  JobDeliveryTargetProof,
} from "./delivery.js";
import { formatJobResult } from "./delivery.js";
import {
  JOB_LIMITS,
  type JobOwnerProof,
  type TerminalJobSourceProof,
  type TerminalClosedOutcomeProof,
  type JobOutputPage,
  type JobOutputCursor,
} from "./types.js";
import {
  isCanonicalJobTime,
  jobJson,
  jobIdentifier,
  jobInteger,
  jobSha256,
  signJobData,
  validateJobOwnerProof,
  validateTerminalJobSourceProof,
  validateTerminalClosedOutcomeProof,
  validateJobOutputPage,
  validateJobOutputCursor,
} from "./validation.js";
import {
  assertJobTransition,
  type JobState,
  type JobDeliveryState,
  type JobJournalKind,
} from "./reducer.js";
export type {
  JobAcceptedInputProof,
  JobDeliveryTargetProof,
} from "./delivery.js";
export const JOB_STORAGE_LIMITS = Object.freeze({
  jobs: 128,
  live: 16,
  sessionLive: 4,
  outputs: 4096,
  deliveries: 128,
  rows: 8192,
  bytes: 33554432,
  rowBytes: 65536,
  inputBytes: 262144,
});
/** Operations that may use the headroom ordinary writes leave for every job and delivery head. */
const RESERVED_OPERATIONS = new Set([
  "settle",
  "cancel-watch",
  "recover",
  "pause-import",
  "delivery-cancel",
  "delivery-uncertain",
]);
/** Bounds one rewrite's record growth (outcome proof, error code) plus its receipt. */
const REWRITE_SLACK_BYTES = 2 * JOB_LIMITS.metadataBytes;
/** An attached, prepared or dispatching head can still be retired once and then paused by import. */
function pendingRewrites(state: unknown): number {
  if (state === "paused-import") return 0;
  return ["attached", "prepared", "dispatching"].includes(String(state))
    ? 2
    : 1;
}
export interface JobStoragePorts {
  writeTx<T>(operation: () => T): T;
  getWorkspace(workspaceId: string): Workspace;
  readOwner(original: object): JobOwnerProof;
  assertOwnerCurrent(
    original: object,
    expected: JobOwnerProof,
    phase: "attach" | "observe",
  ): void;
  readSource(original: object): TerminalJobSourceProof;
  assertSourceCurrent(
    original: object,
    expected: TerminalJobSourceProof,
    phase: "attach" | "observe",
  ): void;
  readOutput(original: object): JobOutputPage;
  readClosedOutcome(original: object): TerminalClosedOutcomeProof;
  readDeliveryTarget(original: object): JobDeliveryTargetProof;
  assertDeliveryTargetCurrent(
    original: object,
    expected: JobDeliveryTargetProof,
  ): void;
  readAccepted(original: object): JobAcceptedInputProof;
  /** ORIGINAL Root acceptance in this primary transaction, with no wake before commit. */
  acceptAtomicInput?(
    originalTarget: object,
    input: { readonly inputRequestId: string; readonly prompt: string },
  ): object;
  releaseAtomicInput?(originalReceipt: object): void;
  readonly now?: () => number;
}
interface Base {
  readonly id: string;
  readonly kind: JobJournalKind;
  readonly entityId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly terminalId: string;
  readonly sourceSha256: string;
  readonly ownerEpoch: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly lastReceiptId: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface CommandJob extends Base {
  readonly kind: "job";
  readonly jobId: string;
  readonly jobKind: "user-terminal-watch";
  readonly sourceRevisionId: string;
  readonly owner: JobOwnerProof;
  readonly source: TerminalJobSourceProof;
  readonly state: JobState;
  readonly cursor: JobOutputCursor | null;
  readonly lastOutputId: string | null;
  readonly outcome: TerminalClosedOutcomeProof | null;
  readonly errorCode: string | null;
}
export interface JobOutputRevision extends Base {
  readonly kind: "output";
  readonly outputId: string;
  readonly jobId: string;
  readonly jobRevisionId: string;
  readonly owner: JobOwnerProof;
  readonly source: TerminalJobSourceProof;
  readonly state: "recorded";
  readonly page: JobOutputPage;
}
export interface JobDelivery extends Base {
  readonly kind: "delivery";
  readonly deliveryId: string;
  readonly jobId: string;
  readonly settledRevisionId: string;
  readonly settledSha256: string;
  readonly owner: JobOwnerProof;
  readonly source: TerminalJobSourceProof;
  readonly target: JobDeliveryTargetProof;
  readonly state: JobDeliveryState;
  readonly inputRequestId: string | null;
  readonly prompt: string | null;
  readonly accepted: JobAcceptedInputProof | null;
  readonly errorCode: string | null;
}
export type JobRecord = CommandJob | JobOutputRevision | JobDelivery;
export interface JobTransitionReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: JobJournalKind;
  readonly entityId: string;
  readonly operation: string;
  readonly beforeRevisionId: string | null;
  readonly afterRevisionId: string;
  readonly afterSha256: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly requestInput: JsonObject;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface JobRequestResult<T extends JobRecord> {
  readonly record: T;
  readonly receipt: JobTransitionReceipt;
  readonly duplicate: boolean;
  readonly output?: JobOutputRevision;
}
export interface JobMutationInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface AttachTerminalJobInput extends JobMutationInput {
  readonly jobId: string;
}
export interface RecordJobOutputInput extends AttachTerminalJobInput {
  readonly outputId: string;
}
export interface SettleTerminalJobInput extends AttachTerminalJobInput {}
export interface CancelCommandJobWatchInput extends AttachTerminalJobInput {}
export interface PrepareJobDeliveryInput extends AttachTerminalJobInput {
  readonly deliveryId: string;
}
export interface DeliverJobResultAtomicInput extends AttachTerminalJobInput {}
export interface MutateJobDeliveryInput extends JobMutationInput {
  readonly deliveryId: string;
}
export interface DispatchJobDeliveryInput extends MutateJobDeliveryInput {
  readonly inputRequestId: string;
  readonly prompt: string;
}
export interface AbandonJobDeliveryInput extends MutateJobDeliveryInput {
  readonly operation: "cancelled" | "uncertain";
  readonly errorCode: string;
}
function fail(code = "JOB_DATABASE_INVALID"): never {
  throw new EngineError(
    code,
    "Job journal proof or lifecycle does not match its native history",
  );
}
const id = jobIdentifier,
  integer = jobInteger;
function json<T>(value: T): T {
  return jobJson(value, JOB_STORAGE_LIMITS.rowBytes);
}
function signed<T extends object>(value: T): T & { readonly sha256: string } {
  return signJobData(value, JOB_STORAGE_LIMITS.rowBytes);
}
function digest<T extends object>(value: T): T {
  const x = json(value) as T & { sha256: string };
  const { sha256, ...body } = x;
  jobSha256(sha256);
  if (knowledgeHash(body) !== sha256) fail();
  return x;
}
function input<T extends JobMutationInput>(
  value: T,
  fields: readonly string[],
): T {
  const x = json(value);
  if (
    !x ||
    typeof x !== "object" ||
    Array.isArray(x) ||
    Object.keys(x).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(x, k))
  )
    fail("INVALID_JOB_INPUT");
  id(x.workspaceId);
  id(x.requestId);
  integer(x.expectedRevision);
  for (const k of fields)
    if (k.endsWith("Id") && k !== "workspaceId" && k !== "requestId")
      id((x as unknown as Record<string, unknown>)[k]);
  return x;
}
function stamp(value: unknown): string {
  if (!isCanonicalJobTime(value)) fail();
  return value;
}
const mutationFields = [
  "workspaceId",
  "requestId",
  "expectedRevision",
] as const;
function ownerMatches(
  owner: JobOwnerProof,
  source: TerminalJobSourceProof,
): void {
  if (
    owner.workspaceId !== source.workspaceId ||
    owner.sessionId !== source.sessionId ||
    owner.sourceSha256 !== source.sha256
  )
    fail("JOB_SOURCE_OWNER_INVALID");
}
function targetProof(value: JobDeliveryTargetProof): JobDeliveryTargetProof {
  const x = digest(value);
  id(x.workspaceId);
  id(x.jobId);
  id(x.jobRevisionId);
  jobSha256(x.jobSha256);
  jobSha256(x.settledSha256);
  jobSha256(x.sourceSha256);
  validateQueueTarget(x.target);
  if (x.target.workspaceId !== x.workspaceId) fail();
  return x;
}
function acceptedProof(value: JobAcceptedInputProof): JobAcceptedInputProof {
  const x = digest(value);
  for (const k of [x.workspaceId, x.sessionId, x.inputId, x.requestId]) id(k);
  integer(x.admittedSeq);
  jobSha256(x.inputSha256);
  return x;
}
function validateRecord(r: JobRecord): void {
  const common = [
    "id",
    "kind",
    "entityId",
    "workspaceId",
    "sessionId",
    "terminalId",
    "sourceSha256",
    "ownerEpoch",
    "revision",
    "previousId",
    "lastReceiptId",
    "createdAt",
    "sha256",
    "owner",
    "source",
    "state",
  ];
  const extra =
    r.kind === "job"
      ? [
          "jobId",
          "jobKind",
          "sourceRevisionId",
          "cursor",
          "lastOutputId",
          "outcome",
          "errorCode",
        ]
      : r.kind === "output"
        ? ["outputId", "jobId", "jobRevisionId", "page"]
        : [
            "deliveryId",
            "jobId",
            "settledRevisionId",
            "settledSha256",
            "target",
            "inputRequestId",
            "prompt",
            "accepted",
            "errorCode",
          ];
  const fields = [...common, ...extra];
  if (
    Object.keys(r).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(r, key))
  )
    fail();
  for (const k of [
    r.id,
    r.entityId,
    r.workspaceId,
    r.sessionId,
    r.terminalId,
    r.lastReceiptId,
  ])
    id(k);
  integer(r.revision);
  if (r.revision < 1) fail();
  if (r.previousId !== null) id(r.previousId);
  stamp(r.createdAt);
  jobSha256(r.sourceSha256);
  jobSha256(r.ownerEpoch);
  const owner = validateJobOwnerProof(r.owner),
    source = validateTerminalJobSourceProof(r.source);
  ownerMatches(owner, source);
  if (
    r.workspaceId !== owner.workspaceId ||
    r.sessionId !== owner.sessionId ||
    r.terminalId !== source.terminalId ||
    r.sourceSha256 !== source.sha256 ||
    r.ownerEpoch !== owner.ownerEpoch
  )
    fail();
  if (r.kind === "job") {
    if (
      r.jobKind !== "user-terminal-watch" ||
      r.jobId !== r.entityId ||
      ![
        "attached",
        "completed",
        "failed",
        "cancelled",
        "uncertain",
        "paused-import",
      ].includes(r.state)
    )
      fail();
    id(r.sourceRevisionId);
    if (r.lastOutputId !== null) id(r.lastOutputId);
    if (r.cursor !== null) {
      const c = validateJobOutputCursor(r.cursor);
      if (
        c.jobId !== r.jobId ||
        c.jobRevisionId !== r.sourceRevisionId ||
        c.sourceSha256 !== r.sourceSha256
      )
        fail();
    }
    if (r.outcome !== null) {
      const o = validateTerminalClosedOutcomeProof(r.outcome);
      if (o.sourceSha256 !== r.sourceSha256) fail();
      if (Date.parse(o.closedAt) < Date.parse(r.source.createdAt)) fail();
    }
    if (
      ["completed", "failed"].includes(r.state) &&
      (!r.outcome?.cleanupConfirmed || r.outcome.state !== r.state)
    )
      fail();
    if (r.state === "attached" && r.outcome !== null) fail();
    if (r.state === "completed" && r.outcome?.exitCode !== 0) fail();
  } else if (r.kind === "output") {
    id(r.jobId);
    id(r.jobRevisionId);
    if (r.outputId !== r.entityId || r.state !== "recorded") fail();
    const p = validateJobOutputPage(r.page);
    if (
      p.jobId !== r.jobId ||
      p.jobRevisionId !== r.jobRevisionId ||
      p.sourceSha256 !== r.sourceSha256
    )
      fail();
  } else if (r.kind === "delivery") {
    if (
      r.deliveryId !== r.entityId ||
      ![
        "prepared",
        "dispatching",
        "accepted",
        "cancelled",
        "uncertain",
        "paused-import",
      ].includes(r.state)
    )
      fail();
    id(r.jobId);
    id(r.settledRevisionId);
    jobSha256(r.settledSha256);
    const t = targetProof(r.target);
    if (
      t.jobId !== r.jobId ||
      t.jobRevisionId !== r.settledRevisionId ||
      t.jobSha256 !== r.settledSha256 ||
      t.settledSha256 !== r.settledSha256 ||
      t.sourceSha256 !== r.sourceSha256
    )
      fail();
    if (r.inputRequestId !== null) id(r.inputRequestId);
    if (
      r.prompt !== null &&
      (typeof r.prompt !== "string" || Buffer.byteLength(r.prompt) > 32768)
    )
      fail("JOB_LIMIT");
    if (
      ["dispatching", "accepted"].includes(r.state) &&
      (!r.inputRequestId || r.prompt === null)
    )
      fail();
    if (r.accepted !== null) {
      const a = acceptedProof(r.accepted);
      if (
        a.workspaceId !== r.workspaceId ||
        a.sessionId !== r.sessionId ||
        a.requestId !== r.inputRequestId
      )
        fail();
    }
    if (r.state === "accepted" && !r.accepted) fail();
  } else fail();
  if (r.kind !== "output" && r.errorCode !== null) id(r.errorCode);
}
/** Native proofs are local primary journal anchors; no foreign terminal database is opened. */
function anchor(
  db: DatabaseSync,
  sessionId: string,
  type: string,
  expected: Record<string, unknown>,
): void {
  const discriminator =
    expected[
      type === "terminal.output_observed"
        ? "pageSha256"
        : type === "terminal.source_closed"
          ? "outcomeSha256"
          : "sourceSha256"
    ];
  jobSha256(discriminator);
  const hs = db
    .prepare(
      "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND instr(data,?)>0 ORDER BY seq LIMIT 8193",
    )
    .all(sessionId, type, discriminator as string);
  if (hs.length > 8192) fail("JOB_LIMIT");
  for (const h of hs) {
    const bytes = integer(Number(h.bytes));
    if (bytes > 65536) fail("JOB_LIMIT");
    const raw =
      readBoundedBody(
        db,
        {
          table: "session_events",
          where: "session_id=? AND seq=?",
          params: [sessionId, h.seq!],
        },
        bytes,
        fail,
      ) ?? fail();
    const e = json(JSON.parse(raw)) as unknown as {
      sessionId: string;
      type: string;
      payload: Record<string, unknown>;
    };
    if (e.sessionId !== sessionId || e.type !== type) fail();
    if (
      Object.entries(expected).every(
        ([k, v]) => knowledgeHash(e.payload[k] ?? null) === knowledgeHash(v),
      )
    )
      return;
  }
  fail("JOB_NATIVE_SOURCE_INVALID");
}
function sourceAnchor(db: DatabaseSync, r: JobRecord): void {
  const session = db
    .prepare("SELECT workspace_id FROM sessions WHERE id=?")
    .get(r.sessionId);
  if (!session || session.workspace_id !== r.workspaceId) fail();
  const { sha256: _sourceDigest, ...sourceTuple } = r.source;
  anchor(db, r.sessionId, "terminal.source_admitted", {
    ...sourceTuple,
    sourceSha256: r.sourceSha256,
    ownerSha256: r.owner.sha256,
    rootBindingSha256: r.owner.rootBindingSha256,
    ownerEpoch: r.ownerEpoch,
  });
}
function acceptedSql(db: DatabaseSync, r: JobDelivery): void {
  if (!r.accepted) return;
  const a = r.accepted,
    h = db
      .prepare(
        "SELECT session_id,workspace_id,request_id,fingerprint,admitted_seq,length(CAST(data AS BLOB)) bytes FROM session_inputs WHERE id=?",
      )
      .get(a.inputId);
  if (
    !h ||
    h.session_id !== r.sessionId ||
    h.workspace_id !== r.workspaceId ||
    h.request_id !== r.inputRequestId ||
    h.admitted_seq !== a.admittedSeq ||
    Number(h.bytes) > JOB_STORAGE_LIMITS.inputBytes
  )
    fail("JOB_INPUT_INVALID");
  const raw =
    readBoundedBody(
      db,
      { table: "session_inputs", where: "id=?", params: [a.inputId] },
      Number(h.bytes),
      fail,
    ) ?? fail();
  const b = JSON.parse(raw) as Record<string, unknown>;
  const normalized = normalizeAcceptInput({
    sessionId: r.sessionId,
    requestId: r.inputRequestId!,
    prompt: r.prompt!,
    config: r.target.target.config,
    delivery: "queue",
  });
  if (
    knowledgeHash(normalized) !== a.inputSha256 ||
    h.fingerprint !== requestIdentity(normalized) ||
    b.sessionId !== r.sessionId ||
    b.requestId !== r.inputRequestId ||
    b.prompt !== r.prompt ||
    knowledgeHash(b.config) !== knowledgeHash(normalized.config) ||
    b.delivery !== "queue"
  )
    fail("JOB_INPUT_INVALID");
  const eh = db
    .prepare(
      "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND input_id=? AND type='input.accepted' LIMIT 2",
    )
    .all(r.sessionId, a.inputId);
  if (
    eh.length !== 1 ||
    Number(eh[0]!.bytes) > JOB_STORAGE_LIMITS.inputBytes ||
    eh[0]!.seq !== a.admittedSeq
  )
    fail("JOB_INPUT_INVALID");
  const er =
    readBoundedBody(
      db,
      {
        table: "session_events",
        where: "session_id=? AND seq=?",
        params: [r.sessionId, eh[0]!.seq!],
      },
      Number(eh[0]!.bytes),
      fail,
    ) ?? fail();
  const event = JSON.parse(er) as {
    inputId: string;
    sessionId: string;
    payload: { input: Record<string, unknown> };
  };
  if (
    event.inputId !== a.inputId ||
    event.sessionId !== r.sessionId ||
    event.payload?.input?.id !== a.inputId ||
    event.payload.input.state !== "pending" ||
    event.payload.input.admittedSeq !== a.admittedSeq ||
    event.payload.input.requestId !== r.inputRequestId ||
    event.payload.input.prompt !== r.prompt ||
    knowledgeHash(event.payload.input.config) !==
      knowledgeHash(normalized.config) ||
    event.payload.input.delivery !== "queue"
  )
    fail("JOB_INPUT_INVALID");
}
function proofSql(db: DatabaseSync, r: JobRecord): void {
  sourceAnchor(db, r);
  if (r.kind === "output")
    anchor(db, r.sessionId, "terminal.output_observed", {
      sourceSha256: r.sourceSha256,
      ownerSha256: r.owner.sha256,
      pageSha256: r.page.sha256,
      snapshotSha256: r.page.snapshotSha256,
      jobId: r.jobId,
      jobRevisionId: r.jobRevisionId,
    });
  if (r.kind === "job" && r.outcome)
    anchor(db, r.sessionId, "terminal.source_closed", {
      ...r.outcome,
      ownerSha256: r.owner.sha256,
      outcomeSha256: r.outcome.sha256,
    });
  if (r.kind === "delivery") acceptedSql(db, r);
}
function assertOutputProgress(
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
function semantic(
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
      const o = after.outcome,
        expected =
          ["uncertain", "interrupted"].includes(o.state) || !o.cleanupConfirmed
            ? "uncertain"
            : o.cancelled || o.timedOut
              ? "cancelled"
              : o.exitCode === 0
                ? "completed"
                : "failed";
      if (after.state !== expected) fail();
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

const JOB_JOURNAL: RevisionJournalProfile<JobJournalKind, JobRecord> = {
  revisions: "job_revisions",
  heads: "job_heads",
  columns: [
    "job_id",
    "created_at",
    "session_id",
    "terminal_id",
    "source_sha256",
    "owner_epoch",
    "input_id",
  ],
  limits: {
    rowBytes: JOB_STORAGE_LIMITS.rowBytes,
    rows: JOB_STORAGE_LIMITS.rows,
    bytes: JOB_STORAGE_LIMITS.bytes,
    kinds: {
      job: JOB_STORAGE_LIMITS.jobs,
      output: JOB_STORAGE_LIMITS.outputs,
      delivery: JOB_STORAGE_LIMITS.deliveries,
    },
  },
  index: (r) => ({
    job_id: r.jobId,
    created_at: r.createdAt,
    session_id: r.sessionId,
    terminal_id: r.terminalId,
    source_sha256: r.sourceSha256,
    owner_epoch: r.ownerEpoch,
    input_id: r.kind === "delivery" ? (r.accepted?.inputId ?? null) : null,
  }),
  scope(kind, entityId, operation) {
    const record = `${kind}:${entityId}:${operation}`;
    return { record, receipt: `receipt:${record}` };
  },
  receiptPrevious: (before) => before?.id ?? null,
  identifier: id,
  sealed: digest,
  verify(record, db) {
    validateRecord(record);
    proofSql(db, record);
  },
  fail,
  codes: {
    limit: "JOB_LIMIT",
    revisionConflict: "JOB_REVISION_CONFLICT",
    requestConflict: "JOB_REQUEST_CONFLICT",
  },
};
type JobJournal = RevisionJournal<
  JobJournalKind,
  JobRecord,
  JobTransitionReceipt
>;

/** Durable history is descriptive. All physical observations must be produced from ORIGINAL Root handles. */
export class JobStorage {
  private readonly journal: JobJournal;
  constructor(
    readonly db: DatabaseSync,
    private readonly ports: JobStoragePorts,
  ) {
    this.journal = createRevisionJournal<
      JobJournalKind,
      JobRecord,
      JobTransitionReceipt
    >(db, JOB_JOURNAL);
  }
  private time(): string {
    return new Date(
      integer(this.ports.now?.() ?? Date.now(), 8640000000000000),
    ).toISOString();
  }
  getJob(
    ws: string,
    jobId: string,
    revisionId?: string,
  ): CommandJob | undefined {
    if (revisionId) {
      const r = this.journal.read<CommandJob>(ws, revisionId, "job");
      if (r.jobId !== jobId) fail();
      return r;
    }
    return this.journal.head(ws, "job", jobId);
  }
  getDelivery(ws: string, deliveryId: string): JobDelivery | undefined {
    return this.journal.head(ws, "delivery", deliveryId);
  }
  inspectJobs(ws: string): CommandJob[] {
    return this.journal.list(ws, "job", JOB_STORAGE_LIMITS.jobs);
  }
  readOutputs(
    ws: string,
    jobId: string,
    afterRevision = 0,
    limit = 32,
  ): JobOutputRevision[] {
    id(jobId);
    integer(afterRevision);
    integer(limit, 32);
    if (limit < 1) fail("INVALID_JOB_INPUT");
    const hs = this.db
      .prepare(
        "SELECT id FROM job_revisions WHERE workspace_id=? AND kind='output' AND job_id=? ORDER BY json_extract(data,'$.page.nextCursor.eventSeq'),json_extract(data,'$.page.nextCursor.byteOffset'),id LIMIT ? OFFSET ?",
      )
      .all(id(ws), jobId, limit, afterRevision);
    return hs.map((h) =>
      this.journal.read<JobOutputRevision>(ws, String(h.id), "output"),
    );
  }
  inspectDeliveries(ws: string): JobDelivery[] {
    return this.journal.list(ws, "delivery", JOB_STORAGE_LIMITS.deliveries);
  }
  /** Lookups describe exact historical admission; they never grant a fresh queue accept. */
  findDeliveryForInput(value: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly requestId: string;
  }): JobDelivery | null {
    const x = json(value);
    if (
      Object.keys(x).length !== 4 ||
      ["workspaceId", "sessionId", "inputId", "requestId"].some(
        (k) => !Object.hasOwn(x, k),
      )
    )
      fail("INVALID_JOB_INPUT");
    for (const field of [x.workspaceId, x.sessionId, x.inputId, x.requestId])
      id(field);
    const linked = this.db
      .prepare(
        "SELECT h.entity_id FROM job_heads h JOIN job_revisions r ON r.id=h.revision_id WHERE h.workspace_id=? AND h.kind='delivery' AND r.input_id=? LIMIT 2",
      )
      .all(x.workspaceId, x.inputId);
    if (linked.length > 1) fail("JOB_INPUT_INVALID");
    if (linked.length) {
      const d = this.getDelivery(x.workspaceId, String(linked[0]!.entity_id))!;
      if (
        d.sessionId !== x.sessionId ||
        d.inputRequestId !== x.requestId ||
        d.accepted?.inputId !== x.inputId
      )
        fail("JOB_INPUT_INVALID");
      return d;
    }
    if (!x.requestId.startsWith("job-result:")) return null;
    const match = /^job-result:(.+):([a-f0-9]{64})$/u.exec(x.requestId);
    if (!match) fail("JOB_INPUT_INVALID");
    const hs = this.db
      .prepare(
        "SELECT entity_id FROM job_heads WHERE workspace_id=? AND kind='delivery' AND entity_id IN (SELECT entity_id FROM job_revisions WHERE workspace_id=? AND kind='delivery' AND job_id=?) LIMIT 129",
      )
      .all(x.workspaceId, x.workspaceId, id(match[1]));
    if (hs.length > JOB_STORAGE_LIMITS.deliveries) fail("JOB_LIMIT");
    const found = hs
      .map((h) => this.getDelivery(x.workspaceId, String(h.entity_id))!)
      .filter((d) => d.inputRequestId === x.requestId);
    if (found.length !== 1) fail("JOB_INPUT_UNTRACKED");
    const d = found[0]!;
    if (
      d.sessionId !== x.sessionId ||
      d.settledSha256 !== match[2] ||
      (d.accepted && d.accepted.inputId !== x.inputId)
    )
      fail("JOB_INPUT_INVALID");
    return d;
  }
  private duplicate<T extends JobRecord>(
    ws: string,
    kind: JobJournalKind,
    eid: string,
    op: string,
    x: JobMutationInput,
  ): JobRequestResult<T> | undefined {
    const pair = this.journal.replay<T>(ws, kind, eid, op, x);
    return pair && json({ ...pair, duplicate: true });
  }
  private append<T extends JobRecord>(
    kind: JobJournalKind,
    eid: string,
    op: string,
    x: JobMutationInput,
    before: T | undefined,
    body: object,
  ): JobRequestResult<T> {
    const pair = this.journal.append<T>({
      kind,
      before,
      expectedRevision: x.expectedRevision,
      build: (rid, receiptId) => {
        const at = this.time(),
          r = signed({
            ...body,
            id: rid,
            kind,
            entityId: eid,
            workspaceId: x.workspaceId,
            revision: (before?.revision ?? 0) + 1,
            previousId: before?.id ?? null,
            lastReceiptId: receiptId,
            createdAt: at,
            ...(!before && kind === "job" ? { sourceRevisionId: rid } : {}),
          }) as unknown as T;
        validateRecord(r);
        semantic(before, r, op);
        proofSql(this.db, r);
        const receipt = signed({
          id: receiptId,
          workspaceId: x.workspaceId,
          kind,
          entityId: eid,
          operation: op,
          beforeRevisionId: before?.id ?? null,
          afterRevisionId: rid,
          afterSha256: r.sha256,
          requestId: x.requestId,
          requestSha256: knowledgeHash(x),
          requestInput: x as unknown as JsonObject,
          createdAt: at,
        });
        return { record: r, receipt };
      },
      ...(RESERVED_OPERATIONS.has(op)
        ? {}
        : { reserve: (r: T) => this.reserve(r) }),
    });
    return json({ ...pair, duplicate: false });
  }
  /** Rows and bytes every job and delivery head still needs once `after` is its entity's head. */
  private reserve(after: JobRecord): { rows: number; bytes: number } {
    const heads = this.db
      .prepare(
        "SELECT json_extract(r.data,'$.state') state,length(CAST(r.data AS BLOB)) bytes FROM job_heads h JOIN job_revisions r ON r.id=h.revision_id WHERE h.kind IN ('job','delivery') AND NOT (h.workspace_id=? AND h.kind=? AND h.entity_id=?)",
      )
      .all(after.workspaceId, after.kind, after.entityId);
    if (after.kind !== "output")
      heads.push({
        state: after.state,
        bytes: Buffer.byteLength(JSON.stringify(after)),
      });
    let rows = 0,
      bytes = 0;
    for (const h of heads) {
      const n = pendingRewrites(h.state);
      rows += 2 * n;
      bytes += n * (Number(h.bytes) + REWRITE_SLACK_BYTES);
    }
    return { rows, bytes };
  }
  private mustJob(ws: string, jid: string): CommandJob {
    const r = this.getJob(ws, jid);
    if (!r) fail("JOB_NOT_FOUND");
    return r;
  }
  private original(
    original: object,
    source: TerminalJobSourceProof,
    phase: "attach" | "observe",
  ): JobOwnerProof {
    const owner = validateJobOwnerProof(this.ports.readOwner(original));
    ownerMatches(owner, source);
    this.ports.assertOwnerCurrent(original, owner, phase);
    this.ports.assertSourceCurrent(original, source, phase);
    return owner;
  }
  attachTerminalJob(
    original: object,
    value: AttachTerminalJobInput,
  ): JobRequestResult<CommandJob> {
    const x = input(value, [...mutationFields, "jobId"]);
    return this.ports.writeTx(() => {
      const dup = this.duplicate<CommandJob>(
        x.workspaceId,
        "job",
        x.jobId,
        "attach",
        x,
      );
      if (dup) return dup;
      const source = validateTerminalJobSourceProof(
          this.ports.readSource(original),
        ),
        owner = this.original(original, source, "attach");
      if (source.workspaceId !== x.workspaceId)
        fail("JOB_SOURCE_OWNER_INVALID");
      this.ports.getWorkspace(x.workspaceId);
      if (this.getJob(x.workspaceId, x.jobId)) fail("JOB_REVISION_CONFLICT");
      const heads = this.db
        .prepare(
          "SELECT workspace_id,entity_id FROM job_heads WHERE kind='job' LIMIT 129",
        )
        .all();
      let live = 0,
        sessionLive = 0;
      for (const h of heads) {
        const j = this.getJob(String(h.workspace_id), String(h.entity_id))!;
        if (j.state === "attached") {
          live++;
          if (j.sessionId === source.sessionId) sessionLive++;
        }
      }
      if (
        live >= JOB_STORAGE_LIMITS.live ||
        sessionLive >= JOB_STORAGE_LIMITS.sessionLive
      )
        fail("JOB_LIMIT");
      return this.append<CommandJob>("job", x.jobId, "attach", x, undefined, {
        jobId: x.jobId,
        jobKind: "user-terminal-watch",
        sessionId: source.sessionId,
        terminalId: source.terminalId,
        sourceSha256: source.sha256,
        ownerEpoch: owner.ownerEpoch,
        owner,
        source,
        state: "attached",
        cursor: null,
        lastOutputId: null,
        outcome: null,
        errorCode: null,
      });
    });
  }
  recordJobOutput(
    original: object,
    value: RecordJobOutputInput,
  ): JobRequestResult<CommandJob> {
    const x = input(value, [...mutationFields, "jobId", "outputId"]);
    return this.ports.writeTx(() => {
      const dup = this.duplicate<CommandJob>(
        x.workspaceId,
        "job",
        x.jobId,
        "output",
        x,
      );
      if (dup) return dup;
      const before = this.mustJob(x.workspaceId, x.jobId);
      if (
        before.revision !== x.expectedRevision ||
        before.state !== "attached" ||
        this.journal.head(x.workspaceId, "output", x.outputId)
      )
        fail("JOB_REVISION_CONFLICT");
      const p = validateJobOutputPage(this.ports.readOutput(original));
      this.original(original, before.source, "observe");
      if (
        p.jobId !== before.jobId ||
        p.jobRevisionId !== before.sourceRevisionId ||
        p.sourceSha256 !== before.sourceSha256 ||
        (!p.gap && !p.fragments.length)
      )
        fail("JOB_OUTPUT_STALE");
      assertOutputProgress(before.cursor, p);
      const ox = { ...x, expectedRevision: 0 };
      const output = this.append<JobOutputRevision>(
        "output",
        x.outputId,
        "output",
        ox,
        undefined,
        {
          outputId: x.outputId,
          jobId: before.jobId,
          jobRevisionId: before.sourceRevisionId,
          sessionId: before.sessionId,
          terminalId: before.terminalId,
          sourceSha256: before.sourceSha256,
          ownerEpoch: before.ownerEpoch,
          owner: before.owner,
          source: before.source,
          state: "recorded",
          page: p,
        },
      ).record;
      const result = this.append("job", x.jobId, "output", x, before, {
        ...before,
        cursor: p.nextCursor,
        lastOutputId: output.outputId,
      });
      return json({ ...result, output });
    });
  }
  settleTerminalJob(
    original: object,
    value: SettleTerminalJobInput,
  ): JobRequestResult<CommandJob> {
    const x = input(value, [...mutationFields, "jobId"]);
    return this.ports.writeTx(() => {
      const dup = this.duplicate<CommandJob>(
        x.workspaceId,
        "job",
        x.jobId,
        "settle",
        x,
      );
      if (dup) return dup;
      const before = this.mustJob(x.workspaceId, x.jobId);
      if (before.revision !== x.expectedRevision || before.state !== "attached")
        fail("JOB_REVISION_CONFLICT");
      const outcome = validateTerminalClosedOutcomeProof(
        this.ports.readClosedOutcome(original),
      );
      this.original(original, before.source, "observe");
      if (outcome.sourceSha256 !== before.sourceSha256)
        fail("JOB_SOURCE_OWNER_INVALID");
      const s: JobState =
        ["uncertain", "interrupted"].includes(outcome.state) ||
        !outcome.cleanupConfirmed
          ? "uncertain"
          : outcome.cancelled || outcome.timedOut
            ? "cancelled"
            : outcome.exitCode === 0
              ? "completed"
              : "failed";
      return this.append("job", x.jobId, "settle", x, before, {
        ...before,
        state: s,
        outcome,
        errorCode: s === "uncertain" ? "JOB_CLEANUP_UNCERTAIN" : null,
      });
    });
  }
  cancelWatch(value: CancelCommandJobWatchInput): JobRequestResult<CommandJob> {
    const x = input(value, [...mutationFields, "jobId"]);
    return this.ports.writeTx(() => {
      const dup = this.duplicate<CommandJob>(
        x.workspaceId,
        "job",
        x.jobId,
        "cancel-watch",
        x,
      );
      if (dup) return dup;
      const before = this.mustJob(x.workspaceId, x.jobId);
      return this.append("job", x.jobId, "cancel-watch", x, before, {
        ...before,
        state: "cancelled",
        errorCode: "JOB_WATCH_CANCELLED",
      });
    });
  }
  /** One primary COMMIT owns preparation, dispatch, actual queued input and its accepted receipt. */
  private assertAtomicHistory(
    record: JobDelivery,
    receipt: JobTransitionReceipt,
    x: DeliverJobResultAtomicInput,
  ): void {
    if (
      x.expectedRevision !== 0 ||
      record.state !== "accepted" ||
      record.revision !== 3 ||
      record.jobId !== x.jobId ||
      record.deliveryId !==
        knowledgeHash([
          "job-result-delivery-v1",
          x.workspaceId,
          x.jobId,
          record.settledSha256,
        ]) ||
      record.lastReceiptId !== receipt.id ||
      receipt.operation !== "delivery-accepted" ||
      receipt.requestId !== x.requestId ||
      receipt.afterSha256 !== record.sha256 ||
      !record.previousId
    )
      fail("JOB_REQUEST_CONFLICT");
    const intent = this.journal.read<JobDelivery>(
      x.workspaceId,
      record.previousId,
      "delivery",
    );
    if (!intent.previousId) fail();
    const prepared = this.journal.read<JobDelivery>(
      x.workspaceId,
      intent.previousId,
      "delivery",
    );
    const prepareReceipt = this.journal.read<JobTransitionReceipt>(
      x.workspaceId,
      prepared.lastReceiptId,
      "transition",
    );
    const intentReceipt = this.journal.read<JobTransitionReceipt>(
      x.workspaceId,
      intent.lastReceiptId,
      "transition",
    );
    if (
      prepareReceipt.requestId !== `atomic-prepare:${knowledgeHash(x)}` ||
      intentReceipt.requestId !== `atomic-intent:${knowledgeHash(x)}` ||
      prepareReceipt.afterSha256 !== prepared.sha256 ||
      intentReceipt.afterSha256 !== intent.sha256 ||
      prepared.revision !== 1 ||
      intent.revision !== 2 ||
      prepared.deliveryId !== record.deliveryId ||
      intent.deliveryId !== record.deliveryId ||
      receipt.beforeRevisionId !== intent.id
    )
      fail("JOB_REQUEST_CONFLICT");
    semantic(undefined, prepared, prepareReceipt.operation);
    semantic(prepared, intent, intentReceipt.operation);
    semantic(intent, record, receipt.operation);
  }
  deliverJobResultAtomic(
    originalTarget: object,
    value: DeliverJobResultAtomicInput,
  ): JobRequestResult<JobDelivery> {
    const x = input(value, [...mutationFields, "jobId"]);
    return this.ports.writeTx(() => {
      // A completed native request is descriptive history, even when its live target was released.
      const hs = this.db
        .prepare(
          "SELECT id FROM job_revisions WHERE workspace_id=? AND kind='transition' AND job_id=? AND request_id=? AND request_scope GLOB 'receipt:delivery:*:delivery-accepted' LIMIT 2",
        )
        .all(x.workspaceId, x.jobId, x.requestId);
      if (hs.length > 1) fail("JOB_REQUEST_CONFLICT");
      if (hs.length) {
        const receipt = this.journal.read<JobTransitionReceipt>(
          x.workspaceId,
          String(hs[0]!.id),
          "transition",
        );
        if (
          !Object.hasOwn(receipt.requestInput, "atomicRequest") ||
          knowledgeHash(receipt.requestInput.atomicRequest) !== knowledgeHash(x)
        )
          fail("JOB_REQUEST_CONFLICT");
        const record = this.journal.read<JobDelivery>(
          x.workspaceId,
          receipt.afterRevisionId,
          "delivery",
        );
        this.assertAtomicHistory(record, receipt, x);
        return json({ record, receipt, duplicate: true });
      }
      // Existing two-phase intents and uncertain gaps must be reconciled, never accepted again.
      const prior = this.db
        .prepare(
          "SELECT h.entity_id FROM job_heads h JOIN job_revisions r ON r.id=h.revision_id WHERE h.workspace_id=? AND h.kind='delivery' AND r.job_id=? LIMIT 2",
        )
        .all(x.workspaceId, x.jobId);
      if (prior.length) fail("JOB_DELIVERY_EXISTS");
      if (!this.ports.acceptAtomicInput || !this.ports.releaseAtomicInput)
        fail("JOB_ATOMIC_DELIVERY_UNSUPPORTED");
      const job = this.mustJob(x.workspaceId, x.jobId);
      const deliveryId = knowledgeHash([
        "job-result-delivery-v1",
        x.workspaceId,
        x.jobId,
        job.sha256,
      ]);
      const identity = knowledgeHash(x);
      const prepared = this.prepareDelivery(originalTarget, {
        ...x,
        deliveryId,
        requestId: `atomic-prepare:${identity}`,
      });
      const prompt = formatJobResult(job, prepared.record.target);
      const inputRequestId = `job-result:${x.jobId}:${job.sha256}`;
      const dispatched = this.dispatchDelivery(originalTarget, {
        workspaceId: x.workspaceId,
        deliveryId,
        requestId: `atomic-intent:${identity}`,
        expectedRevision: prepared.record.revision,
        inputRequestId,
        prompt,
      });
      const accepted = this.ports.acceptAtomicInput(originalTarget, {
        inputRequestId,
        prompt,
      });
      try {
        if (
          !accepted ||
          typeof accepted !== "object" ||
          nodeTypes.isProxy(accepted) ||
          nodeTypes.isPromise(accepted)
        )
          fail("JOB_ATOMIC_INPUT_INVALID");
        return this.acceptedDelivery(
          originalTarget,
          accepted,
          {
            workspaceId: x.workspaceId,
            deliveryId,
            requestId: x.requestId,
            expectedRevision: dispatched.record.revision,
            atomicRequest: x,
          } as MutateJobDeliveryInput,
          "delivery-accepted",
        );
      } finally {
        const released = this.ports.releaseAtomicInput(accepted);
        if (nodeTypes.isPromise(released)) fail("JOB_ATOMIC_INPUT_INVALID");
      }
    });
  }
  prepareJobDelivery(
    original: object,
    value: PrepareJobDeliveryInput,
  ): JobRequestResult<JobDelivery> {
    const x = input(value, [...mutationFields, "jobId", "deliveryId"]);
    return this.ports.writeTx(() => this.prepareDelivery(original, x));
  }
  private prepareDelivery(
    original: object,
    x: PrepareJobDeliveryInput,
  ): JobRequestResult<JobDelivery> {
    const dup = this.duplicate<JobDelivery>(
      x.workspaceId,
      "delivery",
      x.deliveryId,
      "delivery-prepare",
      x,
    );
    if (dup) return dup;
    const job = this.mustJob(x.workspaceId, x.jobId);
    if (
      !["completed", "failed", "cancelled"].includes(job.state) ||
      !job.outcome?.cleanupConfirmed
    )
      fail("JOB_NOT_SETTLED");
    const target = targetProof(this.ports.readDeliveryTarget(original));
    this.ports.assertDeliveryTargetCurrent(original, target);
    if (
      target.workspaceId !== x.workspaceId ||
      target.jobId !== job.jobId ||
      target.jobRevisionId !== job.id ||
      target.jobSha256 !== job.sha256 ||
      target.settledSha256 !== job.sha256 ||
      target.sourceSha256 !== job.sourceSha256 ||
      target.target.sessionId !== job.sessionId
    )
      fail("JOB_DELIVERY_STALE");
    const existing = this.db
      .prepare(
        "SELECT entity_id FROM job_heads WHERE workspace_id=? AND kind='delivery' LIMIT 129",
      )
      .all(x.workspaceId);
    for (const h of existing)
      if (
        this.getDelivery(x.workspaceId, String(h.entity_id))!.jobId ===
        job.jobId
      )
        fail("JOB_DELIVERY_EXISTS");
    return this.append<JobDelivery>(
      "delivery",
      x.deliveryId,
      "delivery-prepare",
      x,
      undefined,
      {
        deliveryId: x.deliveryId,
        jobId: job.jobId,
        settledRevisionId: job.id,
        settledSha256: job.sha256,
        sessionId: job.sessionId,
        terminalId: job.terminalId,
        sourceSha256: job.sourceSha256,
        ownerEpoch: job.ownerEpoch,
        owner: job.owner,
        source: job.source,
        target,
        state: "prepared",
        inputRequestId: null,
        prompt: null,
        accepted: null,
        errorCode: null,
      },
    );
  }
  dispatchJobDelivery(
    original: object,
    value: DispatchJobDeliveryInput,
  ): JobRequestResult<JobDelivery> {
    const x = input(value, [
      ...mutationFields,
      "deliveryId",
      "inputRequestId",
      "prompt",
    ]);
    return this.ports.writeTx(() => this.dispatchDelivery(original, x));
  }
  private dispatchDelivery(
    original: object,
    x: DispatchJobDeliveryInput,
  ): JobRequestResult<JobDelivery> {
    const dup = this.duplicate<JobDelivery>(
      x.workspaceId,
      "delivery",
      x.deliveryId,
      "delivery-intent",
      x,
    );
    if (dup) return dup;
    const before = this.getDelivery(x.workspaceId, x.deliveryId);
    if (!before) fail("JOB_NOT_FOUND");
    const target = targetProof(this.ports.readDeliveryTarget(original));
    this.ports.assertDeliveryTargetCurrent(original, target);
    if (
      target.sha256 !== before.target.sha256 ||
      x.inputRequestId !==
        `job-result:${before.jobId}:${before.settledSha256}` ||
      x.prompt !==
        formatJobResult(
          this.mustJob(x.workspaceId, before.jobId),
          before.target,
        )
    )
      fail("JOB_DELIVERY_STALE");
    return this.append("delivery", x.deliveryId, "delivery-intent", x, before, {
      ...before,
      state: "dispatching",
      inputRequestId: x.inputRequestId,
      prompt: x.prompt,
    });
  }
  private acceptedDelivery(
    originalTarget: object,
    originalAccepted: object,
    x: MutateJobDeliveryInput,
    op: "delivery-accepted" | "delivery-reconcile",
  ): JobRequestResult<JobDelivery> {
    const dup = this.duplicate<JobDelivery>(
      x.workspaceId,
      "delivery",
      x.deliveryId,
      op,
      x,
    );
    if (dup) return dup;
    const before = this.getDelivery(x.workspaceId, x.deliveryId);
    if (!before) fail("JOB_NOT_FOUND");
    const target = targetProof(this.ports.readDeliveryTarget(originalTarget));
    this.ports.assertDeliveryTargetCurrent(originalTarget, target);
    if (target.sha256 !== before.target.sha256) fail("JOB_DELIVERY_STALE");
    const accepted = acceptedProof(this.ports.readAccepted(originalAccepted));
    return this.append("delivery", x.deliveryId, op, x, before, {
      ...before,
      state: "accepted",
      accepted,
      errorCode: null,
    });
  }
  completeJobDelivery(
    originalTarget: object,
    originalAccepted: object,
    value: MutateJobDeliveryInput,
  ): JobRequestResult<JobDelivery> {
    const x = input(value, [...mutationFields, "deliveryId"]);
    return this.ports.writeTx(() =>
      this.acceptedDelivery(
        originalTarget,
        originalAccepted,
        x,
        "delivery-accepted",
      ),
    );
  }
  abandonJobDelivery(
    value: AbandonJobDeliveryInput,
  ): JobRequestResult<JobDelivery> {
    const x = input(value, [
      ...mutationFields,
      "deliveryId",
      "operation",
      "errorCode",
    ]);
    return this.ports.writeTx(() => {
      const op =
          x.operation === "cancelled"
            ? "delivery-cancel"
            : "delivery-uncertain",
        dup = this.duplicate<JobDelivery>(
          x.workspaceId,
          "delivery",
          x.deliveryId,
          op,
          x,
        );
      if (dup) return dup;
      const before = this.getDelivery(x.workspaceId, x.deliveryId);
      if (!before) fail("JOB_NOT_FOUND");
      return this.append("delivery", x.deliveryId, op, x, before, {
        ...before,
        state: x.operation,
        errorCode: id(x.errorCode),
      });
    });
  }
  validateGraph(): void {
    const graph = this.journal.scan(),
      records = graph.records;
    for (const r of records.values()) {
      const t = this.journal.receiptOf(r, graph),
        before = this.journal.previousOf(r, graph);
      if (before) assertRevisionLink(before, r, fail);
      semantic(before, r, t.operation);
      if (Object.hasOwn(t.requestInput, "atomicRequest")) {
        if (r.kind !== "delivery") fail();
        const request = input(
          t.requestInput
            .atomicRequest as unknown as DeliverJobResultAtomicInput,
          [...mutationFields, "jobId"],
        );
        this.assertAtomicHistory(r, t, request);
      }
      if (!["recover", "pause-import"].includes(t.operation)) {
        if (r.kind === "job" && t.requestInput.jobId !== r.jobId) fail();
        if (
          r.kind === "output" &&
          (t.requestInput.jobId !== r.jobId ||
            t.requestInput.outputId !== r.outputId)
        )
          fail();
        if (
          r.kind === "delivery" &&
          (t.requestInput.deliveryId !== r.deliveryId ||
            (t.operation === "delivery-prepare" &&
              t.requestInput.jobId !== r.jobId))
        )
          fail();
      }
      if (r.kind === "job") {
        const admission = records.get(r.sourceRevisionId);
        if (
          !admission ||
          admission.kind !== "job" ||
          admission.revision !== 1 ||
          admission.state !== "attached" ||
          admission.jobId !== r.jobId ||
          admission.sourceSha256 !== r.sourceSha256 ||
          admission.owner.sha256 !== r.owner.sha256
        )
          fail();
        if (t.operation === "output") {
          const o = [...records.values()].find(
            (x) =>
              x.kind === "output" &&
              x.outputId === r.lastOutputId &&
              x.workspaceId === r.workspaceId,
          ) as JobOutputRevision | undefined;
          if (
            !o ||
            o.jobId !== r.jobId ||
            o.page.nextCursor.sha256 !== r.cursor?.sha256 ||
            o.sourceSha256 !== r.sourceSha256
          )
            fail();
          assertOutputProgress((before as CommandJob).cursor, o.page);
        }
      }
      if (r.kind === "output") {
        const admission = records.get(r.jobRevisionId);
        if (
          !admission ||
          admission.kind !== "job" ||
          admission.revision !== 1 ||
          admission.jobId !== r.jobId ||
          admission.sourceSha256 !== r.sourceSha256 ||
          admission.owner.sha256 !== r.owner.sha256
        )
          fail();
      }
      if (r.kind === "delivery") {
        const settled = records.get(r.settledRevisionId);
        if (
          !settled ||
          settled.kind !== "job" ||
          settled.jobId !== r.jobId ||
          settled.sha256 !== r.settledSha256 ||
          !settled.outcome?.cleanupConfirmed ||
          !["completed", "failed", "cancelled"].includes(settled.state) ||
          settled.owner.sha256 !== r.owner.sha256
        )
          fail();
        if (
          r.prompt !== null &&
          r.prompt !== formatJobResult(settled, r.target)
        )
          fail("JOB_DELIVERY_STALE");
        if (
          r.inputRequestId !== null &&
          r.inputRequestId !== `job-result:${r.jobId}:${r.settledSha256}`
        )
          fail("JOB_INPUT_INVALID");
      }
    }
    this.journal.assertHeads(graph);
    const grouped = new Map<string, number>();
    let live = 0;
    for (const h of graph.heads) {
      if (h.kind !== "job") continue;
      const j = records.get(h.revision_id) as CommandJob;
      if (j.state === "attached") {
        live++;
        grouped.set(j.sessionId, (grouped.get(j.sessionId) ?? 0) + 1);
      }
    }
    if (
      live > JOB_STORAGE_LIMITS.live ||
      [...grouped.values()].some((x) => x > JOB_STORAGE_LIMITS.sessionLive)
    )
      fail("JOB_LIMIT");
  }
  rewriteLocal(
    operation: "recover" | "pause-import",
    archiveSha?: string,
    workspaceId?: string,
  ): number {
    this.validateGraph();
    if (archiveSha !== undefined) jobSha256(archiveSha);
    if (workspaceId !== undefined) id(workspaceId);
    const hs = this.db
      .prepare(
        "SELECT workspace_id,kind,entity_id FROM job_heads WHERE kind IN ('job','delivery') ORDER BY workspace_id,kind,entity_id LIMIT 257",
      )
      .all();
    if (hs.length > 256) fail("JOB_LIMIT");
    let count = 0;
    for (const h of hs) {
      if (workspaceId !== undefined && h.workspace_id !== workspaceId) continue;
      const kind = String(h.kind) as "job" | "delivery",
        before = this.journal.head<JobRecord>(
          String(h.workspace_id),
          kind,
          String(h.entity_id),
        )!;
      if (
        operation === "recover" &&
        !(
          (kind === "job" && before.state === "attached") ||
          (kind === "delivery" &&
            ["prepared", "dispatching"].includes(before.state))
        )
      )
        continue;
      if (operation === "pause-import" && before.state === "paused-import")
        continue;
      const x = {
        workspaceId: before.workspaceId,
        requestId: `${operation}:${knowledgeHash({ revision: before.id, archiveSha: archiveSha ?? null })}`,
        expectedRevision: before.revision,
      };
      this.append(kind, before.entityId, operation, x, before, {
        ...before,
        state: operation === "recover" ? "uncertain" : "paused-import",
        errorCode:
          operation === "recover"
            ? "JOB_RECOVERY_REQUIRED"
            : "JOB_IMPORTED_PAUSED",
      });
      count++;
    }
    return count;
  }

  recoverInterrupted(): number {
    return this.ports.writeTx(() => recoverInterruptedJobs(this.db));
  }
}

function metadataPorts(): JobStoragePorts {
  const unavailable = (): never => fail("JOB_ORIGINAL_REQUIRED");
  return {
    writeTx: (op) => op(),
    getWorkspace: unavailable,
    readOwner: unavailable,
    assertOwnerCurrent: unavailable,
    readSource: unavailable,
    assertSourceCurrent: unavailable,
    readOutput: unavailable,
    readClosedOutcome: unavailable,
    readDeliveryTarget: unavailable,
    assertDeliveryTargetCurrent: unavailable,
    readAccepted: unavailable,
  };
}
function transaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) return operation();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function validateJobDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  options.check?.();
  new JobStorage(db, metadataPorts()).validateGraph();
  options.check?.();
}
function recoverInterruptedJobs(db: DatabaseSync): number {
  return transaction(db, () =>
    new JobStorage(db, metadataPorts()).rewriteLocal("recover"),
  );
}
export function markImportedJobsPaused(
  db: DatabaseSync,
  archiveSha: string,
  workspaceId?: string,
): number {
  return transaction(db, () =>
    new JobStorage(db, metadataPorts()).rewriteLocal(
      "pause-import",
      archiveSha,
      workspaceId,
    ),
  );
}
