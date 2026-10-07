import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EngineError, type JsonObject, type ProviderAttempt, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import type { VerificationRemainingBudget } from './controller.js';
import { verificationHash } from './types.js';

const stop: ProviderEvent = { type: 'finish', reason: 'stop' };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Fixture {
  directory: string; source: string; dbPath: string; engine: ReturnType<typeof createEngine>; workspace: Workspace; session: Session; requests: TurnRequest[];
  submit(): Promise<RunReceipt>; command<T>(type: string, payload: JsonObject): Promise<T>; attempts(runId: string): ProviderAttempt[];
}
interface Options { maxTurns?: number; maxToolCalls?: number; repositoryContext?: boolean; script?: (request: TurnRequest, owned: Fixture) => AsyncIterable<ProviderEvent> }
async function fixture(t: TestContext, options: Options = {}): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-verification-controller-races-'))), directory = join(base, 'repository'), dbPath = join(base, 'engine.sqlite');
  await mkdir(directory); execFileSync('git', ['init', '--quiet', '--template=', directory]); const source = join(directory, 'a.ts'); await writeFile(source, 'const alpha = 1;\n');
  const requests: TurnRequest[] = []; let owned!: Fixture;
  const provider: ProviderAdapter = { id: 'controller-race-fixture', async *streamTurn(request): AsyncGenerator<ProviderEvent> {
    requests.push(structuredClone(request)); if (options.script) { yield* options.script(request, owned); return; }
    yield { type: 'text.delta', delta: 'Authored model prose is not verification evidence.' }; yield stop;
  } };
  const engine = createEngine({ dbPath, artifactDir: join(base, 'artifacts'), verificationTools: true, providers: [provider], ...(options.repositoryContext ? { repositoryContextPolicy: { query: { kind: 'symbols', paths: ['a.ts'] }, slotBytes: 4096 } } : {}), defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build', limits: { maxTurns: options.maxTurns ?? 4, maxToolCalls: options.maxToolCalls ?? 4, maxDurationMs: 15000 }, budgets: { maxProviderAttempts: 2, retryBaseDelayMs: 0 } }, agentProfiles: [{ id: 'verifier', description: 'Host race fixture checks', instructions: 'Use registered check IDs.', tools: ['verify_changes', 'run_command', 'read_file'] }] });
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  t.after(async () => { reader.close(); await engine.close(); await rm(base, { recursive: true, force: true }); });
  const command = async <T>(type: string, payload: JsonObject): Promise<T> => { const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload }); assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result as unknown as T; };
  const workspace = await command<Workspace>('workspace.open', { path: directory }), session = await command<Session>('session.create', { workspaceId: workspace.id }), profile = engine.profiles.list()[0]!;
  engine.registerVerificationCheck({ id: 'race-check', revision: 1, workspaceId: workspace.id, command: 'printf must-be-approved > verification-effect.txt', cwd: directory, profileId: profile.id, profileRevision: profile.revision, sourceRevision: 'host-race-check-v1', timeoutMs: 1000, maxOutputBytes: 4096, required: true });
  await engine.configureVerificationSession(session.id, 0, { checkIds: ['race-check'], sourcePaths: ['a.ts'], maxRepairs: 2 });
  const submit = () => command<RunReceipt>('run.submit', { sessionId: session.id, requestId: randomUUID(), prompt: 'Original owned task.', config: { agentProfileId: profile.id } });
  const attempts = (runId: string) => reader.prepare('SELECT data FROM provider_attempts WHERE run_id=? ORDER BY rowid').all(runId).map(row => JSON.parse(String(row.data)) as ProviderAttempt);
  owned = { directory, source, dbPath, engine, workspace, session, requests, submit, command, attempts };
  return owned;
}
function noCommandEffect(f: Fixture, runId: string) {
  assert.equal(existsSync(join(f.directory, 'verification-effect.txt')), false); assert.equal(f.engine.getVerificationState(f.session.id, runId)!.receipts.length, 0); assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
}

test('initial provider dispatch observes the captured host scope and genuine native records before any repair exists', { timeout: 10000 }, async t => {
  let firstObserved = false, firstFailure: unknown;
  const f = await fixture(t, { maxTurns: 2, repositoryContext: true, script: async function* (request, owned): AsyncGenerator<ProviderEvent> {
    if (!request.turnIndex) {
      try {
      firstObserved = true; const run = owned.engine.store.getRun(request.runId);
      assert.ok(owned.engine.store.getSessionDocument(owned.session.id, 'verification.scope.' + verificationHash(run.id).slice(0, 40)));
      assert.equal(owned.engine.getVerificationState(owned.session.id, run.id), null); assert.equal(owned.engine.getVerificationCompletion(owned.session.id, run.id), null);
      assert.equal(owned.engine.store.getTurn(request.turnId!).runId, run.id); assert.equal(owned.engine.store.getAttempt(request.attemptId!).state, 'dispatched'); assert.equal(owned.engine.store.getAttemptCleanup(request.attemptId!, owned.session.id).state, 'dispatched');
      assert.equal(request.messages.some(message => message.content.startsWith('[Moodcode verification control v1]')), false); assert.ok(request.messages.some(message => message.role === 'user' && message.content === 'Original owned task.'));
      } catch (error) { firstFailure = error; }
    }
    yield stop;
  } }), submitted = await f.submit(), run = await f.engine.waitForRun(submitted.runId);
  if (firstFailure) throw firstFailure;
  assert.equal(firstObserved, true); assert.equal(run.state, 'completed', JSON.stringify(run.error)); assert.equal(f.requests.length, 2); assert.equal(f.engine.store.listTurns(run.id).length, 2); assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 1); noCommandEffect(f, run.id);
});

test('same-Turn readonly HTTP retry rechecks the consumed boundary without widening original turns or tool budget', { timeout: 10000 }, async t => {
  let retried = false; const budgets: VerificationRemainingBudget[] = [];
  const f = await fixture(t, { maxTurns: 2, maxToolCalls: 1, script: async function* (request): AsyncGenerator<ProviderEvent> {
    if (request.turnIndex === 1 && !retried) {
      retried = true; request.messages[0]!.content = 'Adapter-local rewrite'; request.tools[0]!.name = 'adapter-local-tool';
      throw new EngineError('PROVIDER_HTTP_ERROR', 'Authored pre-output retry', { status: 429, retryAfterMs: 25 });
    }
    yield stop;
  } });
  f.engine.registerLifecycleHook({ id: 'natural-clock-decrease', revision: 1, stages: ['before-model'], callback: async invocation => { if (invocation.stage === 'before-model' && invocation.metadata.turnIndex === 1) await delay(20); } });
  const readBudget = f.engine.coordinator.verificationRemainingBudget.bind(f.engine.coordinator);
  f.engine.coordinator.verificationRemainingBudget = run => { const observed = readBudget(run); budgets.push({ ...observed }); return observed; };
  const submitted = await f.submit(), run = await f.engine.waitForRun(submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(run.state, 'completed', JSON.stringify(run.error)); assert.equal(f.requests.length, 3); assert.equal(f.engine.store.listTurns(run.id).length, 2);
  const first = f.requests[1]!, retry = f.requests[2]!; assert.equal(first.turnId, retry.turnId); assert.notEqual(first.attemptId, retry.attemptId); assert.deepEqual(retry.messages, first.messages); assert.deepEqual(retry.tools, first.tools);
  assert.equal(completion.repairsUsed, 1); assert.equal(completion.stages.length, 1); assert.equal(completion.boundaries.filter(boundary => boundary.phase === 'before-provider').length, 1); assert.equal(completion.result.taskVerified, false);
  assert.ok(budgets.some(budget => budget.turns === 0)); assert.ok(budgets.every(budget => budget.toolCalls === 1)); assert.ok(budgets.slice(1).every((budget, index) => budget.durationMs <= budgets[index]!.durationMs));
  for (const request of f.requests) { const cleanup = f.engine.store.getAttemptCleanup(request.attemptId!, f.session.id); assert.equal(cleanup.cleanupConfirmed, true); assert.equal(cleanup.requestSha256, digest(request)); }
  assert.equal(f.attempts(run.id).length, 3); noCommandEffect(f, run.id);
});

test('real read_file consumes the original tool allowance so missing verification cannot allocate another model repair', { timeout: 10000 }, async t => {
  const f = await fixture(t, { maxTurns: 4, maxToolCalls: 1, script: async function* (request): AsyncGenerator<ProviderEvent> {
    if (!request.turnIndex) { yield { type: 'tool.call', call: { id: 'actual-source-read', name: 'read_file', input: { path: 'a.ts' } } }; yield { type: 'finish', reason: 'tool_calls' }; }
    else yield stop;
  } }), submitted = await f.submit(), run = await f.engine.waitForRun(submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!, calls = f.engine.store.getSnapshot(f.session.id).tools;
  assert.equal(run.state, 'completed'); assert.equal(calls.length, 1); assert.equal(calls[0]!.state, 'completed'); assert.ok(calls[0]!.output!.includes('const alpha = 1')); assert.equal(completion.result.reason, 'budget_exhausted'); assert.equal(completion.repairsUsed, 0); assert.equal(f.requests.length, 2); noCommandEffect(f, run.id);
});

for (const repositoryContext of [false, true]) test(`before-model host source change after stage consumption blocks continuation dispatch (${repositoryContext ? 'repository context' : 'verification source'})`, { timeout: 10000 }, async t => {
  const f = await fixture(t, { repositoryContext }); let changed = false;
  f.engine.registerLifecycleHook({ id: 'source-change', revision: 1, stages: ['before-model'], callback: async invocation => {
    if (invocation.stage === 'before-model' && invocation.metadata.turnIndex === 1) {
      const completion = f.engine.getVerificationCompletion(f.session.id, invocation.identity.runId)!; assert.ok(completion.stages[0]!.consumedByBoundaryId); await writeFile(f.source, 'const alpha = 2;\n'); changed = true;
    }
  } });
  const submitted = await f.submit(), run = await f.engine.waitForRun(submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(changed, true); assert.equal(run.state, 'failed'); assert.equal(run.error?.code, repositoryContext ? 'REPOSITORY_CONTEXT_STALE' : 'VERIFICATION_CONTROLLER_BOUNDARY_CONFLICT'); assert.equal(f.requests.length, 1); assert.equal(completion.repairsUsed, 1); assert.equal(completion.stages.length, 1); assert.equal(completion.result.taskVerified, false);
  assert.equal(f.attempts(run.id).filter(attempt => attempt.dispatchedAt).length, 1); assert.equal(readFileSync(f.source, 'utf8'), 'const alpha = 2;\n'); noCommandEffect(f, run.id);
});

test('source change after a real retryable continuation attempt prevents the retry RPC and records no-dispatch cleanup', { timeout: 10000 }, async t => {
  const f = await fixture(t, { maxTurns: 3, script: async function* (request, owned): AsyncGenerator<ProviderEvent> {
    if (request.turnIndex === 1) { await writeFile(owned.source, 'const alpha = 9;\n'); throw new EngineError('PROVIDER_HTTP_ERROR', 'Authored pre-output retry after source change', { status: 429, retryAfterMs: 0 }); }
    yield stop;
  } }), submitted = await f.submit(), run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, 'failed'); assert.equal(run.error?.code, 'VERIFICATION_CONTROLLER_BOUNDARY_CONFLICT'); assert.equal(f.requests.length, 2); assert.equal(f.engine.getVerificationCompletion(f.session.id, run.id)!.repairsUsed, 1);
  const attempts = f.attempts(run.id); assert.equal(attempts.length, 3); const undispatched = attempts.find(attempt => !attempt.dispatchedAt)!; assert.ok(undispatched); assert.equal(f.engine.store.getAttemptCleanup(undispatched.id, f.session.id).state, 'not-dispatched'); noCommandEffect(f, run.id);
});

test('steer during pending continuation context construction is promoted before capture with the same one-use stage', { timeout: 10000 }, async t => {
  const f = await fixture(t, { maxTurns: 3 }); const build = f.engine.context.build.bind(f.engine.context); let steerId: string | null = null;
  f.engine.context.build = async request => {
    const messages = await build(request);
    if (request.verificationContinuation && !steerId) {
      steerId = f.engine.scheduler.accept({ sessionId: f.session.id, requestId: 'context-steer', prompt: 'Latest actual steer.', delivery: 'steer', config: request.config }).inputId;
    }
    return messages;
  };
  const submitted = await f.submit(), run = await f.engine.waitForRun(submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(run.state, 'completed'); assert.equal(f.requests.length, 2); assert.ok(steerId); assert.equal(f.engine.store.getInput(steerId).state, 'promoted'); assert.equal(f.engine.store.getInput(steerId).runId, run.id);
  const continuation = f.requests[1]!; assert.ok(continuation.messages.some(message => message.role === 'user' && message.content === 'Latest actual steer.')); assert.equal(continuation.messages.filter(message => message.content.startsWith('[Moodcode verification control v1]')).length, 1);
  assert.ok(f.engine.store.getTurn(continuation.turnId!).inputIds.includes(steerId)); assert.equal(completion.repairsUsed, 1); assert.equal(completion.boundaries.filter(boundary => boundary.phase === 'before-provider').length, 1); assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 1); noCommandEffect(f, run.id);
});

test('steer after continuation consumption stays outside the frozen attempt and joins the next genuine Turn within the absolute Run ceiling', { timeout: 10000 }, async t => {
  const f = await fixture(t, { maxTurns: 3 }); let steerId: string | null = null;
  f.engine.registerLifecycleHook({ id: 'late-steer', revision: 1, stages: ['before-model'], callback: invocation => {
    if (invocation.stage === 'before-model' && invocation.metadata.turnIndex === 1 && !steerId) {
      assert.ok(f.engine.getVerificationCompletion(f.session.id, invocation.identity.runId)!.stages[0]!.consumedByBoundaryId);
      steerId = f.engine.scheduler.accept({ sessionId: f.session.id, requestId: 'late-steer', prompt: 'Steer after frozen continuation.', delivery: 'steer', config: f.engine.store.getRun(invocation.identity.runId).config }).inputId;
    }
  } });
  const submitted = await f.submit(), run = await f.engine.waitForRun(submitted.runId), completion = f.engine.getVerificationCompletion(f.session.id, run.id)!;
  assert.equal(run.state, 'completed'); assert.equal(f.requests.length, 3); assert.equal(f.engine.store.listTurns(run.id).length, run.config.limits.maxTurns); assert.equal(completion.repairsUsed, 1); assert.equal(completion.stages.length, 1); assert.equal(completion.result.reason, 'stalled');
  assert.equal(f.requests[1]!.messages.some(message => message.content === 'Steer after frozen continuation.'), false); assert.ok(f.requests[2]!.messages.some(message => message.content === 'Steer after frozen continuation.')); assert.equal(f.requests[2]!.messages.some(message => message.content.startsWith('[Moodcode verification control v1]')), false);
  assert.ok(steerId); assert.equal(f.engine.store.getInput(steerId).runId, run.id); assert.equal(new Set(f.requests.map(request => request.runId)).size, 1); noCommandEffect(f, run.id);
});
