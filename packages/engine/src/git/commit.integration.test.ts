import assert from "node:assert/strict";
import test from "node:test";
import { chmod, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { commitFixture, gitFixture } from "./fixtures/commit.js";
import {
  gitCommitDocumentKind,
  validateGitCommitDatabase,
} from "./commit-receipts.js";
import { gitSha } from "./types.js";
const code = (expected: string) => (error: unknown) =>
  (error as { code: string }).code === expected;
test(
  "actual verified selected commit preserves the complete unrelated staged index and deduplicates without Original",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      before = gitFixture(f.root, "rev-parse", "HEAD"),
      index = await readFile(join(f.root, ".git", "index")),
      other = gitFixture(f.root, "ls-files", "-s", "other.ts"),
      original = await f.preview(),
      input = f.input(original),
      result = await f.engine.commitReviewedChanges(original, input);
    assert.equal(result.receipt.state, "committed", JSON.stringify(result));
    assert.notEqual(result.receipt.commitSha, before);
    assert.equal(gitFixture(f.root, "show", "HEAD:a.ts"), "const alpha = 2;");
    assert.equal(
      gitFixture(f.root, "show", "HEAD:other.ts"),
      "const other = 1;",
    );
    assert.deepEqual(await readFile(join(f.root, ".git", "index")), index);
    assert.equal(gitFixture(f.root, "ls-files", "-s", "other.ts"), other);
    assert.equal(
      gitFixture(f.root, "diff", "--cached", "--name-only"),
      "other.ts",
    );
    const duplicate = await f.engine.commitReviewedChanges({}, input);
    assert.equal(duplicate.kind, "duplicate");
    assert.equal(duplicate.receipt.commitSha, result.receipt.commitSha);
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "2");
    const reopened = await f.reopen();
    assert.equal(
      reopened.getGitCommitReceipt(
        f.workspace.id,
        f.session.id,
        input.requestId,
      )!.commitSha,
      result.receipt.commitSha,
    );
  },
);
test(
  "deny, copied Original, descriptor traps and changed exact request consume no commit",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      head = gitFixture(f.root, "rev-parse", "HEAD"),
      original = await f.preview(),
      input = f.input(original);
    assert.throws(
      () => f.engine.commitReviewedChanges({ ...original }, input),
      code("GIT_COMMIT_PREVIEW_OWNER_INVALID"),
    );
    let reads = 0;
    const malicious = Object.defineProperty({ ...input }, "decision", {
      get() {
        reads++;
        return "allow";
      },
      enumerable: true,
    });
    assert.throws(() => f.engine.commitReviewedChanges(original, malicious));
    assert.equal(reads, 0);
    const result = await f.engine.commitReviewedChanges(original, {
      ...input,
      decision: "deny",
    });
    assert.equal(result.receipt.state, "denied");
    assert.equal(gitFixture(f.root, "rev-parse", "HEAD"), head);
    assert.throws(
      () => f.engine.commitReviewedChanges(original, input),
      code("REQUEST_ID_CONFLICT"),
    );
  },
);
for (const drift of ["HEAD", "index", "source", "hooks"] as const)
  test(
    `exact ${drift} drift denies effects before Git commit`,
    { skip: process.platform === "win32", timeout: 30000 },
    async (t) => {
      const f = await commitFixture(t);
      if (drift === "hooks") {
        await mkdir(join(f.root, "custom-hooks"));
        gitFixture(f.root, "config", "core.hooksPath", "custom-hooks");
        await writeFile(
          join(f.root, "custom-hooks", "pre-commit"),
          "#!/bin/sh\nexit 0\n",
          { mode: 0o755 },
        );
      }
      const original = await f.preview(),
        input = f.input(original);
      if (drift === "HEAD")
        gitFixture(f.root, "commit", "--allow-empty", "-m", "Foreign drift");
      if (drift === "index") {
        await writeFile(join(f.root, "other.ts"), "const other = 3;\n");
        gitFixture(f.root, "add", "other.ts");
      }
      if (drift === "source")
        await writeFile(join(f.root, "a.ts"), "const alpha = 9;\n");
      if (drift === "hooks")
        await writeFile(
          join(f.root, "custom-hooks", "pre-commit"),
          "#!/bin/sh\nprintf forbidden > hook-effect\n",
        );
      const before = gitFixture(f.root, "rev-parse", "HEAD");
      await assert.rejects(
        f.engine.commitReviewedChanges(original, input),
        code("GIT_COMMIT_STALE"),
      );
      assert.equal(gitFixture(f.root, "rev-parse", "HEAD"), before);
    },
  );
test(
  "real rejecting hook records failure and no second commit on duplicate",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      path = join(f.root, ".git", "hooks", "pre-commit");
    await writeFile(
      path,
      "#!/bin/sh\nprintf actual-hook > hook-effect\nexit 7\n",
    );
    await chmod(path, 0o755);
    const original = await f.preview(),
      input = f.input(original),
      head = gitFixture(f.root, "rev-parse", "HEAD"),
      result = await f.engine.commitReviewedChanges(original, input);
    assert.equal(result.receipt.state, "failed", JSON.stringify(result));
    assert.equal(result.receipt.outcome!.cleanupConfirmed, true);
    assert.equal(gitFixture(f.root, "rev-parse", "HEAD"), head);
    assert.equal(
      await readFile(join(f.root, "hook-effect"), "utf8"),
      "actual-hook",
    );
    assert.equal(
      (await f.engine.commitReviewedChanges({}, input)).kind,
      "duplicate",
    );
  },
);
test(
  "native self-rehashed receipt cannot replace its immutable actual transition",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      original = await f.preview(),
      input = f.input(original);
    await f.engine.commitReviewedChanges(original, input);
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    const kind = gitCommitDocumentKind(input.requestId),
      row = db
        .prepare(
          "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
        )
        .get(f.session.id, kind)!,
      raw = String(row.data),
      r = JSON.parse(raw);
    r.commitSha = "1".repeat(40);
    const { sha256, ...body } = r;
    r.sha256 = gitSha(JSON.stringify(body));
    db.prepare(
      "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
    ).run(JSON.stringify(r), f.session.id, kind);
    assert.throws(() => validateGitCommitDatabase(db));
    db.prepare(
      "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
    ).run(raw, f.session.id, kind);
    validateGitCommitDatabase(db);
  },
);
