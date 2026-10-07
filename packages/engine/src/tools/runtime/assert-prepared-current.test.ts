import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, type JsonValue } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition } from '../../ports.js';
import { CommandPreflightRegistry } from '../../permission/preflight.js';
import { RoleResourcePolicyRegistry } from '../../permission/role-policy-registry.js';
import { ScopedToolRuntime } from './index.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-prepared-current-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const context: ToolContext = { workspace: { id: 'workspace', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() }, sessionId: 'session', runId: 'run', toolCallId: 'call', turnId: 'turn', attemptId: 'attempt', signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: root, recordCheckpoint() {} };
  return { root, context };
}
function producer(name = 'read_file', requiresApproval = false) {
  const counts = { prepared: 0, executed: 0, revalidated: 0 }, inner: PreparedTool[] = []; let executed: PreparedTool | undefined;
  const tool: ToolDefinition = { name, description: 'Retained capability fixture.', inputSchema: { type: 'object' }, async prepare(input) { counts.prepared++; const request: PreparedTool = { name, input: structuredClone(input) as JsonValue, fingerprint: 'producer-prepared-fingerprint', requiresApproval, preview: {} }; inner.push(request); return request; }, async execute(request) { counts.executed++; executed = request; return { content: 'Observed producer execution.' }; } };
  const revalidate = async () => { counts.revalidated++; };
  return { tool, counts, inner, revalidate, executed: () => executed };
}

test('retained current checks neither prepare, revalidate, execute nor consume the grant and leave the exact handle usable', async t => {
  const { context } = await fixture(t), runtime = new ScopedToolRuntime(), source = producer('read_file', true); runtime.register('engine', source.tool, { revalidate: source.revalidate });
  const scope = { workspaceId: 'workspace', sessionId: 'session', toolName: 'read_file', effect: 'read' as const }, grant = runtime.grants.issue({ ...scope, policyVersion: runtime.policy.version, ttlMs: 10000, maxUses: 2 });
  const prepared = await runtime.delegate('engine', 'read_file').prepare({}, context); assert.equal(prepared.preview.scopedGrantId, grant.id);
  await runtime.assertPreparedCurrent(prepared, context); await runtime.assertPreparedCurrent(prepared, context);
  assert.deepEqual(source.counts, { prepared: 1, executed: 0, revalidated: 0 }); assert.equal(runtime.grants.find(scope, runtime.policy.version)!.remainingUses, 2);
  await runtime.execute(prepared, context); assert.deepEqual(source.counts, { prepared: 1, executed: 1, revalidated: 1 }); assert.strictEqual(source.executed(), source.inner[0]); assert.equal(runtime.grants.find(scope, runtime.policy.version)!.remainingUses, 1);
  await assert.rejects(runtime.assertPreparedCurrent(prepared, context), { code: 'INVALID_PREPARED_TOOL' });
});

test('retained checks reject clones, foreign owners and outer or opaque-inner changes without producer invocation', async t => {
  const { context } = await fixture(t), runtime = new ScopedToolRuntime(), source = producer(); runtime.register('engine', source.tool); const handler = runtime.delegate('engine', 'read_file');
  const original = await handler.prepare({}, context); await assert.rejects(runtime.assertPreparedCurrent(structuredClone(original), context), { code: 'INVALID_PREPARED_TOOL' }); await assert.rejects(new ScopedToolRuntime().assertPreparedCurrent(original, context), { code: 'INVALID_PREPARED_TOOL' });
  for (const change of [{ runId: 'other-run' }, { sessionId: 'other-session' }, { toolCallId: 'other-call' }, { turnId: 'other-turn' }, { attemptId: 'other-attempt' }, { workspace: { ...context.workspace, id: 'other-workspace' } }]) await assert.rejects(runtime.assertPreparedCurrent(original, { ...context, ...change }), { code: 'TOOL_APPROVAL_STALE' });
  const outer = await handler.prepare({}, context); outer.preview.mutated = true; await assert.rejects(runtime.assertPreparedCurrent(outer, context), { code: 'TOOL_APPROVAL_STALE' });
  const inner = await handler.prepare({}, context); source.inner.at(-1)!.preview.mutated = true; await assert.rejects(runtime.assertPreparedCurrent(inner, context), { code: 'TOOL_APPROVAL_STALE' });
  assert.equal(source.counts.prepared, 3); assert.equal(source.counts.executed, 0); assert.equal(source.counts.revalidated, 0);
});

test('retained checks reject a revoked grant without consuming or invoking producer revalidation', async t => {
  const { context } = await fixture(t), runtime = new ScopedToolRuntime(), source = producer('read_file', true); runtime.register('engine', source.tool, { revalidate: source.revalidate });
  const grant = runtime.grants.issue({ workspaceId: 'workspace', sessionId: 'session', toolName: 'read_file', effect: 'read', policyVersion: runtime.policy.version, ttlMs: 10000 }); const prepared = await runtime.delegate('engine', 'read_file').prepare({}, context);
  runtime.grants.revoke(grant.id); await assert.rejects(runtime.assertPreparedCurrent(prepared, context), { code: 'TOOL_GRANT_STALE' }); assert.deepEqual(source.counts, { prepared: 1, executed: 0, revalidated: 0 });
});

test('retained checks reject current registry/profile/catalogue policy changes and do not consume the request', async t => {
  const { context } = await fixture(t), registry = new RoleResourcePolicyRegistry({ revision: 1, rules: [{ id: 'source', roleId: 'editor', resource: { kind: 'all' }, decision: 'allow' }] }), runtime = new ScopedToolRuntime({ roleResourcePolicyRegistry: registry, resolveRoleResources: () => [] }), source = producer(); runtime.register('engine', source.tool);
  const catalogue = runtime.catalogue('engine', 'build', undefined, { id: 'editor', revision: 'host-profile' }), prepared = await runtime.resolve(catalogue, 'read_file').prepare({}, context);
  await runtime.assertPreparedCurrent(prepared, context); registry.replace(1, { revision: 1, rules: [] }); await assert.rejects(runtime.assertPreparedCurrent(prepared, context), { code: 'TOOL_CATALOGUE_STALE' }); assert.equal(source.counts.executed, 0); assert.equal(runtime.getPolicyDecisionReceipt(prepared)!.rolePolicy!.registryRevision, 1);
  const freshCatalogue = runtime.catalogue('engine', 'build', undefined, { id: 'editor', revision: 'host-profile' }), fresh = await runtime.resolve(freshCatalogue, 'read_file').prepare({}, context); freshCatalogue.profile = { id: 'other', revision: 'other' };
  await assert.rejects(runtime.assertPreparedCurrent(fresh, context), { code: 'TOOL_CATALOGUE_STALE' }); assert.equal(source.counts.executed, 0);
  const current = await runtime.resolve(runtime.catalogue('engine', 'build', undefined, { id: 'editor', revision: 'host-profile' }), 'read_file').prepare({}, context); runtime.policy.replace([{ tool: 'read_file', decision: 'deny' }]); await assert.rejects(runtime.assertPreparedCurrent(current, context), { code: 'TOOL_CATALOGUE_STALE' });
});

test('retained command preflight checks detect changed source, analyzer and selector with zero producer execution', async t => {
  const { context, root } = await fixture(t), preflight = new CommandPreflightRegistry(), source = producer('run_command', true); let sourceRevision = 'actual-source-1', selected: string | undefined = 'trusted';
  const remove = preflight.register({ id: 'trusted', revision: 1, sourceSha256: 'a'.repeat(64), async analyze() { return { decision: 'allow', findings: [] }; } });
  const runtime = new ScopedToolRuntime({ commandPreflight: { registry: preflight, selectAnalyzer: () => selected, resolveSourceRevision: () => sourceRevision } }); runtime.register('engine', source.tool, { revalidate: source.revalidate }); const handler = runtime.delegate('engine', 'run_command'), input = { command: 'retained-fixture-command', cwd: root };
  const first = await handler.prepare(input, context); await runtime.assertPreparedCurrent(first, context); sourceRevision = 'actual-source-2'; await assert.rejects(runtime.assertPreparedCurrent(first, context), { code: 'COMMAND_PREFLIGHT_STALE' });
  const second = await handler.prepare(input, context); selected = undefined; await assert.rejects(runtime.assertPreparedCurrent(second, context), { code: 'COMMAND_PREFLIGHT_STALE' }); selected = 'trusted';
  const third = await handler.prepare(input, context); remove(); preflight.register({ id: 'trusted', revision: 2, sourceSha256: 'b'.repeat(64), async analyze() { return { decision: 'allow', findings: [] }; } }); await assert.rejects(runtime.assertPreparedCurrent(third, context), { code: 'COMMAND_PREFLIGHT_STALE' });
  assert.deepEqual(source.counts, { prepared: 3, executed: 0, revalidated: 0 });
});

test('retained checks revalidate ownership and generation after trusted asynchronous observations', async t => {
  const { context } = await fixture(t), registry = new RoleResourcePolicyRegistry({ revision: 1, rules: [{ id: 'source', roleId: 'editor', resource: { kind: 'all' }, decision: 'allow' }] }), source = producer(); let changeDuringObservation = false;
  const runtime = new ScopedToolRuntime({ roleResourcePolicyRegistry: registry, resolveRoleResources() { if (changeDuringObservation) { registry.replace(1, { revision: 1, rules: [] }); changeDuringObservation = false; } return []; } }); runtime.register('engine', source.tool);
  const prepared = await runtime.resolve(runtime.catalogue('engine', 'build', undefined, { id: 'editor', revision: 'host-profile' }), 'read_file').prepare({}, context); changeDuringObservation = true;
  await assert.rejects(runtime.assertPreparedCurrent(prepared, context), { code: 'TOOL_CATALOGUE_STALE' }); assert.deepEqual(source.counts, { prepared: 1, executed: 0, revalidated: 0 });
});
