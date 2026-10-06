import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ContextRevision, type JsonObject } from '@moodcode/contracts';
import { SqliteStore } from './index.js';
import { DATABASE_MIGRATIONS, migrateDatabase } from './migrations.js';
import type { SummaryAttemptIdentity } from './summary-attempts.js';

const stamp = '2026-10-07T00:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
const config = { providerId: 'scripted', modelId: 'local', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const allUsage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'moodcode-summary-records-')), dbPath = join(root, 'engine.sqlite'), store = new SqliteStore(dbPath);
  store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Summary records', createdAt: stamp });
  const runId = store.admit({ sessionId: 'session', requestId: 'goal', prompt: 'Goal', config }).runId;
  store.commit(runId, 'run.started', {}, { run: { state: 'running' } });
  const db = new DatabaseSync(dbPath);
  t.after(() => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const identity = (id = 'summary'): SummaryAttemptIdentity => ({ id, scope: 'completed-history', sessionId: 'session', workspaceId: 'workspace', runId, providerId: config.providerId, modelId: config.modelId,
    sourceProjection: 'conversation-text-v1', sourceSha256: hash('exact source'), requestSha256: hash('exact serialized request'), requestBytes: 100,
    expectedMemoryRevision: 0, sourceMessageIds: ['source-message'], sourceRunIds: ['source-run'] });
  function completeProvider(id = 'summary', text = 'summary text') {
    store.createSummaryAttempt(identity(id)); store.dispatchSummaryAttempt(id); store.observeSummaryAttempt(id, { textDelta: text });
    store.observeSummaryAttempt(id, { finishReason: 'stop' }); store.markSummaryProviderCompleted(id);
  }
  function publication(id = 'summary', text = 'summary text') {
    const attempt = store.getSummaryAttempt(id), revisionId = `revision-${id}`;
    const revision: ContextRevision = { schemaVersion: 2, id: revisionId, sessionId: 'session', runId, revision: store.nextContextRevisionIndex('session'), kind: 'summary',
      sourceIds: [...attempt.sourceMessageIds!], text, sha256: hash(text), createdAt: stamp };
    const checkpoint: JsonObject = { id, version: 1, revisionId, sessionId: 'session', runId, providerId: config.providerId, modelId: config.modelId, sourceSha256: attempt.sourceSha256,
      sourceMessageIds: attempt.sourceMessageIds!, sourceRunIds: attempt.sourceRunIds!, cutoffRunId: attempt.sourceRunIds!.at(-1)!, usage: store.getSummaryUsage(id)?.usage as unknown as JsonObject ?? allUsage };
    return { payload: { summaryAttemptId: id, revisionId, usage: checkpoint.usage } as JsonObject,
      change: { revision, kind: 'context.memory', expectedRevision: attempt.expectedMemoryRevision, data: { active: checkpoint } } };
  }
  return { root, dbPath, db, store, runId, identity, completeProvider, publication };
}

test('DB4 migration keeps legacy rows and journals unchanged and creates no synthetic summary attempts', () => {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  try {
    migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 3));
    db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run('workspace', '/tmp/example', '{"legacy":"unchanged"}');
    const before = db.prepare('SELECT * FROM workspaces').all();
    migrateDatabase(db, DATABASE_MIGRATIONS.slice(0, 4)); assert.deepEqual(db.prepare('SELECT * FROM workspaces').all(), before);
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.equal(db.prepare('SELECT count(*) AS n FROM summary_attempts').get()?.n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM summary_usage').get()?.n, 0);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='model_session_latest_image'").get());
  } finally { db.close(); }
});

test('preparation owns an immutable exact source and request without a native Turn or Attempt', t => {
  const f = fixture(t), prepared = f.store.createSummaryAttempt(f.identity());
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.cleanupConfirmed, true);
  assert.deepEqual(f.store.createSummaryAttempt(f.identity()), prepared);
  assert.throws(() => f.store.createSummaryAttempt({ ...f.identity(), requestSha256: hash('changed request') }), hasCode('SUMMARY_IDENTITY_CONFLICT'));
  assert.throws(() => f.store.createSummaryAttempt({ ...f.identity('wrong'), workspaceId: 'other' }), hasCode('SUMMARY_BINDING_MISMATCH'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_turns').get()?.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM provider_attempts').get()?.n, 0);
  assert.equal(f.store.readSessionEvents('session', 0).filter(event => event.type === 'summary.prepared').length, 1);
  f.store.dispatchSummaryAttempt('summary'); assert.throws(() => f.store.dispatchSummaryAttempt('summary'), hasCode('SUMMARY_TRANSITION_INVALID'));
});

test('source arrays reject sparse, accessor, custom serialization and symbol metadata before observation', t => {
  const f = fixture(t), sparse = new Array<string>(1), accessor = ['valid'];
  let reads = 0; Object.defineProperty(accessor, '0', { enumerable: true, get: () => { reads++; return 'valid'; } });
  const custom = ['valid']; Object.defineProperty(custom, 'toJSON', { value: () => ['changed'] });
  for (const sourceMessageIds of [sparse, accessor, custom, new Proxy(['valid'], {})]) assert.throws(() => f.store.createSummaryAttempt({ ...f.identity(), sourceMessageIds }), hasCode('INVALID_SUMMARY_RECORD'));
  const supplied = { ...f.identity(), [Symbol('hidden')]: true }; assert.throws(() => f.store.createSummaryAttempt(supplied), hasCode('INVALID_SUMMARY_RECORD'));
  assert.equal(reads, 0); assert.equal(f.store.listSummaryAttempts('session').attempts.length, 0);
});

test('partial cumulative nullable usage merges without summing repeated snapshots and rolls back invalid snapshots', t => {
  const f = fixture(t); f.store.createSummaryAttempt(f.identity()); f.store.dispatchSummaryAttempt('summary');
  f.store.observeSummaryAttempt('summary', { usage: { inputTokens: 12, cachedInputTokens: 4 } });
  f.store.observeSummaryAttempt('summary', { usage: { inputTokens: null, outputTokens: 7, reasoningOutputTokens: 2 } });
  const before = f.store.getSummaryUsage('summary')!;
  assert.deepEqual(before.usage, { inputTokens: 12, cachedInputTokens: 4, outputTokens: 7, reasoningOutputTokens: 2 });
  f.store.observeSummaryAttempt('summary', { usage: { outputTokens: 7 } }); assert.deepEqual(f.store.getSummaryUsage('summary'), before);
  for (const usage of [{ inputTokens: 11 }, { cachedInputTokens: 13 }, { outputTokens: -1 }]) assert.throws(() => f.store.observeSummaryAttempt('summary', { usage }));
  assert.deepEqual(f.store.getSummaryUsage('summary'), before);
  const events = f.store.readSessionEvents('session', 0).filter(event => event.type === 'provider.usage');
  assert.equal(events.length, 2); assert.ok(events.every(event => event.payload.purpose === 'summary' && !event.attemptId && event.payload.summaryAttemptId === 'summary'));
});

test('provider usage journal failure rolls back both latest usage and summary state atomically', t => {
  const f = fixture(t); f.store.createSummaryAttempt(f.identity()); f.store.dispatchSummaryAttempt('summary');
  const before = f.store.getSummaryAttempt('summary'), seq = f.store.getSnapshot('session').lastSeq;
  f.db.exec("CREATE TRIGGER fail_summary_usage BEFORE INSERT ON events WHEN NEW.type='provider.usage' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => f.store.observeSummaryAttempt('summary', { usage: { inputTokens: 8 } }));
  assert.equal(f.store.getSummaryUsage('summary'), null); assert.deepEqual(f.store.getSummaryAttempt('summary'), before); assert.equal(f.store.getSnapshot('session').lastSeq, seq);
});

test('provider completion freezes observations and terminal state permits only duplicate usage', t => {
  const f = fixture(t); f.completeProvider();
  assert.equal(f.store.getSummaryAttempt('summary').publication, 'pending');
  for (const observation of [{ textDelta: 'late' }, { finishReason: 'stop' as const }, {}, { providerRequestId: 'late' }]) assert.throws(() => f.store.observeSummaryAttempt('summary', observation), hasCode('SUMMARY_ATTEMPT_IMMUTABLE'));
  const settled = f.store.settleSummaryAttempt('summary', { state: 'failed', cleanupConfirmed: true, errorCode: 'REVISION_CONFLICT' });
  assert.equal(settled.publication, 'discarded'); assert.deepEqual(f.store.observeSummaryAttempt('summary', { usage: allUsage }), settled);
  assert.throws(() => f.store.observeSummaryAttempt('summary', { usage: { outputTokens: 1 } }), hasCode('SUMMARY_ATTEMPT_IMMUTABLE'));
});

test('actual retention loss differs from observed UTF8 delta byte sum for split Unicode and oversized output', t => {
  const f = fixture(t); f.store.createSummaryAttempt(f.identity()); f.store.dispatchSummaryAttempt('summary');
  f.store.observeSummaryAttempt('summary', { textDelta: '\ud83d' }); f.store.observeSummaryAttempt('summary', { textDelta: '\ude00' });
  const emoji = f.store.getSummaryAttempt('summary'); assert.equal(emoji.partialText, '😀'); assert.equal(emoji.observedOutputBytes, 6); assert.equal(emoji.retainedTextBytes, 4); assert.equal(emoji.partialTextTruncated, false);
  f.store.observeSummaryAttempt('summary', { finishReason: 'stop' }); f.store.markSummaryProviderCompleted('summary');
  f.store.createSummaryAttempt(f.identity('large')); f.store.dispatchSummaryAttempt('large'); f.store.observeSummaryAttempt('large', { textDelta: 'é'.repeat(40000) });
  const large = f.store.getSummaryAttempt('large'); assert.equal(large.observedOutputBytes, 80000); assert.equal(large.retainedTextBytes, 65536); assert.equal(large.partialTextTruncated, true);
  f.store.observeSummaryAttempt('large', { finishReason: 'stop' }); assert.throws(() => f.store.markSummaryProviderCompleted('large'), hasCode('SUMMARY_PROTOCOL_ERROR'));
});

test('publication binds typed owner/source/IDs/CAS before atomically completing and rejects forged candidate', t => {
  const f = fixture(t); f.completeProvider(); const publication = f.publication();
  for (const mismatch of ['sourceSha256','sessionId','runId','sourceMessageIds','cutoffRunId','revisionSourceIds','expectedRevision']) {
    const forged = structuredClone(publication), checkpoint = forged.change.data.active as JsonObject;
    if (mismatch === 'sourceSha256') checkpoint.sourceSha256 = hash('different source');
    else if (mismatch === 'sourceMessageIds') checkpoint.sourceMessageIds = ['different-source'];
    else if (mismatch === 'revisionSourceIds') forged.change.revision.sourceIds = ['different-source'];
    else if (mismatch === 'expectedRevision') forged.change.expectedRevision = 1;
    else checkpoint[mismatch] = 'different-owner';
    assert.throws(() => f.store.commitContextDocument(f.runId, 'summary.completed', forged.payload, forged.change), hasCode('SUMMARY_BINDING_MISMATCH'));
  }
  assert.equal(f.store.getSummaryAttempt('summary').state, 'streaming'); assert.equal(f.store.getSessionDocument('session', 'context.memory'), null);
  f.store.commitContextDocument(f.runId, 'summary.completed', publication.payload, publication.change);
  const completed = f.store.getSummaryAttempt('summary'); assert.equal(completed.state, 'completed'); assert.equal(completed.publication, 'activated'); assert.equal(completed.summaryRevisionId, publication.change.revision.id);
  assert.equal(f.store.readSessionEvents('session', 0).filter(event => event.type === 'summary.completed').length, 1);
});

test('publication journal failure rolls back typed completion, immutable revision and memory pointer', t => {
  const f = fixture(t); f.completeProvider(); const publication = f.publication(), before = f.store.getSummaryAttempt('summary');
  f.db.exec("CREATE TRIGGER fail_summary_publication BEFORE INSERT ON session_events WHEN NEW.type='summary.completed' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => f.store.commitContextDocument(f.runId, 'summary.completed', publication.payload, publication.change));
  assert.deepEqual(f.store.getSummaryAttempt('summary'), before); assert.equal(f.store.getSessionDocument('session', 'context.memory'), null);
  assert.throws(() => f.store.getContextRevision(publication.change.revision.id));
});

test('terminal Run allows final owner-bound observations and settlement but blocks activation', t => {
  const f = fixture(t); f.store.createSummaryAttempt(f.identity()); f.store.dispatchSummaryAttempt('summary');
  f.store.commit(f.runId, 'run.failed', {}, { run: { state: 'failed' } });
  f.store.observeSummaryAttempt('summary', { textDelta: 'partial', usage: { outputTokens: 4 } });
  assert.equal(f.store.getSummaryUsage('summary')?.usage.outputTokens, 4);
  const settled = f.store.settleSummaryAttempt('summary', { state: 'interrupted', cleanupConfirmed: true, errorCode: 'ENGINE_CLOSED' });
  assert.equal(settled.partialText, 'partial'); assert.equal(settled.state, 'interrupted');
});

test('restart interrupts prepared or proof-complete unpublished attempts and quarantines dispatched orphan owner', t => {
  const f = fixture(t); f.store.createSummaryAttempt(f.identity('prepared')); f.store.createSummaryAttempt(f.identity('dispatched')); f.store.dispatchSummaryAttempt('dispatched');
  f.completeProvider('provider-done'); f.store.commit(f.runId, 'run.failed', {}, { run: { state: 'failed' } });
  assert.deepEqual(f.store.recoverInterrupted(), []);
  assert.equal(f.store.getSummaryAttempt('prepared').state, 'interrupted'); assert.equal(f.store.getSummaryAttempt('provider-done').state, 'interrupted');
  const uncertain = f.store.getSummaryAttempt('dispatched'); assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.cleanupConfirmed, false);
  assert.equal(f.store.hasUncertainSummaries('workspace'), true); assert.equal(f.store.getSessionControl('session').reason, 'recovery_required');
  const seq = f.store.getSnapshot('session').lastSeq; f.store.recoverInterrupted(); assert.equal(f.store.getSnapshot('session').lastSeq, seq);
});

test('owner-bound paging and reads reject foreign cursor before fetching payload and preserve exact JSON byte bounds', t => {
  const f = fixture(t); for (const id of ['one','two','three']) f.store.createSummaryAttempt(f.identity(id));
  f.store.createSession({ id: 'other-session', workspaceId: 'workspace', title: 'Other', createdAt: stamp });
  const page = f.store.listSummaryAttempts('session', { limit: 2 }); assert.deepEqual(page.attempts.map(attempt => attempt.id), ['one','two']); assert.equal(page.nextCursor, 'two');
  assert.deepEqual(f.store.listSummaryAttempts('session', { afterId: 'two' }).attempts.map(attempt => attempt.id), ['three']);
  assert.throws(() => f.store.getSummaryAttempt('one', 'other-session'), hasCode('SUMMARY_BINDING_MISMATCH'));
  assert.throws(() => f.store.listSummaryAttempts('other-session', { afterId: 'one' }), hasCode('INVALID_SUMMARY_CURSOR'));
  f.db.exec("UPDATE summary_attempts SET revision=9007199254740992 WHERE id='one'"); assert.throws(() => f.store.getSummaryAttempt('one'), hasCode('SUMMARY_BINDING_MISMATCH'));
});
