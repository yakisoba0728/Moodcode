import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { jobFixture, jobInvoke, jobUntil } from "./fixtures/job.js";
import {
  validateJobDatabase,
  type CommandJob,
  type JobOutputRevision,
  type JobRequestResult,
} from "./store.js";
import type { JobOutputPage } from "./types.js";
import { signJobData } from "./validation.js";

test(
  "authentic later PTY page cannot replace the initial durable prefix even after all native wrappers are rehashed",
  { skip: !["darwin", "linux", "freebsd"].includes(process.platform) },
  async (t) => {
    const f = await jobFixture(t),
      attached = f.attach(),
      job = attached.result.record;
    await f.write("unicode");
    await jobUntil(
      () => f.text().includes("UNICODE_END"),
      "Actual PTY did not emit the bounded Unicode source",
    );
    const firstOriginal = jobInvoke<object>(
      f.engine,
      "captureJobOutput",
      attached.original,
      { jobId: job.jobId, jobRevisionId: job.sourceRevisionId },
    );
    const first = jobInvoke<JobOutputPage>(
      f.engine,
      "readJobOutputPage",
      firstOriginal,
    );
    assert.equal(first.hasMore, true);
    const written = jobInvoke<JobRequestResult<CommandJob>>(
      f.engine,
      "recordJobOutput",
      firstOriginal,
      {
        workspaceId: f.workspace.id,
        jobId: job.jobId,
        outputId: randomUUID(),
        requestId: randomUUID(),
        expectedRevision: 1,
      },
    );
    assert.ok(written.output);
    const lateOriginal = jobInvoke<object>(
      f.engine,
      "captureJobOutput",
      attached.original,
      {
        jobId: job.jobId,
        jobRevisionId: job.sourceRevisionId,
        cursor: first.nextCursor,
      },
    );
    const late = jobInvoke<JobOutputPage>(
      f.engine,
      "readJobOutputPage",
      lateOriginal,
    );
    assert.ok(late.fragments.length);
    assert.notEqual(late.sha256, first.sha256);
    assert.equal(late.gap, null);
    const db = new DatabaseSync(f.dbPath);
    try {
      validateJobDatabase(db);
      db.exec("SAVEPOINT job_graph_probe");
      try {
        const output = signJobData(
            { ...written.output!, page: late },
            65536,
          ) as JobOutputRevision,
          after = signJobData({ ...written.record, cursor: late.nextCursor });
        for (const [before, forged] of [
          [written.output!, output],
          [written.record, after],
        ] as const) {
          const receipt = JSON.parse(
            String(
              db
                .prepare("SELECT data FROM job_revisions WHERE id=?")
                .get(before.lastReceiptId)!.data,
            ),
          );
          const changed = signJobData({
            ...receipt,
            afterSha256: forged.sha256,
          });
          db.prepare("UPDATE job_revisions SET data=?,sha256=? WHERE id=?").run(
            JSON.stringify(forged),
            forged.sha256,
            before.id,
          );
          db.prepare("UPDATE job_revisions SET data=?,sha256=? WHERE id=?").run(
            JSON.stringify(changed),
            changed.sha256,
            changed.id,
          );
          db.prepare("UPDATE job_heads SET sha256=? WHERE revision_id=?").run(
            forged.sha256,
            before.id,
          );
        }
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        assert.throws(
          () => validateJobDatabase(db),
          (error) =>
            error instanceof EngineError && error.code === "JOB_OUTPUT_STALE",
        );
        assert.equal(f.providerCalls.length, 0);
      } finally {
        db.exec("ROLLBACK TO job_graph_probe;RELEASE job_graph_probe");
      }
      validateJobDatabase(db);
    } finally {
      db.close();
    }
  },
);
