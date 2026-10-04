import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { getCodexModelCatalog } from './codex.js';

const secrets = ['fixture-private-access', 'fixture-private-account', 'fixture-private-refresh', 'fixture-private-id'];
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'moodcode-next-stage-models-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: secrets[0], account_id: secrets[1], refresh_token: secrets[2], id_token: secrets[3] } }), { mode: 0o600 });
  const auth = await readFile(join(home, 'auth.json'));
  const cache = async (models: unknown) => writeFile(join(home, 'models_cache.json'), JSON.stringify({ models }));
  const catalog = () => getCodexModelCatalog({ codexHome: home });
  return { home, auth, cache, catalog };
}

test('local Codex model metadata filters hidden/invalid/duplicate entries and unknown efforts without exposing auth fields', async t => {
  const f = await fixture(t);
  await f.cache([
    { slug: 'gpt-fixture', display_name: 'Fixture Model', default_reasoning_level: 'ultra', supported_reasoning_levels: [{ effort: 'high' }, { effort: 'ultra' }, { effort: 'high' }, { effort: 'unknown' }] },
    { slug: 'gpt-fixture', display_name: 'Duplicate' },
    { slug: 'gpt-hidden', visibility: 'hide' },
    { slug: 'unsupported-model', display_name: 'Invalid prefix' },
    { slug: `gpt-${secrets[0]}`, display_name: 'Credential ID' },
    { slug: 'codex-second', display_name: `Display ${secrets[1]}`, default_reasoning_level: 'max', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-control', display_name: 'Unsafe\nName' },
  ]);
  assert.deepEqual(await f.catalog(), [
    { id: 'gpt-fixture', displayName: 'Fixture Model', reasoningEfforts: ['high', 'ultra'], defaultEffort: 'ultra' },
    { id: 'codex-second', displayName: 'codex-second', reasoningEfforts: ['low'] },
    { id: 'gpt-control', displayName: 'gpt-control', reasoningEfforts: [] },
  ]);
  for (const secret of secrets) assert.ok(!JSON.stringify(await f.catalog()).includes(secret));
  assert.deepEqual(await readFile(join(f.home, 'auth.json')), f.auth);
  const changed = await f.catalog();
  changed[0]!.reasoningEfforts.push('none');
  assert.deepEqual((await f.catalog())[0]!.reasoningEfforts, ['high', 'ultra']);
});

test('catalog metadata has a fixed model/effort cap and malformed or oversized cache files yield an empty local catalog', async t => {
  const f = await fixture(t);
  await f.cache(Array.from({ length: 140 }, (_, index) => ({ slug: `gpt-fixture-${index}`, supported_reasoning_levels: Array.from({ length: 40 }, (_, effort) => ({ effort: effort < 32 ? 'low' : 'ultra' })) })));
  const catalog = await f.catalog();
  assert.equal(catalog.length, 128);
  assert.deepEqual(catalog[0]!.reasoningEfforts, ['low']);
  await f.cache(Array.from({ length: 4097 }, () => ({ slug: 'gpt-fixture' })));
  assert.deepEqual(await f.catalog(), []);
  await writeFile(join(f.home, 'models_cache.json'), '{invalid json');
  assert.deepEqual(await f.catalog(), []);
  await writeFile(join(f.home, 'models_cache.json'), 'x'.repeat(2_097_153));
  assert.deepEqual(await f.catalog(), []);
  assert.deepEqual(await readFile(join(f.home, 'auth.json')), f.auth);
});

test('catalog reads reject linked cache files and propagate cancellation without updating local files', async t => {
  const f = await fixture(t);
  const target = join(f.home, 'cache-target.json');
  await writeFile(target, JSON.stringify({ models: [{ slug: 'gpt-linked' }] }));
  await symlink(target, join(f.home, 'models_cache.json'));
  assert.deepEqual(await f.catalog(), []);
  await assert.rejects(getCodexModelCatalog({ codexHome: f.home, signal: AbortSignal.abort() }), { code: 'PROVIDER_CANCELLED' });
  assert.equal(JSON.parse(await readFile(target, 'utf8')).models[0].slug, 'gpt-linked');
  assert.deepEqual(await readFile(join(f.home, 'auth.json')), f.auth);
});
