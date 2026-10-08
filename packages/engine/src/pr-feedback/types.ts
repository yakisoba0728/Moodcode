import {
  EngineError,
  type RunConfig,
  type JsonObject,
} from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import type { ScheduleTargetPin } from "../schedules/types.js";
import type {
  VerificationReceipt,
  VerificationSource,
} from "../verification/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { commitJson } from "../git/types.js";
export const PR_LIMITS = Object.freeze({
  watches: 32,
  occurrences: 128,
  rows: 512,
  rowBytes: 131072,
  totalBytes: 16777216,
  httpBytes: 1048576,
  pages: 4,
  checks: 256,
  reviews: 128,
  textBytes: 2048,
  promptBytes: 32768,
  intervalMs: 1000,
  requests: 2048,
});
export function prFail(code = "PR_FEEDBACK_INVALID"): never {
  throw new EngineError(
    code,
    "The bounded PR feedback, source or native admission evidence is invalid",
  );
}
export const prJson = <T>(v: T): T => {
  try {
    return commitJson(v);
  } catch {
    return prFail();
  }
};
export function prId(v: unknown): string {
  if (
    typeof v !== "string" ||
    !v ||
    Buffer.byteLength(v) > 128 ||
    /[\x00-\x1f\x7f]/.test(v)
  )
    prFail();
  return v;
}
export function prDigest(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) prFail();
  return v;
}
export function prGitSha(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v)) prFail();
  return v;
}
export function prInt(
  v: unknown,
  max = Number.MAX_SAFE_INTEGER,
  min = 0,
): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    prFail();
  return v;
}
export function prFields(
  v: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const p = prJson(v);
  if (
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).some((k) => !keys.includes(k))
  )
    prFail();
  return p as Record<string, unknown>;
}
export const prSign = <T extends object>(v: T): T & { sha256: string } => {
  const { sha256: _, ...b } = v as T & { sha256?: string };
  return prJson({ ...b, sha256: knowledgeHash(b) }) as T & { sha256: string };
};
export function prSigned<T extends { sha256: string }>(v: T): T {
  const c = prJson(v);
  const { sha256, ...b } = c;
  if (prDigest(sha256) !== knowledgeHash(b)) prFail();
  return c;
}
export interface PrRepository {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}
export interface PrRequiredCheck {
  readonly kind: "check" | "status";
  readonly name: string;
  readonly appId: number | null;
}
export interface PrPolicy {
  readonly required: readonly PrRequiredCheck[];
  readonly reviews: "observe";
  readonly maxRepairInputs: number;
}
export interface PrSourcePin {
  readonly runId: string;
  readonly head: string;
  readonly files: readonly { path: string; hash: string }[];
  readonly verificationSource: VerificationSource;
  readonly verificationRevision: number;
  readonly verificationDocumentSha256: string;
  readonly receipts: readonly VerificationReceipt[];
  readonly configurationSha256: string;
  readonly sha256: string;
}
export interface PrWatchPreview {
  readonly version: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly id: string;
  readonly repository: PrRepository;
  readonly apiBase: string;
  readonly policy: PrPolicy;
  readonly binding: KnowledgeHostBinding;
  readonly ownerEpoch: string;
  readonly target: ScheduleTargetPin;
  readonly source: PrSourcePin | null;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface PreviewPrWatchInput {
  readonly sessionId: string;
  readonly watchId: string;
  readonly repository: PrRepository;
  readonly policy: PrPolicy;
  readonly config: RunConfig;
  readonly sourceRunId: string | null;
  readonly apiBase?: string;
}
export interface RegisterPrWatchInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly watchId: string;
  readonly requestId: string;
  readonly expectedRevision: 0;
  readonly previewSha256: string;
  readonly decision: "allow" | "deny";
}
export interface PrCheckSnapshot {
  readonly kind: "check" | "status";
  readonly id: number;
  readonly name: string;
  readonly appId: number | null;
  readonly head: string;
  readonly state: "missing" | "pending" | "failed" | "passed";
  readonly conclusion: string | null;
  readonly observedRevision: string;
  readonly text: string;
}
export interface PrReviewSnapshot {
  readonly id: number;
  readonly authorId: number;
  readonly head: string;
  readonly state: string;
  readonly submittedAt: string;
  readonly body: string;
}
export function prChangesRequested(
  reviews: readonly PrReviewSnapshot[],
): boolean {
  const decisions = new Map<number, PrReviewSnapshot>();
  for (const r of reviews) {
    if (!["APPROVED", "CHANGES_REQUESTED"].includes(r.state)) continue;
    const previous = decisions.get(r.authorId);
    if (
      !previous ||
      r.submittedAt > previous.submittedAt ||
      (r.submittedAt === previous.submittedAt && r.id > previous.id)
    )
      decisions.set(r.authorId, r);
  }
  return [...decisions.values()].some((r) => r.state === "CHANGES_REQUESTED");
}
export interface PrRemoteSnapshot {
  readonly version: 1;
  readonly provider: "github";
  readonly repository: PrRepository;
  readonly repositoryId: number;
  readonly headRepositoryId: number;
  readonly headRepository: { owner: string; name: string };
  readonly base: string;
  readonly head: string;
  readonly state: "open" | "closed";
  readonly checks: readonly PrCheckSnapshot[];
  readonly reviews: readonly PrReviewSnapshot[];
  readonly requiredState: "missing" | "pending" | "failed" | "passed";
  readonly changesRequested: boolean;
  readonly coverage: "complete";
  readonly mergeAuthority: false;
  readonly semanticSha256: string;
  readonly observedAt: string;
  readonly sha256: string;
}
export interface PrWatchRecord {
  readonly version: 1;
  readonly revision: number;
  readonly preview: PrWatchPreview;
  readonly state: "active" | "denied" | "disabled" | "paused-import";
  readonly registrationRequestId: string;
  readonly registrationSha256: string;
  readonly cursor: number;
  readonly repairInputs: number;
  readonly snapshot: PrRemoteSnapshot | null;
  readonly gap: string | null;
  readonly nextPollAt: string | null;
  readonly importSha256: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sha256: string;
}
export interface PrAcceptedInput {
  readonly inputId: string;
  readonly requestId: string;
  readonly admittedSeq: number;
  readonly inputSha256: string;
}
export interface PrFeedbackOccurrence {
  readonly version: 1;
  readonly id: string;
  readonly revision: number;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly watchId: string;
  readonly watchSha256: string;
  readonly preview: PrWatchPreview;
  readonly snapshot: PrRemoteSnapshot;
  readonly state: "accepted" | "advisory" | "paused-import";
  readonly source: PrSourcePin | null;
  readonly repairEligible: boolean;
  readonly inputRequestId: string;
  readonly prompt: string | null;
  readonly accepted: PrAcceptedInput | null;
  readonly createdAt: string;
  readonly sha256: string;
}
export interface PollPrWatchInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly watchId: string;
  readonly requestId: string;
  readonly expectedRevision: number;
}
export interface PrPollResult {
  readonly kind: "updated" | "duplicate" | "gap";
  readonly watch: PrWatchRecord;
  readonly occurrence: PrFeedbackOccurrence | null;
}
export const prData = (v: object) => v as unknown as JsonObject;
export function validatePrRepository(v: unknown): PrRepository {
  const p = prFields(v, ["owner", "name", "number"]);
  for (const k of ["owner", "name"])
    if (
      typeof p[k] !== "string" ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(p[k] as string) ||
      p[k] === "." ||
      p[k] === ".."
    )
      prFail();
  prInt(p.number, 1000000000, 1);
  return p as unknown as PrRepository;
}
export function validatePrPolicy(v: unknown): PrPolicy {
  const p = prFields(v, ["required", "reviews", "maxRepairInputs"]);
  if (
    !Array.isArray(p.required) ||
    !p.required.length ||
    p.required.length > 32 ||
    p.reviews !== "observe"
  )
    prFail();
  prInt(p.maxRepairInputs, 8);
  const seen = new Set<string>();
  for (const x of p.required) {
    const q = prFields(x, ["kind", "name", "appId"]);
    prId(q.name);
    if (
      !["check", "status"].includes(String(q.kind)) ||
      (q.kind === "status" && q.appId !== null)
    )
      prFail();
    if (q.appId !== null) prInt(q.appId, Number.MAX_SAFE_INTEGER, 1);
    if (seen.has(knowledgeHash(q))) prFail();
    seen.add(knowledgeHash(q));
  }
  return prJson(p) as unknown as PrPolicy;
}
export function feedbackPrompt(
  o: Pick<PrFeedbackOccurrence, "id" | "snapshot" | "source" | "preview">,
): string {
  const text =
    "[Moodcode PR feedback v1]\n" +
    JSON.stringify({
      version: 1,
      authority: "untrusted-ci-review-data",
      occurrenceId: o.id,
      repository: o.snapshot.repository,
      base: o.snapshot.base,
      head: o.snapshot.head,
      requiredState: o.snapshot.requiredState,
      checks: o.snapshot.checks,
      reviews: o.snapshot.reviews,
      localSourceSha256: o.source?.verificationSource.sha256 ?? null,
      sourceRunId: o.source?.runId ?? null,
      repairBudget: o.preview.target.allocation,
      verificationRequired: true,
      mergeAuthority: false,
    });
  if (Buffer.byteLength(text) > PR_LIMITS.promptBytes)
    prFail("PR_PROMPT_LIMIT");
  return text;
}
