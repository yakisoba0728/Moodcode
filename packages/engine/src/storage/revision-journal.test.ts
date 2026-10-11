import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { canonicalSha256, sealRecord, verifySealed } from '../shared/canonical.js';
import { assertOnlyChanged, assertRevisionLink, createRevisionJournal, type JournalReceipt, type JournalRecord, type RevisionJournalProfile } from './revision-journal.js';

interface Toy extends JournalRecord<'toy'> { readonly owner: string; readonly value: number }
type Input = { workspaceId: string; requestId: string; expectedRevision: number; value: number };
const raise = (code = 'TOY_INVALID'): never => { throw Object.assign(new Error(code), { code }); };
const code = (name: string) => (error: unknown) => (error as { code?: string }).code === name;
const profile: RevisionJournalProfile<'toy', Toy> = {
  revisions: 'toy_revisions', heads: 'toy_heads', columns: ['owner'],
  limits: { rowBytes: 4096, rows: 8, bytes: 65536, kinds: { toy: 2 } },
  index: (record, receipt) => ({ owner: receipt ? null : record.owner }),
  scope: (kind, entityId, operation) => ({ record: `${kind}:${entityId}:${operation}`, receipt: `receipt:${kind}:${entityId}:${operation}` }),
  receiptPrevious: before => before?.id ?? null,
  identifier: value => typeof value === 'string' && value ? value : raise('TOY_INPUT'),
  sealed: value => verifySealed(structuredClone(value), raise),
  verify: record => { if (typeof record.value !== 'number') raise(); },
  fail: raise,
  codes: { limit: 'TOY_LIMIT', revisionConflict: 'TOY_REVISION_CONFLICT', requestConflict: 'TOY_REQUEST_CONFLICT' },
};
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE toy_revisions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,revision INTEGER NOT NULL,previous_id TEXT,owner TEXT,
    request_scope TEXT NOT NULL,request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,sha256 TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(workspace_id,request_scope,request_id)) STRICT;
    CREATE TABLE toy_heads(workspace_id TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,revision_id TEXT NOT NULL,revision INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(workspace_id,kind,entity_id)) STRICT`);
  const journal = createRevisionJournal<'toy', Toy, JournalReceipt<'toy'>>(db, profile);
  let builds = 0;
  const entry = (entityId: string, operation: string, input: Input, before: Toy | undefined, administrative = false) => ({
    kind: 'toy' as const, before, expectedRevision: input.expectedRevision,
    build(revisionId: string, receiptId: string) {
      builds++;
      const record = sealRecord({ id: revisionId, kind: 'toy' as const, entityId, workspaceId: input.workspaceId, revision: (before?.revision ?? 0) + 1, previousId: before?.id ?? null,
        lastReceiptId: receiptId, createdAt: '2030-01-01T00:00:00.000Z', owner: 'owner-1', value: input.value });
      const receipt = sealRecord({ id: receiptId, workspaceId: input.workspaceId, kind: 'toy' as const, entityId, operation, beforeRevisionId: before?.id ?? null, afterRevisionId: revisionId,
        afterSha256: record.sha256, requestId: input.requestId, requestSha256: canonicalSha256(input), requestInput: input, createdAt: record.createdAt });
      return { record, receipt };
    },
    ...(administrative ? {} : { reserve: () => ({ rows: 0, bytes: 0 }) }),
  });
  return { db, journal, entry, builds: () => builds };
}

test('journal pairs carry their scopes, index columns and receipt link, move heads from the fence and replay requests', t => {
  const { db, journal, entry } = fixture(t);
  const create: Input = { workspaceId: 'ws', requestId: 'create', expectedRevision: 0, value: 1 };
  const first = journal.append(entry('a', 'create', create, undefined));
  const update: Input = { workspaceId: 'ws', requestId: 'update', expectedRevision: 1, value: 2 };
  const second = journal.append(entry('a', 'update', update, first.record));
  assert.deepEqual(journal.head('ws', 'toy', 'a'), second.record);
  assert.deepEqual(journal.read('ws', first.record.id, 'toy'), first.record);
  assert.deepEqual(db.prepare('SELECT id,kind,previous_id,owner,request_scope FROM toy_revisions ORDER BY revision,kind').all().map(row => ({ ...row })), [
    { id: first.record.id, kind: 'toy', previous_id: null, owner: 'owner-1', request_scope: 'toy:a:create' },
    { id: first.receipt.id, kind: 'transition', previous_id: null, owner: null, request_scope: 'receipt:toy:a:create' },
    { id: second.record.id, kind: 'toy', previous_id: first.record.id, owner: 'owner-1', request_scope: 'toy:a:update' },
    { id: second.receipt.id, kind: 'transition', previous_id: first.record.id, owner: null, request_scope: 'receipt:toy:a:update' },
  ]);
  assert.deepEqual(journal.replay('ws', 'toy', 'a', 'update', update), second);
  assert.equal(journal.replay('ws', 'toy', 'a', 'update', { ...update, requestId: 'other' }), undefined);
  const changed: Input = { ...update, value: 3 };
  assert.throws(() => journal.replay('ws', 'toy', 'a', 'update', changed), code('TOY_REQUEST_CONFLICT'));
  assert.throws(() => journal.append(entry('a', 'update', { ...update, requestId: 'stale', expectedRevision: 0 }, first.record)), code('TOY_REVISION_CONFLICT'));
  db.exec('BEGIN');
  assert.throws(() => journal.append(entry('a', 'update', { ...update, requestId: 'raced' }, first.record)), code('TOY_REVISION_CONFLICT'));
  db.exec('ROLLBACK');
  const graph = journal.scan();
  for (const record of graph.records.values()) { journal.receiptOf(record, graph); journal.previousOf(record, graph); }
  journal.assertHeads(graph);
  assert.deepEqual(journal.list('ws', 'toy', 2), [second.record]);
  assert.deepEqual(journal.current('ws'), [second.record]);
});

test('journal bounds refuse writes before building them and its graph rejects drifted columns and heads', t => {
  const { db, journal, entry, builds } = fixture(t);
  const input = (requestId: string, expectedRevision = 0): Input => ({ workspaceId: 'ws', requestId, expectedRevision, value: 1 });
  const a = journal.append(entry('a', 'create', input('a'), undefined));
  journal.append(entry('b', 'create', input('b'), undefined));
  assert.throws(() => journal.append(entry('c', 'create', input('c'), undefined)), code('TOY_LIMIT'));
  const b2 = journal.append(entry('a', 'update', input('a2', 1), a.record));
  journal.append(entry('a', 'update', input('a3', 2), b2.record));
  const built = builds();
  assert.throws(() => journal.append(entry('a', 'update', input('a4', 3), journal.head('ws', 'toy', 'a'), true)), code('TOY_LIMIT'));
  assert.equal(builds(), built);
  db.prepare("UPDATE toy_revisions SET owner='drifted' WHERE id=?").run(a.record.id);
  assert.throws(() => journal.scan(), code('TOY_INVALID'));
  db.prepare("UPDATE toy_revisions SET owner='owner-1' WHERE id=?").run(a.record.id);
  db.prepare("UPDATE toy_heads SET revision_id=?,revision=1,sha256=? WHERE entity_id='a'").run(a.record.id, a.record.sha256);
  assert.throws(() => journal.assertHeads(journal.scan()), code('TOY_INVALID'));
  assert.throws(() => journal.head('ws', 'toy', 'a'), code('TOY_INVALID'));
});

test('transition guards fail with the module code on unlinked revisions and on added or removed immutable keys', () => {
  const fail = () => raise('TRANSITION');
  const before = { id: 'r1', kind: 'toy', entityId: 'a', workspaceId: 'ws', revision: 1, previousId: null, lastReceiptId: 't1', createdAt: 'now', sha256: 'x' };
  assert.doesNotThrow(() => assertRevisionLink(before, { ...before, id: 'r2', revision: 2, previousId: 'r1' }, fail));
  assert.throws(() => assertRevisionLink(before, { ...before, id: 'r2', revision: 3, previousId: 'r1' }, fail), code('TRANSITION'));
  assert.throws(() => assertRevisionLink(before, { ...before, id: 'r2', revision: 2, previousId: 'r1', entityId: 'b' }, fail), code('TRANSITION'));
  assert.doesNotThrow(() => assertOnlyChanged({ state: 'a', spec: { x: 1 } }, { spec: { x: 1 }, state: 'b' }, ['state'], fail));
  assert.throws(() => assertOnlyChanged({ state: 'a', spec: { x: 1 } }, { state: 'a', spec: { x: 2 } }, ['state'], fail), code('TRANSITION'));
  assert.throws(() => assertOnlyChanged({ state: 'a', permission: null }, { state: 'a' }, ['state'], fail), code('TRANSITION'));
  assert.throws(() => assertOnlyChanged({ state: 'a' }, { state: 'a', controls: [] }, ['state'], fail), code('TRANSITION'));
  assert.doesNotThrow(() => assertOnlyChanged({ state: 'a' }, { state: 'a', controls: [] }, ['controls'], fail));
});
