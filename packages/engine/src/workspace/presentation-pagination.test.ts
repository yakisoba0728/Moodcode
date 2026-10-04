import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { openWorkspace } from './index.js';
import { listWorkspaceFiles, WORKSPACE_PRESENTATION_LIMITS } from './presentation.js';

const exec = promisify(execFile);
const errorCode = (wanted: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === wanted;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moodcode-presentation-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet', '--template=', root]);
  return { root, workspace: await openWorkspace(root) };
}

test('presentation omits real Python environments and Gitignored entries while paging the whole sorted directory', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.gitignore'), 'generated/\n*.log\n!keep.log\n');
  for (const name of ['src', 'tests', '.venv', 'venv', '__pycache__', '.ruff_cache', 'cache', 'generated']) {
    await mkdir(path.join(f.root, name));
    await writeFile(path.join(f.root, name, 'module.py'), 'value = 1\n');
  }
  for (const name of ['app.py', 'debug.log', 'keep.log']) await writeFile(path.join(f.root, name), 'value = 1\n');
  const paths: string[] = [];
  let continuation: string | undefined;
  for (let page = 0; page < 10; page++) {
    const listing = await listWorkspaceFiles(f.workspace, '', { limit: 2, continuation });
    paths.push(...listing.entries.map(entry => entry.path));
    assert.ok(listing.entries.length <= 2);
    assert.ok(Buffer.byteLength(JSON.stringify(listing)) <= WORKSPACE_PRESENTATION_LIMITS.maxJsonBytes);
    continuation = listing.continuation;
    if (!continuation) { assert.equal(listing.truncated, false); break; }
    assert.equal(listing.truncated, true);
    assert.ok(Buffer.byteLength(continuation) <= 2048);
  }
  assert.deepEqual(paths, ['src', 'tests', '.gitignore', 'app.py', 'keep.log']);
  for (const name of ['.venv', 'venv', '__pycache__', 'generated']) await assert.rejects(listWorkspaceFiles(f.workspace, name), errorCode('PATH_EXCLUDED'));
});

test('presentation continuation rejects tampering, request mismatch and real file/directory/ignore changes', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'src'));
  for (const name of ['a.py', 'b.py', 'c.py']) await writeFile(path.join(f.root, 'src', name), 'value = 1\n');
  for (const continuation of ['offset:2', '../outside', 'x'.repeat(2049)]) await assert.rejects(listWorkspaceFiles(f.workspace, 'src', { limit: 1, continuation }), errorCode('INVALID_CONTINUATION'));
  const first = await listWorkspaceFiles(f.workspace, 'src', { limit: 1 });
  assert.equal(typeof first.continuation, 'string');
  await assert.rejects(listWorkspaceFiles(f.workspace, '', { limit: 1, continuation: first.continuation }), errorCode('INVALID_CONTINUATION'));
  await assert.rejects(listWorkspaceFiles(f.workspace, 'src', { limit: 2, continuation: first.continuation }), errorCode('INVALID_CONTINUATION'));
  await writeFile(path.join(f.root, 'src', 'a.py'), 'value = 2\n');
  await assert.rejects(listWorkspaceFiles(f.workspace, 'src', { limit: 1, continuation: first.continuation }), errorCode('STALE_CONTINUATION'));
  const changed = await listWorkspaceFiles(f.workspace, 'src', { limit: 1 });
  await writeFile(path.join(f.root, 'src', 'd.py'), 'value = 3\n');
  await assert.rejects(listWorkspaceFiles(f.workspace, 'src', { limit: 1, continuation: changed.continuation }), errorCode('STALE_CONTINUATION'));
  const ignoreChanged = await listWorkspaceFiles(f.workspace, 'src', { limit: 1 });
  await writeFile(path.join(f.root, '.gitignore'), 'src/b.py\n');
  await assert.rejects(listWorkspaceFiles(f.workspace, 'src', { limit: 1, continuation: ignoreChanged.continuation }), errorCode('STALE_CONTINUATION'));
  const fresh = await listWorkspaceFiles(f.workspace, 'src');
  assert.deepEqual(fresh.entries.map(entry => entry.name), ['a.py', 'c.py', 'd.py']);
});

test('JSON-limited GUI pages resume at the actual last rendered entry, without gaps or duplicate rows', async t => {
  const f = await fixture(t);
  const directory = `directory-${'d'.repeat(170)}`;
  await mkdir(path.join(f.root, directory));
  const names = Array.from({ length: 800 }, (_, index) => `${String(index).padStart(4, '0')}-${'n'.repeat(170)}.py`);
  for (let offset = 0; offset < names.length; offset += 50) await Promise.all(names.slice(offset, offset + 50).map(name => writeFile(path.join(f.root, directory, name), 'x')));
  const first = await listWorkspaceFiles(f.workspace, directory);
  assert.ok(first.entries.length < names.length);
  assert.equal(first.truncated, true);
  assert.ok(first.continuation);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= WORKSPACE_PRESENTATION_LIMITS.maxJsonBytes);
  const second = await listWorkspaceFiles(f.workspace, directory, { continuation: first.continuation });
  assert.deepEqual([...first.entries, ...second.entries].map(entry => entry.name), names);
  assert.equal(second.continuation, undefined);
});

test('a partial scan with a symlink warning does not issue a misleading continuation', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'a.py'), 'x');
  await writeFile(path.join(f.root, 'b.py'), 'y');
  await symlink(path.join(f.root, 'a.py'), path.join(f.root, 'link.py'));
  const result = await listWorkspaceFiles(f.workspace, '', { limit: 1 });
  assert.equal(result.truncated, true);
  assert.equal(result.continuation, undefined);
  assert.ok(result.warnings.some(warning => warning.includes('SYMLINK_NOT_ALLOWED')));
  assert.ok(result.warnings.some(warning => warning.includes('safe continuation is unavailable')));
});
