import assert from "node:assert/strict";
import test from "node:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { commitFixture, gitFixture } from "./fixtures/commit.js";
import { groupExists } from "../tools/command/process-control.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  gitCommitDocumentKind,
  validateGitCommitDatabase,
} from "./commit-receipts.js";
const until = async (fn: () => boolean) => {
  const end = Date.now() + 8000;
  while (!fn()) {
    assert.ok(Date.now() < end, "Actual process boundary did not arrive");
    await delay(10);
  }
};
test(
  "real working-tree selection preserves unrelated stage and rejects overlapping user stage",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t);
    gitFixture(f.root, "restore", "--staged", "a.ts");
    const index = await readFile(join(f.root, ".git", "index")),
      original = await f.preview(undefined, "working-tree"),
      result = await f.engine.commitReviewedChanges(
        original,
        f.input(original),
      );
    assert.equal(result.receipt.state, "committed", JSON.stringify(result));
    assert.notDeepEqual(await readFile(join(f.root, ".git", "index")), index);
    assert.equal(gitFixture(f.root, "show", "HEAD:a.ts"), "const alpha = 2;");
    assert.equal(
      gitFixture(f.root, "diff", "--cached", "--name-only"),
      "other.ts",
    );
    assert.equal(gitFixture(f.root, "diff", "--name-only"), "");
  },
);
test(
  "commit rejects partial staging that differs from the physically verified source",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t);
    await writeFile(join(f.root, "a.ts"), "const alpha = 3;\n");
    await assert.rejects(
      f.preview(),
      (e: unknown) =>
        (e as { code: string }).code === "GIT_COMMIT_VERIFICATION_REQUIRED" ||
        (e as { code: string }).code === "GIT_COMMIT_VERIFIED_INDEX_MISMATCH",
    );
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "1");
  },
);
test(
  "actual hook cancellation and timeout join the entire process group",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    for (const mode of ["cancel", "timeout"] as const) {
      const f = await commitFixture(t, {
          timeoutMs: mode === "timeout" ? 600 : 3000,
        }),
        hook = join(f.root, ".git", "hooks", "pre-commit");
      await writeFile(
        hook,
        "#!/bin/sh\nprintf started > hook-started\nsleep 10\n",
      );
      await chmod(hook, 0o755);
      const original = await f.preview(),
        input = f.input(original),
        abort = new AbortController(),
        head = gitFixture(f.root, "rev-parse", "HEAD"),
        pending = f.engine.commitReviewedChanges(original, input, abort.signal);
      await until(() => existsSync(join(f.root, "hook-started")));
      if (mode === "cancel") abort.abort();
      const result = await pending;
      assert.equal(
        result.receipt.state,
        mode === "cancel" ? "cancelled" : "failed",
        JSON.stringify(result),
      );
      assert.equal(result.receipt.outcome!.cleanupConfirmed, true);
      assert.equal(groupExists(result.receipt.outcome!.groupPid!), false);
      assert.equal(gitFixture(f.root, "rev-parse", "HEAD"), head);
      assert.equal(
        (await f.engine.commitReviewedChanges({}, input)).kind,
        "duplicate",
      );
    }
  },
);
test(
  "actual commit followed by native receipt SQL failure remains uncertain and reconciles without another commit",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      original = await f.preview(),
      input = f.input(original),
      db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    db.exec(
      "CREATE TRIGGER fail_commit_receipt BEFORE UPDATE ON session_documents WHEN NEW.kind LIKE 'git.commit.%' AND json_extract(NEW.data,'$.state')='committed' BEGIN SELECT RAISE(ABORT,'actual receipt fault'); END",
    );
    const result = await f.engine.commitReviewedChanges(original, input);
    assert.equal(result.receipt.state, "uncertain", JSON.stringify(result));
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "2");
    assert.equal(f.engine.store.hasUncertainGitCommit(f.workspace.id), true);
    assert.equal(
      (await f.engine.commitReviewedChanges({}, input)).kind,
      "duplicate",
    );
    db.exec("DROP TRIGGER fail_commit_receipt");
    const reconciled = await f.engine.reconcileGitCommit({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      requestId: input.requestId,
      expectedRevision: result.receipt.revision,
    });
    assert.equal(reconciled.state, "committed");
    assert.equal(reconciled.reconciled, true);
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "2");
    assert.equal(f.engine.store.hasUncertainGitCommit(f.workspace.id), false);
  },
);
test(
  "native preparation SQL rollback, budget, CAS, message and caller descriptor mutations perform no Git commit",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    db.exec(
      "CREATE TRIGGER fail_preview BEFORE INSERT ON session_documents WHEN NEW.kind LIKE 'git.commit.%' BEGIN SELECT RAISE(ABORT,'actual preparation fault'); END",
    );
    await assert.rejects(f.preview());
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type='git.commit.transition'",
          )
          .get()!.n,
      ),
      0,
    );
    db.exec("DROP TRIGGER fail_preview");
    const original = await f.preview(),
      input = f.input(original);
    for (const changed of [
      { ...input, expectedRevision: 2 },
      { ...input, message: "changed approval" },
      { ...input, previewSha256: "0".repeat(64) },
    ])
      assert.throws(() =>
        f.engine.commitReviewedChanges(original, changed as never),
      );
    const p = f.engine.readGitCommitPreview(original);
    p.message = "caller clone changed";
    (p.paths as string[])[0] = "other.ts";
    assert.equal(
      f.engine.readGitCommitPreview(original).message,
      "Reviewed alpha change\n",
    );
    const result = await f.engine.commitReviewedChanges(original, input);
    assert.equal(result.receipt.state, "committed");
    assert.equal(
      gitFixture(f.root, "show", "HEAD:other.ts"),
      "const other = 1;",
    );
  },
);
test(
  "archive preserves genuine immutable commits while imported heads pause and have no execution Original",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      original = await f.preview(),
      input = f.input(original),
      result = await f.engine.commitReviewedChanges(original, input);
    await f.engine.close();
    const archive = await exportEngineArchive({
        dbPath: f.dbPath,
        artifactDir: f.artifactDir,
        destination: join(f.base, "archive"),
      }),
      imported = await importEngineArchive({
        directory: archive.directory,
        destination: join(f.base, "imported"),
      });
    const engine = createEngine({
      ...f.config,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
    });
    t.after(() => engine.close());
    const r = engine.getGitCommitReceipt(
      f.workspace.id,
      f.session.id,
      input.requestId,
    )!;
    assert.equal(r.state, "paused-import");
    assert.deepEqual(r.outcome, result.receipt.outcome);
    assert.equal(r.preview.sha256, result.receipt.preview.sha256);
    assert.equal(
      (await engine.commitReviewedChanges({}, input)).kind,
      "duplicate",
    );
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "2");
  },
);
test(
  "self-consistent changed receipt and document digest still contradict actual immutable outcome anchor",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      original = await f.preview(),
      input = f.input(original);
    await f.engine.commitReviewedChanges(original, input);
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    const kind = gitCommitDocumentKind(input.requestId);
    db.exec("SAVEPOINT proof_probe");
    try {
      const r = JSON.parse(
        String(
          db
            .prepare(
              "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
            )
            .get(f.session.id, kind)!.data,
        ),
      );
      r.outcome.supervisorPid++;
      const { sha256, ...body } = r;
      r.sha256 = knowledgeHash(body);
      db.prepare(
        "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
      ).run(JSON.stringify(r), f.session.id, kind);
      assert.throws(() => validateGitCommitDatabase(db));
    } finally {
      db.exec("ROLLBACK TO proof_probe; RELEASE proof_probe");
    }
    validateGitCommitDatabase(db);
  },
);
for (const fault of ["supervisor", "dispatch", "process"] as const)
  test(
    `native ${fault} admission fault holds lease until actual supervisor closes`,
    { skip: process.platform === "win32", timeout: 30000 },
    async (t) => {
      const f = await commitFixture(t),
        original = await f.preview(),
        input = f.input(original),
        db = new DatabaseSync(f.dbPath);
      t.after(() => db.close());
      if (fault === "dispatch")
        db.exec(
          "CREATE TRIGGER fail_admit BEFORE UPDATE ON session_documents WHEN NEW.kind LIKE 'git.commit.%' AND json_extract(NEW.data,'$.state')='dispatched' BEGIN SELECT RAISE(ABORT,'dispatch fault'); END",
        );
      else
        db.exec(
          `CREATE TRIGGER fail_admit BEFORE INSERT ON session_events WHEN NEW.type='git.commit.${fault === "supervisor" ? "supervisor" : "process"}_admitted' BEGIN SELECT RAISE(ABORT,'source fault'); END`,
        );
      const result = await f.engine.commitReviewedChanges(original, input);
      assert.equal(
        result.receipt.state,
        fault === "process" ? "uncertain" : "failed",
        JSON.stringify(result),
      );
      const { assertExecutionLockAvailable } =
        await import("../tools/command/execution-lock.js");
      assert.doesNotThrow(
        () => assertExecutionLockAvailable(`${f.dbPath}.effects.sqlite`),
        "Host returned before its actual supervisor released the physical marker",
      );
      assert.equal(f.engine.store.hasActiveRuns(f.workspace.id), false);
      if (fault !== "process")
        assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "1");
      db.exec("DROP TRIGGER fail_admit");
      assert.equal(
        (await f.engine.commitReviewedChanges({}, input)).kind,
        "duplicate",
      );
    },
  );
test(
  "default-off reopen preserves readable receipts and cannot recreate preview authority",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      original = await f.preview(),
      input = f.input(original);
    await f.engine.commitReviewedChanges(original, input);
    await f.engine.close();
    const engine = createEngine({ ...f.config, gitCommits: false });
    t.after(() => engine.close());
    assert.equal(
      engine.getGitCommitReceipt(f.workspace.id, f.session.id, input.requestId)!
        .state,
      "committed",
    );
    assert.throws(
      () =>
        engine.previewGitCommit({
          sessionId: f.session.id,
          requestId: "disabled",
          runId: f.run.id,
          paths: ["a.ts"],
          message: "disabled",
          selection: "staged",
        }),
      (e: unknown) =>
        (e as { code: string }).code === "GIT_COMMITS_UNSUPPORTED",
    );
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "2");
  },
);
test(
  "actual commit-msg mutation remains an honest unknown receipt and never repeats the commit",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      hook = join(f.root, ".git", "hooks", "commit-msg");
    await writeFile(
      hook,
      '#!/bin/sh\nprintf "Hook changed message\\n" > "$1"\n',
    );
    await chmod(hook, 0o755);
    const original = await f.preview(),
      input = f.input(original),
      result = await f.engine.commitReviewedChanges(original, input);
    assert.equal(result.receipt.state, "uncertain");
    assert.equal(result.receipt.outcome!.message, "Hook changed message\n");
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "2");
    await assert.rejects(
      f.engine.reconcileGitCommit({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        requestId: input.requestId,
        expectedRevision: result.receipt.revision,
      }),
      (e: unknown) =>
        (e as { code: string }).code === "GIT_COMMIT_RECONCILIATION_CONFLICT",
    );
    assert.equal(
      (await f.engine.commitReviewedChanges({}, input)).kind,
      "duplicate",
    );
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "2");
  },
);
test(
  "physical workspace lease prevents a concurrent coding Run while approved Git hook owns its process",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      hook = join(f.root, ".git", "hooks", "pre-commit");
    await writeFile(
      hook,
      "#!/bin/sh\nprintf started > lease-hook-started\nsleep 1\n",
    );
    await chmod(hook, 0o755);
    const original = await f.preview(),
      input = f.input(original),
      pending = f.engine.commitReviewedChanges(original, input);
    await until(() => existsSync(join(f.root, "lease-hook-started")));
    await assert.rejects(
      f.engine.previewGitCommit({
        sessionId: f.session.id,
        requestId: "second",
        runId: f.run.id,
        paths: ["a.ts"],
        message: "second",
        selection: "staged",
      }),
      (e: unknown) =>
        (e as { code: string }).code === "WORKSPACE_BUSY" ||
        (e as { code: string }).code === "CLEANUP_PENDING",
    );
    const result = await f.engine.dispatch({
      schemaVersion: 1,
      commandId: "concurrent-code",
      type: "run.submit",
      payload: {
        sessionId: f.session.id,
        requestId: "during-git-hook",
        prompt: "Cannot overlap the Git effect",
      },
    });
    assert.equal(result.ok, false);
    assert.equal((await pending).receipt.state, "committed");
  },
);
test(
  "native acceptance proof requires the actual terminal verification Run, approval, ToolPart and checkpoint",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      original = await f.preview(),
      input = f.input(original);
    await f.engine.commitReviewedChanges(original, input);
    const p = f.engine.getGitCommitReceipt(
        f.workspace.id,
        f.session.id,
        input.requestId,
      )!.preview,
      db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    for (const mutate of [
      () =>
        db
          .prepare(
            "UPDATE runs SET state='running',data=json_set(data,'$.state','running') WHERE id=?",
          )
          .run(p.runId),
      () =>
        db
          .prepare(
            "UPDATE approvals SET status='denied',data=json_set(data,'$.status','denied') WHERE tool_call_id=?",
          )
          .run(p.verification[0]!.toolCallId),
      () =>
        db
          .prepare(
            "DELETE FROM message_parts WHERE json_extract(data,'$.toolCallId')=?",
          )
          .run(p.verification[0]!.toolCallId),
      () =>
        db
          .prepare(
            "UPDATE checkpoints SET data=json_set(data,'$.incomplete',json('true')) WHERE id=?",
          )
          .run(p.verification[0]!.observation!.executionCheckpointId),
    ]) {
      db.exec("SAVEPOINT actual_verification_proof");
      try {
        mutate();
        assert.throws(() => validateGitCommitDatabase(db));
      } finally {
        db.exec(
          "ROLLBACK TO actual_verification_proof; RELEASE actual_verification_proof",
        );
      }
    }
    validateGitCommitDatabase(db);
  },
);
