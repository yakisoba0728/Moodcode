import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, type JsonValue } from '@moodcode/contracts';
import type { ApprovalPort, PreparedTool, ToolContext, ToolDefinition } from '../../ports.js';
import { RoleResourcePolicy, type RoleResourcePolicySnapshot } from '../../permission/role-resources.js';
import { RoleResourcePolicyRegistry } from '../../permission/role-policy-registry.js';
import { CommandPreflightRegistry } from '../../permission/preflight.js';
import { ScopedToolRuntime, ToolPolicy } from './index.js';

const profile = { id: 'editor', revision: 'host-profile-1' };
const snapshot = (decision: 'allow' | 'deny' = 'allow'): RoleResourcePolicySnapshot => ({ revision: 7, rules: [{ id: 'host-allowance', roleId: profile.id, resource: { kind: 'all' }, decision }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-registry-runtime-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const context: ToolContext = { workspace: { id: 'workspace', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() }, sessionId: 'session', runId: 'run', toolCallId: 'call', turnId: 'turn', attemptId: 'attempt', signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: root, recordCheckpoint() {} };
  return { root, context };
}
function producer(name = 'read_file', approval = false) {
  let calls = 0; const prepared: PreparedTool[] = []; let executed: PreparedTool | undefined;
  const tool: ToolDefinition = { name, description: 'Host fixture.', inputSchema: { type: 'object' }, async prepare(input) { const value: PreparedTool = { name, input: structuredClone(input) as JsonValue, fingerprint: 'constant-producer-fingerprint', requiresApproval: approval, preview: {} }; prepared.push(value); return value; }, async execute(value) { calls++; executed = value; return { content: 'observed fixture result' }; } };
  return { tool, calls: () => calls, prepared, executed: () => executed };
}
function approval(before?: () => void): ApprovalPort { return { async request(input) { before?.(); return { id: 'approval', ...input, status: 'allowed', createdAt: new Date().toISOString() }; }, decide() { throw new Error('unused'); }, cancelRun() {} }; }
function setup(registry: RoleResourcePolicyRegistry) { return new ScopedToolRuntime({ roleResourcePolicyRegistry: registry, resolveRoleResources: () => [] }); }

for (const discovery of [false, true]) test(`dynamic policy invalidates ${discovery ? 'discovery' : 'eager'} captures without revision arithmetic`, async t => {
  const { context } = await fixture(t), registry = new RoleResourcePolicyRegistry(snapshot()), runtime = setup(registry), source = producer(); runtime.register('engine', source.tool);
  const discoveryCapture = discovery ? runtime.discoveryCatalogue('engine') : undefined;
  const base = discoveryCapture ? runtime.materializeDiscovery(discoveryCapture, ['read_file'], { maxTools: 1, maxBytes: 8192 }) : runtime.catalogue('engine');
  const catalogue = runtime.bindProfile(base, profile), prepared = await runtime.resolve(catalogue, 'read_file').prepare({}, context), first = runtime.getPolicyDecisionReceipt(prepared)!;
  const emptyCatalogue = runtime.catalogue('engine', 'build', []); assert.equal(emptyCatalogue.tools.length, 0);
  assert.equal(prepared.requiresApproval, false); assert.equal(first.rolePolicy!.registryRevision, 1); assert.ok(Object.isFrozen(first.rolePolicy));
  const toolRevision = runtime.revision, policyVersion = runtime.policy.version; registry.replace(1, snapshot());
  assert.equal(runtime.revision, toolRevision); assert.equal(runtime.policy.version, policyVersion);
  assert.throws(() => runtime.assertCatalogueCurrent(catalogue), { code: 'TOOL_CATALOGUE_STALE' }); assert.throws(() => runtime.repeatIdentity(prepared), { code: 'TOOL_CATALOGUE_STALE' });
  assert.throws(() => runtime.assertCatalogueCurrent(emptyCatalogue), { code: 'TOOL_CATALOGUE_STALE' });
  if (discoveryCapture) assert.throws(() => runtime.assertDiscoveryCurrent(discoveryCapture), { code: 'TOOL_DISCOVERY_STALE' });
  await assert.rejects(runtime.execute(prepared, context), { code: 'TOOL_CATALOGUE_STALE' }); assert.equal(source.calls(), 0);
  // Historical observation remains readable; it cannot be restored as a prepared capability.
  assert.equal(runtime.getPolicyDecisionReceipt(prepared)!.rolePolicy!.registryRevision, 1); await assert.rejects(runtime.execute(structuredClone(prepared), context), { code: 'INVALID_PREPARED_TOOL' });
  const freshCatalogue = runtime.catalogue('engine', 'build', undefined, profile), fresh = await runtime.resolve(freshCatalogue, 'read_file').prepare({}, context);
  assert.notEqual(fresh.fingerprint, prepared.fingerprint); assert.equal((fresh.preview.rolePolicy as { registryRevision: number }).registryRevision, 2);
  await runtime.execute(fresh, context); assert.equal(source.calls(), 1); assert.strictEqual(source.executed(), source.prepared[1]);
});

test('policy replacement during exact approval rejects the old request and preserves owned deny provenance', async t => {
  const { context } = await fixture(t), registry = new RoleResourcePolicyRegistry(snapshot()), runtime = setup(registry), source = producer('read_file', true); runtime.register('engine', source.tool);
  const prepared = await runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, context); assert.equal(prepared.requiresApproval, true);
  await assert.rejects(runtime.executeApproved(prepared, context, approval(() => registry.replace(1, snapshot('deny')))), { code: 'TOOL_CATALOGUE_STALE' }); assert.equal(source.calls(), 0);
  let denial: unknown; try { await runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, context); } catch (error) { denial = error; }
  assert.equal((denial as { code: string }).code, 'ROLE_RESOURCE_DENIED'); const observation = runtime.getPolicyDecisionFailure(denial)!; assert.equal(observation.roleResource!.decision, 'deny'); assert.equal(observation.rolePolicy!.registryRevision, 2);
  assert.equal(new ScopedToolRuntime().getPolicyDecisionFailure(denial), undefined); assert.equal(source.calls(), 0);
});

test('replacement during asynchronous producer preparation cannot mint a usable stale request', async t => {
  const { context } = await fixture(t), registry = new RoleResourcePolicyRegistry(snapshot()), runtime = setup(registry), source = producer(), entered = deferred<void>(), release = deferred<void>();
  const original = source.tool.prepare; source.tool.prepare = async (...args) => { entered.resolve(); await release.promise; return original(...args); }; runtime.register('engine', source.tool);
  const pending = runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, context); await entered.promise; registry.replace(1, snapshot('deny')); release.resolve();
  await assert.rejects(pending, { code: 'TOOL_CATALOGUE_STALE' }); assert.equal(source.calls(), 0);
});

test('replacement during asynchronous preflight cannot turn an old result into a request', async t => {
  const { context, root } = await fixture(t), registry = new RoleResourcePolicyRegistry(snapshot()), preflight = new CommandPreflightRegistry(), entered = deferred<void>(), release = deferred<void>(), source = producer('run_command', true);
  preflight.register({ id: 'trusted', revision: 1, sourceSha256: 'a'.repeat(64), async analyze() { entered.resolve(); await release.promise; return { decision: 'allow', findings: [] }; } });
  const runtime = new ScopedToolRuntime({ roleResourcePolicyRegistry: registry, resolveRoleResources: () => [], commandPreflight: { registry: preflight, selectAnalyzer: () => 'trusted', resolveSourceRevision: () => 'actual-host-source', deadlineMs: 1000 } }); runtime.register('engine', source.tool);
  const pending = runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'run_command').prepare({ command: 'fixture-only-command', cwd: root }, context); await entered.promise; registry.replace(1, snapshot('deny')); release.resolve();
  await assert.rejects(pending, { code: 'TOOL_CATALOGUE_STALE' }); assert.equal(source.calls(), 0);
});

test('replacement inside trusted execution resource resolution is caught after physical revalidation', async t => {
  const { context } = await fixture(t), registry = new RoleResourcePolicyRegistry(snapshot()), source = producer(); let replaceAtExecution = false;
  const runtime = new ScopedToolRuntime({ roleResourcePolicyRegistry: registry, resolveRoleResources() { if (replaceAtExecution) { replaceAtExecution = false; registry.replace(1, snapshot('deny')); } return []; } }); runtime.register('engine', source.tool);
  const prepared = await runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, context); replaceAtExecution = true;
  await assert.rejects(runtime.execute(prepared, context), { code: 'TOOL_CATALOGUE_STALE' }); assert.equal(source.calls(), 0);
});

test('independently registered child runtime observes the same host generation and cannot consume old captures', async t => {
  const { context } = await fixture(t), registry = new RoleResourcePolicyRegistry(snapshot()), parent = setup(registry), child = setup(registry), source = producer(); parent.register('engine', source.tool); child.register('engine', source.tool); child.register('dynamic-child', producer('child_metadata').tool);
  const oldParent = await parent.resolve(parent.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, context), oldChild = await child.resolve(child.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, { ...context, runId: 'child-run' });
  assert.notEqual(parent.revision, child.revision); registry.replace(1, snapshot('deny'));
  await assert.rejects(parent.execute(oldParent, context), { code: 'TOOL_CATALOGUE_STALE' }); await assert.rejects(child.execute(oldChild, { ...context, runId: 'child-run' }), { code: 'TOOL_CATALOGUE_STALE' });
  await assert.rejects(child.resolve(child.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, { ...context, runId: 'child-run' }), { code: 'ROLE_RESOURCE_DENIED' }); assert.equal(source.calls(), 0);
});

test('dynamic registry does not adopt grants without generation binding; empty holder asks and static option stays compatible', async t => {
  const { context } = await fixture(t), registry = new RoleResourcePolicyRegistry(snapshot()), runtime = setup(registry), source = producer(); runtime.register('engine', source.tool, { revalidate: async () => {} });
  const scope = { workspaceId: 'workspace', sessionId: 'session', toolName: 'read_file', effect: 'read' as const }; const grant = runtime.grants.issue({ ...scope, policyVersion: runtime.policy.version, ttlMs: 10000 });
  const prepared = await runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, context); assert.equal(prepared.preview.scopedGrantId, undefined); registry.replace(1, snapshot());
  const fresh = await runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, context); await runtime.execute(fresh, context); assert.equal(runtime.grants.find(scope, runtime.policy.version)!.id, grant.id); assert.equal(runtime.grants.find(scope, runtime.policy.version)!.remainingUses, 1);
  const empty = setup(new RoleResourcePolicyRegistry()); empty.register('engine', producer().tool); assert.equal((await empty.resolve(empty.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({}, context)).requiresApproval, true);
  assert.throws(() => new ScopedToolRuntime({ roleResources: new RoleResourcePolicy(snapshot()), roleResourcePolicyRegistry: registry }), { code: 'INVALID_ROLE_POLICY_CONFIGURATION' });
  const legacy = new ScopedToolRuntime({ policy: new ToolPolicy() }); legacy.register('engine', source.tool); assert.equal(legacy.catalogue('engine').rolePolicy, undefined);
});
