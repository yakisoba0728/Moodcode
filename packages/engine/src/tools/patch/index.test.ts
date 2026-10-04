import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type Checkpoint, type JsonObject, type JsonValue } from '@moodcode/contracts';
import type { PreparedTool, ToolContext } from '../../ports.js';
import { createPatchTool } from './index.js';
import { acquireExecutionLock, assertExecutionLockAvailable } from '../command/execution-lock.js';

const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const change = (relative: string, before: string | null, after: string | null) => ({ path: relative, expectedHash: before === null ? null : digest(before), content: after });
const hasCode = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moodcode-patch-')));
  const checkpoints: Checkpoint[] = [];
  const controller = new AbortController();
  const context: ToolContext = {
    workspace: { id: 'workspace', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() },
    sessionId: 'session', runId: 'run', toolCallId: 'tool', signal: controller.signal,
    limits: { ...DEFAULT_LIMITS }, artifactDir: root,
    recordCheckpoint(checkpoint) { checkpoints.push(checkpoint); },
  };
  return { root, checkpoints, context, controller, tool: createPatchTool(), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('prepare produces an approval fingerprint and bounded readable preview without effects', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'original.txt'), 'old\n');
    const prepared = await f.tool.prepare({ changes: [change('original.txt', 'old\n', 'new\n'), change('nested/new.txt', null, 'created\n')] }, f.context);
    assert.equal(prepared.name, 'apply_patch');
    assert.equal(prepared.requiresApproval, true);
    assert.match(prepared.fingerprint, /^[a-f0-9]{64}$/);
    assert.match(JSON.stringify(prepared.preview), /--- a\/original.txt/);
    assert.equal(await fs.readFile(path.join(f.root, 'original.txt'), 'utf8'), 'old\n');
    assert.deepEqual((await fs.readdir(f.root)).sort(), ['original.txt']);
    assert.deepEqual(f.checkpoints, []);
    const other = await f.tool.prepare({ changes: [change('original.txt', 'old\n', 'different\n')] }, f.context);
    assert.notEqual(other.fingerprint, prepared.fingerprint);
  } finally { await f.cleanup(); }
});

test('approved full replacements create, update, and delete while preserving unrelated user changes', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'update.txt'), 'existing user edit\n', { mode: 0o755 });
    await fs.writeFile(path.join(f.root, 'delete.txt'), 'remove\n');
    await fs.writeFile(path.join(f.root, 'unrelated.txt'), 'uncommitted user work\n');
    const prepared = await f.tool.prepare({ changes: [change('update.txt', 'existing user edit\n', 'replacement\n'), change('delete.txt', 'remove\n', null), change('new/deep/create.txt', null, 'hello\n')] }, f.context);
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, 'update.txt'), 'utf8'), 'replacement\n');
    assert.equal((await fs.stat(path.join(f.root, 'update.txt'))).mode & 0o777, 0o755);
    await assert.rejects(fs.stat(path.join(f.root, 'delete.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.root, 'new/deep/create.txt'), 'utf8'), 'hello\n');
    assert.equal(await fs.readFile(path.join(f.root, 'unrelated.txt'), 'utf8'), 'uncommitted user work\n');
    assert.equal(f.checkpoints.length, 1);
    assert.deepEqual(f.checkpoints[0]!.files.map((file) => file.path), ['update.txt', 'delete.txt', 'new/deep/create.txt']);
    for (const file of f.checkpoints[0]!.files) {
      assert.equal(file.beforeHash, file.before === null ? null : digest(file.before));
      assert.equal(file.afterHash, file.after === null ? null : digest(file.after));
    }
  } finally { await f.cleanup(); }
});

test('input validation rejects malformed, overlapping, traversal, excluded, and non-text changes', async () => {
  const f = await fixture();
  try {
    const badInputs: unknown[] = [null, [], {}, { changes: [] }, { changes: [change('a', null, 'b')], extra: true },
      { changes: [{ path: 'a', content: 'b' }] }, { changes: [{ path: 'a', expectedHash: 'not-a-hash', content: 'b' }] },
      { changes: [{ path: 'a', expectedHash: null, content: 1 }] }, { changes: [change('a', null, null)] },
      { changes: [change('a', null, 'one'), change('a', null, 'two')] },
      { changes: [change('A', null, 'one'), change('a', null, 'two')] },
      { changes: [change('a', null, 'one'), change('a/b', null, 'two')] },
      { changes: [change('text', null, '\ud800')] }, { changes: [change('binary', null, 'a\0b')] }];
    for (const input of badInputs) await assert.rejects(f.tool.prepare(input, f.context), hasCode('INVALID_PATCH_INPUT'));
    for (const relative of ['../outside', '/absolute', './relative', 'a//b', 'a/../b', 'C:\\outside', 'C:outside', 'a\\b', '.git/config', 'x/Node_Modules/a', '', 'nul\0name', '\ud800', 'x'.repeat(513)]) {
      await assert.rejects(f.tool.prepare({ changes: [change(relative, null, 'content')] }, f.context), hasCode('INVALID_PATCH_PATH'));
    }
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('file, count, and combined preimage/replacement byte limits are enforced', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.tool.prepare({ changes: Array.from({ length: 33 }, (_, i) => change(`f${i}`, null, 'a')) }, f.context), hasCode('INVALID_PATCH_INPUT'));
    await assert.rejects(f.tool.prepare({ changes: [change('large', null, 'a'.repeat(1024 * 1024 + 1))] }, f.context), hasCode('PATCH_LIMIT_EXCEEDED'));
    await assert.rejects(f.tool.prepare({ changes: [change('unicode', null, '가'.repeat(400_000))] }, f.context), hasCode('PATCH_LIMIT_EXCEEDED'));
    await assert.rejects(f.tool.prepare({ changes: Array.from({ length: 5 }, (_, i) => change(`f${i}`, null, 'a'.repeat(1024 * 1024))) }, f.context), hasCode('PATCH_LIMIT_EXCEEDED'));
    const big = 'a'.repeat(1024 * 1024);
    for (let i = 0; i < 3; i++) await fs.writeFile(path.join(f.root, `existing${i}`), big);
    await assert.rejects(f.tool.prepare({ changes: Array.from({ length: 3 }, (_, i) => change(`existing${i}`, big, big)) }, f.context), hasCode('PATCH_LIMIT_EXCEEDED'));
    await fs.writeFile(path.join(f.root, 'huge'), big + 'a');
    await assert.rejects(f.tool.prepare({ changes: [change('huge', big + 'a', 'small')] }, f.context), hasCode('PATCH_LIMIT_EXCEEDED'));
  } finally { await f.cleanup(); }
});

test('expected hashes guard both existing and absent preimages, and existing binary files are rejected', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'existing'), 'user work');
    for (const item of [change('existing', null, 'overwrite'), change('existing', 'wrong', 'overwrite'), change('missing', 'old', null)]) {
      await assert.rejects(f.tool.prepare({ changes: [item] }, f.context), hasCode('PATCH_PREIMAGE_MISMATCH'));
    }
    await fs.writeFile(path.join(f.root, 'nul'), Buffer.from([65, 0, 66]));
    await fs.writeFile(path.join(f.root, 'invalid'), Buffer.from([255, 254]));
    for (const relative of ['nul', 'invalid']) await assert.rejects(f.tool.prepare({ changes: [change(relative, 'unused', 'new')] }, f.context), hasCode('UNSUPPORTED_PATCH_FILE'));
    assert.equal(await fs.readFile(path.join(f.root, 'existing'), 'utf8'), 'user work');
  } finally { await f.cleanup(); }
});

test('all target preimages are rechecked before any patch effect', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'first'), 'first');
    await fs.writeFile(path.join(f.root, 'second'), 'second');
    const prepared = await f.tool.prepare({ changes: [change('first', 'first', 'changed'), change('second', 'second', 'changed')] }, f.context);
    await fs.writeFile(path.join(f.root, 'second'), 'external edit');
    await assert.rejects(f.tool.execute(prepared, f.context), hasCode('PATCH_PREIMAGE_MISMATCH'));
    assert.equal(await fs.readFile(path.join(f.root, 'first'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(f.root, 'second'), 'utf8'), 'external edit');
    assert.deepEqual(f.checkpoints, []);
  } finally { await f.cleanup(); }
});

test('changed approved inputs, fingerprints, previews, or execution context cannot be applied', async () => {
  const f = await fixture();
  try {
    const mutators: ((prepared: PreparedTool) => void)[] = [
      (prepared) => { ((prepared.input as JsonObject).changes as JsonObject[])[0]!.content = 'tampered'; },
      (prepared) => { prepared.fingerprint = '0'.repeat(64); },
      (prepared) => { prepared.preview.files = []; },
      (prepared) => { prepared.requiresApproval = false; },
      (prepared) => { prepared.name = 'other'; },
    ];
    for (const mutate of mutators) {
      const prepared = await f.tool.prepare({ changes: [change('new', null, 'approved')] }, f.context);
      mutate(prepared);
      await assert.rejects(f.tool.execute(prepared, f.context), hasCode('PATCH_APPROVAL_STALE'));
    }
    const prepared = await f.tool.prepare({ changes: [change('new', null, 'approved')] }, f.context);
    await assert.rejects(f.tool.execute({ ...prepared }, f.context), hasCode('INVALID_PREPARED_PATCH'));
    await assert.rejects(f.tool.execute(prepared, { ...f.context, toolCallId: 'different-call' }), hasCode('PATCH_APPROVAL_STALE'));
    assert.deepEqual(await fs.readdir(f.root), []);
  } finally { await f.cleanup(); }
});

test('symlink targets and parents are rejected, including parents swapped after preparation', async () => {
  const f = await fixture();
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moodcode-outside-')));
  try {
    await fs.writeFile(path.join(outside, 'target'), 'outside');
    await fs.symlink(path.join(outside, 'target'), path.join(f.root, 'leaf'));
    await fs.symlink(outside, path.join(f.root, 'link'));
    await assert.rejects(f.tool.prepare({ changes: [change('leaf', 'outside', 'overwrite')] }, f.context), hasCode('UNSAFE_PATCH_PATH'));
    await assert.rejects(f.tool.prepare({ changes: [change('link/new', null, 'overwrite')] }, f.context), hasCode('UNSAFE_PATCH_PATH'));
    await fs.mkdir(path.join(f.root, 'parent'));
    const prepared = await f.tool.prepare({ changes: [change('parent/new', null, 'overwrite')] }, f.context);
    await fs.rmdir(path.join(f.root, 'parent'));
    await fs.symlink(outside, path.join(f.root, 'parent'));
    await assert.rejects(f.tool.execute(prepared, f.context), hasCode('UNSAFE_PATCH_PATH'));
    assert.equal(await fs.readFile(path.join(outside, 'target'), 'utf8'), 'outside');
    await assert.rejects(fs.stat(path.join(outside, 'new')), { code: 'ENOENT' });
  } finally { await f.cleanup(); await fs.rm(outside, { recursive: true, force: true }); }
});

test('hard-linked and replaced targets cannot consume a prepared approval', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'target'), 'same');
    await fs.link(path.join(f.root, 'target'), path.join(f.root, 'alias'));
    await assert.rejects(f.tool.prepare({ changes: [change('target', 'same', 'new')] }, f.context), hasCode('UNSAFE_PATCH_PATH'));
    await fs.unlink(path.join(f.root, 'alias'));
    const prepared = await f.tool.prepare({ changes: [change('target', 'same', 'new')] }, f.context);
    await fs.writeFile(path.join(f.root, 'replacement'), 'same');
    await fs.rename(path.join(f.root, 'replacement'), path.join(f.root, 'target'));
    await assert.rejects(f.tool.execute(prepared, f.context), hasCode('PATCH_PREIMAGE_MISMATCH'));
    assert.equal(await fs.readFile(path.join(f.root, 'target'), 'utf8'), 'same');
  } finally { await f.cleanup(); }
});

test('execution rechecks each target again and omits a later external edit from patch attribution', async (t) => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'first'), 'first');
    await fs.writeFile(path.join(f.root, 'second'), 'second');
    const prepared = await f.tool.prepare({ changes: [change('first', 'first', 'new first'), change('second', 'second', 'new second')] }, f.context);
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filename: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const handle = await originalOpen(filename, flags, mode);
      if (String(filename) === path.join(f.root, 'first') && typeof flags === 'number' && (flags & constants.O_RDWR) === constants.O_RDWR) await fs.writeFile(path.join(f.root, 'second'), 'external edit');
      return handle;
    });
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.isError, true);
    assert.equal(await fs.readFile(path.join(f.root, 'first'), 'utf8'), 'new first');
    assert.equal(await fs.readFile(path.join(f.root, 'second'), 'utf8'), 'external edit');
    assert.equal(f.checkpoints[0]!.incomplete, true);
    assert.deepEqual(f.checkpoints[0]!.files.map((file) => file.path), ['first']);
    assert.match(f.checkpoints[0]!.warnings.join(' '), /external edit.*omitted/);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('a failure after a partial write records exact surviving bytes and does not roll back earlier effects', async (t) => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'first'), 'first');
    await fs.writeFile(path.join(f.root, 'second'), 'original-long');
    const prepared = await f.tool.prepare({ changes: [change('first', 'first', 'new first'), change('second', 'original-long', 'new')] }, f.context);
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filename: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const handle = await originalOpen(filename, flags, mode);
      if (String(filename) === path.join(f.root, 'second') && typeof flags === 'number' && (flags & constants.O_RDWR) === constants.O_RDWR) {
        t.mock.method(handle, 'truncate', async () => { throw new Error('simulated disk failure'); });
      }
      return handle;
    });
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.isError, true);
    const surviving = await fs.readFile(path.join(f.root, 'second'), 'utf8');
    assert.equal(surviving, 'newginal-long');
    assert.equal(await fs.readFile(path.join(f.root, 'first'), 'utf8'), 'new first');
    const checkpoint = f.checkpoints[0]!;
    assert.equal(checkpoint.incomplete, true);
    assert.equal(checkpoint.files[1]!.before, 'original-long');
    assert.equal(checkpoint.files[1]!.after, surviving);
    assert.equal(checkpoint.files[1]!.afterHash, digest(surviving));
    assert.match(checkpoint.warnings.join(' '), /simulated disk failure/);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('cancellation before effects is respected and cancellation after an effect still records its checkpoint', async (t) => {
  const f = await fixture();
  try {
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(f.tool.prepare({ changes: [change('new', null, 'x')] }, { ...f.context, signal: aborted.signal }), hasCode('CANCELLED'));
    const prepared = await f.tool.prepare({ changes: [change('first', null, 'first'), change('second', null, 'second')] }, f.context);
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filename: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const handle = await originalOpen(filename, flags, mode);
      if (String(filename) === path.join(f.root, 'first') && typeof flags === 'number' && (flags & constants.O_CREAT) !== 0) {
        const sync = handle.sync.bind(handle);
        t.mock.method(handle, 'sync', async () => { await sync(); f.controller.abort(); });
      }
      return handle;
    });
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.isError, true);
    assert.equal(await fs.readFile(path.join(f.root, 'first'), 'utf8'), 'first');
    await assert.rejects(fs.stat(path.join(f.root, 'second')), { code: 'ENOENT' });
    assert.equal(f.checkpoints[0]!.incomplete, true);
    assert.deepEqual(f.checkpoints[0]!.files.map((file) => file.path), ['first']);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('checkpoint persistence failures report filesystem effects and a prepared request is never automatically repeatable', async () => {
  const f = await fixture();
  try {
    const prepared = await f.tool.prepare({ changes: [change('new', null, 'created')] }, f.context);
    await assert.rejects(f.tool.execute(prepared, { ...f.context, recordCheckpoint() { throw new Error('database failure'); } }), hasCode('PATCH_CHECKPOINT_FAILED'));
    assert.equal(await fs.readFile(path.join(f.root, 'new'), 'utf8'), 'created');
    await assert.rejects(f.tool.execute(prepared, f.context), hasCode('INVALID_PREPARED_PATCH'));
  } finally { await f.cleanup(); }
});

test('previews remain bounded while listing every target and tool output obeys the byte budget', async () => {
  const f = await fixture();
  try {
    const content = Array.from({ length: 20 }, () => '\t'.repeat(200)).join('\n');
    const prepared = await f.tool.prepare({ changes: Array.from({ length: 32 }, (_, i) => change(`${i}-${'가'.repeat(60)}`, null, content)) }, f.context);
    assert.ok(Buffer.byteLength(JSON.stringify(prepared.preview)) <= 32 * 1024);
    assert.equal(prepared.preview.truncated, true);
    assert.equal((prepared.preview.files as JsonValue[]).length, 32);
    const result = await f.tool.execute(prepared, { ...f.context, limits: { ...f.context.limits, maxOutputBytes: 5 } });
    assert.ok(Buffer.byteLength(result.content) <= 5);
    assert.equal(f.checkpoints[0]!.files.length, 32);
  } finally { await f.cleanup(); }
});

test('no-op full replacements produce no attributed file change', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'same'), 'same');
    const prepared = await f.tool.prepare({ changes: [change('same', 'same', 'same')] }, f.context);
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.isError, undefined);
    assert.deepEqual(f.checkpoints[0]!.files, []);
    assert.equal(await fs.readFile(path.join(f.root, 'same'), 'utf8'), 'same');
  } finally { await f.cleanup(); }
});

test('escaped path metadata cannot grow an approval preview beyond its bound', async () => {
  const f = await fixture();
  try {
    const suffix = Array.from({ length: 8 }, () => '"'.repeat(60)).join('/');
    await assert.rejects(f.tool.prepare({ changes: Array.from({ length: 32 }, (_, i) => change(`${i}/${suffix}`, null, 'small')) }, f.context), hasCode('PATCH_LIMIT_EXCEEDED'));
    assert.deepEqual(await fs.readdir(f.root), []);
    assert.deepEqual(f.checkpoints, []);
  } finally { await f.cleanup(); }
});

test('a failed postimage read reports incomplete effects rather than a successful empty patch', async (t) => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'target'), 'old');
    const prepared = await f.tool.prepare({ changes: [change('target', 'old', 'new')] }, f.context);
    const originalOpen = fs.open;
    let synced = false;
    t.mock.method(fs, 'open', async (filename: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const writable = typeof flags === 'number' && (flags & constants.O_RDWR) === constants.O_RDWR;
      if (synced && !writable && String(filename) === path.join(f.root, 'target')) throw new Error('simulated postimage read failure');
      const handle = await originalOpen(filename, flags, mode);
      if (writable) {
        const sync = handle.sync.bind(handle);
        t.mock.method(handle, 'sync', async () => { await sync(); synced = true; });
      }
      return handle;
    });
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.isError, true);
    assert.match(result.content, /partially failed/);
    assert.equal(await fs.readFile(path.join(f.root, 'target'), 'utf8'), 'new');
    assert.equal(f.checkpoints[0]!.incomplete, true);
    assert.deepEqual(f.checkpoints[0]!.files, []);
    assert.match(f.checkpoints[0]!.warnings.join(' '), /Could not capture postimage/);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('cancellation during parent creation stops further directories and records directory effects', async (t) => {
  const f = await fixture();
  try {
    const prepared = await f.tool.prepare({ changes: [change('new/deep/file', null, 'content')] }, f.context);
    const mkdir = fs.mkdir;
    t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
      const result = await mkdir(...args);
      if (String(args[0]) === path.join(f.root, 'new')) f.controller.abort();
      return result;
    });
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.isError, true);
    assert.equal((await fs.stat(path.join(f.root, 'new'))).isDirectory(), true);
    await assert.rejects(fs.stat(path.join(f.root, 'new/deep')), { code: 'ENOENT' });
    assert.deepEqual(f.checkpoints[0]!.files, []);
    assert.match(f.checkpoints[0]!.warnings.join(' '), /Created 1 parent.*restoration does not remove/);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('a partial multibyte write is explicitly marked outside the text checkpoint representation', async (t) => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'target'), 'abcd');
    const prepared = await f.tool.prepare({ changes: [change('target', 'abcd', '😀')] }, f.context);
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filename: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const handle = await originalOpen(filename, flags, mode);
      if (String(filename) === path.join(f.root, 'target') && typeof flags === 'number' && (flags & constants.O_RDWR) === constants.O_RDWR) {
        const write = handle.write.bind(handle);
        let writes = 0;
        t.mock.method(handle, 'write', async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (writes++ > 0) throw new Error('simulated short UTF-8 write failure');
          return write(buffer, offset, Math.min(2, length), position);
        });
      }
      return handle;
    });
    const result = await f.tool.execute(prepared, f.context);
    assert.equal(result.isError, true);
    assert.equal((await fs.readFile(path.join(f.root, 'target'))).toString('hex'), 'f09f6364');
    assert.deepEqual(f.checkpoints[0]!.files, []);
    assert.equal(f.checkpoints[0]!.incomplete, true);
    assert.match(f.checkpoints[0]!.warnings.join(' '), /Could not capture postimage/);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('patch locks block concurrent effects and remain held through checkpoint persistence', async () => {
  const f = await fixture();
  const lockPath = path.join(f.root, 'effects.sqlite');
  const context = { ...f.context, executionLockPath: lockPath };
  let held: ReturnType<typeof acquireExecutionLock> | undefined;
  try {
    held = acquireExecutionLock(lockPath);
    const blocked = await f.tool.prepare({ changes: [change('new', null, 'approved')] }, context);
    await assert.rejects(f.tool.execute(blocked, context), hasCode('COMMAND_EFFECTS_BUSY'));
    await assert.rejects(fs.stat(path.join(f.root, 'new')), { code: 'ENOENT' });
    held.release(true); held = undefined;
    const prepared = await f.tool.prepare({ changes: [change('new', null, 'approved')] }, context);
    const result = await f.tool.execute(prepared, { ...context, recordCheckpoint(checkpoint) {
      assert.throws(() => assertExecutionLockAvailable(lockPath), hasCode('COMMAND_EFFECTS_BUSY'));
      f.context.recordCheckpoint(checkpoint);
    } });
    assert.equal(result.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, 'new'), 'utf8'), 'approved');
    assertExecutionLockAvailable(lockPath);
    const bound = await f.tool.prepare({ changes: [change('another', null, 'approved')] }, context);
    await assert.rejects(f.tool.execute(bound, f.context), hasCode('PATCH_APPROVAL_STALE'));
  } finally { held?.release(true); await f.cleanup(); }
});

test('orphaned effects and checkpoint persistence gaps leave a durable block on new patch effects', async () => {
  const f = await fixture();
  const lockPath = path.join(f.root, 'effects.sqlite');
  const context = { ...f.context, executionLockPath: lockPath };
  try {
    const prepared = await f.tool.prepare({ changes: [change('new', null, 'created')] }, context);
    await assert.rejects(f.tool.execute(prepared, { ...context, recordCheckpoint() { throw new Error('database lost'); } }), hasCode('PATCH_CHECKPOINT_FAILED'));
    assert.equal(await fs.readFile(path.join(f.root, 'new'), 'utf8'), 'created');
    assert.throws(() => assertExecutionLockAvailable(lockPath), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
    const next = await f.tool.prepare({ changes: [change('another', null, 'must not be written')] }, context);
    await assert.rejects(f.tool.execute(next, context), hasCode('COMMAND_CLEANUP_UNCERTAIN'));
    await assert.rejects(fs.stat(path.join(f.root, 'another')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
