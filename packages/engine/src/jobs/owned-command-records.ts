import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { CommandArtifactDescriptor } from "../tools/command/observation.js";
import { validateCommandArtifactDescriptor } from "../tools/command/observation.js";
import type { ProcessOutcome } from "../tools/command/process-control.js";
import type { SessionDocument } from "../storage/native-records.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  jobJson,
  jobIdentifier,
  jobInteger,
  jobSha256,
  signJobData,
} from "./validation.js";

/** Descriptive pins; only the Root's original ToolContext grants producer authority. */
export interface OwnedCommandJobSource {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly toolCallId: string;
  readonly approvalId: string;
  readonly approvalFingerprint: string;
  readonly rootBindingSha256: string;
  readonly catalogueSha256: string;
  readonly ownerEpoch: string;
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly preparedFingerprint: string;
  readonly preparedSha256: string;
  readonly sha256: string;
}
export type OwnedCommandJobState =
  | "starting"
  | "running"
  | "settling"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain"
  | "paused-import";
export interface OwnedCommandCompletion {
  readonly outcome: ProcessOutcome;
  readonly stdout: CommandArtifactDescriptor;
  readonly stderr: CommandArtifactDescriptor;
  readonly checkpoint: {
    readonly id: string;
    readonly runId: string;
    readonly toolCallId: string;
    readonly kind: "command";
    readonly createdAt: string;
    readonly incomplete: boolean;
    readonly sha256: string;
  };
  readonly observationFailure?: string;
}
export interface OwnedCommandJobRecord {
  readonly version: 1;
  readonly jobId: string;
  readonly revision: number;
  readonly source: OwnedCommandJobSource;
  readonly state: OwnedCommandJobState;
  readonly groupPid: number | null;
  readonly completion: OwnedCommandCompletion | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface OwnedCommandJobWriteDocument {
  (
    sessionId: string,
    kind: string,
    expectedRevision: number,
    data: JsonObject,
  ): SessionDocument;
}
export interface OwnedCommandJobValidationOptions {
  readonly check?: () => void;
}
export interface OwnedCommandJobControlOptions {
  /** Native putSessionDocument in the caller's existing primary transaction. */
  readonly writeDocument: OwnedCommandJobWriteDocument;
  readonly now?: () => number;
}
export type OwnedCommandJobDatabase = DatabaseSync;

export const OWNED_COMMAND_JOB_LIMITS = Object.freeze({
  jobs: 128,
  bytes: 8_388_608,
  rowBytes: 65_536,
  nativeBytes: 8_388_608,
});
function fail(code = "OWNED_COMMAND_JOB_INVALID"): never {
  throw new EngineError(
    code,
    "Owned command job does not match its bounded native execution evidence",
  );
}
function parsed(raw: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(raw));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    return value as Record<string, unknown>;
  } catch {
    fail();
  }
}
const stamp = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail();
  return value;
};
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const o = value as Record<string, unknown>;
  if (
    Object.keys(o).some(
      (k) => !required.includes(k) && !optional.includes(k),
    ) ||
    required.some((k) => !Object.hasOwn(o, k))
  )
    fail();
  return o;
}
function digest(value: Record<string, unknown>): void {
  const { sha256, ...body } = value;
  jobSha256(sha256);
  if (knowledgeHash(body) !== sha256) fail();
}
export function ownedCommandJobId(source: {
  readonly runId: string;
  readonly toolCallId: string;
}): string {
  const value = jobJson(source);
  jobIdentifier(value.runId);
  jobIdentifier(value.toolCallId);
  return `command-${knowledgeHash({ runId: value.runId, toolCallId: value.toolCallId }).slice(0, 32)}`;
}
export function ownedCommandJobKind(jobId: string): string {
  jobIdentifier(jobId);
  return `command.job.${knowledgeHash(jobId).slice(0, 32)}`;
}
function source(value: unknown): OwnedCommandJobSource {
  const p = object(value, [
    "workspaceId",
    "sessionId",
    "runId",
    "turnId",
    "attemptId",
    "toolCallId",
    "approvalId",
    "approvalFingerprint",
    "rootBindingSha256",
    "catalogueSha256",
    "ownerEpoch",
    "command",
    "cwd",
    "timeoutMs",
    "preparedFingerprint",
    "preparedSha256",
    "sha256",
  ]);
  for (const k of [
    "workspaceId",
    "sessionId",
    "runId",
    "turnId",
    "attemptId",
    "toolCallId",
    "approvalId",
  ])
    jobIdentifier(p[k]);
  for (const k of [
    "approvalFingerprint",
    "rootBindingSha256",
    "catalogueSha256",
    "ownerEpoch",
    "preparedFingerprint",
    "preparedSha256",
  ])
    jobSha256(p[k]);
  if (
    typeof p.command !== "string" ||
    !p.command.trim() ||
    p.command.includes("\0") ||
    Buffer.byteLength(p.command) > 16_384 ||
    typeof p.cwd !== "string" ||
    !isAbsolute(p.cwd) ||
    p.cwd.includes("\0") ||
    Buffer.byteLength(p.cwd) > 8192 ||
    jobInteger(p.timeoutMs, 300_000) < 1
  )
    fail();
  digest(p);
  return p as unknown as OwnedCommandJobSource;
}
function completion(
  value: unknown,
  pin: OwnedCommandJobSource,
): OwnedCommandCompletion {
  const p = object(
    value,
    ["outcome", "stdout", "stderr", "checkpoint"],
    ["observationFailure"],
  );
  const o = object(
    p.outcome,
    [
      "exitCode",
      "signal",
      "cancelled",
      "timedOut",
      "cleanupConfirmed",
      "started",
    ],
    ["outputDiscarded", "error"],
  );
  if (
    o.exitCode !== null &&
    (!Number.isSafeInteger(o.exitCode) ||
      Math.abs(o.exitCode as number) > 2_147_483_647)
  )
    fail();
  if (
    o.signal !== null &&
    (typeof o.signal !== "string" || !/^SIG[A-Z0-9]+$/u.test(o.signal))
  )
    fail();
  for (const k of ["cancelled", "timedOut", "cleanupConfirmed", "started"])
    if (typeof o[k] !== "boolean") fail();
  if (
    Object.hasOwn(o, "outputDiscarded") &&
    typeof o.outputDiscarded !== "boolean"
  )
    fail();
  for (const [obj, k] of [
    [o, "error"],
    [p, "observationFailure"],
  ] as const)
    if (
      Object.hasOwn(obj, k) &&
      (typeof obj[k] !== "string" || Buffer.byteLength(obj[k] as string) > 4096)
    )
      fail();
  validateCommandArtifactDescriptor(p.stdout);
  validateCommandArtifactDescriptor(p.stderr);
  const c = object(p.checkpoint, [
    "id",
    "runId",
    "toolCallId",
    "kind",
    "createdAt",
    "incomplete",
    "sha256",
  ]);
  jobIdentifier(c.id);
  jobSha256(c.sha256);
  stamp(c.createdAt);
  if (
    c.runId !== pin.runId ||
    c.toolCallId !== pin.toolCallId ||
    c.kind !== "command" ||
    typeof c.incomplete !== "boolean"
  )
    fail();
  return p as unknown as OwnedCommandCompletion;
}
/** DATA validation does not hydrate a source handle or open an artifact path. */
export function validateOwnedCommandJob(value: unknown): OwnedCommandJobRecord {
  const p = object(jobJson(value, OWNED_COMMAND_JOB_LIMITS.rowBytes), [
    "version",
    "jobId",
    "revision",
    "source",
    "state",
    "groupPid",
    "completion",
    "errorCode",
    "createdAt",
    "updatedAt",
    "sha256",
  ]);
  if (
    p.version !== 1 ||
    jobInteger(p.revision) < 1 ||
    ![
      "starting",
      "running",
      "settling",
      "completed",
      "failed",
      "cancelled",
      "uncertain",
      "paused-import",
    ].includes(p.state as string)
  )
    fail();
  const s = source(p.source);
  if (
    p.jobId !== ownedCommandJobId({ runId: s.runId, toolCallId: s.toolCallId })
  )
    fail();
  stamp(p.createdAt);
  stamp(p.updatedAt);
  if (String(p.updatedAt) < String(p.createdAt)) fail();
  if (p.groupPid !== null && jobInteger(p.groupPid, 2_147_483_647) < 1) fail();
  if (p.state === "running" && p.groupPid === null) fail();
  if (p.completion !== null) completion(p.completion, s);
  if (
    ["starting", "running"].includes(p.state as string) &&
    p.completion !== null
  )
    fail();
  if (p.state === "settling" && p.completion === null) fail();
  if (["completed", "failed", "cancelled"].includes(p.state as string)) {
    if (!p.completion) fail();
    const c = p.completion as unknown as OwnedCommandCompletion;
    if (!c.outcome.cleanupConfirmed || c.observationFailure) fail();
    if (
      p.state === "completed" &&
      (c.outcome.exitCode !== 0 ||
        c.outcome.cancelled ||
        c.outcome.timedOut ||
        c.outcome.error)
    )
      fail();
    if (p.state === "cancelled" && !c.outcome.cancelled && !c.outcome.timedOut)
      fail();
  }
  if (p.errorCode !== null) jobIdentifier(p.errorCode);
  digest(p);
  return p as unknown as OwnedCommandJobRecord;
}
type NativeTable =
  | "tools"
  | "approvals"
  | "checkpoints"
  | "workspaces"
  | "session_turns"
  | "provider_attempts";
function nativeBody(
  db: DatabaseSync,
  table: NativeTable,
  id: string,
  max: number = OWNED_COMMAND_JOB_LIMITS.nativeBytes,
): Record<string, unknown> {
  const h = db
    .prepare(`SELECT length(CAST(data AS BLOB)) bytes FROM ${table} WHERE id=?`)
    .get(id);
  if (!h || Number(h.bytes) < 1 || Number(h.bytes) > max)
    fail("OWNED_COMMAND_SOURCE_INVALID");
  const row = db
    .prepare(
      `SELECT data FROM ${table} WHERE id=? AND length(CAST(data AS BLOB))=?`,
    )
    .get(id, h.bytes!);
  if (!row) fail();
  return parsed(row.data);
}
function events(
  db: DatabaseSync,
  table: "events" | "session_events",
  sessionId: string,
  type: string,
  discriminator: string,
): Record<string, unknown>[] {
  const hs = db
    .prepare(
      `SELECT seq,length(CAST(data AS BLOB)) bytes FROM ${table} WHERE session_id=? AND type=? AND instr(data,?)>0 LIMIT 130`,
    )
    .all(sessionId, type, discriminator);
  if (hs.length > 128) fail("OWNED_COMMAND_JOB_LIMIT");
  if (
    hs.reduce((sum, h) => sum + Number(h.bytes), 0) >
    OWNED_COMMAND_JOB_LIMITS.nativeBytes
  )
    fail("OWNED_COMMAND_JOB_LIMIT");
  return hs.map((h) => {
    if (
      Number(h.bytes) < 1 ||
      Number(h.bytes) > OWNED_COMMAND_JOB_LIMITS.nativeBytes
    )
      fail("OWNED_COMMAND_JOB_LIMIT");
    const r = db
      .prepare(
        `SELECT data FROM ${table} WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?`,
      )
      .get(sessionId, h.seq!, h.bytes!);
    if (!r) fail();
    return parsed(r.data);
  });
}
function sourceSql(
  db: DatabaseSync,
  r: OwnedCommandJobRecord,
): Record<string, unknown> {
  const s = r.source;
  const h = db
    .prepare("SELECT workspace_id,session_id FROM runs WHERE id=?")
    .get(s.runId);
  const session = db
    .prepare("SELECT workspace_id FROM sessions WHERE id=?")
    .get(s.sessionId);
  const toolHeader = db
    .prepare("SELECT session_id,run_id,state FROM tools WHERE id=?")
    .get(s.toolCallId);
  const turnHeader = db
    .prepare("SELECT session_id,run_id FROM session_turns WHERE id=?")
    .get(s.turnId);
  const attemptHeader = db
    .prepare(
      "SELECT session_id,run_id,turn_id FROM provider_attempts WHERE id=?",
    )
    .get(s.attemptId);
  const approvalHeader = db
    .prepare(
      "SELECT session_id,run_id,tool_call_id,status FROM approvals WHERE id=?",
    )
    .get(s.approvalId);
  if (
    !h ||
    h.workspace_id !== s.workspaceId ||
    h.session_id !== s.sessionId ||
    session?.workspace_id !== s.workspaceId ||
    toolHeader?.session_id !== s.sessionId ||
    toolHeader.run_id !== s.runId ||
    turnHeader?.session_id !== s.sessionId ||
    turnHeader.run_id !== s.runId ||
    attemptHeader?.session_id !== s.sessionId ||
    attemptHeader.run_id !== s.runId ||
    attemptHeader.turn_id !== s.turnId ||
    approvalHeader?.session_id !== s.sessionId ||
    approvalHeader.run_id !== s.runId ||
    approvalHeader.tool_call_id !== s.toolCallId ||
    approvalHeader.status !== "allowed"
  )
    fail("OWNED_COMMAND_SOURCE_INVALID");
  const tool = nativeBody(db, "tools", s.toolCallId),
    approval = nativeBody(db, "approvals", s.approvalId);
  const preview = approval.preview as Record<string, unknown>;
  if (
    tool.id !== s.toolCallId ||
    tool.runId !== s.runId ||
    tool.sessionId !== s.sessionId ||
    tool.name !== "run_command" ||
    tool.state !== toolHeader.state ||
    approval.id !== s.approvalId ||
    approval.runId !== s.runId ||
    approval.sessionId !== s.sessionId ||
    approval.toolCallId !== s.toolCallId ||
    approval.status !== "allowed" ||
    approval.toolName !== "run_command" ||
    approval.fingerprint !== s.approvalFingerprint ||
    !preview ||
    preview.command !== s.command ||
    preview.cwd !== s.cwd ||
    preview.timeoutMs !== s.timeoutMs ||
    preview.workspaceId !== s.workspaceId ||
    preview.runId !== s.runId ||
    preview.toolCallId !== s.toolCallId ||
    !(preview.platform === "win32"
      ? preview.termination === "windows-job-object"
      : ["darwin", "linux", "freebsd"].includes(preview.platform as string) && preview.termination === "posix-process-group")
  )
    fail("OWNED_COMMAND_SOURCE_INVALID");
  const turn = nativeBody(db, "session_turns", s.turnId),
    attempt = nativeBody(db, "provider_attempts", s.attemptId);
  if (
    turn.id !== s.turnId ||
    turn.runId !== s.runId ||
    turn.sessionId !== s.sessionId ||
    attempt.id !== s.attemptId ||
    attempt.turnId !== s.turnId ||
    attempt.runId !== s.runId ||
    attempt.sessionId !== s.sessionId
  )
    fail("OWNED_COMMAND_SOURCE_INVALID");
  const admitted = events(
    db,
    "session_events",
    s.sessionId,
    "command.job.source_admitted",
    s.sha256,
  );
  const admission = admitted.find(
    (e) =>
      e.runId === s.runId &&
      e.turnId === s.turnId &&
      e.attemptId === s.attemptId &&
      (e.payload as Record<string, unknown>)?.jobId === r.jobId &&
      knowledgeHash((e.payload as Record<string, unknown>).source) ===
        knowledgeHash(s),
  );
  if (!admission) fail("OWNED_COMMAND_SOURCE_INVALID");
  const processes = events(
    db,
    "session_events",
    s.sessionId,
    "command.job.process_admitted",
    s.sha256,
  ).filter(
    (e) =>
      e.runId === s.runId &&
      e.turnId === s.turnId &&
      e.attemptId === s.attemptId &&
      (e.payload as Record<string, unknown>)?.jobId === r.jobId &&
      (e.payload as Record<string, unknown>).sourceSha256 === s.sha256,
  );
  if (
    r.groupPid === null
      ? processes.length !== 0
      : processes.length !== 1 ||
        (processes[0]!.payload as Record<string, unknown>).groupPid !==
          r.groupPid
  )
    fail("OWNED_COMMAND_PROCESS_INVALID");
  const recordedRoot = (admission.payload as Record<string, unknown>)
    .workspaceRoot;
  const workspaceRoot =
    recordedRoot ?? nativeBody(db, "workspaces", s.workspaceId, 65_536).root;
  if (
    typeof workspaceRoot !== "string" ||
    !isAbsolute(workspaceRoot) ||
    workspaceRoot.includes("\0") ||
    Buffer.byteLength(workspaceRoot) > 8192
  )
    fail("OWNED_COMMAND_SOURCE_INVALID");
  const innerPreview = {
    command: s.command,
    cwd: s.cwd,
    timeoutMs: s.timeoutMs,
    workspaceId: s.workspaceId,
    runId: s.runId,
    toolCallId: s.toolCallId,
    platform: preview.platform,
    termination: preview.termination,
    ...(preview.sandbox?{sandbox:preview.sandbox}:{}),
  };
  const innerData = { workspaceRoot, sessionId: s.sessionId, ...(preview.sandbox?{sandbox:preview.sandbox}:{}) };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        name: "run_command",
        preview: innerPreview,
        data: innerData,
      }),
    )
    .digest("hex");
  if (
    s.preparedFingerprint !== fingerprint ||
    s.preparedSha256 !==
      knowledgeHash({
        name: "run_command",
        input: { command: s.command, cwd: s.cwd, timeoutMs: s.timeoutMs },
        fingerprint,
        requiresApproval: true,
        preview: innerPreview,
        data: innerData,
      })
  )
    fail("OWNED_COMMAND_SOURCE_INVALID");
  return tool;
}
/** Match the Tool event only after the original native close and terminal Part were verified. */
export function matchesOwnedCommandToolOutcome(
  db: DatabaseSync,
  r: OwnedCommandJobRecord,
  tool: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
): boolean {
  const c = r.completion;
  if (!c || !payload || payload.output !== tool.output) return false;
  if (payload.cleanupConfirmed === c.outcome.cleanupConfirmed) return true;
  if (
    r.state !== "cancelled" || tool.state !== "interrupted" ||
    Object.hasOwn(payload, "cleanupConfirmed") ||
    c.outcome.cleanupConfirmed !== true ||
    (!c.outcome.cancelled && !c.outcome.timedOut) || c.observationFailure ||
    payload.state !== "interrupted" || payload.name !== "run_command" ||
    typeof tool.error !== "string" || payload.error !== tool.error
  ) return false;
  const preview = nativeBody(db, "approvals", r.source.approvalId).preview as Record<string, unknown>;
  // Windows cancellation closes the Run's Tool before its independent command
  // join. That event omits the outcome; its absence cannot override false.
  return preview?.platform === "win32" && preview.termination === "windows-job-object";
}
function completionSql(
  db: DatabaseSync,
  r: OwnedCommandJobRecord,
  tool: Record<string, unknown>,
): void {
  const c = r.completion;
  if (!c) return;
  const closed = events(
    db,
    "session_events",
    r.source.sessionId,
    "command.job.closed_observed",
    knowledgeHash(c),
  );
  if (
    !closed.some(
      (e) =>
        e.runId === r.source.runId &&
        e.turnId === r.source.turnId &&
        e.attemptId === r.source.attemptId &&
        (e.payload as Record<string, unknown>)?.jobId === r.jobId &&
        (e.payload as Record<string, unknown>).sourceSha256 ===
          r.source.sha256 &&
        (e.payload as Record<string, unknown>).completionSha256 ===
          knowledgeHash(c),
    )
  )
    fail("OWNED_COMMAND_COMPLETION_INVALID");
  const checkpoint = nativeBody(db, "checkpoints", c.checkpoint.id);
  const checkpointHeader = db
    .prepare("SELECT run_id,tool_call_id FROM checkpoints WHERE id=?")
    .get(c.checkpoint.id);
  if (
    checkpoint.id !== c.checkpoint.id ||
    checkpointHeader?.run_id !== r.source.runId ||
    checkpointHeader.tool_call_id !== r.source.toolCallId ||
    checkpoint.runId !== r.source.runId ||
    checkpoint.toolCallId !== r.source.toolCallId ||
    checkpoint.kind !== "command" ||
    checkpoint.createdAt !== c.checkpoint.createdAt ||
    Boolean(checkpoint.incomplete) !== c.checkpoint.incomplete ||
    knowledgeHash(checkpoint) !== c.checkpoint.sha256
  )
    fail("OWNED_COMMAND_COMPLETION_INVALID");
  if (!["completed", "failed", "cancelled"].includes(r.state)) return;
  if (
    (r.state === "completed" && tool.state !== "completed") ||
    (r.state === "failed" && tool.state !== "failed") ||
    (r.state === "cancelled" &&
      !["failed", "interrupted"].includes(tool.state as string))
  )
    fail("OWNED_COMMAND_COMPLETION_INVALID");
  const hs = db
    .prepare(
      "SELECT id,state,length(CAST(data AS BLOB)) bytes FROM message_parts WHERE session_id=? AND run_id=? AND turn_id=? AND instr(data,?)>0 LIMIT 65",
    )
    .all(
      r.source.sessionId,
      r.source.runId,
      r.source.turnId,
      r.source.toolCallId,
    );
  if (hs.length > 64) fail("OWNED_COMMAND_JOB_LIMIT");
  if (
    hs.reduce((sum, h) => sum + Number(h.bytes), 0) >
    OWNED_COMMAND_JOB_LIMITS.nativeBytes
  )
    fail("OWNED_COMMAND_JOB_LIMIT");
  let matched = 0;
  for (const h of hs) {
    if (Number(h.bytes) > OWNED_COMMAND_JOB_LIMITS.nativeBytes)
      fail("OWNED_COMMAND_JOB_LIMIT");
    const row = db
      .prepare(
        "SELECT data FROM message_parts WHERE id=? AND length(CAST(data AS BLOB))=?",
      )
      .get(h.id!, h.bytes!);
    if (!row) fail();
    const p = parsed(row.data);
    if (p.type !== "tool" || p.toolCallId !== r.source.toolCallId) continue;
    if (
      p.runId !== r.source.runId ||
      p.turnId !== r.source.turnId ||
      p.sessionId !== r.source.sessionId ||
      p.name !== "run_command" ||
      p.id !== h.id ||
      knowledgeHash(p.input) !== knowledgeHash(tool.input) ||
      p.state !== h.state ||
      !["completed", "failed", "interrupted"].includes(p.state as string) ||
      (r.state === "completed" && p.state !== "completed") ||
      (p.result as Record<string, unknown>)?.output !== tool.output
    )
      fail("OWNED_COMMAND_COMPLETION_INVALID");
    matched++;
  }
  if (matched !== 1) fail("OWNED_COMMAND_COMPLETION_INVALID");
  const observed = events(
    db,
    "events",
    r.source.sessionId,
    `tool.${tool.state}`,
    r.source.toolCallId,
  );
  if (
    !observed.some(
      (e) => {
        const payload = e.payload as Record<string, unknown>;
        return e.runId === r.source.runId &&
          payload?.toolCallId === r.source.toolCallId &&
          matchesOwnedCommandToolOutcome(db, r, tool, payload);
      },
    )
  )
    fail("OWNED_COMMAND_COMPLETION_INVALID");
}
interface DocumentHeader {
  session_id: string;
  kind: string;
  revision: number;
  bytes: number;
  workspace_id: string;
}
function headers(db: DatabaseSync): DocumentHeader[] {
  const count = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM session_documents WHERE kind GLOB 'command.job.*'",
    )
    .get()!;
  if (
    Number(count.n) > OWNED_COMMAND_JOB_LIMITS.jobs ||
    Number(count.bytes) > OWNED_COMMAND_JOB_LIMITS.bytes
  )
    fail("OWNED_COMMAND_JOB_LIMIT");
  const hs = db
    .prepare(
      "SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) bytes,s.workspace_id FROM session_documents d LEFT JOIN sessions s ON s.id=d.session_id WHERE d.kind GLOB 'command.job.*' ORDER BY d.session_id,d.kind LIMIT 129",
    )
    .all() as unknown as DocumentHeader[];
  if (hs.length > 128) fail("OWNED_COMMAND_JOB_LIMIT");
  for (const h of hs)
    if (
      !h.workspace_id ||
      !Number.isSafeInteger(h.revision) ||
      h.revision < 1 ||
      Number(h.bytes) > OWNED_COMMAND_JOB_LIMITS.rowBytes
    )
      fail("OWNED_COMMAND_DOCUMENT_INVALID");
  return hs;
}
function read(db: DatabaseSync, h: DocumentHeader): OwnedCommandJobRecord {
  const row = db
    .prepare(
      "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND revision=? AND length(CAST(data AS BLOB))=?",
    )
    .get(h.session_id, h.kind, h.revision, h.bytes);
  if (!row) fail("OWNED_COMMAND_DOCUMENT_INVALID");
  const raw = String(row.data),
    r = validateOwnedCommandJob(parsed(raw));
  if (
    r.source.workspaceId !== h.workspace_id ||
    r.source.sessionId !== h.session_id ||
    r.revision !== h.revision ||
    h.kind !== ownedCommandJobKind(r.jobId)
  )
    fail("OWNED_COMMAND_DOCUMENT_INVALID");
  const sha = createHash("sha256").update(raw).digest("hex");
  const anchors = events(
    db,
    "session_events",
    h.session_id,
    "session.document.updated",
    sha,
  );
  if (
    anchors.filter(
      (e) =>
        (e.payload as Record<string, unknown>)?.kind === h.kind &&
        (e.payload as Record<string, unknown>).revision === h.revision &&
        (e.payload as Record<string, unknown>).sha256 === sha,
    ).length !== 1
  )
    fail("OWNED_COMMAND_DOCUMENT_INVALID");
  const tool = sourceSql(db, r);
  completionSql(db, r, tool);
  return r;
}
export function readOwnedCommandJobs(
  db: DatabaseSync,
  workspaceId: string,
  sessionId?: string,
): readonly OwnedCommandJobRecord[] {
  jobIdentifier(workspaceId);
  if (sessionId !== undefined) jobIdentifier(sessionId);
  return Object.freeze(
    headers(db)
      .filter(
        (h) =>
          h.workspace_id === workspaceId &&
          (sessionId === undefined || h.session_id === sessionId),
      )
      .map((h) => read(db, h)),
  );
}
export function readOwnedCommandJob(
  db: DatabaseSync,
  workspaceId: string,
  jobId: string,
): OwnedCommandJobRecord | undefined {
  jobIdentifier(jobId);
  jobIdentifier(workspaceId);
  const matched = headers(db).filter(
    (h) =>
      h.workspace_id === workspaceId && h.kind === ownedCommandJobKind(jobId),
  );
  if (matched.length > 1) fail("OWNED_COMMAND_DOCUMENT_INVALID");
  return matched.length ? read(db, matched[0]!) : undefined;
}
export function validateOwnedCommandJobDatabase(
  db: DatabaseSync,
  options: OwnedCommandJobValidationOptions = {},
): void {
  for (const h of headers(db)) {
    options.check?.();
    read(db, h);
  }
}
function control(
  db: DatabaseSync,
  workspaceId: string | undefined,
  state: "uncertain" | "paused-import",
  errorCode: string,
  options: OwnedCommandJobControlOptions,
): number {
  if (!db.isTransaction) fail("OWNED_COMMAND_TRANSACTION_REQUIRED");
  const hs = headers(db),
    records = hs
      .filter(
        (h) => workspaceId === undefined || h.workspace_id === workspaceId,
      )
      .map((h) => read(db, h));
  let changed = 0;
  for (const record of records) {
    if (
      state === "uncertain" &&
      !["starting", "running", "settling"].includes(record.state)
    )
      continue;
    if (state === "paused-import" && record.state === "paused-import") continue;
    const next = validateOwnedCommandJob(
      signJobData({
        ...record,
        revision: record.revision + 1,
        state,
        errorCode:
          state === "paused-import" &&
          ["starting", "running", "settling", "uncertain"].includes(
            record.state,
          )
            ? "COMMAND_JOB_CLEANUP_UNCERTAIN"
            : errorCode,
        updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      }),
    );
    const written = jobJson(
      options.writeDocument(
        record.source.sessionId,
        ownedCommandJobKind(record.jobId),
        record.revision,
        next as unknown as JsonObject,
      ),
      OWNED_COMMAND_JOB_LIMITS.rowBytes + 128,
    );
    if (
      written.revision !== next.revision ||
      knowledgeHash(written.data) !== knowledgeHash(next)
    )
      fail("OWNED_COMMAND_DOCUMENT_INVALID");
    changed++;
  }
  return changed;
}
export function pauseImportedOwnedCommandJobs(
  db: DatabaseSync,
  workspaceId: string,
  archiveSha256: string,
  options: OwnedCommandJobControlOptions,
): number {
  jobIdentifier(workspaceId);
  jobSha256(archiveSha256);
  return control(
    db,
    workspaceId,
    "paused-import",
    `IMPORTED_${archiveSha256.slice(0, 16)}`,
    options,
  );
}
export function recoverInterruptedOwnedCommandJobs(
  db: DatabaseSync,
  options: OwnedCommandJobControlOptions,
): number {
  return control(
    db,
    undefined,
    "uncertain",
    "OWNED_COMMAND_RESTART_UNCERTAIN",
    options,
  );
}
