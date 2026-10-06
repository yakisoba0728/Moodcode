import { EngineError, type ArtifactIdentity, type ArtifactReference, type JsonValue } from '@moodcode/contracts';

export const ARTIFACT_ID = /^artifact_[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const IDENTITY_KEYS = ['sessionId', 'runId', 'toolCallId', 'turnId', 'attemptId'] as const;

export function fail(code: string, message: string): never { throw new EngineError(code, message); }
export function number(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) fail('INVALID_ARTIFACT', `${label} must be a bounded nonnegative integer`);
  return value as number;
}
export function positive(value: unknown, label: string, maximum: number): number {
  const result = number(value, label, maximum);
  if (result === 0) fail('INVALID_ARTIFACT_OPTIONS', `${label} must be positive`);
  return result;
}
export function identity(value: ArtifactIdentity): ArtifactIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARTIFACT_IDENTITY', 'Artifact identity is required');
  const result: Record<string, string> = {};
  for (const key of IDENTITY_KEYS) {
    const item = value[key];
    if (item === undefined && (key === 'turnId' || key === 'attemptId')) continue;
    if (typeof item !== 'string' || !item.length || Buffer.byteLength(item) > 512 || /[\u0000-\u001f\u007f]/.test(item)) fail('INVALID_ARTIFACT_IDENTITY', `Invalid artifact ${key}`);
    result[key] = item;
  }
  return result as unknown as ArtifactIdentity;
}
export function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return IDENTITY_KEYS.every(key => left[key] === right[key]);
}
export function artifactId(value: unknown): string {
  if (typeof value !== 'string' || !ARTIFACT_ID.test(value)) fail('INVALID_ARTIFACT_ID', 'Invalid managed artifact ID');
  return value;
}
export function reference(value: ArtifactReference): ArtifactReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARTIFACT', 'Artifact reference is required');
  const storedBytes = number(value.storedBytes, 'storedBytes');
  const observedBytes = number(value.observedBytes, 'observedBytes');
  const producerTruncatedBytes = value.producerTruncatedBytes === null ? null : number(value.producerTruncatedBytes, 'producerTruncatedBytes');
  const artifactTruncatedBytes = number(value.artifactTruncatedBytes, 'artifactTruncatedBytes');
  if (typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) fail('INVALID_ARTIFACT', 'Invalid artifact SHA-256');
  if (!['completed', 'failed', 'interrupted'].includes(value.outcome) || typeof value.complete !== 'boolean') fail('INVALID_ARTIFACT', 'Invalid artifact outcome');
  if (storedBytes > observedBytes || artifactTruncatedBytes > observedBytes - storedBytes) fail('INVALID_ARTIFACT', 'Invalid artifact byte accounting');
  if (producerTruncatedBytes !== null && producerTruncatedBytes + artifactTruncatedBytes + storedBytes !== observedBytes) fail('INVALID_ARTIFACT', 'Artifact byte accounting does not balance');
  if (value.complete && (value.outcome !== 'completed' || producerTruncatedBytes !== 0 || artifactTruncatedBytes !== 0)) fail('INVALID_ARTIFACT', 'Incomplete artifact cannot claim completeness');
  for (const field of ['createdAt', 'expiresAt'] as const) {
    if (typeof value[field] !== 'string' || value[field].length > 64 || !Number.isFinite(Date.parse(value[field]))) fail('INVALID_ARTIFACT', `Invalid artifact ${field}`);
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) fail('INVALID_ARTIFACT', 'Artifact expiry must follow creation');
  return { id: artifactId(value.id), identity: identity(value.identity), sha256: value.sha256, storedBytes, observedBytes,
    producerTruncatedBytes, artifactTruncatedBytes, createdAt: value.createdAt, expiresAt: value.expiresAt, complete: value.complete, outcome: value.outcome };
}

/** A rendered UTF-8 prefix never splits a Unicode scalar and counts replacement bytes. */
export function textPrefix(value: string, maximum: number): string {
  let bytes = 0;
  let result = '';
  for (const scalar of value) {
    const count = Buffer.byteLength(scalar);
    if (bytes + count > maximum) break;
    result += scalar;
    bytes += count;
  }
  // Unpaired UTF-16 surrogates become replacement characters on the wire.
  return Buffer.from(result, 'utf8').toString('utf8');
}

export class JsonBudgetError extends Error {}
/** Validates JSON without invoking accessors and stops before an oversized projection is allocated. */
export function boundedJson(value: unknown, maximumBytes: number): JsonValue {
  let bytes = 0;
  let nodes = 0;
  const active = new Set<object>();
  const consume = (size: number) => { bytes += size; if (bytes > maximumBytes) throw new JsonBudgetError(); };
  const visit = (input: unknown, depth: number): JsonValue => {
    if (++nodes > 10_000 || depth > 64) fail('INVALID_ARTIFACT_DATA', 'JSON result exceeds the nesting or node limit');
    if (input === null) { consume(4); return null; }
    if (typeof input === 'string') { if (Buffer.byteLength(input) > maximumBytes - bytes) throw new JsonBudgetError(); consume(Buffer.byteLength(JSON.stringify(input))); return input; }
    if (typeof input === 'boolean') { consume(input ? 4 : 5); return input; }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail('INVALID_ARTIFACT_DATA', 'JSON result contains a nonfinite number');
      consume(Buffer.byteLength(JSON.stringify(input))); return input;
    }
    if (!input || typeof input !== 'object') fail('INVALID_ARTIFACT_DATA', 'Result must contain only JSON values');
    if (active.has(input)) fail('INVALID_ARTIFACT_DATA', 'JSON result contains a cycle');
    const proto = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && proto !== Object.prototype && proto !== null) fail('INVALID_ARTIFACT_DATA', 'JSON result must contain plain objects');
    active.add(input); consume(2);
    try {
      if (Array.isArray(input)) {
        const output: JsonValue[] = [];
        for (let index = 0; index < input.length; index++) {
          if (index) consume(1);
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !('value' in descriptor)) fail('INVALID_ARTIFACT_DATA', 'JSON arrays must be dense data values');
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      const output: Record<string, JsonValue> = {};
      let count = 0;
      for (const key in input) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) fail('INVALID_ARTIFACT_DATA', 'JSON objects cannot contain accessors');
        if (Buffer.byteLength(key) > maximumBytes - bytes) throw new JsonBudgetError();
        consume(Buffer.byteLength(JSON.stringify(key)) + 1 + (count++ ? 1 : 0));
        Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return output;
    } finally { active.delete(input); }
  };
  return visit(value, 0);
}
