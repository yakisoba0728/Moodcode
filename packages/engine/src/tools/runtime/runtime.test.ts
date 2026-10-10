import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, EngineError, type ApprovalRecord } from '@moodcode/contracts';
import type { ApprovalPort, ToolContext, ToolDefinition } from '../../ports.js';
import { ArtifactStore, createToolResultEnvelope } from '../../artifacts/index.js';
import { ScopedToolRuntime } from './index.js';
import { ToolPolicy } from '../../permission/policy.js';
import { ScopedToolGrants } from '../../permission/grants.js';
const code = (expected: string) => (e: unknown) => { assert.equal((e as { code: string }).code, expected); return true; };
function context(): ToolContext { return { workspace: { id: 'w', root: '/workspace', gitRoot: '/workspace', branch: null, createdAt: new Date().toISOString() }, sessionId: 's', runId: 'r', toolCallId: 'call', turnId: 'turn', attemptId: 'attempt', signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: '/artifacts', recordCheckpoint() {} }; }
function tool(name = 'custom', requiresApproval = false): ToolDefinition & { calls: number } { const source = { name, description: 'test', inputSchema: { type: 'object' }, calls: 0, async prepare(input: unknown) { return { name, input: input as never, fingerprint: 'inner-hash', requiresApproval, preview: { action: name } }; }, async execute() { source.calls++; return { content: 'full result', data: { value: 1 } }; } }; return source; }
function approval(status: ApprovalRecord['status'] = 'allowed'): ApprovalPort { return { async request(input) { return { id: 'approval', ...input, status, createdAt: new Date().toISOString() }; }, decide() { throw new Error('unused'); }, cancelRun() {} }; }
test('exact approval cannot be skipped by configured allow or a valid reusable grant', async () => {
  const policy = new ToolPolicy([{ tool: 'delegate_task', decision: 'allow' }]);
  const runtime = new ScopedToolRuntime({ policy }), source = tool('delegate_task', true);
  runtime.register('scope', source, { effect: 'execute', exactApproval: true, revalidate: async () => {} });
  const grant = runtime.grants.issue({ workspaceId: 'w', sessionId: 's', toolName: source.name, effect: 'execute', policyVersion: policy.version, ttlMs: 1000 });
  const ctx = context(), delegate = runtime.delegate('scope', source.name);
  const denied = await delegate.prepare({}, ctx); assert.equal(denied.requiresApproval, true);
  await assert.rejects(runtime.executeApproved(denied, ctx, approval('denied')), code('TOOL_APPROVAL_DENIED')); assert.equal(source.calls, 0);
  await runtime.executeApproved(await delegate.prepare({}, ctx), ctx, approval()); assert.equal(source.calls, 1);
  assert.ok(runtime.grants.find(grant, policy.version));
  policy.replace([{ tool: source.name, decision: 'deny' }]); assert.equal(runtime.catalogue('scope').tools.length, 0);
});
test('catalogue captures schemas and function registrations and rejects stale or copied handles', () => {
  const runtime = new ScopedToolRuntime(); const source = tool('read_file'); const dispose = runtime.register('scope', source); const first = runtime.catalogue('scope'); source.inputSchema.type = 'array'; source.execute = async () => ({ content: 'changed' }); assert.equal(first.tools[0]?.inputSchema.type, 'object'); assert.throws(() => runtime.resolve(structuredClone(first), 'read_file'), code('TOOL_CATALOGUE_STALE')); const registered = runtime.resolve(first, 'read_file'); assert.equal(registered.effectClass, 'read'); dispose(); assert.throws(() => runtime.resolve(first, 'read_file'), code('TOOL_CATALOGUE_STALE')); dispose();
});
test('disposed scoped registrations never remove later replacement registrations', () => { const runtime = new ScopedToolRuntime(); const firstDispose = runtime.register('scope', tool('a')); runtime.clearScope('scope'); runtime.register('scope', tool('a')); firstDispose(); assert.equal(runtime.catalogue('scope').tools.length, 1); });
test('catalogue mutations and schema edits cannot redirect resolved calls', () => { const runtime = new ScopedToolRuntime(); runtime.register('scope', tool('a')); const catalogue = runtime.catalogue('scope'); catalogue.tools[0]!.inputSchema.type = 'array'; assert.throws(() => runtime.resolve(catalogue, 'a'), code('TOOL_CATALOGUE_STALE')); });
test('configured denial dominates allow and grants; plan catalogues exclude effects', () => { const policy = new ToolPolicy([{ tool: '*', decision: 'allow' }, { tool: 'edit_file', decision: 'deny' }]); const runtime = new ScopedToolRuntime({ policy }); runtime.register('scope', tool('edit_file', true)); runtime.register('scope', tool('run_command', true)); runtime.register('scope', tool('read_file')); assert.deepEqual(runtime.catalogue('scope', 'plan').tools.map(t => t.name), ['read_file']); assert.equal(policy.evaluate({ toolName: 'edit_file', effect: 'write', mode: 'build', requiresApproval: false }).decision, 'deny'); });
test('unknown tool asks for approval despite its unchecked producer requirement', async () => { const runtime = new ScopedToolRuntime(); const source = tool(); runtime.register('scope', source); const prepared = await runtime.delegate('scope', source.name).prepare({}, context()); assert.equal(prepared.requiresApproval, true); const result = await runtime.executeApproved(prepared, context(), approval()); assert.equal(source.calls, 1); assert.equal(result.content, 'full result'); assert.equal(result.structuredResult?.outcome, 'completed'); });
test('denied approval executes no producer effect', async () => { const runtime = new ScopedToolRuntime(); const source = tool(); runtime.register('scope', source); const ctx = context(); const prepared = await runtime.delegate('scope', source.name).prepare({}, ctx); await assert.rejects(runtime.executeApproved(prepared, ctx, approval('denied')), code('TOOL_APPROVAL_DENIED')); assert.equal(source.calls, 0); });
test('registry or policy changes during approval invalidate prepared identity before effects', async () => { const runtime = new ScopedToolRuntime(); const source = tool(); runtime.register('scope', source); const ctx = context(); const prepared = await runtime.delegate('scope', source.name).prepare({}, ctx); runtime.policy.replace([{ tool: 'custom', decision: 'deny' }]); await assert.rejects(runtime.executeApproved(prepared, ctx, approval()), code('TOOL_CATALOGUE_STALE')); assert.equal(source.calls, 0); });
test('outer input/preview/identity tampering and repeated execution are rejected', async () => { const runtime = new ScopedToolRuntime(); const source = tool('read_file'); runtime.register('scope', source); const ctx = context(); const delegate = runtime.delegate('scope', source.name); const changed = await delegate.prepare({ x: 1 }, ctx); (changed.input as { x: number }).x = 2; await assert.rejects(delegate.execute(changed, ctx), code('TOOL_APPROVAL_STALE')); const identity = await delegate.prepare({}, ctx); await assert.rejects(delegate.execute(identity, { ...ctx, attemptId: 'other' }), code('TOOL_APPROVAL_STALE')); const once = await delegate.prepare({}, ctx); await delegate.execute(once, ctx); await assert.rejects(delegate.execute(once, ctx), code('INVALID_PREPARED_TOOL')); assert.equal(source.calls, 1); });
test('prepared inner stays opaque and changed inner requests are detected', async () => { const runtime = new ScopedToolRuntime(); const source = tool('read_file'); let captured: unknown; const original = source.prepare; source.prepare = async (...args) => { captured = await original(...args); return captured as never; }; runtime.register('scope', source); const ctx = context(); const delegate = runtime.delegate('scope', source.name); const prepared = await delegate.prepare({}, ctx); (captured as { fingerprint: string }).fingerprint = 'mutated'; await assert.rejects(delegate.execute(prepared, ctx), code('TOOL_APPROVAL_STALE')); assert.equal(source.calls, 0); });
test('grants cannot skip fingerprint approval without producer revalidation', async () => { const runtime = new ScopedToolRuntime(); const source = tool('edit_file', true); runtime.register('scope', source); runtime.grants.issue({ workspaceId: 'w', sessionId: 's', toolName: 'edit_file', effect: 'write', policyVersion: runtime.policy.version, ttlMs: 1000 }); assert.equal((await runtime.delegate('scope', source.name).prepare({}, context())).requiresApproval, true); });
test('scoped grant consumption revalidates prepared request and is one-use', async () => { const runtime = new ScopedToolRuntime(); const source = tool('edit_file', true); let revalidated = 0; runtime.register('scope', source, { revalidate: async () => { revalidated++; } }); const grant = runtime.grants.issue({ workspaceId: 'w', sessionId: 's', toolName: 'edit_file', effect: 'write', policyVersion: runtime.policy.version, ttlMs: 1000 }); const ctx = context(); const delegate = runtime.delegate('scope', source.name); const prepared = await delegate.prepare({}, ctx); assert.equal(prepared.requiresApproval, false); await delegate.execute(prepared, ctx); assert.equal(revalidated, 1); assert.equal(runtime.grants.find(grant, runtime.policy.version), undefined); assert.equal((await delegate.prepare({}, ctx)).requiresApproval, true); });
test('grant revoke while revalidation runs cannot authorize execution', async () => { const runtime = new ScopedToolRuntime(); const source = tool('edit_file', true); let id = ''; runtime.register('scope', source, { revalidate: async () => runtime.grants.revoke(id) }); const grant = runtime.grants.issue({ workspaceId: 'w', sessionId: 's', toolName: 'edit_file', effect: 'write', policyVersion: runtime.policy.version, ttlMs: 1000 }); id = grant.id; const ctx = context(); const delegate = runtime.delegate('scope', source.name); await assert.rejects(delegate.execute(await delegate.prepare({}, ctx), ctx), code('TOOL_GRANT_STALE')); assert.equal(source.calls, 0); });
test('grants expire, are versioned and cannot cross workspace/session scope', () => { let now = 0; const grants = new ScopedToolGrants(() => now); const scope = { workspaceId: 'w', sessionId: 's', toolName: 'read_file', effect: 'read' as const }; const grant = grants.issue({ ...scope, policyVersion: 1, ttlMs: 100 }); assert.equal(grants.find({ ...scope, workspaceId: 'other' }, 1), undefined); assert.equal(grants.find(scope, 2), undefined); now = 100; assert.equal(grants.find(scope, 1), undefined); assert.throws(() => grants.consume(grant.id, scope, 1, grant.revision), code('TOOL_GRANT_STALE')); });
test('optional artifact normalization preserves legacy content and attaches owned bounded refs', async t => { const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-runtime-'))); t.after(() => rm(directory, { force: true, recursive: true })); const store = await ArtifactStore.open({ directory, limits: { maxArtifactBytes: 4 } }); const runtime = new ScopedToolRuntime({ artifacts: store }); const source = tool('read_file'); runtime.register('scope', source); const ctx = context(); const delegate = runtime.delegate('scope', source.name); const result = await delegate.execute(await delegate.prepare({}, ctx), ctx); assert.equal(result.content, 'full result'); const ref = result.structuredResult!.artifactRefs[0]!; assert.equal(ref.identity.attemptId, 'attempt'); assert.equal(ref.complete, false); assert.equal(Buffer.from((await store.read(ref.id)).bytes).toString(), 'full'); });
test('resource-specific deny leaves tool visible but blocks prepared path and command', async () => { const policy = new ToolPolicy([{ tool: 'edit_file', resource: 'path:private/**', decision: 'deny' }, { tool: 'run_command', resource: 'command:rm -rf .', decision: 'deny' }]); const runtime = new ScopedToolRuntime({ policy }); const source = tool('edit_file', true); runtime.register('scope', source); assert.equal(runtime.catalogue('scope').tools.length, 1); await assert.rejects(runtime.delegate('scope', source.name).prepare({ path: 'private/key' }, context()), code('TOOL_POLICY_DENIED')); assert.equal(source.calls, 0); assert.equal(policy.evaluate({ toolName: 'run_command', effect: 'execute', mode: 'build', requiresApproval: true, resources: ['command:rm -rf .'] }).decision, 'deny'); });
test('descendant path restriction applies only deny/ask path rules the call resources did not already decide', () => {
  const policy = new ToolPolicy([{ tool: '*', resource: 'path:secrets/**', decision: 'deny' }, { tool: 'list_files', resource: 'path:vault/**', decision: 'ask' }, { effect: 'write', resource: 'path:src/**', decision: 'deny' }, { tool: '*', resource: 'path:docs/**', decision: 'allow' }, { tool: '*', resource: 'command:ls', decision: 'deny' }]);
  const restricted = policy.descendantRestriction({ toolName: 'list_files', effect: 'read', resources: ['path:.'] })!;
  assert.deepEqual(['secrets', 'secrets/a', 'secretsx/a', 'vault/b', 'src/c', 'docs/d'].filter(restricted), ['secrets', 'secrets/a', 'vault/b']);
  assert.deepEqual(['secrets/a', 'vault/b'].filter(policy.descendantRestriction({ toolName: 'list_files', effect: 'read', resources: ['path:vault'] })!), ['secrets/a']);
  assert.equal(policy.descendantRestriction({ toolName: 'search_files', effect: 'read', resources: ['path:secrets'] }), undefined);
});
test('exact-resource grants do not authorize different paths and internal state is allowed in plan', () => { const policy = new ToolPolicy(); assert.equal(policy.evaluate({ toolName: 'todo_write', effect: 'state', mode: 'plan', requiresApproval: false }).decision, 'allow'); const grants = new ScopedToolGrants(); const scope = { workspaceId: 'w', sessionId: 's', toolName: 'edit_file', effect: 'write' as const, resources: ['path:src/a.ts'] }; grants.issue({ ...scope, policyVersion: 1, ttlMs: 1000 }); assert.ok(grants.find(scope, 1)); assert.equal(grants.find({ ...scope, resources: ['path:src/b.ts'] }, 1), undefined); assert.equal(grants.find({ ...scope, resources: undefined }, 1), undefined); });
test('CAS-backed grants survive restart and conflict invalidates cached authorization', () => {
  const records = new Map<string, { revision: number; data: import('@moodcode/contracts').JsonObject }>();
  const persistence = { getSessionDocument(sessionId: string) { return structuredClone(records.get(sessionId) ?? null); }, putSessionDocument(sessionId: string, _kind: string, expected: number, data: import('@moodcode/contracts').JsonObject) { const prior = records.get(sessionId); if ((prior?.revision ?? 0) !== expected) throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT' }); const next = { revision: expected + 1, data: structuredClone(data) }; records.set(sessionId, next); return structuredClone(next); } };
  const scope = { workspaceId: 'w', sessionId: 's', toolName: 'run_command', effect: 'execute' as const, resources: ['command:echo secret-token'] };
  const first = new ScopedToolGrants(() => 1000, persistence); const grant = first.issue({ ...scope, policyVersion: 1, ttlMs: 1000, maxUses: 2 }); assert.ok(!JSON.stringify(records).includes('secret-token')); assert.ok(!JSON.stringify(persistence.getSessionDocument('s')).includes('secret-token'));
  const second = new ScopedToolGrants(() => 1000, persistence); assert.ok(second.find(scope, 1)); first.revoke(grant.id); assert.throws(() => second.consume(grant.id, scope, 1, grant.revision), code('REVISION_CONFLICT')); assert.equal(second.find(scope, 1), undefined);
  const restarted = new ScopedToolGrants(() => 1000, persistence); assert.equal(restarted.find(scope, 1), undefined);
});
test('repeat read identity is stable across call IDs while approval fingerprints stay distinct', async () => { const runtime = new ScopedToolRuntime(); const source = tool('read_file'); runtime.register('scope', source); const delegate = runtime.delegate('scope', source.name); const first = await delegate.prepare({ path: 'a' }, context()); const second = await delegate.prepare({ path: 'a' }, { ...context(), toolCallId: 'another' }); assert.notEqual(first.fingerprint, second.fingerprint); assert.equal(runtime.repeatIdentity(first), runtime.repeatIdentity(second)); first.preview.changed = true; assert.throws(() => runtime.repeatIdentity(first), code('INVALID_PREPARED_TOOL')); });
test('included host scopes are composed explicitly and stale captures cannot resolve removed tools', async () => { const runtime = new ScopedToolRuntime(); runtime.register('engine', tool('read_file')); runtime.register('plugin_demo', tool('custom')); const original = runtime.catalogue('engine'); runtime.setIncludedScopes('engine', ['plugin_demo']); assert.deepEqual(runtime.catalogue('engine').tools.map(t => t.name), ['read_file', 'custom']); assert.throws(() => runtime.resolve(original, 'read_file'), code('TOOL_CATALOGUE_STALE')); const captured = runtime.catalogue('engine'); const custom = runtime.resolve(captured, 'custom'); assert.equal(custom.effectClass, 'unknown'); await custom.prepare({}, context()); runtime.clearScope('plugin_demo'); assert.throws(() => runtime.resolve(captured, 'custom'), code('TOOL_CATALOGUE_STALE')); });
test('included scopes never silently shadow duplicate tool names', () => { const runtime = new ScopedToolRuntime(); runtime.register('engine', tool('a')); runtime.register('plugin_demo', tool('a')); assert.throws(() => runtime.setIncludedScopes('engine', ['plugin_demo']), code('TOOL_SCOPE_CONFLICT')); runtime.clearScope('plugin_demo'); runtime.setIncludedScopes('engine', ['plugin_demo']); assert.throws(() => runtime.register('plugin_demo', tool('a')), code('TOOL_SCOPE_CONFLICT')); });
test('lazy artifact failure and invalid result data preserve already returned producer effects', async () => { let opened = 0; const runtime = new ScopedToolRuntime({ artifacts: async () => { opened++; throw new Error('fixture-secret'); } }); const source = tool('edit_file', true); runtime.register('scope', source); assert.equal(opened, 0); const delegate = runtime.delegate('scope', source.name); const ctx = context(); const result = await runtime.executeApproved(await delegate.prepare({}, ctx), ctx, approval()); assert.equal(source.calls, 1); assert.equal(opened, 1); assert.equal(result.content, 'full result'); assert.equal(result.isError, true); assert.equal(result.structuredResult?.metadata?.artifactPersistenceFailed, true); assert.ok(!JSON.stringify(result).includes('fixture-secret'));
 const other = new ScopedToolRuntime(); const invalid = tool('edit_file', true); invalid.execute = async () => { invalid.calls++; const data: Record<string, unknown> = {}; data.self = data; return { content: 'effect completed', data: data as never }; }; other.register('scope', invalid); const result2 = await other.executeApproved(await other.delegate('scope', invalid.name).prepare({}, ctx), ctx, approval()); assert.equal(result2.content, 'effect completed'); assert.equal(result2.isError, true); assert.equal(result2.data, undefined); assert.equal(result2.structuredResult?.metadata?.resultProjectionFailed, true);
});
test('known unavailable managed persistence preserves bounded producer results and honest output artifacts', async () => {
  const capability = { code: 'ARTIFACT_PLATFORM_UNSUPPORTED' as const, reason: 'Managed result copies are unavailable on this platform.' };
  const runtime = new ScopedToolRuntime({ artifactsUnavailable: capability }), source = tool('run_command', true);
  const content = '한글🙂'.repeat(1_000), paths = [{ path: '/trusted-fixture/stdout.log', bytes: 1_024, truncated: true }];
  source.execute = async () => { source.calls++; return { content, data: { cleanupConfirmed: true, observedBytes: 10_000 }, artifacts: paths }; };
  runtime.register('scope', source);
  capability.reason = 'A later host object mutation cannot change this warning';
  const ctx = context(); ctx.limits.maxOutputBytes = 128;
  const result = await runtime.executeApproved(await runtime.delegate('scope', source.name).prepare({}, ctx), ctx, approval());
  assert.equal(source.calls, 1); assert.equal(result.isError, undefined); assert.equal(result.content, content);
  assert.deepEqual(result.data, { cleanupConfirmed: true, observedBytes: 10_000 }); assert.deepEqual(result.artifacts, paths);
  assert.equal(result.structuredResult?.outcome, 'completed'); assert.deepEqual(result.structuredResult?.artifactRefs, []);
  assert.equal(result.structuredResult?.metadata?.artifactPersistenceUnavailable, true);
  assert.equal(result.structuredResult?.metadata?.artifactPersistenceCode, 'ARTIFACT_PLATFORM_UNSUPPORTED');
  assert.equal(result.structuredResult?.metadata?.artifactPersistenceFailed, undefined);
  assert.ok(result.structuredResult?.warnings.includes('Managed result copies are unavailable on this platform.'));
  assert.ok(Buffer.byteLength(result.structuredResult!.modelContent) <= 128); assert.ok(Buffer.byteLength(result.structuredResult!.displayContent) <= 128);
  assert.equal(result.structuredResult!.modelContent.includes('\uFFFD'), false);
});
test('known optional artifact unavailability cannot hide unavailable native command ownership or producer errors', async () => {
  const runtime = new ScopedToolRuntime({ artifactsUnavailable: { code: 'ARTIFACT_PLATFORM_UNSUPPORTED', reason: 'Managed copies unavailable.' } });
  const missing = tool('run_command', true);
  missing.execute = async () => { missing.calls++; throw new EngineError('WINDOWS_JOB_BACKEND_UNAVAILABLE', 'Actual native command ownership unavailable'); };
  runtime.register('scope', missing);
  const ctx = context();
  await assert.rejects(runtime.executeApproved(await runtime.delegate('scope', missing.name).prepare({}, ctx), ctx, approval()), code('WINDOWS_JOB_BACKEND_UNAVAILABLE'));
  assert.equal(missing.calls, 1);
  const failed = tool('failed_command', true);
  failed.execute = async () => { failed.calls++; return { content: 'Producer failed', isError: true, data: { cleanupConfirmed: false } }; };
  runtime.register('scope', failed);
  const result = await runtime.executeApproved(await runtime.delegate('scope', failed.name).prepare({}, ctx), ctx, approval());
  assert.equal(failed.calls, 1); assert.equal(result.isError, true); assert.equal(result.structuredResult?.outcome, 'failed');
  assert.deepEqual(result.data, { cleanupConfirmed: false }); assert.deepEqual(result.structuredResult?.artifactRefs, []);
});
test('known unavailable artifact capability rejects ambiguous or unbounded host configuration', () => {
  const unavailable = { code: 'ARTIFACT_PLATFORM_UNSUPPORTED' as const, reason: 'Unsupported platform.' };
  assert.throws(() => new ScopedToolRuntime({ artifacts: async () => { throw new Error('must never open'); }, artifactsUnavailable: unavailable }), code('INVALID_ARTIFACT_CONFIGURATION'));
  for (const reason of ['', 'x'.repeat(257)]) assert.throws(() => new ScopedToolRuntime({ artifactsUnavailable: { ...unavailable, reason } }), code('INVALID_ARTIFACT_CONFIGURATION'));
  assert.throws(() => new ScopedToolRuntime({ artifactsUnavailable: { ...unavailable, code: 'ACTUAL_STORAGE_FAILURE' as never } }), code('INVALID_ARTIFACT_CONFIGURATION'));
});
test('known unavailable optional copying preserves an already persisted producer-owned artifact reference', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-runtime-owned-reference-')));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const store = await ArtifactStore.open({ directory }), ctx = context();
  const persisted = await store.put({ identity: { sessionId: ctx.sessionId, runId: ctx.runId, toolCallId: ctx.toolCallId, turnId: ctx.turnId, attemptId: ctx.attemptId }, content: 'Original producer bytes' });
  const source = tool('read_file');
  source.execute = async () => { source.calls++; return { content: 'Original producer bytes', structuredResult: createToolResultEnvelope({
    displayContent: 'Original producer bytes', artifactRefs: [persisted.reference], outcome: 'completed',
  }) }; };
  const runtime = new ScopedToolRuntime({ artifactsUnavailable: { code: 'ARTIFACT_PLATFORM_UNSUPPORTED', reason: 'Additional managed result copies unavailable.' } });
  runtime.register('scope', source);
  const result = await runtime.delegate('scope', source.name).execute(await runtime.delegate('scope', source.name).prepare({}, ctx), ctx);
  assert.equal(source.calls, 1); assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredResult?.artifactRefs, [persisted.reference]);
  assert.equal(Buffer.from((await store.read(persisted.reference.id, { identity: persisted.reference.identity })).bytes).toString(), 'Original producer bytes');
  assert.equal(result.structuredResult?.metadata?.artifactPersistenceUnavailable, true);
});
test('a real supported artifact store identity failure still fails settlement after the producer runs once', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-runtime-storage-fault-')));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const root = join(directory, 'managed'), store = await ArtifactStore.open({ directory: root });
  await rename(root, join(directory, 'original')); await mkdir(root);
  const runtime = new ScopedToolRuntime({ artifacts: store }), source = tool('edit_file', true);
  runtime.register('scope', source); const ctx = context();
  const result = await runtime.executeApproved(await runtime.delegate('scope', source.name).prepare({}, ctx), ctx, approval());
  assert.equal(source.calls, 1); assert.equal(result.content, 'full result'); assert.equal(result.isError, true);
  assert.equal(result.structuredResult?.metadata?.artifactPersistenceFailed, true);
  assert.equal(result.structuredResult?.metadata?.artifactPersistenceUnavailable, undefined);
  assert.equal(result.structuredResult?.metadata?.effectsMayBePresent, true); assert.deepEqual(result.structuredResult?.artifactRefs, []);
});
test('initial policy version identifies rule configuration across restart', () => { const first = new ToolPolicy([{ tool: 'edit_file', resource: 'path:src/**', decision: 'ask' }]); const same = new ToolPolicy([{ tool: 'edit_file', resource: 'path:src/**', decision: 'ask' }]); const different = new ToolPolicy([{ tool: 'edit_file', resource: 'path:private/**', decision: 'deny' }]); assert.equal(first.version, same.version); assert.notEqual(first.version, different.version); const old = first.version; first.replace([{ tool: '*', decision: 'deny' }]); assert.notEqual(first.version, old); });
test('catalogue allowlist narrows both provider advertisement and captured resolution', () => { const runtime = new ScopedToolRuntime(); runtime.register('engine', tool('read_file')); runtime.register('engine', tool('run_command')); const allowed = ['read_file']; const catalogue = runtime.catalogue('engine', 'build', allowed); allowed.push('run_command'); assert.deepEqual(catalogue.tools.map(t => t.name), ['read_file']); assert.throws(() => runtime.resolve(catalogue, 'run_command'), code('TOOL_NOT_FOUND')); assert.equal(runtime.catalogue('engine', 'build', []).tools.length, 0); assert.throws(() => runtime.catalogue('engine', 'build', ['*']), code('INVALID_TOOL_ALLOWLIST')); });
