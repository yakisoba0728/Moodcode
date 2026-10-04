import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { CommandEnvelope } from '@moodcode/contracts';
import { DESKTOP_CHANNELS } from '../main/ipc-channels.js';
import { createDesktopApi, validateDesktopCommand, validateDesktopSettings } from './api.js';
import type { DesktopTransport } from './api.js';
import type { DesktopUpdate, HostStatus, SaveDesktopSettings } from '../shared/protocol.js';

class TransportDouble extends EventEmitter implements DesktopTransport {
  invocations: { channel: string; args: unknown[] }[] = [];
  response: unknown = { ok: true, value: undefined };
  async invoke(channel: string, ...args: unknown[]) { this.invocations.push({ channel, args }); return this.response; }
}
const submit = (payload: Record<string, unknown> = {}): CommandEnvelope => ({
  schemaVersion: 1, commandId: 'fixture-command', type: 'run.submit',
  payload: { sessionId: 'fixture-session', requestId: 'fixture-request', prompt: 'fixture', ...payload } as CommandEnvelope['payload'],
});
const update: DesktopUpdate = { subscriptionId: 'subscription', sessionId: 'session', lastSeq: 12 };
const status: HostStatus = { state: 'ready', generation: 1 };
const settings: SaveDesktopSettings = { providerId: 'openai-responses', modelId: 'fixture-model', baseURL: 'https://example.test/v1', apiKey: 'fixture-secret' };
const invalid = (error: unknown) => error instanceof Error && 'code' in error && (error.code === 'INVALID_INPUT' || error.code === 'UNKNOWN_COMMAND') && !error.message.includes('fixture-secret');

test('desktop bridge is frozen and exposes only the typed API', () => {
  const api = createDesktopApi(new TransportDouble());
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), ['chooseWorkspace', 'command', 'getBootstrap', 'onHostState', 'onUpdate', 'openExternal', 'retryEngine', 'saveSettings', 'subscribe', 'unsubscribe'].sort());
  assert.equal('invoke' in api, false);
  assert.equal('send' in api, false);
  assert.equal('ipcRenderer' in api, false);
});

test('bridge methods map to the closed IPC channel list and unwrap success envelopes', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  transport.response = { ok: true, value: 'fixture-result' };
  assert.equal(await api.getBootstrap(), 'fixture-result');
  assert.equal(await api.chooseWorkspace(), 'fixture-result');
  assert.equal(await api.command(submit()), 'fixture-result');
  assert.equal(await api.subscribe('session', 42), 'fixture-result');
  assert.equal(await api.unsubscribe('subscription'), 'fixture-result');
  assert.equal(await api.saveSettings(settings), 'fixture-result');
  assert.equal(await api.retryEngine(), 'fixture-result');
  assert.equal(await api.openExternal('https://example.test/docs'), 'fixture-result');
  assert.deepEqual(transport.invocations.map(({ channel }) => channel), [
    DESKTOP_CHANNELS.bootstrap, DESKTOP_CHANNELS.chooseWorkspace, DESKTOP_CHANNELS.command, DESKTOP_CHANNELS.subscribe,
    DESKTOP_CHANNELS.unsubscribe, DESKTOP_CHANNELS.saveSettings, DESKTOP_CHANNELS.retryEngine, DESKTOP_CHANNELS.openExternal,
  ]);
  assert.deepEqual(transport.invocations[3]?.args, ['session', 42]);
  assert.deepEqual(transport.invocations[4]?.args, ['subscription']);
  assert.deepEqual(transport.invocations[7]?.args, ['https://example.test/docs']);
});

test('host error codes survive private envelopes, including INVALID_INPUT', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const code of ['ENGINE_BUSY', 'WORKSPACE_BUSY', 'IPC_FORBIDDEN', 'INVALID_INPUT']) {
    transport.response = { ok: false, error: { code, message: 'A safe fixture failure.' } };
    await assert.rejects(api.retryEngine(), (error: Error & { code?: string }) => error.code === code && error.message === 'A safe fixture failure.');
  }
});

test('invalid private envelopes fail safely rather than leaking arbitrary response contents', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const response of [null, 'fixture-secret', { ok: true }, { ok: true, value: {}, apiKey: 'fixture-secret' },
    { ok: true, value: {}, error: {} }, { ok: false, error: { code: 'FAILED', message: 'fixture-secret', apiKey: 'fixture-secret' } },
    { ok: false, error: { code: 'FAILED', message: 'x'.repeat(1025) } }, { ok: false, error: { code: 'FAILED', message: 'failure' }, value: 1 }]) {
    transport.response = response;
    await assert.rejects(api.getBootstrap(), (error: Error & { code?: string }) => error.code === 'IPC_INVALID_RESPONSE' && !error.message.includes('fixture-secret'));
  }
});

test('transport failures are sanitized and do not expose Electron or host error details', async () => {
  const transport = new TransportDouble();
  transport.invoke = async () => { throw new Error('An arbitrary Electron failure with fixture-secret.'); };
  const api = createDesktopApi(transport);
  await assert.rejects(api.getBootstrap(), (error: Error & { code?: string }) => error.code === 'IPC_TRANSPORT_FAILED' && !error.message.includes('fixture-secret'));
});

test('command validation preserves omitted and partial run settings for utility defaults', () => {
  const omitted = validateDesktopCommand(submit());
  assert.equal(Object.hasOwn(omitted.payload, 'config'), false);
  for (const config of [{}, { mode: 'build' }, { providerId: 'codex' }, { modelId: 'fixture-model', limits: { maxTurns: 3 } }]) {
    const original = submit({ config });
    const copy = validateDesktopCommand(original);
    assert.deepEqual(copy.payload.config, config);
    assert.notEqual(copy, original);
    assert.notEqual(copy.payload, original.payload);
    assert.notEqual(copy.payload.config, config);
    if ('limits' in config) {
      const copied = copy.payload.config as { limits: unknown };
      assert.notEqual(copied.limits, config.limits);
    }
  }
});

test('command validation copies every supported bounded envelope without mutating inputs', () => {
  const command: CommandEnvelope = { schemaVersion: 1, commandId: 'snapshot', type: 'session.getSnapshot', payload: { sessionId: 'session' } };
  Object.freeze(command.payload);
  Object.freeze(command);
  assert.deepEqual(validateDesktopCommand(command), command);
  assert.notEqual(validateDesktopCommand(command).payload, command.payload);
});

test('invalid commands fail before transport and do not copy credential attempts into errors', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const command of [submit({ apiKey: 'fixture-secret' }), submit({ config: { providerId: 'scripted', apiKey: 'fixture-secret' } }),
    submit({ prompt: 'x'.repeat(131073) }), submit({ config: null }), { ...submit(), type: 'fixture-secret' },
    { ...submit(), payload: { sessionId: 'fixture-secret\n' } }, { ...submit(), schemaVersion: 100 }]) {
    await assert.rejects(api.command(command as CommandEnvelope), (error: Error) => !error.message.includes('fixture-secret'));
  }
  assert.equal(transport.invocations.length, 0);
});

test('subscription identifiers and cursors are bounded before invoking main', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const id of ['', 'x'.repeat(257), '한'.repeat(100), 'fixture-secret\n', 5]) {
    await assert.rejects(api.subscribe(id as string, 0), invalid);
    await assert.rejects(api.unsubscribe(id as string), invalid);
  }
  for (const cursor of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '0']) {
    await assert.rejects(api.subscribe('session', cursor as number), invalid);
  }
  assert.equal(transport.invocations.length, 0);
});

test('settings accepts known providers, copies credentials once, and supports inferred Codex model', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  const copy = validateDesktopSettings(settings);
  assert.deepEqual(copy, settings);
  assert.notEqual(copy, settings);
  for (const input of [settings, { ...settings, providerId: 'openai-compatible' as const },
    { providerId: 'scripted' as const, modelId: 'local', baseURL: '', clearKey: true },
    { providerId: 'codex' as const, modelId: '', baseURL: '' }]) await api.saveSettings(input);
  assert.equal(transport.invocations.length, 4);
});

test('settings rejects unknown, credential URLs, getter, extra and unbounded fields before IPC', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const input of [null, [], { ...settings, providerId: 'fixture-secret' }, { ...settings, token: 'fixture-secret' },
    { ...settings, apiKey: 'x'.repeat(4097) }, { ...settings, apiKey: 'fixture-secret ' }, { ...settings, clearKey: true },
    { ...settings, clearKey: 'fixture-secret' }, { ...settings, modelId: '' }, { ...settings, modelId: 'x'.repeat(257) },
    { ...settings, baseURL: 'https://user:fixture-secret@example.test/v1' }, { ...settings, baseURL: 'https://example.test/v1?key=fixture-secret' },
    { ...settings, baseURL: 'https://example.test/v1#fixture-secret' }, { ...settings, providerId: 'scripted', baseURL: '' },
    { ...settings, providerId: 'codex', baseURL: '' }, { ...settings, get apiKey() { throw new Error('fixture-secret'); } }]) {
    await assert.rejects(api.saveSettings(input as SaveDesktopSettings), invalid);
  }
  assert.equal(transport.invocations.length, 0);
});

test('uninspectable settings are rejected with a safe input error', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  const input = new Proxy(settings, { getPrototypeOf() { throw new Error('fixture-secret'); } });
  await assert.rejects(api.saveSettings(input), invalid);
  assert.equal(transport.invocations.length, 0);
});

test('external links are bounded and validated before invoking main', async () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  for (const url of ['file:///fixture-secret', 'javascript:fixture-secret', 'data:text/html,fixture-secret', 'https://user:fixture-secret@example.test', ' https://example.test']) {
    await assert.rejects(api.openExternal(url), invalid);
  }
  assert.equal(transport.invocations.length, 0);
});

test('event bridges strip the Electron event and return copied frozen bounded payloads', () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  const updates: DesktopUpdate[] = [];
  const statuses: HostStatus[] = [];
  api.onUpdate((value) => updates.push(value));
  api.onHostState((value) => statuses.push(value));
  const electronEvent = { sender: { fixtureSecret: true } };
  transport.emit(DESKTOP_CHANNELS.update, electronEvent, update);
  transport.emit(DESKTOP_CHANNELS.hostState, electronEvent, status);
  assert.deepEqual(updates, [update]);
  assert.deepEqual(statuses, [status]);
  assert.notEqual(updates[0], update);
  assert.notEqual(statuses[0], status);
  assert.equal(Object.isFrozen(updates[0]), true);
  assert.equal(Object.isFrozen(statuses[0]), true);
});

test('malformed and oversize updates and host states are dropped without invoking the listener', () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  let calls = 0;
  api.onUpdate(() => calls++);
  api.onHostState(() => calls++);
  for (const payload of [null, { ...update, output: 'fixture-secret' }, { ...update, subscriptionId: 'x'.repeat(257) },
    { ...update, lastSeq: -1 }, { ...update, lastSeq: Infinity }, { ...update, error: { code: 'FAILED', message: 'x'.repeat(1025) } },
    { ...update, get lastSeq() { throw new Error('fixture-secret'); } }]) transport.emit(DESKTOP_CHANNELS.update, {}, payload);
  for (const payload of [null, { ...status, state: 'fixture-secret' }, { ...status, generation: -1 }, { ...status, apiKey: 'fixture-secret' },
    { ...status, error: { code: 'FAILED', message: 'failure', apiKey: 'fixture-secret' } }]) transport.emit(DESKTOP_CHANNELS.hostState, {}, payload);
  assert.equal(calls, 0);
});

test('bounded event errors survive as copied data and cannot expose arbitrary event fields', () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  const values: DesktopUpdate[] = [];
  api.onUpdate((value) => values.push(value));
  const payload = { ...update, error: { code: 'SUBSCRIPTION_FAILED', message: 'A safe failure.' } };
  transport.emit(DESKTOP_CHANNELS.update, {}, payload);
  assert.deepEqual(values, [payload]);
  assert.notEqual(values[0]?.error, payload.error);
  assert.equal(Object.isFrozen(values[0]?.error), true);
});

test('duplicate listeners are independent and unsubscribe is exact and idempotent', () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  let calls = 0;
  const listener = () => calls++;
  const removeFirst = api.onUpdate(listener);
  const removeSecond = api.onUpdate(listener);
  transport.emit(DESKTOP_CHANNELS.update, {}, update);
  assert.equal(calls, 2);
  removeFirst();
  removeFirst();
  transport.emit(DESKTOP_CHANNELS.update, {}, update);
  assert.equal(calls, 3);
  assert.equal(transport.listenerCount(DESKTOP_CHANNELS.update), 1);
  removeSecond();
  transport.emit(DESKTOP_CHANNELS.update, {}, update);
  assert.equal(calls, 3);
  assert.equal(transport.listenerCount(DESKTOP_CHANNELS.update), 0);
});

test('repeated mount/unmount leaks no listeners and renderer callback errors do not block others', () => {
  const transport = new TransportDouble();
  const api = createDesktopApi(transport);
  const unrelated = () => {};
  transport.on(DESKTOP_CHANNELS.update, unrelated);
  for (let index = 0; index < 100; index++) {
    const offUpdate = api.onUpdate(() => {});
    const offStatus = api.onHostState(() => {});
    offUpdate();
    offStatus();
  }
  assert.deepEqual(transport.listeners(DESKTOP_CHANNELS.update), [unrelated]);
  assert.equal(transport.listenerCount(DESKTOP_CHANNELS.hostState), 0);
  api.onUpdate(() => { throw new Error('A renderer callback failed.'); });
  let calls = 0;
  api.onUpdate(() => calls++);
  assert.doesNotThrow(() => transport.emit(DESKTOP_CHANNELS.update, {}, update));
  assert.equal(calls, 1);
});
