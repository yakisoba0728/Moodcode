import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { EngineError } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { RunCoordinator } from './index.js';
import type { EngineStore } from '../ports.js';

const hasCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  const store = new SqliteStore(':memory:');
  store.putWorkspace({ id: 'workspace', root: '/fixture/host-generation', gitRoot: '/fixture/host-generation', branch: null, createdAt: '2026-10-08T00:00:00.000Z' });
  const native = new Set<string>();
  // A trusted custom native storage port; later Engine tests exercise actual generation tables.
  (store as EngineStore).hasUncertainKnowledgeGeneration = workspaceId => native.has(workspaceId);
  const legacyBlocker = (workspaceId: string) => store.hasUncertainSummaries(workspaceId) || store.hasUncertainExecution(workspaceId);
  store.hasUncertainWorkspace = workspaceId => native.has(workspaceId) || legacyBlocker(workspaceId);
  const coordinator = new RunCoordinator({ store, providers: new Map(), tools: [], artifactDir: '/fixture/artifacts',
    approvals: { async request() { throw new Error('No generation tool approval'); }, decide() { throw new Error('No generation tool approval'); }, cancelRun() {} },
    buildContext: async () => { throw new Error('Host generation cannot prepare coding context'); } });
  return { store, native, coordinator };
}

test('durably quarantined host generation can be acknowledged without poisoning unrelated runtime effect ownership', async () => {
  const f = fixture(); let idle = 0;
  f.coordinator.setSessionHooks({ boundary: () => false, cancelled() {}, settled() {}, workspaceIdle() { idle++; } });
  try {
    const receipt = await f.coordinator.withHostGenerationLease('workspace', async () => {
      f.native.add('workspace'); return { state: 'uncertain', cleanupConfirmed: false, executionBlocked: true };
    });
    assert.equal(receipt.state, 'uncertain'); assert.equal(idle, 1);
    assert.throws(() => f.coordinator.assertWorkspaceCleanupConfirmed('workspace'), hasCode('CLEANUP_PENDING'));
    await assert.rejects(f.coordinator.withHostGenerationLease('workspace', async () => 0), hasCode('CLEANUP_PENDING'));
    const observed = await f.coordinator.withRecoveryDecisionLease('workspace', async () => {
      f.native.delete('workspace'); return { providerRetried: false, executionResumed: false };
    });
    assert.deepEqual(observed, { providerRetried: false, executionResumed: false }); assert.equal(idle, 1);
    assert.doesNotThrow(() => f.coordinator.assertWorkspaceAvailable('workspace'));
  } finally { await f.coordinator.close(); f.store.close(); }
});

test('a claimed native quarantine without authoritative storage evidence fails closed', async () => {
  for (const supplied of [false, undefined] as const) {
    const f = fixture();
    if (supplied === undefined) Object.defineProperty(f.store, 'hasUncertainKnowledgeGeneration', { value: undefined });
    try {
      await assert.rejects(f.coordinator.withHostGenerationLease('workspace', async () => ({ cleanupConfirmed: false, executionBlocked: true })), hasCode('CLEANUP_UNCERTAIN'));
      await assert.rejects(f.coordinator.withRecoveryDecisionLease('workspace', async () => 0), hasCode('CLEANUP_PENDING'));
    } finally { await f.coordinator.close(); f.store.close(); }
  }
});

test('ordinary uncertain effects retain independent quarantine even when native generation evidence exists', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.coordinator.withWorkspaceLease('workspace', async () => {
      f.native.add('workspace'); return { cleanupConfirmed: false };
    }), hasCode('CLEANUP_UNCERTAIN'));
    f.native.delete('workspace');
    await assert.rejects(f.coordinator.withRecoveryDecisionLease('workspace', async () => 0), hasCode('CLEANUP_PENDING'));
    assert.throws(() => f.coordinator.assertWorkspaceAvailable('workspace'), hasCode('CLEANUP_PENDING'));
  } finally { await f.coordinator.close(); f.store.close(); }
});

test('close aborts and joins the actual host-generation promise before reporting its native uncertainty', async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let signal: AbortSignal | undefined, settled = false, closed = false;
  const operation = f.coordinator.withHostGenerationLease('workspace', async value => {
    signal = value; entered.resolve(); await release.promise;
    f.native.add('workspace'); settled = true; return { cleanupConfirmed: false, executionBlocked: true };
  });
  try {
    await entered.promise;
    const closing = f.coordinator.close().then(() => { closed = true; });
    const rejected = assert.rejects(closing, hasCode('CLEANUP_UNCERTAIN'));
    assert.equal(signal!.aborted, true); await tick(); assert.equal(settled, false); assert.equal(closed, false);
    release.resolve(); assert.equal((await operation).cleanupConfirmed, false); await rejected;
    assert.equal(settled, true); assert.equal(f.native.has('workspace'), true);
  } finally { release.resolve(); await f.coordinator.close().catch(() => {}); f.store.close(); }
});

test('close reports durable native quarantine when host settlement fails without a cleanup error code', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const operation = f.coordinator.withHostGenerationLease('workspace', async () => {
    entered.resolve(); await release.promise; f.native.add('workspace');
    throw new EngineError('KNOWLEDGE_SETTLEMENT_FAILED', 'Native terminal write failed');
  });
  void operation.catch(() => {});
  try {
    await entered.promise;
    const closing = f.coordinator.close(), closed = assert.rejects(closing, hasCode('CLEANUP_UNCERTAIN'));
    release.resolve(); await assert.rejects(operation, hasCode('KNOWLEDGE_SETTLEMENT_FAILED')); await closed;
    assert.equal(f.native.has('workspace'), true);
  } finally { release.resolve(); await f.coordinator.close().catch(() => {}); f.store.close(); }
});
