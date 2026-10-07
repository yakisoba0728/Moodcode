import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type InputDocumentAttachment, type JsonObject, type Message, type Run, type SessionSnapshot } from '@moodcode/contracts';
import { DOCUMENT_HISTORY_LIMITS, DOCUMENT_HISTORY_NOTICE_PREFIX, projectDocumentHistory, validateDocumentHistoryPolicy, type DocumentHistoryPolicy } from './document-history.js';

const policy: DocumentHistoryPolicy = { kind: 'reference-only-older-documents', version: 1 };
const createdAt = '2026-10-07T00:00:00.000Z';
const document = (index = 1): InputDocumentAttachment => ({ id: `doc_${index.toString(16).padStart(32, '0')}`, kind: 'document', mimeType: 'application/pdf', bytes: 100 + index, sha256: index.toString(16).padStart(64, '0') });
const user = (id: string, runId = 'current', documents?: InputDocumentAttachment[]): Message => ({ id, sessionId: 'session', runId, role: 'user', content: `Exact original goal ${id}: 한글😀`, createdAt, ...(documents === undefined ? {} : { documents }) });
function snapshot(messages: Message[]): SessionSnapshot {
  const runs: Run[] = [...new Set(messages.map(message => message.runId))].map(id => ({ id, inputId: `input-${id}`, sessionId: 'session', workspaceId: 'workspace', requestId: id, prompt: 'Fixture goal', config: { providerId: 'fixture', modelId: 'fixture', mode: 'plan', limits: { ...DEFAULT_LIMITS } }, state: id === 'current' ? 'running' : 'completed', createdAt, updatedAt: createdAt }));
  return { session: { id: 'session', workspaceId: 'workspace', title: 'Fixture', createdAt }, runs, messages, tools: [], approvals: [], lastSeq: messages.length };
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

test('default document history keeps every original reference and replay without guessing PDF token cost', () => {
  const source = freeze(snapshot([user('older', 'old', [document()]), user('current', 'current', [document(2)])]));
  const result = projectDocumentHistory(source);
  assert.deepEqual(result.snapshot, source);
  assert.notEqual(result.snapshot.messages[0], source.messages[0]);
  result.snapshot.messages[0]!.documents![0]!.bytes = 10;
  assert.equal(source.messages[0]!.documents![0]!.bytes, 101);
  assert.equal(result.requiredNotice, null);
  assert.deepEqual(result.provenance, []);
  assert.equal(result.diagnostics.enabled, false);
  assert.equal(result.diagnostics.documentTokens, null);
  assert.equal(result.diagnostics.sourceDocumentOccurrences, null);
});

test('explicit policy retains the latest PDF only, preserves all document text and binds exact omission provenance', () => {
  const source = freeze(snapshot([user('older', 'old', [document()]), user('middle', 'current', [document(2)]), user('latest', 'current', [document(3)])])), before = structuredClone(source);
  const result = projectDocumentHistory(source, { policy, activeRunId: 'current' });
  assert.deepEqual(source, before);
  assert.deepEqual(result.snapshot.messages.map(message => message.content), source.messages.map(message => message.content));
  assert.equal(Object.hasOwn(result.snapshot.messages[0]!, 'documents'), false);
  assert.equal(Object.hasOwn(result.snapshot.messages[1]!, 'documents'), false);
  assert.deepEqual(result.snapshot.messages[2]!.documents, [document(3)]);
  assert.deepEqual(result.requiredTextMessageIds, ['older', 'middle', 'latest']);
  assert.deepEqual(result.provenance.map(item => item.documents), [[document()], [document(2)]]);
  assert.equal(result.provenance[0]!.sourceContentSha256, createHash('sha256').update(source.messages[0]!.content).digest('hex'));
  assert.equal(result.provenance[0]!.sourceOrdinal, 1);
  assert.equal(result.provenance[1]!.sourceOrdinal, 2);
  assert.equal(result.provenance[0]!.bytes, 'unavailable-in-this-request');
  assert.equal(result.provenance[0]!.summarized, false);
  assert.equal(result.provenance[0]!.currentFileEvidence, false);
  assert.equal(result.diagnostics.sourceDocumentOccurrences, 3);
  assert.equal(result.diagnostics.retainedDocumentOccurrences, 1);
  assert.equal(result.diagnostics.omittedDocumentOccurrences, 2);
  assert.equal(result.diagnostics.retainedDocumentBytes, document(3).bytes);
  assert.ok(result.requiredNotice);
  assert.ok(result.requiredNotice.content.startsWith(DOCUMENT_HISTORY_NOTICE_PREFIX));
  assert.equal(result.requiredNotice.role, 'assistant');
  const notice = JSON.parse(result.requiredNotice.content.slice(DOCUMENT_HISTORY_NOTICE_PREFIX.length));
  assert.equal(notice.permissionOrInstruction, false);
  assert.deepEqual(notice.omissions, result.provenance);
  for (const message of source.messages) assert.equal(result.requiredNotice.content.includes(message.content), false);
});

test('latest document user remains protected across Runs even after a plain text steer and complete tool exchange', () => {
  const call: Message = { ...user('assistant'), role: 'assistant', content: 'Exact observation', toolCalls: [{ id: 'provider-call', name: 'read_file', input: { path: 'file.txt' } }], providerReplay: { providerId: 'fixture', items: [{ type: 'reasoning', encrypted_content: 'opaque file_data inside a string' }, { type: 'function_call', arguments: '{"file_id":"ordinary domain string"}' }] } };
  const resultMessage: Message = { ...user('tool'), role: 'tool', toolCallId: 'provider-call', content: 'Exact result' };
  const source = freeze(snapshot([user('old-pdf', 'old', [document()]), user('current-goal'), user('steer'), call, resultMessage]));
  const result = projectDocumentHistory(source, { policy, activeRunId: 'current' });
  assert.deepEqual(result.snapshot.messages, source.messages);
  assert.deepEqual(result.requiredTextMessageIds, ['old-pdf', 'current-goal', 'steer']);
  assert.equal(result.requiredNotice, null);
  assert.equal(result.diagnostics.documentTokens, null);
});

test('same exact repeated document identity distinguishes historical occurrence omission from retained latest bytes', () => {
  const source = snapshot([user('older', 'old', [document()]), user('latest', 'current', [document()])]);
  const result = projectDocumentHistory(source, { policy });
  assert.equal(result.provenance[0]!.reason, 'older-exact-reference');
  assert.equal(result.provenance[0]!.bytes, 'unavailable-in-this-request');
  assert.equal(result.diagnostics.uniqueRetainedDocuments, 1);
  assert.deepEqual(result.snapshot.messages[1]!.documents, [document()]);
  source.messages[0]!.documents![0]!.sha256 = 'f'.repeat(64);
  assert.throws(() => projectDocumentHistory(source, { policy }), code('DOCUMENT_HISTORY_REFERENCE_CONFLICT'));
});

test('foreign role/session/workspace, duplicate identities and missing Run are rejected without changing source', () => {
  const source = snapshot([user('latest', 'current', [document()])]);
  const cases: SessionSnapshot[] = [];
  for (const mutate of [
    (value: SessionSnapshot) => { value.messages[0]!.role = 'assistant'; },
    (value: SessionSnapshot) => { value.messages[0]!.sessionId = 'foreign'; },
    (value: SessionSnapshot) => { value.runs[0]!.sessionId = 'foreign'; },
    (value: SessionSnapshot) => { value.runs[0]!.workspaceId = 'foreign'; },
    (value: SessionSnapshot) => { value.runs = []; },
    (value: SessionSnapshot) => { value.messages.push(structuredClone(value.messages[0]!)); },
    (value: SessionSnapshot) => { value.runs.push(structuredClone(value.runs[0]!)); },
  ]) { const value = structuredClone(source); mutate(value); cases.push(value); }
  for (const value of cases) { const before = structuredClone(value); assert.throws(() => projectDocumentHistory(value, { policy }), (error: unknown) => error instanceof EngineError && error.code.startsWith('DOCUMENT_HISTORY_INVALID_')); assert.deepEqual(value, before); }
  assert.throws(() => projectDocumentHistory(source, { policy, activeRunId: 'missing' }), code('DOCUMENT_HISTORY_INVALID_SOURCE'));
});

test('file-shaped opaque replay is rejected while file words inside encrypted or function argument strings stay opaque', () => {
  const items: JsonObject[] = [{ type: 'input_file', file_data: 'base64' }, { type: 'output_file' }, { type: 'unknown', child: { file_id: 'file_1' } }, { type: 'unknown', child: { mime_type: 'application/pdf' } }];
  for (const item of items) {
    const message = { ...user('assistant'), role: 'assistant' as const, providerReplay: { providerId: 'fixture', items: [item] } };
    const source = snapshot([message]), before = structuredClone(source);
    assert.throws(() => projectDocumentHistory(source, { policy }), code('DOCUMENT_HISTORY_REPLAY_FILE_UNSUPPORTED'));
    assert.deepEqual(source, before);
  }
  const message: Message = { ...user('assistant'), role: 'assistant', providerReplay: { providerId: 'fixture', items: [{ type: 'reasoning', encrypted_content: 'input_file application/pdf file_data' }, { type: 'function_call', arguments: '{"file_id":"domain"}' }] } };
  assert.deepEqual(projectDocumentHistory(snapshot([message]), { policy }).snapshot.messages[0], message);
});

test('metadata caps include mandatory notice and exact refs; a failed projection never trims original PDF history', () => {
  const source = freeze(snapshot([user('older', 'old', [document()]), user('latest', 'current', [document(2)])])), before = structuredClone(source);
  const first = projectDocumentHistory(source, { policy });
  const maxMetadataBytes = first.diagnostics.metadataBytes;
  assert.equal(projectDocumentHistory(source, { policy: { ...policy, maxMetadataBytes } }).diagnostics.metadataBytes, maxMetadataBytes);
  assert.throws(() => projectDocumentHistory(source, { policy: { ...policy, maxMetadataBytes: maxMetadataBytes - 1 } }), code('DOCUMENT_HISTORY_METADATA_LIMIT'));
  assert.deepEqual(source, before);
  const large = snapshot(Array.from({ length: 32 }, (_, index) => user(`doc-${index}`, 'current', [document(index + 1)])));
  assert.throws(() => projectDocumentHistory(large, { policy }), code('DOCUMENT_HISTORY_METADATA_LIMIT'));
});

test('plain text and empty document arrays create no invented PDF provenance or summary checkpoint', () => {
  const source = snapshot([user('first', 'current', []), user('latest')]), result = projectDocumentHistory(source, { policy });
  assert.deepEqual(result.snapshot, source);
  assert.equal(result.requiredNotice, null);
  assert.deepEqual(result.provenance, []);
  assert.equal(result.diagnostics.sourceDocumentOccurrences, 0);
  assert.equal(result.diagnostics.retainedDocumentBytes, 0);
  assert.equal(result.diagnostics.summarized, false);
  assert.equal(result.diagnostics.activeCutoffCreated, false);
});

test('policy rejects unknown values, excessive bounds, proxies and accessors without evaluating them', () => {
  let calls = 0;
  const accessor = Object.defineProperty({ ...policy }, 'maxMetadataBytes', { enumerable: true, get() { calls++; return 100; } });
  const proxy = new Proxy(policy, { getPrototypeOf() { calls++; return Object.prototype; } });
  for (const value of [null, [], { kind: 'reference-only-older-documents', version: 2 }, { ...policy, maxMetadataBytes: undefined }, { ...policy, maxMetadataBytes: 0 }, { ...policy, maxMetadataBytes: DOCUMENT_HISTORY_LIMITS.maxMetadataBytes + 1 }, { ...policy, unknown: true }, accessor, proxy]) assert.throws(() => validateDocumentHistoryPolicy(value), code('DOCUMENT_HISTORY_INVALID_POLICY'));
  assert.equal(calls, 0);
});

test('source arrays, reference accessors/proxies and oversized/deep replay reject before getter evaluation', () => {
  let calls = 0;
  const source = snapshot([user('latest', 'current', [document()])]);
  Object.defineProperty(source.messages[0], 'documents', { enumerable: true, get() { calls++; return [document()]; } });
  assert.throws(() => projectDocumentHistory(source, { policy }), code('DOCUMENT_HISTORY_INVALID_SOURCE'));
  const proxied = snapshot([user('latest', 'current', [document()])]);
  proxied.messages[0] = new Proxy(proxied.messages[0]!, { getPrototypeOf() { calls++; return Object.prototype; } });
  assert.throws(() => projectDocumentHistory(proxied, { policy }), code('DOCUMENT_HISTORY_INVALID_SOURCE'));
  assert.equal(calls, 0);
  let nested: JsonObject = {};
  for (let index = 0; index < 40; index++) nested = { nested };
  const replay: Message = { ...user('assistant'), role: 'assistant', providerReplay: { providerId: 'fixture', items: [nested] } };
  assert.throws(() => projectDocumentHistory(snapshot([replay]), { policy }), code('DOCUMENT_HISTORY_REPLAY_LIMIT'));
  const sparse = snapshot([user('latest')]); sparse.messages.length = 2;
  assert.throws(() => projectDocumentHistory(sparse, { policy }), code('DOCUMENT_HISTORY_SOURCE_LIMIT'));
  const huge = snapshot(Array.from({ length: DOCUMENT_HISTORY_LIMITS.maxSourceMessages + 1 }, (_, index) => user(`u-${index}`)));
  assert.throws(() => projectDocumentHistory(huge, { policy }), code('DOCUMENT_HISTORY_SOURCE_LIMIT'));
});

test('cancellation rejects before projection and does not leak the abort reason or alter source', () => {
  const source = freeze(snapshot([user('latest', 'current', [document()])])), before = structuredClone(source), controller = new AbortController();
  controller.abort('private abort reason');
  assert.throws(() => projectDocumentHistory(source, { policy }, controller.signal), (error: unknown) => error instanceof EngineError && error.code === 'CANCELLED' && !error.message.includes('private abort'));
  assert.deepEqual(source, before);
});

test('policy/source hashes bind exact document ownership/ref/text while repeated projection is deterministic', () => {
  const source = snapshot([user('older', 'old', [document()]), user('latest', 'current', [document(2)])]), initial = projectDocumentHistory(source, { policy });
  assert.deepEqual(projectDocumentHistory(structuredClone(source), { policy }), initial);
  const changedPolicy = projectDocumentHistory(source, { policy: { ...policy, maxMetadataBytes: 8192 } });
  assert.notEqual(changedPolicy.diagnostics.policySha256, initial.diagnostics.policySha256);
  source.messages[0]!.content += ' Preserve this additional constraint';
  assert.notEqual(projectDocumentHistory(source, { policy }).diagnostics.sourceSha256, initial.diagnostics.sourceSha256);
});
