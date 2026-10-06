import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { SessionCommandResult } from '@moodcode/contracts';
import { runHarness, type HarnessEngine } from './protocol.js';

function fixture(overrides: Partial<HarnessEngine> = {}, maxConcurrentCommands = 1) {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  let text = '';
  output.on('data', bytes => { text += bytes.toString(); });
  const engine: HarnessEngine = {
    async dispatch(command) { return { schemaVersion: 1, commandId: command.commandId, ok: true, result: command.payload }; },
    async *subscribe() {}, close() {}, ...overrides,
  };
  const completed = runHarness(engine, { input, output, diagnostics, signals: new EventEmitter(), maxConcurrentCommands });
  return { input, completed, send: (value: unknown) => input.write(JSON.stringify(value) + '\n'), records: () => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
async function until(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 1000) throw new Error('Harness did not respond');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('session schema commands are opt-in and future versions remain rejected', async () => {
  const f = fixture();
  f.send({ schemaVersion: 2, commandId: 'native', type: 'input.accept', payload: {} });
  await until(() => f.records().length === 1);
  assert.equal(f.records()[0].schemaVersion, 2);
  assert.equal(f.records()[0].error.code, 'COMMAND_UNAVAILABLE');
  f.send({ schemaVersion: 3, commandId: 'future', type: 'input.accept', payload: {} });
  await until(() => f.records().length === 2);
  assert.equal(f.records()[1].error.code, 'UNSUPPORTED_SCHEMA_VERSION');
  f.input.end();
  assert.equal((await f.completed).exitCode, 0);
});

test('session event cursor is separate and pre-Run input events need no fake run ID', async () => {
  let cursor = -1;
  const f = fixture({
    async dispatchSession(command) { return { schemaVersion: 2, commandId: command.commandId, ok: true, result: command.payload }; },
    async *subscribeSession(sessionId, afterSeq) {
      cursor = afterSeq;
      yield { schemaVersion: 2, stream: 'session-v2', eventId: 'event', sessionId, inputId: 'input', seq: afterSeq + 1,
        timestamp: new Date().toISOString(), type: 'input.accepted', payload: {} };
    },
  });
  f.send({ schemaVersion: 2, commandId: 'events', type: 'session.events', payload: { sessionId: 'session', afterSeq: 4 } });
  await until(() => f.records().length === 2);
  assert.equal(cursor, 4);
  assert.equal(f.records()[0].type, 'result');
  assert.equal(f.records()[1].event.seq, 5);
  assert.equal(f.records()[1].event.runId, undefined);
  assert.equal(f.records()[1].event.stream, 'session-v2');
  f.input.end();
  await f.completed;
});

test('pause has control capacity while a native acceptance dispatch is pending', async () => {
  let release!: (value: SessionCommandResult) => void;
  const f = fixture({ dispatchSession(command) {
    if (command.type === 'input.accept') return new Promise(resolve => { release = resolve; });
    return Promise.resolve({ schemaVersion: 2, commandId: command.commandId, ok: true, result: {} });
  } });
  f.send({ schemaVersion: 2, commandId: 'accept', type: 'input.accept', payload: {} });
  f.send({ schemaVersion: 2, commandId: 'pause', type: 'session.pause', payload: { sessionId: 'session' } });
  await until(() => f.records().length === 1);
  assert.equal(f.records()[0].commandId, 'pause');
  release({ schemaVersion: 2, commandId: 'accept', ok: true, result: {} });
  await until(() => f.records().length === 2);
  f.input.end();
  await f.completed;
});
