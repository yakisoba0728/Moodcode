import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export const PROJECTS = [
  "packages/contracts",
  "packages/engine",
  "apps/engine-harness",
];
// This is a deliberate partial Windows gate. Adding a fixture requires portability review.
export const WINDOWS_STORAGE_TESTS = [
  "storage",
  "migrations",
  "native-inbox",
  "native-records",
  "native-documents-history",
  "history-search",
  "next-stage-history-metrics",
  "terminal-approval",
];
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const resultsDir = resolve(
  process.env.MOODCODE_CI_RESULTS_DIR ?? join(root, "artifacts", "engine-ci"),
);
const recordPath = join(resultsDir, "steps.json");
const require = createRequire(import.meta.url);

export function commandPlan(mode) {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  switch (mode) {
    case "typecheck":
      return [process.execPath, tsc, "-b", ...PROJECTS, "--pretty", "false"];
    case "build":
      return [
        process.execPath,
        tsc,
        "-b",
        ...PROJECTS,
        "--force",
        "--pretty",
        "false",
      ];
    case "prepare-pty":
      return [process.execPath, join(root, "scripts", "prepare-pty.mjs")];
    case "test":
      return [process.execPath, join(root, "scripts", "test-engine.mjs")];
    case "eval":
      return [process.execPath, join(root, "scripts", "evaluate-engine.mjs")];
    case "test-windows":
      return [
        process.execPath,
        "--test",
        "--test-concurrency=4",
        "<all contracts/dist/*.test.js>",
        ...WINDOWS_STORAGE_TESTS.map(
          (name) => `packages/engine/dist/storage/${name}.test.js`,
        ),
        "packages/engine/dist/tools/command/backends.test.js",
      ];
    default:
      throw new Error(`Unknown CI operation: ${mode}`);
  }
}

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await collect(path)));
    else if (entry.name.endsWith(".test.js")) result.push(path);
  }
  return result.sort();
}

export async function windowsTestFiles(projectRoot = root) {
  const contracts = await collect(
    join(projectRoot, "packages", "contracts", "dist"),
  );
  if (!contracts.length)
    throw new Error("Windows partial gate found no compiled contract tests");
  const files = [
    ...contracts,
    ...WINDOWS_STORAGE_TESTS.map((name) =>
      join(
        projectRoot,
        "packages",
        "engine",
        "dist",
        "storage",
        `${name}.test.js`,
      ),
    ),
    join(
      projectRoot,
      "packages",
      "engine",
      "dist",
      "tools",
      "command",
      "backends.test.js",
    ),
  ];
  await Promise.all(files.map((path) => readFile(path)));
  return files;
}

function metadata() {
  return {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    lane: process.env.MOODCODE_CI_LANE ?? "local-configuration-check",
    commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")
      ? process.env.GITHUB_SHA
      : null,
    checkedAt: new Date().toISOString(),
    projects: PROJECTS,
    windowsJobObject: {
      available: false,
      actualVerification: false,
      reason:
        "No native Job Object binding is supplied; portable port fixtures are not OS proof.",
    },
    liveProviderRequests: false,
    guiLaunch: false,
  };
}

async function record(step) {
  let previous = { schemaVersion: 1, steps: [] };
  try {
    previous = JSON.parse(await readFile(recordPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  previous.steps.push(step);
  await writeFile(
    `${recordPath}.tmp`,
    `${JSON.stringify(previous, null, 2)}\n`,
  );
  await rename(`${recordPath}.tmp`, recordPath);
}

async function run(mode, argv) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const log = createWriteStream(join(resultsDir, `${mode}.log`));
  const stdout = createWriteStream(join(resultsDir, `${mode}.stdout`));
  const stderr = createWriteStream(join(resultsDir, `${mode}.stderr`));
  let failure;
  let status;
  try {
    status = await new Promise((resolveStatus, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: root,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(stdout);
      child.stderr.pipe(stderr);
      child.stdout.on("data", (bytes) => {
        process.stdout.write(bytes);
        log.write(bytes);
      });
      child.stderr.on("data", (bytes) => {
        process.stderr.write(bytes);
        log.write(bytes);
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolveStatus({ code, signal }));
    });
  } catch (error) {
    failure = error.message;
    log.write(`${failure}\n`);
  } finally {
    for (const stream of [stdout, stderr, log]) {
      if (!stream.writableEnded) stream.end();
      await new Promise((resolveEnd, reject) => {
        if (stream.writableFinished) resolveEnd();
        else {
          stream.once("finish", resolveEnd);
          stream.once("error", reject);
        }
      });
    }
  }
  await record({
    operation: mode,
    command: argv,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    exitCode: status?.code ?? null,
    signal: status?.signal ?? null,
    state: !failure && status?.code === 0 ? "passed" : "failed",
    ...(failure ? { failure } : {}),
  });
  return failure ? 1 : (status?.code ?? 1);
}

async function summary() {
  const data = metadata();
  let steps = [];
  try {
    steps = JSON.parse(await readFile(recordPath, "utf8")).steps;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const outcome = {
    ...data,
    installOutcome:
      process.env.MOODCODE_CI_INSTALL_OUTCOME ?? "not-run-locally",
    jobStatus: process.env.MOODCODE_CI_JOB_STATUS ?? "not-a-github-run",
    steps,
    ciRunConfirmed: process.env.GITHUB_ACTIONS === "true",
    windowsFullEngineVerified: false,
  };
  await writeFile(
    join(resultsDir, "results.json"),
    `${JSON.stringify(outcome, null, 2)}\n`,
  );
  const text = [
    `Moodcode headless CI: ${data.lane}`,
    `Actual host: ${data.platform}/${data.architecture}, ${data.node}`,
    `Job: ${outcome.jobStatus}; install: ${outcome.installOutcome}`,
    ...steps.map(
      (step) => `- ${step.operation}: ${step.state} (exit ${step.exitCode})`,
    ),
    "Windows Job Object/process-tree/crash verification: unavailable; Windows lane is partial.",
    "No live model credentials or Electron GUI are used.",
  ].join("\n");
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

export async function main(mode) {
  await mkdir(resultsDir, { recursive: true });
  if (mode === "metadata" || mode === "plan") {
    const data = {
      ...metadata(),
      plannedCommands: Object.fromEntries(
        [
          "prepare-pty",
          "typecheck",
          "build",
          "test",
          "test-windows",
          "eval",
        ].map((operation) => [operation, commandPlan(operation)]),
      ),
      windowsStorageSelection: WINDOWS_STORAGE_TESTS,
    };
    await writeFile(
      join(resultsDir, "environment.json"),
      `${JSON.stringify(data, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  if (mode === "summary") {
    await summary();
    return 0;
  }
  let argv = commandPlan(mode);
  if (mode === "test-windows")
    argv = [
      process.execPath,
      "--test",
      "--test-concurrency=4",
      ...(await windowsTestFiles()),
    ];
  const exitCode = await run(mode, argv);
  if (mode === "eval") {
    try {
      const result = JSON.parse(
        await readFile(join(resultsDir, "eval.stdout"), "utf8"),
      );
      await writeFile(
        join(resultsDir, "evaluation.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    } catch (error) {
      if (exitCode === 0) throw error;
    }
  }
  if (exitCode !== 0) return exitCode;
  if (mode === "prepare-pty") {
    if (process.platform === "darwin" || process.platform === "linux") {
      let pty;
      try {
        pty = require("node-pty");
        if (typeof pty.spawn !== "function")
          throw new Error(
            "POSIX CI requires the optional native node-pty implementation",
          );
      } catch (error) {
        await record({
          operation: "pty-native-module",
          state: "failed",
          exitCode: 1,
          failure: error.message,
        });
        throw error;
      }
      await record({
        operation: "pty-native-module",
        state: "passed",
        exitCode: 0,
      });
      await writeFile(
        join(resultsDir, "pty-capability.json"),
        JSON.stringify({
          available: true,
          platform: process.platform,
          package: "node-pty",
          helperPrepared: true,
          actualPtyVerified: false,
        }),
      );
    } else
      await writeFile(
        join(resultsDir, "pty-capability.json"),
        JSON.stringify({
          available: false,
          platform: process.platform,
          reason:
            "This partial lane does not verify a Windows PTY or Job Object implementation",
        }),
      );
  }
  if (mode === "eval") {
    const result = JSON.parse(
      await readFile(join(resultsDir, "eval.stdout"), "utf8"),
    );
    if (
      result.schemaVersion !== 1 ||
      result.kind !== "engine-fixture-evaluation" ||
      !Array.isArray(result.tasks) ||
      result.tasks.length !== 3 ||
      result.tasks.some((task) => task.passed !== true)
    )
      throw new Error(
        "Engine fixture evaluation did not produce three passing local scripted tasks",
      );
    await writeFile(
      join(resultsDir, "evaluation.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return 0;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main(process.argv[2] ?? "plan")
    .then((code) => {
      process.exitCode = code;
    })
    .catch(async (error) => {
      await mkdir(resultsDir, { recursive: true });
      await appendFile(
        join(resultsDir, "launcher-error.log"),
        `${error.message}\n`,
      );
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
