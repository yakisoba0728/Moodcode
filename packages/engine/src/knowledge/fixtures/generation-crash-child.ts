import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../../engine.js';
import type { ProviderAdapter, ProviderEvent } from '../../ports.js';
import type { HostGenerationRequest } from '../../provider/generation.js';
import { KnowledgeGenerationStorage } from '../generation-store.js';
import type { KnowledgeGenerationObservation, KnowledgeGenerationSettlement } from '../generation-types.js';
import type { KnowledgeSourceSelection } from '../host.js';
import { KnowledgeStorage } from '../store.js';
import { canonicalKnowledge, sha256 } from '../validation.js';

/** This worker changes no durable row itself: each boundary follows the original successful SQL API. */
const [directoryArgument, phaseArgument] = process.argv.slice(2);
if (!directoryArgument || !['create', 'prepare', 'dispatch', 'finish', 'settle', 'candidate'].includes(phaseArgument!)) throw new Error('Invalid host generation crash phase');
const directory = directoryArgument, phase = phaseArgument!;
const config = JSON.parse(readFileSync(join(directory, 'crash-config.json'), 'utf8')) as {
  workspaceId: string; planId: string; requestId: string; requestSha256: string; requestBytes: number; selection: KnowledgeSourceSelection[];
};
const providerId = 'generation-crash-fixture';
const provider: ProviderAdapter = {
  id: providerId,
  async *streamTurn() { appendFileSync(join(directory, 'unexpected-coding.log'), 'UNEXPECTED\n'); throw new Error('Crash worker must not create a coding Turn'); },
  streamGeneration(request: HostGenerationRequest) {
    appendFileSync(join(directory, 'generation-calls.jsonl'), JSON.stringify({ owner: request.owner, sha256: sha256(canonicalKnowledge(request)), bytes: Buffer.byteLength(canonicalKnowledge(request)) }) + '\n', { mode: 0o600 });
    let index = 0;
    const events: ProviderEvent[] = [
      { type: 'usage', inputTokens: 11, outputTokens: 5, cachedInputTokens: 3, reasoningOutputTokens: 1 },
      { type: 'text.delta', delta: 'Native child output before crash.\n' },
      { type: 'finish', reason: 'stop' },
    ];
    const iterator: AsyncIterableIterator<ProviderEvent> = {
      [Symbol.asyncIterator]() { return iterator; },
      async next() { const event = events[index++]; return event ? { done: false, value: event } : { done: true, value: undefined }; },
      async return() { appendFileSync(join(directory, 'iterator-returns.log'), 'actual-return\n'); return { done: true, value: undefined }; },
    };
    return iterator;
  },
};
const engine = createEngine({ dbPath: join(directory, 'engine.sqlite'), artifactDir: join(directory, 'artifacts'), providers: [provider], knowledgeGeneration: true,
  defaults: { providerId, modelId: 'fixture-model', mode: 'plan', limits: { maxTurns: 3, maxDurationMs: 10000 } } });
let stopped = false;
function stop(generationId: string): void {
  assert.equal(stopped, false); stopped = true;
  const native = Reflect.get(engine, 'knowledgeGenerations') as KnowledgeGenerationStorage;
  assert.ok(native instanceof KnowledgeGenerationStorage);
  const generation = native.getGeneration(config.workspaceId, generationId);
  const attempt = generation.attemptId ? native.getAttempt(config.workspaceId, generation.attemptId) : null;
  const candidate = engine.workspaceKnowledge.getCandidateByGeneration(config.workspaceId, generationId) ?? null;
  // Synchronous readiness publication prevents IPC buffering from changing the exact stop boundary.
  writeFileSync(join(directory, 'crash-ready.json'), JSON.stringify({ phase, generation, attempt, candidate }), { mode: 0o600 });
  process.kill(process.pid, 'SIGSTOP');
  throw new Error('Parent must SIGKILL this stopped fixture rather than resume it');
}

function wrap(prototype: object, name: string, observe: (result: unknown, args: readonly unknown[]) => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  assert.equal(typeof descriptor?.value, 'function', `Actual native method ${name} must exist`);
  const original = descriptor!.value as (...args: unknown[]) => unknown;
  Object.defineProperty(prototype, name, { ...descriptor, value(this: unknown, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args);
    assert.equal(Boolean(result && typeof result === 'object' && 'then' in result), false, 'Native SQL instrumentation must not cross an await');
    observe(result, args); return result;
  } });
}
if (phase === 'create') wrap(KnowledgeGenerationStorage.prototype, 'create', result => {
  const value = result as { kind: string; record: { id: string } }; if (value.kind === 'created') stop(value.record.id);
});
if (phase === 'prepare') wrap(KnowledgeGenerationStorage.prototype, 'prepareAttempt', (_result, args) => stop((args[0] as { generationId: string }).generationId));
if (phase === 'dispatch') wrap(KnowledgeGenerationStorage.prototype, 'dispatch', (_result, args) => stop((args[0] as { generationId: string }).generationId));
if (phase === 'finish') wrap(KnowledgeGenerationStorage.prototype, 'observe', (_result, args) => {
  if ((args[2] as KnowledgeGenerationObservation).finishReason === 'stop') stop((args[0] as { generationId: string }).generationId);
});
if (phase === 'settle') wrap(KnowledgeGenerationStorage.prototype, 'settle', (_result, args) => {
  if ((args[2] as KnowledgeGenerationSettlement).state === 'completed') stop((args[0] as { generationId: string }).generationId);
});
if (phase === 'candidate') wrap(KnowledgeStorage.prototype, 'appendCandidate', result => stop((result as { generationOwnerId: string }).generationOwnerId));

const projection = engine.captureWorkspaceKnowledgeSources(config.workspaceId, config.selection);
const preview = engine.previewWorkspaceKnowledgeGeneration({ providerId, modelId: 'fixture-model', projection });
assert.equal(preview.requestSha256, config.requestSha256); assert.equal(preview.requestBytes, config.requestBytes);
await engine.generateWorkspaceKnowledge({ workspaceId: config.workspaceId, planId: config.planId, requestId: config.requestId, projection });
throw new Error(`Actual engine did not reach durable ${phase} boundary`);
