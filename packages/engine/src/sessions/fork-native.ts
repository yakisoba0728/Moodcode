import {
  validateInputRecord,
  validateMessagePart,
  validateProviderAttempt,
  validateTurnRecord,
} from "@moodcode/contracts/validation";
import { validateForkChildDatabase } from "./fork-child.js";
import type { DatabaseSync } from "node:sqlite";
import {
  isTerminal,
  type SessionSnapshot,
  type Session,
  type JsonObject,
  type AcceptInput,
  type InputReceipt,
} from "@moodcode/contracts";
import {
  FORK_KIND,
  FORK_IMPORT_KIND,
  FORK_LIMITS,
  FORK_PROFILE_ID,
  boundedRow,
  decode,
  forkHash,
  forkJson,
  forkId,
  forkError,
  signedFork,
  type ConversationFork,
  type FrozenHistoryManifest,
  type ForkSourcePin,
  type ForkPreview,
  type ForkResult,
} from "./fork-types.js";
const TABLES = [
  "runs",
  "messages",
  "tools",
  "approvals",
  "checkpoints",
  "session_turns",
  "provider_attempts",
  "message_parts",
  "attempt_cleanup",
] as const;
function sourceSequences(
  db: DatabaseSync,
  sessionId: string,
): { legacySeq: number; nativeSeq: number } {
  return {
    legacySeq: Number(
      db.prepare("SELECT last_seq FROM sessions WHERE id=?").get(sessionId)
        ?.last_seq,
    ),
    nativeSeq: Number(
      db
        .prepare("SELECT last_seq FROM session_sequences WHERE session_id=?")
        .get(sessionId)?.last_seq ?? 0,
    ),
  };
}
function assertRecordHash(record: { sha256: string }): void {
  if (record.sha256 !== signedFork(record).sha256)
    forkError("FORK_NATIVE_INVALID", "Signed fork DATA changed");
}
function scopedRow(
  table: string,
  row: Record<string, unknown>,
  sessionId: string,
  runIds: Set<string>,
): any {
  const value = decode(row);
  if (
    (table === "attempt_cleanup"
      ? value.attemptId !== row.attempt_id
      : value.id !== row.id) ||
    (value.runId && (value.runId !== row.run_id || !runIds.has(value.runId))) ||
    (value.sessionId && value.sessionId !== sessionId) ||
    (table === "runs" &&
      (value.sessionId !== sessionId || value.state !== row.state)) ||
    (row.session_id !== undefined && row.session_id !== sessionId) ||
    (row.state !== undefined && value.state !== row.state)
  )
    forkError(
      "FORK_NATIVE_INVALID",
      "Native history payload disagrees with its actual SQL owner",
    );
  for (const [sql, field] of [
    ["run_id", "runId"],
    ["session_id", "sessionId"],
    ["workspace_id", "workspaceId"],
    ["turn_id", "turnId"],
    ["tool_call_id", "toolCallId"],
    ["input_id", "inputId"],
  ] as const)
    if (row[sql] !== undefined && value[field] !== row[sql])
      forkError(
        "FORK_NATIVE_INVALID",
        "Frozen source SQL relation differs from its producer payload",
      );
  if (table === "session_turns") validateTurnRecord(value);
  if (table === "provider_attempts") validateProviderAttempt(value);
  if (table === "message_parts") validateMessagePart(value);
  return value;
}
/** Whole completed Run groups; cardinality and bytes are checked before any JSON materialization. */
export function captureForkSource(
  db: DatabaseSync,
  sourceSessionId: string,
  throughRunId?: string,
): FrozenHistoryManifest {
  forkId(sourceSessionId);
  const session = decode(
    boundedRow(db, "sessions", "id=?", [sourceSessionId]),
  ) as Session;
  if (session.id !== sourceSessionId)
    forkError("FORK_NATIVE_INVALID", "Source Session identity changed");
  const newest = db
    .prepare(
      "SELECT id,ordinal,state FROM runs WHERE session_id=? ORDER BY ordinal DESC LIMIT 1",
    )
    .get(sourceSessionId);
  if (!newest || !isTerminal(String(newest.state) as any))
    forkError(
      "FORK_SOURCE_ACTIVE",
      "Source session requires a terminal actual Run",
    );
  const cutoff = throughRunId
    ? db
        .prepare(
          "SELECT id,ordinal,state FROM runs WHERE session_id=? AND id=?",
        )
        .get(sourceSessionId, forkId(throughRunId))
    : newest;
  if (!cutoff || !isTerminal(String(cutoff.state) as any))
    forkError(
      "FORK_SOURCE_ACTIVE",
      "Fork boundary is not a completed native Run",
    );
  const selected = db
    .prepare(
      "SELECT id FROM runs WHERE session_id=? AND ordinal<=? ORDER BY ordinal DESC LIMIT ?",
    )
    .all(sourceSessionId, cutoff.ordinal!, FORK_LIMITS.runs)
    .reverse();
  const ids = selected.map((row) => String(row.id)),
    runIds = new Set(ids),
    placeholders = ids.map(() => "?").join(",");
  const { legacySeq, nativeSeq } = sourceSequences(db, sourceSessionId);
  const snapshot: SessionSnapshot = {
    session,
    runs: [],
    messages: [],
    tools: [],
    approvals: [],
    lastSeq: legacySeq,
  };
  const pins: ForkSourcePin[] = [];
  let totalBytes = Buffer.byteLength(JSON.stringify(session));
  for (const table of TABLES) {
    const where =
      table === "runs"
        ? `id IN (${placeholders})`
        : `run_id IN (${placeholders})`;
    const keyColumn = table === "attempt_cleanup" ? "attempt_id" : "id";
    const headers = db
      .prepare(
        `SELECT ${keyColumn} AS id,length(CAST(data AS BLOB)) bytes FROM ${table} WHERE ${where} ORDER BY rowid LIMIT ?`,
      )
      .all(...ids, FORK_LIMITS.pins + 1);
    totalBytes += headers.reduce((sum, row) => sum + Number(row.bytes), 0);
    if (
      headers.length + pins.length > FORK_LIMITS.pins ||
      totalBytes > FORK_LIMITS.sourceBytes ||
      (table === "messages" && headers.length > FORK_LIMITS.messages)
    )
      forkError(
        "FORK_LIMIT",
        "Selected whole native history exceeds the bounded fork window",
      );
    for (const header of headers) {
      const row = boundedRow(db, table, `${keyColumn}=?`, [String(header.id)])!,
        value = scopedRow(table, row, sourceSessionId, runIds);
      if (
        table === "runs" &&
        (!isTerminal(value.state) ||
          value.state === "interrupted" ||
          ["CLEANUP_UNCERTAIN", "ENGINE_INTERRUPTED"].includes(
            value.error?.code,
          ))
      )
        forkError(
          "FORK_CLEANUP_UNCERTAIN",
          "Interrupted source effects cannot be granted a fork",
        );
      if (
        table === "tools" &&
        !["completed", "failed", "denied"].includes(value.state)
      )
        forkError(
          "FORK_CLEANUP_UNCERTAIN",
          "Source tool has no terminal known outcome",
        );
      if (
        table === "provider_attempts" &&
        [
          "prepared",
          "dispatched",
          "streaming",
          "interrupted",
          "uncertain",
        ].includes(value.state)
      )
        forkError(
          "FORK_CLEANUP_UNCERTAIN",
          "Source provider Attempt is unresolved",
        );
      if (
        table === "attempt_cleanup" &&
        (!["confirmed", "not-dispatched"].includes(value.state) ||
          (value.state === "confirmed" && value.cleanupConfirmed !== true) ||
          (value.state === "not-dispatched" && value.cleanupConfirmed !== null))
      )
        forkError(
          "FORK_CLEANUP_UNCERTAIN",
          "Source provider cleanup is unresolved",
        );
      pins.push({ table, id: String(header.id), sha256: forkHash(value) });
      if (table === "runs") snapshot.runs.push(value);
      if (table === "messages") snapshot.messages.push(value);
      if (table === "tools") snapshot.tools.push(value);
      if (table === "approvals") snapshot.approvals.push(value);
    }
  }
  const later = db
    .prepare(
      "SELECT id FROM runs WHERE session_id=? AND ordinal>? ORDER BY ordinal LIMIT 65",
    )
    .all(sourceSessionId, cutoff.ordinal!);
  if (later.length > 64)
    forkError("FORK_LIMIT", "Later-effect disposition exceeds its bound");
  return forkJson(
    signedFork({
      version: 1 as const,
      sourceSessionId,
      sourceWorkspaceId: session.workspaceId,
      throughRunId: String(cutoff.id),
      legacySeq,
      nativeSeq,
      snapshot,
      pins,
      omittedRuns:
        Number(
          db
            .prepare(
              "SELECT count(*) n FROM runs WHERE session_id=? AND ordinal<=?",
            )
            .get(sourceSessionId, cutoff.ordinal!)!.n,
        ) - ids.length,
      laterRunIds: later.map((row) => String(row.id)),
    }),
  );
}
export function assertFrozenManifest(source: FrozenHistoryManifest): void {
  assertRecordHash(source);
  if (
    source.version !== 1 ||
    source.snapshot.session.id !== source.sourceSessionId ||
    source.snapshot.session.workspaceId !== source.sourceWorkspaceId ||
    source.snapshot.runs.length > FORK_LIMITS.runs ||
    source.snapshot.messages.length > FORK_LIMITS.messages ||
    source.pins.length > FORK_LIMITS.pins
  )
    forkError("FORK_NATIVE_INVALID", "Frozen manifest shape is inconsistent");
  const runs = new Set(source.snapshot.runs.map((run) => run.id)),
    seen = new Set<string>();
  if (
    runs.size !== source.snapshot.runs.length ||
    source.snapshot.runs.at(-1)?.id !== source.throughRunId ||
    !Number.isSafeInteger(source.omittedRuns) ||
    source.omittedRuns < 0 ||
    source.laterRunIds.length > 64
  )
    forkError("FORK_NATIVE_INVALID", "Frozen Run lineage is malformed");
  for (const pin of source.pins) {
    if (
      !TABLES.includes(pin.table as any) ||
      seen.has(`${pin.table}:${pin.id}`) ||
      !/^[a-f0-9]{64}$/.test(pin.sha256)
    )
      forkError("FORK_NATIVE_INVALID", "Frozen native source pins are invalid");
    seen.add(`${pin.table}:${pin.id}`);
  }
  for (const [table, rows] of [
    ["runs", source.snapshot.runs],
    ["messages", source.snapshot.messages],
    ["tools", source.snapshot.tools],
    ["approvals", source.snapshot.approvals],
  ] as const)
    for (const row of rows) {
      if (
        row.sessionId !== source.sourceSessionId ||
        (table === "runs" && !isTerminal((row as any).state)) ||
        (table !== "runs" && !runs.has((row as any).runId)) ||
        !source.pins.some(
          (pin) =>
            pin.table === table &&
            pin.id === row.id &&
            pin.sha256 === forkHash(row),
        )
      )
        forkError(
          "FORK_NATIVE_INVALID",
          "Frozen body has no exact original native identity/hash",
        );
    }
}
export function assertForkSourceCurrent(
  db: DatabaseSync,
  source: FrozenHistoryManifest,
  fresh: boolean,
): void {
  assertFrozenManifest(source);
  const runIds = new Set(source.snapshot.runs.map((run) => run.id));
  for (const pin of source.pins) {
    const keyColumn = pin.table === "attempt_cleanup" ? "attempt_id" : "id";
    const row = boundedRow(db, pin.table, `${keyColumn}=?`, [pin.id]);
    if (
      !row ||
      forkHash(scopedRow(pin.table, row, source.sourceSessionId, runIds)) !==
        pin.sha256
    )
      forkError("FORK_SOURCE_STALE", "Frozen source native row changed");
  }
  if (!fresh) return;
  const current = sourceSequences(db, source.sourceSessionId);
  if (
    current.legacySeq !== source.legacySeq ||
    current.nativeSeq !== source.nativeSeq
  )
    forkError(
      "FORK_SOURCE_STALE",
      "Source journal advanced after the approved preview",
    );
}
export interface ForkNativePorts {
  createSession(session: Session): void;
  putDocument(
    sessionId: string,
    kind: string,
    revision: number,
    data: JsonObject,
  ): void;
  appendEvent(
    sessionId: string,
    type: string,
    payload: JsonObject,
    refs?: { inputId?: string },
  ): void;
  accept(input: AcceptInput): InputReceipt;
  assertPreview(original: object, preview: ForkPreview): void;
  readPreview(original: object): ForkPreview;
  afterCommit(operation: () => void): void;
  wake(sessionId: string): void;
}
export function assertForkRecordShape(
  record: ConversationFork,
  code: string,
): void {
  const { preview } = record,
    config: unknown = preview.config;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    preview.readonlyFirstRun !== true ||
    preview.effectsRetained !== true ||
    preview.config.mode !== "plan" ||
    preview.config.agentProfileId !== FORK_PROFILE_ID ||
    !Number.isSafeInteger(preview.depth) ||
    preview.depth < 1 ||
    preview.depth > FORK_LIMITS.depth ||
    record.version !== 1 ||
    preview.targetSessionId !== record.sessionId ||
    record.workspaceId !== preview.targetWorkspaceId ||
    record.approvalFingerprint !== preview.sha256 ||
    record.origin !== "host-fork"
  )
    forkError(code, "Fork record lineage identity changed");
}
export function readConversationFork(
  db: DatabaseSync,
  sessionId: string,
): ConversationFork | null {
  const row = boundedRow(
    db,
    "session_documents",
    "session_id=? AND kind=?",
    [sessionId, FORK_KIND],
    FORK_LIMITS.recordBytes,
  );
  if (!row) return null;
  const record = decode(row) as ConversationFork;
  assertRecordHash(record);
  assertRecordHash(record.preview);
  if (record.sessionId !== sessionId)
    forkError("FORK_NATIVE_INVALID", "Native fork lineage identity changed");
  assertForkRecordShape(record, "FORK_NATIVE_INVALID");
  const session = decode(boundedRow(db, "sessions", "id=?", [sessionId]));
  const markerRow = boundedRow(
      db,
      "session_documents",
      "session_id=? AND kind=?",
      [sessionId, FORK_IMPORT_KIND],
    ),
    marker = markerRow ? decode(markerRow) : null;
  const targetOnly = marker?.kind === "target-only-history";
  if (
    session.workspaceId !==
    (targetOnly ? marker.workspaceId : record.workspaceId)
  )
    forkError("FORK_NATIVE_INVALID", "Fork target Session changed");
  const type = targetOnly
    ? "conversation.fork.imported"
    : "conversation.fork.materialized";
  const headers = db
    .prepare(
      "SELECT seq FROM session_events WHERE session_id=? AND type=? LIMIT 2",
    )
    .all(sessionId, type);
  const anchors = headers.map((row) =>
    boundedRow(db, "session_events", "session_id=? AND seq=?", [
      sessionId,
      Number(row.seq),
    ]),
  );
  if (
    anchors.length !== 1 ||
    forkHash(decode(anchors[0]).payload.record) !== forkHash(record)
  )
    forkError(
      "FORK_NATIVE_INVALID",
      "Fork lineage lacks its independent immutable admission event",
    );
  if (targetOnly) {
    if (
      marker.paused !== true ||
      marker.sourceRecordSha256 !== record.sha256 ||
      forkHash(decode(anchors[0]).payload.importProof) !== forkHash(marker)
    )
      forkError(
        "FORK_NATIVE_INVALID",
        "Paused imported history evidence changed",
      );
  } else {
    const input = validateInputRecord(
      decode(
        boundedRow(db, "session_inputs", "id=? AND session_id=?", [
          record.input.inputId,
          sessionId,
        ]),
      ),
    );
    const acceptance = boundedRow(
      db,
      "session_events",
      "session_id=? AND seq=? AND type='input.accepted'",
      [sessionId, record.input.admittedSeq],
    );
    const admitted = acceptance ? decode(acceptance).payload.input : null;
    if (
      input.admittedSeq !== record.input.admittedSeq ||
      record.input.state !== "pending" ||
      record.input.duplicate !== false ||
      !admitted ||
      acceptance!.input_id !== input.id ||
      admitted.id !== input.id ||
      admitted.sessionId !== sessionId ||
      admitted.state !== "pending" ||
      admitted.admittedSeq !== record.input.admittedSeq ||
      forkHash(admitted.config) !== forkHash(input.config) ||
      admitted.prompt !== input.prompt ||
      admitted.requestId !== input.requestId
    )
      forkError(
        "FORK_NATIVE_INVALID",
        "Fork input lost its exact genuine queue-acceptance receipt",
      );
    if (
      input.requestId !== `fork:${record.id}` ||
      input.prompt !== record.preview.prompt ||
      forkHash(input.config) !== forkHash(record.preview.config)
    )
      forkError("FORK_NATIVE_INVALID", "Fork first actual input changed");
  }
  assertFrozenManifest(record.preview.source);
  return forkJson(record);
}
export function materializeConversationFork(
  db: DatabaseSync,
  original: object,
  requestId: string,
  approvalFingerprint: string,
  ports: ForkNativePorts,
): ForkResult {
  forkId(requestId);
  const allHeads = db
    .prepare(
      "SELECT length(CAST(data AS BLOB)) bytes FROM session_documents WHERE kind=? LIMIT 513",
    )
    .all(FORK_KIND);
  if (
    allHeads.length > 512 ||
    allHeads.some((row) => Number(row.bytes) > FORK_LIMITS.recordBytes)
  )
    forkError("FORK_LIMIT", "Native fork request lookup exceeds bounded heads");
  const existing = db
    .prepare(
      "SELECT session_id FROM session_documents WHERE kind=? AND json_extract(data,'$.requestId')=? LIMIT 2",
    )
    .all(FORK_KIND, requestId);
  if (existing.length > 1)
    forkError("FORK_NATIVE_INVALID", "Fork request is aliased");
  if (existing.length) {
    const record = readConversationFork(db, String(existing[0]!.session_id))!;
    if (record.approvalFingerprint !== approvalFingerprint)
      forkError(
        "FORK_REQUEST_CONFLICT",
        "Fork request already selected different history",
      );
    return { record, duplicate: true };
  }
  if (allHeads.length >= 512)
    forkError("FORK_LIMIT", "Materialized fork count is full");
  const preview = ports.readPreview(original);
  ports.assertPreview(original, preview);
  if (preview.sha256 !== approvalFingerprint)
    forkError(
      "FORK_APPROVAL_MISMATCH",
      "Approval does not match the exact Original preview",
    );
  assertForkSourceCurrent(db, preview.source, true);
  const now = new Date().toISOString(),
    session: Session = {
      id: preview.targetSessionId,
      workspaceId: preview.targetWorkspaceId,
      title: preview.title,
      createdAt: now,
    };
  ports.createSession(session);
  const input = ports.accept({
    sessionId: session.id,
    requestId: `fork:${preview.previewId}`,
    prompt: preview.prompt,
    config: preview.config,
    delivery: "queue",
  });
  const record: ConversationFork = signedFork({
    version: 1 as const,
    id: preview.previewId,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    requestId,
    approvalFingerprint,
    preview,
    input,
    origin: "host-fork" as const,
    parentForkSha256: preview.parent?.sha256 ?? null,
    createdAt: now,
  });
  forkJson(record);
  ports.putDocument(session.id, FORK_KIND, 0, record as unknown as JsonObject);
  ports.appendEvent(
    session.id,
    "conversation.fork.materialized",
    { record: record as unknown as JsonObject },
    { inputId: input.inputId },
  );
  ports.afterCommit(() => ports.wake(session.id));
  return { record: structuredClone(record), duplicate: false };
}
export function validateConversationForkDatabase(db: DatabaseSync): void {
  validateForkChildDatabase(db);
  const headers = db
    .prepare("SELECT session_id FROM session_documents WHERE kind=? LIMIT 513")
    .all(FORK_KIND);
  if (headers.length > 512)
    forkError(
      "FORK_LIMIT",
      "Native fork count exceeds the bounded archive limit",
    );
  for (const row of headers) readConversationFork(db, String(row.session_id));
}
