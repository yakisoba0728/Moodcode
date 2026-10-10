import { randomUUID } from "node:crypto";
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
import { validateScheduleTarget } from "../schedules/spec.js";
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
    phase: "attach" | "observe" | "deliver",
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
type Body = JobRecord | JobTransitionReceipt;
interface Row {
  id: string;
  workspace_id: string;
  kind: string;
  entity_id: string;
  job_id: string;
  created_at: string;
  revision: number;
  previous_id: string | null;
  session_id: string;
  terminal_id: string;
  source_sha256: string;
  owner_epoch: string;
  input_id: string | null;
  request_scope: string;
  request_id: string;
  request_sha256: string;
  sha256: string;
  bytes: number;
  data?: string;
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
  validateScheduleTarget(x.target);
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
    if (integer(Number(h.bytes)) > 65536) fail("JOB_LIMIT");
    const row = db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
      )
      .get(sessionId, h.seq!, h.bytes!);
    if (!row) fail();
    const e = json(JSON.parse(String(row.data))) as unknown as {
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
  const row = db
    .prepare(
      "SELECT data FROM session_inputs WHERE id=? AND length(CAST(data AS BLOB))=?",
    )
    .get(a.inputId, h.bytes!);
  if (!row) fail();
  const b = JSON.parse(String(row.data)) as Record<string, unknown>;
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
  const er = db
    .prepare(
      "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
    )
    .get(r.sessionId, eh[0]!.seq!, eh[0]!.bytes!);
  if (!er) fail();
  const event = JSON.parse(String(er.data)) as {
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
function state(r: JobRecord): string {
  return r.state;
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

/** Durable history is descriptive. All physical observations must be produced from ORIGINAL Root handles. */
export class JobStorage {
  constructor(
    readonly db: DatabaseSync,
    private readonly ports: JobStoragePorts,
  ) {}
  private time(): string {
    return new Date(
      integer(this.ports.now?.() ?? Date.now(), 8640000000000000),
    ).toISOString();
  }
  private read<T extends Body>(ws: string, rid: string, kind?: string): T {
    const h = this.db
      .prepare(
        "SELECT id,workspace_id,kind,entity_id,job_id,created_at,revision,previous_id,session_id,terminal_id,source_sha256,owner_epoch,input_id,request_scope,request_id,request_sha256,sha256,length(CAST(data AS BLOB)) bytes FROM job_revisions WHERE workspace_id=? AND id=?",
      )
      .get(id(ws), id(rid)) as unknown as Row | undefined;
    if (!h || (kind && h.kind !== kind)) fail();
    if (integer(h.bytes) > JOB_STORAGE_LIMITS.rowBytes) fail("JOB_LIMIT");
    const row = this.db
      .prepare(
        "SELECT data FROM job_revisions WHERE workspace_id=? AND id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(ws, rid, h.bytes);
    if (!row) fail();
    const r = digest(JSON.parse(String(row.data))) as Body;
    if (
      r.id !== h.id ||
      r.workspaceId !== h.workspace_id ||
      r.entityId !== h.entity_id ||
      r.sha256 !== h.sha256
    )
      fail();
    if (h.kind === "transition") {
      const t = r as JobTransitionReceipt;
      if (
        t.requestId !== h.request_id ||
        t.requestSha256 !== h.request_sha256 ||
        knowledgeHash(t.requestInput) !== t.requestSha256
      )
        fail();
    } else {
      const b = r as JobRecord;
      validateRecord(b);
      if (
        b.kind !== h.kind ||
        b.jobId !== h.job_id ||
        b.createdAt !== h.created_at ||
        b.revision !== h.revision ||
        b.previousId !== h.previous_id ||
        b.sessionId !== h.session_id ||
        b.terminalId !== h.terminal_id ||
        b.sourceSha256 !== h.source_sha256 ||
        b.ownerEpoch !== h.owner_epoch ||
        h.input_id !==
          (b.kind === "delivery" ? (b.accepted?.inputId ?? null) : null)
      )
        fail();
      proofSql(this.db, b);
    }
    return r as T;
  }
  private head<T extends JobRecord>(
    ws: string,
    kind: JobJournalKind,
    eid: string,
  ): T | undefined {
    const h = this.db
      .prepare(
        "SELECT revision_id,revision,sha256 FROM job_heads WHERE workspace_id=? AND kind=? AND entity_id=?",
      )
      .get(id(ws), kind, id(eid));
    if (!h) return;
    const r = this.read<T>(ws, String(h.revision_id), kind);
    if (
      r.entityId !== eid ||
      r.revision !== h.revision ||
      r.sha256 !== h.sha256 ||
      this.db
        .prepare(
          "SELECT max(revision) n FROM job_revisions WHERE workspace_id=? AND kind=? AND entity_id=?",
        )
        .get(ws, kind, eid)?.n !== r.revision
    )
      fail();
    return r;
  }
  getJob(
    ws: string,
    jobId: string,
    revisionId?: string,
  ): CommandJob | undefined {
    if (revisionId) {
      const r = this.read<CommandJob>(ws, revisionId, "job");
      if (r.jobId !== jobId) fail();
      return r;
    }
    return this.head(ws, "job", jobId);
  }
  getDelivery(ws: string, deliveryId: string): JobDelivery | undefined {
    return this.head(ws, "delivery", deliveryId);
  }
  inspectJobs(ws: string): CommandJob[] {
    const hs = this.db
      .prepare(
        "SELECT entity_id FROM job_heads WHERE workspace_id=? AND kind='job' ORDER BY entity_id LIMIT 129",
      )
      .all(id(ws));
    if (hs.length > JOB_STORAGE_LIMITS.jobs) fail("JOB_LIMIT");
    return hs.map((h) =>
      this.head<CommandJob>(ws, "job", String(h.entity_id))!,
    );
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
      this.read<JobOutputRevision>(ws, String(h.id), "output"),
    );
  }
  inspectOutputs(ws: string, jobId: string): JobOutputRevision[] {
    return this.readOutputs(ws, jobId, 0, 32);
  }
  inspectDeliveries(ws: string): JobDelivery[] {
    const hs = this.db
      .prepare(
        "SELECT entity_id FROM job_heads WHERE workspace_id=? AND kind='delivery' ORDER BY entity_id LIMIT 129",
      )
      .all(id(ws));
    if (hs.length > JOB_STORAGE_LIMITS.deliveries) fail("JOB_LIMIT");
    return hs.map((h) => this.getDelivery(ws, String(h.entity_id))!);
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
    const h = this.db
      .prepare(
        "SELECT id,request_sha256 FROM job_revisions WHERE workspace_id=? AND kind='transition' AND request_scope=? AND request_id=?",
      )
      .get(ws, `receipt:${kind}:${eid}:${op}`, x.requestId);
    if (!h) return;
    if (h.request_sha256 !== knowledgeHash(x)) fail("JOB_REQUEST_CONFLICT");
    const receipt = this.read<JobTransitionReceipt>(
      ws,
      String(h.id),
      "transition",
    );
    return json({
      record: this.read<T>(ws, receipt.afterRevisionId, kind),
      receipt,
      duplicate: true,
    });
  }
  private append<T extends JobRecord>(
    kind: JobJournalKind,
    eid: string,
    op: string,
    x: JobMutationInput,
    before: T | undefined,
    body: object,
  ): JobRequestResult<T> {
    if ((before?.revision ?? 0) !== x.expectedRevision)
      fail("JOB_REVISION_CONFLICT");
    const max =
      kind === "job"
        ? JOB_STORAGE_LIMITS.jobs
        : kind === "output"
          ? JOB_STORAGE_LIMITS.outputs
          : JOB_STORAGE_LIMITS.deliveries;
    if (
      !before &&
      Number(
        this.db
          .prepare("SELECT count(*) n FROM job_heads WHERE kind=?")
          .get(kind)?.n,
      ) >= max
    )
      fail("JOB_LIMIT");
    const total = this.db
      .prepare(
        "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM job_revisions",
      )
      .get()!;
    if (Number(total.n) + 2 > JOB_STORAGE_LIMITS.rows) fail("JOB_LIMIT");
    const rid = randomUUID(),
      receiptId = randomUUID(),
      at = this.time(),
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
    const reserve = RESERVED_OPERATIONS.has(op)
      ? { rows: 0, bytes: 0 }
      : this.reserve(r);
    if (
      Number(total.n) + 2 + reserve.rows > JOB_STORAGE_LIMITS.rows ||
      Number(total.bytes) +
        Buffer.byteLength(JSON.stringify(r)) +
        Buffer.byteLength(JSON.stringify(receipt)) +
        reserve.bytes >
        JOB_STORAGE_LIMITS.bytes
    )
      fail("JOB_LIMIT");
    const insert = this.db.prepare(
        "INSERT INTO job_revisions(id,workspace_id,kind,entity_id,job_id,created_at,revision,previous_id,session_id,terminal_id,source_sha256,owner_epoch,input_id,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ),
      scope = `${kind}:${eid}:${op}`,
      inputId = r.kind === "delivery" ? (r.accepted?.inputId ?? null) : null;
    insert.run(
      rid,
      x.workspaceId,
      kind,
      eid,
      r.jobId,
      r.createdAt,
      r.revision,
      r.previousId,
      r.sessionId,
      r.terminalId,
      r.sourceSha256,
      r.ownerEpoch,
      inputId,
      scope,
      x.requestId,
      receipt.requestSha256,
      r.sha256,
      JSON.stringify(r),
    );
    insert.run(
      receiptId,
      x.workspaceId,
      "transition",
      eid,
      r.jobId,
      r.createdAt,
      r.revision,
      before?.id ?? null,
      r.sessionId,
      r.terminalId,
      r.sourceSha256,
      r.ownerEpoch,
      inputId,
      `receipt:${scope}`,
      x.requestId,
      receipt.requestSha256,
      receipt.sha256,
      JSON.stringify(receipt),
    );
    if (before) {
      const changed = this.db
        .prepare(
          "UPDATE job_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind=? AND entity_id=? AND revision_id=?",
        )
        .run(rid, r.revision, r.sha256, x.workspaceId, kind, eid, before.id);
      if (changed.changes !== 1) fail("JOB_REVISION_CONFLICT");
    } else
      this.db
        .prepare(
          "INSERT INTO job_heads(workspace_id,kind,entity_id,revision_id,revision,sha256) VALUES(?,?,?,?,?,?)",
        )
        .run(x.workspaceId, kind, eid, rid, r.revision, r.sha256);
    return json({ record: r, receipt, duplicate: false });
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
        this.head(x.workspaceId, "output", x.outputId)
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
    const intent = this.read<JobDelivery>(
      x.workspaceId,
      record.previousId,
      "delivery",
    );
    if (!intent.previousId) fail();
    const prepared = this.read<JobDelivery>(
      x.workspaceId,
      intent.previousId,
      "delivery",
    );
    const prepareReceipt = this.read<JobTransitionReceipt>(
      x.workspaceId,
      prepared.lastReceiptId,
      "transition",
    );
    const intentReceipt = this.read<JobTransitionReceipt>(
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
        const receipt = this.read<JobTransitionReceipt>(
          x.workspaceId,
          String(hs[0]!.id),
          "transition",
        );
        if (
          !Object.hasOwn(receipt.requestInput, "atomicRequest") ||
          knowledgeHash(receipt.requestInput.atomicRequest) !== knowledgeHash(x)
        )
          fail("JOB_REQUEST_CONFLICT");
        const record = this.read<JobDelivery>(
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
  private accepted(
    originalTarget: object,
    originalAccepted: object,
    value: MutateJobDeliveryInput,
    op: "delivery-accepted" | "delivery-reconcile",
  ): JobRequestResult<JobDelivery> {
    const x = input(value, [...mutationFields, "deliveryId"]);
    return this.ports.writeTx(() =>
      this.acceptedDelivery(originalTarget, originalAccepted, x, op),
    );
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
    return this.accepted(
      originalTarget,
      originalAccepted,
      value,
      "delivery-accepted",
    );
  }
  reconcileJobDelivery(
    originalTarget: object,
    originalAccepted: object,
    value: MutateJobDeliveryInput,
  ): JobRequestResult<JobDelivery> {
    return this.accepted(
      originalTarget,
      originalAccepted,
      value,
      "delivery-reconcile",
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
    const totals = this.db
      .prepare(
        "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM job_revisions",
      )
      .get()!;
    if (
      Number(totals.n) > JOB_STORAGE_LIMITS.rows ||
      Number(totals.bytes) > JOB_STORAGE_LIMITS.bytes
    )
      fail("JOB_LIMIT");
    for (const [kind, max] of [
      ["job", JOB_STORAGE_LIMITS.jobs],
      ["output", JOB_STORAGE_LIMITS.outputs],
      ["delivery", JOB_STORAGE_LIMITS.deliveries],
    ] as const)
      if (
        Number(
          this.db
            .prepare("SELECT count(*) n FROM job_heads WHERE kind=?")
            .get(kind)?.n,
        ) > max
      )
        fail("JOB_LIMIT");
    const hs = this.db
      .prepare(
        "SELECT workspace_id,id,kind,entity_id,revision,request_scope FROM job_revisions ORDER BY workspace_id,kind,entity_id,revision,id LIMIT 8193",
      )
      .all();
    const records = new Map<string, JobRecord>(),
      receipts = new Map<string, JobTransitionReceipt>();
    for (const h of hs) {
      const r = this.read<Body>(
        String(h.workspace_id),
        String(h.id),
        String(h.kind),
      );
      if (h.kind === "transition")
        receipts.set(r.id, r as JobTransitionReceipt);
      else records.set(r.id, r as JobRecord);
    }
    for (const r of records.values()) {
      const t = receipts.get(r.lastReceiptId);
      if (
        !t ||
        t.kind !== r.kind ||
        t.entityId !== r.entityId ||
        t.workspaceId !== r.workspaceId ||
        t.beforeRevisionId !== r.previousId ||
        t.afterRevisionId !== r.id ||
        t.afterSha256 !== r.sha256 ||
        t.createdAt !== r.createdAt
      )
        fail();
      const before =
        r.previousId === null ? undefined : records.get(r.previousId);
      if (
        (r.previousId && !before) ||
        (before &&
          (before.kind !== r.kind ||
            before.entityId !== r.entityId ||
            before.workspaceId !== r.workspaceId ||
            before.revision + 1 !== r.revision)) ||
        (!before && r.revision !== 1)
      )
        fail();
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
      if (
        t.requestInput.workspaceId !== r.workspaceId ||
        t.requestInput.requestId !== t.requestId ||
        t.requestInput.expectedRevision !== (before?.revision ?? 0)
      )
        fail();
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
      const h = this.db
        .prepare(
          "SELECT request_id,request_sha256,request_scope,session_id,terminal_id,source_sha256,owner_epoch,input_id,job_id,created_at FROM job_revisions WHERE id=?",
        )
        .get(r.id)!;
      const th = this.db
        .prepare(
          "SELECT request_id,request_sha256,request_scope,session_id,terminal_id,source_sha256,owner_epoch,input_id,job_id,created_at FROM job_revisions WHERE id=?",
        )
        .get(t.id)!;
      if (
        h.request_scope !== `${r.kind}:${r.entityId}:${t.operation}` ||
        th.request_scope !== `receipt:${h.request_scope}` ||
        h.request_id !== t.requestId ||
        h.request_sha256 !== t.requestSha256
      )
        fail();
      for (const k of [
        "request_id",
        "request_sha256",
        "session_id",
        "terminal_id",
        "source_sha256",
        "owner_epoch",
        "input_id",
        "job_id",
        "created_at",
      ] as const)
        if (h[k] !== th[k]) fail();
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
      receipts.delete(t.id);
    }
    if (receipts.size) fail();
    const heads = this.db
      .prepare("SELECT workspace_id,kind,entity_id FROM job_heads LIMIT 4353")
      .all();
    const latest = new Map<string, JobRecord>();
    for (const r of records.values()) {
      const key = knowledgeHash([r.workspaceId, r.kind, r.entityId]),
        prior = latest.get(key);
      if (!prior || prior.revision < r.revision) latest.set(key, r);
    }
    for (const h of heads) {
      this.head(
        String(h.workspace_id),
        String(h.kind) as JobJournalKind,
        String(h.entity_id),
      );
      latest.delete(knowledgeHash([h.workspace_id, h.kind, h.entity_id]));
    }
    if (latest.size) fail();
    const grouped = new Map<string, number>();
    let live = 0;
    for (const h of heads) {
      if (h.kind !== "job") continue;
      const j = this.getJob(String(h.workspace_id), String(h.entity_id))!;
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
        before = this.head<JobRecord>(
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

function metadataPorts(db: DatabaseSync): JobStoragePorts {
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
  new JobStorage(db, metadataPorts(db)).validateGraph();
  options.check?.();
}
export const validateJobsDatabase = validateJobDatabase;
export function recoverInterruptedJobs(db: DatabaseSync): number {
  return transaction(db, () =>
    new JobStorage(db, metadataPorts(db)).rewriteLocal("recover"),
  );
}
export function markImportedJobsPaused(
  db: DatabaseSync,
  archiveSha: string,
  workspaceId?: string,
): number {
  return transaction(db, () =>
    new JobStorage(db, metadataPorts(db)).rewriteLocal(
      "pause-import",
      archiveSha,
      workspaceId,
    ),
  );
}
