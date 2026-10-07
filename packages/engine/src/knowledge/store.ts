import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  KnowledgeArchiveData, KnowledgeArchiveRow, KnowledgeCandidate, KnowledgeCandidateSummary,
  KnowledgeGenerationEvidence, KnowledgeGenerationHandle, KnowledgeGenerationPlan, KnowledgeHostBinding,
  KnowledgeImportPause, KnowledgeListOptions, KnowledgePage, KnowledgeRequestReceipt, KnowledgeStoragePorts,
  KnowledgeStorageTable, PrepareKnowledgeGeneration, SetWorkspaceTrust, TrustRevision,
} from './types.js';
import {
  KNOWLEDGE_LIMITS, KNOWLEDGE_STORAGE_TABLES, identifier, immutableKnowledgeJson, integer, knowledgeError,
  knowledgeHash, sha256, stamp, validateBinding, validateCandidate, validateGenerationEvidence,
  validateGenerationInput, validateGenerationPlan, validateKnowledgeArchiveRow, validateTrustInput, validateTrustRevision,
} from './validation.js';

/** Migration fragment only. The authoritative store chooses its own migration/version. */
export const KNOWLEDGE_SCHEMA_SQL = `
CREATE TABLE workspace_trust_revisions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0), data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536),
  UNIQUE(workspace_id, revision), UNIQUE(workspace_id, id)
);
CREATE TABLE workspace_trust_heads (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0), revision_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536), CHECK(id = workspace_id),
  FOREIGN KEY(workspace_id, revision_id) REFERENCES workspace_trust_revisions(workspace_id, id)
);
CREATE TABLE knowledge_generation_plans (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trust_revision_id TEXT NOT NULL, data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536),
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, trust_revision_id) REFERENCES workspace_trust_revisions(workspace_id, id)
);
CREATE TABLE knowledge_candidates (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL UNIQUE, trust_revision_id TEXT NOT NULL, generation_owner_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536), UNIQUE(workspace_id, generation_owner_id),
  FOREIGN KEY(workspace_id, plan_id) REFERENCES knowledge_generation_plans(workspace_id, id),
  FOREIGN KEY(workspace_id, trust_revision_id) REFERENCES workspace_trust_revisions(workspace_id, id)
);
CREATE TABLE knowledge_request_receipts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  binding_sha256 TEXT NOT NULL, request_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536), UNIQUE(workspace_id, binding_sha256, request_id)
);
CREATE TABLE knowledge_import_pauses (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 65536), CHECK(id = workspace_id)
);
CREATE INDEX knowledge_trust_workspace_page ON workspace_trust_revisions(workspace_id, id);
CREATE INDEX knowledge_plan_workspace_page ON knowledge_generation_plans(workspace_id, id);
CREATE INDEX knowledge_candidate_workspace_page ON knowledge_candidates(workspace_id, id);
CREATE INDEX knowledge_receipt_workspace_page ON knowledge_request_receipts(workspace_id, id);
`;

type DataRow = { id: string; workspace_id: string; data: string };
type HandleState = { plan: KnowledgeGenerationPlan; evidence: KnowledgeGenerationEvidence };
function encoded(value: unknown): string { return JSON.stringify(value); }
function hashed<T extends object>(body: T): T & { readonly sha256: string } { return immutableKnowledgeJson({ ...body, sha256: knowledgeHash(body) }); }
function synchronous(value: unknown): void { if (value !== undefined) knowledgeError('KNOWLEDGE_ASYNC_PORT', 'Knowledge freshness ports must return void synchronously inside the owner transaction'); }

/** Bounded host records on the caller's SQLite connection. No provider, shell or file write is performed. */
export class KnowledgeStorage {
  readonly #db: DatabaseSync;
  readonly #ports: KnowledgeStoragePorts;
  readonly #handles = new WeakMap<object, HandleState>();
  readonly #activeHandles = new Set<object>();
  constructor(db: DatabaseSync, ports: KnowledgeStoragePorts) {
    if (!ports || typeof ports.writeTx !== 'function' || typeof ports.getWorkspace !== 'function' || typeof ports.checkHostBinding !== 'function' || typeof ports.assertTrustSourcesCurrent !== 'function' || typeof ports.assertSourcesCurrent !== 'function' || typeof ports.assertTargetCurrent !== 'function' || ports.readGenerationEvidence !== undefined && typeof ports.readGenerationEvidence !== 'function' || ports.now !== undefined && typeof ports.now !== 'function') knowledgeError('INVALID_KNOWLEDGE_PORTS', 'Knowledge storage needs synchronous host owner and freshness ports');
    this.#db = db; this.#ports = Object.freeze({ ...ports }); Object.freeze(this);
  }
  private write<T>(operation: () => T): T {
    let entered = false;
    const result = this.#ports.writeTx(() => {
      if (entered || !this.#db.isTransaction) knowledgeError('KNOWLEDGE_TRANSACTION_REQUIRED', 'Knowledge writes must use one transaction on their own database');
      entered = true; const value = operation();
      if (value && typeof value === 'object' && 'then' in value) knowledgeError('KNOWLEDGE_ASYNC_PORT', 'Knowledge writes cannot cross an await');
      return value;
    });
    if (!entered) knowledgeError('KNOWLEDGE_TRANSACTION_REQUIRED', 'Host write transaction did not execute its operation');
    if (result && typeof result === 'object' && 'then' in result) knowledgeError('KNOWLEDGE_ASYNC_PORT', 'Host write transaction must return its result synchronously');
    return result;
  }
  private now(): string {
    const value = this.#ports.now?.() ?? Date.now(); integer(value, 8_640_000_000_000_000);
    return stamp(new Date(value).toISOString());
  }
  private row(table: KnowledgeStorageTable, id: string, workspaceId: string): DataRow | undefined {
    return this.#db.prepare(`SELECT id,workspace_id,data FROM ${table} WHERE id=? AND workspace_id=?`).get(id, workspaceId) as DataRow | undefined;
  }
  private decode(row: DataRow, table: KnowledgeStorageTable): KnowledgeArchiveData {
    if (Buffer.byteLength(row.data) > KNOWLEDGE_LIMITS.rowBytes) knowledgeError('KNOWLEDGE_LIMIT', 'Stored knowledge row exceeds its bound');
    return validateKnowledgeArchiveRow({ table, key: row.id, workspaceId: row.workspace_id, data: JSON.parse(row.data) }).data;
  }
  private insert(table: KnowledgeStorageTable, value: KnowledgeArchiveData, columns: Readonly<Record<string, SQLInputValue>> = {}): void {
    const id = 'id' in value ? value.id : value.workspaceId;
    const names = ['id', 'workspace_id', 'data', ...Object.keys(columns)], values: SQLInputValue[] = [id, value.workspaceId, encoded(value), ...Object.values(columns)];
    this.#db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`).run(...values);
  }
  /** Read-only descriptive binding, useful when constructing an exact host trust preview. */
  readHostBinding(workspaceId: string): KnowledgeHostBinding {
    identifier(workspaceId);
    const workspace = immutableKnowledgeJson(this.#ports.getWorkspace(workspaceId));
    const binding = validateBinding(this.#ports.checkHostBinding(workspaceId));
    if (workspace.id !== workspaceId || binding.workspaceId !== workspaceId || workspace.root !== binding.root) knowledgeError('KNOWLEDGE_BINDING_MISMATCH', 'Workspace and current physical host binding disagree');
    return binding;
  }
  private assertBinding(binding: KnowledgeHostBinding): void {
    if (knowledgeHash(binding) !== knowledgeHash(this.readHostBinding(binding.workspaceId))) knowledgeError('KNOWLEDGE_BINDING_MISMATCH', 'Knowledge was captured under another root or storage binding');
  }
  private assertUnpaused(workspaceId: string): void {
    if (this.getImportPause(workspaceId)) knowledgeError('KNOWLEDGE_IMPORT_PAUSED', 'Imported knowledge requires explicit host recovery before generation or publication');
  }
  private unexpired(expiresAt: string | null, current: string): void {
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(current)) knowledgeError('KNOWLEDGE_EXPIRED', 'Knowledge trust or source plan has expired');
  }
  getTrust(workspaceId: string): TrustRevision | undefined {
    identifier(workspaceId);
    const row = this.row('workspace_trust_heads', workspaceId, workspaceId);
    if (!row) return undefined;
    const head = this.decode(row, 'workspace_trust_heads') as { revision: number; revisionId: string };
    const revision = this.getTrustRevision(workspaceId, head.revisionId);
    if (!revision || revision.revision !== head.revision) knowledgeError('KNOWLEDGE_RECORD_CONFLICT', 'Trust head does not match its revision');
    return revision;
  }
  getTrustRevision(workspaceId: string, revisionId: string): TrustRevision | undefined {
    identifier(workspaceId); identifier(revisionId); const row = this.row('workspace_trust_revisions', revisionId, workspaceId);
    return row ? this.decode(row, 'workspace_trust_revisions') as TrustRevision : undefined;
  }
  /** Active authority requires the exact current revision, physical binding and live source hashes. */
  assertTrusted(workspaceId: string, expectedRevision: number): TrustRevision {
    return this.trustedAt(workspaceId, expectedRevision, this.now());
  }
  private trustedAt(workspaceId: string, expectedRevision: number, current: string): TrustRevision {
    integer(expectedRevision); this.assertUnpaused(workspaceId);
    const trust = this.getTrust(workspaceId);
    if (!trust || trust.decision !== 'allow' || trust.revision !== expectedRevision) knowledgeError('WORKSPACE_UNTRUSTED', 'Workspace trust was never approved or was changed/revoked');
    this.unexpired(trust.expiresAt, current); this.assertBinding(trust.binding);
    synchronous(this.#ports.assertTrustSourcesCurrent(trust.binding, trust.sources));
    return trust;
  }
  private duplicate(binding: KnowledgeHostBinding, requestId: string, operation: KnowledgeRequestReceipt['operation'], fingerprint: string): KnowledgeRequestReceipt | undefined {
    const row = this.#db.prepare('SELECT id,workspace_id,data FROM knowledge_request_receipts WHERE workspace_id=? AND binding_sha256=? AND request_id=?').get(binding.workspaceId, knowledgeHash(binding), requestId) as DataRow | undefined;
    if (!row) return undefined;
    const receipt = this.decode(row, 'knowledge_request_receipts') as KnowledgeRequestReceipt;
    if (receipt.operation !== operation || receipt.requestSha256 !== fingerprint || receipt.bindingSha256 !== knowledgeHash(binding) || receipt.requestId !== requestId) knowledgeError('KNOWLEDGE_REQUEST_CONFLICT', 'Knowledge request ID was already used with different exact input');
    return receipt;
  }
  private receipt(binding: KnowledgeHostBinding, requestId: string, operation: KnowledgeRequestReceipt['operation'], fingerprint: string, recordId: string): void {
    const receipt: KnowledgeRequestReceipt = immutableKnowledgeJson({ id: randomUUID(), workspaceId: binding.workspaceId, bindingSha256: knowledgeHash(binding), requestId, operation, requestSha256: fingerprint, recordId });
    this.insert('knowledge_request_receipts', receipt, { binding_sha256: receipt.bindingSha256, request_id: requestId });
  }
  setTrust(input: SetWorkspaceTrust): TrustRevision {
    const request = validateTrustInput(input), fingerprint = knowledgeHash(request);
    return this.write(() => {
      this.assertBinding(request.binding);
      const duplicate = this.duplicate(request.binding, request.requestId, 'set-trust', fingerprint);
      if (duplicate) return this.getTrustRevision(request.workspaceId, duplicate.recordId) ?? knowledgeError('KNOWLEDGE_RECORD_CONFLICT', 'Trust receipt has no durable record');
      const previous = this.getTrust(request.workspaceId), revision = previous?.revision ?? 0;
      if (revision !== request.expectedRevision) knowledgeError('KNOWLEDGE_REVISION_CONFLICT', 'Workspace trust changed before the host decision');
      if (revision === Number.MAX_SAFE_INTEGER) knowledgeError('KNOWLEDGE_LIMIT', 'Workspace trust revision limit reached');
      const current = this.now(); this.unexpired(request.expiresAt, current);
      if (request.decision === 'allow') synchronous(this.#ports.assertTrustSourcesCurrent(request.binding, request.sources));
      // Pure host callbacks must not be able to substitute a stale head/binding during validation.
      this.assertBinding(request.binding);
      if ((this.getTrust(request.workspaceId)?.revision ?? 0) !== revision) knowledgeError('KNOWLEDGE_REVISION_CONFLICT', 'Trust changed while checking host sources');
      const record = validateTrustRevision(hashed({ id: randomUUID(), workspaceId: request.workspaceId, revision: revision + 1, previousId: previous?.id ?? null, requestId: request.requestId, decision: request.decision, binding: request.binding, sources: request.sources, createdAt: current, expiresAt: request.expiresAt }));
      this.insert('workspace_trust_revisions', record, { revision: record.revision });
      const head = immutableKnowledgeJson({ workspaceId: request.workspaceId, revision: record.revision, revisionId: record.id });
      if (previous) {
        const updated = this.#db.prepare('UPDATE workspace_trust_heads SET revision=?,revision_id=?,data=? WHERE workspace_id=? AND revision=?').run(record.revision, record.id, encoded(head), record.workspaceId, revision);
        if (updated.changes !== 1) knowledgeError('KNOWLEDGE_REVISION_CONFLICT', 'Trust head CAS failed');
      } else this.insert('workspace_trust_heads', head, { revision: record.revision, revision_id: record.id });
      this.receipt(request.binding, request.requestId, 'set-trust', fingerprint, record.id); return record;
    });
  }
  prepareGeneration(input: PrepareKnowledgeGeneration): KnowledgeGenerationPlan {
    const request = validateGenerationInput(input), fingerprint = knowledgeHash(request);
    return this.write(() => {
      this.assertBinding(request.binding); this.assertUnpaused(request.workspaceId);
      const duplicate = this.duplicate(request.binding, request.requestId, 'prepare-generation', fingerprint);
      if (duplicate) return this.getGenerationPlan(request.workspaceId, duplicate.recordId) ?? knowledgeError('KNOWLEDGE_RECORD_CONFLICT', 'Generation receipt has no durable plan');
      const current = this.now(), trust = this.trustedAt(request.workspaceId, request.expectedTrustRevision, current);
      this.unexpired(request.expiresAt, current);
      if (trust.expiresAt !== null && Date.parse(request.expiresAt) > Date.parse(trust.expiresAt)) knowledgeError('INVALID_KNOWLEDGE', 'Generation plan cannot outlive its trust grant');
      synchronous(this.#ports.assertSourcesCurrent(request.binding, request.source)); synchronous(this.#ports.assertTargetCurrent(request.binding, request.target));
      this.assertTrusted(request.workspaceId, request.expectedTrustRevision); this.assertBinding(request.binding); this.unexpired(request.expiresAt, this.now());
      const plan = validateGenerationPlan(hashed({ ...request, id: randomUUID(), trustRevisionId: trust.id, state: 'pending' as const, toolCount: 0 as const, createdAt: current }));
      this.insert('knowledge_generation_plans', plan, { trust_revision_id: plan.trustRevisionId });
      this.receipt(request.binding, request.requestId, 'prepare-generation', fingerprint, plan.id); return plan;
    });
  }
  getGenerationPlan(workspaceId: string, planId: string): KnowledgeGenerationPlan | undefined {
    identifier(workspaceId); identifier(planId); const row = this.row('knowledge_generation_plans', planId, workspaceId);
    return row ? this.decode(row, 'knowledge_generation_plans') as KnowledgeGenerationPlan : undefined;
  }
  private currentPlan(plan: KnowledgeGenerationPlan): void {
    this.unexpired(plan.expiresAt, this.now()); this.assertBinding(plan.binding);
    const trust = this.assertTrusted(plan.workspaceId, plan.expectedTrustRevision);
    if (trust.id !== plan.trustRevisionId) knowledgeError('KNOWLEDGE_REVISION_CONFLICT', 'Plan does not reference the exact current trust revision');
    synchronous(this.#ports.assertSourcesCurrent(plan.binding, plan.source)); synchronous(this.#ports.assertTargetCurrent(plan.binding, plan.target));
    this.assertBinding(plan.binding); this.unexpired(plan.expiresAt, this.now()); this.assertTrusted(plan.workspaceId, plan.expectedTrustRevision);
    if (this.getTrust(plan.workspaceId)?.id !== plan.trustRevisionId) knowledgeError('KNOWLEDGE_REVISION_CONFLICT', 'Trust changed while checking the plan');
  }
  private evidence(plan: KnowledgeGenerationPlan, ownerId: string): KnowledgeGenerationEvidence {
    if (!this.#ports.readGenerationEvidence) knowledgeError('KNOWLEDGE_GENERATION_OWNER_UNAVAILABLE', 'Native host generation ownership must be installed before appending candidates');
    const evidence = validateGenerationEvidence(this.#ports.readGenerationEvidence(plan, ownerId));
    if (evidence.ownerId !== ownerId || evidence.planId !== plan.id || evidence.workspaceId !== plan.workspaceId || evidence.bindingSha256 !== knowledgeHash(plan.binding) || evidence.requestSha256 !== plan.requestSha256 || evidence.providerId !== plan.providerId || evidence.modelId !== plan.modelId || evidence.outputBytes > plan.maxOutputBytes) knowledgeError('KNOWLEDGE_GENERATION_BINDING_MISMATCH', 'Native generation evidence does not belong to the exact pending plan/request');
    return evidence;
  }
  attachGenerationOwner(workspaceId: string, planId: string, ownerId: string): KnowledgeGenerationHandle {
    identifier(workspaceId); identifier(planId); identifier(ownerId);
    if (this.#activeHandles.size >= KNOWLEDGE_LIMITS.handles) knowledgeError('KNOWLEDGE_LIMIT', 'Host must release generation handles before capturing more owners');
    const state = this.write(() => {
      const plan = this.getGenerationPlan(workspaceId, planId) ?? knowledgeError('KNOWLEDGE_NOT_FOUND', 'Knowledge generation plan does not exist in this workspace');
      this.currentPlan(plan); const evidence = this.evidence(plan, ownerId); this.currentPlan(plan); return { plan, evidence };
    });
    const handle = Object.freeze({ planId, ownerId }); this.#handles.set(handle, state); this.#activeHandles.add(handle); return handle;
  }
  private owned(handle: KnowledgeGenerationHandle): HandleState {
    if (!handle || typeof handle !== 'object' || !this.#activeHandles.has(handle)) knowledgeError('KNOWLEDGE_GENERATION_HANDLE_INVALID', 'Generation handle is foreign, copied, released or never issued');
    return this.#handles.get(handle) ?? knowledgeError('KNOWLEDGE_GENERATION_HANDLE_INVALID', 'Generation handle has no owner');
  }
  releaseGenerationOwner(handle: KnowledgeGenerationHandle): void { this.owned(handle); this.#activeHandles.delete(handle); this.#handles.delete(handle); }
  appendCandidate(handle: KnowledgeGenerationHandle, input: { readonly requestId: string; readonly body: string }): KnowledgeCandidate {
    const state = this.owned(handle), request = immutableKnowledgeJson(input);
    if (Object.keys(request).length !== 2 || !Object.hasOwn(request, 'requestId') || !Object.hasOwn(request, 'body')) knowledgeError('INVALID_KNOWLEDGE', 'Candidate append accepts only a request ID and observed output body');
    identifier(request.requestId);
    if (typeof request.body !== 'string' || !request.body.trim() || Buffer.byteLength(request.body) > state.plan.maxOutputBytes) knowledgeError('KNOWLEDGE_LIMIT', 'Candidate body exceeds its captured generation output budget');
    const fingerprint = knowledgeHash({ planId: state.plan.id, ownerId: state.evidence.ownerId, ...request });
    return this.write(() => {
      this.owned(handle); this.assertBinding(state.plan.binding); this.assertUnpaused(state.plan.workspaceId);
      const duplicate = this.duplicate(state.plan.binding, request.requestId, 'append-candidate', fingerprint);
      if (duplicate) return this.getCandidate(state.plan.workspaceId, duplicate.recordId) ?? knowledgeError('KNOWLEDGE_RECORD_CONFLICT', 'Candidate receipt has no durable observation');
      this.currentPlan(state.plan);
      const evidence = this.evidence(state.plan, state.evidence.ownerId);
      if (knowledgeHash(evidence) !== knowledgeHash(state.evidence)) knowledgeError('KNOWLEDGE_GENERATION_BINDING_MISMATCH', 'Native generation evidence changed after owner capture');
      if (sha256(request.body) !== evidence.outputSha256 || Buffer.byteLength(request.body) !== evidence.outputBytes) knowledgeError('KNOWLEDGE_GENERATION_BINDING_MISMATCH', 'Candidate body is not the exact native owner output');
      const existing = this.#db.prepare('SELECT id FROM knowledge_candidates WHERE plan_id=? OR (workspace_id=? AND generation_owner_id=?) LIMIT 1').get(state.plan.id, state.plan.workspaceId, evidence.ownerId);
      if (existing) knowledgeError('KNOWLEDGE_RECORD_CONFLICT', 'A generation output already has its immutable candidate');
      this.currentPlan(state.plan);
      const plan = state.plan, candidate = validateCandidate(hashed({ id: randomUUID(), workspaceId: plan.workspaceId, planId: plan.id, generationOwnerId: evidence.ownerId, binding: plan.binding, trustRevisionId: plan.trustRevisionId, trustRevision: plan.expectedTrustRevision, source: plan.source, target: plan.target, providerId: plan.providerId, modelId: plan.modelId, requestSha256: plan.requestSha256, usage: evidence.usage, toolCount: 0 as const, cleanupConfirmed: true as const, state: 'pending' as const, body: request.body, bodySha256: evidence.outputSha256, createdAt: this.now(), expiresAt: plan.expiresAt }));
      this.insert('knowledge_candidates', candidate, { plan_id: plan.id, trust_revision_id: plan.trustRevisionId, generation_owner_id: evidence.ownerId });
      this.receipt(plan.binding, request.requestId, 'append-candidate', fingerprint, candidate.id); return candidate;
    });
  }
  getCandidate(workspaceId: string, candidateId: string): KnowledgeCandidate | undefined {
    identifier(workspaceId); identifier(candidateId); const row = this.row('knowledge_candidates', candidateId, workspaceId);
    return row ? this.decode(row, 'knowledge_candidates') as KnowledgeCandidate : undefined;
  }
  /** Freshness does not approve a candidate: every result remains pending host review. */
  assertCandidateCurrent(workspaceId: string, candidateId: string): KnowledgeCandidate {
    const candidate = this.getCandidate(workspaceId, candidateId) ?? knowledgeError('KNOWLEDGE_NOT_FOUND', 'Knowledge candidate does not exist in this workspace');
    this.unexpired(candidate.expiresAt, this.now());
    const plan = this.getGenerationPlan(workspaceId, candidate.planId) ?? knowledgeError('KNOWLEDGE_RECORD_CONFLICT', 'Candidate source plan is missing');
    this.currentPlan(plan);
    if (candidate.trustRevisionId !== plan.trustRevisionId || candidate.trustRevision !== plan.expectedTrustRevision || knowledgeHash(candidate.binding) !== knowledgeHash(plan.binding) || knowledgeHash(candidate.source) !== knowledgeHash(plan.source) || knowledgeHash(candidate.target) !== knowledgeHash(plan.target) || candidate.requestSha256 !== plan.requestSha256 || candidate.providerId !== plan.providerId || candidate.modelId !== plan.modelId) knowledgeError('KNOWLEDGE_RECORD_CONFLICT', 'Candidate provenance does not match its durable plan');
    return candidate;
  }
  getImportPause(workspaceId: string): KnowledgeImportPause | undefined {
    identifier(workspaceId); const row = this.row('knowledge_import_pauses', workspaceId, workspaceId);
    return row ? this.decode(row, 'knowledge_import_pauses') as KnowledgeImportPause : undefined;
  }
  /** Import owner calls this inside its transaction; it grants no resume or trust rebinding. */
  markImportPaused(workspaceId: string, archiveSha256: string): KnowledgeImportPause {
    const record = validateKnowledgeArchiveRow({ table: 'knowledge_import_pauses', key: workspaceId, workspaceId, data: { workspaceId, archiveSha256, createdAt: this.now(), state: 'paused' } }).data as KnowledgeImportPause;
    const operation = () => {
      this.readHostBinding(workspaceId);
      this.#db.prepare('INSERT INTO knowledge_import_pauses(id,workspace_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(workspaceId, workspaceId, encoded(record)); return record;
    };
    return this.#db.isTransaction ? operation() : this.write(operation);
  }
  private page<T>(table: KnowledgeStorageTable, workspaceId: string, options: KnowledgeListOptions, project: (row: DataRow) => T): KnowledgePage<T> {
    identifier(workspaceId);
    const normalized = immutableKnowledgeJson(options), limit = integer(normalized.limit ?? KNOWLEDGE_LIMITS.pageRows, KNOWLEDGE_LIMITS.pageRows), maxBytes = integer(normalized.maxBytes ?? KNOWLEDGE_LIMITS.pageBytes, KNOWLEDGE_LIMITS.pageBytes);
    if (!limit || maxBytes < KNOWLEDGE_LIMITS.rowBytes + 4_096 || Object.keys(normalized).some(key => !['after', 'limit', 'maxBytes'].includes(key))) knowledgeError('INVALID_KNOWLEDGE', 'Knowledge pages require 1..32 rows and enough bytes for one bounded row');
    if (normalized.after !== undefined) {
      identifier(normalized.after);
      if (!this.row(table, normalized.after, workspaceId)) knowledgeError('INVALID_KNOWLEDGE_CURSOR', 'Knowledge page cursor belongs to another table/workspace or a removed row');
    }
    const rows = this.#db.prepare(`SELECT id,workspace_id,data FROM ${table} WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?`).all(workspaceId, normalized.after ?? '', limit + 1) as DataRow[];
    const items: T[] = []; let selected = '', bytes = 2;
    for (const row of rows) {
      if (items.length === limit) break;
      const item = project(row), size = Buffer.byteLength(encoded(item)) + (items.length ? 1 : 0);
      if (bytes + size > maxBytes) break; items.push(item); bytes += size; selected = row.id;
    }
    if (rows.length && !items.length) knowledgeError('KNOWLEDGE_LIMIT', 'One bounded knowledge row exceeds the page envelope');
    return immutableKnowledgeJsonPage({ items, next: rows.length > items.length ? selected : null, bytes });
  }
  listCandidates(workspaceId: string, options: KnowledgeListOptions = {}): KnowledgePage<KnowledgeCandidateSummary> {
    return this.page('knowledge_candidates', workspaceId, options, row => { const { body: _body, ...summary } = this.decode(row, 'knowledge_candidates') as KnowledgeCandidate; return Object.freeze(summary); });
  }
  exportRows(table: KnowledgeStorageTable, workspaceId: string, options: KnowledgeListOptions = {}): KnowledgePage<KnowledgeArchiveRow> {
    if (!KNOWLEDGE_STORAGE_TABLES.includes(table)) knowledgeError('INVALID_KNOWLEDGE', 'Unknown knowledge archive table');
    return this.page(table, workspaceId, options, row => validateKnowledgeArchiveRow({ table, key: row.id, workspaceId: row.workspace_id, data: this.decode(row, table) }));
  }
}

/** Each row is already validated at 64KiB; page envelopes have their separate 1MiB cap. */
function immutableKnowledgeJsonPage<T>(page: KnowledgePage<T>): KnowledgePage<T> {
  return Object.freeze({ items: Object.freeze(page.items), next: page.next, bytes: page.bytes });
}
