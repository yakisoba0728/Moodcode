import { lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { types } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { EngineError, isTerminal, SCHEMA_VERSION, SESSION_SCHEMA_VERSION, SESSION_COMMAND_TYPES, type CommandEnvelope, type CommandResult, type EngineCapabilities, type EngineEvent, type InputCursor, type JsonValue, type Run, type RunConfig, type RunConfigInput, type Session, type SessionCommandResult, type SessionEventV2 } from '@moodcode/contracts';
import { assertInputMediaBudget, normalizeAcceptInput, normalizeEngineBudgets, normalizeSubmitInput, validateCommand, validateSessionCommand } from '@moodcode/contracts/validation';
import type { ProviderAdapter, ProviderEvent, ToolDefinition } from './ports.js';
import { SqliteStore, type DatabaseBackup, type IntegrityCheckResult, type StoreBackupOptions } from './storage/index.js';
import type { SummaryAttemptListOptions } from './storage/summary-attempts.js';
import { RunCoordinator } from './runner/index.js';
import { VerificationController, verificationContinuationMessage } from './verification/controller.js';
import { createLifecycleContinuationPort } from './lifecycle/continuation.js';
import type { KnowledgeStorage } from './knowledge/store.js';
import type { KnowledgeHostAdapter, KnowledgeSourceProjection, KnowledgeSourceSelection } from './knowledge/host.js';
import type { PrepareKnowledgeGeneration } from './knowledge/types.js';
import { knowledgeHash, validateGenerationInput } from './knowledge/validation.js';
import { buildKnowledgeGenerationRequest } from './knowledge/generation-request.js';
import { assertKnowledgeGenerationHostInput, KnowledgeGenerationService, type WorkspaceKnowledgeGenerationInput } from './knowledge/generation-service.js';
import type { KnowledgeGenerationStorage } from './knowledge/generation-store.js';
import type { KnowledgeGenerationRecoveryPreview } from './knowledge/generation-types.js';
import type { KnowledgePublicationStorage } from './knowledge/publication-store.js';
import { KnowledgePublicationService } from './knowledge/publication-service.js';
import { KnowledgeFilePublicationService } from './knowledge/file-publication-service.js';
import type { KnowledgeFilePublicationStorage } from './knowledge/file-publication-store.js';
import type { KnowledgeFileRecoveryPreview } from './knowledge/file-publication-types.js';
import { FileKnowledgePublicationHost } from './knowledge/file-publication-fs.js';
import type { KnowledgeFileExecutionGuards } from './knowledge/file-execution-guards.js';
import type { KnowledgeImportRecoveryStorage } from './knowledge/import-recovery-store.js';
import { KnowledgeImportRecoveryService } from './knowledge/import-recovery-service.js';
import { ProposalSourceCaptureHost } from './proposals/source-capture.js';
import { ProposalHostService, type CreateProposalSetInput } from './proposals/host.js';
import { ProposalOverlayContextSource, proposalContextPolicy } from './proposals/overlay.js';
import type { ProposalContextPolicy } from './proposals/overlay.js';
import type { ProposalStorage } from './proposals/store.js';
import type { ProposalApplyStorage } from './proposals/apply-store.js';
import type { ProposalApplyCapture, ProposalApplyCleanup, ProposalApplyRecoveryPreview } from './proposals/apply-types.js';
import type { ProposalApplyExecutionGuards } from './proposals/execution-guards.js';
import { ProposalApplyService } from './proposals/apply-service.js';
import { PhysicalPatchProducer } from './tools/patch/physical.js';
import { knowledgeContextPolicy } from './knowledge/context-source.js';
import type { KnowledgeContextPolicy } from './knowledge/context-types.js';
import { WorkspaceTrustService, assertWorkspaceTrustSourcesCurrent } from './workspace/trust.js';
import { LifecycleHookRegistry, type LifecycleHookRegistration } from './lifecycle/index.js';
import { exportTrajectory, validateTrajectoryOptions, type JournalProjection, type TrajectoryOptions } from './diagnostics/trajectory.js';
import { createCodingEvidenceManifest, validateCodingEvidenceOptions, type CodingEvidenceManifest, type CodingSourceIdentity } from './diagnostics/attempt-manifest.js';
import { getTrajectoryStallObservation, type StallObservation, type StallOptions } from './diagnostics/stall.js';
import { EngineExecutionObserver } from './diagnostics/execution-observer.js';
import { WorkspaceExecutionSource, type WorkspaceExecutionSourceLimits } from './diagnostics/execution-source.js';
import type { DiagnosticExecutionPageOptions } from './diagnostics/execution-observation-types.js';
import { readNativeCodingEvidence, type NativeCodingEvidenceOptions } from './diagnostics/native-attempt-manifest.js';
import { InputScheduler } from './runner/input-scheduler.js';
import { waitChildProviderAdmission } from './child-tasks/provider-admission.js';
import { bindChildTeamModelCatalogue, consumeChildTeamModelCatalogue } from './teams/model-tool-catalogue.js';
import { EngineTeamModelToolHost, type BindTeamModelToolsInput, type TeamModelToolsBinding } from './teams/model-tool-host.js';
import { createTeamModelTools, TEAM_MODEL_TOOL_NAMES, TEAM_MODEL_WRITE_TOOL_NAMES } from './teams/model-tools.js';
import { ScriptedProvider } from './provider/index.js';
import { validateHostGenerationRequest } from './provider/generation.js';
import { ApprovalManager } from './permission/index.js';
import { openWorkspace } from './workspace/index.js';
import { getWorkspaceStatus, listWorkspaceFiles, readWorkspaceFile } from './workspace/presentation.js';
import { buildContext } from './context/index.js';
import { ContextService } from './context/service.js';
import { ModelRegistry, type ModelSpec } from './context/model-spec.js';
import { createReadTools } from './tools/read/index.js';
import { createPatchTool } from './tools/patch/index.js';
import { createCommandTool } from './tools/command/index.js';
import { createExactEditTool } from './tools/edit/index.js';
import { createFileActionTools } from './tools/file-actions/index.js';
import { createPatternSearchTools } from './tools/search/index.js';
import { ScopedToolRuntime, type ScopedToolRuntimeOptions, type RuntimeCommandPreflightOptions, type ToolRegistrationCapture } from './tools/runtime/index.js';
import type { RoleResourcePolicy, RoleResourcePolicySnapshot } from './permission/role-resources.js';
import { RoleResourcePolicyRegistry } from './permission/role-policy-registry.js';
import { readPolicyDecisionReceipts, type PolicyDecisionReceiptPage } from './permission/decision-receipts.js';
import { validateToolDiscoveryPolicy, type ToolDiscoveryPolicy } from './tools/runtime/discovery.js';
import { createToolDiscoveryTool } from './runner/tool-discovery.js';
import { ToolPolicy, type ToolPolicyRule } from './permission/policy.js';
import { ScopedToolGrants } from './permission/grants.js';
import { QuestionManager, type QuestionAnswer } from './questions/index.js';
import { SessionTaskService } from './session-state/index.js';
import { createSessionTaskTools } from './tools/session/index.js';
import { createQuestionTool } from './tools/session/question.js';
import { createLocalReferenceTools } from './tools/session/skills.js';
import { createArtifactReadTool } from './tools/session/artifact.js';
import { ArtifactStore } from './artifacts/store.js';
import { EnginePluginManager, type EnginePlugin, type ActivePlugin } from './plugins/index.js';
import { McpClient, registerMcp, type McpRegistration } from './mcp/index.js';
import { AgentProfiles, type AgentProfileSpec } from './agents/index.js';
import { TerminalService, SqliteTerminalJournal, type PtyBackend } from './terminals/index.js';
import { EngineChildren, type EngineChildRequest } from './child-tasks/engine-host.js';
import { EngineTeamOwners } from './teams/engine-owners.js';
import { EngineWorkflowOwners } from './workflows/engine-owner.js';
import { WorkflowHost } from './workflows/host.js';
import { WorkflowService } from './workflows/service.js';
import type { WorkflowStorage } from './workflows/store.js';
import { EngineScheduleProducer } from './schedules/engine-producer.js';
import { ScheduleHost } from './schedules/host.js';
import { ScheduleDispatcher } from './schedules/dispatcher.js';
import type { ScheduleStorage } from './schedules/store.js';
import { EngineAgentBackendProducer, type CaptureAgentBackendTarget, type AgentBackendSecretResolver } from './agent-backends/engine-producer.js';
import { AgentBackendStorage, type RegisterAgentBackendInput, type DisableAgentBackendInput } from './agent-backends/store.js';
import { OwnedBackendProcesses } from './agent-backends/process.js';
import { AgentBackendHost } from './agent-backends/host.js';
import { agentBackendObject, validateAgentBackendSpec } from './agent-backends/validation.js';
import { TeamHostService } from './teams/host.js';
import { TeamService } from './teams/service.js';
import type { TeamStorage } from './teams/store.js';
import type { ChildTeamTarget, ChildTeamInputEvidence } from './child-tasks/team-bridge.js';
import type { ChildStorageHostIdentity } from './child-tasks/storage-binding.js';
import type { ChildTaskManager, ChildTaskRecord } from './child-tasks/index.js';
import type { WorktreeManager } from './worktrees/index.js';
import { createChildMergeTool } from './child-tasks/merge.js';
import { LspManager, type LspFactory } from './lsp/index.js';
import { FormatterRegistry, createFormatTool, createLspFormatTool } from './formatters/index.js';
import { WorkspaceChangeHub, type WorkspaceChangeWatch, type WorkspaceFileChange } from './workspace/changes.js';
import { assertExecutionLockAvailable, acquireExecutionLock, reserveExecutionLock, readExecutionLockReservation } from './tools/command/execution-lock.js';
import { getReviewDiff, previewRestoreCheckpoint, restoreCheckpoint, type RestoreResult } from './review/index.js';
import { readRecoveryAcknowledgments, isRestoreAcknowledged } from './recovery/index.js';
import { validateSummaryRecoveryRequest, type SummaryRecoveryRequest, type SummaryRecoveryReceipt } from './recovery/summary.js';
import { validateProviderRecoveryRequest, type ProviderRecoveryRequest, type ProviderRecoveryReceipt } from './recovery/provider.js';
import { ReviewJournal, type RestoreOperation, type RestoreOperationInput } from './review/audit.js';
import { ImageAttachmentStore } from './media/index.js';
import { providerImages } from './media/provider.js';
import { DocumentAttachmentStore } from './documents/store.js';
import { providerDocuments } from './documents/provider.js';
import type { InputDocumentAttachment, InputImageAttachment } from '@moodcode/contracts';
import { createDelegateTaskTool } from './child-tasks/delegation.js';
import { validateMediaHistoryPolicy, type MediaHistoryPolicy } from './context/media-history.js';
import { validateActivePrefixPolicy, type ActivePrefixPolicy } from './context/active-prefix.js';
import { validateDocumentHistoryPolicy, type DocumentHistoryPolicy } from './context/document-history.js';
import { inspectEngineStorage, type StorageUsageReport, type StorageUsageLimits } from './diagnostics/storage-usage.js';
import { validateChildDocumentStorageRequest, inspectChildDocumentStorage, type ChildDocumentStorageRequest, type ChildDocumentStorageReport } from './diagnostics/child-document-storage.js';
import { createChildDocumentReadFrame } from './storage/child-document-reader.js';
import { RepositoryContextService, type RepositoryQuery, type RepositorySnapshot } from './repository/index.js';
import { createRepositoryContextTool } from './repository/tool.js';
import { VerificationCheckRegistry, VerificationPlanService, VerificationReceiptService, type VerificationCheckRegistration } from './verification/index.js';
import { VerificationHostService, type VerificationSessionPolicy } from './verification/host.js';
import { createVerificationTool } from './verification/tool.js';
import { RepositoryContextSource, repositoryContextPolicy, type RepositoryContextPolicy } from './context/repository-contributions.js';

export interface EngineStorageUsageOptions { signal?: AbortSignal; limits?: Partial<StorageUsageLimits> }
export type EngineStorageUsageReport = StorageUsageReport;
export type EngineChildDocumentStorageOptions = ChildDocumentStorageRequest;
export type EngineChildDocumentStorageReport = ChildDocumentStorageReport;

export type RestoreCommandResult = RestoreResult & {
  operationId: string;
  duplicate: boolean;
  recordMetadataError?: { code: string; message: string };
};

export interface ReviewHistoryResult {
  runId: string;
  operations: RestoreOperation[];
}

function metadataFailure(): { code: string; message: string } {
  return { code: 'REVIEW_RECORD_FAILED', message: 'Restoration outcome could not be recorded; reconcile the quarantined workspace before further effects' };
}

const NATIVE_COMMANDS_ENABLED = ['input.accept', 'input.list', 'input.cancel', 'session.pause', 'session.resume', 'session.events', 'engine.getCapabilities', 'run.getTurns', 'turn.getParts', 'artifact.get', 'session.getTasks', 'session.setTasks', 'question.list', 'question.answer', 'question.reject', 'session.getContext', 'session.searchHistory', 'session.getDiagnostics'] as const;

export interface EngineOptions {
  /** Original producer observations; bounded physical reads are disabled by default. */
  diagnosticObservations?: boolean;
  diagnosticSourceLimits?: Partial<WorkspaceExecutionSourceLimits>;
  dbPath: string;
  artifactDir?: string;
  providers?: ProviderAdapter[];
  tools?: ToolDefinition[];
  defaults?: RunConfigInput;
  toolPolicy?: readonly ToolPolicyRule[];
  /** Explicit Run-local schema discovery; default provider exposure remains eager. */
  toolDiscoveryPolicy?: ToolDiscoveryPolicy;
  /** Explicit read-only repository navigation; the default core catalogue is unchanged. */
  repositoryContextTools?: boolean;
  repositoryContextPolicy?: RepositoryContextPolicy;
  /** Host-registered checks only; command/profile approval remains mandatory. */
  verificationTools?: boolean;
  /** Explicit tools-free host extraction into pending workspace knowledge candidates. */
  knowledgeGeneration?: boolean;
  /** Explicit host-approved publication to native workspace document revisions. */
  knowledgePublication?: boolean;
  /** Explicit exact-approved physical workspace-file and skill publication. */
  knowledgeFilePublication?: boolean;
  /** Explicit host recovery and per-document activation after an archive import. */
  knowledgeImportRecovery?: boolean;
  /** Host-selected current approved documents, consumed as bounded read-only data. */
  knowledgeContextPolicy?: KnowledgeContextPolicy;
  /** Host-authored pending proposals, saved separately from physical application. */
  proposals?: boolean;
  /** Separate exact-approved idle host file application. */
  proposalApply?: boolean;
  /** Explicit host team membership, native mailbox/board and current child input delivery. */
  teams?: boolean;
  /** Fixed tool catalogue; host must separately bind an actual selected team member. */
  teamModelTools?: boolean;
  /** Explicit host workflow orchestration through isolated actual child executions. */
  workflows?: boolean;
  /** Explicit root lifetime and durable queue-only scheduled input admission. */
  schedules?: boolean;
  /** Root-owned ACP v1 stdio providers; imported definitions do not restore runtime authority. */
  agentBackends?: boolean;
  /** Explicit audience-bound runtime secrets; bodies never enter native backend journals. */
  agentBackendSecrets?: AgentBackendSecretResolver;
  /** Exact host-selected pending proposals projected as read-only model data. */
  proposalContextPolicy?: ProposalContextPolicy;
  /** Explicit trusted host callbacks; no workspace hook discovery or shell execution. */
  lifecycleHooks?: readonly LifecycleHookRegistration[];
  /** Shared host policy registry for owned child engines. Captures remain Run-bound. */
  lifecycleHookRegistry?: LifecycleHookRegistry;
  /** Whole bounded host data reserved before optional history and source context. */
  lifecycleContextSlotBytes?: number;
  /** At most one extra turn, bound to actual current passed native verification. */
  lifecycleContinuation?: boolean;
  /** Optional host policy narrowing for persisted agent profiles and exact resources. */
  roleResourcePolicy?: RoleResourcePolicy;
  roleResourcePolicyRegistry?: RoleResourcePolicyRegistry;
  resolveRoleResources?: ScopedToolRuntimeOptions['resolveRoleResources'];
  commandPreflight?: RuntimeCommandPreflightOptions;
  /** Trusted host policy shared by an owned child; grants remain local to each engine. */
  toolPolicyInstance?: ToolPolicy;
  modelSpecs?: readonly ModelSpec[];
  outputTokenReserve?: number;
  /** Explicit host policy; original transcript and image references remain durable. */
  mediaHistoryPolicy?: MediaHistoryPolicy;
  /** Bounded derived observations from completed exchanges of a still-active Run. */
  activePrefixPolicy?: ActivePrefixPolicy;
  /** PDF page/text token cost is opaque. The default refuses this unknown cost. */
  allowUnknownDocumentTokenCost?: boolean;
  documentHistoryPolicy?: DocumentHistoryPolicy;
  agentProfiles?: readonly AgentProfileSpec[];
  allowedToolNames?: readonly string[];
  ptyBackend?: PtyBackend;
  worktreeDirectory?: string;
  /** Root task namespace for a host-owned nested engine. No additional tools or grants. */
  childTaskScope?: { tasks: ChildTaskManager; worktrees: WorktreeManager; sessionId: string };
  configureChild?: (engine: MoodcodeEngine, task: Readonly<ChildTaskRecord>) => void;
}
function json(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}

function verifyExecutionIdle(lockPath: string): void {
  try {
    assertExecutionLockAvailable(lockPath);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'COMMAND_EFFECTS_BUSY') {
      throw new EngineError('CLEANUP_PENDING', 'A command supervisor is still cleaning up a previous engine execution; reopen after cleanup');
    }
    throw error;
  }
}

function assertDocumentSupport(provider: ProviderAdapter | undefined, models: ModelRegistry, config: Pick<RunConfig, 'providerId' | 'modelId'>, allowUnknownTokenCost: boolean): void {
  if (!provider?.inputFileTypes?.includes('application/pdf') || !models.get(config.providerId, config.modelId).inputFileTypes?.includes('application/pdf')
    || provider.supportsInputFile?.(config.modelId, 'application/pdf') === false) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider and model require explicit PDF support');
  if (!allowUnknownTokenCost || provider.allowUnknownDocumentTokenCost !== true) throw new EngineError('DOCUMENT_TOKEN_COST_UNKNOWN', 'PDF token cost is unknown; host and provider must explicitly permit this cost');
}

function withInputMedia(provider: ProviderAdapter, images: ImageAttachmentStore, documents: DocumentAttachmentStore, store: SqliteStore, models: ModelRegistry, allowUnknownTokenCost: boolean): ProviderAdapter {
  return { id: provider.id, ...(provider.replayProtocol ? { replayProtocol: provider.replayProtocol } : {}),
    ...(provider.retryableHttpStatuses ? { retryableHttpStatuses: provider.retryableHttpStatuses } : {}),
    ...(provider.inputModalities ? { inputModalities: provider.inputModalities } : {}),
    ...(provider.inputFileTypes ? { inputFileTypes: provider.inputFileTypes } : {}),
    ...(provider.allowUnknownDocumentTokenCost === undefined ? {} : { allowUnknownDocumentTokenCost: provider.allowUnknownDocumentTokenCost }),
    ...(provider.supportsInputFile ? { supportsInputFile: (modelId: string, mimeType: 'application/pdf') => provider.supportsInputFile!(modelId, mimeType) } : {}),
    ...(provider.streamGeneration ? { streamGeneration(request: import('./provider/generation.js').HostGenerationRequest, signal: AbortSignal) {
      return provider.streamGeneration!(validateHostGenerationRequest(request), signal);
    } } : {}),
    streamTurn(request, signal) {
      let iterator: AsyncIterator<ProviderEvent> | undefined, initialization: Promise<void> | undefined;
      let providerEntered = false, confirmedDone = false;
      const initialize = () => initialization ??= (async () => {
        if (request.resolvedImages !== undefined || request.resolvedDocuments !== undefined) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Input bytes must be resolved by the engine');
        const refs = new Map<string, InputImageAttachment>();
        const documentRefs = new Map<string, InputDocumentAttachment>();
        for (const message of request.messages) for (const ref of message.attachments ?? []) {
          if (message.role !== 'user') throw new EngineError('PROVIDER_INVALID_REQUEST', 'Image references belong to user messages');
          const previous = refs.get(ref.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(ref)) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Conflicting image references');
          refs.set(ref.id, ref);
        }
        for (const message of request.messages) for (const ref of message.documents ?? []) {
          if (message.role !== 'user') throw new EngineError('PROVIDER_INVALID_REQUEST', 'Document references belong to user messages');
          const previous = documentRefs.get(ref.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(ref)) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Conflicting document references');
          documentRefs.set(ref.id, ref);
        }
        let resolved = request;
        if (refs.size || documentRefs.size) {
          const run = store.getRun(request.runId);
          if (request.sessionId !== run.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Input request belongs to another session');
          if (documentRefs.size) assertDocumentSupport(provider, models, { providerId: provider.id, modelId: request.modelId }, allowUnknownTokenCost);
          if (refs.size) {
            const modalities = models.get(provider.id, request.modelId).modalities;
            if (!provider.inputModalities?.includes('image') || modalities !== null && !modalities.includes('image')) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider or model does not support image input');
            resolved = { ...resolved, resolvedImages: await images.resolve(run.sessionId, [...refs.values()], signal) };
          }
          if (documentRefs.size) resolved = { ...resolved, resolvedDocuments: await documents.resolve(run.sessionId, [...documentRefs.values()], signal) };
          providerImages(resolved, true, signal);
          if (documentRefs.size) providerDocuments(resolved, true, signal);
        }
        if (signal.aborted) throw signal.reason ?? new EngineError('CANCELLED', 'Provider request was cancelled');
        providerEntered = true;
        iterator = provider.streamTurn(resolved, signal)[Symbol.asyncIterator]();
      })();
      // Forward the real cleanup result. An async-generator wrapper can become
      // closed after inner next() throws and falsely report return().done=true.
      const stream: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() { return stream; },
        async next() { await initialize(); const result = await iterator!.next(); if (result.done === true) confirmedDone = true; return result; },
        async return() {
          if (initialization) await initialization.catch(() => {});
          if (!providerEntered || confirmedDone) return { done: true, value: undefined };
          if (!iterator?.return) throw new EngineError('CLEANUP_UNCERTAIN', 'Underlying provider has no cleanup operation');
          const result = await iterator.return(); if (result.done === true) confirmedDone = true; return result;
        },
      };
      return stream;
    },
  };
}

export class MoodcodeEngine {
  readonly store: SqliteStore;
  readonly coordinator: RunCoordinator;
  readonly scheduler: InputScheduler;
  readonly toolRuntime: ScopedToolRuntime;
  readonly approvals: ApprovalManager;
  readonly questions: QuestionManager;
  readonly tasks: SessionTaskService;
  readonly context: ContextService;
  private readonly images: ImageAttachmentStore;
  private readonly documents: DocumentAttachmentStore;
  private readonly pendingImages = new Set<Promise<unknown>>();
  private readonly pendingStorage = new Set<Promise<unknown>>();
  private readonly storagePaths: { artifactDir: string; dbPath?: string };
  private readonly childStorageIdentity: ChildStorageHostIdentity;
  private readonly verifyChildStorageIdentity: () => void;
  private readonly executionObserver: EngineExecutionObserver;
  private readonly validateImageInput: (sessionId: string, config: RunConfig, refs: InputImageAttachment[]) => Promise<void>;
  private readonly validateDocumentInput: (sessionId: string, config: RunConfig, refs: InputDocumentAttachment[]) => Promise<void>;
  private readonly managedArtifacts: () => Promise<ArtifactStore>;
  readonly plugins: EnginePluginManager;
  readonly profiles: AgentProfiles;
  readonly terminals: TerminalService;
  readonly children: EngineChildren;
  readonly lsp: LspManager;
  readonly repository: RepositoryContextService;
  readonly lifecycleHooks: LifecycleHookRegistry;
  readonly roleResourcePolicyRegistry?: RoleResourcePolicyRegistry;
  readonly verificationChecks: VerificationCheckRegistry;
  readonly verificationPlans: VerificationPlanService;
  readonly verificationReceipts: VerificationReceiptService;
  readonly verificationController: VerificationController;
  readonly workspaceKnowledge: KnowledgeStorage;
  readonly workspaceTrust: WorkspaceTrustService;
  private readonly knowledgeHost: KnowledgeHostAdapter;
  private readonly knowledgeGenerationEnabled: boolean;
  private readonly hostGenerationProviders: ReadonlyMap<string, ProviderAdapter>;
  private readonly knowledgeGenerations: KnowledgeGenerationStorage;
  private readonly knowledgeGenerationService: KnowledgeGenerationService;
  private readonly knowledgePublicationEnabled: boolean;
  private readonly knowledgePublications: KnowledgePublicationStorage;
  private readonly knowledgePublicationService: KnowledgePublicationService;
  private readonly knowledgeFilePublicationEnabled: boolean;
  private readonly knowledgeFilePublications: KnowledgeFilePublicationStorage;
  private readonly knowledgeFileHost: FileKnowledgePublicationHost;
  private readonly knowledgeFilePublicationService: KnowledgeFilePublicationService;
  private readonly knowledgeFileExecutionGuards: KnowledgeFileExecutionGuards;
  private readonly knowledgeFileRecoveryPreviews = new WeakMap<KnowledgeFileRecoveryPreview, string>();
  private readonly knowledgeImportRecoveryEnabled: boolean;
  private readonly knowledgeImports: KnowledgeImportRecoveryStorage;
  private readonly knowledgeImportService: KnowledgeImportRecoveryService;
  private readonly proposalsEnabled: boolean;
  private readonly proposalRecords: ProposalStorage;
  private readonly proposalSource: ProposalSourceCaptureHost;
  private readonly proposalService: ProposalHostService;
  private readonly proposalOverlay: ProposalOverlayContextSource;
  private readonly proposalApplyEnabled: boolean;
  private readonly proposalApplies: ProposalApplyStorage;
  private readonly proposalApplyService: ProposalApplyService;
  private readonly proposalApplyGuards: ProposalApplyExecutionGuards;
  private readonly proposalApplyCleanups = new WeakMap<object, { capture: ProposalApplyCapture; proof: ProposalApplyCleanup }>();
  private readonly proposalApplyRecoveryPreviews = new WeakMap<object, string>();
  private readonly teamsEnabled: boolean;
  private readonly teamRecords: TeamStorage;
  private readonly teamHost: TeamHostService;
  private readonly teamService: TeamService;
  private readonly teamModelToolsEnabled: boolean;
  private readonly teamModelHost: EngineTeamModelToolHost;
  private readonly teamModelDefinitions: readonly ToolDefinition[];
  private readonly workflowsEnabled: boolean;
  private readonly workflowRecords: WorkflowStorage;
  private readonly workflowHost: WorkflowHost;
  private readonly workflowService: WorkflowService;
  private readonly schedulesEnabled: boolean;
  private readonly scheduleRecords: ScheduleStorage;
  private readonly scheduleProducer: EngineScheduleProducer;
  private readonly scheduleDispatcher: ScheduleDispatcher;
  private readonly agentBackendsEnabled: boolean;
  private readonly backendProducer: EngineAgentBackendProducer;
  private readonly backendRecords: AgentBackendStorage;
  private readonly backendProcesses: OwnedBackendProcesses;
  private readonly backendHost: AgentBackendHost;
  private readonly runtimeProviders: Map<string, ProviderAdapter>;
  private readonly backendProviderIds = new Set<string>();
  private readonly knowledgeRecoveryPreviews = new WeakMap<KnowledgeGenerationRecoveryPreview, string>();
  private readonly verificationHost: VerificationHostService;
  private readonly verificationEnabled: boolean;
  readonly formatters: FormatterRegistry;
  readonly changes: WorkspaceChangeHub;
  private readonly watchConsumers = new Map<string, Promise<void>>();
  private readonly languageServers = new Map<string, (path: string) => string | null>();
  private readonly languageServerRevisions = new Map<string, string>();
  private readonly pendingRepository = new Set<Promise<RepositorySnapshot>>();
  private readonly lspChanges = new Map<string, { version: number; done: Promise<void> }>();
  private readonly observationFailures = new Map<string, string>();
  private readonly terminalJournal: SqliteTerminalJournal;
  private readonly hostResources = new AbortController();
  private readonly mcp = new Map<string, McpRegistration>();
  private readonly pendingMcp = new Map<string, Promise<McpRegistration>>();
  private readonly mcpClients = new Map<string, McpClient>();
  readonly reviewJournal: ReviewJournal;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly defaults: RunConfig;
  private readonly hostAllowedTools?: readonly string[];
  private readonly capabilities: EngineCapabilities;
  private readonly executionLockPath: string;
  private readonly restoreRequests = new Map<string, { binding: RestoreOperationInput; promise: Promise<RestoreCommandResult> }>();

  constructor(options: EngineOptions) {
    if (!options || typeof options.dbPath !== 'string' || options.dbPath.length === 0) {
      throw new EngineError('INVALID_CONFIG', 'dbPath must be a non-empty string');
    }
    const repositoryPolicy = options.repositoryContextPolicy !== undefined ? repositoryContextPolicy(options.repositoryContextPolicy) : undefined;
    const knowledgePolicy = options.knowledgeContextPolicy === undefined ? undefined : knowledgeContextPolicy(options.knowledgeContextPolicy);
    const proposalPolicy = options.proposalContextPolicy === undefined ? undefined : proposalContextPolicy(options.proposalContextPolicy);
    if (options.lifecycleHookRegistry !== undefined && !(options.lifecycleHookRegistry instanceof LifecycleHookRegistry)) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Shared hook registry requires an explicit trusted host registry');
    if (options.lifecycleHookRegistry && options.lifecycleHooks !== undefined) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Specify one host registry or initial hook registrations');
    this.lifecycleHooks = options.lifecycleHookRegistry ?? new LifecycleHookRegistry();
    if (options.lifecycleContextSlotBytes !== undefined && (!Number.isSafeInteger(options.lifecycleContextSlotBytes) || options.lifecycleContextSlotBytes < 128 || options.lifecycleContextSlotBytes > 16_384))
      throw new EngineError('INVALID_LIFECYCLE_CONTEXT', 'Lifecycle context slot must be between 128 and 16384 bytes');
    if (options.lifecycleContinuation !== undefined && typeof options.lifecycleContinuation !== 'boolean') throw new EngineError('INVALID_CONFIG', 'Lifecycle continuation requires an explicit host boolean');
    if (options.roleResourcePolicyRegistry !== undefined && !(options.roleResourcePolicyRegistry instanceof RoleResourcePolicyRegistry)) throw new EngineError('INVALID_ROLE_POLICY_CONFIGURATION', 'Shared role policy requires a trusted host registry');
    if (options.roleResourcePolicyRegistry && options.roleResourcePolicy) throw new EngineError('INVALID_ROLE_POLICY_CONFIGURATION', 'Specify one role policy registry or immutable role policy');
    this.roleResourcePolicyRegistry = options.roleResourcePolicyRegistry;
    if (options.verificationTools !== undefined && typeof options.verificationTools !== 'boolean') throw new EngineError('INVALID_CONFIG', 'Verification tool exposure must be an explicit boolean');
    this.verificationEnabled = options.verificationTools === true;
    if (options.knowledgeGeneration !== undefined && typeof options.knowledgeGeneration !== 'boolean') throw new EngineError('INVALID_CONFIG', 'Knowledge generation requires an explicit host boolean');
    this.knowledgeGenerationEnabled = options.knowledgeGeneration === true;
    if (options.knowledgePublication !== undefined && typeof options.knowledgePublication !== 'boolean') throw new EngineError('INVALID_CONFIG', 'Knowledge publication requires an explicit host boolean');
    this.knowledgePublicationEnabled = options.knowledgePublication === true;
    if (options.knowledgeFilePublication !== undefined && typeof options.knowledgeFilePublication !== 'boolean') throw new EngineError('INVALID_CONFIG', 'Knowledge file publication requires an explicit host boolean');
    this.knowledgeFilePublicationEnabled = options.knowledgeFilePublication === true;
    if (options.knowledgeImportRecovery !== undefined && typeof options.knowledgeImportRecovery !== 'boolean') throw new EngineError('INVALID_CONFIG', 'knowledgeImportRecovery must be an explicit boolean');
    this.knowledgeImportRecoveryEnabled = options.knowledgeImportRecovery === true;
    if (options.proposals !== undefined && typeof options.proposals !== 'boolean') throw new EngineError('INVALID_CONFIG', 'proposals must be an explicit boolean');
    if (options.teams !== undefined && typeof options.teams !== 'boolean') throw new EngineError('INVALID_CONFIG', 'teams must be an explicit boolean');
    this.teamsEnabled = options.teams === true;
    if (options.teamModelTools !== undefined && typeof options.teamModelTools !== 'boolean') throw new EngineError('INVALID_CONFIG', 'teamModelTools must be an explicit boolean');
    this.teamModelToolsEnabled = options.teamModelTools === true;
    if (options.workflows !== undefined && typeof options.workflows !== 'boolean') throw new EngineError('INVALID_CONFIG', 'workflows must be an explicit boolean');
    this.workflowsEnabled = options.workflows === true;
    if (options.schedules !== undefined && typeof options.schedules !== 'boolean') throw new EngineError('INVALID_CONFIG', 'schedules must be an explicit boolean');
    this.schedulesEnabled = options.schedules === true;
    if (options.agentBackends !== undefined && typeof options.agentBackends !== 'boolean') throw new EngineError('INVALID_CONFIG', 'agentBackends requires an explicit root host boolean');
    if (options.agentBackendSecrets !== undefined && (!options.agentBackendSecrets || typeof options.agentBackendSecrets.resolve !== 'function')) throw new EngineError('INVALID_CONFIG', 'Backend secrets require an explicit trusted host resolver');
    this.agentBackendsEnabled = options.agentBackends === true;
    if (this.teamModelToolsEnabled && !this.teamsEnabled) throw new EngineError('INVALID_CONFIG', 'Model team tools require explicit host teams');
    this.proposalsEnabled = options.proposals === true;
    if (options.proposalApply !== undefined && typeof options.proposalApply !== 'boolean') throw new EngineError('INVALID_CONFIG', 'proposalApply must be an explicit boolean');
    this.proposalApplyEnabled = options.proposalApply === true;
    if (options.diagnosticObservations !== undefined && typeof options.diagnosticObservations !== 'boolean') throw new EngineError('INVALID_CONFIG', 'Execution observations require an explicit host boolean');
    if (this.verificationEnabled && options.tools !== undefined) throw new EngineError('INVALID_VERIFICATION_CONFIG', 'Verification requires the engine-owned command producer and core registrations');
    if (options.allowUnknownDocumentTokenCost !== undefined && typeof options.allowUnknownDocumentTokenCost !== 'boolean') throw new EngineError('INVALID_CONFIG', 'Document token cost policy must be a boolean');
    if (options.repositoryContextTools !== undefined && typeof options.repositoryContextTools !== 'boolean') throw new EngineError('INVALID_CONFIG', 'Repository tool exposure must be an explicit boolean');
    if (options.lifecycleHooks !== undefined) {
      if (!Array.isArray(options.lifecycleHooks) || options.lifecycleHooks.length > this.lifecycleHooks.limits.maxHooks) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Initial lifecycle hooks must be a bounded explicit host list');
      for (const hook of options.lifecycleHooks) this.lifecycleHooks.register(hook);
    }
    this.defaults = normalizeSubmitInput({ sessionId: 'defaults', requestId: 'defaults', prompt: 'defaults', config: options.defaults ?? {} }).config;
    const mediaHistoryPolicy = options.mediaHistoryPolicy === undefined ? undefined : validateMediaHistoryPolicy(options.mediaHistoryPolicy);
    const activePrefixPolicy = options.activePrefixPolicy === undefined ? undefined : validateActivePrefixPolicy(options.activePrefixPolicy);
    const documentHistoryPolicy = options.documentHistoryPolicy === undefined ? undefined : validateDocumentHistoryPolicy(options.documentHistoryPolicy);
    const toolDiscoveryPolicy = options.toolDiscoveryPolicy === undefined ? undefined : validateToolDiscoveryPolicy(options.toolDiscoveryPolicy);
    const dbPath = options.dbPath === ':memory:' ? options.dbPath : resolve(options.dbPath);
    const artifactDir = options.artifactDir !== undefined ? resolve(options.artifactDir)
      : dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'moodcode-memory-artifacts-')) : resolve(`${options.dbPath}.artifacts`);
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    this.store = new SqliteStore(dbPath, this.defaults.budgets);
    let reviewJournal: ReviewJournal | undefined;
    let terminalJournal: SqliteTerminalJournal | undefined;
    try {
      const canonicalDbPath = dbPath === ':memory:' ? undefined : realpathSync(dbPath);
      this.storagePaths = { artifactDir: realpathSync(artifactDir), ...(canonicalDbPath ? { dbPath: canonicalDbPath } : {}) };
      const physicalIdentity = (path: string) => {
        const stat = statSync(path, { bigint: true });
        return { path: realpathSync(path), dev: stat.dev.toString(), ino: stat.ino.toString() };
      };
      const storageBinding = {
        database: canonicalDbPath ? physicalIdentity(canonicalDbPath) : { memory: randomUUID() },
        artifacts: physicalIdentity(this.storagePaths.artifactDir),
      };
      this.childStorageIdentity = storageBinding;
      this.verifyChildStorageIdentity = () => {
        try {
          const database = canonicalDbPath ? physicalIdentity(canonicalDbPath) : storageBinding.database;
          const artifacts = physicalIdentity(this.storagePaths.artifactDir);
          if (JSON.stringify({ database, artifacts }) !== JSON.stringify(storageBinding)) throw new Error('changed');
        } catch { throw new EngineError('CHILD_STORAGE_HOST_CHANGED', 'Child storage inspection requires the unchanged host storage identity'); }
      };
      const knowledgeBinding = (workspaceId: string) => {
        this.verifyChildStorageIdentity();
        for (const storagePath of [this.storagePaths.dbPath, this.storagePaths.artifactDir]) if (storagePath && (lstatSync(storagePath).isSymbolicLink() || realpathSync(storagePath) !== storagePath)) throw new EngineError('KNOWLEDGE_BINDING_MISMATCH', 'Workspace knowledge requires the unchanged physical database and artifact owner');
        const workspace = this.store.getWorkspace(workspaceId), root = lstatSync(workspace.root, { bigint: true });
        if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(workspace.root) !== workspace.root) throw new EngineError('KNOWLEDGE_BINDING_MISMATCH', 'Workspace knowledge requires its canonical physical root');
        return { workspaceId, root: workspace.root, rootDevice: root.dev.toString(), rootInode: root.ino.toString(), storageBindingSha256: knowledgeHash(storageBinding) };
      };
      this.knowledgeFilePublications = this.store.createKnowledgeFilePublicationStorage({ checkBinding: knowledgeBinding,
        getCandidate: (workspaceId, candidateId) => this.workspaceKnowledge.getCandidate(workspaceId, candidateId),
        assertCommitCurrent: (record, phase) => this.knowledgeFilePublicationService.assertCommitCurrent(record, phase),
        beforeRecoveryDecision: (workspaceId, operation) => {
          if (operation === 'acknowledge') this.knowledgeFileExecutionGuards.reconcile(workspaceId, this.executionLockPath);
          verifyExecutionIdle(this.executionLockPath);
          if (operation === 'resume' && (this.store.hasUncertainSummaries(workspaceId) || this.store.hasUncertainExecution(workspaceId) || this.store.hasUncertainKnowledgeGeneration(workspaceId))) throw new EngineError('CLEANUP_PENDING', 'Other workspace producers still require independent recovery');
        } });
      this.knowledgeFileExecutionGuards = this.store.createKnowledgeFileExecutionGuards({ checkBinding: knowledgeBinding,
        getOwner: (workspaceId, id) => { const owner = this.knowledgeFilePublications.getOwner(workspaceId, id); if (!owner) throw new EngineError('KNOWLEDGE_FILE_NOT_FOUND', 'Physical publication owner does not exist in this workspace'); return owner; } });
      this.knowledgeFileHost = new FileKnowledgePublicationHost({ checkBinding: knowledgeBinding,
        readTargetRevision: (binding, path) => this.knowledgeFilePublications.getCurrentTarget(binding.workspaceId, path)?.revision ?? 0,
        acquireExecutionGuard: (binding, publicationId) => {
          const reservation = reserveExecutionLock(this.executionLockPath);
          this.knowledgeFileExecutionGuards.reserve(binding, publicationId, this.executionLockPath, readExecutionLockReservation(reservation));
          return acquireExecutionLock(this.executionLockPath, reservation);
        } });
      this.knowledgeHost = this.store.createKnowledgeHostAdapter({ checkHostBinding: knowledgeBinding,
        ...(this.knowledgeFilePublicationEnabled ? { readFileTargetRevision: (binding: ReturnType<typeof knowledgeBinding>, path: string) =>
          this.knowledgeFilePublications.captureTarget(binding, this.knowledgeFileHost.observeTargetSync(binding, path)).revision } : {}),
        readWorkspaceDocumentTarget: (binding, key) => this.knowledgePublications.captureDocumentTarget(binding.workspaceId, key) });
      this.workspaceKnowledge = this.store.createKnowledgeStorage({ checkHostBinding: knowledgeBinding, assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
        assertSourcesCurrent: (binding, source) => this.knowledgeHost.assertSourcesCurrent(binding, source), assertTargetCurrent: (binding, target) => this.knowledgeHost.assertTargetCurrent(binding, target),
        readGenerationEvidence: (plan, ownerId) => this.knowledgeGenerations.readEvidence(plan, ownerId) });
      this.knowledgeGenerations = this.store.createKnowledgeGenerationStorage({ checkBinding: knowledgeBinding,
        getPlan: (workspaceId, planId) => this.workspaceKnowledge.getGenerationPlan(workspaceId, planId),
        assertPlanCurrent: plan => this.workspaceKnowledge.assertGenerationPlanCurrent(plan) });
      this.knowledgePublications = this.store.createKnowledgePublicationStorage({ checkBinding: knowledgeBinding,
        getCandidate: (workspaceId, candidateId) => this.workspaceKnowledge.getCandidate(workspaceId, candidateId),
        assertCommitCurrent: record => this.knowledgePublicationService.assertCommitCurrent(record) });
      this.knowledgeImports = this.store.createKnowledgeImportRecoveryStorage({ checkBinding: knowledgeBinding,
        assertCommitCurrent: preview => this.knowledgeImportService.assertCommitCurrent(preview) });
      this.proposalSource = new ProposalSourceCaptureHost({ checkBinding: knowledgeBinding });
      this.proposalRecords = this.store.createProposalStorage({ checkBinding: knowledgeBinding,
        readSourceCapture: original => this.proposalSource.read(original),
        assertSourcesCurrent: (native, original) => this.proposalService.assertCommitCurrent(native, original) });
      this.proposalService = new ProposalHostService(this.proposalRecords, this.proposalSource,
        operation => this.store.readExecutionObservationEvidence(operation), this.hostResources.signal);
      this.proposalApplies = this.store.createProposalApplyStorage({ checkBinding: knowledgeBinding,
        getRevision: (workspaceId, id) => this.proposalRecords.getRevision(workspaceId, id),
        getHead: (workspaceId, id) => this.proposalRecords.getSet(workspaceId, id),
        readApprovedCapture: (original, input) => this.proposalApplyService.readApprovedCapture(original, input),
        assertCurrent: (original, capture, phase) => this.proposalApplyService.assertCurrent(original, capture, phase),
        readPhysicalResult: (capture, original) => this.proposalApplyService.assertPhysicalResult(capture, original),
        readExecutionGuard: (capture, original) => { const guard = this.proposalApplyGuards.readOriginal(original);
          if (guard.ownerId !== capture.ownerId || guard.workspaceId !== capture.workspaceId) throw new EngineError('PROPOSAL_APPLY_GUARD_INVALID', 'Execution guard belongs to another original apply owner'); return guard; },
        getExecutionGuard: (workspaceId, ownerId) => this.proposalApplyGuards.get(workspaceId, ownerId),
        assertCleanup: (capture, original) => { const cleanup = this.proposalApplyCleanups.get(original);
          if (!cleanup || cleanup.capture !== capture) throw new EngineError('PROPOSAL_APPLY_CLEANUP_INVALID', 'Cleanup requires its original apply owner and actual lock release'); return cleanup.proof; },
        beforeRecoveryDecision: (workspaceId, operation) => {
          if (operation === 'acknowledge') this.proposalApplyGuards.reconcile(workspaceId, this.executionLockPath);
          verifyExecutionIdle(this.executionLockPath);
          if (operation === 'resume' && (this.store.hasUncertainExecution(workspaceId) || this.store.hasUncertainSummaries(workspaceId)
            || this.store.hasUncertainKnowledgeGeneration(workspaceId) || this.store.hasUncertainKnowledgeFilePublication(workspaceId))) throw new EngineError('CLEANUP_PENDING', 'Other native producers require their own recovery before proposal resume');
        } });
      this.proposalApplyGuards = this.store.createProposalApplyExecutionGuards({ checkBinding: knowledgeBinding,
        getOwner: (workspaceId, id) => { const owner = this.proposalApplies.getOwner(workspaceId, id);
          if (!owner) throw new EngineError('PROPOSAL_APPLY_NOT_FOUND', 'Native proposal apply owner is absent'); return owner; } });
      this.proposalApplyService = new ProposalApplyService(this.proposalApplies, {
        readTx: operation => this.store.readExecutionObservationEvidence(operation), checkBinding: knowledgeBinding,
        getSelection: (workspaceId, id) => this.proposalRecords.getSelection(workspaceId, id),
        getRevision: (workspaceId, id) => this.proposalRecords.getRevision(workspaceId, id),
        readBlobText: reference => this.store.readProposalBlobText(reference),
        assertUnpaused: workspaceId => this.workspaceKnowledge.assertUnpaused(workspaceId),
        assertIdleAndNoExecutionUncertainty: workspaceId => { this.coordinator.assertWorkspaceCleanupConfirmed(workspaceId); verifyExecutionIdle(this.executionLockPath); },
        assertSourcesCurrent: (binding, manifest, signal) => this.proposalSource.assertStoredManifestCurrentSync(binding, manifest, signal),
        withWorkspaceLease: (workspaceId, signal, operation) => this.coordinator.withHostProposalApplyLease(workspaceId,
          lease => operation(AbortSignal.any([signal, lease, this.hostResources.signal]))),
        physical: new PhysicalPatchProducer(),
        acquireExecutionGuard: async capture => {
          const owner = this.proposalApplies.getOwner(capture.workspaceId, capture.ownerId);
          if (!owner) throw new EngineError('PROPOSAL_APPLY_NOT_FOUND', 'Native proposal apply owner is absent');
          const reservation = reserveExecutionLock(this.executionLockPath);
          const originalGuard = this.proposalApplyGuards.reserve(owner.binding, owner.id, this.executionLockPath, readExecutionLockReservation(reservation));
          this.proposalApplies.claim(capture, originalGuard);
          let lock;
          try { lock = acquireExecutionLock(this.executionLockPath, reservation); }
          catch (error) { this.proposalApplies.uncertain(capture, error instanceof EngineError ? error.code : 'PROPOSAL_APPLY_LOCK_FAILED'); throw error; }
          let released = false;
          return { guard: originalGuard, release: cleanupConfirmed => {
            if (released) throw new EngineError('PROPOSAL_APPLY_CLEANUP_INVALID', 'Original execution lease was already released'); released = true;
            let confirmed = false;
            if (cleanupConfirmed) confirmed = this.proposalApplyService.readCurrentPhysicalOutcome(capture).cleanupConfirmed;
            lock.release(confirmed);
            if (confirmed) verifyExecutionIdle(this.executionLockPath);
            const guard = this.proposalApplyGuards.readOriginal(originalGuard), original = Object.freeze({ id: owner.id });
            this.proposalApplyCleanups.set(original, { capture, proof: { confirmed, guardSha256: guard.sha256 } }); return original;
          } };
        },
      }, this.hostResources.signal);
      this.workspaceTrust = new WorkspaceTrustService(this.workspaceKnowledge);
      const recoveryBinding = (workspaceId: string) => {
        const database = canonicalDbPath ? physicalIdentity(canonicalDbPath) : storageBinding.database;
        const artifacts = physicalIdentity(this.storagePaths.artifactDir);
        if (JSON.stringify({ database, artifacts }) !== JSON.stringify(storageBinding)) throw new EngineError('SUMMARY_RECOVERY_STORAGE_CHANGED', 'Summary recovery storage identity changed during this engine lifetime');
        const workspace = this.store.getWorkspace(workspaceId);
        return createHash('sha256').update(JSON.stringify({ ...storageBinding, workspace: { id: workspace.id, root: workspace.root, gitRoot: workspace.gitRoot } })).digest('hex');
      };
      this.store.configureSummaryRecovery(recoveryBinding);
      this.store.configureProviderRecovery(workspaceId => {
        try { return recoveryBinding(workspaceId); }
        catch { throw new EngineError('PROVIDER_RECOVERY_STORAGE_CHANGED', 'Provider recovery storage identity changed during this engine lifetime'); }
      });
      this.executionLockPath = canonicalDbPath === undefined ? resolve(artifactDir, 'effects.sqlite') : `${canonicalDbPath}.effects.sqlite`;
      const interruptedFileOwners: string[] = [];
      try { verifyExecutionIdle(this.executionLockPath); }
      catch (error) { const known = this.knowledgeFileExecutionGuards.matching(this.executionLockPath);
        if (known) interruptedFileOwners.push(known.publicationId); else if (!this.proposalApplyGuards.matching(this.executionLockPath)) throw error; }
      reviewJournal = new ReviewJournal(canonicalDbPath === undefined ? resolve(artifactDir, 'review.sqlite') : `${canonicalDbPath}.review.sqlite`);
      this.reviewJournal = reviewJournal;
      this.store.recoverInterrupted();
      this.knowledgeGenerations.recoverInterruptedOwners();
      this.knowledgePublications.recoverInterruptedOwners();
      this.knowledgeFilePublications.recoverInterruptedOwners(interruptedFileOwners);
      this.proposalApplies.recoverInterruptedOwners();
      this.approvals = new ApprovalManager(this.store);
      this.questions = new QuestionManager(this.store);
      this.tasks = new SessionTaskService(this.store);
      this.profiles = new AgentProfiles(this.store, options.agentProfiles);
      this.lsp = new LspManager();
      this.repository = new RepositoryContextService(this.lsp, path => {
        const matches = [...this.languageServers].map(([serverId, select]) => ({ serverId, languageId: select(path), revision: this.languageServerRevisions.get(serverId)! })).filter(item => item.languageId !== null);
        if (matches.length > 1) throw new EngineError('REPOSITORY_SERVER_AMBIGUOUS', 'More than one host server supports this path; narrow the host language routing');
        return matches[0] as { serverId: string; languageId: string; revision: string } | undefined ?? null;
      });
      this.verificationChecks = new VerificationCheckRegistry();
      this.verificationPlans = new VerificationPlanService(this.store, this.verificationChecks);
      this.verificationReceipts = new VerificationReceiptService(this.verificationPlans);
      this.verificationHost = new VerificationHostService(this.store, this.verificationPlans, this.repository);
      this.verificationController = new VerificationController(this.store, this.verificationPlans, {
        observeSource: (run, signal) => this.verificationHost.observe({ sessionId: run.sessionId, runId: run.id, workspace: this.store.getWorkspace(run.workspaceId) }, signal),
        readCurrentProfile: run => { const profile = this.profiles.forRun(run.sessionId, run.config); return profile ? { id: profile.id, revision: profile.revision } : null; },
        readRemainingBudget: run => this.coordinator.verificationRemainingBudget(run),
        readExecutionBlocker: run => {
          if (this.store.hasDeniedVerificationTool(run.id)) return 'verification_denied';
          const profile = this.profiles.forRun(run.sessionId, run.config);
          const profileTools = profile?.tools;
          const allowed = this.hostAllowedTools ? (profileTools ? profileTools.filter(name => this.hostAllowedTools!.includes(name)) : this.hostAllowedTools) : profileTools;
          const catalogue = this.toolRuntime.catalogue('engine', run.config.mode, allowed, profile ? { id: profile.id, revision: profile.revision } : undefined);
          if (!catalogue.tools.some(tool => tool.name === 'verify_changes') || !catalogue.tools.some(tool => tool.name === 'run_command')) return 'verification_denied';
          const checks = this.verificationPlans.get(run.sessionId, run.id)?.plans.at(-1)?.checks ?? [];
          if (!checks.length) for (const id of this.verificationHost.configuration(run.sessionId)?.checkIds ?? []) {
            try { this.verificationChecks.capture(id); }
            catch (error) { if (error instanceof EngineError && error.code === 'VERIFICATION_CHECK_NOT_FOUND') return 'check_stale'; throw error; }
          }
          if (checks.some(check => this.toolRuntime.policy.evaluate({ toolName: 'run_command', effect: 'execute', mode: run.config.mode, requiresApproval: true, resources: [`command:${check.command}`, `path:${check.cwd}`] }).decision === 'deny')) return 'verification_denied';
          return null;
        },
        assertBoundaryCurrent: (run, boundary) => this.coordinator.assertVerificationBoundaryCurrent(run, boundary),
        commitCurrent: (runId, kind, revision, data, verificationRevision) => this.store.putActiveVerificationControllerDocument(runId, kind, revision, data, verificationRevision),
      });
      this.formatters = new FormatterRegistry();
      this.changes = new WorkspaceChangeHub({ signal: this.hostResources.signal });
      this.children = new EngineChildren(this, { ...options, ...(repositoryPolicy ? { repositoryContextPolicy: repositoryPolicy } : {}), ...(mediaHistoryPolicy ? { mediaHistoryPolicy } : {}), ...(activePrefixPolicy ? { activePrefixPolicy } : {}), ...(toolDiscoveryPolicy ? { toolDiscoveryPolicy } : {}) }, options.worktreeDirectory ?? join(realpathSync(artifactDir), 'children'), value => {
        bindChildTeamModelCatalogue(value, this.teamModelDefinitions);
        return new MoodcodeEngine(value);
      }, storageBinding);
      const teamOwners = new EngineTeamOwners(this);
      this.teamRecords = this.store.createTeamStorage({ checkBinding: knowledgeBinding,
        readMemberOwner: original => this.teamHost.readMemberOwner(original),
        assertMemberOwnerCurrent: (original, member) => this.teamHost.assertMemberOwnerCurrent(original,member),
        assertRecipientCurrent: member => this.teamHost.assertRecipientCurrent(member),
        readAcceptedInput: (capture, original) => this.teamService.readAcceptedInput(capture,original) });
      this.teamHost = new TeamHostService({ native: this.teamRecords, owner: teamOwners });
      const nativeTeams = this.teamRecords;
      this.teamService = new TeamService({ host: this.teamHost, native: {
        findSendRequest: input => nativeTeams.findSendRequest(input),
        findOperationRequest: (...args) => nativeTeams.findOperationRequest(...args),
        getMember: (...args) => nativeTeams.getMember(...args),
        send: (...args) => nativeTeams.send(...args),
        readMailbox: (...args) => nativeTeams.readMailbox(...args),
        claimMailbox: (...args) => nativeTeams.claimMailbox(...args),
        releasePage: page => nativeTeams.releasePage(page),
        putTask: (...args) => nativeTeams.putTask(...args),
        claimTask: (...args) => nativeTeams.claimTask(...args),
        completeTask: (...args) => nativeTeams.completeTask(...args),
        prepareDelivery: (...args) => nativeTeams.prepareDelivery(...args),
        dispatchDelivery: capture => nativeTeams.dispatchDelivery(capture),
        completeDelivery: (...args) => nativeTeams.completeDelivery(...args),
        cancelDelivery: capture => { nativeTeams.cancelDelivery(capture); },
        releaseDelivery: capture => nativeTeams.releaseDelivery(capture),
        getDeliveryHistory: (workspaceId,id) => this.store.readExecutionObservationEvidence(() => {
          const record = nativeTeams.getDelivery(workspaceId,id);
          return record ? { record, receipt: nativeTeams.getDeliveryReceipt(workspaceId,id) ?? null } : undefined;
        }),
      }, input: {
        capture: (sessionId,taskId) => this.children.teamBridge.capture(sessionId,taskId),
        readTarget: original => this.children.teamBridge.readTarget(original as ChildTeamTarget),
        assertCurrent: original => this.children.teamBridge.assertCurrent(original as ChildTeamTarget),
        accept: (original,input) => this.children.teamBridge.accept(original as ChildTeamTarget,input),
        readAccepted: (original,accepted) => {
          const proof = this.children.teamBridge.readAccepted(original as ChildTeamTarget,accepted as ChildTeamInputEvidence);
          return { sessionId: proof.childSessionId, runId: proof.childRunId, inputId: proof.inputId,
            requestId: proof.requestId, inputSha256: proof.inputSha256, admittedSeq: proof.admittedSeq, delivery: 'steer' };
        },
        release: original => this.children.teamBridge.release(original as ChildTeamTarget),
      } });
      this.teamRecords.recoverInterruptedDeliveries();
      this.teamModelHost = new EngineTeamModelToolHost({ owner: teamOwners, service: this.teamService,
        rootSessionWorkspace: sessionId => this.store.getSession(sessionId).workspaceId,
        getTeam: (workspaceId,teamId) => nativeTeams.activeTeam(workspaceId,teamId),
        getMember: (workspaceId,teamId,memberId) => nativeTeams.getMember(workspaceId,teamId,memberId),
        getTask: (workspaceId,teamId,taskId) => nativeTeams.getTask(workspaceId,teamId,taskId),
        getCursor: (...args) => nativeTeams.cursor(...args),
        assertOwnerUnquarantined: (workspaceId,owner) => nativeTeams.assertOwnerUnquarantined(workspaceId,owner),
        resolveExecution: proof => {
          const actual = proof.kind === 'root' ? this : this.children.resolveTeamModelExecution(proof);
          return { store: actual.store, coordinator: actual.coordinator, executionLockPath: actual.executionLockPath, artifactDir: actual.storagePaths.artifactDir };
        }, assertEnabled: () => {
          this.assertTeamsEnabled();
          if (!this.teamModelToolsEnabled) throw new EngineError('TEAM_MODEL_DISABLED', 'Model team tools require explicit host opt-in');
        },
      });
      this.teamModelDefinitions = this.teamModelToolsEnabled ? createTeamModelTools(this.teamModelHost.port()) : consumeChildTeamModelCatalogue(options);
      const workflowOwners = new EngineWorkflowOwners(this, knowledgeBinding);
      const workflowChildren = this.children.workflowObservationPort(workflowOwners);
      this.workflowRecords = this.store.createWorkflowStorage({
        readOwner: original => workflowOwners.read(original),
        assertOwnerCurrent: (original, expected) => workflowOwners.assertCurrent(original, expected),
        assertOwnerSettling: (original, expected) => workflowOwners.assertSettling(original, expected),
        readWorktree: (original, worktreeId) => workflowOwners.worktree(original, worktreeId),
        assertWorktreeCurrent: (original, expected) => workflowOwners.assertWorktreeCurrent(original, expected),
        readChildAdmission: original => workflowChildren.readAdmission(original),
        readChildCompletion: original => workflowChildren.readCompletion(original),
      });
      this.workflowHost = new WorkflowHost({ owner: workflowOwners, getWorkflow: (...args) => this.workflowRecords.getWorkflow(...args) });
      this.workflowService = new WorkflowService({ native: this.workflowRecords, host: this.workflowHost, owner: workflowOwners, children: workflowChildren });
      this.workflowRecords.recoverInterrupted();
      terminalJournal = new SqliteTerminalJournal(join(realpathSync(artifactDir), 'terminals.sqlite'));
      this.terminalJournal = terminalJournal;
      this.terminals = new TerminalService({ journal: terminalJournal, ...(options.ptyBackend ? { backend: options.ptyBackend } : {}), resolveOwner: owner => {
        const session = this.store.getSession(owner.sessionId);
        if (session.workspaceId !== owner.workspaceId) throw new EngineError('TERMINAL_AUTHORITY', 'Terminal session belongs to a different workspace');
        return { sessionId: session.id, workspaceId: session.workspaceId, root: this.store.getWorkspace(session.workspaceId).root };
      } });
      const models = new ModelRegistry();
      for (const spec of options.modelSpecs ?? []) models.put(spec);
      this.images = new ImageAttachmentStore({ directory: join(realpathSync(artifactDir), 'input-media'), documents: this.store });
      this.documents = new DocumentAttachmentStore({ directory: join(realpathSync(artifactDir), 'input-documents'), documents: this.store });
      let artifacts: Promise<ArtifactStore> | undefined;
      const artifactBudgets = normalizeEngineBudgets(this.defaults.budgets);
      this.managedArtifacts = () => artifacts ??= ArtifactStore.open({ directory: join(realpathSync(artifactDir), 'managed'), limits: {
        maxArtifactBytes: artifactBudgets.maxArtifactBytes, maxProducerBytes: artifactBudgets.maxProducerBytes,
      } });
      const providers = new Map<string, ProviderAdapter>([['scripted', new ScriptedProvider()]]);
      this.runtimeProviders = providers;
      for (const provider of options.providers ?? []) providers.set(provider.id, provider);
      this.validateImageInput = async (sessionId, config, refs) => {
        const modalities = models.get(config.providerId, config.modelId).modalities;
        if (!providers.get(config.providerId)?.inputModalities?.includes('image') || modalities !== null && !modalities.includes('image')) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider or model does not support image input');
        await this.images.resolve(sessionId, refs, this.hostResources.signal);
        if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      };
      this.validateDocumentInput = async (sessionId, config, refs) => {
        assertDocumentSupport(providers.get(config.providerId), models, config, options.allowUnknownDocumentTokenCost === true);
        await this.documents.resolve(sessionId, refs, this.hostResources.signal);
        if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      };
      for (const [id, provider] of providers) providers.set(id, withInputMedia(provider, this.images, this.documents, this.store, models, options.allowUnknownDocumentTokenCost === true));
      this.hostGenerationProviders = providers;
      this.knowledgeGenerationService = new KnowledgeGenerationService({ native: this.knowledgeGenerations, knowledge: this.workspaceKnowledge, host: this.knowledgeHost,
        provider: id => this.knowledgeGenerationProvider(id), assertPlanCurrent: plan => this.workspaceKnowledge.assertGenerationPlanCurrent(plan),
        withLease: (workspaceId, operation) => this.coordinator.withHostGenerationLease(workspaceId, operation) });
      this.knowledgePublicationService = new KnowledgePublicationService({ native: this.knowledgePublications,
        getCandidate: (workspaceId, candidateId) => this.workspaceKnowledge.getCandidate(workspaceId, candidateId),
        getPlan: (workspaceId, planId) => this.workspaceKnowledge.getGenerationPlan(workspaceId, planId),
        getGeneration: (workspaceId, generationId) => this.knowledgeGenerations.getGeneration(workspaceId, generationId),
        getAttempt: (workspaceId, attemptId) => this.knowledgeGenerations.getAttempt(workspaceId, attemptId),
        getTrust: workspaceId => this.workspaceKnowledge.getTrust(workspaceId),
        getTrustRevision: (workspaceId, revisionId) => this.workspaceKnowledge.getTrustRevision(workspaceId, revisionId),
        checkBinding: knowledgeBinding, assertUnpaused: workspaceId => this.workspaceKnowledge.assertUnpaused(workspaceId),
        assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
        assertSourcesCurrent: (binding, source) => this.knowledgeHost.assertSourcesCurrent(binding, source),
        withLease: (workspaceId, operation) => this.coordinator.withWorkspaceLease(workspaceId, operation) });
      this.knowledgeFilePublicationService = new KnowledgeFilePublicationService({ native: this.knowledgeFilePublications, host: this.knowledgeFileHost,
        getCandidate: (workspaceId, id) => this.workspaceKnowledge.getCandidate(workspaceId, id),
        getPlan: (workspaceId, id) => this.workspaceKnowledge.getGenerationPlan(workspaceId, id),
        getGeneration: (workspaceId, id) => this.knowledgeGenerations.getGeneration(workspaceId, id),
        getAttempt: (workspaceId, id) => this.knowledgeGenerations.getAttempt(workspaceId, id),
        getTrust: workspaceId => this.workspaceKnowledge.getTrust(workspaceId),
        getTrustRevision: (workspaceId, id) => this.workspaceKnowledge.getTrustRevision(workspaceId, id),
        checkBinding: knowledgeBinding, assertUnpaused: workspaceId => this.workspaceKnowledge.assertUnpaused(workspaceId),
        assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
        assertSourcesCurrent: (binding, source) => this.knowledgeHost.assertSourcesCurrent(binding, source),
        signal: this.hostResources.signal, withLease: (workspaceId, operation) => this.coordinator.withHostFilePublicationLease(workspaceId, operation) });
      this.knowledgeImportService = new KnowledgeImportRecoveryService({ native: this.knowledgeImports,
        readTx: operation => this.store.readExecutionObservationEvidence(operation), checkBinding: knowledgeBinding,
        readActivationProof: (workspaceId, key) => this.store.readKnowledgeImportDocumentProof(workspaceId, key),
        assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
        assertSourcesCurrent: (binding, source) => this.knowledgeHost.assertSourcesCurrent(binding, source),
        assertNoExecutionUncertainty: workspaceId => {
          verifyExecutionIdle(this.executionLockPath);
          if (this.store.hasUncertainSummaries(workspaceId) || this.store.hasUncertainExecution(workspaceId)) throw new EngineError('CLEANUP_PENDING', 'Independent coding or summary producers require their own recovery approval');
          const imported = this.knowledgeImports.getFrontier(workspaceId);
          if (imported?.head.state === 'resumed' && (this.store.hasUncertainKnowledgeGeneration(workspaceId) || this.store.hasUncertainKnowledgeFilePublication(workspaceId)))
            throw new EngineError('CLEANUP_PENDING', 'Successor knowledge producers require independent recovery before activation');
        },
        withWorkspaceLease: (workspaceId, operation) => this.coordinator.withRecoveryDecisionLease(workspaceId, signal => {
          if (this.hostResources.signal.aborted || signal.aborted) throw new EngineError('ENGINE_CLOSED', 'Engine closed during import recovery');
          verifyExecutionIdle(this.executionLockPath);
          return operation(signal);
        }),
      });
      const knowledgeContext = knowledgePolicy ? {
        policy: knowledgePolicy,
        getProfile: (run: Run) => { const profile = this.profiles.forRun(run.sessionId, run.config); return profile ? { id: profile.id, revision: profile.revision } : undefined; },
        source: this.store.createKnowledgeContextSource({
          checkBinding: knowledgeBinding,
          assertOwnerCurrent: (workspaceId, owner) => {
            const session = this.store.getSession(owner.sessionId);
            if (session.workspaceId !== workspaceId) throw new EngineError('KNOWLEDGE_CONTEXT_STALE', 'Knowledge context session belongs to another workspace');
            if (owner.runId === null) {
              if (owner.profile !== null) throw new EngineError('KNOWLEDGE_CONTEXT_STALE', 'Profile selection requires its admitted Run owner');
              return;
            }
            const run = this.store.getRun(owner.runId);
            if (run.sessionId !== session.id || run.workspaceId !== workspaceId || isTerminal(run.state) || run.state === 'cancelling')
              throw new EngineError('KNOWLEDGE_CONTEXT_STALE', 'Knowledge context requires its original active Run and session');
            const profile = this.profiles.forRun(run.sessionId, run.config);
            if (knowledgeHash(owner.profile) !== knowledgeHash(profile ? { id: profile.id, revision: profile.revision } : null))
              throw new EngineError('KNOWLEDGE_CONTEXT_STALE', 'Knowledge context profile differs from its admitted host configuration');
          },
          isPaused: workspaceId => this.workspaceKnowledge.isImportPaused(workspaceId),
          getDocumentHead: (workspaceId, key) => this.knowledgePublications.getDocumentHead(workspaceId, key),
          getDocumentRevision: (workspaceId, id) => this.knowledgePublications.getDocumentRevision(workspaceId, id),
          getPublication: (workspaceId, id) => this.knowledgePublications.getPublication(workspaceId, id),
          getReceipt: (workspaceId, requestId) => this.knowledgePublications.getReceipt(workspaceId, requestId),
          getCandidate: (workspaceId, id) => this.workspaceKnowledge.getCandidate(workspaceId, id),
          getGeneration: (workspaceId, id) => this.knowledgeGenerations.getGeneration(workspaceId, id),
          getAttempt: (workspaceId, id) => this.knowledgeGenerations.getAttempt(workspaceId, id),
          getPlan: (workspaceId, id) => this.workspaceKnowledge.getGenerationPlan(workspaceId, id),
          getTrust: workspaceId => this.workspaceKnowledge.getTrust(workspaceId),
          getTrustRevision: (workspaceId, id) => this.workspaceKnowledge.getTrustRevision(workspaceId, id),
          assertTrustSourcesCurrent: assertWorkspaceTrustSourcesCurrent,
          assertSourcesCurrent: (binding, source) => this.knowledgeHost.assertSourcesCurrent(binding, source),
        }),
      } : undefined;
      this.proposalOverlay = new ProposalOverlayContextSource({ checkBinding: knowledgeBinding,
        readTx: operation => this.store.readExecutionObservationEvidence(operation),
        getSet: (workspaceId, id) => this.proposalRecords.getSet(workspaceId, id),
        getSelection: (workspaceId, id) => this.proposalRecords.getSelection(workspaceId, id),
        readBlobText: reference => this.store.readProposalBlobText(reference),
        assertSourcesCurrent: (binding, manifest, signal) => this.proposalSource.assertStoredManifestCurrent(binding, manifest, signal),
        assertOwnerCurrent: (workspaceId, owner) => {
          const session = this.store.getSession(owner.sessionId);
          if (session.workspaceId !== workspaceId) throw new EngineError('PROPOSAL_CONTEXT_STALE', 'Proposal context belongs to another workspace');
          if (owner.runId === null) {
            if (owner.profile !== null) throw new EngineError('PROPOSAL_CONTEXT_STALE', 'Profile selection requires its original Run');
            return;
          }
          const run = this.store.getRun(owner.runId);
          if (run.sessionId !== session.id || run.workspaceId !== workspaceId || isTerminal(run.state) || run.state === 'cancelling') throw new EngineError('PROPOSAL_CONTEXT_STALE', 'Proposal context requires its original active Run');
          const profile = this.profiles.forRun(run.sessionId, run.config);
          if (knowledgeHash(owner.profile) !== knowledgeHash(profile ? { id: profile.id, revision: profile.revision } : null)) throw new EngineError('PROPOSAL_CONTEXT_STALE', 'Proposal context profile differs from its admitted configuration');
        } });
      const proposalContext = proposalPolicy ? { source: this.proposalOverlay, policy: proposalPolicy,
        getProfile: (run: Run) => { const profile = this.profiles.forRun(run.sessionId, run.config); return profile ? { id: profile.id, revision: profile.revision } : undefined; } } : undefined;
      this.context = new ContextService(this.store, models, options.outputTokenReserve, id => providers.get(id), { lifecycleHooks: this.lifecycleHooks,
        ...(options.lifecycleContextSlotBytes === undefined ? {} : { lifecycleContextSlotBytes: options.lifecycleContextSlotBytes }),
        ...(mediaHistoryPolicy ? { mediaHistoryPolicy } : {}), ...(activePrefixPolicy ? { activePrefixPolicy } : {}), ...(documentHistoryPolicy ? { documentHistoryPolicy } : {}), ...(repositoryPolicy ? { repositoryContext: { source: new RepositoryContextSource(this.repository), policy: repositoryPolicy } } : {}), ...(knowledgeContext ? { knowledgeContext } : {}), ...(proposalContext ? { proposalContext } : {}) });
      if (options.toolPolicy && options.toolPolicyInstance) throw new EngineError('INVALID_TOOL_POLICY', 'Specify rules or one trusted policy instance');
      const coreCommand = createCommandTool();
      const coreTools = options.tools ?? [...createReadTools(), createPatchTool(), coreCommand, createExactEditTool(), ...createFileActionTools(), ...createPatternSearchTools(), ...createSessionTaskTools(this.tasks), createQuestionTool(this.questions), ...createLocalReferenceTools(), createArtifactReadTool(this.store, this.managedArtifacts), createFormatTool(this.formatters), createLspFormatTool(this.lsp), createChildMergeTool(options.childTaskScope?.tasks ?? this.children.tasks, options.childTaskScope?.worktrees ?? this.children.worktrees, options.childTaskScope?.sessionId), createDelegateTaskTool(this.children.delegationHost(this.executionLockPath))];
      const nativeFiles = [canonicalDbPath, canonicalDbPath ? `${canonicalDbPath}.owner.sqlite` : undefined, this.executionLockPath, canonicalDbPath ? `${canonicalDbPath}.review.sqlite` : undefined].filter((path): path is string => path !== undefined);
      const source = new WorkspaceExecutionSource({ checkWorkspaceBinding: workspace => {
        this.verifyChildStorageIdentity();
        if (JSON.stringify(this.store.getWorkspace(workspace.id)) !== JSON.stringify(workspace)) throw new EngineError('EXECUTION_OBSERVATION_STALE', 'Observed workspace binding changed');
      }, ...(options.diagnosticSourceLimits ? { limits: options.diagnosticSourceLimits } : {}), excludedPaths: [{ path: this.storagePaths.artifactDir, kind: 'directory' }, ...nativeFiles.flatMap(path => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`].map(path => ({ path, kind: 'file' as const })))] });
      this.executionObserver = new EngineExecutionObserver(this.store, source, () => this.toolRuntime);
      const workspaceSourceTools = options.tools ? [] : coreTools.filter(tool => ['read_file', 'list_files', 'search_files', 'glob_files', 'regex_search', 'apply_patch', 'edit_file', 'rename_file', 'delete_file', 'run_command'].includes(tool.name));
      this.toolRuntime = new ScopedToolRuntime({ policy: options.toolPolicyInstance ?? new ToolPolicy(options.toolPolicy), grants: new ScopedToolGrants(Date.now, this.store), artifacts: this.managedArtifacts,
        workspaceSourceTools: Object.freeze(workspaceSourceTools), ...(options.diagnosticObservations === true ? { beforeProducer: (prepared, context) => this.executionObserver.beforeProducer(prepared, context) } : {}),
        ...(options.roleResourcePolicy ? { roleResources: options.roleResourcePolicy } : {}), ...(options.roleResourcePolicyRegistry ? { roleResourcePolicyRegistry: options.roleResourcePolicyRegistry } : {}), ...(options.resolveRoleResources ? { resolveRoleResources: options.resolveRoleResources } : {}), ...(options.commandPreflight ? { commandPreflight: options.commandPreflight } : {}) });
      let commandRegistration: ToolRegistrationCapture | undefined;
      const repositoryTools = options.repositoryContextTools ? [createRepositoryContextTool(this.repository)] : [];
      const verificationTool = this.verificationEnabled ? createVerificationTool({ plans: this.verificationPlans, receipts: this.verificationReceipts, getRun: id => this.store.getRun(id), sourceObservation: (context, signal) => this.verificationHost.observe(context, AbortSignal.any([signal, this.hostResources.signal])), commandRuntime: this.toolRuntime, captureCatalogue: context => this.coordinator.captureToolCatalogue(context),
        consumedSettlementWriter: (context, kind, revision, data) => this.coordinator.commitConsumedVerificationSettlement(context, kind, revision, data),
        commandCapability: (_context, catalogue) => {
          if (!commandRegistration) throw new EngineError('TOOL_PRODUCER_MISMATCH', 'The original engine command producer is unavailable');
          this.toolRuntime.assertRegistrationCurrent(catalogue, commandRegistration);
          return Object.freeze({ producer: 'engine-owned-run-command' as const, platform: process.platform, supported: process.platform !== 'win32', catalogueRevision: catalogue.revision });
        }, artifacts: this.managedArtifacts }) : undefined;
      const verificationTools: ToolDefinition[] = verificationTool ? [{ ...verificationTool, prepare: async (input, context) => { await this.verificationHost.ensurePlan(context, context.signal); return verificationTool.prepare(input, context); } }] : [];
      const availableTools = toolDiscoveryPolicy ? [...coreTools, ...repositoryTools, ...this.teamModelDefinitions, createToolDiscoveryTool({
        identity: context => this.coordinator.toolDiscoveryIdentity(context),
        stage: (context, query, limit, expected, action) => this.coordinator.stageToolDiscovery(context, query, limit, expected, action),
      }), ...verificationTools] : [...coreTools, ...repositoryTools, ...this.teamModelDefinitions, ...verificationTools];
      if (options.allowedToolNames && (new Set(options.allowedToolNames).size !== options.allowedToolNames.length || options.allowedToolNames.some(name => !availableTools.some(tool => tool.name === name)))) throw new EngineError('INVALID_TOOL_ALLOWLIST', 'Host tool allowlist must name unique available tools');
      this.hostAllowedTools = options.allowedToolNames ? [...options.allowedToolNames] : undefined;
      const tools = options.allowedToolNames ? availableTools.filter(tool => options.allowedToolNames!.includes(tool.name)) : availableTools;
      for (const tool of tools) this.toolRuntime.register('engine', tool, (TEAM_MODEL_TOOL_NAMES as readonly string[]).includes(tool.name) ? { exactApproval: (TEAM_MODEL_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name) } : options.tools ? {} : ['delegate_task', 'verify_changes'].includes(tool.name) ? { exactApproval: true } : { revalidate: async (prepared, context) => {
        const current = await tool.prepare(prepared.input, context);
        if (current.fingerprint !== prepared.fingerprint || JSON.stringify(current.preview) !== JSON.stringify(prepared.preview)) throw new EngineError('TOOL_APPROVAL_STALE', 'Tool resources changed since scoped authorization');
      } });
      if (this.verificationEnabled && tools.includes(coreCommand)) commandRegistration = this.toolRuntime.captureRegistration('engine', 'run_command', coreCommand);
      this.plugins = new EnginePluginManager(this.toolRuntime);
      this.capabilities = {
        schemaVersion: SCHEMA_VERSION,
        runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, commandExecution: process.platform === 'win32' ? 'unsupported' : 'posix-process-group' },
        providerIds: [...providers.keys()].sort(),
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema: structuredClone(inputSchema) })),
        modes: ['plan', 'build'], defaults: structuredClone(this.defaults),
        features: { historyPaging: true, sessionMetrics: true },
        extensions: { sessionSchemaVersions: [SESSION_SCHEMA_VERSION], commands: [...NATIVE_COMMANDS_ENABLED] },
      };
      this.coordinator = new RunCoordinator({
        beforeProviderDispatch: run => this.scheduleProducer.beforeProviderDispatch(run),
        onRunStarted: async (run,signal) => {
          const admission = waitChildProviderAdmission(this,signal);
          if (admission) await admission;
          if (signal.aborted) throw signal.reason ?? new EngineError('CANCELLED', 'Run initialization was cancelled');
          if (this.verificationEnabled) await this.verificationHost.start(run,signal);
        },
        ...(options.diagnosticObservations === true ? { executionObserver: this.executionObserver } : {}),
        ...(options.lifecycleContinuation === true ? { lifecycleContinuation: createLifecycleContinuationPort({ store: this.store, controller: this.verificationController, plans: this.verificationPlans,
          observeSource: (run, signal) => this.verificationHost.observe({ sessionId: run.sessionId, runId: run.id, workspace: this.store.getWorkspace(run.workspaceId) }, signal),
          readCurrentProfile: run => { const profile = this.profiles.forRun(run.sessionId, run.config); return profile ? { id: profile.id, revision: profile.revision } : null; },
          assertBoundaryCurrent: (run, boundary) => this.coordinator.assertVerificationBoundaryCurrent(run, boundary),
          readRemainingBudget: run => this.coordinator.verificationRemainingBudget(run),
        }) } : {}),
        ...(this.verificationEnabled ? {
          verificationStop: async (run, boundary, signal) => {
            if (!this.verificationHost.configuration(run.sessionId)) return null;
            const workspace = this.store.getWorkspace(run.workspaceId);
            if (!this.verificationPlans.get(run.sessionId, run.id)) {
              try { await this.verificationHost.ensurePlan({ sessionId: run.sessionId, runId: run.id, workspace }, signal); }
              catch (error) { if (!(error instanceof EngineError) || error.code !== 'VERIFICATION_CHECK_NOT_FOUND') throw error; }
            }
            const source = await this.verificationHost.observe({ sessionId: run.sessionId, runId: run.id, workspace }, signal), verification = this.verificationPlans.get(run.sessionId, run.id);
            const result = await this.verificationController.evaluate(run.sessionId, run.id, this.verificationController.get(run.sessionId, run.id)?.revision ?? 0, { boundary, source, verificationRevision: verification?.revision ?? 0, planSha256: verification?.plans.at(-1)?.planSha256 ?? null }, signal);
            const content = verificationContinuationMessage(result);
            return content && result.result.stageId ? { stageId: result.result.stageId, message: { role: 'user' as const, content: `[Moodcode verification control v1]\n${content}` } } : null;
          },
          verificationBeforeProvider: async (run, boundary, signal) => {
            const workspace = this.store.getWorkspace(run.workspaceId), source = await this.verificationHost.observe({ sessionId: run.sessionId, runId: run.id, workspace }, signal), verification = this.verificationPlans.get(run.sessionId, run.id);
            const result = await this.verificationController.evaluate(run.sessionId, run.id, this.verificationController.get(run.sessionId, run.id)?.revision ?? 0, { boundary, source, verificationRevision: verification?.revision ?? 0, planSha256: verification?.plans.at(-1)?.planSha256 ?? null }, signal);
            if (result.result.action === 'stop') throw new EngineError('VERIFICATION_CONTINUATION_BLOCKED', `Verification continuation stopped (${result.result.reason})`);
          },
        } : {}),
        lifecycleHooks: this.lifecycleHooks,
        store: this.store,
        providers,
        tools,
        approvals: this.approvals,
        artifactDir,
        executionLockPath: this.executionLockPath,
        buildContext: request => this.context.build({ ...request, agentInstructions: this.profiles.forRun(request.snapshot.session.id, request.config)?.instructions }),
        contextSnapshot: (sessionId, config) => this.context.snapshot(sessionId, config),
        getContextRevisionId: sessionId => this.context.revisionId(sessionId),
        assertContextFresh: async (request, signal) => {
          const run = this.store.getRun(request.runId);
          this.profiles.forRun(run.sessionId, run.config);
          await this.context.assertFresh(request.sessionId, request.messages, signal, request.runId);
          this.profiles.forRun(run.sessionId, run.config);
        },
        releaseContext: (sessionId, runId) => this.context.releaseContext(sessionId, runId),
        getToolProfile: run => {
          const profile = this.profiles.forRun(run.sessionId, run.config);
          return profile ? { id: profile.id, revision: profile.revision } : undefined;
        },
        getAllowedTools: run => {
          const profile = this.profiles.forRun(run.sessionId, run.config)?.tools;
          return this.hostAllowedTools ? (profile ? profile.filter(name => this.hostAllowedTools!.includes(name)) : this.hostAllowedTools) : profile;
        },
        recoverContextOverflow: (request, provider) => this.context.recoverOverflow(request, provider),
        toolRuntime: this.toolRuntime,
        ...(toolDiscoveryPolicy ? { toolDiscoveryPolicy, coreToolNames: coreTools.map(tool => tool.name) } : {}),
        onToolCheckpoint: async observation => {
          await this.watchWorkspace(observation.workspace.id);
          const changes = await this.changes.recordCheckpoint({ ...observation, sessionId: observation.run.sessionId, runId: observation.run.id });
          await Promise.all(changes.map(change => this.syncLanguageServers(change)));
        },
      });
      this.scheduleProducer = new EngineScheduleProducer(this, knowledgeBinding, () => this.scheduleRecords, () => this.closing, () => this.schedulesEnabled);
      this.scheduleRecords = this.store.createScheduleStorage({
        readWorker: original => this.scheduleProducer.readWorker(original),
        assertWorkerCurrent: (original, expected, phase) => this.scheduleProducer.assertWorkerCurrent(original, expected, phase),
        readTarget: original => this.scheduleProducer.readTarget(original),
        assertTargetCurrent: (original, expected, spec) => this.scheduleProducer.assertTargetCurrent(original, expected, spec),
        readTrigger: original => this.scheduleProducer.readTrigger(original),
        assertTriggerCurrent: (original, expected, spec) => this.scheduleProducer.assertTriggerCurrent(original, expected, spec),
        readAcceptedInput: original => this.scheduleProducer.readAcceptedInput(original),
        readInputObservation: original => this.scheduleProducer.readInputObservation(original),
        readDueBatch: original => this.scheduleProducer.readDueBatch(original),
        assertDueBatchCurrent: (original, expected, spec) => this.scheduleProducer.assertDueBatchCurrent(original, expected, spec),
      });
      this.scheduleRecords.recoverInterrupted();
      this.scheduler = new InputScheduler({ store: this.store, coordinator: this.coordinator, beforePromotion: input => this.scheduleProducer.beforePromotion(input) });
      const scheduleHost = new ScheduleHost({ native: this.scheduleRecords, input: this.scheduleProducer.inputPort() });
      this.scheduleDispatcher = new ScheduleDispatcher({ native: this.scheduleRecords, host: scheduleHost });
      this.backendProducer = new EngineAgentBackendProducer(this, knowledgeBinding, () => this.backendRecords, () => this.closing,
        () => this.agentBackendsEnabled, this.executionLockPath, options.agentBackendSecrets);
      this.backendProcesses = new OwnedBackendProcesses(this.backendProducer);
      this.backendRecords = this.store.createAgentBackendStorage({
        readOwner: original => this.backendProducer.readOwner(original),
        assertOwnerCurrent: (original, proof, phase) => this.backendProducer.assertOwnerCurrent(original, proof, phase),
        readTarget: original => this.backendProducer.readTarget(original),
        assertTargetCurrent: (original, proof, spec) => this.backendProducer.assertTargetCurrent(original, proof, spec),
        readConnection: original => this.backendProducer.observeConnection(original, this.backendProcesses.readConnection(original)),
        assertConnectionCurrent: original => this.backendProcesses.assertConnectionCurrent(original),
        readPeerObservation: original => this.backendProcesses.readPeerObservation(original),
        readWrite: original => this.backendProcesses.readWrite(original),
        readClientEffect: original => this.coordinator.readProviderClientReadCompletion(original),
        readDisposal: original => this.backendProcesses.readDisposal(original),
      });
      this.backendRecords.recoverInterrupted();
      this.backendHost = new AgentBackendHost({ store: this.backendRecords, processes: this.backendProcesses, clientReads: this.backendProducer.clientReadPort(), turns: this.backendProducer, lifetime: this.hostResources.signal });
      const recoveredRestores = this.reviewJournal.recoverPending();
      const recoveryAcknowledgments = canonicalDbPath ? readRecoveryAcknowledgments({ dbPath: canonicalDbPath, artifactDir: realpathSync(artifactDir) }) : [];
      for (const operation of recoveredRestores) {
        const run = this.store.getRun(operation.runId);
        if (run.workspaceId !== operation.workspaceId || run.sessionId !== operation.sessionId
          || !this.store.listCheckpoints(run.id).some((checkpoint) => checkpoint.id === operation.checkpointId && checkpoint.runId === run.id)) {
          throw new EngineError('REVIEW_OPERATION_BINDING_MISMATCH', 'Interrupted restoration does not match the primary run and checkpoint');
        }
        if (!isRestoreAcknowledged(operation, recoveryAcknowledgments)) this.coordinator.quarantineWorkspace(operation.workspaceId);
      }
    } catch (error) {
      terminalJournal?.close();
      try { reviewJournal?.close(); }
      finally { this.store.close(); }
      throw error;
    }
  }

  /** Native inbox/session commands have their own explicit protocol and journal. */
  async dispatchSession(value: unknown): Promise<SessionCommandResult> {
    let commandId = '';
    try {
      const command = validateSessionCommand(value, { defaults: this.defaults, enabledCommands: NATIVE_COMMANDS_ENABLED });
      commandId = command.commandId;
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      const payload = command.payload;
      let result: unknown;
      switch (command.type) {
        case 'engine.getCapabilities': result = this.getCapabilities(); break;
        case 'input.accept': {
          const input = normalizeAcceptInput(payload, this.defaults);
          input.config = this.profiles.apply(input.sessionId, input.config);
          if ((input.attachments?.length || input.documents?.length) && !this.store.lookupInputReceipt(input)) {
            assertInputMediaBudget(input.attachments, input.documents);
            if (input.documents?.length) await this.validateDocumentInput(input.sessionId, input.config, input.documents);
            if (input.attachments?.length) await this.validateImageInput(input.sessionId, input.config, input.attachments);
          }
          result = this.scheduler.accept(input); break;
        }
        case 'input.list': result = this.store.listInputs(payload.sessionId as string, payload.cursor as unknown as InputCursor | undefined, payload.limit as number); break;
        case 'input.cancel': {
          const input = this.store.getInput(payload.inputId as string);
          if (input.sessionId !== payload.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Input belongs to a different session');
          result = this.scheduler.cancelInput(input.id); break;
        }
        case 'session.pause': result = this.scheduler.pause(payload.sessionId as string); break;
        case 'session.resume': result = this.scheduler.resume(payload.sessionId as string); break;
        case 'session.events': {
          this.store.getSession(payload.sessionId as string);
          result = { sessionId: payload.sessionId, stream: 'session-v2', afterSeq: payload.afterSeq }; break;
        }
        case 'session.getTasks': result = this.tasks.get(payload.sessionId as string); break;
        case 'session.getContext': result = this.context.diagnostics(payload.sessionId as string); break;
        case 'session.getDiagnostics': {
          const session = this.store.getSession(payload.sessionId as string);
          result = { metrics: this.store.getNativeMetrics(session.id), context: this.context.diagnostics(session.id), workspaceObservation: { failure: this.observationFailures.get(session.workspaceId) ?? null, active: this.watchConsumers.has(session.workspaceId) } }; break;
        }
        case 'session.searchHistory': result = this.store.searchHistory(payload.sessionId as string, { query: payload.query as string, beforeMessageId: payload.beforeMessageId as string | undefined, limit: payload.limit as number, maxBytes: payload.maxBytes as number }); break;
        case 'session.setTasks': result = this.tasks.replace(payload.sessionId as string, payload.expectedRevision as number, payload.tasks); break;
        case 'question.list': result = this.questions.list(payload.sessionId as string); break;
        case 'question.answer': result = this.questions.answer(payload.sessionId as string, payload.questionId as string, payload.version as number, payload.answer as unknown as QuestionAnswer); break;
        case 'question.reject': result = this.questions.reject(payload.sessionId as string, payload.questionId as string, payload.version as number); break;
        case 'run.getTurns': result = this.store.listTurnsPage(payload.runId as string, payload.afterTurnId as string | undefined, payload.limit as number); break;
        case 'turn.getParts': result = this.store.listPartsPage(payload.turnId as string, payload.afterPartId as string | undefined, payload.limit as number); break;
        case 'artifact.get': {
          const run = this.store.getRun(payload.runId as string);
          if (run.sessionId !== payload.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Artifact run belongs to a different session');
          const page = await (await this.managedArtifacts()).read(payload.artifactId as string, { identity: {
            sessionId: payload.sessionId as string, runId: run.id, toolCallId: payload.toolCallId as string,
            ...(payload.turnId ? { turnId: payload.turnId as string } : {}), ...(payload.attemptId ? { attemptId: payload.attemptId as string } : {}),
          }, offset: payload.offset as number, limit: payload.limit as number });
          result = { reference: page.reference, offset: page.offset, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}), encoding: 'base64', content: Buffer.from(page.bytes).toString('base64') }; break;
        }
        default: throw new EngineError('UNKNOWN_COMMAND', 'Unknown session command');
      }
      return { schemaVersion: SESSION_SCHEMA_VERSION, commandId, ok: true, result: json(result) };
    } catch (error) {
      if (!commandId && value && typeof value === 'object') {
        try {
          const id = Object.getOwnPropertyDescriptor(value, 'commandId');
          if (id && 'value' in id && typeof id.value === 'string' && id.value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id.value)) commandId = id.value;
        } catch { /* Invalid objects are contained by the command result boundary. */ }
      }
      const failure = error instanceof EngineError ? error : new EngineError('INTERNAL_ERROR', 'Session command failed');
      return { schemaVersion: SESSION_SCHEMA_VERSION, commandId, ok: false, error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } };
    }
  }

  async dispatch(value: CommandEnvelope | unknown): Promise<CommandResult> {
    let commandId = '';
    try {
      const command = validateCommand(value, this.defaults);
      commandId = command.commandId;
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      const payload = command.payload;
      let result: unknown;
      switch (command.type) {
        case 'engine.getCapabilities':
          result = this.getCapabilities();
          break;
        case 'workspace.open': {
          const workspace = await openWorkspace(payload.path as string);
          result = this.store.putWorkspace(workspace);
          break;
        }
        case 'workspace.getStatus':
          result = await getWorkspaceStatus(this.store.getWorkspace(payload.workspaceId as string));
          break;
        case 'file.list':
          result = await listWorkspaceFiles(this.store.getWorkspace(payload.workspaceId as string), payload.path as string | undefined, { ...(payload.limit === undefined ? {} : { limit: payload.limit as number }), ...(payload.continuation === undefined ? {} : { continuation: payload.continuation as string }) });
          break;
        case 'file.read':
          result = await readWorkspaceFile(this.store.getWorkspace(payload.workspaceId as string), payload.path as string);
          break;
        case 'session.create': {
          const workspaceId = payload.workspaceId as string;
          this.store.getWorkspace(workspaceId);
          const session: Session = { id: randomUUID(), workspaceId, title: (payload.title as string | undefined) ?? 'New session', createdAt: new Date().toISOString() };
          result = this.store.createSession(session);
          break;
        }
        case 'session.list': {
          this.store.getWorkspace(payload.workspaceId as string);
          result = this.store.listSessions(payload.workspaceId as string);
          break;
        }
        case 'session.getSnapshot':
          result = this.store.getSnapshot(payload.sessionId as string);
          break;
        case 'session.getHistory':
          result = this.store.getHistory(payload.sessionId as string, payload.beforeRunId as string | undefined, payload.limit as number | undefined);
          break;
        case 'session.getMetrics':
          result = this.store.getMetrics(payload.sessionId as string);
          break;
        case 'run.submit':
          {
            const input = normalizeSubmitInput(payload);
            input.config = this.profiles.apply(input.sessionId, input.config);
            if ((input.attachments?.length || input.documents?.length) && !this.store.lookupRunReceipt(input)) {
              assertInputMediaBudget(input.attachments, input.documents);
              if (input.documents?.length) await this.validateDocumentInput(input.sessionId, input.config, input.documents);
              if (input.attachments?.length) await this.validateImageInput(input.sessionId, input.config, input.attachments);
            }
            result = this.scheduler.submitLegacy(input);
          }
          break;
        case 'run.cancel':
          result = this.coordinator.cancel(payload.runId as string);
          break;
        case 'approval.decide':
          result = this.approvals.decide(payload.approvalId as string, payload.decision as 'allow' | 'deny', payload.fingerprint as string);
          break;
        case 'review.getDiff':
          result = await getReviewDiff(this.store, payload.runId as string);
          break;
        case 'review.previewRestore': {
          const run = this.restoreRun(payload.runId as string, payload.checkpointId as string);
          result = await previewRestoreCheckpoint(this.store, this.store.getWorkspace(run.workspaceId), payload.checkpointId as string, { executionLockPath: this.executionLockPath });
          break;
        }
        case 'review.restore':
          result = await this.restore(command.commandId, payload.runId as string, payload.checkpointId as string, payload.previewFingerprint as string);
          break;
        case 'review.history': {
          const run = this.store.getRun(payload.runId as string);
          result = { runId: run.id, operations: this.reviewJournal.list(run.id) } satisfies ReviewHistoryResult;
          break;
        }
        case 'events.subscribe':
          this.store.getSession(payload.sessionId as string);
          result = { sessionId: payload.sessionId, afterSeq: payload.afterSeq ?? 0 };
          break;
        default:
          throw new EngineError('UNKNOWN_COMMAND', 'Unknown engine command');
      }
      return { schemaVersion: SCHEMA_VERSION, commandId, ok: true, result: json(result) };
    } catch (error) {
      if (!commandId && value && typeof value === 'object') {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(value, 'commandId');
          if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
            && descriptor.value.trim().length > 0 && descriptor.value.length <= 256
            && !/[\u0000-\u001f\u007f]/u.test(descriptor.value)
            && Buffer.byteLength(descriptor.value) <= 256) commandId = descriptor.value;
        } catch { /* Invalid object traps must not escape the command result boundary. */ }
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        commandId,
        ok: false,
        error: error instanceof EngineError ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } : { code: 'INTERNAL_ERROR', message: 'Unexpected engine error' },
      };
    }
  }

  private restoreRun(runId: string, checkpointId: string): Run {
    const run = this.store.getRun(runId);
    if (!this.store.listCheckpoints(runId).some((checkpoint) => checkpoint.id === checkpointId && checkpoint.runId === runId)) {
      throw new EngineError('CHECKPOINT_RUN_MISMATCH', 'Checkpoint does not belong to the requested run');
    }
    return run;
  }

  private restoreReply(operation: RestoreOperation): RestoreCommandResult {
    if (operation.state === 'completed' && operation.result) return { ...operation.result, operationId: operation.id, duplicate: true };
    if (operation.state === 'started') throw new EngineError('RESTORE_PENDING', 'Restoration has already started and has no recorded final outcome; effects will not be replayed');
    if (operation.error) throw new EngineError(operation.error.code, operation.error.message);
    throw new EngineError('RESTORE_INTERRUPTED', 'Restoration has no confirmed outcome; effects will not be replayed');
  }

  private restore(commandId: string, runId: string, checkpointId: string, fingerprint: string): Promise<RestoreCommandResult> {
    const sameRequest = (binding: RestoreOperationInput): boolean => binding.runId === runId && binding.checkpointId === checkpointId && binding.fingerprint === fingerprint;
    const conflict = (): never => { throw new EngineError('REVIEW_JOURNAL_OPERATION_CONFLICT', 'Operation ID is already bound to a different restore request'); };
    const inFlight = this.restoreRequests.get(commandId);
    if (inFlight) {
      if (!sameRequest(inFlight.binding)) conflict();
      return inFlight.promise.then((result) => ({ ...result, duplicate: true }));
    }
    const existing = this.reviewJournal.get(commandId);
    if (existing) {
      if (!sameRequest(existing)) conflict();
      const recordedRun = this.restoreRun(runId, checkpointId);
      if (existing.sessionId !== recordedRun.sessionId || existing.workspaceId !== recordedRun.workspaceId) conflict();
      return Promise.resolve(this.restoreReply(existing));
    }
    const run = this.restoreRun(runId, checkpointId);
    if (!isTerminal(run.state)) throw new EngineError('RUN_NOT_TERMINAL', 'An active run cannot be restored');
    const workspace = this.store.getWorkspace(run.workspaceId);
    const binding: RestoreOperationInput = { id: commandId, runId, checkpointId, fingerprint, sessionId: run.sessionId, workspaceId: run.workspaceId };
    let observed: RestoreCommandResult | undefined;
    const lease = this.coordinator.withWorkspaceLease(workspace.id, async (signal) => {
      // All audit writes stay inside the lease so close cannot release either
      // SQLite connection while a restoration is still recording its outcome.
      try {
        // The public journal may have been updated after synchronous dispatch
        // admission but before this microtask. Never execute a known operation.
        const previous = this.reviewJournal.get(commandId);
        if (previous) {
          if ((Object.keys(binding) as (keyof RestoreOperationInput)[]).some((key) => previous[key] !== binding[key])) conflict();
          observed = this.restoreReply(previous);
          return observed;
        }
        this.reviewJournal.start(binding);
      }
      catch (error) {
        if (error instanceof EngineError) throw error;
        throw new EngineError('REVIEW_RECORD_FAILED', 'Restoration could not start because audit recording failed');
      }
      let restored: RestoreResult;
      try { restored = await restoreCheckpoint(this.store, workspace, checkpointId, { signal, executionLockPath: this.executionLockPath, previewFingerprint: fingerprint }); }
      catch (error) {
        const failure = error instanceof EngineError ? error : new EngineError('RESTORE_FAILED', 'Checkpoint restoration failed');
        try { this.reviewJournal.finish(commandId, { error: { code: failure.code, message: failure.message } }); }
        catch {
          this.coordinator.quarantineWorkspace(workspace.id);
          throw new EngineError(failure.code, failure.message, { ...(failure.details ?? {}), recordMetadataError: metadataFailure() });
        }
        throw failure;
      }
      observed = { ...restored, operationId: commandId, duplicate: false };
      if (restored.effectsUncertain || restored.executionBlocked) this.coordinator.quarantineWorkspace(workspace.id);
      if (restored.restored.length) {
        const checkpoint = this.store.listCheckpoints(run.id).find(item => item.id === checkpointId)!;
        try {
          await this.watchWorkspace(workspace.id);
          const restoredPaths = new Set(restored.restored);
          const changes = await this.changes.recordCheckpoint({ workspace, sessionId: run.sessionId, runId: run.id, toolCallId: checkpoint.toolCallId, signal,
            checkpoints: [{ ...checkpoint, id: `restore_${createHash('sha256').update(commandId).digest('hex')}`, createdAt: new Date().toISOString(), files: checkpoint.files.filter(file => restoredPaths.has(file.path)).map(file => ({ ...file, before: file.after, after: file.before, beforeHash: file.afterHash, afterHash: file.beforeHash })) }] });
          await Promise.all(changes.map(change => this.syncLanguageServers(change)));
        } catch { observed.warnings.push('Restoration effects were recorded, but workspace observation or language-service delivery could not be confirmed.'); }
      }
      try { this.reviewJournal.finish(commandId, restored); }
      catch {
        this.coordinator.quarantineWorkspace(workspace.id);
        observed.recordMetadataError = metadataFailure();
        observed.warnings = [...observed.warnings, observed.recordMetadataError.message];
      }
      return observed;
    });
    const pending = lease.catch((error: unknown) => {
      // A returned service result retains its observed partial effects even
      // when the coordinator refuses to claim confirmed cleanup.
      if (observed && error instanceof EngineError && error.code === 'CLEANUP_UNCERTAIN') return observed;
      throw error;
    }).finally(() => { this.restoreRequests.delete(commandId); });
    this.restoreRequests.set(commandId, { binding, promise: pending });
    void pending.catch(() => {});
    return pending;
  }

  subscribe(sessionId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new EngineError('INVALID_CURSOR', 'afterSeq must be a non-negative safe integer');
    return this.store.subscribe(sessionId, afterSeq, signal);
  }

  subscribeSession(sessionId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<SessionEventV2> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.subscribeSessionEvents(sessionId, afterSeq, signal);
  }

  waitForSession(sessionId: string): Promise<void> { return this.scheduler.waitForSession(sessionId); }

  waitForRun(runId: string): Promise<Run> { return this.coordinator.waitForRun(runId); }

  startChildTask(request: EngineChildRequest) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.children.start(request);
  }

  registerLanguageServer(serverId: string, factory: LspFactory, languageForPath: (path: string) => string | null, revision = '1'): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (typeof languageForPath !== 'function') throw new EngineError('INVALID_LSP_CONFIG', 'Host must explicitly select supported language paths');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(revision)) throw new EngineError('INVALID_LSP_CONFIG', 'Host language server revision must be bounded');
    this.lsp.register(serverId, factory); this.languageServers.set(serverId, languageForPath); this.languageServerRevisions.set(serverId, revision);
  }

  getRepositoryContext(workspaceId: string, query: RepositoryQuery, signal?: AbortSignal): Promise<RepositorySnapshot> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    const pending = this.repository.query(this.store.getWorkspace(workspaceId), query, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    this.pendingRepository.add(pending);
    pending.finally(() => this.pendingRepository.delete(pending)).catch(() => {});
    return pending;
  }

  registerLifecycleHook(hook: LifecycleHookRegistration): () => void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.lifecycleHooks.register(hook);
  }

  getTrajectory(options: TrajectoryOptions): JournalProjection {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    validateTrajectoryOptions(options);
    if (options.runId !== undefined) {
      const run = this.store.getRun(options.runId);
      if (run.sessionId !== options.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Trajectory Run belongs to another session');
    }
    return exportTrajectory(this.store, options);
  }

  getAttemptManifest(runId: string, options: Omit<TrajectoryOptions, 'sessionId' | 'runId'> & { source?: CodingSourceIdentity } = {}): CodingEvidenceManifest {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    validateCodingEvidenceOptions(options);
    const run = this.store.getRun(runId), { source, ...page } = options;
    return createCodingEvidenceManifest(run, this.getTrajectory({ ...page, sessionId: run.sessionId, runId }), source);
  }

  getCodingEvidence(runId: string, options: NativeCodingEvidenceOptions = {}) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return readNativeCodingEvidence({ getRun: id => this.store.getRun(id), getSession: id => this.store.getSession(id),
      readSessionEvents: (sessionId, afterSeq, limit) => this.store.readSessionEvents(sessionId, afterSeq, limit),
      listExecutionObservations: (workspaceId, id, page) => this.executionObserver.storage.listRun(workspaceId, id, page),
      readCoherentSnapshot: operation => this.store.readExecutionObservationEvidence(operation),
    }, runId, options);
  }

  inspectToolRegistration(toolName: string, scopeId = 'engine') {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.toolRuntime.inspectToolRegistration(scopeId, toolName);
  }

  getStallObservation(options: TrajectoryOptions, limits?: StallOptions): StallObservation {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => {
      const trajectory = this.getTrajectory(options), run = trajectory.runId ? this.store.getRun(trajectory.runId) : undefined;
      const observations = run ? this.executionObserver.storage.listRun(run.workspaceId, run.id).items : [];
      return getTrajectoryStallObservation(trajectory, limits, observations);
    });
  }

  getExecutionObservations(input: { workspaceId: string; runId: string } & DiagnosticExecutionPageOptions) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new EngineError('INVALID_EXECUTION_OBSERVATION', 'Observation queries require plain bounded data');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (!['workspaceId', 'runId'].every(key => Object.hasOwn(descriptors[key] ?? {}, 'value')) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['workspaceId', 'runId', 'afterOrdinal', 'throughOrdinal', 'limit', 'maxBytes'].includes(key) || !Object.hasOwn(descriptors[key]!, 'value'))) throw new EngineError('INVALID_EXECUTION_OBSERVATION', 'Observation queries require exact plain bounded data');
    const { workspaceId, runId, ...page } = input;
    return this.store.readExecutionObservationEvidence(() => {
      if (this.store.getRun(runId).workspaceId !== workspaceId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Observation Run belongs to another workspace');
      return this.executionObserver.storage.listRun(workspaceId, runId, page);
    });
  }

  getPolicyDecisionReceipts(options: TrajectoryOptions): PolicyDecisionReceiptPage {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    validateTrajectoryOptions(options);
    if (options.runId !== undefined && this.store.getRun(options.runId).sessionId !== options.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Decision Run belongs to another session');
    return readPolicyDecisionReceipts(this.store, options);
  }

  async watchWorkspace(workspaceId: string): Promise<WorkspaceChangeWatch> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    const workspace = this.store.getWorkspace(workspaceId), watch = await this.changes.watch(workspace, { signal: this.hostResources.signal });
    if (!this.watchConsumers.has(workspaceId)) {
      const consumer = (async () => {
        try { for await (const event of this.changes.subscribe(workspaceId, 0, this.hostResources.signal)) {
          if (event.type === 'change') await this.syncLanguageServers(event.change);
          else if (event.type === 'incomplete') this.observationFailures.set(workspaceId, event.code);
        } } catch (error) { if (!this.hostResources.signal.aborted) this.observationFailures.set(workspaceId, error instanceof EngineError ? error.code : 'WORKSPACE_OBSERVATION_FAILED'); }
      })();
      this.watchConsumers.set(workspaceId, consumer);
    }
    return watch;
  }

  private syncLanguageServers(change: WorkspaceFileChange): Promise<void> {
    const workspace = this.store.getWorkspace(change.workspaceId);
    return Promise.all([...this.languageServers].map(async ([serverId, selectLanguage]) => {
      const language = selectLanguage(change.path); if (!language) return;
      const key = JSON.stringify([workspace.id, serverId, change.path]), known = this.lspChanges.get(key);
      if (known && known.version >= change.documentVersion) return known.done;
      const done = this.lsp.fileChanged(workspace, serverId, change.path, language, change.kind, this.hostResources.signal).catch(error => {
        this.observationFailures.set(workspace.id, error instanceof EngineError ? error.code : 'LSP_UPDATE_FAILED');
        if (this.lspChanges.get(key)?.done === done) this.lspChanges.delete(key);
      });
      this.lspChanges.set(key, { version: change.documentVersion, done });
      if (this.lspChanges.size > 256) this.lspChanges.delete(this.lspChanges.keys().next().value!);
      return done;
    })).then(() => {});
  }

  createWorktree(sessionId: string, requestId: string, reference?: string) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId), workspace = this.store.getWorkspace(session.workspaceId);
    this.children.recover(sessionId);
    return this.coordinator.withWorkspaceLease(workspace.id, signal => this.children.worktrees.create({ sessionId, requestId, workspace, ...(reference ? { reference } : {}) }, signal));
  }

  cleanupWorktree(sessionId: string, worktreeId: string) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId);
    return this.coordinator.withWorkspaceLease(session.workspaceId, signal => this.children.worktrees.cleanup(sessionId, worktreeId, signal));
  }

  prepareChildWorktree(sessionId: string, parentWorktreeId: string, requestId: string, reference?: string) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId);
    this.children.recover(sessionId);
    return this.coordinator.withWorkspaceLease(session.workspaceId, async signal => {
      const parent = this.children.worktrees.get(sessionId, parentWorktreeId);
      if (parent.ownerId) throw new EngineError('CHILD_WORKTREE_BUSY', 'Prepare nested worktrees before an execution owns their parent');
      const workspace = await this.children.worktrees.verify(parent, signal);
      return this.children.worktrees.create({ sessionId, requestId, workspace, ...(reference ? { reference } : {}) }, signal);
    });
  }

  getCapabilities(): EngineCapabilities {
    return { ...structuredClone(this.capabilities), providerIds: [...this.runtimeProviders.keys()].sort(), tools: [...this.toolRuntime.catalogue('engine', 'build', this.hostAllowedTools).tools] };
  }

  private assertAgentBackendsEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.agentBackendsEnabled) throw new EngineError('AGENT_BACKENDS_DISABLED', 'Agent backends require explicit root host opt-in');
  }
  captureAgentBackendTarget(input: CaptureAgentBackendTarget): object { this.assertAgentBackendsEnabled(); return this.backendProducer.captureTarget(input); }
  readAgentBackendTarget(original: object) { return this.backendProducer.readTargetPin(original); }
  registerAgentBackend(original: object, input: RegisterAgentBackendInput) {
    this.assertAgentBackendsEnabled();
    const selected = agentBackendObject(input, ['workspaceId', 'requestId', 'expectedRevision', 'spec']);
    const spec = validateAgentBackendSpec(selected.spec), providerId = `acp:${spec.id}`;
    if (this.runtimeProviders.has(providerId) && !this.backendProviderIds.has(providerId)) throw new EngineError('BACKEND_PROVIDER_ID_CONFLICT', 'The backend provider ID is already owned by a registered host provider');
    const result = this.backendRecords.registerBackend(original, { ...selected, spec } as unknown as RegisterAgentBackendInput);
    this.backendProducer.activate(result.record, original);
    this.runtimeProviders.set(providerId, this.backendHost.provider(result.record)); this.backendProviderIds.add(providerId);
    return result;
  }
  disableAgentBackend(input: DisableAgentBackendInput) {
    this.assertAgentBackendsEnabled(); const result = this.backendRecords.disableBackend(input);
    this.backendProducer.deactivate(result.record.backendId); const providerId = `acp:${result.record.backendId}`;
    if (this.backendProviderIds.has(providerId)) this.runtimeProviders.delete(providerId);
    return result;
  }
  getAgentBackend(workspaceId: string, backendId: string, revisionId?: string) { return this.backendRecords.getBackend(workspaceId, backendId, revisionId); }
  inspectAgentBackends(workspaceId: string) { return this.backendRecords.inspectBackends(workspaceId); }
  inspectAgentBackendConnections(workspaceId: string) { return this.backendRecords.inspectConnections(workspaceId); }
  inspectAgentBackendRequests(workspaceId: string) { return this.backendRecords.inspectRequests(workspaceId); }
  inspectAgentBackendEffects(workspaceId: string) { return this.backendRecords.inspectClientEffects(workspaceId); }
  releaseAgentBackendTarget(original: object): void { this.backendProducer.releaseTarget(original); }

  replaceRoleResourcePolicy(expectedRegistryRevision: number, policy: RoleResourcePolicySnapshot) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.roleResourcePolicyRegistry) throw new EngineError('ROLE_POLICY_UNSUPPORTED', 'Dynamic role policy requires an explicit host registry');
    return this.roleResourcePolicyRegistry.replace(expectedRegistryRevision, policy);
  }

  registerVerificationCheck(check: VerificationCheckRegistration): () => void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.verificationEnabled) throw new EngineError('VERIFICATION_UNSUPPORTED', 'Verification tools require explicit host opt-in');
    this.store.getWorkspace(check.workspaceId);
    return this.verificationChecks.register(check);
  }

  configureVerificationSession(sessionId: string, expectedRevision: number, policy: VerificationSessionPolicy) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    if (!this.verificationEnabled) return Promise.reject(new EngineError('VERIFICATION_UNSUPPORTED', 'Verification tools require explicit host opt-in'));
    const session = this.store.getSession(sessionId);
    return this.coordinator.withWorkspaceLease(session.workspaceId, signal => this.verificationHost.configure(sessionId, expectedRevision, policy, signal));
  }

  getVerificationConfiguration(sessionId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.verificationHost.configuration(sessionId);
  }

  getVerificationState(sessionId: string, runId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.verificationPlans.get(sessionId, runId);
  }

  getVerificationCompletion(sessionId: string, runId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.verificationController.get(sessionId, runId);
  }

  previewWorkspaceTrust(workspaceId: string, paths: readonly string[]) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.workspaceTrust.preview(workspaceId, paths);
  }

  private assertKnowledgeImportRecoveryEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.knowledgeImportRecoveryEnabled) throw new EngineError('KNOWLEDGE_IMPORT_RECOVERY_DISABLED', 'Imported knowledge recovery requires explicit host opt-in');
  }
  previewWorkspaceKnowledgeImportAcknowledgment(input: Parameters<KnowledgeImportRecoveryService['previewAcknowledgment']>[0]) {
    this.assertKnowledgeImportRecoveryEnabled(); return this.knowledgeImportService.previewAcknowledgment(input);
  }
  previewWorkspaceKnowledgeImportRecovery(input: Parameters<KnowledgeImportRecoveryService['previewResume']>[0]) {
    this.assertKnowledgeImportRecoveryEnabled(); return this.knowledgeImportService.previewResume(input);
  }
  previewWorkspaceKnowledgeImportActivation(input: Parameters<KnowledgeImportRecoveryService['previewActivation']>[0]) {
    this.assertKnowledgeImportRecoveryEnabled(); return this.knowledgeImportService.previewActivation(input);
  }
  previewWorkspaceKnowledgeImportDeactivation(input: Parameters<KnowledgeImportRecoveryService['previewDeactivation']>[0]) {
    this.assertKnowledgeImportRecoveryEnabled(); return this.knowledgeImportService.previewDeactivation(input);
  }
  acknowledgeWorkspaceKnowledgeImport(input: Parameters<KnowledgeImportRecoveryService['acknowledge']>[0]) {
    try { this.assertKnowledgeImportRecoveryEnabled(); return this.knowledgeImportService.acknowledge(input); } catch (error) { return Promise.reject(error); }
  }
  resumeWorkspaceKnowledgeImport(input: Parameters<KnowledgeImportRecoveryService['resume']>[0]) {
    try { this.assertKnowledgeImportRecoveryEnabled(); return this.knowledgeImportService.resume(input); } catch (error) { return Promise.reject(error); }
  }
  activateWorkspaceKnowledgeImport(input: Parameters<KnowledgeImportRecoveryService['activate']>[0]) {
    try { this.assertKnowledgeImportRecoveryEnabled(); return this.knowledgeImportService.activate(input); } catch (error) { return Promise.reject(error); }
  }
  deactivateWorkspaceKnowledgeImport(input: Parameters<KnowledgeImportRecoveryService['deactivate']>[0]) {
    try { this.assertKnowledgeImportRecoveryEnabled(); return this.knowledgeImportService.deactivate(input); } catch (error) { return Promise.reject(error); }
  }
  releaseWorkspaceKnowledgeImportPreview(preview: Parameters<KnowledgeImportRecoveryService['releasePreview']>[0]): void { this.knowledgeImportService.releasePreview(preview); }
  getWorkspaceKnowledgeImportFrontier(workspaceId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.knowledgeImports.getFrontier(workspaceId));
  }
  getWorkspaceKnowledgeImportActivation(workspaceId: string, documentKey: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.knowledgeImports.getActivation(workspaceId, documentKey));
  }

  private assertTeamsEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.teamsEnabled) throw new EngineError('TEAMS_DISABLED', 'Teams require explicit host opt-in');
  }
  private assertSchedulesEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.schedulesEnabled) throw new EngineError('SCHEDULES_DISABLED', 'Schedules require explicit root host opt-in');
  }
  captureScheduleWorker(workspaceId: string): object { this.assertSchedulesEnabled(); return this.scheduleProducer.captureWorker(workspaceId); }
  captureScheduleTarget(input: Parameters<EngineScheduleProducer['captureTarget']>[0]): object { this.assertSchedulesEnabled(); return this.scheduleProducer.captureTarget(input); }
  readScheduleTarget(original: object) { this.assertSchedulesEnabled(); return this.scheduleProducer.targetPin(original); }
  registerSchedule(...args: Parameters<ScheduleStorage['registerSchedule']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.registerSchedule(...args); }
  disableSchedule(...args: Parameters<ScheduleStorage['disableSchedule']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.disableSchedule(...args); }
  getSchedule(...args: Parameters<ScheduleStorage['getSchedule']>) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.scheduleRecords.getSchedule(...args));
  }
  inspectSchedules(workspaceId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.scheduleRecords.inspectSchedules(workspaceId));
  }
  inspectScheduleOccurrences(...args: Parameters<ScheduleStorage['inspectOccurrences']>) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.scheduleRecords.inspectOccurrences(...args));
  }
  getSchedulerLease(workspaceId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.scheduleRecords.getLease(workspaceId));
  }
  acquireSchedulerLease(...args: Parameters<ScheduleStorage['acquireLease']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.acquireLease(...args); }
  renewSchedulerLease(...args: Parameters<ScheduleStorage['renewLease']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.renewLease(...args); }
  previewScheduleDue(input: Parameters<EngineScheduleProducer['captureDue']>[0]) { this.assertSchedulesEnabled(); return this.scheduleProducer.captureDue(input); }
  advanceScheduleDue(...args: Parameters<ScheduleStorage['advanceDueBatch']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.advanceDueBatch(...args); }
  previewScheduleWebhook(input: Parameters<EngineScheduleProducer['captureWebhook']>[0]) { this.assertSchedulesEnabled(); return this.scheduleProducer.captureWebhook(input); }
  acceptScheduleTrigger(...args: Parameters<ScheduleStorage['acceptTrigger']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.acceptTrigger(...args); }
  claimScheduleOccurrence(...args: Parameters<ScheduleStorage['claimOccurrence']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.claimOccurrence(...args); }
  captureScheduleOccurrenceObservation(...args: Parameters<ScheduleStorage['captureOccurrenceObservation']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.captureOccurrenceObservation(...args); }
  dispatchScheduleOccurrence(input: Parameters<ScheduleDispatcher['dispatch']>[0]) { this.assertSchedulesEnabled(); return this.scheduleDispatcher.dispatch(input); }
  observeScheduleOccurrence(input: Parameters<ScheduleDispatcher['observe']>[0]) { this.assertSchedulesEnabled(); return this.scheduleDispatcher.observe(input); }
  abandonScheduleOccurrence(...args: Parameters<ScheduleStorage['abandonClaim']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.abandonClaim(...args); }
  releaseScheduleHandle(original: object): void { this.scheduleProducer.release(original); this.scheduleRecords.releaseClaim(original); }
  bindTeamModelTools(input: BindTeamModelToolsInput): TeamModelToolsBinding { return this.teamModelHost.bind(input); }
  private assertWorkflowsEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.workflowsEnabled) throw new EngineError('WORKFLOWS_DISABLED', 'Workflows require explicit host opt-in');
  }
  registerWorkflow(input: Parameters<WorkflowService['register']>[0]) { this.assertWorkflowsEnabled(); return this.workflowService.register(input); }
  getWorkflow(workspaceId: string, workflowId: string, revisionId?: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.workflowRecords.getWorkflow(workspaceId, workflowId, revisionId));
  }
  async previewWorkflowStart(input: Parameters<WorkflowHost['previewStart']>[0]) {
    this.assertWorkflowsEnabled();
    const operation = this.workflowHost.previewStart(input);
    this.pendingStorage.add(operation);
    try { return await operation; } finally { this.pendingStorage.delete(operation); }
  }
  startWorkflow(input: Parameters<WorkflowService['start']>[0]) { this.assertWorkflowsEnabled(); return this.workflowService.start(input); }
  startWorkflowStage(input: Parameters<WorkflowService['startStage']>[0]) {
    try { this.assertWorkflowsEnabled(); return this.workflowService.startStage(input); } catch (error) { return Promise.reject(error); }
  }
  observeWorkflowStage(input: Parameters<WorkflowService['observeStage']>[0]) {
    try { this.assertWorkflowsEnabled(); return this.workflowService.observeStage(input); } catch (error) { return Promise.reject(error); }
  }
  inspectWorkflow(workspaceId: string, instanceId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.workflowRecords.inspectWorkflow(workspaceId, instanceId));
  }
  releaseWorkflowStartPreview(input: Parameters<WorkflowHost['release']>[0]): void { this.workflowHost.release(input); }
  releaseTeamModelTools(original: TeamModelToolsBinding): void { this.teamModelHost.releaseBinding(original); }
  createTeam(input: Parameters<TeamHostService['createTeam']>[0]) { this.assertTeamsEnabled(); return this.teamHost.createTeam(input); }
  previewTeamMember(input: Parameters<TeamHostService['previewMember']>[0]) { this.assertTeamsEnabled(); return this.teamHost.previewMember(input); }
  joinTeamMember(input: Parameters<TeamHostService['joinMember']>[0]) { this.assertTeamsEnabled(); return this.teamHost.joinMember(input); }
  retireTeamMember(input: Parameters<TeamHostService['retireMember']>[0]) { this.assertTeamsEnabled(); return this.teamHost.retireMember(input); }
  releaseTeamMemberPreview(input: Parameters<TeamHostService['releasePreview']>[0]): void { this.teamHost.releasePreview(input); }
  sendAgentMessage(input: Parameters<TeamService['sendAgentMessage']>[0]) { this.assertTeamsEnabled(); return this.teamService.sendAgentMessage(input); }
  readAgentMailbox(input: Parameters<TeamService['readAgentMailbox']>[0]) { this.assertTeamsEnabled(); return this.teamService.readAgentMailbox(input); }
  claimAgentMailbox(input: Parameters<TeamService['claimAgentMailbox']>[0]) { this.assertTeamsEnabled(); return this.teamService.claimAgentMailbox(input); }
  releaseAgentMailboxPage(input: Parameters<TeamService['releasePage']>[0]): void { this.teamService.releasePage(input); }
  putTeamTask(input: Parameters<TeamService['putTeamTask']>[0]) { this.assertTeamsEnabled(); return this.teamService.putTeamTask(input); }
  claimTeamTask(input: Parameters<TeamService['claimTeamTask']>[0]) { this.assertTeamsEnabled(); return this.teamService.claimTeamTask(input); }
  completeTeamTask(input: Parameters<TeamService['completeTeamTask']>[0]) { this.assertTeamsEnabled(); return this.teamService.completeTeamTask(input); }
  resumeChildTurn(input: Parameters<TeamService['resumeChildTurn']>[0]) { this.assertTeamsEnabled(); return this.teamService.resumeChildTurn(input); }
  getTeam(workspaceId: string,teamId: string) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.getTeam(workspaceId,teamId)); }
  getTeamMember(workspaceId: string,teamId: string,memberId: string) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.getMember(workspaceId,teamId,memberId)); }
  listTeamMembers(workspaceId: string,teamId: string,limit?: number) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.listMembers(workspaceId,teamId,limit)); }
  getTeamTask(workspaceId: string,teamId: string,taskId: string) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.getTask(workspaceId,teamId,taskId)); }
  listTeamTasks(workspaceId: string,teamId: string,limit?: number) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.listTasks(workspaceId,teamId,limit)); }
  getTeamDelivery(workspaceId: string,id: string) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => {
    const record=this.teamRecords.getDelivery(workspaceId,id); return record ? {record,receipt:this.teamRecords.getDeliveryReceipt(workspaceId,id) ?? null} : undefined;
  }); }

  createProposalSet(input: CreateProposalSetInput) {
    try {
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      if (!this.proposalsEnabled) throw new EngineError('PROPOSALS_DISABLED', 'Creating pending proposals requires explicit host opt-in');
      return this.proposalService.create(input);
    } catch (error) { return Promise.reject(error); }
  }
  previewProposalApply(input: Parameters<ProposalApplyService['preview']>[0]) {
    try { this.assertProposalApplyEnabled(); return this.proposalApplyService.preview(input); }
    catch (error) { return Promise.reject(error); }
  }
  applyProposal(input: Parameters<ProposalApplyService['apply']>[0]) {
    try { this.assertProposalApplyEnabled(); return this.proposalApplyService.apply(input); }
    catch (error) { return Promise.reject(error); }
  }
  releaseProposalApplyPreview(preview: Parameters<ProposalApplyService['releasePreview']>[0]): void { this.proposalApplyService.releasePreview(preview); }
  getProposalApply(workspaceId: string, ownerId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.proposalApplies.getHistory(workspaceId, ownerId));
  }
  getProposalApplyRequest(workspaceId: string, requestId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.readExecutionObservationEvidence(() => this.proposalApplies.getRequest(workspaceId, requestId));
  }
  previewProposalApplyRecovery(workspaceId: string): ProposalApplyRecoveryPreview {
    this.assertProposalApplyEnabled();
    const preview = this.store.readExecutionObservationEvidence(() => this.proposalApplies.previewRecovery(workspaceId));
    this.proposalApplyRecoveryPreviews.set(preview, workspaceId); return preview;
  }
  acknowledgeProposalApplyRecovery(input: { readonly workspaceId: string; readonly requestId: string; readonly preview: ProposalApplyRecoveryPreview; readonly reason: string }) {
    return this.proposalApplyRecoveryDecision('acknowledge', input);
  }
  resumeProposalApplyRecovery(input: { readonly workspaceId: string; readonly requestId: string; readonly preview: ProposalApplyRecoveryPreview; readonly reason: string }) {
    return this.proposalApplyRecoveryDecision('resume', input);
  }
  private assertProposalApplyEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.proposalApplyEnabled) throw new EngineError('PROPOSAL_APPLY_DISABLED', 'Applying proposals requires separate explicit host opt-in');
  }
  private proposalApplyRecoveryDecision(operation: 'acknowledge' | 'resume', input: { readonly workspaceId: string; readonly requestId: string; readonly preview: ProposalApplyRecoveryPreview; readonly reason: string }) {
    try {
      this.assertProposalApplyEnabled();
      if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new EngineError('INVALID_PROPOSAL_APPLY_RECOVERY', 'Recovery requires original bounded host data');
      const fields = Object.getOwnPropertyDescriptors(input);
      if (Reflect.ownKeys(fields).length !== 4 || ['workspaceId','requestId','preview','reason'].some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))) throw new EngineError('INVALID_PROPOSAL_APPLY_RECOVERY', 'Recovery requires original bounded host data');
      const workspaceId = fields.workspaceId!.value as string, requestId = fields.requestId!.value as string,
        preview = fields.preview!.value as ProposalApplyRecoveryPreview, reason = fields.reason!.value as string;
      if (this.proposalApplyRecoveryPreviews.get(preview) !== workspaceId || typeof reason !== 'string' || !reason.trim()
        || Buffer.byteLength(reason, 'utf8') > 512 || Buffer.from(reason, 'utf8').toString('utf8') !== reason) throw new EngineError('INVALID_PROPOSAL_APPLY_RECOVERY', 'Recovery requires its original preview and bounded explicit reason');
      return this.coordinator.withRecoveryDecisionLease(workspaceId, async signal => {
        if (signal.aborted || this.hostResources.signal.aborted) throw new EngineError('ENGINE_CLOSED', 'Engine closed during proposal recovery');
        const decision = operation === 'acknowledge' ? this.proposalApplies.acknowledge(preview, { requestId, reason, approved: true })
          : this.proposalApplies.resume(preview, { requestId, reason, approved: true }); return decision;
      });
    } catch (error) { return Promise.reject(error); }
  }
  getProposalSet(workspaceId: string, proposalId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.proposalService.get(workspaceId, proposalId);
  }
  listProposalSets(input: Parameters<ProposalHostService['list']>[0]) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.proposalService.list(input);
  }
  getProposalDiff(input: Parameters<ProposalHostService['diff']>[0]) {
    try {
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      return this.proposalService.diff(input);
    } catch (error) { return Promise.reject(error); }
  }

  setWorkspaceTrust(input: Parameters<WorkspaceTrustService['set']>[0]) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    this.store.getWorkspace(input.workspaceId);
    return this.coordinator.withWorkspaceLease(input.workspaceId, async signal => { if (signal.aborted) throw signal.reason; return this.workspaceTrust.set(input); });
  }

  captureWorkspaceKnowledgeSources(workspaceId: string, selection: readonly KnowledgeSourceSelection[]) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgeHost.captureSources({ workspaceId, selection });
  }

  previewWorkspaceKnowledgeGeneration(input: { providerId: string; modelId: string; projection: KnowledgeSourceProjection; reasoningEffort?: import('@moodcode/contracts').ReasoningEffort }) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    assertKnowledgeGenerationHostInput(input, ['providerId', 'modelId', 'projection'], ['reasoningEffort']);
    this.knowledgeGenerationProvider(input.providerId);
    this.knowledgeHost.assertProjectionFresh(input.projection);
    const request = buildKnowledgeGenerationRequest({ providerId: input.providerId, modelId: input.modelId, source: input.projection,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) });
    // Store-issued generation and attempt UUIDs have this exact width; check the full envelope before native admission.
    validateHostGenerationRequest({ ...request.payload, owner: { kind: 'host-generation', workspaceId: input.projection.workspaceId,
      generationId: '00000000-0000-0000-0000-000000000000', attemptId: '00000000-0000-0000-0000-000000000000' } });
    return request;
  }

  private knowledgeGenerationProvider(providerId: string): ProviderAdapter & import('./provider/generation.js').HostGenerationProviderPort {
    if (!this.knowledgeGenerationEnabled) throw new EngineError('KNOWLEDGE_GENERATION_DISABLED', 'Host knowledge extraction requires explicit opt-in');
    const provider = this.hostGenerationProviders.get(providerId);
    if (!provider || typeof provider.streamGeneration !== 'function') throw new EngineError('KNOWLEDGE_PROVIDER_UNSUPPORTED', 'Provider does not support an independently owned tools-free generation');
    return provider as ProviderAdapter & import('./provider/generation.js').HostGenerationProviderPort;
  }

  releaseWorkspaceKnowledgeSources(projection: KnowledgeSourceProjection): void {
    this.knowledgeHost.releaseProjection(projection);
  }

  prepareWorkspaceKnowledgeGeneration(input: Omit<PrepareKnowledgeGeneration, 'binding' | 'source'> & { projection: KnowledgeSourceProjection }) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    try {
      assertKnowledgeGenerationHostInput(input, ['workspaceId', 'requestId', 'expectedTrustRevision', 'target', 'providerId', 'modelId', 'requestSha256', 'requestBytes', 'maxOutputBytes', 'expiresAt', 'projection']);
      const { projection, ...description } = input;
      this.knowledgeHost.assertProjectionFresh(projection);
      const plan = validateGenerationInput({ ...description, binding: projection.binding, source: projection.manifest });
      if (plan.workspaceId !== projection.workspaceId) throw new EngineError('KNOWLEDGE_BINDING_MISMATCH', 'Pending generation and original source projection must share the workspace');
      return this.coordinator.withWorkspaceLease(plan.workspaceId, async signal => {
        if (signal.aborted) throw signal.reason;
        this.knowledgeHost.assertProjectionFresh(projection);
        return this.workspaceKnowledge.prepareGeneration(plan);
      });
    } catch (error) { return Promise.reject(error); }
  }

  captureWorkspaceKnowledgeTarget(workspaceId: string, path: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgeHost.captureFileTarget(workspaceId, path);
  }
  captureWorkspaceKnowledgeDocumentTarget(workspaceId: string, key: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgeHost.captureDocumentTarget(workspaceId, key);
  }
  private assertKnowledgePublicationEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.knowledgePublicationEnabled) throw new EngineError('KNOWLEDGE_PUBLICATION_DISABLED', 'Workspace publication requires explicit host opt-in');
  }
  private assertKnowledgeFilePublicationEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.knowledgeFilePublicationEnabled) throw new EngineError('KNOWLEDGE_FILE_PUBLICATION_DISABLED', 'Physical knowledge publication requires explicit host opt-in');
  }
  previewWorkspaceKnowledgeFilePublication(input: Parameters<KnowledgeFilePublicationService['previewPublish']>[0]) {
    try { this.assertKnowledgeFilePublicationEnabled(); return this.knowledgeFilePublicationService.previewPublish(input); } catch (error) { return Promise.reject(error); }
  }
  previewWorkspaceKnowledgeFileRevocation(input: Parameters<KnowledgeFilePublicationService['previewRevoke']>[0]) {
    try { this.assertKnowledgeFilePublicationEnabled(); return this.knowledgeFilePublicationService.previewRevoke(input); } catch (error) { return Promise.reject(error); }
  }
  publishWorkspaceKnowledgeFile(input: Parameters<KnowledgeFilePublicationService['publish']>[0]) {
    try { this.assertKnowledgeFilePublicationEnabled(); return this.knowledgeFilePublicationService.publish(input); } catch (error) { return Promise.reject(error); }
  }
  revokeWorkspaceKnowledgeFile(input: Parameters<KnowledgeFilePublicationService['revoke']>[0]) {
    try { this.assertKnowledgeFilePublicationEnabled(); return this.knowledgeFilePublicationService.revoke(input); } catch (error) { return Promise.reject(error); }
  }
  releaseWorkspaceKnowledgeFilePublicationPreview(preview: Parameters<KnowledgeFilePublicationService['releasePreview']>[0]): void { this.knowledgeFilePublicationService.releasePreview(preview); }
  getWorkspaceKnowledgeFilePublication(workspaceId: string, id: string) { if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing'); return this.knowledgeFilePublications.getOwner(workspaceId, id); }
  getWorkspaceKnowledgeFilePublicationReceipt(workspaceId: string, requestId: string) { if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing'); return this.knowledgeFilePublications.getReceipt(workspaceId, requestId); }
  getWorkspaceKnowledgeFileTarget(workspaceId: string, path: string) { if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing'); return this.knowledgeFilePublications.getCurrentTarget(workspaceId, path); }
  previewWorkspaceKnowledgeFileRecovery(workspaceId: string) {
    this.assertKnowledgeFilePublicationEnabled();
    const preview = this.knowledgeFilePublications.previewRecovery(workspaceId); this.knowledgeFileRecoveryPreviews.set(preview, workspaceId); return preview;
  }
  acknowledgeWorkspaceKnowledgeFileRecovery(input: { workspaceId: string; requestId: string; approved: true; preview: KnowledgeFileRecoveryPreview; reason: string }) {
    return this.fileRecoveryDecision('acknowledge', input);
  }
  resumeWorkspaceKnowledgeFileAfterRecovery(input: { workspaceId: string; requestId: string; approved: true; preview: KnowledgeFileRecoveryPreview; reason: string }) {
    return this.fileRecoveryDecision('resume', input);
  }
  private fileRecoveryDecision(operation: 'acknowledge' | 'resume', input: { workspaceId: string; requestId: string; approved: true; preview: KnowledgeFileRecoveryPreview; reason: string }) {
    try {
      this.assertKnowledgeFilePublicationEnabled(); assertKnowledgeGenerationHostInput(input, ['workspaceId','requestId','approved','preview','reason']);
      const prepared = Object.freeze({ ...input }), workspaceId = this.knowledgeFileRecoveryPreviews.get(prepared.preview);
      if (!workspaceId || workspaceId !== prepared.workspaceId || prepared.approved !== true) throw new EngineError('KNOWLEDGE_FILE_RECOVERY_PREVIEW_INVALID', 'Physical recovery requires the original host preview and explicit approval');
      return this.coordinator.withRecoveryDecisionLease(workspaceId, async signal => {
        if (signal.aborted) throw signal.reason;
        const receipt = operation === 'acknowledge' ? this.knowledgeFilePublications.acknowledge(prepared) : this.knowledgeFilePublications.resume(prepared);
        this.scheduler.holdRecoveryWorkspace(workspaceId); return receipt;
      });
    } catch (error) { return Promise.reject(error); }
  }
  listWorkspaceKnowledgeFilePublications(workspaceId: string, options?: Parameters<KnowledgeFilePublicationStorage['listPublications']>[1]) { if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing'); return this.knowledgeFilePublications.listPublications(workspaceId, options); }
  previewWorkspaceKnowledgePublication(input: Parameters<KnowledgePublicationService['previewPublish']>[0]) {
    this.assertKnowledgePublicationEnabled();
    return this.knowledgePublicationService.previewPublish(input);
  }
  previewWorkspaceKnowledgeRevocation(input: Parameters<KnowledgePublicationService['previewRevoke']>[0]) {
    this.assertKnowledgePublicationEnabled();
    return this.knowledgePublicationService.previewRevoke(input);
  }
  publishWorkspaceKnowledge(input: Parameters<KnowledgePublicationService['publish']>[0]) {
    try { this.assertKnowledgePublicationEnabled(); return this.knowledgePublicationService.publish(input); }
    catch (error) { return Promise.reject(error); }
  }
  revokeWorkspaceKnowledge(input: Parameters<KnowledgePublicationService['revoke']>[0]) {
    try { this.assertKnowledgePublicationEnabled(); return this.knowledgePublicationService.revoke(input); }
    catch (error) { return Promise.reject(error); }
  }
  releaseWorkspaceKnowledgePublicationPreview(preview: Parameters<KnowledgePublicationService['releasePreview']>[0]): void {
    this.knowledgePublicationService.releasePreview(preview);
  }
  getWorkspaceKnowledgePublication(workspaceId: string, publicationId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    const publication = this.knowledgePublications.getPublication(workspaceId, publicationId);
    if (!publication) throw new EngineError('KNOWLEDGE_PUBLICATION_NOT_FOUND', 'Publication does not exist in this workspace');
    if (publication.state === 'completed') {
      const committed = this.knowledgePublications.getCommitted(workspaceId, publicationId);
      if (!committed) throw new EngineError('KNOWLEDGE_PUBLICATION_CONFLICT', 'Completed publication has no original committed receipt');
      return { ...committed, duplicate: true as const };
    }
    return { publication, document: null, head: null, receipt: null, duplicate: true as const };
  }
  getWorkspaceKnowledgePublicationRecord(workspaceId: string, publicationId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgePublications.getPublication(workspaceId, publicationId);
  }
  getWorkspaceKnowledgeDocument(workspaceId: string, key: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgePublications.getCurrentDocument(workspaceId, key);
  }
  getWorkspaceKnowledgeDocumentRevision(workspaceId: string, revisionId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgePublications.getDocumentRevision(workspaceId, revisionId);
  }
  getWorkspaceKnowledgePublicationReceipt(workspaceId: string, requestId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgePublications.getReceipt(workspaceId, requestId);
  }
  listWorkspaceKnowledgePublications(workspaceId: string, options: Parameters<KnowledgePublicationStorage['listPublications']>[1] = {}) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgePublications.listPublications(workspaceId, options);
  }
  listWorkspaceKnowledgeDocumentRevisions(workspaceId: string, key: string, options: Parameters<KnowledgePublicationStorage['listDocumentRevisions']>[2] = {}) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgePublications.listDocumentRevisions(workspaceId, key, options);
  }

  generateWorkspaceKnowledge(input: WorkspaceKnowledgeGenerationInput) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    return this.knowledgeGenerationService.generate(input);
  }

  getWorkspaceKnowledgeGeneration(workspaceId: string, generationId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgeGenerationService.get(workspaceId, generationId);
  }

  finishWorkspaceKnowledgeCandidate(input: { workspaceId: string; generationId: string; requestId: string }) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    if (!this.knowledgeGenerationEnabled) return Promise.reject(new EngineError('KNOWLEDGE_GENERATION_DISABLED', 'Host knowledge extraction requires explicit opt-in'));
    return this.knowledgeGenerationService.finish(input);
  }

  cancelWorkspaceKnowledgeGeneration(workspaceId: string, generationId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.knowledgeGenerationService.cancel(workspaceId, generationId);
  }

  getWorkspaceKnowledgeRecoveryPreview(workspaceId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    const preview = this.knowledgeGenerations.getRecoveryPreview(workspaceId);
    this.knowledgeRecoveryPreviews.set(preview, workspaceId);
    return preview;
  }

  acknowledgeWorkspaceKnowledgeRecovery(input: { preview: KnowledgeGenerationRecoveryPreview; requestId: string; reason: string; acknowledged: true }) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    try {
      assertKnowledgeGenerationHostInput(input, ['preview', 'requestId', 'reason', 'acknowledged']);
      const { preview, requestId, reason, acknowledged } = input;
      const workspaceId = this.knowledgeRecoveryPreviews.get(preview);
      if (!workspaceId || acknowledged !== true) throw new EngineError('KNOWLEDGE_RECOVERY_PREVIEW_INVALID', 'Recovery requires the original host preview and explicit acknowledgment');
      return this.coordinator.withRecoveryDecisionLease(workspaceId, async signal => {
        if (signal.aborted) throw signal.reason;
        verifyExecutionIdle(this.executionLockPath);
        const receipt = this.knowledgeGenerations.acknowledgeRecovery(preview, { requestId, reason });
        this.scheduler.holdRecoveryWorkspace(workspaceId);
        return receipt;
      });
    } catch (error) { return Promise.reject(error); }
  }

  resumeWorkspaceKnowledge(input: { workspaceId: string; requestId: string; expectedRevision: number; expectedFrontierSha256: string }) {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    try {
      assertKnowledgeGenerationHostInput(input, ['workspaceId', 'requestId', 'expectedRevision', 'expectedFrontierSha256']);
      const prepared = Object.freeze({ ...input });
      return this.coordinator.withRecoveryDecisionLease(prepared.workspaceId, async signal => {
        if (signal.aborted) throw signal.reason;
        verifyExecutionIdle(this.executionLockPath);
        if (this.store.hasUncertainSummaries(prepared.workspaceId) || this.store.hasUncertainExecution(prepared.workspaceId)) throw new EngineError('CLEANUP_PENDING', 'Other workspace producers still require independent recovery');
        const receipt = this.knowledgeGenerations.resumeWorkspace(prepared);
        this.scheduler.holdRecoveryWorkspace(prepared.workspaceId);
        return receipt;
      });
    } catch (error) { return Promise.reject(error); }
  }

  private refreshToolScopes(): void {
    this.toolRuntime.setIncludedScopes('engine', [...this.plugins.list().map(plugin => plugin.scopeId), ...[...this.mcp.values()].map(connection => connection.scopeId)]);
  }

  async activatePlugin(plugin: EnginePlugin, signal?: AbortSignal): Promise<ActivePlugin> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    const active = await this.plugins.activate(plugin, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    try { this.refreshToolScopes(); return active; }
    catch (error) { await this.plugins.deactivate(active.id); throw error; }
  }

  async deactivatePlugin(id: string): Promise<void> { await this.plugins.deactivate(id); this.refreshToolScopes(); }

  async connectMcp(client: McpClient, signal?: AbortSignal): Promise<{ id: string; scopeId: string; toolNames: string[]; resources: McpRegistration['resources'] }> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (this.mcp.has(client.id) || this.pendingMcp.has(client.id)) throw new EngineError('MCP_ALREADY_CONNECTED', 'MCP ID is already connected or connecting');
    if (this.mcp.size + this.pendingMcp.size >= 32) throw new EngineError('MCP_CONNECTION_LIMIT', 'Too many engine MCP connections');
    const pending = registerMcp(client, this.toolRuntime, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    this.mcpClients.set(client.id, client);
    this.pendingMcp.set(client.id, pending);
    let connection: McpRegistration | undefined;
    try {
      connection = await pending;
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine closed during MCP connection');
      this.mcp.set(client.id, connection); this.refreshToolScopes();
      return { id: client.id, scopeId: connection.scopeId, toolNames: connection.tools.map(tool => tool.name), resources: structuredClone(connection.resources) };
    } catch (error) { this.mcp.delete(client.id); this.mcpClients.delete(client.id); if (connection) await connection.close(); else await client.close(); throw error; }
    finally { this.pendingMcp.delete(client.id); }
  }

  async disconnectMcp(id: string): Promise<void> {
    const connection = this.mcp.get(id); if (!connection) return;
    this.mcp.delete(id); this.mcpClients.delete(id); this.refreshToolScopes(); await connection.close();
  }

  integrityCheck(): IntegrityCheckResult {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.integrityCheck();
  }

  /** Session-bound, bounded host observation; summaries are separate from ordinary Attempts. */
  getAttemptCleanup(sessionId: string, attemptId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    this.store.getSession(sessionId);
    return this.store.getAttemptCleanup(attemptId, sessionId);
  }

  /** Exact session-bound MCP receipt observation; it grants no retry or recovery authority. */
  getMcpExecution(sessionId: string, toolCallId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    this.store.getSession(sessionId);
    return this.store.getMcpExecution(toolCallId, sessionId);
  }

  getSummaryAttempt(sessionId: string, summaryAttemptId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    this.store.getSession(sessionId);
    return this.store.getSummaryAttempt(summaryAttemptId, sessionId);
  }

  getSummaryUsage(sessionId: string, summaryAttemptId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    this.store.getSession(sessionId);
    return this.store.getSummaryUsage(summaryAttemptId, sessionId);
  }

  listSummaryAttempts(sessionId: string, options?: SummaryAttemptListOptions) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.listSummaryAttempts(sessionId, options);
  }

  /** Host preview only; it never confirms cleanup, replays providers or changes session control. */
  getSummaryRecoveryPreview(sessionId: string, summaryAttemptId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.getSummaryRecoveryPreview(sessionId, summaryAttemptId);
  }

  acknowledgeSummaryRecovery(request: SummaryRecoveryRequest): Promise<SummaryRecoveryReceipt> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    try {
      const prepared = validateSummaryRecoveryRequest(request);
      const existing = this.store.findSummaryRecoveryReceipt(prepared);
      if (existing) return Promise.resolve(existing);
      const session = this.store.getSession(prepared.sessionId);
      return this.coordinator.withSummaryRecoveryLease(session.workspaceId, async signal => {
        if (signal.aborted) throw signal.reason ?? new EngineError('ENGINE_CLOSED', 'Summary recovery decision was cancelled');
        verifyExecutionIdle(this.executionLockPath);
        const receipt = this.store.acknowledgeSummaryRecovery(prepared);
        this.scheduler.holdSummaryRecoveryWorkspace(session.workspaceId);
        return receipt;
      });
    } catch (error) { return Promise.reject(error); }
  }

  getProviderRecoveryPreview(sessionId: string, attemptId: string) {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    return this.store.getProviderRecoveryPreview(sessionId, attemptId);
  }

  acknowledgeProviderRecovery(request: ProviderRecoveryRequest): Promise<ProviderRecoveryReceipt> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    try {
      const prepared = validateProviderRecoveryRequest(request), existing = this.store.findProviderRecoveryReceipt(prepared);
      if (existing) return Promise.resolve(existing);
      const session = this.store.getSession(prepared.sessionId);
      return this.coordinator.withRecoveryDecisionLease(session.workspaceId, async signal => {
        if (signal.aborted) throw signal.reason ?? new EngineError('ENGINE_CLOSED', 'Provider recovery decision was cancelled');
        verifyExecutionIdle(this.executionLockPath);
        const receipt = this.store.acknowledgeProviderRecovery(prepared);
        this.scheduler.holdRecoveryWorkspace(session.workspaceId);
        return receipt;
      });
    } catch (error) { return Promise.reject(error); }
  }

  backup(destination: string, options?: StoreBackupOptions): Promise<DatabaseBackup> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    return this.store.backup(destination, options);
  }

  /** Explicit host observation. Never scans files as a side effect of a model turn. */
  async getStorageUsage(options: EngineStorageUsageOptions = {}): Promise<EngineStorageUsageReport> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['signal', 'limits'].includes(key))) throw new EngineError('INVALID_STORAGE_USAGE_OPTIONS', 'Storage inspection accepts only signal and bounded limits');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new EngineError('INVALID_STORAGE_USAGE_OPTIONS', 'Storage inspection requires an AbortSignal');
    const signal = options.signal === undefined ? this.hostResources.signal : AbortSignal.any([options.signal, this.hostResources.signal]);
    const imageIndex = this.store.inspectInputImageIndex({ signal });
    const documentIndex = this.store.inspectInputDocumentIndex({ signal });
    const operation = inspectEngineStorage({ ...this.storagePaths, signal, ...(options.limits === undefined ? {} : { limits: options.limits }), imageIndex, documentIndex });
    this.pendingStorage.add(operation);
    try { return await operation; } finally { this.pendingStorage.delete(operation); }
  }

  /** Explicit bounded index observation of selected, durably bound managed children. */
  async getChildDocumentStorageUsage(value: EngineChildDocumentStorageOptions): Promise<EngineChildDocumentStorageReport> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    const options = validateChildDocumentStorageRequest(value);
    const signal = options.signal === undefined ? this.hostResources.signal : AbortSignal.any([options.signal, this.hostResources.signal]);
    const operation = (async () => {
      const { maxReportBytes: _maxReportBytes, ...readLimits } = options.limits;
      const frame = createChildDocumentReadFrame({ signal, limits: readLimits });
      frame.check();
      this.verifyChildStorageIdentity();
      const sources = this.store.inspectChildDocumentStorageSources({
        sessionId: options.sessionId, sourceRunId: options.sourceRunId, taskIds: options.taskIds,
        hostIdentity: this.childStorageIdentity, childrenDirectory: this.children.getStorageDirectory(), signal,
      }, frame);
      const report = await inspectChildDocumentStorage({ ...sources, frame, limits: options.limits });
      if (signal.aborted) throw new EngineError('CANCELLED', 'Child storage inspection was cancelled');
      this.verifyChildStorageIdentity();
      return report;
    })();
    this.pendingStorage.add(operation);
    try { return await operation; }
    catch (error) {
      if (signal.aborted) throw new EngineError('CANCELLED', 'Child storage inspection was cancelled');
      throw error;
    } finally { this.pendingStorage.delete(operation); }
  }

  importImage(sessionId: string, data: Uint8Array, mimeType: InputImageAttachment['mimeType'], signal?: AbortSignal): Promise<InputImageAttachment> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const operation = this.images.import(sessionId, data, mimeType, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    this.pendingImages.add(operation);
    void operation.then(() => this.pendingImages.delete(operation), () => this.pendingImages.delete(operation));
    return operation;
  }

  /** Host-only bounded import. References carry no path, filename or raw bytes. */
  importDocument(sessionId: string, data: Uint8Array, signal?: AbortSignal): Promise<InputDocumentAttachment> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const operation = this.documents.import(sessionId, data, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    this.pendingImages.add(operation);
    void operation.then(() => this.pendingImages.delete(operation), () => this.pendingImages.delete(operation));
    return operation;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closePromise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void (async () => {
      try {
        this.hostResources.abort();
        this.questions.close();
        this.teamService.close();
        this.teamModelHost.close();
        this.teamHost.close();
        // Both calls synchronously stop admissions before either awaits active work.
        const outcomes = await Promise.allSettled([this.backendHost.close(), this.scheduleDispatcher.close(), this.workflowService.close(), this.proposalApplyService.close(), this.proposalService.close(), this.proposalOverlay.close(), this.knowledgeImportService.close(), this.knowledgeFilePublicationService.close(), this.scheduler.close(), this.coordinator.close(), this.children.close(), this.changes.close(), this.lsp.close(), ...this.watchConsumers.values(), ...[...this.pendingRepository].map(operation => operation.catch(() => {})), ...[...this.pendingImages].map(operation => operation.catch(() => {})), ...[...this.pendingStorage].map(operation => operation.catch(() => {})), this.terminals.close(), this.plugins.close(), ...[...this.mcpClients.values()].map(client => client.close()), ...[...this.mcp.keys()].map(id => this.disconnectMcp(id)), ...[...this.pendingMcp.values()].map(pending => pending.catch(() => {}))]);
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      finally {
        await this.executionObserver.close();
        try { this.terminalJournal.close(); }
        finally { try { this.reviewJournal.close(); }
        finally { this.backendProducer.close(); this.scheduleProducer.close(); await this.store.closeAsync(); }
        }
      }
    })().then(resolve, reject);
    return this.closePromise;
  }
}

export function createEngine(options: EngineOptions): MoodcodeEngine { return new MoodcodeEngine(options); }
