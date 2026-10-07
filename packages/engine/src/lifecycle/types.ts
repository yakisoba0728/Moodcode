import type { JsonObject, JsonValue } from "@moodcode/contracts";
import type { ToolEffectClass } from "../ports.js";

export const LIFECYCLE_STAGES = [
  "tool-prepare",
  "model-context",
  "before-model",
  "after-model",
  "tool-prepared",
  "tool-settled",
  "before-stop",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export type LifecycleAction = "observe" | "deny" | "stop";
export type LifecycleFailurePolicy = LifecycleAction;
export interface LifecycleRunIdentity {
  workspaceId: string;
  sessionId: string;
  runId: string;
}

/** Summaries only. Requests, credentials, opaque replay and tool arguments are not part of this port. */
export interface LifecycleMetadataByStage {
  "tool-prepare": {
    toolCallId: string;
    toolName: string;
    inputSha256: string;
    inputBytes: number;
    registryRevision?: number;
    policyVersion?: number;
    turnId?: string;
    attemptId?: string;
  };
  "model-context": {
    providerId: string;
    modelId: string;
    turnIndex: number;
    contextSha256: string;
    contextBytes: number;
    slotBytes: number;
    contextRevisionId?: string;
  };
  "before-model": {
    providerId: string;
    modelId: string;
    turnIndex: number;
    turnId?: string;
    contextRevisionId?: string;
    contextBytes: number;
    toolCount: number;
    requestSha256: string;
  };
  "after-model": {
    providerId: string;
    modelId: string;
    turnIndex: number;
    turnId?: string;
    attemptId?: string;
    finishReason: "stop" | "tool_calls" | "length";
    toolCallCount: number;
    outputBytes: number;
  };
  "tool-prepared": {
    toolCallId: string;
    toolName: string;
    turnId?: string;
    attemptId?: string;
    fingerprint: string;
    requiresApproval: boolean;
    effectClass?: ToolEffectClass;
    inputSha256?: string;
    previewSha256?: string;
  };
  "tool-settled": {
    toolCallId: string;
    toolName: string;
    turnId?: string;
    attemptId?: string;
    fingerprint?: string;
    outcome: "completed" | "failed" | "denied" | "interrupted";
    outputBytes: number;
    errorCode?: string;
    cleanup?: "confirmed" | "uncertain" | "not-dispatched";
  };
  "before-stop": {
    outcome: "completed" | "failed" | "cancelled";
    errorCode?: string;
    turnCount: number;
    toolCallCount: number;
    outputBytes: number;
    verificationSha256?: string;
    continuationsUsed?: number;
  };
}
export type LifecycleInvocation<S extends LifecycleStage = LifecycleStage> =
  S extends LifecycleStage
    ? {
        readonly invocationId: string;
        readonly identity: Readonly<LifecycleRunIdentity>;
        readonly stage: S;
        readonly metadata: Readonly<LifecycleMetadataByStage[S]>;
      }
    : never;
export type LifecycleHookResult =
  | { kind: "observe"; metadata?: JsonObject }
  | {
      kind: "deny" | "stop";
      code: string;
      reason: string;
      metadata?: JsonObject;
    }
  | { kind: "rewrite-input"; expectedInputSha256: string; input: JsonValue }
  | { kind: "context-data"; expectedContextSha256: string; data: JsonObject }
  | { kind: "continue"; expectedVerificationSha256: string; data: JsonObject };
export type LifecycleHookCallback = (
  invocation: LifecycleInvocation,
  signal: AbortSignal,
) => LifecycleHookResult | void | Promise<LifecycleHookResult | void>;
export interface LifecycleHookRegistration {
  id: string;
  /** Host revision must increase when an id is reused after removal. */
  revision: number;
  stages: readonly LifecycleStage[];
  order?: number;
  timeoutMs?: number;
  failurePolicy?: LifecycleFailurePolicy;
  callback: LifecycleHookCallback;
}
export interface LifecycleHookDescriptor {
  readonly id: string;
  readonly revision: number;
  readonly stages: readonly LifecycleStage[];
  readonly order: number;
  readonly timeoutMs: number;
  readonly failurePolicy: LifecycleFailurePolicy;
  readonly registrationIndex: number;
}
export interface LifecycleLimits {
  maxHooks: number;
  maxHookIdentities: number;
  maxMetadataBytes: number;
  maxResultBytes: number;
  maxHookTimeoutMs: number;
  maxDispatchMs: number;
  maxInvocationsPerCapture: number;
}
export interface LifecycleCapture {
  readonly identity: Readonly<LifecycleRunIdentity>;
  readonly registryRevision: number;
  readonly hooks: readonly LifecycleHookDescriptor[];
}
export type ReadonlyLifecycleJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyLifecycleJsonValue[]
  | ReadonlyLifecycleJsonObject;
export interface ReadonlyLifecycleJsonObject {
  readonly [key: string]: ReadonlyLifecycleJsonValue;
}
export interface LifecycleHookOutcome {
  readonly hookId: string;
  readonly hookRevision: number;
  readonly stage: LifecycleStage;
  readonly status:
    | "observed"
    | "denied"
    | "stop-requested"
    | "failed"
    | "timed-out"
    | "cancelled"
    | "stale";
  readonly action: LifecycleAction;
  readonly elapsedMs: number;
  readonly code?: string;
  readonly reason?: string;
  readonly metadata?: ReadonlyLifecycleJsonObject;
  /** Hash-only observation. It conveys no input/context/continuation authority. */
  readonly transform?: LifecycleTransformReceipt;
}
export type LifecycleTransformReceipt =
  | {
      readonly kind: "rewrite-input";
      readonly expectedInputSha256: string;
      readonly inputSha256: string;
    }
  | {
      readonly kind: "context-data";
      readonly expectedContextSha256: string;
      readonly dataSha256: string;
    }
  | {
      readonly kind: "continue";
      readonly expectedVerificationSha256: string;
      readonly dataSha256: string;
    };
export interface LifecycleContextDataItem {
  readonly hookId: string;
  readonly hookRevision: number;
  readonly data: JsonObject;
}
export interface LifecycleInputRewrite {
  readonly input: JsonValue;
  readonly originalSha256: string;
  readonly effectiveSha256: string;
}
export interface LifecycleContextData {
  readonly items: readonly LifecycleContextDataItem[];
  readonly sha256: string;
}
export interface LifecycleContinuation {
  readonly verificationSha256: string;
  readonly data: JsonObject;
  readonly sha256: string;
}
export interface LifecycleDispatchOutcome {
  readonly invocationId: string;
  readonly registryRevision: number;
  readonly stage: LifecycleStage;
  readonly status: "completed" | "cancelled" | "stale";
  readonly action: LifecycleAction;
  readonly code?: string;
  readonly reason?: string;
  readonly outcomes: readonly LifecycleHookOutcome[];
  /** Ephemeral detached payloads; consumers must never journal these members. */
  readonly inputRewrite?: LifecycleInputRewrite;
  readonly contextData?: LifecycleContextData;
  readonly continuation?: LifecycleContinuation;
}
