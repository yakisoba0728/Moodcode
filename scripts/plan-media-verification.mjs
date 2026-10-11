import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  fstatSync,
  lstatSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Planning only: fixed repository source reads, no provider imports or account lookup.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sources = [
  "packages/contracts/src/index.ts",
  "packages/contracts/src/v2.ts",
  "packages/contracts/src/validation.ts",
  "packages/engine/src/media/validation.ts",
  "packages/engine/src/media/provider.ts",
  "packages/engine/src/media/segments.ts",
  "packages/engine/src/media/segment-validation.ts",
  "packages/engine/src/media/segment-provider.ts",
  "packages/engine/src/media/segment-store.ts",
  "packages/engine/src/storage/session-blob-store.ts",
  "packages/engine/src/media/output.ts",
  "packages/engine/src/media/native-validation.ts",
  "packages/engine/src/media/storage-capacity.ts",
  "packages/engine/src/documents/validation.ts",
  "packages/engine/src/documents/provider.ts",
  "packages/engine/src/provider/codex.ts",
  "packages/engine/src/provider/responses.ts",
  "packages/engine/src/provider/anthropic.ts",
  "packages/engine/src/provider/openai-compatible.ts",
  "packages/engine/src/context/model-spec.ts",
  "packages/engine/src/context/plan.ts",
  "packages/engine/src/runner/turn-executor.ts",
  "packages/engine/src/artifacts/store.ts",
  "packages/engine/src/engine.ts",
];
const providers = [
  "codex",
  "openai-responses",
  "anthropic",
  "openai-compatible",
];
/** @type {Record<string, string>} */
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  if (
    !["--provider", "--model"].includes(key) ||
    value === undefined ||
    Object.hasOwn(options, key)
  )
    throw new Error(
      "Use optional --provider <codex|openai-responses|anthropic|openai-compatible> --model <exact-model-id>.",
    );
  if (
    Buffer.byteLength(value) > 256 ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error("Invalid bounded identifier.");
  options[key] = value;
}
if (options["--provider"] && !providers.includes(options["--provider"]))
  throw new Error("Unknown provider.");
if (options["--model"] && !options["--provider"])
  throw new Error("A model must have an exact provider.");
let sourceBytes = 0;
const sourcePins = Object.fromEntries(
  sources.map((path) => {
    const physical = lstatSync(join(root, path), { bigint: true });
    if (
      !physical.isFile() ||
      physical.size > 1048576n ||
      physical.size < 1n ||
      sourceBytes + Number(physical.size) > 4194304
    )
      throw new Error("Repository source pin byte bound exceeded.");
    const fd = openSync(
      join(root, path),
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = fstatSync(fd, { bigint: true });
      if (
        !before.isFile() ||
        before.dev !== physical.dev ||
        before.ino !== physical.ino ||
        before.size > 1048576n ||
        before.size < 1n ||
        sourceBytes + Number(before.size) > 4194304
      )
        throw new Error("Repository source pin byte bound exceeded.");
      // Read at most the admitted size plus one byte; reject a growing/changing file.
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(
          fd,
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd, { bigint: true });
      if (
        length !== Number(before.size) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error("Repository source changed during pinning.");
      sourceBytes += length;
      return [
        path,
        createHash("sha256").update(bytes.subarray(0, length)).digest("hex"),
      ];
    } finally {
      closeSync(fd);
    }
  }),
);
const selected = options["--provider"] ? [options["--provider"]] : providers;
const cases = [
  [
    "image-recognition",
    "live",
    "A valid image contains a random visual answer absent from the text prompt; independently check its answer and attachment SHA.",
    "image",
  ],
  [
    "pdf-page-recognition",
    "live-responses-only",
    "A real PDF contains page text and artwork; exact model support, both unknown-document-cost opt-ins and an independent page answer are required.",
    "pdf",
  ],
  [
    "audio-segment-recognition",
    "live-chat-only",
    "An exact production Chat model consumes actual selected PCM16 WAV samples. Check a spoken random answer absent from text, source/asset SHA and interval; a local fixture model does not verify the account.",
    "audio",
  ],
  [
    "video-frame-recognition",
    "live-frame-adapter",
    "An exact supported image-capable production model consumes decoded AVI PNG frames. Independently check random frame pixels/order/timestamps; this proves the frame projection, not native video transport.",
    "video",
  ],
  [
    "generated-audio-layout",
    "live-chat-only",
    "An exact production model with separately verified host voice/rate/channels returns PCM16. Validate complete samples, duration, stream identity, final expiry/finish/DONE, actual Attempt/Part/Artifact and an independently checked audible answer. Never infer layout from another API.",
    "output",
  ],
  [
    "invalid-mime-signature",
    "local-before-live",
    "Invalid image/PDF or mismatched WAV/AVI container/codec rejects before account lookup, remote dispatch or native input acceptance.",
    "all",
  ],
  [
    "oversized-payload",
    "local-before-live",
    "Per-source, interval/duration, decoded/repeated asset and aggregate serialized media bounds reject before remote dispatch.",
    "all",
  ],
  [
    "unknown-model-capability",
    "local-before-live",
    "Unknown exact model IDs, generic modality labels or a missing adapter/model capability conjunction cannot dispatch new media.",
    "all",
  ],
  [
    "unknown-pdf-token-cost",
    "local-before-live",
    "Either missing independent PDF cost opt-in rejects; opted-in diagnostics keep documentTokens=null and incomplete estimates.",
    "pdf",
  ],
  [
    "unknown-media-token-cost",
    "local-before-live",
    "Missing fixed host allowUnknownMediaTokenCost rejects audio/video/output. With explicit permission mediaTokens stays null; absent usage is not zero.",
    "segments",
  ],
  [
    "decoded-segment-anchors",
    "local-before-live",
    "Re-decode genuine source bytes and independently verify selected WAV samples and timestamped lossless PNG pixels; DTO timestamps cannot replace physical bytes.",
    "segments",
  ],
  [
    "native-provider-artifact",
    "local-before-live",
    "A genuine Engine Run/Turn/provider Attempt emits a native media Part and managed Artifact, with immutable provider identity and independent cleanup/birth journals; no invented Tool ID.",
    "output",
  ],
  [
    "partial-generation",
    "local-before-live",
    "Cancellation/truncated stream retains an interrupted Artifact and failed/interrupted Part. A partial sample is octet data, not WAV; no successful recognition or automatic replay.",
    "output",
  ],
  [
    "artifact-and-output-budget",
    "local-before-live",
    "Charge PCM and text against the actual Run output budget, and count the full WAV header against normalized producer/artifact budgets before publication.",
    "output",
  ],
  [
    "native-publication-sql-failure",
    "local-before-live",
    "Physical artifact publication followed by native receipt failure remains uncertain; it cannot fabricate a complete Part or retry the provider.",
    "output",
  ],
  [
    "duplicate-delivery",
    "local-before-live",
    "Retry the exact accepted media input and assert the same native input/Run identity, one provider request and no second Artifact publication.",
    "all",
  ],
  [
    "source-removal-or-change",
    "local-before-live",
    "Delete/change the actual source blob or owner before dispatch: reject with zero requests and no substituted bytes. Prior success is historical evidence only.",
    "all",
  ],
  [
    "restart-and-paused-import",
    "local-before-live",
    "Preserve source/output bytes, exact native owners and receipts through reopen/archive/import; pause imported sessions, expose bounded output reads and never dispatch restored producers.",
    "all",
  ],
  [
    "sigkill-and-unjoined-cleanup",
    "local-before-live",
    "Actual SIGKILL at artifact/Part/final-settlement boundaries and an unjoinable response leave recovery/uncertainty. No generated output or completion receipt grants execution authority.",
    "output",
  ],
];
/** @param {string} adapter @param {Record<string, unknown>} capability @param {Record<string, unknown>} [extra] */
const supported = (adapter, capability, extra = {}) => ({
  adapter,
  model: "unverified",
  accountVerified: false,
  ...capability,
  ...extra,
});
const unsupported = () => ({
  adapter: "unsupported",
  model: "not-requested",
  accountVerified: false,
});
const plan = {
  schemaVersion: 1,
  workItem: "MC2-16a",
  workItems: ["MC2-16a", "MC2-16b", "MC2-16c", "MC2-16d"],
  kind: "account-media-verification-plan",
  state: "plan-only",
  liveProviderCalls: 0,
  accountConfigurationRead: false,
  accountVerified: false,
  sourcePins,
  implementation: {
    authority: "source-pinned-adapter-plan-only",
    engineApis: [
      "importImage",
      "importDocument",
      "importMedia",
      "getMediaCapabilities",
      "readMediaOutput",
    ],
    modelSelectionGrantsCapability: false,
    accountCompatibility: "unverified",
    completionCredit: false,
  },
  matrix: selected.map((providerId) => {
    const chat = providerId === "openai-compatible",
      frames = chat || providerId === "openai-responses";
    return {
      providerId,
      modelId: options["--model"] ?? null,
      accountVerified: false,
      image: supported("declared-input-image", {
        mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      }),
      pdf:
        providerId === "openai-responses"
          ? supported(
              "explicit-pdfModelIds-and-modelSpec-required",
              { mimeTypes: ["application/pdf"] },
              { unknownTokenCost: "two-independent-opt-ins-required" },
            )
          : unsupported(),
      audio: chat
        ? supported("implemented-wav-input_audio", {
            mimeTypes: ["audio/wav"],
            codec: "PCM16 RIFF WAV",
            modelDeclaration:
              "audioModelIds exact ID AND ModelSpec.mediaCapabilities.audioInput=true",
          })
        : unsupported(),
      video: frames
        ? supported(
            chat
              ? "implemented-avi-png-image_url"
              : "implemented-avi-png-input_image",
            {
              mimeTypes: ["video/x-msvideo"],
              wireMimeTypes: ["image/png"],
              codec: "single video stream RGB24/BI_RGB AVI",
              modelDeclaration:
                "videoModelIds exact ID AND ModelSpec.mediaCapabilities.videoFrames=true",
              nativeFullVideo: false,
            },
          )
        : unsupported(),
      generatedMedia: chat
        ? supported("implemented-streamed-pcm16-provider-artifact", {
            mimeTypes: ["audio/wav"],
            partialUnalignedMimeType: "application/octet-stream",
            modelDeclaration:
              "outputAudio.modelIds exact ID AND ModelSpec.mediaCapabilities.audioOutput=true",
            layout:
              "explicit host outputAudio voice/sampleRate/channels independently verified for exact endpoint/model",
            nativeIdentity: "actual Run/Turn/Attempt; no fabricated toolCallId",
            imageGeneration: false,
            videoGeneration: false,
          })
        : unsupported(),
      requiredCases: cases
        .filter(
          ([, , , lane]) =>
            lane === "all" ||
            lane === "image" ||
            (lane === "pdf" && providerId === "openai-responses") ||
            (lane === "audio" && chat) ||
            (lane === "video" && frames) ||
            (lane === "segments" && frames) ||
            (lane === "output" && chat),
        )
        .map(([id]) => id),
      unsupportedMediaCheck:
        "Audio/video/output requests outside these exact adapter/model declarations reject before dispatch; an exact --model string is not a host declaration or verified account.",
    };
  }),
  constraints: {
    segments: {
      sourceBytes: 524288,
      sourceDurationMs: 30000,
      maxIntervals: 4,
      maxIntervalMs: 10000,
      intervalUnit: "integer milliseconds; ordered nonoverlapping",
      audioSampleRates: [8000, 16000, 24000, 48000],
      audioChannels: [1, 2],
      maxVideoWidth: 256,
      maxVideoHeight: 256,
      maxVideoSourceFrames: 32,
      maxRiffChunks: 256,
      decodedAndRepeatedWireAssets: 4,
      decodedAndRepeatedWireBytes: 1048576,
    },
    output: {
      streamsPerAttempt: 1,
      pcmBytes: 524244,
      wavHeaderBytes: 44,
      totalWavBytes: 524288,
      maxChunks: 256,
      maxDurationMs: 30000,
      sampleRates: [8000, 16000, 24000, 48000],
      channels: [1, 2],
      layoutVerified: false,
      actualRunOutputAndNormalizedArtifactBudgetsRequired: true,
      boundedHostReadDefaultBytes: 8192,
      boundedHostReadMaximumBytes: 65536,
    },
    tokenCost: {
      mediaTokens: null,
      documentTokens: null,
      unknownMediaCost:
        "fixed host allowUnknownMediaTokenCost=true; independent exact model support",
      unknownPdfCost: "independent host and Responses adapter opt-ins",
      providerUsage:
        "record actual usage when supplied; otherwise null/absent, never zero",
    },
    unsupported: [
      "MP3/AAC/Opus/FLAC",
      "compressed AVI/MP4/MOV",
      "native full-video API",
      "Anthropic/Responses/Codex audio input or audio output",
      "Anthropic/Codex new video segments",
      "image/video generation",
    ],
    history:
      "Original native owners and physical source/output bytes are required. Reopen/import/capability reads never rehydrate a live grant or replay a provider.",
  },
  cases: cases.map(([id, execution, acceptance]) => ({
    id,
    execution,
    acceptance,
    state: "pending",
    evidence: null,
  })),
  evidenceContract: {
    identity: [
      "exact-provider-id",
      "exact-model-id",
      "adapter-source-sha",
      "host-model-capability-sha",
      "exact-endpoint-and-output-layout-source",
      "runtime-version",
      "observed-at",
    ],
    input: [
      "fixture-sha",
      "mime-and-decoder",
      "decoded-bytes",
      "source-and-asset-sha",
      "segment-or-page-anchor",
      "prompt-sha",
      "native-input-run-turn-attempt-ids",
    ],
    observation: [
      "request-count",
      "recognition-answer-hash",
      "independent-expected-answer-check",
      "native-terminal-state",
      "actual-cleanup-receipt",
      "usage-or-null",
      "provider-artifact-and-native-media-part",
      "sample-layout-and-full-stored-byte-check",
    ],
    redact: [
      "credentials",
      "account-tokens",
      "authorization-headers",
      "raw-fixture-or-response-contents",
    ],
    success:
      "Only an independently checked actual account response proves recognition or production media compatibility. HTTP success, model names, declarations, local fixtures and this plan do not.",
  },
  nextExecution: {
    local:
      "Run media segments/segments.integration/segment-boundaries/media-output-budgets and segment-crash source or compiled suites. These use genuine native ownership and local fixture transports; they do not verify an account.",
    localSuites: [
      "packages/engine/src/media/segments.test.ts",
      "packages/engine/src/media/segments.integration.test.ts",
      "packages/engine/src/media/segment-boundaries.integration.test.ts",
      "packages/engine/src/media/media-output-budgets.integration.test.ts",
      "packages/engine/src/media/segment-crash.integration.test.ts",
    ],
    live: "Select exact account/provider/model and independently verify capability, endpoint, output layout and cost policy before tools-free bounded fixtures. Existing Codex image executors scripts/verify-session-image.mjs --live and scripts/verify-media-history.mjs --live prove image only; neither proves new audio/video/PDF/output support.",
    newModalities:
      "Native audio segments, frame projection and provider audio Artifacts are implemented locally. MC2-16d production account/model evidence and E5-13 stay open until separately executed; unsupported transports/codecs stay unsupported.",
  },
  environmentDebt: {
    id: "E5-13",
    state: "open",
    reason:
      "This plan makes no actual multimodal account request or completion claim.",
  },
};
console.log(JSON.stringify(plan, null, 2));
