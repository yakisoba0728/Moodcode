import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export type NativeDataTable =
  | "runs"
  | "session_turns"
  | "provider_attempts"
  | "attempt_cleanup"
  | "tools"
  | "approvals"
  | "checkpoints"
  | "message_parts"
  | "session_documents"
  | "session_events";

// Callers own the table manifest and the policy for retaining these native DATA.
export function nativeFixtureData(
  dbPath: string,
  tables: readonly NativeDataTable[],
): Record<string, Record<string, unknown>[]> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let bytes = 0;
  try {
    return Object.fromEntries(
      tables.map((table) => {
        const rows = db
          .prepare(`SELECT data FROM ${table} ORDER BY rowid LIMIT 1025`)
          .all();
        assert.ok(
          rows.length <= 1024,
          "Fixture native evidence row ceiling exceeded",
        );
        return [
          table,
          rows.map((row) => {
            const raw = String(row.data);
            bytes += Buffer.byteLength(raw);
            assert.ok(
              bytes <= 8_388_608,
              "Fixture native evidence byte ceiling exceeded",
            );
            return JSON.parse(raw) as Record<string, unknown>;
          }),
        ];
      }),
    );
  } finally {
    db.close();
  }
}
