import { EngineError, type JsonValue } from "@moodcode/contracts";
import { types } from "node:util";
import {
  LIFECYCLE_STAGES,
  type LifecycleHookResult,
  type LifecycleInvocation,
  type LifecycleLimits,
  type LifecycleRunIdentity,
  type LifecycleStage,
} from "./types.js";

export const DEFAULT_LIFECYCLE_LIMITS: Readonly<LifecycleLimits> =
  Object.freeze({
    maxHooks: 32,
    maxHookIdentities: 128,
    maxMetadataBytes: 4_096,
    maxResultBytes: 4_096,
    maxHookTimeoutMs: 1_000,
    maxDispatchMs: 1_000,
    maxInvocationsPerCapture: 1_024,
  });
const LIMIT_MAXIMA: LifecycleLimits = {
  maxHooks: 128,
  maxHookIdentities: 1_024,
  maxMetadataBytes: 65_536,
  maxResultBytes: 65_536,
  maxHookTimeoutMs: 10_000,
  maxDispatchMs: 30_000,
  maxInvocationsPerCapture: 8_192,
};
export function lifecycleLimits(
  input: Partial<LifecycleLimits> = {},
): Readonly<LifecycleLimits> {
  const result = { ...DEFAULT_LIFECYCLE_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (
      !Object.hasOwn(DEFAULT_LIFECYCLE_LIMITS, key) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > LIMIT_MAXIMA[key as keyof LifecycleLimits]
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_LIMIT",
        "Lifecycle limits must be bounded positive integers",
      );
    result[key as keyof LifecycleLimits] = value;
  }
  if (result.maxHookIdentities < result.maxHooks)
    throw new EngineError(
      "INVALID_LIFECYCLE_LIMIT",
      "Lifecycle identity limit must cover the active hook limit",
    );
  return Object.freeze(result);
}
export function freezeLifecycle<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeLifecycle(item);
    Object.freeze(value);
  }
  return value;
}
/** Reject accessors/non-JSON values before reading them. Clone and bound both graph size and encoded bytes. */
export function boundedLifecycleJson(
  value: unknown,
  maxBytes: number,
): JsonValue {
  let nodes = 0,
    minimumBytes = 0;
  const parents = new Set<object>();
  const clone = (item: unknown, depth: number): JsonValue => {
    if (++nodes > 512 || depth > 8)
      throw new EngineError(
        "LIFECYCLE_METADATA_LIMIT",
        "Lifecycle JSON exceeds structural limits",
      );
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      minimumBytes += JSON.stringify(item).length;
      if (minimumBytes > maxBytes)
        throw new EngineError(
          "LIFECYCLE_METADATA_LIMIT",
          "Lifecycle JSON exceeds its byte limit",
        );
      return item;
    }
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > maxBytes)
        throw new EngineError(
          "LIFECYCLE_METADATA_LIMIT",
          "Lifecycle string exceeds its byte limit",
        );
      minimumBytes += Buffer.byteLength(item) + 2;
      if (minimumBytes > maxBytes)
        throw new EngineError(
          "LIFECYCLE_METADATA_LIMIT",
          "Lifecycle JSON exceeds its byte limit",
        );
      return item;
    }
    if (
      !item ||
      typeof item !== "object" ||
      types.isProxy(item) ||
      parents.has(item)
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_METADATA",
        "Lifecycle values must be finite acyclic plain JSON",
      );
    const array = Array.isArray(item),
      prototype = Object.getPrototypeOf(item);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_METADATA",
        "Lifecycle JSON must use plain objects and arrays",
      );
    const descriptors = Object.getOwnPropertyDescriptors(item),
      keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string"))
      throw new EngineError(
        "INVALID_LIFECYCLE_METADATA",
        "Lifecycle JSON cannot contain symbol keys",
      );
    if ((array && item.length > 64) || (!array && keys.length > 64))
      throw new EngineError(
        "LIFECYCLE_METADATA_LIMIT",
        "Lifecycle JSON has too many members",
      );
    const entries = keys.filter(
      (key) => !(array && key === "length"),
    ) as string[];
    minimumBytes += 2 + Math.max(0, entries.length - 1);
    for (const key of entries) {
      const descriptor = descriptors[key]!;
      if (
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        Buffer.byteLength(key) > 128 ||
        /[\u0000-\u001f\u007f]/u.test(key)
      )
        throw new EngineError(
          "INVALID_LIFECYCLE_METADATA",
          "Lifecycle JSON keys and values must be plain enumerable data",
        );
      if (!array) minimumBytes += Buffer.byteLength(key) + 3;
    }
    if (minimumBytes > maxBytes)
      throw new EngineError(
        "LIFECYCLE_METADATA_LIMIT",
        "Lifecycle JSON exceeds its byte limit",
      );
    if (
      array &&
      (entries.length !== item.length ||
        entries.some((key, index) => key !== String(index)))
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_METADATA",
        "Lifecycle arrays must be dense and have no custom properties",
      );
    parents.add(item);
    const result: JsonValue = array
      ? entries.map((key) => clone(descriptors[key]!.value, depth + 1))
      : Object.fromEntries(
          entries.map((key) => [
            key,
            clone(descriptors[key]!.value, depth + 1),
          ]),
        );
    parents.delete(item);
    return result;
  };
  const result = clone(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes)
    throw new EngineError(
      "LIFECYCLE_METADATA_LIMIT",
      "Lifecycle JSON exceeds its encoded byte limit",
    );
  return freezeLifecycle(result);
}
const scalarString = (value: unknown, maxBytes = 256) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= maxBytes &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sha = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function lifecycleIdentity(
  identity: unknown,
): Readonly<LifecycleRunIdentity> {
  const data = boundedLifecycleJson(identity, 1_024);
  if (
    !data ||
    Array.isArray(data) ||
    typeof data !== "object" ||
    Object.keys(data).length !== 3 ||
    !["workspaceId", "sessionId", "runId"].every((key) =>
      scalarString(data[key]),
    )
  )
    throw new EngineError(
      "INVALID_LIFECYCLE_IDENTITY",
      "Lifecycle capture requires exact bounded workspace/session/run identities",
    );
  return data as unknown as Readonly<LifecycleRunIdentity>;
}
const schemas: Record<
  LifecycleStage,
  {
    required: Record<string, (value: unknown) => boolean>;
    optional: Record<string, (value: unknown) => boolean>;
  }
> = {
  "tool-prepare": {
    required: {
      toolCallId: scalarString,
      toolName: scalarString,
      inputSha256: sha,
      inputBytes: integer,
    },
    optional: {
      registryRevision: integer,
      policyVersion: integer,
      turnId: scalarString,
      attemptId: scalarString,
    },
  },
  "model-context": {
    required: {
      providerId: scalarString,
      modelId: scalarString,
      turnIndex: integer,
      contextSha256: sha,
      contextBytes: integer,
      slotBytes: integer,
    },
    optional: { contextRevisionId: scalarString },
  },
  "before-model": {
    required: {
      providerId: scalarString,
      modelId: scalarString,
      turnIndex: integer,
      contextBytes: integer,
      toolCount: integer,
      requestSha256: sha,
    },
    optional: { turnId: scalarString, contextRevisionId: scalarString },
  },
  "after-model": {
    required: {
      providerId: scalarString,
      modelId: scalarString,
      turnIndex: integer,
      finishReason: (value) =>
        ["stop", "tool_calls", "length"].includes(value as string),
      toolCallCount: integer,
      outputBytes: integer,
    },
    optional: { turnId: scalarString, attemptId: scalarString },
  },
  "tool-prepared": {
    required: {
      toolCallId: scalarString,
      toolName: scalarString,
      fingerprint: (value) => scalarString(value, 1_024),
      requiresApproval: (value) => typeof value === "boolean",
    },
    optional: {
      turnId: scalarString,
      attemptId: scalarString,
      effectClass: (value) =>
        ["read", "state", "write", "execute", "network", "unknown"].includes(
          value as string,
        ),
      inputSha256: sha,
      previewSha256: sha,
    },
  },
  "tool-settled": {
    required: {
      toolCallId: scalarString,
      toolName: scalarString,
      outcome: (value) =>
        ["completed", "failed", "denied", "interrupted"].includes(
          value as string,
        ),
      outputBytes: integer,
    },
    optional: {
      turnId: scalarString,
      attemptId: scalarString,
      fingerprint: (value) => scalarString(value, 1_024),
      errorCode: scalarString,
      cleanup: (value) =>
        ["confirmed", "uncertain", "not-dispatched"].includes(value as string),
    },
  },
  "before-stop": {
    required: {
      outcome: (value) =>
        ["completed", "failed", "cancelled"].includes(value as string),
      turnCount: integer,
      toolCallCount: integer,
      outputBytes: integer,
    },
    optional: {
      errorCode: scalarString,
      verificationSha256: sha,
      continuationsUsed: integer,
    },
  },
};
export function lifecycleInvocation(
  value: LifecycleInvocation,
  maxBytes: number,
): LifecycleInvocation {
  const copy = boundedLifecycleJson(value, maxBytes);
  if (
    !copy ||
    Array.isArray(copy) ||
    typeof copy !== "object" ||
    Object.keys(copy).sort().join(",") !==
      "identity,invocationId,metadata,stage" ||
    !scalarString(copy.invocationId) ||
    !LIFECYCLE_STAGES.includes(copy.stage as LifecycleStage)
  )
    throw new EngineError(
      "INVALID_LIFECYCLE_INVOCATION",
      "Lifecycle invocation envelope is invalid",
    );
  lifecycleIdentity(copy.identity);
  const metadata = copy.metadata,
    schema = schemas[copy.stage as LifecycleStage];
  if (
    !metadata ||
    Array.isArray(metadata) ||
    typeof metadata !== "object" ||
    Object.entries(schema.required).some(
      ([key, test]) => !test(metadata[key]),
    ) ||
    Object.entries(metadata).some(([key, item]) => {
      const test = Object.hasOwn(schema.required, key)
        ? schema.required[key]
        : Object.hasOwn(schema.optional, key)
          ? schema.optional[key]
          : undefined;
      return !test || !test(item);
    })
  )
    throw new EngineError(
      "INVALID_LIFECYCLE_METADATA",
      "Lifecycle stage metadata contains unsupported fields or values",
    );
  return copy as unknown as LifecycleInvocation;
}
export function allowsLifecycleDeny(stage: LifecycleStage): boolean {
  return (
    stage === "tool-prepare" ||
    stage === "model-context" ||
    stage === "before-model" ||
    stage === "tool-prepared"
  );
}
export function lifecycleResult(
  value: LifecycleHookResult | void,
  stage: LifecycleStage,
  maxBytes: number,
): LifecycleHookResult {
  const copy = boundedLifecycleJson(
    value === undefined ? { kind: "observe" } : value,
    maxBytes,
  );
  if (
    copy &&
    !Array.isArray(copy) &&
    typeof copy === "object" &&
    ["rewrite-input", "context-data", "continue"].includes(copy.kind as string)
  ) {
    const kind = copy.kind;
    const expectedKey =
      kind === "rewrite-input"
        ? "expectedInputSha256"
        : kind === "context-data"
          ? "expectedContextSha256"
          : "expectedVerificationSha256";
    const dataKey = kind === "rewrite-input" ? "input" : "data";
    const requiredStage =
      kind === "rewrite-input"
        ? "tool-prepare"
        : kind === "context-data"
          ? "model-context"
          : "before-stop";
    if (
      stage !== requiredStage ||
      Object.keys(copy).sort().join(",") !==
        ["kind", expectedKey, dataKey].sort().join(",") ||
      !sha(copy[expectedKey]) ||
      (dataKey === "data" &&
        (!copy.data ||
          Array.isArray(copy.data) ||
          typeof copy.data !== "object"))
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_RESULT",
        "Lifecycle transforms require their exact stage, digest and plain JSON payload",
      );
    return copy as unknown as LifecycleHookResult;
  }
  if (
    !copy ||
    Array.isArray(copy) ||
    typeof copy !== "object" ||
    !["observe", "deny", "stop"].includes(copy.kind as string) ||
    Object.keys(copy).some(
      (key) => !["kind", "code", "reason", "metadata"].includes(key),
    )
  )
    throw new EngineError(
      "INVALID_LIFECYCLE_RESULT",
      "Lifecycle callback returned an invalid result",
    );
  if (
    copy.kind === "observe"
      ? copy.code !== undefined || copy.reason !== undefined
      : !scalarString(copy.code, 128) || !scalarString(copy.reason, 2_048)
  )
    throw new EngineError(
      "INVALID_LIFECYCLE_RESULT",
      "Lifecycle control results require bounded code/reason; observations do not control execution",
    );
  if (copy.kind === "deny" && !allowsLifecycleDeny(stage))
    throw new EngineError(
      "INVALID_LIFECYCLE_RESULT",
      "Deny is only supported before model dispatch or tool approval/effect",
    );
  if (
    copy.metadata !== undefined &&
    (!copy.metadata ||
      Array.isArray(copy.metadata) ||
      typeof copy.metadata !== "object")
  )
    throw new EngineError(
      "INVALID_LIFECYCLE_RESULT",
      "Lifecycle result metadata must be a JSON object",
    );
  return copy as unknown as LifecycleHookResult;
}
