import { isAbsolute, resolve } from 'node:path';
import { types } from 'node:util';
import { EngineError, type InputDocumentAttachment } from '@moodcode/contracts';
import { attachment } from '../documents/validation.js';
import { CHILD_DOCUMENT_READ_LIMITS, type ChildDocumentReadLimits, type ChildDocumentReadStats } from '../storage/child-document-reader.js';
import type { InputDocumentIndexReport } from '../storage/input-document-index.js';
import { isBoundedId, isSha256, plainRecord } from '../shared/data.js';
import { denseValues } from './validation.js';

export interface ArchivedChildDocumentStorageLimits extends ChildDocumentReadLimits { maxReportBytes: number; maxDocumentSamples: number }
export const DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS: Readonly<ArchivedChildDocumentStorageLimits> = Object.freeze({ ...CHILD_DOCUMENT_READ_LIMITS, maxChildren: 8, maxReportBytes: 32_768, maxDocumentSamples: 16 });
export interface ArchivedChildDocumentStorageRequest { directory: string; expectedManifestSha256: string; sessionId: string; sourceRunId: string; taskIds: readonly string[]; signal?: AbortSignal; limits?: Partial<ArchivedChildDocumentStorageLimits> }
export interface ValidatedArchivedChildDocumentStorageRequest extends Omit<ArchivedChildDocumentStorageRequest, 'limits'> { limits: Readonly<ArchivedChildDocumentStorageLimits>; releaseSignal(): void }
export interface ArchivedChildDocumentLineage { rootRunId: string; parentRunId: string; parentTaskId?: string; taskRequestId?: string; depth: number }
export interface ArchivedChildDocumentObservation {
  taskId: string; status: 'observed' | 'unchecked'; reason?: string; reasons?: readonly string[];
  childSessionId?: string; childRunId?: string; lineage?: ArchivedChildDocumentLineage; index?: InputDocumentIndexReport;
}
export interface ArchivedChildDocumentStorageItem {
  taskId: string; status: 'observed' | 'unchecked'; reasons: string[]; childSessionId?: string; childRunId?: string; lineage?: ArchivedChildDocumentLineage;
  indexComplete: boolean | null; countsKnown: boolean; documentCount: number | null; observedReferences: number | null;
  indexedReferences: number | null; declaredBytes: number | null; observedDeclaredBytes: number | null; sampledJsonBytes: number | null;
  documents: InputDocumentAttachment[]; documentsOmitted: number | null; observedDocumentsOmitted: number | null;
}
export interface ArchivedChildDocumentStorageReport {
  schemaVersion: 1; scope: 'verified-archive-historical'; archiveId: string; manifestSha256: string; sessionId: string; sourceRunId: string;
  complete: boolean; archiveCoverage: 'complete' | 'partial' | 'unchecked'; limits: Readonly<ArchivedChildDocumentStorageLimits>;
  requestedChildren: number; observedChildren: number; uncheckedChildren: number; reportsOmitted: number; documentsOmitted: number | null; observedDocumentsOmitted: number;
  children: ArchivedChildDocumentStorageItem[]; reasons: string[]; stats: ChildDocumentReadStats; statsScope: 'whole-archive-proof-frame';
  declaredReferenceBytes: { children: number | null; observedChildSubtotal: number; accounting: 'declared-reference-bytes-per-archived-child-store'; physicalFileBytes: null };
  recoveryAcknowledgmentsRebound: false; physicalRebinding: false; executionResumed: false;
  coverage: { selectedChildren: 'exact-request-task-ids'; archiveChildren: 'manifest-declared-audit'; requestedTaskCap: number; wholeArchiveChildProofCap: 32;
    documentMetadata: 'bounded-samples-of-validated-index-references'; documentContents: 'not-returned'; documentBlobs: 'archive-validated-not-returned';
    originalFiles: 'not-read'; originalPhysicalOwnership: 'not-activated'; providerCredentials: 'not-read'; unselectedChildren: 'archive-proof-only';
    metadataBytes: 'whole-archive-shared-proof-frame'; physicalReadBytes: null; physicalAllocatedBytes: null; cleanup: 'not-performed'; executionAuthority: 'not-granted' };
}
export interface ArchivedChildDocumentReportInput {
  archiveId: string; manifestSha256: string; expectedManifestSha256: string; sessionId: string; sourceRunId: string;
  archiveDocumentAuditCoverage: 'complete' | 'partial' | 'unchecked'; requestedTaskIds: readonly string[]; observations: readonly ArchivedChildDocumentObservation[];
  stats: ChildDocumentReadStats; limits: Readonly<ArchivedChildDocumentStorageLimits>;
}

function fail(code: string): never { throw new EngineError(code, 'Archived child document inspection requires exact bounded data.'); }
function invalidRequest(): never { return fail('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'); }
function invalidReport(): never { return fail('ARCHIVE_CHILD_REPORT_INVALID'); }
type Reject = () => never;
function plain(value: unknown, keys: readonly string[], reject: Reject): Record<string, unknown> { return plainRecord(value, [], keys, reject); }
function task(value: unknown): value is string { return typeof value === 'string' && /^child_[a-f0-9]{32}$/u.test(value); }
function amount(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max; }
function selectors(value: unknown, max: number, reject: Reject): string[] {
  const ids = denseValues(value, max, reject), seen = new Set<string>(), selected: string[] = [];
  for (const value of ids) { if (!task(value) || seen.has(value)) reject(); seen.add(value); selected.push(value); }
  return selected;
}
function limits(value: unknown, reject: Reject): Readonly<ArchivedChildDocumentStorageLimits> {
  const fields = value === undefined ? {} : plain(value, Object.keys(DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS), reject);
  const selected = { ...DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS, ...fields };
  for (const key of Object.keys(selected) as (keyof ArchivedChildDocumentStorageLimits)[]) {
    const ceiling = key === 'maxChildren' ? 32 : key === 'maxDocumentSamples' ? 128 : DEFAULT_ARCHIVED_CHILD_DOCUMENT_STORAGE_LIMITS[key];
    if (!amount(selected[key], ceiling) || selected[key] < (key === 'maxDocumentSamples' ? 0 : 1)) reject();
  }
  if (selected.maxReportBytes < 4096) reject();
  return Object.freeze(selected);
}
function signal(value: unknown): { signal?: AbortSignal; releaseSignal(): void } {
  if (value === undefined) return { releaseSignal() {} };
  if (types.isProxy(value) || !value || typeof value !== 'object' || Object.getPrototypeOf(value) !== AbortSignal.prototype) invalidRequest();
  // Native brand validation avoids invoking a caller's shadowed aborted getter.
  if (Reflect.ownKeys(value).some(key => ['aborted', 'reason', 'throwIfAborted'].includes(String(key)) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) invalidRequest();
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
  try { if (!aborted || typeof aborted.call(value) !== 'boolean') invalidRequest(); } catch { invalidRequest(); }
  // Node's unobserved composite signals can compute cancellation lazily from
  // a public source surface. A live native observer activates the dependency
  // throughout this operation; the inspector must release it in finally.
  const selected = AbortSignal.any([value as AbortSignal]), observer = () => {};
  EventTarget.prototype.addEventListener.call(selected, 'abort', observer, { once: true });
  let released = false;
  return { signal: selected, releaseSignal() { if (released) return; released = true; EventTarget.prototype.removeEventListener.call(selected, 'abort', observer); } };
}
/** Pure validation: no canonical filesystem lookup, database, or archive access. */
export function validateArchivedChildDocumentStorageRequest(value: unknown): ValidatedArchivedChildDocumentStorageRequest {
  const request = plain(value, ['directory', 'expectedManifestSha256', 'sessionId', 'sourceRunId', 'taskIds', 'signal', 'limits'], invalidRequest);
  if (typeof request.directory !== 'string' || !isAbsolute(request.directory) || resolve(request.directory) !== request.directory || Buffer.byteLength(request.directory) > 8192 || /[\u0000-\u001f\u007f]/u.test(request.directory)
    || !isSha256(request.expectedManifestSha256) || !isBoundedId(request.sessionId) || !isBoundedId(request.sourceRunId)) invalidRequest();
  const selectedLimits = limits(request.limits, invalidRequest), taskIds = selectors(request.taskIds, selectedLimits.maxChildren, invalidRequest), preparedSignal = signal(request.signal);
  return Object.freeze({ directory: request.directory, expectedManifestSha256: request.expectedManifestSha256, sessionId: request.sessionId, sourceRunId: request.sourceRunId, taskIds: Object.freeze(taskIds), ...preparedSignal, limits: selectedLimits });
}
function reason(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value)) invalidReport(); return value; }
function lineage(value: unknown, sourceRunId: string): ArchivedChildDocumentLineage | undefined {
  if (value === undefined) return undefined;
  const object = plain(value, ['rootRunId', 'parentRunId', 'parentTaskId', 'taskRequestId', 'depth'], invalidReport);
  if (object.rootRunId !== sourceRunId || !isBoundedId(object.parentRunId) || !amount(object.depth, 16) || object.depth < 1 || object.parentTaskId !== undefined && !task(object.parentTaskId) || object.taskRequestId !== undefined && !isBoundedId(object.taskRequestId)) invalidReport();
  return { rootRunId: sourceRunId, parentRunId: object.parentRunId, depth: object.depth, ...(object.parentTaskId !== undefined ? { parentTaskId: object.parentTaskId as string } : {}), ...(object.taskRequestId !== undefined ? { taskRequestId: object.taskRequestId as string } : {}) };
}
function stats(value: unknown, bounds: Readonly<ArchivedChildDocumentStorageLimits>): ChildDocumentReadStats {
  const object = plain(value, ['selectedMetadataBytes', 'selectedRefs', 'selectedRows', 'openedChildren', 'rawMirrorBytes', 'elapsedMs', 'exhaustedReason'], invalidReport);
  if (!amount(object.selectedMetadataBytes, bounds.maxMetadataBytes) || !amount(object.selectedRefs, bounds.maxRefs) || !amount(object.selectedRows, bounds.maxRows) || !amount(object.openedChildren, 32)
    || !amount(object.rawMirrorBytes, bounds.maxMirrorBytes) || typeof object.elapsedMs !== 'number' || !Number.isFinite(object.elapsedMs) || object.elapsedMs < 0 || object.exhaustedReason !== null && typeof object.exhaustedReason !== 'string') invalidReport();
  return { selectedMetadataBytes: object.selectedMetadataBytes, selectedRefs: object.selectedRefs, selectedRows: object.selectedRows, openedChildren: object.openedChildren, rawMirrorBytes: object.rawMirrorBytes, elapsedMs: object.elapsedMs, exhaustedReason: object.exhaustedReason === null ? null : reason(object.exhaustedReason) };
}
function child(observation: unknown, sourceRunId: string, sampleBudget: { remaining: number }, maxRefs: number): ArchivedChildDocumentStorageItem {
  const object = plain(observation, ['taskId', 'status', 'reason', 'reasons', 'childSessionId', 'childRunId', 'lineage', 'index'], invalidReport);
  if (!task(object.taskId) || typeof object.status !== 'string' || !['observed', 'unchecked'].includes(object.status) || object.childSessionId !== undefined && !isBoundedId(object.childSessionId) || object.childRunId !== undefined && !isBoundedId(object.childRunId)) invalidReport();
  const reasons = object.reasons === undefined ? [] : denseValues(object.reasons, 16, invalidReport).map(reason);
  if (object.reason !== undefined) reasons.push(reason(object.reason));
  const selectedLineage = lineage(object.lineage, sourceRunId);
  const result: ArchivedChildDocumentStorageItem = { taskId: object.taskId, status: object.status as 'observed' | 'unchecked', reasons: [...new Set(reasons)], ...(object.childSessionId ? { childSessionId: object.childSessionId as string } : {}), ...(object.childRunId ? { childRunId: object.childRunId as string } : {}), ...(selectedLineage ? { lineage: selectedLineage } : {}), indexComplete: null, countsKnown: false, documentCount: null, indexedReferences: null, observedReferences: null, declaredBytes: null, observedDeclaredBytes: null, sampledJsonBytes: null, documents: [], documentsOmitted: null, observedDocumentsOmitted: null };
  if (object.status === 'unchecked') { if (object.index !== undefined) invalidReport(); if (!result.reasons.length) result.reasons.push('child-index-unchecked'); return result; }
  if (!isBoundedId(object.childSessionId) || !isBoundedId(object.childRunId)) invalidReport();
  const index = plain(object.index, ['scope', 'observedAt', 'complete', 'totalDocuments', 'sampledDocuments', 'invalidDocuments', 'omittedDocuments', 'invalidReferences', 'omittedReferences', 'sampledJsonBytes', 'documents', 'refs', 'documentIds', 'declaredBytes', 'limits', 'reasons', 'coverage'], invalidReport);
  if (typeof index.complete !== 'boolean' || !amount(index.sampledJsonBytes, CHILD_DOCUMENT_READ_LIMITS.maxMetadataBytes) || index.declaredBytes !== null && !amount(index.declaredBytes)) invalidReport();
  const refs = denseValues(index.refs, maxRefs, invalidReport), seen = new Set<string>();
  for (const value of refs) {
    const ref = plain(value, ['id', 'kind', 'mimeType', 'bytes', 'sha256', 'sessionId', 'workspaceId'], invalidReport);
    if (ref.sessionId !== object.childSessionId || !isBoundedId(ref.workspaceId)) invalidReport();
    let selected: InputDocumentAttachment;
    try { selected = attachment({ id: ref.id, kind: ref.kind, mimeType: ref.mimeType, bytes: ref.bytes, sha256: ref.sha256 }); } catch { invalidReport(); }
    if (seen.has(selected.id)) invalidReport(); seen.add(selected.id);
    if (sampleBudget.remaining > 0) { result.documents.push(selected); sampleBudget.remaining--; }
  }
  result.indexComplete = index.complete; result.countsKnown = index.complete; result.documentCount = index.complete ? refs.length : null; result.indexedReferences = result.documentCount;
  result.observedReferences = refs.length; result.declaredBytes = index.complete ? index.declaredBytes as number | null : null; result.observedDeclaredBytes = index.declaredBytes as number | null;
  result.sampledJsonBytes = index.sampledJsonBytes; result.observedDocumentsOmitted = refs.length - result.documents.length; result.documentsOmitted = index.complete ? result.observedDocumentsOmitted : null;
  if (!index.complete) result.reasons.push('child-index-incomplete');
  return result;
}
/** Formats only already-validated observations; it performs no filesystem/SQL access or proof charging. */
export function buildArchivedChildDocumentStorageReport(value: ArchivedChildDocumentReportInput): ArchivedChildDocumentStorageReport {
  const input = plain(value, ['archiveId', 'manifestSha256', 'expectedManifestSha256', 'sessionId', 'sourceRunId', 'archiveDocumentAuditCoverage', 'requestedTaskIds', 'observations', 'stats', 'limits'], invalidReport);
  if (typeof input.archiveId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(input.archiveId) || !isSha256(input.manifestSha256) || !isSha256(input.expectedManifestSha256) || !isBoundedId(input.sessionId) || !isBoundedId(input.sourceRunId) || typeof input.archiveDocumentAuditCoverage !== 'string' || !['complete', 'partial', 'unchecked'].includes(input.archiveDocumentAuditCoverage)) invalidReport();
  if (input.manifestSha256 !== input.expectedManifestSha256) fail('ARCHIVE_MANIFEST_SHA_MISMATCH');
  const bounds = limits(input.limits, invalidReport), requested = selectors(input.requestedTaskIds, bounds.maxChildren, invalidReport), proofStats = stats(input.stats, bounds), sampleBudget = { remaining: bounds.maxDocumentSamples };
  const supplied = denseValues(input.observations, 32, invalidReport), byTask = new Map<string, unknown>();
  for (const item of supplied) {
    const header = plain(item, ['taskId', 'status', 'reason', 'reasons', 'childSessionId', 'childRunId', 'lineage', 'index'], invalidReport);
    if (!task(header.taskId) || !requested.includes(header.taskId) || byTask.has(header.taskId)) invalidReport(); byTask.set(header.taskId, item);
  }
  const children = requested.map(taskId => child(byTask.get(taskId) ?? { taskId, status: 'unchecked', reason: 'child-observation-unavailable' }, input.sourceRunId as string, sampleBudget, bounds.maxRefs));
  if (children.reduce((sum, item) => sum + (item.observedReferences ?? 0), 0) > bounds.maxRefs) invalidReport();
  const observedChildren = children.filter(item => item.status === 'observed').length, uncheckedChildren = children.length - observedChildren;
  const totalsKnown = !uncheckedChildren && children.every(item => item.indexComplete && item.declaredBytes !== null), observedChildSubtotal = children.reduce((sum, item) => sum + (item.observedDeclaredBytes ?? 0), 0);
  if (!amount(observedChildSubtotal)) invalidReport();
  const report: ArchivedChildDocumentStorageReport = { schemaVersion: 1, scope: 'verified-archive-historical', archiveId: input.archiveId, manifestSha256: input.manifestSha256, sessionId: input.sessionId, sourceRunId: input.sourceRunId,
    complete: !uncheckedChildren && children.every(item => item.indexComplete === true && item.observedDocumentsOmitted === 0) && !proofStats.exhaustedReason, archiveCoverage: input.archiveDocumentAuditCoverage as ArchivedChildDocumentStorageReport['archiveCoverage'], limits: bounds,
    requestedChildren: requested.length, observedChildren, uncheckedChildren, reportsOmitted: 0, documentsOmitted: null, observedDocumentsOmitted: 0, children, reasons: [], stats: proofStats, statsScope: 'whole-archive-proof-frame',
    declaredReferenceBytes: { children: totalsKnown ? observedChildSubtotal : null, observedChildSubtotal, accounting: 'declared-reference-bytes-per-archived-child-store', physicalFileBytes: null }, recoveryAcknowledgmentsRebound: false, physicalRebinding: false, executionResumed: false,
    coverage: { selectedChildren: 'exact-request-task-ids', archiveChildren: 'manifest-declared-audit', requestedTaskCap: bounds.maxChildren, wholeArchiveChildProofCap: 32, documentMetadata: 'bounded-samples-of-validated-index-references', documentContents: 'not-returned', documentBlobs: 'archive-validated-not-returned', originalFiles: 'not-read', originalPhysicalOwnership: 'not-activated', providerCredentials: 'not-read', unselectedChildren: 'archive-proof-only', metadataBytes: 'whole-archive-shared-proof-frame', physicalReadBytes: null, physicalAllocatedBytes: null, cleanup: 'not-performed', executionAuthority: 'not-granted' } };
  const allCountsKnown = !uncheckedChildren && children.every(item => item.countsKnown), initialOmissions = children.reduce((sum, item) => sum + (item.observedDocumentsOmitted ?? 0), 0);
  report.observedDocumentsOmitted = initialOmissions; report.documentsOmitted = allCountsKnown ? initialOmissions : null;
  if (uncheckedChildren) report.reasons.push('selected-children-unchecked'); if (children.some(item => item.indexComplete === false)) report.reasons.push('child-index-incomplete'); if (initialOmissions) report.reasons.push('document-sample-limit'); if (proofStats.exhaustedReason) report.reasons.push(proofStats.exhaustedReason);
  // Samples are display-only. Trim those first, preserving proven counts and
  // known subtotal even if the separately bounded report omits child details.
  while (Buffer.byteLength(JSON.stringify(report)) > bounds.maxReportBytes) {
    const sampled = report.children.findLast(item => item.documents.length > 0);
    if (sampled) { sampled.documents.pop(); sampled.observedDocumentsOmitted = (sampled.observedDocumentsOmitted ?? 0) + 1; if (sampled.documentsOmitted !== null) sampled.documentsOmitted++; report.observedDocumentsOmitted++; if (report.documentsOmitted !== null) report.documentsOmitted++; }
    else if (report.children.length) { const omitted = report.children.pop()!; report.reportsOmitted++; report.observedDocumentsOmitted += omitted.documents.length; if (report.documentsOmitted !== null) report.documentsOmitted += omitted.documents.length; }
    else fail('ARCHIVE_CHILD_REPORT_LIMIT');
    report.complete = false; if (!report.reasons.includes('report-byte-limit')) report.reasons.push('report-byte-limit');
  }
  return report;
}
