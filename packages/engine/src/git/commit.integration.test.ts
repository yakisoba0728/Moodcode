import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { commitFixture, gitFixture } from "./fixtures/commit.js";
import {
  gitCommitDocumentKind,
  validateGitCommitDatabase,
} from "./commit-receipts.js";
import { gitSha } from "./types.js";
import {
  entriesFor,
  fileBytes,
  indexProjection,
  objectOid,
} from "./commit-preview.js";
const code = (expected: string) => (error: unknown) =>
  (error as { code: string }).code === expected;
test(
  "real Git selection accepts a two-dot basename and rejects parent traversal without changing HEAD or index",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const base = await realpath(
        await mkdtemp(join(tmpdir(), "moodcode-git-path-")),
      ),
      root = join(base, "repository");
    t.after(() => t.diagnostic(`Retained actual Git path fixture: ${base}`));
    await mkdir(root);
    gitFixture(root, "init", "--quiet", "--template=");
    gitFixture(root, "config", "user.name", "Moodcode Fixture");
    gitFixture(root, "config", "user.email", "fixture@example.invalid");
    gitFixture(root, "config", "commit.gpgSign", "false");
    await writeFile(join(root, "..notes.txt"), "original notes\n");
    await writeFile(join(root, "other.txt"), "original other\n");
    await writeFile(join(base, "outside.txt"), "outside the repository\n");
    gitFixture(root, "add", ".");
    gitFixture(root, "commit", "--quiet", "-m", "Initial fixture");
    await writeFile(join(root, "..notes.txt"), "selected notes\n");
    await writeFile(join(root, "other.txt"), "unrelated staged change\n");
    gitFixture(root, "add", "..notes.txt", "other.txt");
    assert.equal(
      (await fileBytes(root, "..notes.txt"))?.toString("utf8"),
      "selected notes\n",
    );
    await assert.rejects(
      fileBytes(root, "../outside.txt"),
      code("GIT_COMMIT_PATH"),
    );
    for (const selection of ["staged", "working-tree"] as const) {
      if (selection === "working-tree")
        gitFixture(root, "restore", "--staged", "..notes.txt");
      const head = gitFixture(root, "rev-parse", "HEAD"),
        index = await readFile(join(root, ".git", "index")),
        entries = await entriesFor(
          root,
          {
            sessionId: "actual-session",
            runId: "actual-run",
            requestId: `actual-${selection}`,
            paths: ["..notes.txt"],
            message: "Selected notes",
            selection,
          },
          "sha1",
        );
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.path, "..notes.txt");
      assert.equal(
        entries[0]!.oid,
        gitFixture(root, "hash-object", "..notes.txt"),
      );
      assert.equal(gitFixture(root, "rev-parse", "HEAD"), head);
      assert.deepEqual(await readFile(join(root, ".git", "index")), index);
      assert.equal(
        gitFixture(root, "show", "HEAD:other.txt"),
        "original other",
      );
    }
  },
);
test(
  "tree and index readers reject a non-UTF-8 path instead of hashing it lossily",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-git-utf8-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    gitFixture(root, "init", "--quiet", "--template=");
    gitFixture(root, "config", "user.name", "Moodcode Fixture");
    gitFixture(root, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "a.txt"), "original\n");
    const oid = gitFixture(root, "hash-object", "-w", "a.txt");
    gitFixture(root, "add", "a.txt");
    execFileSync("git", ["-C", root, "update-index", "-z", "--index-info"], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      input: Buffer.concat([
        Buffer.from(`100644 ${oid}\tlatin1-caf`),
        Buffer.from([0xe9, 0]),
      ]),
    });
    gitFixture(root, "commit", "--quiet", "-m", "Latin-1 path");
    await writeFile(join(root, "a.txt"), "selected\n");
    gitFixture(root, "add", "a.txt");
    await assert.rejects(indexProjection(root), code("GIT_COMMIT_PATH"));
    await assert.rejects(
      entriesFor(
        root,
        {
          sessionId: "actual-session",
          runId: "actual-run",
          requestId: "actual-latin1",
          paths: ["a.txt"],
          message: "Selected",
          selection: "staged",
        },
        "sha1",
      ),
      code("GIT_COMMIT_PATH"),
    );
  },
);
test(
  "a temporary index that differs from the approved tree stops before Git commit",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t);
    await writeFile(
      join(f.root, ".git", "hooks", "post-index-change"),
      [
        "#!/bin/sh",
        'case "$GIT_INDEX_FILE" in',
        "*/git-commit-*/index)",
        '  [ -e "$GIT_INDEX_FILE.hooked" ] && exit 0',
        '  : > "$GIT_INDEX_FILE.hooked"',
        "  git update-index --add other.ts",
        "  ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const original = await f.preview(),
      result = await f.engine.commitReviewedChanges(
        original,
        f.input(original),
      );
    assert.equal(result.receipt.state, "failed", JSON.stringify(result));
    assert.equal(result.receipt.errorCode, "GIT_COMMIT_STALE");
    assert.equal(result.receipt.outcome!.started, false);
    assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "1");
  },
);
for (const selection of ["staged", "working-tree"] as const)
  test(
    `actual verified ${selection} commit accepts a two-dot basename and rejects parent traversal`,
    { skip: process.platform === "win32", timeout: 30000 },
    async (t) => {
      const f = await commitFixture(t, {
        sourcePath: "..notes.txt",
        retainEvidence: true,
      });
      if (selection === "working-tree")
        gitFixture(f.root, "restore", "--staged", "..notes.txt");
      await assert.rejects(
        f.engine.previewGitCommit({
          sessionId: f.session.id,
          requestId: "reject-parent-traversal",
          runId: f.run.id,
          paths: ["../outside.txt"],
          message: "Must not commit outside the workspace",
          selection,
        }),
        code("GIT_COMMIT_VERIFICATION_SCOPE"),
      );
      assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "1");
      const original = await f.preview(undefined, selection),
        result = await f.engine.commitReviewedChanges(
          original,
          f.input(original),
        );
      assert.equal(result.receipt.state, "committed", JSON.stringify(result));
      assert.equal(
        gitFixture(f.root, "show", "HEAD:..notes.txt"),
        "const alpha = 2;",
      );
      assert.equal(
        gitFixture(f.root, "show", "HEAD:other.ts"),
        "const other = 1;",
      );
      assert.equal(
        gitFixture(f.root, "diff", "--cached", "--name-only"),
        "other.ts",
      );
      assert.equal(gitFixture(f.root, "rev-list", "--count", "HEAD"), "2");
    },
  );
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
for (const hook of [
  "post-index-change",
  "reference-transaction",
  "pre-auto-gc",
] as const)
  test(
    `a ${hook} hook planted after preview denies effects before Git commit`,
    { skip: process.platform === "win32", timeout: 30000 },
    async (t) => {
      const f = await commitFixture(t),
        original = await f.preview(),
        input = f.input(original),
        before = gitFixture(f.root, "rev-parse", "HEAD"),
        effect = join(dirname(f.root), "hook-effect");
      await writeFile(
        join(f.root, ".git", "hooks", hook),
        `#!/bin/sh\nprintf forbidden > '${effect}'\n`,
        { mode: 0o755 },
      );
      await assert.rejects(
        f.engine.commitReviewedChanges(original, input),
        code("GIT_COMMIT_STALE"),
      );
      assert.equal(gitFixture(f.root, "rev-parse", "HEAD"), before);
      await assert.rejects(readFile(effect), code("ENOENT"));
    },
  );
test(
  "approved commit does not start automatic Git maintenance",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      effect = join(dirname(f.root), "auto-gc-effect"),
      format = gitFixture(f.root, "rev-parse", "--show-object-format") as
        "sha1" | "sha256";
    for (const [key, value] of Object.entries({
      "maintenance.auto": "true",
      "maintenance.strategy": "gc",
      "maintenance.autoDetach": "false",
      "gc.auto": "1",
      "gc.autoDetach": "false",
    }))
      gitFixture(f.root, "config", key, value);
    await writeFile(
      join(f.root, ".git", "hooks", "pre-auto-gc"),
      `#!/bin/sh\nprintf ran > '${effect}'\nexit 1\n`,
      { mode: 0o755 },
    );
    // Two loose objects under objects/17 exceed gc.auto=1's estimate.
    const blob = join(dirname(f.root), "loose-blob");
    for (let i = 0, found = 0; found < 2; i++) {
      const data = Buffer.from(`loose ${i}\n`);
      if (!objectOid("blob", data, format).startsWith("17")) continue;
      await writeFile(blob, data);
      gitFixture(f.root, "hash-object", "-w", "--no-filters", blob);
      found++;
    }
    const original = await f.preview(),
      result = await f.engine.commitReviewedChanges(
        original,
        f.input(original),
      );
    assert.equal(result.receipt.state, "committed", JSON.stringify(result));
    await assert.rejects(readFile(effect), code("ENOENT"));
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
