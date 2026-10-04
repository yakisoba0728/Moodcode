import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { CommandEnvelope, CommandResult, EngineEvent } from '@moodcode/contracts';
import { runHarness, type HarnessEngine } from './protocol.js';
import { parseArguments, withSubmitDefaults } from './index.js';

const command = (id: string, type: string, payload: object = {}) => ({ schemaVersion: 1, commandId: id, type, payload });
const event = (seq: number): EngineEvent => ({ schemaVersion: 1, eventId: `event-${seq}`, sessionId: 'session', runId: 'run', seq, timestamp: '2026-10-04T00:00:00.000Z', type: 'message.delta', payload: { delta: 'hello' } });

function fixture(engineOverrides: Partial<HarnessEngine> = {}, options: Partial<Parameters<typeof runHarness>[1]> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const signals = new EventEmitter();
  let lines = '';
  let errors = '';
  output.on('data', (chunk) => { lines += chunk.toString(); });
  diagnostics.on('data', (chunk) => { errors += chunk.toString(); });
  let closed = 0;
  const calls: CommandEnvelope[] = [];
  const engine: HarnessEngine = {
    async dispatch(request) {
      calls.push(request);
      return { schemaVersion: 1, commandId: request.commandId, ok: true, result: request.payload };
    },
    async *subscribe(_session, _afterSeq, signal) {
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    },
    close() { closed++; },
    ...engineOverrides,
  };
  const completion = runHarness(engine, { input, output, diagnostics, signals, shutdownTimeoutMs: 500, ...options });
  return {
    input, output, diagnostics, signals, calls, completion,
    get closed() { return closed; },
    get errors() { return errors; },
    records: () => lines.trim() ? lines.trim().split('\n').map((line) => JSON.parse(line)) as Record<string, any>[] : [],
    send: (value: unknown) => input.write(JSON.stringify(value) + '\n'),
  };
}

async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > limit) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('dispatch remains concurrent while cancel and approval control commands arrive', async () => {
  let release!: (value: CommandResult) => void;
  const requests: string[] = [];
  const f = fixture({ dispatch(request) {
    requests.push(request.type);
    if (request.type === 'run.submit') return new Promise((resolve) => { release = resolve; });
    return Promise.resolve({ schemaVersion: 1, commandId: request.commandId, ok: true, result: {} });
  } });
  f.send(command('submit', 'run.submit', { sessionId: 'session', requestId: 'request', prompt: 'hello' }));
  f.send(command('cancel', 'run.cancel', { runId: 'run' }));
  f.send(command('decide', 'approval.decide', { approvalId: 'approval', decision: 'allow', fingerprint: 'fingerprint' }));
  await until(() => f.records().length === 2);
  assert.deepEqual(requests, ['run.submit', 'run.cancel', 'approval.decide']);
  assert.deepEqual(f.records().map((record) => record.commandId), ['cancel', 'decide']);
  release({ schemaVersion: 1, commandId: 'submit', ok: true, result: { runId: 'run' } });
  await until(() => f.records().length === 3);
  f.input.end();
  assert.deepEqual(await f.completion, { reason: 'eof', exitCode: 0 });
  assert.equal(f.closed, 1);
});

test('subscribe validates through facade and replays afterSeq with result before events', async () => {
  let cursor = -1;
  const f = fixture({ async *subscribe(_session, afterSeq) { cursor = afterSeq; yield event(afterSeq + 1); yield event(afterSeq + 2); } });
  f.send(command('subscription', 'events.subscribe', { sessionId: 'session', afterSeq: 4 }));
  await until(() => f.records().length === 3);
  assert.equal(cursor, 4);
  assert.equal(f.calls[0]?.type, 'events.subscribe');
  assert.equal(f.records()[0]?.type, 'result');
  assert.deepEqual(f.records().slice(1).map((record) => [record.type, record.subscriptionId, record.event.seq]), [['event', 'subscription', 5], ['event', 'subscription', 6]]);
  f.input.end();
  await f.completion;
});

test('malformed, unknown, oversized and invalid UTF-8 records are bounded and intake recovers', async () => {
  const f = fixture({}, { maxInputBytes: 160 });
  f.input.write('bad JSON\n');
  f.send(command('unknown', 'not.a.command'));
  f.input.write('x'.repeat(200));
  f.input.write('\n');
  f.input.write(Buffer.from([0xff, 10]));
  f.send(command('good', 'session.list', { workspaceId: 'workspace' }));
  f.input.end();
  assert.equal((await f.completion).exitCode, 0);
  const records = f.records();
  assert.deepEqual(records.filter((record) => !record.ok).map((record) => record.error.code), ['INVALID_JSON', 'UNKNOWN_COMMAND', 'INPUT_TOO_LARGE', 'INVALID_JSON']);
  assert.equal(records.find((record) => record.commandId === 'good')?.ok, true);
  assert.equal(f.calls.length, 1);
});

test('a chunked final JSON record without newline is processed at EOF', async () => {
  const f = fixture();
  const line = JSON.stringify(command('last', 'session.list', { workspaceId: 'workspace' }));
  f.input.write(line.slice(0, 20));
  f.input.end(line.slice(20));
  await f.completion;
  assert.equal(f.records()[0]?.commandId, 'last');
});

test('EOF waits for an asynchronous command mutation before closing storage', async () => {
  let closed = false;
  const f = fixture({ async dispatch(request) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(closed, false);
    return { schemaVersion: 1, commandId: request.commandId, ok: true, result: { id: 'workspace' } };
  }, close() { closed = true; } });
  f.send(command('open', 'workspace.open', { path: '/fixture' }));
  f.input.end();
  assert.equal((await f.completion).exitCode, 0);
  assert.equal(closed, true);
  assert.equal(f.records()[0]?.ok, true);
});

test('errors truncate messages and redact API keys without exposing details', async () => {
  const secret = 'secret-"api\\key';
  const f = fixture({ async dispatch() { throw Object.assign(new Error(secret + 'x'.repeat(5_000)), { code: 'FAKE_ERROR', details: { apiKey: secret } }); } }, { secrets: [secret] });
  f.send(command('error', 'session.list', { workspaceId: 'workspace' }));
  f.input.end();
  await f.completion;
  const failure = f.records()[0]?.error;
  assert.equal(failure.code, 'FAKE_ERROR');
  assert.equal(failure.message.length, 2_048);
  assert.match(failure.message, /^\[REDACTED\]/);
  assert.equal(failure.details, undefined);
});

test('returned engine failures also obey error bounds', async () => {
  const f = fixture({ async dispatch(request) { return { schemaVersion: 1, commandId: request.commandId, ok: false, error: { code: 'FAKE_ERROR', message: 'x'.repeat(10_000), details: { private: 'payload' } } }; } });
  f.send(command('error', 'session.list', { workspaceId: 'workspace' }));
  f.input.end();
  await f.completion;
  assert.equal(f.records()[0]?.error.message.length, 2_048);
  assert.equal(f.records()[0]?.error.details, undefined);
});

test('subscription caps reserve capacity during asynchronous dispatch', async () => {
  let release!: (value: CommandResult) => void;
  const f = fixture({ dispatch(request) { return new Promise((resolve) => { release = (result) => resolve({ ...result, commandId: request.commandId }); }); } }, { maxSubscriptions: 1 });
  f.send(command('first', 'events.subscribe', { sessionId: 'session' }));
  f.send(command('second', 'events.subscribe', { sessionId: 'session' }));
  await until(() => f.records().length === 1);
  assert.equal(f.records()[0]?.error.code, 'SUBSCRIPTION_LIMIT');
  release({ schemaVersion: 1, commandId: 'first', ok: true, result: {} });
  await until(() => f.records().length === 2);
  f.input.end();
  await f.completion;
});

test('control commands have reserved capacity when ordinary command slots are occupied', async () => {
  const resolvers: (() => void)[] = [];
  const f = fixture({ dispatch(request) {
    if (request.type !== 'run.cancel') return new Promise((resolve) => resolvers.push(() => resolve({ schemaVersion: 1, commandId: request.commandId, ok: true, result: {} })));
    return Promise.resolve({ schemaVersion: 1, commandId: request.commandId, ok: true, result: {} });
  } }, { maxConcurrentCommands: 1 });
  f.send(command('busy', 'session.list', { workspaceId: 'workspace' }));
  f.send(command('overload', 'session.list', { workspaceId: 'workspace' }));
  f.send(command('cancel', 'run.cancel', { runId: 'run' }));
  await until(() => f.records().length === 2);
  assert.equal(f.records().find((record) => record.commandId === 'overload')?.error.code, 'COMMAND_LIMIT');
  assert.equal(f.records().find((record) => record.commandId === 'cancel')?.ok, true);
  resolvers.forEach((release) => release());
  f.input.end();
  await f.completion;
});

test('SIGTERM aborts event readers and closes the engine once', async () => {
  let aborted = false;
  const f = fixture({ async *subscribe(_session, _cursor, signal) {
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  } });
  f.send(command('sub', 'events.subscribe', { sessionId: 'session' }));
  await until(() => f.records().length === 1);
  f.signals.emit('SIGTERM');
  assert.deepEqual(await f.completion, { reason: 'signal', exitCode: 0 });
  assert.equal(aborted, true);
  assert.equal(f.closed, 1);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('oversized engine output becomes a bounded command failure', async () => {
  const f = fixture({ async dispatch(request) { return { schemaVersion: 1, commandId: request.commandId, ok: true, result: 'x'.repeat(3_000) }; } }, { maxOutputBytes: 1_024 });
  f.send(command('large', 'session.list', { workspaceId: 'workspace' }));
  f.input.end();
  assert.equal((await f.completion).exitCode, 0);
  assert.equal(f.records()[0]?.error.code, 'OUTPUT_TOO_LARGE');
});

test('blocked stdout does not stall engine cleanup and has a shutdown deadline', async () => {
  const blocked = new Writable({ write(_chunk, _encoding, _callback) { /* Simulated consumer never drains. */ } });
  let closed = false;
  const f = fixture({ close() { closed = true; } }, { output: blocked, shutdownTimeoutMs: 20 });
  f.send(command('result', 'session.list', { workspaceId: 'workspace' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  f.input.end();
  assert.equal((await f.completion).exitCode, 1);
  assert.equal(closed, true);
  assert.equal(blocked.destroyed, true);
  assert.match(f.errors, /Cleanup exceeded/);
});

test('the output byte queue is bounded under concurrent responses', async () => {
  const blocked = new Writable({ write(_chunk, _encoding, _callback) {} });
  const f = fixture({}, { output: blocked, maxQueuedOutputBytes: 200, shutdownTimeoutMs: 20 });
  for (let index = 0; index < 10; index++) f.send(command(String(index), 'session.list', { workspaceId: 'workspace' }));
  assert.equal((await f.completion).exitCode, 1);
  assert.match(f.errors, /Output queue exceeded/);
});

test('CLI flags select local defaults and reject credentials in arguments', () => {
  assert.deepEqual(parseArguments([], '/tmp/workspace'), { dbPath: '/tmp/workspace/.moodcode/engine.sqlite', artifactDir: '/tmp/workspace/.moodcode/artifacts', provider: 'scripted', modelId: 'local', baseURL: undefined, help: false, explicit: { provider: false, model: false, baseURL: false } });
  assert.equal(parseArguments(['--db=state.sqlite', '--artifacts', 'artifacts', '--provider', 'openai-compatible', '--base-url', 'http://127.0.0.1:8080/v1', '--model', 'fixture'], '/tmp').modelId, 'fixture');
  for (const args of [['--api-key=secret'], ['--apiKey', 'secret'], ['--provider', 'openai-compatible'], ['--base-url', 'https://secret:token@example.test/v1'], ['--base-url', 'https://example.test/?key=secret']]) assert.throws(() => parseArguments(args), /API keys|requires|without credentials/);
  assert.throws(() => parseArguments(['--unknown-secret=secret']), (error: Error) => !error.message.includes('secret'));
});

test('CLI-selected provider/model fill only missing valid submit config fields', async () => {
  const observed: CommandEnvelope[] = [];
  const engine: HarnessEngine = { async dispatch(value) { observed.push(value); return { schemaVersion: 1, commandId: value.commandId, ok: true }; }, async *subscribe() {}, close() {} };
  const configured = withSubmitDefaults(engine, 'openai-compatible', 'fixture');
  await configured.dispatch(command('a', 'run.submit', { sessionId: 'session', requestId: 'request', prompt: 'hello' }) as CommandEnvelope);
  await configured.dispatch(command('b', 'run.submit', { config: { modelId: 'explicit', mode: 'build' } }) as CommandEnvelope);
  await configured.dispatch(command('c', 'run.submit', { config: null }) as CommandEnvelope);
  assert.deepEqual(observed[0]?.payload.config, { providerId: 'openai-compatible', modelId: 'fixture' });
  assert.deepEqual(observed[1]?.payload.config, { providerId: 'openai-compatible', modelId: 'explicit', mode: 'build' });
  assert.equal(observed[2]?.payload.config, null);
});
