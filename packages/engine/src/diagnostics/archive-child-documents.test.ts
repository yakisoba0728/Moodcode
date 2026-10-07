import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import type { InputDocumentIndexReport } from '../storage/input-document-index.js';
import { buildArchivedChildDocumentStorageReport, DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS, validateArchivedChildDocumentStorageRequest,
  type ArchivedChildDocumentObservation, type ArchivedChildDocumentReportInput } from './archive-child-documents.js';

const taskId = (n: number) => 'child_' + n.toString(16).padStart(32, '0');
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
const request = () => ({ directory: '/tmp/authored-archive', expectedManifestSha256: 'a'.repeat(64), sessionId: 'session', sourceRunId: 'root-run', taskIds: [taskId(1)] });
function index(count = 3, complete = true, owner = 'child-session'): InputDocumentIndexReport {
  const refs = Array.from({ length: count }, (_, n) => ({ id: 'doc_' + n.toString(16).padStart(32, '0'), kind: 'document' as const, mimeType: 'application/pdf' as const, bytes: n + 42, sha256: n.toString(16).padStart(64, '0'), sessionId: owner, workspaceId: 'child-workspace' }));
  return { scope: 'primary-database-only', observedAt: '2026-10-07T00:00:00.000Z', complete, totalDocuments: 1, sampledDocuments: 1, invalidDocuments: complete ? 0 : 1, omittedDocuments: 0, invalidReferences: 0, omittedReferences: complete ? 0 : null, sampledJsonBytes: 100, documents: [{ sessionId: owner, workspaceId: 'child-workspace', workspaceRoot: '/private/source-workspace-not-returned', revision: 1, referenceCount: count }], refs, documentIds: refs.map(ref => ref.id), declaredBytes: refs.reduce((sum, ref) => sum + ref.bytes, 0), limits: { maxDocuments: 64, maxRefs: 2048, maxJsonBytes: 4_194_304 }, reasons: complete ? [] : ['invalid-owner'], coverage: { source: 'session_documents.input_documents', ownerValidation: 'joined-session-workspace-and-stored-payload', bytes: 'UTF-8 sampled JSON and declared unique reference bytes', sql: 'bounded metadata/payload rows; document count may scan primary headers', childDatabases: 'not-read', childBlobs: 'not-read', filesystem: 'not-read', physicalReadBytes: null } };
}
function observed(n = 1, count = 3, complete = true): ArchivedChildDocumentObservation {
  return { taskId: taskId(n), status: 'observed', childSessionId: 'child-session', childRunId: 'child-run', lineage: { rootRunId: 'root-run', parentRunId: 'root-run', depth: 1 }, index: index(count, complete) };
}
function input(observations: ArchivedChildDocumentObservation[] = [observed()]): ArchivedChildDocumentReportInput {
  return { archiveId: '12345678-1234-1234-1234-123456789abc', manifestSha256: 'a'.repeat(64), expectedManifestSha256: 'a'.repeat(64), sessionId: 'session', sourceRunId: 'root-run', archiveDocumentAuditCoverage: 'complete', requestedTaskIds: observations.map(item => item.taskId), observations, stats: { selectedMetadataBytes: 1024, selectedRefs: 3, selectedRows: 10, openedChildren: 1, rawMirrorBytes: 446_464, elapsedMs: 1, exhaustedReason: null }, limits: DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS };
}

test('request validation is detached, frozen, exact and requires no filesystem existence', () => {
  const source = { ...request(), limits: { maxMetadataBytes: 1024, maxDocumentSamples: 0 } }, selected = validateArchivedChildDocumentStorageRequest(source);
  source.taskIds[0] = taskId(2); source.limits.maxMetadataBytes = 1; source.directory = '/changed';
  assert.equal(selected.directory, '/tmp/authored-archive'); assert.deepEqual(selected.taskIds, [taskId(1)]); assert.equal(selected.limits.maxMetadataBytes, 1024); assert.equal(selected.limits.maxDocumentSamples, 0);
  assert.ok(Object.isFrozen(selected)); assert.ok(Object.isFrozen(selected.taskIds)); assert.ok(Object.isFrozen(selected.limits));
});

test('proxy, accessor, dense-array, and nested limits traps are never invoked', () => {
  let traps = 0;
  const proxy = new Proxy(request(), { getPrototypeOf() { traps++; throw new Error('private'); }, ownKeys() { traps++; throw new Error('private'); } });
  const getter = request(); Object.defineProperty(getter, 'directory', { enumerable: true, get() { traps++; throw new Error('private'); } });
  const ids = [taskId(1)]; Object.defineProperty(ids, '0', { enumerable: true, get() { traps++; throw new Error('private'); } });
  const limits = new Proxy({}, { get() { traps++; throw new Error('private'); } });
  for (const value of [proxy, getter, { ...request(), taskIds: ids }, { ...request(), taskIds: new Proxy([], { get() { traps++; throw new Error('private'); } }) }, { ...request(), limits }]) assert.throws(() => validateArchivedChildDocumentStorageRequest(value), code('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
  assert.equal(traps, 0);
});

test('invalid paths, SHA, owners, duplicate/sparse selectors and unknown fields fail before archive access', () => {
  const invalid = [null, [], { ...request(), directory: 'relative' }, { ...request(), directory: '/tmp/a/../b' }, { ...request(), directory: '/tmp/\u0000b' }, { ...request(), directory: '/tmp/' + 'a'.repeat(8192) }, { ...request(), expectedManifestSha256: 'A'.repeat(64) }, { ...request(), sessionId: '' }, { ...request(), sourceRunId: 'a\n' }, { ...request(), taskIds: [taskId(1), taskId(1)] }, { ...request(), taskIds: new Array(1) }, { ...request(), taskIds: ['arbitrary-child'] }, { ...request(), dbPath: '/arbitrary' }, { ...request(), filename: 'private.pdf' }];
  for (const value of invalid) assert.throws(() => validateArchivedChildDocumentStorageRequest(value), code('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
});

test('each proof/display hard cap remains strict while explicit zero samples and up to 32 selected tasks work', () => {
  for (const key of Object.keys(DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS) as (keyof typeof DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS)[]) {
    const ceiling = key === 'maxChildren' ? 32 : key === 'maxDocumentSamples' ? 128 : DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS[key];
    for (const value of [ceiling + 1, -1, 1.5, Number.NaN]) assert.throws(() => validateArchivedChildDocumentStorageRequest({ ...request(), limits: { [key]: value } }), code('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
    if (key !== 'maxDocumentSamples') assert.throws(() => validateArchivedChildDocumentStorageRequest({ ...request(), limits: { [key]: 0 } }), code('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
  }
  assert.throws(() => validateArchivedChildDocumentStorageRequest({ ...request(), limits: { maxReportBytes: 4095 } }), code('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
  assert.throws(() => validateArchivedChildDocumentStorageRequest({ ...request(), taskIds: Array.from({ length: 9 }, (_, n) => taskId(n)) }), code('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
  assert.equal(validateArchivedChildDocumentStorageRequest({ ...request(), taskIds: Array.from({ length: 32 }, (_, n) => taskId(n)), limits: { maxChildren: 32, maxDocumentSamples: 0 } }).taskIds.length, 32);
});

test('native signal brand/shadow/prototype validation never invokes supplied getters or prototype traps', () => {
  let traps = 0;
  const controller = new AbortController(); Object.defineProperty(controller.signal, 'aborted', { get() { traps++; return false; } });
  const proxyPrototype = new Proxy(AbortSignal.prototype, { getPrototypeOf() { traps++; throw new Error('private'); } });
  const inherited = new AbortController().signal; Object.setPrototypeOf(inherited, proxyPrototype);
  const shadow = new AbortController(); shadow.abort(); Object.defineProperty(shadow.signal, 'aborted', { value: false });
  for (const signal of [controller.signal, inherited, shadow.signal, Object.create(AbortSignal.prototype), new Proxy(new AbortController().signal, { get() { traps++; return false; } })]) assert.throws(() => validateArchivedChildDocumentStorageRequest({ ...request(), signal }), code('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
  assert.equal(traps, 0);
});

test('observed private native signal preserves cancellation for direct/composite signals despite post-entry public shadow mutation', () => {
  for (const beforeAbort of [true, false]) for (const composite of [true, false]) {
    const controller = new AbortController(), supplied = composite ? AbortSignal.any([controller.signal]) : controller.signal, selected = validateArchivedChildDocumentStorageRequest({ ...request(), signal: supplied });
    try {
      assert.notEqual(selected.signal, supplied); assert.equal(selected.signal!.aborted, false); assert.equal(getEventListeners(selected.signal!, 'abort').length, 1);
      if (beforeAbort) { Object.defineProperty(controller.signal, 'aborted', { value: false }); if (composite) Object.defineProperty(supplied, 'aborted', { value: false }); }
      controller.abort('local-fixture');
      if (!beforeAbort) { Object.defineProperty(controller.signal, 'aborted', { value: false }); if (composite) Object.defineProperty(supplied, 'aborted', { value: false }); }
      assert.equal(controller.signal.aborted, false); assert.equal(selected.signal!.aborted, true);
    } finally { selected.releaseSignal(); selected.releaseSignal(); assert.equal(getEventListeners(selected.signal!, 'abort').length, 0); }
  }
  const controller = new AbortController(); controller.abort(); const selected = validateArchivedChildDocumentStorageRequest({ ...request(), signal: controller.signal });
  try { assert.equal(selected.signal!.aborted, true); } finally { selected.releaseSignal(); }
});

test('a completed operation can idempotently release its active cancellation observer without retaining caller listeners', () => {
  const controller = new AbortController(), selected = validateArchivedChildDocumentStorageRequest({ ...request(), signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assert.equal(getEventListeners(selected.signal!, 'abort').length, 1);
  selected.releaseSignal(); selected.releaseSignal(); assert.equal(getEventListeners(selected.signal!, 'abort').length, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('verified report includes exact detached metadata samples with no raw paths, content, refs, record or authority activation', () => {
  const source = input(), report = buildArchivedChildDocumentStorageReport(source), expected = source.observations[0]!.index!.refs.map(({ sessionId: _session, workspaceId: _workspace, ...ref }) => ref);
  assert.deepEqual(report.children[0]!.documents, expected); assert.equal(report.complete, true); assert.equal(report.children[0]!.documentCount, 3); assert.equal(report.children[0]!.documentsOmitted, 0); assert.equal(report.declaredReferenceBytes.children, 129);
  source.observations[0]!.index!.refs[0]!.sha256 = 'b'.repeat(64); source.stats.selectedMetadataBytes = 1; source.observations[0]!.lineage!.parentRunId = 'changed';
  assert.equal(report.children[0]!.documents[0]!.sha256, '0'.repeat(64)); assert.equal(report.stats.selectedMetadataBytes, 1024); assert.equal(report.children[0]!.lineage!.parentRunId, 'root-run');
  const serialized = JSON.stringify(report); assert.equal(serialized.includes('/private/source-workspace-not-returned'), false); assert.equal(serialized.includes('workspaceRoot'), false); assert.equal(serialized.includes('"refs"'), false);
  assert.equal(report.coverage.cleanup, 'not-performed'); assert.equal(report.coverage.executionAuthority, 'not-granted'); assert.equal(report.physicalRebinding, false); assert.equal(report.recoveryAcknowledgmentsRebound, false); assert.equal(report.executionResumed, false);
});

test('selected complete remains independent of partial archive coverage and whole-proof child statistics', () => {
  const source = input([observed(1, 0)]); source.archiveDocumentAuditCoverage = 'partial'; source.stats.openedChildren = 11; source.limits = { ...source.limits, maxChildren: 1 };
  const report = buildArchivedChildDocumentStorageReport(source);
  assert.equal(report.complete, true); assert.equal(report.archiveCoverage, 'partial'); assert.equal(report.stats.openedChildren, 11); assert.equal(report.requestedChildren, 1); assert.equal(report.statsScope, 'whole-archive-proof-frame'); assert.equal(report.coverage.requestedTaskCap, 1); assert.equal(report.coverage.wholeArchiveChildProofCap, 32);
});

test('sample cap follows exact request order even when collected observations are reversed', () => {
  const source = input([observed(2, 2), observed(1, 2)]); source.requestedTaskIds = [taskId(1), taskId(2)]; source.limits = { ...source.limits, maxDocumentSamples: 1 };
  const report = buildArchivedChildDocumentStorageReport(source);
  assert.deepEqual(report.children.map(item => item.taskId), [taskId(1), taskId(2)]); assert.equal(report.children[0]!.documents.length, 1); assert.equal(report.children[1]!.documents.length, 0); assert.equal(report.documentsOmitted, 3); assert.equal(report.complete, false); assert.ok(report.reasons.includes('document-sample-limit')); assert.equal(report.declaredReferenceBytes.children, 170);
});

test('counts-only report preserves known totals and explicitly omitted document samples', () => {
  const source = input(); source.limits = { ...source.limits, maxDocumentSamples: 0 };
  const report = buildArchivedChildDocumentStorageReport(source);
  assert.deepEqual(report.children[0]!.documents, []); assert.equal(report.children[0]!.documentCount, 3); assert.equal(report.children[0]!.countsKnown, true); assert.equal(report.documentsOmitted, 3); assert.equal(report.complete, false); assert.equal(report.declaredReferenceBytes.children, 129);
});

test('unchecked/legacy/external and incomplete observations preserve null unknown totals with a separate known subtotal', () => {
  const source = input([observed(1, 1, false), { taskId: taskId(2), status: 'unchecked', reason: 'legacy-unbound' }, { taskId: taskId(3), status: 'unchecked', reason: 'external-child-storage' }]);
  const report = buildArchivedChildDocumentStorageReport(source);
  assert.equal(report.complete, false); assert.equal(report.uncheckedChildren, 2); assert.equal(report.children[0]!.declaredBytes, null); assert.equal(report.children[0]!.documentCount, null); assert.equal(report.children[0]!.countsKnown, false); assert.equal(report.children[1]!.documentsOmitted, null); assert.equal(report.declaredReferenceBytes.children, null); assert.equal(report.declaredReferenceBytes.observedChildSubtotal, 42); assert.equal(report.documentsOmitted, null);
});

test('missing selected observation is unchecked and unexpected/duplicate/cross-owner observations fail closed', () => {
  const missing = input([]); missing.requestedTaskIds = [taskId(1)]; assert.equal(buildArchivedChildDocumentStorageReport(missing).children[0]!.status, 'unchecked');
  const foreign = input(); foreign.observations[0]!.index!.refs[0]!.sessionId = 'foreign';
  const duplicate = input([observed(), observed()]); duplicate.requestedTaskIds = [taskId(1)];
  const wrongTask = input(); wrongTask.requestedTaskIds = [taskId(2)];
  const lineage = input(); lineage.observations[0]!.lineage!.rootRunId = 'foreign-run';
  for (const source of [foreign, duplicate, wrongTask, lineage]) assert.throws(() => buildArchivedChildDocumentStorageReport(source), code('ARCHIVE_CHILD_REPORT_INVALID'));
  const stale = input(); stale.expectedManifestSha256 = 'b'.repeat(64); assert.throws(() => buildArchivedChildDocumentStorageReport(stale), code('ARCHIVE_MANIFEST_SHA_MISMATCH'));
});

test('report byte cap trims metadata samples before details without rewriting count/known subtotal', () => {
  const source = input([observed(1, 32)]); source.limits = { ...source.limits, maxDocumentSamples: 128, maxReportBytes: 4096 };
  const report = buildArchivedChildDocumentStorageReport(source);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 4096); assert.equal(report.reportsOmitted, 0); assert.ok(report.children[0]!.documents.length < 32); assert.equal(report.children[0]!.documentCount, 32); assert.equal(report.children[0]!.documentsOmitted, 32 - report.children[0]!.documents.length); assert.equal(report.complete, false); assert.ok(report.reasons.includes('report-byte-limit')); assert.equal(report.declaredReferenceBytes.children, source.observations[0]!.index!.declaredBytes);
});

test('detail omission is explicit, counts still describe all requested tasks, and raw report secrets are rejected', () => {
  const observations = Array.from({ length: 32 }, (_, n) => ({ taskId: taskId(n), status: 'unchecked' as const, reasons: Array.from({ length: 8 }, (_, i) => `reason_${i}_` + 'a'.repeat(90)) }));
  const source = input(observations); source.limits = { ...source.limits, maxChildren: 32, maxReportBytes: 4096 };
  const report = buildArchivedChildDocumentStorageReport(source);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 4096); assert.ok(report.reportsOmitted > 0); assert.equal(report.uncheckedChildren, 32); assert.equal(report.requestedChildren, 32); assert.equal(report.declaredReferenceBytes.children, null); assert.equal(report.complete, false);
  const unsafe = input(); Object.assign(unsafe.observations[0]!, { record: { credential: 'not-returned' } }); assert.throws(() => buildArchivedChildDocumentStorageReport(unsafe), code('ARCHIVE_CHILD_REPORT_INVALID'));
  const credentialReason = input([{ taskId: taskId(1), status: 'unchecked', reason: 'Authorization: private' }]); assert.throws(() => buildArchivedChildDocumentStorageReport(credentialReason), code('ARCHIVE_CHILD_REPORT_INVALID'));
});

test('report input/accessor/ref traps and proof counter overruns reject without invoking supplied code', () => {
  let traps = 0; const getter = input(); Object.defineProperty(getter, 'stats', { enumerable: true, get() { traps++; throw new Error('private'); } });
  const proxy = new Proxy(input(), { ownKeys() { traps++; throw new Error('private'); } });
  const refGetter = input(); Object.defineProperty(refGetter.observations[0]!.index!.refs[0], 'sha256', { enumerable: true, get() { traps++; return 'b'.repeat(64); } });
  const statusCoercion = input(); Object.assign(statusCoercion.observations[0]!, { status: { toString() { traps++; return 'observed'; } } });
  const coverageCoercion = input(); Object.assign(coverageCoercion, { archiveDocumentAuditCoverage: { [Symbol.toPrimitive]() { traps++; return 'complete'; } } });
  for (const source of [getter, proxy, refGetter, statusCoercion, coverageCoercion]) assert.throws(() => buildArchivedChildDocumentStorageReport(source), code('ARCHIVE_CHILD_REPORT_INVALID')); assert.equal(traps, 0);
  const rows = input(); rows.stats.selectedRows = 8193; assert.throws(() => buildArchivedChildDocumentStorageReport(rows), code('ARCHIVE_CHILD_REPORT_INVALID'));
  const refs = input([observed(1, 2), observed(2, 2)]); refs.limits = { ...refs.limits, maxRefs: 3 }; assert.throws(() => buildArchivedChildDocumentStorageReport(refs), code('ARCHIVE_CHILD_REPORT_INVALID'));
});
