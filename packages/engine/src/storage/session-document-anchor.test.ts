import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type InputDocumentAttachment, type InputImageAttachment, type Message } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

const config = { providerId: 'fixture', modelId: 'fixture', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const stamp = '2026-10-07T00:00:00.000Z';
const pdf: InputDocumentAttachment = { id: 'doc_' + 'a'.repeat(32), kind: 'document', mimeType: 'application/pdf', bytes: 128, sha256: 'a'.repeat(64) };
const image: InputImageAttachment = { id: 'img_' + 'b'.repeat(32), kind: 'image', mimeType: 'image/png', bytes: 128, sha256: 'b'.repeat(64) };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-session-doc-anchor-')), path = join(directory, 'engine.sqlite');
  let store = new SqliteStore(path);
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Document anchor', createdAt: stamp });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function start(requestId: string, media: { documents?: InputDocumentAttachment[]; attachments?: InputImageAttachment[] } = {}) {
    const receipt = store.admit({ sessionId: 'session', requestId, prompt: requestId, config, ...media });
    store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
    const messageId = store.readModelHistory('session').snapshot.messages.find(message => message.runId === receipt.runId && message.role === 'user')!.id;
    return { ...receipt, messageId };
  }
  function complete(runId: string) {
    store.commit(runId, 'message.completed', {}, { message: { id: 'answer-' + runId, sessionId: 'session', runId, role: 'assistant', content: 'Done', createdAt: stamp } });
    store.commit(runId, 'run.completed', {}, { run: { state: 'completed' } });
  }
  return { get store() { return store; }, path, start, complete, reopen() { store.close(); store = new SqliteStore(path); return store; } };
}

test('PDF and image session anchors preserve numeric chronology and independent owners across pagination and restart', t => {
  const f = fixture(t), pixels = f.start('older-pixels', { attachments: [image] }); f.complete(pixels.runId);
  const document = f.start('newer-pdf', { documents: [pdf] }); f.complete(document.runId);
  const middle = f.start('optional-middle'); f.complete(middle.runId);
  const current = f.start('current-text'); f.complete(current.runId);
  for (const restarted of [false, true]) {
    const store = restarted ? f.reopen() : f.store;
    store.getSnapshot = () => { throw new Error('Whole-session snapshots are forbidden'); };
    const page = store.readModelHistory('session', 4, 32768);
    assert.deepEqual(page.snapshot.messages.map(message => message.content), ['older-pixels', 'newer-pdf', 'current-text', 'Done']);
    assert.equal(page.sessionImageAnchor?.messageId, pixels.messageId);
    assert.equal(page.sessionDocumentAnchor?.messageId, document.messageId);
    assert.deepEqual(page.snapshot.messages.find(message => message.id === document.messageId)?.documents, [pdf]);
    assert.equal(page.omittedRuns, 1); assert.equal(page.omittedMessages, 4);
    assert.ok(Buffer.byteLength(JSON.stringify(page.snapshot)) <= 32768);
  }
});

test('a long active Run reserves both foreign session media anchors and its complete newest tool exchange', t => {
  const f = fixture(t), pixels = f.start('pixels', { attachments: [image] }); f.complete(pixels.runId);
  const document = f.start('pdf', { documents: [pdf] }); f.complete(document.runId);
  const current = f.start('goal'), db = new DatabaseSync(f.path);
  try {
    const insert = db.prepare('INSERT INTO messages(id,session_id,run_id,data) VALUES(?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 100; index++) {
      const callId = `call-${index}`;
      const assistant: Message = { id: `assistant-${index}`, sessionId: 'session', runId: current.runId, role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'read_file', input: { path: 'fixture.txt' } }], createdAt: stamp };
      const result: Message = { id: `result-${index}`, sessionId: 'session', runId: current.runId, role: 'tool', toolCallId: callId, content: 'historical observation '.repeat(400), createdAt: stamp };
      for (const message of [assistant, result]) insert.run(message.id, message.sessionId, message.runId, JSON.stringify(message));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  f.store.getSnapshot = () => { throw new Error('Whole-session snapshots are forbidden'); };
  const page = f.store.readModelHistory('session', 5, 32768);
  assert.deepEqual(page.snapshot.messages.map(message => message.id), [pixels.messageId, document.messageId, current.messageId, 'assistant-99', 'result-99']);
  assert.equal(page.activeWindow?.runId, current.runId);
  assert.equal(page.snapshot.messages.at(-1)?.toolCallId, 'call-99');
  assert.ok(Buffer.byteLength(JSON.stringify(page.snapshot)) <= 32768);
});

for (const corruption of ['message-session', 'run-session', 'run-workspace', 'document-reference'] as const) test(`latest PDF anchor rejects ${corruption} without dropping the required original`, t => {
  const f = fixture(t), document = f.start('pdf', { documents: [pdf] }); f.complete(document.runId);
  const current = f.start('current'); f.complete(current.runId);
  const db = new DatabaseSync(f.path);
  try {
    if (corruption === 'message-session') db.prepare("UPDATE messages SET data=json_set(data,'$.sessionId','foreign') WHERE id=?").run(document.messageId);
    if (corruption === 'run-session') db.prepare("UPDATE runs SET data=json_set(data,'$.sessionId','foreign') WHERE id=?").run(document.runId);
    if (corruption === 'run-workspace') db.prepare("UPDATE runs SET data=json_set(data,'$.workspaceId','foreign') WHERE id=?").run(document.runId);
    if (corruption === 'document-reference') db.prepare("UPDATE messages SET data=json_set(data,'$.documents[0].sha256','bad') WHERE id=?").run(document.messageId);
  } finally { db.close(); }
  assert.throws(() => f.store.readModelHistory('session', 3, 32768), (error: unknown) => error instanceof EngineError && error.code === 'MODEL_HISTORY_BINDING_MISMATCH');
});

test('inbox PDF and image references survive promotion and exact retry independently', t => {
  const f = fixture(t), input = { sessionId: 'session', requestId: 'mixed', prompt: 'Inspect both', config, delivery: 'queue' as const, documents: [pdf], attachments: [image] };
  const receipt = f.store.acceptInput(input), promotion = f.store.promoteInput(receipt.inputId);
  assert.deepEqual(promotion.run.documents, [pdf]); assert.deepEqual(promotion.run.attachments, [image]);
  assert.deepEqual(f.store.readModelHistory('session').snapshot.messages[0]?.documents, [pdf]);
  const reopened = f.reopen();
  assert.equal(reopened.lookupInputReceipt(input)?.inputId, receipt.inputId);
  assert.throws(() => reopened.lookupInputReceipt({ ...input, documents: [] }), (error: unknown) => error instanceof EngineError && error.code === 'REQUEST_ID_CONFLICT');
  assert.throws(() => reopened.lookupInputReceipt({ ...input, documents: [{ ...pdf, sha256: 'c'.repeat(64) }] }), (error: unknown) => error instanceof EngineError && error.code === 'REQUEST_ID_CONFLICT');
});
