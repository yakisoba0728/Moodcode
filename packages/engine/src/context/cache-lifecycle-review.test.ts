import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type RunConfig } from '@moodcode/contracts';
import { createEngine, type EngineStorageUsageOptions } from '../engine.js';
import type { ProviderMessage } from '../ports.js';
import { SqliteStore } from '../storage/index.js';
import { ContextService } from './service.js';
import { InstructionSources } from './sources.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t: TestContext, sessionCount: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-context-lru-review-'))), store = new SqliteStore(':memory:');
  const createdAt = new Date().toISOString(), config: RunConfig = { providerId: 'fixture', modelId: 'fixture', mode: 'plan', limits: { ...DEFAULT_LIMITS } };
  store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  for (let index = 0; index < sessionCount; index++) store.createSession({ id: 'session-' + index, workspaceId: 'workspace', title: 'Concurrent cache review', createdAt });
  await writeFile(join(root, 'AGENTS.md'), 'Verified local instruction baseline 🌿');
  const service = new ContextService(store);
  const build = (sessionId: string, signal = new AbortController().signal) => service.build({ workspace: store.getWorkspace('workspace'), snapshot: service.snapshot(sessionId, config), config, signal });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, service, build };
}

test('a pending instruction observation stays pinned while enough new sessions evict every idle LRU entry', async t => {
  const f = await fixture(t, 256);
  for (let index = 0; index < 128; index++) await f.build('session-' + index);
  const original = InstructionSources.prototype.observe, acquired = deferred(), release = deferred();
  const observed: InstructionSources[] = []; let held: Promise<ProviderMessage[]> | undefined;
  t.mock.method(InstructionSources.prototype, 'observe', async function (this: InstructionSources, ...args: Parameters<InstructionSources['observe']>) {
    observed.push(this);
    const observation = await original.apply(this, args);
    if (observed.length === 1) { acquired.resolve(); await release.promise; }
    return observation;
  });
  try {
    held = f.build('session-0'); await acquired.promise;
    // Session 0 was refreshed to MRU on admission. 128 new sessions are
    // sufficient to reach it again; eviction must still skip its live lease.
    for (let index = 128; index < 256; index++) await f.build('session-' + index);
    release.resolve(); assert.ok((await held).some(message => message.content.includes('Verified local instruction baseline 🌿')));
    assert.ok((await f.build('session-0')).some(message => message.content.includes('Verified local instruction baseline 🌿')));
    assert.equal(observed.at(-1), observed[0], 'LRU evicted an instruction reader while its observation was pinned');
    assert.equal(f.service.diagnostics('session-0')?.instructions.sources[0]?.retainedBaseline, false);
  } finally { release.resolve(); await Promise.allSettled(held ? [held] : []); t.mock.restoreAll(); }
});

test('all-pinned capacity rejects admission, then cancellation and durable baseline failure each release a reusable slot', async t => {
  const f = await fixture(t, 130), original = InstructionSources.prototype.observe;
  const controllers = Array.from({ length: 130 }, () => new AbortController());
  const gates = controllers.map(() => deferred()), entered = controllers.map(() => deferred());
  const ownership = new Map(controllers.map((controller, index) => [controller.signal, index]));
  type Outcome = { ok: true; messages: ProviderMessage[] } | { ok: false; error: unknown };
  const jobs: Promise<Outcome>[] = [];
  const start = (index: number) => {
    const job = f.build('session-' + index, controllers[index]!.signal).then(
      messages => ({ ok: true as const, messages }), error => ({ ok: false as const, error }),
    );
    jobs.push(job); return job;
  };
  t.mock.method(InstructionSources.prototype, 'observe', async function (this: InstructionSources, ...args: Parameters<InstructionSources['observe']>) {
    const signal = args[1], index = ownership.get(signal);
    if (index !== undefined) {
      entered[index]!.resolve(); const aborted = () => gates[index]!.resolve();
      signal.addEventListener('abort', aborted, { once: true });
      try { if (!signal.aborted) await gates[index]!.promise; } finally { signal.removeEventListener('abort', aborted); }
    }
    return original.apply(this, args);
  });
  const originalPut = f.store.putSessionDocument.bind(f.store); let failedOnce = false;
  t.mock.method(f.store, 'putSessionDocument', (...args: Parameters<SqliteStore['putSessionDocument']>) => {
    if (args[0] === 'session-1' && args[1].startsWith('instruction.') && !failedOnce) {
      failedOnce = true; throw new EngineError('FIXTURE_BASELINE_WRITE_FAILED', 'Controlled durable baseline failure');
    }
    return originalPut(...args);
  });
  try {
    const initial = Array.from({ length: 128 }, (_, index) => start(index));
    await Promise.all(entered.slice(0, 128).map(item => item.promise));
    await assert.rejects(f.build('session-128', controllers[128]!.signal), error => error instanceof EngineError && error.code === 'WORKSPACE_CONTEXT_LIMIT');
    assert.equal(f.store.getSessionDocument('session-128', 'context.head'), null);
    controllers[0]!.abort(); const cancelled = await initial[0]!;
    assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.ok(cancelled.error instanceof EngineError && cancelled.error.code === 'CANCELLED');
    const afterAbort = start(128); await entered[128]!.promise;
    await assert.rejects(f.build('session-129', controllers[129]!.signal), error => error instanceof EngineError && error.code === 'WORKSPACE_CONTEXT_LIMIT');
    gates[1]!.resolve(); const failed = await initial[1]!;
    assert.equal(failed.ok, false); if (!failed.ok) assert.ok(failed.error instanceof EngineError && failed.error.code === 'FIXTURE_BASELINE_WRITE_FAILED');
    assert.equal(f.store.getSessionDocument('session-1', 'context.head'), null);
    const afterFailure = start(129); await entered[129]!.promise;
    for (const gate of gates) gate.resolve();
    const outcomes = await Promise.all(jobs);
    assert.equal(outcomes.filter(outcome => outcome.ok).length, 128); assert.equal(outcomes.filter(outcome => !outcome.ok).length, 2);
    assert.equal((await afterAbort).ok, true); assert.equal((await afterFailure).ok, true);
    // The failed reader was evicted to admit session 129. A fresh read must
    // persist a genuine baseline and complete, with no leaked live lease.
    assert.ok((await f.build('session-1')).some(message => message.content.includes('Verified local instruction baseline 🌿')));
    assert.equal(f.service.diagnostics('session-1')?.instructions.sources[0]?.retainedBaseline, false);
  } finally {
    for (const controller of controllers) controller.abort(); for (const gate of gates) gate.resolve();
    await Promise.allSettled(jobs); t.mock.restoreAll();
  }
});

test('the storage host facade rejects invalid signal and falsy/oversized limits instead of treating them as omitted', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-storage-boundary-review-'))), engine = createEngine({ dbPath: ':memory:', artifactDir: join(root, 'artifacts') });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const original = engine.store.inspectInputImageIndex.bind(engine.store); let indexCalls = 0;
  t.mock.method(engine.store, 'inspectInputImageIndex', (...args: Parameters<SqliteStore['inspectInputImageIndex']>) => { indexCalls++; return original(...args); });
  for (const signal of [null, false, 0, 'fixture-private-value', {}, []]) {
    await assert.rejects(engine.getStorageUsage({ signal } as unknown as EngineStorageUsageOptions), error => error instanceof EngineError && error.code === 'INVALID_STORAGE_USAGE_OPTIONS' && !error.message.includes('fixture-private-value'));
  }
  assert.equal(indexCalls, 0, 'Invalid signals reached the primary database inspection');
  for (const limits of [null, false, 0, 'fixture-private-value', [], { maxEntries: 0 }, { maxReportBytes: 4_095 }, { maxDepth: 33 }, { unknown: 1 }]) {
    await assert.rejects(engine.getStorageUsage({ limits } as unknown as EngineStorageUsageOptions), error => error instanceof EngineError && error.code === 'INVALID_STORAGE_USAGE_OPTIONS' && !error.message.includes('fixture-private-value'));
  }
  const abort = new AbortController(); abort.abort('fixture-private-abort-reason');
  await assert.rejects(engine.getStorageUsage({ signal: abort.signal }), error => error instanceof EngineError && error.code === 'CANCELLED' && !error.message.includes('fixture-private-abort-reason'));
  assert.equal((await engine.getStorageUsage()).complete, true);
});
