import { createHash, randomUUID } from 'node:crypto';
import { EngineError, SESSION_SCHEMA_VERSION, type ContextRevision, type JsonObject, type RunConfig, type SessionSnapshot } from '@moodcode/contracts';
import type { ContextRequest, ProviderAdapter, ProviderMessage } from '../ports.js';
import type { SqliteStore } from '../storage/index.js';
import { ModelRegistry } from './model-spec.js';
import { planContext, type ContextPlan } from './plan.js';
import { InstructionSources, type InstructionObservation } from './sources.js';
import { SemanticMemoryService } from './semantic-memory.js';

export interface ContextDiagnostics {
  revisionId: string; revision: number; plan: Omit<ContextPlan, 'messages'>;
  instructions: InstructionObservation; omittedDatabaseMessages: number; omittedDatabaseRuns: number;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Produces a persisted, inspectable context only at a coordinator's safe turn boundary. */
export class ContextService {
  readonly memory: SemanticMemoryService;
  private readonly sources = new Map<string, InstructionSources>();
  private readonly history = new Map<string, { omittedMessages: number; omittedRuns: number }>();
  private readonly revisions = new Map<string, string>();
  constructor(private readonly store: SqliteStore, readonly models = new ModelRegistry(), private readonly outputTokenReserve = 0, private readonly provider?: (id: string) => ProviderAdapter | undefined) {
    if (!Number.isSafeInteger(outputTokenReserve) || outputTokenReserve < 0 || outputTokenReserve > 100_000_000) throw new EngineError('INVALID_OUTPUT_RESERVE', 'Output token reserve must be a bounded nonnegative integer');
    this.memory = new SemanticMemoryService(store);
  }
  snapshot(sessionId: string, config: RunConfig): SessionSnapshot {
    const page = this.store.readModelHistory(sessionId, 512, Math.max(1024, Math.min(33_554_432, config.limits.maxContextBytes * 4)));
    this.history.set(sessionId, { omittedMessages: page.omittedMessages, omittedRuns: page.omittedRuns });
    return page.snapshot;
  }
  revisionId(sessionId: string): string | undefined {
    return this.revisions.get(sessionId) ?? this.diagnostics(sessionId)?.revisionId;
  }
  diagnostics(sessionId: string): ContextDiagnostics | null {
    this.store.getSession(sessionId);
    return structuredClone(this.store.getSessionDocument(sessionId, 'context.head')?.data.diagnostics as unknown as ContextDiagnostics ?? null);
  }
  private relevantPaths(request: ContextRequest): string[] {
    const activeRunId = request.snapshot.runs.findLast(run => !['completed', 'cancelled', 'failed', 'interrupted'].includes(run.state))?.id;
    const paths = new Set<string>();
    for (const call of request.snapshot.tools) {
      if (call.runId !== activeRunId || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) continue;
      for (const key of ['path', 'source', 'destination']) if (typeof call.input[key] === 'string' && paths.size < 24) paths.add(call.input[key]);
      if (Array.isArray(call.input.changes)) for (const change of call.input.changes) {
        if (change && typeof change === 'object' && !Array.isArray(change) && typeof change.path === 'string' && paths.size < 24) paths.add(change.path);
      }
    }
    return [...paths];
  }
  async recoverOverflow(request: ContextRequest, provider: ProviderAdapter): Promise<void> { await this.memory.summarize(request, provider); }
  async build(request: ContextRequest, summaryAttempted = false): Promise<ProviderMessage[]> {
    let sources = this.sources.get(request.workspace.id);
    if (!sources) {
      if (this.sources.size >= 128) throw new EngineError('WORKSPACE_CONTEXT_LIMIT', 'Too many active workspace instruction caches');
      sources = new InstructionSources(request.workspace.root); this.sources.set(request.workspace.id, sources);
    }
    const observation = await sources.observe(this.relevantPaths(request), request.signal);
    const model = this.models.get(request.config.providerId, request.config.modelId);
    const projected = this.memory.project(request);
    const plan = await planContext({ ...projected, instructionSources: observation.sources }, { model, outputTokens: this.outputTokenReserve });
    const provider = this.provider?.(request.config.providerId);
    const selectedIds = new Set(plan.selectedMessageIds);
    const omittedDiscussion = projected.snapshot.messages.some(message => message.runId !== request.run?.id && message.role !== 'tool' && message.content.trim() && !selectedIds.has(message.id));
    if (!summaryAttempted && omittedDiscussion && request.run && request.budget && provider) {
      try { await this.memory.summarize(request, provider); return this.build(request, true); }
      catch (error) {
        if (request.signal.aborted || error instanceof EngineError && ['OUTPUT_LIMIT', 'RUN_TIME_LIMIT', 'CLEANUP_UNCERTAIN'].includes(error.code)) throw error;
        plan.warnings.push(`Semantic summary was not activated (${error instanceof EngineError ? error.code : 'SUMMARY_FAILED'}); the previous memory remains in use.`);
      }
    }
    if (request.signal.aborted) throw new EngineError('CANCELLED', 'Context construction was cancelled');
    const sessionId = request.snapshot.session.id;
    const previous = this.store.getSessionDocument(sessionId, 'context.head');
    const sourceIds = [...plan.selectedMessageIds, ...observation.sources.filter(source => source.sha256 !== null).map(source => `${source.id}:${source.sha256}`)];
    const bindingHash = digest({ plan: plan.sha256, sources: sourceIds, config: request.config, model: { ...model, source: { kind: model.source.kind, reference: model.source.reference } } });
    const old = previous?.data;
    const oldRevisionId = typeof old?.revisionId === 'string' ? old.revisionId : undefined;
    let revisionId = oldRevisionId;
    let revision = typeof old?.contextRevision === 'number' ? old.contextRevision : 0;
    if (old?.bindingHash !== bindingHash || !revisionId) {
      revisionId = randomUUID(); revision = this.store.nextContextRevisionIndex(sessionId);
      const text = JSON.stringify(plan.messages);
      const latest = this.store.getLatestContextRevision(sessionId);
      const record: ContextRevision = { schemaVersion: SESSION_SCHEMA_VERSION, id: revisionId, sessionId, revision, kind: revision === 1 ? 'baseline' : 'update',
        sourceIds, text, sha256: createHash('sha256').update(text).digest('hex'), createdAt: new Date().toISOString(), ...(latest ? { supersedesId: latest.id } : {}) };
      this.store.putContextRevision(record);
    }
    const { messages, ...publicPlan } = plan;
    // Text is retained in ContextRevision; diagnostics carry source hashes and observations only.
    const diagnostics: ContextDiagnostics = { revisionId, revision, plan: publicPlan,
      instructions: { ...observation, sources: observation.sources.map(source => ({ ...source, text: null })) },
      omittedDatabaseMessages: this.history.get(sessionId)?.omittedMessages ?? 0, omittedDatabaseRuns: this.history.get(sessionId)?.omittedRuns ?? 0 };
    this.store.putSessionDocument(sessionId, 'context.head', previous?.revision ?? 0, { revisionId, contextRevision: revision, bindingHash, diagnostics: JSON.parse(JSON.stringify(diagnostics)) as JsonObject });
    this.revisions.set(sessionId, revisionId);
    return messages;
  }
}
