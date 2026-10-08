import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { ownedDeliveryFixture } from "./fixtures/owned-command-delivery.js";
import { jobInvoke } from "./fixtures/job.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 25_000,
};

test(
  "genuine settled host and owned targets in one Root retain separate Original owners before result admission",
  posix,
  async (t) => {
    const f = await ownedDeliveryFixture(t, { hostCommands: true }),
      owned = await f.complete(),
      ownedTarget = f.capture(),
      quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`,
      preview = await f.engine.previewHostCommand({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        command: `${quote(process.execPath)} ${quote(f.script)}`,
        limits: { maxDurationMs: 10_000, maxOutputBytes: 1_048_576 },
      }),
      started = await f.engine.startHostCommand({
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        preview,
        fingerprint: f.engine.readHostCommandPreview(preview).fingerprint,
        approved: true,
      }),
      host = await f.engine.waitForHostCommand({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      }),
      hostTarget = f.engine.captureHostCommandJobDeliveryTarget({
        workspaceId: f.workspace.id,
        jobId: host.jobId,
        config: f.targetConfig,
      }),
      db = new DatabaseSync(f.dbPath, { readOnly: true });
    t.after(() => db.close());
    assert.equal(host.state, "completed");
    assert.equal(host.completion!.outcome.cleanupConfirmed, true);
    assert.equal(owned.completion!.outcome.cleanupConfirmed, true);
    const images = () => [
      db.prepare("SELECT * FROM session_inputs ORDER BY id").all(),
      db.prepare("SELECT * FROM session_documents ORDER BY session_id,kind").all(),
      db.prepare("SELECT * FROM session_events ORDER BY session_id,seq").all(),
      db.prepare("SELECT * FROM provider_attempts ORDER BY id").all(),
    ];
    const before = images(),
      required = (error: unknown) =>
        error instanceof EngineError && error.code === "JOB_ORIGINAL_REQUIRED";
    for (const target of [ownedTarget, { ...hostTarget }]) {
      assert.throws(() => f.engine.readHostCommandJobDeliveryTarget(target), required);
      assert.throws(() => f.engine.deliverHostCommandJobResult({
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        expectedRevision: 0,
        target,
        approved: true,
      }), required);
    }
    for (const target of [hostTarget, { ...ownedTarget }]) {
      assert.throws(() => jobInvoke(f.engine, "readOwnedCommandJobDeliveryTarget", target), required);
      assert.throws(() => f.deliver(target), required);
    }
    assert.deepEqual(images(), before);
    assert.equal(f.providerEntries(), 2);
    assert.equal(f.settled().sha256, owned.sha256);
    assert.equal(f.engine.getHostCommand(f.workspace.id, host.jobId)!.sha256, host.sha256);
    assert.equal(f.engine.readHostCommandJobDeliveryTarget(hostTarget).jobId, host.jobId);
    assert.equal(f.deliver(ownedTarget).kind, "accepted");
    assert.equal(f.engine.deliverHostCommandJobResult({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      expectedRevision: 0,
      target: hostTarget,
      approved: true,
    }).kind, "accepted");
    assert.equal(f.providerEntries(), 2);
  },
);
