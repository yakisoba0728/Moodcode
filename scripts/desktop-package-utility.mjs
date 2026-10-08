import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCommandEnvironment } from '../packages/engine/dist/tools/command/process-control.js';
import { captureDesktopNativeEvidence } from './desktop-test-evidence.mjs';

/** The probe drives the packaged private WorkerStart port; production main keeps ignoring test overrides. */
export async function runPackagedUtilityCodingProbe(application, { workerPath, dataDir, commandExecution, electronVersion }) {
  const key = `__moodcodePackageUtility_${randomUUID().replaceAll('-', '')}`;
  const environment = createCommandEnvironment();
  delete environment.NODE_TEST_CONTEXT;
  await application.evaluate(({ utilityProcess }, { key, workerPath, dataDir, environment }) => {
    const child = utilityProcess.fork(workerPath, [], { cwd: dataDir, env: environment, stdio: 'pipe', serviceName: 'Moodcode disposable package verification' });
    const pending = new Map();
    let serial = 0, exited = false, exitCode;
    let resolveExit;
    const exit = new Promise(resolve => { resolveExit = resolve; });
    // Drain without retaining any child diagnostics in the test or its artifacts.
    child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
    child.on('message', message => {
      const request = pending.get(message?.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else {
        const valid = typeof message.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(message.error.code);
        request.reject(Object.assign(new Error('Package utility request failed.'), {
          code: valid ? message.error.code : 'UTILITY_INVALID_ERROR_CODE', source: valid ? 'actual-native-IPC' : 'driver-protocol' }));
      }
    });
    child.on('exit', code => {
      exited = true; exitCode = code;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Object.assign(new Error('Package utility exited before acknowledgement.'), { code: 'UTILITY_EXIT_BEFORE_ACK', source: 'driver-lifecycle' })); }
      pending.clear(); resolveExit(code);
    });
    const request = (type, payload) => new Promise((resolve, reject) => {
      if (exited) { reject(Object.assign(new Error('Package utility is closed.'), { code: 'UTILITY_ALREADY_EXITED', source: 'driver-lifecycle' })); return; }
      const id = `package-probe-${++serial}`;
      const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('Package utility acknowledgement deadline exceeded.'), { code: 'UTILITY_REQUEST_DEADLINE', source: 'driver-deadline' })); }, 20_000);
      pending.set(id, { resolve, reject, timer });
      child.postMessage({ id, type, ...(payload === undefined ? {} : { payload }) });
    });
    globalThis[key] = { child, request, exit, get exited() { return exited; }, get exitCode() { return exitCode; } };
  }, { key, workerPath, dataDir, environment });
  const request = (type, payload) => application.evaluate(({ }, { key, type, payload }) => globalThis[key].request(type, payload), { key, type, payload });
  const command = async (type, payload = {}) => {
    const result = await request('command', { schemaVersion: 1, commandId: randomUUID(), type, payload });
    assert.equal(result.ok, true, `Package command ${type} failed: ${result.error?.code}`);
    return result.result;
  };
  const until = async (operation, condition, message, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await operation();
      if (condition(value)) return value;
      await delay(25);
    }
    throw new Error(message);
  };
  let evidence, failure, sessionId, latestSnapshot, nativeBeforeClose, nativeAfterClose;
  try {
    const bootstrap = await request('start', { dbPath: join(dataDir, 'coding.sqlite'), artifactDir: join(dataDir, 'coding-artifacts'),
      config: { providerId: 'scripted', modelId: 'local', baseURL: '' }, testScenario: 'coding' });
    assert.equal(bootstrap.capabilities.runtime.platform, process.platform);
    assert.equal(bootstrap.capabilities.runtime.electron, electronVersion);
    assert.equal(bootstrap.capabilities.runtime.commandExecution, commandExecution,
      'The actual packaged utility must load its native execution backend before the probe creates effects.');
    assert.equal(bootstrap.capabilities.defaults.modelId, 'desktop-coding-fixture');
    const workspace = join(dataDir, 'coding-workspace');
    await mkdir(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    const before = 'export function add(a, b) { return a - b; }\n';
    const after = 'export function add(a, b) { return a + b; }\n';
    await writeFile(join(workspace, 'math.mjs'), before);
    const executionReceipt = join(workspace, 'test-executed.txt');
    await writeFile(join(workspace, 'math.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs'; import {add} from './math.mjs'; test('packaged utility native command', () => {assert.equal(add(2, 3), 5); writeFileSync('test-executed.txt', 'native-command-executed\\n');});\n");
    const opened = await command('workspace.open', { path: workspace });
    const session = await command('session.create', { workspaceId: opened.id, title: 'Disposable packaged native command proof' });
    sessionId = session.id;
    const receipt = await command('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Fix and verify add(a, b).', config: { mode: 'build' } });
    const snapshot = () => command('session.getSnapshot', { sessionId: session.id });
    const approval = async toolName => {
      const value = await until(snapshot, current => current.approvals.some(item => item.toolName === toolName && item.status === 'pending'),
        `Packaged utility did not request ${toolName} approval.`);
      return value.approvals.find(item => item.toolName === toolName && item.status === 'pending');
    };
    const patch = await approval('apply_patch');
    assert.equal(await readFile(join(workspace, 'math.mjs'), 'utf8'), before, 'No write may occur before its exact approval.');
    const pending = await snapshot();
    assert.equal(pending.tools.find(tool => tool.name === 'apply_patch').input.changes[0].expectedHash, createHash('sha256').update(before).digest('hex'));
    await command('approval.decide', { approvalId: patch.id, fingerprint: patch.fingerprint, decision: 'allow' });
    const processApproval = await approval('run_command');
    assert.equal(processApproval.preview.command, 'node --test');
    assert.equal((await snapshot()).tools.find(tool => tool.name === 'run_command').state, 'awaiting_approval');
    assert.equal(await readFile(join(workspace, 'math.mjs'), 'utf8'), after);
    assert.equal(await stat(executionReceipt).catch(() => undefined), undefined, 'The command must not execute before its exact approval.');
    await command('approval.decide', { approvalId: processApproval.id, fingerprint: processApproval.fingerprint, decision: 'allow' });
    const completed = await until(snapshot, value => value.runs.some(run => run.id === receipt.runId && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state)),
      'Packaged native command did not settle.');
    latestSnapshot = completed;
    const run = completed.runs.find(run => run.id === receipt.runId);
    assert.equal(run.state, 'completed', `Packaged native command run failed: ${run.error?.code}`);
    assert.ok(completed.tools.every(tool => tool.state === 'completed'));
    const tool = completed.tools.find(item => item.name === 'run_command');
    assert.match(tool.output, /^Command completed; exitCode=0; signal=null; cleanupConfirmed=true\./u);
    assert.match(tool.output, /packaged utility native command/u);
    assert.match(tool.output, /(?:#|ℹ) tests [1-9]\d*/u);
    assert.equal(await readFile(executionReceipt, 'utf8'), 'native-command-executed\n');
    assert.equal(completed.approvals.filter(item => item.toolName === 'run_command' && item.status === 'allowed').length, 1);
    const diff = await command('review.getDiff', { runId: receipt.runId });
    const file = diff.files.find(item => item.path === 'math.mjs');
    assert.equal(file.before, before); assert.equal(file.after, after);
    assert.ok(diff.checkpoints.some(item => item.kind === 'command' && !item.incomplete), 'Native command checkpoint must retain complete effect evidence.');
    await request('assertIdle');
    evidence = { owner: 'actual-packaged-engine-utility', commandExecution, privateCodingFixture: true, exactNativeApprovals: 2,
      runState: run.state, exitCode: 0, cleanupConfirmed: true, completeCommandCheckpoint: true, mainTestOverridesEnabled: false };
  } catch (error) { failure = error; }
  finally {
    if (sessionId) latestSnapshot = await command('session.getSnapshot', { sessionId }).catch(() => latestSnapshot);
    nativeBeforeClose = await captureDesktopNativeEvidence({ sourceDirectory: dataDir, phase: 'before-close',
      liveSnapshot: latestSnapshot ? { runs: latestSnapshot.runs, tools: latestSnapshot.tools } : undefined }).catch(() => undefined);
    const closed = await application.evaluate(async ({ }, key) => {
      const value = globalThis[key];
      const result = { acknowledged: false, exitObserved: false, exitCode: null, forcedStop: false };
      if (!value) return { ...result, error: { code: 'UTILITY_STATE_MISSING', source: 'driver-protocol' } };
      const wait = (promise, ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('Utility exit observation deadline exceeded.'), { code: 'UTILITY_EXIT_DEADLINE', source: 'driver-deadline' })), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
      });
      try {
        if (!value.exited) { await value.request('close'); result.acknowledged = true; }
        await wait(value.exit, 5000);
      } catch (error) {
        result.error = { code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.code) ? error.code : 'UTILITY_CLOSE_LOCAL_FAILURE',
          source: ['actual-native-IPC','driver-protocol','driver-lifecycle','driver-deadline'].includes(error?.source) ? error.source : 'driver-lifecycle' };
        // Only this original UtilityProcess handle may be stopped. Exit observation
        // after a forced stop never establishes command/Job cleanup confirmation.
        if (!value.exited) { result.forcedStop = true; try { value.child.kill(); } catch { result.errors = [{ code: 'UTILITY_STOP_LOCAL_FAILURE', source: 'driver-lifecycle' }]; } }
        await wait(value.exit, 3000).catch(() => {});
      } finally { delete globalThis[key]; }
      result.exitObserved = value.exited; result.exitCode = value.exitCode ?? null;
      return result;
    }, key).catch(() => ({ acknowledged: false, exitObserved: null, exitCode: null, forcedStop: false, error: { code: 'UTILITY_CLOSE_OBSERVATION_FAILED', source: 'driver-lifecycle' } }));
    nativeAfterClose = await captureDesktopNativeEvidence({ sourceDirectory: dataDir, phase: 'after-close', close: closed }).catch(() => undefined);
    const nativeConfirmed = evidence?.cleanupConfirmed === true ? true : nativeBeforeClose?.sqlite
      .flatMap(item => item.records.tools ?? []).find(tool => tool.name === 'run_command')?.cleanupConfirmed ?? null;
    const cleanup = { state: nativeConfirmed === true && closed.acknowledged && closed.exitObserved && closed.exitCode === 0 && !closed.forcedStop ? 'confirmed' : 'unknown',
      nativeConfirmed, utilityAcknowledged: closed.acknowledged, utilityExitObserved: closed.exitObserved, forcedStop: closed.forcedStop, utilityScope: 'private-coding-utility' };
    if (!(closed.acknowledged && closed.exitObserved && closed.exitCode === 0 && !closed.forcedStop)) {
      failure ??= new Error('The packaged utility did not acknowledge close and exit cleanly.');
    }
    if (failure) Object.defineProperty(failure, 'desktopTestEvidence', { value: { cleanup, nativeBeforeClose, nativeAfterClose }, enumerable: false });
    else { evidence.utilityCloseConfirmed = true; evidence.cleanup = cleanup; }
  }
  if (failure) throw failure;
  return evidence;
}
