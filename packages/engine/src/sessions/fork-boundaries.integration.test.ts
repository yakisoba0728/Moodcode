import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { isTerminal, type RunReceipt } from "@moodcode/contracts";
import {
  forkFixture,
  forkUntil,
  forkCounts,
  forkCommand,
} from "./fixtures/fork.js";
test("actual nonterminal source and cancelled unresolved tool cannot authorize a frozen fork", async (t) => {
  const f = await forkFixture(t, { skipSource: true }),
    receipt = await forkCommand<RunReceipt>(f.engine, "run.submit", {
      sessionId: f.session.id,
      requestId: "held-source",
      prompt: "source",
      config: JSON.parse(JSON.stringify(f.config)),
    });
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some((a) => a.status === "pending"),
    "No actual pending tool",
  );
  const count = forkCounts(f.dbPath);
  await assert.rejects(
    f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork",
    }),
    { code: "FORK_SOURCE_ACTIVE" },
  );
  assert.deepEqual(forkCounts(f.dbPath), count);
  await f.engine.coordinator.cancel(receipt.runId);
  await forkUntil(
    () => isTerminal(f.engine.store.getRun(receipt.runId).state),
    "Source cancel has not reached native terminal",
  );
  await assert.rejects(
    f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork",
    }),
    { code: "FORK_CLEANUP_UNCERTAIN" },
  );
});
test("native source SQL identity alias is rejected before snapshot grant or model entry", async (t) => {
  const f = await forkFixture(t),
    db = new DatabaseSync(f.dbPath),
    calls = f.entries.length,
    count = forkCounts(f.dbPath);
  try {
    const row = db
        .prepare("SELECT id,data FROM messages WHERE session_id=? LIMIT 1")
        .get(f.session.id)!,
      body = JSON.parse(String(row.data));
    body.id = "borrowed-native-message";
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(
      JSON.stringify(body),
      row.id!,
    );
    await assert.rejects(
      f.engine.captureForkPreview({
        sourceSessionId: f.session.id,
        prompt: "forged",
      }),
      { code: "FORK_NATIVE_INVALID" },
    );
    assert.deepEqual(forkCounts(f.dbPath), count);
    assert.equal(f.entries.length, calls);
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(
      String(row.data),
      row.id!,
    );
  } finally {
    db.close();
  }
});
test("fixed context budget and late catalogue drift reject before a new actual provider or native first input", async (t) => {
  const f = await forkFixture(t),
    count = forkCounts(f.dbPath),
    calls = f.entries.length;
  await assert.rejects(
    f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork",
      config: { limits: { maxContextBytes: 1024 } },
    }),
    { code: "FORK_CONTEXT_LIMIT" },
  );
  const o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork",
    }),
    p = f.engine.readForkPreview(o);
  f.engine.profiles.register({
    id: "moodcode-conversation-fork-readonly",
    description: "changed host profile",
    instructions: "read only",
    tools: ["read_file"],
  });
  assert.throws(
    () =>
      f.engine.forkConversationView({
        preview: o,
        requestId: "stale-profile",
        approved: true,
        approvalFingerprint: p.sha256,
      }),
    { code: "FORK_PROFILE_STALE" },
  );
  assert.deepEqual(forkCounts(f.dbPath), count);
  assert.equal(f.entries.length, calls);
});
test("accepted readonly fork is fenced at real queue promotion when its pinned profile changes", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "queued-fork",
    }),
    p = f.engine.readForkPreview(o),
    wake = f.engine.scheduler.wake.bind(f.engine.scheduler);
  f.engine.scheduler.wake = async () => {};
  const r = f.engine.forkConversationView({
    preview: o,
    requestId: "queued-stale",
    approved: true,
    approvalFingerprint: p.sha256,
  });
  f.engine.scheduler.wake = wake;
  const calls = f.entries.length;
  f.engine.profiles.register({
    id: "moodcode-conversation-fork-readonly",
    description: "new revision",
    instructions: "read only",
    tools: ["read_file"],
  });
  await assert.rejects(f.engine.scheduler.wake(r.record.sessionId), {
    code: "FORK_TARGET_STALE",
  });
  assert.equal(f.entries.length, calls);
  assert.equal(
    f.engine.store.getInput(r.record.input.inputId).state,
    "pending",
  );
  assert.equal(f.engine.store.getSnapshot(r.record.sessionId).runs.length, 0);
  assert.equal(f.effects(), "effect\n");
});
test("fully changed native first input cannot rewrite the independent actual acceptance receipt", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "queued-fork",
    }),
    p = f.engine.readForkPreview(o),
    wake = f.engine.scheduler.wake.bind(f.engine.scheduler);
  f.engine.scheduler.wake = async () => {};
  const r = f.engine.forkConversationView({
    preview: o,
    requestId: "input-tamper",
    approved: true,
    approvalFingerprint: p.sha256,
  });
  f.engine.scheduler.wake = wake;
  const db = new DatabaseSync(f.dbPath);
  try {
    const row = db
      .prepare("SELECT data FROM session_inputs WHERE id=?")
      .get(r.record.input.inputId)!;
    const data = JSON.parse(String(row.data));
    data.admittedSeq += 1;
    db.prepare(
      "UPDATE session_inputs SET data=?,admitted_seq=? WHERE id=?",
    ).run(JSON.stringify(data), data.admittedSeq, r.record.input.inputId);
    assert.throws(
      () => f.engine.inspectConversationLineage(r.record.sessionId),
      { code: "FORK_NATIVE_INVALID" },
    );
    db.prepare(
      "UPDATE session_inputs SET data=?,admitted_seq=? WHERE id=?",
    ).run(String(row.data), r.record.input.admittedSeq, r.record.input.inputId);
  } finally {
    db.close();
  }
});
test("oversized current native body is rejected from metadata before history projection", async (t) => {
  const f = await forkFixture(t),
    db = new DatabaseSync(f.dbPath);
  try {
    const row = db
        .prepare("SELECT id,data FROM messages WHERE session_id=? LIMIT 1")
        .get(f.session.id)!,
      body = JSON.parse(String(row.data));
    body.content = "x".repeat(300000);
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(
      JSON.stringify(body),
      row.id!,
    );
    await assert.rejects(
      f.engine.captureForkPreview({
        sourceSessionId: f.session.id,
        prompt: "large",
      }),
      { code: "FORK_LIMIT" },
    );
    db.prepare("UPDATE messages SET data=? WHERE id=?").run(
      String(row.data),
      row.id!,
    );
  } finally {
    db.close();
  }
});
