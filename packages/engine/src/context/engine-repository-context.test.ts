import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineError, type JsonObject, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import type { LifecycleHookRegistration } from '../lifecycle/index.js';

async function fixture(t: test.TestContext, options: { stale?: 'hook' | 'retry'; includeContext?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-context-engine-'))), directory = join(base, 'repository'), source = join(directory, 'a.ts');
  await mkdir(directory); execFileSync('git', ['init', '--quiet', '--template=', directory]);
  await writeFile(source, 'repository_evidence_unique_marker\n');
  const requests: TurnRequest[] = [], hook: LifecycleHookRegistration = { id: 'source-change', revision: 1, stages: ['before-model'], order: 0, timeoutMs: 1000, failurePolicy: 'stop', async callback() { await writeFile(source, 'changed_source\n'); return { kind: 'observe' }; } };
  const provider: ProviderAdapter = { id: 'context-fixture', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request));
    if (options.stale === 'retry' && requests.length === 1) { await writeFile(source, 'changed_source\n'); throw new EngineError('PROVIDER_HTTP_ERROR', 'Fixture retry', { status: 429, retryAfterMs: 1 }); }
    yield { type: 'text.delta', delta: 'Fixture finished.' }; yield { type: 'finish', reason: 'stop' };
  } };
  const policy = { query: { kind: 'symbols' as const, paths: ['a.ts'] }, slotBytes: 8192, exactRanges: [{ path: 'a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 33 } } }] };
  const engine = createEngine({ dbPath: join(base, 'engine.sqlite'), artifactDir: join(base, 'artifacts'), providers: [provider], ...(options.includeContext === false ? {} : { repositoryContextPolicy: policy }), ...(options.stale === 'hook' ? { lifecycleHooks: [hook] } : {}), defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { maxDurationMs: 10000 } } });
  policy.query.paths[0] = 'changed-after-construction.ts';
  t.after(async () => { await engine.close(); await rm(base, { force: true, recursive: true }); });
  async function command<T>(type: string, payload: JsonObject): Promise<T> { const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(result.ok, true, JSON.stringify(result.error)); return result.result as unknown as T; }
  const workspace = await command<Workspace>('workspace.open', { path: directory }), session = await command<Session>('session.create', { workspaceId: workspace.id });
  const submitted = await command<RunReceipt>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Explain the selected source.' });
  return { directory, engine, session, requests, submitted };
}

test('actual engine inserts host-selected repository evidence into frozen model context', { timeout: 15000 }, async t => {
  const f = await fixture(t), run = await f.engine.waitForRun(f.submitted.runId);
  assert.equal(run.state, 'completed', JSON.stringify(run.error)); assert.equal(f.requests.length, 1);
  const evidence = f.requests[0]!.messages.find(value => value.content.includes('repository_evidence_unique_marker'))!;
  assert.ok(evidence); assert.equal(evidence.role, 'assistant'); assert.ok(evidence.content.includes('untrusted-repository-data'));
  assert.equal(f.requests[0]!.tools.length, 21);
  const diagnostic = f.engine.context.diagnostics(f.session.id)!;
  assert.equal(diagnostic.repositoryContext!.query.paths[0], 'a.ts'); assert.equal(JSON.stringify(diagnostic).includes('repository_evidence_unique_marker'), false);
  const revision = f.engine.store.getLatestContextRevision(f.session.id)!;
  assert.ok(revision.text.includes('repository_evidence_unique_marker')); assert.ok(revision.sourceIds.some(value => value.includes('repository')));
});

test('source changes during the awaited before-model hook prevent native provider dispatch', { timeout: 15000 }, async t => {
  const f = await fixture(t, { stale: 'hook' }), run = await f.engine.waitForRun(f.submitted.runId);
  assert.equal(run.state, 'failed'); assert.equal(f.requests.length, 0); assert.ok(run.error?.code.startsWith('REPOSITORY_'));
});

test('native provider retry cannot dispatch a frozen repository request after source mutation', { timeout: 15000 }, async t => {
  const f = await fixture(t, { stale: 'retry' }), run = await f.engine.waitForRun(f.submitted.runId);
  assert.equal(run.state, 'failed'); assert.equal(f.requests.length, 1); assert.ok(run.error?.code.startsWith('REPOSITORY_'));
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 0);
});

test('automatic repository evidence remains explicit opt-in', { timeout: 15000 }, async t => {
  const f = await fixture(t, { includeContext: false }), run = await f.engine.waitForRun(f.submitted.runId);
  assert.equal(run.state, 'completed'); assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.messages.some(value => value.content.includes('repository_evidence_unique_marker')), false);
  assert.equal(f.engine.context.diagnostics(f.session.id)!.repositoryContext, undefined);
});
