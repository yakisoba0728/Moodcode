import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { assertDatabaseContractEqual } from "../../scripts/inspect-engine-db-contract.mjs";
import {
  validatePersistentSoakReport,
  validatePtyRepeatabilityReport,
} from "./followup-reports.mjs";
import { preserveFollowupEvidence } from "./followup-evidence.mjs";

export const PROJECTS = [
  "packages/contracts",
  "packages/engine",
  "apps/engine-harness",
];
// This is a deliberate partial Windows gate. Adding a fixture requires portability review.
export const WINDOWS_STORAGE_TESTS = [
  "storage",
  "fixture-lifetime",
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
const LOCAL_REPORT_MODES = new Set([
  "eval",
  "resilience",
  "benchmark",
  "db-contract",
  "persistent-soak",
  "pty-repeatability",
]);
const databaseBaselinePath = join(
  root,
  "docs/moodcode/next-db-contract-baseline.json",
);

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
    case "test-media-local":
      return [
        process.execPath,
        "--test",
        "--test-concurrency=1",
        join(root, "scripts", "plan-media-verification.test.mjs"),
        join(root, "scripts", "verify-media-account.test.mjs"),
      ];
    case "test-hardening-cli":
      return [
        process.execPath,
        "--import",
        join(root, "node_modules", "tsx", "dist", "loader.mjs"),
        "--test",
        "--test-concurrency=1",
        join(root, "scripts", "verify-engine-resilience.test.mjs"),
        join(root, "scripts", "inspect-engine-db-contract.test.mjs"),
        join(root, "scripts", "verify-engine-persistent-soak.test.mjs"),
        join(root, "scripts", "verify-pty-repeatability.test.mjs"),
        join(root, "scripts", "verify-provider-coverage.test.mjs"),
        join(root, "scripts", "verify-provider-coverage-anthropic.test.mjs"),
        join(root, "scripts", "verify-provider-coverage-pdf.test.mjs"),
        join(root, "scripts", "verify-provider-coverage-media.test.mjs"),
        join(root, ".github", "scripts", "followup-reports.test.mjs"),
        join(root, ".github", "scripts", "followup-evidence.test.mjs"),
      ];
    case "eval":
      return [process.execPath, join(root, "scripts", "evaluate-engine.mjs")];
    case "resilience":
      return [
        process.execPath,
        join(root, "scripts", "verify-engine-resilience.mjs"),
        "--profile",
        "quick",
        "--runtime",
        "compiled",
      ];
    case "benchmark":
      return [
        process.execPath,
        join(root, "scripts", "benchmark-engine.mjs"),
        "--profile",
        "quick",
        "--runtime",
        "compiled",
      ];
    case "db-contract":
      return [
        process.execPath,
        join(root, "scripts", "inspect-engine-db-contract.mjs"),
        "--runtime",
        "compiled",
        "--compare",
        databaseBaselinePath,
      ];
    case "persistent-soak":
      return [
        process.execPath,
        join(root, "scripts", "verify-engine-persistent-soak.mjs"),
        "--profile",
        "quick",
        "--runtime",
        "compiled",
      ];
    case "pty-repeatability":
      return [
        process.execPath,
        join(root, "scripts", "verify-pty-repeatability.mjs"),
        "--json",
        "--runtime",
        "compiled",
        "--iterations",
        "3",
      ];
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

// A successful child exit alone does not certify a complete local report.
export function validateLocalReport(mode, result, databaseBaseline) {
  const reject = () => {
    throw new Error(`Invalid or incomplete local ${mode} report`);
  };
  if (!result || typeof result !== "object" || Array.isArray(result)) reject();
  if (mode === "persistent-soak") return validatePersistentSoakReport(result);
  if (mode === "pty-repeatability")
    return validatePtyRepeatabilityReport(result);
  if (result.passed !== true || result.noLive !== true) reject();
  if (mode === "db-contract") {
    if (
      result.schemaVersion !== 1 ||
      result.kind !== "engine-primary-db-contract" ||
      result.runtime?.mode !== "compiled" ||
      result.comparison?.equal !== true ||
      result.comparison.sha256 !== result.catalogue?.sha256 ||
      !/^[a-f0-9]{64}$/.test(result.moduleSha256 ?? "") ||
      !Array.isArray(result.catalogue?.objects) ||
      result.catalogue.objects.length > 1024
    )
      reject();
    assertDatabaseContractEqual(result.catalogue, databaseBaseline?.catalogue);
    return result;
  }
  if (mode === "resilience") {
    if (
      result.schemaVersion !== 1 ||
      result.kind !== "engine-resilience-soak" ||
      result.supported !== true ||
      result.runtime?.mode !== "compiled" ||
      !Number.isSafeInteger(result.iterations) ||
      result.iterations < 3 ||
      !Array.isArray(result.results) ||
      result.results.length !== result.iterations ||
      result.results.some(
        (item) =>
          item.passed !== true ||
          item.noReplay !== true ||
          item.cleanup?.engineClosed !== true ||
          item.cleanup?.physicalGroupAbsent !== true ||
          item.cleanup?.databaseRemoved !== true,
      )
    )
      reject();
    const scenarios = new Set(result.results.map((item) => item.scenario));
    if (
      !["complete", "cancel", "root-sigkill"].every((value) =>
        scenarios.has(value),
      )
    )
      reject();
    const sha = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
    if (
      !sha(result.source?.harnessEntrySha256) ||
      !sha(result.source?.engineEntrySha256) ||
      result.summary?.completed !== result.iterations ||
      result.summary?.failed !== 0 ||
      result.summary?.cleanupFailures !== 0 ||
      result.summary?.processLaunches !== result.iterations ||
      new Set(result.results.map((item) => item.iteration)).size !==
        result.iterations
    )
      reject();
    let observedCalls = 0,
      unknownOutcomes = 0;
    for (const item of result.results) {
      const native = item.native;
      if (
        !Number.isSafeInteger(item.iteration) ||
        item.iteration < 0 ||
        item.iteration >= result.iterations ||
        item.processLaunches !== 1 ||
        !native ||
        !sha(native.sourceConfigSha256) ||
        !sha(native.job?.sha256) ||
        native.cancelledInputState !== "cancelled" ||
        native.tokens !== null ||
        native.cost !== null ||
        !Number.isSafeInteger(item.providerCalls?.command) ||
        item.providerCalls.command < 1 ||
        item.providerCalls.command > 2 ||
        !Number.isSafeInteger(item.providerCalls?.observer) ||
        item.providerCalls.observer < 0 ||
        item.providerCalls.observer > 1
      )
        reject();
      // Known cancellation may explicitly consume the original queued input.
      // This never permits replay of the cancelled command or an unknown effect.
      const queuedObserver =
        item.scenario === "cancel" &&
        native.job.state === "cancelled" &&
        native.resumeOutcome === "resumed" &&
        native.pendingInputState === "promoted"
          ? 1
          : 0;
      if (item.providerCalls?.reopened !== queuedObserver) reject();
      observedCalls +=
        item.providerCalls.command +
        item.providerCalls.observer +
        item.providerCalls.reopened;
      for (const phase of ["beforeReopen", "afterReopen"]) {
        const observation = native[phase];
        if (
          !sha(observation?.recordsSha256) ||
          observation.counts?.tools !== 1 ||
          observation.counts?.session_inputs !== 3 ||
          !Number.isSafeInteger(observation.counts?.runs) ||
          observation.counts.runs < 1 ||
          observation.counts.runs > 2
        )
          reject();
      }
      if (
        item.scenario === "complete" &&
        (native.job.state !== "completed" ||
          !sha(native.job.completionSha256) ||
          native.sourceRunState !== "completed" ||
          native.pendingInputState !== "promoted")
      )
        reject();
      if (
        item.scenario === "cancel" &&
        (!["cancelled", "uncertain"].includes(native.job.state) ||
          native.sourceRunState !== "cancelled")
      )
        reject();
      if (native.job.state === "cancelled" && !sha(native.job.completionSha256))
        reject();
      if (
        item.scenario === "root-sigkill" &&
        (native.job.state !== "uncertain" ||
          native.job.completionSha256 !== null ||
          native.sourceRunState !== "interrupted")
      )
        reject();
      if (native.job.state === "uncertain") {
        unknownOutcomes++;
        if (
          native.resumeOutcome !== "cleanup-pending" ||
          native.pendingInputState !== "pending"
        )
          reject();
      }
    }
    if (
      result.summary.providerCalls !== observedCalls ||
      result.summary.unknownOutcomes !== unknownOutcomes
    )
      reject();
    return result;
  }
  if (!["eval", "benchmark"].includes(mode)) reject();
  const identity = result.sourceRuntime;
  if (
    result.providerId !== "scripted" ||
    result.modelId !== "local" ||
    result.accountVerified !== false ||
    result.liveRequests !== 0 ||
    result.credentialsRead !== false ||
    result.modelQualityEvaluated !== false ||
    identity?.stable !== true ||
    identity.before?.runtime !== "compiled" ||
    identity.after?.runtime !== "compiled" ||
    !/^[a-f0-9]{64}$/.test(identity.before?.sourceSha256 ?? "") ||
    identity.before.sourceSha256 !== identity.after?.sourceSha256 ||
    identity.before.gitHead !== identity.after?.gitHead
  )
    reject();
  if (mode === "eval") {
    if (
      result.schemaVersion !== 2 ||
      result.kind !== "engine-fixture-evaluation" ||
      !Array.isArray(result.tasks) ||
      result.tasks.length !== 3 ||
      result.tasks.some((task) => task.passed !== true)
    )
      reject();
    if (
      result.commitMode !== "approved" ||
      result.tasks.some(
        (task) =>
          task.verification?.taskVerified !== true ||
          task.checks?.processCleanupConfirmed !== true ||
          task.cleanup?.engineClosed !== true ||
          task.cleanup?.temporaryFilesRemoved !== true ||
          task.commit?.requested !== true ||
          task.commit?.state !== "committed" ||
          task.commit?.duplicateNoSecondCommit !== true ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(task.commit?.sha ?? ""),
      )
    )
      reject();
    const ids = result.tasks.map((task) => task.taskId).sort();
    if (
      JSON.stringify(ids) !==
      JSON.stringify([
        "addition-bug",
        "empty-list-boundary",
        "two-module-change",
      ])
    )
      reject();
  } else {
    if (
      result.schemaVersion !== 1 ||
      result.kind !== "native-engine-performance-baseline" ||
      result.absoluteTimingGate !== false ||
      result.cleanup?.engineClosed !== true ||
      result.cleanup?.temporaryFilesRemoved !== true ||
      result.fixture?.historyPaginationExact !== true ||
      result.fixture?.reopenedWithoutProviderReplay !== true ||
      result.summary?.state !== "completed" ||
      result.summary?.cleanupConfirmed !== true
    )
      reject();
    for (const key of [
      "history",
      "modelHistory",
      "contextRun",
      "contextObservation",
      "metrics",
      "eventReplay",
      "summaryUsage",
      "summaryAttempt",
      "summaryList",
      "storageInspection",
    ]) {
      const latency = result.measurements?.[key]?.latency;
      if (
        !Number.isSafeInteger(latency?.count) ||
        latency.count < 3 ||
        ![latency.min, latency.p50, latency.p95, latency.max].every(
          (value) => Number.isFinite(value) && value >= 0,
        ) ||
        latency.min > latency.p50 ||
        latency.p50 > latency.p95 ||
        latency.p95 > latency.max
      )
        reject();
    }
  }
  return result;
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
  // The executor tests use loopback HTTP and explicit fixture capabilities.
  // Force built engine modules; this stage never invokes an account CLI with --live.
  const environmentOverrides =
    mode === "test-media-local"
      ? { MOODCODE_MEDIA_VERIFY_TEST_ENGINE: "compiled" }
      : {};
  try {
    status = await new Promise((resolveStatus, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: root,
        env: { ...process.env, ...environmentOverrides },
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
    ...(mode === "test-media-local" ? { environmentOverrides } : {}),
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
          "test-media-local",
          "test-hardening-cli",
          "test-windows",
          "eval",
          "resilience",
          "benchmark",
          "db-contract",
          "persistent-soak",
          "pty-repeatability",
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
  if (LOCAL_REPORT_MODES.has(mode)) {
    try {
      const result = JSON.parse(
        await readFile(join(resultsDir, `${mode}.stdout`), "utf8"),
      );
      await writeFile(
        join(resultsDir, mode === "eval" ? "evaluation.json" : `${mode}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      if (["persistent-soak", "pty-repeatability"].includes(mode)) {
        try {
          const evidence = await preserveFollowupEvidence(
            mode,
            result,
            await realpath(resultsDir),
          );
          await writeFile(
            join(resultsDir, `${mode}-evidence.json`),
            `${JSON.stringify(evidence, null, 2)}\n`,
          );
          if (
            exitCode === 0 &&
            (!evidence.sourceQualified || !evidence.exactSourceCopy)
          )
            throw new Error(
              "Passing followup requires an exact retained fixture copy",
            );
          await record({
            operation: `${mode}-evidence`,
            state: evidence.status === "preserved" ? "passed" : "unavailable",
            exitCode: evidence.status === "preserved" ? 0 : 1,
          });
        } catch (error) {
          if (error.evidence)
            await writeFile(
              join(resultsDir, `${mode}-evidence.json`),
              `${JSON.stringify(error.evidence, null, 2)}\n`,
            );
          await record({
            operation: `${mode}-evidence`,
            state: "failed",
            exitCode: 1,
            failure: error.message,
          });
          return 1;
        }
      }
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
  if (LOCAL_REPORT_MODES.has(mode)) {
    const result = JSON.parse(
      await readFile(join(resultsDir, `${mode}.stdout`), "utf8"),
    );
    try {
      const baseline =
        mode === "db-contract"
          ? JSON.parse(await readFile(databaseBaselinePath, "utf8"))
          : undefined;
      validateLocalReport(mode, result, baseline);
      await record({
        operation: `${mode}-report`,
        state: "passed",
        exitCode: 0,
      });
    } catch (error) {
      await record({
        operation: `${mode}-report`,
        state: "failed",
        exitCode: 1,
        failure: error.message,
      });
      throw error;
    }
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
