import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { batchFixture, until } from "./fixtures/batch.js";
import { EFFECT_BATCH_LIMITS, validateEffectBatch } from "./storage.js";
test("completed native batch reopens with default-off history and imports paused without provider or effect replay", async (t) => {
  const f = await batchFixture(t);
  const receipt = await f.submit();
  await until(() => f.pending().length === 2, "Actual approvals");
  f.approve();
  assert.equal(
    (await f.engine.coordinator.waitForRun(receipt.runId)).state,
    "completed",
  );
  const original = f.records()[0]!;
  assert.equal(original.lockReleased, true);
  await f.engine.close();
  let entries = 0;
  const provider = {
    id: f.provider.id,
    async *streamTurn() {
      entries++;
      throw new Error("History cannot dispatch");
    },
  };
  const reopen = createEngine({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    providers: [provider],
  });
  t.after(() => reopen.close());
  assert.equal(
    reopen.getEffectBatch(f.session.id, original.id)!.sha256,
    original.sha256,
  );
  assert.equal(entries, 0);
  await reopen.close();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.directory, "archive"),
  });
  assert.equal(
    validateEngineArchive({ directory: archive.directory }).manifestSha256,
    archive.manifestSha256,
  );
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(f.directory, "import"),
  });
  const engine = createEngine({
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    providers: [provider],
    effectBatches: true,
  });
  t.after(() => engine.close());
  const record = engine.getEffectBatch(f.session.id, original.id)!;
  assert.equal(record.state, "paused-import");
  assert.deepEqual(record.members, original.members);
  assert.equal(engine.store.getSessionControl(f.session.id).paused, true);
  assert.equal(entries, 0);
  assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "A");
});
test("fully rehashed native completion and resource contradiction cannot replace independent prepared evidence", async (t) => {
  const f = await batchFixture(t);
  const receipt = await f.submit();
  await until(() => f.pending().length === 2, "Approvals");
  f.approve();
  await f.engine.coordinator.waitForRun(receipt.runId);
  const original = f.records()[0]!,
    db = new DatabaseSync(f.dbPath);
  const changed = new Map<string, string>();
  let prior: string | null = null;
  for (const row of db
    .prepare(
      "SELECT seq,data FROM session_events WHERE session_id=? AND type='effect.batch.recorded' ORDER BY seq",
    )
    .all(f.session.id)) {
    const e = JSON.parse(String(row.data)),
      r = e.payload.record;
    const old = r.sha256;
    r.members[0].claim.files[0].afterHash = "0".repeat(64);
    const { sha256: cs, ...cb } = r.members[0].claim;
    r.members[0].claim.sha256 = knowledgeHash(cb);
    r.previousSha256 = prior;
    const { sha256, ...body } = r;
    r.sha256 = knowledgeHash(body);
    prior = r.sha256;
    changed.set(old, r.sha256);
    db.prepare(
      "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
    ).run(JSON.stringify(e), f.session.id, row.seq!);
  }
  const head = JSON.parse(
    String(
      db
        .prepare(
          "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
        )
        .get(f.session.id, `effect.batch.${original.id}`)!.data,
    ),
  );
  head.members[0].claim.files[0].afterHash = "0".repeat(64);
  const { sha256: cs, ...cb } = head.members[0].claim;
  head.members[0].claim.sha256 = knowledgeHash(cb);
  head.previousSha256 = changed.get(head.previousSha256);
  head.sha256 = prior;
  db.prepare(
    "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
  ).run(JSON.stringify(head), f.session.id, `effect.batch.${original.id}`);
  db.close();
  assert.throws(() => f.records(), { code: "EFFECT_BATCH_EVIDENCE_INVALID" });
});
test("a settled member event must be the only one for its tool call and carry no Run", async (t) => {
  const f = await batchFixture(t);
  const receipt = await f.submit();
  await until(() => f.pending().length === 2, "Approvals");
  f.approve();
  await f.engine.coordinator.waitForRun(receipt.runId);
  const original = f.records()[0]!,
    db = new DatabaseSync(f.dbPath);
  const seq = Number(
    db
      .prepare(
        "SELECT seq FROM session_events WHERE session_id=? AND type='effect.batch.member_settled' ORDER BY seq LIMIT 1",
      )
      .get(f.session.id)!.seq,
  );
  db.prepare(
    "INSERT INTO session_events(session_id,seq,event_id,schema_version,run_id,type,data) SELECT session_id,seq+1000000,event_id||'-copy',schema_version,?,type,json_set(data,'$.seq',seq+1000000,'$.eventId',event_id||'-copy','$.runId',?) FROM session_events WHERE session_id=? AND seq=?",
  ).run(receipt.runId, receipt.runId, f.session.id, seq);
  assert.throws(() => f.records(), { code: "EFFECT_BATCH_EVIDENCE_INVALID" });
  db.prepare("DELETE FROM session_events WHERE session_id=? AND seq=?").run(
    f.session.id,
    seq + 1000000,
  );
  assert.equal(f.records()[0]!.sha256, original.sha256);
  db.prepare(
    "UPDATE session_events SET run_id=?,data=json_set(data,'$.runId',?) WHERE session_id=? AND seq=?",
  ).run(receipt.runId, receipt.runId, f.session.id, seq);
  db.close();
  assert.throws(() => f.records(), { code: "EFFECT_BATCH_EVIDENCE_INVALID" });
});
test("malformed or oversized effect batch evidence reports the effect batch code, not a job code", () => {
  const oversized = {
    version: 1,
    padding: "x".repeat(EFFECT_BATCH_LIMITS.nativeBytes),
  };
  for (const value of [new Proxy({ version: 1 }, {}), oversized])
    assert.throws(() => validateEffectBatch(value), {
      code: "EFFECT_BATCH_EVIDENCE_INVALID",
    });
});
