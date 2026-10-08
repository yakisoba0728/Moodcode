import { EngineError, type RunConfigInput } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { jobHostAbort, jobHostRecord } from "./host.js";
import { jobIdentifier, jobJson } from "./validation.js";
import {
  formatOwnedCommandJobResult,
  validateOwnedCommandDeliveryTargetProof,
  type OwnedCommandDeliveryTargetProof,
} from "./owned-command-result.js";
import type {
  OwnedCommandDeliveryInput,
  OwnedCommandDeliveryResult,
} from "./owned-command-delivery-records.js";

export interface ActualOwnedCommandInputPort {
  captureTarget(input: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly config: RunConfigInput;
  }): object;
  readTarget(original: object): OwnedCommandDeliveryTargetProof;
  assertTargetCurrent(
    original: object,
    expected: OwnedCommandDeliveryTargetProof,
  ): void;
  release(original: object): void;
}
export interface OwnedCommandDeliveryNativePort {
  /** Genuine Root input acceptance and its native receipt share a single primary transaction. */
  deliver(
    originalTarget: object,
    input: OwnedCommandDeliveryInput,
  ): OwnedCommandDeliveryResult;
}
export interface DeliverOwnedCommandJobResultInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly expectedRevision: 0;
  readonly target: object;
  readonly approved: boolean;
  readonly signal?: AbortSignal;
}
interface Request {
  readonly original: object;
  readonly sha256: string;
  result?: OwnedCommandDeliveryResult;
  error?: unknown;
}

/** Explicit Root delivery consumes a completed observation; the source Run keeps its execution history. */
export class OwnedCommandDelivery {
  private readonly targets = new Map<object, OwnedCommandDeliveryTargetProof>();
  private readonly requests = new Map<string, Request>();
  private readonly signal: AbortSignal;
  private closed = false;
  constructor(
    readonly ports: {
      readonly native: OwnedCommandDeliveryNativePort;
      readonly input: ActualOwnedCommandInputPort;
      readonly lifetime?: AbortSignal;
    },
  ) {
    this.signal = ports.lifetime ?? new AbortController().signal;
  }
  private open(): void {
    if (this.closed)
      throw new EngineError(
        "JOB_CLOSED",
        "Owned command result delivery is closed",
      );
    jobHostAbort(this.signal);
  }
  captureTarget(
    input: Parameters<ActualOwnedCommandInputPort["captureTarget"]>[0],
  ): object {
    this.open();
    jobHostRecord(input, ["workspaceId", "jobId", "config"]);
    jobIdentifier(input.workspaceId);
    jobIdentifier(input.jobId);
    if (this.targets.size >= 128)
      throw new EngineError(
        "JOB_HANDLE_LIMIT",
        "Owned command delivery target limit was reached",
      );
    const original = this.ports.input.captureTarget(jobJson(input, 65_536));
    try {
      const proof = validateOwnedCommandDeliveryTargetProof(
        this.ports.input.readTarget(original),
      );
      if (
        proof.workspaceId !== input.workspaceId ||
        proof.jobId !== input.jobId
      )
        throw new EngineError(
          "COMMAND_JOB_TARGET_STALE",
          "Owned command capture selected another completed job",
        );
      this.ports.input.assertTargetCurrent(original, proof);
      this.targets.set(original, structuredClone(proof));
      return original;
    } catch (failure) {
      this.ports.input.release(original);
      throw failure;
    }
  }
  readTarget(original: object): OwnedCommandDeliveryTargetProof {
    this.open();
    const expected = this.targets.get(original);
    if (!expected)
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        "Owned command delivery requires its retained original target",
      );
    this.ports.input.assertTargetCurrent(original, expected);
    const actual = validateOwnedCommandDeliveryTargetProof(
      this.ports.input.readTarget(original),
    );
    if (knowledgeHash(actual) !== knowledgeHash(expected))
      throw new EngineError(
        "COMMAND_JOB_TARGET_STALE",
        "Owned command delivery target changed",
      );
    return structuredClone(actual);
  }
  deliver(
    input: DeliverOwnedCommandJobResultInput,
  ): OwnedCommandDeliveryResult {
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
        "Owned command delivery starts at revision zero",
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
        "Owned command delivery requires its retained original target",
      );
    const nativeInput: OwnedCommandDeliveryInput = {
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
          "Owned command delivery request changed",
        );
      if (prior.result)
        return structuredClone({ ...prior.result, kind: "duplicate" });
      throw (
        prior.error ??
        new EngineError(
          "JOB_DELIVERY_UNCERTAIN",
          "Owned command delivery cannot be replayed",
        )
      );
    }
    if (this.requests.size >= 128)
      throw new EngineError(
        "JOB_HANDLE_LIMIT",
        "Owned command delivery request limit was reached",
      );
    const proof = this.readTarget(input.target);
    formatOwnedCommandJobResult(proof.settled, proof);
    const request: Request = { original: input.target, sha256 };
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
