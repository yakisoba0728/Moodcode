import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { hostDeliveryFixture } from "./fixtures/host-command-delivery.js";
import { jobCommand } from "./fixtures/job.js";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { join } from "node:path";
const posix = {
  timeout: 25000,
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
};
for (const exitCode of [0, 7])
  test(
    `actual independent host ${exitCode === 0 ? "completed" : "failed"} inbox commits full native input/link/birth and dispatches exact independently pinned target`,
    posix,
    async (t) => {
      const f = await hostDeliveryFixture(t, { exitCode }),
        settled = await f.complete();
      const before = f.counts();
      assert.equal(before.runs, 0);
      assert.equal(before.tools, 0);
      const target = f.capture(),
        proof = f.engine.readHostCommandJobDeliveryTarget(target);
      assert.equal(proof.settled.jobSha256, settled.sha256);
      const requestId = randomUUID(),
        result = f.deliver(target, requestId);
      assert.equal(result.kind, "accepted");
      assert.equal(
        result.record.settled.state,
        exitCode ? "failed" : "completed",
      );
      assert.equal(
        f.engine.store.getInput(result.record.accepted.inputId).state,
        "pending",
      );
      assert.ok(!result.record.prompt.includes("inbox-host.mjs"));
      assert.ok(!result.record.prompt.includes(f.root));
      const expected = structuredClone(result.record);
      Reflect.set(result.record, "prompt", "changed");
      assert.deepEqual(f.deliver(target, requestId).record, expected);
      assert.deepEqual(
        structuredClone(
          f.engine.getHostCommandJobDelivery(f.workspace.id, expected.id),
        ),
        expected,
      );
      assert.equal(f.counts()["host.command.delivery.*"], 1);
      assert.equal(f.counts()["host.command.input.*"], 1);
      await jobCommand(f.engine, "session.resume", { sessionId: f.session.id });
      await f.engine.waitForSession(f.session.id);
      assert.equal(f.providerCalls.length, 1);
      assert.equal(
        f.engine.store.getInput(expected.accepted.inputId).state,
        "promoted",
      );
      assert.ok(
        JSON.stringify(f.providerCalls[0]!.messages).includes(
          "Moodcode independent host command result v1",
        ),
      );
      assert.equal(f.engine.inspectHostCommands(f.workspace.id).length, 1);
      assert.throws(() => process.kill(f.pid, 0));
    },
  );
test(
  "genuine cancelled cleanup-confirmed independent host can deliver; running, copied, denied and stale target have zero acceptance",
  posix,
  async (t) => {
    const f = await hostDeliveryFixture(t, { hold: true });
    assert.throws(() => f.capture());
    await f.engine.cancelHostCommand({
      workspaceId: f.workspace.id,
      jobId: f.started.jobId,
    });
    const job = await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: f.started.jobId,
    });
    assert.equal(job.state, "cancelled");
    assert.equal(job.completion!.outcome.cleanupConfirmed, true);
    const target = f.capture(),
      counts = f.counts();
    for (const input of [
      { target: { ...target }, approved: true },
      { target, approved: false },
      { target, approved: true, expectedRevision: 1 },
    ])
      assert.throws(() =>
        f.engine.deliverHostCommandJobResult({
          workspaceId: f.workspace.id,
          requestId: randomUUID(),
          expectedRevision: 0,
          ...input,
        } as never),
      );
    assert.deepEqual(f.counts(), counts);
    assert.equal(f.deliver(target).kind, "accepted");
  },
);
test(
  "SQL receipt failure rolls back actual input/link/birth and does not wake provider",
  posix,
  async (t) => {
    const f = await hostDeliveryFixture(t);
    await f.complete();
    const target = f.capture(),
      before = f.counts(),
      db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TRIGGER fail_host_inbox BEFORE INSERT ON session_documents WHEN NEW.kind GLOB 'host.command.delivery.*' BEGIN SELECT RAISE(ABORT,'actual host inbox admission failure'); END",
    );
    try {
      assert.throws(() => f.deliver(target));
      assert.deepEqual(f.counts(), before);
      assert.equal(f.providerCalls.length, 0);
      assert.equal(
        Number(
          db
            .prepare(
              "SELECT count(*) n FROM session_events WHERE type='host.command.result_admitted'",
            )
            .get()!.n,
        ),
        0,
      );
    } finally {
      db.exec("DROP TRIGGER fail_host_inbox");
      db.close();
    }
  },
);
test(
  "restart retains accepted history without reexecuting host; archive imports paused receipt/default-off catalogue",
  posix,
  async (t) => {
    const f = await hostDeliveryFixture(t);
    await f.complete();
    const result = f.deliver(f.capture());
    await f.engine.close();
    const reopened = createEngine(f.configuration);
    f.engines.add(reopened);
    assert.equal(
      reopened.getHostCommandJobDelivery(f.workspace.id, result.record.id)!
        .state,
      "accepted",
    );
    assert.equal(reopened.inspectHostCommands(f.workspace.id).length, 1);
    await reopened.close();
    const archive = await exportEngineArchive({
        dbPath: f.dbPath,
        artifactDir: f.artifactDir,
        destination: join(f.base, "archive"),
      }),
      archiveImport = await importEngineArchive({
        directory: archive.directory,
        destination: join(f.base, "imported"),
      });
    const imported = createEngine({
      ...f.configuration,
      dbPath: archiveImport.dbPath,
      artifactDir: archiveImport.artifactDir,
      jobs: false,
      hostCommands: false,
      commandJobModelTools: false,
    });
    f.engines.add(imported);
    assert.equal(
      imported.getHostCommandJobDelivery(f.workspace.id, result.record.id)!
        .state,
      "paused-import",
    );
    assert.throws(() =>
      imported.captureHostCommandJobDeliveryTarget({
        workspaceId: f.workspace.id,
        jobId: f.started.jobId,
        config: f.config,
      }),
    );
    assert.equal(f.providerCalls.length, 0);
  },
);
