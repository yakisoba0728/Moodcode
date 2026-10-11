import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { errnoCode, openSingleLinkFile, readStableFile, sameRegularFile, stableStat, streamStableFile, symlinkFreeDirectory, symlinkFreeDirectorySync, syncDirectory, syncDirectoryAsync, within, type StableField } from './fs.js';

const fault = (name: string) => (): never => { throw new Error(name); };
const reported = (name: string) => (error: unknown) => error instanceof Error && error.message === name;
const handlers = { onChanged: fault('changed'), onLimit: fault('limit') };
const once = (action: () => void) => { let done = false; return () => { if (!done) { done = true; action(); } }; };
function directory(t: TestContext): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-shared-fs-')));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function file(t: TestContext, text = 'abc'): string {
  const path = join(directory(t), 'file');
  writeFileSync(path, text);
  return path;
}
const read = (path: string, options: { stable?: StableField[]; check?: () => void; requireSingleLink?: boolean; maxBytes?: number } = {}) =>
  streamStableFile(path, lstatSync(path), { maxBytes: 16, stable: ['size', 'mtime', 'ctime'], ...handlers, ...options });

test('streamStableFile hashes the pinned file and copies it exclusively with private permissions', t => {
  const source = file(t), copy = join(directory(t), 'copy');
  const result = streamStableFile(source, lstatSync(source), { maxBytes: 3, stable: ['size', 'mtime', 'ctime'], copyTo: copy, fsyncCopy: true, ...handlers });
  assert.equal(result.sha256, createHash('sha256').update('abc').digest('hex'));
  assert.equal(result.bytes, 3);
  assert.equal(result.stats.ino, lstatSync(source).ino);
  assert.equal(readFileSync(copy, 'utf8'), 'abc');
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  assert.throws(() => streamStableFile(source, lstatSync(source), { maxBytes: 3, stable: [], copyTo: copy, ...handlers }), (error: unknown) => errnoCode(error) === 'EEXIST');
  assert.equal(typeof streamStableFile(source, lstatSync(source, { bigint: true }), { maxBytes: 3, stable: ['mtime'], ...handlers }).stats.mtimeNs, 'bigint');
});

test('streamStableFile reports growth, replacement and extra links through the caller handlers', t => {
  assert.throws(() => read(file(t), { maxBytes: 2 }), reported('limit'));
  const grown = file(t);
  assert.throws(() => read(grown, { check: once(() => appendFileSync(grown, 'x'.repeat(32))) }), reported('limit'));
  const appended = file(t);
  assert.throws(() => read(appended, { check: once(() => appendFileSync(appended, 'd')) }), reported('changed'));
  const replaced = file(t), other = file(t, 'xyz');
  assert.throws(() => read(replaced, { check: once(() => renameSync(other, replaced)) }), reported('changed'));
  const linked = file(t);
  linkSync(linked, join(directory(t), 'link'));
  assert.equal(read(linked).bytes, 3);
  assert.throws(() => read(linked, { requireSingleLink: true }), reported('changed'));
});

test('streamStableFile checks only the stat fields each caller pins', t => {
  const source = file(t);
  assert.equal(read(source, { stable: ['size', 'mtime'], check: once(() => chmodSync(source, 0o640)) }).bytes, 3);
  assert.throws(() => read(source, { stable: ['mode'], check: once(() => chmodSync(source, 0o600)) }), reported('changed'));
  const before = lstatSync(source, { bigint: true });
  chmodSync(source, 0o644);
  const after = lstatSync(source, { bigint: true });
  assert.equal(stableStat(before, after, ['size', 'mtime', 'nlink']), true);
  assert.equal(stableStat(before, after, ['mode']), false);
  assert.equal(stableStat(lstatSync(source), lstatSync(source), ['mtime', 'ctime']), true);
  assert.equal(stableStat(before, undefined), false);
});

test('sameRegularFile requires the same regular file with unchanged size, times and links', t => {
  const source = file(t), pinned = lstatSync(source, { bigint: true });
  assert.equal(sameRegularFile(pinned, lstatSync(source, { bigint: true })), true);
  assert.equal(sameRegularFile(pinned, undefined), false);
  linkSync(source, join(directory(t), 'link'));
  assert.equal(sameRegularFile(pinned, lstatSync(source, { bigint: true })), false);
  const grown = file(t), before = lstatSync(grown, { bigint: true });
  appendFileSync(grown, 'd');
  assert.equal(sameRegularFile(before, lstatSync(grown, { bigint: true })), false);
  const folder = directory(t);
  assert.equal(sameRegularFile(lstatSync(folder, { bigint: true }), lstatSync(folder, { bigint: true })), false);
});

test('readStableFile pins only canonical regular files within the limit', t => {
  const source = file(t), root = directory(t);
  const pin = readStableFile(source, { maxBytes: 3, stable: ['size', 'mtime', 'ctime'], requireSingleLink: true, ...handlers });
  assert.equal(pin.stats.size, 3n);
  assert.equal(pin.sha256, createHash('sha256').update('abc').digest('hex'));
  symlinkSync(source, join(root, 'symlink'));
  symlinkSync(join(source, '..'), join(root, 'parent'));
  const options = { maxBytes: 3, stable: [], ...handlers, onUnsafe: fault('unsafe') };
  assert.throws(() => readStableFile(join(root, 'symlink'), options), reported('unsafe'));
  assert.throws(() => readStableFile(join(root, 'parent', 'file'), options), reported('unsafe'));
  assert.throws(() => readStableFile(source, { ...options, maxBytes: 2 }), reported('unsafe'));
  linkSync(source, join(root, 'hard'));
  assert.throws(() => readStableFile(source, { ...options, requireSingleLink: true, onUnsafe: undefined }), reported('changed'));
});

test('within rejects parent escapes but not names that only start with two dots', () => {
  assert.equal(within('/a', '/a'), true);
  assert.equal(within('/a', '/a/b/c'), true);
  assert.equal(within('/a', '/a/..b'), true);
  assert.equal(within('/a', '/a/../b'), false);
  assert.equal(within('/a', '/ab'), false);
  assert.equal(within('/a/b', '/a'), false);
});

test('symlink-free directory walks reject a symlink component before resolve() can erase it', async t => {
  const root = directory(t), real = join(root, 'real', 'nested');
  mkdirSync(real, { recursive: true });
  symlinkSync(real, join(root, 'link'));
  const unsafe = { onUnsafe: fault('unsafe') };
  assert.equal(symlinkFreeDirectorySync(`${root}/real/./nested/..`, unsafe), join(root, 'real'));
  assert.throws(() => symlinkFreeDirectorySync(`${root}/link/..`, unsafe), reported('unsafe'));
  assert.throws(() => symlinkFreeDirectorySync(join(root, 'missing', 'x'), unsafe), (error: unknown) => errnoCode(error) === 'ENOENT');
  assert.equal(symlinkFreeDirectorySync(join(root, 'missing', 'x'), { ...unsafe, allowMissing: true }), join(root, 'missing', 'x'));
  const created = join(root, 'created', 'deeper');
  assert.equal((await symlinkFreeDirectory(created, { ...unsafe, create: true })).isDirectory(), true);
  assert.equal(statSync(created).mode & 0o777, 0o700);
  await assert.rejects(symlinkFreeDirectory(join(root, 'absent'), unsafe), (error: unknown) => errnoCode(error) === 'ENOENT');
  await assert.rejects(symlinkFreeDirectory(join(root, 'link'), { ...unsafe, create: true }), reported('unsafe'));
  await assert.rejects(symlinkFreeDirectory(`${root}/real/../real`, unsafe), reported('unsafe'));
});

test('syncDirectory refuses a symlink or a file, and errnoCode reads only string codes', t => {
  const root = directory(t);
  writeFileSync(join(root, 'file'), '');
  symlinkSync(root, join(root, 'link'));
  syncDirectory(root);
  assert.throws(() => syncDirectory(join(root, 'link')), (error: unknown) => ['ELOOP', 'ENOTDIR'].includes(errnoCode(error)!));
  assert.throws(() => syncDirectory(join(root, 'file')), (error: unknown) => errnoCode(error) === 'ENOTDIR');
  assert.equal(errnoCode({ code: 1 }), undefined);
  assert.equal(errnoCode(null), undefined);
  assert.equal(errnoCode('ENOENT'), undefined);
});

test('syncDirectoryAsync and openSingleLinkFile refuse symlinks, files and extra links', async t => {
  const root = directory(t), path = join(root, 'file'), unsafe = fault('unsafe');
  writeFileSync(path, 'abc');
  symlinkSync(root, join(root, 'dir-link'));
  symlinkSync(path, join(root, 'file-link'));
  await syncDirectoryAsync(root);
  await assert.rejects(syncDirectoryAsync(join(root, 'dir-link')), (error: unknown) => ['ELOOP', 'ENOTDIR'].includes(errnoCode(error)!));
  await assert.rejects(syncDirectoryAsync(path), (error: unknown) => errnoCode(error) === 'ENOTDIR');
  const handle = await openSingleLinkFile(path, unsafe);
  try { assert.equal((await handle.readFile()).toString(), 'abc'); } finally { await handle.close(); }
  for (const target of [root, join(root, 'file-link')]) await assert.rejects(openSingleLinkFile(target, unsafe), reported('unsafe'));
  linkSync(path, join(root, 'second'));
  await assert.rejects(openSingleLinkFile(path, unsafe), reported('unsafe'));
});
