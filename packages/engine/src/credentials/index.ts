import { inspect } from 'node:util';
import { EngineError } from '@moodcode/contracts';
export interface CredentialReference { id: string; audience: string }
export interface HostCredential { bearerToken: string; expiresAt: number }
export interface CredentialHostCallbacks { resolve(reference: CredentialReference, signal: AbortSignal): Promise<HostCredential>; refresh?(reference: CredentialReference, signal: AbortSignal): Promise<HostCredential> }
function reference(input: CredentialReference): CredentialReference { if (!input || typeof input.id !== 'string' || !/^host:[A-Za-z0-9_.-]{1,128}$/.test(input.id) || typeof input.audience !== 'string' || !input.audience || Buffer.byteLength(input.audience) > 2048 || /[\u0000-\u001f\u007f]/.test(input.audience)) throw new EngineError('INVALID_CREDENTIAL_REFERENCE', 'Credential requires a bounded host reference and exact audience'); return { id: input.id, audience: input.audience }; }
/** Host owns account storage and refresh. This module never reads login files or environment secrets. */
export class CredentialBroker {
  private cached = new Map<string, HostCredential>();
  constructor(private readonly host: CredentialHostCallbacks, private readonly now: () => number = Date.now) {}
  toJSON(): unknown { return { kind: 'CredentialBroker', cachedReferenceCount: this.cached.size }; }
  [inspect.custom](): string { return '[CredentialBroker: secrets hidden]'; }
  clear(input?: CredentialReference): void { if (input) { const ref = reference(input); this.cached.delete(JSON.stringify(ref)); } else this.cached.clear(); }
  async withAuthorization<T>(input: CredentialReference, audience: string, signal: AbortSignal, use: (authorization: string) => Promise<T>): Promise<T> {
    const ref = reference(input); if (audience !== ref.audience) throw new EngineError('CREDENTIAL_AUDIENCE_MISMATCH', 'Credential cannot be used for a different server audience');
    if (signal.aborted) throw new EngineError('CREDENTIAL_CANCELLED', 'Credential request cancelled');
    const key = JSON.stringify(ref); let credential = this.cached.get(key);
    try {
      if (!credential) credential = await cancellable(this.host.resolve(ref, signal), signal);
      if (credential.expiresAt <= this.now() + 5000) {
        if (!this.host.refresh) throw new EngineError('CREDENTIAL_EXPIRED', 'Host credential expired and has no refresh callback');
        credential = await cancellable(this.host.refresh(ref, signal), signal);
      }
    } catch (error) { this.cached.delete(key); if (signal.aborted) throw new EngineError('CREDENTIAL_CANCELLED', 'Credential request cancelled'); if (error instanceof EngineError && error.code === 'CREDENTIAL_EXPIRED') throw error; throw new EngineError('CREDENTIAL_HOST_FAILED', 'Host credential resolution or refresh failed'); }
    if (signal.aborted) throw new EngineError('CREDENTIAL_CANCELLED', 'Credential request cancelled');
    if (typeof credential.bearerToken !== 'string' || !credential.bearerToken || Buffer.byteLength(credential.bearerToken) > 16_384 || /[\u0000-\u0020\u007f]/.test(credential.bearerToken) || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= this.now()) throw new EngineError('INVALID_HOST_CREDENTIAL', 'Host returned an invalid or expired credential');
    if (this.cached.size >= 128 && !this.cached.has(key)) throw new EngineError('CREDENTIAL_CACHE_LIMIT', 'Credential reference cache limit exceeded');
    this.cached.set(key, { bearerToken: credential.bearerToken, expiresAt: credential.expiresAt });
    return use(`Bearer ${credential.bearerToken}`);
  }
}
async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> { let listener: (() => void) | undefined; try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { listener = () => reject(new EngineError('CREDENTIAL_CANCELLED', 'Credential request cancelled')); signal.addEventListener('abort', listener, { once: true }); if (signal.aborted) listener(); })]); } finally { if (listener) signal.removeEventListener('abort', listener); } }
