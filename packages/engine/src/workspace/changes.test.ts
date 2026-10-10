import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { Checkpoint } from '@moodcode/contracts';
import { openWorkspace } from './index.js';
import { WorkspaceChangeHub, type WorkspaceChangeEvent, type WorkspaceChangeHubOptions } from './changes.js';

const exec = promisify(execFile);
const hash = (value: string | null) => value === null ? null : createHash('sha256').update(value).digest('hex');
const errorCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Change hub operation did not settle')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function nextChange(iterator: AsyncIterableIterator<WorkspaceChangeEvent>, path: string) {
  return deadline((async () => { for (;;) { const item = await iterator.next(); assert.equal(item.done, false); if (item.value.type === 'change' && item.value.change.path === path) return item.value; } })());
}
async function fixture(t: TestContext, options: WorkspaceChangeHubOptions = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'moodcode-change-hub-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repo'); await mkdir(root);
  const git = (...args: string[]) => exec('git', ['-C', root, '-c', 'user.name=Moodcode Test', '-c', 'user.email=test@localhost', ...args]);
  await git('init', '--initial-branch=main');
  await writeFile(join(root, 'tracked.txt'), 'before'); await writeFile(join(root, 'marker.txt'), '0');
  await git('add', '.'); await git('commit', '-m', 'Change fixture');
  const workspace = await openWorkspace(root);
  const hub = new WorkspaceChangeHub({ observer: { intervalMs: 50 }, ...options });
  t.after(() => hub.close());
  await hub.watch(workspace);
  const checkpoint = (before: string | null, after: string | null, path = 'tracked.txt', checkpointId = 'checkpoint-1'): Checkpoint => ({
    id: checkpointId, runId: 'r1', toolCallId: 'tool1', kind: 'patch', createdAt: new Date().toISOString(), warnings: [],
    files: [{ path, before, after, beforeHash: hash(before), afterHash: hash(after) }],
  });
  const record = (value: Checkpoint, signal?: AbortSignal) => hub.recordCheckpoint({ workspace, sessionId: 's1', runId: 'r1', toolCallId: 'tool1', turnId: 't1', attemptId: 'a1', checkpoints: [value], ...(signal ? { signal } : {}) });
  return { root, temporary, workspace, hub, checkpoint, record };
}

test('internal checkpoints and delayed external polls share one change identity and document version', async t => {
  const f = await fixture(t);
  assert.equal(f.hub.getDocument(f.workspace.id, 'tracked.txt')!.documentVersion, 1);
  assert.deepEqual(f.hub.replay(f.workspace.id), []);
  const subscriber = f.hub.subscribe(f.workspace.id);
  await writeFile(join(f.root, 'tracked.txt'), 'after');
  const [change] = await f.record(f.checkpoint('before', 'after'));
  assert.ok(change); assert.equal(change.documentVersion, 2);
  assert.deepEqual(change.toolOwners, [{ sessionId: 's1', runId: 'r1', toolCallId: 'tool1', turnId: 't1', attemptId: 'a1', checkpointId: 'checkpoint-1' }]);
  // A different file forces a completed real poll after the checkpoint. The
  // tracked file's delayed external observation must not add another change.
  await writeFile(join(f.root, 'marker.txt'), '1');
  await nextChange(subscriber, 'marker.txt');
  const tracked = f.hub.replay(f.workspace.id).filter(event => event.type === 'change' && event.change.path === 'tracked.txt');
  assert.equal(tracked.length, 1); assert.equal(tracked[0]!.type, 'change');
  assert.equal(tracked[0]!.change.changeId, change.changeId);
  assert.equal(f.hub.getDocument(f.workspace.id, 'tracked.txt')!.documentVersion, 2);
  const count = f.hub.replay(f.workspace.id).length;
  assert.equal((await f.record(f.checkpoint('before', 'after')))[0]!.changeId, change.changeId);
  assert.equal(f.hub.replay(f.workspace.id).length, count);
  change.toolOwners[0]!.runId = 'mutated';
  assert.equal((await f.record(f.checkpoint('before', 'after')))[0]!.toolOwners[0]!.runId, 'r1');
});

test('an external observation receives later tool attribution without another LSP document change', async t => {
  const f = await fixture(t); const subscriber = f.hub.subscribe(f.workspace.id);
  await writeFile(join(f.root, 'tracked.txt'), 'after');
  const observed = await nextChange(subscriber, 'tracked.txt');
  assert.deepEqual(observed.change.sources, ['external']); assert.deepEqual(observed.change.toolOwners, []);
  const [bound] = await f.record(f.checkpoint('before', 'after'));
  assert.equal(bound!.changeId, observed.change.changeId); assert.equal(bound!.documentVersion, observed.change.documentVersion);
  assert.deepEqual(bound!.sources, ['external', 'tool']);
  const attribution = await deadline(subscriber.next());
  assert.equal(attribution.value.type, 'attribution'); assert.equal(attribution.value.change.changeId, observed.change.changeId);
  // LSP bridges subscribe only to canonical change events; attribution updates
  // the owner journal but cannot emit a second didChange for that version.
  assert.equal(f.hub.replay(f.workspace.id).filter(event => event.type === 'change').length, 1);
});

test('superseded checkpoint hashes are rechecked against disk and never claim external contents', async t => {
  const f = await fixture(t, { observer: { intervalMs: 60_000 } });
  await writeFile(join(f.root, 'tracked.txt'), 'tool output');
  const checkpoint = f.checkpoint('before', 'tool output');
  await writeFile(join(f.root, 'tracked.txt'), 'external output');
  assert.deepEqual(await f.record(checkpoint), []);
  const events = f.hub.replay(f.workspace.id);
  assert.ok(events.some(event => event.type === 'incomplete' && event.code === 'CHECKPOINT_CHANGE_SUPERSEDED'));
  const changes = events.filter(event => event.type === 'change'); assert.equal(changes.length, 1);
  assert.equal(changes[0]!.change.afterHash, hash('external output')); assert.deepEqual(changes[0]!.change.sources, ['external']); assert.deepEqual(changes[0]!.change.toolOwners, []);
});

test('creation, deletion and recreation advance versions, with exact checkpoint owner and content validation', async t => {
  const f = await fixture(t, { observer: { intervalMs: 60_000 } });
  await writeFile(join(f.root, 'new.txt'), 'one');
  const first = (await f.record(f.checkpoint(null, 'one', 'new.txt', 'c1')))[0]!;
  assert.equal(first.kind, 'created'); assert.equal(first.documentVersion, 1);
  await rm(join(f.root, 'new.txt'));
  const second = (await f.record(f.checkpoint('one', null, 'new.txt', 'c2')))[0]!;
  assert.equal(second.kind, 'deleted'); assert.equal(second.documentVersion, 2);
  await writeFile(join(f.root, 'new.txt'), 'two');
  const third = (await f.record(f.checkpoint(null, 'two', 'new.txt', 'c3')))[0]!;
  assert.equal(third.kind, 'created'); assert.equal(third.documentVersion, 3);
  await assert.rejects(f.record(f.checkpoint(null, 'wrong', 'new.txt', 'c1')), errorCode('CHECKPOINT_CHANGE_CONFLICT'));
  await assert.rejects(f.record({ ...f.checkpoint(null, 'two', 'new.txt'), runId: 'alien' }), errorCode('CHECKPOINT_CHANGE_OWNER_MISMATCH'));
  const forged = f.checkpoint(null, 'two', 'new.txt'); forged.files[0]!.afterHash = hash('forged');
  await assert.rejects(f.record(forged), errorCode('INVALID_CHANGE_CHECKPOINT'));
});

test('a later checkpoint cannot rewrite an already observed transition with a different before hash', async t => {
  const f = await fixture(t); const subscriber = f.hub.subscribe(f.workspace.id);
  await writeFile(join(f.root, 'tracked.txt'), 'intermediate'); await nextChange(subscriber, 'tracked.txt');
  await writeFile(join(f.root, 'tracked.txt'), 'after'); await nextChange(subscriber, 'tracked.txt');
  assert.deepEqual(await f.record(f.checkpoint('before', 'after')), []);
  const changes = f.hub.replay(f.workspace.id).filter(event => event.type === 'change');
  assert.equal(changes.length, 2); assert.equal(changes[1]!.change.beforeHash, hash('intermediate'));
  assert.equal(f.hub.getDocument(f.workspace.id, 'tracked.txt')!.documentVersion, 3);
  assert.ok(f.hub.replay(f.workspace.id).some(event => event.type === 'incomplete' && event.code === 'CHECKPOINT_CHANGE_TRANSITION_MISMATCH'));
});

test('subscriber cancellation, backpressure, cursor eviction and hub close are bounded and clean listeners', async t => {
  const f = await fixture(t, { observer: { intervalMs: 60_000 }, limits: { historyEvents: 2, subscriberBytes: 900, maxSubscribers: 1 } });
  const controller = new AbortController(), subscriber = f.hub.subscribe(f.workspace.id, 0, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  assert.throws(() => f.hub.subscribe(f.workspace.id), errorCode('WORKSPACE_CHANGE_SUBSCRIBER_LIMIT'));
  for (const [index, content] of ['one', 'two', 'three'].entries()) {
    await writeFile(join(f.root, 'tracked.txt'), content);
    await f.record(f.checkpoint(index === 0 ? 'before' : ['one', 'two'][index - 1]!, content, 'tracked.txt', `c${index}`));
  }
  await assert.rejects(subscriber.next(), errorCode('WORKSPACE_CHANGE_BACKPRESSURE'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.throws(() => f.hub.replay(f.workspace.id, 0), errorCode('WORKSPACE_CHANGE_CURSOR_EXPIRED'));
  const sequence = f.hub.replay(f.workspace.id, 1, 2).at(-1)!.seq;
  const pending = f.hub.subscribe(f.workspace.id, sequence, controller.signal);
  const next = pending.next(); controller.abort(); assert.equal((await next).done, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const after = f.hub.subscribe(f.workspace.id, sequence); const waiting = after.next();
  await deadline(f.hub.close()); assert.equal((await waiting).done, true);
  await assert.rejects(f.hub.watch(f.workspace), errorCode('ENGINE_CLOSED'));
});

test('history byte limits cannot retain an unbounded rejected change index or abort listeners', async t => {
  const f = await fixture(t, { observer: { intervalMs: 60_000 }, limits: { historyBytes: 180, subscriberBytes: 1 } });
  for (let index = 0; index < 10; index++) { await writeFile(join(f.root, 'tracked.txt'), String(index)); await f.record(f.checkpoint(index === 0 ? 'before' : String(index - 1), String(index), 'tracked.txt', `c${index}`)); }
  const entries = Reflect.get(f.hub, 'entries') as Map<string, { changes: Map<string, unknown> }>;
  assert.equal(entries.get(f.workspace.id)!.changes.size, 0);
  const controller = new AbortController(); const subscriber = f.hub.subscribe(f.workspace.id, 0, controller.signal);
  await assert.rejects(subscriber.next(), errorCode('WORKSPACE_CHANGE_BACKPRESSURE'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.hub.getDocument(f.workspace.id, 'tracked.txt')!.hash, hash('9'));
});

test('a restarted subscriber resumes after its cursor only while the retained replay fits one queue', async t => {
  const f = await fixture(t, { observer: { intervalMs: 60_000 }, limits: { historyEvents: 3, subscriberBytes: 900 } });
  for (const [index, content] of ['one', 'two', 'three', 'four'].entries()) {
    await writeFile(join(f.root, 'tracked.txt'), content);
    await f.record(f.checkpoint(index === 0 ? 'before' : ['one', 'two', 'three'][index - 1]!, content, 'tracked.txt', `c${index}`));
  }
  assert.deepEqual(f.hub.replay(f.workspace.id, 1).map(event => event.seq), [2, 3, 4]);
  assert.equal(f.hub.resumeCursor(f.workspace.id, 4), 4);
  assert.equal(f.hub.resumeCursor(f.workspace.id, 3), 3);
  assert.equal(f.hub.resumeCursor(f.workspace.id, 1), 4, 'a retained replay larger than one queue resumes at the head');
  assert.equal(f.hub.resumeCursor(f.workspace.id, 0), 4, 'an expired cursor resumes at the head');
  const resumed = f.hub.subscribe(f.workspace.id, f.hub.resumeCursor(f.workspace.id, 3));
  assert.equal((await resumed.next()).value.seq, 4);
  await resumed.return?.();
});

test('root replacement and symlink files cannot produce fabricated deletions or tool attribution', async t => {
  const f = await fixture(t, { observer: { intervalMs: 60_000 } });
  await writeFile(join(f.temporary, 'outside.txt'), 'after');
  await rm(join(f.root, 'tracked.txt')); await symlink(join(f.temporary, 'outside.txt'), join(f.root, 'tracked.txt'));
  assert.deepEqual(await f.record(f.checkpoint('before', 'after')), []);
  assert.equal(f.hub.getDocument(f.workspace.id, 'tracked.txt')!.hash, hash('before'));
  assert.ok(f.hub.replay(f.workspace.id).some(event => event.type === 'incomplete' && event.code === 'WORKSPACE_FILE_UNOBSERVED'));
  await rename(f.root, join(f.temporary, 'old-repo')); await mkdir(f.root); await writeFile(join(f.root, 'tracked.txt'), 'after');
  assert.deepEqual(await f.record(f.checkpoint('before', 'after', 'tracked.txt', 'c2')), []);
  assert.ok(f.hub.replay(f.workspace.id).some(event => event.type === 'incomplete' && event.code === 'WORKSPACE_ROOT_CHANGED'));
  assert.equal(f.hub.replay(f.workspace.id).some(event => event.type === 'change'), false);
});

test('watch ownership, cancellation and registration caps are explicit', async t => {
  const f = await fixture(t, { limits: { maxWorkspaces: 1 } });
  await assert.rejects(f.hub.watch({ ...f.workspace, root: `${f.root}/different` }), errorCode('WORKSPACE_CHANGE_SCOPE_MISMATCH'));
  await assert.rejects(f.hub.watch({ ...f.workspace, id: 'another' }), errorCode('WORKSPACE_WATCH_LIMIT'));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.record(f.checkpoint('before', 'after'), cancelled.signal), errorCode('ABORTED'));
  const signal = new AbortController(); await f.hub.watch(f.workspace, { signal: signal.signal });
  const pending = f.hub.subscribe(f.workspace.id).next(); signal.abort(); assert.equal((await deadline(pending)).done, true);
  await assert.rejects(f.hub.watch(f.workspace), errorCode('WORKSPACE_WATCH_CLOSED'));
});

test('repeated watches with one signal keep one abort listener until the hub closes', async t => {
  const f = await fixture(t, { observer: { intervalMs: 60_000 } });
  const controller = new AbortController();
  for (let index = 0; index < 3; index++) await f.hub.watch(f.workspace, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  await deadline(f.hub.close());
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a failed observer restarts on the next watch and reconciles the gap without duplicates', async t => {
  const f = await fixture(t); const failed = f.hub.subscribe(f.workspace.id);
  const moved = join(f.temporary, 'moved'); await rename(f.root, moved);
  await assert.rejects(deadline((async () => { for (;;) await failed.next(); })()), errorCode('WORKSPACE_OBSERVER_FAILED'));
  await writeFile(join(moved, 'marker.txt'), '1'); await rm(join(moved, 'tracked.txt'));
  await rename(moved, f.root);
  await f.hub.watch(f.workspace);
  const marker = f.hub.subscribe(f.workspace.id), tracked = f.hub.subscribe(f.workspace.id);
  const [changed, deleted] = await Promise.all([nextChange(marker, 'marker.txt'), nextChange(tracked, 'tracked.txt')]);
  assert.equal(changed.change.kind, 'changed'); assert.equal(changed.change.documentVersion, 2); assert.deepEqual(changed.change.sources, ['external']);
  assert.equal(deleted.change.kind, 'deleted'); assert.equal(deleted.change.documentVersion, 2);
  await writeFile(join(f.root, 'tracked.txt'), 'again');
  const created = await nextChange(tracked, 'tracked.txt');
  assert.equal(created.change.kind, 'created'); assert.equal(created.change.documentVersion, 3);
  const events = f.hub.replay(f.workspace.id);
  assert.ok(events.some(event => event.type === 'incomplete' && event.code === 'WORKSPACE_OBSERVER_FAILED'));
  assert.equal(events.filter(event => event.type === 'change').length, 3);
});

test('an observer failure before the initial observation does not stick to later watches', async t => {
  const f = await fixture(t, { observer: { intervalMs: 60_000 } });
  const hub = new WorkspaceChangeHub({ observer: { intervalMs: 60_000 } }); t.after(() => hub.close());
  const moved = join(f.temporary, 'moved'); await rename(f.root, moved);
  await assert.rejects(deadline(hub.watch(f.workspace)), (error: unknown) => error instanceof Error && 'code' in error);
  await rename(moved, f.root);
  await deadline(hub.watch(f.workspace));
  assert.equal(hub.getDocument(f.workspace.id, 'tracked.txt')!.documentVersion, 1);
});
