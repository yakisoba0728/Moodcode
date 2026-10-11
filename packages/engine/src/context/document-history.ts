import { types } from 'node:util';
import type { InputDocumentAttachment, SessionSnapshot } from '@moodcode/contracts';
import type { ProviderMessage } from '../ports.js';
import { jsonTextSha256, sha256Hex } from '../shared/canonical.js';
import { attachments, sameAttachment } from '../documents/validation.js';
import { fail, HISTORY_PROJECTION_LIMITS, inspectReplay, provenanceNotice, record, requiredUserAnchors, type ReplayFault } from './history-projection.js';

export const DOCUMENT_HISTORY_NOTICE_PREFIX = '[Moodcode document history provenance v1]\n';
export const DOCUMENT_HISTORY_LIMITS = HISTORY_PROJECTION_LIMITS;
export interface DocumentHistoryPolicy { kind: 'reference-only-older-documents'; version: 1; maxMetadataBytes?: number }
export interface DocumentHistoryOptions { policy?: DocumentHistoryPolicy; activeRunId?: string }
export interface DocumentHistoryProvenance {
  version: 1; sessionId: string; runId: string; messageId: string; sourceOrdinal: number;
  sourceContentSha256: string; documents: InputDocumentAttachment[];
  bytes: 'unavailable-in-this-request'; reason: 'host-reference-only-history' | 'older-exact-reference';
  summarized: false; currentFileEvidence: false;
}
export interface DocumentHistoryDiagnostics {
  enabled: boolean; policySha256: string | null; sourceSha256: string | null;
  sourceDocumentOccurrences: number | null; retainedDocumentOccurrences: number | null; omittedDocumentOccurrences: number | null;
  retainedDocumentBytes: number | null; uniqueRetainedDocuments: number | null;
  metadataBytes: number; noticeBytes: number;
  metadataTokenEstimate: { tokens: number; source: 'utf8-byte-upper-bound'; estimated: true };
  documentTokens: null; summarized: false; activeCutoffCreated: false;
}
export interface DocumentHistoryProjection {
  snapshot: SessionSnapshot; requiredTextMessageIds: string[]; requiredNotice: ProviderMessage | null;
  provenance: DocumentHistoryProvenance[]; diagnostics: DocumentHistoryDiagnostics;
}

function cancelled(signal?: AbortSignal): void {
  if (types.isProxy(signal) || signal !== undefined && !(signal instanceof AbortSignal)) fail('DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history cancellation requires a host signal');
  if (signal?.aborted) fail('CANCELLED', 'Document history projection was cancelled');
}
function id(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value); }
function dense(value: unknown): value is unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > DOCUMENT_HISTORY_LIMITS.maxSourceMessages || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}
export function validateDocumentHistoryPolicy(value: unknown): Required<DocumentHistoryPolicy> {
  if (!record(value) || Reflect.ownKeys(value).some(key => !['kind', 'version', 'maxMetadataBytes'].includes(String(key)))
    || !Object.hasOwn(value, 'kind') || !Object.hasOwn(value, 'version') || value.kind !== 'reference-only-older-documents' || value.version !== 1) fail('DOCUMENT_HISTORY_INVALID_POLICY', 'Document history requires an explicit supported host policy');
  const maxMetadataBytes = Object.hasOwn(value, 'maxMetadataBytes') ? value.maxMetadataBytes : DOCUMENT_HISTORY_LIMITS.maxMetadataBytes;
  if (typeof maxMetadataBytes !== 'number' || !Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1 || maxMetadataBytes > DOCUMENT_HISTORY_LIMITS.maxMetadataBytes) fail('DOCUMENT_HISTORY_INVALID_POLICY', 'Document history metadata must fit the host bound');
  return { kind: 'reference-only-older-documents', version: 1, maxMetadataBytes };
}

const REPLAY_FAULTS: Record<ReplayFault, [string, string]> = {
  nodes: ['DOCUMENT_HISTORY_REPLAY_LIMIT', 'Opaque replay exceeds the bounded document metadata inspection'],
  keys: ['DOCUMENT_HISTORY_REPLAY_LIMIT', 'Opaque replay exceeds the bounded document key count'],
  proxy: ['DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history replay requires acyclic plain data'],
  cycle: ['DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history replay requires acyclic plain data'],
  prototype: ['DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history replay requires plain JSON'],
  accessor: ['DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history replay cannot contain accessors or hidden data'],
  unsupported: ['DOCUMENT_HISTORY_REPLAY_FILE_UNSUPPORTED', 'File-shaped opaque replay cannot be treated as imported document history'],
};
const fileShaped = (key: string, child: unknown) => key === 'type' && typeof child === 'string' && ['input_file', 'output_file', 'file', 'file_url', 'input_document', 'output_document', 'document'].includes(child)
  || ['file_data', 'file_id', 'file_url', 'document_data', 'document_url'].includes(key)
  || ['mimeType', 'mime_type', 'media_type'].includes(key) && child === 'application/pdf';

/** Host opt-in changes transport references only. Text, chronology, replay and durable source remain exact. */
export function projectDocumentHistory(source: SessionSnapshot, options: DocumentHistoryOptions = {}, signal?: AbortSignal): DocumentHistoryProjection {
  cancelled(signal);
  if (!record(options) || Reflect.ownKeys(options).some(key => !['policy', 'activeRunId'].includes(String(key)))) fail('DOCUMENT_HISTORY_INVALID_POLICY', 'Document history options require bounded plain data');
  const empty: DocumentHistoryDiagnostics = { enabled: false, policySha256: null, sourceSha256: null, sourceDocumentOccurrences: null, retainedDocumentOccurrences: null,
    omittedDocumentOccurrences: null, retainedDocumentBytes: null, uniqueRetainedDocuments: null, metadataBytes: 0, noticeBytes: 0,
    metadataTokenEstimate: { tokens: 0, source: 'utf8-byte-upper-bound', estimated: true }, documentTokens: null, summarized: false, activeCutoffCreated: false };
  if (options.policy === undefined) return { snapshot: structuredClone(source), requiredTextMessageIds: [], requiredNotice: null, provenance: [], diagnostics: empty };
  const policy = validateDocumentHistoryPolicy(options.policy);
  if (!record(source) || !record(source.session) || !id(source.session.id) || !id(source.session.workspaceId) || !dense(source.messages) || !dense(source.runs)) fail('DOCUMENT_HISTORY_SOURCE_LIMIT', 'Document history requires a bounded dense source and owner manifest');
  if (options.activeRunId !== undefined && !id(options.activeRunId)) fail('DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history Run identifiers must be bounded');
  const runs = new Set<string>();
  for (const run of source.runs) {
    cancelled(signal);
    if (!record(run) || !id(run.id) || run.sessionId !== source.session.id || run.workspaceId !== source.session.workspaceId || runs.has(run.id)) fail('DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history Run manifest must have exact session/workspace owners');
    runs.add(run.id);
  }
  if (options.activeRunId !== undefined && !runs.has(options.activeRunId)) fail('DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history active Run is absent from its owner manifest');
  const refs = new Map<string, InputDocumentAttachment[]>(), identities = new Map<string, InputDocumentAttachment>(), messageIds = new Set<string>();
  let count = 0;
  for (const message of source.messages) {
    cancelled(signal);
    if (!record(message) || !id(message.id) || !id(message.runId) || message.sessionId !== source.session.id || !runs.has(message.runId)
      || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string' || messageIds.has(message.id)) fail('DOCUMENT_HISTORY_INVALID_SOURCE', 'Document history messages require exact same-session Run owners');
    messageIds.add(message.id);
    if (message.providerReplay !== undefined) inspectReplay(message.providerReplay, () => cancelled(signal), fileShaped, fault => fail(...REPLAY_FAULTS[fault]));
    if (!Object.hasOwn(message, 'documents')) continue;
    let documents: InputDocumentAttachment[];
    try { documents = attachments(message.documents); } catch { fail('DOCUMENT_HISTORY_INVALID_REFERENCE', 'Document history contains an invalid imported PDF reference'); }
    if (!documents.length) continue;
    if (message.role !== 'user') fail('DOCUMENT_HISTORY_INVALID_REFERENCE', 'Imported documents belong only to user messages');
    for (const ref of documents) {
      const previous = identities.get(ref.id);
      if (previous && !sameAttachment(previous, ref)) fail('DOCUMENT_HISTORY_REFERENCE_CONFLICT', 'The same document identity has conflicting historical metadata');
      identities.set(ref.id, ref);
    }
    refs.set(message.id, documents); count += documents.length;
  }
  const latest = source.messages.findLast(message => refs.has(message.id));
  const required = new Set([...refs.keys(), ...requiredUserAnchors(source.messages, options.activeRunId)]);
  const snapshot = structuredClone(source), provenance: DocumentHistoryProvenance[] = [];
  for (let index = 0; index < snapshot.messages.length; index++) {
    cancelled(signal);
    const message = snapshot.messages[index]!, documents = refs.get(message.id);
    if (!documents || message.id === latest?.id) continue;
    delete message.documents;
    provenance.push({ version: 1, sessionId: message.sessionId, runId: message.runId, messageId: message.id, sourceOrdinal: index + 1,
      sourceContentSha256: sha256Hex(message.content), documents: structuredClone(documents), bytes: 'unavailable-in-this-request',
      reason: documents.every(ref => refs.get(latest!.id)!.some(retained => sameAttachment(retained, ref))) ? 'older-exact-reference' : 'host-reference-only-history', summarized: false, currentFileEvidence: false });
  }
  const policySha256 = jsonTextSha256(policy);
  const sourceSha256 = jsonTextSha256(source.messages.map((message, index) => ({ messageId: message.id, sessionId: message.sessionId, runId: message.runId, role: message.role,
    ordinal: index + 1, contentSha256: sha256Hex(message.content), documents: refs.get(message.id) ?? [] })));
  const { requiredNotice, noticeBytes, metadataBytes } = provenanceNotice(DOCUMENT_HISTORY_NOTICE_PREFIX, provenance.length ? {
    version: 1, observationKind: 'quoted-document-provenance', byteScope: 'historical-message-occurrence',
    bytes: 'Document bytes are unavailable in this request for the listed older message occurrences. An identical reference may be available in the separately retained latest document message.',
    summarized: false, currentFileEvidence: false, permissionOrInstruction: false, policySha256, sourceSha256, omissions: provenance,
  } : null, { provenance, requiredTextMessageIds: [...required], policySha256, sourceSha256 }, policy.maxMetadataBytes,
  () => fail('DOCUMENT_HISTORY_METADATA_LIMIT', 'Document provenance and its required model notice exceed the explicit metadata budget'));
  cancelled(signal);
  const retained = latest ? refs.get(latest.id)! : [];
  return { snapshot, requiredTextMessageIds: [...required], requiredNotice, provenance,
    diagnostics: { enabled: true, policySha256, sourceSha256, sourceDocumentOccurrences: count, retainedDocumentOccurrences: retained.length,
      omittedDocumentOccurrences: count - retained.length, retainedDocumentBytes: retained.reduce((sum, ref) => sum + ref.bytes, 0), uniqueRetainedDocuments: new Set(retained.map(ref => ref.id)).size,
      metadataBytes, noticeBytes, metadataTokenEstimate: { tokens: noticeBytes, source: 'utf8-byte-upper-bound', estimated: true }, documentTokens: null, summarized: false, activeCutoffCreated: false } };
}
