import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HELP = `Usage: node scripts/verify-engine-resilience.mjs [options]
  --profile quick|extended       Default quick (3 iterations); extended defaults to 12
  --runtime compiled|source      Default compiled; source needs the repository's absolute tsx loader
  --iterations 3..60             Every run includes complete, cancel and Root SIGKILL
  --seed 0..4294967295            Deterministic payload seed (default 20261009)
  --boundary-timeout-ms 1000..30000  Per-boundary deadline (default 10000)
  --report PATH                  Atomically save the structured JSON report
  --help                         No engine import or execution

POSIX local fixtures only. No live provider, credential reader or automatic retry.
Exit 0: all native assertions and cleanup passed; 1: failure/unsupported; 2: invalid CLI.
`;
function integer(value, min, max) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value))
    throw new Error("Expected a bounded decimal integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error("Integer option is out of bounds");
  return parsed;
}
export function parseResilienceArgs(args) {
  const options = { profile: "quick", runtime: "compiled", seed: 20261009 };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--help" && args.length === 1) return { help: true };
    if (
      ![
        "--profile",
        "--runtime",
        "--iterations",
        "--seed",
        "--boundary-timeout-ms",
        "--report",
      ].includes(name) ||
      seen.has(name)
    )
      throw new Error("Unknown or duplicate option");
    seen.add(name);
    const value = args[++i];
    if (value === undefined || value.startsWith("--"))
      throw new Error("Missing option value");
    if (name === "--profile") {
      if (!["quick", "extended"].includes(value))
        throw new Error("Invalid profile");
      options.profile = value;
    } else if (name === "--runtime") {
      if (!["compiled", "source"].includes(value))
        throw new Error("Invalid runtime");
      options.runtime = value;
    } else if (name === "--iterations")
      options.iterations = integer(value, 3, 60);
    else if (name === "--seed") options.seed = integer(value, 0, 0xffffffff);
    else if (name === "--boundary-timeout-ms")
      options.boundaryTimeoutMs = integer(value, 1000, 30000);
    else {
      if (!value || value.includes("\0"))
        throw new Error("Invalid report path");
      options.report = resolve(value);
    }
  }
  return options;
}
/** Exposed only to test CLI validation; the real verifier always owns genuine Engine fixtures. */
export async function runResilienceCli(args, ports = {}) {
  const output = ports.output ?? ((text) => process.stdout.write(text));
  let options;
  try {
    options = parseResilienceArgs(args);
  } catch (error) {
    (ports.error ?? ((text) => process.stderr.write(text)))(
      `Invalid resilience CLI: ${error.message}\n`,
    );
    return 2;
  }
  if (options.help) {
    output(HELP);
    return 0;
  }
  const { runtime, report: destination, ...scenario } = options;
  const url = new URL(
    runtime === "source"
      ? "../packages/engine/src/resilience/index.ts"
      : "../packages/engine/dist/resilience/index.js",
    import.meta.url,
  );
  const load = ports.load ?? (() => import(url.href));
  try {
    const { verifyEngineResilience } = await load();
    const report = await verifyEngineResilience(scenario);
    const text = JSON.stringify(report, null, 2) + "\n";
    if (Buffer.byteLength(text) > 1_048_576)
      throw new Error("Resilience report exceeds 1 MiB");
    if (destination) {
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    }
    output(text);
    return report.passed === true ? 0 : 1;
  } catch (error) {
    // Import, I/O or verifier failure must never be converted to a green report.
    const report = {
      schemaVersion: 1,
      kind: "engine-resilience-soak",
      passed: false,
      noLive: true,
      runtime: { mode: runtime },
      failure: {
        name: error.name ?? "Error",
        message: String(error.message ?? "Verifier failed").slice(0, 512),
      },
    };
    output(JSON.stringify(report, null, 2) + "\n");
    return 1;
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  process.exitCode = await runResilienceCli(process.argv.slice(2));
