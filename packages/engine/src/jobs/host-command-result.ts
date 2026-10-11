import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  validateQueueTarget,
  type QueueTargetPin,
} from "../runner/queue-target.js";
import type { CommandResultProfile } from "./command-delivery-records.js";
import {
  validateHostCommandRecord,
  type HostCommandRecord,
} from "./host-command-records.js";
import {
  jobIdentifier,
  jobJson,
  jobObject,
  jobSha256,
  signJobData,
} from "./validation.js";
export interface HostCommandSettlementPin {
  readonly version: 1;
  readonly id: string;
  readonly jobId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly jobSha256: string;
  readonly sourceSha256: string;
  readonly state: "completed" | "failed" | "cancelled";
  readonly observation: Readonly<Record<string, unknown>>;
  readonly sha256: string;
}
export interface HostCommandDeliveryTargetProof {
  readonly version: 1;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly jobSha256: string;
  readonly sourceSha256: string;
  readonly settled: HostCommandSettlementPin;
  readonly target: QueueTargetPin;
  readonly sha256: string;
}
export const HOST_COMMAND_RESULT_LIMITS = Object.freeze({
  pinBytes: 32_768,
  observationBytes: 24_576,
  proofBytes: 131_072,
  promptBytes: 32_768,
});
function fail(): never {
  throw new EngineError(
    "HOST_COMMAND_DELIVERY_SOURCE_INVALID",
    "Independent command delivery requires a genuinely settled cleanup-confirmed host observation",
  );
}
/** Same descriptive source tuple for model pages and native result delivery; it grants no authority. */
export function hostCommandSourceSha(job: HostCommandRecord): string {
  return knowledgeHash({
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    sessionId: job.sessionId,
    owner: job.owner,
    previewSha256: knowledgeHash(job.preview),
    pid: job.pid,
  });
}
export function hostCommandSettlement(
  input: HostCommandRecord,
): HostCommandSettlementPin {
  const job = validateHostCommandRecord(input);
  if (
    !["completed", "failed", "cancelled"].includes(job.state) ||
    job.completion?.outcome.cleanupConfirmed !== true ||
    Object.hasOwn(job.completion, "observationFailure")
  )
    fail();
  const c = job.completion!,
    stream = (s: typeof c.stdout) => ({
      sha256: s.sha256,
      observedBytes: s.observedBytes,
      artifactBytes: s.artifactBytes,
      truncated: s.truncated,
    });
  const outcome = { ...c.outcome };
  if (outcome.error)
    outcome.error = outcome.error
      .replaceAll(c.stdout.path, "[sealed stdout]")
      .replaceAll(c.stderr.path, "[sealed stderr]");
  return signJobData(
    {
      version: 1 as const,
      id: job.id,
      jobId: job.jobId,
      workspaceId: job.workspaceId,
      sessionId: job.sessionId,
      jobSha256: job.sha256,
      sourceSha256: hostCommandSourceSha(job),
      state: job.state as "completed" | "failed" | "cancelled",
      observation: {
        authority: "untrusted-command-observation",
        executionAuthority: false,
        sourceKind: "host-command",
        state: job.state,
        outcome,
        checkpoint: {
          sha256: knowledgeHash({
            files: c.files,
            warnings: c.warnings,
            incomplete: c.incomplete,
          }),
          files: c.files.length,
          warnings: c.warnings.length,
          incomplete: c.incomplete,
        },
        sealedStreams: { stdout: stream(c.stdout), stderr: stream(c.stderr) },
      },
    },
    HOST_COMMAND_RESULT_LIMITS.pinBytes,
  );
}
export function validateHostCommandSettlement(
  value: unknown,
): HostCommandSettlementPin {
  const p = jobObject(
    value,
    [
      "version",
      "id",
      "jobId",
      "workspaceId",
      "sessionId",
      "jobSha256",
      "sourceSha256",
      "state",
      "observation",
      "sha256",
    ],
    [],
    HOST_COMMAND_RESULT_LIMITS.pinBytes,
  );
  for (const k of ["id", "jobId", "workspaceId", "sessionId"])
    jobIdentifier(p[k]);
  for (const k of ["jobSha256", "sourceSha256", "sha256"]) jobSha256(p[k]);
  const { sha256, ...body } = p;
  const o = jobObject(
    p.observation,
    [
      "authority",
      "executionAuthority",
      "sourceKind",
      "state",
      "outcome",
      "checkpoint",
      "sealedStreams",
    ],
    [],
    HOST_COMMAND_RESULT_LIMITS.observationBytes,
  );
  const outcome = jobObject(
    o.outcome,
    [
      "started",
      "exitCode",
      "signal",
      "cancelled",
      "timedOut",
      "cleanupConfirmed",
    ],
    ["error", "outputDiscarded"],
  );
  for (const key of ["started", "cancelled", "timedOut", "cleanupConfirmed"])
    if (typeof outcome[key] !== "boolean") fail();
  if (
    (outcome.outputDiscarded !== undefined &&
      typeof outcome.outputDiscarded !== "boolean") ||
    (outcome.error !== undefined &&
      (typeof outcome.error !== "string" ||
        Buffer.byteLength(outcome.error) > 8192)) ||
    (outcome.exitCode !== null && !Number.isSafeInteger(outcome.exitCode)) ||
    (outcome.signal !== null && typeof outcome.signal !== "string")
  )
    fail();
  const cp = jobObject(o.checkpoint, [
    "sha256",
    "files",
    "warnings",
    "incomplete",
  ]);
  jobSha256(cp.sha256);
  if (
    !Number.isSafeInteger(cp.files) ||
    Number(cp.files) < 0 ||
    !Number.isSafeInteger(cp.warnings) ||
    Number(cp.warnings) < 0 ||
    typeof cp.incomplete !== "boolean"
  )
    fail();
  const streams = jobObject(o.sealedStreams, ["stdout", "stderr"]);
  for (const name of ["stdout", "stderr"]) {
    const stream = jobObject(streams[name], [
      "sha256",
      "observedBytes",
      "artifactBytes",
      "truncated",
    ]);
    jobSha256(stream.sha256);
    if (
      !Number.isSafeInteger(stream.observedBytes) ||
      Number(stream.observedBytes) < 0 ||
      !Number.isSafeInteger(stream.artifactBytes) ||
      Number(stream.artifactBytes) < 0 ||
      Number(stream.artifactBytes) > Number(stream.observedBytes) ||
      typeof stream.truncated !== "boolean"
    )
      fail();
  }
  if (
    p.version !== 1 ||
    !["completed", "failed", "cancelled"].includes(String(p.state)) ||
    o.authority !== "untrusted-command-observation" ||
    o.executionAuthority !== false ||
    o.sourceKind !== "host-command" ||
    o.state !== p.state ||
    outcome.cleanupConfirmed !== true ||
    knowledgeHash(body) !== sha256
  )
    fail();
  return p as unknown as HostCommandSettlementPin;
}
export function validateHostCommandDeliveryTargetProof(
  value: unknown,
): HostCommandDeliveryTargetProof {
  const p = jobObject(
    value,
    [
      "version",
      "workspaceId",
      "jobId",
      "jobSha256",
      "sourceSha256",
      "settled",
      "target",
      "sha256",
    ],
    [],
    HOST_COMMAND_RESULT_LIMITS.proofBytes,
  );
  const settled = validateHostCommandSettlement(p.settled),
    target = validateQueueTarget(p.target);
  const { sha256, ...body } = p;
  if (
    p.version !== 1 ||
    p.workspaceId !== settled.workspaceId ||
    p.jobId !== settled.jobId ||
    p.jobSha256 !== settled.jobSha256 ||
    p.sourceSha256 !== settled.sourceSha256 ||
    target.workspaceId !== p.workspaceId ||
    target.sessionId !== settled.sessionId ||
    knowledgeHash(body) !== sha256
  )
    fail();
  return jobJson(
    { ...p, settled, target },
    HOST_COMMAND_RESULT_LIMITS.proofBytes,
  ) as unknown as HostCommandDeliveryTargetProof;
}
export function formatHostCommandJobResult(
  input: HostCommandSettlementPin,
  rawProof: HostCommandDeliveryTargetProof,
): string {
  const proof = validateHostCommandDeliveryTargetProof(rawProof),
    job = validateHostCommandSettlement(input);
  if (knowledgeHash(job) !== knowledgeHash(proof.settled)) fail();
  const result =
    "[Moodcode independent host command result v1]\n" +
    JSON.stringify({
      schemaVersion: 1,
      jobId: job.jobId,
      jobSha256: job.jobSha256,
      sourceSha256: job.sourceSha256,
      source: { workspaceId: job.workspaceId, sessionId: job.sessionId },
      ...job.observation,
    });
  if (Buffer.byteLength(result) > HOST_COMMAND_RESULT_LIMITS.promptBytes)
    fail();
  return result;
}
/** Independent host command results as one kind of settled command delivery. */
export const HOST_COMMAND_RESULT_PROFILE: CommandResultProfile<
  HostCommandSettlementPin,
  HostCommandDeliveryTargetProof
> = Object.freeze({
  label: "Independent host command",
  inputPrefix: "host-command-result",
  placeholder: "host-command-target",
  proofBytes: HOST_COMMAND_RESULT_LIMITS.proofBytes,
  validateSettled: validateHostCommandSettlement,
  validateTarget: validateHostCommandDeliveryTargetProof,
  formatResult: formatHostCommandJobResult,
  digests: (settled: HostCommandSettlementPin) => ({
    jobSha256: settled.jobSha256,
    sourceSha256: settled.sourceSha256,
  }),
  sessionOf: (settled: HostCommandSettlementPin) => settled.sessionId,
});
