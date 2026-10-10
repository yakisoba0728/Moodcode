import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { CommandPreflightRegistry } from "../permission/preflight.js";
import { RoleResourcePolicy } from "../permission/role-resources.js";
import type { ProviderAdapter, TurnRequest } from "../ports.js";
import { signJobData } from "./validation.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { jobCommand, jobFixture, jobUntil } from "./fixtures/job.js";
import {
  validateHostCommandDatabase,
  type HostCommandRecord,
} from "./host-command-records.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 25000,
};
const quote = (x: string) => `'${x.replaceAll("'", "'\\''")}'`;
const code = (name: string) => (e: unknown) =>
  e instanceof EngineError && e.code === name;
async function waitForHostPid(marker: string): Promise<number> {
  let pid = 0;
  await jobUntil(() => {
    if (!existsSync(marker)) return false;
    // Creating the marker precedes writing its PID; an empty read means PID 0.
    const text = readFileSync(marker, "utf8");
    if (!/^[1-9]\d*$/.test(text)) return false;
    const candidate = Number(text);
    if (!Number.isSafeInteger(candidate)) return false;
    pid = candidate;
    return true;
  }, "Actual host command positive PID was not observed");
  return pid;
}
async function fixture(
  t: test.TestContext,
  extra: Parameters<typeof jobFixture>[1] = {},
  deferPidPublication = false,
) {
  const f = await jobFixture(t, {
    ...extra,
    createTerminal: false,
    engine: { hostCommands: true, ...extra.engine },
  });
  const marker = join(f.root, "host.pid"),
    publishPid = join(f.root, "host-pid.publish"),
    release = join(f.root, "host.release"),
    effect = join(f.root, "host-effect.txt"),
    script = join(f.root, "host-command.mjs");
  writeFileSync(
    script,
    `import{writeFileSync,existsSync}from'node:fs';${deferPidPublication ? `writeFileSync(${JSON.stringify(marker)},'');while(!existsSync(${JSON.stringify(publishPid)}))await new Promise(resolve=>setTimeout(resolve,1));` : ""}writeFileSync(${JSON.stringify(marker)},String(process.pid));writeFileSync(${JSON.stringify(effect)},'Actual independent host effect\\n');process.stdout.write('HOST_READY 한글🙂\\n');let timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('HOST_DONE\\n',()=>process.exit(0));}},10);`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const preview = () =>
    f.engine.previewHostCommand({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      command,
      limits: { maxDurationMs: 10000, maxOutputBytes: 1048576 },
    });
  const start = async (
    original: object,
    approved = true,
    requestId = randomUUID(),
  ) =>
    f.engine.startHostCommand({
      workspaceId: f.workspace.id,
      requestId,
      preview: original,
      fingerprint: f.engine.readHostCommandPreview(original).fingerprint,
      approved,
    });
  const complete = async (record: HostCommandRecord) => {
    writeFileSync(release, "Explicit continuation");
    return f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: record.jobId,
    });
  };
  const counts = () => {
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      return Object.fromEntries(
        [
          "runs",
          "tools",
          "approvals",
          "session_turns",
          "provider_attempts",
          "checkpoints",
        ].map((table) => [
          table,
          Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
        ]),
      );
    } finally {
      db.close();
    }
  };
  return {
    ...f,
    marker,
    publishPid,
    release,
    effect,
    script,
    preview,
    start,
    complete,
    counts,
  };
}

test(
  "independent approved command owns its idle workspace, genuine PID, output and checkpoint without creating Run/Tool identities",
  posix,
  async (t) => {
    const f = await fixture(t),
      before = f.counts(),
      original = await f.preview(),
      proof = f.engine.readHostCommandPreview(original);
    assert.equal(proof.input.command.includes(f.script), true);
    assert.equal(existsSync(f.marker), false);
    const requestId = randomUUID(),
      started = await f.start(original, true, requestId);
    assert.equal(started.state, "running");
    assert.ok(started.pid);
    await jobUntil(
      () => existsSync(f.marker) && existsSync(f.effect),
      "Actual host command did not execute",
    );
    const pid = Number(readFileSync(f.marker, "utf8"));
    assert.equal(
      readFileSync(f.effect, "utf8"),
      "Actual independent host effect\n",
    );
    await assert.rejects(
      f.engine.coordinator.withWorkspaceLease(f.workspace.id, async () => {}),
      (e) =>
        e instanceof EngineError &&
        ["WORKSPACE_BUSY", "CLEANUP_PENDING"].includes(e.code),
    );
    const submit = await f.engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type: "run.submit",
      payload: {
        sessionId: f.session.id,
        requestId: randomUUID(),
        prompt: "Lease must reject this run",
        config: JSON.parse(JSON.stringify(f.config)),
      },
    });
    assert.equal(submit.ok, false);
    assert.ok(
      ["WORKSPACE_BUSY", "CLEANUP_PENDING"].includes(submit.error?.code ?? ""),
    );
    await assert.rejects(
      f.start(original, true, randomUUID()),
      (e) =>
        e instanceof EngineError &&
        ["WORKSPACE_BUSY", "CLEANUP_PENDING"].includes(e.code),
    );
    assert.equal(f.engine.inspectHostCommands(f.workspace.id).length, 1);
    const temporary = f.engine.captureHostCommandOutput({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    f.engine.releaseHostCommandHandle(temporary);
    await assert.rejects(
      f.engine.coordinator.withWorkspaceLease(f.workspace.id, async () => {}),
      (e) =>
        e instanceof EngineError &&
        ["WORKSPACE_BUSY", "CLEANUP_PENDING"].includes(e.code),
    );
    const duplicate = await f.start(original, true, requestId);
    assert.equal(duplicate.jobId, started.jobId);
    assert.equal(duplicate.pid, started.pid);
    await jobUntil(
      () =>
        f.engine.getHostCommand(f.workspace.id, started.jobId)!.outputSeq > 0,
      "Original output was not recorded",
    );
    const frozen = f.engine.captureHostCommandOutput({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      }),
      page = f.engine.readHostCommandOutput(frozen);
    assert.ok(
      page.fragments
        .map((v) => v.data)
        .join("")
        .includes("한글🙂"),
    );
    const closed = await f.complete(started);
    assert.equal(closed.state, "completed");
    assert.equal(closed.completion?.outcome.cleanupConfirmed, true);
    assert.ok(
      closed.completion?.files.some((v) => v.path === "host-effect.txt"),
    );
    assert.equal(closed.completion?.stdout.sha256.length, 64);
    assert.equal(
      f.engine.readHostCommandArtifacts({
        workspaceId: f.workspace.id,
        jobId: closed.jobId,
      }).stdout.sha256,
      closed.completion?.stdout.sha256,
    );
    assert.throws(
      () => process.kill(pid, 0),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
    );
    assert.deepEqual(f.counts(), before);
    assert.equal(f.providerCalls.length, 0);
    assert.deepEqual(f.engine.readHostCommandOutput(frozen), page);
    f.engine.releaseHostCommandHandle(frozen);
    await f.engine.coordinator.withWorkspaceLease(
      f.workspace.id,
      async () => {},
    );
  },
);

test(
  "deny, copied Original, accessors and stale policy all reject before independent process effects",
  posix,
  async (t) => {
    const f = await fixture(t),
      original = await f.preview(),
      fingerprint = f.engine.readHostCommandPreview(original).fingerprint;
    const input = {
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview: original,
      fingerprint,
      approved: true,
    };
    let traps = 0;
    await assert.rejects(
      f.engine.startHostCommand({ ...input, preview: { ...original } }),
      code("HOST_COMMAND_ORIGINAL_REQUIRED"),
    );
    await assert.rejects(
      f.engine.startHostCommand({
        ...input,
        preview: new Proxy(
          {},
          {
            get() {
              traps++;
              throw Error("trap");
            },
          },
        ),
      }),
      code("HOST_COMMAND_ORIGINAL_REQUIRED"),
    );
    await assert.rejects(
      f.engine.startHostCommand({
        ...input,
        get approved() {
          traps++;
          return true;
        },
      }),
    );
    assert.equal(traps, 0);
    await assert.rejects(
      f.engine.startHostCommand({ ...input, fingerprint: "f".repeat(64) }),
      code("HOST_COMMAND_APPROVAL_MISMATCH"),
    );
    const denied = await f.start(original, false);
    assert.equal(denied.state, "denied");
    assert.equal(denied.pid, null);
    f.engine.toolRuntime.policy.replace([
      { tool: "run_command", decision: "deny" },
    ]);
    await assert.rejects(
      f.engine.startHostCommand(input),
      code("HOST_COMMAND_POLICY_DENIED"),
    );
    assert.equal(existsSync(f.marker), false);
    assert.equal(existsSync(f.effect), false);
    assert.equal(f.providerCalls.length, 0);
    assert.equal(f.counts().runs, 0);
  },
);

test(
  "explicit host cancel and Engine.close abort and join the same real process while preserving confirmed independent cleanup",
  posix,
  async (t) => {
    for (const close of [false, true]) {
      const f = await fixture(t),
        started = await f.start(await f.preview());
      const pid = await waitForHostPid(f.marker);
      if (close) {
        await f.engine.close();
        const restarted = createEngine({
          ...f.configuration,
          hostCommands: false,
        });
        f.engines.add(restarted);
        const record = restarted.getHostCommand(f.workspace.id, started.jobId)!;
        assert.equal(record.state, "cancelled");
        assert.equal(record.completion?.outcome.cleanupConfirmed, true);
      } else {
        const record = await f.engine.cancelHostCommand({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
        });
        assert.equal(record.state, "cancelled");
        assert.equal(record.completion?.outcome.cleanupConfirmed, true);
        await f.engine.coordinator.withWorkspaceLease(
          f.workspace.id,
          async () => {},
        );
      }
      assert.throws(
        () => process.kill(pid, 0),
        (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
      );
      assert.equal(f.providerCalls.length, 0);
    }
  },
);

test(
  "host cancel waits for the real positive PID when its native marker exists before publication",
  posix,
  async (t) => {
    const f = await fixture(t, {}, true),
      started = await f.start(await f.preview());
    await jobUntil(() => existsSync(f.marker), "Host PID marker absent");
    assert.equal(readFileSync(f.marker, "utf8"), "");
    assert.equal(Number(readFileSync(f.marker, "utf8")), 0);
    let ready = false;
    const pendingPid = waitForHostPid(f.marker).then((pid) => {
      ready = true;
      return pid;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ready, false, "An empty marker must not publish PID 0");
    writeFileSync(f.publishPid, "Publish the original process PID");
    const pid = await pendingPid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0));
    const record = await f.engine.cancelHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.equal(record.pid, started.pid);
    assert.equal(record.state, "cancelled");
    assert.equal(record.completion?.outcome.cleanupConfirmed, true);
    assert.throws(
      () => process.kill(pid, 0),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
    );
    await f.engine.coordinator.withWorkspaceLease(
      f.workspace.id,
      async () => {},
    );
    assert.equal(f.providerCalls.length, 0);
  },
);

test(
  "native approved admission SQL fault rolls back all identity records and prevents spawn; native PID fault cleans the launched process and retains uncertainty",
  posix,
  async (t) => {
    for (const phase of ["approved", "running"]) {
      const f = await fixture(t),
        original = await f.preview(),
        db = new DatabaseSync(f.dbPath);
      db.exec(
        `CREATE TRIGGER host_fault BEFORE INSERT ON host_command_revisions WHEN NEW.kind='${phase}' BEGIN SELECT RAISE(ABORT,'actual host native fault'); END;`,
      );
      await assert.rejects(f.start(original));
      db.exec("DROP TRIGGER host_fault");
      db.close();
      if (phase === "approved") {
        assert.equal(existsSync(f.marker), false);
        assert.deepEqual(f.engine.inspectHostCommands(f.workspace.id), []);
      } else {
        await jobUntil(
          () =>
            f.engine.inspectHostCommands(f.workspace.id)[0]?.state ===
            "uncertain",
          "Failed PID admission was not quarantined",
        );
        if (existsSync(f.marker)) {
          const pid = Number(readFileSync(f.marker, "utf8"));
          assert.throws(
            () => process.kill(pid, 0),
            (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
          );
        }
        assert.throws(
          () =>
            f.engine.coordinator.assertWorkspaceCleanupConfirmed(
              f.workspace.id,
            ),
          code("CLEANUP_PENDING"),
        );
        await assert.rejects(f.engine.close(), code("CLEANUP_UNCERTAIN"));
        f.engines.delete(f.engine);
      }
      assert.equal(f.counts().runs, 0);
      assert.equal(f.providerCalls.length, 0);
    }
  },
);

test(
  "approval and closed journals keep workspace file contents out while historical closed witnesses still validate",
  posix,
  async (t) => {
    const f = await fixture(t),
      secret = `API_KEY=host-secret-${randomUUID()}\n`,
      effect = "Actual independent host effect\n",
      sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    writeFileSync(join(f.root, ".env"), secret);
    const closed = await f.complete(await f.start(await f.preview()));
    assert.equal(closed.state, "completed");
    assert.equal(
      closed.completion?.files.find((v) => v.path === "host-effect.txt")?.after,
      effect,
    );
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    const approved = JSON.parse(
      String(
        db
          .prepare(
            "SELECT data FROM host_command_revisions WHERE job_id=? AND revision=1",
          )
          .get(closed.jobId)!.data,
      ),
    );
    assert.deepEqual(
      approved.payload.files.find((v: { path: string }) => v.path === ".env"),
      { path: ".env", sha256: sha256(secret), bytes: Buffer.byteLength(secret) },
    );
    for (const [table, text] of [
      ["host_command_revisions", secret],
      ["session_events", secret],
      ["session_events", effect],
    ] as const)
      assert.equal(
        Number(
          db
            .prepare(`SELECT count(*) n FROM ${table} WHERE instr(data,?)>0`)
            .get(text)!.n,
        ),
        0,
        `${table} retained ${JSON.stringify(text)}`,
      );
    const row = db
        .prepare(
          "SELECT seq,data FROM session_events WHERE type='host.command.closed' AND json_extract(data,'$.payload.jobId')=?",
        )
        .get(closed.jobId)!,
      event = JSON.parse(String(row.data)),
      witnessed = event.payload.completion.files.find(
        (v: { path: string }) => v.path === "host-effect.txt",
      );
    assert.deepEqual(witnessed, {
      path: "host-effect.txt",
      beforeHash: null,
      afterHash: sha256(effect),
    });
    const rewrite = (payload: unknown) =>
      db
        .prepare("UPDATE session_events SET data=? WHERE session_id=? AND seq=?")
        .run(JSON.stringify({ ...event, payload }), f.session.id, row.seq!);
    db.exec("BEGIN");
    try {
      rewrite({ ...event.payload, completion: closed.completion });
      validateHostCommandDatabase(db);
      witnessed.afterHash = "f".repeat(64);
      rewrite(event.payload);
      assert.throws(() => validateHostCommandDatabase(db), {
        code: "HOST_COMMAND_EVIDENCE_INVALID",
      });
    } finally {
      db.exec("ROLLBACK");
    }
    validateHostCommandDatabase(db);
  },
);

test(
  "completed native host history reopens without capabilities or replay and imports paused with exact successful cleanup history",
  posix,
  async (t) => {
    const f = await fixture(t),
      started = await f.start(await f.preview()),
      closed = await f.complete(started);
    await f.engine.close();
    const restarted = createEngine({ ...f.configuration, hostCommands: false });
    f.engines.add(restarted);
    assert.deepEqual(
      restarted.getHostCommand(f.workspace.id, closed.jobId),
      closed,
    );
    await assert.rejects(
      restarted.previewHostCommand({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        command: "true",
        limits: { maxDurationMs: 1000, maxOutputBytes: 1000 },
      }),
      code("HOST_COMMANDS_DISABLED"),
    );
    assert.throws(() =>
      restarted.captureHostCommandOutput({
        workspaceId: f.workspace.id,
        jobId: closed.jobId,
      }),
    );
    await restarted.close();
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "archive"),
    });
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "imported"),
    });
    const engine = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      hostCommands: false,
    });
    f.engines.add(engine);
    const history = engine.getHostCommand(f.workspace.id, closed.jobId)!;
    assert.equal(history.state, "paused-import");
    assert.equal(history.completion?.outcome.cleanupConfirmed, true);
    assert.equal(
      history.completion?.stdout.sha256,
      closed.completion?.stdout.sha256,
    );
    assert.equal(f.providerCalls.length, 0);
  },
);

test(
  "same-byte sealed artifact inode substitution rejects new physical observation while a previously frozen output page remains advisory DATA",
  posix,
  async (t) => {
    const f = await fixture(t),
      started = await f.start(await f.preview()),
      closed = await f.complete(started),
      original = f.engine.captureHostCommandOutput({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      }),
      page = f.engine.readHostCommandOutput(original),
      path = closed.completion!.stdout.path;
    const replacement = `${path}.replacement`;
    writeFileSync(replacement, readFileSync(path));
    renameSync(replacement, path);
    assert.throws(
      () =>
        f.engine.readHostCommandArtifacts({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
        }),
      code("HOST_COMMAND_ARTIFACT_STALE"),
    );
    assert.throws(
      () =>
        f.engine.captureHostCommandOutput({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
        }),
      code("HOST_COMMAND_ARTIFACT_STALE"),
    );
    assert.deepEqual(f.engine.readHostCommandOutput(original), page);
  },
);

test(
  "Run-only command preflight cannot be bypassed by independent host execution and produces no analyzer or process effects",
  posix,
  async (t) => {
    let analyzerCalls = 0;
    const f = await fixture(t, {
      engine: {
        commandPreflight: {
          registry: new CommandPreflightRegistry(),
          selectAnalyzer: () => {
            analyzerCalls++;
            return undefined;
          },
        },
      },
    });
    await assert.rejects(f.preview(), code("HOST_COMMAND_POLICY_UNSUPPORTED"));
    assert.equal(analyzerCalls, 0);
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(f.engine.inspectHostCommands(f.workspace.id), []);
    assert.equal(f.providerCalls.length, 0);
  },
);

test(
  "independent approved duration and output budgets abort the genuine process without widening its native ownership",
  posix,
  async (t) => {
    for (const budget of ["duration", "output"]) {
      const f = await fixture(t),
        command =
          budget === "duration"
            ? `${quote(process.execPath)} ${quote(f.script)}`
            : `${quote(process.execPath)} -e ${quote("process.stdout.write('한글🙂'.repeat(10000));setInterval(()=>{},100);")}`;
      const original = await f.engine.previewHostCommand({
          workspaceId: f.workspace.id,
          sessionId: f.session.id,
          command: command ?? `${quote(process.execPath)} ${quote(f.script)}`,
          timeoutMs: budget === "duration" ? 300 : 10000,
          limits: {
            maxDurationMs: 10000,
            maxOutputBytes: budget === "output" ? 64 : 1048576,
          },
        }),
        started = await f.start(original),
        closed = await f.engine.waitForHostCommand({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
        });
      assert.equal(closed.state, "cancelled");
      assert.equal(closed.completion?.outcome.cleanupConfirmed, true);
      assert.equal(
        closed.preview.limits.maxOutputBytes,
        budget === "output" ? 64 : 1048576,
      );
      assert.ok(
        closed.outputStoredBytes <= closed.preview.limits.maxOutputBytes,
      );
      if (budget === "duration")
        assert.equal(closed.completion?.outcome.timedOut, true);
      else assert.ok(closed.outputObservedBytes > 64);
      await f.engine.coordinator.withWorkspaceLease(
        f.workspace.id,
        async () => {},
      );
      assert.equal(f.counts().runs, 0);
    }
  },
);

test(
  "native checkpoint/closed receipt fault after real cleanup retains durable uncertainty across restart and archive import",
  posix,
  async (t) => {
    for (const phase of ["checkpoint", "closed"]) {
      const f = await fixture(t),
        started = await f.start(await f.preview());
      let pid = 0;
      await jobUntil(() => {
        if (!existsSync(f.marker)) return false;
        const text = readFileSync(f.marker, "utf8");
        if (!/^[1-9]\d*$/.test(text)) return false;
        const candidate = Number(text);
        if (!Number.isSafeInteger(candidate)) return false;
        pid = candidate;
        return true;
      }, "Actual host command positive PID was not observed");
      const db = new DatabaseSync(f.dbPath);
      db.exec(
        `CREATE TRIGGER host_settle_fault BEFORE INSERT ON host_command_revisions WHEN NEW.kind='${phase}' BEGIN SELECT RAISE(ABORT,'genuine settlement fault'); END;`,
      );
      writeFileSync(f.release, "Finish the original source");
      await assert.rejects(
        f.engine.waitForHostCommand({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
        }),
        code("CLEANUP_UNCERTAIN"),
      );
      db.exec("DROP TRIGGER host_settle_fault");
      db.close();
      // A rejected native settlement is uncertainty, not a physical exit acknowledgement.
      await jobUntil(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }, "The original command PID remained alive after settlement failure");
      assert.throws(
        () => process.kill(pid, 0),
        (e: unknown) => (e as NodeJS.ErrnoException).code === "ESRCH",
      );
      assert.equal(
        f.engine.getHostCommand(f.workspace.id, started.jobId)!.state,
        "uncertain",
      );
      await assert.rejects(f.engine.close(), code("CLEANUP_UNCERTAIN"));
      f.engines.delete(f.engine);
      const reopened = createEngine({
        ...f.configuration,
        hostCommands: false,
      });
      f.engines.add(reopened);
      assert.equal(
        reopened.getHostCommand(f.workspace.id, started.jobId)!.state,
        "uncertain",
      );
      assert.equal(reopened.store.hasUncertainWorkspace(f.workspace.id), true);
      await reopened.close();
      const archive = await exportEngineArchive({
          dbPath: f.dbPath,
          artifactDir: f.artifactDir,
          destination: join(f.base, "uncertain-archive"),
        }),
        imported = await importEngineArchive({
          directory: archive.directory,
          destination: join(f.base, "uncertain-import"),
        }),
        historical = createEngine({
          ...f.configuration,
          dbPath: imported.dbPath,
          artifactDir: imported.artifactDir,
          hostCommands: false,
        });
      f.engines.add(historical);
      assert.equal(
        historical.getHostCommand(f.workspace.id, started.jobId)!.state,
        "paused-import",
      );
      assert.equal(
        historical.store.hasUncertainWorkspace(f.workspace.id),
        true,
      );
      assert.equal(f.providerCalls.length, 0);
    }
  },
);

test(
  "frozen independent output cursors pin their actual source and reject non-codepoint offsets without invoking caller traps",
  posix,
  async (t) => {
    const f = await fixture(t),
      started = await f.start(await f.preview());
    await jobUntil(
      () =>
        f.engine.getHostCommand(f.workspace.id, started.jobId)!.outputSeq > 0,
      "Actual output absent",
    );
    const original = f.engine.captureHostCommandOutput({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      }),
      page = f.engine.readHostCommandOutput(original);
    assert.throws(
      () => f.engine.readHostCommandOutput({ ...original }),
      code("HOST_COMMAND_ORIGINAL_REQUIRED"),
    );
    const other = f.engine.captureHostCommandOutput({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.throws(
      () =>
        f.engine.readHostCommandOutput(other, {
          cursor: signJobData({
            ...page.nextCursor,
            snapshotSha256: "f".repeat(64),
          }),
        }),
      code("HOST_COMMAND_CURSOR_STALE"),
    );
    const event = page.fragments.find((e) => e.data.includes("한"))!,
      offset =
        Buffer.byteLength(event.data.slice(0, event.data.indexOf("한"))) + 1,
      cursor = signJobData({
        ...page.nextCursor,
        eventSeq: event.seq,
        byteOffset: offset,
      });
    assert.throws(
      () => f.engine.readHostCommandOutput(original, { cursor }),
      code("HOST_COMMAND_CURSOR_STALE"),
    );
    let traps = 0;
    assert.throws(() =>
      f.engine.readHostCommandOutput(original, {
        get cursor() {
          traps++;
          return page.nextCursor;
        },
      }),
    );
    assert.equal(traps, 0);
    await f.complete(started);
  },
);

test(
  "a genuine active provider Run prevents independent admission before native approval or process effects",
  posix,
  async (t) => {
    let request: TurnRequest | undefined;
    const provider: ProviderAdapter = {
      id: "actual-job-fixture",
      async *streamTurn(actual, signal) {
        request = actual;
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "finish", reason: "stop" };
      },
    };
    const f = await fixture(t),
      original = await f.preview();
    (
      Reflect.get(
        Reflect.get(f.engine.coordinator, "options"),
        "providers",
      ) as Map<string, ProviderAdapter>
    ).set(provider.id, provider);
    const response = await f.engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type: "run.submit",
      payload: {
        sessionId: f.session.id,
        requestId: randomUUID(),
        prompt: "Real native Run retains workspace admission",
        config: JSON.parse(JSON.stringify(f.config)),
      },
    });
    assert.equal(response.ok, true, JSON.stringify(response.error));
    const receipt = response.result as unknown as { runId: string };
    await jobUntil(
      () => request !== undefined,
      "Actual provider Run did not enter",
    );
    await assert.rejects(f.start(original), code("WORKSPACE_BUSY"));
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(f.engine.inspectHostCommands(f.workspace.id), []);
    assert.equal(f.counts().runs, 1);
    await f.engine.coordinator.cancel(receipt.runId);
    assert.equal((await f.engine.waitForRun(receipt.runId)).state, "cancelled");
  },
);

test(
  "configured Run-owned role/resource policy rejects the independent lane before any physical or durable admission",
  posix,
  async (t) => {
    const f = await fixture(t, {
      engine: {
        roleResourcePolicy: new RoleResourcePolicy({ revision: 1, rules: [] }),
      },
    });
    await assert.rejects(f.preview(), code("HOST_COMMAND_POLICY_UNSUPPORTED"));
    assert.equal(existsSync(f.marker), false);
    assert.deepEqual(f.engine.inspectHostCommands(f.workspace.id), []);
  },
);

test(
  "actual invalid UTF8 output is retained as bounded decoded advisory text while sealed byte evidence remains exact",
  posix,
  async (t) => {
    const f = await fixture(t),
      preview = await f.engine.previewHostCommand({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        command: `${quote(process.execPath)} -e ${quote("process.stdout.write(Buffer.from([255,240,159,153,130,227]));")}`,
        limits: { maxDurationMs: 10000, maxOutputBytes: 100000 },
      }),
      started = await f.start(preview),
      closed = await f.engine.waitForHostCommand({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      });
    assert.equal(closed.state, "completed");
    assert.equal(closed.completion?.stdout.observedBytes, 6);
    const original = f.engine.captureHostCommandOutput({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      }),
      page = f.engine.readHostCommandOutput(original);
    assert.equal(page.fragments.map((v) => v.data).join(""), "�🙂�");
    assert.equal(closed.completion?.outcome.cleanupConfirmed, true);
    assert.equal(f.counts().runs, 0);
  },
);
