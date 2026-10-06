import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type Checkpoint, type SubmitInput, type ToolCallRecord } from '@moodcode/contracts';
import { SqliteStore } from './index.js';
import { DB_VERSION } from './migrations.js';

const now = '2026-10-04T00:00:00.000Z';
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-maintenance-')));
  const source = join(directory, 'source.sqlite');
  const destination = join(directory, 'archive', 'backup.sqlite');
  const store = new SqliteStore(source);
  const stores = [store];
  t.after(() => { for (const current of stores) current.close(); rmSync(directory, { recursive: true, force: true }); });
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: now });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Backup fixture', createdAt: now });
  const input: SubmitInput = { sessionId: 'session', requestId: 'terminal-request', prompt: 'Persist terminal and active runs', config: { providerId: 'scripted', modelId: 'local', mode: 'build', limits: { ...DEFAULT_LIMITS } } };
  return { directory, source, destination, store, stores, input };
}

function populate(store: SqliteStore, input: SubmitInput) {
  const receipt = store.admit(input);
  store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  const tool: ToolCallRecord = { id: 'tool', sessionId: input.sessionId, runId: receipt.runId, name: 'apply_patch', input: { changes: [] }, state: 'running' };
  store.commit(receipt.runId, 'tool.running', {}, { tool });
  const checkpoint: Checkpoint = { id: 'checkpoint', runId: receipt.runId, toolCallId: tool.id, kind: 'patch', createdAt: now, files: [{ path: 'example.txt', before: 'before', after: 'after', beforeHash: 'before-hash', afterHash: 'after-hash' }], warnings: ['External effects are outside the backup'] };
  store.commit(receipt.runId, 'workspace.changed', {}, { checkpoint });
  store.commit(receipt.runId, 'tool.completed', {}, { tool: { ...tool, state: 'completed', output: 'committed outcome' } });
  store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const active = store.admit({ ...input, requestId: 'active-request' });
  store.commit(active.runId, 'run.started', {}, { run: { state: 'running' } });
  return { terminalId: receipt.runId, activeId: active.runId, checkpoint };
}

test('integrity check includes SQLite structure, foreign keys and supported schema version without recording events', (t) => {
  const { store, input, source } = fixture(t);
  const { terminalId } = populate(store, input);
  const before = store.getSnapshot(input.sessionId);
  assert.deepEqual(store.integrityCheck(), { ok: true, schemaVersion: DB_VERSION, errors: [], foreignKeyViolations: [] });
  assert.deepEqual(store.getSnapshot(input.sessionId), before);
  const external = new DatabaseSync(source);
  try {
    external.exec('PRAGMA foreign_keys=OFF');
    external.prepare('UPDATE checkpoints SET run_id=? WHERE id=?').run('missing-run', 'checkpoint');
    const integrity = store.integrityCheck();
    assert.equal(integrity.ok, false);
    assert.deepEqual(integrity.errors, []);
    assert.equal(integrity.foreignKeyViolations[0]?.table, 'checkpoints');
    external.prepare('UPDATE checkpoints SET run_id=? WHERE id=?').run(terminalId, 'checkpoint');
    external.exec('PRAGMA ignore_check_constraints=ON; UPDATE sessions SET last_seq=-1');
    const structural = store.integrityCheck();
    assert.equal(structural.ok, false);
    assert.match(structural.errors.join('\n'), /CHECK constraint failed in sessions/);
    external.prepare('UPDATE sessions SET last_seq=? WHERE id=?').run(before.lastSeq, input.sessionId);
    external.exec('PRAGMA ignore_check_constraints=OFF');
    external.exec('PRAGMA user_version=99');
    const version = store.integrityCheck();
    assert.equal(version.ok, false);
    assert.equal(version.schemaVersion, 99);
    assert.match(version.errors[0]!, /version 99/);
    external.exec(`PRAGMA user_version=${DB_VERSION}`);
    assert.equal(store.integrityCheck().ok, true);
  } finally { external.close(); }
});

test('native backup includes uncheckpointed WAL rows and produces a standalone restorable SQLite file', async (t) => {
  const { store, input, source, destination, directory, stores } = fixture(t);
  const { terminalId, activeId, checkpoint } = populate(store, input);
  assert.equal(existsSync(`${source}-wal`), true);
  assert.ok(statSync(`${source}-wal`).size > 0);
  const before = store.getSnapshot(input.sessionId);
  const journal = store.readEvents(input.sessionId, 0, 1_024);
  writeFileSync(join(directory, 'external-effect.txt'), 'Keep this effect outside the SQLite archive');
  writeFileSync(`${source}.effects.sqlite`, 'Unrelated effect bookkeeping fixture');
  const result = await store.backup(destination);
  assert.equal(result.destination, destination);
  assert.equal(result.schemaVersion, DB_VERSION);
  assert.ok(result.bytes > 0);
  assert.equal(result.bytes, statSync(destination).size);
  assert.deepEqual(readdirSync(join(directory, 'archive')), ['backup.sqlite']);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(store.getSnapshot(input.sessionId), before);
  assert.deepEqual(store.readEvents(input.sessionId, 0, 1_024), journal);
  const rawBackup = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(rawBackup.prepare('PRAGMA user_version').get()?.user_version, DB_VERSION);
    assert.equal(rawBackup.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
    assert.equal(rawBackup.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally { rawBackup.close(); }

  // Opening a restored store preserves committed state until explicit recovery is requested.
  const restored = new SqliteStore(destination);
  stores.push(restored);
  assert.deepEqual(restored.getSnapshot(input.sessionId), before);
  assert.deepEqual(restored.readEvents(input.sessionId, 0, 1_024), journal);
  assert.deepEqual(restored.listCheckpoints(terminalId), [checkpoint]);
  assert.equal(restored.getRun(terminalId).state, 'completed');
  assert.equal(restored.getRun(activeId).state, 'running');
  assert.equal(restored.integrityCheck().ok, true);
  assert.equal(restored.recoverInterrupted()[0]?.id, activeId);
  assert.equal(restored.getRun(activeId).state, 'interrupted');
  assert.equal(store.getRun(activeId).state, 'running');
  assert.equal(readFileSync(join(directory, 'external-effect.txt'), 'utf8'), 'Keep this effect outside the SQLite archive');
});

test('WAL mutations while native backup runs preserve event and projection consistency', async (t) => {
  const { store, input, destination, stores } = fixture(t);
  const { activeId } = populate(store, input);
  const activeTool: ToolCallRecord = { id: 'active-approval-tool', sessionId: input.sessionId, runId: activeId, name: 'run_command', input: { command: 'fixture only' }, state: 'awaiting_approval' };
  store.commit(activeId, 'approval.requested', {}, {
    tool: activeTool,
    approval: { id: 'active-approval', sessionId: input.sessionId, runId: activeId, toolCallId: activeTool.id, toolName: activeTool.name, fingerprint: 'fixture-fingerprint', preview: {}, status: 'pending', createdAt: now },
  });
  // Force several native steps while keeping this a local SQLite fixture.
  for (let i = 0; i < 90; i++) store.commit(activeId, 'message.delta', { delta: `${i}:${'x'.repeat(8_192)}` });
  const before = store.getSnapshot(input.sessionId);
  const beforeJournal = store.readEvents(input.sessionId, 0, 1_024);
  const pending = store.backup(destination);
  store.commit(activeId, 'run.completed', { marker: 'During backup' }, { run: { state: 'completed' } });
  assert.equal(store.getApproval('active-approval').status, 'expired');
  await pending;
  const restored = new SqliteStore(destination);
  stores.push(restored);
  const snapshot = restored.getSnapshot(input.sessionId);
  const journal = restored.readEvents(input.sessionId, 0, 1_024);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(journal, beforeJournal);
  assert.equal(restored.getApproval('active-approval').status, 'pending');
  const completed = journal.some(event => event.runId === activeId && event.type === 'run.completed');
  assert.equal(snapshot.runs.find(run => run.id === activeId)?.state, completed ? 'completed' : 'running');
  assert.equal(snapshot.lastSeq, journal.at(-1)?.seq);
  assert.deepEqual(journal.map(event => event.seq), Array.from({ length: snapshot.lastSeq }, (_, i) => i + 1));
  assert.equal(restored.integrityCheck().ok, true);
});

test('pre-abort and in-flight abort reject and clean private partial files; source remains usable', async (t) => {
  const { store, input, destination, directory } = fixture(t);
  const { activeId } = populate(store, input);
  await assert.rejects(store.backup(destination, { signal: AbortSignal.abort() }), code('BACKUP_ABORTED'));
  assert.equal(existsSync(join(directory, 'archive')), false);
  for (let i = 0; i < 70; i++) store.commit(activeId, 'message.delta', { delta: 'x'.repeat(8_192) });
  const controller = new AbortController();
  const pending = store.backup(destination, { signal: controller.signal });
  controller.abort(new Error('Private reason must not be copied to database'));
  await assert.rejects(pending, code('BACKUP_ABORTED'));
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(join(directory, 'archive')), []);
  assert.equal(store.getRun(activeId).state, 'running');
  assert.equal(store.integrityCheck().ok, true);
  await store.backup(destination);
  assert.equal(existsSync(destination), true);
});

test('close cancels in-flight backups and releases the owner only after native cleanup settles', async (t) => {
  const { store, source, input, destination, directory, stores } = fixture(t);
  const { activeId } = populate(store, input);
  for (let i = 0; i < 70; i++) store.commit(activeId, 'message.delta', { delta: 'x'.repeat(8_192) });
  const pending = store.backup(destination);
  store.close();
  assert.throws(() => new SqliteStore(source), code('DB_LOCKED'));
  assert.throws(() => store.integrityCheck(), code('STORE_CLOSED'));
  await assert.rejects(pending, code('STORE_CLOSED'));
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(join(directory, 'archive')), []);
  const successor = new SqliteStore(source);
  stores.push(successor);
  assert.equal(successor.getRun(activeId).state, 'running');
  assert.equal(successor.integrityCheck().ok, true);
  await assert.rejects(store.backup(join(directory, 'after-close.sqlite')), code('STORE_CLOSED'));
});

test('closeAsync waits for parallel backup cancellation, cleanup and owner release and tolerates repeated closes', async (t) => {
  const { store, source, input, destination, directory, stores } = fixture(t);
  const { activeId } = populate(store, input);
  for (let i = 0; i < 70; i++) store.commit(activeId, 'message.delta', { delta: 'x'.repeat(8_192) });
  const second = join(directory, 'second-backup.sqlite');
  const controller = new AbortController();
  const pending = [store.backup(destination, { signal: controller.signal }), store.backup(second)];
  const settled = Promise.allSettled(pending);
  controller.abort();
  const close = store.closeAsync();
  const repeated = store.closeAsync();
  store.close();
  let fullyClosed = false;
  void close.then(() => { fullyClosed = true; });
  assert.equal(fullyClosed, false);
  assert.throws(() => new SqliteStore(source), code('DB_LOCKED'));
  await Promise.all([close, repeated]);
  const outcomes = await settled;
  assert.equal(fullyClosed, true);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.reason instanceof EngineError, true);
  }
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(second), false);
  assert.deepEqual(readdirSync(join(directory, 'archive')), []);
  assert.equal(readdirSync(directory).some(name => name.startsWith('.moodcode-backup-')), false);
  const successor = new SqliteStore(source);
  stores.push(successor);
  assert.equal(successor.integrityCheck().ok, true);
  await store.closeAsync();
  store.close();
});

test('closeAsync surfaces native connection release failures consistently after double close', async (t) => {
  const { store } = fixture(t);
  const sourceDb = (store as unknown as { db: DatabaseSync }).db;
  const nativeClose = sourceDb.close.bind(sourceDb);
  const injected = t.mock.method(sourceDb, 'close', () => { throw new Error('Injected SQLite release failure'); });
  try {
    await assert.rejects(store.closeAsync(), code('STORE_CLOSE_FAILED'));
    await assert.rejects(store.closeAsync(), code('STORE_CLOSE_FAILED'));
    assert.equal(injected.mock.callCount(), 1);
    store.close();
  } finally { injected.mock.restore(); nativeClose(); }
});

test('closeAsync and a cancelling backup both surface release errors after the native job settles', async (t) => {
  const { store, input, destination, directory } = fixture(t);
  const { activeId } = populate(store, input);
  for (let i = 0; i < 40; i++) store.commit(activeId, 'message.delta', { delta: 'x'.repeat(8_192) });
  const sourceDb = (store as unknown as { db: DatabaseSync }).db;
  const nativeClose = sourceDb.close.bind(sourceDb);
  const pending = store.backup(destination);
  const injected = t.mock.method(sourceDb, 'close', () => { throw new Error('Injected deferred SQLite release failure'); });
  try {
    const outcomes = await Promise.allSettled([pending, store.closeAsync()]);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') assert.equal(code('STORE_CLOSE_FAILED')(outcome.reason), true);
    }
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(join(directory, 'archive')), []);
    await assert.rejects(store.closeAsync(), code('STORE_CLOSE_FAILED'));
    assert.equal(injected.mock.callCount(), 1);
  } finally { injected.mock.restore(); nativeClose(); }
});

test('backup validation failure cleans partial output for corrupted foreign keys and unsupported version', async (t) => {
  const { store, source, input, destination, directory } = fixture(t);
  const { terminalId } = populate(store, input);
  const external = new DatabaseSync(source);
  try {
    external.exec('PRAGMA foreign_keys=OFF');
    external.prepare('UPDATE checkpoints SET run_id=? WHERE id=?').run('missing-run', 'checkpoint');
    await assert.rejects(store.backup(destination), code('DB_INTEGRITY_FAILED'));
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(join(directory, 'archive')), []);
    external.prepare('UPDATE checkpoints SET run_id=? WHERE id=?').run(terminalId, 'checkpoint');
    external.exec('PRAGMA user_version=99');
    await assert.rejects(store.backup(destination), code('DB_VERSION_UNSUPPORTED'));
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(join(directory, 'archive')), []);
    external.exec(`PRAGMA user_version=${DB_VERSION}`);
  } finally { external.close(); }
  await store.backup(destination);
  assert.equal(existsSync(destination), true);
});

test('parallel backups settle independently and memory stores can export restorable file databases', async (t) => {
  const { directory, destination, stores } = fixture(t);
  const memory = new SqliteStore(':memory:');
  stores.push(memory);
  memory.putWorkspace({ id: 'memory-workspace', root: '/memory', gitRoot: '/memory', branch: null, createdAt: now });
  const other = join(directory, 'other', 'backup.sqlite');
  const outputs = await Promise.all([memory.backup(destination), memory.backup(other)]);
  assert.equal(outputs.length, 2);
  for (const { destination: file } of outputs) {
    const restored = new SqliteStore(file);
    stores.push(restored);
    assert.equal(restored.listWorkspaces()[0]?.id, 'memory-workspace');
    assert.equal(restored.integrityCheck().ok, true);
  }
});
