import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineError } from "@moodcode/contracts";
import { gitControlPaths } from "./platform-backends.js";

const fixed = (root: string) => ({
  literal: [join(root, ".git"), join(root, ".git", "config.worktree")],
  subpath: [
    "config",
    "commondir",
    "hooks",
    "info",
    "modules",
    "rebase-merge",
    "worktrees",
  ].map((p) => join(root, ".git", p)),
});
function repository(t: TestContext) {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "moodcode-git-control-")),
  );
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "ws");
  execFileSync("git", ["init", "-q", "--template=", root]);
  const config = (key: string, value: string) =>
    execFileSync("git", ["-C", root, "config", key, value]);
  return { base, root, config };
}

test("hooksPath and include targets inside a write grant are denied with every entry on their path", (t) => {
  const { base, root, config } = repository(t);
  mkdirSync(join(root, "real", "hooks"), { recursive: true });
  symlinkSync("real", join(root, "link"));
  mkdirSync(join(base, "outside"));
  writeFileSync(
    join(base, "outside", "cond.cfg"),
    `[include]\n\tpath = ${join(root, "nested.cfg")}\n`,
  );
  config("core.hooksPath", "link/hooks");
  config("include.path", "../local.cfg");
  config("includeIf.onbranch:nomatch.path", join(base, "outside", "cond.cfg"));
  const paths = gitControlPaths(root, [root]),
    unchanged = fixed(root);
  assert.deepEqual(paths.literal.slice(0, 2), unchanged.literal);
  assert.deepEqual(paths.subpath.slice(0, 7), unchanged.subpath);
  assert.deepEqual(paths.literal.slice(2).sort(), [
    join(root, "link"),
    join(root, "real"),
  ]);
  assert.deepEqual(paths.subpath.slice(7).sort(), [
    join(root, "local.cfg"),
    join(root, "nested.cfg"),
    join(root, "real", "hooks"),
  ]);
  assert.deepEqual(gitControlPaths(root, []), unchanged);
  assert.deepEqual(gitControlPaths(root, [join(root, "src")]), unchanged);
});

test("an unreadable workspace repository fails closed instead of dropping hooks", (t) => {
  const { root, config } = repository(t);
  config("core.hooksPath", "tools/hooks");
  writeFileSync(join(root, ".git", "HEAD"), "not a ref\n");
  assert.throws(
    () => gitControlPaths(root, [root]),
    (e) => e instanceof EngineError && e.code === "SANDBOX_SOURCE_STALE",
  );
});
