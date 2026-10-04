import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { openWorkspace } from './index.js';
import { getWorkspaceStatus, listWorkspaceFiles, readWorkspaceFile, WORKSPACE_PRESENTATION_LIMITS } from './presentation.js';

const exec = promisify(execFile);
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const errorCode = (wanted: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === wanted;

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moodcode-presentation-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repository');
  await mkdir(root);
  const git = (...args: string[]) => exec('git', ['-C', root, '-c', 'user.name=Moodcode Test', '-c', 'user.email=test@localhost', ...args]);
  await git('init', '--initial-branch=main');
  return { temporary, root, git, workspace: await openWorkspace(root) };
}

async function manyFiles(directory: string, names: string[]): Promise<void> {
  for (let offset = 0; offset < names.length; offset += 50) {
    await Promise.all(names.slice(offset, offset + 50).map((name) => writeFile(path.join(directory, name), 'text')));
  }
}

test('presentation status uses the actual branch/index/untracked/rename state with a JSON shape', async (t) => {
  const { root, git, workspace } = await fixture(t);
  const unborn = await getWorkspaceStatus(workspace);
  assert.equal(unborn.branch, 'main');
  assert.equal(unborn.clean, true);
  assert.equal(unborn.totalChangedFiles, 0);
  await writeFile(path.join(root, 'old.txt'), 'original');
  await writeFile(path.join(root, 'modified.txt'), 'before');
  await git('add', '.');
  await git('commit', '-m', 'Fixture');
  await git('mv', 'old.txt', 'renamed.txt');
  await writeFile(path.join(root, 'modified.txt'), 'after');
  const unusual = process.platform === 'win32' ? 'untracked space.txt' : 'untracked\nname.txt';
  await writeFile(path.join(root, unusual), 'untracked');
  await git('checkout', '-b', 'actual-branch');
  const status = await getWorkspaceStatus(workspace);
  assert.equal(workspace.branch, 'main'); // Stale open metadata must not control the result.
  assert.equal(status.branch, 'actual-branch');
  assert.equal(status.dirty, true);
  assert.equal(status.clean, false);
  assert.equal(status.totalChangedFiles, 3);
  assert.equal(status.truncated, false);
  assert.deepEqual(status.warnings, []);
  assert.deepEqual(status.changedFiles.find((file) => file.path === 'renamed.txt'), { path: 'renamed.txt', index: 'R', worktree: ' ', originalPath: 'old.txt' });
  assert.ok(status.changedFiles.some((file) => file.path === unusual && file.index === '?'));
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  await git('checkout', '--detach');
  assert.equal((await getWorkspaceStatus(workspace)).branch, null);
});

test('lazy directory listings are sorted, normalized and exclude metadata/dependencies/build caches', async (t) => {
  const { root, workspace } = await fixture(t);
  for (const name of ['src', 'z-directory', 'NODE_MODULES', 'BUILD', '.next', '.cache']) await mkdir(path.join(root, name));
  await writeFile(path.join(root, 'a.txt'), 'abc');
  await writeFile(path.join(root, 'z.txt'), 'last');
  await writeFile(path.join(root, 'src', 'nested.txt'), 'inside');
  const listing = await listWorkspaceFiles(workspace);
  assert.equal(listing.path, '');
  assert.deepEqual(listing.entries, [
    { path: 'src', name: 'src', kind: 'directory' },
    { path: 'z-directory', name: 'z-directory', kind: 'directory' },
    { path: 'a.txt', name: 'a.txt', kind: 'file', bytes: 3 },
    { path: 'z.txt', name: 'z.txt', kind: 'file', bytes: 4 },
  ]);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.warnings, []);
  const nested = await listWorkspaceFiles(workspace, './src//');
  assert.equal(nested.path, 'src');
  assert.deepEqual(nested.entries, [{ path: 'src/nested.txt', name: 'nested.txt', kind: 'file', bytes: 6 }]);
  await assert.rejects(listWorkspaceFiles(workspace, 'a.txt'), errorCode('NOT_DIRECTORY'));
  for (const excluded of ['.git', '.git/config', 'NODE_MODULES', 'BUILD', '.next', '.cache', 'src/../.git']) {
    await assert.rejects(listWorkspaceFiles(workspace, excluded), (error) => errorCode('PATH_EXCLUDED')(error) || errorCode('PATH_OUTSIDE_WORKSPACE')(error));
  }
  await assert.rejects(readWorkspaceFile(workspace, '.git/config'), errorCode('PATH_EXCLUDED'));
});

test('presentation refuses lexical absolute/traversal/NUL/backslash/oversized paths', async (t) => {
  const { workspace } = await fixture(t);
  for (const input of ['/absolute', 'C:/absolute', 'C:relative', '\\server\\share', 'folder\\file', 'a\0b', 'a'.repeat(4097)]) {
    await assert.rejects(listWorkspaceFiles(workspace, input), errorCode('INVALID_WORKSPACE_PATH'));
    await assert.rejects(readWorkspaceFile(workspace, input), errorCode('INVALID_WORKSPACE_PATH'));
  }
  for (const input of ['../outside', 'a/../../outside', 'a/../inside']) {
    await assert.rejects(listWorkspaceFiles(workspace, input), errorCode('PATH_OUTSIDE_WORKSPACE'));
    await assert.rejects(readWorkspaceFile(workspace, input), errorCode('PATH_OUTSIDE_WORKSPACE'));
  }
  await assert.rejects(readWorkspaceFile(workspace, ''), errorCode('INVALID_WORKSPACE_PATH'));
  await assert.rejects(readWorkspaceFile(workspace, 'missing.txt'), errorCode('PATH_NOT_FOUND'));
});

test('internal/external/dangling/parent symlinks are rejected and listed as omitted warnings', async (t) => {
  const { root, temporary, workspace } = await fixture(t);
  await mkdir(path.join(root, 'inside'));
  await writeFile(path.join(root, 'inside', 'file.txt'), 'inside');
  await writeFile(path.join(temporary, 'outside.txt'), 'outside');
  await symlink(path.join(root, 'inside'), path.join(root, 'directory-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.join(root, 'inside', 'file.txt'), path.join(root, 'file-link'));
  await symlink(path.join(temporary, 'outside.txt'), path.join(root, 'outside-link'));
  await symlink(path.join(temporary, 'missing.txt'), path.join(root, 'dangling'));
  for (const input of ['directory-link', 'directory-link/file.txt', 'file-link', 'outside-link', 'dangling']) {
    await assert.rejects(readWorkspaceFile(workspace, input), errorCode('SYMLINK_NOT_ALLOWED'));
  }
  await assert.rejects(listWorkspaceFiles(workspace, 'directory-link'), errorCode('SYMLINK_NOT_ALLOWED'));
  const listing = await listWorkspaceFiles(workspace);
  assert.deepEqual(listing.entries.map((entry) => entry.path), ['inside']);
  assert.equal(listing.truncated, true);
  assert.equal(listing.warnings.filter((message) => message.includes('SYMLINK_NOT_ALLOWED')).length, 4);
});

test('text reading preserves UTF-8 BOM/CRLF/multibyte/empty content and byte-faithful hashes', async (t) => {
  const { root, workspace } = await fixture(t);
  for (const [name, content] of Object.entries({ 'bom.txt': '\uFEFF한국어\r\n🙂', 'empty.txt': '', 'line.txt': 'line\r\n' })) {
    await writeFile(path.join(root, name), content);
    const result = await readWorkspaceFile(workspace, `./${name}`);
    assert.deepEqual(result, { path: name, content, bytes: Buffer.byteLength(content), sha256: hash(content), truncated: false });
    assert.equal(result.sha256, hash(await readFile(path.join(root, name))));
  }
  await assert.rejects(readWorkspaceFile(workspace, '.'), errorCode('INVALID_WORKSPACE_PATH'));
  await mkdir(path.join(root, 'directory'));
  await assert.rejects(readWorkspaceFile(workspace, 'directory'), errorCode('NOT_REGULAR_FILE'));
});

test('exact 512 KiB is accepted, larger/binary/invalid UTF-8 files have explicit error codes', async (t) => {
  const { root, workspace } = await fixture(t);
  const exact = 'é'.repeat(WORKSPACE_PRESENTATION_LIMITS.maxFileBytes / 2);
  await writeFile(path.join(root, 'exact.txt'), exact);
  assert.equal((await readWorkspaceFile(workspace, 'exact.txt')).bytes, WORKSPACE_PRESENTATION_LIMITS.maxFileBytes);
  await writeFile(path.join(root, 'large.txt'), `${exact}x`);
  await assert.rejects(readWorkspaceFile(workspace, 'large.txt'), errorCode('FILE_TOO_LARGE'));
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 65]));
  await assert.rejects(readWorkspaceFile(workspace, 'binary.bin'), errorCode('BINARY_FILE'));
  await writeFile(path.join(root, 'invalid.bin'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(readWorkspaceFile(workspace, 'invalid.bin'), errorCode('INVALID_UTF8'));
});

test('FIFO is neither opened as text nor returned as a file', { skip: process.platform === 'win32' }, async (t) => {
  const { root, workspace } = await fixture(t);
  await exec('mkfifo', [path.join(root, 'pipe')]);
  await assert.rejects(readWorkspaceFile(workspace, 'pipe'), errorCode('NOT_REGULAR_FILE'));
  const listing = await listWorkspaceFiles(workspace);
  assert.equal(listing.entries.length, 0);
  assert.ok(listing.warnings.some((message) => message.includes('NOT_REGULAR_FILE')));
});

test('directory and Git status entry limits expose accurate truncation and counts', async (t) => {
  const { root, workspace } = await fixture(t);
  await mkdir(path.join(root, 'many'));
  await manyFiles(path.join(root, 'many'), Array.from({ length: 1_100 }, (_, index) => `file-${index}.txt`));
  const listing = await listWorkspaceFiles(workspace, 'many');
  assert.equal(listing.entries.length, 1_000);
  assert.equal(listing.truncated, true);
  assert.ok(listing.warnings.some((message) => message.includes('entry limit')));
  const status = await getWorkspaceStatus(workspace);
  assert.equal(status.totalChangedFiles, 1_100);
  assert.equal(status.changedFiles.length, 1_000);
  assert.equal(status.dirty, true);
  assert.equal(status.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= WORKSPACE_PRESENTATION_LIMITS.maxJsonBytes);
});

test('JSON byte limits bound long lazy paths and Git changes below the entry ceiling', async (t) => {
  const { root, workspace } = await fixture(t);
  const directory = `long-${'d'.repeat(175)}`;
  await mkdir(path.join(root, directory));
  await manyFiles(path.join(root, directory), Array.from({ length: 800 }, (_, index) => `${index}-${'f'.repeat(175)}.txt`));
  const listing = await listWorkspaceFiles(workspace, directory);
  assert.equal(listing.truncated, true);
  assert.ok(listing.entries.length < 800);
  assert.ok(listing.warnings.some((message) => message.includes('JSON byte limit')));
  assert.ok(Buffer.byteLength(JSON.stringify(listing)) <= WORKSPACE_PRESENTATION_LIMITS.maxJsonBytes);
  const status = await getWorkspaceStatus(workspace);
  assert.equal(status.totalChangedFiles, 800);
  assert.equal(status.truncated, true);
  assert.ok(status.changedFiles.length < 800);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= WORKSPACE_PRESENTATION_LIMITS.maxJsonBytes);
});

test('skipped symlinks count toward directory limits and warning output remains bounded', { skip: process.platform === 'win32' }, async (t) => {
  const { root, workspace } = await fixture(t);
  const directory = path.join(root, 'links');
  await mkdir(directory);
  for (let offset = 0; offset < 1_050; offset += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 1_050 - offset) }, (_, index) => symlink('missing-target', path.join(directory, `link-${offset + index}`))));
  }
  const listing = await listWorkspaceFiles(workspace, 'links');
  assert.equal(listing.entries.length, 0);
  assert.equal(listing.truncated, true);
  assert.equal(listing.warnings.length, WORKSPACE_PRESENTATION_LIMITS.maxWarnings);
  assert.ok(listing.warnings.at(-1)?.includes('warnings were omitted'));
});

test('pre-abort and cancellation during filesystem work abort all presentation APIs', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(path.join(root, 'text.txt'), 'text');
  const signal = AbortSignal.abort();
  await assert.rejects(getWorkspaceStatus(workspace, signal), errorCode('ABORTED'));
  await assert.rejects(listWorkspaceFiles(workspace, '', { signal }), errorCode('ABORTED'));
  await assert.rejects(readWorkspaceFile(workspace, 'text.txt', { signal }), errorCode('ABORTED'));
  const controller = new AbortController();
  const listing = listWorkspaceFiles(workspace, '', { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(listing, errorCode('ABORTED'));
});

test('read detects real-file replacement after descriptor read and closes the descriptor', async (t) => {
  const { root, workspace } = await fixture(t);
  const target = path.join(root, 'text.txt');
  await writeFile(target, 'before');
  const probe = await open(target);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  let descriptor: FileHandle | undefined;
  let changed = false;
  const mocked = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    if (!changed) {
      changed = true;
      descriptor = this;
      await rename(target, path.join(root, 'old.txt'));
      await writeFile(target, 'after!');
    }
    return result;
  });
  try {
    await assert.rejects(readWorkspaceFile(workspace, 'text.txt'), errorCode('FILE_CHANGED'));
    assert.equal(descriptor?.fd, -1);
    assert.equal(await readFile(target, 'utf8'), 'after!');
  } finally { mocked.mock.restore(); }
});

test('growth past 512 KiB and abort during descriptor read are bounded and close handles', async (t) => {
  const { root, workspace } = await fixture(t);
  const target = path.join(root, 'text.txt');
  await writeFile(target, 'x'.repeat(WORKSPACE_PRESENTATION_LIMITS.maxFileBytes));
  const probe = await open(target);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  let changed = false;
  let descriptor: FileHandle | undefined;
  const mocked = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    if (!changed) { changed = true; descriptor = this; await appendFile(target, 'x'); }
    return result;
  });
  try {
    await assert.rejects(readWorkspaceFile(workspace, 'text.txt'), errorCode('FILE_TOO_LARGE'));
    assert.equal(descriptor?.fd, -1);
  } finally { mocked.mock.restore(); }
  await writeFile(target, 'small');
  const controller = new AbortController();
  const cancelled = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    descriptor = this;
    controller.abort();
    return result;
  });
  try {
    await assert.rejects(readWorkspaceFile(workspace, 'text.txt', { signal: controller.signal }), errorCode('ABORTED'));
    assert.equal(descriptor?.fd, -1);
  } finally { cancelled.mock.restore(); }
});

test('root replacement during reading is rejected and the original opened file remains unchanged', async (t) => {
  const { root, temporary, workspace } = await fixture(t);
  await writeFile(path.join(root, 'text.txt'), 'original');
  const probe = await open(path.join(root, 'text.txt'));
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  let changed = false;
  const mocked = t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    if (!changed) {
      changed = true;
      await rename(root, path.join(temporary, 'original-root'));
      await mkdir(root);
      await writeFile(path.join(root, 'text.txt'), 'replacement');
    }
    return result;
  });
  try {
    await assert.rejects(readWorkspaceFile(workspace, 'text.txt'), errorCode('WORKSPACE_ROOT_CHANGED'));
    assert.equal(await readFile(path.join(temporary, 'original-root', 'text.txt'), 'utf8'), 'original');
  } finally { mocked.mock.restore(); }
});
