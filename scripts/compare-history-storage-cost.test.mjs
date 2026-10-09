import assert from 'node:assert/strict';
import test from 'node:test';
import { FIXTURE, compareResults, semanticNormalizer } from './compare-history-storage-cost.mjs';

test('independent normalization preserves opaque payload semantics while removing fixture identities', () => {
  const left = { root: '/private/fixture-a/file', id: '11111111-1111-4111-8111-111111111111', timestamp: '2026-10-09T00:00:00.000Z',
    opaque: { z: ['한국어', null, true, { id: '11111111-1111-4111-8111-111111111111' }], a: 'dummy-signature' } };
  const right = { ...left, root: '/private/fixture-b/file', id: '22222222-2222-4222-8222-222222222222', timestamp: '2026-10-09T01:00:00.000Z',
    opaque: { z: ['한국어', null, true, { id: '22222222-2222-4222-8222-222222222222' }], a: 'dummy-signature' } };
  assert.deepEqual(semanticNormalizer('/private/fixture-a')(left), semanticNormalizer('/private/fixture-b')(right));
  assert.equal(left.opaque.a, 'dummy-signature');
  assert.deepEqual(Object.keys(semanticNormalizer('/private/fixture-a')(left).opaque), ['z', 'a']);
  const altered = structuredClone(right); altered.opaque.a = 'changed-signature';
  assert.notDeepEqual(semanticNormalizer('/private/fixture-a')(left), semanticNormalizer('/private/fixture-b')(altered));
});

function result() {
  const counters = { sqlPrepareCalls: 20, sqlExecCalls: 8, sqlReadCalls: 14, sqlWriteCalls: 6, sqlReturnedRows: 28,
    sqlReturnedJsonUtf8Bytes: 1024, nativeRowWrites: 6, exactEventRecordCopies: 6, serializedUtf8Bytes: 4096, stringifyCalls: 30 };
  return { fixture: FIXTURE, fixtureSha256: 'fixture-hash', providerCalls: FIXTURE.runs,
    records: { schema: 23, tables: { session_events: { rows: 6, dataUtf8Bytes: 2048 } }, exactOrderedRowsSha256: 'exact', normalizedOrderedRowsSha256: 'semantic' },
    semantics: { modelSha256: 'model', publicHistorySha256: 'public', modelBytes: 10, publicHistoryBytes: 5 },
    archive: { exactOrderedRowsSha256: 'exact', normalizedOrderedRowsSha256: 'semantic', sourceRowsPreserved: true },
    writes: { ...counters, elapsedMs: 99 }, reads: { ...counters, elapsedMs: 4 } };
}

test('comparison measures serialization work without treating elapsed time as a threshold', () => {
  const baseline = result(), candidate = result();
  candidate.writes.stringifyCalls -= 2; candidate.writes.serializedUtf8Bytes -= 1024; candidate.writes.elapsedMs = 999;
  const compared = compareResults(baseline, candidate);
  assert.equal(compared.stringifyCallsSaved, 2); assert.equal(compared.serializedUtf8BytesSaved, 1024);
});

test('comparison rejects exact byte changes even when normalized semantics still agree', () => {
  const baseline = result(), candidate = result(); candidate.records.exactOrderedRowsSha256 = 'changed';
  assert.throws(() => compareResults(baseline, candidate), /Native counts, bytes/);
});

test('comparison rejects native write count or fixture input changes', () => {
  const baseline = result(), candidate = result(); candidate.writes.sqlWriteCalls++;
  assert.throws(() => compareResults(baseline, candidate), /sqlWriteCalls/);
  const changed = result(); changed.fixtureSha256 = 'different-payload';
  assert.throws(() => compareResults(baseline, changed), /different-payload/);
});
