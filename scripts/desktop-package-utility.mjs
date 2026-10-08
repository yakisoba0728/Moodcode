import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCommandEnvironment } from '../packages/engine/dist/tools/command/process-control.js';

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
      else request.reject(new Error(`Package utility request failed: ${message.error?.code ?? 'UNKNOWN'}`));
    });
    child.on('exit', code => {
      exited = true; exitCode = code;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Package utility exited before acknowledgement.')); }
      pending.clear(); resolveExit(code);
    });
    const request = (type, payload) => new Promise((resolve, reject) => {
      if (exited) { reject(new Error('Package utility is closed.')); return; }
      const id = `package-probe-${++serial}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Package utility acknowledgement deadline exceeded.')); }, 20_000);
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
  let evidence;
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
  } finally {
    const closed = await application.evaluate(async ({ }, key) => {
      const value = globalThis[key];
      if (!value) throw new Error('Package utility cleanup state is missing.');
      try {
        if (!value.exited) await value.request('close');
        const code = await Promise.race([value.exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged utility cleanup exit deadline exceeded.')), 5000))]);
        return { exitCode: code, graceful: true };
      } catch (error) {
        if (!value.exited) value.child.kill();
        await Promise.race([value.exit, new Promise(resolve => setTimeout(resolve, 3000))]);
        throw error;
      } finally { delete globalThis[key]; }
    }, key);
    assert.equal(closed.exitCode, 0, 'The packaged utility must acknowledge close and exit cleanly.');
    if (evidence) evidence.utilityCloseConfirmed = true;
  }
  return evidence;
}
