import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { EVIDENCE_READ_LIMITS, hasEvidenceRead, invalidateEvidenceRead, readEvidenceBody, withEvidenceRead } from './evidence-read.js';

const code = (name: string) => (error: unknown) => error instanceof EngineError && error.code === `RECOVERY_EVIDENCE_${name}`;
function fixture(t: TestContext, path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,data TEXT NOT NULL);
    CREATE TABLE summary_attempts(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE context_revisions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE session_documents(session_id TEXT,kind TEXT,data TEXT,PRIMARY KEY(session_id,kind));`);
  db.prepare('INSERT INTO messages VALUES(?,?,?)').run('message','session',JSON.stringify({ text: 'original' }));
  const prepare = db.prepare.bind(db), bodies: string[] = [];
  db.prepare = ((sql: string) => { if (/^SELECT (?:data FROM|json_remove\()/u.test(sql)) bodies.push(sql); return prepare(sql); }) as typeof db.prepare;
  t.after(() => db.close());
  const read = (maxBytes = 1024, expectedBytes?: number) => readEvidenceBody(db, { table: 'messages', key: 'message' }, { maxBytes, ...(expectedBytes === undefined ? {} : { expectedBytes }) });
  function transaction<T>(operation: () => T) { db.exec('BEGIN'); try { const result = withEvidenceRead(db, operation); db.exec('COMMIT'); return result; } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; } }
  return { db, bodies, read, transaction };
}

test('one real transaction shares raw strings across nested scopes without sharing mutable parsed objects', t => {
  const f = fixture(t);
  assert.equal(hasEvidenceRead(f.db), false); assert.throws(() => withEvidenceRead(f.db, f.read), code('TRANSACTION_REQUIRED'));
  f.transaction(() => {
    assert.equal(hasEvidenceRead(f.db), true); const first = JSON.parse(f.read()!) as { text: string }; first.text = 'caller mutation';
    assert.equal(withEvidenceRead(f.db, () => JSON.parse(f.read()!).text), 'original'); assert.equal(f.bodies.length, 1);
  });
  assert.equal(hasEvidenceRead(f.db), false); f.transaction(f.read); assert.equal(f.bodies.length, 2);
});

test('outside a scope reads remain locally bounded and are never cached', t => {
  const f = fixture(t); assert.equal(f.read(), f.read()); assert.equal(f.bodies.length, 2);
  assert.throws(() => f.read(1), code('LIMIT')); assert.equal(f.bodies.length, 2); assert.equal(hasEvidenceRead(f.db), false);
  assert.equal(readEvidenceBody(f.db, { table: 'messages', key: 'missing' }, { maxBytes: 1024 }), undefined);
});

test('aggregate selected bytes span different tables and cannot be reset by nested scopes', t => {
  const f = fixture(t), chunk = 'x'.repeat(1_048_576);
  for (let index = 0; index < 8; index++) f.db.prepare('INSERT INTO messages VALUES(?,?,?)').run('large-' + index,'session',chunk);
  f.db.prepare('INSERT INTO summary_attempts VALUES(?,?)').run('summary','{}');
  assert.throws(() => f.transaction(() => {
    for (let index = 0; index < 8; index++) withEvidenceRead(f.db, () => readEvidenceBody(f.db, { table: 'messages', key: 'large-' + index }, { maxBytes: chunk.length, expectedBytes: chunk.length }));
    try { readEvidenceBody(f.db, { table: 'summary_attempts', key: 'summary' }, { maxBytes: 1024 }); } catch (error) { assert.ok(code('LIMIT')(error)); }
    return false;
  }), code('LIMIT'));
  assert.equal(f.bodies.length, 8); assert.equal(hasEvidenceRead(f.db), false);
});

test('cache entry bound is independent from its aggregate byte bound and stays sticky', t => {
  const f = fixture(t);
  for (let index = 0; index <= EVIDENCE_READ_LIMITS.maxCachedBodies; index++) f.db.prepare('INSERT INTO messages VALUES(?,?,?)').run('tiny-' + index,'session','{}');
  assert.throws(() => f.transaction(() => {
    for (let index = 0; index <= EVIDENCE_READ_LIMITS.maxCachedBodies; index++) readEvidenceBody(f.db, { table: 'messages', key: 'tiny-' + index }, { maxBytes: 2, expectedBytes: 2 });
  }), code('LIMIT')); assert.equal(f.bodies.length, EVIDENCE_READ_LIMITS.maxCachedBodies);
});

test('cache hits still enforce the caller local cap and expected metadata byte size', t => {
  const f = fixture(t);
  assert.throws(() => f.transaction(() => { f.read(); try { f.read(1); } catch {} return false; }), code('LIMIT'));
  assert.equal(f.bodies.length, 1);
  assert.throws(() => f.transaction(() => { f.read(); f.read(1024, 999); }), code('CHANGED'));
  assert.equal(f.bodies.length, 2);
});

test('same-byte updates, owner-only updates and delete/reinsert invalidate the actual raw cache', t => {
  const f = fixture(t);
  f.transaction(() => {
    const first = f.read()!;
    f.db.prepare("UPDATE messages SET data=? WHERE id='message'").run(JSON.stringify({ text: 'modified' }));
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(f.read()!)); assert.equal(JSON.parse(f.read()!).text, 'modified'); assert.equal(f.bodies.length, 2);
    f.db.prepare("UPDATE messages SET session_id='changed-owner' WHERE id='message'").run(); f.read(); assert.equal(f.bodies.length, 3);
    f.db.prepare("DELETE FROM messages WHERE id='message'").run(); f.db.prepare('INSERT INTO messages VALUES(?,?,?)').run('message','session',first);
    assert.equal(f.read(), first); assert.equal(f.bodies.length, 4);
  });
});

test('explicit and detected invalidation never refund already selected aggregate bytes', t => {
  const f = fixture(t), body = 'x'.repeat(EVIDENCE_READ_LIMITS.maxSelectedBytes);
  f.db.prepare("UPDATE messages SET data=? WHERE id='message'").run(body);
  assert.throws(() => f.transaction(() => {
    f.read(body.length); invalidateEvidenceRead(f.db);
    try { f.read(body.length); } catch {}
    return true;
  }), code('LIMIT')); assert.equal(f.bodies.length, 1);
  assert.throws(() => f.transaction(() => {
    f.read(body.length); f.db.prepare("UPDATE messages SET session_id='other' WHERE id='message'").run(); f.read(body.length);
  }), code('LIMIT')); assert.equal(f.bodies.length, 2);
});

test('rollback and exceptions dispose the frame before a subsequent transaction', t => {
  const f = fixture(t);
  assert.throws(() => f.transaction(() => { f.read(); f.db.prepare("UPDATE messages SET data=? WHERE id='message'").run('{"text":"rolled back"}'); throw new Error('stop'); }), /stop/u);
  assert.equal(hasEvidenceRead(f.db), false); assert.equal(JSON.parse(f.transaction(f.read)!).text, 'original'); assert.equal(f.bodies.length, 2);
});

test('COMMIT/BEGIN with an external same-size update cannot reuse the earlier snapshot body', t => {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-evidence-epoch-')); t.after(() => rmSync(directory,{recursive:true,force:true}));
  const path = join(directory,'evidence.sqlite'), f = fixture(t,path), external = new DatabaseSync(path); t.after(() => external.close());
  f.db.exec('BEGIN');
  withEvidenceRead(f.db, () => {
    const first = f.read()!; f.db.exec('COMMIT'); external.prepare("UPDATE messages SET data=? WHERE id='message'").run('{"text":"modified"}'); f.db.exec('BEGIN');
    const next = f.read()!; assert.equal(Buffer.byteLength(first),Buffer.byteLength(next)); assert.equal(JSON.parse(next).text,'modified'); assert.equal(f.bodies.length,2);
  }); f.db.exec('COMMIT'); assert.equal(hasEvidenceRead(f.db),false);
});

test('summary text-free projection uses distinct bounded cache keys and context owner projection is rejected', t => {
  const f = fixture(t), summary = { id:'summary',state:'uncertain',partialText:'private-partial'.repeat(4096) };
  f.db.prepare('INSERT INTO summary_attempts VALUES(?,?)').run('summary',JSON.stringify(summary));
  f.db.prepare('INSERT INTO context_revisions VALUES(?,?)').run('context',JSON.stringify({id:'context',sessionId:'session',runId:'run',text:'large-context'.repeat(4096)}));
  f.db.prepare('INSERT INTO session_documents VALUES(?,?,?)').run('session','context.head','{"revisionId":"context"}');
  f.transaction(() => {
    const metadata = () => readEvidenceBody(f.db,{table:'summary_attempts',key:'summary',projection:'summary-metadata-v1'},{maxBytes:1024});
    assert.equal(JSON.parse(metadata()!).partialText,undefined); metadata(); assert.equal(f.bodies.length,1);
    const raw = readEvidenceBody(f.db,{table:'summary_attempts',key:'summary'},{maxBytes:1_048_576}); assert.equal(JSON.parse(raw!).partialText,summary.partialText); assert.equal(f.bodies.length,2);
    assert.throws(() => readEvidenceBody(f.db,{table:'context_revisions',key:'context',projection:'context-owner-v1'} as never,{maxBytes:1024}),code('INVALID_REQUEST')); assert.equal(f.bodies.length,2);
    assert.equal(readEvidenceBody(f.db,{table:'session_documents',key:['session','context.head']},{maxBytes:1024}),'{"revisionId":"context"}');
  });
});

test('invalid descriptors cannot invoke proxy/accessor hooks or generate arbitrary SQL', t => {
  const f = fixture(t); let traps = 0;
  const proxy = new Proxy({table:'messages',key:'message'},{getPrototypeOf(){traps++;throw new Error('trap');}});
  assert.throws(() => readEvidenceBody(f.db,proxy as never,{maxBytes:1024}),code('INVALID_REQUEST')); assert.equal(traps,0);
  assert.throws(() => readEvidenceBody(f.db,{table:'messages',get key(){traps++;return 'message';}} as never,{maxBytes:1024}),code('INVALID_REQUEST')); assert.equal(traps,0);
  assert.throws(() => readEvidenceBody(f.db,{table:'sqlite_master',key:'message'} as never,{maxBytes:1024}),code('INVALID_REQUEST'));
  assert.throws(() => readEvidenceBody(f.db,{table:'messages',key:'message',projection:{toString(){traps++;return 'data';}}} as never,{maxBytes:1024}),code('INVALID_REQUEST')); assert.equal(traps,0);
  const inherited = Object.create({table:'messages',key:'message'}) as never;
  assert.throws(() => readEvidenceBody(f.db,inherited,{maxBytes:1024}),code('INVALID_REQUEST'));
  const inheritedBounds = Object.create({maxBytes:1024}) as never;
  assert.throws(() => readEvidenceBody(f.db,{table:'messages',key:'message'},inheritedBounds),code('INVALID_REQUEST'));
  assert.throws(() => f.transaction(async () => 'forbidden'),code('INVALID_REQUEST'));
});

test('stale expected owner bytes cannot return a larger changed body to JavaScript', t => {
  const f = fixture(t), expected = Buffer.byteLength(f.read()!); let returnedBytes = 0;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/^SELECT data FROM messages/u.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = ((...parameters) => { const row = Reflect.apply(get, statement, parameters) as ReturnType<typeof statement.get>; if (typeof row?.data === 'string') returnedBytes += Buffer.byteLength(row.data); return row; }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  f.transaction(() => {
    f.db.prepare("UPDATE messages SET data=? WHERE id='message'").run('x'.repeat(EVIDENCE_READ_LIMITS.maxSelectedBytes + 1_048_576));
    assert.equal(f.read(1024,expected),undefined); assert.equal(returnedBytes,0);
  }); f.db.prepare = prepare;
});

test('a write between fresh length preflight and body SQL cannot bypass the byte guard', t => {
  const f = fixture(t), prepare = f.db.prepare.bind(f.db); let changed = false, returnedBytes = 0;
  f.db.prepare = ((sql: string) => {
    if (/^SELECT data FROM messages/u.test(sql) && !changed) {
      changed = true; prepare("UPDATE messages SET data=? WHERE id='message'").run('x'.repeat(EVIDENCE_READ_LIMITS.maxSelectedBytes + 1));
    }
    const statement = prepare(sql);
    if (/^SELECT data FROM messages/u.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = ((...parameters) => { const row = Reflect.apply(get, statement, parameters) as ReturnType<typeof statement.get>; if (typeof row?.data === 'string') returnedBytes += Buffer.byteLength(row.data); return row; }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  f.transaction(() => { assert.equal(f.read(),undefined); assert.equal(changed,true); assert.equal(returnedBytes,0); }); f.db.prepare = prepare;
});
