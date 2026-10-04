export const SCHEMA_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type RunState = 'created' | 'running' | 'awaiting_approval' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
export function isTerminal(state: RunState): boolean { return TERMINAL_STATES.has(state); }
export class EngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: JsonObject) { super(message); this.name = 'EngineError'; }
}
export interface Workspace { id: string; root: string; gitRoot: string; branch: string | null; createdAt: string }
export interface Session { id: string; workspaceId: string; title: string; createdAt: string }
export interface RunLimits { maxTurns: number; maxToolCalls: number; maxDurationMs: number; toolTimeoutMs: number; maxOutputBytes: number; maxContextBytes: number }
export const DEFAULT_LIMITS: Readonly<RunLimits> = Object.freeze({ maxTurns: 12, maxToolCalls: 32, maxDurationMs: 300_000, toolTimeoutMs: 60_000, maxOutputBytes: 65_536, maxContextBytes: 262_144 });
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export interface RunConfig { providerId: string; modelId: string; mode: 'plan' | 'build'; limits: RunLimits; reasoningEffort?: ReasoningEffort }
export type RunConfigInput = Partial<Omit<RunConfig, 'limits'>> & { limits?: Partial<RunLimits> };
export interface EngineCapabilities {
  schemaVersion: number;
  runtime: { node: string; electron: string | null; platform: string; commandExecution: 'posix-process-group' | 'unsupported' };
  providerIds: string[];
  tools: { name: string; description: string; inputSchema: JsonObject }[];
  modes: ('plan' | 'build')[];
  defaults: RunConfig;
  features?: { historyPaging: boolean; sessionMetrics: boolean };
}
export interface SubmitInput { sessionId: string; requestId: string; prompt: string; config: RunConfig }
export interface Run { id: string; inputId: string; sessionId: string; workspaceId: string; requestId: string; prompt: string; config: RunConfig; state: RunState; createdAt: string; updatedAt: string; error?: { code: string; message: string } }
export interface RunReceipt { runId: string; inputId: string; admittedSeq: number; duplicate: boolean }
export interface ProviderToolCall { id: string; name: string; input: JsonValue }
/** Provider-native completed output for manual replay; opaque to tools and the UI. */
export interface ProviderReplay { providerId: string; items: JsonObject[] }
export interface Message { id: string; sessionId: string; runId: string; role: 'user' | 'assistant' | 'tool'; content: string; createdAt: string; toolCalls?: ProviderToolCall[]; toolCallId?: string; providerReplay?: ProviderReplay }
export interface ToolCallRecord { id: string; runId: string; sessionId: string; name: string; input: JsonValue; state: 'requested' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'denied' | 'interrupted'; output?: string; error?: string }
export interface ApprovalRecord { id: string; sessionId: string; runId: string; toolCallId: string; toolName: string; fingerprint: string; preview: JsonObject; status: 'pending' | 'allowed' | 'denied' | 'expired'; createdAt: string; resolvedAt?: string }
export interface CheckpointFile { path: string; before: string | null; after: string | null; beforeHash: string | null; afterHash: string | null }
export interface Checkpoint { id: string; runId: string; toolCallId: string; kind: 'patch' | 'command'; createdAt: string; files: CheckpointFile[]; warnings: string[]; incomplete?: boolean }
export interface EngineEvent { schemaVersion: typeof SCHEMA_VERSION; eventId: string; sessionId: string; runId: string; seq: number; timestamp: string; type: string; payload: JsonObject }
export interface SessionSnapshot { session: Session; runs: Run[]; messages: Message[]; tools: ToolCallRecord[]; approvals: ApprovalRecord[]; lastSeq: number }
export interface SessionHistoryPage { snapshot: SessionSnapshot; hasMore: boolean; beforeRunId: string | null; truncatedRecords: boolean }
export interface SessionMetrics { observedUsageEvents: number; inputTokens: number | null; outputTokens: number | null; usageWindowTruncated: boolean; context: { bytes: number; limit: number; summaryIncluded: boolean; turnIndex: number } | null }
export interface FileDiff { path: string; before: string | null; after: string | null; beforeHash: string | null; afterHash: string | null }
export interface ReviewDiff { runId: string; files: FileDiff[]; checkpoints: Checkpoint[]; warnings: string[] }
export interface CommandEnvelope { schemaVersion: typeof SCHEMA_VERSION; commandId: string; type: string; payload: JsonObject }
export interface CommandResult { schemaVersion: typeof SCHEMA_VERSION; commandId: string; ok: boolean; result?: JsonValue; error?: { code: string; message: string; details?: JsonObject } }
