import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newBase, POSIX_SUPPORTED } from "./fixture.js";
import { runCrashScenario } from "./crash.js";
import { runLocalScenario, type IterationResult } from "./scenarios.js";
import {
  iterationSeed,
  resolveResilienceOptions,
  scenarioAt,
  type ResilienceOptions,
} from "./options.js";
export { resolveResilienceOptions } from "./options.js";
export type { ResilienceOptions } from "./options.js";

/** Account-free compound native lifecycle assertions, rather than synthetic proof rows. */
export async function verifyEngineResilience(options: ResilienceOptions = {}) {
  const resolved = resolveResilienceOptions(options);
  const started = performance.now();
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const digestFile = (url: URL) =>
    createHash("sha256").update(readFileSync(url)).digest("hex");
  let gitHead: string | null = null;
  try {
    gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* A packaged runtime may not contain Git metadata. */
  }
  const source = {
    harnessEntrySha256: digestFile(
      new URL(`./index.${extension}`, import.meta.url),
    ),
    engineEntrySha256: digestFile(
      new URL(`../engine.${extension}`, import.meta.url),
    ),
    gitHead,
    qualification:
      "Entry-file identities only; this report is not a full engine source freeze.",
  };
  const results: IterationResult[] = [];
  if (POSIX_SUPPORTED)
    for (let iteration = 0; iteration < resolved.iterations; iteration++) {
      const scenario = scenarioAt(iteration),
        seed = iterationSeed(resolved.seed, iteration);
      const base = newBase();
      const result =
        scenario === "root-sigkill"
          ? await runCrashScenario(
              base,
              iteration,
              seed,
              resolved.boundaryTimeoutMs,
            )
          : await runLocalScenario(
              base,
              iteration,
              seed,
              scenario,
              resolved.boundaryTimeoutMs,
            );
      results.push(result);
      // Failure stops the suite; cleanup debt is preserved and never followed by more effects.
      if (!result.passed) break;
    }
  return {
    schemaVersion: 1,
    kind: "engine-resilience-soak",
    timestamp: new Date().toISOString(),
    passed:
      POSIX_SUPPORTED &&
      results.length === resolved.iterations &&
      results.every((r) => r.passed),
    supported: POSIX_SUPPORTED,
    noLive: true,
    ...resolved,
    runtime: {
      mode: extension === "ts" ? "source" : "compiled",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    source,
    results,
    summary: {
      completed: results.length,
      failed: results.filter((r) => !r.passed).length,
      providerCalls: results.reduce(
        (n, r) =>
          n +
          r.providerCalls.command +
          r.providerCalls.observer +
          r.providerCalls.reopened,
        0,
      ),
      processLaunches: results.reduce((n, r) => n + r.processLaunches, 0),
      unknownOutcomes: results.filter(
        (r) => r.native?.job.state === "uncertain",
      ).length,
      cleanupFailures: results.filter(
        (r) => !r.cleanup.engineClosed || !r.cleanup.physicalGroupAbsent,
      ).length,
      durationMs: Math.round(performance.now() - started),
    },
    limitations: [
      "POSIX owned run_command only; Windows JobObject, PTY, workflows and child task concurrency are separate suites.",
      "Scripted provider only; no external model, credential reader or billed token/cost proof.",
      "A physically absent process does not repair uncertain native receipts or grant replay.",
      "Seed controls payloads; this is a correctness soak, not a performance improvement benchmark.",
    ],
  };
}
