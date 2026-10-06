import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRegistry, unknownModelSpec } from './model-spec.js';
import { estimateTokens } from './plan.js';

test('unknown catalog entries retain unknown limits and capabilities', () => {
  const registry = new ModelRegistry();
  const unknown = registry.get('fixture', 'model');
  assert.equal(unknown.contextWindow, null);
  assert.equal(unknown.maxOutputTokens, null);
  assert.equal(unknown.tools, null);
  assert.deepEqual(registry.list(), []);
});

test('metadata is scoped to provider/model and isolated from caller mutation', () => {
  const registry = new ModelRegistry();
  const spec = { ...unknownModelSpec('fixture', 'model'), contextWindow: 1000, tools: true };
  registry.put(spec);
  spec.contextWindow = 1;
  assert.equal(registry.get('fixture', 'model').contextWindow, 1000);
  const returned = registry.get('fixture', 'model');
  returned.contextWindow = 2;
  assert.equal(registry.get('fixture', 'model').contextWindow, 1000);
  assert.equal(registry.get('another-provider', 'model').tools, null);
  assert.throws(() => registry.put({ ...spec, contextWindow: NaN }));
});

test('token fallback includes UTF-8 bytes and keeps its estimate provenance', () => {
  const messages = [{ role: 'user' as const, content: '한글' }];
  const estimate = estimateTokens(messages, 12);
  assert.equal(estimate.tokens, Buffer.byteLength(JSON.stringify(messages)) + 12);
  assert.equal(estimate.estimated, true);
  assert.equal(estimate.source, 'utf8-byte-upper-bound');
});
