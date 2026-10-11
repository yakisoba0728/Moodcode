import {
  ownedCommandJobId,
  readOwnedCommandJob,
} from "../jobs/owned-command-records.js";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { JsonObject } from "@moodcode/contracts";
import {
  immutableKnowledgeJson as json,
  knowledgeHash,
} from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";
import { readBoundedBody } from "../storage/evidence-read.js";
import {
  createRevisionJournal,
  type RevisionJournal,
  type RevisionJournalProfile,
} from "../storage/revision-journal.js";
import type { AgentBackendSpec } from "./types.js";
import {
  clientEffectToolName,
  clientReadToolInput,
  terminalCommandLine,
  workspaceLocalPath,
  type BackendClientReadProof,
  type BackendClientPermissionProof,
} from "./client-effects.js";
import {
  assertBackendTransition,
  SETTLED_EFFECT_STATES,
  SETTLED_REQUEST_STATES,
  type BackendJournalKind,
} from "./reducer.js";
import { validateAcpV1Message } from "./protocol.js";
import {
  AGENT_BACKEND_STORAGE_LIMITS,
  fail,
  prepareSignedBackendRevision,
  isObject,
  resultObject,
  digest,
  id,
  sha,
  integer,
  state,
  ownerOf,
  recoverable,
  pausable,
  bodyOf,
  effectRpc,
  nativeExitStatus,
  validatePermissionResponse,
  validateEffectResponse,
  validateBody,
  validateTransition,
  type BackendTurnProof,
  type BackendTargetProof,
  type BackendRevisionBase,
  type AgentBackendRevision,
  type BackendConnectionRevision,
  type BackendRemoteRequest,
  type BackendClientEffectRevision,
  type AgentBackendRecord,
  type BackendTransitionReceipt,
  type BackendTerminalControl,
} from "./journal.js";
/** Wall-clock time clamped to the newest head, because the validator orders revisions by createdAt. */
export function backendClock(db: DatabaseSync, now: number): string {
  const at = new Date(integer(now, 8640000000000000)).toISOString(),
    last = db
      .prepare(
        "SELECT max(json_extract(r.data,'$.createdAt')) at FROM backend_heads h JOIN backend_revisions r ON r.id=h.revision_id",
      )
      .get()?.at;
  return typeof last === "string" && last > at ? last : at;
}
/** Index columns of a revision row; the receipt row of a backend revision has no session. */
function revisionColumns(r: AgentBackendRecord, receipt: boolean) {
  const o = ownerOf(r);
  return {
    session_id:
      o?.sessionId ??
      (!receipt && r.kind === "backend" ? r.spec.target.sessionId : null),
    run_id: o?.runId ?? null,
    turn_id: o?.turnId ?? null,
    attempt_id: o?.attemptId ?? null,
    tool_id:
      r.kind === "client-effect" ? (r.completion?.toolCallId ?? null) : null,
    connection_id: r.kind === "backend" ? null : r.connectionId,
    owner_epoch: o?.ownerEpoch ?? null,
  };
}
const BACKEND_JOURNAL: RevisionJournalProfile<
  BackendJournalKind,
  AgentBackendRecord
> = {
  revisions: "backend_revisions",
  heads: "backend_heads",
  columns: [
    "session_id",
    "run_id",
    "turn_id",
    "attempt_id",
    "tool_id",
    "connection_id",
    "owner_epoch",
  ],
  limits: {
    rowBytes: AGENT_BACKEND_STORAGE_LIMITS.rowBytes,
    rows: AGENT_BACKEND_STORAGE_LIMITS.rows,
    bytes: AGENT_BACKEND_STORAGE_LIMITS.bytes,
    kinds: {
      backend: AGENT_BACKEND_STORAGE_LIMITS.backends,
      connection: AGENT_BACKEND_STORAGE_LIMITS.connections,
      request: AGENT_BACKEND_STORAGE_LIMITS.requests,
      "client-effect": AGENT_BACKEND_STORAGE_LIMITS.effects,
    },
  },
  index: revisionColumns,
  scope(kind, entityId, operation) {
    const record = `${kind}:${entityId}:${operation}`;
    return { record, receipt: `receipt:${record}` };
  },
  receiptPrevious: () => null,
  identifier: id,
  sealed: digest,
  verify(record, db) {
    validateBody(record);
    validateOwnerSql(db, record);
  },
  fail,
  codes: {
    limit: "BACKEND_LIMIT",
    revisionConflict: "BACKEND_REVISION_CONFLICT",
    requestConflict: "BACKEND_REQUEST_CONFLICT",
  },
};
export type BackendJournal = RevisionJournal<
  BackendJournalKind,
  AgentBackendRecord,
  BackendTransitionReceipt
>;
export function backendJournal(
  db: DatabaseSync,
  profile = BACKEND_JOURNAL,
): BackendJournal {
  return createRevisionJournal<
    BackendJournalKind,
    AgentBackendRecord,
    BackendTransitionReceipt
  >(db, profile);
}
function readPrimary(
  db: DatabaseSync,
  table:
    | "runs"
    | "checkpoints"
    | "workspaces"
    | "sessions"
    | "session_turns"
    | "provider_attempts"
    | "tools"
    | "message_parts"
    | "approvals",
  key: string,
  maxBytes = 262144,
): Record<string, unknown> {
  const header = db
    .prepare(`SELECT length(CAST(data AS BLOB)) bytes FROM ${table} WHERE id=?`)
    .get(id(key));
  if (!header || Number(header.bytes) > maxBytes) fail();
  const body = db
    .prepare(
      `SELECT data FROM ${table} WHERE id=? AND length(CAST(data AS BLOB))=?`,
    )
    .get(key, Number(header.bytes));
  if (!body) fail();
  const result = JSON.parse(String(body.data));
  if (!isObject(result) || result.id !== key) fail();
  return result;
}
export function validateSessionLoadSourceSql(
  db: DatabaseSync,
  spec: AgentBackendSpec,
  target: BackendTargetProof,
):
  | {
      backend: AgentBackendRevision;
      request: BackendRemoteRequest;
      connection: BackendConnectionRevision;
    }
  | undefined {
  const load = spec.sessionLoad;
  if (!load) return;
  function revision<T extends AgentBackendRecord>(
    rid: string,
    kind: BackendJournalKind,
  ): T {
    const h = db
      .prepare(
        "SELECT workspace_id,kind,sha256,length(CAST(data AS BLOB)) bytes FROM backend_revisions WHERE id=?",
      )
      .get(id(rid));
    if (
      !h ||
      h.workspace_id !== spec.target.workspaceId ||
      h.kind !== kind ||
      Number(h.bytes) > AGENT_BACKEND_STORAGE_LIMITS.rowBytes
    )
      fail("BACKEND_LOAD_SOURCE_INVALID");
    const invalid = () => fail("BACKEND_LOAD_SOURCE_INVALID");
    const raw =
      readBoundedBody(
        db,
        { table: "backend_revisions", where: "id=?", params: [rid] },
        Number(h.bytes),
        invalid,
      ) ?? invalid();
    const r = json(JSON.parse(raw)) as unknown as T;
    validateBody(r);
    validateOwnerSql(db, r);
    if (
      r.id !== rid ||
      r.sha256 !== h.sha256 ||
      r.workspaceId !== spec.target.workspaceId
    )
      fail("BACKEND_LOAD_SOURCE_INVALID");
    return r;
  }
  const backend = revision<AgentBackendRevision>(
      load.sourceBackendRevisionId,
      "backend",
    ),
    request = revision<BackendRemoteRequest>(
      load.sourceRequestRevisionId,
      "request",
    ),
    connection = revision<BackendConnectionRevision>(
      load.sourceConnectionRevisionId,
      "connection",
    );
  const run = readPrimary(db, "runs", request.owner.runId);
  const header = db
    .prepare("SELECT workspace_id,session_id,state FROM runs WHERE id=?")
    .get(request.owner.runId);
  const oldConfig = {
    ...spec.target.config,
    providerId: backend.spec.target.config.providerId,
  };
  if (
    backend.backendId !== load.sourceBackendId ||
    !backend.enabled ||
    backend.spec.contextOwner !== "engine" ||
    backend.spec.sessionLoad ||
    request.remoteRequestId !== load.sourceRequestId ||
    request.sha256 !== load.sourceRequestSha256 ||
    request.state !== "completed" ||
    connection.connectionId !== load.sourceConnectionId ||
    connection.sha256 !== load.sourceConnectionSha256 ||
    connection.state !== "closed" ||
    connection.disposal?.cleanupConfirmed !== true ||
    request.backendRevisionId !== backend.id ||
    connection.backendRevisionId !== backend.id ||
    request.connectionId !== connection.connectionId ||
    request.epoch !== connection.proof.epoch ||
    request.owner.sha256 !== connection.proof.ownerSha256 ||
    request.remoteSessionId !== load.remoteSessionId ||
    connection.remoteSessionId !== load.remoteSessionId ||
    backend.spec.target.sessionId !== spec.target.sessionId ||
    request.owner.sessionId !== spec.target.sessionId ||
    backend.spec.launch.cwd !== spec.launch.cwd ||
    knowledgeHash(backend.spec.launch) !== knowledgeHash(spec.launch) ||
    knowledgeHash(backend.spec.credentialReference) !==
      knowledgeHash(spec.credentialReference) ||
    backend.spec.endpointAudience !== spec.endpointAudience ||
    knowledgeHash(backend.spec.target.config) !== knowledgeHash(oldConfig) ||
    knowledgeHash(backend.spec.target.profile) !==
      knowledgeHash(spec.target.profile) ||
    backend.spec.target.workspaceBindingSha256 !==
      spec.target.workspaceBindingSha256 ||
    backend.spec.target.catalogueSha256 !== spec.target.catalogueSha256 ||
    knowledgeHash(backend.spec.target.tools) !==
      knowledgeHash(spec.target.tools) ||
    !header ||
    header.state !== "completed" ||
    run.state !== header.state ||
    header.workspace_id !== spec.target.workspaceId ||
    header.session_id !== spec.target.sessionId
  )
    fail("BACKEND_LOAD_SOURCE_INVALID");
  function manifest(value: string | undefined): JsonObject {
    if (typeof value !== "string" || Buffer.byteLength(value) > 32768)
      fail("BACKEND_LOAD_SOURCE_INVALID");
    return json(JSON.parse(value)) as JsonObject;
  }
  const old = manifest(backend.target.capabilitiesManifest),
    current = manifest(target.capabilitiesManifest);
  if (
    knowledgeHash(old) !== backend.spec.target.capabilitiesSha256 ||
    knowledgeHash(current) !== spec.target.capabilitiesSha256 ||
    !Array.isArray(old.providerIds) ||
    !Array.isArray(current.providerIds) ||
    knowledgeHash({ ...current, providerIds: old.providerIds }) !==
      knowledgeHash(old) ||
    knowledgeHash(current.providerIds) !==
      knowledgeHash([...new Set([...old.providerIds, `acp:${spec.id}`])].sort())
  )
    fail("BACKEND_LOAD_SOURCE_INVALID");
  return { backend, request, connection };
}
export function validateTurnSql(db: DatabaseSync, p: BackendTurnProof): void {
  digest(p);
  for (const key of [
    "workspaceId",
    "sessionId",
    "runId",
    "turnId",
    "attemptId",
    "providerId",
    "modelId",
    "ownerEpoch",
  ] as const)
    id(p[key]);
  for (const key of [
    "requestSha256",
    "configSha256",
    "catalogueSha256",
    "rootBindingSha256",
  ] as const)
    sha(p[key]);
  const session = readPrimary(db, "sessions", p.sessionId),
    run = readPrimary(db, "runs", p.runId),
    turn = readPrimary(db, "session_turns", p.turnId),
    attempt = readPrimary(db, "provider_attempts", p.attemptId);
  if (
    session.workspaceId !== p.workspaceId ||
    run.workspaceId !== p.workspaceId ||
    run.sessionId !== p.sessionId ||
    turn.sessionId !== p.sessionId ||
    turn.runId !== p.runId ||
    attempt.sessionId !== p.sessionId ||
    attempt.runId !== p.runId ||
    attempt.turnId !== p.turnId ||
    knowledgeHash(run.config) !== p.configSha256
  )
    fail("BACKEND_OWNER_INVALID");
  const cleanup = db
    .prepare(
      "SELECT workspace_id,session_id,run_id,turn_id,provider_id,model_id,context_revision_id,request_sha256 FROM attempt_cleanup WHERE attempt_id=?",
    )
    .get(p.attemptId);
  if (
    !cleanup ||
    cleanup.workspace_id !== p.workspaceId ||
    cleanup.session_id !== p.sessionId ||
    cleanup.run_id !== p.runId ||
    cleanup.turn_id !== p.turnId ||
    cleanup.provider_id !== p.providerId ||
    cleanup.model_id !== p.modelId ||
    cleanup.context_revision_id !== p.contextRevisionId ||
    cleanup.request_sha256 !== p.requestSha256
  )
    fail("BACKEND_OWNER_INVALID");
}
export function validateTerminalOutputSql(
  db: DatabaseSync,
  e: BackendClientEffectRevision,
  control: BackendTerminalControl,
): void {
  const wire = control.frame.message;
  if (!("method" in wire) || wire.method !== "terminal/output") return;
  const result = resultObject(control.message);
  if (!result) fail("BACKEND_DELIVERY_INVALID");
  const body = { output: result.output, truncated: result.truncated };
  const completion = e.completion,
    data = completion?.result;
  const noProcess =
    completion?.state === "failed" &&
    completion.effectMethod === "terminal/create" &&
    completion.cleanupConfirmed === true &&
    completion.content === null &&
    completion.checkpoint === null &&
    isObject(data) &&
    data.status === "cancelled" &&
    data.started === false &&
    data.cancelled === true &&
    data.timedOut === false &&
    data.cleanupConfirmed === true &&
    data.exitCode === null &&
    data.signal === null;
  if (noProcess) {
    const jobId = ownedCommandJobId({
      runId: completion.runId,
      toolCallId: completion.toolCallId,
    });
    if (
      result.exitStatus !== undefined ||
      readOwnedCommandJob(db, completion.workspaceId, jobId) ||
      db
        .prepare(
          "SELECT 1 FROM checkpoints WHERE run_id=? AND tool_call_id=? LIMIT 1",
        )
        .get(completion.runId, completion.toolCallId) ||
      [
        "command.job.source_admitted",
        "command.job.process_admitted",
        "command.job.closed_observed",
      ].some((type) =>
        nativePayloads(db, e.owner, type).some(
          (value) => value.jobId === jobId,
        ),
      )
    )
      fail("BACKEND_EFFECT_COMPLETION_INVALID");
  }
  if (
    !nativePayloads(db, e.owner, "backend.terminal_output_observed").some(
      (value) =>
        value.providerToolCallId === e.input.callId &&
        knowledgeHash(value.output) === knowledgeHash(body) &&
        (noProcess
          ? value.toolCallId === completion.toolCallId &&
            value.noProcessCompletionSha256 === completion.sha256 &&
            knowledgeHash(body) ===
              knowledgeHash({ output: "", truncated: false })
          : value.noProcessCompletionSha256 === undefined),
    )
  )
    fail("BACKEND_DELIVERY_INVALID");
  if (
    result.exitStatus !== undefined &&
    (!completion ||
      knowledgeHash(result.exitStatus) !==
        knowledgeHash(nativeExitStatus(completion.result)))
  )
    fail("BACKEND_DELIVERY_INVALID");
}
interface SessionEvent {
  readonly header: Record<string, SQLOutputValue>;
  readonly event: { readonly payload?: JsonObject };
}
/** Bounded `session_events` rows of one type matching `where`, read one body at a time. */
function* sessionEvents(
  db: DatabaseSync,
  type: string,
  where: string,
  params: readonly SQLInputValue[],
): Generator<SessionEvent> {
  const headers = db
    .prepare(
      `SELECT session_id,seq,run_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE type=? AND ${where} LIMIT ?`,
    )
    .all(type, ...params, AGENT_BACKEND_STORAGE_LIMITS.eventScan + 1);
  if (headers.length > AGENT_BACKEND_STORAGE_LIMITS.eventScan)
    fail("BACKEND_LIMIT");
  for (const header of headers) {
    if (Number(header.bytes) > AGENT_BACKEND_STORAGE_LIMITS.eventBytes)
      fail("BACKEND_LIMIT");
    const raw =
      readBoundedBody(
        db,
        {
          table: "session_events",
          where: "session_id=? AND seq=?",
          params: [header.session_id!, header.seq!],
        },
        Number(header.bytes),
        fail,
      ) ?? fail();
    yield { header, event: JSON.parse(raw) };
  }
}
function ownerEvents(
  db: DatabaseSync,
  owner: BackendTurnProof,
  type: string,
): Generator<SessionEvent> {
  return sessionEvents(
    db,
    type,
    "session_id=? AND run_id=? AND turn_id=? AND attempt_id=?",
    [owner.sessionId, owner.runId, owner.turnId, owner.attemptId],
  );
}
function some<T>(items: Iterable<T>, match: (item: T) => boolean): boolean {
  for (const item of items) if (match(item)) return true;
  return false;
}
export function nativePayloads(
  db: DatabaseSync,
  owner: BackendTurnProof,
  type: string,
): JsonObject[] {
  return Array.from(
    ownerEvents(db, owner, type),
    (e) => e.event.payload as JsonObject,
  );
}
function assertEffectOwner(
  e: BackendClientEffectRevision,
  p: BackendClientReadProof | BackendClientPermissionProof,
): void {
  digest(p);
  for (const key of [
    "workspaceId",
    "sessionId",
    "runId",
    "turnId",
    "attemptId",
  ] as const)
    if (p[key] !== e.owner[key]) fail("BACKEND_EFFECT_OWNER_INVALID");
}
function proposed(
  db: DatabaseSync,
  e: BackendClientEffectRevision,
  toolCallId: string,
): boolean {
  return nativePayloads(db, e.owner, "backend.client_effect_proposed").some(
    (value) =>
      value.toolCallId === toolCallId &&
      value.providerToolCallId === e.input.callId &&
      knowledgeHash(value.input) === knowledgeHash(e.input),
  );
}
export function validatePermissionSql(
  db: DatabaseSync,
  e: BackendClientEffectRevision,
  p: BackendClientPermissionProof,
): void {
  assertEffectOwner(e, p);
  if (
    p.providerToolCallId !== e.input.callId ||
    !nativePayloads(db, e.owner, "backend.client_permission").some(
      (value) => knowledgeHash(value.permission) === knowledgeHash(p),
    )
  )
    fail("BACKEND_PERMISSION_INVALID");
  if (!proposed(db, e, p.toolCallId)) fail("BACKEND_PERMISSION_INVALID");
  const tool = readPrimary(db, "tools", p.toolCallId);
  if (
    tool.name !== clientEffectToolName(e.input) ||
    tool.sessionId !== p.sessionId ||
    tool.runId !== p.runId ||
    knowledgeHash(tool.input) !== p.inputSha256
  )
    fail("BACKEND_PERMISSION_INVALID");
  if (p.allowed) {
    if (!p.approvalId || !p.preparedFingerprint)
      fail("BACKEND_PERMISSION_INVALID");
    const approval = readPrimary(db, "approvals", p.approvalId);
    if (
      approval.status !== "allowed" ||
      approval.toolCallId !== p.toolCallId ||
      approval.fingerprint !== p.preparedFingerprint ||
      approval.runId !== p.runId ||
      approval.sessionId !== p.sessionId ||
      approval.toolName !== tool.name
    )
      fail("BACKEND_PERMISSION_INVALID");
  }
}
export function validateClientEffectSql(
  db: DatabaseSync,
  e: BackendClientEffectRevision,
  p: BackendClientReadProof,
): void {
  assertEffectOwner(e, p);
  const run = readPrimary(db, "runs", e.owner.runId);
  const runConfig = run.config as { limits: { maxOutputBytes: number } };
  const outputBudget = integer(runConfig.limits.maxOutputBytes);
  if (
    p.providerToolCallId !== e.input.callId ||
    !SETTLED_EFFECT_STATES.includes(p.state) ||
    typeof p.cleanupConfirmed !== "boolean" ||
    !Number.isSafeInteger(p.outputBytes) ||
    p.outputBytes < 0 ||
    p.outputBytes > outputBudget ||
    (p.content !== null &&
      Buffer.byteLength(p.content) > AGENT_BACKEND_STORAGE_LIMITS.outputBytes)
  )
    fail("BACKEND_EFFECT_INVALID");
  const tool = readPrimary(db, "tools", p.toolCallId, outputBudget * 6 + 65536);
  if (
    tool.name !== clientEffectToolName(e.input) ||
    tool.sessionId !== p.sessionId ||
    tool.runId !== p.runId ||
    tool.state !== p.state ||
    knowledgeHash(tool.input) !== p.inputSha256 ||
    sha256Hex(typeof tool.output === "string" ? tool.output : "") !==
      p.outputSha256 ||
    Buffer.byteLength(typeof tool.output === "string" ? tool.output : "") !==
      p.outputBytes
  )
    fail("BACKEND_EFFECT_INVALID");
  const workspace = readPrimary(db, "workspaces", p.workspaceId);
  if (typeof workspace.root !== "string") fail("BACKEND_EFFECT_INPUT_INVALID");
  const toolInput = tool.input as JsonObject;
  if ("method" in e.input) {
    if (!proposed(db, e, p.toolCallId)) fail("BACKEND_EFFECT_INPUT_INVALID");
    if (p.effectMethod !== e.input.method) fail("BACKEND_EFFECT_INPUT_INVALID");
    if (e.input.method === "fs/write_text_file") {
      const local = workspaceLocalPath(workspace.root, e.input.path);
      const changes = toolInput.changes;
      if (
        local === undefined ||
        !Array.isArray(changes) ||
        changes.length !== 1 ||
        !isObject(changes[0]) ||
        changes[0].path !== local ||
        changes[0].content !== e.input.content
      )
        fail("BACKEND_EFFECT_INPUT_INVALID");
    } else {
      if (
        toolInput.command !==
          terminalCommandLine(e.input.command, e.input.args) ||
        toolInput.cwd !== e.input.cwd
      )
        fail("BACKEND_EFFECT_INPUT_INVALID");
    }
    if (
      clientEffectToolName(e.input) === "run_command" &&
      isObject(p.result) &&
      p.result.started === true
    ) {
      const job = readOwnedCommandJob(
        db,
        p.workspaceId,
        ownedCommandJobId({ runId: p.runId, toolCallId: p.toolCallId }),
      );
      if (
        !job?.completion ||
        job.source.toolCallId !== p.toolCallId ||
        job.source.runId !== p.runId ||
        job.completion.checkpoint.id !== p.checkpoint?.id
      )
        fail("BACKEND_EFFECT_CHECKPOINT_INVALID");
      for (const key of [
        "exitCode",
        "signal",
        "cancelled",
        "timedOut",
        "cleanupConfirmed",
        "started",
      ] as const)
        if (
          knowledgeHash(job.completion.outcome[key]) !==
          knowledgeHash(p.result[key])
        )
          fail("BACKEND_EFFECT_COMPLETION_INVALID");
    }
    if (
      !nativePayloads(db, e.owner, "backend.client_effect_closed").some(
        (value) => knowledgeHash(value.completion) === knowledgeHash(p),
      )
    )
      fail("BACKEND_EFFECT_COMPLETION_INVALID");
    if (
      p.state === "completed" ||
      (isObject(p.result) && p.result.checkpointId)
    ) {
      const checkpoints = db
        .prepare(
          "SELECT id,length(CAST(data AS BLOB)) bytes FROM checkpoints WHERE run_id=? LIMIT 129",
        )
        .all(p.runId);
      if (checkpoints.length > 128) fail("BACKEND_LIMIT");
      const cpId =
        p.checkpoint?.id ?? (isObject(p.result) ? p.result.checkpointId : null);
      if (!cpId || !checkpoints.some((h) => h.id === cpId))
        fail("BACKEND_EFFECT_CHECKPOINT_INVALID");
      const cp = readPrimary(db, "checkpoints", String(cpId), 8388608);
      if (
        cp.runId !== p.runId ||
        cp.toolCallId !== p.toolCallId ||
        (p.checkpoint && knowledgeHash(cp) !== p.checkpoint.sha256) ||
        cp.kind !== (e.input.method === "terminal/create" ? "command" : "patch")
      )
        fail("BACKEND_EFFECT_CHECKPOINT_INVALID");
    }
  } else {
    const localPath = workspaceLocalPath(workspace.root, e.input.path);
    if (
      localPath === undefined ||
      knowledgeHash(tool.input) !==
        knowledgeHash(
          clientReadToolInput(localPath, e.input.line, e.input.limit),
        )
    )
      fail("BACKEND_EFFECT_INPUT_INVALID");
  }
  const parts = db
    .prepare(
      "SELECT id FROM message_parts WHERE turn_id=? AND run_id=? AND session_id=? LIMIT 257",
    )
    .all(p.turnId, p.runId, p.sessionId);
  if (parts.length > 256) fail("BACKEND_LIMIT");
  if (
    !parts.some((r) => {
      const part = readPrimary(db, "message_parts", String(r.id));
      return (
        part.type === "tool" &&
        part.toolCallId === p.toolCallId &&
        part.providerCallId === p.providerToolCallId &&
        part.name === clientEffectToolName(e.input) &&
        ["completed", "failed", "interrupted"].includes(String(part.state))
      );
    })
  )
    fail("BACKEND_EFFECT_PART_INVALID");
  if (p.preparedFingerprint !== null) {
    if (
      !some(
        ownerEvents(db, e.owner, "tool.prepared"),
        ({ event }) =>
          event.payload?.toolCallId === p.toolCallId &&
          event.payload?.providerToolCallId === p.providerToolCallId &&
          event.payload?.toolName === clientEffectToolName(e.input) &&
          event.payload?.inputSha256 === p.inputSha256 &&
          event.payload?.preparedFingerprint === p.preparedFingerprint,
      )
    )
      fail("BACKEND_EFFECT_FINGERPRINT_INVALID");
    const approvals = db
      .prepare("SELECT id FROM approvals WHERE tool_call_id=? LIMIT 17")
      .all(p.toolCallId);
    if (approvals.length > 16) fail("BACKEND_LIMIT");
    if (
      (approvals.length || "method" in e.input) &&
      !approvals.some((a) => {
        const approval = readPrimary(db, "approvals", String(a.id));
        return (
          approval.status === "allowed" &&
          approval.toolCallId === p.toolCallId &&
          approval.fingerprint === p.preparedFingerprint &&
          approval.sessionId === p.sessionId &&
          approval.runId === p.runId &&
          approval.toolName === clientEffectToolName(e.input)
        );
      }) &&
      (p.state === "completed" ||
        ("method" in e.input &&
          p.checkpoint !== undefined &&
          p.checkpoint !== null))
    )
      fail("BACKEND_EFFECT_APPROVAL_INVALID");
  }
  if (
    p.content !== null &&
    (p.state !== "completed" || !p.cleanupConfirmed || p.errorCode !== null)
  )
    fail("BACKEND_EFFECT_INVALID");
}
/** `anchored` holds connection identities whose owner events one validation pass already found. */
function validateOwnerSql(
  db: DatabaseSync,
  r: AgentBackendRecord,
  anchored?: Set<string>,
): void {
  if (r.kind === "backend") {
    const s = readPrimary(db, "sessions", r.spec.target.sessionId);
    if (s.workspaceId !== r.workspaceId) fail();
    validateSessionLoadSourceSql(db, r.spec, r.target);
    return;
  }
  if (r.kind === "connection") {
    const identity = JSON.stringify([
      r.backendId,
      r.backendRevisionId,
      r.backendSha256,
      r.connectionId,
      r.proof,
    ]);
    if (anchored?.has(identity)) return;
    const anchor = some(
      sessionEvents(
        db,
        "backend.launch_reserved",
        "json_extract(data,'$.payload.ownerSha256')=? AND json_extract(data,'$.payload.launchSha256')=?",
        [r.proof.ownerSha256, r.proof.launchSha256],
      ),
      ({ header, event }) =>
        event.payload?.backendId === r.backendId &&
        event.payload?.backendRevisionId === r.backendRevisionId &&
        event.payload?.ownerSha256 === r.proof.ownerSha256 &&
        event.payload?.launchSha256 === r.proof.launchSha256 &&
        event.payload?.turnId === header.turn_id &&
        event.payload?.attemptId === header.attempt_id,
    );
    if (!anchor) fail("BACKEND_CONNECTION_OWNER_INVALID");
    const hasAdmission = some(
      sessionEvents(
        db,
        "backend.connection_admitted",
        "json_extract(data,'$.payload.connectionId')=? AND json_extract(data,'$.payload.ownerSha256')=?",
        [r.connectionId, r.proof.ownerSha256],
      ),
      ({ event: { payload: p } }) =>
        !!p &&
        p.connectionId === r.connectionId &&
        p.epoch === r.proof.epoch &&
        p.processId === r.proof.processId &&
        p.birthNonce === r.proof.birthNonce &&
        p.ownerSha256 === r.proof.ownerSha256 &&
        p.backendRevisionId === r.backendRevisionId &&
        p.backendId === r.backendId &&
        p.backendSha256 === r.backendSha256 &&
        p.launchSha256 === r.proof.launchSha256 &&
        knowledgeHash(p.clientCapabilities ?? null) ===
          knowledgeHash(r.proof.clientCapabilities ?? null) &&
        (p.executionMode ?? null) === (r.proof.executionMode ?? null),
    );
    if (!hasAdmission) fail("BACKEND_CONNECTION_OWNER_INVALID");
    anchored?.add(identity);
  }
  if (r.kind === "request" || r.kind === "client-effect") {
    validateTurnSql(db, r.owner);
    if (r.kind === "client-effect") {
      if (r.permission) validatePermissionSql(db, r, r.permission);
      if (r.completion) validateClientEffectSql(db, r, r.completion);
    }
  }
}
export function validateAgentBackendDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  const anchored = new Set<string>(),
    journal = backendJournal(db, {
      ...BACKEND_JOURNAL,
      verify(record, db) {
        validateBody(record);
        validateOwnerSql(db, record, anchored);
      },
    }),
    graph = journal.scan(options.check),
    records = graph.records,
    all = [...records.values()],
    connections = Map.groupBy(
      all.filter((v) => v.kind === "connection"),
      (v) => v.connectionId,
    ),
    requests = Map.groupBy(
      all.filter((v) => v.kind === "request"),
      (v) => v.remoteRequestId,
    ),
    effects = all.filter((v) => v.kind === "client-effect"),
    effectsByRequest = Map.groupBy(effects, (v) => v.remoteRequestId),
    effectRevisions = Map.groupBy(effects, (v) => v.entityId);
  for (const r of records.values()) {
    const t = journal.receiptOf(r, graph);
    if (r.kind === "client-effect" && r.controls)
      for (const control of r.controls)
        validateTerminalOutputSql(db, r, control);
    if (
      t.operation === "bind-effect" &&
      r.kind === "client-effect" &&
      (!r.executionFrame ||
        r.executionFrame.frameSha256 !==
          knowledgeHash(r.executionFrame.message))
    )
      fail();
    if (t.operation === "effect-ack" && r.kind === "client-effect") {
      const message = validateAcpV1Message(t.requestInput.message);
      if (
        !("method" in r.input) ||
        r.input.method !== "terminal/create" ||
        !r.delivery ||
        !nativePayloads(db, r.owner, "backend.client_effect_dispatched").some(
          (value) => value.providerToolCallId === r.input.callId,
        ) ||
        resultObject(message)?.terminalId !== `terminal:${r.effectId}` ||
        r.delivery.frameSha256 !== knowledgeHash(message)
      )
        fail();
    }
    if (t.operation === "delivery" && r.kind === "client-effect") {
      const message = validateAcpV1Message(t.requestInput.message);
      if (
        !("id" in message) ||
        message.id !== effectRpc(r) ||
        r.delivery?.frameSha256 !== knowledgeHash(message)
      )
        fail();
      validateEffectResponse(r, message);
    }
    if (t.operation === "permission" && r.kind === "client-effect") {
      if (!r.permission || !r.permissionDelivery) fail();
      const message = validateAcpV1Message(t.requestInput.message);
      validatePermissionSql(db, r, r.permission);
      validatePermissionResponse(r, r.permission, message);
      if (r.permissionDelivery.frameSha256 !== knowledgeHash(message)) fail();
    }
    const before = journal.previousOf(r, graph);
    assertBackendTransition(
      r.kind,
      before ? state(before) : null,
      state(r),
      t.operation,
    );
    validateTransition(before, r, t.operation);
    if (r.kind === "connection") {
      const b = records.get(r.backendRevisionId);
      if (
        !b ||
        b.kind !== "backend" ||
        b.workspaceId !== r.workspaceId ||
        b.backendId !== r.backendId ||
        b.spec.sha256 !== r.backendSha256 ||
        b.target.launchSha256 !== r.proof.launchSha256
      )
        fail();
      if (b.spec.sessionLoad) {
        if (
          r.capabilities &&
          (r.capabilities.contextOwner !== "agent" ||
            !r.capabilities.loadSession)
        )
          fail("ACP_LOAD_UNSUPPORTED");
        if (r.sessionLoad) {
          const m = r.sessionLoad.message;
          if (
            !("method" in m) ||
            m.params?.sessionId !== b.spec.sessionLoad.remoteSessionId ||
            m.params?.cwd !== b.spec.launch.cwd
          )
            fail("BACKEND_LOAD_SOURCE_INVALID");
        }
        if (
          r.remoteSessionId !== null &&
          (r.sessionLoad?.state !== "loaded" ||
            r.remoteSessionId !== b.spec.sessionLoad.remoteSessionId)
        )
          fail("BACKEND_REMOTE_SESSION_INVALID");
      } else if (
        r.sessionLoad ||
        (r.capabilities && r.capabilities.contextOwner !== "engine")
      )
        fail("BACKEND_LOAD_SOURCE_INVALID");
    }
    if (r.kind === "request" || r.kind === "client-effect") {
      const revisions = connections.get(r.connectionId) ?? [],
        onEpoch = (v: BackendConnectionRevision) =>
          v.workspaceId === r.workspaceId && v.proof.epoch === r.epoch,
        c = revisions.find(onEpoch);
      if (!c || c.proof.ownerSha256 !== r.owner.sha256)
        fail("BACKEND_OWNER_INVALID");
      if (r.kind === "request" && SETTLED_REQUEST_STATES.includes(r.state)) {
        if (
          !revisions.some(
            (v) =>
              onEpoch(v) &&
              v.state === "closed" &&
              v.disposal?.cleanupConfirmed === true &&
              v.createdAt <= r.createdAt,
          )
        )
          fail("BACKEND_TERMINAL_INVALID");
        for (const effect of effectsByRequest.get(r.remoteRequestId) ?? [])
          if (
            effect.workspaceId === r.workspaceId &&
            effect.createdAt <= r.createdAt &&
            !effectRevisions
              .get(effect.entityId)!
              .some(
                (v) =>
                  v.workspaceId === effect.workspaceId &&
                  v.delivery !== null &&
                  v.completion !== null &&
                  v.createdAt <= r.createdAt,
              )
          )
            fail("BACKEND_EFFECT_UNSETTLED");
      }
      if (
        r.kind === "client-effect" &&
        !requests
          .get(r.remoteRequestId)
          ?.some(
            (v) =>
              v.workspaceId === r.workspaceId &&
              v.owner.sha256 === r.owner.sha256 &&
              v.connectionId === r.connectionId &&
              v.epoch === r.epoch,
          )
      )
        fail();
    }
  }
  journal.assertHeads(graph);
}
function appendAdministrative(
  journal: BackendJournal,
  before: AgentBackendRecord,
  operation: "recover" | "pause-import",
  at: string,
  archiveSha?: string,
): void {
  const input = {
    workspaceId: before.workspaceId,
    requestId:
      operation === "recover"
        ? `recover:${before.id}`
        : `import:${archiveSha}:${before.id}`,
    expectedRevision: before.revision,
    ...(archiveSha ? { archiveSha256: archiveSha } : {}),
  };
  const body = bodyOf(before) as Record<string, unknown>;
  if (before.kind === "backend") body.enabled = false;
  else {
    body.state = operation === "recover" ? "uncertain" : "paused-import";
    body.errorCode =
      operation === "recover" ? "BACKEND_OWNER_LOST" : "BACKEND_IMPORTED";
  }
  journal.append({
    kind: before.kind,
    before,
    expectedRevision: before.revision,
    build: (revisionId, receiptId) =>
      prepareSignedBackendRevision({
        kind: before.kind,
        entityId: before.entityId,
        workspaceId: before.workspaceId,
        before,
        body: body as Omit<AgentBackendRecord, keyof BackendRevisionBase>,
        requestInput: input,
        revisionId,
        receiptId,
        operation,
        createdAt: at,
      }),
  });
}
export function recoverAgentBackends(
  db: DatabaseSync,
  at = backendClock(db, Date.now()),
): number {
  validateAgentBackendDatabase(db);
  const journal = backendJournal(db),
    records = journal.current().filter((r) => recoverable(r.kind, state(r)));
  for (const r of records) appendAdministrative(journal, r, "recover", at);
  return records.length;
}
export function markImportedAgentBackendsPaused(
  db: DatabaseSync,
  archiveSha: string,
  workspaceId?: string,
): void {
  sha(archiveSha);
  validateAgentBackendDatabase(db);
  const at = backendClock(db, Date.now()),
    journal = backendJournal(db);
  for (const r of journal.current(workspaceId))
    if (pausable(r.kind, state(r)))
      appendAdministrative(journal, r, "pause-import", at, archiveSha);
}
export function hasAgentBackendBlocker(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  return backendJournal(db)
    .current(workspaceId)
    .some(
      (r) =>
        r.kind !== "backend" &&
        (r.state === "uncertain" ||
          (r.state === "paused-import" &&
            (r.kind === "connection"
              ? r.disposal?.cleanupConfirmed !== true
              : r.kind === "request"
                ? r.terminal === null
                : r.completion === null ||
                  r.completion.cleanupConfirmed !== true ||
                  r.delivery === null))),
    );
}
