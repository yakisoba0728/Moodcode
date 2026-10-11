import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { acquireExecutionLock } from '../tools/command/execution-lock.js';
import { RECOVERY_PRECEDENCE, RecoveryGate, type RecoveryGatePorts, type RecoveryProducer } from './gate.js';

const PRODUCERS: readonly RecoveryProducer[] = ['summaries', 'execution', 'knowledgeGeneration', 'knowledgeFilePublication'];

function gate(uncertain: ReadonlySet<RecoveryProducer>, overrides: Partial<RecoveryGatePorts> = {}) {
  const checked: RecoveryProducer[] = [];
  const has = (producer: RecoveryProducer) => () => { checked.push(producer); return uncertain.has(producer); };
  const ports: RecoveryGatePorts = {
    store: { hasUncertainSummaries: has('summaries'), hasUncertainExecution: has('execution'), hasUncertainKnowledgeGeneration: has('knowledgeGeneration'), hasUncertainKnowledgeFilePublication: has('knowledgeFilePublication') },
    executionLockPath: join(tmpdir(), 'moodcode-gate-unused.sqlite'), closed: new AbortController().signal,
    lease: (_workspaceId, operation) => operation(new AbortController().signal), hold() {}, ...overrides,
  };
  return { gate: new RecoveryGate(ports), checked };
}

test('recovery precedence pins which producers block each resume or activation and the order they are checked', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(RECOVERY_PRECEDENCE).map(([key, { blockers }]) => [key, blockers])), {
    knowledgeFileResume: ['summaries', 'execution', 'knowledgeGeneration'],
    proposalApplyResume: ['execution', 'summaries', 'knowledgeGeneration', 'knowledgeFilePublication'],
    knowledgeImportActivation: ['summaries', 'execution'],
    knowledgeImportSuccessors: ['knowledgeGeneration', 'knowledgeFilePublication'],
    knowledgeGenerationResume: ['summaries', 'execution'],
  });
  for (const [key, { blockers, message }] of Object.entries(RECOVERY_PRECEDENCE) as [keyof typeof RECOVERY_PRECEDENCE, (typeof RECOVERY_PRECEDENCE)[keyof typeof RECOVERY_PRECEDENCE]][]) {
    const clear = gate(new Set());
    clear.gate.assertCertain(key, 'workspace');
    assert.deepEqual(clear.checked, blockers, key);
    for (const producer of PRODUCERS) {
      const f = gate(new Set([producer]));
      if (!(blockers as readonly RecoveryProducer[]).includes(producer)) { f.gate.assertCertain(key, 'workspace'); continue; }
      assert.throws(() => f.gate.assertCertain(key, 'workspace'), (error: unknown) => error instanceof EngineError && error.code === 'CLEANUP_PENDING' && error.message === message, `${key}/${producer}`);
      assert.equal(f.checked.at(-1), producer);
    }
  }
});

test('a decision checks cancellation and idle inside the lease before it decides, then holds the workspace only when asked', async () => {
  const trace: string[] = [];
  const aborted = new AbortController(); aborted.abort(new EngineError('ENGINE_CLOSED', 'Run coordinator is closing'));
  const f = gate(new Set(), { lease: (workspaceId, operation) => { trace.push(`lease:${workspaceId}`); return operation(new AbortController().signal); }, hold: workspaceId => { trace.push(`hold:${workspaceId}`); } });
  assert.equal(await f.gate.decide('w1', { idle: true, hold: true }, () => { trace.push('decide'); return 'receipt'; }), 'receipt');
  assert.equal(await f.gate.decide('w2', {}, () => { trace.push('decide'); return 'receipt'; }), 'receipt');
  assert.deepEqual(trace, ['lease:w1', 'decide', 'hold:w1', 'lease:w2', 'decide']);
  const cancelled = gate(new Set(), { lease: (_workspaceId, operation) => operation(aborted.signal) });
  await assert.rejects(cancelled.gate.decide('w', { hold: true }, () => assert.fail('cancelled decision ran')), { code: 'ENGINE_CLOSED', message: 'Run coordinator is closing' });
  const closing = new AbortController(); closing.abort();
  const closed = gate(new Set(), { closed: closing.signal });
  await assert.rejects(closed.gate.decide('w', { closed: 'Engine closed during proposal recovery' }, () => assert.fail('closed decision ran')), { code: 'ENGINE_CLOSED', message: 'Engine closed during proposal recovery' });
});

test('an execution lock held by a command supervisor leaves the decision pending without running it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'effects.sqlite'), f = gate(new Set(), { executionLockPath: path }), lock = acquireExecutionLock(path);
  try {
    assert.throws(() => f.gate.assertIdle(), { code: 'CLEANUP_PENDING', message: 'A command supervisor is still cleaning up a previous engine execution; reopen after cleanup' });
    await assert.rejects(f.gate.decide('w', { idle: true }, () => assert.fail('busy decision ran')), { code: 'CLEANUP_PENDING' });
  } finally { lock.release(true); }
  f.gate.assertIdle();
});
