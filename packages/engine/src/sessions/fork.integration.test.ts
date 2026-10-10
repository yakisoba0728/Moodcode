import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isTerminal, type RunReceipt } from "@moodcode/contracts";
import {
  forkFixture,
  forkUntil,
  forkCommand,
  forkCounts,
} from "./fixtures/fork.js";
import { forkHash, signedFork } from "./fork-types.js";
import test from "node:test";
test("actual effect-preserving fork consumes frozen native history without replaying command or source approvals", async (t) => {
  const f = await forkFixture(t),
    beforeSource = f.engine.store.getSnapshot(f.session.id),
    effects = f.effects(),
    sourceEvents = f.engine.store.readSessionEvents(f.session.id, 0, 100),
    original = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    preview = f.engine.readForkPreview(original);
  const result = f.engine.forkConversationView({
    preview: original,
    requestId: "fork-one",
    approved: true,
    approvalFingerprint: preview.sha256,
  });
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(result.record.sessionId)
        .runs.some((r) => isTerminal(r.state)),
    "Fork actual Run did not settle",
  );
  const target = f.engine.store.getSnapshot(result.record.sessionId),
    run = target.runs[0]!;
  assert.equal(run.state, "completed", JSON.stringify(run));
  assert.equal(run.config.mode, "plan");
  assert.equal(target.tools.length, 0);
  assert.equal(target.approvals.length, 0);
  assert.equal(f.effects(), effects);
  const entry = f.entries.find((e) => e.sessionId === result.record.sessionId)!;
  assert.ok(
    entry.messages.some(
      (m) => m.role === "tool" && m.content.includes("actual effect preserved"),
    ),
  );
  assert.ok(entry.messages.some((m) => m.content.includes("effectsRetained")));
  assert.deepEqual(entry.tools.map((t) => t.name).sort(), [
    "glob_files",
    "list_files",
    "read_file",
    "regex_search",
    "search_files",
  ]);
  assert.deepEqual(result.record.preview.source.snapshot, beforeSource);
  assert.deepEqual(
    f.engine.store.readSessionEvents(f.session.id, 0, 100),
    sourceEvents,
  );
  const context = f.engine.store.getLatestContextRevision(
    result.record.sessionId,
  )!;
  assert.ok(
    context.sourceIds.some((id) => id.startsWith("conversation-fork:")),
  );
  assert.equal(forkHash(JSON.parse(context.text)), forkHash(entry.messages));
  const count = forkCounts(f.dbPath);
  result.record.preview.prompt = "caller mutation";
  const duplicate = f.engine.forkConversationView({
    preview: {},
    requestId: "fork-one",
    approved: true,
    approvalFingerprint: preview.sha256,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.preview.prompt, "fork-first");
  assert.deepEqual(forkCounts(f.dbPath), count);
});
test("exact Original approval denies copied handles, getter input, released previews and stale source journal with zero admission", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    count = forkCounts(f.dbPath);
  let traps = 0;
  assert.throws(
    () =>
      f.engine.forkConversationView({
        preview: { ...o },
        requestId: "copy",
        approved: true,
        approvalFingerprint: p.sha256,
      }),
    { code: "FORK_PREVIEW_INVALID" },
  );
  const value = {
    preview: o,
    requestId: "getter",
    approved: true,
    approvalFingerprint: p.sha256,
  };
  Object.defineProperty(value, "approved", {
    get() {
      traps++;
      return true;
    },
    enumerable: true,
  });
  assert.throws(() => f.engine.forkConversationView(value), {
    code: "FORK_INVALID",
  });
  assert.equal(traps, 0);
  assert.throws(
    () =>
      f.engine.forkConversationView({
        preview: o,
        requestId: "deny",
        approved: false,
        approvalFingerprint: p.sha256,
      }),
    { code: "FORK_APPROVAL_REQUIRED" },
  );
  f.engine.releaseForkPreview(o);
  assert.throws(
    () =>
      f.engine.forkConversationView({
        preview: o,
        requestId: "released",
        approved: true,
        approvalFingerprint: p.sha256,
      }),
    { code: "FORK_PREVIEW_INVALID" },
  );
  assert.deepEqual(forkCounts(f.dbPath), count);
  const fresh = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    fp = f.engine.readForkPreview(fresh);
  await f.source("later effect");
  assert.throws(
    () =>
      f.engine.forkConversationView({
        preview: fresh,
        requestId: "stale",
        approved: true,
        approvalFingerprint: fp.sha256,
      }),
    { code: "FORK_SOURCE_STALE" },
  );
});
test("earlier conversation boundary leaves later actual filesystem effects intact and starts new readonly execution", async (t) => {
  const f = await forkFixture(t);
  await f.source("later actual effect");
  const effects = f.effects(),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      throughRunId: f.first!.runId,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o);
  assert.equal(p.source.laterRunIds.length, 1);
  assert.equal(p.source.snapshot.runs.length, 1);
  const r = f.engine.forkConversationView({
    preview: o,
    requestId: randomUUID(),
    approved: true,
    approvalFingerprint: p.sha256,
  });
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(r.record.sessionId)
        .runs.some((r) => isTerminal(r.state)),
    "Earlier fork did not settle",
  );
  assert.equal(f.effects(), effects);
  assert.equal(f.engine.store.getSnapshot(r.record.sessionId).tools.length, 0);
});
test("compatible opaque history is preserved; mismatched opaque state requires explicit semantic disposition", async (t) => {
  const f = await forkFixture(t, { replay: true });
  await assert.rejects(
    f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
      config: { modelId: "other" },
    }),
    { code: "FORK_OPAQUE_MISMATCH" },
  );
  const o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    r = f.engine.forkConversationView({
      preview: o,
      requestId: "opaque-exact",
      approved: true,
      approvalFingerprint: p.sha256,
    });
  await forkUntil(
    () => f.entries.some((e) => e.sessionId === r.record.sessionId),
    "No actual exact replay entry",
  );
  assert.ok(
    f.entries
      .find((e) => e.sessionId === r.record.sessionId)!
      .messages.some((m) => m.providerReplay),
  );
  const sem = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "semantic-first",
      config: { modelId: "other" },
      disposition: "semantic",
    }),
    sp = f.engine.readForkPreview(sem),
    sr = f.engine.forkConversationView({
      preview: sem,
      requestId: "opaque-semantic",
      approved: true,
      approvalFingerprint: sp.sha256,
    });
  await forkUntil(
    () => f.entries.some((e) => e.sessionId === sr.record.sessionId),
    "No actual semantic entry",
  );
  assert.ok(
    f.entries
      .find((e) => e.sessionId === sr.record.sessionId)!
      .messages.every((m) => !m.providerReplay && !m.toolCalls),
  );
  assert.ok(r.record.preview.transcript.some((m) => m.providerReplay));
  const lineage = f.engine.readForkPreview(
    await f.engine.captureForkPreview({
      sourceSessionId: r.record.sessionId,
      prompt: "semantic-lineage",
      config: { modelId: "other" },
      disposition: "semantic",
    }),
  );
  assert.equal(lineage.parent!.sha256, r.record.sha256);
  const quoted = JSON.stringify(lineage.transcript);
  assert.ok(quoted.includes("Frozen parent lineage quoted DATA"));
  assert.ok(quoted.includes("actual effect preserved"));
  assert.ok(!quoted.includes("providerReplay"));
});
test("native fork body tamper is rejected against independent materialization receipt", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    r = f.engine.forkConversationView({
      preview: o,
      requestId: "tamper",
      approved: true,
      approvalFingerprint: p.sha256,
    });
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(r.record.sessionId)
        .runs.some((r) => isTerminal(r.state)),
    "No settled fork",
  );
  const db = new DatabaseSync(f.dbPath);
  try {
    const row = db
      .prepare(
        "SELECT data FROM session_documents WHERE session_id=? AND kind='conversation.fork.v1'",
      )
      .get(r.record.sessionId)!;
    const body = JSON.parse(String(row.data));
    body.requestId = "forged";
    delete body.sha256;
    body.sha256 = forkHash(body);
    db.prepare(
      "UPDATE session_documents SET data=? WHERE session_id=? AND kind='conversation.fork.v1'",
    ).run(JSON.stringify(body), r.record.sessionId);
    assert.throws(
      () => f.engine.inspectConversationLineage(r.record.sessionId),
      { code: "FORK_NATIVE_INVALID" },
    );
    const shapeless = JSON.parse(String(row.data));
    delete shapeless.preview.config;
    shapeless.preview = signedFork(shapeless.preview);
    shapeless.approvalFingerprint = shapeless.preview.sha256;
    db.prepare(
      "UPDATE session_documents SET data=? WHERE session_id=? AND kind='conversation.fork.v1'",
    ).run(JSON.stringify(signedFork(shapeless)), r.record.sessionId);
    assert.throws(
      () => f.engine.inspectConversationLineage(r.record.sessionId),
      { code: "FORK_NATIVE_INVALID" },
    );
    db.prepare(
      "UPDATE session_documents SET data=? WHERE session_id=? AND kind='conversation.fork.v1'",
    ).run(String(row.data), r.record.sessionId);
  } finally {
    db.close();
  }
});
test("re-signed archive records that native reads reject are refused at import preview", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    r = f.engine.forkConversationView({
      preview: o,
      requestId: "archive-shape",
      approved: true,
      approvalFingerprint: p.sha256,
    });
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(r.record.sessionId)
        .runs.some((r) => isTerminal(r.state)),
    "No settled fork",
  );
  const archive = f.engine.exportConversationForkHistory(r.record.sessionId);
  const capture = (edit: (record: any) => void) => {
    const record = structuredClone(archive.record) as any;
    edit(record);
    record.preview = signedFork(record.preview);
    record.approvalFingerprint = record.preview.sha256;
    return f.engine.captureForkImportPreview({
      workspaceId: f.workspace.id,
      archive: signedFork({ ...archive, record: signedFork(record) }),
    });
  };
  assert.ok(capture(() => {}));
  for (const edit of [
    (record: any) => (record.origin = "delegated-data"),
    (record: any) => (record.preview.depth = 0),
    (record: any) => (record.preview.config.mode = "build"),
    (record: any) => delete record.preview.config,
  ])
    assert.throws(() => capture(edit), { code: "FORK_ARCHIVE_INVALID" });
  assert.throws(
    () =>
      capture((record) => {
        record.sessionId = record.preview.targetSessionId = "forged\u0000id";
      }),
    { code: "FORK_INVALID" },
  );
});
test("subsequent write is a new actual approval; inherited approval cannot authorize new command", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    r = f.engine.forkConversationView({
      preview: o,
      requestId: "new-authority",
      approved: true,
      approvalFingerprint: p.sha256,
    });
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(r.record.sessionId)
        .runs.some((r) => isTerminal(r.state)),
    "No first readonly Run",
  );
  const effects = f.effects(),
    receipt = await forkCommand<RunReceipt>(f.engine, "run.submit", {
      sessionId: r.record.sessionId,
      requestId: "new-write",
      prompt: "write-new",
      config: JSON.parse(JSON.stringify(f.config)),
    });
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(r.record.sessionId)
        .approvals.some(
          (a) => a.runId === receipt.runId && a.status === "pending",
        ),
    "New effect missing genuine approval",
  );
  assert.equal(f.effects(), effects);
  const approval = f.engine.store
    .getSnapshot(r.record.sessionId)
    .approvals.find((a) => a.runId === receipt.runId)!;
  assert.notEqual(
    approval.id,
    f.engine.store.getSnapshot(f.session.id).approvals[0]!.id,
  );
  f.engine.approvals.decide(approval.id, "deny", approval.fingerprint);
  await forkUntil(
    () => isTerminal(f.engine.store.getRun(receipt.runId).state),
    "Denial did not settle",
  );
  assert.equal(f.effects(), effects);
});
