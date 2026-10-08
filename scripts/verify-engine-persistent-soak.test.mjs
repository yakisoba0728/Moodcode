import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parsePersistentSoakArgs,
  runPersistentSoakCli,
} from "./verify-engine-persistent-soak.mjs";

test("persistent CLI rejects duplicate, unbounded, fractional and unknown controls before loading runtime", async () => {
  assert.deepEqual(parsePersistentSoakArgs([]), {
    profile: "quick",
    runtime: "compiled",
    seed: 20261009,
  });
  assert.equal(
    parsePersistentSoakArgs(["--profile", "long", "--duration-ms", "28800000"])
      .durationMs,
    28800000,
  );
  for (const args of [
    ["--duration-ms", "28800001"],
    ["--duration-ms", "Infinity"],
    ["--max-cycles", "2"],
    ["--max-cycles", "3.0"],
    ["--max-inputs", "15"],
    ["--max-samples", "257"],
    ["--seed", "4294967296"],
    ["--max-input-bytes", "1024"],
    ["--profile", "long", "--profile", "long"],
    ["--live"],
    ["--iterations", "60"],
  ])
    assert.throws(() => parsePersistentSoakArgs(args));
  let imports = 0;
  const load = () => {
    imports++;
    throw new Error("No import expected");
  };
  assert.equal(
    await runPersistentSoakCli(["--help"], { load, output() {} }),
    0,
  );
  assert.equal(
    await runPersistentSoakCli(["--duration-ms", "999"], { load, error() {} }),
    2,
  );
  assert.equal(imports, 0);
});
test("CLI persists failing evidence and keeps cleanup/import/persistence failures non-green", async () => {
  const base = await mkdtemp(join(tmpdir(), "persistent-cli-"));
  try {
    const destination = join(base, "failed.json");
    let output = "";
    const report = {
      schemaVersion: 1,
      kind: "cli-contract-fixture-only",
      passed: false,
      cleanup: {
        retainedEvidencePath: "/private/fixture-evidence",
        physicalCleanupConfirmed: false,
      },
    };
    assert.equal(
      await runPersistentSoakCli(["--report", destination], {
        load: async () => ({ verifyEnginePersistentSoak: async () => report }),
        output: (text) => {
          output += text;
        },
      }),
      1,
    );
    assert.deepEqual(
      JSON.parse(await readFile(destination, "utf8")),
      JSON.parse(output),
    );
    assert.equal(
      await runPersistentSoakCli([], {
        load: async () => {
          throw new Error("Source missing");
        },
        output() {},
      }),
      1,
    );
    assert.equal(
      await runPersistentSoakCli(["--report", base], {
        load: async () => ({
          verifyEnginePersistentSoak: async () => ({ passed: true }),
        }),
        output() {},
      }),
      1,
    );
    assert.equal(
      (await readdir(base)).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
