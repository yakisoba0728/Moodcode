import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, EngineError, type ApprovalRecord, type JsonValue } from '@moodcode/contracts';
import type { ApprovalPort, PreparedTool, ToolContext, ToolDefinition } from '../../ports.js';
import { RoleResourcePolicy, type RoleResource, type RoleResourceRule } from '../../permission/role-resources.js';
import { CommandPreflightRegistry } from '../../permission/preflight.js';
import { ScopedToolRuntime, ToolPolicy, type RuntimeCommandPreflightOptions, type RuntimePreparedToolObservation, type RuntimeToolProfile, type ScopedToolRuntimeOptions } from './index.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-role-runtime-'))); await mkdir(join(root, 'src')); await mkdir(join(root, 'private')); await writeFile(join(root, 'src', 'a.ts'), 'a'); await writeFile(join(root, 'private', 'key'), 'private');
  t.after(() => rm(root, { recursive: true, force: true }));
  const context: ToolContext = { workspace: { id: 'workspace', root, gitRoot: root, branch: null, createdAt: new Date().toISOString() }, sessionId: 'session', runId: 'run', toolCallId: 'call', turnId: 'turn', attemptId: 'attempt', signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: root, recordCheckpoint() {} };
  return { root, context };
}
const profile: RuntimeToolProfile = { id: 'editor', revision: 'profile-1' };
function roles(rules: readonly RoleResourceRule[] = [{ id: 'source', roleId: 'editor', resource: { kind: 'file', path: 'src', descendants: true }, decision: 'allow' }]) { return new RoleResourcePolicy({ revision: 1, rules }); }
function fileResources(observation: RuntimePreparedToolObservation): readonly RoleResource[] {
  const input = observation.prepared.input as { path: string }; return [{ kind: 'file', path: input.path }];
}
function tool(name = 'read_file', requiresApproval = false) {
  const prepared: PreparedTool[] = []; let executed: PreparedTool | undefined;
  const source: ToolDefinition & { calls: number } = { name, description: 'fixture', inputSchema: { type: 'object' }, calls: 0,
    async prepare(input) { const clone = structuredClone(input) as JsonValue; const request = { name, input: clone, fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'), requiresApproval, preview: { action: name } }; prepared.push(request); return request; },
    async execute(request) { executed = request; source.calls++; return { content: 'producer-result' }; } };
  return { source, prepared, executed: () => executed };
}
function approval(status: ApprovalRecord['status'] = 'allowed', before?: () => void | Promise<void>): ApprovalPort { return { async request(input) { await before?.(); return { id: 'approval', ...input, status, createdAt: new Date().toISOString() }; }, decide() { throw new Error('unused'); }, cancelRun() {} }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function registerCommand(analyze: Parameters<CommandPreflightRegistry['register']>[0]['analyze'], extra: Partial<RuntimeCommandPreflightOptions> = {}) {
  const registry = new CommandPreflightRegistry(); const remove = registry.register({ id: 'check', revision: 1, sourceSha256: 'a'.repeat(64), analyze });
  const commandPreflight: RuntimeCommandPreflightOptions = { registry, selectAnalyzer: observation => observation.prepared.name === 'run_command' ? 'check' : undefined, resolveSourceRevision: () => 'workspace-input-sha-1', ...extra };
  return { registry, remove, commandPreflight };
}

test('host profile is immutable, authenticated and cached for eager and discovery captures', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', tool().source);
  const original = runtime.catalogue('engine'); const sourceProfile = { ...profile }; const bound = runtime.bindProfile(original, sourceProfile);
  assert.strictEqual(runtime.bindProfile(original, { ...profile }), bound); sourceProfile.id = 'other'; assert.deepEqual(bound.profile, profile);
  assert.throws(() => { (bound.profile as RuntimeToolProfile).id = 'other'; }, TypeError);
  assert.throws(() => runtime.bindProfile(bound, { id: 'other', revision: 'new' }), { code: 'TOOL_PROFILE_STALE' });
  assert.throws(() => runtime.bindProfile(structuredClone(original), profile), { code: 'TOOL_CATALOGUE_STALE' });
  assert.throws(() => runtime.bindProfile(original, { id: '', revision: 'new' }), { code: 'INVALID_TOOL_PROFILE' });
  let getterCalls = 0; const accessor = { revision: 'new' }; Object.defineProperty(accessor, 'id', { enumerable: true, get() { getterCalls++; return 'editor'; } });
  assert.throws(() => runtime.bindProfile(original, accessor as RuntimeToolProfile), { code: 'INVALID_TOOL_PROFILE' }); assert.equal(getterCalls, 0);
  const discovery = runtime.discoveryCatalogue('engine'); const materialized = runtime.materializeDiscovery(discovery, ['read_file'], { maxTools: 1, maxBytes: 8192 });
  const selected = runtime.bindProfile(materialized, profile); assert.equal(runtime.resolve(selected, 'read_file').name, 'read_file');
  bound.profile = { id: 'forged', revision: 'new' }; assert.throws(() => runtime.assertCatalogueCurrent(bound), { code: 'TOOL_CATALOGUE_STALE' });
});

test('actual prepare and execute consume role receipt without replacing the producer capability', async t => {
  const { context } = await fixture(t); const runtime = new ScopedToolRuntime({ roleResources: roles(), resolveRoleResources: fileResources }); const source = tool(); runtime.register('engine', source.source);
  const catalogue = runtime.catalogue('engine', 'build', undefined, profile), handler = runtime.resolve(catalogue, source.source.name);
  const prepared = await handler.prepare({ path: 'src/a.ts' }, context); assert.equal(prepared.requiresApproval, false);
  const receipt = prepared.preview.roleResourceDecision as { decision: string; matchedRules: unknown[] }; assert.equal(receipt.decision, 'allow'); assert.equal(receipt.matchedRules.length, 1);
  const observation = runtime.getPolicyDecisionReceipt(prepared)!; assert.ok(Object.isFrozen(observation)); assert.ok(Object.isFrozen(observation.roleResource)); assert.notStrictEqual(observation.roleResource, prepared.preview.roleResourceDecision);
  await assert.rejects(roles().assertCurrent(observation.roleResource!, { workspaceId: context.workspace.id, workspaceRoot: context.workspace.root, sessionId: context.sessionId, roleId: profile.id, roleRevision: profile.revision, toolName: 'read_file', effect: 'read', mode: 'build', preparedFingerprint: source.prepared[0]!.fingerprint, requiresApproval: false, baseDecision: { decision: 'allow', version: runtime.policy.version, reason: 'read effect' }, resources: [{ kind: 'file', path: 'src/a.ts' }] }), { code: 'ROLE_RESOURCE_STALE' });
  await runtime.executeApproved(prepared, context, approval()); assert.equal(source.source.calls, 1); assert.strictEqual(source.executed(), source.prepared[0]); assert.deepEqual(source.executed()!.input, { path: 'src/a.ts' });
});

test('role deny and unknown ask narrow a configured allow and existing grants', async t => {
  const { context } = await fixture(t); const denied = new ScopedToolRuntime({ roleResources: roles([{ id: 'deny', roleId: 'editor', resource: { kind: 'file', path: 'src', descendants: true }, decision: 'deny' }]), resolveRoleResources: fileResources });
  const source = tool(); denied.register('engine', source.source);
  await assert.rejects(denied.resolve(denied.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({ path: 'src/a.ts' }, context), { code: 'ROLE_RESOURCE_DENIED' }); assert.equal(source.source.calls, 0);
  const policy = new ToolPolicy([{ tool: 'edit_file', decision: 'allow' }]); const narrowed = new ScopedToolRuntime({ policy, roleResources: roles(), resolveRoleResources: fileResources }); const edit = tool('edit_file', true);
  narrowed.register('engine', edit.source, { revalidate: async () => {} }); const scope = { workspaceId: context.workspace.id, sessionId: context.sessionId, toolName: 'edit_file', effect: 'write' as const, resources: ['path:src/a.ts'] };
  const grant = narrowed.grants.issue({ ...scope, policyVersion: policy.version, ttlMs: 10000 });
  const prepared = await narrowed.resolve(narrowed.catalogue('engine', 'build', undefined, profile), 'edit_file').prepare({ path: 'src/a.ts' }, context);
  assert.equal(prepared.requiresApproval, true); assert.equal(prepared.preview.scopedGrantId, undefined);
  await assert.rejects(narrowed.executeApproved(prepared, context, approval('denied')), { code: 'TOOL_APPROVAL_DENIED' }); assert.equal(edit.source.calls, 0); assert.equal(narrowed.grants.find(scope, policy.version)?.id, grant.id);
});

test('role deny-all covers the default unknown resource declaration of an approval-bound command', async t => {
  const { root, context } = await fixture(t); const source = tool('run_command', true);
  const runtime = new ScopedToolRuntime({ roleResources: roles([{ id: 'no-shell', roleId: 'editor', toolName: 'run_command', resource: { kind: 'all' }, decision: 'deny' }]) }); runtime.register('engine', source.source);
  let failure: unknown; try { await runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'run_command').prepare({ command: 'printf safe', cwd: root }, context); } catch (error) { failure = error; }
  assert.equal((failure as { code: string }).code, 'ROLE_RESOURCE_DENIED'); const receipt = runtime.getPolicyDecisionFailure(failure)!.roleResource!;
  assert.equal(receipt.reason, 'role_denied'); assert.deepEqual(receipt.resources, [{ kind: 'unknown', label: 'Host resource identity unavailable' }]); assert.equal(source.source.calls, 0);
});

test('missing host profile or resource declaration requires approval; disabled roles preserve legacy behavior', async t => {
  const { context } = await fixture(t);
  for (const options of [{ roleResources: roles(), resolveRoleResources: fileResources }, { roleResources: roles() }]) {
    const runtime = new ScopedToolRuntime(options); runtime.register('engine', tool().source);
    const catalogue = options.resolveRoleResources ? runtime.catalogue('engine') : runtime.catalogue('engine', 'build', undefined, profile);
    assert.equal((await runtime.resolve(catalogue, 'read_file').prepare({ path: 'src/a.ts' }, context)).requiresApproval, true);
  }
  const legacy = new ScopedToolRuntime(); const source = tool(); legacy.register('engine', source.source); const prepared = await legacy.delegate('engine', 'read_file').prepare({ path: 'src/a.ts' }, context);
  assert.equal(prepared.requiresApproval, false); assert.equal(prepared.preview.roleResourceDecision, undefined); await legacy.execute(prepared, context); assert.equal(source.source.calls, 1);
  assert.equal(legacy.getPolicyDecisionReceipt(prepared), undefined); assert.throws(() => legacy.getPolicyDecisionReceipt(structuredClone(prepared)), { code: 'INVALID_PREPARED_TOOL' });
});

test('host observation is a detached immutable copy and callback failure never authorizes execution', async t => {
  const { context } = await fixture(t); let observed: RuntimePreparedToolObservation | undefined;
  const runtime = new ScopedToolRuntime({ roleResources: roles(), resolveRoleResources(observation) { observed = observation; (observation.prepared.input as { path: string }).path = 'private/key'; return []; } });
  const source = tool(); runtime.register('engine', source.source);
  await assert.rejects(runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({ path: 'src/a.ts' }, context), { code: 'ROLE_RESOURCE_RESOLUTION_FAILED' });
  assert.ok(Object.isFrozen(observed!.prepared)); assert.ok(Object.isFrozen(observed!.prepared.input)); assert.equal((source.prepared[0]!.input as { path: string }).path, 'src/a.ts'); assert.equal(source.source.calls, 0);
});

test('role resources and symlink identity are checked again after exact approval', async t => {
  const { root, context } = await fixture(t); await symlink('src', join(root, 'alias'));
  const runtime = new ScopedToolRuntime({ roleResources: roles(), resolveRoleResources: fileResources }); const source = tool('read_file', true); runtime.register('engine', source.source);
  const handler = runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file'); const prepared = await handler.prepare({ path: 'alias/a.ts' }, context);
  await assert.rejects(runtime.executeApproved(prepared, context, approval('allowed', async () => { await unlink(join(root, 'alias')); await symlink('private', join(root, 'alias')); })), { code: 'ROLE_RESOURCE_STALE' }); assert.equal(source.source.calls, 0);
});

test('MCP identities use only host declaration and connection/catalogue changes stop dispatch', async t => {
  const { context } = await fixture(t); let connection = 'connection-1';
  const mcp = { kind: 'mcp' as const, serverId: 'host-server', connectionId: connection, catalogueRevision: 2, uri: 'resource://one' };
  const runtime = new ScopedToolRuntime({ roleResources: roles([{ id: 'mcp', roleId: 'editor', resource: mcp, decision: 'allow' }]), resolveRoleResources: () => [{ ...mcp, connectionId: connection }] });
  const source = tool('mcp_fake', true); runtime.register('mcp_host', source.source, { effect: 'read', exactApproval: true });
  const handler = runtime.resolve(runtime.catalogue('mcp_host', 'build', undefined, profile), 'mcp_fake'); const prepared = await handler.prepare({ serverId: 'forged', uri: 'file:///private' }, context);
  assert.deepEqual((prepared.preview.roleResourceDecision as { resources: unknown }).resources, [mcp]);
  await assert.rejects(runtime.executeApproved(prepared, context, approval('allowed', () => { connection = 'connection-2'; })), { code: 'ROLE_RESOURCE_STALE' }); assert.equal(source.source.calls, 0);
});

test('role receipt/profile preview mutation cannot change prepared authority', async t => {
  const { context } = await fixture(t); const runtime = new ScopedToolRuntime({ roleResources: roles(), resolveRoleResources: fileResources }); const source = tool(); runtime.register('engine', source.source);
  const handler = runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file'); const prepared = await handler.prepare({ path: 'src/a.ts' }, context);
  (prepared.preview.roleResourceDecision as { decision: string }).decision = 'deny'; await assert.rejects(runtime.execute(prepared, context), { code: 'TOOL_APPROVAL_STALE' }); assert.equal(source.source.calls, 0);
});

test('preflight receipt binds exact canonical prepared command and keeps mandatory approval', async t => {
  const { root, context } = await fixture(t); let command = ''; const { commandPreflight } = registerCommand(async observation => { command = observation.binding.command; return { decision: 'allow', findings: [] }; });
  const runtime = new ScopedToolRuntime({ commandPreflight }); const source = tool('run_command', true); runtime.register('engine', source.source, { revalidate: async () => {} });
  const scope = { workspaceId: context.workspace.id, sessionId: context.sessionId, toolName: 'run_command', effect: 'execute' as const, resources: [`command:printf safe`, `path:${root}`] };
  runtime.grants.issue({ ...scope, policyVersion: runtime.policy.version, ttlMs: 10000 });
  const prepared = await runtime.delegate('engine', 'run_command').prepare({ command: 'printf safe', cwd: root }, context);
  assert.equal(command, 'printf safe'); assert.equal(prepared.requiresApproval, true); assert.equal(prepared.preview.scopedGrantId, undefined);
  assert.equal((prepared.preview.commandPreflight as { sourceRevision: string }).sourceRevision, 'workspace-input-sha-1'); assert.ok(!JSON.stringify(prepared.preview.commandPreflight).includes('printf safe'));
  await runtime.executeApproved(prepared, context, approval()); assert.strictEqual(source.executed(), source.prepared[0]); assert.deepEqual(source.executed()!.input, { command: 'printf safe', cwd: root });
});

test('preflight deny never dispatches, and malformed/failing callback results require approval', async t => {
  const { root, context } = await fixture(t);
  const deny = registerCommand(async () => ({ decision: 'allow', findings: [{ code: 'blocked', decision: 'deny', summary: 'Requires host denial' }] }));
  const denied = new ScopedToolRuntime({ commandPreflight: deny.commandPreflight }); const source = tool('run_command'); denied.register('engine', source.source);
  await assert.rejects(denied.delegate('engine', 'run_command').prepare({ command: 'printf safe', cwd: root }, context), { code: 'COMMAND_PREFLIGHT_DENIED' }); assert.equal(source.source.calls, 0);
  const failing = registerCommand(async () => { throw new Error('secret content'); }); const runtime = new ScopedToolRuntime({ policy: new ToolPolicy([{ tool: 'run_command', decision: 'allow' }]), commandPreflight: failing.commandPreflight }); runtime.register('engine', source.source);
  const prepared = await runtime.delegate('engine', 'run_command').prepare({ command: 'printf safe', cwd: root }, context); assert.equal(prepared.requiresApproval, true); assert.equal((prepared.preview.commandPreflight as { status: string }).status, 'failed'); assert.ok(!JSON.stringify(prepared).includes('secret content'));
  await assert.rejects(runtime.executeApproved(prepared, context, approval('denied')), { code: 'TOOL_APPROVAL_DENIED' }); assert.equal(source.source.calls, 0);
});

test('preflight timeout asks and cancellation yields no prepared executable request', async t => {
  const { root, context } = await fixture(t); const output = deferred<{ decision: 'allow'; findings: [] }>();
  const setup = registerCommand(async () => output.promise, { deadlineMs: 2 }); const runtime = new ScopedToolRuntime({ policy: new ToolPolicy([{ tool: 'run_command', decision: 'allow' }]), commandPreflight: setup.commandPreflight }); const source = tool('run_command'); runtime.register('engine', source.source);
  const prepared = await runtime.delegate('engine', 'run_command').prepare({ command: 'printf safe', cwd: root }, context); assert.equal(prepared.requiresApproval, true); assert.equal((prepared.preview.commandPreflight as { status: string }).status, 'timed_out'); assert.equal(source.source.calls, 0);
  output.resolve({ decision: 'allow', findings: [] });
  const entered = deferred<void>(), blocked = deferred<{ decision: 'allow'; findings: [] }>(); const cancelled = registerCommand(async () => { entered.resolve(); return blocked.promise; });
  const another = new ScopedToolRuntime({ commandPreflight: cancelled.commandPreflight }); another.register('engine', source.source); const controller = new AbortController();
  const pending = another.delegate('engine', 'run_command').prepare({ command: 'printf safe', cwd: root }, { ...context, signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); blocked.resolve({ decision: 'allow', findings: [] }); assert.equal(source.source.calls, 0);
});

test('preflight registration/source/selector change during approval invalidates dispatch', async t => {
  const { root, context } = await fixture(t); let revision = 'workspace-input-sha-1', selected: string | undefined = 'check';
  const setup = registerCommand(async () => ({ decision: 'allow', findings: [] }), { resolveSourceRevision: () => revision, selectAnalyzer: () => selected });
  const runtime = new ScopedToolRuntime({ commandPreflight: setup.commandPreflight }); const source = tool('run_command', true); runtime.register('engine', source.source); const handler = runtime.delegate('engine', 'run_command');
  const first = await handler.prepare({ command: 'printf safe', cwd: root }, context); await assert.rejects(runtime.executeApproved(first, context, approval('allowed', () => { revision = 'workspace-input-sha-2'; })), { code: 'COMMAND_PREFLIGHT_STALE' });
  const second = await handler.prepare({ command: 'printf safe', cwd: root }, context); await assert.rejects(runtime.executeApproved(second, context, approval('allowed', () => { selected = undefined; })), { code: 'COMMAND_PREFLIGHT_STALE' });
  const skipped = await handler.prepare({ command: 'printf safe', cwd: root }, context); await assert.rejects(runtime.executeApproved(skipped, context, approval('allowed', () => { selected = 'check'; })), { code: 'COMMAND_PREFLIGHT_STALE' });
  const fourth = await handler.prepare({ command: 'printf safe', cwd: root }, context); await assert.rejects(runtime.executeApproved(fourth, context, approval('allowed', setup.remove)), { code: 'COMMAND_PREFLIGHT_STALE' }); assert.equal(source.source.calls, 0);
});

test('preflight requires actual source revision and exact command/cwd instead of catalogue or model-derived substitutes', async t => {
  const { root, context } = await fixture(t); const setup = registerCommand(async () => ({ decision: 'allow', findings: [] }), { resolveSourceRevision: undefined });
  const runtime = new ScopedToolRuntime({ commandPreflight: setup.commandPreflight }); const source = tool('run_command'); runtime.register('engine', source.source);
  await assert.rejects(runtime.delegate('engine', 'run_command').prepare({ command: 'printf safe', cwd: root }, context), { code: 'COMMAND_PREFLIGHT_SOURCE_REQUIRED' });
  const good = registerCommand(async () => ({ decision: 'allow', findings: [] })); const exact = new ScopedToolRuntime({ commandPreflight: good.commandPreflight }); exact.register('engine', source.source);
  await assert.rejects(exact.delegate('engine', 'run_command').prepare({ command: 'printf safe' }, context), { code: 'COMMAND_PREFLIGHT_COMMAND_REQUIRED' });
  await assert.rejects(exact.delegate('engine', 'run_command').prepare({ command: 'printf safe', cwd: '.' }, context), { code: 'INVALID_COMMAND_PREFLIGHT_PATH' }); assert.equal(source.source.calls, 0);
});

test('host resolver/analyzer options are captured and cannot be disabled through original options mutation', async t => {
  const { context } = await fixture(t); const options: ScopedToolRuntimeOptions = { roleResources: roles(), resolveRoleResources: fileResources };
  const runtime = new ScopedToolRuntime(options); options.roleResources = undefined; options.resolveRoleResources = undefined; const source = tool(); runtime.register('engine', source.source);
  const prepared = await runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({ path: 'src/a.ts' }, context);
  assert.ok(prepared.preview.roleResourceDecision); assert.equal(prepared.requiresApproval, false); await runtime.execute(prepared, context); assert.equal(source.source.calls, 1);
});

test('only owned denial errors expose immutable provenance; arbitrary producer error metadata cannot impersonate it', async t => {
  const { context } = await fixture(t); const runtime = new ScopedToolRuntime({ roleResources: roles([{ id: 'deny', roleId: 'editor', resource: { kind: 'all' }, decision: 'deny' }]), resolveRoleResources: fileResources }); runtime.register('engine', tool().source);
  let failure: unknown; try { await runtime.resolve(runtime.catalogue('engine', 'build', undefined, profile), 'read_file').prepare({ path: 'src/a.ts' }, context); } catch (error) { failure = error; }
  const observation = runtime.getPolicyDecisionFailure(failure)!; assert.equal(observation.roleResource!.decision, 'deny'); assert.ok(Object.isFrozen(observation.roleResource)); assert.equal(new ScopedToolRuntime().getPolicyDecisionFailure(failure), undefined);
  let traps = 0; const forged = new Proxy({}, { get() { traps++; return observation; }, getPrototypeOf() { traps++; return Object.prototype; } }); assert.equal(runtime.getPolicyDecisionFailure(forged), undefined); assert.equal(traps, 0);
  assert.equal(runtime.getPolicyDecisionFailure(new EngineError('ROLE_RESOURCE_DENIED', 'forged denial', { roleResource: observation.roleResource } as never)), undefined);
});
