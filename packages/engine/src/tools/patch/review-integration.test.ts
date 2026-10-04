import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, type JsonObject } from '@moodcode/contracts';
import type { ToolContext } from '../../ports.js';
import { SqliteStore } from '../../storage/index.js';
import { getReviewDiff, restoreCheckpoint } from '../../review/index.js';
import { assertExecutionLockAvailable } from '../command/execution-lock.js';
import { createPatchTool } from './index.js';

test('a partially written patch persists exact observed images, survives SQLite reopen, and restores the user preimage', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moodcode-patch-review-')));
  const dbPath = path.join(root, 'engine.sqlite');
  const lockPath = path.join(root, 'effects.sqlite');
  let store: SqliteStore | undefined;
  try {
    const original = 'existing user draft, not committed\n';
    await fs.writeFile(path.join(root, 'edited.txt'), original);
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'unrelated user work\n');
    store = new SqliteStore(dbPath);
    const workspace = store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() });
    store.createSession({ id: 'session', workspaceId: workspace.id, title: 'partial patch', createdAt: workspace.createdAt });
    const receipt = store.admit({ sessionId: 'session', requestId: 'request', prompt: 'patch', config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS } } });
    store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
    const input: JsonObject = { changes: [{ path: 'created.txt', expectedHash: null, content: 'created\n' }, { path: 'edited.txt', expectedHash: createHash('sha256').update(original).digest('hex'), content: 'new' }] };
    const toolRecord = { id: 'patch-call', runId: receipt.runId, sessionId: 'session', name: 'apply_patch', input, state: 'running' as const };
    store.commit(receipt.runId, 'tool.running', {}, { tool: toolRecord });
    const context: ToolContext = {
      workspace, sessionId: 'session', runId: receipt.runId, toolCallId: toolRecord.id,
      signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: root, executionLockPath: lockPath,
      recordCheckpoint(checkpoint) { store!.commit(receipt.runId, 'workspace.changed', { checkpointId: checkpoint.id }, { checkpoint }); },
    };
    const tool = createPatchTool();
    const prepared = await tool.prepare(input, context);
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (filename: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const handle = await originalOpen(filename, flags, mode);
      if (String(filename) === path.join(root, 'edited.txt') && typeof flags === 'number' && (flags & constants.O_RDWR) === constants.O_RDWR) t.mock.method(handle, 'truncate', async () => { throw new Error('simulated partial patch failure'); });
      return handle;
    });
    const result = await tool.execute(prepared, context);
    t.mock.restoreAll();
    assert.equal(result.isError, true);
    const partial = await fs.readFile(path.join(root, 'edited.txt'), 'utf8');
    assert.equal(partial, 'new' + original.slice(3));
    assertExecutionLockAvailable(lockPath);
    store.commit(receipt.runId, 'tool.failed', {}, { tool: { ...toolRecord, state: 'failed', output: result.content } });
    store.commit(receipt.runId, 'run.failed', {}, { run: { state: 'failed', error: { code: 'PARTIAL_PATCH', message: 'simulated failure' } } });
    const beforeClose = getReviewDiff(store, receipt.runId);
    store.close(); store = undefined;
    store = new SqliteStore(dbPath);
    const review = getReviewDiff(store, receipt.runId);
    assert.deepEqual(review, beforeClose);
    assert.equal(review.files.find((file) => file.path === 'edited.txt')!.before, original);
    assert.equal(review.files.find((file) => file.path === 'edited.txt')!.after, partial);
    assert.equal(review.checkpoints[0]!.incomplete, true);
    assert.match(review.warnings.join(' '), /incomplete/);
    const restored = await restoreCheckpoint(store, workspace, review.checkpoints[0]!.id);
    assert.deepEqual(restored.restored, ['created.txt', 'edited.txt']);
    assert.deepEqual(restored.conflicts, []);
    assert.deepEqual(restored.failed, []);
    await assert.rejects(fs.stat(path.join(root, 'created.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'edited.txt'), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'unrelated user work\n');
  } finally { t.mock.restoreAll(); store?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
