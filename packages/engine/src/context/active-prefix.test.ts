import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { DEFAULT_ENGINE_BUDGETS, DEFAULT_LIMITS, EngineError, type ContextRevision, type InputImageAttachment, type JsonObject, type Message, type MessagePart, type ProviderAttempt, type RunConfig, type TurnRecord } from '@moodcode/contracts';
import { BudgetAccount } from '../config/budgets.js';
import type { ContextRequest, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { SqliteStore } from '../storage/index.js';
import { ACTIVE_PREFIX_DOCUMENT, ACTIVE_PREFIX_MEMORY_PREFIX, ActivePrefixMemoryService, validateActivePrefixPolicy, type PreparedActivePrefix } from './active-prefix.js';
import { planContext } from './plan.js';
import { unknownModelSpec } from './model-spec.js';
import { ContextService } from './service.js';

const stamp = () => new Date().toISOString();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
const config: RunConfig = { providerId: 'fixture', modelId: 'active-summary', mode: 'plan', limits: { ...DEFAULT_LIMITS, maxTurns: 64, maxToolCalls: 128 }, budgets: { ...DEFAULT_ENGINE_BUDGETS, turnAllowance: 64 } };
const image: InputImageAttachment = { id: 'img_' + 'a'.repeat(32), kind: 'image', mimeType: 'image/png', bytes: 8, sha256: 'b'.repeat(64) };
function fixture(t: TestContext, count = 24, options: { runConfig?: RunConfig; toolBytes?: number } = {}) {
  const runConfig = options.runConfig ?? config;
  const store = new SqliteStore(':memory:'); t.after(() => store.close());
  store.putWorkspace({ id: 'workspace', root: process.cwd(), gitRoot: process.cwd(), branch: null, createdAt: stamp() });
  store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Active prefix', createdAt: stamp() });
  const input = store.acceptInput({ sessionId: 'session', requestId: 'first', prompt: 'Preserve original goal and original pixels', attachments: [image], config: runConfig, delivery: 'queue' });
  const run = store.promoteInput(input.inputId).run;
  store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  for (let index = 0; index < count; index++) {
    const turn: TurnRecord = { schemaVersion: 2, id: `turn-${index}`, sessionId: run.sessionId, runId: run.id, index, inputIds: store.listRunInputIds(run.id), state: 'created', createdAt: stamp() };
    store.putTurn(turn); store.putTurn({ ...turn, state: 'streaming' });
    const attempt: ProviderAttempt = { schemaVersion: 2, id: `attempt-${index}`, sessionId: run.sessionId, runId: run.id, turnId: turn.id, index: 0, providerId: config.providerId, modelId: config.modelId, state: 'prepared', createdAt: stamp() };
    store.putAttempt(attempt); const dispatched = store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: stamp() });
    const assistant: Message = { id: `assistant-${index}`, sessionId: run.sessionId, runId: run.id, role: 'assistant', content: `Inspect observation ${index}`,
      toolCalls: [{ id: 'reused-provider-id', name: 'read_file', input: { path: `facts/${index}.txt` } }], providerReplay: { providerId: 'fixture', items: [{ type: 'opaque_fixture', token: `private-replay-${index}` }] }, createdAt: stamp() };
    store.commit(run.id, 'message.completed', {}, { message: assistant });
    const part: MessagePart = { schemaVersion: 2, id: `part-${index}`, sessionId: run.sessionId, runId: run.id, turnId: turn.id, messageId: assistant.id, index: 0, revision: 0, state: 'open', type: 'tool',
      toolCallId: `internal-${index}`, providerCallId: 'reused-provider-id', name: 'read_file', input: { path: `facts/${index}.txt` }, createdAt: stamp() };
    store.putPart(part);
    store.putAttempt({ ...dispatched, state: 'completed', completedAt: stamp() });
    store.putTurn({ ...turn, state: 'awaiting_tools' });
    const content = `nonce-${index}: durable observation ${index}` + 'x'.repeat(options.toolBytes ?? 0);
    store.commit(run.id, 'tool.completed', {}, { tool: { id: `internal-${index}`, sessionId: run.sessionId, runId: run.id, name: 'read_file', input: part.input, state: 'completed', output: content } });
    store.commit(run.id, 'message.completed', {}, { message: { id: `result-${index}`, sessionId: run.sessionId, runId: run.id, role: 'tool', toolCallId: 'reused-provider-id', content,
      toolResult: { warnings: index === 0 ? ['Observation is historical'] : [], artifactRefs: [], outcome: 'completed' }, createdAt: stamp() } });
    store.putPart({ ...part, revision: 1, state: 'completed', result: { output: content, isError: false, truncated: false }, completedAt: stamp() });
    store.putTurn({ ...turn, state: 'completed', completedAt: stamp(), finishReason: 'tool_calls' });
    if (index === 10) {
      const steer = store.acceptInput({ sessionId: 'session', requestId: 'steer', prompt: 'Current steer: retain the requested constraint', config: runConfig, delivery: 'steer' });
      store.promoteSteers([steer.inputId], run.id);
    }
  }
  const memory = new ActivePrefixMemoryService(store, { kind: 'active-prefix-semantic', version: 1 });
  const request: ContextRequest = { workspace: store.getWorkspace('workspace'), snapshot: store.readModelHistory('session').snapshot, config: runConfig, run: store.getRun(run.id), budget: new BudgetAccount(runConfig), signal: new AbortController().signal };
  return { store, run, memory, request };
}
function provider(events: ProviderEvent[], inspect?: (request: TurnRequest) => void): ProviderAdapter {
  return { id: 'fixture', async *streamTurn(request) { inspect?.(request); yield* events; } };
}
function appendTextTurn(f: ReturnType<typeof fixture>, index: number, extraBytes = 0): void {
  const turn: TurnRecord = { schemaVersion: 2, id: `turn-${index}`, sessionId: f.run.sessionId, runId: f.run.id, index, inputIds: f.store.listRunInputIds(f.run.id), state: 'created', createdAt: stamp() };
  f.store.putTurn(turn); f.store.putTurn({ ...turn, state: 'streaming' });
  const attempt: ProviderAttempt = { schemaVersion: 2, id: `attempt-${index}`, sessionId: f.run.sessionId, runId: f.run.id, turnId: turn.id, index: 0, providerId: config.providerId, modelId: config.modelId, state: 'prepared', createdAt: stamp() };
  f.store.putAttempt(attempt); const dispatched = f.store.putAttempt({ ...attempt, state: 'dispatched', dispatchedAt: stamp() });
  const content = `Latest text-only complete observation ${index}` + 'y'.repeat(extraBytes);
  f.store.commit(f.run.id, 'message.completed', {}, { message: { id: `assistant-${index}`, sessionId: f.run.sessionId, runId: f.run.id, role: 'assistant', content, createdAt: stamp() } });
  const part: MessagePart = { schemaVersion: 2, id: `part-${index}`, sessionId: f.run.sessionId, runId: f.run.id, turnId: turn.id, messageId: `assistant-${index}`, index: 0, revision: 0, state: 'open', type: 'text', text: content, createdAt: stamp() };
  f.store.putPart(part); f.store.putPart({ ...part, revision: 1, state: 'completed', completedAt: stamp() });
  f.store.putAttempt({ ...dispatched, state: 'completed', completedAt: stamp() });
  f.store.putTurn({ ...turn, state: 'completed', completedAt: stamp(), finishReason: 'stop' });
}
const success = () => provider([{ type: 'text.delta', delta: 'Recorded nonce-0 from facts/0.txt; historical observation, verify current files.' }, { type: 'usage', inputTokens: 48, outputTokens: 12, cachedInputTokens: 4, reasoningOutputTokens: 2 }, { type: 'finish', reason: 'stop' }]);
async function context(f: ReturnType<typeof fixture>, candidate: PreparedActivePrefix) {
  const projected = f.memory.project(f.request, candidate), plan = await planContext(projected);
  const text = JSON.stringify(plan.messages);
  const revision: ContextRevision = { schemaVersion: 2, id: 'context-' + candidate.checkpoint.id, sessionId: f.run.sessionId, runId: f.run.id, revision: candidate.summaryRevision.revision + 1,
    kind: 'update', supersedesId: candidate.summaryRevision.id, sourceIds: [...plan.selectedMessageIds, candidate.summaryRevision.id], text, sha256: hash(text), createdAt: stamp() };
  const data: JsonObject = { revisionId: revision.id, contextRevision: revision.revision, bindingHash: hash(text), diagnostics: { revisionId: revision.id, revision: revision.revision } };
  return { projected, plan, publication: { contextRevision: revision, contextData: data } };
}

test('active-prefix host policy rejects unsupported or unbounded requests', () => {
  assert.equal(validateActivePrefixPolicy({ kind: 'active-prefix-semantic', version: 1 }).maxSourceBytes, 32768);
  for (const value of [0, 129, NaN, 2.5]) assert.throws(() => validateActivePrefixPolicy({ kind: 'active-prefix-semantic', version: 1, maxSourceMessages: value }), hasCode('INVALID_ACTIVE_PREFIX_POLICY'));
  assert.throws(() => validateActivePrefixPolicy({ kind: 'active-prefix-semantic', version: 1, maxCoveredMessages: 100 }), hasCode('INVALID_ACTIVE_PREFIX_POLICY'));
  let reads = 0;
  const accessor = { kind: 'active-prefix-semantic', version: 1, get maxSourceBytes() { reads++; return 1024; } } as const;
  assert.throws(() => validateActivePrefixPolicy(accessor), hasCode('INVALID_ACTIVE_PREFIX_POLICY'));
  assert.equal(reads, 0);
  assert.throws(() => validateActivePrefixPolicy({ kind: 'active-prefix-semantic', version: 1, extra: true } as never), hasCode('INVALID_ACTIVE_PREFIX_POLICY'));
  assert.throws(() => validateActivePrefixPolicy(Object.assign(Object.create({ inherited: true }), { kind: 'active-prefix-semantic', version: 1 }) as never), hasCode('INVALID_ACTIVE_PREFIX_POLICY'));
});

test('24 completed native tool exchanges prepare exact facts without publishing or altering raw transcript', async t => {
  const f = fixture(t), before = f.store.getSnapshot('session'), beforeTurns = f.store.listTurns(f.run.id);
  let outputBytes = 0, observed = false;
  const candidate = await f.memory.prepare({ ...f.request, consumeSummaryOutput: bytes => { outputBytes += bytes; } }, provider([
    { type: 'text.delta', delta: 'nonce-0 was observed by read_file(facts/0.txt).' }, { type: 'usage', inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 },
    { type: 'usage', inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningOutputTokens: 1 }, { type: 'finish', reason: 'stop' },
  ], request => {
    observed = true; assert.deepEqual(request.tools, []); assert.equal(request.turnId, undefined); assert.ok(request.attemptId);
    const source = JSON.parse(request.messages.at(-1)!.content) as { messages: { content: string }[] };
    assert.ok(source.messages.some(message => message.content.includes('nonce-0')));
    assert.ok(!request.messages.at(-1)!.content.includes('private-replay'));
    assert.ok(!request.messages.at(-1)!.content.includes(image.id));
    assert.ok(!request.messages.at(-1)!.content.includes('nonce-23'));
  }));
  assert.ok(observed); assert.equal(outputBytes, Buffer.byteLength(candidate.summaryRevision.text));
  assert.equal(candidate.source.factsSha256, hash(candidate.source.sourceJson));
  assert.equal(candidate.checkpoint.id, f.store.readEvents('session', 0).find(event => event.type === 'summary.dispatched')?.payload.summaryAttemptId);
  assert.equal(candidate.summaryRevision.turnId, undefined);
  assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
  assert.equal(f.store.getLatestContextRevision('session'), null);
  assert.equal(f.store.readEvents('session', 0).filter(event => event.type === 'summary.completed').length, 0);
  assert.deepEqual(f.store.getSnapshot('session').messages, before.messages);
  assert.deepEqual(f.store.listTurns(f.run.id), beforeTurns);
  assert.equal(f.request.budget!.snapshot().summaryCalls, 1);
  assert.equal(f.request.budget!.snapshot().logicalTurns, 0);
  assert.deepEqual(candidate.checkpoint.usage, { inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningOutputTokens: 1 });
  const attempt = f.store.getSummaryAttempt(candidate.checkpoint.id);
  assert.equal(attempt.scope, 'active-run-prefix'); assert.equal(attempt.state, 'streaming'); assert.equal(attempt.publication, 'pending');
  assert.ok(attempt.providerCompletedAt); assert.equal(attempt.cleanupConfirmed, true);
  assert.equal(attempt.partialText, candidate.summaryRevision.text); assert.equal(attempt.observedOutputBytes, outputBytes);
  assert.equal(attempt.sourceSha256, candidate.source.factsSha256); assert.equal(attempt.manifestSha256, candidate.source.manifestSha256);
  assert.deepEqual(f.store.getSummaryUsage(candidate.checkpoint.id)?.usage, candidate.checkpoint.usage);
});

test('candidate projection preserves original goal, current steer, image refs and latest native replay, then publishes both revisions', async t => {
  const f = fixture(t), raw = f.store.getSnapshot('session').messages;
  const candidate = await f.memory.prepare(f.request, success()), prepared = await context(f, candidate);
  assert.ok(prepared.projected.activePrefixMemory!.content.startsWith(ACTIVE_PREFIX_MEMORY_PREFIX));
  assert.ok(prepared.projected.snapshot.messages.find(message => message.role === 'user')?.attachments?.some(ref => ref.id === image.id));
  assert.ok(prepared.projected.snapshot.messages.some(message => message.content.startsWith('Current steer')));
  assert.deepEqual(prepared.projected.snapshot.messages.find(message => message.id === 'assistant-23')?.providerReplay, raw.find(message => message.id === 'assistant-23')?.providerReplay);
  assert.ok(!prepared.projected.snapshot.messages.some(message => message.id === 'result-0'));
  const checkpoint = f.memory.publishWithContext(f.request, candidate, prepared.publication);
  assert.equal(f.memory.active('session', f.run.id)?.checkpoint.id, checkpoint.id);
  assert.equal(f.store.getSessionDocument('session', 'context.head')?.data.revisionId, prepared.publication.contextRevision.id);
  assert.equal(f.store.getLatestContextRevision('session')?.id, prepared.publication.contextRevision.id);
  assert.equal(f.store.getContextRevision(checkpoint.revisionId).sha256, checkpoint.summarySha256);
  const completed = f.store.getSummaryAttempt(checkpoint.id);
  assert.equal(completed.state, 'completed'); assert.equal(completed.publication, 'activated');
  assert.equal(completed.summaryRevisionId, checkpoint.revisionId); assert.equal(completed.contextRevisionId, prepared.publication.contextRevision.id);
  assert.deepEqual(f.store.getSnapshot('session').messages, raw);
  assert.throws(() => f.memory.publishWithContext(f.request, candidate, prepared.publication), hasCode('ACTIVE_PREFIX_CANDIDATE_INVALID'));
});

test('required candidate budget failure can be discarded without advancing any active checkpoint or context revision', async t => {
  const f = fixture(t), candidate = await f.memory.prepare(f.request, success());
  const projected = f.memory.project(f.request, candidate);
  const failed = planContext({ ...projected, config: { ...config, limits: { ...config.limits, maxContextBytes: 256 } } });
  await assert.rejects(failed);
  f.memory.discard(candidate, new EngineError('CONTEXT_LIMIT', 'Required candidate did not fit'));
  assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
  assert.equal(f.store.getLatestContextRevision('session'), null);
  assert.equal(f.store.readEvents('session', 0).findLast(event => event.type === 'summary.failed')?.payload.code, 'CONTEXT_LIMIT');
  const discarded = f.store.getSummaryAttempt(candidate.checkpoint.id);
  assert.equal(discarded.state, 'failed'); assert.equal(discarded.publication, 'discarded'); assert.equal(discarded.cleanupConfirmed, true);
  assert.ok(discarded.providerCompletedAt); assert.equal(discarded.partialText, candidate.summaryRevision.text);
});

test('discard after cancellation retains provider-complete proof and records interrupted for a custom signal reason', async t => {
  const f = fixture(t), controller = new AbortController();
  const candidate = await f.memory.prepare({ ...f.request, signal: controller.signal }, success());
  const reason = new Error('Host stopped while planning a completed candidate'); controller.abort(reason);
  f.memory.discard(candidate, reason);
  const attempt = f.store.getSummaryAttempt(candidate.checkpoint.id);
  assert.equal(attempt.state, 'interrupted'); assert.equal(attempt.publication, 'discarded'); assert.equal(attempt.cleanupConfirmed, true);
  assert.ok(attempt.providerCompletedAt); assert.equal(attempt.partialText, candidate.summaryRevision.text);
  assert.equal(f.store.getLatestContextRevision('session'), null); assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
});

test('provider protocol errors and decreasing inclusive usage do not create candidates or active memory', async t => {
  const f = fixture(t);
  const cases: ProviderEvent[][] = [[], [{ type: 'finish', reason: 'length' }], [{ type: 'text.delta', delta: 'unfinished' }], [{ type: 'tool.call', call: { id: 'forbidden', name: 'read_file', input: {} } }],
    [{ type: 'reasoning.delta', delta: 'not a text-only result' }], [{ type: 'usage', inputTokens: 10 }, { type: 'usage', inputTokens: 9 }],
    [{ type: 'usage', inputTokens: 1, cachedInputTokens: 2 }], [{ type: 'text.delta', delta: 'ok' }, { type: 'finish', reason: 'stop' }, { type: 'text.delta', delta: 'after finish' }]];
  for (const events of cases) {
    await assert.rejects(f.memory.prepare({ ...f.request, budget: new BudgetAccount(config) }, provider(events)));
    assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
    assert.equal(f.store.getLatestContextRevision('session'), null);
  }
  const failedWithoutValue: ProviderAdapter = { id: 'fixture', async *streamTurn() { yield { type: 'text.delta', delta: 'plausible text' }; yield { type: 'finish', reason: 'stop' }; throw undefined; } };
  await assert.rejects(f.memory.prepare({ ...f.request, budget: new BudgetAccount(config) }, failedWithoutValue), hasCode('SUMMARY_FAILED'));
  assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
});

test('observed text consumes the shared allowance before a smaller local summary cap can reject it', async t => {
  const f = fixture(t), memory = new ActivePrefixMemoryService(f.store, { kind: 'active-prefix-semantic', version: 1, maxOutputBytes: 4 });
  let consumed = 0;
  await assert.rejects(memory.prepare({ ...f.request, consumeSummaryOutput: bytes => { consumed += bytes; } }, provider([{ type: 'text.delta', delta: '123456' }, { type: 'finish', reason: 'stop' }])), hasCode('SUMMARY_OUTPUT_LIMIT'));
  assert.equal(consumed, 6, 'Already observed bytes cannot be refunded by a local rejection');
  assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
  let attempted = 0;
  await assert.rejects(memory.prepare({ ...f.request, consumeSummaryOutput: bytes => { attempted += bytes; throw new EngineError('OUTPUT_LIMIT', 'Shared Run output budget exceeded'); } }, provider([{ type: 'text.delta', delta: '123456' }])), hasCode('OUTPUT_LIMIT'));
  assert.equal(attempted, 6);
  assert.equal(f.store.readEvents('session', 0).findLast(event => event.type === 'summary.failed')?.payload.code, 'OUTPUT_LIMIT');
  assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
});

test('cancelled summary and dispatch journal failure prevent activation and preserve honest dispatch evidence', async t => {
  const f = fixture(t), controller = new AbortController();
  let entered!: () => void, release!: () => void;
  const dispatched = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const slow: ProviderAdapter = { id: 'fixture', async *streamTurn(_request, signal) { entered(); signal.addEventListener('abort', release, { once: true }); await gate; yield { type: 'text.delta', delta: 'late' }; yield { type: 'finish', reason: 'stop' }; } };
  const pending = f.memory.prepare({ ...f.request, signal: controller.signal }, slow), rejection = assert.rejects(pending);
  await dispatched; controller.abort(new EngineError('CANCELLED', 'test cancellation')); await rejection;
  assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
  let calls = 0;
  f.store.dispatchSummaryAttempt = () => { throw new EngineError('JOURNAL_FAILURE', 'Injected journal failure'); };
  await assert.rejects(f.memory.prepare({ ...f.request, budget: new BudgetAccount(config) }, provider([], () => { calls++; })), hasCode('JOURNAL_FAILURE'));
  assert.equal(calls, 0);
  assert.equal(f.store.readEvents('session', 0).findLast(event => event.type === 'summary.failed')?.payload.code, 'JOURNAL_FAILURE');
});

test('candidate mutation, changed summary pointer and known model reserve are rejected before publication', async t => {
  const f = fixture(t), candidate = await f.memory.prepare(f.request, success());
  candidate.summaryRevision.text += 'changed';
  assert.throws(() => f.memory.project(f.request, candidate), hasCode('ACTIVE_PREFIX_CANDIDATE_INVALID'));
  const model = { ...unknownModelSpec(config.providerId, config.modelId), contextWindow: 100, maxOutputTokens: 100 };
  let calls = 0;
  const budget = new BudgetAccount(config);
  await assert.rejects(f.memory.prepare({ ...f.request, budget }, provider([], () => { calls++; }), { model }), hasCode('ACTIVE_PREFIX_SOURCE_LIMIT'));
  assert.equal(calls, 0); assert.equal(budget.snapshot().summaryCalls, 0);
  assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
});

test('after publication a new Run does not inherit the predecessor active cutoff', async t => {
  const f = fixture(t), candidate = await f.memory.prepare(f.request, success()), prepared = await context(f, candidate);
  f.memory.publishWithContext(f.request, candidate, prepared.publication);
  f.store.commit(f.run.id, 'run.completed', {}, { run: { state: 'completed' } });
  const input = f.store.acceptInput({ sessionId: 'session', requestId: 'next', prompt: 'New goal', config, delivery: 'queue' }), next = f.store.promoteInput(input.inputId).run;
  assert.equal(f.memory.active('session', next.id), null);
  const request = { ...f.request, run: next, snapshot: f.store.getSnapshot('session') };
  assert.deepEqual(f.memory.project(request), request);
});

test('a fresh service validates immutable checkpoint metadata and rejects altered durable coverage', async t => {
  const f = fixture(t), candidate = await f.memory.prepare(f.request, success()), prepared = await context(f, candidate);
  f.memory.publishWithContext(f.request, candidate, prepared.publication);
  const reader = new ActivePrefixMemoryService(f.store, { kind: 'active-prefix-semantic', version: 1 });
  assert.deepEqual(reader.active('session', f.run.id), f.memory.active('session', f.run.id));
  const document = f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT)!;
  const altered = structuredClone(document.data);
  const active = altered.active as JsonObject;
  active.coveredMessageIds = [f.request.snapshot.messages[0]!.id];
  f.store.putSessionDocument('session', ACTIVE_PREFIX_DOCUMENT, document.revision, altered);
  assert.throws(() => reader.active('session', f.run.id), hasCode('ACTIVE_PREFIX_BINDING_MISMATCH'));
});

test('publication rejects concurrent context head CAS changes and settles the losing candidate once', async t => {
  const f = fixture(t), candidate = await f.memory.prepare(f.request, success()), prepared = await context(f, candidate);
  f.store.putSessionDocument('session', 'context.head', candidate.source.expectedContextHeadRevision, { revisionId: 'concurrent-winner', diagnostics: {} });
  assert.throws(() => f.memory.publishWithContext(f.request, candidate, prepared.publication), hasCode('ACTIVE_PREFIX_SOURCE_CHANGED'));
  assert.equal(f.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), null);
  assert.equal(f.store.getLatestContextRevision('session'), null);
  assert.equal(f.store.getSessionDocument('session', 'context.head')?.data.revisionId, 'concurrent-winner');
  assert.equal(f.store.readEvents('session', 0).filter(event => event.type === 'summary.failed').length, 1);
  assert.throws(() => f.memory.discard(candidate, new EngineError('SECOND_SETTLEMENT', 'do not duplicate')), hasCode('ACTIVE_PREFIX_CANDIDATE_INVALID'));
});

test('incremental checkpoint summarizes newly eligible exchanges and old steer once, retaining cumulative exact coverage', async t => {
  const f = fixture(t), first = await f.memory.prepare(f.request, success()), firstContext = await context(f, first);
  f.memory.publishWithContext(f.request, first, firstContext.publication);
  const steer = f.store.acceptInput({ sessionId: 'session', requestId: 'next-steer', prompt: 'Latest steer stays raw', config, delivery: 'steer' });
  f.store.promoteSteers([steer.inputId], f.run.id); appendTextTurn(f, 24);
  f.request.snapshot = f.store.readModelHistory('session').snapshot;
  let observedPrior = false;
  const next = await f.memory.prepare(f.request, provider([{ type: 'text.delta', delta: 'Retain nonce-0 and newly recorded nonce-22; preserve earlier constraints.' }, { type: 'finish', reason: 'stop' }], request => {
    observedPrior = request.messages.some(message => message.content.includes('Previous derived memory'));
    const facts = JSON.parse(request.messages.at(-1)!.content) as { messages: { content: string }[] };
    assert.ok(facts.messages.some(message => message.content.includes('nonce-22')));
    assert.ok(facts.messages.some(message => message.content.startsWith('Current steer')));
    assert.ok(!facts.messages.some(message => message.content.includes('nonce-0')));
    assert.ok(!facts.messages.some(message => message.content.startsWith('Latest steer')));
  }));
  assert.ok(observedPrior); assert.equal(next.checkpoint.previousCheckpointId, first.checkpoint.id);
  assert.ok(first.checkpoint.coveredMessageIds.every(id => next.checkpoint.coveredMessageIds.includes(id)));
  assert.ok(next.checkpoint.sourceMessageIds.every(id => !first.checkpoint.coveredMessageIds.includes(id)));
  const projected = f.memory.project(f.request, next);
  assert.ok(projected.snapshot.messages.some(message => message.id === steer.inputId));
  assert.ok(projected.snapshot.messages.some(message => message.id === 'assistant-24'));
  assert.ok(!projected.snapshot.messages.some(message => message.content.startsWith('Current steer')));
  const prepared = await context(f, next); f.memory.publishWithContext(f.request, next, prepared.publication);
  assert.equal(f.memory.active('session', f.run.id)?.checkpoint.id, next.checkpoint.id);
  assert.equal(f.request.budget!.snapshot().summaryCalls, 2);
  assert.equal(f.request.budget!.snapshot().logicalTurns, 0);
});

test('summary source uses a smaller complete chunk when quoted JSON and the fixed envelope would exceed a 16KiB request', async t => {
  const runConfig = { ...config, limits: { ...config.limits, maxContextBytes: 16_384 } };
  const f = fixture(t, 24, { runConfig });
  let actualBytes = 0;
  const candidate = await f.memory.prepare(f.request, provider([{ type: 'text.delta', delta: 'A complete bounded source chunk was observed.' }, { type: 'finish', reason: 'stop' }], request => {
    actualBytes = Buffer.byteLength(JSON.stringify(request));
  }));
  assert.ok(candidate.source.limits.maxSourceBytes < f.memory.policy.maxSourceBytes);
  assert.ok(candidate.source.sourceMessageIds.length < 44, 'Select a complete prefix chunk instead of rejecting the large original prefix');
  assert.ok(actualBytes <= runConfig.limits.maxContextBytes);
  assert.ok(candidate.source.sourceMessageIds.length >= 2);
});

test('ContextService prepares a replacement checkpoint when the old protected recent suffix prevents the initial context plan fitting', async t => {
  const runConfig = { ...config, limits: { ...config.limits, maxContextBytes: 10_000 } };
  const f = fixture(t, 4, { runConfig, toolBytes: 3300 });
  let calls = 0;
  const summaryProvider = provider([{ type: 'text.delta', delta: 'Compact historical observations; verify the current state.' }, { type: 'finish', reason: 'stop' }], () => { calls++; });
  const service = new ContextService(f.store, undefined, 0, () => summaryProvider, { activePrefixPolicy: { kind: 'active-prefix-semantic', version: 1 } });
  f.request.snapshot = service.snapshot('session', runConfig);
  await service.build(f.request);
  const firstActive = service.activePrefix!.active('session', f.run.id);
  assert.ok(firstActive, JSON.stringify(service.diagnostics('session')?.plan.warnings));
  const first = firstActive.checkpoint;
  assert.equal(calls, 1);
  appendTextTurn(f, 4, 3300);
  f.request.snapshot = service.snapshot('session', runConfig);
  await assert.rejects(planContext(service.activePrefix!.project(f.request)), hasCode('IMAGE_CONTEXT_LIMIT'));
  const messages = await service.build(f.request);
  const next = service.activePrefix!.active('session', f.run.id)!.checkpoint;
  assert.notEqual(next.id, first.id);
  assert.equal(next.previousCheckpointId, first.id);
  assert.equal(calls, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= runConfig.limits.maxContextBytes);
  assert.ok(messages.some(message => message.content.startsWith(ACTIVE_PREFIX_MEMORY_PREFIX)));
  assert.equal(service.diagnostics('session')!.activePrefix!.checkpointId, next.id);
});
