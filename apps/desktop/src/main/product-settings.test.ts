import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DesktopProductSettings } from './product-settings.js';
import { DEFAULT_PRODUCT_SETTINGS, validateProductSettings } from '../shared/product-settings.js';
import { DesktopModelCatalog } from './model-catalog.js';
import { readPrivateJson, writePrivateJson } from './private-json.js';
import { UtilityWorker } from '../worker/core.js';
import { randomUUID } from 'node:crypto';

test('extension boundaries reject credentials, remote module paths, script injection, duplicate profiles and accessors', () => {
  const valid = { ...DEFAULT_PRODUCT_SETTINGS, profiles: [{ id: 'review', description: 'Review', instructions: 'Read', tools: ['read_file'], modelId: 'review-model', turnAllowance: 2 }] };
  assert.deepEqual(validateProductSettings(valid), valid);
  for (const change of [{ apiKey: 'secret' }, { searchKeyEnv: 'secret-value' }, { plugins: [{ name: 'pkg;touch-file', version: '1.0.0', enabled: true }] }, { plugins: [{ name: 'https://example.com/pkg.js', version: 'latest', enabled: true }] }, { profiles: [...valid.profiles, ...valid.profiles] }, { profiles: [{ ...valid.profiles[0], tools: ['read_file', 'read_file'] }] }, { profiles: [{ ...valid.profiles[0], providerId: 'another-account' }] }]) assert.throws(() => validateProductSettings({ ...valid, ...change }), { code: 'PRODUCT_SETTINGS_INVALID' });
  let accessed = false;
  const profiles = [] as unknown[]; Object.defineProperty(profiles, 0, { enumerable: true, get() { accessed = true; return valid.profiles[0]; } });
  assert.throws(() => validateProductSettings({ ...valid, profiles })); assert.equal(accessed, false);
});
test('public catalogue retains offline cache after failed refresh and treats corrupted cache as optional', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-catalog-cache-'))); t.after(() => rm(root, { recursive: true, force: true }));
  let fail = false;
  const service = new DesktopModelCatalog(root, async () => fail ? new Response('', { status: 503 }) : Response.json({ google: { models: { fixture: { name: 'Fixture', tool_call: true, limit: { context: 1000 } } } } }));
  await service.load(); assert.equal(service.get(), null); const catalog = await service.refresh();
  const offline = new DesktopModelCatalog(root, async () => { throw Error('offline'); }); await offline.load(); assert.deepEqual(offline.get(), catalog);
  fail = true; await assert.rejects(service.refresh()); assert.deepEqual(service.get(), catalog);
  await writeFile(join(root, 'model-catalog.json'), '{broken'); await offline.load(); assert.equal(offline.get(), null);
});
test('private product settings save atomically, reject stale writers and never persist or return web search secrets', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-product-settings-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const service = new DesktopProductSettings(root, { EXA_API_KEY: 'private-search-key' }); await service.load();
  const view = service.get(), settings = { ...view.settings, web: true, searchKeyEnv: 'EXA_API_KEY', compatibilitySkills: true };
  const saved = await service.save({ revision: view.revision, settings });
  assert.equal(saved.searchKeyConfigured, true); assert.ok(!JSON.stringify(saved).includes('private-search-key')); assert.equal(service.runtime().searchKey, 'private-search-key');
  assert.ok(!(await readFile(join(root, 'product-settings.json'), 'utf8')).includes('private-search-key'));
  if (process.platform !== 'win32') assert.equal((await stat(join(root, 'product-settings.json'))).mode & 0o777, 0o600);
  await assert.rejects(service.save({ revision: view.revision, settings }), { code: 'PRODUCT_SETTINGS_STALE' });
  await assert.rejects(service.save({ revision: saved.revision, settings: { ...settings, plugins: [{ name: 'missing-plugin', version: '1.0.0', enabled: true }] } }), { code: 'PLUGIN_NOT_INSTALLED' });
  const reopened = new DesktopProductSettings(root, {}); await reopened.load(); assert.deepEqual(reopened.get().settings, settings); assert.equal(reopened.get().searchKeyConfigured, false);
  const empty = new DesktopProductSettings(root, { EXA_API_KEY: '' }); await empty.load(); assert.equal(empty.runtime().searchKey, undefined); assert.equal(empty.get().searchKeyConfigured, false);
  await writePrivateJson(root, 'product-settings.json', { ...settings, web: false }, 524_288);
  await assert.rejects(service.save({ revision: saved.revision, settings }), { code: 'PRODUCT_SETTINGS_STALE' });
});
test('private JSON refuses symlink and oversized reads without damaging the original target', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-private-json-'))); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'original.json'), '{"original":true}');
  if (process.platform !== 'win32') { await symlink(join(root, 'original.json'), join(root, 'linked.json')); await assert.rejects(readPrivateJson(root, 'linked.json', 1024)); assert.equal(await readFile(join(root, 'original.json'), 'utf8'), '{"original":true}'); }
  await assert.rejects(readPrivateJson(root, 'original.json', 1));
  await assert.rejects(writePrivateJson(root, 'original.json', { replaced: true }, 1024, async () => {
    await writeFile(join(root, 'original.json'), '{"concurrent":true}'); throw Error('stale write');
  }));
  assert.equal(await readFile(join(root, 'original.json'), 'utf8'), '{"concurrent":true}');
  assert.ok(!(await readdir(root)).some(name => name.endsWith('.tmp')));
});

test('malformed extension settings start disabled and explicit repair retains the original bytes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-product-repair-'))); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'product-settings.json'), '{malformed original');
  const service = new DesktopProductSettings(root, {}); await service.load(); const view = service.get();
  assert.ok(view.error); assert.deepEqual(view.settings, DEFAULT_PRODUCT_SETTINGS); assert.equal(service.runtime().productSettings.web, false);
  const saved = await service.save({ revision: view.revision, settings: DEFAULT_PRODUCT_SETTINGS }); assert.equal(saved.error, undefined);
  const retained = (await readdir(root)).find(name => name.startsWith('product-settings.invalid-')); assert.ok(retained); assert.equal(await readFile(join(root, retained), 'utf8'), '{malformed original');
});
test('pinned plugin install disables lifecycle scripts, strips credentials, requires separate enablement and loads actual engine tools', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-plugin-install-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  const fixture = join(bin, 'npm-fixture.cjs');
  await writeFile(fixture, `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
assert.equal(process.env.MOODCODE_API_KEY,undefined); assert.equal(process.env.EXA_API_KEY,undefined); assert.ok(process.argv.includes('--ignore-scripts')); assert.ok(process.argv.includes('--save-exact')); assert.ok(process.argv.includes('fixture-plugin@1.2.3'));
const root=path.join(process.cwd(),'node_modules','fixture-plugin');fs.mkdirSync(root,{recursive:true});
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'fixture-plugin',version:'1.2.3',type:'module',main:'index.js'}));
fs.writeFileSync(path.join(root,'index.js'),\`export default {id:'fixture',async activate(){return {tools:[{name:'fixture_plugin_read',effectClass:'read',description:'Fixture plugin',inputSchema:{type:'object'},async prepare(){return {name:'fixture_plugin_read',input:{},fingerprint:'fixture',requiresApproval:false,preview:{}}},async execute(){return {content:'fixture'}}}]}}}\`);
fs.writeFileSync('install-observed.json',JSON.stringify(process.argv.slice(2)));`);
  if (process.platform === 'win32') { const cli = join(bin, 'node_modules', 'npm', 'bin'); await mkdir(cli, { recursive: true }); await writeFile(join(cli, 'npm-cli.js'), `require(${JSON.stringify(fixture)});\n`); }
  else await writeFile(join(bin, 'npm'), `#!${process.execPath}\nrequire(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  const service = new DesktopProductSettings(root, { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, Path: `${bin}${delimiter}${process.env.Path ?? ''}`, MOODCODE_API_KEY: 'do-not-forward-provider', EXA_API_KEY: 'do-not-forward-search' }); await service.load();
  let view = service.get(); const plugin = { name: 'fixture-plugin', version: '1.2.3', enabled: false };
  view = await service.save({ revision: view.revision, settings: { ...view.settings, plugins: [plugin] } });
  await service.install(plugin); view = service.get(); assert.deepEqual(view.installed, [{ name: plugin.name, version: plugin.version }]); assert.deepEqual(service.runtime().plugins, []);
  view = await service.save({ revision: view.revision, settings: { ...view.settings, profiles: [{ id: 'review', description: 'Review', instructions: 'Read current source.', tools: ['read_file'], modelId: 'fixture-review', turnAllowance: 2 }], plugins: [{ ...plugin, enabled: true }] } });
  assert.throws(() => service.runtime(['other-account-model']), { code: 'ACCOUNT_MODEL_REQUIRED' });
  assert.equal(service.runtime(['fixture-review']).plugins.length, 1);
  const worker = new UtilityWorker({ emit() {} }); t.after(() => worker.close());
  const response = await worker.handle({ id: randomUUID(), type: 'start', payload: { dbPath: ':memory:', artifactDir: join(root, 'artifacts'), config: { providerId: 'scripted', modelId: 'local', baseURL: '' }, ...service.runtime() } });
  assert.equal(response.ok, true, JSON.stringify(response)); assert.ok(JSON.stringify(response).includes('fixture_plugin_read'));
  await worker.close();
  await writeFile(fixture, `require('node:fs').writeFileSync('cancel-owner.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  const installing = service.install(plugin); installing.catch(() => {});
  let pid: number | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { try { pid = (JSON.parse(await readFile(join(root, 'plugins', 'cancel-owner.json'), 'utf8')) as { pid: number }).pid; break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  service.cancelInstall(); await assert.rejects(installing, { code: 'PLUGIN_INSTALL_FAILED' });
  assert.ok(pid); assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
});
