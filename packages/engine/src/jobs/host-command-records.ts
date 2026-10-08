import {sandboxDigest} from '../sandbox/types.js';
import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  jobIdentifier,
  jobJson,
  jobObject,
  signJobData,
} from "./validation.js";
import type {
  CommandInput,
  PhysicalCommandResult,
} from "../tools/command/index.js";
import { validateCommandArtifactDescriptor } from "../tools/command/observation.js";

export const HOST_COMMAND_TABLES = [
  "host_command_revisions",
  "host_command_heads",
] as const;
export const HOST_COMMAND_LIMITS = Object.freeze({
  jobs: 128,
  rows: 4096,
  rowBytes: 262144,
  totalBytes: 33554432,
  outputBytes: 1048576,
  snapshotBytes: 32768,
});
export const HOST_COMMAND_SCHEMA_SQL = `
CREATE TABLE host_command_revisions (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT NOT NULL REFERENCES sessions(id),
 revision INTEGER NOT NULL CHECK(revision>0), previous_id TEXT REFERENCES host_command_revisions(id),
 kind TEXT NOT NULL CHECK(kind IN ('approved','denied','running','output','checkpoint','closed','recovery','import')),
 state TEXT NOT NULL CHECK(state IN ('approved','running','completed','failed','cancelled','denied','uncertain','paused-import')),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=262144), UNIQUE(job_id,revision)
) STRICT, WITHOUT ROWID;
CREATE TABLE host_command_heads (
 job_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT NOT NULL REFERENCES sessions(id),
 request_id TEXT NOT NULL, request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64), revision_id TEXT NOT NULL REFERENCES host_command_revisions(id),
 state TEXT NOT NULL CHECK(state IN ('approved','running','completed','failed','cancelled','denied','uncertain','paused-import')), UNIQUE(workspace_id,request_id)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX host_command_active_workspace ON host_command_heads(workspace_id) WHERE state IN ('approved','running');
`;
export type HostCommandState =
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "denied"
  | "uncertain"
  | "paused-import";
export interface HostCommandPreview {
  readonly sandbox?:import('../sandbox/types.js').SandboxLaunch;
  readonly version: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly input: CommandInput;
  readonly rootBindingSha256: string;
  readonly cwdIdentitySha256: string;
  readonly platform: NodeJS.Platform;
  readonly policyVersion: number;
  readonly limits: {
    readonly maxDurationMs: number;
    readonly maxOutputBytes: number;
  };
  readonly fingerprint: string;
}
export interface HostCommandOwner {
  readonly epoch: string;
  readonly rootBindingSha256: string;
  readonly beforeSnapshotSha256: string;
}
export interface HostCommandRecord {
  readonly version: 1;
  readonly id: string;
  readonly jobId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly previousId: string | null;
  readonly kind: string;
  readonly state: HostCommandState;
  readonly requestId: string;
  readonly requestSha256: string;
  readonly preview: HostCommandPreview;
  readonly owner: HostCommandOwner;
  readonly pid: number | null;
  readonly completion: PhysicalCommandResult | null;
  readonly outputSeq: number;
  readonly outputObservedBytes: number;
  readonly outputStoredBytes: number;
  readonly payload: JsonObject;
  readonly createdAt: string;
  readonly sha256: string;
}
function failure(code = "HOST_COMMAND_EVIDENCE_INVALID"): never {
  throw new EngineError(
    code,
    "Independent host command evidence is stale, incomplete or contradictory",
  );
}
const digest = (body: Record<string, unknown>) => {
  const { sha256, ...value } = body;
  if (knowledgeHash(value) !== sha256) failure();
};
export function validateHostCommandRecord(value: unknown): HostCommandRecord {
  const r = jobObject(
    value,
    [
      "version",
      "id",
      "jobId",
      "workspaceId",
      "sessionId",
      "revision",
      "previousId",
      "kind",
      "state",
      "requestId",
      "requestSha256",
      "preview",
      "owner",
      "pid",
      "completion",
      "outputSeq",
      "outputObservedBytes",
      "outputStoredBytes",
      "payload",
      "createdAt",
      "sha256",
    ],
    [],
    HOST_COMMAND_LIMITS.rowBytes,
  );
  for (const k of ["id", "jobId", "workspaceId", "sessionId", "requestId"])
    jobIdentifier(r[k]);
  if (
    r.version !== 1 ||
    !Number.isSafeInteger(r.revision) ||
    Number(r.revision) < 1 ||
    !Number.isSafeInteger(r.outputSeq) ||
    Number(r.outputSeq) < 0 ||
    !Number.isSafeInteger(r.outputObservedBytes) ||
    !Number.isSafeInteger(r.outputStoredBytes) ||
    Number(r.outputObservedBytes) < 0 ||
    Number(r.outputStoredBytes) < 0 ||
    Number(r.outputStoredBytes) > HOST_COMMAND_LIMITS.outputBytes
  )
    failure();
  if (
    r.pid !== null &&
    (!Number.isSafeInteger(r.pid) ||
      Number(r.pid) < 1 ||
      Number(r.pid) > 2147483647)
  )
    failure();
  const p = jobObject(
    r.preview,
    [
      "version",
      "workspaceId",
      "sessionId",
      "input",
      "rootBindingSha256",
      "cwdIdentitySha256",
      "platform",
      "policyVersion",
      "limits",
      "fingerprint",
    ],
    ["sandbox"],
    131072,
  );
  const { fingerprint, ...previewBody } = p;
  if(p.sandbox){const launch=sandboxDigest(p.sandbox);if(p.platform!=='darwin'||launch.backend!=='darwin-seatbelt-v1'||launch.executable!=='/usr/bin/sandbox-exec'||typeof launch.profile!=='string'||Buffer.byteLength(launch.profile)>32768)failure();}
  if (
    p.version !== 1 ||
    typeof p.platform !== "string" ||
    !["darwin", "linux", "freebsd", "win32"].includes(p.platform) ||
    !Number.isSafeInteger(p.policyVersion) ||
    Number(p.policyVersion) < 0 ||
    knowledgeHash(previewBody) !== fingerprint ||
    p.workspaceId !== r.workspaceId ||
    p.sessionId !== r.sessionId
  )
    failure();
  const input = jobObject(p.input, ["command", "cwd", "timeoutMs"], [], 131072),
    limits = jobObject(p.limits, ["maxDurationMs", "maxOutputBytes"]);
  if (
    typeof input.command !== "string" ||
    !input.command.trim() ||
    Buffer.byteLength(input.command) > 16384 ||
    input.command.includes("\0") ||
    typeof input.cwd !== "string" ||
    !isAbsolute(input.cwd) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    Number(input.timeoutMs) < 1 ||
    Number(input.timeoutMs) > 300000 ||
    !Number.isSafeInteger(limits.maxDurationMs) ||
    Number(limits.maxDurationMs) < 1 ||
    Number(limits.maxDurationMs) > 300000 ||
    Number(input.timeoutMs) > Number(limits.maxDurationMs) ||
    !Number.isSafeInteger(limits.maxOutputBytes) ||
    Number(limits.maxOutputBytes) < 1 ||
    Number(limits.maxOutputBytes) > HOST_COMMAND_LIMITS.outputBytes
  )
    failure();
  const owner = jobObject(r.owner, [
    "epoch",
    "rootBindingSha256",
    "beforeSnapshotSha256",
  ]);
  if (owner.rootBindingSha256 !== p.rootBindingSha256) failure();
  for (const h of [
    p.fingerprint,
    p.rootBindingSha256,
    p.cwdIdentitySha256,
    owner.epoch,
    owner.beforeSnapshotSha256,
    r.requestSha256,
    r.sha256,
  ])
    if (typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h)) failure();
  if (
    ![
      "approved",
      "running",
      "completed",
      "failed",
      "cancelled",
      "denied",
      "uncertain",
      "paused-import",
    ].includes(String(r.state))
  )
    failure();
  if (
    typeof r.createdAt !== "string" ||
    !Number.isFinite(Date.parse(r.createdAt)) ||
    Buffer.byteLength(r.createdAt) > 128 ||
    ![
      "approved",
      "denied",
      "running",
      "output",
      "checkpoint",
      "closed",
      "recovery",
      "import",
    ].includes(String(r.kind)) ||
    (r.previousId !== null && typeof r.previousId !== "string")
  )
    failure();
  if (r.completion !== null) validateCompletion(r.completion);
  if (["completed", "failed", "cancelled"].includes(String(r.state))) {
    const c = r.completion as PhysicalCommandResult | null;
    if (!c || c.outcome.cleanupConfirmed !== true || c.observationFailure)
      failure();
    validateCommandArtifactDescriptor(c.stdout);
    validateCommandArtifactDescriptor(c.stderr);
    if (r.state === "cancelled" && !c.outcome.cancelled && !c.outcome.timedOut)
      failure();
    if (
      (c.outcome.started && r.pid === null) ||
      (r.state === "completed" &&
        (c.outcome.exitCode !== 0 ||
          c.outcome.cancelled ||
          c.outcome.timedOut ||
          c.outcome.error))
    )
      failure();
  }
  digest(r);
  return r as unknown as HostCommandRecord;
}
function validateCompletion(value: unknown): void {
  const c = jobObject(
    value,
    ["outcome", "stdout", "stderr", "files", "warnings", "incomplete"],
    ["observationFailure"],
    HOST_COMMAND_LIMITS.rowBytes,
  );
  const o = jobObject(
    c.outcome,
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
    (o.exitCode !== null &&
      (!Number.isSafeInteger(o.exitCode) ||
        Math.abs(Number(o.exitCode)) > 2147483647)) ||
    (o.signal !== null &&
      (typeof o.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(o.signal)))
  )
    failure();
  for (const key of ["cancelled", "timedOut", "cleanupConfirmed", "started"])
    if (typeof o[key] !== "boolean") failure();
  if (
    (Object.hasOwn(o, "outputDiscarded") &&
      typeof o.outputDiscarded !== "boolean") ||
    typeof c.incomplete !== "boolean"
  )
    failure();
  for (const [obj, key] of [
    [o, "error"],
    [c, "observationFailure"],
  ] as const)
    if (
      Object.hasOwn(obj, key) &&
      (typeof obj[key] !== "string" ||
        Buffer.byteLength(String(obj[key])) > 4096)
    )
      failure();
  validateCommandArtifactDescriptor(c.stdout);
  validateCommandArtifactDescriptor(c.stderr);
  if (
    !Array.isArray(c.files) ||
    c.files.length > 256 ||
    !Array.isArray(c.warnings) ||
    c.warnings.length > 512 ||
    c.warnings.some((v) => typeof v !== "string" || Buffer.byteLength(v) > 8192)
  )
    failure();
  const paths = new Set<string>();
  for (const value of c.files) {
    const f = jobObject(
      value,
      ["path", "before", "after", "beforeHash", "afterHash"],
      [],
      65536,
    );
    if (
      typeof f.path !== "string" ||
      !f.path ||
      isAbsolute(f.path) ||
      posix.normalize(f.path) !== f.path ||
      f.path === ".." ||
      f.path.startsWith("../") ||
      f.path.includes("\\") ||
      f.path.includes("\0") ||
      paths.has(f.path)
    )
      failure();
    paths.add(f.path);
    for (const side of ["before", "after"] as const) {
      const body = f[side],
        sha = f[`${side}Hash`];
      if (
        body === null
          ? sha !== null
          : typeof body !== "string" ||
            Buffer.byteLength(body) > 8192 ||
            createHash("sha256").update(body).digest("hex") !== sha
      )
        failure();
    }
  }
}

function caps(db: DatabaseSync): void {
  const row = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM host_command_revisions",
    )
    .get()!;
  if (
    Number(row.n) > HOST_COMMAND_LIMITS.rows ||
    Number(row.bytes) > HOST_COMMAND_LIMITS.totalBytes ||
    Number(db.prepare("SELECT count(*) n FROM host_command_heads").get()!.n) >
      HOST_COMMAND_LIMITS.jobs
  )
    failure("HOST_COMMAND_LIMIT");
}
function readRow(db: DatabaseSync, id: string): HostCommandRecord {
  const h = db
    .prepare(
      "SELECT job_id,workspace_id,session_id,revision,previous_id,kind,state,sha256,length(CAST(data AS BLOB)) bytes FROM host_command_revisions WHERE id=?",
    )
    .get(id);
  if (!h || Number(h.bytes) > HOST_COMMAND_LIMITS.rowBytes) failure();
  const row = db
    .prepare("SELECT data FROM host_command_revisions WHERE id=?")
    .get(id)!;
  const r = validateHostCommandRecord(JSON.parse(String(row.data)));
  if (
    r.id !== id ||
    r.jobId !== h.job_id ||
    r.workspaceId !== h.workspace_id ||
    r.sessionId !== h.session_id ||
    r.revision !== h.revision ||
    r.previousId !== h.previous_id ||
    r.kind !== h.kind ||
    r.state !== h.state ||
    r.sha256 !== h.sha256
  )
    failure();
  const anchors = db
    .prepare(
      "SELECT seq,data,run_id,input_id,turn_id,attempt_id FROM session_events WHERE session_id=? AND type='host.command.revision' AND json_extract(data,'$.payload.revisionId')=? LIMIT 2",
    )
    .all(r.sessionId, id);
  if (
    anchors.length !== 1 ||
    anchors[0]!.run_id !== null ||
    anchors[0]!.input_id !== null ||
    anchors[0]!.turn_id !== null ||
    anchors[0]!.attempt_id !== null
  )
    failure();
  const e = JSON.parse(String(anchors[0]!.data));
  if (
    e.sessionId !== r.sessionId ||
    e.seq !== anchors[0]!.seq ||
    e.type !== "host.command.revision" ||
    ["runId", "inputId", "turnId", "attemptId"].some(
      (k) => e[k] !== undefined,
    ) ||
    knowledgeHash(e.payload) !==
      knowledgeHash({
        jobId: r.jobId,
        revisionId: id,
        kind: r.kind,
        sha256: r.sha256,
      })
  )
    failure();
  if (r.kind === "approved" || r.kind === "denied") {
    const witness = anchor(db, r, "host.command.approval");
    if (
      knowledgeHash(witness) !==
      knowledgeHash({
        jobId: r.jobId,
        requestId: r.requestId,
        requestSha256: r.requestSha256,
        decision: r.kind === "approved" ? "allow" : "deny",
        preview: r.preview,
        owner: r.owner,
        snapshot: r.payload,
      })
    )
      failure();
  }
  if (r.kind === "running")
    if (
      knowledgeHash(anchor(db, r, "host.command.process")) !==
      knowledgeHash({
        jobId: r.jobId,
        pid: r.pid,
        owner: r.owner,
        previewFingerprint: r.preview.fingerprint,
      })
    )
      failure();
  if (r.kind === "closed")
    if (
      knowledgeHash(anchor(db, r, "host.command.closed")) !==
      knowledgeHash({ jobId: r.jobId, pid: r.pid, completion: r.completion })
    )
      failure();
  return r;
}
function anchor(db: DatabaseSync, r: HostCommandRecord, type: string): unknown {
  const hs = db
    .prepare(
      "SELECT seq,run_id,input_id,turn_id,attempt_id,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND json_extract(data,'$.payload.jobId')=? LIMIT 2",
    )
    .all(r.sessionId, type, r.jobId);
  if (
    hs.length !== 1 ||
    Number(hs[0]!.bytes) > HOST_COMMAND_LIMITS.rowBytes + 65536 ||
    ["run_id", "input_id", "turn_id", "attempt_id"].some(
      (k) => hs[0]![k] !== null,
    )
  )
    failure();
  const e = JSON.parse(
    String(
      db
        .prepare("SELECT data FROM session_events WHERE session_id=? AND seq=?")
        .get(r.sessionId, hs[0]!.seq!)!.data,
    ),
  );
  if (e.sessionId !== r.sessionId || e.seq !== hs[0]!.seq || e.type !== type)
    failure();
  return e.payload;
}
function transition(
  previous: HostCommandRecord | undefined,
  next: HostCommandRecord,
): void {
  if (!previous) {
    if (
      knowledgeHash(next.payload) !== next.owner.beforeSnapshotSha256 ||
      next.jobId !==
        `host_command_${knowledgeHash([next.workspaceId, next.requestId, next.requestSha256]).slice(0, 32)}` ||
      next.requestSha256 !==
        knowledgeHash({
          workspaceId: next.workspaceId,
          requestId: next.requestId,
          fingerprint: next.preview.fingerprint,
          approved: next.kind === "approved",
        })
    )
      failure();
    if (
      next.revision !== 1 ||
      next.previousId !== null ||
      !["approved", "denied"].includes(next.kind) ||
      next.kind !== next.state ||
      next.pid !== null ||
      next.outputSeq !== 0 ||
      next.outputObservedBytes !== 0 ||
      next.outputStoredBytes !== 0 ||
      next.completion !== null
    )
      failure();
    return;
  }
  if (
    next.revision !== previous.revision + 1 ||
    next.previousId !== previous.id ||
    next.jobId !== previous.jobId ||
    next.requestId !== previous.requestId ||
    next.requestSha256 !== previous.requestSha256 ||
    knowledgeHash(next.preview) !== knowledgeHash(previous.preview) ||
    knowledgeHash(next.owner) !== knowledgeHash(previous.owner) ||
    (previous.pid !== null && next.pid !== previous.pid) ||
    next.outputSeq < previous.outputSeq ||
    next.outputObservedBytes < previous.outputObservedBytes ||
    next.outputStoredBytes < previous.outputStoredBytes
  )
    failure();
  if (
    next.kind === "running" &&
    (previous.state !== "approved" ||
      next.state !== "running" ||
      next.pid === null ||
      next.payload.pid !== next.pid)
  )
    failure();
  if (next.kind === "output") {
    if (
      previous.state !== "running" ||
      next.state !== "running" ||
      next.outputSeq !== previous.outputSeq + 1
    )
      failure();
    const p = jobObject(
      next.payload,
      ["seq", "stream", "data", "bytes"],
      [],
      HOST_COMMAND_LIMITS.rowBytes,
    );
    if (
      p.seq !== next.outputSeq ||
      !["stdout", "stderr"].includes(String(p.stream)) ||
      typeof p.data !== "string" ||
      Buffer.byteLength(p.data) !== p.bytes ||
      Number(p.bytes) > 16384 ||
      next.outputStoredBytes !== previous.outputStoredBytes + Number(p.bytes)
    )
      failure();
  }
  if (
    next.kind === "checkpoint" &&
    (!["approved", "running"].includes(previous.state) ||
      next.state !== previous.state ||
      next.pid !== previous.pid ||
      next.outputSeq !== previous.outputSeq ||
      next.outputStoredBytes !== previous.outputStoredBytes)
  )
    failure();
  if (next.kind === "closed") {
    if (
      !["approved", "running"].includes(previous.state) ||
      previous.kind !== "checkpoint" ||
      !["completed", "failed", "cancelled", "uncertain"].includes(next.state) ||
      next.completion === null ||
      next.outputObservedBytes !==
        next.completion.stdout.observedBytes +
          next.completion.stderr.observedBytes ||
      next.payload.completionSha256 !== knowledgeHash(next.completion) ||
      previous.payload.sha256 !==
        knowledgeHash({
          files: next.completion.files,
          warnings: next.completion.warnings,
          incomplete: next.completion.incomplete,
        })
    )
      failure();
  }
  if (
    next.kind === "recovery" &&
    (!["approved", "running", "uncertain"].includes(previous.state) ||
      next.state !== "uncertain")
  )
    failure();
  if (next.kind === "import" && next.state !== "paused-import") failure();
  if (
    ![
      "running",
      "output",
      "checkpoint",
      "closed",
      "recovery",
      "import",
    ].includes(next.kind)
  )
    failure();
}
export function readHostCommand(
  db: DatabaseSync,
  workspaceId: string,
  jobId: string,
): HostCommandRecord | undefined {
  jobIdentifier(workspaceId);
  jobIdentifier(jobId);
  caps(db);
  const h = db
    .prepare(
      "SELECT * FROM host_command_heads WHERE workspace_id=? AND job_id=?",
    )
    .get(workspaceId, jobId);
  if (!h) return;
  const result = readRow(db, String(h.revision_id));
  if (
    result.jobId !== h.job_id ||
    result.workspaceId !== h.workspace_id ||
    result.sessionId !== h.session_id ||
    result.requestId !== h.request_id ||
    result.requestSha256 !== h.request_sha256 ||
    result.state !== h.state
  )
    failure();
  let current: HostCommandRecord | undefined = result;
  let count = 0;
  while (current) {
    if (++count > HOST_COMMAND_LIMITS.rows) failure();
    const previous: HostCommandRecord | undefined =
      current.previousId === null ? undefined : readRow(db, current.previousId);
    transition(previous, current);
    current = previous;
  }
  return result;
}
export function inspectHostCommands(
  db: DatabaseSync,
  workspaceId?: string,
): readonly HostCommandRecord[] {
  caps(db);
  const rows = db
    .prepare(
      "SELECT workspace_id,job_id FROM host_command_heads WHERE (? IS NULL OR workspace_id=?) ORDER BY job_id",
    )
    .all(workspaceId ?? null, workspaceId ?? null);
  return Object.freeze(
    rows.map((h) =>
      readHostCommand(db, String(h.workspace_id), String(h.job_id))!,
    ),
  );
}
export function validateHostCommandDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
): void {
  if (
    !db
      .prepare("SELECT name FROM sqlite_schema WHERE name='host_command_heads'")
      .get()
  )
    return;
  const heads = inspectHostCommands(db);
  let rows = 0;
  for (const head of heads) {
    options.check?.();
    rows += head.revision;
  }
  if (
    rows !==
    Number(db.prepare("SELECT count(*) n FROM host_command_revisions").get()!.n)
  )
    failure();
}
export function hasHostCommandUncertainty(
  db: DatabaseSync,
  workspaceId: string,
): boolean {
  return !!db
    .prepare(
      "SELECT h.job_id FROM host_command_heads h JOIN host_command_revisions r ON r.id=h.revision_id LEFT JOIN host_command_revisions p ON p.id=r.previous_id WHERE h.workspace_id=? AND (h.state IN ('approved','running','uncertain') OR h.state='paused-import' AND p.state IN ('approved','running','uncertain')) LIMIT 1",
    )
    .get(workspaceId);
}
export interface HostCommandJournalPorts {
  transaction<T>(op: () => T): T;
  appendEvent(sessionId: string, type: string, payload: JsonObject): void;
}
export class HostCommandStorage {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ports: HostCommandJournalPorts,
  ) {
    validateHostCommandDatabase(db);
  }
  find(workspaceId: string, requestId: string): HostCommandRecord | undefined {
    const h = this.db
      .prepare(
        "SELECT job_id FROM host_command_heads WHERE workspace_id=? AND request_id=?",
      )
      .get(workspaceId, requestId);
    return h
      ? readHostCommand(this.db, workspaceId, String(h.job_id))
      : undefined;
  }
  get(workspaceId: string, jobId: string) {
    return readHostCommand(this.db, workspaceId, jobId);
  }
  inspect(workspaceId?: string) {
    return inspectHostCommands(this.db, workspaceId);
  }
  append(body: Omit<HostCommandRecord, "sha256">): HostCommandRecord {
    return this.ports.transaction(() => {
      caps(this.db);
      const record = validateHostCommandRecord(
        signJobData(
          body,
          body.kind === "import"
            ? HOST_COMMAND_LIMITS.rowBytes
            : HOST_COMMAND_LIMITS.rowBytes - 1024,
        ),
      );
      const size = Buffer.byteLength(JSON.stringify(record)),
        usage = this.db
          .prepare(
            "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes FROM host_command_revisions",
          )
          .get()!;
      const heads = this.db
        .prepare("SELECT job_id,state FROM host_command_heads")
        .all();
      const projected = [
        ...heads.filter((h) => h.job_id !== record.jobId),
        { job_id: record.jobId, state: record.state },
      ];
      const reserved = projected.reduce(
        (n, h) =>
          n +
          (h.state === "paused-import"
            ? 0
            : h.state === "approved"
              ? 4
              : h.state === "running"
                ? 3
                : 1),
        0,
      );
      if (
        projected.length > HOST_COMMAND_LIMITS.jobs ||
        Number(usage.n) + 1 > HOST_COMMAND_LIMITS.rows ||
        Number(usage.bytes) + size > HOST_COMMAND_LIMITS.totalBytes ||
        (["approved", "denied", "running", "output"].includes(record.kind) &&
          (Number(usage.n) + 1 + reserved > HOST_COMMAND_LIMITS.rows ||
            Number(usage.bytes) +
              size +
              reserved * HOST_COMMAND_LIMITS.rowBytes >
              HOST_COMMAND_LIMITS.totalBytes))
      )
        failure("HOST_COMMAND_LIMIT");
      const previous =
        record.previousId === null
          ? undefined
          : readRow(this.db, record.previousId);
      transition(previous, record);
      const session = this.db
        .prepare("SELECT workspace_id FROM sessions WHERE id=?")
        .get(record.sessionId);
      if (session?.workspace_id !== record.workspaceId) failure();
      if (previous) {
        const h = this.db
          .prepare("SELECT revision_id FROM host_command_heads WHERE job_id=?")
          .get(record.jobId);
        if (h?.revision_id !== previous.id)
          failure("HOST_COMMAND_REVISION_CONFLICT");
      }
      this.db
        .prepare(
          "INSERT INTO host_command_revisions(id,job_id,workspace_id,session_id,revision,previous_id,kind,state,sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          record.id,
          record.jobId,
          record.workspaceId,
          record.sessionId,
          record.revision,
          record.previousId,
          record.kind,
          record.state,
          record.sha256,
          JSON.stringify(record),
        );
      this.ports.appendEvent(record.sessionId, "host.command.revision", {
        jobId: record.jobId,
        revisionId: record.id,
        kind: record.kind,
        sha256: record.sha256,
      });
      if (record.kind === "approved" || record.kind === "denied")
        this.ports.appendEvent(record.sessionId, "host.command.approval", {
          jobId: record.jobId,
          requestId: record.requestId,
          requestSha256: record.requestSha256,
          decision: record.kind === "approved" ? "allow" : "deny",
          preview: record.preview as unknown as JsonObject,
          owner: record.owner as unknown as JsonObject,
          snapshot: record.payload,
        });
      if (record.kind === "running")
        this.ports.appendEvent(record.sessionId, "host.command.process", {
          jobId: record.jobId,
          pid: record.pid,
          owner: record.owner as unknown as JsonObject,
          previewFingerprint: record.preview.fingerprint,
        });
      if (record.kind === "closed")
        this.ports.appendEvent(record.sessionId, "host.command.closed", {
          jobId: record.jobId,
          pid: record.pid,
          completion: record.completion as unknown as JsonObject,
        });
      if (previous)
        this.db
          .prepare(
            "UPDATE host_command_heads SET revision_id=?,state=? WHERE job_id=? AND revision_id=?",
          )
          .run(record.id, record.state, record.jobId, previous.id);
      else
        this.db
          .prepare(
            "INSERT INTO host_command_heads(job_id,workspace_id,session_id,request_id,request_sha256,revision_id,state) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            record.jobId,
            record.workspaceId,
            record.sessionId,
            record.requestId,
            record.requestSha256,
            record.id,
            record.state,
          );
      caps(this.db);
      return record;
    });
  }
  control(
    before: HostCommandRecord,
    kind: "recovery" | "import",
    payload: JsonObject,
  ): HostCommandRecord {
    return this.append({
      ...before,
      id: knowledgeHash([before.jobId, before.revision + 1, kind, payload]),
      revision: before.revision + 1,
      previousId: before.id,
      kind,
      state: kind === "recovery" ? "uncertain" : "paused-import",
      payload,
      createdAt: new Date().toISOString(),
    });
  }
  recover(): number {
    let n = 0;
    for (const r of this.inspect())
      if (["approved", "running"].includes(r.state)) {
        this.control(r, "recovery", { reason: "ROOT_INTERRUPTED_NO_REPLAY" });
        n++;
      }
    return n;
  }
  pauseImport(workspaceId: string, archiveSha256: string): number {
    let n = 0;
    for (const r of this.inspect(workspaceId))
      if (r.state !== "paused-import") {
        this.control(r, "import", { archiveSha256 });
        n++;
      }
    return n;
  }
}
