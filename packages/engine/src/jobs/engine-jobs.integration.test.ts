import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError, type Session } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { jobCommand, jobFixture, jobInvoke, jobUntil } from "./fixtures/job.js";
import type { CommandJob, JobDelivery, JobRequestResult } from "./store.js";
import type { JobOutputCursor, JobOutputPage } from "./types.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
};

test("an explicitly unavailable host PTY backend cannot grant a watched physical source", async (t) => {
  let attempted = 0;
  const f = await jobFixture(t, {
    createTerminal: false,
    engine: {
      ptyBackend: {
        async capability() {
          return {
            available: false,
            platform: process.platform,
            backend: "unavailable",
            processTree: "unsupported",
            isolation: "host-user",
            code: "PTY_UNAVAILABLE",
          };
        },
        async spawn() {
          attempted++;
          throw new EngineError(
            "PTY_UNAVAILABLE",
            "The explicit host backend is unavailable",
          );
        },
      },
    },
  });
  assert.equal(f.capability.available, false);
  await assert.rejects(
    f.engine.terminals.create({ owner: f.owner }),
    nativeError,
  );
  assert.equal(attempted, 1);
  const history = f.engine.terminals.list(f.owner);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.state, "failed");
  assert.throws(
    () =>
      jobInvoke(f.engine, "captureTerminalJob", {
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        terminalId: history[0]!.id,
      }),
    nativeError,
  );
  assert.equal(f.rows("job_revisions").length, 0);
});
const nativeError = (error: unknown) => error instanceof EngineError;
type Fixture = Awaited<ReturnType<typeof jobFixture>>;
function getJob(f: Fixture, jobId: string): CommandJob {
  return jobInvoke<CommandJob>(
    f.engine,
    "getCommandJob",
    f.workspace.id,
    jobId,
  );
}
function page(
  f: Fixture,
  source: object,
  job: CommandJob,
  cursor?: JobOutputCursor,
) {
  const original = jobInvoke<object>(f.engine, "captureJobOutput", source, {
    jobId: job.jobId,
    jobRevisionId: job.sourceRevisionId,
    ...(cursor ? { cursor } : {}),
  });
  const data = jobInvoke<JobOutputPage>(
    f.engine,
    "readJobOutputPage",
    original,
  );
  return { original, data };
}
function record(f: Fixture, original: object, job: CommandJob) {
  return jobInvoke<JobRequestResult<CommandJob>>(
    f.engine,
    "recordJobOutput",
    original,
    {
      workspaceId: f.workspace.id,
      jobId: job.jobId,
      outputId: randomUUID(),
      requestId: randomUUID(),
      expectedRevision: job.revision,
    },
  );
}
function settle(f: Fixture, original: object, job: CommandJob) {
  return jobInvoke<JobRequestResult<CommandJob>>(
    f.engine,
    "settleTerminalJob",
    original,
    {
      workspaceId: f.workspace.id,
      jobId: job.jobId,
      requestId: randomUUID(),
      expectedRevision: job.revision,
    },
  );
}

test(
  "a real user PTY job records bounded original output and settles from its genuine retained closed outcome",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    assert.equal(attached.result.record.jobKind, "user-terminal-watch");
    assert.equal(attached.result.record.state, "attached");
    const first = page(f, attached.original, attached.result.record);
    assert.ok(
      first.data.fragments
        .map((part) => part.data)
        .join("")
        .includes("JOB_READY:"),
    );
    assert.ok(first.data.rawBytes <= 8192);
    const recorded = record(f, first.original, attached.result.record);
    assert.deepEqual(recorded.output?.page, first.data);
    assert.equal(recorded.record.sourceRevisionId, attached.result.record.id);
    await f.finish();
    const final = settle(f, attached.original, recorded.record);
    assert.equal(final.record.state, "completed");
    assert.equal(final.record.outcome?.cleanupConfirmed, true);
    assert.equal(final.record.outcome?.exitCode, 0);
    assert.equal(f.rows("session_inputs").length, 0);
    assert.equal(f.providerCalls.length, 0);
    const copied = structuredClone(final.record) as unknown as {
      state: string;
    };
    copied.state = "uncertain";
    assert.equal(getJob(f, final.record.jobId).state, "completed");
  },
);

test(
  "copied sources, wrong owners and accessor selections cannot create a job or affect its real PTY",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      source = f.source(),
      before = f.rows("job_revisions").length;
    assert.throws(() => f.attach({ ...source }), nativeError);
    const other = await jobCommand<Session>(f.engine, "session.create", {
      workspaceId: f.workspace.id,
    });
    assert.throws(
      () =>
        jobInvoke(f.engine, "captureTerminalJob", {
          workspaceId: f.workspace.id,
          sessionId: other.id,
          terminalId: f.terminal!.id,
        }),
      nativeError,
    );
    let traps = 0;
    const invalid = {
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      get terminalId() {
        traps++;
        return f.terminal!.id;
      },
    };
    assert.throws(
      () => jobInvoke(f.engine, "captureTerminalJob", invalid),
      nativeError,
    );
    assert.equal(traps, 0);
    assert.equal(f.rows("job_revisions").length, before);
    assert.equal(
      f.engine.terminals.get(f.terminal!.id, f.owner).state,
      "running",
    );
    await f.write("still-owned-by-user");
    await jobUntil(
      () => f.text().includes("JOB_ECHO:still-owned-by-user"),
      "Rejected job admission affected the user PTY",
    );
  },
);

test(
  "cancelling a job watch retires only observation and cannot deliver or cancel its live user terminal",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    const cancelled = jobInvoke<JobRequestResult<CommandJob>>(
      f.engine,
      "cancelCommandJobWatch",
      {
        workspaceId: f.workspace.id,
        jobId: attached.result.record.jobId,
        requestId: randomUUID(),
        expectedRevision: attached.result.record.revision,
      },
    );
    assert.equal(cancelled.record.state, "cancelled");
    assert.equal(cancelled.record.outcome, null);
    assert.equal(
      f.engine.terminals.get(f.terminal!.id, f.owner).state,
      "running",
    );
    await f.write("watch-cancelled");
    await jobUntil(
      () => f.text().includes("JOB_ECHO:watch-cancelled"),
      "Observer cancellation stopped the user terminal",
    );
    assert.throws(
      () =>
        jobInvoke(f.engine, "captureCommandJobDeliveryTarget", {
          workspaceId: f.workspace.id,
          jobId: cancelled.record.jobId,
          config: f.config,
        }),
      nativeError,
    );
    assert.equal(f.rows("session_inputs").length, 0);
  },
);

test(
  "real UTF-8 output pages remain pinned while later PTY output arrives and advance the immutable source cursor",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    await f.write("unicode");
    await jobUntil(
      () => f.text().includes("UNICODE_END"),
      "The actual Unicode output did not arrive",
    );
    let job = attached.result.record;
    let current = page(f, attached.original, job);
    const snapshotSha = current.data.snapshotSha256;
    await f.write("late-output");
    await jobUntil(
      () => f.text().includes("JOB_ECHO:late-output"),
      "The late actual output did not arrive",
    );
    let content = "",
      reads = 0;
    while (true) {
      assert.ok(++reads < 16, "Bounded Unicode pages did not reach EOF");
      assert.equal(current.data.snapshotSha256, snapshotSha);
      assert.equal(
        current.data.jobRevisionId,
        attached.result.record.sourceRevisionId,
      );
      assert.ok(current.data.rawBytes <= 8192);
      assert.equal(
        current.data.fragments
          .map((part) => part.data)
          .join("")
          .includes("\ufffd"),
        false,
      );
      content += current.data.fragments.map((part) => part.data).join("");
      job = record(f, current.original, job).record;
      jobInvoke(f.engine, "releaseCommandJobHandle", current.original);
      if (!current.data.hasMore) break;
      current = page(f, attached.original, job, current.data.nextCursor);
    }
    assert.ok(reads > 1);
    assert.ok(content.includes("한글🙂"));
    assert.ok(content.includes("UNICODE_END"));
    assert.equal(content.includes("JOB_ECHO:late-output"), false);
    assert.ok(job.cursor);
    assert.equal(job.cursor.eventSeq, job.cursor.throughSeq + 1);
    assert.equal(job.cursor.byteOffset, 0);
  },
);

test(
  "end-of-snapshot captures release consumed snapshots but keep another watch's unfinished snapshot",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      watched = f.attach(),
      source = watched.original;
    let job = watched.result.record,
      other = f.attach(source).result.record;
    const partial = jobInvoke<object>(f.engine, "captureJobOutput", source, {
      jobId: other.jobId,
      jobRevisionId: other.sourceRevisionId,
      maxBytes: 4,
    });
    other = record(f, partial, other).record;
    jobInvoke(f.engine, "releaseCommandJobHandle", partial);
    assert.ok(other.cursor!.eventSeq <= other.cursor!.throughSeq);
    for (let i = 0; i < 70; i++) {
      const line = `cycle-${String(i).padStart(2, "0")}`;
      await f.write(line);
      await jobUntil(
        () => f.text().includes(`JOB_ECHO:${line}`),
        "The cycle output did not arrive",
      );
      let current = page(f, source, job);
      for (;;) {
        job = record(f, current.original, job).record;
        jobInvoke(f.engine, "releaseCommandJobHandle", current.original);
        if (!current.data.hasMore) break;
        current = page(f, source, job, current.data.nextCursor);
      }
    }
    assert.equal(job.cursor!.eventSeq, job.cursor!.throughSeq + 1);
    const resumed = page(f, source, other);
    assert.equal(resumed.data.snapshotSha256, other.cursor!.snapshotSha256);
    assert.equal(
      record(f, resumed.original, other).record.revision,
      other.revision + 1,
    );
  },
);

test(
  "explicit completed job result delivery queues one exact native input and cached result copies cannot alter its receipt",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    await f.finish();
    const closed = settle(f, attached.original, attached.result.record);
    await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
    const target = jobInvoke<object>(
      f.engine,
      "captureCommandJobDeliveryTarget",
      {
        workspaceId: f.workspace.id,
        jobId: closed.record.jobId,
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
    assert.throws(
      () =>
        jobInvoke(f.engine, "deliverCommandJobResult", {
          ...input,
          target: { ...target },
        }),
      nativeError,
    );
    assert.throws(
      () =>
        jobInvoke(f.engine, "deliverCommandJobResult", {
          ...input,
          approved: false,
        }),
      nativeError,
    );
    assert.equal(f.rows("session_inputs").length, 0);
    const delivered = jobInvoke<JobRequestResult<JobDelivery>>(
      f.engine,
      "deliverCommandJobResult",
      input,
    );
    assert.equal(delivered.record.state, "accepted");
    const expected = structuredClone(delivered);
    (delivered.record as unknown as { state: string }).state = "uncertain";
    const duplicate = jobInvoke<JobRequestResult<JobDelivery>>(
      f.engine,
      "deliverCommandJobResult",
      input,
    );
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.record, expected.record);
    assert.equal(f.rows("session_inputs").length, 1);
    const pending = f.engine.store.pendingInputs(f.session.id);
    assert.equal(pending.length, 1);
    assert.equal(
      pending[0]!.requestId,
      `job-result:${closed.record.jobId}:${closed.record.sha256}`,
    );
    assert.equal(pending[0]!.delivery, "queue");
    assert.match(pending[0]!.prompt, /untrusted-terminal-observation/);
    assert.equal(f.providerCalls.length, 0);
    await jobCommand(f.engine, "session.resume", { sessionId: f.session.id });
    await f.engine.scheduler.waitForSession(f.session.id);
    assert.equal(f.providerCalls.length, 1);
    assert.equal(
      f.engine.store.listTurns(f.engine.store.getInput(pending[0]!.id).runId!)
        .length,
      1,
    );
  },
);

test(
  "a changed actual profile fences an already accepted job result before queue promotion",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    await f.finish();
    const closed = settle(f, attached.original, attached.result.record);
    await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
    const target = jobInvoke<object>(
      f.engine,
      "captureCommandJobDeliveryTarget",
      {
        workspaceId: f.workspace.id,
        jobId: closed.record.jobId,
        config: f.config,
      },
    );
    const accepted = jobInvoke<JobRequestResult<JobDelivery>>(
      f.engine,
      "deliverCommandJobResult",
      {
        workspaceId: f.workspace.id,
        requestId: randomUUID(),
        expectedRevision: 0,
        target,
        approved: true,
      },
    );
    assert.ok(accepted.record.accepted);
    f.engine.profiles.register({
      id: "actual-job-read-profile",
      description: "Changed after native queue acceptance",
      instructions: "A new host profile cannot inherit the old result target",
      tools: ["read_file", "bash"],
    });
    await jobCommand(f.engine, "session.resume", { sessionId: f.session.id });
    await f.engine.waitForSession(f.session.id).catch(() => {});
    assert.equal(f.providerCalls.length, 0);
    assert.equal(
      f.engine.store.getInput(accepted.record.accepted.inputId).state,
      "pending",
    );
    assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 0);
    assert.equal(f.rows("session_inputs").length, 1);
    assert.throws(
      () => jobInvoke(f.engine, "readCommandJobDeliveryTarget", target),
      nativeError,
    );
  },
);

test(
  "atomic delivery rolls back its actual input and receipt together when native receipt storage fails",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    await f.finish();
    const closed = settle(f, attached.original, attached.result.record);
    await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
    const target = jobInvoke<object>(
      f.engine,
      "captureCommandJobDeliveryTarget",
      {
        workspaceId: f.workspace.id,
        jobId: closed.record.jobId,
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
    const db = new DatabaseSync(f.dbPath);
    db.exec(`CREATE TRIGGER reject_job_delivery_receipt BEFORE INSERT ON job_revisions
    WHEN NEW.kind='delivery' AND json_extract(NEW.data,'$.state')='accepted'
    BEGIN SELECT RAISE(ABORT,'Actual accepted delivery receipt failure'); END;`);
    try {
      assert.throws(() =>
        jobInvoke(f.engine, "deliverCommandJobResult", input),
      );
      assert.equal(f.rows("session_inputs").length, 0);
      assert.throws(() =>
        jobInvoke(f.engine, "deliverCommandJobResult", input),
      );
      assert.equal(f.rows("session_inputs").length, 0);
      const head = db
        .prepare(
          "SELECT r.data FROM job_heads h JOIN job_revisions r ON r.id=h.revision_id WHERE h.kind='delivery'",
        )
        .get();
      assert.equal(head, undefined);
      assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
      assert.equal(
        f.rows("session_events").filter((row) => row.type === "input.accepted")
          .length,
        0,
      );
      assert.equal(f.providerCalls.length, 0);
    } finally {
      db.exec("DROP TRIGGER reject_job_delivery_receipt");
      db.close();
    }
  },
);

test(
  "default-off reopen keeps interrupted watch history but cannot restore a source or replay a user process",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    await f.engine.close();
    const reopened = createEngine({ ...f.configuration, jobs: false });
    f.engines.add(reopened);
    const history = jobInvoke<CommandJob>(
      reopened,
      "getCommandJob",
      f.workspace.id,
      attached.result.record.jobId,
    );
    assert.equal(history.state, "uncertain");
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
        jobInvoke(reopened, "settleTerminalJob", attached.original, {
          workspaceId: f.workspace.id,
          jobId: history.jobId,
          requestId: randomUUID(),
          expectedRevision: history.revision,
        }),
      nativeError,
    );
    assert.equal(
      reopened.terminals.get(f.terminal!.id, f.owner).state,
      "cancelled",
    );
    assert.equal(f.providerCalls.length, 0);
  },
);

test(
  "an existing user terminal can remain usable while jobs are disabled",
  posix,
  async (t) => {
    const f = await jobFixture(t, { jobs: false });
    assert.throws(() => f.source(), nativeError);
    await f.write("feature-off");
    await jobUntil(
      () => f.text().includes("JOB_ECHO:feature-off"),
      "The independent user PTY stopped when jobs were disabled",
    );
    assert.equal(f.rows("job_revisions").length, 0);
  },
);
