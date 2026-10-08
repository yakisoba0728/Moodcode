import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError, type Workspace } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { validateScheduleDatabase } from "./store.js";
import type {
  ScheduleClaimResult,
  ScheduleRequestResult,
  ScheduleRevision,
  SchedulerLeaseResult,
  TriggerOccurrence,
} from "./store.js";
import {
  scheduleCommand,
  scheduleFixture,
  scheduleInvoke,
} from "./fixtures/schedule.js";

type Fixture = Awaited<ReturnType<typeof scheduleFixture>>;
type OccurrenceResult = ScheduleRequestResult<TriggerOccurrence>;
function actualOccurrence(f: Fixture) {
  const target = f.target(),
    spec = f.spec(target.pin, "native-graph", {
      trigger: {
        kind: "webhook",
        secretReference: "graph-host-secret",
        bodySchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    });
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
    ),
    worker = scheduleInvoke<object>(
      f.engine,
      "captureScheduleWorker",
      f.workspace.id,
    ),
    lease = scheduleInvoke<SchedulerLeaseResult>(
      f.engine,
      "acquireSchedulerLease",
      worker,
      {
        workspaceId: f.workspace.id,
        requestId: "lease",
        expectedRevision: 0,
        ttlMs: 30000,
      },
    ),
    trigger = scheduleInvoke<object>(f.engine, "previewScheduleWebhook", {
      workspaceId: f.workspace.id,
      scheduleId: spec.id,
      eventId: "actual-graph-event",
      data: {},
    }),
    queued = scheduleInvoke<OccurrenceResult>(
      f.engine,
      "acceptScheduleTrigger",
      trigger,
      {
        workspaceId: f.workspace.id,
        scheduleId: spec.id,
        requestId: "trigger",
        expectedScheduleRevision: registered.record.revision,
      },
    );
  return { worker, lease, queued };
}
function actualClaim(
  f: Fixture,
  selected: ReturnType<typeof actualOccurrence>,
) {
  return scheduleInvoke<ScheduleClaimResult>(
    f.engine,
    "claimScheduleOccurrence",
    selected.worker,
    selected.lease.lease,
    {
      workspaceId: f.workspace.id,
      occurrenceId: selected.queued.record.occurrenceId,
      requestId: "claim",
      expectedRevision: selected.queued.record.revision,
    },
  );
}
function signed(body: Record<string, unknown>): Record<string, unknown> {
  const { sha256: _old, ...image } = body;
  return { ...image, sha256: knowledgeHash(image) };
}
/** Rewrite every related digest/header so the test reaches semantic validation instead of a hash mismatch. */
function rewrite(
  db: DatabaseSync,
  result: ScheduleRequestResult<object>,
  changes: Record<string, unknown>,
  epoch?: string,
) {
  const record = signed({ ...structuredClone(result.record), ...changes }),
    receipt = signed({
      ...structuredClone(result.receipt),
      afterSha256: record.sha256,
    });
  if (epoch === undefined)
    db.prepare("UPDATE schedule_revisions SET sha256=?,data=? WHERE id=?").run(
      String(record.sha256),
      JSON.stringify(record),
      String(record.id),
    );
  else
    db.prepare(
      "UPDATE schedule_revisions SET sha256=?,data=?,owner_epoch=? WHERE id=?",
    ).run(
      String(record.sha256),
      JSON.stringify(record),
      epoch,
      String(record.id),
    );
  db.prepare("UPDATE schedule_revisions SET sha256=?,data=? WHERE id=?").run(
    String(receipt.sha256),
    JSON.stringify(receipt),
    String(receipt.id),
  );
  db.prepare("UPDATE schedule_heads SET sha256=? WHERE revision_id=?").run(
    String(record.sha256),
    String(record.id),
  );
  return record;
}
function rejected(db: DatabaseSync) {
  assert.throws(
    () => validateScheduleDatabase(db),
    (error: unknown) => {
      assert.ok(error instanceof EngineError, String(error));
      assert.ok(
        [
          "SCHEDULE_DATABASE_INVALID",
          "SCHEDULE_INPUT_INVALID",
          "SCHEDULE_TARGET_STALE",
        ].includes(error.code),
        error.code,
      );
      return true;
    },
  );
}

test(
  "native semantic replay rejects fully rehashed completed state on a genuine queued trigger",
  { timeout: 20000 },
  async (t) => {
    const f = await scheduleFixture(t),
      selected = actualOccurrence(f),
      db = new DatabaseSync(f.dbPath);
    try {
      validateScheduleDatabase(db);
      rewrite(db, selected.queued, { state: "completed" });
      assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 0);
      assert.equal(f.requests.length, 0);
      rejected(db);
    } finally {
      db.close();
    }
  },
);

test(
  "native semantic replay rejects a fully rehashed terminal observation for an actual pending input",
  { timeout: 20000 },
  async (t) => {
    const f = await scheduleFixture(t),
      selected = actualOccurrence(f),
      claim = actualClaim(f, selected),
      accepted = scheduleInvoke<OccurrenceResult>(
        f.engine,
        "dispatchScheduleOccurrence",
        {
          workspaceId: f.workspace.id,
          requestId: "dispatch",
          expectedRevision: claim.record.revision,
          approved: true,
          claim: claim.claim,
        },
      ),
      original = scheduleInvoke<object>(
        f.engine,
        "captureScheduleOccurrenceObservation",
        selected.worker,
        {
          workspaceId: f.workspace.id,
          occurrenceId: accepted.record.occurrenceId,
          requestId: "capture",
          expectedRevision: accepted.record.revision,
        },
      ),
      observed = scheduleInvoke<OccurrenceResult>(
        f.engine,
        "observeScheduleOccurrence",
        {
          workspaceId: f.workspace.id,
          requestId: "observe",
          expectedRevision: accepted.record.revision,
          observation: original,
        },
      ),
      db = new DatabaseSync(f.dbPath);
    try {
      validateScheduleDatabase(db);
      assert.ok(observed.record.observation);
      const contradictory = signed({
        ...observed.record.observation,
        state: "promoted",
        runId: null,
        runState: "completed",
        cleanupConfirmed: true,
      });
      rewrite(db, observed, { state: "completed", observation: contradictory });
      assert.equal(
        f.engine.store.getInput(accepted.record.input!.inputId).state,
        "pending",
      );
      assert.equal(f.counts().runs, 0);
      assert.equal(f.requests.length, 0);
      rejected(db);
    } finally {
      db.close();
    }
  },
);

test(
  "native semantic replay rejects an authentic foreign workspace worker relinked into lease and claim history",
  { timeout: 20000 },
  async (t) => {
    const f = await scheduleFixture(t),
      selected = actualOccurrence(f),
      claim = actualClaim(f, selected),
      otherRoot = join(f.base, "other-workspace");
    mkdirSync(otherRoot);
    execFileSync("git", ["init", "--quiet", "--template=", otherRoot]);
    const other = await scheduleCommand<Workspace>(f.engine, "workspace.open", {
        path: otherRoot,
      }),
      otherWorker = scheduleInvoke<object>(
        f.engine,
        "captureScheduleWorker",
        other.id,
      ),
      otherLease = scheduleInvoke<SchedulerLeaseResult>(
        f.engine,
        "acquireSchedulerLease",
        otherWorker,
        {
          workspaceId: other.id,
          requestId: "foreign-lease",
          expectedRevision: 0,
          ttlMs: 30000,
        },
      ),
      db = new DatabaseSync(f.dbPath);
    try {
      validateScheduleDatabase(db);
      assert.notEqual(otherLease.record.worker.workspaceId, f.workspace.id);
      const forgedLease = rewrite(
        db,
        selected.lease,
        { worker: otherLease.record.worker },
        otherLease.record.worker.ownerEpoch,
      );
      rewrite(
        db,
        claim,
        { worker: otherLease.record.worker, leaseSha256: forgedLease.sha256 },
        otherLease.record.worker.ownerEpoch,
      );
      assert.equal(f.engine.store.listInputs(f.session.id).inputs.length, 0);
      assert.equal(f.requests.length, 0);
      rejected(db);
    } finally {
      db.close();
    }
  },
);
