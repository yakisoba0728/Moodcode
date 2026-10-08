import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, DATABASE_MIGRATIONS, DB_VERSION } from '../storage/migrations.js';
import { checkDatabase, RECOVERY_LIMITS } from './snapshot.js';

function fixture(t: test.TestContext, version = DB_VERSION) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, version)); t.after(() => db.close());
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => String(row.name));
  return { db, tables };
}
test('current primary schema is within the bounded recovery schema inspection and includes native generation and SQL/file publication records', t => {
  const { db, tables } = fixture(t), count = Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get()!.count);
  assert.ok(count > 64); assert.ok(count <= RECOVERY_LIMITS.maxSchemaEntries); assert.ok(DB_VERSION >= 14); assert.ok(tables.includes('diagnostic_effect_epochs')); assert.ok(tables.includes('diagnostic_execution_observations'));
  assert.ok(tables.includes('knowledge_file_publications')); assert.ok(tables.includes('knowledge_file_execution_guards')); assert.ok(tables.includes('knowledge_file_observations')); assert.ok(tables.includes('knowledge_file_publication_receipts'));
  assert.ok(tables.includes('knowledge_candidates')); assert.ok(tables.includes('knowledge_generations')); assert.ok(tables.includes('knowledge_generation_attempts')); assert.ok(tables.includes('workspace_document_revisions')); assert.ok(tables.includes('knowledge_publications')); assert.match(checkDatabase(db, DB_VERSION, tables, () => {}), /^[a-f0-9]{64}$/);
});
test('excessive schema metadata remains bounded even with empty data and an otherwise accepted table list', t => {
  const { db, tables } = fixture(t);
  const count = Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get()!.count);
  for (let index = count; index <= RECOVERY_LIMITS.maxSchemaEntries; index++) db.exec(`CREATE INDEX authored_schema_bound_${index} ON workspaces(root)`);
  assert.throws(() => checkDatabase(db, DB_VERSION, tables, () => {}), { code: 'RECOVERY_LIMIT_EXCEEDED' });
});
test('an unexpected table below the schema count cap cannot become trusted archive/recovery metadata', t => {
  const version = DB_VERSION - 1;
  const { db, tables } = fixture(t, version); db.exec('CREATE TABLE authored_foreign_metadata(value TEXT)');
  const count = Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get()!.count);
  assert.ok(count <= RECOVERY_LIMITS.maxSchemaEntries);
  assert.throws(() => checkDatabase(db, version, tables, () => {}), { code: 'RECOVERY_DATABASE_INVALID' });
});
test('frozen empty DB12 logical hash retains its exact historical schema and row digest', t => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 12)); t.after(() => db.close());
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all().map(row => String(row.name));
  assert.equal(checkDatabase(db, 12, tables, () => {}), 'fbdc6515805a0dda0daab7453c09f630890e946d2866bc3e68707c9bb2087977');
  assert.equal(tables.includes('knowledge_file_publications'), false);
});
