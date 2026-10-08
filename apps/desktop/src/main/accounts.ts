import { randomUUID } from 'node:crypto';
import type { CredentialStorage } from './settings.js';
import type { DesktopAccount, DesktopAccountAction, DesktopAccountView } from '../shared/account-protocol.js';
import { AccountError, CHATGPT_API, ChatGPTAuth, accountFail, type AccountRegistration, type AccountTokens, type ChatGPTAuthOptions } from './account-auth.js';
import { AccountVault } from './account-vault.js';

interface SavedAccount extends AccountRegistration {
  id: string; state: DesktopAccount['state']; tokens?: AccountTokens;
}
interface SavedAccounts { schemaVersion: 1; hostId: string; accounts: SavedAccount[]; activeAccountId?: string }
export interface PrivateAccountCredential { readonly apiKey: string; readonly accountId: string; readonly baseURL: typeof CHATGPT_API; readonly models: readonly { id: string; displayName: string }[] }
export interface DesktopAccountsOptions extends ChatGPTAuthOptions {
  directory: string; safeStorage: CredentialStorage;
  assertIdle?(): Promise<void>;
  onChange?(view: DesktopAccountView): void;
}
function validString(value: unknown, max = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function parseSaved(value: unknown): SavedAccounts {
  const data = value as SavedAccounts;
  if (!data || data.schemaVersion !== 1 || !validString(data.hostId) || !/^urn:uuid:[a-f0-9-]{36}$/u.test(data.hostId)
    || !Array.isArray(data.accounts) || data.accounts.length > 16 || Object.keys(data).some(field => !['schemaVersion', 'hostId', 'accounts', 'activeAccountId'].includes(field))) accountFail('ACCOUNT_STORAGE_INVALID', 'The saved account record is invalid.');
  const ids = new Set<string>();
  for (const account of data.accounts) {
    if (!account || !validString(account.id, 36) || ids.has(account.id) || !validString(account.clientId) || account.clientId === 'dynamic_agent_client'
      || !validString(account.label, 256) || (account.subject !== undefined && !validString(account.subject)) || !['connected', 'signed-out', 'expired', 'failed'].includes(account.state)
      || Object.keys(account).some(field => !['id', 'clientId', 'subject', 'label', 'state', 'tokens'].includes(field))) accountFail('ACCOUNT_STORAGE_INVALID', 'A saved account registration is invalid.');
    ids.add(account.id);
    const tokens = account.tokens;
    if (tokens && (!validString(account.subject) || !validString(tokens.accessToken, 16_384) || !validString(tokens.idToken, 65_536)
      || (tokens.refreshToken !== undefined && !validString(tokens.refreshToken, 16_384)) || !Number.isFinite(tokens.expiresAt)
      || !Array.isArray(tokens.scopes) || tokens.scopes.length > 32 || tokens.scopes.some(scope => !validString(scope, 128))
      || Object.keys(tokens).some(field => !['accessToken', 'refreshToken', 'idToken', 'expiresAt', 'scopes'].includes(field)))) accountFail('ACCOUNT_STORAGE_INVALID', 'A saved account session is invalid.');
    if (account.state === 'connected' && !tokens) accountFail('ACCOUNT_STORAGE_INVALID', 'A saved account session is missing.');
  }
  if (data.activeAccountId !== undefined && !ids.has(data.activeAccountId)) accountFail('ACCOUNT_STORAGE_INVALID', 'The active account registration is invalid.');
  return data;
}

/** Main owns accounts. The worker receives only the selected, fresh bearer credential. */
export class DesktopAccounts {
  readonly #vault: AccountVault;
  readonly #auth: ChatGPTAuth;
  readonly #now: () => number;
  #saved: SavedAccounts = { schemaVersion: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
  #loaded = false;
  #operation: Promise<unknown> = Promise.resolve();
  #pending?: { owner: string; controller: AbortController };
  #error?: DesktopAccountView['error'];
  #revision = 0;
  #models = new Map<string, { id: string; displayName: string }[]>();
  #credential?: PrivateAccountCredential;
  #quarantined = new Set<string>();
  constructor(readonly options: DesktopAccountsOptions) {
    this.#vault = new AccountVault(options.directory, options.safeStorage);
    this.#auth = new ChatGPTAuth(options); this.#now = options.now ?? Date.now;
  }
  async #load(): Promise<void> {
    if (this.#loaded) return;
    const saved = await this.#vault.load();
    if (saved !== undefined) this.#saved = parseSaved(saved);
    const uncertain = await this.#vault.pendingRefresh();
    if (uncertain) {
      this.#quarantined.add(uncertain);
      const account = this.#saved.accounts.find(item => item.id === uncertain);
      if (account) { account.state = 'failed'; delete account.tokens; }
      this.#error = { code: 'ACCOUNT_REAUTH_REQUIRED', message: 'An earlier token renewal did not confirm persistence. Sign in again; it will not be replayed.' };
    }
    this.#loaded = true;
  }
  #view(): DesktopAccountView {
    return { accounts: this.#saved.accounts.map(account => ({ id: account.id, providerId: 'chatgpt', label: account.label,
      state: this.#quarantined.has(account.id) ? 'failed' : account.state === 'connected' && account.tokens && account.tokens.expiresAt <= this.#now() ? 'expired' : account.state,
      sharing: account.state === 'connected' && !!account.tokens?.scopes.includes('chatgpt.tokens.use.direct'), ...(account.tokens ? { expiresAt: account.tokens.expiresAt } : {}) })),
      ...(this.#saved.activeAccountId ? { activeAccountId: this.#saved.activeAccountId } : {}), pending: !!this.#pending,
      secureStorage: this.#vault.available() ? 'available' : 'unavailable', models: structuredClone(this.#models.get(this.#saved.activeAccountId ?? '') ?? []), revision: this.#revision,
      ...(this.#error ? { error: { ...this.#error } } : {}) };
  }
  async getView(): Promise<DesktopAccountView> { await this.#load(); return this.#view(); }
  #changed(): void { this.#revision += 1; this.options.onChange?.(this.#view()); }
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation); this.#operation = result.then(() => undefined, () => undefined); return result;
  }
  #account(id: string | undefined): SavedAccount {
    const account = this.#saved.accounts.find(item => item.id === id);
    if (!account) accountFail('ACCOUNT_NOT_FOUND', 'Select a saved account.');
    return account;
  }
  cancelOwner(owner: string): void { if (this.#pending?.owner === owner) this.#pending.controller.abort(); }
  async close(): Promise<void> { this.#pending?.controller.abort(); await this.#operation; this.#credential = undefined; }
  /** Non-enumerable bearer: do not send this object or its properties to renderer IPC. */
  getCredential(): PrivateAccountCredential | undefined {
    if (!this.#credential || this.#pending) return undefined;
    const account = this.#account(this.#credential.accountId);
    if (this.#quarantined.has(account.id) || account.state !== 'connected' || !account.tokens || account.tokens.expiresAt <= this.#now()) return undefined;
    return this.#credential;
  }
  async resolveCredential(): Promise<PrivateAccountCredential | undefined> {
    return this.#exclusive(async () => {
      await this.#load(); this.#credential = undefined;
      if (!this.#saved.activeAccountId) return undefined;
      const account = this.#account(this.#saved.activeAccountId);
      if (this.#quarantined.has(account.id) || !account.tokens || !['connected', 'expired'].includes(account.state) || !account.tokens.scopes.includes('chatgpt.tokens.use.direct')) return undefined;
      await this.#vault.lease(async () => {
        if (account.tokens!.expiresAt <= this.#now() + 60_000) await this.#refresh(account, new AbortController().signal);
        if (!this.#models.has(account.id)) this.#models.set(account.id, await this.#auth.models(account.tokens!, new AbortController().signal));
      });
      const credential = { accountId: account.id, baseURL: CHATGPT_API, models: Object.freeze(structuredClone(this.#models.get(account.id) ?? [])) } as PrivateAccountCredential;
      Object.defineProperty(credential, 'apiKey', { value: account.tokens!.accessToken, enumerable: false });
      this.#credential = Object.freeze(credential); return this.#credential;
    });
  }
  async #refresh(account: SavedAccount, signal: AbortSignal): Promise<void> {
    if (this.#quarantined.has(account.id) || !account.tokens) accountFail('ACCOUNT_REAUTH_REQUIRED', 'This account needs a new sign-in.');
    await this.#vault.beginRefresh(account.id);
    try {
      const tokens = await this.#auth.refresh(account, account.tokens, signal);
      const next = structuredClone(this.#saved);
      Object.assign(next.accounts.find(item => item.id === account.id)!, { tokens, state: 'connected' });
      try { await this.#vault.save(next); }
      catch (error) {
        // The rotating grant may already be consumed. Never retry the old token or enable an unpersisted replacement.
        this.#quarantined.add(account.id); delete account.tokens; account.state = 'failed'; this.#models.delete(account.id);
        throw error;
      }
      Object.assign(account, { tokens, state: 'connected' }); this.#models.delete(account.id); this.#quarantined.delete(account.id);
      await this.#vault.finishRefresh(account.id);
    } catch (error) {
      if (error instanceof AccountError && error.code === 'ACCOUNT_REAUTH_REQUIRED') {
        delete account.tokens; account.state = 'expired'; await this.#vault.save(this.#saved);
        await this.#vault.finishRefresh(account.id);
      } else {
        this.#quarantined.add(account.id); delete account.tokens; account.state = 'failed'; this.#models.delete(account.id);
        // A failed request may have consumed a rotating grant. Explicit sign-in is the recovery path.
        await this.#vault.save(this.#saved).then(() => this.#vault.finishRefresh(account.id)).catch(() => undefined);
      }
      throw error;
    }
  }
  action(input: DesktopAccountAction, owner: string): Promise<DesktopAccountView> {
    if (!input || typeof input !== 'object') return Promise.reject(new AccountError('ACCOUNT_ACTION_INVALID', 'The account action is invalid.'));
    const fields: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(input);
    if ((Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      || Reflect.ownKeys(input).some(field => typeof field !== 'string' || !['action', 'accountId'].includes(field))
      || Object.values(fields).some(field => !field.enumerable || !('value' in field))
      || typeof fields.action?.value !== 'string' || !['sign-in', 'select', 'refresh', 'sign-out', 'forget', 'cancel'].includes(fields.action.value)
      || (fields.accountId && !validString(fields.accountId.value, 36)) || !validString(owner, 256)) {
      return Promise.reject(new AccountError('ACCOUNT_ACTION_INVALID', 'The account action is invalid.'));
    }
    if (input.action === 'cancel') { this.cancelOwner(owner); return this.getView(); }
    if (this.#pending) return Promise.reject(new AccountError('ACCOUNT_BUSY', 'An account operation is already running.'));
    return this.#exclusive(async () => {
      await this.#load(); await this.options.assertIdle?.();
      this.#credential = undefined; this.#error = undefined;
      const pending = { owner, controller: new AbortController() }; this.#pending = pending; this.#changed();
      try {
        await this.#vault.lease(async () => {
          if (input.action === 'sign-in') {
            if (!this.#vault.available()) accountFail('ACCOUNT_SECURE_STORAGE_REQUIRED', 'Unlock the operating system credential storage before signing in.');
            let account = input.accountId ? this.#account(input.accountId) : undefined;
            if (!account && this.#saved.accounts.length >= 16) accountFail('ACCOUNT_LIMIT', 'Remove a saved account before adding another.');
            await this.#vault.save(this.#saved); // Persist the installation ID before opening a browser.
            const authenticated = await this.#auth.signIn(this.#saved.hostId, account ? { ...account, ...(account.tokens ? { idToken: account.tokens.idToken } : {}) } : undefined,
              pending.controller.signal, async clientId => {
                if (!account) { account = { id: randomUUID(), clientId, label: `ChatGPT account ${this.#saved.accounts.length + 1}`, state: 'signed-out' }; this.#saved.accounts.push(account); }
                await this.#vault.save(this.#saved);
              });
            await this.options.assertIdle?.();
            const next = structuredClone(this.#saved);
            Object.assign(next.accounts.find(item => item.id === account!.id)!, authenticated, { state: 'connected' });
            next.activeAccountId = account!.id;
            await this.#vault.save(next); this.#saved = next; this.#quarantined.delete(account!.id);
            await this.#vault.finishRefresh(account!.id);
            if (authenticated.tokens.scopes.includes('chatgpt.tokens.use.direct')) this.#models.set(account!.id, await this.#auth.models(authenticated.tokens, pending.controller.signal));
          } else {
            const account = this.#account(input.accountId ?? this.#saved.activeAccountId);
            if (input.action === 'select') {
              if (this.#quarantined.has(account.id) || !account.tokens || !['connected', 'expired'].includes(account.state)) accountFail('ACCOUNT_REAUTH_REQUIRED', 'Sign in again before selecting this account.');
              if (account.tokens.expiresAt <= this.#now() + 60_000) await this.#refresh(account, pending.controller.signal);
              const models = account.tokens!.scopes.includes('chatgpt.tokens.use.direct') ? await this.#auth.models(account.tokens!, pending.controller.signal) : [];
              await this.options.assertIdle?.(); this.#saved.activeAccountId = account.id; this.#models.set(account.id, models); await this.#vault.save(this.#saved);
            } else if (input.action === 'refresh') {
              await this.#refresh(account, pending.controller.signal);
              if (account.tokens!.scopes.includes('chatgpt.tokens.use.direct')) this.#models.set(account.id, await this.#auth.models(account.tokens!, pending.controller.signal));
            } else if (input.action === 'sign-out' || input.action === 'forget') {
              const tokens = account.tokens;
              const revoked = !tokens || await this.#auth.revoke(account, tokens, pending.controller.signal);
              delete account.tokens; account.state = 'signed-out'; this.#models.delete(account.id); this.#quarantined.delete(account.id);
              if (this.#saved.activeAccountId === account.id) delete this.#saved.activeAccountId;
              await this.#vault.save(this.#saved);
              await this.#vault.finishRefresh(account.id);
              if (!revoked) this.#error = { code: 'ACCOUNT_REVOCATION_UNCONFIRMED', message: 'Signed out locally. Remote revocation was not confirmed; disconnect Moodcode in ChatGPT settings.' };
              if (input.action === 'forget') { this.#saved.accounts = this.#saved.accounts.filter(item => item.id !== account.id); await this.#vault.save(this.#saved); }
            } else accountFail('ACCOUNT_ACTION_INVALID', 'The account action is invalid.');
          }
        });
      } catch (error) {
        const safe = error instanceof AccountError ? error : new AccountError('ACCOUNT_OPERATION_FAILED', 'The account operation failed. Retry or sign in again.');
        this.#error = { code: safe.code, message: safe.message };
        throw safe;
      } finally { if (this.#pending === pending) this.#pending = undefined; this.#changed(); }
      return this.#view();
    });
  }
}
