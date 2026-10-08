import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile, readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import { createCommandEnvironment } from '../packages/engine/dist/tools/command/process-control.js';
import { DESKTOP_ELECTRON_VERSION, WINDOWS_NATIVE_BINARY, verifyWindowsBinaryArchitecture } from './desktop-native-package.mjs';
import { runPackagedUtilityCodingProbe } from './desktop-package-utility.mjs';

const args = process.argv.slice(2);
const portableOnly = args.includes('--portable');
const releaseProfile = args.includes('--release');
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
const userData = await mkdtemp(join(tmpdir(), 'moodcode-package-smoke-'));
let app;
const children = new Set();
async function runSupervisor(relative, initial, start) {
  const child = fork(join(resources, 'app.asar', 'dist', 'main', relative), [], {
    cwd: userData, execPath: binary, execArgv: [], detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...createCommandEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
  });
  children.add(child);
  let outcome, diagnostics, output = '', errorOutput = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
  const closed = new Promise((resolveClose, reject) => {
    const timer = setTimeout(() => { child.send({ type: 'stop' }); reject(new Error('Packaged supervisor deadline exceeded.')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('message', message => {
      if (message.type === 'ready') child.send(start);
      if (message.type === 'diagnostics') diagnostics = message.diagnostics;
      if (message.type === 'result') { outcome = message.outcome; diagnostics ??= message.diagnostics; }
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
  const db = new DatabaseSync(join(userData, 'engine.sqlite'), { readOnly: true });
  const sqliteVersion = Number(db.prepare('PRAGMA user_version').get().user_version); db.close();
  assert.equal(sqliteVersion, 23, 'Packaged utility must open the current engine database.');
  const updates = await page.evaluate(() => window.moodcode.getAppUpdate());
  assert.equal(updates.state, releaseProfile ? 'idle' : 'disabled', 'The packaged update profile must match its build profile.');
  const evidence = { ok: true, platform: process.platform, scope: portableOnly ? 'bundle-utility-SQLite-renderer' : process.platform === 'win32'
    ? 'bundle-utility-SQLite-renderer-native-Windows-utility' : 'bundle-utility-SQLite-renderer-native-POSIX-supervisors',
    runtime, host: bootstrap.host.state, primarySQLiteVersion: sqliteVersion, testOverridesIgnored: true, updates: updates.state };
  if (!portableOnly && process.platform === 'win32') {
    assert.equal(bootstrap.capabilities.runtime.commandExecution, 'windows-job-object',
      'Native Windows package acceptance requires the integrated Job Object binding before command effects.');
    const receipt = JSON.parse(extractFile(join(resources, 'app.asar'), 'dist/main/windows-native-build.json').toString('utf8'));
    assert.equal(receipt.runtime, 'electron'); assert.equal(receipt.electronVersion, DESKTOP_ELECTRON_VERSION);
    assert.equal(runtime.electron, receipt.electronVersion); assert.equal(receipt.arch, runtime.arch);
    assert.equal(receipt.bindingVersion, 1); assert.equal(receipt.nodeApi, 8);
    assert.equal(receipt.packageRelativeBinary, WINDOWS_NATIVE_BINARY);
    assert.equal(receipt.bytes, windowsNativeBytes.length);
    assert.equal(receipt.sha256, createHash('sha256').update(windowsNativeBytes).digest('hex'));
    evidence.windowsJobObject = await runPackagedUtilityCodingProbe(app, { workerPath: join(resources, 'app.asar', 'dist/main/engine-worker.js'),
      dataDir: userData, commandExecution: 'windows-job-object', electronVersion: runtime.electron });
    evidence.windowsNativeBinary = { packageRelativePathPreserved: true, outsideAsar: true, electronHeaders: receipt.electronVersion,
      arch: receipt.arch, sha256: receipt.sha256 };
  }
  await app.close(); app = undefined;
  if (!portableOnly && process.platform !== 'win32') {
    await writeFile(join(userData, 'packaged.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert/strict';test('packaged supervisor executes node',()=>assert.equal(2+3,5));\n");
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
  console.log(JSON.stringify(evidence));
} finally {
  await app?.close();
  for (const child of children) { if (child.connected) child.send({ type: 'stop' }); await new Promise(resolve => { child.once('close', resolve); setTimeout(resolve, 3000); }); }
  await rm(userData, { recursive: true, force: true });
}
