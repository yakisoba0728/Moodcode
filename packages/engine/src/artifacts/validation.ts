import { normalizeArtifactIdentity } from '@moodcode/contracts/validation';
import { EngineError, type ArtifactIdentity, type ArtifactReference, type JsonValue } from '@moodcode/contracts';
import { plainJson, type PlainJsonFault } from '../shared/data.js';
export { utf8Prefix as textPrefix } from '../shared/data.js';

export const ARTIFACT_ID = /^artifact_[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const IDENTITY_KEYS = ['sessionId', 'runId', 'toolCallId', 'turnId', 'attemptId', 'source', 'providerId', 'modelId'] as const;

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
export function identity(value: ArtifactIdentity): ArtifactIdentity { return normalizeArtifactIdentity(value); }
export function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return IDENTITY_KEYS.every(key => (left as unknown as Record<string,unknown>)[key] === (right as unknown as Record<string,unknown>)[key]);
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

export class JsonBudgetError extends Error {}
const JSON_FAULTS: Partial<Record<PlainJsonFault, string>> = {
  structure: 'JSON result exceeds the nesting or node limit', number: 'JSON result contains a nonfinite number', cycle: 'JSON result contains a cycle',
  prototype: 'JSON result must contain plain objects', element: 'JSON arrays must be dense data values', accessor: 'JSON objects cannot contain accessors',
};
function jsonFault(fault: PlainJsonFault): never {
  if (fault === 'bytes') throw new JsonBudgetError();
  return fail('INVALID_ARTIFACT_DATA', JSON_FAULTS[fault] ?? 'Result must contain only JSON values');
}
/** Validates JSON without invoking accessors and stops before an oversized projection is allocated. */
export function boundedJson(value: unknown, maximumBytes: number): JsonValue {
  return plainJson(value, { maxBytes: maximumBytes, maxNodes: 10_000, maxDepth: 64, accounting: 'encoded', lenient: true, fail: jsonFault }) as JsonValue;
}
