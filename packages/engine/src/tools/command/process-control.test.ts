import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupGroup, createCommandEnvironment, groupExists, registerCredentialEnvNames } from './process-control.js';

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`fixture ${code}`), { code });
}

test('host-declared credential names are stripped in any case from later command environments', () => {
  const source = { PATH: '/bin', WORK_LLM_GATEWAY_KEY: 'fake', work_llm_gateway_key: 'fake', WORK_LLM_GATEWAY_URL: 'http://fixture' };
  assert.deepEqual(createCommandEnvironment(source), source);
  registerCredentialEnvNames(['Work_Llm_Gateway_Key']);
  assert.deepEqual(createCommandEnvironment(source), { PATH: '/bin', WORK_LLM_GATEWAY_URL: 'http://fixture' });
  assert.equal(source.WORK_LLM_GATEWAY_KEY, 'fake', 'the caller environment must remain unchanged');
});

test('permission-denied group probes retain uncertainty until absence is observed', t => {
  const kill = t.mock.method(process, 'kill', () => { throw systemError('EPERM'); });
  assert.equal(groupExists(12345), true);
  kill.mock.mockImplementation(() => { throw systemError('ESRCH'); });
  assert.equal(groupExists(12345), false);
});

test('cleanup survives a denied signal and transient probes only after confirmed group absence', async t => {
  const calls: (number | NodeJS.Signals | undefined)[] = [];
  let probes = 0;
  t.mock.method(process, 'kill', (pid: number, signal?: number | NodeJS.Signals) => {
    assert.equal(pid, -12345);
    calls.push(signal);
    if (signal !== 0 || ++probes === 1) throw systemError('EPERM');
    throw systemError('ESRCH');
  });
  assert.equal(await cleanupGroup(12345), true);
  assert.deepEqual(calls, ['SIGTERM', 0, 0]);
});

test('persistent permission denial cannot release an uncertain group', { timeout: 5000 }, async t => {
  const calls: (number | NodeJS.Signals | undefined)[] = [];
  t.mock.method(process, 'kill', (_pid: number, signal?: number | NodeJS.Signals) => {
    calls.push(signal);
    throw systemError('EPERM');
  });
  assert.equal(await cleanupGroup(12345), false);
  assert.ok(calls.includes('SIGTERM'));
  assert.ok(calls.includes('SIGKILL'));
});

test('unexpected process-control errors remain explicit', async t => {
  t.mock.method(process, 'kill', () => { throw systemError('EIO'); });
  assert.throws(() => groupExists(12345), { code: 'EIO' });
  await assert.rejects(cleanupGroup(12345), { code: 'EIO' });
});
