import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { jobFixture, jobInvoke, jobUntil } from "./fixtures/job.js";
import type { CommandJob, JobRequestResult } from "./store.js";
import type { JobOutputCursor, JobOutputPage } from "./types.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
};
const nativeError = (error: unknown) => error instanceof EngineError;
type Fixture = Awaited<ReturnType<typeof jobFixture>>;
function events(f: Fixture, type: string): number {
  return f.rows("session_events").filter((row) => row.type === type).length;
}
function capture(
  f: Fixture,
  original: object,
  job: CommandJob,
  cursor?: JobOutputCursor,
) {
  const page = jobInvoke<object>(f.engine, "captureJobOutput", original, {
    jobId: job.jobId,
    jobRevisionId: job.sourceRevisionId,
    ...(cursor ? { cursor } : {}),
  });
  return {
    original: page,
    data: jobInvoke<JobOutputPage>(f.engine, "readJobOutputPage", page),
  };
}
function recordInput(f: Fixture, job: CommandJob) {
  return {
    workspaceId: f.workspace.id,
    jobId: job.jobId,
    outputId: randomUUID(),
    requestId: randomUUID(),
    expectedRevision: job.revision,
  };
}
function settleInput(f: Fixture, job: CommandJob) {
  return {
    workspaceId: f.workspace.id,
    jobId: job.jobId,
    requestId: randomUUID(),
    expectedRevision: job.revision,
  };
}
function get(f: Fixture, jobId: string): CommandJob {
  return jobInvoke<CommandJob>(
    f.engine,
    "getCommandJob",
    f.workspace.id,
    jobId,
  );
}

test(
  "actual source admission SQL failure cannot leave a source anchor or a synthetic job and retry remains original",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      db = new DatabaseSync(f.dbPath);
    try {
      db.exec(
        `CREATE TRIGGER reject_terminal_source BEFORE INSERT ON session_events WHEN NEW.type='terminal.source_admitted' BEGIN SELECT RAISE(ABORT,'Actual source anchor failed'); END;`,
      );
      assert.throws(() => f.source());
      assert.equal(events(f, "terminal.source_admitted"), 0);
      assert.equal(f.rows("job_revisions").length, 0);
      db.exec("DROP TRIGGER reject_terminal_source");
      const attached = f.attach();
      assert.equal(events(f, "terminal.source_admitted"), 1);
      assert.equal(attached.result.record.source.terminalId, f.terminal!.id);
      assert.equal(
        f.engine.terminals.get(f.terminal!.id, f.owner).state,
        "running",
      );
      assert.equal(f.providerCalls.length, 0);
    } finally {
      db.close();
    }
  },
);

test(
  "actual output anchor and output/head SQL failures roll back independently and retain one original retry",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach(),
      db = new DatabaseSync(f.dbPath);
    try {
      db.exec(
        `CREATE TRIGGER reject_terminal_page BEFORE INSERT ON session_events WHEN NEW.type='terminal.output_observed' BEGIN SELECT RAISE(ABORT,'Actual output anchor failed'); END;`,
      );
      assert.throws(() =>
        capture(f, attached.original, attached.result.record),
      );
      assert.equal(events(f, "terminal.output_observed"), 0);
      assert.equal(get(f, attached.result.record.jobId).revision, 1);
      db.exec("DROP TRIGGER reject_terminal_page");
      const original = capture(f, attached.original, attached.result.record);
      assert.equal(events(f, "terminal.output_observed"), 1);
      const before = f.rows("job_revisions").length,
        input = recordInput(f, attached.result.record);
      db.exec(
        `CREATE TRIGGER reject_terminal_output BEFORE INSERT ON job_revisions WHEN NEW.kind='output' BEGIN SELECT RAISE(ABORT,'Actual output row failed'); END;`,
      );
      assert.throws(() =>
        jobInvoke(f.engine, "recordJobOutput", original.original, input),
      );
      assert.equal(f.rows("job_revisions").length, before);
      assert.equal(get(f, input.jobId).revision, 1);
      db.exec("DROP TRIGGER reject_terminal_output");
      const committed = jobInvoke<JobRequestResult<CommandJob>>(
        f.engine,
        "recordJobOutput",
        original.original,
        input,
      );
      assert.deepEqual(committed.output?.page, original.data);
      assert.equal(committed.record.revision, 2);
      assert.equal(events(f, "terminal.output_observed"), 1);
      assert.equal(f.providerCalls.length, 0);
    } finally {
      db.close();
    }
  },
);

test(
  "genuine closed anchor and native settlement share rollback; retry never fabricates a second physical outcome",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach(),
      db = new DatabaseSync(f.dbPath);
    await f.finish();
    const input = settleInput(f, attached.result.record),
      before = f.rows("job_revisions").length;
    try {
      db.exec(
        `CREATE TRIGGER reject_terminal_settlement BEFORE INSERT ON job_revisions WHEN NEW.kind='job' AND json_extract(NEW.data,'$.state')='completed' BEGIN SELECT RAISE(ABORT,'Actual settlement row failed'); END;`,
      );
      assert.throws(() =>
        jobInvoke(f.engine, "settleTerminalJob", attached.original, input),
      );
      assert.equal(events(f, "terminal.source_closed"), 0);
      assert.equal(f.rows("job_revisions").length, before);
      assert.equal(get(f, input.jobId).state, "attached");
      assert.equal(
        f.engine.terminals.get(f.terminal!.id, f.owner).state,
        "completed",
      );
      db.exec("DROP TRIGGER reject_terminal_settlement");
      const settled = jobInvoke<JobRequestResult<CommandJob>>(
        f.engine,
        "settleTerminalJob",
        attached.original,
        input,
      );
      assert.equal(settled.record.state, "completed");
      assert.equal(settled.record.outcome?.cleanupConfirmed, true);
      assert.equal(events(f, "terminal.source_closed"), 1);
      assert.equal(f.providerCalls.length, 0);
    } finally {
      db.close();
    }
  },
);

test(
  "replacing the real terminal journal inode rejects retained and newly captured sources before native effects",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach(),
      original = capture(f, attached.original, attached.result.record);
    const journal = join(f.artifactDir, "terminals.sqlite"),
      backup = join(f.artifactDir, "terminals.original.sqlite");
    const inode = statSync(journal, { bigint: true }).ino,
      before = f.rows("job_revisions").length;
    renameSync(journal, backup);
    copyFileSync(backup, journal);
    assert.notEqual(statSync(journal, { bigint: true }).ino, inode);
    try {
      assert.throws(
        () => jobInvoke(f.engine, "readTerminalJobSource", attached.original),
        nativeError,
      );
      assert.throws(() => f.source(), nativeError);
      assert.throws(
        () => jobInvoke(f.engine, "readJobOutputPage", original.original),
        nativeError,
      );
      assert.throws(
        () =>
          jobInvoke(
            f.engine,
            "recordJobOutput",
            original.original,
            recordInput(f, attached.result.record),
          ),
        nativeError,
      );
      assert.throws(
        () =>
          jobInvoke(
            f.engine,
            "settleTerminalJob",
            attached.original,
            settleInput(f, attached.result.record),
          ),
        nativeError,
      );
      assert.equal(f.rows("job_revisions").length, before);
      assert.equal(get(f, attached.result.record.jobId).revision, 1);
      assert.equal(f.providerCalls.length, 0);
    } finally {
      rmSync(journal);
      renameSync(backup, journal);
    }
    assert.equal(
      jobInvoke<{ terminalId: string }>(
        f.engine,
        "readTerminalJobSource",
        attached.original,
      ).terminalId,
      f.terminal!.id,
    );
  },
);

test(
  "enabled reopen retains completed terminal history without reissuing its physical source or original owner",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    await f.finish();
    const settled = jobInvoke<JobRequestResult<CommandJob>>(
      f.engine,
      "settleTerminalJob",
      attached.original,
      settleInput(f, attached.result.record),
    );
    await f.engine.close();
    const reopened = createEngine({ ...f.configuration, jobs: true });
    f.engines.add(reopened);
    const history = jobInvoke<CommandJob>(
      reopened,
      "getCommandJob",
      f.workspace.id,
      settled.record.jobId,
    );
    assert.equal(history.state, "completed");
    assert.equal(
      reopened.terminals.get(f.terminal!.id, f.owner).state,
      "completed",
    );
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
      () => jobInvoke(reopened, "readTerminalJobSource", attached.original),
      nativeError,
    );
    assert.equal(f.providerCalls.length, 0);
  },
);

test(
  "native forward output rejects a genuine late first page and an old replay, then continues after frozen EOF",
  posix,
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach();
    await f.write("unicode");
    await jobUntil(
      () => f.text().includes("UNICODE_END"),
      "Actual Unicode output arrived",
    );
    let job = attached.result.record,
      current = capture(f, attached.original, job);
    assert.equal(current.data.hasMore, true);
    const late = capture(f, attached.original, job, current.data.nextCursor),
      before = f.rows("job_revisions").length;
    assert.throws(
      () =>
        jobInvoke(
          f.engine,
          "recordJobOutput",
          late.original,
          recordInput(f, job),
        ),
      nativeError,
    );
    assert.equal(f.rows("job_revisions").length, before);
    job = jobInvoke<JobRequestResult<CommandJob>>(
      f.engine,
      "recordJobOutput",
      current.original,
      recordInput(f, job),
    ).record;
    assert.throws(
      () =>
        jobInvoke(
          f.engine,
          "recordJobOutput",
          current.original,
          recordInput(f, job),
        ),
      nativeError,
    );
    assert.equal(get(f, job.jobId).revision, job.revision);
    let reads = 1;
    while (current.data.hasMore) {
      assert.ok(++reads < 16);
      current = capture(f, attached.original, job, current.data.nextCursor);
      job = jobInvoke<JobRequestResult<CommandJob>>(
        f.engine,
        "recordJobOutput",
        current.original,
        recordInput(f, job),
      ).record;
    }
    const prior = job.cursor!;
    assert.equal(prior.eventSeq, prior.throughSeq + 1);
    await f.write("after-committed-eof");
    await jobUntil(
      () => f.text().includes("JOB_ECHO:after-committed-eof"),
      "Late physical output arrived after native EOF",
    );
    const fresh = capture(f, attached.original, job),
      content = fresh.data.fragments.map((part) => part.data).join("");
    assert.notEqual(fresh.data.snapshotSha256, prior.snapshotSha256);
    assert.ok(content.includes("JOB_ECHO:after-committed-eof"));
    assert.equal(content.includes("JOB_READY:"), false);
    assert.equal(content.includes("한글🙂"), false);
    assert.equal(fresh.data.fragments[0]!.seq, prior.eventSeq);
    const committed = jobInvoke<JobRequestResult<CommandJob>>(
      f.engine,
      "recordJobOutput",
      fresh.original,
      recordInput(f, job),
    );
    assert.equal(committed.record.revision, job.revision + 1);
    assert.equal(f.providerCalls.length, 0);
  },
);
