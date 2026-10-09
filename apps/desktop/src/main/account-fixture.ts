import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { ChatGPTAuthOptions } from './account-auth.js';

/** Isolated GUI auth fixture. Main enables it only for the un-packaged account test scenario. */
export async function createAccountFixtureTransport(): Promise<Pick<ChatGPTAuthOptions, 'fetch' | 'openExternal'>> {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'moodcode-fixture', alg: 'RS256' };
  let refreshes = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json({ issuer: 'https://auth.openai.com',
      authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
      jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
    if (url === 'https://chatgpt.com/backend-api/codex/models?client_version=0.162.0') {
      const headers = new Headers(init?.headers);
      if (!headers.get('Authorization')?.startsWith('Bearer moodcode-fixture-access-') || headers.get('ChatGPT-Account-Id') !== 'fixture-chatgpt-account') throw new Error('Invalid fixture account binding.');
      return Response.json({ models: [{ slug: 'fixture-chatgpt-model', display_name: 'Fixture ChatGPT model', visibility: 'list' }] });
    }
    if (url === 'https://auth.openai.com/oauth/token' && init?.body instanceof URLSearchParams) {
      const form = init.body;
      if (form.get('grant_type') === 'refresh_token') return Response.json({ access_token: `moodcode-fixture-access-refresh-${++refreshes}`, refresh_token: `moodcode-fixture-refresh-${refreshes}`, token_type: 'Bearer', expires_in: 3600 });
      const client = form.get('client_id')!;
      const idToken = await new SignJWT({ email: 'account-fixture@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-chatgpt-account' } })
        .setProtectedHeader({ alg: 'RS256', kid: 'moodcode-fixture' }).setIssuer('https://auth.openai.com').setAudience(client)
        .setSubject('fixture-subject').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
      return Response.json({ access_token: 'moodcode-fixture-access-initial', refresh_token: 'moodcode-fixture-refresh-initial', id_token: idToken,
        token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access' });
    }
    throw new Error('Unsupported account fixture request.');
  };
  return { fetch: transport, openExternal: async address => {
    const pending = new URL(address);
    if (pending.origin !== 'https://auth.openai.com' || pending.pathname !== '/oauth/authorize' || pending.searchParams.get('client_id') !== 'app_EMoamEEZ73f0CkXaXp7hrann') throw new Error('Invalid fixture authorize URL.');
    const callback = new URL(pending.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: pending.searchParams.get('state')!, code: 'moodcode-fixture-code' }).toString();
    const result = await fetch(callback, { signal: AbortSignal.timeout(5_000) });
    if (result.status !== 200) throw new Error('Fixture callback failed.');
  } };
}
