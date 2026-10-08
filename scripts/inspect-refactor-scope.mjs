import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AST_EXTENSIONS,
  classifyPath,
  readSource,
  sha256,
} from "./refactor-inventory/scope.mjs";
import { buildReport } from "./refactor-inventory/report.mjs";
import { analyze, git } from "./refactor-inventory/process.mjs";

const TOOL_ROOT = dirname(fileURLToPath(import.meta.url));
const HELP = `Usage: node scripts/inspect-refactor-scope.mjs [options]

Read Git-tracked owned source only; emit a source-pinned RF-01 inventory as JSON.
No engine/provider imports, account configuration, network, build or repository writes.

  --root PATH                  Repository root (default: current directory)
  --detail summary|full        Summary omits per-file function/call arrays (default: summary)
  --top N                      Maximum candidates per list (default: 20; 1..100)
  --duplicate-min-lines N      Minimum body line span (default: 6; 1..1000)
  --duplicate-min-nodes N      Minimum body AST nodes (default: 40; 10..10000)
  --max-files N                Maximum selected sources (default: 5000; 1..20000)
  --max-file-bytes N           Per-source bound (default: 2097152; 1..16777216)
  --max-total-bytes N          Captured source bound (default: 67108864; 1..268435456)
  --max-report-bytes N         JSON/worker output bound (default: 67108864; 1024..134217728)
  --timeout-ms N               Whole inspection deadline (default: 60000; 100..120000)
  --stable                     Omit variable timing/RSS observations for stable JSON
  --help                       Print help without scanning or loading the compiler

Exit 0: physical and AST coverage complete; manual review still required.
Exit 1: partial/failed measurement, unsupported syntax, changed source or exceeded bound.
Exit 2: invalid arguments. Unsupported CSS/HTML/YAML remain explicit physical-only records.
`;
const DEFAULTS = {
  detail: "summary",
  top: 20,
  duplicateMinLines: 6,
  duplicateMinNodes: 40,
  maxFiles: 5000,
  maxFileBytes: 2097152,
  maxTotalBytes: 67108864,
  maxReportBytes: 67108864,
  timeoutMs: 60000,
  stable: false,
};
const NUMERIC = {
  "--top": ["top", 1, 100],
  "--duplicate-min-lines": ["duplicateMinLines", 1, 1000],
  "--duplicate-min-nodes": ["duplicateMinNodes", 10, 10000],
  "--max-files": ["maxFiles", 1, 20000],
  "--max-file-bytes": ["maxFileBytes", 1, 16777216],
  "--max-total-bytes": ["maxTotalBytes", 1, 268435456],
  "--max-report-bytes": ["maxReportBytes", 1024, 134217728],
  "--timeout-ms": ["timeoutMs", 100, 120000],
};

export function parseInventoryArgs(args) {
  const options = { ...DEFAULTS, root: process.cwd() },
    seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--help") {
      options.help = true;
      continue;
    }
    if (flag === "--stable") {
      options.stable = true;
      continue;
    }
    if (flag !== "--root" && flag !== "--detail" && !NUMERIC[flag]) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value: ${flag}`);
    if (flag === "--root") {
      options.root = resolve(value);
      continue;
    }
    if (flag === "--detail") {
      if (value !== "summary" && value !== "full")
        throw new Error("--detail must be summary or full");
      options.detail = value;
      continue;
    }
    const [key, minimum, maximum] = NUMERIC[flag],
      number = Number(value);
    if (
      !/^[1-9][0-9]*$/u.test(value) ||
      !Number.isSafeInteger(number) ||
      number < minimum ||
      number > maximum
    ) {
      throw new Error(`${flag} must be an integer in ${minimum}..${maximum}`);
    }
    options[key] = number;
  }
  return options;
}

function indexEntries(index) {
  const result = new Map();
  for (const entry of index.split("\0")) {
    if (!entry) continue;
    const match = /^(\d+) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new Error("invalid-git-index-entry");
    const [, mode, oid, stage, path] = match;
    const stages = result.get(path) ?? [];
    stages.push({ mode, oid, stage: Number(stage) });
    result.set(path, stages);
  }
  return result;
}

export async function inspectRefactorScope(options) {
  const started = performance.now(),
    deadline = started + options.timeoutMs;
  const remaining = () => Math.max(1, Math.floor(deadline - performance.now()));
  const root = realpathSync(options.root);
  if (
    realpathSync(
      git(root, ["rev-parse", "--show-toplevel"], remaining()).trim(),
    ) !== root
  ) {
    throw new Error("root-must-be-repository-top-level");
  }
  const index = git(
    root,
    ["ls-files", "--stage", "-z", "--cached"],
    remaining(),
  );
  const tracked = indexEntries(index),
    head =
      git(root, ["rev-parse", "--verify", "HEAD"], remaining(), true)?.trim() ??
      null;
  const files = [],
    excluded = {},
    changedPaths = [],
    validationFailures = [];
  let totalBytes = 0,
    boundsExceeded = false;
  for (const [path, stages] of [...tracked].sort(([a], [b]) =>
    a.localeCompare(b, "en"),
  )) {
    const classification = classifyPath(path);
    if (classification.scope === "excluded") {
      excluded[classification.reason] =
        (excluded[classification.reason] ?? 0) + 1;
      continue;
    }
    const file = {
      path,
      ...classification,
      index: stages,
      physicalStatus: "failed",
      syntax: { status: "failed", reason: "physical-source-not-measured" },
    };
    files.push(file);
    try {
      if (files.length > options.maxFiles) throw new Error("max-files");
      if (performance.now() >= deadline) throw new Error("inspection-deadline");
      if (stages.length !== 1 || stages[0].stage !== 0)
        throw new Error("unmerged-index");
      if (stages[0].mode !== "100644" && stages[0].mode !== "100755")
        throw new Error("non-regular-index-entry");
      const available = Math.min(
        options.maxFileBytes,
        options.maxTotalBytes - totalBytes,
      );
      let source;
      try {
        source = readSource(root, path, available);
      } catch (error) {
        if (
          error.message === "max-file-bytes" &&
          available < options.maxFileBytes
        ) {
          throw new Error("max-total-bytes");
        }
        throw error;
      }
      if (totalBytes + source.bytes > options.maxTotalBytes)
        throw new Error("max-total-bytes");
      totalBytes += source.bytes;
      Object.assign(file, source, { physicalStatus: "measured" });
      file.syntax = AST_EXTENSIONS.has(classification.extension)
        ? { status: "pending" }
        : {
            status: "unsupported",
            reason: `no-parser-for-${classification.extension}`,
          };
    } catch (error) {
      const reason = String(error.code ?? error.message).slice(0, 160);
      file.physicalReason = reason;
      if (reason.startsWith("max-") || reason === "inspection-deadline")
        boundsExceeded = true;
    }
  }
  const sources = files
    .filter((file) => file.syntax.status === "pending")
    .map((file) => ({ path: file.path, text: file.text }));
  let analysis = { records: [], typescript: null, observations: null };
  if (sources.length) {
    try {
      analysis = await analyze(sources, options, remaining());
    } catch (error) {
      analysis.records = sources.map((source) => ({
        path: source.path,
        status: "failed",
        reason: error.message,
      }));
      if (/bound|timeout/u.test(error.message)) boundsExceeded = true;
    }
  }
  for (const file of files)
    if (file.physicalStatus === "measured") {
      if (performance.now() >= deadline) {
        validationFailures.push({
          path: file.path,
          reason: "source-validation-deadline",
        });
        boundsExceeded = true;
        break;
      }
      try {
        const after = readSource(root, file.path, options.maxFileBytes);
        if (after.sha256 !== file.sha256) changedPaths.push(file.path);
      } catch (error) {
        changedPaths.push(file.path);
        validationFailures.push({
          path: file.path,
          reason: String(error.code ?? error.message).slice(0, 160),
        });
      }
    }
  let afterIndex = null,
    afterHead = null;
  try {
    if (performance.now() >= deadline)
      throw new Error("source-validation-deadline");
    afterIndex = git(
      root,
      ["ls-files", "--stage", "-z", "--cached"],
      remaining(),
    );
    afterHead =
      git(root, ["rev-parse", "--verify", "HEAD"], remaining(), true)?.trim() ??
      null;
  } catch (error) {
    validationFailures.push({
      path: null,
      reason: String(error.code ?? error.message).slice(0, 160),
    });
  }
  const toolPins = {};
  for (const path of [
    "inspect-refactor-scope.mjs",
    ...["scope", "ast", "worker", "report", "process"].map(
      (name) => `refactor-inventory/${name}.mjs`,
    ),
  ]) {
    toolPins[`scripts/${path}`] = sha256(readFileSync(join(TOOL_ROOT, path)));
  }
  const sourceStable =
    index === afterIndex &&
    head === afterHead &&
    files.every((file) => file.physicalStatus === "measured") &&
    changedPaths.length === 0 &&
    validationFailures.length === 0;
  const capture = {
    files,
    head,
    afterHead,
    indexSha256: sha256(index),
    afterIndexSha256: afterIndex === null ? null : sha256(afterIndex),
    sourceStable,
    changedPaths,
    validationFailures,
    boundsExceeded,
    exclusions: {
      trackedPaths: tracked.size,
      selectedSourcePaths: files.length,
      byReason: Object.fromEntries(
        Object.entries(excluded).sort(([a], [b]) => a.localeCompare(b, "en")),
      ),
    },
  };
  const { root: ignoredRoot, help: ignoredHelp, ...bounds } = options;
  const runtime = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    typescript: analysis.typescript,
    toolPins,
    observations: options.stable
      ? null
      : {
          captureAndAnalysisElapsedMs:
            Math.round((performance.now() - started) * 1000) / 1000,
          coordinatorPeakRssBeforeReportBytes:
            process.resourceUsage().maxRSS * 1024,
          worker: analysis.observations,
          scope:
            "inventory capture/analysis before report formatting; not product/test/engine performance",
        },
  };
  return buildReport(capture, analysis, bounds, runtime);
}

export async function runInventoryCli(args, hooks = {}) {
  const output = hooks.output ?? ((value) => process.stdout.write(value));
  const errorOutput =
    hooks.error ?? ((value) => process.stderr.write(`${value}\n`));
  let options;
  try {
    options = parseInventoryArgs(args);
  } catch (error) {
    errorOutput(error.message);
    return 2;
  }
  if (options.help) {
    output(HELP);
    return 0;
  }
  try {
    const report = await (hooks.inspect ?? inspectRefactorScope)(options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(json) > options.maxReportBytes)
      throw new Error("max-report-bytes");
    output(json);
    return report.complete ? 0 : 1;
  } catch (error) {
    output(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          workItem: "RF-01",
          kind: "owned-code-refactor-inventory",
          complete: false,
          refactorAcceptance: false,
          state: "measurement-failed",
          executionStatus: "failed",
          failure: String(error.code ?? error.message).slice(0, 160),
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await runInventoryCli(process.argv.slice(2));
}
