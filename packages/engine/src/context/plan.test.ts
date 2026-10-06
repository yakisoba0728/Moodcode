import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError } from '@moodcode/contracts';
import type { ContextRequest } from '../ports.js';
import { unknownModelSpec } from './model-spec.js';
import { planContext } from './plan.js';

test('context plan retains the latest request and reports selection and unknown metadata', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-context-plan-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const createdAt = new Date().toISOString();
  const request: ContextRequest = {
    workspace: { id: 'workspace', root, gitRoot: root, branch: null, createdAt },
    snapshot: { session: { id: 'session', workspaceId: 'workspace', title: 'fixture', createdAt }, runs: [], tools: [], approvals: [], lastSeq: 1,
      messages: [{ id: 'latest', sessionId: 'session', runId: 'run', role: 'user', content: 'Current request', createdAt }] },
    config: { providerId: 'fixture', modelId: 'fixture', mode: 'plan', limits: { ...DEFAULT_LIMITS } },
    signal: new AbortController().signal, reservedBytes: 100,
  };
  const plan = await planContext(request);
  assert.deepEqual(plan.selectedMessageIds, ['latest']);
  assert.equal(plan.omittedMessageCount, 0);
  assert.equal(plan.tokenLimit, null);
  assert.equal(plan.bytes, Buffer.byteLength(JSON.stringify(plan.messages)) + 100);
  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
  assert.ok(plan.warnings[0]!.includes('unknown'));
  const model = { ...unknownModelSpec('fixture', 'fixture'), contextWindow: 10, maxOutputTokens: 5 };
  await assert.rejects(planContext(request, { model, outputTokens: 5 }), (error: unknown) => error instanceof EngineError && error.code === 'CONTEXT_TOKEN_LIMIT');
  await assert.rejects(planContext(request, { model, outputTokens: 6 }), (error: unknown) => error instanceof EngineError && error.code === 'MODEL_OUTPUT_LIMIT');
  await assert.rejects(planContext(request, { model: { ...model, modelId: 'another' } }), (error: unknown) => error instanceof EngineError && error.code === 'MODEL_BINDING_MISMATCH');
});
