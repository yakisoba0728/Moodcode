import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { EngineError, type ArtifactReference, type JsonObject, type Run, type SessionControl, type Workspace } from '@moodcode/contracts';
import type { SessionDocument, SessionDocumentStore } from '../session-state/index.js';
import { boundedJson } from '../artifacts/validation.js';

export const VERIFICATION_LIMITS = Object.freeze({ maxRegistrations: 64, maxChecks: 16, maxPlans: 3, maxRepairs: 2, maxReceipts: 48, maxIndexRuns: 64, maxDocumentBytes: 196_608, maxCommandBytes: 16_384, maxOutputBytes: 1_048_576, maxTimeoutMs: 300_000 });
export interface VerificationStore extends SessionDocumentStore {
  getRun(id: string): Run; getWorkspace(id: string): Workspace;
  getSessionControl(sessionId: string): SessionControl;
  /** Root store checks active Run and publishes this document CAS in one primary transaction. */
  putActiveRunDocument(runId: string, kind: string, expectedRevision: number, data: JsonObject): SessionDocument;
}
export interface VerificationSource { sha256: string; revision: string; checkpointId: string | null }
export interface VerificationCommandCapability { producer: 'engine-owned-run-command'; platform: string; supported: boolean; catalogueRevision: number }
/** Host-only callback; the caller captures the actual live outer ToolContext separately. */
export type VerificationConsumedSettlementWriter = (kind: string, expectedRevision: number, data: JsonObject) => SessionDocument;
export interface VerificationCheckRegistration {
  id: string; revision: number; workspaceId: string;
  command: string; cwd: string; profileId: string; profileRevision: string;
  sourceRevision: string; timeoutMs: number; maxOutputBytes: number; required: boolean;
}
export interface VerificationCheck extends VerificationCheckRegistration { registrationSha256: string }
export interface VerificationPlan {
  schemaVersion: 1; id: string; revision: number; sessionId: string; runId: string; workspaceId: string; workspaceRoot: string;
  createdAt: string; source: VerificationSource; runConfigSha256: string; registryRevision: number; checks: VerificationCheck[];
  maxRepairs: number;
  budget: { maxExecutions: number; maxDurationMs: number; maxOutputBytes: number; allocation: 'run-ceiling-only-not-reservation' };
  executionAuthority: 'none'; planSha256: string;
}
export type VerificationStatus = 'pass' | 'fail' | 'skipped' | 'unsupported' | 'timeout' | 'cancelled' | 'uncertain' | 'stale';
export interface VerificationObservation {
  disposition: 'executed' | 'skipped' | 'unsupported';
  command: string; cwd: string; profileId: string; profileRevision: string;
  toolCallId: string; preparedFingerprint: string; sourceBefore: VerificationSource; sourceAfter: VerificationSource | null;
  executionCheckpointId: string | null; exitCode: number | null; signal: string | null;
  started: boolean; cancelled: boolean; timedOut: boolean;
  cleanup: { confirmed: boolean | null; scope: 'posix-process-group' | 'windows-job' | 'not-dispatched' | 'unknown'; evidenceSha256: string | null };
  observedOutputBytes: number | null; outputAccountingComplete: boolean; artifactRefs: ArtifactReference[];
  /** False when the owned producer outcome or its published evidence is incomplete. */
  executionComplete?: boolean;
  commandCapability?: VerificationCommandCapability;
  reasonCode: string | null;
}
export interface VerificationReceipt {
  schemaVersion: 1; id: string; sessionId: string; runId: string; workspaceId: string;
  planId: string; planSha256: string; checkId: string; registrationSha256: string;
  attempt: number; toolCallId: string; preparedFingerprint: string; sourceBefore: VerificationSource;
  phase: 'prepared' | 'dispatched' | 'settled'; status: VerificationStatus | null;
  createdAt: string; dispatchedAt: string | null; settledAt: string | null;
  observation: VerificationObservation | null; sourceStale: boolean | null;
  recovery: 'none' | 'restart-without-outcome' | 'producer-without-outcome'; receiptSha256: string;
}
export interface VerificationState {
  schemaVersion: 1; sessionId: string; runId: string; workspaceId: string;
  plans: VerificationPlan[]; receipts: VerificationReceipt[];
}
export interface VerificationSnapshot extends VerificationState { revision: number }
export interface VerificationPlanSelection { checkIds: string[]; source: VerificationSource; maxRepairs?: number }
export interface VerificationBegin {
  checkId: string; toolCallId: string; preparedFingerprint: string; source: VerificationSource;
}
export interface VerificationReceiptResult { revision: number; receipt: VerificationReceipt }
export interface VerificationIndexPage {
  revision: number; runIds: string[]; nextCursor: string | null;
  coverage: 'bounded-discovery-index-only'; receiptAuthority: false;
}
export type VerificationClock = () => string;

export function verificationFail(code: string, message: string): never { throw new EngineError(code, message); }
export function verificationHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function verificationPlain(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) verificationFail('INVALID_VERIFICATION_DATA', 'Verification accepts plain records');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) verificationFail('INVALID_VERIFICATION_DATA', 'Verification rejects unknown fields, accessors and symbols');
  }
}
export function verificationText(value: unknown, max = 256): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) verificationFail('INVALID_VERIFICATION_DATA', 'Verification requires bounded identity text');
}
export function verificationNumber(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) verificationFail('INVALID_VERIFICATION_DATA', 'Verification number is outside its bounded range');
}
export function verificationDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) verificationFail('INVALID_VERIFICATION_DATA', 'Verification digest must be a lowercase SHA-256');
}
export function verificationTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) verificationFail('INVALID_VERIFICATION_DATA', 'Verification timestamp must be a canonical ISO time');
}
export function normalizeVerificationSource(value: VerificationSource): VerificationSource {
  verificationPlain(value, ['sha256', 'revision', 'checkpointId']); verificationDigest(value.sha256); verificationText(value.revision);
  if (value.checkpointId !== null) verificationText(value.checkpointId);
  return { sha256: value.sha256, revision: value.revision, checkpointId: value.checkpointId };
}
export function normalizeVerificationCommandCapability(value: VerificationCommandCapability, catalogueRevision?: number): VerificationCommandCapability {
  verificationPlain(value, ['producer', 'platform', 'supported', 'catalogueRevision']); verificationText(value.platform, 32); verificationNumber(value.catalogueRevision);
  if (value.producer !== 'engine-owned-run-command' || !/^[a-z0-9]+$/u.test(value.platform) || typeof value.supported !== 'boolean' || value.supported !== (value.platform !== 'win32') || catalogueRevision !== undefined && value.catalogueRevision !== catalogueRevision) verificationFail('INVALID_VERIFICATION_COMMAND_CAPABILITY', 'Command capability must match the actual native producer and platform semantics');
  return { producer: value.producer, platform: value.platform, supported: value.supported, catalogueRevision: value.catalogueRevision };
}
export function verificationJson(value: unknown): JsonObject {
  let nodes = 0; const ancestors = new Set<object>();
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 32) verificationFail('VERIFICATION_DOCUMENT_LIMIT', 'Verification structured data exceeds its inspection budget');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') { if (Buffer.byteLength(item) > VERIFICATION_LIMITS.maxDocumentBytes) verificationFail('VERIFICATION_DOCUMENT_LIMIT', 'Verification string exceeds its byte budget'); return; }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(item)) || ancestors.has(item)) verificationFail('INVALID_VERIFICATION_DATA', 'Verification JSON rejects proxies, cycles and non-data objects');
    ancestors.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) verificationFail('INVALID_VERIFICATION_DATA', 'Verification JSON rejects accessors and symbols');
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  inspect(value, 0);
  let result;
  try { result = boundedJson(value, VERIFICATION_LIMITS.maxDocumentBytes); }
  catch (error) { if (error instanceof EngineError) throw error; return verificationFail('VERIFICATION_DOCUMENT_LIMIT', 'Verification document exceeds its byte budget'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return verificationFail('INVALID_VERIFICATION_DATA', 'Verification document must be a JSON object');
  return result;
}
