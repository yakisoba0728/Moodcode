import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { acquireExecutionLock, inspectExecutionLock } from './execution-lock.js';

const SCHEMA = `CREATE TABLE command_execution (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  group_pid INTEGER CHECK (group_pid IS NULL OR group_pid > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL
);`;
const UPDATED_AT = '2026-10-04T01:02:03.456Z';

interface TemporaryLock {
  directory: string;
  path: string;
  cleanup(fn: () => void | Promise<void>): void;
}

function temporaryLock(t: TestContext): TemporaryLock {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-command-inspection-'));
  const callbacks: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    try { for (const callback of callbacks.reverse()) await callback(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, path: join(directory, 'effects.sqlite'), cleanup: fn => callbacks.push(fn) };
}

function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof EngineError && error.code === code;
}

/** Deliberately excludes access time: reading a file may update it. */
function fileTree(directory: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  function visit(path: string, relative: string): void {
    const stat = lstatSync(path, { bigint: true });
    const common = { mode: String(stat.mode), size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
    if (stat.isDirectory()) {
      const entries = readdirSync(path).sort();
      result[relative] = { ...common, type: 'directory', entries };
      for (const entry of entries) visit(join(path, entry), relative ? `${relative}/${entry}` : entry);
    } else if (stat.isSymbolicLink()) {
      result[relative] = { ...common, type: 'symlink', target: readlinkSync(path) };
    } else if (stat.isFile()) {
      result[relative] = { ...common, type: 'file', hash: createHash('sha256').update(readFileSync(path)).digest('hex') };
    } else {
      result[relative] = { ...common, type: 'other' };
    }
  }
  visit(directory, '');
  return result;
}

function preserved<T>(directory: string, inspect: () => T): T {
  const before = fileTree(directory);
  try { return inspect(); }
  finally { assert.deepEqual(fileTree(directory), before, 'inspection must preserve file bytes, modes, mtimes, and directory entries'); }
}

function createDatabase(path: string, schema = SCHEMA): void {
  const db = new DatabaseSync(path);
  try { if (schema) db.exec(schema); }
  finally { db.close(); }
}

function insertMarker(path: string, values: readonly [number, number | null, number, string | Uint8Array] = [24680, 13579, 0, UPDATED_AT]): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('INSERT INTO command_execution (id, owner_pid, group_pid, active, updated_at) VALUES (1, ?, ?, ?, ?)').run(...values);
  } finally { db.close(); }
}

test('missing paths are not initialized and inspection creates neither database nor parents', t => {
  const fixture = temporaryLock(t);
  for (const path of [fixture.path, join(fixture.directory, 'missing', 'nested', 'effects.sqlite')]) {
    assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(path)), {
      status: 'not_initialized', marker: null, schemaVersion: null,
    });
  }
});

test('zero byte, empty SQLite, absent table, and empty marker table remain uninitialized without writes', t => {
  const fixture = temporaryLock(t);
  const zero = join(fixture.directory, 'zero.sqlite');
  writeFileSync(zero, '');
  const empty = join(fixture.directory, 'empty.sqlite');
  createDatabase(empty, '');
  const unrelated = join(fixture.directory, 'unrelated.sqlite');
  createDatabase(unrelated, 'CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES (\'keep\');');
  createDatabase(fixture.path);
  for (const path of [zero, empty, unrelated, fixture.path]) {
    assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(path)), {
      status: 'not_initialized', marker: null, schemaVersion: 0,
    });
  }
});

test('inactive marker is available and returns bounded observation fields without changing the marker', t => {
  const fixture = temporaryLock(t);
  createDatabase(fixture.path);
  insertMarker(fixture.path);
  assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(fixture.path)), {
    status: 'available', schemaVersion: 0,
    marker: { ownerPid: 24680, groupPid: 13579, active: false, updatedAt: UPDATED_AT },
  });
});

test('uppercase declared column names return canonical available marker fields', t => {
  const fixture = temporaryLock(t);
  const schema = SCHEMA.replace(/\b(?:id|owner_pid|group_pid|active|updated_at)\b/g, name => name.toUpperCase());
  createDatabase(fixture.path, schema);
  insertMarker(fixture.path);
  assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(fixture.path)), {
    status: 'available', schemaVersion: 0,
    marker: { ownerPid: 24680, groupPid: 13579, active: false, updatedAt: UPDATED_AT },
  });
});

test('active marker remains uncertain with live or unreachable observed PIDs and nullable group', t => {
  const fixture = temporaryLock(t);
  for (const ownerPid of [process.pid, 2_147_483_647]) {
    const path = join(fixture.directory, `${ownerPid}.sqlite`);
    createDatabase(path);
    insertMarker(path, [ownerPid, null, 1, UPDATED_AT]);
    assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(path)), {
      status: 'uncertain', schemaVersion: 0,
      marker: { ownerPid, groupPid: null, active: true, updatedAt: UPDATED_AT },
    });
  }
});

test('confirmed release is observable as available while inspection never changes a live owner', t => {
  const fixture = temporaryLock(t);
  const owner = acquireExecutionLock(fixture.path);
  fixture.cleanup(() => owner.release(false));
  owner.recordGroup(process.pid);
  assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(fixture.path)), {
    status: 'busy', marker: null, schemaVersion: null,
  });
  owner.release(true);
  const inspected = preserved(fixture.directory, () => inspectExecutionLock(fixture.path));
  assert.equal(inspected.status, 'available');
  assert.equal(inspected.schemaVersion, 0);
  assert.equal(inspected.marker?.ownerPid, process.pid);
  assert.equal(inspected.marker?.groupPid, process.pid);
  assert.equal(inspected.marker?.active, false);
});

interface Exited { code: number | null; signal: NodeJS.Signals | null }

async function childOwner(fixture: TemporaryLock): Promise<{ child: ChildProcess; pid: number; exited: Promise<Exited> }> {
  const source = import.meta.url.endsWith('.ts');
  const moduleUrl = new URL(`./execution-lock.${source ? 'ts' : 'js'}`, import.meta.url).href;
  const code = `import { acquireExecutionLock } from ${JSON.stringify(moduleUrl)};
const lock = acquireExecutionLock(process.argv[1]);
lock.recordGroup(process.pid);
process.stdout.write(JSON.stringify({pid: process.pid}) + '\\n');
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, [
    ...(source ? ['--import', 'tsx'] : []), '--input-type=module', '--eval', code, fixture.path,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<Exited>((resolveExit, reject) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    child.once('error', reject);
  });
  fixture.cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  let diagnostics = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-8192); });
  const pid = await new Promise<number>((resolvePid, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Inspection child did not become ready: ${diagnostics}`)), 8000);
    const fail = (error: unknown) => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Inspection child exited before readiness (${code ?? signal}): ${diagnostics}`)));
    let buffered = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered = `${buffered}${chunk}`.slice(-8192);
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffered.slice(0, newline)) as { pid: unknown };
        assert.equal(value.pid, child.pid);
        assert.equal(typeof value.pid, 'number');
        clearTimeout(timeout);
        resolvePid(Number(value.pid));
      } catch (error) { fail(error); }
    });
  });
  return { child, pid, exited };
}

test('actual child exclusive lock reads as busy; SIGKILL reads its unchanged durable marker as uncertain', { timeout: 15000 }, async t => {
  const fixture = temporaryLock(t);
  const { child, pid, exited } = await childOwner(fixture);
  assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(fixture.path)), {
    status: 'busy', marker: null, schemaVersion: null,
  });
  assert.equal(child.kill('SIGKILL'), true);
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
  const inspected = preserved(fixture.directory, () => inspectExecutionLock(fixture.path));
  assert.equal(inspected.status, 'uncertain');
  assert.equal(inspected.schemaVersion, 0);
  assert.equal(inspected.marker?.ownerPid, pid);
  assert.equal(inspected.marker?.groupPid, null, 'uncommitted group update must not become authoritative after a crash');
  assert.equal(inspected.marker?.active, true);
  assert.equal(typeof inspected.marker?.updatedAt, 'string');
  assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(fixture.path)), inspected);
});

test('inspection rejects invalid paths without creating or following files', t => {
  const fixture = temporaryLock(t);
  const link = join(fixture.directory, 'linked.sqlite');
  createDatabase(fixture.path);
  symlinkSync(fixture.path, link);
  const directory = join(fixture.directory, 'directory.sqlite');
  mkdirSync(directory);
  for (const path of ['', 'relative.sqlite', ':memory:', `${fixture.path}\0suffix`, directory, link]) {
    preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(path), hasCode('COMMAND_EFFECTS_INSPECT_INVALID_PATH')));
  }
});

test('filesystem failures remain distinct from invalid paths and corruption', t => {
  const fixture = temporaryLock(t);
  const parent = join(fixture.directory, 'parent-file');
  writeFileSync(parent, 'preserve this file');
  preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(join(parent, 'effects.sqlite')), hasCode('COMMAND_EFFECTS_INSPECT_FAILED')));
});

test('unsupported SQLite schema versions fail explicitly without changing metadata', t => {
  const fixture = temporaryLock(t);
  for (const version of [1, 2_147_483_647]) {
    const path = join(fixture.directory, `version-${version}.sqlite`);
    createDatabase(path);
    const db = new DatabaseSync(path);
    try { db.exec(`PRAGMA user_version=${version}`); }
    finally { db.close(); }
    preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(path), hasCode('COMMAND_EFFECTS_LOCK_UNSUPPORTED_VERSION')));
  }
});

test('WAL format is rejected before SQLite can create shared memory or journal sidecars', t => {
  const fixture = temporaryLock(t);
  createDatabase(fixture.path);
  insertMarker(fixture.path);
  const db = new DatabaseSync(fixture.path);
  try {
    assert.equal(db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode, 'wal');
  } finally { db.close(); }
  const header = readFileSync(fixture.path).subarray(0, 100);
  assert.equal(header[18], 2);
  assert.equal(header[19], 2);
  assert.deepEqual(readdirSync(fixture.directory), ['effects.sqlite'], 'fixture begins without WAL sidecars');
  preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(fixture.path), hasCode('COMMAND_EFFECTS_LOCK_UNSUPPORTED_VERSION')));
  assert.deepEqual(readdirSync(fixture.directory), ['effects.sqlite'], 'inspection must not create -wal or -shm files');
});

test('a stale zero-byte path stat cannot bypass validation of the opened WAL file header', t => {
  const fixture = temporaryLock(t);
  const walFixture = join(fixture.directory, 'wal-fixture.sqlite');
  createDatabase(walFixture);
  const db = new DatabaseSync(walFixture);
  try { assert.equal(db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode, 'wal'); }
  finally { db.close(); }
  const walBytes = readFileSync(walFixture);
  assert.equal(walBytes[18], 2);
  assert.equal(walBytes[19], 2);
  rmSync(walFixture);
  writeFileSync(fixture.path, '');
  const originalLstat = fs.lstatSync;
  let replaced = false;
  let changedFixtureTree: Record<string, unknown> | undefined;
  const mocked = t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
    const observed = Reflect.apply(originalLstat, fs, args) as ReturnType<typeof fs.lstatSync>;
    if (String(args[0]) === fixture.path && !replaced) {
      assert.ok(observed);
      assert.equal(observed.size, 0);
      replaced = true;
      writeFileSync(fixture.path, walBytes);
      changedFixtureTree = fileTree(fixture.directory);
    }
    return observed;
  });
  try {
    syncBuiltinESMExports();
    assert.throws(() => inspectExecutionLock(fixture.path), hasCode('COMMAND_EFFECTS_LOCK_UNSUPPORTED_VERSION'));
    assert.equal(replaced, true, 'fixture must change after the path stat and before descriptor inspection');
    assert.ok(changedFixtureTree);
    assert.deepEqual(fileTree(fixture.directory), changedFixtureTree, 'inspection must preserve the intentionally changed fixture and create no sidecars');
    assert.deepEqual(readdirSync(fixture.directory), ['effects.sqlite']);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('database over the 1 MiB inspection bound fails with bounded diagnostics and no writes', t => {
  const fixture = temporaryLock(t);
  writeFileSync(fixture.path, Buffer.alloc(1_048_577, 0x61));
  preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(fixture.path), error => {
    assert.ok(hasCode('COMMAND_EFFECTS_INSPECT_CORRUPT')(error));
    assert.ok(error instanceof EngineError);
    assert.ok(Buffer.byteLength(error.message, 'utf8') < 4096);
    assert.ok(Buffer.byteLength(JSON.stringify(error.details ?? null), 'utf8') < 4096);
    return true;
  }));
});

test('malformed SQLite and marker schemas fail as corruption without repair or replacement', t => {
  const fixture = temporaryLock(t);
  const malformed = join(fixture.directory, 'garbage.sqlite');
  writeFileSync(malformed, 'not a sqlite database\0private-marker-fragment');
  const invalidSchemas = [
    'CREATE TABLE command_execution (id INTEGER PRIMARY KEY, owner_pid INTEGER);',
    'CREATE VIEW command_execution AS SELECT 1 AS id, 1 AS owner_pid, NULL AS group_pid, 0 AS active, \'2026-10-04T01:02:03.456Z\' AS updated_at;',
  ];
  const paths = [malformed];
  for (const [index, schema] of invalidSchemas.entries()) {
    const path = join(fixture.directory, `schema-${index}.sqlite`);
    createDatabase(path, schema);
    paths.push(path);
  }
  for (const path of paths) {
    preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(path), hasCode('COMMAND_EFFECTS_INSPECT_CORRUPT')));
  }
});

test('a hidden generated extra column is rejected as a noncanonical marker schema', t => {
  const fixture = temporaryLock(t);
  const schema = SCHEMA.replace('updated_at TEXT NOT NULL', 'updated_at TEXT NOT NULL, extra TEXT AS (owner_pid || active) VIRTUAL');
  createDatabase(fixture.path, schema);
  insertMarker(fixture.path);
  preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(fixture.path), hasCode('COMMAND_EFFECTS_INSPECT_CORRUPT')));
});

test('UTF-16 marker timestamps must respect the 128 byte UTF-8 observation ceiling', t => {
  const fixture = temporaryLock(t);
  const timestamp = '\u2000'.repeat(50) + '2026-10-04';
  assert.ok(Number.isFinite(Date.parse(timestamp)), 'fixture timestamp must be valid to isolate the byte limit');
  assert.equal(Buffer.byteLength(timestamp, 'utf8'), 160);
  const db = new DatabaseSync(fixture.path);
  try {
    db.exec("PRAGMA encoding='UTF-16le'");
    db.exec(SCHEMA);
    db.prepare('INSERT INTO command_execution VALUES (1, ?, ?, 0, ?)').run(24680, 13579, timestamp);
    assert.equal(db.prepare('SELECT length(CAST(updated_at AS BLOB)) AS bytes FROM command_execution').get()?.bytes, 120);
  } finally { db.close(); }
  preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(fixture.path), hasCode('COMMAND_EFFECTS_INSPECT_CORRUPT')));
});

test('UTF-16 storage accepts a timestamp whose returned UTF-8 bytes remain within the observation ceiling', t => {
  const fixture = temporaryLock(t);
  const timestamp = ' '.repeat(90) + '2026-10-04';
  assert.ok(Number.isFinite(Date.parse(timestamp)));
  assert.equal(Buffer.byteLength(timestamp, 'utf8'), 100);
  const db = new DatabaseSync(fixture.path);
  try {
    db.exec("PRAGMA encoding='UTF-16le'");
    db.exec(SCHEMA);
    db.prepare('INSERT INTO command_execution VALUES (1, ?, ?, 0, ?)').run(24680, 13579, timestamp);
    assert.equal(db.prepare('SELECT length(CAST(updated_at AS BLOB)) AS bytes FROM command_execution').get()?.bytes, 200);
  } finally { db.close(); }
  assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(fixture.path)), {
    status: 'available', schemaVersion: 0,
    marker: { ownerPid: 24680, groupPid: 13579, active: false, updatedAt: timestamp },
  });
});

test('invalid and oversized marker fields fail closed with bounded diagnostics', t => {
  const fixture = temporaryLock(t);
  const invalid: readonly (readonly [number, number | null, number, string | Uint8Array])[] = [
    [0, null, 0, UPDATED_AT],
    [-1, null, 0, UPDATED_AT],
    [Number.MAX_SAFE_INTEGER + 1, null, 0, UPDATED_AT],
    [1, 0, 0, UPDATED_AT],
    [1, Number.MAX_SAFE_INTEGER + 1, 0, UPDATED_AT],
    [1, null, 2, UPDATED_AT],
    [1, null, 0, new Uint8Array([1, 2, 3])],
    [1, null, 0, 'x'.repeat(1024 * 1024)],
  ];
  for (const [index, values] of invalid.entries()) {
    const path = join(fixture.directory, `marker-${index}.sqlite`);
    createDatabase(path);
    insertMarker(path, values);
    preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(path), error => {
      assert.ok(hasCode('COMMAND_EFFECTS_INSPECT_CORRUPT')(error));
      assert.ok(error instanceof EngineError);
      assert.ok(Buffer.byteLength(error.message, 'utf8') < 4096, 'diagnostic text must not copy oversized marker contents');
      assert.ok(Buffer.byteLength(JSON.stringify(error.details ?? null), 'utf8') < 4096, 'error metadata must remain bounded');
      return true;
    }));
  }
});

test('non-singleton markers fail as corruption instead of appearing available or uninitialized', t => {
  const fixture = temporaryLock(t);
  for (const multiple of [false, true]) {
    const path = join(fixture.directory, `${multiple ? 'multiple' : 'wrong-id'}.sqlite`);
    createDatabase(path);
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA ignore_check_constraints=ON');
      if (multiple) db.prepare('INSERT INTO command_execution VALUES (1, 1, NULL, 0, ?)').run(UPDATED_AT);
      db.prepare('INSERT INTO command_execution VALUES (2, 1, NULL, 0, ?)').run(UPDATED_AT);
    } finally { db.close(); }
    preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(path), hasCode('COMMAND_EFFECTS_INSPECT_CORRUPT')));
  }
});

test('pre-aborted inspection fails without opening, creating, or changing the database', t => {
  const fixture = temporaryLock(t);
  createDatabase(fixture.path);
  insertMarker(fixture.path);
  const controller = new AbortController();
  controller.abort(new Error('caller cancellation reason'));
  for (const path of [fixture.path, join(fixture.directory, 'missing', 'effects.sqlite')]) {
    preserved(fixture.directory, () => assert.throws(() => inspectExecutionLock(path, { signal: controller.signal }), hasCode('COMMAND_EFFECTS_INSPECT_ABORTED')));
  }
  assert.equal(preserved(fixture.directory, () => inspectExecutionLock(fixture.path, { signal: new AbortController().signal })).status, 'available');
});

test('unreadable database maps to permission denied and preserves its contents and mode', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX non-root permissions required' : false,
}, t => {
  const fixture = temporaryLock(t);
  createDatabase(fixture.path);
  insertMarker(fixture.path);
  chmodSync(fixture.path, 0o600);
  const before = fileTree(fixture.directory);
  try {
    chmodSync(fixture.path, 0);
    assert.throws(() => inspectExecutionLock(fixture.path), hasCode('COMMAND_EFFECTS_INSPECT_PERMISSION_DENIED'));
    assert.equal(lstatSync(fixture.path).mode & 0o777, 0);
  } finally { chmodSync(fixture.path, 0o600); }
  assert.deepEqual(fileTree(fixture.directory), before);
});

test('an existing database and parent without write permissions remain readable and unchanged', {
  skip: process.platform === 'win32' ? 'POSIX file and directory permissions required' : false,
}, t => {
  const fixture = temporaryLock(t);
  const parent = join(fixture.directory, 'readonly');
  const path = join(parent, 'effects.sqlite');
  mkdirSync(parent, { mode: 0o700 });
  createDatabase(path);
  insertMarker(path);
  fixture.cleanup(() => {
    chmodSync(parent, 0o700);
    chmodSync(path, 0o600);
  });
  chmodSync(path, 0o400);
  chmodSync(parent, 0o500);
  assert.deepEqual(preserved(fixture.directory, () => inspectExecutionLock(path)), {
    status: 'available', schemaVersion: 0,
    marker: { ownerPid: 24680, groupPid: 13579, active: false, updatedAt: UPDATED_AT },
  });
  assert.equal(lstatSync(path).mode & 0o777, 0o400);
  assert.equal(lstatSync(parent).mode & 0o777, 0o500);
});

test('unsearchable parent maps to permission denied without creating a missing database', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX non-root permissions required' : false,
}, t => {
  const fixture = temporaryLock(t);
  const parent = join(fixture.directory, 'private');
  mkdirSync(parent, { mode: 0o700 });
  const before = fileTree(fixture.directory);
  try {
    chmodSync(parent, 0);
    assert.throws(() => inspectExecutionLock(join(parent, 'missing.sqlite')), hasCode('COMMAND_EFFECTS_INSPECT_PERMISSION_DENIED'));
    assert.equal(lstatSync(parent).mode & 0o777, 0);
  } finally { chmodSync(parent, 0o700); }
  assert.deepEqual(fileTree(fixture.directory), before);
});
