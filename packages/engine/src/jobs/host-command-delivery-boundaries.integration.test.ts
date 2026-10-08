import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Run } from "@moodcode/contracts";
import { hostDeliveryFixture } from "./fixtures/host-command-delivery.js";
import { jobCommand } from "./fixtures/job.js";
const posix = {
  timeout: 25000,
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
};
const changes: { field: string; candidate(run: Run): Run }[] = [
  {
    field: "config",
    candidate: (run) => ({ ...run, config: { ...run.config, mode: "build" } }),
  },
  { field: "prompt", candidate: (run) => ({ ...run, prompt: "Changed result DATA" }) },
  { field: "id", candidate: (run) => ({ ...run, id: "foreign-run" }) },
  {
    field: "workspaceId",
    candidate: (run) => ({ ...run, workspaceId: randomUUID() }),
  },
  {
    field: "sessionId",
    candidate: (run) => ({ ...run, sessionId: randomUUID() }),
  },
  {
    field: "requestId",
    candidate: (run) => ({ ...run, requestId: randomUUID() }),
  },
  {
    field: "own undefined attachments",
    candidate: (run) => ({ ...run, attachments: undefined }),
  },
  {
    field: "own undefined documents",
    candidate: (run) => ({ ...run, documents: undefined }),
  },
];
for (const { field, candidate } of changes)
  test(
    `actual independent inbox rejects trusted provider-boundary ${field} drift with zero provider entry`,
    posix,
    async (t) => {
      const f = await hostDeliveryFixture(t);
      const settled = await f.complete(),
        delivery = f.deliver(f.capture()).record;
      const options = Reflect.get(f.engine.coordinator, "options") as {
          beforeProviderDispatch: (run: Run) => void;
        },
        original = options.beforeProviderDispatch;
      let checks = 0,
        runId = "";
      options.beforeProviderDispatch = (run) => {
        if (run.inputId !== delivery.accepted.inputId) return original(run);
        checks++;
        runId = run.id;
        original(candidate(run));
      };
      t.after(() => {
        options.beforeProviderDispatch = original;
      });
      await jobCommand(f.engine, "session.resume", { sessionId: f.session.id });
      await f.engine.waitForSession(f.session.id);
      assert.equal(checks, 1);
      assert.equal(f.providerCalls.length, 0);
      const failed = f.engine.store.getRun(runId);
      assert.equal(failed.state, "failed");
      assert.equal(failed.error?.code, "COMMAND_JOB_INPUT_INVALID");
      assert.equal(
        f.engine.getHostCommand(f.workspace.id, settled.jobId)!.sha256,
        settled.sha256,
      );
      assert.throws(() => process.kill(f.pid, 0));
    },
  );
test(
  "current profile, artifact inode and safe public descriptors are pinned before independent inbox admission",
  posix,
  async (t) => {
    const f = await hostDeliveryFixture(t);
    const job = await f.complete(),
      target = f.capture(),
      before = f.counts();
    let traps = 0;
    const descriptor = Object.defineProperty(
      { workspaceId: f.workspace.id, jobId: job.jobId, config: f.config },
      "config",
      {
        enumerable: true,
        get() {
          traps++;
          return f.config;
        },
      },
    );
    assert.throws(() =>
      f.engine.captureHostCommandJobDeliveryTarget(descriptor),
    );
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          return [];
        },
      },
    );
    assert.throws(() =>
      f.engine.captureHostCommandJobDeliveryTarget(proxy as never),
    );
    assert.equal(traps, 0);
    const stream = job.completion!.stdout.path,
      temp = stream + ".replaced";
    copyFileSync(stream, temp);
    renameSync(temp, stream);
    assert.throws(() => f.deliver(target));
    assert.deepEqual(f.counts(), before);
  },
);
test(
  "explicit pending target profile drift and default-off producer prevent automatic provider replay",
  posix,
  async (t) => {
    const f = await hostDeliveryFixture(t);
    await f.complete();
    const delivery = f.deliver(f.capture()).record;
    f.engine.profiles.register({
      id: f.config.agentProfileId!,
      description: "Changed target",
      instructions: "Changed profile after durable input",
      tools: ["read_file"],
    });
    await jobCommand(f.engine, "session.resume", { sessionId: f.session.id });
    await f.engine.waitForSession(f.session.id);
    assert.equal(f.providerCalls.length, 0);
    assert.equal(
      f.engine.store.getInput(delivery.accepted.inputId).state,
      "pending",
    );
  },
);
test(
  "native independent receipt and immutable input birth/link mismatches are rejected during inspect",
  posix,
  async (t) => {
    const f = await hostDeliveryFixture(t);
    await f.complete();
    const delivery = f.deliver(f.capture()).record,
      db = new DatabaseSync(f.dbPath);
    const row = db
      .prepare(
        "SELECT session_id,kind,data FROM session_documents WHERE kind GLOB 'host.command.input.*'",
      )
      .get()!;
    try {
      db.prepare(
        "DELETE FROM session_documents WHERE session_id=? AND kind=?",
      ).run(row.session_id!, row.kind!);
      assert.throws(() =>
        f.engine.getHostCommandJobDelivery(f.workspace.id, delivery.id),
      );
    } finally {
      db.prepare(
        "INSERT INTO session_documents(session_id,kind,revision,data) VALUES(?,?,1,?)",
      ).run(row.session_id!, row.kind!, row.data!);
      db.close();
    }
    assert.equal(
      f.engine.getHostCommandJobDelivery(f.workspace.id, delivery.id)!.sha256,
      delivery.sha256,
    );
  },
);
test(
  "real pending-input backpressure rolls back independent result acceptance without widening target budget",
  posix,
  async (t) => {
    const f = await hostDeliveryFixture(t);
    await f.complete();
    const config = {
      ...f.config,
      budgets: { ...f.config.budgets!, maxPendingInputs: 1 },
    };
    const ordinary = f.engine.store.acceptInput({
      sessionId: f.session.id,
      requestId: randomUUID(),
      prompt: "Actual pending queue occupies its fixed allocation",
      config,
      delivery: "queue",
    });
    assert.equal(f.engine.store.getInput(ordinary.inputId).state, "pending");
    const target = f.engine.captureHostCommandJobDeliveryTarget({
        workspaceId: f.workspace.id,
        jobId: f.started.jobId,
        config,
      }),
      before = f.counts();
    assert.equal(
      f.engine.readHostCommandJobDeliveryTarget(target).target.config.budgets!
        .maxPendingInputs,
      1,
    );
    assert.throws(() => f.deliver(target));
    assert.deepEqual(f.counts(), before);
    assert.equal(f.providerCalls.length, 0);
  },
);
test(
  "genuine native host settlement receipt failure retains uncertainty and grants neither inbox nor model source",
  posix,
  async (t) => {
    const f = await hostDeliveryFixture(t, { hold: true }),
      db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TRIGGER fault_host_source BEFORE INSERT ON host_command_revisions WHEN NEW.kind='closed' BEGIN SELECT RAISE(ABORT,'actual closed observation receipt fault'); END",
    );
    try {
      await assert.rejects(f.complete());
    } finally {
      db.exec("DROP TRIGGER fault_host_source");
      db.close();
    }
    assert.equal(
      f.engine.getHostCommand(f.workspace.id, f.started.jobId)!.state,
      "uncertain",
    );
    const before = f.counts();
    assert.throws(() => f.capture());
    const profile = {
      id: "uncertain-reader",
      description: "Read only",
      instructions: "Only explicitly bound output DATA",
      tools: ["read_command_job", "read_command_job_output"],
    };
    f.engine.profiles.register(profile);
    const p = f.engine.profiles.list().find((x) => x.id === profile.id)!;
    assert.throws(() =>
      f.engine.bindCommandJobModelTools({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        profile: { id: p.id, revision: p.revision },
        jobs: [
          { alias: "unsafe", kind: "host-command", jobId: f.started.jobId },
        ],
      }),
    );
    assert.deepEqual(f.counts(), before);
    assert.equal(f.providerCalls.length, 0);
    await assert.rejects(
      f.engine.close(),
      (e: unknown) => (e as { code: string }).code === "CLEANUP_UNCERTAIN",
    );
    f.engines.delete(f.engine);
  },
);
