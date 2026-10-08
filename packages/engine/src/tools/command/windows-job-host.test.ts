import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsJobHost, loadWindowsJobHost, type WindowsJobNativeBinding } from './windows-job-host.js';
import type { WindowsSuspendedProcess } from './backends.js';

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  const calls: string[] = [], reads: number[] = [];
  let first = true, exited = false, eof = false, closeCount = 0, environment: Record<string, string> | undefined;
  const child = {
    pid: 321,
    readOutput(bytes = 65536) {
      reads.push(bytes);
      const emit = first && bytes > 0;
      if (emit) first = false;
      return { stdout: emit ? Buffer.from('observed') : Buffer.alloc(0), stderr: Buffer.alloc(0), exited, exitCode: exited ? 0 : null, stdoutClosed: eof, stderrClosed: eof };
    },
    terminate() { calls.push('child.terminate'); exited = true; eof = true; },
    close() { calls.push('child.close'); closeCount++; },
  };
  const binding: WindowsJobNativeBinding = { createJob() {
    calls.push('create');
    return { spawnSuspended(input) { calls.push('spawn'); environment = input.environment; return child; }, assign(actual) { assert.equal(actual, child); calls.push('assign'); }, resume(actual) { assert.equal(actual, child); calls.push('resume'); }, terminate() { child.terminate(); }, activeProcessCount() { calls.push('query'); return exited ? 0 : 1; }, close() { calls.push('job.close'); } };
  } };
  return { host: createWindowsJobHost(binding), calls, reads, environment: () => environment, closeCount: () => closeCount, exit() { exited = true; }, drain() { eof = true; } };
}
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('native adapter must progress'); }
const input = { command: 'fixture', cwd: '/fixture', timeoutMs: 1000 };

test('native adapter preserves suspended assignment order, environment and real count query', async () => {
  const f = fixture(), job = await f.host.createJob(), output: string[] = [];
  const child = await job.spawnSuspended(input, { PATH: '/fixture/bin', EMPTY: undefined }, (_stream, bytes) => { output.push(bytes.toString()); });
  await job.assign(child); await job.resume(child);
  assert.deepEqual(f.calls, ['create', 'spawn', 'assign', 'resume']);
  assert.deepEqual(f.environment(), { PATH: '/fixture/bin' }); assert.equal(await job.activeProcessCount(), 1);
  await until(() => output.length > 0); f.exit(); f.drain();
  assert.deepEqual(await child.closed, { exitCode: 0 });
  assert.equal(f.closeCount(), 1); await child.close?.(); await job.close();
  assert.equal(f.closeCount(), 1); assert.equal(f.calls.at(-1), 'job.close');
});
test('native adapter polls exit with zero-byte reads while output forwarding is backpressured', async () => {
  const f = fixture(), job = await f.host.createJob(), delivery = gate<void>();
  const child = await job.spawnSuspended(input, {}, () => delivery.promise);
  await job.assign(child); await job.resume(child);
  await until(() => f.reads.includes(65536)); f.exit();
  assert.deepEqual(await child.exited, { exitCode: 0 });
  assert.ok(f.reads.includes(0)); assert.equal(f.reads.filter(n => n > 0).length, 1);
  let closed = false; void child.closed.then(() => { closed = true; });
  f.drain(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(closed, false);
  delivery.resolve(); await child.closed; await job.close(); assert.equal(f.closeCount(), 1);
});
test('discard releases stalled forwarding and closes only after the actual native exit and pipe EOF', async () => {
  const f = fixture(), job = await f.host.createJob(), never = new Promise<void>(() => {});
  const child = await job.spawnSuspended(input, {}, () => never);
  await until(() => f.reads.includes(65536)); child.discardOutput?.();
  f.exit(); f.drain(); await child.closed; await job.close();
  assert.equal(f.closeCount(), 1);
});
test('native adapter rejects foreign suspended handles and closes every owned child on job close', async () => {
  const f = fixture(), job = await f.host.createJob();
  const child = await job.spawnSuspended(input, {}, () => {});
  await assert.rejects(job.assign({ ...child } as WindowsSuspendedProcess), { code: 'WINDOWS_JOB_FOREIGN_PROCESS' });
  await job.close(); await assert.rejects(child.closed, { code: 'WINDOWS_JOB_OUTPUT_UNSETTLED' });
  assert.equal(f.closeCount(), 1); assert.ok(f.calls.indexOf('job.close') < f.calls.indexOf('child.close'));
});
test('the default host loader never advertises a native Windows binding on another platform', () => {
  if (process.platform !== 'win32') assert.equal(loadWindowsJobHost(), undefined);
  else assert.ok(loadWindowsJobHost(), 'Windows verification requires an installed real native binding');
});
