import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADVANCED_EXPIRY_MS, RENEWAL_WINDOW_MS, advanceSelectedExpiry, classifyAccountRequest, createRevisionTracker, discoveredJwksURL } from './verify-desktop-codex-renewal-live.mjs';

const catalogURL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.162.0', jwksURL = 'https://auth.openai.com/fixture/keys';
const destinations = { catalogURL, jwksURL };
const code = expected => error => error.code === expected;

test('account requests are allow-listed by exact destination, method and redirect policy', () => {
  const get = { method: 'GET', redirect: 'error' }, post = { method: 'POST', redirect: 'error' };
  assert.equal(classifyAccountRequest('https://auth.openai.com/oauth/token', post, destinations), 'token-refresh');
  assert.equal(classifyAccountRequest('https://auth.openai.com/.well-known/openid-configuration', get, destinations), 'discovery');
  assert.equal(classifyAccountRequest(jwksURL, get, destinations), 'jwks');
  assert.equal(classifyAccountRequest(catalogURL, { redirect: 'error' }, destinations), 'catalog');
  for (const [url, init] of [['https://auth.openai.com/oauth/token', get], ['https://auth.openai.com/oauth/token', { method: 'POST' }],
    ['https://auth.openai.com/oauth/revoke', post], ['https://auth.openai.com/.well-known/jwks.json', get], [jwksURL, post], ['https://auth.example/oauth/token', post],
    [catalogURL.replace('0.162.0', '0.1.0'), get], ['https://chatgpt.com/backend-api/codex/responses', post]]) assert.equal(classifyAccountRequest(url, init, destinations), undefined, url);
});

test('JWKS destination is taken only from the issuer discovery document', () => {
  assert.equal(discoveredJwksURL({ issuer: 'https://auth.openai.com', jwks_uri: jwksURL }), jwksURL);
  for (const document of [undefined, { issuer: 'https://auth.example', jwks_uri: jwksURL }, { issuer: 'https://auth.openai.com' },
    { issuer: 'https://auth.openai.com', jwks_uri: 'https://keys.example/jwks' }, { issuer: 'https://auth.openai.com', jwks_uri: `${jwksURL}?v=1` },
    { issuer: 'https://auth.openai.com', jwks_uri: 'not a url' }]) assert.throws(() => discoveredJwksURL(document), code('VERIFY_DISCOVERY_INVALID'));
});

test('only the selected account expiry advances, never later than its real expiry', () => {
  const now = 1_800_000_000_000, real = now + 10 * 86_400_000;
  const value = { activeAccountId: 'a', accounts: [{ id: 'b', tokens: { expiresAt: real } }, { id: 'a', tokens: { expiresAt: real, accessToken: 'unchanged' } }] };
  advanceSelectedExpiry(value, now);
  assert.equal(value.accounts[1].tokens.expiresAt, now + ADVANCED_EXPIRY_MS); assert.equal(value.accounts[1].tokens.accessToken, 'unchanged');
  assert.equal(value.accounts[0].tokens.expiresAt, real);
  const sooner = { activeAccountId: 'a', accounts: [{ id: 'a', tokens: { expiresAt: now + 1_000 } }] };
  assert.equal(advanceSelectedExpiry(sooner, now).accounts[0].tokens.expiresAt, now + 1_000);
  for (const invalid of [{}, { activeAccountId: 'a', accounts: [{ id: 'a' }] }, { activeAccountId: 'a', accounts: [{ id: 'a', tokens: { expiresAt: 'soon' } }] }])
    assert.throws(() => advanceSelectedExpiry(invalid, now), code('VERIFY_FRESH_NATIVE_ACCOUNT_REQUIRED'));
  // Advanced expiry leaves time for a pre-window turn and a later in-window turn.
  assert.ok(ADVANCED_EXPIRY_MS - RENEWAL_WINDOW_MS >= 45_000);
});

test('credential revisions are ordinal and stable per digest', () => {
  const revision = createRevisionTracker();
  assert.deepEqual(['first', 'first', 'second', 'first', 'second'].map(revision), [1, 1, 2, 1, 2]);
});
