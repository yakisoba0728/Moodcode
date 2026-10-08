import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEngine } from "../engine.js";
import { getRecoveryStatus, recoverEngine } from "../recovery/index.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { jobFixture } from "./fixtures/job.js";
import { validateHostCommandDatabase } from "./host-command-records.js";
import { signJobData } from "./validation.js";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 25000,
};
async function completed(t: test.TestContext) {
  const f = await jobFixture(t, {
      createTerminal: false,
      engine: { hostCommands: true },
    }),
    preview = await f.engine.previewHostCommand({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      command: `${quote(process.execPath)} -e ${quote("process.stdout.write('Actual native independent observation 한글🙂\\n');")}`,
      limits: { maxDurationMs: 10000, maxOutputBytes: 100000 },
    }),
    started = await f.engine.startHostCommand({
      workspaceId: f.workspace.id,
      requestId: "actual-native-command",
      preview,
      fingerprint: f.engine.readHostCommandPreview(preview).fingerprint,
      approved: true,
    }),
    record = await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
  assert.equal(record.state, "completed");
  return { ...f, record };
}

test(
  "genuine independent process evidence rejects rewritten PID/approval despite internally consistent rehashed revision anchors",
  posix,
  async (t) => {
    const f = await completed(t),
      db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    validateHostCommandDatabase(db);
    for (const change of ["pid", "approval"]) {
      db.exec("BEGIN");
      try {
        const rows = db
          .prepare(
            "SELECT id,data FROM host_command_revisions ORDER BY revision",
          )
          .all();
        for (const row of rows) {
          const old = JSON.parse(String(row.data));
          if (change === "pid" && old.pid !== null) {
            old.pid += 100000;
            if (old.kind === "running") old.payload.pid = old.pid;
          }
          if (change === "approval") {
            const { fingerprint, ...body } = old.preview;
            body.input.command = "echo altered_without_real_host_approval";
            old.preview = { ...body, fingerprint: knowledgeHash(body) };
          }
          const forged = signJobData(old, 262144);
          db.prepare(
            "UPDATE host_command_revisions SET sha256=?,data=? WHERE id=?",
          ).run(forged.sha256, JSON.stringify(forged), row.id!);
          const anchor = db
              .prepare(
                "SELECT seq,data FROM session_events WHERE type='host.command.revision' AND json_extract(data,'$.payload.revisionId')=?",
              )
              .get(row.id!)!,
            event = JSON.parse(String(anchor.data));
          event.payload.sha256 = forged.sha256;
          db.prepare(
            "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
          ).run(JSON.stringify(event), f.session.id, anchor.seq!);
        }
        assert.throws(() => validateHostCommandDatabase(db));
      } finally {
        db.exec("ROLLBACK");
      }
      validateHostCommandDatabase(db);
    }
  },
);

test(
  "actual DB23 recovery fingerprint and verified backup include full independently settled host history without replay",
  posix,
  async (t) => {
    const f = await completed(t);
    await f.engine.close();
    const options = { dbPath: f.dbPath, artifactDir: f.artifactDir },
      before = await getRecoveryStatus(options);
    assert.equal(before.state, "clear");
    assert.match(before.fingerprint!, /^[a-f0-9]{64}$/);
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare("UPDATE host_command_revisions SET sha256=? WHERE id=?").run(
        "f".repeat(64),
        f.record.id,
      );
      const status = await getRecoveryStatus(options);
      assert.equal(status.state, "blocked");
      assert.equal(status.fingerprint, null);
    } finally {
      db.prepare("UPDATE host_command_revisions SET sha256=? WHERE id=?").run(
        f.record.sha256,
        f.record.id,
      );
      db.close();
    }
    const effect = new DatabaseSync(f.dbPath + ".effects.sqlite");
    effect
      .prepare(
        "UPDATE command_execution SET active=1,owner_pid=?,group_pid=? WHERE id=1",
      )
      .run(f.record.pid!, f.record.pid!);
    effect.close();
    const status = await getRecoveryStatus(options);
    assert.equal(status.state, "recoverable");
    const recovered = await recoverEngine({
      ...options,
      fingerprint: status.fingerprint!,
      acknowledged: true,
    });
    assert.equal(recovered.backupVerified, true);
    assert.equal(recovered.effectMarkerCleared, true);
    const backup = new DatabaseSync(
      join(f.artifactDir, "recovery", recovered.recoveryId, "primary.sqlite"),
      { readOnly: true },
    );
    try {
      assert.equal(
        backup.prepare("PRAGMA user_version").get()!.user_version,
        23,
      );
      validateHostCommandDatabase(backup);
      assert.equal(
        JSON.parse(
          String(
            backup
              .prepare("SELECT data FROM host_command_revisions WHERE id=?")
              .get(f.record.id)!.data,
          ),
        ).sha256,
        f.record.sha256,
      );
    } finally {
      backup.close();
    }
    const opened = createEngine({ ...f.configuration, hostCommands: false });
    f.engines.add(opened);
    assert.equal(
      opened.getHostCommand(f.workspace.id, f.record.jobId)!.sha256,
      f.record.sha256,
    );
    assert.equal(f.providerCalls.length, 0);
    assert.equal(opened.store.getSnapshot(f.session.id).runs.length, 0);
  },
);
