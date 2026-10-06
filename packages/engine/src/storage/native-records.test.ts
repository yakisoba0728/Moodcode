import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ContextRevision, type MessagePart, type ProviderAttempt, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const config = { providerId: 'scripted', modelId: 'local', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
const stamp = () => new Date().toISOString();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-native-records-')), path = join(directory, 'engine.sqlite');
  const stores: SqliteStore[] = [];
  const open = () => { const store = new SqliteStore(path); stores.push(store); return store; };
  const store = open();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp() });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Records', createdAt: stamp() });
  const accepted = store.acceptInput({ sessionId: 'session', requestId: 'first', prompt: 'first', config, delivery: 'queue' });
  const run = store.promoteInput(accepted.inputId).run;
  store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const turn: TurnRecord = { schemaVersion: 2, id: 'turn', sessionId: 'session', runId: run.id, inputIds: [accepted.inputId], index: 0, state: 'created', createdAt: stamp() };
  store.putTurn(turn);
  const attempt: ProviderAttempt = { schemaVersion: 2, id: 'attempt', sessionId: 'session', runId: run.id, turnId: turn.id, index: 0, providerId: 'scripted', modelId: 'local', state: 'prepared', createdAt: stamp() };
  const part: MessagePart = { schemaVersion: 2, id: 'part', sessionId: 'session', runId: run.id, turnId: turn.id, messageId: 'typed-message', index: 0, revision: 0, type: 'text', text: '', state: 'open', createdAt: stamp() };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, open, run, accepted, turn, attempt, part };
}

test('Turn, attempt and streaming Parts persist ordered identities and terminal immutable results', t => {
  const f = fixture(t);
  f.store.putAttempt(f.attempt);
  const dispatched = f.store.putAttempt({ ...f.attempt, state: 'dispatched', dispatchedAt: stamp() });
  const streaming = f.store.putAttempt({ ...dispatched, state: 'streaming' });
  f.store.putTurn({ ...f.turn, state: 'streaming' });
  f.store.putPart(f.part);
  const text = f.store.putPart({ ...f.part, revision: 1, text: '한국어 결과' });
  const reasoning: MessagePart = { ...f.part, id: 'reasoning', index: 1, type: 'reasoning', text: 'visible reasoning', providerData: { signature: 'fixture-signature' } };
  f.store.putPart(reasoning);
  f.store.putPart({ ...reasoning, revision: 1, state: 'completed', completedAt: stamp() });
  f.store.putPart({ ...text, revision: 2, state: 'completed', completedAt: stamp() });
  const completedAttempt = f.store.putAttempt({ ...streaming, state: 'completed', completedAt: stamp(), providerRequestId: 'fixture-request' });
  const completedTurn = f.store.putTurn({ ...f.turn, state: 'completed', completedAt: stamp(), finishReason: 'stop' });
  const events = f.store.readSessionEvents('session', 0), parts = f.store.listParts(f.turn.id);
  assert.equal(parts[0]?.type, 'text');
  assert.equal(parts[0]?.state, 'completed');
  assert.equal(parts[1]?.type, 'reasoning');
  assert.equal(f.store.listTurns(f.run.id)[0]?.id, f.turn.id);
  assert.deepEqual(f.store.putAttempt(completedAttempt), completedAttempt);
  assert.deepEqual(f.store.putTurn(completedTurn), completedTurn);
  assert.deepEqual(f.store.readSessionEvents('session', 0), events, 'Idempotent writes must not publish duplicate events');
  assert.throws(() => f.store.putTurn({ ...completedTurn, finishReason: 'changed' }), hasCode('TURN_TERMINAL'));
  f.store.close();
  const successor = f.open();
  assert.deepEqual(successor.getTurn(f.turn.id), completedTurn);
  assert.deepEqual(successor.getAttempt(f.attempt.id), completedAttempt);
  assert.deepEqual(successor.listParts(f.turn.id), parts);
  assert.deepEqual(successor.recoverInterrupted().map(run => run.state), ['interrupted']);
  assert.deepEqual(successor.getTurn(f.turn.id), completedTurn, 'Recovery cannot rewrite a settled Turn');
});

test('Turn completion requires both provider settlement and closed Parts', t => {
  const f = fixture(t);
  f.store.putTurn({ ...f.turn, state: 'streaming' });
  f.store.putAttempt(f.attempt);
  const dispatched = f.store.putAttempt({ ...f.attempt, state: 'dispatched', dispatchedAt: stamp() });
  f.store.putPart(f.part);
  assert.throws(() => f.store.putTurn({ ...f.turn, state: 'completed', completedAt: stamp() }), hasCode('TURN_NOT_SETTLED'));
  f.store.putAttempt({ ...dispatched, state: 'completed', completedAt: stamp() });
  assert.throws(() => f.store.putTurn({ ...f.turn, state: 'completed', completedAt: stamp() }), hasCode('TURN_NOT_SETTLED'));
  f.store.putPart({ ...f.part, revision: 1, state: 'completed', completedAt: stamp() });
  assert.equal(f.store.putTurn({ ...f.turn, state: 'completed', completedAt: stamp() }).state, 'completed');
});

test('Part revision and durable text prefix conflicts do not publish or modify the record', t => {
  const f = fixture(t);
  f.store.putPart({ ...f.part, text: 'durable prefix' });
  const events = f.store.readSessionEvents('session', 0);
  assert.throws(() => f.store.putPart({ ...f.part, text: 'durable prefix plus', revision: 2 }), hasCode('REVISION_CONFLICT'));
  assert.throws(() => f.store.putPart({ ...f.part, text: 'rewritten', revision: 1 }), hasCode('RECORD_CONFLICT'));
  assert.deepEqual(f.store.readSessionEvents('session', 0), events);
  const terminal = f.store.putPart({ ...f.part, text: 'durable prefix', revision: 1, state: 'interrupted', completedAt: stamp() });
  assert.ok(terminal.type === 'text');
  assert.deepEqual(f.store.putPart(terminal), terminal);
  assert.throws(() => f.store.putPart({ ...terminal, revision: 2, text: 'durable prefix later' }), hasCode('PART_TERMINAL'));
  assert.equal(f.store.listParts(f.turn.id)[0]?.revision, 1);
});

test('Turn and Part page cursors stay bound to their owner and preserve independent message order', t => {
  const f = fixture(t);
  f.store.putPart(f.part);
  f.store.putPart({ ...f.part, id: 'part-two', index: 1 });
  f.store.putPart({ ...f.part, id: 'part-other-message', messageId: 'another-message', index: 0 });
  const first = f.store.listPartsPage(f.turn.id, undefined, 2);
  assert.deepEqual(first.parts.map(part => part.id), ['part', 'part-two']);
  assert.equal(first.nextCursor, 'part-two');
  assert.deepEqual(f.store.listPartsPage(f.turn.id, first.nextCursor!).parts.map(part => part.id), ['part-other-message']);
  assert.throws(() => f.store.listPartsPage(f.turn.id, 'missing'), hasCode('INVALID_PART_CURSOR'));
  assert.throws(() => f.store.listPartsPage(f.turn.id, undefined, 101), hasCode('INVALID_PAGE_SIZE'));
  f.store.putTurn({ ...f.turn, state: 'failed', completedAt: stamp() });
  const second = { ...f.turn, id: 'turn-two', index: 1, createdAt: stamp() };
  f.store.putTurn(second);
  assert.throws(() => f.store.listPartsPage(second.id, 'part'), hasCode('INVALID_PART_CURSOR'));
  const turns = f.store.listTurnsPage(f.run.id, undefined, 1);
  assert.deepEqual(turns.turns.map(turn => turn.id), [f.turn.id]);
  assert.equal(turns.nextCursor, f.turn.id);
  assert.deepEqual(f.store.listTurnsPage(f.run.id, turns.nextCursor!).turns.map(turn => turn.id), ['turn-two']);
  assert.equal(f.store.listTurnsPage(f.run.id, 'turn-two').nextCursor, null);
  assert.throws(() => f.store.listTurnsPage(f.run.id, 'missing'), hasCode('INVALID_TURN_CURSOR'));
  assert.equal(f.store.hasActiveRuns('workspace'), true);
  assert.equal(f.store.hasActiveRuns('workspace', f.run.id), false);
});

test('provider dispatch journal failure leaves the prepared attempt and cursor unchanged', t => {
  const f = fixture(t);
  f.store.putAttempt(f.attempt);
  const events = f.store.readSessionEvents('session', 0), observer = new DatabaseSync(f.path);
  t.after(() => observer.close());
  observer.exec("CREATE TRIGGER fail_dispatch BEFORE INSERT ON session_events WHEN NEW.type='provider.attempt.dispatched' BEGIN SELECT RAISE(ABORT,'dispatch journal failed'); END");
  assert.throws(() => f.store.putAttempt({ ...f.attempt, state: 'dispatched', dispatchedAt: stamp() }), /dispatch journal failed/);
  assert.deepEqual(f.store.getAttempt(f.attempt.id), f.attempt);
  assert.deepEqual(f.store.readSessionEvents('session', 0), events);
});

test('cross-session ownership and identity changes are rejected before execution projection', t => {
  const f = fixture(t);
  assert.throws(() => f.store.putTurn({ ...f.turn, id: 'foreign-turn', sessionId: 'other' }), hasCode('RECORD_SCOPE_MISMATCH'));
  assert.throws(() => f.store.putAttempt({ ...f.attempt, sessionId: 'other' }), hasCode('RECORD_SCOPE_MISMATCH'));
  assert.throws(() => f.store.putPart({ ...f.part, sessionId: 'other' }), hasCode('RECORD_SCOPE_MISMATCH'));
  f.store.putAttempt(f.attempt);
  assert.throws(() => f.store.putAttempt({ ...f.attempt, modelId: 'other' }), hasCode('RECORD_CONFLICT'));
  assert.throws(() => f.store.putTurn({ ...f.turn, inputIds: ['missing-input'] }), hasCode('RECORD_CONFLICT'));
});

test('prepared-only crash is interrupted, pending work remains durable and recovery is idempotent', t => {
  const f = fixture(t);
  f.store.putAttempt(f.attempt); f.store.putPart({ ...f.part, text: 'persisted before dispatch' });
  const queued = f.store.acceptInput({ sessionId: 'session', requestId: 'queued', prompt: 'keep queued', config, delivery: 'queue' });
  f.store.close();
  const successor = f.open();
  successor.recoverInterrupted();
  assert.equal(successor.getAttempt(f.attempt.id).state, 'interrupted');
  assert.equal(successor.getAttempt(f.attempt.id).uncertainty, undefined);
  assert.equal(successor.getTurn(f.turn.id).state, 'interrupted');
  assert.equal(successor.listParts(f.turn.id)[0]?.state, 'interrupted');
  assert.equal(successor.getInput(queued.inputId).state, 'pending');
  assert.equal(successor.getSessionControl('session').reason, 'recovery_required');
  const events = successor.readSessionEvents('session', 0);
  assert.deepEqual(successor.recoverInterrupted(), []);
  assert.deepEqual(successor.readSessionEvents('session', 0), events);
  assert.throws(() => successor.promoteInput(queued.inputId), hasCode('SESSION_PAUSED'));
});

test('dispatched crash preserves uncertainty and does not replay the provider attempt or partial output', t => {
  const f = fixture(t);
  f.store.putAttempt(f.attempt);
  f.store.putAttempt({ ...f.attempt, state: 'dispatched', dispatchedAt: stamp() });
  f.store.putTurn({ ...f.turn, state: 'streaming' });
  f.store.putPart({ ...f.part, text: 'partial provider output' });
  f.store.close();
  const successor = f.open(); successor.recoverInterrupted();
  assert.equal(successor.getAttempt(f.attempt.id).state, 'uncertain');
  assert.equal(successor.getAttempt(f.attempt.id).uncertainty?.kind, 'provider_dispatch');
  assert.equal(successor.getTurn(f.turn.id).state, 'uncertain');
  assert.equal(successor.getSessionControl('session').paused, true);
  assert.equal(successor.listParts(f.turn.id)[0]?.type === 'text' && (successor.listParts(f.turn.id)[0] as { text: string }).text, 'partial provider output');
  const events = successor.readSessionEvents('session', 0);
  successor.setSessionPaused('session', false);
  assert.throws(() => successor.putAttempt({ ...f.attempt, id: 'retry', index: 1 }), hasCode('RUN_TERMINAL'));
  assert.equal(events.filter(event => event.type === 'provider.attempt.dispatched').length, 1);
});

test('context revisions verify hashes, ownership, monotonic revision and immutable content', t => {
  const f = fixture(t);
  const context: ContextRevision = { schemaVersion: 2, id: 'context', sessionId: 'session', revision: 1, kind: 'baseline', sourceIds: ['workspace:agents'], text: 'Own instructions', sha256: hash('Own instructions'), createdAt: stamp() };
  assert.throws(() => f.store.putContextRevision({ ...context, sha256: '0'.repeat(64) }), hasCode('CONTEXT_HASH_MISMATCH'));
  f.store.putContextRevision(context);
  f.store.putTurn({ ...f.turn, contextRevisionId: context.id });
  assert.deepEqual(f.store.putContextRevision(context), context);
  assert.throws(() => f.store.putContextRevision({ ...context, text: 'changed', sha256: hash('changed') }), hasCode('RECORD_CONFLICT'));
  assert.throws(() => f.store.putContextRevision({ ...context, id: 'wrong-revision', revision: 3 }), hasCode('REVISION_CONFLICT'));
  const update = f.store.putContextRevision({ ...context, id: 'updated', revision: 2, kind: 'update', supersedesId: context.id, text: 'New instructions', sha256: hash('New instructions') });
  assert.equal(update.supersedesId, context.id);
  assert.throws(() => f.store.putTurn({ ...f.turn, contextRevisionId: update.id }), hasCode('RECORD_CONFLICT'));
});
