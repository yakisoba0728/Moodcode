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
  PROVIDER_CONTENT_FILTERED: 'Provider filtered the completion.',
  PROVIDER_UNSUPPORTED_FINISH_REASON: 'Provider returned an unsupported finish reason or function call.',
  PROVIDER_UNSUPPORTED_OUTPUT: 'Provider returned unsupported output.',
  PROVIDER_UNSUPPORTED_EVENT: 'Provider returned an unsupported event.',
};

/** Rebuild public errors without remote messages, causes, or private details. */
export function publicError(error: unknown): EngineError {
  if (error instanceof EngineError) {
    const status = error.details?.status;
    if (error.code === 'PROVIDER_HTTP_ERROR' && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      return new EngineError('PROVIDER_HTTP_ERROR', `Provider HTTP request failed with status ${status}.`, { status });
    }
    const message = Object.hasOwn(PUBLIC_ERRORS, error.code) ? PUBLIC_ERRORS[error.code] : undefined;
    if (message) return new EngineError(error.code, message);
  }
  return new EngineError('PROVIDER_TRANSPORT_ERROR', 'Provider HTTP transport failed.');
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
