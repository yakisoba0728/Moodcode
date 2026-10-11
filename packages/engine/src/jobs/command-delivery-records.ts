import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import {
  normalizeAcceptInput,
  validateInputRecord,
} from "@moodcode/contracts/validation";
import { knowledgeHash, sha256 } from "../knowledge/validation.js";
import type { QueueTargetPin } from "../runner/queue-target.js";
import { sameCanonical as same } from "../shared/canonical.js";
import { requestIdentity } from "../storage/native-schema.js";
import type { SessionDocument } from "../storage/native-records.js";
import { assertInTransaction } from "../storage/transaction.js";
import type { JobAcceptedInputProof } from "./delivery.js";
import {
  isCanonicalJobTime,
  jobJson,
  jobObject,
  jobIdentifier,
  jobSha256,
  signJobData,
} from "./validation.js";

export interface CommandDeliveryInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly expectedRevision: 0;
  readonly targetSha256: string;
}
export interface CommandDeliveryRecord<S> {
  readonly version: 1;
  readonly id: string;
  readonly revision: 1 | 2;
  readonly state: "accepted" | "paused-import";
  readonly workspaceId: string;
  readonly jobId: string;
  readonly settled: S;
  readonly target: QueueTargetPin;
  readonly targetSha256: string;
  readonly prompt: string;
  readonly inputRequestId: string;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly accepted: JobAcceptedInputProof;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly importArchiveSha256: string | null;
  readonly sha256: string;
}
export type CommandDeliveryResult<S> = {
  readonly kind: "accepted" | "duplicate";
  readonly record: CommandDeliveryRecord<S>;
};
export interface CommandDeliveryTargetProof<S> {
  readonly version: 1;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly jobSha256: string;
  readonly sourceSha256: string;
  readonly settled: S;
  readonly target: QueueTargetPin;
  readonly sha256: string;
}
export interface CommandDeliveryPorts<P, E extends string> {
  readTargetOriginal(original: object): P;
  assertTarget(original: object, expected: P): void;
  acceptAtomic(
    original: object,
    input: { inputRequestId: string; prompt: string },
  ): object;
  readAccepted(original: object): JobAcceptedInputProof;
  releaseAccepted(original: object): void;
  writeDocument(
    sessionId: string,
    kind: string,
    expectedRevision: number,
    data: JsonObject,
  ): SessionDocument;
  appendEvent(
    sessionId: string,
    type: E,
    payload: JsonObject,
    refs: { inputId: string },
  ): unknown;
}
export interface CommandDeliveryControlOptions {
  writeDocument: CommandDeliveryPorts<unknown, string>["writeDocument"];
}
export interface CommandDeliveryValidationOptions {
  readonly check?: () => void;
}
/** What one kind of settled command result needs for its records, producer and Root delivery. */
export interface CommandResultProfile<
  S,
  P extends CommandDeliveryTargetProof<S>,
> {
  /** Prefix of the Root delivery messages, such as "Owned command". */
  readonly label: string;
  /** Request id prefix of the queued result input. */
  readonly inputPrefix: string;
  /** Request id and prompt of the input that only normalizes the target config. */
  readonly placeholder: string;
  readonly proofBytes: number;
  readonly validateSettled: (value: unknown) => S;
  readonly validateTarget: (value: unknown) => P;
  readonly formatResult: (settled: S, proof: P) => string;
  readonly digests: (settled: S) => {
    readonly jobSha256: string;
    readonly sourceSha256: string;
  };
  readonly sessionOf: (settled: S) => string;
}
/** Record helpers a settled-source proof reports through. */
export interface CommandDeliveryKit {
  fail(code?: string): never;
  parsed(value: unknown): unknown;
  documentAnchor(
    db: DatabaseSync,
    sessionId: string,
    kind: string,
    revision: number,
    encoded: string,
  ): void;
}
export interface CommandDeliverySpec<
  S,
  P extends CommandDeliveryTargetProof<S>,
  E extends string,
> extends CommandResultProfile<S, P> {
  /** Prefix of the local error codes, such as "OWNED_COMMAND_DELIVERY". */
  readonly code: string;
  /** Receipts are `${kindPrefix}delivery.*` documents and their input links `${kindPrefix}input.*`. */
  readonly kindPrefix: string;
  readonly admittedEvent: E;
  readonly idDomain: string;
  /** The job's settlement as stored now; delivery is stale unless it equals the target's pin. */
  readonly currentSettled: (
    db: DatabaseSync,
    workspaceId: string,
    jobId: string,
  ) => S | undefined;
  /** Re-proves a record's pinned settlement against the native rows of its source. */
  readonly assertSettledSource: (
    db: DatabaseSync,
    record: CommandDeliveryRecord<S>,
    kit: CommandDeliveryKit,
  ) => void;
}
const COMMAND_DELIVERY_LIMITS = Object.freeze({
  deliveries: 128,
  documents: 256,
  bytes: 16_777_216,
  rowBytes: 131_072,
  anchorBytes: 196_608,
  inputBytes: 262_144,
});
interface Link {
  version: 1;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  deliveryId: string;
  inputRequestId: string;
  receiptSha256: string;
  sha256: string;
}
interface Header {
  session_id: string;
  kind: string;
  revision: number;
  bytes: number;
  workspace_id: string;
}

function failure(code: string): never {
  throw new EngineError(
    code,
    "Command result delivery does not match its bounded native admission evidence",
  );
}

/** Receipts, input links and admission anchors of one kind of settled command result delivery. */
export function createCommandDeliveryRecords<
  S,
  P extends CommandDeliveryTargetProof<S>,
  E extends string,
>(spec: CommandDeliverySpec<S, P, E>) {
  type DeliveryRecord = CommandDeliveryRecord<S>;
  const limits = COMMAND_DELIVERY_LIMITS,
    receipts = `${spec.kindPrefix}delivery.*`,
    links = `${spec.kindPrefix}input.*`,
    countReceipts = `SELECT count(*) n FROM session_documents WHERE kind GLOB '${receipts}'`;
  const code = (suffix: string) => `${spec.code}_${suffix}`;
  function fail(failed = code("INVALID")): never {
    return failure(failed);
  }
  function parsed(value: unknown): unknown {
    try {
      return JSON.parse(String(value));
    } catch {
      fail();
    }
  }
  function stamp(value: unknown): string {
    if (!isCanonicalJobTime(value)) fail();
    return value;
  }
  function synchronous(value: unknown): void {
    if (types.isPromise(value)) fail(code("ASYNC_PORT"));
  }
  function inputData(value: unknown): CommandDeliveryInput {
    const p = jobObject(value, [
      "workspaceId",
      "jobId",
      "requestId",
      "expectedRevision",
      "targetSha256",
    ]);
    for (const k of ["workspaceId", "jobId", "requestId"]) jobIdentifier(p[k]);
    jobSha256(p.targetSha256);
    if (p.expectedRevision !== 0) failure("REVISION_CONFLICT");
    return p as unknown as CommandDeliveryInput;
  }
  function deliveryId(
    workspaceId: string,
    jobId: string,
    jobDigest: string,
  ): string {
    jobIdentifier(workspaceId);
    jobIdentifier(jobId);
    jobSha256(jobDigest);
    return knowledgeHash([spec.idDomain, workspaceId, jobId, jobDigest]);
  }
  function deliveryKind(deliveryId: string): string {
    jobIdentifier(deliveryId);
    return `${spec.kindPrefix}delivery.${knowledgeHash(deliveryId).slice(0, 32)}`;
  }
  function inputKind(inputId: string): string {
    jobIdentifier(inputId);
    return `${spec.kindPrefix}input.${knowledgeHash(inputId).slice(0, 32)}`;
  }
  function targetOf(r: DeliveryRecord): P {
    const { jobSha256, sourceSha256 } = spec.digests(r.settled);
    return spec.validateTarget({
      version: 1,
      workspaceId: r.workspaceId,
      jobId: r.jobId,
      jobSha256,
      sourceSha256,
      settled: r.settled,
      target: r.target,
      sha256: r.targetSha256,
    });
  }
  function acceptedProof(value: unknown): JobAcceptedInputProof {
    const p = jobObject(value, [
      "workspaceId",
      "sessionId",
      "inputId",
      "requestId",
      "admittedSeq",
      "inputSha256",
      "sha256",
    ]);
    for (const k of ["workspaceId", "sessionId", "inputId", "requestId"])
      jobIdentifier(p[k]);
    for (const k of ["inputSha256", "sha256"]) jobSha256(p[k]);
    const { sha256, ...body } = p;
    if (
      !Number.isSafeInteger(p.admittedSeq) ||
      Number(p.admittedSeq) < 1 ||
      knowledgeHash(body) !== sha256
    )
      fail(code("INPUT_INVALID"));
    return p as unknown as JobAcceptedInputProof;
  }
  function validateRecord(value: unknown): DeliveryRecord {
    const p = jobObject(
      value,
      [
        "version",
        "id",
        "revision",
        "state",
        "workspaceId",
        "jobId",
        "settled",
        "target",
        "targetSha256",
        "prompt",
        "inputRequestId",
        "requestId",
        "requestSha256",
        "accepted",
        "createdAt",
        "updatedAt",
        "importArchiveSha256",
        "sha256",
      ],
      [],
      limits.rowBytes,
    );
    const r = p as unknown as DeliveryRecord;
    for (const v of [
      r.id,
      r.workspaceId,
      r.jobId,
      r.inputRequestId,
      r.requestId,
    ])
      jobIdentifier(v);
    for (const v of [r.targetSha256, r.requestSha256, r.sha256]) jobSha256(v);
    stamp(r.createdAt);
    stamp(r.updatedAt);
    const { sha256, ...body } = p;
    if (
      r.version !== 1 ||
      r.updatedAt < r.createdAt ||
      knowledgeHash(body) !== sha256 ||
      !(
        (r.revision === 1 &&
          r.state === "accepted" &&
          r.importArchiveSha256 === null &&
          r.updatedAt === r.createdAt) ||
        (r.revision === 2 &&
          r.state === "paused-import" &&
          typeof r.importArchiveSha256 === "string")
      )
    )
      fail();
    if (r.importArchiveSha256 !== null) jobSha256(r.importArchiveSha256);
    const proof = targetOf(r),
      accepted = acceptedProof(r.accepted),
      settled = spec.validateSettled(r.settled),
      { jobSha256: settledSha256 } = spec.digests(settled);
    if (
      r.id !== deliveryId(r.workspaceId, r.jobId, settledSha256) ||
      r.inputRequestId !== `${spec.inputPrefix}:${r.jobId}:${settledSha256}` ||
      r.prompt !== spec.formatResult(settled, proof) ||
      accepted.workspaceId !== r.workspaceId ||
      accepted.sessionId !== proof.target.sessionId ||
      accepted.requestId !== r.inputRequestId ||
      r.requestSha256 !==
        knowledgeHash(
          inputData({
            workspaceId: r.workspaceId,
            jobId: r.jobId,
            requestId: r.requestId,
            expectedRevision: 0,
            targetSha256: r.targetSha256,
          }),
        )
    )
      fail();
    return jobJson(r, limits.rowBytes);
  }
  function linkOf(r: DeliveryRecord): Link {
    return signJobData({
      version: 1 as const,
      workspaceId: r.workspaceId,
      sessionId: r.accepted.sessionId,
      inputId: r.accepted.inputId,
      deliveryId: r.id,
      inputRequestId: r.inputRequestId,
      receiptSha256: r.sha256,
    });
  }
  function caps(db: DatabaseSync): void {
    const c = db
      .prepare(
        `SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,coalesce(max(length(CAST(data AS BLOB))),0) biggest FROM session_documents WHERE kind GLOB '${receipts}' OR kind GLOB '${links}'`,
      )
      .get()!;
    if (
      Number(c.n) > limits.documents ||
      Number(c.bytes) > limits.bytes ||
      Number(c.biggest) > limits.rowBytes
    )
      fail(code("LIMIT"));
    const d = db.prepare(countReceipts).get()!;
    if (Number(d.n) > limits.deliveries) fail(code("LIMIT"));
  }
  function docHeader(
    db: DatabaseSync,
    workspaceId: string,
    kind: string,
    sessionId?: string,
  ): Header | undefined {
    const hs = db
      .prepare(
        "SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) bytes,s.workspace_id FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE s.workspace_id=? AND d.kind=? AND (? IS NULL OR d.session_id=?) LIMIT 2",
      )
      .all(
        workspaceId,
        kind,
        sessionId ?? null,
        sessionId ?? null,
      ) as unknown as Header[];
    if (hs.length > 1) fail();
    return hs[0];
  }
  function eventBodies(
    db: DatabaseSync,
    sessionId: string,
    type: string,
    discriminator: string,
    maximum = limits.anchorBytes,
  ): Record<string, unknown>[] {
    const hs = db
      .prepare(
        "SELECT seq,run_id,input_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND instr(data,?)>0 LIMIT 130",
      )
      .all(sessionId, type, discriminator);
    if (
      hs.length > 128 ||
      hs.reduce((n, h) => n + Number(h.bytes), 0) > limits.bytes
    )
      fail(code("LIMIT"));
    return hs.map((h) => {
      if (Number(h.bytes) < 1 || Number(h.bytes) > maximum) fail(code("LIMIT"));
      const row = db
        .prepare(
          "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
        )
        .get(sessionId, h.seq!, h.bytes!);
      if (!row) fail();
      const e = parsed(row.data) as Record<string, unknown>;
      if (
        e.sessionId !== sessionId ||
        e.seq !== h.seq ||
        (e.runId ?? null) !== h.run_id ||
        (e.inputId ?? null) !== h.input_id ||
        (e.turnId ?? null) !== h.turn_id ||
        (e.attemptId ?? null) !== h.attempt_id
      )
        fail();
      return e;
    });
  }
  function documentAnchor(
    db: DatabaseSync,
    sessionId: string,
    kind: string,
    revision: number,
    encoded: string,
  ): void {
    const sha = sha256(encoded);
    if (
      eventBodies(db, sessionId, "session.document.updated", sha).filter(
        (e) => {
          const p = e.payload as Record<string, unknown>;
          return (
            p?.kind === kind && p.revision === revision && p.sha256 === sha
          );
        },
      ).length !== 1
    )
      fail(code("DOCUMENT_INVALID"));
  }
  function docBody(db: DatabaseSync, h: Header): unknown {
    if (
      !Number.isSafeInteger(h.revision) ||
      h.revision < 1 ||
      Number(h.bytes) < 1 ||
      Number(h.bytes) > limits.rowBytes
    )
      fail(code("LIMIT"));
    const row = db
      .prepare(
        "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND revision=? AND length(CAST(data AS BLOB))=?",
      )
      .get(h.session_id, h.kind, h.revision, h.bytes);
    if (!row) fail();
    const encoded = String(row.data);
    documentAnchor(db, h.session_id, h.kind, h.revision, encoded);
    return parsed(encoded);
  }
  function admission(
    db: DatabaseSync,
    sessionId: string,
    inputId: string,
  ): DeliveryRecord | undefined {
    const hs = db
      .prepare(
        `SELECT seq,run_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type='${spec.admittedEvent}' AND input_id=? LIMIT 2`,
      )
      .all(sessionId, inputId);
    if (hs.length > 1) fail(code("ANCHOR_INVALID"));
    if (!hs.length) return;
    const h = hs[0]!;
    if (Number(h.bytes) < 1 || Number(h.bytes) > limits.anchorBytes)
      fail(code("LIMIT"));
    const row = db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
      )
      .get(sessionId, h.seq!, h.bytes!);
    if (!row) fail();
    const e = jobObject(
      parsed(row.data),
      [
        "schemaVersion",
        "stream",
        "eventId",
        "sessionId",
        "seq",
        "timestamp",
        "type",
        "payload",
        "inputId",
      ],
      [],
      limits.anchorBytes,
    );
    const p = jobObject(e.payload, ["receipt"], [], limits.anchorBytes);
    const r = validateRecord(p.receipt);
    if (
      e.schemaVersion !== 2 ||
      e.stream !== "session-v2" ||
      e.type !== spec.admittedEvent ||
      e.seq !== h.seq ||
      e.sessionId !== sessionId ||
      e.inputId !== inputId ||
      h.run_id !== null ||
      h.turn_id !== null ||
      h.attempt_id !== null ||
      r.state !== "accepted" ||
      r.revision !== 1 ||
      r.accepted.inputId !== inputId ||
      r.accepted.sessionId !== sessionId
    )
      fail(code("ANCHOR_INVALID"));
    return r;
  }
  const birthBody = ({
    revision: _r,
    state: _s,
    updatedAt: _t,
    importArchiveSha256: _i,
    sha256: _h,
    ...body
  }: DeliveryRecord) => body;
  function acceptedSql(db: DatabaseSync, r: DeliveryRecord): void {
    const a = r.accepted,
      h = db
        .prepare(
          "SELECT session_id,workspace_id,request_id,fingerprint,admitted_seq,delivery,state,run_id,promoted_seq,length(CAST(data AS BLOB)) bytes FROM session_inputs WHERE id=?",
        )
        .get(a.inputId);
    if (
      !h ||
      h.session_id !== a.sessionId ||
      h.workspace_id !== r.workspaceId ||
      h.request_id !== r.inputRequestId ||
      h.admitted_seq !== a.admittedSeq ||
      Number(h.bytes) > limits.inputBytes
    )
      fail(code("INPUT_INVALID"));
    const row = db
      .prepare(
        "SELECT data FROM session_inputs WHERE id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(a.inputId, h.bytes!);
    if (!row) fail();
    const rawInput = parsed(row.data) as Record<string, unknown>;
    if (
      Object.hasOwn(rawInput, "attachments") ||
      Object.hasOwn(rawInput, "documents")
    )
      fail(code("INPUT_INVALID"));
    const input = validateInputRecord(rawInput);
    const normalized = normalizeAcceptInput({
      sessionId: a.sessionId,
      requestId: r.inputRequestId,
      prompt: r.prompt,
      config: r.target.config,
      delivery: "queue",
    });
    if (
      a.inputSha256 !== knowledgeHash(normalized) ||
      h.fingerprint !== requestIdentity(normalized) ||
      input.id !== a.inputId ||
      input.workspaceId !== r.workspaceId ||
      input.sessionId !== a.sessionId ||
      input.requestId !== r.inputRequestId ||
      input.admittedSeq !== a.admittedSeq ||
      input.state !== h.state ||
      input.delivery !== h.delivery ||
      (input.runId ?? null) !== h.run_id ||
      (input.promotedSeq ?? null) !== h.promoted_seq ||
      input.prompt !== r.prompt ||
      !same(input.config, normalized.config) ||
      input.delivery !== "queue"
    )
      fail(code("INPUT_INVALID"));
    const hs = db
      .prepare(
        "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND input_id=? AND type='input.accepted' LIMIT 2",
      )
      .all(a.sessionId, a.inputId);
    if (
      hs.length !== 1 ||
      hs[0]!.seq !== a.admittedSeq ||
      Number(hs[0]!.bytes) > limits.inputBytes
    )
      fail(code("INPUT_INVALID"));
    const er = db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
      )
      .get(a.sessionId, hs[0]!.seq!, hs[0]!.bytes!);
    if (!er) fail();
    const e = parsed(er.data) as Record<string, unknown>,
      b = (e.payload as Record<string, unknown>)?.input as Record<
        string,
        unknown
      >;
    if (
      e.inputId !== a.inputId ||
      e.sessionId !== a.sessionId ||
      !b ||
      b.id !== a.inputId ||
      b.workspaceId !== r.workspaceId ||
      b.sessionId !== a.sessionId ||
      b.state !== "pending" ||
      b.admittedSeq !== a.admittedSeq ||
      b.requestId !== r.inputRequestId ||
      b.prompt !== r.prompt ||
      b.delivery !== "queue" ||
      Object.hasOwn(b, "attachments") ||
      Object.hasOwn(b, "documents") ||
      !same(b.config, normalized.config)
    )
      fail(code("INPUT_INVALID"));
  }
  const kit: CommandDeliveryKit = { fail, parsed, documentAnchor };
  function readRecord(db: DatabaseSync, h: Header): DeliveryRecord {
    const r = validateRecord(docBody(db, h));
    if (
      r.workspaceId !== h.workspace_id ||
      r.accepted.sessionId !== h.session_id ||
      r.revision !== h.revision ||
      h.kind !== deliveryKind(r.id)
    )
      fail();
    const birth = admission(db, h.session_id, r.accepted.inputId);
    if (!birth || !same(birthBody(r), birthBody(birth)))
      fail(code("ANCHOR_INVALID"));
    if (r.state === "accepted" && !same(r, birth)) fail(code("ANCHOR_INVALID"));
    const linkH = docHeader(
      db,
      r.workspaceId,
      inputKind(r.accepted.inputId),
      h.session_id,
    );
    if (
      !linkH ||
      linkH.revision !== 1 ||
      !same(docBody(db, linkH), linkOf(birth))
    )
      fail(code("LINK_INVALID"));
    spec.assertSettledSource(db, r, kit);
    acceptedSql(db, r);
    return r;
  }
  function readDelivery(
    db: DatabaseSync,
    workspaceId: string,
    deliveryId: string,
  ): DeliveryRecord | undefined {
    jobIdentifier(workspaceId);
    jobIdentifier(deliveryId);
    caps(db);
    const h = docHeader(db, workspaceId, deliveryKind(deliveryId));
    const r = h ? readRecord(db, h) : undefined;
    if (r && r.id !== deliveryId) fail();
    return r;
  }
  function readDeliveries(
    db: DatabaseSync,
    workspaceId: string,
    sessionId?: string,
  ): readonly DeliveryRecord[] {
    jobIdentifier(workspaceId);
    if (sessionId !== undefined) jobIdentifier(sessionId);
    caps(db);
    const hs = db
      .prepare(
        `SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) bytes,s.workspace_id FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE s.workspace_id=? AND d.kind GLOB '${receipts}' AND (? IS NULL OR d.session_id=?) ORDER BY d.session_id,d.kind LIMIT 129`,
      )
      .all(
        workspaceId,
        sessionId ?? null,
        sessionId ?? null,
      ) as unknown as Header[];
    if (hs.length > 128) fail(code("LIMIT"));
    return Object.freeze(hs.map((h) => readRecord(db, h)));
  }
  function findForInput(
    db: DatabaseSync,
    value: {
      workspaceId: string;
      sessionId: string;
      inputId: string;
      requestId: string;
    },
  ): DeliveryRecord | null {
    const x = jobObject(value, [
      "workspaceId",
      "sessionId",
      "inputId",
      "requestId",
    ]);
    for (const v of Object.values(x)) jobIdentifier(v);
    const h = docHeader(
      db,
      String(x.workspaceId),
      inputKind(String(x.inputId)),
      String(x.sessionId),
    );
    const birth = admission(db, String(x.sessionId), String(x.inputId));
    if (!h && !birth) {
      if (String(x.requestId).startsWith(`${spec.inputPrefix}:`))
        fail(code("LINK_INVALID"));
      return null;
    }
    caps(db);
    if (!h || !birth || !same(docBody(db, h), linkOf(birth)))
      fail(code("LINK_INVALID"));
    const r = readDelivery(db, String(x.workspaceId), birth.id);
    if (
      !r ||
      r.accepted.inputId !== x.inputId ||
      r.accepted.sessionId !== x.sessionId ||
      r.inputRequestId !== x.requestId
    )
      fail(code("LINK_INVALID"));
    return r;
  }
  function validateDatabase(
    db: DatabaseSync,
    options: CommandDeliveryValidationOptions = {},
  ): void {
    caps(db);
    const hs = db
      .prepare(
        `SELECT session_id,input_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE type='${spec.admittedEvent}' ORDER BY session_id,seq LIMIT 129`,
      )
      .all();
    if (
      hs.length > 128 ||
      hs.reduce((n, h) => n + Number(h.bytes), 0) > limits.bytes
    )
      fail(code("LIMIT"));
    for (const h of hs) {
      options.check?.();
      if (!h.input_id || Number(h.bytes) > limits.anchorBytes)
        fail(code("ANCHOR_INVALID"));
      const birth = admission(db, String(h.session_id), String(h.input_id));
      if (!birth || !readDelivery(db, birth.workspaceId, birth.id))
        fail(code("LINK_INVALID"));
    }
    const ds = db
      .prepare(
        `SELECT sum(kind GLOB '${receipts}') receipts,sum(kind GLOB '${links}') links FROM session_documents WHERE kind GLOB '${receipts}' OR kind GLOB '${links}'`,
      )
      .get()!;
    if (
      Number(ds.receipts ?? 0) !== hs.length ||
      Number(ds.links ?? 0) !== hs.length
    )
      fail(code("LINK_INVALID"));
  }
  function deliverAtomic(
    db: DatabaseSync,
    original: object,
    value: CommandDeliveryInput,
    ports: CommandDeliveryPorts<P, E>,
  ): CommandDeliveryResult<S> {
    const x = inputData(value);
    assertInTransaction(db, () => fail(code("TRANSACTION_REQUIRED")));
    caps(db);
    const previous = readDeliveries(db, x.workspaceId).filter(
      (r) => r.requestId === x.requestId,
    );
    if (previous.length > 1) fail();
    if (previous.length) {
      if (previous[0]!.requestSha256 !== knowledgeHash(x))
        failure("REQUEST_ID_CONFLICT");
      return Object.freeze({ kind: "duplicate", record: previous[0]! });
    }
    if (
      !original ||
      typeof original !== "object" ||
      types.isProxy(original) ||
      types.isPromise(original)
    )
      fail(code("ORIGINAL_REQUIRED"));
    const proof = spec.validateTarget(ports.readTargetOriginal(original));
    if (
      proof.workspaceId !== x.workspaceId ||
      proof.jobId !== x.jobId ||
      proof.sha256 !== x.targetSha256
    )
      fail(code("TARGET_INVALID"));
    synchronous(ports.assertTarget(original, proof));
    const id = deliveryId(x.workspaceId, x.jobId, proof.jobSha256);
    if (readDelivery(db, x.workspaceId, id)) failure("REQUEST_ID_CONFLICT");
    const before = spec.currentSettled(db, x.workspaceId, x.jobId);
    if (!before || !same(before, proof.settled)) fail(code("STALE"));
    const prompt = spec.formatResult(proof.settled, proof),
      inputRequestId = `${spec.inputPrefix}:${x.jobId}:${proof.jobSha256}`;
    const at = new Date().toISOString();
    // Reject metadata/output bounds before producing an actual input.
    jobJson(
      { proof, prompt, inputRequestId, requestId: x.requestId },
      limits.rowBytes,
    );
    const count = db.prepare(countReceipts).get()!;
    if (Number(count.n) >= limits.deliveries) fail(code("LIMIT"));
    const acceptedOriginal = ports.acceptAtomic(original, {
      inputRequestId,
      prompt,
    });
    if (
      !acceptedOriginal ||
      typeof acceptedOriginal !== "object" ||
      types.isProxy(acceptedOriginal) ||
      types.isPromise(acceptedOriginal)
    )
      fail(code("ORIGINAL_REQUIRED"));
    try {
      const accepted = acceptedProof(ports.readAccepted(acceptedOriginal));
      const record = validateRecord(
        signJobData(
          {
            version: 1 as const,
            id,
            revision: 1 as const,
            state: "accepted" as const,
            workspaceId: x.workspaceId,
            jobId: x.jobId,
            settled: proof.settled,
            target: proof.target,
            targetSha256: proof.sha256,
            prompt,
            inputRequestId,
            requestId: x.requestId,
            requestSha256: knowledgeHash(x),
            accepted,
            createdAt: at,
            updatedAt: at,
            importArchiveSha256: null,
          },
          limits.rowBytes,
        ),
      );
      acceptedSql(db, record);
      spec.assertSettledSource(db, record, kit);
      const payload = jobJson({ receipt: record }, limits.anchorBytes);
      synchronous(
        ports.appendEvent(
          accepted.sessionId,
          spec.admittedEvent,
          payload as unknown as JsonObject,
          { inputId: accepted.inputId },
        ),
      );
      const saved = ports.writeDocument(
        accepted.sessionId,
        deliveryKind(id),
        0,
        record as unknown as JsonObject,
      );
      synchronous(saved);
      if (saved.revision !== 1 || !same(saved.data, record)) fail();
      const link = linkOf(record),
        linked = ports.writeDocument(
          accepted.sessionId,
          inputKind(accepted.inputId),
          0,
          link as unknown as JsonObject,
        );
      synchronous(linked);
      if (linked.revision !== 1 || !same(linked.data, link)) fail();
      caps(db);
      const stored = readDelivery(db, x.workspaceId, id);
      if (!stored || !same(stored, record)) fail();
      return Object.freeze({ kind: "accepted", record: stored });
    } finally {
      synchronous(ports.releaseAccepted(acceptedOriginal));
    }
  }
  function pauseImported(
    db: DatabaseSync,
    workspaceId: string,
    archiveSHA: string,
    options: CommandDeliveryControlOptions,
  ): number {
    jobIdentifier(workspaceId);
    jobSha256(archiveSHA);
    assertInTransaction(db, () => fail(code("TRANSACTION_REQUIRED")));
    let count = 0;
    for (const before of readDeliveries(db, workspaceId)) {
      if (before.state === "paused-import") continue;
      const at = new Date().toISOString();
      const { sha256: _sha, ...body } = before;
      const next = validateRecord(
        signJobData(
          {
            ...body,
            revision: 2 as const,
            state: "paused-import" as const,
            updatedAt: at,
            importArchiveSha256: archiveSHA,
          },
          limits.rowBytes,
        ),
      );
      const saved = options.writeDocument(
        before.accepted.sessionId,
        deliveryKind(before.id),
        1,
        next as unknown as JsonObject,
      );
      synchronous(saved);
      if (saved.revision !== 2 || !same(saved.data, next)) fail();
      count++;
    }
    validateDatabase(db);
    return count;
  }
  return {
    deliveryKind,
    inputKind,
    validateRecord,
    readDelivery,
    readDeliveries,
    findForInput,
    validateDatabase,
    deliverAtomic,
    pauseImported,
  };
}
