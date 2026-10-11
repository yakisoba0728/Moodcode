import {CommandLifetimeService,createCommandLifetimeTools} from './jobs/command-lifetime.js';
import {EffectBatchHost} from './effect-batches/host.js';
import {CodeModeHost} from './code-mode/host.js';
import {jobJson} from './jobs/validation.js';
import { MediaSegmentStore } from './media/segment-store.js';
import { providerSegments } from './media/segment-provider.js';
import { PrFeedbackHost } from './pr-feedback/host.js';
import {EngineHostCommandDeliveryProducer} from './jobs/host-command-delivery-producer.js';
import {EngineHostCommandDeliverySource} from './jobs/host-command-delivery-source.js';
import {HostCommandDelivery} from './jobs/host-command-delivery.js';
import {CommandJobModelHost,createCommandJobModelTools,type BindCommandJobModelToolsInput} from './jobs/command-model-tools.js';
import {captureCommandReadSource} from './jobs/command-read-sources.js';

import { CodingBatchHost } from "./coding-runs/batch-host.js";
import { WorkflowEffects, WORKFLOW_MODEL_NAMES } from "./workflows/effects.js";
import {SandboxHost} from './sandbox/host.js';
import type {PreviewSandboxGrantInput,ApproveSandboxGrantInput} from './sandbox/types.js';
import { TeamWorkflowBoard, teamBoardKind, validateTeamBoardRecord } from './teams/workflow-board.js';
import { assertResidentProviderDispatch } from './child-tasks/resident.js';
import { HostCommandService } from './jobs/host-command-service.js';
import { GitCommitHost } from './git/commit-host.js';
import { ConversationForkHost } from './sessions/fork-host.js';
import type { CaptureForkPreviewInput, ForkCommitInput } from './sessions/fork-types.js';
import { constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { types } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { EngineError, isTerminal, SCHEMA_VERSION, SESSION_SCHEMA_VERSION, type CommandEnvelope, type CommandResult, type EngineCapabilities, type EngineEvent, type InputCursor, type InputDocumentAttachment, type InputImageAttachment, type InputMediaAttachment, type InputMediaSegment, type JsonValue, type ReasoningEffort, type Run, type RunConfig, type RunConfigInput, type Session, type SessionCommandResult, type SessionEventV2 } from '@moodcode/contracts';
import { assertInputMediaBudget, normalizeAcceptInput, normalizeEngineBudgets, normalizeRunConfig, normalizeSubmitInput, validateCommand, validateSessionCommand } from '@moodcode/contracts/validation';
import type { PreparedTool, ProviderAdapter, ProviderEvent, ToolContext, ToolDefinition } from './ports.js';
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
import { ProposalOverlayContextSource, proposalContextPolicy, type ProposalContextPolicy } from './proposals/overlay.js';
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
import { validateHostGenerationRequest, type HostGenerationProviderPort, type HostGenerationRequest } from './provider/generation.js';
import { ApprovalManager } from './permission/index.js';
import { openWorkspace } from './workspace/index.js';
import { getWorkspaceStatus, listWorkspaceFiles, readWorkspaceFile } from './workspace/presentation.js';
import { ContextService } from './context/service.js';
import { ModelRegistry, type ModelSpec } from './context/model-spec.js';
import { createReadTools } from './tools/read/index.js';
import { createPatchTool } from './tools/patch/index.js';
import { createCommandTool } from './tools/command/index.js';
import type { CommandExecutionCompletion } from './tools/command/observation.js';
import { commandBackendCapability } from './tools/command/backends.js';
import { registerCredentialEnvNames } from './tools/command/process-control.js';
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
import type { ChildStorageHostIdentity } from './child-tasks/storage-binding.js';
import type { ChildTaskManager, ChildTaskRecord } from './child-tasks/index.js';
import type { WorktreeManager } from './worktrees/index.js';
import { createChildMergeTool } from './child-tasks/merge.js';
import { LspManager, type LspFactory } from './lsp/index.js';
import { FormatterRegistry, createFormatTool, createLspFormatTool } from './formatters/index.js';
import { WorkspaceChangeHub, type WorkspaceChangeWatch, type WorkspaceFileChange } from './workspace/changes.js';
import { assertExecutionLockAvailable, inspectExecutionLock, acquireExecutionLock, reserveExecutionLock, readExecutionLockReservation } from './tools/command/execution-lock.js';
import { getReviewDiff, previewRestoreCheckpoint, restoreCheckpoint, type RestoreResult } from './review/index.js';
import { readRecoveryAcknowledgments, isRestoreAcknowledged } from './recovery/index.js';
import { validateSummaryRecoveryRequest, type SummaryRecoveryRequest, type SummaryRecoveryReceipt } from './recovery/summary.js';
import { validateProviderRecoveryRequest, type ProviderRecoveryRequest, type ProviderRecoveryReceipt } from './recovery/provider.js';
import { ReviewJournal, type RestoreOperation, type RestoreOperationInput } from './review/audit.js';
import { ImageAttachmentStore } from './media/index.js';
import { providerImages } from './media/provider.js';
import { DocumentAttachmentStore } from './documents/store.js';
import { providerDocuments } from './documents/provider.js';
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
  /** Actual Darwin kernel sandbox, explicit grants, never a host fallback. */
  osSandbox?:boolean;
  /** Actual OS-isolated closed JSON runtime, with individual nested native approvals. */
  codeMode?:boolean;
  /** Original producer observations; bounded physical reads are disabled by default. */
  diagnosticObservations?: boolean;
  diagnosticSourceLimits?: Partial<WorkspaceExecutionSourceLimits>;
  dbPath: string;
  /** Host credential variable names stripped from every child environment of this process, besides the built-in list. */
  credentialEnvNames?: readonly string[];
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
  /** Idle host Git commits require an exact Original preview and actual verification. */
  gitCommits?: boolean;
  prFeedback?: boolean;
  prFeedbackLoopback?: boolean;
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
  /** Explicit readonly catalogue plus separately host-bound job aliases; children do not inherit. */
  commandJobModelTools?: boolean;
  residentTeams?: boolean;
  /** Explicit host workflow orchestration through isolated actual child executions. */
  workflows?: boolean;
  /** Explicit root lifetime and durable queue-only scheduled input admission. */

codingBatches?: boolean;
schedules?: boolean;
  /** Root-owned ACP v1 stdio providers; imported definitions do not restore runtime authority. */
  agentBackends?: boolean;
  agentBackendClientEffects?: boolean;
  /** Explicit read-only observation of existing user-owned terminals as native jobs. */
  jobs?: boolean;
  /** Exact prepared-resource parallel effects; root opt-in, children remain serial. */
  effectBatches?: boolean;
  /** Explicit independent idle-workspace command owner; disabled by default. */
  hostCommands?: boolean;
  commandLifetimes?: boolean;
  /** Exact host-approved bounded conversation forks; execution approvals are never inherited. */
  conversationForks?: boolean;
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
  /** Explicitly admit media whose token cost remains unknown. */
  allowUnknownMediaTokenCost?: boolean;
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

function assertMediaCommandData(value:unknown):void{
  if(types.isProxy(value))throw new EngineError('INVALID_INPUT','command must be an inspectable JSON object',{path:'command'});if(!value||typeof value!=='object')return;const p=Object.getOwnPropertyDescriptor(value,'payload');if(!p||!('value'in p)||!p.value||typeof p.value!=='object')return;if(types.isProxy(p.value))throw new EngineError('INVALID_INPUT','payload must be an inspectable JSON object',{path:'payload'});const m=Object.getOwnPropertyDescriptor(p.value,'media');if(m&&'value'in m)jobJson(m.value,65536);
}

function assertSegmentSupport(provider:ProviderAdapter|undefined,models:ModelRegistry,modelId:string,refs:readonly InputMediaAttachment[],allowUnknown:boolean):void{
  const caps=provider?models.get(provider.id,modelId).mediaCapabilities:null;
  for(const ref of refs)if(provider?.supportsInputMedia?.(modelId,ref.kind)!==true||(ref.kind==='audio'?caps?.audioInput:caps?.videoFrames)!==true)throw new EngineError('PROVIDER_UNSUPPORTED_INPUT','Selected provider and exact model require verified media support');
  if(provider?.requestedOutputMedia?.(modelId)&&caps?.audioOutput!==true)throw new EngineError('PROVIDER_UNSUPPORTED_OUTPUT','Selected exact model requires verified audio output support');
  if((refs.length||provider?.requestedOutputMedia?.(modelId))&&!allowUnknown)throw new EngineError('MEDIA_TOKEN_COST_UNKNOWN','Media token cost is unknown and requires explicit host policy');
}

function withInputMedia(provider: ProviderAdapter, images: ImageAttachmentStore, documents: DocumentAttachmentStore, segments:MediaSegmentStore, store: SqliteStore, models: ModelRegistry, allowUnknownTokenCost: boolean, allowMediaCost:boolean): ProviderAdapter {
  return { id: provider.id,
    ...(provider.supportsInputMedia?{supportsInputMedia:(modelId:string,kind:'audio'|'video')=>provider.supportsInputMedia!(modelId,kind)}:{}),
    ...(provider.requestedOutputMedia?{requestedOutputMedia:(modelId:string)=>provider.requestedOutputMedia!(modelId)}:{}), ...(provider.replayProtocol ? { replayProtocol: provider.replayProtocol } : {}),
    ...(provider.retryableHttpStatuses ? { retryableHttpStatuses: provider.retryableHttpStatuses } : {}),
    ...(provider.inputModalities ? { inputModalities: provider.inputModalities } : {}),
    ...(provider.inputFileTypes ? { inputFileTypes: provider.inputFileTypes } : {}),
    ...(provider.allowUnknownDocumentTokenCost === undefined ? {} : { allowUnknownDocumentTokenCost: provider.allowUnknownDocumentTokenCost }),
    ...(provider.supportsInputFile ? { supportsInputFile: (modelId: string, mimeType: 'application/pdf') => provider.supportsInputFile!(modelId, mimeType) } : {}),
    ...(provider.streamGeneration ? { streamGeneration(request: HostGenerationRequest, signal: AbortSignal) {
      return provider.streamGeneration!(validateHostGenerationRequest(request), signal);
    } } : {}),
    streamTurn(request, signal) {
      let iterator: AsyncIterator<ProviderEvent> | undefined, initialization: Promise<void> | undefined;
      let providerEntered = false, confirmedDone = false;
      const initialize = () => initialization ??= (async () => {
        if (request.resolvedImages !== undefined || request.resolvedDocuments !== undefined || request.resolvedMedia !== undefined) throw new EngineError('PROVIDER_INVALID_REQUEST', 'Input bytes must be resolved by the engine');
        const refs = new Map<string, InputImageAttachment>();
        const documentRefs = new Map<string, InputDocumentAttachment>();
        const segmentRefs = new Map<string,InputMediaAttachment>();
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
        for(const message of request.messages)for(const ref of message.media??[]){if(message.role!=='user')throw new EngineError('PROVIDER_INVALID_REQUEST','Media references belong to user inputs');const old=segmentRefs.get(ref.id);if(old&&JSON.stringify(old)!==JSON.stringify(ref))throw new EngineError('PROVIDER_INVALID_REQUEST','Conflicting media references');segmentRefs.set(ref.id,ref);}
        assertSegmentSupport(provider,models,request.modelId,[...segmentRefs.values()],allowMediaCost);
        let resolved = request;
        if (refs.size || documentRefs.size || segmentRefs.size) {
          const run = store.getRun(request.runId);
          if (request.sessionId !== run.sessionId) throw new EngineError('RECORD_SCOPE_MISMATCH', 'Input request belongs to another session');
          if (documentRefs.size) assertDocumentSupport(provider, models, { providerId: provider.id, modelId: request.modelId }, allowUnknownTokenCost);
          if (refs.size) {
            const modalities = models.get(provider.id, request.modelId).modalities;
            if (!provider.inputModalities?.includes('image') || modalities !== null && !modalities.includes('image')) throw new EngineError('PROVIDER_UNSUPPORTED_INPUT', 'Selected provider or model does not support image input');
            resolved = { ...resolved, resolvedImages: await images.resolve(run.sessionId, [...refs.values()], signal) };
          }
          if (documentRefs.size) resolved = { ...resolved, resolvedDocuments: await documents.resolve(run.sessionId, [...documentRefs.values()], signal) };
          if(segmentRefs.size)resolved={...resolved,resolvedMedia:await segments.resolve(run.sessionId,[...segmentRefs.values()],signal)};
          const decoded=providerSegments(resolved,kind=>provider.supportsInputMedia?.(request.modelId,kind)===true,signal);
          const assetBytes=[...decoded.values()].reduce((sum,v)=>sum+v.assets.reduce((n,a)=>n+a.bytes.length,0),0);
          if([...refs.values()].reduce((sum,v)=>sum+v.bytes,0)+[...documentRefs.values()].reduce((sum,v)=>sum+v.bytes,0)+assetBytes>1048576)throw new EngineError('INPUT_MEDIA_LIMIT','Combined input media wire budget exceeded');
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
  private readonly segments:MediaSegmentStore;
  private readonly mediaCapabilities:(providerId:string,modelId:string)=>{audioInput:boolean;videoFrames:boolean;audioOutput:boolean;unknownTokenCostAllowed:boolean;tokenCost:null;source:ModelSpec['source']};
  private readonly validateSegmentInput:(sessionId:string,config:RunConfig,refs:InputMediaAttachment[])=>Promise<void>;
  private readonly documents: DocumentAttachmentStore;
  private readonly pendingImages = new Set<Promise<unknown>>();
  private readonly pendingStorage = new Set<Promise<unknown>>();
  private readonly storagePaths: { artifactDir: string; dbPath?: string };
  private readonly ownedArtifactDir: string | undefined;
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
  private readonly knowledgeHost: KnowledgeHostAdapter;
  private readonly knowledgeGenerationEnabled: boolean;
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
  private readonly commandJobModelHost: CommandJobModelHost;
  private readonly commandJobModelDefinitions: readonly ToolDefinition[];
  private readonly teamModelHost: EngineTeamModelToolHost;
  private readonly teamModelDefinitions: readonly ToolDefinition[];
  private readonly workflowsEnabled: boolean;

private readonly codingBatchesEnabled: boolean;
  private readonly codingBatches: CodingBatchHost;
  private codingBatchDispatchGuard?: () => void;
  private codingBatchCharge?: () => void;
private readonly workflowRecords: WorkflowStorage;
  private readonly workflowHost: WorkflowHost;
  private readonly workflowService: WorkflowService;
  private readonly workflowEffects:WorkflowEffects;
  private readonly schedulesEnabled: boolean;
  private readonly scheduleRecords: ScheduleStorage;
  private readonly scheduleProducer: EngineScheduleProducer;
  private readonly scheduleDispatcher: ScheduleDispatcher;
  private readonly agentBackendsEnabled: boolean;
  private readonly backendProducer: EngineAgentBackendProducer;
  private readonly backendRecords: AgentBackendStorage;
  private readonly backendProcesses: OwnedBackendProcesses;
  private readonly backendHost: AgentBackendHost;
  private readonly codeModeHost:CodeModeHost;
  private readonly jobsEnabled: boolean;
  private readonly conversationForkHost: ConversationForkHost;
  private readonly conversationForksEnabled: boolean;
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
  private readonly sandboxEnabled:boolean;
  private readonly ownedCommandProducer: EngineOwnedCommandDeliveryProducer;
  private readonly ownedCommandDelivery: OwnedCommandDelivery;
  private readonly runtimeProviders: Map<string, ProviderAdapter>;
  private readonly backendProviderIds = new Set<string>();
  private readonly knowledgeRecoveryPreviews = new WeakMap<KnowledgeGenerationRecoveryPreview, string>();
  private readonly liveKnowledgeRecoveryPreviews = new Map<string, KnowledgeGenerationRecoveryPreview>();
  private readonly verificationHost: VerificationHostService;
  private readonly verificationEnabled: boolean;
  readonly formatters: FormatterRegistry;
  readonly changes: WorkspaceChangeHub;
  private readonly watchConsumers = new Map<string, { seq: number; running: boolean; done: Promise<void> }>();
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
  private readonly capabilities: Omit<EngineCapabilities, 'providerIds' | 'tools'>;
  private readonly gitCommitHost: GitCommitHost;
  private readonly prFeedbackHost: PrFeedbackHost;
  private readonly executionLockPath: string;
  private readonly restoreRequests = new Map<string, { binding: RestoreOperationInput; promise: Promise<RestoreCommandResult> }>();

  constructor(options: EngineOptions) {
    this.sandboxEnabled=options.osSandbox===true;
    if (!options || typeof options.dbPath !== 'string' || options.dbPath.length === 0) {
      throw new EngineError('INVALID_CONFIG', 'dbPath must be a non-empty string');
    }
    const credentialEnvNames: unknown = options.credentialEnvNames;
    if (credentialEnvNames !== undefined) {
      const names = Array.isArray(credentialEnvNames) && credentialEnvNames.length <= 256 ? Array.from(credentialEnvNames as unknown[]) : undefined;
      if (!names?.every((name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)))
        throw new EngineError('INVALID_CONFIG', 'credentialEnvNames must list at most 256 environment variable names');
      registerCredentialEnvNames(names);
    }
    const repositoryPolicy = options.repositoryContextPolicy !== undefined ? repositoryContextPolicy(options.repositoryContextPolicy) : undefined;
    const knowledgePolicy = options.knowledgeContextPolicy === undefined ? undefined : knowledgeContextPolicy(options.knowledgeContextPolicy);
    const proposalPolicy = options.proposalContextPolicy === undefined ? undefined : proposalContextPolicy(options.proposalContextPolicy);
    if (options.lifecycleHookRegistry !== undefined && !(options.lifecycleHookRegistry instanceof LifecycleHookRegistry)) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Shared hook registry requires an explicit trusted host registry');
    if (options.lifecycleHookRegistry && options.lifecycleHooks !== undefined) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Specify one host registry or initial hook registrations');
    this.lifecycleHooks = options.lifecycleHookRegistry ?? new LifecycleHookRegistry();
    if (options.lifecycleContextSlotBytes !== undefined && (!Number.isSafeInteger(options.lifecycleContextSlotBytes) || options.lifecycleContextSlotBytes < 128 || options.lifecycleContextSlotBytes > 16_384))
      throw new EngineError('INVALID_LIFECYCLE_CONTEXT', 'Lifecycle context slot must be between 128 and 16384 bytes');
    this.assertOptionalBoolean(options, 'lifecycleContinuation', 'Lifecycle continuation requires an explicit host boolean');
    if (options.roleResourcePolicyRegistry !== undefined && !(options.roleResourcePolicyRegistry instanceof RoleResourcePolicyRegistry)) throw new EngineError('INVALID_ROLE_POLICY_CONFIGURATION', 'Shared role policy requires a trusted host registry');
    if (options.roleResourcePolicyRegistry && options.roleResourcePolicy) throw new EngineError('INVALID_ROLE_POLICY_CONFIGURATION', 'Specify one role policy registry or immutable role policy');
    this.roleResourcePolicyRegistry = options.roleResourcePolicyRegistry;
    for (const flag of [options.prFeedback,options.prFeedbackLoopback]) if (flag!==undefined&&typeof flag!=='boolean') throw new EngineError('INVALID_CONFIG','PR feedback requires explicit host boolean opt-in');
    this.assertOptionalBoolean(options, 'verificationTools', 'Verification tool exposure must be an explicit boolean');
    this.verificationEnabled = options.verificationTools === true;
    this.assertOptionalBoolean(options, 'knowledgeGeneration', 'Knowledge generation requires an explicit host boolean');
    this.knowledgeGenerationEnabled = options.knowledgeGeneration === true;
    this.assertOptionalBoolean(options, 'knowledgePublication', 'Knowledge publication requires an explicit host boolean');
    this.knowledgePublicationEnabled = options.knowledgePublication === true;
    this.assertOptionalBoolean(options, 'knowledgeFilePublication', 'Knowledge file publication requires an explicit host boolean');
    this.knowledgeFilePublicationEnabled = options.knowledgeFilePublication === true;
    this.assertOptionalBoolean(options, 'knowledgeImportRecovery', 'knowledgeImportRecovery must be an explicit boolean');
    this.knowledgeImportRecoveryEnabled = options.knowledgeImportRecovery === true;
    this.assertOptionalBoolean(options, 'proposals', 'proposals must be an explicit boolean');
    this.assertOptionalBoolean(options, 'teams', 'teams must be an explicit boolean');
    this.teamsEnabled = options.teams === true;
    this.assertOptionalBoolean(options, 'teamModelTools', 'teamModelTools must be an explicit boolean');
    this.teamModelToolsEnabled = options.teamModelTools === true;
    this.assertOptionalBoolean(options, 'commandJobModelTools', 'commandJobModelTools must be an explicit boolean');
    this.assertOptionalBoolean(options, 'residentTeams', 'residentTeams requires explicit boolean');
    if(options.residentTeams===true&&(!this.teamModelToolsEnabled||options.teams!==true))throw new EngineError('INVALID_CONFIG','Resident teams require teams and team model tools');
    this.assertOptionalBoolean(options, 'workflows', 'workflows must be an explicit boolean');
    this.workflowsEnabled = options.workflows === true;

    this.assertOptionalBoolean(options, 'codingBatches', 'codingBatches must be explicit boolean');
    this.codingBatchesEnabled = options.codingBatches === true;
    if (
      this.codingBatchesEnabled &&
      (!this.workflowsEnabled ||
        options.verificationTools !== true ||
        options.tools)
    )
      throw new EngineError(
        "CODING_BATCH_UNSUPPORTED",
        "Coding batches require core workflow and verification tools",
      );
    this.assertOptionalBoolean(options, 'schedules', 'schedules must be an explicit boolean');
    this.schedulesEnabled = options.schedules === true;
    this.assertOptionalBoolean(options, 'agentBackends', 'agentBackends requires an explicit root host boolean');
    if (options.agentBackendSecrets !== undefined && (!options.agentBackendSecrets || typeof options.agentBackendSecrets.resolve !== 'function')) throw new EngineError('INVALID_CONFIG', 'Backend secrets require an explicit trusted host resolver');
    this.agentBackendsEnabled = options.agentBackends === true;
    this.assertOptionalBoolean(options, 'agentBackendClientEffects', 'ACP client effects require explicit host opt-in');
    if(options.agentBackendClientEffects&&!this.agentBackendsEnabled)throw new EngineError("INVALID_CONFIG","ACP effects require agentBackends opt-in");
    this.assertOptionalBoolean(options, 'jobs', 'jobs requires an explicit root host boolean');
    this.assertOptionalBoolean(options, 'codeMode', 'codeMode requires an explicit boolean');
    if(options.codeMode&&options.tools)throw new EngineError('CODE_MODE_CUSTOM_TOOLS_UNSUPPORTED','Restricted code mode requires the actual engine core tool producers');
    this.jobsEnabled = options.jobs === true;
    this.assertOptionalBoolean(options, 'effectBatches', 'effectBatches requires an explicit boolean');
    this.assertOptionalBoolean(options, 'conversationForks', 'conversationForks must be an explicit boolean');
    this.conversationForksEnabled = options.conversationForks === true;
    if (this.teamModelToolsEnabled && !this.teamsEnabled) throw new EngineError('INVALID_CONFIG', 'Model team tools require explicit host teams');
    this.proposalsEnabled = options.proposals === true;
    this.assertOptionalBoolean(options, 'proposalApply', 'proposalApply must be an explicit boolean');
    this.proposalApplyEnabled = options.proposalApply === true;
    this.assertOptionalBoolean(options, 'diagnosticObservations', 'Execution observations require an explicit host boolean');
    if (this.verificationEnabled && options.tools !== undefined) throw new EngineError('INVALID_VERIFICATION_CONFIG', 'Verification requires the engine-owned command producer and core registrations');
    this.assertOptionalBoolean(options, 'osSandbox', 'osSandbox must be an explicit boolean');
    if(options.osSandbox && (options.repositoryContextTools||options.verificationTools||options.lifecycleHooks?.length||options.lifecycleHookRegistry?.list().length))throw new EngineError('SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED','Repository/verification or host lifecycle callbacks require a separately sandbox-bound producer');
    if(options.osSandbox && options.tools)throw new EngineError('SANDBOX_CUSTOM_TOOLS_UNSUPPORTED','Custom effects cannot assert OS sandbox enforcement');
    this.assertOptionalBoolean(options, 'commandLifetimes', 'commandLifetimes requires an explicit host boolean');
    if(options.osSandbox && options.commandLifetimes===true)throw new EngineError('SANDBOX_COMMAND_LIFETIME_UNSUPPORTED','Interactive ownership transfer requires a separately sandbox-bound command lifetime producer');
    if(options.commandLifetimes===true&&(!this.jobsEnabled||options.hostCommands!==true))throw new EngineError('INVALID_CONFIG','commandLifetimes requires jobs and hostCommands');
    this.assertOptionalBoolean(options, 'hostCommands', 'hostCommands must be an explicit boolean');
    this.assertOptionalBoolean(options, 'allowUnknownMediaTokenCost', 'Media token cost policy must be a boolean');
    this.assertOptionalBoolean(options, 'allowUnknownDocumentTokenCost', 'Document token cost policy must be a boolean');
    this.assertOptionalBoolean(options, 'repositoryContextTools', 'Repository tool exposure must be an explicit boolean');
    if (options.lifecycleHooks !== undefined) {
      if (!Array.isArray(options.lifecycleHooks) || options.lifecycleHooks.length > this.lifecycleHooks.limits.maxHooks) throw new EngineError('INVALID_LIFECYCLE_HOOK', 'Initial lifecycle hooks must be a bounded explicit host list');
      for (const hook of options.lifecycleHooks) this.lifecycleHooks.register(hook);
    }
    this.defaults = normalizeRunConfig(options.defaults ?? {});
    const mediaHistoryPolicy = options.mediaHistoryPolicy === undefined ? undefined : validateMediaHistoryPolicy(options.mediaHistoryPolicy);
    const activePrefixPolicy = options.activePrefixPolicy === undefined ? undefined : validateActivePrefixPolicy(options.activePrefixPolicy);
    const documentHistoryPolicy = options.documentHistoryPolicy === undefined ? undefined : validateDocumentHistoryPolicy(options.documentHistoryPolicy);
    const toolDiscoveryPolicy = options.toolDiscoveryPolicy === undefined ? undefined : validateToolDiscoveryPolicy(options.toolDiscoveryPolicy);
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
          // A busy lock found here leaves no guard row, so the owner settles as cancelled, not uncertain.
          assertExecutionLockAvailable(this.executionLockPath);
          const reservation = reserveExecutionLock(this.executionLockPath);
          this.knowledgeFileExecutionGuards.reserve(binding, publicationId, this.executionLockPath, readExecutionLockReservation(reservation));
          try { return acquireExecutionLock(this.executionLockPath, reservation); }
          catch { throw new EngineError('KNOWLEDGE_FILE_CLEANUP_UNCERTAIN', 'File execution marker may stay committed after a failed lock acquisition'); }
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
          // A busy lock found here leaves no guard row, so the owner settles as cancelled, not uncertain.
          assertExecutionLockAvailable(this.executionLockPath);
          const reservation = reserveExecutionLock(this.executionLockPath);
          const originalGuard = this.proposalApplies.claim(capture, () =>
            this.proposalApplyGuards.reserve(owner.binding, owner.id, this.executionLockPath, readExecutionLockReservation(reservation)));
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
        if (known) interruptedFileOwners.push(known.publicationId); else if (!this.proposalApplyGuards.matching(this.executionLockPath)) {
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
      reviewJournal = new ReviewJournal(canonicalDbPath === undefined ? resolve(artifactDir, 'review.sqlite') : `${canonicalDbPath}.review.sqlite`);
      this.reviewJournal = reviewJournal;
      this.store.recoverInterrupted();
      this.store.validateGitCommits();
      this.store.createGitCommitStorage().recover();
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
      }, storageBinding, (child,sessionId,parent,parentRunId,allocation)=>{this.conversationForkHost.inheritChild(parent,child,sessionId,parentRunId,allocation);if(options.osSandbox)parent.sandboxHost.inherit(child.sandboxHost,sessionId,parentRunId);});
      const teamOwners = new EngineTeamOwners(this);
      this.teamRecords = this.store.createTeamStorage({ checkBinding: knowledgeBinding,
        readMemberOwner: original => this.teamHost.readMemberOwner(original),
        assertMemberOwnerCurrent: (original, member) => this.teamHost.assertMemberOwnerCurrent(original,member),
        assertRecipientCurrent: member => this.teamHost.assertRecipientCurrent(member),
        readAcceptedInput: (capture, original) => this.teamService.readAcceptedInput(capture,original) });
      this.teamHost = new TeamHostService({ native: this.teamRecords, owner: teamOwners });
      const nativeTeams = this.teamRecords;
      this.teamService = new TeamService({ beforeCompleteTask:input=>{const member=nativeTeams.getMember(input.workspaceId,input.teamId,input.memberId);if(member){const doc=this.store.getSessionDocument(member.owner.rootSessionId,teamBoardKind(input.teamId,input.taskId));if(doc&&validateTeamBoardRecord(doc.data).submissions.at(-1)?.review?.verdict!=='accept')throw new EngineError('TEAM_REVIEW_REQUIRED','Submitted advisory DATA requires independent approved review');}},host: this.teamHost, native: {
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
          return { currentRunId: proof.kind==='child'?this.children.currentTeamRunId(proof):proof.runId, store: actual.store, coordinator: actual.coordinator, executionLockPath: actual.executionLockPath, artifactDir: actual.storagePaths.artifactDir };
        }, assertEnabled: () => {
          this.assertTeamsEnabled();
          if (!this.teamModelToolsEnabled) throw new EngineError('TEAM_MODEL_DISABLED', 'Model team tools require explicit host opt-in');
        },
      });
      this.teamModelDefinitions = this.teamModelToolsEnabled ? createTeamModelTools(this.teamModelHost.port()) : consumeChildTeamModelCatalogue(options);
      this.commandJobModelHost=new CommandJobModelHost(this,()=>options.commandJobModelTools===true&&this.jobsEnabled&&!this.closing,(selection,workspaceId)=>captureCommandReadSource(this,this.jobProducer,selection,workspaceId));
      this.commandJobModelDefinitions=options.commandJobModelTools===true&&this.jobsEnabled?createCommandJobModelTools(this.commandJobModelHost):[];
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
      this.workflowEffects=new WorkflowEffects(this,knowledgeBinding,()=>this.workflowService,workflowOwners,workflowChildren,!options.tools&&this.verificationEnabled,this.workflowsEnabled);
      const effectNative=this.store.createWorkflowEffectStorage({readEffect:o=>this.workflowEffects.readEffect(o),assertEffect:o=>this.workflowEffects.assertEffect(o),readTarget:o=>this.workflowEffects.readTarget(o),assertTarget:o=>this.workflowEffects.assertTarget(o),accept:(o,i)=>this.workflowEffects.accept(o,i)});
      this.workflowEffects.install(effectNative);
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
        this.codingBatchesEnabled,
      );
terminalJournal = new SqliteTerminalJournal(join(realpathSync(artifactDir), 'terminals.sqlite'));
      this.terminalJournal = terminalJournal;
      this.terminals = new TerminalService({ journal: terminalJournal, ...(options.ptyBackend ? { backend: options.ptyBackend } : {}), resolveOwner: owner => {
        const session = this.store.getSession(owner.sessionId);
        if (session.workspaceId !== owner.workspaceId) throw new EngineError('TERMINAL_AUTHORITY', 'Terminal session belongs to a different workspace');
        return { sessionId: session.id, workspaceId: session.workspaceId, root: this.store.getWorkspace(session.workspaceId).root };
      } });
      const allowMediaCost=options.allowUnknownMediaTokenCost===true;
      const models = new ModelRegistry();
      for (const spec of options.modelSpecs ?? []) models.put(spec);
      this.images = new ImageAttachmentStore({ directory: join(realpathSync(artifactDir), 'input-media'), documents: this.store });
      this.segments=new MediaSegmentStore({directory:join(realpathSync(artifactDir),'input-segments'),documents:this.store});
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
      this.mediaCapabilities=(providerId,modelId)=>{const spec=models.get(providerId,modelId),provider=providers.get(providerId);return{audioInput:spec.mediaCapabilities?.audioInput===true&&provider?.supportsInputMedia?.(modelId,'audio')===true,videoFrames:spec.mediaCapabilities?.videoFrames===true&&provider?.supportsInputMedia?.(modelId,'video')===true,audioOutput:spec.mediaCapabilities?.audioOutput===true&&provider?.requestedOutputMedia?.(modelId)==='audio/wav',unknownTokenCostAllowed:allowMediaCost,tokenCost:null,source:spec.source};};
      this.validateSegmentInput=async(sessionId,config,refs)=>{assertSegmentSupport(providers.get(config.providerId),models,config.modelId,refs,allowMediaCost);await this.segments.resolve(sessionId,refs,this.hostResources.signal);};
      for (const [id, provider] of providers) providers.set(id, withInputMedia(provider, this.images, this.documents, this.segments,this.store, models, options.allowUnknownDocumentTokenCost === true,allowMediaCost));
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
      this.context = new ContextService(this.store, models, options.outputTokenReserve, id => providers.get(id), { lifecycleHooks: options.osSandbox ? undefined : this.lifecycleHooks,
        conversationFork: { prepare:(sessionId,config)=>this.conversationForkHost.context(sessionId,config), assertFresh:(sessionId,sha,config)=>this.conversationForkHost.assertContext(sessionId,sha,config) },
        ...(options.lifecycleContextSlotBytes === undefined ? {} : { lifecycleContextSlotBytes: options.lifecycleContextSlotBytes }),
        ...(mediaHistoryPolicy ? { mediaHistoryPolicy } : {}), ...(activePrefixPolicy ? { activePrefixPolicy } : {}), ...(documentHistoryPolicy ? { documentHistoryPolicy } : {}), ...(repositoryPolicy ? { repositoryContext: { source: new RepositoryContextSource(this.repository), policy: repositoryPolicy } } : {}), ...(knowledgeContext ? { knowledgeContext } : {}), ...(proposalContext ? { proposalContext } : {}) });
      if (options.toolPolicy && options.toolPolicyInstance) throw new EngineError('INVALID_TOOL_POLICY', 'Specify rules or one trusted policy instance');
      const commandObserver = (this.jobsEnabled || options.osSandbox) ? {
        beforeSpawn:(context:ToolContext,prepared:PreparedTool)=>{
          const own= this.jobsEnabled ? this.ownedCommandHost.beforeSpawn(context,prepared) : undefined;
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
      this.childToolNames = Object.freeze([...(options.tools ?? allCoreTools.filter(tool => tool.name !== 'delegate_task' && !lifetimeTools.includes(tool))).map(tool => tool.name), ...(this.verificationEnabled ? ['verify_changes'] : []), ...(toolDiscoveryPolicy ? ['discover_tools'] : []), ...(this.teamModelToolsEnabled ? TEAM_MODEL_TOOL_NAMES : [])]);
      // Effect paths with no OS-bound producer are deliberately absent from this catalogue.
      const coreTools=options.osSandbox ? allCoreTools.filter(t=>['run_command','delegate_task'].includes(t.name)) : allCoreTools;
      const nativeFiles = [canonicalDbPath, canonicalDbPath ? `${canonicalDbPath}.owner.sqlite` : undefined, this.executionLockPath, canonicalDbPath ? `${canonicalDbPath}.review.sqlite` : undefined].filter((path): path is string => path !== undefined);
      const source = new WorkspaceExecutionSource({ checkWorkspaceBinding: workspace => {
        this.verifyChildStorageIdentity();
        if (JSON.stringify(this.store.getWorkspace(workspace.id)) !== JSON.stringify(workspace)) throw new EngineError('EXECUTION_OBSERVATION_STALE', 'Observed workspace binding changed');
      }, ...(options.diagnosticSourceLimits ? { limits: options.diagnosticSourceLimits } : {}), excludedPaths: [{ path: this.storagePaths.artifactDir, kind: 'directory' }, ...nativeFiles.flatMap(path => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`].map(path => ({ path, kind: 'file' as const })))] });
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
      const verificationTool = this.verificationEnabled ? createVerificationTool({ plans: this.verificationPlans, receipts: this.verificationReceipts, getRun: id => this.store.getRun(id), sourceObservation: (context, signal) => this.verificationHost.observe(context, AbortSignal.any([signal, this.hostResources.signal])), commandRuntime: this.toolRuntime, captureCatalogue: context => this.coordinator.captureToolCatalogue(context),
        executeCommand: (outer,nested,prepared) => this.coordinator.withVerificationCommandContext(outer,nested,()=>{ const execute = () => this.toolRuntime.execute(prepared,nested); return options.diagnosticObservations === true ? this.executionObserver.nested(outer,prepared,execute) : execute(); }),
        consumedSettlementWriter: (context, kind, revision, data) => this.coordinator.commitConsumedVerificationSettlement(context, kind, revision, data),
        commandCapability: (_context, catalogue) => {
          if (!commandRegistration) throw new EngineError('TOOL_PRODUCER_MISMATCH', 'The original engine command producer is unavailable');
          this.toolRuntime.assertRegistrationCurrent(catalogue, commandRegistration);
          return Object.freeze({ producer: 'engine-owned-run-command' as const, platform: process.platform, supported: commandBackendCapability().available, catalogueRevision: catalogue.revision });
        }, artifacts: this.managedArtifacts }) : undefined;
      const verificationTools: ToolDefinition[] = verificationTool ? [{ ...verificationTool, prepare: async (input, context) => { await this.verificationHost.ensurePlan(context, context.signal); return verificationTool.prepare(input, context); } }] : [];
      const codeModeTools:ToolDefinition[]=options.codeMode?[{name:'execute_code',description:'Execute a restricted moodcode-json-v1 program; source and nested effects require native approval.',effectClass:'execute',inputSchema:{type:'object',required:['source','allocation'],additionalProperties:false,properties:{source:{type:'string'},allocation:{type:'object'}}},prepare:(input,ctx)=>this.codeModeHost.prepare(input,ctx),execute:(p,ctx)=>this.codeModeHost.executePrepared(p,ctx)}]:[];
      const availableTools = toolDiscoveryPolicy ? [...coreTools, ...codeModeTools, ...repositoryTools, ...this.teamModelDefinitions, ...this.commandJobModelDefinitions, ...(this.workflowsEnabled?this.workflowEffects.tools():[]), createToolDiscoveryTool({
        identity: context => this.coordinator.toolDiscoveryIdentity(context),
        stage: (context, query, limit, expected, action) => this.coordinator.stageToolDiscovery(context, query, limit, expected, action),
      }), ...verificationTools] : [...coreTools, ...codeModeTools, ...repositoryTools, ...this.teamModelDefinitions, ...this.commandJobModelDefinitions, ...(this.workflowsEnabled?this.workflowEffects.tools():[]), ...verificationTools];
      if (options.allowedToolNames && (new Set(options.allowedToolNames).size !== options.allowedToolNames.length || options.allowedToolNames.some(name => !availableTools.some(tool => tool.name === name)))) throw new EngineError('INVALID_TOOL_ALLOWLIST', 'Host tool allowlist must name unique available tools');
      this.hostAllowedTools = options.allowedToolNames ? [...options.allowedToolNames] : undefined;
      const tools = options.allowedToolNames ? availableTools.filter(tool => options.allowedToolNames!.includes(tool.name)) : availableTools;
      for (const tool of tools) this.toolRuntime.register('engine', tool, (WORKFLOW_MODEL_NAMES as readonly string[]).includes(tool.name)?{exactApproval:tool.name!=='observe_workflow_stage'}:(TEAM_MODEL_TOOL_NAMES as readonly string[]).includes(tool.name) ? { exactApproval: (TEAM_MODEL_WRITE_TOOL_NAMES as readonly string[]).includes(tool.name) } : options.tools ? {} : ['delegate_task', 'verify_changes','run_command_job','command_job_input','wait_command_job','execute_code'].includes(tool.name) ? { exactApproval: true } : { revalidate: async (prepared, context) => {
        const current = await tool.prepare(prepared.input, context);
        if (current.fingerprint !== prepared.fingerprint || JSON.stringify(current.preview) !== JSON.stringify(prepared.preview)) throw new EngineError('TOOL_APPROVAL_STALE', 'Tool resources changed since scoped authorization');
      } });
      if (this.verificationEnabled && tools.includes(coreCommand)) commandRegistration = this.toolRuntime.captureRegistration('engine', 'run_command', coreCommand);
      this.plugins = new EnginePluginManager(this.toolRuntime);
      const commandCapability = commandBackendCapability();
      this.capabilities = {
        schemaVersion: SCHEMA_VERSION,
        runtime: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform, commandExecution: commandCapability.processTree === 'windows-job-object' ? 'windows-job-object' : commandCapability.available ? 'posix-process-group' : 'unsupported' },
        modes: ['plan', 'build'], defaults: structuredClone(this.defaults),
        features: { historyPaging: true, sessionMetrics: true },
        extensions: { sessionSchemaVersions: [SESSION_SCHEMA_VERSION], commands: [...NATIVE_COMMANDS_ENABLED] },
      };
      this.coordinator = new RunCoordinator({
        ...(options.effectBatches===true?{effectBatches:new EffectBatchHost({save:record=>this.store.writeEffectBatch(record),memberSettled:(record,index)=>this.store.recordEffectBatchMember(record,index),assertOpen:()=>{if(this.closing)throw new EngineError('ENGINE_CLOSED','Effect batch host closed');this.verifyChildStorageIdentity();}})}:{}),
        onCommandLifetimesSettling:(runId,outcome)=>this.commandLifetimes?.runSettling(runId,outcome)??Promise.resolve(),
        onCommandLifetimeToolSettled:record=>this.commandLifetimes?.toolSettled(record),
        beforeActualProviderRequest: (original) => {
          if (this.codingBatchCharge) {
            this.coordinator.assertProviderRequest(original, "dispatch");
            this.codingBatchCharge();
          }
        },
        beforeProviderDispatch: (run) => {
          assertResidentProviderDispatch(this,run);
          if(this.sandboxEnabled && this.lifecycleHooks.list().length)throw new EngineError('SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED','New host lifecycle effects require a fresh supported producer');
          this.prFeedbackHost?.beforeProviderDispatch(run);
          this.hostCommandDeliveryProducer?.beforeProviderDispatch(run);
          this.codingBatchDispatchGuard?.();
          this.scheduleProducer.beforeProviderDispatch(run);
          this.jobProducer?.beforeProviderDispatch(run);
          this.ownedCommandProducer?.beforeProviderDispatch(run);
          this.conversationForkHost.context(run.sessionId, run.config);
          for (const id of this.store.listRunInputIds(run.id))
            this.workflowEffects.beforeInput(
              id,
              this.store.getInput(id).requestId,
              run,
            );
        },
        onWorkflowToolSettled: (record) =>
          this.workflowEffects.toolSettled(record),
        onCodeModeToolSettled:record=>this.codeModeHost?.toolSettled(record),
        onOwnedCommandToolSettled: (record) =>
          this.ownedCommandHost?.toolSettled(record),
        onRunStarted: async (run, signal) => {
          const admission = waitChildProviderAdmission(this, signal);
          if (admission) await admission;
          if (signal.aborted)
            throw (
              signal.reason ??
              new EngineError("CANCELLED", "Run initialization was cancelled")
            );
          if (this.verificationEnabled)
            await this.verificationHost.start(run, signal);
        },
        ...(options.diagnosticObservations === true
          ? { executionObserver: this.executionObserver }
          : {}),
        ...(options.lifecycleContinuation === true
          ? {
              lifecycleContinuation: createLifecycleContinuationPort({
                store: this.store,
                controller: this.verificationController,
                plans: this.verificationPlans,
                observeSource: (run, signal) =>
                  this.verificationHost.observe(
                    {
                      sessionId: run.sessionId,
                      runId: run.id,
                      workspace: this.store.getWorkspace(run.workspaceId),
                    },
                    signal,
                  ),
                readCurrentProfile: (run) => {
                  const profile = this.profiles.forRun(
                    run.sessionId,
                    run.config,
                  );
                  return profile
                    ? { id: profile.id, revision: profile.revision }
                    : null;
                },
                assertBoundaryCurrent: (run, boundary) =>
                  this.coordinator.assertVerificationBoundaryCurrent(
                    run,
                    boundary,
                  ),
                readRemainingBudget: (run) =>
                  this.coordinator.verificationRemainingBudget(run),
              }),
            }
          : {}),
        ...(this.verificationEnabled
          ? {
              verificationStop: async (run, boundary, signal) => {
                if (!this.verificationHost.configuration(run.sessionId))
                  return null;
                const workspace = this.store.getWorkspace(run.workspaceId);
                if (!this.verificationPlans.get(run.sessionId, run.id)) {
                  try {
                    await this.verificationHost.ensurePlan(
                      { sessionId: run.sessionId, runId: run.id, workspace },
                      signal,
                    );
                  } catch (error) {
                    if (
                      !(error instanceof EngineError) ||
                      error.code !== "VERIFICATION_CHECK_NOT_FOUND"
                    )
                      throw error;
                  }
                }
                const source = await this.verificationHost.observe(
                    { sessionId: run.sessionId, runId: run.id, workspace },
                    signal,
                  ),
                  verification = this.verificationPlans.get(
                    run.sessionId,
                    run.id,
                  );
                const result = await this.verificationController.evaluate(
                  run.sessionId,
                  run.id,
                  this.verificationController.get(run.sessionId, run.id)
                    ?.revision ?? 0,
                  {
                    boundary,
                    source,
                    verificationRevision: verification?.revision ?? 0,
                    planSha256: verification?.plans.at(-1)?.planSha256 ?? null,
                  },
                  signal,
                );
                const content = verificationContinuationMessage(result);
                return content && result.result.stageId
                  ? {
                      stageId: result.result.stageId,
                      message: {
                        role: "user" as const,
                        content: `[Moodcode verification control v1]\n${content}`,
                      },
                    }
                  : null;
              },
              verificationBeforeProvider: async (run, boundary, signal) => {
                const workspace = this.store.getWorkspace(run.workspaceId),
                  source = await this.verificationHost.observe(
                    { sessionId: run.sessionId, runId: run.id, workspace },
                    signal,
                  ),
                  verification = this.verificationPlans.get(
                    run.sessionId,
                    run.id,
                  );
                const result = await this.verificationController.evaluate(
                  run.sessionId,
                  run.id,
                  this.verificationController.get(run.sessionId, run.id)
                    ?.revision ?? 0,
                  {
                    boundary,
                    source,
                    verificationRevision: verification?.revision ?? 0,
                    planSha256: verification?.plans.at(-1)?.planSha256 ?? null,
                  },
                  signal,
                );
                if (result.result.action === "stop")
                  throw new EngineError(
                    "VERIFICATION_CONTINUATION_BLOCKED",
                    `Verification continuation stopped (${result.result.reason})`,
                  );
              },
            }
          : {}),
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
        getToolProfile: (run) => {
          const profile = this.profiles.forRun(run.sessionId, run.config);
          return profile
            ? { id: profile.id, revision: profile.revision }
            : undefined;
        },
        getAllowedTools: (run) => {
          const profile = this.profiles.forRun(
            run.sessionId,
            run.config,
          )?.tools;
          return this.hostAllowedTools
            ? profile
              ? profile.filter((name) => this.hostAllowedTools!.includes(name))
              : this.hostAllowedTools
            : profile;
        },
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
            changes.map((change) => this.syncLanguageServers(change)),
          );
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
      this.scheduler = new InputScheduler({ store: this.store, coordinator: this.coordinator, beforePromotion: input => { this.scheduleProducer.beforePromotion(input); this.jobProducer?.beforePromotion(input); this.ownedCommandProducer?.beforePromotion(input); this.prFeedbackHost?.beforePromotion(input); this.hostCommandDeliveryProducer?.beforePromotion(input); this.conversationForkHost.context(input.sessionId,input.config); this.workflowEffects.beforeInput(input.id,input.requestId); } });
      this.conversationForkHost = new ConversationForkHost(this,knowledgeBinding,id=>providers.get(id),this.conversationForksEnabled);
      const scheduleHost = new ScheduleHost({ native: this.scheduleRecords, input: this.scheduleProducer.inputPort() });
      this.scheduleDispatcher = new ScheduleDispatcher({ native: this.scheduleRecords, host: scheduleHost });
      this.backendProducer = new EngineAgentBackendProducer(this, knowledgeBinding, () => this.backendRecords, () => this.closing,
        () => this.agentBackendsEnabled, this.executionLockPath, options.agentBackendSecrets, ()=>options.agentBackendClientEffects===true, ()=>options.agentBackendClientEffects===true&&this.jobsEnabled);
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
      this.backendHost = new AgentBackendHost({ store: this.backendRecords, processes: this.backendProcesses, clientReads: this.backendProducer.clientReadPort(), turns: this.backendProducer, clientEffectsEnabled: options.agentBackendClientEffects===true, terminalEffectsEnabled: options.agentBackendClientEffects===true&&this.jobsEnabled, lifetime: this.hostResources.signal });
      this.codeModeHost=new CodeModeHost(this,this.store.createCodeModeStorage((original,record,revision)=>this.codeModeHost.assertRecordOwner(original,record,revision)),knowledgeBinding,options.codeMode===true);
      this.jobProducer = new EngineJobProducer(this, knowledgeBinding, () => this.jobRecords, () => this.closing, () => this.jobsEnabled, this.storagePaths.artifactDir);
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
      this.jobHost = new JobHost({ native: this.jobRecords, source: this.jobProducer.sourcePort(), lifetime: this.hostResources.signal });
      this.jobDelivery = new JobDelivery({ native: this.jobRecords, input: this.jobProducer.inputPort(), lifetime: this.hostResources.signal });
      this.store.validateEffectBatches();
      this.store.recoverEffectBatches();
      this.store.recoverOwnedCommandJobs();
      this.sandboxHost = new SandboxHost(this,this.store.createSandboxStorage(),{enabled:options.osSandbox===true,binding:knowledgeBinding,excluded:[this.storagePaths.artifactDir,...nativeFiles.flatMap(path=>[path,`${path}-wal`,`${path}-shm`,`${path}-journal`])],active:()=>!this.closing});
      this.hostCommands = new HostCommandService(this, this.store.createHostCommandStorage(), knowledgeBinding, { enabled: () => options.hostCommands === true && !this.closing, unsupportedPolicy: Boolean(options.commandPreflight || options.roleResourcePolicy || options.roleResourcePolicyRegistry || options.resolveRoleResources), artifactDir:this.storagePaths.artifactDir, executionLockPath:this.executionLockPath, lifetime:this.hostResources.signal, ...(options.osSandbox?{sandbox:(ws:string,session:string)=>this.sandboxHost.hostLaunch(ws,session)}:{}) });
      this.ownedCommandHost = new OwnedCommandJobHost(this, knowledgeBinding, () => this.jobsEnabled && !this.closing);
      this.store.validateOwnedCommandDeliveries();
      this.ownedCommandProducer = new EngineOwnedCommandDeliveryProducer(this, knowledgeBinding, () => this.jobsEnabled && !this.closing, this.ownedCommandHost);
      this.ownedCommandDelivery = new OwnedCommandDelivery({input:this.ownedCommandProducer.inputPort(),native:{deliver:(original,input) => this.store.deliverOwnedCommandResultAtomic(original,input,{
        readTargetOriginal: original => this.ownedCommandProducer.readTarget(original),
        assertTarget: (original,expected) => this.ownedCommandProducer.assertTargetCurrent(original,expected),
        acceptAtomic: (original,request) => this.ownedCommandProducer.acceptAtomic(original,request),
        readAccepted: original => this.ownedCommandProducer.readAccepted(original),
        releaseAccepted: original => this.ownedCommandProducer.release(original),
      })}, lifetime:this.hostResources.signal});
      this.commandLifetimes=new CommandLifetimeService(this,this.hostCommands,()=>options.commandLifetimes===true&&this.jobsEnabled&&!this.closing);
      this.store.validateHostCommandDeliveries();
      this.hostCommandDeliverySource=new EngineHostCommandDeliverySource(this);
      this.hostCommandDeliveryProducer = new EngineHostCommandDeliveryProducer(this, knowledgeBinding, () => options.hostCommands===true && this.jobsEnabled && !this.closing, this.hostCommandDeliverySource);
      this.hostCommandDelivery = new HostCommandDelivery({input:this.hostCommandDeliveryProducer.inputPort(),native:{deliver:(original,input) => this.store.deliverHostCommandResultAtomic(original,input,{
        readTargetOriginal: original => this.hostCommandDeliveryProducer.readTarget(original),
        assertTarget: (original,expected) => this.hostCommandDeliveryProducer.assertTargetCurrent(original,expected),
        acceptAtomic: (original,request) => this.hostCommandDeliveryProducer.acceptAtomic(original,request),
        readAccepted: original => this.hostCommandDeliveryProducer.readAccepted(original),
        releaseAccepted: original => this.hostCommandDeliveryProducer.release(original),
      })}, lifetime:this.hostResources.signal});
      this.gitCommitHost = new GitCommitHost({ store:this.store,records:this.store.createGitCommitStorage(),plans:this.verificationPlans,verification:this.verificationHost,
        binding:knowledgeBinding,enabled:()=>options.gitCommits===true && this.verificationEnabled && !this.closing,
        lease:(workspaceId,operation)=>this.coordinator.withWorkspaceLease(workspaceId,operation),
        recoveryLease:(workspaceId,operation)=>this.coordinator.withRecoveryDecisionLease(workspaceId,operation),
        executionLockPath:this.executionLockPath,artifactDir:this.storagePaths.artifactDir,lifetime:this.hostResources.signal });
      this.store.validatePrFeedback();
      this.prFeedbackHost = new PrFeedbackHost(this,this.store.createPrFeedbackStorage(),knowledgeBinding,this.verificationHost,()=>options.prFeedback===true&&this.verificationEnabled&&!this.closing,options.prFeedbackLoopback===true,this.hostResources.signal);
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

  private applyProfile(input: { sessionId: string; requestId: string; config: RunConfig }): void {
    const admitted = input.config.agentProfileId ? this.store.findInputByRequest(input.sessionId, input.requestId)?.config : undefined;
    input.config = this.profiles.apply(input.sessionId, input.config, admitted);
  }

  private assertOptionalBoolean(options: EngineOptions, key: keyof EngineOptions, message: string): void {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new EngineError('INVALID_CONFIG', message);
  }

  private async validateFreshMediaInput(input: Pick<ReturnType<typeof normalizeSubmitInput>, 'sessionId' | 'config' | 'attachments' | 'documents' | 'media'>): Promise<void> {
    assertInputMediaBudget(input.attachments, input.documents);
    if (input.media?.length) await this.validateSegmentInput(input.sessionId, input.config, input.media);
    if (input.documents?.length) await this.validateDocumentInput(input.sessionId, input.config, input.documents);
    if (input.attachments?.length) await this.validateImageInput(input.sessionId, input.config, input.attachments);
  }

  /** Native inbox/session commands have their own explicit protocol and journal. */
  async dispatchSession(value: unknown): Promise<SessionCommandResult> {
    let commandId = '';
    try {
      assertMediaCommandData(value);
      const command = validateSessionCommand(value, { defaults: this.defaults, enabledCommands: NATIVE_COMMANDS_ENABLED });
      commandId = command.commandId;
      if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
      const payload = command.payload;
      let result: unknown;
      switch (command.type) {
        case 'engine.getCapabilities': result = this.getCapabilities(); break;
        case 'input.accept': {
          const input = normalizeAcceptInput(payload, this.defaults);
          this.applyProfile(input);
          if ((input.attachments?.length || input.documents?.length || input.media?.length) && !this.store.lookupInputReceipt(input)) {
            await this.validateFreshMediaInput(input);
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
          result = { metrics: this.store.getNativeMetrics(session.id), context: this.context.diagnostics(session.id), workspaceObservation: { failure: this.observationFailures.get(session.workspaceId) ?? null, active: this.watchConsumers.get(session.workspaceId)?.running === true } }; break;
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
      assertMediaCommandData(value);
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
            this.applyProfile(input);
            if ((input.attachments?.length || input.documents?.length || input.media?.length) && !this.store.lookupRunReceipt(input)) {
              await this.validateFreshMediaInput(input);
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

  previewResidentChildTask(request:EngineChildRequest,idleTimeoutMs?:number){return this.children.previewResident(request,idleTimeoutMs);}
  releaseResidentChildTaskPreview(original:object):void{this.children.releaseResidentPreview(original);}
  readResidentChildTaskPreview(original:object){return this.children.readResidentPreview(original);}
  startResidentChildTask(original:object,approved:boolean){return this.children.startResident(original,approved);}
  inspectResidentChildTask(sessionId:string,taskId:string){return this.children.inspectResident(sessionId,taskId);}
  stopResidentChildTask(sessionId:string,taskId:string){return this.children.stopResident(sessionId,taskId);}
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
    if(this.sandboxEnabled)throw new EngineError('SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED','Host lifecycle effects require their own sandbox-bound producer');
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
      const toolCallIds = new Set(trajectory.events.flatMap(event => run && event.runId === run.id && event.tool?.toolCallId ? [event.tool.toolCallId] : []));
      const observations = run ? [...toolCallIds].flatMap(id => this.executionObserver.storage.getObservation(run.workspaceId, id) ?? []) : [];
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
    const consumer = this.watchConsumers.get(workspaceId) ?? { seq: 0, running: false, done: Promise.resolve() };
    if (!consumer.running) {
      this.watchConsumers.set(workspaceId, consumer);
      consumer.running = true;
      consumer.done = this.consumeWorkspaceChanges(workspaceId, consumer);
    }
    return watch;
  }

  /** A failed consumer restarts on the next watch after its last processed event, or at the head when that replay no longer fits. */
  private async consumeWorkspaceChanges(workspaceId: string, consumer: { seq: number; running: boolean }): Promise<void> {
    try {
      const from = this.changes.resumeCursor(workspaceId, consumer.seq);
      if (from !== consumer.seq && !this.observationFailures.has(workspaceId)) this.observationFailures.set(workspaceId, 'WORKSPACE_CHANGE_CURSOR_EXPIRED');
      consumer.seq = from;
      for await (const event of this.changes.subscribe(workspaceId, from, this.hostResources.signal)) {
        if (event.type === 'change') await this.syncLanguageServers(event.change);
        else if (event.type === 'incomplete') this.observationFailures.set(workspaceId, event.code);
        consumer.seq = event.seq;
      }
    } catch (error) { if (!this.hostResources.signal.aborted) this.observationFailures.set(workspaceId, error instanceof EngineError ? error.code : 'WORKSPACE_OBSERVATION_FAILED'); }
    finally { consumer.running = false; }
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

  private assertAgentBackendsEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.agentBackendsEnabled) throw new EngineError('AGENT_BACKENDS_DISABLED', 'Agent backends require explicit root host opt-in');
  }
  captureAgentBackendTarget(input: CaptureAgentBackendTarget): object { if(this.sandboxEnabled)throw new EngineError('SANDBOX_AGENT_BACKEND_UNSUPPORTED','ACP effect servers cannot bypass sandbox restrictions'); this.assertAgentBackendsEnabled(); return this.backendProducer.captureTarget(input); }
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
  cancelCommandJobWatch(...args: Parameters<JobHost['cancelCommandJobWatch']>) { if (!this.jobsEnabled) throw new EngineError('JOBS_DISABLED', 'Job mutations require explicit root host opt-in'); return this.jobHost.cancelCommandJobWatch(...args); }
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
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
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
  reconcilePrHead(...args:Parameters<PrFeedbackHost['reconcileHead']>){return this.prFeedbackHost.reconcileHead(...args);}
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
  bindCommandJobModelTools(input: BindCommandJobModelToolsInput): object { return this.commandJobModelHost.bind(input); }
  releaseCommandJobModelTools(original: object): void { this.commandJobModelHost.release(original); }

  bindTeamModelTools(input: BindTeamModelToolsInput): TeamModelToolsBinding { return this.teamModelHost.bind(input); }
  private assertWorkflowsEnabled(): void {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (!this.workflowsEnabled) throw new EngineError('WORKFLOWS_DISABLED', 'Workflows require explicit host opt-in');
  }

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
  bindWorkflowModelTools(input:Parameters<WorkflowEffects['bind']>[0]){this.assertWorkflowsEnabled();return this.workflowEffects.bind(input);}
  releaseWorkflowModelTools(original:object){this.workflowEffects.release(original);}
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
  getTeam(workspaceId: string,teamId: string) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.getTeam(workspaceId,teamId)); }
  getTeamMember(workspaceId: string,teamId: string,memberId: string) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.getMember(workspaceId,teamId,memberId)); }
  listTeamMembers(workspaceId: string,teamId: string,limit?: number) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.listMembers(workspaceId,teamId,limit)); }
  getTeamTask(workspaceId: string,teamId: string,taskId: string) { if(this.closing) throw new EngineError('ENGINE_CLOSED','Engine is closing'); return this.store.readExecutionObservationEvidence(() => this.teamRecords.getTask(workspaceId,teamId,taskId)); }
  readTeamTaskPage(workspaceId:string,teamId:string,afterTaskId?:string,limit?:number){if(this.closing)throw new EngineError('ENGINE_CLOSED','Engine is closing');return this.store.readExecutionObservationEvidence(()=>this.teamRecords.listTasksPage(workspaceId,teamId,afterTaskId,limit));}
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

  previewWorkspaceKnowledgeGeneration(input: { providerId: string; modelId: string; projection: KnowledgeSourceProjection; reasoningEffort?: ReasoningEffort }) {
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

  private knowledgeGenerationProvider(providerId: string): ProviderAdapter & HostGenerationProviderPort {
    if (!this.knowledgeGenerationEnabled) throw new EngineError('KNOWLEDGE_GENERATION_DISABLED', 'Host knowledge extraction requires explicit opt-in');
    const provider = this.runtimeProviders.get(providerId);
    if (!provider || typeof provider.streamGeneration !== 'function') throw new EngineError('KNOWLEDGE_PROVIDER_UNSUPPORTED', 'Provider does not support an independently owned tools-free generation');
    return provider as ProviderAdapter & HostGenerationProviderPort;
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
    this.liveKnowledgeRecoveryPreviews.set(workspaceId, preview);
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
    if(this.sandboxEnabled)throw new EngineError('SANDBOX_PLUGIN_UNSUPPORTED','Plugin effects cannot assert sandbox enforcement');
    const active = await this.plugins.activate(plugin, signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    try { this.refreshToolScopes(); return active; }
    catch (error) { await this.plugins.deactivate(active.id); throw error; }
  }

  async deactivatePlugin(id: string): Promise<void> { await this.plugins.deactivate(id); this.refreshToolScopes(); }

  async connectMcp(client: McpClient, signal?: AbortSignal): Promise<{ id: string; scopeId: string; toolNames: string[]; resources: McpRegistration['resources'] }> {
    if (this.closing) throw new EngineError('ENGINE_CLOSED', 'Engine is closing');
    if (this.mcp.has(client.id) || this.pendingMcp.has(client.id)) throw new EngineError('MCP_ALREADY_CONNECTED', 'MCP ID is already connected or connecting');
    if (this.mcp.size + this.pendingMcp.size >= 32) throw new EngineError('MCP_CONNECTION_LIMIT', 'Too many engine MCP connections');
    if(this.sandboxEnabled&&!this.sandboxHost.hasMcp(client))throw new EngineError('SANDBOX_MCP_UNSUPPORTED','Only actual sandbox-owned stdio transports are admitted');
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
      return this.coordinator.withRecoveryDecisionLease(session.workspaceId, async signal => {
        if (signal.aborted) throw signal.reason ?? new EngineError('ENGINE_CLOSED', 'Summary recovery decision was cancelled');
        verifyExecutionIdle(this.executionLockPath);
        const receipt = this.store.acknowledgeSummaryRecovery(prepared);
        this.scheduler.holdRecoveryWorkspace(session.workspaceId);
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

  private trackMediaImport<T>(factory: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Engine is closing'));
    const operation = factory(signal ? AbortSignal.any([signal, this.hostResources.signal]) : this.hostResources.signal);
    this.pendingImages.add(operation);
    void operation.then(() => this.pendingImages.delete(operation), () => this.pendingImages.delete(operation));
    return operation;
  }

  importImage(sessionId: string, data: Uint8Array, mimeType: InputImageAttachment['mimeType'], signal?: AbortSignal): Promise<InputImageAttachment> {
    return this.trackMediaImport(lifetime => this.images.import(sessionId, data, mimeType, lifetime), signal);
  }

  /** Host-only bounded import. References carry no path, filename or raw bytes. */
  importDocument(sessionId: string, data: Uint8Array, signal?: AbortSignal): Promise<InputDocumentAttachment> {
    return this.trackMediaImport(lifetime => this.documents.import(sessionId, data, lifetime), signal);
  }

  /** Host-only read of a native media Part; archive/reopened DATA never dispatches a provider. */
  async readMediaOutput(input:{sessionId:string;partId:string;offset?:number;limit?:number;signal?:AbortSignal}){
    if(this.closing)throw new EngineError('ENGINE_CLOSED','Engine is closing');
    if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).some(k=>typeof k!=='string'))throw new EngineError('MEDIA_INVALID_READ','Read options must be ordinary data');const d=Object.getOwnPropertyDescriptor(input,'signal');if(d&&(!d.enumerable||!('value'in d)))throw new EngineError('MEDIA_INVALID_READ','Read options must be ordinary data');const signal=d?.value as AbortSignal|undefined;const raw=Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(input)).filter(([key])=>key!=='signal').map(([key,value])=>{if(!value.enumerable||!('value'in value))throw new EngineError('MEDIA_INVALID_READ','Read options cannot contain accessors');return[key,value.value];}));const safe=jobJson(raw,4096) as Omit<typeof input,'signal'>;if(Object.keys(safe).some(k=>!['sessionId','partId','offset','limit'].includes(k))||typeof safe.sessionId!=='string'||typeof safe.partId!=='string'||safe.offset!==undefined&&(!Number.isSafeInteger(safe.offset)||safe.offset<0)||safe.limit!==undefined&&(!Number.isSafeInteger(safe.limit)||safe.limit<1||safe.limit>65536))throw new EngineError('MEDIA_INVALID_READ','Bounded native media read options are required');
    const part=this.store.readProviderMediaPart(safe.sessionId,safe.partId);const operation=(await this.managedArtifacts()).read(part.artifact.id,{identity:part.artifact.identity,...(safe.offset===undefined?{}:{offset:safe.offset}),limit:safe.limit??8192,signal:signal?AbortSignal.any([signal,this.hostResources.signal]):this.hostResources.signal});this.pendingStorage.add(operation);try{return await operation;}finally{this.pendingStorage.delete(operation);}
  }
  getMediaCapabilities(providerId:string,modelId:string){return this.mediaCapabilities(providerId,modelId);}

  importMedia(sessionId:string,data:Uint8Array,mimeType:InputMediaAttachment['mimeType'],segments:readonly InputMediaSegment[],signal?:AbortSignal):Promise<InputMediaAttachment>{
    return this.trackMediaImport(lifetime => this.segments.import(sessionId, data, mimeType, segments, lifetime), signal);
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
        this.commandJobModelHost.close();
        this.teamHost.close();
        this.conversationForkHost.close();
        this.jobHost.close();
        this.jobDelivery.close();
        this.ownedCommandDelivery.close();
        this.hostCommandDelivery.close();
        // Both calls synchronously stop admissions before either awaits active work.
        const outcomes = await Promise.allSettled([this.commandLifetimes.close(), this.hostCommands.close(), this.gitCommitHost.close(), this.prFeedbackHost.close(), this.backendHost.close(), this.scheduleDispatcher.close(), this.codingBatches.close(), this.workflowService.close(), this.proposalApplyService.close(), this.proposalService.close(), this.proposalOverlay.close(), this.knowledgeImportService.close(), this.knowledgeFilePublicationService.close(), this.scheduler.close(), this.coordinator.close(), this.children.close(), this.changes.close(), this.lsp.close(), ...[...this.watchConsumers.values()].map(consumer => consumer.done), ...[...this.pendingRepository].map(operation => operation.catch(() => {})), ...[...this.pendingImages].map(operation => operation.catch(() => {})), ...[...this.pendingStorage].map(operation => operation.catch(() => {})), this.terminals.close(), this.plugins.close(), ...[...this.mcpClients.values()].map(client => client.close()), ...[...this.mcp.keys()].map(id => this.disconnectMcp(id)), ...[...this.pendingMcp.values()].map(pending => pending.catch(() => {}))]);
        for (const preview of this.liveKnowledgeRecoveryPreviews.values()) this.knowledgeGenerations.releaseRecoveryPreview(preview);
        this.liveKnowledgeRecoveryPreviews.clear();
        const failed = outcomes.find(outcome => outcome.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      finally {
        await this.executionObserver.close();
        try { this.terminalJournal.close(); }
        finally { try { this.reviewJournal.close(); }
        finally { try { await this.codeModeHost.close(); this.workflowEffects.close(); this.hostCommandDeliveryProducer.close(); this.hostCommandDeliverySource.close(); this.ownedCommandProducer.close(); this.ownedCommandHost.close(); this.jobProducer.close(); this.backendProducer.close(); this.scheduleProducer.close(); await this.store.closeAsync(); }
        finally { this.removeOwnedArtifactDir(); } }
        }
      }
    })().then(resolve, reject);
    return this.closePromise;
  }
}

export function createEngine(options: EngineOptions): MoodcodeEngine { return new MoodcodeEngine(options); }
