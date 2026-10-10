import type { ForkContextContribution } from '../sessions/fork-types.js';
import { createHash, randomUUID } from 'node:crypto';
import { EngineError, isTerminal, SESSION_SCHEMA_VERSION, type ContextRevision, type JsonObject, type Run, type RunConfig, type SessionSnapshot } from '@moodcode/contracts';
import type { ContextRequest, ProviderAdapter, ProviderMessage } from '../ports.js';
import type { ModelHistoryPage, SqliteStore } from '../storage/index.js';
import { entriesBytes } from './memory.js';
import { ModelRegistry } from './model-spec.js';
import { estimateTokens, planContext, type ContextPlan } from './plan.js';
import { InstructionSources, instructionPathHints, type InstructionObservation, type InstructionSource } from './sources.js';
import { SemanticMemoryService } from './semantic-memory.js';
import { projectToolHistory } from './tool-history.js';
import { projectMediaHistory, validateMediaHistoryPolicy, type MediaHistoryPolicy, type ImageHistoryProvenance, type MediaHistoryDiagnostics } from './media-history.js';
import { ActivePrefixMemoryService, type ActivePrefixPolicy, type ActivePrefixCheckpoint, type PreparedActivePrefix } from './active-prefix.js';
import { projectDocumentHistory, validateDocumentHistoryPolicy, type DocumentHistoryPolicy, type DocumentHistoryDiagnostics, type DocumentHistoryProvenance } from './document-history.js';
import { repositoryContextPolicy, type ContextSourcePort, type PreparedRepositoryContribution, type RepositoryContextPolicy } from './repository-contributions.js';
import { knowledgeContextPolicy } from '../knowledge/context-source.js';
import type { KnowledgeContextPolicy, KnowledgeContextProfile, KnowledgeContextSourcePort, PreparedKnowledgeContribution } from '../knowledge/context-types.js';
import type { LifecycleCapture, LifecycleHookRegistry } from '../lifecycle/index.js';
import { proposalContextPolicy, proposalContributionSourceIds } from '../proposals/overlay.js';
import type { ProposalContextPolicy, ProposalContextProfile, ProposalContextSourcePort, PreparedProposalContribution } from '../proposals/overlay.js';
import { gitIgnoredPaths } from '../workspace/ignore.js';

export interface ContextServiceOptions { conversationFork?: { prepare(sessionId:string,config:RunConfig):ForkContextContribution|null; assertFresh(sessionId:string,sha256:string,config:RunConfig):void }; mediaHistoryPolicy?: MediaHistoryPolicy; activePrefixPolicy?: ActivePrefixPolicy; documentHistoryPolicy?: DocumentHistoryPolicy;
  lifecycleHooks?: LifecycleHookRegistry; lifecycleContextSlotBytes?: number;
  repositoryContext?: { source: ContextSourcePort; policy: RepositoryContextPolicy };
  knowledgeContext?: { source: KnowledgeContextSourcePort; policy: KnowledgeContextPolicy; getProfile?: (run: Run) => KnowledgeContextProfile | undefined };
  proposalContext?: { source: ProposalContextSourcePort; policy: ProposalContextPolicy; getProfile?: (run: Run) => ProposalContextProfile | undefined } }

export interface ContextDiagnostics {
  revisionId: string; revision: number; plan: Omit<ContextPlan, 'messages'>;
  instructions: InstructionObservation; omittedDatabaseMessages: number; omittedDatabaseRuns: number;
  activeWindow?: ModelHistoryPage['activeWindow'];
  sessionImageAnchor?: ModelHistoryPage['sessionImageAnchor'];
  sessionDocumentAnchor?: ModelHistoryPage['sessionDocumentAnchor'];
  documentHistory?: DocumentHistoryDiagnostics & { provenance: DocumentHistoryProvenance[] };
  mediaHistory?: MediaHistoryDiagnostics & { provenance: ImageHistoryProvenance[] };
  repositoryContext?: Omit<PreparedRepositoryContribution, 'messages' | 'snippets'> & { snippets: Omit<PreparedRepositoryContribution['snippets'][number], 'text'>[] };
  knowledgeContext?: Omit<PreparedKnowledgeContribution, 'messages'>;
  proposalContext?: Omit<PreparedProposalContribution, 'messages'>;
  lifecycleContext?: { registryRevision: number; baseContextSha256: string; dataSha256: string | null; messageBytes: number; hookIds: string[] };
  activePrefix?: { checkpointId: string; summaryRevisionId: string; scope: 'active-run-prefix'; projection: ActivePrefixCheckpoint['projection'];
    factsSha256: string; manifestSha256: string; policySha256: string; coveredMessageIds: string[]; protectedMessageIds: string[];
    summaryUsage: ActivePrefixCheckpoint['usage']; historicalFileEvidence: true; currentFileEvidence: false };
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FILE_TOOLS = new Set(['read_file', 'list_files', 'search_files', 'glob_files', 'regex_search', 'edit_file', 'apply_patch', 'rename_file', 'delete_file']);
type SnapshotHistory = Pick<ModelHistoryPage, 'omittedMessages' | 'omittedRuns' | 'activeWindow' | 'sessionImageAnchor' | 'sessionDocumentAnchor'>;
const snapshotHistory = (page: ModelHistoryPage): SnapshotHistory => ({ omittedMessages: page.omittedMessages, omittedRuns: page.omittedRuns,
  ...(page.activeWindow ? { activeWindow: page.activeWindow } : {}), ...(page.sessionImageAnchor ? { sessionImageAnchor: page.sessionImageAnchor } : {}),
  ...(page.sessionDocumentAnchor ? { sessionDocumentAnchor: page.sessionDocumentAnchor } : {}) });

/** Produces a persisted, inspectable context only at a coordinator's safe turn boundary. */
export class ContextService {
  readonly memory: SemanticMemoryService;
  readonly activePrefix?: ActivePrefixMemoryService;
  private readonly sources = new Map<string, { source: InstructionSources; leases: number }>();
  private readonly history = new WeakMap<SessionSnapshot, SnapshotHistory>();
  private readonly mediaHistoryPolicy?: Required<MediaHistoryPolicy>;
  private readonly documentHistoryPolicy?: DocumentHistoryPolicy;
  private readonly repositoryContext?: { source: ContextSourcePort; policy: RepositoryContextPolicy };
  private readonly knowledgeContext?: NonNullable<ContextServiceOptions['knowledgeContext']>;
  private readonly proposalContext?: NonNullable<ContextServiceOptions['proposalContext']>;
  private readonly lifecycleHooks?: LifecycleHookRegistry;
  private readonly lifecycleContextSlotBytes: number;
  private readonly contextCaptures = new Map<string, { repository?: PreparedRepositoryContribution; knowledge?: PreparedKnowledgeContribution; proposal?: PreparedProposalContribution; lifecycle?: LifecycleCapture; fork?: {sha256:string; config:RunConfig}; revisionId: string; messagesSha256: string; runId?: string }>();
  private readonly conversationFork?: ContextServiceOptions['conversationFork'];
  private readonly contextReservations = new Map<string, symbol>();
  constructor(private readonly store: SqliteStore, readonly models = new ModelRegistry(), private readonly outputTokenReserve = 0, private readonly provider?: (id: string) => ProviderAdapter | undefined, options: ContextServiceOptions = {}) {
    if (!Number.isSafeInteger(outputTokenReserve) || outputTokenReserve < 0 || outputTokenReserve > 100_000_000) throw new EngineError('INVALID_OUTPUT_RESERVE', 'Output token reserve must be a bounded nonnegative integer');
    this.conversationFork = options.conversationFork;
    this.lifecycleHooks = options.lifecycleHooks;
    this.lifecycleContextSlotBytes = options.lifecycleContextSlotBytes ?? 8192;
    if (!Number.isSafeInteger(this.lifecycleContextSlotBytes) || this.lifecycleContextSlotBytes < 128 || this.lifecycleContextSlotBytes > 16_384)
      throw new EngineError('INVALID_LIFECYCLE_CONTEXT', 'Lifecycle context reservation must be between 128 and 16384 bytes');
    this.memory = new SemanticMemoryService(store);
    if (options.activePrefixPolicy !== undefined) this.activePrefix = new ActivePrefixMemoryService(store, options.activePrefixPolicy);
    if (options.mediaHistoryPolicy !== undefined) this.mediaHistoryPolicy = validateMediaHistoryPolicy(options.mediaHistoryPolicy);
    if (options.documentHistoryPolicy !== undefined) this.documentHistoryPolicy = validateDocumentHistoryPolicy(options.documentHistoryPolicy);
    if (options.repositoryContext !== undefined) {
      if (!options.repositoryContext.source || typeof options.repositoryContext.source.prepare !== 'function' || typeof options.repositoryContext.source.assertFresh !== 'function')
        throw new EngineError('INVALID_REPOSITORY_CONTEXT', 'Repository context requires a host-owned prepare/freshness source');
      this.repositoryContext = { source: options.repositoryContext.source, policy: repositoryContextPolicy(options.repositoryContext.policy) };
    }
    if (options.knowledgeContext !== undefined) {
      const configured = options.knowledgeContext;
      if (!configured.source || typeof configured.source.prepare !== 'function' || typeof configured.source.assertFresh !== 'function' || typeof configured.source.release !== 'function'
        || configured.getProfile !== undefined && typeof configured.getProfile !== 'function')
        throw new EngineError('INVALID_KNOWLEDGE_CONTEXT', 'Knowledge context requires a separate host prepare/freshness/release source');
      this.knowledgeContext = { source: configured.source, policy: knowledgeContextPolicy(configured.policy), ...(configured.getProfile ? { getProfile: configured.getProfile } : {}) };
    }
    if (options.proposalContext !== undefined) {
      const configured = options.proposalContext;
      if (!configured.source || typeof configured.source.prepare !== 'function' || typeof configured.source.assertFresh !== 'function' || typeof configured.source.release !== 'function'
        || configured.getProfile !== undefined && typeof configured.getProfile !== 'function') throw new EngineError('INVALID_PROPOSAL_CONTEXT', 'Proposal overlay requires an original host context source');
      this.proposalContext = { source: configured.source, policy: proposalContextPolicy(configured.policy), ...(configured.getProfile ? { getProfile: configured.getProfile } : {}) };
    }
  }
  async assertFresh(sessionId: string | undefined, messages: readonly ProviderMessage[], signal: AbortSignal, runId?: string): Promise<void> {
    const hasLifecycle = sessionId !== undefined && this.contextCaptures.get(sessionId)?.lifecycle !== undefined;
    if (!this.repositoryContext && !this.knowledgeContext && !this.proposalContext && !hasLifecycle && !this.contextCaptures.get(sessionId??'')?.fork) return;
    const stale = this.repositoryContext ? 'REPOSITORY_CONTEXT_STALE' : this.knowledgeContext ? 'KNOWLEDGE_CONTEXT_STALE' : this.proposalContext ? 'PROPOSAL_CONTEXT_STALE' : 'LIFECYCLE_CONTEXT_STALE', cancelled = this.repositoryContext ? 'REPOSITORY_CONTEXT_CANCELLED' : this.knowledgeContext ? 'KNOWLEDGE_CONTEXT_CANCELLED' : this.proposalContext ? 'PROPOSAL_CONTEXT_CANCELLED' : 'LIFECYCLE_CONTEXT_CANCELLED';
    if (typeof sessionId !== 'string' || !sessionId) throw new EngineError(stale, 'Supplemental context requires its prepared session owner');
    if (signal.aborted) throw new EngineError(cancelled, 'Supplemental context dispatch was cancelled');
    const captured = this.contextCaptures.get(sessionId);
    const valid = () => captured && this.contextCaptures.get(sessionId) === captured && this.revisionId(sessionId) === captured.revisionId
      && this.store.getSessionDocument(sessionId, 'context.head')?.data.revisionId === captured.revisionId
      && digest(messages) === captured.messagesSha256 && (runId === undefined || captured.runId === runId);
    if (captured?.fork) this.conversationFork!.assertFresh(sessionId,captured.fork.sha256,captured.fork.config);
    if (!valid()) throw new EngineError(stale, 'Dispatch does not match the prepared context, revision and Run owner');
    if (captured!.lifecycle) this.lifecycleHooks!.assertCurrent(captured!.lifecycle);
    if (captured!.repository) await this.repositoryContext!.source.assertFresh(captured!.repository, signal);
    if (signal.aborted) throw new EngineError(cancelled, 'Supplemental context dispatch was cancelled');
    if (!valid()) throw new EngineError(stale, 'Prepared context ownership changed during freshness validation');
    if (captured!.lifecycle) this.lifecycleHooks!.assertCurrent(captured!.lifecycle);
    if (captured!.knowledge) await this.knowledgeContext!.source.assertFresh(captured!.knowledge, signal);
    if (captured!.proposal) await this.proposalContext!.source.assertFresh(captured!.proposal, signal);
    if (signal.aborted) throw new EngineError(cancelled, 'Supplemental context dispatch was cancelled');
    if (!valid()) throw new EngineError(stale, 'Prepared context ownership changed during freshness validation');
    if (captured!.lifecycle) this.lifecycleHooks!.assertCurrent(captured!.lifecycle);
  }
  releaseContext(sessionId: string, runId?: string): void {
    const captured = this.contextCaptures.get(sessionId);
    if (captured && (runId === undefined || captured.runId === runId)) {
      this.contextCaptures.delete(sessionId);
      if (captured.knowledge) this.knowledgeContext!.source.release(captured.knowledge);
      if (captured.proposal) this.proposalContext!.source.release(captured.proposal);
    }
  }
  private reserveContextCapture(sessionId: string): symbol {
    if (this.contextReservations.has(sessionId)) throw new EngineError('CONTEXT_CAPTURE_BUSY', 'This session already has a context construction owner');
    const pending = [...this.contextReservations.keys()].filter(id => !this.contextCaptures.has(id)).length;
    if (!this.contextCaptures.has(sessionId) && this.contextCaptures.size + pending >= 128) {
      const idle = [...this.contextCaptures].find(([id, capture]) => !this.contextReservations.has(id) && (capture.runId === undefined || isTerminal(this.store.getRun(capture.runId).state)));
      if (!idle) throw new EngineError('CONTEXT_CAPTURE_LIMIT', 'Active or preparing context owners have filled the bounded capture cache');
      this.releaseContext(idle[0]);
    }
    const reservation = Symbol('context-owner'); this.contextReservations.set(sessionId, reservation); return reservation;
  }
  snapshot(sessionId: string, config: RunConfig): SessionSnapshot {
    const page = this.store.readModelHistory(sessionId, 512, Math.max(1024, Math.min(33_554_432, config.limits.maxContextBytes * 4)));
    this.history.set(page.snapshot, snapshotHistory(page));
    return page.snapshot;
  }
  private historyForSnapshot(snapshot: SessionSnapshot, config: RunConfig): SnapshotHistory | undefined {
    const owned = this.history.get(snapshot);
    if (owned) return owned;
    // Public callers may copy or supply a snapshot. Current SQL metadata belongs
    // to that copy only when the complete native snapshot still matches it.
    let page: ModelHistoryPage;
    try { page = this.store.readModelHistory(snapshot.session.id, 512, Math.max(1024, Math.min(33_554_432, config.limits.maxContextBytes * 4))); }
    catch (error) { if (error instanceof EngineError && error.code === 'MODEL_HISTORY_LIMIT') return undefined; throw error; }
    if (digest(page.snapshot) !== digest(snapshot)) return undefined;
    const metadata = snapshotHistory(page); this.history.set(snapshot, metadata); return metadata;
  }
  revisionId(sessionId: string): string | undefined {
    return this.diagnostics(sessionId)?.revisionId;
  }
  diagnostics(sessionId: string): ContextDiagnostics | null {
    this.store.getSession(sessionId);
    return structuredClone(this.store.getSessionDocument(sessionId, 'context.head')?.data.diagnostics as unknown as ContextDiagnostics ?? null);
  }
  private relevantPaths(request: ContextRequest): { paths: string[]; warnings: string[] } {
    const activeRunId = request.snapshot.runs.findLast(run => !isTerminal(run.state))?.id;
    const paths = new Set<string>();
    for (const call of request.snapshot.tools) {
      if (call.runId !== activeRunId || !FILE_TOOLS.has(call.name) || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) continue;
      for (const key of ['path', 'destination']) if (typeof call.input[key] === 'string' && paths.size < 24) paths.add(call.input[key]);
      if (Array.isArray(call.input.changes)) for (const change of call.input.changes) {
        if (change && typeof change === 'object' && !Array.isArray(change) && typeof change.path === 'string' && paths.size < 24) paths.add(change.path);
      }
    }
    return instructionPathHints(request.workspace.root, paths);
  }
  async recoverOverflow(request: ContextRequest, provider: ProviderAdapter): Promise<void> {
    if (this.activePrefix && request.run && request.activePrefixStage?.stage === 'overflow-recovery') {
      const before = this.activePrefix.active(request.snapshot.session.id, request.run.id)?.checkpoint.id;
      await this.build(request, true, false, true);
      if (this.activePrefix.active(request.snapshot.session.id, request.run.id)?.checkpoint.id !== before) return;
    }
    await this.memory.summarize(request, provider);
  }
  async build(request: ContextRequest, summaryAttempted = false, prefixAttempted = false, forcePrefix = false): Promise<ProviderMessage[]> {
    const sessionId = request.snapshot.session.id;
    const history = this.historyForSnapshot(request.snapshot, request.config);
    const lifecycle = request.lifecycleCapture?.hooks.some(hook => hook.stages.includes('model-context')) ? request.lifecycleCapture : undefined;
    if (lifecycle && (!this.lifecycleHooks || !request.run || lifecycle.identity.runId !== request.run.id || lifecycle.identity.sessionId !== sessionId || lifecycle.identity.workspaceId !== request.workspace.id))
      throw new EngineError('LIFECYCLE_CONTEXT_STALE', 'Lifecycle context requires its original captured Run owner');
    if (lifecycle) this.lifecycleHooks!.assertCurrent(lifecycle);
    const lifecycleSlot = lifecycle ? this.lifecycleContextSlotBytes : 0;
    const originalReservedBytes = request.reservedBytes ?? 0;
    const reservedBytes = originalReservedBytes + lifecycleSlot;
    const initialFork = this.conversationFork?.prepare(sessionId, request.config);
    const reservation = this.repositoryContext || this.knowledgeContext || this.proposalContext || lifecycle || initialFork ? this.reserveContextCapture(sessionId) : undefined;
    const releaseReservation = () => { if (reservation && this.contextReservations.get(sessionId) === reservation) this.contextReservations.delete(sessionId); };
    const preparedKnowledge = new Set<PreparedKnowledgeContribution>();
    const preparedProposals = new Set<PreparedProposalContribution>();
    const releaseDiscarded = (keep?: PreparedKnowledgeContribution, keepProposal?: PreparedProposalContribution) => {
      for (const prepared of preparedKnowledge) if (prepared !== keep) { preparedKnowledge.delete(prepared); this.knowledgeContext!.source.release(prepared); }
      for (const prepared of preparedProposals) if (prepared !== keepProposal) { preparedProposals.delete(prepared); this.proposalContext!.source.release(prepared); }
    };
    try {
    const cacheKey = JSON.stringify([request.workspace.id, sessionId]);
    let cached = this.sources.get(cacheKey);
    if (!cached) {
      if (this.sources.size >= 128) {
        const idle = [...this.sources].find(([, entry]) => entry.leases === 0);
        if (!idle) throw new EngineError('WORKSPACE_CONTEXT_LIMIT', 'Too many concurrent workspace instruction observations');
        // Baselines remain in session documents and are owner-validated on reload.
        this.sources.delete(idle[0]);
      }
      const key = (id: string) => `instruction.${digest(id).slice(0, 32)}`;
      const workspace = request.workspace;
      const source = new InstructionSources(workspace.root, {
        loadBaseline: id => this.store.getSessionDocument(sessionId, key(id))?.data.source as unknown as InstructionSource ?? null,
        saveBaseline: source => {
          const previous = this.store.getSessionDocument(sessionId, key(source.id));
          const prior = previous?.data.source as unknown as InstructionSource | undefined;
          if (prior?.sha256 === source.sha256 && prior?.status === source.status && prior.workspaceRoot === source.workspaceRoot) return;
          this.store.putSessionDocument(sessionId, key(source.id), previous?.revision ?? 0, { source: JSON.parse(JSON.stringify(source)) as JsonObject });
        },
      }, (directories, signal) => gitIgnoredPaths(workspace, directories, signal)); cached = { source, leases: 0 }; this.sources.set(cacheKey, cached);
    } else {
      this.sources.delete(cacheKey); this.sources.set(cacheKey, cached);
    }
    const hints = this.relevantPaths(request);
    cached.leases++;
    let observation: InstructionObservation;
    try { observation = await cached.source.observe(hints.paths, request.signal); }
    finally { cached.leases--; }
    observation.warnings.push(...hints.warnings);
    const model = this.models.get(request.config.providerId, request.config.modelId);
    const makePlan = async (candidate?: PreparedActivePrefix) => {
      const remembered = this.memory.project(request);
      const prefix = this.activePrefix?.project(remembered, candidate) ?? remembered;
      // Completed-history memory may predate the bounded SQL window that exposed
      // this image. Retain its exact user text/refs and owner above that cutoff.
      const image = request.snapshot.messages.findLast(message => message.role === 'user' && message.attachments?.length);
      const document = request.snapshot.messages.findLast(message => message.role === 'user' && message.documents?.length);
      const segment = request.snapshot.messages.findLast(message => message.role === 'user' && message.media?.length);
      let restored = prefix.snapshot;
      for (const input of [image, document, segment]) if (input && !restored.messages.some(message => message.id === input.id)) {
        const origin = request.snapshot.runs.find(run => run.id === input.runId);
        if (!origin) throw new EngineError('MODEL_HISTORY_BINDING_MISMATCH', 'Required session input has no retained Run owner');
        const selectedIds = new Set(restored.messages.map(message => message.id)); selectedIds.add(input.id);
        const runIds = new Set(restored.runs.map(run => run.id)); runIds.add(origin.id);
        restored = { ...restored, messages: request.snapshot.messages.filter(message => selectedIds.has(message.id)),
          runs: request.snapshot.runs.filter(run => runIds.has(run.id)) };
      }
      const media = this.mediaHistoryPolicy ? projectMediaHistory(restored, { policy: this.mediaHistoryPolicy, ...(request.run ? { activeRunId: request.run.id } : {}) }, request.signal) : undefined;
      const documents = this.documentHistoryPolicy ? projectDocumentHistory(media?.snapshot ?? restored, { policy: this.documentHistoryPolicy, ...(request.run ? { activeRunId: request.run.id } : {}) }, request.signal) : undefined;
      const projected = { ...prefix, snapshot: projectToolHistory(documents?.snapshot ?? media?.snapshot ?? restored, request.run?.id),
        requiredHistoryMessageIds: [...new Set([...(prefix.requiredHistoryMessageIds ?? []), ...(image ? [image.id] : []), ...(document ? [document.id] : []), ...(segment ? [segment.id] : []), ...(media ? [...media.requiredTextMessageIds, ...media.requiredExchangeMessageIds] : []), ...(documents?.requiredTextMessageIds ?? [])])],
        ...(media?.requiredNotice ? { mediaHistoryNotice: media.requiredNotice } : {}), ...(documents?.requiredNotice ? { documentHistoryNotice: documents.requiredNotice } : {}) };
      const planRequest = { ...projected, reservedBytes, instructionSources: observation.sources };
      const fork = initialFork;
      const forkOptions = fork ? {forkMessages:fork.messages} : {};
      let contribution: PreparedRepositoryContribution | undefined;
      let knowledge: PreparedKnowledgeContribution | undefined;
      let proposal: PreparedProposalContribution | undefined;
      try {
      const prepareRepository = (requiredMessagesBytes: number) => {
        const configured = this.repositoryContext!;
        return configured.source.prepare({ workspace: request.workspace, query: configured.policy.query,
          ...(configured.policy.exactRanges === undefined ? {} : { exactRanges: configured.policy.exactRanges }), signal: request.signal,
          budget: { slotBytes: configured.policy.slotBytes, maxContextBytes: request.config.limits.maxContextBytes,
            reservedBytes, requiredMessagesBytes, contextWindow: model.contextWindow, outputTokens: this.outputTokenReserve } });
      };
      let plan: ContextPlan;
      if (this.repositoryContext || this.knowledgeContext || this.proposalContext) {
        const required = await planContext(planRequest, { model, outputTokens: this.outputTokenReserve, ...forkOptions, requiredOnly: true });
        const requiredMessagesBytes = required.bytes - reservedBytes;
        if (this.repositoryContext) contribution = await prepareRepository(requiredMessagesBytes);
        const repositoryBytes = contribution ? entriesBytes(contribution.messages) : 0;
        if (this.knowledgeContext) {
          const configured = this.knowledgeContext;
          knowledge = await configured.source.prepare({ workspace: request.workspace, policy: configured.policy,
            owner: { sessionId, runId: request.run?.id ?? null, profile: request.run ? configured.getProfile?.(request.run) ?? null : null }, signal: request.signal,
            budget: { slotBytes: configured.policy.slotBytes, maxContextBytes: request.config.limits.maxContextBytes,
              reservedBytes, requiredMessagesBytes: requiredMessagesBytes + repositoryBytes,
              contextWindow: model.contextWindow, outputTokens: this.outputTokenReserve } });
          preparedKnowledge.add(knowledge);
        }
        if (this.proposalContext) {
          const configured = this.proposalContext;
          const knowledgeBytes = knowledge ? entriesBytes(knowledge.messages) : 0;
          proposal = await configured.source.prepare({ workspace: request.workspace, policy: configured.policy,
            owner: { sessionId, runId: request.run?.id ?? null, profile: request.run ? configured.getProfile?.(request.run) ?? null : null }, signal: request.signal,
            budget: { slotBytes: configured.policy.slotBytes, maxContextBytes: request.config.limits.maxContextBytes,
              reservedBytes, requiredMessagesBytes: requiredMessagesBytes + repositoryBytes + knowledgeBytes,
              contextWindow: model.contextWindow, outputTokens: this.outputTokenReserve } });
          preparedProposals.add(proposal);
        }
        plan = await planContext(planRequest, { model, outputTokens: this.outputTokenReserve, ...forkOptions,
          ...(contribution ? { repositoryMessages: contribution.messages } : {}), ...(knowledge ? { knowledgeMessages: knowledge.messages } : {}), ...(proposal ? { proposalMessages: proposal.messages } : {}) });
      } else {
        plan = await planContext(planRequest, { model, outputTokens: this.outputTokenReserve, ...forkOptions });
      }
      return { projected, media, documents, plan, contribution, knowledge, proposal, fork };
      } catch (error) {
        if (knowledge && preparedKnowledge.delete(knowledge)) this.knowledgeContext!.source.release(knowledge);
        if (proposal && preparedProposals.delete(proposal)) this.proposalContext!.source.release(proposal);
        throw error;
      }
    };
    const provider = this.provider?.(request.config.providerId);
    let candidate: PreparedActivePrefix | undefined;
    let handedOff = false;
    let prefixTried = prefixAttempted;
    let outcome: Awaited<ReturnType<typeof makePlan>>;
    try { outcome = await makePlan(); }
    catch (initialError) {
      if (prefixTried || !this.activePrefix || !request.run || !request.budget || !provider || !(initialError instanceof EngineError)
        || !['CONTEXT_LIMIT', 'ACTIVE_PREFIX_CONTEXT_LIMIT', 'IMAGE_CONTEXT_LIMIT', 'DOCUMENT_CONTEXT_LIMIT', 'CONTEXT_TOKEN_LIMIT'].includes(initialError.code)) throw initialError;
      // The predecessor protects the recent suffix it observed. After another
      // complete exchange, a new checkpoint may cover part of that old suffix
      // and fit even when planning with the predecessor alone no longer fits.
      prefixTried = true;
      try {
        candidate = await this.activePrefix.prepare(request, provider, { model, ...(request.activePrefixStage ? { stage: request.activePrefixStage } : {}) });
        outcome = await makePlan(candidate);
      } catch (error) {
        if (candidate) this.activePrefix.discard(candidate, error);
        if (request.signal.aborted || error instanceof EngineError && ['OUTPUT_LIMIT', 'RUN_TIME_LIMIT', 'CLEANUP_UNCERTAIN'].includes(error.code)) throw error;
        throw initialError;
      }
    }
    let { projected, media, documents, plan, contribution, knowledge, proposal, fork } = outcome;
    releaseDiscarded(knowledge, proposal);
    const selectedIds = new Set(plan.selectedMessageIds);
    const omittedDiscussion = projected.snapshot.messages.some(message => message.runId !== request.run?.id && message.role !== 'tool' && message.content.trim() && !selectedIds.has(message.id));
    if (!candidate && !summaryAttempted && omittedDiscussion && request.run && request.budget && provider) {
      try { await this.memory.summarize(request, provider); releaseDiscarded(); releaseReservation(); return this.build(request, true, prefixAttempted, forcePrefix); }
      catch (error) {
        if (request.signal.aborted || error instanceof EngineError && ['OUTPUT_LIMIT', 'RUN_TIME_LIMIT', 'CLEANUP_UNCERTAIN'].includes(error.code)) throw error;
        plan.warnings.push(`Semantic summary was not activated (${error instanceof EngineError ? error.code : 'SUMMARY_FAILED'}); the previous memory remains in use.`);
      }
    }
    const omittedActive = projected.snapshot.messages.some(message => message.runId === request.run?.id && message.role !== 'user' && !selectedIds.has(message.id))
      || (history?.activeWindow?.omittedMessages ?? 0) > 0;
    if (!candidate && !prefixTried && this.activePrefix && request.run && request.budget && provider && (forcePrefix || omittedActive)) {
      try {
        candidate = await this.activePrefix.prepare(request, provider, { model, ...(request.activePrefixStage ? { stage: request.activePrefixStage } : {}) });
        ({ projected, media, documents, plan, contribution, knowledge, proposal } = await makePlan(candidate));
        releaseDiscarded(knowledge, proposal);
      } catch (error) {
        if (candidate) this.activePrefix.discard(candidate, error);
        candidate = undefined;
        if (request.signal.aborted || error instanceof EngineError && ['OUTPUT_LIMIT', 'RUN_TIME_LIMIT', 'CLEANUP_UNCERTAIN'].includes(error.code)) throw error;
        plan.warnings.push(`Active-prefix summary was not activated (${error instanceof EngineError ? error.code : 'SUMMARY_FAILED'}); the previous checkpoint remains in use.`);
      }
    }
    try {
    if (request.signal.aborted) throw new EngineError('CANCELLED', 'Context construction was cancelled');
    let lifecycleDiagnostics: ContextDiagnostics['lifecycleContext'];
    if (lifecycle) {
      const baseContextSha256 = plan.sha256;
      const invocationId = `${request.run!.id}:context:${request.turnIndex ?? 0}:${baseContextSha256}`;
      const dispatched = await this.lifecycleHooks!.dispatch(lifecycle, { invocationId, identity: lifecycle.identity, stage: 'model-context', metadata: {
        providerId: request.config.providerId, modelId: request.config.modelId, turnIndex: request.turnIndex ?? 0,
        contextSha256: baseContextSha256, contextBytes: Buffer.byteLength(JSON.stringify(plan.messages)), slotBytes: lifecycleSlot,
      } }, request.signal);
      const payload = { invocationId, stage: 'model-context', registryRevision: dispatched.registryRevision, status: dispatched.status, action: dispatched.action,
        outcomes: dispatched.outcomes.map(item => ({ hookId: item.hookId, revision: item.hookRevision, status: item.status, action: item.action, elapsedMs: item.elapsedMs,
          ...(item.code ? { code: item.code } : {}), ...(item.transform ? { transform: item.transform } : {}) })) } as JsonObject;
      this.store.commitRunObservation(request.run!.id, 'lifecycle.outcome', payload);
      this.lifecycleHooks!.assertCurrent(lifecycle);
      if (dispatched.status === 'cancelled' || dispatched.action === 'stop') throw new EngineError('RUN_CANCELLED', 'Lifecycle context callback stopped request construction');
      if (dispatched.status === 'stale') throw new EngineError('LIFECYCLE_REGISTRY_STALE', 'Lifecycle registry changed during context construction');
      if (dispatched.action === 'deny') throw new EngineError('LIFECYCLE_DENIED', 'Lifecycle context callback denied request construction');
      let lifecycleMessages: ProviderMessage[] = [];
      if (dispatched.contextData) {
        lifecycleMessages = [{ role: 'assistant', content: '[Moodcode lifecycle context data v1]\n' + JSON.stringify({ schemaVersion: 1, authority: 'data-only', items: dispatched.contextData.items }) }];
        if (entriesBytes(lifecycleMessages) > lifecycleSlot) throw new EngineError('LIFECYCLE_CONTEXT_LIMIT', 'The complete lifecycle data entry exceeds its reserved slot');
      }
      lifecycleDiagnostics = { registryRevision: lifecycle.registryRevision, baseContextSha256, dataSha256: dispatched.contextData?.sha256 ?? null,
        messageBytes: entriesBytes(lifecycleMessages), hookIds: dispatched.contextData?.items.map(item => item.hookId) ?? [] };
      // Preserve the exact base snapshot accepted by the callbacks. Releasing
      // unused reservation never selects additional unobserved history.
      const index = plan.messages.findIndex(message => message.role !== 'system');
      const insertion = index < 0 ? plan.messages.length : index;
      const messages = [...plan.messages.slice(0, insertion), ...lifecycleMessages, ...plan.messages.slice(insertion)];
      const text = JSON.stringify(messages), inputEstimate = estimateTokens(messages, originalReservedBytes);
      const bytes = Buffer.byteLength(text) + originalReservedBytes;
      if (bytes > plan.byteLimit || plan.tokenLimit !== null && inputEstimate.tokens + plan.reservations.outputTokens > plan.tokenLimit)
        throw new EngineError('LIFECYCLE_CONTEXT_LIMIT', 'Whole lifecycle data exceeds the original byte or model window reservation');
      plan = { ...plan, messages, sha256: createHash('sha256').update(text).digest('hex'), bytes, inputEstimate,
        reservations: { ...plan.reservations, envelopeBytes: originalReservedBytes, ...(lifecycleDiagnostics.messageBytes ? { lifecycleBytes: lifecycleDiagnostics.messageBytes } : {}) } };
      this.lifecycleHooks!.assertCurrent(lifecycle);
    }
    if (contribution) await this.repositoryContext!.source.assertFresh(contribution, request.signal);
    if (knowledge) await this.knowledgeContext!.source.assertFresh(knowledge, request.signal);
    if (proposal) await this.proposalContext!.source.assertFresh(proposal, request.signal);
    if (request.signal.aborted) throw new EngineError('CANCELLED', 'Context construction was cancelled before persistence');
    const previous = this.store.getSessionDocument(sessionId, 'context.head');
    const prefixCheckpoint = candidate?.checkpoint ?? (request.run ? this.activePrefix?.active(sessionId, request.run.id)?.checkpoint : undefined);
    const observedSourceIds = [...plan.selectedMessageIds, ...observation.sources.filter(source => source.sha256 !== null).map(source => `${source.id}:${source.sha256}`),
      ...(lifecycleDiagnostics ? [`lifecycle-registry:${lifecycleDiagnostics.registryRevision}`, `lifecycle-base:${lifecycleDiagnostics.baseContextSha256}`,
        ...(lifecycleDiagnostics.dataSha256 ? [`lifecycle-data:${lifecycleDiagnostics.dataSha256}`] : [])] : []),
      ...(prefixCheckpoint ? [prefixCheckpoint.revisionId, `active-prefix-policy:${prefixCheckpoint.policySha256}`, `active-prefix-facts:${prefixCheckpoint.factsSha256}`, `active-prefix-manifest:${prefixCheckpoint.manifestSha256}`] : []),
      ...(media ? [`image-policy:${media.diagnostics.policySha256}`, `image-source:${media.diagnostics.sourceSha256}`, ...media.provenance.map(item => `image-message:${item.messageId}:${digest(item)}`)] : []),
      ...(documents ? [`document-policy:${documents.diagnostics.policySha256}`, `document-source:${documents.diagnostics.sourceSha256}`, ...documents.provenance.map(item => `document-message:${item.messageId}:${digest(item)}`)] : []),
      ...(contribution ? [`repository-contribution:${contribution.id}`, `repository-generation:${contribution.generation}`,
        ...(contribution.sourceManifest.projectSources ?? []).map(source => `repository-project:${source.serverId}:${source.sha256}`),
        ...contribution.observedSources.map(source => `repository-source:${source.path}:${source.hash}`)] : []),
      ...(knowledge ? [`knowledge-policy:${knowledge.policySha256}`, `knowledge-contribution:${knowledge.id}`, `knowledge-binding:${knowledge.bindingSha256}`,
        ...knowledge.documents.flatMap(document => [`knowledge-document:${document.documentRevisionId}:${document.documentSha256}`,
          `knowledge-publication:${document.publicationId}:${document.publicationSha256}`, `knowledge-receipt:${document.receiptId}:${document.receiptSha256}`,
          `knowledge-candidate:${document.candidateId}:${document.candidateSha256}`, `knowledge-generation:${document.generationId}:${document.generationSha256}`,
          `knowledge-attempt:${document.attemptId}:${document.attemptSha256}`, `knowledge-plan:${document.planId}:${document.planSha256}`,
          `knowledge-trust:${document.trustRevisionId}:${document.trustRevisionSha256}`, `knowledge-source:${document.sourceManifestSha256}`,
          ...(document.importActivation ? [`knowledge-import-activation:${document.importActivation.activationId}:${document.importActivation.activationSha256}`,
            `knowledge-import-frontier:${document.importActivation.frontierId}:${document.importActivation.frontierSha256}`, `knowledge-import-resume:${document.importActivation.resumeDecisionSha256}`,
            `knowledge-import-original-binding:${document.importActivation.originalBindingSha256}`] : [])])] : []),
      ...(proposal ? [`proposal-policy:${proposal.policySha256}`, ...proposalContributionSourceIds(proposal)] : [])];
    if (fork) observedSourceIds.push(...fork.sourceIds);
    const sourceIds = [...new Set(observedSourceIds)];
    const bindingHash = digest({ plan: plan.sha256, sources: sourceIds, config: request.config, model: { ...model, source: { kind: model.source.kind, reference: model.source.reference } } });
    const old = previous?.data;
    const oldRevisionId = typeof old?.revisionId === 'string' ? old.revisionId : undefined;
    let revisionId = oldRevisionId;
    let revision = typeof old?.contextRevision === 'number' ? old.contextRevision : 0;
    let pendingRevision: ContextRevision | undefined;
    if (candidate || old?.bindingHash !== bindingHash || !revisionId) {
      revisionId = randomUUID(); revision = candidate ? candidate.summaryRevision.revision + 1 : this.store.nextContextRevisionIndex(sessionId);
      const text = JSON.stringify(plan.messages);
      const latest = candidate?.summaryRevision ?? this.store.getLatestContextRevision(sessionId);
      pendingRevision = { schemaVersion: SESSION_SCHEMA_VERSION, id: revisionId, sessionId, revision, kind: revision === 1 ? 'baseline' : 'update',
        sourceIds, text, sha256: createHash('sha256').update(text).digest('hex'), createdAt: new Date().toISOString(), ...(request.run ? { runId: request.run.id } : {}), ...(latest ? { supersedesId: latest.id } : {}) };
    }
    const { messages, ...publicPlan } = plan;
    const repositoryDiagnostics = contribution ? (() => {
      const { messages: ignoredMessages, snippets, ...metadata } = contribution;
      return { ...metadata, snippets: snippets.map(({ text: ignoredText, ...snippet }) => snippet) };
    })() : undefined;
    const knowledgeDiagnostics = knowledge ? (() => { const { messages: ignoredMessages, ...metadata } = knowledge; return metadata; })() : undefined;
    const proposalDiagnostics = proposal ? (() => { const { messages: ignoredMessages, ...metadata } = proposal; return metadata; })() : undefined;
    // Text is retained in ContextRevision; diagnostics carry source hashes and observations only.
    const diagnostics: ContextDiagnostics = { revisionId, revision, plan: publicPlan,
      instructions: { ...observation, sources: observation.sources.map(source => ({ ...source, text: null })) },
      ...(history?.activeWindow ? { activeWindow: history.activeWindow } : {}),
      ...(history?.sessionImageAnchor ? { sessionImageAnchor: history.sessionImageAnchor } : {}),
      ...(history?.sessionDocumentAnchor ? { sessionDocumentAnchor: history.sessionDocumentAnchor } : {}),
      ...(media ? { mediaHistory: { ...media.diagnostics, provenance: media.provenance } } : {}),
      ...(documents ? { documentHistory: { ...documents.diagnostics, provenance: documents.provenance } } : {}),
      ...(repositoryDiagnostics ? { repositoryContext: repositoryDiagnostics } : {}),
      ...(knowledgeDiagnostics ? { knowledgeContext: knowledgeDiagnostics } : {}),
      ...(proposalDiagnostics ? { proposalContext: proposalDiagnostics } : {}),
      ...(lifecycleDiagnostics ? { lifecycleContext: lifecycleDiagnostics } : {}),
      ...(prefixCheckpoint ? { activePrefix: { checkpointId: prefixCheckpoint.id, summaryRevisionId: prefixCheckpoint.revisionId, scope: prefixCheckpoint.scope, projection: prefixCheckpoint.projection,
        factsSha256: prefixCheckpoint.factsSha256, manifestSha256: prefixCheckpoint.manifestSha256, policySha256: prefixCheckpoint.policySha256,
        coveredMessageIds: prefixCheckpoint.coveredMessageIds, protectedMessageIds: prefixCheckpoint.protectedMessageIds, summaryUsage: prefixCheckpoint.usage,
        historicalFileEvidence: true, currentFileEvidence: false } } : {}),
      omittedDatabaseMessages: history?.omittedMessages ?? 0, omittedDatabaseRuns: history?.omittedRuns ?? 0 };
    const data = { revisionId, contextRevision: revision, bindingHash, diagnostics: JSON.parse(JSON.stringify(diagnostics)) as JsonObject };
    if (candidate && pendingRevision) {
      handedOff = true;
      try { this.activePrefix!.publishWithContext(request, candidate, { contextRevision: pendingRevision, contextData: data }); }
      catch (error) {
        if (request.signal.aborted || error instanceof EngineError && ['OUTPUT_LIMIT', 'RUN_TIME_LIMIT', 'CLEANUP_UNCERTAIN'].includes(error.code)) throw error;
        if (!(error instanceof EngineError) || !['REVISION_CONFLICT', 'ACTIVE_PREFIX_SOURCE_CHANGED', 'ACTIVE_PREFIX_CONTEXT_CONFLICT'].includes(error.code)) throw error;
        // Overflow recovery retains the existing Turn/input proof. A changed
        // frontier stops that recovery rather than redispatching a stale request.
        if (forcePrefix) throw error;
        // Never retry a consumed summary. Re-read the current owner projection before
        // dispatch so a concurrent checkpoint or steer cannot leave stale messages.
        releaseDiscarded(); releaseReservation(); return this.build({ ...request, snapshot: this.snapshot(sessionId, request.config) }, true, true);
      }
    }
    else if (pendingRevision && request.run) this.store.commitContextDocument(request.run.id, 'context.revision.activated', { contextRevisionId: revisionId, revision, sha256: pendingRevision.sha256 }, { revision: pendingRevision, kind: 'context.head', expectedRevision: previous?.revision ?? 0, data });
    else { if (pendingRevision) this.store.putContextRevision(pendingRevision); this.store.putSessionDocument(sessionId, 'context.head', previous?.revision ?? 0, data); }
    if (contribution || knowledge || proposal || lifecycle || fork) {
      this.releaseContext(sessionId);
      this.contextCaptures.set(sessionId, { ...(fork ? {fork:{sha256:fork.sha256,config:structuredClone(request.config)}} : {}), ...(contribution ? { repository: contribution } : {}), ...(knowledge ? { knowledge } : {}), ...(proposal ? { proposal } : {}), ...(lifecycle ? { lifecycle } : {}), revisionId, messagesSha256: digest(messages), ...(request.run ? { runId: request.run.id } : {}) });
      if (knowledge) preparedKnowledge.delete(knowledge);
      if (proposal) preparedProposals.delete(proposal);
    }
    return messages;
    } catch (error) {
      if (candidate && !handedOff) this.activePrefix!.discard(candidate, error);
      throw error;
    }
    } finally {
      try { releaseDiscarded(); } finally { releaseReservation(); }
    }
  }
}
