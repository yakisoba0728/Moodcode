import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import {
  hostCommandSettlement,
  type HostCommandSettlementPin,
} from "./host-command-result.js";
/** Retained actual HostCommandService output handle and sealed artifacts authenticate independent settled source. */
export class EngineHostCommandDeliverySource {
  private readonly originals = new Map<
    object,
    { handle: object; pin: HostCommandSettlementPin }
  >();
  constructor(private readonly engine: MoodcodeEngine) {}
  captureSettledSource(input: { workspaceId: string; jobId: string }): object {
    const record = this.engine.getHostCommand(input.workspaceId, input.jobId);
    if (!record)
      throw new EngineError(
        "HOST_COMMAND_DELIVERY_SOURCE_INVALID",
        "Unknown independent command",
      );
    const pin = hostCommandSettlement(record),
      handle = this.engine.captureHostCommandOutput(input);
    try {
      this.engine.readHostCommandOutput(handle);
      this.engine.readHostCommandArtifacts(input);
      const original = Object.freeze({});
      if (this.originals.size >= 128)
        throw new EngineError(
          "JOB_HANDLE_LIMIT",
          "Host inbox source capacity reached",
        );
      this.originals.set(original, { handle, pin });
      return original;
    } catch (e) {
      this.engine.releaseHostCommandHandle(handle);
      throw e;
    }
  }
  readSettledSource(original: object): HostCommandSettlementPin {
    if (types.isProxy(original))
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        "Original host source required",
      );
    const s = this.originals.get(original);
    if (!s)
      throw new EngineError(
        "JOB_ORIGINAL_REQUIRED",
        "Original host source required",
      );
    const job = this.engine.getHostCommand(s.pin.workspaceId, s.pin.jobId);
    if (!job || job.sha256 !== s.pin.jobSha256)
      throw new EngineError(
        "HOST_COMMAND_DELIVERY_STALE",
        "Settled native host source changed",
      );
    this.engine.readHostCommandOutput(s.handle);
    this.engine.readHostCommandArtifacts({
      workspaceId: s.pin.workspaceId,
      jobId: s.pin.jobId,
    });
    return structuredClone(s.pin);
  }
  release(original: object) {
    const s = this.originals.get(original);
    if (!s) return;
    this.originals.delete(original);
    this.engine.releaseHostCommandHandle(s.handle);
  }
  close() {
    for (const o of this.originals.keys()) this.release(o);
  }
}
