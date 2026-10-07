import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type JsonObject, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { ScriptedProvider } from '../provider/scripted.js';
import type { ProviderAdapter, ProviderEvent } from '../ports.js';
import type { WorkspaceKnowledgeGenerationInput } from './generation-service.js';
import { buildKnowledgeGenerationRequest } from './generation-request.js';

const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
async function fixture(t: TestContext, generationEvents?: ProviderEvent[]) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-generation-service-review-'))), root = join(base, 'repository'); mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Host instruction source.\n'); writeFileSync(join(root, 'source.ts'), 'export const selected = 1;\n');
  const dbPath = join(base, 'engine.sqlite'), provider = new ScriptedProvider([], generationEvents ? [{ events: generationEvents }] : []), engine = createEngine({ dbPath, artifactDir: join(base, 'artifacts'), providers: [provider], ...(generationEvents ? { knowledgeGeneration: true } : {}) });
  t.after(async () => { await engine.close(); rmSync(base, { recursive: true, force: true }); });
  const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'workspace.open', payload: { path: root } as JsonObject }); assert.equal(response.ok, true); const workspace = response.result as unknown as Workspace;
  const trust = await engine.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'review-trust', expectedRevision: 0, decision: 'allow', preview: engine.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'source.ts' }]), logical = buildKnowledgeGenerationRequest({ providerId: provider.id, modelId: 'fixture-model', source: projection });
  const target = { ...engine.captureWorkspaceKnowledgeTarget(workspace.id, 'ORIGINAL_MEMORY.md') };
  const input = { workspaceId: workspace.id, requestId: 'review-plan', expectedTrustRevision: trust.revision, projection, target, providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes, maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  return { engine, root, provider, workspace, input, countPlans() { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return Number(db.prepare('SELECT count(*) AS n FROM knowledge_generation_plans').get()!.n); } finally { db.close(); } }, assertNoExecution() { assert.equal(provider.generationCallCount, 0); assert.equal(provider.callCount, 0); assert.equal(engine.store.listSessions(workspace.id).length, 0); } };
}

test('actual host plan preparation captures nested target before the workspace lease microtask', async t => {
  const f = await fixture(t), original = { ...f.input.target }, pending = f.engine.prepareWorkspaceKnowledgeGeneration(f.input); f.input.target.path = 'MUTATED_AFTER_CALL.md';
  const plan = await pending; assert.deepEqual(plan.target, original); assert.equal(f.countPlans(), 1); f.assertNoExecution();
});

test('host input/nested-target getters and proxies reject without trap effects or durable plans', async t => {
  const f = await fixture(t); let effects = 0;
  const accessorTarget = { ...f.input.target }; Object.defineProperty(accessorTarget, 'path', { enumerable: true, get() { effects++; return 'getter-must-not-execute.md'; } });
  const proxyTarget = new Proxy(f.input.target, { ownKeys() { effects++; return []; }, getPrototypeOf() { effects++; return Object.prototype; } });
  const proxyInput = new Proxy(f.input, { ownKeys() { effects++; return []; }, getPrototypeOf() { effects++; return Object.prototype; } });
  const accessorInput = { ...f.input }; Object.defineProperty(accessorInput, 'target', { enumerable: true, get() { effects++; return f.input.target; } });
  for (const input of [{ ...f.input, target: accessorTarget }, { ...f.input, target: proxyTarget }, proxyInput, accessorInput]) await assert.rejects(f.engine.prepareWorkspaceKnowledgeGeneration(input), (error: unknown) => error instanceof EngineError);
  assert.equal(effects, 0); assert.equal(f.countPlans(), 0); f.assertNoExecution();
});

test('nested target changed into a getter after admission cannot execute during lease or change exact target', async t => {
  const f = await fixture(t), original = { ...f.input.target }; let effects = 0;
  const pending = f.engine.prepareWorkspaceKnowledgeGeneration(f.input); Object.defineProperty(f.input.target, 'path', { enumerable: true, get() { effects++; return 'late-getter.md'; } });
  const plan = await pending; assert.deepEqual(plan.target, original); assert.equal(effects, 0); assert.equal(f.countPlans(), 1); f.assertNoExecution();
});

for (const changed of ['source', 'target', 'released-projection'] as const) test(`actual pending lease ${changed} currentness rejects before durable plan or execution`, async t => {
  const f = await fixture(t), pending = f.engine.prepareWorkspaceKnowledgeGeneration(f.input);
  if (changed === 'source') writeFileSync(join(f.root, 'source.ts'), 'export const selected = 2;\n');
  else if (changed === 'target') writeFileSync(join(f.root, 'ORIGINAL_MEMORY.md'), 'Created after admission, before lease execution.\n');
  else f.engine.releaseWorkspaceKnowledgeSources(f.input.projection);
  const expected = changed === 'source' ? 'KNOWLEDGE_SOURCE_CHANGED' : changed === 'target' ? 'KNOWLEDGE_TARGET_CHANGED' : 'KNOWLEDGE_SOURCE_CAPTURE_INVALID';
  await assert.rejects(pending, hasCode(expected)); assert.equal(f.countPlans(), 0); f.assertNoExecution();
});

for (const delta of ['invalid\ud800', 'invalid\0text']) test('actual native invalid text records full charge and discard without candidate authority', async t => {
  const prefix = 'Actual retained public prefix.', f = await fixture(t, [{ type: 'text.delta', delta: prefix }, { type: 'text.delta', delta }, { type: 'finish', reason: 'stop' }]), plan = await f.engine.prepareWorkspaceKnowledgeGeneration(f.input);
  const result = await f.engine.generateWorkspaceKnowledge({ workspaceId: f.workspace.id, planId: plan.id, requestId: 'invalid-native-output', projection: f.input.projection });
  assert.equal(result.generation.state, 'failed'); assert.equal(result.generation.errorCode, 'KNOWLEDGE_GENERATION_PROTOCOL'); assert.equal(result.attempt!.output, prefix); assert.equal(result.attempt!.outputBytes, Buffer.byteLength(prefix)); assert.equal(result.attempt!.observedTextBytes, Buffer.byteLength(prefix) + Buffer.byteLength(delta)); assert.equal(result.attempt!.outputTruncated, true); assert.equal(result.attempt!.cleanup!.confirmed, true); assert.equal(result.candidate, null); assert.equal(f.provider.generationCallCount, 1); assert.equal(f.provider.callCount, 0); assert.equal(f.engine.workspaceKnowledge.listCandidates(f.workspace.id).items.length, 0);
});

test('actual same-tick 33-workspace burst caps reservations before dispatch and releases all 32 confirmed cancellations', { timeout: 20_000 }, async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-generation-capacity-review-'))), dbPath = join(base, 'engine.sqlite');
  let calls = 0, returns = 0, coding = 0, complete = false;
  const provider: ProviderAdapter = {
    id: 'capacity-generation', async *streamTurn() { coding++; yield { type: 'finish', reason: 'stop' }; },
    streamGeneration(request, signal) {
      calls++; assert.equal(request.owner.kind, 'host-generation'); assert.equal(signal.aborted, false);
      if (complete) return (async function* () { yield { type: 'text.delta', delta: 'Actual new output after capacity release.' }; yield { type: 'finish', reason: 'stop' }; })();
      return { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<ProviderEvent>>(() => {}), return: async () => { returns++; return { done: true as const, value: undefined }; } }; } };
    },
  };
  const engine = createEngine({ dbPath, artifactDir: join(base, 'artifacts'), providers: [provider], knowledgeGeneration: true, defaults: { providerId: provider.id, modelId: 'fixture-model' } });
  t.after(async () => { await engine.close(); rmSync(base, { recursive: true, force: true }); });
  const inputs: WorkspaceKnowledgeGenerationInput[] = [], signals: AbortController[] = [];
  for (let index = 0; index < 33; index++) {
    const root = join(base, `repository-${index}`); mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]); writeFileSync(join(root, 'AGENTS.md'), 'Actual host-approved instruction source.\n'); writeFileSync(join(root, 'source.ts'), `export const selected = ${index};\n`);
    const opened = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'workspace.open', payload: { path: root } }); assert.equal(opened.ok, true); const workspace = opened.result as unknown as Workspace;
    const trust = await engine.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'capacity-trust', expectedRevision: 0, decision: 'allow', preview: engine.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
    const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'source.ts' }]), logical = engine.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
    const plan = await engine.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: 'capacity-plan', expectedTrustRevision: trust.revision, projection, target: engine.captureWorkspaceKnowledgeTarget(workspace.id, 'MEMORY.md'), providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes, maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const signal = new AbortController(); signals.push(signal); inputs.push({ workspaceId: workspace.id, planId: plan.id, requestId: 'capacity-generation', projection, signal: signal.signal });
  }
  // No await separates these calls: all reservations precede the operation microtasks.
  const pending = inputs.slice(0, 32).map(input => engine.generateWorkspaceKnowledge(input));
  for (const operation of pending) void operation.catch(() => {});
  const rejected = engine.generateWorkspaceKnowledge(inputs[32]!);
  await assert.rejects(rejected, hasCode('KNOWLEDGE_GENERATION_LIMIT'));
  const deadline = Date.now() + 5_000; while (calls < 32) { assert.ok(Date.now() < deadline, 'All admitted native attempts must actually enter the provider'); await new Promise(resolve => setImmediate(resolve)); }
  const read = <T>(operation: (db: DatabaseSync) => T) => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return operation(db); } finally { db.close(); } };
  assert.equal(read(db => Number(db.prepare('SELECT count(*) AS n FROM knowledge_generations').get()!.n)), 32);
  assert.equal(read(db => Number(db.prepare('SELECT count(*) AS n FROM knowledge_generations WHERE workspace_id=?').get(inputs[32]!.workspaceId)!.n)), 0);
  for (const signal of signals.slice(0, 32)) signal.abort();
  const cancelled = await Promise.all(pending);
  for (const result of cancelled) { assert.equal(result.generation.state, 'cancelled'); assert.equal(result.attempt!.cleanup!.confirmed, true); assert.equal(result.candidate, null); assert.equal(result.executionBlocked, false); }
  assert.equal(calls, 32); assert.equal(returns, 32); assert.equal(coding, 0);
  complete = true; const fresh = await engine.generateWorkspaceKnowledge(inputs[32]!); assert.equal(fresh.generation.state, 'completed'); assert.ok(fresh.candidate); assert.equal(fresh.attempt!.cleanup!.confirmed, true); assert.equal(calls, 33);
  assert.equal(read(db => Number(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n)), 0); assert.equal(read(db => Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n)), 0);
});

test('actual completed native output crossing original deadline withholds automatic candidate; explicit finish never renews producer', { timeout: 5_000 }, async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-generation-deadline-review-'))), root = join(base, 'repository'), dbPath = join(base, 'engine.sqlite'); mkdirSync(root); execFileSync('git', ['init', '--quiet', '--template=', root]);
  writeFileSync(join(root, 'AGENTS.md'), 'Actual host-approved instruction source.\n'); writeFileSync(join(root, 'source.ts'), 'export const selected = 1;\n');
  let calls = 0, probes = 0, observedCompleted = false, originalDeadline = 0;
  const provider: ProviderAdapter = { id: 'deadline-generation', async *streamTurn() { assert.fail('No coding provider owner is admitted by this fixture'); }, streamGeneration(request) {
    calls++; let index = 0;
    const observeCompleted = () => {
      if (++probes > 32) return;
      const db = new DatabaseSync(dbPath, { readOnly: true }); let stored: { state: string; deadline: number; candidate: { state: string } };
      try { const row = db.prepare('SELECT data FROM knowledge_generations WHERE id=?').get(request.owner.generationId); assert.ok(row); stored = JSON.parse(String(row.data)); } finally { db.close(); }
      if (stored.state === 'completed' && stored.candidate.state === 'pending') {
        observedCompleted = true; originalDeadline = stored.deadline;
        const observerDeadline = Date.now() + 1_000;
        while (Date.now() <= stored.deadline) { assert.ok(Date.now() < observerDeadline, 'Host observer is bounded to one second'); }
      } else if (!['failed', 'cancelled', 'uncertain'].includes(stored.state)) queueMicrotask(observeCompleted);
    };
    return { [Symbol.asyncIterator]() { return { next: async () => { if (index++ === 0) return { done: false as const, value: { type: 'text.delta' as const, delta: 'Actual complete native knowledge.' } }; if (index === 2) return { done: false as const, value: { type: 'finish' as const, reason: 'stop' as const } }; queueMicrotask(observeCompleted); return { done: true as const, value: undefined }; }, return: async () => ({ done: true as const, value: undefined }) }; } };
  } };
  const engine = createEngine({ dbPath, artifactDir: join(base, 'artifacts'), providers: [provider], knowledgeGeneration: true, defaults: { providerId: provider.id, modelId: 'fixture-model' } });
  t.after(async () => { await engine.close(); rmSync(base, { recursive: true, force: true }); });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'workspace.open', payload: { path: root } }); assert.equal(opened.ok, true); const workspace = opened.result as unknown as Workspace;
  const trust = await engine.setWorkspaceTrust({ workspaceId: workspace.id, requestId: 'deadline-trust', expectedRevision: 0, decision: 'allow', preview: engine.previewWorkspaceTrust(workspace.id, ['AGENTS.md']) });
  const projection = engine.captureWorkspaceKnowledgeSources(workspace.id, [{ kind: 'file', path: 'source.ts' }]), logical = engine.previewWorkspaceKnowledgeGeneration({ providerId: provider.id, modelId: 'fixture-model', projection });
  const plan = await engine.prepareWorkspaceKnowledgeGeneration({ workspaceId: workspace.id, requestId: 'deadline-plan', expectedTrustRevision: trust.revision, projection, target: engine.captureWorkspaceKnowledgeTarget(workspace.id, 'MEMORY.md'), providerId: provider.id, modelId: 'fixture-model', requestSha256: logical.requestSha256, requestBytes: logical.requestBytes, maxOutputBytes: 1024, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const result = await engine.generateWorkspaceKnowledge({ workspaceId: workspace.id, planId: plan.id, requestId: 'deadline-generation', projection, budget: { maxDurationMs: 250, providerRequestTimeoutMs: 200, inactivityTimeoutMs: 150, cleanupTimeoutMs: 25 } });
  assert.equal(observedCompleted, true); assert.ok(probes <= 32); assert.equal(result.generation.state, 'completed'); assert.equal(result.generation.deadline, originalDeadline); assert.equal(result.attempt!.cleanup!.confirmed, true); assert.equal(result.generation.candidate.state, 'withheld'); assert.equal(result.generation.candidate.reason, 'KNOWLEDGE_GENERATION_DEADLINE'); assert.equal(result.candidate, null); assert.equal(calls, 1);
  const finished = await engine.finishWorkspaceKnowledgeCandidate({ workspaceId: workspace.id, generationId: result.generation.id, requestId: 'explicit-host-finish-after-original-deadline' });
  assert.equal(finished.generation.state, 'completed'); assert.equal(finished.generation.deadline, originalDeadline); assert.equal(finished.candidate!.body, 'Actual complete native knowledge.'); assert.equal(finished.candidate!.state, 'pending'); assert.equal(calls, 1);
});
