import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEngine } from "../engine.js";
import { jobUntil, jobCommand } from "./fixtures/job.js";
import { lifetimeFixture } from "./fixtures/command-lifetime.js";
import { preserveOwnedDeliveryEvidence as preserveCommandEvidence } from "./fixtures/owned-command-delivery-windows.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20000,
};
test(
  "native lifetime admission failure and actual live-Run/host lease conflict have zero process effects",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TRIGGER lifetime_admission_fault BEFORE INSERT ON session_documents WHEN NEW.kind GLOB 'command.lifetime.*' BEGIN SELECT RAISE(ABORT,'fixture lifetime admission fault'); END",
    );
    await assert.rejects(f.start());
    assert.equal(existsSync(f.marker), false);
    assert.equal(
      db.prepare("SELECT count(*) n FROM host_command_heads").get()!.n,
      0,
    );
    db.exec("DROP TRIGGER lifetime_admission_fault");
    const started = await f.start();
    await assert.rejects(f.start(), (e) =>
      ["WORKSPACE_BUSY", "CLEANUP_PENDING"].includes(
        (e as { code: string }).code,
      ),
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM host_command_heads").get()!.n,
      1,
    );
    await f.engine.cancelCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    db.close();
  },
);
test(
  "native transfer receipt failure cleans the genuine same process but keeps durable uncertainty across reopen",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      started = await f.start();
    await jobUntil(() => existsSync(f.marker), "PID missing");
    const pid = Number(readFileSync(f.marker, "utf8")),
      db = new DatabaseSync(f.dbPath);
    assert.equal(pid, started.physical!.groupPid);
    db.exec(
      "CREATE TRIGGER lifetime_transfer_fault BEFORE UPDATE ON session_documents WHEN NEW.kind GLOB 'command.lifetime.*' AND json_extract(NEW.data,'$.operation.kind')='transfer' BEGIN SELECT RAISE(ABORT,'fixture transfer receipt fault'); END",
    );
    const p = f.engine.previewCommandLifetimeTransfer({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
      mode: "background",
    });
    assert.throws(() =>
      f.engine.transferCommandLifetime({
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        preview: p,
        fingerprint: f.engine.readCommandLifetimeTransfer(p).fingerprint,
        approved: true,
      }),
    );
    await jobUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, "Same original PID not cleaned");
    await jobUntil(
      () =>
        f.engine.inspectCommandLifetimes(f.workspace.id)[0]!
          .completionSha256 !== null,
      "Actual sealed completion missing",
    );
    assert.equal(
      f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.state,
      "uncertain",
    );
    db.exec("DROP TRIGGER lifetime_transfer_fault");
    db.close();
    await f.engine.close();
    const reopened = createEngine({
      ...f.configuration,
      commandLifetimes: false,
    });
    f.engines.add(reopened);
    assert.equal(
      reopened.inspectCommandLifetimes(f.workspace.id)[0]!.state,
      "uncertain",
    );
    assert.throws(
      () => reopened.coordinator.assertWorkspaceAvailable(f.workspace.id),
      { code: "CLEANUP_PENDING" },
    );
  },
);
test(
  "physical stdin succeeds before SQL ACK failure and preserves unknown receipt with no resend or owner takeover",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      started = await f.start(),
      db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TRIGGER lifetime_ack_fault BEFORE UPDATE ON session_documents WHEN NEW.kind GLOB 'command.lifetime.*' AND json_extract(NEW.data,'$.operation.kind')='input-ack' BEGIN SELECT RAISE(ABORT,'fixture stdin acknowledgement fault'); END",
    );
    await assert.rejects(f.input(started.jobId, "ACTUAL_ONCE\n"), {
      code: "COMMAND_LIFETIME_INPUT_UNCERTAIN",
    });
    const record = f.engine.inspectCommandLifetimes(f.workspace.id)[0]!;
    assert.equal(record.state, "uncertain");
    assert.equal(record.stdinSeq, 1);
    assert.equal(record.stdinBytes, 12);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM session_events WHERE type='command.lifetime.revision' AND json_extract(data,'$.payload.record.operation.kind')='input-ack'",
        )
        .get()!.n,
      0,
    );
    assert.throws(
      () =>
        f.engine.previewCommandLifetimeInput({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
          data: "RETRY",
        }),
      { code: "COMMAND_LIFETIME_OWNER_UNAVAILABLE" },
    );
    db.exec("DROP TRIGGER lifetime_ack_fault");
    db.close();
  },
);
test(
  "same-SHA sealed artifact inode replacement rejects current source while a captured output page stays frozen DATA",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      started = await f.start();
    await f.input(started.jobId, "DATA\n");
    await f.input(started.jobId, "", true);
    await f.engine.waitForCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    const h = f.engine.captureHostCommandOutput({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      }),
      page = f.engine.readHostCommandOutput(h),
      artifact = f.engine.readHostCommandArtifacts({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      }).stdout;
    const content = readFileSync(artifact.path);
    renameSync(artifact.path, artifact.path + ".old");
    writeFileSync(artifact.path, content);
    assert.throws(
      () =>
        f.engine.readHostCommandArtifacts({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
        }),
      { code: "HOST_COMMAND_ARTIFACT_STALE" },
    );
    assert.deepEqual(f.engine.readHostCommandOutput(h), page);
    f.engine.releaseHostCommandHandle(h);
  },
);
test(
  "genuine completed lifetime archive/import remains paused and default-off without restoring PID authority or source Run events",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      started = await f.start();
    await f.input(started.jobId, "", true);
    await f.engine.waitForCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    await f.engine.close();
    const archive = await exportEngineArchive({
        dbPath: f.dbPath,
        artifactDir: f.configuration.artifactDir!,
        destination: join(f.base, "lifetime.archive"),
      }),
      target = await importEngineArchive({
        directory: archive.directory,
        destination: join(f.base, "imported"),
      });
    const imported = createEngine({
      ...f.configuration,
      dbPath: target.dbPath,
      artifactDir: target.artifactDir,
      commandLifetimes: false,
    });
    f.engines.add(imported);
    const r = imported.inspectCommandLifetimes(f.workspace.id)[0]!;
    assert.equal(r.state, "paused-import");
    assert.deepEqual(structuredClone(r.physical), started.physical);
    assert.equal(
      imported.inspectHostCommands(f.workspace.id)[0]!.state,
      "paused-import",
    );
    assert.throws(
      () =>
        imported.previewCommandLifetimeTransfer({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
          mode: "background",
        }),
      { code: "COMMAND_LIFETIMES_DISABLED" },
    );
    assert.equal(f.providerCalls.length, 0);
  },
);
test(
  "actual cancellation racing the committed handoff keeps uncertainty and launches no replacement or stdin effect",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      started = await f.start();
    const put = f.engine.store.putCommandLifetime.bind(f.engine.store);
    let cancellation: Promise<unknown> | undefined;
    f.engine.store.putCommandLifetime = (record, revision) => {
      if (record.operation.kind === "transfer")
        cancellation = f.engine.cancelCommandLifetime({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
        });
      put(record, revision);
    };
    const p = f.engine.previewCommandLifetimeTransfer({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
      mode: "background",
    });
    assert.throws(
      () =>
        f.engine.transferCommandLifetime({
          workspaceId: f.workspace.id,
          requestId: randomUUID(),
          preview: p,
          fingerprint: f.engine.readCommandLifetimeTransfer(p).fingerprint,
          approved: true,
        }),
      { code: "COMMAND_LIFETIME_TRANSFER_UNCERTAIN" },
    );
    await cancellation;
    assert.equal(
      f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.state,
      "uncertain",
    );
    assert.throws(
      () =>
        f.engine.previewCommandLifetimeInput({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
          data: "late",
        }),
      { code: "COMMAND_LIFETIME_OWNER_UNAVAILABLE" },
    );
    assert.equal(f.engine.inspectHostCommands(f.workspace.id).length, 1);
  },
);
test(
  "actual stdin has one outstanding operation, immutable approval consumption and fixed total byte budget",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      started = await f.start();
    const input = f.engine.previewCommandLifetimeInput({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
        data: "ONE\n",
      }),
      fingerprint = f.engine.readCommandLifetimeInputPreview(input).fingerprint;
    const sent = f.engine.writeCommandLifetimeInput({
      workspaceId: f.workspace.id,
      requestId: "actual-input-once",
      preview: input,
      fingerprint,
      approved: true,
    });
    assert.throws(
      () =>
        f.engine.previewCommandLifetimeInput({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
          data: "CONCURRENT",
        }),
      { code: "COMMAND_LIFETIME_INPUT_UNAVAILABLE" },
    );
    await sent;
    await assert.rejects(
      f.engine.writeCommandLifetimeInput({
        workspaceId: f.workspace.id,
        requestId: "actual-input-once",
        preview: input,
        fingerprint,
        approved: true,
      }),
      { code: "COMMAND_LIFETIME_INPUT_STALE" },
    );
    assert.equal(
      f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.stdinSeq,
      1,
    );
    await f.engine.cancelCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
  },
);

test(
  "genuinely settled independent lifetime delivers through the existing atomic host result inbox and exact native provider pins",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      started = await f.start();
    await f.input(started.jobId, "INBOX_DATA\n");
    await f.input(started.jobId, "", true);
    await f.engine.waitForCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
    const target = f.engine.captureHostCommandJobDeliveryTarget({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
        config: f.config,
      }),
      requestId = randomUUID();
    const accepted = await f.engine.deliverHostCommandJobResult({
      workspaceId: f.workspace.id,
      requestId,
      expectedRevision: 0,
      target,
      approved: true,
    });
    assert.equal(
      accepted.record.accepted.inputId,
      f.engine.store.getInput(accepted.record.accepted.inputId).id,
    );
    assert.equal(
      f.engine.store.getInput(accepted.record.accepted.inputId).state,
      "pending",
    );
    const duplicate = await f.engine.deliverHostCommandJobResult({
      workspaceId: f.workspace.id,
      requestId,
      expectedRevision: 0,
      target,
      approved: true,
    });
    assert.equal(
      duplicate.record.accepted.inputId,
      accepted.record.accepted.inputId,
    );
    await jobCommand(f.engine, "session.resume", { sessionId: f.session.id });
    await jobUntil(
      () => f.providerCalls.length === 1,
      "Actual host lifetime inbox did not reach the provider",
    );
    const input = f.engine.store.getInput(accepted.record.accepted.inputId);
    assert.equal(input.state, "promoted");
    assert.equal((await f.engine.waitForRun(input.runId!)).state, "completed");
    assert.ok(
      f.providerCalls[0]!.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.includes("untrusted-command-observation"),
      ),
    );
    assert.equal(
      f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.state,
      "settled",
    );
  },
);
test(
  "actual supervisor drains four bounded stdin packets but refuses a fifth packet beyond the approved fixed lifetime byte cap",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      count = join(f.root, "stdin-count.txt");
    writeFileSync(
      join(f.root, "lifetime.mjs"),
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(f.marker)},String(process.pid));let bytes=0;process.stdin.on('data',b=>{bytes+=b.length;writeFileSync(${JSON.stringify(count)},String(bytes));});process.stdin.on('end',()=>process.stdout.write('TOTAL:'+bytes+'\\n'));`,
    );
    const started = await f.start();
    for (let i = 0; i < 4; i++) await f.input(started.jobId, "x".repeat(16384));
    await jobUntil(
      () => existsSync(count) && readFileSync(count, "utf8") === "65536",
      "Actual stdin bytes were not drained",
    );
    assert.equal(
      f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.stdinBytes,
      65536,
    );
    assert.throws(
      () =>
        f.engine.previewCommandLifetimeInput({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
          data: "fifth",
        }),
      { code: "COMMAND_LIFETIME_INPUT_UNAVAILABLE" },
    );
    await f.input(started.jobId, "", true);
    const done = await f.engine.waitForCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.equal(done.state, "settled");
    assert.equal(done.stdinSeq, 5);
  },
);

test(
  "foreground lifetime waiter rejects after actual physical join when both terminal native writes persistently fail",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      release = join(f.root, "settlement.release");
    writeFileSync(
      join(f.root, "lifetime.mjs"),
      `import{writeFileSync,existsSync}from'node:fs';writeFileSync(${JSON.stringify(f.marker)},String(process.pid));const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('PHYSICALLY_JOINED\\n');}},10);`,
    );
    const started = await f.start();
    await jobUntil(
      () => existsSync(f.marker),
      "Original command did not start",
    );
    assert.equal(
      Number(readFileSync(f.marker, "utf8")),
      started.physical!.groupPid,
    );
    const db = Reflect.get(f.engine.store, "db") as DatabaseSync,
      attempted: string[] = [];
    preserveCommandEvidence("lifetime-native-original", {
      classification:
        "genuine HostCommandService-owned command, primary native SQLite",
      started,
      marker: readFileSync(f.marker, "utf8"),
      host: f.engine.inspectHostCommands(f.workspace.id)[0],
      userVersion: Number(db.prepare("PRAGMA user_version").get()!.user_version),
    });
    db.function("lifetime_terminal_probe", (kind) => {
      attempted.push(String(kind));
      return 1;
    });
    db.exec(`CREATE TEMP TRIGGER lifetime_terminal_fault BEFORE UPDATE ON session_documents
      WHEN NEW.kind GLOB 'command.lifetime.*' AND json_extract(NEW.data,'$.operation.kind') IN ('closed','uncertain')
      BEGIN SELECT lifetime_terminal_probe(json_extract(NEW.data,'$.operation.kind')); SELECT RAISE(ABORT,'persistent terminal lifetime fault'); END`);
    const waiting = f.engine.waitForCommandLifetime({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      }),
      observed = waiting.then(
        (record) => ({ kind: "resolved" as const, record }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      writeFileSync(release, "original-command-only");
      const host = await f.engine.waitForHostCommand({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      });
      assert.equal(host.completion!.outcome.cleanupConfirmed, true);
      assert.equal(host.completion!.outcome.exitCode, 0);
      assert.deepEqual(attempted, ["closed", "uncertain"]);
      const result = await Promise.race([
        observed,
        new Promise<{ kind: "deadline" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "deadline" }), 1000);
        }),
      ]);
      assert.equal(
        result.kind,
        "rejected",
        "A physically joined command must not leave its no-signal waiter pending after both native writes fail",
      );
      if (result.kind === "rejected")
        assert.match(
          String(result.error),
          /persistent terminal lifetime fault/u,
        );
      preserveCommandEvidence("lifetime-native-joined-fault", {
        classification:
          "genuine physical join with persistent injected primary SQLite terminal write failures",
        host,
        attempted,
        waiter: result.kind,
        error: result.kind === "rejected" ? String(result.error) : null,
        lifetime: f.engine.inspectCommandLifetimes(f.workspace.id)[0],
        documents: db
          .prepare("SELECT * FROM session_documents ORDER BY session_id,kind")
          .all(),
        events: db
          .prepare("SELECT * FROM session_events ORDER BY session_id,seq")
          .all(),
        waiterDeadlineMs: 1000,
        approvedCommandLimits: { maxDurationMs: 10000, maxOutputBytes: 65536 },
      });
      assert.equal(
        f.engine.inspectCommandLifetimes(f.workspace.id)[0]!.state,
        "running",
      );
      assert.throws(
        () => f.engine.coordinator.assertWorkspaceAvailable(f.workspace.id),
        { code: "CLEANUP_PENDING" },
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type='command.lifetime.revision' AND json_extract(data,'$.payload.record.operation.kind') IN ('closed','uncertain')",
          )
          .get()!.n,
        0,
      );
    } finally {
      clearTimeout(timer);
      db.exec("DROP TRIGGER lifetime_terminal_fault");
    }
  },
);

test(
  "genuine background transfer releases an already waiting foreground caller before its original command closes",
  posix,
  async (t) => {
    const f = await lifetimeFixture(t),
      started = await f.start();
    const waiting = f.engine.waitForCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    f.transfer(started.jobId, "background");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        waiting,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Background transfer did not release foreground wait",
                ),
              ),
            1000,
          );
        }),
      ]);
      assert.equal(result.mode, "background");
      assert.equal(result.state, "running");
      assert.equal(result.completionSha256, null);
      assert.equal(
        f.engine.inspectHostCommands(f.workspace.id)[0]!.state,
        "running",
      );
    } finally {
      clearTimeout(timer);
      await f.engine.cancelCommandLifetime({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      });
    }
  },
);
