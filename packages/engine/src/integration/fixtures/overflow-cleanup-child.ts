import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EngineError } from '@moodcode/contracts';
import { createEngine } from '../../engine.js';
import type { ProviderAdapter, ProviderEvent } from '../../ports.js';

// The parent stops only this private synthetic provider and temporary DB.
const [root, phase] = process.argv.slice(2);
if (!root || !['summary-usage','summary-uncertain'].includes(phase!)) throw new Error('Invalid overflow cleanup crash fixture');
const repository = join(root, 'repository'); mkdirSync(repository);
let calls = 0;
const provider: ProviderAdapter = { id: 'overflow-cleanup-crash', streamTurn(request) {
  appendFileSync(join(root, 'calls.log'), `${++calls}\n`, { mode: 0o600 });
  if (calls === 1) return (async function* (): AsyncGenerator<ProviderEvent> {
    yield { type: 'text.delta', delta: 'Synthetic historical discussion. '.repeat(285) };
    yield { type: 'finish', reason: 'stop' };
  })();
  if (calls === 2) {
    const iterator: AsyncIterableIterator<ProviderEvent> = { [Symbol.asyncIterator]() { return iterator; }, async next(): Promise<IteratorResult<ProviderEvent>> {
    throw new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Synthetic overflow before current output');
    }, async return() { return { done: true as const, value: undefined }; } };
    return iterator;
  }
  if (calls !== 3 || request.turnId || request.tools.length) throw new Error('Unexpected synthetic provider request');
  let index = 0;
  const iterator: AsyncIterableIterator<ProviderEvent> = { [Symbol.asyncIterator]() { return iterator; }, async next(): Promise<IteratorResult<ProviderEvent>> {
    if (index++ === 0) return { done: false, value: { type: 'usage', inputTokens: 9 } };
    if (index === 2) return { done: false, value: { type: 'text.delta', delta: 'Synthetic partial overflow memory.' } };
    throw new EngineError('PROVIDER_TRANSPORT_ERROR', 'Synthetic summary has no cleanup operation');
  } }; return iterator;
} };
const engine = createEngine({ dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
  defaults: { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { maxContextBytes: 16384, maxOutputBytes: 32768 } } });
const createdAt = new Date().toISOString();
engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Overflow crash frontier', createdAt });
engine.store.getSnapshot = () => { throw new Error('Overflow crash child forbids full snapshots'); };
const config = engine.getCapabilities().defaults;
const first = engine.coordinator.submit({ sessionId: 'session', requestId: 'historical', prompt: 'Exact synthetic historical overflow goal.', config });
if ((await engine.waitForRun(first.runId)).state !== 'completed') throw new Error('Historical crash fixture failed');
await engine.waitForSession('session');
function stop(summaryAttemptId: string): never {
  const summary = engine.getSummaryAttempt('session', summaryAttemptId);
  if (!summary.currentTurnId || !summary.failedAttemptId) throw new Error('Overflow origin missing');
  process.send?.({ phase, summaryAttemptId, turnId: summary.currentTurnId, attemptId: summary.failedAttemptId, runId: summary.runId });
  process.kill(process.pid, 'SIGSTOP');
  throw new Error('Stopped fixture must never resume');
}
const observe = engine.store.observeSummaryAttempt.bind(engine.store), settle = engine.store.settleSummaryAttempt.bind(engine.store);
engine.store.observeSummaryAttempt = (id, observation) => {
  const value = observe(id, observation); if (phase === 'summary-usage' && observation.usage) stop(id); return value;
};
engine.store.settleSummaryAttempt = (id, outcome) => {
  const value = settle(id, outcome); if (phase === 'summary-uncertain' && value.state === 'uncertain') stop(id); return value;
};
const failed = engine.coordinator.submit({ sessionId: 'session', requestId: 'overflow', prompt: 'Exact synthetic ordinary cleanup fixture goal.', config });
await engine.waitForRun(failed.runId); throw new Error('Child missed the exact overflow crash frontier');
