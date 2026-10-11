import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { assertInTransaction, casReplace, guardedWrite, type GuardedWriteOptions, type WriteTransactionPort } from './transaction.js';

const raise = (name: string) => (): never => { throw new Error(name); };
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE knowledge_generations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL)');
  let calls = 0;
  const port: WriteTransactionPort & { calls: () => number } = {
    calls: () => calls,
    writeTx<T>(operation: () => T): T { calls++; db.exec('BEGIN'); try { const result = operation(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
  return { db, port };
}
const strict: GuardedWriteOptions = { join: false, innerAsyncCheck: true, required: raise('required') };

test('guarded writes enter the host transaction exactly once and synchronously', t => {
  const { db, port } = fixture(t);
  assert.equal(guardedWrite(db, port, () => db.isTransaction, strict), true); assert.equal(port.calls(), 1);
  const detached = { ...strict, detached: raise('detached') };
  assert.throws(() => guardedWrite(db, { writeTx: () => undefined as never }, () => 1, detached), /detached/u);
  assert.throws(() => guardedWrite(db, { writeTx: operation => operation() }, () => 1, detached), /required/u);
  assert.throws(() => guardedWrite(db, { writeTx: operation => port.writeTx(() => { operation(); return operation(); }) }, () => 1, detached), /required/u);
  const swallowed = <T>(operation: () => T): T => { try { return operation(); } catch { return 'forged' as T; } };
  assert.throws(() => guardedWrite(db, { writeTx: swallowed }, () => 'written', detached), /detached/u);
  assert.throws(() => guardedWrite(db, { writeTx: operation => port.writeTx(() => { operation(); return swallowed(operation); }) }, () => 'written', detached), /detached/u);
  assert.throws(() => guardedWrite(db, port, () => Promise.resolve(1), { ...detached, async: raise('async') }), /async/u);
  assert.equal(db.isTransaction, false);
  assert.throws(() => guardedWrite(db, port, () => Promise.resolve(1), { ...detached, innerAsyncCheck: false }), /detached/u);
  const asyncResult = { ...detached, innerAsyncCheck: false, asyncResult: raise('asyncResult') };
  assert.throws(() => guardedWrite(db, port, () => Promise.resolve(1), asyncResult), /asyncResult/u);
  assert.throws(() => guardedWrite(db, { writeTx: () => Promise.resolve(1) as never }, () => 1, asyncResult), /detached/u);
  const lazy = { then: 'not callable' };
  assert.throws(() => guardedWrite(db, port, () => lazy, strict), /required/u);
  assert.equal(guardedWrite(db, port, () => lazy, { ...strict, isThenable: value => typeof Reflect.get(Object(value), 'then') === 'function' }), lazy);
});

test('only joining modules run inline inside a caller transaction', t => {
  const { db, port } = fixture(t);
  port.writeTx(() => {
    assert.equal(guardedWrite(db, port, () => 'joined', { ...strict, join: true }), 'joined'); assert.equal(port.calls(), 1);
    assert.throws(() => guardedWrite(db, port, () => 'nested', strict), /cannot start a transaction within a transaction/u);
    assert.doesNotThrow(() => assertInTransaction(db, raise('outside')));
  });
  assert.throws(() => assertInTransaction(db, raise('outside')), /outside/u);
});

test('CAS replace keeps each store statement and fails stale on any fence mismatch', t => {
  const { db } = fixture(t), statements: string[] = [], prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => { statements.push(sql); return prepare(sql); }) as typeof db.prepare;
  const previous = { id: 'generation', workspaceId: 'workspace', state: 'running', revision: 1 }, next = { ...previous, state: 'completed', revision: 2 };
  db.prepare('INSERT INTO knowledge_generations VALUES(?,?,?,?,?)').run(previous.id, previous.workspaceId, previous.state, previous.revision, JSON.stringify(previous));
  const update = (record: typeof next, prior: object | undefined, revision: number) => casReplace(db, { table: 'knowledge_generations', set: { state: record.state, revision: record.revision },
    key: { id: record.id, workspace_id: record.workspaceId }, fence: { revision }, previous: prior }, record, raise('stale'));
  update(next, previous, 1);
  assert.equal(statements.at(-1), 'UPDATE knowledge_generations SET state=?,revision=?,data=? WHERE id=? AND workspace_id=? AND revision=? AND data=?');
  assert.equal(db.prepare('SELECT data FROM knowledge_generations').get()!.data, JSON.stringify(next));
  assert.throws(() => update({ ...next, revision: 3 }, previous, 2), /stale/u);
  assert.throws(() => update({ ...next, revision: 3 }, next, 1), /stale/u);
  update({ ...next, revision: 3 }, undefined, 2);
  assert.equal(statements.at(-1), 'UPDATE knowledge_generations SET state=?,revision=?,data=? WHERE id=? AND workspace_id=? AND revision=?');
  assert.equal(JSON.parse(String(db.prepare('SELECT data FROM knowledge_generations').get()!.data)).revision, 3);
  const count = statements.length;
  for (const invalid of [{ table: 'sqlite_master' }, { key: {} }, { set: { data: '{}' } }, { fence: { 'revision=revision OR 1': 1 } }])
    assert.throws(() => casReplace(db, { table: 'knowledge_generations', set: {}, key: { id: 'generation' }, fence: {}, ...invalid }, next, raise('stale')), TypeError);
  assert.equal(statements.length, count);
});
