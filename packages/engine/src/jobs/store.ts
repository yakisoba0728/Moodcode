import { types as nodeTypes } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { JsonObject, Workspace } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  assertRevisionLink,
  createRevisionJournal,
  type RevisionJournal,
  type RevisionJournalProfile,
} from "../storage/revision-journal.js";
import {
  formatJobResult,
  isDeliverableJob,
  jobResultDeliveryId,
  jobResultInputRequestId,
  parseJobResultInputRequestId,
  type JobAcceptedInputProof,
  type JobDeliveryTargetProof,
} from "./delivery.js";
import {
  JOB_LIMITS,
  type JobOwnerProof,
  type TerminalJobSourceProof,
  type TerminalClosedOutcomeProof,
  type JobOutputPage,
  type JobOutputCursor,
} from "./types.js";
import {
  jobIdentifier,
  jobInteger,
  jobSha256,
  signJobData,
  validateJobOwnerProof,
  validateTerminalJobSourceProof,
  validateTerminalClosedOutcomeProof,
  validateJobOutputPage,
} from "./validation.js";
import {
  assertOutputProgress,
  fail,
  semantic,
  settledJobState,
  type JobState,
  type JobDeliveryState,
  type JobJournalKind,
} from "./reducer.js";
import {
  JOB_STORAGE_LIMITS,
  acceptedProof,
  digest,
  json,
  ownerMatches,
  proofSql,
  targetProof,
  validateRecord,
} from "./store-proofs.js";
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
export interface NativeJobDelivery extends Base {
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
export type JobRecord = CommandJob | JobOutputRevision | NativeJobDelivery;
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
const id = jobIdentifier,
  integer = jobInteger;
function signed<T extends object>(value: T): T & { readonly sha256: string } {
  return signJobData(value, JOB_STORAGE_LIMITS.rowBytes);
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
const mutationFields = [
  "workspaceId",
  "requestId",
  "expectedRevision",
] as const;

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
  getDelivery(ws: string, deliveryId: string): NativeJobDelivery | undefined {
    return this.journal.head(ws, "delivery", deliveryId);
  }
  inspectJobs(ws: string): CommandJob[] {
    return this.journal.list(ws, "job", JOB_STORAGE_LIMITS.jobs);
  }
  readOutputs(
    ws: string,
    jobId: string,
    offset = 0,
    limit = 32,
  ): JobOutputRevision[] {
    id(jobId);
    integer(offset);
    integer(limit, 32);
    if (limit < 1) fail("INVALID_JOB_INPUT");
    const hs = this.db
      .prepare(
        "SELECT id FROM job_revisions WHERE workspace_id=? AND kind='output' AND job_id=? ORDER BY json_extract(data,'$.page.nextCursor.eventSeq'),json_extract(data,'$.page.nextCursor.byteOffset'),id LIMIT ? OFFSET ?",
      )
      .all(id(ws), jobId, limit, offset);
    return hs.map((h) =>
      this.journal.read<JobOutputRevision>(ws, String(h.id), "output"),
    );
  }
  inspectDeliveries(ws: string): NativeJobDelivery[] {
    return this.journal.list(ws, "delivery", JOB_STORAGE_LIMITS.deliveries);
  }
  /** Lookups describe exact historical admission; they never grant a fresh queue accept. */
  findDeliveryForInput(value: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly requestId: string;
  }): NativeJobDelivery | null {
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
    const request = parseJobResultInputRequestId(x.requestId);
    if (request === null) return null;
    if (!request) fail("JOB_INPUT_INVALID");
    const hs = this.deliveryHeadsForJob(
      x.workspaceId,
      id(request.jobId),
      JOB_STORAGE_LIMITS.deliveries + 1,
    );
    if (hs.length > JOB_STORAGE_LIMITS.deliveries) fail("JOB_LIMIT");
    const found = hs
      .map((entityId) => this.getDelivery(x.workspaceId, entityId)!)
      .filter((d) => d.inputRequestId === x.requestId);
    if (found.length !== 1) fail("JOB_INPUT_UNTRACKED");
    const d = found[0]!;
    if (
      d.sessionId !== x.sessionId ||
      d.settledSha256 !== request.settledSha256 ||
      (d.accepted && d.accepted.inputId !== x.inputId)
    )
      fail("JOB_INPUT_INVALID");
    return d;
  }
  private deliveryHeadsForJob(
    ws: string,
    jobId: string,
    limit: number,
  ): string[] {
    return this.db
      .prepare(
        "SELECT h.entity_id FROM job_heads h JOIN job_revisions r ON r.id=h.revision_id WHERE h.workspace_id=? AND h.kind='delivery' AND r.job_id=? LIMIT ?",
      )
      .all(ws, jobId, limit)
      .map((h) => String(h.entity_id));
  }
  private once<T extends JobRecord>(
    kind: JobJournalKind,
    eid: string,
    op: string,
    x: JobMutationInput,
    run: () => JobRequestResult<T>,
  ): JobRequestResult<T> {
    const pair = this.journal.replay<T>(x.workspaceId, kind, eid, op, x);
    return pair ? json({ ...pair, duplicate: true }) : run();
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
  private mustAttached(x: AttachTerminalJobInput): CommandJob {
    const r = this.mustJob(x.workspaceId, x.jobId);
    if (r.revision !== x.expectedRevision || r.state !== "attached")
      fail("JOB_REVISION_CONFLICT");
    return r;
  }
  private mustDelivery(ws: string, deliveryId: string): NativeJobDelivery {
    const r = this.getDelivery(ws, deliveryId);
    if (!r) fail("JOB_NOT_FOUND");
    return r;
  }
  private currentTarget(original: object): JobDeliveryTargetProof {
    const target = targetProof(this.ports.readDeliveryTarget(original));
    this.ports.assertDeliveryTargetCurrent(original, target);
    return target;
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
    return this.ports.writeTx(() =>
      this.once<CommandJob>("job", x.jobId, "attach", x, () => {
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
            "SELECT workspace_id,entity_id FROM job_heads WHERE kind='job' LIMIT ?",
          )
          .all(JOB_STORAGE_LIMITS.jobs + 1);
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
      }),
    );
  }
  recordJobOutput(
    original: object,
    value: RecordJobOutputInput,
  ): JobRequestResult<CommandJob> {
    const x = input(value, [...mutationFields, "jobId", "outputId"]);
    return this.ports.writeTx(() =>
      this.once<CommandJob>("job", x.jobId, "output", x, () => {
        const before = this.mustAttached(x);
        if (this.journal.head(x.workspaceId, "output", x.outputId))
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
        const output = this.append<JobOutputRevision>(
          "output",
          x.outputId,
          "output",
          { ...x, expectedRevision: 0 },
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
      }),
    );
  }
  settleTerminalJob(
    original: object,
    value: SettleTerminalJobInput,
  ): JobRequestResult<CommandJob> {
    const x = input(value, [...mutationFields, "jobId"]);
    return this.ports.writeTx(() =>
      this.once<CommandJob>("job", x.jobId, "settle", x, () => {
        const before = this.mustAttached(x);
        const outcome = validateTerminalClosedOutcomeProof(
          this.ports.readClosedOutcome(original),
        );
        this.original(original, before.source, "observe");
        if (outcome.sourceSha256 !== before.sourceSha256)
          fail("JOB_SOURCE_OWNER_INVALID");
        const s = settledJobState(outcome);
        return this.append("job", x.jobId, "settle", x, before, {
          ...before,
          state: s,
          outcome,
          errorCode: s === "uncertain" ? "JOB_CLEANUP_UNCERTAIN" : null,
        });
      }),
    );
  }
  cancelWatch(value: CancelCommandJobWatchInput): JobRequestResult<CommandJob> {
    const x = input(value, [...mutationFields, "jobId"]);
    return this.ports.writeTx(() =>
      this.once<CommandJob>("job", x.jobId, "cancel-watch", x, () => {
        const before = this.mustJob(x.workspaceId, x.jobId);
        return this.append("job", x.jobId, "cancel-watch", x, before, {
          ...before,
          state: "cancelled",
          errorCode: "JOB_WATCH_CANCELLED",
        });
      }),
    );
  }
  /** One primary COMMIT owns preparation, dispatch, actual queued input and its accepted receipt. */
  private assertAtomicHistory(
    record: NativeJobDelivery,
    receipt: JobTransitionReceipt,
    x: DeliverJobResultAtomicInput,
  ): void {
    if (
      x.expectedRevision !== 0 ||
      record.state !== "accepted" ||
      record.revision !== 3 ||
      record.jobId !== x.jobId ||
      record.deliveryId !==
        jobResultDeliveryId(x.workspaceId, x.jobId, record.settledSha256) ||
      record.lastReceiptId !== receipt.id ||
      receipt.operation !== "delivery-accepted" ||
      receipt.requestId !== x.requestId ||
      receipt.afterSha256 !== record.sha256 ||
      !record.previousId
    )
      fail("JOB_REQUEST_CONFLICT");
    const intent = this.journal.read<NativeJobDelivery>(
      x.workspaceId,
      record.previousId,
      "delivery",
    );
    if (!intent.previousId) fail();
    const prepared = this.journal.read<NativeJobDelivery>(
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
  ): JobRequestResult<NativeJobDelivery> {
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
        const record = this.journal.read<NativeJobDelivery>(
          x.workspaceId,
          receipt.afterRevisionId,
          "delivery",
        );
        this.assertAtomicHistory(record, receipt, x);
        return json({ record, receipt, duplicate: true });
      }
      // Existing two-phase intents and uncertain gaps must be reconciled, never accepted again.
      if (this.deliveryHeadsForJob(x.workspaceId, x.jobId, 1).length)
        fail("JOB_DELIVERY_EXISTS");
      if (!this.ports.acceptAtomicInput || !this.ports.releaseAtomicInput)
        fail("JOB_ATOMIC_DELIVERY_UNSUPPORTED");
      const job = this.mustJob(x.workspaceId, x.jobId);
      const deliveryId = jobResultDeliveryId(
        x.workspaceId,
        x.jobId,
        job.sha256,
      );
      const identity = knowledgeHash(x);
      const prepared = this.prepareDelivery(originalTarget, {
        ...x,
        deliveryId,
        requestId: `atomic-prepare:${identity}`,
      });
      const prompt = formatJobResult(job, prepared.record.target);
      const inputRequestId = jobResultInputRequestId(x.jobId, job.sha256);
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
  ): JobRequestResult<NativeJobDelivery> {
    const x = input(value, [...mutationFields, "jobId", "deliveryId"]);
    return this.ports.writeTx(() => this.prepareDelivery(original, x));
  }
  private prepareDelivery(
    original: object,
    x: PrepareJobDeliveryInput,
  ): JobRequestResult<NativeJobDelivery> {
    return this.once<NativeJobDelivery>(
      "delivery",
      x.deliveryId,
      "delivery-prepare",
      x,
      () => {
        const job = this.mustJob(x.workspaceId, x.jobId);
        if (!isDeliverableJob(job)) fail("JOB_NOT_SETTLED");
        const target = this.currentTarget(original);
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
        const [existing] = this.deliveryHeadsForJob(
          x.workspaceId,
          job.jobId,
          1,
        );
        if (
          existing &&
          this.getDelivery(x.workspaceId, existing)!.jobId === job.jobId
        )
          fail("JOB_DELIVERY_EXISTS");
        return this.append<NativeJobDelivery>(
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
      },
    );
  }
  dispatchJobDelivery(
    original: object,
    value: DispatchJobDeliveryInput,
  ): JobRequestResult<NativeJobDelivery> {
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
  ): JobRequestResult<NativeJobDelivery> {
    return this.once<NativeJobDelivery>(
      "delivery",
      x.deliveryId,
      "delivery-intent",
      x,
      () => {
        const before = this.mustDelivery(x.workspaceId, x.deliveryId);
        const target = this.currentTarget(original);
        if (
          target.sha256 !== before.target.sha256 ||
          x.inputRequestId !==
            jobResultInputRequestId(before.jobId, before.settledSha256) ||
          x.prompt !==
            formatJobResult(
              this.mustJob(x.workspaceId, before.jobId),
              before.target,
            )
        )
          fail("JOB_DELIVERY_STALE");
        return this.append(
          "delivery",
          x.deliveryId,
          "delivery-intent",
          x,
          before,
          {
            ...before,
            state: "dispatching",
            inputRequestId: x.inputRequestId,
            prompt: x.prompt,
          },
        );
      },
    );
  }
  private acceptedDelivery(
    originalTarget: object,
    originalAccepted: object,
    x: MutateJobDeliveryInput,
    op: "delivery-accepted" | "delivery-reconcile",
  ): JobRequestResult<NativeJobDelivery> {
    return this.once<NativeJobDelivery>("delivery", x.deliveryId, op, x, () => {
      const before = this.mustDelivery(x.workspaceId, x.deliveryId);
      const target = this.currentTarget(originalTarget);
      if (target.sha256 !== before.target.sha256) fail("JOB_DELIVERY_STALE");
      const accepted = acceptedProof(this.ports.readAccepted(originalAccepted));
      return this.append("delivery", x.deliveryId, op, x, before, {
        ...before,
        state: "accepted",
        accepted,
        errorCode: null,
      });
    });
  }
  completeJobDelivery(
    originalTarget: object,
    originalAccepted: object,
    value: MutateJobDeliveryInput,
  ): JobRequestResult<NativeJobDelivery> {
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
  ): JobRequestResult<NativeJobDelivery> {
    const x = input(value, [
      ...mutationFields,
      "deliveryId",
      "operation",
      "errorCode",
    ]);
    return this.ports.writeTx(() => {
      const op =
        x.operation === "cancelled" ? "delivery-cancel" : "delivery-uncertain";
      return this.once<NativeJobDelivery>(
        "delivery",
        x.deliveryId,
        op,
        x,
        () => {
          const before = this.mustDelivery(x.workspaceId, x.deliveryId);
          return this.append("delivery", x.deliveryId, op, x, before, {
            ...before,
            state: x.operation,
            errorCode: id(x.errorCode),
          });
        },
      );
    });
  }
  validateGraph(): void {
    const graph = this.journal.scan(),
      records = graph.records,
      outputs = new Map<string, JobOutputRevision>();
    for (const r of records.values())
      if (r.kind === "output") {
        const key = JSON.stringify([r.workspaceId, r.outputId]);
        if (!outputs.has(key)) outputs.set(key, r);
      }
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
      if (r.kind !== "delivery") {
        const admission = records.get(
          r.kind === "job" ? r.sourceRevisionId : r.jobRevisionId,
        );
        if (
          !admission ||
          admission.kind !== "job" ||
          admission.revision !== 1 ||
          (r.kind === "job" && admission.state !== "attached") ||
          admission.jobId !== r.jobId ||
          admission.sourceSha256 !== r.sourceSha256 ||
          admission.owner.sha256 !== r.owner.sha256
        )
          fail();
      }
      if (r.kind === "job" && t.operation === "output") {
        const o = outputs.get(JSON.stringify([r.workspaceId, r.lastOutputId]));
        if (
          !o ||
          o.jobId !== r.jobId ||
          o.page.nextCursor.sha256 !== r.cursor?.sha256 ||
          o.sourceSha256 !== r.sourceSha256
        )
          fail();
        assertOutputProgress((before as CommandJob).cursor, o.page);
      }
      if (r.kind === "delivery") {
        const settled = records.get(r.settledRevisionId);
        if (
          !settled ||
          settled.kind !== "job" ||
          settled.jobId !== r.jobId ||
          settled.sha256 !== r.settledSha256 ||
          !isDeliverableJob(settled) ||
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
          r.inputRequestId !== jobResultInputRequestId(r.jobId, r.settledSha256)
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
    const max = JOB_STORAGE_LIMITS.jobs + JOB_STORAGE_LIMITS.deliveries;
    const hs = this.db
      .prepare(
        "SELECT workspace_id,kind,entity_id FROM job_heads WHERE kind IN ('job','delivery') ORDER BY workspace_id,kind,entity_id LIMIT ?",
      )
      .all(max + 1);
    if (hs.length > max) fail("JOB_LIMIT");
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
    return this.ports.writeTx(() =>
      transaction(this.db, () =>
        new JobStorage(this.db, metadataPorts()).rewriteLocal("recover"),
      ),
    );
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
