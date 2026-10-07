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
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 6)); assert.equal(databaseVersion(db), 6); assert.deepEqual(rows(), beforeRows);
  assert.equal(db.prepare('SELECT count(*) AS count FROM attempt_cleanup').get()?.count, 0);
  assert.ok(db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM provider_attempts a JOIN runs r ON r.id=a.run_id WHERE r.workspace_id=? AND a.state='uncertain' LIMIT 1").all(run.workspace_id!).some(row => String(row.detail).includes('ordinary_uncertain_attempts')));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('DB6 to DB7 preserves old uncertainty/proof/usage and adds no implicit provider decision', t => {
  const { db } = fixture(t); db.exec('PRAGMA foreign_keys=ON');
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 6));
  const owner = db.prepare('SELECT id,session_id,workspace_id FROM runs ORDER BY ordinal LIMIT 1').get()!;
  db.prepare('INSERT INTO session_turns(id,session_id,run_id,turn_index,state,data) VALUES(?,?,?,?,?,?)').run('old-turn', owner.session_id!, owner.id!, 0, 'uncertain', JSON.stringify({ opaque: 'Original unknown Turn' }));
  db.prepare('INSERT INTO provider_attempts(id,session_id,run_id,turn_id,attempt_index,state,data) VALUES(?,?,?,?,?,?,?)').run('old-attempt', owner.session_id!, owner.id!, 'old-turn', 0, 'uncertain', JSON.stringify({ opaque: 'Original unknown provider outcome' }));
  db.prepare('INSERT INTO attempt_usage(attempt_id,session_id,run_id,turn_id,revision,data) VALUES(?,?,?,?,?,?)').run('old-attempt', owner.session_id!, owner.id!, 'old-turn', 1, JSON.stringify({ usage: { inputTokens: 9, outputTokens: null } }));
  db.prepare('INSERT INTO attempt_cleanup(attempt_id,session_id,workspace_id,run_id,turn_id,provider_id,model_id,request_sha256,request_bytes,state,revision,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('old-attempt', owner.session_id!, owner.workspace_id!, owner.id!, 'old-turn', 'fixture', 'local', '1'.repeat(64), 128, 'confirmed', 3, JSON.stringify({ opaque: 'Old observed proof; not a new ACK' }));
  db.prepare('INSERT INTO summary_attempts(id,session_id,workspace_id,run_id,scope,state,revision,data) VALUES(?,?,?,?,?,?,?,?)')
    .run('old-summary',owner.session_id!,owner.workspace_id!,owner.id!,'completed-history','uncertain',3,'{"opaque":"Old summary"}');
  const legacyBody='{"opaque":"Original DB5 decision remains historical"}';
  db.prepare('INSERT INTO summary_recovery_acknowledgments(id,summary_attempt_id,session_id,workspace_id,run_id,request_id,binding_scope,attempt_revision,fingerprint,record_sha256,usage_sha256,source_owner_sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('old-decision','old-summary',owner.session_id!,owner.workspace_id!,owner.id!,'old-request','2'.repeat(64),3,'3'.repeat(64),'4'.repeat(64),null,'5'.repeat(64),legacyBody);
  const tables = ['events','session_events','messages','session_turns','provider_attempts','attempt_usage','attempt_cleanup','summary_recovery_acknowledgments'];
  const columns=Object.fromEntries(tables.map(table=>[table,db.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name)).join(',')]));
  const rows = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT ${columns[table]} FROM ${table} ORDER BY rowid`).all()]));
  const beforeRows = rows(), before = databaseContents(db);
  const failed = [...DATABASE_MIGRATIONS.slice(0, 6), { version: 7, name: 'intentional-v7-failure', apply(database: DatabaseSync) {
    DATABASE_MIGRATIONS[6]!.apply(database); throw new Error('DB7 rollback');
  } }];
  assert.throws(() => migrateDatabase(db, failed), /DB7 rollback/u); assert.equal(databaseVersion(db), 6); assert.deepEqual(databaseContents(db), before);
  migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,7)); assert.equal(databaseVersion(db), 7); assert.deepEqual(rows(), beforeRows);
  const migrated=db.prepare('SELECT data,proof_version,pins_sha256,startup_high_water FROM summary_recovery_acknowledgments WHERE id=?').get('old-decision')!;
  assert.equal(migrated.data,legacyBody);assert.equal(migrated.proof_version,1);assert.equal(migrated.pins_sha256,null);assert.equal(migrated.startup_high_water,null);
  assert.equal(db.prepare('SELECT count(*) AS count FROM provider_recovery_acknowledgments').get()?.count, 0);
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

 test('DB7 to DB8 adds a bounded latest-document index and preserves all original rows; failed migration rolls back', t => {
  const {db}=fixture(t);db.exec('PRAGMA foreign_keys=ON');migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,7));
  const before=databaseContents(db),messages=db.prepare('SELECT * FROM messages ORDER BY ordinal').all();
  const failed=[...DATABASE_MIGRATIONS.slice(0,7),{version:8,name:'intentional-v8-failure',apply(database:DatabaseSync){DATABASE_MIGRATIONS[7]!.apply(database);throw new Error('DB8 rollback');}}];
  assert.throws(()=>migrateDatabase(db,failed),/DB8 rollback/u);assert.equal(databaseVersion(db),7);assert.deepEqual(databaseContents(db),before);
  migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,8));assert.equal(databaseVersion(db),8);assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY ordinal').all(),messages);
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT ordinal FROM messages WHERE session_id=? AND json_extract(data,'$.role')='user' AND json_type(data,'$.documents')='array' AND json_array_length(data,'$.documents')>0 ORDER BY ordinal DESC LIMIT 1").all('session');
  assert.ok(plan.some(row=>String(row.detail).includes('model_session_latest_document')));assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('DB8 to DB9 installs empty MCP dispatch receipts without inferring legacy remote observations',t=>{
  const {db}=fixture(t);db.exec('PRAGMA foreign_keys=ON');migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,8));
  const before=databaseContents(db),events=db.prepare('SELECT * FROM events ORDER BY session_id,seq').all(),native=db.prepare('SELECT * FROM session_events ORDER BY session_id,seq').all();
  const failure=[...DATABASE_MIGRATIONS.slice(0,8),{version:9,name:'intentional-v9-failure',apply(database:DatabaseSync){DATABASE_MIGRATIONS[8]!.apply(database);throw new Error('DB9 rollback');}}];
  assert.throws(()=>migrateDatabase(db,failure),/DB9 rollback/u);assert.equal(databaseVersion(db),8);assert.deepEqual(databaseContents(db),before);
  migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,9));assert.equal(databaseVersion(db),9);assert.equal(db.prepare('SELECT count(*) AS count FROM mcp_executions').get()!.count,0);
  assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY session_id,seq').all(),events);assert.deepEqual(db.prepare('SELECT * FROM session_events ORDER BY session_id,seq').all(),native);
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM mcp_executions WHERE workspace_id=? AND (state IN ('dispatch-intent','uncertain') OR transport_cleanup_confirmed=0) LIMIT 1").all('workspace');
  assert.ok(plan.some(row=>String(row.detail).includes('mcp_executions_workspace_blocked')));assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const after=databaseContents(db);migrateDatabase(db,DATABASE_MIGRATIONS.slice(0,9));assert.deepEqual(databaseContents(db),after);
});

test('DB9 to DB10 adds empty workspace trust/knowledge tables and rolls back failed installation atomically', t => {
  const { db } = fixture(t); db.exec('PRAGMA foreign_keys=ON'); migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 9));
  const before = databaseContents(db), events = db.prepare('SELECT * FROM events ORDER BY session_id,seq').all();
  const failure = [...DATABASE_MIGRATIONS.slice(0, 9), { version: 10, name: 'intentional-v10-failure', apply(database: DatabaseSync) { DATABASE_MIGRATIONS[9]!.apply(database); throw new Error('DB10 rollback'); } }];
  assert.throws(() => migrateDatabase(db, failure), /DB10 rollback/u); assert.equal(databaseVersion(db), 9); assert.deepEqual(databaseContents(db), before);
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 10)); assert.equal(databaseVersion(db), 10);
  for (const table of ['workspace_trust_revisions', 'workspace_trust_heads', 'knowledge_generation_plans', 'knowledge_candidates', 'knowledge_request_receipts', 'knowledge_import_pauses']) assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count, 0);
  assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY session_id,seq').all(), events); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const after = databaseContents(db); migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 10)); assert.deepEqual(databaseContents(db), after);
});

test('DB10 to DB11 adds independent empty generation owners and rolls back failed installation without invented legacy dispatch', t => {
  const { db } = fixture(t); db.exec('PRAGMA foreign_keys=ON'); migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 10));
  const before = databaseContents(db), legacy = ['workspaces', 'sessions', 'runs', 'messages', 'events', 'provider_attempts', 'summary_attempts', 'knowledge_generation_plans', 'knowledge_candidates'];
  const records = legacy.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()] as const);
  const failure = [...DATABASE_MIGRATIONS.slice(0, 10), { version: 11, name: 'intentional-v11-failure', apply(database: DatabaseSync) { DATABASE_MIGRATIONS[10]!.apply(database); throw new Error('DB11 rollback'); } }];
  assert.throws(() => migrateDatabase(db, failure), /DB11 rollback/u); assert.equal(databaseVersion(db), 10); assert.deepEqual(databaseContents(db), before);
  migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 11)); assert.equal(databaseVersion(db), 11);
  for (const table of ['knowledge_generations', 'knowledge_generation_attempts', 'knowledge_generation_recovery_acknowledgments', 'knowledge_generation_workspace_barriers']) assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count, 0);
  for (const [table, rows] of records) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const after = databaseContents(db); migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 11)); assert.deepEqual(databaseContents(db), after);
});


test('DB11 to DB12 adds workspace document CAS without fabricating legacy approval or publication and rolls back atomically', t => {
  const { db } = fixture(t); db.exec('PRAGMA foreign_keys=ON'); migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 11));
  const before = databaseContents(db), legacy = ['workspaces', 'sessions', 'runs', 'messages', 'events', 'knowledge_generation_plans', 'knowledge_candidates', 'knowledge_generations', 'knowledge_generation_attempts'];
  const records = legacy.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()] as const);
  const failure = [...DATABASE_MIGRATIONS.slice(0, 11), { version: 12, name: 'intentional-v12-failure', apply(database: DatabaseSync) { DATABASE_MIGRATIONS[11]!.apply(database); throw new Error('DB12 rollback'); } }];
  assert.throws(() => migrateDatabase(db, failure), /DB12 rollback/u); assert.equal(databaseVersion(db), 11); assert.deepEqual(databaseContents(db), before);
  migrateDatabase(db); assert.equal(databaseVersion(db), 12);
  for (const table of ['workspace_document_revisions', 'workspace_document_heads', 'knowledge_publications', 'knowledge_publication_receipts']) {
    assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count, 0);
    assert.ok(db.prepare(`PRAGMA foreign_key_list(${table})`).all().every(row => !['sessions', 'runs', 'turns', 'provider_attempts'].includes(String(row.table))));
  }
  for (const [table, rows] of records) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const after = databaseContents(db); migrateDatabase(db); assert.deepEqual(databaseContents(db), after);
});
