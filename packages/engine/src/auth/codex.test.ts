import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { test } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { createCodexCredentialReader, getCodexAuthStatus } from './codex.js';

const ACCESS = 'synthetic-access-only-for-local-tests';
const REFRESH = 'synthetic-refresh-only-for-local-tests';
const ID = 'synthetic-id-only-for-local-tests';
const ACCOUNT = 'synthetic-account-only-for-local-tests';
const NOW = 1_800_000_000_000;
const signal = (): AbortSignal => new AbortController().signal;
function fixture(accessToken = ACCESS): Record<string, unknown> {
  return { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: accessToken, refresh_token: REFRESH, id_token: ID, account_id: ACCOUNT }, last_refresh: '2026-10-01T00:00:00Z' };
}
function jwt(payload: unknown): string {
  return [Buffer.from('{"alg":"synthetic"}').toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url'), 'synthetic-signature'].join('.');
}
async function home(t: { after(fn: () => Promise<void>): void }, auth: unknown = fixture()): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'moodcode-codex-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (auth !== undefined) await writeFile(join(directory, 'auth.json'), typeof auth === 'string' || Buffer.isBuffer(auth) ? auth : JSON.stringify(auth), { mode: 0o600 });
  return directory;
}
function code(expected: string): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, expected);
    assert.equal(error.details, undefined);
    for (const secret of [ACCESS, REFRESH, ID, ACCOUNT]) assert.ok(!inspect(error, { showHidden: true }).includes(secret));
    return true;
  };
}

test('status returns only safe metadata and credential object inspection is redacted', async t => {
  const codexHome = await home(t);
  await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-synthetic-codex"\n[profiles.example]\nmodel = "gpt-ignored"\n');
  assert.deepEqual(await getCodexAuthStatus({ codexHome, now: () => NOW }), { state: 'ready', modelId: 'gpt-synthetic-codex' });
  const reader = createCodexCredentialReader({ codexHome, now: () => NOW });
  await reader.use(signal(), credential => {
    assert.equal(credential.accessToken, ACCESS);
    assert.equal(credential.accountId, ACCOUNT);
    assert.deepEqual(new Set(credential.secrets), new Set([ACCESS, ACCOUNT, REFRESH, ID]));
    assert.equal(inspect(credential, { showHidden: true }), '[CodexCredential]');
    assert.equal(JSON.stringify(credential), '{}');
    assert.deepEqual(Object.keys(credential), []);
    assert.ok(Object.isFrozen(credential));
    assert.ok(Object.isFrozen(credential.secrets));
  });
  for (const secret of [ACCESS, REFRESH, ID, ACCOUNT]) assert.ok(!inspect(reader, { showHidden: true }).includes(secret));
});

test('each use follows atomic Codex refresh without changing credential files', async t => {
  const codexHome = await home(t);
  const path = join(codexHome, 'auth.json');
  const reader = createCodexCredentialReader({ codexHome, now: () => NOW });
  const before = createHash('sha256').update(await readFile(path)).digest('hex');
  await reader.use(signal(), credential => { assert.equal(credential.accessToken, ACCESS); });
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), before);
  const next = join(codexHome, 'auth-next.json');
  await writeFile(next, JSON.stringify(fixture('synthetic-access-rotated-by-codex')));
  await rename(next, path);
  const refreshed = await readFile(path);
  await reader.use(signal(), credential => { assert.equal(credential.accessToken, 'synthetic-access-rotated-by-codex'); });
  assert.deepEqual(await readFile(path), refreshed);
});

test('missing authentication has a safe status and static error', async t => {
  const codexHome = await home(t);
  await rm(join(codexHome, 'auth.json'));
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'missing' });
  await assert.rejects(createCodexCredentialReader({ codexHome }).use(signal(), () => { assert.fail('must not use missing credentials'); }), code('CODEX_AUTH_MISSING'));
});

test('access JWT expiry is checked locally and the exact expiry boundary is expired', async t => {
  for (const exp of [NOW / 1000 - 1, NOW / 1000]) {
    const codexHome = await home(t, fixture(jwt({ exp })));
    assert.deepEqual(await getCodexAuthStatus({ codexHome, now: () => NOW }), { state: 'expired' });
    await assert.rejects(createCodexCredentialReader({ codexHome, now: () => NOW }).use(signal(), () => undefined), code('CODEX_AUTH_EXPIRED'));
  }
});

test('unexpired and opaque access tokens are accepted, and ID token expiry is not used', async t => {
  for (const accessToken of [ACCESS, jwt({ exp: NOW / 1000 + 1 }), jwt({ sub: 'synthetic-user' })]) {
    const auth = fixture(accessToken);
    (auth.tokens as Record<string, unknown>).id_token = jwt({ exp: 0 });
    const codexHome = await home(t, auth);
    assert.deepEqual(await getCodexAuthStatus({ codexHome, now: () => NOW }), { state: 'ready' });
  }
});

test('unsupported cached authentication never falls back to an API key', async t => {
  for (const mode of ['apikey', 'api', 'workload_identity', 'unknown']) {
    const auth = fixture(); auth.auth_mode = mode;
    const codexHome = await home(t, auth);
    assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'unsupported' });
    await assert.rejects(createCodexCredentialReader({ codexHome }).use(signal(), () => undefined), code('CODEX_AUTH_UNSUPPORTED'));
  }
});

for (const [name, mutate] of [
  ['missing auth mode', (auth: Record<string, unknown>) => { delete auth.auth_mode; }],
  ['array tokens', (auth: Record<string, unknown>) => { auth.tokens = []; }],
  ['null tokens', (auth: Record<string, unknown>) => { auth.tokens = null; }],
  ['missing access token', (auth: Record<string, unknown>) => { delete (auth.tokens as Record<string, unknown>).access_token; }],
  ['empty access token', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).access_token = ''; }],
  ['non-string access token', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).access_token = 4; }],
  ['access token whitespace', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).access_token = 'unsafe bearer'; }],
  ['access token newline', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).access_token = 'unsafe\nbearer'; }],
  ['oversized access token', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).access_token = 'a'.repeat(32_769); }],
  ['invalid refresh token', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).refresh_token = false; }],
  ['invalid ID token', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).id_token = 'unsafe\rid'; }],
  ['missing account id', (auth: Record<string, unknown>) => { delete (auth.tokens as Record<string, unknown>).account_id; }],
  ['empty account id', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).account_id = ''; }],
  ['oversized account id', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).account_id = 'a'.repeat(257); }],
  ['account header injection', (auth: Record<string, unknown>) => { (auth.tokens as Record<string, unknown>).account_id = 'account\r\nX: unsafe'; }],
] as const) {
  test(`invalid credential fields: ${name}`, async t => {
    const auth = fixture(); mutate(auth);
    const codexHome = await home(t, auth);
    assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'invalid' });
    await assert.rejects(createCodexCredentialReader({ codexHome }).use(signal(), () => undefined), code('CODEX_AUTH_INVALID'));
  });
}

test('largest permitted bearer token and optional absent auxiliary tokens are accepted', async t => {
  const auth = fixture('a'.repeat(32_768));
  const tokens = auth.tokens as Record<string, unknown>;
  delete tokens.refresh_token; tokens.id_token = null;
  const codexHome = await home(t, auth);
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'ready' });
  await createCodexCredentialReader({ codexHome }).use(signal(), credential => { assert.equal(credential.secrets.length, 2); });
});

for (const [name, content] of [
  ['invalid JSON', '{"tokens":'],
  ['JSON array', '[]'],
  ['JSON primitive', 'null'],
  ['nonfinite JSON number', '{"value":1e999}'],
  ['too deeply nested JSON', '{"value":' + '['.repeat(66) + '0' + ']'.repeat(66) + '}'],
  ['invalid UTF-8', Buffer.from([0x7b, 0xc3, 0x28, 0x7d])],
] as const) {
  test(`invalid authentication document: ${name}`, async t => {
    const codexHome = await home(t, content);
    assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'invalid' });
  });
}

for (const [name, token] of [
  ['invalid payload', 'eyJhbGciOiJ0ZXN0In0.bm90LWpzb24.signature'],
  ['array payload', jwt([])],
  ['nonfinite exp', jwt({ exp: 'tomorrow' })],
  ['negative exp', jwt({ exp: -1 })],
  ['fractional exp', jwt({ exp: 3.5 })],
  ['unsafe exp', jwt({ exp: Number.MAX_SAFE_INTEGER })],
  ['invalid base64url', 'header.@@@.signature'],
] as const) {
  test(`invalid access JWT: ${name}`, async t => {
    const codexHome = await home(t, fixture(token));
    assert.deepEqual(await getCodexAuthStatus({ codexHome, now: () => NOW }), { state: 'invalid' });
  });
}

test('auth links and nonregular files are rejected before credential callbacks', async t => {
  const codexHome = await home(t);
  const path = join(codexHome, 'auth.json');
  await rename(path, join(codexHome, 'actual-auth.json'));
  await symlink(join(codexHome, 'actual-auth.json'), path);
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'unreadable' });
  await assert.rejects(createCodexCredentialReader({ codexHome }).use(signal(), () => undefined), code('CODEX_AUTH_UNREADABLE'));
  await rm(path); await mkdir(path);
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'unreadable' });
});

test('oversized authentication documents are never read as credentials', async t => {
  const codexHome = await home(t, ' '.repeat(131_073));
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'unreadable' });
});

test('unreadable authentication errors contain neither credential data nor file paths', async t => {
  const codexHome = await home(t);
  const path = join(codexHome, 'auth.json');
  await chmod(path, 0);
  t.after(() => chmod(path, 0o600).catch(() => {}));
  if (process.getuid?.() === 0) return;
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'unreadable' });
  await assert.rejects(createCodexCredentialReader({ codexHome }).use(signal(), () => undefined), error => {
    code('CODEX_AUTH_UNREADABLE')(error);
    assert.ok(!inspect(error, { showHidden: true }).includes(codexHome));
    return true;
  });
});

test('abort reasons are not disclosed and callbacks are not invoked', async t => {
  const codexHome = await home(t);
  const controller = new AbortController(); controller.abort(new Error(ACCESS));
  await assert.rejects(getCodexAuthStatus({ codexHome, signal: controller.signal }), code('PROVIDER_CANCELLED'));
  await assert.rejects(createCodexCredentialReader({ codexHome }).use(controller.signal, () => { assert.fail('cancelled callback'); }), code('PROVIDER_CANCELLED'));
});

test('cancellation during an async file read is checked before using credentials', async t => {
  const codexHome = await home(t);
  const controller = new AbortController();
  const pending = createCodexCredentialReader({ codexHome }).use(controller.signal, () => { assert.fail('cancelled callback'); });
  queueMicrotask(() => controller.abort(REFRESH));
  await assert.rejects(pending, code('PROVIDER_CANCELLED'));
});

test('top-level model wins over catalog and nested profile model is ignored', async t => {
  const codexHome = await home(t);
  await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-catalog-codex', extra: ACCESS }] }));
  await writeFile(join(codexHome, 'config.toml'), '# local configuration\nmodel = \'gpt-selected-codex\' # chosen\n[profiles.example]\nmodel = "gpt-profile-codex"');
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'ready', modelId: 'gpt-selected-codex' });
  await writeFile(join(codexHome, 'config.toml'), '[profiles.example]\nmodel = "gpt-profile-codex"');
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'ready', modelId: 'gpt-catalog-codex' });
});

test('invalid and sensitive model fields are omitted; only catalog slug is considered', async t => {
  const codexHome = await home(t);
  await writeFile(join(codexHome, 'config.toml'), 'model = "https://untrusted.test/model"\n');
  await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: REFRESH }, { name: 'gpt-name-is-not-slug' }, { slug: 'gpt-valid-catalog' }] }));
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'ready', modelId: 'gpt-valid-catalog' });
  await rm(join(codexHome, 'models_cache.json'));
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'ready' });
});

test('credential strings cannot be returned as model metadata even for unsupported auth', async t => {
  const secret = 'gpt-synthetic-credential';
  const auth = fixture(secret);
  const codexHome = await home(t, auth);
  await writeFile(join(codexHome, 'config.toml'), `model = "${secret}"`);
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'ready' });
  auth.auth_mode = 'unsupported';
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify(auth));
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'unsupported' });
});

test('model links, oversize and malformed caches are ignored without changing auth status', async t => {
  const codexHome = await home(t);
  await writeFile(join(codexHome, 'elsewhere.toml'), 'model = "gpt-symlink-codex"');
  await symlink(join(codexHome, 'elsewhere.toml'), join(codexHome, 'config.toml'));
  await writeFile(join(codexHome, 'models_cache.json'), '{invalid');
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'ready' });
  await rm(join(codexHome, 'config.toml'));
  await writeFile(join(codexHome, 'config.toml'), ' '.repeat(262_145));
  await writeFile(join(codexHome, 'models_cache.json'), ' '.repeat(2_097_153));
  assert.deepEqual(await getCodexAuthStatus({ codexHome }), { state: 'ready' });
});

test('bad options and invalid clocks yield safe authentication metadata', async t => {
  assert.deepEqual(await getCodexAuthStatus({ codexHome: '' }), { state: 'invalid' });
  assert.throws(() => createCodexCredentialReader({ codexHome: '\0' }), code('CODEX_AUTH_INVALID'));
  for (const now of [() => NaN, () => -1, () => Infinity, () => { throw new Error(ACCESS); }]) {
    const codexHome = await home(t);
    assert.deepEqual(await getCodexAuthStatus({ codexHome, now }), { state: 'invalid' });
  }
});
