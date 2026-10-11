import { normalizeArtifactIdentity, validateArtifactReference } from '@moodcode/contracts/validation';
import { EngineError, type ArtifactIdentity, type ArtifactReference, type JsonValue } from '@moodcode/contracts';
import { plainJson, type PlainJsonFault } from '../shared/data.js';
export { utf8Prefix as textPrefix } from '../shared/data.js';

export const ARTIFACT_ID = /^artifact_[a-f0-9]{32}$/;
export const ARTIFACT_OUTCOMES = ['completed', 'failed', 'interrupted'] as const satisfies readonly ArtifactReference['outcome'][];
const REFERENCE_KEYS = ['id', 'identity', 'sha256', 'storedBytes', 'observedBytes', 'producerTruncatedBytes', 'artifactTruncatedBytes', 'createdAt', 'expiresAt', 'complete', 'outcome'] as const satisfies readonly (keyof ArtifactReference)[];
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
  // Unknown keys are stripped, not rejected, and identity faults keep their contracts code.
  const known = Object.fromEntries(REFERENCE_KEYS.map(key => [key, value[key]]));
  let ref: ArtifactReference;
  try { ref = validateArtifactReference(known); }
  catch (error) {
    const { details, message } = error as EngineError;
    if (String(details?.path).startsWith('artifact.identity')) throw error;
    if (details?.path === 'artifact.id') artifactId(known.id);
    return fail('INVALID_ARTIFACT', message);
  }
  artifactId(ref.id);
  return ref;
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
/** Validates JSON without invoking accessors and stops before an oversized projection is allocated. Strict also rejects proxies, symbol keys and hidden properties. */
export function boundedJson(value: unknown, maximumBytes: number, strict = false): JsonValue {
  return plainJson(value, { maxBytes: maximumBytes, maxNodes: 10_000, maxDepth: 64, accounting: 'encoded', lenient: !strict, fail: jsonFault }) as JsonValue;
}
