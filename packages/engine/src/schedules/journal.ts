import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  EngineError,
  type InputRecord,
  type JsonObject,
  type RunConfig,
} from "@moodcode/contracts";
import {
  normalizeAcceptInput,
  validateInputRecord,
} from "@moodcode/contracts/validation";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import { sealRecord, sha256Hex, verifySealed } from "../shared/canonical.js";
import { requestIdentity } from "../storage/native-schema.js";
import type {
  ScheduleDueBatch,
  ScheduleDueCursor,
  ScheduleSpec,
  ScheduleOccurrenceCandidate,
} from "./types.js";
import { validateScheduleSpec } from "./spec.js";
import {
  formatScheduleInput,
  validateScheduleOccurrence,
  validateScheduleCursor,
  initialScheduleCursor,
} from "./occurrences.js";
export interface SchedulerWorkerProof {
  readonly workspaceId: string;
  readonly ownerEpoch: string;
  readonly rootBindingSha256: string;
  readonly sha256: string;
}
export interface ScheduleTargetProof {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sourceSha256: string;
  readonly config: RunConfig;
  readonly configSha256: string;
  readonly capabilitiesSha256: string;
  readonly catalogueSha256: string;
  readonly profile: { readonly id: string; readonly revision: string } | null;
  readonly sha256: string;
}
export interface ScheduleAcceptedInputProof {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly requestId: string;
  readonly admittedSeq: number;
  readonly inputSha256: string;
  readonly sha256: string;
}
export interface ScheduleInputObservationProof {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly inputSha256: string;
  readonly state: "pending" | "promoted" | "cancelled";
  readonly runId: string | null;
  readonly runState: string | null;
  readonly runSha256: string | null;
  readonly cleanupConfirmed: boolean | null;
  readonly usage: {
    readonly turns: number;
    readonly toolCalls: number;
    readonly outputBytes: number;
  } | null;
  readonly sha256: string;
}
export type ScheduleOccurrenceState =
  | "queued"
  | "claimed"
  | "dispatching"
  | "accepted"
  | "promoted"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "paused-import";
export interface Revision {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly lastReceiptId: string;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface ScheduleRevision extends Revision {
  readonly scheduleId: string;
  readonly spec: ScheduleSpec;
  readonly cursor: ScheduleDueCursor | null;
  readonly due: ScheduleDueBatchProof | null;
  readonly target: ScheduleTargetProof;
  readonly worker: SchedulerWorkerProof | null;
}
export interface SchedulerLease extends Revision {
  readonly worker: SchedulerWorkerProof;
  readonly generation: number;
  readonly expiresAt: string;
  readonly lastClockAt: string;
}
export interface TriggerOccurrence extends Revision {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly scheduleRevisionId: string;
  readonly scheduleSha256: string;
  readonly candidate: ScheduleOccurrenceCandidate;
  readonly state: ScheduleOccurrenceState;
  readonly leaseRevisionId: string | null;
  readonly leaseSha256: string | null;
  readonly worker: SchedulerWorkerProof | null;
  readonly generation: number | null;
  readonly claimToken: string | null;
  readonly inputRequestId: string;
  readonly prompt: string | null;
  readonly promptSha256: string | null;
  readonly input: ScheduleAcceptedInputProof | null;
  readonly observation: ScheduleInputObservationProof | null;
  readonly errorCode: string | null;
}
export interface ScheduleTransitionReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityId: string;
  readonly kind: "schedule" | "lease" | "occurrence";
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
export interface ScheduleRequestResult<T> {
  readonly record: T;
  readonly receipt: ScheduleTransitionReceipt;
  readonly duplicate: boolean;
}
export const SCHEDULE_STORAGE_LIMITS = Object.freeze({
  rowBytes: 131072,
  rows: 8192,
  bytes: 33554432,
  schedules: 32,
  globalSchedules: 32,
  occurrences: 512,
  globalOccurrences: 512,
  leaseMinMs: 1000,
  leaseMaxMs: 300000,
});
export interface ScheduleDueBatchProof {
  readonly workspaceId: string;
  readonly scheduleRevisionId: string;
  readonly scheduleSha256: string;
  readonly previousCursorSha256: string;
  readonly batch: ScheduleDueBatch;
  readonly sha256: string;
}
type Kind = "schedule" | "lease" | "occurrence" | "transition";
type Body =
  | ScheduleRevision
  | SchedulerLease
  | TriggerOccurrence
  | ScheduleTransitionReceipt;
type NativeRow = {
  id: string;
  workspace_id: string;
  kind: Kind;
  entity_id: string;
  revision: number;
  previous_id: string | null;
  session_id: string | null;
  input_id: string | null;
  run_id: string | null;
  owner_epoch: string | null;
  request_scope: string;
  request_id: string;
  request_sha256: string;
  sha256: string;
  bytes: number;
  data: string;
};
export function fail(code = "SCHEDULE_DATABASE_INVALID"): never {
  throw new EngineError(
    code,
    "Schedule journal or original capability is stale or invalid",
  );
}
export function json<T>(
  value: T,
  bytes: number = SCHEDULE_STORAGE_LIMITS.rowBytes,
): T {
  const result = immutableKnowledgeJson(value);
  if (Buffer.byteLength(JSON.stringify(result)) > bytes) fail("SCHEDULE_LIMIT");
  return result;
}
export function signed<T extends object>(value: T): T & { sha256: string } {
  return sealRecord(value, json);
}
function fields(value: object, keys: readonly string[]): void {
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail();
}
function payload(value: Revision): Record<string, unknown> {
  const {
    id: _id,
    workspaceId: _workspace,
    revision: _revision,
    previousId: _previous,
    lastReceiptId: _receipt,
    createdAt: _created,
    sha256: _sha,
    ...body
  } = value;
  return body;
}
export function digest<T extends { sha256: string }>(input: T): T {
  return verifySealed(json(input), () => fail());
}
export function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail("INVALID_SCHEDULE_INPUT");
  return value;
}
export function integer(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    fail("SCHEDULE_LIMIT");
  return Number(value);
}
/** Recovery, import and the abandon of a live claim, which frees its recover reserve, may spend the headroom ordinary appends leave. */
const ADMINISTRATIVE_OPERATIONS = new Set([
  "recover",
  "import-disable",
  "import-pause",
  "abandon",
]);
/** Upper bound of a receipt plus the fields a recover or import revision adds. */
const ADMINISTRATIVE_REVISION_BYTES = 4096;
/** Revisions recoverInterrupted and pauseImported may still append for a head in this state. */
function administrativeWrites(kind: string, state: unknown): number {
  if (kind === "schedule") return state === true || state === 1 ? 1 : 0;
  if (kind !== "occurrence") return 0;
  return (
    Number(state === "claimed" || state === "dispatching") +
    Number(state !== "paused-import")
  );
}

/** Reads, appends and audits schedule revisions inside the caller's transaction; nothing here needs an original handle. */
export class ScheduleJournal {
  constructor(
    readonly db: DatabaseSync,
    private readonly clock: () => number = Date.now,
  ) {}
  protected now(): number {
    return integer(this.clock(), 1, 8640000000000000);
  }
  private time(): string {
    return new Date(this.now()).toISOString();
  }
  private row(revisionId: string, workspaceId: string): NativeRow | undefined {
    const header = this.db
      .prepare(
        "SELECT id,workspace_id,kind,entity_id,revision,previous_id,session_id,input_id,run_id,owner_epoch,request_scope,request_id,request_sha256,sha256,length(CAST(data AS BLOB)) AS bytes FROM schedule_revisions WHERE id=? AND workspace_id=?",
      )
      .get(id(revisionId), id(workspaceId)) as unknown as NativeRow | undefined;
    if (!header) return;
    if (integer(header.bytes) > SCHEDULE_STORAGE_LIMITS.rowBytes)
      fail("SCHEDULE_LIMIT");
    const raw = this.db
      .prepare(
        "SELECT data FROM schedule_revisions WHERE id=? AND workspace_id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(revisionId, workspaceId, header.bytes);
    if (!raw) fail();
    return { ...header, data: String(raw.data) };
  }
  protected read<T extends Body>(
    revisionId: string,
    workspaceId: string,
    kind?: Kind,
  ): T {
    const row = this.row(revisionId, workspaceId);
    if (!row || (kind && row.kind !== kind)) fail();
    const body = digest(JSON.parse(row.data) as Body);
    const base = [
      "id",
      "workspaceId",
      "revision",
      "previousId",
      "lastReceiptId",
      "createdAt",
      "sha256",
    ];
    if (row.kind === "schedule")
      fields(body, [
        ...base,
        "scheduleId",
        "spec",
        "cursor",
        "due",
        "target",
        "worker",
      ]);
    else if (row.kind === "lease")
      fields(body, [
        ...base,
        "worker",
        "generation",
        "expiresAt",
        "lastClockAt",
      ]);
    else if (row.kind === "occurrence")
      fields(body, [
        ...base,
        "occurrenceId",
        "scheduleId",
        "scheduleRevisionId",
        "scheduleSha256",
        "candidate",
        "state",
        "leaseRevisionId",
        "leaseSha256",
        "worker",
        "generation",
        "claimToken",
        "inputRequestId",
        "prompt",
        "promptSha256",
        "input",
        "observation",
        "errorCode",
      ]);
    else
      fields(body, [
        "id",
        "workspaceId",
        "kind",
        "entityId",
        "operation",
        "beforeRevisionId",
        "afterRevisionId",
        "afterSha256",
        "requestId",
        "requestSha256",
        "requestInput",
        "createdAt",
        "sha256",
      ]);
    if (
      typeof body.createdAt !== "string" ||
      !Number.isFinite(Date.parse(body.createdAt)) ||
      new Date(body.createdAt).toISOString() !== body.createdAt
    )
      fail();
    if (
      body.id !== row.id ||
      body.workspaceId !== row.workspace_id ||
      body.sha256 !== row.sha256
    )
      fail();
    if (row.kind !== "transition") {
      const record = body as
        ScheduleRevision | SchedulerLease | TriggerOccurrence;
      if (
        record.revision !== row.revision ||
        record.previousId !== row.previous_id
      )
        fail();
      if (row.kind === "schedule") {
        const spec = body as ScheduleRevision;
        if (
          spec.scheduleId !== row.entity_id ||
          validateScheduleSpec(spec.spec).sha256 !== spec.spec.sha256 ||
          spec.spec.id !== spec.scheduleId ||
          row.session_id !== spec.spec.target.sessionId ||
          row.owner_epoch !== (spec.worker?.ownerEpoch ?? null) ||
          row.input_id !== null ||
          row.run_id !== null
        )
          fail();
        this.target(spec.target, spec.spec);
      } else if (row.kind === "lease") {
        const lease = body as SchedulerLease;
        digest(lease.worker);
        integer(lease.generation, 1);
        if (
          lease.worker.workspaceId !== row.workspace_id ||
          row.entity_id !== "scheduler" ||
          row.owner_epoch !== lease.worker.ownerEpoch ||
          row.session_id !== null ||
          row.input_id !== null ||
          row.run_id !== null
        )
          fail();
      } else {
        const occurrence = body as TriggerOccurrence;
        if (
          occurrence.occurrenceId !== row.entity_id ||
          row.input_id !== (occurrence.input?.inputId ?? null) ||
          row.run_id !== (occurrence.observation?.runId ?? null) ||
          row.owner_epoch !== (occurrence.worker?.ownerEpoch ?? null) ||
          row.session_id !==
            this.scheduleFor(occurrence).spec.target.sessionId ||
          (occurrence.worker !== null &&
            occurrence.worker.workspaceId !== row.workspace_id)
        )
          fail();
      }
    } else {
      const receipt = body as ScheduleTransitionReceipt;
      if (
        knowledgeHash(receipt.requestInput) !== receipt.requestSha256 ||
        row.request_id !== receipt.requestId ||
        row.request_sha256 !== receipt.requestSha256 ||
        row.entity_id !== `${receipt.kind}:${receipt.entityId}`
      )
        fail();
    }
    if (
      row.request_scope !==
      (row.kind === "transition"
        ? `receipt:${row.entity_id}`
        : `${row.kind}:${row.entity_id}`)
    )
      fail();
    return body as T;
  }
  private head<T extends Body>(
    workspaceId: string,
    kind: "schedule" | "lease" | "occurrence",
    entityId: string,
  ): T | undefined {
    const head = this.db
      .prepare(
        "SELECT revision_id,revision,sha256 FROM schedule_heads WHERE workspace_id=? AND kind=? AND entity_id=?",
      )
      .get(id(workspaceId), kind, id(entityId));
    if (!head) return;
    const row = this.row(String(head.revision_id), workspaceId)!;
    const body = this.read<T>(row.id, workspaceId, kind),
      latest = this.db
        .prepare(
          "SELECT max(revision) AS revision FROM schedule_revisions WHERE workspace_id=? AND kind=? AND entity_id=?",
        )
        .get(workspaceId, kind, entityId);
    if (
      row.entity_id !== entityId ||
      row.revision !== head.revision ||
      head.revision !== latest?.revision ||
      body.sha256 !== head.sha256
    )
      fail();
    return body;
  }
  protected receipt(record: Revision): ScheduleTransitionReceipt {
    const receipt = this.read<ScheduleTransitionReceipt>(
        record.lastReceiptId,
        record.workspaceId,
        "transition",
      ),
      row = this.row(record.id, record.workspaceId)!;
    if (
      receipt.afterRevisionId !== record.id ||
      receipt.afterSha256 !== record.sha256 ||
      receipt.beforeRevisionId !== record.previousId ||
      row.request_id !== receipt.requestId ||
      row.request_sha256 !== receipt.requestSha256
    )
      fail();
    return receipt;
  }
  protected duplicate<T extends Body & Revision>(
    workspaceId: string,
    scope: string,
    requestId: string,
    sha256: string,
  ): ScheduleRequestResult<T> | undefined {
    const row = this.db
      .prepare(
        "SELECT id,request_sha256 FROM schedule_revisions WHERE workspace_id=? AND request_scope=? AND request_id=?",
      )
      .get(workspaceId, scope, requestId);
    if (!row) return;
    if (row.request_sha256 !== sha256) fail("SCHEDULE_REQUEST_CONFLICT");
    const record = this.read<T>(String(row.id), workspaceId);
    return { record, receipt: this.receipt(record), duplicate: true };
  }
  private sizes(): { rows: number; bytes: number } {
    const sizes = this.db
      .prepare(
        "SELECT count(*) AS n,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM schedule_revisions",
      )
      .get()!;
    return { rows: Number(sizes.n), bytes: Number(sizes.bytes) };
  }
  /** Rows and bytes recovery and import still need once `next` heads its entity. */
  private administrativeReserve(
    kind: "schedule" | "lease" | "occurrence",
    entity: string,
    next: ScheduleRevision | SchedulerLease | TriggerOccurrence,
  ): { rows: number; bytes: number } {
    let rows = 0,
      bytes = 0;
    const add = (head: string, state: unknown, n: number, size: number) => {
      const writes = administrativeWrites(head, state);
      rows += 2 * writes * n;
      bytes += writes * (size + n * ADMINISTRATIVE_REVISION_BYTES);
    };
    for (const group of this.db
      .prepare(
        "SELECT h.kind,CASE h.kind WHEN 'schedule' THEN json_extract(r.data,'$.spec.enabled') ELSE json_extract(r.data,'$.state') END AS state,count(*) AS n,coalesce(sum(length(CAST(r.data AS BLOB))),0) AS bytes FROM schedule_heads h JOIN schedule_revisions r ON r.id=h.revision_id WHERE h.kind<>'lease' AND NOT (h.workspace_id=? AND h.kind=? AND h.entity_id=?) GROUP BY 1,2",
      )
      .all(next.workspaceId, kind, entity))
      add(
        String(group.kind),
        group.state,
        Number(group.n),
        Number(group.bytes),
      );
    add(
      kind,
      kind === "schedule"
        ? (next as ScheduleRevision).spec.enabled
        : (next as TriggerOccurrence).state,
      1,
      Buffer.byteLength(JSON.stringify(next)),
    );
    return { rows, bytes };
  }
  private insert(
    kind: Kind,
    entity: string,
    body: Body,
    scope: string,
    requestId: string,
    requestSha: string,
    revision: number,
    previousId: string | null,
  ): void {
    const value = json(body),
      sizes = this.sizes();
    if (
      sizes.rows >= SCHEDULE_STORAGE_LIMITS.rows ||
      sizes.bytes + Buffer.byteLength(JSON.stringify(value)) >
        SCHEDULE_STORAGE_LIMITS.bytes
    )
      fail("SCHEDULE_LIMIT");
    let sessionId: string | null = null,
      inputId: string | null = null,
      runId: string | null = null,
      epoch: string | null = null;
    if (kind === "schedule") {
      sessionId = (body as ScheduleRevision).spec.target.sessionId;
      epoch = (body as ScheduleRevision).worker?.ownerEpoch ?? null;
    } else if (kind === "lease")
      epoch = (body as SchedulerLease).worker.ownerEpoch;
    else if (kind === "occurrence") {
      const record = body as TriggerOccurrence;
      sessionId = this.scheduleFor(record).spec.target.sessionId;
      inputId = record.input?.inputId ?? null;
      runId = record.observation?.runId ?? null;
      epoch = record.worker?.ownerEpoch ?? null;
    }
    this.db
      .prepare(
        "INSERT INTO schedule_revisions(id,workspace_id,kind,entity_id,revision,previous_id,session_id,input_id,run_id,owner_epoch,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        body.id,
        body.workspaceId,
        kind,
        entity,
        revision,
        previousId,
        sessionId,
        inputId,
        runId,
        epoch,
        scope,
        requestId,
        requestSha,
        body.sha256,
        JSON.stringify(value),
      );
  }
  protected commit<
    T extends ScheduleRevision | SchedulerLease | TriggerOccurrence,
  >(
    kind: "schedule" | "lease" | "occurrence",
    entity: string,
    record: T,
    before: T | undefined,
    operation: string,
    input: JsonObject,
  ): ScheduleRequestResult<T> {
    const requestId = id(input.requestId),
      requestSha = knowledgeHash(input),
      scope = `${kind}:${entity}`;
    const receipt = signed({
      id: record.lastReceiptId,
      workspaceId: record.workspaceId,
      kind,
      entityId: entity,
      operation,
      beforeRevisionId: before?.id ?? null,
      afterRevisionId: record.id,
      afterSha256: record.sha256,
      requestId,
      requestSha256: requestSha,
      requestInput: input,
      createdAt: record.createdAt,
    });
    const prior = (before as TriggerOccurrence | undefined)?.state;
    if (
      !ADMINISTRATIVE_OPERATIONS.has(operation) ||
      (operation === "abandon" &&
        prior !== "claimed" &&
        prior !== "dispatching")
    ) {
      const sizes = this.sizes(),
        reserve = this.administrativeReserve(kind, entity, record);
      if (
        sizes.rows + 2 + reserve.rows > SCHEDULE_STORAGE_LIMITS.rows ||
        sizes.bytes +
          Buffer.byteLength(JSON.stringify(record)) +
          Buffer.byteLength(JSON.stringify(receipt)) +
          reserve.bytes >
          SCHEDULE_STORAGE_LIMITS.bytes
      )
        fail("SCHEDULE_LIMIT");
    }
    this.insert(
      kind,
      entity,
      record,
      scope,
      requestId,
      requestSha,
      record.revision,
      record.previousId,
    );
    this.insert(
      "transition",
      `${kind}:${entity}`,
      receipt,
      `receipt:${kind}:${entity}`,
      requestId,
      requestSha,
      record.revision,
      before?.lastReceiptId ?? null,
    );
    if (before) {
      if (
        this.db
          .prepare(
            "UPDATE schedule_heads SET revision_id=?,revision=?,sha256=? WHERE workspace_id=? AND kind=? AND entity_id=? AND revision_id=? AND revision=? AND sha256=?",
          )
          .run(
            record.id,
            record.revision,
            record.sha256,
            record.workspaceId,
            kind,
            entity,
            before.id,
            before.revision,
            before.sha256,
          ).changes !== 1
      )
        fail("SCHEDULE_STALE");
    } else
      this.db
        .prepare(
          "INSERT INTO schedule_heads(workspace_id,kind,entity_id,revision_id,revision,sha256) VALUES(?,?,?,?,?,?)",
        )
        .run(
          record.workspaceId,
          kind,
          entity,
          record.id,
          record.revision,
          record.sha256,
        );
    return { record, receipt, duplicate: false };
  }
  protected revise<T extends object>(
    body: T,
    before?: Revision,
    at?: number,
  ): T & Revision {
    return signed({
      ...body,
      id: randomUUID(),
      workspaceId: Reflect.get(body, "workspaceId"),
      revision: (before?.revision ?? 0) + 1,
      previousId: before?.id ?? null,
      lastReceiptId: randomUUID(),
      createdAt: at === undefined ? this.time() : new Date(at).toISOString(),
    }) as T & Revision;
  }
  protected target(proof: ScheduleTargetProof, spec: ScheduleSpec): void {
    digest(proof);
    const target = spec.target;
    if (
      proof.workspaceId !== target.workspaceId ||
      proof.sessionId !== target.sessionId ||
      proof.sourceSha256 !== target.workspaceBindingSha256 ||
      proof.capabilitiesSha256 !== target.capabilitiesSha256 ||
      proof.catalogueSha256 !== target.catalogueSha256 ||
      proof.configSha256 !== target.runConfigSha256 ||
      knowledgeHash(proof.config) !== target.runConfigSha256 ||
      knowledgeHash(proof.config) !== knowledgeHash(target.config) ||
      knowledgeHash(proof.profile) !== knowledgeHash(target.profile)
    )
      fail("SCHEDULE_TARGET_STALE");
    const session = this.db
      .prepare("SELECT workspace_id FROM sessions WHERE id=?")
      .get(proof.sessionId);
    if (session?.workspace_id !== proof.workspaceId)
      fail("SCHEDULE_TARGET_STALE");
  }
  protected scheduleFor(occurrence: TriggerOccurrence): ScheduleRevision {
    const schedule = this.getSchedule(
      occurrence.workspaceId,
      occurrence.scheduleId,
      occurrence.scheduleRevisionId,
    );
    if (!schedule || schedule.spec.sha256 !== occurrence.scheduleSha256) fail();
    return schedule;
  }
  getSchedule(
    workspaceId: string,
    scheduleId: string,
    revisionId?: string,
  ): ScheduleRevision | undefined {
    const value = revisionId
      ? this.read<ScheduleRevision>(revisionId, workspaceId, "schedule")
      : this.head<ScheduleRevision>(workspaceId, "schedule", scheduleId);
    if (value && value.scheduleId !== scheduleId) fail();
    return value;
  }
  getLease(workspaceId: string): SchedulerLease | undefined {
    return this.head(workspaceId, "lease", "scheduler");
  }
  getOccurrence(
    workspaceId: string,
    occurrenceId: string,
  ): TriggerOccurrence | undefined {
    return this.head(workspaceId, "occurrence", occurrenceId);
  }
  inspectSchedules(workspaceId: string): readonly ScheduleRevision[] {
    return this.db
      .prepare(
        "SELECT entity_id FROM schedule_heads WHERE workspace_id=? AND kind='schedule' ORDER BY entity_id LIMIT 33",
      )
      .all(id(workspaceId))
      .map((row) => this.getSchedule(workspaceId, String(row.entity_id))!);
  }
  inspectOccurrences(
    workspaceId: string,
    scheduleId?: string,
  ): readonly TriggerOccurrence[] {
    return this.db
      .prepare(
        "SELECT entity_id FROM schedule_heads WHERE workspace_id=? AND kind='occurrence' ORDER BY entity_id LIMIT 513",
      )
      .all(id(workspaceId))
      .map((row) => this.getOccurrence(workspaceId, String(row.entity_id))!)
      .filter(
        (value) => scheduleId === undefined || value.scheduleId === scheduleId,
      );
  }
  protected inputRecord(
    schedule: ScheduleRevision,
    occurrence: TriggerOccurrence,
  ): InputRecord | undefined {
    const meta = this.db
      .prepare(
        "SELECT id,workspace_id,state,run_id,length(CAST(data AS BLOB)) AS bytes,length(CAST(fingerprint AS BLOB)) AS fingerprint_bytes FROM session_inputs WHERE session_id=? AND request_id=?",
      )
      .get(schedule.spec.target.sessionId, occurrence.inputRequestId);
    if (!meta) return;
    if (
      integer(meta.bytes) > 262144 ||
      integer(meta.fingerprint_bytes) > 262144
    )
      fail("SCHEDULE_LIMIT");
    const raw = this.db
      .prepare(
        "SELECT data,fingerprint FROM session_inputs WHERE id=? AND length(CAST(data AS BLOB))=? AND length(CAST(fingerprint AS BLOB))=?",
      )
      .get(String(meta.id), Number(meta.bytes), Number(meta.fingerprint_bytes));
    if (!raw) fail();
    const record = validateInputRecord(JSON.parse(String(raw.data)));
    const accepted = normalizeAcceptInput({
      sessionId: record.sessionId,
      requestId: record.requestId,
      prompt: record.prompt,
      config: record.config,
      delivery: record.delivery,
    });
    if (
      record.id !== meta.id ||
      record.workspaceId !== meta.workspace_id ||
      record.workspaceId !== occurrence.workspaceId ||
      record.state !== meta.state ||
      (record.runId ?? null) !== meta.run_id ||
      record.sessionId !== schedule.spec.target.sessionId ||
      record.requestId !== occurrence.inputRequestId ||
      record.delivery !== "queue" ||
      record.prompt !== occurrence.prompt ||
      sha256Hex(record.prompt) !== occurrence.promptSha256 ||
      knowledgeHash(record.config) !== schedule.target.configSha256 ||
      String(raw.fingerprint) !== requestIdentity(accepted) ||
      record.attachments?.length ||
      record.documents?.length
    )
      fail("SCHEDULE_INPUT_INVALID");
    return record;
  }
  protected inputProof(record: InputRecord): ScheduleAcceptedInputProof {
    const accepted = normalizeAcceptInput({
      sessionId: record.sessionId,
      requestId: record.requestId,
      prompt: record.prompt,
      config: record.config,
      delivery: record.delivery,
    });
    return signed({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      inputId: record.id,
      requestId: record.requestId,
      admittedSeq: record.admittedSeq,
      inputSha256: knowledgeHash(accepted),
    });
  }
  protected observation(
    record: InputRecord,
    proof: ScheduleInputObservationProof,
    historical = false,
  ): void {
    digest(proof);
    fields(proof, [
      "workspaceId",
      "sessionId",
      "inputId",
      "inputSha256",
      "state",
      "runId",
      "runState",
      "runSha256",
      "cleanupConfirmed",
      "usage",
      "sha256",
    ]);
    if (
      !["pending", "promoted", "cancelled"].includes(proof.state) ||
      (proof.state === "promoted") !== (proof.runId !== null) ||
      (proof.runState !== null &&
        ![
          "created",
          "running",
          "awaiting_approval",
          "cancelling",
          "completed",
          "cancelled",
          "failed",
          "interrupted",
        ].includes(proof.runState)) ||
      (proof.cleanupConfirmed !== null &&
        typeof proof.cleanupConfirmed !== "boolean")
    )
      fail();
    if (proof.usage !== null) {
      fields(proof.usage, ["turns", "toolCalls", "outputBytes"]);
      for (const value of Object.values(proof.usage))
        integer(value, 0, 16777216);
    }
    if (
      proof.inputId !== record.id ||
      proof.workspaceId !== record.workspaceId ||
      proof.sessionId !== record.sessionId ||
      proof.inputSha256 !== this.inputProof(record).inputSha256 ||
      ((!historical || proof.state !== "pending") &&
        proof.state !== record.state) ||
      ((!historical || proof.runId !== null) &&
        proof.runId !== (record.runId ?? null))
    )
      fail("SCHEDULE_INPUT_INVALID");
    if (!proof.runId) {
      if (
        proof.runState !== null ||
        proof.runSha256 !== null ||
        proof.cleanupConfirmed !== null ||
        proof.usage !== null
      )
        fail();
      return;
    }
    const meta = this.db
      .prepare(
        "SELECT session_id,workspace_id,input_id,state,length(CAST(data AS BLOB)) AS bytes FROM runs WHERE id=?",
      )
      .get(proof.runId);
    if (!meta || Number(meta.bytes) > 262144) fail();
    const row = this.db
      .prepare(
        "SELECT data FROM runs WHERE id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(proof.runId, Number(meta.bytes));
    if (!row) fail();
    const run = JSON.parse(String(row.data)) as Record<string, unknown>;
    if (
      meta.session_id !== record.sessionId ||
      meta.workspace_id !== record.workspaceId ||
      meta.input_id !== record.id ||
      run.id !== proof.runId ||
      run.state !== meta.state ||
      ((!historical ||
        [
          "completed",
          "failed",
          "cancelled",
          "interrupted",
          "uncertain",
        ].includes(proof.runState ?? "")) &&
        proof.runState !== run.state) ||
      proof.runSha256 !==
        knowledgeHash({
          id: run.id,
          inputId: run.inputId,
          sessionId: run.sessionId,
          workspaceId: run.workspaceId,
          prompt: run.prompt,
          config: run.config,
        }) ||
      run.prompt !== record.prompt ||
      knowledgeHash(run.config) !== knowledgeHash(record.config)
    )
      fail("SCHEDULE_INPUT_INVALID");
  }
  protected recoveryRecord(
    before: TriggerOccurrence,
    state: ScheduleOccurrenceState,
    requestId: string,
    operation: string,
    input?: ScheduleAcceptedInputProof,
  ): void {
    // Startup and import cannot fail on a clock step back; the predecessor is already no earlier than its lease.
    this.commit(
      "occurrence",
      before.occurrenceId,
      this.revise(
        {
          ...before,
          state,
          input: input ?? before.input,
          errorCode:
            state === "uncertain"
              ? "SCHEDULE_RESTART_UNCERTAIN"
              : before.errorCode,
        },
        before,
        Math.max(this.now(), Date.parse(before.createdAt)),
      ),
      before,
      operation,
      {
        workspaceId: before.workspaceId,
        occurrenceId: before.occurrenceId,
        requestId,
        expectedRevision: before.revision,
        operation,
      },
    );
  }
  private semantic(
    record: ScheduleRevision | SchedulerLease | TriggerOccurrence,
    kind: "schedule" | "lease" | "occurrence",
  ): void {
    const receipt = this.receipt(record),
      request = receipt.requestInput,
      before = record.previousId
        ? this.read<ScheduleRevision | SchedulerLease | TriggerOccurrence>(
            record.previousId,
            record.workspaceId,
            kind,
          )
        : undefined;
    if (
      request.requestId !== receipt.requestId ||
      request.workspaceId !== record.workspaceId ||
      request.operation !== receipt.operation ||
      (before &&
        request.expectedRevision !== before.revision &&
        receipt.operation !== "register") ||
      (!before && record.revision !== 1)
    )
      fail();
    if (kind === "schedule") {
      const after = record as ScheduleRevision,
        prior = before as ScheduleRevision | undefined;
      if (receipt.operation === "register") {
        if (
          request.expectedRevision !== (prior?.revision ?? 0) ||
          knowledgeHash(request.spec) !== knowledgeHash(after.spec) ||
          after.worker !== null ||
          after.due !== null ||
          knowledgeHash(after.cursor) !==
            knowledgeHash(initialScheduleCursor(after.spec))
        )
          fail();
      } else if (
        receipt.operation === "disable" ||
        receipt.operation === "import-disable"
      ) {
        if (
          !prior ||
          after.spec.enabled ||
          after.worker !== null ||
          after.due !== null ||
          knowledgeHash(after.target) !== knowledgeHash(prior.target)
        )
          fail();
        const { sha256: _sha, ...definition } = prior.spec;
        if (
          knowledgeHash(after.spec) !==
            knowledgeHash(
              validateScheduleSpec({ ...definition, enabled: false }),
            ) ||
          knowledgeHash(after.cursor) !==
            knowledgeHash(initialScheduleCursor(after.spec))
        )
          fail();
      } else if (receipt.operation === "due") {
        if (
          !prior ||
          knowledgeHash(after.spec) !== knowledgeHash(prior.spec) ||
          knowledgeHash(after.target) !== knowledgeHash(prior.target) ||
          !after.worker ||
          !after.due
        )
          fail();
        const proof = digest(after.due);
        if (
          proof.workspaceId !== record.workspaceId ||
          proof.scheduleRevisionId !== prior.id ||
          proof.scheduleSha256 !== prior.spec.sha256 ||
          proof.previousCursorSha256 !== knowledgeHash(prior.cursor) ||
          proof.batch.clockRollback ||
          proof.batch.executionAuthority !== false ||
          proof.batch.occurrences.length > 32 ||
          knowledgeHash(proof.batch.nextCursor) !== knowledgeHash(after.cursor)
        )
          fail();
        for (const candidate of proof.batch.occurrences)
          validateScheduleOccurrence(candidate, prior.spec);
      } else fail();
      return;
    }
    if (kind === "lease") {
      const after = record as SchedulerLease,
        prior = before as SchedulerLease | undefined,
        now = Date.parse(after.lastClockAt),
        expiry = Date.parse(after.expiresAt);
      integer(now, 1);
      integer(expiry, 1);
      if (
        expiry - now !== request.ttlMs ||
        Number(request.ttlMs) < 1000 ||
        Number(request.ttlMs) > 300000 ||
        (prior && now < Date.parse(prior.lastClockAt))
      )
        fail();
      if (receipt.operation === "lease-acquire") {
        if (
          after.generation !== (prior?.generation ?? 0) + 1 ||
          (prior && now < Date.parse(prior.expiresAt))
        )
          fail();
      } else if (receipt.operation === "lease-renew") {
        if (
          !prior ||
          after.generation !== prior.generation ||
          after.worker.sha256 !== prior.worker.sha256 ||
          now >= Date.parse(prior.expiresAt)
        )
          fail();
      } else fail();
      return;
    }
    const after = record as TriggerOccurrence,
      prior = before as TriggerOccurrence | undefined;
    if (!prior) {
      if (
        !["trigger", "due-occurrence"].includes(receipt.operation) ||
        after.state !== "queued" ||
        after.leaseRevisionId !== null ||
        after.leaseSha256 !== null ||
        after.worker !== null ||
        after.generation !== null ||
        after.claimToken !== null ||
        after.prompt !== null ||
        after.promptSha256 !== null ||
        after.input !== null ||
        after.observation !== null ||
        after.errorCode !== null
      )
        fail();
      return;
    }
    for (const key of [
      "occurrenceId",
      "scheduleId",
      "scheduleRevisionId",
      "scheduleSha256",
      "candidate",
      "inputRequestId",
    ] as const)
      if (knowledgeHash(after[key]) !== knowledgeHash(prior[key])) fail();
    let expected: Record<string, unknown> = { ...payload(prior) };
    if (receipt.operation === "claim") {
      if (
        prior.state !== "queued" ||
        after.state !== "claimed" ||
        !after.worker ||
        !after.claimToken ||
        !after.leaseRevisionId ||
        !after.leaseSha256 ||
        after.generation === null
      )
        fail();
      expected = {
        ...expected,
        state: "claimed",
        worker: after.worker,
        claimToken: after.claimToken,
        leaseRevisionId: after.leaseRevisionId,
        leaseSha256: after.leaseSha256,
        generation: after.generation,
      };
    } else if (receipt.operation === "dispatch") {
      if (
        prior.state !== "claimed" ||
        after.state !== "dispatching" ||
        request.prompt !==
          formatScheduleInput(this.scheduleFor(prior).spec, prior.candidate) ||
        request.inputRequestId !== prior.inputRequestId
      )
        fail();
      expected = {
        ...expected,
        state: "dispatching",
        prompt: request.prompt,
        promptSha256: sha256Hex(String(request.prompt)),
      };
    } else if (receipt.operation === "accepted") {
      if (
        !["dispatching", "uncertain"].includes(prior.state) ||
        after.state !== "accepted" ||
        !after.input
      )
        fail();
      expected = {
        ...expected,
        state: "accepted",
        input: after.input,
        errorCode: null,
      };
    } else if (receipt.operation === "observe") {
      if (!after.input || !after.observation) fail();
      const proof = after.observation;
      let state: ScheduleOccurrenceState =
        proof.state === "cancelled"
          ? "cancelled"
          : proof.state === "pending"
            ? "accepted"
            : "promoted";
      if (
        proof.runState &&
        [
          "completed",
          "failed",
          "cancelled",
          "interrupted",
          "uncertain",
        ].includes(proof.runState)
      )
        state =
          proof.cleanupConfirmed === true &&
          ["completed", "failed", "cancelled"].includes(proof.runState)
            ? (proof.runState as ScheduleOccurrenceState)
            : "uncertain";
      expected = {
        ...expected,
        state,
        input: after.input,
        observation: proof,
        errorCode: state === "uncertain" ? "SCHEDULE_RUN_UNCERTAIN" : null,
      };
    } else if (receipt.operation === "abandon") {
      const state =
        prior.state === "claimed" && request.requestedOperation === "cancelled"
          ? "cancelled"
          : "uncertain";
      if (typeof request.errorCode !== "string") fail();
      expected = { ...expected, state, errorCode: request.errorCode };
    } else if (receipt.operation === "recover") {
      if (
        !["claimed", "dispatching"].includes(prior.state) ||
        after.state !== "uncertain" ||
        receipt.requestId !== `recover:${prior.id}`
      )
        fail();
      expected = {
        ...expected,
        state: "uncertain",
        input: after.input,
        errorCode: "SCHEDULE_RESTART_UNCERTAIN",
      };
    } else if (receipt.operation === "import-pause") {
      expected = { ...expected, state: "paused-import" };
    } else fail();
    if (knowledgeHash(expected) !== knowledgeHash(payload(after))) fail();
  }
  validate(check: () => void = () => {}): void {
    const sizes = this.db
      .prepare(
        "SELECT count(*) AS n,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM schedule_revisions",
      )
      .get()!;
    if (
      Number(sizes.n) > 8192 ||
      Number(sizes.bytes) > 33554432 ||
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM schedule_heads WHERE kind='occurrence'",
          )
          .get()!.n,
      ) > 512 ||
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM schedule_heads WHERE kind='schedule'",
          )
          .get()!.n,
      ) > 32
    )
      fail("SCHEDULE_LIMIT");
    for (const header of this.db
      .prepare(
        "SELECT id,workspace_id FROM schedule_revisions ORDER BY workspace_id,id LIMIT 8193",
      )
      .all()) {
      check();
      const row = this.row(String(header.id), String(header.workspace_id))!,
        body = this.read<Body>(row.id, row.workspace_id);
      if (row.previous_id) {
        const before = this.row(row.previous_id, row.workspace_id);
        if (
          !before ||
          before.kind !== row.kind ||
          before.entity_id !== row.entity_id ||
          before.revision + 1 !== row.revision
        )
          fail();
      } else if (row.revision !== 1) fail();
      if (row.kind === "transition") {
        const receipt = body as ScheduleTransitionReceipt,
          after = this.read<
            ScheduleRevision | SchedulerLease | TriggerOccurrence
          >(receipt.afterRevisionId, receipt.workspaceId, receipt.kind);
        if (
          after.lastReceiptId !== receipt.id ||
          after.sha256 !== receipt.afterSha256 ||
          after.previousId !== receipt.beforeRevisionId ||
          row.previous_id !==
            (after.previousId
              ? this.read<
                  ScheduleRevision | SchedulerLease | TriggerOccurrence
                >(after.previousId, after.workspaceId).lastReceiptId
              : null)
        )
          fail();
        continue;
      }
      const record = body as
          ScheduleRevision | SchedulerLease | TriggerOccurrence,
        receipt = this.receipt(record);
      this.semantic(record, row.kind);
      if (
        receipt.kind !== row.kind ||
        receipt.entityId !== row.entity_id ||
        !this.head(row.workspace_id, row.kind, row.entity_id)
      )
        fail();
      if (row.kind === "schedule") {
        const schedule = body as ScheduleRevision;
        if (schedule.cursor !== null)
          validateScheduleCursor(schedule.cursor, schedule.spec);
        if (schedule.due) {
          digest(schedule.due);
          if (
            schedule.due.scheduleSha256 !== schedule.spec.sha256 ||
            knowledgeHash(schedule.cursor) !==
              knowledgeHash(schedule.due.batch.nextCursor)
          )
            fail();
        }
      }
      if (row.kind === "occurrence") {
        const occurrence = body as TriggerOccurrence,
          schedule = this.scheduleFor(occurrence);
        validateScheduleOccurrence(occurrence.candidate, schedule.spec);
        if (
          occurrence.inputRequestId !== occurrence.candidate.inputRequestId ||
          ![
            "queued",
            "claimed",
            "dispatching",
            "accepted",
            "promoted",
            "completed",
            "failed",
            "cancelled",
            "uncertain",
            "paused-import",
          ].includes(occurrence.state)
        )
          fail();
        if (
          occurrence.prompt !== null &&
          (occurrence.prompt !==
            formatScheduleInput(schedule.spec, occurrence.candidate) ||
            occurrence.promptSha256 !== sha256Hex(occurrence.prompt))
        )
          fail();
        if (occurrence.worker !== null) {
          digest(occurrence.worker);
          const lease = this.read<SchedulerLease>(
            occurrence.leaseRevisionId!,
            occurrence.workspaceId,
            "lease",
          );
          if (
            Date.parse(occurrence.createdAt) < Date.parse(lease.createdAt) ||
            (occurrence.state === "claimed" &&
              Date.parse(occurrence.createdAt) >=
                Date.parse(lease.expiresAt)) ||
            lease.sha256 !== occurrence.leaseSha256 ||
            lease.worker.sha256 !== occurrence.worker.sha256 ||
            lease.generation !== occurrence.generation ||
            !occurrence.claimToken
          )
            fail();
        }
        if (occurrence.input) {
          digest(occurrence.input);
          const input = this.inputRecord(schedule, occurrence);
          if (
            !input ||
            knowledgeHash(this.inputProof(input)) !==
              knowledgeHash(occurrence.input)
          )
            fail();
        }
        if (occurrence.observation) {
          digest(occurrence.observation);
          const actual = this.inputRecord(schedule, occurrence);
          if (!actual) fail();
          this.observation(actual, occurrence.observation, true);
          const proof = occurrence.observation;
          if (
            proof.inputId !== occurrence.input?.inputId ||
            proof.inputSha256 !== occurrence.input?.inputSha256 ||
            proof.workspaceId !== occurrence.workspaceId ||
            proof.sessionId !== schedule.spec.target.sessionId
          )
            fail();
          if (
            ["completed", "failed", "cancelled"].includes(occurrence.state) &&
            proof.runId &&
            proof.cleanupConfirmed !== true
          )
            fail();
        }
      }
    }
    for (const row of this.db
      .prepare(
        "SELECT workspace_id,kind,entity_id FROM schedule_heads LIMIT 8193",
      )
      .all()) {
      check();
      this.head(
        String(row.workspace_id),
        row.kind as "schedule" | "lease" | "occurrence",
        String(row.entity_id),
      );
    }
  }
  pauseImported(archiveSha: string, workspaceId?: string): void {
    if (!/^[a-f0-9]{64}$/.test(archiveSha)) fail();
    if (
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM schedule_heads WHERE kind='occurrence'",
          )
          .get()!.n,
      ) > 512 ||
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM schedule_heads WHERE kind='schedule'",
          )
          .get()!.n,
      ) > 32
    )
      fail("SCHEDULE_LIMIT");
    for (const head of this.db
      .prepare(
        `SELECT workspace_id,entity_id FROM schedule_heads WHERE kind='schedule'${workspaceId === undefined ? "" : " AND workspace_id=?"} LIMIT 1025`,
      )
      .all(...(workspaceId === undefined ? [] : [id(workspaceId)]))) {
      const before = this.getSchedule(
        String(head.workspace_id),
        String(head.entity_id),
      )!;
      if (!before.spec.enabled) continue;
      const { sha256: _sha, ...definition } = before.spec,
        spec = validateScheduleSpec({ ...definition, enabled: false });
      this.commit(
        "schedule",
        before.scheduleId,
        this.revise(
          {
            ...before,
            spec,
            cursor: initialScheduleCursor(spec),
            due: null,
            worker: null,
          },
          before,
        ),
        before,
        "import-disable",
        {
          workspaceId: before.workspaceId,
          scheduleId: before.scheduleId,
          requestId: `archive:${archiveSha.slice(0, 24)}:${before.id}`,
          expectedRevision: before.revision,
          operation: "import-disable",
        },
      );
    }
    for (const head of this.db
      .prepare(
        `SELECT workspace_id,entity_id FROM schedule_heads WHERE kind='occurrence'${workspaceId === undefined ? "" : " AND workspace_id=?"} LIMIT 1025`,
      )
      .all(...(workspaceId === undefined ? [] : [id(workspaceId)]))) {
      const before = this.getOccurrence(
        String(head.workspace_id),
        String(head.entity_id),
      )!;
      if (before.state !== "paused-import")
        this.recoveryRecord(
          before,
          "paused-import",
          `archive:${archiveSha.slice(0, 24)}:${before.id}`,
          "import-pause",
        );
    }
  }
}
export function validateScheduleDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  new ScheduleJournal(db).validate(options.check);
}
export function markImportedSchedulesDisabled(
  db: DatabaseSync,
  archiveSha: string,
  workspaceId?: string,
): void {
  new ScheduleJournal(db).pauseImported(archiveSha, workspaceId);
}
