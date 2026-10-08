import { StringDecoder } from "node:string_decoder";
import { isAbsolute } from "node:path";
import { types } from "node:util";
import { EngineError, type Checkpoint } from "@moodcode/contracts";
import type { PreparedTool, ToolContext } from "../../ports.js";
import { immutableKnowledgeJson } from "../../knowledge/validation.js";
import type { ProcessOutcome } from "./process-control.js";

export type CommandOutputStream = "stdout" | "stderr";
/** Observed file DATA. Only the original command producer may attest its authority. */
export interface CommandArtifactDescriptor {
  readonly version: 1;
  readonly path: string;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly observedBytes: number;
  readonly artifactBytes: number;
  readonly truncated: boolean;
}
export interface CommandExecutionCompletion {
  readonly outcome: ProcessOutcome;
  readonly stdout: CommandArtifactDescriptor;
  readonly stderr: CommandArtifactDescriptor;
  /** This is the exact object already passed to the original recordCheckpoint callback. */
  readonly checkpoint: Checkpoint;
  readonly observationFailure?: string;
}
/** Synchronous Root-only callbacks; a caller-supplied context or DTO grants no authority. */
export interface CommandProcessControl {
  readonly supervisorPid: number;
  readonly groupPid: number;
  readonly epoch: string;
  write(data: string): Promise<void>;
  end(): Promise<void>;
  alive(): boolean;
}
export interface CommandExecutionObserver {
  beforeSpawn(context: ToolContext, prepared: PreparedTool): object;
  started(original: object, groupPid: number): void;
  control?(original: object, control: CommandProcessControl): void;
  output(original: object, stream: CommandOutputStream, bytes: Buffer): void;
  closed(original: object, completion: CommandExecutionCompletion): void;
  failed?(original: object, error: unknown): void;
}
export interface CommandOutputEvent {
  readonly seq: number;
  readonly stream: CommandOutputStream;
  readonly data: string;
  readonly bytes: number;
}
export interface CommandOutputRingSnapshot {
  readonly outputSeq: number;
  readonly oldestSeq: number;
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly output: readonly CommandOutputEvent[];
}
export const COMMAND_OBSERVATION_LIMITS = Object.freeze({
  outputHookBytes: 16_384,
  preAdmissionBytes: 65_536,
  eventBytes: 16_384,
  ringBytes: 262_144,
  artifactBytes: 1_048_576,
});
const fail = (): never => {
  throw new EngineError(
    "COMMAND_OBSERVATION_INVALID",
    "Command observation data exceeds its exact bounds",
  );
};
/** Strict DATA validation never opens or trusts a supplied artifact path. */
export function validateCommandArtifactDescriptor(
  value: unknown,
): CommandArtifactDescriptor {
  const p = immutableKnowledgeJson(value) as unknown as Record<string, unknown>;
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).sort().join(",") !==
      "artifactBytes,device,inode,mtimeNs,observedBytes,path,sha256,size,truncated,version"
  )
    fail();
  if (
    p.version !== 1 ||
    typeof p.path !== "string" ||
    !isAbsolute(p.path) ||
    p.path.includes("\0") ||
    Buffer.byteLength(p.path) > 8192 ||
    typeof p.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.sha256)
  )
    fail();
  for (const key of ["device", "inode", "mtimeNs"])
    if (typeof p[key] !== "string" || !/^\d{1,32}$/.test(p[key] as string))
      fail();
  for (const key of ["size", "observedBytes", "artifactBytes"])
    if (!Number.isSafeInteger(p[key]) || (p[key] as number) < 0) fail();
  if (
    (p.size as number) !== p.artifactBytes ||
    (p.artifactBytes as number) > COMMAND_OBSERVATION_LIMITS.artifactBytes ||
    (p.observedBytes as number) < (p.artifactBytes as number) ||
    typeof p.truncated !== "boolean" ||
    p.truncated !== (p.observedBytes as number) > (p.artifactBytes as number)
  )
    fail();
  return p as unknown as CommandArtifactDescriptor;
}

/** Bounded observation text with one decoder per actual output stream. No execution capability. */
export class CommandOutputRing {
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private readonly ended = new Set<CommandOutputStream>();
  private readonly events: CommandOutputEvent[] = [];
  private seq = 0;
  private observed = 0;
  private retained = 0;
  private append(
    stream: CommandOutputStream,
    text: string,
  ): readonly CommandOutputEvent[] {
    const emitted: CommandOutputEvent[] = [];
    let data = "",
      bytes = 0;
    const emit = () => {
      if (!data) return;
      const event = Object.freeze({ seq: ++this.seq, stream, data, bytes });
      this.events.push(event);
      this.retained += bytes;
      emitted.push(event);
      while (this.retained > COMMAND_OBSERVATION_LIMITS.ringBytes)
        this.retained -= this.events.shift()!.bytes;
      data = "";
      bytes = 0;
    };
    for (const character of text) {
      const length = Buffer.byteLength(character);
      if (bytes + length > COMMAND_OBSERVATION_LIMITS.eventBytes) emit();
      data += character;
      bytes += length;
    }
    emit();
    return Object.freeze(emitted);
  }
  push(
    stream: CommandOutputStream,
    data: Buffer,
  ): readonly CommandOutputEvent[] {
    if (
      typeof stream !== "string" ||
      !Object.hasOwn(this.decoders, stream) ||
      this.ended.has(stream) ||
      types.isProxy(data) ||
      !Buffer.isBuffer(data) ||
      data.byteLength > COMMAND_OBSERVATION_LIMITS.outputHookBytes ||
      this.observed > Number.MAX_SAFE_INTEGER - data.byteLength
    )
      fail();
    this.observed += data.byteLength;
    return this.append(stream, this.decoders[stream].write(data));
  }
  end(stream: CommandOutputStream): readonly CommandOutputEvent[] {
    if (
      typeof stream !== "string" ||
      !Object.hasOwn(this.decoders, stream) ||
      this.ended.has(stream)
    )
      fail();
    this.ended.add(stream);
    return this.append(stream, this.decoders[stream].end());
  }
  snapshot(): CommandOutputRingSnapshot {
    return Object.freeze({
      outputSeq: this.seq,
      oldestSeq: this.events[0]?.seq ?? this.seq + 1,
      observedBytes: this.observed,
      retainedBytes: this.retained,
      output: Object.freeze([...this.events]),
    });
  }
}
