import type { ToolEffectClass } from "../ports.js";

/** Host-issued source coverage, never accepted from a provider/tool result payload. */
export interface ExecutionSourceSnapshot {
  readonly schemaVersion: 1;
  readonly completeness: "full" | "unknown";
  readonly sha256: string | null;
  readonly fileCount: number;
  readonly bytes: number;
}
export interface DiagnosticExecutionIdentity {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly attemptId: string;
}
export interface DiagnosticExecutionRuntimeMetadata extends DiagnosticExecutionIdentity {
  readonly effectClass: ToolEffectClass;
  readonly effectiveInputSha256: string;
  readonly source: ExecutionSourceSnapshot;
  /** Actual host result retention, not a claim inside the returned tool data. Defaults unknown. */
  readonly resultComplete?: boolean;
}
export interface DiagnosticEffectEpoch {
  readonly workspaceId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface DiagnosticExecutionObservation extends DiagnosticExecutionIdentity {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly ordinal: number;
  readonly runtimeEpoch: string;
  readonly revision: number;
  readonly state: "dispatched" | "settled" | "interrupted";
  readonly toolName: string;
  readonly effectClass: ToolEffectClass;
  readonly inputSha256: string;
  readonly effectiveInputSha256: string;
  readonly dispatchToolSha256: string;
  readonly settledToolSha256: string | null;
  readonly resultSha256: string | null;
  readonly resultComplete: boolean;
  readonly outcome: "completed" | "failed" | "interrupted" | "unknown";
  readonly sourceBefore: ExecutionSourceSnapshot;
  readonly sourceAfter: ExecutionSourceSnapshot | null;
  readonly effectEpochBefore: number;
  readonly effectEpochDispatch: number;
  readonly effectEpochAfter: number | null;
  readonly dispatchedAt: string;
  readonly settledAt: string | null;
  readonly sha256: string;
}
/** Instance-owned, exact-object capability; copied descriptors grant no authority. */
export interface DiagnosticExecutionCapture extends DiagnosticExecutionIdentity {
  readonly observationId: string;
  readonly runtimeEpoch: string;
}
export interface DiagnosticExecutionDispatch {
  readonly capture: DiagnosticExecutionCapture;
  readonly record: DiagnosticExecutionObservation;
}
export interface DiagnosticExecutionPageOptions {
  readonly afterOrdinal?: number;
  readonly throughOrdinal?: number;
  readonly limit?: number;
  readonly maxBytes?: number;
}
export interface DiagnosticExecutionPage {
  readonly items: readonly DiagnosticExecutionObservation[];
  readonly next: number | null;
  readonly throughOrdinal: number;
  readonly bytes: number;
}
export interface DiagnosticExecutionObservationPorts {
  readonly writeTx: <T>(operation: () => T) => T;
  /** Must reject copied/released/foreign source handles and validate actual runtime metadata. */
  readonly readSourceSnapshot: (
    originalHandle: object,
    phase: "before" | "after",
  ) => DiagnosticExecutionRuntimeMetadata;
  readonly now?: () => number;
}
export type DiagnosticExecutionObservationTable =
  "diagnostic_effect_epochs" | "diagnostic_execution_observations";
export interface DiagnosticExecutionArchiveRow {
  readonly table: DiagnosticExecutionObservationTable;
  readonly key: string;
  readonly workspaceId: string;
  readonly data: DiagnosticEffectEpoch | DiagnosticExecutionObservation;
}
