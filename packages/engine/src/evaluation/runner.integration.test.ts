import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCodingEvaluation, type CodingTaskReport } from "./coding.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url)),
  runtime = import.meta.url.endsWith(".ts") ? "source" : "compiled";
const sourceArgs =
  runtime === "source"
    ? ["--import", join(root, "node_modules/tsx/dist/loader.mjs")]
    : [];
const cli = (script: string, args: string[], extra: string[] = []) =>
  spawnSync(
    process.execPath,
    [...extra, ...sourceArgs, join(root, "scripts", script), ...args],
    { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4_194_304 },
  );

test("CLI preflight rejects unsafe/oversized/duplicate arguments with no native setup, preserving help and defaults", async () => {
  const evaluation = await import(
      new URL("../../../../scripts/evaluate-engine.mjs", import.meta.url).href
    ),
    benchmark = await import(
      new URL("../../../../scripts/benchmark-engine.mjs", import.meta.url).href
    );
  assert.equal(evaluation.parseEvaluationArgs([]).seed, 20261009);
  assert.equal(benchmark.parseBenchmarkArgs([]).profile, "quick");
  assert.equal(
    benchmark.parseBenchmarkArgs(["--profile", "standard"]).runs,
    200,
  );
  for (const script of ["evaluate-engine.mjs", "benchmark-engine.mjs"]) {
    const helped = cli(script, ["--help"]);
    assert.equal(helped.status, 0);
    assert.match(helped.stdout, /Usage:/);
    for (const args of [
      ["--live"],
      ["--runtime", "source", "--runtime", "compiled"],
      ["--seed", "-1"],
      ["--seed", "4294967296"],
      ["--seed", "1e3"],
      ["--unknown", "value"],
    ]) {
      const result = cli(script, args);
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.passed, false);
      assert.equal(report.sourceRuntime, null);
      assert.equal(report.accountVerified, false);
      assert.equal(report.credentialsRead, false);
      assert.equal(report.liveRequests, 0);
    }
  }
  assert.throws(() => benchmark.parseBenchmarkArgs(["--runs", "1001"]));
  assert.throws(() => benchmark.parseBenchmarkArgs(["--samples", "101"]));
  assert.throws(() =>
    benchmark.parseBenchmarkArgs(["--message-bytes", "1000000000"]),
  );
});

test(
  "actual CLI fixes three real Git repositories with native verification/Part/approved commit, no credentials or fetch",
  { timeout: 60_000, skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "moodcode-eval-access-")),
      audit = join(directory, "access.json"),
      preload = join(directory, "guard.mjs");
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      preload,
      `import fs from 'node:fs'; import fsp from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; import {basename} from 'node:path';
const audit={credentialFileReads:0,credentialEnvironmentReads:0,fetchCalls:0};
const check=p=>{const name=basename(String(p));if(name==='.env'||name.startsWith('.env.')||['auth.json','credentials.json','credentials.toml','settings.json'].includes(name)){audit.credentialFileReads++;throw Error('CREDENTIAL_READ_FORBIDDEN')}};
for(const [obj,key] of [[fs,'readFileSync'],[fs,'readFile'],[fsp,'readFile']]){const original=obj[key];obj[key]=function(p,...args){check(p);return original.call(this,p,...args)}};
syncBuiltinESMExports();const originalEnv=process.env;process.env=new Proxy(originalEnv,{get(target,key){if(typeof key==='string'&&/API_KEY|ACCESS_TOKEN|REFRESH_TOKEN/.test(key)){audit.credentialEnvironmentReads++;throw Error('CREDENTIAL_ENV_FORBIDDEN')}return Reflect.get(target,key)}});
globalThis.fetch=()=>{audit.fetchCalls++;throw Error('FETCH_FORBIDDEN')};process.once('exit',()=>fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify(audit)));
`,
    );
    const result = cli(
      "evaluate-engine.mjs",
      ["--runtime", runtime, "--seed", "7"],
      ["--import", preload],
    );
    const report = JSON.parse(result.stdout);
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        stderr: result.stderr,
        failure: report.failure,
        sourceStable: report.sourceRuntime?.stable,
        tasks: report.tasks,
      }),
    );
    assert.equal(report.passed, true, JSON.stringify(report.tasks));
    assert.equal(report.sourceRuntime.stable, true);
    assert.equal(report.summary.successRate, 1);
    assert.equal(report.summary.attempted, 3);
    assert.equal(report.modelQualityEvaluated, false);
    assert.equal(report.accountVerified, false);
    for (const task of report.tasks as CodingTaskReport[]) {
      assert.equal(task.passed, true);
      assert.ok(Object.values(task.checks).every((value) => value === true));
      assert.equal(task.native!.toolParts, task.native!.tools.length);
      assert.equal(task.commit.state, "committed");
      assert.match(task.commit.sha!, /^[a-f0-9]{40,64}$/);
      assert.equal(task.commit.duplicateNoSecondCommit, true);
      assert.equal(task.tokens.input, null);
      assert.equal(task.tokens.output, null);
      assert.equal(task.cost.amount, null);
      assert.equal(task.cleanup!.engineClosed, true);
      assert.equal(task.cleanup!.temporaryFilesRemoved, true);
    }
    assert.deepEqual(JSON.parse(await readFile(audit, "utf8")), {
      credentialFileReads: 0,
      credentialEnvironmentReads: 0,
      fetchCalls: 0,
    });
  },
);

test(
  "wrong scripted patch and denied approval cannot earn task/verification/commit credit despite provider terminal text",
  { timeout: 60_000, skip: process.platform === "win32" },
  async () => {
    for (const fixtureFault of ["wrong-patch", "deny-patch"] as const) {
      const report = await runCodingEvaluation({
        seed: 9,
        task: "addition-bug",
        commit: "none",
        fixtureFault,
      });
      assert.equal(report.passed, false);
      assert.equal(report.summary.successRate, 0);
      assert.equal(report.summary.attempted, 1);
      const task = report.tasks[0]!;
      assert.equal(task.checks.nativeVerificationPassed, false);
      assert.equal(task.commit.sha, null);
      assert.equal(task.cleanup!.engineClosed, true);
      assert.equal(task.cleanup!.temporaryFilesRemoved, true);
      assert.ok(task.native!.tools.some((tool) => tool.state !== "completed"));
      if (fixtureFault === "deny-patch")
        assert.ok(
          task.native!.approvals.some(
            (approval) => approval.status === "denied",
          ),
        );
    }
  },
);

test(
  "quick benchmark creates actual Runs/history/summary/event replay and reports finite percentiles without an SLA",
  { timeout: 60_000 },
  () => {
    const result = cli("benchmark-engine.mjs", [
      "--runtime",
      runtime,
      "--profile",
      "quick",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.sourceRuntime.stable, true);
    assert.equal(report.absoluteTimingGate, false);
    assert.equal(report.fixture.inputRuns, 24);
    assert.equal(report.fixture.persistedMessages, 48);
    assert.equal(report.fixture.historyPaginationExact, true);
    assert.equal(report.fixture.reopenedWithoutProviderReplay, true);
    assert.equal(report.summary.state, "completed");
    assert.equal(report.summary.publication, "activated");
    assert.equal(report.summary.cleanupConfirmed, true);
    assert.equal(report.summary.measuredActivations, 1);
    assert.equal(report.summary.readUsageSql.summaryFullPayloadReads, 0);
    assert.equal(report.summary.readUsageSql.writeStatements, 0);
    assert.equal(report.usage.inputTokens, null);
    assert.equal(report.cost.amount, null);
    for (const measurement of Object.values(report.measurements) as {
      latency: { count: number; p50: number; p95: number; max: number };
      resultBytes: { max: number };
    }[]) {
      assert.equal(measurement.latency.count, 5);
      assert.ok(Number.isFinite(measurement.latency.p50));
      assert.ok(measurement.latency.p95 >= measurement.latency.p50);
      assert.ok(measurement.latency.max >= measurement.latency.p95);
      assert.ok(measurement.resultBytes.max > 0);
    }
    assert.equal(report.cleanup.engineClosed, true);
    assert.equal(report.cleanup.temporaryFilesRemoved, true);
  },
);
