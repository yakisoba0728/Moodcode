import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { filePublicationFixture } from "../knowledge/fixtures/file-publication.js";
import { getRecoveryStatus, recoverEngine } from "./index.js";
import { KNOWLEDGE_FILE_PUBLICATION_TABLES } from "../knowledge/file-publication-store.js";
import { KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE } from "../knowledge/file-execution-guards.js";

function history(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      [
        ...KNOWLEDGE_FILE_PUBLICATION_TABLES,
        KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE,
      ].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
test("DB13 recovery fingerprint includes actual file owner/receipt/checkpoint/head/guard without rewriting observations", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate(),
    published = await f.publish(await f.preview(candidate), "recovery-publish");
  await f.engine.close();
  f.retireClosed();
  const options = { dbPath: f.dbPath, artifactDir: join(f.base, "artifacts") },
    before = history(f.dbPath),
    bytes = readFileSync(f.dbPath),
    first = await getRecoveryStatus(options);
  assert.equal(first.state, "clear");
  assert.deepEqual(first.blockers, []);
  assert.match(first.fingerprint!, /^[a-f0-9]{64}$/u);
  assert.equal(first.pendingRestoreCount, 0);
  assert.deepEqual(history(f.dbPath), before);
  assert.deepEqual(readFileSync(f.dbPath), bytes);
  const current = f.reopen();
  await f.revoke(
    await f.revokePreview(published.publication.id, current),
    "recovery-revoke",
    current,
  );
  await current.close();
  f.retireClosed(current);
  const after = await getRecoveryStatus(options);
  assert.equal(after.state, "clear");
  assert.notEqual(after.fingerprint, first.fingerprint);
  const changed = history(f.dbPath);
  assert.equal(changed.knowledge_file_publication_receipts!.length, 2);
  assert.equal(changed[KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE]!.length, 2);
});
test("generic DB13 recovery inspection cannot acknowledge or rewrite actual uncertain file effects", async (t) => {
  const f = await filePublicationFixture(t),
    candidate = await f.candidate(),
    preview = await f.preview(candidate),
    writer = new DatabaseSync(f.dbPath);
  writer.exec(
    "CREATE TRIGGER authored_receipt_failure BEFORE INSERT ON knowledge_file_publication_receipts BEGIN SELECT RAISE(ABORT,'native receipt fail'); END",
  );
  writer.close();
  await assert.rejects(
    f.publish(preview, "recovery-uncertain"),
    /native receipt fail/u,
  );
  const remove = new DatabaseSync(f.dbPath);
  remove.exec("DROP TRIGGER authored_receipt_failure");
  remove.close();
  await f.engine.close();
  f.retireClosed();
  const before = history(f.dbPath),
    options = { dbPath: f.dbPath, artifactDir: join(f.base, "artifacts") };
  assert.equal(
    JSON.parse(String(before.knowledge_file_publications![0]!.data)).state,
    "uncertain",
  );
  assert.equal(before.knowledge_file_publication_receipts!.length, 0);
  const status = await getRecoveryStatus(options);
  assert.equal(status.state, "clear");
  assert.match(status.fingerprint!, /^[a-f0-9]{64}$/u);
  await assert.rejects(
    recoverEngine({
      ...options,
      fingerprint: status.fingerprint!,
      acknowledged: true,
    }),
    (e) => e instanceof EngineError && e.code === "RECOVERY_NOT_NEEDED",
  );
  assert.deepEqual(history(f.dbPath), before);
});
