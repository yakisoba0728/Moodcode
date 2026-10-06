import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError, type InputImageAttachment } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import { png } from '../media/fixtures.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';

type Failure = 'HTTP retry' | 'overflow recovery';
function completed(content: string): AsyncIterable<ProviderEvent> {
  return { async *[Symbol.asyncIterator]() { yield { type: 'text.delta', delta: content }; yield { type: 'finish', reason: 'stop' }; } };
}
async function fixture(t: TestContext, failure: Failure, imageInput: boolean, cleanupDone: boolean) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-cleanup-proof-')));
  let started = false, mainCalls = 0, summaryCalls = 0, returnCalls = 0, overflowRecoveries = 0, wholeReads = 0;
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = { id: 'cleanup-proof', inputModalities: ['text', 'image'], streamTurn(request) {
    if (!request.turnId) { summaryCalls++; assert.deepEqual(request.tools, []); return completed('Preserve the earlier verified text goal.'); }
    if (!started) return completed('Completed earlier text-only history for a real overflow recovery.');
    requests.push(structuredClone(request)); mainCalls++;
    if (mainCalls > 1) return completed('Final result after confirmed cleanup.');
    return { [Symbol.asyncIterator]() { return {
      async next(): Promise<IteratorResult<ProviderEvent>> {
        throw failure === 'HTTP retry'
          ? new EngineError('PROVIDER_HTTP_ERROR', 'Synthetic retryable provider response', { status: 503 })
          : new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Synthetic explicit overflow before output');
      },
      async return(): Promise<IteratorResult<ProviderEvent>> {
        returnCalls++;
        return cleanupDone ? { done: true, value: undefined } : { done: false, value: { type: 'progress' } };
      },
    }; } };
  } };
  const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], allowedToolNames: [],
    defaults: { providerId: provider.id, modelId: 'fixture', mode: 'plan', limits: { maxContextBytes: 16384, maxDurationMs: 10000 }, budgets: { maxProviderAttempts: 2, retryBaseDelayMs: 1 } } });
  t.after(async () => { try { await engine.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: directory, gitRoot: directory, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Cleanup proof', createdAt });
  engine.store.getSnapshot = () => { wholeReads++; throw new Error('Cleanup proof fixtures use bounded native reads'); };
  const seed = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'older-text', prompt: 'Earlier text-only goal', config: engine.getCapabilities().defaults });
  assert.equal((await engine.waitForRun(seed.runId)).state, 'completed');
  const recover = engine.context.recoverOverflow.bind(engine.context);
  engine.context.recoverOverflow = async (request, selected) => { overflowRecoveries++; await recover(request, selected); };
  const bytes = png(); let attachment: InputImageAttachment | undefined;
  if (imageInput) attachment = await engine.importImage('session', bytes, 'image/png');
  started = true;
  const input = { sessionId: 'session', requestId: 'current', prompt: 'Current exact goal', config: engine.getCapabilities().defaults, ...(attachment ? { attachments: [attachment] } : {}) };
  const receipt = engine.scheduler.submitLegacy(input), run = await engine.waitForRun(receipt.runId);
  return { engine, input, receipt, run, attachment, bytes, requests, counts: () => ({ mainCalls, summaryCalls, returnCalls, overflowRecoveries, wholeReads }) };
}

for (const imageInput of [false, true]) for (const failure of ['HTTP retry', 'overflow recovery'] as const) {
  const label = imageInput ? 'resolved image' : 'text';
  test(`actual ${label} ${failure} rejects return done false and preserves uncertainty without redispatch`, { timeout: 10000 }, async t => {
    const f = await fixture(t, failure, imageInput, false);
    assert.equal(f.run.state, 'failed'); assert.equal(f.run.error?.code, 'CLEANUP_UNCERTAIN');
    assert.deepEqual(f.counts(), { mainCalls: 1, summaryCalls: 0, returnCalls: 1, overflowRecoveries: 0, wholeReads: 0 });
    const turns = f.engine.store.listTurns(f.run.id); assert.equal(turns.length, 1); assert.equal(turns[0]!.state, 'uncertain');
    assert.equal(turns[0]!.uncertainty?.kind, 'provider_dispatch');
    const events = f.engine.store.readSessionEvents('session', 0, 100).filter(event => event.runId === f.run.id && event.type === 'provider.attempt.prepared');
    assert.equal(events.length, 1); assert.ok(events[0]!.attemptId);
    const attempt = f.engine.store.getAttempt(events[0]!.attemptId);
    assert.equal(attempt.state, 'uncertain'); assert.equal(attempt.uncertainty?.requiresRecovery, true);
    const control = f.engine.store.getSessionControl('session'); assert.equal(control.paused, true); assert.equal(control.reason, 'recovery_required');
    assert.equal(f.engine.store.listSummaryAttempts('session', { runId: f.run.id }).attempts.length, 0);
    assert.equal(f.engine.coordinator.getRunUsage(f.run.id).outputBytes, 0);
    assert.equal(f.engine.store.getSessionDocument('session', 'context.memory'), null);
    const duplicate = f.engine.scheduler.submitLegacy(f.input); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.runId, f.run.id);
    assert.equal(f.counts().mainCalls, 1);
    assert.throws(() => f.engine.coordinator.submit({ ...f.input, requestId: 'blocked-new-run' }), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING');
    if (f.attachment) {
      assert.deepEqual(f.requests[0]!.resolvedImages, [{ attachment: f.attachment, data: f.bytes.toString('base64') }]);
      assert.deepEqual(f.engine.store.getInput(f.receipt.inputId).attachments, [f.attachment]);
    } else assert.equal(f.requests[0]!.resolvedImages, undefined);
  });

  test(`actual ${label} ${failure} permits the bounded next attempt only after return done true`, { timeout: 10000 }, async t => {
    const f = await fixture(t, failure, imageInput, true);
    assert.equal(f.run.state, 'completed', JSON.stringify(f.run.error));
    assert.deepEqual(f.counts(), { mainCalls: 2, summaryCalls: failure === 'overflow recovery' ? 1 : 0, returnCalls: 1, overflowRecoveries: failure === 'overflow recovery' ? 1 : 0, wholeReads: 0 });
    const turns = f.engine.store.listTurns(f.run.id); assert.equal(turns.length, 1); assert.equal(turns[0]!.state, 'completed');
    const events = f.engine.store.readSessionEvents('session', 0, 100).filter(event => event.runId === f.run.id && event.type === 'provider.attempt.prepared');
    assert.equal(events.length, 2); assert.equal(events[0]!.turnId, events[1]!.turnId); assert.notEqual(events[0]!.attemptId, events[1]!.attemptId);
    assert.equal(f.engine.store.getAttempt(events[0]!.attemptId!).state, 'failed'); assert.equal(f.engine.store.getAttempt(events[1]!.attemptId!).state, 'completed');
    assert.equal(f.engine.store.getSessionControl('session').paused, false);
    if (f.attachment) for (const request of f.requests) assert.deepEqual(request.resolvedImages, [{ attachment: f.attachment, data: f.bytes.toString('base64') }]);
  });
}
