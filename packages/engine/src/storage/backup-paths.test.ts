import assert from 'node:assert/strict';
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError } from '@moodcode/contracts';
import { SqliteStore } from './index.js';

function fixture(t: TestContext): { directory: string; dbPath: string; store: SqliteStore; sessionId: string } {
  // macOS exposes /var and /tmp through symlinks; use the actual temporary root.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-backup-paths-')));
  const dbPath = join(directory, 'source.sqlite');
  const store = new SqliteStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: now });
  const session = store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Backup path fixture', createdAt: now });
  store.admit({
    sessionId: session.id, requestId: 'backup-fixture-request', prompt: 'Persist this input in the backup',
    config: { providerId: 'scripted', modelId: 'local', mode: 'plan', limits: { ...DEFAULT_LIMITS } },
  });
  return { directory, dbPath, store, sessionId: session.id };
}

function engineFailure(error: unknown): boolean {
  return error instanceof EngineError;
}

function privateParent(directory: string): string {
  const parent = join(directory, 'backups');
  mkdirSync(parent, { mode: 0o700 });
  return parent;
}

test('backup creates private directories and a private, independently readable SQLite file', async (t) => {
  const { directory, store, sessionId } = fixture(t);
  const parent = join(directory, 'new-parent');
  const nested = join(parent, 'nested');
  const destination = join(nested, 'snapshot.sqlite');
  const before = store.getSnapshot(sessionId);
  const result = await store.backup(destination);
  const metadata = statSync(destination);
  assert.equal(result.destination, destination);
  assert.equal(result.bytes, metadata.size);
  assert.ok(result.bytes > 0);
  assert.equal(result.schemaVersion, 1);
  assert.equal(statSync(parent).mode & 0o777, 0o700);
  assert.equal(statSync(nested).mode & 0o777, 0o700);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  assert.deepEqual(readdirSync(nested), ['snapshot.sqlite']);
  assert.deepEqual(store.getSnapshot(sessionId), before);

  const reader = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.deepEqual(reader.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok']);
    assert.deepEqual(reader.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(reader.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM events').get()?.n, before.lastSeq);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n, before.messages.length);
  } finally { reader.close(); }
});

for (const contents of ['', 'unrelated existing file']) {
  test(`backup refuses an existing ${contents === '' ? 'empty' : 'nonempty'} file without changing it`, async (t) => {
    const { directory, store } = fixture(t);
    const parent = privateParent(directory);
    const destination = join(parent, 'existing.sqlite');
    writeFileSync(destination, contents, { mode: 0o640 });
    const before = lstatSync(destination);
    await assert.rejects(store.backup(destination), engineFailure);
    assert.equal(readFileSync(destination, 'utf8'), contents);
    const after = lstatSync(destination);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.deepEqual(readdirSync(parent), ['existing.sqlite']);
  });
}

test('backup refuses a destination directory and preserves its contents', async (t) => {
  const { directory, store } = fixture(t);
  const destination = join(directory, 'existing-directory');
  mkdirSync(destination, { mode: 0o700 });
  const marker = join(destination, 'marker');
  writeFileSync(marker, 'keep this directory');
  await assert.rejects(store.backup(destination), engineFailure);
  assert.equal(readFileSync(marker, 'utf8'), 'keep this directory');
  assert.deepEqual(readdirSync(destination), ['marker']);
});

for (const link of ['symlink', 'dangling-symlink', 'hardlink'] as const) {
  test(`backup refuses an existing destination ${link} and preserves the target`, async (t) => {
    const { directory, store } = fixture(t);
    const parent = privateParent(directory);
    const destination = join(parent, 'linked.sqlite');
    const target = join(directory, 'unrelated-target');
    if (link !== 'dangling-symlink') writeFileSync(target, 'unrelated target contents');
    if (link === 'hardlink') linkSync(target, destination);
    else symlinkSync(target, destination, 'file');
    const before = lstatSync(destination);
    await assert.rejects(store.backup(destination), engineFailure);
    const after = lstatSync(destination);
    assert.equal(after.ino, before.ino);
    assert.equal(after.isSymbolicLink(), link !== 'hardlink');
    if (link === 'dangling-symlink') assert.equal(readdirSync(directory).includes('unrelated-target'), false);
    else assert.equal(readFileSync(target, 'utf8'), 'unrelated target contents');
    assert.deepEqual(readdirSync(parent), ['linked.sqlite']);
  });
}

test('backup refuses a symlink in an existing parent path', async (t) => {
  const { directory, store } = fixture(t);
  const target = join(directory, 'actual-parent');
  mkdirSync(target, { mode: 0o700 });
  const alias = join(directory, 'parent-link');
  symlinkSync(target, alias, 'dir');
  await assert.rejects(store.backup(join(alias, 'nested', 'snapshot.sqlite')), engineFailure);
  assert.deepEqual(readdirSync(target), []);
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
});

test('backup rejects an original symlink parent followed by .. before path normalization', async (t) => {
  const { directory, store } = fixture(t);
  const parent = privateParent(directory);
  const target = join(directory, 'actual-target');
  mkdirSync(target, { mode: 0o700 });
  const marker = join(target, 'marker');
  writeFileSync(marker, 'preserve the symlink target');
  const alias = join(parent, 'link');
  symlinkSync(target, alias, 'dir');
  // join() would erase the very component that this regression must exercise.
  await assert.rejects(store.backup(`${alias}/../snapshot.sqlite`), (error: unknown) =>
    error instanceof EngineError && error.code === 'BACKUP_PATH_UNSUPPORTED');
  assert.deepEqual(readdirSync(parent), ['link']);
  assert.deepEqual(readdirSync(target), ['marker']);
  assert.equal(readFileSync(marker, 'utf8'), 'preserve the symlink target');
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.equal(readdirSync(directory).includes('snapshot.sqlite'), false);
});

test('backup refuses a dangling parent symlink without creating its target', async (t) => {
  const { directory, store } = fixture(t);
  const target = join(directory, 'absent-parent');
  const alias = join(directory, 'dangling-parent');
  symlinkSync(target, alias, 'dir');
  await assert.rejects(store.backup(join(alias, 'snapshot.sqlite')), engineFailure);
  assert.equal(readdirSync(directory).includes('absent-parent'), false);
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
});

for (const suffix of ['-wal', '-shm', '-journal']) {
  test(`backup refuses a destination with a preexisting SQLite ${suffix} sidecar`, async (t) => {
    const { directory, store } = fixture(t);
    const parent = privateParent(directory);
    const destination = join(parent, 'snapshot.sqlite');
    const sidecar = `${destination}${suffix}`;
    writeFileSync(sidecar, 'foreign sidecar contents');
    await assert.rejects(store.backup(destination), engineFailure);
    assert.equal(readFileSync(sidecar, 'utf8'), 'foreign sidecar contents');
    assert.deepEqual(readdirSync(parent), [`snapshot.sqlite${suffix}`]);
  });
}

test('backup refuses the source database as its destination', async (t) => {
  const { dbPath, store, sessionId } = fixture(t);
  const snapshot = store.getSnapshot(sessionId);
  await assert.rejects(store.backup(dbPath), engineFailure);
  assert.deepEqual(store.getSnapshot(sessionId), snapshot);
});

for (const link of ['file', 'symlink', 'hardlink'] as const) {
  test(`backup preserves a ${link} created at the destination while native copying is pending`, async (t) => {
    const { directory, store, sessionId } = fixture(t);
    const parent = privateParent(directory);
    const destination = join(parent, 'publish-race.sqlite');
    const target = join(directory, 'publish-race-target');
    const snapshot = store.getSnapshot(sessionId);
    if (link !== 'file') writeFileSync(target, 'concurrent unrelated target');
    const pending = store.backup(destination);
    if (link === 'file') writeFileSync(destination, 'concurrent unrelated file', { flag: 'wx', mode: 0o640 });
    else if (link === 'symlink') symlinkSync(target, destination, 'file');
    else linkSync(target, destination);
    const before = lstatSync(destination);
    await assert.rejects(pending, engineFailure);
    const after = lstatSync(destination);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.isSymbolicLink(), link === 'symlink');
    assert.equal(readFileSync(destination, 'utf8'), link === 'file' ? 'concurrent unrelated file' : 'concurrent unrelated target');
    if (link !== 'file') assert.equal(readFileSync(target, 'utf8'), 'concurrent unrelated target');
    assert.deepEqual(readdirSync(parent), ['publish-race.sqlite']);
    assert.deepEqual(store.getSnapshot(sessionId), snapshot);
  });
}

test('backup rejects empty and NUL-containing destination paths', async (t) => {
  const { directory, store } = fixture(t);
  await assert.rejects(store.backup(''), engineFailure);
  await assert.rejects(store.backup(join(directory, 'nul\0.sqlite')), engineFailure);
});
