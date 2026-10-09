import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { AnthropicProvider, type EngineOptions, type MoodcodeEngine } from '@moodcode/engine';
import { UtilityWorker } from './core.js';

const artifactDir = resolve('fixture-artifacts');

test('worker constructs Anthropic without a scripted fallback and preserves host effort', async t => {
  for (const workspace of [undefined, 'wrkspc_fixtureDesktop']) {
    let created: EngineOptions | undefined;
    const worker = new UtilityWorker({ emit() {}, createEngine(options) {
      created = options;
      return { store: { listWorkspaces: () => [] }, dispatch: async () => ({ ok: true, result: {} }), async *subscribe() {}, close: async () => {} } as unknown as MoodcodeEngine;
    } });
    t.after(() => worker.close());
    const response = await worker.handle({ id: randomUUID(), type: 'start', payload: { dbPath: ':memory:', artifactDir, config: {
      providerId: 'anthropic', modelId: 'fixture-anthropic-model', baseURL: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-fixture-worker', reasoningEffort: 'high',
      ...(workspace ? { anthropicWorkspaceId: workspace } : {}),
    } } });
    assert.equal(response.ok, true);
    assert.ok(created?.providers?.[0] instanceof AnthropicProvider);
    assert.equal(created.defaults?.providerId, 'anthropic');
    assert.equal(created.defaults?.reasoningEffort, 'high');
    assert.ok(!JSON.stringify(response).includes('sk-ant-fixture-worker'));
  }
});

test('worker rejects non-Anthropic workspaces, unsafe header values and unsupported effort before Engine creation', async () => {
  const valid = { providerId: 'anthropic', modelId: 'fixture-anthropic-model', baseURL: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-fixture-worker' };
  const inputs = [
    { ...valid, anthropicWorkspaceId: 'wrkspc_ok\r\nx-injected: yes' },
    { ...valid, anthropicWorkspaceId: '' },
    { ...valid, anthropicWorkspaceId: null },
    { ...valid, anthropicWorkspaceId: 'wrkspc_' + 'a'.repeat(129) },
    { ...valid, providerId: 'openai-responses', anthropicWorkspaceId: 'wrkspc_fixtureDesktop' },
    { ...valid, reasoningEffort: 'ultra' },
    { ...valid, apiKey: 'wrkspc_fixturePrivate', anthropicWorkspaceId: 'wrkspc_fixturePrivate' },
  ];
  let created = 0;
  for (const config of inputs) {
    const worker = new UtilityWorker({ emit() {}, createEngine() { created++; throw new Error('Unexpected Engine creation'); } });
    const response = await worker.handle({ id: randomUUID(), type: 'start', payload: { dbPath: ':memory:', artifactDir, config } });
    assert.equal(response.ok, false);
    assert.ok(!JSON.stringify(response).includes(config.apiKey));
    await worker.close();
  }
  assert.equal(created, 0);
});
