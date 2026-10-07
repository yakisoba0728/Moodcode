import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ProviderAttempt, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const stamp = () => new Date().toISOString();
const config = { providerId: 'authored', modelId: 'authored-model', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'moodcode-phase-two-observation-')), path = join(root, 'state.sqlite'), store = new SqliteStore(path);
  store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp() });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Phase two observation', createdAt: stamp() });
  const receipt = store.admit({ sessionId: 'session', requestId: 'request', prompt: 'Authored storage fixture', config }), run = store.getRun(receipt.runId);
  store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const turn: TurnRecord = { schemaVersion: 2, id: 'turn', sessionId: 'session', runId: run.id, inputIds: [run.inputId], index: 0, state: 'created', createdAt: stamp() };
  store.putTurn(turn);
  const attempt: ProviderAttempt = { schemaVersion: 2, id: 'attempt', sessionId: 'session', runId: run.id, turnId: turn.id, index: 0, providerId: config.providerId, modelId: config.modelId, state: 'prepared', createdAt: stamp() };
  store.putAttempt(attempt);
  const journals = () => ({ legacy: store.readEvents('session', 0, 1_024), native: store.readSessionEvents('session', 0, 100) });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { path, store, run, turn, attempt, journals };
}

test('phase two observations commit the same detached payload to both journals with exact Run/Turn/Attempt scope', t => {
  const f = fixture(t), payload = { invocationId: 'invocation', stage: 'after-model', status: 'completed', action: 'observe', outcomes: [{ hookId: 'hook', hookRevision: 1, status: 'observed', action: 'observe', elapsedMs: 0 }] };
  const event = f.store.commitRunObservation(f.run.id, 'lifecycle.outcome', payload, { turnId: f.turn.id, attemptId: f.attempt.id });
  payload.outcomes[0]!.action = 'caller mutation';
  const native = f.journals().native.at(-1)!;
  assert.equal(event.runId, f.run.id); assert.equal(native.runId, f.run.id); assert.equal(native.turnId, f.turn.id); assert.equal(native.attemptId, f.attempt.id);
  assert.equal(native.type, event.type); assert.deepEqual(native.payload, event.payload); assert.equal((native.payload.outcomes as { action: string }[])[0]!.action, 'observe');
  assert.equal(f.store.getRun(f.run.id).state, 'running');
});

test('legacy journal failure rolls back the native observation and both sequence counters', t => {
  const f = fixture(t), before = f.journals(), observer = new DatabaseSync(f.path);
  try {
    observer.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON events WHEN NEW.type='lifecycle.outcome' BEGIN SELECT RAISE(ABORT,'authored legacy observation failure'); END");
    assert.throws(() => f.store.commitRunObservation(f.run.id, 'lifecycle.outcome', { marker: 'not-committed' }, { turnId: f.turn.id, attemptId: f.attempt.id }), /authored legacy observation failure/);
    assert.deepEqual(f.journals(), before);
    observer.exec('DROP TRIGGER fail_observation');
    const event = f.store.commitRunObservation(f.run.id, 'lifecycle.outcome', { marker: 'committed' });
    assert.equal(event.seq, before.legacy.at(-1)!.seq + 1); assert.equal(f.journals().native.at(-1)!.seq, before.native.at(-1)!.seq + 1);
  } finally { observer.close(); }
});

test('native observation rejection publishes no legacy event or cursor advance', t => {
  const f = fixture(t), before = f.journals();
  assert.throws(() => f.store.commitRunObservation(f.run.id, 'lifecycle.outcome', { invalid: undefined } as never));
  assert.deepEqual(f.journals(), before);
  assert.throws(() => f.store.commitRunObservation(f.run.id, 'unsupported' as never, {}), hasCode('INVALID_RUN_OBSERVATION'));
  assert.deepEqual(f.journals(), before);
});

test('foreign or missing Turn/Attempt references cannot publish an observation in either journal', t => {
  const f = fixture(t), before = f.journals();
  for (const refs of [{ turnId: 'missing' }, { attemptId: f.attempt.id }, { turnId: f.turn.id, attemptId: 'missing' }]) {
    assert.throws(() => f.store.commitRunObservation(f.run.id, 'lifecycle.outcome', {}, refs), hasCode('RECORD_SCOPE_MISMATCH'));
    assert.deepEqual(f.journals(), before);
  }
  f.store.putWorkspace({ id: 'other-workspace', root: join(f.store.getWorkspace('workspace').root, 'other'), gitRoot: join(f.store.getWorkspace('workspace').root, 'other'), branch: null, createdAt: stamp() });
  f.store.createSession({ id: 'other-session', workspaceId: 'other-workspace', title: 'Other ownership', createdAt: stamp() });
  const other = f.store.admit({ sessionId: 'other-session', requestId: 'other-request', prompt: 'Other owner', config });
  f.store.putTurn({ ...f.turn, id: 'foreign-turn', sessionId: 'other-session', runId: other.runId, inputIds: [other.inputId] });
  assert.throws(() => f.store.commitRunObservation(f.run.id, 'lifecycle.outcome', {}, { turnId: 'foreign-turn' }), hasCode('RECORD_SCOPE_MISMATCH'));
  assert.deepEqual(f.journals(), before);
});

for (const terminal of ['completed', 'failed', 'cancelled'] as const) test(`late phase two observations cannot append after ${terminal}`, t => {
  const f = fixture(t);
  if (terminal === 'cancelled') f.store.commit(f.run.id, 'run.cancelling', {}, { run: { state: 'cancelling' } });
  f.store.commit(f.run.id, `run.${terminal}`, {}, { run: { state: terminal } });
  const before = f.journals();
  assert.throws(() => f.store.commitRunObservation(f.run.id, 'lifecycle.outcome', { late: true }, { turnId: f.turn.id, attemptId: f.attempt.id }), hasCode('RUN_TERMINAL'));
  assert.deepEqual(f.journals(), before);
});

test('active Run document publication is detached CAS and blocks cancelling/terminal owners', t => {
  const f = fixture(t), original = { ownerRunId: f.run.id, state: 'draft' }, first = f.store.putActiveRunDocument(f.run.id, 'verification.fixture', 0, original);
  original.state = 'caller mutation'; assert.equal(f.store.getSessionDocument('session', 'verification.fixture')!.data.state, 'draft');
  const before = f.journals();
  assert.throws(() => f.store.putActiveRunDocument(f.run.id, 'verification.fixture', 0, { state: 'conflict' }), hasCode('REVISION_CONFLICT'));
  assert.deepEqual(f.journals(), before);
  f.store.commit(f.run.id, 'run.cancelling', {}, { run: { state: 'cancelling' } });
  const cancelled = f.journals();
  assert.throws(() => f.store.putActiveRunDocument(f.run.id, 'verification.fixture', first.revision, { state: 'too-late' }), hasCode('RUN_TERMINAL'));
  assert.deepEqual(f.journals(), cancelled); assert.deepEqual(f.store.getSessionDocument('session', 'verification.fixture'), first);
  f.store.commit(f.run.id, 'run.cancelled', {}, { run: { state: 'cancelled' } });
  assert.throws(() => f.store.putActiveRunDocument(f.run.id, 'verification.fixture', first.revision, { state: 'too-late' }), hasCode('RUN_TERMINAL'));
});

test('active Run document journal failure rolls back the CAS publication', t => {
  const f = fixture(t), original = f.store.putActiveRunDocument(f.run.id, 'verification.fixture', 0, { state: 'draft' }), before = f.journals(), observer = new DatabaseSync(f.path);
  try {
    observer.exec("CREATE TRIGGER fail_active_document BEFORE INSERT ON session_events WHEN NEW.type='session.document.updated' BEGIN SELECT RAISE(ABORT,'authored document observation failure'); END");
    assert.throws(() => f.store.putActiveRunDocument(f.run.id, 'verification.fixture', original.revision, { state: 'published' }), /authored document observation failure/);
    assert.deepEqual(f.store.getSessionDocument('session', 'verification.fixture'), original); assert.deepEqual(f.journals(), before);
  } finally { observer.close(); }
});
