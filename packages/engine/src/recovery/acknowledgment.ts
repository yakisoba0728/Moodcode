import type { DatabaseSync } from 'node:sqlite';
import type { NativeSessionStorage } from '../storage/native.js';
import { withEvidenceRead } from '../storage/evidence-read.js';
import { sha256Hex } from '../shared/canonical.js';
import { isBoundedId, isSha256 } from '../shared/data.js';
import { canonical } from './snapshot.js';

export const CONTEXT_BASELINE_KINDS = ['context.memory', 'context.active_memory', 'context.head'] as const;
export const digest = (value: unknown): string => sha256Hex(canonical(value));
export const isHighWater = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
export const isIsoTimestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function captureHighWater(db: DatabaseSync, table: 'provider_attempts' | 'summary_attempts'): string {
  return String(db.prepare(`SELECT CAST(coalesce(max(rowid),0) AS TEXT) AS ordinal FROM ${table}`).get()!.ordinal);
}
export function readRecoveryTransaction<T>(native: NativeSessionStorage, operation: () => T): T {
  native.hooks.assertOpen();
  const db = native.database;
  if (db.isTransaction) return withEvidenceRead(db, operation);
  db.exec('BEGIN');
  try { const result = withEvidenceRead(db, operation); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
/** A context sourceIds entry: {} is a hash-bound label to skip, nativeId a label pinning its message, null a bare native identity.
 *  allowBackslash keeps the reading recorded provider decisions were digested under, where an instruction path with a backslash is a label. */
export function parseContextSourceReference(value: string, allowBackslash = false): { nativeId?: string } | null {
  if (/^(?:active-prefix-(?:policy|facts|manifest|checkpoint)|(?:image|document)-(?:policy|source)):[a-f0-9]{64}$/u.test(value)) return {};
  const separator = value.lastIndexOf(':');
  if (separator < 0 || !isSha256(value.slice(separator + 1))) return null;
  if (value.startsWith('instruction:')) {
    const path = value.slice('instruction:'.length, separator), components = path.split('/');
    return (allowBackslash || !path.includes('\\')) && components.at(-1) === 'AGENTS.md' && components.every(part => part !== '' && part !== '.' && part !== '..') ? {} : null;
  }
  if (value.startsWith('image-message:') || value.startsWith('document-message:')) {
    const nativeId = value.slice(value.indexOf(':') + 1, separator);
    if (isBoundedId(nativeId)) return { nativeId };
  }
  return null;
}
