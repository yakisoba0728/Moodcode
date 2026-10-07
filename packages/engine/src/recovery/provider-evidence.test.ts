import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type MessagePart, type ProviderAttempt, type TurnRecord } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { PROVIDER_RECOVERY_LIMITS, type ProviderRecoveryBudget } from './provider-contract.js';
import { providerRecoveryPinsValid, readProviderRecoveryBaseline, readProviderRecoveryEvidence } from './provider-evidence.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const budget = (): ProviderRecoveryBudget => ({ bytes: 0, max: PROVIDER_RECOVERY_LIMITS.maxEvidenceBytes });
function fixture(t: TestContext, priorTool = false) {
  const directory = mkdtempSync(join(tmpdir(), 'moodcode-provider-evidence-')), store = new SqliteStore(join(directory, 'engine.sqlite'));
  const db = (store as unknown as { db: DatabaseSync }).db, timestamp = new Date().toISOString();
  store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt: timestamp });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Independent provider evidence', createdAt: timestamp });
  const config = { providerId: 'local', modelId: 'fixture', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
  const receipt = store.acceptInput({ sessionId: 'session', requestId: 'goal', prompt: 'Original nonce goal', config, delivery: 'queue' });
  const run = store.promoteInput(receipt.inputId).run; store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  const goalId = String(db.prepare('SELECT id FROM messages WHERE run_id=? ORDER BY ordinal LIMIT 1').get(run.id)!.id);
  const turn = (index: number): TurnRecord => ({ schemaVersion: 2, id: `turn-${index}`, sessionId: 'session', runId: run.id, index, inputIds: [receipt.inputId], state: 'created', createdAt: timestamp });
  const attempt = (owner: TurnRecord): ProviderAttempt => ({ schemaVersion: 2, id: `attempt-${owner.index}`, sessionId: 'session', runId: run.id, turnId: owner.id, index: 0, providerId: config.providerId, modelId: config.modelId, state: 'prepared', createdAt: timestamp });
  if (priorTool) {
    const owner = turn(0); store.putTurn(owner); store.putTurn({ ...owner, state: 'streaming' });
    const first = attempt(owner); store.putAttempt(first); const dispatched = store.putAttempt({ ...first, state: 'dispatched', dispatchedAt: timestamp });
    const call = { id: 'shared-provider-id', name: 'read_file', input: { path: 'observed.txt' } };
    store.commit(run.id, 'message.completed', {}, { message: { id: 'prior-assistant', sessionId: 'session', runId: run.id, role: 'assistant', content: 'Inspect the file', toolCalls: [call], createdAt: timestamp } });
    const part: MessagePart = { schemaVersion: 2, id: 'prior-tool-part', sessionId: 'session', runId: run.id, turnId: owner.id, messageId: 'prior-assistant', type: 'tool', index: 0, revision: 0, state: 'open', toolCallId: 'prior-tool', providerCallId: call.id, name: call.name, input: call.input, createdAt: timestamp };
    store.putPart(part); store.putAttempt({ ...dispatched, state: 'completed', completedAt: timestamp }); store.putTurn({ ...owner, state: 'awaiting_tools' });
    const tool = { id: 'prior-tool', sessionId: 'session', runId: run.id, name: call.name, input: call.input, state: 'requested' as const };
    store.commit(run.id, 'tool.requested', { toolCallId: tool.id, providerToolCallId: call.id, name: call.name, input: call.input }, { tool });
    store.commit(run.id, 'tool.running', { toolCallId: tool.id, name: call.name, state: 'running' }, { tool: { ...tool, state: 'running' } });
    const output = 'Verified prior tool nonce';
    store.commit(run.id, 'tool.completed', { toolCallId: tool.id, providerToolCallId: call.id, name: call.name, output, isError: false, truncated: false }, {
      tool: { ...tool, state: 'completed', output }, message: { id: 'prior-result', sessionId: 'session', runId: run.id, role: 'tool', toolCallId: call.id, content: output, createdAt: timestamp } });
    store.putPart({ ...part, revision: 1, state: 'completed', completedAt: timestamp, result: { output, isError: false, truncated: false } });
    store.putTurn({ ...owner, state: 'completed', completedAt: timestamp, finishReason: 'tool_calls' });
  }
  const steer = store.acceptInput({ sessionId: 'session', requestId: 'steer', prompt: 'Latest nonce steer', config, delivery: 'steer' }); store.promoteSteers([steer.inputId], run.id);
  const current = { ...turn(priorTool ? 1 : 0), inputIds: [receipt.inputId, steer.inputId] }, requestText = JSON.stringify([{ role: 'user', content: run.prompt }]);
  store.putContextRevision({ schemaVersion: 2, id: 'original-context', sessionId: 'session', runId: run.id, revision: 1, kind: 'baseline', sourceIds: [goalId], text: requestText, sha256: digest(requestText), createdAt: timestamp });
  store.putSessionDocument('session', 'context.head', 0, { revisionId: 'original-context' });
  store.putTurn(current); store.putTurn({ ...current, state: 'streaming' });
  const prepared = { ...attempt(current), contextRevisionId: 'original-context' }; store.putAttempt(prepared);
  store.createAttemptCleanup({ attemptId: prepared.id, sessionId: 'session', workspaceId: 'workspace', runId: run.id, turnId: current.id, providerId: prepared.providerId, modelId: prepared.modelId,
    contextRevisionId: prepared.contextRevisionId, requestProjection: 'engine-turn-request-v1', requestSha256: digest('Exactly hashed original logical request'), requestBytes: 44 });
  store.dispatchAttemptCleanup(prepared.id); const dispatched = store.putAttempt({ ...prepared, state: 'dispatched', dispatchedAt: new Date().toISOString() });
  store.commit(run.id, 'message.delta', {}, { message: { id: 'partial-assistant', sessionId: 'session', runId: run.id, role: 'assistant', content: 'Visible partial nonce', createdAt: timestamp,
    providerReplay: { providerId: config.providerId, items: [{ preserved: 'Opaque native replay nonce' }] } } });
  const base = { schemaVersion: 2 as const, sessionId: 'session', runId: run.id, turnId: current.id, messageId: 'partial-assistant', revision: 0, state: 'open' as const, createdAt: timestamp };
  const parts: MessagePart[] = [
    { ...base, id: 'partial-text', index: 0, type: 'text', text: 'Visible partial nonce' },
    { ...base, id: 'partial-reasoning', index: 1, type: 'reasoning', text: 'Public reasoning observation', providerData: { preserved: 'opaque' } },
    { ...base, id: 'unexecuted-proposal', index: 2, type: 'tool', toolCallId: 'unexecuted-tool', providerCallId: 'shared-provider-id', name: 'read_file', input: { path: 'never-executed.txt' } },
    { ...base, id: 'partial-media', index: 3, type: 'media', mime: 'image/png', artifact: { id: 'media-reference', identity: { sessionId: 'session', runId: run.id, toolCallId: 'media-output', turnId: current.id, attemptId: prepared.id },
      sha256: digest('Stored media'), storedBytes: 7, observedBytes: 7, producerTruncatedBytes: 0, artifactTruncatedBytes: 0, complete: true, outcome: 'completed', createdAt: timestamp, expiresAt: new Date(Date.now() + 86400000).toISOString() } },
  ];
  for (const part of parts) { store.putPart(part); store.putPart({ ...part, revision: 1, state: 'interrupted', completedAt: new Date().toISOString() }); }
  store.putAttemptUsage(prepared.id, { inputTokens: 50, cachedInputTokens: 10, outputTokens: 4, reasoningOutputTokens: 2 });
  store.settleAttemptCleanup(prepared.id, { outcome: 'confirmed', method: 'iterator-return-done', reason: 'error', errorCode: 'PROVIDER_TRANSPORT_ERROR' });
  const uncertainty = { kind: 'provider_dispatch' as const, requiresRecovery: true as const, message: 'Remote outcome is unknown' };
  store.putAttempt({ ...dispatched, state: 'uncertain', completedAt: new Date().toISOString(), uncertainty });
  store.putTurn({ ...current, state: 'uncertain', completedAt: new Date().toISOString(), uncertainty }); store.commit(run.id, 'run.failed', {}, { run: { state: 'failed' } });
  store.getSnapshot = () => { throw new Error('Independent evidence tests forbid whole-session snapshots'); };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const read = (selectedBudget = budget()) => readProviderRecoveryEvidence(db, store, 'session', prepared.id, selectedBudget);
  return { store, db, run, prepared, current, goalId, steer, read };
}

test('exact partial text/reasoning/media/proposal and prior completed tool exchange remain immutable selected evidence', t => {
  const f = fixture(t, true), selected = budget(), before = f.db.prepare('SELECT total_changes() AS count').get()!.count;
  const evidence = f.read(selected); assert.equal(evidence.attempt.state, 'uncertain'); assert.equal(evidence.cleanup.cleanupConfirmed, true); assert.ok(evidence.usageSha256);
  assert.ok(selected.bytes > 0 && selected.bytes < PROVIDER_RECOVERY_LIMITS.maxEvidenceBytes); assert.equal(f.db.prepare('SELECT total_changes() AS count').get()!.count, before);
  const original = f.store.listParts(f.current.id); assert.equal(original.length, 4); assert.equal(f.db.prepare("SELECT 1 FROM tools WHERE id='unexecuted-tool'").get(), undefined);
  f.db.prepare("UPDATE message_parts SET data=json_set(data,'$.providerData.preserved','Changed opaque evidence') WHERE id='partial-reasoning'").run();
  assert.notEqual(f.read().sourceSha256, evidence.sourceSha256); assert.equal(f.store.getAttempt(f.prepared.id).state, 'uncertain');
});

for (const target of ['goal', 'steer'] as const) test(`a ${target} Message detached from the promoted input fails source integrity`, t => {
  const f = fixture(t); f.db.prepare("UPDATE messages SET data=json_set(data,'$.content','Different authoritative instruction') WHERE id=?").run(target === 'goal' ? f.goalId : f.steer.inputId);
  assert.throws(f.read, code('PROVIDER_RECOVERY_SOURCE_CHANGED'));
});

for (const corruption of ['running-interrupted', 'missing-terminal', 'uncertain-result', 'wrong-result'] as const) test(`prior tool ${corruption} prevents provider-only recovery`, t => {
  const f = fixture(t, true);
  if (corruption === 'running-interrupted') f.db.prepare("UPDATE tools SET state='interrupted',data=json_set(data,'$.state','interrupted') WHERE id='prior-tool'").run();
  if (corruption === 'missing-terminal') f.db.prepare("DELETE FROM events WHERE run_id=? AND type='tool.completed'").run(f.run.id);
  if (corruption === 'uncertain-result') f.db.prepare("UPDATE events SET data=json_set(data,'$.payload.cleanupConfirmed',json('false')) WHERE run_id=? AND type='tool.completed'").run(f.run.id);
  if (corruption === 'wrong-result') f.db.prepare("UPDATE messages SET data=json_set(data,'$.content','Changed result') WHERE id='prior-result'").run();
  assert.throws(f.read, code('PROVIDER_RECOVERY_TOOLS_UNCERTAIN'));
});

test('foreign and oversized selected payloads are rejected before their bodies are returned to JavaScript', t => {
  const f = fixture(t), original = f.db.prepare.bind(f.db); let selectedBodies = 0;
  f.db.prepare = ((sql: string) => { if (/SELECT data FROM messages/u.test(sql)) selectedBodies++; return original(sql); }) as typeof f.db.prepare;
  f.store.createSession({ id: 'foreign-session', workspaceId: 'workspace', title: 'Other owner', createdAt: new Date().toISOString() });
  f.db.prepare("UPDATE messages SET session_id='foreign-session' WHERE id='partial-assistant'").run();
  assert.throws(f.read, code('PROVIDER_RECOVERY_OWNER_MISMATCH')); assert.equal(selectedBodies, 0);
  f.db.prepare("UPDATE messages SET session_id='session',data=json_set(data,'$.content',?) WHERE id='partial-assistant'").run('x'.repeat(PROVIDER_RECOVERY_LIMITS.maxOwnerBytes + 1));
  assert.throws(f.read, code('PROVIDER_RECOVERY_LIMIT')); assert.equal(selectedBodies, 0); f.db.prepare = original;
});

test('selected byte cap and malformed metadata fail closed without mutating original records', t => {
  const f = fixture(t); assert.throws(() => f.read({ bytes: 0, max: 1 }), code('PROVIDER_RECOVERY_LIMIT'));
  f.db.prepare("UPDATE message_parts SET revision=?,data=json_set(data,'$.revision',?) WHERE id='partial-text'").run(9007199254740992n, 9007199254740992n);
  assert.throws(f.read, code('PROVIDER_RECOVERY_SOURCE_CHANGED')); assert.equal(f.store.getAttempt(f.prepared.id).state, 'uncertain');
});

test('context decision baseline changes with a new head while immutable pins remain independently valid', t => {
  const f = fixture(t), first = readProviderRecoveryBaseline(f.db, 'session', budget()); assert.equal(first.pins.length, 2);
  assert.equal(providerRecoveryPinsValid(f.db, first.pins, budget()), true);
  f.store.putSessionDocument('session', 'context.head', 1, { revisionId: 'original-context', hostObservation: 'New decision baseline' });
  assert.notEqual(readProviderRecoveryBaseline(f.db, 'session', budget()).hash, first.hash); assert.equal(providerRecoveryPinsValid(f.db, first.pins, budget()), true);
  f.db.prepare("UPDATE messages SET data=json_set(data,'$.content','Changed pinned source') WHERE id=?").run(f.goalId);
  assert.equal(providerRecoveryPinsValid(f.db, first.pins, budget()), false); assert.equal(providerRecoveryPinsValid(f.db, first.pins, { bytes: 0, max: 1 }), false);
});

test('actual interrupted Turn crash boundary is accepted only with its original uncertain Attempt', t => {
  const f = fixture(t); f.db.prepare("UPDATE session_turns SET state='interrupted',data=json_remove(json_set(data,'$.state','interrupted'),'$.uncertainty') WHERE id=?").run(f.current.id);
  assert.equal(f.read().turn.state, 'interrupted');
  f.db.prepare("UPDATE provider_attempts SET state='interrupted',data=json_remove(json_set(data,'$.state','interrupted'),'$.uncertainty') WHERE id=?").run(f.prepared.id);
  assert.throws(f.read, code('PROVIDER_RECOVERY_NOT_NEEDED'));
});

test('domain tool envelope metadata remains evidence without becoming engine cleanup proof', t => {
  const f = fixture(t, true), before = f.read().sourceSha256;
  const envelope = { displayContent: 'Verified prior tool nonce', modelContent: 'Verified prior tool nonce', warnings: [], artifactRefs: [], outcome: 'completed',
    metadata: { timedOut: true, cleanupConfirmed: false, data: { cleanupUncertain: true }, result: { effectsUncertain: true }, tool: { executionBlocked: true } },
    structuredData: { cleanupConfirmed: false, timedOut: true } };
  f.db.prepare("UPDATE events SET data=json_set(data,'$.payload.structuredResult',json(?)) WHERE run_id=? AND type='tool.completed'").run(JSON.stringify(envelope), f.run.id);
  assert.notEqual(f.read().sourceSha256, before);
  f.db.prepare("UPDATE events SET data=json_set(data,'$.payload.structuredResult.outcome','interrupted') WHERE run_id=? AND type='tool.completed'").run(f.run.id);
  assert.throws(f.read, code('PROVIDER_RECOVERY_TOOLS_UNCERTAIN'));
});

for (const field of ['cleanupConfirmed','cleanupUncertain','effectsUncertain','executionBlocked','timedOut'] as const) test(`actual top-level ${field} tool proof remains blocking`, t => {
  const f = fixture(t, true);
  f.db.prepare("UPDATE events SET data=json_set(data,?,json(?)) WHERE run_id=? AND type='tool.completed'").run(`$.payload.${field}`, field === 'cleanupConfirmed' ? 'false' : 'true', f.run.id);
  assert.throws(f.read, code('PROVIDER_RECOVERY_TOOLS_UNCERTAIN'));
});

test('missing bare message/revision source and unknown typed labels cannot enter a fresh decision', t => {
  const f = fixture(t);
  for (const reference of ['missing-message', 'missing-summary-revision', 'unrecognized-label:' + 'a'.repeat(64), 'instruction:not-AGENTS.md:' + 'b'.repeat(64)]) {
    f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json(?)) WHERE id='original-context'").run(JSON.stringify([reference]));
    assert.throws(() => readProviderRecoveryBaseline(f.db, 'session', budget()), code('PROVIDER_RECOVERY_SOURCE_CHANGED'));
    assert.throws(f.read, code('PROVIDER_RECOVERY_SOURCE_CHANGED'));
  }
});

test('a baseline revision bound to another Run owner is rejected before its content is selected', t => {
  const f = fixture(t);
  f.store.createSession({ id: 'foreign-context-session', workspaceId: 'workspace', title: 'Other owner', createdAt: new Date().toISOString() });
  const foreign = f.store.acceptInput({ sessionId: 'foreign-context-session', requestId: 'foreign-goal', prompt: 'Foreign goal', config: f.run.config, delivery: 'queue' });
  const foreignRun = f.store.promoteInput(foreign.inputId).run;
  f.db.prepare("UPDATE context_revisions SET run_id=?,data=json_set(data,'$.runId',?) WHERE id='original-context'").run(foreignRun.id, foreignRun.id);
  const prepare = f.db.prepare.bind(f.db); let contextBodies = 0;
  f.db.prepare = ((sql: string) => { if (/SELECT data FROM context_revisions/u.test(sql)) contextBodies++; return prepare(sql); }) as typeof f.db.prepare;
  assert.throws(() => readProviderRecoveryBaseline(f.db, 'session', budget()), code('PROVIDER_RECOVERY_OWNER_MISMATCH')); assert.equal(contextBodies, 0);
  f.db.prepare = prepare;
});

test('bare source foreign SQL ownership is rejected before its body is read', t => {
  const f = fixture(t);
  f.store.createSession({ id: 'foreign', workspaceId: 'workspace', title: 'Foreign source', createdAt: new Date().toISOString() });
  f.db.prepare("UPDATE messages SET session_id='foreign' WHERE id=?").run(f.goalId);
  const prepare = f.db.prepare.bind(f.db); let messageBodies = 0;
  f.db.prepare = ((sql: string) => { if (/SELECT data FROM messages/u.test(sql)) messageBodies++; return prepare(sql); }) as typeof f.db.prepare;
  assert.throws(() => readProviderRecoveryBaseline(f.db, 'session', budget()), code('PROVIDER_RECOVERY_OWNER_MISMATCH')); assert.equal(messageBodies, 0);
  f.db.prepare = prepare;
});

test('immutable prior summaries and their original sources remain pinned after mutable head replacement', t => {
  const f = fixture(t), now = new Date().toISOString(), text = 'Derived historical facts';
  f.store.putContextRevision({ schemaVersion: 2, id: 'prior-summary', sessionId: 'session', revision: 2, kind: 'summary', sourceIds: [f.goalId], text, sha256: digest(text), createdAt: now, supersedesId: 'original-context' });
  const sourceIds = ['prior-summary', `instruction:AGENTS.md:${'a'.repeat(64)}`, `active-prefix-policy:${'b'.repeat(64)}`, `active-prefix-facts:${'c'.repeat(64)}`,
    `active-prefix-manifest:${'d'.repeat(64)}`, `active-prefix-checkpoint:${'e'.repeat(64)}`, `image-policy:${'f'.repeat(64)}`, `image-source:${'a'.repeat(64)}`, `image-message:${f.goalId}:${'b'.repeat(64)}`];
  f.store.putContextRevision({ schemaVersion: 2, id: 'derived-context', sessionId: 'session', revision: 3, kind: 'update', sourceIds, text, sha256: digest(text), createdAt: now, supersedesId: 'prior-summary' });
  f.store.putSessionDocument('session', 'context.head', 1, { revisionId: 'derived-context' });
  const baseline = readProviderRecoveryBaseline(f.db, 'session', budget()); assert.deepEqual(baseline.pins.map(pin => pin.id), ['derived-context','prior-summary',f.goalId]);
  f.store.putSessionDocument('session', 'context.head', 2, { revisionId: 'original-context' }); assert.equal(providerRecoveryPinsValid(f.db, baseline.pins, budget()), true);
  f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.text','Tampered prior memory') WHERE id='prior-summary'").run();
  assert.equal(providerRecoveryPinsValid(f.db, baseline.pins, budget()), false);
});

test('future/cyclic context source references fail closed and immutable closure stays bounded', t => {
  const f = fixture(t);
  f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json(?)) WHERE id='original-context'").run(JSON.stringify(['original-context']));
  assert.throws(() => readProviderRecoveryBaseline(f.db, 'session', budget()), code('PROVIDER_RECOVERY_SOURCE_CHANGED'));
  const refs = Array.from({ length: PROVIDER_RECOVERY_LIMITS.maxMessages * 2 + 1 }, (_, index) => `instruction:scope-${index}/AGENTS.md:${'a'.repeat(64)}`);
  f.db.prepare("UPDATE context_revisions SET data=json_set(data,'$.sourceIds',json(?)) WHERE id='original-context'").run(JSON.stringify(refs));
  assert.throws(() => readProviderRecoveryBaseline(f.db, 'session', budget()), code('PROVIDER_RECOVERY_LIMIT'));
});

test('baseline-only pins revalidate native Run owners after the decision without reading their bodies', t => {
  const f = fixture(t), now = new Date().toISOString();
  const other = f.store.admit({ sessionId: 'session', requestId: 'historical-input', prompt: 'Historical source only', config: f.run.config });
  const historical = f.store.getRun(other.runId);
  const messageId = String(f.db.prepare('SELECT id FROM messages WHERE run_id=? ORDER BY ordinal LIMIT 1').get(historical.id)!.id);
  const text = 'Baseline using independent historical source';
  f.store.putContextRevision({ schemaVersion: 2, id: 'baseline-only', sessionId: 'session', revision: 2, kind: 'update', sourceIds: [messageId], text, sha256: digest(text), createdAt: now, supersedesId: 'original-context' });
  f.store.putSessionDocument('session', 'context.head', 1, { revisionId: 'baseline-only' });
  const baseline = readProviderRecoveryBaseline(f.db, 'session', budget()); assert.equal(providerRecoveryPinsValid(f.db, baseline.pins, budget()), true);
  f.store.createSession({ id: 'changed-run-owner', workspaceId: 'workspace', title: 'Foreign owner', createdAt: now });
  f.db.prepare('UPDATE runs SET session_id=? WHERE id=?').run('changed-run-owner', historical.id);
  const prepare = f.db.prepare.bind(f.db); let sourceBodies = 0;
  f.db.prepare = ((sql: string) => { if (/SELECT data FROM messages/u.test(sql)) sourceBodies++; return prepare(sql); }) as typeof f.db.prepare;
  assert.equal(providerRecoveryPinsValid(f.db, baseline.pins, budget()), false); assert.equal(sourceBodies, 0); f.db.prepare = prepare;
  // The candidate's own source remains intact; its decision baseline alone lost ownership.
  assert.equal(f.read().attempt.state, 'uncertain');
});
