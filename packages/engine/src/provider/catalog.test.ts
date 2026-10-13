import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogModelSpec, fetchModelCatalog, MODEL_CATALOG_URL, parseModelCatalog } from './catalog.js';
const input = { google: { name: 'Google', models: { coding: { name: 'Coding', tool_call: true, reasoning: true, modalities: { input: ['text', 'image', 'audio'], output: ['text'] }, limit: { context: 1000, output: 200 } } } } };
test('catalogue metadata stays bounded and cannot grant unsupported SDK media or another endpoint capabilities', () => {
  const catalog = parseModelCatalog(input);
  const spec = catalogModelSpec(catalog, 'google', 'coding', 'https://generativelanguage.googleapis.com/v1beta');
  assert.deepEqual(spec?.modalities, ['text']); assert.equal(spec?.contextWindow, 1000);
  assert.equal(catalogModelSpec(catalog, 'google', 'coding', 'https://proxy.example/v1'), undefined);
  assert.equal(catalogModelSpec(catalog, 'codex', 'coding', ''), undefined);
  assert.equal(catalog.providers.find(p => p.id === 'google')?.models[0]?.input.length, 3);
  const unknown = parseModelCatalog({ openai: { models: { model: { limit: { context: 0, output: -1 } } } } });
  assert.equal(unknown.providers[0]?.models[0]?.contextWindow, null);
  assert.equal(unknown.providers[0]?.models[0]?.tools, null);
  assert.throws(() => parseModelCatalog({}), { code: 'MODEL_CATALOG_INVALID' });
});
test('public catalogue fetch sends no credentials, rejects failures and oversized bodies', async () => {
  const catalog = await fetchModelCatalog(async (url, init) => {
    assert.equal(url, MODEL_CATALOG_URL); assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('authorization'), false);
    return Response.json(input);
  });
  assert.equal(catalog.providers.find(p => p.id === 'google')?.models.length, 1);
  await assert.rejects(fetchModelCatalog(async () => new Response('', { status: 503 })), { code: 'MODEL_CATALOG_UNAVAILABLE' });
  await assert.rejects(fetchModelCatalog(async () => new Response('x'.repeat(8 * 1024 * 1024 + 1))), { code: 'MODEL_CATALOG_LIMIT' });
});
