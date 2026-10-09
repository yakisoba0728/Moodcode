import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

const ISSUER = 'https://auth.openai.com';
export const CHATGPT_API = 'https://chatgpt.com/backend-api/codex';
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_CATALOG_VERSION = '0.162.0';
const REDIRECT = 'http://localhost:1455/auth/callback';
const SCOPES = 'openid profile email offline_access';

export class AccountError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AccountError'; }
}
export function accountFail(code: string, message: string): never { throw new AccountError(code, message); }
export interface AccountRegistration { clientId: string; subject?: string; label: string; idToken?: string; chatgptAccountId?: string; authKind?: 'codex-oauth' | 'legacy-siwc' }
export interface AccountTokens {
  accessToken: string; refreshToken?: string; idToken: string; expiresAt: number; scopes: string[]; chatgptAccountId?: string;
}
export interface AuthenticatedAccount {
  clientId: string; subject: string; label: string; tokens: AccountTokens; authKind: 'codex-oauth';
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
  const expiresIn = data.expires_in === undefined ? 3600 : data.expires_in;
  if (!opaque(data.access_token) || (data.refresh_token !== undefined && !opaque(data.refresh_token))
    || (data.id_token !== undefined && !opaque(data.id_token, 65_536)) || (data.token_type !== undefined && data.token_type !== 'Bearer')
    || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 31 * 86_400
    || (data.scope !== undefined && (typeof data.scope !== 'string' || data.scope.length > 4_096))) {
    accountFail('ACCOUNT_TOKEN_INVALID', 'The sign-in response contained invalid credentials.');
  }
  const idToken = data.id_token as string | undefined ?? previous?.idToken;
  if (!idToken) accountFail('ACCOUNT_IDENTITY_REQUIRED', 'The sign-in response did not include verified identity.');
  const scopes = typeof data.scope === 'string' ? data.scope.split(/ +/u).filter(Boolean) : previous?.scopes ?? [];
  if (scopes.length > 32 || scopes.some(scope => !opaque(scope, 128))) accountFail('ACCOUNT_TOKEN_INVALID', 'The granted permissions are invalid.');
  return { accessToken: data.access_token, refreshToken: data.refresh_token as string | undefined ?? previous?.refreshToken,
    idToken, expiresAt: now + expiresIn * 1_000, scopes, ...(previous?.chatgptAccountId ? { chatgptAccountId: previous.chatgptAccountId } : {}) };
}

/** Codex browser PKCE; credentials and authorization URLs stay in main. */
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

  async #discovery(signal: AbortSignal): Promise<{ jwks: string; revoke?: string }> {
    const data = await this.#request(`${ISSUER}/.well-known/openid-configuration`, signal);
    if (data.issuer !== ISSUER) accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration is invalid.');
    const endpoint = (value: unknown): string => {
      if (typeof value !== 'string') accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration is invalid.');
      let url: URL;
      try { url = new URL(value); } catch { accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration is invalid.'); }
      if (url.origin !== ISSUER || url.username || url.password || url.hash || url.search) accountFail('ACCOUNT_DISCOVERY_INVALID', 'The account identity configuration is invalid.');
      return value;
    };
    return { jwks: endpoint(data.jwks_uri), ...(data.revocation_endpoint ? { revoke: endpoint(data.revocation_endpoint) } : {}) };
  }

  async #identity(idToken: string, jwksUrl: string, signal: AbortSignal): Promise<{ subject: string; label: string; chatgptAccountId: string }> {
    const keys = await this.#request(jwksUrl, signal);
    if (!Array.isArray(keys.keys) || keys.keys.length > 32) accountFail('ACCOUNT_IDENTITY_INVALID', 'The account identity could not be verified.');
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys as unknown as JSONWebKeySet), {
        issuer: ISSUER, audience: CHATGPT_CLIENT_ID, requiredClaims: ['sub', 'exp', 'iat'],
        algorithms: ['RS256', 'ES256'], clockTolerance: 5, currentDate: new Date(this.#now()),
      });
      if (!opaque(payload.sub, 512)) throw new Error();
      const auth = payload['https://api.openai.com/auth'];
      const nested = auth !== null && typeof auth === 'object' && !Array.isArray(auth) ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
      const headerId = nested ?? payload.chatgpt_account_id;
      if (typeof headerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(headerId)
        || (nested !== undefined && payload.chatgpt_account_id !== undefined && nested !== payload.chatgpt_account_id)) {
        accountFail('ACCOUNT_HEADER_ID_REQUIRED', 'The verified identity did not include a usable Codex account. Sign in again.');
      }
      if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'The account operation was cancelled.');
      const name = typeof payload.email === 'string' ? payload.email : typeof payload.name === 'string' ? payload.name : 'ChatGPT account';
      if (name.length > 256 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error();
      return { subject: payload.sub, label: name, chatgptAccountId: headerId };
    } catch (error) { if (error instanceof AccountError) throw error; accountFail('ACCOUNT_IDENTITY_INVALID', 'The account identity could not be verified.'); }
  }

  async signIn(_hostId: string, registration: AccountRegistration | undefined, signal: AbortSignal,
    onRegistration: (clientId: string) => Promise<void>): Promise<AuthenticatedAccount> {
    if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'Sign-in was cancelled.');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    let resolveCallback!: (value: string) => void, rejectCallback!: (error: AccountError) => void;
    let rejectInterrupted!: (error: AccountError) => void;
    const callback = new Promise<string>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    void callback.catch(() => undefined); void interrupted.catch(() => undefined);
    let consumed = false;
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Security-Policy', "default-src 'none'");
      if (consumed || request.method !== 'GET' || !request.url || request.url.length > 16_384
        || !['localhost:1455', '127.0.0.1:1455'].includes(request.headers.host ?? '')) {
        response.writeHead(400).end('Invalid sign-in callback.'); return;
      }
      let url: URL;
      try { url = new URL(request.url, REDIRECT); } catch { response.writeHead(400).end('Invalid sign-in callback.'); return; }
      if (url.origin !== new URL(REDIRECT).origin || url.pathname !== '/auth/callback'
        || url.searchParams.getAll('state').length !== 1 || !same(url.searchParams.get('state') ?? '', state)) {
        response.writeHead(400).end('Invalid sign-in state.'); return;
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') && url.searchParams.getAll('error').length === 1 && !url.searchParams.has('code')) {
        consumed = true; response.writeHead(200).end('Sign-in declined. Return to Moodcode.');
        rejectCallback(new AccountError('ACCOUNT_ACCESS_DENIED', 'Sign-in was declined.')); return;
      }
      consumed = true;
      if (url.searchParams.has('error') || url.searchParams.getAll('code').length !== 1 || !opaque(code)
        || url.searchParams.getAll('client_id').length > 1
        || (url.searchParams.has('client_id') && url.searchParams.get('client_id') !== CHATGPT_CLIENT_ID)) {
        response.writeHead(400).end('Invalid sign-in callback.');
        rejectCallback(new AccountError('ACCOUNT_CALLBACK_INVALID', 'The sign-in callback was invalid.')); return;
      }
      response.writeHead(200).end('Sign-in received. Return to Moodcode.'); resolveCallback(code);
    });
    server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.maxConnections = 4;
    const interrupt = (error: AccountError) => { rejectCallback(error); rejectInterrupted(error); };
    const cancel = () => interrupt(new AccountError('ACCOUNT_CANCELLED', 'Sign-in was cancelled.'));
    signal.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', error => reject(new AccountError((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? 'ACCOUNT_CALLBACK_PORT_IN_USE' : 'ACCOUNT_CALLBACK_FAILED',
        'The local sign-in port 1455 is unavailable. Finish other Codex sign-ins and retry.')));
        server.listen(1455, '127.0.0.1', resolve);
      });
      if (signal.aborted) cancel();
      timer = setTimeout(() => interrupt(new AccountError('ACCOUNT_CALLBACK_TIMEOUT', 'Sign-in expired. Start a new sign-in.')), this.options.callbackTimeoutMs ?? 180_000);
      const authorize = new URL(`${ISSUER}/oauth/authorize`);
      authorize.search = new URLSearchParams({ client_id: CHATGPT_CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT,
        scope: SCOPES, state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'moodcode' }).toString();
      if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'Sign-in was cancelled.');
      const opened = this.options.openExternal(authorize.href).catch(() => accountFail('ACCOUNT_BROWSER_FAILED', 'The system browser could not open sign-in.'));
      await Promise.race([opened, interrupted]);
      const code = await callback;
      if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'Sign-in was cancelled.');
      await onRegistration(CHATGPT_CLIENT_ID);
      const data = await this.#request(`${ISSUER}/oauth/token`, signal, new URLSearchParams({ grant_type: 'authorization_code', client_id: CHATGPT_CLIENT_ID,
        code, code_verifier: verifier, redirect_uri: REDIRECT }));
      const tokens = parseTokens(data, this.#now());
      const discovery = await this.#discovery(signal);
      const identity = await this.#identity(tokens.idToken, discovery.jwks, signal);
      if (signal.aborted) accountFail('ACCOUNT_CANCELLED', 'Sign-in was cancelled.');
      if (registration?.authKind === 'codex-oauth' && ((registration.subject && registration.subject !== identity.subject)
        || (registration.chatgptAccountId && registration.chatgptAccountId !== identity.chatgptAccountId)))
        accountFail('ACCOUNT_IDENTITY_CHANGED', 'The signed-in identity did not match the selected account.');
      return { clientId: CHATGPT_CLIENT_ID, subject: identity.subject, label: identity.label, authKind: 'codex-oauth',
        tokens: { ...tokens, chatgptAccountId: identity.chatgptAccountId } };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); consumed = true;
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  async refresh(registration: AccountRegistration, previous: AccountTokens, signal: AbortSignal): Promise<AccountTokens> {
    if (registration.authKind !== 'codex-oauth' || registration.clientId !== CHATGPT_CLIENT_ID || !previous.refreshToken || !previous.chatgptAccountId)
      accountFail('ACCOUNT_REAUTH_REQUIRED', 'This account needs a new sign-in.');
    const data = await this.#request(`${ISSUER}/oauth/token`, signal, new URLSearchParams({ grant_type: 'refresh_token', client_id: CHATGPT_CLIENT_ID,
      refresh_token: previous.refreshToken }));
    const tokens = parseTokens(data, this.#now(), previous);
    if (data.id_token !== undefined) {
      const discovery = await this.#discovery(signal);
      const identity = await this.#identity(tokens.idToken, discovery.jwks, signal);
      if (identity.subject !== registration.subject || identity.chatgptAccountId !== previous.chatgptAccountId)
        accountFail('ACCOUNT_IDENTITY_CHANGED', 'The renewed identity did not match this account.');
    }
    return tokens;
  }

  async revoke(registration: AccountRegistration, tokens: AccountTokens, signal: AbortSignal): Promise<boolean> {
    if (!tokens.refreshToken) return true;
    if (registration.authKind !== 'codex-oauth' || registration.clientId !== CHATGPT_CLIENT_ID) return false;
    try {
      const discovery = await this.#discovery(signal);
      if (!discovery.revoke) return false;
      const response = await this.#fetch(discovery.revoke, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: 'refresh_token', client_id: registration.clientId }) });
      return response.status === 200;
    } catch { return false; }
  }

  async models(tokens: AccountTokens, signal: AbortSignal): Promise<{ id: string; displayName: string }[]> {
    if (!tokens.chatgptAccountId) accountFail('ACCOUNT_REAUTH_REQUIRED', 'This account needs a new sign-in.');
    let response: Response;
    try { response = await this.#fetch(`${CHATGPT_API}/models?client_version=${CODEX_CATALOG_VERSION}`, { headers: { Authorization: `Bearer ${tokens.accessToken}`,
      'ChatGPT-Account-Id': tokens.chatgptAccountId, originator: 'moodcode', 'User-Agent': 'Moodcode/0.1.0' }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }); }
    catch { accountFail('ACCOUNT_NETWORK', 'The account model catalog could not be reached. Try again.'); }
    const data = await boundedJson(response);
    if (!response.ok) accountFail(response.status === 401 ? 'ACCOUNT_REAUTH_REQUIRED' : 'ACCOUNT_MODELS_FAILED', response.status === 401 ? 'This account needs a new sign-in.' : 'The account model catalog could not be loaded.');
    if (!Array.isArray(data.models) || data.models.length > 512) accountFail('ACCOUNT_MODELS_INVALID', 'The account model catalog is invalid.');
    const ids = new Set<string>(), secrets = [tokens.accessToken, tokens.refreshToken, tokens.idToken, tokens.chatgptAccountId].filter((value): value is string => !!value);
    return data.models.filter(model => model?.visibility === 'list').map(model => {
      if (!opaque(model.slug, 512) || typeof model.display_name !== 'string' || model.display_name.length > 256 || /[\u0000-\u001f\u007f]/u.test(model.display_name)) accountFail('ACCOUNT_MODELS_INVALID', 'The account model catalog is invalid.');
      if (!model.display_name.trim() || ids.has(model.slug) || secrets.some(secret => model.slug.includes(secret) || model.display_name.includes(secret))) accountFail('ACCOUNT_MODELS_INVALID', 'The account model catalog is invalid.');
      ids.add(model.slug);
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
