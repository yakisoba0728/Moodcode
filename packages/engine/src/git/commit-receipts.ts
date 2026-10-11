import type { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import type { SessionDocument } from "../storage/native-records.js";
import { verificationDocumentKind } from "../verification/plans.js";
import { verificationHash } from "../verification/types.js";
import {
  gitSha,
  commitData,
  commitFields,
  commitJson,
  commitId,
  commitDigest,
  commitPath,
  gitOid,
  signedCommit,
  gitCommitError,
  GIT_COMMIT_LIMITS,
  type GitCommitPreview,
  type GitCommitReceipt,
} from "./types.js";
export const gitCommitDocumentKind = (requestId: string) =>
  "git.commit." + knowledgeHash(commitId(requestId)).slice(0, 40);
export interface GitCommitRecordPorts {
  writeTx<T>(operation: () => T): T;
  writeDocument(
    sessionId: string,
    kind: string,
    expected: number,
    data: JsonObject,
  ): SessionDocument;
  appendEvent(sessionId: string, type: string, payload: JsonObject): unknown;
}
function assertEventBounds(row: Record<string, any>): void {
  if (
    Number(row.count) > 8192 ||
    Number(row.bytes) > 33554432 ||
    Number(row.largest) > GIT_COMMIT_LIMITS.recordBytes + 8192
  )
    gitCommitError("GIT_COMMIT_LIMIT");
}
function caps(db: DatabaseSync): void {
  assertEventBounds(
    db
      .prepare(
        "SELECT count(*) AS count,sum(length(CAST(data AS BLOB))) AS bytes,max(length(CAST(data AS BLOB))) AS largest FROM session_events WHERE type LIKE 'git.commit.%'",
      )
      .get()!,
  );
  const row = db
    .prepare(
      "SELECT count(*) AS count, sum(length(CAST(data AS BLOB))) AS bytes,max(length(CAST(data AS BLOB))) AS largest FROM session_documents WHERE kind LIKE 'git.commit.%'",
    )
    .get()!;
  if (
    Number(row.count) > GIT_COMMIT_LIMITS.records ||
    Number(row.bytes) > GIT_COMMIT_LIMITS.totalBytes ||
    Number(row.largest) > GIT_COMMIT_LIMITS.recordBytes
  )
    gitCommitError("GIT_COMMIT_LIMIT");
}
function eventMetadata(
  db: DatabaseSync,
  sessionId: string,
  type: string,
  kind: string,
): void {
  assertEventBounds(
    db
      .prepare(
        "SELECT count(*) AS count,sum(length(CAST(data AS BLOB))) AS bytes,max(length(CAST(data AS BLOB))) AS largest FROM session_events WHERE session_id=? AND type=? AND json_extract(data,'$.payload.kind')=?",
      )
      .get(sessionId, type, kind)!,
  );
}
/** Parsed payloads of a receipt's events of one type; `latest` keeps only the newest. */
function payloads(
  db: DatabaseSync,
  sessionId: string,
  type: string,
  id: string,
  maxBytes: number,
  latest = false,
): Record<string, any>[] {
  return db
    .prepare(
      `SELECT data FROM session_events WHERE session_id=? AND type=? AND json_extract(data,'$.payload.id')=? AND length(CAST(data AS BLOB))<=? ${latest ? "ORDER BY seq DESC LIMIT 1" : "LIMIT 2"}`,
    )
    .all(sessionId, type, id, maxBytes)
    .map((row) => JSON.parse(String(row.data)).payload);
}
function body(
  db: DatabaseSync,
  table: string,
  id: string,
  max = 1048576,
): Record<string, any> {
  const column = table === "session_documents" ? "kind" : "id",
    h = db
      .prepare(
        `SELECT length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE ${column}=? LIMIT 2`,
      )
      .all(id);
  if (h.length !== 1 || Number(h[0]!.bytes) > max)
    gitCommitError("GIT_COMMIT_NATIVE_EVIDENCE_INVALID");
  return JSON.parse(
    String(
      db
        .prepare(
          `SELECT data FROM ${table} WHERE ${column}=? AND length(CAST(data AS BLOB))<=?`,
        )
        .get(id, max)!.data,
    ),
  );
}
export type VerificationEvidencePin = Pick<
  GitCommitPreview,
  | "runId"
  | "workspaceId"
  | "sessionId"
  | "verificationRevision"
  | "verificationDocumentSha256"
  | "verification"
  | "source"
>;
export function validateCommitVerification(
  db: DatabaseSync,
  p: VerificationEvidencePin,
): void {
  const runHeader = db
      .prepare("SELECT workspace_id,session_id,state FROM runs WHERE id=?")
      .get(p.runId),
    run = body(db, "runs", p.runId);
  if (
    !runHeader ||
    runHeader.workspace_id !== p.workspaceId ||
    runHeader.session_id !== p.sessionId ||
    !["completed", "failed", "cancelled", "interrupted"].includes(
      String(runHeader.state),
    ) ||
    run.state !== runHeader.state ||
    run.workspaceId !== p.workspaceId ||
    run.sessionId !== p.sessionId
  )
    gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
  eventMetadata(
    db,
    p.sessionId,
    "session.document.updated",
    verificationDocumentKind(p.runId),
  );
  const kind = verificationDocumentKind(p.runId),
    events = db
      .prepare(
        "SELECT data,length(CAST(data AS BLOB)) AS bytes FROM session_events WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=? LIMIT 2",
      )
      .all(p.sessionId, kind, p.verificationRevision);
  if (
    events.length !== 1 ||
    Number(events[0]!.bytes) > GIT_COMMIT_LIMITS.recordBytes ||
    JSON.parse(String(events[0]!.data)).payload.sha256 !==
      p.verificationDocumentSha256
  )
    gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
  if (!p.verification.length) gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
  for (const r of p.verification) {
    const { receiptSha256, ...receiptBody } = r;
    if (
      r.status !== "pass" ||
      r.phase !== "settled" ||
      r.recovery !== "none" ||
      r.sourceStale !== false ||
      r.runId !== p.runId ||
      r.sessionId !== p.sessionId ||
      r.workspaceId !== p.workspaceId ||
      verificationHash(receiptBody) !== receiptSha256 ||
      r.sourceBefore.sha256 !== p.source.sha256
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const o = r.observation;
    if (
      !o ||
      !o.started ||
      o.exitCode !== 0 ||
      o.signal !== null ||
      o.cancelled ||
      o.timedOut ||
      !o.cleanup.confirmed ||
      o.executionComplete !== true ||
      o.sourceAfter?.sha256 !== p.source.sha256 ||
      !o.executionCheckpointId
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const tool = body(db, "tools", r.toolCallId),
      th = db
        .prepare("SELECT run_id,session_id,state FROM tools WHERE id=?")
        .get(r.toolCallId);
    if (
      th?.run_id !== p.runId ||
      th.session_id !== p.sessionId ||
      tool.sessionId !== p.sessionId ||
      th.state !== "completed" ||
      tool.state !== "completed" ||
      tool.name !== "verify_changes" ||
      tool.runId !== p.runId ||
      tool.input.checkId !== r.checkId
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const approvals = db
      .prepare(
        "SELECT data FROM approvals WHERE run_id=? AND tool_call_id=? AND session_id=? AND status='allowed' AND length(CAST(data AS BLOB))<=131072 LIMIT 2",
      )
      .all(p.runId, r.toolCallId, p.sessionId);
    if (
      approvals.length !== 1 ||
      !approvals.some((row) => {
        const a = JSON.parse(String(row.data));
        return (
          a.toolCallId === tool.id &&
          a.preview.verification?.preparedFingerprint ===
            r.preparedFingerprint &&
          a.toolName === "verify_changes" &&
          a.status === "allowed" &&
          a.preview.command === o.command &&
          a.preview.cwd === o.cwd &&
          a.preview.verification.planSha256 === r.planSha256 &&
          a.preview.verification.checkId === r.checkId &&
          a.preview.verification.source.sha256 === p.source.sha256
        );
      })
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const checkpointHeader = db
      .prepare("SELECT run_id,tool_call_id FROM checkpoints WHERE id=?")
      .get(o.executionCheckpointId);
    if (
      checkpointHeader?.run_id !== p.runId ||
      checkpointHeader.tool_call_id !== r.toolCallId
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const checkpoint = body(
      db,
      "checkpoints",
      o.executionCheckpointId,
      8388608,
    );
    if (
      checkpoint.runId !== p.runId ||
      checkpoint.toolCallId !== tool.id ||
      checkpoint.kind !== "command" ||
      checkpoint.incomplete
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const partHeaders = db
      .prepare(
        "SELECT data,length(CAST(data AS BLOB)) AS bytes FROM message_parts WHERE run_id=? AND session_id=? AND json_extract(data,'$.toolCallId')=? AND length(CAST(data AS BLOB))<=1048576 LIMIT 3",
      )
      .all(p.runId, p.sessionId, tool.id);
    if (
      partHeaders.length !== 1 ||
      Number(partHeaders[0]!.bytes) > 1048576 ||
      JSON.parse(String(partHeaders[0]!.data)).state !== "completed"
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const part = JSON.parse(String(partHeaders[0]!.data));
    if (
      part.sessionId !== p.sessionId ||
      part.runId !== p.runId ||
      part.name !== tool.name ||
      part.result?.output !== tool.output ||
      part.result?.isError !== false ||
      part.result?.truncated !== false
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const completedHeaders = db
      .prepare(
        "SELECT seq,length(CAST(data AS BLOB)) AS bytes FROM events WHERE session_id=? AND run_id=? AND type='tool.completed' AND json_extract(data,'$.payload.toolCallId')=? LIMIT 2",
      )
      .all(p.sessionId, p.runId, tool.id);
    if (
      completedHeaders.length !== 1 ||
      Number(completedHeaders[0]!.bytes) > 1048576
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const completed = JSON.parse(
      String(
        db
          .prepare(
            "SELECT data FROM events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))<=1048576",
          )
          .get(p.sessionId, Number(completedHeaders[0]!.seq))!.data,
      ),
    ).payload;
    if (
      completed.cleanupConfirmed !== true ||
      completed.isError !== false ||
      completed.truncated !== false ||
      completed.output !== tool.output
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
    const checkpointEvidence = {
      id: checkpoint.id,
      runId: checkpoint.runId,
      toolCallId: checkpoint.toolCallId,
      kind: checkpoint.kind,
      createdAt: checkpoint.createdAt,
      incomplete: Boolean(checkpoint.incomplete),
      files: checkpoint.files.map((f: any) => ({
        path: f.path,
        beforeHash: f.beforeHash,
        afterHash: f.afterHash,
      })),
    };
    if (
      o.cleanup.evidenceSha256 !==
      verificationHash({
        producer: "run_command",
        command: o.command,
        cwd: o.cwd,
        toolCallId: r.toolCallId,
        preparedFingerprint: r.preparedFingerprint,
        exitCode: o.exitCode,
        signal: o.signal,
        cleanupConfirmed: o.cleanup.confirmed,
        terminationScope: o.cleanup.scope,
        checkpoint: checkpointEvidence,
      })
    )
      gitCommitError("GIT_COMMIT_VERIFICATION_INVALID");
  }
}
type GitCommitState = GitCommitReceipt["state"];
const TRANSITIONS: Readonly<Record<GitCommitState, readonly GitCommitState[]>> =
  {
    prepared: ["approved", "denied", "uncertain", "paused-import"],
    approved: [
      "dispatched",
      "cancelled",
      "failed",
      "uncertain",
      "paused-import",
    ],
    dispatched: [
      "committed",
      "failed",
      "cancelled",
      "uncertain",
      "paused-import",
    ],
    uncertain: ["committed", "failed", "uncertain", "paused-import"],
    committed: ["paused-import"],
    failed: ["paused-import"],
    denied: ["paused-import"],
    cancelled: ["paused-import"],
    "paused-import": ["paused-import"],
  };
export function validateGitCommitReceipt(value: unknown): GitCommitReceipt {
  const r = commitJson(value) as GitCommitReceipt;
  commitFields(
    r,
    [
      "version",
      "id",
      "revision",
      "preview",
      "state",
      "requestSha256",
      "outcome",
      "commitSha",
      "reconciled",
      "errorCode",
      "importArchiveSha256",
      "createdAt",
      "updatedAt",
      "sha256",
    ],
    true,
    "GIT_COMMIT_RECEIPT_INVALID",
  );
  if (
    !r ||
    r.version !== 1 ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    typeof r.state !== "string" ||
    !Object.hasOwn(TRANSITIONS, r.state)
  )
    gitCommitError("GIT_COMMIT_RECEIPT_INVALID");
  commitId(r.id);
  const { sha256, ...record } = r;
  commitDigest(sha256);
  if (knowledgeHash(record) !== sha256)
    gitCommitError("GIT_COMMIT_RECEIPT_INVALID");
  commitFields(
    r.preview,
    [
      "version",
      "id",
      "requestId",
      "workspaceId",
      "sessionId",
      "runId",
      "binding",
      "ownerEpoch",
      "repository",
      "paths",
      "selection",
      "entries",
      "message",
      "expectedTree",
      "expectedIndexProjectionSha256",
      "verification",
      "verificationRevision",
      "verificationDocumentSha256",
      "source",
      "timeoutMs",
      "maxOutputBytes",
      "createdAt",
      "sha256",
    ],
    true,
    "GIT_COMMIT_RECEIPT_INVALID",
  );
  const p = r.preview,
    { sha256: previewSha, ...preview } = p;
  if (
    p.version !== 1 ||
    knowledgeHash(preview) !== previewSha ||
    p.id !== r.id ||
    !p.paths.length ||
    p.paths.length > GIT_COMMIT_LIMITS.paths ||
    new Set(p.paths).size !== p.paths.length ||
    p.paths.length !== p.entries.length ||
    !p.message.endsWith("\n") ||
    Buffer.byteLength(p.message) > GIT_COMMIT_LIMITS.messageBytes ||
    !p.message.trim()
  )
    gitCommitError("GIT_COMMIT_PREVIEW_INVALID");
  if (
    p.binding.workspaceId !== p.workspaceId ||
    p.binding.root !== p.repository.root ||
    !Array.isArray(p.entries) ||
    p.entries.some(
      (e) =>
        !p.paths.includes(commitPath(e.path)) ||
        !/^100(?:644|755)$/.test(e.mode) ||
        (e.oid !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(e.oid)),
    ) ||
    new Set(p.entries.map((e) => e.path)).size !== p.paths.length ||
    !Number.isSafeInteger(p.timeoutMs) ||
    p.timeoutMs < 1 ||
    p.timeoutMs > GIT_COMMIT_LIMITS.timeoutMs ||
    !Number.isSafeInteger(p.maxOutputBytes) ||
    p.maxOutputBytes < 1024 ||
    p.maxOutputBytes > GIT_COMMIT_LIMITS.outputBytes
  )
    gitCommitError("GIT_COMMIT_PREVIEW_INVALID");
  for (const id of [p.workspaceId, p.sessionId, p.runId, p.requestId])
    commitId(id);
  gitOid(p.repository.head);
  gitOid(p.expectedTree);
  commitDigest(p.ownerEpoch);
  commitDigest(p.source.sha256);
  commitDigest(p.expectedIndexProjectionSha256);
  if (r.outcome) {
    commitFields(
      r.outcome,
      [
        "exitCode",
        "signal",
        "cancelled",
        "timedOut",
        "cleanupConfirmed",
        "started",
        "groupPid",
        "supervisorPid",
        "indexAfterSha256",
        "indexAfterProjectionSha256",
        "selectedAfter",
        "stdout",
        "stderr",
        "beforeHead",
        "afterHead",
        "parent",
        "tree",
        "message",
        "errorCode",
      ],
      true,
      "GIT_COMMIT_RECEIPT_INVALID",
    );
    if (
      [
        r.outcome.cancelled,
        r.outcome.timedOut,
        r.outcome.cleanupConfirmed,
        r.outcome.started,
      ].some((v) => typeof v !== "boolean") ||
      (r.outcome.cancelled && r.outcome.timedOut) ||
      (r.outcome.supervisorPid === null
        ? !r.reconciled
        : !Number.isSafeInteger(r.outcome.supervisorPid) ||
          r.outcome.supervisorPid < 1) ||
      (r.outcome.groupPid !== null &&
        (!Number.isSafeInteger(r.outcome.groupPid) || r.outcome.groupPid < 1))
    )
      gitCommitError("GIT_COMMIT_OUTCOME_INVALID");
  }
  if (r.requestSha256 !== null) commitDigest(r.requestSha256);
  if (
    r.state === "committed" &&
    (!r.commitSha ||
      !r.outcome ||
      !r.outcome.cleanupConfirmed ||
      (!r.reconciled &&
        (r.outcome.exitCode !== 0 ||
          r.outcome.signal !== null ||
          !r.outcome.started ||
          r.outcome.cancelled ||
          r.outcome.timedOut)) ||
      r.outcome.afterHead !== r.commitSha ||
      r.outcome.beforeHead !== p.repository.head ||
      r.outcome.parent !== p.repository.head ||
      r.outcome.tree !== p.expectedTree ||
      r.outcome.message !== p.message)
  )
    gitCommitError("GIT_COMMIT_OUTCOME_INVALID");
  if (r.commitSha) gitOid(r.commitSha);
  if (
    (r.state === "prepared" &&
      (r.requestSha256 !== null || r.outcome !== null)) ||
    (r.state === "denied" && (r.outcome !== null || r.commitSha !== null)) ||
    (r.state === "dispatched" && r.outcome !== null)
  )
    gitCommitError("GIT_COMMIT_OUTCOME_INVALID");
  return r;
}
function headers(db: DatabaseSync, ws?: string) {
  caps(db);
  return db
    .prepare(
      `SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) AS bytes FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE d.kind LIKE 'git.commit.%' ${ws ? "AND s.workspace_id=?" : ""} ORDER BY d.session_id,d.kind LIMIT 65`,
    )
    .all(...(ws ? [ws] : []));
}
function readHeader(
  db: DatabaseSync,
  h: Record<string, any>,
): GitCommitReceipt {
  if (Number(h.bytes) > GIT_COMMIT_LIMITS.recordBytes)
    gitCommitError("GIT_COMMIT_LIMIT");
  const raw = String(
      db
        .prepare(
          "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND revision=? AND length(CAST(data AS BLOB))<=?",
        )
        .get(h.session_id, h.kind, h.revision, GIT_COMMIT_LIMITS.recordBytes)!
        .data,
    ),
    r = validateGitCommitReceipt(JSON.parse(raw));
  if (
    r.preview.sessionId !== h.session_id ||
    gitCommitDocumentKind(r.preview.requestId) !== h.kind ||
    r.revision !== h.revision
  )
    gitCommitError("GIT_COMMIT_RECEIPT_INVALID");
  const anchors = db
    .prepare(
      "SELECT data,length(CAST(data AS BLOB)) AS bytes FROM session_events WHERE session_id=? AND type='git.commit.transition' AND json_extract(data,'$.payload.id')=? ORDER BY seq LIMIT 129",
    )
    .all(h.session_id, r.id);
  if (anchors.length !== r.revision || anchors.length > 128)
    gitCommitError("GIT_COMMIT_NATIVE_EVIDENCE_INVALID");
  let before: GitCommitReceipt | undefined;
  for (const anchor of anchors) {
    if (Number(anchor.bytes) > GIT_COMMIT_LIMITS.recordBytes + 4096)
      gitCommitError("GIT_COMMIT_LIMIT");
    const payload = JSON.parse(String(anchor.data)).payload,
      current = validateGitCommitReceipt(payload.record);
    if (
      current.revision !== (before?.revision ?? 0) + 1 ||
      payload.id !== r.id ||
      current.id !== r.id ||
      (before &&
        knowledgeHash(current.preview) !== knowledgeHash(before.preview)) ||
      (before &&
        current.requestSha256 !== before.requestSha256 &&
        before.requestSha256 !== null)
    )
      gitCommitError("GIT_COMMIT_NATIVE_EVIDENCE_INVALID");
    if (
      current.revision === 2 &&
      (current.state === "approved" || current.state === "denied") &&
      current.requestSha256 !==
        knowledgeHash({
          workspaceId: current.preview.workspaceId,
          sessionId: current.preview.sessionId,
          requestId: current.preview.requestId,
          previewSha256: current.preview.sha256,
          expectedRevision: 1,
          decision: current.state === "denied" ? "deny" : "allow",
        })
    )
      gitCommitError("REQUEST_ID_CONFLICT");
    if (
      !before
        ? current.state !== "prepared"
        : !TRANSITIONS[before.state].includes(current.state)
    )
      gitCommitError("GIT_COMMIT_TRANSITION_INVALID");
    if (payload.previousSha256 !== (before?.sha256 ?? null))
      gitCommitError("GIT_COMMIT_NATIVE_EVIDENCE_INVALID");
    before = current;
  }
  if (before!.sha256 !== r.sha256)
    gitCommitError("GIT_COMMIT_NATIVE_EVIDENCE_INVALID");
  if (r.outcome) {
    const [observed] = payloads(
      db,
      h.session_id,
      r.reconciled ? "git.commit.reconciled" : "git.commit.closed",
      r.id,
      GIT_COMMIT_LIMITS.recordBytes,
      true,
    );
    if (
      !observed ||
      observed.previewSha256 !== r.preview.sha256 ||
      knowledgeHash(observed.outcome) !== knowledgeHash(r.outcome)
    )
      gitCommitError("GIT_COMMIT_OUTCOME_INVALID");
    if (!r.reconciled) {
      const sup = payloads(
        db,
        h.session_id,
        "git.commit.supervisor_admitted",
        r.id,
        4096,
      );
      if (
        sup.length !== 1 ||
        sup[0]!.supervisorPid !== r.outcome.supervisorPid ||
        sup[0]!.previewSha256 !== r.preview.sha256
      )
        gitCommitError("GIT_COMMIT_OUTCOME_INVALID");
      const groups = payloads(
        db,
        h.session_id,
        "git.commit.process_admitted",
        r.id,
        4096,
      );
      if (
        r.outcome.started
          ? groups.length !== 1 ||
            groups[0]!.groupPid !== r.outcome.groupPid ||
            groups[0]!.previewSha256 !== r.preview.sha256
          : groups.length !== 0 || r.outcome.groupPid !== null
      )
        gitCommitError("GIT_COMMIT_OUTCOME_INVALID");
    }
  }
  const source = payloads(
    db,
    h.session_id,
    "git.commit.source_admitted",
    r.id,
    GIT_COMMIT_LIMITS.recordBytes,
  );
  if (
    source.length !== 1 ||
    knowledgeHash(source[0]!.preview) !== knowledgeHash(r.preview)
  )
    gitCommitError("GIT_COMMIT_SOURCE_INVALID");
  const docEvent = db
    .prepare(
      "SELECT data FROM session_events WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=? LIMIT 2",
    )
    .all(h.session_id, h.kind, h.revision);
  if (
    docEvent.length !== 1 ||
    JSON.parse(String(docEvent[0]!.data)).payload.sha256 !== gitSha(raw)
  )
    gitCommitError("GIT_COMMIT_NATIVE_EVIDENCE_INVALID");
  validateCommitVerification(db, r.preview);
  return r;
}
function readGitCommitReceipts(
  db: DatabaseSync,
  workspaceId?: string,
): GitCommitReceipt[] {
  return headers(db, workspaceId).map((h) => readHeader(db, h));
}
export function validateGitCommitDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  for (const h of headers(db)) {
    options.check?.();
    readHeader(db, h);
  }
}
export function hasUncertainGitCommit(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  return readGitCommitReceipts(db, workspaceId).some(
    (r) =>
      r.state === "uncertain" ||
      r.state === "dispatched" ||
      r.state === "approved" ||
      (r.state === "paused-import" &&
        (!r.outcome?.cleanupConfirmed || r.commitSha === null)),
  );
}
export class GitCommitStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ports: GitCommitRecordPorts,
  ) {}
  get(
    workspaceId: string,
    sessionId: string,
    requestId: string,
  ): GitCommitReceipt | undefined {
    return readGitCommitReceipts(this.db, workspaceId).find(
      (r) =>
        r.preview.sessionId === sessionId && r.preview.requestId === requestId,
    );
  }
  list(workspaceId: string) {
    return readGitCommitReceipts(this.db, workspaceId);
  }
  /** The write transaction validates every receipt afterwards, so it reads only its own. */
  private readOne(r: GitCommitReceipt): GitCommitReceipt | undefined {
    const h = this.db
      .prepare(
        "SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) AS bytes FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE d.session_id=? AND d.kind=? AND s.workspace_id=?",
      )
      .get(
        r.preview.sessionId,
        gitCommitDocumentKind(r.preview.requestId),
        r.preview.workspaceId,
      );
    return h && readHeader(this.db, h);
  }
  write(record: GitCommitReceipt, expectedRevision: number): GitCommitReceipt {
    return this.ports.writeTx(() => {
      const r = validateGitCommitReceipt(record),
        old = this.readOne(r);
      if (
        (old?.revision ?? 0) !== expectedRevision ||
        r.revision !== expectedRevision + 1
      )
        gitCommitError("REVISION_CONFLICT");
      if (!old && headers(this.db).length >= GIT_COMMIT_LIMITS.records)
        gitCommitError("GIT_COMMIT_LIMIT");
      if (expectedRevision === 0)
        this.ports.appendEvent(
          r.preview.sessionId,
          "git.commit.source_admitted",
          commitData({ id: r.id, preview: r.preview }),
        );
      this.ports.appendEvent(
        r.preview.sessionId,
        "git.commit.transition",
        commitData({
          id: r.id,
          previousSha256: old?.sha256 ?? null,
          record: r,
        }),
      );
      this.ports.writeDocument(
        r.preview.sessionId,
        gitCommitDocumentKind(r.preview.requestId),
        expectedRevision,
        commitData(r),
      );
      validateGitCommitDatabase(this.db);
      return r;
    });
  }
  private advance(old: GitCommitReceipt, patch: Partial<GitCommitReceipt>) {
    this.write(
      signedCommit({
        ...old,
        revision: old.revision + 1,
        ...patch,
        updatedAt: new Date().toISOString(),
      }),
      old.revision,
    );
  }
  recover() {
    for (const old of readGitCommitReceipts(this.db))
      if (["approved", "dispatched"].includes(old.state))
        this.advance(old, {
          state: "uncertain",
          errorCode: "GIT_COMMIT_INTERRUPTED",
        });
  }
  pause(workspaceId: string, archiveSha256: string) {
    commitDigest(archiveSha256);
    for (const old of this.list(workspaceId))
      if (old.state !== "paused-import")
        this.advance(old, {
          state: "paused-import",
          importArchiveSha256: archiveSha256,
        });
  }
}

/** Restart inspection recognizes only a genuinely admitted supervisor, never a live dispatch grant. */
export function hasKnownGitCommitSupervisor(
  db: DatabaseSync,
  pid: number,
): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const rows = db
    .prepare(
      "SELECT session_id,json_extract(data,'$.payload.id') AS id FROM session_events WHERE type='git.commit.supervisor_admitted' AND json_extract(data,'$.payload.supervisorPid')=? AND length(CAST(data AS BLOB))<=4096 LIMIT 65",
    )
    .all(pid);
  if (rows.length > 64) gitCommitError("GIT_COMMIT_LIMIT");
  const receipts = readGitCommitReceipts(db);
  return rows.some((row) =>
    receipts.some(
      (r) =>
        r.id === row.id &&
        r.preview.sessionId === row.session_id &&
        ["approved", "dispatched", "uncertain"].includes(r.state),
    ),
  );
}

export function readGitCommitProcessEvidence(
  db: DatabaseSync,
  sessionId: string,
  id: string,
): { supervisorPid: number | null; groupPid: number | null } {
  commitId(sessionId);
  commitId(id);
  const read = (type: string, field: string) => {
    const rows = payloads(db, sessionId, type, id, 4096);
    if (rows.length > 1) gitCommitError("GIT_COMMIT_OUTCOME_INVALID");
    if (!rows.length) return null;
    const pid = rows[0]![field];
    if (!Number.isSafeInteger(pid) || pid < 1)
      gitCommitError("GIT_COMMIT_OUTCOME_INVALID");
    return pid as number;
  };
  return {
    supervisorPid: read("git.commit.supervisor_admitted", "supervisorPid"),
    groupPid: read("git.commit.process_admitted", "groupPid"),
  };
}
