import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import type {
  DiagnosticEffectEpoch,
  DiagnosticExecutionArchiveRow,
  DiagnosticExecutionCapture,
  DiagnosticExecutionDispatch,
  DiagnosticExecutionIdentity,
  DiagnosticExecutionObservation,
  DiagnosticExecutionObservationPorts,
  DiagnosticExecutionObservationTable,
  DiagnosticExecutionPage,
  DiagnosticExecutionPageOptions,
  DiagnosticExecutionRuntimeMetadata,
  ExecutionSourceSnapshot,
} from "./execution-observation-types.js";

export const DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES = Object.freeze([
  "diagnostic_effect_epochs",
  "diagnostic_execution_observations",
] as const);
/** Workspace counters and original tool owners; the primary migrator owns schema version. */
export const DIAGNOSTIC_EXECUTION_OBSERVATION_SCHEMA_SQL = `
CREATE TABLE diagnostic_effect_epochs(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),epoch INTEGER NOT NULL CHECK(epoch>=0),revision INTEGER NOT NULL CHECK(revision>0),data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=4096)) STRICT;
CREATE TABLE diagnostic_execution_observations(ordinal INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL REFERENCES workspaces(id),session_id TEXT NOT NULL REFERENCES sessions(id),run_id TEXT NOT NULL REFERENCES runs(id),tool_call_id TEXT NOT NULL UNIQUE REFERENCES tools(id),turn_id TEXT NOT NULL REFERENCES session_turns(id),attempt_id TEXT NOT NULL REFERENCES provider_attempts(id),state TEXT NOT NULL CHECK(state IN ('dispatched','settled','interrupted')),revision INTEGER NOT NULL CHECK(revision>0),data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=16384)) STRICT;
CREATE INDEX diagnostic_execution_run_page ON diagnostic_execution_observations(workspace_id,run_id,ordinal);
CREATE INDEX diagnostic_execution_owner_active ON diagnostic_execution_observations(state,ordinal);
`;

export type { DiagnosticExecutionObservationPorts } from "./execution-observation-types.js";

export const DIAGNOSTIC_EXECUTION_OBSERVATION_LIMITS = Object.freeze({
  rowBytes: 16384,
  epochBytes: 4096,
  nativeRowBytes: 1048576,
  maxSources: 4096,
  maxSourceBytes: 67108864,
  pageRows: 100,
  pageBytes: 1048576,
  activeCaptures: 128,
});
function fail(code: string, message: string): never {
  throw new EngineError(code, message);
}
function json<T>(value: T): T {
  try {
    return immutableKnowledgeJson(value);
  } catch {
    return fail(
      "INVALID_EXECUTION_OBSERVATION",
      "Execution observations require bounded detached plain JSON",
    );
  }
}
function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some(
      (k) => !required.includes(k) && !optional.includes(k),
    )
  )
    fail(
      "INVALID_EXECUTION_OBSERVATION",
      "Observation fields differ from the native contract",
    );
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail("INVALID_EXECUTION_OBSERVATION", "Expected bounded native identity");
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    fail(
      "INVALID_EXECUTION_OBSERVATION",
      "Observation counter exceeds its bounded integer range",
    );
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    fail("INVALID_EXECUTION_OBSERVATION", "Expected exact SHA-256");
  return value;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const signed = <T extends object>(value: T): T & { readonly sha256: string } =>
  json({ ...value, sha256: knowledgeHash(value) });
const IDENTITY_FIELDS = [
  "workspaceId",
  "sessionId",
  "runId",
  "toolCallId",
  "turnId",
  "attemptId",
] as const;
function identity(value: unknown): DiagnosticExecutionIdentity {
  const v = json(value);
  fields(v, IDENTITY_FIELDS);
  IDENTITY_FIELDS.forEach((k) => identifier(v[k]));
  return v as unknown as DiagnosticExecutionIdentity;
}
function sameIdentity(
  a: DiagnosticExecutionIdentity,
  b: DiagnosticExecutionIdentity,
): boolean {
  return IDENTITY_FIELDS.every((k) => a[k] === b[k]);
}
export function validateExecutionSourceSnapshot(
  input: unknown,
): ExecutionSourceSnapshot {
  const v = json(input);
  fields(v, ["schemaVersion", "completeness", "sha256", "fileCount", "bytes"]);
  if (
    v.schemaVersion !== 1 ||
    !["full", "unknown"].includes(String(v.completeness))
  )
    fail(
      "INVALID_EXECUTION_OBSERVATION",
      "Source snapshot requires explicit observed coverage",
    );
  integer(v.fileCount, 4096);
  integer(v.bytes, 67108864);
  if (v.completeness === "full") digest(v.sha256);
  else if (v.sha256 !== null)
    fail(
      "INVALID_EXECUTION_OBSERVATION",
      "Unknown source coverage cannot assert a content digest",
    );
  return v as unknown as ExecutionSourceSnapshot;
}
function metadata(input: unknown): DiagnosticExecutionRuntimeMetadata {
  const v = json(input);
  fields(
    v,
    [...IDENTITY_FIELDS, "effectClass", "effectiveInputSha256", "source"],
    ["resultComplete"],
  );
  IDENTITY_FIELDS.forEach((k) => identifier(v[k]));
  if (
    !["read", "state", "write", "execute", "network", "unknown"].includes(
      String(v.effectClass),
    )
  )
    fail("INVALID_EXECUTION_OBSERVATION", "Invalid host effect class");
  digest(v.effectiveInputSha256);
  validateExecutionSourceSnapshot(v.source);
  if (v.resultComplete !== undefined && typeof v.resultComplete !== "boolean")
    fail(
      "INVALID_EXECUTION_OBSERVATION",
      "Actual result retention must be explicit",
    );
  return v as unknown as DiagnosticExecutionRuntimeMetadata;
}
function timestamp(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(
      "INVALID_EXECUTION_OBSERVATION",
      "Observation timestamp must be canonical UTC",
    );
}
export function validateDiagnosticExecutionObservationArchiveRow(
  input: DiagnosticExecutionArchiveRow,
): DiagnosticExecutionArchiveRow {
  const envelope = json(input);
  fields(envelope, ["table", "key", "workspaceId", "data"]);
  if (!DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES.includes(envelope.table))
    fail("INVALID_EXECUTION_OBSERVATION", "Unknown observation table");
  identifier(envelope.key);
  identifier(envelope.workspaceId);
  const v = envelope.data as unknown as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail("INVALID_EXECUTION_OBSERVATION", "Observation body must be an object");
  digest(v.sha256);
  const { sha256: expected, ...body } = v;
  if (
    knowledgeHash(body) !== expected ||
    v.workspaceId !== envelope.workspaceId
  )
    fail(
      "EXECUTION_OBSERVATION_HASH_MISMATCH",
      "Observation hash or scope changed",
    );
  if (envelope.table === "diagnostic_effect_epochs") {
    fields(v, ["workspaceId", "epoch", "revision", "updatedAt", "sha256"]);
    identifier(v.workspaceId);
    integer(v.epoch);
    if (integer(v.revision) < 1 || v.workspaceId !== envelope.key)
      fail(
        "INVALID_EXECUTION_OBSERVATION",
        "Effect epoch requires its workspace owner",
      );
    timestamp(v.updatedAt);
    if (Buffer.byteLength(JSON.stringify(v)) > 4096)
      fail("EXECUTION_OBSERVATION_LIMIT", "Epoch row exceeds its bound");
  } else {
    fields(v, [
      ...IDENTITY_FIELDS,
      "schemaVersion",
      "id",
      "ordinal",
      "runtimeEpoch",
      "revision",
      "state",
      "toolName",
      "effectClass",
      "inputSha256",
      "effectiveInputSha256",
      "dispatchToolSha256",
      "settledToolSha256",
      "resultSha256",
      "resultComplete",
      "outcome",
      "sourceBefore",
      "sourceAfter",
      "effectEpochBefore",
      "effectEpochDispatch",
      "effectEpochAfter",
      "dispatchedAt",
      "settledAt",
      "sha256",
    ]);
    IDENTITY_FIELDS.forEach((k) => identifier(v[k]));
    identifier(v.id);
    identifier(v.runtimeEpoch);
    identifier(v.toolName);
    if (
      v.schemaVersion !== 1 ||
      v.id !== envelope.key ||
      integer(v.ordinal) < 1 ||
      integer(v.revision) < 1 ||
      !["dispatched", "settled", "interrupted"].includes(String(v.state)) ||
      !["completed", "failed", "interrupted", "unknown"].includes(
        String(v.outcome),
      ) ||
      !["read", "state", "write", "execute", "network", "unknown"].includes(
        String(v.effectClass),
      )
    )
      fail(
        "INVALID_EXECUTION_OBSERVATION",
        "Invalid native observation owner/state",
      );
    for (const key of [
      "inputSha256",
      "effectiveInputSha256",
      "dispatchToolSha256",
    ])
      digest(v[key]);
    for (const key of ["settledToolSha256", "resultSha256"])
      if (v[key] !== null) digest(v[key]);
    validateExecutionSourceSnapshot(v.sourceBefore);
    if (v.sourceAfter !== null) validateExecutionSourceSnapshot(v.sourceAfter);
    integer(v.effectEpochBefore);
    integer(v.effectEpochDispatch);
    if (v.effectEpochAfter !== null) integer(v.effectEpochAfter);
    const bump = ["write", "execute", "network", "unknown"].includes(
      String(v.effectClass),
    )
      ? 1
      : 0;
    if (
      v.effectEpochDispatch !== Number(v.effectEpochBefore) + bump ||
      (v.effectEpochAfter !== null &&
        Number(v.effectEpochAfter) < Number(v.effectEpochDispatch)) ||
      typeof v.resultComplete !== "boolean"
    )
      fail(
        "INVALID_EXECUTION_OBSERVATION",
        "Effect boundary contradicts actual dispatch",
      );
    timestamp(v.dispatchedAt);
    if (v.settledAt !== null) timestamp(v.settledAt);
    if (
      (v.state === "dispatched" &&
        (v.settledAt !== null ||
          v.sourceAfter !== null ||
          v.effectEpochAfter !== null ||
          v.outcome !== "unknown" ||
          v.resultComplete ||
          v.resultSha256 !== null ||
          v.settledToolSha256 !== null)) ||
      (v.state !== "dispatched" && v.settledAt === null) ||
      (v.resultComplete &&
        (v.state !== "settled" ||
          v.outcome !== "completed" ||
          v.resultSha256 === null ||
          v.settledToolSha256 === null)) ||
      (v.state === "interrupted" &&
        (v.resultComplete || v.resultSha256 !== null || v.sourceAfter !== null))
    )
      fail(
        "INVALID_EXECUTION_OBSERVATION",
        "Observation cannot claim unavailable terminal evidence",
      );
    if (Buffer.byteLength(JSON.stringify(v)) > 16384)
      fail(
        "EXECUTION_OBSERVATION_LIMIT",
        "Execution observation row exceeds its native cap",
      );
  }
  return envelope;
}
type Row = Record<string, unknown> & { data: string };
function rawRow(
  db: DatabaseSync,
  table: string,
  where: string,
  params: readonly SQLInputValue[],
  cap: number,
): Row | undefined {
  const h = db
    .prepare(
      `SELECT length(CAST(data AS BLOB)) AS bytes FROM ${table} WHERE ${where}`,
    )
    .get(...params);
  if (!h) return undefined;
  if (
    !Number.isSafeInteger(h.bytes) ||
    Number(h.bytes) < 2 ||
    Number(h.bytes) > cap
  )
    fail(
      "EXECUTION_OBSERVATION_READ_LIMIT",
      "Selected native row exceeds metadata read cap",
    );
  const row = db
    .prepare(`SELECT * FROM ${table} WHERE ${where}`)
    .get(...params) as Row | undefined;
  if (
    !row ||
    typeof row.data !== "string" ||
    Buffer.byteLength(row.data) !== h.bytes
  )
    fail(
      "EXECUTION_OBSERVATION_CHANGED",
      "Selected native row changed during bounded read",
    );
  return row;
}
function parsed(row: Row): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(row.data);
  } catch {
    return fail(
      "EXECUTION_OBSERVATION_CORRUPT",
      "Native row has malformed bounded JSON",
    );
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail("EXECUTION_OBSERVATION_CORRUPT", "Native record must be an object");
  return v as Record<string, unknown>;
}
function decoded(
  row: Row,
  table: DiagnosticExecutionObservationTable,
): DiagnosticEffectEpoch | DiagnosticExecutionObservation {
  const body = parsed(row);
  const value = validateDiagnosticExecutionObservationArchiveRow({
    table,
    key: String(
      table === "diagnostic_effect_epochs" ? row.workspace_id : row.id,
    ),
    workspaceId: String(row.workspace_id),
    data: body as unknown as DiagnosticExecutionObservation,
  }).data;
  const v = value as unknown as Record<string, unknown>;
  for (const [column, key] of [
    ["workspace_id", "workspaceId"],
    ["epoch", "epoch"],
    ["revision", "revision"],
    ["ordinal", "ordinal"],
    ["session_id", "sessionId"],
    ["run_id", "runId"],
    ["tool_call_id", "toolCallId"],
    ["turn_id", "turnId"],
    ["attempt_id", "attemptId"],
    ["state", "state"],
  ] as const)
    if (Object.hasOwn(row, column) && row[column] !== v[key])
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Observation SQL owner metadata differs from JSON body",
      );
  return value;
}

function nativeTool(
  db: DatabaseSync,
  owner: DiagnosticExecutionIdentity,
  dispatch: boolean,
): Record<string, unknown> {
  const run = db
      .prepare("SELECT id,workspace_id,session_id,state FROM runs WHERE id=?")
      .get(owner.runId),
    session = db
      .prepare("SELECT id,workspace_id FROM sessions WHERE id=?")
      .get(owner.sessionId),
    tool = rawRow(db, "tools", "id=?", [owner.toolCallId], 1048576),
    turn = db
      .prepare(
        "SELECT id,session_id,run_id,state FROM session_turns WHERE id=?",
      )
      .get(owner.turnId),
    attempt = db
      .prepare(
        "SELECT id,session_id,run_id,turn_id,state FROM provider_attempts WHERE id=?",
      )
      .get(owner.attemptId);
  if (
    !run ||
    !session ||
    !tool ||
    !turn ||
    !attempt ||
    run.workspace_id !== owner.workspaceId ||
    run.session_id !== owner.sessionId ||
    session.workspace_id !== owner.workspaceId ||
    tool.run_id !== owner.runId ||
    tool.session_id !== owner.sessionId ||
    turn.run_id !== owner.runId ||
    turn.session_id !== owner.sessionId ||
    attempt.run_id !== owner.runId ||
    attempt.session_id !== owner.sessionId ||
    attempt.turn_id !== owner.turnId
  )
    fail(
      "EXECUTION_OBSERVATION_OWNER_INVALID",
      "Observation requires the actual workspace Run/session/tool/Turn/Attempt tuple",
    );
  const body = parsed(tool);
  if (
    body.id !== owner.toolCallId ||
    body.runId !== owner.runId ||
    body.sessionId !== owner.sessionId ||
    body.state !== tool.state ||
    typeof body.name !== "string" ||
    !Object.hasOwn(body, "input")
  )
    fail(
      "EXECUTION_OBSERVATION_OWNER_INVALID",
      "Native tool body/index ownership differs",
    );
  identifier(body.name);
  if (
    dispatch &&
    (!["running", "awaiting_approval"].includes(String(run.state)) ||
      tool.state !== "running" ||
      turn.state !== "awaiting_tools" ||
      attempt.state !== "completed")
  )
    fail(
      "EXECUTION_OBSERVATION_NOT_DISPATCHABLE",
      "Requested, denied, waiting or terminal tools cannot acquire dispatch observation",
    );
  const part = db
    .prepare(
      "SELECT id,length(CAST(data AS BLOB)) AS bytes FROM message_parts WHERE run_id=? AND session_id=? AND turn_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.toolCallId')=? LIMIT 2",
    )
    .all(owner.runId, owner.sessionId, owner.turnId, owner.toolCallId);
  if (part.length !== 1)
    fail(
      "EXECUTION_OBSERVATION_OWNER_INVALID",
      "Actual model Tool Part does not bind this invocation",
    );
  const raw = rawRow(
      db,
      "message_parts",
      "id=?",
      [String(part[0]!.id)],
      1048576,
    )!,
    parsedPart = parsed(raw);
  if (
    parsedPart.runId !== owner.runId ||
    parsedPart.sessionId !== owner.sessionId ||
    parsedPart.turnId !== owner.turnId ||
    parsedPart.toolCallId !== owner.toolCallId ||
    parsedPart.name !== body.name ||
    hash(parsedPart.input) !== hash(body.input)
  )
    fail(
      "EXECUTION_OBSERVATION_OWNER_INVALID",
      "Native Tool Part input/name differs from original tool record",
    );
  return body;
}

/** Diagnostic captures grant observation authority only, never effect/retry/approval authority. */
export class DiagnosticExecutionObservationStorage {
  readonly #db: DatabaseSync;
  readonly #ports: DiagnosticExecutionObservationPorts;
  readonly #runtimeEpoch = randomUUID();
  readonly #captures = new WeakMap<
    object,
    { record: DiagnosticExecutionObservation; source: object }
  >();
  readonly #live = new Set<object>();
  constructor(db: DatabaseSync, ports: DiagnosticExecutionObservationPorts) {
    if (
      !ports ||
      typeof ports !== "object" ||
      types.isProxy(ports) ||
      Reflect.ownKeys(ports).some(
        (k) =>
          typeof k !== "string" ||
          !["writeTx", "readSourceSnapshot", "now"].includes(k) ||
          !("value" in Object.getOwnPropertyDescriptor(ports, k)!),
      )
    )
      fail(
        "INVALID_EXECUTION_OBSERVATION_PORTS",
        "Native observation ports require explicit trusted data callbacks",
      );
    if (
      typeof ports.writeTx !== "function" ||
      typeof ports.readSourceSnapshot !== "function" ||
      (ports.now !== undefined && typeof ports.now !== "function")
    )
      fail(
        "INVALID_EXECUTION_OBSERVATION_PORTS",
        "Native observation callbacks are missing",
      );
    this.#db = db;
    this.#ports = Object.freeze({ ...ports });
  }
  private now(): string {
    return new Date(
      integer(this.#ports.now?.() ?? Date.now(), 8640000000000000),
    ).toISOString();
  }
  private write<T>(op: () => T): T {
    if (this.#db.isTransaction) return op();
    let entered = false;
    const result = this.#ports.writeTx(() => {
      if (entered || !this.#db.isTransaction)
        fail(
          "EXECUTION_OBSERVATION_TRANSACTION_REQUIRED",
          "Observation must use exactly one primary transaction",
        );
      entered = true;
      return op();
    });
    if (!entered || (result && typeof result === "object" && "then" in result))
      fail(
        "EXECUTION_OBSERVATION_TRANSACTION_REQUIRED",
        "Observation transaction cannot detach",
      );
    return result;
  }
  getEpoch(workspaceId: string): DiagnosticEffectEpoch | undefined {
    identifier(workspaceId);
    const row = rawRow(
      this.#db,
      "diagnostic_effect_epochs",
      "workspace_id=?",
      [workspaceId],
      4096,
    );
    return row
      ? (decoded(row, "diagnostic_effect_epochs") as DiagnosticEffectEpoch)
      : undefined;
  }
  getObservation(
    workspaceId: string,
    toolCallId: string,
  ): DiagnosticExecutionObservation | undefined {
    identifier(workspaceId);
    identifier(toolCallId);
    const row = rawRow(
      this.#db,
      "diagnostic_execution_observations",
      "workspace_id=? AND tool_call_id=?",
      [workspaceId, toolCallId],
      16384,
    );
    return row
      ? (decoded(
          row,
          "diagnostic_execution_observations",
        ) as DiagnosticExecutionObservation)
      : undefined;
  }
  private setEpoch(workspaceId: string, bump: boolean): DiagnosticEffectEpoch {
    const previous = this.getEpoch(workspaceId),
      next = signed({
        workspaceId,
        epoch: (previous?.epoch ?? 0) + (bump ? 1 : 0),
        revision: (previous?.revision ?? 0) + 1,
        updatedAt: this.now(),
      });
    if (previous) {
      const result = this.#db
        .prepare(
          "UPDATE diagnostic_effect_epochs SET epoch=?,revision=?,data=? WHERE workspace_id=? AND epoch=? AND revision=? AND data=?",
        )
        .run(
          next.epoch,
          next.revision,
          JSON.stringify(next),
          workspaceId,
          previous.epoch,
          previous.revision,
          JSON.stringify(previous),
        );
      if (Number(result.changes) !== 1)
        fail(
          "EXECUTION_OBSERVATION_STALE",
          "Workspace effect epoch CAS changed",
        );
    } else
      this.#db
        .prepare(
          "INSERT INTO diagnostic_effect_epochs(workspace_id,epoch,revision,data) VALUES(?,?,?,?)",
        )
        .run(workspaceId, next.epoch, next.revision, JSON.stringify(next));
    return next;
  }
  dispatch(
    input: DiagnosticExecutionIdentity,
    originalSourceHandle: object,
  ): DiagnosticExecutionDispatch {
    const owner = identity(input);
    if (
      !originalSourceHandle ||
      typeof originalSourceHandle !== "object" ||
      types.isProxy(originalSourceHandle)
    )
      fail(
        "EXECUTION_OBSERVATION_SOURCE_INVALID",
        "Dispatch needs an original trusted source handle",
      );
    if (this.#live.size >= 128)
      fail(
        "EXECUTION_OBSERVATION_LIMIT",
        "Original active observation captures exceed the host cap",
      );
    const record = this.write(() => {
      const tool = nativeTool(this.#db, owner, true);
      if (this.getObservation(owner.workspaceId, owner.toolCallId))
        fail(
          "EXECUTION_OBSERVATION_DUPLICATE",
          "The actual tool invocation was already dispatched; no replay or second capture",
        );
      const observed = metadata(
        this.#ports.readSourceSnapshot(originalSourceHandle, "before"),
      );
      if (!sameIdentity(owner, observed))
        fail(
          "EXECUTION_OBSERVATION_SOURCE_INVALID",
          "Original source handle belongs to another execution",
        );
      const current = nativeTool(this.#db, owner, true);
      if (hash(current) !== hash(tool))
        fail(
          "EXECUTION_OBSERVATION_STALE",
          "Native tool changed during source validation",
        );
      const before = this.getEpoch(owner.workspaceId)?.epoch ?? 0,
        epoch = this.setEpoch(
          owner.workspaceId,
          ["write", "execute", "network", "unknown"].includes(
            observed.effectClass,
          ),
        ),
        ordinal = integer(
          Number(
            this.#db
              .prepare(
                "SELECT coalesce(max(ordinal),0)+1 AS ordinal FROM diagnostic_execution_observations",
              )
              .get()!.ordinal,
          ),
        );
      const record: DiagnosticExecutionObservation = signed({
        ...owner,
        schemaVersion: 1 as const,
        id: randomUUID(),
        ordinal,
        runtimeEpoch: this.#runtimeEpoch,
        revision: 1,
        state: "dispatched" as const,
        toolName: String(tool.name),
        effectClass: observed.effectClass,
        inputSha256: hash(tool.input),
        effectiveInputSha256: observed.effectiveInputSha256,
        dispatchToolSha256: hash(tool),
        settledToolSha256: null,
        resultSha256: null,
        resultComplete: false,
        outcome: "unknown" as const,
        sourceBefore: observed.source,
        sourceAfter: null,
        effectEpochBefore: before,
        effectEpochDispatch: epoch.epoch,
        effectEpochAfter: null,
        dispatchedAt: this.now(),
        settledAt: null,
      });
      validateDiagnosticExecutionObservationArchiveRow({
        table: "diagnostic_execution_observations",
        key: record.id,
        workspaceId: owner.workspaceId,
        data: record,
      });
      this.#db
        .prepare(
          "INSERT INTO diagnostic_execution_observations(ordinal,id,workspace_id,session_id,run_id,tool_call_id,turn_id,attempt_id,state,revision,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          record.ordinal,
          record.id,
          record.workspaceId,
          record.sessionId,
          record.runId,
          record.toolCallId,
          record.turnId,
          record.attemptId,
          record.state,
          record.revision,
          JSON.stringify(record),
        );
      return record;
    });
    const capture: DiagnosticExecutionCapture = Object.freeze({
      ...owner,
      observationId: record.id,
      runtimeEpoch: this.#runtimeEpoch,
    });
    this.#captures.set(capture, { record, source: originalSourceHandle });
    this.#live.add(capture);
    return Object.freeze({ capture, record });
  }
  private owned(capture: DiagnosticExecutionCapture): {
    record: DiagnosticExecutionObservation;
    source: object;
  } {
    if (
      !capture ||
      typeof capture !== "object" ||
      types.isProxy(capture) ||
      !this.#live.has(capture)
    )
      fail(
        "EXECUTION_OBSERVATION_CAPTURE_INVALID",
        "Observation capability is copied, released, foreign or never issued",
      );
    const owned = this.#captures.get(capture)!,
      actual = this.getObservation(
        owned.record.workspaceId,
        owned.record.toolCallId,
      );
    if (
      !actual ||
      actual.runtimeEpoch !== this.#runtimeEpoch ||
      actual.sha256 !== owned.record.sha256
    )
      fail(
        "EXECUTION_OBSERVATION_STALE",
        "Original native observation changed",
      );
    return owned;
  }
  private save(
    previous: DiagnosticExecutionObservation,
    next: DiagnosticExecutionObservation,
  ): void {
    validateDiagnosticExecutionObservationArchiveRow({
      table: "diagnostic_execution_observations",
      key: next.id,
      workspaceId: next.workspaceId,
      data: next,
    });
    const result = this.#db
      .prepare(
        "UPDATE diagnostic_execution_observations SET state=?,revision=?,data=? WHERE id=? AND workspace_id=? AND state=? AND revision=? AND data=?",
      )
      .run(
        next.state,
        next.revision,
        JSON.stringify(next),
        previous.id,
        previous.workspaceId,
        previous.state,
        previous.revision,
        JSON.stringify(previous),
      );
    if (Number(result.changes) !== 1)
      fail(
        "EXECUTION_OBSERVATION_STALE",
        "Original dispatch observation CAS changed",
      );
  }
  settle(capture: DiagnosticExecutionCapture): DiagnosticExecutionObservation {
    const issued = this.owned(capture);
    if (issued.record.state === "settled") return issued.record;
    const record = this.write(() => {
      const owned = this.owned(capture),
        previous = owned.record;
      if (previous.state !== "dispatched")
        fail(
          "EXECUTION_OBSERVATION_TERMINAL",
          "Interrupted observations cannot become successful on replay",
        );
      const tool = nativeTool(this.#db, previous, false);
      if (!["completed", "failed", "interrupted"].includes(String(tool.state)))
        fail(
          "EXECUTION_OBSERVATION_NOT_SETTLED",
          "Actual tool result is not durably terminal",
        );
      if (
        hash(tool.input) !== previous.inputSha256 ||
        tool.name !== previous.toolName
      )
        fail(
          "EXECUTION_OBSERVATION_STALE",
          "Native terminal tool original input/name changed",
        );
      const observed = metadata(
        this.#ports.readSourceSnapshot(owned.source, "after"),
      );
      if (
        !sameIdentity(previous, observed) ||
        observed.effectClass !== previous.effectClass ||
        observed.effectiveInputSha256 !== previous.effectiveInputSha256
      )
        fail(
          "EXECUTION_OBSERVATION_SOURCE_INVALID",
          "Post source handle changed original execution metadata",
        );
      const after = nativeTool(this.#db, previous, false);
      if (hash(after) !== hash(tool))
        fail(
          "EXECUTION_OBSERVATION_STALE",
          "Actual terminal tool changed during post-source validation",
        );
      const outcome = tool.state as "completed" | "failed" | "interrupted",
        outputObserved = typeof tool.output === "string",
        resultSha256 = outputObserved
          ? hash({ outcome, output: tool.output, error: tool.error ?? null })
          : null,
        { sha256: ignored, ...base } = previous,
        next: DiagnosticExecutionObservation = signed({
          ...base,
          revision: previous.revision + 1,
          state: "settled" as const,
          settledToolSha256: hash(tool),
          resultSha256,
          resultComplete:
            outcome === "completed" &&
            outputObserved &&
            tool.error === undefined &&
            observed.resultComplete === true,
          outcome,
          sourceAfter: observed.source,
          effectEpochAfter: this.getEpoch(previous.workspaceId)?.epoch ?? 0,
          settledAt: this.now(),
        });
      this.save(previous, next);
      return next;
    });
    this.#captures.set(capture, { record, source: issued.source });
    return record;
  }
  private interrupt(
    previous: DiagnosticExecutionObservation,
  ): DiagnosticExecutionObservation {
    const { sha256: ignored, ...base } = previous,
      next: DiagnosticExecutionObservation = signed({
        ...base,
        revision: previous.revision + 1,
        state: "interrupted" as const,
        outcome: "unknown" as const,
        resultComplete: false,
        settledToolSha256: null,
        resultSha256: null,
        sourceAfter: null,
        effectEpochAfter:
          this.getEpoch(previous.workspaceId)?.epoch ??
          previous.effectEpochDispatch,
        settledAt: this.now(),
      });
    this.save(previous, next);
    return next;
  }
  release(capture: DiagnosticExecutionCapture): void {
    if (
      !capture ||
      typeof capture !== "object" ||
      types.isProxy(capture) ||
      !this.#live.has(capture)
    )
      fail(
        "EXECUTION_OBSERVATION_CAPTURE_INVALID",
        "Release requires the original issued observation capability",
      );
    const issued = this.#captures.get(capture)!;
    try {
      const actual = this.getObservation(
        issued.record.workspaceId,
        issued.record.toolCallId,
      );
      // An outer primary transaction can roll back after dispatch returned. No row
      // or a replaced row grants this capability authority to rewrite a successor.
      if (
        !actual ||
        actual.sha256 !== issued.record.sha256 ||
        actual.runtimeEpoch !== this.#runtimeEpoch
      )
        return;
      if (actual.state === "dispatched")
        this.write(() => this.interrupt(this.owned(capture).record));
    } finally {
      this.#captures.delete(capture);
      this.#live.delete(capture);
    }
  }
  recoverInterruptedOwners(): number {
    let count = 0;
    for (const h of this.#db
      .prepare(
        "SELECT workspace_id,tool_call_id FROM diagnostic_execution_observations WHERE state='dispatched' ORDER BY ordinal",
      )
      .iterate()) {
      if (++count > 4096)
        fail(
          "EXECUTION_OBSERVATION_LIMIT",
          "Interrupted observation sweep exceeds original cap",
        );
      this.write(() => {
        const row = this.getObservation(
          String(h.workspace_id),
          String(h.tool_call_id),
        )!;
        if (row.runtimeEpoch !== this.#runtimeEpoch) this.interrupt(row);
      });
    }
    return count;
  }
  listRun(
    workspaceId: string,
    runId: string,
    input: DiagnosticExecutionPageOptions = {},
  ): DiagnosticExecutionPage {
    identifier(workspaceId);
    identifier(runId);
    const options = json(input);
    fields(
      options,
      [],
      ["afterOrdinal", "throughOrdinal", "limit", "maxBytes"],
    );
    const after = integer(options.afterOrdinal ?? 0),
      limit = integer(options.limit ?? 100, 100),
      cap = integer(options.maxBytes ?? 1048576, 1048576);
    if (limit < 1 || cap < 256)
      fail(
        "INVALID_EXECUTION_OBSERVATION",
        "Page reservation must be positive and bounded",
      );
    const run = this.#db
      .prepare("SELECT workspace_id FROM runs WHERE id=?")
      .get(runId);
    if (!run || run.workspace_id !== workspaceId)
      fail(
        "EXECUTION_OBSERVATION_OWNER_INVALID",
        "Observation selector must be the exact existing workspace Run",
      );
    const through =
      options.throughOrdinal === undefined
        ? Number(
            this.#db
              .prepare(
                "SELECT coalesce(max(ordinal),0) AS ordinal FROM diagnostic_execution_observations WHERE workspace_id=? AND run_id=?",
              )
              .get(workspaceId, runId)!.ordinal,
          )
        : integer(options.throughOrdinal);
    if (through < after)
      fail(
        "INVALID_EXECUTION_OBSERVATION",
        "Observation page bounds moved backwards",
      );
    const headers = this.#db
      .prepare(
        "SELECT ordinal,tool_call_id,length(CAST(data AS BLOB)) AS bytes FROM diagnostic_execution_observations WHERE workspace_id=? AND run_id=? AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT ?",
      )
      .all(workspaceId, runId, after, through, limit + 1);
    const items: DiagnosticExecutionObservation[] = [];
    let bytes = 0;
    for (const h of headers.slice(0, limit)) {
      const size = integer(Number(h.bytes), 16384);
      if (bytes + size + items.length + 256 > cap) {
        if (!items.length)
          fail(
            "EXECUTION_OBSERVATION_LIMIT",
            "Original record cannot fit the whole-row page budget",
          );
        break;
      }
      const row = this.getObservation(workspaceId, String(h.tool_call_id))!;
      items.push(row);
      bytes += size;
    }
    const result = {
      items: Object.freeze(items),
      next:
        headers.length > items.length ? (items.at(-1)?.ordinal ?? null) : null,
      throughOrdinal: through,
      bytes: 0,
    };
    result.bytes = Buffer.byteLength(JSON.stringify(result));
    result.bytes = Buffer.byteLength(JSON.stringify(result));
    if (result.bytes > cap)
      fail(
        "EXECUTION_OBSERVATION_LIMIT",
        "Serialized diagnostic page exceeds its bounded reservation",
      );
    return Object.freeze(result);
  }
}

/** Existing native records remain the authority; imported descriptions cannot manufacture a read proof. */
export function validateDiagnosticExecutionObservationDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): void {
  let rows = 0,
    bytes = 0;
  for (const h of db
    .prepare(
      "SELECT workspace_id,length(CAST(data AS BLOB)) AS bytes FROM diagnostic_effect_epochs ORDER BY workspace_id",
    )
    .iterate()) {
    check();
    if (++rows > 65536 || (bytes += integer(Number(h.bytes), 4096)) > 67108864)
      fail(
        "EXECUTION_OBSERVATION_LIMIT",
        "Native diagnostic validation exceeds bounded rows/bytes",
      );
    const raw = rawRow(
        db,
        "diagnostic_effect_epochs",
        "workspace_id=?",
        [String(h.workspace_id)],
        4096,
      )!,
      epoch = decoded(raw, "diagnostic_effect_epochs") as DiagnosticEffectEpoch;
    const count = db
      .prepare(
        "SELECT count(*) AS count FROM diagnostic_execution_observations WHERE workspace_id=?",
      )
      .get(epoch.workspaceId)!.count;
    if (count !== epoch.revision)
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Workspace effect counter lacks its exact actual dispatch frontier",
      );
  }
  const workspaceEpochs = new Map<string, number>();
  for (const h of db
    .prepare(
      "SELECT ordinal,id,workspace_id,length(CAST(data AS BLOB)) AS bytes FROM diagnostic_execution_observations ORDER BY ordinal",
    )
    .iterate()) {
    check();
    if (++rows > 65536 || (bytes += integer(Number(h.bytes), 16384)) > 67108864)
      fail(
        "EXECUTION_OBSERVATION_LIMIT",
        "Native execution validation exceeds bounded rows/bytes",
      );
    const row = rawRow(
        db,
        "diagnostic_execution_observations",
        "id=?",
        [String(h.id)],
        16384,
      )!,
      record = decoded(
        row,
        "diagnostic_execution_observations",
      ) as DiagnosticExecutionObservation,
      tool = nativeTool(db, record, false);
    if (
      record.toolName !== tool.name ||
      record.inputSha256 !== hash(tool.input)
    )
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Historical diagnostic input no longer binds its actual native tool",
      );
    const before = workspaceEpochs.get(record.workspaceId) ?? 0;
    if (record.effectEpochBefore !== before)
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Diagnostic effect epochs are not monotonic actual dispatches",
      );
    workspaceEpochs.set(record.workspaceId, record.effectEpochDispatch);
    if (workspaceEpochs.size > 4096)
      fail(
        "EXECUTION_OBSERVATION_LIMIT",
        "Diagnostic workspace frontier exceeds its bounded count",
      );
    const epochRaw = rawRow(
      db,
      "diagnostic_effect_epochs",
      "workspace_id=?",
      [record.workspaceId],
      4096,
    );
    if (!epochRaw)
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Actual execution observation has no effect epoch frontier",
      );
    const epoch = decoded(
      epochRaw,
      "diagnostic_effect_epochs",
    ) as DiagnosticEffectEpoch;
    if (
      record.effectEpochDispatch > epoch.epoch ||
      (record.effectEpochAfter !== null &&
        record.effectEpochAfter > epoch.epoch)
    )
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Execution observation claims a future effect boundary",
      );
    if (
      record.state === "settled" &&
      (record.outcome !== tool.state ||
        record.settledToolSha256 !== hash(tool) ||
        record.resultSha256 !==
          (typeof tool.output === "string"
            ? hash({
                outcome: tool.state,
                output: tool.output,
                error: tool.error ?? null,
              })
            : null) ||
        (record.resultComplete &&
          (tool.state !== "completed" || tool.error !== undefined)))
    )
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Settled diagnostic result does not match exact native output/state",
      );
    if (
      record.state === "dispatched" &&
      tool.state === "running" &&
      record.dispatchToolSha256 !== hash(tool)
    )
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Active native tool changed its original dispatch identity",
      );
  }
  for (const [workspaceId, expected] of workspaceEpochs) {
    const row = rawRow(
      db,
      "diagnostic_effect_epochs",
      "workspace_id=?",
      [workspaceId],
      4096,
    )!;
    if (
      (decoded(row, "diagnostic_effect_epochs") as DiagnosticEffectEpoch)
        .epoch !== expected
    )
      fail(
        "EXECUTION_OBSERVATION_CORRUPT",
        "Current effect epoch differs from its exact committed dispatches",
      );
  }
}
