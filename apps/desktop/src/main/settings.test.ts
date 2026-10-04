import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { SaveDesktopSettings } from '../shared/protocol.js';
import {
  SettingsError, SettingsStore, type CredentialStorage, type DesktopCodexAuth, type PreparedSettings,
} from './settings.js';

class TestStorage implements CredentialStorage {
  available = true;
  backend: string | undefined;
  encryptions = 0;
  decryptions = 0;
  encryptionError: string | undefined;
  decryptionError: string | undefined;
  readonly cipherKey = randomBytes(32);
  isEncryptionAvailable(): boolean { return this.available; }
  getSelectedStorageBackend(): string { return this.backend as string; }
  encryptString(value: string): Buffer {
    this.encryptions += 1;
    if (this.encryptionError) throw new Error(this.encryptionError);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cipherKey, iv);
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]);
  }
  decryptString(value: Buffer): string {
    this.decryptions += 1;
    if (this.decryptionError) throw new Error(this.decryptionError);
    const decipher = createDecipheriv('aes-256-gcm', this.cipherKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  }
}

async function fixture(t: TestContext, extra: { environment?: Record<string, string | undefined>; codexAuth?: () => DesktopCodexAuth } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  const path = join(directory, 'settings.json');
  const storage = new TestStorage();
  const store = new SettingsStore({ directory, safeStorage: storage, environment: extra.environment ?? {}, ...extra });
  return { root, directory, path, storage, store };
}
const remote = (extra: Partial<SaveDesktopSettings> = {}): SaveDesktopSettings => ({
  providerId: 'openai-compatible', modelId: 'fixture-model', baseURL: 'http://127.0.0.1:3000/v1', ...extra,
});
const scripted: SaveDesktopSettings = { providerId: 'scripted', modelId: 'local', baseURL: '' };
function code(expected: string, secret?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof SettingsError);
    assert.equal(error.code, expected);
    if (secret) assert.ok(!`${error.message}${JSON.stringify(error)}`.includes(secret));
    return true;
  };
}
async function writeStored(directory: string, document: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'settings.json'), `${JSON.stringify(document)}\n`, { mode: 0o600 });
}

test('defaults are an explicit local demo and loading never creates a settings file', async (t) => {
  const environment = Object.defineProperty({}, 'MOODCODE_API_KEY', { get() { throw new Error('unrelated credential read'); } });
  const { store, root, storage } = await fixture(t, { environment });
  const result = await store.load();
  assert.deepEqual(result.view, {
    providerId: 'scripted', modelId: 'local', baseURL: '', keyConfigured: false,
    keySource: 'none', credentialStorage: 'available',
  });
  assert.deepEqual(result.engineConfig, { providerId: 'scripted', modelId: 'local', baseURL: '' });
  assert.equal(storage.encryptions + storage.decryptions, 0);
  assert.deepEqual(await readdir(root), []);
});

test('preparation does no filesystem writes and only an explicit private property contains the key', async (t) => {
  const { store, root } = await fixture(t);
  const prepared = await store.prepare(remote({ apiKey: 'fixture-secret-prepared' }));
  assert.equal(prepared.engineConfig.apiKey, 'fixture-secret-prepared');
  assert.equal(prepared.view.keySource, 'stored');
  assert.ok(!JSON.stringify(prepared).includes('fixture-secret-prepared'));
  assert.ok(!Object.hasOwn({ ...prepared }, 'engineConfig'));
  assert.throws(() => { (prepared.engineConfig as { apiKey: string }).apiKey = 'mutated'; }, TypeError);
  assert.deepEqual(await readdir(root), []);
  assert.equal(store.getView().providerId, 'scripted');
});

test('an atomic commit persists ciphertext only with owner permissions and reloads it', async (t) => {
  const { directory, path, store, storage } = await fixture(t);
  const prepared = await store.prepare(remote({ apiKey: 'fixture-secret-roundtrip' }));
  const committed = await store.commit(prepared);
  assert.equal(committed.engineConfig.apiKey, 'fixture-secret-roundtrip');
  const bytes = await readFile(path, 'utf8');
  assert.ok(!bytes.includes('fixture-secret-roundtrip'));
  const document = JSON.parse(bytes);
  assert.equal(document.credential.providerId, 'openai-compatible');
  assert.equal(document.apiKey, undefined);
  assert.deepEqual(await readdir(directory), ['settings.json']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }
  const reopened = new SettingsStore({ directory, safeStorage: storage, environment: {} });
  assert.equal((await reopened.load()).engineConfig.apiKey, 'fixture-secret-roundtrip');
  assert.equal(reopened.getView().keySource, 'stored');
});

test('environment priority is MOODCODE_API_KEY then OPENAI_API_KEY and is never persisted', async (t) => {
  const { store, path, storage } = await fixture(t, { environment: {
    MOODCODE_API_KEY: 'fixture-moodcode-env', OPENAI_API_KEY: 'fixture-openai-env',
  } });
  const prepared = await store.prepare(remote());
  assert.equal(prepared.engineConfig.apiKey, 'fixture-moodcode-env');
  assert.equal(prepared.view.keySource, 'environment');
  await store.commit(prepared);
  const bytes = await readFile(path, 'utf8');
  assert.ok(!bytes.includes('fixture-moodcode-env') && !bytes.includes('fixture-openai-env'));
  assert.equal(JSON.parse(bytes).credential, undefined);
  assert.equal(storage.encryptions + storage.decryptions, 0);
});

test('OPENAI_API_KEY works when OS credential storage is unavailable', async (t) => {
  const { store, storage } = await fixture(t, { environment: { OPENAI_API_KEY: 'fixture-openai-env' } });
  storage.available = false;
  const prepared = await store.prepare(remote({ providerId: 'openai-responses' }));
  assert.equal(prepared.engineConfig.apiKey, 'fixture-openai-env');
  assert.equal(prepared.view.credentialStorage, 'unavailable');
  assert.equal(prepared.view.keySource, 'environment');
});

test('a selected remote provider without a key fails explicitly and never falls back', async (t) => {
  const { store, directory } = await fixture(t);
  await writeStored(directory, { schemaVersion: 1, ...remote() });
  await assert.rejects(store.load(), code('SETTINGS_KEY_REQUIRED'));
  assert.equal(store.getView().providerId, 'openai-compatible');
  assert.equal(store.getView().keyConfigured, false);
  assert.equal(store.getView().keySource, 'none');
  const repair = await store.prepare(remote({ apiKey: 'fixture-repair' }));
  await store.commit(repair);
  assert.equal(store.getView().keyConfigured, true);
});

test('stored credentials cannot silently transfer to another provider', async (t) => {
  const { store } = await fixture(t);
  await store.commit(await store.prepare(remote({ apiKey: 'fixture-provider-a' })));
  await assert.rejects(store.prepare(remote({ providerId: 'openai-responses' })), code('SETTINGS_KEY_REQUIRED'));
  const replacement = await store.prepare(remote({ providerId: 'openai-responses', apiKey: 'fixture-provider-b' }));
  await store.commit(replacement);
  assert.equal(replacement.engineConfig.apiKey, 'fixture-provider-b');
  await assert.rejects(store.prepare(remote()), code('SETTINGS_KEY_REQUIRED'));
});

test('switching to the local demo preserves a provider-bound encrypted key for an explicit switch back', async (t) => {
  const { store, storage } = await fixture(t);
  await store.commit(await store.prepare(remote({ apiKey: 'fixture-preserved' })));
  const count = storage.decryptions;
  const local = await store.prepare(scripted);
  await store.commit(local);
  assert.equal(local.engineConfig.apiKey, undefined);
  assert.equal(local.view.keySource, 'none');
  assert.equal(storage.decryptions, count);
  const back = await store.prepare(remote());
  assert.equal(back.engineConfig.apiKey, 'fixture-preserved');
});

test('an environment credential can select another provider without rebinding the stored key', async (t) => {
  const environment: Record<string, string | undefined> = {};
  const { store, path } = await fixture(t, { environment });
  await store.commit(await store.prepare(remote({ apiKey: 'fixture-bound-a' })));
  environment.MOODCODE_API_KEY = 'fixture-env-b';
  await store.commit(await store.prepare(remote({ providerId: 'openai-responses' })));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).credential.providerId, 'openai-compatible');
  delete environment.MOODCODE_API_KEY;
  await assert.rejects(store.load(), code('SETTINGS_KEY_REQUIRED'));
  assert.equal((await store.prepare(remote())).engineConfig.apiKey, 'fixture-bound-a');
});

test('clearKey removes ciphertext atomically and rejects conflicting replacement input', async (t) => {
  const { store, path } = await fixture(t);
  await store.commit(await store.prepare(remote({ apiKey: 'fixture-clear-me' })));
  await assert.rejects(store.prepare(remote({ clearKey: true, apiKey: 'fixture-conflict' })), code('SETTINGS_INVALID', 'fixture-conflict'));
  await assert.rejects(store.prepare(remote({ clearKey: true })), code('SETTINGS_KEY_REQUIRED'));
  await store.commit(await store.prepare({ ...scripted, clearKey: true }));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).credential, undefined);
  await assert.rejects(store.prepare(remote()), code('SETTINGS_KEY_REQUIRED'));
});

for (const backend of ['basic_text', 'basic', 'plain_text', 'plaintext', 'unknown', 'none']) {
  test(`the insecure ${backend} backend cannot store credentials`, async (t) => {
    const { store, storage, root } = await fixture(t);
    storage.backend = backend;
    await assert.rejects(store.prepare(remote({ apiKey: 'fixture-no-storage' })), code('SETTINGS_CREDENTIAL_STORAGE_UNAVAILABLE', 'fixture-no-storage'));
    assert.equal(storage.encryptions, 0);
    assert.deepEqual(await readdir(root), []);
  });
}

test('safeStorage exceptions never copy a secret into public errors', async (t) => {
  const { store, storage } = await fixture(t);
  storage.encryptionError = 'native failure containing fixture-sensitive-value';
  await assert.rejects(store.prepare(remote({ apiKey: 'fixture-sensitive-value' })), code('SETTINGS_CREDENTIAL_ENCRYPT_FAILED', 'fixture-sensitive-value'));
  storage.encryptionError = undefined;
  await store.commit(await store.prepare(remote({ apiKey: 'fixture-sensitive-value' })));
  storage.decryptionError = 'native failure containing fixture-sensitive-value';
  await assert.rejects(store.load(), code('SETTINGS_CREDENTIAL_DECRYPT_FAILED', 'fixture-sensitive-value'));
  assert.ok(!JSON.stringify(store.getView()).includes('fixture-sensitive-value'));
});

test('invalid environment credentials do not fall back to stored or lower-priority keys', async (t) => {
  const { store } = await fixture(t, { environment: {
    MOODCODE_API_KEY: 'fixture-invalid\ncredential', OPENAI_API_KEY: 'fixture-valid-lower-priority',
  } });
  await assert.rejects(store.prepare(remote()), code('SETTINGS_ENVIRONMENT_CREDENTIAL_INVALID', 'fixture-invalid'));
});

test('Codex-authenticated defaults use sanitized model metadata without reading any key', async (t) => {
  const environment = Object.defineProperty({}, 'MOODCODE_API_KEY', { get() { throw new Error('Codex must not read API keys'); } });
  const { store, root, storage } = await fixture(t, {
    environment, codexAuth: () => ({ available: true, state: 'available', modelId: 'fixture-codex-model' }),
  });
  const result = await store.load();
  assert.equal(result.view.providerId, 'codex');
  assert.equal(result.view.modelId, 'fixture-codex-model');
  assert.equal(result.view.keySource, 'codex');
  assert.equal(result.view.codexAuthState, 'available');
  assert.equal(result.view.keyConfigured, true);
  assert.equal(result.engineConfig.apiKey, undefined);
  assert.equal(result.engineConfig.baseURL, '');
  assert.equal(storage.encryptions + storage.decryptions, 0);
  assert.deepEqual(await readdir(root), []);
});

test('missing Codex authentication leaves first launch as the explicit local demo', async (t) => {
  const { store } = await fixture(t, { codexAuth: () => ({ available: false, state: 'missing' }) });
  const result = await store.load();
  assert.equal(result.view.providerId, 'scripted');
  assert.equal(result.view.keyConfigured, false);
  assert.equal(result.view.codexAuthState, 'missing');
});

test('a saved local demo exposes sanitized Codex model metadata for an explicit provider switch', async (t) => {
  const { store, directory } = await fixture(t, { codexAuth: () => ({ available: true, state: 'available', modelId: 'fixture-local-codex-model' }) });
  await writeStored(directory, { schemaVersion: 1, ...scripted });
  const result = await store.load();
  assert.equal(result.view.providerId, 'scripted');
  assert.equal(result.view.codexAuthState, 'available');
  assert.equal(result.view.codexModelId, 'fixture-local-codex-model');
  assert.equal(result.view.keyConfigured, false);
  assert.equal(result.engineConfig.apiKey, undefined);
});

test('unsafe or oversized Codex model metadata is omitted from renderer settings', async (t) => {
  let modelId = 'fixture-model\ninvalid';
  const { store, directory } = await fixture(t, { codexAuth: () => ({ available: true, state: 'available', modelId }) });
  await writeStored(directory, { schemaVersion: 1, ...scripted });
  assert.equal((await store.load()).view.codexModelId, undefined);
  modelId = 'x'.repeat(513);
  assert.equal((await store.load()).view.codexModelId, undefined);
});

test('Codex preparation accepts its auth default model but forbids caller API keys and base URLs', async (t) => {
  const { store } = await fixture(t, { codexAuth: () => ({ available: true, state: 'available', modelId: 'fixture-codex-model' }) });
  const result = await store.prepare({ providerId: 'codex', modelId: '', baseURL: '' });
  assert.equal(result.engineConfig.modelId, 'fixture-codex-model');
  assert.equal(result.engineConfig.apiKey, undefined);
  await assert.rejects(store.prepare({ providerId: 'codex', modelId: 'fixture-model', baseURL: '', apiKey: 'fixture-forbidden-codex-key' }), code('SETTINGS_INVALID', 'fixture-forbidden-codex-key'));
  await assert.rejects(store.prepare({ providerId: 'codex', modelId: 'fixture-model', baseURL: 'https://example.test' }), code('SETTINGS_INVALID'));
});

test('a saved Codex selection fails explicitly when auth expires, while retaining recovery metadata', async (t) => {
  let auth: DesktopCodexAuth = { available: true, state: 'available', modelId: 'fixture-codex-model' };
  const { store } = await fixture(t, { codexAuth: () => auth });
  await store.commit(await store.prepare({ providerId: 'codex', modelId: 'fixture-codex-model', baseURL: '' }));
  auth = { available: false, state: 'expired' };
  await assert.rejects(store.load(), code('SETTINGS_CODEX_AUTH_REQUIRED'));
  assert.equal(store.getView().providerId, 'codex');
  assert.equal(store.getView().codexAuthState, 'expired');
  assert.equal(store.getView().keyConfigured, false);
  await store.commit(await store.prepare(scripted));
  assert.equal(store.getView().providerId, 'scripted');
});

test('Codex auth status failures are bounded sanitized metadata', async (t) => {
  const { store } = await fixture(t, { codexAuth() { throw new Error('fixture-private-auth-token'); } });
  const result = await store.load();
  assert.equal(result.view.codexAuthState, 'unreadable');
  assert.ok(!JSON.stringify(result).includes('fixture-private-auth-token'));
  await assert.rejects(store.prepare({ providerId: 'codex', modelId: 'fixture-model', baseURL: '' }), code('SETTINGS_CODEX_AUTH_REQUIRED', 'fixture-private-auth-token'));
});

test('Codex requires model metadata rather than silently choosing an invented model', async (t) => {
  const { store } = await fixture(t, { codexAuth: () => ({ available: true, state: 'available' }) });
  await assert.rejects(store.load(), code('SETTINGS_CODEX_MODEL_REQUIRED'));
});

test('an encrypted API key survives a Codex selection but is never decrypted or sent to Codex', async (t) => {
  const { store, storage, path } = await fixture(t, { codexAuth: () => ({ available: true, state: 'available', modelId: 'fixture-codex-model' }) });
  await store.commit(await store.prepare(remote({ apiKey: 'fixture-remote-only' })));
  const count = storage.decryptions;
  const codex = await store.prepare({ providerId: 'codex', modelId: 'fixture-codex-model', baseURL: '' });
  await store.commit(codex);
  assert.equal(codex.engineConfig.apiKey, undefined);
  assert.equal(storage.decryptions, count);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).credential.providerId, 'openai-compatible');
});

test('truncated JSON, invalid UTF-8 and oversized files fail without exposing content', async (t) => {
  const { directory, path, store } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  for (const value of ['{"apiKey":"fixture-truncated-secret"', Buffer.from([0xff, 0xfe])]) {
    await writeFile(path, value, { mode: 0o600 });
    await assert.rejects(store.load(), code('SETTINGS_JSON', 'fixture-truncated-secret'));
  }
  await writeFile(path, Buffer.alloc(32_769, 0x61));
  await assert.rejects(store.load(), code('SETTINGS_FILE_LIMIT'));
});

test('schema rejects plaintext keys, malformed ciphertext and unsupported providers', async (t) => {
  const { directory, store } = await fixture(t);
  for (const document of [
    { schemaVersion: 1, ...scripted, apiKey: 'fixture-unwanted-plaintext' },
    { schemaVersion: 1, ...scripted, credential: { providerId: 'openai-compatible', encryptedKey: 'not base64!' } },
    { schemaVersion: 1, ...scripted, credential: { providerId: 'codex', encryptedKey: 'YQ==' } },
    { schemaVersion: 99, ...scripted },
    { schemaVersion: 1, ...scripted, providerId: 'custom-unknown' },
  ]) {
    await writeStored(directory, document);
    await assert.rejects(store.load(), code('SETTINGS_INVALID', 'fixture-unwanted-plaintext'));
  }
});

test('symbolic settings files are rejected and their target is not touched', async (t) => {
  const { root, directory, path, store } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  const target = join(root, 'outside.json');
  await writeFile(target, 'outside fixture', { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(store.load(), code('SETTINGS_FILE_TYPE'));
  assert.equal(await readFile(target, 'utf8'), 'outside fixture');
});

test('symbolic settings directories are rejected before load or writes', async (t) => {
  const { root, directory, store } = await fixture(t);
  const target = join(root, 'outside');
  await mkdir(target);
  await symlink(target, directory);
  await assert.rejects(store.load(), code('SETTINGS_FILE_TYPE'));
  await assert.rejects(store.prepare(scripted), code('SETTINGS_FILE_TYPE'));
  assert.deepEqual(await readdir(target), []);
});

test('hard-linked settings are rejected', async (t) => {
  const { root, directory, path, store } = await fixture(t);
  await mkdir(directory, { mode: 0o700 });
  const target = join(root, 'original.json');
  await writeFile(target, JSON.stringify({ schemaVersion: 1, ...scripted }), { mode: 0o600 });
  await link(target, path);
  await assert.rejects(store.load(), code('SETTINGS_FILE_TYPE'));
});

test('group/world-readable credential settings are refused', { skip: process.platform === 'win32' }, async (t) => {
  const { directory, path, store } = await fixture(t);
  await writeStored(directory, { schemaVersion: 1, ...scripted });
  await chmod(path, 0o644);
  await assert.rejects(store.load(), code('SETTINGS_FILE_PERMISSIONS'));
});

test('prepared settings are store-bound and revision-bound under simultaneous commits', async (t) => {
  const { root, store, path, storage } = await fixture(t);
  const first = await store.prepare({ ...scripted, modelId: 'first-fixture' });
  const stale = await store.prepare({ ...scripted, modelId: 'stale-fixture' });
  const other = new SettingsStore({ directory: join(root, 'other'), safeStorage: storage, environment: {} });
  await assert.rejects(other.commit(first), code('SETTINGS_STALE'));
  await assert.rejects(store.commit({ view: first.view, engineConfig: first.engineConfig } as PreparedSettings), code('SETTINGS_STALE'));
  const results = await Promise.allSettled([store.commit(first), store.commit(stale)]);
  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.status, 'rejected');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).modelId, 'first-fixture');
  assert.equal(store.getView().modelId, 'first-fixture');
  await assert.rejects(store.commit(first), code('SETTINGS_STALE'));
});

test('failed commit preserves externally changed settings and does not change current view', async (t) => {
  const { store, path, directory } = await fixture(t);
  await store.commit(await store.prepare(scripted));
  const prepared = await store.prepare(remote({ apiKey: 'fixture-uncommitted' }));
  const external = { schemaVersion: 1, ...scripted, modelId: 'external-fixture' };
  await writeStored(directory, external);
  await assert.rejects(store.commit(prepared), code('SETTINGS_CHANGED', 'fixture-uncommitted'));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), external);
  assert.equal(store.getView().modelId, 'local');
  assert.deepEqual(await readdir(directory), ['settings.json']);
});

test('a symlink inserted after prepare prevents commit and leaves its target unchanged', async (t) => {
  const { root, directory, path, store } = await fixture(t);
  const prepared = await store.prepare(remote({ apiKey: 'fixture-never-written' }));
  await mkdir(directory, { mode: 0o700 });
  const target = join(root, 'outside.json');
  await writeFile(target, 'outside fixture', { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(store.commit(prepared), code('SETTINGS_FILE_TYPE', 'fixture-never-written'));
  assert.equal(await readFile(target, 'utf8'), 'outside fixture');
  assert.deepEqual(await readdir(directory), ['settings.json']);
});

test('bounded input validation rejects unsafe URL metadata without echoing credentials', async (t) => {
  const { store } = await fixture(t, { environment: { MOODCODE_API_KEY: 'fixture-key' } });
  for (const baseURL of [
    '', 'ftp://example.test', 'https://fixture-url-secret@example.test', 'https://example.test?token=fixture-url-secret',
    'https://example.test#fixture-url-secret', 'https://example.test?', ' https://example.test', 'https://example.test\n',
  ]) await assert.rejects(store.prepare(remote({ baseURL })), code('SETTINGS_INVALID', 'fixture-url-secret'));
  await assert.rejects(store.prepare(remote({ modelId: '' })), code('SETTINGS_INVALID'));
  await assert.rejects(store.prepare(remote({ modelId: 'a'.repeat(513) })), code('SETTINGS_INVALID'));
  await assert.rejects(store.prepare(remote({ apiKey: 'a'.repeat(4_097) })), code('SETTINGS_INVALID'));
  await assert.rejects(store.prepare({ ...remote(), clearKey: 'true' } as unknown as SaveDesktopSettings), code('SETTINGS_INVALID'));
});

test('input accessors and inherited properties are rejected without executing them', async (t) => {
  const { store } = await fixture(t);
  let reads = 0;
  const hostile = Object.defineProperty({ ...scripted }, 'apiKey', { enumerable: true, get() { reads += 1; return 'fixture-hostile'; } });
  await assert.rejects(store.prepare(hostile), code('SETTINGS_INVALID', 'fixture-hostile'));
  assert.equal(reads, 0);
  await assert.rejects(store.prepare(Object.create(scripted)), code('SETTINGS_INVALID'));
  await assert.rejects(store.prepare({ ...scripted, [Symbol('secret')]: 'fixture-symbol' }), code('SETTINGS_INVALID'));
});

test('a failed write due to an invalid settings directory retains in-memory configuration', async (t) => {
  const { directory, root, store } = await fixture(t);
  const prepared = await store.prepare(remote({ apiKey: 'fixture-failed-write' }));
  await writeFile(directory, 'fixture-directory-blocker', { mode: 0o600 });
  await assert.rejects(store.commit(prepared), code('SETTINGS_FILE_TYPE', 'fixture-failed-write'));
  assert.equal(store.getView().providerId, 'scripted');
  assert.equal(await readFile(directory, 'utf8'), 'fixture-directory-blocker');
  assert.deepEqual(await readdir(root), ['private']);
});
