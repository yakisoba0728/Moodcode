import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { SqliteStore } from './index.js';
import { DATABASE_MIGRATIONS, databaseVersion, DB_VERSION, migrateDatabase, type DatabaseMigration } from './migrations.js';
import { databaseContents, restoreFrozenDatabase } from './fixtures/v1-fixture.js';
import { V1_DATABASE_FIXTURE } from './fixtures/v1-database.js';

const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-migration-'));
  const path = join(directory, 'engine.sqlite');
  restoreFrozenDatabase(path, V1_DATABASE_FIXTURE.primary, directory);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, db };
}
function next(apply: DatabaseMigration['apply'], version = 2): DatabaseMigration {
  return { version, name: `test-version-${version}`, apply };
}

test('initial migration remains v1 with Run-owned events and original SQLite constraints', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal(DB_VERSION, 1);
    assert.equal(Object.isFrozen(DATABASE_MIGRATIONS), true);
    migrateDatabase(db);
    assert.equal(databaseVersion(db), 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    const runId = db.prepare('PRAGMA table_info(events)').all().find(row => row.name === 'run_id');
    assert.equal(runId?.notnull, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_list(events)').all().some(row => row.from === 'run_id' && row.table === 'runs'), true);
    const before = databaseContents(db);
    migrateDatabase(db);
    assert.deepEqual(databaseContents(db), before);
  } finally { db.close(); }
});

test('existing v1 database is unchanged while consecutive migrations see the preceding version', t => {
  const { db } = fixture(t), versions: number[] = [];
  const oldRows = db.prepare('SELECT * FROM events ORDER BY seq').all();
  const plan = [...DATABASE_MIGRATIONS,
    next(database => { versions.push(databaseVersion(database, 3)); database.exec('CREATE TABLE future_projection(id TEXT PRIMARY KEY) STRICT'); }),
    next(database => { versions.push(databaseVersion(database, 3)); database.exec('ALTER TABLE future_projection ADD COLUMN detail TEXT'); }, 3),
  ];
  migrateDatabase(db, plan);
  assert.deepEqual(versions, [1, 2]);
  assert.equal(databaseVersion(db, 3), 3);
  assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY seq').all(), oldRows);
  assert.equal(db.prepare('PRAGMA table_info(future_projection)').all().some(row => row.name === 'detail'), true);
  migrateDatabase(db, plan);
  assert.deepEqual(versions, [1, 2], 'Already applied migrations cannot run again');
});

test('failure in a later migration rolls back all pending schema, record and user_version changes', t => {
  const { db } = fixture(t), before = databaseContents(db);
  const failure = new Error('intentional later migration failure');
  const plan = [...DATABASE_MIGRATIONS,
    next(database => { database.exec("CREATE TABLE future_projection(id TEXT); UPDATE sessions SET last_seq=999"); }),
    next(database => { database.exec("UPDATE approvals SET data='{}'"); throw failure; }, 3),
  ];
  assert.throws(() => migrateDatabase(db, plan), error => error === failure);
  assert.deepEqual(databaseContents(db), before);
  assert.equal(db.isTransaction, false);
  migrateDatabase(db, [...DATABASE_MIGRATIONS, next(database => { database.exec('CREATE TABLE future_projection(id TEXT)'); })]);
  assert.equal(databaseVersion(db, 2), 2, 'The rolled back version can be applied successfully later');
});

test('deferred foreign key violations reject migration before commit and restore the previous database', t => {
  const { db } = fixture(t), before = databaseContents(db);
  const plan = [...DATABASE_MIGRATIONS, next(database => {
    database.exec("CREATE TABLE future_binding(workspace_id TEXT REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED) STRICT; INSERT INTO future_binding VALUES('absent-workspace')");
  })];
  assert.throws(() => migrateDatabase(db, plan), hasCode('DB_INTEGRITY_FAILED'));
  assert.deepEqual(databaseContents(db), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('gaps, duplicate versions and invalid names fail before any migration SQL', t => {
  const { db } = fixture(t), before = databaseContents(db);
  let called = false;
  for (const bad of [next(() => { called = true; }, 3), { ...next(() => { called = true; }), version: 1 }, { ...next(() => { called = true; }), name: '' }]) {
    assert.throws(() => migrateDatabase(db, [...DATABASE_MIGRATIONS, bad]), hasCode('DB_MIGRATION_PLAN_INVALID'));
  }
  assert.equal(called, false);
  assert.deepEqual(databaseContents(db), before);
});

test('migration refuses disabled foreign keys and leaves an existing caller transaction alone', t => {
  const { db } = fixture(t), before = databaseContents(db);
  const plan = [...DATABASE_MIGRATIONS, next(database => { database.exec('CREATE TABLE future_projection(id TEXT)'); })];
  db.exec('PRAGMA foreign_keys=OFF');
  assert.throws(() => migrateDatabase(db, plan), hasCode('DB_MIGRATION_FOREIGN_KEYS_DISABLED'));
  assert.deepEqual(databaseContents(db), before);
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  assert.throws(() => migrateDatabase(db, plan), hasCode('DB_MIGRATION_TRANSACTION_ACTIVE'));
  assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
  assert.deepEqual(databaseContents(db), before);
});

test('future version is rejected before mutation and failed constructor releases ownership', t => {
  const { path, db } = fixture(t);
  db.exec('PRAGMA user_version=99');
  const before = readFileSync(path);
  assert.throws(() => migrateDatabase(db), hasCode('DB_VERSION_UNSUPPORTED'));
  assert.deepEqual(readFileSync(path), before);
  assert.throws(() => new SqliteStore(path), hasCode('DB_VERSION_UNSUPPORTED'));
  assert.throws(() => new SqliteStore(path), hasCode('DB_VERSION_UNSUPPORTED'));
  assert.deepEqual(readFileSync(path), before);
  db.exec('PRAGMA user_version=1');
  const store = new SqliteStore(path);
  try { assert.equal(store.getRun(V1_DATABASE_FIXTURE.ids.terminalRunId).state, 'completed'); }
  finally { store.close(); }
});

test('failed initial schema creation rolls back partial tables and permits a later owner', t => {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-initial-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'engine.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE approvals(sentinel TEXT)');
  db.close();
  assert.throws(() => new SqliteStore(path), /approvals already exists/);
  const inspect = new DatabaseSync(path);
  try {
    assert.equal(databaseVersion(inspect), 0);
    assert.deepEqual(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['approvals']);
    inspect.exec('DROP TABLE approvals');
  } finally { inspect.close(); }
  const store = new SqliteStore(path);
  try { assert.deepEqual(store.listWorkspaces(), []); }
  finally { store.close(); }
});
