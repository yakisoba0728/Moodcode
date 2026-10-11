import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import type { ToolContext } from '../ports.js';
import type { ChildTaskRecord } from './index.js';
import { createDelegateTaskTool, delegationDigest, parseDelegationInput, type DelegationHost, type DelegationInspection } from './delegation.js';

const input = { requestId: 'observe', prompt: 'Read file.txt and report.', tools: ['read_file'], allocation: { turns: 2, toolCalls: 2, outputBytes: 4096, durationMs: 5000 } };
const context = (): ToolContext => ({ sessionId: 'session', runId: 'run', toolCallId: 'tool', workspace: { id: 'workspace', root: '/fixture', gitRoot: '/fixture', branch: 'main', createdAt: new Date().toISOString() }, signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: '/artifacts', executionLockPath: '/effects.sqlite', recordCheckpoint() {} });
const inspection = (): DelegationInspection => ({ baseCommit: 'a'.repeat(40), parentIdentity: 'identity', allowedReadTools: ['read_file'], remainingBudget: { turns: 8, toolCalls: 8, outputBytes: 65536, durationMs: 60000 } });
const task = (): ChildTaskRecord => ({ id: 'child', requestId: 'observe', sessionId: 'session', parentRunId: 'run', rootRunId: 'run', depth: 1, worktreeId: 'worktree', toolNames: ['read_file'], budget: input.allocation, state: 'completed', fingerprint: 'fingerprint', createdAt: '', updatedAt: '', childRunId: 'child-run', outcome: { state: 'completed', content: 'read observation', usage: { turns: 2, toolCalls: 1, outputBytes: 16 } }, deliveryState: 'none', deliveryRequestId: 'delivery' });
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; };

test('delegation input rejects unknown fields, effect tools, duplicates and invalid allocations before host inspection', async () => {
  let inspected = 0;
  const tool = createDelegateTaskTool({ async inspect() { inspected++; return inspection(); }, async run() { return task(); } });
  await assert.rejects(tool.prepare({ ...input, model: 'override' }, context()), code('INVALID_DELEGATION_INPUT'));
  await assert.rejects(tool.prepare({ ...input, tools: ['apply_patch'] }, context()), code('DELEGATION_TOOL_ESCALATION'));
  await assert.rejects(tool.prepare({ ...input, tools: ['read_file', 'read_file'] }, context()), code('DELEGATION_TOOL_ESCALATION'));
  await assert.rejects(tool.prepare({ ...input, allocation: { ...input.allocation, turns: 0 } }, context()), code('INVALID_DELEGATION_BUDGET'));
  assert.equal(inspected, 0);
  assert.throws(() => parseDelegationInput({ ...input, prompt: '😀'.repeat(8193) }), code('INVALID_DELEGATION_INPUT'));
});

test('approval fingerprint binds immutable commit/tools/request, rather than observed remaining duration', async () => {
  let remaining = 60000;
  const tool = createDelegateTaskTool({ async inspect() { return { ...inspection(), remainingBudget: { ...inspection().remainingBudget, durationMs: remaining-- } }; }, async run() { return task(); } });
  const one = await tool.prepare(input, context()), two = await tool.prepare(input, context());
  assert.equal(one.requiresApproval, true);
  assert.equal(tool.effectClass, 'write');
  assert.equal(one.fingerprint, two.fingerprint);
  assert.equal(delegationDigest({ request: 'x', b: [1, '\u00e9'], a: null }), 'c71f4fc1b5d56d463d8d7f849be3f7281dec669b98c8904b5672907783eee45c');
  assert.equal(one.preview.uncommittedChangesIncluded, false);
  assert.equal(one.preview.automaticDelivery, false);
  assert.equal(one.preview.automaticMerge, false);
  assert.ok(!JSON.stringify(one.preview).includes('remainingBudget'));
});

test('opaque delegation handles reject fabricated, mutated, changed-owner and reused execution', async () => {
  let runs = 0;
  const host: DelegationHost = { async inspect() { return inspection(); }, async run() { runs++; return task(); } };
  const tool = createDelegateTaskTool(host), ctx = context();
  const one = await tool.prepare(input, ctx);
  await assert.rejects(tool.execute(structuredClone(one), ctx), code('INVALID_PREPARED_DELEGATION'));
  const two = await tool.prepare(input, ctx);
  two.preview.baseCommit = 'b'.repeat(40);
  await assert.rejects(tool.execute(two, ctx), code('DELEGATION_APPROVAL_STALE'));
  const three = await tool.prepare(input, ctx);
  await assert.rejects(tool.execute(three, { ...ctx, toolCallId: 'other' }), code('DELEGATION_APPROVAL_STALE'));
  const four = await tool.prepare(input, ctx);
  const result = await tool.execute(four, ctx);
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content).deliveryState, 'none');
  await assert.rejects(tool.execute(four, ctx), code('INVALID_PREPARED_DELEGATION'));
  assert.equal(runs, 1);
});

test('allocation must fit parent budgets and tool deadline; exact existing request can join without reserving again', async () => {
  let existing = false;
  const tool = createDelegateTaskTool({ async inspect() { return { ...inspection(), remainingBudget: { turns: 0, toolCalls: 0, outputBytes: 0, durationMs: 1 }, ...(existing ? { existingTaskId: 'child' } : {}) }; }, async run() { return task(); } });
  await assert.rejects(tool.prepare(input, context()), code('DELEGATION_BUDGET_EXCEEDED'));
  existing = true;
  const prepared = await tool.prepare(input, context());
  assert.equal((await tool.execute(prepared, context())).isError, false);
  const deadline = createDelegateTaskTool({ async inspect() { return inspection(); }, async run() { return task(); } });
  await assert.rejects(deadline.prepare(input, { ...context(), limits: { ...DEFAULT_LIMITS, toolTimeoutMs: 4999 } }), code('DELEGATION_BUDGET_EXCEEDED'));
});

test('child result is bounded valid UTF-8 observation and never asserts source worktree changes', async () => {
  const child = task(); child.outcome!.content = '😀'.repeat(5000);
  const tool = createDelegateTaskTool({ async inspect() { return inspection(); }, async run() { return child; } });
  const ctx = { ...context(), limits: { ...DEFAULT_LIMITS, maxOutputBytes: 1024 } };
  const output = await tool.execute(await tool.prepare(input, ctx), ctx);
  assert.ok(Buffer.byteLength(output.content) <= 1024);
  const parsed = JSON.parse(output.content);
  assert.equal(parsed.truncated, true);
  assert.ok(!parsed.observation.includes('�'));
  assert.equal(parsed.source, 'git-commit');
  assert.equal(parsed.uncommittedChangesIncluded, false);
  assert.equal((output.data as Record<string, unknown>).deliveryState, 'none');
});
