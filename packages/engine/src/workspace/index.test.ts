import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { captureWorkspace, getGitStatus, openWorkspace, resolveWorkspacePath, workspaceIdForRoot, workspaceWritePath } from './index.js';
import { runGit } from './git.js';

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'moodcode-workspace-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repository with space ');
  await mkdir(root);
  const git = async (...args: string[]) => exec('git', ['-C', root, '-c', 'user.name=Moodcode Test', '-c', 'user.email=test@localhost', '-c', 'core.autocrlf=false', ...args]);
  await git('init', '--initial-branch=main');
  return { temporary, root: await realpath(root), git, workspace: await openWorkspace(root) };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
}

test('opening nested paths and aliases uses the canonical Git root and stable identity', async (t) => {
  const { temporary, root, workspace } = await fixture(t);
  await mkdir(path.join(root, 'nested', 'deeper'), { recursive: true });
  const nested = await openWorkspace(path.join(root, 'nested', 'deeper'));
  assert.equal(nested.root, root);
  assert.equal(nested.gitRoot, root);
  assert.equal(nested.id, workspace.id);
  assert.equal(workspace.id, workspaceIdForRoot(root));
  assert.equal(workspaceIdForRoot('/tmp/\u00e9'), 'workspace_ed2fd1a3eec8c400c3fc93078b4c1b94316ae6a982c816aafd500b2bb0b3a741');
  assert.equal(nested.branch, 'main');
  assert.ok(!Number.isNaN(Date.parse(nested.createdAt)));
  const alias = path.join(temporary, 'alias');
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await openWorkspace(alias)).id, workspace.id);
});

test('opening requires an existing directory in a working tree', async (t) => {
  const { temporary, root } = await fixture(t);
  await assert.rejects(openWorkspace(''), errorCode('INVALID_WORKSPACE_PATH'));
  await assert.rejects(openWorkspace(path.join(root, 'missing')), errorCode('INVALID_WORKSPACE_PATH'));
  await writeFile(path.join(root, 'file'), 'text');
  await assert.rejects(openWorkspace(path.join(root, 'file')), errorCode('INVALID_WORKSPACE_PATH'));
  const outside = path.join(temporary, 'outside');
  await mkdir(outside);
  await assert.rejects(openWorkspace(outside), errorCode('NOT_GIT_WORKSPACE'));
});

test('detached HEAD and separate linked worktrees have appropriate branch and identity', async (t) => {
  const { temporary, root, workspace, git } = await fixture(t);
  await writeFile(path.join(root, 'tracked.txt'), 'first');
  await git('add', 'tracked.txt');
  await git('commit', '-m', 'Initial fixture');
  await git('checkout', '--detach');
  assert.equal((await openWorkspace(root)).branch, null);
  assert.equal((await getGitStatus(workspace)).branch, null);
  const linked = path.join(temporary, 'linked');
  await git('worktree', 'add', '-b', 'feature', linked);
  const linkedWorkspace = await openWorkspace(linked);
  assert.equal(linkedWorkspace.branch, 'feature');
  assert.equal(linkedWorkspace.root, await realpath(linked));
  assert.notEqual(linkedWorkspace.id, workspace.id);
});

test('path resolution rejects lexical traversal and absolute or ambiguous portable paths', async (t) => {
  const { root, workspace } = await fixture(t);
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'file.txt'), 'text');
  assert.equal(await resolveWorkspacePath(workspace, '.'), root);
  assert.equal(await resolveWorkspacePath(workspace, ''), root);
  assert.equal(await resolveWorkspacePath(workspace, './folder//file.txt'), path.join(root, 'folder', 'file.txt'));
  for (const relative of ['../escape', 'folder/../file', 'a/../../escape']) {
    await assert.rejects(resolveWorkspacePath(workspace, relative, true), errorCode('PATH_OUTSIDE_WORKSPACE'));
  }
  for (const relative of ['/absolute', 'C:/absolute', 'C:relative', '\\server\\share', 'folder\\file', 'a\0b']) {
    await assert.rejects(resolveWorkspacePath(workspace, relative, true), errorCode('INVALID_WORKSPACE_PATH'));
  }
  if (process.platform === 'win32') {
    for (const relative of ['folder/file:stream', 'folder/CON', 'folder/NUL.txt', 'folder/COM1', 'folder/.. ', 'folder/trailing.']) {
      await assert.rejects(resolveWorkspacePath(workspace, relative, true), errorCode('INVALID_WORKSPACE_PATH'));
    }
  }
  await assert.rejects(resolveWorkspacePath(workspace, 'missing'), errorCode('PATH_NOT_FOUND'));
  assert.equal(await resolveWorkspacePath(workspace, 'missing/nested/file.txt', true), path.join(root, 'missing', 'nested', 'file.txt'));
  await assert.rejects(resolveWorkspacePath(workspace, 'folder/file.txt/child', true), errorCode('PATH_NOT_DIRECTORY'));
});

test('write paths reject Windows aliases of Git metadata and dependencies on every platform', () => {
  for (const relative of ['.git./hooks/pre-commit', '.git /config', 'GIT~1/hooks/pre-commit', 'pkg/node_m~1/x.js', 'src/trailing.', 'src/trailing ', '.GIT/config', 'src/node_modules/x', 'a/./b', 'a/../b', 'a//b', '/absolute', 'C:/absolute', 'a\\b', 'a\nb']) {
    assert.throws(() => workspaceWritePath(relative, 'BAD_PATH', 'bad path'), errorCode('BAD_PATH'));
  }
  assert.deepEqual(workspaceWritePath('a\nb', 'BAD_PATH', 'bad path', false), ['a\nb']);
  assert.deepEqual(workspaceWritePath('.github/report~2024.pdf', 'BAD_PATH', 'bad path'), ['.github', 'report~2024.pdf']);
  assert.deepEqual(workspaceWritePath('src/a~b.ts', 'BAD_PATH', 'bad path'), ['src', 'a~b.ts']);
});

test('write paths reject HFS+ ignorable-code-point aliases of Git metadata and dependencies', () => {
  const ignorable = ['‌', '‍', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁪', '⁫', '⁬', '⁭', '⁮', '⁯', '﻿'];
  for (const mark of ignorable) {
    for (const relative of [`${mark}.git/config`, `.g${mark}it/hooks/pre-commit`, `.GI${mark}T/config`, `.git${mark}/config`, `src/node${mark}_modules/x.js`, `NODE_MODULES${mark}${mark}/x.js`]) {
      assert.throws(() => workspaceWritePath(relative, 'BAD_PATH', 'bad path'), errorCode('BAD_PATH'));
    }
  }
  assert.deepEqual(workspaceWritePath('src/a‌b.ts', 'BAD_PATH', 'bad path'), ['src', 'a‌b.ts']);
  assert.deepEqual(workspaceWritePath('.gi‌t-x/config', 'BAD_PATH', 'bad path'), ['.gi‌t-x', 'config']);
});

test('symlink resolution checks existing and missing targets and prefix siblings', async (t) => {
  const { temporary, root, workspace } = await fixture(t);
  const outside = `${root}-other`;
  await mkdir(outside);
  await mkdir(path.join(root, 'inside'));
  await writeFile(path.join(root, 'inside', 'file.txt'), 'internal');
  await symlink(path.join(root, 'inside'), path.join(root, 'inside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.join(temporary, 'missing-target'), path.join(root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await resolveWorkspacePath(workspace, 'inside-link/file.txt'), path.join(root, 'inside', 'file.txt'));
  assert.equal(await resolveWorkspacePath(workspace, 'inside-link/new/child', true), path.join(root, 'inside', 'new', 'child'));
  await assert.rejects(resolveWorkspacePath(workspace, 'outside-link', true), errorCode('PATH_OUTSIDE_WORKSPACE'));
  await assert.rejects(resolveWorkspacePath(workspace, 'outside-link/new/child', true), errorCode('PATH_OUTSIDE_WORKSPACE'));
  await assert.rejects(resolveWorkspacePath(workspace, 'dangling', true), errorCode('PATH_UNAVAILABLE'));
  await assert.rejects(resolveWorkspacePath(workspace, 'dangling/new/child', true), errorCode('PATH_UNAVAILABLE'));
  if (process.platform !== 'win32') {
    await symlink('loop', path.join(root, 'loop'));
    await assert.rejects(resolveWorkspacePath(workspace, 'loop/new', true), errorCode('PATH_UNAVAILABLE'));
  }
});

test('a replaced workspace root is revalidated before resolving a path', async (t) => {
  const { temporary, root, workspace } = await fixture(t);
  const moved = path.join(temporary, 'original');
  const outside = path.join(temporary, 'new-root');
  await mkdir(outside);
  await rename(root, moved);
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveWorkspacePath(workspace, 'new.txt', true), errorCode('WORKSPACE_ROOT_CHANGED'));
});

test('Git status preserves untracked names, modifications and NUL rename records', async (t) => {
  const { root, workspace, git } = await fixture(t);
  assert.equal((await getGitStatus(workspace)).clean, true);
  await writeFile(path.join(root, 'old name.txt'), 'original');
  await writeFile(path.join(root, 'modified.txt'), 'before');
  await git('add', '.');
  await git('commit', '-m', 'Status fixture');
  await git('mv', 'old name.txt', 'renamed name.txt');
  await writeFile(path.join(root, 'modified.txt'), 'after');
  const unusualName = process.platform === 'win32' ? 'untracked space.txt' : 'untracked\nname.txt';
  await writeFile(path.join(root, unusualName), 'untracked');
  const status = await getGitStatus(workspace);
  assert.equal(status.dirty, true);
  assert.equal(status.clean, false);
  assert.equal(status.branch, 'main');
  assert.deepEqual(status.entries.find((entry) => entry.path === 'renamed name.txt'), { path: 'renamed name.txt', originalPath: 'old name.txt', index: 'R', worktree: ' ' });
  assert.deepEqual(status.entries.find((entry) => entry.path === 'modified.txt'), { path: 'modified.txt', index: ' ', worktree: 'M' });
  assert.deepEqual(status.entries.find((entry) => entry.path === unusualName), { path: unusualName, index: '?', worktree: '?' });
});

test('capture observes tracked, untracked and ignored text with byte-faithful hashes', async (t) => {
  const { root, workspace, git } = await fixture(t);
  await mkdir(path.join(root, 'nested', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'nested', '.git'), { recursive: true });
  await mkdir(path.join(root, 'mixed', '.GIT'), { recursive: true });
  await mkdir(path.join(root, 'mixed', 'NODE_MODULES'), { recursive: true });
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'tracked.txt'), 'tracked\n');
  await git('add', '.gitignore', 'tracked.txt');
  await git('commit', '-m', 'Capture fixture');
  await writeFile(path.join(root, 'empty.txt'), '');
  await writeFile(path.join(root, 'ignored.txt'), 'ignored content');
  const bomText = '\uFEFFcontent\r\n';
  await writeFile(path.join(root, 'bom.txt'), bomText);
  await writeFile(path.join(root, 'nested', 'file.txt'), 'nested');
  await writeFile(path.join(root, 'nested', 'node_modules', 'excluded'), 'exclude');
  await writeFile(path.join(root, 'nested', '.git', 'excluded'), 'exclude');
  await writeFile(path.join(root, 'mixed', '.GIT', 'excluded'), 'exclude');
  await writeFile(path.join(root, 'mixed', 'NODE_MODULES', 'excluded'), 'exclude');
  const first = await captureWorkspace(workspace);
  assert.deepEqual([...first.files.keys()], ['.gitignore', 'bom.txt', 'empty.txt', 'ignored.txt', 'nested/file.txt', 'tracked.txt']);
  assert.deepEqual(first.warnings, []);
  assert.equal(first.files.get('bom.txt')?.content, bomText);
  assert.equal(first.files.get('empty.txt')?.content, '');
  for (const [relative, file] of first.files) {
    const bytes = await readFile(path.join(root, ...relative.split('/')));
    assert.equal(file.hash, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.hash, createHash('sha256').update(file.content).digest('hex'));
  }
  assert.deepEqual(await captureWorkspace(workspace), first);
  await rm(path.join(root, 'tracked.txt'));
  await writeFile(path.join(root, 'new.txt'), 'new');
  const second = await captureWorkspace(workspace);
  assert.equal(second.files.has('tracked.txt'), false);
  assert.equal(second.files.get('new.txt')?.content, 'new');
});

test('capture skips binary, oversized and symbolic link entries with warnings', async (t) => {
  const { temporary, root, workspace } = await fixture(t);
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
  await writeFile(path.join(root, 'invalid.bin'), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(17));
  await writeFile(path.join(root, 'text.txt'), 'text');
  await writeFile(path.join(temporary, 'outside.txt'), 'outside');
  await symlink(path.join(temporary, 'outside.txt'), path.join(root, 'outside-link'));
  await symlink(path.join(root, 'text.txt'), path.join(root, 'inside-link'));
  const capture = await captureWorkspace(workspace, { maxFileBytes: 16 });
  assert.deepEqual([...capture.files.keys()], ['text.txt']);
  for (const expected of ['binary', 'non-UTF-8', 'oversized', 'outside-link', 'inside-link']) {
    assert.ok(capture.warnings.some((warning) => warning.includes(expected)), expected);
  }
});

test('capture bounds files, bytes, traversal entries, depth and warning count', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(path.join(root, 'a.txt'), '1234');
  await writeFile(path.join(root, 'b.txt'), '5678');
  await mkdir(path.join(root, 'deep', 'deeper'), { recursive: true });
  await writeFile(path.join(root, 'deep', 'deeper', 'c.txt'), 'deep');
  const count = await captureWorkspace(workspace, { maxFiles: 1 });
  assert.deepEqual([...count.files.keys()], ['a.txt']);
  assert.ok(count.warnings.some((warning) => warning.includes('file limit')));
  const total = await captureWorkspace(workspace, { maxTotalBytes: 4 });
  assert.deepEqual([...total.files.keys()], ['a.txt']);
  assert.ok(total.warnings.some((warning) => warning.includes('total byte limit')));
  const entries = await captureWorkspace(workspace, { maxEntries: 0 });
  assert.equal(entries.files.size, 0);
  assert.ok(entries.warnings.some((warning) => warning.includes('entry limit')));
  const depth = await captureWorkspace(workspace, { maxDepth: 0 });
  assert.equal(depth.files.has('deep/deeper/c.txt'), false);
  assert.ok(depth.warnings.some((warning) => warning.includes('depth limit')));
  await mkdir(path.join(root, 'binaries'));
  await Promise.all(Array.from({ length: 210 }, (_, index) => writeFile(path.join(root, 'binaries', `${index}.bin`), '\0')));
  const warnings = await captureWorkspace(workspace);
  assert.equal(warnings.warnings.length, 200);
  assert.ok(warnings.warnings[199]?.includes('warnings were omitted'));
  for (const badOptions of [{ maxFiles: -1 }, { maxEntries: 0.5 }, { maxFileBytes: Number.NaN }, { maxDepth: 257 }]) {
    await assert.rejects(captureWorkspace(workspace, badOptions), errorCode('INVALID_LIMIT'));
  }
});

test('public Git/capture functions honor pre-aborted signals', async (t) => {
  const { root, workspace } = await fixture(t);
  const signal = AbortSignal.abort();
  await assert.rejects(openWorkspace(root, { signal }), errorCode('ABORTED'));
  await assert.rejects(getGitStatus(workspace, { signal }), errorCode('ABORTED'));
  await assert.rejects(captureWorkspace(workspace, { signal }), errorCode('ABORTED'));
  await assert.rejects(getGitStatus(workspace, { timeoutMs: 0 }), errorCode('INVALID_LIMIT'));
});

test('capture responds to cancellation after observation has started', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(path.join(root, 'file.txt'), 'text');
  const controller = new AbortController();
  const capturing = captureWorkspace(workspace, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(capturing, errorCode('ABORTED'));
});

test('repository-selector environment variables cannot redirect workspace discovery', async (t) => {
  const { root, workspace } = await fixture(t);
  const old = process.env.GIT_DIR;
  const oldTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(root, 'nonexistent-git');
  process.env.GIT_WORK_TREE = path.dirname(root);
  try {
    assert.equal((await openWorkspace(root)).id, workspace.id);
    assert.equal((await getGitStatus(workspace)).clean, true);
  } finally {
    if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old;
    if (oldTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = oldTree;
  }
});

test('Git children receive no provider credentials, including repository hooks', { skip: process.platform === 'win32' }, async (t) => {
  const { temporary, root, git } = await fixture(t);
  await git('commit', '--allow-empty', '-m', 'base');
  const hooks = path.join(temporary, 'hooks');
  const marker = path.join(temporary, 'hook-environment');
  await mkdir(hooks);
  await writeFile(path.join(hooks, 'post-checkout'), `#!/bin/sh\nprintf '%s|%s' "\${ANTHROPIC_API_KEY-unset}" "\${HOME-unset}" > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test-only';
  try {
    const result = await runGit(root, ['-c', `core.hooksPath=${hooks}`, 'worktree', 'add', '--detach', path.join(temporary, 'linked')]);
    assert.equal(result.code, 0, result.stderr.toString('utf8'));
  } finally {
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
  }
  assert.equal(await readFile(marker, 'utf8'), `unset|${process.env.HOME ?? 'unset'}`);
});

test('Git runner terminates stalled processes on timeout/abort and bounds captured output', { skip: process.platform === 'win32' }, async (t) => {
  const { temporary, root } = await fixture(t);
  const binaryDir = path.join(temporary, 'fake-bin');
  await mkdir(binaryDir);
  const fakeGit = path.join(binaryDir, 'git');
  const pidFile = path.join(temporary, 'git-pid');
  const oldPath = process.env.PATH;
  const helpers = new Set<number>();
  // The helper inherits the pipes and stays in Git's process group, like a hook or checkout child.
  const stalled = `#!${process.execPath}\nconst fs = require('node:fs');\nconst helper = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });\nfs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, process.pid + ' ' + helper.pid);\nfs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});\nsetInterval(() => {}, 1000);\n`;
  const readPids = async () => {
    const [leader, helper] = (await readFile(pidFile, 'utf8')).split(' ').map(Number) as [number, number];
    helpers.add(helper);
    return { leader, helper };
  };
  const assertHelperExited = async (pid: number) => {
    // A killed helper is briefly a zombie until it is reparented and reaped.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { process.kill(pid, 0); }
      catch (error) { assert.equal(codeOfTest(error), 'ESRCH'); helpers.delete(pid); return; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Git helper ${pid} survived termination`);
  };
  await writeFile(fakeGit, stalled, { mode: 0o755 });
  process.env.PATH = `${binaryDir}${path.delimiter}${oldPath ?? ''}`;
  try {
    await assert.rejects(runGit(root, ['status'], { timeoutMs: 2_000 }), errorCode('GIT_TIMEOUT'));
    const timedOut = await readPids();
    assert.throws(() => process.kill(timedOut.leader, 0), (error) => codeOfTest(error) === 'ESRCH');
    await assertHelperExited(timedOut.helper);
    await rm(pidFile);
    const controller = new AbortController();
    const running = runGit(root, ['status'], { timeoutMs: 5_000, signal: controller.signal });
    // Wait for the fake Git process to start before exercising in-flight abort.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await readFile(pidFile); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    const aborted = await readPids();
    controller.abort();
    await assert.rejects(running, errorCode('ABORTED'));
    assert.throws(() => process.kill(aborted.leader, 0), (error) => codeOfTest(error) === 'ESRCH');
    await assertHelperExited(aborted.helper);
    await writeFile(fakeGit, `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(3 * 1024 * 1024));\n`, { mode: 0o755 });
    await assert.rejects(runGit(root, ['status']), errorCode('GIT_OUTPUT_LIMIT'));
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    for (const pid of helpers) try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
  }
});

function codeOfTest(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}
