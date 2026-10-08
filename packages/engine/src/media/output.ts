import {
  EngineError,
  type ProviderArtifactIdentity,
  type ArtifactReference,
  type EngineBudgets,
} from "@moodcode/contracts";
import type { ProviderEvent } from "../ports.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { encodePcmWave, segmentHash } from "./segments.js";
import { types } from "node:util";

/** Owned by one actual provider Attempt, retaining bounded copied PCM only. */
export class ProviderAudioCapture {
  #parts: Buffer[] = [];
  #bytes = 0;
  #id?: string;
  #sampleRate?: number;
  #channels?: number;
  #ended = false;
  #stored = false;
  constructor(
    private readonly identity: ProviderArtifactIdentity,
    private readonly requested: boolean,
  ) {}
  get bytes() {
    return this.#bytes;
  }
  get mime() {
    return this.#bytes % (this.#channels! * 2) === 0
      ? "audio/wav"
      : "application/octet-stream";
  }
  append(
    event: Extract<ProviderEvent, { type: "media.delta" }>,
    available: number,
  ): number {
    if (!this.requested || types.isProxy(event) || this.#ended)
      throw new EngineError(
        "PROVIDER_UNSUPPORTED_OUTPUT",
        "Output media has no original requested capability",
      );
    const descriptors = Object.getOwnPropertyDescriptors(event);
    if (
      Object.keys(descriptors).sort().join(",") !==
        "bytes,channels,providerMediaId,sampleRate,type" ||
      Object.values(descriptors).some((d) => !("value" in d) || !d.enumerable)
    )
      throw new EngineError(
        "PROVIDER_PROTOCOL_ERROR",
        "Media output must be ordinary data",
      );
    const { providerMediaId, sampleRate, channels, bytes } = event;
    if (
      typeof providerMediaId !== "string" ||
      !providerMediaId ||
      Buffer.byteLength(providerMediaId) > 256 ||
      /[\u0000-\u001f\u007f]/.test(providerMediaId) ||
      ![8000, 16000, 24000, 48000].includes(sampleRate) ||
      ![1, 2].includes(channels) ||
      types.isProxy(bytes) ||
      !(bytes instanceof Uint8Array) ||
      !bytes.byteLength ||
      (this.#id &&
        (this.#id !== providerMediaId ||
          this.#sampleRate !== sampleRate ||
          this.#channels !== channels))
    )
      throw new EngineError(
        "PROVIDER_PROTOCOL_ERROR",
        "Audio stream identity or layout changed",
      );
    if (
      this.#parts.length >= 256 ||
      bytes.byteLength > available ||
      this.#bytes + bytes.byteLength >
        Math.min(524244, sampleRate * channels * 2 * 30)
    )
      throw new EngineError(
        "OUTPUT_LIMIT",
        "Media output exceeds the actual Run byte budget",
      );
    this.#id = providerMediaId;
    this.#sampleRate = sampleRate;
    this.#channels = channels;
    this.#parts.push(Buffer.from(bytes));
    this.#bytes += bytes.byteLength;
    return bytes.byteLength;
  }
  end(event: Extract<ProviderEvent, { type: "media.end" }>): void {
    if (types.isProxy(event))
      throw new EngineError(
        "PROVIDER_PROTOCOL_ERROR",
        "Media end must be ordinary data",
      );
    const d = Object.getOwnPropertyDescriptors(event);
    if (
      Object.keys(d).sort().join(",") !== "providerMediaId,type" ||
      Object.values(d).some((v) => !("value" in v) || !v.enumerable) ||
      !this.#id ||
      this.#ended ||
      event.providerMediaId !== this.#id ||
      this.#bytes % (this.#channels! * 2)
    )
      throw new EngineError(
        "PROVIDER_PROTOCOL_ERROR",
        "Media end does not match the actual captured stream",
      );
    this.#ended = true;
  }
  async store(
    artifacts: ArtifactStore,
    success: boolean,
    budgets: Pick<EngineBudgets, "maxArtifactBytes" | "maxProducerBytes">,
  ): Promise<ArtifactReference | null> {
    if (!this.#bytes || this.#stored) return null;
    if (success && !this.#ended)
      throw new EngineError(
        "PROVIDER_INCOMPLETE_STREAM",
        "Media output never reached a validated end",
      );
    // A partial trailing sample is retained honestly as raw bytes; it cannot be called a WAV.
    const pcm = Buffer.concat(this.#parts, this.#bytes),
      valid = pcm.length % (this.#channels! * 2) === 0;
    const content = valid
      ? encodePcmWave(pcm, this.#sampleRate, this.#channels)
      : pcm;
    if (
      budgets.maxArtifactBytes < content.length ||
      budgets.maxProducerBytes < content.length ||
      artifacts.limits.maxArtifactBytes < content.length ||
      artifacts.limits.maxProducerBytes < content.length
    )
      throw new EngineError(
        "ARTIFACT_LIMIT",
        "Media requires complete bounded artifact storage",
      );
    const stored = await artifacts.put({
      identity: this.identity,
      content,
      mediaType: valid ? "audio/wav" : "application/octet-stream",
      sourceComplete: success,
      outcome: success ? "completed" : "interrupted",
      metadata: {
        source: "provider-audio-v1",
        providerMediaId: this.#id!,
        sampleRate: this.#sampleRate!,
        channels: this.#channels!,
        pcmBytes: pcm.length,
        pcmSha256: segmentHash(pcm),
        complete: success,
      },
    });
    if (
      stored.reference.storedBytes !== content.length ||
      (stored.reference.producerTruncatedBytes !== 0 && success)
    )
      throw new EngineError(
        "CLEANUP_UNCERTAIN",
        "Published media is not a complete captured artifact",
      );
    this.#stored = true;
    this.#parts = [];
    return stored.reference;
  }
}
