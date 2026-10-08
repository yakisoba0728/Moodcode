import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WindowsJobCommandBackend, executeOwnedWindowsJob } from './backends.js';
import { loadWindowsJobHost } from './windows-job-host.js';
import { registerWindowsEngineCases } from './windows-native-engine-cases.fixture.js';
import {
  activePids, assertGone, directoryFixture, treePids, until, windowsCommand, windowsNative,
} from './windows-native-test-helpers.fixture.js';

interface NativeChild {
  pid: number;
  readOutput(maximum?: number): { stdout: Buffer; stderr: Buffer; stdoutClosed: boolean; stderrClosed: boolean; exited: boolean; exitCode: number | null };
  terminate(): void;
  close(): void;
}
interface NativeJob {
  spawnSuspended(input: { command: string; cwd: string; environment: NodeJS.ProcessEnv }): NativeChild;
  assign(child: NativeChild): void;
  resume(child: NativeChild): void;
  activeProcessCount(): number;
  terminate(): void;
  close(): void;
}
function binding(): { createJob(): NativeJob; currentProcessHandleCount(): number; nativeInfo(): { platform: string; arch: string; napiVersion: number; atomicJobAssignment: boolean } } {
  return createRequire(import.meta.url)('@moodcode/windows-job');
}
const cases: { name: string; execute: (t: TestContext) => void | Promise<void> }[] = [];
function nativeTest(name: string, execute: (t: TestContext) => void | Promise<void>): void { cases.push({ name, execute }); }

nativeTest('actual native binding requires x64 Windows and Node-API with atomic suspended ownership', () => {
  const info = binding().nativeInfo();
  assert.equal(info.platform, 'win32');
  assert.equal(info.arch, process.arch);
  assert.ok(info.napiVersion >= 8);
  assert.equal(info.atomicJobAssignment, true);
  const capability = new WindowsJobCommandBackend().capability();
  assert.equal(capability.available, true, 'Windows native CI must fail when its real addon is unavailable');
  assert.equal(capability.processTree, 'windows-job-object');
  assert.equal(capability.parentCrashCleanup, true);
});

nativeTest('CREATE_SUSPENDED stays inert until assignment/resume; QueryInformationJobObject sees descendants and close kills all', async t => {
  const directory = directoryFixture(t), job = binding().createJob();
  let child: NativeChild | undefined;
  t.after(() => { job.close(); child?.close(); });
  child = job.spawnSuspended({ command: windowsCommand('tree-hold', directory), cwd: directory, environment: process.env });
  assert.ok(child.pid > 0);
  assert.equal(job.activeProcessCount(), 1, 'Atomic native job membership must exist even before the JS assign call');
  assert.throws(() => job.resume(child!), (error: unknown) => (error as { code: string }).code === 'WINDOWS_JOB_INVALID_STATE');
  await new Promise(yes => setTimeout(yes, 80));
  assert.equal(existsSync(join(directory, 'effects.log')), false);
  job.assign(child);
  assert.equal(existsSync(join(directory, 'effects.log')), false);
  job.resume(child);
  await until(() => treePids(directory).length === 3, 'Resumed native tree did not start');
  const pids = [child.pid, ...treePids(directory)];
  assert.equal(activePids(pids).length, new Set(pids).size);
  assert.ok(job.activeProcessCount() >= 3, 'Real native accounting must include child and grandchild, including detached descendants');
  job.close();
  await assertGone(pids);
  await until(() => {
    const output = child!.readOutput();
    return output.exited && output.stdoutClosed && output.stderrClosed;
  }, 'Job handle close must settle actual process exit and both pipes');
  job.close();
  child.close();
  child.close();
  assert.throws(() => child!.readOutput(), (error: unknown) => (error as { code: string }).code === 'WINDOWS_JOB_INVALID_STATE');
  assert.throws(() => job.activeProcessCount(), (error: unknown) => (error as { code: string }).code === 'WINDOWS_JOB_INVALID_STATE');
});

nativeTest('native JS host drains exact multibyte stdout/stderr before reporting normal completion', async t => {
  const directory = directoryFixture(t), stdout: Buffer[] = [], stderr: Buffer[] = [];
  const outcome = await new WindowsJobCommandBackend().execute(
    { command: windowsCommand('output', directory), cwd: directory, timeoutMs: 10_000 },
    new AbortController().signal, (stream, chunk) => { (stream === 'stdout' ? stdout : stderr).push(Buffer.from(chunk)); },
    () => {}, () => {},
  );
  assert.equal(outcome.started, true);
  assert.equal(outcome.cleanupConfirmed, true);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.timedOut, false);
  assert.deepEqual(Buffer.concat(stdout), Buffer.from('한글🙂'.repeat(8192)));
  assert.deepEqual(Buffer.concat(stderr), Buffer.from('stderr🙂'.repeat(8192)));
});

nativeTest('status-only native exit releases process accounting while buffered multibyte output remains drainable', async t => {
  const directory = directoryFixture(t), job = binding().createJob();
  const child = job.spawnSuspended({ command: windowsCommand('output-small', directory), cwd: directory, environment: process.env });
  t.after(() => { job.close(); child.close(); });
  job.assign(child);
  job.resume(child);
  let state: ReturnType<NativeChild['readOutput']> | undefined;
  await until(() => {
    state = child.readOutput(0);
    assert.equal(state.stdout.length, 0);
    assert.equal(state.stderr.length, 0);
    return state.exited;
  }, 'Actual primary process must exit without consuming its buffered output');
  assert.ok(state);
  assert.equal(state.exitCode, 0);
  assert.equal(state.stdoutClosed, false);
  assert.equal(state.stderrClosed, false);
  assert.equal(job.activeProcessCount(), 0, 'QueryInformationJobObject must exclude the exited primary after its native process handles are released');
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  await until(() => {
    const batch = child.readOutput();
    stdout.push(batch.stdout);
    stderr.push(batch.stderr);
    assert.equal(batch.exited, true);
    assert.equal(batch.exitCode, 0, 'Cached exit truth must survive releasing the original process handle');
    return batch.stdoutClosed && batch.stderrClosed;
  }, 'Native output must drain to both real pipe EOFs after process handle release');
  for (const [observed, expected] of [[Buffer.concat(stdout), Buffer.from('한글🙂'.repeat(2048))], [Buffer.concat(stderr), Buffer.from('stderr🙂'.repeat(2048))]] as const) {
    assert.deepEqual(observed, expected);
    assert.equal(createHash('sha256').update(observed).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  }
});

for (const stop of ['primary-exit', 'timeout', 'cancel'] as const) {
  nativeTest(`actual Windows ${stop} removes the entire owned tree and settles inherited pipes`, async t => {
    const directory = directoryFixture(t), abort = new AbortController(), warnings: string[] = [], stdout: Buffer[] = [], stderr: Buffer[] = [];
    const running = new WindowsJobCommandBackend().execute(
      { command: windowsCommand(stop === 'primary-exit' ? 'tree-exit' : 'tree-hold', directory), cwd: directory, timeoutMs: stop === 'timeout' ? 3000 : 10_000 },
      abort.signal, (stream, chunk) => { (stream === 'stdout' ? stdout : stderr).push(Buffer.from(chunk)); },
      () => {}, warning => warnings.push(warning),
    );
    await until(() => treePids(directory).length === 3, 'Actual native tree admission was not observed');
    const pids = treePids(directory);
    if (stop === 'cancel') {
      await until(() => Buffer.concat(stdout).toString('utf8').includes('ROOT_STDOUT 한글🙂') && Buffer.concat(stderr).toString('utf8').includes('LEAF_STDERR 🙂'),
        'Actual forwarded output must be observed before explicit cancellation');
      abort.abort();
    }
    const outcome = await running;
    assert.equal(outcome.started, true);
    assert.equal(outcome.cleanupConfirmed, true);
    assert.equal(outcome.cancelled, stop === 'cancel');
    assert.equal(outcome.timedOut, stop === 'timeout');
    if (stop === 'primary-exit') {
      assert.equal(outcome.exitCode, 0);
      assert.equal(warnings.length, 1, 'Retained descendants must trigger explicit cleanup');
    }
    await assertGone(pids);
    assert.match(Buffer.concat(stdout).toString('utf8'), /ROOT_STDOUT 한글🙂/u);
    assert.match(Buffer.concat(stderr).toString('utf8'), /LEAF_STDERR 🙂/u);
  });
}

nativeTest('cancelled late native job opening closes the real unadopted handle', async () => {
  const host = loadWindowsJobHost();
  assert.ok(host, 'Actual native host is required');
  const real = await host.createJob(), abort = new AbortController();
  let deliver!: (job: typeof real) => void, closed = false;
  const opening = new Promise<typeof real>(yes => { deliver = yes; });
  const close = real.close.bind(real);
  real.close = async () => { await close(); closed = true; };
  const running = executeOwnedWindowsJob({ ...host, createJob: () => opening },
    { command: 'echo never_started', cwd: process.cwd(), timeoutMs: 10_000 }, abort.signal,
    () => assert.fail('Late cancelled open must not produce output'), () => assert.fail('Late cancelled open must not start'), () => {},
  );
  abort.abort();
  assert.equal((await running).cancelled, true);
  deliver(real);
  await until(() => closed, 'Late native Job Object was not closed');
});

nativeTest('native handle counts return to the warmed baseline after repeated child/job/pipe disposal', async t => {
  const directory = directoryFixture(t), native = binding(), backend = new WindowsJobCommandBackend();
  const execute = async () => {
    const outcome = await backend.execute({ command: 'echo native_handle_cycle', cwd: directory, timeoutMs: 10_000 },
      new AbortController().signal, () => {}, () => {}, () => {});
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.cleanupConfirmed, true);
  };
  await execute();
  const before = native.currentProcessHandleCount();
  for (let index = 0; index < 12; index++) await execute();
  const after = native.currentProcessHandleCount();
  assert.ok(after <= before, `Native process/job/pipe handles leaked: baseline=${before}, after=${after}`);
});

nativeTest('real native cancellation releases a blocked output sink without claiming complete capture', async t => {
  const directory = directoryFixture(t), abort = new AbortController();
  let observed = 0;
  const running = new WindowsJobCommandBackend().execute({ command: windowsCommand('overflow', directory), cwd: directory, timeoutMs: 10_000 },
    abort.signal, (_stream, bytes) => { observed += bytes.length; return new Promise<void>(() => {}); }, () => {}, () => {});
  await until(() => observed > 0, 'Actual native output did not reach the blocked sink');
  abort.abort();
  const outcome = await running;
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.cleanupConfirmed, true);
  assert.equal(outcome.outputDiscarded, true);
  assert.ok(observed < 2_000_000, 'Blocked output sink must not forward the complete unacknowledged output');
});

for (const boundary of ['suspended', 'running'] as const) {
  nativeTest(`parent SIGKILL at ${boundary} closes OS-owned handles and prevents surviving commands`, async t => {
    const directory = directoryFixture(t);
    const owner = fork(fileURLToPath(new URL('./windows-native-owner.fixture.js', import.meta.url)), [boundary, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    let diagnostics = '';
    owner.stderr?.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-8192); });
    const ended = new Promise<void>((yes, no) => { owner.once('exit', () => yes()); owner.once('error', no); });
    t.after(async () => { if (owner.exitCode === null) owner.kill('SIGKILL'); await ended; });
    const ready = await new Promise<{ type: string; pid?: number; pids?: number[]; count?: number }>((yes, no) => {
      const timer = setTimeout(() => no(new Error(`Actual native owner did not reach ${boundary}: ${diagnostics}`)), 10_000);
      owner.once('message', packet => { clearTimeout(timer); yes(packet as { type: string; pid?: number; pids?: number[]; count?: number }); });
      owner.once('exit', () => { clearTimeout(timer); no(new Error(`Native owner exited before ${boundary}: ${diagnostics}`)); });
      owner.once('error', error => { clearTimeout(timer); no(error); });
    });
    assert.equal(ready.type, boundary);
    if (boundary === 'suspended') {
      assert.equal(ready.count, 1);
      assert.equal(existsSync(join(directory, 'effects.log')), false);
    }
    const pids = ready.pids ?? [ready.pid!];
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    owner.kill('SIGKILL');
    await ended;
    await assertGone(pids);
    if (boundary === 'suspended') assert.equal(existsSync(join(directory, 'effects.log')), false);
  });
}
registerWindowsEngineCases(nativeTest);
test('actual Windows native Job Object lifecycle and Engine integration', { ...windowsNative, timeout: 120_000 }, async t => {
  for (const scenario of cases) await t.test(scenario.name, { timeout: 30_000 }, scenario.execute);
});
