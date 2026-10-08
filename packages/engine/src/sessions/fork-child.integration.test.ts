import assert from "node:assert/strict";
import test from "node:test";
import { forkFixture, forkUntil } from "./fixtures/fork.js";
import { isTerminal } from "@moodcode/contracts";
test("actual child engine consumes readonly quoted fork lineage under original live parent and real child allocation", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "held-fork-parent",
    }),
    p = f.engine.readForkPreview(o),
    release = f.hold(p.targetSessionId);
  t.after(release);
  const r = f.engine.forkConversationView({
    preview: o,
    requestId: "child-parent",
    approved: true,
    approvalFingerprint: p.sha256,
  });
  await forkUntil(
    () => f.entries.some((e) => e.sessionId === r.record.sessionId),
    "Actual parent never entered provider",
  );
  const parent = f.engine.store.getSnapshot(r.record.sessionId).runs[0]!;
  const worktree = await f.engine.children.worktrees.create(
      {
        sessionId: r.record.sessionId,
        requestId: "child-data-worktree",
        workspace: f.workspace,
        safeCheckout: true,
      },
      new AbortController().signal,
    ),
    allocation = {
      turns: 1,
      toolCalls: 1,
      outputBytes: 8192,
      durationMs: 3000,
    };
  const task = await f.engine.children.start({
    sessionId: r.record.sessionId,
    requestId: "actual-data-child",
    parentRunId: parent.id,
    worktreeId: worktree.id,
    prompt: "Read the historical evidence only",
    tools: ["read_file"],
    allocation,
  });
  const done = await f.engine.children.tasks.wait(r.record.sessionId, task.id);
  assert.equal(done.state, "completed", JSON.stringify(done));
  assert.equal(done.budget.turns, 1);
  const entry = f.entries.find(
    (e) => e.sessionId !== f.session.id && e.sessionId !== r.record.sessionId,
  )!;
  assert.ok(
    entry.messages.some((m) =>
      m.content.includes("[Inherited conversation fork quoted DATA"),
    ),
  );
  assert.ok(
    entry.messages.some((m) => m.content.includes("actual effect preserved")),
  );
  assert.deepEqual(
    entry.tools.map((t) => t.name),
    ["read_file"],
  );
  assert.equal(f.effects(), "effect\n");
  release();
  await forkUntil(
    () => isTerminal(f.engine.store.getRun(parent.id).state),
    "Parent did not settle",
  );
  assert.equal(f.engine.store.getSnapshot(r.record.sessionId).tools.length, 0);
});
