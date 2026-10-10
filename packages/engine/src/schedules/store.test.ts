import assert from "node:assert/strict";
import test from "node:test";
import { EngineError, type InputRecord } from "@moodcode/contracts";
import { scheduleFixture, scheduleInvoke } from "./fixtures/schedule.js";
import {
  ScheduleStorage,
  markImportedSchedulesDisabled,
  validateScheduleDatabase,
  type ScheduleRequestResult,
  type ScheduleRevision,
  type SchedulerLeaseResult,
  type ScheduleClaimResult,
  type TriggerOccurrence,
  type ScheduleStoragePorts,
  type ScheduleDueResult,
} from "./store.js";

const code = (name: string) => (error: unknown) =>
  error instanceof EngineError && error.code === name;
async function actual(t: test.TestContext) {
  const f = await scheduleFixture(t),
    target = f.target(),
    spec = f.spec(target.pin),
    native = Reflect.get(f.engine, "scheduleRecords") as ScheduleStorage;
  assert.ok(native instanceof ScheduleStorage);
  const registered = scheduleInvoke<ScheduleRequestResult<ScheduleRevision>>(
    f.engine,
    "registerSchedule",
    target.original,
    {
      workspaceId: f.workspace.id,
      requestId: "register",
      expectedRevision: 0,
      spec,
    },
  );
  const worker = scheduleInvoke<object>(
      f.engine,
      "captureScheduleWorker",
      f.workspace.id,
    ),
    leaseInput = {
      workspaceId: f.workspace.id,
      requestId: "lease",
      expectedRevision: 0,
      ttlMs: 30000,
    };
  const lease = scheduleInvoke<SchedulerLeaseResult>(
    f.engine,
    "acquireSchedulerLease",
    worker,
    leaseInput,
  );
  assert.ok(lease.lease);
  return { f, target, spec, native, registered, worker, lease, leaseInput };
}
function rollback(native: ScheduleStorage, run: () => void) {
  native.db.exec("SAVEPOINT native_schedule_probe");
  try {
    run();
  } finally {
    native.db.exec("ROLLBACK TO native_schedule_probe");
    native.db.exec("RELEASE native_schedule_probe");
  }
}
function due(value: Awaited<ReturnType<typeof actual>>) {
  return scheduleInvoke<object>(value.f.engine, "previewScheduleDue", {
    workspaceId: value.f.workspace.id,
    scheduleId: value.spec.id,
  });
}
function advance(
  value: Awaited<ReturnType<typeof actual>>,
  requestId = "advance",
) {
  const input = {
    workspaceId: value.f.workspace.id,
    scheduleId: value.spec.id,
    requestId,
    expectedRevision: value.registered.record.revision,
  };
  const original = due(value),
    result = value.native.advanceDueBatch(value.worker, original, input);
  return { original, input, result };
}

test("native schedule SQLite enforces STRICT, relational FKs, bounded JSON and WITHOUT ROWID", async (t) => {
  const { native, registered } = await actual(t);
  for (const name of ["schedule_revisions", "schedule_heads"]) {
    const sql = String(
      native.db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!
        .sql,
    );
    assert.match(sql, /STRICT/i);
    assert.match(sql, /WITHOUT ROWID/i);
    assert.throws(
      () => native.db.prepare(`SELECT rowid FROM ${name}`).get(),
      /no such column/,
    );
  }
  for (const [sql, arg] of [
    ["UPDATE schedule_revisions SET revision=? WHERE id=?", "bad-type"],
    ["UPDATE schedule_revisions SET revision=? WHERE id=?", 0],
    [
      "UPDATE schedule_revisions SET workspace_id=? WHERE id=?",
      "missing-workspace",
    ],
    ["UPDATE schedule_revisions SET input_id=? WHERE id=?", "missing-input"],
    ["UPDATE schedule_revisions SET run_id=? WHERE id=?", "missing-run"],
    ["UPDATE schedule_revisions SET data=? WHERE id=?", "x".repeat(131073)],
  ] as const)
    rollback(native, () =>
      assert.throws(
        () => native.db.prepare(sql).run(arg, registered.record.id),
        /constraint|cannot store/i,
      ),
    );
  validateScheduleDatabase(native.db);
});

test("native durable lease/due/claim dedupe precedes original producers and never reconstructs capabilities", async (t) => {
  const value = await actual(t),
    { f, native, leaseInput, lease, worker } = value,
    ports = Reflect.get(native, "ports") as ScheduleStoragePorts,
    read = ports.readWorker.bind(ports);
  let reads = 0;
  ports.readWorker = (handle) => {
    reads++;
    return read(handle);
  };
  const before = f.counts(),
    duplicateLease = native.acquireLease({}, leaseInput);
  assert.equal(duplicateLease.duplicate, true);
  assert.equal(duplicateLease.lease, undefined);
  assert.equal(reads, 0);
  assert.deepEqual(f.counts(), before);
  const advanced = advance(value),
    after = f.counts(),
    beforeReads = reads;
  const duplicateDue = native.advanceDueBatch({}, {}, advanced.input);
  assert.equal(duplicateDue.duplicate, true);
  assert.equal(reads, beforeReads);
  assert.deepEqual(f.counts(), after);
  assert.equal(
    duplicateDue.occurrences[0]!.sha256,
    advanced.result.occurrences[0]!.sha256,
  );
  const occurrence = advanced.result.occurrences[0]!,
    claimInput = {
      workspaceId: f.workspace.id,
      occurrenceId: occurrence.occurrenceId,
      requestId: "claim",
      expectedRevision: occurrence.revision,
    };
  const claimed = native.claimOccurrence(worker, lease.lease!, claimInput),
    claimedCounts = f.counts(),
    claimedReads = reads;
  assert.ok(claimed.claim);
  const duplicateClaim = native.claimOccurrence({}, {}, claimInput);
  assert.equal(duplicateClaim.duplicate, true);
  assert.equal(duplicateClaim.claim, undefined);
  assert.equal(reads, claimedReads);
  assert.deepEqual(f.counts(), claimedCounts);
  assert.throws(
    () =>
      native.claimOccurrence(worker, lease.lease!, {
        ...claimInput,
        requestId: "stale-claim",
      }),
    code("SCHEDULE_CLAIM_STALE"),
  );
  assert.deepEqual(f.counts(), claimedCounts);
  assert.equal(f.requests.length, 0);
  validateScheduleDatabase(native.db);
});

test("original due cursor and occurrence writes roll back atomically on an actual SQLite commit boundary", async (t) => {
  const value = await actual(t),
    { f, native, worker, registered } = value,
    original = due(value),
    input = {
      workspaceId: f.workspace.id,
      scheduleId: value.spec.id,
      requestId: "retry-due",
      expectedRevision: registered.record.revision,
    },
    before = f.counts();
  native.db.exec(
    "CREATE TEMP TRIGGER reject_due BEFORE INSERT ON schedule_revisions WHEN NEW.kind='schedule' AND NEW.revision=2 BEGIN SELECT RAISE(ABORT,'actual due commit failure'); END",
  );
  try {
    assert.throws(
      () => native.advanceDueBatch(worker, original, input),
      /actual due commit failure/,
    );
    assert.deepEqual(f.counts(), before);
    assert.deepEqual(
      native.getSchedule(f.workspace.id, value.spec.id)!.cursor,
      registered.record.cursor,
    );
    assert.equal(native.inspectOccurrences(f.workspace.id).length, 0);
  } finally {
    native.db.exec("DROP TRIGGER reject_due");
  }
  const accepted = native.advanceDueBatch(worker, original, input);
  assert.equal(accepted.occurrences.length, 1);
  assert.equal(accepted.record.revision, 2);
  assert.equal(f.requests.length, 0);
  validateScheduleDatabase(native.db);
});

test("native promotion lookup preserves ordinary large inputs and catches accepted request ID tampering via metadata", async (t) => {
  const value = await actual(t),
    { f, native } = value;
  const accepted = f.engine.scheduler.accept({
    sessionId: f.session.id,
    requestId: "ordinary-large-input",
    prompt: "Ordinary content. ".repeat(5000),
    config: f.config,
    delivery: "queue",
  });
  const ordinary = f.engine.store.getInput(accepted.inputId);
  assert.ok(Buffer.byteLength(ordinary.prompt) > 65536);
  assert.equal(native.lookupScheduleInput(ordinary), null);
  const advanced = advance(value),
    occurrence = advanced.result.occurrences[0]!,
    claim = scheduleInvoke<ScheduleClaimResult>(
      f.engine,
      "claimScheduleOccurrence",
      value.worker,
      value.lease.lease,
      {
        workspaceId: f.workspace.id,
        occurrenceId: occurrence.occurrenceId,
        requestId: "claim",
        expectedRevision: occurrence.revision,
      },
    );
  const dispatched = scheduleInvoke<ScheduleRequestResult<TriggerOccurrence>>(
    f.engine,
    "dispatchScheduleOccurrence",
    {
      workspaceId: f.workspace.id,
      requestId: "dispatch",
      expectedRevision: claim.record.revision,
      approved: true,
      claim: claim.claim,
    },
  );
  assert.equal(dispatched.record.state, "accepted");
  const input = f.engine.store.getInput(dispatched.record.input!.inputId);
  assert.equal(
    native.lookupScheduleInput(input)!.occurrence.occurrenceId,
    occurrence.occurrenceId,
  );
  rollback(native, () => {
    const forged = { ...input, requestId: "ordinary-forged-request" };
    native.db
      .prepare("UPDATE session_inputs SET request_id=?,data=? WHERE id=?")
      .run(forged.requestId, JSON.stringify(forged), forged.id);
    assert.throws(
      () => native.lookupScheduleInput(forged),
      code("SCHEDULE_INPUT_INVALID"),
    );
  });
  assert.equal(f.requests.length, 0);
  validateScheduleDatabase(native.db);
});

test("global occurrence metadata cap rejects new due materialization before malformed foreign heads are decoded", async (t) => {
  const value = await actual(t),
    { f, native, worker, registered } = value,
    original = due(value),
    input = {
      workspaceId: f.workspace.id,
      scheduleId: value.spec.id,
      requestId: "over-global-cap",
      expectedRevision: registered.record.revision,
    };
  rollback(native, () => {
    const insert = native.db.prepare(
      "INSERT INTO schedule_heads(workspace_id,kind,entity_id,revision_id,revision,sha256) VALUES(?,'occurrence',?,?,1,?)",
    );
    for (let i = 0; i < 512; i++)
      insert.run(
        f.workspace.id,
        `cap_${i}`,
        registered.record.id,
        registered.record.sha256,
      );
    const before = f.counts();
    assert.throws(
      () => native.advanceDueBatch(worker, original, input),
      code("SCHEDULE_LIMIT"),
    );
    assert.deepEqual(f.counts(), before);
    assert.equal(f.requests.length, 0);
  });
  validateScheduleDatabase(native.db);
});

test("native descriptor-safe admission and lookup reject untrusted getters and proxies before effects", async (t) => {
  const { f, native, worker, leaseInput } = await actual(t),
    before = f.counts();
  let traps = 0;
  const getter = { ...leaseInput, requestId: "getter" };
  Object.defineProperty(getter, "ttlMs", {
    enumerable: true,
    get() {
      traps++;
      return 30000;
    },
  });
  const proxy = new Proxy(
    { ...leaseInput, requestId: "proxy" },
    {
      get() {
        traps++;
        return "trap";
      },
      has() {
        traps++;
        return true;
      },
      ownKeys() {
        traps++;
        return [];
      },
    },
  );
  assert.throws(() => native.acquireLease(worker, getter));
  assert.throws(() => native.acquireLease(worker, proxy));
  assert.throws(() =>
    native.lookupScheduleInput(proxy as unknown as InputRecord),
  );
  assert.equal(traps, 0);
  assert.deepEqual(f.counts(), before);
});

test("a claim reads the clock once and rejects a step back behind its lease", async (t) => {
  const value = await actual(t),
    { f, native, worker, lease } = value,
    occurrence = advance(value).result.occurrences[0]!,
    ports = Reflect.get(native, "ports") as ScheduleStoragePorts,
    claimInput = {
      workspaceId: f.workspace.id,
      occurrenceId: occurrence.occurrenceId,
      requestId: "claim",
      expectedRevision: occurrence.revision,
    },
    before = f.counts();
  Reflect.set(ports, "now", () => Date.parse(lease.record.createdAt) - 1000);
  assert.throws(
    () => native.claimOccurrence(worker, lease.lease!, claimInput),
    code("SCHEDULE_CLOCK_ROLLBACK"),
  );
  assert.deepEqual(f.counts(), before);
  const expiry = Date.parse(lease.record.expiresAt);
  let reads = 0;
  Reflect.set(ports, "now", () => (reads++ === 0 ? expiry - 1 : expiry + 1));
  const claimed = native.claimOccurrence(worker, lease.lease!, claimInput);
  Reflect.deleteProperty(ports, "now");
  assert.equal(claimed.record.createdAt, new Date(expiry - 1).toISOString());
  validateScheduleDatabase(native.db);
});

test("claim transitions reject a step back behind their lease and recovery stamps no earlier than the claim", async (t) => {
  const value = await actual(t),
    { f, native, worker, lease } = value,
    occurrence = advance(value).result.occurrences[0]!,
    ports = Reflect.get(native, "ports") as ScheduleStoragePorts,
    claimed = native.claimOccurrence(worker, lease.lease!, {
      workspaceId: f.workspace.id,
      occurrenceId: occurrence.occurrenceId,
      requestId: "claim",
      expectedRevision: occurrence.revision,
    }),
    before = f.counts();
  Reflect.set(ports, "now", () => Date.parse(lease.record.createdAt) - 60000);
  try {
    assert.throws(
      () =>
        scheduleInvoke(f.engine, "dispatchScheduleOccurrence", {
          workspaceId: f.workspace.id,
          requestId: "dispatch-behind-lease",
          expectedRevision: claimed.record.revision,
          approved: true,
          claim: claimed.claim,
        }),
      code("SCHEDULE_CLOCK_ROLLBACK"),
    );
    assert.deepEqual(f.counts(), before);
    native.recoverInterrupted();
  } finally {
    Reflect.deleteProperty(ports, "now");
  }
  const recovered = native.getOccurrence(
    f.workspace.id,
    occurrence.occurrenceId,
  )!;
  assert.equal(recovered.state, "uncertain");
  assert.equal(recovered.createdAt, claimed.record.createdAt);
  assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 0);
  assert.equal(f.requests.length, 0);
  validateScheduleDatabase(native.db);
});

test("ordinary appends stop while recovery and import headroom remains", async (t) => {
  const value = await actual(t),
    { f, native, worker, lease } = value,
    occurrence = advance(value).result.occurrences[0]!;
  native.claimOccurrence(worker, lease.lease!, {
    workspaceId: f.workspace.id,
    occurrenceId: occurrence.occurrenceId,
    requestId: "claim",
    expectedRevision: occurrence.revision,
  });
  rollback(native, () => {
    const rows = () =>
        Number(
          native.db
            .prepare("SELECT count(*) AS n FROM schedule_revisions")
            .get()!.n,
        ),
      used = rows(),
      insert = native.db.prepare(
        "INSERT INTO schedule_revisions(id,workspace_id,kind,entity_id,revision,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,'transition','filler',?,'filler',?,'0','0','{}')",
      );
    // Leave 7 rows: recover (2), import-disable and import-pause (4) fit; a renew (2) plus that reserve (6) does not.
    for (let i = 1; i <= 8192 - 7 - used; i++)
      insert.run(`filler-${i}`, f.workspace.id, i, `filler-${i}`);
    assert.throws(
      () =>
        native.renewLease(lease.lease!, {
          workspaceId: f.workspace.id,
          requestId: "renew",
          expectedRevision: lease.record.revision,
          ttlMs: 30000,
        }),
      code("SCHEDULE_LIMIT"),
    );
    assert.equal(rows(), 8185);
    native.recoverInterrupted();
    assert.equal(
      native.getOccurrence(f.workspace.id, occurrence.occurrenceId)!.state,
      "uncertain",
    );
    markImportedSchedulesDisabled(native.db, "a".repeat(64));
    assert.equal(
      native.getOccurrence(f.workspace.id, occurrence.occurrenceId)!.state,
      "paused-import",
    );
    assert.equal(
      native.getSchedule(f.workspace.id, value.spec.id)!.spec.enabled,
      false,
    );
  });
  validateScheduleDatabase(native.db);
});

test("only the abandon of a live claim may spend recovery and import headroom", async (t) => {
  const value = await actual(t),
    { f, native, worker, lease } = value,
    schedule = (id: string) => {
      const spec = f.spec(value.target.pin, id),
        registered = scheduleInvoke<ScheduleRequestResult<ScheduleRevision>>(
          f.engine,
          "registerSchedule",
          value.target.original,
          {
            workspaceId: f.workspace.id,
            requestId: `register-${id}`,
            expectedRevision: 0,
            spec,
          },
        );
      return advance({ ...value, spec, registered }, `advance-${id}`).result
        .occurrences[0]!;
    },
    claim = (occurrence: TriggerOccurrence) =>
      native.claimOccurrence(worker, lease.lease!, {
        workspaceId: f.workspace.id,
        occurrenceId: occurrence.occurrenceId,
        requestId: `claim-${occurrence.occurrenceId}`,
        expectedRevision: occurrence.revision,
      }),
    abandon = (claimed: ScheduleClaimResult, requestId: string) =>
      native.abandonClaim(claimed.claim!, {
        workspaceId: f.workspace.id,
        requestId,
        expectedRevision: native.getOccurrence(
          f.workspace.id,
          claimed.record.occurrenceId,
        )!.revision,
        operation: "uncertain",
        errorCode: "SCHEDULE_DISPATCH_FAILED",
      }),
    x = claim(advance(value).result.occurrences[0]!),
    y = claim(schedule("claimed")),
    z = claim(schedule("interrupted")),
    state = (claimed: ScheduleClaimResult) =>
      native.getOccurrence(f.workspace.id, claimed.record.occurrenceId)!.state;
  abandon(x, "abandon-x");
  rollback(native, () => {
    const rows = () =>
        Number(
          native.db
            .prepare("SELECT count(*) AS n FROM schedule_revisions")
            .get()!.n,
        ),
      used = rows(),
      insert = native.db.prepare(
        "INSERT INTO schedule_revisions(id,workspace_id,kind,entity_id,revision,request_scope,request_id,request_sha256,sha256,data) VALUES(?,?,'transition','filler',?,'filler',?,'0','0','{}')",
      );
    // Leave 16 rows: import-disable for 3 schedules (6), import-pause for X (2), recover and import-pause for Y and Z (8).
    for (let i = 1; i <= 8192 - 16 - used; i++)
      insert.run(`filler-${i}`, f.workspace.id, i, `filler-${i}`);
    assert.throws(() => abandon(x, "abandon-x-again"), code("SCHEDULE_LIMIT"));
    assert.equal(rows(), 8176);
    abandon(y, "abandon-y");
    assert.equal(state(y), "uncertain");
    native.recoverInterrupted();
    assert.equal(state(z), "uncertain");
    markImportedSchedulesDisabled(native.db, "a".repeat(64));
    for (const claimed of [x, y, z])
      assert.equal(state(claimed), "paused-import");
    assert.equal(rows(), 8192);
  });
  validateScheduleDatabase(native.db);
});
