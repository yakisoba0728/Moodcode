import type { DatabaseSync } from "node:sqlite";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  jobJson,
  jobObject,
  jobIdentifier,
  jobSha256,
  signJobData,
} from "./validation.js";
import { readHostCommand } from "./host-command-records.js";

export const COMMAND_LIFETIME_PREFIX = "command.lifetime.";
export type CommandLifetimeMode = "foreground" | "background";
export interface CommandLifetimeOrigin {
  runId: string;
  toolCallId: string;
  turnId: string;
  attemptId: string;
  approvalId: string;
  approvalFingerprint: string;
  catalogueSha256: string;
  configSha256: string;
  inputSha256: string;
  profileSha256: string;
}
export interface CommandLifetimeRecord {
  version: 1;
  jobId: string;
  workspaceId: string;
  sessionId: string;
  revision: number;
  state: "starting" | "running" | "settled" | "uncertain" | "paused-import";
  mode: CommandLifetimeMode;
  rootEpoch: string;
  generation: number;
  hostPreviewSha256: string;
  origin: CommandLifetimeOrigin | null;
  physical: null | { supervisorPid: number; groupPid: number; epoch: string };
  stdinSeq: number;
  stdinBytes: number;
  stdinEof: boolean;
  transfers: number;
  completionSha256: string | null;
  operation: {
    kind:
      | "admit"
      | "started"
      | "transfer"
      | "input-intent"
      | "input-ack"
      | "closed"
      | "uncertain"
      | "recover"
      | "import";
    requestId: string;
    requestSha256: string;
    approved: boolean;
  };
  previousSha256: string | null;
  createdAt: string;
  updatedAt: string;
  sha256: string;
}
export function lifetimeKind(jobId: string): string {
  jobIdentifier(jobId);
  return COMMAND_LIFETIME_PREFIX + knowledgeHash(jobId).slice(0, 46);
}
function fail(): never {
  throw new EngineError(
    "COMMAND_LIFETIME_EVIDENCE_INVALID",
    "Command lifetime ownership or native evidence is invalid",
  );
}
export function validateCommandLifetimeRecord(
  value: unknown,
): CommandLifetimeRecord {
  const r = jobObject(
    value,
    [
      "version",
      "jobId",
      "workspaceId",
      "sessionId",
      "revision",
      "state",
      "mode",
      "rootEpoch",
      "generation",
      "hostPreviewSha256",
      "origin",
      "physical",
      "stdinSeq",
      "stdinBytes",
      "stdinEof",
      "transfers",
      "completionSha256",
      "operation",
      "previousSha256",
      "createdAt",
      "updatedAt",
      "sha256",
    ],
    [],
    16384,
  );
  if (
    r.version !== 1 ||
    !["starting", "running", "settled", "uncertain", "paused-import"].includes(
      String(r.state),
    ) ||
    !["foreground", "background"].includes(String(r.mode))
  )
    fail();
  for (const k of ["jobId", "workspaceId", "sessionId"]) jobIdentifier(r[k]);
  for (const k of ["rootEpoch", "hostPreviewSha256", "sha256"]) jobSha256(r[k]);
  for (const k of ["completionSha256", "previousSha256"])
    if (r[k] !== null) jobSha256(r[k]);
  for (const k of [
    "revision",
    "generation",
    "stdinSeq",
    "stdinBytes",
    "transfers",
  ])
    if (
      !Number.isSafeInteger(r[k]) ||
      Number(r[k]) < (k === "revision" || k === "generation" ? 1 : 0) ||
      Number(r[k]) >
        (k === "stdinBytes"
          ? 65536
          : k === "revision"
            ? 256
            : k === "transfers"
              ? 16
              : 64)
    )
      fail();
  if (typeof r.stdinEof !== "boolean") fail();
  for (const k of ["createdAt", "updatedAt"])
    if (
      typeof r[k] !== "string" ||
      new Date(r[k] as string).toISOString() !== r[k]
    )
      fail();
  const o = jobObject(r.operation, [
    "kind",
    "requestId",
    "requestSha256",
    "approved",
  ]);
  if (
    ![
      "admit",
      "started",
      "transfer",
      "input-intent",
      "input-ack",
      "closed",
      "uncertain",
      "recover",
      "import",
    ].includes(String(o.kind)) ||
    typeof o.approved !== "boolean"
  )
    fail();
  jobIdentifier(o.requestId);
  jobSha256(o.requestSha256);
  if (r.physical !== null) {
    const p = jobObject(r.physical, ["supervisorPid", "groupPid", "epoch"]);
    jobIdentifier(p.epoch);
    for (const k of ["supervisorPid", "groupPid"])
      if (!Number.isSafeInteger(p[k]) || Number(p[k]) < 1) fail();
  }
  if (r.origin !== null) {
    const p = jobObject(r.origin, [
      "runId",
      "toolCallId",
      "turnId",
      "attemptId",
      "approvalId",
      "approvalFingerprint",
      "catalogueSha256",
      "configSha256",
      "inputSha256",
      "profileSha256",
    ]);
    for (const k of [
      "runId",
      "toolCallId",
      "turnId",
      "attemptId",
      "approvalId",
    ])
      jobIdentifier(p[k]);
    for (const k of [
      "approvalFingerprint",
      "catalogueSha256",
      "configSha256",
      "inputSha256",
      "profileSha256",
    ])
      jobSha256(p[k]);
  }
  if (
    (r.state === "running" && r.physical === null) ||
    (r.state === "settled" && r.completionSha256 === null)
  )
    fail();
  const { sha256, ...body } = r;
  if (knowledgeHash(body) !== sha256) fail();
  return r as unknown as CommandLifetimeRecord;
}
export function readCommandLifetimes(
  db: DatabaseSync,
  workspaceId?: string,
): CommandLifetimeRecord[] {
  const cap = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM session_documents WHERE kind GLOB 'command.lifetime.*'",
    )
    .get()!;
  if (Number(cap.n) > 128 || Number(cap.bytes) > 2097152) fail();
  const rows = db
    .prepare(
      "SELECT d.session_id,d.revision,d.data,s.workspace_id,d.kind FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE d.kind GLOB 'command.lifetime.*'" +
        (workspaceId ? " AND s.workspace_id=?" : ""),
    )
    .all(...(workspaceId ? [workspaceId] : []));
  return rows.map((h) => {
    const r = validateCommandLifetimeRecord(JSON.parse(String(h.data)));
    if (
      r.sessionId !== h.session_id ||
      r.workspaceId !== h.workspace_id ||
      r.revision !== h.revision ||
      lifetimeKind(r.jobId) !== h.kind
    )
      fail();
    return r;
  });
}
export function validateCommandLifetimeDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  const bounds = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,coalesce(max(length(CAST(data AS BLOB))),0) largest FROM session_events WHERE type='command.lifetime.revision'",
    )
    .get()!;
  if (
    Number(bounds.n) > 4096 ||
    Number(bounds.bytes) > 33554432 ||
    Number(bounds.largest) > 20000
  )
    fail();
  for (const head of readCommandLifetimes(db)) {
    check();
    const events = db
      .prepare(
        "SELECT seq,data,run_id,turn_id,attempt_id,input_id FROM session_events WHERE session_id=? AND type='command.lifetime.revision' AND json_extract(data,'$.payload.record.jobId')=? ORDER BY seq LIMIT 257",
      )
      .all(head.sessionId, head.jobId);
    if (events.length < 1 || events.length > 256) fail();
    let previous: CommandLifetimeRecord | undefined;
    for (const h of events) {
      check();
      if (
        [h.run_id, h.turn_id, h.attempt_id, h.input_id].some((x) => x !== null)
      )
        fail();
      const event = JSON.parse(String(h.data));
      const r = validateCommandLifetimeRecord(event.payload.record);
      if (
        r.sessionId !== head.sessionId ||
        r.workspaceId !== head.workspaceId ||
        r.jobId !== head.jobId ||
        r.revision !== (previous?.revision ?? 0) + 1 ||
        r.previousSha256 !== (previous?.sha256 ?? null) ||
        event.sessionId !== r.sessionId ||
        event.seq !== h.seq ||
        event.type !== "command.lifetime.revision"
      )
        fail();
      if (previous) {
        if (
          ["settled", "paused-import"].includes(previous.state) &&
          r.state !== previous.state &&
          r.operation.kind !== "import"
        )
          fail();
        if (
          (r.mode !== previous.mode && r.operation.kind !== "transfer") ||
          (r.generation !== previous.generation &&
            r.operation.kind !== "transfer") ||
          (r.transfers !== previous.transfers &&
            r.operation.kind !== "transfer")
        )
          fail();
        if (
          previous.physical === null &&
          r.physical !== null &&
          r.operation.kind !== "started"
        )
          fail();
        if (r.operation.kind === "input-intent") {
          if (
            !r.operation.approved ||
            r.stdinSeq !== previous.stdinSeq + 1 ||
            r.stdinBytes - previous.stdinBytes > 16384 ||
            previous.stdinEof
          )
            fail();
        } else if (
          r.stdinSeq !== previous.stdinSeq ||
          r.stdinBytes !== previous.stdinBytes ||
          r.stdinEof !== previous.stdinEof
        )
          fail();
        if (
          r.operation.kind === "input-ack" &&
          (previous.operation.kind !== "input-intent" ||
            r.operation.requestId !== previous.operation.requestId ||
            r.operation.requestSha256 !== previous.operation.requestSha256 ||
            !r.operation.approved)
        )
          fail();
        if (
          r.operation.kind === "transfer" &&
          r.operation.requestSha256 !==
            knowledgeHash({
              fingerprint: knowledgeHash({
                record: previous.sha256,
                mode: r.mode,
                physical: previous.physical,
                epoch: previous.rootEpoch,
              }),
              approved: true,
            })
        )
          fail();
        for (const k of [
          "origin",
          "rootEpoch",
          "hostPreviewSha256",
          "createdAt",
        ] as const)
          if (knowledgeHash(r[k]) !== knowledgeHash(previous[k])) fail();
        if (
          r.physical &&
          previous.physical &&
          knowledgeHash(r.physical) !== knowledgeHash(previous.physical)
        )
          fail();
        if (
          r.stdinSeq < previous.stdinSeq ||
          r.stdinBytes < previous.stdinBytes ||
          (previous.stdinEof && !r.stdinEof) ||
          r.transfers < previous.transfers ||
          r.generation < previous.generation
        )
          fail();
        if (
          r.operation.kind === "transfer" &&
          (r.physical === null ||
            r.generation !== previous.generation + 1 ||
            r.transfers !== previous.transfers + 1 ||
            r.mode === previous.mode ||
            !r.operation.approved)
        )
          fail();
      } else if (
        r.state !== "starting" ||
        r.operation.kind !== "admit" ||
        r.physical !== null ||
        r.revision !== 1 ||
        r.generation !== 1
      )
        fail();
      previous = r;
    }
    if (previous?.sha256 !== head.sha256) fail();
    const host = readHostCommand(db, head.workspaceId, head.jobId);
    if (host) {
      if (
        host.sessionId !== head.sessionId ||
        knowledgeHash(host.preview) !== head.hostPreviewSha256 ||
        (head.physical && host.pid !== head.physical.groupPid)
      )
        fail();
      if (
        head.state === "settled" &&
        (!host.completion ||
          knowledgeHash(host.completion) !== head.completionSha256 ||
          !host.completion.outcome.cleanupConfirmed ||
          host.completion.observationFailure)
      )
        fail();
    } else if (
      head.state !== "uncertain" &&
      head.state !== "starting" &&
      head.state !== "paused-import"
    )
      fail();
    if (head.origin) {
      const o = head.origin,
        tool = db.prepare("SELECT * FROM tools WHERE id=?").get(o.toolCallId),
        approval = db
          .prepare("SELECT * FROM approvals WHERE id=?")
          .get(o.approvalId),
        run = db.prepare("SELECT * FROM runs WHERE id=?").get(o.runId),
        turn = db
          .prepare("SELECT * FROM session_turns WHERE id=?")
          .get(o.turnId),
        attempt = db
          .prepare("SELECT * FROM provider_attempts WHERE id=?")
          .get(o.attemptId);
      if (!tool || !approval || !run || !turn || !attempt) fail();
      const t = JSON.parse(String(tool.data)),
        a = JSON.parse(String(approval.data)),
        r = JSON.parse(String(run.data)),
        v = JSON.parse(String(turn.data)),
        p = JSON.parse(String(attempt.data));
      if (
        tool.run_id !== t.runId ||
        tool.session_id !== t.sessionId ||
        tool.state !== t.state ||
        approval.run_id !== a.runId ||
        approval.session_id !== a.sessionId ||
        approval.tool_call_id !== a.toolCallId ||
        approval.status !== a.status ||
        run.session_id !== r.sessionId ||
        run.workspace_id !== r.workspaceId ||
        run.state !== r.state ||
        turn.session_id !== v.sessionId ||
        turn.run_id !== v.runId ||
        turn.state !== v.state ||
        attempt.session_id !== p.sessionId ||
        attempt.run_id !== p.runId ||
        attempt.turn_id !== p.turnId ||
        attempt.state !== p.state
      )
        fail();
      const parts = db
        .prepare(
          "SELECT data,state FROM message_parts WHERE session_id=? AND run_id=? AND turn_id=? AND json_extract(data,'$.toolCallId')=? LIMIT 2",
        )
        .all(head.sessionId, o.runId, o.turnId, o.toolCallId);
      if (parts.length !== 1) fail();
      const part = JSON.parse(String(parts[0]!.data));
      if (
        part.type !== "tool" ||
        part.toolCallId !== o.toolCallId ||
        part.sessionId !== head.sessionId ||
        part.runId !== o.runId ||
        part.turnId !== o.turnId ||
        parts[0]!.state !== part.state ||
        !["running", "completed", "failed", "interrupted"].includes(t.state)
      )
        fail();
      if (
        t.name !== "run_command_job" ||
        t.runId !== o.runId ||
        t.sessionId !== head.sessionId ||
        knowledgeHash(t.input) !== o.inputSha256 ||
        a.status !== "allowed" ||
        a.toolCallId !== t.id ||
        a.runId !== r.id ||
        a.sessionId !== head.sessionId ||
        a.fingerprint !== o.approvalFingerprint ||
        a.toolName !== t.name ||
        r.workspaceId !== head.workspaceId ||
        r.sessionId !== head.sessionId ||
        knowledgeHash(r.config) !== o.configSha256 ||
        v.runId !== r.id ||
        p.turnId !== v.id
      )
        fail();
    }
  }
}
export function pauseCommandLifetimes(
  db: DatabaseSync,
  workspaceId: string,
  archiveSha: string,
  write: (r: CommandLifetimeRecord) => void,
): void {
  for (const r of readCommandLifetimes(db, workspaceId))
    if (r.state !== "paused-import")
      write(
        signJobData(
          {
            ...r,
            revision: r.revision + 1,
            previousSha256: r.sha256,
            state: "paused-import" as const,
            updatedAt: new Date().toISOString(),
            operation: {
              kind: "import" as const,
              requestId: archiveSha,
              requestSha256: archiveSha,
              approved: false,
            },
          },
          16384,
        ),
      );
}
