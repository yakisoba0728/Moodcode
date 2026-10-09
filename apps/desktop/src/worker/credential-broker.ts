import { randomUUID } from 'node:crypto';
import { EngineError } from '@moodcode/contracts';
import type { CodexCredential, WorkerCredentialRequest, WorkerCredentialResponse } from './protocol.js';

export const CREDENTIAL_LIMITS = Object.freeze({ pending: 64, timeoutMs: 120_000, retainedSecrets: 1024 });
const cancelled = () => new EngineError('PROVIDER_CANCELLED', 'Provider credential request cancelled.');
const unavailable = () => new EngineError('ACCOUNT_REAUTH_REQUIRED', 'The selected Codex account credential is unavailable. Refresh the account or sign in again.');
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && descriptors[key]?.enumerable && 'value' in descriptors[key]!);
}
export function checkedCredential(value: unknown): CodexCredential {
  if (!fields(value, ['accessToken', 'accountId', 'secrets'])
    || typeof value.accessToken !== 'string' || !/^[\x21-\x7e]{1,32768}$/.test(value.accessToken)
    || typeof value.accountId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value.accountId)
    || !Array.isArray(value.secrets) || value.secrets.length > 16
    || value.secrets.some(secret => typeof secret !== 'string' || !/^[\x21-\x7e]{1,65536}$/.test(secret))) throw unavailable();
  const secrets = [...new Set([value.accessToken, value.accountId, ...value.secrets as string[]])];
  if (secrets.length > 16 || secrets.reduce((bytes, secret) => bytes + Buffer.byteLength(secret), 0) > 1_000_000) throw unavailable();
  return Object.freeze({ accessToken: value.accessToken, accountId: value.accountId, secrets: Object.freeze(secrets) });
}
export function retainSecrets(previous: readonly string[], credential: CodexCredential): string[] {
  const next = [...new Set([...previous, credential.accessToken, credential.accountId, ...credential.secrets])];
  if (next.length > CREDENTIAL_LIMITS.retainedSecrets) throw unavailable();
  return next;
}

/** Main shares one rotation, while each cancelled turn releases only its own waiter. */
export class MainCredentialBroker {
  #pending = new Map<string, { controller: AbortController; ids: Set<string> }>();
  #flight?: { controller: AbortController; ids: Set<string> };
  #closed = false;
  constructor(readonly options: { resolve(signal: AbortSignal): Promise<CodexCredential>; valid(): boolean; post(response: WorkerCredentialResponse): void }) {}
  receive(value: unknown): boolean {
    if (!value || typeof value !== 'object' || !['codex-credential', 'codex-credential-cancel'].includes(String((value as { type?: unknown }).type))) return false;
    if (!fields(value, ['type', 'id']) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) return true;
    const id = value.id;
    if (value.type === 'codex-credential-cancel') {
      const flight = this.#pending.get(id); this.#pending.delete(id); flight?.ids.delete(id);
      if (flight && !flight.ids.size) { flight.controller.abort(); if (this.#flight === flight) this.#flight = undefined; }
      return true;
    }
    if (this.#pending.has(id)) return true;
    if (this.#closed || !this.options.valid() || this.#pending.size >= CREDENTIAL_LIMITS.pending) { this.#failure(id); return true; }
    let flight = this.#flight;
    if (!flight) {
      flight = { controller: new AbortController(), ids: new Set() }; this.#flight = flight;
      const current = flight;
      void Promise.resolve().then(() => this.options.resolve(current.controller.signal)).then(credential => {
        const checked = checkedCredential(credential);
        if (this.#closed || current.controller.signal.aborted || !this.options.valid()) throw cancelled();
        for (const pending of this.#release(current)) this.#post({ type: 'codex-credential-result', id: pending, ok: true, credential: checked });
      }).catch(() => { for (const pending of this.#release(current)) this.#failure(pending); });
    }
    flight.ids.add(id); this.#pending.set(id, flight); return true;
  }
  #post(response: WorkerCredentialResponse): void { try { this.options.post(response); } catch { this.close(); } }
  #release(flight: { controller: AbortController; ids: Set<string> }): string[] {
    const ids = [...flight.ids]; flight.ids.clear();
    for (const id of ids) this.#pending.delete(id);
    if (this.#flight === flight) this.#flight = undefined;
    return ids;
  }
  #failure(id: string): void { const error = unavailable(); this.#post({ type: 'codex-credential-result', id, ok: false, error: { code: error.code, message: error.message } }); }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    for (const flight of new Set(this.#pending.values())) { flight.controller.abort(); flight.ids.clear(); }
    for (const id of this.#pending.keys()) this.#failure(id);
    this.#pending.clear(); this.#flight = undefined;
  }
}

/** Private replies bypass public engine results; no credential survives cancel/close. */
export class WorkerCredentialClient {
  #pending = new Map<string, { finish(credential?: CodexCredential, error?: Error): void }>();
  #closed = false;
  constructor(readonly post: (request: WorkerCredentialRequest) => void, readonly timeoutMs: number = CREDENTIAL_LIMITS.timeoutMs) {}
  request(signal: AbortSignal): Promise<CodexCredential> {
    if (signal.aborted || this.#closed) return Promise.reject(cancelled());
    if (this.#pending.size >= CREDENTIAL_LIMITS.pending) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cancel = (): void => { finish(undefined, cancelled()); try { this.post({ type: 'codex-credential-cancel', id }); } catch { /* Parent may already be gone. */ } };
      const timer = setTimeout(cancel, Math.max(1, Math.min(CREDENTIAL_LIMITS.timeoutMs, this.timeoutMs)));
      const finish = (credential?: CodexCredential, error?: Error): void => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(credential!);
      };
      this.#pending.set(id, { finish }); signal.addEventListener('abort', cancel, { once: true });
      try { this.post({ type: 'codex-credential', id }); } catch { finish(undefined, unavailable()); }
    });
  }
  receive(value: unknown): boolean {
    if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'codex-credential-result') return false;
    if (!fields(value, ['type', 'id', 'ok', 'credential', 'error']) || typeof value.id !== 'string') return true;
    const pending = this.#pending.get(value.id); if (!pending) return true;
    try { if (value.ok !== true) throw unavailable(); pending.finish(checkedCredential(value.credential)); }
    catch { pending.finish(undefined, unavailable()); }
    return true;
  }
  close(): void {
    if (this.#closed) return; this.#closed = true;
    for (const [id, pending] of this.#pending) {
      pending.finish(undefined, cancelled());
      try { this.post({ type: 'codex-credential-cancel', id }); } catch { /* Parent may already be gone. */ }
    }
  }
}
