import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import { jobCommand, jobFixture, jobInvoke } from "./fixtures/job.js";
import type { CommandJob, JobDelivery, JobRequestResult } from "./store.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20_000,
};
const nativeError = (error: unknown) => error instanceof EngineError;
type Fixture = Awaited<ReturnType<typeof jobFixture>>;

async function acceptedResult(f: Fixture) {
  const attached = f.attach();
  await f.finish();
  const settled = jobInvoke<JobRequestResult<CommandJob>>(
    f.engine,
    "settleTerminalJob",
    attached.original,
    {
      workspaceId: f.workspace.id,
      jobId: attached.result.record.jobId,
      requestId: randomUUID(),
      expectedRevision: 1,
    },
  );
  await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
  const target = jobInvoke<object>(
    f.engine,
    "captureCommandJobDeliveryTarget",
    {
      workspaceId: f.workspace.id,
      jobId: settled.record.jobId,
      config: f.config,
    },
  );
  const input = {
    workspaceId: f.workspace.id,
    requestId: randomUUID(),
    expectedRevision: 0,
    target,
    approved: true,
  };
  const delivered = jobInvoke<JobRequestResult<JobDelivery>>(
    f.engine,
    "deliverCommandJobResult",
    input,
  );
  assert.equal(delivered.record.state, "accepted");
  assert.ok(delivered.record.accepted);
  assert.equal(
    f.engine.store.getInput(delivered.record.accepted.inputId).state,
    "pending",
  );
  assert.equal(f.providerCalls.length, 0);
  return { attached, settled, input, delivered };
}
function rows(
  path: string,
  table: "job_revisions" | "session_inputs" | "session_turns",
) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    db.close();
  }
}
function delivery(path: string, deliveryId: string): JobDelivery {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT r.data FROM job_heads h JOIN job_revisions r ON r.id=h.revision_id WHERE h.kind='delivery' AND h.entity_id=?",
      )
      .get(deliveryId);
    assert.ok(row);
    return JSON.parse(String(row.data)) as JobDelivery;
  } finally {
    db.close();
  }
}

test(
  "a new actual Root can explicitly resume the already accepted input without reconstructing its terminal or accepting it again",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      accepted = await acceptedResult(f);
    const inputId = accepted.delivered.record.accepted!.inputId;
    await f.engine.close();
    const reopened = createEngine({ ...f.configuration, jobs: true });
    f.engines.add(reopened);
    assert.equal(reopened.store.getSessionControl(f.session.id).paused, true);
    assert.equal(reopened.store.getInput(inputId).state, "pending");
    assert.equal(f.providerCalls.length, 0);
    assert.throws(
      () =>
        jobInvoke(reopened, "captureTerminalJob", {
          workspaceId: f.workspace.id,
          sessionId: f.session.id,
          terminalId: f.terminal!.id,
        }),
      nativeError,
    );
    assert.throws(
      () =>
        jobInvoke(reopened, "captureCommandJobDeliveryTarget", {
          workspaceId: f.workspace.id,
          jobId: accepted.settled.record.jobId,
          config: f.config,
        }),
      nativeError,
    );
    assert.throws(
      () => jobInvoke(reopened, "deliverCommandJobResult", accepted.input),
      nativeError,
    );
    assert.equal(rows(f.dbPath, "session_inputs").length, 1);
    await jobCommand(reopened, "session.resume", { sessionId: f.session.id });
    await reopened.waitForSession(f.session.id);
    assert.equal(reopened.store.getInput(inputId).state, "promoted");
    assert.equal(f.providerCalls.length, 1);
    assert.equal(rows(f.dbPath, "session_inputs").length, 1);
    assert.equal(rows(f.dbPath, "session_turns").length, 1);
  },
);

test(
  "an archived accepted terminal result stays paused on import with jobs off or on and cannot restore source, reaccept or dispatch",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      accepted = await acceptedResult(f);
    const inputId = accepted.delivered.record.accepted!.inputId;
    await f.engine.close();
    const history = rows(f.dbPath, "job_revisions");
    const archived = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "accepted-job-archive"),
    });
    assert.equal(
      validateEngineArchive({ directory: archived.directory }).manifestSha256,
      archived.manifestSha256,
    );
    for (const jobs of [false, true]) {
      const imported = await importEngineArchive({
        directory: archived.directory,
        destination: join(
          f.base,
          jobs ? "accepted-jobs-on" : "accepted-jobs-off",
        ),
      });
      assert.equal(imported.executionResumed, false);
      const engine = createEngine({
        ...f.configuration,
        dbPath: imported.dbPath,
        artifactDir: imported.artifactDir,
        jobs,
      });
      f.engines.add(engine);
      const stored = delivery(
        imported.dbPath,
        accepted.delivered.record.deliveryId,
      );
      assert.equal(stored.state, "paused-import");
      assert.deepEqual(stored.accepted, accepted.delivered.record.accepted);
      const importedRows = rows(imported.dbPath, "job_revisions");
      for (const original of history)
        assert.deepEqual(
          importedRows.find((row) => row.id === original.id),
          original,
        );
      assert.equal(engine.store.getSessionControl(f.session.id).paused, true);
      assert.equal(engine.store.getInput(inputId).state, "pending");
      assert.throws(
        () =>
          jobInvoke(engine, "captureTerminalJob", {
            workspaceId: f.workspace.id,
            sessionId: f.session.id,
            terminalId: f.terminal!.id,
          }),
        nativeError,
      );
      assert.throws(
        () =>
          jobInvoke(engine, "captureCommandJobDeliveryTarget", {
            workspaceId: f.workspace.id,
            jobId: accepted.settled.record.jobId,
            config: f.config,
          }),
        nativeError,
      );
      assert.throws(
        () => jobInvoke(engine, "deliverCommandJobResult", accepted.input),
        nativeError,
      );
      try {
        engine.scheduler.resume(f.session.id);
        await engine.waitForSession(f.session.id);
      } catch (error) {
        assert.ok(error instanceof EngineError);
      }
      assert.equal(engine.store.getInput(inputId).state, "pending");
      assert.equal(rows(imported.dbPath, "session_inputs").length, 1);
      assert.equal(rows(imported.dbPath, "session_turns").length, 0);
      assert.equal(f.providerCalls.length, 0);
      await engine.close();
    }
  },
);
