import path from 'node:path';
import { EngineError } from '@moodcode/contracts';
import { canonicalJson, canonicalSha256, reseal, sameCanonical, sha256Hex } from '../shared/canonical.js';
import { assertNativeSignal, exactKeys, plainJson, plainRecord, recordGuards, type PlainJsonFault, type PlainJsonOptions, type RecordFault } from '../shared/data.js';
import type {
  KnowledgeArchiveRow, KnowledgeCandidate, KnowledgeGenerationEvidence, KnowledgeGenerationPlan,
  KnowledgeHostBinding, KnowledgeSourceManifest, KnowledgeStorageTable, KnowledgeTarget, KnowledgeUsage,
  PrepareKnowledgeGeneration, SetWorkspaceTrust, TrustRevision, TrustSourcePin,
} from './types.js';

export const KNOWLEDGE_LIMITS = Object.freeze({ rowBytes: 65_536, bodyBytes: 16_384, sourceBytes: 262_144, trustFileBytes: 32_768, trustSources: 32, sourcePins: 64, pageRows: 32, pageBytes: 1_048_576, handles: 128 });
export function knowledgeError(code: string, message: string): never { throw new EngineError(code, message); }
export { canonicalJson as canonicalKnowledge, canonicalSha256 as knowledgeHash, sameCanonical as sameKnowledge, sha256Hex as sha256 };
export const UNKNOWN_KNOWLEDGE_USAGE: KnowledgeUsage = Object.freeze({ inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null });
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return knowledgeError('INVALID_KNOWLEDGE', 'Expected a plain knowledge object');
  return value as ObjectValue;
}
function fields(value: ObjectValue, names: readonly string[]): void {
  if (!exactKeys(value, names)) knowledgeError('INVALID_KNOWLEDGE', 'Knowledge object fields do not match the contract');
}
const RECORD_FAULTS: Record<RecordFault, string> = {
  id: 'Knowledge identity must be bounded text', integer: 'Knowledge count must be a bounded nonnegative safe integer', sha: 'Knowledge hash must be a lowercase SHA-256 digest',
  stamp: 'Knowledge timestamp must use canonical UTC ISO format', exact: 'Knowledge object fields do not match the contract', hash: 'Knowledge record does not match its immutable digest',
};
const guards = recordGuards({ json: immutableKnowledgeJson, fail: fault => knowledgeError(fault === 'hash' ? 'KNOWLEDGE_HASH_MISMATCH' : 'INVALID_KNOWLEDGE', RECORD_FAULTS[fault]) });
export const { id: identifier, integer, stamp, seal: withKnowledgeHash } = guards;
const { sha: digest, verify } = guards;
export function resealKnowledge<T extends { readonly sha256: string }>(record: T, patch: Partial<Omit<T, 'sha256'>>): T { return reseal(record, patch, immutableKnowledgeJson); }
/** Hostile host input, read through descriptors without running a getter or proxy trap; returns a null-prototype snapshot. */
export function knowledgeHostRecord(value: unknown, required: readonly string[], optional: readonly string[], code: string, message: string, fieldsMessage = message, descriptorMessage = fieldsMessage): Record<string, unknown> {
  const record = plainRecord(value, required, optional, fault => knowledgeError(code, fault === 'shape' ? message : fault === 'fields' ? fieldsMessage : descriptorMessage));
  return Object.assign(Object.create(null) as Record<string, unknown>, record);
}
export function assertKnowledgeSignal(value: unknown, code: string, message: string, overrideMessage = message): asserts value is AbortSignal {
  assertNativeSignal(value, fault => knowledgeError(code, fault === 'shape' ? message : overrideMessage));
}
function nullable<T>(value: unknown, check: (value: unknown) => T): T | null { return value === null ? null : check(value); }
export function samePhysicalRoot(left: KnowledgeHostBinding, right: KnowledgeHostBinding): boolean {
  return left.workspaceId === right.workspaceId && left.root === right.root && left.rootDevice === right.rootDevice && left.rootInode === right.rootInode;
}
function physical(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,32}$/u.test(value)) return knowledgeError('INVALID_KNOWLEDGE', 'Physical source identity must be a decimal device or inode');
  return value;
}
export function exactKnowledgePath(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4_096 || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /[:\u0000-\u001f\u007f]/u.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) return knowledgeError('INVALID_KNOWLEDGE_PATH', 'Knowledge paths must be exact relative workspace paths');
  return value;
}
function jsonFault(fault: PlainJsonFault): never {
  switch (fault) {
    case 'structure': return knowledgeError('KNOWLEDGE_LIMIT', 'Knowledge JSON structure exceeds its bound');
    case 'bytes': case 'text': return knowledgeError('KNOWLEDGE_LIMIT', 'Knowledge text must be bounded valid UTF-8');
    case 'items': case 'holes': case 'element': return knowledgeError('KNOWLEDGE_LIMIT', 'Knowledge arrays must be dense and bounded');
    case 'prototype': return knowledgeError('INVALID_KNOWLEDGE', 'Knowledge records cannot contain custom prototypes');
    case 'symbol': case 'accessor': return knowledgeError('INVALID_KNOWLEDGE', 'Knowledge records cannot contain accessors or symbol keys');
    case 'property': return knowledgeError('INVALID_KNOWLEDGE', 'Knowledge object properties must be ordinary data');
    default: return knowledgeError('INVALID_KNOWLEDGE', 'Knowledge values must be ordinary immutable JSON');
  }
}
const KNOWLEDGE_JSON: PlainJsonOptions = { maxBytes: KNOWLEDGE_LIMITS.rowBytes, maxNodes: 4_096, maxDepth: 12, maxItems: 256, accounting: 'text', wellFormed: true, rejectKeys: ['__proto__'], freeze: true, fail: jsonFault };
/** Reject executable JSON, sparse arrays, proxies and oversized structures before serialization. */
export function immutableKnowledgeJson<T>(input: T): T {
  const result = plainJson(input, KNOWLEDGE_JSON);
  if (Buffer.byteLength(JSON.stringify(result)) > KNOWLEDGE_LIMITS.rowBytes) knowledgeError('KNOWLEDGE_LIMIT', 'Serialized knowledge row exceeds its byte bound');
  return result;
}
function assertHash(record: ObjectValue): void {
  if (Buffer.byteLength(JSON.stringify(record)) > KNOWLEDGE_LIMITS.rowBytes - 4_096) knowledgeError('KNOWLEDGE_LIMIT', 'Knowledge record must leave room for its archive envelope');
  verify(record);
}
export function validateBinding(value: unknown): KnowledgeHostBinding {
  const result = object(immutableKnowledgeJson(value)); fields(result, ['workspaceId', 'root', 'rootDevice', 'rootInode', 'storageBindingSha256']);
  identifier(result.workspaceId); physical(result.rootDevice); physical(result.rootInode); digest(result.storageBindingSha256);
  if (typeof result.root !== 'string' || Buffer.byteLength(result.root) > 4_096 || !path.isAbsolute(result.root) || path.resolve(result.root) !== result.root || /[\u0000-\u001f]/u.test(result.root)) knowledgeError('INVALID_KNOWLEDGE', 'Knowledge root must be a canonical absolute path');
  return result as unknown as KnowledgeHostBinding;
}
function trustSources(value: unknown): readonly TrustSourcePin[] {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_LIMITS.trustSources) return knowledgeError('KNOWLEDGE_LIMIT', 'Instruction source count exceeds its bound');
  const paths = new Set<string>();
  for (const input of value) {
    const item = object(input); fields(item, ['path', 'sha256', 'bytes', 'device', 'inode']);
    const selected = exactKnowledgePath(item.path); digest(item.sha256); integer(item.bytes, KNOWLEDGE_LIMITS.trustFileBytes); physical(item.device); physical(item.inode);
    if (paths.has(selected)) knowledgeError('INVALID_KNOWLEDGE', 'Instruction source paths must be unique'); paths.add(selected);
  }
  return value as readonly TrustSourcePin[];
}
function trustInput(result: ObjectValue): void {
  identifier(result.workspaceId); identifier(result.requestId); integer(result.expectedRevision);
  const binding = validateBinding(result.binding); if (binding.workspaceId !== result.workspaceId) knowledgeError('KNOWLEDGE_SCOPE_MISMATCH', 'Trust binding belongs to another workspace');
  const sources = trustSources(result.sources); nullable(result.expiresAt, stamp);
  if (result.decision !== 'allow' && result.decision !== 'deny') knowledgeError('INVALID_KNOWLEDGE', 'Trust requires an explicit host allow or deny decision');
  if (result.decision === 'deny' && (sources.length || result.expiresAt !== null)) knowledgeError('INVALID_KNOWLEDGE', 'Trust revocation cannot carry allowed sources or an expiry');
}
export function validateTrustInput(value: unknown): SetWorkspaceTrust {
  const result = object(immutableKnowledgeJson(value)); fields(result, ['workspaceId', 'requestId', 'expectedRevision', 'decision', 'binding', 'sources', 'expiresAt']); trustInput(result);
  return result as unknown as SetWorkspaceTrust;
}
export function validateTrustRevision(value: unknown): TrustRevision {
  const result = object(immutableKnowledgeJson(value)); fields(result, ['id', 'workspaceId', 'revision', 'previousId', 'requestId', 'decision', 'binding', 'sources', 'createdAt', 'expiresAt', 'sha256']);
  identifier(result.id); nullable(result.previousId, identifier); stamp(result.createdAt);
  const revision = integer(result.revision); if (revision < 1 || (revision === 1) !== (result.previousId === null)) knowledgeError('INVALID_KNOWLEDGE', 'Trust history must have a consistent revision predecessor');
  trustInput({ ...result, expectedRevision: revision - 1 });
  if (result.expiresAt !== null && Date.parse(stamp(result.expiresAt)) <= Date.parse(stamp(result.createdAt))) knowledgeError('INVALID_KNOWLEDGE', 'Trust expiry must follow creation');
  assertHash(result); return result as unknown as TrustRevision;
}
export function validateSource(value: unknown): KnowledgeSourceManifest {
  const result = object(immutableKnowledgeJson(value)); fields(result, ['projection', 'sha256', 'bytes', 'pins']); digest(result.sha256); integer(result.bytes, KNOWLEDGE_LIMITS.sourceBytes);
  if (result.projection !== 'host-selected-text-v1' || !Array.isArray(result.pins) || !result.pins.length || result.pins.length > KNOWLEDGE_LIMITS.sourcePins) knowledgeError('INVALID_KNOWLEDGE', 'Knowledge source must use a bounded explicit host text selection');
  const identities = new Set<string>();
  for (const input of result.pins) {
    const item = object(input); let identity: string;
    if (item.kind === 'message') {
      fields(item, ['kind', 'sessionId', 'runId', 'messageId', 'sha256']); identifier(item.sessionId); nullable(item.runId, identifier); digest(item.sha256); identity = `message:${identifier(item.sessionId)}:${identifier(item.messageId)}`;
    } else if (item.kind === 'file') {
      fields(item, ['kind', 'path', 'sha256', 'bytes', 'device', 'inode']); identity = `file:${exactKnowledgePath(item.path)}`; digest(item.sha256); integer(item.bytes, KNOWLEDGE_LIMITS.sourceBytes); physical(item.device); physical(item.inode);
    } else return knowledgeError('INVALID_KNOWLEDGE', 'Unknown knowledge source pin');
    if (identities.has(identity)) knowledgeError('INVALID_KNOWLEDGE', 'Knowledge source pins must be unique'); identities.add(identity);
  }
  return result as unknown as KnowledgeSourceManifest;
}
export function validateTarget(value: unknown): KnowledgeTarget {
  const result = object(immutableKnowledgeJson(value)); integer(result.revision); nullable(result.sha256, digest);
  if (result.kind === 'workspace-document') { fields(result, ['kind', 'key', 'revision', 'sha256']); identifier(result.key); }
  else if (result.kind === 'workspace-file') {
    fields(result, ['kind', 'path', 'revision', 'sha256', 'device', 'inode']); exactKnowledgePath(result.path); nullable(result.device, physical); nullable(result.inode, physical);
    if ((result.sha256 === null) !== (result.device === null) || (result.device === null) !== (result.inode === null)) knowledgeError('INVALID_KNOWLEDGE', 'File target preimage and physical identity must agree');
  } else return knowledgeError('INVALID_KNOWLEDGE', 'Unknown knowledge target');
  if (result.revision === 0 && result.sha256 !== null || result.kind === 'workspace-document' && (result.revision === 0) !== (result.sha256 === null))
    knowledgeError('INVALID_KNOWLEDGE', 'Revision zero requires an absent preimage; document absence has no native file tombstone');
  return result as unknown as KnowledgeTarget;
}
const planInputFields = ['workspaceId', 'requestId', 'binding', 'expectedTrustRevision', 'source', 'target', 'providerId', 'modelId', 'requestSha256', 'requestBytes', 'maxOutputBytes', 'expiresAt'] as const;
function planInput(result: ObjectValue): void {
  identifier(result.workspaceId); identifier(result.requestId); identifier(result.providerId); identifier(result.modelId); digest(result.requestSha256); stamp(result.expiresAt);
  const binding = validateBinding(result.binding); if (binding.workspaceId !== result.workspaceId) knowledgeError('KNOWLEDGE_SCOPE_MISMATCH', 'Generation plan belongs to another workspace binding');
  if (integer(result.expectedTrustRevision) < 1 || integer(result.requestBytes, KNOWLEDGE_LIMITS.sourceBytes) < 1 || integer(result.maxOutputBytes, KNOWLEDGE_LIMITS.bodyBytes) < 1) knowledgeError('INVALID_KNOWLEDGE', 'Generation plan requires positive trust and request/output budgets');
  validateSource(result.source); validateTarget(result.target);
}
export function validateGenerationInput(value: unknown): PrepareKnowledgeGeneration {
  const result = object(immutableKnowledgeJson(value)); fields(result, planInputFields); planInput(result); return result as unknown as PrepareKnowledgeGeneration;
}
export function validateGenerationPlan(value: unknown): KnowledgeGenerationPlan {
  const result = object(immutableKnowledgeJson(value)); fields(result, [...planInputFields, 'id', 'trustRevisionId', 'state', 'toolCount', 'createdAt', 'sha256']); planInput(result); identifier(result.id); identifier(result.trustRevisionId); stamp(result.createdAt);
  if (result.state !== 'pending' || result.toolCount !== 0 || Date.parse(stamp(result.expiresAt)) <= Date.parse(stamp(result.createdAt))) knowledgeError('INVALID_KNOWLEDGE', 'Generation plans must remain pending, tool-free and unexpired at creation');
  assertHash(result); return result as unknown as KnowledgeGenerationPlan;
}
export function validateUsage(value: unknown): KnowledgeUsage {
  const result = object(immutableKnowledgeJson(value)); fields(result, ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningTokens']);
  for (const field of Object.values(result)) nullable(field, integer);
  if (result.inputTokens !== null && result.cachedInputTokens !== null && (result.cachedInputTokens as number) > (result.inputTokens as number) || result.outputTokens !== null && result.reasoningTokens !== null && (result.reasoningTokens as number) > (result.outputTokens as number)) knowledgeError('INVALID_KNOWLEDGE', 'Knowledge usage breakdown exceeds its total');
  return result as unknown as KnowledgeUsage;
}
export function validateGenerationEvidence(value: unknown): KnowledgeGenerationEvidence {
  const result = object(immutableKnowledgeJson(value)); fields(result, ['ownerId', 'planId', 'workspaceId', 'bindingSha256', 'requestSha256', 'providerId', 'modelId', 'outputSha256', 'outputBytes', 'toolCount', 'completed', 'cleanupConfirmed', 'usage']);
  for (const key of ['ownerId', 'planId', 'workspaceId', 'providerId', 'modelId']) identifier(result[key]);
  for (const key of ['bindingSha256', 'requestSha256', 'outputSha256']) digest(result[key]);
  if (integer(result.outputBytes, KNOWLEDGE_LIMITS.bodyBytes) < 1 || result.toolCount !== 0 || result.completed !== true || result.cleanupConfirmed !== true) knowledgeError('KNOWLEDGE_GENERATION_UNSETTLED', 'Candidate requires completed tool-free output and confirmed native owner cleanup');
  validateUsage(result.usage); return result as unknown as KnowledgeGenerationEvidence;
}
export function validateCandidate(value: unknown): KnowledgeCandidate {
  const result = object(immutableKnowledgeJson(value)); fields(result, ['id', 'workspaceId', 'planId', 'generationOwnerId', 'binding', 'trustRevisionId', 'trustRevision', 'source', 'target', 'providerId', 'modelId', 'requestSha256', 'usage', 'toolCount', 'cleanupConfirmed', 'state', 'body', 'bodySha256', 'createdAt', 'expiresAt', 'sha256']);
  for (const key of ['id', 'workspaceId', 'planId', 'generationOwnerId', 'trustRevisionId', 'providerId', 'modelId']) identifier(result[key]);
  const binding = validateBinding(result.binding); if (binding.workspaceId !== result.workspaceId) knowledgeError('KNOWLEDGE_SCOPE_MISMATCH', 'Candidate belongs to another workspace binding');
  if (integer(result.trustRevision) < 1 || result.state !== 'pending' || result.toolCount !== 0 || result.cleanupConfirmed !== true) knowledgeError('INVALID_KNOWLEDGE', 'Candidates can only be pending tool-free observations');
  validateSource(result.source); validateTarget(result.target); validateUsage(result.usage); digest(result.requestSha256); digest(result.bodySha256); stamp(result.createdAt); stamp(result.expiresAt);
  if (typeof result.body !== 'string' || !result.body.trim() || Buffer.byteLength(result.body) > KNOWLEDGE_LIMITS.bodyBytes || sha256Hex(result.body) !== result.bodySha256 || Date.parse(stamp(result.expiresAt)) <= Date.parse(stamp(result.createdAt))) knowledgeError('KNOWLEDGE_HASH_MISMATCH', 'Candidate body/expiry does not match its bounded observation');
  assertHash(result); return result as unknown as KnowledgeCandidate;
}
export const KNOWLEDGE_STORAGE_TABLES: readonly KnowledgeStorageTable[] = Object.freeze(['workspace_trust_revisions', 'workspace_trust_heads', 'knowledge_generation_plans', 'knowledge_candidates', 'knowledge_request_receipts', 'knowledge_import_pauses']);
/** Archive rows are historical evidence. Validation does not rebind or activate their authority. */
export function validateKnowledgeArchiveRow(value: unknown): KnowledgeArchiveRow {
  const row = object(immutableKnowledgeJson(value)); fields(row, ['table', 'key', 'workspaceId', 'data']); identifier(row.key); identifier(row.workspaceId);
  if (!KNOWLEDGE_STORAGE_TABLES.includes(row.table as KnowledgeStorageTable)) knowledgeError('INVALID_KNOWLEDGE', 'Unknown knowledge archive table');
  let data = object(row.data), key: string;
  switch (row.table) {
    case 'workspace_trust_revisions': data = validateTrustRevision(data) as unknown as ObjectValue; key = identifier(data.id); break;
    case 'knowledge_generation_plans': data = validateGenerationPlan(data) as unknown as ObjectValue; key = identifier(data.id); break;
    case 'knowledge_candidates': data = validateCandidate(data) as unknown as ObjectValue; key = identifier(data.id); break;
    case 'workspace_trust_heads': fields(data, ['workspaceId', 'revision', 'revisionId']); if (integer(data.revision) < 1) knowledgeError('INVALID_KNOWLEDGE', 'Trust head must reference a positive revision'); identifier(data.revisionId); key = identifier(data.workspaceId); break;
    case 'knowledge_request_receipts':
      fields(data, ['id', 'workspaceId', 'bindingSha256', 'requestId', 'operation', 'requestSha256', 'recordId']); digest(data.bindingSha256); digest(data.requestSha256); identifier(data.requestId); identifier(data.recordId);
      if (!['set-trust', 'prepare-generation', 'append-candidate'].includes(String(data.operation))) knowledgeError('INVALID_KNOWLEDGE', 'Unknown knowledge dedupe operation'); key = identifier(data.id); break;
    case 'knowledge_import_pauses': fields(data, ['workspaceId', 'archiveSha256', 'createdAt', 'state']); digest(data.archiveSha256); stamp(data.createdAt); if (data.state !== 'paused') knowledgeError('INVALID_KNOWLEDGE', 'Imported knowledge must remain paused'); key = identifier(data.workspaceId); break;
    default: return knowledgeError('INVALID_KNOWLEDGE', 'Unknown knowledge archive table');
  }
  if (key !== row.key || data.workspaceId !== row.workspaceId) knowledgeError('KNOWLEDGE_SCOPE_MISMATCH', 'Knowledge archive key/workspace does not match its body');
  return row as unknown as KnowledgeArchiveRow;
}
