import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, EngineError, type RunConfig } from '@moodcode/contracts';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';
import { BudgetAccount } from '../config/budgets.js';
import { LspManager } from '../lsp/index.js';
import type { ContextRequest, ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { RepositoryContextService } from '../repository/index.js';
import { TurnExecutor } from '../runner/turn-executor.js';
import { SqliteStore } from '../storage/index.js';
import { runGit } from '../workspace/git.js';
import { planContext } from './plan.js';
import { ContextService } from './service.js';
import { repositoryContextPolicy, RepositoryContextSource, type ContextSourcePort } from './repository-contributions.js';

const signal = () => new AbortController().signal;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorCode = (expected: string) => (error: unknown) => { assert.equal((error as { code?: string }).code, expected); return true; };
const stop: ProviderEvent = { type: 'finish', reason: 'stop' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function collect(stream: AsyncIterable<ProviderEvent>) { for await (const _ of stream) { /* Finish the actual native iterator. */ } }
async function wait<T>(operation: () => Promise<T>, abort: AbortSignal): Promise<T> {
  if (abort.aborted) throw abort.reason;
  let cancelled!: () => void;
  const cancellation = new Promise<never>((_, reject) => { cancelled = () => reject(abort.reason); abort.addEventListener('abort', cancelled, { once: true }); });
  try { return await Promise.race([operation(), cancellation]); } finally { abort.removeEventListener('abort', cancelled); }
}
async function fixture(t: test.TestContext, options: { limit?: number; prompt?: string; source?: (source: RepositoryContextSource) => ContextSourcePort } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-repository-context-wiring-')));
  await runGit(root, ['init', '-q']); await writeFile(join(root, 'source.ts'), 'export const authored = "local evidence";\n');
  const store = new SqliteStore(':memory:'), lsp = new LspManager();
  const workspace = store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() });
  store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Repository context wiring', createdAt: new Date().toISOString() });
  const config: RunConfig = { providerId: 'fixture', modelId: 'model', mode: 'build', limits: { ...DEFAULT_LIMITS, ...(options.limit ? { maxContextBytes: options.limit } : {}) }, budgets: normalizeEngineBudgets({ retryBaseDelayMs: 0 }) };
  const receipt = store.admit({ sessionId: 'session', requestId: 'request', prompt: options.prompt ?? 'Preserve the exact current user goal 한글😀', config });
  store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  const run = store.getRun(receipt.runId);
  const source = new RepositoryContextSource(new RepositoryContextService(lsp, () => null));
  const hostPolicy = { query: { kind: 'symbols' as const, paths: ['source.ts'] }, slotBytes: 16_384,
    exactRanges: [{ path: 'source.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 39 } } }] };
  const service = new ContextService(store, undefined, 32, undefined, { repositoryContext: { source: options.source?.(source) ?? source, policy: hostPolicy } });
  const request = (): ContextRequest => ({ workspace, snapshot: service.snapshot('session', config), config, signal: signal(), run, reservedBytes: 64 });
  const executor = (freshness: (request: TurnRequest, signal: AbortSignal) => Promise<void>) => {
    const account = new BudgetAccount(config); account.startTurn();
    return new TurnExecutor({ run, index: 0, inputIds: [run.inputId], budget: account, store, wait,
      contextRevisionId: service.revisionId('session'), currentContextRevisionId: () => service.revisionId('session'), assertContextFresh: freshness });
  };
  t.after(async () => { await lsp.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, store, source, hostPolicy, service, config, run, request, executor };
}
test('actual ContextService merges repository evidence, recalculates its plan and persists hash-only diagnostics and source provenance', async t => {
  const f = await fixture(t), input = f.request(), messages = await f.service.build(input);
  assert.ok(messages.some(message => message.content.includes('local evidence')));
  assert.equal(messages.at(-1)?.role, 'user'); assert.equal(messages.at(-1)?.content, f.run.prompt);
  const diagnostics = f.service.diagnostics('session')!;
  assert.equal(diagnostics.plan.sha256, sha(messages));
  assert.equal(diagnostics.plan.bytes, Buffer.byteLength(JSON.stringify(messages)) + 64);
  assert.equal(diagnostics.plan.reservations.envelopeBytes, 64);
  assert.ok(diagnostics.plan.reservations.repositoryBytes! > 0);
  assert.equal(diagnostics.repositoryContext?.inputEstimate.tokens, null);
  assert.equal(diagnostics.repositoryContext?.snippets[0]?.selectionReason, 'host-exact-range');
  assert.equal('text' in diagnostics.repositoryContext!.snippets[0]!, false);
  assert.equal('messages' in diagnostics.repositoryContext!, false);
  assert.ok(!JSON.stringify(diagnostics.repositoryContext).includes('local evidence'));
  const revision = f.store.getLatestContextRevision('session')!;
  assert.equal(revision.sha256, sha(messages)); assert.ok(revision.sourceIds.some(id => id.startsWith('repository-source:source.ts:')));
  assert.ok(revision.sourceIds.includes('repository-generation:' + diagnostics.repositoryContext!.generation));
  assert.equal(revision.text, JSON.stringify(messages));
  await f.service.assertFresh('session', structuredClone(messages), signal(), f.run.id);
  const changed = structuredClone(messages); changed.at(-1)!.content += 'altered';
  await assert.rejects(f.service.assertFresh('session', changed, signal(), f.run.id), errorCode('REPOSITORY_CONTEXT_STALE'));
  await assert.rejects(f.service.assertFresh('session', messages, signal(), 'other-run'), errorCode('REPOSITORY_CONTEXT_STALE'));
  f.service.releaseRepositoryContext('session', 'other-run'); await f.service.assertFresh('session', messages, signal(), f.run.id);
  f.service.releaseRepositoryContext('session', f.run.id);
  await assert.rejects(f.service.assertFresh('session', messages, signal(), f.run.id), errorCode('REPOSITORY_CONTEXT_STALE'));
});
test('a tight actual ContextService preserves the mandatory current exchange and explicitly omits optional evidence', async t => {
  const f = await fixture(t, { limit: 512 });
  const messages = await f.service.build(f.request());
  assert.equal(messages.at(-1)?.content, f.run.prompt);
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) + 64 <= 512);
  const diagnostics = f.service.diagnostics('session')!;
  assert.equal(diagnostics.repositoryContext?.omissions.message, true);
  assert.equal(diagnostics.repositoryContext?.omissions.contextBudget, 1);
  assert.equal('messages' in diagnostics.repositoryContext!, false);
  await f.service.assertFresh('session', messages, signal(), f.run.id);
});
test('a large required input reserves its actual complete transcript before one optional evidence prepare', async t => {
  const reservations: number[] = [];
  const f = await fixture(t, { limit: 6600, prompt: 'required anchor '.repeat(380), source: source => ({
    prepare: request => { reservations.push(request.budget.requiredMessagesBytes); return source.prepare(request); }, assertFresh: (...args) => source.assertFresh(...args),
  }) });
  const required = await planContext(f.request(), { outputTokens: 32, requiredOnly: true });
  const messages = await f.service.build(f.request());
  assert.deepEqual(reservations, [required.bytes - 64]);
  assert.ok(reservations[0]! > Buffer.byteLength(f.run.prompt));
  assert.equal(messages.at(-1)?.content, f.run.prompt);
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) + 64 <= 6600);
  assert.equal(f.service.diagnostics('session')?.repositoryContext?.omissions.message, true);
});
test('replacing a session capture during an awaited freshness check rejects the stale capture even when text and revision are equal', async t => {
  const entered = deferred<void>(), release = deferred<void>(); let holdNext = false;
  const f = await fixture(t, { source: source => ({ prepare: request => source.prepare(request), assertFresh: async (...args) => {
    if (holdNext) { holdNext = false; entered.resolve(); await release.promise; }
    await source.assertFresh(...args);
  } }) });
  const first = await f.service.build(f.request()), revision = f.service.revisionId('session');
  holdNext = true;
  const pending = f.service.assertFresh('session', first, signal(), f.run.id);
  const rejected = assert.rejects(pending, errorCode('REPOSITORY_CONTEXT_STALE'));
  await entered.promise;
  const second = await f.service.build(f.request());
  assert.deepEqual(second, first); assert.equal(f.service.revisionId('session'), revision);
  release.resolve(); await rejected;
  await f.service.assertFresh('session', second, signal(), f.run.id);
});
test('the bounded session capture cache rejects an evicted handle and releases only the requested Run owner', async t => {
  const f = await fixture(t);
  const observed = await f.source.prepare({ workspace: f.workspace, query: f.hostPolicy.query, exactRanges: f.hostPolicy.exactRanges,
    signal: signal(), budget: { slotBytes: 16_384, maxContextBytes: 262_144, reservedBytes: 64, requiredMessagesBytes: 2, contextWindow: null, outputTokens: 32 } });
  // A pure fixed peer isolates cache bounds; observation production is verified by the other integration cases.
  const source: ContextSourcePort = { prepare: async () => observed, assertFresh: async () => {} };
  const service = new ContextService(f.store, undefined, 32, undefined, { repositoryContext: { source, policy: f.hostPolicy } });
  let first: import('../ports.js').ProviderMessage[] = [], latest: import('../ports.js').ProviderMessage[] = [];
  for (let index = 0; index < 129; index++) {
    const sessionId = `bounded-${index}`;
    f.store.createSession({ id: sessionId, workspaceId: f.workspace.id, title: 'Bounded capture', createdAt: new Date().toISOString() });
    latest = await service.build({ workspace: f.workspace, snapshot: service.snapshot(sessionId, f.config), config: f.config, signal: signal(), reservedBytes: 64 });
    if (!index) first = latest;
  }
  await assert.rejects(service.assertFresh('bounded-0', first, signal()), errorCode('REPOSITORY_CONTEXT_STALE'));
  await service.assertFresh('bounded-128', latest, signal());
  service.releaseRepositoryContext('bounded-128');
  await assert.rejects(service.assertFresh('bounded-128', latest, signal()), errorCode('REPOSITORY_CONTEXT_STALE'));
});
test('planner evidence reservation counts escaped JSON exactly and never splits the required tool exchange', async t => {
  const f = await fixture(t), request = f.request();
  const createdAt = new Date().toISOString();
  request.snapshot.messages.push({ id: 'assistant', sessionId: 'session', runId: f.run.id, role: 'assistant', content: 'Observed read', toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'source.ts' } }], createdAt },
    { id: 'tool', sessionId: 'session', runId: f.run.id, role: 'tool', content: 'Actual tool result', toolCallId: 'call', createdAt });
  const evidence = { role: 'assistant' as const, content: 'Untrusted source "quoted" \\ path \n😀' };
  const plan = await planContext(request, { outputTokens: 32, repositoryMessages: [evidence] });
  const assistant = plan.messages.findIndex(message => message.toolCalls?.length);
  assert.equal(plan.messages[assistant + 1]?.role, 'tool'); assert.equal(plan.messages[assistant + 1]?.toolCallId, 'call');
  assert.equal(plan.reservations.repositoryBytes, Buffer.byteLength(JSON.stringify(evidence)) + 1);
  assert.equal(plan.bytes, Buffer.byteLength(JSON.stringify(plan.messages)) + 64); assert.equal(plan.sha256, sha(plan.messages));
  assert.equal(plan.inputEstimate.tokens, plan.bytes); assert.equal(plan.tokenLimit, null);
});
test('same-Turn retries validate the same request on every actual native Attempt and preserve cleanup evidence', async t => {
  const f = await fixture(t), messages = await f.service.build(f.request()), requests: TurnRequest[] = []; let checks = 0, closes = 0;
  const executor = f.executor(async (request, signal) => { checks++; await f.service.assertFresh(request.sessionId, request.messages, signal, request.runId); });
  const provider: ProviderAdapter = { id: 'fixture', streamTurn(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> { throw new EngineError('PROVIDER_HTTP_ERROR', 'Authored retry', { status: 503, retryAfterMs: 0 }); }, async return() { closes++; return { done: true, value: undefined }; } }; } };
    return { async *[Symbol.asyncIterator]() { yield stop; } };
  } };
  await collect(executor.stream(provider, { runId: f.run.id, sessionId: 'session', turnIndex: 0, modelId: 'model', messages, tools: [] }, signal()));
  assert.equal(checks, 2); assert.equal(requests.length, 2); assert.equal(closes, 1);
  assert.deepEqual(requests[1]?.messages, requests[0]?.messages); assert.deepEqual(requests[1]?.tools, requests[0]?.tools);
  for (const request of requests) { const cleanup = f.store.getAttemptCleanup(request.attemptId!); assert.equal(cleanup.state, 'confirmed'); assert.equal(cleanup.requestSha256, sha(request)); }
});
test('a repository edit after confirmed retryable cleanup rejects the next native producer without rewriting its fixed messages', async t => {
  const f = await fixture(t), messages = await f.service.build(f.request()), original = structuredClone(messages); let calls = 0, checks = 0, closes = 0;
  const executor = f.executor(async (request, signal) => { checks++; await f.service.assertFresh(request.sessionId, request.messages, signal, request.runId); });
  let firstAttempt: string | undefined;
  const provider: ProviderAdapter = { id: 'fixture', streamTurn(request) {
    calls++; firstAttempt = request.attemptId;
    return { [Symbol.asyncIterator]() { return { async next(): Promise<IteratorResult<ProviderEvent>> { throw new EngineError('PROVIDER_HTTP_ERROR', 'Authored retry', { status: 429, retryAfterMs: 0 }); }, async return() {
      closes++; await writeFile(join(f.root, 'source.ts'), 'export const changed = true;\n'); return { done: true, value: undefined };
    } }; } };
  } };
  await assert.rejects(collect(executor.stream(provider, { runId: f.run.id, sessionId: 'session', turnIndex: 0, modelId: 'model', messages, tools: [] }, signal())), errorCode('REPOSITORY_CONTEXT_STALE'));
  assert.equal(calls, 1); assert.equal(closes, 1); assert.equal(checks, 2); assert.deepEqual(messages, original);
  assert.equal(f.store.getAttemptCleanup(firstAttempt!).state, 'confirmed');
  const denied = f.store.getAttemptCleanup(executor.attemptId!); assert.equal(denied.state, 'not-dispatched');
  assert.equal(denied.method, 'no-dispatch'); assert.equal(f.store.getAttempt(executor.attemptId!).dispatchedAt, undefined);
});
test('attempt freshness callback mutation is rejected before native dispatch and cannot change the original request', async t => {
  const f = await fixture(t), messages = await f.service.build(f.request()), original = structuredClone(messages); let called = 0;
  const executor = f.executor(async request => { request.messages[0]!.content = 'validation rewrite'; });
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn() { called++; yield stop; } };
  await assert.rejects(collect(executor.stream(provider, { runId: f.run.id, sessionId: 'session', turnIndex: 0, modelId: 'model', messages, tools: [] }, signal())), errorCode('CONTEXT_REVISION_STALE'));
  assert.equal(called, 0); assert.deepEqual(messages, original);
  assert.equal(f.store.getAttemptCleanup(executor.attemptId!).state, 'not-dispatched');
});
test('host policy normalization rejects unknown modes and preserves frozen exact paths and ranges', () => {
  const input = { query: { kind: 'symbols', paths: ['source.ts'] }, slotBytes: 4096,
    exactRanges: [{ path: 'source.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } }] };
  const policy = repositoryContextPolicy(input);
  input.query.paths[0] = 'changed'; input.exactRanges[0]!.range.end.character = 1;
  assert.deepEqual(policy.query.paths, ['source.ts']); assert.equal(policy.exactRanges?.[0]?.range.end.character, 4);
  assert.ok(Object.isFrozen(policy.exactRanges?.[0]?.range.end));
  assert.throws(() => repositoryContextPolicy({ ...input, autoIndex: true }), errorCode('INVALID_REPOSITORY_CONTEXT'));
});
