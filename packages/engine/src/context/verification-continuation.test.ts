import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type RunConfig } from '@moodcode/contracts';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';
import { BudgetAccount } from '../config/budgets.js';
import { LspManager } from '../lsp/index.js';
import type { ContextRequest, ProviderAdapter, ProviderMessage, TurnRequest } from '../ports.js';
import { RepositoryContextService } from '../repository/index.js';
import { SqliteStore } from '../storage/index.js';
import { TurnExecutor } from '../runner/turn-executor.js';
import { ContextService } from './service.js';
import { planContext } from './plan.js';
import { RepositoryContextSource } from './repository-contributions.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const signal = () => new AbortController().signal;
function control(stageId = 'repair_stage_one', padding = ''): ProviderMessage {
  return { role: 'user', content: '[Moodcode verification control v1]\n' + JSON.stringify({ kind: 'verification-continuation', version: 1, stageId, repairOrdinal: 1, reason: 'check_missing', checkIds: ['registered-tests'], sourceSha256: sha('source'), executionAuthority: 'none', instruction: 'Continue the existing task within its original budget. ' + padding }) };
}
async function fixture(t: TestContext, limit = 4096) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-verification-context-'))), store = new SqliteStore(':memory:'), lsp = new LspManager();
  t.after(async () => { await lsp.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet', '--template=', root]); await writeFile(join(root, 'source.ts'), 'export const authored = "local evidence";\n');
  const stamp = new Date().toISOString(), workspace = store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp });
  store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Verification control context', createdAt: stamp });
  const config: RunConfig = { providerId: 'fixture', modelId: 'model', mode: 'build', limits: { ...DEFAULT_LIMITS, maxContextBytes: limit }, budgets: normalizeEngineBudgets({ retryBaseDelayMs: 0 }) };
  const receipt = store.admit({ sessionId: 'session', requestId: 'request', prompt: 'Preserve the exact current user goal', config }); store.commit(receipt.runId, 'run.started', {}, { run: { state: 'running' } });
  const run = store.getRun(receipt.runId), source = new RepositoryContextSource(new RepositoryContextService(lsp, () => null));
  let preparations = 0, freshnessHook: (() => Promise<void>) | undefined;
  const reservations: number[] = [];
  const service = new ContextService(store, undefined, 32, undefined, { repositoryContext: { source: {
    prepare: request => { preparations++; reservations.push(request.budget.requiredMessagesBytes); return source.prepare(request); },
    assertFresh: async (...args) => { await freshnessHook?.(); await source.assertFresh(...args); },
  }, policy: { query: { kind: 'symbols', paths: ['source.ts'] }, slotBytes: 4096, exactRanges: [{ path: 'source.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 39 } } }] } } });
  const request = (continuation = control()): ContextRequest => ({ workspace, snapshot: service.snapshot('session', config), config, run, signal: signal(), reservedBytes: 64, verificationContinuation: continuation });
  let invocations = 0, lastExecutor: TurnExecutor | undefined; const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'fixture', async *streamTurn(value) { invocations++; requests.push(structuredClone(value)); yield { type: 'finish', reason: 'stop' }; } };
  const execute = async (messages: ProviderMessage[]) => {
    const budget = new BudgetAccount(config); budget.startTurn();
    const executor = new TurnExecutor({ run, index: 0, inputIds: [run.inputId], budget, store, wait: (operation) => operation(), contextRevisionId: service.revisionId('session'), currentContextRevisionId: () => service.revisionId('session'), assertContextFresh: (value, currentSignal) => service.assertFresh('session', value.messages, currentSignal, run.id) });
    lastExecutor = executor;
    try { for await (const _event of executor.stream(provider, { runId: run.id, turnIndex: 0, modelId: config.modelId, messages, tools: [] }, signal())) { /* Consume the actual adapter iterator. */ } executor.outputFinished('stop', false); }
    catch (error) { executor.fail(error); throw error; }
    return executor;
  };
  return { root, store, config, run, service, request, execute, requests, get reservations() { return [...reservations]; }, get lastExecutor() { return lastExecutor; }, get preparations() { return preparations; }, get invocations() { return invocations; }, set freshnessHook(value: typeof freshnessHook) { freshnessHook = value; } };
}

test('required verification control reaches the actual provider as one bounded user message and binds native context serialization', async t => {
  const f = await fixture(t), continuation = control(), messages = await f.service.build(f.request(continuation));
  assert.deepEqual(messages.at(-1), continuation); assert.equal(messages.filter(message => message.content.startsWith('[Moodcode verification control v1]')).length, 1);
  assert.ok(messages.some(message => message.role === 'user' && message.content === f.run.prompt));
  const revision = f.store.getLatestContextRevision('session')!; assert.equal(revision.text, JSON.stringify(messages)); assert.equal(revision.sha256, sha(revision.text));
  assert.equal(f.service.diagnostics('session')!.plan.sha256, sha(JSON.stringify(messages))); assert.ok(Buffer.byteLength(JSON.stringify(messages)) + 64 <= f.config.limits.maxContextBytes);
  await f.execute(messages); assert.equal(f.invocations, 1); assert.deepEqual(f.requests[0]!.messages, messages); assert.equal(f.requests[0]!.runId, f.run.id);
  assert.equal(f.store.listTurns(f.run.id)[0]!.state, 'completed'); assert.equal(f.config.limits.maxContextBytes, 4096);
});

test('tight actual ContextService reserves mandatory control and transcript before preparing optional evidence once', async t => {
  const f = await fixture(t, 1536), continuation = control('tight-stage', 'x'.repeat(300)), request = f.request(continuation), base = await planContext(request, { outputTokens: 32, requiredOnly: true });
  assert.ok(base.bytes < 1536); const messages = await f.service.build(request);
  assert.equal(f.preparations, 1); assert.deepEqual(f.reservations, [base.bytes - 64]);
  assert.ok(f.reservations[0]! > Buffer.byteLength(continuation.content) + Buffer.byteLength(f.run.prompt));
  assert.deepEqual(messages.at(-1), continuation); assert.ok(messages.some(message => message.content === f.run.prompt));
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) + 64 <= 1536); assert.equal(f.service.diagnostics('session')!.repositoryContext!.omissions.message, true);
  assert.equal(f.service.diagnostics('session')!.repositoryContext!.omissions.contextBudget, 1); await f.execute(messages); assert.equal(f.invocations, 1);
});

test('oversize required control fails explicitly before any native Turn or provider dispatch', async t => {
  const f = await fixture(t), oversized: ProviderMessage = { role: 'user', content: 'x'.repeat(9217) };
  await assert.rejects((async () => { const messages = await f.service.build(f.request(oversized)); await f.execute(messages); })(), code('VERIFICATION_CONTEXT_LIMIT'));
  assert.equal(f.invocations, 0); assert.equal(f.store.listTurns(f.run.id).length, 0); assert.equal(f.store.getLatestContextRevision('session'), null);
});

test('modified frozen control and changed physical source reject before adapter dispatch with actual no-dispatch cleanup', async t => {
  for (const mutation of ['control', 'source'] as const) {
    const f = await fixture(t), messages = await f.service.build(f.request());
    if (mutation === 'control') messages.at(-1)!.content += ' changed frozen control'; else await writeFile(join(f.root, 'source.ts'), 'export const authored = "changed physical source";\n');
    await assert.rejects(f.execute(messages), code('REPOSITORY_CONTEXT_STALE')); assert.equal(f.invocations, 0);
    const turn = f.store.listTurns(f.run.id)[0]!, attempt = f.store.getAttempt(f.lastExecutor!.attemptId!); assert.equal(turn.state, 'failed'); assert.equal(attempt.state, 'failed'); assert.equal(attempt.dispatchedAt, undefined);
    const cleanup = f.store.getAttemptCleanup(attempt.id)!; assert.equal(cleanup.state, 'not-dispatched'); assert.equal(cleanup.method, 'no-dispatch'); assert.equal(cleanup.cleanupConfirmed, null);
  }
});

test('replaced opaque source capture cannot approve an old awaited freshness check even with identical control text and revision', async t => {
  const f = await fixture(t), request = f.request(), first = await f.service.build(request), revision = f.service.revisionId('session');
  let entered!: () => void, release!: () => void, checks = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.freshnessHook = async () => { if (++checks === 1) { entered(); await gate; } };
  const pending = f.service.assertFresh('session', first, signal(), f.run.id), rejected = assert.rejects(pending, code('REPOSITORY_CONTEXT_STALE'));
  await started; const second = await f.service.build(request); assert.deepEqual(second, first); assert.equal(f.service.revisionId('session'), revision);
  release(); await rejected; await f.service.assertFresh('session', second, signal(), f.run.id); assert.equal(f.invocations, 0);
});
