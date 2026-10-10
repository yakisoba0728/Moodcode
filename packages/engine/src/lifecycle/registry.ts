import { EngineError, type RunLimits } from "@moodcode/contracts";
import { types } from "node:util";
import { dispatchLifecycleHooks } from "./dispatch.js";
import {
  allowsLifecycleDeny,
  boundedLifecycleJson,
  freezeLifecycle,
  lifecycleIdentity,
  lifecycleInvocationLimit,
  lifecycleLimits,
} from "./validation.js";
import {
  LIFECYCLE_STAGES,
  type LifecycleCapture,
  type LifecycleDispatchOutcome,
  type LifecycleHookCallback,
  type LifecycleHookDescriptor,
  type LifecycleHookRegistration,
  type LifecycleInvocation,
  type LifecycleLimits,
  type LifecycleRunIdentity,
} from "./types.js";

export interface LifecycleCapturedHook {
  readonly descriptor: LifecycleHookDescriptor;
  readonly callback: LifecycleHookCallback;
}
/** Internal execution data is kept off the transferable capture descriptor. */
interface LifecycleCaptureState {
  readonly hooks: readonly LifecycleCapturedHook[];
  readonly abort: AbortController;
  readonly maxInvocations: number;
  readonly invocations: Map<
    string,
    { canonical: string; promise: Promise<LifecycleDispatchOutcome> }
  >;
  released: boolean;
}

/** Explicit trusted host registration only. This registry never discovers or executes workspace hook files. */
export class LifecycleHookRegistry {
  readonly limits: Readonly<LifecycleLimits>;
  private readonly hooks = new Map<string, LifecycleCapturedHook>();
  private readonly revisions = new Map<string, number>();
  private readonly captures = new WeakMap<
    LifecycleCapture,
    LifecycleCaptureState
  >();
  private generation = 0;
  private registrationIndex = 0;
  constructor(limits: Partial<LifecycleLimits> = {}) {
    this.limits = lifecycleLimits(limits);
  }
  get revision(): number {
    return this.generation;
  }
  list(): readonly LifecycleHookDescriptor[] {
    return freezeLifecycle(this.ordered().map((item) => item.descriptor));
  }
  register(input: LifecycleHookRegistration): () => void {
    if (
      !input ||
      typeof input !== "object" ||
      types.isProxy(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_HOOK",
        "Lifecycle hook registration must be a plain host object",
      );
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== "string" ||
          ![
            "id",
            "revision",
            "stages",
            "order",
            "timeoutMs",
            "failurePolicy",
            "callback",
          ].includes(key) ||
          !("value" in descriptors[key]!) ||
          !descriptors[key]!.enumerable,
      )
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_HOOK",
        "Lifecycle hook registration has unsupported fields or accessors",
      );
    const { id, revision, callback } = input;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(id) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      typeof callback !== "function"
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_HOOK",
        "Lifecycle hooks require a bounded stable id, positive revision and host callback",
      );
    if (this.hooks.has(id))
      throw new EngineError(
        "LIFECYCLE_HOOK_DUPLICATE",
        "Lifecycle hook id is already registered",
      );
    if (revision <= (this.revisions.get(id) ?? 0))
      throw new EngineError(
        "LIFECYCLE_HOOK_REVISION",
        "Reused lifecycle hook ids require a newer host revision",
      );
    if (this.hooks.size >= this.limits.maxHooks)
      throw new EngineError(
        "LIFECYCLE_HOOK_LIMIT",
        "Lifecycle registry reached its active hook limit",
      );
    if (
      !this.revisions.has(id) &&
      this.revisions.size >= this.limits.maxHookIdentities
    )
      throw new EngineError(
        "LIFECYCLE_HOOK_IDENTITY_LIMIT",
        "Lifecycle registry reached its bounded revision identity limit",
      );
    let stages: LifecycleHookRegistration["stages"];
    try {
      const clone = boundedLifecycleJson(input.stages, 256);
      if (
        !Array.isArray(clone) ||
        clone.length === 0 ||
        clone.length > LIFECYCLE_STAGES.length ||
        clone.some(
          (stage) =>
            !LIFECYCLE_STAGES.includes(
              stage as (typeof LIFECYCLE_STAGES)[number],
            ),
        ) ||
        new Set(clone).size !== clone.length
      )
        throw new Error("Invalid stages");
      stages = clone as LifecycleHookRegistration["stages"];
    } catch {
      throw new EngineError(
        "INVALID_LIFECYCLE_HOOK",
        "Lifecycle stages must be unique plain supported stage names",
      );
    }
    const order = input.order ?? 0,
      timeoutMs = input.timeoutMs ?? this.limits.maxHookTimeoutMs,
      failurePolicy = input.failurePolicy ?? "stop";
    if (
      !Number.isSafeInteger(order) ||
      Math.abs(order) > 1_000_000 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > this.limits.maxHookTimeoutMs ||
      !["observe", "deny", "stop"].includes(failurePolicy) ||
      (failurePolicy === "deny" &&
        stages.some((stage) => !allowsLifecycleDeny(stage)))
    )
      throw new EngineError(
        "INVALID_LIFECYCLE_HOOK",
        "Lifecycle hook order, deadline or failure policy is invalid for its stages",
      );
    const descriptor = freezeLifecycle({
      id,
      revision,
      stages: [...stages],
      order,
      timeoutMs,
      failurePolicy,
      registrationIndex: ++this.registrationIndex,
    });
    const registered = Object.freeze({ descriptor, callback });
    this.hooks.set(id, registered);
    this.revisions.set(id, revision);
    this.generation++;
    return () => {
      if (this.hooks.get(id) === registered) {
        this.hooks.delete(id);
        this.generation++;
      }
    };
  }
  capture(
    identity: LifecycleRunIdentity,
    runLimits?: Readonly<Pick<RunLimits, "maxTurns" | "maxToolCalls">>,
  ): LifecycleCapture {
    const hooks = this.ordered(),
      maxInvocations = lifecycleInvocationLimit(this.limits, runLimits);
    const capture = freezeLifecycle({
      identity: lifecycleIdentity(identity),
      registryRevision: this.generation,
      hooks: hooks.map((item) => item.descriptor),
    });
    this.captures.set(capture, {
      hooks,
      abort: new AbortController(),
      maxInvocations,
      invocations: new Map(),
      released: false,
    });
    return capture;
  }
  /** Cancels acceptance of active callbacks; it is not a physical cleanup receipt for any external effects. */
  release(capture: LifecycleCapture): void {
    const state = this.captureState(capture);
    if (state.released) return;
    state.released = true;
    state.abort.abort(
      new EngineError(
        "LIFECYCLE_CAPTURE_RELEASED",
        "Lifecycle capture is no longer active",
      ),
    );
    state.invocations.clear();
  }
  assertCurrent(capture: LifecycleCapture): void {
    const state = this.captureState(capture);
    if (state.released)
      throw new EngineError(
        "LIFECYCLE_CAPTURE_RELEASED",
        "Lifecycle capture is no longer active",
      );
    if (capture.registryRevision !== this.generation)
      throw new EngineError(
        "LIFECYCLE_REGISTRY_STALE",
        "Lifecycle registry changed after this Run capture",
      );
  }
  /** Package dispatch port. A forged/cloned capture has no callbacks or authority. */
  captureState(capture: LifecycleCapture): LifecycleCaptureState {
    const state = this.captures.get(capture);
    if (!state)
      throw new EngineError(
        "INVALID_LIFECYCLE_CAPTURE",
        "Lifecycle capture does not belong to this registry",
      );
    return state;
  }
  dispatch(
    capture: LifecycleCapture,
    invocation: LifecycleInvocation,
    signal: AbortSignal,
  ): Promise<LifecycleDispatchOutcome> {
    return dispatchLifecycleHooks(this, capture, invocation, signal);
  }
  private ordered(): readonly LifecycleCapturedHook[] {
    return Object.freeze(
      [...this.hooks.values()].sort(
        (a, b) =>
          a.descriptor.order - b.descriptor.order ||
          a.descriptor.registrationIndex - b.descriptor.registrationIndex,
      ),
    );
  }
}
