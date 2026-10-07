import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type EngineEvent, type JsonObject, type MessagePart, type ProviderAttempt, type Run, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import type { NativeSessionStorage } from '../storage/native.js';
import type { SummaryAttemptStorage } from '../storage/summary-attempts.js';
import { captureSummaryRecoveryHighWater, SUMMARY_RECOVERY_PROOF_SCHEMA, SUMMARY_RECOVERY_SCHEMA, SummaryRecoveryStorage, validateSummaryRecoveryRequest, type SummaryRecoveryRequest } from './summary.js';
import { canonical } from './snapshot.js';
import { readEvidenceBody, withEvidenceRead } from '../storage/evidence-read.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const config = { providerId: 'fixture', modelId: 'model', mode: 'plan' as const, limits: { ...DEFAULT_LIMITS } };
function fixture(t: TestContext, restart = true) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-summary-recovery-')), path = join(directory, 'engine.sqlite');
  let store = new SqliteStore(path), binding = hash('original physical host scope');
  const timestamp = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: timestamp });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Recovery', createdAt: timestamp });
  store.createSession({ id: 'other', workspaceId: 'workspace', title: 'Other', createdAt: timestamp });
  const older = store.admit({ sessionId: 'session', requestId: 'old', prompt: 'Exact historical goal', config });
  store.commit(older.runId, 'run.started', {}, { run: { state: 'running' } });
  store.commit(older.runId, 'message.completed', {}, { message: { id: 'old-answer', sessionId: 'session', runId: older.runId, role: 'assistant', content: 'Historical verified observation.', createdAt: timestamp } });
  store.commit(older.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const messages = store.readModelHistory('session').snapshot.messages;
  const source = JSON.stringify(messages.map(({ id, runId, role, content }) => ({ id, runId, role, content })));
  const current = store.admit({ sessionId: 'session', requestId: 'current', prompt: 'Original current constraint', config });
  store.commit(current.runId, 'run.started', {}, { run: { state: 'running' } });
  const currentOwner = store as unknown as { db: DatabaseSync };
  const baselineMessageId = String(currentOwner.db.prepare("SELECT id FROM messages WHERE run_id=? AND json_extract(data,'$.role')='user' LIMIT 1").get(current.runId)!.id);
  store.createSummaryAttempt({ id: 'summary', scope: 'completed-history', sessionId: 'session', workspaceId: 'workspace', runId: current.runId,
    providerId: config.providerId, modelId: config.modelId, sourceProjection: 'conversation-text-v1', sourceSha256: hash(source), requestSha256: hash('exact host request'), requestBytes: 100,
    expectedMemoryRevision: 0, sourceMessageIds: messages.map(message => message.id), sourceRunIds: [older.runId] });
  store.dispatchSummaryAttempt('summary'); store.observeSummaryAttempt('summary', { textDelta: 'Observed partial summary.', usage: { inputTokens: 9 } });
  store.settleSummaryAttempt('summary', { state: 'uncertain', cleanupConfirmed: false, errorCode: 'CLEANUP_UNCERTAIN' });
  const text = JSON.stringify([{ role: 'user', content: 'Original current constraint' }]);
  store.putContextRevision({ schemaVersion: 2, id: 'context', sessionId: 'session', runId: current.runId, revision: 1, kind: 'baseline', text, sha256: hash(text), sourceIds: [...messages.map(message => message.id),baselineMessageId], createdAt: timestamp });
  store.putSessionDocument('session', 'context.head', 0, { revisionId: 'context', observation: 'initial' });
  store.commit(current.runId, 'run.failed', { error: { code: 'CLEANUP_UNCERTAIN' } }, { run: { state: 'failed', error: { code: 'CLEANUP_UNCERTAIN', message: 'Unknown summary cleanup' } } });
  if (restart) { store.close(); store = new SqliteStore(path); }
  store.configureSummaryRecovery(() => binding);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.getSnapshot = () => { throw new Error('Summary recovery requires bounded owner queries'); };
  const request = (): SummaryRecoveryRequest => {
    const preview = store.getSummaryRecoveryPreview('session', 'summary'); assert.equal(preview.status, 'eligible', JSON.stringify(preview.blockers)); assert.ok(preview.fingerprint);
    return { sessionId: 'session', summaryAttemptId: 'summary', requestId: 'host-decision', fingerprint: preview.fingerprint, acknowledged: true };
  };
  return { store, db, request, current, baselineMessageId, rawBinding: () => binding, setBinding(value: string) { binding = value; } };
}

test('summary recovery request validation rejects proxy/getter traps without reading them and returns a detached snapshot', () => {
  let traps = 0;
  const value = { sessionId: 'session', summaryAttemptId: 'summary', requestId: 'request', fingerprint: 'a'.repeat(64), acknowledged: true };
  const proxy = new Proxy(value, { getPrototypeOf() { traps++; throw new Error('Unexpected prototype trap'); }, ownKeys() { traps++; throw new Error('Unexpected keys trap'); } });
  assert.throws(() => validateSummaryRecoveryRequest(proxy), code('SUMMARY_RECOVERY_INVALID_REQUEST')); assert.equal(traps, 0);
  assert.throws(() => validateSummaryRecoveryRequest({ ...value, get fingerprint() { traps++; return 'a'.repeat(64); } }), code('SUMMARY_RECOVERY_INVALID_REQUEST')); assert.equal(traps, 0);
  const snapshot = validateSummaryRecoveryRequest(value); value.sessionId = 'changed'; assert.equal(snapshot.sessionId, 'session');
  assert.throws(() => validateSummaryRecoveryRequest({ ...value, acknowledged: false }), code('SUMMARY_RECOVERY_ACKNOWLEDGMENT_REQUIRED'));
});

test('previous-boot ACK adds one ledger and both audits without changing original summary, usage, context or pause', t => {
  const f = fixture(t), request = f.request(), before = { attempt: f.store.getSummaryAttempt('summary'), usage: f.store.getSummaryUsage('summary'), head: f.store.getSessionDocument('session', 'context.head'), pause: f.store.getSessionControl('session') };
  assert.equal(f.store.hasUncertainSummaries('workspace'), true);
  const receipt = f.store.acknowledgeSummaryRecovery(request); assert.equal(receipt.duplicate, false); assert.equal(receipt.cleanupConfirmed, false); assert.equal(receipt.executionResumed, false);
  assert.equal(f.store.hasUncertainSummaries('workspace'), false); assert.equal(f.store.getSummaryRecoveryPreview('session', 'summary').status, 'acknowledged');
  assert.deepEqual({ attempt: f.store.getSummaryAttempt('summary'), usage: f.store.getSummaryUsage('summary'), head: f.store.getSessionDocument('session', 'context.head'), pause: f.store.getSessionControl('session') }, before);
  assert.equal(f.store.readEvents('session', 0).filter(event => event.type === 'summary.recovery.acknowledged').length, 1);
  assert.equal(f.store.readSessionEvents('session', 0).filter(event => event.type === 'summary.recovery.acknowledged').length, 1);
  const duplicate = f.store.acknowledgeSummaryRecovery(request); assert.deepEqual(duplicate, { ...receipt, duplicate: true });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n, 1);
  assert.throws(() => f.store.acknowledgeSummaryRecovery({ ...request, fingerprint: 'b'.repeat(64) }), code('SUMMARY_RECOVERY_REQUEST_CONFLICT'));
});

test('same-boot summary and another session owner cannot receive a new acknowledgment', t => {
  const f = fixture(t, false), preview = f.store.getSummaryRecoveryPreview('session', 'summary');
  assert.equal(preview.status, 'blocked'); assert.ok(preview.blockers.includes('SUMMARY_RECOVERY_RESTART_REQUIRED'));
  assert.throws(() => f.store.acknowledgeSummaryRecovery({ sessionId: 'session', summaryAttemptId: 'summary', requestId: 'unsafe', fingerprint: 'a'.repeat(64), acknowledged: true }), code('SUMMARY_RECOVERY_RESTART_REQUIRED'));
  assert.throws(() => f.store.getSummaryRecoveryPreview('other', 'summary'), code('SUMMARY_RECOVERY_OWNER_MISMATCH'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n, 0);
});

for (const target of ['source-run', 'source-message', 'source-run-sql-owner'] as const) test(`foreign ${target} metadata is rejected before its raw recovery body is returned`, t => {
  const f = fixture(t), foreign = f.store.admit({ sessionId: 'other', requestId: 'foreign', prompt: 'Foreign source body sentinel', config });
  f.store.commit(foreign.runId, 'run.started', {}, { run: { state: 'running' } });
  f.store.commit(foreign.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const ownDb = (f.store as unknown as { db: DatabaseSync }).db;
  const original = ownDb.prepare.bind(ownDb);
  const foreignMessageId = String(f.db.prepare('SELECT id FROM messages WHERE run_id=? LIMIT 1').get(foreign.runId)!.id);
  let table = 'runs', identity = foreign.runId, bodyReads = 0;
  if (target === 'source-run') f.db.prepare("UPDATE summary_attempts SET data=json_set(data,'$.sourceRunIds',json(?)) WHERE id='summary'").run(JSON.stringify([foreign.runId]));
  if (target === 'source-message') {
    table = 'messages'; identity = foreignMessageId;
    f.db.prepare("UPDATE summary_attempts SET data=json_set(data,'$.sourceMessageIds',json(?)) WHERE id='summary'").run(JSON.stringify([identity]));
  }
  if (target === 'source-run-sql-owner') {
    identity = String(f.db.prepare("SELECT run_id FROM messages WHERE id='old-answer'").get()!.run_id);
    f.db.prepare('UPDATE runs SET session_id=? WHERE id=?').run('other', identity);
  }
  ownDb.prepare = ((sql: string) => {
    const statement = original(sql), get = statement.get.bind(statement);
    statement.get = ((...parameters: SQLInputValue[]) => {
      const row = get(...parameters);
      if (sql.includes(`FROM ${table} WHERE id=?`) && parameters[0] === identity && typeof row?.data === 'string') bodyReads++;
      return row;
    }) as typeof statement.get;
    return statement;
  }) as typeof ownDb.prepare;
  try {
    const preview = f.store.getSummaryRecoveryPreview('session', 'summary');
    assert.equal(preview.status, 'blocked'); assert.ok(preview.blockers.includes('SUMMARY_RECOVERY_OWNER_MISMATCH'));
    assert.equal(bodyReads, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n, 0);
  } finally { ownDb.prepare = original; }
});

test('a consumed root evidence budget stays blocked for summary predicates while a new historical receipt read is independent', t => {
  const f = fixture(t), request = f.request(), receipt = f.store.acknowledgeSummaryRecovery(request);
  const ownDb = (f.store as unknown as { db: DatabaseSync }).db;
  f.db.prepare("UPDATE messages SET data=json_set(data,'$.content',?) WHERE id='old-answer'").run('x'.repeat(8388608));
  ownDb.exec('BEGIN');
  try {
    assert.throws(() => withEvidenceRead(ownDb, () => {
      assert.throws(() => readEvidenceBody(ownDb, { table: 'messages', key: 'old-answer' }, { maxBytes: 8388608 }), code('RECOVERY_EVIDENCE_LIMIT'));
      const recovery = (f.store as unknown as { summaryRecovery: SummaryRecoveryStorage }).summaryRecovery;
      assert.equal(recovery.hasValidAcknowledgment('session', 'summary'), false);
      assert.equal(recovery.hasUnacknowledged('workspace'), true);
    }), code('RECOVERY_EVIDENCE_LIMIT'));
  } finally { ownDb.exec('ROLLBACK'); }
  assert.deepEqual(f.store.acknowledgeSummaryRecovery(request), { ...receipt, duplicate: true });
});

test('same-write-transaction callback source mutation invalidates cached raw evidence before ACK and rolls back both journals', t => {
  const f = fixture(t), request = f.request();
  const internal = f.store as unknown as { db: DatabaseSync; native: NativeSessionStorage };
  const originalPrepare = internal.db.prepare.bind(internal.db), originalRun = internal.native.hooks.run;
  const originalBody = String(f.db.prepare("SELECT data FROM messages WHERE id='old-answer'").get()!.data);
  const originalContent = (JSON.parse(originalBody) as { content: string }).content;
  let firstBaselineRead = false, mutated = false;
  internal.db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql), get = statement.get.bind(statement);
    statement.get = ((...parameters: SQLInputValue[]) => {
      const row = get(...parameters);
      if (sql.includes('FROM context_revisions WHERE id=?') && parameters[0] === 'context' && typeof row?.data === 'string') firstBaselineRead = true;
      return row;
    }) as typeof statement.get;
    return statement;
  }) as typeof internal.db.prepare;
  internal.native.hooks.run = runId => {
    if (firstBaselineRead && !mutated) {
      mutated = true;
      originalPrepare("UPDATE messages SET data=json_set(data,'$.content',?) WHERE id='old-answer'").run('X'.repeat(originalContent.length));
    }
    return originalRun(runId);
  };
  try {
    assert.throws(() => f.store.acknowledgeSummaryRecovery(request), code('SUMMARY_RECOVERY_SOURCE_CHANGED'));
    assert.equal(mutated, true);
    assert.equal(String(f.db.prepare("SELECT data FROM messages WHERE id='old-answer'").get()!.data), originalBody);
    for (const table of ['summary_recovery_acknowledgments','events','session_events']) {
      const query = table === 'summary_recovery_acknowledgments' ? `SELECT count(*) AS n FROM ${table}` : `SELECT count(*) AS n FROM ${table} WHERE type='summary.recovery.acknowledged'`;
      assert.equal(f.db.prepare(query).get()!.n, 0);
    }
  } finally { internal.native.hooks.run = originalRun; internal.db.prepare = originalPrepare; }
  assert.equal(f.store.acknowledgeSummaryRecovery(request).duplicate, false);
});

test('cached raw summary bodies still produce independently validated detached records', t => {
  const f = fixture(t), ownDb = (f.store as unknown as { db: DatabaseSync }).db;
  const original = f.store.getSummaryAttempt('summary');
  ownDb.exec('BEGIN');
  try { withEvidenceRead(ownDb, () => {
    const first = f.store.getSummaryAttempt('summary'); first.partialText = 'Caller mutation'; first.sourceMessageIds!.splice(0);
    assert.deepEqual(f.store.getSummaryAttempt('summary'), original);
    const usage = f.store.getSummaryUsage('summary')!; usage.usage.inputTokens = 999;
    assert.equal(f.store.getSummaryUsage('summary')!.usage.inputTokens, 9);
  }); } finally { ownDb.exec('ROLLBACK'); }
});

test('mutable head changes reject stale preview but do not invalidate a completed immutable ACK', t => {
  const f = fixture(t), stale = f.request();
  f.store.putSessionDocument('session', 'context.head', 1, { revisionId: 'context', observation: 'concurrent host update' });
  assert.throws(() => f.store.acknowledgeSummaryRecovery(stale), code('SUMMARY_RECOVERY_STALE'));
  const request = f.request(); f.store.acknowledgeSummaryRecovery(request);
  f.store.putSessionDocument('session', 'context.head', 2, { revisionId: 'context', observation: 'later explicit Run context' });
  assert.equal(f.store.hasUncertainSummaries('workspace'), false); assert.equal(f.store.getSummaryRecoveryPreview('session', 'summary').status, 'acknowledged');
  assert.equal(f.store.acknowledgeSummaryRecovery(request).duplicate, true);
});

for (const target of ['source-text','source-replay','revision','ledger-revision','scope'] as const) test(`ACK is inactive after immutable ${target} changes, while the original receipt is only a read-only historical decision`, t => {
  const f = fixture(t), request = f.request(), receipt = f.store.acknowledgeSummaryRecovery(request);
  if (target === 'source-text') f.db.prepare("UPDATE messages SET data=json_set(data,'$.content','Changed observation') WHERE id='old-answer'").run();
  if (target === 'source-replay') f.db.prepare("UPDATE messages SET data=json_set(data,'$.providerReplay',json(?)) WHERE id='old-answer'").run('{"providerId":"fixture","items":[{"type":"opaque_changed"}]}');
  if (target === 'revision') f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.text','Changed immutable context') WHERE id='context'").run();
  if (target === 'ledger-revision') f.db.prepare('UPDATE summary_recovery_acknowledgments SET attempt_revision=attempt_revision+1').run();
  if (target === 'scope') f.setBinding(hash('copied physical database and artifact directory'));
  assert.equal(f.store.hasUncertainSummaries('workspace'), true);
  if (target === 'scope') assert.equal(f.store.getSummaryRecoveryPreview('session', 'summary').status, 'eligible');
  else { const preview = f.store.getSummaryRecoveryPreview('session', 'summary'); assert.equal(preview.status, 'blocked'); assert.ok(preview.blockers.includes('SUMMARY_RECOVERY_SOURCE_CHANGED')); }
  if (target !== 'ledger-revision' && target !== 'scope') assert.deepEqual(f.store.acknowledgeSummaryRecovery(request), { ...receipt, duplicate: true });
});

for (const stream of ['events','session_events']) test(`ledger and both audit journals roll back when ${stream} publication fails`, t => {
  const f = fixture(t), request = f.request();
  f.db.exec(`CREATE TRIGGER reject_summary_ack BEFORE INSERT ON ${stream} WHEN NEW.type='summary.recovery.acknowledged' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
  assert.throws(() => f.store.acknowledgeSummaryRecovery(request));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n, 0);
  for (const table of ['events','session_events']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE type='summary.recovery.acknowledged'`).get()!.n, 0);
  assert.equal(f.store.hasUncertainSummaries('workspace'), true); assert.equal(f.store.getSummaryAttempt('summary').state, 'uncertain');
});

test('oversized pinned source is blocked before returning its body to JavaScript', t => {
  const f = fixture(t); f.db.prepare("UPDATE messages SET data=json_set(data,'$.content',?) WHERE id='old-answer'").run('x'.repeat(2097153));
  const preview = f.store.getSummaryRecoveryPreview('session', 'summary'); assert.equal(preview.status, 'blocked'); assert.ok(preview.blockers.includes('SUMMARY_RECOVERY_LIMIT'));
  assert.equal(f.store.hasUncertainSummaries('workspace'), true);
});

test('active-prefix exact tool fact reconstruction retains reused provider IDs and validates terminal Part owners', t => {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-prefix-recovery-')), path = join(directory, 'engine.sqlite');
  let store = new SqliteStore(path); const createdAt = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Active prefix recovery', createdAt });
  const input = store.acceptInput({ sessionId: 'session', requestId: 'goal', prompt: 'Original authoritative goal', delivery: 'queue', config });
  const run = store.promoteInput(input.inputId).run; store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  for (let index = 0; index < 3; index++) {
    const turn: TurnRecord = { schemaVersion: 2, id: `turn-${index}`, sessionId: 'session', runId: run.id, index, inputIds: [input.inputId], state: 'created', createdAt };
    store.putTurn(turn); store.putTurn({ ...turn, state: 'streaming' });
    const attempt: ProviderAttempt = { schemaVersion: 2, id: `attempt-${index}`, sessionId: 'session', runId: run.id, turnId: turn.id, index: 0, providerId: config.providerId, modelId: config.modelId, state: 'prepared', createdAt };
    store.putAttempt(attempt); const dispatched = store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: createdAt });
    const call = { id: 'reused-provider-call', name: 'read_file', input: { path: `observation-${index}.txt` } };
    const assistantId = `assistant-${index}`, content = `Exact historical nonce-${index}`;
    store.commit(run.id, 'message.completed', {}, { message: { id: assistantId, sessionId: 'session', runId: run.id, role: 'assistant', content: `Inspect ${index}`, toolCalls: [call], createdAt } });
    const part: MessagePart = { schemaVersion: 2, id: `part-${index}`, sessionId: 'session', runId: run.id, turnId: turn.id, messageId: assistantId, index: 0, revision: 0, state: 'open', type: 'tool', toolCallId: `internal-${index}`, providerCallId: call.id, name: call.name, input: call.input, createdAt };
    store.putPart(part); store.putAttempt({ ...dispatched, state: 'completed', completedAt: createdAt }); store.putTurn({ ...turn, state: 'awaiting_tools' });
    store.commit(run.id, 'tool.completed', {}, { tool: { id: part.toolCallId, sessionId: 'session', runId: run.id, name: call.name, input: call.input, state: 'completed', output: content } });
    store.commit(run.id, 'message.completed', {}, { message: { id: `result-${index}`, sessionId: 'session', runId: run.id, role: 'tool', toolCallId: call.id, content, createdAt } });
    store.putPart({ ...part, revision: 1, state: 'completed', result: { output: content, isError: false, truncated: false }, completedAt: createdAt });
    store.putTurn({ ...turn, state: 'completed', finishReason: 'tool_calls', completedAt: createdAt });
  }
  const source = store.readActivePrefixSource(run.id, { stage: 'between-turns', policySha256: hash('host policy'), maxSourceMessages: 128, maxSourceBytes: 65536, keepRecentTurns: 1, maxCoveredMessages: 512 });
  assert.deepEqual(source.sourceMessageIds, ['assistant-0','result-0','assistant-1','result-1']);
  store.createSummaryAttempt({ id: 'active-summary', scope: 'active-run-prefix', sessionId: 'session', workspaceId: 'workspace', runId: run.id, providerId: config.providerId, modelId: config.modelId,
    sourceProjection: source.projection, sourceSha256: source.factsSha256, manifestSha256: source.manifestSha256, policySha256: source.policySha256, requestSha256: hash('exact active request'), requestBytes: 100,
    sourceMessageIds: source.sourceMessageIds, sourceTurnIds: source.sourceTurnIds, boundaryTurnId: source.boundaryTurnId, boundaryAttemptId: source.boundaryAttemptId, expectedMemoryRevision: 0, expectedContextHeadRevision: 0 });
  store.dispatchSummaryAttempt('active-summary'); store.observeSummaryAttempt('active-summary', { textDelta: 'Visible partial active observations' });
  store.settleSummaryAttempt('active-summary', { state: 'uncertain', cleanupConfirmed: false, errorCode: 'CLEANUP_UNCERTAIN' });
  store.commit(run.id, 'run.failed', {}, { run: { state: 'failed' } }); store.close(); store = new SqliteStore(path); store.configureSummaryRecovery(() => hash('unchanged physical scope'));
  const db = new DatabaseSync(path); t.after(() => { db.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const original = store.getSummaryAttempt('active-summary'), originalTurns = store.listTurns(run.id);
  const preview = store.getSummaryRecoveryPreview('session', 'active-summary'); assert.equal(preview.status, 'eligible', JSON.stringify(preview.blockers)); assert.ok(preview.fingerprint);
  store.acknowledgeSummaryRecovery({ sessionId: 'session', summaryAttemptId: 'active-summary', requestId: 'host-active-ack', fingerprint: preview.fingerprint, acknowledged: true });
  assert.equal(store.hasUncertainSummaries('workspace'), false); assert.deepEqual(store.getSummaryAttempt('active-summary'), original); assert.deepEqual(store.listTurns(run.id), originalTurns);
  db.prepare("UPDATE message_parts SET data=json_set(data,'$.runId','another-run') WHERE id='part-0'").run();
  assert.equal(store.hasUncertainSummaries('workspace'), true); const invalid = store.getSummaryRecoveryPreview('session', 'active-summary'); assert.equal(invalid.status, 'blocked'); assert.ok(invalid.blockers.includes('SUMMARY_RECOVERY_SOURCE_CHANGED'));
});

for (const data of ['null', '{', '[]']) test(`malformed ledger ${data} is a typed blocked preview and cannot clear execution`, t => {
  const f = fixture(t), request = f.request(); f.store.acknowledgeSummaryRecovery(request);
  f.db.prepare('UPDATE summary_recovery_acknowledgments SET data=?').run(data);
  assert.equal(f.store.hasUncertainSummaries('workspace'), true); const preview = f.store.getSummaryRecoveryPreview('session', 'summary');
  assert.equal(preview.status, 'blocked'); assert.ok(preview.blockers.includes('SUMMARY_RECOVERY_SOURCE_CHANGED'));
});

test('V2 decision pins genuinely baseline-only source refs and rejects pin removal after source drift', t => {
  const f = fixture(t), request = f.request(), preview = f.store.getSummaryRecoveryPreview('session', 'summary');
  const receipt = f.store.acknowledgeSummaryRecovery(request);
  const row = f.db.prepare('SELECT data,proof_version,pins_sha256,startup_high_water FROM summary_recovery_acknowledgments').get()!;
  const audit = JSON.parse(String(row.data));
  assert.equal(row.proof_version, 2); assert.equal(audit.proofVersion, 2); assert.equal(row.pins_sha256, hash(canonical(audit.pins)));
  assert.equal(receipt.bindingScope, hash(canonical({ kind: 'summary-recovery', proofVersion: 2, storageBinding: f.rawBinding() })));
  assert.ok(audit.pins.some((pin: { id: string }) => pin.id === f.baselineMessageId));
  assert.ok(!f.store.getSummaryAttempt('summary').sourceMessageIds!.includes(f.baselineMessageId), 'The changed message is outside summarized history');
  f.db.prepare("UPDATE messages SET data=json_set(data,'$.content','Changed decision-time baseline-only constraint') WHERE id=?").run(f.baselineMessageId);
  assert.equal(f.store.hasUncertainSummaries('workspace'), true);
  assert.equal(f.store.getSummaryRecoveryPreview('session', 'summary').sourceOwnerSha256, preview.sourceOwnerSha256, 'Original summary source remains unchanged');
  f.db.exec("UPDATE summary_recovery_acknowledgments SET data=json_set(data,'$.pins',json('[]'))");
  assert.equal(f.store.hasUncertainSummaries('workspace'), true);
  const rejected = f.store.getSummaryRecoveryPreview('session', 'summary'); assert.equal(rejected.status, 'blocked'); assert.ok(rejected.blockers.includes('SUMMARY_RECOVERY_SOURCE_CHANGED'));
});

test('coordinated V2 pins and SQL pin-digest mutation cannot match the original decision fingerprint', t => {
  const f = fixture(t), request = f.request(), receipt = f.store.acknowledgeSummaryRecovery(request);
  const audit = JSON.parse(String(f.db.prepare('SELECT data FROM summary_recovery_acknowledgments').get()!.data));
  audit.pins = []; audit.pinsSha256 = hash(canonical([]));
  f.db.prepare('UPDATE summary_recovery_acknowledgments SET pins_sha256=?,data=?').run(audit.pinsSha256, JSON.stringify(audit));
  assert.equal(f.store.hasUncertainSummaries('workspace'), true);
  assert.equal(f.store.getSummaryRecoveryPreview('session', 'summary').status, 'blocked');
  assert.deepEqual(f.store.findSummaryRecoveryReceipt(request), { ...receipt, duplicate: true }, 'Historical receipt lookup does not reactivate invalid proof');
});

function legacyDecision(f: ReturnType<typeof fixture>) {
  const preview = f.store.getSummaryRecoveryPreview('session', 'summary'), request = f.request();
  f.store.acknowledgeSummaryRecovery(request);
  const row = f.db.prepare('SELECT * FROM summary_recovery_acknowledgments').get()!, audit = JSON.parse(String(row.data));
  // Materialize the historical DB5 format from this fixture's exact observations.
  // Its old fingerprint did not include the immutable pin digest.
  const legacyFingerprint = hash(canonical({ ...preview, status: 'blocked', fingerprint: null, bindingScope: f.rawBinding(),
    startupHighWater: captureSummaryRecoveryHighWater(f.db) }));
  audit.receipt.requestId = 'legacy-host-decision'; audit.receipt.bindingScope = f.rawBinding(); audit.receipt.fingerprint = legacyFingerprint;
  delete audit.proofVersion; delete audit.pinsSha256; delete audit.startupHighWater;
  const body = JSON.stringify(audit), receipt = audit.receipt;
  f.db.prepare('UPDATE summary_recovery_acknowledgments SET request_id=?,binding_scope=?,fingerprint=?,proof_version=1,pins_sha256=NULL,startup_high_water=NULL,data=? WHERE id=?')
    .run(receipt.requestId, receipt.bindingScope, receipt.fingerprint, body, receipt.id);
  for (const table of ['events','session_events']) {
    const event = f.db.prepare(`SELECT data FROM ${table} WHERE type='summary.recovery.acknowledged' LIMIT 1`).get()!;
    const value = JSON.parse(String(event.data)); value.payload = { ...receipt }; delete value.payload.duplicate;
    f.db.prepare(`UPDATE ${table} SET data=? WHERE type='summary.recovery.acknowledged'`).run(JSON.stringify(value));
  }
  return { body, receipt, request: { sessionId: 'session', summaryAttemptId: 'summary', requestId: receipt.requestId, fingerprint: receipt.fingerprint, acknowledged: true } as SummaryRecoveryRequest };
}

test('V1 decision remains inactive historical evidence with exact old retry and a fresh independent V2 decision', t => {
  const f = fixture(t), legacy = legacyDecision(f);
  assert.equal(f.store.hasUncertainSummaries('workspace'), true);
  const preview = f.store.getSummaryRecoveryPreview('session', 'summary'); assert.equal(preview.status, 'eligible'); assert.ok(preview.fingerprint);
  assert.notEqual(preview.bindingScope, legacy.receipt.bindingScope);
  const original = { attempt: f.store.getSummaryAttempt('summary'), usage: f.store.getSummaryUsage('summary'), head: f.store.getSessionDocument('session', 'context.head'), pause: f.store.getSessionControl('session') };
  const count = () => f.db.prepare('SELECT count(*) AS n FROM session_events').get()!.n;
  const before = count();
  assert.deepEqual(f.store.findSummaryRecoveryReceipt(legacy.request), { ...legacy.receipt, duplicate: true });
  assert.deepEqual(f.store.acknowledgeSummaryRecovery(legacy.request), { ...legacy.receipt, duplicate: true });
  assert.equal(count(), before); assert.equal(f.store.hasUncertainSummaries('workspace'), true);
  assert.throws(() => f.store.findSummaryRecoveryReceipt({ ...legacy.request, fingerprint: hash('different old request') }), code('SUMMARY_RECOVERY_REQUEST_CONFLICT'));
  const newReceipt = f.store.acknowledgeSummaryRecovery({ ...legacy.request, requestId: 'fresh-proof-v2', fingerprint: preview.fingerprint });
  assert.notEqual(newReceipt.id, legacy.receipt.id); assert.equal(f.store.hasUncertainSummaries('workspace'), false);
  assert.deepEqual(f.store.acknowledgeSummaryRecovery(legacy.request), { ...legacy.receipt, duplicate: true });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n, 2);
  assert.equal(f.db.prepare('SELECT data FROM summary_recovery_acknowledgments WHERE id=?').get(legacy.receipt.id)!.data, legacy.body);
  assert.deepEqual({ attempt: f.store.getSummaryAttempt('summary'), usage: f.store.getSummaryUsage('summary'), head: f.store.getSessionDocument('session', 'context.head'), pause: f.store.getSessionControl('session') }, original);
});

test('DB7 proof ALTER preserves raw DB5 body and leaves old missing pin proof unavailable', t => {
  const f = fixture(t), legacy = legacyDecision(f), row = f.db.prepare('SELECT * FROM summary_recovery_acknowledgments').get()!;
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  for (const [table, identity] of [['workspaces',row.workspace_id],['sessions',row.session_id],['runs',row.run_id],['summary_attempts',row.summary_attempt_id]] as const) {
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`); db.prepare(`INSERT INTO ${table}(id) VALUES(?)`).run(String(identity));
  }
  db.exec(SUMMARY_RECOVERY_SCHEMA);
  db.prepare('INSERT INTO summary_recovery_acknowledgments(id,summary_attempt_id,session_id,workspace_id,run_id,request_id,binding_scope,attempt_revision,fingerprint,record_sha256,usage_sha256,source_owner_sha256,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(String(row.id),String(row.summary_attempt_id),String(row.session_id),String(row.workspace_id),String(row.run_id),String(row.request_id),String(row.binding_scope),Number(row.attempt_revision),String(row.fingerprint),String(row.record_sha256),row.usage_sha256 === null ? null : String(row.usage_sha256),String(row.source_owner_sha256),legacy.body);
  db.exec(SUMMARY_RECOVERY_PROOF_SCHEMA);
  const migrated = db.prepare('SELECT data,binding_scope,fingerprint,proof_version,pins_sha256,startup_high_water FROM summary_recovery_acknowledgments').get()!;
  assert.equal(migrated.data, legacy.body); assert.equal(migrated.binding_scope, legacy.receipt.bindingScope); assert.equal(migrated.fingerprint, legacy.receipt.fingerprint);
  assert.equal(migrated.proof_version, 1); assert.equal(migrated.pins_sha256, null); assert.equal(migrated.startup_high_water, null);
});

test('summary boot frontier is frozen after construction and historical owner checks precede ledger bodies', t => {
  const f = fixture(t), owner = f.store as unknown as { native: NativeSessionStorage; summaryRecords: SummaryAttemptStorage; append(run: Run, type: string, payload: JsonObject): EngineEvent };
  const options = { bindingScope: () => f.rawBinding(), startupHighWater: '0', appendLegacy: (run: Run, type: string, payload: JsonObject) => owner.append(run,type,payload) };
  const recovery = new SummaryRecoveryStorage(owner.native, owner.summaryRecords, options); options.startupHighWater = captureSummaryRecoveryHighWater(f.db);
  assert.ok(recovery.preview('session','summary').blockers.includes('SUMMARY_RECOVERY_RESTART_REQUIRED'));
  const legacy = legacyDecision(f); let payloadReads = 0; const db = owner.native.database, prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => { if (/SELECT data FROM summary_recovery_acknowledgments/u.test(sql)) payloadReads++; return prepare(sql); }) as typeof db.prepare;
  try { assert.throws(() => recovery.findReceipt({ ...legacy.request, sessionId: 'other' }), code('SUMMARY_RECOVERY_OWNER_MISMATCH')); assert.equal(payloadReads,0); }
  finally { db.prepare = prepare; }
});

function semanticChain(f: ReturnType<typeof fixture>, extraReferences: string[] = []) {
  const stamp = new Date().toISOString(), side = f.store.admit({ sessionId: 'session', requestId: 'baseline-source-run', prompt: 'Separate baseline source', config });
  f.store.commit(side.runId,'run.started',{}, { run: { state: 'running' } });
  f.store.commit(side.runId,'message.completed',{}, { message: { id: 'baseline-native-message', sessionId: 'session', runId: side.runId, role: 'assistant', content: 'Exact baseline-only observation M1', createdAt: stamp } });
  const firstText = 'First derived semantic memory S1';
  f.store.putContextRevision({ schemaVersion: 2, id: 'semantic-S1', sessionId: 'session', runId: side.runId, revision: 2, kind: 'summary',
    sourceIds: ['baseline-native-message'], text: firstText, sha256: hash(firstText), supersedesId: 'context', createdAt: stamp });
  f.store.commit(side.runId,'run.completed',{}, { run: { state: 'completed' } });
  const secondText = 'Later semantic memory S2 preserves S1';
  f.store.putContextRevision({ schemaVersion: 2, id: 'semantic-S2', sessionId: 'session', revision: 3, kind: 'summary',
    sourceIds: ['old-answer','semantic-S1',...extraReferences], text: secondText, sha256: hash(secondText), supersedesId: 'semantic-S1', createdAt: stamp });
  f.store.putSessionDocument('session','context.head',1,{ revisionId: 'semantic-S2' });
  return { sideRunId: side.runId };
}

test('missing nested semantic source before ACK is fail-closed instead of skipped', t => {
  const f = fixture(t); semanticChain(f);
  f.db.exec("DELETE FROM messages WHERE id='baseline-native-message'");
  const preview = f.store.getSummaryRecoveryPreview('session','summary');
  assert.equal(preview.status,'blocked'); assert.ok(preview.blockers.includes('SUMMARY_RECOVERY_SOURCE_CHANGED'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM summary_recovery_acknowledgments').get()!.n,0);
});

for (const target of ['message','earlier-summary','source-owner'] as const) test(`transitive baseline ${target} drift after ACK remains blocked even when the mutable head advances`, t => {
  const f = fixture(t), chain = semanticChain(f), request = f.request(), receipt = f.store.acknowledgeSummaryRecovery(request);
  const audit = JSON.parse(String(f.db.prepare('SELECT data FROM summary_recovery_acknowledgments').get()!.data));
  assert.ok(audit.pins.some((pin: { id: string }) => pin.id === 'semantic-S1'));
  assert.ok(audit.pins.some((pin: { id: string }) => pin.id === 'baseline-native-message'));
  f.store.putSessionDocument('session','context.head',2,{ revisionId: 'context', observation: 'Later explicit context' });
  assert.equal(f.store.hasUncertainSummaries('workspace'),false);
  if (target === 'message') f.db.exec("UPDATE messages SET data=json_set(data,'$.content','Changed M1') WHERE id='baseline-native-message'");
  if (target === 'earlier-summary') f.db.exec("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json('[]')) WHERE id='semantic-S1'");
  if (target === 'source-owner') f.db.prepare("UPDATE runs SET session_id='other' WHERE id=?").run(chain.sideRunId);
  assert.equal(f.store.hasUncertainSummaries('workspace'),true);
  assert.deepEqual(f.store.findSummaryRecoveryReceipt(request),{ ...receipt, duplicate: true });
});

test('known provenance labels remain hash-bound while image-message labels pin their native source', t => {
  const f = fixture(t), labelHash = hash('retained provenance');
  semanticChain(f,[`instruction:AGENTS.md:${labelHash}`,`instruction:src/AGENTS.md:${labelHash}`,
    ...['policy','facts','manifest','checkpoint'].map(kind => `active-prefix-${kind}:${labelHash}`),
    `image-policy:${labelHash}`,`image-source:${labelHash}`,`image-message:baseline-native-message:${labelHash}`,
    `document-policy:${labelHash}`,`document-source:${labelHash}`,`document-message:baseline-native-message:${labelHash}`]);
  const request = f.request(); f.store.acknowledgeSummaryRecovery(request);
  const audit = JSON.parse(String(f.db.prepare('SELECT data FROM summary_recovery_acknowledgments').get()!.data));
  assert.equal(audit.pins.filter((pin: { id: string }) => pin.id === 'baseline-native-message').length,1);
  assert.equal(f.store.hasUncertainSummaries('workspace'),false);
  f.db.exec("UPDATE messages SET data=json_set(data,'$.content','Changed image source metadata') WHERE id='baseline-native-message'");
  assert.equal(f.store.hasUncertainSummaries('workspace'),true);
});

for (const invalid of ['unknown-label','malformed-instruction','self','forward','ambiguous','foreign'] as const) test(`immutable semantic closure rejects ${invalid} sources before acknowledgment`, t => {
  const f = fixture(t); semanticChain(f);
  if (invalid === 'unknown-label') f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json(?)) WHERE id='semantic-S2'").run(JSON.stringify([`unrecognized-provenance:${hash('label')}`]));
  if (invalid === 'malformed-instruction') f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json(?)) WHERE id='semantic-S2'").run(JSON.stringify([`instruction:../AGENTS.md:${hash('label')}`]));
  if (invalid === 'self') f.db.exec("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json('[\"semantic-S2\"]')) WHERE id='semantic-S2'");
  if (invalid === 'forward') f.db.exec("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json('[\"semantic-S2\"]')) WHERE id='semantic-S1'");
  if (invalid === 'ambiguous') f.db.exec("INSERT INTO messages(id,session_id,run_id,data) SELECT 'semantic-S1',session_id,run_id,json_set(data,'$.id','semantic-S1') FROM messages WHERE id='baseline-native-message'");
  if (invalid === 'foreign') f.db.exec("UPDATE context_revisions SET session_id='other',data=json_set(data,'$.sessionId','other') WHERE id='semantic-S1'");
  const preview = f.store.getSummaryRecoveryPreview('session','summary'); assert.equal(preview.status,'blocked');
  assert.ok(preview.blockers.includes(invalid === 'foreign' ? 'SUMMARY_RECOVERY_OWNER_MISMATCH' : 'SUMMARY_RECOVERY_SOURCE_CHANGED'),JSON.stringify(preview.blockers));
});

test('semantic closure reference and row-byte limits fail closed before an oversized nested body is returned', t => {
  const references = fixture(t); semanticChain(references);
  const labels = Array.from({ length: 1024 },(_,index) => `image-policy:${index.toString(16).padStart(64,'0')}`);
  references.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json(?)) WHERE id='semantic-S1'").run(JSON.stringify(labels));
  assert.ok(references.store.getSummaryRecoveryPreview('session','summary').blockers.includes('SUMMARY_RECOVERY_LIMIT'));
  const f = fixture(t); semanticChain(f);
  const text = 'x'.repeat(1_048_576);
  f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.text',?,'$.sha256',?) WHERE id='semantic-S1'").run(text,hash(text));
  const owner = f.store as unknown as { db: DatabaseSync }, db = owner.db, prepare = db.prepare.bind(db); let nestedBodyReads = 0;
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/^SELECT data FROM context_revisions WHERE id=\?/u.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = ((...parameters: SQLInputValue[]) => { if (parameters[0] === 'semantic-S1') nestedBodyReads++; return get(...parameters); }) as typeof statement.get;
    }
    return statement;
  }) as typeof db.prepare;
  try { assert.ok(f.store.getSummaryRecoveryPreview('session','summary').blockers.includes('SUMMARY_RECOVERY_LIMIT')); assert.equal(nestedBodyReads,0); }
  finally { db.prepare = prepare; }
});
