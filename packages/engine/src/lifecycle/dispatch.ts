import { EngineError } from "@moodcode/contracts";
import { createHash } from "node:crypto";
import type {
  LifecycleHookRegistry,
  LifecycleCapturedHook,
} from "./registry.js";
import {
  freezeLifecycle,
  lifecycleInvocation,
  lifecycleResult,
} from "./validation.js";
import type {
  LifecycleCapture,
  LifecycleContextDataItem,
  LifecycleContinuation,
  LifecycleDispatchOutcome,
  LifecycleHookOutcome,
  LifecycleHookResult,
  LifecycleInputRewrite,
  LifecycleInvocation,
  LifecycleTransformReceipt,
} from "./types.js";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

type CallbackSettlement =
  | { kind: "result"; result: LifecycleHookResult | void }
  | { kind: "error" }
  | { kind: "timeout" }
  | { kind: "cancel" };
async function invoke(
  hook: LifecycleCapturedHook,
  invocation: LifecycleInvocation,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CallbackSettlement> {
  if (signal.aborted) return { kind: "cancel" };
  const started = performance.now();
  const deadline = new AbortController(),
    combined = AbortSignal.any([signal, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined,
    detach = () => {};
  const interruption = new Promise<CallbackSettlement>((resolve) => {
    const abort = () => resolve({ kind: "cancel" });
    signal.addEventListener("abort", abort, { once: true });
    detach = () => signal.removeEventListener("abort", abort);
    timer = setTimeout(() => {
      deadline.abort(
        new EngineError(
          "LIFECYCLE_HOOK_TIMEOUT",
          "Lifecycle callback deadline elapsed",
        ),
      );
      resolve({ kind: "timeout" });
    }, timeoutMs);
    if (signal.aborted) abort();
  });
  // Both handlers remain attached after the race. A late rejection never escapes
  // as an unhandled rejection, and a late result is never published or cached.
  const callback: Promise<CallbackSettlement> = Promise.resolve()
    .then(async (): Promise<CallbackSettlement> => {
      if (combined.aborted) return { kind: "cancel" } as const;
      return Promise.resolve(hook.callback(invocation, combined)).then(
        (result) => ({ kind: "result", result }) as const,
        () => ({ kind: "error" }) as const,
      );
    })
    .catch(() => ({ kind: "error" }) as const);
  try {
    const result = await Promise.race([callback, interruption]);
    // JavaScript cannot preempt a synchronous host callback. Its result still
    // loses authority when it blocked the event loop past its deadline.
    if (
      (result.kind === "result" || result.kind === "error") &&
      performance.now() - started >= timeoutMs
    ) {
      deadline.abort(
        new EngineError(
          "LIFECYCLE_HOOK_TIMEOUT",
          "Lifecycle callback deadline elapsed",
        ),
      );
      return { kind: "timeout" };
    }
    return result;
  } finally {
    clearTimeout(timer);
    detach();
  }
}

export function dispatchLifecycleHooks(
  registry: LifecycleHookRegistry,
  capture: LifecycleCapture,
  input: LifecycleInvocation,
  signal: AbortSignal,
): Promise<LifecycleDispatchOutcome> {
  registry.assertCurrent(capture);
  const invocation = lifecycleInvocation(
    input,
    registry.limits.maxMetadataBytes,
  );
  if (
    ["workspaceId", "sessionId", "runId"].some(
      (key) =>
        invocation.identity[key as keyof typeof invocation.identity] !==
        capture.identity[key as keyof typeof capture.identity],
    )
  )
    throw new EngineError(
      "LIFECYCLE_IDENTITY_MISMATCH",
      "Lifecycle invocation does not belong to the captured Run",
    );
  const state = registry.captureState(capture),
    canonical = JSON.stringify(invocation),
    previous = state.invocations.get(invocation.invocationId);
  if (previous) {
    if (previous.canonical !== canonical)
      throw new EngineError(
        "LIFECYCLE_INVOCATION_CONFLICT",
        "Lifecycle invocation id was reused with changed metadata",
      );
    return previous.promise;
  }
  if (state.invocations.size >= state.maxInvocations)
    throw new EngineError(
      "LIFECYCLE_INVOCATION_LIMIT",
      "Lifecycle Run capture reached its bounded invocation limit",
    );
  const task = dispatch(
    registry,
    capture,
    invocation,
    AbortSignal.any([signal, state.abort.signal]),
  );
  state.invocations.set(invocation.invocationId, { canonical, promise: task });
  return task;
}

async function dispatch(
  registry: LifecycleHookRegistry,
  capture: LifecycleCapture,
  invocation: LifecycleInvocation,
  signal: AbortSignal,
): Promise<LifecycleDispatchOutcome> {
  const started = performance.now(),
    outcomes: LifecycleHookOutcome[] = [];
  let currentInvocation = invocation,
    inputRewrite: LifecycleInputRewrite | undefined,
    continuation: LifecycleContinuation | undefined;
  const contextItems: LifecycleContextDataItem[] = [];
  const finish = (
    action: LifecycleDispatchOutcome["action"],
    status: LifecycleDispatchOutcome["status"],
    code?: string,
    reason?: string,
  ): LifecycleDispatchOutcome =>
    freezeLifecycle({
      invocationId: invocation.invocationId,
      registryRevision: capture.registryRevision,
      stage: invocation.stage,
      status,
      action,
      ...(code ? { code } : {}),
      ...(reason ? { reason } : {}),
      outcomes,
      // A transform is usable only on the fully current successful observation
      // path. Hash receipts may remain as evidence after a later hook denies.
      ...(action === "observe" && status === "completed"
        ? {
            ...(inputRewrite ? { inputRewrite } : {}),
            ...(contextItems.length
              ? {
                  contextData: {
                    items: contextItems,
                    sha256: digest(contextItems),
                  },
                }
              : {}),
            ...(continuation ? { continuation } : {}),
          }
        : {}),
    });
  for (const hook of registry
    .captureState(capture)
    .hooks.filter((item) =>
      item.descriptor.stages.includes(invocation.stage),
    )) {
    if (signal.aborted)
      return finish(
        "stop",
        "cancelled",
        "LIFECYCLE_CANCELLED",
        "Lifecycle dispatch was cancelled",
      );
    try {
      registry.assertCurrent(capture);
    } catch {
      return finish(
        "stop",
        "stale",
        "LIFECYCLE_REGISTRY_STALE",
        "Lifecycle capture changed before callback dispatch",
      );
    }
    const descriptor = hook.descriptor,
      callbackStarted = performance.now(),
      remaining = registry.limits.maxDispatchMs - (callbackStarted - started);
    let settled: CallbackSettlement =
      remaining <= 0
        ? { kind: "timeout" }
        : await invoke(
            hook,
            currentInvocation,
            signal,
            Math.min(descriptor.timeoutMs, remaining),
          );
    const base = {
      hookId: descriptor.id,
      hookRevision: descriptor.revision,
      stage: invocation.stage,
      elapsedMs: Math.max(0, Math.round(performance.now() - callbackStarted)),
    };
    if (signal.aborted || settled.kind === "cancel") {
      outcomes.push({
        ...base,
        status: "cancelled",
        action: "stop",
        code: "LIFECYCLE_CANCELLED",
      });
      return finish(
        "stop",
        "cancelled",
        "LIFECYCLE_CANCELLED",
        "Lifecycle callback was cancelled",
      );
    }
    try {
      registry.assertCurrent(capture);
    } catch {
      outcomes.push({
        ...base,
        status: "stale",
        action: "stop",
        code: "LIFECYCLE_REGISTRY_STALE",
      });
      return finish(
        "stop",
        "stale",
        "LIFECYCLE_REGISTRY_STALE",
        "Lifecycle registry changed while the callback was running",
      );
    }
    let result: LifecycleHookResult | undefined,
      transform: LifecycleTransformReceipt | undefined,
      errorCode: string | undefined;
    if (settled.kind === "result") {
      try {
        result = lifecycleResult(
          settled.result,
          invocation.stage,
          registry.limits.maxResultBytes,
        );
        if (result.kind === "rewrite-input") {
          if (
            currentInvocation.stage !== "tool-prepare" ||
            invocation.stage !== "tool-prepare" ||
            result.expectedInputSha256 !==
              currentInvocation.metadata.inputSha256
          )
            throw new EngineError(
              "LIFECYCLE_TRANSFORM_STALE",
              "Lifecycle rewrite does not match the current input digest",
            );
          const effectiveSha256 = digest(result.input),
            inputBytes = Buffer.byteLength(JSON.stringify(result.input));
          const updated = lifecycleInvocation(
            {
              ...currentInvocation,
              metadata: {
                ...currentInvocation.metadata,
                inputSha256: effectiveSha256,
                inputBytes,
              },
            },
            registry.limits.maxMetadataBytes,
          );
          inputRewrite = {
            input: result.input,
            originalSha256: invocation.metadata.inputSha256,
            effectiveSha256,
          };
          currentInvocation = updated;
          transform = {
            kind: result.kind,
            expectedInputSha256: result.expectedInputSha256,
            inputSha256: effectiveSha256,
          };
        } else if (result.kind === "context-data") {
          if (
            invocation.stage !== "model-context" ||
            result.expectedContextSha256 !== invocation.metadata.contextSha256
          )
            throw new EngineError(
              "LIFECYCLE_TRANSFORM_STALE",
              "Lifecycle context data does not match the original context digest",
            );
          const next = [
            ...contextItems,
            {
              hookId: descriptor.id,
              hookRevision: descriptor.revision,
              data: result.data,
            },
          ];
          if (
            Buffer.byteLength(JSON.stringify(next)) >
            Math.min(
              registry.limits.maxResultBytes,
              invocation.metadata.slotBytes,
            )
          )
            throw new EngineError(
              "LIFECYCLE_TRANSFORM_LIMIT",
              "Lifecycle aggregate context data exceeds its result or reserved slot limit",
            );
          contextItems.push(next[next.length - 1]!);
          transform = {
            kind: result.kind,
            expectedContextSha256: result.expectedContextSha256,
            dataSha256: digest(result.data),
          };
        } else if (result.kind === "continue") {
          if (
            invocation.stage !== "before-stop" ||
            invocation.metadata.outcome !== "completed" ||
            invocation.metadata.verificationSha256 === undefined ||
            result.expectedVerificationSha256 !==
              invocation.metadata.verificationSha256
          )
            throw new EngineError(
              "LIFECYCLE_TRANSFORM_STALE",
              "Lifecycle continuation requires the current completed verification boundary",
            );
          if ((invocation.metadata.continuationsUsed ?? 0) >= 1)
            throw new EngineError(
              "LIFECYCLE_TRANSFORM_LIMIT",
              "Original Run lifecycle continuation allowance is already consumed",
            );
          if (continuation)
            throw new EngineError(
              "LIFECYCLE_CONTINUATION_LIMIT",
              "Lifecycle dispatch accepts only one continuation result",
            );
          const sha256 = digest(result.data);
          continuation = {
            verificationSha256: result.expectedVerificationSha256,
            data: result.data,
            sha256,
          };
          transform = {
            kind: result.kind,
            expectedVerificationSha256: result.expectedVerificationSha256,
            dataSha256: sha256,
          };
        }
      } catch (error) {
        settled = { kind: "error" };
        errorCode =
          error instanceof EngineError
            ? error.code
            : "INVALID_LIFECYCLE_RESULT";
      }
    }
    if (result && settled.kind === "result") {
      const action = transform
        ? "observe"
        : (result.kind as "observe" | "deny" | "stop");
      outcomes.push({
        ...base,
        status:
          action === "observe"
            ? "observed"
            : action === "deny"
              ? "denied"
              : "stop-requested",
        action,
        ...("code" in result
          ? { code: result.code, reason: result.reason }
          : {}),
        ...("metadata" in result && result.metadata
          ? { metadata: result.metadata }
          : {}),
        ...(transform ? { transform } : {}),
      });
      if (action !== "observe")
        return finish(
          action,
          "completed",
          "code" in result ? result.code : undefined,
          "reason" in result ? result.reason : undefined,
        );
    } else {
      const code =
          errorCode ??
          (settled.kind === "timeout"
            ? "LIFECYCLE_HOOK_TIMEOUT"
            : "LIFECYCLE_HOOK_FAILED"),
        action = descriptor.failurePolicy;
      // Do not publish arbitrary callback exception text: it can contain request
      // data or host secrets. The stable typed failure code is sufficient here.
      outcomes.push({
        ...base,
        status: settled.kind === "timeout" ? "timed-out" : "failed",
        action,
        code,
      });
      if (action !== "observe")
        return finish(
          action,
          "completed",
          code,
          "Lifecycle callback failed under its configured failure policy",
        );
    }
  }
  if (signal.aborted)
    return finish(
      "stop",
      "cancelled",
      "LIFECYCLE_CANCELLED",
      "Lifecycle dispatch was cancelled",
    );
  try {
    registry.assertCurrent(capture);
  } catch {
    return finish(
      "stop",
      "stale",
      "LIFECYCLE_REGISTRY_STALE",
      "Lifecycle capture changed before result acceptance",
    );
  }
  return finish("observe", "completed");
}
