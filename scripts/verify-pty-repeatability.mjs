import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, release } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PTY_SCENARIOS = [
  "normal-exit",
  "input-resize",
  "cancel",
  "supervisor-death",
  "ipc-disconnect",
];
export const PTY_REPEATABILITY_HELP = `Usage: node scripts/verify-pty-repeatability.mjs [options]
  --runtime compiled|source   Default compiled; source uses the absolute local tsx loader
  --iterations 1..32          Default 8; deterministic iteration/scenario order
  --scenarios NAMES           Comma-separated subset; default all five scenarios
  --timeout-ms 1000..15000    Per-boundary deadline (default 10000)
  --max-duration-ms 10000..900000  Entire batch budget (default 120000)
  --output NEW_DIRECTORY      Retain reports, actual SQLite and artifacts (default fresh OS temp)
  --report PATH               Also select the aggregate JSON report path
  --json                      Emit the aggregate JSON on stdout; progress goes to stderr
  --help                      Validate no runtime or native dependency

Exit 0: passed; 1: failed; 2: unsupported/invalid CLI. Every fixture is retained.
Supported POSIX native PTY observations only; no Windows native qualification.
Repeated passes do not identify or resolve historical R-PTY-01.
`;
const repository = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function integer(value, min, max) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value))
    throw new Error("Expected a bounded decimal integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error("Integer option is out of bounds");
  return parsed;
}
export function parsePtyRepeatabilityArgs(args) {
  const options = {
    runtime: "compiled",
    iterations: 8,
    scenarios: [...PTY_SCENARIOS],
    timeoutMs: 10000,
    maxDurationMs: 120000,
  };
  const seen = new Set();
  if (args.length === 1 && args[0] === "--help") return { help: true };
  for (let at = 0; at < args.length; at++) {
    const name = args[at];
    if (name === "--json" && !seen.has(name)) {
      seen.add(name);
      options.json = true;
      continue;
    }
    if (
      ![
        "--runtime",
        "--iterations",
        "--scenarios",
        "--timeout-ms",
        "--max-duration-ms",
        "--output",
        "--report",
      ].includes(name) ||
      seen.has(name)
    )
      throw new Error("Unknown or duplicate option");
    seen.add(name);
    const value = args[++at];
    if (!value || value.startsWith("--") || value.includes("\0"))
      throw new Error("Missing or invalid option value");
    if (name === "--runtime") {
      if (!["compiled", "source"].includes(value))
        throw new Error("Invalid runtime");
      options.runtime = value;
    } else if (name === "--iterations")
      options.iterations = integer(value, 1, 32);
    else if (name === "--timeout-ms")
      options.timeoutMs = integer(value, 1000, 15000);
    else if (name === "--max-duration-ms")
      options.maxDurationMs = integer(value, 10000, 900000);
    else if (name === "--scenarios") {
      const names = value.split(",");
      if (
        !names.length ||
        names.some((item) => !PTY_SCENARIOS.includes(item)) ||
        new Set(names).size !== names.length
      )
        throw new Error("Invalid scenarios");
      options.scenarios = PTY_SCENARIOS.filter((item) => names.includes(item));
    } else options[name === "--output" ? "output" : "report"] = resolve(value);
  }
  return options;
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${path}.tmp`, path);
}
function readJson(path, maxBytes = 2_097_152) {
  const bytes = readFileSync(path);
  assert.ok(
    bytes.length <= maxBytes,
    "Repeatability evidence exceeds its byte bound",
  );
  return JSON.parse(bytes.toString("utf8"));
}
function filePin(path) {
  const canonical = realpathSync(path),
    bytes = readFileSync(canonical);
  return { path: canonical, bytes: bytes.length, sha256: sha256(bytes) };
}
function runtimePins(runtime) {
  const pins = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    release: release(),
    executable: filePin(process.execPath),
    files: [filePin(fileURLToPath(import.meta.url))],
    nodePty: null,
  };
  if (runtime === "source")
    pins.files.push(
      filePin(join(repository, "node_modules/tsx/dist/loader.mjs")),
    );
  if (existsSync(join(repository, "package-lock.json")))
    pins.files.push(filePin(join(repository, "package-lock.json")));
  const require = createRequire(import.meta.url);
  try {
    const packagePath = require.resolve("node-pty/package.json"),
      packageData = JSON.parse(readFileSync(packagePath, "utf8"));
    const utilsPath = require.resolve("node-pty/lib/utils.js"),
      native = require(utilsPath).loadNativeModule("pty");
    const nativeDirectory = resolve(dirname(utilsPath), native.dir);
    pins.nodePty = {
      version: packageData.version,
      files: [
        packagePath,
        require.resolve("node-pty"),
        utilsPath,
        join(dirname(utilsPath), "unixTerminal.js"),
        join(nativeDirectory, "pty.node"),
        ...(process.platform === "darwin"
          ? [join(nativeDirectory, "spawn-helper")]
          : []),
      ].map(filePin),
    };
  } catch {
    /* The genuine backend capability reports unavailable native support. */
  }
  if (["darwin", "linux", "freebsd"].includes(process.platform))
    pins.files.push(...["/bin/sh", "/bin/ps"].map(filePin));
  return pins;
}
function childRun(args, timeoutMs, logPrefix) {
  return new Promise((done) => {
    let stdout = "",
      stderr = "",
      timedOut = false,
      settled = false,
      escalated = false;
    let escalation;
    const child = spawn(process.execPath, args, {
      cwd: repository,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        escalated = true;
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-8192);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      writeFileSync(`${logPrefix}.stdout.log`, stdout, { mode: 0o600 });
      writeFileSync(`${logPrefix}.stderr.log`, stderr, { mode: 0o600 });
      done({
        exitCode,
        signal,
        timedOut,
        escalated,
        ...(error ? { error: String(error.message).slice(0, 1024) } : {}),
      });
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (code, signal) => finish(code, signal));
  });
}
function observeTimedOutCase(data) {
  const pids = new Set([
    data.nativePid,
    data.supervisor?.pid,
    ...(data.processSnapshot ?? []).map((row) => row.pid),
  ]);
  const observations = [];
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      observations.push({ pid, presence: "present" });
    } catch (error) {
      observations.push({
        pid,
        presence: error.code === "ESRCH" ? "absent" : "unknown",
        errorCode: error.code ?? "UNKNOWN",
      });
    }
  }
  return {
    authority: "observation-only",
    physicalOwnershipRestored: false,
    cleanupConfirmed: false,
    pids: observations,
  };
}
export async function verifyPtyRepeatability(
  options,
  output = (text) => process.stdout.write(text),
) {
  const directory =
    options.output ??
    mkdtempSync(join(tmpdir(), "moodcode-pty-repeatability-"));
  if (options.output) mkdirSync(directory, { mode: 0o700 });
  const reportPath = options.report ?? join(directory, "report.json"),
    started = performance.now();
  const report = {
    schemaVersion: 1,
    kind: "native-pty-repeatability",
    status: "running",
    nativeQualified: false,
    noLive: true,
    liveProviderRequests: 0,
    credentialsRead: false,
    startedAt: new Date().toISOString(),
    runtime: options.runtime,
    requestedIterations: options.iterations,
    requestedScenarios: options.scenarios,
    timeoutMs: options.timeoutMs,
    maxDurationMs: options.maxDurationMs,
    evidenceDirectory: directory,
    reportPath,
    retainedEvidence: true,
    historicalRpty01: {
      causeConfirmed: false,
      reproduced: false,
      resolved: false,
    },
    cases: [],
    errors: [],
    identityStable: false,
  };
  const save = () => writeJson(reportPath, report);
  save();
  const worker = join(
    repository,
    "packages/engine",
    options.runtime === "source" ? "src" : "dist",
    "terminals",
    `repeatability-worker.${options.runtime === "source" ? "ts" : "js"}`,
  );
  const loader = join(repository, "node_modules/tsx/dist/loader.mjs");
  const prefix = [
    ...(options.runtime === "source" ? ["--import", loader] : []),
    worker,
  ];
  let beforeIdentity;
  try {
    if (!existsSync(worker))
      throw new Error(
        `Selected runtime worker is absent: ${relative(repository, worker)}; build before compiled verification`,
      );
    report.runtimePins = runtimePins(options.runtime);
    const identityPath = join(directory, "identity-before.json");
    const before = await childRun(
      [...prefix, "--identity", identityPath],
      Math.min(15000, options.maxDurationMs),
      join(directory, "identity-before"),
    );
    assert.equal(
      before.exitCode,
      0,
      "Source/runtime inventory failed; see retained identity worker logs",
    );
    beforeIdentity = readJson(identityPath);
    assert.equal(beforeIdentity.runtime, options.runtime);
    report.sourceIdentity = beforeIdentity;
    save();
    if (!["darwin", "linux", "freebsd"].includes(process.platform)) {
      report.status = "unsupported";
      report.errors.push({
        phase: "capability",
        code: "PTY_PLATFORM_UNSUPPORTED",
      });
    } else {
      let stopped = false;
      for (
        let iteration = 1;
        iteration <= options.iterations && !stopped;
        iteration++
      )
        for (const scenario of options.scenarios) {
          const remaining =
            options.maxDurationMs - (performance.now() - started);
          if (remaining <= 0)
            throw new Error("PTY_REPEATABILITY_BATCH_TIMEOUT");
          const caseDirectory = join(
            directory,
            `${String(iteration).padStart(3, "0")}-${scenario}`,
          );
          mkdirSync(caseDirectory, { mode: 0o700 });
          const child = await childRun(
            [
              ...prefix,
              scenario,
              String(iteration),
              caseDirectory,
              String(options.timeoutMs),
            ],
            Math.min(remaining, options.timeoutMs * 3 + 17000),
            join(caseDirectory, "worker"),
          );
          const casePath = join(caseDirectory, "case.json");
          const data = existsSync(casePath)
            ? readJson(casePath, 131072)
            : {
                schemaVersion: 1,
                scenario,
                iteration,
                status: "failed",
                evidencePath: casePath,
                errors: [
                  {
                    phase: "worker-start",
                    code: "PTY_REPEATABILITY_NO_EVIDENCE",
                  },
                ],
              };
          assert.equal(data.scenario, scenario);
          assert.equal(data.iteration, iteration);
          data.worker = child;
          if (
            child.timedOut ||
            child.exitCode !==
              (data.status === "passed"
                ? 0
                : data.status === "unsupported"
                  ? 2
                  : 1) ||
            data.status === "running"
          ) {
            data.status = "failed";
            data.errors.push({
              phase: "worker",
              code: child.timedOut
                ? "PTY_REPEATABILITY_WORKER_TIMEOUT"
                : "PTY_REPEATABILITY_WORKER_FAILED",
            });
            if (child.timedOut)
              data.watchdogObservation = observeTimedOutCase(data);
          }
          writeJson(casePath, data);
          report.cases.push(data);
          output(
            `PTY ${iteration}/${options.iterations} ${scenario}: ${data.status}\n`,
          );
          save();
          if (data.status !== "passed") {
            stopped = true;
            break;
          }
        }
    }
  } catch (error) {
    report.errors.push({
      phase: "batch",
      code: error.code ?? "PTY_REPEATABILITY_FAILED",
      message: String(error.message).slice(0, 1024),
    });
  }
  if (beforeIdentity) {
    try {
      const remaining = options.maxDurationMs - (performance.now() - started);
      if (remaining <= 0)
        throw Object.assign(new Error("PTY_REPEATABILITY_BATCH_TIMEOUT"), {
          code: "PTY_REPEATABILITY_BATCH_TIMEOUT",
        });
      const afterPath = join(directory, "identity-after.json");
      const after = await childRun(
        [
          ...prefix,
          "--identity",
          afterPath,
          join(directory, "identity-before.json"),
        ],
        Math.min(15000, remaining),
        join(directory, "identity-after"),
      );
      if (existsSync(afterPath)) {
        const afterIdentity = readJson(afterPath);
        report.finalSourceSha256 = afterIdentity.sourceSha256;
        if (
          beforeIdentity.sourceSha256 !== afterIdentity.sourceSha256 ||
          beforeIdentity.gitHead !== afterIdentity.gitHead ||
          beforeIdentity.runtime !== afterIdentity.runtime
        )
          throw Object.assign(new Error("Source/runtime identity changed"), {
            code: "PTY_REPEATABILITY_IDENTITY_CHANGED",
          });
      }
      assert.equal(
        after.exitCode,
        0,
        "Final inventory failed; see identity worker logs",
      );
      assert.deepEqual(runtimePins(options.runtime), report.runtimePins);
      report.identityStable = true;
    } catch (error) {
      report.errors.push({
        phase: "identity",
        code:
          error.code === "ERR_ASSERTION"
            ? "PTY_REPEATABILITY_IDENTITY_UNVERIFIED"
            : (error.code ?? "PTY_REPEATABILITY_IDENTITY_UNVERIFIED"),
        message: String(error.message).slice(0, 1024),
      });
    }
  }
  const expected = options.iterations * options.scenarios.length;
  report.completedCases = report.cases.length;
  if (report.errors.length && report.status !== "unsupported")
    report.status = "failed";
  else if (report.cases.some((item) => item.status === "failed"))
    report.status = "failed";
  else if (
    report.status === "unsupported" ||
    report.cases.some((item) => item.status === "unsupported")
  )
    report.status = "unsupported";
  else
    report.status =
      report.cases.length === expected && report.identityStable
        ? "passed"
        : "failed";
  report.nativeQualified = report.status === "passed";
  report.durationMs = performance.now() - started;
  save();
  output(
    `PTY repeatability ${report.status}; retained report: ${reportPath}\n`,
  );
  return report;
}
export async function runPtyRepeatabilityCli(
  args,
  output = (text) => process.stdout.write(text),
  error = (text) => process.stderr.write(text),
) {
  let options;
  try {
    options = parsePtyRepeatabilityArgs(args);
  } catch (cause) {
    error(`Invalid PTY repeatability CLI: ${cause.message}\n`);
    return 2;
  }
  if (options.help) {
    output(PTY_REPEATABILITY_HELP);
    return 0;
  }
  try {
    const report = await verifyPtyRepeatability(
      options,
      options.json ? error : output,
    );
    if (options.json) output(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === "passed"
      ? 0
      : report.status === "unsupported"
        ? 2
        : 1;
  } catch (cause) {
    error(`PTY repeatability failed: ${cause.message}\n`);
    return 1;
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  process.exitCode = await runPtyRepeatabilityCli(process.argv.slice(2));
