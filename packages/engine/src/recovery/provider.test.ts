import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type EngineEvent, type JsonObject, type ProviderAttempt, type Run, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import type { NativeSessionStorage } from '../storage/native.js';
import { captureProviderRecoveryHighWater, PROVIDER_RECOVERY_SCHEMA, ProviderRecoveryStorage, validateProviderRecoveryRequest, type ProviderRecoveryRequest } from './provider.js';
import { canonical } from './snapshot.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const config = { providerId: 'scripted', modelId: 'local-model', mode: 'plan' as const, limits: { ...DEFAULT_LIMITS } };
type Owner = { db: DatabaseSync; native: NativeSessionStorage; append(run: Run, type: string, payload: JsonObject): EngineEvent };

function candidate(store: SqliteStore, suffix: string, cleanup: 'confirmed' | 'uncertain' = 'confirmed') {
  const owner = store as unknown as Owner, timestamp = new Date().toISOString(), sessionId = `session-${suffix}`;
  store.createSession({ id: sessionId, workspaceId: 'workspace', title: 'Explicit provider recovery', createdAt: timestamp });
  const input = store.acceptInput({ sessionId, requestId: `goal-${suffix}`, prompt: 'Original exact goal', config, delivery: 'queue' });
  const run = store.promoteInput(input.inputId).run;
  store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const contextId = `context-${suffix}`, contextText = JSON.stringify([{ role: 'user', content: 'Original exact goal' }]);
  const messageId = String(owner.db.prepare("SELECT id FROM messages WHERE run_id=? AND json_extract(data,'$.role')='user' LIMIT 1").get(run.id)!.id);
  store.putContextRevision({ schemaVersion: 2, id: contextId, sessionId, runId: run.id, revision: 1, kind: 'baseline', text: contextText,
    sha256: hash(contextText), sourceIds: [messageId], createdAt: timestamp });
  store.putSessionDocument(sessionId, 'context.head', 0, { revisionId: contextId, observation: 'original baseline' });
  const turn: TurnRecord = { schemaVersion: 2, id: `turn-${suffix}`, sessionId, runId: run.id, inputIds: [input.inputId], index: 0, state: 'created', contextRevisionId: contextId, createdAt: timestamp };
  const attempt: ProviderAttempt = { schemaVersion: 2, id: `attempt-${suffix}`, sessionId, runId: run.id, turnId: turn.id, index: 0,
    providerId: config.providerId, modelId: config.modelId, state: 'prepared', contextRevisionId: contextId, createdAt: timestamp };
  store.putTurn(turn); store.putAttempt(attempt);
  const requestText = JSON.stringify({ runId: run.id, turnIndex: 0, turnId: turn.id, attemptId: attempt.id, modelId: config.modelId, messages: [{ role: 'user', content: 'Original exact goal' }], tools: [], includeMetadata: true });
  store.createAttemptCleanup({ attemptId: attempt.id, sessionId, workspaceId: 'workspace', runId: run.id, turnId: turn.id,
    providerId: attempt.providerId, modelId: attempt.modelId, contextRevisionId: contextId,
    requestProjection: 'engine-turn-request-v1', requestSha256: hash(requestText), requestBytes: Buffer.byteLength(requestText), createdAt: timestamp });
  store.dispatchAttemptCleanup(attempt.id);
  const dispatched = store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: new Date().toISOString() });
  store.putAttemptUsage(attempt.id, { inputTokens: 20, outputTokens: 3 });
  store.settleAttemptCleanup(attempt.id, cleanup === 'confirmed'
    ? { outcome: 'confirmed', method: 'iterator-return-done', reason: 'error', errorCode: 'PROVIDER_TIMEOUT' }
    : { outcome: 'uncertain', method: 'return-timeout', reason: 'error', errorCode: 'CLEANUP_UNCERTAIN' });
  const uncertainty = { kind: 'provider_dispatch' as const, message: 'Provider result remains unknown', requiresRecovery: true as const };
  store.putAttempt({ ...dispatched, state: 'uncertain', completedAt: new Date().toISOString(), uncertainty });
  store.putTurn({ ...turn, state: 'uncertain', completedAt: new Date().toISOString(), uncertainty });
  store.commit(run.id, 'run.failed', { error: { code: 'PROVIDER_TIMEOUT' } }, { run: { state: 'failed', error: { code: 'PROVIDER_TIMEOUT', message: 'The remote outcome is unconfirmed' } } });
  return { sessionId, runId: run.id, turnId: turn.id, attemptId: attempt.id, contextId, messageId };
}
function fixture(t: TestContext, options: { restart?: boolean; cleanup?: 'confirmed' | 'uncertain'; multiple?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-provider-recovery-')), path = join(directory, 'engine.sqlite');
  let store = new SqliteStore(path), binding = hash('original physical storage identity');
  const stamp = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: stamp });
  const first = candidate(store, 'first', options.cleanup), second = options.multiple ? candidate(store, 'second') : undefined;
  if (options.restart !== false) { store.close(); store = new SqliteStore(path); }
  const owner = store as unknown as Owner, db = owner.db;
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='provider_recovery_acknowledgments'").get()) db.exec(PROVIDER_RECOVERY_SCHEMA);
  const recovery = new ProviderRecoveryStorage(owner.native, store, { bindingScope: () => binding,
    startupHighWater: options.restart === false ? '0' : captureProviderRecoveryHighWater(db), appendLegacy: (run, type, payload) => owner.append(run, type, payload) });
  store.getSnapshot = () => { throw new Error('Provider recovery must use bounded exact evidence'); };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function request(target = first, requestId = 'host-decision'): ProviderRecoveryRequest {
    const preview = recovery.preview(target.sessionId, target.attemptId);
    assert.equal(preview.status, 'eligible', JSON.stringify(preview.blockers)); assert.ok(preview.fingerprint);
    return { sessionId: target.sessionId, attemptId: target.attemptId, requestId, fingerprint: preview.fingerprint, acknowledged: true };
  }
  return { store, db, recovery, first, second, request, setBinding(value: string) { binding = value; } };
}

test('request validator snapshots plain exact input and avoids proxy/accessor traps', () => {
  let traps = 0;
  const value = { sessionId: 'session', attemptId: 'attempt', requestId: 'request', fingerprint: 'a'.repeat(64), acknowledged: true };
  assert.throws(() => validateProviderRecoveryRequest(new Proxy(value, { getPrototypeOf() { traps++; throw new Error('trap'); } })), code('PROVIDER_RECOVERY_INVALID_REQUEST'));
  assert.throws(() => validateProviderRecoveryRequest({ ...value, get fingerprint() { traps++; return value.fingerprint; } }), code('PROVIDER_RECOVERY_INVALID_REQUEST'));
  for (const invalid of [{ ...value, extra: true }, { ...value, [Symbol('hidden')]: 1 }, { ...value, requestId: 'x'.repeat(257) }, { ...value, fingerprint: 'bad' }]) assert.throws(() => validateProviderRecoveryRequest(invalid), code('PROVIDER_RECOVERY_INVALID_REQUEST'));
  assert.throws(() => validateProviderRecoveryRequest({ ...value, acknowledged: false }), code('PROVIDER_RECOVERY_ACKNOWLEDGMENT_REQUIRED'));
  assert.equal(traps, 0);
  const valid = validateProviderRecoveryRequest(value); value.sessionId = 'changed'; assert.equal(valid.sessionId, 'session');
});

test('previous boot exact proof ACK publishes both audits and preserves all execution/input/context/usage records', t => {
  const f = fixture(t), request = f.request();
  const before = () => ({ attempt: f.store.getAttempt(f.first.attemptId), cleanup: f.store.getAttemptCleanup(f.first.attemptId), turn: f.store.getTurn(f.first.turnId), run: f.store.getRun(f.first.runId),
    head: f.store.getSessionDocument(f.first.sessionId, 'context.head'), control: f.store.getSessionControl(f.first.sessionId), inputs: f.store.listInputs(f.first.sessionId),
    usage: f.db.prepare('SELECT data FROM attempt_usage WHERE attempt_id=?').get(f.first.attemptId), messages: f.db.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal').all(f.first.runId) });
  const original = before(); assert.equal(f.recovery.hasUnacknowledged('workspace'), true);
  const receipt = f.recovery.acknowledge(request);
  assert.equal(receipt.cleanupConfirmed, true); assert.equal(receipt.providerOutcomeConfirmed, false); assert.equal(receipt.executionResumed, false); assert.equal(receipt.providerRetried, false); assert.equal(receipt.checkpointActivated, false);
  assert.equal(f.recovery.hasUnacknowledged('workspace'), false); assert.equal(f.recovery.hasValidAcknowledgment(f.first.sessionId, f.first.attemptId), true);
  assert.deepEqual(before(), original); assert.equal(f.recovery.preview(f.first.sessionId, f.first.attemptId).status, 'acknowledged');
  assert.equal(f.store.readEvents(f.first.sessionId, 0).filter(event => event.type === 'provider.recovery.acknowledged').length, 1);
  const events = f.store.readSessionEvents(f.first.sessionId, 0).filter(event => event.type === 'provider.recovery.acknowledged'); assert.equal(events.length, 1); assert.equal(events[0]!.attemptId, f.first.attemptId);
  assert.deepEqual(f.recovery.acknowledge(request), { ...receipt, duplicate: true }); assert.deepEqual(f.recovery.findReceipt(request), { ...receipt, duplicate: true });
  assert.throws(() => f.recovery.acknowledge({ ...request, fingerprint: hash('conflict') }), code('PROVIDER_RECOVERY_REQUEST_CONFLICT'));
  assert.throws(() => f.recovery.acknowledge({ ...request, requestId: 'second-decision' }), code('PROVIDER_RECOVERY_REQUEST_CONFLICT'));
});

test('same boot and unknown cleanup remain blocked with unavailable evidence explicitly null', t => {
  const current = fixture(t, { restart: false }), preview = current.recovery.preview(current.first.sessionId, current.first.attemptId);
  assert.equal(preview.status, 'blocked'); assert.ok(preview.blockers.includes('PROVIDER_RECOVERY_RESTART_REQUIRED')); assert.equal(preview.requestSha256, null); assert.equal(preview.requestBytes, null);
  const unknown = fixture(t, { cleanup: 'uncertain' }), blocked = unknown.recovery.preview(unknown.first.sessionId, unknown.first.attemptId);
  assert.equal(blocked.status, 'blocked'); assert.equal(unknown.recovery.hasUnacknowledged('workspace'), true);
});

test('boot frontier is a constructor snapshot and cannot be advanced to admit a same-boot candidate', t => {
  const f = fixture(t), owner = f.store as unknown as Owner;
  const options = { startupHighWater: '0', bindingScope: () => hash('unchanged physical binding'), appendLegacy: (run: Run, type: string, payload: JsonObject) => owner.append(run, type, payload) };
  const recovery = new ProviderRecoveryStorage(owner.native, f.store, options);
  options.startupHighWater = captureProviderRecoveryHighWater(f.db);
  assert.ok(recovery.preview(f.first.sessionId, f.first.attemptId).blockers.includes('PROVIDER_RECOVERY_RESTART_REQUIRED'));
  const fresh = candidate(f.store, 'new-after-boot');
  assert.ok(f.recovery.preview(fresh.sessionId, fresh.attemptId).blockers.includes('PROVIDER_RECOVERY_RESTART_REQUIRED'));
});

test('missing original cleanup and tool-effect Turn remain blocked without synthetic proof', t => {
  const missing = fixture(t); missing.db.prepare('DELETE FROM attempt_cleanup WHERE attempt_id=?').run(missing.first.attemptId);
  assert.equal(missing.recovery.preview(missing.first.sessionId, missing.first.attemptId).status, 'blocked');
  const effect = fixture(t); effect.db.prepare("UPDATE session_turns SET data=json_set(data,'$.uncertainty.kind','tool_effect') WHERE id=?").run(effect.first.turnId);
  assert.equal(effect.recovery.preview(effect.first.sessionId, effect.first.attemptId).status, 'blocked');
  assert.equal(effect.recovery.hasUnacknowledged('workspace'), true);
});

test('foreign owner is rejected before source and ledger bodies are read', t => {
  const f = fixture(t), request = f.request(); f.recovery.acknowledge(request);
  let bodyReads = 0; const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => { if (/SELECT data FROM/u.test(sql)) bodyReads++; return prepare(sql); }) as typeof f.db.prepare;
  try { assert.throws(() => f.recovery.preview('foreign', f.first.attemptId), code('PROVIDER_RECOVERY_OWNER_MISMATCH')); assert.throws(() => f.recovery.findReceipt({ ...request, sessionId: 'foreign' }), code('PROVIDER_RECOVERY_OWNER_MISMATCH')); assert.equal(bodyReads, 0); }
  finally { f.db.prepare = prepare; }
});

test('context baseline is a decision CAS but mutable later heads do not invalidate original immutable ACK pins', t => {
  const f = fixture(t), stale = f.request();
  f.store.putSessionDocument(f.first.sessionId, 'context.head', 1, { revisionId: f.first.contextId, observation: 'concurrent host change' });
  assert.throws(() => f.recovery.acknowledge(stale), code('PROVIDER_RECOVERY_STALE'));
  const request = f.request(), receipt = f.recovery.acknowledge(request);
  f.store.putSessionDocument(f.first.sessionId, 'context.head', 2, { revisionId: f.first.contextId, observation: 'later explicit context' });
  assert.equal(f.recovery.hasValidAcknowledgment(f.first.sessionId, f.first.attemptId), true); assert.deepEqual(f.recovery.acknowledge(request), { ...receipt, duplicate: true });
});

test('immutable baseline pin coverage is bound into the decision fingerprint and cannot be dropped from audit data', t => {
  const f = fixture(t), request = f.request(); f.recovery.acknowledge(request);
  const row = f.db.prepare('SELECT data FROM provider_recovery_acknowledgments').get()!, audit = JSON.parse(String(row.data));
  assert.ok(audit.pins.length > 0);
  f.db.exec("UPDATE provider_recovery_acknowledgments SET data=json_set(data,'$.pins',json('[]'))");
  assert.equal(f.recovery.hasValidAcknowledgment(f.first.sessionId, f.first.attemptId), false);
  const emptyPinsSha = hash(canonical([]));
  audit.pins = []; audit.pinsSha256 = emptyPinsSha;
  f.db.prepare('UPDATE provider_recovery_acknowledgments SET pins_sha256=?,data=?').run(emptyPinsSha, JSON.stringify(audit));
  assert.equal(f.recovery.hasValidAcknowledgment(f.first.sessionId, f.first.attemptId), false, 'Updating redundant pin hash still cannot match the original fingerprint');
  assert.equal(f.recovery.hasUnacknowledged('workspace'), true);
});

test('each ordinary uncertain candidate requires its own receipt without clearing the other candidate', t => {
  const f = fixture(t, { multiple: true }), first = f.request(), second = f.request(f.second!, 'other-host-decision');
  f.recovery.acknowledge(first); assert.equal(f.recovery.hasUnacknowledged('workspace'), true); assert.equal(f.recovery.hasValidAcknowledgment(f.first.sessionId, f.first.attemptId), true);
  assert.throws(() => f.recovery.acknowledge({ ...second, requestId: first.requestId }), code('PROVIDER_RECOVERY_REQUEST_CONFLICT'));
  f.recovery.acknowledge(second); assert.equal(f.recovery.hasUnacknowledged('workspace'), false);
});

test('active Run blocks a fresh decision but exact original retry remains read-only', t => {
  const f = fixture(t), request = f.request(), receipt = f.recovery.acknowledge(request);
  f.store.setSessionPaused(f.first.sessionId, false);
  const input = f.store.acceptInput({ sessionId: f.first.sessionId, requestId: 'new-explicit-goal', prompt: 'Independent new goal', delivery: 'queue', config }); f.store.promoteInput(input.inputId);
  assert.equal(f.recovery.preview(f.first.sessionId, f.first.attemptId).status, 'blocked');
  assert.equal(f.recovery.hasValidAcknowledgment(f.first.sessionId, f.first.attemptId), true);
  assert.deepEqual(f.recovery.acknowledge(request), { ...receipt, duplicate: true });
  assert.equal(f.store.getInput(input.inputId).state, 'promoted');
});

for (const target of ['source','replay','cleanup','usage','context-pin','ledger-hash','physical-scope'] as const) test(`immutable ${target} drift deactivates ACK without replacing its historical receipt`, t => {
  const f = fixture(t), request = f.request(), receipt = f.recovery.acknowledge(request);
  if (target === 'source') f.db.prepare("UPDATE messages SET data=json_set(data,'$.content','Changed original constraint') WHERE id=?").run(f.first.messageId);
  if (target === 'replay') f.db.prepare("UPDATE messages SET data=json_set(data,'$.providerReplay',json(?)) WHERE id=?").run('{"providerId":"scripted","items":[{"type":"opaque-change"}]}', f.first.messageId);
  if (target === 'cleanup') f.db.prepare("UPDATE attempt_cleanup SET data=json_set(data,'$.errorCode','OTHER_ERROR') WHERE attempt_id=?").run(f.first.attemptId);
  if (target === 'usage') f.db.prepare("UPDATE attempt_usage SET data=json_set(data,'$.usage.outputTokens',4) WHERE attempt_id=?").run(f.first.attemptId);
  if (target === 'context-pin') f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json('[]')) WHERE id=?").run(f.first.contextId);
  if (target === 'ledger-hash') f.db.prepare('UPDATE provider_recovery_acknowledgments SET source_sha256=?').run(hash('tampered-ledger'));
  if (target === 'physical-scope') f.setBinding(hash('different imported physical storage'));
  assert.equal(f.recovery.hasValidAcknowledgment(f.first.sessionId, f.first.attemptId), false); assert.equal(f.recovery.hasUnacknowledged('workspace'), true);
  if (target === 'physical-scope') assert.equal(f.recovery.findReceipt(request), null);
  else if (target === 'ledger-hash') assert.throws(() => f.recovery.findReceipt(request), code('PROVIDER_RECOVERY_SOURCE_CHANGED'));
  else assert.deepEqual(f.recovery.acknowledge(request), { ...receipt, duplicate: true });
});

for (const table of ['events','session_events']) test(`ACK ledger and both event streams roll back on ${table} journal failure`, t => {
  const f = fixture(t), request = f.request(), before = f.store.getAttempt(f.first.attemptId);
  f.db.exec(`CREATE TRIGGER reject_provider_ack BEFORE INSERT ON ${table} WHEN NEW.type='provider.recovery.acknowledged' BEGIN SELECT RAISE(ABORT,'synthetic provider audit failure'); END`);
  assert.throws(() => f.recovery.acknowledge(request));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM provider_recovery_acknowledgments').get()!.n, 0);
  for (const journal of ['events','session_events']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${journal} WHERE type='provider.recovery.acknowledged'`).get()!.n, 0);
  assert.deepEqual(f.store.getAttempt(f.first.attemptId), before); assert.equal(f.recovery.hasUnacknowledged('workspace'), true);
});

test('malformed/oversized/extra-field ledger is bounded and cannot clear original uncertainty', t => {
  for (const value of ['null', '{', '[]', JSON.stringify({ receipt: null, extra: true })]) {
    const f = fixture(t), request = f.request(); f.recovery.acknowledge(request); f.db.prepare('UPDATE provider_recovery_acknowledgments SET data=?').run(value);
    assert.equal(f.recovery.hasUnacknowledged('workspace'), true); assert.equal(f.recovery.hasValidAcknowledgment(f.first.sessionId, f.first.attemptId), false);
  }
  const f = fixture(t), request = f.request(); f.recovery.acknowledge(request);
  f.db.exec('PRAGMA ignore_check_constraints=ON'); f.db.prepare('UPDATE provider_recovery_acknowledgments SET data=?').run('x'.repeat(65537)); f.db.exec('PRAGMA ignore_check_constraints=OFF');
  let ledgerReads = 0; const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => { if (/SELECT data FROM provider_recovery_acknowledgments/u.test(sql)) ledgerReads++; return prepare(sql); }) as typeof f.db.prepare;
  try { assert.throws(() => f.recovery.findReceipt(request), code('PROVIDER_RECOVERY_LIMIT')); assert.equal(ledgerReads, 0); }
  finally { f.db.prepare = prepare; }
});
