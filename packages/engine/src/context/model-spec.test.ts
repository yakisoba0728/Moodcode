import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRegistry, unknownModelSpec, type ModelSpec } from './model-spec.js';
import { estimateTokens } from './plan.js';

test('unknown catalog entries retain unknown limits and capabilities', () => {
  const registry = new ModelRegistry();
  const unknown = registry.get('fixture', 'model');
  assert.equal(unknown.contextWindow, null);
  assert.equal(unknown.maxOutputTokens, null);
  assert.equal(unknown.tools, null);
  assert.equal(unknown.inputFileTypes, null);
  assert.deepEqual(registry.list(), []);
});

test('native file metadata separates unknown, explicit unsupported and declared PDF support', () => {
  const registry = new ModelRegistry(), baseline = unknownModelSpec('fixture', 'model');
  const legacy: ModelSpec = { ...baseline }; delete legacy.inputFileTypes;
  assert.equal(registry.put(legacy).inputFileTypes, null);
  assert.equal(registry.get('fixture', 'model').inputFileTypes, null);
  assert.equal(registry.put({ ...legacy, inputFileTypes: undefined }).inputFileTypes, null);
  assert.equal(registry.put({ ...legacy, inputFileTypes: null }).inputFileTypes, null);
  assert.deepEqual(registry.put({ ...legacy, inputFileTypes: [] }).inputFileTypes, []);
  const types: 'application/pdf'[] = ['application/pdf'];
  assert.deepEqual(registry.put({ ...legacy, inputFileTypes: types }).inputFileTypes, types);
  types.pop();
  assert.deepEqual(registry.get('fixture', 'model').inputFileTypes, ['application/pdf']);
  const returned = registry.list()[0]!;
  (returned.inputFileTypes as 'application/pdf'[]).pop();
  assert.deepEqual(registry.get('fixture', 'model').inputFileTypes, ['application/pdf']);
  assert.equal(registry.get('fixture', 'other-model').inputFileTypes, null);
});

test('file capability metadata rejects unsupported/sparse/accessor/proxy arrays before evaluating getters or traps', () => {
  const registry = new ModelRegistry(), baseline = unknownModelSpec('fixture', 'model');
  let calls = 0;
  const entryGetter = Object.defineProperty([], '0', { enumerable: true, get() { calls++; return 'application/pdf'; } });
  const proxy = new Proxy(['application/pdf'], { getPrototypeOf() { calls++; return Array.prototype; } });
  const getter = Object.defineProperty({ ...baseline }, 'inputFileTypes', { enumerable: true, get() { calls++; return ['application/pdf']; } });
  for (const value of [['image/png'], ['application/pdf', 'application/pdf'], new Array(1), entryGetter, proxy, Object.assign(['application/pdf'], { extra: true }), 'application/pdf', false]) {
    assert.throws(() => registry.put({ ...baseline, inputFileTypes: value } as ModelSpec), (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_MODEL_SPEC');
  }
  assert.throws(() => registry.put(getter));
  assert.equal(calls, 0);
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
