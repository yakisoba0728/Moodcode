import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { jobFixture, jobUntil } from "./fixtures/job.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20000,
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
import { lifetimeFixture as fixture } from "./fixtures/command-lifetime.js";
test(
  "genuine host foreground→background→foreground preserves one supervisor and PID, accepts bounded Unicode stdin and EOF, and seals native cleanup",
  posix,
  async (t) => {
    const f = await fixture(t),
      started = await f.start();
    assert.equal(started.state, "running");
    await jobUntil(() => existsSync(f.marker), "Actual lifetime PID missing");
    const pid = Number(readFileSync(f.marker, "utf8"));
    assert.equal(started.physical!.groupPid, pid);
    let returned = false;
    const foreground = f.engine
      .waitForCommandLifetime({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      })
      .then((r) => {
        returned = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(returned, false);
    const background = f.transfer(started.jobId, "background");
    assert.equal((await foreground).mode, "background");
    assert.deepEqual(background.physical, started.physical);
    assert.equal(background.generation, 2);
    await f.input(started.jobId, "한글🙂\n");
    await jobUntil(() => {
      const h = f.engine.captureHostCommandOutput({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
      });
      try {
        return f.engine
          .readHostCommandOutput(h)
          .fragments.some((x) => x.data.includes("ECHO:한글🙂"));
      } finally {
        f.engine.releaseHostCommandHandle(h);
      }
    }, "Actual stdin output missing");
    const again = f.transfer(started.jobId, "foreground");
    assert.deepEqual(again.physical, started.physical);
    const joined = f.engine.waitForCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    await f.input(started.jobId, "", true);
    const completed = await joined;
    assert.equal(completed.state, "settled");
    assert.equal(completed.stdinEof, true);
    assert.equal(completed.transfers, 2);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const host = await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.equal(host.completion!.outcome.cleanupConfirmed, true);
    assert.equal(host.state, "completed");
    f.engine.readHostCommandArtifacts({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    const db = f.sql();
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM runs").get()!.n, 0);
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type='host.command.process'",
          )
          .get()!.n,
        1,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type='command.lifetime.revision' AND json_extract(data,'$.payload.record.operation.kind')='transfer'",
          )
          .get()!.n,
        2,
      );
    } finally {
      db.close();
    }
  },
);
test(
  "denied/copied original start and stale transfer/input approval never spawn or write",
  posix,
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.start(false), {
      code: "COMMAND_LIFETIME_APPROVAL_DENIED",
    });
    await assert.rejects(
      f.engine.startCommandLifetime({
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        preview: { ...f.preview },
        fingerprint: f.engine.readCommandLifetimePreview(f.preview).fingerprint,
        approved: true,
      }),
      { code: "COMMAND_LIFETIME_ORIGINAL_REQUIRED" },
    );
    assert.equal(existsSync(f.marker), false);
    const started = await f.start(),
      old = f.engine.previewCommandLifetimeInput({
        workspaceId: f.workspace.id,
        jobId: started.jobId,
        data: "OLD\n",
      }),
      oldFingerprint =
        f.engine.readCommandLifetimeInputPreview(old).fingerprint;
    f.transfer(started.jobId, "background");
    await assert.rejects(
      f.engine.writeCommandLifetimeInput({
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        preview: old,
        fingerprint: oldFingerprint,
        approved: true,
      }),
      { code: "COMMAND_LIFETIME_INPUT_STALE" },
    );
    assert.throws(
      () =>
        f.engine.previewCommandLifetimeInput({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
          data: "x".repeat(16385),
        }),
      { code: "COMMAND_LIFETIME_INPUT_UNAVAILABLE" },
    );
    const cancelled = await f.engine.cancelCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.equal(cancelled.state, "settled");
    assert.equal(
      f.engine.getHostCommand(f.workspace.id, started.jobId)!.state,
      "cancelled",
    );
  },
);
test(
  "Root close joins the same background process and reopening history issues no original ownership or replay",
  posix,
  async (t) => {
    const f = await fixture(t),
      started = await f.start();
    f.transfer(started.jobId, "background");
    await jobUntil(() => existsSync(f.marker), "PID missing");
    const pid = Number(readFileSync(f.marker, "utf8"));
    assert.equal(pid, started.physical!.groupPid);
    await f.engine.close();
    await jobUntil(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "ESRCH";
        }
      },
      "Original PID not reaped after Root cleanup: " +
        JSON.stringify({
          pid,
          physical: started.physical,
          ps: (() => {
            try {
              return execFileSync(
                "ps",
                ["-p", String(pid), "-o", "pid=,ppid=,pgid=,stat=,command="],
                { encoding: "utf8" },
              );
            } catch {
              return "gone";
            }
          })(),
        }),
    );
    const { createEngine } = await import("../engine.js");
    const reopened = createEngine({
      ...f.configuration,
      commandLifetimes: false,
    });
    f.engines.add(reopened);
    assert.equal(reopened.inspectCommandLifetimes(f.workspace.id).length, 1);
    assert.throws(
      () =>
        reopened.previewCommandLifetimeTransfer({
          workspaceId: f.workspace.id,
          jobId: started.jobId,
          mode: "foreground",
        }),
      { code: "COMMAND_LIFETIMES_DISABLED" },
    );
    assert.equal(f.providerCalls.length, 0);
  },
);
test(
  "a host start signal aborted after background admission leaves the lifetime to its own owner",
  posix,
  async (t) => {
    const f = await fixture(t, "background"),
      controller = new AbortController(),
      started = await f.start(true, controller.signal);
    assert.equal(started.mode, "background");
    controller.abort();
    await f.input(started.jobId, "", true);
    const host = await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.equal(host.state, "completed");
    assert.equal(host.completion!.outcome.cancelled, false);
    const settled = await f.engine.waitForCommandLifetime({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.equal(settled.state, "settled");
    assert.equal(settled.stdinEof, true);
  },
);
