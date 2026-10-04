import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createEngine, loadConfig, getDiagnostics, WorkspaceObserver,
  SqliteStore, inspectExecutionLock,
} from '../packages/engine/dist/index.js';

const report = { type: 'moodcode.electron.runtime', ok: false, runtime: { node: process.versions.node, electron: process.versions.electron ?? null }, checks: {} };
let directory;
let engine;
let observer;
let backupStore;
const deadline = (promise, milliseconds = 10_000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime check timed out')), milliseconds); })]).finally(() => clearTimeout(timer));
};
try {
  assert(process.versions.electron, 'Use the Electron runtime launcher');
  directory = await mkdtemp(join(await realpath(tmpdir()), 'moodcode-runtime-'));
  const workspacePath = join(directory, 'workspace');
  await mkdir(workspacePath);
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const initialized = spawnSync('git', ['-C', workspacePath, 'init', '--quiet'], { env: gitEnv, encoding: 'utf8', timeout: 5_000, maxBuffer: 65_536 });
  assert.equal(initialized.status, 0, 'Temporary Git fixture must initialize');
  const filePath = join(workspacePath, 'observed.txt');
  await writeFile(filePath, 'before\n');
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ mode: 'plan', limits: { maxTurns: 3 } }));
  const config = await loadConfig({ userConfigPath: configPath });
  assert.equal(config.runConfig.limits.maxTurns, 3);
  assert(Object.isFrozen(config.runConfig));
  report.checks.config = true;

  const dbPath = join(directory, 'state', 'engine.sqlite');
  engine = createEngine({ dbPath, defaults: config.runConfig });
  let commandId = 0;
  const dispatch = async (type, payload) => {
    const reply = await engine.dispatch({ schemaVersion: 1, commandId: `runtime-${++commandId}`, type, payload });
    assert.equal(reply.ok, true, `Command ${type} must succeed`);
    return reply.result;
  };
  const capabilities = await dispatch('engine.getCapabilities', {});
  assert.equal(capabilities.runtime.node, process.versions.node);
  assert.equal(capabilities.defaults.limits.maxTurns, 3);
  report.checks.capabilities = true;
  const workspace = await dispatch('workspace.open', { path: workspacePath });
  const session = await dispatch('session.create', { workspaceId: workspace.id });
  const receipt = await dispatch('run.submit', { sessionId: session.id, requestId: 'runtime-probe', prompt: 'Local runtime verification.' });
  assert.equal((await deadline(engine.waitForRun(receipt.runId))).state, 'completed');
  const snapshot = await dispatch('session.getSnapshot', { sessionId: session.id });

  observer = new WorkspaceObserver(workspace, { intervalMs: 50, gitTimeoutMs: 2_000 });
  assert.equal((await deadline(observer.next())).done, false);
  await writeFile(filePath, 'after\n');
  let observed = false;
  const observeDeadline = Date.now() + 5_000;
  while (!observed && Date.now() < observeDeadline) {
    const item = await deadline(observer.next(), 5_000);
    assert.equal(item.done, false);
    observed = item.value.changes.some(change => change.path === 'observed.txt');
  }
  assert(observed, 'Observer must detect a fixture edit');
  await observer.stop();
  observer = undefined;
  report.checks.observer = true;
  assert.equal(engine.integrityCheck().ok, true);
  report.checks.integrity = true;
  const backup = await deadline(engine.backup(join(directory, 'backups', 'engine.sqlite')));
  backupStore = new SqliteStore(backup.destination);
  assert.deepEqual(backupStore.getSnapshot(session.id), snapshot);
  assert.equal(backupStore.integrityCheck().ok, true);
  await backupStore.closeAsync();
  backupStore = undefined;
  report.checks.backup = true;
  const inspection = inspectExecutionLock(`${await realpath(dbPath)}.effects.sqlite`);
  assert(['available', 'not_initialized'].includes(inspection.status));
  report.checks.executionInspection = true;
  const diagnostics = await getDiagnostics({ workspacePath, artifactParent: dirname(dbPath) });
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.sqlite.verified, true);
  report.checks.diagnostics = true;
  await engine.close();
  engine = createEngine({ dbPath });
  assert.equal(engine.store.getSnapshot(session.id).lastSeq, snapshot.lastSeq);
  await engine.close();
  engine = undefined;
  report.checks.closeAndReopen = true;
  report.ok = true;
} catch (error) {
  report.error = { code: typeof error?.code === 'string' ? error.code : 'RUNTIME_CHECK_FAILED', message: String(error?.message ?? 'Runtime verification failed').slice(0, 1_024) };
} finally {
  try { await observer?.stop(); await backupStore?.closeAsync(); await engine?.close(); }
  catch { report.ok = false; report.cleanupFailed = true; }
  if (directory) await rm(directory, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
