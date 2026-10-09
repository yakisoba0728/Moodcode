import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("./inspect-history-storage-cost.py", import.meta.url));
const HELP = `Usage: node scripts/inspect-history-storage-cost.mjs --database PATH --closed-snapshot [--timeout-ms 1000..60000]
Requires an already closed snapshot with absent/empty WAL. Refuses live WAL.
Python3 stdlib SQLite uses mode=ro&immutable=1; no Engine import or checkpoint.
Prints bounded counts, byte totals, schema names and digests; no stored values.
Exit 0: unchanged inspection; 1: refused/failed/changed; 2: invalid options.
`;

export function parseHistoryStorageArgs(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = { timeoutMs: 30000, closedSnapshot: false }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key) || !["--database", "--closed-snapshot", "--timeout-ms"].includes(key))
      throw new Error("Unknown or duplicate storage inspection option");
    seen.add(key);
    if (key === "--closed-snapshot") options.closedSnapshot = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--") || value.includes("\0")) throw new Error("Missing or invalid option value");
      if (key === "--database") options.database = resolve(value);
      else {
        if (!/^\d+$/.test(value) || Number(value) < 1000 || Number(value) > 60000)
          throw new Error("Timeout must be 1000..60000 milliseconds");
        options.timeoutMs = Number(value);
      }
    }
  }
  if (!options.database || !options.closedSnapshot) throw new Error("Database path and --closed-snapshot are required");
  return options;
}

export async function inspectHistoryStorage(options) {
  if (!options?.closedSnapshot || typeof options.database !== "string" ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60000)
    throw new Error("Invalid closed-snapshot inspection options");
  const { stdout } = await execute("python3", [helper, options.database, String(options.timeoutMs)], {
    timeout: options.timeoutMs + 1000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  return JSON.parse(stdout);
}

export async function runHistoryStorageCli(args, output = value => process.stdout.write(value)) {
  let options;
  try { options = parseHistoryStorageArgs(args); }
  catch (error) { output(`${error.message}\n`); return 2; }
  if (options.help) { output(HELP); return 0; }
  try {
    const report = await inspectHistoryStorage(options);
    output(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === "measured_unchanged" ? 0 : 1;
  } catch {
    // Child errors can contain schema text; keep diagnostics bounded and private.
    output("Storage inspector failed or exceeded its process/output bound\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runHistoryStorageCli(process.argv.slice(2));
