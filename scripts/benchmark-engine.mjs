import { pathToFileURL } from "node:url";

export function parseBenchmarkArgs(argv) {
  const options = { runtime: "compiled", profile: "quick", seed: 20261009 };
  const seen = new Set();
  const bounds = {
    "--runs": [8, 1000],
    "--message-bytes": [256, 2048],
    "--samples": [3, 100],
    "--warmup": [0, 10],
    "--seed": [0, 0xffffffff],
  };
  const names = {
    "--runs": "runs",
    "--message-bytes": "messageBytes",
    "--samples": "samples",
    "--warmup": "warmup",
    "--seed": "seed",
  };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--help" && argv.length === 1) return { help: true };
    if (
      seen.has(key) ||
      !["--runtime", "--profile", ...Object.keys(bounds)].includes(key) ||
      index + 1 === argv.length
    )
      throw new Error("INVALID_BASELINE_ARGUMENT");
    seen.add(key);
    const value = argv[++index];
    if (key === "--runtime" && ["source", "compiled"].includes(value))
      options.runtime = value;
    else if (key === "--profile" && ["quick", "standard"].includes(value))
      options.profile = value;
    else if (
      bounds[key] &&
      /^(0|[1-9][0-9]{0,9})$/.test(value) &&
      Number(value) >= bounds[key][0] &&
      Number(value) <= bounds[key][1]
    )
      options[names[key]] = Number(value);
    else throw new Error("INVALID_BASELINE_ARGUMENT");
  }
  return {
    ...(options.profile === "quick"
      ? { runs: 24, messageBytes: 256, samples: 5, warmup: 1 }
      : { runs: 200, messageBytes: 1024, samples: 20, warmup: 3 }),
    ...options,
  };
}
export async function benchmarkEngine(argv = []) {
  const report = {
    schemaVersion: 1,
    kind: "native-engine-performance-baseline",
    timestamp: new Date().toISOString(),
    passed: false,
    noLive: true,
    providerId: "scripted",
    modelId: "local",
    accountVerified: false,
    liveRequests: 0,
    credentialsRead: false,
    modelQualityEvaluated: false,
    absoluteTimingGate: false,
    sourceRuntime: null,
    failure: null,
  };
  let identity, assertStable;
  try {
    const options = parseBenchmarkArgs(argv);
    if (options.help) return { help: true };
    report.parameters = options;
    const directory = options.runtime === "source" ? "src" : "dist",
      extension = options.runtime === "source" ? "ts" : "js";
    const runtime = await import(
      new URL(
        `../packages/engine/${directory}/evaluation/runtime.${extension}`,
        import.meta.url,
      )
    );
    identity = runtime.sourceRuntimeIdentity;
    assertStable = runtime.assertIdentityStable;
    report.environment = runtime.environment();
    report.sourceRuntime = {
      before: await identity(),
      after: null,
      stable: false,
    };
    const { runEngineBenchmark } = await import(
      new URL(
        `../packages/engine/${directory}/evaluation/benchmark.${extension}`,
        import.meta.url,
      )
    );
    Object.assign(report, await runEngineBenchmark(options));
  } catch (error) {
    report.passed = false;
    report.failure =
      typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
        ? error.code
        : /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "")
          ? error.message
          : "BENCHMARK_FAILED";
  } finally {
    if (identity && report.sourceRuntime)
      try {
        report.sourceRuntime.after = await identity();
        assertStable(report.sourceRuntime.before, report.sourceRuntime.after);
        report.sourceRuntime.stable = true;
      } catch {
        report.passed = false;
        report.failure = "BASELINE_SOURCE_CHANGED";
      }
    report.completedAt = new Date().toISOString();
  }
  return report;
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const report = await benchmarkEngine(process.argv.slice(2));
  if (report.help)
    process.stdout.write(
      "Usage: node scripts/benchmark-engine.mjs [--runtime compiled|source] [--profile quick|standard] [--runs 8..1000] [--message-bytes 256..2048] [--samples 3..100] [--warmup 0..10] [--seed 0..4294967295]\nActual native Runs create the history; no bulk SQL fixture rows or live providers. Measures bounded history/context/event/summary/DB metrics. Timing and memory are informational, not absolute CI thresholds.\n",
    );
  else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  }
}
