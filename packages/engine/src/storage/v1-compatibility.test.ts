import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { ReviewJournal } from '../review/audit.js';
import { getReviewDiff } from '../review/index.js';
import { getRecoveryStatus, readRecoveryAcknowledgments } from '../recovery/index.js';
import { isRestoreAcknowledged, readAudits } from '../recovery/ledger.js';
import { SqliteStore } from './index.js';
import { databaseContents, restoreV1Fixture } from './fixtures/v1-fixture.js';
import { V1_DATABASE_FIXTURE } from './fixtures/v1-database.js';

const ids = V1_DATABASE_FIXTURE.ids;
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-v1-compatibility-')));
  const path = join(directory, 'engine.sqlite');
  const artifactDir = join(directory, 'artifacts');
  mkdirSync(artifactDir, { mode: 0o700 });
  restoreV1Fixture(path, directory);
  const stores: SqliteStore[] = [], journals: ReviewJournal[] = [];
  t.after(() => { for (const journal of journals) journal.close(); for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = (file = path) => { const store = new SqliteStore(file); stores.push(store); return store; };
  const review = () => { const journal = new ReviewJournal(path + '.review.sqlite'); journals.push(journal); return journal; };
  return { directory, path, artifactDir, open, review };
}
function contents(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return databaseContents(db); } finally { db.close(); }
}

test('frozen v1 history keeps every durable row, replay, approval, checkpoint and event binding on open', t => {
  const f = fixture(t), before = contents(f.path);
  const store = f.open(), snapshot = store.getSnapshot(ids.sessionId);
  assert.equal(snapshot.runs.length, 2);
  assert.equal(store.getRun(ids.terminalRunId).state, 'completed');
  assert.equal(store.getRun(ids.activeRunId).state, 'awaiting_approval', 'Opening storage must not silently perform recovery');
  assert.equal(store.getApproval('v1-allowed-approval').status, 'allowed');
  assert.equal(store.getApproval('v1-terminal-expired-approval').status, 'expired');
  assert.equal(store.getApproval('v1-pending-approval').status, 'pending');
  const message = snapshot.messages.find(record => record.id === 'v1-assistant');
  assert.equal(message?.content, 'Stored Korean result: 완료');
  assert.deepEqual(message?.providerReplay, { providerId: 'scripted', items: [{ type: 'reasoning', id: 'v1-reasoning', encrypted_content: 'fixture-opaque-state' }] });
  const checkpoint = store.listCheckpoints(ids.terminalRunId)[0]!;
  assert.equal(checkpoint.id, ids.checkpointId);
  assert.equal(checkpoint.toolCallId, 'v1-patch-tool');
  assert.equal(checkpoint.files[0]?.before, 'user content\n');
  assert.equal(checkpoint.files[0]?.after, 'engine content\n');
  assert.equal(store.listCheckpoints(ids.activeRunId)[0]?.incomplete, true);
  const events = store.readEvents(ids.sessionId, 0, 1_024);
  assert.equal(events.at(-1)?.seq, snapshot.lastSeq);
  assert.deepEqual(events.map(event => event.seq), Array.from({ length: snapshot.lastSeq }, (_, index) => index + 1));
  assert.equal(events.every(event => event.schemaVersion === 1 && snapshot.runs.some(run => run.id === event.runId)), true);
  const terminal = store.getRun(ids.terminalRunId);
  assert.deepEqual(store.admit({ sessionId: terminal.sessionId, requestId: terminal.requestId, prompt: terminal.prompt, config: terminal.config }), {
    runId: terminal.id, inputId: terminal.inputId, admittedSeq: 1, duplicate: true,
  });
  assert.throws(() => store.commit(terminal.id, 'message.delta', { delta: 'late result' }), hasCode('RUN_TERMINAL'));
  const diff = getReviewDiff(store, terminal.id);
  assert.equal(diff.checkpoints[0]?.id, checkpoint.id);
  assert.equal(diff.files[0]?.path, 'kept.txt');
  assert.equal(diff.warnings.includes('Fixture captures only recorded effects'), true);
  assert.equal(store.getHistory(ids.sessionId).snapshot.messages.find(record => record.id === message?.id)?.providerReplay, undefined);
  assert.deepEqual(store.getSnapshot(ids.sessionId), snapshot, 'Display/history projections cannot alter native replay');
  assert.equal(store.integrityCheck().ok, true);
  store.close();
  assert.deepEqual(contents(f.path), before, 'No schema, ordinal, JSON or cursor rewrites are allowed at v1 open');
});

test('frozen v1 interrupted recovery expires active approval once without changing terminal result or checkpoint images', t => {
  const f = fixture(t), store = f.open(), before = store.getSnapshot(ids.sessionId);
  const journalBefore = store.readEvents(ids.sessionId, 0, 1_024);
  const terminalBefore = store.getRun(ids.terminalRunId);
  const checkpoints = [store.listCheckpoints(ids.terminalRunId), store.listCheckpoints(ids.activeRunId)];
  const recovered = store.recoverInterrupted();
  assert.deepEqual(recovered.map(run => run.id), [ids.activeRunId]);
  assert.equal(recovered[0]?.state, 'interrupted');
  assert.equal(recovered[0]?.error?.code, 'ENGINE_INTERRUPTED');
  assert.deepEqual(store.getRun(ids.terminalRunId), terminalBefore);
  assert.equal(store.getSnapshot(ids.sessionId).tools.find(tool => tool.id === 'v1-terminal-unresolved-tool')?.state, 'interrupted');
  assert.equal(store.getSnapshot(ids.sessionId).tools.find(tool => tool.id === 'v1-active-tool')?.state, 'interrupted');
  assert.equal(store.getApproval('v1-pending-approval').status, 'expired');
  assert.equal(store.getApproval('v1-allowed-approval').status, 'allowed');
  assert.match(getReviewDiff(store, ids.terminalRunId).warnings.join('\n'), /effects may exist outside recorded checkpoints/);
  assert.deepEqual([store.listCheckpoints(ids.terminalRunId), store.listCheckpoints(ids.activeRunId)], checkpoints);
  const all = store.readEvents(ids.sessionId, 0, 1_024);
  assert.deepEqual(all.slice(0, journalBefore.length), journalBefore);
  assert.deepEqual(all.slice(journalBefore.length).map(event => event.type), ['tool.interrupted', 'tool.interrupted', 'approval.expired', 'run.interrupted']);
  assert.equal(all.filter(event => event.runId === ids.terminalRunId && event.type === 'run.completed').length, 1);
  assert.equal(all.filter(event => event.runId === ids.terminalRunId && event.type === 'run.interrupted').length, 0);
  assert.equal(store.getSnapshot(ids.sessionId).lastSeq, before.lastSeq + 4);
  const after = store.getSnapshot(ids.sessionId);
  store.close();
  const successor = f.open();
  assert.deepEqual(successor.getSnapshot(ids.sessionId), after);
  assert.deepEqual(successor.recoverInterrupted(), []);
  assert.deepEqual(successor.getSnapshot(ids.sessionId), after);
});

test('frozen review and recovery ledger preserve exact restore binding and keep unmatched uncertainty quarantined', async t => {
  const f = fixture(t), beforeReview = readFileSync(f.path + '.review.sqlite'), beforeLedger = readFileSync(f.path + '.recovery.sqlite');
  const store = f.open();
  assert.equal(store.listCheckpoints(ids.terminalRunId)[0]?.id, ids.checkpointId);
  store.close();
  const journal = f.review();
  const completed = journal.get('v1-completed-restore')!;
  const interrupted = journal.get('v1-acknowledged-restore')!;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.result?.restored[0], 'kept.txt');
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.runId, ids.terminalRunId);
  assert.equal(interrupted.checkpointId, ids.checkpointId);
  const ledger = new DatabaseSync(f.path + '.recovery.sqlite', { readOnly: true });
  try {
    const audits = readAudits(ledger, () => {});
    assert.equal(audits.audits.length, 1);
    const acknowledgments = audits.audits[0]!.acknowledgments;
    assert.equal(isRestoreAcknowledged(interrupted, acknowledgments), true);
    for (const key of ['id', 'checkpointId', 'runId', 'sessionId', 'workspaceId', 'fingerprint'] as const) {
      assert.equal(isRestoreAcknowledged({ ...interrupted, [key]: 'changed' }, acknowledgments), false);
    }
    assert.equal(isRestoreAcknowledged({ ...interrupted, error: { ...interrupted.error!, message: 'changed outcome' } }, acknowledgments), false);
  } finally { ledger.close(); }
  const sentinel = join(f.directory, 'kept.txt');
  writeFileSync(sentinel, 'external user content must survive recovery');
  const pending = journal.recoverPending();
  assert.deepEqual(pending.map(operation => operation.id), ['v1-acknowledged-restore', 'v1-unfinished-restore']);
  assert.equal(pending.every(operation => operation.state === 'interrupted'), true);
  assert.deepEqual(journal.get(completed.id), completed);
  assert.deepEqual(journal.get(interrupted.id), interrupted);
  assert.throws(() => journal.start({ id: interrupted.id, checkpointId: 'other', runId: interrupted.runId, sessionId: interrupted.sessionId, workspaceId: interrupted.workspaceId, fingerprint: interrupted.fingerprint }), hasCode('REVIEW_JOURNAL_OPERATION_CONFLICT'));
  assert.equal(readFileSync(sentinel, 'utf8'), 'external user content must survive recovery');
  journal.close();
  const status = await getRecoveryStatus({ dbPath: f.path, artifactDir: f.artifactDir });
  assert.equal(status.state, 'recoverable');
  assert.equal(status.pendingRestoreCount, 2);
  assert.deepEqual(readRecoveryAcknowledgments({ dbPath: f.path, artifactDir: f.artifactDir }), [], 'An acknowledgment copied to different file identities cannot clear uncertainty');
  assert.deepEqual(readFileSync(f.path + '.recovery.sqlite'), beforeLedger);
  assert.notDeepEqual(readFileSync(f.path + '.review.sqlite'), beforeReview, 'Only explicit review recovery transitions the unfinished operation');
});

test('backup of frozen v1 preserves primary records and does not silently claim to include review or recovery artifacts', async t => {
  const f = fixture(t), store = f.open();
  const snapshot = store.getSnapshot(ids.sessionId), events = store.readEvents(ids.sessionId, 0, 1_024);
  const review = readFileSync(f.path + '.review.sqlite'), ledger = readFileSync(f.path + '.recovery.sqlite');
  const destination = join(f.directory, 'archive.sqlite');
  const backup = await store.backup(destination);
  assert.equal(backup.schemaVersion, 1);
  const restored = f.open(destination);
  assert.deepEqual(restored.getSnapshot(ids.sessionId), snapshot);
  assert.deepEqual(restored.readEvents(ids.sessionId, 0, 1_024), events);
  assert.deepEqual(restored.listCheckpoints(ids.terminalRunId), store.listCheckpoints(ids.terminalRunId));
  assert.equal(restored.integrityCheck().ok, true);
  assert.deepEqual(readFileSync(f.path + '.review.sqlite'), review);
  assert.deepEqual(readFileSync(f.path + '.recovery.sqlite'), ledger);
});
