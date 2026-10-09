import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { MoodcodeEngine } from '@moodcode/engine';
import { attachUtilityWorker, type UtilityPort } from './runtime.js';
import type { WorkerPush, WorkerResponse } from './protocol.js';

class Port extends EventEmitter implements UtilityPort {
  readonly messages: (WorkerResponse | WorkerPush)[] = [];
  readonly order: string[];
  broken = false;
  constructor(order: string[] = []) { super(); this.order = order; }
  postMessage(message: WorkerResponse | WorkerPush): void {
    if (this.broken) throw new Error('Disconnected parent');
    this.messages.push(message);
    this.order.push('type' in message ? 'update' : `reply:${message.id}`);
  }
}
class Lifecycle extends EventEmitter {
  readonly codes: number[] = [];
  constructor(readonly order: string[] = []) { super(); }
  exit(code = 0): void { this.codes.push(code); this.order.push(`exit:${code}`); }
}
function engine(close: () => Promise<void>): Pick<MoodcodeEngine, 'store' | 'dispatch' | 'subscribe' | 'close'> {
  return { store: { listWorkspaces: () => [] } as unknown as MoodcodeEngine['store'],
    dispatch: async () => ({ schemaVersion: 1, commandId: 'capabilities', ok: true, result: {} }),
    async *subscribe() {}, close };
}
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(2); }
  throw new Error('Utility test condition was not reached');
}
const start = { id: 'start', type: 'start', payload: { dbPath: ':memory:', artifactDir: '/tmp/moodcode-runtime-unused', config: { providerId: 'scripted', modelId: 'echo', baseURL: '' } } };

test('close acknowledgement precedes utility exit and listener cleanup', async () => {
  const order: string[] = [];
  const port = new Port(order);
  const lifecycle = new Lifecycle(order);
  let closed = 0;
  const attached = attachUtilityWorker(port, lifecycle, { createEngine: () => engine(async () => { closed++; order.push('engine-closed'); }) });
  port.emit('message', { data: start });
  await until(() => port.messages.length === 1);
  port.emit('message', { data: { id: 'close', type: 'close' } });
  await until(() => lifecycle.codes.length === 1);
  assert.deepEqual(order, ['reply:start', 'engine-closed', 'reply:close', 'exit:0']);
  assert.equal(port.listenerCount('message'), 0);
  assert.equal(lifecycle.listenerCount('SIGTERM'), 0);
  await attached.shutdown();
  assert.equal(closed, 1);
});

test('signal and parent disconnect wait for engine cleanup and exit only once', async () => {
  for (const trigger of ['SIGTERM', 'SIGINT', 'disconnect', 'port-close']) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const port = new Port();
    const lifecycle = new Lifecycle();
    const attached = attachUtilityWorker(port, lifecycle, { createEngine: () => engine(() => gate) });
    port.emit('message', { data: start });
    await until(() => port.messages.length === 1);
    if (trigger === 'port-close') port.emit('close'); else lifecycle.emit(trigger);
    lifecycle.emit('disconnect');
    await delay(5);
    assert.deepEqual(lifecycle.codes, []);
    release();
    await until(() => lifecycle.codes.length === 1);
    assert.deepEqual(lifecycle.codes, [0]);
    await attached.shutdown();
    assert.equal(port.listenerCount('close'), 0);
    assert.equal(lifecycle.listenerCount('disconnect'), 0);
  }
});

test('invalid request is a bounded reply and does not terminate utility', async () => {
  const port = new Port();
  const lifecycle = new Lifecycle();
  const attached = attachUtilityWorker(port, lifecycle);
  port.emit('message', { data: { id: 'invalid', type: 'raw-sql', payload: { secret: 'private' } } });
  await until(() => port.messages.length === 1);
  const response = port.messages[0] as WorkerResponse;
  assert.equal(response.ok, false);
  assert.ok(!JSON.stringify(response).includes('private'));
  assert.deepEqual(lifecycle.codes, []);
  await attached.shutdown();
});

test('failed parent transport closes engine without leaking request tasks', async () => {
  const port = new Port();
  const lifecycle = new Lifecycle();
  let closed = 0;
  const attached = attachUtilityWorker(port, lifecycle, { createEngine: () => engine(async () => { closed++; }) });
  port.emit('message', { data: start });
  await until(() => port.messages.length === 1);
  port.broken = true;
  port.emit('message', { data: { id: 'bootstrap', type: 'bootstrap' } });
  await until(() => lifecycle.codes.length === 1);
  assert.equal(closed, 1);
  assert.equal(port.listenerCount('message'), 0);
  await attached.shutdown();
});

test('cleanup failure is surfaced before utility can acknowledge close', async () => {
  const port = new Port();
  const lifecycle = new Lifecycle();
  const attached = attachUtilityWorker(port, lifecycle, { createEngine: () => engine(async () => { throw new Error('private failure'); }) });
  port.emit('message', { data: start });
  await until(() => port.messages.length === 1);
  port.emit('message', { data: { id: 'close', type: 'close' } });
  await until(() => port.messages.length === 2);
  const response = port.messages[1] as WorkerResponse;
  assert.equal(response.ok, false);
  assert.ok(!JSON.stringify(response).includes('private failure'));
  assert.deepEqual(lifecycle.codes, []);
  await assert.rejects(attached.shutdown());
});


test('engine close followed by failed ACK delivery exits without inventing a close receipt', async () => {
  const order: string[] = []; const port = new Port(order); const lifecycle = new Lifecycle(order); let closed = 0;
  const attached = attachUtilityWorker(port, lifecycle, { createEngine: () => engine(async () => { closed++; order.push('engine-closed'); }) });
  port.emit('message', { data: start }); await until(() => port.messages.length === 1);
  port.broken = true; port.emit('message', { data: { id: 'close-unobserved', type: 'close' } });
  await until(() => lifecycle.codes.length === 1);
  assert.deepEqual(order, ['reply:start', 'engine-closed', 'exit:0']);
  assert.equal(port.messages.some(message => 'id' in message && message.id === 'close-unobserved'), false);
  assert.equal(closed, 1); await attached.shutdown();
});
