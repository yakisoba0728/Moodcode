import type { ApprovalRecord, Checkpoint, EngineEvent, JsonObject, JsonValue, Message, ProviderReplay, ProviderToolCall, Run, RunConfig, RunLimits, RunReceipt, RunState, Session, SessionSnapshot, SubmitInput, ToolCallRecord, Workspace } from '@moodcode/contracts';
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
  commit(runId: string, type: string, payload: JsonObject, change?: CommitChange): EngineEvent;
  getSnapshot(sessionId: string): SessionSnapshot;
  readEvents(sessionId: string, afterSeq: number, limit?: number): EngineEvent[];
  subscribe(sessionId: string, afterSeq: number, signal?: AbortSignal): AsyncIterable<EngineEvent>;
  getApproval(id: string): ApprovalRecord;
  listCheckpoints(runId: string): Checkpoint[];
  recoverInterrupted(): Run[];
  close(): void;
}
export interface ProviderMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ProviderToolCall[]; toolCallId?: string; providerReplay?: ProviderReplay }
export interface ProviderTool { name: string; description: string; inputSchema: JsonObject }
export interface TurnRequest { runId: string; turnIndex: number; modelId: string; messages: ProviderMessage[]; tools: ProviderTool[] }
export type ProviderEvent = { type: 'text.delta'; delta: string } | { type: 'tool.call'; call: ProviderToolCall } | { type: 'usage'; inputTokens?: number; outputTokens?: number } | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length'; replayItems?: JsonObject[] };
export interface ProviderAdapter { readonly id: string; streamTurn(request: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> }
export interface ToolContext { workspace: Workspace; sessionId: string; runId: string; toolCallId: string; signal: AbortSignal; limits: RunLimits; artifactDir: string; executionLockPath?: string; recordCheckpoint(checkpoint: Checkpoint): void }
export interface PreparedTool { name: string; input: JsonValue; fingerprint: string; requiresApproval: boolean; preview: JsonObject; data?: JsonValue }
export interface ToolResult { content: string; isError?: boolean; data?: JsonValue; artifacts?: { path: string; bytes: number; truncated: boolean }[] }
export interface ToolDefinition extends ProviderTool { prepare(input: unknown, context: ToolContext): Promise<PreparedTool>; execute(prepared: PreparedTool, context: ToolContext): Promise<ToolResult> }
export interface ApprovalRequest { sessionId: string; runId: string; toolCallId: string; toolName: string; fingerprint: string; preview: JsonObject }
export interface ApprovalPort { request(input: ApprovalRequest, signal: AbortSignal): Promise<ApprovalRecord>; decide(id: string, decision: 'allow' | 'deny', fingerprint: string): ApprovalRecord; cancelRun(runId: string): void }
export interface ContextRequest { workspace: Workspace; snapshot: SessionSnapshot; config: RunConfig; signal: AbortSignal; reservedBytes?: number }
export type ContextBuilder = (request: ContextRequest) => Promise<ProviderMessage[]>;
export interface CoordinatorOptions { store: EngineStore; providers: ReadonlyMap<string, ProviderAdapter>; tools: readonly ToolDefinition[]; approvals: ApprovalPort; artifactDir: string; executionLockPath?: string; buildContext: ContextBuilder }
export interface CoordinatorPort { submit(input: SubmitInput): RunReceipt; cancel(runId: string): { runId: string; state: RunState }; waitForRun(runId: string): Promise<Run>; close(): Promise<void> }
