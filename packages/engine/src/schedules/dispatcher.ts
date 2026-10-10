import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  ScheduleHost,
  scheduleHostAbort,
  scheduleHostError,
  scheduleHostRecord,
  type ScheduleHostNativePort,
} from "./host.js";
import { scheduleIdentifier, scheduleInteger } from "./spec.js";
import type {
  DispatchScheduleClaimInput,
  ScheduleRequestResult,
  SettleScheduleClaimInput,
  TriggerOccurrence,
} from "./store.js";

export interface ScheduleDispatcherNativePort extends ScheduleHostNativePort {
  dispatchClaim(
    originalClaim: object,
    input: DispatchScheduleClaimInput,
  ): ScheduleRequestResult<TriggerOccurrence>;
  completeAccepted(
    originalClaim: object,
    originalAccepted: object,
    input: SettleScheduleClaimInput,
  ): ScheduleRequestResult<TriggerOccurrence>;
  settleObserved(
    originalObservation: object,
    originalObserved: object,
    input: SettleScheduleClaimInput,
  ): ScheduleRequestResult<TriggerOccurrence>;
  abandonClaim(
    originalClaim: object,
    input: SettleScheduleClaimInput & {
      readonly errorCode: string;
      readonly operation: "cancelled" | "uncertain";
    },
  ): ScheduleRequestResult<TriggerOccurrence>;
}
export interface DispatchScheduleOccurrenceInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly approved: boolean;
  readonly claim: object;
  readonly signal?: AbortSignal;
}
export interface ObserveScheduleOccurrenceInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly observation: object;
  readonly signal?: AbortSignal;
}
interface CachedRequest {
  readonly original: object;
  readonly sha256: string;
  result?: ScheduleRequestResult<TriggerOccurrence>;
  error?: unknown;
  finished: boolean;
}
/** Bounds in-flight requests; the least recently used finished one makes room, since store receipts keep no-replay. */
const REQUEST_CACHE_LIMIT = 256;

/** Explicit queue delivery uses one actual acceptance between durable intent and native receipt. */
export class ScheduleDispatcher {
  private readonly requests = new Map<string, CachedRequest>();
  private readonly lifetime = new AbortController();
  private closed = false;
  constructor(
    readonly ports: {
      native: ScheduleDispatcherNativePort;
      host: ScheduleHost;
    },
  ) {}
  private open(): void {
    if (this.closed) scheduleHostError("SCHEDULE_CLOSED");
    scheduleHostAbort(this.lifetime.signal);
  }
  private identity(input: {
    workspaceId: string;
    requestId: string;
    expectedRevision: number;
  }): void {
    scheduleIdentifier(input.workspaceId);
    scheduleIdentifier(input.requestId);
    scheduleInteger(input.expectedRevision, Number.MAX_SAFE_INTEGER, 1);
  }
  private request(
    operation: "dispatch" | "observe",
    original: object,
    input: { workspaceId: string; requestId: string; expectedRevision: number },
  ): {
    current: CachedRequest;
    duplicate?: ScheduleRequestResult<TriggerOccurrence>;
  } {
    if (!original || typeof original !== "object" || types.isProxy(original))
      scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    const key = knowledgeHash({
        operation,
        workspaceId: input.workspaceId,
        requestId: input.requestId,
      }),
      sha256 = knowledgeHash({ operation, ...input });
    const prior = this.requests.get(key);
    if (prior) {
      if (prior.original !== original || prior.sha256 !== sha256)
        scheduleHostError("SCHEDULE_REQUEST_CONFLICT");
      if (!prior.finished) scheduleHostError("SCHEDULE_REQUEST_IN_PROGRESS");
      this.requests.delete(key);
      this.requests.set(key, prior);
      if (prior.error !== undefined) throw prior.error;
      if (!prior.result) scheduleHostError("SCHEDULE_REQUEST_UNCERTAIN");
      return {
        current: prior,
        duplicate: structuredClone({ ...prior.result, duplicate: true }),
      };
    }
    if (this.requests.size >= REQUEST_CACHE_LIMIT) {
      for (const [stale, entry] of this.requests)
        if (entry.finished) {
          this.requests.delete(stale);
          break;
        }
      if (this.requests.size >= REQUEST_CACHE_LIMIT)
        scheduleHostError("SCHEDULE_REQUEST_LIMIT");
    }
    const current: CachedRequest = { original, sha256, finished: false };
    this.requests.set(key, current);
    return { current };
  }
  private finish(
    current: CachedRequest,
    result: ScheduleRequestResult<TriggerOccurrence>,
  ): ScheduleRequestResult<TriggerOccurrence> {
    current.result = structuredClone(result);
    current.finished = true;
    return structuredClone(current.result);
  }
  dispatch(
    input: DispatchScheduleOccurrenceInput,
  ): ScheduleRequestResult<TriggerOccurrence> {
    scheduleHostRecord(
      input,
      ["workspaceId", "requestId", "expectedRevision", "approved", "claim"],
      ["signal"],
    );
    this.open();
    this.identity(input);
    scheduleHostAbort(input.signal);
    if (input.approved !== true)
      scheduleHostError("SCHEDULE_APPROVAL_REQUIRED");
    const selected = this.request("dispatch", input.claim, {
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
    });
    if (selected.duplicate) return selected.duplicate;
    let binding: object | undefined, accepted: object | undefined;
    let intent: ScheduleRequestResult<TriggerOccurrence> | undefined;
    let acceptanceAttempted = false;
    try {
      binding = this.ports.host.bindDispatch(input.claim, input.signal);
      const { image, prompt } = this.ports.host.read(binding);
      if (
        image.workspaceId !== input.workspaceId ||
        image.occurrenceRevision !== input.expectedRevision
      )
        scheduleHostError("SCHEDULE_CLAIM_STALE");
      this.ports.host.assertDispatch(binding, input.signal);
      intent = this.ports.native.dispatchClaim(input.claim, {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        inputRequestId: image.inputRequestId,
        prompt,
      });
      if (intent.duplicate) return this.finish(selected.current, intent);
      this.open();
      scheduleHostAbort(input.signal);
      acceptanceAttempted = true;
      accepted = this.ports.host.accept(binding, input.signal);
      const result = this.ports.native.completeAccepted(input.claim, accepted, {
        workspaceId: input.workspaceId,
        requestId: `accepted:${knowledgeHash({ occurrenceId: image.occurrenceId, requestId: input.requestId })}`,
        expectedRevision: intent.record.revision,
      });
      return this.finish(selected.current, result);
    } catch (error) {
      if (intent && !intent.duplicate) {
        try {
          this.ports.native.abandonClaim(input.claim, {
            workspaceId: input.workspaceId,
            requestId: `uncertain:${knowledgeHash({ requestId: input.requestId, occurrenceId: intent.record.occurrenceId })}`,
            expectedRevision: intent.record.revision,
            errorCode:
              error instanceof EngineError
                ? error.code
                : "SCHEDULE_DISPATCH_FAILED",
            operation:
              !acceptanceAttempted &&
              error instanceof EngineError &&
              error.code === "CANCELLED"
                ? "cancelled"
                : "uncertain",
          });
        } catch {
          // The durable dispatch intent remains uncertain if the physical writer or CAS was lost.
        }
      }
      selected.current.error = error;
      selected.current.finished = true;
      throw error;
    } finally {
      if (accepted) this.ports.host.releaseProduced(accepted);
      if (binding) this.ports.host.release(binding);
    }
  }
  observe(
    input: ObserveScheduleOccurrenceInput,
  ): ScheduleRequestResult<TriggerOccurrence> {
    scheduleHostRecord(
      input,
      ["workspaceId", "requestId", "expectedRevision", "observation"],
      ["signal"],
    );
    this.open();
    this.identity(input);
    scheduleHostAbort(input.signal);
    const selected = this.request("observe", input.observation, {
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
    });
    if (selected.duplicate) return selected.duplicate;
    let binding: object | undefined, observed: object | undefined;
    try {
      binding = this.ports.host.bindObservation(
        input.observation,
        input.signal,
      );
      const { image } = this.ports.host.read(binding);
      if (
        image.workspaceId !== input.workspaceId ||
        image.occurrenceRevision !== input.expectedRevision
      )
        scheduleHostError("SCHEDULE_OBSERVATION_STALE");
      this.open();
      observed = this.ports.host.observe(binding, input.signal);
      const result = this.ports.native.settleObserved(
        input.observation,
        observed,
        {
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
        },
      );
      return this.finish(selected.current, result);
    } catch (error) {
      selected.current.error = error;
      selected.current.finished = true;
      throw error;
    } finally {
      if (observed) this.ports.host.releaseProduced(observed);
      if (binding) this.ports.host.release(binding);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.requests.clear();
    this.lifetime.abort();
    this.ports.host.close();
  }
}
