import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { AI_SDK_PROVIDERS, type AiSdkProviderId } from '@moodcode/contracts';
import { AiSdkProvider, type EngineOptions, type MoodcodeEngine } from '@moodcode/engine';
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
