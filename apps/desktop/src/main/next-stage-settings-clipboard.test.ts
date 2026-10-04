import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { DesktopSettings, SaveDesktopSettings } from '../shared/protocol.js';
import { validateClipboardText } from '../shared/clipboard.js';
import { createDesktopApi, type DesktopTransport, validateDesktopSettings } from '../preload/api.js';
import { DESKTOP_CHANNELS } from './ipc-channels.js';
import { DesktopHost } from './host.js';
import { SettingsStore, type DesktopCodexAuth } from './settings.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-next-stage-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let auth: DesktopCodexAuth = { available: true, state: 'available', modelId: 'gpt-fixture', models: [
    { id: 'gpt-fixture', displayName: 'Fixture', reasoningEfforts: ['low', 'ultra'], defaultEffort: 'ultra' },
    { id: 'gpt-small', displayName: 'Small', reasoningEfforts: ['low'], defaultEffort: 'low' },
  ] };
  const options = {
    directory, environment: {}, codexAuth: () => auth,
    safeStorage: { isEncryptionAvailable: () => false, encryptString() { assert.fail('Codex settings must not encrypt a caller key'); }, decryptString() { assert.fail('Codex settings must not decrypt a key'); } },
  };
  const store = new SettingsStore(options);
  return { directory, store, options, setAuth(value: DesktopCodexAuth) { auth = value; } };
}

test('Codex reasoning effort and sanitized model choices survive settings commit/reopen and the public host allowlist', async t => {
  const f = await fixture(t);
  await f.store.load();
  const input: SaveDesktopSettings = { providerId: 'codex', modelId: '', baseURL: '', reasoningEffort: 'ultra' };
  assert.equal(validateDesktopSettings(input).reasoningEffort, 'ultra');
  const prepared = await f.store.prepare(input);
  const committed = await f.store.commit(prepared);
  assert.equal(committed.engineConfig.reasoningEffort, 'ultra');
  assert.equal(committed.view.modelId, 'gpt-fixture');
  const document = JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(document.reasoningEffort, 'ultra');
  assert.equal(Object.hasOwn(document, 'credential'), false);
  assert.equal(Object.hasOwn(document, 'codexModels'), false);
  const reopened = new SettingsStore(f.options);
  assert.equal((await reopened.load()).engineConfig.reasoningEffort, 'ultra');
  const host = new DesktopHost({ settings: reopened, spawn() { assert.fail('Public settings read must not spawn an engine'); }, dbPath: join(f.directory, 'unused.sqlite'), artifactDir: join(f.directory, 'artifacts'), platform: 'fixture', version: 'fixture' });
  const view = host.getSettings();
  assert.equal(view.reasoningEffort, 'ultra');
  assert.equal(view.codexModels?.length, 2);
  assert.equal(view.keySource, 'codex');
  view.codexModels![0]!.reasoningEfforts.push('none');
  view.codexModels![0]!.displayName = 'Caller mutation';
  assert.deepEqual(host.getSettings().codexModels![0]!.reasoningEfforts, ['low', 'ultra']);
  assert.equal(host.getSettings().codexModels![0]!.displayName, 'Fixture');
  assert.ok(!JSON.stringify(view).includes('engineConfig'));
});

test('settings reject unsupported known-model efforts, accept explicit unknown models, and refresh detached local metadata', async t => {
  const f = await fixture(t);
  await f.store.load();
  await assert.rejects(f.store.prepare({ providerId: 'codex', modelId: 'gpt-small', baseURL: '', reasoningEffort: 'ultra' }), { code: 'SETTINGS_INVALID' });
  const unknown = await f.store.prepare({ providerId: 'codex', modelId: 'gpt-explicit-not-cached', baseURL: '', reasoningEffort: 'ultra' });
  assert.equal(unknown.engineConfig.modelId, 'gpt-explicit-not-cached');
  for (const reasoningEffort of [undefined, 'future', null]) {
    const input = { providerId: 'codex', modelId: 'gpt-fixture', baseURL: '', reasoningEffort } as unknown as SaveDesktopSettings;
    assert.throws(() => validateDesktopSettings(input), { code: 'INVALID_INPUT' });
    await assert.rejects(f.store.prepare(input), { code: 'SETTINGS_INVALID' });
  }
  await assert.rejects(f.store.prepare({ providerId: 'scripted', modelId: 'local', baseURL: '', reasoningEffort: 'high' }), { code: 'SETTINGS_INVALID' });
  const view = f.store.getView();
  view.codexModels![0]!.displayName = 'Mutated';
  assert.equal(f.store.getView().codexModels![0]!.displayName, 'Fixture');
  f.setAuth({ available: true, state: 'available', modelId: 'gpt-next', models: [{ id: 'gpt-next', displayName: 'Refreshed local cache', reasoningEfforts: ['high'] }] });
  const refreshed = f.store.refreshView();
  assert.equal(refreshed.codexModelId, 'gpt-next');
  assert.equal(refreshed.codexModels![0]!.displayName, 'Refreshed local cache');
  assert.equal(refreshed.modelId, 'gpt-fixture'); // Refreshing cache metadata does not change selected/persisted model.
});

test('clipboard preserves exact multiline Unicode up to its byte cap and invalid copies never invoke IPC', async () => {
  const text = '한국어🙂\nline two\r\n\tcode';
  assert.equal(validateClipboardText(text), text);
  assert.equal(validateClipboardText(''), '');
  const exact = '🙂'.repeat(1_048_576 / 4);
  assert.equal(validateClipboardText(exact), exact);
  const calls: { channel: string; args: unknown[] }[] = [];
  const transport: DesktopTransport = {
    async invoke(channel, ...args) { calls.push({ channel, args }); return { ok: true, value: undefined }; },
    on() {}, removeListener() {},
  };
  const api = createDesktopApi(transport);
  await api.copyText!(text);
  assert.deepEqual(calls, [{ channel: DESKTOP_CHANNELS.copyText, args: [text] }]);
  for (const input of [null, 1, {}, 'NUL\0text', `${exact}x`, 'x'.repeat(1_048_577)]) {
    assert.throws(() => validateClipboardText(input), { code: 'INVALID_CLIPBOARD_TEXT' });
    await assert.rejects(api.copyText!(input as string), { code: 'INVALID_CLIPBOARD_TEXT' });
  }
  assert.equal(calls.length, 1);
});

test('host public settings forward new effort/catalog metadata while excluding unexpected private fields', () => {
  const view: DesktopSettings = { providerId: 'codex', modelId: 'gpt-fixture', baseURL: '', keyConfigured: true, keySource: 'codex', credentialStorage: 'unavailable', reasoningEffort: 'ultra', codexModels: [{ id: 'gpt-fixture', displayName: 'Fixture', reasoningEfforts: ['ultra'] }] };
  const privateView = { ...view, apiKey: 'synthetic-private-key', engineConfig: { apiKey: 'synthetic-private-key' } };
  const never = async (): Promise<never> => assert.fail('Metadata-only host read must not load, prepare or commit settings');
  const host = new DesktopHost({ settings: { getView: () => privateView, load: never, prepare: never, commit: never }, spawn() { assert.fail('Must not spawn'); }, dbPath: '/unused', artifactDir: '/unused', platform: 'fixture', version: 'fixture' });
  assert.deepEqual(host.getSettings(), view);
  assert.ok(!JSON.stringify(host.getSettings()).includes('synthetic-private-key'));
});
