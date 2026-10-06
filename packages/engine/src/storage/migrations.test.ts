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

const V1_MIGRATIONS = DATABASE_MIGRATIONS.slice(0, 1);
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
    assert.equal(DB_VERSION, DATABASE_MIGRATIONS.length);
    assert.equal(V1_MIGRATIONS[0]?.version, 1);
    assert.equal(Object.isFrozen(DATABASE_MIGRATIONS), true);
    migrateDatabase(db, V1_MIGRATIONS);
    assert.equal(databaseVersion(db), 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    const runId = db.prepare('PRAGMA table_info(events)').all().find(row => row.name === 'run_id');
    assert.equal(runId?.notnull, 1);
    assert.equal(db.prepare('PRAGMA foreign_key_list(events)').all().some(row => row.from === 'run_id' && row.table === 'runs'), true);
    const before = databaseContents(db);
    migrateDatabase(db, V1_MIGRATIONS);
    assert.deepEqual(databaseContents(db), before);
  } finally { db.close(); }
});

test('v1 to v2 to v3 preserves original records and installs durable usage and indexed role lookup without inventing observations',t=>{
  const {db}=fixture(t),legacy=db.prepare('SELECT * FROM events ORDER BY seq').all();
  db.exec('PRAGMA foreign_keys=ON');
  migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,2));
  const native=db.prepare('SELECT * FROM session_events ORDER BY session_id,seq').all();
  assert.equal(databaseVersion(db),2);
  migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,3));
  assert.equal(databaseVersion(db),3);
  assert.equal(db.prepare('SELECT count(*) AS count FROM attempt_usage').get()?.count,0);
  assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY seq').all(),legacy);
  assert.deepEqual(db.prepare('SELECT * FROM session_events ORDER BY session_id,seq').all(),native);
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT ordinal FROM messages WHERE run_id=? AND json_extract(data,'$.role')='user' ORDER BY ordinal DESC LIMIT 1").all('run');
  assert.ok(plan.some(row=>String(row.detail).includes('model_messages_role')));
});

test('failed v3 migration rolls back usage table/index and leaves v2 identity intact',t=>{
  const {db}=fixture(t);db.exec('PRAGMA foreign_keys=ON');
  migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,2));
  const before=databaseContents(db);
  const plan=[...DATABASE_MIGRATIONS.slice(0,2),{version:3,name:'intentional-v3-failure',apply:(database:DatabaseSync)=>{DATABASE_MIGRATIONS[2]!.apply(database);throw new Error('v3 rollback');}}];
  assert.throws(()=>migrateDatabase(db,plan),/v3 rollback/);
  assert.equal(databaseVersion(db),2);
  assert.deepEqual(databaseContents(db),before);
  migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,3));
  assert.equal(databaseVersion(db),3);
});

test('DB4 to DB5 preserves uncertain summary/usage and installs an empty decision ledger with indexed quarantine', t => {
  const { db } = fixture(t); db.exec('PRAGMA foreign_keys=ON');
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 4));
  const run = db.prepare('SELECT id,session_id,workspace_id,data FROM runs ORDER BY ordinal LIMIT 1').get()!;
  const owner = JSON.parse(String(run.data)) as { config: { providerId: string; modelId: string } };
  const summary = { id: 'db4-uncertain-summary', sessionId: run.session_id, workspaceId: run.workspace_id, runId: run.id,
    providerId: owner.config.providerId, modelId: owner.config.modelId, scope: 'completed-history', sourceProjection: 'conversation-text-v1',
    sourceSha256: '1'.repeat(64), requestSha256: '2'.repeat(64), requestBytes: 1024, expectedMemoryRevision: 0,
    schemaVersion: 2, revision: 3, state: 'uncertain', createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:01.000Z',
    completedAt: '2026-10-07T00:00:01.000Z', cleanupConfirmed: false, publication: 'discarded', observedOutputBytes: 7, retainedTextBytes: 7,
    partialText: 'partial', partialTextTruncated: false };
  db.prepare('INSERT INTO summary_attempts(id,session_id,workspace_id,run_id,scope,state,revision,data) VALUES(?,?,?,?,?,?,?,?)')
    .run(summary.id, run.session_id!, run.workspace_id!, run.id!, summary.scope, summary.state, summary.revision, JSON.stringify(summary));
  db.prepare('INSERT INTO summary_usage(summary_attempt_id,session_id,run_id,revision,data) VALUES(?,?,?,?,?)')
    .run(summary.id, run.session_id!, run.id!, 1, JSON.stringify({ summaryAttemptId: summary.id, usage: { inputTokens: 9, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null } }));
  const before = databaseContents(db);
  const failing = [...DATABASE_MIGRATIONS.slice(0, 4), { version: 5, name: 'intentional-v5-failure', apply(database: DatabaseSync) {
    DATABASE_MIGRATIONS[4]!.apply(database); throw new Error('DB5 rollback');
  } }];
  assert.throws(() => migrateDatabase(db, failing), /DB5 rollback/u); assert.equal(databaseVersion(db), 4); assert.deepEqual(databaseContents(db), before);
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 5)); assert.equal(databaseVersion(db), 5);
  assert.deepEqual(db.prepare('SELECT data FROM summary_attempts').all().map(row => String(row.data)), [JSON.stringify(summary)]);
  assert.equal(db.prepare('SELECT count(*) AS count FROM summary_usage').get()?.count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM summary_recovery_acknowledgments').get()?.count, 0);
  assert.ok(db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM summary_attempts WHERE workspace_id=? AND state='uncertain' LIMIT 1").all(run.workspace_id!).some(row => String(row.detail).includes('summary_workspace_uncertain')));
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('DB5 to DB6 preserves ordinary uncertainty and nullable observations without synthesizing cleanup proof', t => {
  const { db } = fixture(t); db.exec('PRAGMA foreign_keys=ON');
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 5));
  const run = db.prepare('SELECT id,session_id,workspace_id,data FROM runs ORDER BY ordinal LIMIT 1').get()!;
  const config = JSON.parse(String(run.data)).config as { providerId: string; modelId: string };
  const stamp = '2026-10-07T00:00:00.000Z', uncertainty = { kind: 'provider_dispatch', message: 'Historical response outcome remains unknown', requiresRecovery: true };
  const turn = { schemaVersion: 2, id: 'legacy-unknown-turn', sessionId: run.session_id, runId: run.id, inputIds: ['legacy-input'], index: 0, state: 'uncertain', createdAt: stamp, completedAt: stamp, uncertainty };
  const attempt = { schemaVersion: 2, id: 'legacy-unknown-attempt', sessionId: run.session_id, runId: run.id, turnId: turn.id, index: 0, providerId: config.providerId, modelId: config.modelId, state: 'uncertain', createdAt: stamp, dispatchedAt: stamp, completedAt: stamp, uncertainty };
  db.prepare('INSERT INTO session_turns(id,session_id,run_id,turn_index,state,data) VALUES(?,?,?,?,?,?)').run(turn.id, run.session_id!, run.id!, 0, turn.state, JSON.stringify(turn));
  db.prepare('INSERT INTO provider_attempts(id,session_id,run_id,turn_id,attempt_index,state,data) VALUES(?,?,?,?,?,?,?)').run(attempt.id, run.session_id!, run.id!, turn.id, 0, attempt.state, JSON.stringify(attempt));
  db.prepare('INSERT INTO attempt_usage(attempt_id,session_id,run_id,turn_id,revision,data) VALUES(?,?,?,?,?,?)').run(attempt.id, run.session_id!, run.id!, turn.id, 1, JSON.stringify({ attemptId: attempt.id, usage: { inputTokens: 17 } }));
  const tables = ['events','session_events','session_turns','provider_attempts','attempt_usage','messages','summary_attempts','summary_usage','summary_recovery_acknowledgments'];
  const rows = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const beforeRows = rows(), before = databaseContents(db);
  const failed = [...DATABASE_MIGRATIONS.slice(0, 5), { version: 6, name: 'intentional-v6-failure', apply(database: DatabaseSync) {
    DATABASE_MIGRATIONS[5]!.apply(database); throw new Error('DB6 rollback');
  } }];
  assert.throws(() => migrateDatabase(db, failed), /DB6 rollback/u);
  assert.equal(databaseVersion(db), 5); assert.deepEqual(databaseContents(db), before);
  migrateDatabase(db); assert.equal(databaseVersion(db), 6); assert.deepEqual(rows(), beforeRows);
  assert.equal(db.prepare('SELECT count(*) AS count FROM attempt_cleanup').get()?.count, 0);
  assert.ok(db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM provider_attempts a JOIN runs r ON r.id=a.run_id WHERE r.workspace_id=? AND a.state='uncertain' LIMIT 1").all(run.workspace_id!).some(row => String(row.detail).includes('ordinary_uncertain_attempts')));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('existing v1 database is unchanged while consecutive migrations see the preceding version', t => {
  const { db } = fixture(t), versions: number[] = [];
  const oldRows = db.prepare('SELECT * FROM events ORDER BY seq').all();
  const plan = [...V1_MIGRATIONS,
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
  const plan = [...V1_MIGRATIONS,
    next(database => { database.exec("CREATE TABLE future_projection(id TEXT); UPDATE sessions SET last_seq=999"); }),
    next(database => { database.exec("UPDATE approvals SET data='{}'"); throw failure; }, 3),
  ];
  assert.throws(() => migrateDatabase(db, plan), error => error === failure);
  assert.deepEqual(databaseContents(db), before);
  assert.equal(db.isTransaction, false);
  migrateDatabase(db, [...V1_MIGRATIONS, next(database => { database.exec('CREATE TABLE future_projection(id TEXT)'); })]);
  assert.equal(databaseVersion(db, 2), 2, 'The rolled back version can be applied successfully later');
});

test('deferred foreign key violations reject migration before commit and restore the previous database', t => {
  const { db } = fixture(t), before = databaseContents(db);
  const plan = [...V1_MIGRATIONS, next(database => {
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
    assert.throws(() => migrateDatabase(db, [...V1_MIGRATIONS, bad]), hasCode('DB_MIGRATION_PLAN_INVALID'));
  }
  assert.equal(called, false);
  assert.deepEqual(databaseContents(db), before);
});

test('migration refuses disabled foreign keys and leaves an existing caller transaction alone', t => {
  const { db } = fixture(t), before = databaseContents(db);
  const plan = [...V1_MIGRATIONS, next(database => { database.exec('CREATE TABLE future_projection(id TEXT)'); })];
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
