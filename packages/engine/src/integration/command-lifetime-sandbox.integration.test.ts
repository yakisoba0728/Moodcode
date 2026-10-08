import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEngine } from "../engine.js";

test("sandbox and interactive ownership transfer fail before storage or process admission", (t) => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "moodcode-lifetime-sandbox-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "engine.sqlite");
  const artifactDir = join(root, "artifacts");
  assert.throws(
    () =>
      createEngine({
        dbPath,
        artifactDir,
        jobs: true,
        hostCommands: true,
        commandLifetimes: true,
        osSandbox: true,
      }),
    { code: "SANDBOX_COMMAND_LIFETIME_UNSUPPORTED" },
  );
  assert.equal(existsSync(dbPath), false);
  assert.equal(existsSync(artifactDir), false);
});
