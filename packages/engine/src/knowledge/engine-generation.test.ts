import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type InputReceipt, type JsonObject, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import type { HostGenerationRequest } from '../provider/generation.js';
import { buildKnowledgeGenerationRequest } from './generation-request.js';
import type { KnowledgeSourceProjection } from './host.js';
import type { KnowledgeCandidate, KnowledgeGenerationPlan } from './types.js';
import type { KnowledgeGenerationAttempt, KnowledgeGenerationBudget, KnowledgeGenerationRecord, KnowledgeGenerationRecoveryPreview, KnowledgeGenerationRecoveryResult } from './generation-types.js';
import type { KnowledgeGenerationStorage } from './generation-store.js';

type Engine = ReturnType<typeof createEngine>;
interface GenerationInput { workspaceId: string; planId: string; requestId: string; projection: KnowledgeSourceProjection; budget?: Partial<KnowledgeGenerationBudget>; reasoningEffort?: import('@moodcode/contracts').ReasoningEffort; signal?: AbortSignal }
interface GenerationResult { generation: KnowledgeGenerationRecord; attempt: KnowledgeGenerationAttempt | null; candidate: KnowledgeCandidate | null }
interface HostApi {
  generateWorkspaceKnowledge(input: GenerationInput): Promise<GenerationResult>;
  getWorkspaceKnowledgeGeneration(workspaceId: string, generationId: string): GenerationResult;
  finishWorkspaceKnowledgeCandidate(input: { workspaceId: string; generationId: string; requestId: string }): Promise<GenerationResult>;
  getWorkspaceKnowledgeRecoveryPreview(workspaceId: string): KnowledgeGenerationRecoveryPreview;
  acknowledgeWorkspaceKnowledgeRecovery(input: { preview: KnowledgeGenerationRecoveryPreview; requestId: string; reason: string; acknowledged: true }): Promise<KnowledgeGenerationRecoveryResult>;
  resumeWorkspaceKnowledge(input: { workspaceId: string; requestId: string; expectedRevision: number; expectedFrontierSha256: string }): Promise<KnowledgeGenerationRecoveryResult>;
}
/** Bind the actual public methods; this fixture supplies no native store/provider substitute. */
function host(engine: Engine): HostApi {
  const bound = <T extends (...args: never[]) => unknown>(name: string): T => {
    const method = Reflect.get(engine, name); assert.equal(typeof method, 'function', `Actual Engine must implement ${name}`);
    return method.bind(engine) as T;
  };
  return {
    generateWorkspaceKnowledge(input) { return bound<HostApi['generateWorkspaceKnowledge']>('generateWorkspaceKnowledge')(input); },
    getWorkspaceKnowledgeGeneration(workspaceId, generationId) { return bound<HostApi['getWorkspaceKnowledgeGeneration']>('getWorkspaceKnowledgeGeneration')(workspaceId, generationId); },
    finishWorkspaceKnowledgeCandidate(input) { return bound<HostApi['finishWorkspaceKnowledgeCandidate']>('finishWorkspaceKnowledgeCandidate')(input); },
    getWorkspaceKnowledgeRecoveryPreview(workspaceId) { return bound<HostApi['getWorkspaceKnowledgeRecoveryPreview']>('getWorkspaceKnowledgeRecoveryPreview')(workspaceId); },
    acknowledgeWorkspaceKnowledgeRecovery(input) { return bound<HostApi['acknowledgeWorkspaceKnowledgeRecovery']>('acknowledgeWorkspaceKnowledgeRecovery')(input); },
    resumeWorkspaceKnowledge(input) { return bound<HostApi['resumeWorkspaceKnowledge']>('resumeWorkspaceKnowledge')(input); },
  };
}
const errorCode = (code?: string) => (error: unknown): boolean => { assert.ok(error instanceof EngineError); if (code) assert.equal(error.code, code); return true; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean, label: string): Promise<void> { const deadline = Date.now() + 4000; while (!check()) { assert.ok(Date.now() < deadline, label); await tick(); } }
const CODING_TABLES = ['sessions', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'session_turns', 'provider_attempts', 'context_revisions', 'summary_attempts', 'summary_usage'] as const;
function readDb<T>(path: string, operation: (db: DatabaseSync) => T): T { const db = new DatabaseSync(path, { readOnly: true }); try { return operation(db); } finally { db.close(); } }
function counts(path: string, tables: readonly string[]): Record<string, number> { return readDb(path, db => Object.fromEntries(tables.map(table => [table, Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)]))); }
function nativeCounts(path: string) { return counts(path, ['knowledge_generations', 'knowledge_generation_attempts', 'knowledge_candidates']); }
function attemptRow(path: string, generationId: string): KnowledgeGenerationAttempt | null {
  return readDb(path, db => { const row = db.prepare('SELECT data FROM knowledge_generation_attempts WHERE generation_id=?').get(generationId); return row ? JSON.parse(String(row.data)) as KnowledgeGenerationAttempt : null; });
}
type GenerationBehavior = (request: HostGenerationRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent>;
const ordinary: GenerationBehavior = async function* () { yield { type: 'text.delta', delta: 'Pending project note.\n' }; yield { type: 'finish', reason: 'stop' }; };

async function fixture(t: TestContext, options: { enabled?: boolean; legacy?: boolean; behavior?: GenerationBehavior } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-engine-generation-'))), root = join(base, 'repository'), dbPath = join(base, 'engine.sqlite'), artifactDir = join(base, 'artifacts');
  mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Host approved instruction source.\n'); writeFileSync(join(root, 'source.ts'), 'export const selected = 1;\n');
  const coding: TurnRequest[] = [], generations: HostGenerationRequest[] = [], generationSignals: AbortSignal[] = [];
  let behavior = options.behavior ?? ordinary;
  const provider: ProviderAdapter = { id: 'knowledge-fixture', async *streamTurn(request) { coding.push(structuredClone(request)); yield { type: 'text.delta', delta: 'Completed source message for selected project facts.' }; yield { type: 'finish', reason: 'stop' }; },
    ...(options.legacy ? {} : { streamGeneration(request: HostGenerationRequest, signal: AbortSignal) { generations.push(request); generationSignals.push(signal); return behavior(request, signal); } }) };
  const engineOptions = { dbPath, artifactDir, providers: [provider], ...(options.enabled === false ? {} : { knowledgeGeneration: true }), defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan' as const, limits: { maxTurns: 3, maxDurationMs: 10000 } } };
  const engine = createEngine(engineOptions), engines = new Set([engine]);
  t.after(async () => { for (const current of engines) await current.close(); rmSync(base, { recursive: true, force: true }); });
  const command = async <T>(type: string, payload: JsonObject): Promise<T> => { const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result as unknown as T; };
  const workspace = await command<Workspace>('workspace.open', { path: root }), session = await command<Session>('session.create', { workspaceId: workspace.id });
  const sourceRun = await command<RunReceipt>('run.submit', { sessionId: session.id, requestId: 'completed-source', prompt: 'Original host selected source task.' });
  assert.equal((await engine.waitForRun(sourceRun.runId)).state, 'completed');
  const sourceMessage = engine.store.getSnapshot(session.id).messages.find(message => message.role === 'assistant')!; assert.ok(sourceMessage);
  const trust = await engine.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'allow-fixture-trust', expectedRevision: 0, decision: 'allow', preview: engine.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'source.ts' }, { kind: 'message', sessionId: session.id, messageId: sourceMessage.id, runId: sourceRun.runId }]);
  const logical = options.enabled === false || options.legacy
    ? buildKnowledgeGenerationRequest({ providerId: provider.id, modelId: 'fixture-model', source: projection })
    : engine.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
  const target = engine.captureWorkspaceKnowledgeTarget(workspace.id, 'MOODCODE_MEMORY.md');
  const plan: KnowledgeGenerationPlan = await engine.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: 'fixture-plan', expectedTrustRevision: trust.revision, projection, target,
    providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes, maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const input: GenerationInput = { workspaceId: workspace.id, planId: plan.id, requestId: 'actual-host-generation', projection };
  const api = host(engine), codingBefore = counts(dbPath, CODING_TABLES);
  return { base, root, dbPath, artifactDir, engine, api, command, workspace, session, sourceRun, sourceMessage, projection, logical, target, plan, trust, input, coding, generations, generationSignals, codingBefore,
    setBehavior(next: GenerationBehavior) { behavior = next; },
    reopen() { const restored = createEngine(engineOptions); engines.add(restored); return { engine: restored, api: host(restored) }; },
    assertNoCodingEffects() { assert.deepEqual(counts(dbPath, CODING_TABLES), codingBefore); assert.equal(coding.length, 1); assert.equal(existsSync(join(root, 'MOODCODE_MEMORY.md')), false); },
  };
}

test('actual preview rejects accessors, proxies and unknown fields before reads, native admission or provider invocation', async t => {
  const f = await fixture(t); let reads = 0;
  const present = readDb(f.dbPath, db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('knowledge_generations','knowledge_generation_attempts','knowledge_candidates','knowledge_generation_plans') ORDER BY name").all().map(row => String(row.name)));
  const before = counts(f.dbPath, present), input = { providerId: 'knowledge-fixture', modelId: 'fixture-model', projection: f.projection };
  const invalid = [
    Object.defineProperty({ ...input }, 'providerId', { enumerable: true, get() { reads++; return 'knowledge-fixture'; } }),
    Object.defineProperty({ ...input }, 'projection', { enumerable: true, get() { reads++; return f.projection; } }),
    new Proxy(input, { get() { reads++; throw new Error('Proxy must not execute.'); }, ownKeys() { reads++; throw new Error('Proxy must not execute.'); }, getPrototypeOf() { reads++; throw new Error('Proxy must not execute.'); } }),
    { ...input, tools: ['run_command'] },
  ];
  for (const value of invalid) assert.throws(() => Reflect.apply(f.engine.previewWorkspaceKnowledgeGeneration, f.engine, [value]), errorCode('INVALID_KNOWLEDGE_GENERATION'));
  assert.equal(reads, 0); assert.equal(f.generations.length, 0); assert.deepEqual(counts(f.dbPath, present), before); f.assertNoCodingEffects();
});

test('actual Engine generates native host output and only one immutable pending candidate without any coding owner/effect', { timeout: 15000 }, async t => {
  const f = await fixture(t), before = nativeCounts(f.dbPath), result = await f.api.generateWorkspaceKnowledge(f.input);
  assert.equal(result.generation.state, 'completed'); assert.equal(result.generation.workspaceId, f.workspace.id); assert.equal(result.generation.planId, f.plan.id);
  assert.equal(f.generations.length, 1); assert.ok(result.attempt && result.candidate);
  assert.deepEqual(f.generations[0]!.owner, { kind: 'host-generation', workspaceId: f.workspace.id, generationId: result.generation.id, attemptId: result.attempt.id });
  for (const key of ['runId', 'sessionId', 'turnIndex', 'turnId', 'resolvedImages', 'resolvedDocuments']) assert.equal(Object.hasOwn(f.generations[0]!, key), false);
  assert.deepEqual(f.generations[0]!.tools, []); assert.equal(f.generations[0]!.includeMetadata, true); assert.deepEqual(f.generations[0]!.messages, f.logical.payload.messages);
  assert.ok(Object.isFrozen(f.generations[0]!) && Object.isFrozen(f.generations[0]!.messages));
  assert.equal(result.attempt.state, 'completed'); assert.equal(result.attempt.output, 'Pending project note.\n'); assert.equal(result.attempt.streamDone, true); assert.equal(result.attempt.cleanup!.confirmed, true);
  assert.deepEqual(result.attempt.usage, { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null });
  assert.equal(result.candidate.state, 'pending'); assert.equal(result.candidate.generationOwnerId, result.generation.id); assert.equal(result.candidate.body, result.attempt.output); assert.equal(result.candidate.bodySha256, result.attempt.outputSha256);
  assert.deepEqual(result.candidate.usage, result.attempt.usage); assert.equal(result.candidate.toolCount, 0); assert.equal(result.candidate.cleanupConfirmed, true);
  assert.ok(Object.isFrozen(result.generation) && Object.isFrozen(result.attempt) && Object.isFrozen(result.candidate));
  assert.equal(result.generation.candidate.state, 'recorded'); assert.equal(result.generation.candidate.candidateId, result.candidate.id);
  assert.equal(result.candidate.source.pins[1]!.kind, 'message'); assert.equal(result.candidate.requestSha256, f.logical.requestSha256);
  assert.deepEqual(nativeCounts(f.dbPath), { knowledge_generations: before.knowledge_generations! + 1, knowledge_generation_attempts: before.knowledge_generation_attempts! + 1, knowledge_candidates: before.knowledge_candidates! + 1 });
  const observed = f.api.getWorkspaceKnowledgeGeneration(f.workspace.id, result.generation.id);
  assert.deepEqual(observed.generation, result.generation); assert.deepEqual(observed.attempt, result.attempt); assert.deepEqual(observed.candidate, result.candidate);
  assert.deepEqual(attemptRow(f.dbPath, result.generation.id), result.attempt); f.assertNoCodingEffects();
});

test('actual normalized nullable usage comes from the tools-free provider observations, never candidate text', async t => {
  const f = await fixture(t, { behavior: async function* () { yield { type: 'usage', inputTokens: 8, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 }; yield { type: 'text.delta', delta: 'No claimed token counters are parsed from this body.' }; yield { type: 'finish', reason: 'stop' }; } });
  const result = await f.api.generateWorkspaceKnowledge(f.input);
  assert.ok(result.attempt && result.candidate); assert.deepEqual(result.attempt.usage, { inputTokens: 8, outputTokens: 3, cachedInputTokens: 2, reasoningTokens: 1 });
  assert.deepEqual(result.candidate.usage, result.attempt.usage); f.assertNoCodingEffects();
});

test('actual provider reasoning/replay is charged and discarded without entering native output or pending candidate', async t => {
  const reasoning = 'private reasoning fixture must not persist', opaque = 'opaque replay fixture must not persist';
  const f = await fixture(t, { behavior: async function* () { yield { type: 'reasoning.delta', delta: reasoning }; yield { type: 'text.delta', delta: 'Only this visible text is proposed.' }; yield { type: 'finish', reason: 'stop', replayItems: [{ type: 'reasoning', encrypted_content: opaque }] }; } });
  const result = await f.api.generateWorkspaceKnowledge(f.input); assert.equal(result.generation.state, 'completed'); assert.ok(result.attempt && result.candidate);
  assert.equal(result.attempt.output, 'Only this visible text is proposed.'); assert.equal(result.candidate.body, result.attempt.output); assert.ok(result.attempt.observationBytes >= Buffer.byteLength(reasoning) + Buffer.byteLength(opaque));
  assert.equal(JSON.stringify(result).includes(reasoning), false); assert.equal(JSON.stringify(result).includes(opaque), false);
  assert.equal(JSON.stringify(attemptRow(f.dbPath, result.generation.id)).includes(opaque), false); f.assertNoCodingEffects();
});

test('exact native duplicates and candidate finishing read the same evidence with zero redispatch; changed request conflicts', async t => {
  const f = await fixture(t), first = await f.api.generateWorkspaceKnowledge(f.input), before = nativeCounts(f.dbPath);
  const duplicate = await f.api.generateWorkspaceKnowledge(f.input), finished = await f.api.finishWorkspaceKnowledgeCandidate({ workspaceId: f.workspace.id, generationId: first.generation.id, requestId: 'explicit-finish' });
  assert.deepEqual(duplicate.generation, first.generation); assert.deepEqual(duplicate.attempt, first.attempt); assert.deepEqual(duplicate.candidate, first.candidate);
  assert.deepEqual(finished.candidate, first.candidate); assert.equal(f.generations.length, 1); assert.deepEqual(nativeCounts(f.dbPath), before);
  await assert.rejects(f.api.generateWorkspaceKnowledge({ ...f.input, budget: { maxOutputBytes: 512 } }), errorCode());
  assert.equal(f.generations.length, 1); assert.deepEqual(nativeCounts(f.dbPath), before); f.assertNoCodingEffects();
});

for (const mode of ['default-off', 'legacy-only'] as const) test(`actual ${mode} rejects before host native ownership or provider calls`, async t => {
  const f = await fixture(t, mode === 'default-off' ? { enabled: false } : { legacy: true }), before = nativeCounts(f.dbPath);
  const expected = mode === 'default-off' ? 'KNOWLEDGE_GENERATION_DISABLED' : 'KNOWLEDGE_PROVIDER_UNSUPPORTED';
  assert.throws(() => f.engine.previewWorkspaceKnowledgeGeneration({ providerId: 'knowledge-fixture', modelId: 'fixture-model', projection: f.projection }), errorCode(expected));
  await assert.rejects(f.api.generateWorkspaceKnowledge(f.input), errorCode(expected)); assert.equal(f.generations.length, 0); assert.deepEqual(nativeCounts(f.dbPath), before); f.assertNoCodingEffects();
});

for (const mode of ['clone', 'released', 'source-changed', 'target-changed'] as const) test(`actual pre-dispatch ${mode} source/target has zero host owner and zero invocation`, async t => {
  const f = await fixture(t), before = nativeCounts(f.dbPath); let input = f.input;
  if (mode === 'clone') input = { ...input, projection: { ...f.projection } };
  if (mode === 'released') f.engine.releaseWorkspaceKnowledgeSources(f.projection);
  if (mode === 'source-changed') writeFileSync(join(f.root, 'source.ts'), 'export const selected = 2;\n');
  if (mode === 'target-changed') writeFileSync(join(f.root, 'MOODCODE_MEMORY.md'), 'Host concurrently created the exact target.\n');
  await assert.rejects(f.api.generateWorkspaceKnowledge(input), errorCode()); assert.equal(f.generations.length, 0); assert.deepEqual(nativeCounts(f.dbPath), before);
  assert.deepEqual(counts(f.dbPath, CODING_TABLES), f.codingBefore);
});

for (const mode of ['source', 'target', 'trust-source', 'trust-revoked'] as const) test(`actual ${mode} change during generation preserves completed native output and withholds pending candidate without replay`, async t => {
  const f = await fixture(t);
  f.setBehavior(async function* () {
    yield { type: 'usage', inputTokens: 4, outputTokens: 2 }; yield { type: 'text.delta', delta: 'Actual completed proposed text.' };
    if (mode === 'source') writeFileSync(join(f.root, 'source.ts'), 'export const selected = 9;\n');
    if (mode === 'target') writeFileSync(join(f.root, 'MOODCODE_MEMORY.md'), 'Actual target changed before append.\n');
    if (mode === 'trust-source') writeFileSync(join(f.root, 'AGENTS.md'), 'Actual pinned instruction source changed.\n');
    if (mode === 'trust-revoked') f.engine.workspaceTrust.set({ workspaceId: f.workspace.id, requestId: 'trusted-host-revoke-during-generation', expectedRevision: f.trust.revision, decision: 'deny' });
    yield { type: 'finish', reason: 'stop' };
  });
  const result = await f.api.generateWorkspaceKnowledge(f.input);
  assert.equal(result.generation.state, 'completed'); assert.ok(result.attempt); assert.equal(result.attempt.state, 'completed'); assert.equal(result.attempt.output, 'Actual completed proposed text.'); assert.equal(result.attempt.cleanup!.confirmed, true);
  assert.equal(result.generation.candidate.state, 'withheld'); assert.ok(result.generation.candidate.reason); assert.equal(result.candidate, null); assert.equal(counts(f.dbPath, ['knowledge_candidates']).knowledge_candidates, 0);
  assert.deepEqual(result.attempt.usage, { inputTokens: 4, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null });
  const duplicate = await f.api.generateWorkspaceKnowledge(f.input); assert.equal(duplicate.generation.id, result.generation.id); assert.equal(duplicate.generation.state, 'completed'); assert.equal(duplicate.candidate, null); assert.equal(f.generations.length, 1);
  assert.deepEqual(counts(f.dbPath, CODING_TABLES), f.codingBefore);
});

test('native finish event alone cannot create a candidate before actual iterator completion', async t => {
  const completion = deferred<IteratorResult<ProviderEvent>>(), atEnd = deferred<void>();
  let index = 0, returns = 0;
  const iterator: AsyncIterator<ProviderEvent> = { async next() { index++; if (index === 1) return { done: false, value: { type: 'text.delta', delta: 'Exact gated output.' } }; if (index === 2) return { done: false, value: { type: 'finish', reason: 'stop' } }; atEnd.resolve(); return completion.promise; }, async return() { returns++; return { done: true, value: undefined }; } };
  const f = await fixture(t, { behavior: () => ({ [Symbol.asyncIterator]() { return iterator; } }) }), operation = f.api.generateWorkspaceKnowledge(f.input);
  await atEnd.promise; const owner = f.generations[0]!.owner, observed = f.api.getWorkspaceKnowledgeGeneration(f.workspace.id, owner.generationId);
  assert.equal(observed.generation.state, 'output-finished'); assert.equal(observed.candidate, null); assert.ok(observed.attempt); assert.equal(observed.attempt.finishReason, 'stop'); assert.equal(observed.attempt.streamDone, false);
  assert.equal(counts(f.dbPath, ['knowledge_candidates']).knowledge_candidates, 0);
  completion.resolve({ done: true, value: undefined }); const result = await operation;
  assert.equal(result.generation.state, 'completed'); assert.equal(result.attempt!.streamDone, true); assert.ok(result.candidate); assert.equal(returns, 0); f.assertNoCodingEffects();
});

for (const mode of ['empty', 'overflow', 'tool', 'length', 'after-finish'] as const) test(`native ${mode} protocol/output failure preserves actual partial observations without candidate`, async t => {
  const f = await fixture(t, { behavior: async function* () {
    yield { type: 'usage', inputTokens: 4, outputTokens: 2 };
    if (mode !== 'empty') yield { type: 'text.delta', delta: mode === 'overflow' ? '1234567890' : 'Partial observed text.' };
    if (mode === 'tool') yield { type: 'tool.call', call: { id: 'forbidden-tool', name: 'run_command', input: { command: 'model supplied proof must not execute' } } };
    yield { type: 'finish', reason: mode === 'length' ? 'length' : 'stop' };
    if (mode === 'after-finish') yield { type: 'text.delta', delta: 'Impossible late text.' };
  } });
  const result = await f.api.generateWorkspaceKnowledge({ ...f.input, ...(mode === 'overflow' ? { budget: { maxOutputBytes: 8 } } : {}) });
  assert.equal(result.generation.state, 'failed'); assert.ok(result.attempt); assert.equal(result.attempt.state, 'failed'); assert.equal(result.attempt.cleanup!.confirmed, true); assert.equal(result.candidate, null);
  assert.ok(result.generation.errorCode); assert.deepEqual(result.attempt.usage, { inputTokens: 4, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null });
  if (mode === 'overflow') { assert.ok(result.attempt.outputBytes <= 8); assert.equal(result.attempt.observedTextBytes, 10); assert.equal(result.attempt.outputTruncated, true); }
  else assert.equal(result.attempt.output, mode === 'empty' ? '' : 'Partial observed text.');
  assert.equal(f.generations.length, 1); assert.equal(counts(f.dbPath, ['knowledge_candidates']).knowledge_candidates, 0); f.assertNoCodingEffects();
});

test('actual caller cancellation preserves partial output/usage with authenticated iterator return and no candidate', async t => {
  const blocked = deferred<void>(), abort = new AbortController(); let index = 0, returns = 0;
  const iterator: AsyncIterator<ProviderEvent> = { async next() { index++; if (index === 1) return { done: false, value: { type: 'usage', inputTokens: 3, outputTokens: 1 } }; if (index === 2) return { done: false, value: { type: 'text.delta', delta: 'Actual partial before cancellation.' } }; blocked.resolve(); return new Promise(() => {}); }, async return() { returns++; return { done: true, value: undefined }; } };
  const f = await fixture(t, { behavior: () => ({ [Symbol.asyncIterator]() { return iterator; } }) }), operation = f.api.generateWorkspaceKnowledge({ ...f.input, signal: abort.signal });
  await blocked.promise; abort.abort(new Error('private abort cause must stay private')); const result = await operation;
  assert.equal(result.generation.state, 'cancelled'); assert.ok(result.attempt); assert.equal(result.attempt.cleanup!.confirmed, true); assert.equal(result.attempt.cleanup!.method, 'iterator-return'); assert.equal(returns, 1);
  assert.equal(result.attempt.output, 'Actual partial before cancellation.'); assert.deepEqual(result.attempt.usage, { inputTokens: 3, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null }); assert.equal(result.candidate, null); assert.equal(f.generationSignals[0]!.aborted, true); f.assertNoCodingEffects();
});

test('adapter owned CLEANUP_UNCERTAIN remains native uncertainty even when a subsequent closed generator return reports done', async t => {
  const f = await fixture(t, { behavior: async function* () { yield { type: 'text.delta', delta: 'Actual observed before transport cleanup failure.' }; throw new EngineError('CLEANUP_UNCERTAIN', 'Synthetic adapter observed rejecting underlying body cancellation.'); } });
  const result = await f.api.generateWorkspaceKnowledge(f.input); assert.equal(result.generation.state, 'uncertain'); assert.ok(result.attempt);
  assert.equal(result.attempt.output, 'Actual observed before transport cleanup failure.'); assert.equal(result.attempt.cleanup!.confirmed, false); assert.equal(result.attempt.cleanup!.reason, 'adapter_cleanup_uncertain'); assert.equal(result.candidate, null);
  assert.equal(result.generation.errorCode, 'CLEANUP_UNCERTAIN'); f.assertNoCodingEffects();
});

test('actual engine close awaits the original provider cleanup and keeps an accepted inbox input pending', { timeout: 15000 }, async t => {
  const reading = deferred<void>(), closing = deferred<void>(), clean = deferred<IteratorResult<ProviderEvent>>(); let returns = 0;
  const iterator: AsyncIterator<ProviderEvent> = { async next() { reading.resolve(); return new Promise(() => {}); }, async return() { returns++; closing.resolve(); return clean.promise; } };
  const f = await fixture(t, { behavior: () => ({ [Symbol.asyncIterator]() { return iterator; } }) }), operation = f.api.generateWorkspaceKnowledge(f.input);
  await reading.promise;
  const input = await f.engine.dispatchSession({ schemaVersion: 2, commandId: 'pending-during-generation', type: 'input.accept', payload: { sessionId: f.session.id, requestId: 'queued-during-host-generation', prompt: 'Remain queued while host generation owns the workspace.', delivery: 'queue' } });
  assert.equal(input.ok, true); const receipt = input.result as unknown as InputReceipt; assert.equal(receipt.state, 'pending'); assert.equal(receipt.runId, undefined);
  assert.equal(f.engine.store.getInput(receipt.inputId).state, 'pending'); assert.deepEqual(counts(f.dbPath, CODING_TABLES), f.codingBefore);
  let resolved = false; const close = f.engine.close().then(() => { resolved = true; });
  await closing.promise; await tick(); assert.equal(resolved, false); assert.equal(f.generationSignals[0]!.aborted, true); assert.equal(returns, 1);
  clean.resolve({ done: true, value: undefined }); const result = await operation; await close;
  assert.equal(resolved, true); assert.equal(result.generation.state, 'cancelled'); assert.equal(result.attempt!.cleanup!.confirmed, true); assert.equal(result.candidate, null);
  assert.deepEqual(counts(f.dbPath, CODING_TABLES), f.codingBefore);
  const pending = readDb(f.dbPath, db => db.prepare('SELECT state,data FROM session_inputs WHERE id=?').get(receipt.inputId)!); assert.equal(pending.state, 'pending'); assert.equal(JSON.parse(String(pending.data)).runId, undefined);
});

test('unconfirmed actual iterator return survives restart as native quarantine, and recovery acknowledgement/resume never replays it', { timeout: 15000 }, async t => {
  const blocked = deferred<void>(); let returns = 0, index = 0;
  const iterator: AsyncIterator<ProviderEvent> = { async next() { index++; if (index === 1) return { done: false, value: { type: 'usage', inputTokens: 2, outputTokens: 1 } }; if (index === 2) return { done: false, value: { type: 'text.delta', delta: 'Observed before unknown cleanup.' } }; blocked.resolve(); return new Promise(() => {}); }, async return() { returns++; throw new Error('actual cleanup fixture failed'); } };
  const f = await fixture(t, { behavior: () => ({ [Symbol.asyncIterator]() { return iterator; } }) }), abort = new AbortController(), operation = f.api.generateWorkspaceKnowledge({ ...f.input, signal: abort.signal });
  await blocked.promise; abort.abort(); const result = await operation;
  assert.equal(result.generation.state, 'uncertain'); assert.ok(result.attempt); assert.equal(result.attempt.cleanup!.confirmed, false); assert.equal(result.attempt.output, 'Observed before unknown cleanup.'); assert.equal(result.candidate, null); assert.equal(returns, 1);
  assert.deepEqual(result.attempt.usage, { inputTokens: 2, outputTokens: 1, cachedInputTokens: null, reasoningTokens: null });
  const quarantine = Reflect.get(f.engine.store, 'hasUncertainKnowledgeGeneration'); assert.equal(typeof quarantine, 'function'); assert.equal(Reflect.apply(quarantine, f.engine.store, [f.workspace.id]), true);
  const before = nativeCounts(f.dbPath); await f.engine.close();
  const restored = f.reopen(), observed = restored.api.getWorkspaceKnowledgeGeneration(f.workspace.id, result.generation.id);
  assert.equal(observed.generation.state, 'uncertain'); assert.equal(observed.attempt!.cleanup!.confirmed, false); assert.equal(observed.candidate, null); assert.deepEqual(nativeCounts(f.dbPath), before); assert.equal(f.generations.length, 1);
  const rejected = await restored.engine.dispatch({ schemaVersion: 1, commandId: 'blocked-native-generation', type: 'run.submit', payload: { sessionId: f.session.id, requestId: 'blocked-run', prompt: 'Must not start coding behind unconfirmed host cleanup.' } }); assert.equal(rejected.ok, false); assert.equal(rejected.error!.code, 'CLEANUP_PENDING');
  const preview = restored.api.getWorkspaceKnowledgeRecoveryPreview(f.workspace.id);
  await assert.rejects(restored.api.acknowledgeWorkspaceKnowledgeRecovery({ preview: { ...preview }, requestId: 'forged-recovery-preview', reason: 'Opaque identity must be original.', acknowledged: true }), errorCode());
  const ackInput = { preview, requestId: 'ack-original-uncertainty', reason: 'Host reviewed the real retained native outcome.', acknowledged: true as const }, ack = await restored.api.acknowledgeWorkspaceKnowledgeRecovery(ackInput);
  assert.equal(ack.barrier.state, 'pending-resume'); assert.equal(f.generations.length, 1); assert.deepEqual(nativeCounts(f.dbPath), before);
  assert.deepEqual(await restored.api.acknowledgeWorkspaceKnowledgeRecovery(ackInput), ack);
  const resumeInput = { workspaceId: f.workspace.id, requestId: 'explicit-resume', expectedRevision: ack.barrier.revision, expectedFrontierSha256: ack.barrier.frontierSha256 }, resumed = await restored.api.resumeWorkspaceKnowledge(resumeInput);
  assert.equal(resumed.barrier.state, 'clear'); assert.deepEqual(await restored.api.resumeWorkspaceKnowledge(resumeInput), resumed);
  const after = restored.api.getWorkspaceKnowledgeGeneration(f.workspace.id, result.generation.id); assert.equal(after.generation.state, 'uncertain'); assert.equal(after.attempt!.cleanup!.confirmed, false); assert.equal(after.candidate, null);
  assert.equal(f.generations.length, 1); assert.deepEqual(nativeCounts(f.dbPath), before); f.assertNoCodingEffects();
  const native = Reflect.get(restored.engine, 'knowledgeGenerations') as KnowledgeGenerationStorage; await restored.engine.close();
  assert.throws(() => native.releaseRecoveryPreview(preview), errorCode('KNOWLEDGE_GENERATION_HANDLE_INVALID'));
});
