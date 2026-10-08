import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { join } from "node:path";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { jobFixture } from "./fixtures/job.js";
import {
  HOST_COMMAND_LIMITS,
  validateHostCommandDatabase,
} from "./host-command-records.js";

const quote = (x: string) => `'${x.replaceAll("'", "'\\''")}'`;
test(
  "real long independent commands fill bounded native output history while preserving terminal/import reserve and readable default-off restart",
  {
    skip: !["darwin", "linux", "freebsd"].includes(process.platform),
    timeout: 90000,
  },
  async (t) => {
    const f = await jobFixture(t, {
        createTerminal: false,
        engine: { hostCommands: true },
      }),
      db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    const command = `${quote(process.execPath)} -e ${quote("process.stdout.write(('한글🙂'+String.fromCharCode(1).repeat(100)).repeat(8000));")}\n#${"x".repeat(15000)}`;
    let completed = 0,
      gap = false,
      capacity = false;
    for (let n = 0; n < 40; n++) {
      const original = await f.engine.previewHostCommand({
          workspaceId: f.workspace.id,
          sessionId: f.session.id,
          command,
          limits: { maxDurationMs: 30000, maxOutputBytes: 1048576 },
        }),
        fingerprint = f.engine.readHostCommandPreview(original).fingerprint;
      try {
        const started = await f.engine.startHostCommand({
            workspaceId: f.workspace.id,
            requestId: randomUUID(),
            preview: original,
            fingerprint,
            approved: true,
          }),
          closed = await f.engine.waitForHostCommand({
            workspaceId: f.workspace.id,
            jobId: started.jobId,
          });
        assert.equal(
          closed.state,
          "completed",
          JSON.stringify(closed.completion?.outcome),
        );
        assert.equal(closed.completion?.outcome.cleanupConfirmed, true);
        assert.equal(closed.completion?.stdout.observedBytes, 880000);
        completed++;
        gap ||= closed.payload.outputJournalGap === true;
        const frozen = f.engine.captureHostCommandOutput({
            workspaceId: f.workspace.id,
            jobId: closed.jobId,
          }),
          page = f.engine.readHostCommandOutput(frozen);
        assert.ok(page.gap);
        assert.ok(page.rawBytes <= 16384);
        assert.ok(
          page.fragments.every(
            (p) =>
              Buffer.byteLength(p.data) === p.bytes && !p.data.includes("�"),
          ),
        );
        f.engine.releaseHostCommandHandle(frozen);
      } catch (error) {
        assert.ok(
          error instanceof EngineError && error.code === "HOST_COMMAND_LIMIT",
          String(error),
        );
        capacity = true;
        break;
      } finally {
        f.engine.releaseHostCommandHandle(original);
      }
    }
    assert.ok(completed > 1);
    assert.equal(capacity, true, JSON.stringify({ completed, gap, capacity }));
    assert.equal(gap, true, JSON.stringify({ completed, gap, capacity }));
    const usage = db
      .prepare(
        "SELECT count(*) n,sum(length(CAST(data AS BLOB))) bytes FROM host_command_revisions",
      )
      .get()!;
    assert.ok(Number(usage.bytes) > HOST_COMMAND_LIMITS.totalBytes * 0.65);
    assert.ok(Number(usage.bytes) <= HOST_COMMAND_LIMITS.totalBytes);
    assert.ok(Number(usage.n) <= HOST_COMMAND_LIMITS.rows);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM host_command_heads WHERE state IN ('approved','running','uncertain')",
        )
        .get()!.n,
      0,
    );
    validateHostCommandDatabase(db);
    await f.engine.close();
    const reopened = createEngine({ ...f.configuration, hostCommands: false });
    f.engines.add(reopened);
    const rows = reopened.inspectHostCommands(f.workspace.id);
    assert.equal(rows.length, completed);
    assert.ok(rows.every((r) => r.state === "completed"));
    assert.equal(f.providerCalls.length, 0);
    await reopened.close();
    const archive = await exportEngineArchive({
        dbPath: f.dbPath,
        artifactDir: f.artifactDir,
        destination: join(f.base, "capacity-archive"),
      }),
      imported = await importEngineArchive({
        directory: archive.directory,
        destination: join(f.base, "capacity-import"),
      });
    const historical = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      hostCommands: false,
    });
    f.engines.add(historical);
    const paused = historical.inspectHostCommands(f.workspace.id);
    assert.equal(paused.length, completed);
    assert.ok(
      paused.every(
        (r) =>
          r.state === "paused-import" && r.completion?.outcome.cleanupConfirmed,
      ),
    );
    assert.equal(historical.store.hasUncertainWorkspace(f.workspace.id), false);
  },
);
