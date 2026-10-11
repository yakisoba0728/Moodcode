import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { pidPresence, raceAbort, settleWithin } from './runtime.js';

const cancelled = () => new EngineError('CANCELLED', 'fixture cancelled');

test('pid presence is absent only on ESRCH, probes groups by negative pid and leaves Windows groups unknown', t => {
  const probes: number[] = [];
  let failure: string | undefined;
  t.mock.method(process, 'kill', (pid: number, signal?: number | NodeJS.Signals) => {
    assert.equal(signal, 0);
    probes.push(pid);
    if (failure) throw Object.assign(new Error('fixture probe'), { code: failure });
    return true;
  });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    assert.deepEqual(pidPresence(12345), { presence: 'alive' });
    for (const code of ['ESRCH', 'EPERM', 'EIO']) {
      failure = code;
      const probe = pidPresence(12345, { group: true });
      assert.equal(probe.presence, code === 'ESRCH' ? 'absent' : 'unknown');
      assert.equal((probe.error as NodeJS.ErrnoException).code, code);
    }
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    failure = 'ESRCH';
    assert.deepEqual(pidPresence(12345, { group: true }), { presence: 'unknown' });
    assert.equal(pidPresence(12345).presence, 'absent');
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  assert.deepEqual(probes, [12345, -12345, -12345, -12345, 12345]);
});

test('raceAbort keeps the promise outcome and rejects an abort with the coded error unless the reason is propagated', async () => {
  assert.equal(await raceAbort(Promise.resolve('value'), new AbortController().signal, cancelled), 'value');
  await assert.rejects(raceAbort(Promise.reject(new Error('original')), new AbortController().signal, cancelled), /original/);
  const reason = new Error('private caller context');
  for (const propagateReason of [false, true]) {
    const controller = new AbortController();
    const pending = raceAbort(new Promise<never>(() => {}), controller.signal, cancelled, { propagateReason });
    controller.abort(reason);
    await assert.rejects(pending, error => propagateReason ? error === reason : (error as EngineError).code === 'CANCELLED');
  }
  const aborted = new AbortController();
  aborted.abort();
  let late!: (error: Error) => void;
  const lateFailure = new Promise<never>((_resolve, reject) => { late = reject; });
  await assert.rejects(raceAbort(lateFailure, aborted.signal, cancelled), { code: 'CANCELLED' });
  late(new Error('observed after the abort'));
});

test('settleWithin reports whether the promise settled either way before its deadline', async () => {
  assert.equal(await settleWithin(Promise.resolve(1), 1_000), true);
  const failed = Promise.reject(new Error('fixture failure'));
  assert.equal(await settleWithin(failed, 1_000), true);
  await assert.rejects(failed, /fixture failure/);
  assert.equal(await settleWithin(new Promise(() => {}), 5), false);
});
