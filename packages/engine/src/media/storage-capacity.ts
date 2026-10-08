import { EngineError } from "@moodcode/contracts";
import type { DatabaseSync } from "node:sqlite";

/** Admission guards match the bounded open/archive readers; all callers hold the primary transaction. */
export function assertMediaIndexCapacity(
  db: DatabaseSync,
  sessionId: string,
  encoded: string,
): void {
  const other = db
    .prepare(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM session_documents WHERE kind='input_media_segments' AND session_id<>?",
    )
    .get(sessionId)!;
  const bytes = Buffer.byteLength(encoded);
  if (
    Number(other.count) >= 128 ||
    bytes > 65536 ||
    Number(other.bytes) + bytes > 1048576
  )
    throw new EngineError(
      "MEDIA_INDEX_CAPACITY",
      "Media index count or byte capacity is full",
    );
}

export function assertMediaReferenceCapacity(db: DatabaseSync): void {
  let total = 0;
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
    total += Number(cap.bytes);
    if (Number(cap.count) > 4096 || total > 16777216)
      throw new EngineError(
        "MEDIA_REFERENCE_CAPACITY",
        "Media reference history capacity is full",
      );
  }
}

export function assertProviderMediaPartCapacity(
  db: DatabaseSync,
  input: {
    encoded: string;
    previousBytes: number;
    previousOpen: boolean;
    nextOpen: boolean;
    newRecord: boolean;
  },
): void {
  const cap = db
    .prepare(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes,coalesce(sum(CASE WHEN state='open' THEN 1 ELSE 0 END),0) AS open FROM message_parts WHERE json_extract(data,'$.artifact.identity.source')='provider'",
    )
    .get()!;
  const bytes = Buffer.byteLength(input.encoded);
  const open =
    Number(cap.open) - Number(input.previousOpen) + Number(input.nextOpen);
  // Artifact/identity are immutable; 512 bytes per open Part reserve its bounded terminal timestamp/revision.
  if (
    Number(cap.count) + Number(input.newRecord) > 4096 ||
    bytes + Number(input.nextOpen) * 512 > 65536 ||
    Number(cap.bytes) - input.previousBytes + bytes + open * 512 > 16777216
  )
    throw new EngineError(
      "MEDIA_PART_CAPACITY",
      "Provider media history capacity is full",
    );
}
