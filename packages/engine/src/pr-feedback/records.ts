import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import type { JsonObject, InputRecord, AcceptInput } from "@moodcode/contracts";
import {
  normalizeAcceptInput,
  validateInputRecord,
} from "@moodcode/contracts/validation";
import { requestIdentity } from "../storage/native-schema.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { validateScheduleTarget } from "../schedules/spec.js";
import { validateCommitVerification } from "../git/commit-receipts.js";
import type { GitCommitPreview } from "../git/types.js";
import {
  PR_LIMITS,
  prChangesRequested,
  prFail,
  prId,
  prInt,
  prDigest,
  prGitSha,
  prJson,
  prFields,
  prSigned,
  prSign,
  prData,
  feedbackPrompt,
  validatePrPolicy,
  validatePrRepository,
  type PrWatchRecord,
  type PrWatchPreview,
  type PrRemoteSnapshot,
  type PrFeedbackOccurrence,
  type PrAcceptedInput,
  type PollPrWatchInput,
  type RegisterPrWatchInput,
  type PrPollResult,
} from "./types.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const prWatchKind = (id: string) =>
  "pr.watch." + knowledgeHash(prId(id)).slice(0, 40);
export const prOccurrenceKind = (id: string) =>
  "pr.feedback." + knowledgeHash(prId(id)).slice(0, 40);
export const prInputKind = (id: string) =>
  "pr.input." + knowledgeHash(prId(id)).slice(0, 40);
export interface PrRecordPorts {
  writeTx<T>(operation: () => T): T;
  writeDocument(
    sessionId: string,
    kind: string,
    revision: number,
    data: JsonObject,
  ): unknown;
  appendEvent(
    sessionId: string,
    type: string,
    data: JsonObject,
    refs?: { inputId: string },
  ): unknown;
}
export interface PrAdmissionPorts {
  readPreview(original: object): PrWatchPreview;
  assertPreview(original: object, expected: PrWatchPreview): void;
}
export interface PrFeedbackPorts {
  readSnapshot(original: object): PrRemoteSnapshot;
  assertCurrent(original: object, watch: PrWatchRecord): void;
  sourceCurrent(original: object, watch: PrWatchRecord): boolean;
  acceptAtomic(
    original: object,
    prompt: string,
    inputRequestId: string,
  ): object;
  readAccepted(original: object): PrAcceptedInput;
  releaseAccepted(original: object): void;
}
interface Header {
  session_id: string;
  kind: string;
  revision: number;
  bytes: number;
  workspace_id: string;
}
const same = (a: unknown, b: unknown) => knowledgeHash(a) === knowledgeHash(b);
/** PR events a write must leave free: ordinary writes keep room to disable and import-pause every watch once; disable keeps room for the import pause. */
const eventReserve = (op: string) =>
  op === "import"
    ? 0
    : op === "disable"
      ? PR_LIMITS.watches
      : 2 * PR_LIMITS.watches;
function caps(db: DatabaseSync, reserve = 0) {
  const unknown = db
    .prepare(
      "SELECT kind FROM session_documents WHERE kind GLOB 'pr.*' LIMIT 513",
    )
    .all();
  if (
    unknown.length > PR_LIMITS.rows ||
    unknown.some(
      (h) => !/^pr\.(watch|feedback|input)\.[a-f0-9]{40}$/.test(String(h.kind)),
    )
  )
    prFail("PR_NAMESPACE_INVALID");
  const h = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(d.data AS BLOB))),0) bytes,max(length(CAST(d.data AS BLOB))) max FROM session_documents d WHERE kind GLOB 'pr.*'",
    )
    .get()!;
  if (
    Number(h.n) > PR_LIMITS.rows ||
    Number(h.bytes) > PR_LIMITS.totalBytes ||
    Number(h.max) > PR_LIMITS.rowBytes
  )
    prFail("PR_STORAGE_LIMIT");
  const e = db
    .prepare(
      "SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,max(length(CAST(data AS BLOB))) max FROM session_events WHERE type GLOB 'pr.*'",
    )
    .get()!;
  if (
    Number(e.n) > PR_LIMITS.requests - reserve ||
    Number(e.bytes) > 33554432 ||
    Number(e.max) > PR_LIMITS.rowBytes + 4096
  )
    prFail("PR_STORAGE_LIMIT");
}
function headers(db: DatabaseSync, glob: string, ws?: string): Header[] {
  const h = db
    .prepare(
      "SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) bytes,s.workspace_id FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE d.kind GLOB ?" +
        (ws ? " AND s.workspace_id=?" : "") +
        " LIMIT 513",
    )
    .all(...(ws ? [glob, ws] : [glob])) as unknown as Header[];
  if (h.length > PR_LIMITS.rows) prFail("PR_STORAGE_LIMIT");
  return h;
}
function header(
  db: DatabaseSync,
  session: string,
  kind: string,
): Header | undefined {
  return db
    .prepare(
      "SELECT d.session_id,d.kind,d.revision,length(CAST(d.data AS BLOB)) bytes,s.workspace_id FROM session_documents d JOIN sessions s ON s.id=d.session_id WHERE d.session_id=? AND d.kind=?",
    )
    .get(session, kind) as unknown as Header | undefined;
}
function body(db: DatabaseSync, h: Header): unknown {
  if (h.bytes < 1 || h.bytes > PR_LIMITS.rowBytes) prFail("PR_STORAGE_LIMIT");
  const row = db
    .prepare(
      "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))=?",
    )
    .get(h.session_id, h.kind, h.bytes);
  if (!row) prFail();
  const data = JSON.parse(String(row.data));
  const events = event(
    db,
    h.session_id,
    "session.document.updated",
    "kind",
    h.kind,
    "revision",
    h.revision,
  );
  if (events.length !== 1 || events[0]!.sha256 !== sha(String(row.data)))
    prFail("PR_DOCUMENT_ANCHOR_INVALID");
  return data;
}
function event(
  db: DatabaseSync,
  session: string,
  type: string,
  key: string,
  value: string | number,
  key2?: string,
  value2?: string | number,
): Record<string, any>[] {
  if (
    !["id", "watchId", "kind", "requestId", "occurrenceId"].includes(key) ||
    (key2 && !["revision", "requestId"].includes(key2))
  )
    prFail();
  const sql =
    "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND type=? AND CASE WHEN length(CAST(data AS BLOB))<=135168 THEN json_extract(data,'$.payload." +
    key +
    "') END=?" +
    (key2
      ? " AND CASE WHEN length(CAST(data AS BLOB))<=135168 THEN json_extract(data,'$.payload." +
        key2 +
        "') END=?"
      : "") +
    " LIMIT 2050";
  const hs = db
    .prepare(sql)
    .all(...(key2 ? [session, type, value, value2!] : [session, type, value]));
  if (
    hs.length > PR_LIMITS.requests ||
    hs.reduce((n, h) => n + Number(h.bytes), 0) > 33554432
  )
    prFail("PR_STORAGE_LIMIT");
  return hs.map((h) => {
    if (Number(h.bytes) > PR_LIMITS.rowBytes + 4096) prFail("PR_STORAGE_LIMIT");
    const r = db
      .prepare(
        "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
      )
      .get(session, h.seq!, h.bytes!);
    if (!r) prFail();
    return JSON.parse(String(r.data)).payload as Record<string, any>;
  });
}
export function validatePrSnapshot(
  value: unknown,
  policy: PrWatchPreview["policy"],
): PrRemoteSnapshot {
  const s = prSigned(prJson(value) as PrRemoteSnapshot);
  prFields(s, [
    "version",
    "provider",
    "repository",
    "repositoryId",
    "headRepositoryId",
    "headRepository",
    "base",
    "head",
    "state",
    "checks",
    "reviews",
    "requiredState",
    "changesRequested",
    "coverage",
    "mergeAuthority",
    "semanticSha256",
    "observedAt",
    "sha256",
  ]);
  validatePrRepository(s.repository);
  prGitSha(s.base);
  prGitSha(s.head);
  prInt(s.repositoryId, Number.MAX_SAFE_INTEGER, 1);
  prInt(s.headRepositoryId, Number.MAX_SAFE_INTEGER, 1);
  validatePrRepository({ ...s.headRepository, number: s.repository.number });
  if (
    s.version !== 1 ||
    s.provider !== "github" ||
    s.mergeAuthority !== false ||
    s.coverage !== "complete" ||
    !["open", "closed"].includes(s.state) ||
    !Array.isArray(s.checks) ||
    s.checks.length > PR_LIMITS.checks ||
    !Array.isArray(s.reviews) ||
    s.reviews.length > PR_LIMITS.reviews
  )
    prFail();
  const { observedAt, semanticSha256, sha256, ...b } = s;
  if (
    !Number.isFinite(Date.parse(observedAt)) ||
    semanticSha256 !== knowledgeHash(b)
  )
    prFail();
  const identities = new Set<string>();
  for (const c of s.checks) {
    prFields(c, [
      "kind",
      "id",
      "name",
      "appId",
      "head",
      "state",
      "conclusion",
      "observedRevision",
      "text",
    ]);
    prInt(c.id, Number.MAX_SAFE_INTEGER, 1);
    prId(c.name);
    if (
      c.head !== s.head ||
      !["check", "status"].includes(c.kind) ||
      !["pending", "failed", "passed"].includes(c.state) ||
      typeof c.text !== "string" ||
      Buffer.byteLength(c.text) > 1024
    )
      prFail();
    if (c.kind === "check") prInt(c.appId, Number.MAX_SAFE_INTEGER, 1);
    else if (c.appId !== null) prFail();
    const key = knowledgeHash([c.kind, c.name, c.appId]);
    if (identities.has(key)) prFail();
    identities.add(key);
  }
  const required = policy.required.map((p) => {
    const xs = s.checks.filter(
      (c) =>
        c.kind === p.kind &&
        c.name === p.name &&
        (p.appId === null || c.appId === p.appId),
    );
    return xs.length === 1 ? xs[0]!.state : "missing";
  });
  const computed = required.includes("failed")
    ? "failed"
    : required.includes("missing")
      ? "missing"
      : required.includes("pending")
        ? "pending"
        : "passed";
  if (s.requiredState !== computed) prFail("PR_REQUIRED_POLICY_INVALID");
  const authors = new Set<number>();
  for (const r of s.reviews) {
    prInt(r.id, Number.MAX_SAFE_INTEGER, 1);
    prInt(r.authorId, Number.MAX_SAFE_INTEGER, 1);
    if (
      r.head !== s.head ||
      authors.has(r.id) ||
      ![
        "APPROVED",
        "CHANGES_REQUESTED",
        "COMMENTED",
        "DISMISSED",
        "PENDING",
      ].includes(r.state) ||
      typeof r.body !== "string" ||
      Buffer.byteLength(r.body) > 1024 ||
      !Number.isFinite(Date.parse(r.submittedAt))
    )
      prFail();
    authors.add(r.id);
  }
  if (s.changesRequested !== prChangesRequested(s.reviews)) prFail();
  return s;
}
export function validatePrPreview(value: unknown): PrWatchPreview {
  const p = prSigned(prJson(value) as PrWatchPreview);
  prFields(p, [
    "version",
    "workspaceId",
    "sessionId",
    "id",
    "repository",
    "apiBase",
    "policy",
    "binding",
    "ownerEpoch",
    "target",
    "source",
    "createdAt",
    "sha256",
  ]);
  for (const x of [p.workspaceId, p.sessionId, p.id]) prId(x);
  prDigest(p.ownerEpoch);
  validatePrRepository(p.repository);
  validatePrPolicy(p.policy);
  validateScheduleTarget(p.target);
  if (
    p.version !== 1 ||
    p.target.workspaceId !== p.workspaceId ||
    p.target.sessionId !== p.sessionId ||
    p.binding.workspaceId !== p.workspaceId ||
    knowledgeHash(p.binding) !== p.target.workspaceBindingSha256 ||
    !Number.isFinite(Date.parse(p.createdAt))
  )
    prFail();
  if (p.source) {
    prSigned(p.source);
    prId(p.source.runId);
    prGitSha(p.source.head);
    prDigest(p.source.configurationSha256);
    prDigest(p.source.verificationDocumentSha256);
    if (
      !Array.isArray(p.source.files) ||
      !p.source.files.length ||
      p.source.files.length > 64 ||
      !p.source.receipts.length
    )
      prFail();
    for (const f of p.source.files) {
      prId(f.path);
      prDigest(f.hash);
    }
  }
  return p;
}
export function validatePrWatch(value: unknown): PrWatchRecord {
  const r = prSigned(prJson(value) as PrWatchRecord);
  prFields(r, [
    "version",
    "revision",
    "preview",
    "state",
    "registrationRequestId",
    "registrationSha256",
    "cursor",
    "repairInputs",
    "snapshot",
    "gap",
    "nextPollAt",
    "importSha256",
    "createdAt",
    "updatedAt",
    "sha256",
  ]);
  validatePrPreview(r.preview);
  prInt(r.revision, 2048, 1);
  prInt(r.cursor, 2048);
  prInt(r.repairInputs, r.preview.policy.maxRepairInputs);
  prDigest(r.registrationSha256);
  prId(r.registrationRequestId);
  if (
    r.version !== 1 ||
    !["active", "denied", "disabled", "paused-import"].includes(r.state) ||
    (r.state === "paused-import" && !r.importSha256) ||
    (r.state !== "paused-import" && r.importSha256 !== null)
  )
    prFail();
  if (r.snapshot) validatePrSnapshot(r.snapshot, r.preview.policy);
  return r;
}
export function validatePrOccurrence(value: unknown): PrFeedbackOccurrence {
  const o = prSigned(prJson(value) as PrFeedbackOccurrence);
  prFields(o, [
    "version",
    "id",
    "revision",
    "workspaceId",
    "sessionId",
    "watchId",
    "watchSha256",
    "preview",
    "snapshot",
    "state",
    "source",
    "repairEligible",
    "inputRequestId",
    "prompt",
    "accepted",
    "createdAt",
    "sha256",
  ]);
  validatePrPreview(o.preview);
  validatePrSnapshot(o.snapshot, o.preview.policy);
  if (
    o.version !== 1 ||
    o.id !== knowledgeHash([o.preview.sha256, o.snapshot.semanticSha256]) ||
    o.watchId !== o.preview.id ||
    o.sessionId !== o.preview.sessionId ||
    o.workspaceId !== o.preview.workspaceId ||
    o.inputRequestId !== "pr-feedback:" + o.id ||
    ![1, 2].includes(o.revision) ||
    !["accepted", "advisory", "paused-import"].includes(o.state) ||
    (o.state === "paused-import") !== (o.revision === 2)
  )
    prFail();
  if (o.repairEligible) {
    if (
      !o.source ||
      !same(o.source, o.preview.source) ||
      o.source.head !== o.snapshot.head ||
      o.snapshot.state !== "open" ||
      !(o.snapshot.requiredState === "failed" || o.snapshot.changesRequested) ||
      !o.accepted ||
      o.prompt !== feedbackPrompt(o) ||
      o.accepted.requestId !== o.inputRequestId ||
      o.accepted.inputSha256 !== knowledgeHash(normalized(o))
    )
      prFail("PR_REPAIR_INVALID");
    prId(o.accepted.inputId);
    prInt(o.accepted.admittedSeq, Number.MAX_SAFE_INTEGER, 1);
  } else if (
    o.source !== null ||
    o.accepted !== null ||
    o.prompt !== null ||
    o.state === "accepted"
  )
    prFail();
  return o;
}
function normalized(o: PrFeedbackOccurrence): AcceptInput {
  return normalizeAcceptInput({
    sessionId: o.sessionId,
    requestId: o.inputRequestId,
    prompt: o.prompt!,
    config: o.preview.target.config,
    delivery: "queue",
  });
}
function sourceSql(db: DatabaseSync, p: PrWatchPreview) {
  if (!p.source) return;
  const e = p.source;
  validateCommitVerification(db, {
    runId: e.runId,
    workspaceId: p.workspaceId,
    sessionId: p.sessionId,
    verificationRevision: e.verificationRevision,
    verificationDocumentSha256: e.verificationDocumentSha256,
    verification: [...e.receipts],
    source: e.verificationSource,
  } as unknown as GitCommitPreview);
}
function watchGraph(db: DatabaseSync, r: PrWatchRecord) {
  const p = r.preview;
  const births = event(db, p.sessionId, "pr.watch.admitted", "id", p.id);
  if (
    births.length !== 1 ||
    !same(births[0]!.preview, p) ||
    births[0]!.registrationSha256 !== r.registrationSha256 ||
    births[0]!.requestId !== r.registrationRequestId
  )
    prFail("PR_REGISTRATION_ANCHOR_INVALID");
  sourceSql(db, p);
  const transitions = event(db, p.sessionId, "pr.watch.transition", "id", p.id);
  let prev: PrWatchRecord | null = null;
  for (const e of transitions) {
    const x = validatePrWatch(e.record);
    if (
      x.revision !== (prev?.revision ?? 0) + 1 ||
      e.beforeSha256 !== (prev?.sha256 ?? null) ||
      !same(x.preview, p) ||
      x.registrationSha256 !== r.registrationSha256
    )
      prFail("PR_WATCH_REPLAY_INVALID");
    if (!prev) {
      if (
        x.cursor ||
        x.repairInputs ||
        x.snapshot ||
        x.gap ||
        x.revision !== 1 ||
        !["active", "denied"].includes(x.state) ||
        e.operation !== "register"
      )
        prFail();
    } else {
      if (
        x.createdAt !== prev.createdAt ||
        x.registrationRequestId !== prev.registrationRequestId
      )
        prFail();
      if (e.operation === "poll") {
        if (
          prev.state !== "active" ||
          x.state !== "active" ||
          x.cursor !== prev.cursor + 1 ||
          !x.snapshot ||
          x.gap !== null ||
          x.repairInputs < prev.repairInputs ||
          x.repairInputs > prev.repairInputs + 1
        )
          prFail();
        const observations = event(
          db,
          p.sessionId,
          "pr.remote.observed",
          "watchId",
          p.id,
          "revision",
          x.revision,
        );
        if (
          observations.length !== 1 ||
          !same(observations[0]!.snapshot, x.snapshot)
        )
          prFail("PR_REMOTE_ANCHOR_INVALID");
        const births = event(
          db,
          p.sessionId,
          "pr.feedback.admitted",
          "id",
          e.occurrenceId,
        );
        if (births.length !== 1) prFail();
        const admitted = validatePrOccurrence(births[0]!.occurrence);
        if (
          admitted.watchSha256 !== prev.sha256 ||
          !same(admitted.snapshot, x.snapshot) ||
          x.repairInputs !==
            prev.repairInputs + (admitted.repairEligible ? 1 : 0)
        )
          prFail("PR_REPAIR_COUNTER_INVALID");
      } else if (e.operation === "gap") {
        if (
          x.state !== prev.state ||
          x.cursor !== prev.cursor ||
          x.repairInputs !== prev.repairInputs ||
          !same(x.snapshot, prev.snapshot) ||
          typeof x.gap !== "string"
        )
          prFail();
      } else if (e.operation === "disable" || e.operation === "import") {
        if (
          x.state !==
            (e.operation === "import" ? "paused-import" : "disabled") ||
          x.cursor !== prev.cursor ||
          x.repairInputs !== prev.repairInputs ||
          !same(x.snapshot, prev.snapshot)
        )
          prFail();
      } else prFail();
    }
    prev = x;
  }
  if (!prev || !same(prev, r)) prFail("PR_HEAD_REPLAY_INVALID");
}
function acceptedSql(db: DatabaseSync, o: PrFeedbackOccurrence) {
  if (!o.accepted) return;
  const a = o.accepted,
    h = db
      .prepare(
        "SELECT i.session_id,s.workspace_id,i.request_id,i.fingerprint,i.admitted_seq,i.state,i.delivery,i.run_id,i.promoted_seq,length(CAST(i.data AS BLOB)) bytes FROM session_inputs i JOIN sessions s ON s.id=i.session_id WHERE i.id=?",
      )
      .get(a.inputId);
  if (!h || Number(h.bytes) > 262144) prFail("PR_INPUT_INVALID");
  const input = validateInputRecord(
      JSON.parse(
        String(
          db
            .prepare(
              "SELECT data FROM session_inputs WHERE id=? AND length(CAST(data AS BLOB))=?",
            )
            .get(a.inputId, h.bytes!)!.data,
        ),
      ),
    ),
    request = normalized(o);
  if (
    input.id !== a.inputId ||
    input.sessionId !== o.sessionId ||
    input.workspaceId !== o.workspaceId ||
    input.requestId !== o.inputRequestId ||
    input.admittedSeq !== a.admittedSeq ||
    input.prompt !== o.prompt ||
    !same(input.config, request.config) ||
    input.delivery !== "queue" ||
    Object.hasOwn(input, "attachments") ||
    Object.hasOwn(input, "documents") ||
    h.fingerprint !== requestIdentity(request) ||
    h.session_id !== input.sessionId ||
    h.workspace_id !== input.workspaceId ||
    h.state !== input.state ||
    h.delivery !== input.delivery ||
    h.run_id !== (input.runId ?? null) ||
    h.promoted_seq !== (input.promotedSeq ?? null) ||
    h.admitted_seq !== input.admittedSeq ||
    h.request_id !== input.requestId
  )
    prFail("PR_INPUT_INVALID");
  const births = db
    .prepare(
      "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND input_id=? AND type='input.accepted' LIMIT 2",
    )
    .all(o.sessionId, a.inputId);
  if (
    births.length !== 1 ||
    births[0]!.seq !== a.admittedSeq ||
    Number(births[0]!.bytes) > 262144
  )
    prFail();
  const b = JSON.parse(
    String(
      db
        .prepare(
          "SELECT data FROM session_events WHERE session_id=? AND seq=? AND length(CAST(data AS BLOB))=?",
        )
        .get(o.sessionId, births[0]!.seq!, births[0]!.bytes!)!.data,
    ),
  ).payload.input;
  if (
    b.id !== a.inputId ||
    b.state !== "pending" ||
    b.sessionId !== o.sessionId ||
    b.workspaceId !== o.workspaceId ||
    b.requestId !== o.inputRequestId ||
    b.admittedSeq !== a.admittedSeq ||
    b.prompt !== o.prompt ||
    b.delivery !== "queue" ||
    Object.hasOwn(b, "attachments") ||
    Object.hasOwn(b, "documents") ||
    !same(b.config, request.config)
  )
    prFail("PR_INPUT_BIRTH_INVALID");
  const links = event(db, o.sessionId, "pr.feedback.admitted", "id", o.id);
  if (links.length !== 1 || !same(links[0]!.occurrence, o)) {
    if (
      o.state !== "paused-import" ||
      links.length !== 1 ||
      !same(
        {
          ...o,
          state: links[0]!.occurrence.state,
          revision: 1,
          sha256: links[0]!.occurrence.sha256,
        },
        links[0]!.occurrence,
      )
    )
      prFail("PR_FEEDBACK_ANCHOR_INVALID");
  }
  const lh = header(db, o.sessionId, prInputKind(a.inputId));
  if (!lh) prFail("PR_LINK_MISSING");
  const l = body(db, lh) as any;
  if (
    l.inputId !== a.inputId ||
    l.occurrenceId !== o.id ||
    l.birthSha256 !== links[0]!.occurrence.sha256
  )
    prFail("PR_LINK_INVALID");
}
export class PrFeedbackStorage {
  constructor(
    readonly db: DatabaseSync,
    readonly ports: PrRecordPorts,
  ) {}
  private write(
    r: PrWatchRecord,
    prev: PrWatchRecord | null,
    op: string,
    requestId: string,
    requestSha256: string,
    occurrenceId: string | null = null,
  ) {
    prSigned(r);
    caps(this.db);
    this.ports.writeDocument(
      r.preview.sessionId,
      prWatchKind(r.preview.id),
      prev?.revision ?? 0,
      prData(r),
    );
    this.ports.appendEvent(
      r.preview.sessionId,
      "pr.watch.transition",
      prData({
        id: r.preview.id,
        beforeSha256: prev?.sha256 ?? null,
        operation: op,
        requestId,
        requestSha256,
        record: r,
        occurrenceId,
      }),
    );
    caps(this.db, eventReserve(op));
    return r;
  }
  get(ws: string, session: string, id: string): PrWatchRecord | null {
    prId(ws);
    prId(session);
    const h = header(this.db, session, prWatchKind(id));
    if (!h) return null;
    caps(this.db);
    const r = validatePrWatch(body(this.db, h));
    if (
      r.preview.workspaceId !== ws ||
      h.workspace_id !== ws ||
      h.revision !== r.revision
    )
      prFail();
    watchGraph(this.db, r);
    return r;
  }
  list(ws?: string): PrWatchRecord[] {
    caps(this.db);
    return headers(this.db, "pr.watch.*", ws).map((h) =>
      this.get(
        h.workspace_id,
        h.session_id,
        JSON.parse(
          String(
            this.db
              .prepare(
                "SELECT data FROM session_documents WHERE session_id=? AND kind=? AND length(CAST(data AS BLOB))=?",
              )
              .get(h.session_id, h.kind, h.bytes)!.data,
          ),
        ).preview.id,
      )!,
    );
  }
  occurrence(
    ws: string,
    session: string,
    id: string,
  ): PrFeedbackOccurrence | null {
    const h = header(this.db, session, prOccurrenceKind(id));
    if (!h) return null;
    caps(this.db);
    const o = validatePrOccurrence(body(this.db, h));
    if (
      o.id !== id ||
      o.workspaceId !== ws ||
      h.workspace_id !== ws ||
      o.revision !== h.revision
    )
      prFail();
    sourceSql(this.db, o.preview);
    const b = event(this.db, session, "pr.feedback.admitted", "id", id);
    if (b.length !== 1) prFail();
    const born = validatePrOccurrence(b[0]!.occurrence);
    if (
      !same(
        o.state === "paused-import"
          ? { ...o, state: born.state, revision: 1, sha256: born.sha256 }
          : o,
        born,
      )
    )
      prFail("PR_FEEDBACK_ANCHOR_INVALID");
    acceptedSql(this.db, o);
    return o;
  }
  occurrences(ws?: string): PrFeedbackOccurrence[] {
    caps(this.db);
    return headers(this.db, "pr.feedback.*", ws).map((h) => {
      const x = body(this.db, h) as PrFeedbackOccurrence;
      return this.occurrence(h.workspace_id, h.session_id, x.id)!;
    });
  }
  request(input: PollPrWatchInput): PrPollResult | null {
    const i = prJson(input);
    const matches = [
      ...event(
        this.db,
        i.sessionId,
        "pr.watch.transition",
        "id",
        i.watchId,
        "requestId",
        i.requestId,
      ),
      ...event(
        this.db,
        i.sessionId,
        "pr.request.duplicate",
        "id",
        i.watchId,
        "requestId",
        i.requestId,
      ),
    ];
    if (!matches.length) return null;
    if (matches.length !== 1 || matches[0]!.requestSha256 !== knowledgeHash(i))
      prFail("PR_REQUEST_CONFLICT");
    const r = validatePrWatch(matches[0]!.record);
    watchGraph(this.db, this.get(i.workspaceId, i.sessionId, i.watchId)!);
    return {
      kind: "duplicate",
      watch: r,
      occurrence: matches[0]!.occurrenceId
        ? this.occurrence(i.workspaceId, i.sessionId, matches[0]!.occurrenceId)
        : null,
    };
  }
  checkWatermarks(
    session: string,
    id: string,
    head: string,
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const p of event(
      this.db,
      session,
      "pr.remote.observed",
      "watchId",
      id,
    )) {
      const s = p.snapshot as PrRemoteSnapshot;
      if (s.head !== head) continue;
      for (const c of s.checks) {
        const k = knowledgeHash([c.kind, c.name, c.appId]);
        map.set(k, Math.max(map.get(k) ?? 0, c.id));
      }
    }
    return map;
  }
  deliveryRequest(
    ws: string,
    session: string,
    id: string,
    requestId: string,
  ): PrPollResult | null {
    const rows = [
      ...event(
        this.db,
        session,
        "pr.watch.transition",
        "id",
        id,
        "requestId",
        requestId,
      ),
      ...event(
        this.db,
        session,
        "pr.request.duplicate",
        "id",
        id,
        "requestId",
        requestId,
      ),
    ];
    if (!rows.length) return null;
    if (rows.length !== 1) prFail();
    const record = validatePrWatch(rows[0]!.record);
    return this.request({
      workspaceId: ws,
      sessionId: session,
      watchId: id,
      requestId,
      expectedRevision: rows[0]!.expectedRevision ?? record.revision - 1,
    });
  }
  register(
    original: object,
    input: RegisterPrWatchInput,
    producer: PrAdmissionPorts,
  ): PrWatchRecord {
    const i = prJson(input);
    prFields(i, [
      "workspaceId",
      "sessionId",
      "watchId",
      "requestId",
      "expectedRevision",
      "previewSha256",
      "decision",
    ]);
    for (const k of [i.workspaceId, i.sessionId, i.watchId, i.requestId])
      prId(k);
    prDigest(i.previewSha256);
    if (i.expectedRevision !== 0 || !["allow", "deny"].includes(i.decision))
      prFail();
    return this.ports.writeTx(() => {
      const prior = this.get(i.workspaceId, i.sessionId, i.watchId);
      if (prior) {
        if (prior.registrationSha256 !== knowledgeHash(i))
          prFail("PR_REQUEST_CONFLICT");
        return prior;
      }
      if (headers(this.db, "pr.watch.*").length >= PR_LIMITS.watches)
        prFail("PR_STORAGE_LIMIT");
      const p = validatePrPreview(producer.readPreview(original));
      if (
        p.sha256 !== i.previewSha256 ||
        p.id !== i.watchId ||
        p.workspaceId !== i.workspaceId ||
        p.sessionId !== i.sessionId
      )
        prFail("PR_PREVIEW_STALE");
      producer.assertPreview(original, p);
      sourceSql(this.db, p);
      const now = new Date().toISOString(),
        r = prSign({
          version: 1 as const,
          revision: 1,
          preview: p,
          state:
            i.decision === "allow" ? ("active" as const) : ("denied" as const),
          registrationRequestId: i.requestId,
          registrationSha256: knowledgeHash(i),
          cursor: 0,
          repairInputs: 0,
          snapshot: null,
          gap: null,
          nextPollAt: null,
          importSha256: null,
          createdAt: now,
          updatedAt: now,
        });
      this.ports.appendEvent(
        i.sessionId,
        "pr.watch.admitted",
        prData({
          id: i.watchId,
          preview: p,
          requestId: i.requestId,
          registrationSha256: r.registrationSha256,
        }),
      );
      return this.write(r, null, "register", i.requestId, knowledgeHash(i));
    });
  }
  consume(
    original: object,
    input: PollPrWatchInput,
    producer: PrFeedbackPorts,
    durable = true,
  ): PrPollResult {
    const i = prJson(input);
    return this.ports.writeTx(() => {
      const duplicate = this.request(i);
      if (duplicate) return duplicate;
      const prev = this.get(i.workspaceId, i.sessionId, i.watchId);
      if (
        !prev ||
        prev.state !== "active" ||
        prev.revision !== i.expectedRevision
      )
        prFail("PR_WATCH_STALE");
      producer.assertCurrent(original, prev);
      const s = validatePrSnapshot(
        producer.readSnapshot(original),
        prev.preview.policy,
      );
      if (!same(s.repository, prev.preview.repository)) prFail();
      const id = knowledgeHash([prev.preview.sha256, s.semanticSha256]),
        prior = this.occurrence(i.workspaceId, i.sessionId, id);
      if (prior) {
        if (durable) {
          this.ports.appendEvent(
            i.sessionId,
            "pr.request.duplicate",
            prData({
              id: i.watchId,
              requestId: i.requestId,
              requestSha256: knowledgeHash(i),
              expectedRevision: i.expectedRevision,
              record: prev,
              occurrenceId: prior.id,
            }),
          );
          caps(this.db, eventReserve("duplicate"));
        }
        return { kind: "duplicate", watch: prev, occurrence: prior };
      }
      if (headers(this.db, "pr.feedback.*").length >= PR_LIMITS.occurrences)
        prFail("PR_STORAGE_LIMIT");
      const repairEligible =
        !!prev.preview.source &&
        prev.preview.source.head === s.head &&
        s.state === "open" &&
        (s.requiredState === "failed" || s.changesRequested) &&
        prev.repairInputs < prev.preview.policy.maxRepairInputs &&
        producer.sourceCurrent(original, prev);
      const body = {
        version: 1 as const,
        id,
        revision: 1,
        workspaceId: i.workspaceId,
        sessionId: i.sessionId,
        watchId: i.watchId,
        watchSha256: prev.sha256,
        preview: prev.preview,
        snapshot: s,
        state: repairEligible ? ("accepted" as const) : ("advisory" as const),
        source: repairEligible ? prev.preview.source : null,
        repairEligible,
        inputRequestId: "pr-feedback:" + id,
        prompt: null as string | null,
        accepted: null as PrAcceptedInput | null,
        createdAt: new Date().toISOString(),
      };
      if (repairEligible) {
        body.prompt = feedbackPrompt(body);
        const cap = producer.acceptAtomic(
          original,
          body.prompt,
          body.inputRequestId,
        );
        if (
          types.isPromise(cap) ||
          !cap ||
          typeof cap !== "object" ||
          types.isProxy(cap)
        )
          prFail("PR_ASYNC_PRODUCER");
        try {
          body.accepted = prJson(producer.readAccepted(cap));
        } finally {
          producer.releaseAccepted(cap);
        }
      }
      const o = validatePrOccurrence(prSign(body));
      this.ports.writeDocument(i.sessionId, prOccurrenceKind(id), 0, prData(o));
      this.ports.appendEvent(
        i.sessionId,
        "pr.feedback.admitted",
        prData({ id, watchId: i.watchId, occurrence: o }),
        o.accepted ? { inputId: o.accepted.inputId } : undefined,
      );
      if (o.accepted)
        this.ports.writeDocument(
          i.sessionId,
          prInputKind(o.accepted.inputId),
          0,
          {
            inputId: o.accepted.inputId,
            occurrenceId: o.id,
            birthSha256: o.sha256,
          },
        );
      this.ports.appendEvent(
        i.sessionId,
        "pr.remote.observed",
        prData({
          watchId: i.watchId,
          revision: prev.revision + 1,
          snapshot: s,
        }),
      );
      const r = prSign({
        ...prev,
        revision: prev.revision + 1,
        cursor: prev.cursor + 1,
        repairInputs: prev.repairInputs + (repairEligible ? 1 : 0),
        snapshot: s,
        gap: null,
        nextPollAt: null,
        updatedAt: new Date().toISOString(),
      });
      this.write(r, prev, "poll", i.requestId, knowledgeHash(i), id);
      acceptedSql(this.db, o);
      return { kind: "updated", watch: r, occurrence: o };
    });
  }
  gap(
    input: PollPrWatchInput,
    code: string,
    nextPollAt: string | null,
    durable = true,
  ): PrPollResult {
    const i = prJson(input);
    return this.ports.writeTx(() => {
      const d = this.request(i);
      if (d) return d;
      const p = this.get(i.workspaceId, i.sessionId, i.watchId);
      if (!p || p.state !== "active" || p.revision !== i.expectedRevision)
        prFail("PR_WATCH_STALE");
      if (!durable && p.gap === code && p.nextPollAt === nextPollAt)
        return { kind: "gap", watch: p, occurrence: null };
      const r = prSign({
        ...p,
        revision: p.revision + 1,
        gap: prId(code),
        nextPollAt,
        updatedAt: new Date().toISOString(),
      });
      this.write(r, p, "gap", i.requestId, knowledgeHash(i));
      return { kind: "gap", watch: r, occurrence: null };
    });
  }
  control(
    input: PollPrWatchInput,
    state: "disabled" | "paused-import",
    archive: string | null = null,
  ): PrWatchRecord {
    return this.ports.writeTx(() => {
      const p = this.get(input.workspaceId, input.sessionId, input.watchId);
      if (!p || p.revision !== input.expectedRevision) prFail("PR_WATCH_STALE");
      const r = prSign({
        ...p,
        revision: p.revision + 1,
        state,
        importSha256: archive,
        updatedAt: new Date().toISOString(),
      });
      return this.write(
        r,
        p,
        state === "disabled" ? "disable" : "import",
        input.requestId,
        knowledgeHash(input),
      );
    });
  }
  pause(ws: string, archive: string) {
    prDigest(archive);
    this.ports.writeTx(() => {
      for (const r of this.list(ws)) {
        if (r.state !== "paused-import")
          this.control(
            {
              workspaceId: ws,
              sessionId: r.preview.sessionId,
              watchId: r.preview.id,
              requestId: "import:" + archive,
              expectedRevision: r.revision,
            },
            "paused-import",
            archive,
          );
      }
      for (const o of this.occurrences(ws)) {
        if (o.state === "paused-import") continue;
        this.ports.writeDocument(
          o.sessionId,
          prOccurrenceKind(o.id),
          1,
          prData(
            prSign({ ...o, revision: 2, state: "paused-import" as const }),
          ),
        );
      }
    });
  }
  findInput(
    input: Pick<InputRecord, "workspaceId" | "sessionId" | "id" | "requestId">,
  ): PrFeedbackOccurrence | null {
    const h = header(this.db, input.sessionId, prInputKind(input.id));
    const anchors = this.db
      .prepare(
        "SELECT seq,length(CAST(data AS BLOB)) bytes FROM session_events WHERE session_id=? AND input_id=? AND type='pr.feedback.admitted' LIMIT 2",
      )
      .all(input.sessionId, input.id);
    if (!h && !anchors.length) {
      if (input.requestId.startsWith("pr-feedback:")) prFail("PR_LINK_MISSING");
      return null;
    }
    if (!h || anchors.length !== 1) prFail("PR_LINK_MISSING");
    const link = body(this.db, h) as any,
      record = this.occurrence(
        input.workspaceId,
        input.sessionId,
        link.occurrenceId,
      );
    if (
      !record?.accepted ||
      record.accepted.inputId !== input.id ||
      record.inputRequestId !== input.requestId
    )
      prFail("PR_LINK_INVALID");
    return record;
  }
}
export function validatePrFeedbackDatabase(
  db: DatabaseSync,
  options: { check?: () => void } = {},
) {
  caps(db);
  const records = new PrFeedbackStorage(db, {
    writeTx: () => prFail(),
    writeDocument: () => prFail(),
    appendEvent: () => prFail(),
  });
  for (const r of records.list()) options.check?.();
  for (const o of records.occurrences()) options.check?.();
  const born = db
    .prepare(
      "SELECT count(*) n FROM session_events WHERE type='pr.watch.admitted'",
    )
    .get()!;
  if (Number(born.n) !== headers(db, "pr.watch.*").length)
    prFail("PR_ORPHAN_WATCH");
  for (const h of headers(db, "pr.input.*")) {
    const link = body(db, h) as any;
    const o = records.occurrence(
      h.workspace_id,
      h.session_id,
      link.occurrenceId,
    );
    if (
      !o?.accepted ||
      o.accepted.inputId !== link.inputId ||
      h.kind !== prInputKind(link.inputId) ||
      h.revision !== 1
    )
      prFail("PR_LINK_INVALID");
  }
  const feedback = db
    .prepare(
      "SELECT count(*) n FROM session_events WHERE type='pr.feedback.admitted'",
    )
    .get()!;
  if (Number(feedback.n) !== headers(db, "pr.feedback.*").length)
    prFail("PR_ORPHAN_FEEDBACK");
}
