import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ContextRevision, type MessagePart, type ProviderAttempt, type TurnRecord } from '@moodcode/contracts';
import { sqliteFixtureDirectory } from './fixtures/sqlite-directory.js';
import { findEventPayloads, readAnchoredDocument } from './native-records.js';

const config = { providerId: 'scripted', modelId: 'local', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
const stamp = () => new Date().toISOString();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: TestContext) {
  const resources = sqliteFixtureDirectory(t, 'moodcode-native-records-'), directory = resources.directory, path = resources.dbPath;
  const open = () => resources.openStore();
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
  return { store, path, open, run, accepted, turn, attempt, part, observe: resources.openDatabase };
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
  const events = f.store.readSessionEvents('session', 0), observer = f.observe();
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

test('native execution row bytes and event copies preserve normalized records and rejected writes', t => {
  const f = fixture(t), database = f.observe();
  const recorded: { table: string; type: string; field: string; value: TurnRecord | ProviderAttempt | MessagePart | ContextRevision }[] = [];
  const context = f.store.putContextRevision({ schemaVersion: 2, id: 'encoded-context', sessionId: 'session', revision: 1,
    kind: 'baseline', sourceIds: ['fixture:private'], text: 'Dummy context: 한국어 🚀', sha256: hash('Dummy context: 한국어 🚀'), createdAt: stamp() });
  recorded.push({ table: 'context_revisions', type: 'context.revision.recorded', field: 'context', value: context });
  const turn = f.store.putTurn({ ...f.turn, state: 'streaming', contextRevisionId: context.id });
  recorded.push({ table: 'session_turns', type: 'turn.streaming', field: 'turn', value: turn });
  const prepared = f.store.putAttempt({ ...f.attempt, contextRevisionId: context.id });
  const attempt = f.store.putAttempt({ ...prepared, state: 'dispatched', dispatchedAt: stamp() });
  recorded.push({ table: 'provider_attempts', type: 'provider.attempt.dispatched', field: 'attempt', value: attempt });
  const initial = f.store.putPart({ ...f.part, type: 'reasoning', text: 'Dummy prefix',
    providerData: { '2': 'numeric key', nested: { unicode: '한국어 🚀', escaped: '\\"\n', negativeZero: -0 }, dense: [null, true, 7] } });
  assert.equal(initial.type, 'reasoning');
  if (initial.type !== 'reasoning') assert.fail('Expected reasoning part');
  const part = f.store.putPart({ ...initial, revision: 1, text: 'Dummy prefix + continuation' });
  if (part.type !== 'reasoning') assert.fail('Expected reasoning part');
  recorded.push({ table: 'message_parts', type: 'message.part.updated', field: 'part', value: part });
  for (const record of recorded) {
    const raw = String(database.prepare(`SELECT data FROM ${record.table} WHERE id=?`).get(record.value.id)!.data);
    assert.equal(raw, JSON.stringify(record.value), 'SQL stores exactly the normalized returned record');
    const event = JSON.parse(String(database.prepare('SELECT data FROM session_events WHERE type=? ORDER BY seq DESC LIMIT 1').get(record.type)!.data));
    assert.equal(JSON.stringify(event.payload[record.field]), raw, 'Journal record copies preserve the exact SQL JSON bytes');
  }
  const before = database.prepare('SELECT data FROM session_events ORDER BY seq').all();
  assert.deepEqual(f.store.putTurn(turn), turn);
  assert.deepEqual(f.store.putAttempt(attempt), attempt);
  assert.equal(JSON.stringify(f.store.putPart(part)), JSON.stringify(part), 'Idempotent replay keeps JSON normalization, including negative zero');
  assert.deepEqual(f.store.putContextRevision(context), context);
  assert.throws(() => f.store.putPart({ ...part, revision: 2, text: 'rewritten prefix' }), hasCode('RECORD_CONFLICT'));
  assert.deepEqual(database.prepare('SELECT data FROM session_events ORDER BY seq').all(), before, 'Idempotency and rejection do not change journal bytes');
  if (part.type === 'reasoning') part.text = 'Caller mutation after commit';
  assert.notEqual(f.store.listParts(f.turn.id)[0]?.type === 'reasoning' && (f.store.listParts(f.turn.id)[0] as { text: string }).text, 'Caller mutation after commit');
});

test('anchored native readers bind document bytes to their one update event and events to their SQL rows', t => {
  const f = fixture(t), db = f.observe(), raise = (name: string) => (): never => { throw new Error(name); };
  const errors = { limit: raise('limit'), invalid: raise('invalid'), anchor: raise('anchor') };
  f.store.putSessionDocument('session', 'fixture.doc', 0, { value: 'first' });
  const second = f.store.putSessionDocument('session', 'fixture.doc', 1, { value: 'second 한국어' }), raw = JSON.stringify(second.data);
  const read = (query: { revision?: number; maxBytes?: number; kind?: string } = {}) => readAnchoredDocument(db, { sessionId: 'session', kind: 'fixture.doc', maxBytes: 1024, ...query }, errors);
  const events = (search: Partial<Parameters<typeof findEventPayloads>[1]> = {}) => findEventPayloads(db, { sessionId: 'session', type: 'session.document.updated', payload: { kind: 'fixture.doc' }, maxRows: 2, maxRowBytes: 8192, ...search }, errors);
  assert.deepEqual(read(), { revision: 2, raw, data: second.data }); assert.deepEqual(read({ revision: 2 }), read());
  assert.equal(read({ revision: 1 }), undefined); assert.equal(read({ kind: 'missing' }), undefined);
  assert.throws(() => read({ maxBytes: Buffer.byteLength(raw) - 1 }), /limit/u);
  assert.deepEqual(events().map(payload => payload.revision), [1, 2]);
  assert.deepEqual(events({ contains: hash(raw) }), [{ kind: 'fixture.doc', revision: 2, sha256: hash(raw) }]);
  assert.equal(findEventPayloads(db, { sessionId: 'session', type: 'input.accepted', refs: { inputId: f.accepted.inputId }, maxRows: 1, maxRowBytes: 65536 }, errors).length, 1);
  assert.equal(findEventPayloads(db, { sessionId: 'session', type: 'input.accepted', refs: { inputId: 'other' }, maxRows: 1, maxRowBytes: 65536 }, errors).length, 0);
  for (const search of [{ maxRows: 1 }, { maxRowBytes: 64 }, { maxTotalBytes: 64 }]) assert.throws(() => events(search), /limit/u);
  assert.throws(() => events({ payload: { "kind') OR 1=1 --": 'x' } }), TypeError);
  db.prepare("UPDATE session_documents SET data=? WHERE session_id='session' AND kind='fixture.doc'").run(raw.replace('second', 'SECOND'));
  assert.throws(() => read(), /anchor/u);
  db.prepare("UPDATE session_documents SET data=? WHERE session_id='session' AND kind='fixture.doc'").run(raw); assert.equal(read()!.raw, raw);
  const anchor = Number(db.prepare("SELECT seq FROM session_events WHERE type='session.document.updated' ORDER BY seq DESC LIMIT 1").get()!.seq);
  db.prepare('UPDATE session_events SET run_id=? WHERE session_id=? AND seq=?').run(f.run.id, 'session', anchor);
  assert.throws(() => events(), /invalid/u); assert.throws(() => read(), /anchor/u);
  db.prepare('UPDATE session_events SET run_id=NULL WHERE session_id=? AND seq=?').run('session', anchor); assert.equal(read()!.revision, 2);
  db.prepare("INSERT INTO session_events(session_id,seq,event_id,schema_version,type,data) SELECT session_id,seq+1000,event_id||'-copy',schema_version,type,json_set(data,'$.seq',seq+1000,'$.eventId',event_id||'-copy') FROM session_events WHERE session_id=? AND seq=?").run('session', anchor);
  assert.throws(() => read(), /anchor/u);
});

test('anchored native readers send event rows SQLite cannot parse to their thunks', t => {
  const f = fixture(t), db = f.observe(), raise = (name: string) => (): never => { throw new Error(name); };
  const errors = { limit: raise('limit'), invalid: raise('invalid'), anchor: raise('anchor') };
  const document = f.store.putSessionDocument('session', 'fixture.doc', 0, { value: 'first' }), sha256 = hash(JSON.stringify(document.data)), broken = `{"broken ${sha256}`;
  const read = () => readAnchoredDocument(db, { sessionId: 'session', kind: 'fixture.doc', maxBytes: 1024 }, errors);
  const events = (maxRows: number) => findEventPayloads(db, { sessionId: 'session', type: 'session.document.updated', payload: { kind: 'fixture.doc' }, maxRows, maxRowBytes: 8192 }, errors);
  const anchor = Number(db.prepare("SELECT seq FROM session_events WHERE type='session.document.updated'").get()!.seq), valid = String(db.prepare('SELECT data FROM session_events WHERE session_id=? AND seq=?').get('session', anchor)!.data);
  db.prepare('UPDATE session_events SET data=? WHERE session_id=? AND seq=?').run(broken, 'session', anchor);
  assert.throws(() => read(), /^Error: anchor$/u); assert.throws(() => events(2), /^Error: invalid$/u);
  db.prepare('UPDATE session_events SET data=? WHERE session_id=? AND seq=?').run(valid, 'session', anchor); assert.equal(read()!.revision, 1);
  db.prepare("INSERT INTO session_events(session_id,seq,event_id,schema_version,type,data) VALUES(?,?,?,2,'session.document.updated',?)").run('session', anchor + 1000, 'broken-anchor', broken);
  assert.throws(() => read(), /^Error: anchor$/u); assert.throws(() => events(1), /^Error: limit$/u); assert.throws(() => events(2), /^Error: invalid$/u);
});
