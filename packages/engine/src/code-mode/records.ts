import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import type { SessionDocument } from "../storage/native-records.js";
import {
  CODE_MODE_LIMITS,
  codeJson,
  codeSign,
  codeModeError,
  parseCodeProgram,
  validateCodeAllocation,
  type CodeModeAllocation,
  type CodeModeRuntimeCapability,
} from "./types.js";
import type {
  CodeModeProcessProof,
  CodeModeProcessOutcome,
} from "./process.js";
export interface CodeModeSource {
  workspaceId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  toolCallId: string;
  approvalId: string;
  approvalFingerprint: string;
  rootBindingSha256: string;
  ownerEpoch: string;
  configSha256: string;
  catalogueSha256: string;
  grantSha256: string;
  runtime: CodeModeRuntimeCapability;
  source: string;
  sourceSha256: string;
  allocation: CodeModeAllocation;
  generation: string;
  sha256: string;
}
export interface NestedCallReceipt {
  id: string;
  toolCallId: string;
  providerToolCallId: string;
  name: string;
  inputSha256: string;
  state: string;
  outputSha256: string;
  outputBytes: number;
  approval: { id: string; fingerprint: string } | null;
}
export interface CodeModeRecord {
  version: 1;
  id: string;
  revision: number;
  source: CodeModeSource;
  state:
    | "prepared"
    | "running"
    | "settling"
    | "completed"
    | "failed"
    | "uncertain"
    | "paused-import";
  process: CodeModeProcessProof | null;
  calls: readonly NestedCallReceipt[];
  pendingCall: { id: string; name: string; input: JsonObject } | null;
  outcome: CodeModeProcessOutcome | null;
  result: JsonValue;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  sha256: string;
}
export const codeModeRecordKind = (id: string) =>
  "code.mode." + knowledgeHash(id).slice(0, 32);
export interface CodeModeRecordPorts {
  assertOriginal(
    original: object,
    record: CodeModeRecord,
    expected: number,
  ): void;
  writeTx<T>(operation: () => T): T;
  writeDocument(
    sessionId: string,
    kind: string,
    revision: number,
    data: JsonObject,
  ): SessionDocument;
  appendEvent(
    sessionId: string,
    type: string,
    payload: JsonObject,
    refs?: { runId?: string; turnId?: string; attemptId?: string },
  ): unknown;
}
function digest(v: Record<string, any>): void {
  const { sha256, ...body } = v;
  if (!/^[a-f0-9]{64}$/.test(sha256) || knowledgeHash(body) !== sha256)
    codeModeError("CODE_MODE_DIGEST_INVALID");
}
function sha(v: unknown): void {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) codeModeError();
}
export function validateCodeModeRecord(value: unknown): CodeModeRecord {
  const r = codeJson(value) as CodeModeRecord;
  digest(r);
  if (
    r.version !== 1 ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    typeof r.id !== "string" ||
    r.id.length > 128 ||
    ![
      "prepared",
      "running",
      "settling",
      "completed",
      "failed",
      "uncertain",
      "paused-import",
    ].includes(r.state)
  )
    codeModeError();
  const s = r.source;
  digest(s);
  parseCodeProgram(s.source);
  validateCodeAllocation(s.allocation);
  if (createHash("sha256").update(s.source).digest("hex") !== s.sourceSha256)
    codeModeError();
  for (const f of [
    "workspaceId",
    "sessionId",
    "runId",
    "turnId",
    "attemptId",
    "toolCallId",
    "approvalId",
    "generation",
  ] as const)
    if (typeof s[f] !== "string" || !s[f] || s[f].length > 128) codeModeError();
  for (const f of [
    "rootBindingSha256",
    "ownerEpoch",
    "configSha256",
    "catalogueSha256",
    "grantSha256",
  ] as const)
    sha(s[f]);
  for (const k of ["createdAt", "updatedAt"] as const)
    if (
      typeof r[k] !== "string" ||
      !Number.isFinite(Date.parse(r[k])) ||
      new Date(r[k]).toISOString() !== r[k]
    )
      codeModeError();
  if (r.updatedAt < r.createdAt) codeModeError();
  for (const c of r.calls) {
    if (
      !c ||
      typeof c !== "object" ||
      c.id !== c.providerToolCallId ||
      !/^code:[a-f0-9]{64}$/.test(c.id) ||
      typeof c.toolCallId !== "string" ||
      c.toolCallId.length > 128 ||
      ![
        "read_file",
        "list_files",
        "search_files",
        "apply_patch",
        "run_command",
        "verify_changes",
      ].includes(c.name) ||
      !["completed", "failed", "denied"].includes(c.state) ||
      !Number.isSafeInteger(c.outputBytes) ||
      c.outputBytes < 0
    )
      codeModeError("CODE_MODE_CALL_INVALID");
    sha(c.inputSha256);
    sha(c.outputSha256);
  }
  digest(s.runtime);
  if (
    s.runtime.version !== 1 ||
    s.runtime.language !== "moodcode-json-v1" ||
    s.runtime.platform !== "darwin" ||
    typeof s.runtime.registrationId !== "string" ||
    s.runtime.registrationId.length > 128 ||
    !s.runtime.registrationId ||
    typeof s.runtime.osRelease !== "string" ||
    !s.runtime.osRelease ||
    s.runtime.code !== null
  )
    codeModeError("CODE_MODE_RUNTIME_INVALID");
  for (const k of [
    "profileSha256",
    "executableSha256",
    "workerSha256",
    "trustedSourceSha256",
    "evidenceSha256",
  ] as const)
    sha(s.runtime[k]);
  if (
    !s.runtime.available ||
    !s.runtime.fileIsolation ||
    !s.runtime.networkIsolation ||
    !s.runtime.processIsolation ||
    s.runtime.backend !== "darwin-seatbelt-v1"
  )
    codeModeError("CODE_MODE_RUNTIME_UNSUPPORTED");
  if (
    !Array.isArray(r.calls) ||
    r.calls.length > s.allocation.maxNestedCalls ||
    new Set(r.calls.map((c) => c.id)).size !== r.calls.length
  )
    codeModeError("CODE_MODE_CALL_LIMIT");
  if (r.process) {
    digest(r.process);
    if (
      r.process.generation !== s.generation ||
      r.process.runtimeSha256 !== s.runtime.sha256 ||
      !Number.isSafeInteger(r.process.processId) ||
      r.process.processId < 1
    )
      codeModeError();
  }
  if (r.outcome) {
    digest(r.outcome);
    if (
      !r.process ||
      r.outcome.generation !== s.generation ||
      r.outcome.processId !== r.process.processId ||
      r.outcome.birthNonce !== r.process.birthNonce ||
      typeof r.outcome.cleanupConfirmed !== "boolean"
    )
      codeModeError();
  }
  if (
    ["completed", "failed"].includes(r.state) &&
    (!r.outcome?.cleanupConfirmed || r.pendingCall)
  )
    codeModeError("CODE_MODE_CLEANUP_UNCERTAIN");
  return r;
}
function headerCaps(db: DatabaseSync): void {
  const e = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,max(length(CAST(data AS BLOB))) largest FROM session_events WHERE type GLOB 'code.mode.*'",
    )
    .get()!;
  if (
    Number(e.n) > 8192 ||
    Number(e.bytes) > 33554432 ||
    Number(e.largest) > 73728
  )
    codeModeError("CODE_MODE_LIMIT");
  const h = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,max(length(CAST(data AS BLOB))) largest FROM session_documents WHERE kind GLOB 'code.mode.*'",
    )
    .get()!;
  if (
    Number(h.n) > 128 ||
    Number(h.bytes) > 8388608 ||
    Number(h.largest) > 65536
  )
    codeModeError("CODE_MODE_LIMIT");
}
function native(
  db: DatabaseSync,
  table: "runs" | "tools" | "approvals" | "message_parts",
  id: string,
): Record<string, any> {
  const h = db
    .prepare(
      `SELECT id,session_id,${table === "runs" ? "" : "run_id,"}${table === "runs" ? "workspace_id,state" : table === "approvals" ? "tool_call_id,status" : "state"},length(CAST(data AS BLOB)) bytes FROM ${table} WHERE id=?`,
    )
    .get(id);
  if (!h || Number(h.bytes) > 2097152)
    codeModeError("CODE_MODE_NATIVE_INVALID");
  const x = db
    .prepare(
      `SELECT data FROM ${table} WHERE id=? AND length(CAST(data AS BLOB))=?`,
    )
    .get(id, h.bytes!);
  if (!x) codeModeError("CODE_MODE_NATIVE_INVALID");
  const r = codeJson(JSON.parse(String(x.data)), 2097152);
  if (
    r.id !== h.id ||
    r.sessionId !== h.session_id ||
    (table !== "runs" && r.runId !== h.run_id) ||
    (table === "runs" &&
      (r.workspaceId !== h.workspace_id || r.state !== h.state)) ||
    (table === "approvals" &&
      (r.toolCallId !== h.tool_call_id || r.status !== h.status)) ||
    (table !== "approvals" && r.state !== h.state)
  )
    codeModeError("CODE_MODE_NATIVE_INVALID");
  return r;
}
function anchors(
  db: DatabaseSync,
  s: CodeModeSource,
  type: string,
  match: string,
): any[] {
  const h = db
    .prepare(
      "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND instr(data,?)>0 LIMIT 257",
    )
    .all(s.sessionId, type, match);
  if (h.length > 256) codeModeError("CODE_MODE_LIMIT");
  return h.map((h) => {
    if (Number(h.bytes) > 73728) codeModeError("CODE_MODE_LIMIT");
    const x = db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
      )
      .get(s.sessionId, h.seq!, h.bytes!);
    if (!x) codeModeError();
    return codeJson(JSON.parse(String(x.data)), 73728);
  });
}
function validateNative(db: DatabaseSync, r: CodeModeRecord): void {
  const s = r.source,
    run = native(db, "runs", s.runId),
    tool = native(db, "tools", s.toolCallId),
    approval = native(db, "approvals", s.approvalId);
  if (
    run.workspaceId !== s.workspaceId ||
    run.sessionId !== s.sessionId ||
    knowledgeHash(run.config) !== s.configSha256 ||
    tool.name !== "execute_code" ||
    tool.runId !== s.runId ||
    tool.sessionId !== s.sessionId ||
    approval.status !== "allowed" ||
    approval.toolCallId !== tool.id ||
    approval.runId !== run.id ||
    approval.fingerprint !== s.approvalFingerprint ||
    approval.preview.codeModeSourceSha256 !== s.sourceSha256 ||
    approval.preview.codeModeGrantSha256 !== s.grantSha256 ||
    approval.preview.runtime?.sha256 !== s.runtime.sha256 ||
    knowledgeHash(approval.preview.allocation) !== knowledgeHash(s.allocation)
  )
    codeModeError("CODE_MODE_SOURCE_INVALID");
  const t = db
      .prepare("SELECT run_id,session_id FROM session_turns WHERE id=?")
      .get(s.turnId),
    a = db
      .prepare("SELECT turn_id,run_id FROM provider_attempts WHERE id=?")
      .get(s.attemptId);
  if (
    t?.run_id !== run.id ||
    t?.session_id !== s.sessionId ||
    a?.turn_id !== s.turnId ||
    a.run_id !== run.id
  )
    codeModeError("CODE_MODE_SOURCE_INVALID");
  const source = anchors(db, s, "code.mode.source_admitted", s.sha256).filter(
    (e) =>
      e.runId === s.runId &&
      e.turnId === s.turnId &&
      e.attemptId === s.attemptId &&
      e.payload?.source?.sha256 === s.sha256 &&
      knowledgeHash(e.payload.source) === knowledgeHash(s),
  );
  if (source.length !== 1) codeModeError("CODE_MODE_SOURCE_INVALID");
  if (
    !r.process &&
    anchors(db, s, "code.mode.process_admitted", r.id).some(
      (e) => e.payload?.id === r.id,
    )
  )
    codeModeError("CODE_MODE_PROCESS_INVALID");
  if (
    !r.outcome &&
    anchors(db, s, "code.mode.closed", r.id).some((e) => e.payload?.id === r.id)
  )
    codeModeError("CODE_MODE_OUTCOME_INVALID");
  if (r.process) {
    if (
      anchors(db, s, "code.mode.process_admitted", r.process.sha256).filter(
        (e) =>
          e.payload?.id === r.id &&
          knowledgeHash(e.payload.process) === knowledgeHash(r.process) &&
          e.runId === s.runId &&
          e.turnId === s.turnId &&
          e.attemptId === s.attemptId,
      ).length !== 1
    )
      codeModeError("CODE_MODE_PROCESS_INVALID");
  }
  if (
    r.outcome &&
    anchors(db, s, "code.mode.closed", r.outcome.sha256).filter(
      (e) =>
        e.payload?.id === r.id &&
        knowledgeHash(e.payload.outcome) === knowledgeHash(r.outcome) &&
        e.runId === s.runId &&
        e.turnId === s.turnId &&
        e.attemptId === s.attemptId,
    ).length !== 1
  )
    codeModeError("CODE_MODE_OUTCOME_INVALID");
  for (const c of r.calls) {
    const tool = native(db, "tools", c.toolCallId);
    if (
      tool.runId !== s.runId ||
      tool.sessionId !== s.sessionId ||
      tool.name !== c.name ||
      tool.state !== c.state ||
      knowledgeHash(tool.input) !== c.inputSha256 ||
      createHash("sha256")
        .update(tool.output ?? "")
        .digest("hex") !== c.outputSha256 ||
      Buffer.byteLength(tool.output ?? "") !== c.outputBytes
    )
      codeModeError("CODE_MODE_CALL_INVALID");
    if (c.approval) {
      const a = native(db, "approvals", c.approval.id);
      if (
        a.status !== "allowed" ||
        a.fingerprint !== c.approval.fingerprint ||
        a.toolCallId !== tool.id ||
        a.runId !== s.runId
      )
        codeModeError("CODE_MODE_CALL_INVALID");
    } else if (
      ["apply_patch", "run_command", "verify_changes"].includes(c.name) &&
      c.state === "completed"
    )
      codeModeError("CODE_MODE_CALL_APPROVAL_REQUIRED");
    const parts = db
      .prepare(
        "SELECT id FROM message_parts WHERE run_id=? AND turn_id=? AND instr(data,?)>0 LIMIT 17",
      )
      .all(s.runId, s.turnId, c.toolCallId);
    if (
      parts.filter((p) => {
        const x = native(db, "message_parts", String(p.id));
        return (
          x.type === "tool" &&
          x.toolCallId === c.toolCallId &&
          x.providerCallId === c.providerToolCallId &&
          x.name === c.name &&
          x.turnId === s.turnId &&
          knowledgeHash(x.input) === c.inputSha256 &&
          x.result?.output === tool.output &&
          ["completed", "failed"].includes(x.state)
        );
      }).length !== 1
    )
      codeModeError("CODE_MODE_PART_INVALID");
  }
  if (["completed", "failed"].includes(r.state)) {
    if (tool.state !== r.state) codeModeError("CODE_MODE_FINAL_INVALID");
    const parts = db
      .prepare(
        "SELECT id FROM message_parts WHERE run_id=? AND turn_id=? AND instr(data,?)>0 LIMIT 17",
      )
      .all(s.runId, s.turnId, tool.id);
    if (
      parts.filter((p) => {
        const x = native(db, "message_parts", String(p.id));
        return (
          x.type === "tool" &&
          x.toolCallId === tool.id &&
          x.name === tool.name &&
          x.turnId === s.turnId &&
          x.result?.output === tool.output &&
          ["completed", "failed"].includes(x.state)
        );
      }).length !== 1
    )
      codeModeError("CODE_MODE_PART_INVALID");
  }
}
export class CodeModeStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ports: CodeModeRecordPorts,
  ) {}
  put(
    original: object,
    record: CodeModeRecord,
    expected: number,
  ): CodeModeRecord {
    this.ports.assertOriginal(original, record, expected);
    return this.append(record, expected);
  }
  private append(record: CodeModeRecord, expected: number): CodeModeRecord {
    return this.ports.writeTx(() => {
      headerCaps(this.db);
      const r = validateCodeModeRecord(record),
        old = this.get(r.source.workspaceId, r.id);
      if (
        r.revision !== expected + 1 ||
        (old?.revision ?? 0) !== expected ||
        (old && old.source.sha256 !== r.source.sha256)
      )
        codeModeError("CODE_MODE_CAS_STALE");
      const refs = {
        runId: r.source.runId,
        turnId: r.source.turnId,
        attemptId: r.source.attemptId,
      };
      if (!old)
        this.ports.appendEvent(
          r.source.sessionId,
          "code.mode.source_admitted",
          { id: r.id, source: r.source as unknown as JsonObject },
          refs,
        );
      if (r.process && !old?.process)
        this.ports.appendEvent(
          r.source.sessionId,
          "code.mode.process_admitted",
          { id: r.id, process: r.process as unknown as JsonObject },
          refs,
        );
      if (r.outcome && !old?.outcome)
        this.ports.appendEvent(
          r.source.sessionId,
          "code.mode.closed",
          { id: r.id, outcome: r.outcome as unknown as JsonObject },
          refs,
        );
      this.ports.appendEvent(
        r.source.sessionId,
        "code.mode.record",
        { id: r.id, record: r as unknown as JsonObject },
        refs,
      );
      this.ports.writeDocument(
        r.source.sessionId,
        codeModeRecordKind(r.id),
        expected,
        r as unknown as JsonObject,
      );
      validateNative(this.db, r);
      headerCaps(this.db);
      return codeJson(r);
    });
  }
  inspect(workspaceId?: string): readonly CodeModeRecord[] {
    headerCaps(this.db);
    const hs = this.db
      .prepare(
        "SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) bytes,s.workspace_id FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE d.kind GLOB 'code.mode.*' LIMIT 129",
      )
      .all();
    if (hs.length > 128) codeModeError("CODE_MODE_LIMIT");
    return hs
      .filter((h) => !workspaceId || h.workspace_id === workspaceId)
      .map((h) => {
        if (Number(h.bytes) > 65536) codeModeError("CODE_MODE_LIMIT");
        const x = this.db
          .prepare(
            "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND revision=? AND length(CAST(data AS BLOB))=?",
          )
          .get(h.session_id!, h.kind!, h.revision!, h.bytes!);
        if (!x) codeModeError();
        const raw = String(x.data),
          r = validateCodeModeRecord(JSON.parse(raw));
        if (
          r.source.workspaceId !== h.workspace_id ||
          r.source.sessionId !== h.session_id ||
          r.revision !== h.revision ||
          codeModeRecordKind(r.id) !== h.kind
        )
          codeModeError("CODE_MODE_DOCUMENT_INVALID");
        const hash = createHash("sha256").update(raw).digest("hex");
        if (
          anchors(this.db, r.source, "session.document.updated", hash).filter(
            (e) =>
              e.payload?.kind === h.kind &&
              e.payload.revision === r.revision &&
              e.payload.sha256 === hash,
          ).length !== 1 ||
          anchors(this.db, r.source, "code.mode.record", r.sha256).filter(
            (e) => knowledgeHash(e.payload?.record) === knowledgeHash(r),
          ).length !== 1
        )
          codeModeError("CODE_MODE_DOCUMENT_INVALID");
        validateNative(this.db, r);
        return r;
      });
  }
  get(workspaceId: string, id: string) {
    return this.inspect(workspaceId).find((r) => r.id === id);
  }
  pause(workspaceId: string) {
    for (const old of this.inspect(workspaceId)) {
      const { sha256, ...body } = old;
      this.append(
        codeSign({
          ...body,
          revision: old.revision + 1,
          state: "paused-import" as const,
          updatedAt: new Date().toISOString(),
        }),
        old.revision,
      );
    }
  }
  recover() {
    for (const old of this.inspect()) {
      if (["prepared", "running", "settling"].includes(old.state)) {
        const { sha256, ...body } = old;
        this.append(
          codeSign({
            ...body,
            revision: old.revision + 1,
            state: "uncertain" as const,
            errorCode: "CODE_MODE_RESTART_UNCERTAIN",
            updatedAt: new Date().toISOString(),
          }),
          old.revision,
        );
      }
    }
  }
  hasUncertain(workspaceId: string) {
    return this.inspect(workspaceId).some(
      (r) =>
        r.state === "uncertain" ||
        (r.state === "paused-import" &&
          (!r.outcome?.cleanupConfirmed || r.pendingCall !== null)),
    );
  }
}
const denied = (): never => codeModeError("CODE_MODE_READ_ONLY");
export function validateCodeModeDatabase(
  db: DatabaseSync,
  options: { check?: (c: string) => void } = {},
) {
  try {
    new CodeModeStorage(db, {
      assertOriginal: denied,
      writeTx: denied,
      writeDocument: denied,
      appendEvent: denied,
    }).inspect();
    options.check?.(
      "Code-mode native source,approval,Tool/Part and immutable receipts valid",
    );
  } catch (error) {
    throw error;
  }
}
