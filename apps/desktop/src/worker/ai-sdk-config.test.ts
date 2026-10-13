import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { AI_SDK_PROVIDERS, type AiSdkProviderId } from '@moodcode/contracts';
import { AiSdkProvider, catalogModelSpec, parseModelCatalog, type EngineOptions, type MoodcodeEngine } from '@moodcode/engine';
import { DEFAULT_PRODUCT_SETTINGS } from '../shared/product-settings.js';
import { UtilityWorker } from './core.js';

test('each SDK provider crosses preload validation and constructs the actual worker adapter without Codex credentials', async t => {
  const { validateDesktopSettings } = await import('../preload/api.js');
  for (const id of Object.keys(AI_SDK_PROVIDERS) as AiSdkProviderId[]) {
    let created: EngineOptions | undefined;
    const worker = new UtilityWorker({ emit() {}, createEngine(options) {
      created = options;
      return { store: { listWorkspaces: () => [] }, dispatch: async () => ({ ok: true, result: {} }), async *subscribe() {}, close: async () => {} } as unknown as MoodcodeEngine;
    } });
    t.after(() => worker.close());
    const config = { providerId: id, modelId: 'fixture-model', baseURL: AI_SDK_PROVIDERS[id].baseURL, apiKey: 'private-sdk-worker-key' };
    assert.deepEqual(validateDesktopSettings(config), config);
    assert.throws(() => validateDesktopSettings({ ...config, credentialMode: 'chatgpt', accountId: randomUUID() }));
    const response = await worker.handle({ id: randomUUID(), type: 'start', payload: { dbPath: ':memory:', artifactDir: resolve('fixture-artifacts'), config } });
    assert.equal(response.ok, true);
    assert.ok(created?.providers?.[0] instanceof AiSdkProvider);
    assert.equal(created.defaults?.providerId, id);
    assert.ok(!JSON.stringify(response).includes(config.apiKey));
  }
});

test('profile models retain their own catalogue limits and unrelated metadata is rejected without provider calls', async t => {
  const created: EngineOptions[] = [];
  const worker = new UtilityWorker({ emit() {}, createEngine(options) { created.push(options); return { store: { listWorkspaces: () => [] }, dispatch: async () => ({ ok: true, result: {} }), async *subscribe() {}, close: async () => {} } as unknown as MoodcodeEngine; } }); t.after(() => worker.close());
  const catalog = parseModelCatalog({ google: { models: { base: { limit: { context: 1000 } }, review: { limit: { context: 2000 } }, unrelated: { limit: { context: 3000 } } } } });
  const config = { providerId: 'google', modelId: 'base', baseURL: AI_SDK_PROVIDERS.google.baseURL, apiKey: 'private-fixture-key' };
  const spec = (id: string) => catalogModelSpec(catalog, 'google', id, config.baseURL)!;
  const payload = { dbPath: ':memory:', artifactDir: resolve('fixture-artifacts'), config, productSettings: { ...DEFAULT_PRODUCT_SETTINGS, profiles: [{ id: 'review', description: 'Review', instructions: '', modelId: 'review' }] }, modelSpecs: [spec('base'), spec('review')] };
  const rejected = await worker.handle({ id: randomUUID(), type: 'start', payload: { ...payload, modelSpecs: [spec('unrelated')] } }); assert.equal(rejected.ok, false); assert.equal(created.length, 0);
  const accepted = await worker.handle({ id: randomUUID(), type: 'start', payload }); assert.equal(accepted.ok, true); assert.deepEqual(created[0]?.modelSpecs?.map(model => model.contextWindow), [1000, 2000]); assert.equal(created[0]?.agentProfiles?.[0]?.model?.modelId, 'review');
});
