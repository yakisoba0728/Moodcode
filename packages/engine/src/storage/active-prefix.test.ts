import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type ContextRevision, type JsonObject, type Message, type MessagePart, type ProviderAttempt, type ToolCallRecord, type TurnRecord } from '@moodcode/contracts';
import type { ActivePrefixCheckpoint, ActivePrefixSource, ActivePrefixSourceOptions, PreparedActivePrefix, ActivePrefixContextPublication } from '../context/active-prefix.js';
import { SqliteStore } from './index.js';
import { readActivePrefixSourceDatabase } from './active-prefix.js';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = '2026-10-07T00:00:00.000Z';
const config = { providerId: 'scripted', modelId: 'local', mode: 'build' as const, limits: { ...DEFAULT_LIMITS } };
const selection: ActivePrefixSourceOptions = { stage: 'between-turns', policySha256: hash('fixture-policy'), maxSourceMessages: 128, maxSourceBytes: 32768, keepRecentTurns: 2, maxCoveredMessages: 512 };
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function fixture(t: TestContext, count = 6) {
  const root = mkdtempSync(join(tmpdir(), 'moodcode-active-prefix-')), path = join(root, 'engine.sqlite'), store = new SqliteStore(path);
  store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Prefix', createdAt: stamp });
  const accepted = store.acceptInput({ sessionId: 'session', requestId: 'goal', prompt: 'initial goal remains raw', config, delivery: 'queue' });
  const run = store.promoteInput(accepted.inputId).run;
  store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  function exchange(index: number, opts: { text?: string; output?: string; failed?: boolean; replay?: boolean; batch?: number; extraPartBytes?: number; media?: boolean } = {}) {
    const turn: TurnRecord = { schemaVersion: 2, id: `turn-${index}`, sessionId: 'session', runId: run.id, inputIds: store.listRunInputIds(run.id), index, state: 'created', createdAt: stamp };
    store.putTurn(turn);
    const attempt: ProviderAttempt = { schemaVersion: 2, id: `attempt-${index}`, sessionId: 'session', runId: run.id, turnId: turn.id, index: 0, providerId: config.providerId, modelId: config.modelId, state: 'prepared', createdAt: stamp };
    store.putAttempt(attempt); store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: stamp });
    store.putTurn({ ...turn, state: 'streaming' });
    const calls = Array.from({ length: opts.batch ?? 1 }, (_, number) => ({ id: number ? `provider-${number}` : 'reused-provider-call', name: 'read_file', input: { path: `file-${index}-${number}.txt` } }));
    const assistant: Message = { id: `assistant-${index}`, sessionId: 'session', runId: run.id, role: 'assistant', content: opts.text ?? `thought-${index}`, toolCalls: calls, createdAt: stamp,
      ...(opts.replay ? { providerReplay: { providerId: config.providerId, items: [{ type: 'fixture', opaque: 'private-replay-'.repeat(10000) }] } } : {}) };
    store.commit(run.id, 'message.completed', { messageId: assistant.id, turnIndex: index }, { message: assistant });
    const parts: MessagePart[] = calls.map((call, number) => ({ schemaVersion: 2, id: `part-${index}-${number}`, sessionId: 'session', runId: run.id, turnId: turn.id, messageId: assistant.id, index: number, revision: 0,
      type: 'tool', state: 'open', createdAt: stamp, toolCallId: number ? `internal-${index}-${number}` : `internal-${index}`, providerCallId: call.id, name: call.name, input: call.input }));
    for (const part of parts) store.putPart(part);
    if (opts.media) {
      const media: MessagePart = { schemaVersion: 2, id: `media-${index}`, sessionId: 'session', runId: run.id, turnId: turn.id, messageId: assistant.id, index: parts.length, revision: 0,
        type: 'media', state: 'open', createdAt: stamp, mime: 'image/png', artifact: { id: 'generated-image', identity: { sessionId: 'session', runId: run.id, toolCallId: `internal-${index}`, turnId: turn.id, attemptId: attempt.id },
          sha256: hash('image'), storedBytes: 8, observedBytes: 8, producerTruncatedBytes: 0, artifactTruncatedBytes: 0, createdAt: stamp, expiresAt: '2027-01-01T00:00:00.000Z', complete: true, outcome: 'completed' } };
      store.putPart(media); store.putPart({ ...media, revision: 1, state: 'completed', completedAt: stamp });
    }
    store.putAttempt({ ...attempt, state: 'completed', dispatchedAt: stamp, completedAt: stamp });
    store.putTurn({ ...turn, state: 'awaiting_tools' });
    const content = opts.output ?? `nonce-${index} observed`, state = opts.failed ? 'failed' as const : 'completed' as const;
    for (const [number, call] of calls.entries()) {
      const part = parts[number]!; assert.equal(part.type, 'tool'); if (part.type !== 'tool') throw new Error('fixture tool part');
      const tool: ToolCallRecord = { id: part.toolCallId, runId: run.id, sessionId: 'session', name: call.name, input: call.input, state, output: content, ...(opts.failed ? { error: content } : {}) };
      store.commit(run.id, `tool.${state}`, {}, { tool, message: { id: number ? `result-${index}-${number}` : `result-${index}`, sessionId: 'session', runId: run.id, role: 'tool', content, toolCallId: call.id, createdAt: stamp } });
      store.putPart({ ...part, revision: 1, state, completedAt: stamp, result: { output: content, isError: opts.failed ?? false, truncated: false, ...(opts.extraPartBytes ? { auxiliary: 'x'.repeat(opts.extraPartBytes) } : {}) } });
    }
    store.putTurn({ ...turn, state: 'completed', completedAt: stamp, finishReason: 'tool_calls' });
    return { turn, attempt, assistant, part: parts[0]! };
  }
  for (let i = 0; i < count; i++) exchange(i, { failed: i === 1, replay: i === 0 });
  return { root, path, store, run, accepted, exchange };
}
function candidate(f: ReturnType<typeof fixture>, source = f.store.readActivePrefixSource(f.run.id, selection), id = 'summary-1'): PreparedActivePrefix & ActivePrefixContextPublication {
  const text = `Derived ${source.sourceMessageIds.length} exact observations`, revision = f.store.nextContextRevisionIndex('session'), latest = f.store.getLatestContextRevision('session');
  const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 1, reasoningOutputTokens: 0 };
  const checkpoint: ActivePrefixCheckpoint = { id, revisionId: `${id}-revision`, version: 1, scope: 'active-run-prefix', projection: source.projection,
    sessionId: source.sessionId, workspaceId: source.workspaceId, runId: source.runId, providerId: source.providerId, modelId: source.modelId,
    sourceMessageIds: [...source.sourceMessageIds], sourceTurnIds: [...source.sourceTurnIds], coveredMessageIds: [...source.coveredMessageIds], protectedMessageIds: [...source.protectedMessageIds],
    boundaryTurnId: source.boundaryTurnId, boundaryAttemptId: source.boundaryAttemptId, latestUserMessageId: source.latestUserMessageId,
    factsSha256: source.factsSha256, manifestSha256: source.manifestSha256, policySha256: source.policySha256, summarySha256: hash(text), createdAt: stamp,
    ...(source.priorCheckpointId ? { previousCheckpointId: source.priorCheckpointId } : {}), usage };
  const summaryRevision: ContextRevision = { schemaVersion: 2, id: checkpoint.revisionId, sessionId: 'session', runId: f.run.id, revision, kind: 'summary', sourceIds: [...source.sourceMessageIds,
    `active-prefix-checkpoint:${hash(JSON.stringify(checkpoint))}`], text, sha256: hash(text), createdAt: stamp, ...(latest ? { supersedesId: latest.id } : {}) };
  const providerText = JSON.stringify([{ role: 'assistant', content: text }]);
  const contextRevision: ContextRevision = { schemaVersion: 2, id: `${id}-context`, sessionId: 'session', runId: f.run.id, revision: revision + 1, kind: 'update', sourceIds: [summaryRevision.id],
    text: providerText, sha256: hash(providerText), createdAt: stamp, supersedesId: summaryRevision.id };
  f.store.commit(f.run.id, 'summary.prepared', { summaryAttemptId: id, scope: 'active-run-prefix', factsSha256: source.factsSha256, manifestSha256: source.manifestSha256,
    expectedMemoryRevision: source.expectedMemoryRevision, expectedContextHeadRevision: source.expectedContextHeadRevision });
  f.store.commit(f.run.id, 'summary.dispatched', { summaryAttemptId: id, scope: 'active-run-prefix', providerId: config.providerId, modelId: config.modelId });
  return { source, checkpoint, summaryRevision, contextRevision, contextData: { revisionId: contextRevision.id, contextRevision: contextRevision.revision, bindingHash: hash(providerText) } };
}
function publish(f: ReturnType<typeof fixture>, change: PreparedActivePrefix & ActivePrefixContextPublication) {
  return f.store.commitActivePrefixCheckpoint(f.run.id, { summaryAttemptId: change.checkpoint.id, scope: 'active-run-prefix', revisionId: change.summaryRevision.id,
    contextRevisionId: change.contextRevision.id, usage: JSON.parse(JSON.stringify(change.checkpoint.usage)) as JsonObject }, change);
}

test('exact old exchanges retain failed observations, pair repeated provider IDs and exclude opaque replay', t => {
  const f = fixture(t), source = f.store.readActivePrefixSource(f.run.id, selection), facts = JSON.parse(source.sourceJson).messages as JsonObject[];
  assert.equal(source.sourceMessageIds.length, 8); assert.deepEqual(source.sourceTurnIds, ['turn-0', 'turn-1', 'turn-2', 'turn-3']);
  assert.equal(source.boundaryTurnId, 'turn-5'); assert.equal(source.boundaryAttemptId, 'attempt-5');
  assert.ok(source.protectedMessageIds.includes(source.latestUserMessageId));
  assert.ok(source.protectedMessageIds.includes('assistant-4') && source.protectedMessageIds.includes('result-5'));
  assert.equal(facts.find(fact => fact.id === 'result-1')?.toolOutcome, 'failed');
  assert.equal(facts.find(fact => fact.id === 'result-3')?.internalToolCallId, 'internal-3');
  assert.equal(source.sourceJson.includes('private-replay'), false); assert.equal(source.factsSha256, hash(source.sourceJson));
  assert.ok(f.store.getSnapshot('session').messages.find(message => message.id === 'assistant-0')?.providerReplay);
});

test('small count and byte policies select a whole earliest exchange chunk and continue cumulative coverage', t => {
  const f = fixture(t), first = f.store.readActivePrefixSource(f.run.id, { ...selection, maxSourceMessages: 3 });
  assert.deepEqual(first.sourceMessageIds, ['assistant-0', 'result-0']);
  publish(f, candidate(f, first));
  const next = f.store.readActivePrefixSource(f.run.id, { ...selection, maxSourceMessages: 3 });
  assert.deepEqual(next.sourceMessageIds, ['assistant-1', 'result-1']);
  assert.deepEqual(next.coveredMessageIds, ['assistant-0', 'result-0', 'assistant-1', 'result-1']);
  assert.equal(next.priorCheckpointId, 'summary-1');
});

test('first exchange exceeding source bounds fails without truncated facts or activating any document', t => {
  const f = fixture(t, 0); f.exchange(0, { output: '한'.repeat(2000) }); for (let i = 1; i < 5; i++) f.exchange(i);
  const events = f.store.readEvents('session', 0);
  assert.throws(() => f.store.readActivePrefixSource(f.run.id, { ...selection, maxSourceBytes: 1024 }), hasCode('ACTIVE_PREFIX_SOURCE_LIMIT'));
  assert.throws(() => f.store.readActivePrefixSource(f.run.id, { ...selection, maxSourceMessages: 1 }), hasCode('ACTIVE_PREFIX_SOURCE_LIMIT'));
  assert.equal(f.store.getSessionDocument('session', 'context.active_memory'), null); assert.deepEqual(f.store.readEvents('session', 0), events);
});

test('aggregate tool Part facts are rejected before payload materialization, even when each Part fits', t => {
  const f = fixture(t, 0); f.exchange(0, { batch: 8, extraPartBytes: 4096 }); for (let i = 1; i < 5; i++) f.exchange(i);
  const observer = new DatabaseSync(f.path); t.after(() => observer.close());
  let partPayloadReads = 0;
  const instrumented = new Proxy(observer, { get(target, key) {
    if (key === 'prepare') return (sql: string) => { if (sql.includes('FROM message_parts') && sql.includes('AS facts')) partPayloadReads++; return target.prepare(sql); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => readActivePrefixSourceDatabase(instrumented, f.store.getRun(f.run.id), { ...selection, maxSourceBytes: 16384 }), hasCode('ACTIVE_PREFIX_SOURCE_LIMIT'));
  assert.equal(partPayloadReads, 0); assert.equal(f.store.getSessionDocument('session', 'context.active_memory'), null);
});

test('a native output media Part protects its whole exchange and is never silently summarized as text', t => {
  const f = fixture(t, 0); f.exchange(0, { media: true }); for (let i = 1; i < 6; i++) f.exchange(i);
  const source = f.store.readActivePrefixSource(f.run.id, selection);
  assert.ok(source.protectedMessageIds.includes('assistant-0') && source.protectedMessageIds.includes('result-0'));
  assert.ok(!source.coveredMessageIds.includes('assistant-0') && !source.coveredMessageIds.includes('result-0'));
  assert.ok(!source.sourceJson.includes('generated-image') && !source.sourceJson.includes('nonce-0'));
  assert.deepEqual(source.sourceTurnIds, ['turn-1', 'turn-2', 'turn-3']);
  publish(f, candidate(f, source)); assert.equal(f.store.listParts('turn-0').find(part => part.type === 'media')?.state, 'completed');
});

test('summary and provider context publish atomically with exact document pointers and both journals', t => {
  const f = fixture(t), before = f.store.getSnapshot('session'), change = candidate(f);
  const event = publish(f, change);
  assert.equal(event.type, 'summary.completed');
  assert.equal(f.store.getSessionDocument('session', 'context.active_memory')?.data.active && (f.store.getSessionDocument('session', 'context.active_memory')!.data.active as JsonObject).id, change.checkpoint.id);
  assert.deepEqual(f.store.getSessionDocument('session', 'context.head')?.data, change.contextData);
  assert.equal(f.store.getLatestContextRevision('session')?.id, change.contextRevision.id);
  const native = f.store.readSessionEvents('session', 0), legacy = f.store.readEvents('session', 0);
  assert.ok(native.some(item => item.type === 'summary.completed') && native.some(item => item.type === 'context.revision.activated'));
  assert.ok(legacy.some(item => item.type === 'summary.completed') && legacy.some(item => item.type === 'context.revision.activated'));
  assert.deepEqual(f.store.getSnapshot('session').messages, before.messages, 'Raw transcript/replay are not rewritten');
  assert.equal(f.store.listTurns(f.run.id).length, 6, 'Summary creates no extra ordinary Turn');
  assert.throws(() => publish(f, change), hasCode('ACTIVE_PREFIX_SOURCE_CHANGED'));
});

for (const journal of ['session_events', 'events'] as const) test(`late ${journal} activation failure rolls back both revisions/documents/completion journals`, t => {
  const f = fixture(t), change = candidate(f), observer = new DatabaseSync(f.path); t.after(() => observer.close());
  observer.exec(`CREATE TRIGGER fail_publish BEFORE INSERT ON ${journal} WHEN NEW.type='context.revision.activated' BEGIN SELECT RAISE(ABORT,'publication failed'); END`);
  const native = f.store.readSessionEvents('session', 0), legacy = f.store.readEvents('session', 0);
  assert.throws(() => publish(f, change), /publication failed/);
  assert.equal(f.store.getSessionDocument('session', 'context.active_memory'), null); assert.equal(f.store.getSessionDocument('session', 'context.head'), null);
  assert.equal(f.store.getLatestContextRevision('session'), null);
  assert.deepEqual(f.store.readSessionEvents('session', 0), native); assert.deepEqual(f.store.readEvents('session', 0), legacy);
});

test('new pending steer invalidates candidate but queue arrival leaves an exact source eligible', t => {
  const f = fixture(t), change = candidate(f);
  f.store.acceptInput({ sessionId: 'session', requestId: 'queued', prompt: 'later Run', config, delivery: 'queue' });
  publish(f, change);
  f.exchange(6); const next = candidate(f, f.store.readActivePrefixSource(f.run.id, selection), 'summary-2');
  f.store.acceptInput({ sessionId: 'session', requestId: 'steer', prompt: 'new instructions', config, delivery: 'steer' });
  assert.throws(() => publish(f, next), hasCode('ACTIVE_PREFIX_SOURCE_CHANGED'));
  assert.equal((f.store.getSessionDocument('session', 'context.active_memory')?.data.active as JsonObject).id, 'summary-1');
});

test('head CAS change, modified exact source or forged checkpoint marker cannot activate stale coverage', t => {
  for (const kind of ['head', 'facts', 'marker'] as const) {
    const f = fixture(t), change = candidate(f);
    if (kind === 'head') f.store.putSessionDocument('session', 'context.head', 0, { revisionId: 'other' });
    if (kind === 'facts') {
      const original = f.store.getSnapshot('session').messages.find(message => message.id === 'assistant-0')!;
      f.store.commit(f.run.id, 'fixture.changed', {}, { message: { ...original, content: 'changed durable facts' } });
    }
    if (kind === 'marker') change.summaryRevision.sourceIds = change.summaryRevision.sourceIds.filter(id => !id.startsWith('active-prefix-checkpoint:'));
    assert.throws(() => publish(f, change), hasCode(kind === 'marker' ? 'ACTIVE_PREFIX_BINDING_MISMATCH' : 'ACTIVE_PREFIX_SOURCE_CHANGED'));
    assert.equal(f.store.getSessionDocument('session', 'context.active_memory'), null);
  }
});

test('SQL headers cannot substitute for mismatched Part, tool or final attempt JSON ownership', t => {
  for (const [table, id, field, value] of [
    ['message_parts', 'part-0-0', 'runId', 'other-run'],
    ['message_parts', 'part-0-0', 'messageId', 'other-assistant'],
    ['tools', 'internal-0', 'sessionId', 'other-session'],
    ['tools', 'internal-0', 'state', 'running'],
    ['provider_attempts', 'attempt-5', 'turnId', 'other-turn'],
    ['session_turns', 'turn-5', 'state', 'streaming'],
  ] as const) {
    const f = fixture(t), observer = new DatabaseSync(f.path); t.after(() => observer.close());
    observer.prepare(`UPDATE ${table} SET data=json_set(data,?,?) WHERE id=?`).run(`$.${field}`, value, id);
    assert.throws(() => f.store.readActivePrefixSource(f.run.id, selection), hasCode('ACTIVE_PREFIX_BINDING_MISMATCH'));
    assert.equal(f.store.getSessionDocument('session', 'context.active_memory'), null);
  }
});

test('open Turn is rejected; cleaned no-output overflow attempt can bind the prior completed boundary', t => {
  const f = fixture(t), turn: TurnRecord = { schemaVersion: 2, id: 'turn-overflow', sessionId: 'session', runId: f.run.id, inputIds: [f.accepted.inputId], index: 6, state: 'created', createdAt: stamp };
  f.store.putTurn(turn);
  const attempt: ProviderAttempt = { schemaVersion: 2, id: 'overflow-attempt', sessionId: 'session', runId: f.run.id, turnId: turn.id, index: 0, providerId: config.providerId, modelId: config.modelId, state: 'prepared', createdAt: stamp };
  f.store.putAttempt(attempt); f.store.putAttempt({ ...attempt, state: 'failed', completedAt: stamp });
  assert.throws(() => f.store.readActivePrefixSource(f.run.id, selection), hasCode('ACTIVE_PREFIX_BINDING_MISMATCH'));
  const source = f.store.readActivePrefixSource(f.run.id, { ...selection, stage: 'overflow-recovery', currentTurnId: turn.id, failedAttemptId: attempt.id, cleanupConfirmed: true });
  assert.equal(source.boundaryTurnId, 'turn-5'); assert.equal(source.currentTurnId, turn.id);
  const part: MessagePart = { schemaVersion: 2, id: 'unexpected-output', sessionId: 'session', runId: f.run.id, turnId: turn.id, messageId: 'overflow-output', index: 0, revision: 0, type: 'text', state: 'open', text: 'already observed', createdAt: stamp };
  f.store.putPart(part);
  assert.throws(() => f.store.readActivePrefixSource(f.run.id, { ...selection, stage: 'overflow-recovery', currentTurnId: turn.id, failedAttemptId: attempt.id, cleanupConfirmed: true }), hasCode('ACTIVE_PREFIX_BINDING_MISMATCH'));
});

test('unfinished summary never activates after Run cancellation or restart; prior checkpoint survives recovery', t => {
  const f = fixture(t), change = candidate(f);
  publish(f, change); f.exchange(6);
  const pending = candidate(f, f.store.readActivePrefixSource(f.run.id, selection), 'pending-summary');
  f.store.recoverInterrupted();
  assert.throws(() => publish(f, pending), hasCode('ACTIVE_PREFIX_OWNER_REQUIRED'));
  assert.equal((f.store.getSessionDocument('session', 'context.active_memory')?.data.active as JsonObject).id, change.checkpoint.id);
  assert.equal(f.store.getRun(f.run.id).state, 'interrupted');
});

test('a different Run pins the old session document CAS without inheriting previous exact coverage', t => {
  const f = fixture(t); publish(f, candidate(f)); f.store.commit(f.run.id, 'run.completed', {}, { run: { state: 'completed' } });
  const receipt = f.store.admit({ sessionId: 'session', requestId: 'next', prompt: 'new goal', config });
  f.store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  // No completed Turn exists in the successor. The old pointer never supplies source eligibility.
  assert.throws(() => f.store.readActivePrefixSource(receipt.runId, selection), hasCode('ACTIVE_PREFIX_NOT_AVAILABLE'));
  assert.equal((f.store.getSessionDocument('session', 'context.active_memory')?.data.active as JsonObject).runId, f.run.id);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}
function actualOverflow(t: TestContext, hold = false, beforeSummary?: (engine: MoodcodeEngine) => void) {
  const root = mkdtempSync(join(tmpdir(), 'moodcode-prefix-overflow-')), repository = join(root, 'workspace'); mkdirSync(repository);
  writeFileSync(join(repository, 'observation.txt'), 'Recorded local observation. '.repeat(24));
  const summaryEntered = deferred(), cleanupEntered = deferred(), releaseCleanup = deferred();
  const coding: TurnRequest[] = [], summaries: TurnRequest[] = []; let overflow = false, cleanupConfirmed = false, engine!: MoodcodeEngine;
  const provider: ProviderAdapter = { id: 'owned-overflow', async *streamTurn(request, signal) {
    if (!request.tools.length) {
      summaries.push(structuredClone(request));
      assert.equal(engine.store.getTurn(coding.at(-1)!.turnId!).state, 'streaming');
      assert.equal(engine.store.getAttempt(coding.at(-1)!.attemptId!).state, 'failed');
      assert.throws(() => engine.store.getAttempt(request.attemptId!), hasCode('ATTEMPT_NOT_FOUND'));
      try {
        summaryEntered.resolve();
        if (hold) { await waitForAbort(signal); return; }
        beforeSummary?.(engine);
        yield { type: 'text.delta', delta: 'Derived historical file observation; current state requires another read.' };
        yield { type: 'usage', inputTokens: 20, outputTokens: 4 };
        yield { type: 'finish', reason: 'stop' };
      } finally {
        if (hold) { cleanupEntered.resolve(); await releaseCleanup.promise; }
        cleanupConfirmed = true;
      }
      return;
    }
    coding.push(structuredClone(request));
    if (request.turnIndex === 6 && !overflow) { overflow = true; yield { type: 'progress' }; throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Owned local no-output overflow'); }
    if (request.turnIndex >= 6) { yield { type: 'text.delta', delta: 'Recovered same logical Turn' }; yield { type: 'finish', reason: 'stop' }; return; }
    yield { type: 'tool.call', call: { id: `read-${request.turnIndex}`, name: 'read_file', input: { path: 'observation.txt' } } };
    yield { type: 'finish', reason: 'tool_calls' };
  } };
  const dbPath = join(root, 'engine.sqlite');
  engine = createEngine({ dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'local', mode: 'plan', limits: { maxTurns: 16, maxToolCalls: 16, maxOutputBytes: 200000, maxContextBytes: 65536 },
      budgets: { turnAllowance: 16, maxProviderAttempts: 2, maxSummaryCalls: 4 } },
    activePrefixPolicy: { kind: 'active-prefix-semantic', version: 1, maxSourceBytes: 32768, keepRecentTurns: 2 } });
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  t.after(async () => { releaseCleanup.resolve(); await engine.close(); reader.close(); rmSync(root, { recursive: true, force: true }); });
  engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: stamp });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Actual overflow proof', createdAt: stamp });
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'owner', prompt: 'Continue the bounded local observation task', config: engine.getCapabilities().defaults });
  return { engine, reader, receipt, coding, summaries, summaryEntered, cleanupEntered, releaseCleanup, cleanupConfirmed: () => cleanupConfirmed };
}

test('actual overflow summary publishes outside native Attempt records and retries the same logical Turn', { timeout: 15000 }, async t => {
  const f = actualOverflow(t), run = await f.engine.waitForRun(f.receipt.runId);
  assert.equal(run.state, 'completed', JSON.stringify(run.error)); assert.equal(f.summaries.length, 1); assert.ok(f.cleanupConfirmed());
  const retried = f.coding.filter(request => request.turnIndex === 6);
  assert.equal(retried.length, 2); assert.equal(retried[0]!.turnId, retried[1]!.turnId); assert.notEqual(retried[0]!.attemptId, retried[1]!.attemptId);
  assert.equal(f.engine.store.listTurns(run.id).length, 7);
  assert.equal(f.engine.coordinator.getRunUsage(run.id).turns, 7, 'One summary and retry do not manufacture ordinary logical Turns');
  const turn = f.engine.store.getTurn(retried[0]!.turnId!), firstAttempt = f.engine.store.getAttempt(retried[0]!.attemptId!), nextAttempt = f.engine.store.getAttempt(retried[1]!.attemptId!);
  assert.equal(turn.state, 'completed'); assert.equal(firstAttempt.state, 'failed'); assert.equal(nextAttempt.state, 'completed');
  assert.notEqual(nextAttempt.contextRevisionId, firstAttempt.contextRevisionId);
  assert.equal(f.engine.store.getContextRevision(nextAttempt.contextRevisionId!).turnId, undefined);
  assert.ok(retried[1]!.messages.some(message => message.content.startsWith('[Moodcode active-prefix memory v1]')));
  const native: ReturnType<typeof f.engine.store.readSessionEvents> = [];
  for (let page = 0; page < 8; page++) {
    const events = f.engine.store.readSessionEvents('session', native.at(-1)?.seq ?? 0, 100); native.push(...events); if (events.length < 100) break;
  }
  assert.ok(native.length < 800); const completed = native.filter(event => event.type === 'summary.completed');
  assert.equal(completed.length, 1); assert.equal(completed[0]!.attemptId, undefined); assert.equal(completed[0]!.payload.summaryAttemptId, f.summaries[0]!.attemptId);
});

test('actual close joins held prefix summary cleanup before closing storage and never activates partial memory', { timeout: 15000 }, async t => {
  const f = actualOverflow(t, true); await f.summaryEntered.promise;
  let closed = false; const closing = f.engine.close().then(() => { closed = true; });
  await f.cleanupEntered.promise; await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(f.cleanupConfirmed(), false);
  assert.equal(f.engine.store.getRun(f.receipt.runId).state, 'cancelling');
  assert.equal(f.engine.store.getSessionDocument('session', 'context.active_memory'), null);
  f.releaseCleanup.resolve(); await closing;
  assert.equal(closed, true); assert.ok(f.cleanupConfirmed());
  assert.throws(() => f.engine.store.getRun(f.receipt.runId), hasCode('STORE_CLOSED'));
  assert.equal(f.reader.prepare("SELECT state FROM runs WHERE id=?").get(f.receipt.runId)?.state, 'cancelled');
  assert.equal(f.reader.prepare("SELECT count(*) AS count FROM events WHERE type='summary.completed'").get()?.count, 0);
  assert.equal(f.reader.prepare("SELECT count(*) AS count FROM context_revisions WHERE json_extract(data,'$.kind')='summary'").get()?.count, 0);
});

test('steer arriving during actual overflow summary stops the stale retry and preserves the unpromoted input', { timeout: 15000 }, async t => {
  let inputId = '';
  const f = actualOverflow(t, false, engine => {
    inputId = engine.scheduler.accept({ sessionId: 'session', requestId: 'overflow-steer', prompt: 'New constraint must not bind to an already captured Turn', config: engine.getCapabilities().defaults, delivery: 'steer' }).inputId;
  });
  const run = await f.engine.waitForRun(f.receipt.runId);
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'ACTIVE_PREFIX_SOURCE_CHANGED');
  assert.equal(f.coding.filter(request => request.turnIndex === 6).length, 1, 'No stale second Attempt may dispatch');
  const pending = f.engine.store.getInput(inputId); assert.equal(pending.state, 'pending'); assert.equal(pending.runId, undefined);
  assert.ok(f.engine.store.getSessionControl('session').paused); assert.equal(f.engine.store.getSessionDocument('session', 'context.active_memory'), null);
  assert.equal(f.reader.prepare("SELECT count(*) AS count FROM events WHERE type='summary.completed'").get()?.count, 0);
  assert.equal(f.engine.store.getTurn(f.coding.at(-1)!.turnId!).state, 'failed');
});
