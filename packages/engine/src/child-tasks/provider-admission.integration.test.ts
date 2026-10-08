import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "@moodcode/contracts";
import type { ProviderEvent, TurnRequest } from "../ports.js";
import type { ChildTaskRecord } from "./index.js";
import { waitChildProviderAdmission } from "./provider-admission.js";
import {
  CHILD_STORAGE_MIRROR_KIND,
  childStorageKind,
  validateChildStorageRecord,
} from "./storage-binding.js";
import { teamFixture, type Engine } from "../teams/fixtures/engine-team.js";

async function waitOrAbort(promise: Promise<void>, signal: AbortSignal) {
  let listener!: () => void;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        listener = resolve;
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) resolve();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

test(
  "each actual child provider first entry observes its durable running task and exact original storage admission",
  { timeout: 15000 },
  async (t) => {
    let f!: Awaited<ReturnType<typeof teamFixture>>;
    const entries: {
      taskId: string;
      childRunId: string;
      bindingSha256: string;
    }[] = [];
    f = await teamFixture(t, {
      streamChild(request: TurnRequest, signal: AbortSignal) {
        const index = Number(
          request.messages
            .find(
              (message) =>
                message.role === "user" &&
                message.content.startsWith("actual-team-child-"),
            )!
            .content.slice("actual-team-child-".length),
        );
        const configured = f.childTasks[index]!,
          child = f.children[index]!;
        const task = f.engine.children.tasks.get(f.session.id, configured.id);
        assert.equal(
          task.state,
          "running",
          "Provider entry follows the authoritative task-running commit",
        );
        assert.equal(task.childRunId, request.runId);
        const run = child.store.getRun(request.runId);
        assert.equal(run.state, "running");
        assert.notEqual(run.sessionId, task.sessionId);
        const rootRecord = validateChildStorageRecord(
          f.engine.store.getSessionDocument(
            f.session.id,
            childStorageKind(task.id),
          )!.data,
        );
        const childMirror = validateChildStorageRecord(
          child.store.getSessionDocument(
            run.sessionId,
            CHILD_STORAGE_MIRROR_KIND,
          )!.data,
        );
        assert.equal(rootRecord.binding.phase, "admitted");
        assert.equal(rootRecord.sha256, childMirror.sha256);
        assert.equal(rootRecord.binding.child.runId, request.runId);
        assert.equal(rootRecord.binding.child.sessionId, run.sessionId);
        assert.equal(rootRecord.binding.lineage.taskId, task.id);
        assert.equal(
          rootRecord.binding.lineage.taskFingerprint,
          task.fingerprint,
        );
        assert.equal(rootRecord.binding.lineage.parentRunId, task.parentRunId);
        assert.equal(rootRecord.confirmedClose, undefined);
        assert.equal(
          f.engine.children.worktrees.get(f.session.id, task.worktreeId)
            .ownerId,
          task.id,
        );
        assert.equal(
          waitChildProviderAdmission(child, signal),
          undefined,
          "Only the original admitted handle releases the provider gate",
        );
        entries.push({
          taskId: task.id,
          childRunId: run.id,
          bindingSha256: rootRecord.sha256,
        });
        return (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: "progress" };
          await waitOrAbort(f.childRelease.promise, signal);
          if (!signal.aborted) {
            yield {
              type: "text.delta",
              delta: "Observed original admitted child.",
            };
            yield { type: "finish", reason: "stop" };
          }
        })();
      },
    });
    const parent = await f.startParent();
    const first = await f.startChild(),
      second = await f.startChild();
    assert.deepEqual(
      entries.map((entry) => entry.taskId),
      [first.task.id, second.task.id],
    );
    assert.notEqual(entries[0]!.childRunId, entries[1]!.childRunId);
    assert.notEqual(entries[0]!.bindingSha256, entries[1]!.bindingSha256);
    f.childRelease.resolve();
    for (const task of [first.task, second.task]) {
      assert.equal(
        (await f.engine.children.tasks.wait(f.session.id, task.id)).state,
        "completed",
      );
      assert.equal(
        f.engine.children.worktrees.get(f.session.id, task.worktreeId).ownerId,
        undefined,
      );
      assert.ok(
        validateChildStorageRecord(
          f.engine.store.getSessionDocument(
            f.session.id,
            childStorageKind(task.id),
          )!.data,
        ).confirmedClose,
      );
    }
    f.parentRelease.resolve();
    assert.equal((await f.engine.waitForRun(parent.runId)).state, "completed");
  },
);

test(
  "parent cancellation while the actual child provider gate is held dispatches no child provider and settles cleanup",
  { timeout: 15000 },
  async (t) => {
    let childProviderEntries = 0;
    const f = await teamFixture(t, {
      streamChild() {
        childProviderEntries++;
        return (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: "finish", reason: "stop" };
        })();
      },
    });
    const parent = await f.startParent();
    const original = f.engine.store.putSessionDocument.bind(f.engine.store);
    let observed:
      { taskId: string; childRunId: string; child: Engine } | undefined;
    f.engine.store.putSessionDocument = (
      sessionId,
      kind,
      revision,
      data: JsonObject,
    ) => {
      const document = original(sessionId, kind, revision, data);
      if (
        sessionId === f.session.id &&
        kind === "engine.child_tasks" &&
        !observed
      ) {
        const task = (data.tasks as unknown as ChildTaskRecord[]).find(
          (value) => value.state === "running" && value.childRunId,
        );
        if (task) {
          const child = f.children[0]!;
          assert.ok(child);
          const held = waitChildProviderAdmission(
            child,
            child.coordinator.getRunCancellationSignal(task.childRunId!),
          );
          assert.ok(
            held,
            "Actual child Run is waiting for its original handle admission",
          );
          void held.catch(() => {});
          const rootRecord = validateChildStorageRecord(
            f.engine.store.getSessionDocument(
              f.session.id,
              childStorageKind(task.id),
            )!.data,
          );
          assert.equal(rootRecord.binding.phase, "admitted");
          assert.equal(rootRecord.binding.child.runId, task.childRunId);
          observed = { taskId: task.id, childRunId: task.childRunId!, child };
          f.engine.coordinator.cancel(parent.runId);
        }
      }
      return document;
    };
    t.after(() => {
      f.engine.store.putSessionDocument = original;
    });
    const accepted = await f.engine.startChildTask({
      sessionId: f.session.id,
      requestId: "cancel-before-original-provider-admission",
      parentRunId: parent.runId,
      worktreeId: f.engine.children.worktrees.list(f.session.id)[0]!.id,
      prompt: "actual-team-child-0",
      tools: ["read_file"],
      allocation: {
        turns: 2,
        toolCalls: 1,
        outputBytes: 4096,
        durationMs: 10000,
      },
    });
    const settled = await f.engine.children.tasks.wait(
      f.session.id,
      accepted.id,
    );
    assert.ok(
      observed,
      "The real admission commit was observed before cancellation",
    );
    assert.equal(settled.id, observed.taskId);
    assert.equal(settled.childRunId, observed.childRunId);
    assert.equal(settled.state, "cancelled", JSON.stringify(settled));
    assert.equal(settled.outcome?.usage.turns, 0);
    assert.equal(settled.outcome?.usage.toolCalls, 0);
    assert.equal(childProviderEntries, 0);
    assert.equal(
      f.requests.length,
      1,
      "Only the original parent provider iterator entered",
    );
    assert.equal((await f.engine.waitForRun(parent.runId)).state, "cancelled");
    assert.equal(
      f.engine.children.worktrees.get(f.session.id, settled.worktreeId).ownerId,
      undefined,
    );
    const rootRecord = validateChildStorageRecord(
      f.engine.store.getSessionDocument(
        f.session.id,
        childStorageKind(settled.id),
      )!.data,
    );
    assert.ok(rootRecord.confirmedClose);
    assert.equal(rootRecord.confirmedClose.bindingSha256, rootRecord.sha256);
    const parentAttemptId = f.requests[0]!.attemptId;
    assert.ok(parentAttemptId);
    const cleanup = f.engine.store.getAttemptCleanup(parentAttemptId);
    assert.equal(cleanup.state, "confirmed");
    assert.equal(cleanup.cleanupConfirmed, true);
    assert.ok(
      ["iterator-next-done", "iterator-return-done"].includes(cleanup.method!),
    );
    await observed.child.close();
    await f.engine.close();
  },
);
