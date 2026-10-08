import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { commitFixture, gitFixture } from "./commit.js";
const cleanups: Array<() => void | Promise<void>> = [],
  scope = {
    after(fn: () => void | Promise<void>) {
      cleanups.push(fn);
    },
  } as unknown as TestContext;
const f = await commitFixture(scope),
  boundary = process.argv[2] ?? "after";
if (boundary === "before") {
  const path = join(f.root, ".git", "hooks", "pre-commit");
  await writeFile(
    path,
    "#!/bin/sh\nprintf started > crash-hook-started\nsleep 10\n",
  );
  await chmod(path, 0o755);
}
const preview = await f.preview(),
  input = f.input(preview),
  original = f.engine.store.commitGitCommitObservation;
Reflect.set(
  f.engine.store,
  "commitGitCommitObservation",
  (...args: Parameters<typeof original>) => {
    if (
      args[1] ===
      (boundary === "before"
        ? "git.commit.process_admitted"
        : "git.commit.closed")
    ) {
      if (boundary === "before") Reflect.apply(original, f.engine.store, args);
      assert.equal(
        gitFixture(f.root, "rev-list", "--count", "HEAD"),
        boundary === "before" ? "1" : "2",
      );
      process.send?.({
        type: "ready",
        boundary,
        groupPid: args[2].groupPid ?? null,
        base: f.base,
        root: f.root,
        dbPath: f.dbPath,
        artifactDir: f.artifactDir,
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        runId: f.run.id,
        input,
        defaults: f.config.defaults,
      });
      process.kill(process.pid, "SIGSTOP");
    }
    return Reflect.apply(original, f.engine.store, args);
  },
);
await f.engine.commitReviewedChanges(preview, input);
assert.fail("Actual postcommit boundary did not stop");
