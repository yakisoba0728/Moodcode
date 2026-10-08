import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HELP = `Usage: node scripts/verify-engine-persistent-soak.mjs [options]
  --profile quick|long            Default quick (1 second); long defaults to 30 minutes
  --runtime compiled|source       Default compiled; source requires the absolute tsx loader
  --duration-ms 1000..28800000     Timed same-instance observation, at most 8 hours
  --max-cycles 3..50000            Input work ceiling (quick 6; long 10000)
  --max-inputs 16..200004          Unique native input ceiling, including checkpoints
  --max-input-bytes 1024..134217728  UTF-8 prompt byte ceiling; reserves mandatory cases
  --payload-bytes 64..8192         Fixed seeded prompt size (default 1024)
  --seed 0..4294967295             Default 20261009
  --max-samples 8..256             Finite actual memory/FD/process/SQLite/artifact samples
  --boundary-timeout-ms 1000..30000  Individual native operation deadline
  --report PATH                   Atomically save the final JSON report
  --help                          No engine import or fixture execution

Account-free POSIX native Engine verification. Approved command completion/cancel,
queue/steer history, graceful reopen and final actual SIGKILL/no replay checkpoint.
Timed observation continues after load ceilings. Unknown DB/artifacts are retained.
Exit 0: expected native invariants and physical cleanup verified; 1: failure/unsupported; 2: invalid CLI.
`;
const NUMERIC = {
  "--duration-ms": ["durationMs", 1000, 28800000],
  "--max-cycles": ["maxCycles", 3, 50000],
  "--max-inputs": ["maxInputs", 16, 200004],
  "--max-input-bytes": ["maxInputBytes", 1024, 134217728],
  "--payload-bytes": ["payloadBytes", 64, 8192],
  "--seed": ["seed", 0, 0xffffffff],
  "--max-samples": ["maxSamples", 8, 256],
  "--boundary-timeout-ms": ["boundaryTimeoutMs", 1000, 30000],
};
export function parsePersistentSoakArgs(args) {
  const options = { profile: "quick", runtime: "compiled", seed: 20261009 };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--help" && args.length === 1) return { help: true };
    if (
      !["--profile", "--runtime", "--report", ...Object.keys(NUMERIC)].includes(
        name,
      ) ||
      seen.has(name)
    )
      throw new Error("Unknown or duplicate option");
    seen.add(name);
    const value = args[++index];
    if (value === undefined || value.startsWith("--"))
      throw new Error("Missing option value");
    if (name === "--profile") {
      if (!["quick", "long"].includes(value))
        throw new Error("Invalid profile");
      options.profile = value;
    } else if (name === "--runtime") {
      if (!["source", "compiled"].includes(value))
        throw new Error("Invalid runtime");
      options.runtime = value;
    } else if (name === "--report") {
      if (!value || value.includes("\0"))
        throw new Error("Invalid report path");
      options.report = resolve(value);
    } else {
      const [key, minimum, maximum] = NUMERIC[name];
      const parsed = Number(value);
      if (
        !/^(?:0|[1-9]\d*)$/.test(value) ||
        !Number.isSafeInteger(parsed) ||
        parsed < minimum ||
        parsed > maximum
      )
        throw new Error("Integer option is out of bounds");
      options[key] = parsed;
    }
  }
  const bytes = options.maxInputBytes ?? 67108864,
    payload = options.payloadBytes ?? 1024;
  if (bytes < payload * 16)
    throw new Error("Input byte ceiling must reserve mandatory cases");
  return options;
}
async function saveReport(destination, text) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    created = true;
    await rename(temporary, destination);
  } finally {
    if (created)
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
export async function runPersistentSoakCli(args, ports = {}) {
  const output = ports.output ?? ((text) => process.stdout.write(text));
  let options;
  try {
    options = parsePersistentSoakArgs(args);
  } catch (error) {
    (ports.error ?? ((text) => process.stderr.write(text)))(
      `Invalid persistent soak CLI: ${error.message}\n`,
    );
    return 2;
  }
  if (options.help) {
    output(HELP);
    return 0;
  }
  const { runtime, report: destination, ...scenario } = options;
  let report;
  try {
    const url = new URL(
      runtime === "source"
        ? "../packages/engine/src/resilience/persistent.ts"
        : "../packages/engine/dist/resilience/persistent.js",
      import.meta.url,
    );
    const { verifyEnginePersistentSoak } = await (
      ports.load ?? (() => import(url.href))
    )();
    report = await verifyEnginePersistentSoak(scenario);
    const text = JSON.stringify(report, null, 2) + "\n";
    if (Buffer.byteLength(text) > 2_097_152)
      throw new Error("Persistent soak report exceeds 2 MiB");
    if (destination) await saveReport(destination, text);
    output(text);
    return report.passed === true ? 0 : 1;
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      kind: "engine-persistent-soak",
      passed: false,
      noLive: true,
      runtime: { mode: runtime },
      retainedEvidencePath: report?.cleanup?.retainedEvidencePath ?? null,
      failure: {
        name: error.name ?? "Error",
        message: String(error.message ?? "Verifier failed").slice(0, 512),
      },
    };
    const text = JSON.stringify(failure, null, 2) + "\n";
    if (destination) await saveReport(destination, text).catch(() => {});
    output(text);
    return 1;
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  process.exitCode = await runPersistentSoakCli(process.argv.slice(2));
