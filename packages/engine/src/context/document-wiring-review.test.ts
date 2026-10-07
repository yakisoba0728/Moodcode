import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_ENGINE_BUDGETS, DEFAULT_LIMITS, EngineError, type InputDocumentAttachment, type InputImageAttachment, type Message, type MessagePart, type ProviderAttempt, type RunConfig, type TurnRecord } from '@moodcode/contracts';
import type { ContextRequest, ProviderAdapter } from '../ports.js';
import { BudgetAccount } from '../config/budgets.js';
import { SqliteStore } from '../storage/index.js';
import { ContextService } from './service.js';
import { projectDocumentHistory, type DocumentHistoryPolicy } from './document-history.js';
import { planContext } from './plan.js';

const stamp = () => new Date().toISOString();
const pdf: InputDocumentAttachment = { id: `doc_${'a'.repeat(32)}`, kind: 'document', mimeType: 'application/pdf', bytes: 32, sha256: 'a'.repeat(64) };
const image: InputImageAttachment = { id: `img_${'b'.repeat(32)}`, kind: 'image', mimeType: 'image/png', bytes: 32, sha256: 'b'.repeat(64) };
const documentPolicy: DocumentHistoryPolicy = { kind: 'reference-only-older-documents', version: 1 };
function fixture(t: TestContext, contextBytes = 10_000) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-document-wiring-review-')), store = new SqliteStore(join(directory, 'engine.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp() });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'PDF review', createdAt: stamp() });
  const config: RunConfig = { providerId: 'fixture', modelId: 'model', mode: 'plan', limits: { ...DEFAULT_LIMITS, maxTurns: 64, maxContextBytes: contextBytes }, budgets: { ...DEFAULT_ENGINE_BUDGETS, turnAllowance: 64 } };
  const start = (requestId: string, documents?: InputDocumentAttachment[], attachments?: InputImageAttachment[]) => {
    const admitted = store.acceptInput({ sessionId: 'session', requestId, prompt: `Original exact goal ${requestId}`, config, delivery: 'queue', ...(documents ? { documents } : {}), ...(attachments ? { attachments } : {}) });
    const run = store.promoteInput(admitted.inputId).run;
    store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
    return store.getRun(run.id);
  };
  return { store, config, start };
}
function textTurn(f: ReturnType<typeof fixture>, runId: string, index: number, bytes: number): void {
  const turn: TurnRecord = { schemaVersion: 2, id: `turn-${index}`, sessionId: 'session', runId, inputIds: f.store.listRunInputIds(runId), index, state: 'created', createdAt: stamp() };
  f.store.putTurn(turn); f.store.putTurn({ ...turn, state: 'streaming' });
  const attempt: ProviderAttempt = { schemaVersion: 2, id: `attempt-${index}`, sessionId: 'session', runId, turnId: turn.id, index: 0, providerId: 'fixture', modelId: 'model', state: 'prepared', createdAt: stamp() };
  f.store.putAttempt(attempt); const dispatched = f.store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: stamp() });
  const content = `Exact observed fact ${index}: ` + 'x'.repeat(bytes);
  const message: Message = { id: `assistant-${index}`, sessionId: 'session', runId, role: 'assistant', content, createdAt: stamp() };
  f.store.commit(runId, 'message.completed', {}, { message });
  const part: MessagePart = { schemaVersion: 2, id: `part-${index}`, sessionId: 'session', runId, turnId: turn.id, messageId: message.id, index: 0, revision: 0, type: 'text', state: 'open', text: content, createdAt: stamp() };
  f.store.putPart(part); f.store.putPart({ ...part, revision: 1, state: 'completed', completedAt: stamp() });
  f.store.putAttempt({ ...dispatched, state: 'completed', completedAt: stamp() });
  f.store.putTurn({ ...turn, state: 'completed', completedAt: stamp(), finishReason: 'stop' });
}
function request(f: ReturnType<typeof fixture>, runId: string, service: ContextService): ContextRequest {
  return { workspace: f.store.getWorkspace('workspace'), snapshot: service.snapshot('session', f.config), config: f.config, run: f.store.getRun(runId), signal: new AbortController().signal, budget: new BudgetAccount(f.config) };
}

test('dual anchors charge an active Run image once when an older PDF and newest complete tool exchange fit five messages', t => {
  const f = fixture(t, 65_536), old = f.start('older-PDF', [pdf]);
  f.store.commit(old.id, 'run.completed', {}, { run: { state: 'completed' } });
  const current = f.start('current-image', undefined, [image]);
  for (let index = 0; index < 8; index++) f.store.commit(current.id, 'message.completed', {}, { message: { id: `earlier-${index}`, sessionId: 'session', runId: current.id, role: 'assistant', content: `Earlier text ${index}`, createdAt: stamp() } });
  const assistant: Message = { id: 'latest-exchange', sessionId: 'session', runId: current.id, role: 'assistant', content: 'Latest complete reads', toolCalls: [{ id: 'call-a', name: 'read_file', input: { path: 'a' } }, { id: 'call-b', name: 'read_file', input: { path: 'b' } }], createdAt: stamp() };
  f.store.commit(current.id, 'message.completed', {}, { message: assistant });
  for (const call of assistant.toolCalls!) f.store.commit(current.id, 'message.completed', {}, { message: { id: `result-${call.id}`, sessionId: 'session', runId: current.id, role: 'tool', toolCallId: call.id, content: `Exact ${call.id} result`, createdAt: stamp() } });
  f.store.getSnapshot = () => { throw new Error('Whole snapshot forbidden'); };
  const page = f.store.readModelHistory('session', 5, 65_536);
  assert.equal(page.snapshot.messages.length, 5);
  assert.deepEqual(page.snapshot.messages.slice(-3).map(message => message.id), ['latest-exchange', 'result-call-a', 'result-call-b']);
  assert.deepEqual(page.snapshot.messages.filter(message => message.documents?.length).map(message => message.runId), [old.id]);
  assert.deepEqual(page.snapshot.messages.filter(message => message.attachments?.length).map(message => message.runId), [current.id]);
  assert.ok(page.sessionImageAnchor && page.sessionDocumentAnchor);
});

test('dual external anchors keep both message and Run pagination chronology when the image predates the PDF', t => {
  const f = fixture(t, 65_536), oldImage = f.start('older-image', undefined, [image]);
  f.store.commit(oldImage.id, 'run.completed', {}, { run: { state: 'completed' } });
  const oldDocument = f.start('later-PDF', [pdf]);
  f.store.commit(oldDocument.id, 'run.completed', {}, { run: { state: 'completed' } });
  const optional = f.start('optional-middle');
  f.store.commit(optional.id, 'run.completed', {}, { run: { state: 'completed' } });
  const current = f.start('current-goal');
  for (let index = 0; index < 8; index++) f.store.commit(current.id, 'message.completed', {}, { message: { id: `current-${index}`, sessionId: 'session', runId: current.id, role: 'assistant', content: `Exact latest observation ${index}`, createdAt: stamp() } });
  f.store.getSnapshot = () => { throw new Error('Whole snapshot forbidden'); };
  const page = f.store.readModelHistory('session', 4, 65_536);
  assert.deepEqual(page.snapshot.messages.map(message => message.runId), [oldImage.id, oldDocument.id, current.id, current.id]);
  assert.deepEqual(page.snapshot.runs.map(run => run.id), [oldImage.id, oldDocument.id, current.id]);
  assert.equal(page.beforeRunId, oldImage.id);
});

test('PDF-bearing goal permits a replacement prefix after the predecessor recent suffix grows beyond context', async t => {
  const f = fixture(t), run = f.start('active-PDF', [pdf]);
  for (let index = 0; index < 4; index++) textTurn(f, run.id, index, 3300);
  let calls = 0;
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn() { calls++; yield { type: 'text.delta', delta: 'Compact exact historical observations; verify current files.' }; yield { type: 'finish', reason: 'stop' }; } };
  const service = new ContextService(f.store, undefined, 0, () => provider, { activePrefixPolicy: { kind: 'active-prefix-semantic', version: 1 }, documentHistoryPolicy: documentPolicy });
  let req = request(f, run.id, service);
  await service.build(req);
  const first = service.activePrefix!.active('session', run.id)!.checkpoint;
  assert.equal(calls, 1);
  textTurn(f, run.id, 4, 3300);
  req = { ...req, snapshot: service.snapshot('session', f.config) };
  await assert.rejects(planContext(service.activePrefix!.project(req)), (error: unknown) => error instanceof EngineError && error.code === 'DOCUMENT_CONTEXT_LIMIT');
  const messages = await service.build(req);
  const next = service.activePrefix!.active('session', run.id)!.checkpoint;
  assert.notEqual(next.id, first.id);
  assert.equal(next.previousCheckpointId, first.id);
  assert.equal(calls, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= f.config.limits.maxContextBytes);
  assert.deepEqual(messages.find(message => message.role === 'user')?.documents, [pdf]);
});

test('a newly prepared prefix persists PDF provenance from the candidate projection rather than the earlier unprojected plan', async t => {
  const f = fixture(t), run = f.start('active-PDF', [pdf]);
  for (let index = 0; index < 6; index++) textTurn(f, run.id, index, 2200);
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn() { yield { type: 'text.delta', delta: 'Exact compact historical observation.' }; yield { type: 'finish', reason: 'stop' }; } };
  const service = new ContextService(f.store, undefined, 0, () => provider, { activePrefixPolicy: { kind: 'active-prefix-semantic', version: 1 }, documentHistoryPolicy: documentPolicy });
  const req = request(f, run.id, service), before = projectDocumentHistory(req.snapshot, { policy: documentPolicy, activeRunId: run.id });
  await service.build(req);
  assert.ok(service.activePrefix!.active('session', run.id));
  const expected = projectDocumentHistory(service.activePrefix!.project(req).snapshot, { policy: documentPolicy, activeRunId: run.id });
  const diagnostics = service.diagnostics('session')!;
  assert.notEqual(expected.diagnostics.sourceSha256, before.diagnostics.sourceSha256);
  assert.equal(diagnostics.documentHistory!.sourceSha256, expected.diagnostics.sourceSha256);
  assert.deepEqual(diagnostics.documentHistory!.provenance, expected.provenance);
  const revision = f.store.getContextRevision(diagnostics.revisionId);
  assert.ok(revision.sourceIds.includes(`document-source:${expected.diagnostics.sourceSha256}`));
});
