import {
  canonicalAttemptCleanupSha256,
  type AttemptCleanupRecord,
} from "../storage/attempt-cleanup.js";
import {
  EngineError,
  type InputMediaAttachment,
  type MessagePart,
  type Run,
} from "@moodcode/contracts";
import {
  validateMessagePart,
  validateProviderAttempt,
  normalizeSubmitInput,
  validateTurnRecord,
  validateSessionEvent,
} from "@moodcode/contracts/validation";
import type { DatabaseSync } from "node:sqlite";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, dirname, parse, sep } from "node:path";
import {
  attachment,
  attachments,
  digest,
  sameAttachment,
} from "./segment-validation.js";
import { decodeMediaSegments, decodePcmWave } from "./segments.js";
import { jobJson } from "../jobs/validation.js";
function bad(): never {
  throw new EngineError(
    "MEDIA_HISTORY_INVALID",
    "Media history lacks exact native source and provider evidence",
  );
}
function parseRow(
  row: Record<string, unknown> | undefined,
  max = 65536,
): unknown {
  if (
    !row ||
    !Number.isSafeInteger(Number(row.bytes)) ||
    Number(row.bytes) > max
  )
    bad();
  return jobJson(JSON.parse(String(row.data)), max);
}
function jsonRecord(
  db: DatabaseSync,
  table: "runs" | "provider_attempts" | "session_turns",
  id: string,
): Record<string, unknown> {
  const columns =
    table === "runs"
      ? "workspace_id"
      : table === "provider_attempts"
        ? "run_id,turn_id,attempt_index"
        : "run_id";
  const row = db
    .prepare(
      `SELECT id,session_id,${columns},state,length(CAST(data AS BLOB)) AS bytes,substr(data,1,1048577) AS data FROM ${table} WHERE id=?`,
    )
    .get(id);
  if (!row) bad();
  return row;
}
function hash(value: unknown): string {
  return digest(Buffer.from(JSON.stringify(value)));
}
export interface MediaHistory {
  sources: Array<InputMediaAttachment & { sessionId: string }>;
  outputs: Array<Extract<MessagePart, { type: "media" }>>;
}
/** Bounded current/historical DATA validation; none of these records grants a live provider capability. */
export function validateMediaDatabase(
  db: DatabaseSync,
  check: () => void = () => {},
): MediaHistory {
  if (Number(db.prepare("PRAGMA user_version").get()?.user_version) < 2) {
    for (const table of ["inputs", "runs", "messages"])
      if (
        db
          .prepare(
            `SELECT 1 FROM ${table} WHERE json_type(data,'$.media') IS NOT NULL AND json_extract(data,'$.media')!='[]' LIMIT 1`,
          )
          .get()
      )
        bad();
    return { sources: [], outputs: [] };
  }
  const sources: MediaHistory["sources"] = [],
    indexed = new Map<string, InputMediaAttachment>();
  let indexBytes = 0;
  const indexCap = db
    .prepare(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM session_documents WHERE kind='input_media_segments'",
    )
    .get()!;
  if (Number(indexCap.count) > 128 || Number(indexCap.bytes) > 1048576) bad();
  const indexes = db
    .prepare(
      "SELECT d.session_id,d.revision,length(CAST(d.data AS BLOB)) AS bytes,d.data,w.id AS workspace_id,w.data AS workspace_data FROM session_documents d JOIN sessions s ON s.id=d.session_id JOIN workspaces w ON w.id=s.workspace_id WHERE d.kind='input_media_segments' LIMIT 129",
    )
    .all();
  if (indexes.length > 128) bad();
  for (const row of indexes) {
    check();
    const data = parseRow(row) as Record<string, unknown>;
    if (
      (indexBytes += Number(row.bytes)) > 1048576 ||
      Object.keys(data).sort().join(",") !== "attachments,owner,version" ||
      data.version !== 1 ||
      Number(row.revision) < 1 ||
      !Array.isArray(data.attachments) ||
      data.attachments.length > 32
    )
      bad();
    const workspace = JSON.parse(String(row.workspace_data)),
      owner = data.owner as Record<string, unknown>;
    if (
      !owner ||
      Object.keys(owner).sort().join(",") !==
        "sessionId,workspaceId,workspaceRoot" ||
      owner.sessionId !== row.session_id ||
      owner.workspaceId !== row.workspace_id ||
      owner.workspaceRoot !== workspace.root
    )
      bad();
    let bytes = 0;
    for (const raw of data.attachments) {
      const ref = attachment(raw),
        key = String(row.session_id) + ":" + ref.id;
      if (
        indexed.has(key) ||
        sources.length >= 4096 ||
        (bytes += ref.bytes) > 16777216
      )
        bad();
      indexed.set(key, ref);
      sources.push({ ...ref, sessionId: String(row.session_id) });
    }
  }
  let refsBytes = 0;
  for (const table of [
    "inputs",
    "runs",
    "messages",
    "session_inputs",
  ] as const) {
    const cap = db
      .prepare(
        `SELECT count(*) AS count,coalesce(sum(length(CAST(json_extract(data,'$.media') AS BLOB))),0) AS bytes FROM ${table} WHERE json_type(data,'$.media') IS NOT NULL AND json_type(data,'$.media')!='null'`,
      )
      .get()!;
    if (Number(cap.count) > 4096 || Number(cap.bytes) + refsBytes > 16777216)
      bad();
    const rows = db
      .prepare(
        `SELECT d.rowid AS position,d.session_id,json_extract(d.data,'$.sessionId') AS owner,json_extract(d.data,'$.role') AS role,length(CAST(json_extract(d.data,'$.media') AS BLOB)) AS bytes,json_extract(d.data,'$.media') AS data,s.id AS actual_session FROM ${table} d LEFT JOIN sessions s ON s.id=d.session_id WHERE json_type(d.data,'$.media') IS NOT NULL AND json_type(d.data,'$.media')!='null' LIMIT 4097`,
      )
      .all();
    if (rows.length > 4096) bad();
    for (const row of rows) {
      check();
      if (
        row.owner !== row.session_id ||
        !row.actual_session ||
        (table === "messages" && row.role !== "user") ||
        (refsBytes += Number(row.bytes)) > 16777216
      )
        bad();
      for (const ref of attachments(parseRow(row))) {
        const original = indexed.get(String(row.session_id) + ":" + ref.id);
        if (!original || !sameAttachment(ref, original)) bad();
      }
    }
  }
  const outputs: MediaHistory["outputs"] = [];
  let partBytes = 0;
  const outputCap = db
    .prepare(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM message_parts WHERE json_extract(data,'$.artifact.identity.source')='provider'",
    )
    .get()!;
  if (Number(outputCap.count) > 4096 || Number(outputCap.bytes) > 16777216)
    bad();
  const rows = db
    .prepare(
      "SELECT *,length(CAST(data AS BLOB)) AS bytes FROM message_parts WHERE json_extract(data,'$.artifact.identity.source')='provider' LIMIT 4097",
    )
    .all();
  if (rows.length > 4096) bad();
  for (const row of rows) {
    check();
    if ((partBytes += Number(row.bytes)) > 16777216) bad();
    const part = validateMessagePart(parseRow(row));
    if (
      part.type !== "media" ||
      !("source" in part.artifact.identity) ||
      part.id !== row.id ||
      part.sessionId !== row.session_id ||
      part.runId !== row.run_id ||
      part.turnId !== row.turn_id ||
      part.state !== row.state ||
      part.revision !== row.revision
    )
      bad();
    const id = part.artifact.identity,
      ar = jsonRecord(db, "provider_attempts", id.attemptId),
      attempt = validateProviderAttempt(parseRow(ar)),
      rr = jsonRecord(db, "runs", id.runId),
      run = parseRow(rr, 1048576) as unknown as Run,
      tr = jsonRecord(db, "session_turns", id.turnId),
      turn = validateTurnRecord(parseRow(tr));
    const normalized = normalizeSubmitInput({
      sessionId: run.sessionId,
      requestId: run.requestId,
      prompt: run.prompt,
      config: run.config,
    });
    if (hash(normalized.config) !== hash(run.config) || run.state !== rr.state)
      bad();
    if (
      id.source !== "provider" ||
      id.sessionId !== part.sessionId ||
      id.runId !== part.runId ||
      id.turnId !== part.turnId ||
      attempt.id !== ar.id ||
      attempt.sessionId !== ar.session_id ||
      attempt.runId !== ar.run_id ||
      attempt.turnId !== ar.turn_id ||
      attempt.index !== ar.attempt_index ||
      attempt.state !== ar.state ||
      attempt.sessionId !== id.sessionId ||
      attempt.runId !== id.runId ||
      attempt.turnId !== id.turnId ||
      attempt.providerId !== id.providerId ||
      attempt.modelId !== id.modelId ||
      !attempt.dispatchedAt ||
      run.id !== rr.id ||
      run.sessionId !== rr.session_id ||
      run.workspaceId !== rr.workspace_id ||
      run.config.providerId !== id.providerId ||
      run.config.modelId !== id.modelId ||
      turn.id !== tr.id ||
      turn.sessionId !== tr.session_id ||
      turn.runId !== tr.run_id ||
      turn.state !== tr.state ||
      turn.sessionId !== id.sessionId ||
      turn.runId !== id.runId
    )
      bad();
    const anchors = db
      .prepare(
        "SELECT *,length(CAST(data AS BLOB)) AS bytes FROM session_events WHERE session_id=? AND type='provider.media.admitted' AND json_extract(data,'$.payload.part.id')=? LIMIT 2",
      )
      .all(part.sessionId, part.id);
    if (anchors.length !== 1) bad();
    const anchor = validateSessionEvent(parseRow(anchors[0])),
      original = validateMessagePart(anchor.payload.part),
      born = validateProviderAttempt(anchor.payload.attempt);
    if (
      anchor.runId !== part.runId ||
      anchor.turnId !== part.turnId ||
      anchor.attemptId !== attempt.id ||
      original.type !== "media" ||
      original.revision !== 0 ||
      original.state !== "open" ||
      original.id !== part.id ||
      original.sessionId !== part.sessionId ||
      original.turnId !== part.turnId ||
      original.runId !== part.runId ||
      original.messageId !== part.messageId ||
      original.index !== part.index ||
      original.mime !== part.mime ||
      original.name !== part.name ||
      original.createdAt !== part.createdAt ||
      hash(original.artifact) !== hash(part.artifact) ||
      born.id !== attempt.id ||
      born.providerId !== attempt.providerId ||
      born.modelId !== attempt.modelId ||
      born.turnId !== attempt.turnId ||
      born.runId !== attempt.runId ||
      born.sessionId !== attempt.sessionId ||
      born.dispatchedAt !== attempt.dispatchedAt
    )
      bad();
    const admitted = db
      .prepare(
        "SELECT data,length(CAST(data AS BLOB)) AS bytes FROM session_events WHERE session_id=? AND attempt_id=? AND type IN ('provider.attempt.streaming','provider.attempt.dispatched') AND json_extract(data,'$.payload.attempt.state')=? LIMIT 2",
      )
      .all(part.sessionId, born.id, born.state);
    if (
      admitted.length !== 1 ||
      hash(validateSessionEvent(parseRow(admitted[0])).payload.attempt) !==
        hash(born)
    )
      bad();
    const cr = db
        .prepare(
          "SELECT *,length(CAST(data AS BLOB)) AS bytes FROM attempt_cleanup WHERE attempt_id=?",
        )
        .get(attempt.id),
      cleanupBody = parseRow(cr, 16384) as unknown as AttemptCleanupRecord;
    canonicalAttemptCleanupSha256(cleanupBody);
    if (
      !cr ||
      cleanupBody.attemptId !== cr.attempt_id ||
      cleanupBody.sessionId !== cr.session_id ||
      cleanupBody.workspaceId !== cr.workspace_id ||
      cleanupBody.runId !== cr.run_id ||
      cleanupBody.turnId !== cr.turn_id ||
      cleanupBody.providerId !== cr.provider_id ||
      cleanupBody.modelId !== cr.model_id ||
      cleanupBody.state !== cr.state ||
      cleanupBody.revision !== cr.revision ||
      cleanupBody.requestSha256 !== cr.request_sha256 ||
      cleanupBody.requestBytes !== cr.request_bytes ||
      cleanupBody.attemptId !== attempt.id ||
      cleanupBody.sessionId !== part.sessionId ||
      cleanupBody.runId !== part.runId ||
      cleanupBody.turnId !== part.turnId ||
      cleanupBody.workspaceId !== run.workspaceId ||
      cleanupBody.providerId !== id.providerId ||
      cleanupBody.modelId !== id.modelId
    )
      bad();
    const cleanupEvents = db
      .prepare(
        "SELECT data,length(CAST(data AS BLOB)) AS bytes FROM session_events WHERE session_id=? AND attempt_id=? AND type=? AND json_extract(data,'$.payload.cleanup.revision')=? LIMIT 2",
      )
      .all(
        part.sessionId,
        attempt.id,
        "provider.cleanup." + cleanupBody.state.replaceAll("-", "_"),
        cleanupBody.revision,
      );
    if (
      cleanupEvents.length !== 1 ||
      canonicalAttemptCleanupSha256(
        validateSessionEvent(parseRow(cleanupEvents[0])).payload
          .cleanup as unknown as AttemptCleanupRecord,
      ) !== canonicalAttemptCleanupSha256(cleanupBody)
    )
      bad();
    if (part.artifact.complete) {
      const cleanup = db
        .prepare(
          "SELECT state,session_id,run_id,turn_id,provider_id,model_id FROM attempt_cleanup WHERE attempt_id=?",
        )
        .get(attempt.id);
      if (
        part.artifact.outcome !== "completed" ||
        cleanupBody.cleanupConfirmed !== true ||
        cleanupBody.method !== "iterator-next-done" ||
        cleanupBody.reason !== "natural-done" ||
        (part.state === "completed" && attempt.state !== "completed") ||
        cleanup?.state !== "confirmed" ||
        cleanup.session_id !== id.sessionId ||
        cleanup.run_id !== id.runId ||
        cleanup.turn_id !== id.turnId ||
        cleanup.provider_id !== id.providerId ||
        cleanup.model_id !== id.modelId
      )
        bad();
    }
    if (!part.artifact.complete && part.state === "completed") bad();
    if (part.revision > 0) {
      const final = db
        .prepare(
          "SELECT data,length(CAST(data AS BLOB)) AS bytes FROM session_events WHERE session_id=? AND type IN ('message.part.updated','message.part.interrupted') AND json_extract(data,'$.payload.part.id')=? AND json_extract(data,'$.payload.part.revision')=? LIMIT 2",
        )
        .all(part.sessionId, part.id, part.revision);
      if (
        final.length !== 1 ||
        hash(validateSessionEvent(parseRow(final[0])).payload.part) !==
          hash(part)
      )
        bad();
    }
    outputs.push(part);
  }
  return { sources, outputs };
}
function safeBytes(path: string, max: number, check: () => void): Buffer {
  let current = parse(path).root;
  for (const piece of dirname(path)
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, piece);
    const st = lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) bad();
  }
  if (realpathSync(dirname(path)) !== dirname(path)) bad();
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > max
  )
    bad();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) bad();
    const bytes = Buffer.alloc(before.size);
    let n = 0;
    while (n < bytes.length) {
      check();
      const size = readSync(fd, bytes, n, bytes.length - n, n);
      if (!size) bad();
      n += size;
    }
    const after = fstatSync(fd),
      live = lstatSync(path);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      live.ino !== before.ino ||
      live.dev !== before.dev
    )
      bad();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function validateMediaFiles(
  db: DatabaseSync,
  root: string,
  check: () => void = () => {},
  members?: readonly { file: string; bytes: number; sha256: string }[],
  prefix = "artifacts",
): void {
  const history = validateMediaDatabase(db, check);
  const member = (file: string, bytes: number, sha256: string) => {
    if (
      members &&
      !members.some(
        (m) =>
          m.file === prefix + "/" + file &&
          m.bytes === bytes &&
          m.sha256 === sha256,
      )
    )
      bad();
  };
  for (const ref of history.sources) {
    check();
    const file = "input-segments/" + ref.id + ".blob",
      bytes = safeBytes(join(root, file), 524288, check);
    if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) bad();
    member(file, ref.bytes, ref.sha256);
    decodeMediaSegments(bytes, ref.mimeType, ref.segments);
  }
  for (const part of history.outputs) {
    check();
    const ref = part.artifact,
      file = "managed/" + ref.id + "/content",
      bytes = safeBytes(join(root, file), 524288, check);
    if (bytes.length !== ref.storedBytes || digest(bytes) !== ref.sha256) bad();
    member(file, ref.storedBytes, ref.sha256);
    const manifestFile = "managed/" + ref.id + "/manifest.json",
      raw = safeBytes(join(root, manifestFile), 65536, check),
      manifest = jobJson(JSON.parse(raw.toString("utf8")), 65536) as Record<
        string,
        unknown
      >;
    member(manifestFile, raw.length, digest(raw));
    if (
      hash(manifest.reference) !== hash(ref) ||
      manifest.mediaType !== part.mime ||
      manifest.sourceComplete !== ref.complete
    )
      bad();
    const metadata = manifest.metadata as Record<string, unknown>;
    if (
      !metadata ||
      metadata.source !== "provider-audio-v1" ||
      metadata.complete !== ref.complete
    )
      bad();
    const wave = part.mime === "audio/wav" ? decodePcmWave(bytes) : null;
    if (
      wave &&
      (wave.sampleRate !== metadata.sampleRate ||
        wave.channels !== metadata.channels)
    )
      bad();
    const pcm =
      part.mime === "audio/wav"
        ? wave!.samples
        : part.mime === "application/octet-stream" && !ref.complete
          ? bytes
          : bad();
    if (metadata.pcmBytes !== pcm.length || metadata.pcmSha256 !== digest(pcm))
      bad();
  }
}
