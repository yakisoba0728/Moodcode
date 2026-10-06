import type { JsonObject, JsonValue, Run, RunConfig, RunReceipt } from './index.js';

/** Independent session journal; existing v1 commands, event sequence and Run stay valid. */
export const SESSION_SCHEMA_VERSION = 2 as const;
export interface EngineBudgets {
  turnAllowance: number;
  maxToolCallsPerTurn: number;
  maxPendingInputs: number;
  maxPendingBytes: number;
  maxSteerBatch: number;
  maxReadConcurrency: number;
  maxProviderAttempts: number;
  providerRequestTimeoutMs: number;
  providerInactivityTimeoutMs: number;
  retryBaseDelayMs: number;
  maxSummaryCalls: number;
  maxSummaryBytes: number;
  maxArtifactBytes: number;
  maxProducerBytes: number;
}
export const DEFAULT_ENGINE_BUDGETS: Readonly<EngineBudgets> = Object.freeze({
  turnAllowance: 12, maxToolCallsPerTurn: 16, maxPendingInputs: 64, maxPendingBytes: 1_048_576,
  maxSteerBatch: 8, maxReadConcurrency: 4, maxProviderAttempts: 2,
  providerRequestTimeoutMs: 60_000, providerInactivityTimeoutMs: 30_000, retryBaseDelayMs: 250,
  maxSummaryCalls: 2, maxSummaryBytes: 65_536, maxArtifactBytes: 8_388_608, maxProducerBytes: 16_777_216,
});
export type InputDelivery = 'queue' | 'steer';
export type InputState = 'pending' | 'promoted' | 'cancelled';
export interface AcceptInput { sessionId: string; requestId: string; prompt: string; config: RunConfig; delivery: InputDelivery }
export interface InputRecord extends AcceptInput {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  state: InputState;
  admittedSeq: number;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  promotedSeq?: number;
  terminalReason?: string;
}
export interface InputReceipt { inputId: string; admittedSeq: number; state: InputState; duplicate: boolean; runId?: string }
export interface InputCursor { sessionId: string; afterSeq: number }
export interface InputPage { inputs: InputRecord[]; nextCursor: InputCursor | null }
/** v2 input sequence and legacy Run receipt sequence belong to different journals. */
export interface InputPromotion { input: InputRecord; run: Run; receipt: RunReceipt }
export interface SessionControl { sessionId: string; paused: boolean; revision: number; updatedAt: string; reason?: 'user' | 'run_cancelled' | 'recovery_required' }
export interface ExecutionUncertainty {
  kind: 'provider_dispatch' | 'tool_effect' | 'cleanup' | 'storage_commit';
  message: string;
  requiresRecovery: true;
}
/** The primary Run remains the existing durable identity; steers add Input bindings. */
export interface RunRecordV2 extends Run { schemaVersion: typeof SESSION_SCHEMA_VERSION; inputIds: string[]; uncertainty?: ExecutionUncertainty }
export type TurnState = 'created' | 'streaming' | 'awaiting_tools' | 'completed' | 'failed' | 'interrupted' | 'uncertain';
export interface TurnRecord {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string; sessionId: string; runId: string; inputIds: string[]; index: number;
  state: TurnState; createdAt: string; completedAt?: string; finishReason?: string;
  contextRevisionId?: string; uncertainty?: ExecutionUncertainty;
}
export type AttemptState = 'prepared' | 'dispatched' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'uncertain';
export interface ProviderAttempt {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string; sessionId: string; runId: string; turnId: string; index: number;
  providerId: string; modelId: string; state: AttemptState; createdAt: string;
  dispatchedAt?: string; completedAt?: string; providerRequestId?: string; contextRevisionId?: string; uncertainty?: ExecutionUncertainty;
}
export interface ToolCallIdentity { id: string; sessionId: string; runId: string; turnId: string; attemptId: string; providerCallId: string }
export interface ArtifactIdentity { sessionId: string; runId: string; toolCallId: string; turnId?: string; attemptId?: string }
export interface ArtifactReference {
  id: string; identity: ArtifactIdentity; sha256: string; storedBytes: number; observedBytes: number;
  producerTruncatedBytes: number | null; artifactTruncatedBytes: number;
  createdAt: string; expiresAt: string; complete: boolean; outcome: 'completed' | 'failed' | 'interrupted';
}
export interface ToolResultEnvelope {
  displayContent: string; modelContent: string; structuredData?: JsonValue; metadata?: JsonObject;
  warnings: string[]; artifactRefs: ArtifactReference[]; outcome: 'completed' | 'failed' | 'interrupted';
}
export interface ArtifactCheckpointBinding extends ArtifactIdentity { checkpointId: string; artifactIds: string[]; partial: boolean }
export interface PartBase {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string; sessionId: string; runId: string; turnId: string; messageId: string;
  index: number; revision: number; state: 'open' | 'completed' | 'failed' | 'interrupted'; createdAt: string; completedAt?: string;
}
export type MessagePart =
  | (PartBase & { type: 'text'; text: string })
  | (PartBase & { type: 'reasoning'; text: string; providerData?: JsonObject })
  | (PartBase & { type: 'tool'; toolCallId: string; providerCallId: string; name: string; input: JsonValue; result?: JsonValue })
  | (PartBase & { type: 'media'; mime: string; name?: string; artifact: ArtifactReference });
export interface ContextRevision {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string; sessionId: string; revision: number; kind: 'baseline' | 'update' | 'summary'; sourceIds: string[];
  text: string; sha256: string; createdAt: string; runId?: string; turnId?: string; supersedesId?: string;
}
/** seq belongs to the session-v2 journal and cannot be used as a v1 events cursor. */
export interface SessionEventV2 {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  stream: 'session-v2'; eventId: string; sessionId: string; seq: number; timestamp: string;
  type: string; payload: JsonObject; runId?: string; inputId?: string; turnId?: string; attemptId?: string;
}
export interface SessionEventCursor { schemaVersion: typeof SESSION_SCHEMA_VERSION; stream: 'session-v2'; sessionId: string; afterSeq: number }
export const SESSION_COMMAND_TYPES = ['input.accept', 'input.list', 'input.cancel', 'session.pause', 'session.resume', 'session.events', 'engine.getCapabilities', 'run.getTurns', 'turn.getParts', 'artifact.get', 'session.getTasks', 'session.setTasks', 'question.list', 'question.answer', 'question.reject', 'session.getContext', 'session.searchHistory'] as const;
export type SessionCommandType = typeof SESSION_COMMAND_TYPES[number];
export interface SessionCommandEnvelope { schemaVersion: typeof SESSION_SCHEMA_VERSION; commandId: string; type: SessionCommandType; payload: JsonObject }
export interface SessionCommandResult { schemaVersion: typeof SESSION_SCHEMA_VERSION; commandId: string; ok: boolean; result?: JsonValue; error?: { code: string; message: string; details?: JsonObject } }
