import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Planning only. This module does not import a provider or read account configuration.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sources = [
  "packages/engine/src/media/validation.ts",
  "packages/engine/src/media/provider.ts",
  "packages/engine/src/documents/validation.ts",
  "packages/engine/src/documents/provider.ts",
  "packages/engine/src/provider/codex.ts",
  "packages/engine/src/provider/responses.ts",
  "packages/engine/src/provider/anthropic.ts",
  "packages/engine/src/provider/openai-compatible.ts",
  "packages/engine/src/context/model-spec.ts",
];
const providers = [
  "codex",
  "openai-responses",
  "anthropic",
  "openai-compatible",
];
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
const sourcePins = Object.fromEntries(
  sources.map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(join(root, path)))
      .digest("hex"),
  ]),
);
const selected = options["--provider"] ? [options["--provider"]] : providers;
const cases = [
  [
    "image-recognition",
    "live",
    "A real valid image containing a random visual answer absent from the text prompt; exact answer and attachment SHA are independently recorded.",
  ],
  [
    "pdf-page-recognition",
    "live-responses-only",
    "A real well-formed PDF with text and page artwork; exact supported model, two unknown-document-token opt-ins and independently checked page answer are required.",
  ],
  [
    "invalid-mime-signature",
    "local-before-live",
    "Mismatch declared MIME and actual bytes; no credential lookup, remote request or accepted Run.",
  ],
  [
    "oversized-payload",
    "local-before-live",
    "Per-item, decoded aggregate and serialized request bounds reject before remote dispatch.",
  ],
  [
    "unknown-model-capability",
    "local-before-live",
    "Missing exact provider/model media declaration stays unknown and prevents dispatch.",
  ],
  [
    "unknown-pdf-token-cost",
    "local-before-live",
    "Either omitted independent opt-in rejects; opted-in diagnostics remain incomplete with documentTokens=null.",
  ],
  [
    "partial-generation",
    "local-before-live",
    "Truncated/cancelled stream is not a recognition receipt; actual iterator cleanup and native uncertainty are retained.",
  ],
  [
    "duplicate-delivery",
    "local-before-live",
    "Exact accepted input retry preserves native identity and does not create a second request.",
  ],
  [
    "source-removal-or-change",
    "local-before-live",
    "Deleted/modified blob or owner is rejected at dispatch; prior success is historical evidence only.",
  ],
  [
    "restart-and-paused-import",
    "local-before-live",
    "Native source/refs survive export and import; restored history does not automatically dispatch a producer.",
  ],
];
const plan = {
  schemaVersion: 1,
  workItem: "MC2-16a",
  kind: "account-media-verification-plan",
  state: "plan-only",
  liveProviderCalls: 0,
  accountConfigurationRead: false,
  sourcePins,
  matrix: selected.map((providerId) => ({
    providerId,
    modelId: options["--model"] ?? null,
    accountVerified: false,
    image: { adapter: "declared-input-image", model: "unverified" },
    pdf:
      providerId === "openai-responses"
        ? {
            adapter: "explicit-pdfModelIds-and-modelSpec-required",
            model: "unverified",
            unknownTokenCost: "two-independent-opt-ins-required",
          }
        : { adapter: "unsupported", model: "not-requested" },
    audio: "not-implemented",
    video: "not-implemented",
    generatedMedia: "not-implemented",
    requiredCases: cases
      .filter(
        ([id]) =>
          id !== "pdf-page-recognition" || providerId === "openai-responses",
      )
      .map(([id]) => id),
  })),
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
      "runtime-version",
      "observed-at",
    ],
    input: [
      "fixture-sha",
      "mime",
      "decoded-bytes",
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
    ],
    redact: [
      "credentials",
      "account-tokens",
      "authorization-headers",
      "raw-fixture-or-response-contents",
    ],
    success:
      "Only an independently checked answer from an actual account request proves recognition. HTTP success, adapter declaration and a scripted fixture do not.",
  },
  nextExecution: {
    local:
      "Use the existing image/PDF source tests and native history/archive tests before account execution.",
    live: "Select exact account/provider/model and execute tools-free bounded fixtures after current capability/source checks. Existing Codex image executors are scripts/verify-session-image.mjs --live and scripts/verify-media-history.mjs --live; neither proves PDF support. scripts/verify-codex.mjs verifies text coding.",
    newModalities:
      "MC2-16b/c/d need new segment, capability, output artifact and actual supported-model evidence separately.",
  },
  environmentDebt: {
    id: "E5-13",
    state: "open",
    reason: "This plan makes no actual multimodal account request.",
  },
};
console.log(JSON.stringify(plan, null, 2));
