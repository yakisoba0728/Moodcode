import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

const ISSUER = 'https://auth.openai.com';
export const CHATGPT_API = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export class AccountError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AccountError'; }
}
export function accountFail(code: string, message: string): never { throw new AccountError(code, message); }
export interface AccountRegistration { clientId: string; subject?: string; label: string; idToken?: string }
export interface AccountTokens {
  accessToken: string; refreshToken?: string; idToken: string; expiresAt: number; scopes: string[];
}
export interface AuthenticatedAccount {
  clientId: string; subject: string; label: string; tokens: AccountTokens;
}
export interface ChatGPTAuthOptions {
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  callbackTimeoutMs?: number;
}
function opaque(value: unknown, max = 16_384): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/u.test(value);
}
function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function parseTokens(data: Record<string, unknown>, now: number, previous?: AccountTokens): AccountTokens {
  if (!opaque(data.access_token) || (data.refresh_token !== undefined && !opaque(data.refresh_token))
    || (data.id_token !== undefined && !opaque(data.id_token, 65_536)) || data.token_type !== 'Bearer'
    || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86_400
    || (data.scope !== undefined && (typeof data.scope !== 'string' || data.scope.length > 4_096))) {
    accountFail('ACCOUNT_TOKEN_INVALID', 'The sign-in response contained invalid credentials.');
  }
  const idToken = data.id_token as string | undefined ?? previous?.idToken;
  if (!idToken) accountFail('ACCOUNT_IDENTITY_REQUIRED', 'The sign-in response did not include verified identity.');
  const scopes = typeof data.scope === 'string' ? data.scope.split(/ +/u).filter(Boolean) : previous?.scopes ?? [];
  if (scopes.length > 32 || scopes.some(scope => !opaque(scope, 128))) accountFail('ACCOUNT_TOKEN_INVALID', 'The granted permissions are invalid.');
  return { accessToken: data.access_token, refreshToken: data.refresh_token as string | undefined ?? previous?.refreshToken,
    idToken, expiresAt: now + data.expires_in * 1_000, scopes };
}

/** Public OSS SIWC contract. URLs are fixed; authorize URLs containing identity hints are never logged. */
export class ChatGPTAuth {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  constructor(readonly options: ChatGPTAuthOptions) { this.#fetch = options.fetch ?? fetch; this.#now = options.now ?? Date.now; }

  async #request(url: string, signal: AbortSignal, form?: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(url, { method: form ? 'POST' : 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: 'error', ...(form ? { body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}) });
    } catch {
      accountFail(signal.aborted ? 'ACCOUNT_CANCELLED' : 'ACCOUNT_NETWORK', signal.aborted ? 'Sign-in was cancelled.' : 'The account service could not be reached. Try again.');
    }
    const data = await boundedJson(response);
    if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'The account operation was cancelled.');
    if (!response.ok) {
      if (data.error === 'invalid_grant' || response.status === 401) accountFail('ACCOUNT_REAUTH_REQUIRED', 'This account needs a new sign-in.');
      accountFail('ACCOUNT_REQUEST_FAILED', 'The account service declined the request. Try again.');
    }
    return data;
  }

  async #discovery(signal: AbortSignal): Promise<{ authorization: string; token: string; jwks: string; revoke?: string }> {
    const data = await this.#request(`${ISSUER}/.well-known/openid-configuration`, signal);
    if (data.issuer !== ISSUER) accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration is invalid.');
    const endpoint = (value: unknown): string => {
      if (typeof value !== 'string') accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration is invalid.');
      let url: URL;
      try { url = new URL(value); } catch { accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration is invalid.'); }
      if (url.origin !== ISSUER || url.username || url.password || url.hash || url.search) accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration is invalid.');
      return value;
    };
    const authorization = endpoint(data.authorization_endpoint), token = endpoint(data.token_endpoint);
    if (authorization !== `${ISSUER}/api/accounts/authorize` || token !== `${ISSUER}/api/accounts/oauth/token`) {
      accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration changed. Update Moodcode before signing in.');
    }
    return { authorization, token, jwks: endpoint(data.jwks_uri), ...(data.revocation_endpoint ? { revoke: endpoint(data.revocation_endpoint) } : {}) };
  }

  async #identity(idToken: string, clientId: string, nonce: string | undefined, jwksUrl: string, signal: AbortSignal): Promise<{ subject: string; label: string }> {
    const keys = await this.#request(jwksUrl, signal);
    if (!Array.isArray(keys.keys) || keys.keys.length > 32) accountFail('ACCOUNT_IDENTITY_INVALID', 'The account identity could not be verified.');
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys as unknown as JSONWebKeySet), {
        issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat', ...(nonce ? ['nonce'] : [])],
        algorithms: ['RS256', 'ES256'], clockTolerance: 5, currentDate: new Date(this.#now()),
      });
      if (!opaque(payload.sub, 512) || (nonce !== undefined && (typeof payload.nonce !== 'string' || !same(payload.nonce, nonce)))) throw new Error();
      if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'The account operation was cancelled.');
      const name = typeof payload.email === 'string' ? payload.email : typeof payload.name === 'string' ? payload.name : 'ChatGPT account';
      if (name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error();
      return { subject: payload.sub, label: name };
    } catch (error) { if (error instanceof AccountError) throw error; accountFail('ACCOUNT_IDENTITY_INVALID', 'The account identity could not be verified.'); }
  }

  async signIn(hostId: string, registration: AccountRegistration | undefined, signal: AbortSignal,
    onRegistration: (clientId: string) => Promise<void>): Promise<AuthenticatedAccount> {
    const discovery = await this.#discovery(signal);
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    let resolveCallback!: (value: { code: string; clientId: string }) => void, rejectCallback!: (error: AccountError) => void;
    const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    // A failed openExternal may occur before callback is awaited.
    void callback.catch(() => undefined);
    let consumed = false, port = 0;
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Security-Policy', "default-src 'none'");
      if (consumed || request.method !== 'GET' || !request.url || request.url.length > 16_384 || request.headers.host !== `127.0.0.1:${port}`) {
        response.writeHead(400).end('Invalid sign-in callback.'); return;
      }
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/auth/callback' || url.searchParams.getAll('state').length !== 1 || !same(url.searchParams.get('state') ?? '', state)) {
        response.writeHead(400).end('Invalid sign-in state.'); return;
      }
      consumed = true;
      if (url.searchParams.has('error')) {
        response.writeHead(200).end('Sign-in declined. Return to Moodcode.');
        rejectCallback(new AccountError('ACCOUNT_ACCESS_DENIED', 'Sign-in permissions were declined.')); return;
      }
      const code = url.searchParams.get('code'), issued = url.searchParams.get('client_id') ?? registration?.clientId;
      if (url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1 || !opaque(code)
        || !opaque(issued, 512) || issued === 'dynamic_agent_client' || (registration && issued !== registration.clientId)) {
        response.writeHead(400).end('Invalid sign-in registration.');
        rejectCallback(new AccountError('ACCOUNT_REGISTRATION_INVALID', 'The sign-in registration did not match this account.')); return;
      }
      response.writeHead(200).end('Sign-in received. Return to Moodcode.');
      resolveCallback({ code, clientId: issued });
    });
    server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.maxConnections = 4;
    const cancel = () => rejectCallback(new AccountError('ACCOUNT_CANCELLED', 'Sign-in was cancelled.'));
    signal.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', () => reject(new AccountError('ACCOUNT_CALLBACK_FAILED', 'The local sign-in listener could not start.'))); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') accountFail('ACCOUNT_CALLBACK_FAILED', 'The local sign-in listener could not start.');
      port = address.port;
      if (signal.aborted) cancel();
      timer = setTimeout(() => rejectCallback(new AccountError('ACCOUNT_CALLBACK_TIMEOUT', 'Sign-in expired. Start a new sign-in.')), this.options.callbackTimeoutMs ?? 180_000);
      const redirect = `http://127.0.0.1:${port}/auth/callback`;
      const authorize = new URL(discovery.authorization);
      authorize.search = new URLSearchParams({ client_id: registration?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
        response_type: 'code', redirect_uri: redirect, scope: SCOPES, resource: CHATGPT_API, state, nonce,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        ...(!registration ? { agent_name_hint: 'Moodcode' } : {}), ...(registration?.idToken ? { id_token_hint: registration.idToken } : {}) }).toString();
      if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'Sign-in was cancelled.');
      try { await this.options.openExternal(authorize.href); } catch { accountFail('ACCOUNT_BROWSER_FAILED', 'The system browser could not open sign-in.'); }
      const result = await callback;
      if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'Sign-in was cancelled.');
      await onRegistration(result.clientId);
      const data = await this.#request(discovery.token, signal, new URLSearchParams({ grant_type: 'authorization_code', client_id: result.clientId,
        code: result.code, code_verifier: verifier, redirect_uri: redirect, resource: CHATGPT_API }));
      const tokens = parseTokens(data, this.#now());
      const identity = await this.#identity(tokens.idToken, result.clientId, nonce, discovery.jwks, signal);
      if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'Sign-in was cancelled.');
      if (registration?.subject && registration.subject !== identity.subject) accountFail('ACCOUNT_IDENTITY_CHANGED', 'The signed-in identity did not match the selected account.');
      return { clientId: result.clientId, ...identity, tokens };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); consumed = true;
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  async refresh(registration: AccountRegistration, previous: AccountTokens, signal: AbortSignal): Promise<AccountTokens> {
    if (!previous.refreshToken) accountFail('ACCOUNT_REAUTH_REQUIRED', 'This account needs a new sign-in.');
    const discovery = await this.#discovery(signal);
    const data = await this.#request(discovery.token, signal, new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.clientId,
      refresh_token: previous.refreshToken, resource: CHATGPT_API }));
    const tokens = parseTokens(data, this.#now(), previous);
    if (!opaque(data.refresh_token)) accountFail('ACCOUNT_TOKEN_INVALID', 'The refreshed session did not include its replacement credential.');
    if (data.id_token !== undefined) {
      const identity = await this.#identity(tokens.idToken, registration.clientId, undefined, discovery.jwks, signal);
      if (identity.subject !== registration.subject) accountFail('ACCOUNT_IDENTITY_CHANGED', 'The renewed identity did not match this account.');
    }
    return tokens;
  }

  async revoke(registration: AccountRegistration, tokens: AccountTokens, signal: AbortSignal): Promise<boolean> {
    if (!tokens.refreshToken) return true;
    try {
      const discovery = await this.#discovery(signal);
      if (!discovery.revoke) return false;
      const response = await this.#fetch(discovery.revoke, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: 'refresh_token', client_id: registration.clientId }) });
      return response.status === 200;
    } catch { return false; }
  }

  async models(tokens: AccountTokens, signal: AbortSignal): Promise<{ id: string; displayName: string }[]> {
    let response: Response;
    try { response = await this.#fetch(`${CHATGPT_API}/models`, { headers: { Authorization: `Bearer ${tokens.accessToken}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }); }
    catch { accountFail('ACCOUNT_NETWORK', 'The account model catalog could not be reached. Try again.'); }
    const data = await boundedJson(response);
    if (!response.ok) accountFail(response.status === 401 ? 'ACCOUNT_REAUTH_REQUIRED' : 'ACCOUNT_MODELS_FAILED', response.status === 401 ? 'This account needs a new sign-in.' : 'The account model catalog could not be loaded.');
    if (!Array.isArray(data.models) || data.models.length > 512) accountFail('ACCOUNT_MODELS_INVALID', 'The account model catalog is invalid.');
    return data.models.filter(model => model?.visibility === 'list').map(model => {
      if (!opaque(model.slug, 512) || typeof model.display_name !== 'string' || model.display_name.length > 256 || /[\u0000-\u001f\u007f]/u.test(model.display_name)) accountFail('ACCOUNT_MODELS_INVALID', 'The account model catalog is invalid.');
      return { id: model.slug as string, displayName: model.display_name as string };
    });
  }
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) accountFail('ACCOUNT_RESPONSE_INVALID', 'The account service returned an invalid response.');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1_048_576) accountFail('ACCOUNT_RESPONSE_LIMIT', 'The account response exceeds its limit.');
      chunks.push(part.value);
    }
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccountError) throw error;
    accountFail('ACCOUNT_RESPONSE_INVALID', 'The account service returned an invalid response.');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
