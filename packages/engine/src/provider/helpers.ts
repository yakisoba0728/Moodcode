import { EngineError, type JsonValue } from '@moodcode/contracts';

export function malformed(): never {
  throw new EngineError('PROVIDER_MALFORMED_STREAM', 'Provider returned an invalid stream.');
}

const PUBLIC_ERRORS: Readonly<Record<string, string>> = {
  PROVIDER_INVALID_REQUEST: 'Provider request is invalid.',
  PROVIDER_INVALID_REPLAY: 'Provider replay data is invalid, exceeds a configured limit or contains unsafe opaque credentials.',
  PROVIDER_CANCELLED: 'Provider turn cancelled.',
  PROVIDER_TIMEOUT: 'Provider turn timed out.',
  PROVIDER_MALFORMED_STREAM: 'Provider returned an invalid stream.',
  PROVIDER_INCOMPLETE_STREAM: 'Provider stream ended before completion.',
  PROVIDER_LIMIT_EXCEEDED: 'Provider request or response exceeds a configured limit.',
  PROVIDER_REMOTE_ERROR: 'Provider reported an error in the stream.',
  PROVIDER_CONTEXT_OVERFLOW: 'Provider rejected the request because its context window is full.',
  PROVIDER_CONTENT_FILTERED: 'Provider filtered the completion.',
  PROVIDER_UNSUPPORTED_FINISH_REASON: 'Provider returned an unsupported finish reason or function call.',
  PROVIDER_UNSUPPORTED_OUTPUT: 'Provider returned unsupported output.',
  PROVIDER_UNSUPPORTED_INPUT: 'Selected provider or model does not support this input.',
  DOCUMENT_TOKEN_COST_UNKNOWN: 'PDF token cost is unknown; explicit host permission is required.',
  PROVIDER_UNSUPPORTED_EVENT: 'Provider returned an unsupported event.',
};

/** Rebuild public errors without remote messages, causes, or private details. */
export function publicError(error: unknown): EngineError {
  if (error instanceof EngineError) {
    const status = error.details?.status;
    if (error.code === 'PROVIDER_HTTP_ERROR' && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      const delay = error.details?.retryAfterMs;
      return new EngineError('PROVIDER_HTTP_ERROR', `Provider HTTP request failed with status ${status}.`, { status, ...(typeof delay === 'number' && Number.isSafeInteger(delay) && delay >= 0 && delay <= 60_000 ? { retryAfterMs: delay } : {}) });
    }
    const message = Object.hasOwn(PUBLIC_ERRORS, error.code) ? PUBLIC_ERRORS[error.code] : undefined;
    if (message) return new EngineError(error.code, message);
  }
  return new EngineError('PROVIDER_TRANSPORT_ERROR', 'Provider HTTP transport failed.');
}
/** Only a bounded delay survives; arbitrary server headers never enter diagnostics. */
export function providerRemoteError(value: unknown): EngineError {
  const code = value && typeof value === 'object' ? (value as Record<string, unknown>).code : undefined;
  return typeof code === 'string' && ['context_length_exceeded', 'context_window_exceeded', 'context_length_overflow', 'context_size_exceeded'].includes(code)
    ? new EngineError('PROVIDER_CONTEXT_OVERFLOW', 'Provider rejected the request because its context window is full.')
    : new EngineError('PROVIDER_REMOTE_ERROR', 'Provider reported an error in the stream.');
}
export function providerHttpError(response: Response): EngineError {
  const raw = response.headers.get('retry-after');
  let retryAfterMs: number | undefined;
  if (raw && raw.length <= 128) {
    const seconds = /^\d+(?:\.\d+)?$/u.test(raw.trim()) ? Number(raw) : undefined;
    const delay = seconds === undefined ? Date.parse(raw) - Date.now() : seconds * 1000;
    if (Number.isFinite(delay) && delay >= 0) retryAfterMs = Math.min(60_000, Math.ceil(delay));
  }
  return new EngineError('PROVIDER_HTTP_ERROR', `Provider HTTP request failed with status ${response.status}.`, { status: response.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
}
/** Inspect only bounded structured rejection codes; remote messages and body text stay private. */
export async function providerHttpFailure(response: Response, signal: AbortSignal): Promise<EngineError> {
  const fallback = providerHttpError(response);
  if (![400, 413].includes(response.status) || !response.body) return fallback;
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
      const item = await reader.read();
      if (signal.aborted) throw new EngineError('PROVIDER_CANCELLED', 'Provider turn cancelled.');
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 8192) return fallback;
      chunks.push(item.value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { return fallback; }
    const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).error : undefined;
    const normalized = providerRemoteError(value);
    return normalized.code === 'PROVIDER_CONTEXT_OVERFLOW' ? normalized : fallback;
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed();
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') malformed();
  return value;
}

const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];
/** Keys travel only over HTTPS or loopback HTTP; a keyless endpoint may use plain HTTP on any host. */
export function providerURLAllowed(url: URL, credentialed: boolean): boolean {
  return !url.username && !url.password && !url.search && !url.hash
    && (url.protocol === 'https:' || url.protocol === 'http:' && (!credentialed || LOOPBACK_HOSTS.includes(url.hostname)));
}

export function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_147_483_647) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider limits must be positive safe integers within the timer and byte range.');
  return limit;
}

function redactionMarker(secret: string): string {
  // Bearer credentials are printable ASCII. The block cannot contain a key,
  // and prevents keys with brackets from reappearing across marker boundaries.
  return '[REDACTED]'.includes(secret) || secret.includes('[') || secret.includes(']') ? '█' : '[REDACTED]';
}
export function redactText(text: string, secret: string | undefined): string {
  return secret ? text.replaceAll(secret, redactionMarker(secret)) : text;
}

/** Additional local OAuth secrets stay in private adapter state. */
export function credentialSecrets(primary: string | undefined, additional: readonly string[] | undefined): string[] {
  if (primary !== undefined && (typeof primary !== 'string' || !primary.length)) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider credential redaction configuration is invalid.');
  if (additional !== undefined && (!Array.isArray(additional) || additional.length > 8)) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider credential redaction configuration is invalid.');
  const secrets = [...new Set([...(primary ? [primary] : []), ...(additional ?? [])])];
  if (secrets.length > 8) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider credential redaction configuration is invalid.');
  let bytes = 0;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !secret.length || secret.length > 32_768 || /[^\x21-\x7e]/.test(secret)) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider credential redaction configuration is invalid.');
    bytes += secret.length;
  }
  if (bytes > 131_072) throw new EngineError('PROVIDER_INVALID_CONFIG', 'Provider credential redaction configuration is invalid.');
  return secrets.sort((a, b) => b.length - a.length);
}
export function redactCredentialText(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) text = redactText(text, secret);
  return text;
}
export function redactCredentialJson(value: unknown, secrets: readonly string[]): JsonValue {
  let result = redactJson(value, undefined);
  for (const secret of secrets) result = redactJson(result, secret);
  return result;
}
export class CredentialTextRedactor {
  #redactors: TextRedactor[];
  constructor(secrets: readonly string[]) { this.#redactors = secrets.map(secret => new TextRedactor(secret)); }
  push(text: string, final = false): string {
    for (const redactor of this.#redactors) text = redactor.push(text, final);
    return text;
  }
}

/** Keep only a suffix that could become the injected secret in a later delta. */
export class TextRedactor {
  #pending = '';
  readonly #secret: string | undefined;

  constructor(secret: string | undefined) {
    this.#secret = secret;
  }

  push(text: string, final = false): string {
    if (!this.#secret) return text;
    this.#pending += text;
    let output = '';
    let offset = 0;
    let match: number;
    while ((match = this.#pending.indexOf(this.#secret, offset)) >= 0) {
      output += this.#pending.slice(offset, match) + redactionMarker(this.#secret);
      offset = match + this.#secret.length;
    }
    const rest = this.#pending.slice(offset);
    let hold = 0;
    if (!final) {
      for (let length = Math.min(rest.length, this.#secret.length - 1); length > 0; length--) {
        if (rest.endsWith(this.#secret.slice(0, length))) { hold = length; break; }
      }
    }
    output += rest.slice(0, rest.length - hold);
    this.#pending = hold > 0 ? rest.slice(-hold) : '';
    return output;
  }
}

export function redactJson(value: unknown, secret: string | undefined, depth = 0): JsonValue {
  if (depth > 64) throw new EngineError('PROVIDER_LIMIT_EXCEEDED', 'Provider tool arguments exceed the nesting limit.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactText(value, secret);
  if (typeof value === 'number') { if (!Number.isFinite(value)) malformed(); return value; }
  if (Array.isArray(value)) return value.map(item => redactJson(item, secret, depth + 1));
  const obj = record(value);
  // defineProperty preserves JSON keys such as __proto__ without mutating a prototype.
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(obj)) {
    const safeKey = redactText(key, secret);
    if (Object.hasOwn(result, safeKey)) malformed();
    Object.defineProperty(result, safeKey, { value: redactJson(item, secret, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
