import type { AcceptInput, ApprovalRecord, ArtifactReference, AttemptUsageRecord, Checkpoint, ContextRevision, EngineBudgets, EngineEvent, ExecutionUncertainty, InputCursor, InputDocumentAttachment, InputImageAttachment, InputMediaAttachment, InputPage, InputPromotion, InputReceipt, InputRecord, JsonObject, JsonValue, Message, MessagePart, ProviderAttempt, ProviderReplay, ProviderToolCall, ProviderUsageSnapshot, ReasoningEffort, Run, RunConfig, RunLimits, RunReceipt, RunState, Session, SessionControl, SessionEventV2, SessionSnapshot, SubmitInput, ToolCallRecord, ToolResultEnvelope, TurnRecord, Workspace } from '@moodcode/contracts';
import type { ArtifactStore } from './artifacts/store.js';
import type { ChildBudget } from './child-tasks/index.js';
import type { BudgetAccount } from './config/budgets.js';
import type { ActivePrefixStage } from './context/active-prefix.js';
import type { InstructionSource } from './context/sources.js';
import type { EngineExecutionObserver } from './diagnostics/execution-observer.js';
import type { EffectBatchHost } from './effect-batches/host.js';
import type { LifecycleCapture, LifecycleHookRegistry } from './lifecycle/index.js';
import type { McpCallSettlement, McpDispatchBoundary, McpToolCallObserver } from './mcp/execution-observation.js';
import type { ToolEffectClass } from './permission/policy.js';
import type { HostGenerationRequest } from './provider/generation.js';
import type { AttemptCleanupIdentity, AttemptCleanupRecord, AttemptCleanupSettlement } from './storage/attempt-cleanup.js';
import type { McpExecutionIdentity, McpExecutionRecord } from './storage/mcp-executions.js';
import type { SessionDocument } from './storage/native-records.js';
import type { ResolvedToolDiscoveryPolicy } from './tools/runtime/discovery.js';
import type { RuntimeToolProfile, ScopedToolRuntime } from './tools/runtime/index.js';
import type { VerificationBoundary } from './verification/completion.js';
export interface CommitChange { run?: { state?: RunState; error?: { code: string; message: string } }; message?: Message; tool?: ToolCallRecord; approval?: ApprovalRecord; checkpoint?: Checkpoint }
export interface EngineStore {
  putWorkspace(workspace: Workspace): Workspace;
  getWorkspace(id: string): Workspace;
  listWorkspaces(): Workspace[];
  createSession(session: Session): Session;
  getSession(id: string): Session;
  listSessions(workspaceId: string): Session[];
  admit(input: SubmitInput): RunReceipt;
  getRun(id: string): Run;
  hasRunRequest?(sessionId: string, requestId: string): boolean;
  hasActiveRuns?(workspaceId: string, excludedRunId?: string): boolean;
  /** All persisted recovery blockers in one bounded workspace evidence snapshot. */
  hasUncertainWorkspace?(workspaceId: string): boolean;
  hasUncertainKnowledgeFilePublication?(workspaceId: string): boolean;
  hasUncertainProposalApply?(workspaceId: string): boolean;
  /** Authoritative native host-generation quarantine; never inferred from a returned provider object. */
  hasUncertainKnowledgeGeneration?(workspaceId: string): boolean;
  /** Admission blocker: uncertain summaries without a valid explicit host decision. */
  hasUncertainSummaries?(workspaceId: string): boolean;
  /** Persisted ordinary execution uncertainty, including unknown cleanup after restart. */
  hasUncertainExecution?(workspaceId: string): boolean;
  commit(runId: string, type: string, payload: JsonObject, change?: CommitChange): EngineEvent;
  commitRunObservation?(runId: string, type: 'lifecycle.outcome' | 'tool.policy_decision' | 'tool.prepared' | 'backend.launch_reserved' | 'backend.connection_admitted' | 'backend.client_permission' | 'backend.client_effect_closed' | 'backend.client_effect_dispatched' | 'backend.client_effect_proposed' | 'backend.terminal_output_observed' | 'effect.batch.resource_prepared' | 'effect.batch.serial_fallback', payload: JsonObject, refs?: { turnId?: string; attemptId?: string }): EngineEvent;
  /** Only an already consumed, still executing native verification tool may settle during cancellation. */
  putConsumedVerificationSettlement?(identity: { runId: string; toolCallId: string; turnId: string; attemptId: string }, kind: string, expectedRevision: number, data: JsonObject): SessionDocument;
  getSnapshot(sessionId: string): SessionSnapshot;
  readEvents(sessionId: string, afterSeq: number, limit?: number): EngineEvent[];
  subscribe(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<EngineEvent>;
  getApproval(id: string): ApprovalRecord;
  listToolApprovals?(toolCallId: string): ApprovalRecord[];
  listPendingRunApprovals?(runId: string, limit?: number): ApprovalRecord[];
  listCheckpoints(runId: string): Checkpoint[];
  recoverInterrupted(): Run[];
  close(): void;
}
/** Native inbox does not manufacture a Run while an input is pending. */
export interface SessionInboxPort {
  acceptInput(input: AcceptInput): InputReceipt;
  getInput(id: string): InputRecord;
  listInputs(sessionId: string, cursor?: InputCursor, limit?: number): InputPage;
  pendingInputs(sessionId: string, delivery?: AcceptInput['delivery'], limit?: number): InputRecord[];
  promoteInput(inputId: string, runId?: string): InputPromotion;
  promoteSteers(inputIds: string[], runId: string): InputRecord[];
  cancelInput(inputId: string): InputRecord;
  getSessionControl(sessionId: string): SessionControl;
  setSessionPaused(sessionId: string, paused: boolean, reason?: SessionControl['reason']): SessionControl;
  readSessionEvents(sessionId: string, afterSeq: number, limit?: number): SessionEventV2[];
  subscribeSessionEvents(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<SessionEventV2>;
}
/** Implementations validate ownership, revisions and terminal transitions atomically. */
export interface ExecutionRecordStore {
  listRunInputIds?(runId: string): string[];
  putTurn(turn: TurnRecord): TurnRecord;
  getTurn(id: string): TurnRecord;
  listTurns(runId: string): TurnRecord[];
  putAttempt(attempt: ProviderAttempt): ProviderAttempt;
  getAttempt(id: string): ProviderAttempt;
  createMcpExecution?(identity: McpExecutionIdentity): McpExecutionRecord;
  dispatchMcpExecution?(toolCallId: string, boundary?: McpDispatchBoundary): McpExecutionRecord;
  settleMcpExecution?(toolCallId: string, settlement: McpCallSettlement): McpExecutionRecord;
  getMcpExecution?(toolCallId: string, expectedSessionId?: string): McpExecutionRecord;
  createAttemptCleanup?(identity: AttemptCleanupIdentity): AttemptCleanupRecord;
  dispatchAttemptCleanup?(attemptId: string): AttemptCleanupRecord;
  settleAttemptCleanup?(attemptId: string, outcome: AttemptCleanupSettlement): AttemptCleanupRecord;
  getAttemptCleanup?(attemptId: string, expectedSessionId?: string): AttemptCleanupRecord;
  getSummaryOverflowDependency?(summaryAttemptId: string, turnId: string, failedAttemptId: string): NonNullable<ExecutionUncertainty['summaryDependency']>;
  putAttemptUsage?(attemptId: string, usage: ProviderUsageSnapshot): AttemptUsageRecord;
  putPart(part: MessagePart): MessagePart;
  listParts(turnId: string): MessagePart[];
  putContextRevision(revision: ContextRevision): ContextRevision;
  getContextRevision(id: string): ContextRevision;
}
export interface SessionEngineStore extends EngineStore, SessionInboxPort, ExecutionRecordStore {}
export interface ResolvedInputImage { attachment: InputImageAttachment; data: string }
/** Canonical base64 for the verified imported bytes; filenames are derived from the immutable ID. */
export interface ResolvedInputDocument { attachment: InputDocumentAttachment; data: string }
export interface ResolvedInputMedia { attachment: InputMediaAttachment; data: string }
export interface ProviderMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ProviderToolCall[]; toolCallId?: string; providerReplay?: ProviderReplay; attachments?: InputImageAttachment[]; documents?: InputDocumentAttachment[]; media?: InputMediaAttachment[] }
export interface ProviderTool { name: string; description: string; inputSchema: JsonObject }
export interface TurnRequest { runId: string; turnIndex: number; modelId: string; messages: ProviderMessage[]; tools: ProviderTool[]; reasoningEffort?: ReasoningEffort; turnId?: string; attemptId?: string; includeMetadata?: boolean; sessionId?: string; resolvedImages?: ResolvedInputImage[]; resolvedDocuments?: ResolvedInputDocument[]; resolvedMedia?: ResolvedInputMedia[] }
/** Metadata of an ORIGINAL request at actual native provider entry. It grants no dispatch authority. */
export interface ProviderRequestOwner {
  workspaceId: string; sessionId: string; runId: string; turnId: string; attemptId: string;
  providerId: string; modelId: string; requestSha256: string; configSha256: string;
  catalogueSha256: string; contextRevisionId: string | null;
}
export type ProviderEvent = { type: 'text.delta'; delta: string } | { type: 'progress'; providerRequestId?: string } | { type: 'reasoning.delta'; delta: string } | {type:'media.delta'; bytes:Uint8Array; providerMediaId:string; sampleRate:number; channels:number} | {type:'media.end'; providerMediaId:string} | { type: 'media'; mime: string; name?: string; artifact: ArtifactReference } | { type: 'tool.call'; call: ProviderToolCall } | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number } | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length'; replayItems?: JsonObject[] };
export interface ProviderAdapter { readonly id: string; readonly replayProtocol?: string; readonly retryableHttpStatuses?: readonly number[]; readonly inputModalities?: readonly ('text' | 'image')[]; readonly inputFileTypes?: readonly 'application/pdf'[]; supportsInputFile?(modelId: string, mimeType: 'application/pdf'): boolean; supportsInputMedia?(modelId:string,kind:'audio'|'video'):boolean; requestedOutputMedia?(modelId:string):'audio/wav'|null; readonly allowUnknownDocumentTokenCost?: boolean; streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>; streamGeneration?(request: HostGenerationRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> }
export interface ToolContext { effectBatchPermit?:object;effectBatchArtifactLimit?:number; workspace: Workspace; sessionId: string; runId: string; toolCallId: string; signal: AbortSignal; limits: RunLimits; artifactDir: string; executionLockPath?: string; recordCheckpoint(checkpoint: Checkpoint): void; budgets?: EngineBudgets; turnId?: string; attemptId?: string; mcpExecutionObserver?: McpToolCallObserver }
export interface PreparedTool { name: string; input: JsonValue; fingerprint: string; requiresApproval: boolean; preview: JsonObject; data?: JsonValue }
export interface ToolResult { content: string; isError?: boolean; data?: JsonValue; artifacts?: { path: string; bytes: number; truncated: boolean }[]; structuredResult?: ToolResultEnvelope }
export type { ToolEffectClass };
export interface ToolDefinition extends ProviderTool { effectClass?: ToolEffectClass; prepare(input: unknown, context: ToolContext): Promise<PreparedTool>; execute(prepared: PreparedTool, context: ToolContext): Promise<ToolResult> }
export interface ApprovalRequest { sessionId: string; runId: string; toolCallId: string; toolName: string; fingerprint: string; preview: JsonObject }
export interface ApprovalPort { request(input: ApprovalRequest, signal: AbortSignal): Promise<ApprovalRecord>; decide(id: string, decision: 'allow' | 'deny', fingerprint: string): ApprovalRecord; cancelRun(runId: string): void }
export interface ContextRequest {
  workspace: Workspace; snapshot: SessionSnapshot; config: RunConfig; signal: AbortSignal; run?: Run; turnIndex?: number;
  reservedBytes?: number; budget?: BudgetAccount; consumeSummaryOutput?: (bytes: number) => void;
  instructionSources?: InstructionSource[]; agentInstructions?: string; semanticMemory?: ProviderMessage; activePrefixMemory?: ProviderMessage; activePrefixStage?: ActivePrefixStage;
  mediaHistoryNotice?: ProviderMessage; documentHistoryNotice?: ProviderMessage; requiredHistoryMessageIds?: readonly string[];
  verificationContinuation?: ProviderMessage; lifecycleContinuation?: ProviderMessage; lifecycleCapture?: LifecycleCapture;
}
export interface ToolCheckpointObservation { workspace: Workspace; run: Run; toolCallId: string; turnId?: string; attemptId?: string; checkpoints: readonly Checkpoint[]; signal: AbortSignal }
export interface ChildRunReservation { signal: AbortSignal; remainingBudget: ChildBudget; allocation: ChildBudget }
export interface RunUsage { turns: number; toolCalls: number; outputBytes: number }
export type ContextBuilder = (request: ContextRequest) => Promise<ProviderMessage[]>;
export interface LifecycleContinuationRequest { verificationSha256: string; data: JsonObject; sha256: string }
export interface LifecycleContinuationCapture { id: string; message: ProviderMessage; verificationSha256: string }
export interface CoordinatorOptions {
  store: EngineStore; providers: ReadonlyMap<string, ProviderAdapter>; tools: readonly ToolDefinition[]; approvals: ApprovalPort; artifactDir: string; executionLockPath?: string;
  executionObserver?: EngineExecutionObserver; effectBatches?: EffectBatchHost; providerArtifacts?: () => Promise<ArtifactStore>;
  buildContext: ContextBuilder; assertContextFresh?: (request: TurnRequest, signal: AbortSignal) => Promise<void>; contextSnapshot?: (sessionId: string, config: RunConfig) => SessionSnapshot; getContextRevisionId?: (sessionId: string) => string | undefined;
  releaseContext?: (sessionId: string, runId: string) => void; recoverContextOverflow?: (request: ContextRequest, provider: ProviderAdapter) => Promise<void>;
  toolRuntime?: ScopedToolRuntime; toolDiscoveryPolicy?: ResolvedToolDiscoveryPolicy; coreToolNames?: readonly string[]; getToolProfile?: (run: Run) => RuntimeToolProfile | undefined; getAllowedTools?: (run: Run) => readonly string[] | undefined;
  onRunStarted?: (run: Run, signal: AbortSignal) => Promise<void>; beforeProviderDispatch?: (run: Run) => void; beforeActualProviderRequest?: (original: TurnRequest) => void;
  lifecycleHooks?: LifecycleHookRegistry;
  lifecycleContinuation?: {
    capture(run: Run, boundary: VerificationBoundary, signal: AbortSignal): Promise<{ verificationSha256: string } | null>;
    admit(run: Run, boundary: VerificationBoundary, request: LifecycleContinuationRequest, signal: AbortSignal): Promise<LifecycleContinuationCapture>;
    assertFresh(run: Run, capture: LifecycleContinuationCapture, signal: AbortSignal): Promise<void>;
  };
  verificationStop?(run: Run, boundary: VerificationBoundary, signal: AbortSignal): Promise<{ stageId: string; message: ProviderMessage } | null>;
  verificationBeforeProvider?(run: Run, boundary: VerificationBoundary, signal: AbortSignal): Promise<void>;
  onToolCheckpoint?: (observation: ToolCheckpointObservation) => void | Promise<void>;
  onOwnedCommandToolSettled?: (record: ToolCallRecord) => void; onWorkflowToolSettled?: (record: ToolCallRecord) => void; onCommandLifetimeToolSettled?: (record: ToolCallRecord) => void; onCodeModeToolSettled?: (record: ToolCallRecord) => void;
  onCommandLifetimesSettling?: (runId: string, outcome: 'completed' | 'failed' | 'cancelled') => Promise<void>;
}
export interface CoordinatorPort { submit(input: SubmitInput): RunReceipt; cancel(runId: string): { runId: string; state: RunState }; waitForRun(runId: string): Promise<Run>; close(): Promise<void> }
