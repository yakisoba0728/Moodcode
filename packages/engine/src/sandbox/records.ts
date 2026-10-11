import type { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "@moodcode/contracts";
import {
  sandboxDigest,
  sandboxError,
  sandboxObject,
  sandboxJson,
  sandboxRecordKind,
  sandboxSha,
  sandboxSign,
  SANDBOX_LIMITS,
  type SandboxRecord,
} from "./types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { SessionDocument } from "../storage/native-records.js";
import { validateQueueTarget } from "../runner/queue-target.js";
import { validateCommandArtifactDescriptor } from "../tools/command/observation.js";
import { isAbsolute } from "node:path";
export interface SandboxRecordPorts {
  writeTx<T>(operation: () => T): T;
  writeDocument(
    sessionId: string,
    kind: string,
    expected: number,
    data: JsonObject,
  ): SessionDocument;
  appendEvent(
    sessionId: string,
    type: string,
    payload: JsonObject,
    refs?: { runId?: string; turnId?: string; attemptId?: string },
  ): unknown;
}
function caps(db: DatabaseSync): void {
  for (const [table, where, limit] of [
    [
      "session_documents",
      "kind LIKE 'sandbox.record.%'",
      SANDBOX_LIMITS.records,
    ],
    ["session_events", "type='sandbox.record'", SANDBOX_LIMITS.events],
  ] as const) {
    const r = db
      .prepare(
        `SELECT count(*) n,sum(length(CAST(data AS BLOB))) bytes,max(length(CAST(data AS BLOB))) largest FROM ${table} WHERE ${where}`,
      )
      .get()!;
    if (
      Number(r.n) > limit ||
      Number(r.bytes) > SANDBOX_LIMITS.totalBytes ||
      Number(r.largest) > SANDBOX_LIMITS.rowBytes + 8192
    )
      sandboxError("SANDBOX_LIMIT");
  }
}
/**
 * Admission keeps room for the new head and for every head's remaining
 * revisions plus one paused-import revision, pruning the oldest closed chains
 * that no MCP binding references. Other states are never pruned.
 */
function reclaim(db: DatabaseSync, records: readonly SandboxRecord[]): void {
  const { rowBytes, totalBytes } = SANDBOX_LIMITS,
    need = { rows: 0, eventBytes: 0, headBytes: 0 },
    reserve = (r: SandboxRecord | undefined, sign: number): void => {
      if (r?.state === "paused-import") return;
      const live = !r
          ? 3
          : ["starting", "running"].includes(r.state)
            ? 3 - r.revision
            : 0,
        pause = live ? rowBytes : Buffer.byteLength(JSON.stringify(r));
      need.rows += sign * (live + 1);
      need.eventBytes += sign * ((live + 1) * 8192 + live * rowBytes + pause);
      need.headBytes += sign * (live ? rowBytes : 8192);
    },
    usage = (table: string, where: string): [number, number] => {
      const u = db
        .prepare(
          `SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM ${table} WHERE ${where}`,
        )
        .get()!;
      return [Number(u.n), Number(u.bytes)];
    },
    linked = new Set(
      records.flatMap((r) =>
        r.kind === "mcp-binding" ? [String(r.owner!.connectionId)] : [],
      ),
    ),
    victims = records
      .filter((r) => r.state === "closed" && !linked.has(r.id))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  for (const r of [undefined, ...records]) reserve(r, 1);
  for (;;) {
    const [heads, headBytes] = usage(
        "session_documents",
        "kind LIKE 'sandbox.record.%'",
      ),
      [events, eventBytes] = usage("session_events", "type='sandbox.record'");
    if (
      heads < SANDBOX_LIMITS.records &&
      events + need.rows <= SANDBOX_LIMITS.events &&
      eventBytes + need.eventBytes <= totalBytes &&
      headBytes + need.headBytes <= totalBytes
    )
      return;
    const r = victims.shift();
    if (!r) sandboxError("SANDBOX_LIMIT");
    db.prepare(
      "DELETE FROM session_documents WHERE session_id=? AND kind=?",
    ).run(r.sessionId, sandboxRecordKind(r.id));
    db.prepare(
      "DELETE FROM session_events WHERE session_id=? AND type='sandbox.record' AND json_extract(data,'$.payload.record.id')=?",
    ).run(r.sessionId, r.id);
    reserve(r, -1);
  }
}
const hex = (value: unknown): boolean =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function path(value: unknown): boolean {
  return (
    typeof value === "string" &&
    isAbsolute(value) &&
    Buffer.byteLength(value) <= 8192 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function validatePin(input: unknown): void {
  const p = sandboxObject(input as Record<string, unknown>, [
    "path",
    "kind",
    "device",
    "inode",
    "mode",
    "size",
    "mtimeNs",
    "sha256",
  ]);
  if (
    !path(p.path) ||
    !["directory", "file"].includes(String(p.kind)) ||
    !["device", "inode", "mode", "size", "mtimeNs"].every(
      (k) => typeof p[k] === "string" && /^\d{1,32}$/.test(p[k] as string),
    ) ||
    (p.kind === "file" ? !hex(p.sha256) : p.sha256 !== null)
  )
    sandboxError("SANDBOX_RECORD_INVALID");
}
function outcome(input: unknown, command: boolean): Record<string, any> {
  const o = sandboxObject(input as Record<string, any>, [
    "exitCode",
    "signal",
    "cancelled",
    "timedOut",
    "cleanupConfirmed",
    "started",
    "outputDiscarded",
    "error",
  ]);
  if (
    (o.exitCode !== null &&
      (!Number.isSafeInteger(o.exitCode) || o.exitCode < 0)) ||
    typeof o.cleanupConfirmed !== "boolean" ||
    typeof o.started !== "boolean" ||
    (command &&
      (typeof o.cancelled !== "boolean" || typeof o.timedOut !== "boolean")) ||
    (o.signal !== undefined &&
      o.signal !== null &&
      (typeof o.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(o.signal))) ||
    (o.outputDiscarded !== undefined &&
      typeof o.outputDiscarded !== "boolean") ||
    (o.error !== undefined &&
      (typeof o.error !== "string" || Buffer.byteLength(o.error) > 32768))
  )
    sandboxError("SANDBOX_COMPLETION_INVALID");
  return o;
}
function validateSandboxRecord(input: unknown): SandboxRecord {
  const r = sandboxDigest(input),
    g = sandboxDigest(r.grant),
    backend = sandboxDigest(g.backend),
    launch = sandboxDigest(g.launch);
  validateQueueTarget(g.target);
  if (
    r.version !== 1 ||
    !["grant", "command", "host-command", "mcp", "mcp-binding"].includes(
      r.kind,
    ) ||
    ![
      "approved",
      "starting",
      "running",
      "closed",
      "uncertain",
      "paused-import",
    ].includes(r.state) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    r.workspaceId !== g.workspaceId ||
    r.sessionId !== g.sessionId ||
    g.target.workspaceId !== g.workspaceId ||
    g.target.sessionId !== g.sessionId ||
    g.version !== 1 ||
    !hex(g.ownerEpoch) ||
    !hex(g.rootBindingSha256) ||
    !hex(r.requestSha256) ||
    (r.previousSha256 !== null && !hex(r.previousSha256)) ||
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.requestId !== "string" ||
    Buffer.byteLength(r.requestId) > 256 ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    !Number.isFinite(Date.parse(r.updatedAt)) ||
    !path(g.root) ||
    !Array.isArray(g.pins) ||
    g.pins.length > 96 ||
    backend.version !== 1 ||
    backend.backend !== "darwin-seatbelt-v1" ||
    backend.supportTier !== "experimental-deprecated-cli" ||
    backend.platform !== "darwin" ||
    backend.available !== true ||
    backend.fileIsolation !== true ||
    backend.networkIsolation !== true ||
    backend.descendantIsolation !== true ||
    !hex(backend.evidenceSha256) ||
    backend.code !== null
  )
    sandboxError("SANDBOX_RECORD_INVALID");
  validatePin(backend.executable);
  for (const pin of g.pins) validatePin(pin);
  for (const field of ["readPaths", "writePaths", "excluded"])
    if (
      !Array.isArray(g[field]) ||
      g[field].length > 128 ||
      !g[field].every(path)
    )
      sandboxError("SANDBOX_RECORD_INVALID");
  if (
    typeof g.profile !== "string" ||
    Buffer.byteLength(g.profile) > SANDBOX_LIMITS.profileBytes ||
    launch.version !== 1 ||
    launch.backend !== backend.backend ||
    !hex(launch.grantSha256) ||
    launch.profile !== g.profile ||
    launch.executable !== backend.executable.path ||
    (r.groupPid !== null &&
      (!Number.isSafeInteger(r.groupPid) || r.groupPid < 1)) ||
    (r.kind === "grant" &&
      (r.owner !== null ||
        r.groupPid !== null ||
        r.completion !== null ||
        !["approved", "paused-import"].includes(r.state))) ||
    (r.kind !== "grant" &&
      (r.owner === null ||
        (r.kind !== "mcp-binding" && r.state === "approved"))) ||
    (r.kind === "mcp-binding" &&
      (r.groupPid === null ||
        r.completion !== null ||
        !["approved", "paused-import"].includes(r.state))) ||
    (r.state === "running" && r.groupPid === null)
  )
    sandboxError("SANDBOX_RECORD_INVALID");
  if (r.completion !== null) {
    const o = outcome(r.completion.outcome, r.kind === "command");
    if (
      (o.started === true && r.groupPid === null) ||
      (r.state === "closed" &&
        (!o.cleanupConfirmed || r.completion.observationFailure))
    )
      sandboxError("SANDBOX_COMPLETION_INVALID");
    if (r.kind === "command") {
      validateCommandArtifactDescriptor(r.completion.stdout);
      validateCommandArtifactDescriptor(r.completion.stderr);
      if (
        typeof r.completion.checkpointId !== "string" ||
        !hex(r.completion.checkpointSha256) ||
        !Array.isArray(r.completion.partialEffects) ||
        r.completion.partialEffects.some((p: unknown) => typeof p !== "string")
      )
        sandboxError("SANDBOX_COMPLETION_INVALID");
    }
  } else if (r.state === "closed") sandboxError("SANDBOX_RECORD_INVALID");
  return r as SandboxRecord;
}
function transition(previous: SandboxRecord | null, next: SandboxRecord): void {
  if (!previous) {
    if (
      next.state !==
        (["grant", "mcp-binding"].includes(next.kind)
          ? "approved"
          : "starting") ||
      (next.kind !== "mcp-binding" && next.groupPid !== null) ||
      next.completion !== null
    )
      sandboxError("SANDBOX_TRANSITION_INVALID");
    return;
  }
  const allowed: Record<
    SandboxRecord["state"],
    readonly SandboxRecord["state"][]
  > = {
    approved: ["paused-import"],
    starting: ["running", "uncertain", "closed", "paused-import"],
    running: ["closed", "uncertain", "paused-import"],
    closed: ["paused-import"],
    uncertain: ["paused-import"],
    "paused-import": [],
  };
  if (
    !allowed[previous.state].includes(next.state) ||
    next.createdAt !== previous.createdAt ||
    next.workspaceId !== previous.workspaceId ||
    next.sessionId !== previous.sessionId
  )
    sandboxError("SANDBOX_TRANSITION_INVALID");
}
function nativeBody(
  db: DatabaseSync,
  table: "tools" | "approvals" | "checkpoints",
  id: string,
  max: number,
): Record<string, any> {
  const h = db
    .prepare(`SELECT length(CAST(data AS BLOB)) bytes FROM ${table} WHERE id=?`)
    .get(id);
  if (!h) sandboxError("SANDBOX_OWNER_INVALID");
  if (Number(h.bytes) > max) sandboxError("SANDBOX_LIMIT");
  const raw = db
    .prepare(
      `SELECT data FROM ${table} WHERE id=? AND length(CAST(data AS BLOB))=?`,
    )
    .get(id, h.bytes!);
  if (!raw) sandboxError("SANDBOX_OWNER_INVALID");
  return JSON.parse(String(raw.data));
}
function anchors(
  db: DatabaseSync,
  sessionId: string,
  id: string,
): SandboxRecord[] {
  const hs = db
    .prepare(
      "SELECT seq,run_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type='sandbox.record' AND json_extract(data,'$.payload.record.id')=? ORDER BY seq LIMIT 8193",
    )
    .all(sessionId, id);
  if (hs.length > 8192) sandboxError("SANDBOX_LIMIT");
  return hs.map((h) => {
    if (Number(h.bytes) > SANDBOX_LIMITS.rowBytes + 8192)
      sandboxError("SANDBOX_LIMIT");
    const raw = db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))<=?",
      )
      .get(sessionId, h.seq!, SANDBOX_LIMITS.rowBytes + 8192)!;
    const event = JSON.parse(String(raw.data)),
      r = validateSandboxRecord(event.payload.record);
    const refs = r.kind === "command" ? r.owner! : {};
    if (
      (h.run_id ?? null) !== (refs.runId ?? null) ||
      (h.turn_id ?? null) !== (refs.turnId ?? null) ||
      (h.attempt_id ?? null) !== (refs.attemptId ?? null) ||
      (event.runId ?? null) !== (h.run_id ?? null) ||
      (event.turnId ?? null) !== (h.turn_id ?? null) ||
      (event.attemptId ?? null) !== (h.attempt_id ?? null)
    )
      sandboxError("SANDBOX_OWNER_INVALID");
    return r;
  });
}
function nativeOwner(db: DatabaseSync, r: SandboxRecord): void {
  const o = r.owner;
  if (!o || r.kind === "grant") return;
  if (r.kind === "mcp-binding") {
    const source = anchors(db, r.sessionId, String(o.connectionId)).find(
        (e) => e.sha256 === o.connectionSha256,
      ),
      grant = anchors(db, r.sessionId, r.grant.id).find(
        (e) =>
          e.kind === "grant" &&
          e.state === "approved" &&
          e.grant.sha256 === r.grant.sha256,
      );
    if (
      !source ||
      !grant ||
      !db
        .prepare(
          "SELECT revision FROM session_documents WHERE session_id=? AND kind=? AND revision>=?",
        )
        .get(r.sessionId, sandboxRecordKind(source.id), source.revision) ||
      !db
        .prepare(
          "SELECT revision FROM session_documents WHERE session_id=? AND kind=? AND revision>=?",
        )
        .get(r.sessionId, sandboxRecordKind(grant.id), grant.revision) ||
      source.kind !== "mcp" ||
      source.state !== "running" ||
      source.groupPid !== r.groupPid ||
      source.workspaceId !== r.workspaceId ||
      source.sessionId !== r.sessionId ||
      source.owner?.clientId !== o.clientId ||
      source.owner?.profileSha256 !== o.profileSha256 ||
      source.owner?.launchSha256 !== o.launchSha256 ||
      knowledgeHash(source.grant.excluded) !==
        knowledgeHash(r.grant.excluded) ||
      knowledgeHash(source.grant.pins) !== knowledgeHash(r.grant.pins) ||
      knowledgeHash(source.grant.target.config) !==
        knowledgeHash(r.grant.target.config) ||
      knowledgeHash(source.grant.target.profile) !==
        knowledgeHash(r.grant.target.profile) ||
      source.grant.ownerEpoch !== r.grant.ownerEpoch ||
      source.grant.backend.sha256 !== r.grant.backend.sha256 ||
      source.grant.profile !== r.grant.profile ||
      source.grant.rootBindingSha256 !== r.grant.rootBindingSha256 ||
      knowledgeHash(source.grant.readPaths) !==
        knowledgeHash(r.grant.readPaths) ||
      knowledgeHash(source.grant.writePaths) !==
        knowledgeHash(r.grant.writePaths) ||
      o.bootstrapTargetSha256 !== knowledgeHash(r.grant.target)
    )
      sandboxError("SANDBOX_MCP_BINDING_INVALID");
  }

  if (r.kind === "command") {
    const run = db
        .prepare("SELECT workspace_id,session_id FROM runs WHERE id=?")
        .get(String(o.runId)),
      toolHeader = db
        .prepare("SELECT run_id,session_id,state FROM tools WHERE id=?")
        .get(String(o.toolCallId)),
      turn = db
        .prepare("SELECT run_id,session_id FROM session_turns WHERE id=?")
        .get(String(o.turnId)),
      attempt = db
        .prepare(
          "SELECT run_id,session_id,turn_id FROM provider_attempts WHERE id=?",
        )
        .get(String(o.attemptId)),
      approvalHeader = db
        .prepare(
          "SELECT run_id,session_id,tool_call_id,status FROM approvals WHERE id=?",
        )
        .get(String(o.approvalId));
    if (
      !run ||
      run.workspace_id !== r.workspaceId ||
      run.session_id !== r.sessionId ||
      !toolHeader ||
      toolHeader.run_id !== o.runId ||
      toolHeader.session_id !== r.sessionId ||
      !turn ||
      turn.run_id !== o.runId ||
      turn.session_id !== r.sessionId ||
      !attempt ||
      attempt.run_id !== o.runId ||
      attempt.session_id !== r.sessionId ||
      attempt.turn_id !== o.turnId ||
      !approvalHeader ||
      approvalHeader.run_id !== o.runId ||
      approvalHeader.session_id !== r.sessionId ||
      approvalHeader.tool_call_id !== o.toolCallId ||
      approvalHeader.status !== "allowed"
    )
      sandboxError("SANDBOX_OWNER_INVALID");
    const t = nativeBody(db, "tools", String(o.toolCallId), 1048576),
      approval = nativeBody(db, "approvals", String(o.approvalId), 131072);
    if (
      t.id !== o.toolCallId ||
      t.runId !== o.runId ||
      t.sessionId !== r.sessionId ||
      t.state !== toolHeader.state ||
      t.name !== "run_command" ||
      approval.id !== o.approvalId ||
      approval.status !== "allowed" ||
      approval.runId !== o.runId ||
      approval.sessionId !== r.sessionId ||
      approval.fingerprint !== o.approvalFingerprint ||
      approval.toolCallId !== o.toolCallId ||
      approval.preview?.sandbox?.sha256 !== r.grant.launch.sha256 ||
      approval.preview?.command !== o.command
    )
      sandboxError("SANDBOX_APPROVAL_INVALID");
    if (r.completion) {
      const c = r.completion,
        h = db
          .prepare("SELECT run_id,tool_call_id FROM checkpoints WHERE id=?")
          .get(String(c.checkpointId)),
        checkpoint = nativeBody(
          db,
          "checkpoints",
          String(c.checkpointId),
          8388608,
        );
      if (
        !h ||
        h.run_id !== o.runId ||
        h.tool_call_id !== o.toolCallId ||
        checkpoint.id !== c.checkpointId ||
        checkpoint.runId !== o.runId ||
        checkpoint.toolCallId !== o.toolCallId ||
        checkpoint.kind !== "command" ||
        knowledgeHash(checkpoint) !== c.checkpointSha256 ||
        knowledgeHash(checkpoint.files.map((f: { path: string }) => f.path)) !==
          knowledgeHash(c.partialEffects)
      )
        sandboxError("SANDBOX_COMPLETION_INVALID");
      const jobId =
          "command-" +
          knowledgeHash({ runId: o.runId, toolCallId: o.toolCallId }).slice(
            0,
            32,
          ),
        closed = db
          .prepare(
            "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type='command.job.closed_observed' AND run_id=? AND turn_id=? AND attempt_id=? AND json_extract(data,'$.payload.jobId')=? LIMIT 2",
          )
          .all(
            r.sessionId,
            String(o.runId),
            String(o.turnId),
            String(o.attemptId),
            jobId,
          );
      if (closed.length > 1) sandboxError("SANDBOX_COMPLETION_INVALID");
      if (closed.length) {
        if (Number(closed[0]!.bytes) > 8192) sandboxError("SANDBOX_LIMIT");
        const event = JSON.parse(
            String(
              db
                .prepare(
                  "SELECT data FROM session_events WHERE session_id=? AND seq=?",
                )
                .get(r.sessionId, closed[0]!.seq!)!.data,
            ),
          ),
          summary = {
            outcome: c.outcome,
            stdout: c.stdout,
            stderr: c.stderr,
            checkpoint: {
              id: checkpoint.id,
              runId: checkpoint.runId,
              toolCallId: checkpoint.toolCallId,
              kind: "command",
              createdAt: checkpoint.createdAt,
              incomplete: Boolean(checkpoint.incomplete),
              sha256: knowledgeHash(checkpoint),
            },
            ...(c.observationFailure
              ? { observationFailure: c.observationFailure }
              : {}),
          };
        if (event.payload.completionSha256 !== knowledgeHash(summary))
          sandboxError("SANDBOX_COMPLETION_INVALID");
      }
    }
  }
}
function readSandboxRecords(
  db: DatabaseSync,
  workspaceId?: string,
): SandboxRecord[] {
  caps(db);
  const hs = db
    .prepare(
      "SELECT session_id,kind,revision,length(CAST(data AS BLOB)) bytes FROM session_documents WHERE kind LIKE 'sandbox.record.%' AND (? IS NULL OR session_id IN (SELECT id FROM sessions WHERE workspace_id=?)) ORDER BY session_id,kind LIMIT 257",
    )
    .all(workspaceId ?? null, workspaceId ?? null);
  if (hs.length > 256) sandboxError("SANDBOX_LIMIT");
  return hs.map((h) => {
    if (Number(h.bytes) > SANDBOX_LIMITS.rowBytes)
      sandboxError("SANDBOX_LIMIT");
    const data = db
      .prepare(
        "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))<=?",
      )
      .get(h.session_id!, h.kind!, SANDBOX_LIMITS.rowBytes)!;
    const r = validateSandboxRecord(JSON.parse(String(data.data)));
    if (
      h.kind !== sandboxRecordKind(r.id) ||
      h.session_id !== r.sessionId ||
      Number(h.revision) !== r.revision
    )
      sandboxError("SANDBOX_HEAD_INVALID");
    const events = anchors(db, r.sessionId, r.id);
    if (events.length !== r.revision || events.at(-1)!.sha256 !== r.sha256)
      sandboxError("SANDBOX_ANCHOR_INVALID");
    let prev: SandboxRecord | null = null;
    for (const e of events) {
      if (
        e.revision !== (prev?.revision ?? 0) + 1 ||
        e.previousSha256 !== (prev?.sha256 ?? null) ||
        (prev &&
          (e.id !== prev.id ||
            e.kind !== prev.kind ||
            e.requestId !== prev.requestId ||
            e.requestSha256 !== prev.requestSha256 ||
            knowledgeHash(e.grant) !== knowledgeHash(prev.grant) ||
            knowledgeHash(e.owner) !== knowledgeHash(prev.owner) ||
            (prev.groupPid !== null && e.groupPid !== prev.groupPid) ||
            (prev.completion !== null &&
              knowledgeHash(e.completion) !== knowledgeHash(prev.completion))))
      )
        sandboxError("SANDBOX_TRANSITION_INVALID");
      transition(prev, e);
      nativeOwner(db, e);
      prev = e;
    }
    const updates = db
      .prepare(
        "SELECT length(CAST(data AS BLOB)) bytes,seq FROM session_events WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=? LIMIT 2",
      )
      .all(r.sessionId, String(h.kind), r.revision);
    if (updates.length !== 1 || Number(updates[0]!.bytes) > 8192)
      sandboxError("SANDBOX_HEAD_INVALID");
    const update = JSON.parse(
      String(
        db
          .prepare(
            "SELECT data FROM session_events WHERE session_id=? AND seq=?",
          )
          .get(r.sessionId, updates[0]!.seq!)!.data,
      ),
    );
    if (update.payload.sha256 !== sandboxSha(String(data.data)))
      sandboxError("SANDBOX_HEAD_INVALID");
    return r;
  });
}
export function validateSandboxDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  for (const r of readSandboxRecords(db)) {
    options.check?.();
    if (
      !db
        .prepare("SELECT id FROM sessions WHERE id=? AND workspace_id=?")
        .get(r.sessionId, r.workspaceId)
    )
      sandboxError("SANDBOX_OWNER_INVALID");
  }
}
export class SandboxStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ports: SandboxRecordPorts,
  ) {}
  list(ws?: string) {
    return readSandboxRecords(this.db, ws);
  }
  get(ws: string, id: string) {
    return this.list(ws).find((r) => r.id === id);
  }
  write(record: SandboxRecord, expected: number): SandboxRecord {
    return this.ports.writeTx(() => {
      caps(this.db);
      const r = validateSandboxRecord(record),
        previous = this.get(r.workspaceId, r.id);
      if (
        (previous?.revision ?? 0) !== expected ||
        r.revision !== expected + 1 ||
        r.previousSha256 !== (previous?.sha256 ?? null)
      )
        sandboxError("SANDBOX_CAS");
      if (!previous) reclaim(this.db, this.list());
      this.ports.writeDocument(
        r.sessionId,
        sandboxRecordKind(r.id),
        expected,
        r as unknown as JsonObject,
      );
      this.ports.appendEvent(
        r.sessionId,
        "sandbox.record",
        { record: r as unknown as JsonObject },
        r.kind === "command"
          ? {
              runId: String(r.owner!.runId),
              turnId: String(r.owner!.turnId),
              attemptId: String(r.owner!.attemptId),
            }
          : undefined,
      );
      validateSandboxDatabase(this.db);
      return sandboxJson(r);
    });
  }
  recover(): void {
    for (const r of this.list()) {
      if (r.kind !== "grant" && ["starting", "running"].includes(r.state))
        this.write(
          sandboxSign({
            ...withoutSha(r),
            revision: r.revision + 1,
            previousSha256: r.sha256,
            state: "uncertain" as const,
            updatedAt: new Date().toISOString(),
          }),
          r.revision,
        );
    }
  }
}
function withoutSha(r: SandboxRecord) {
  const { sha256: _sha, ...body } = r;
  return body;
}
export function pauseImportedSandboxes(
  db: DatabaseSync,
  workspaceId: string,
  ports: SandboxRecordPorts,
): void {
  const native = new SandboxStorage(db, ports);
  for (const r of native.list(workspaceId)) {
    if (r.state === "paused-import") continue;
    native.write(
      sandboxSign({
        ...withoutSha(r),
        revision: r.revision + 1,
        previousSha256: r.sha256,
        state: "paused-import" as const,
        updatedAt: new Date().toISOString(),
      }),
      r.revision,
    );
  }
}
