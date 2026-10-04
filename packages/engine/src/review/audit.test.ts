import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { ReviewJournal, REVIEW_JOURNAL_LIMITS, type RestoreOperationInput } from './audit.js';
import type { RestoreResult } from './index.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-review-audit-'));
  const file = join(directory, 'review.sqlite');
  const journals: ReviewJournal[] = [];
  t.after(() => { for (const journal of journals) journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, open(path = file): ReviewJournal { const journal = new ReviewJournal(path); journals.push(journal); return journal; } };
}
function input(id = 'operation', runId = 'run'): RestoreOperationInput {
  return { id, checkpointId: 'checkpoint', runId, sessionId: 'session', workspaceId: 'workspace', fingerprint: 'a'.repeat(64) };
}
function result(): RestoreResult {
  return { checkpointId: 'checkpoint', runId: 'run', atomic: false, restored: ['a.txt'], conflicts: [], failed: [], warnings: [],
    cancelled: false, observations: [{ path: 'a.txt', state: 'present', currentHash: 'b'.repeat(64), bytes: 4 }], effectsUncertain: false, executionBlocked: false };
}
function hasCode(code: string): (error: unknown) => boolean { return error => error instanceof EngineError && error.code === code; }

test('audit start commits FULL SQLite metadata visible to an independent reader before effects', (t) => {
  const f = fixture(t), journal = f.open();
  const db = (journal as unknown as { db: DatabaseSync }).db;
  assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 2);
  assert.equal(db.prepare('PRAGMA fullfsync').get()?.fullfsync, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
  assert.equal(journal.get('missing'), undefined);
  const started = journal.start(input());
  assert.equal(started.state, 'started');
  const reader = new DatabaseSync(f.file, { readOnly: true });
  try { assert.equal(reader.prepare('SELECT state FROM review_operations WHERE id=?').get('operation')?.state, 'started'); }
  finally { reader.close(); }
  const sentinel = join(f.directory, 'effect.txt');
  writeFileSync(sentinel, 'effect performed after the committed start');
  journal.close();
  assert.deepEqual(f.open().get('operation'), started);
  assert.equal(readFileSync(sentinel, 'utf8'), 'effect performed after the committed start');
});

test('audit exact binding replay remains idempotent even after finish and rejects every conflicting binding', (t) => {
  const journal = fixture(t).open(), request = input();
  const first = journal.start(request);
  assert.deepEqual(journal.start({ ...request }), first);
  for (const key of ['checkpointId', 'runId', 'sessionId', 'workspaceId', 'fingerprint'] as const) {
    assert.throws(() => journal.start({ ...request, [key]: key === 'fingerprint' ? 'c'.repeat(64) : 'different' }), hasCode('REVIEW_JOURNAL_OPERATION_CONFLICT'));
  }
  const completed = journal.finish(request.id, result());
  assert.deepEqual(journal.start(request), completed);
  assert.equal(journal.list(request.runId).length, 1);
});

test('audit finish survives reopen and returns detached immutable records', (t) => {
  const f = fixture(t), journal = f.open(), original = result();
  journal.start(input());
  const completed = journal.finish('operation', original);
  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.result?.totals, { restored: 1, conflicts: 0, failed: 0, observations: 1, warnings: 0 });
  assert.equal(completed.result?.truncated, false);
  completed.result?.restored.push('caller mutation');
  completed.result?.observations.push({ path: 'caller mutation', state: 'unobserved' });
  assert.deepEqual(journal.get('operation')?.result?.restored, ['a.txt']);
  assert.deepEqual(journal.finish('operation', original), journal.get('operation'));
  assert.throws(() => journal.finish('operation', { ...original, cancelled: true }), hasCode('REVIEW_JOURNAL_OUTCOME_CONFLICT'));
  assert.throws(() => journal.finish('operation', { error: { code: 'FAILED', message: 'different outcome' } }), hasCode('REVIEW_JOURNAL_OUTCOME_CONFLICT'));
  journal.close();
  const reopened = f.open();
  assert.deepEqual(reopened.get('operation')?.result?.restored, ['a.txt']);
  assert.deepEqual(reopened.finish('operation', original), reopened.get('operation'));
});

test('audit completed records preserve partial cancellation and uncertainty while thrown errors are failed', (t) => {
  const journal = fixture(t).open(), partial = result();
  partial.cancelled = true;
  partial.conflicts = [{ path: 'edited.txt', reason: 'User edit preserved' }];
  partial.failed = [{ path: 'partial.txt', error: 'Write failed', mayHaveChanged: true }];
  partial.observations.push({ path: 'partial.txt', state: 'unobserved', error: 'Read failed' });
  partial.effectsUncertain = true;
  partial.executionBlocked = true;
  journal.start(input());
  const completed = journal.finish('operation', partial);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result?.cancelled, true);
  assert.equal(completed.result?.failed[0]?.mayHaveChanged, true);
  assert.equal(completed.result?.executionBlocked, true);
  journal.start(input('error'));
  const error = { error: { code: 'RESTORE_PREVIEW_STALE', message: 'Refresh the preview' } };
  const failed = journal.finish('error', error);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result, undefined);
  assert.deepEqual(failed.error, error.error);
  assert.deepEqual(journal.finish('error', error), failed);
  assert.throws(() => journal.finish('error', { error: { ...error.error, message: 'different' } }), hasCode('REVIEW_JOURNAL_OUTCOME_CONFLICT'));
  assert.throws(() => journal.finish('unknown', result()), hasCode('REVIEW_JOURNAL_OPERATION_NOT_FOUND'));
});

test('audit result binding failures roll back without consuming the unfinished outcome', (t) => {
  const journal = fixture(t).open();
  journal.start(input());
  for (const changed of [{ checkpointId: 'other' }, { runId: 'other' }]) {
    assert.throws(() => journal.finish('operation', { ...result(), ...changed }), hasCode('REVIEW_JOURNAL_OUTCOME_CONFLICT'));
    assert.equal(journal.get('operation')?.state, 'started');
  }
  assert.throws(() => journal.finish('operation', { ...result(), atomic: true } as unknown as RestoreResult), hasCode('REVIEW_JOURNAL_RESULT_INVALID'));
  assert.equal(journal.finish('operation', result()).state, 'completed');
});

test('audit recovery durably interrupts unfinished operations and re-quarantines prior interruption without touching files', (t) => {
  const f = fixture(t), journal = f.open(), sentinel = join(f.directory, 'user.txt');
  writeFileSync(sentinel, 'external user content');
  journal.start(input('unfinished'));
  journal.start(input('done'));
  journal.finish('done', result());
  journal.close();
  const successor = f.open(), recovered = successor.recoverPending();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.id, 'unfinished');
  assert.equal(recovered[0]?.state, 'interrupted');
  assert.match(recovered[0]?.error?.message ?? '', /effects are unknown/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'external user content');
  assert.equal(successor.get('done')?.state, 'completed');
  assert.deepEqual(successor.recoverPending(), recovered);
  assert.throws(() => successor.finish('unfinished', result()), hasCode('REVIEW_JOURNAL_OUTCOME_CONFLICT'));
  successor.close();
  assert.deepEqual(f.open().recoverPending(), recovered);
});

test('audit history is run-scoped, ordered by latest start, bounded, and rejects use after close', (t) => {
  const journal = fixture(t).open();
  journal.start(input('first'));
  journal.start(input('other', 'another-run'));
  journal.start(input('last'));
  assert.deepEqual(journal.list('run').map(operation => operation.id), ['last', 'first']);
  assert.deepEqual(journal.list('run', 1).map(operation => operation.id), ['last']);
  assert.deepEqual(journal.list('run', 0), []);
  for (const limit of [-1, 1.5, REVIEW_JOURNAL_LIMITS.maxListLimit + 1]) assert.throws(() => journal.list('run', limit), hasCode('REVIEW_JOURNAL_LIMIT_EXCEEDED'));
  journal.close();
  journal.close();
  for (const action of [() => journal.get('first'), () => journal.list('run'), () => journal.start(input()), () => journal.finish('first', result()), () => journal.recoverPending()]) {
    assert.throws(action, hasCode('REVIEW_JOURNAL_CLOSED'));
  }
});

test('audit bounds escaped UTF-8 JSON, keeps original totals, drops image fields, and hashes cropped-away differences', (t) => {
  const f = fixture(t), journal = f.open(), original = result();
  const long = '\u0001😀'.repeat(2_000);
  original.restored = Array.from({ length: 3_000 }, (_, index) => long + String(index));
  original.failed = [{ path: 'failed.txt', error: long, mayHaveChanged: true }];
  original.warnings = [long + 'original suffix'];
  const withImages = { ...original, before: 'PRIVATE FILE IMAGE', after: 'PRIVATE FILE IMAGE', content: 'PRIVATE FILE IMAGE',
    observations: original.observations.map(item => ({ ...item, content: 'PRIVATE FILE IMAGE' })) };
  journal.start(input());
  const saved = journal.finish('operation', withImages);
  assert.equal(saved.result?.truncated, true);
  assert.equal(saved.result?.totals.restored, 3_000);
  assert.equal(saved.result?.totals.failed, 1);
  assert.equal(saved.result?.failed[0]?.path, 'failed.txt');
  assert.equal(saved.result?.failed[0]?.mayHaveChanged, true);
  const encoded = JSON.stringify(saved.result);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= REVIEW_JOURNAL_LIMITS.maxResultBytes);
  assert.equal(Buffer.from(encoded, 'utf8').toString('utf8'), encoded);
  assert.equal(encoded.includes('PRIVATE FILE IMAGE'), false);
  assert.ok((saved.result?.restored.length ?? 0) <= REVIEW_JOURNAL_LIMITS.maxEntries);
  assert.ok(Buffer.byteLength(saved.result?.failed[0]?.error ?? '', 'utf8') <= REVIEW_JOURNAL_LIMITS.maxTextBytes);
  assert.throws(() => journal.finish('operation', { ...original, warnings: [long + 'different suffix'] }), hasCode('REVIEW_JOURNAL_OUTCOME_CONFLICT'));
  assert.deepEqual(journal.finish('operation', withImages), saved);
  journal.close();
  const reader = new DatabaseSync(f.file, { readOnly: true });
  try {
    const record = reader.prepare('SELECT result FROM review_operations WHERE id=?').get('operation')?.result;
    assert.equal(typeof record, 'string');
    assert.equal(String(record).includes('PRIVATE FILE IMAGE'), false);
  } finally { reader.close(); }
  assert.deepEqual(f.open().get('operation'), saved);
});

test('audit rejects duplicate owners and canonical parent aliases share ownership until close', (t) => {
  const f = fixture(t), journal = f.open();
  const alias = join(f.directory, 'parent-alias');
  symlinkSync(f.directory, alias, 'dir');
  assert.throws(() => new ReviewJournal(f.file), hasCode('REVIEW_JOURNAL_LOCKED'));
  assert.throws(() => new ReviewJournal(join(alias, 'review.sqlite')), hasCode('REVIEW_JOURNAL_LOCKED'));
  journal.start(input());
  journal.close();
  assert.equal(f.open(join(alias, 'review.sqlite')).get('operation')?.state, 'started');
});

test('audit refuses DB/owner/sidecar symlinks and hard links before opening unsafe paths', (t) => {
  const f = fixture(t), target = join(f.directory, 'target');
  writeFileSync(target, 'unchanged target');
  for (const suffix of ['', '.owner.sqlite', '-journal', '.owner.sqlite-journal']) {
    const file = join(f.directory, 'alias' + suffix.length + '.sqlite');
    symlinkSync(target, file + suffix, 'file');
    assert.throws(() => new ReviewJournal(file), hasCode('REVIEW_JOURNAL_PATH_UNSUPPORTED'));
    assert.equal(readFileSync(target, 'utf8'), 'unchanged target');
  }
  const journal = f.open();
  journal.close();
  linkSync(f.file, join(f.directory, 'hardlink.sqlite'));
  assert.throws(() => new ReviewJournal(f.file), hasCode('REVIEW_JOURNAL_PATH_UNSUPPORTED'));
  assert.throws(() => new ReviewJournal(join(f.directory, 'hardlink.sqlite')), hasCode('REVIEW_JOURNAL_PATH_UNSUPPORTED'));
  assert.throws(() => new ReviewJournal(':memory:'), hasCode('REVIEW_JOURNAL_PATH_UNSUPPORTED'));
});

test('audit rejects future or unrelated schemas without altering those databases and releases failed owner claims', (t) => {
  const f = fixture(t);
  let db = new DatabaseSync(f.file);
  db.exec('PRAGMA user_version=2');
  db.close();
  const future = readFileSync(f.file);
  assert.throws(() => new ReviewJournal(f.file), hasCode('REVIEW_JOURNAL_VERSION_UNSUPPORTED'));
  assert.deepEqual(readFileSync(f.file), future);
  db = new DatabaseSync(f.file);
  db.exec('PRAGMA user_version=0; CREATE TABLE unrelated(value TEXT)');
  db.close();
  const unrelated = readFileSync(f.file);
  assert.throws(() => new ReviewJournal(f.file), hasCode('REVIEW_JOURNAL_SCHEMA_INVALID'));
  assert.deepEqual(readFileSync(f.file), unrelated);
  db = new DatabaseSync(f.file);
  db.exec('DROP TABLE unrelated');
  db.close();
  const journal = f.open();
  journal.start(input());
  journal.close();
  db = new DatabaseSync(f.file);
  db.exec('DROP INDEX review_operations_run');
  db.close();
  assert.throws(() => new ReviewJournal(f.file), hasCode('REVIEW_JOURNAL_SCHEMA_INVALID'));
});

test('SIGKILL releases audit ownership and the committed start survives native SQLite recovery', { timeout: 12_000 }, async (t) => {
  const f = fixture(t), source = import.meta.url.endsWith('.ts');
  const moduleUrl = new URL(source ? './audit.ts' : './audit.js', import.meta.url).href;
  const script = 'import { ReviewJournal } from ' + JSON.stringify(moduleUrl) + '; const journal=new ReviewJournal(process.argv[1]); journal.start(JSON.parse(process.argv[2])); process.stdout.write("started\\n"); setInterval(()=>{},1000);';
  const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), '--input-type=module', '--eval', script, f.file, JSON.stringify(input())], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once('close', (code, signal) => done({ code, signal })));
  let diagnostics = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (value: string) => { diagnostics = (diagnostics + value).slice(-2_048); });
  try {
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('Audit child startup timed out: ' + diagnostics)), 8_000);
      const fail = (error: Error): void => { clearTimeout(timeout); reject(error); };
      child.once('error', fail);
      child.once('exit', () => fail(new Error('Audit child exited before readiness: ' + diagnostics)));
      child.stdout?.setEncoding('utf8');
      child.stdout?.once('data', () => { clearTimeout(timeout); done(); });
    });
    assert.throws(() => new ReviewJournal(f.file), hasCode('REVIEW_JOURNAL_LOCKED'));
    assert.equal(child.kill('SIGKILL'), true);
    assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' });
    const successor = f.open();
    assert.equal(successor.get('operation')?.state, 'started');
    assert.equal(successor.recoverPending()[0]?.state, 'interrupted');
    assert.equal(successor.recoverPending()[0]?.error?.code, 'RESTORE_INTERRUPTED');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});
