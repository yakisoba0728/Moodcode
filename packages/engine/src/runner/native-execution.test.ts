import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type AcceptInput, type RunConfig } from '@moodcode/contracts';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';
import { SqliteStore } from '../storage/index.js';
import { ApprovalManager } from '../permission/index.js';
import type { CoordinatorOptions, ProviderAdapter, ProviderEvent, ToolDefinition } from '../ports.js';
import { RunCoordinator } from './index.js';
import { InputScheduler } from './input-scheduler.js';
import { ArtifactStore } from '../artifacts/store.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate: () => boolean) { const deadline = Date.now() + 2500; while (!predicate()) { assert.ok(Date.now() < deadline, 'native operation must progress'); await tick(); } }
const stop: ProviderEvent = { type: 'finish', reason: 'stop' };
async function fixture(t: TestContext, provider: ProviderAdapter, tools: ToolDefinition[] = [], patch: Partial<RunConfig> = {}, extension: Partial<CoordinatorOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-native-run-')));
  const store = new SqliteStore(':memory:');
  const workspace = store.putWorkspace({ id: 'w1', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() });
  const session = store.createSession({ id: 's1', workspaceId: workspace.id, title: 'native fixture', createdAt: new Date().toISOString() });
  const approvals = new ApprovalManager(store);
  const config: RunConfig = { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS, maxDurationMs: 5000 }, ...patch };
  const coordinator = new RunCoordinator({ store, providers: new Map([[provider.id, provider]]), tools, approvals, artifactDir: root,
    buildContext: async ({ snapshot }) => snapshot.messages.map(({ role, content, toolCalls, toolCallId }) => ({ role, content, ...(toolCalls ? { toolCalls } : {}), ...(toolCallId ? { toolCallId } : {}) })), ...extension });
  const scheduler = new InputScheduler({ store, coordinator });
  t.after(async () => { await Promise.allSettled([scheduler.close(), coordinator.close()]); store.close(); await rm(root, { recursive: true, force: true }); });
  const input = (requestId: string, prompt = requestId, delivery: AcceptInput['delivery'] = 'queue', sessionId = session.id): AcceptInput => ({ sessionId, requestId, prompt, delivery, config: structuredClone(config) });
  return { root, store, coordinator, scheduler, input, config };
}

test('pending acceptance has no Run and duplicate wake joins one FIFO execution', async t => {
  const release = gate(); t.after(release.resolve);
  const prompts: string[] = [];
  const f = await fixture(t, { id: 'native', async *streamTurn(request) { prompts.push(request.messages.findLast(message => message.role === 'user')!.content); if (prompts.length === 1) await release.promise; yield stop; } });
  const first = f.scheduler.accept(f.input('first'));
  assert.equal(first.runId, undefined);
  assert.equal(f.store.getSnapshot('s1').runs.length, 0);
  const a = f.scheduler.wake('s1'), b = f.scheduler.wake('s1'); assert.equal(a, b);
  await until(() => prompts.length === 1);
  const second = f.scheduler.accept(f.input('second'));
  assert.equal(f.scheduler.accept(f.input('second')).duplicate, true);
  assert.equal(f.store.getInput(second.inputId).state, 'pending');
  release.resolve(); await a;
  assert.deepEqual(prompts, ['first', 'second']);
  const inputs = f.store.listInputs('s1').inputs;
  assert.deepEqual(inputs.map(input => input.state), ['promoted', 'promoted']);
  assert.equal(new Set(inputs.map(input => input.runId)).size, 2);
  assert.equal(f.store.getSnapshot('s1').runs.every(run => run.state === 'completed'), true);
});

test('steer accepted during final provider stream is applied at settlement in the same Run', async t => {
  const release = gate(); t.after(release.resolve);
  const seen: { runId: string; prompt: string }[] = [];
  const f = await fixture(t, { id: 'native', async *streamTurn(request) {
    seen.push({ runId: request.runId, prompt: request.messages.findLast(message => message.role === 'user')!.content });
    if (seen.length === 1) { yield { type: 'text.delta', delta: 'original reply' }; await release.promise; }
    yield stop;
  } }, [], { budgets: normalizeEngineBudgets({ turnAllowance: 1 }) });
  f.scheduler.accept(f.input('first'));
  await until(() => seen.length === 1);
  const steer = f.scheduler.accept(f.input('steer', 'changed direction', 'steer'));
  assert.equal(f.store.getInput(steer.inputId).state, 'pending');
  release.resolve(); await f.scheduler.waitForSession('s1');
  assert.deepEqual(seen.map(item => item.prompt), ['first', 'changed direction']);
  assert.equal(new Set(seen.map(item => item.runId)).size, 1);
  assert.equal(f.store.listTurns(seen[0]!.runId).length, 2);
  assert.deepEqual(f.store.listTurns(seen[0]!.runId)[1]!.inputIds.length, 2);
});

test('pause preserves backlog and cancel pauses automatic continuation until explicit resume', async t => {
  let calls = 0;
  const f = await fixture(t, { id: 'native', async *streamTurn(_request, signal) {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
    if (!signal.aborted) yield stop;
  } });
  f.scheduler.pause('s1');
  const first = f.scheduler.accept(f.input('first')); const cancelled = f.scheduler.accept(f.input('cancelled'));
  f.scheduler.cancelInput(cancelled.inputId);
  await f.scheduler.waitForSession('s1'); assert.equal(calls, 0);
  f.scheduler.resume('s1'); await until(() => calls === 1);
  const next = f.scheduler.accept(f.input('next'));
  f.coordinator.cancel(f.store.getInput(first.inputId).runId!);
  await f.scheduler.waitForSession('s1');
  assert.equal(f.store.getSessionControl('s1').paused, true);
  assert.equal(f.store.getInput(next.inputId).state, 'pending');
  assert.equal(calls, 1);
  f.scheduler.resume('s1'); await f.scheduler.waitForSession('s1');
  assert.equal(calls, 2);
});

test('same workspace session tickets are fair while different workspaces execute independently', async t => {
  const release = gate(); t.after(release.resolve);
  const seen: string[] = [];
  const f = await fixture(t, { id: 'native', async *streamTurn(request) { const prompt = request.messages.findLast(message => message.role === 'user')!.content; seen.push(prompt); if (prompt === 'a1') await release.promise; yield stop; } });
  f.store.createSession({ id: 's2', workspaceId: 'w1', title: 'second', createdAt: new Date().toISOString() });
  const w2 = f.store.putWorkspace({ ...f.store.getWorkspace('w1'), id: 'w2', root: '/independent', gitRoot: '/independent' });
  f.store.createSession({ id: 's3', workspaceId: w2.id, title: 'third', createdAt: new Date().toISOString() });
  f.scheduler.accept(f.input('a1')); await until(() => seen.includes('a1'));
  f.scheduler.accept(f.input('a2')); f.scheduler.accept(f.input('b1', 'b1', 'queue', 's2')); f.scheduler.accept(f.input('c1', 'c1', 'queue', 's3'));
  await until(() => seen.includes('c1')); assert.equal(seen.includes('b1'), false);
  release.resolve(); await Promise.all(['s1', 's2', 's3'].map(id => f.scheduler.waitForSession(id)));
  assert.ok(seen.indexOf('b1') < seen.indexOf('a2'));
});

test('typed parts retain stable internal tool identities despite provider IDs repeated in later turns', async t => {
  let effects = 0;
  const tool: ToolDefinition = { name: 'read_fixture', description: 'fixture', inputSchema: { type: 'object' }, effectClass: 'read',
    async prepare(input) { return { name: 'read_fixture', input: input as never, fingerprint: JSON.stringify(input), requiresApproval: false, preview: {} }; },
    async execute(_prepared, context) { const parts = f.store.listParts(context.turnId!); assert.ok(parts.some(part => part.type === 'tool' && part.toolCallId === context.toolCallId && part.state === 'open')); effects++; return { content: 'result' }; } };
  const f = await fixture(t, { id: 'native', async *streamTurn(request) {
    if (request.turnIndex < 2) { yield { type: 'tool.call', call: { id: 'provider-same', name: tool.name, input: { turn: request.turnIndex } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { yield { type: 'text.delta', delta: 'complete' }; yield stop; }
  } }, [tool]);
  f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
  const snapshot = f.store.getSnapshot('s1'); assert.equal(snapshot.runs[0]!.state, 'completed'); assert.equal(effects, 2);
  const parts = f.store.listTurns(snapshot.runs[0]!.id).flatMap(turn => f.store.listParts(turn.id)).filter(part => part.type === 'tool');
  assert.equal(parts.length, 2); assert.equal(new Set(parts.map(part => part.toolCallId)).size, 2); assert.deepEqual(parts.map(part => part.providerCallId), ['provider-same', 'provider-same']);
  assert.equal(parts.every(part => part.state === 'completed'), true);
});

test('retryable HTTP rejection before output creates two durable attempts inside one logical turn', async t => {
  let attempts = 0;
  const f = await fixture(t, { id: 'native', async *streamTurn() { if (++attempts === 1) throw new EngineError('PROVIDER_HTTP_ERROR', 'rejected', { status: 429, retryAfterMs: 0 }); yield { type: 'text.delta', delta: 'retried' }; yield stop; } }, [], { budgets: normalizeEngineBudgets({ retryBaseDelayMs: 0 }) });
  f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
  const run = f.store.getSnapshot('s1').runs[0]!; assert.equal(run.state, 'completed');
  assert.equal(f.store.listTurns(run.id).length, 1); assert.equal(attempts, 2);
  const attemptEvents = f.store.readSessionEvents('s1', 0, 100).filter(event => event.type === 'provider.attempt.prepared');
  assert.equal(attemptEvents.length, 2); assert.notEqual(attemptEvents[0]!.attemptId, attemptEvents[1]!.attemptId);
});

test('visible output prevents retry and failed parts retain the committed prefix', async t => {
  let calls = 0;
  const f = await fixture(t, { id: 'native', async *streamTurn() { calls++; yield { type: 'text.delta', delta: 'visible' }; throw new EngineError('PROVIDER_HTTP_ERROR', 'failed after text', { status: 503 }); } });
  f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
  const run = f.store.getSnapshot('s1').runs[0]!; assert.equal(run.state, 'failed'); assert.equal(calls, 1);
  const turn = f.store.listTurns(run.id)[0]!; assert.equal(turn.state, 'failed');
  const parts = f.store.listParts(turn.id); assert.equal(parts[0]!.state, 'failed'); assert.ok(parts[0]!.type === 'text'); assert.equal(parts[0]!.text, 'visible');
});

test('request and inactivity timeouts stop an ambiguous attempt without automatic provider retry', async t => {
  for (const which of ['request', 'inactivity'] as const) await t.test(which, async nested => {
    let calls = 0;
    const f = await fixture(nested, { id: 'native', async *streamTurn(_request, signal) { calls++; await new Promise<never>((_resolve, reject) => { const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }); } }, [], { budgets: normalizeEngineBudgets({ providerRequestTimeoutMs: which === 'request' ? 15 : 100, providerInactivityTimeoutMs: which === 'inactivity' ? 15 : 100 }) });
    f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
    const run = f.store.getSnapshot('s1').runs[0]!; assert.equal(run.state, 'failed'); assert.equal(calls, 1);
    const turn = f.store.listTurns(run.id)[0]!; assert.equal(turn.state, 'uncertain');
    assert.equal(run.error?.code, which === 'request' ? 'PROVIDER_REQUEST_TIMEOUT' : 'PROVIDER_INACTIVITY_TIMEOUT');
  });
});

test('many tiny deltas flush bounded batches and a stalled subscriber does not block execution', async t => {
  const f = await fixture(t, { id: 'native', async *streamTurn() { for (let i = 0; i < 100; i++) yield { type: 'text.delta', delta: 'x' }; yield stop; } });
  const subscriber = f.store.subscribeSessionEvents('s1', 0)[Symbol.asyncIterator]();
  f.scheduler.accept(f.input('first')); await subscriber.next();
  await f.scheduler.waitForSession('s1');
  const snapshot = f.store.getSnapshot('s1'); assert.equal(snapshot.runs[0]!.state, 'completed');
  const deltas = f.store.readEvents('s1', 0, 1000).filter(event => event.type === 'message.delta');
  assert.ok(deltas.length >= 2 && deltas.length < 10);
  assert.equal(deltas.reduce((text, event) => text + event.payload.delta, ''), 'x'.repeat(100));
  const parts = f.store.listParts(f.store.listTurns(snapshot.runs[0]!.id)[0]!.id);
  assert.ok(parts[0]!.type === 'text'); assert.equal(parts[0]!.text, 'x'.repeat(100)); assert.equal(parts[0]!.state, 'completed');
  await subscriber.return?.();
});

test('only declared reads execute concurrently within the bound and settlement precedes state tools and the next turn', async t => {
  let active = 0, peak = 0, completed = 0, stateEffects = 0;
  const read: ToolDefinition = { name: 'parallel_read', effectClass: 'read', description: 'fixture', inputSchema: { type: 'object' },
    async prepare(input) { return { name: this.name, input: input as never, fingerprint: JSON.stringify(input), requiresApproval: false, preview: {} }; },
    async execute() { active++; peak = Math.max(peak, active); await tick(); active--; completed++; return { content: 'small result' }; } };
  const state: ToolDefinition = { ...read, name: 'serial_state', effectClass: 'state', async execute() { assert.equal(active, 0); assert.equal(completed, 4); stateEffects++; return { content: 'state updated' }; } };
  const f = await fixture(t, { id: 'native', async *streamTurn(request) {
    if (request.turnIndex === 0) { for (let index = 0; index < 4; index++) yield { type: 'tool.call', call: { id: `c${index}`, name: read.name, input: { index } } }; yield { type: 'tool.call', call: { id: 'state', name: state.name, input: null } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { assert.equal(active, 0); assert.equal(completed, 4); assert.equal(stateEffects, 1); yield stop; }
  } }, [read, state], { budgets: normalizeEngineBudgets({ maxReadConcurrency: 2 }) });
  f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
  assert.equal(f.store.getSnapshot('s1').runs[0]!.state, 'completed'); assert.equal(peak, 2);
  assert.equal(f.store.getSnapshot('s1').tools.every(tool => tool.state === 'completed'), true);
});

test('fatal parallel read cleanup aborts peers, settles their records and quarantines later workspace execution', async t => {
  let started = 0, settled = 0, turns = 0;
  const read: ToolDefinition = { name: 'parallel_read', effectClass: 'read', description: 'fixture', inputSchema: { type: 'object' },
    async prepare(input) { return { name: this.name, input: input as never, fingerprint: JSON.stringify(input), requiresApproval: false, preview: {} }; },
    async execute(prepared, context) {
      started++;
      if ((prepared.input as { index: number }).index === 0) { await tick(); throw new EngineError('CLEANUP_UNCERTAIN', 'fixture cleanup unknown'); }
      await new Promise<void>(resolve => { context.signal.addEventListener('abort', () => resolve(), { once: true }); if (context.signal.aborted) resolve(); });
      settled++; return { content: 'peer stopped', data: { cleanupConfirmed: true } };
    } };
  const f = await fixture(t, { id: 'native', async *streamTurn() { turns++; for (let index = 0; index < 2; index++) yield { type: 'tool.call', call: { id: `c${index}`, name: read.name, input: { index } } }; yield { type: 'finish', reason: 'tool_calls' }; } }, [read]);
  f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
  const snapshot = f.store.getSnapshot('s1'); assert.equal(snapshot.runs[0]!.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(started, 2); assert.equal(settled, 1); assert.equal(turns, 1);
  assert.equal(snapshot.tools.every(tool => ['failed', 'interrupted'].includes(tool.state)), true);
  assert.equal(f.store.listTurns(snapshot.runs[0]!.id)[0]!.uncertainty?.kind, 'tool_effect');
  const pending = f.scheduler.accept(f.input('pending')); assert.equal(f.store.getInput(pending.inputId).state, 'pending');
  assert.throws(() => f.scheduler.resume('s1'), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
});

test('public summary and media parts stay separate from flat text and inclusive usage is attempt-bound', async t => {
  const f = await fixture(t, { id: 'native', async *streamTurn(request) {
    assert.equal(request.includeMetadata, true);
    yield { type: 'progress', providerRequestId: 'remote-request' };
    yield { type: 'reasoning.delta', delta: 'Public summary.' };
    yield { type: 'text.delta', delta: 'Final answer.' };
    const artifacts = await ArtifactStore.open({ directory: join(f.root, 'media') });
    const artifact = await artifacts.put({ identity: { sessionId: 's1', runId: request.runId, toolCallId: 'media-source', turnId: request.turnId!, attemptId: request.attemptId! }, content: 'attachment fixture' });
    yield { type: 'media', mime: 'text/plain', name: 'fixture.txt', artifact: artifact.reference };
    yield { type: 'usage', inputTokens: 20, outputTokens: 10, cachedInputTokens: 8, reasoningOutputTokens: 4 };
    yield stop;
  } });
  f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
  const snapshot = f.store.getSnapshot('s1'), turn = f.store.listTurns(snapshot.runs[0]!.id)[0]!;
  assert.equal(snapshot.messages.find(message => message.role === 'assistant')!.content, 'Final answer.');
  assert.deepEqual(f.store.listParts(turn.id).map(part => part.type), ['reasoning', 'text', 'media']);
  const usage = f.store.readEvents('s1', 0, 100).find(event => event.type === 'run.usage')!;
  assert.equal(usage.payload.cachedInputTokens, 8); assert.equal(usage.payload.reasoningOutputTokens, 4); assert.equal(usage.payload.turnId, turn.id);
  assert.equal(f.store.getAttempt(usage.payload.attemptId as string).providerRequestId, 'remote-request');
});

test('context overflow recovers once and reuses the logical Turn with a new bounded Attempt', async t => {
  let recovered = false, recoveries = 0, attempts = 0;
  const f = await fixture(t, { id: 'native', async *streamTurn(request) {
    attempts++;
    if (!recovered) { yield { type: 'progress' }; throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'fixture explicit overflow'); }
    assert.equal(request.messages[0]!.content, 'compact context'); yield { type: 'text.delta', delta: 'completed' }; yield stop;
  } }, [], {}, {
    async recoverContextOverflow(request) {
      assert.ok(request.run); assert.ok(request.budget); assert.equal(request.activePrefixStage?.stage, 'overflow-recovery');
      if (request.activePrefixStage?.stage === 'overflow-recovery') {
        assert.equal(request.activePrefixStage.cleanupConfirmed, true);
        assert.equal(f.store.getAttempt(request.activePrefixStage.failedAttemptId).state, 'failed');
        assert.equal(f.store.getAttempt(request.activePrefixStage.failedAttemptId).turnId, request.activePrefixStage.currentTurnId);
      }
      request.budget.startSummary(); recoveries++; recovered = true;
    },
    async buildContext() { return [{ role: 'user', content: recovered ? 'compact context' : 'initial context' }]; },
  });
  f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
  const run = f.store.getSnapshot('s1').runs[0]!; assert.equal(run.state, 'completed'); assert.equal(recoveries, 1); assert.equal(attempts, 2);
  assert.equal(f.store.listTurns(run.id).length, 1);
  const prepared = f.store.readSessionEvents('s1', 0, 100).filter(event => event.type === 'provider.attempt.prepared');
  assert.equal(prepared.length, 2); assert.equal(prepared[0]!.turnId, prepared[1]!.turnId); assert.notEqual(prepared[0]!.attemptId, prepared[1]!.attemptId);
});

test('provider retry and overflow recovery require cleanup proof from the underlying iterator', async t => {
  for (const overflow of [false, true]) await t.test(overflow ? 'overflow recovery' : 'HTTP retry', async nested => {
    let calls = 0, recoveries = 0;
    const failure = overflow ? new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'explicit fixture overflow') : new EngineError('PROVIDER_HTTP_ERROR', 'fixture rate limit', { status: 429 });
    const f = await fixture(nested, { id: 'native', streamTurn() {
      calls++;
      return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> { throw failure; } }; } };
    } }, [], { budgets: normalizeEngineBudgets({ maxProviderAttempts: 3, retryBaseDelayMs: 1 }) }, { async recoverContextOverflow() { recoveries++; } });
    f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
    const run = f.store.getSnapshot('s1').runs[0]!;
    assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(calls, 1); assert.equal(recoveries, 0);
    const turn = f.store.listTurns(run.id)[0]!; assert.equal(turn.state, 'uncertain');
    assert.equal(f.store.getSessionControl('s1').paused, true);
  });
});

test('context overflow after public output or after one recovery cannot trigger another summary or redispatch', async t => {
  for (const visible of [true, false]) await t.test(visible ? 'visible prefix' : 'second overflow', async nested => {
    let calls = 0, recoveries = 0;
    const f = await fixture(nested, { id: 'native', async *streamTurn() { calls++; if (visible) yield { type: 'text.delta', delta: 'prefix' }; throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'fixture overflow'); } }, [], { budgets: normalizeEngineBudgets({ maxProviderAttempts: 3 }) }, { async recoverContextOverflow() { recoveries++; } });
    f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
    assert.equal(f.store.getSnapshot('s1').runs[0]!.state, 'failed'); assert.equal(calls, visible ? 1 : 2); assert.equal(recoveries, visible ? 0 : 1);
  });
});

test('summary output shares the Run output budget before the recovered provider can dispatch', async t => {
  for (const summaryBytes of [3, 5] as const) await t.test(summaryBytes === 3 ? 'remaining bytes bound final output' : 'summary exceeds Run limit', async nested => {
    let calls = 0, summaries = 0;
    const f = await fixture(nested, { id: 'native', async *streamTurn() {
      if (++calls === 1) throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'fixture explicit overflow');
      yield { type: 'text.delta', delta: 'ok' }; yield stop;
    } }, [], { limits: { ...DEFAULT_LIMITS, maxDurationMs: 5000, maxOutputBytes: 4 } }, {
      async recoverContextOverflow(request) {
        assert.ok(request.consumeSummaryOutput);
        request.budget!.startSummary(); summaries++;
        request.consumeSummaryOutput(summaryBytes);
      },
    });
    f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
    const run = f.store.getSnapshot('s1').runs[0]!;
    assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'OUTPUT_LIMIT');
    assert.equal(summaries, 1); assert.equal(calls, summaryBytes === 3 ? 2 : 1);
    assert.equal(f.store.listTurns(run.id).length, 1);
    const visible = f.store.getSnapshot('s1').messages.filter(message => message.role === 'assistant').map(message => message.content).join('');
    assert.equal(Buffer.byteLength(visible), summaryBytes === 3 ? 1 : 0);
  });
});

test('profile allowlists are captured for schemas and execution even if a provider proposes an excluded tool', async t => {
  let effects = 0;
  const allowed = ['permitted'];
  const tool: ToolDefinition = { name: 'excluded', description: 'fixture', inputSchema: { type: 'object' }, effectClass: 'state', async prepare() { effects++; return { name: this.name, input: null, fingerprint: 'fixture', preview: {}, requiresApproval: false }; }, async execute() { effects++; return { content: 'must never run' }; } };
  const f = await fixture(t, { id: 'native', async *streamTurn(request) {
    assert.deepEqual(request.tools.map(tool => tool.name), []);
    if (request.turnIndex === 0) { allowed.push('excluded'); yield { type: 'tool.call', call: { id: 'proposal', name: 'excluded', input: null } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else { assert.match(request.messages.findLast(message => message.role === 'tool')!.content, /TOOL_NOT_ALLOWED/); yield stop; }
  } }, [tool], { agentProfileId: 'limited', agentProfileRevision: 'revision-1' }, { getAllowedTools: () => allowed });
  f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
  const run = f.store.getSnapshot('s1').runs[0]!; assert.equal(run.state, 'completed'); assert.equal(effects, 0); assert.equal(f.store.getSnapshot('s1').tools[0]!.state, 'denied');
});

test('checkpoint artifact mappings preserve immutable checkpoint state, hashes and partial evidence', async t => {
  for (const scenario of ['complete', 'partial', 'wrong-owner', 'cleanup-uncertain'] as const) await t.test(scenario, async nested => {
    const tool: ToolDefinition = { name: 'artifact_fixture', description: 'fixture', effectClass: 'state', inputSchema: { type: 'object' }, async prepare() { return { name: this.name, input: null, fingerprint: 'fixture', preview: {}, requiresApproval: false }; }, async execute(_prepared, context) {
      context.recordCheckpoint({ id: `checkpoint-${scenario}`, runId: context.runId, toolCallId: context.toolCallId, kind: 'command', createdAt: new Date().toISOString(), files: [], warnings: [], ...(scenario === 'partial' ? { incomplete: true } : {}) });
      const store = await ArtifactStore.open({ directory: join(context.artifactDir, 'artifact-fixture') });
      const item = await store.put({ identity: { sessionId: context.sessionId, runId: context.runId, toolCallId: scenario === 'wrong-owner' ? 'alien-tool' : context.toolCallId, turnId: context.turnId!, attemptId: context.attemptId! }, content: 'artifact bytes' });
      return { content: 'legacy', ...(scenario === 'cleanup-uncertain' ? { data: { cleanupConfirmed: false } } : {}), structuredResult: { displayContent: 'display', modelContent: 'model', warnings: [], artifactRefs: [item.reference], outcome: 'completed' } };
    } };
    const f = await fixture(nested, { id: 'native', async *streamTurn(request) { if (request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'proposal', name: tool.name, input: null } }; yield { type: 'finish', reason: 'tool_calls' }; } else yield stop; } }, [tool]);
    f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
    const snapshot = f.store.getSnapshot('s1'), run = snapshot.runs[0]!, checkpoints = f.store.listCheckpoints(run.id);
    assert.equal(checkpoints.length, 1); assert.equal(Boolean(checkpoints[0]!.incomplete), scenario === 'partial');
    const mappings = f.store.readEvents('s1', 0, 100).filter(event => event.type === 'checkpoint.artifacts');
    if (scenario === 'complete' || scenario === 'partial') {
      assert.equal(run.state, 'completed'); assert.equal(mappings.length, 1); assert.equal(mappings[0]!.payload.partial, scenario === 'partial');
      assert.equal(mappings[0]!.payload.toolCallId, snapshot.tools[0]!.id); assert.match(String((mappings[0]!.payload.artifacts as { sha256: string }[])[0]!.sha256), /^[a-f0-9]{64}$/);
      const message = snapshot.messages.find(message => message.role === 'tool')!;
      assert.equal(message.content, 'model'); assert.equal(message.toolResult!.outcome, 'completed'); assert.deepEqual(message.toolResult!.warnings, []);
      assert.equal(message.toolResult!.artifactRefs.length, 1); assert.equal(message.toolResult!.artifactRefs[0]!.identity.toolCallId, snapshot.tools[0]!.id);
      assert.equal(message.toolResult!.artifactRefs[0]!.sha256, (mappings[0]!.payload.artifacts as { sha256: string }[])[0]!.sha256);
    } else {
      assert.equal(mappings.length, 0);
      if (scenario === 'wrong-owner') assert.match(snapshot.tools[0]!.output!, /CHECKPOINT_ARTIFACT_MISMATCH/);
      else { assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); }
    }
  });
});

test('parent child reservations use measured usage, permanent caps and the real terminal cancellation signal', async t => {
  const release = gate(), started = gate(); t.after(release.resolve);
  let settled = false;
  const f = await fixture(t, { id: 'native', async *streamTurn() {
    try { yield { type: 'text.delta', delta: 'xy' }; yield { type: 'reasoning.delta', delta: 'zz' }; started.resolve(); await release.promise; yield { type: 'text.delta', delta: '!' }; yield stop; }
    finally { settled = true; }
  } }, [], { limits: { ...DEFAULT_LIMITS, maxTurns: 4, maxToolCalls: 4, maxOutputBytes: 16, maxDurationMs: 5000 } });
  const receipt = f.scheduler.accept(f.input('parent')); await started.promise;
  const runId = f.store.getInput(receipt.inputId).runId!;
  assert.deepEqual(f.coordinator.getRunUsage(runId), { turns: 1, toolCalls: 0, outputBytes: 4 });
  const allocation = { turns: 1, toolCalls: 2, outputBytes: 4, durationMs: 1000 };
  const reservation = f.coordinator.reserveChildRun(runId, allocation);
  assert.equal(f.coordinator.getRunCancellationSignal(runId), reservation.signal);
  assert.equal(reservation.signal.aborted, false); assert.equal(reservation.remainingBudget.turns, 3); assert.equal(reservation.remainingBudget.outputBytes, 12);
  allocation.outputBytes = 999; reservation.allocation.outputBytes = 888; reservation.remainingBudget.turns = 999;
  const remaining = f.coordinator.getRemainingChildBudget(runId);
  assert.equal(remaining.turns, 2); assert.equal(remaining.toolCalls, 2); assert.equal(remaining.outputBytes, 8); assert.ok(remaining.durationMs > 0 && remaining.durationMs <= 5000);
  assert.throws(() => f.coordinator.reserveChildRun(runId, { turns: 1, toolCalls: 3, outputBytes: 0, durationMs: 1000 }), error => error instanceof EngineError && error.code === 'CHILD_BUDGET_EXCEEDED');
  assert.equal(f.coordinator.getRemainingChildBudget(runId).toolCalls, 2);
  const second = f.coordinator.reserveChildRun(runId, { turns: 1, toolCalls: 0, outputBytes: 0, durationMs: 1000 });
  assert.equal(second.signal, reservation.signal);
  let terminalObserved = false;
  reservation.signal.addEventListener('abort', () => {
    assert.equal(settled, true); assert.equal(f.store.getRun(runId).state, 'completed');
    assert.equal(f.store.listTurns(runId).every(turn => turn.state === 'completed' && f.store.listParts(turn.id).every(part => part.state !== 'open')), true);
    assert.deepEqual(f.coordinator.getRunUsage(runId), { turns: 1, toolCalls: 0, outputBytes: 5 }); terminalObserved = true;
  }, { once: true });
  release.resolve(); await f.scheduler.waitForSession('s1');
  assert.equal(terminalObserved, true); assert.equal(reservation.signal.aborted, true);
  assert.deepEqual(f.coordinator.getRunUsage(runId), { turns: 1, toolCalls: 0, outputBytes: 5 });
  assert.throws(() => f.coordinator.reserveChildRun(runId, { turns: 1, toolCalls: 0, outputBytes: 0, durationMs: 1000 }), error => error instanceof EngineError && error.code === 'PARENT_RUN_NOT_ACTIVE');
  assert.throws(() => f.coordinator.getRunCancellationSignal(runId), error => error instanceof EngineError && error.code === 'PARENT_RUN_NOT_ACTIVE');
});

test('reserved child caps limit parent tools, next turns and streamed output before effects or redispatch', async t => {
  for (const cap of ['tools', 'turns', 'output'] as const) await t.test(cap, async nested => {
    const release = gate(), started = gate(); nested.after(release.resolve);
    let executions = 0, providerTurns = 0;
    const tool: ToolDefinition = { name: 'read_fixture', effectClass: 'read', description: 'fixture', inputSchema: { type: 'object' }, async prepare() { return { name: this.name, input: null, fingerprint: 'read', preview: {}, requiresApproval: false }; }, async execute() { executions++; return { content: '' }; } };
    const f = await fixture(nested, { id: 'native', async *streamTurn() {
      providerTurns++; if (cap === 'output') yield { type: 'text.delta', delta: 'a' };
      started.resolve(); await release.promise;
      if (cap === 'output') { yield { type: 'text.delta', delta: 'bcdef' }; yield stop; }
      else { yield { type: 'tool.call', call: { id: 'proposal', name: tool.name, input: null } }; yield { type: 'finish', reason: 'tool_calls' }; }
    } }, [tool], { limits: { ...DEFAULT_LIMITS, maxTurns: 2, maxToolCalls: cap === 'tools' ? 1 : 2, maxOutputBytes: 8, maxDurationMs: 5000 } });
    const receipt = f.scheduler.accept(f.input('parent')); await started.promise;
    const runId = f.store.getInput(receipt.inputId).runId!;
    const reservation = f.coordinator.reserveChildRun(runId, { turns: 1, toolCalls: cap === 'tools' ? 1 : 0, outputBytes: cap === 'output' ? 4 : 0, durationMs: 1000 });
    release.resolve(); await f.scheduler.waitForSession('s1');
    const run = f.store.getRun(runId); assert.equal(run.state, 'failed'); assert.equal(run.error!.code, cap === 'tools' ? 'TOOL_CALL_LIMIT' : cap === 'turns' ? 'TURN_LIMIT' : 'OUTPUT_LIMIT');
    assert.equal(providerTurns, 1); assert.equal(executions, cap === 'turns' ? 1 : 0); assert.equal(reservation.signal.aborted, true);
    assert.deepEqual(f.coordinator.getRunUsage(runId), { turns: 1, toolCalls: cap === 'turns' ? 1 : 0, outputBytes: cap === 'output' ? 4 : 0 });
    if (cap === 'output') assert.equal(f.store.getSnapshot('s1').messages.find(message => message.role === 'assistant')!.content, 'abcd');
  });
});

test('checkpoint observers run after tool settlement and cannot replace completed or uncertain tool outcomes', async t => {
  for (const behavior of ['completed', 'observer-failed', 'cleanup-uncertain'] as const) await t.test(behavior, async nested => {
    let settled = false, observations = 0;
    const tool: ToolDefinition = { name: 'checkpoint_fixture', effectClass: 'state', description: 'fixture', inputSchema: { type: 'object' }, async prepare() { return { name: this.name, input: null, fingerprint: 'checkpoint', preview: {}, requiresApproval: false }; }, async execute(_prepared, context) {
      try { context.recordCheckpoint({ id: 'checkpoint', runId: context.runId, toolCallId: context.toolCallId, kind: 'command', files: [], warnings: [], createdAt: new Date().toISOString() }); return { content: 'observed', ...(behavior === 'cleanup-uncertain' ? { data: { cleanupConfirmed: false } } : {}) }; }
      finally { settled = true; }
    } };
    const f = await fixture(nested, { id: 'native', async *streamTurn(request) { if (request.turnIndex === 0) { yield { type: 'tool.call', call: { id: 'proposal', name: tool.name, input: null } }; yield { type: 'finish', reason: 'tool_calls' }; } else yield stop; } }, [tool], {}, {
      onToolCheckpoint(observation) {
        observations++; assert.equal(settled, true); assert.equal(observation.run.sessionId, 's1'); assert.equal(observation.workspace.id, 'w1');
        assert.equal(observation.checkpoints[0]!.toolCallId, observation.toolCallId); assert.notEqual(observation.toolCallId, 'proposal'); assert.ok(observation.turnId); assert.ok(observation.attemptId);
        observation.checkpoints[0]!.warnings.push('mutated observer copy');
        if (behavior === 'observer-failed') throw new Error('observer fixture failed');
      },
    });
    f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
    const run = f.store.getSnapshot('s1').runs[0]!; assert.equal(observations, 1); assert.deepEqual(f.store.listCheckpoints(run.id)[0]!.warnings, []);
    assert.equal(run.state, behavior === 'cleanup-uncertain' ? 'failed' : 'completed');
    if (behavior === 'cleanup-uncertain') assert.equal(run.error!.code, 'CLEANUP_UNCERTAIN');
    assert.equal(f.store.readEvents('s1', 0, 100).filter(event => event.type === 'workspace.observation_failed').length, behavior === 'observer-failed' ? 1 : 0);
  });
});

test('provider-specific 529 retries occur only before any public stream event', async t => {
  for (const visible of [false, true]) await t.test(visible ? 'public prefix forbids retry' : 'rejection permits bounded retry', async nested => {
    let calls = 0;
    const f = await fixture(nested, { id: 'native', retryableHttpStatuses: [429, 500, 503, 504, 529], async *streamTurn() {
      if (++calls === 1) { if (visible) yield { type: 'text.delta', delta: 'prefix' }; throw new EngineError('PROVIDER_HTTP_ERROR', 'overloaded', { status: 529, retryAfterMs: 0 }); }
      yield { type: 'text.delta', delta: 'success' }; yield stop;
    } }, [], { budgets: normalizeEngineBudgets({ retryBaseDelayMs: 0 }) });
    f.scheduler.accept(f.input('first')); await f.scheduler.waitForSession('s1');
    const run = f.store.getSnapshot('s1').runs[0]!; assert.equal(run.state, visible ? 'failed' : 'completed'); assert.equal(calls, visible ? 1 : 2);
    assert.equal(f.store.listTurns(run.id).length, 1);
    assert.equal(f.store.readSessionEvents('s1', 0, 100).filter(event => event.type === 'provider.attempt.prepared').length, calls);
  });
});
