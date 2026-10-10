import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { MoodcodeEngine } from "../engine.js";
import { effectKind, signEffect } from "./effects-records.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import {
  EFFECT_BEFORE,
  EFFECT_AFTER,
  workflowEffectsFixture,
  effectsUntil,
  effectsCommand,
} from "./fixtures/effects.js";
test(
  "real model roles execute approved isolated editor, native validator, exact approved parent merge and atomic actual parent input",
  { timeout: 45000 },
  async (t) => {
    const f = await workflowEffectsFixture(t),
      before = f.engine.coordinator.getRemainingChildBudget(f.parent.runId);
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
    await f.throughValidation();
    assert.equal(f.record().state, "completed");
    assert.ok(
      before.turns >
        f.engine.coordinator.getRemainingChildBudget(f.parent.runId).turns,
    );
    assert.equal(f.childBytes(), EFFECT_AFTER);
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
    const editor = f.engine.inspectWorkflowEffect(
        f.workspace.id,
        f.record().instanceId,
        "edit",
      )!,
      validator = f.engine.inspectWorkflowEffect(
        f.workspace.id,
        f.record().instanceId,
        "validate",
      )!;
    assert.equal(editor.evidence.snapshot.tools[0]!.name, "apply_patch");
    assert.equal(validator.evidence.verification!.receipts[0]!.status, "pass");
    assert.equal(
      validator.evidence.verification!.receipts[0]!.observation!.cleanup
        .confirmed,
      true,
    );
    assert.equal(editor.state, "observed");
    const merge = await f.pendingParent("merge_workflow_stage");
    assert.equal(
      merge.preview.workflow && typeof merge.preview.workflow,
      "object",
    );
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
    assert.throws(() =>
      f.engine.approvals.decide(merge.id, "allow", "incorrect-fingerprint"),
    );
    f.engine.approvals.decide(merge.id, "allow", merge.fingerprint);
    await effectsUntil(
      () => f.engine.store.getToolCall(merge.toolCallId).state === "completed",
      "Merge did not complete",
    );
    f.engine.inspectWorkflowEffect(
      f.workspace.id,
      f.record().instanceId,
      "edit",
    );
    await f.approveParent("deliver_workflow_result");
    await effectsUntil(() => f.sourceTerminal(), "Source did not terminal");
    await effectsUntil(
      () => f.events.includes("parent-input"),
      "Parent input was not actually consumed",
    );
    await effectsUntil(
      () =>
        f.engine.store.getSnapshot(f.session.id).runs.length === 2 &&
        f.engine.store
          .getSnapshot(f.session.id)
          .runs.every((r) =>
            ["completed", "failed", "cancelled"].includes(r.state),
          ),
      "Parent input Run did not settle",
    );
    assert.equal(f.sourceBytes(), EFFECT_AFTER);
    const settled = f.engine.inspectWorkflowEffect(
      f.workspace.id,
      f.record().instanceId,
      "edit",
    )!;
    assert.equal(settled.state, "merged");
    assert.equal(settled.merge!.checkpointIds.length, 1);
    const delivery = f.engine.inspectWorkflowDelivery(
      f.workspace.id,
      f.record().instanceId,
    )!;
    assert.equal(delivery.state, "accepted");
    assert.equal(
      f.engine.store.getInput(delivery.input.inputId).state,
      "promoted",
    );
    assert.equal(f.events.filter((e) => e === "parent-input").length, 1);
    assert.equal(f.engine.children.tasks.list(f.session.id).length, 2);
    assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 1);
  },
);

test(
  "nested validator source executes genuine native verification and exact approved parent merge",
  { timeout: 45000 },
  async (t) => {
    const relative = "src/foo.ts",
      beforeBytes = "before workflow\n",
      afterBytes = "editor-approved change\n",
      beforeHash = createHash("sha256").update(beforeBytes).digest("hex"),
      afterHash = createHash("sha256").update(afterBytes).digest("hex"),
      f = await workflowEffectsFixture(t, {
        sourcePath: relative,
        automaticDelivery: false,
        dbRoot: process.env.MOODCODE_WORKFLOW_EFFECTS_EVIDENCE_ROOT,
      }),
      parentPath = join(f.root, relative),
      childPath = join(f.worktree.root, relative);
    assert.equal(readFileSync(parentPath, "utf8"), beforeBytes);
    await f.throughValidation();
    assert.equal(f.record().state, "completed", JSON.stringify(f.record()));
    assert.equal(readFileSync(parentPath, "utf8"), beforeBytes);
    assert.equal(readFileSync(childPath, "utf8"), afterBytes);
    const editor = f.engine.inspectWorkflowEffect(f.workspace.id, f.record().instanceId, "edit")!,
      validator = f.engine.inspectWorkflowEffect(f.workspace.id, f.record().instanceId, "validate")!,
      patch = editor.evidence.snapshot.tools.find((tool) => tool.name === "apply_patch")!,
      patchCheckpoint = editor.evidence.checkpoints.find((checkpoint) => checkpoint.toolCallId === patch.id)!,
      nativeVerify = validator.evidence.snapshot.tools.find((tool) => tool.name === "verify_changes")!,
      receipt = validator.evidence.verification!.receipts[0]!;
    assert.equal(patch.state, "completed");
    assert.equal(patchCheckpoint.kind, "patch");
    assert.deepEqual(patchCheckpoint.files, [{
      path: relative,
      before: beforeBytes,
      after: afterBytes,
      beforeHash,
      afterHash,
    }]);
    for (const effect of [editor, validator]) {
      assert.deepEqual(effect.files.map((file) => ({ path: file.path, sha256: file.sha256 })), [
        { path: childPath, sha256: afterHash },
      ]);
    }
    assert.equal(nativeVerify.state, "completed");
    assert.equal(receipt.toolCallId, nativeVerify.id);
    assert.equal(receipt.runId, validator.completion.child.childRunId);
    assert.equal(receipt.sessionId, validator.completion.child.childSessionId);
    assert.equal(receipt.checkId, "actual-required-check");
    assert.equal(receipt.phase, "settled");
    assert.equal(receipt.status, "pass");
    assert.equal(receipt.sourceStale, false);
    assert.equal(receipt.observation!.disposition, "executed");
    assert.equal(receipt.observation!.exitCode, 0);
    assert.equal(receipt.observation!.executionComplete, true);
    assert.equal(receipt.observation!.cleanup.confirmed, true);
    assert.ok(receipt.observation!.command.includes(JSON.stringify(relative)));
    assert.deepEqual(receipt.observation!.sourceBefore, receipt.sourceBefore);
    assert.deepEqual(receipt.observation!.sourceAfter, receipt.sourceBefore);
    assert.ok(validator.evidence.parts.some((part) =>
      part.type === "tool" && part.toolCallId === nativeVerify.id && part.state === "completed",
    ));

    const approval = await f.pendingParent("merge_workflow_stage");
    assert.equal(readFileSync(parentPath, "utf8"), beforeBytes);
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    await effectsUntil(
      () => f.engine.store.getToolCall(approval.toolCallId).state === "completed" && f.sourceTerminal(),
      "Nested source merge did not complete",
    );
    const merged = f.engine.inspectWorkflowEffect(f.workspace.id, f.record().instanceId, "edit")!,
      checkpoints = f.engine.store.listCheckpoints(f.parent.runId);
    assert.equal(readFileSync(parentPath, "utf8"), afterBytes);
    assert.equal(merged.state, "merged");
    assert.equal(merged.merge!.toolCallId, approval.toolCallId);
    assert.equal(merged.merge!.approvalId, approval.id);
    assert.equal(merged.merge!.preparedFingerprint, approval.fingerprint);
    assert.equal(merged.merge!.validatorSha256, validator.sha256);
    assert.deepEqual(merged.merge!.parentFiles.map((file) => ({ path: file.path, sha256: file.sha256 })), [
      { path: parentPath, sha256: afterHash },
    ]);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]!.toolCallId, approval.toolCallId);
    assert.deepEqual(merged.merge!.checkpointIds, [checkpoints[0]!.id]);
    assert.deepEqual(checkpoints[0]!.files, [{
      path: relative,
      before: beforeBytes,
      after: afterBytes,
      beforeHash,
      afterHash,
    }]);
    assert.equal(f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId), null);
  },
);

test(
  "denied native merge keeps parent bytes and never admits a result",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t);
    await f.throughValidation();
    await f.approveParent("merge_workflow_stage", "deny");
    await effectsUntil(() => f.sourceTerminal(), "Denied source did not stop");
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
    assert.equal(
      f.engine.inspectWorkflowEffect(
        f.workspace.id,
        f.record().instanceId,
        "edit",
      )!.state,
      "observed",
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
    assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
    assert.equal(f.events.filter((e) => e === "parent-input").length, 0);
  },
);

for (const variant of [
  "child-file",
  "child-artifact",
  "parent-head",
  "parent-preimage",
] as const)
  test(
    `native merge approval revalidates ${variant} before parent effect`,
    { timeout: 20000 },
    async (t) => {
      const f = await workflowEffectsFixture(t);
      await f.throughValidation();
      const approval = await f.pendingParent("merge_workflow_stage");
      if (variant === "child-file")
        writeFileSync(
          join(f.worktree.root, "seed.txt"),
          "changed after verification\n",
        );
      if (variant === "child-artifact") {
        const v = f.engine.inspectWorkflowEffect(
          f.workspace.id,
          f.record().instanceId,
          "validate",
        )!;
        assert.ok(v.artifacts.length);
        writeFileSync(v.artifacts[0]!.path, "changed artifact");
      }
      if (variant === "parent-preimage")
        writeFileSync(join(f.root, "seed.txt"), "concurrent parent edit\n");
      if (variant === "parent-head") {
        writeFileSync(join(f.root, "another.txt"), "separate commit");
        execFileSync("git", ["-C", f.root, "add", "another.txt"]);
        execFileSync("git", [
          "-C",
          f.root,
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--quiet",
          "-m",
          "advanced head",
        ]);
      }
      f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
      await effectsUntil(() => f.sourceTerminal(), "Stale source did not stop");
      assert.equal(
        f.sourceBytes(),
        variant === "parent-preimage"
          ? "concurrent parent edit\n"
          : EFFECT_BEFORE,
      );
      assert.equal(
        f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
        null,
      );
      assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
    },
  );

test(
  "native merge refuses shared worktree changes outside the pinned editor effect",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t);
    f.proceed.resolve();
    await f.approveParent("request_workflow_stage");
    await f.approveChild("apply_patch");
    await f.pendingParent("request_workflow_stage");
    assert.deepEqual(
      f.engine
        .inspectWorkflowEffect(f.workspace.id, f.record().instanceId, "edit")!
        .files.map((file) => file.path),
      [join(f.worktree.root, "seed.txt")],
    );
    writeFileSync(join(f.worktree.root, "extra.txt"), "validator output\n");
    await f.approveParent("request_workflow_stage");
    await f.approveChild("verify_changes");
    const merge = () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .tools.find((tool) => tool.name === "merge_workflow_stage");
    await effectsUntil(
      () => !["requested", "running", undefined].includes(merge()?.state),
      "Merge was not prepared",
    );
    assert.equal(merge()!.state, "failed");
    assert.match(merge()!.output ?? "", /WORKFLOW_VERIFICATION_SOURCE_STALE/);
    await effectsUntil(() => f.sourceTerminal(), "Stale source did not stop");
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
    assert.equal(existsSync(join(f.root, "extra.txt")), false);
    assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
    assert.equal(
      f.engine.inspectWorkflowEffect(
        f.workspace.id,
        f.record().instanceId,
        "edit",
      )!.state,
      "observed",
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
  },
);

test(
  "an editor that deletes a tracked file fails the workflow with a typed child effect error",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { editorDeletes: true });
    f.proceed.resolve();
    await f.approveParent("request_workflow_stage");
    await f.approveChild("apply_patch");
    const observe = () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .tools.find((tool) => tool.name === "observe_workflow_stage");
    await effectsUntil(
      () => !["requested", "running", undefined].includes(observe()?.state),
      "Observe did not settle",
    );
    assert.equal(existsSync(join(f.worktree.root, "seed.txt")), false);
    assert.equal(observe()!.state, "failed");
    assert.match(observe()!.output ?? "", /WORKFLOW_CHILD_EFFECT_FAILED/);
    assert.equal(f.record().state, "failed");
    assert.equal(
      f.engine.inspectWorkflowEffect(
        f.workspace.id,
        f.record().instanceId,
        "edit",
      ),
      null,
    );
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
  },
);

test(
  "failed genuine verification cannot become a merge or result receipt",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { failedCheck: true });
    await f.throughValidation();
    await effectsUntil(
      () => f.sourceTerminal(),
      "Failed validator source did not stop",
    );
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
    assert.equal(f.record().state, "failed");
    assert.equal(
      f.engine.inspectWorkflowEffect(
        f.workspace.id,
        f.record().instanceId,
        "validate",
      ),
      null,
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
    assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
    assert.equal(f.events.filter((e) => e === "parent-input").length, 0);
  },
);

test(
  "a denied model result delivery leaves no captured delivery target behind",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t);
    await f.throughMerge();
    await f.approveParent("deliver_workflow_result", "deny");
    await effectsUntil(() => f.sourceTerminal(), "Denied source did not stop");
    assert.equal(
      Reflect.get(Reflect.get(f.engine, "workflowEffects"), "targets").size,
      0,
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
    assert.equal(f.sourceBytes(), EFFECT_AFTER);
  },
);

test(
  "an approved model result delivery recaptures its target and refuses a parent changed since approval",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t);
    await f.throughMerge();
    const approval = await f.pendingParent("deliver_workflow_result");
    writeFileSync(join(f.root, "seed.txt"), "parent changed before delivery\n");
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    await effectsUntil(() => f.sourceTerminal(), "Stale source did not stop");
    const deliver = f.engine.store
      .getSnapshot(f.session.id)
      .tools.find((tool) => tool.name === "deliver_workflow_result")!;
    assert.equal(deliver.state, "failed");
    assert.match(deliver.output ?? "", /WORKFLOW_SOURCE_STALE/);
    assert.equal(
      Reflect.get(Reflect.get(f.engine, "workflowEffects"), "targets").size,
      0,
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
  },
);

test(
  "an approved model result delivery refuses a merged parent file deleted since approval with a typed stale error",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t);
    await f.throughMerge();
    const approval = await f.pendingParent("deliver_workflow_result");
    unlinkSync(join(f.root, "seed.txt"));
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    await effectsUntil(() => f.sourceTerminal(), "Stale source did not stop");
    const deliver = f.engine.store
      .getSnapshot(f.session.id)
      .tools.find((tool) => tool.name === "deliver_workflow_result")!;
    assert.equal(deliver.state, "failed");
    assert.match(deliver.output ?? "", /WORKFLOW_SOURCE_STALE/);
    assert.doesNotMatch(deliver.output ?? "", /ENOENT/);
    assert.equal(
      Reflect.get(Reflect.get(f.engine, "workflowEffects"), "targets").size,
      0,
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
  },
);

test(
  "Original approved host result delivery is atomic, immutable on duplicates, and source terminal receives no new execution events",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { automaticDelivery: false });
    await f.throughMerge();
    await effectsCommand(f.engine, "session.pause", {
      sessionId: f.session.id,
    });
    const sourceEvents = f.engine.store
      .readEvents(f.session.id, 0, 1024)
      .filter((e) => e.runId === f.parent.runId).length;
    const target = f.engine.captureWorkflowDeliveryTarget({
        workspaceId: f.workspace.id,
        instanceId: f.record().instanceId,
        config: f.engine.store.getRun(f.parent.runId).config,
      }),
      input = {
        workspaceId: f.workspace.id,
        requestId: "host-result",
        expectedRevision: 0 as const,
        target,
        approved: true,
      };
    assert.throws(() =>
      f.engine.deliverWorkflowResult({ ...input, approved: false }),
    );
    assert.throws(() =>
      f.engine.deliverWorkflowResult({ ...input, target: { ...target } }),
    );
    let traps = 0;
    assert.throws(() =>
      f.engine.deliverWorkflowResult(
        Object.defineProperty({ ...input }, "approved", {
          enumerable: true,
          get() {
            traps++;
            return true;
          },
        }),
      ),
    );
    assert.equal(traps, 0);
    const abort = new AbortController();
    abort.abort();
    assert.throws(() =>
      f.engine.deliverWorkflowResult({ ...input, signal: abort.signal }),
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
    const first = f.engine.deliverWorkflowResult(input),
      sha = first.record.sha256;
    (first.record as { prompt: string }).prompt = "caller mutation";
    const duplicate = f.engine.deliverWorkflowResult(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.sha256, sha);
    assert.notEqual(duplicate.record.prompt, "caller mutation");
    assert.equal(
      f.engine.store.getInput(duplicate.record.input.inputId).state,
      "pending",
    );
    assert.equal(
      f.engine.store
        .readEvents(f.session.id, 0, 1024)
        .filter((e) => e.runId === f.parent.runId).length,
      sourceEvents,
    );
    f.engine.releaseWorkflowDeliveryTarget(target);
    assert.throws(() => f.engine.readWorkflowDeliveryTarget(target));
    await effectsCommand(f.engine, "session.resume", {
      sessionId: f.session.id,
    });
    await effectsUntil(
      () => f.events.includes("parent-input"),
      "Result was not consumed",
    );
    assert.equal(f.events.filter((e) => e === "parent-input").length, 1);
  },
);

test(
  "native result receipt SQL failure rolls back Input, SessionDoc and independent events together",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { automaticDelivery: false });
    await f.throughMerge();
    await effectsCommand(f.engine, "session.pause", {
      sessionId: f.session.id,
    });
    const target = f.engine.captureWorkflowDeliveryTarget({
      workspaceId: f.workspace.id,
      instanceId: f.record().instanceId,
      config: f.engine.store.getRun(f.parent.runId).config,
    });
    const db = new DatabaseSync(f.dbPath);
    const count = () =>
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_inputs WHERE request_id LIKE 'workflow-result:%'",
          )
          .get()!.n,
      );
    db.exec(
      "CREATE TRIGGER deny_workflow_delivery BEFORE INSERT ON session_documents WHEN NEW.kind LIKE 'workflow.delivery.%' BEGIN SELECT RAISE(ABORT,'receipt fault');END",
    );
    assert.throws(() =>
      f.engine.deliverWorkflowResult({
        workspaceId: f.workspace.id,
        requestId: "sql-result",
        expectedRevision: 0,
        target,
        approved: true,
      }),
    );
    assert.equal(count(), 0);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type='workflow.result.admitted'",
          )
          .get()!.n,
      ),
      0,
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
    db.exec("DROP TRIGGER deny_workflow_delivery");
    const result = f.engine.deliverWorkflowResult({
      workspaceId: f.workspace.id,
      requestId: "sql-result",
      expectedRevision: 0,
      target,
      approved: true,
    });
    assert.equal(count(), 1);
    assert.equal(result.duplicate, false);
    db.close();
  },
);

test(
  "accepted result restart remains inert until explicit resume and never repeats child effects or merge",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { automaticDelivery: false });
    await f.throughMerge();
    const instanceId = f.record().instanceId;
    await effectsCommand(f.engine, "session.pause", {
      sessionId: f.session.id,
    });
    const target = f.engine.captureWorkflowDeliveryTarget({
        workspaceId: f.workspace.id,
        instanceId,
        config: f.engine.store.getRun(f.parent.runId).config,
      }),
      delivered = f.engine.deliverWorkflowResult({
        workspaceId: f.workspace.id,
        requestId: "restart-result",
        expectedRevision: 0,
        target,
        approved: true,
      }),
      before = f.requests.length;
    await f.engine.close();
    const closed = new MoodcodeEngine({ ...f.configuration, workflows: false });
    t.after(() => closed.close());
    assert.equal(
      closed.inspectWorkflowDelivery(f.workspace.id, instanceId)!.sha256,
      delivered.record.sha256,
    );
    assert.throws(() =>
      closed.captureWorkflowDeliveryTarget({
        workspaceId: f.workspace.id,
        instanceId,
        config: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.requests.length, before);
    await closed.close();
    const restarted = new MoodcodeEngine(f.configuration);
    t.after(() => restarted.close());
    assert.equal(
      restarted.inspectWorkflowDelivery(
        f.workspace.id,
        delivered.record.instanceId,
      )!.sha256,
      delivered.record.sha256,
    );
    await effectsCommand(restarted, "session.resume", {
      sessionId: f.session.id,
    });
    await effectsUntil(
      () =>
        restarted.store.getInput(delivered.record.input.inputId).state ===
        "promoted",
      "Result did not promote after explicit resume",
    );
    await effectsUntil(
      () => f.events.filter((e) => e === "parent-input").length === 1,
      "Restart did not consume result",
    );
    assert.equal(restarted.children.tasks.list(f.session.id).length, 2);
    assert.equal(f.sourceBytes(), EFFECT_AFTER);
  },
);

test(
  "completed workflow and accepted result export/import preserve IDs as paused history without Original authority",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { automaticDelivery: false });
    await f.throughMerge();
    await effectsCommand(f.engine, "session.pause", {
      sessionId: f.session.id,
    });
    const target = f.engine.captureWorkflowDeliveryTarget({
        workspaceId: f.workspace.id,
        instanceId: f.record().instanceId,
        config: f.engine.store.getRun(f.parent.runId).config,
      }),
      delivery = f.engine.deliverWorkflowResult({
        workspaceId: f.workspace.id,
        requestId: "archive-result",
        expectedRevision: 0,
        target,
        approved: true,
      }),
      before = f.requests.length;
    await f.engine.close();
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "archive"),
    });
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "imported"),
    });
    const engine = new MoodcodeEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
    });
    t.after(() => engine.close());
    const record = engine.inspectWorkflowDelivery(
      f.workspace.id,
      delivery.record.instanceId,
    )!;
    assert.equal(record.state, "paused-import");
    assert.equal(record.input.inputId, delivery.record.input.inputId);
    assert.equal(
      engine.inspectWorkflowEffect(
        f.workspace.id,
        delivery.record.instanceId,
        "edit",
      )!.state,
      "paused-import",
    );
    assert.throws(() =>
      engine.captureWorkflowDeliveryTarget({
        workspaceId: f.workspace.id,
        instanceId: delivery.record.instanceId,
        config: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.requests.length, before);
    assert.equal(f.sourceBytes(), EFFECT_AFTER);
  },
);

test(
  "result target preserves current parent merge bytes and releasing a copy cannot retire the Original binding",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { automaticDelivery: false });
    f.engine.releaseWorkflowModelTools({ ...f.binding });
    await f.throughMerge();
    writeFileSync(join(f.root, "seed.txt"), "parent changed after merge\n");
    assert.throws(() =>
      f.engine.captureWorkflowDeliveryTarget({
        workspaceId: f.workspace.id,
        instanceId: f.record().instanceId,
        config: f.engine.store.getRun(f.parent.runId).config,
      }),
    );
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
  },
);

test(
  "authentic model tool execution rejects SQL-matching copied context, getters, forged actor fields and released Original binding without child dispatch",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t),
      effects = Reflect.get(f.engine, "workflowEffects"),
      tools = effects.tools() as import("../ports.js").ToolDefinition[],
      tool = tools.find((t) => t.name === "request_workflow_stage")!;
    const fake = Object.defineProperty(
      {
        sessionId: f.session.id,
        runId: f.parent.runId,
        workspace: f.workspace,
      },
      "toolCallId",
      {
        enumerable: true,
        get() {
          throw new Error("copied context accessor executed");
        },
      },
    ) as unknown as import("../ports.js").ToolContext;
    await assert.rejects(
      tool.prepare(
        {
          stageId: "edit",
          requestId: "copy",
          expectedRevision: f.record().revision,
        },
        fake,
      ),
      { code: "WORKFLOW_MODEL_OWNER_STALE" },
    );
    assert.equal(f.engine.children.tasks.list(f.session.id).length, 0);
    let traps = 0;
    assert.throws(() =>
      f.engine.bindWorkflowModelTools(
        Object.defineProperty(
          { workspaceId: f.workspace.id, instanceId: f.record().instanceId },
          "instanceId",
          {
            enumerable: true,
            get() {
              traps++;
              return f.record().instanceId;
            },
          },
        ),
      ),
    );
    assert.equal(traps, 0);
    f.engine.releaseWorkflowModelTools(f.binding);
    f.proceed.resolve();
    await effectsUntil(() => f.sourceTerminal(), "Unbound source did not stop");
    assert.equal(f.engine.children.tasks.list(f.session.id).length, 0);
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
  },
);

test(
  "native merge completion CAS failure leaves physical effect uncertain and blocks result admission",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t);
    await f.throughValidation();
    const approval = await f.pendingParent("merge_workflow_stage"),
      db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TRIGGER fail_workflow_merge_receipt BEFORE UPDATE ON session_documents WHEN NEW.kind LIKE 'workflow.effect.%' AND json_extract(NEW.data,'$.state')='merged' BEGIN SELECT RAISE(ABORT,'merge receipt gap');END",
    );
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    await effectsUntil(
      () => f.sourceTerminal(),
      "Uncertain merge source did not stop",
    );
    assert.equal(f.sourceBytes(), EFFECT_AFTER);
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
    assert.ok(
      ["merge-dispatching", "uncertain"].includes(
        f.engine.inspectWorkflowEffect(
          f.workspace.id,
          f.record().instanceId,
          "edit",
        )!.state,
      ),
    );
    assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), true);
    db.close();
  },
);

test(
  "fully re-signed native merge checkpoint alteration cannot assert a completed effect or result",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { automaticDelivery: false });
    await f.throughMerge();
    const effect = f.engine.inspectWorkflowEffect(
        f.workspace.id,
        f.record().instanceId,
        "edit",
      )!,
      kind = effectKind(effect.instanceId, effect.stageId),
      doc = f.engine.store.getSessionDocument(f.session.id, kind)!,
      forged = signEffect({
        ...effect,
        revision: effect.revision + 1,
        previousSha256: effect.sha256,
        merge: {
          ...effect.merge!,
          checkpointIds: [effect.evidence.checkpoints[0]!.id],
        },
      });
    f.engine.store.putSessionDocument(
      f.session.id,
      kind,
      doc.revision,
      forged as unknown as import("@moodcode/contracts").JsonObject,
    );
    assert.throws(() =>
      f.engine.inspectWorkflowEffect(f.workspace.id, effect.instanceId, "edit"),
    );
    assert.throws(() =>
      f.engine.captureWorkflowDeliveryTarget({
        workspaceId: f.workspace.id,
        instanceId: effect.instanceId,
        config: f.engine.store.getRun(f.parent.runId).config,
      }),
    );
  },
);

test(
  "parent cancellation while merge approval is pending cannot create checkpoints or result input",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t);
    await f.throughValidation();
    const a = await f.pendingParent("merge_workflow_stage");
    await f.engine.coordinator.cancel(f.parent.runId);
    assert.throws(() =>
      f.engine.approvals.decide(a.id, "allow", a.fingerprint),
    );
    await effectsUntil(
      () => f.sourceTerminal(),
      "Cancelled parent did not terminal",
    );
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
    assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
  },
);

test(
  "native validator registration revision changes after approval preparation invalidate the parent merge",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t);
    await f.throughValidation();
    const a = await f.pendingParent("merge_workflow_stage"),
      current = f.engine.verificationChecks.capture("actual-required-check");
    Reflect.get(f.engine.verificationChecks, "entries").delete(current.id);
    const { registrationSha256, ...definition } = current;
    f.engine.registerVerificationCheck({
      ...definition,
      revision: 2,
      timeoutMs: current.timeoutMs + 1,
    });
    f.engine.approvals.decide(a.id, "allow", a.fingerprint);
    await effectsUntil(
      () => f.sourceTerminal(),
      "Changed check source did not stop",
    );
    assert.equal(f.sourceBytes(), EFFECT_BEFORE);
    assert.equal(f.engine.store.listCheckpoints(f.parent.runId).length, 0);
    assert.equal(
      f.engine.inspectWorkflowDelivery(f.workspace.id, f.record().instanceId),
      null,
    );
  },
);

test(
  "queued result rechecks exact target profile and parent files before every actual admission",
  { timeout: 20000 },
  async (t) => {
    const f = await workflowEffectsFixture(t, { automaticDelivery: false });
    await f.throughMerge();
    await effectsCommand(f.engine, "session.pause", {
      sessionId: f.session.id,
    });
    const target = f.engine.captureWorkflowDeliveryTarget({
        workspaceId: f.workspace.id,
        instanceId: f.record().instanceId,
        config: f.engine.store.getRun(f.parent.runId).config,
      }),
      delivery = f.engine.deliverWorkflowResult({
        workspaceId: f.workspace.id,
        requestId: "stale-queued-profile",
        expectedRevision: 0,
        target,
        approved: true,
      }),
      before = f.requests.length;
    f.engine.profiles.register({
      ...f.configuration.agentProfiles[0]!,
      instructions: "New host policy revision.",
    });
    await effectsCommand(f.engine, "session.resume", {
      sessionId: f.session.id,
    });
    await assert.rejects(f.engine.scheduler.wake(f.session.id), {
      code: "JOB_PROFILE_STALE",
    });
    assert.equal(
      f.engine.store.getInput(delivery.record.input.inputId).state,
      "pending",
    );
    assert.equal(f.requests.length, before);
    assert.equal(f.events.filter((e) => e === "parent-input").length, 0);
    assert.equal(f.sourceBytes(), EFFECT_AFTER);
  },
);
