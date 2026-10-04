import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { EngineError, REASONING_EFFORTS, type ReasoningEffort } from '@moodcode/contracts';

export interface CodexAuthOptions {
  /** A local Codex credential directory. Defaults to CODEX_HOME or ~/.codex. */
  codexHome?: string;
  /** Epoch milliseconds; expiry checks are local hints, not signature verification. */
  now?: () => number;
  signal?: AbortSignal;
}
export interface CodexAuthStatus {
  state: 'ready' | 'missing' | 'expired' | 'unreadable' | 'invalid' | 'unsupported';
  modelId?: string;
}
export interface CodexModelMetadata {
  id: string;
  displayName: string;
  reasoningEfforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

/** Local cache metadata only; never requests a model or refreshes credentials. */
export async function getCodexModelCatalog(options: CodexAuthOptions = {}): Promise<CodexModelMetadata[]> {
  cancelled(options.signal);
  const { home, now } = settings(options);
  let secrets: readonly string[] = [];
  try { secrets = (await credential(home, now, options.signal, value => { secrets = value; })).secrets; }
  catch (error) { if (isCancellation(error)) throw error; }
  try {
    const cache = json(await readLocalFile(join(home, 'models_cache.json'), CACHE_BYTES, options.signal));
    if (!Array.isArray(cache.models) || cache.models.length > 4096) return [];
    const models: CodexModelMetadata[] = [];
    const seen = new Set<string>();
    for (const value of cache.models) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const id = modelSlug(item.slug, secrets);
      if (!id || seen.has(id) || item.visibility === 'hide') continue;
      const name = item.display_name;
      const displayName = typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 256
        && !/[\u0000-\u001f\u007f]/u.test(name) && !secrets.some(secret => name.includes(secret)) ? name : id;
      const reasoningEfforts = Array.isArray(item.supported_reasoning_levels)
        ? [...new Set(item.supported_reasoning_levels.slice(0, 32).flatMap(level => {
          const effort = level && typeof level === 'object' ? (level as Record<string, unknown>).effort : undefined;
          return REASONING_EFFORTS.includes(effort as ReasoningEffort) ? [effort as ReasoningEffort] : [];
        }))] : [];
      const defaultEffort = reasoningEfforts.includes(item.default_reasoning_level as ReasoningEffort) ? item.default_reasoning_level as ReasoningEffort : undefined;
      models.push({ id, displayName, reasoningEfforts, ...(defaultEffort ? { defaultEffort } : {}) });
      seen.add(id);
      if (models.length === 128) break;
    }
    return models;
  } catch (error) { if (isCancellation(error)) throw error; return []; }
}

/** Internal transport data. This type and its reader are not facade exports. */
export interface CodexCredential {
  readonly accessToken: string;
  readonly accountId: string;
  readonly secrets: readonly string[];
}
export interface CodexCredentialReader {
  use<T>(signal: AbortSignal, callback: (credential: CodexCredential) => T | Promise<T>): Promise<T>;
}

type AuthState = Exclude<CodexAuthStatus['state'], 'ready'>;
const AUTH_BYTES = 131_072;
const CONFIG_BYTES = 262_144;
const CACHE_BYTES = 2_097_152;
const AUTH_MESSAGES: Readonly<Record<AuthState, string>> = {
  missing: 'Codex local authentication is missing. Sign in with Codex first.',
  expired: 'Codex local authentication has expired. Refresh the session in Codex first.',
  unreadable: 'Codex local authentication could not be safely read.',
  invalid: 'Codex local authentication is invalid.',
  unsupported: 'Codex local authentication must use a ChatGPT session.',
};
function authError(state: AuthState): EngineError {
  return new EngineError(`CODEX_AUTH_${state.toUpperCase()}`, AUTH_MESSAGES[state]);
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
}
function isCancellation(error: unknown): boolean {
  return error instanceof EngineError && error.code === 'PROVIDER_CANCELLED';
}
function fileError(error: unknown, allowMissing: boolean): EngineError {
  if (isCancellation(error)) return error as EngineError;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return authError(allowMissing && code === 'ENOENT' ? 'missing' : 'unreadable');
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** Bounded descriptor reads reject links, non-files, replacement and in-place writes. */
async function readLocalFile(path: string, maximum: number, signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  let before: BigIntStats;
  try { before = await lstat(path, { bigint: true }); } catch (error) { throw fileError(error, true); }
  cancelled(signal);
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum)) throw authError('unreadable');
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { throw fileError(error, false); }
  const bytes = Buffer.alloc(maximum + 1);
  try {
    cancelled(signal);
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) throw authError('unreadable');
    let length = 0;
    while (length <= maximum) {
      cancelled(signal);
      const result = await handle.read(bytes, length, Math.min(16_384, maximum + 1 - length), length);
      cancelled(signal);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maximum || BigInt(length) !== opened.size) throw authError('unreadable');
    const after = await handle.stat({ bigint: true });
    cancelled(signal);
    const current = await lstat(path, { bigint: true });
    cancelled(signal);
    if (!sameFile(opened, after) || !sameFile(after, current)) throw authError('unreadable');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); } catch { throw authError('invalid'); }
  } catch (error) {
    if (error instanceof EngineError && (isCancellation(error) || error.code.startsWith('CODEX_AUTH_'))) throw error;
    throw fileError(error, false);
  } finally {
    bytes.fill(0);
    await handle.close().catch(() => {});
  }
}

function plain(value: unknown, depth = 0): void {
  if (depth > 64) throw authError('invalid');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) plain(item, depth + 1); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) plain(item, depth + 1);
    return;
  }
  throw authError('invalid');
}
function json(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw authError('invalid'); }
  plain(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw authError('invalid');
  return value as Record<string, unknown>;
}
function bearer(value: unknown, optional = false): string | undefined {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 32_768 || /[^\x21-\x7e]/.test(value)) throw authError('invalid');
  return value;
}
function expiry(token: string, now: number): void {
  const segments = token.split('.');
  if (segments.length !== 3) return;
  if (segments.some(part => !part || !/^[A-Za-z0-9_-]+$/.test(part))) throw authError('invalid');
  const payload = segments[1]!;
  const bytes = Buffer.from(payload, 'base64url');
  try {
    if (bytes.toString('base64url') !== payload) throw authError('invalid');
    const claims = json(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (claims.exp !== undefined) {
      if (typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp < 0 || claims.exp > Number.MAX_SAFE_INTEGER / 1000) throw authError('invalid');
      if (claims.exp * 1000 <= now) throw authError('expired');
    }
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw authError('invalid');
  } finally { bytes.fill(0); }
}

class PrivateCredential implements CodexCredential {
  #accessToken: string;
  #accountId: string;
  #secrets: readonly string[];
  constructor(accessToken: string, accountId: string, secrets: string[]) {
    this.#accessToken = accessToken;
    this.#accountId = accountId;
    this.#secrets = Object.freeze([...new Set(secrets)]);
    Object.freeze(this);
  }
  get accessToken(): string { return this.#accessToken; }
  get accountId(): string { return this.#accountId; }
  get secrets(): readonly string[] { return this.#secrets; }
  [inspect.custom](): string { return '[CodexCredential]'; }
  toJSON(): Record<string, never> { return {}; }
}
function settings(options: CodexAuthOptions): { home: string; now: () => number } {
  const home = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  if (typeof home !== 'string' || !home.length || home.length > 8192 || home.includes('\0') || (options.now !== undefined && typeof options.now !== 'function')) throw authError('invalid');
  return { home: resolve(home), now: options.now ?? Date.now };
}
async function credential(home: string, now: () => number, signal?: AbortSignal, observeSecrets?: (secrets: readonly string[]) => void): Promise<CodexCredential> {
  const auth = json(await readLocalFile(join(home, 'auth.json'), AUTH_BYTES, signal));
  cancelled(signal);
  if (auth.tokens && typeof auth.tokens === 'object' && !Array.isArray(auth.tokens)) {
    const source = auth.tokens as Record<string, unknown>;
    observeSecrets?.(['access_token', 'refresh_token', 'id_token', 'account_id'].map(key => source[key]).filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32_768));
  }
  if (typeof auth.auth_mode !== 'string') throw authError('invalid');
  if (auth.auth_mode !== 'chatgpt') throw authError('unsupported');
  if (!auth.tokens || typeof auth.tokens !== 'object' || Array.isArray(auth.tokens)) throw authError('invalid');
  const tokens = auth.tokens as Record<string, unknown>;
  const accessToken = bearer(tokens.access_token)!;
  const refreshToken = bearer(tokens.refresh_token, true);
  const idToken = bearer(tokens.id_token, true);
  const accountId = tokens.account_id;
  if (typeof accountId !== 'string' || !accountId.length || accountId.length > 256 || /[^\x21-\x7e]/.test(accountId)) throw authError('invalid');
  let timestamp: number;
  try { timestamp = now(); } catch { throw authError('invalid'); }
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > Number.MAX_SAFE_INTEGER) throw authError('invalid');
  expiry(accessToken, timestamp);
  cancelled(signal);
  return new PrivateCredential(accessToken, accountId, [accessToken, accountId, ...[refreshToken, idToken].filter((value): value is string => value !== undefined)]);
}

/** Read-only, per-use credential access. No auth refresh, writes or account requests. */
export function createCodexCredentialReader(options: CodexAuthOptions = {}): CodexCredentialReader {
  const { home, now } = settings(options);
  return Object.freeze({
    async use<T>(signal: AbortSignal, callback: (data: CodexCredential) => T | Promise<T>): Promise<T> {
      cancelled(signal);
      const data = await credential(home, now, signal);
      cancelled(signal);
      return await callback(data);
    },
  });
}

function modelSlug(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || value.length > 128 || !/^(?:gpt-|codex-|chatgpt-|o[0-9])[a-z0-9._-]*$/.test(value)) return undefined;
  if (secrets.some(secret => value.includes(secret))) return undefined;
  return value;
}
function configModel(text: string, secrets: readonly string[]): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*model\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const encoded = match[1]!;
    let value: unknown;
    try { value = encoded.startsWith('"') ? JSON.parse(encoded) : encoded.slice(1, -1); } catch { return undefined; }
    return modelSlug(value, secrets);
  }
  return undefined;
}
async function localModel(home: string, secrets: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  try {
    const selected = configModel(await readLocalFile(join(home, 'config.toml'), CONFIG_BYTES, signal), secrets);
    if (selected) return selected;
  } catch (error) { if (isCancellation(error)) throw error; }
  try {
    const cache = json(await readLocalFile(join(home, 'models_cache.json'), CACHE_BYTES, signal));
    if (Array.isArray(cache.models) && cache.models.length <= 4096) {
      for (const entry of cache.models) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const selected = modelSlug((entry as Record<string, unknown>).slug, secrets);
          if (selected) return selected;
        }
      }
    }
  } catch (error) { if (isCancellation(error)) throw error; }
  return undefined;
}

/** Safe GUI metadata only. Cached credentials are never returned or refreshed. */
export async function getCodexAuthStatus(options: CodexAuthOptions = {}): Promise<CodexAuthStatus> {
  cancelled(options.signal);
  let home: string;
  let now: () => number;
  try { ({ home, now } = settings(options)); } catch { return { state: 'invalid' }; }
  let state: CodexAuthStatus['state'] = 'ready';
  let secrets: readonly string[] = [];
  try { secrets = (await credential(home, now, options.signal, value => { secrets = value; })).secrets; } catch (error) {
    if (isCancellation(error)) throw error;
    const code = error instanceof EngineError ? error.code : '';
    const known = Object.keys(AUTH_MESSAGES).find(candidate => code === `CODEX_AUTH_${candidate.toUpperCase()}`);
    state = known ? known as AuthState : 'unreadable';
  }
  const modelId = await localModel(home, secrets, options.signal);
  return modelId ? { state, modelId } : { state };
}
