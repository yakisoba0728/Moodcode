import type { DatabaseSync } from "node:sqlite";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import { knowledgeHash } from "../knowledge/validation.js";
import { requestIdentity } from "../storage/native-schema.js";
import { readBoundedBody } from "../storage/evidence-read.js";
import { validateQueueTarget } from "../runner/queue-target.js";
import type {
  JobAcceptedInputProof,
  JobDeliveryTargetProof,
} from "./delivery.js";
import type { JobOwnerProof, TerminalJobSourceProof } from "./types.js";
import {
  isCanonicalJobTime,
  jobJson,
  jobIdentifier,
  jobInteger,
  jobSha256,
  validateJobOwnerProof,
  validateTerminalJobSourceProof,
  validateTerminalClosedOutcomeProof,
  validateJobOutputPage,
  validateJobOutputCursor,
} from "./validation.js";
import { JOB_DELIVERY_STATES, JOB_STATES, fail } from "./reducer.js";
import type { JobRecord, NativeJobDelivery } from "./store.js";
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
  promptBytes: 32768,
});
const id = jobIdentifier,
  integer = jobInteger;
export function json<T>(value: T): T {
  return jobJson(value, JOB_STORAGE_LIMITS.rowBytes);
}
export function digest<T extends object>(value: T): T {
  const x = json(value) as T & { sha256: string };
  const { sha256, ...body } = x;
  jobSha256(sha256);
  if (knowledgeHash(body) !== sha256) fail();
  return x;
}
function stamp(value: unknown): string {
  if (!isCanonicalJobTime(value)) fail();
  return value;
}
export function ownerMatches(
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
export function targetProof(
  value: JobDeliveryTargetProof,
): JobDeliveryTargetProof {
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
export function acceptedProof(
  value: JobAcceptedInputProof,
): JobAcceptedInputProof {
  const x = digest(value);
  for (const k of [x.workspaceId, x.sessionId, x.inputId, x.requestId]) id(k);
  integer(x.admittedSeq);
  jobSha256(x.inputSha256);
  return x;
}
export function validateRecord(r: JobRecord): void {
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
      !JOB_STATES.includes(r.state)
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
    if (r.deliveryId !== r.entityId || !JOB_DELIVERY_STATES.includes(r.state))
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
      (typeof r.prompt !== "string" ||
        Buffer.byteLength(r.prompt) > JOB_STORAGE_LIMITS.promptBytes)
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
function acceptedSql(db: DatabaseSync, r: NativeJobDelivery): void {
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
export function proofSql(db: DatabaseSync, r: JobRecord): void {
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
