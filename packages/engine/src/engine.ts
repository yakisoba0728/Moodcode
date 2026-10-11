import {COMMAND_LIFETIME_TOOLS,CommandLifetimeService,createCommandLifetimeTools} from './jobs/command-lifetime.js';
import {EffectBatchHost} from './effect-batches/host.js';
import {CodeModeHost, createExecuteCodeTool} from './code-mode/host.js';
import { plainRecord } from './shared/data.js';
import { PrFeedbackHost } from './pr-feedback/host.js';
import {EngineHostCommandDeliveryProducer} from './jobs/host-command-delivery-producer.js';
import {EngineHostCommandDeliverySource} from './jobs/host-command-delivery-source.js';
import type {EngineCommandDeliveryProducer} from './jobs/command-delivery-input.js';
import type {CommandDeliveryTargetProof} from './jobs/command-delivery-records.js';
import {HostCommandDelivery} from './jobs/host-command-delivery.js';
import {CommandJobModelHost,createCommandJobModelTools,type BindCommandJobModelToolsInput} from './jobs/command-model-tools.js';
import {captureCommandReadSource} from './jobs/command-read-sources.js';

import { CodingBatchHost } from "./coding-runs/batch-host.js";
import { WorkflowEffects } from "./workflows/effects.js";
import { WorkflowModelTools } from "./workflows/model-tools.js";
import {SandboxHost} from './sandbox/host.js';
import type {PreviewSandboxGrantInput,ApproveSandboxGrantInput} from './sandbox/types.js';
import { TeamWorkflowBoard, assertTeamTaskReviewAccepted } from './teams/workflow-board.js';
import { assertResidentProviderDispatch } from './child-tasks/resident.js';
import { HostCommandService } from './jobs/host-command-service.js';
import { GitCommitHost } from './git/commit-host.js';
import { ConversationForkHost } from './sessions/fork-host.js';
import type { CaptureForkPreviewInput, ForkCommitInput } from './sessions/fork-types.js';
import { constants, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineError, SCHEMA_VERSION, SESSION_SCHEMA_VERSION, type CommandEnvelope, type CommandResult, type EngineCapabilities, type EngineEvent, type InputDocumentAttachment, type InputImageAttachment, type InputMediaAttachment, type InputMediaSegment, type ReasoningEffort, type Run, type RunConfig, type SessionCommandResult, type SessionEventV2, type ToolCallRecord } from '@moodcode/contracts';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';
import type { PreparedTool, ProviderAdapter, RunParticipant, ToolContext, ToolDefinition } from './ports.js';
import { SqliteStore, type DatabaseBackup, type IntegrityCheckResult, type StoreBackupOptions } from './storage/index.js';
import type { SummaryAttemptListOptions } from './storage/summary-attempts.js';
import { RunCoordinator } from './runner/index.js';
import type { VerificationController } from './verification/controller.js';
import type { KnowledgeStorage } from './knowledge/store.js';
import type { KnowledgeSourceProjection, KnowledgeSourceSelection } from './knowledge/host.js';
import type { PrepareKnowledgeGeneration } from './knowledge/types.js';
import { knowledgeHash } from './knowledge/validation.js';
import type { WorkspaceKnowledgeGenerationInput } from './knowledge/generation-service.js';
import type { KnowledgeGenerationRecoveryPreview } from './knowledge/generation-types.js';
import type { KnowledgePublicationStorage } from './knowledge/publication-store.js';
import type { KnowledgePublicationService } from './knowledge/publication-service.js';
import type { KnowledgeFilePublicationService } from './knowledge/file-publication-service.js';
import type { KnowledgeFilePublicationStorage } from './knowledge/file-publication-store.js';
import type { KnowledgeFileRecoveryPreview } from './knowledge/file-publication-types.js';
import type { KnowledgeImportRecoveryService } from './knowledge/import-recovery-service.js';
import type { ProposalHostService, CreateProposalSetInput } from './proposals/host.js';
import type { ProposalApplyRecoveryPreview } from './proposals/apply-types.js';
import type { ProposalApplyService } from './proposals/apply-service.js';
import type { WorkspaceTrustService } from './workspace/trust.js';
import type { LifecycleHookRegistry, LifecycleHookRegistration } from './lifecycle/index.js';
import { exportTrajectory, validateTrajectoryOptions, type JournalProjection, type TrajectoryOptions } from './diagnostics/trajectory.js';
import { createCodingEvidenceManifest, validateCodingEvidenceOptions, type CodingEvidenceManifest, type CodingEvidenceOptions } from './diagnostics/attempt-manifest.js';
import { getTrajectoryStallObservation, type StallObservation, type StallOptions } from './diagnostics/stall.js';
import { EngineExecutionObserver } from './diagnostics/execution-observer.js';
import { WorkspaceExecutionSource } from './diagnostics/execution-source.js';
import type { DiagnosticExecutionPageOptions } from './diagnostics/execution-observation-types.js';
import { readNativeCodingEvidence, type NativeCodingEvidenceOptions } from './diagnostics/native-attempt-manifest.js';
import { InputScheduler } from './runner/input-scheduler.js';
import { waitChildProviderAdmission } from './child-tasks/provider-admission.js';
import { bindChildTeamModelCatalogue, consumeChildTeamModelCatalogue } from './teams/model-tool-catalogue.js';
import { EngineTeamModelToolHost, type BindTeamModelToolsInput, type TeamModelToolsBinding } from './teams/model-tool-host.js';
import { createTeamModelTools, TEAM_MODEL_TOOL_NAMES } from './teams/model-tools.js';
import { ApprovalManager } from './permission/index.js';
import { ContextService } from './context/service.js';
import { createReadTools } from './tools/read/index.js';
import { createPatchTool } from './tools/patch/index.js';
import { createCommandTool } from './tools/command/index.js';
import type { CommandExecutionCompletion } from './tools/command/observation.js';
import { commandBackendCapability } from './tools/command/backends.js';
import { createExactEditTool } from './tools/edit/index.js';
import { createFileActionTools } from './tools/file-actions/index.js';
import { createPatternSearchTools } from './tools/search/index.js';
import { declaredToolRegistration, ScopedToolRuntime, type ToolRegistrationCapture } from './tools/runtime/index.js';
import type { RoleResourcePolicySnapshot } from './permission/role-resources.js';
import type { RoleResourcePolicyRegistry } from './permission/role-policy-registry.js';
import { readPolicyDecisionReceipts, type PolicyDecisionReceiptPage } from './permission/decision-receipts.js';
import { createToolDiscoveryTool } from './runner/tool-discovery.js';
import { ToolPolicy } from './permission/policy.js';
import { ScopedToolGrants } from './permission/grants.js';
import { QuestionManager } from './questions/index.js';
import { SessionTaskService } from './session-state/index.js';
import { createSessionTaskTools } from './tools/session/index.js';
import { createQuestionTool } from './tools/session/question.js';
import { createLocalReferenceTools } from './tools/session/skills.js';
import { createArtifactReadTool } from './tools/session/artifact.js';
import { ArtifactStore } from './artifacts/store.js';
import { EnginePluginManager, type EnginePlugin, type ActivePlugin } from './plugins/index.js';
import { McpClient, registerMcp, type McpRegistration } from './mcp/index.js';
import { AgentProfiles } from './agents/index.js';
import { TerminalService, SqliteTerminalJournal } from './terminals/index.js';
import { EngineChildren, type EngineChildRequest } from './child-tasks/engine-host.js';
import type { EngineRuntime } from './engine-runtime.js';
import { EngineTeamOwners } from './teams/engine-owners.js';
import { EngineWorkflowOwners } from './workflows/engine-owner.js';
import { WorkflowHost } from './workflows/host.js';
import { WorkflowService } from './workflows/service.js';
import type { WorkflowStorage } from './workflows/store.js';
import { EngineScheduleProducer } from './schedules/engine-producer.js';
import { ScheduleHost } from './schedules/host.js';
import { ScheduleDispatcher } from './schedules/dispatcher.js';
import type { ScheduleStorage } from './schedules/store.js';
import { EngineAgentBackendProducer, type CaptureAgentBackendTarget } from './agent-backends/engine-producer.js';
import { AgentBackendStorage, type RegisterAgentBackendInput, type DisableAgentBackendInput } from './agent-backends/store.js';
import { OwnedBackendProcesses } from './agent-backends/process.js';
import { AgentBackendHost } from './agent-backends/host.js';
import { EngineJobProducer } from './jobs/engine-producer.js';
import { JobHost } from './jobs/host.js';
import { JobDelivery } from './jobs/delivery.js';
import { OwnedCommandJobHost } from './jobs/owned-command-host.js';
import { OwnedCommandDelivery } from './jobs/owned-command-delivery.js';
import { EngineOwnedCommandDeliveryProducer } from './jobs/owned-command-producer.js';
import type { JobStorage } from './jobs/store.js';
import { agentBackendObject, validateAgentBackendSpec } from './agent-backends/validation.js';
import { TeamHostService } from './teams/host.js';
import { TeamService } from './teams/service.js';
import type { TeamStorage } from './teams/store.js';
import type { ChildTeamTarget, ChildTeamInputEvidence } from './child-tasks/team-bridge.js';
import { createChildMergeTool } from './child-tasks/merge.js';
import { LspManager, type LspFactory } from './lsp/index.js';
import { FormatterRegistry, createFormatTool, createLspFormatTool } from './formatters/index.js';
import { WorkspaceChangeHub, type WorkspaceChangeWatch } from './workspace/changes.js';
import { inspectExecutionLock } from './tools/command/execution-lock.js';
import { RecoveryGate } from './recovery/gate.js';
import { validateSummaryRecoveryRequest, type SummaryRecoveryRequest, type SummaryRecoveryReceipt } from './recovery/summary.js';
import { validateProviderRecoveryRequest, type ProviderRecoveryRequest, type ProviderRecoveryReceipt } from './recovery/provider.js';
import { ReviewJournal } from './review/audit.js';
import { createDelegateTaskTool } from './child-tasks/delegation.js';
import { inspectEngineStorage, type StorageUsageReport, type StorageUsageLimits } from './diagnostics/storage-usage.js';
import { validateChildDocumentStorageRequest, inspectChildDocumentStorage, type ChildDocumentStorageRequest, type ChildDocumentStorageReport } from './diagnostics/child-document-storage.js';
import { createChildDocumentReadFrame } from './storage/child-document-reader.js';
import { RepositoryContextService, type RepositoryQuery, type RepositorySnapshot } from './repository/index.js';
import { createRepositoryContextTool } from './repository/tool.js';
import type { VerificationCheckRegistry, VerificationPlanService, VerificationReceiptService, VerificationCheckRegistration } from './verification/index.js';
import type { VerificationSessionPolicy } from './verification/host.js';
import { RepositoryContextSource } from './context/repository-contributions.js';
import { EngineLifetime, EngineStorage } from './engine-kernel.js';
import { resolveEngineOptions, type EngineFeatures, type EngineOptions } from './engine-options.js';
import { EngineCommands, NATIVE_COMMANDS_ENABLED } from './engine-commands.js';
import { EngineKnowledge } from './engine-knowledge.js';
import { EngineProposals } from './engine-proposals.js';
import { EngineVerification } from './engine-verification.js';
import { WorkspaceLanguageSync } from './engine-language-sync.js';
import { EngineRestore } from './engine-restore.js';
import { EngineInputMedia } from './media/engine-input.js';

export interface EngineStorageUsageOptions { signal?: AbortSignal; limits?: Partial<StorageUsageLimits> }
export type EngineStorageUsageReport = StorageUsageReport;
export type EngineChildDocumentStorageOptions = ChildDocumentStorageRequest;
export type EngineChildDocumentStorageReport = ChildDocumentStorageReport;

export type { RestoreCommandResult, ReviewHistoryResult } from './engine-restore.js';
export type { EngineOptions } from './engine-options.js';

/** Fence order decides which error surfaces first, so promotion and provider dispatch keep their own orders. */
export const RUN_PARTICIPANT_ORDER = Object.freeze({
  promotion: ['schedule', 'job', 'ownedCommand', 'prFeedback', 'hostCommandDelivery', 'conversationFork', 'workflow'],
  dispatch: ['resident', 'sandbox', 'prFeedback', 'hostCommandDelivery', 'codingBatch', 'schedule', 'job', 'ownedCommand', 'conversationFork', 'workflow', 'commandLifetime', 'codeMode'],
} as const);

/** Own function properties that call the target's current method of the same name. */
function forward<T extends object, K extends keyof T>(target: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map(key => [key, (...args: unknown[]) => (target[key] as (...args: unknown[]) => unknown).apply(target, args)])) as Pick<T, K>;
}

function atomicPorts<S, P extends CommandDeliveryTargetProof<S>>(producer: EngineCommandDeliveryProducer<S, P>) {
  return {
    readTargetOriginal: (original: object) => producer.readTarget(original),
    assertTarget: (original: object, expected: P) => producer.assertTargetCurrent(original, expected),
    acceptAtomic: (original: object, request: { inputRequestId: string; prompt: string }) => producer.acceptAtomic(original, request),
    readAccepted: (original: object) => producer.readAccepted(original),
    releaseAccepted: (original: object) => producer.release(original),
  };
}

export class MoodcodeEngine implements EngineRuntime {
  readonly store: SqliteStore;
  readonly coordinator: RunCoordinator;
  readonly scheduler: InputScheduler;
  readonly toolRuntime: ScopedToolRuntime;
  readonly approvals: ApprovalManager;
  readonly questions: QuestionManager;
  readonly tasks: SessionTaskService;
  readonly context: ContextService;
  private readonly lifetime = new EngineLifetime();
  private readonly enabled: EngineFeatures;
  private readonly storage: EngineStorage;
  private readonly ownedArtifactDir: string | undefined;
  private readonly media: EngineInputMedia;
  private readonly knowledge: EngineKnowledge;
  private readonly proposals: EngineProposals;
  private readonly verification: EngineVerification;
  private readonly languageSync: WorkspaceLanguageSync;
  private readonly restorer: EngineRestore;
  private readonly commands: EngineCommands;
  private readonly executionObserver: EngineExecutionObserver;
  private readonly managedArtifacts: () => Promise<ArtifactStore>;
  readonly plugins: EnginePluginManager;
  readonly profiles: AgentProfiles;
  readonly terminals: TerminalService;
  readonly children: EngineChildren;
  /** Built-in tools a child engine provides itself; it never adopts another scope's MCP or plugin tools. */
  readonly childToolNames: readonly string[];
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
  private readonly teamRecords: TeamStorage;
  private readonly teamHost: TeamHostService;
  private readonly teamService: TeamService;
  private readonly commandJobModelHost: CommandJobModelHost;
  private readonly commandJobModelDefinitions: readonly ToolDefinition[];
  private readonly teamModelHost: EngineTeamModelToolHost;
  private readonly teamModelDefinitions: readonly ToolDefinition[];
  private readonly codingBatches: CodingBatchHost;
  private codingBatchDispatchGuard?: () => void;
  private codingBatchCharge?: () => void;
  private readonly workflowRecords: WorkflowStorage;
  private readonly workflowHost: WorkflowHost;
  private readonly workflowService: WorkflowService;
  private readonly workflowEffects:WorkflowEffects;
  private readonly workflowModelTools:WorkflowModelTools;
  private readonly scheduleRecords: ScheduleStorage;
  private readonly scheduleProducer: EngineScheduleProducer;
  private readonly scheduleDispatcher: ScheduleDispatcher;
  private readonly backendProducer: EngineAgentBackendProducer;
  private readonly backendRecords: AgentBackendStorage;
  private readonly backendProcesses: OwnedBackendProcesses;
  private readonly backendHost: AgentBackendHost;
  private readonly codeModeHost:CodeModeHost;
  private readonly conversationForkHost: ConversationForkHost;
  private readonly jobProducer: EngineJobProducer;
  private readonly jobRecords: JobStorage;
  private readonly jobHost: JobHost;
  private readonly jobDelivery: JobDelivery;
  private readonly ownedCommandHost: OwnedCommandJobHost;
  private readonly hostCommands: HostCommandService;
  private readonly commandLifetimes: CommandLifetimeService;
  private readonly hostCommandDeliverySource: EngineHostCommandDeliverySource;
  private readonly hostCommandDeliveryProducer: EngineHostCommandDeliveryProducer;
  private readonly hostCommandDelivery: HostCommandDelivery;
  private readonly sandboxHost:SandboxHost;
  private readonly ownedCommandProducer: EngineOwnedCommandDeliveryProducer;
  private readonly ownedCommandDelivery: OwnedCommandDelivery;
  private readonly runtimeProviders: Map<string, ProviderAdapter>;
  private readonly backendProviderIds = new Set<string>();
  readonly formatters: FormatterRegistry;
  readonly changes: WorkspaceChangeHub;
  private readonly terminalJournal: SqliteTerminalJournal;
  private readonly mcp = new Map<string, McpRegistration>();
  private readonly pendingMcp = new Map<string, Promise<McpRegistration>>();
  private readonly mcpClients = new Map<string, McpClient>();
  readonly reviewJournal: ReviewJournal;
  private closePromise?: Promise<void>;
  private readonly defaults: RunConfig;
  private readonly hostAllowedTools?: readonly string[];
  private readonly capabilities: Omit<EngineCapabilities, 'providerIds' | 'tools'>;
  private readonly gitCommitHost: GitCommitHost;
  private readonly prFeedbackHost: PrFeedbackHost;
  private readonly executionLockPath: string;
  private readonly recoveryGate: RecoveryGate;

  constructor(options: EngineOptions) {
    const resolved = resolveEngineOptions(options);
    const { repositoryPolicy, knowledgePolicy, proposalPolicy, mediaHistoryPolicy, activePrefixPolicy, documentHistoryPolicy, toolDiscoveryPolicy } = resolved;
    this.enabled = resolved.enabled;
    this.lifecycleHooks = resolved.lifecycleHooks;
    this.roleResourcePolicyRegistry = options.roleResourcePolicyRegistry;
    this.defaults = resolved.defaults;
    const dbPath = options.dbPath === ':memory:' ? options.dbPath : resolve(options.dbPath);
    this.ownedArtifactDir = options.artifactDir === undefined && dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'moodcode-memory-artifacts-')) : undefined;
    const artifactDir = options.artifactDir !== undefined ? resolve(options.artifactDir) : this.ownedArtifactDir ?? resolve(`${options.dbPath}.artifacts`);
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    let store: SqliteStore | undefined;
    let reviewJournal: ReviewJournal | undefined;
    let terminalJournal: SqliteTerminalJournal | undefined;
    try {
      this.store = store = new SqliteStore(dbPath, this.defaults.budgets);
      const storage = this.storage = new EngineStorage(store, dbPath, artifactDir);
      const knowledgeBinding = storage.knowledgeBinding;
      this.executionLockPath = storage.executionLockPath;
      this.recoveryGate = new RecoveryGate({ store: this.store, executionLockPath: this.executionLockPath, closed: this.lifetime.signal,
        lease: (workspaceId, operation) => this.coordinator.withRecoveryDecisionLease(workspaceId, operation), hold: workspaceId => this.scheduler.holdRecoveryWorkspace(workspaceId) });
      const profileIdentity = (run: Run) => this.profiles.pinForRun(run.sessionId, run.config);
      this.knowledge = new EngineKnowledge(store, storage, this.recoveryGate, this.lifetime, this.enabled, this, () => this.runtimeProviders);
      this.workspaceKnowledge = this.knowledge.records;
      this.proposals = new EngineProposals(store, storage, this.recoveryGate, this.lifetime, this.enabled, this, this.knowledge.records, profileIdentity);
      this.workspaceTrust = this.knowledge.trust;
      storage.bindRecovery();
      const interruptedFileOwners: string[] = [];
      try { this.recoveryGate.assertIdle(); }
      catch (error) { const known = this.knowledge.fileGuards.matching(this.executionLockPath);
        if (known) interruptedFileOwners.push(known.publicationId); else if (!this.proposals.applyGuards.matching(this.executionLockPath)) {
          const marker = inspectExecutionLock(this.executionLockPath);
          // A native Windows owner crash leaves its marker active after the job
          // handle has closed. Permit inspection of the exactly bound journal;
          // recovery retains uncertainty and every execution gate keeps the
          // active marker. This does not confirm cleanup or authorize replay.
          const knownWindowsHost = process.platform === 'win32' && marker.status === 'uncertain' &&
            this.store.createHostCommandStorage().hasKnownWindowsExecutionMarker(marker.marker, this.executionLockPath,
              workspaceId => knowledgeHash(knowledgeBinding(workspaceId)));
          if (marker.status !== 'uncertain' || !knownWindowsHost && !this.store.hasKnownGitCommitSupervisor(marker.marker.ownerPid) &&
            !this.store.hasKnownEffectBatchMarker(marker.marker, this.executionLockPath)) throw error;
        } }
      reviewJournal = new ReviewJournal(storage.reviewJournalPath);
      this.reviewJournal = reviewJournal;
      this.store.recoverInterrupted();
      this.store.validateGitCommits();
      this.store.createGitCommitStorage().recover();
      this.knowledge.generations.recoverInterruptedOwners();
      this.knowledge.publications.recoverInterruptedOwners();
      this.knowledge.filePublications.recoverInterruptedOwners(interruptedFileOwners);
      this.proposals.applies.recoverInterruptedOwners();
      this.approvals = new ApprovalManager(this.store);
      this.questions = new QuestionManager(this.store);
      this.tasks = new SessionTaskService(this.store);
      this.profiles = new AgentProfiles(this.store, options.agentProfiles);
      this.lsp = new LspManager();
      this.formatters = new FormatterRegistry();
      this.changes = new WorkspaceChangeHub({ signal: this.lifetime.signal });
      this.languageSync = new WorkspaceLanguageSync(store, this.lsp, this.changes, this.lifetime);
      this.repository = new RepositoryContextService(this.lsp, path => this.languageSync.route(path));
      this.verification = new EngineVerification(store, this.repository, this.profiles, this, tools => this.allowedTools(tools), this.lifetime, this.enabled.verification);
      this.verificationChecks = this.verification.checks;
      this.verificationPlans = this.verification.plans;
      this.verificationReceipts = this.verification.receipts;
      this.verificationController = this.verification.controller;
      this.children = new EngineChildren(this, { ...options, ...(repositoryPolicy ? { repositoryContextPolicy: repositoryPolicy } : {}), ...(mediaHistoryPolicy ? { mediaHistoryPolicy } : {}), ...(activePrefixPolicy ? { activePrefixPolicy } : {}), ...(toolDiscoveryPolicy ? { toolDiscoveryPolicy } : {}) }, options.worktreeDirectory ?? join(this.storage.paths.artifactDir, 'children'), value => {
        bindChildTeamModelCatalogue(value, this.teamModelDefinitions);
        return new MoodcodeEngine(value);
      }, this.storage.identity, (child,sessionId,parent,parentRunId,allocation)=>{this.conversationForkHost.inheritChild(parent,child,sessionId,parentRunId,allocation);if(options.osSandbox)parent.sandboxHost.inherit(child.sandboxHost,sessionId,parentRunId);});
      const teamOwners = new EngineTeamOwners(this);
      this.teamRecords = this.store.createTeamStorage({ checkBinding: knowledgeBinding,
        readMemberOwner: original => this.teamHost.readMemberOwner(original),
        assertMemberOwnerCurrent: (original, member) => this.teamHost.assertMemberOwnerCurrent(original,member),
        assertRecipientCurrent: member => this.teamHost.assertRecipientCurrent(member),
        readAcceptedInput: (capture, original) => this.teamService.readAcceptedInput(capture,original) });
      this.teamHost = new TeamHostService({ native: this.teamRecords, owner: teamOwners });
      const nativeTeams = this.teamRecords;
      this.teamService = new TeamService({ beforeCompleteTask: input => assertTeamTaskReviewAccepted((sessionId,kind) => this.store.getSessionDocument(sessionId,kind), nativeTeams.getMember(input.workspaceId,input.teamId,input.memberId), input), host: this.teamHost, native: {
        ...forward(nativeTeams, ['findSendRequest', 'findOperationRequest', 'getMember', 'send', 'readMailbox', 'claimMailbox', 'releasePage',
          'putTask', 'claimTask', 'completeTask', 'prepareDelivery', 'dispatchDelivery', 'completeDelivery', 'releaseDelivery']),
        cancelDelivery: capture => { nativeTeams.cancelDelivery(capture); },
        getDeliveryHistory: (workspaceId,id) => this.store.readExecutionObservationEvidence(() => nativeTeams.getDeliveryHistory(workspaceId,id)),
      }, input: {
        capture: (sessionId,taskId) => this.children.teamBridge.capture(sessionId,taskId),
        readTarget: original => this.children.teamBridge.readTarget(original as ChildTeamTarget),
        assertCurrent: original => this.children.teamBridge.assertCurrent(original as ChildTeamTarget),
        assertAdmissible: original => this.children.teamBridge.assertAdmissible(original as ChildTeamTarget),
        accept: (original,input) => this.children.teamBridge.accept(original as ChildTeamTarget,input),
        readAccepted: (original,accepted) => {
          const proof = this.children.teamBridge.readAccepted(original as ChildTeamTarget,accepted as ChildTeamInputEvidence);
          return { sessionId: proof.childSessionId, runId: proof.childRunId, inputId: proof.inputId,
            requestId: proof.requestId, inputSha256: proof.inputSha256, admittedSeq: proof.admittedSeq, delivery: proof.delivery };
        },
        confirmDelivery:(target,accepted)=>this.children.teamBridge.confirm(target as ChildTeamTarget,accepted as ChildTeamInputEvidence),
        release: original => this.children.teamBridge.release(original as ChildTeamTarget),
      } });
      this.teamRecords.recoverInterruptedDeliveries();
      this.store.validateResidentTeams();
      this.children.recoverResidentHistories();
      this.teamModelHost = new EngineTeamModelToolHost({ board:new TeamWorkflowBoard(this,input=>this.teamService.completeReviewedTask(input)), owner: teamOwners, service: this.teamService,
        rootSessionWorkspace: sessionId => this.store.getSession(sessionId).workspaceId,
        getTeam: (workspaceId,teamId) => nativeTeams.activeTeam(workspaceId,teamId),
        getMember: (workspaceId,teamId,memberId) => nativeTeams.getMember(workspaceId,teamId,memberId),
        getTask: (workspaceId,teamId,taskId) => nativeTeams.getTask(workspaceId,teamId,taskId),
        getCursor: (...args) => nativeTeams.cursor(...args),
        assertOwnerUnquarantined: (workspaceId,owner) => nativeTeams.assertOwnerUnquarantined(workspaceId,owner),
        resolveExecution: proof => {
          const actual = proof.kind === 'root' ? this : this.children.resolveTeamModelExecution(proof);
          return { currentRunId: proof.kind==='child'?this.children.currentTeamRunId(proof):proof.runId, store: actual.store, coordinator: actual.coordinator, executionLockPath: actual.executionLockPath, artifactDir: actual.storage.paths.artifactDir };
        }, assertEnabled: () => {
          this.assertTeamsEnabled();
          if (!this.enabled.teamModelTools) throw new EngineError('TEAM_MODEL_DISABLED', 'Model team tools require explicit host opt-in');
        },
      });
      this.teamModelDefinitions = this.enabled.teamModelTools ? createTeamModelTools(this.teamModelHost.port()) : consumeChildTeamModelCatalogue(options);
      this.commandJobModelHost=new CommandJobModelHost(this,()=>options.commandJobModelTools===true&&this.enabled.jobs&&!this.lifetime.closing,(selection,workspaceId)=>captureCommandReadSource(this,this.jobProducer,selection,workspaceId));
      this.commandJobModelDefinitions=options.commandJobModelTools===true&&this.enabled.jobs?createCommandJobModelTools(this.commandJobModelHost):[];
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
      this.workflowEffects=new WorkflowEffects(this,knowledgeBinding,()=>this.workflowService,workflowOwners,workflowChildren,!options.tools&&this.enabled.verification,this.enabled.workflows);
      const effectNative=this.store.createWorkflowEffectStorage({readEffect:o=>this.workflowEffects.readEffect(o),assertEffect:o=>this.workflowEffects.assertEffect(o),readTarget:o=>this.workflowEffects.readTarget(o),assertTarget:o=>this.workflowEffects.assertTarget(o),accept:(o,i)=>this.workflowEffects.accept(o,i)});
      this.workflowEffects.install(effectNative);
      this.workflowModelTools=new WorkflowModelTools(this,this.workflowEffects,()=>this.workflowService,workflowOwners);
      this.workflowHost = new WorkflowHost({ owner: workflowOwners, getWorkflow: (...args) => this.workflowRecords.getWorkflow(...args),assertEffectsSupported:(o,spec)=>this.workflowEffects.assertSupported(o,spec) });
      this.workflowService = new WorkflowService({
        native: this.workflowRecords,
        host: this.workflowHost,
        owner: workflowOwners,
        children: workflowChildren,
        batch: {
          reserved: (r, s) => this.codingBatches.reserved(r, s),
          dispatch: (r, s, id) => this.codingBatches.dispatch(r, s, id),
          observed: (r, s, o) => this.codingBatches.observed(r, s, o),
        },
        effects: {
          captureChild: (r, s, o) => this.workflowEffects.captureChild(r, s, o),
          commitChild: (o, r) => this.workflowEffects.commitChild(o, r),
          release: (o) => this.workflowEffects.release(o),
          transaction: (op) => this.store.withWorkflowEffectsTransaction(op),
          mergePending: (r) => this.workflowEffects.mergePending(r),
        },
      });
      this.workflowRecords.recoverInterrupted();
      this.codingBatches = new CodingBatchHost(
        this,
        this.store.createCodingBatchStorage(),
        this.workflowEffects,
        workflowChildren,
        this.enabled.codingBatches,
      );
      terminalJournal = new SqliteTerminalJournal(join(this.storage.paths.artifactDir, 'terminals.sqlite'));
      this.terminalJournal = terminalJournal;
      this.terminals = new TerminalService({ journal: terminalJournal, ...(options.ptyBackend ? { backend: options.ptyBackend } : {}), resolveOwner: owner => {
        const session = this.store.getSession(owner.sessionId);
        if (session.workspaceId !== owner.workspaceId) throw new EngineError('TERMINAL_AUTHORITY', 'Terminal session belongs to a different workspace');
        return { sessionId: session.id, workspaceId: session.workspaceId, root: this.store.getWorkspace(session.workspaceId).root };
      } });
      let artifacts: Promise<ArtifactStore> | undefined;
      const artifactBudgets = normalizeEngineBudgets(this.defaults.budgets);
      this.managedArtifacts = () => artifacts ??= ArtifactStore.open({ directory: join(realpathSync(artifactDir), 'managed'), limits: {
        maxArtifactBytes: artifactBudgets.maxArtifactBytes, maxProducerBytes: artifactBudgets.maxProducerBytes,
      } });
      this.media = new EngineInputMedia(store, storage.paths.artifactDir, options, this.lifetime, this.managedArtifacts);
      const providers = this.runtimeProviders = this.media.providers;
      const knowledgeContext = knowledgePolicy ? this.knowledge.context(knowledgePolicy, profileIdentity) : undefined;
      const proposalContext = proposalPolicy ? this.proposals.context(proposalPolicy, profileIdentity) : undefined;
      this.context = new ContextService(this.store, this.media.models, options.outputTokenReserve, id => providers.get(id), { lifecycleHooks: options.osSandbox ? undefined : this.lifecycleHooks,
        conversationFork: { prepare:(sessionId,config)=>this.conversationForkHost.context(sessionId,config), assertFresh:(sessionId,sha,config)=>this.conversationForkHost.assertContext(sessionId,sha,config) },
        ...(options.lifecycleContextSlotBytes === undefined ? {} : { lifecycleContextSlotBytes: options.lifecycleContextSlotBytes }),
        ...(mediaHistoryPolicy ? { mediaHistoryPolicy } : {}), ...(activePrefixPolicy ? { activePrefixPolicy } : {}), ...(documentHistoryPolicy ? { documentHistoryPolicy } : {}), ...(repositoryPolicy ? { repositoryContext: { source: new RepositoryContextSource(this.repository), policy: repositoryPolicy } } : {}), ...(knowledgeContext ? { knowledgeContext } : {}), ...(proposalContext ? { proposalContext } : {}) });
      if (options.toolPolicy && options.toolPolicyInstance) throw new EngineError('INVALID_TOOL_POLICY', 'Specify rules or one trusted policy instance');
      const commandObserver = (this.enabled.jobs || options.osSandbox) ? {
        beforeSpawn:(context:ToolContext,prepared:PreparedTool)=>{
          const own= this.enabled.jobs ? this.ownedCommandHost.beforeSpawn(context,prepared) : undefined;
          const sandbox= options.osSandbox ? this.sandboxHost.beforeSpawn(context,prepared) : undefined;
          return Object.freeze({own,sandbox});
        },
        started:(original:object,pid:number)=>{const x=original as {own?:object;sandbox?:object};if(x.sandbox)this.sandboxHost.started(x.sandbox,pid);if(x.own)this.ownedCommandHost.started(x.own,pid);},
        output:(original:object,stream:'stdout'|'stderr',bytes:Buffer)=>{const x=original as {own?:object;sandbox?:object};if(x.own)this.ownedCommandHost.output(x.own,stream,bytes);},
        closed:(original:object,completion:CommandExecutionCompletion)=>{const x=original as {own?:object;sandbox?:object};if(x.sandbox)this.sandboxHost.closed(x.sandbox,completion);if(x.own)this.ownedCommandHost.closed(x.own,completion);},
        failed:(original:object,error:unknown)=>{const x=original as {own?:object;sandbox?:object};if(x.sandbox)this.sandboxHost.failed(x.sandbox,error);if(x.own)this.ownedCommandHost.failed(x.own,error);},
      } : undefined;
      const coreCommand = createCommandTool({...commandObserver?{observer:commandObserver}:{},...options.osSandbox?{sandbox:(context:ToolContext)=>this.sandboxHost.launch(context)}:{}});
      const lifetimeTools = options.commandLifetimes===true?createCommandLifetimeTools(()=>this.commandLifetimes):[];
      const allCoreTools = options.tools ?? [...createReadTools(), createPatchTool(), coreCommand, ...lifetimeTools, createExactEditTool(), ...createFileActionTools(), ...createPatternSearchTools(), ...createSessionTaskTools(this.tasks), createQuestionTool(this.questions), ...createLocalReferenceTools(), createArtifactReadTool(this.store, this.managedArtifacts), createFormatTool(this.formatters), createLspFormatTool(this.lsp), createChildMergeTool(options.childTaskScope?.tasks ?? this.children.tasks, options.childTaskScope?.worktrees ?? this.children.worktrees, options.childTaskScope?.sessionId), createDelegateTaskTool(this.children.delegationHost(this.executionLockPath))];
      this.childToolNames = Object.freeze([...(options.tools ?? allCoreTools.filter(tool => tool.name !== 'delegate_task' && !lifetimeTools.includes(tool))).map(tool => tool.name), ...(this.enabled.verification ? ['verify_changes'] : []), ...(toolDiscoveryPolicy ? ['discover_tools'] : []), ...(this.enabled.teamModelTools ? TEAM_MODEL_TOOL_NAMES : [])]);
      // Effect paths with no OS-bound producer are deliberately absent from this catalogue.
      const coreTools=options.osSandbox ? allCoreTools.filter(t=>['run_command','delegate_task'].includes(t.name)) : allCoreTools;
      const source = new WorkspaceExecutionSource({ checkWorkspaceBinding: workspace => {
        this.storage.verify();
        if (JSON.stringify(this.store.getWorkspace(workspace.id)) !== JSON.stringify(workspace)) throw new EngineError('EXECUTION_OBSERVATION_STALE', 'Observed workspace binding changed');
      }, ...(options.diagnosticSourceLimits ? { limits: options.diagnosticSourceLimits } : {}), excludedPaths: [{ path: this.storage.paths.artifactDir, kind: 'directory' }, ...this.storage.nativeFiles.map(path => ({ path, kind: 'file' as const }))] });
      this.executionObserver = new EngineExecutionObserver(this.store, source, () => this.toolRuntime);
      const workspaceSourceTools = options.tools ? [] : coreTools.filter(tool => ['read_file', 'list_files', 'search_files', 'glob_files', 'regex_search', 'apply_patch', 'edit_file', 'rename_file', 'delete_file', 'run_command'].includes(tool.name));
      this.toolRuntime = new ScopedToolRuntime({ policy: options.toolPolicyInstance ?? new ToolPolicy(options.toolPolicy), grants: new ScopedToolGrants(Date.now, this.store),
        ...(process.platform === 'win32' && !constants.O_NOFOLLOW ? { artifactsUnavailable: {
          code: 'ARTIFACT_PLATFORM_UNSUPPORTED' as const,
          reason: 'Managed result copies are unavailable on this platform; only output artifacts returned by the producer can be reviewed.',
        } } : { artifacts: this.managedArtifacts }),
        workspaceSourceTools: Object.freeze(workspaceSourceTools), preparedResourceTools: options.tools ? [] : Object.freeze([...coreTools]), ...(options.diagnosticObservations === true ? { beforeProducer: (prepared, context) => this.executionObserver.beforeProducer(prepared, context) } : {}),
        ...(options.roleResourcePolicy ? { roleResources: options.roleResourcePolicy } : {}), ...(options.roleResourcePolicyRegistry ? { roleResourcePolicyRegistry: options.roleResourcePolicyRegistry } : {}), ...(options.resolveRoleResources ? { resolveRoleResources: options.resolveRoleResources } : {}), ...(options.commandPreflight ? { commandPreflight: options.commandPreflight } : {}) });
      let commandRegistration: ToolRegistrationCapture | undefined;
      const repositoryTools = options.repositoryContextTools ? [createRepositoryContextTool(this.repository)] : [];
      const verificationTools = this.enabled.verification ? [this.verification.tool(() => options.diagnosticObservations === true ? this.executionObserver : undefined, this.managedArtifacts, () => commandRegistration)] : [];
      const modelTools = [...coreTools, ...(options.codeMode ? [createExecuteCodeTool(() => this.codeModeHost)] : []), ...repositoryTools, ...this.teamModelDefinitions, ...this.commandJobModelDefinitions, ...(this.enabled.workflows ? this.workflowModelTools.tools() : [])];
      const availableTools = [...modelTools, ...(toolDiscoveryPolicy ? [createToolDiscoveryTool({
        identity: context => this.coordinator.toolDiscoveryIdentity(context),
        stage: (context, query, limit, expected, action) => this.coordinator.stageToolDiscovery(context, query, limit, expected, action),
      })] : []), ...verificationTools];
      if (options.allowedToolNames && (new Set(options.allowedToolNames).size !== options.allowedToolNames.length || options.allowedToolNames.some(name => !availableTools.some(tool => tool.name === name)))) throw new EngineError('INVALID_TOOL_ALLOWLIST', 'Host tool allowlist must name unique available tools');
      this.hostAllowedTools = options.allowedToolNames ? [...options.allowedToolNames] : undefined;
      const tools = options.allowedToolNames ? availableTools.filter(tool => options.allowedToolNames!.includes(tool.name)) : availableTools;
      for (const tool of tools) this.toolRuntime.register('engine', tool, declaredToolRegistration(tool) ?? (options.tools ? {} : { revalidate: async (prepared, context) => {
        const current = await tool.prepare(prepared.input, context);
        if (current.fingerprint !== prepared.fingerprint || JSON.stringify(current.preview) !== JSON.stringify(prepared.preview)) throw new EngineError('TOOL_APPROVAL_STALE', 'Tool resources changed since scoped authorization');
      } }));
      if (this.enabled.verification && tools.includes(coreCommand)) commandRegistration = this.toolRuntime.captureRegistration('engine', 'run_command', coreCommand);
      this.plugins = new EnginePluginManager(this.toolRuntime);
      const commandCapability = commandBackendCapability();
      this.capabilities = {
        schemaVersion: SCHEMA_VERSION,
        runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, commandExecution: commandCapability.processTree === 'windows-job-object' ? 'windows-job-object' : commandCapability.available ? 'posix-process-group' : 'unsupported' },
        modes: ['plan', 'build'], defaults: structuredClone(this.defaults),
        features: { historyPaging: true, sessionMetrics: true },
        extensions: { sessionSchemaVersions: [SESSION_SCHEMA_VERSION], commands: [...NATIVE_COMMANDS_ENABLED] },
      };
      const fences = (get: () => RunParticipant | undefined): RunParticipant => ({ beforePromotion: input => get()?.beforePromotion?.(input), beforeProviderDispatch: run => get()?.beforeProviderDispatch?.(run) });
      const settles = (names: readonly string[], get: () => { toolSettled(record: ToolCallRecord): void } | undefined) => (record: ToolCallRecord) => { if (names.includes(record.name)) get()?.toolSettled(record); };
      const participants: Record<(typeof RUN_PARTICIPANT_ORDER.dispatch)[number], RunParticipant> = {
        resident: { beforeProviderDispatch: run => assertResidentProviderDispatch(this, run) },
        sandbox: { beforeProviderDispatch: () => { if (this.enabled.sandbox && this.lifecycleHooks.list().length) throw new EngineError('SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED', 'New host lifecycle effects require a fresh supported producer'); } },
        prFeedback: fences(() => this.prFeedbackHost),
        hostCommandDelivery: fences(() => this.hostCommandDeliveryProducer),
        codingBatch: { beforeProviderDispatch: () => this.codingBatchDispatchGuard?.() },
        schedule: fences(() => this.scheduleProducer),
        job: fences(() => this.jobProducer),
        ownedCommand: { ...fences(() => this.ownedCommandProducer), toolSettled: settles(['run_command'], () => this.ownedCommandHost) },
        conversationFork: { beforePromotion: input => this.conversationForkHost.context(input.sessionId, input.config), beforeProviderDispatch: run => this.conversationForkHost.context(run.sessionId, run.config) },
        workflow: { beforePromotion: input => this.workflowEffects.beforeInput(input.id, input.requestId),
          beforeProviderDispatch: run => { for (const id of this.store.listRunInputIds(run.id)) this.workflowEffects.beforeInput(id, this.store.getInput(id).requestId, run); },
          toolSettled: settles(['merge_workflow_stage'], () => this.workflowModelTools) },
        commandLifetime: { toolSettled: settles(COMMAND_LIFETIME_TOOLS, () => this.commandLifetimes) },
        codeMode: { toolSettled: settles(['execute_code'], () => this.codeModeHost) },
      };
      this.coordinator = new RunCoordinator({
        ...(options.effectBatches===true?{effectBatches:new EffectBatchHost({save:record=>this.store.writeEffectBatch(record),memberSettled:(record,index)=>this.store.recordEffectBatchMember(record,index),assertOpen:()=>{if(this.lifetime.closing)throw new EngineError('ENGINE_CLOSED','Effect batch host closed');this.storage.verify();}})}:{}),
        onCommandLifetimesSettling:(runId,outcome)=>this.commandLifetimes?.runSettling(runId,outcome)??Promise.resolve(),
        participants: RUN_PARTICIPANT_ORDER.dispatch.map(name => participants[name]),
        beforeActualProviderRequest: (original) => {
          if (this.codingBatchCharge) {
            this.coordinator.assertProviderRequest(original, "dispatch");
            this.codingBatchCharge();
          }
        },
        onRunStarted: async (run, signal) => {
          const admission = waitChildProviderAdmission(this, signal);
          if (admission) await admission;
          if (signal.aborted)
            throw (
              signal.reason ??
              new EngineError("CANCELLED", "Run initialization was cancelled")
            );
          if (this.enabled.verification)
            await this.verification.host.start(run, signal);
        },
        ...(options.diagnosticObservations === true
          ? { executionObserver: this.executionObserver }
          : {}),
        ...this.verification.coordinatorHooks(options.lifecycleContinuation === true),
        lifecycleHooks: options.osSandbox ? undefined : this.lifecycleHooks,
        store: this.store,
        providers, providerArtifacts:this.managedArtifacts,
        tools,
        approvals: this.approvals,
        artifactDir,
        executionLockPath: this.executionLockPath,
        buildContext: (request) =>
          this.context.build({
            ...request,
            agentInstructions: this.profiles.forRun(
              request.snapshot.session.id,
              request.config,
            )?.instructions,
          }),
        contextSnapshot: (sessionId, config) =>
          this.context.snapshot(sessionId, config),
        getContextRevisionId: (sessionId) => this.context.revisionId(sessionId),
        assertContextFresh: async (request, signal) => {
          const run = this.store.getRun(request.runId);
          this.profiles.forRun(run.sessionId, run.config);
          await this.context.assertFresh(
            request.sessionId,
            request.messages,
            signal,
            request.runId,
          );
          this.profiles.forRun(run.sessionId, run.config);
        },
        releaseContext: (sessionId, runId) =>
          this.context.releaseContext(sessionId, runId),
        getToolProfile: (run) =>
          this.profiles.pinForRun(run.sessionId, run.config) ?? undefined,
        getAllowedTools: (run) =>
          this.allowedTools(
            this.profiles.forRun(run.sessionId, run.config)?.tools,
          ),
        recoverContextOverflow: (request, provider) =>
          this.context.recoverOverflow(request, provider),
        toolRuntime: this.toolRuntime,
        ...(toolDiscoveryPolicy
          ? {
              toolDiscoveryPolicy,
              coreToolNames: coreTools.map((tool) => tool.name),
            }
          : {}),
        onToolCheckpoint: async (observation) => {
          await this.watchWorkspace(observation.workspace.id);
          const changes = await this.changes.recordCheckpoint({
            ...observation,
            sessionId: observation.run.sessionId,
            runId: observation.run.id,
          });
          await Promise.all(
            changes.map((change) => this.languageSync.sync(change)),
          );
        },
      });
      this.scheduleProducer = new EngineScheduleProducer(this, knowledgeBinding, () => this.scheduleRecords, () => this.lifetime.closing, () => this.enabled.schedules);
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
      this.scheduler = new InputScheduler({ store: this.store, coordinator: this.coordinator, participants: RUN_PARTICIPANT_ORDER.promotion.map(name => participants[name]) });
      this.conversationForkHost = new ConversationForkHost(this,knowledgeBinding,id=>providers.get(id),this.enabled.conversationForks);
      const scheduleHost = new ScheduleHost({ native: this.scheduleRecords, input: this.scheduleProducer.inputPort() });
      this.scheduleDispatcher = new ScheduleDispatcher({ native: this.scheduleRecords, host: scheduleHost });
      this.backendProducer = new EngineAgentBackendProducer(this, knowledgeBinding, () => this.backendRecords, () => this.lifetime.closing,
        () => this.enabled.agentBackends, this.executionLockPath, options.agentBackendSecrets, ()=>options.agentBackendClientEffects===true, ()=>options.agentBackendClientEffects===true&&this.enabled.jobs);
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
        readClientPermission: original => this.coordinator.readProviderClientEffectPermission(original),
        readDisposal: original => this.backendProcesses.readDisposal(original),
      });
      this.backendRecords.recoverInterrupted();
      this.backendHost = new AgentBackendHost({ store: this.backendRecords, processes: this.backendProcesses, clientReads: this.backendProducer.clientReadPort(), turns: this.backendProducer, lifetime: this.lifetime.signal });
      this.codeModeHost=new CodeModeHost(this,this.store.createCodeModeStorage((original,record,revision)=>this.codeModeHost.assertRecordOwner(original,record,revision)),knowledgeBinding,options.codeMode===true);
      this.jobProducer = new EngineJobProducer(this, knowledgeBinding, () => this.jobRecords, () => this.lifetime.closing, () => this.enabled.jobs, this.storage.paths.artifactDir);
      this.jobRecords = this.store.createJobStorage({
        readOwner: original => this.jobProducer.readOwner(original),
        assertOwnerCurrent: (original, expected) => this.jobProducer.assertOwnerCurrent(original, expected),
        readSource: original => this.jobProducer.readSource(original),
        assertSourceCurrent: (original, expected, phase) => this.jobProducer.assertSourceCurrent(original, expected, phase),
        readOutput: original => this.jobProducer.readOutput(original),
        readClosedOutcome: original => this.jobProducer.readClosedOutcome(original),
        readDeliveryTarget: original => this.jobProducer.readTarget(original),
        assertDeliveryTargetCurrent: (original, expected) => this.jobProducer.assertTargetCurrent(original, expected),
        readAccepted: original => this.jobProducer.readAccepted(original),
        acceptAtomicInput: (original, request) => this.jobProducer.acceptAtomicInput(original, request),
        releaseAtomicInput: original => this.jobProducer.release(original),
      });
      this.jobRecords.recoverInterrupted();
      this.jobHost = new JobHost({ native: this.jobRecords, source: this.jobProducer.sourcePort(), lifetime: this.lifetime.signal });
      this.jobDelivery = new JobDelivery({ native: this.jobRecords, input: this.jobProducer.inputPort(), lifetime: this.lifetime.signal });
      this.store.validateEffectBatches();
      this.store.recoverEffectBatches();
      this.store.recoverOwnedCommandJobs();
      this.sandboxHost = new SandboxHost(this,this.store.createSandboxStorage(),{enabled:options.osSandbox===true,binding:knowledgeBinding,excluded:[this.storage.paths.artifactDir,...this.storage.nativeFiles],active:()=>!this.lifetime.closing});
      this.hostCommands = new HostCommandService(this, this.store.createHostCommandStorage(), knowledgeBinding, { enabled: () => options.hostCommands === true && !this.lifetime.closing, unsupportedPolicy: Boolean(options.commandPreflight || options.roleResourcePolicy || options.roleResourcePolicyRegistry || options.resolveRoleResources), artifactDir:this.storage.paths.artifactDir, executionLockPath:this.executionLockPath, lifetime:this.lifetime.signal, ...(options.osSandbox?{sandbox:(ws:string,session:string)=>this.sandboxHost.hostLaunch(ws,session)}:{}) });
      this.ownedCommandHost = new OwnedCommandJobHost(this, knowledgeBinding, () => this.enabled.jobs && !this.lifetime.closing);
      this.store.validateOwnedCommandDeliveries();
      this.ownedCommandProducer = new EngineOwnedCommandDeliveryProducer(this, knowledgeBinding, () => this.enabled.jobs && !this.lifetime.closing, this.ownedCommandHost);
      this.ownedCommandDelivery = new OwnedCommandDelivery({ input: this.ownedCommandProducer.inputPort(),
        native: { deliver: (original, input) => this.store.deliverOwnedCommandResultAtomic(original, input, atomicPorts(this.ownedCommandProducer)) }, lifetime: this.lifetime.signal });
      this.commandLifetimes=new CommandLifetimeService(this,this.hostCommands,()=>options.commandLifetimes===true&&this.enabled.jobs&&!this.lifetime.closing);
      this.store.validateHostCommandDeliveries();
      this.hostCommandDeliverySource=new EngineHostCommandDeliverySource(this);
      this.hostCommandDeliveryProducer = new EngineHostCommandDeliveryProducer(this, knowledgeBinding, () => options.hostCommands===true && this.enabled.jobs && !this.lifetime.closing, this.hostCommandDeliverySource);
      this.hostCommandDelivery = new HostCommandDelivery({ input: this.hostCommandDeliveryProducer.inputPort(),
        native: { deliver: (original, input) => this.store.deliverHostCommandResultAtomic(original, input, atomicPorts(this.hostCommandDeliveryProducer)) }, lifetime: this.lifetime.signal });
      this.gitCommitHost = new GitCommitHost({ store:this.store,records:this.store.createGitCommitStorage(),plans:this.verificationPlans,verification:this.verification.host,
        binding:knowledgeBinding,enabled:()=>options.gitCommits===true && this.enabled.verification && !this.lifetime.closing,
        lease:(workspaceId,operation)=>this.coordinator.withWorkspaceLease(workspaceId,operation),
        recoveryLease:(workspaceId,operation)=>this.recoveryGate.lease(workspaceId,operation),
        executionLockPath:this.executionLockPath,artifactDir:this.storage.paths.artifactDir,lifetime:this.lifetime.signal });
      this.store.validatePrFeedback();
      this.prFeedbackHost = new PrFeedbackHost(this,this.store.createPrFeedbackStorage(),knowledgeBinding,this.verification.host,()=>options.prFeedback===true&&this.enabled.verification&&!this.lifetime.closing,options.prFeedbackLoopback===true,this.lifetime.signal);
      this.restorer = new EngineRestore(store, reviewJournal, this, this.languageSync, this.changes, this.executionLockPath);
      this.restorer.quarantineInterrupted(storage.paths);
      this.commands = new EngineCommands({ store, scheduler: this.scheduler, coordinator: this.coordinator, approvals: this.approvals, questions: this.questions,
        tasks: this.tasks, context: this.context, profiles: this.profiles, defaults: this.defaults, lifetime: this.lifetime, media: this.media,
        restorer: this.restorer, languageSync: this.languageSync, managedArtifacts: this.managedArtifacts, getCapabilities: () => this.getCapabilities() });
    } catch (error) {
      try { terminalJournal?.close(); }
      finally { try { reviewJournal?.close(); }
      finally { try { store?.close(); }
      finally { this.removeOwnedArtifactDir(); } } }
      throw error;
    }
  }

  private removeOwnedArtifactDir(): void {
    if (this.ownedArtifactDir) try { rmSync(this.ownedArtifactDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }

  private allowedTools(profileTools: readonly string[] | undefined): readonly string[] | undefined {
    return this.hostAllowedTools ? (profileTools ? profileTools.filter(name => this.hostAllowedTools!.includes(name)) : this.hostAllowedTools) : profileTools;
  }

  /** Native inbox/session commands have their own explicit protocol and journal. */
  dispatchSession(value: unknown): Promise<SessionCommandResult> { return this.commands.dispatchSession(value); }

  dispatch(value: CommandEnvelope | unknown): Promise<CommandResult> { return this.commands.dispatch(value); }

  subscribe(sessionId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    this.lifetime.assertOpen();
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new EngineError('INVALID_CURSOR', 'afterSeq must be a non-negative safe integer');
    return this.store.subscribe(sessionId, afterSeq, signal);
  }

  subscribeSession(sessionId: string, afterSeq = 0, signal?: AbortSignal): AsyncIterable<SessionEventV2> {
    this.lifetime.assertOpen();
    return this.store.subscribeSessionEvents(sessionId, afterSeq, signal);
  }

  waitForSession(sessionId: string): Promise<void> { return this.scheduler.waitForSession(sessionId); }

  waitForRun(runId: string): Promise<Run> { return this.coordinator.waitForRun(runId); }

  previewResidentChildTask(request:EngineChildRequest,idleTimeoutMs?:number){return this.children.previewResident(request,idleTimeoutMs);}
  releaseResidentChildTaskPreview(original:object):void{this.children.releaseResidentPreview(original);}
  readResidentChildTaskPreview(original:object){return this.children.readResidentPreview(original);}
  startResidentChildTask(original:object,approved:boolean){return this.children.startResident(original,approved);}
  inspectResidentChildTask(sessionId:string,taskId:string){return this.children.inspectResident(sessionId,taskId);}
  stopResidentChildTask(sessionId:string,taskId:string){return this.children.stopResident(sessionId,taskId);}
  startChildTask(request: EngineChildRequest) {
    this.lifetime.assertOpen();
    return this.children.start(request);
  }

  registerLanguageServer(serverId: string, factory: LspFactory, languageForPath: (path: string) => string | null, revision = '1'): void {
    this.languageSync.register(serverId, factory, languageForPath, revision);
  }

  getRepositoryContext(workspaceId: string, query: RepositoryQuery, signal?: AbortSignal): Promise<RepositorySnapshot> {
    this.lifetime.assertOpen();
    return this.lifetime.track(this.repository.query(this.store.getWorkspace(workspaceId), query, this.lifetime.hostSignal(signal)));
  }

  registerLifecycleHook(hook: LifecycleHookRegistration): () => void {
    this.lifetime.assertOpen();
    if(this.enabled.sandbox)throw new EngineError('SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED','Host lifecycle effects require their own sandbox-bound producer');
    return this.lifecycleHooks.register(hook);
  }

  getTrajectory(options: TrajectoryOptions): JournalProjection {
    this.lifetime.assertOpen();
    validateTrajectoryOptions(options);
    if (options.runId !== undefined) {
      const run = this.store.getRun(options.runId);
      if (run.sessionId !== options.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Trajectory Run belongs to another session');
    }
    return exportTrajectory(this.store, options);
  }

  getAttemptManifest(runId: string, options: CodingEvidenceOptions = {}): CodingEvidenceManifest {
    this.lifetime.assertOpen();
    validateCodingEvidenceOptions(options);
    const run = this.store.getRun(runId), { source, ...page } = options;
    return createCodingEvidenceManifest(run, this.getTrajectory({ ...page, sessionId: run.sessionId, runId }), source);
  }

  getCodingEvidence(runId: string, options: NativeCodingEvidenceOptions = {}) {
    this.lifetime.assertOpen();
    return readNativeCodingEvidence({ getRun: id => this.store.getRun(id), getSession: id => this.store.getSession(id),
      readSessionEvents: (sessionId, afterSeq, limit) => this.store.readSessionEvents(sessionId, afterSeq, limit),
      listExecutionObservations: (workspaceId, id, page) => this.executionObserver.storage.listRun(workspaceId, id, page),
      readCoherentSnapshot: operation => this.store.readExecutionObservationEvidence(operation),
    }, runId, options);
  }

  inspectToolRegistration(toolName: string, scopeId = 'engine') {
    this.lifetime.assertOpen();
    return this.toolRuntime.inspectToolRegistration(scopeId, toolName);
  }

  getStallObservation(options: TrajectoryOptions, limits?: StallOptions): StallObservation {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => {
      const trajectory = this.getTrajectory(options), run = trajectory.runId ? this.store.getRun(trajectory.runId) : undefined;
      const toolCallIds = new Set(trajectory.events.flatMap(event => run && event.runId === run.id && event.tool?.toolCallId ? [event.tool.toolCallId] : []));
      const observations = run ? [...toolCallIds].flatMap(id => this.executionObserver.storage.getObservation(run.workspaceId, id) ?? []) : [];
      return getTrajectoryStallObservation(trajectory, limits, observations);
    });
  }

  getExecutionObservations(input: { workspaceId: string; runId: string } & DiagnosticExecutionPageOptions) {
    this.lifetime.assertOpen();
    plainRecord(input, ['workspaceId', 'runId'], ['afterOrdinal', 'throughOrdinal', 'limit', 'maxBytes'], fault => {
      throw new EngineError('INVALID_EXECUTION_OBSERVATION', fault === 'shape' ? 'Observation queries require plain bounded data' : 'Observation queries require exact plain bounded data');
    });
    const { workspaceId, runId, ...page } = input;
    return this.store.readExecutionObservationEvidence(() => {
      if (this.store.getRun(runId).workspaceId !== workspaceId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Observation Run belongs to another workspace');
      return this.executionObserver.storage.listRun(workspaceId, runId, page);
    });
  }

  getPolicyDecisionReceipts(options: TrajectoryOptions): PolicyDecisionReceiptPage {
    this.lifetime.assertOpen();
    validateTrajectoryOptions(options);
    if (options.runId !== undefined && this.store.getRun(options.runId).sessionId !== options.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Decision Run belongs to another session');
    return readPolicyDecisionReceipts(this.store, options);
  }

  watchWorkspace(workspaceId: string): Promise<WorkspaceChangeWatch> { return this.languageSync.watch(workspaceId); }

  createWorktree(sessionId: string, requestId: string, reference?: string) {
    if (this.lifetime.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId), workspace = this.store.getWorkspace(session.workspaceId);
    this.children.recover(sessionId);
    return this.coordinator.withWorkspaceLease(workspace.id, signal => this.children.worktrees.create({ sessionId, requestId, workspace, ...(reference ? { reference } : {}) }, signal));
  }

  cleanupWorktree(sessionId: string, worktreeId: string) {
    if (this.lifetime.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId);
    return this.coordinator.withWorkspaceLease(session.workspaceId, signal => this.children.worktrees.cleanup(sessionId, worktreeId, signal));
  }

  prepareChildWorktree(sessionId: string, parentWorktreeId: string, requestId: string, reference?: string) {
    if (this.lifetime.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const session = this.store.getSession(sessionId);
    this.children.recover(sessionId);
    return this.coordinator.withWorkspaceLease(session.workspaceId, async signal => {
      const parent = this.children.worktrees.get(sessionId, parentWorktreeId);
      if (parent.ownerId) throw new EngineError('CHILD_WORKTREE_BUSY', 'Prepare nested worktrees before an execution owns their parent');
      const workspace = await this.children.worktrees.verify(parent, signal);
      return this.children.worktrees.create({ sessionId, requestId, workspace, ...(reference ? { reference } : {}) }, signal);
    });
  }

  captureForkPreview(input: CaptureForkPreviewInput): Promise<object> { return this.conversationForkHost.capture(input); }
  readForkPreview(original: object) { return this.conversationForkHost.read(original); }
  forkConversationView(input: ForkCommitInput) { return this.conversationForkHost.commit(input); }
  inspectConversationLineage(sessionId: string) { return this.store.getConversationFork(sessionId); }
  exportConversationForkHistory(sessionId: string) { return this.conversationForkHost.exportHistory(sessionId); }
  captureForkImportPreview(input: Parameters<ConversationForkHost['captureImport']>[0]) { return this.conversationForkHost.captureImport(input); }
  readForkImportPreview(original: object) { return this.conversationForkHost.readImport(original); }
  importConversationForkHistory(input: ForkCommitInput) { return this.conversationForkHost.importHistory(input); }
  releaseForkPreview(original: object): void { this.conversationForkHost.release(original); }
  getCapabilities(): EngineCapabilities {
    const { schemaVersion, runtime, ...rest } = structuredClone(this.capabilities);
    return { schemaVersion, runtime, providerIds: [...this.runtimeProviders.keys()].sort(), tools: [...this.toolRuntime.catalogue('engine', 'build', this.hostAllowedTools).tools], ...rest };
  }

  private assertAgentBackendsEnabled(): void { this.lifetime.assertEnabled(this.enabled.agentBackends, 'AGENT_BACKENDS_DISABLED', 'Agent backends require explicit root host opt-in'); }
  captureAgentBackendTarget(input: CaptureAgentBackendTarget): object { if(this.enabled.sandbox)throw new EngineError('SANDBOX_AGENT_BACKEND_UNSUPPORTED','ACP effect servers cannot bypass sandbox restrictions'); this.assertAgentBackendsEnabled(); return this.backendProducer.captureTarget(input); }
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
  /** Native disabled state fences dispatch; original Attempt owners retain observation authority. */
  disableAgentBackend(input: DisableAgentBackendInput) {
    this.assertAgentBackendsEnabled(); const result = this.backendRecords.disableBackend(input);
    const providerId = `acp:${result.record.backendId}`;
    if (this.backendProviderIds.has(providerId)) this.runtimeProviders.delete(providerId);
    return result;
  }
  getAgentBackend(workspaceId: string, backendId: string, revisionId?: string) { return this.backendRecords.getBackend(workspaceId, backendId, revisionId); }
  inspectAgentBackends(workspaceId: string) { return this.backendRecords.inspectBackends(workspaceId); }
  inspectAgentBackendConnections(workspaceId: string) { return this.backendRecords.inspectConnections(workspaceId); }
  inspectAgentBackendRequests(workspaceId: string) { return this.backendRecords.inspectRequests(workspaceId); }
  inspectAgentBackendEffects(workspaceId: string) { return this.backendRecords.inspectClientEffects(workspaceId); }
  releaseAgentBackendTarget(original: object): void { this.backendProducer.releaseTarget(original); }

  captureTerminalJob(...args: Parameters<JobHost['captureTerminalJob']>) { return this.jobHost.captureTerminalJob(...args); }
  readTerminalJobSource(...args: Parameters<JobHost['readTerminalJobSource']>) { return this.jobHost.readTerminalJobSource(...args); }
  attachTerminalJob(...args: Parameters<JobHost['attachTerminalJob']>) { return this.jobHost.attachTerminalJob(...args); }
  captureJobOutput(...args: Parameters<JobHost['captureJobOutput']>) { return this.jobHost.captureJobOutput(...args); }
  readJobOutputPage(...args: Parameters<JobHost['readOutput']>) { return this.jobHost.readOutput(...args); }
  recordJobOutput(...args: Parameters<JobHost['recordJobOutput']>) { return this.jobHost.recordJobOutput(...args); }
  settleTerminalJob(...args: Parameters<JobHost['settleTerminalJob']>) { return this.jobHost.settleTerminalJob(...args); }
  cancelCommandJobWatch(...args: Parameters<JobHost['cancelCommandJobWatch']>) { if (!this.enabled.jobs) throw new EngineError('JOBS_DISABLED', 'Job mutations require explicit root host opt-in'); return this.jobHost.cancelCommandJobWatch(...args); }
  getCommandJob(...args: Parameters<JobStorage['getJob']>) { return this.store.readExecutionObservationEvidence(() => this.jobRecords.getJob(...args)); }
  inspectCommandJobs(...args: Parameters<JobStorage['inspectJobs']>) { return this.store.readExecutionObservationEvidence(() => this.jobRecords.inspectJobs(...args)); }
  readCommandJobOutputs(...args: Parameters<JobStorage['readOutputs']>) { return this.store.readExecutionObservationEvidence(() => this.jobRecords.readOutputs(...args)); }
  inspectCommandJobDeliveries(...args: Parameters<JobStorage['inspectDeliveries']>) { return this.store.readExecutionObservationEvidence(() => this.jobRecords.inspectDeliveries(...args)); }
  captureCommandJobDeliveryTarget(...args: Parameters<JobDelivery['captureTarget']>) { return this.jobDelivery.captureTarget(...args); }
  readCommandJobDeliveryTarget(...args: Parameters<JobDelivery['readTarget']>) { return this.jobDelivery.readTarget(...args); }
  deliverCommandJobResult(...args: Parameters<JobDelivery['deliver']>) { return this.jobDelivery.deliver(...args); }
  releaseCommandJobHandle(original: object): void { this.jobHost.release(original); this.jobDelivery.release(original); }
  connectSandboxedMcp(input:Parameters<SandboxHost['connectMcp']>[0]){return this.sandboxHost.connectMcp(input);}
  bindSandboxedMcp(original:object){return this.sandboxHost.bindMcp(original);}
  registerSandboxBackend(){return this.sandboxHost.registerSandboxBackend();}
  getSandboxCapability(){return this.sandboxHost.capability();}
  previewSandboxGrant(input:PreviewSandboxGrantInput){return this.sandboxHost.preview(input);}
  readSandboxGrant(original:object){return this.sandboxHost.read(original);}
  approveSandboxGrant(input:ApproveSandboxGrantInput){return this.sandboxHost.approve(input);}
  releaseSandboxGrant(original:object){this.sandboxHost.release(original);}
  observeEnforcement(workspaceId:string){return this.sandboxHost.inspect(workspaceId);}
  commandLifetimeCapability(){return this.commandLifetimes.capability();}
  previewCommandLifetime(...args:Parameters<CommandLifetimeService['preview']>){return this.commandLifetimes.preview(...args);}
  readCommandLifetimePreview(...args:Parameters<CommandLifetimeService['readPreview']>){return this.commandLifetimes.readPreview(...args);}
  startCommandLifetime(...args:Parameters<CommandLifetimeService['start']>){return this.commandLifetimes.start(...args);}
  previewCommandLifetimeTransfer(...args:Parameters<CommandLifetimeService['previewTransfer']>){return this.commandLifetimes.previewTransfer(...args);}
  readCommandLifetimeTransfer(...args:Parameters<CommandLifetimeService['readTransfer']>){return this.commandLifetimes.readTransfer(...args);}
  transferCommandLifetime(...args:Parameters<CommandLifetimeService['transfer']>){return this.commandLifetimes.transfer(...args);}
  previewCommandLifetimeInput(...args:Parameters<CommandLifetimeService['previewInput']>){return this.commandLifetimes.previewInput(...args);}
  readCommandLifetimeInputPreview(...args:Parameters<CommandLifetimeService['readInputPreview']>){return this.commandLifetimes.readInputPreview(...args);}
  writeCommandLifetimeInput(...args:Parameters<CommandLifetimeService['input']>){return this.commandLifetimes.input(...args);}
  waitForCommandLifetime(...args:Parameters<CommandLifetimeService['wait']>){return this.commandLifetimes.wait(...args);}
  cancelCommandLifetime(...args:Parameters<CommandLifetimeService['cancel']>){return this.commandLifetimes.cancel(...args);}
  inspectCommandLifetimes(...args:Parameters<CommandLifetimeService['inspect']>){return this.commandLifetimes.inspect(...args);}
  releaseCommandLifetimeHandle(original:object){this.commandLifetimes.release(original);}
  previewHostCommand(...args: Parameters<HostCommandService['preview']>) { return this.hostCommands.preview(...args); }
  readHostCommandPreview(...args: Parameters<HostCommandService['readPreview']>) { return this.hostCommands.readPreview(...args); }
  startHostCommand(...args: Parameters<HostCommandService['start']>) { return this.hostCommands.start(...args); }
  waitForHostCommand(...args: Parameters<HostCommandService['wait']>) { return this.hostCommands.wait(...args); }
  cancelHostCommand(...args: Parameters<HostCommandService['cancel']>) { return this.hostCommands.cancel(...args); }
  inspectHostCommands(...args: Parameters<HostCommandService['inspect']>) { return this.hostCommands.inspect(...args); }
  getHostCommand(...args: Parameters<HostCommandService['get']>) { return this.hostCommands.get(...args); }
  captureHostCommandOutput(...args: Parameters<HostCommandService['captureOutput']>) { return this.hostCommands.captureOutput(...args); }
  readHostCommandOutput(...args: Parameters<HostCommandService['readOutput']>) { return this.hostCommands.readOutput(...args); }
  readHostCommandArtifacts(...args: Parameters<HostCommandService['artifacts']>) { return this.hostCommands.artifacts(...args); }
  releaseHostCommandHandle(original:object):void { this.hostCommands.release(original); }
  inspectOwnedCommandJobs(...args: Parameters<OwnedCommandJobHost['inspect']>) { return this.ownedCommandHost.inspect(...args); }
  getOwnedCommandJob(...args: Parameters<OwnedCommandJobHost['get']>) { return this.ownedCommandHost.get(...args); }
  captureOwnedCommandJobOutput(...args: Parameters<OwnedCommandJobHost['captureOutput']>) { return this.ownedCommandHost.captureOutput(...args); }
  readOwnedCommandJobOutput(...args: Parameters<OwnedCommandJobHost['readOutput']>) { return this.ownedCommandHost.readOutput(...args); }
  releaseOwnedCommandJobHandle(original: object): void { this.ownedCommandHost.release(original); }
  cancelOwnedCommandJob(...args: Parameters<OwnedCommandJobHost['cancel']>) { return this.ownedCommandHost.cancel(...args); }
  captureOwnedCommandJobDeliveryTarget(...args: Parameters<OwnedCommandDelivery['captureTarget']>) { return this.ownedCommandDelivery.captureTarget(...args); }
  readOwnedCommandJobDeliveryTarget(...args: Parameters<OwnedCommandDelivery['readTarget']>) { return this.ownedCommandDelivery.readTarget(...args); }
  deliverOwnedCommandJobResult(...args: Parameters<OwnedCommandDelivery['deliver']>) { return this.ownedCommandDelivery.deliver(...args); }
  releaseOwnedCommandJobDeliveryHandle(original: object): void { this.ownedCommandDelivery.release(original); }
  inspectEffectBatches(workspaceId:string,sessionId?:string){this.store.getWorkspace(workspaceId);if(sessionId&&this.store.getSession(sessionId).workspaceId!==workspaceId)throw new EngineError('RECORD_SCOPE_MISMATCH','Effect batch session mismatch');return this.store.inspectEffectBatches(workspaceId,sessionId);}
  getEffectBatch(sessionId:string,id:string){return this.store.getEffectBatch(sessionId,id);}
  getOwnedCommandJobDelivery(...args: Parameters<SqliteStore['getOwnedCommandJobDelivery']>) { return this.store.getOwnedCommandJobDelivery(...args); }
  captureHostCommandJobDeliveryTarget(...args: Parameters<HostCommandDelivery['captureTarget']>) { return this.hostCommandDelivery.captureTarget(...args); }
  readHostCommandJobDeliveryTarget(...args: Parameters<HostCommandDelivery['readTarget']>) { return this.hostCommandDelivery.readTarget(...args); }
  deliverHostCommandJobResult(...args: Parameters<HostCommandDelivery['deliver']>) { return this.hostCommandDelivery.deliver(...args); }
  releaseHostCommandJobDeliveryHandle(original: object): void { this.hostCommandDelivery.release(original); }
  inspectHostCommandJobDeliveries(...args: Parameters<SqliteStore['inspectHostCommandJobDeliveries']>) {return this.store.inspectHostCommandJobDeliveries(...args);}
  getHostCommandJobDelivery(...args: Parameters<SqliteStore['getHostCommandJobDelivery']>) { return this.store.getHostCommandJobDelivery(...args); }
  inspectOwnedCommandJobDeliveries(...args: Parameters<SqliteStore['inspectOwnedCommandJobDeliveries']>) { return this.store.inspectOwnedCommandJobDeliveries(...args); }

  replaceRoleResourcePolicy(expectedRegistryRevision: number, policy: RoleResourcePolicySnapshot) {
    this.lifetime.assertOpen();
    if (!this.roleResourcePolicyRegistry) throw new EngineError('ROLE_POLICY_UNSUPPORTED', 'Dynamic role policy requires an explicit host registry');
    return this.roleResourcePolicyRegistry.replace(expectedRegistryRevision, policy);
  }

  previewPrWatch(...args:Parameters<PrFeedbackHost['preview']>){return this.prFeedbackHost.preview(...args);}
  readPrWatchPreview(...args:Parameters<PrFeedbackHost['readPreview']>){return this.prFeedbackHost.readPreview(...args);}
  getCodeModeCapability(){return this.codeModeHost.getCapability();}
  getCodeModeSupport(){return this.codeModeHost.getSupport();}
  registerCodeModeHost(){return this.codeModeHost.registerCodeModeHost();}
  previewCodeModeGrant(input:unknown){return this.codeModeHost.previewCodeModeGrant(input);}
  readCodeModeGrant(original:object){return this.codeModeHost.readCodeModeGrant(original);}
  approveCodeModeGrant(input:unknown){return this.codeModeHost.approveCodeModeGrant(input);}
  releaseCodeModeGrant(original:object){this.codeModeHost.release(original);}
  inspectCodeMode(workspaceId:string){return this.codeModeHost.inspect(workspaceId);}
  getCodeMode(workspaceId:string,id:string){return this.codeModeHost.get(workspaceId,id);}
  registerPrWatch(...args:Parameters<PrFeedbackHost['register']>){return this.prFeedbackHost.register(...args);}
  pollPrWatch(...args:Parameters<PrFeedbackHost['poll']>){return this.prFeedbackHost.poll(...args);}
  acceptCiFeedback(...args:Parameters<PrFeedbackHost['acceptWebhook']>){return this.prFeedbackHost.acceptWebhook(...args);}
  reconcilePrHead(...args:Parameters<PrFeedbackHost['poll']>){return this.prFeedbackHost.poll(...args);}
  startPrWatch(...args:Parameters<PrFeedbackHost['start']>){return this.prFeedbackHost.start(...args);}
  stopPrWatch(...args:Parameters<PrFeedbackHost['stop']>){return this.prFeedbackHost.stop(...args);}
  disablePrWatch(...args:Parameters<PrFeedbackHost['disable']>){return this.prFeedbackHost.disable(...args);}
  releasePrWatchPreview(original:object){this.prFeedbackHost.release(original);}
  getPrWatch(workspaceId:string,sessionId:string,id:string){return this.prFeedbackHost.records.get(workspaceId,sessionId,id);}
  inspectPrWatches(workspaceId:string){return this.prFeedbackHost.records.list(workspaceId);}
  getPrFeedbackOccurrence(workspaceId:string,sessionId:string,id:string){return this.prFeedbackHost.records.occurrence(workspaceId,sessionId,id);}
  getPrRepairVerification(...args:Parameters<PrFeedbackHost['repairVerification']>){return this.prFeedbackHost.repairVerification(...args);}
  previewGitCommit(...args:Parameters<GitCommitHost['preview']>) { return this.gitCommitHost.preview(...args); }
  readGitCommitPreview(...args:Parameters<GitCommitHost['read']>) { return this.gitCommitHost.read(...args); }
  releaseGitCommitPreview(...args:Parameters<GitCommitHost['release']>) { return this.gitCommitHost.release(...args); }
  commitReviewedChanges(...args:Parameters<GitCommitHost['commit']>) { return this.gitCommitHost.commit(...args); }
  reconcileGitCommit(...args:Parameters<GitCommitHost['reconcile']>) { return this.gitCommitHost.reconcile(...args); }
  getGitCommitReceipt(...args:Parameters<SqliteStore['getGitCommitReceipt']>) { return this.store.getGitCommitReceipt(...args); }
  inspectGitCommitReceipts(...args:Parameters<SqliteStore['inspectGitCommitReceipts']>) { return this.store.inspectGitCommitReceipts(...args); }

  registerVerificationCheck(check: VerificationCheckRegistration): () => void { return this.verification.register(check); }

  configureVerificationSession(sessionId: string, expectedRevision: number, policy: VerificationSessionPolicy) {
    return this.verification.configure(sessionId, expectedRevision, policy);
  }

  getVerificationConfiguration(sessionId: string) {
    this.lifetime.assertOpen();
    return this.verification.host.configuration(sessionId);
  }

  getVerificationState(sessionId: string, runId: string) {
    this.lifetime.assertOpen();
    return this.verificationPlans.get(sessionId, runId);
  }

  getVerificationCompletion(sessionId: string, runId: string) {
    this.lifetime.assertOpen();
    return this.verificationController.get(sessionId, runId);
  }

  previewWorkspaceTrust(workspaceId: string, paths: readonly string[]) { return this.knowledge.previewTrust(workspaceId, paths); }

  previewWorkspaceKnowledgeImportAcknowledgment(input: Parameters<KnowledgeImportRecoveryService['previewAcknowledgment']>[0]) { return this.knowledge.previewImportAcknowledgment(input); }
  previewWorkspaceKnowledgeImportRecovery(input: Parameters<KnowledgeImportRecoveryService['previewResume']>[0]) { return this.knowledge.previewImportRecovery(input); }
  previewWorkspaceKnowledgeImportActivation(input: Parameters<KnowledgeImportRecoveryService['previewActivation']>[0]) { return this.knowledge.previewImportActivation(input); }
  previewWorkspaceKnowledgeImportDeactivation(input: Parameters<KnowledgeImportRecoveryService['previewDeactivation']>[0]) { return this.knowledge.previewImportDeactivation(input); }
  acknowledgeWorkspaceKnowledgeImport(input: Parameters<KnowledgeImportRecoveryService['acknowledge']>[0]) { return this.knowledge.acknowledgeImport(input); }
  resumeWorkspaceKnowledgeImport(input: Parameters<KnowledgeImportRecoveryService['resume']>[0]) { return this.knowledge.resumeImport(input); }
  activateWorkspaceKnowledgeImport(input: Parameters<KnowledgeImportRecoveryService['activate']>[0]) { return this.knowledge.activateImport(input); }
  deactivateWorkspaceKnowledgeImport(input: Parameters<KnowledgeImportRecoveryService['deactivate']>[0]) { return this.knowledge.deactivateImport(input); }
  releaseWorkspaceKnowledgeImportPreview(preview: Parameters<KnowledgeImportRecoveryService['releasePreview']>[0]): void { this.knowledge.importService.releasePreview(preview); }
  getWorkspaceKnowledgeImportFrontier(workspaceId: string) { return this.knowledge.getImportFrontier(workspaceId); }
  getWorkspaceKnowledgeImportActivation(workspaceId: string, documentKey: string) { return this.knowledge.getImportActivation(workspaceId, documentKey); }

  private assertTeamsEnabled(): void { this.lifetime.assertEnabled(this.enabled.teams, 'TEAMS_DISABLED', 'Teams require explicit host opt-in'); }
  private assertSchedulesEnabled(): void { this.lifetime.assertEnabled(this.enabled.schedules, 'SCHEDULES_DISABLED', 'Schedules require explicit root host opt-in'); }
  captureScheduleWorker(workspaceId: string): object { this.assertSchedulesEnabled(); return this.scheduleProducer.captureWorker(workspaceId); }
  captureScheduleTarget(input: Parameters<EngineScheduleProducer['captureTarget']>[0]): object { this.assertSchedulesEnabled(); return this.scheduleProducer.captureTarget(input); }
  readScheduleTarget(original: object) { this.assertSchedulesEnabled(); return this.scheduleProducer.targetPin(original); }
  registerSchedule(...args: Parameters<ScheduleStorage['registerSchedule']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.registerSchedule(...args); }
  disableSchedule(...args: Parameters<ScheduleStorage['disableSchedule']>) { this.assertSchedulesEnabled(); return this.scheduleRecords.disableSchedule(...args); }
  getSchedule(...args: Parameters<ScheduleStorage['getSchedule']>) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.scheduleRecords.getSchedule(...args));
  }
  inspectSchedules(workspaceId: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.scheduleRecords.inspectSchedules(workspaceId));
  }
  inspectScheduleOccurrences(...args: Parameters<ScheduleStorage['inspectOccurrences']>) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.scheduleRecords.inspectOccurrences(...args));
  }
  getSchedulerLease(workspaceId: string) {
    this.lifetime.assertOpen();
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
  bindCommandJobModelTools(input: BindCommandJobModelToolsInput): object { return this.commandJobModelHost.bind(input); }
  releaseCommandJobModelTools(original: object): void { this.commandJobModelHost.release(original); }

  bindTeamModelTools(input: BindTeamModelToolsInput): TeamModelToolsBinding { return this.teamModelHost.bind(input); }
  private assertWorkflowsEnabled(): void { this.lifetime.assertEnabled(this.enabled.workflows, 'WORKFLOWS_DISABLED', 'Workflows require explicit host opt-in'); }

  installCodingBatchDispatchGuard(guard: () => void, charge: () => void): void {
    if (this.codingBatchDispatchGuard)
      throw new EngineError(
        "CODING_BATCH_ALREADY_BOUND",
        "Original child has one batch guard",
      );
    this.codingBatchDispatchGuard = guard;
    this.codingBatchCharge = charge;
  }
  previewCodingAttemptGroup(input: Parameters<CodingBatchHost["preview"]>[0]) {
    return this.codingBatches.preview(input);
  }
  startCodingAttemptGroup(input: Parameters<CodingBatchHost["start"]>[0]) {
    return this.codingBatches.start(input);
  }
  runCodingAttemptGroup(input: Parameters<CodingBatchHost["run"]>[0]) {
    return this.codingBatches.run(input);
  }
  inspectBatchEvidence(workspaceId: string, groupId: string) {
    return this.codingBatches.inspect(workspaceId, groupId);
  }
  resumeVerifiedBatch(input: Parameters<CodingBatchHost["resume"]>[0]) {
    return this.codingBatches.resume(input);
  }
  skipCodingBatchCase(input: Parameters<CodingBatchHost["skip"]>[0]) {
    return this.codingBatches.skip(input);
  }
  cancelCodingAttemptGroup(input: Parameters<CodingBatchHost["cancel"]>[0]) {
    return this.codingBatches.cancel(input);
  }
  previewCodingAttemptSelection(
    input: Parameters<CodingBatchHost["previewSelection"]>[0],
  ) {
    return this.codingBatches.previewSelection(input);
  }
  selectCodingAttempt(input: Parameters<CodingBatchHost["select"]>[0]) {
    return this.codingBatches.select(input);
  }
  captureCodingBatchDeliveryTarget(
    input: Parameters<CodingBatchHost["captureDelivery"]>[0],
  ) {
    return this.codingBatches.captureDelivery(input);
  }
  readCodingBatchDeliveryTarget(original: object) {
    return this.codingBatches.readDelivery(original);
  }
  deliverCodingBatchResult(input: Parameters<CodingBatchHost["deliver"]>[0]) {
    return this.codingBatches.deliver(input);
  }
  captureBatchEvidenceExport(workspaceId: string, groupId: string) {
    return this.codingBatches.captureExport(workspaceId, groupId);
  }
  readBatchEvidenceExport(original: object) {
    return this.codingBatches.readExport(original);
  }
  releaseCodingAttemptHandle(original: object) {
    this.codingBatches.release(original);
  }
  registerWorkflow(input: Parameters<WorkflowService['register']>[0]) { this.assertWorkflowsEnabled(); return this.workflowService.register(input); }
  getWorkflow(workspaceId: string, workflowId: string, revisionId?: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.workflowRecords.getWorkflow(workspaceId, workflowId, revisionId));
  }
  async previewWorkflowStart(input: Parameters<WorkflowHost['previewStart']>[0]) {
    this.assertWorkflowsEnabled();
    return await this.lifetime.track(this.workflowHost.previewStart(input));
  }
  startWorkflow(input: Parameters<WorkflowService['start']>[0]) { this.assertWorkflowsEnabled(); return this.workflowService.start(input); }
  startWorkflowStage(input: Parameters<WorkflowService['startStage']>[0]) {
    return this.lifetime.rejecting(() => { this.assertWorkflowsEnabled(); return this.workflowService.startStage(input); });
  }
  observeWorkflowStage(input: Parameters<WorkflowService['observeStage']>[0]) {
    return this.lifetime.rejecting(() => { this.assertWorkflowsEnabled(); return this.workflowService.observeStage(input); });
  }
  inspectWorkflow(workspaceId: string, instanceId: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.workflowRecords.inspectWorkflow(workspaceId, instanceId));
  }
  bindWorkflowModelTools(input:Parameters<WorkflowModelTools['bind']>[0]){this.assertWorkflowsEnabled();return this.workflowModelTools.bind(input);}
  releaseWorkflowModelTools(original:object){this.workflowModelTools.release(original);}
  captureWorkflowDeliveryTarget(input:Parameters<WorkflowEffects['captureTarget']>[0]){this.assertWorkflowsEnabled();return this.workflowEffects.captureTarget(input);}
  readWorkflowDeliveryTarget(original:object){this.assertWorkflowsEnabled();return this.workflowEffects.readTarget(original);}
  deliverWorkflowResult(input:Parameters<WorkflowEffects['deliver']>[0]){this.assertWorkflowsEnabled();return this.workflowEffects.deliver(input);}
  releaseWorkflowDeliveryTarget(original:object){this.workflowEffects.release(original);}
  inspectWorkflowEffect(workspaceId:string,instanceId:string,stageId:string){const record=this.workflowRecords.inspectWorkflow(workspaceId,instanceId);return record?this.store.readWorkflowEffect(record.owner.sessionId,instanceId,stageId):null;}
  inspectWorkflowDelivery(workspaceId:string,instanceId:string){const record=this.workflowRecords.inspectWorkflow(workspaceId,instanceId);return record?this.store.readWorkflowDelivery(record.owner.sessionId,instanceId):null;}
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
  getTeam(workspaceId: string, teamId: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.teamRecords.getTeam(workspaceId, teamId));
  }
  getTeamMember(workspaceId: string, teamId: string, memberId: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.teamRecords.getMember(workspaceId, teamId, memberId));
  }
  listTeamMembers(workspaceId: string, teamId: string, limit?: number) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.teamRecords.listMembers(workspaceId, teamId, limit));
  }
  getTeamTask(workspaceId: string, teamId: string, taskId: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.teamRecords.getTask(workspaceId, teamId, taskId));
  }
  readTeamTaskPage(workspaceId: string, teamId: string, afterTaskId?: string, limit?: number) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.teamRecords.listTasksPage(workspaceId, teamId, afterTaskId, limit));
  }
  listTeamTasks(workspaceId: string, teamId: string, limit?: number) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => this.teamRecords.listTasks(workspaceId, teamId, limit));
  }
  getTeamDelivery(workspaceId: string, id: string) {
    this.lifetime.assertOpen();
    return this.store.readExecutionObservationEvidence(() => {
      const record = this.teamRecords.getDelivery(workspaceId, id);
      return record ? { record, receipt: this.teamRecords.getDeliveryReceipt(workspaceId, id) ?? null } : undefined;
    });
  }

  createProposalSet(input: CreateProposalSetInput) { return this.proposals.create(input); }
  previewProposalApply(input: Parameters<ProposalApplyService['preview']>[0]) { return this.proposals.previewApply(input); }
  applyProposal(input: Parameters<ProposalApplyService['apply']>[0]) { return this.proposals.apply(input); }
  releaseProposalApplyPreview(preview: Parameters<ProposalApplyService['releasePreview']>[0]): void { this.proposals.applyService.releasePreview(preview); }
  getProposalApply(workspaceId: string, ownerId: string) { return this.proposals.getApply(workspaceId, ownerId); }
  getProposalApplyRequest(workspaceId: string, requestId: string) { return this.proposals.getApplyRequest(workspaceId, requestId); }
  previewProposalApplyRecovery(workspaceId: string): ProposalApplyRecoveryPreview { return this.proposals.previewApplyRecovery(workspaceId); }
  acknowledgeProposalApplyRecovery(input: { readonly workspaceId: string; readonly requestId: string; readonly preview: ProposalApplyRecoveryPreview; readonly reason: string }) {
    return this.proposals.applyRecoveryDecision('acknowledge', input);
  }
  resumeProposalApplyRecovery(input: { readonly workspaceId: string; readonly requestId: string; readonly preview: ProposalApplyRecoveryPreview; readonly reason: string }) {
    return this.proposals.applyRecoveryDecision('resume', input);
  }
  getProposalSet(workspaceId: string, proposalId: string) { return this.proposals.get(workspaceId, proposalId); }
  listProposalSets(input: Parameters<ProposalHostService['list']>[0]) { return this.proposals.list(input); }
  getProposalDiff(input: Parameters<ProposalHostService['diff']>[0]) { return this.proposals.diff(input); }

  setWorkspaceTrust(input: Parameters<WorkspaceTrustService['set']>[0]) { return this.knowledge.setTrust(input); }

  captureWorkspaceKnowledgeSources(workspaceId: string, selection: readonly KnowledgeSourceSelection[]) { return this.knowledge.captureSources(workspaceId, selection); }
  previewWorkspaceKnowledgeGeneration(input: { providerId: string; modelId: string; projection: KnowledgeSourceProjection; reasoningEffort?: ReasoningEffort }) { return this.knowledge.previewGeneration(input); }
  releaseWorkspaceKnowledgeSources(projection: KnowledgeSourceProjection): void { this.knowledge.releaseSources(projection); }
  prepareWorkspaceKnowledgeGeneration(input: Omit<PrepareKnowledgeGeneration, 'binding' | 'source'> & { projection: KnowledgeSourceProjection }) { return this.knowledge.prepareGeneration(input); }
  captureWorkspaceKnowledgeTarget(workspaceId: string, path: string) { return this.knowledge.captureTarget(workspaceId, path); }
  captureWorkspaceKnowledgeDocumentTarget(workspaceId: string, key: string) { return this.knowledge.captureDocumentTarget(workspaceId, key); }

  previewWorkspaceKnowledgeFilePublication(input: Parameters<KnowledgeFilePublicationService['previewPublish']>[0]) { return this.knowledge.previewFilePublication(input); }
  previewWorkspaceKnowledgeFileRevocation(input: Parameters<KnowledgeFilePublicationService['previewRevoke']>[0]) { return this.knowledge.previewFileRevocation(input); }
  publishWorkspaceKnowledgeFile(input: Parameters<KnowledgeFilePublicationService['publish']>[0]) { return this.knowledge.publishFile(input); }
  revokeWorkspaceKnowledgeFile(input: Parameters<KnowledgeFilePublicationService['revoke']>[0]) { return this.knowledge.revokeFile(input); }
  releaseWorkspaceKnowledgeFilePublicationPreview(preview: Parameters<KnowledgeFilePublicationService['releasePreview']>[0]): void { this.knowledge.filePublicationService.releasePreview(preview); }
  getWorkspaceKnowledgeFilePublication(workspaceId: string, id: string) { return this.knowledge.getFilePublication(workspaceId, id); }
  getWorkspaceKnowledgeFilePublicationReceipt(workspaceId: string, requestId: string) { return this.knowledge.getFilePublicationReceipt(workspaceId, requestId); }
  getWorkspaceKnowledgeFileTarget(workspaceId: string, path: string) { return this.knowledge.getFileTarget(workspaceId, path); }
  previewWorkspaceKnowledgeFileRecovery(workspaceId: string) { return this.knowledge.previewFileRecovery(workspaceId); }
  acknowledgeWorkspaceKnowledgeFileRecovery(input: { workspaceId: string; requestId: string; approved: true; preview: KnowledgeFileRecoveryPreview; reason: string }) {
    return this.knowledge.fileRecoveryDecision('acknowledge', input);
  }
  resumeWorkspaceKnowledgeFileAfterRecovery(input: { workspaceId: string; requestId: string; approved: true; preview: KnowledgeFileRecoveryPreview; reason: string }) {
    return this.knowledge.fileRecoveryDecision('resume', input);
  }
  listWorkspaceKnowledgeFilePublications(workspaceId: string, options?: Parameters<KnowledgeFilePublicationStorage['listPublications']>[1]) { return this.knowledge.listFilePublications(workspaceId, options); }

  previewWorkspaceKnowledgePublication(input: Parameters<KnowledgePublicationService['previewPublish']>[0]) { return this.knowledge.previewPublication(input); }
  previewWorkspaceKnowledgeRevocation(input: Parameters<KnowledgePublicationService['previewRevoke']>[0]) { return this.knowledge.previewRevocation(input); }
  publishWorkspaceKnowledge(input: Parameters<KnowledgePublicationService['publish']>[0]) { return this.knowledge.publish(input); }
  revokeWorkspaceKnowledge(input: Parameters<KnowledgePublicationService['revoke']>[0]) { return this.knowledge.revoke(input); }
  releaseWorkspaceKnowledgePublicationPreview(preview: Parameters<KnowledgePublicationService['releasePreview']>[0]): void { this.knowledge.publicationService.releasePreview(preview); }
  getWorkspaceKnowledgePublication(workspaceId: string, publicationId: string) { return this.knowledge.getPublication(workspaceId, publicationId); }
  getWorkspaceKnowledgePublicationRecord(workspaceId: string, publicationId: string) { return this.knowledge.getPublicationRecord(workspaceId, publicationId); }
  getWorkspaceKnowledgeDocument(workspaceId: string, key: string) { return this.knowledge.getDocument(workspaceId, key); }
  getWorkspaceKnowledgeDocumentRevision(workspaceId: string, revisionId: string) { return this.knowledge.getDocumentRevision(workspaceId, revisionId); }
  getWorkspaceKnowledgePublicationReceipt(workspaceId: string, requestId: string) { return this.knowledge.getPublicationReceipt(workspaceId, requestId); }
  listWorkspaceKnowledgePublications(workspaceId: string, options: Parameters<KnowledgePublicationStorage['listPublications']>[1] = {}) { return this.knowledge.listPublications(workspaceId, options); }
  listWorkspaceKnowledgeDocumentRevisions(workspaceId: string, key: string, options: Parameters<KnowledgePublicationStorage['listDocumentRevisions']>[2] = {}) {
    return this.knowledge.listDocumentRevisions(workspaceId, key, options);
  }

  generateWorkspaceKnowledge(input: WorkspaceKnowledgeGenerationInput) { return this.knowledge.generate(input); }
  getWorkspaceKnowledgeGeneration(workspaceId: string, generationId: string) { return this.knowledge.getGeneration(workspaceId, generationId); }
  finishWorkspaceKnowledgeCandidate(input: { workspaceId: string; generationId: string; requestId: string }) { return this.knowledge.finishCandidate(input); }
  cancelWorkspaceKnowledgeGeneration(workspaceId: string, generationId: string) { return this.knowledge.cancelGeneration(workspaceId, generationId); }
  getWorkspaceKnowledgeRecoveryPreview(workspaceId: string) { return this.knowledge.recoveryPreview(workspaceId); }
  acknowledgeWorkspaceKnowledgeRecovery(input: { preview: KnowledgeGenerationRecoveryPreview; requestId: string; reason: string; acknowledged: true }) {
    return this.knowledge.acknowledgeRecovery(input);
  }
  resumeWorkspaceKnowledge(input: { workspaceId: string; requestId: string; expectedRevision: number; expectedFrontierSha256: string }) {
    return this.knowledge.resume(input);
  }

  private refreshToolScopes(): void {
    this.toolRuntime.setIncludedScopes('engine', [...this.plugins.list().map(plugin => plugin.scopeId), ...[...this.mcp.values()].map(connection => connection.scopeId)]);
  }

  async activatePlugin(plugin: EnginePlugin, signal?: AbortSignal): Promise<ActivePlugin> {
    this.lifetime.assertOpen();
    if(this.enabled.sandbox)throw new EngineError('SANDBOX_PLUGIN_UNSUPPORTED','Plugin effects cannot assert sandbox enforcement');
    const active = await this.plugins.activate(plugin, this.lifetime.hostSignal(signal));
    try { this.refreshToolScopes(); return active; }
    catch (error) { await this.plugins.deactivate(active.id); throw error; }
  }

  async deactivatePlugin(id: string): Promise<void> { await this.plugins.deactivate(id); this.refreshToolScopes(); }

  async connectMcp(client: McpClient, signal?: AbortSignal): Promise<{ id: string; scopeId: string; toolNames: string[]; resources: McpRegistration['resources'] }> {
    this.lifetime.assertOpen();
    if (this.mcp.has(client.id) || this.pendingMcp.has(client.id)) throw new EngineError('MCP_ALREADY_CONNECTED', 'MCP ID is already connected or connecting');
    if (this.mcp.size + this.pendingMcp.size >= 32) throw new EngineError('MCP_CONNECTION_LIMIT', 'Too many engine MCP connections');
    if(this.enabled.sandbox&&!this.sandboxHost.hasMcp(client))throw new EngineError('SANDBOX_MCP_UNSUPPORTED','Only actual sandbox-owned stdio transports are admitted');
    const pending = registerMcp(client, this.toolRuntime, this.lifetime.hostSignal(signal));
    this.mcpClients.set(client.id, client);
    this.pendingMcp.set(client.id, pending);
    let connection: McpRegistration | undefined;
    try {
      connection = await pending;
      if (this.lifetime.closing) throw new EngineError('ENGINE_CLOSED', 'Engine closed during MCP connection');
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
    this.lifetime.assertOpen();
    return this.store.integrityCheck();
  }

  /** Session-bound, bounded host observation; summaries are separate from ordinary Attempts. */
  getAttemptCleanup(sessionId: string, attemptId: string) {
    this.lifetime.assertOpen();
    this.store.getSession(sessionId);
    return this.store.getAttemptCleanup(attemptId, sessionId);
  }

  /** Exact session-bound MCP receipt observation; it grants no retry or recovery authority. */
  getMcpExecution(sessionId: string, toolCallId: string) {
    this.lifetime.assertOpen();
    this.store.getSession(sessionId);
    return this.store.getMcpExecution(toolCallId, sessionId);
  }

  getSummaryAttempt(sessionId: string, summaryAttemptId: string) {
    this.lifetime.assertOpen();
    this.store.getSession(sessionId);
    return this.store.getSummaryAttempt(summaryAttemptId, sessionId);
  }

  getSummaryUsage(sessionId: string, summaryAttemptId: string) {
    this.lifetime.assertOpen();
    this.store.getSession(sessionId);
    return this.store.getSummaryUsage(summaryAttemptId, sessionId);
  }

  listSummaryAttempts(sessionId: string, options?: SummaryAttemptListOptions) {
    this.lifetime.assertOpen();
    return this.store.listSummaryAttempts(sessionId, options);
  }

  /** Host preview only; it never confirms cleanup, replays providers or changes session control. */
  getSummaryRecoveryPreview(sessionId: string, summaryAttemptId: string) {
    this.lifetime.assertOpen();
    return this.store.getSummaryRecoveryPreview(sessionId, summaryAttemptId);
  }

  acknowledgeSummaryRecovery(request: SummaryRecoveryRequest): Promise<SummaryRecoveryReceipt> {
    return this.acknowledgeRecovery(() => validateSummaryRecoveryRequest(request), prepared => this.store.findSummaryRecoveryReceipt(prepared),
      prepared => this.store.acknowledgeSummaryRecovery(prepared));
  }

  getProviderRecoveryPreview(sessionId: string, attemptId: string) {
    this.lifetime.assertOpen();
    return this.store.getProviderRecoveryPreview(sessionId, attemptId);
  }

  acknowledgeProviderRecovery(request: ProviderRecoveryRequest): Promise<ProviderRecoveryReceipt> {
    return this.acknowledgeRecovery(() => validateProviderRecoveryRequest(request), prepared => this.store.findProviderRecoveryReceipt(prepared),
      prepared => this.store.acknowledgeProviderRecovery(prepared));
  }

  private acknowledgeRecovery<P extends { sessionId: string }, R>(prepare: () => P, find: (prepared: P) => R | null | undefined, acknowledge: (prepared: P) => R): Promise<R> {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertOpen();
      const prepared = prepare(), existing = find(prepared);
      if (existing) return Promise.resolve(existing);
      return this.recoveryGate.decide(this.store.getSession(prepared.sessionId).workspaceId, { idle: true, hold: true }, () => acknowledge(prepared));
    });
  }

  backup(destination: string, options?: StoreBackupOptions): Promise<DatabaseBackup> {
    return this.lifetime.rejecting(() => {
      this.lifetime.assertOpen();
      return this.store.backup(destination, options);
    });
  }

  /** Explicit host observation. Never scans files as a side effect of a model turn. */
  async getStorageUsage(options: EngineStorageUsageOptions = {}): Promise<EngineStorageUsageReport> {
    this.lifetime.assertOpen();
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['signal', 'limits'].includes(key))) throw new EngineError('INVALID_STORAGE_USAGE_OPTIONS', 'Storage inspection accepts only signal and bounded limits');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new EngineError('INVALID_STORAGE_USAGE_OPTIONS', 'Storage inspection requires an AbortSignal');
    const signal = this.lifetime.hostSignal(options.signal);
    const imageIndex = this.store.inspectInputImageIndex({ signal });
    const documentIndex = this.store.inspectInputDocumentIndex({ signal });
    return await this.lifetime.track(inspectEngineStorage({ ...this.storage.paths, signal, ...(options.limits === undefined ? {} : { limits: options.limits }), imageIndex, documentIndex }));
  }

  /** Explicit bounded index observation of selected, durably bound managed children. */
  async getChildDocumentStorageUsage(value: EngineChildDocumentStorageOptions): Promise<EngineChildDocumentStorageReport> {
    this.lifetime.assertOpen();
    const options = validateChildDocumentStorageRequest(value);
    const signal = this.lifetime.hostSignal(options.signal);
    const operation = (async () => {
      const { maxReportBytes: _maxReportBytes, ...readLimits } = options.limits;
      const frame = createChildDocumentReadFrame({ signal, limits: readLimits });
      frame.check();
      this.storage.verify();
      const sources = this.store.inspectChildDocumentStorageSources({
        sessionId: options.sessionId, sourceRunId: options.sourceRunId, taskIds: options.taskIds,
        hostIdentity: this.storage.identity, childrenDirectory: this.children.getStorageDirectory(), signal,
      }, frame);
      const report = await inspectChildDocumentStorage({ ...sources, frame, limits: options.limits });
      if (signal.aborted) throw new EngineError('CANCELLED', 'Child storage inspection was cancelled');
      this.storage.verify();
      return report;
    })();
    try { return await this.lifetime.track(operation); }
    catch (error) {
      if (signal.aborted) throw new EngineError('CANCELLED', 'Child storage inspection was cancelled');
      throw error;
    }
  }

  importImage(sessionId: string, data: Uint8Array, mimeType: InputImageAttachment['mimeType'], signal?: AbortSignal): Promise<InputImageAttachment> {
    return this.media.importImage(sessionId, data, mimeType, signal);
  }

  /** Host-only bounded import. References carry no path, filename or raw bytes. */
  importDocument(sessionId: string, data: Uint8Array, signal?: AbortSignal): Promise<InputDocumentAttachment> {
    return this.media.importDocument(sessionId, data, signal);
  }

  /** Host-only read of a native media Part; archive/reopened DATA never dispatches a provider. */
  readMediaOutput(input: { sessionId: string; partId: string; offset?: number; limit?: number; signal?: AbortSignal }) { return this.media.readOutput(input); }
  getMediaCapabilities(providerId:string,modelId:string){return this.media.capabilities(providerId,modelId);}

  importMedia(sessionId:string,data:Uint8Array,mimeType:InputMediaAttachment['mimeType'],segments:readonly InputMediaSegment[],signal?:AbortSignal):Promise<InputMediaAttachment>{
    return this.media.importMedia(sessionId, data, mimeType, segments, signal);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifetime.closing = true;
    const closed = Promise.withResolvers<void>();
    this.closePromise = closed.promise;
    void (async () => {
      try {
        this.lifetime.resources.abort();
        this.questions.close();
        this.teamService.close();
        this.teamModelHost.close();
        this.commandJobModelHost.close();
        this.teamHost.close();
        this.conversationForkHost.close();
        this.jobHost.close();
        this.jobDelivery.close();
        this.ownedCommandDelivery.close();
        this.hostCommandDelivery.close();
        // Every closer below is invoked while this array is built, before any is awaited;
        // scheduler.close() and coordinator.close() stop admissions in that synchronous step.
        const outcomes = await Promise.allSettled([
          this.commandLifetimes.close(), this.hostCommands.close(), this.gitCommitHost.close(), this.prFeedbackHost.close(), this.backendHost.close(),
          this.scheduleDispatcher.close(), this.codingBatches.close(), this.workflowService.close(), this.proposals.applyService.close(), this.proposals.service.close(),
          this.proposals.overlay.close(), this.knowledge.importService.close(), this.knowledge.filePublicationService.close(), this.scheduler.close(), this.coordinator.close(),
          this.children.close(), this.changes.close(), this.lsp.close(),
          ...this.languageSync.consumersDone(),
          ...[...this.lifetime.pending].map(operation => operation.catch(() => {})),
          this.terminals.close(), this.plugins.close(),
          ...[...this.mcpClients.values()].map(client => client.close()),
          ...[...this.mcp.keys()].map(id => this.disconnectMcp(id)),
          ...[...this.pendingMcp.values()].map(pending => pending.catch(() => {})),
        ]);
        this.knowledge.releaseRecoveryPreviews();
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        await this.executionObserver.close();
        try {
          this.terminalJournal.close();
        } finally {
          try {
            this.reviewJournal.close();
          } finally {
            try {
              await this.codeModeHost.close();
              this.workflowEffects.close();
              this.workflowModelTools.close();
              this.hostCommandDeliveryProducer.close();
              this.hostCommandDeliverySource.close();
              this.ownedCommandProducer.close();
              this.ownedCommandHost.close();
              this.jobProducer.close();
              this.backendProducer.close();
              this.scheduleProducer.close();
              await this.store.closeAsync();
            } finally {
              this.removeOwnedArtifactDir();
            }
          }
        }
      }
    })().then(closed.resolve, closed.reject);
    return this.closePromise;
  }
}

export function createEngine(options: EngineOptions): MoodcodeEngine { return new MoodcodeEngine(options); }
