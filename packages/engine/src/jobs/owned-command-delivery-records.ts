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
  ownedCommandJobKind,
  matchesOwnedCommandToolOutcome,
  readOwnedCommandJob,
  validateOwnedCommandJob,
  type OwnedCommandJobRecord,
} from "./owned-command-records.js";
import {
  validateOwnedCommandDeliveryTargetProof,
  formatOwnedCommandJobResult,
  type OwnedCommandDeliveryTargetProof,
} from "./owned-command-result.js";
import {
  isCanonicalJobTime,
  jobJson,
  jobObject,
  jobIdentifier,
  jobSha256,
  signJobData,
} from "./validation.js";

export interface OwnedCommandDeliveryInput {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly expectedRevision: 0;
  readonly targetSha256: string;
}
export interface OwnedCommandDeliveryRecord {
  readonly version: 1;
  readonly id: string;
  readonly revision: 1 | 2;
  readonly state: "accepted" | "paused-import";
  readonly workspaceId: string;
  readonly jobId: string;
  readonly settled: OwnedCommandJobRecord;
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
export type OwnedCommandDeliveryResult = {
  readonly kind: "accepted" | "duplicate";
  readonly record: OwnedCommandDeliveryRecord;
};
export interface OwnedCommandDeliveryPorts {
  readTargetOriginal(original: object): OwnedCommandDeliveryTargetProof;
  assertTarget(
    original: object,
    expected: OwnedCommandDeliveryTargetProof,
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
    type: "command.job.result_admitted",
    payload: JsonObject,
    refs: { inputId: string },
  ): unknown;
  readonly now?: () => number;
}
export interface OwnedCommandDeliveryControlOptions {
  writeDocument: OwnedCommandDeliveryPorts["writeDocument"];
  readonly now?: () => number;
}
export interface OwnedCommandDeliveryValidationOptions {
  readonly check?: () => void;
}
export const OWNED_COMMAND_DELIVERY_LIMITS = Object.freeze({
  deliveries: 128,
  documents: 256,
  bytes: 16_777_216,
  rowBytes: 131_072,
  anchorBytes: 196_608,
  inputBytes: 262_144,
});

function fail(code = "OWNED_COMMAND_DELIVERY_INVALID"): never {
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
  if (types.isPromise(value)) fail("OWNED_COMMAND_DELIVERY_ASYNC_PORT");
}
function inputData(value: unknown): OwnedCommandDeliveryInput {
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
  return p as unknown as OwnedCommandDeliveryInput;
}
export function ownedCommandDeliveryId(
  workspaceId: string,
  jobId: string,
  jobDigest: string,
): string {
  jobIdentifier(workspaceId);
  jobIdentifier(jobId);
  jobSha256(jobDigest);
  return knowledgeHash([
    "owned-command-result-v1",
    workspaceId,
    jobId,
    jobDigest,
  ]);
}
export function ownedCommandDeliveryKind(deliveryId: string): string {
  jobIdentifier(deliveryId);
  return `command.delivery.${knowledgeHash(deliveryId).slice(0, 32)}`;
}
export function ownedCommandInputKind(inputId: string): string {
  jobIdentifier(inputId);
  return `command.input.${knowledgeHash(inputId).slice(0, 32)}`;
}
function targetOf(
  r: OwnedCommandDeliveryRecord,
): OwnedCommandDeliveryTargetProof {
  return validateOwnedCommandDeliveryTargetProof({
    version: 1,
    workspaceId: r.workspaceId,
    jobId: r.jobId,
    jobSha256: r.settled.sha256,
    sourceSha256: r.settled.source.sha256,
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
    fail("OWNED_COMMAND_DELIVERY_INPUT_INVALID");
  return p as unknown as JobAcceptedInputProof;
}
export function validateOwnedCommandDeliveryRecord(
  value: unknown,
): OwnedCommandDeliveryRecord {
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
    OWNED_COMMAND_DELIVERY_LIMITS.rowBytes,
  );
  const r = p as unknown as OwnedCommandDeliveryRecord;
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
    settled = validateOwnedCommandJob(r.settled);
  if (
    r.id !== ownedCommandDeliveryId(r.workspaceId, r.jobId, settled.sha256) ||
    r.inputRequestId !== `owned-command-result:${r.jobId}:${settled.sha256}` ||
    r.prompt !== formatOwnedCommandJobResult(settled, proof) ||
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
  return jobJson(r, OWNED_COMMAND_DELIVERY_LIMITS.rowBytes);
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
function linkOf(r: OwnedCommandDeliveryRecord): Link {
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
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,coalesce(max(length(CAST(data AS BLOB))),0) biggest FROM session_documents WHERE kind GLOB 'command.delivery.*' OR kind GLOB 'command.input.*'",
    )
    .get()!;
  if (
    Number(c.n) > OWNED_COMMAND_DELIVERY_LIMITS.documents ||
    Number(c.bytes) > OWNED_COMMAND_DELIVERY_LIMITS.bytes ||
    Number(c.biggest) > OWNED_COMMAND_DELIVERY_LIMITS.rowBytes
  )
    fail("OWNED_COMMAND_DELIVERY_LIMIT");
  const d = db
    .prepare(
      "SELECT count(*) n FROM session_documents WHERE kind GLOB 'command.delivery.*'",
    )
    .get()!;
  if (Number(d.n) > OWNED_COMMAND_DELIVERY_LIMITS.deliveries)
    fail("OWNED_COMMAND_DELIVERY_LIMIT");
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
  maximum = OWNED_COMMAND_DELIVERY_LIMITS.anchorBytes,
): Record<string, unknown>[] {
  const hs = db
    .prepare(
      "SELECT seq,run_id,input_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND instr(data,?)>0 LIMIT 130",
    )
    .all(sessionId, type, discriminator);
  if (
    hs.length > 128 ||
    hs.reduce((n, h) => n + Number(h.bytes), 0) >
      OWNED_COMMAND_DELIVERY_LIMITS.bytes
  )
    fail("OWNED_COMMAND_DELIVERY_LIMIT");
  return hs.map((h) => {
    if (Number(h.bytes) < 1 || Number(h.bytes) > maximum)
      fail("OWNED_COMMAND_DELIVERY_LIMIT");
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
    fail("OWNED_COMMAND_DELIVERY_DOCUMENT_INVALID");
}
function docBody(db: DatabaseSync, h: Header): unknown {
  if (
    !Number.isSafeInteger(h.revision) ||
    h.revision < 1 ||
    Number(h.bytes) < 1 ||
    Number(h.bytes) > OWNED_COMMAND_DELIVERY_LIMITS.rowBytes
  )
    fail("OWNED_COMMAND_DELIVERY_LIMIT");
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
): OwnedCommandDeliveryRecord | undefined {
  const hs = db
    .prepare(
      "SELECT seq,run_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type='command.job.result_admitted' AND input_id=? LIMIT 2",
    )
    .all(sessionId, inputId);
  if (hs.length > 1) fail("OWNED_COMMAND_DELIVERY_ANCHOR_INVALID");
  if (!hs.length) return;
  const h = hs[0]!;
  if (
    Number(h.bytes) < 1 ||
    Number(h.bytes) > OWNED_COMMAND_DELIVERY_LIMITS.anchorBytes
  )
    fail("OWNED_COMMAND_DELIVERY_LIMIT");
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
    OWNED_COMMAND_DELIVERY_LIMITS.anchorBytes,
  );
  const p = jobObject(
    e.payload,
    ["receipt"],
    [],
    OWNED_COMMAND_DELIVERY_LIMITS.anchorBytes,
  );
  const r = validateOwnedCommandDeliveryRecord(p.receipt);
  if (
    e.schemaVersion !== 2 ||
    e.stream !== "session-v2" ||
    e.type !== "command.job.result_admitted" ||
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
    fail("OWNED_COMMAND_DELIVERY_ANCHOR_INVALID");
  return r;
}
function sameBirth(
  r: OwnedCommandDeliveryRecord,
  birth: OwnedCommandDeliveryRecord,
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
function settledSql(db: DatabaseSync, r: OwnedCommandDeliveryRecord): void {
  const saved = r.settled,
    source = saved.source;
  const run = db
    .prepare(
      "SELECT workspace_id,session_id,state,length(CAST(data AS BLOB)) bytes FROM runs WHERE id=?",
    )
    .get(source.runId);
  if (
    !run ||
    run.workspace_id !== source.workspaceId ||
    run.session_id !== source.sessionId ||
    !["completed", "failed", "cancelled", "interrupted"].includes(
      String(run.state),
    ) ||
    Number(run.bytes) < 1 ||
    Number(run.bytes) > 8_388_608
  )
    fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  const runRow = db
    .prepare(
      "SELECT data FROM runs WHERE id=? AND length(CAST(data AS BLOB))=?",
    )
    .get(source.runId, run.bytes!);
  if (!runRow) fail();
  const runBody = parsed(runRow.data) as Record<string, unknown>;
  if (
    runBody.id !== source.runId ||
    runBody.workspaceId !== run.workspace_id ||
    runBody.sessionId !== run.session_id ||
    runBody.state !== run.state
  )
    fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  const current = readOwnedCommandJob(db, r.workspaceId, r.jobId);
  if (
    !current ||
    !same(current.source, source) ||
    current.groupPid !== saved.groupPid ||
    !same(current.completion, saved.completion)
  )
    fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  documentAnchor(
    db,
    source.sessionId,
    ownedCommandJobKind(r.jobId),
    saved.revision,
    JSON.stringify(saved),
  );
  const toolH = db
    .prepare(
      "SELECT session_id,run_id,state,length(CAST(data AS BLOB)) bytes FROM tools WHERE id=?",
    )
    .get(source.toolCallId);
  if (
    !toolH ||
    toolH.session_id !== source.sessionId ||
    toolH.run_id !== source.runId ||
    Number(toolH.bytes) > 8_388_608
  )
    fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  const toolRow = db
    .prepare(
      "SELECT data FROM tools WHERE id=? AND length(CAST(data AS BLOB))=?",
    )
    .get(source.toolCallId, toolH.bytes!);
  if (!toolRow) fail();
  const tool = parsed(toolRow.data) as Record<string, unknown>;
  if (
    tool.state !== toolH.state ||
    (saved.state === "completed"
      ? tool.state !== "completed"
      : saved.state === "failed"
        ? tool.state !== "failed"
        : !["failed", "interrupted"].includes(String(tool.state)))
  )
    fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  const parts = db
    .prepare(
      "SELECT id,state,length(CAST(data AS BLOB)) bytes FROM message_parts WHERE session_id=? AND run_id=? AND turn_id=? AND instr(data,?)>0 LIMIT 65",
    )
    .all(source.sessionId, source.runId, source.turnId, source.toolCallId);
  if (
    parts.length > 64 ||
    parts.reduce((n, h) => n + Number(h.bytes), 0) > 8_388_608
  )
    fail("OWNED_COMMAND_DELIVERY_LIMIT");
  let matched = 0;
  for (const h of parts) {
    if (Number(h.bytes) > 8_388_608) fail("OWNED_COMMAND_DELIVERY_LIMIT");
    const row = db
      .prepare(
        "SELECT data FROM message_parts WHERE id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(h.id!, h.bytes!);
    if (!row) fail();
    const p = parsed(row.data) as Record<string, unknown>;
    if (p.type !== "tool" || p.toolCallId !== source.toolCallId) continue;
    if (
      p.sessionId !== source.sessionId ||
      p.runId !== source.runId ||
      p.turnId !== source.turnId ||
      p.name !== "run_command" ||
      p.state !== h.state ||
      !["completed", "failed", "interrupted"].includes(String(p.state)) ||
      (saved.state === "completed" && p.state !== "completed") ||
      !same(p.input, tool.input) ||
      (p.result as Record<string, unknown>)?.output !== tool.output
    )
      fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
    matched++;
  }
  if (matched !== 1) fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
  const closedHeaders = db
    .prepare(
      "SELECT seq,run_id,length(CAST(data AS BLOB)) bytes FROM events WHERE session_id=? AND type=? AND instr(data,?)>0 LIMIT 130",
    )
    .all(source.sessionId, `tool.${tool.state}`, source.toolCallId);
  if (
    closedHeaders.length > 128 ||
    closedHeaders.reduce((n, h) => n + Number(h.bytes), 0) > 8_388_608
  )
    fail("OWNED_COMMAND_DELIVERY_LIMIT");
  let observed = 0;
  for (const h of closedHeaders) {
    if (Number(h.bytes) < 1 || Number(h.bytes) > 8_388_608)
      fail("OWNED_COMMAND_DELIVERY_LIMIT");
    const row = db
      .prepare(
        "SELECT data FROM events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
      )
      .get(source.sessionId, h.seq!, h.bytes!);
    if (!row) fail();
    const e = parsed(row.data) as Record<string, unknown>,
      p = e.payload as Record<string, unknown>;
    if (
      e.sessionId !== source.sessionId ||
      e.seq !== h.seq ||
      e.runId !== h.run_id
    )
      fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
    if (
      e.runId === source.runId &&
      p?.toolCallId === source.toolCallId &&
      matchesOwnedCommandToolOutcome(db, saved, tool, p)
    )
      observed++;
  }
  if (observed !== 1) fail("OWNED_COMMAND_DELIVERY_SOURCE_INVALID");
}
function acceptedSql(db: DatabaseSync, r: OwnedCommandDeliveryRecord): void {
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
    Number(h.bytes) > OWNED_COMMAND_DELIVERY_LIMITS.inputBytes
  )
    fail("OWNED_COMMAND_DELIVERY_INPUT_INVALID");
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
    fail("OWNED_COMMAND_DELIVERY_INPUT_INVALID");
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
    fail("OWNED_COMMAND_DELIVERY_INPUT_INVALID");
  const hs = db
    .prepare(
      "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND input_id=? AND type='input.accepted' LIMIT 2",
    )
    .all(a.sessionId, a.inputId);
  if (
    hs.length !== 1 ||
    hs[0]!.seq !== a.admittedSeq ||
    Number(hs[0]!.bytes) > OWNED_COMMAND_DELIVERY_LIMITS.inputBytes
  )
    fail("OWNED_COMMAND_DELIVERY_INPUT_INVALID");
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
    fail("OWNED_COMMAND_DELIVERY_INPUT_INVALID");
}
function readRecord(db: DatabaseSync, h: Header): OwnedCommandDeliveryRecord {
  const r = validateOwnedCommandDeliveryRecord(docBody(db, h));
  if (
    r.workspaceId !== h.workspace_id ||
    r.accepted.sessionId !== h.session_id ||
    r.revision !== h.revision ||
    h.kind !== ownedCommandDeliveryKind(r.id)
  )
    fail();
  const birth = admission(db, h.session_id, r.accepted.inputId);
  if (!birth || !sameBirth(r, birth))
    fail("OWNED_COMMAND_DELIVERY_ANCHOR_INVALID");
  if (r.state === "accepted" && !same(r, birth))
    fail("OWNED_COMMAND_DELIVERY_ANCHOR_INVALID");
  const linkH = docHeader(
    db,
    r.workspaceId,
    ownedCommandInputKind(r.accepted.inputId),
    h.session_id,
  );
  if (
    !linkH ||
    linkH.revision !== 1 ||
    !same(docBody(db, linkH), linkOf(birth))
  )
    fail("OWNED_COMMAND_DELIVERY_LINK_INVALID");
  settledSql(db, r);
  acceptedSql(db, r);
  return r;
}
export function readOwnedCommandDelivery(
  db: DatabaseSync,
  workspaceId: string,
  deliveryId: string,
): OwnedCommandDeliveryRecord | undefined {
  jobIdentifier(workspaceId);
  jobIdentifier(deliveryId);
  caps(db);
  const h = docHeader(db, workspaceId, ownedCommandDeliveryKind(deliveryId));
  const r = h ? readRecord(db, h) : undefined;
  if (r && r.id !== deliveryId) fail();
  return r;
}
export function readOwnedCommandDeliveries(
  db: DatabaseSync,
  workspaceId: string,
  sessionId?: string,
): readonly OwnedCommandDeliveryRecord[] {
  jobIdentifier(workspaceId);
  if (sessionId !== undefined) jobIdentifier(sessionId);
  caps(db);
  const hs = db
    .prepare(
      "SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) bytes,s.workspace_id FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE s.workspace_id=? AND d.kind GLOB 'command.delivery.*' AND (? IS NULL OR d.session_id=?) ORDER BY d.session_id,d.kind LIMIT 129",
    )
    .all(
      workspaceId,
      sessionId ?? null,
      sessionId ?? null,
    ) as unknown as Header[];
  if (hs.length > 128) fail("OWNED_COMMAND_DELIVERY_LIMIT");
  return Object.freeze(hs.map((h) => readRecord(db, h)));
}
export function findOwnedCommandDeliveryForInput(
  db: DatabaseSync,
  value: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
    requestId: string;
  },
): OwnedCommandDeliveryRecord | null {
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
    ownedCommandInputKind(String(x.inputId)),
    String(x.sessionId),
  );
  const birth = admission(db, String(x.sessionId), String(x.inputId));
  if (!h && !birth) {
    if (String(x.requestId).startsWith("owned-command-result:"))
      fail("OWNED_COMMAND_DELIVERY_LINK_INVALID");
    return null;
  }
  caps(db);
  if (!h || !birth || !same(docBody(db, h), linkOf(birth)))
    fail("OWNED_COMMAND_DELIVERY_LINK_INVALID");
  const r = readOwnedCommandDelivery(db, String(x.workspaceId), birth.id);
  if (
    !r ||
    r.accepted.inputId !== x.inputId ||
    r.accepted.sessionId !== x.sessionId ||
    r.inputRequestId !== x.requestId
  )
    fail("OWNED_COMMAND_DELIVERY_LINK_INVALID");
  return r;
}
export function validateOwnedCommandDeliveryDatabase(
  db: DatabaseSync,
  options: OwnedCommandDeliveryValidationOptions = {},
): void {
  caps(db);
  const hs = db
    .prepare(
      "SELECT session_id,input_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE type='command.job.result_admitted' ORDER BY session_id,seq LIMIT 129",
    )
    .all();
  if (
    hs.length > 128 ||
    hs.reduce((n, h) => n + Number(h.bytes), 0) >
      OWNED_COMMAND_DELIVERY_LIMITS.bytes
  )
    fail("OWNED_COMMAND_DELIVERY_LIMIT");
  let receipts = 0,
    links = 0;
  for (const h of hs) {
    options.check?.();
    if (
      !h.input_id ||
      Number(h.bytes) > OWNED_COMMAND_DELIVERY_LIMITS.anchorBytes
    )
      fail("OWNED_COMMAND_DELIVERY_ANCHOR_INVALID");
    const birth = admission(db, String(h.session_id), String(h.input_id));
    if (!birth || !readOwnedCommandDelivery(db, birth.workspaceId, birth.id))
      fail("OWNED_COMMAND_DELIVERY_LINK_INVALID");
    receipts++;
    links++;
  }
  const ds = db
    .prepare(
      "SELECT sum(kind GLOB 'command.delivery.*') receipts,sum(kind GLOB 'command.input.*') links FROM session_documents WHERE kind GLOB 'command.delivery.*' OR kind GLOB 'command.input.*'",
    )
    .get()!;
  if (Number(ds.receipts ?? 0) !== receipts || Number(ds.links ?? 0) !== links)
    fail("OWNED_COMMAND_DELIVERY_LINK_INVALID");
}
export function deliverOwnedCommandResultAtomic(
  db: DatabaseSync,
  original: object,
  value: OwnedCommandDeliveryInput,
  ports: OwnedCommandDeliveryPorts,
): OwnedCommandDeliveryResult {
  const x = inputData(value);
  if (!db.isTransaction) fail("OWNED_COMMAND_DELIVERY_TRANSACTION_REQUIRED");
  caps(db);
  const previous = readOwnedCommandDeliveries(db, x.workspaceId).filter(
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
    fail("OWNED_COMMAND_DELIVERY_ORIGINAL_REQUIRED");
  const proof = validateOwnedCommandDeliveryTargetProof(
    ports.readTargetOriginal(original),
  );
  if (
    proof.workspaceId !== x.workspaceId ||
    proof.jobId !== x.jobId ||
    proof.sha256 !== x.targetSha256
  )
    fail("OWNED_COMMAND_DELIVERY_TARGET_INVALID");
  synchronous(ports.assertTarget(original, proof));
  const id = ownedCommandDeliveryId(x.workspaceId, x.jobId, proof.jobSha256);
  if (readOwnedCommandDelivery(db, x.workspaceId, id))
    fail("REQUEST_ID_CONFLICT");
  const before = readOwnedCommandJob(db, x.workspaceId, x.jobId);
  if (!before || !same(before, proof.settled))
    fail("OWNED_COMMAND_DELIVERY_STALE");
  const prompt = formatOwnedCommandJobResult(proof.settled, proof),
    inputRequestId = `owned-command-result:${x.jobId}:${proof.jobSha256}`;
  const at = new Date(ports.now?.() ?? Date.now()).toISOString();
  // Reject metadata/output bounds before producing an actual input.
  jobJson(
    { proof, prompt, inputRequestId, requestId: x.requestId },
    OWNED_COMMAND_DELIVERY_LIMITS.rowBytes,
  );
  const count = db
    .prepare(
      "SELECT count(*) n FROM session_documents WHERE kind GLOB 'command.delivery.*'",
    )
    .get()!;
  if (Number(count.n) >= 128) fail("OWNED_COMMAND_DELIVERY_LIMIT");
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
    fail("OWNED_COMMAND_DELIVERY_ORIGINAL_REQUIRED");
  try {
    const accepted = acceptedProof(ports.readAccepted(acceptedOriginal));
    const record = validateOwnedCommandDeliveryRecord(
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
        OWNED_COMMAND_DELIVERY_LIMITS.rowBytes,
      ),
    );
    acceptedSql(db, record);
    settledSql(db, record);
    const payload = jobJson(
      { receipt: record },
      OWNED_COMMAND_DELIVERY_LIMITS.anchorBytes,
    );
    synchronous(
      ports.appendEvent(
        accepted.sessionId,
        "command.job.result_admitted",
        payload as unknown as JsonObject,
        { inputId: accepted.inputId },
      ),
    );
    const saved = ports.writeDocument(
      accepted.sessionId,
      ownedCommandDeliveryKind(id),
      0,
      record as unknown as JsonObject,
    );
    synchronous(saved);
    if (saved.revision !== 1 || !same(saved.data, record)) fail();
    const link = linkOf(record),
      linked = ports.writeDocument(
        accepted.sessionId,
        ownedCommandInputKind(accepted.inputId),
        0,
        link as unknown as JsonObject,
      );
    synchronous(linked);
    if (linked.revision !== 1 || !same(linked.data, link)) fail();
    caps(db);
    const stored = readOwnedCommandDelivery(db, x.workspaceId, id);
    if (!stored || !same(stored, record)) fail();
    return Object.freeze({ kind: "accepted", record: stored });
  } finally {
    synchronous(ports.releaseAccepted(acceptedOriginal));
  }
}
export function pauseImportedOwnedCommandDeliveries(
  db: DatabaseSync,
  workspaceId: string,
  archiveSHA: string,
  options: OwnedCommandDeliveryControlOptions,
): number {
  jobIdentifier(workspaceId);
  jobSha256(archiveSHA);
  if (!db.isTransaction) fail("OWNED_COMMAND_DELIVERY_TRANSACTION_REQUIRED");
  let count = 0;
  for (const before of readOwnedCommandDeliveries(db, workspaceId)) {
    if (before.state === "paused-import") continue;
    const at = new Date(options.now?.() ?? Date.now()).toISOString();
    const { sha256: _sha, ...body } = before;
    const next = validateOwnedCommandDeliveryRecord(
      signJobData(
        {
          ...body,
          revision: 2 as const,
          state: "paused-import" as const,
          updatedAt: at,
          importArchiveSha256: archiveSHA,
        },
        OWNED_COMMAND_DELIVERY_LIMITS.rowBytes,
      ),
    );
    const saved = options.writeDocument(
      before.accepted.sessionId,
      ownedCommandDeliveryKind(before.id),
      1,
      next as unknown as JsonObject,
    );
    synchronous(saved);
    if (saved.revision !== 2 || !same(saved.data, next)) fail();
    count++;
  }
  validateOwnedCommandDeliveryDatabase(db);
  return count;
}
