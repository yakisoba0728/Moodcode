import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseResilienceArgs,
  runResilienceCli,
} from "./verify-engine-resilience.mjs";

test("quick and extended CLI bounds preserve all three compound scenarios", () => {
  assert.deepEqual(parseResilienceArgs([]), {
    profile: "quick",
    runtime: "compiled",
    seed: 20261009,
  });
  assert.deepEqual(
    parseResilienceArgs([
      "--profile",
      "extended",
      "--iterations",
      "60",
      "--seed",
      "4294967295",
      "--runtime",
      "source",
    ]),
    {
      profile: "extended",
      runtime: "source",
      iterations: 60,
      seed: 4294967295,
    },
  );
  for (const args of [
    ["--iterations", "2"],
    ["--iterations", "61"],
    ["--iterations", "3.0"],
    ["--seed", "-1"],
    ["--seed", "4294967296"],
    ["--profile", "quick", "--profile", "quick"],
    ["--live"],
    ["--runtime", "remote"],
    ["--boundary-timeout-ms", "999"],
  ])
    assert.throws(() => parseResilienceArgs(args));
});
test("help and invalid options do not import the engine or start fixtures", async () => {
  let imports = 0;
  const load = () => {
    imports++;
    throw new Error("Must not import");
  };
  assert.equal(await runResilienceCli(["--help"], { load, output() {} }), 0);
  assert.equal(await runResilienceCli(["--live"], { load, error() {} }), 2);
  assert.equal(imports, 0);
  const result = spawnSync(
    process.execPath,
    [
      new URL("./verify-engine-resilience.mjs", import.meta.url).pathname,
      "--help",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No live provider/);
});
test("a false result and cleanup/import failure return exit 1, never success", async () => {
  for (const load of [
    async () => ({
      verifyEngineResilience: async () => ({
        passed: false,
        cleanup: { engineClosed: false },
      }),
    }),
    async () => {
      throw new Error("Runtime missing");
    },
  ]) {
    let text = "";
    assert.equal(
      await runResilienceCli([], {
        load,
        output(value) {
          text += value;
        },
      }),
      1,
    );
    assert.equal(JSON.parse(text).passed, false);
  }
});
test("report persistence failure cannot turn a passing fixture result into a green CLI", async () => {
  const base = await mkdtemp(join(tmpdir(), "resilience-cli-"));
  try {
    let text = "";
    const load = async () => ({
      verifyEngineResilience: async () => ({
        schemaVersion: 1,
        passed: true,
        kind: "cli-contract-fixture-only",
      }),
    });
    assert.equal(
      await runResilienceCli(["--report", join(base, "result.json")], {
        load,
        output(value) {
          text += value;
        },
      }),
      0,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(base, "result.json"), "utf8")),
      JSON.parse(text),
    );
    const directory = join(base, "directory");
    await mkdir(directory);
    const temporary = `${directory}.${process.pid}.tmp`;
    text = "";
    assert.equal(
      await runResilienceCli(["--report", directory], {
        load,
        output(value) {
          text += value;
        },
      }),
      1,
    );
    assert.equal(JSON.parse(text).passed, false);
    assert.match(JSON.parse(text).failure.message, /rename/);
    await assert.rejects(access(temporary), { code: "ENOENT" });
    const foreign = Buffer.from("preexisting report temporary bytes");
    await writeFile(temporary, foreign, { flag: "wx" });
    text = "";
    assert.equal(
      await runResilienceCli(["--report", directory], {
        load,
        output(value) {
          text += value;
        },
      }),
      1,
    );
    assert.equal(JSON.parse(text).passed, false);
    assert.match(JSON.parse(text).failure.message, /EEXIST/);
    assert.deepEqual(await readFile(temporary), foreign);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("successful report rename releases the old temporary path before cleanup", async () => {
  const base = await mkdtemp(join(tmpdir(), "resilience-cli-transfer-"));
  const destination = join(base, "result.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  const foreign = Buffer.from("new owner after successful report rename");
  const realRename = fs.promises.rename;
  const report = { passed: true, kind: "report-transfer-fixture-only" };
  fs.promises.rename = async (from, to) => {
    await realRename(from, to);
    assert.equal(from, temporary);
    assert.equal(to, destination);
    await writeFile(temporary, foreign, { flag: "wx" });
  };
  syncBuiltinESMExports();
  try {
    assert.equal(await runResilienceCli(["--report", destination], {
      load: async () => ({ verifyEngineResilience: async () => report }),
      output() {},
    }), 0);
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), report);
    assert.deepEqual(await readFile(temporary), foreign);
  } finally {
    fs.promises.rename = realRename;
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  }
});
