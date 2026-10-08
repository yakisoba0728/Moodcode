import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowsJobCommandBackend, PosixCommandBackend, executeOwnedWindowsJob, type WindowsJobHostPort, type WindowsSuspendedProcess } from './backends.js';
import { executeShell, type ShellInput } from './process-control.js';
const input: ShellInput = { command: 'fixture command', cwd: '/fixture', timeoutMs: 10_000 };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function nativeFixture(options: { assignmentFailure?: boolean; retained?: boolean; retainedPipes?: boolean; closeFailure?: boolean; invalidObservation?: boolean; hangingSpawn?: boolean } = {}) {
  const calls: string[] = [], childClosed = gate<{ exitCode: number | null }>(), childExited = gate<{ exitCode: number | null }>(), spawnGate = gate<WindowsSuspendedProcess>();
  let count = 0;
  const child: WindowsSuspendedProcess = { pid: 123, exited: childExited.promise, closed: childClosed.promise, async terminate() { calls.push('child.terminate'); childClosed.resolve({ exitCode: null }); } };
  const host: WindowsJobHostPort = { platform: 'win32', killOnClose: true, suspendedAssignment: true, async createJob() {
    calls.push('create');
    return { async spawnSuspended(_input, env) { calls.push('spawn.suspended'); assert.equal(env.OPENAI_API_KEY, undefined); return options.hangingSpawn ? spawnGate.promise : child; }, async assign() { calls.push('assign'); if (options.assignmentFailure) throw new Error('private-native-error'); count = 1; }, async resume() { calls.push('resume'); }, async terminate() { calls.push('job.terminate'); count = 0; childClosed.resolve({ exitCode: null }); }, async activeProcessCount() { calls.push('observe'); return options.invalidObservation ? -1 : count; }, async close() { calls.push('close'); if (options.closeFailure) throw new Error('private-close-error'); } };
  } };
  return { calls, host, child, spawnGate, drain() { childClosed.resolve({ exitCode: 0 }); }, complete() { count = options.retained || options.retainedPipes ? 2 : 0; childExited.resolve({ exitCode: 0 }); if (!options.retainedPipes) childClosed.resolve({ exitCode: 0 }); } };
}
async function until(predicate: () => boolean): Promise<void> { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('native port fixture must progress'); }

test('host commands report user authority without pretending to isolate files or network', () => {
  const capability = new PosixCommandBackend().capability(); assert.equal(capability.isolation, 'host-user'); assert.equal(capability.fileIsolation, false); assert.equal(capability.networkIsolation, false);
  const windows = new WindowsJobCommandBackend(null).capability(); assert.equal(windows.available, false); assert.equal(windows.processTree, 'unsupported'); assert.equal(windows.code, 'WINDOWS_JOB_BACKEND_UNAVAILABLE');
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
  assert.equal(f.calls.includes('resume'), false); assert.equal(f.calls.includes('record'), false); assert.ok(f.calls.includes('child.terminate')); assert.ok(f.calls.includes('job.terminate')); assert.equal(result.started, false); assert.equal(result.cleanupConfirmed, true); assert.ok(result.error); assert.equal(JSON.stringify(result).includes('private-native-error'), false);
});
test('in-flight cancellation terminates the owned job and waits for both empty job and child stream settlement', async () => {
  const f = nativeFixture(), abort = new AbortController(); const running = executeOwnedWindowsJob(f.host, input, abort.signal, () => {}, () => {}, () => {});
  await until(() => f.calls.includes('resume')); abort.abort(); const outcome = await running;
  assert.equal(outcome.cancelled, true); assert.equal(outcome.cleanupConfirmed, true); assert.equal(outcome.error, undefined); assert.ok(f.calls.indexOf('job.terminate') < f.calls.indexOf('close'));
});
test('primary exit does not leave retained job descendants alive', async () => {
  const f = nativeFixture({ retained: true }), warnings: string[] = [];
  const running = executeOwnedWindowsJob(f.host, input, new AbortController().signal, () => {}, () => {}, warning => warnings.push(warning));
  await until(() => f.calls.includes('resume')); f.complete(); const outcome = await running;
  assert.equal(warnings.length, 1); assert.equal(outcome.cleanupConfirmed, true); assert.ok(f.calls.includes('job.terminate'));
});
test('primary exit joins real accounting samples before classifying descendants independently of output EOF', async () => {
  const f = nativeFixture({ retainedPipes: true }), warnings: string[] = [], observedEmpty = gate<void>();
  const counts = [1, 1, 0], observed: number[] = [];
  const host: WindowsJobHostPort = { ...f.host, async createJob() {
    const job = await f.host.createJob();
    job.activeProcessCount = async () => {
      const count = counts.shift() ?? 0; observed.push(count);
      if (count === 0) observedEmpty.resolve();
      return count;
    };
    return job;
  } };
  const running = executeOwnedWindowsJob(host, input, new AbortController().signal, () => {}, () => {}, warning => warnings.push(warning));
  await until(() => f.calls.includes('resume')); f.complete();
  await observedEmpty.promise;
  assert.deepEqual(observed.slice(0, 3), [1, 1, 0]);
  assert.equal(f.calls.includes('job.terminate'), false);
  assert.deepEqual(warnings, []);
  f.drain();
  const outcome = await running;
  assert.equal(outcome.exitCode, 0); assert.equal(outcome.cleanupConfirmed, true);
  assert.equal(outcome.error, undefined); assert.equal(outcome.timedOut, false);
});
test('natural exit accounting join stays within the approved command duration', async () => {
  const f = nativeFixture({ retainedPipes: true }), warnings: string[] = [];
  const running = executeOwnedWindowsJob(f.host, { ...input, timeoutMs: 20 }, new AbortController().signal, () => {}, () => {}, warning => warnings.push(warning));
  await until(() => f.calls.includes('resume')); f.complete();
  const outcome = await running;
  assert.equal(outcome.timedOut, true); assert.equal(outcome.cleanupConfirmed, true);
  assert.equal(outcome.error, undefined); assert.equal(warnings.some(warning => warning.includes('retained descendants')), false);
  assert.ok(f.calls.includes('job.terminate'));
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
  assert.equal(outcome.cleanupConfirmed, false); assert.ok(outcome.error); assert.equal(f.calls.includes('resume'), false); f.spawnGate.resolve(f.child); await until(() => f.calls.includes('child.terminate'));
});
test('primary exit terminates descendants that keep inherited output pipes open before waiting for stream close', async () => {
  const f = nativeFixture({ retainedPipes: true });
  const running = executeOwnedWindowsJob(f.host, input, new AbortController().signal, () => {}, () => {}, () => {});
  await until(() => f.calls.includes('resume')); f.complete();
  const outcome = await running;
  assert.ok(f.calls.includes('job.terminate')); assert.equal(outcome.cleanupConfirmed, true); assert.equal(outcome.timedOut, false);
});
test('native ownership deadline invalidates a late job lease without needing user cancellation', async () => {
  const f = nativeFixture(), opening = gate<Awaited<ReturnType<WindowsJobHostPort['createJob']>>>();
  const running = executeOwnedWindowsJob({ ...f.host, createJob: () => opening.promise }, input, new AbortController().signal, () => {}, () => {}, () => {}, { operationMs: 10, cleanupMs: 20, pollMs: 1 });
  const outcome = await running;
  assert.equal(outcome.cleanupConfirmed, false); assert.equal(outcome.cancelled, false); assert.equal(outcome.timedOut, false);
  opening.resolve(await f.host.createJob()); await until(() => f.calls.includes('close'));
  assert.equal(f.calls.includes('spawn.suspended'), false);
});
test('native spawn deadline terminates a late suspended child without resuming it', async () => {
  const f = nativeFixture({ hangingSpawn: true });
  const outcome = await executeOwnedWindowsJob(f.host, input, new AbortController().signal, () => {}, () => {}, () => {}, { operationMs: 10, cleanupMs: 20, pollMs: 1 });
  assert.equal(outcome.cleanupConfirmed, false); assert.equal(outcome.timedOut, false);
  f.spawnGate.resolve(f.child); await until(() => f.calls.includes('child.terminate'));
  assert.equal(f.calls.includes('resume'), false);
});
test('command runtime is bounded by approved duration rather than the short native ownership deadline', async () => {
  const f = nativeFixture();
  const running = executeOwnedWindowsJob(f.host, input, new AbortController().signal, () => {}, () => {}, () => {}, { operationMs: 10, cleanupMs: 20, pollMs: 1 });
  await until(() => f.calls.includes('resume'));
  await new Promise(resolve => setTimeout(resolve, 25)); f.complete();
  assert.equal((await running).exitCode, 0);
});
test('synchronous native startup exceeding the approved duration never resumes the suspended command', async () => {
  const f = nativeFixture(), host: WindowsJobHostPort = { ...f.host, async createJob() {
    const job = await f.host.createJob(), spawn = job.spawnSuspended.bind(job);
    job.spawnSuspended = async (...args) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return spawn(...args);
    };
    return job;
  } };
  const outcome = await executeOwnedWindowsJob(host, { ...input, timeoutMs: 5 }, new AbortController().signal, () => {}, () => {}, () => {});
  assert.equal(outcome.timedOut, true); assert.equal(outcome.cleanupConfirmed, true);
  assert.equal(outcome.error, undefined);
  assert.equal(f.calls.includes('resume'), false); assert.ok(f.calls.includes('child.terminate'));
});
