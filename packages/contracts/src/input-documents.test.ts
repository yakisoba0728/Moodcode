import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError, INPUT_DOCUMENT_LIMITS, type InputDocumentAttachment, type InputImageAttachment } from './index.js';
import { assertInputMediaBudget, normalizeAcceptInput, normalizeDocumentAttachments, normalizeSubmitInput, validateCommand, validateInputRecord, validateRunRecordV2, validateSessionCommand } from './validation.js';

const document = (bytes = 100): InputDocumentAttachment => ({ id: `doc_${'1'.repeat(32)}`, kind: 'document', mimeType: 'application/pdf', bytes, sha256: 'a'.repeat(64) });
const image = (index = 1, bytes = 100): InputImageAttachment => ({ id: `img_${index.toString(16).padStart(32, '0')}`, kind: 'image', mimeType: 'image/png', bytes, sha256: 'b'.repeat(64) });
const input = { sessionId: 'session', requestId: 'request', prompt: 'Read this PDF' };
const invalid = (error: unknown) => error instanceof EngineError && error.code === 'INVALID_INPUT';

test('PDF references survive v1/v2 admission and durable record validation without aliases or caller mutation', () => {
  const refs = [document()], normalized = normalizeSubmitInput({ ...input, documents: refs });
  refs[0]!.bytes = 200;
  refs.push(document());
  assert.deepEqual(normalized.documents, [document()]);
  assert.deepEqual(normalizeAcceptInput({ ...input, documents: [document()], delivery: 'queue' }).documents, [document()]);
  assert.deepEqual(validateCommand({ schemaVersion: 1, commandId: 'command', type: 'run.submit', payload: { ...input, documents: [document()] } }).payload.documents, [document()]);
  assert.deepEqual(validateSessionCommand({ schemaVersion: 2, commandId: 'command', type: 'input.accept', payload: { ...input, documents: [document()] } }, { enabledCommands: ['input.accept'] }).payload.documents, [document()]);
  const timestamp = '2026-10-07T00:00:00.000Z';
  const accepted = validateInputRecord({ ...normalized, schemaVersion: 2, id: 'input', workspaceId: 'workspace', delivery: 'queue', state: 'pending', admittedSeq: 1, createdAt: timestamp, updatedAt: timestamp });
  const run = validateRunRecordV2({ ...normalized, schemaVersion: 2, id: 'run', inputId: 'input', inputIds: ['input'], workspaceId: 'workspace', state: 'created', createdAt: timestamp, updatedAt: timestamp });
  assert.deepEqual(accepted.documents, [document()]);
  assert.deepEqual(run.documents, [document()]);
  assert.notEqual(accepted.documents?.[0], normalized.documents?.[0]);
  assert.notEqual(run.documents?.[0], normalized.documents?.[0]);
});

test('absent document refs keep the old exact shape while explicit empty refs remain present', () => {
  const baseline = normalizeSubmitInput(input);
  assert.equal(Object.hasOwn(baseline, 'documents'), false);
  assert.equal(Object.hasOwn(normalizeAcceptInput(input), 'documents'), false);
  assert.deepEqual(normalizeSubmitInput({ ...input, documents: [] }).documents, []);
  assert.notEqual(JSON.stringify(baseline), JSON.stringify(normalizeSubmitInput({ ...input, documents: [] })));
  assert.throws(() => normalizeSubmitInput({ ...input, documents: undefined }), invalid);
  assert.throws(() => normalizeAcceptInput({ ...input, documents: undefined }), invalid);
});

test('PDF references reject inline bytes, filenames, locations, unsupported identities and MIME types', () => {
  for (const bad of [
    { ...document(), filename: 'report.pdf' }, { ...document(), path: '/tmp/report.pdf' }, { ...document(), url: 'https://example.invalid/report.pdf' },
    { ...document(), data: 'JVBERg==' }, { ...document(), base64: 'JVBERg==' }, { ...document(), kind: 'image' }, { ...document(), id: image().id },
    { ...document(), id: `doc_${'A'.repeat(32)}` }, { ...document(), mimeType: 'application/msword' }, { ...document(), mimeType: 'Application/PDF' },
    { ...document(), sha256: 'A'.repeat(64) }, { ...document(), sha256: 'a'.repeat(63) },
  ]) assert.throws(() => normalizeDocumentAttachments([bad]), invalid);
});

test('document count/bytes and decoded image/document union stay bounded for commands and direct helper', () => {
  assert.deepEqual(normalizeDocumentAttachments([document(INPUT_DOCUMENT_LIMITS.maxDocumentBytes)]), [document(INPUT_DOCUMENT_LIMITS.maxDocumentBytes)]);
  for (const bytes of [0, -1, 1.5, NaN, Infinity, INPUT_DOCUMENT_LIMITS.maxDocumentBytes + 1]) assert.throws(() => normalizeDocumentAttachments([document(bytes)]), invalid);
  assert.throws(() => normalizeDocumentAttachments([document(), document()]), invalid);
  const attachments = [image(1, 524_288)], documents = [document(524_288)];
  assert.doesNotThrow(() => assertInputMediaBudget(attachments, documents));
  assert.doesNotThrow(() => normalizeSubmitInput({ ...input, attachments, documents }));
  assert.throws(() => assertInputMediaBudget([...attachments, image(2, 1)], documents), invalid);
  assert.throws(() => normalizeAcceptInput({ ...input, attachments: [...attachments, image(2, 1)], documents }), invalid);
  assert.doesNotThrow(() => assertInputMediaBudget(undefined, undefined));
  assert.throws(() => assertInputMediaBudget(undefined, null), invalid);
});

test('document refs reject sparse/custom arrays, accessors and proxies without evaluating getters', () => {
  let getterCalls = 0;
  const entry = Object.defineProperty({ ...document() }, 'bytes', { enumerable: true, get() { getterCalls++; return 100; } });
  const array = Object.defineProperty([], '0', { enumerable: true, get() { getterCalls++; return document(); } });
  const custom = [document()]; Object.setPrototypeOf(custom, null);
  for (const bad of [undefined, null, new Array(1), array, [entry], custom, Object.assign([document()], { extra: true }), [new Proxy(document(), {})], new Proxy([document()], {})]) assert.throws(() => normalizeDocumentAttachments(bad), invalid);
  assert.equal(getterCalls, 0);
  const symbol = [document()]; Object.defineProperty(symbol, Symbol('extra'), { value: 1 });
  assert.throws(() => normalizeDocumentAttachments(symbol), invalid);
  const hidden = [document()]; Object.defineProperty(hidden, '0', { value: document(), enumerable: false });
  assert.throws(() => normalizeDocumentAttachments(hidden), invalid);
});
