import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { formatScheduleInput } from "./occurrences.js";
import {
  scheduleIdentifier,
  scheduleInteger,
  scheduleJson,
  scheduleSha,
  validateScheduleTarget,
} from "./spec.js";
import type { ScheduleClaimImage, ScheduleTargetProof } from "./store.js";

/** Every returned object is issued by the actual root InputScheduler/storage producer. */
export interface ActualScheduleInputPort {
  capture(
    originalClaim: object,
    request: { readonly inputRequestId: string; readonly prompt: string },
  ): object;
  readTarget(originalTarget: object): ScheduleTargetProof;
  assertCurrent(originalTarget: object): void;
  /** Synchronous durable queue acceptance. Configuration is privately pinned by capture. */
  accept(originalTarget: object): object;
  captureObservation(originalObservation: object): object;
  /** One bounded native observation; never starts, resumes or cancels a Run. */
  observe(originalTarget: object): object;
  release(original: object): void;
}

export interface ScheduleHostNativePort {
  readClaim(originalClaim: object): ScheduleClaimImage;
  readObservation(originalObservation: object): ScheduleClaimImage;
  assertClaimCurrent(
    originalClaim: object,
    phase: "dispatch" | "observe",
  ): void;
}

export function scheduleHostError(code: string): never {
  throw new EngineError(
    code,
    "Scheduled admission requires its original root owner, immutable occurrence and current execution pins",
  );
}

/** Shallow validation preserves original capability and AbortSignal identities without invoking accessors. */
export function scheduleHostRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    scheduleHostError("INVALID_SCHEDULE_INPUT");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    required.some((key) => !Object.hasOwn(fields, key)) ||
    Reflect.ownKeys(fields).some(
      (key) =>
        typeof key !== "string" ||
        ![...required, ...optional].includes(key) ||
        !fields[key]!.enumerable ||
        !Object.hasOwn(fields[key]!, "value"),
    )
  )
    scheduleHostError("INVALID_SCHEDULE_INPUT");
  return value as Record<string, unknown>;
}

export function scheduleHostAbort(signal?: AbortSignal): void {
  if (signal === undefined) return;
  if (
    !signal ||
    typeof signal !== "object" ||
    types.isProxy(signal) ||
    !(signal instanceof AbortSignal)
  )
    scheduleHostError("INVALID_SCHEDULE_INPUT");
  const fields = Object.getOwnPropertyDescriptors(signal);
  if (
    [
      "aborted",
      "reason",
      "throwIfAborted",
      "addEventListener",
      "removeEventListener",
    ].some((key) => Object.hasOwn(fields, key))
  )
    scheduleHostError("INVALID_SCHEDULE_INPUT");
  let aborted: boolean;
  try {
    aborted = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted",
    )!.get!.call(signal);
  } catch {
    return scheduleHostError("INVALID_SCHEDULE_INPUT");
  }
  if (aborted)
    throw new EngineError("CANCELLED", "Scheduled request was cancelled");
}

interface HostBinding {
  readonly authority: "dispatch" | "observe";
  readonly originalNative: object;
  readonly originalTarget: object;
  readonly image: ScheduleClaimImage;
  readonly prompt: string;
}

/** The host retains original producer handles. Serialized images only describe their fixed scope. */
export class ScheduleHost {
  private readonly originals = new WeakMap<object, HostBinding>();
  private readonly retained = new Set<object>();
  private closed = false;
  constructor(
    readonly ports: {
      native: ScheduleHostNativePort;
      input: ActualScheduleInputPort;
    },
  ) {}
  private open(): void {
    if (this.closed) scheduleHostError("SCHEDULE_CLOSED");
  }
  private original(value: object): HostBinding {
    this.open();
    if (!value || typeof value !== "object" || types.isProxy(value))
      scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    const binding = this.originals.get(value);
    if (!binding) scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    return binding;
  }
  private image(original: object, authority: "dispatch" | "observe") {
    this.open();
    if (!original || typeof original !== "object" || types.isProxy(original))
      scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    this.ports.native.assertClaimCurrent(original, authority);
    const image = scheduleJson(
      authority === "dispatch"
        ? this.ports.native.readClaim(original)
        : this.ports.native.readObservation(original),
      65536,
    );
    if (image.authority !== authority)
      scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    for (const id of [
      image.workspaceId,
      image.scheduleId,
      image.occurrenceId,
      image.scheduleRevisionId,
      image.inputRequestId,
    ])
      scheduleIdentifier(id);
    scheduleInteger(image.occurrenceRevision, Number.MAX_SAFE_INTEGER, 1);
    for (const digest of [
      image.scheduleSha256,
      image.occurrenceSha256,
      image.sha256,
    ])
      scheduleSha(digest);
    if (image.leaseSha256 !== null) scheduleSha(image.leaseSha256);
    const { sha256, ...body } = image;
    if (
      knowledgeHash(body) !== sha256 ||
      image.target.workspaceId !== image.workspaceId ||
      image.candidate.occurrenceId !== image.occurrenceId ||
      image.candidate.inputRequestId !== image.inputRequestId ||
      image.candidate.scheduleId !== image.scheduleId ||
      image.candidate.scheduleSha256 !== image.scheduleSha256 ||
      knowledgeHash(image.data) !== knowledgeHash(image.candidate.data)
    )
      scheduleHostError("SCHEDULE_CLAIM_STALE");
    validateScheduleTarget(image.target);
    return image;
  }
  private assertTarget(image: ScheduleClaimImage, original: object): void {
    const actual = scheduleJson(this.ports.input.readTarget(original));
    const expected = {
      workspaceId: image.workspaceId,
      sessionId: image.target.sessionId,
      sourceSha256: image.target.workspaceBindingSha256,
      config: image.target.config,
      configSha256: image.target.runConfigSha256,
      capabilitiesSha256: image.target.capabilitiesSha256,
      catalogueSha256: image.target.catalogueSha256,
      profile: image.target.profile,
    };
    const { sha256, ...body } = actual;
    if (
      scheduleSha(sha256) !== knowledgeHash(body) ||
      knowledgeHash(body) !== knowledgeHash(expected)
    )
      scheduleHostError("SCHEDULE_TARGET_STALE");
  }
  private retain(binding: HostBinding): object {
    if (this.retained.size >= 32) scheduleHostError("SCHEDULE_HANDLE_LIMIT");
    const original = Object.freeze({});
    this.originals.set(original, binding);
    this.retained.add(original);
    return original;
  }
  bindDispatch(originalClaim: object, signal?: AbortSignal): object {
    scheduleHostAbort(signal);
    const image = this.image(originalClaim, "dispatch");
    const prompt = formatScheduleInput(
      {
        id: image.scheduleId,
        sha256: image.scheduleSha256,
        prompt: image.prompt,
      },
      image.candidate,
    );
    const originalTarget = this.ports.input.capture(originalClaim, {
      inputRequestId: image.inputRequestId,
      prompt,
    });
    try {
      this.assertTarget(image, originalTarget);
      this.ports.input.assertCurrent(originalTarget);
      this.ports.native.assertClaimCurrent(originalClaim, "dispatch");
      scheduleHostAbort(signal);
      return this.retain({
        authority: "dispatch",
        originalNative: originalClaim,
        originalTarget,
        image,
        prompt,
      });
    } catch (error) {
      this.ports.input.release(originalTarget);
      throw error;
    }
  }
  bindObservation(originalObservation: object, signal?: AbortSignal): object {
    scheduleHostAbort(signal);
    const image = this.image(originalObservation, "observe");
    const originalTarget =
      this.ports.input.captureObservation(originalObservation);
    try {
      this.assertTarget(image, originalTarget);
      this.ports.native.assertClaimCurrent(originalObservation, "observe");
      scheduleHostAbort(signal);
      return this.retain({
        authority: "observe",
        originalNative: originalObservation,
        originalTarget,
        image,
        prompt: image.prompt,
      });
    } catch (error) {
      this.ports.input.release(originalTarget);
      throw error;
    }
  }
  read(original: object): { image: ScheduleClaimImage; prompt: string } {
    const binding = this.original(original);
    return {
      image: scheduleJson(binding.image, 65536),
      prompt: binding.prompt,
    };
  }
  assertDispatch(original: object, signal?: AbortSignal): void {
    const binding = this.original(original);
    if (binding.authority !== "dispatch")
      scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    scheduleHostAbort(signal);
    this.ports.native.assertClaimCurrent(binding.originalNative, "dispatch");
    this.ports.input.assertCurrent(binding.originalTarget);
  }
  accept(original: object, signal?: AbortSignal): object {
    this.assertDispatch(original, signal);
    const binding = this.original(original);
    return this.ports.input.accept(binding.originalTarget);
  }
  observe(original: object, signal?: AbortSignal): object {
    const binding = this.original(original);
    if (binding.authority !== "observe")
      scheduleHostError("SCHEDULE_ORIGINAL_REQUIRED");
    scheduleHostAbort(signal);
    this.ports.native.assertClaimCurrent(binding.originalNative, "observe");
    return this.ports.input.observe(binding.originalTarget);
  }
  releaseProduced(original: object): void {
    this.ports.input.release(original);
  }
  release(original: object): void {
    const binding = this.originals.get(original);
    if (!binding) return;
    this.originals.delete(original);
    this.retained.delete(original);
    this.ports.input.release(binding.originalTarget);
  }
  close(): void {
    for (const original of this.retained) this.release(original);
    this.closed = true;
  }
}
