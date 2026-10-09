import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { rm, writeFile, readdir, stat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createCommandEnvironment } from '../packages/engine/dist/tools/command/process-control.js';
import { DESKTOP_ELECTRON_VERSION, WINDOWS_NATIVE_BINARY, verifyWindowsBinaryArchitecture, readWindowsNativeBuildReceipt } from './desktop-native-package.mjs';
import { runPackagedUtilityCodingProbe } from './desktop-package-utility.mjs';
import { createDesktopTestDirectory, captureDesktopNativeEvidence, preserveDesktopTestEvidence, mayDeleteDesktopTestDirectory } from './desktop-test-evidence.mjs';
import { bindMainUtilityClose, readMainUtilityClose, qualifyDesktopNativeCleanup, aggregateFixtureCleanup } from './desktop-main-utility-close.mjs';

const args = process.argv.slice(2);
const portableOnly = args.includes('--portable');
const releaseProfile = args.includes('--release');
const failSupervisorRunning = args.includes('--fail-supervisor-running');
if (failSupervisorRunning && (portableOnly || process.platform === 'win32')) throw new Error('Controlled supervisor failure requires the POSIX native package lane.');
const explicit = args.includes('--executable') ? args[args.indexOf('--executable') + 1] : undefined;
async function executable() {
  if (explicit) return resolve(explicit);
  const directories = await readdir(resolve('release'));
  const candidates = process.platform === 'darwin'
    ? directories.filter(name => /^mac(?:-|$)/u.test(name)).map(name => join('release', name, 'Moodcode.app', 'Contents', 'MacOS', 'Moodcode'))
    : [join('release', process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', process.platform === 'win32' ? 'Moodcode.exe' : 'moodcode')];
  for (const candidate of candidates) if ((await stat(candidate).catch(() => undefined))?.isFile()) return resolve(candidate);
  throw new Error('Build the desktop package for this OS before running its smoke test.');
}
const binary = await executable();
const resources = process.platform === 'darwin' ? resolve(dirname(binary), '../Resources') : join(dirname(binary), 'resources');
let windowsNativeBytes;
if (process.platform === 'win32' && !portableOnly) {
  const nativeBinary = join(resources, 'app.asar.unpacked', 'node_modules', '@moodcode', 'windows-job', WINDOWS_NATIVE_BINARY);
  assert.ok((await stat(nativeBinary).catch(() => undefined))?.isFile(),
    'Windows native package acceptance requires the integrated @moodcode/windows-job binary at its unpacked package-relative path. Run --portable for the separate portable boundary.');
  windowsNativeBytes = await readFile(nativeBinary);
  verifyWindowsBinaryArchitecture(windowsNativeBytes, process.arch);
}
const userData = await createDesktopTestDirectory('package');
let app, failure, resultEvidence, nativeBeforeClose, nativeAfterClose, retained, mainUtilityReceiptPath, fixtureDeleted = false;
const privateUtilities = [];
const children = new Set();
const supervisorObservations = [];
const observationByChild = new Map();
const applicationClose = { requested: false, settled: false, exitObserved: null, exitCode: null, signal: null };
async function bounded(operation, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ settled: false }), ms);
    operation.then(value => { clearTimeout(timer); resolve({ settled: true, value }); }, error => { clearTimeout(timer); resolve({ settled: true, error }); });
  });
}
async function closeApplication() {
  if (!app || applicationClose.requested) return;
  applicationClose.requested = true;
  nativeBeforeClose ??= await captureDesktopNativeEvidence({ sourceDirectory: userData, phase: 'before-close', liveSnapshot: { supervisor: supervisorObservations },
    close: { applicationClose, mainUtility: mainUtilityReceiptPath ? await readMainUtilityClose(mainUtilityReceiptPath) : null } })
    .catch(() => { failure ??= new Error('Packaged test before-close evidence collection failed.'); return undefined; });
  const result = await bounded(app.close(), 10000);
  applicationClose.settled = result.settled && !result.error;
  if (result.settled && !result.error) app = undefined;
  else failure ??= result.error ?? new Error('Packaged application close did not settle within its observation deadline.');
}
async function runSupervisor(relative, initial, start) {
  const child = fork(join(resources, 'app.asar', 'dist', 'main', relative), [], {
    cwd: userData, execPath: binary, execArgv: [], detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...createCommandEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
  });
  children.add(child);
  const observed = { kind: relative.startsWith('terminals/') ? 'pty-supervisor' : 'command-supervisor', source: 'original-supervisor',
    resultObserved: false, exitObserved: false, closeObserved: false, exitCode: null, exitSignal: null, stopRequested: false, outcome: null, diagnostics: null, events: [] };
  supervisorObservations.push(observed);
  observationByChild.set(child, observed);
  const note = kind => { if (observed.events.length < 32) observed.events.push({ kind }); };
  const keep = value => { try { return Buffer.byteLength(JSON.stringify(value)) <= 16384 ? value : null; } catch { return null; } };
  let outcome, diagnostics, output = '', errorOutput = '';
  child.stdout.on('data', chunk => { if (output.length < 1_048_576) output += chunk.toString().slice(0, 1_048_576 - output.length); });
  child.stderr.on('data', chunk => { if (errorOutput.length < 1_048_576) errorOutput += chunk.toString().slice(0, 1_048_576 - errorOutput.length); });
  child.on('exit', (code, signal) => { observed.exitObserved = true; observed.exitCode = code; observed.exitSignal = signal; note('exit'); });
  observed.closed = new Promise(resolve => child.once('close', resolve));
  child.on('close', (code, signal) => { observed.closeObserved = true; observed.exitCode = code; observed.exitSignal = signal; note('close'); });
  const closed = new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => { note('deadline'); reject(new Error('Packaged supervisor deadline exceeded.')); }, 15000);
    child.on('error', error => { note('error'); clearTimeout(timer); reject(error); });
    child.on('message', message => {
      if (message.type === 'ready') { note('ready'); try { child.send(start); } catch (error) { clearTimeout(timer); reject(error); } }
      if (message.type === 'started') {
        note('started');
        if (failSupervisorRunning && observed.kind === 'command-supervisor') { clearTimeout(timer); reject(new Error('Controlled package verification failure after original native command started.')); }
      }
      if (message.type === 'diagnostics') { note('diagnostics'); diagnostics = message.diagnostics; observed.diagnostics = keep(message.diagnostics); }
      if (message.type === 'result') { note('result'); outcome = message.outcome;
        const finalDiagnostics = message.diagnostics ?? message.outcome?.diagnostics;
        diagnostics = finalDiagnostics ?? diagnostics;
        observed.resultObserved = true; observed.outcome = keep(message.outcome);
        if (finalDiagnostics) observed.diagnostics = keep(finalDiagnostics); }
    });
    child.on('close', code => { clearTimeout(timer); children.delete(child); resolveClose(code); });
  });
  if (initial) child.send(initial);
  assert.equal(await closed, 0, errorOutput);
  assert.equal(outcome?.exitCode, 0, errorOutput);
  assert.equal(outcome?.cleanupConfirmed, true, errorOutput);
  return { outcome, diagnostics, output };
}
try {
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ schemaVersion: 1, providerId: 'scripted', modelId: 'local', baseURL: '' }), { mode: 0o600 });
  app = await electron.launch({ executablePath: binary, args: [], env: { ...process.env, MOODCODE_DESKTOP_USER_DATA: userData,
    MOODCODE_DESKTOP_TEST: '1', MOODCODE_DESKTOP_TEST_SCENARIO: 'coding', MOODCODE_API_KEY: '', OPENAI_API_KEY: '' } });
  app.process().once('exit', (code, signal) => { applicationClose.exitObserved = true; applicationClose.exitCode = code; applicationClose.signal = signal; });
  mainUtilityReceiptPath = await bindMainUtilityClose(app, userData);
  const page = await app.firstWindow();
  await expect(page.getByText('무엇을 만들어볼까요?', { exact: true })).toBeVisible({ timeout: 20000 });
  const runtime = await app.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, node: process.versions.node, electron: process.versions.electron,
    arch: process.arch, isolation: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().contextIsolation }));
  assert.equal(runtime.packaged, true); assert.equal(runtime.isolation, true);
  const bootstrap = await page.evaluate(() => window.moodcode.getBootstrap());
  assert.equal(bootstrap.host.state, 'ready'); assert.equal(bootstrap.settings.providerId, 'scripted');
  assert.equal(bootstrap.settings.modelId, 'local', 'Packaged builds must ignore the test scenario override.');
  assert.equal(bootstrap.capabilities.runtime.platform, process.platform);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  const initialNative = await captureDesktopNativeEvidence({ sourceDirectory: userData, phase: 'before-close' });
  const sqliteVersion = initialNative.sqlite.find(item => item.file === 'engine.sqlite' && item.available)?.userVersion;
  assert.equal(sqliteVersion, 23, 'Packaged utility must open the current engine database.');
  const updates = await page.evaluate(() => window.moodcode.getAppUpdate());
  assert.equal(updates.state, releaseProfile ? 'idle' : 'disabled', 'The packaged update profile must match its build profile.');
  const evidence = { ok: true, platform: process.platform, scope: portableOnly ? 'bundle-utility-SQLite-renderer' : process.platform === 'win32'
    ? 'bundle-utility-SQLite-renderer-native-Windows-utility' : 'bundle-utility-SQLite-renderer-native-POSIX-supervisors',
    runtime, host: bootstrap.host.state, primarySQLiteVersion: sqliteVersion, testOverridesIgnored: true, updates: updates.state };
  resultEvidence = evidence;
  if (!portableOnly && process.platform === 'win32') {
    assert.equal(bootstrap.capabilities.runtime.commandExecution, 'windows-job-object',
      'Native Windows package acceptance requires the integrated Job Object binding before command effects.');
    const receipt = readWindowsNativeBuildReceipt(join(resources, 'app.asar'));
    assert.equal(receipt.runtime, 'electron'); assert.equal(receipt.electronVersion, DESKTOP_ELECTRON_VERSION);
    assert.equal(runtime.electron, receipt.electronVersion); assert.equal(receipt.arch, runtime.arch);
    assert.equal(receipt.bindingVersion, 1); assert.equal(receipt.nodeApi, 8);
    assert.equal(receipt.packageRelativeBinary, WINDOWS_NATIVE_BINARY);
    assert.equal(receipt.bytes, windowsNativeBytes.length);
    assert.equal(receipt.sha256, createHash('sha256').update(windowsNativeBytes).digest('hex'));
    evidence.windowsJobObject = await runPackagedUtilityCodingProbe(app, { workerPath: join(resources, 'app.asar', 'dist/main/engine-worker.js'),
      dataDir: userData, commandExecution: 'windows-job-object', electronVersion: runtime.electron });
    privateUtilities.push(evidence.windowsJobObject.cleanup);
    evidence.windowsNativeBinary = { packageRelativePathPreserved: true, outsideAsar: true, electronHeaders: receipt.electronVersion,
      arch: receipt.arch, sha256: receipt.sha256 };
  }
  await closeApplication();
  if (failure) throw failure;
  if (!portableOnly && process.platform !== 'win32') {
    await writeFile(join(userData, 'packaged.test.mjs'), failSupervisorRunning
      ? "import {test} from 'node:test';import assert from 'node:assert/strict';test('packaged supervisor executes node',async()=>{await new Promise(resolve=>setTimeout(resolve,2000));assert.equal(2+3,5)});\n"
      : "import {test} from 'node:test';import assert from 'node:assert/strict';test('packaged supervisor executes node',()=>assert.equal(2+3,5));\n");
    const command = await runSupervisor('supervisor.js', { type: 'init', input: { command: 'node --test packaged.test.mjs', cwd: userData, timeoutMs: 5000 },
      executionLockPath: join(userData, 'packaged.effects.sqlite') }, { type: 'start' });
    assert.match(command.output, /packaged supervisor executes node/u);
    evidence.commandSupervisor = { exitCode: command.outcome.exitCode, cleanupConfirmed: command.outcome.cleanupConfirmed };
    const terminal = await runSupervisor('terminals/supervisor.js', undefined, { type: 'start', input: { file: '/bin/sh', args: ['-c', 'printf "packaged-pty-smoke\\n"'],
      cwd: userData, cols: 80, rows: 24, maxDurationMs: 5000 } });
    assert.match(terminal.output, /packaged-pty-smoke/u);
    assert.equal(terminal.diagnostics.source.platform, process.platform);
    assert.equal(terminal.diagnostics.nativeExit.observed, true);
    evidence.ptySupervisor = { exitCode: terminal.outcome.exitCode, cleanupConfirmed: terminal.outcome.cleanupConfirmed,
      nativeExitObserved: terminal.diagnostics.nativeExit.observed };
  }
} catch (error) { failure ??= error; }
finally {
  // The private probe owns this original pre-close capture. Never replace its
  // failure observation with a later snapshot taken after utility teardown.
  nativeBeforeClose = failure?.desktopTestEvidence?.nativeBeforeClose ?? nativeBeforeClose;
  if (failure && supervisorObservations.length && !failure.desktopTestEvidence?.nativeBeforeClose) {
    // POSIX package supervisors run after main quits. Capture their original
    // failed/running state before requesting their stop, rather than reusing
    // the earlier main-only snapshot from before any supervisor was spawned.
    nativeBeforeClose = await captureDesktopNativeEvidence({ sourceDirectory: userData, phase: 'before-close',
      liveSnapshot: { supervisor: supervisorObservations }, close: { applicationClose,
        mainUtility: mainUtilityReceiptPath ? await readMainUtilityClose(mainUtilityReceiptPath) : null } })
      .catch(() => nativeBeforeClose);
  }
  nativeBeforeClose ??= await captureDesktopNativeEvidence({ sourceDirectory: userData, phase: 'before-close',
    liveSnapshot: { supervisor: supervisorObservations }, close: { applicationClose,
      mainUtility: mainUtilityReceiptPath ? await readMainUtilityClose(mainUtilityReceiptPath) : null } }).catch(() => { failure ??= new Error('Packaged test before-close evidence collection failed.'); return undefined; });
  await closeApplication();
  for (const child of children) {
    const observed = observationByChild.get(child);
    if (observed) { observed.stopRequested = true; if (observed.events.length < 32) observed.events.push({ kind: 'stop-requested' }); }
    if (child.connected) try { child.send({ type: 'stop' }); } catch { if (observed) observed.stopSendFailed = true; }
  }
  for (const observed of supervisorObservations) if (!observed.closeObserved) await bounded(observed.closed, 3000);
  nativeAfterClose = await captureDesktopNativeEvidence({ sourceDirectory: userData, phase: 'after-close', liveSnapshot: { supervisor: supervisorObservations },
    close: { applicationClose, mainUtility: mainUtilityReceiptPath ? await readMainUtilityClose(mainUtilityReceiptPath) : null, utility: failure?.desktopTestEvidence ? {
      ...failure.desktopTestEvidence.nativeAfterClose?.close, cleanup: failure.desktopTestEvidence.cleanup,
    } : undefined } }).catch(() => { failure ??= new Error('Packaged test after-close evidence collection failed.'); return undefined; });
  const supervisorConfirmed = supervisorObservations.some(value => value.resultObserved && value.outcome?.cleanupConfirmed === false) ? false
    : supervisorObservations.length && supervisorObservations.every(value => value.resultObserved && value.outcome?.cleanupConfirmed === true) ? true : null;
  if (failure?.desktopTestEvidence?.cleanup) privateUtilities.push(failure.desktopTestEvidence.cleanup);
  const persistedNative = qualifyDesktopNativeCleanup(nativeAfterClose);
  const nativeConfirmed = persistedNative === false || supervisorConfirmed === false ? false
    : persistedNative === true && (!supervisorObservations.length || supervisorConfirmed === true) ? true : null;
  const mainUtilityClose = mainUtilityReceiptPath ? await readMainUtilityClose(mainUtilityReceiptPath) : null;
  const cleanup = aggregateFixtureCleanup({ mainReceipt: mainUtilityClose, nativeConfirmed, privateUtilities,
    privateUtilitiesExpected: !portableOnly && process.platform === 'win32' ? 1 : 0 });
  if (mayDeleteDesktopTestDirectory({ outcome: failure ? 'failed' : 'passed', cleanup })) { await rm(userData, { recursive: true, force: true }); fixtureDeleted = true; }
  else {
    retained = await preserveDesktopTestEvidence({ sourceDirectory: userData, artifactDirectory: resolve('artifacts/desktop-package/failures'), scenario: 'package',
      outcome: failure ? 'failed' : 'unknown', cleanup, nativeBeforeClose, nativeAfterClose }).catch(() => { failure ??= new Error('Packaged test evidence bundle collection failed.'); return undefined; });
    if (!retained) console.error(JSON.stringify({ fixtureRetained: true, evidenceBundleAvailable: false, sourceDirectory: userData }));
    else if (failure) console.error(JSON.stringify({ testFailed: true, originalFixtureRetained: true, evidenceManifest: retained.manifestPath }));
  }
  if (resultEvidence) { resultEvidence.cleanup = cleanup; resultEvidence.mainUtilityClose = mainUtilityClose; resultEvidence.originalFixtureRetained = !fixtureDeleted; resultEvidence.evidenceBundleAvailable = !!retained;
    if (retained) resultEvidence.evidenceManifest = retained.manifestPath; }
}
if (failure) throw failure;
console.log(JSON.stringify(resultEvidence));
