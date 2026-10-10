import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { normalizeSubmitInput } from '@moodcode/contracts/validation';
import { SqliteStore } from '../storage/index.js';
import { DB_VERSION } from '../storage/migrations.js';
import { ReviewJournal } from '../review/audit.js';
import { createEngine } from '../engine.js';
import { getRecoveryStatus, isRestoreAcknowledged, readRecoveryAcknowledgments, recoverEngine, RECOVERY_LIMITS } from './index.js';
import { initializeLedger } from './ledger.js';

function hasCode(code: string) { return (error: unknown): boolean => error instanceof EngineError && error.code === code && !JSON.stringify(error).includes('sk-recovery-fixture'); }
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-recovery-test-')));
  const dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
  mkdirSync(artifactDir, { mode: 0o700 });
  const store = new SqliteStore(dbPath);
  const now = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: now });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'fixture', createdAt: now });
  const receipt = store.admit(normalizeSubmitInput({ sessionId: 'session', requestId: 'request', prompt: 'preserve sk-recovery-fixture-private-text' }));
  store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  store.commit(receipt.runId, 'tool.started', {}, { tool: { id: 'tool', runId: receipt.runId, sessionId: 'session', name: 'patch', input: {}, state: 'running' } });
  store.commit(receipt.runId, 'checkpoint.created', {}, { checkpoint: { id: 'checkpoint', runId: receipt.runId, toolCallId: 'tool', kind: 'patch', createdAt: now, files: [], warnings: [] } });
  store.commit(receipt.runId, 'tool.completed', {}, { tool: { id: 'tool', runId: receipt.runId, sessionId: 'session', name: 'patch', input: {}, state: 'completed', output: 'fixture completed' } });
  store.commit(receipt.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const original = store.getSnapshot('session');
  store.close();
  const journal = new ReviewJournal(dbPath + '.review.sqlite');
  const operation = { id: 'restore', checkpointId: 'checkpoint', runId: receipt.runId, sessionId: 'session', workspaceId: 'workspace', fingerprint: 'a'.repeat(64) };
  journal.start(operation);
  const interrupted = journal.recoverPending()[0]!;
  journal.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, dbPath, artifactDir, original, operation, interrupted, options: { dbPath, artifactDir }, effect: dbPath + '.effects.sqlite', review: dbPath + '.review.sqlite', ledger: dbPath + '.recovery.sqlite' };
}
function tree(directory: string): Record<string, { ino: number; data: string }> {
  return Object.fromEntries(readdirSync(directory).filter(name => lstatSync(join(directory, name)).isFile()).map(name => [name, { ino: lstatSync(join(directory, name)).ino, data: readFileSync(join(directory, name)).toString('hex') }]));
}
async function child(t: TestContext, code: string, args: string[] = [], detached = false): Promise<ChildProcess> {
  const instance = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { detached, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; instance.stderr!.on('data', bytes => { stderr += String(bytes); });
  t.after(async () => {
    if (instance.exitCode === null && instance.signalCode === null) { const exited = once(instance, 'exit'); instance.kill('SIGKILL'); await exited; }
  });
  await Promise.race([
    once(instance.stdout!, 'data'),
    once(instance, 'exit').then(() => { throw new Error('Owned child exited before ready: ' + stderr); }),
  ]);
  return instance;
}
async function stoppedPid(t: TestContext): Promise<number> {
  const instance = await child(t, "process.stdout.write('ready');setInterval(()=>{},1000)", [], true);
  const pid = instance.pid!;
  const exited = once(instance, 'exit'); instance.kill('SIGKILL'); await exited;
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
  assert.throws(() => process.kill(-pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
  return pid;
}
function marker(file: string, owner: number, group: number | null, active = true): void {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE command_execution(id INTEGER PRIMARY KEY CHECK(id=1),owner_pid INTEGER NOT NULL CHECK(owner_pid>0),group_pid INTEGER CHECK(group_pid IS NULL OR group_pid>0),active INTEGER NOT NULL CHECK(active IN (0,1)),updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO command_execution VALUES(1,?,?,?,?)').run(owner, group, active ? 1 : 0, new Date().toISOString());
  } finally { db.close(); }
}

test('readonly diagnostics disclose bounded metadata and leave every original byte/inode/sidecar unchanged', async t => {
  const f = fixture(t), before = tree(f.directory);
  const status = await getRecoveryStatus(f.options);
  assert.equal(status.state, 'recoverable');
  assert.equal(status.pendingRestoreCount, 1);
  assert.equal(status.activeRunCount, 0);
  assert.match(status.fingerprint!, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(status), /sk-recovery-fixture|restore|checkpoint|engine\.sqlite|\/private\/|\/Users\//);
  assert.deepEqual(tree(f.directory), before);
  assert.deepEqual(readdirSync(f.artifactDir), []);
});

test('explicit acknowledgment produces verified primary/review backups and exact durable binding without modifying originals', async t => {
  const f = fixture(t), beforeReview = readFileSync(f.review), status = await getRecoveryStatus(f.options);
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: false } as never), hasCode('RECOVERY_ACKNOWLEDGMENT_REQUIRED'));
  assert.equal(readdirSync(f.artifactDir).length, 0);
  const result = await recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true });
  assert.equal(result.restoredAcknowledgments, 1);
  assert.equal(result.effectMarkerCleared, false);
  const acks = readRecoveryAcknowledgments(f.options);
  assert.equal(acks.length, 1);
  assert.equal(isRestoreAcknowledged(f.interrupted, acks), true);
  for (const key of ['id', 'checkpointId', 'runId', 'sessionId', 'workspaceId', 'fingerprint'] as const) assert.equal(isRestoreAcknowledged({ ...f.interrupted, [key]: 'changed' }, acks), false);
  assert.equal(isRestoreAcknowledged({ ...f.interrupted, error: { ...f.interrupted.error!, message: 'changed' } }, acks), false);
  assert.deepEqual(readFileSync(f.review), beforeReview);
  const primary = new SqliteStore(f.dbPath);
  try { assert.deepEqual(primary.getSnapshot('session'), f.original); assert.equal(primary.readEvents('session', 0).at(-1)?.type, 'run.completed'); } finally { primary.close(); }
  for (const name of ['primary', 'review']) {
    const path = join(f.artifactDir, 'recovery', result.recoveryId, name + '.sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, name === 'primary' ? DB_VERSION : 1); assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete'); }
    finally { db.close(); }
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
  }
  assert.equal((await getRecoveryStatus(f.options)).state, 'clear');
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_STALE'));
});

test('dead owned PID and process group are required before the active marker can be cleared', async t => {
  const f = fixture(t), pid = await stoppedPid(t);
  marker(f.effect, pid, pid);
  const status = await getRecoveryStatus(f.options);
  assert.deepEqual(status.marker, { active: true, owner: 'absent', group: 'absent' });
  assert.equal(status.state, 'recoverable');
  const recovered = await recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true });
  assert.equal(recovered.effectMarkerCleared, true);
  const db = new DatabaseSync(f.effect, { readOnly: true });
  try { assert.equal(db.prepare('SELECT active FROM command_execution').get()?.active, 0); } finally { db.close(); }
});

test('an owner PID reused after the audit commit keeps the marker and is reported with the committed acknowledgments', async t => {
  const f = fixture(t), pid = await stoppedPid(t);
  marker(f.effect, pid, pid);
  const status = await getRecoveryStatus(f.options);
  const audited = (): boolean => {
    try { const db = new DatabaseSync(f.ledger, { readOnly: true }); try { return Number(db.prepare('SELECT count(*) AS count FROM recovery_audit').get()?.count) > 0; } finally { db.close(); } }
    catch { return false; }
  };
  const originalKill = process.kill.bind(process);
  const reused = t.mock.method(process, 'kill', (observed: number, signal: NodeJS.Signals | number = 'SIGTERM') => signal === 0 && observed === pid && audited() ? true : originalKill(observed, signal));
  const result = await recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true });
  assert.equal(result.restoredAcknowledgments, 1);
  assert.equal(result.effectMarkerCleared, false);
  assert.equal(result.effectMarkerBlocker, 'PROCESS_OWNER_ALIVE');
  const effect = new DatabaseSync(f.effect, { readOnly: true });
  try { assert.equal(effect.prepare('SELECT active FROM command_execution').get()?.active, 1); } finally { effect.close(); }
  assert.equal(isRestoreAcknowledged(f.interrupted, readRecoveryAcknowledgments(f.options)), true);
  const blocked = await getRecoveryStatus(f.options);
  assert.ok(blocked.blockers.includes('PROCESS_OWNER_ALIVE'));
  assert.equal(blocked.pendingRestoreCount, 0);
  reused.mock.restore();
  const stopped = await getRecoveryStatus(f.options);
  assert.equal(stopped.state, 'recoverable');
  const cleared = await recoverEngine({ ...f.options, fingerprint: stopped.fingerprint!, acknowledged: true });
  assert.equal(cleared.effectMarkerCleared, true);
  assert.equal(cleared.effectMarkerBlocker, undefined);
});

test('live owned child blocks recovery without signaling or stopping that child', async t => {
  const f = fixture(t), instance = await child(t, "process.stdout.write('ready');setInterval(()=>{},1000)", [], true);
  marker(f.effect, instance.pid!, instance.pid!);
  const status = await getRecoveryStatus(f.options);
  assert.equal(status.state, 'blocked');
  assert.ok(status.blockers.includes('PROCESS_OWNER_ALIVE'));
  assert.ok(status.blockers.includes('PROCESS_GROUP_ALIVE'));
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_BLOCKED'));
  assert.doesNotThrow(() => process.kill(instance.pid!, 0));
  assert.equal(readdirSync(f.artifactDir).length, 0);
});

test('missing command group and EPERM observations remain unresolved even when owner PID disappeared', async t => {
  const f = fixture(t), pid = await stoppedPid(t);
  marker(f.effect, pid, null);
  let status = await getRecoveryStatus(f.options);
  assert.ok(status.blockers.includes('PROCESS_GROUP_NOT_RECORDED'));
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_BLOCKED'));
  const db = new DatabaseSync(f.effect); db.prepare('UPDATE command_execution SET group_pid=?').run(pid); db.close();
  const originalKill = process.kill.bind(process);
  t.mock.method(process, 'kill', (observed: number, signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (signal === 0 && (observed === pid || observed === -pid)) throw Object.assign(new Error('fixture denied'), { code: 'EPERM' });
    return originalKill(observed, signal);
  });
  status = await getRecoveryStatus(f.options);
  assert.ok(status.blockers.includes('PROCESS_CLEANUP_UNVERIFIED'));
  assert.equal(status.marker?.owner, 'unknown');
  assert.equal(status.marker?.group, 'unknown');
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_BLOCKED'));
});

test('current primary/review owners and an independent writer cannot be replaced by recovery', async t => {
  const f = fixture(t), current = new SqliteStore(f.dbPath);
  try {
    const status = await getRecoveryStatus(f.options);
    assert.ok(status.blockers.includes('RECOVERY_OWNER_BUSY'));
    await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_OWNER_BUSY'));
  } finally { current.close(); }
  const review = new ReviewJournal(f.review);
  try {
    const status = await getRecoveryStatus(f.options);
    assert.ok(status.blockers.includes('RECOVERY_OWNER_BUSY'));
    await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_OWNER_BUSY'));
  } finally { review.close(); }
  const status = await getRecoveryStatus(f.options), writer = new DatabaseSync(f.dbPath);
  writer.exec('BEGIN IMMEDIATE');
  try { await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_OWNER_BUSY')); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
});

test('logical fingerprint survives healthy idle ownership close/WAL checkpoint but detects changed journal data', async t => {
  const f = fixture(t), store = new SqliteStore(f.dbPath);
  const before = await getRecoveryStatus(f.options);
  store.close();
  const after = await getRecoveryStatus(f.options);
  assert.equal(before.fingerprint, after.fingerprint);
  const db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify({ ...f.original.session, title: 'changed externally' }), 'session');
  db.close();
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: after.fingerprint!, acknowledged: true }), hasCode('RECOVERY_STALE'));
  assert.equal(readdirSync(f.artifactDir).length, 0);
});

test('started restoration requires normal restart and is never acknowledged or rewritten by recovery', async t => {
  const f = fixture(t), journal = new ReviewJournal(f.review);
  journal.start({ ...f.operation, id: 'started' }); journal.close();
  const before = readFileSync(f.review), status = await getRecoveryStatus(f.options);
  assert.ok(status.blockers.includes('RESTORE_RESTART_REQUIRED'));
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_BLOCKED'));
  assert.deepEqual(readFileSync(f.review), before);
  assert.deepEqual(readRecoveryAcknowledgments(f.options), []);
});

test('a real SQLite writer crash leaves committed WAL recoverable through a readonly private snapshot', async t => {
  const f = fixture(t);
  const instance = await child(t, `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run('wal-workspace','wal-root',JSON.stringify({id:'wal-workspace',root:'wal-root'})); process.stdout.write('ready');setInterval(()=>{},1000);`, [f.dbPath]);
  const exited = once(instance, 'exit'); instance.kill('SIGKILL'); await exited;
  assert.ok(lstatSync(f.dbPath + '-wal').size > 0);
  rmSync(f.dbPath + '-shm', { force: true });
  const before = tree(f.directory), status = await getRecoveryStatus(f.options);
  assert.equal(status.state, 'recoverable');
  assert.deepEqual(tree(f.directory), before);
  const result = await recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true });
  const backup = new DatabaseSync(join(f.artifactDir, 'recovery', result.recoveryId, 'primary.sqlite'), { readOnly: true });
  try { assert.equal(backup.prepare("SELECT count(*) AS count FROM workspaces WHERE id='wal-workspace'").get()?.count, 1); }
  finally { backup.close(); }
});

test('metadata permission failure leaves active effects and original interrupted journal blocked', async t => {
  const f = fixture(t), pid = await stoppedPid(t);
  marker(f.effect, pid, pid);
  const ledger = new DatabaseSync(f.ledger); initializeLedger(ledger); ledger.close(); chmodSync(f.ledger, 0o400);
  const before = readFileSync(f.review), status = await getRecoveryStatus(f.options);
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), error => error instanceof EngineError && ['RECOVERY_METADATA_FAILED', 'RECOVERY_PERMISSION_DENIED', 'RECOVERY_DATABASE_INVALID'].includes(error.code));
  const effect = new DatabaseSync(f.effect, { readOnly: true });
  try { assert.equal(effect.prepare('SELECT active FROM command_execution').get()?.active, 1); } finally { effect.close(); }
  assert.deepEqual(readFileSync(f.review), before);
  assert.deepEqual(readRecoveryAcknowledgments(f.options), []);
  chmodSync(f.ledger, 0o600);
});

test('a recovery failure inside the ledger transaction keeps its code and commits no acknowledgment', async t => {
  const f = fixture(t), status = await getRecoveryStatus(f.options);
  const now = performance.now.bind(performance);
  // The DELETE-mode ledger journal exists only while the audit transaction is open.
  const clock = t.mock.method(performance, 'now', () => existsSync(f.ledger + '-journal') ? Number.MAX_SAFE_INTEGER : now());
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true }), hasCode('RECOVERY_LIMIT_EXCEEDED'));
  clock.mock.restore();
  assert.deepEqual(readRecoveryAcknowledgments(f.options), []);
  assert.equal((await getRecoveryStatus(f.options)).pendingRestoreCount, 1);
});

test('path aliases, oversized files, unsupported owner WAL and corrupt DBs remain bounded readonly blockers', async t => {
  const f = fixture(t);
  const alias = join(f.directory, 'alias'); symlinkSync(f.dbPath, alias);
  assert.ok((await getRecoveryStatus({ ...f.options, dbPath: alias })).blockers.includes('RECOVERY_PATH_UNSUPPORTED'));
  const large = join(f.directory, 'large.sqlite'); const fd = openSync(large, 'w'); ftruncateSync(fd, RECOVERY_LIMITS.maxFileBytes + 1); closeSync(fd);
  assert.ok((await getRecoveryStatus({ ...f.options, dbPath: large })).blockers.includes('RECOVERY_LIMIT_EXCEEDED'));
  rmSync(large);
  const owner = new DatabaseSync(f.dbPath + '.owner.sqlite'); owner.exec('PRAGMA journal_mode=WAL; CREATE TABLE sentinel(value)'); owner.close();
  const before = tree(f.directory);
  assert.ok((await getRecoveryStatus(f.options)).blockers.includes('RECOVERY_DATABASE_INVALID'));
  assert.deepEqual(tree(f.directory), before);
  writeFileSync(f.dbPath, 'invalid sk-recovery-fixture secret database');
  const status = await getRecoveryStatus(f.options);
  assert.equal(status.fingerprint, null);
  assert.doesNotMatch(JSON.stringify(status), /sk-recovery-fixture|engine\.sqlite|\/Users\//);
});

test('recovery audit applies only to exact original binding, outcome/timestamp and pinned database identities', async t => {
  const f = fixture(t), status = await getRecoveryStatus(f.options);
  await recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true });
  assert.equal(isRestoreAcknowledged(f.interrupted, readRecoveryAcknowledgments(f.options)), true);
  const db = new DatabaseSync(f.review);
  db.prepare('UPDATE review_operations SET fingerprint=? WHERE id=?').run('b'.repeat(64), f.operation.id); db.close();
  assert.deepEqual(readRecoveryAcknowledgments(f.options), []);
  assert.equal((await getRecoveryStatus(f.options)).pendingRestoreCount, 1);
  const reset = new DatabaseSync(f.review);
  reset.prepare('UPDATE review_operations SET fingerprint=?,finished_at=? WHERE id=?').run(f.operation.fingerprint, new Date(Date.parse(f.interrupted.finishedAt!) + 1).toISOString(), f.operation.id); reset.close();
  assert.deepEqual(readRecoveryAcknowledgments(f.options), []);
  const restored = new DatabaseSync(f.review);
  restored.prepare('UPDATE review_operations SET finished_at=? WHERE id=?').run(f.interrupted.finishedAt!, f.operation.id); restored.close();
  assert.equal(readRecoveryAcknowledgments(f.options).length, 1);
  const copyDir = join(f.directory, 'copied'); mkdirSync(copyDir); mkdirSync(join(copyDir, 'artifacts'));
  const copy = join(copyDir, 'engine.sqlite');
  for (const suffix of ['', '.review.sqlite', '.recovery.sqlite']) copyFileSync(f.dbPath + suffix, copy + suffix);
  assert.deepEqual(readRecoveryAcknowledgments({ dbPath: copy, artifactDir: join(copyDir, 'artifacts') }), []);
  const corrupted = new DatabaseSync(f.review);
  corrupted.prepare('UPDATE review_operations SET outcome_hash=? WHERE id=?').run('c'.repeat(64), f.operation.id); corrupted.close();
  assert.throws(() => readRecoveryAcknowledgments(f.options), hasCode('RECOVERY_DATABASE_INVALID'));
  assert.equal((await getRecoveryStatus(f.options)).state, 'blocked');
});

test('an independent held effect lease blocks clearing while its logical fingerprint remains stable', async t => {
  const f = fixture(t), pid = await stoppedPid(t); marker(f.effect, pid, pid);
  const before = await getRecoveryStatus(f.options);
  const holder = await child(t, `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{timeout:0});db.exec('BEGIN EXCLUSIVE');process.stdout.write('ready');setInterval(()=>{},1000);`, [f.effect]);
  const busy = await getRecoveryStatus(f.options);
  assert.equal(busy.fingerprint, before.fingerprint);
  assert.ok(busy.blockers.includes('RECOVERY_EFFECT_BUSY'));
  await assert.rejects(recoverEngine({ ...f.options, fingerprint: before.fingerprint!, acknowledged: true }), hasCode('RECOVERY_EFFECT_BUSY'));
  const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited;
  const result = await recoverEngine({ ...f.options, fingerprint: before.fingerprint!, acknowledged: true });
  assert.equal(result.effectMarkerCleared, true);
});

test('completed uncertain restoration re-quarantines on startup, then exact durable recovery lifts that quarantine', async t => {
  const f = fixture(t), journal = new ReviewJournal(f.review);
  journal.start({ ...f.operation, id: 'uncertain-completed' });
  const completed = journal.finish('uncertain-completed', { checkpointId: 'checkpoint', runId: f.operation.runId, atomic: false,
    restored: [], conflicts: [], failed: [{ path: 'file.txt', error: 'partial outcome', mayHaveChanged: true }], warnings: [],
    cancelled: false, observations: [{ path: 'file.txt', state: 'unobserved' }], effectsUncertain: true, executionBlocked: true });
  journal.close();
  let engine = createEngine(f.options);
  try {
    await assert.rejects(engine.coordinator.withWorkspaceLease('workspace', async () => 'unexpected'), hasCode('CLEANUP_PENDING'));
  } finally { await engine.close(); }
  const status = await getRecoveryStatus(f.options);
  assert.equal(status.pendingRestoreCount, 2);
  const beforeReview = readFileSync(f.review);
  const result = await recoverEngine({ ...f.options, fingerprint: status.fingerprint!, acknowledged: true });
  assert.equal(result.restoredAcknowledgments, 2);
  const acknowledgments = readRecoveryAcknowledgments(f.options);
  assert.equal(isRestoreAcknowledged(completed, acknowledgments), true);
  assert.deepEqual(readFileSync(f.review), beforeReview);
  engine = createEngine(f.options);
  try {
    assert.equal(await engine.coordinator.withWorkspaceLease('workspace', async () => 'available'), 'available');
    assert.deepEqual(engine.store.getSnapshot('session'), f.original);
    assert.equal(engine.store.readEvents('session', 0).at(-1)?.type, 'run.completed');
    assert.equal(engine.reviewJournal.get('uncertain-completed')?.state, 'completed');
  } finally { await engine.close(); }
});
