import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isTerminal,
  type RunReceipt,
  type Workspace,
} from "@moodcode/contracts";
import { MoodcodeEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import {
  forkFixture,
  forkUntil,
  forkCommand,
  forkCounts,
} from "./fixtures/fork.js";
async function settled(
  f: Awaited<ReturnType<typeof forkFixture>>,
  sessionId: string,
) {
  await forkUntil(
    () =>
      f.engine.store
        .getSnapshot(sessionId)
        .runs.some((r) => isTerminal(r.state)),
    "Fork did not settle",
  );
}
test("SQL fault rolls back Session, profile, native lineage, inbox and independent receipt before any provider wake", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    counts = forkCounts(f.dbPath),
    calls = f.entries.length,
    db = new DatabaseSync(f.dbPath);
  try {
    db.exec(
      "CREATE TRIGGER reject_fork BEFORE INSERT ON session_documents WHEN NEW.kind='conversation.fork.v1' BEGIN SELECT RAISE(ABORT,'actual fork receipt fault'); END;",
    );
    assert.throws(
      () =>
        f.engine.forkConversationView({
          preview: o,
          requestId: "rollback",
          approved: true,
          approvalFingerprint: p.sha256,
        }),
      /actual fork receipt fault/,
    );
    assert.deepEqual(forkCounts(f.dbPath), counts);
    assert.equal(f.entries.length, calls);
    assert.equal(f.engine.store.listSessions(f.workspace.id).length, 1);
    db.exec("DROP TRIGGER reject_fork");
    const r = f.engine.forkConversationView({
      preview: o,
      requestId: "rollback",
      approved: true,
      approvalFingerprint: p.sha256,
    });
    await settled(f, r.record.sessionId);
    assert.equal(forkCounts(f.dbPath).inputs, counts.inputs + 1);
  } finally {
    db.close();
  }
});
test("reopen restores history and pending input without replay, Original rebind or automatic wake", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    wake = f.engine.scheduler.wake.bind(f.engine.scheduler);
  f.engine.scheduler.wake = async () => {};
  const r = f.engine.forkConversationView({
    preview: o,
    requestId: "reopen",
    approved: true,
    approvalFingerprint: p.sha256,
  });
  f.engine.scheduler.wake = wake;
  await f.engine.close();
  const count = f.entries.length,
    off = new MoodcodeEngine({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      providers: [f.provider],
      defaults: f.config,
    });
  t.after(() => off.close());
  assert.equal(
    off.inspectConversationLineage(r.record.sessionId)!.sha256,
    r.record.sha256,
  );
  assert.equal(off.store.getInput(r.record.input.inputId).state, "pending");
  assert.equal(f.entries.length, count);
  await assert.rejects(
    off.captureForkPreview({ sourceSessionId: f.session.id, prompt: "off" }),
    { code: "FORK_DISABLED" },
  );
  await off.close();
  const enabled = new MoodcodeEngine({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    providers: [f.provider],
    defaults: f.config,
    conversationForks: true,
  });
  t.after(() => enabled.close());
  assert.throws(() => enabled.readForkPreview(o), {
    code: "FORK_PREVIEW_INVALID",
  });
  const duplicate = enabled.forkConversationView({
    preview: {},
    requestId: "reopen",
    approved: true,
    approvalFingerprint: p.sha256,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.entries.length, count);
  enabled.scheduler.resume(r.record.sessionId);
  await forkUntil(
    () =>
      enabled.store
        .getSnapshot(r.record.sessionId)
        .runs.some((r) => isTerminal(r.state)),
    "Explicit resume did not consume pending fork",
  );
  assert.equal(f.entries.length, count + 1);
  assert.equal(f.effects(), "effect\n");
});
test("target-only archive import into a different physical workspace keeps signed source IDs/hash as paused DATA with no input authority", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    r = f.engine.forkConversationView({
      preview: o,
      requestId: "archive-source",
      approved: true,
      approvalFingerprint: p.sha256,
    });
  await settled(f, r.record.sessionId);
  const archive = f.engine.exportConversationForkHistory(r.record.sessionId),
    newRoot = join(f.base, "fresh-workspace");
  mkdirSync(newRoot);
  execFileSync("git", ["init", "--quiet", "--template=", newRoot]);
  writeFileSync(join(newRoot, "seed.txt"), "different physical workspace");
  let calls = 0;
  const imported = new MoodcodeEngine({
    dbPath: join(f.base, "fresh.sqlite"),
    artifactDir: join(f.base, "fresh-artifacts"),
    providers: [
      {
        id: f.provider.id,
        async *streamTurn() {
          calls++;
          yield { type: "finish" as const, reason: "stop" as const };
        },
      },
    ],
    conversationForks: true,
  });
  t.after(() => imported.close());
  const workspace = await forkCommand<Workspace>(imported, "workspace.open", {
      path: newRoot,
    }),
    ip = imported.captureForkImportPreview({
      workspaceId: workspace.id,
      archive,
    }),
    preview = imported.readForkImportPreview(ip);
  const history = imported.importConversationForkHistory({
    preview: ip,
    requestId: "import-history",
    approved: true,
    approvalFingerprint: preview.sha256,
  });
  assert.equal(history.sha256, r.record.sha256);
  assert.deepEqual(
    imported.inspectConversationLineage(history.sessionId)!.preview.source.pins,
    r.record.preview.source.pins,
  );
  assert.equal(
    imported.store.getSession(history.sessionId).workspaceId,
    workspace.id,
  );
  assert.equal(
    imported.store.getSessionControl(history.sessionId).paused,
    true,
  );
  assert.equal(imported.store.getSnapshot(history.sessionId).runs.length, 0);
  assert.equal(imported.store.pendingInputs(history.sessionId).length, 0);
  assert.equal(calls, 0);
  assert.throws(() => imported.readForkPreview(o), {
    code: "FORK_PREVIEW_INVALID",
  });
  const native = await forkCommand<RunReceipt>(imported, "run.submit", {
    sessionId: history.sessionId,
    requestId: "cannot-rebind",
    prompt: "new execution",
    config: JSON.parse(JSON.stringify(f.config)),
  });
  await forkUntil(
    () => isTerminal(imported.store.getRun(native.runId).state),
    "Imported source did not reject dispatch",
  );
  assert.equal(
    imported.store.getRun(native.runId).error?.code,
    "FORK_IMPORT_PAUSED",
  );
  assert.equal(calls, 0);
});
test("full actual Engine archive/import pauses materialized forks and never reissues original authority", async (t) => {
  const f = await forkFixture(t),
    o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p = f.engine.readForkPreview(o),
    r = f.engine.forkConversationView({
      preview: o,
      requestId: "whole-archive",
      approved: true,
      approvalFingerprint: p.sha256,
    });
  await settled(f, r.record.sessionId);
  await f.engine.close();
  const exported = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "whole-archive"),
    }),
    archive = await importEngineArchive({
      directory: exported.directory,
      destination: join(f.base, "whole-import"),
    });
  const engine = new MoodcodeEngine({
    dbPath: archive.dbPath,
    artifactDir: archive.artifactDir,
    providers: [f.provider],
    conversationForks: true,
  });
  t.after(() => engine.close());
  assert.equal(
    engine.inspectConversationLineage(r.record.sessionId)!.sha256,
    r.record.sha256,
  );
  assert.equal(
    engine.store.getSessionDocument(
      r.record.sessionId,
      "conversation.fork.import",
    )!.data.paused,
    true,
  );
  assert.equal(engine.store.getSessionControl(r.record.sessionId).paused, true);
  assert.throws(() => engine.readForkPreview(o), {
    code: "FORK_PREVIEW_INVALID",
  });
  assert.equal(engine.store.getSnapshot(r.record.sessionId).runs.length, 1);
});
test("fork-of-fork carries bounded parent lineage into the actual third provider without duplicating native effects", async (t) => {
  const f = await forkFixture(t),
    one = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      prompt: "fork-first",
    }),
    p1 = f.engine.readForkPreview(one),
    r1 = f.engine.forkConversationView({
      preview: one,
      requestId: "parent-fork",
      approved: true,
      approvalFingerprint: p1.sha256,
    });
  await settled(f, r1.record.sessionId);
  const two = await f.engine.captureForkPreview({
      sourceSessionId: r1.record.sessionId,
      prompt: "descendant-fork",
    }),
    p2 = f.engine.readForkPreview(two);
  assert.equal(p2.depth, 2);
  assert.equal(p2.parent!.sha256, r1.record.sha256);
  const r2 = f.engine.forkConversationView({
    preview: two,
    requestId: "descendant-fork",
    approved: true,
    approvalFingerprint: p2.sha256,
  });
  await settled(f, r2.record.sessionId);
  const actual = f.entries.find((e) => e.sessionId === r2.record.sessionId)!;
  assert.ok(
    actual.messages.some(
      (m) => m.role === "tool" && m.content.includes("actual effect preserved"),
    ),
  );
  assert.ok(
    actual.messages.some(
      (m) =>
        m.content ===
        "Frozen history was consumed by the actual fork provider.",
    ),
  );
  assert.equal(f.effects(), "effect\n");
  assert.equal(f.engine.store.getSnapshot(r2.record.sessionId).tools.length, 0);
});
test("pre-created actual managed Git worktree is selected explicitly and keeps Root filesystem effects unchanged", async (t) => {
  const f = await forkFixture(t),
    worktree = await f.engine.children.worktrees.create(
      {
        sessionId: f.session.id,
        requestId: "fork-worktree",
        workspace: f.workspace,
        safeCheckout: true,
      },
      new AbortController().signal,
    ),
    workspace = await forkCommand<Workspace>(f.engine, "workspace.open", {
      path: worktree.root,
    });
  const o = await f.engine.captureForkPreview({
      sourceSessionId: f.session.id,
      targetWorkspaceId: workspace.id,
      worktreeId: worktree.id,
      prompt: "fork-worktree",
    }),
    p = f.engine.readForkPreview(o),
    r = f.engine.forkConversationView({
      preview: o,
      requestId: "fork-worktree-run",
      approved: true,
      approvalFingerprint: p.sha256,
    });
  await settled(f, r.record.sessionId);
  assert.equal(
    f.engine.store.getSession(r.record.sessionId).workspaceId,
    workspace.id,
  );
  assert.equal(p.worktree!.baseCommit, worktree.baseCommit);
  assert.equal(f.effects(), "effect\n");
  assert.equal(f.engine.store.getSnapshot(r.record.sessionId).tools.length, 0);
  assert.equal(
    f.engine.children.worktrees.get(f.session.id, worktree.id).ownerId,
    undefined,
  );
});
