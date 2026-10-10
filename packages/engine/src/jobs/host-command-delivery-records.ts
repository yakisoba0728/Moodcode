import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import {
  normalizeAcceptInput,
  validateInputRecord,
} from "@moodcode/contracts/validation";
import { knowledgeHash, sha256 } from "../knowledge/validation.js";
import { requestIdentity } from "../storage/native-schema.js";
import type { SessionDocument } from "../storage/native-records.js";
import type { ScheduleTargetPin } from "../schedules/types.js";
import type { JobAcceptedInputProof } from "./delivery.js";
import {
  readHostCommand,
  validateHostCommandRecord,
} from "./host-command-records.js";
import {
  hostCommandSettlement,
  validateHostCommandSettlement,
  type HostCommandSettlementPin,
} from "./host-command-result.js";
import {
  validateHostCommandDeliveryTargetProof,
  formatHostCommandJobResult,
  type HostCommandDeliveryTargetProof,
} from "./host-command-result.js";
import {
  isCanonicalJobTime,
  jobJson,
  jobObject,
  jobIdentifier,
  jobSha256,
  signJobData,
} from "./validation.js";

export interface HostCommandDeliveryInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly expectedRevision: 0;
  readonly targetSha256: string;
}
export interface HostCommandDeliveryRecord {
  readonly version: 1;
  readonly id: string;
  readonly revision: 1 | 2;
  readonly state: "accepted" | "paused-import";
  readonly workspaceId: string;
  readonly jobId: string;
  readonly settled: HostCommandSettlementPin;
  readonly target: ScheduleTargetPin;
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
export type HostCommandDeliveryResult = {
  readonly kind: "accepted" | "duplicate";
  readonly record: HostCommandDeliveryRecord;
};
export interface HostCommandDeliveryPorts {
  readTargetOriginal(original: object): HostCommandDeliveryTargetProof;
  assertTarget(
    original: object,
    expected: HostCommandDeliveryTargetProof,
  ): void;
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
    type: "host.command.result_admitted",
    payload: JsonObject,
    refs: { inputId: string },
  ): unknown;
}
export interface HostCommandDeliveryControlOptions {
  writeDocument: HostCommandDeliveryPorts["writeDocument"];
}
export interface HostCommandDeliveryValidationOptions {
  readonly check?: () => void;
}
const HOST_COMMAND_DELIVERY_LIMITS = Object.freeze({
  deliveries: 128,
  documents: 256,
  bytes: 16_777_216,
  rowBytes: 131_072,
  anchorBytes: 196_608,
  inputBytes: 262_144,
});

function fail(code = "HOST_COMMAND_DELIVERY_INVALID"): never {
  throw new EngineError(
    code,
    "Command result delivery does not match its bounded native admission evidence",
  );
}
const same = (left: unknown, right: unknown) =>
  knowledgeHash(left) === knowledgeHash(right);
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
  if (types.isPromise(value)) fail("HOST_COMMAND_DELIVERY_ASYNC_PORT");
}
function inputData(value: unknown): HostCommandDeliveryInput {
  const p = jobObject(value, [
    "workspaceId",
    "jobId",
    "requestId",
    "expectedRevision",
    "targetSha256",
  ]);
  for (const k of ["workspaceId", "jobId", "requestId"]) jobIdentifier(p[k]);
  jobSha256(p.targetSha256);
  if (p.expectedRevision !== 0) fail("REVISION_CONFLICT");
  return p as unknown as HostCommandDeliveryInput;
}
function hostCommandDeliveryId(
  workspaceId: string,
  jobId: string,
  jobDigest: string,
): string {
  jobIdentifier(workspaceId);
  jobIdentifier(jobId);
  jobSha256(jobDigest);
  return knowledgeHash([
    "host-command-result-v1",
    workspaceId,
    jobId,
    jobDigest,
  ]);
}
function hostCommandDeliveryKind(deliveryId: string): string {
  jobIdentifier(deliveryId);
  return `host.command.delivery.${knowledgeHash(deliveryId).slice(0, 32)}`;
}
function hostCommandInputKind(inputId: string): string {
  jobIdentifier(inputId);
  return `host.command.input.${knowledgeHash(inputId).slice(0, 32)}`;
}
function targetOf(
  r: HostCommandDeliveryRecord,
): HostCommandDeliveryTargetProof {
  return validateHostCommandDeliveryTargetProof({
    version: 1,
    workspaceId: r.workspaceId,
    jobId: r.jobId,
    jobSha256: r.settled.jobSha256,
    sourceSha256: r.settled.sourceSha256,
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
    fail("HOST_COMMAND_DELIVERY_INPUT_INVALID");
  return p as unknown as JobAcceptedInputProof;
}
export function validateHostCommandDeliveryRecord(
  value: unknown,
): HostCommandDeliveryRecord {
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
    HOST_COMMAND_DELIVERY_LIMITS.rowBytes,
  );
  const r = p as unknown as HostCommandDeliveryRecord;
  for (const v of [r.id, r.workspaceId, r.jobId, r.inputRequestId, r.requestId])
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
    settled = validateHostCommandSettlement(r.settled);
  if (
    r.id !== hostCommandDeliveryId(r.workspaceId, r.jobId, settled.jobSha256) ||
    r.inputRequestId !==
      `host-command-result:${r.jobId}:${settled.jobSha256}` ||
    r.prompt !== formatHostCommandJobResult(settled, proof) ||
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
  return jobJson(r, HOST_COMMAND_DELIVERY_LIMITS.rowBytes);
}
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
function linkOf(r: HostCommandDeliveryRecord): Link {
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
interface Header {
  session_id: string;
  kind: string;
  revision: number;
  bytes: number;
  workspace_id: string;
}
function caps(db: DatabaseSync): void {
  const c = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,coalesce(max(length(CAST(data AS BLOB))),0) biggest FROM session_documents WHERE kind GLOB 'host.command.delivery.*' OR kind GLOB 'host.command.input.*'",
    )
    .get()!;
  if (
    Number(c.n) > HOST_COMMAND_DELIVERY_LIMITS.documents ||
    Number(c.bytes) > HOST_COMMAND_DELIVERY_LIMITS.bytes ||
    Number(c.biggest) > HOST_COMMAND_DELIVERY_LIMITS.rowBytes
  )
    fail("HOST_COMMAND_DELIVERY_LIMIT");
  const d = db
    .prepare(
      "SELECT count(*) n FROM session_documents WHERE kind GLOB 'host.command.delivery.*'",
    )
    .get()!;
  if (Number(d.n) > HOST_COMMAND_DELIVERY_LIMITS.deliveries)
    fail("HOST_COMMAND_DELIVERY_LIMIT");
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
  maximum = HOST_COMMAND_DELIVERY_LIMITS.anchorBytes,
): Record<string, unknown>[] {
  const hs = db
    .prepare(
      "SELECT seq,run_id,input_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND instr(data,?)>0 LIMIT 130",
    )
    .all(sessionId, type, discriminator);
  if (
    hs.length > 128 ||
    hs.reduce((n, h) => n + Number(h.bytes), 0) >
      HOST_COMMAND_DELIVERY_LIMITS.bytes
  )
    fail("HOST_COMMAND_DELIVERY_LIMIT");
  return hs.map((h) => {
    if (Number(h.bytes) < 1 || Number(h.bytes) > maximum)
      fail("HOST_COMMAND_DELIVERY_LIMIT");
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
    eventBodies(db, sessionId, "session.document.updated", sha).filter((e) => {
      const p = e.payload as Record<string, unknown>;
      return p?.kind === kind && p.revision === revision && p.sha256 === sha;
    }).length !== 1
  )
    fail("HOST_COMMAND_DELIVERY_DOCUMENT_INVALID");
}
function docBody(db: DatabaseSync, h: Header): unknown {
  if (
    !Number.isSafeInteger(h.revision) ||
    h.revision < 1 ||
    Number(h.bytes) < 1 ||
    Number(h.bytes) > HOST_COMMAND_DELIVERY_LIMITS.rowBytes
  )
    fail("HOST_COMMAND_DELIVERY_LIMIT");
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
): HostCommandDeliveryRecord | undefined {
  const hs = db
    .prepare(
      "SELECT seq,run_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type='host.command.result_admitted' AND input_id=? LIMIT 2",
    )
    .all(sessionId, inputId);
  if (hs.length > 1) fail("HOST_COMMAND_DELIVERY_ANCHOR_INVALID");
  if (!hs.length) return;
  const h = hs[0]!;
  if (
    Number(h.bytes) < 1 ||
    Number(h.bytes) > HOST_COMMAND_DELIVERY_LIMITS.anchorBytes
  )
    fail("HOST_COMMAND_DELIVERY_LIMIT");
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
    HOST_COMMAND_DELIVERY_LIMITS.anchorBytes,
  );
  const p = jobObject(
    e.payload,
    ["receipt"],
    [],
    HOST_COMMAND_DELIVERY_LIMITS.anchorBytes,
  );
  const r = validateHostCommandDeliveryRecord(p.receipt);
  if (
    e.schemaVersion !== 2 ||
    e.stream !== "session-v2" ||
    e.type !== "host.command.result_admitted" ||
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
    fail("HOST_COMMAND_DELIVERY_ANCHOR_INVALID");
  return r;
}
function sameBirth(
  r: HostCommandDeliveryRecord,
  birth: HostCommandDeliveryRecord,
): boolean {
  const {
    revision: _r,
    state: _s,
    updatedAt: _t,
    importArchiveSha256: _i,
    sha256: _h,
    ...body
  } = r;
  const {
    revision: _br,
    state: _bs,
    updatedAt: _bt,
    importArchiveSha256: _bi,
    sha256: _bh,
    ...birthBody
  } = birth;
  return same(body, birthBody);
}
function settledSql(db: DatabaseSync, r: HostCommandDeliveryRecord): void {
  const current = readHostCommand(db, r.workspaceId, r.jobId);
  if (!current || current.sessionId !== r.settled.sessionId)
    fail("HOST_COMMAND_DELIVERY_SOURCE_INVALID");
  const h = db
    .prepare(
      "SELECT length(CAST(data AS BLOB)) bytes FROM host_command_revisions WHERE id=? AND workspace_id=? AND job_id=?",
    )
    .get(r.settled.id, r.workspaceId, r.jobId);
  if (!h || Number(h.bytes) < 1 || Number(h.bytes) > 262144)
    fail("HOST_COMMAND_DELIVERY_SOURCE_INVALID");
  const raw = db
    .prepare(
      "SELECT data FROM host_command_revisions WHERE id=? AND length(CAST(data AS BLOB))=?",
    )
    .get(r.settled.id, h.bytes!);
  if (!raw) fail();
  const closed = validateHostCommandRecord(parsed(raw.data));
  if (
    !same(hostCommandSettlement(closed), r.settled) ||
    !same(current.owner, closed.owner) ||
    !same(current.preview, closed.preview) ||
    current.pid !== closed.pid ||
    closed.revision > current.revision ||
    closed.jobId !== current.jobId ||
    closed.workspaceId !== current.workspaceId ||
    closed.sessionId !== current.sessionId ||
    !same(current.completion, closed.completion)
  )
    fail("HOST_COMMAND_DELIVERY_SOURCE_INVALID");
}
function acceptedSql(db: DatabaseSync, r: HostCommandDeliveryRecord): void {
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
    Number(h.bytes) > HOST_COMMAND_DELIVERY_LIMITS.inputBytes
  )
    fail("HOST_COMMAND_DELIVERY_INPUT_INVALID");
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
    fail("HOST_COMMAND_DELIVERY_INPUT_INVALID");
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
    fail("HOST_COMMAND_DELIVERY_INPUT_INVALID");
  const hs = db
    .prepare(
      "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND input_id=? AND type='input.accepted' LIMIT 2",
    )
    .all(a.sessionId, a.inputId);
  if (
    hs.length !== 1 ||
    hs[0]!.seq !== a.admittedSeq ||
    Number(hs[0]!.bytes) > HOST_COMMAND_DELIVERY_LIMITS.inputBytes
  )
    fail("HOST_COMMAND_DELIVERY_INPUT_INVALID");
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
    fail("HOST_COMMAND_DELIVERY_INPUT_INVALID");
}
function readRecord(db: DatabaseSync, h: Header): HostCommandDeliveryRecord {
  const r = validateHostCommandDeliveryRecord(docBody(db, h));
  if (
    r.workspaceId !== h.workspace_id ||
    r.accepted.sessionId !== h.session_id ||
    r.revision !== h.revision ||
    h.kind !== hostCommandDeliveryKind(r.id)
  )
    fail();
  const birth = admission(db, h.session_id, r.accepted.inputId);
  if (!birth || !sameBirth(r, birth))
    fail("HOST_COMMAND_DELIVERY_ANCHOR_INVALID");
  if (r.state === "accepted" && !same(r, birth))
    fail("HOST_COMMAND_DELIVERY_ANCHOR_INVALID");
  const linkH = docHeader(
    db,
    r.workspaceId,
    hostCommandInputKind(r.accepted.inputId),
    h.session_id,
  );
  if (
    !linkH ||
    linkH.revision !== 1 ||
    !same(docBody(db, linkH), linkOf(birth))
  )
    fail("HOST_COMMAND_DELIVERY_LINK_INVALID");
  settledSql(db, r);
  acceptedSql(db, r);
  return r;
}
export function readHostCommandDelivery(
  db: DatabaseSync,
  workspaceId: string,
  deliveryId: string,
): HostCommandDeliveryRecord | undefined {
  jobIdentifier(workspaceId);
  jobIdentifier(deliveryId);
  caps(db);
  const h = docHeader(db, workspaceId, hostCommandDeliveryKind(deliveryId));
  const r = h ? readRecord(db, h) : undefined;
  if (r && r.id !== deliveryId) fail();
  return r;
}
export function readHostCommandDeliveries(
  db: DatabaseSync,
  workspaceId: string,
  sessionId?: string,
): readonly HostCommandDeliveryRecord[] {
  jobIdentifier(workspaceId);
  if (sessionId !== undefined) jobIdentifier(sessionId);
  caps(db);
  const hs = db
    .prepare(
      "SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) bytes,s.workspace_id FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE s.workspace_id=? AND d.kind GLOB 'host.command.delivery.*' AND (? IS NULL OR d.session_id=?) ORDER BY d.session_id,d.kind LIMIT 129",
    )
    .all(
      workspaceId,
      sessionId ?? null,
      sessionId ?? null,
    ) as unknown as Header[];
  if (hs.length > 128) fail("HOST_COMMAND_DELIVERY_LIMIT");
  return Object.freeze(hs.map((h) => readRecord(db, h)));
}
export function findHostCommandDeliveryForInput(
  db: DatabaseSync,
  value: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
    requestId: string;
  },
): HostCommandDeliveryRecord | null {
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
    hostCommandInputKind(String(x.inputId)),
    String(x.sessionId),
  );
  const birth = admission(db, String(x.sessionId), String(x.inputId));
  if (!h && !birth) {
    if (String(x.requestId).startsWith("host-command-result:"))
      fail("HOST_COMMAND_DELIVERY_LINK_INVALID");
    return null;
  }
  caps(db);
  if (!h || !birth || !same(docBody(db, h), linkOf(birth)))
    fail("HOST_COMMAND_DELIVERY_LINK_INVALID");
  const r = readHostCommandDelivery(db, String(x.workspaceId), birth.id);
  if (
    !r ||
    r.accepted.inputId !== x.inputId ||
    r.accepted.sessionId !== x.sessionId ||
    r.inputRequestId !== x.requestId
  )
    fail("HOST_COMMAND_DELIVERY_LINK_INVALID");
  return r;
}
export function validateHostCommandDeliveryDatabase(
  db: DatabaseSync,
  options: HostCommandDeliveryValidationOptions = {},
): void {
  caps(db);
  const hs = db
    .prepare(
      "SELECT session_id,input_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE type='host.command.result_admitted' ORDER BY session_id,seq LIMIT 129",
    )
    .all();
  if (
    hs.length > 128 ||
    hs.reduce((n, h) => n + Number(h.bytes), 0) >
      HOST_COMMAND_DELIVERY_LIMITS.bytes
  )
    fail("HOST_COMMAND_DELIVERY_LIMIT");
  let receipts = 0,
    links = 0;
  for (const h of hs) {
    options.check?.();
    if (
      !h.input_id ||
      Number(h.bytes) > HOST_COMMAND_DELIVERY_LIMITS.anchorBytes
    )
      fail("HOST_COMMAND_DELIVERY_ANCHOR_INVALID");
    const birth = admission(db, String(h.session_id), String(h.input_id));
    if (!birth || !readHostCommandDelivery(db, birth.workspaceId, birth.id))
      fail("HOST_COMMAND_DELIVERY_LINK_INVALID");
    receipts++;
    links++;
  }
  const ds = db
    .prepare(
      "SELECT sum(kind GLOB 'host.command.delivery.*') receipts,sum(kind GLOB 'host.command.input.*') links FROM session_documents WHERE kind GLOB 'host.command.delivery.*' OR kind GLOB 'host.command.input.*'",
    )
    .get()!;
  if (Number(ds.receipts ?? 0) !== receipts || Number(ds.links ?? 0) !== links)
    fail("HOST_COMMAND_DELIVERY_LINK_INVALID");
}
export function deliverHostCommandResultAtomic(
  db: DatabaseSync,
  original: object,
  value: HostCommandDeliveryInput,
  ports: HostCommandDeliveryPorts,
): HostCommandDeliveryResult {
  const x = inputData(value);
  if (!db.isTransaction) fail("HOST_COMMAND_DELIVERY_TRANSACTION_REQUIRED");
  caps(db);
  const previous = readHostCommandDeliveries(db, x.workspaceId).filter(
    (r) => r.requestId === x.requestId,
  );
  if (previous.length > 1) fail();
  if (previous.length) {
    if (previous[0]!.requestSha256 !== knowledgeHash(x))
      fail("REQUEST_ID_CONFLICT");
    return Object.freeze({ kind: "duplicate", record: previous[0]! });
  }
  if (
    !original ||
    typeof original !== "object" ||
    types.isProxy(original) ||
    types.isPromise(original)
  )
    fail("HOST_COMMAND_DELIVERY_ORIGINAL_REQUIRED");
  const proof = validateHostCommandDeliveryTargetProof(
    ports.readTargetOriginal(original),
  );
  if (
    proof.workspaceId !== x.workspaceId ||
    proof.jobId !== x.jobId ||
    proof.sha256 !== x.targetSha256
  )
    fail("HOST_COMMAND_DELIVERY_TARGET_INVALID");
  synchronous(ports.assertTarget(original, proof));
  const id = hostCommandDeliveryId(x.workspaceId, x.jobId, proof.jobSha256);
  if (readHostCommandDelivery(db, x.workspaceId, id))
    fail("REQUEST_ID_CONFLICT");
  const before = readHostCommand(db, x.workspaceId, x.jobId);
  if (!before || !same(hostCommandSettlement(before), proof.settled))
    fail("HOST_COMMAND_DELIVERY_STALE");
  const prompt = formatHostCommandJobResult(proof.settled, proof),
    inputRequestId = `host-command-result:${x.jobId}:${proof.jobSha256}`;
  const at = new Date().toISOString();
  // Reject metadata/output bounds before producing an actual input.
  jobJson(
    { proof, prompt, inputRequestId, requestId: x.requestId },
    HOST_COMMAND_DELIVERY_LIMITS.rowBytes,
  );
  const count = db
    .prepare(
      "SELECT count(*) n FROM session_documents WHERE kind GLOB 'host.command.delivery.*'",
    )
    .get()!;
  if (Number(count.n) >= 128) fail("HOST_COMMAND_DELIVERY_LIMIT");
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
    fail("HOST_COMMAND_DELIVERY_ORIGINAL_REQUIRED");
  try {
    const accepted = acceptedProof(ports.readAccepted(acceptedOriginal));
    const record = validateHostCommandDeliveryRecord(
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
        HOST_COMMAND_DELIVERY_LIMITS.rowBytes,
      ),
    );
    acceptedSql(db, record);
    settledSql(db, record);
    const payload = jobJson(
      { receipt: record },
      HOST_COMMAND_DELIVERY_LIMITS.anchorBytes,
    );
    synchronous(
      ports.appendEvent(
        accepted.sessionId,
        "host.command.result_admitted",
        payload as unknown as JsonObject,
        { inputId: accepted.inputId },
      ),
    );
    const saved = ports.writeDocument(
      accepted.sessionId,
      hostCommandDeliveryKind(id),
      0,
      record as unknown as JsonObject,
    );
    synchronous(saved);
    if (saved.revision !== 1 || !same(saved.data, record)) fail();
    const link = linkOf(record),
      linked = ports.writeDocument(
        accepted.sessionId,
        hostCommandInputKind(accepted.inputId),
        0,
        link as unknown as JsonObject,
      );
    synchronous(linked);
    if (linked.revision !== 1 || !same(linked.data, link)) fail();
    caps(db);
    const stored = readHostCommandDelivery(db, x.workspaceId, id);
    if (!stored || !same(stored, record)) fail();
    return Object.freeze({ kind: "accepted", record: stored });
  } finally {
    synchronous(ports.releaseAccepted(acceptedOriginal));
  }
}
export function pauseImportedHostCommandDeliveries(
  db: DatabaseSync,
  workspaceId: string,
  archiveSHA: string,
  options: HostCommandDeliveryControlOptions,
): number {
  jobIdentifier(workspaceId);
  jobSha256(archiveSHA);
  if (!db.isTransaction) fail("HOST_COMMAND_DELIVERY_TRANSACTION_REQUIRED");
  let count = 0;
  for (const before of readHostCommandDeliveries(db, workspaceId)) {
    if (before.state === "paused-import") continue;
    const at = new Date().toISOString();
    const { sha256: _sha, ...body } = before;
    const next = validateHostCommandDeliveryRecord(
      signJobData(
        {
          ...body,
          revision: 2 as const,
          state: "paused-import" as const,
          updatedAt: at,
          importArchiveSha256: archiveSHA,
        },
        HOST_COMMAND_DELIVERY_LIMITS.rowBytes,
      ),
    );
    const saved = options.writeDocument(
      before.accepted.sessionId,
      hostCommandDeliveryKind(before.id),
      1,
      next as unknown as JsonObject,
    );
    synchronous(saved);
    if (saved.revision !== 2 || !same(saved.data, next)) fail();
    count++;
  }
  validateHostCommandDeliveryDatabase(db);
  return count;
}
