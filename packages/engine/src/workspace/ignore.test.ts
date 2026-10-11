import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { openWorkspace } from './index.js';
import { continuationOffset, continuationToken, excludedDirectory, excludedTraversalPath, excludedWorkspacePaths, gitIgnoredPaths, ignoredWorkspacePaths, snapshotFingerprint, validateContinuation } from './ignore.js';

const exec = promisify(execFile);
const errorCode = (wanted: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === wanted;

test('Git ignore lookup applies nested, negated, anchored and escaped rules to NUL-separated names', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moodcode-ignore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet', '--template=', root]);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'generated'));
  await writeFile(path.join(root, '.gitignore'), '*.log\n!keep.log\n/generated/\n\\#literal\nspace file.txt\n');
  await writeFile(path.join(root, 'src', '.gitignore'), '*.secret\n!public.secret\n');
  const workspace = await openWorkspace(root);
  const paths = ['normal.py', 'error.log', 'keep.log', 'generated', 'generated/app.py', 'src/generated/app.py', '#literal', 'space file.txt', 'src/private.secret', 'src/public.secret', 'src/line\nname.log'];
  const ignored = await ignoredWorkspacePaths(workspace, paths);
  assert.deepEqual([...ignored].sort(), ['#literal', 'error.log', 'generated', 'generated/app.py', 'space file.txt', 'src/line\nname.log', 'src/private.secret'].sort());
  assert.deepEqual([...await ignoredWorkspacePaths(workspace, [])], []);
  const many = Array.from({ length: 300 }, (_, index) => `file-${index}.log`);
  assert.equal((await ignoredWorkspacePaths(workspace, many)).size, many.length);
  await assert.rejects(ignoredWorkspacePaths(workspace, ['../outside']), errorCode('INVALID_WORKSPACE_PATH'));
  await assert.rejects(ignoredWorkspacePaths(workspace, ['x\0y']), errorCode('INVALID_WORKSPACE_PATH'));
  await assert.rejects(ignoredWorkspacePaths(workspace, ['normal.py'], AbortSignal.abort()), errorCode('ABORTED'));
});

test('Git ignore lookup does not forward provider credentials to Git', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moodcode-ignore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet', '--template=', root]);
  const workspace = await openWorkspace(root);
  const binaryDir = await mkdtemp(path.join(os.tmpdir(), 'moodcode-ignore-bin-'));
  t.after(() => rm(binaryDir, { recursive: true, force: true }));
  const marker = path.join(binaryDir, 'environment');
  await writeFile(path.join(binaryDir, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.ANTHROPIC_API_KEY ?? 'unset');\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  const oldKey = process.env.ANTHROPIC_API_KEY;
  process.env.PATH = `${binaryDir}${path.delimiter}${oldPath ?? ''}`;
  process.env.ANTHROPIC_API_KEY = 'sk-test-only';
  try {
    assert.deepEqual([...await ignoredWorkspacePaths(workspace, ['normal.py'])], []);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
  }
  assert.equal(await readFile(marker, 'utf8'), 'unset');
});

test('excluded workspace paths join Git ignore rules with traversal exclusions and skip Git outside a repository', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moodcode-ignore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet', '--template=', root]);
  await writeFile(path.join(root, '.gitignore'), '*.log\n');
  const paths = ['src/app.ts', 'error.log', 'node_modules/pkg/index.js', 'node_modules'];
  const workspace = await openWorkspace(root);
  assert.deepEqual([...await gitIgnoredPaths(workspace, paths)], ['error.log']);
  assert.deepEqual([...await excludedWorkspacePaths(workspace, paths)], ['error.log', 'node_modules/pkg/index.js']);
  const outside = { ...workspace, gitRoot: '' };
  assert.deepEqual([...await gitIgnoredPaths(outside, paths)], []);
  assert.deepEqual([...await excludedWorkspacePaths(outside, paths)], ['node_modules/pkg/index.js']);
});

test('virtual environments and Python/build caches are excluded only as traversal directory components', () => {
  for (const name of ['.venv', 'VENV', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'cache', '.cache', 'node_modules', '.git']) {
    assert.equal(excludedDirectory(name), true);
    assert.equal(excludedTraversalPath(`src/${name}/inside.py`, false), true);
    assert.equal(excludedTraversalPath(`src/${name}`, true), true);
  }
  assert.equal(excludedDirectory('source'), false);
  assert.equal(excludedTraversalPath('src/cache', false), false);
});

test('continuations authenticate a bounded offset, scope and snapshot without carrying path authority', () => {
  const scope = snapshotFingerprint({ workspace: 'one', path: 'src' });
  const snapshot = snapshotFingerprint(['a.py', 'b.py', 'c.py']);
  assert.equal(snapshotFingerprint({ b: 1, a: ['\u00e9'] }), '2d01fc215e152aeb7cc3061324aef7886ac417c52816fb5caec5f1ca08613cd4');
  const token = continuationToken(scope, snapshot, 2);
  assert.ok(Buffer.byteLength(token) <= 2048);
  assert.equal(continuationOffset(token, scope, snapshot, 3), 2);
  assert.equal(continuationOffset(undefined, scope, snapshot, 3), 0);
  assert.deepEqual(validateContinuation(token), { scope, snapshot, offset: 2 });
  const [body, signature] = token.split('.');
  const tampered = Buffer.from(JSON.stringify({ scope, snapshot, offset: 1 })).toString('base64url');
  assert.notEqual(tampered, body);
  for (const malformed of ['', 'plain-offset:2', '../outside', 'x'.repeat(2049), `${tampered}.${signature}`, `${body}.${signature!.slice(0, -1)}!`]) {
    assert.throws(() => validateContinuation(malformed), errorCode('INVALID_CONTINUATION'));
  }
  assert.throws(() => continuationOffset(token, snapshotFingerprint('different workspace'), snapshot, 3), errorCode('INVALID_CONTINUATION'));
  assert.throws(() => continuationOffset(token, scope, snapshotFingerprint('changed files'), 3), errorCode('STALE_CONTINUATION'));
  assert.throws(() => continuationOffset(token, scope, snapshot, 2), errorCode('INVALID_CONTINUATION'));
});
