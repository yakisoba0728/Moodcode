import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { EngineError, type Run } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { exportEngineArchive, importEngineArchive } from '../storage/archive.js';
import { SqliteStore } from '../storage/index.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';

type Scope = 'active-run-prefix' | 'completed-history';
type SummaryObservation = { id: string; request: TurnRequest; source: string; text: string };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function untilAbort(signal: AbortSignal) { if (signal.aborted) return; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
const initialGoal = 'Exact initial lifecycle goal: retain local observations.';
const historicalGoal = 'Exact historical lifecycle goal.';
const laterGoal = 'Current original constraint must remain authoritative. '.repeat(155);
interface FixtureOptions {
  scope?: Scope; stopAfterSummaries?: number;
  summary?: (observed: SummaryObservation, index: number, signal: AbortSignal) => AsyncIterable<ProviderEvent>;
  beforeStart?: (fixture: Fixture) => void | Promise<void>;
  maxSummaryCalls?: number; maxOutputBytes?: number;
}
interface Fixture {
  root: string; dbPath: string; artifactDir: string; reader: DatabaseSync; engine: MoodcodeEngine; options: EngineOptions;
  scope: Scope; nonce: string; runId: string; oldRunId: string; done: Promise<Run>; main: TurnRequest[]; summaries: SummaryObservation[];
  fullReads(): number; reopen(): Promise<void>; pointer(): unknown;
}
function observation(request: TurnRequest): SummaryObservation {
  assert.ok(request.attemptId); assert.equal(request.turnId, undefined); assert.deepEqual(request.tools, []);
  const source = request.messages.findLast(message => message.role === 'user')!.content;
  const parsed = JSON.parse(source) as { messages?: { content: string }[] } | { content: string }[];
  const content = (Array.isArray(parsed) ? parsed : parsed.messages!).map(message => message.content).join('\n');
  const nonce = content.match(/SYNTHETIC_NONCE=([a-f0-9]{32})/u)?.[1] ?? request.messages.slice(1, -1).map(message => message.content.match(/historicalNonce["\s:]+([a-f0-9]{32})/u)?.[1]).find(Boolean) ?? null;
  assert.equal(source.includes('fixture-private-replay'), false);
  return { id: request.attemptId, request: structuredClone(request), source, text: JSON.stringify({ historicalObservation: true, currentFileEvidence: false, historicalNonce: nonce }) };
}
async function* success(observed: SummaryObservation): AsyncGenerator<ProviderEvent> {
  yield { type: 'progress', providerRequestId: 'synthetic-summary-request' };
  yield { type: 'usage', inputTokens: 10, outputTokens: 0, cachedInputTokens: 0 };
  yield { type: 'usage', inputTokens: 10, outputTokens: 0 };
  yield { type: 'text.delta', delta: observed.text };
  yield { type: 'usage', inputTokens: 15, outputTokens: 3, cachedInputTokens: 4, reasoningOutputTokens: 1 };
  yield { type: 'finish', reason: 'stop' };
  yield { type: 'usage', inputTokens: 15, outputTokens: 3 };
}
async function fixture(t: TestContext, opts: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-summary-lifecycle-'))), repository = join(root, 'repository'), dbPath = join(root, 'engine.sqlite'), artifactDir = join(root, 'artifacts');
  await mkdir(repository); const nonce = randomBytes(16).toString('hex'), scope = opts.scope ?? 'active-run-prefix';
  await writeFile(join(repository, 'observed-0.txt'), `SYNTHETIC_NONCE=${nonce}\nSynthetic original tool observation.\n`);
  for (let index = 1; index < 20; index++) await writeFile(join(repository, `observed-${index}.txt`), 'Synthetic bounded historical file observation. '.repeat(43));
  let f!: Fixture, fullReads = 0; const main: TurnRequest[] = [], summaries: SummaryObservation[] = [];
  const mainStream = async function* (request: TurnRequest): AsyncGenerator<ProviderEvent> {
    assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']); main.push(structuredClone(request));
    yield { type: 'usage', inputTokens: 7, outputTokens: 2, cachedInputTokens: 2, reasoningOutputTokens: 1 };
    yield { type: 'usage', inputTokens: 7, outputTokens: 2 };
    if (scope === 'completed-history') {
      yield { type: 'text.delta', delta: request.runId === f.oldRunId ? `SYNTHETIC_NONCE=${nonce}\n` + 'Synthetic historical discussion. '.repeat(285) : 'Finished bounded historical memory verification.' };
      yield { type: 'finish', reason: 'stop' }; return;
    }
    if (request.turnIndex >= 20 || summaries.length >= (opts.stopAfterSummaries ?? 32)) {
      yield { type: 'text.delta', delta: 'Finished bounded summary lifecycle verification.' }; yield { type: 'finish', reason: 'stop' }; return;
    }
    yield { type: 'tool.call', call: { id: `observed-${request.turnIndex}`, name: 'read_file', input: { path: `observed-${request.turnIndex}.txt` } } };
    yield { type: 'finish', reason: 'tool_calls', replayItems: [{ type: 'reasoning', encrypted_content: `fixture-private-replay-${request.turnIndex}` }] };
  };
  const provider: ProviderAdapter = { id: 'summary-lifecycle', replayProtocol: 'synthetic-responses-v1', streamTurn(request, signal) {
    if (request.tools.length) return mainStream(request);
    const observed = observation(request), index = summaries.length; summaries.push(observed);
    return opts.summary?.(observed, index, signal) ?? success(observed);
  } };
  const options: EngineOptions = { dbPath, artifactDir, providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxTurns: 32, maxToolCalls: 24, maxOutputBytes: opts.maxOutputBytes ?? 1_048_576, maxContextBytes: 16_384 },
      budgets: { turnAllowance: 32, maxSummaryCalls: opts.maxSummaryCalls ?? 32, maxSummaryBytes: 65_536 } },
    ...(scope === 'active-run-prefix' ? { activePrefixPolicy: { kind: 'active-prefix-semantic', version: 1, maxSourceMessages: 12, maxSourceBytes: 12_000, maxOutputBytes: 2048, keepRecentTurns: 4, maxCoveredMessages: 512 } } : {}),
  };
  const engine = createEngine(options), reader = new DatabaseSync(dbPath, { readOnly: true });
  t.after(async () => { try { await f.engine.close(); } finally { reader.close(); await rm(root, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt }); engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Summary lifecycle', createdAt });
  const trap = () => { f.engine.store.getSnapshot = () => { fullReads++; throw new Error('Summary lifecycle forbids whole session snapshots'); }; };
  f = { root, dbPath, artifactDir, reader, engine, options, scope, nonce, runId: '', oldRunId: '', done: undefined!, main, summaries, fullReads: () => fullReads,
    async reopen() { await f.engine.close(); f.engine = createEngine(options); trap(); },
    pointer() { return f.engine.store.getSessionDocument('session', scope === 'active-run-prefix' ? 'context.active_memory' : 'context.memory'); },
  }; trap(); await opts.beforeStart?.(f);
  if (scope === 'completed-history') {
    const prior = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'historical', prompt: historicalGoal, config: engine.getCapabilities().defaults }); f.oldRunId = prior.runId;
    assert.equal((await engine.waitForRun(prior.runId)).state, 'completed');
  }
  const current = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'primary', prompt: scope === 'active-run-prefix' ? initialGoal : laterGoal, config: engine.getCapabilities().defaults });
  f.runId = current.runId; f.done = engine.waitForRun(current.runId); return f;
}
async function enteredOrFinished(f: Fixture, entered: ReturnType<typeof deferred>) { await Promise.race([entered.promise, f.done.then(run => assert.fail(`Run ended before held summary: ${run.state}/${run.error?.code}`))]); }
function originalMessages(f: Fixture): string[] { return f.reader.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal LIMIT 64').all(f.runId).map(row => String(row.data)); }
function eventCount(f: Fixture, journal: 'events' | 'session_events', type: string, summaryId: string, inputTokens?: number): number {
  return Number(f.reader.prepare(`SELECT count(*) AS count FROM ${journal} WHERE run_id=? AND type=? AND json_extract(data,'$.payload.summaryAttemptId')=? AND (? IS NULL OR json_extract(data,'$.payload.inputTokens')=?)`).get(f.runId, type, summaryId, inputTokens ?? null, inputTokens ?? null)!.count);
}

for (const scope of ['active-run-prefix', 'completed-history'] as const) test(`actual ${scope} summary has a durable completion receipt and deduplicated inclusive usage separate from ordinary attempts`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { scope, stopAfterSummaries: 1 }), run = await f.done;
  assert.equal(run.state, 'completed', JSON.stringify(run.error)); assert.equal(f.summaries.length, 1); assert.equal(f.fullReads(), 0);
  const observed = f.summaries[0]!, attempt = f.engine.store.getSummaryAttempt(observed.id), usage = f.engine.store.getSummaryUsage(observed.id);
  assert.equal(attempt.state, 'completed'); assert.equal(attempt.scope, scope); assert.equal(attempt.sessionId, 'session'); assert.equal(attempt.runId, f.runId);
  assert.equal(attempt.workspaceId, 'workspace'); assert.equal(attempt.providerId, 'summary-lifecycle'); assert.equal(attempt.modelId, 'fixture-model');
  assert.equal(attempt.cleanupConfirmed, true); assert.ok(attempt.providerCompletedAt); assert.ok(attempt.completedAt);
  assert.equal(attempt.observedOutputBytes, Buffer.byteLength(observed.text)); assert.equal(attempt.retainedTextBytes, Buffer.byteLength(observed.text));
  assert.equal(attempt.partialText, observed.text); assert.equal(attempt.partialTextTruncated, false); assert.equal(attempt.publication, 'activated');
  assert.equal(attempt.sourceSha256, hash(observed.source)); assert.equal(attempt.requestSha256, hash(JSON.stringify(observed.request))); assert.equal(attempt.requestBytes, Buffer.byteLength(JSON.stringify(observed.request)));
  assert.equal(attempt.sourceProjection, scope === 'active-run-prefix' ? 'text-and-complete-tool-observations-v1' : 'conversation-text-v1');
  assert.ok(attempt.sourceMessageIds!.length > 0); assert.equal(JSON.stringify(attempt).includes('fixture-private-replay'), false);
  assert.ok(usage); assert.deepEqual(usage.usage, { inputTokens: 15, outputTokens: 3, cachedInputTokens: 4, reasoningOutputTokens: 1 });
  assert.equal(f.engine.store.getSummaryAttempt(observed.id, 'session').id, observed.id);
  assert.throws(() => f.engine.store.getSummaryAttempt(observed.id, 'another-session'), (error: unknown) => error instanceof EngineError && error.code === 'SUMMARY_BINDING_MISMATCH');
  assert.throws(() => f.engine.store.getSummaryUsage(observed.id, 'another-session'), (error: unknown) => error instanceof EngineError && error.code === 'SUMMARY_BINDING_MISMATCH');
  assert.deepEqual(f.engine.store.observeSummaryAttempt(observed.id, { usage: { inputTokens: 15 } }), attempt);
  assert.throws(() => f.engine.store.observeSummaryAttempt(observed.id, { usage: { inputTokens: 16 } }), (error: unknown) => error instanceof EngineError && error.code === 'SUMMARY_ATTEMPT_IMMUTABLE');
  assert.throws(() => f.engine.store.getAttempt(observed.id), (error: unknown) => error instanceof EngineError && error.code === 'ATTEMPT_NOT_FOUND');
  const metrics = f.engine.store.getNativeMetrics('session');
  assert.equal(metrics.attempts.total, f.main.length); assert.equal(metrics.attemptUsage.inputTokens.tokens, f.main.length * 7); assert.equal(metrics.attemptUsage.outputTokens.tokens, f.main.length * 2);
  assert.equal(metrics.summaryAttempts.total, 1); assert.equal(metrics.summaryAttempts.states.completed, 1); assert.equal(metrics.summaryAttempts.scopes[scope], 1);
  assert.equal(metrics.summaryAttemptUsage.inputTokens.tokens, 15); assert.equal(metrics.summaryAttemptUsage.outputTokens.tokens, 3); assert.equal(metrics.summaryAttemptUsage.cachedInputTokens.tokens, 4);
  assert.equal(metrics.summaryAttemptUsage.reasoningOutputTokens.tokens, 1); assert.equal(metrics.summaryAttemptUsage.billedTokens, null); assert.equal(metrics.attemptUsage.billedTokens, null);
  const typedBefore = structuredClone(attempt), usageBefore = structuredClone(usage), raw = originalMessages(f), mainCalls = f.main.length, summaryCalls = f.summaries.length;
  await f.reopen(); assert.deepEqual(f.engine.store.getSummaryAttempt(observed.id), typedBefore); assert.deepEqual(f.engine.store.getSummaryUsage(observed.id), usageBefore);
  assert.deepEqual(originalMessages(f), raw); assert.equal(f.main.length, mainCalls); assert.equal(f.summaries.length, summaryCalls);
  const duplicate = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: scope === 'active-run-prefix' ? initialGoal : laterGoal, config: run.config });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, f.runId); assert.equal(f.summaries.length, summaryCalls); assert.equal(f.main.length, mainCalls);
});

for (const scope of ['active-run-prefix', 'completed-history'] as const) test(`actual ${scope} partial usage survives a decreasing snapshot rejection and never publishes memory`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { scope, stopAfterSummaries: 1, summary: async function* () {
    yield { type: 'usage', inputTokens: 11, outputTokens: 0, cachedInputTokens: 0 };
    yield { type: 'text.delta', delta: 'Partial observation.' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 1 };
  } });
  assert.equal((await f.done).state, 'completed'); assert.equal(f.summaries.length, 1); assert.equal(f.fullReads(), 0);
  const id = f.summaries[0]!.id, attempt = f.engine.store.getSummaryAttempt(id), usage = f.engine.store.getSummaryUsage(id);
  assert.equal(attempt.state, 'failed'); assert.equal(attempt.errorCode, 'SUMMARY_PROTOCOL_ERROR'); assert.equal(attempt.cleanupConfirmed, true); assert.equal(f.pointer(), null);
  assert.ok(usage); assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: null });
  assert.equal(attempt.observedOutputBytes, Buffer.byteLength('Partial observation.')); assert.equal(f.engine.store.getNativeMetrics('session').summaryAttemptUsage.reasoningOutputTokens.tokens, null);
  assert.equal(f.engine.store.getNativeMetrics('session').summaryAttempts.states.completed, 0);
});

test('actual transport failure preserves partial nullable summary usage and charged text without automatic summary retry', { timeout: 30000 }, async t => {
  const f = await fixture(t, { stopAfterSummaries: 1, summary: async function* () {
    yield { type: 'usage', inputTokens: 9 }; yield { type: 'text.delta', delta: 'Partial observed text.' };
    throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic summary transport stopped after partial observations');
  } });
  assert.equal((await f.done).state, 'completed'); assert.equal(f.summaries.length, 1); assert.equal(f.pointer(), null);
  const id = f.summaries[0]!.id, attempt = f.engine.store.getSummaryAttempt(id), usage = f.engine.store.getSummaryUsage(id)!;
  assert.equal(attempt.state, 'failed'); assert.equal(attempt.cleanupConfirmed, true);
  assert.deepEqual(usage.usage, { inputTokens: 9, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null });
  assert.equal(attempt.observedOutputBytes, Buffer.byteLength('Partial observed text.')); assert.ok(f.engine.coordinator.getRunUsage(f.runId).outputBytes >= attempt.observedOutputBytes);
  assert.equal(f.fullReads(), 0);
});

test('actual adapter lacking underlying return cannot turn partial transport failure into confirmed cleanup', { timeout: 30000 }, async t => {
  const f = await fixture(t, { stopAfterSummaries: 1, summary: () => {
    let index = 0; return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> {
      if (index++ === 0) return { done: false, value: { type: 'usage', inputTokens: 9, outputTokens: 0 } };
      throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic non-generator iterator has no cleanup proof');
    } }; } };
  } });
  const run = await f.done; assert.equal(run.error?.code, 'CLEANUP_UNCERTAIN'); assert.equal(f.summaries.length, 1); assert.equal(f.pointer(), null);
  const attempt = f.engine.store.getSummaryAttempt(f.summaries[0]!.id); assert.equal(attempt.state, 'uncertain'); assert.equal(attempt.cleanupConfirmed, false);
  assert.equal(f.engine.store.getSummaryUsage(attempt.id)!.usage.inputTokens, 9); assert.equal(f.fullReads(), 0);
});

test('actual cancellation settles a held summary after its terminal Run and preserves the prior checkpoint and exact receipt', { timeout: 30000 }, async t => {
  const entered = deferred();
  const f = await fixture(t, { summary: async function* (observed, index, signal) {
    if (index === 0) { yield* success(observed); return; }
    yield { type: 'usage', inputTokens: 12, outputTokens: 0 }; yield { type: 'text.delta', delta: 'Interrupted partial memory.' };
    entered.resolve(); await untilAbort(signal);
  } });
  await enteredOrFinished(f, entered); const prior = structuredClone(f.pointer()), held = f.summaries[1]!, sourceBefore = f.engine.store.getSummaryAttempt(held.id), raw = originalMessages(f), nativeTurns = f.engine.store.listTurns(f.runId).length;
  assert.ok(prior); assert.equal(sourceBefore.state, 'streaming');
  f.engine.coordinator.cancel(f.runId); assert.equal((await f.done).state, 'cancelled');
  const terminal = f.engine.store.getSummaryAttempt(held.id); assert.equal(terminal.state, 'interrupted'); assert.equal(terminal.cleanupConfirmed, true); assert.deepEqual(f.pointer(), prior);
  assert.deepEqual(originalMessages(f), raw); assert.equal(f.engine.store.listTurns(f.runId).length, nativeTurns); assert.equal(f.engine.store.getSummaryUsage(held.id)!.usage.inputTokens, 12);
  const calls = f.summaries.length, mainCalls = f.main.length; await f.reopen(); assert.deepEqual(f.engine.store.getSummaryAttempt(held.id), terminal);
  const duplicate = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: initialGoal, config: f.engine.store.getRun(f.runId).config });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, f.runId); assert.equal(f.summaries.length, calls); assert.equal(f.main.length, mainCalls); assert.equal(f.fullReads(), 0);
});

test('actual close joins held completed-history summary cleanup before releasing storage and records interruption without activation', { timeout: 30000 }, async t => {
  const entered = deferred(), cleanupEntered = deferred(), cleanupRelease = deferred(); t.after(cleanupRelease.resolve);
  const f = await fixture(t, { scope: 'completed-history', summary: async function* (_observed, _index, signal) {
    try { yield { type: 'usage', inputTokens: 8, outputTokens: 0 }; yield { type: 'text.delta', delta: 'Held partial history.' }; entered.resolve(); await untilAbort(signal); }
    finally { cleanupEntered.resolve(); await cleanupRelease.promise; }
  } });
  await enteredOrFinished(f, entered); const id = f.summaries[0]!.id, raw = originalMessages(f), baseline = f.pointer(); let closed = false;
  const closing = f.engine.close().then(() => { closed = true; }); await cleanupEntered.promise; await tick();
  assert.equal(closed, false); assert.equal(f.engine.store.getSummaryAttempt(id).state, 'streaming'); assert.deepEqual(f.pointer(), baseline);
  cleanupRelease.resolve(); await closing; const calls = f.summaries.length, mainCalls = f.main.length;
  f.engine = createEngine(f.options); f.engine.store.getSnapshot = () => { throw new Error('Reopened summary fixture forbids full snapshots'); };
  assert.equal(f.engine.store.getSummaryAttempt(id).state, 'interrupted'); assert.equal(f.engine.store.getSummaryAttempt(id).cleanupConfirmed, true);
  assert.equal(f.engine.store.getSummaryUsage(id)!.usage.inputTokens, 8); assert.deepEqual(f.pointer(), baseline); assert.deepEqual(originalMessages(f), raw);
  assert.equal(f.summaries.length, calls); assert.equal(f.main.length, mainCalls); assert.equal(f.fullReads(), 0);
});

for (const journal of ['session_events', 'events'] as const) test(`actual late ${journal} summary activation failure rolls back typed completion and both pointers/revisions`, { timeout: 30000 }, async t => {
  let writer: DatabaseSync | undefined, candidateRevisionId = ''; t.after(() => writer?.close());
  const f = await fixture(t, { stopAfterSummaries: 1, beforeStart: owned => {
    writer = new DatabaseSync(owned.dbPath);
    writer.exec(`CREATE TRIGGER reject_summary_publish BEFORE INSERT ON ${journal} WHEN NEW.type='summary.completed' BEGIN SELECT RAISE(ABORT,'synthetic summary publish rejected'); END`);
    const publish = owned.engine.store.commitActivePrefixCheckpoint.bind(owned.engine.store);
    owned.engine.store.commitActivePrefixCheckpoint = (runId, payload, change) => { candidateRevisionId = change.contextRevision.id; return publish(runId, payload, change); };
  } });
  const run = await f.done; assert.ok(['completed', 'failed'].includes(run.state)); assert.equal(f.summaries.length, 1); assert.equal(f.pointer(), null);
  const id = f.summaries[0]!.id, attempt = f.engine.store.getSummaryAttempt(id); assert.notEqual(attempt.state, 'completed'); assert.ok(['failed', 'uncertain'].includes(attempt.state));
  assert.equal(f.reader.prepare("SELECT count(*) AS count FROM context_revisions WHERE run_id=? AND json_extract(data,'$.kind')='summary'").get(f.runId)!.count, 0);
  assert.ok(candidateRevisionId); assert.equal(f.reader.prepare('SELECT count(*) AS count FROM context_revisions WHERE id=?').get(candidateRevisionId)!.count, 0);
  assert.equal(eventCount(f, 'events', 'summary.completed', id), 0); assert.equal(eventCount(f, 'session_events', 'summary.completed', id), 0);
  assert.equal(f.engine.store.getSummaryUsage(id)!.usage.inputTokens, 15); assert.equal(f.fullReads(), 0);
});

for (const journal of ['session_events', 'events'] as const) test(`actual ${journal} failure rolls back a new summary usage snapshot without losing the previous observation`, { timeout: 30000 }, async t => {
  let writer: DatabaseSync | undefined; t.after(() => writer?.close());
  const f = await fixture(t, { stopAfterSummaries: 1, beforeStart: owned => {
    writer = new DatabaseSync(owned.dbPath);
    writer.exec(`CREATE TRIGGER reject_summary_usage BEFORE INSERT ON ${journal} WHEN NEW.type='provider.usage' AND json_extract(NEW.data,'$.payload.purpose')='summary' AND json_extract(NEW.data,'$.payload.inputTokens')=15 BEGIN SELECT RAISE(ABORT,'synthetic usage journal rejected'); END`);
  } });
  const run = await f.done; assert.ok(['completed', 'failed'].includes(run.state)); assert.equal(f.summaries.length, 1); assert.equal(f.pointer(), null);
  const id = f.summaries[0]!.id, attempt = f.engine.store.getSummaryAttempt(id); assert.equal(attempt.state, 'failed'); assert.equal(attempt.cleanupConfirmed, true);
  assert.deepEqual(f.engine.store.getSummaryUsage(id)!.usage, { inputTokens: 10, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: null });
  assert.equal(attempt.partialText, f.summaries[0]!.text);
  for (const journal of ['events', 'session_events'] as const) {
    assert.equal(eventCount(f, journal, 'provider.usage', id, 15), 0); assert.equal(eventCount(f, journal, 'provider.usage', id, 10), 1);
  }
  assert.equal(f.fullReads(), 0);
});

test('actual local summary overflow retains observed partial bytes and usage while sharing the Run output budget', { timeout: 30000 }, async t => {
  const text = 'X'.repeat(2049), f = await fixture(t, { stopAfterSummaries: 1, summary: async function* () {
    yield { type: 'usage', inputTokens: 9, outputTokens: 0 }; yield { type: 'text.delta', delta: text }; yield { type: 'finish', reason: 'stop' };
  } });
  assert.equal((await f.done).state, 'completed'); assert.equal(f.summaries.length, 1); assert.equal(f.pointer(), null);
  const attempt = f.engine.store.getSummaryAttempt(f.summaries[0]!.id); assert.equal(attempt.state, 'failed'); assert.equal(attempt.errorCode, 'SUMMARY_OUTPUT_LIMIT');
  assert.equal(attempt.observedOutputBytes, 2049); assert.equal(attempt.retainedTextBytes, 2049); assert.equal(attempt.partialText, text); assert.equal(attempt.partialTextTruncated, false);
  assert.ok(f.engine.coordinator.getRunUsage(f.runId).outputBytes >= 2049); assert.equal(f.engine.store.getSummaryUsage(attempt.id)!.usage.outputTokens, 0);
  assert.equal(f.engine.store.getNativeMetrics('session').attempts.total, f.main.length); assert.equal(f.fullReads(), 0);
});

test('actual shared Run output rejection retains a bounded partial prefix and honest truncation metadata', { timeout: 30000 }, async t => {
  const text = 'X'.repeat(65_537), f = await fixture(t, { stopAfterSummaries: 1, maxOutputBytes: 12_000, summary: async function* () {
    yield { type: 'usage', inputTokens: 9 }; yield { type: 'text.delta', delta: text };
  } });
  const run = await f.done; assert.ok(['completed', 'failed'].includes(run.state)); assert.equal(f.summaries.length, 1); assert.equal(f.pointer(), null);
  const attempt = f.engine.store.getSummaryAttempt(f.summaries[0]!.id); assert.equal(attempt.state, 'failed'); assert.equal(attempt.errorCode, 'OUTPUT_LIMIT'); assert.equal(attempt.cleanupConfirmed, true);
  assert.equal(attempt.observedOutputBytes, 65_537); assert.equal(attempt.retainedTextBytes, 65_536); assert.equal(attempt.partialText, text.slice(0, 65_536)); assert.equal(attempt.partialTextTruncated, true);
  assert.ok(f.engine.coordinator.getRunUsage(f.runId).outputBytes <= 12_000); assert.equal(f.engine.store.getNativeMetrics('session').summaryAttempts.truncatedPartialTexts, 1);
  assert.deepEqual(f.engine.store.getSummaryUsage(attempt.id)!.usage, { inputTokens: 9, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null }); assert.equal(f.fullReads(), 0);
});

test('actual shared summary call allowance stops subsequent summarizers without adding ordinary Turns or attempts', { timeout: 30000 }, async t => {
  const f = await fixture(t, { maxSummaryCalls: 1 }), run = await f.done; assert.ok(['completed', 'failed'].includes(run.state)); assert.equal(f.summaries.length, 1);
  const metrics = f.engine.store.getNativeMetrics('session'); assert.equal(metrics.summaryAttempts.total, 1); assert.equal(metrics.summaryAttempts.states.completed, 1);
  assert.equal(metrics.attempts.total, f.main.length); assert.ok(metrics.turns.total >= f.main.length && metrics.turns.total <= f.main.length + 1); assert.ok(f.main.length > 4 && f.main.length <= 21);
  if (run.state === 'failed') assert.ok(['CONTEXT_LIMIT', 'CONTEXT_REQUIRED_BLOCKS_EXCEED_BUDGET', 'CONTEXT_BUDGET_EXCEEDED'].includes(run.error!.code), JSON.stringify(run.error));
  assert.equal(f.fullReads(), 0);
});

test('actual completed summary owner, exact source receipt and nullable usage survive archive import without dispatch', { timeout: 30000 }, async t => {
  const f = await fixture(t, { stopAfterSummaries: 1 }); assert.equal((await f.done).state, 'completed'); const id = f.summaries[0]!.id;
  const attempt = f.engine.store.getSummaryAttempt(id), usage = f.engine.store.getSummaryUsage(id), pointer = f.pointer(), raw = originalMessages(f), mainCalls = f.main.length, summaryCalls = f.summaries.length;
  await f.engine.close(); const archive = await exportEngineArchive({ dbPath: f.dbPath, artifactDir: f.artifactDir, destination: join(f.root, 'archive') });
  assert.equal(archive.manifest.databases.find(database => database.role === 'primary')!.schemaVersion, 4);
  const imported = await importEngineArchive({ directory: archive.directory, destination: join(f.root, 'restored') });
  assert.equal(imported.schemaVersion, 4); assert.equal(imported.executionResumed, false);
  const restored = createEngine({ ...f.options, dbPath: imported.dbPath, artifactDir: imported.artifactDir }); t.after(() => restored.close());
  restored.store.getSnapshot = () => { throw new Error('Restored summary fixture forbids whole snapshots'); };
  assert.deepEqual(restored.store.getSummaryAttempt(id, 'session'), attempt); assert.deepEqual(restored.store.getSummaryUsage(id, 'session'), usage);
  assert.deepEqual(restored.store.getSessionDocument('session', 'context.active_memory'), pointer); assert.equal(restored.store.getSessionControl('session').paused, true);
  const read = new DatabaseSync(imported.dbPath, { readOnly: true });
  try { assert.deepEqual(read.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal LIMIT 64').all(f.runId).map(row => String(row.data)), raw); } finally { read.close(); }
  await tick(); const duplicate = restored.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: initialGoal, config: restored.store.getRun(f.runId).config });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, f.runId); assert.equal(f.main.length, mainCalls); assert.equal(f.summaries.length, summaryCalls); assert.equal(f.fullReads(), 0);
});

type CrashPhase = 'prepared' | 'dispatched' | 'provider-complete';
interface CrashReady { phase: CrashPhase; sessionId: string; runId: string; summaryAttemptId: string }
async function launchCrash(t: TestContext, directory: string, phase: CrashPhase) {
  const source = import.meta.url.endsWith('.ts'), extension = source ? 'ts' : import.meta.url.endsWith('.mjs') ? 'mjs' : 'js';
  const path = fileURLToPath(new URL(`./fixtures/summary-lifecycle-child.${extension}`, import.meta.url));
  const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), path, directory, phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8192); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = await new Promise<CrashReady>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Summary child did not reach ${phase}: ${diagnostics}`)), 12000);
    child.once('message', message => { clearTimeout(timer); resolve(message as CrashReady); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Summary child exited before ${phase}: ${diagnostics}`)); });
  });
  assert.equal(ready.phase, phase); assert.equal(ready.sessionId, 'session'); assert.ok(ready.runId); return { child, ready, exited };
}

for (const phase of ['prepared', 'dispatched', 'provider-complete'] as const) test(`actual SIGKILL after durable summary ${phase} preserves the receipt and recovers without retry or activation`, { timeout: 30000, skip: process.platform === 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), `moodcode-summary-crash-${phase}-`))), dbPath = join(root, 'engine.sqlite');
  t.after(() => rm(root, { recursive: true, force: true })); const { child, ready, exited } = await launchCrash(t, root, phase);
  assert.throws(() => new SqliteStore(dbPath), (error: unknown) => error instanceof EngineError && error.code === 'DB_LOCKED');
  const read = new DatabaseSync(dbPath, { readOnly: true });
  const before = JSON.parse(String(read.prepare('SELECT data FROM summary_attempts WHERE id=?').get(ready.summaryAttemptId)!.data)) as ReturnType<SqliteStore['getSummaryAttempt']>;
  const raw = read.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal LIMIT 64').all(ready.runId).map(row => String(row.data));
  const ordinaryCount = read.prepare('SELECT count(*) AS count FROM provider_attempts WHERE run_id=?').get(ready.runId)!.count;
  read.close(); assert.equal(before.state, phase === 'prepared' ? 'prepared' : phase === 'dispatched' ? 'dispatched' : 'streaming');
  assert.equal(before.publication, 'pending'); assert.match(before.sourceSha256, /^[a-f0-9]{64}$/u); assert.match(before.requestSha256, /^[a-f0-9]{64}$/u);
  child.kill('SIGKILL'); await exited; const callsPath = join(root, 'provider-calls.log'), calls = await readFile(callsPath, 'utf8');
  assert.equal(calls.split('\n').filter(call => call === 'summary').length, phase === 'provider-complete' ? 1 : 0);
  let unexpectedCalls = 0; const provider: ProviderAdapter = { id: 'summary-crash', async *streamTurn() { unexpectedCalls++; yield { type: 'finish', reason: 'stop' }; } };
  const options: EngineOptions = { dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'] };
  let engine = createEngine(options); t.after(() => engine.close()); engine.store.getSnapshot = () => { throw new Error('Recovered summary forbids whole snapshots'); };
  await tick(); const recovered = engine.store.getSummaryAttempt(ready.summaryAttemptId, 'session');
  assert.equal(recovered.state, phase === 'dispatched' ? 'uncertain' : 'interrupted'); assert.equal(recovered.cleanupConfirmed, phase !== 'dispatched');
  assert.equal(recovered.sourceSha256, before.sourceSha256); assert.equal(recovered.requestSha256, before.requestSha256); assert.deepEqual(recovered.sourceMessageIds, before.sourceMessageIds);
  assert.equal(recovered.partialText, before.partialText); assert.equal(recovered.observedOutputBytes, before.observedOutputBytes); assert.equal(recovered.publication, 'discarded');
  assert.equal(engine.store.getRun(ready.runId).state, 'interrupted'); assert.equal(engine.store.getSessionControl('session').paused, true); assert.equal(engine.store.getSessionDocument('session', 'context.active_memory'), null);
  const usage = engine.store.getSummaryUsage(ready.summaryAttemptId); if (phase === 'provider-complete') assert.deepEqual(usage!.usage, { inputTokens: 17, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: null }); else assert.equal(usage, null);
  assert.equal(engine.store.getNativeMetrics('session').attempts.total, Number(ordinaryCount)); assert.equal(unexpectedCalls, 0);
  const verify = new DatabaseSync(dbPath, { readOnly: true });
  try { assert.deepEqual(verify.prepare('SELECT data FROM messages WHERE run_id=? ORDER BY ordinal LIMIT 64').all(ready.runId).map(row => String(row.data)), raw); } finally { verify.close(); }
  const duplicate = engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: 'Exact original crash goal.', config: engine.store.getRun(ready.runId).config });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, ready.runId); assert.equal(unexpectedCalls, 0); assert.equal(await readFile(callsPath, 'utf8'), calls);
  const settled = structuredClone(recovered), observedUsage = structuredClone(usage); await engine.close(); engine = createEngine(options); engine.store.getSnapshot = () => { throw new Error('Second restart forbids whole snapshots'); };
  assert.deepEqual(engine.store.getSummaryAttempt(ready.summaryAttemptId), settled); assert.deepEqual(engine.store.getSummaryUsage(ready.summaryAttemptId), observedUsage); assert.equal(unexpectedCalls, 0);
});
