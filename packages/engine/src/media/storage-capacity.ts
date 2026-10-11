import { EngineError } from "@moodcode/contracts";
import type { DatabaseSync } from "node:sqlite";
import { SEGMENT_DOCUMENT_KIND } from "./segment-store.js";

/** Shared by the admission guards and the bounded open/archive readers in native-validation.ts. */
export const MEDIA_STORAGE_CAPS = Object.freeze({
  indexDocuments: 128,
  indexDocumentBytes: 65536,
  indexBytes: 1048576,
  referenceRows: 4096,
  referenceBytes: 16777216,
  providerParts: 4096,
  providerPartBytes: 65536,
  providerPartTotalBytes: 16777216,
  openPartReserve: 512,
});
export const MEDIA_REFERENCE_TABLES = Object.freeze([
  "inputs",
  "runs",
  "messages",
  "session_inputs",
] as const);
interface Totals {
  count: number;
  bytes: number;
}

export function mediaReferenceTotals(
  db: DatabaseSync,
  table: (typeof MEDIA_REFERENCE_TABLES)[number],
): Totals {
  const row = db
    .prepare(
      `SELECT count(*) AS count,coalesce(sum(length(CAST(json_extract(data,'$.media') AS BLOB))),0) AS bytes FROM ${table} WHERE json_type(data,'$.media') IS NOT NULL AND json_type(data,'$.media')!='null'`,
    )
    .get()!;
  return { count: Number(row.count), bytes: Number(row.bytes) };
}

export function providerMediaPartTotals(
  db: DatabaseSync,
): Totals & { open: number } {
  const row = db
    .prepare(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes,coalesce(sum(CASE WHEN state='open' THEN 1 ELSE 0 END),0) AS open FROM message_parts WHERE json_extract(data,'$.artifact.identity.source')='provider'",
    )
    .get()!;
  return {
    count: Number(row.count),
    bytes: Number(row.bytes),
    open: Number(row.open),
  };
}

/** All callers hold the primary transaction. */
export function assertMediaIndexCapacity(
  db: DatabaseSync,
  sessionId: string,
  encoded: string,
): void {
  const other = db
    .prepare(
      "SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM session_documents WHERE kind=? AND session_id<>?",
    )
    .get(SEGMENT_DOCUMENT_KIND, sessionId)!;
  const bytes = Buffer.byteLength(encoded);
  if (
    Number(other.count) >= MEDIA_STORAGE_CAPS.indexDocuments ||
    bytes > MEDIA_STORAGE_CAPS.indexDocumentBytes ||
    Number(other.bytes) + bytes > MEDIA_STORAGE_CAPS.indexBytes
  )
    throw new EngineError(
      "MEDIA_INDEX_CAPACITY",
      "Media index count or byte capacity is full",
    );
}

export function assertMediaReferenceCapacity(db: DatabaseSync): void {
  let total = 0;
  for (const table of MEDIA_REFERENCE_TABLES) {
    const cap = mediaReferenceTotals(db, table);
    total += cap.bytes;
    if (
      cap.count > MEDIA_STORAGE_CAPS.referenceRows ||
      total > MEDIA_STORAGE_CAPS.referenceBytes
    )
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
  const cap = providerMediaPartTotals(db),
    reserve = MEDIA_STORAGE_CAPS.openPartReserve;
  const bytes = Buffer.byteLength(input.encoded);
  const open = cap.open - Number(input.previousOpen) + Number(input.nextOpen);
  // Artifact/identity are immutable; the reserve per open Part bounds its terminal timestamp/revision.
  if (
    cap.count + Number(input.newRecord) > MEDIA_STORAGE_CAPS.providerParts ||
    bytes + Number(input.nextOpen) * reserve >
      MEDIA_STORAGE_CAPS.providerPartBytes ||
    cap.bytes - input.previousBytes + bytes + open * reserve >
      MEDIA_STORAGE_CAPS.providerPartTotalBytes
  )
    throw new EngineError(
      "MEDIA_PART_CAPACITY",
      "Provider media history capacity is full",
    );
}
