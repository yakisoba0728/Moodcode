import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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
    "test-media-local",
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

test("media scripts trigger both path filters and execute local compiled regression tests with LF or CRLF workflow checkout", async () => {
  const source = await readFile(
    new URL("../workflows/engine.yml", import.meta.url),
    "utf8",
  );
  for (const ending of ["\n", "\r\n"]) {
    const checkout = source.replace(/\r\n?/g, "\n").replace(/\n/g, ending);
    const workflow = checkout.replace(/\r\n?/g, "\n");
    for (const event of ["pull_request", "push"]) {
      const block = workflow.split(`  ${event}:\n`)[1].split(/^  \w+:\s*$/m)[0];
      for (const path of [
        "scripts/verify-media-account*.mjs",
        "scripts/plan-media-verification*.mjs",
      ])
        assert.ok(block.includes(`- "${path}"`), `${event}: ${path}`);
    }
    const posix = workflow
      .split("  posix:\n")[1]
      .split("  windows-portable:\n")[0];
    assert.match(
      posix,
      /run: node \.github\/scripts\/engine-ci\.mjs test-media-local/,
    );
    assert.ok(
      posix.indexOf("engine-ci.mjs build") <
        posix.indexOf("engine-ci.mjs test-media-local"),
    );
  }
  const plan = commandPlan("test-media-local");
  assert.deepEqual(plan.slice(0, 3), [
    process.execPath,
    "--test",
    "--test-concurrency=1",
  ]);
  assert.deepEqual(
    plan.slice(3).map((path) => path.split(/[\\/]/).at(-1)),
    ["plan-media-verification.test.mjs", "verify-media-account.test.mjs"],
  );
  assert.ok(
    !plan.some(
      (argument) => argument === "--live" || argument === "--api-key-env",
    ),
  );
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
    selected.some((path) =>
      /storage[\\/]fixture-lifetime\.test\.js$/.test(path),
    ),
    "Actual SQLite connection lifetime regression is included in the portable gate",
  );
  assert.ok(
    selected.every(
      (path) => !/(?:native-crash|ownership|terminals)\.test\.js$/.test(path),
    ),
  );
  await rm(join(root, "packages/engine/dist/storage/native-inbox.test.js"));
  await assert.rejects(windowsTestFiles(root), { code: "ENOENT" });
});
