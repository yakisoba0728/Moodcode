import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject } from '@moodcode/contracts';
import type { ToolContext, ToolDefinition, ToolEffectClass } from '../../ports.js';
import { ScopedToolRuntime, type ToolCatalogue } from './index.js';
import { ToolPolicy } from '../../permission/policy.js';

// Authored in-memory observations only. No producer filesystem/network effects,
// native evidence synthesis, project storage, approval decisions or upstream fixtures.
const failure = (code: string) => (value: unknown): boolean => value instanceof EngineError && value.code === code;
function context(id = 'call-current'): ToolContext {
  return { workspace: { id: 'workspace-current', root: '/authored/no-effects', gitRoot: '/authored/no-effects', branch: null, createdAt: '2026-10-07T00:00:00Z' },
    sessionId: 'session-current', runId: 'run-current', toolCallId: id, turnId: 'turn-current', attemptId: 'attempt-current',
    signal: new AbortController().signal, limits: { ...DEFAULT_LIMITS }, artifactDir: '/authored/no-artifacts', recordCheckpoint() {} };
}
function source(name: string, effect: ToolEffectClass = 'read', requiresApproval = false) {
  const calls = { prepare: 0, execute: 0 };
  const tool: ToolDefinition = { name, description: 'An authored current-catalogue observation.', effectClass: effect,
    inputSchema: { type: 'object', properties: { marker: { type: 'string' } } },
    async prepare(input) { calls.prepare++; return { name, input: input as JsonObject, fingerprint: `current:${JSON.stringify(input)}`, requiresApproval, preview: { operation: name } }; },
    async execute() { calls.execute++; return { content: `Observed ${name}.` }; } };
  return { tool, calls };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function noClones(operation: () => void): void {
  const original = globalThis.structuredClone; let count = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => { count++; return original(value, options); }) as typeof structuredClone;
  try { operation(); assert.equal(count, 0); } finally { globalThis.structuredClone = original; }
}

test('a current empty capture is valid without any tool to resolve, allocation or revision change', () => {
  const runtime = new ScopedToolRuntime(), catalogue = runtime.catalogue('engine'), revision = runtime.revision;
  assert.deepEqual(catalogue.tools, []);
  noClones(() => { for (let count = 0; count < 20; count++) runtime.assertCatalogueCurrent(catalogue); });
  assert.equal(runtime.revision, revision); assert.deepEqual(catalogue.tools, []);
  assert.throws(() => runtime.resolve(catalogue, 'absent'), failure('TOOL_NOT_FOUND'));
});

test('fully denied, plan-filtered and explicitly empty profile captures remain current without widening', () => {
  const policy = new ToolPolicy([{ tool: 'private_read', decision: 'deny' }]), runtime = new ScopedToolRuntime({ policy });
  runtime.register('engine', source('private_read').tool); runtime.register('engine', source('private_write', 'write').tool);
  for (const catalogue of [runtime.catalogue('engine', 'plan'), runtime.catalogue('engine', 'build', [])]) {
    runtime.assertCatalogueCurrent(catalogue); assert.deepEqual(catalogue.tools, []);
    for (const name of ['private_read', 'private_write']) assert.throws(() => runtime.resolve(catalogue, name), failure('TOOL_NOT_FOUND'));
  }
});

test('foreign runtimes and copied or forged handles cannot reuse even identical empty or populated descriptors', () => {
  const first = new ScopedToolRuntime(), second = new ScopedToolRuntime();
  for (const runtime of [first, second]) runtime.register('engine', source('private_read').tool);
  const catalogue = first.catalogue('engine'), foreign = second.catalogue('engine');
  assert.deepEqual(catalogue, foreign);
  for (const value of [foreign, structuredClone(catalogue), { ...catalogue }, new ScopedToolRuntime().catalogue('engine'), null, undefined]) {
    assert.throws(() => first.assertCatalogueCurrent(value as ToolCatalogue), failure('TOOL_CATALOGUE_STALE'));
  }
  first.assertCatalogueCurrent(catalogue);
});

test('foreign proxy, accessors and serialization hooks are rejected by ownership before supplied traps run', () => {
  const runtime = new ScopedToolRuntime(), catalogue = runtime.catalogue('engine'); let traps = 0;
  const proxy = new Proxy(catalogue, { get() { traps++; throw new Error('untrusted get'); }, ownKeys() { traps++; throw new Error('untrusted ownKeys'); }, getPrototypeOf() { traps++; throw new Error('untrusted prototype'); } });
  const getter = Object.defineProperty({}, 'tools', { enumerable: true, get() { traps++; throw new Error('untrusted getter'); } });
  const serializer = { ...catalogue, toJSON() { traps++; throw new Error('untrusted serialization'); } };
  for (const value of [proxy, getter, serializer]) assert.throws(() => runtime.assertCatalogueCurrent(value as ToolCatalogue), failure('TOOL_CATALOGUE_STALE'));
  assert.equal(traps, 0); runtime.assertCatalogueCurrent(catalogue);
});

test('owned descriptor, schema, ordering and catalogue identity mutations invalidate the original signature', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', source('private_first').tool); runtime.register('engine', source('private_second').tool);
  const changes: ((catalogue: ToolCatalogue) => void)[] = [
    catalogue => { catalogue.scopeId = 'other'; }, catalogue => { catalogue.mode = 'plan'; }, catalogue => { catalogue.revision++; }, catalogue => { catalogue.policyVersion++; },
    catalogue => { catalogue.tools[0]!.name = 'replacement'; }, catalogue => { catalogue.tools[0]!.description = 'Changed descriptor.'; },
    catalogue => { catalogue.tools[0]!.inputSchema.type = 'array'; }, catalogue => { (catalogue.tools as ToolCatalogue['tools'][number][]).reverse(); },
  ];
  for (const change of changes) {
    const catalogue = runtime.catalogue('engine'); change(catalogue);
    assert.throws(() => runtime.assertCatalogueCurrent(catalogue), failure('TOOL_CATALOGUE_STALE'));
    assert.throws(() => runtime.resolve(catalogue, 'private_first'), failure('TOOL_CATALOGUE_STALE'));
  }
  runtime.assertCatalogueCurrent(runtime.catalogue('engine'));
});

test('any registry revision change invalidates existing empty and populated captures while fresh captures are current', () => {
  const runtime = new ScopedToolRuntime(), empty = runtime.catalogue('engine'); runtime.register('engine', source('private_read').tool);
  assert.throws(() => runtime.assertCatalogueCurrent(empty), failure('TOOL_CATALOGUE_STALE'));
  const populated = runtime.catalogue('engine'), filtered = runtime.catalogue('engine', 'build', []);
  runtime.register('unrelated_scope', source('other_read').tool);
  for (const catalogue of [populated, filtered]) assert.throws(() => runtime.assertCatalogueCurrent(catalogue), failure('TOOL_CATALOGUE_STALE'));
  runtime.assertCatalogueCurrent(runtime.catalogue('engine'));
});

test('dispose and same-name re-registration never transfer a captured handler or let an old disposer remove the replacement', async () => {
  const runtime = new ScopedToolRuntime(), old = source('private_read'), replacement = source('private_read');
  const dispose = runtime.register('engine', old.tool), catalogue = runtime.catalogue('engine'), handler = runtime.resolve(catalogue, old.tool.name);
  const ctx = context(), prepared = await handler.prepare({}, ctx); dispose(); runtime.register('engine', replacement.tool); dispose();
  assert.throws(() => runtime.assertCatalogueCurrent(catalogue), failure('TOOL_CATALOGUE_STALE'));
  await assert.rejects(handler.execute(prepared, ctx), failure('TOOL_CATALOGUE_STALE'));
  const fresh = runtime.catalogue('engine'); runtime.assertCatalogueCurrent(fresh);
  const newHandler = runtime.resolve(fresh, replacement.tool.name); await newHandler.execute(await newHandler.prepare({}, ctx), ctx);
  assert.equal(old.calls.execute, 0); assert.equal(replacement.calls.execute, 1);
});

test('scope inclusion and removal are part of source currency and cannot preserve a removed remote handler', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', source('local_read').tool); runtime.register('mcp_private', source('remote_read', 'unknown').tool);
  const initial = runtime.catalogue('engine'); runtime.setIncludedScopes('engine', ['mcp_private']);
  assert.throws(() => runtime.assertCatalogueCurrent(initial), failure('TOOL_CATALOGUE_STALE'));
  const included = runtime.catalogue('engine'); runtime.assertCatalogueCurrent(included); assert.ok(included.tools.some(tool => tool.name === 'remote_read'));
  runtime.clearScope('mcp_private'); assert.throws(() => runtime.assertCatalogueCurrent(included), failure('TOOL_CATALOGUE_STALE'));
  const fresh = runtime.catalogue('engine'); runtime.assertCatalogueCurrent(fresh);
  assert.throws(() => runtime.resolve(fresh, 'remote_read'), failure('TOOL_NOT_FOUND'));
});

test('policy replacement invalidates captures independently of registry changes, including equivalent rules', () => {
  const policy = new ToolPolicy(), runtime = new ScopedToolRuntime({ policy }); runtime.register('engine', source('private_read').tool);
  const captured = runtime.catalogue('engine'), registryRevision = runtime.revision; policy.replace([]);
  assert.equal(runtime.revision, registryRevision); assert.throws(() => runtime.assertCatalogueCurrent(captured), failure('TOOL_CATALOGUE_STALE'));
  const fresh = runtime.catalogue('engine'); runtime.assertCatalogueCurrent(fresh);
  policy.replace([{ tool: 'private_read', decision: 'deny' }]); assert.throws(() => runtime.assertCatalogueCurrent(fresh), failure('TOOL_CATALOGUE_STALE'));
  const denied = runtime.catalogue('engine'); runtime.assertCatalogueCurrent(denied); assert.deepEqual(denied.tools, []);
});

test('host source mutation does not alter owned schema or registered handler and current checking grants no extra call', async () => {
  const runtime = new ScopedToolRuntime(), original = source('private_read'); runtime.register('engine', original.tool);
  const catalogue = runtime.catalogue('engine'), handler = runtime.resolve(catalogue, original.tool.name); let replacementCalls = 0;
  original.tool.inputSchema.type = 'array'; original.tool.execute = async () => { replacementCalls++; return { content: 'Replacement.' }; };
  noClones(() => runtime.assertCatalogueCurrent(catalogue)); assert.equal(catalogue.tools[0]!.inputSchema.type, 'object');
  assert.equal(original.calls.prepare, 0); assert.equal(original.calls.execute, 0);
  const ctx = context(); await handler.execute(await handler.prepare({}, ctx), ctx);
  assert.equal(original.calls.execute, 1); assert.equal(replacementCalls, 0);
});

test('current materialized discovery captures expose only their exact selected handler set', () => {
  const runtime = new ScopedToolRuntime(); runtime.register('engine', source('chosen_read').tool); runtime.register('engine', source('hidden_read').tool);
  const metadata = runtime.discoveryCatalogue('engine'), catalogue = runtime.materializeDiscovery(metadata, ['chosen_read'], { maxTools: 1, maxBytes: 4096 });
  runtime.assertCatalogueCurrent(catalogue); assert.deepEqual(catalogue.tools.map(tool => tool.name), ['chosen_read']);
  assert.throws(() => runtime.resolve(catalogue, 'hidden_read'), failure('TOOL_NOT_FOUND'));
  runtime.policy.replace([]); assert.throws(() => runtime.assertCatalogueCurrent(catalogue), failure('TOOL_CATALOGUE_STALE'));
});

for (const mutation of ['registry', 'policy'] as const) test(`a ${mutation} change while prepare awaits cannot return an authorized handle from the old capture`, { timeout: 3000 }, async () => {
  const runtime = new ScopedToolRuntime(), observation = source('private_read'), entered = deferred(), release = deferred();
  const prepare = observation.tool.prepare;
  observation.tool.prepare = async (...args) => { entered.resolve(); await release.promise; return prepare(...args); };
  runtime.register('engine', observation.tool); const catalogue = runtime.catalogue('engine'), handler = runtime.resolve(catalogue, observation.tool.name);
  const preparing = handler.prepare({}, context()); await entered.promise;
  if (mutation === 'registry') runtime.register('other_scope', source('other_read').tool); else runtime.policy.replace([{ tool: observation.tool.name, decision: 'deny' }]);
  release.resolve(); await assert.rejects(preparing, failure('TOOL_CATALOGUE_STALE')); assert.equal(observation.calls.execute, 0);
  runtime.assertCatalogueCurrent(runtime.catalogue('engine'));
});

test('a successful current check does not authorize a copied prepared handle or changed execution identity', async () => {
  const runtime = new ScopedToolRuntime(), observation = source('private_read'); runtime.register('engine', observation.tool);
  const catalogue = runtime.catalogue('engine'), handler = runtime.resolve(catalogue, observation.tool.name), ctx = context();
  const prepared = await handler.prepare({}, ctx); runtime.assertCatalogueCurrent(catalogue);
  await assert.rejects(handler.execute(structuredClone(prepared), ctx), failure('INVALID_PREPARED_TOOL'));
  await assert.rejects(handler.execute(prepared, { ...ctx, toolCallId: 'other-call' }), failure('TOOL_APPROVAL_STALE'));
  await assert.rejects(handler.execute(prepared, ctx), failure('INVALID_PREPARED_TOOL'));
  const fresh = await handler.prepare({}, ctx); await handler.execute(fresh, ctx);
  assert.equal(observation.calls.execute, 1);
});

test('current checking does not consume grants, and a policy update cannot reuse an old grant or prepared authorization', async () => {
  const runtime = new ScopedToolRuntime(), observation = source('private_write', 'write', true); let validations = 0;
  runtime.register('engine', observation.tool, { revalidate: async () => { validations++; } });
  const scope = { workspaceId: context().workspace.id, sessionId: context().sessionId, toolName: observation.tool.name, effect: 'write' as const };
  const grant = runtime.grants.issue({ ...scope, policyVersion: runtime.policy.version, ttlMs: 10000, maxUses: 2 });
  const catalogue = runtime.catalogue('engine'), handler = runtime.resolve(catalogue, observation.tool.name), ctx = context();
  const prepared = await handler.prepare({}, ctx); assert.equal(prepared.requiresApproval, false);
  for (let count = 0; count < 10; count++) runtime.assertCatalogueCurrent(catalogue);
  assert.equal(runtime.grants.find(scope, runtime.policy.version)!.remainingUses, 2); assert.equal(validations, 0);
  runtime.policy.replace([]); await assert.rejects(handler.execute(prepared, ctx), failure('TOOL_CATALOGUE_STALE'));
  assert.equal(runtime.grants.find(scope, runtime.policy.version), undefined);
  const fresh = runtime.catalogue('engine'); runtime.assertCatalogueCurrent(fresh);
  assert.equal((await runtime.resolve(fresh, observation.tool.name).prepare({}, ctx)).requiresApproval, true);
  assert.equal(observation.calls.execute, 0); assert.equal(grant.remainingUses, 2);
});

test('registry change during grant revalidation stops effects and leaves the grant unconsumed', { timeout: 3000 }, async () => {
  const runtime = new ScopedToolRuntime(), observation = source('private_write', 'write', true), entered = deferred(), release = deferred();
  runtime.register('engine', observation.tool, { revalidate: async () => { entered.resolve(); await release.promise; } });
  const ctx = context(), scope = { workspaceId: ctx.workspace.id, sessionId: ctx.sessionId, toolName: observation.tool.name, effect: 'write' as const };
  runtime.grants.issue({ ...scope, policyVersion: runtime.policy.version, ttlMs: 10000, maxUses: 2 });
  const catalogue = runtime.catalogue('engine'), handler = runtime.resolve(catalogue, observation.tool.name), prepared = await handler.prepare({}, ctx);
  const executing = handler.execute(prepared, ctx); await entered.promise; runtime.register('other_scope', source('other_read').tool); release.resolve();
  await assert.rejects(executing, failure('TOOL_CATALOGUE_STALE')); assert.equal(observation.calls.execute, 0);
  assert.equal(runtime.grants.find(scope, runtime.policy.version)!.remainingUses, 2);
});

test('a current catalogue cannot suppress cancellation observed after a held prepare', { timeout: 3000 }, async () => {
  const runtime = new ScopedToolRuntime(), observation = source('private_read'), entered = deferred(), release = deferred(), controller = new AbortController();
  const prepare = observation.tool.prepare; observation.tool.prepare = async (...args) => { entered.resolve(); await release.promise; return prepare(...args); };
  runtime.register('engine', observation.tool); const catalogue = runtime.catalogue('engine'), handler = runtime.resolve(catalogue, observation.tool.name);
  const preparing = handler.prepare({}, { ...context(), signal: controller.signal }); await entered.promise;
  runtime.assertCatalogueCurrent(catalogue); controller.abort(); release.resolve();
  await assert.rejects(preparing, failure('CANCELLED')); assert.equal(observation.calls.execute, 0); runtime.assertCatalogueCurrent(catalogue);
});
