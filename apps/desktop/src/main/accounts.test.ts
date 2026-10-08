import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { DesktopAccounts } from './accounts.js';
import { AccountError } from './account-auth.js';
import { SettingsStore, type CredentialStorage } from './settings.js';

const code = (expected: string) => (error: unknown): boolean => {
  assert.ok(error instanceof AccountError); assert.equal(error.code, expected);
  assert.doesNotMatch(error.message, /private-(?:access|refresh|identity)/u); return true;
};
class EncryptedFixture implements CredentialStorage {
  readonly key = randomBytes(32);
  available = true;
  failEncryption = false;
  beforeEncrypt?: (value: string) => void;
  isEncryptionAvailable(): boolean { return this.available; }
  getSelectedStorageBackend(): string { return 'fixture-encrypted'; }
  encryptString(value: string): Buffer {
    if (this.failEncryption) throw new Error('private-refresh');
    this.beforeEncrypt?.(value);
    return this.encrypt(value, randomBytes(12));
  }
  private encrypt(value: string, nonce: Buffer): Buffer {
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce), data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), data]);
  }
  decryptString(value: Buffer): string {
    const cipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  }
}

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), 'moodcode-accounts-'));
  // Normal Electron userData can be 0755. Account storage gets its own 0700 child.
  await chmod(parent, 0o755);
  const directory = join(parent, 'accounts'), storage = new EncryptedFixture();
  const pair = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256' };
  let now = 1_800_000_000_000, authorize: URL | undefined, subject = 'fixture-subject', tokenClient = '', nonceOverride: string | undefined;
  let refreshFailure = false, revokeFailure = false, browserHeld = false, refreshCounter = 0;
  let signatureFailure = false;
  let jwksHold: Promise<void> | undefined, releaseJwks: (() => void) | undefined, jwksRequested = false;
  const calls: { url: string; body?: URLSearchParams; authorization?: string | null }[] = [];
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = String(input), body = init?.body instanceof URLSearchParams ? init.body : undefined;
    calls.push({ url, body, authorization: new Headers(init?.headers).get('Authorization') });
    if (url.endsWith('/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
      token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
    if (url.endsWith('/jwks.json')) { jwksRequested = true; await jwksHold; return Response.json({ keys: [jwk] }); }
    if (url.endsWith('/oauth/token')) {
      if (body?.get('grant_type') === 'refresh_token') {
        refreshCounter += 1;
        if (refreshFailure) return Response.json({ error: 'invalid_grant', error_description: 'private-refresh' }, { status: 400 });
        return Response.json({ access_token: `private-access-refreshed-${refreshCounter}`, refresh_token: `private-refresh-rotated-${refreshCounter}`, token_type: 'Bearer', expires_in: 3600 });
      }
      tokenClient = body!.get('client_id')!;
      let idToken = await new SignJWT({ nonce: nonceOverride ?? authorize!.searchParams.get('nonce'), email: 'person@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
        .setIssuer('https://auth.openai.com').setSubject(subject).setAudience(tokenClient).setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 3600).sign(pair.privateKey);
      if (signatureFailure) idToken = `${idToken.slice(0, -8)}invalidx`;
      return Response.json({ access_token: 'private-access-initial', refresh_token: 'private-refresh-initial', id_token: idToken, token_type: 'Bearer', expires_in: 3600,
        scope: 'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct' });
    }
    if (url.endsWith('/oauth/revoke')) return new Response(null, { status: revokeFailure ? 503 : 200 });
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list' }, { slug: 'hidden-model', display_name: 'Hidden model', visibility: 'hidden' }] });
    throw new Error('Unexpected fixture endpoint');
  };
  const openExternal = async (url: string) => {
    authorize = new URL(url); if (browserHeld) return;
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
    const wrong = new URL(redirect); wrong.search = new URLSearchParams({ state: 'wrong-state', code: 'private-code', client_id: 'oaiapp_fixture' }).toString();
    assert.equal((await fetch(wrong)).status, 400);
    redirect.search = new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'private-code', client_id: authorize.searchParams.get('client_id') === 'dynamic_agent_client' ? 'oaiapp_fixture' : authorize.searchParams.get('client_id')! }).toString();
    assert.equal((await fetch(redirect)).status, 200);
  };
  const options = { directory, safeStorage: storage, fetch: fetchFixture, openExternal, now: () => now, callbackTimeoutMs: 500 };
  const accounts = new DesktopAccounts(options);
  t.after(async () => { await accounts.close(); await rm(parent, { recursive: true, force: true }); });
  return { parent, directory, storage, accounts, options, calls, authorize: () => authorize!, advance: (ms: number) => { now += ms; },
    changeSubject: () => { subject = 'different-subject'; }, badNonce: () => { nonceOverride = 'wrong-nonce'; }, badSignature: () => { signatureFailure = true; },
    refreshFailure: () => { refreshFailure = true; }, revokeFailure: () => { revokeFailure = true; }, holdBrowser: () => { browserHeld = true; }, refreshes: () => refreshCounter,
    holdJwks: () => { jwksHold = new Promise<void>(resolve => { releaseJwks = resolve; }); }, releaseJwks: () => releaseJwks?.(), jwksRequested: () => jwksRequested };
}

test('official loopback PKCE validates identity, stores encrypted sessions and binds Responses to account models', async t => {
  const f = await fixture(t);
  const view = await f.accounts.action({ action: 'sign-in' }, 'owner-1');
  assert.equal(view.accounts[0]?.state, 'connected'); assert.equal(view.accounts[0]?.sharing, true);
  assert.deepEqual(view.models, [{ id: 'fixture-model', displayName: 'Fixture model' }]);
  assert.equal(f.authorize().searchParams.get('client_id'), 'dynamic_agent_client');
  assert.match(f.authorize().searchParams.get('ext_agent_host_id')!, /^urn:uuid:/u);
  assert.equal(f.authorize().searchParams.get('code_challenge_method'), 'S256');
  const exchange = f.calls.find(call => call.body?.get('grant_type') === 'authorization_code')!;
  assert.equal(exchange.body?.get('redirect_uri'), f.authorize().searchParams.get('redirect_uri'));
  assert.equal(exchange.body?.get('client_id'), 'oaiapp_fixture');
  assert.equal(exchange.body?.get('resource'), 'https://api.openai.com/v1');
  const encrypted = await readFile(join(f.directory, 'accounts.enc.json'), 'utf8');
  assert.doesNotMatch(encrypted, /private-access|private-refresh|person@example/u);
  assert.doesNotMatch(JSON.stringify(view), /private-access|private-refresh|oaiapp_fixture/u);
  await f.accounts.resolveCredential(); const credential = f.accounts.getCredential()!;
  assert.equal(credential.apiKey, 'private-access-initial'); assert.doesNotMatch(JSON.stringify(credential), /private-access/u);
  const settings = new SettingsStore({ directory: join(f.parent, 'settings'), safeStorage: f.storage, environment: {}, accountCredential: () => f.accounts.getCredential() });
  const binding = { credentialMode: 'chatgpt' as const, accountId: view.activeAccountId };
  const prepared = await settings.prepare({ providerId: 'openai-responses', modelId: 'fixture-model', baseURL: 'https://api.openai.com/v1', ...binding });
  assert.equal(prepared.engineConfig.apiKey, 'private-access-initial'); assert.equal(prepared.view.keySource, 'chatgpt');
  assert.doesNotMatch(JSON.stringify(prepared), /private-access/u);
  await assert.rejects(settings.prepare({ providerId: 'openai-responses', modelId: 'hidden-model', baseURL: 'https://api.openai.com/v1', ...binding }));
  await assert.rejects(settings.prepare({ providerId: 'openai-compatible', modelId: 'fixture-model', baseURL: 'https://api.openai.com/v1' }));
  await assert.rejects(settings.prepare({ providerId: 'openai-responses', modelId: 'fixture-model', baseURL: 'https://foreign.example/v1' }));
});

test('account restore reuses host and client, rotates tokens once and replaces the persistent grant', async t => {
  const f = await fixture(t); const initial = await f.accounts.action({ action: 'sign-in' }, 'owner');
  const id = initial.activeAccountId!, host = f.authorize().searchParams.get('ext_agent_host_id');
  await f.accounts.action({ action: 'sign-in', accountId: id }, 'owner');
  assert.equal(f.authorize().searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(f.authorize().searchParams.has('agent_name_hint'), false);
  assert.equal(f.authorize().searchParams.get('ext_agent_host_id'), host); assert.ok(f.authorize().searchParams.get('id_token_hint'));
  f.advance(3_550_000);
  await Promise.all([f.accounts.resolveCredential(), f.accounts.resolveCredential()]);
  assert.equal(f.refreshes(), 1); assert.equal(f.accounts.getCredential()?.apiKey, 'private-access-refreshed-1');
  const restored = new DesktopAccounts(f.options); t.after(() => restored.close());
  await restored.resolveCredential(); assert.equal(restored.getCredential()?.apiKey, 'private-access-refreshed-1');
});

test('returning identity mismatch cannot overwrite a connected account', async t => {
  const f = await fixture(t); const initial = await f.accounts.action({ action: 'sign-in' }, 'owner'); f.changeSubject();
  await assert.rejects(f.accounts.action({ action: 'sign-in', accountId: initial.activeAccountId }, 'owner'), code('ACCOUNT_IDENTITY_CHANGED'));
  assert.equal((await f.accounts.getView()).activeAccountId, initial.activeAccountId);
  await f.accounts.resolveCredential(); assert.equal(f.accounts.getCredential()?.apiKey, 'private-access-initial');
});

for (const invalid of ['nonce', 'signature'] as const) test(`unverified ${invalid} never makes an account active`, async t => {
  const f = await fixture(t); if (invalid === 'nonce') f.badNonce(); else f.badSignature();
  await assert.rejects(f.accounts.action({ action: 'sign-in' }, 'owner'), code('ACCOUNT_IDENTITY_INVALID'));
  assert.equal((await f.accounts.getView()).activeAccountId, undefined); assert.equal(f.accounts.getCredential(), undefined);
});

test('expired rotating grant removes credentials and requests explicit reauthorization', async t => {
  const f = await fixture(t); await f.accounts.action({ action: 'sign-in' }, 'owner'); f.advance(3_600_000); f.refreshFailure();
  await assert.rejects(f.accounts.resolveCredential(), code('ACCOUNT_REAUTH_REQUIRED'));
  assert.equal(f.accounts.getCredential(), undefined); assert.equal((await f.accounts.getView()).accounts[0]?.state, 'expired');
  const restored = new DesktopAccounts(f.options); t.after(() => restored.close());
  assert.equal(await restored.resolveCredential(), undefined);
});

test('refresh persistence failure quarantines both old and unpersisted rotating grants', async t => {
  const f = await fixture(t); await f.accounts.action({ action: 'sign-in' }, 'owner'); await f.accounts.resolveCredential();
  f.storage.failEncryption = true; f.advance(3_600_000);
  await assert.rejects(f.accounts.resolveCredential(), code('ACCOUNT_STORAGE_FAILED'));
  assert.equal(f.accounts.getCredential(), undefined); assert.equal((await f.accounts.getView()).accounts[0]?.state, 'failed');
  f.storage.failEncryption = false; assert.equal(await f.accounts.resolveCredential(), undefined); assert.equal(f.refreshes(), 1);
  const reopened = new DesktopAccounts(f.options); t.after(() => reopened.close());
  assert.equal(await reopened.resolveCredential(), undefined); assert.equal(f.refreshes(), 1);
  assert.equal((await reopened.getView()).error?.code, 'ACCOUNT_REAUTH_REQUIRED');
});

test('selected ChatGPT mode never falls back to stored or environment API keys after logout', async t => {
  const f = await fixture(t); const view = await f.accounts.action({ action: 'sign-in' }, 'owner');
  await f.accounts.resolveCredential();
  const settings = new SettingsStore({ directory: join(f.parent, 'settings'), safeStorage: f.storage, environment: {}, accountCredential: () => f.accounts.getCredential() });
  await settings.commit(await settings.prepare({ providerId: 'openai-responses', modelId: 'fixture-model', baseURL: 'https://api.openai.com/v1', apiKey: 'fixture-saved-api-key' }));
  await settings.commit(await settings.prepare({ providerId: 'openai-responses', modelId: 'fixture-model', baseURL: 'https://api.openai.com/v1', credentialMode: 'chatgpt', accountId: view.activeAccountId }));
  await f.accounts.action({ action: 'sign-out' }, 'owner');
  await assert.rejects(settings.load(), error => { assert.equal((error as { code: string }).code, 'SETTINGS_ACCOUNT_AUTH_REQUIRED'); return true; });
  const envStore = new SettingsStore({ directory: join(f.parent, 'settings'), safeStorage: f.storage, environment: { OPENAI_API_KEY: 'fixture-environment-api-key' }, accountCredential: () => f.accounts.getCredential() });
  await assert.rejects(envStore.load(), error => { assert.equal((error as { code: string }).code, 'SETTINGS_ACCOUNT_AUTH_REQUIRED'); return true; });
  const explicitKey = await envStore.prepare({ providerId: 'openai-responses', modelId: 'fixture-model', baseURL: 'https://api.openai.com/v1', credentialMode: 'api-key' });
  assert.equal(explicitKey.engineConfig.apiKey, 'fixture-environment-api-key');
});

test('local logout clears every token, retains registration, and reports unconfirmed remote revocation', async t => {
  const f = await fixture(t); const initial = await f.accounts.action({ action: 'sign-in' }, 'owner'); f.revokeFailure();
  const view = await f.accounts.action({ action: 'sign-out', accountId: initial.activeAccountId }, 'owner');
  assert.equal(view.accounts[0]?.state, 'signed-out'); assert.equal(view.activeAccountId, undefined);
  assert.equal(view.error?.code, 'ACCOUNT_REVOCATION_UNCONFIRMED'); assert.equal(f.accounts.getCredential(), undefined);
  const revoke = f.calls.find(call => call.url.endsWith('/oauth/revoke'))!;
  assert.equal(revoke.body?.get('token_type_hint'), 'refresh_token'); assert.equal(revoke.body?.get('client_id'), 'oaiapp_fixture');
  const restored = new DesktopAccounts(f.options); t.after(() => restored.close());
  assert.equal(await restored.resolveCredential(), undefined);
  await f.accounts.action({ action: 'sign-in', accountId: initial.activeAccountId }, 'owner');
  assert.equal(f.authorize().searchParams.has('id_token_hint'), false); assert.equal(f.authorize().searchParams.get('client_id'), 'oaiapp_fixture');
  await f.accounts.action({ action: 'forget', accountId: initial.activeAccountId }, 'owner'); assert.deepEqual((await f.accounts.getView()).accounts, []);
});

test('owner reload cancels loopback auth, another owner cannot cancel it, and the callback listener closes', async t => {
  const f = await fixture(t); f.holdBrowser(); const pending = f.accounts.action({ action: 'sign-in' }, 'owner');
  while (!(await f.accounts.getView()).pending || !f.authorize()) await new Promise(resolve => setTimeout(resolve, 5));
  f.accounts.cancelOwner('different-owner'); assert.equal((await f.accounts.getView()).pending, true);
  f.accounts.cancelOwner('owner'); await assert.rejects(pending, code('ACCOUNT_CANCELLED'));
  assert.equal((await f.accounts.getView()).pending, false);
  await assert.rejects(fetch(f.authorize().searchParams.get('redirect_uri')!));
  assert.equal(f.accounts.getCredential(), undefined);
});

test('owner reload while JWKS verification is pending cannot activate or persist a late sign-in', async t => {
  const f = await fixture(t); f.holdJwks();
  const signIn = f.accounts.action({ action: 'sign-in' }, 'owner');
  while (!f.jwksRequested()) await new Promise(resolve => setTimeout(resolve, 5));
  f.accounts.cancelOwner('owner'); f.releaseJwks();
  await assert.rejects(signIn, code('ACCOUNT_CANCELLED'));
  assert.equal((await f.accounts.getView()).activeAccountId, undefined); assert.equal(f.accounts.getCredential(), undefined);
  const persisted = JSON.parse(f.storage.decryptString(Buffer.from(JSON.parse(await readFile(join(f.directory, 'accounts.enc.json'), 'utf8')).encrypted, 'base64')));
  assert.equal(persisted.accounts[0].tokens, undefined); assert.equal(persisted.accounts[0].state, 'signed-out');
});

test('cancel during encrypted credential persistence stops before the atomic file commit', async t => {
  const f = await fixture(t); let interrupted = false;
  f.storage.beforeEncrypt = value => {
    if (!interrupted && value.includes('private-access-initial')) { interrupted = true; queueMicrotask(() => f.accounts.cancelOwner('owner')); }
  };
  await assert.rejects(f.accounts.action({ action: 'sign-in' }, 'owner'), code('ACCOUNT_CANCELLED'));
  assert.equal(interrupted, true); assert.equal((await f.accounts.getView()).activeAccountId, undefined);
  const persisted = JSON.parse(f.storage.decryptString(Buffer.from(JSON.parse(await readFile(join(f.directory, 'accounts.enc.json'), 'utf8')).encrypted, 'base64')));
  assert.equal(persisted.accounts[0].tokens, undefined);
  assert.deepEqual(await readdir(f.directory), ['accounts.enc.json']);
});

test('secure storage failure never launches a browser or writes plaintext credentials', async t => {
  const f = await fixture(t); f.storage.available = false;
  await assert.rejects(f.accounts.action({ action: 'sign-in' }, 'owner'), code('ACCOUNT_SECURE_STORAGE_REQUIRED'));
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.directory), []);
});

test('unsafe account files are rejected without changing their targets', async t => {
  const f = await fixture(t); await mkdir(f.directory, { mode: 0o700 });
  const target = join(f.parent, 'untouched'); await writeFile(target, 'untouched fixture', { mode: 0o600 });
  await symlink(target, join(f.directory, 'accounts.enc.json'));
  await assert.rejects(f.accounts.getView(), code('ACCOUNT_FILE_UNSAFE')); assert.equal(await readFile(target, 'utf8'), 'untouched fixture');
});

test('account action data rejects accessors without reading their secret values', async t => {
  const f = await fixture(t); let reads = 0;
  const input = Object.defineProperty({}, 'action', { enumerable: true, get() { reads += 1; return 'sign-in'; } });
  await assert.rejects(f.accounts.action(input as never, 'owner'), code('ACCOUNT_ACTION_INVALID'));
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
});
