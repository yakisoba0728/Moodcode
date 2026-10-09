import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { DEFAULT_LIMITS } from '@moodcode/contracts';
import type { ToolContext, ToolDefinition } from '../ports.js';
import { ScopedToolRuntime } from '../tools/runtime/index.js';
import { EnginePluginManager, observePluginTool } from './index.js';
const signal = () => new AbortController().signal; const code = (expected: string) => (e: unknown) => { assert.equal((e as { code: string }).code, expected); return true; };
function tool(name = 'custom'): ToolDefinition { return { name, description: 'fixture tool', inputSchema: { type: 'object' }, async prepare(input) { return { name, input: input as never, fingerprint: 'fixture', requiresApproval: false, preview: {} }; }, async execute() { return { content: 'fixture result' }; } }; }
function context(): ToolContext { return { workspace: { id: 'w', root: '/w', gitRoot: '/w', branch: null, createdAt: new Date().toISOString() }, sessionId: 's', runId: 'r', toolCallId: 'call', signal: signal(), limits: { ...DEFAULT_LIMITS }, artifactDir: '/a', recordCheckpoint() {} }; }
test('explicit plugin activation registers scoped tools and deactivation invalidates prepared captures', async () => { const runtime = new ScopedToolRuntime(); const manager = new EnginePluginManager(runtime); let disposed = 0; const active = await manager.activate({ id: 'demo', async activate() { return { tools: [tool()], dispose() { disposed++; } }; } }, signal()); const catalogue = runtime.catalogue(active.scopeId); const definition = runtime.resolve(catalogue, 'custom'); const prepared = await definition.prepare({}, context()); assert.equal(prepared.requiresApproval, true); await manager.deactivate(active.id); assert.equal(disposed, 1); assert.equal(manager.list().length, 0); await assert.rejects(definition.execute(prepared, context()), code('TOOL_CATALOGUE_STALE')); });
test('partial registration failure disposes only activation-owned tools', async () => { const runtime = new ScopedToolRuntime(); const manager = new EnginePluginManager(runtime); let disposed = false; await assert.rejects(manager.activate({ id: 'demo', async activate() { return { tools: [tool('a'), tool('a')], dispose() { disposed = true; } }; } }, signal()), code('TOOL_REGISTRATION_CONFLICT')); assert.equal(disposed, true); assert.equal(runtime.catalogue('plugin_demo').tools.length, 0); });
test('cancelled noncooperating activation cleans up once when factory eventually returns', async () => { const runtime = new ScopedToolRuntime(); const manager = new EnginePluginManager(runtime); let resolve!: (value: { tools: ToolDefinition[]; dispose(): void }) => void; let disposed = 0; const controller = new AbortController(); const pending = manager.activate({ id: 'demo', activate() { return new Promise(done => { resolve = done; }); } }, controller.signal); controller.abort(); await assert.rejects(pending, code('PLUGIN_CANCELLED')); resolve({ tools: [tool()], dispose() { disposed++; } }); await new Promise<void>(done => setImmediate(done)); assert.equal(disposed, 1); assert.equal(manager.list().length, 0); });
test('duplicate plugin ids and close reject future activations', async () => { const runtime = new ScopedToolRuntime(); const manager = new EnginePluginManager(runtime); const plugin = { id: 'demo', async activate() { return { tools: [tool()] }; } }; await manager.activate(plugin, signal()); await assert.rejects(manager.activate(plugin, signal()), code('PLUGIN_ALREADY_ACTIVE')); await manager.close(); assert.equal(runtime.catalogue('plugin_demo').tools.length, 0); await assert.rejects(manager.activate(plugin, signal()), code('INVALID_ENGINE_PLUGIN')); });
test('metadata hooks cannot rewrite prepared identity and settlement hook failure preserves result', async () => { let called = false; const source = observePluginTool('demo', tool(), { prepared(metadata) { assert.equal('input' in metadata, false); assert.equal(metadata.fingerprint, 'fixture'); called = true; }, settled() { throw new Error('fixture-secret'); } }); const ctx = context(); const prepared = await source.prepare({ private: 'payload' }, ctx); const result = await source.execute(prepared, ctx); assert.equal(called, true); assert.equal(result.content, 'fixture result'); assert.ok(result.structuredResult?.warnings[0]?.includes('settlement hook')); assert.ok(!JSON.stringify(result).includes('fixture-secret')); });
test('close waits for cancelled activation late teardown and rejects unconfirmed cleanup', async () => { const manager = new EnginePluginManager(new ScopedToolRuntime()); let resolve!: (activation: { tools: ToolDefinition[]; dispose(): Promise<void> }) => void; let cleaned = false; const pending = manager.activate({ id: 'late', activate() { return new Promise(done => { resolve = done; }); } }, signal()); const pendingError = assert.rejects(pending, code('PLUGIN_CANCELLED')); const close = manager.close(); resolve({ tools: [], async dispose() { await new Promise(done => setTimeout(done, 10)); cleaned = true; } }); await pendingError; await close; assert.equal(cleaned, true);
 const unknown = new EnginePluginManager(new ScopedToolRuntime()); const stalled = unknown.activate({ id: 'stalled', activate() { return new Promise(() => {}); } }, signal()); const stalledError = assert.rejects(stalled, code('PLUGIN_CANCELLED')); await assert.rejects(unknown.close(), code('PLUGIN_ACTIVATION_UNCERTAIN')); await stalledError;
});

test('deactivate and close retain pending plugin disposal until it settles', async () => {
  const manager = new EnginePluginManager(new ScopedToolRuntime());
  let release!: () => void, entered!: () => void, disposed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entry = new Promise<void>(resolve => { entered = resolve; });
  await manager.activate({ id: 'owned', async activate() { return { tools: [tool()], async dispose() { disposed++; entered(); await gate; } }; } }, signal());
  await tick();
  const deactivation = manager.deactivate('owned'); await entry;
  let repeatedSettled = false, closeSettled = false;
  const repeated = manager.deactivate('owned').then(() => { repeatedSettled = true; });
  const closing = manager.close().then(() => { closeSettled = true; });
  try {
    await tick();
    assert.equal(closeSettled, false, 'close must retain the pending disposal owner');
    assert.equal(repeatedSettled, false, 'repeated deactivation must join the same owner');
    assert.equal(disposed, 1);
  } finally { release(); await Promise.all([deactivation, repeated, closing]); }
  assert.equal(disposed, 1); assert.equal(closeSettled, true);
});

test('same plugin ID remains reserved while deactivation disposal is pending', async () => {
  const manager = new EnginePluginManager(new ScopedToolRuntime());
  let release!: () => void, entered!: () => void, replacementFactories = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entry = new Promise<void>(resolve => { entered = resolve; });
  await manager.activate({ id: 'owned', async activate() { return { tools: [], async dispose() { entered(); await gate; } }; } }, signal());
  await tick();
  const deactivation = manager.deactivate('owned'); await entry;
  try {
    await assert.rejects(manager.activate({ id: 'owned', async activate() { replacementFactories++; return { tools: [] }; } }, signal()), code('PLUGIN_ALREADY_ACTIVE'));
    assert.equal(replacementFactories, 0);
  } finally { release(); await deactivation; await manager.close(); }
});

test('a rejected deactivation disposal remains visible to later close', async () => {
  const manager = new EnginePluginManager(new ScopedToolRuntime()); let disposed = 0;
  await manager.activate({ id: 'failed', async activate() { return { tools: [], dispose() { disposed++; throw new Error('authored disposal rejection'); } }; } }, signal());
  await tick();
  await assert.rejects(manager.deactivate('failed'), code('PLUGIN_CLEANUP_FAILED'));
  await assert.rejects(manager.deactivate('failed'), code('PLUGIN_CLEANUP_FAILED'));
  await assert.rejects(manager.close(), code('PLUGIN_CLEANUP_FAILED'));
  assert.equal(disposed, 1);
});

test('close bounds an already pending deactivation without forgetting its cleanup', async () => {
  const manager = new EnginePluginManager(new ScopedToolRuntime());
  let release!: () => void, entered!: () => void, disposed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entry = new Promise<void>(resolve => { entered = resolve; });
  await manager.activate({ id: 'pending', async activate() { return { tools: [], async dispose() { disposed++; entered(); await gate; } }; } }, signal());
  await tick();
  const deactivation = manager.deactivate('pending'); await entry;
  try {
    const start = Date.now();
    await assert.rejects(manager.close(), code('PLUGIN_ACTIVATION_UNCERTAIN'));
    assert.ok(Date.now() - start < 2000); assert.equal(disposed, 1);
  } finally { release(); await deactivation; }
  await manager.close(); assert.equal(disposed, 1);
});

test('failed registration disposal remains owned after activation settles', async () => {
  const manager = new EnginePluginManager(new ScopedToolRuntime()); let disposed = 0, replacements = 0;
  await assert.rejects(manager.activate({ id: 'failed', async activate() { return { tools: [tool('duplicate'), tool('duplicate')], dispose() { disposed++; throw new Error('authored registration disposal rejection'); } }; } }, signal()), code('PLUGIN_CLEANUP_FAILED'));
  await tick();
  const replacementError = await manager.activate({ id: 'failed', async activate() { replacements++; return { tools: [] }; } }, signal()).then(() => undefined, error => error as { code: string });
  const closeError = await manager.close().then(() => undefined, error => error as { code: string });
  assert.deepEqual({ replacement: replacementError?.code, close: closeError?.code, replacements, disposed }, { replacement: 'PLUGIN_ALREADY_ACTIVE', close: 'PLUGIN_CLEANUP_FAILED', replacements: 0, disposed: 1 });
});

test('cancelled late factory disposal failure remains owned after settlement', async () => {
  const manager = new EnginePluginManager(new ScopedToolRuntime()); let disposed = 0, replacements = 0;
  let deliver!: (activation: { tools: ToolDefinition[]; dispose(): void }) => void;
  const controller = new AbortController();
  const activation = manager.activate({ id: 'late', activate() { return new Promise(resolve => { deliver = resolve; }); } }, controller.signal);
  controller.abort(); await assert.rejects(activation, code('PLUGIN_CANCELLED'));
  deliver({ tools: [], dispose() { disposed++; throw new Error('authored late disposal rejection'); } });
  await tick();
  const replacementError = await manager.activate({ id: 'late', async activate() { replacements++; return { tools: [] }; } }, signal()).then(() => undefined, error => error as { code: string });
  const closeError = await manager.close().then(() => undefined, error => error as { code: string });
  assert.deepEqual({ replacement: replacementError?.code, close: closeError?.code, replacements, disposed }, { replacement: 'PLUGIN_ALREADY_ACTIVE', close: 'PLUGIN_CLEANUP_FAILED', replacements: 0, disposed: 1 });
});
