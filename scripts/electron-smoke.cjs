'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPORT_TYPE = 'moodcode.electron.engine.report';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_DIAGNOSTIC_BYTES = 16_384;

function timeoutFromEnvironment(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error('MOODCODE_ELECTRON_SMOKE_TIMEOUT_MS must be an integer between 1000 and 120000');
  }
  return timeout;
}

function errorDetails(error, stage) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'SMOKE_FAILED',
    message: String(error?.message ?? error).slice(0, 2_048),
    stage,
  };
}

function bounded(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      const error = new Error('Electron engine smoke interrupted by a signal');
      error.code = 'SMOKE_INTERRUPTED';
      finish(reject, error);
    };
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle(value);
    };
    timer = setTimeout(() => {
      const error = new Error('Electron smoke exceeded its deadline');
      error.code = 'SMOKE_TIMEOUT';
      finish(reject, error);
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function launchUtility(utilityProcess, options) {
  let child;
  let timer;
  let report;
  let diagnosticsBytes = 0;
  let diagnosticsTruncated = false;
  const args = [
    '--engine-entry', options.engineEntry,
    '--workspace', options.workspace,
    '--db', options.dbPath,
    '--artifacts', options.artifactDir,
    '--timeout-ms', String(options.timeoutMs),
  ];
  const promise = new Promise((resolve, reject) => {
    function fail(code, message) {
      clearTimeout(timer);
      child?.kill();
      const error = new Error(message);
      error.code = code;
      reject(error);
    }
    child = utilityProcess.fork(path.join(__dirname, 'electron-engine-child.cjs'), args, {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe',
      serviceName: 'Moodcode Engine Smoke',
    });
    // Runtime warnings and unexpected logging stay on stderr; stdout remains one
    // machine-readable final report. Slow/noisy diagnostics have a byte bound.
    const forwardDiagnostic = (chunk) => {
      const data = Buffer.from(chunk);
      const remaining = MAX_DIAGNOSTIC_BYTES - diagnosticsBytes;
      if (remaining > 0) {
        const selected = data.subarray(0, remaining);
        diagnosticsBytes += selected.length;
        process.stderr.write(selected);
      }
      if (data.length > remaining && !diagnosticsTruncated) {
        diagnosticsTruncated = true;
        process.stderr.write('\n[Electron utility diagnostics truncated]\n');
      }
    };
    child.stdout?.on('data', forwardDiagnostic);
    child.stderr?.on('data', forwardDiagnostic);
    child.on('message', (message) => {
      if (!message || message.type !== REPORT_TYPE || message.schemaVersion !== 1 || typeof message.ok !== 'boolean') {
        fail('INVALID_CHILD_REPORT', 'Electron utility emitted an invalid smoke report');
        return;
      }
      if (report) {
        fail('DUPLICATE_CHILD_REPORT', 'Electron utility emitted more than one smoke report');
        return;
      }
      report = message;
    });
    child.on('error', (type) => fail('UTILITY_PROCESS_ERROR', `Electron utility process failed: ${String(type).slice(0, 256)}`));
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      if (!report) {
        const error = new Error(`Electron utility exited with code ${exitCode} without a report`);
        error.code = 'UTILITY_NO_REPORT';
        reject(error);
        return;
      }
      resolve({ report, exitCode, diagnosticsBytes, diagnosticsTruncated });
    });
    timer = setTimeout(() => fail('UTILITY_TIMEOUT', 'Electron utility smoke exceeded its timeout'), options.timeoutMs + 3_000);
  });
  return { promise, stop: () => child?.kill() };
}

async function runSmoke(electron, options = {}) {
  const { app, BrowserWindow, utilityProcess } = electron;
  const started = Date.now();
  let temp;
  let utility;
  let windowsCreated = 0;
  let stage = 'main.startup';
  const controller = new AbortController();
  const report = {
    schemaVersion: 1,
    type: 'moodcode.electron.smoke',
    ok: false,
    main: { node: process.versions.node, electron: process.versions.electron ?? null, chrome: process.versions.chrome ?? null },
  };
  const onWindowCreated = (_event, window) => {
    windowsCreated += 1;
    window.destroy();
  };
  const onSignal = () => {
    controller.abort();
    utility?.stop();
  };
  app.on('browser-window-created', onWindowCreated);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const timeoutMs = options.timeoutMs ?? timeoutFromEnvironment(process.env.MOODCODE_ELECTRON_SMOKE_TIMEOUT_MS);
    await bounded(app.whenReady(), timeoutMs, controller.signal);
    app.dock?.hide();
    stage = 'fixture.create';
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'moodcode-electron-smoke-'));
    const workspace = path.join(temp, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'README.md'), 'Temporary Moodcode Electron utility smoke workspace.\n');
    const git = spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384 });
    if (git.error || git.status !== 0) {
      const error = git.error ?? new Error(`Cannot initialize temporary smoke workspace: ${git.stderr}`);
      error.code = error.code ?? 'FIXTURE_GIT_FAILED';
      throw error;
    }
    stage = 'utility.launch';
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0 || controller.signal.aborted) {
      const error = new Error('Electron smoke was interrupted before utility launch');
      error.code = controller.signal.aborted ? 'SMOKE_INTERRUPTED' : 'SMOKE_TIMEOUT';
      throw error;
    }
    utility = launchUtility(utilityProcess, {
      timeoutMs: remaining,
      workspace,
      engineEntry: options.engineEntry ?? path.resolve(__dirname, '../packages/engine/dist/index.js'),
      dbPath: path.join(temp, 'engine.sqlite'),
      artifactDir: path.join(temp, 'artifacts'),
    });
    const outcome = await bounded(utility.promise, remaining + 3_000, controller.signal);
    stage = 'utility.verify';
    report.utility = outcome.report;
    report.utilityExitCode = outcome.exitCode;
    report.diagnosticsBytes = outcome.diagnosticsBytes;
    report.diagnosticsTruncated = outcome.diagnosticsTruncated;
    if (!outcome.report.ok) {
      report.error = outcome.report.error ?? { code: 'UTILITY_SMOKE_FAILED', message: 'Electron utility smoke failed', stage };
    } else if (outcome.exitCode !== 0) {
      report.error = { code: 'UTILITY_EXIT_FAILED', message: `Electron utility exited with code ${outcome.exitCode}`, stage };
    } else if (outcome.report.runtime?.processType !== 'utility' || outcome.report.checks?.sqliteQuery !== true) {
      report.error = { code: 'UTILITY_RUNTIME_UNVERIFIED', message: 'Real utility runtime and SQLite query were not verified', stage };
    } else if (['commandApprovalRequested', 'commandApprovalVerified', 'commandApproved', 'commandCompleted', 'commandOutputVerified', 'commandCleanupConfirmed', 'commandCheckpointVerified', 'commandEvidencePersisted'].some((name) => outcome.report.checks?.[name] !== true)) {
      report.error = { code: 'UTILITY_COMMAND_UNVERIFIED', message: 'Approved fixture command execution, cleanup or persistence was not verified', stage };
    } else {
      report.ok = true;
    }
  } catch (error) {
    report.error = errorDetails(error, stage);
  } finally {
    utility?.stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    report.main.windowsCreated = windowsCreated;
    report.main.windowCount = BrowserWindow.getAllWindows().length;
    app.removeListener('browser-window-created', onWindowCreated);
    if (windowsCreated || report.main.windowCount) {
      report.ok = false;
      report.error = { code: 'UNEXPECTED_BROWSER_WINDOW', message: 'Electron smoke created a BrowserWindow', stage: 'main.cleanup' };
    }
    if (temp) {
      try {
        await bounded(fs.rm(temp, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }), 3_000);
        report.fixtureRemoved = true;
      } catch (error) {
        report.ok = false;
        report.cleanupError = errorDetails(error, 'fixture.cleanup');
      }
    }
    report.elapsedMs = Date.now() - started;
  }
  return report;
}

async function main() {
  const electron = require('electron');
  let report;
  try {
    if (process.type !== 'browser' || !electron.app) {
      const error = new Error('This entry must run as an Electron main process');
      error.code = 'ELECTRON_MAIN_RUNTIME_REQUIRED';
      throw error;
    }
    report = await runSmoke(electron);
  } catch (error) {
    report = { schemaVersion: 1, type: 'moodcode.electron.smoke', ok: false, error: errorDetails(error, 'main.startup') };
  }
  process.stdout.write(`${JSON.stringify(report)}\n`, () => {
    if (electron.app) electron.app.exit(report.ok ? 0 : 1);
    else process.exitCode = report.ok ? 0 : 1;
  });
}

module.exports = { runSmoke, launchUtility, timeoutFromEnvironment };
// Electron's internal module loader does not reliably set require.main.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) void main();
