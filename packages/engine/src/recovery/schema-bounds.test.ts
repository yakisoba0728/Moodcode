import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase, DATABASE_MIGRATIONS, DB_VERSION, primaryTablesFor } from '../storage/migrations.js';
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
test('DB19 workflow schema fits its measured catalogue and the schema cap is inclusive', t => {
  const { db, tables } = fixture(t,19);
  const count = Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").get()!.count);
  assert.equal(count,130);
  assert.equal(RECOVERY_LIMITS.maxSchemaEntries,160);
  assert.ok(tables.includes('workflow_revisions'));
  assert.ok(tables.includes('workflow_heads'));
  for (let index = count; index < RECOVERY_LIMITS.maxSchemaEntries; index++) db.exec(`CREATE INDEX authored_workflow_cap_${index} ON workspaces(root)`);
  assert.match(checkDatabase(db,19,tables,()=>{}),/^[a-f0-9]{64}$/u);
  db.exec('CREATE INDEX authored_workflow_cap_excess ON workspaces(root)');
  assert.throws(()=>checkDatabase(db,19,tables,()=>{}),{code:'RECOVERY_LIMIT_EXCEEDED'});
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
const EMPTY_PRIMARY_LOGICAL_HASHES = [
  '3df13a5c2b8a3552f8a09d8bc638a1335c5a245504df7e7a7117713676b338a1', 'd1ea46bcfa7c3966344de9d5d1cdf084e4e886f382f0146aa2f4fbc9ee33b6a1', 'eaa57ae5939c8c9cda9cfde273bf891881eb3bfb5d40cddc7346fa279a0f2a6b',
  '428dc8c1ac926fe9a03aca8044c2fec5d7258b2f16be0aa54878bcf2ed79fa6e', '4645bea6b837dac125d3e80bd00c0dac7c0e67c9d06737cf78840cc32e81ccc4', 'ffae97498cef98d06dad95e3b62ed8acd18900ca754544f9f8cf6b8de28764b9',
  '91efc745c7c7073c7944d8b120f2c93dacef96091f1fe38d9402de709211fbb1', 'cda0ba54c71e41ab8cae3e12d726dbd97d8cd4213ca6c54868144e83f675e0a3', 'eca52868301300d51a01b5d6290a9cbe305ddd76e4a86b91cc7bd402ae0b21c3',
  '39c2008deee64604b1811d279c613350def6e5322b0f5731a70e30c25339771d', 'f26dc929cce6ab108c70dbfbc8fdc8851a45f0b51f0365e5e0bf9609b647c5e5', 'fbdc6515805a0dda0daab7453c09f630890e946d2866bc3e68707c9bb2087977',
  'a5cc20fffc0fb56c6af68b204095e81003ff47f5d99090b95d36659c52eedce3', 'a8448442b496b2a846a489194107d2b2ac415f7b84cc7591b9d539de870a72db', '32b5ef69eb469693c2c8bf6c3d2810739a6f6ef1c63e5b38d58e2b7400a6092e',
  '9270cf117fb78d77992c7a7b95303fe19860f19926fbba04f02b74d1a84f851f', 'ae77a8d369b1703b515fffa3bae21f4a1b417de908054f0e02a32340f123acf6', '2d8a8b175673ecc51fffa0664aa745047ee95c82d0a4768340bf2ce70ca5da16',
  'fcd513b32ad2ade81435d290ae7b1235ec805e9f5cd46660d4229ee68053e600', 'c99fffae86c1a20390e809de290743dd244feaa92725aeafbb9733c73227cebb', '64356b55de52cb035309b0b4379e1715281771fded40062b4a726537cf0c9443',
  '8dd911ccf75e6e44dd762c4b79edda466b28ac33fdd4ea55058f44803fafffe9', 'b4299d83df4f55f29311e6892d1544f685b6fe091e3cfa7d1d03df3ed9c01240',
];
test('the primary feature ladder names exactly the tables of every schema version and keeps each frozen empty logical hash', t => {
  assert.equal(EMPTY_PRIMARY_LOGICAL_HASHES.length, DB_VERSION);
  for (let version = 1; version <= DB_VERSION; version++) {
    const { db, tables } = fixture(t, version), expected = primaryTablesFor(version);
    assert.equal(new Set(expected).size, expected.length);
    assert.deepEqual([...expected].sort(), tables);
    assert.equal(checkDatabase(db, version, expected, () => {}), EMPTY_PRIMARY_LOGICAL_HASHES[version - 1]);
  }
});
