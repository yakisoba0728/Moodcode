import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandPlan,
  PROJECTS,
  WINDOWS_STORAGE_TESTS,
  windowsTestFiles,
} from "./engine-ci.mjs";

test("headless compiler scope contains no desktop project and no GUI launcher", () => {
  assert.deepEqual(PROJECTS, [
    "packages/contracts",
    "packages/engine",
    "apps/engine-harness",
  ]);
  for (const operation of [
    "typecheck",
    "build",
    "test",
    "prepare-pty",
    "eval",
    "test-windows",
  ]) {
    const plan = commandPlan(operation);
    assert.equal(plan[0], process.execPath);
    assert.ok(
      !plan.some((argument) =>
        /apps[\\/]desktop|electron(?:\.exe)?$/.test(argument),
      ),
    );
  }
  assert.throws(() => commandPlan("desktop"));
});

test("Windows selection includes contracts and selected SQLite/port fixtures without POSIX process authority tests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "moodcode-ci-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [
    "packages/contracts/dist/contracts.test.js",
    ...WINDOWS_STORAGE_TESTS.map(
      (name) => `packages/engine/dist/storage/${name}.test.js`,
    ),
    "packages/engine/dist/tools/command/backends.test.js",
    "packages/engine/dist/storage/native-crash.test.js",
    "packages/engine/dist/storage/ownership.test.js",
    "packages/engine/dist/terminals/terminals.test.js",
  ];
  for (const path of paths) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, "");
  }
  const selected = await windowsTestFiles(root);
  assert.equal(selected.length, WINDOWS_STORAGE_TESTS.length + 2);
  assert.ok(
    selected.every(
      (path) => !/(?:native-crash|ownership|terminals)\.test\.js$/.test(path),
    ),
  );
  await rm(join(root, "packages/engine/dist/storage/native-inbox.test.js"));
  await assert.rejects(windowsTestFiles(root), { code: "ENOENT" });
});
