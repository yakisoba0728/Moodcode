import { createHash } from 'node:crypto';

type Sealed<T> = T & { readonly sha256: string };

/** Sorted-key JSON. Persisted digests depend on these exact bytes, including the historical output for non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sha256Hex(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function canonicalSha256(value: unknown): string { return sha256Hex(canonicalJson(value)); }
/** Depends on key order: only for digests already persisted over JSON.stringify output. */
export function jsonTextSha256(value: unknown): string { return sha256Hex(JSON.stringify(value)); }
export function sameCanonical(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
/** A sha256 already on the record is replaced, never hashed into the new digest. */
export function sealRecord<T extends object>(record: T, normalize: (sealed: Sealed<T>) => Sealed<T> = sealed => sealed): Sealed<T> {
  const { sha256: _stale, ...body } = record as T & { sha256?: unknown };
  return normalize({ ...body, sha256: canonicalSha256(body) } as Sealed<T>);
}
export function verifySealed<T extends object>(record: T, onMismatch: () => never): T {
  const { sha256, ...body } = record as T & { sha256?: unknown };
  if (canonicalSha256(body) !== sha256) onMismatch();
  return record;
}
