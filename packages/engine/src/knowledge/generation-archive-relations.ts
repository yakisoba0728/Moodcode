import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { KNOWLEDGE_GENERATION_TABLES, validateKnowledgeGenerationArchiveRow } from './generation-store.js';
import type { KnowledgeGenerationAttempt, KnowledgeGenerationRecord, KnowledgeGenerationTable } from './generation-types.js';
import type { KnowledgeCandidate, KnowledgeGenerationPlan, KnowledgeStorageTable, TrustRevision } from './types.js';
import { identifier, knowledgeError, knowledgeHash, validateKnowledgeArchiveRow } from './validation.js';

type Table = KnowledgeGenerationTable | 'knowledge_generation_plans' | 'knowledge_candidates' | 'workspace_trust_revisions';
type Header = { id: string; workspace_id: string; bytes: number; [key: string]: SQLInputValue };
type Body = { [key: string]: unknown };
const ROW_BYTES = 65_536;
const COLUMNS: Readonly<Record<Table, Readonly<Record<string, string>>>> = Object.freeze({
  knowledge_generations: { plan_id: 'planId', request_id: 'requestId', state: 'state', revision: 'revision' },
  knowledge_generation_attempts: { generation_id: 'generationId', plan_id: 'planId', state: 'state', revision: 'revision' },
  knowledge_generation_recovery_acknowledgments: { request_id: 'requestId', operation: 'operation' },
  knowledge_generation_workspace_barriers: { state: 'state', revision: 'revision' },
  knowledge_generation_plans: { trust_revision_id: 'trustRevisionId' },
  knowledge_candidates: { plan_id: 'planId', trust_revision_id: 'trustRevisionId', generation_owner_id: 'generationOwnerId' },
  workspace_trust_revisions: { revision: 'revision' },
});
function invalid(message: string): never {
  return knowledgeError('KNOWLEDGE_GENERATION_RELATION_INVALID', message);
}
function equal(left: unknown, right: unknown): boolean { return knowledgeHash(left) === knowledgeHash(right); }

/**
 * Validate persisted historical producer relationships without issuing host capabilities.
 * Call inside a stable database read/transaction. `check` supplies the caller's cancellation,
 * archive deadline and whole-database limits. Every body is bounded before SQLite returns it;
 * metadata and independent relations are streamed, never accumulated into a database-sized array.
 */
export function validateKnowledgeGenerationDatabase(db: DatabaseSync, check: () => void): void {
  function headers(table: Table, where = '', parameters: readonly SQLInputValue[] = []): Iterable<Header> {
    check();
    const columns = Object.keys(COLUMNS[table]);
    return db.prepare(`SELECT id,workspace_id,${columns.length ? columns.join(',') + ',' : ''}length(CAST(data AS BLOB)) AS bytes FROM ${table} ${where}`).iterate(...parameters) as Iterable<Header>;
  }
  function read(table: Table, header: Header): Body {
    check();
    identifier(header.id); identifier(header.workspace_id);
    if (!Number.isSafeInteger(header.bytes) || header.bytes < 1 || header.bytes > ROW_BYTES)
      return invalid('Stored knowledge row exceeds its byte bound before body loading');
    const row = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${ROW_BYTES} THEN data END AS data FROM ${table} WHERE id=? AND workspace_id=?`).get(header.id, header.workspace_id);
    if (!row || typeof row.data !== 'string' || Buffer.byteLength(row.data) !== header.bytes)
      return invalid('Stored knowledge row changed or exceeds its bounded metadata');
    check();
    let parsed: unknown;
    try { parsed = JSON.parse(row.data); } catch { return invalid('Stored knowledge row is not JSON'); }
    const wrapper = { table, key: header.id, workspaceId: header.workspace_id, data: parsed };
    const data = (KNOWLEDGE_GENERATION_TABLES.includes(table as KnowledgeGenerationTable)
      ? validateKnowledgeGenerationArchiveRow(wrapper).data
      : validateKnowledgeArchiveRow({ ...wrapper, table: table as KnowledgeStorageTable }).data) as unknown as Body;
    for (const [column, field] of Object.entries(COLUMNS[table]))
      if (header[column] !== data[field]) invalid('Indexed knowledge columns disagree with their validated JSON body');
    return data;
  }
  function one(table: Table, where: string, parameters: readonly SQLInputValue[]): Body | undefined {
    let result: Body | undefined;
    for (const header of headers(table, `WHERE ${where} LIMIT 2`, parameters)) {
      if (result) invalid('An exact knowledge relation resolves to multiple records');
      result = read(table, header);
    }
    return result;
  }
  function exact<T>(table: Table, workspaceId: string, id: string): T {
    return (one(table, 'workspace_id=? AND id=?', [workspaceId, id]) ?? invalid('Native generation references a missing exact knowledge record')) as unknown as T;
  }
  function planFor(g: KnowledgeGenerationRecord): KnowledgeGenerationPlan {
    const plan = exact<KnowledgeGenerationPlan>('knowledge_generation_plans', g.workspaceId, g.planId);
    const trust = exact<TrustRevision>('workspace_trust_revisions', g.workspaceId, plan.trustRevisionId);
    if (plan.sha256 !== g.planSha256 || plan.providerId !== g.providerId || plan.modelId !== g.modelId ||
        plan.requestSha256 !== g.logicalRequestSha256 || plan.requestBytes !== g.logicalRequestBytes || !equal(plan.binding, g.binding) ||
        g.budget.maxOutputBytes > plan.maxOutputBytes || g.deadline > Date.parse(plan.expiresAt) ||
        Date.parse(g.createdAt) < Date.parse(plan.createdAt) || Date.parse(g.createdAt) >= Date.parse(plan.expiresAt) ||
        trust.decision !== 'allow' || trust.revision !== plan.expectedTrustRevision || !equal(trust.binding, plan.binding))
      invalid('Native generation differs from its original exact plan or historical trust revision');
    if (knowledgeHash({ workspaceId: g.workspaceId, planId: g.planId, requestId: g.requestId, budget: g.budget,
      logicalRequestSha256: g.logicalRequestSha256, logicalRequestBytes: g.logicalRequestBytes }) !== g.createSha256)
      invalid('Native generation creation hash does not describe its stored original input');
    return plan;
  }
  function pair(g: KnowledgeGenerationRecord, a: KnowledgeGenerationAttempt | undefined): void {
    if (!a) {
      if (g.attemptId !== null || !['prepared', 'failed', 'cancelled'].includes(g.state))
        invalid('Dispatched native generation has no original exact attempt');
      return;
    }
    if (a.id !== g.attemptId || a.workspaceId !== g.workspaceId || a.generationId !== g.id || a.planId !== g.planId ||
        a.runtimeEpoch !== g.runtimeEpoch || a.state !== g.state || a.errorCode !== g.errorCode ||
        Date.parse(a.createdAt) < Date.parse(g.createdAt) || Date.parse(a.updatedAt) > Date.parse(g.updatedAt) ||
        (a.dispatchedAt !== null && Date.parse(a.dispatchedAt) > Date.parse(a.updatedAt)) || a.outputBytes > g.budget.maxOutputBytes)
      invalid('Native generation and attempt ownership, state or retained output budget disagree');
    if ((a.dispatchedAt === null || a.state === 'dispatched') && (a.outputBytes !== 0 || a.observedTextBytes !== 0 ||
        a.outputTruncated || a.observationBytes !== 0 || a.events !== 0 || Object.values(a.usage).some(value => value !== null) ||
        a.providerRequestId !== null || a.finishReason !== null || a.streamDone))
      invalid('Native attempt cannot observe provider output before its original durable dispatch');
    if (a.dispatchedAt === null && a.cleanup !== null && a.cleanup.method !== 'not-dispatched')
      invalid('Undispatched native attempt cannot claim iterator cleanup');
    // Failed/uncertain outcomes preserve their last real overflow observation. Only completed
    // output may assert that every original charge, event and completion time stayed in budget.
    if (g.state === 'completed' && (a.observedTextBytes > g.budget.maxOutputBytes ||
        a.observationBytes > g.budget.maxObservationBytes || a.events > g.budget.maxEvents ||
        Date.parse(a.updatedAt) >= g.deadline))
      invalid('Completed native output exceeded its original deadline or observation budget');
  }
  function candidateFor(g: KnowledgeGenerationRecord, a: KnowledgeGenerationAttempt | undefined, plan: KnowledgeGenerationPlan): void {
    const candidate = one('knowledge_candidates', 'workspace_id=? AND generation_owner_id=?', [g.workspaceId, g.id]) as unknown as KnowledgeCandidate | undefined;
    if (g.candidate.state === 'recorded' && (!candidate || candidate.id !== g.candidate.candidateId))
      invalid('Recorded native candidate ID is not the exact actual owner candidate');
    if (!candidate) return;
    if (g.state !== 'completed' || !a || candidate.planId !== plan.id || candidate.generationOwnerId !== g.id ||
        !equal(candidate.binding, plan.binding) || candidate.trustRevisionId !== plan.trustRevisionId ||
        candidate.trustRevision !== plan.expectedTrustRevision || !equal(candidate.source, plan.source) || !equal(candidate.target, plan.target) ||
        candidate.providerId !== g.providerId || candidate.modelId !== g.modelId || candidate.requestSha256 !== g.logicalRequestSha256 ||
        candidate.body !== a.output || candidate.bodySha256 !== a.outputSha256 || !equal(candidate.usage, a.usage) ||
        candidate.expiresAt !== plan.expiresAt || Date.parse(candidate.createdAt) < Date.parse(a.updatedAt))
      invalid('Knowledge candidate is not the exact completed native owner output and provenance');
    // The candidate append and native marker use separate durable transactions. A crash between
    // them legitimately leaves an exact candidate with a pending/withheld marker; never promote it.
  }

  for (const header of headers('knowledge_generations', 'ORDER BY id')) {
    const generation = read('knowledge_generations', header) as unknown as KnowledgeGenerationRecord;
    const plan = planFor(generation);
    const attempt = one('knowledge_generation_attempts', 'workspace_id=? AND generation_id=?', [generation.workspaceId, generation.id]) as unknown as KnowledgeGenerationAttempt | undefined;
    pair(generation, attempt);
    candidateFor(generation, attempt, plan);
  }
  // Also reject orphan or hidden attempts even when foreign-key enforcement was disabled by
  // an archive author. Looking up an exact generation remains bounded and uses its primary key.
  for (const header of headers('knowledge_generation_attempts', 'ORDER BY id')) {
    const attempt = read('knowledge_generation_attempts', header) as unknown as KnowledgeGenerationAttempt;
    pair(exact<KnowledgeGenerationRecord>('knowledge_generations', attempt.workspaceId, attempt.generationId), attempt);
  }
  for (const table of ['knowledge_generation_recovery_acknowledgments', 'knowledge_generation_workspace_barriers'] as const)
    for (const header of headers(table, 'ORDER BY id')) read(table, header);
  check();
}
