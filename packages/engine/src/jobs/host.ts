import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import type {
  JobOutputPage,
  JobOwnerProof,
  ReadJobOutputInput,
  TerminalClosedOutcomeProof,
  TerminalJobSourceProof,
} from "./types.js";
import type {
  AttachTerminalJobInput,
  CancelCommandJobWatchInput,
  CommandJob,
  JobRequestResult,
  RecordJobOutputInput,
  SettleTerminalJobInput,
} from "./store.js";
import {
  jobIdentifier,
  jobJson,
  validateJobOutputPage,
  validateTerminalJobSourceProof,
} from "./validation.js";

/** Only the actual Root/TerminalService can issue these observation capabilities. */
export interface ActualTerminalJobPort {
  captureSource(input: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly terminalId: string;
  }): object;
  readSource(original: object): TerminalJobSourceProof;
  readOwner(original: object): JobOwnerProof;
  assertSourceCurrent(
    original: object,
    expected: TerminalJobSourceProof,
    phase: "attach" | "observe",
  ): void;
  captureOutput(originalSource: object, input: ReadJobOutputInput): object;
  readOutput(originalPage: object): JobOutputPage;
  captureClosedOutcome(originalSource: object): object;
  readClosedOutcome(originalOutcome: object): TerminalClosedOutcomeProof;
  release(original: object): void;
}

export interface JobHostNativePort {
  attachTerminalJob(
    original: object,
    input: AttachTerminalJobInput,
  ): JobRequestResult<CommandJob>;
  recordJobOutput(
    original: object,
    input: RecordJobOutputInput,
  ): JobRequestResult<CommandJob>;
  settleTerminalJob(
    original: object,
    input: SettleTerminalJobInput,
  ): JobRequestResult<CommandJob>;
  cancelWatch(input: CancelCommandJobWatchInput): JobRequestResult<CommandJob>;
}

/** Watches retain observation sources. Closing a watch never controls its user PTY. */
export class JobHost {
  private readonly handles = new Set<object>();
  private readonly sources = new WeakMap<object, TerminalJobSourceProof>();
  private readonly pages = new WeakSet<object>();
  private readonly signal: AbortSignal;
  private closed = false;
  constructor(
    readonly ports: {
      readonly native: JobHostNativePort;
      readonly source: ActualTerminalJobPort;
      readonly lifetime?: AbortSignal;
    },
  ) {
    this.signal = ports.lifetime ?? new AbortController().signal;
  }
  private open(): void {
    if (this.closed)
      throw new EngineError("JOB_CLOSED", "The job observation host is closed");
    jobHostAbort(this.signal);
  }
  private retain(original: object): void {
    if (this.handles.size >= 128) {
      this.ports.source.release(original);
      throw new EngineError(
        "JOB_HANDLE_LIMIT",
        "The job observation handle limit was reached",
      );
    }
    this.handles.add(original);
  }
  private source(
    original: object,
    phase: "attach" | "observe",
  ): TerminalJobSourceProof {
    const captured = this.sources.get(original);
    if (!captured || !this.handles.has(original))
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        "The job source must be its original retained handle",
      );
    this.ports.source.assertSourceCurrent(original, captured, phase);
    return this.ports.source.readSource(original);
  }
  captureTerminalJob(input: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly terminalId: string;
  }): object {
    this.open();
    jobHostRecord(input, ["workspaceId", "sessionId", "terminalId"]);
    for (const value of [input.workspaceId, input.sessionId, input.terminalId])
      jobIdentifier(value);
    const original = this.ports.source.captureSource(input);
    try {
      const proof = validateTerminalJobSourceProof(
        this.ports.source.readSource(original),
      );
      if (
        proof.workspaceId !== input.workspaceId ||
        proof.sessionId !== input.sessionId ||
        proof.terminalId !== input.terminalId
      )
        throw new EngineError(
          "JOB_SOURCE_STALE",
          "The original source differs from its selected user terminal",
        );
      this.retain(original);
      this.sources.set(original, proof);
      return original;
    } catch (error) {
      this.ports.source.release(original);
      throw error;
    }
  }
  readTerminalJobSource(original: object): TerminalJobSourceProof {
    this.open();
    return structuredClone(this.source(original, "observe"));
  }
  attachTerminalJob(
    original: object,
    input: AttachTerminalJobInput,
  ): JobRequestResult<CommandJob> {
    this.open();
    this.source(original, "attach");
    return structuredClone(
      this.ports.native.attachTerminalJob(original, input),
    );
  }
  captureJobOutput(originalSource: object, input: ReadJobOutputInput): object {
    this.open();
    this.source(originalSource, "observe");
    jobHostRecord(
      input,
      ["jobId", "jobRevisionId"],
      ["cursor", "maxBytes", "maxFragments"],
    );
    jobIdentifier(input.jobId);
    jobIdentifier(input.jobRevisionId);
    const original = this.ports.source.captureOutput(
      originalSource,
      jobJson(input),
    );
    try {
      validateJobOutputPage(this.ports.source.readOutput(original));
      this.retain(original);
      this.pages.add(original);
      return original;
    } catch (error) {
      this.ports.source.release(original);
      throw error;
    }
  }
  readOutput(original: object): JobOutputPage {
    this.open();
    if (!this.pages.has(original) || !this.handles.has(original))
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        "The output page must be its original retained handle",
      );
    return structuredClone(this.ports.source.readOutput(original));
  }
  recordJobOutput(
    original: object,
    input: RecordJobOutputInput,
  ): JobRequestResult<CommandJob> {
    this.open();
    this.readOutput(original);
    return structuredClone(this.ports.native.recordJobOutput(original, input));
  }
  settleTerminalJob(
    originalSource: object,
    input: SettleTerminalJobInput,
  ): JobRequestResult<CommandJob> {
    this.open();
    this.source(originalSource, "observe");
    const original = this.ports.source.captureClosedOutcome(originalSource);
    try {
      return structuredClone(
        this.ports.native.settleTerminalJob(original, input),
      );
    } finally {
      this.ports.source.release(original);
    }
  }
  cancelCommandJobWatch(
    input: CancelCommandJobWatchInput,
  ): JobRequestResult<CommandJob> {
    this.open();
    return structuredClone(this.ports.native.cancelWatch(input));
  }
  release(original: object): void {
    if (!this.handles.delete(original)) return;
    this.sources.delete(original);
    this.pages.delete(original);
    this.ports.source.release(original);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const original of this.handles) this.release(original);
  }
}

/** Validate envelopes without invoking caller getters or copying original handles. */
export function jobHostRecord(
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
    throw new EngineError("INVALID_JOB_INPUT", "Job input must be plain data");
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
    throw new EngineError(
      "INVALID_JOB_INPUT",
      "Job input fields must remain explicit plain data",
    );
  return value as Record<string, unknown>;
}

export function jobHostAbort(signal?: AbortSignal): void {
  if (signal === undefined) return;
  if (
    !signal ||
    types.isProxy(signal) ||
    !(signal instanceof AbortSignal) ||
    [
      "aborted",
      "reason",
      "throwIfAborted",
      "addEventListener",
      "removeEventListener",
    ].some((key) => Object.hasOwn(signal, key))
  )
    throw new EngineError("INVALID_JOB_INPUT", "Job signal must be original");
  const aborted = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  )!.get!.call(signal) as boolean;
  if (aborted)
    throw new EngineError("CANCELLED", "Job observation was cancelled");
}
