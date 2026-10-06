import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsJobCommandBackend, PosixCommandBackend, executeOwnedWindowsJob, type WindowsJobHostPort, type WindowsSuspendedProcess } from './backends.js';
import { executeShell, type ShellInput } from './process-control.js';
const input: ShellInput = { command: 'fixture command', cwd: '/fixture', timeoutMs: 10_000 };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function nativeFixture(options: { assignmentFailure?: boolean; retained?: boolean; closeFailure?: boolean; invalidObservation?: boolean; hangingSpawn?: boolean } = {}) {
  const calls: string[] = [], childClosed = gate<{ exitCode: number | null }>(), spawnGate = gate<WindowsSuspendedProcess>();
  let count = 0;
  const child: WindowsSuspendedProcess = { pid: 123, closed: childClosed.promise, async terminate() { calls.push('child.terminate'); childClosed.resolve({ exitCode: null }); } };
  const host: WindowsJobHostPort = { platform: 'win32', killOnClose: true, suspendedAssignment: true, async createJob() {
    calls.push('create');
    return { async spawnSuspended(_input, env) { calls.push('spawn.suspended'); assert.equal(env.OPENAI_API_KEY, undefined); return options.hangingSpawn ? spawnGate.promise : child; }, async assign() { calls.push('assign'); if (options.assignmentFailure) throw new Error('private-native-error'); count = 1; }, async resume() { calls.push('resume'); }, async terminate() { calls.push('job.terminate'); count = 0; childClosed.resolve({ exitCode: null }); }, async activeProcessCount() { calls.push('observe'); return options.invalidObservation ? -1 : count; }, async close() { calls.push('close'); if (options.closeFailure) throw new Error('private-close-error'); } };
  } };
  return { calls, host, child, spawnGate, complete() { count = options.retained ? 2 : 0; childClosed.resolve({ exitCode: 0 }); } };
}
async function until(predicate: () => boolean): Promise<void> { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('native port fixture must progress'); }

test('host commands report user authority without pretending to isolate files or network', () => {
  const capability = new PosixCommandBackend().capability(); assert.equal(capability.isolation, 'host-user'); assert.equal(capability.fileIsolation, false); assert.equal(capability.networkIsolation, false);
  const windows = new WindowsJobCommandBackend().capability(); assert.equal(windows.available, false); assert.equal(windows.processTree, 'unsupported'); assert.equal(windows.code, 'WINDOWS_JOB_BACKEND_UNAVAILABLE');
});
test('the existing shell process port delegates only to an available platform-bound ownership backend', async () => {
  const result = { exitCode: 0, signal: null, cancelled: false, timedOut: false, cleanupConfirmed: true, started: true } as const;
  let called = 0, startedPid = 0;
  const backend = { capability: () => ({ platform: process.platform, available: true, processTree: 'posix-group' as const, isolation: 'host-user' as const, fileIsolation: false as const, networkIsolation: false as const, parentCrashCleanup: false }), async execute(_input: ShellInput, _signal: AbortSignal, _output: unknown, started: (pid: number) => void) { called++; started(123); return result; } };
  assert.deepEqual(await executeShell(input, new AbortController().signal, () => {}, pid => { startedPid = pid; }, () => {}, backend), result); assert.equal(called, 1); assert.equal(startedPid, 123);
  await assert.rejects(executeShell(input, new AbortController().signal, () => {}, () => {}, () => {}, { ...backend, capability: () => ({ ...backend.capability(), available: false }) }), (error: unknown) => (error as { code: string }).code === 'COMMAND_BACKEND_UNAVAILABLE');
  assert.equal(called, 1);
});
test('Windows ownership assigns the suspended process before recording or resuming and confirms empty job before close', async () => {
  const f = nativeFixture(), running = executeOwnedWindowsJob(f.host, input, new AbortController().signal, () => {}, () => f.calls.push('record'), () => {});
  await until(() => f.calls.includes('resume')); f.complete(); const outcome = await running;
  assert.deepEqual(f.calls.slice(0, 5), ['create', 'spawn.suspended', 'assign', 'record', 'resume']); assert.equal(f.calls.at(-1), 'close'); assert.equal(outcome.cleanupConfirmed, true); assert.equal(outcome.exitCode, 0);
});
test('assignment failure terminates the unassigned suspended child without executing it or exposing private errors', async () => {
  const f = nativeFixture({ assignmentFailure: true }); const result = await executeOwnedWindowsJob(f.host, input, new AbortController().signal, () => {}, () => f.calls.push('record'), () => {});
  assert.equal(f.calls.includes('resume'), false); assert.equal(f.calls.includes('record'), false); assert.ok(f.calls.includes('child.terminate')); assert.ok(f.calls.includes('job.terminate')); assert.equal(result.started, false); assert.equal(result.cleanupConfirmed, true); assert.equal(JSON.stringify(result).includes('private-native-error'), false);
});
test('in-flight cancellation terminates the owned job and waits for both empty job and child stream settlement', async () => {
  const f = nativeFixture(), abort = new AbortController(); const running = executeOwnedWindowsJob(f.host, input, abort.signal, () => {}, () => {}, () => {});
  await until(() => f.calls.includes('resume')); abort.abort(); const outcome = await running;
  assert.equal(outcome.cancelled, true); assert.equal(outcome.cleanupConfirmed, true); assert.ok(f.calls.indexOf('job.terminate') < f.calls.indexOf('close'));
});
test('primary exit does not leave retained job descendants alive', async () => {
  const f = nativeFixture({ retained: true }), warnings: string[] = [];
  const running = executeOwnedWindowsJob(f.host, input, new AbortController().signal, () => {}, () => {}, warning => warnings.push(warning));
  await until(() => f.calls.includes('resume')); f.complete(); const outcome = await running;
  assert.equal(warnings.length, 1); assert.equal(outcome.cleanupConfirmed, true); assert.ok(f.calls.includes('job.terminate'));
});
test('invalid native ownership observations and close failure preserve cleanup uncertainty', async t => {
  for (const options of [{ invalidObservation: true }, { closeFailure: true }]) await t.test(JSON.stringify(options), async () => {
    const f = nativeFixture(options), running = executeOwnedWindowsJob(f.host, input, new AbortController().signal, () => {}, () => {}, () => {}); await until(() => f.calls.includes('resume')); f.complete();
    assert.equal((await running).cleanupConfirmed, false);
  });
});
test('cancellation during native spawn never marks cleanup confirmed and terminates a late unassigned handle', async () => {
  const f = nativeFixture({ hangingSpawn: true }), abort = new AbortController(); const running = executeOwnedWindowsJob(f.host, input, abort.signal, () => {}, () => {}, () => {});
  await until(() => f.calls.includes('spawn.suspended')); abort.abort(); const outcome = await running;
  assert.equal(outcome.cleanupConfirmed, false); assert.equal(f.calls.includes('resume'), false); f.spawnGate.resolve(f.child); await until(() => f.calls.includes('child.terminate'));
});
test('actual Windows Job Object child-tree timeout and parent-crash verification', { skip: process.platform === 'win32' ? 'No native Windows Job Object binding is installed; portable port tests are not OS verification.' : 'Requires Windows and an actual native Job Object binding.' }, () => {});
