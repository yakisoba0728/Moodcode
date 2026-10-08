import { types } from "node:util";
import {
  EngineError,
  type InputRecord,
  type Run,
} from "@moodcode/contracts";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import { jobHostRecord } from "./host.js";
import { jobJson, signJobData } from "./validation.js";
import type { JobAcceptedInputProof } from "./delivery.js";
import type { ActualOwnedCommandInputPort } from "./owned-command-delivery.js";
import {
  formatOwnedCommandJobResult,
  validateOwnedCommandDeliveryTargetProof,
  OWNED_COMMAND_RESULT_LIMITS,
  type OwnedCommandDeliveryTargetProof,
} from "./owned-command-result.js";
import type { OwnedCommandJobHost } from "./owned-command-host.js";
import type { OwnedCommandDeliveryRecord } from "./owned-command-delivery-records.js";
import { describeEngineQueueTarget } from "./queue-target.js";
import {
  acceptedRequest,
  isPromotedCommandRunInvalid,
} from "./command-delivery-input.js";

interface Target {
  readonly source: object;
  readonly binding: KnowledgeHostBinding;
  readonly proof: OwnedCommandDeliveryTargetProof;
}
function fail(code: string): never {
  throw new EngineError(
    code,
    "The original settled command delivery target or actual native input changed",
  );
}
/** Current command observations and actual queue acceptance share this Root-private producer. */
export class EngineOwnedCommandDeliveryProducer {
  private readonly targets = new WeakMap<object, Target>();
  private readonly accepted = new WeakMap<object, JobAcceptedInputProof>();
  private readonly retained = new Set<object>();
  private closed = false;
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly checkBinding: (
      workspaceId: string,
    ) => KnowledgeHostBinding,
    private readonly enabled: () => boolean,
    private readonly source: OwnedCommandJobHost,
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
    input: Parameters<ActualOwnedCommandInputPort["captureTarget"]>[0],
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
      const settled = this.source.readSettledSource(source);
      const normalized = normalizeAcceptInput({
        sessionId: settled.source.sessionId,
        requestId: "owned-command-target",
        prompt: "owned-command-target",
        config: data.config,
        delivery: "queue",
      });
      normalized.config = this.engine.profiles.apply(
        settled.source.sessionId,
        normalized.config,
      );
      const target = describeEngineQueueTarget(
        this.engine,
        (id) => this.binding(id),
        data.workspaceId,
        settled.source.sessionId,
        normalized.config,
      );
      const proof = validateOwnedCommandDeliveryTargetProof(
        signJobData(
          {
            version: 1 as const,
            workspaceId: data.workspaceId,
            jobId: data.jobId,
            jobSha256: settled.sha256,
            sourceSha256: settled.source.sha256,
            settled,
            target,
          },
          OWNED_COMMAND_RESULT_LIMITS.proofBytes,
        ),
      );
      return this.issue(this.targets, { source, binding, proof });
    } catch (error) {
      this.source.release(source);
      throw error;
    }
  }
  private assertTarget(target: Target): void {
    this.active();
    const proof = target.proof;
    if (
      knowledgeHash(this.binding(proof.workspaceId)) !==
      knowledgeHash(target.binding)
    )
      fail("COMMAND_JOB_TARGET_STALE");
    const settled = this.source.readSettledSource(target.source);
    if (
      settled.sha256 !== proof.jobSha256 ||
      knowledgeHash(settled) !== knowledgeHash(proof.settled)
    )
      fail("COMMAND_JOB_TARGET_STALE");
    formatOwnedCommandJobResult(settled, proof);
    const current = describeEngineQueueTarget(
      this.engine,
      (id) => this.binding(id),
      proof.workspaceId,
      proof.target.sessionId,
      proof.target.config,
    );
    if (knowledgeHash(current) !== knowledgeHash(proof.target))
      fail("JOB_TARGET_STALE");
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(proof.workspaceId);
  }
  readTarget(original: object): OwnedCommandDeliveryTargetProof {
    const target = this.original(this.targets, original);
    this.assertTarget(target);
    return structuredClone(target.proof);
  }
  assertTargetCurrent(
    original: object,
    expected: OwnedCommandDeliveryTargetProof,
  ): void {
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
        `owned-command-result:${proof.jobId}:${proof.jobSha256}` ||
      value.prompt !== formatOwnedCommandJobResult(proof.settled, proof)
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
  beforePromotion(input: InputRecord): OwnedCommandDeliveryRecord | null {
    const receipt = this.engine.store.findOwnedCommandDeliveryForInput({
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
    const current = describeEngineQueueTarget(
      this.engine,
      (id) => this.binding(id),
      input.workspaceId,
      input.sessionId,
      input.config,
    );
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
  inputPort(): ActualOwnedCommandInputPort {
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
