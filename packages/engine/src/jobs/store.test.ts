import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { JOB_SCHEMA_SQL } from "./schema.js";
import {
  JobStorage,
  validateJobDatabase,
  markImportedJobsPaused,
  type JobStoragePorts,
} from "./store.js";
import { signJobData } from "./validation.js";
import { readJobOutput } from "./output.js";
import type {
  JobOwnerProof,
  TerminalJobSourceProof,
  TerminalClosedOutcomeProof,
  JobOutputCursor,
  JobOutputPage,
  JobOutputSnapshot,
} from "./types.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
/** Explicit trusted test producers exercise native SQL contracts, not physical PTY authority. Real Root integration is separate. */
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE workspaces(id TEXT PRIMARY KEY);CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id));CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id TEXT,workspace_id TEXT,request_id TEXT,admitted_seq INTEGER,data TEXT);CREATE TABLE session_events(session_id TEXT,seq INTEGER,type TEXT,data TEXT,PRIMARY KEY(session_id,seq));",
  );
  db.exec(JOB_SCHEMA_SQL);
  db.prepare("INSERT INTO workspaces(id) VALUES(?)").run("workspace");
  db.prepare("INSERT INTO sessions(id,workspace_id) VALUES(?,?)").run(
    "session",
    "workspace",
  );
  const at = "2026-10-08T00:00:00.000Z",
    sha = "a".repeat(64);
  const source = signJobData({
    terminalId: "terminal",
    workspaceId: "workspace",
    sessionId: "session",
    serviceEpoch: "epoch",
    entryBirthNonce: "birth",
    journalBindingSha256: sha,
    launchSha256: sha,
    createdAt: at,
    authority: "current-physical" as const,
  }) as TerminalJobSourceProof;
  const owner = signJobData({
    workspaceId: "workspace",
    sessionId: "session",
    rootBindingSha256: sha,
    ownerEpoch: sha,
    sourceSha256: source.sha256,
  }) as JobOwnerProof;
  const originals = new WeakMap<
    object,
    {
      source: TerminalJobSourceProof;
      owner: JobOwnerProof;
      page?: JobOutputPage;
      outcome?: TerminalClosedOutcomeProof;
    }
  >();
  let reads = 0,
    seq = 0;
  const emit = (type: string, payload: object) => {
    seq++;
    db.prepare(
      "INSERT INTO session_events(session_id,seq,type,data) VALUES(?,?,?,?)",
    ).run(
      "session",
      seq,
      type,
      JSON.stringify({ sessionId: "session", type, payload }),
    );
  };
  const { sha256: _sourceSha, ...tuple } = source;
  emit("terminal.source_admitted", {
    ...tuple,
    sourceSha256: source.sha256,
    ownerSha256: owner.sha256,
    rootBindingSha256: owner.rootBindingSha256,
    ownerEpoch: owner.ownerEpoch,
  });
  const original = Object.freeze({});
  originals.set(original, { source, owner });
  function capture(value: object) {
    const row = originals.get(value);
    if (!row)
      throw new EngineError("JOB_ORIGINAL_REQUIRED", "Test original missing");
    return row;
  }
  const unavailable = (): never => {
    throw new EngineError(
      "JOB_ORIGINAL_REQUIRED",
      "No test delivery authority",
    );
  };
  const ports: JobStoragePorts = {
    writeTx: (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    getWorkspace: () => ({
      id: "workspace",
      root: "/test",
      gitRoot: "/test",
      branch: null,
      createdAt: at,
    }),
    readOwner: (v) => capture(v).owner,
    assertOwnerCurrent: (v, expected) =>
      assert.equal(capture(v).owner.sha256, expected.sha256),
    readSource: (v) => {
      reads++;
      return capture(v).source;
    },
    assertSourceCurrent: (v, expected) =>
      assert.equal(capture(v).source.sha256, expected.sha256),
    readOutput: (v) => {
      const p = capture(v).page;
      return p ?? unavailable();
    },
    readClosedOutcome: (v) => {
      const o = capture(v).outcome;
      return o ?? unavailable();
    },
    readDeliveryTarget: unavailable,
    assertDeliveryTargetCurrent: unavailable,
    readAccepted: unavailable,
    now: () => Date.parse(at),
  };
  const native = new JobStorage(db, ports),
    attach = (jobId = "job", requestId = "attach") =>
      native.attachTerminalJob(original, {
        workspaceId: "workspace",
        jobId,
        requestId,
        expectedRevision: 0,
      });
  const snapshots = new Map<number, JobOutputSnapshot>();
  function page(
    jobId: string,
    jobRevisionId: string,
    events = 1,
    cursor?: JobOutputCursor | null,
  ) {
    let snapshot = snapshots.get(events);
    if (!snapshot) {
      snapshot = signJobData(
        {
          version: 1 as const,
          source,
          throughSeq: events,
          oldestSeq: 1,
          observedBytes: 6 * events,
          retainedBytes: 6 * events,
          output: Array.from({ length: events }, (_, i) => ({
            seq: i + 1,
            data: "한글",
            bytes: 6,
          })),
        },
        4194304,
      ) as JobOutputSnapshot;
      snapshots.set(events, snapshot);
    }
    const p = readJobOutput(snapshot, {
      jobId,
      jobRevisionId,
      maxFragments: 1,
      ...(cursor ? { cursor } : {}),
    });
    const handle = {};
    originals.set(handle, { source, owner, page: p });
    emit("terminal.output_observed", {
      sourceSha256: source.sha256,
      ownerSha256: owner.sha256,
      pageSha256: p.sha256,
      snapshotSha256: p.snapshotSha256,
      jobId,
      jobRevisionId,
    });
    return handle;
  }
  function closed(state: "completed" | "uncertain" = "completed") {
    const outcome = signJobData({
      sourceSha256: source.sha256,
      state,
      exitCode: 0,
      cancelled: false,
      timedOut: false,
      cleanupConfirmed: true,
      reason: state === "uncertain" ? "journal_failed" : null,
      closedAt: at,
    }) as TerminalClosedOutcomeProof;
    const handle = {};
    originals.set(handle, { source, owner, outcome });
    emit("terminal.source_closed", {
      ...outcome,
      ownerSha256: owner.sha256,
      outcomeSha256: outcome.sha256,
    });
    return handle;
  }
  return {
    db,
    native,
    original,
    owner,
    source,
    attach,
    page,
    closed,
    reads: () => reads,
  };
}
function rollback(db: DatabaseSync, fn: () => void) {
  db.exec("SAVEPOINT native_job_probe");
  try {
    fn();
  } finally {
    db.exec("ROLLBACK TO native_job_probe;RELEASE native_job_probe");
  }
}

test("job primary journals enforce STRICT, FK, row bounds and WITHOUT ROWID", (t) => {
  const f = fixture(t),
    r = f.attach().record;
  for (const table of ["job_revisions", "job_heads"]) {
    const sql = String(
      f.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)!
        .sql,
    );
    assert.match(sql, /STRICT/);
    assert.match(sql, /WITHOUT ROWID/);
    assert.throws(
      () => f.db.prepare(`SELECT rowid FROM ${table}`).get(),
      /no such column/,
    );
  }
  for (const [column, value] of [
    ["revision", "string"],
    ["revision", 0],
    ["workspace_id", "missing"],
    ["session_id", "missing"],
    ["data", "x".repeat(65537)],
  ] as const)
    rollback(f.db, () =>
      assert.throws(
        () =>
          f.db
            .prepare(`UPDATE job_revisions SET ${column}=? WHERE id=?`)
            .run(value, r.id),
        /constraint|cannot store/i,
      ),
    );
  validateJobDatabase(f.db);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM session_inputs").get()!.n,
    0,
  );
});

test("native job dedupe precedes original capture and current CAS while getter inputs have zero effects", (t) => {
  const f = fixture(t),
    first = f.attach();
  const n = f.reads();
  f.native.cancelWatch({
    workspaceId: "workspace",
    jobId: "job",
    requestId: "cancel",
    expectedRevision: 1,
  });
  const duplicate = f.native.attachTerminalJob(
    {},
    {
      workspaceId: "workspace",
      jobId: "job",
      requestId: "attach",
      expectedRevision: 0,
    },
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(f.reads(), n);
  assert.throws(
    () =>
      f.native.attachTerminalJob(f.original, {
        workspaceId: "workspace",
        jobId: "job",
        requestId: "attach",
        expectedRevision: 1,
      }),
    code("JOB_REQUEST_CONFLICT"),
  );
  let getters = 0;
  const value = {
    workspaceId: "workspace",
    jobId: "getter",
    requestId: "getter",
    get expectedRevision() {
      getters++;
      return 0;
    },
  };
  assert.throws(() => f.native.attachTerminalJob(f.original, value));
  assert.equal(getters, 0);
  assert.equal(f.reads(), n);
  validateJobDatabase(f.db);
});

test("output binds immutable source admission revision separately from current CAS; copied pages cannot produce writes", (t) => {
  const f = fixture(t),
    attached = f.attach().record,
    p = f.page("job", attached.sourceRevisionId),
    input = {
      workspaceId: "workspace",
      jobId: "job",
      outputId: "output",
      requestId: "output",
      expectedRevision: 1,
    };
  const out = f.native.recordJobOutput(p, input);
  assert.equal(out.record.revision, 2);
  assert.equal(out.record.sourceRevisionId, attached.id);
  assert.equal(out.record.cursor!.jobRevisionId, attached.id);
  assert.equal(out.output!.page.fragments[0]!.data, "한글");
  assert.equal(f.native.readOutputs("workspace", "job")[0]!.id, out.output!.id);
  assert.throws(
    () =>
      f.native.recordJobOutput(
        {},
        {
          ...input,
          requestId: "copied",
          outputId: "copied",
          expectedRevision: 2,
        },
      ),
    code("JOB_ORIGINAL_REQUIRED"),
  );
  assert.equal(f.native.getJob("workspace", "job")!.revision, 2);
  validateJobDatabase(f.db);
});

test("fully rehashed terminal state does not replace exact transition or primary physical outcome anchors", (t) => {
  const f = fixture(t),
    r = f.attach().record;
  rollback(f.db, () => {
    const forged = signJobData({ ...r, state: "cancelled" });
    const receipt = JSON.parse(
      String(
        f.db
          .prepare("SELECT data FROM job_revisions WHERE id=?")
          .get(r.lastReceiptId)!.data,
      ),
    );
    const changed = signJobData({ ...receipt, afterSha256: forged.sha256 });
    f.db
      .prepare("UPDATE job_revisions SET data=?,sha256=? WHERE id=?")
      .run(JSON.stringify(forged), forged.sha256, r.id);
    f.db
      .prepare("UPDATE job_revisions SET data=?,sha256=? WHERE id=?")
      .run(JSON.stringify(changed), changed.sha256, changed.id);
    f.db
      .prepare("UPDATE job_heads SET sha256=? WHERE revision_id=?")
      .run(forged.sha256, r.id);
    assert.throws(() => validateJobDatabase(f.db));
  });
  const completed = f.native.settleTerminalJob(f.closed(), {
    workspaceId: "workspace",
    jobId: "job",
    requestId: "settle",
    expectedRevision: 1,
  }).record;
  assert.equal(completed.state, "completed");
  rollback(f.db, () => {
    f.db
      .prepare("DELETE FROM session_events WHERE type='terminal.source_closed'")
      .run();
    assert.throws(
      () => validateJobDatabase(f.db),
      code("JOB_NATIVE_SOURCE_INVALID"),
    );
  });
  validateJobDatabase(f.db);
});

test("confirmed physical cleanup plus uncertain terminal durability stays uncertain", (t) => {
  const f = fixture(t);
  f.attach();
  const r = f.native.settleTerminalJob(f.closed("uncertain"), {
    workspaceId: "workspace",
    jobId: "job",
    requestId: "settle",
    expectedRevision: 1,
  }).record;
  assert.equal(r.state, "uncertain");
  assert.equal(r.outcome!.cleanupConfirmed, true);
  assert.throws(
    () =>
      f.native.prepareJobDelivery(
        {},
        {
          workspaceId: "workspace",
          jobId: "job",
          deliveryId: "delivery",
          requestId: "delivery",
          expectedRevision: 0,
        },
      ),
    code("JOB_NOT_SETTLED"),
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM session_inputs").get()!.n,
    0,
  );
  validateJobDatabase(f.db);
});

test("native restart and import append conservative history without reading originals or accepting inbox inputs", (t) => {
  const f = fixture(t),
    a = f.attach().record,
    originalRows = f.db
      .prepare("SELECT id,data FROM job_revisions ORDER BY id")
      .all(),
    captures = f.reads();
  assert.equal(f.native.recoverInterrupted(), 1);
  assert.equal(f.native.getJob("workspace", "job")!.state, "uncertain");
  assert.equal(f.native.recoverInterrupted(), 0);
  assert.equal(f.reads(), captures);
  for (const row of originalRows)
    assert.equal(
      f.db.prepare("SELECT data FROM job_revisions WHERE id=?").get(row.id!)!
        .data,
      row.data,
    );
  assert.equal(markImportedJobsPaused(f.db, "b".repeat(64), "absent"), 0);
  assert.equal(markImportedJobsPaused(f.db, "b".repeat(64), "workspace"), 1);
  assert.equal(f.native.getJob("workspace", "job")!.state, "paused-import");
  assert.equal(f.native.getJob("workspace", "job", a.id)!.state, "attached");
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM session_inputs").get()!.n,
    0,
  );
  validateJobDatabase(f.db);
});

test("watchers enforce session and global historical caps and missing heads cannot hide immutable entities", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) f.attach(`live-${i}`, `attach-${i}`);
  assert.throws(() => f.attach("fifth", "fifth"), code("JOB_LIMIT"));
  for (let i = 0; i < 4; i++)
    f.native.cancelWatch({
      workspaceId: "workspace",
      jobId: `live-${i}`,
      requestId: `cancel-${i}`,
      expectedRevision: 1,
    });
  for (let i = 4; i < 128; i++) {
    const id = `history-${i}`;
    f.attach(id, `attach-${i}`);
    f.native.cancelWatch({
      workspaceId: "workspace",
      jobId: id,
      requestId: `cancel-${i}`,
      expectedRevision: 1,
    });
  }
  assert.throws(() => f.attach("overflow", "overflow"), code("JOB_LIMIT"));
  assert.equal(f.native.inspectJobs("workspace").length, 128);
  validateJobDatabase(f.db);
  rollback(f.db, () => {
    f.db
      .prepare("DELETE FROM job_heads WHERE kind='job' AND entity_id='live-0'")
      .run();
    assert.throws(
      () => validateJobDatabase(f.db),
      code("JOB_DATABASE_INVALID"),
    );
  });
});

test("outputs read in recording order; empty pages and reused output ids write nothing", (t) => {
  const f = fixture(t),
    events = 6;
  let job = f.attach().record;
  const record = (outputId: string, requestId = outputId) =>
    f.native.recordJobOutput(
      f.page("job", job.sourceRevisionId, events, job.cursor),
      {
        workspaceId: "workspace",
        jobId: "job",
        outputId,
        requestId,
        expectedRevision: job.revision,
      },
    ).record;
  for (let i = 0; i < events - 1; i++) job = record(`output-${i}`);
  assert.throws(
    () => record("output-0", "reused"),
    code("JOB_REVISION_CONFLICT"),
  );
  job = record(`output-${events - 1}`);
  assert.deepEqual(
    f.native.readOutputs("workspace", "job").map((o) => o.outputId),
    Array.from({ length: events }, (_, i) => `output-${i}`),
  );
  const rows = f.db.prepare("SELECT count(*) n FROM job_revisions").get()!.n;
  assert.throws(() => record("empty"), code("JOB_OUTPUT_STALE"));
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM job_revisions").get()!.n,
    rows,
  );
  assert.equal(f.native.getJob("workspace", "job")!.revision, job.revision);
  validateJobDatabase(f.db);
});

test("ordinary job writes leave settle and cancel room for every attached watch", (t) => {
  const f = fixture(t);
  const a = f.attach("a", "attach-a").record;
  f.attach("b", "attach-b");
  f.db
    .prepare(
      "WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM k WHERE i<8184) INSERT INTO job_revisions(id,workspace_id,kind,entity_id,job_id,created_at,revision,session_id,terminal_id,source_sha256,owner_epoch,request_scope,request_id,request_sha256,sha256,data) SELECT 'pad-'||i,'workspace','transition','pad-'||i,'pad','2026-10-08T00:00:00.000Z',1,'session','terminal','pad','pad','pad','pad-'||i,'pad','pad','{}' FROM k",
    )
    .run();
  const rows = () =>
    Number(f.db.prepare("SELECT count(*) n FROM job_revisions").get()!.n);
  assert.equal(rows(), 8188);
  assert.throws(
    () =>
      f.native.recordJobOutput(f.page("a", a.sourceRevisionId), {
        workspaceId: "workspace",
        jobId: "a",
        outputId: "output",
        requestId: "output",
        expectedRevision: 1,
      }),
    code("JOB_LIMIT"),
  );
  assert.throws(() => f.attach("c", "attach-c"), code("JOB_LIMIT"));
  assert.equal(rows(), 8188);
  assert.equal(
    f.native.settleTerminalJob(f.closed(), {
      workspaceId: "workspace",
      jobId: "a",
      requestId: "settle",
      expectedRevision: 1,
    }).record.state,
    "completed",
  );
  f.native.cancelWatch({
    workspaceId: "workspace",
    jobId: "b",
    requestId: "cancel",
    expectedRevision: 1,
  });
  assert.equal(rows(), 8192);
  f.db.prepare("DELETE FROM job_revisions WHERE id GLOB 'pad-*'").run();
  validateJobDatabase(f.db);
});
