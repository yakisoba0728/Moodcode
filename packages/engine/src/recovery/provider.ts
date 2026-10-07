import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { EngineError, type EngineEvent, type JsonObject, type Run } from '@moodcode/contracts';
import type { SqliteStore } from '../storage/index.js';
import type { NativeSessionStorage } from '../storage/native.js';
import { canonical } from './snapshot.js';
import { PROVIDER_RECOVERY_LIMITS, type ProviderRecoveryBudget, type ProviderRecoveryEvidence, type ProviderRecoveryPin,
  type ProviderRecoveryPreview, type ProviderRecoveryReceipt, type ProviderRecoveryRequest } from './provider-contract.js';
import { readProviderRecoveryBaseline, readProviderRecoveryEvidence, providerRecoveryPinsValid } from './provider-evidence.js';

export * from './provider-contract.js';
export const PROVIDER_RECOVERY_TABLES = ['provider_recovery_acknowledgments'] as const;
export const PROVIDER_RECOVERY_SCHEMA = `CREATE TABLE provider_recovery_acknowledgments (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES provider_attempts(id),
  session_id TEXT NOT NULL REFERENCES sessions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL REFERENCES runs(id), turn_id TEXT NOT NULL REFERENCES session_turns(id),
  request_id TEXT NOT NULL, binding_scope TEXT NOT NULL CHECK(length(binding_scope)=64),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  cleanup_record_sha256 TEXT NOT NULL CHECK(length(cleanup_record_sha256)=64), usage_sha256 TEXT CHECK(usage_sha256 IS NULL OR length(usage_sha256)=64),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64), context_baseline_sha256 TEXT NOT NULL CHECK(length(context_baseline_sha256)=64),
  pins_sha256 TEXT NOT NULL CHECK(length(pins_sha256)=64), startup_high_water TEXT NOT NULL,
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB))<=65536),
  UNIQUE(binding_scope,workspace_id,request_id), UNIQUE(binding_scope,attempt_id)
) STRICT;
CREATE INDEX provider_recovery_workspace ON provider_recovery_acknowledgments(workspace_id,binding_scope);`;

type Store = Pick<SqliteStore, 'getAttemptCleanup' | 'getTurn' | 'getAttempt'>;
type Row = Record<string, unknown>;
interface Audit {
  receipt: ProviderRecoveryReceipt;
  recordSha256: string; cleanupRecordSha256: string; usageSha256: string | null; sourceSha256: string;
  contextBaselineSha256: string; pinsSha256: string; startupHighWater: string; pins: ProviderRecoveryPin[];
}
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const validSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const highWater = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
function fail(suffix: string, message: string): never { throw new EngineError(`PROVIDER_RECOVERY_${suffix}`, message); }
function plain(value: unknown, keys?: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_REQUEST', 'Provider recovery accepts plain data only');
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || keys && !keys.includes(key) || !property?.enumerable || !('value' in property)) fail('INVALID_REQUEST', 'Provider recovery rejects accessors and unknown fields');
  }
}
export function validateProviderRecoveryRequest(value: unknown): ProviderRecoveryRequest {
  plain(value, ['sessionId', 'attemptId', 'requestId', 'fingerprint', 'acknowledged']);
  if (value.acknowledged !== true) fail('ACKNOWLEDGMENT_REQUIRED', 'Explicit acknowledgment of this exact provider preview is required');
  if (!identifier(value.sessionId) || !identifier(value.attemptId) || !identifier(value.requestId) || !validSha(value.fingerprint)) fail('INVALID_REQUEST', 'Provider recovery requires bounded owner and request identities');
  return { sessionId: value.sessionId, attemptId: value.attemptId, requestId: value.requestId, fingerprint: value.fingerprint, acknowledged: true };
}
export function captureProviderRecoveryHighWater(db: DatabaseSync): string {
  return String(db.prepare('SELECT CAST(coalesce(max(rowid),0) AS TEXT) AS ordinal FROM provider_attempts').get()!.ordinal);
}
function charge(budget: ProviderRecoveryBudget, bytes: unknown): void {
  if (!Number.isSafeInteger(bytes) || Number(bytes) < 0 || Number(bytes) > budget.max - budget.bytes) fail('LIMIT', 'Provider recovery exceeds its bounded evidence budget');
  budget.bytes += Number(bytes);
}
function parsed(text: string): unknown { try { return JSON.parse(text); } catch { return fail('SOURCE_CHANGED', 'Provider recovery acknowledgment is not valid JSON'); } }
function exactKeys(value: unknown, allowed: readonly string[]): value is Row {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)));
}
function budget(): ProviderRecoveryBudget { return { bytes: 0, max: PROVIDER_RECOVERY_LIMITS.maxEvidenceBytes }; }
function fingerprint(evidence: ProviderRecoveryEvidence, scope: string, contextBaselineSha256: string, pinsSha256: string, startupHighWater: string): string {
  return sha({ version: 1, sessionId: evidence.attempt.sessionId, workspaceId: evidence.run.workspaceId, runId: evidence.run.id,
    turnId: evidence.turn.id, attemptId: evidence.attempt.id, bindingScope: scope,
    requestSha256: evidence.cleanup.requestSha256, requestBytes: evidence.cleanup.requestBytes, recordSha256: evidence.recordSha256,
    cleanupRecordSha256: evidence.cleanupRecordSha256, usageSha256: evidence.usageSha256, sourceSha256: evidence.sourceSha256,
    contextBaselineSha256, pinsSha256, startupHighWater });
}

/** A host decision observes uncertainty; it neither confirms a model outcome nor changes execution records. */
export class ProviderRecoveryStorage {
  constructor(private readonly native: NativeSessionStorage, private readonly store: Store, private readonly options: {
    bindingScope(workspaceId: string): string; startupHighWater: string;
    appendLegacy(run: Run, type: string, payload: JsonObject): EngineEvent;
  }) {
    if (!highWater(options.startupHighWater)) fail('INVALID_REQUEST', 'Recovery requires the original ordinary Attempt boot frontier');
    this.options = Object.freeze({ bindingScope: options.bindingScope, startupHighWater: options.startupHighWater, appendLegacy: options.appendLegacy });
  }
  private get db() { return this.native.database; }
  private read<T>(operation: () => T): T {
    this.native.hooks.assertOpen();
    if (this.db.isTransaction) return operation();
    this.db.exec('BEGIN');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private scope(workspaceId: string): string {
    const value = this.options.bindingScope(workspaceId);
    if (!validSha(value)) fail('BINDING_CHANGED', 'Provider recovery requires an unchanged physical storage binding');
    return value;
  }
  private target(sessionId: string, id: string): Row {
    if (!identifier(sessionId) || !identifier(id)) fail('INVALID_REQUEST', 'Provider recovery requires bounded session and Attempt identities');
    const row = this.db.prepare(`SELECT a.id,a.session_id,a.run_id,a.turn_id,a.state,CAST(a.rowid AS TEXT) AS ordinal,
      r.workspace_id,r.session_id AS run_session_id,s.workspace_id AS session_workspace_id
      FROM provider_attempts a JOIN runs r ON r.id=a.run_id JOIN sessions s ON s.id=a.session_id WHERE a.id=?`).get(id);
    if (!row) fail('NOT_FOUND', 'Ordinary provider Attempt was not found');
    if (row.session_id !== sessionId || row.run_session_id !== sessionId || row.workspace_id !== row.session_workspace_id) fail('OWNER_MISMATCH', 'Provider Attempt belongs to another owner');
    if (![row.id,row.session_id,row.run_id,row.turn_id,row.workspace_id].every(identifier)
      || typeof row.ordinal !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(row.ordinal)) fail('SOURCE_CHANGED', 'Provider Attempt SQL owner metadata is invalid');
    return row;
  }
  private ledger(where: string, ...parameters: string[]): Row | undefined {
    return this.db.prepare(`SELECT id,attempt_id,session_id,workspace_id,run_id,turn_id,request_id,binding_scope,fingerprint,
      record_sha256,cleanup_record_sha256,usage_sha256,source_sha256,context_baseline_sha256,pins_sha256,startup_high_water,length(CAST(data AS BLOB)) AS bytes
      FROM provider_recovery_acknowledgments WHERE ${where} LIMIT 1`).get(...parameters);
  }
  private audit(row: Row, allowance: ProviderRecoveryBudget): Audit {
    if (!Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > PROVIDER_RECOVERY_LIMITS.maxLedgerBytes) fail('LIMIT', 'Provider acknowledgment exceeds its durable read bound');
    charge(allowance, row.bytes);
    const value = parsed(String(this.db.prepare('SELECT data FROM provider_recovery_acknowledgments WHERE id=?').get(String(row.id))!.data));
    if (!exactKeys(value, ['receipt','recordSha256','cleanupRecordSha256','usageSha256','sourceSha256','contextBaselineSha256','pinsSha256','startupHighWater','pins'])) fail('SOURCE_CHANGED', 'Provider acknowledgment must contain bounded audit data');
    const receipt = value.receipt;
    if (!exactKeys(receipt, ['version','id','requestId','sessionId','workspaceId','runId','turnId','attemptId','fingerprint','bindingScope','acknowledgedAt','state','cleanupConfirmed','providerOutcomeConfirmed','providerRetried','executionResumed','checkpointActivated','duplicate'])
      || receipt.version !== 1 || receipt.id !== row.id || receipt.attemptId !== row.attempt_id || receipt.sessionId !== row.session_id
      || receipt.workspaceId !== row.workspace_id || receipt.runId !== row.run_id || receipt.turnId !== row.turn_id || receipt.requestId !== row.request_id
      || receipt.bindingScope !== row.binding_scope || receipt.fingerprint !== row.fingerprint || receipt.state !== 'uncertain' || receipt.cleanupConfirmed !== true
      || receipt.providerOutcomeConfirmed !== false || receipt.providerRetried !== false || receipt.executionResumed !== false || receipt.checkpointActivated !== false || receipt.duplicate !== false
      || ![receipt.id,receipt.requestId,receipt.sessionId,receipt.workspaceId,receipt.runId,receipt.turnId,receipt.attemptId].every(identifier)
      || !validSha(receipt.fingerprint) || !validSha(receipt.bindingScope)
      || typeof receipt.acknowledgedAt !== 'string' || receipt.acknowledgedAt.length > 64 || !Number.isFinite(Date.parse(receipt.acknowledgedAt)) || new Date(receipt.acknowledgedAt).toISOString() !== receipt.acknowledgedAt
      || value.recordSha256 !== row.record_sha256 || !validSha(value.recordSha256) || value.cleanupRecordSha256 !== row.cleanup_record_sha256 || !validSha(value.cleanupRecordSha256)
      || value.usageSha256 !== row.usage_sha256 || value.usageSha256 !== null && !validSha(value.usageSha256)
      || value.sourceSha256 !== row.source_sha256 || !validSha(value.sourceSha256) || value.contextBaselineSha256 !== row.context_baseline_sha256 || !validSha(value.contextBaselineSha256)
      || value.pinsSha256 !== row.pins_sha256 || !validSha(value.pinsSha256) || value.startupHighWater !== row.startup_high_water || !highWater(value.startupHighWater)
      || !Array.isArray(value.pins) || value.pins.length > 1024 || value.pins.some(pin => !exactKeys(pin, ['table','id','sha256']) || !['messages','context_revisions'].includes(String(pin.table)) || !identifier(pin.id) || !validSha(pin.sha256))
      || new Set(value.pins.map(pin => `${pin.table}:${pin.id}`)).size !== value.pins.length || sha(value.pins) !== value.pinsSha256) fail('SOURCE_CHANGED', 'Provider acknowledgment and SQL identity disagree');
    return value as unknown as Audit;
  }
  private valid(audit: Audit, evidence: ProviderRecoveryEvidence, scope: string, allowance: ProviderRecoveryBudget): boolean {
    const receipt = audit.receipt;
    return receipt.bindingScope === scope && receipt.sessionId === evidence.attempt.sessionId && receipt.workspaceId === evidence.run.workspaceId
      && receipt.runId === evidence.run.id && receipt.turnId === evidence.turn.id && receipt.attemptId === evidence.attempt.id
      && evidence.attempt.state === 'uncertain' && evidence.cleanup.state === 'confirmed' && evidence.cleanup.cleanupConfirmed === true
      && audit.recordSha256 === evidence.recordSha256 && audit.cleanupRecordSha256 === evidence.cleanupRecordSha256
      && audit.usageSha256 === evidence.usageSha256 && audit.sourceSha256 === evidence.sourceSha256
      && receipt.fingerprint === fingerprint(evidence, scope, audit.contextBaselineSha256, audit.pinsSha256, audit.startupHighWater)
      && providerRecoveryPinsValid(this.db, audit.pins, allowance);
  }
  private previewInTransaction(sessionId: string, id: string): ProviderRecoveryPreview {
    const header = this.target(sessionId, id), scope = this.scope(String(header.workspace_id));
    const base: ProviderRecoveryPreview = { version: 1, status: 'blocked', fingerprint: null, blockers: [], sessionId,
      workspaceId: String(header.workspace_id), runId: String(header.run_id), turnId: String(header.turn_id), attemptId: id, bindingScope: scope,
      requestSha256: null, requestBytes: null, recordSha256: null, cleanupRecordSha256: null, usageSha256: null, sourceSha256: null, contextBaselineSha256: null };
    if (BigInt(String(header.ordinal)) > BigInt(this.options.startupHighWater)) base.blockers.push('PROVIDER_RECOVERY_RESTART_REQUIRED');
    if (header.state !== 'uncertain') base.blockers.push('PROVIDER_RECOVERY_NOT_NEEDED');
    if (this.db.prepare("SELECT 1 FROM runs WHERE workspace_id=? AND state IN ('created','running','awaiting_approval','cancelling') LIMIT 1").get(base.workspaceId)) base.blockers.push('PROVIDER_RECOVERY_ACTIVE_RUN');
    if (base.blockers.length) return base;
    try {
      const allowance = budget(), evidence = readProviderRecoveryEvidence(this.db, this.store, sessionId, id, allowance);
      Object.assign(base, { requestSha256: evidence.cleanup.requestSha256, requestBytes: evidence.cleanup.requestBytes,
        recordSha256: evidence.recordSha256, cleanupRecordSha256: evidence.cleanupRecordSha256, usageSha256: evidence.usageSha256, sourceSha256: evidence.sourceSha256 });
      const existing = this.ledger('attempt_id=? AND binding_scope=?', id, scope);
      if (existing) {
        if (existing.session_id !== sessionId || existing.workspace_id !== base.workspaceId || existing.run_id !== base.runId || existing.turn_id !== base.turnId) fail('SOURCE_CHANGED', 'Provider acknowledgment SQL owner changed');
        const audit = this.audit(existing, allowance);
        if (!this.valid(audit, evidence, scope, allowance)) fail('SOURCE_CHANGED', 'An existing provider decision no longer matches its immutable evidence');
        return { ...base, status: 'acknowledged', fingerprint: audit.receipt.fingerprint, contextBaselineSha256: audit.contextBaselineSha256, acknowledgment: structuredClone(audit.receipt) };
      }
      const baseline = readProviderRecoveryBaseline(this.db, sessionId, allowance);
      const preview = { ...base, status: 'eligible' as const, contextBaselineSha256: baseline.hash };
      return { ...preview, fingerprint: fingerprint(evidence, scope, baseline.hash, sha(baseline.pins), this.options.startupHighWater) };
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      return { ...base, blockers: [error.code] };
    }
  }
  preview(sessionId: string, id: string): ProviderRecoveryPreview { return this.read(() => this.previewInTransaction(sessionId, id)); }
  /** Exact retries are historical receipts; current context and blockers cannot turn them into execution authorization. */
  findReceipt(value: ProviderRecoveryRequest): ProviderRecoveryReceipt | null {
    const request = validateProviderRecoveryRequest(value);
    return this.read(() => this.findReceiptInTransaction(request));
  }
  private findReceiptInTransaction(request: ProviderRecoveryRequest): ProviderRecoveryReceipt | null {
    const target = this.target(request.sessionId, request.attemptId), scope = this.scope(String(target.workspace_id));
    const row = this.ledger('workspace_id=? AND binding_scope=? AND request_id=?', String(target.workspace_id), scope, request.requestId);
    if (!row) return null;
    // SQL owner checks precede the bounded ledger body fetch.
    if (row.session_id !== request.sessionId || row.attempt_id !== request.attemptId || row.run_id !== target.run_id || row.turn_id !== target.turn_id || row.fingerprint !== request.fingerprint) fail('REQUEST_CONFLICT', 'Provider recovery request ID belongs to another exact decision');
    return { ...structuredClone(this.audit(row, { bytes: 0, max: PROVIDER_RECOVERY_LIMITS.maxLedgerBytes }).receipt), duplicate: true };
  }
  acknowledge(value: ProviderRecoveryRequest): ProviderRecoveryReceipt {
    const request = validateProviderRecoveryRequest(value), previous = this.findReceipt(request);
    if (previous) return previous;
    return this.native.write(request.sessionId, () => {
      const duplicate = this.findReceiptInTransaction(request);
      if (duplicate) return duplicate;
      const preview = this.previewInTransaction(request.sessionId, request.attemptId);
      if (preview.status === 'blocked') throw new EngineError(preview.blockers[0]!, 'The ordinary provider Attempt is not eligible for this host decision');
      if (preview.status === 'acknowledged') fail('REQUEST_CONFLICT', 'This provider Attempt already has a decision; retry its original request');
      if (preview.fingerprint !== request.fingerprint) fail('STALE', 'Provider recovery source or context changed before acknowledgment');
      const allowance = budget(), evidence = readProviderRecoveryEvidence(this.db, this.store, request.sessionId, request.attemptId, allowance);
      const baseline = readProviderRecoveryBaseline(this.db, request.sessionId, allowance);
      const scope = this.scope(evidence.run.workspaceId);
      if (scope !== preview.bindingScope || evidence.recordSha256 !== preview.recordSha256 || evidence.cleanupRecordSha256 !== preview.cleanupRecordSha256
        || evidence.usageSha256 !== preview.usageSha256 || evidence.sourceSha256 !== preview.sourceSha256 || baseline.hash !== preview.contextBaselineSha256
        || fingerprint(evidence, scope, baseline.hash, sha(baseline.pins), this.options.startupHighWater) !== request.fingerprint) fail('STALE', 'Provider recovery evidence changed during acknowledgment');
      const receipt: ProviderRecoveryReceipt = { version: 1, id: randomUUID(), requestId: request.requestId, sessionId: request.sessionId,
        workspaceId: evidence.run.workspaceId, runId: evidence.run.id, turnId: evidence.turn.id, attemptId: evidence.attempt.id,
        fingerprint: request.fingerprint, bindingScope: scope, acknowledgedAt: new Date().toISOString(), state: 'uncertain', cleanupConfirmed: true,
        providerOutcomeConfirmed: false, providerRetried: false, executionResumed: false, checkpointActivated: false, duplicate: false };
      const audit: Audit = { receipt, recordSha256: evidence.recordSha256, cleanupRecordSha256: evidence.cleanupRecordSha256, usageSha256: evidence.usageSha256,
        sourceSha256: evidence.sourceSha256, contextBaselineSha256: baseline.hash, pinsSha256: sha(baseline.pins), startupHighWater: this.options.startupHighWater, pins: baseline.pins }, encoded = JSON.stringify(audit);
      if (Buffer.byteLength(encoded) > PROVIDER_RECOVERY_LIMITS.maxLedgerBytes) fail('LIMIT', 'Provider acknowledgment exceeds its durable byte bound');
      this.db.prepare(`INSERT INTO provider_recovery_acknowledgments(id,attempt_id,session_id,workspace_id,run_id,turn_id,request_id,binding_scope,fingerprint,
        record_sha256,cleanup_record_sha256,usage_sha256,source_sha256,context_baseline_sha256,pins_sha256,startup_high_water,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(receipt.id, receipt.attemptId, receipt.sessionId, receipt.workspaceId, receipt.runId, receipt.turnId, receipt.requestId, receipt.bindingScope, receipt.fingerprint,
          audit.recordSha256, audit.cleanupRecordSha256, audit.usageSha256, audit.sourceSha256, audit.contextBaselineSha256, audit.pinsSha256, audit.startupHighWater, encoded);
      const payload = JSON.parse(JSON.stringify(receipt)) as JsonObject; delete payload.duplicate;
      const event = this.native.appendEvent(receipt.sessionId, 'provider.recovery.acknowledged', payload, { runId: receipt.runId, turnId: receipt.turnId, attemptId: receipt.attemptId });
      this.options.appendLegacy(evidence.run, event.type, event.payload);
      return structuredClone(receipt);
    });
  }
  /** Admission examines immutable decisions only; other execution/effect blockers are handled independently. */
  hasValidAcknowledgment(sessionId: string, id: string): boolean {
    return this.read(() => {
      try {
        const header = this.target(sessionId, id), scope = this.scope(String(header.workspace_id));
        if (header.state !== 'uncertain') return false;
        const row = this.ledger('attempt_id=? AND binding_scope=?', id, scope);
        if (!row || row.session_id !== sessionId || row.workspace_id !== header.workspace_id || row.run_id !== header.run_id || row.turn_id !== header.turn_id) return false;
        const allowance = budget(), audit = this.audit(row, allowance), evidence = readProviderRecoveryEvidence(this.db, this.store, sessionId, id, allowance);
        return this.valid(audit, evidence, scope, allowance);
      } catch { return false; }
    });
  }
  hasUnacknowledged(workspaceId: string): boolean {
    return this.read(() => {
      try {
        if (!identifier(workspaceId)) return true;
        if (!this.db.prepare("SELECT 1 FROM provider_attempts a JOIN runs r ON r.id=a.run_id WHERE r.workspace_id=? AND a.state='uncertain' LIMIT 1").get(workspaceId)) return false;
        const scope = this.scope(workspaceId);
        if (this.db.prepare(`SELECT 1 FROM provider_attempts p JOIN runs r ON r.id=p.run_id LEFT JOIN provider_recovery_acknowledgments a
          ON a.attempt_id=p.id AND a.binding_scope=? WHERE r.workspace_id=? AND p.state='uncertain' AND a.id IS NULL LIMIT 1`).get(scope, workspaceId)) return true;
        const candidates = this.db.prepare("SELECT a.id,a.session_id FROM provider_attempts a JOIN runs r ON r.id=a.run_id WHERE r.workspace_id=? AND a.state='uncertain' ORDER BY a.rowid LIMIT ?")
          .all(workspaceId, PROVIDER_RECOVERY_LIMITS.maxCandidates + 1);
        if (candidates.length > PROVIDER_RECOVERY_LIMITS.maxCandidates) return true;
        const allowance = budget();
        for (const candidate of candidates) {
          const id = String(candidate.id), sessionId = String(candidate.session_id), row = this.ledger('attempt_id=? AND binding_scope=?', id, scope);
          if (!row || row.session_id !== sessionId || row.workspace_id !== workspaceId) return true;
          const audit = this.audit(row, allowance), evidence = readProviderRecoveryEvidence(this.db, this.store, sessionId, id, allowance);
          if (!this.valid(audit, evidence, scope, allowance)) return true;
        }
        return false;
      } catch { return true; }
    });
  }
}
