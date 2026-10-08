import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopApi, type DesktopTransport } from './api.js';
import { DESKTOP_CHANNELS } from '../main/ipc-channels.js';

test('advanced bridge copies bounded JSON and transports only typed methods', async () => {
  const calls: [string, unknown[]][] = [];
  const transport: DesktopTransport = { invoke: async (channel, ...args) => { calls.push([channel,args]); return { ok: true, value: { committed: true } }; }, on() {}, removeListener() {} };
  const api = createDesktopApi(transport);
  const request = { sessionId: 'session', type: 'question.answer' as const, payload: { questionId: 'question', version: 1, answer: { optionIds: ['choice'] } } };
  await api.advanced!(request); request.payload.answer.optionIds.push('later');
  assert.deepEqual(calls[0], [DESKTOP_CHANNELS.advanced, [{ sessionId: 'session', type: 'question.answer', payload: { questionId: 'question', version: 1, answer: { optionIds: ['choice'] } } }]]);
  await api.getAdvancedSnapshot!('session'); assert.equal(calls[1]![0], DESKTOP_CHANNELS.advancedSnapshot);
  for (const input of [
    { sessionId: 'session', type: 'engine.eval', payload: {} },
    { sessionId: 'session', type: 'terminal.create', original: {}, payload: {} },
    { sessionId: 'session', type: 'input.accept', payload: { prompt: 'x'.repeat(65_537) } },
    { sessionId: 'session', type: 'question.answer', get payload() { throw new Error('getter must remain inert'); } },
  ]) await assert.rejects(api.advanced!(input as never));
  assert.equal(calls.length, 2);
});

test('account and updater bridges enforce their closed payloads before IPC', async () => {
  let calls = 0;
  const api = createDesktopApi({ invoke: async () => { calls++; return { ok: true, value: null }; }, on() {}, removeListener() {} });
  await api.accountAction!({ action: 'cancel' }); await api.appUpdateAction!({ action: 'check' });
  await assert.rejects(api.accountAction!({ action: 'select', accountId: 'id', accessToken: 'fixture-secret' } as never));
  await assert.rejects(api.appUpdateAction!({ action: 'install', acknowledged: false } as never));
  assert.equal(calls, 2);
});
