import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { EngineError, type InputDocumentAttachment } from '@moodcode/contracts';
import { plainRecord } from '../shared/data.js';

const INPUT_DOCUMENT_ID = /^doc_[a-f0-9]{32}$/u;
export interface DocumentLimits { maxDocumentBytes: number; maxInputDocuments: number; maxInputBytes: number; maxSessionDocuments: number; maxSessionBytes: number }
/** Local storage budgets, independent of provider limits or document token estimates. */
export const DEFAULT_DOCUMENT_LIMITS: Readonly<DocumentLimits> = Object.freeze({ maxDocumentBytes: 524_288, maxInputDocuments: 1, maxInputBytes: 1_048_576, maxSessionDocuments: 32, maxSessionBytes: 16_777_216 });
export function fail(code: string): never { throw new EngineError(code, 'Document input validation failed.'); }
export function documentLimits(input: Partial<DocumentLimits> = {}): Readonly<DocumentLimits> {
  plainRecord(input, [], Object.keys(DEFAULT_DOCUMENT_LIMITS), () => fail('DOCUMENT_INVALID_CONFIG'));
  const limits = { ...DEFAULT_DOCUMENT_LIMITS, ...input };
  for (const key of Object.keys(limits) as (keyof DocumentLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_DOCUMENT_LIMITS[key]) fail('DOCUMENT_INVALID_CONFIG');
  return Object.freeze(limits);
}
export function cancelled(signal?: AbortSignal): void {
  if (types.isProxy(signal) || signal !== undefined && !(signal instanceof AbortSignal)) fail('DOCUMENT_INVALID_CONFIG');
  if (signal?.aborted) fail('DOCUMENT_CANCELLED');
}
export function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function attachment(input: unknown, limits: Readonly<DocumentLimits> = DEFAULT_DOCUMENT_LIMITS): InputDocumentAttachment {
  const value = plainRecord(input, ['id', 'kind', 'mimeType', 'bytes', 'sha256'], [], () => fail('DOCUMENT_INVALID_REFERENCE'));
  if (typeof value.id !== 'string' || !INPUT_DOCUMENT_ID.test(value.id) || value.kind !== 'document' || value.mimeType !== 'application/pdf'
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) || typeof value.bytes !== 'number'
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > limits.maxDocumentBytes) fail('DOCUMENT_INVALID_REFERENCE');
  return { id: value.id, kind: 'document', mimeType: 'application/pdf', bytes: value.bytes, sha256: value.sha256 };
}
export function sameAttachment(left: InputDocumentAttachment, right: InputDocumentAttachment): boolean {
  return left.id === right.id && left.kind === right.kind && left.mimeType === right.mimeType && left.bytes === right.bytes && left.sha256 === right.sha256;
}
export function attachments(value: unknown, limits: Readonly<DocumentLimits> = DEFAULT_DOCUMENT_LIMITS): InputDocumentAttachment[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail('DOCUMENT_INVALID_REFERENCE');
  if (value.length > limits.maxInputDocuments) fail('DOCUMENT_LIMIT_EXCEEDED');
  const result: InputDocumentAttachment[] = [], ids = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('DOCUMENT_INVALID_REFERENCE');
    const ref = attachment(descriptor.value, limits); if (ids.has(ref.id)) fail('DOCUMENT_INVALID_REFERENCE'); ids.add(ref.id); result.push(ref);
  }
  if (result.reduce((sum, ref) => sum + ref.bytes, 0) > limits.maxInputBytes) fail('DOCUMENT_LIMIT_EXCEEDED');
  return result;
}
/** Signature only: this does not parse pages, objects, encryption, active content, or PDF validity. */
export function validateDocumentBytes(bytes: Uint8Array, mimeType: 'application/pdf', limits: Readonly<DocumentLimits> = DEFAULT_DOCUMENT_LIMITS): void {
  if (types.isProxy(bytes) || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > limits.maxDocumentBytes) fail('DOCUMENT_LIMIT_EXCEEDED');
  if (mimeType !== 'application/pdf') fail('DOCUMENT_MIME_MISMATCH');
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/u.test(data.subarray(0, 9).toString('latin1'))) fail('DOCUMENT_INVALID_FORMAT');
}
