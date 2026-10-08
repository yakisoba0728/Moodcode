import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ContextRevision, type JsonObject, type Message, type ToolCallRecord } from '@moodcode/contracts';
import type { SqliteStore } from './index.js';
import { sqliteFixtureDirectory } from './fixtures/sqlite-directory.js';

const config = { providerId: 'scripted', modelId: 'local', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const stamp = () => new Date().toISOString();
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function fixture(t: TestContext) {
  const resources = sqliteFixtureDirectory(t, 'moodcode-native-documents-'), directory = resources.directory, path = resources.dbPath;
  const open = () => resources.openStore();
  const store = open();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp() });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Documents', createdAt: stamp() });
  return { store, path, open, observe: resources.openDatabase };
}

test('session document CAS preserves detached JSON and revision conflicts across reopen', t => {
  const f = fixture(t);
  assert.equal(f.store.getSessionDocument('session', 'questions'), null);
  const data: JsonObject = { pending: [{ id: 'question', answer: null }], formatVersion: 1 };
  const first = f.store.putSessionDocument('session', 'questions', 0, data);
  (data.pending as JsonObject[])[0]!.answer = 'caller mutation';
  assert.equal((f.store.getSessionDocument('session', 'questions')?.data.pending as JsonObject[])[0]?.answer, null);
  const events = f.store.readSessionEvents('session', 0);
  assert.throws(() => f.store.putSessionDocument('session', 'questions', 0, { pending: [] }), hasCode('REVISION_CONFLICT'));
  assert.deepEqual(f.store.readSessionEvents('session', 0), events);
  const second = f.store.putSessionDocument('session', 'questions', first.revision, { pending: [], answered: ['question'] });
  assert.equal(second.revision, 2);
  f.store.close();
  assert.deepEqual(f.open().getSessionDocument('session', 'questions'), second);
});

test('document namespaces, byte bounds and non-data properties fail without side effects', t => {
  const f = fixture(t);
  for (const kind of ['', '../questions', 'x'.repeat(65)]) assert.throws(() => f.store.putSessionDocument('session', kind, 0, {}), hasCode('INVALID_DOCUMENT_KIND'));
  assert.throws(() => f.store.putSessionDocument('session', 'large', 0, { text: '한'.repeat(100_000) }), hasCode('SESSION_DOCUMENT_LIMIT'));
  let calls = 0;
  const getter = Object.defineProperty({}, 'private', { enumerable: true, get() { calls++; return 'side effect'; } }) as JsonObject;
  assert.throws(() => f.store.putSessionDocument('session', 'unsafe', 0, getter));
  assert.equal(calls, 0);
  assert.deepEqual(f.store.readSessionEvents('session', 0), []);
  assert.equal(f.store.getSessionDocument('session', 'large'), null);
});

test('session document journal failure rolls back a successful CAS update', t => {
  const f = fixture(t), first = f.store.putSessionDocument('session', 'todos', 0, { items: ['first'] });
  const observer = f.observe();
  observer.exec("CREATE TRIGGER fail_document BEFORE INSERT ON session_events WHEN NEW.type='session.document.updated' BEGIN SELECT RAISE(ABORT,'document event failed'); END");
  const events = f.store.readSessionEvents('session', 0);
  assert.throws(() => f.store.putSessionDocument('session', 'todos', first.revision, { items: ['second'] }), /document event failed/);
  assert.deepEqual(f.store.getSessionDocument('session', 'todos'), first);
  assert.deepEqual(f.store.readSessionEvents('session', 0), events);
});

test('context revision activation, document CAS and both journal streams commit or roll back together', t => {
  const f = fixture(t), receipt = f.store.admit({ sessionId: 'session', requestId: 'summary', prompt: 'summarize', config });
  f.store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  const text = 'summary fixture';
  const revision: ContextRevision = { schemaVersion: 2, id: 'summary', sessionId: 'session', runId: receipt.runId, revision: f.store.nextContextRevisionIndex('session'), kind: 'summary', sourceIds: [receipt.inputId], text, sha256: createHash('sha256').update(text).digest('hex'), createdAt: stamp() };
  const native = f.store.readSessionEvents('session', 0), legacy = f.store.readEvents('session', 0);
  const observer = f.observe();
  observer.exec("CREATE TRIGGER fail_summary BEFORE INSERT ON events WHEN NEW.type='summary.completed' BEGIN SELECT RAISE(ABORT,'summary settlement failed'); END");
  const change = { revision, kind: 'context.memory', expectedRevision: 0, data: { activeSummaryId: revision.id } };
  assert.throws(() => f.store.commitContextDocument(receipt.runId, 'summary.completed', { summaryId: revision.id }, change), /summary settlement failed/);
  assert.equal(f.store.getSessionDocument('session', 'context.memory'), null);
  assert.equal(f.store.nextContextRevisionIndex('session'), 1);
  assert.throws(() => f.store.getContextRevision(revision.id), hasCode('CONTEXT_REVISION_NOT_FOUND'));
  assert.deepEqual(f.store.readSessionEvents('session', 0), native);
  assert.deepEqual(f.store.readEvents('session', 0), legacy);
  observer.exec('DROP TRIGGER fail_summary');
  const event = f.store.commitContextDocument(receipt.runId, 'summary.completed', { summaryId: revision.id }, change);
  assert.equal(event.type, 'summary.completed');
  assert.equal(f.store.getSessionDocument('session', 'context.memory')?.data.activeSummaryId, revision.id);
  assert.deepEqual(f.store.getContextRevision(revision.id), revision);
  assert.equal(f.store.nextContextRevisionIndex('session'), 2);
  assert.equal(f.store.readSessionEvents('session', native.at(-1)!.seq).at(-1)?.type, 'summary.completed');
});

function populate(store: SqliteStore, count: number): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const receipt = store.admit({ sessionId: 'session', requestId: `request-${index}`, prompt: `goal-${index}`, config });
    ids.push(receipt.runId);
    store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
    const tool: ToolCallRecord = { id: `tool-${index}`, sessionId: 'session', runId: receipt.runId, name: 'read_file', input: { path: 'a.txt' }, state: 'requested' };
    const assistant: Message = { id: `assistant-${index}`, sessionId: 'session', runId: receipt.runId, role: 'assistant', content: '', createdAt: stamp(), toolCalls: [{ id: tool.id, name: tool.name, input: tool.input }], providerReplay: { providerId: 'scripted', items: [{ type: 'reasoning', encrypted_content: `opaque-${index}` }] } };
    store.commit(receipt.runId, 'tool.requested', {}, { tool, message: assistant });
    store.commit(receipt.runId, 'tool.started', {}, { tool: { ...tool, state: 'running' } });
    store.commit(receipt.runId, 'tool.completed', {}, { tool: { ...tool, state: 'completed', output: `result-${index}` }, message: { id: `result-${index}`, sessionId: 'session', runId: receipt.runId, role: 'tool', content: `result-${index}`, toolCallId: tool.id, createdAt: stamp() } });
    store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
  }
  return ids;
}

test('model history queries bounded recent complete Run exchanges without loading the full snapshot', t => {
  const f = fixture(t), ids = populate(f.store, 10);
  const original = f.store.getSnapshot('session');
  f.store.getSnapshot = () => { throw new Error('Unbounded snapshot must not be queried'); };
  const page = f.store.readModelHistory('session', 6, 20_000);
  assert.deepEqual(page.snapshot.runs.map(run => run.id), ids.slice(-2));
  assert.equal(page.snapshot.messages.length, 6);
  assert.equal(page.omittedRuns, 8);
  assert.equal(page.omittedMessages, 24);
  assert.equal(page.beforeRunId, ids[8]);
  assert.equal(page.snapshot.lastSeq, original.lastSeq);
  for (const message of page.snapshot.messages.filter(message => message.role === 'assistant')) {
    assert.ok(message.providerReplay, 'Model projection keeps the original continuation metadata');
    assert.equal(page.snapshot.messages.some(result => result.role === 'tool' && result.toolCallId === message.toolCalls?.[0]?.id), true);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(page.snapshot)) <= 20_000);
});

test('model history refuses to trim the newest required exchange or accept unsafe read limits', t => {
  const f = fixture(t); populate(f.store, 2);
  assert.throws(() => f.store.readModelHistory('session', 2, 20_000), hasCode('MODEL_HISTORY_LIMIT'));
  assert.throws(() => f.store.readModelHistory('session', 200, 1024), hasCode('MODEL_HISTORY_LIMIT'));
  for (const [messages, bytes] of [[0, 20_000], [4097, 20_000], [200, 1], [200, 33_554_433]]) {
    assert.throws(() => f.store.readModelHistory('session', messages, bytes), hasCode('INVALID_MODEL_HISTORY_LIMIT'));
  }
});

test('legacy admissions and native request identity return the same real Run without duplicate user input', t => {
  const f = fixture(t), input = { sessionId: 'session', requestId: 'legacy', prompt: 'legacy goal', config };
  const receipt = f.store.admit(input), before = f.store.getSnapshot('session');
  const native = f.store.acceptInput({ ...input, delivery: 'queue' });
  assert.equal(native.duplicate, true);
  assert.equal(native.state, 'promoted');
  assert.equal(native.runId, receipt.runId);
  assert.equal(native.inputId, receipt.inputId);
  assert.deepEqual(f.store.getSnapshot('session'), before);
  assert.throws(() => f.store.acceptInput({ ...input, delivery: 'steer' }), hasCode('REQUEST_ID_CONFLICT'));
});
