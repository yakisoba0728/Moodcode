import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type InputImageAttachment, type Message } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const config = { providerId: 'fixture', modelId: 'fixture', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const stamp = '2026-10-07T00:00:00.000Z';
const image: InputImageAttachment = { id: 'img_' + 'a'.repeat(32), kind: 'image', mimeType: 'image/png', bytes: 128, sha256: 'a'.repeat(64) };
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-session-image-')), path = join(directory, 'engine.sqlite');
  let store = new SqliteStore(path);
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Image anchor', createdAt: stamp });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const start = (requestId: string, withImage = false) => {
    const receipt = store.admit({ sessionId: 'session', requestId, prompt: requestId, config, ...(withImage ? { attachments: [image] } : {}) });
    store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
    const messageId = store.readModelHistory('session').snapshot.messages.find(message => message.runId === receipt.runId && message.role === 'user')!.id;
    return { ...receipt, messageId };
  };
  const complete = (runId: string) => {
    store.commit(runId, 'message.completed', {}, { message: { id: 'answer-' + runId, sessionId: 'session', runId, role: 'assistant', content: 'Done', createdAt: stamp } });
    store.commit(runId, 'run.completed', {}, { run: { state: 'completed' } });
  };
  const reopen = () => { store.close(); store = new SqliteStore(path); return store; };
  return { get store() { return store; }, path, start, complete, reopen };
}

test('session image survives whole-Run pagination and restart while optional older Runs are dropped whole', t => {
  const f = fixture(t), old = f.start('original-image', true); f.complete(old.runId);
  const middle = f.start('optional-middle'); f.complete(middle.runId);
  const current = f.start('current-text'); f.complete(current.runId);
  for (const restart of [false, true]) {
    const store = restart ? f.reopen() : f.store;
    store.getSnapshot = () => { throw new Error('No whole-session snapshot'); };
    const page = store.readModelHistory('session', 3, 32768);
    assert.deepEqual(page.snapshot.messages.map(message => message.content), ['original-image', 'current-text', 'Done']);
    assert.deepEqual(page.snapshot.runs.map(run => run.id), [old.runId, current.runId]);
    assert.equal(page.omittedRuns, 1); assert.equal(page.omittedMessages, 3);
    assert.equal(page.sessionImageAnchor?.messageId, old.messageId); assert.equal(page.sessionImageAnchor?.runId, old.runId);
    assert.deepEqual(page.snapshot.messages[0]?.attachments, [image]);
    assert.ok(Buffer.byteLength(JSON.stringify(page.snapshot)) <= 32768);
  }
});

test('long active Run reserves its earlier session image plus goal and complete latest exchange', t => {
  const f = fixture(t), old = f.start('original-image', true); f.complete(old.runId);
  const current = f.start('current-text'), db = new DatabaseSync(f.path);
  try {
    db.exec('BEGIN IMMEDIATE'); const insert = db.prepare('INSERT INTO messages(id,session_id,run_id,data) VALUES(?,?,?,?)');
    for (let index = 0; index < 100; index++) {
      const callId = `call-${index}`;
      const assistant: Message = { id: `assistant-${index}`, sessionId: 'session', runId: current.runId, role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'read_file', input: { path: 'fixture.txt' } }], createdAt: stamp };
      const result: Message = { id: `result-${index}`, sessionId: 'session', runId: current.runId, role: 'tool', content: 'bounded observation '.repeat(500), toolCallId: callId, createdAt: stamp };
      for (const message of [assistant, result]) insert.run(message.id, message.sessionId, message.runId, JSON.stringify(message));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  f.store.getSnapshot = () => { throw new Error('No whole-session snapshot'); };
  const page = f.store.readModelHistory('session', 16, 16384);
  assert.ok(page.activeWindow); assert.ok(page.snapshot.messages.length <= 16); assert.ok(Buffer.byteLength(JSON.stringify(page.snapshot)) <= 16384);
  assert.equal(page.snapshot.messages[0]?.id, old.messageId); assert.deepEqual(page.snapshot.messages[0]?.attachments, [image]);
  assert.ok(page.snapshot.messages.some(message => message.id === current.messageId));
  assert.deepEqual(page.snapshot.messages.slice(-2).map(message => message.id), ['assistant-99', 'result-99']);
  assert.equal(page.sessionImageAnchor?.messageId, old.messageId); assert.ok(page.omittedMessages > 180);
});

test('latest image wins across Runs and does not revive older image frames', t => {
  const f = fixture(t), first = f.start('first-image', true); f.complete(first.runId);
  const latest = f.start('latest-image', true); f.complete(latest.runId);
  const current = f.start('current-text'); f.complete(current.runId);
  const page = f.store.readModelHistory('session', 3, 32768);
  assert.equal(page.sessionImageAnchor?.messageId, latest.messageId);
  assert.deepEqual(page.snapshot.messages.filter(message => message.attachments?.length).map(message => message.id), [latest.messageId]);
});

test('session image required cardinality fails before a context can silently lose it', t => {
  const f = fixture(t), old = f.start('original-image', true); f.complete(old.runId); f.start('current-text');
  assert.throws(() => f.store.readModelHistory('session', 1, 32768), code('IMAGE_CONTEXT_LIMIT'));
});

test('session image lookup has a dedicated partial index rather than scanning text message JSON', t => {
  const f = fixture(t), db = new DatabaseSync(f.path);
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT m.id,m.run_id FROM messages m LEFT JOIN runs r ON r.id=m.run_id
      WHERE m.session_id=? AND json_extract(m.data,'$.role')='user' AND json_type(m.data,'$.attachments')='array'
      AND json_array_length(m.data,'$.attachments')>0 ORDER BY m.ordinal DESC LIMIT 1`).all('session');
    assert.ok(plan.some(row => String(row.detail).includes('model_session_latest_image')), JSON.stringify(plan));
  } finally { db.close(); }
});

for (const corruption of ['message-owner', 'run-owner', 'image-reference', 'oversized-message', 'unsafe-ordinal'] as const) test(`bounded session image read rejects ${corruption} without changing raw history`, t => {
  const f = fixture(t), old = f.start('original-image', true); f.complete(old.runId); f.start('current-text');
  const db = new DatabaseSync(f.path);
  try {
    if (corruption === 'message-owner') db.prepare("UPDATE messages SET data=json_set(data,'$.sessionId','other') WHERE id=?").run(old.messageId);
    if (corruption === 'run-owner') db.prepare("UPDATE runs SET data=json_set(data,'$.workspaceId','other') WHERE id=?").run(old.runId);
    if (corruption === 'image-reference') db.prepare("UPDATE messages SET data=json_set(data,'$.attachments[0].sha256','bad') WHERE id=?").run(old.messageId);
    if (corruption === 'oversized-message') db.prepare("UPDATE messages SET data=json_set(data,'$.content',?) WHERE id=?").run('x'.repeat(20000), old.messageId);
    if (corruption === 'unsafe-ordinal') db.prepare('UPDATE messages SET ordinal=9007199254740992 WHERE id=?').run(old.messageId);
    const before = db.prepare('SELECT data FROM messages WHERE id=?').get(old.messageId)?.data;
    assert.throws(() => f.store.readModelHistory('session', 1, 8192), code(corruption === 'oversized-message' ? 'IMAGE_CONTEXT_LIMIT' : 'MODEL_HISTORY_BINDING_MISMATCH'));
    assert.equal(db.prepare('SELECT data FROM messages WHERE id=?').get(old.messageId)?.data, before);
  } finally { db.close(); }
});
