import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queueHardeningCliEvidence } from "../.github/scripts/engine-ci.mjs";
import {
  PTY_SCENARIOS,
  parsePtyRepeatabilityArgs,
  runPtyRepeatabilityWorker,
  runPtyRepeatabilityCli,
} from "./verify-pty-repeatability.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("PTY repeatability CLI defaults to compiled and bounds deterministic selection", () => {
  const defaults = parsePtyRepeatabilityArgs([]);
  assert.equal(defaults.runtime, "compiled");
  assert.equal(defaults.iterations, 8);
  assert.equal(parsePtyRepeatabilityArgs(["--json"]).json, true);
  assert.deepEqual(defaults.scenarios, PTY_SCENARIOS);
  assert.deepEqual(
    parsePtyRepeatabilityArgs(["--scenarios", "ipc-disconnect,normal-exit"])
      .scenarios,
    ["normal-exit", "ipc-disconnect"],
  );
  for (const args of [
    ["--iterations", "0"],
    ["--iterations", "33"],
    ["--iterations", "1.1"],
    ["--iterations", "01"],
    ["--timeout-ms", "999"],
    ["--max-duration-ms", "900001"],
    ["--runtime", "invented"],
    ["--scenarios", "normal-exit,normal-exit"],
    ["--scenarios", "fake"],
    ["--scenarios", ""],
    ["--help", "--iterations", "1"],
    ["--iterations"],
    ["--output", "bad\0path"],
    ["--runtime", "source", "--runtime", "source"],
    ["--unknown", "value"],
    ["--json", "--json"],
  ])
    assert.throws(() => parsePtyRepeatabilityArgs(args));
});

test("PTY repeatability help and invalid input never load a runtime or create evidence", async () => {
  const output = [],
    errors = [];
  assert.equal(
    await runPtyRepeatabilityCli(
      ["--help"],
      (text) => output.push(text),
      (text) => errors.push(text),
    ),
    0,
  );
  assert.match(output[0], /compiled\|source/);
  assert.match(
    output[0],
    /Repeated passes do not identify or resolve historical R-PTY-01/,
  );
  assert.equal(
    await runPtyRepeatabilityCli(
      ["--runtime", "fake"],
      (text) => output.push(text),
      (text) => errors.push(text),
    ),
    2,
  );
  assert.equal(errors.length, 1);
});

test(
  "actual worker close retains post-exit diagnostic tails with explicit byte bounds",
  { timeout: 5000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodcode-pty-worker-drain-")),
      prefix = join(directory, "worker");
    const script = `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify("setTimeout(() => { process.stdout.write('a'.repeat(16384) + 'FINAL_STDOUT_DIAGNOSTIC\\n'); process.stderr.write('b'.repeat(16384) + 'FINAL_STDERR_DIAGNOSTIC\\n'); }, 150)")}], { stdio: ['ignore', 1, 2] });
    child.unref();
    process.stdout.write('BEFORE_EXIT\\n');
  `;
    const result = await runPtyRepeatabilityWorker(
      ["--input-type=module", "-e", script],
      2000,
      prefix,
    );
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.exitObserved, true);
    assert.equal(result.closeObserved, true);
    assert.equal(result.timedOut, false);
    for (const name of ["stdout", "stderr"]) {
      const bytes = readFileSync(`${prefix}.${name}.log`),
        log = result.logs[name];
      assert.equal(bytes.length, 8192);
      assert.equal(log.retainedBytes, bytes.length);
      assert.ok(log.totalBytes > bytes.length);
      assert.equal(log.truncated, true);
      assert.equal(log.eofObserved, true);
      assert.match(
        bytes.toString(),
        new RegExp(`FINAL_${name.toUpperCase()}_DIAGNOSTIC\\n$`),
      );
    }
  },
);

test(
  "actual exit before inherited pipe drain cannot bypass the worker deadline",
  { timeout: 5000 },
  async () => {
    const directory = mkdtempSync(
        join(tmpdir(), "moodcode-pty-worker-deadline-"),
      ),
      prefix = join(directory, "worker");
    const script = `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: ['ignore', 1, 2] });
    child.unref();
  `;
    const result = await runPtyRepeatabilityWorker(
      ["--input-type=module", "-e", script],
      1000,
      prefix,
    );
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.exitObserved, true);
    assert.equal(result.closeObserved, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.escalated, false);
    assert.equal(result.logs.stdout.eofObserved, true);
    assert.equal(result.logs.stderr.eofObserved, true);
  },
);

test(
  "actual source Engine repeatability retains normal, resized, cancelled and uncertain fault SQLite evidence",
  {
    skip: !["darwin", "linux", "freebsd"].includes(process.platform),
    timeout: 60000,
  },
  async () => {
    const child = spawnSync(
      process.execPath,
      [
        join(repository, "scripts/verify-pty-repeatability.mjs"),
        "--json",
        "--runtime",
        "source",
        "--iterations",
        "1",
        "--timeout-ms",
        "10000",
        "--max-duration-ms",
        "55000",
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 59000,
        maxBuffer: 131072,
      },
    );
    let report;
    try {
      report = JSON.parse(child.stdout);
    } catch {
      assert.fail(
        `Invalid actual PTY report:\n${child.stdout}\n${child.stderr}`,
      );
    }
    const preservationError = await queueHardeningCliEvidence(
      child.stdout,
      "native-lifecycle",
    ).then(
      () => null,
      (error) => error,
    );
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    if (preservationError) throw preservationError;
    assert.match(child.stderr, /retained report:/);
    assert.deepEqual(
      report,
      JSON.parse(readFileSync(report.reportPath, "utf8")),
    );
    assert.equal(report.status, "passed");
    assert.equal(report.nativeQualified, true);
    assert.equal(report.noLive, true);
    assert.equal(report.liveProviderRequests, 0);
    assert.equal(report.credentialsRead, false);
    assert.equal(report.runtime, "source");
    assert.equal(report.identityStable, true);
    assert.equal(report.retainedEvidence, true);
    assert.deepEqual(report.historicalRpty01, {
      causeConfirmed: false,
      reproduced: false,
      resolved: false,
    });
    assert.equal(report.runtimePins.node, process.version);
    assert.ok(
      report.runtimePins.nodePty.files.some((pin) =>
        pin.path.endsWith("pty.node"),
      ),
    );
    assert.ok(
      report.sourceIdentity.files.some(
        (pin) => pin.path === "packages/engine/src/terminals/backend.ts",
      ),
    );
    assert.ok(
      report.sourceIdentity.files.some(
        (pin) => pin.path === "packages/contracts/dist/index.js",
      ),
    );
    assert.deepEqual(
      report.cases.map((item) => item.scenario),
      PTY_SCENARIOS,
    );
    for (const item of report.cases) {
      assert.equal(item.status, "passed");
      assert.equal(item.engineClosed, true);
      assert.equal(item.persistence.sqliteMatches, true);
      assert.equal(item.persistence.restartMatches, true);
      assert.equal(item.persistence.historyOnly, true);
      assert.ok(existsSync(item.engineSqlitePath));
      assert.ok(existsSync(item.terminalSqlitePath));
      assert.equal(statSync(item.evidencePath).mode & 0o777, 0o600);
      assert.equal(item.worker.timedOut, false);
      assert.equal(item.worker.exitObserved, true);
      assert.equal(item.worker.closeObserved, true);
      assert.equal(item.worker.logs.stdout.eofObserved, true);
      assert.equal(item.worker.logs.stderr.eofObserved, true);
      assert.equal(
        item.backendOutcome.diagnostics.source.terminalPid,
        item.processSnapshot[0].pid,
      );
      assert.equal(
        item.backendOutcome.diagnostics.source.supervisorPid,
        item.supervisor.pid,
      );
      assert.ok(item.supervisor.events.some((event) => event.kind === "exit"));
      assert.ok(
        item.supervisor.events.some((event) => event.kind === "disconnect"),
      );
      assert.ok(
        item.supervisor.events.some((event) => event.kind === "stdout-eof"),
      );
      assert.ok(
        [
          ...item.beforeClosePresence.pids,
          ...item.beforeClosePresence.groups,
        ].every(
          (observation) =>
            observation.presence === "absent" &&
            observation.errorCode === "ESRCH",
        ),
      );
      const db = new DatabaseSync(item.terminalSqlitePath, { readOnly: true });
      try {
        const record = JSON.parse(
          String(
            db
              .prepare("SELECT payload FROM terminals WHERE id=?")
              .get(item.terminal.id).payload,
          ),
        ).record;
        assert.deepEqual(record.diagnostics, item.backendOutcome.diagnostics);
        assert.equal(record.state, item.terminal.state);
        if (["supervisor-death", "ipc-disconnect"].includes(item.scenario)) {
          assert.equal(record.state, "uncertain");
          assert.equal(record.cleanupConfirmed, false);
          assert.equal(record.reason, "supervisor_lost");
          assert.equal(record.diagnostics.cleanup.groupSnapshot, "unavailable");
        } else {
          assert.equal(record.cleanupConfirmed, true);
          assert.equal(
            record.state,
            item.scenario === "cancel" ? "cancelled" : "completed",
          );
          assert.equal(record.diagnostics.supervisorExit.closeObserved, true);
        }
      } finally {
        db.close();
      }
    }
    assert.equal(
      report.cases.find((item) => item.scenario === "input-resize").replay
        .resize,
      true,
    );
  },
);

test(
  "actual batch deadline retains native SQLite evidence and gives no completed batch credit",
  {
    skip: !["darwin", "linux", "freebsd"].includes(process.platform),
    timeout: 18000,
  },
  async () => {
    const child = spawnSync(
      process.execPath,
      [
        join(repository, "scripts/verify-pty-repeatability.mjs"),
        "--runtime",
        "source",
        "--iterations",
        "32",
        "--scenarios",
        "normal-exit,input-resize",
        "--timeout-ms",
        "1000",
        "--max-duration-ms",
        "10000",
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 17000,
        maxBuffer: 131072,
      },
    );
    const match = /retained report: (.+)\n/.exec(child.stdout);
    assert.ok(match, `${child.stdout}\n${child.stderr}`);
    const report = JSON.parse(readFileSync(match[1], "utf8"));
    const preservationError = await queueHardeningCliEvidence(
      readFileSync(match[1], "utf8"),
      "batch-deadline",
    ).then(
      () => null,
      (error) => error,
    );
    assert.equal(child.status, 1, `${child.stdout}\n${child.stderr}`);
    if (preservationError) throw preservationError;
    assert.equal(report.status, "failed");
    assert.equal(report.nativeQualified, false);
    assert.equal(report.retainedEvidence, true);
    assert.ok(report.completedCases > 0 && report.completedCases < 64);
    assert.ok(report.durationMs < 15000);
    assert.ok(
      report.cases.some((item) => item.status === "failed") ||
        report.errors.some(
          (item) => item.code === "PTY_REPEATABILITY_BATCH_TIMEOUT",
        ),
    );
    for (const item of report.cases.filter(
      (item) => item.status === "passed",
    )) {
      assert.ok(existsSync(item.engineSqlitePath));
      assert.ok(existsSync(item.terminalSqlitePath));
      assert.equal(item.terminal.state, "completed");
      assert.equal(item.terminal.cleanupConfirmed, true);
    }
    for (const item of report.cases.filter((item) => item.worker.timedOut)) {
      assert.equal(item.status, "failed");
      assert.ok(
        item.worker.signal === null ||
          ["SIGTERM", "SIGKILL"].includes(item.worker.signal),
      );
      assert.equal(item.watchdogObservation.authority, "observation-only");
      assert.equal(item.watchdogObservation.physicalOwnershipRestored, false);
      assert.equal(item.watchdogObservation.cleanupConfirmed, false);
      assert.ok(
        item.watchdogObservation.pids.every(
          (observation) =>
            !Object.hasOwn(observation, "sent") &&
            !Object.hasOwn(observation, "signal"),
        ),
      );
      assert.ok(
        item.errors.some(
          (error) => error.code === "PTY_REPEATABILITY_WORKER_TIMEOUT",
        ),
      );
    }
  },
);
