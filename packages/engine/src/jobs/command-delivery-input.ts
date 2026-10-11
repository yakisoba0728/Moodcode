import { types } from "node:util";
import {
  EngineError,
  type AcceptInput,
  type InputRecord,
  type Run,
  type RunConfigInput,
} from "@moodcode/contracts";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  describeQueueTarget,
  jobTargetChanged,
} from "../runner/queue-target.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import type {
  CommandDeliveryInput,
  CommandDeliveryRecord,
  CommandDeliveryResult,
  CommandDeliveryTargetProof,
  CommandResultProfile,
} from "./command-delivery-records.js";
import type { JobAcceptedInputProof } from "./delivery.js";
import {
  jobHostAbort,
  jobHostRecord,
  jobIdentifier,
  jobJson,
  signJobData,
} from "./validation.js";

export function acceptedRequest(input: InputRecord): AcceptInput {
  return {
    sessionId: input.sessionId,
    requestId: input.requestId,
    prompt: input.prompt,
    config: input.config,
    delivery: input.delivery,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.documents ? { documents: input.documents } : {}),
  };
}

export function isPromotedCommandRunInvalid(
  input: InputRecord,
  run: Run,
  receipt: { readonly target: { readonly config: Run["config"] } },
): boolean {
  return (
    input.state !== "promoted" ||
    input.runId !== run.id ||
    run.workspaceId !== input.workspaceId ||
    run.sessionId !== input.sessionId ||
    run.requestId !== input.requestId ||
    run.prompt !== input.prompt ||
    knowledgeHash(run.config) !== knowledgeHash(receipt.target.config) ||
    Object.hasOwn(run, "attachments") ||
    Object.hasOwn(run, "documents")
  );
}

export interface ActualCommandInputPort<P> {
  captureTarget(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly config: RunConfigInput;
  }): object;
  readTarget(original: object): P;
  assertTargetCurrent(original: object, expected: P): void;
  release(original: object): void;
}
export interface CommandDeliveryNativePort<S> {
  /** Genuine Root input acceptance and its native receipt share a single primary transaction. */
  deliver(
    originalTarget: object,
    input: CommandDeliveryInput,
  ): CommandDeliveryResult<S>;
}
export interface DeliverCommandJobResultInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: 0;
  readonly target: object;
  readonly approved: boolean;
  readonly signal?: AbortSignal;
}
export interface CommandResultDeliveryPorts<S, P> {
  readonly native: CommandDeliveryNativePort<S>;
  readonly input: ActualCommandInputPort<P>;
  readonly lifetime?: AbortSignal;
}
interface Request<S> {
  readonly original: object;
  readonly sha256: string;
  result?: CommandDeliveryResult<S>;
  error?: unknown;
}

/** Explicit Root delivery of one settled command observation, retained by its original target. */
export class CommandResultDelivery<S, P extends CommandDeliveryTargetProof<S>> {
  private readonly targets = new Map<object, P>();
  private readonly requests = new Map<string, Request<S>>();
  private readonly signal: AbortSignal;
  private closed = false;
  constructor(
    readonly ports: CommandResultDeliveryPorts<S, P>,
    private readonly profile: CommandResultProfile<S, P>,
  ) {
    this.signal = ports.lifetime ?? new AbortController().signal;
  }
  private open(): void {
    if (this.closed)
      throw new EngineError(
        "JOB_CLOSED",
        `${this.profile.label} result delivery is closed`,
      );
    jobHostAbort(this.signal);
  }
  captureTarget(
    input: Parameters<ActualCommandInputPort<P>["captureTarget"]>[0],
  ): object {
    this.open();
    jobHostRecord(input, ["workspaceId", "jobId", "config"]);
    jobIdentifier(input.workspaceId);
    jobIdentifier(input.jobId);
    if (this.targets.size >= 128)
      throw new EngineError(
        "JOB_HANDLE_LIMIT",
        `${this.profile.label} delivery target limit was reached`,
      );
    const original = this.ports.input.captureTarget(jobJson(input, 65_536));
    try {
      const proof = this.profile.validateTarget(
        this.ports.input.readTarget(original),
      );
      if (
        proof.workspaceId !== input.workspaceId ||
        proof.jobId !== input.jobId
      )
        throw new EngineError(
          "COMMAND_JOB_TARGET_STALE",
          `${this.profile.label} capture selected another completed job`,
        );
      this.ports.input.assertTargetCurrent(original, proof);
      this.targets.set(original, structuredClone(proof));
      return original;
    } catch (failure) {
      this.ports.input.release(original);
      throw failure;
    }
  }
  readTarget(original: object): P {
    this.open();
    const expected = this.targets.get(original);
    if (!expected)
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        `${this.profile.label} delivery requires its retained original target`,
      );
    this.ports.input.assertTargetCurrent(original, expected);
    const actual = this.profile.validateTarget(
      this.ports.input.readTarget(original),
    );
    if (knowledgeHash(actual) !== knowledgeHash(expected))
      throw new EngineError(
        "COMMAND_JOB_TARGET_STALE",
        `${this.profile.label} delivery target changed`,
      );
    return structuredClone(actual);
  }
  deliver(input: DeliverCommandJobResultInput): CommandDeliveryResult<S> {
    jobHostRecord(
      input,
      ["workspaceId", "requestId", "expectedRevision", "target", "approved"],
      ["signal"],
    );
    jobIdentifier(input.workspaceId);
    jobIdentifier(input.requestId);
    if (input.expectedRevision !== 0)
      throw new EngineError(
        "REVISION_CONFLICT",
        `${this.profile.label} delivery starts at revision zero`,
      );
    jobHostAbort(input.signal);
    this.open();
    if (input.approved !== true)
      throw new EngineError(
        "JOB_APPROVAL_REQUIRED",
        "Delivery requires explicit approval of the original fixed target",
      );
    const expected = this.targets.get(input.target);
    if (!expected || expected.workspaceId !== input.workspaceId)
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        `${this.profile.label} delivery requires its retained original target`,
      );
    const nativeInput: CommandDeliveryInput = {
      workspaceId: input.workspaceId,
      jobId: expected.jobId,
      requestId: input.requestId,
      expectedRevision: 0,
      targetSha256: expected.sha256,
    };
    const key = knowledgeHash([input.workspaceId, input.requestId]),
      sha256 = knowledgeHash(nativeInput),
      prior = this.requests.get(key);
    if (prior) {
      if (prior.original !== input.target || prior.sha256 !== sha256)
        throw new EngineError(
          "JOB_REQUEST_CONFLICT",
          `${this.profile.label} delivery request changed`,
        );
      if (prior.result)
        return structuredClone({ ...prior.result, kind: "duplicate" });
      throw (
        prior.error ??
        new EngineError(
          "JOB_DELIVERY_UNCERTAIN",
          `${this.profile.label} delivery cannot be replayed`,
        )
      );
    }
    if (this.requests.size >= 128)
      throw new EngineError(
        "JOB_HANDLE_LIMIT",
        `${this.profile.label} delivery request limit was reached`,
      );
    const proof = this.readTarget(input.target);
    this.profile.formatResult(proof.settled, proof);
    const request: Request<S> = { original: input.target, sha256 };
    this.requests.set(key, request);
    try {
      jobHostAbort(input.signal);
      jobHostAbort(this.signal);
      this.ports.input.assertTargetCurrent(input.target, proof);
      const result = this.ports.native.deliver(input.target, nativeInput);
      request.result = structuredClone(result);
      return structuredClone(result);
    } catch (failure) {
      request.error = failure;
      throw failure;
    }
  }
  release(original: object): void {
    if (!this.targets.delete(original)) return;
    this.ports.input.release(original);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const original of [...this.targets.keys()]) this.release(original);
    this.requests.clear();
  }
}

export interface CommandSettledSource<S> {
  captureSettledSource(input: { workspaceId: string; jobId: string }): object;
  readSettledSource(original: object): S;
  release(original: object): void;
}
interface Target<P> {
  readonly source: object;
  readonly binding: KnowledgeHostBinding;
  readonly proof: P;
}
function fail(code: string): never {
  throw new EngineError(
    code,
    "The original settled command delivery target or actual native input changed",
  );
}
/** Current command observations and actual queue acceptance share this Root-private producer. */
export class EngineCommandDeliveryProducer<
  S,
  P extends CommandDeliveryTargetProof<S>,
> {
  private readonly targets = new WeakMap<object, Target<P>>();
  private readonly accepted = new WeakMap<object, JobAcceptedInputProof>();
  private readonly retained = new Set<object>();
  private closed = false;
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly checkBinding: (
      workspaceId: string,
    ) => KnowledgeHostBinding,
    private readonly enabled: () => boolean,
    private readonly source: CommandSettledSource<S>,
    private readonly profile: CommandResultProfile<S, P>,
    private readonly findDelivery: (
      store: MoodcodeEngine["store"],
      input: {
        workspaceId: string;
        sessionId: string;
        inputId: string;
        requestId: string;
      },
    ) => CommandDeliveryRecord<S> | null,
  ) {}
  private open(): void {
    if (this.closed) fail("ENGINE_CLOSED");
  }
  private active(): void {
    this.open();
    if (!this.enabled()) fail("JOBS_DISABLED");
  }
  private binding(workspaceId: string): KnowledgeHostBinding {
    this.open();
    const binding = jobJson(this.checkBinding(workspaceId));
    assertPhysicalKnowledgeRoot(binding);
    return binding;
  }
  private issue<T>(map: WeakMap<object, T>, data: T): object {
    this.open();
    if (this.retained.size >= 256) fail("JOB_HANDLE_LIMIT");
    const original = Object.freeze({});
    map.set(original, data);
    this.retained.add(original);
    return original;
  }
  private original<T>(map: WeakMap<object, T>, original: object): T {
    this.open();
    if (
      !original ||
      typeof original !== "object" ||
      types.isProxy(original) ||
      !this.retained.has(original)
    )
      fail("JOB_ORIGINAL_REQUIRED");
    const value = map.get(original);
    if (!value) fail("JOB_ORIGINAL_REQUIRED");
    return value;
  }
  captureTarget(
    input: Parameters<ActualCommandInputPort<P>["captureTarget"]>[0],
  ): object {
    this.active();
    jobHostRecord(input, ["workspaceId", "jobId", "config"]);
    const data = jobJson(input, 65536);
    const binding = this.binding(data.workspaceId),
      source = this.source.captureSettledSource({
        workspaceId: data.workspaceId,
        jobId: data.jobId,
      });
    try {
      const settled = this.source.readSettledSource(source),
        sessionId = this.profile.sessionOf(settled);
      const normalized = normalizeAcceptInput({
        sessionId,
        requestId: this.profile.placeholder,
        prompt: this.profile.placeholder,
        config: data.config,
        delivery: "queue",
      });
      normalized.config = this.engine.profiles.apply(
        sessionId,
        normalized.config,
      );
      const target = describeQueueTarget(
        this.engine,
        (id) => this.binding(id),
        data.workspaceId,
        sessionId,
        normalized.config,
        jobTargetChanged,
      ).pin;
      const { jobSha256, sourceSha256 } = this.profile.digests(settled);
      const proof = this.profile.validateTarget(
        signJobData(
          {
            version: 1 as const,
            workspaceId: data.workspaceId,
            jobId: data.jobId,
            jobSha256,
            sourceSha256,
            settled,
            target,
          },
          this.profile.proofBytes,
        ),
      );
      return this.issue(this.targets, { source, binding, proof });
    } catch (error) {
      this.source.release(source);
      throw error;
    }
  }
  private assertTarget(target: Target<P>): void {
    this.active();
    const proof = target.proof;
    if (
      knowledgeHash(this.binding(proof.workspaceId)) !==
      knowledgeHash(target.binding)
    )
      fail("COMMAND_JOB_TARGET_STALE");
    const settled = this.source.readSettledSource(target.source);
    if (
      this.profile.digests(settled).jobSha256 !== proof.jobSha256 ||
      knowledgeHash(settled) !== knowledgeHash(proof.settled)
    )
      fail("COMMAND_JOB_TARGET_STALE");
    this.profile.formatResult(settled, proof);
    const current = describeQueueTarget(
      this.engine,
      (id) => this.binding(id),
      proof.workspaceId,
      proof.target.sessionId,
      proof.target.config,
      jobTargetChanged,
    ).pin;
    if (knowledgeHash(current) !== knowledgeHash(proof.target))
      fail("JOB_TARGET_STALE");
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(proof.workspaceId);
  }
  readTarget(original: object): P {
    const target = this.original(this.targets, original);
    this.assertTarget(target);
    return structuredClone(target.proof);
  }
  assertTargetCurrent(original: object, expected: P): void {
    if (knowledgeHash(this.readTarget(original)) !== knowledgeHash(expected))
      fail("COMMAND_JOB_TARGET_STALE");
  }
  acceptAtomic(
    original: object,
    request: { inputRequestId: string; prompt: string },
  ): object {
    jobHostRecord(request, ["inputRequestId", "prompt"]);
    const value = jobJson(request, 65536),
      target = this.original(this.targets, original);
    this.assertTarget(target);
    const proof = target.proof;
    if (
      value.inputRequestId !==
        `${this.profile.inputPrefix}:${proof.jobId}:${proof.jobSha256}` ||
      value.prompt !== this.profile.formatResult(proof.settled, proof)
    )
      fail("COMMAND_JOB_INPUT_INVALID");
    const input = normalizeAcceptInput({
      sessionId: proof.target.sessionId,
      requestId: value.inputRequestId,
      prompt: value.prompt,
      config: proof.target.config,
      delivery: "queue",
    });
    this.engine.store.publishAfterCommit(() => {
      void this.engine.scheduler.wake(input.sessionId).catch(() => {});
    });
    const receipt = this.engine.store.acceptInput(input),
      stored = this.engine.store.getInput(receipt.inputId);
    if (
      stored.workspaceId !== proof.workspaceId ||
      stored.admittedSeq !== receipt.admittedSeq ||
      knowledgeHash(acceptedRequest(stored)) !== knowledgeHash(input)
    )
      fail("COMMAND_JOB_INPUT_INVALID");
    return this.issue(
      this.accepted,
      signJobData({
        workspaceId: stored.workspaceId,
        sessionId: stored.sessionId,
        inputId: stored.id,
        requestId: stored.requestId,
        admittedSeq: stored.admittedSeq,
        inputSha256: knowledgeHash(input),
      }),
    );
  }
  readAccepted(original: object): JobAcceptedInputProof {
    const proof = this.original(this.accepted, original),
      input = this.engine.store.getInput(proof.inputId);
    this.binding(proof.workspaceId);
    if (
      input.workspaceId !== proof.workspaceId ||
      input.sessionId !== proof.sessionId ||
      input.requestId !== proof.requestId ||
      input.admittedSeq !== proof.admittedSeq ||
      knowledgeHash(acceptedRequest(input)) !== proof.inputSha256
    )
      fail("COMMAND_JOB_INPUT_INVALID");
    return structuredClone(proof);
  }
  beforePromotion(input: InputRecord): CommandDeliveryRecord<S> | null {
    const receipt = this.findDelivery(this.engine.store, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      inputId: input.id,
      requestId: input.requestId,
    });
    if (!receipt) return null;
    this.active();
    if (
      receipt.state !== "accepted" ||
      receipt.accepted.inputId !== input.id ||
      receipt.prompt !== input.prompt ||
      knowledgeHash(input.config) !== knowledgeHash(receipt.target.config)
    )
      fail("COMMAND_JOB_DELIVERY_PAUSED");
    // Native accepted history is sufficient after a normal restart; no source Original is recreated.
    const current = describeQueueTarget(
      this.engine,
      (id) => this.binding(id),
      input.workspaceId,
      input.sessionId,
      input.config,
      jobTargetChanged,
    ).pin;
    if (knowledgeHash(current) !== knowledgeHash(receipt.target))
      fail("JOB_TARGET_STALE");
    return receipt;
  }
  beforeProviderDispatch(run: Run): void {
    const input = this.engine.store.getInput(run.inputId),
      receipt = this.beforePromotion(input);
    if (!receipt) return;
    if (isPromotedCommandRunInvalid(input, run, receipt))
      fail("COMMAND_JOB_INPUT_INVALID");
  }
  inputPort(): ActualCommandInputPort<P> {
    return {
      captureTarget: (input) => this.captureTarget(input),
      readTarget: (original) => this.readTarget(original),
      assertTargetCurrent: (original, expected) =>
        this.assertTargetCurrent(original, expected),
      release: (original) => this.release(original),
    };
  }
  release(original: object): void {
    if (!this.retained.delete(original)) return;
    const target = this.targets.get(original);
    if (target) this.source.release(target.source);
    this.targets.delete(original);
    this.accepted.delete(original);
  }
  close(): void {
    if (this.closed) return;
    for (const original of [...this.retained]) this.release(original);
    this.closed = true;
  }
}
