import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { DEFAULT_ENGINE_BUDGETS, DEFAULT_LIMITS, EngineError, type AcceptInput, type EngineBudgets } from '@moodcode/contracts';
import { sqliteFixtureDirectory } from './fixtures/sqlite-directory.js';

const now = '2026-10-07T00:00:00.000Z';
const config = { providerId: 'scripted', modelId: 'local', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function fixture(t: TestContext, budgets?: EngineBudgets) {
  const resources = sqliteFixtureDirectory(t, 'moodcode-native-inbox-'), directory = resources.directory, path = resources.dbPath;
  const open = () => resources.openStore(budgets);
  const store = open();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: now });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Native inbox', createdAt: now });
  const input = (requestId: string, delivery: AcceptInput['delivery'] = 'queue'): AcceptInput => ({ sessionId: 'session', requestId, prompt: requestId, config: structuredClone(config), delivery });
  return { store, path, open, input, observe: resources.openDatabase };
}

test('pending acceptance is durable without a Run, user message, v1 event or synthetic Run ID', t => {
  const f = fixture(t), receipt = f.store.acceptInput(f.input('first'));
  assert.deepEqual(Object.keys(receipt).sort(), ['admittedSeq', 'duplicate', 'inputId', 'state']);
  assert.equal(receipt.state, 'pending');
  assert.equal(receipt.admittedSeq, 1);
  assert.deepEqual(f.store.getSnapshot('session').runs, []);
  assert.deepEqual(f.store.getSnapshot('session').messages, []);
  assert.deepEqual(f.store.readEvents('session', 0), []);
  const event = f.store.readSessionEvents('session', 0)[0]!;
  assert.equal(event.schemaVersion, 2);
  assert.equal(event.stream, 'session-v2');
  assert.equal(event.inputId, receipt.inputId);
  assert.equal(event.runId, undefined);
  f.store.close();
  const reopened = f.open();
  assert.equal(reopened.getInput(receipt.inputId).state, 'pending');
  assert.deepEqual(reopened.recoverInterrupted(), []);
  assert.equal(reopened.getSessionControl('session').paused, false);
  assert.deepEqual(reopened.acceptInput(f.input('first')), { ...receipt, duplicate: true });
});

test('exact request identity precedes backlog checks and rejects prompt, mode, model and delivery changes', t => {
  const f = fixture(t, { ...DEFAULT_ENGINE_BUDGETS, maxPendingInputs: 1 });
  const receipt = f.store.acceptInput(f.input('identity'));
  assert.deepEqual(f.store.acceptInput(structuredClone(f.input('identity'))), { ...receipt, duplicate: true });
  assert.throws(() => f.store.acceptInput(f.input('second')), hasCode('INPUT_BACKLOG_LIMIT'));
  for (const changed of [
    { ...f.input('identity'), prompt: 'changed' }, { ...f.input('identity'), delivery: 'steer' as const },
    { ...f.input('identity'), config: { ...config, mode: 'plan' as const } }, { ...f.input('identity'), config: { ...config, modelId: 'other' } },
  ]) assert.throws(() => f.store.acceptInput(changed), hasCode('REQUEST_ID_CONFLICT'));
  f.store.createSession({ id: 'other', workspaceId: 'workspace', title: 'Independent inbox', createdAt: now });
  assert.equal(f.store.acceptInput({ ...f.input('identity'), sessionId: 'other' }).state, 'pending');
  assert.equal(f.store.listInputs('session').inputs.length, 1);
  assert.equal(f.store.readSessionEvents('session', 0).length, 1);
});

test('serialized UTF-8 pending byte budget includes JSON escaping and cancellation releases capacity', t => {
  const f = fixture(t, { ...DEFAULT_ENGINE_BUDGETS, maxPendingBytes: 1024 });
  const accepted = f.store.acceptInput({ ...f.input('small'), prompt: '한글'.repeat(40) });
  assert.throws(() => f.store.acceptInput({ ...f.input('large'), prompt: '\u0001'.repeat(300) }), hasCode('INPUT_BACKLOG_LIMIT'));
  const cancelled = f.store.cancelInput(accepted.inputId);
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(f.store.cancelInput(accepted.inputId), cancelled);
  assert.throws(() => f.store.promoteInput(accepted.inputId), hasCode('INPUT_CANCELLED'));
  assert.equal(f.store.acceptInput(f.input('new')).state, 'pending');
});

test('promotion atomically creates a real legacy Run and keeps both event sequences independent', t => {
  const f = fixture(t), receipt = f.store.acceptInput(f.input('first'));
  const promoted = f.store.promoteInput(receipt.inputId);
  assert.equal(promoted.input.id, receipt.inputId);
  assert.equal(promoted.input.state, 'promoted');
  assert.equal(promoted.input.admittedSeq, 1);
  assert.equal(promoted.input.promotedSeq, 2);
  assert.equal(promoted.receipt.admittedSeq, 1);
  assert.equal(promoted.run.inputId, receipt.inputId);
  assert.equal(f.store.getSnapshot('session').messages[0]?.content, 'first');
  assert.deepEqual(f.store.readEvents('session', 0).map(event => event.type), ['input.admitted']);
  assert.deepEqual(f.store.readSessionEvents('session', 0).map(event => event.type), ['input.accepted', 'input.promoted']);
  assert.deepEqual(f.store.promoteInput(receipt.inputId), { ...promoted, receipt: { ...promoted.receipt, duplicate: true } });
  assert.throws(() => f.store.cancelInput(receipt.inputId), hasCode('INPUT_ALREADY_PROMOTED'));
  assert.equal(f.store.listRunInputIds(promoted.run.id)[0], receipt.inputId);
});

test('promotion journal failure rolls back pending state, legacy admission, message and both cursors', t => {
  const f = fixture(t), receipt = f.store.acceptInput(f.input('first'));
  const observer = f.observe();
  observer.exec("CREATE TRIGGER fail_native_promotion BEFORE INSERT ON session_events WHEN NEW.type='input.promoted' BEGIN SELECT RAISE(ABORT,'native promotion failed'); END");
  assert.throws(() => f.store.promoteInput(receipt.inputId), /native promotion failed/);
  assert.equal(f.store.getInput(receipt.inputId).state, 'pending');
  assert.deepEqual(f.store.getSnapshot('session').runs, []);
  assert.deepEqual(f.store.getSnapshot('session').messages, []);
  assert.equal(f.store.getSnapshot('session').lastSeq, 0);
  assert.deepEqual(f.store.readSessionEvents('session', 0).map(event => event.seq), [1]);
  observer.exec('DROP TRIGGER fail_native_promotion');
  assert.equal(f.store.promoteInput(receipt.inputId).input.promotedSeq, 2);
});

test('queue acceptance during a live Run waits for the oldest input and cannot bind to the live Run', t => {
  const f = fixture(t), first = f.store.acceptInput(f.input('first')), second = f.store.acceptInput(f.input('second'));
  assert.throws(() => f.store.promoteInput(second.inputId), hasCode('INPUT_ORDER_CONFLICT'));
  const promotion = f.store.promoteInput(first.inputId);
  assert.throws(() => f.store.promoteInput(second.inputId, promotion.run.id), hasCode('INPUT_DELIVERY_CONFLICT'));
  assert.throws(() => f.store.promoteInput(second.inputId), hasCode('WORKSPACE_BUSY'));
  assert.equal(f.store.getInput(second.inputId).state, 'pending');
  f.store.commit(promotion.run.id, 'run.started', {}, { run: { state: 'running' } });
  f.store.commit(promotion.run.id, 'run.completed', {}, { run: { state: 'completed' } });
  assert.notEqual(f.store.promoteInput(second.inputId).run.id, promotion.run.id);
});

test('ordered steering batch binds each user input once to its real active Run', t => {
  const f = fixture(t), first = f.store.acceptInput(f.input('initial')), run = f.store.promoteInput(first.inputId).run;
  f.store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const queue = f.store.acceptInput(f.input('queued'));
  const a = f.store.acceptInput(f.input('steer-a', 'steer')), b = f.store.acceptInput(f.input('steer-b', 'steer'));
  assert.throws(() => f.store.promoteSteers([b.inputId, a.inputId], run.id), hasCode('INPUT_ORDER_CONFLICT'));
  const promoted = f.store.promoteSteers([a.inputId, b.inputId], run.id);
  assert.equal(promoted.every(input => input.runId === run.id), true);
  assert.equal(f.store.getInput(queue.inputId).state, 'pending');
  assert.deepEqual(f.store.getSnapshot('session').messages.map(message => message.content), ['initial', 'steer-a', 'steer-b']);
  const before = f.store.getSnapshot('session');
  assert.deepEqual(f.store.promoteSteers([a.inputId, b.inputId], run.id), promoted);
  assert.deepEqual(f.store.getSnapshot('session'), before);
  assert.deepEqual(f.store.listRunInputIds(run.id), [first.inputId, a.inputId, b.inputId]);
});

test('second steering publication failure rolls back the whole batch and rejects other session ownership', t => {
  const f = fixture(t), first = f.store.acceptInput(f.input('initial')), run = f.store.promoteInput(first.inputId).run;
  const a = f.store.acceptInput(f.input('steer-a', 'steer')), b = f.store.acceptInput(f.input('steer-b', 'steer'));
  const observer = f.observe();
  observer.exec(`CREATE TRIGGER fail_second_steer BEFORE INSERT ON session_events WHEN NEW.type='input.promoted' AND NEW.input_id='${b.inputId}' BEGIN SELECT RAISE(ABORT,'second steer failed'); END`);
  const before = f.store.getSnapshot('session'), events = f.store.readSessionEvents('session', 0);
  assert.throws(() => f.store.promoteSteers([a.inputId, b.inputId], run.id), /second steer failed/);
  assert.equal(f.store.getInput(a.inputId).state, 'pending');
  assert.equal(f.store.getInput(b.inputId).state, 'pending');
  assert.deepEqual(f.store.getSnapshot('session'), before);
  assert.deepEqual(f.store.readSessionEvents('session', 0), events);
  observer.exec('DROP TRIGGER fail_second_steer');
  f.store.createSession({ id: 'other', workspaceId: 'workspace', title: 'Other', createdAt: now });
  const foreign = f.store.acceptInput({ ...f.input('foreign', 'steer'), sessionId: 'other' });
  assert.throws(() => f.store.promoteSteers([foreign.inputId], run.id), hasCode('RECORD_SCOPE_MISMATCH'));
});

test('pause and user cancellation are durable without deleting the pending queue', t => {
  const f = fixture(t), receipt = f.store.acceptInput(f.input('pending'));
  const paused = f.store.setSessionPaused('session', true);
  assert.equal(paused.reason, 'user');
  assert.deepEqual(f.store.setSessionPaused('session', true), paused);
  assert.throws(() => f.store.promoteInput(receipt.inputId), hasCode('SESSION_PAUSED'));
  f.store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.getSessionControl('session'), paused);
  assert.equal(reopened.getInput(receipt.inputId).state, 'pending');
  reopened.setSessionPaused('session', false);
  const run = reopened.promoteInput(receipt.inputId).run;
  const next = reopened.acceptInput(f.input('remain-pending'));
  reopened.commit(run.id, 'run.cancelled', {}, { run: { state: 'cancelled' } });
  assert.equal(reopened.getSessionControl('session').reason, 'run_cancelled');
  assert.equal(reopened.getInput(next.inputId).state, 'pending');
  assert.throws(() => reopened.promoteInput(next.inputId), hasCode('SESSION_PAUSED'));
});

test('input pages use their own session cursor, return detached data and reject invalid limits', t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) f.store.acceptInput(f.input(`input-${i}`));
  const first = f.store.listInputs('session', undefined, 2), second = f.store.listInputs('session', first.nextCursor!, 2);
  assert.deepEqual(first.inputs.map(input => input.requestId), ['input-0', 'input-1']);
  assert.deepEqual(second.inputs.map(input => input.requestId), ['input-2', 'input-3']);
  assert.equal(f.store.listInputs('session', second.nextCursor!, 2).nextCursor, null);
  first.inputs[0]!.prompt = 'caller mutation';
  assert.equal(f.store.getInput(first.inputs[0]!.id).prompt, 'input-0');
  assert.throws(() => f.store.listInputs('session', { sessionId: 'other', afterSeq: 0 }), hasCode('INVALID_INPUT_CURSOR'));
  for (const limit of [0, 101, 1.5]) assert.throws(() => f.store.listInputs('session', undefined, limit), hasCode('INVALID_PAGE_SIZE'));
});

test('native subscription replays and wakes independently from the legacy cursor and aborts idle reads', async t => {
  const f = fixture(t), abort = new AbortController();
  const native = f.store.subscribeSessionEvents('session', 0, abort.signal)[Symbol.asyncIterator]();
  const legacy = f.store.subscribe('session', 0, abort.signal)[Symbol.asyncIterator]();
  const nativeNext = native.next(), legacyNext = legacy.next();
  const accepted = f.store.acceptInput(f.input('wake'));
  assert.equal((await nativeNext).value?.type, 'input.accepted');
  assert.equal(await Promise.race([legacyNext.then(() => true), delay(20, false)]), false);
  f.store.promoteInput(accepted.inputId);
  assert.equal((await legacyNext).value?.type, 'input.admitted');
  assert.equal((await native.next()).value?.type, 'input.promoted');
  const waiting = native.next(); abort.abort();
  assert.equal((await waiting).done, true);
  assert.equal((await legacy.next()).done, true);
});
