import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateChildStorageRecord,
  childStorageKind,
} from "../child-tasks/storage-binding.js";
import { batchFixture, batchCommand, batchUntil } from "./fixtures/batch.js";

test("two genuine independent coding cases reserve fairly, verify/review and exact approved selection merges once and consumes inbox", async (t) => {
  const f = await batchFixture(t);
  f.approveChildren();
  const before = f.engine.coordinator.getRemainingChildBudget(f.parent.runId),
    preview = await f.engine.previewCodingAttemptGroup(f.input),
    group = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "group-start",
      approved: true,
      preview,
    }),
    after = f.engine.coordinator.getRemainingChildBudget(f.parent.runId);
  assert.equal(before.turns - after.turns, 18);
  assert.equal(before.toolCalls - after.toolCalls, 12);
  assert.equal(before.outputBytes - after.outputBytes, 98304);
  const completed = await f.engine.runCodingAttemptGroup({
    workspaceId: f.workspace.id,
    groupId: group.groupId,
    requestId: "run",
    expectedRevision: group.revision,
    approved: true,
  });
  assert.equal(completed.state, "ready");
  assert.deepEqual(
    completed.cases.map((c) => c.state),
    ["verified", "verified"],
  );
  assert.equal(f.children.length, 6);
  const storage = f.engine.children.tasks
    .list(f.session.id)
    .map((t) =>
      validateChildStorageRecord(
        f.engine.store.getSessionDocument(f.session.id, childStorageKind(t.id))!
          .data,
      ),
    );
  assert.equal(
    new Set(storage.map((s) => s.binding.physical.database.path)).size,
    6,
  );
  assert.equal(
    new Set(storage.map((s) => s.binding.physical.artifacts.path)).size,
    6,
  );
  const actualTasks = f.engine.children.tasks.list(f.session.id);
  assert.equal(actualTasks.filter((c) => c.state === "completed").length, 6);
  assert.equal(
    new Set(
      actualTasks
        .filter((c) => c.toolNames.includes("apply_patch"))
        .map((c) => c.worktreeId),
    ).size,
    2,
  );
  writeFileSync(join(f.root, "unrelated.txt"), "staged unrelated\n");
  execFileSync("git", ["-C", f.root, "add", "unrelated.txt"]);
  const staged = execFileSync("git", [
    "-C",
    f.root,
    "diff",
    "--cached",
  ]).toString();
  const selection = await f.engine.previewCodingAttemptSelection({
    workspaceId: f.workspace.id,
    groupId: group.groupId,
    caseId: "A",
    expectedRevision: completed.revision,
  });
  assert.throws(() =>
    f.engine.selectCodingAttempt({
      workspaceId: f.workspace.id,
      requestId: "select",
      approved: true,
      preview: structuredClone(selection),
    }),
  );
  const selected = f.engine.selectCodingAttempt({
    workspaceId: f.workspace.id,
    requestId: "select",
    approved: true,
    preview: selection,
  });
  assert.equal(selected.selection?.state, "selected");
  f.releaseParent(selected.cases[0]!.instanceId);
  await f.approveMerge();
  assert.equal((await f.finish()).state, "completed");
  const merged = f.engine.inspectBatchEvidence(f.workspace.id, group.groupId);
  assert.equal(merged.state, "completed");
  assert.equal(merged.selection?.state, "merged");
  assert.equal(readFileSync(join(f.root, "seed.txt"), "utf8"), "candidate A\n");
  assert.equal(
    readFileSync(join(f.worktrees[2]!.root, "seed.txt"), "utf8"),
    "candidate B\n",
  );
  assert.equal(
    execFileSync("git", ["-C", f.root, "diff", "--cached"]).toString(),
    staged,
  );
  const sourceEvents = f.engine.store
    .readEvents(f.session.id, 0, 1024)
    .filter((e) => e.runId === f.parent.runId).length;
  await batchCommand(f.engine, "session.pause", { sessionId: f.session.id });
  const target = f.engine.captureCodingBatchDeliveryTarget({
    workspaceId: f.workspace.id,
    groupId: group.groupId,
    config: f.run.config,
  });
  const receipt = f.engine.deliverCodingBatchResult({
    workspaceId: f.workspace.id,
    groupId: group.groupId,
    requestId: "delivery",
    expectedRevision: 0,
    approved: true,
    target,
  });
  assert.equal(receipt.record.input.state, "pending");
  assert.equal(
    f.engine.deliverCodingBatchResult({
      workspaceId: f.workspace.id,
      groupId: group.groupId,
      requestId: "delivery",
      expectedRevision: 0,
      approved: true,
      target,
    }).duplicate,
    true,
  );
  assert.equal(
    f.engine.store
      .readEvents(f.session.id, 0, 1024)
      .filter((e) => e.runId === f.parent.runId).length,
    sourceEvents,
  );
  await batchCommand(f.engine, "session.resume", { sessionId: f.session.id });
  await batchUntil(
    () =>
      f.requests.some((r) =>
        r.messages.some((m) =>
          m.content.startsWith("[Moodcode workflow result DATA v1]"),
        ),
      ),
    "actual result provider consumption",
  );
  assert.equal(
    f.engine.store
      .listInputs(f.session.id)
      .inputs.filter((i) => i.requestId.startsWith("workflow-result:")).length,
    1,
  );
});

test("a genuine failed verification remains partial failure while an independent candidate is verified; no ID-only success or failed replay", async (t) => {
  const f = await batchFixture(t, { failedCase: "B" });
  f.approveChildren();
  const preview = await f.engine.previewCodingAttemptGroup(f.input),
    group = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview,
    });
  const result = await f.engine.runCodingAttemptGroup({
    workspaceId: f.workspace.id,
    groupId: group.groupId,
    requestId: "run",
    expectedRevision: group.revision,
    approved: true,
  });
  assert.deepEqual(
    result.cases.map((c) => c.state),
    ["verified", "failed"],
  );
  await assert.rejects(
    f.engine.previewCodingAttemptSelection({
      workspaceId: f.workspace.id,
      groupId: group.groupId,
      caseId: "B",
      expectedRevision: result.revision,
    }),
  );
  const count = f.children.length;
  await f.engine.resumeVerifiedBatch({
    workspaceId: f.workspace.id,
    groupId: group.groupId,
    requestId: "resume",
    expectedRevision: result.revision,
    approved: true,
  });
  assert.equal(f.children.length, count);
  assert.equal(
    readFileSync(join(f.root, "seed.txt"), "utf8"),
    "batch baseline\n",
  );
});

test("Original preview denial/copy/accessors/release and source/catalogue staleness admit zero children", async (t) => {
  const f = await batchFixture(t),
    preview = await f.engine.previewCodingAttemptGroup(f.input);
  assert.throws(() =>
    f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "denied",
      approved: false,
      preview,
    }),
  );
  assert.throws(() =>
    f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "copy",
      approved: true,
      preview: structuredClone(preview),
    }),
  );
  let traps = 0;
  assert.throws(() =>
    f.engine.startCodingAttemptGroup(
      Object.defineProperty(
        {
          workspaceId: f.workspace.id,
          requestId: "accessor",
          approved: true,
          preview,
        },
        "approved",
        {
          get() {
            traps++;
            return true;
          },
        },
      ),
    ),
  );
  assert.equal(traps, 0);
  writeFileSync(join(f.root, "seed.txt"), "external changed\n");
  assert.throws(() =>
    f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "stale",
      approved: true,
      preview,
    }),
  );
  assert.equal(f.children.length, 0);
  f.engine.releaseCodingAttemptHandle(preview);
  assert.throws(() =>
    f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "released",
      approved: true,
      preview,
    }),
  );
});

test("known skipped pending case is explicitly resumed with the same reserved slot; verified case is never rerun", async (t) => {
  const f = await batchFixture(t);
  f.approveChildren();
  const p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    }),
    skip = f.engine.skipCodingBatchCase({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "B",
      requestId: "skip",
      expectedRevision: g.revision,
      approved: true,
    });
  const first = await f.engine.runCodingAttemptGroup({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    requestId: "run-one",
    expectedRevision: skip.revision,
    approved: true,
  });
  assert.deepEqual(
    first.cases.map((c) => c.state),
    ["verified", "skipped"],
  );
  assert.equal(f.children.length, 3);
  const exported = f.engine.captureBatchEvidenceExport(
    f.workspace.id,
    g.groupId,
  );
  assert.equal(
    f.engine.readBatchEvidenceExport(exported).group.sha256,
    first.sha256,
  );
  const second = await f.engine.resumeVerifiedBatch({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    requestId: "resume",
    expectedRevision: first.revision,
    approved: true,
  });
  assert.deepEqual(
    second.cases.map((c) => c.state),
    ["verified", "verified"],
  );
  assert.equal(f.children.length, 6);
  assert.equal(
    second.usage.unknownUsageRequests,
    0,
    JSON.stringify(
      f.engine
        .readBatchEvidenceExport(
          f.engine.captureBatchEvidenceExport(f.workspace.id, g.groupId),
        )
        .cases.map((c) => ({
          usage: c.reviewer.attemptUsages,
          attempts: c.reviewer.attempts,
        })),
    ),
  );
  assert.equal(second.usage.measuredInputTokens, 300);
  assert.equal(second.usage.measuredOutputTokens, 200);
  assert.equal(second.usage.chargedCostMicros, 1000);
});

test("running cancellation joins actual child cleanup and pending cancellation never dispatches; no cancellation-as-success", async (t) => {
  const f = await batchFixture(t, { holdChild: true }),
    p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    });
  const running = f.engine.runCodingAttemptGroup({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    requestId: "run",
    expectedRevision: g.revision,
    approved: true,
  });
  await batchUntil(
    () =>
      f.engine.children.tasks
        .list(f.session.id)
        .filter((t) => t.state === "running").length === 2,
    "actual two owned children running",
  );
  const current = f.engine.inspectBatchEvidence(f.workspace.id, g.groupId),
    cancelled = await f.engine.cancelCodingAttemptGroup({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "cancel",
      expectedRevision: current.revision,
      approved: true,
    });
  await running;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(
    f.engine.children.tasks
      .list(f.session.id)
      .every((t) => t.state === "cancelled"),
    true,
  );
  assert.equal(
    cancelled.cases.every((c) => c.state === "cancelled"),
    true,
    JSON.stringify(cancelled.cases),
  );
  assert.equal(f.children.length, 2);
  await assert.rejects(
    f.engine.resumeVerifiedBatch({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "resume",
      expectedRevision: cancelled.revision,
      approved: true,
    }),
  );
});

test("fixed source/token/cost/concurrency ceilings reject before any actual isolated member admission", async (t) => {
  const f = await batchFixture(t);
  await assert.rejects(
    f.engine.previewCodingAttemptGroup({
      ...f.input,
      limits: { ...f.input.limits, maxTokens: 1 },
    }),
  );
  await assert.rejects(
    f.engine.previewCodingAttemptGroup({
      ...f.input,
      groupId: "cost-limit",
      cases: f.input.cases.map((c) => ({
        ...c,
        spec: { ...c.spec, id: c.spec.id + "-cost" },
      })),
      limits: { ...f.input.limits, maxCostMicros: 1 },
    }),
  );
  await assert.rejects(
    f.engine.previewCodingAttemptGroup({
      ...f.input,
      limits: { ...f.input.limits, concurrency: 5 },
    }),
  );
  await assert.rejects(
    f.engine.previewCodingAttemptGroup({
      ...f.input,
      cases: f.input.cases.map((c, i) =>
        i === 1
          ? {
              ...c,
              stageWorktrees: {
                ...c.stageWorktrees,
                review: f.input.cases[0]!.stageWorktrees.review!,
              },
            }
          : c,
      ),
    }),
  );
  assert.equal(f.children.length, 0);
});

test("selection reselect has exact revisions, reviewer score is DATA and denied native merge retains all effects", async (t) => {
  const f = await batchFixture(t);
  f.approveChildren();
  const p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    }),
    ready = await f.engine.runCodingAttemptGroup({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "run",
      expectedRevision: g.revision,
      approved: true,
    }),
    a = await f.engine.previewCodingAttemptSelection({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "A",
      expectedRevision: ready.revision,
    }),
    one = f.engine.selectCodingAttempt({
      workspaceId: f.workspace.id,
      requestId: "select-a",
      approved: true,
      preview: a,
    });
  assert.equal(
    f.engine.selectCodingAttempt({
      workspaceId: f.workspace.id,
      requestId: "select-a",
      approved: true,
      preview: a,
    }).sha256,
    one.sha256,
  );
  const b = await f.engine.previewCodingAttemptSelection({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "B",
      expectedRevision: one.revision,
    }),
    two = f.engine.selectCodingAttempt({
      workspaceId: f.workspace.id,
      requestId: "select-b",
      approved: true,
      preview: b,
    });
  assert.equal(two.selection?.revision, 2);
  assert.throws(() =>
    f.engine.selectCodingAttempt({
      workspaceId: f.workspace.id,
      requestId: "old-a",
      approved: true,
      preview: a,
    }),
  );
  f.releaseParent(two.cases[1]!.instanceId);
  await f.approveMerge("deny");
  await f.finish();
  assert.equal(
    readFileSync(join(f.root, "seed.txt"), "utf8"),
    "batch baseline\n",
  );
  assert.equal(
    f.engine.inspectBatchEvidence(f.workspace.id, g.groupId).selection?.state,
    "selected",
  );
  assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
});

test("selection changes while exact native merge approval is pending invalidate the old prepared result", async (t) => {
  const f = await batchFixture(t);
  f.approveChildren();
  const p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    }),
    ready = await f.engine.runCodingAttemptGroup({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "run",
      expectedRevision: g.revision,
      approved: true,
    }),
    a = await f.engine.previewCodingAttemptSelection({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "A",
      expectedRevision: ready.revision,
    }),
    selected = f.engine.selectCodingAttempt({
      workspaceId: f.workspace.id,
      requestId: "select-a",
      approved: true,
      preview: a,
    });
  f.releaseParent(selected.cases[0]!.instanceId);
  await batchUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some(
          (a) =>
            a.status === "pending" && a.toolName === "merge_workflow_stage",
        ),
    "actual merge waiting",
  );
  const again = await f.engine.previewCodingAttemptSelection({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    caseId: "A",
    expectedRevision: selected.revision,
  });
  f.engine.selectCodingAttempt({
    workspaceId: f.workspace.id,
    requestId: "reselect-a",
    approved: true,
    preview: again,
  });
  await f.approveMerge();
  await f.finish();
  assert.equal(
    readFileSync(join(f.root, "seed.txt"), "utf8"),
    "batch baseline\n",
  );
  assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
});

test("actual parent owner loss and exported evidence freshness never restore dispatch or reservations", async (t) => {
  const f = await batchFixture(t);
  f.approveChildren();
  const p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    });
  const skipped = f.engine.skipCodingBatchCase({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    caseId: "B",
    requestId: "skip",
    expectedRevision: g.revision,
    approved: true,
  });
  const ready = await f.engine.runCodingAttemptGroup({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "run",
      expectedRevision: skipped.revision,
      approved: true,
    }),
    data = f.engine.captureBatchEvidenceExport(f.workspace.id, g.groupId);
  const before = f.children.length;
  await f.engine.coordinator.cancel(f.parent.runId);
  await assert.rejects(
    f.engine.resumeVerifiedBatch({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "resume",
      expectedRevision: ready.revision,
      approved: true,
    }),
  );
  assert.equal(f.children.length, before);
  assert.equal(
    f.engine.readBatchEvidenceExport(data).group.sha256,
    ready.sha256,
  );
});

test("genuine provider return without cleanup confirmation leaves actual cancelled children and batch uncertain", async (t) => {
  const f = await batchFixture(t, { holdChild: true, unknownCleanup: true }),
    p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    });
  const running = f.engine.runCodingAttemptGroup({
    workspaceId: f.workspace.id,
    groupId: g.groupId,
    requestId: "run",
    expectedRevision: g.revision,
    approved: true,
  });
  await batchUntil(
    () =>
      f.engine.children.tasks
        .list(f.session.id)
        .filter((t) => t.state === "running").length === 2 &&
      f.requests.filter((r) => r.sessionId !== f.session.id).length === 2,
    "actual entered unconfirmed provider children",
  );
  const current = f.engine.inspectBatchEvidence(f.workspace.id, g.groupId),
    result = await f.engine.cancelCodingAttemptGroup({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "cancel",
      expectedRevision: current.revision,
      approved: true,
    });
  await running;
  assert.equal(result.state, "uncertain");
  assert.ok(result.cases.some((c) => c.state === "uncertain"));
  assert.ok(
    f.engine.children.tasks
      .list(f.session.id)
      .some((t) => t.state === "uncertain"),
  );
  await assert.rejects(
    f.engine.resumeVerifiedBatch({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "resume",
      expectedRevision: result.revision,
      approved: true,
    }),
  );
  assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
});

test("after export, actual changed candidate source prevents verified resume before pending case starts", async (t) => {
  const f = await batchFixture(t);
  f.approveChildren();
  const p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    }),
    skip = f.engine.skipCodingBatchCase({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "B",
      requestId: "skip",
      expectedRevision: g.revision,
      approved: true,
    }),
    ready = await f.engine.runCodingAttemptGroup({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "run",
      expectedRevision: skip.revision,
      approved: true,
    });
  f.engine.captureBatchEvidenceExport(f.workspace.id, g.groupId);
  writeFileSync(
    join(f.worktrees[0]!.root, "seed.txt"),
    "changed exported candidate\n",
  );
  const count = f.children.length;
  await assert.rejects(
    f.engine.resumeVerifiedBatch({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "resume",
      expectedRevision: ready.revision,
      approved: true,
    }),
  );
  assert.equal(f.children.length, count);
});

test("genuine absent native token usage remains unknown while request costs and actual reservations stay consumed", async (t) => {
  const f = await batchFixture(t, { unknownUsage: true });
  f.approveChildren();
  const p = await f.engine.previewCodingAttemptGroup(f.input),
    g = f.engine.startCodingAttemptGroup({
      workspaceId: f.workspace.id,
      requestId: "start",
      approved: true,
      preview: p,
    }),
    skip = f.engine.skipCodingBatchCase({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      caseId: "B",
      requestId: "skip",
      expectedRevision: g.revision,
      approved: true,
    }),
    ready = await f.engine.runCodingAttemptGroup({
      workspaceId: f.workspace.id,
      groupId: g.groupId,
      requestId: "run",
      expectedRevision: skip.revision,
      approved: true,
    });
  assert.equal(ready.cases[0]!.state, "verified");
  assert.equal(ready.usage.requests, 5);
  assert.equal(ready.usage.unknownUsageRequests, 5);
  assert.equal(ready.usage.measuredInputTokens, null);
  assert.equal(ready.usage.measuredOutputTokens, null);
  assert.equal(ready.usage.chargedCostMicros, 500);
  const e = f.engine.readBatchEvidenceExport(
    f.engine.captureBatchEvidenceExport(f.workspace.id, g.groupId),
  );
  assert.equal(
    e.cases[0]!.reviewer.attemptUsages![0]!.usage.inputTokens,
    undefined,
  );
  assert.equal(
    e.cases[0]!.reviewer.attemptUsages![0]!.usage.outputTokens,
    undefined,
  );
});
