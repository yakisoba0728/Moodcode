import type { AcceptInput, ApprovalRecord, Checkpoint, ContextRevision, EngineBudgets, EngineEvent, InputCursor, InputPage, InputPromotion, InputReceipt, InputRecord, JsonObject, JsonValue, Message, MessagePart, ProviderAttempt, ProviderReplay, ProviderToolCall, Run, RunConfig, RunLimits, RunReceipt, RunState, Session, SessionControl, SessionEventV2, SessionSnapshot, SubmitInput, ToolCallRecord, ToolResultEnvelope, TurnRecord, Workspace } from '@moodcode/contracts';
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
  commit(runId: string, type: string, payload: JsonObject, change?: CommitChange): EngineEvent;
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
  putAttemptUsage?(attemptId: string, usage: import('@moodcode/contracts').ProviderUsageSnapshot): import('@moodcode/contracts').AttemptUsageRecord;
  putPart(part: MessagePart): MessagePart;
  listParts(turnId: string): MessagePart[];
  putContextRevision(revision: ContextRevision): ContextRevision;
  getContextRevision(id: string): ContextRevision;
}
export interface SessionEngineStore extends EngineStore, SessionInboxPort, ExecutionRecordStore {}
export interface ResolvedInputImage { attachment: import('@moodcode/contracts').InputImageAttachment; data: string }
export interface ProviderMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ProviderToolCall[]; toolCallId?: string; providerReplay?: ProviderReplay; attachments?: import('@moodcode/contracts').InputImageAttachment[] }
export interface ProviderTool { name: string; description: string; inputSchema: JsonObject }
export interface TurnRequest { runId: string; turnIndex: number; modelId: string; messages: ProviderMessage[]; tools: ProviderTool[]; reasoningEffort?: import('@moodcode/contracts').ReasoningEffort; turnId?: string; attemptId?: string; includeMetadata?: boolean; sessionId?: string; resolvedImages?: ResolvedInputImage[] }
export type ProviderEvent = { type: 'text.delta'; delta: string } | { type: 'progress'; providerRequestId?: string } | { type: 'reasoning.delta'; delta: string } | { type: 'media'; mime: string; name?: string; artifact: import('@moodcode/contracts').ArtifactReference } | { type: 'tool.call'; call: ProviderToolCall } | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number } | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length'; replayItems?: JsonObject[] };
export interface ProviderAdapter { readonly id: string; readonly replayProtocol?: string; readonly retryableHttpStatuses?: readonly number[]; readonly inputModalities?: readonly ('text' | 'image')[]; streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> }
export interface ToolContext { workspace: Workspace; sessionId: string; runId: string; toolCallId: string; signal: AbortSignal; limits: RunLimits; artifactDir: string; executionLockPath?: string; recordCheckpoint(checkpoint: Checkpoint): void; budgets?: EngineBudgets; turnId?: string; attemptId?: string }
export interface PreparedTool { name: string; input: JsonValue; fingerprint: string; requiresApproval: boolean; preview: JsonObject; data?: JsonValue }
export interface ToolResult { content: string; isError?: boolean; data?: JsonValue; artifacts?: { path: string; bytes: number; truncated: boolean }[]; structuredResult?: ToolResultEnvelope }
export type ToolEffectClass = 'read' | 'state' | 'write' | 'execute' | 'network' | 'unknown';
export interface ToolDefinition extends ProviderTool { effectClass?: ToolEffectClass; prepare(input: unknown, context: ToolContext): Promise<PreparedTool>; execute(prepared: PreparedTool, context: ToolContext): Promise<ToolResult> }
export interface ApprovalRequest { sessionId: string; runId: string; toolCallId: string; toolName: string; fingerprint: string; preview: JsonObject }
export interface ApprovalPort { request(input: ApprovalRequest, signal: AbortSignal): Promise<ApprovalRecord>; decide(id: string, decision: 'allow' | 'deny', fingerprint: string): ApprovalRecord; cancelRun(runId: string): void }
export interface ContextRequest { workspace: Workspace; snapshot: SessionSnapshot; config: RunConfig; signal: AbortSignal; reservedBytes?: number; instructionSources?: import('./context/sources.js').InstructionSource[]; run?: Run; budget?: import('./config/budgets.js').BudgetAccount; semanticMemory?: ProviderMessage; agentInstructions?: string; consumeSummaryOutput?: (bytes: number) => void; mediaHistoryNotice?: ProviderMessage; requiredHistoryMessageIds?: readonly string[] }
export interface ToolCheckpointObservation { workspace: Workspace; run: Run; toolCallId: string; turnId?: string; attemptId?: string; checkpoints: readonly Checkpoint[]; signal: AbortSignal }
export interface ChildRunReservation { signal: AbortSignal; remainingBudget: import('./child-tasks/index.js').ChildBudget; allocation: import('./child-tasks/index.js').ChildBudget }
export interface RunUsage { turns: number; toolCalls: number; outputBytes: number }
export type ContextBuilder = (request: ContextRequest) => Promise<ProviderMessage[]>;
export interface CoordinatorOptions { store: EngineStore; providers: ReadonlyMap<string, ProviderAdapter>; tools: readonly ToolDefinition[]; approvals: ApprovalPort; artifactDir: string; executionLockPath?: string; buildContext: ContextBuilder; contextSnapshot?: (sessionId: string, config: RunConfig) => SessionSnapshot; getContextRevisionId?: (sessionId: string) => string | undefined; toolRuntime?: import('./tools/runtime/index.js').ScopedToolRuntime; recoverContextOverflow?: (request: ContextRequest, provider: ProviderAdapter) => Promise<void>; getAllowedTools?: (run: Run) => readonly string[] | undefined; onToolCheckpoint?: (observation: ToolCheckpointObservation) => void | Promise<void> }
export interface CoordinatorPort { submit(input: SubmitInput): RunReceipt; cancel(runId: string): { runId: string; state: RunState }; waitForRun(runId: string): Promise<Run>; close(): Promise<void> }
