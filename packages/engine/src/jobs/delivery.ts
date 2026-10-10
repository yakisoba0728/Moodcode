import { EngineError, type RunConfigInput } from "@moodcode/contracts";
import type { ScheduleTargetPin } from "../schedules/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { jobHostAbort, jobHostRecord } from "./host.js";
import { jobIdentifier, jobInteger, jobJson } from "./validation.js";
import type {
  AbandonJobDeliveryInput,
  CommandJob,
  DeliverJobResultAtomicInput,
  DispatchJobDeliveryInput,
  JobDelivery as NativeJobDelivery,
  JobRequestResult,
  MutateJobDeliveryInput,
  PrepareJobDeliveryInput,
} from "./store.js";

/** Immutable DATA pins; authority belongs to the producer's original target. */
export interface JobDeliveryTargetProof {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly jobRevisionId: string;
  readonly jobSha256: string;
  readonly settledSha256: string;
  readonly sourceSha256: string;
  readonly target: ScheduleTargetPin;
  readonly sha256: string;
}
export interface JobAcceptedInputProof {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly requestId: string;
  readonly admittedSeq: number;
  readonly inputSha256: string;
  readonly sha256: string;
}

/** A synchronous actual InputScheduler receipt never comes from a caller DTO. */
export interface ActualJobInputPort {
  captureTarget(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly config: RunConfigInput;
  }): object;
  readTarget(original: object): JobDeliveryTargetProof;
  assertTargetCurrent(original: object, expected: JobDeliveryTargetProof): void;
  captureInput(
    originalTarget: object,
    input: { readonly inputRequestId: string; readonly prompt: string },
  ): object;
  accept(originalInput: object): object;
  readAccepted(originalAccepted: object): JobAcceptedInputProof;
  release(original: object): void;
}

/** Complete quoted observation DATA; output cursors grant no execution access. */
export function formatJobResult(
  job: CommandJob,
  target: JobDeliveryTargetProof,
): string {
  if (
    !["completed", "failed", "cancelled"].includes(job.state) ||
    job.outcome?.cleanupConfirmed !== true ||
    job.workspaceId !== target.workspaceId ||
    job.jobId !== target.jobId ||
    job.id !== target.jobRevisionId ||
    job.sha256 !== target.jobSha256 ||
    job.sha256 !== target.settledSha256 ||
    job.sourceSha256 !== target.sourceSha256 ||
    job.sessionId !== target.target.sessionId
  )
    throw new EngineError(
      "JOB_NOT_SETTLED",
      "Job delivery requires its exact genuine settled terminal observation",
    );
  const data = jobJson(
    {
      schemaVersion: 1,
      authority: "untrusted-terminal-observation",
      jobId: job.jobId,
      jobKind: job.jobKind,
      sourceSha256: job.sourceSha256,
      settledSha256: target.settledSha256,
      state: job.state,
      outcome: job.outcome,
      cursor: job.cursor,
    },
    32_768,
  );
  const prompt =
    "[Moodcode user terminal job result v1]\n" + JSON.stringify(data);
  if (Buffer.byteLength(prompt) > 32_768)
    throw new EngineError(
      "JOB_LIMIT",
      "The whole job result must fit its input budget",
    );
  return prompt;
}
export interface JobDeliveryNativePort {
  /** The trusted Root can admit its actual native input and receipt in one transaction. */
  deliverJobResultAtomic?(
    originalTarget: object,
    input: DeliverJobResultAtomicInput,
  ): JobRequestResult<NativeJobDelivery>;
  getJob(
    workspaceId: string,
    jobId: string,
    revisionId?: string,
  ): CommandJob | undefined;
  prepareJobDelivery(
    originalTarget: object,
    input: PrepareJobDeliveryInput,
  ): JobRequestResult<NativeJobDelivery>;
  dispatchJobDelivery(
    originalTarget: object,
    input: DispatchJobDeliveryInput,
  ): JobRequestResult<NativeJobDelivery>;
  completeJobDelivery(
    originalTarget: object,
    originalAccepted: object,
    input: MutateJobDeliveryInput,
  ): JobRequestResult<NativeJobDelivery>;
  abandonJobDelivery(
    input: AbandonJobDeliveryInput,
  ): JobRequestResult<NativeJobDelivery>;
}
export interface DeliverCommandJobResultInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly target: object;
  readonly approved: boolean;
  readonly signal?: AbortSignal;
}
interface DeliveryRequest {
  readonly original: object;
  readonly sha256: string;
  result?: JobRequestResult<NativeJobDelivery>;
  error?: unknown;
}

/** One actual queue acceptance between explicit native intent and its receipt. */
export class JobDelivery {
  private readonly targets = new Map<object, JobDeliveryTargetProof>();
  private readonly requests = new Map<string, DeliveryRequest>();
  private readonly signal: AbortSignal;
  private closed = false;
  constructor(
    readonly ports: {
      readonly native: JobDeliveryNativePort;
      readonly input: ActualJobInputPort;
      readonly lifetime?: AbortSignal;
    },
  ) {
    this.signal = ports.lifetime ?? new AbortController().signal;
  }
  private open(): void {
    if (this.closed)
      throw new EngineError("JOB_CLOSED", "Job result delivery is closed");
    jobHostAbort(this.signal);
  }
  captureTarget(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly config: RunConfigInput;
  }): object {
    this.open();
    jobHostRecord(input, ["workspaceId", "jobId", "config"]);
    jobIdentifier(input.workspaceId);
    jobIdentifier(input.jobId);
    if (this.targets.size >= 128)
      throw new EngineError(
        "JOB_HANDLE_LIMIT",
        "Job delivery target limit was reached",
      );
    const original = this.ports.input.captureTarget(jobJson(input, 65_536));
    try {
      const proof = this.ports.input.readTarget(original);
      this.targets.set(original, structuredClone(proof));
      return original;
    } catch (error) {
      this.ports.input.release(original);
      throw error;
    }
  }
  readTarget(original: object): JobDeliveryTargetProof {
    this.open();
    const expected = this.targets.get(original);
    if (!expected)
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        "Job delivery requires its original fixed target",
      );
    this.ports.input.assertTargetCurrent(original, expected);
    return structuredClone(this.ports.input.readTarget(original));
  }
  deliver(
    input: DeliverCommandJobResultInput,
  ): JobRequestResult<NativeJobDelivery> {
    jobHostRecord(
      input,
      ["workspaceId", "requestId", "expectedRevision", "target", "approved"],
      ["signal"],
    );
    jobIdentifier(input.workspaceId);
    jobIdentifier(input.requestId);
    jobInteger(input.expectedRevision);
    jobHostAbort(input.signal);
    if (input.approved !== true)
      throw new EngineError(
        "JOB_APPROVAL_REQUIRED",
        "Explicit job result delivery requires approval of its original target",
      );
    const expected = this.targets.get(input.target);
    if (!expected)
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        "Job delivery requires its original fixed target",
      );
    const key = JSON.stringify([input.workspaceId, input.requestId]);
    const sha256 = knowledgeHash({
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      targetSha256: expected.sha256,
    });
    const prior = this.requests.get(key);
    if (prior) {
      if (prior.original !== input.target || prior.sha256 !== sha256)
        throw new EngineError(
          "JOB_REQUEST_CONFLICT",
          "Job delivery request changed",
        );
      if (prior.result)
        return structuredClone({ ...prior.result, duplicate: true });
      throw (
        prior.error ??
        new EngineError(
          "JOB_DELIVERY_UNCERTAIN",
          "Job delivery cannot be replayed",
        )
      );
    }
    this.open();
    if (this.requests.size >= 128)
      throw new EngineError(
        "JOB_HANDLE_LIMIT",
        "Job delivery request limit was reached",
      );
    const target = this.readTarget(input.target);
    if (
      target.workspaceId !== input.workspaceId ||
      knowledgeHash(target) !== knowledgeHash(expected)
    )
      throw new EngineError(
        "JOB_DELIVERY_STALE",
        "The selected job result target changed",
      );
    const job = this.ports.native.getJob(
      target.workspaceId,
      target.jobId,
      target.jobRevisionId,
    );
    if (!job)
      throw new EngineError(
        "JOB_NOT_FOUND",
        "The exact settled job result was not found",
      );
    const prompt = formatJobResult(job, target),
      inputRequestId = `job-result:${target.jobId}:${target.settledSha256}`;
    jobIdentifier(inputRequestId);
    const cached: DeliveryRequest = { original: input.target, sha256 };
    this.requests.set(key, cached);
    let delivery: NativeJobDelivery | undefined,
      originalInput: object | undefined,
      accepted: object | undefined,
      intent = false;
    try {
      if (this.ports.native.deliverJobResultAtomic) {
        jobHostAbort(input.signal);
        jobHostAbort(this.signal);
        this.ports.input.assertTargetCurrent(input.target, target);
        const completed = this.ports.native.deliverJobResultAtomic(
          input.target,
          {
            workspaceId: input.workspaceId,
            jobId: target.jobId,
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
          },
        );
        cached.result = structuredClone(completed);
        return structuredClone(completed);
      }
      const prepared = this.ports.native.prepareJobDelivery(input.target, {
        workspaceId: input.workspaceId,
        jobId: target.jobId,
        deliveryId: knowledgeHash([
          "job-result-delivery-v1",
          target.workspaceId,
          target.jobId,
          target.settledSha256,
        ]),
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
      });
      delivery = prepared.record;
      if (prepared.duplicate) {
        cached.result = structuredClone(prepared);
        return structuredClone(prepared);
      }
      jobHostAbort(input.signal);
      jobHostAbort(this.signal);
      originalInput = this.ports.input.captureInput(input.target, {
        inputRequestId,
        prompt,
      });
      this.ports.input.assertTargetCurrent(input.target, target);
      const dispatched = this.ports.native.dispatchJobDelivery(input.target, {
        workspaceId: input.workspaceId,
        deliveryId: delivery.deliveryId,
        requestId: knowledgeHash(["job-intent", input.requestId]),
        expectedRevision: delivery.revision,
        inputRequestId,
        prompt,
      });
      delivery = dispatched.record;
      if (dispatched.duplicate)
        throw new EngineError(
          "JOB_DELIVERY_UNCERTAIN",
          "A historical dispatch intent cannot grant another acceptance",
        );
      intent = true;
      jobHostAbort(input.signal);
      jobHostAbort(this.signal);
      this.ports.input.assertTargetCurrent(input.target, target);
      accepted = this.ports.input.accept(originalInput);
      const completed = this.ports.native.completeJobDelivery(
        input.target,
        accepted,
        {
          workspaceId: input.workspaceId,
          deliveryId: delivery.deliveryId,
          requestId: knowledgeHash(["job-accepted", input.requestId]),
          expectedRevision: delivery.revision,
        },
      );
      cached.result = structuredClone(completed);
      return structuredClone(completed);
    } catch (error) {
      cached.error = error;
      if (delivery && ["prepared", "dispatching"].includes(delivery.state)) {
        try {
          this.ports.native.abandonJobDelivery({
            workspaceId: input.workspaceId,
            deliveryId: delivery.deliveryId,
            requestId: knowledgeHash(["job-abandoned", input.requestId]),
            expectedRevision: delivery.revision,
            operation: intent ? "uncertain" : "cancelled",
            errorCode:
              error instanceof EngineError ? error.code : "JOB_DELIVERY_FAILED",
          });
        } catch {
          /* The original durable intent remains unresolved and cannot replay. */
        }
      }
      throw error;
    } finally {
      if (accepted) this.ports.input.release(accepted);
      if (originalInput) this.ports.input.release(originalInput);
    }
  }
  release(original: object): void {
    if (!this.targets.delete(original)) return;
    // Released targets fail JOB_ORIGINAL_REQUIRED first; store dedupe blocks replay.
    for (const [key, request] of this.requests)
      if (request.original === original) this.requests.delete(key);
    this.ports.input.release(original);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const original of this.targets.keys()) this.release(original);
    this.requests.clear();
  }
}
