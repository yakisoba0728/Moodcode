import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  validateQueueTarget,
  type QueueTargetPin,
} from "../runner/queue-target.js";
import {
  validateOwnedCommandJob,
  type OwnedCommandJobRecord,
} from "./owned-command-records.js";
import { jobIdentifier, jobJson, jobObject, jobSha256 } from "./validation.js";

/** Descriptive DATA only. The Root separately authenticates its ORIGINAL target and terminal source Run. */
export interface OwnedCommandDeliveryTargetProof {
  readonly version: 1;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly jobSha256: string;
  readonly sourceSha256: string;
  readonly settled: OwnedCommandJobRecord;
  readonly target: QueueTargetPin;
  readonly sha256: string;
}
export const OWNED_COMMAND_RESULT_LIMITS = Object.freeze({
  proofBytes: 131_072,
  promptBytes: 32_768,
});
function invalid(code = "OWNED_COMMAND_DELIVERY_TARGET_INVALID"): never {
  throw new EngineError(
    code,
    "Command delivery requires an exact bounded settled observation and queue target",
  );
}
function assertSettled(job: OwnedCommandJobRecord): void {
  if (
    !["completed", "failed", "cancelled"].includes(job.state) ||
    job.completion?.outcome.cleanupConfirmed !== true ||
    Object.hasOwn(job.completion, "observationFailure")
  )
    invalid("OWNED_COMMAND_NOT_SETTLED");
}

/** Validates checksums and scope without opening artifacts or recreating execution authority. */
export function validateOwnedCommandDeliveryTargetProof(
  input: unknown,
): OwnedCommandDeliveryTargetProof {
  const p = jobObject(
    input,
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
    OWNED_COMMAND_RESULT_LIMITS.proofBytes,
  );
  if (p.version !== 1) invalid();
  jobIdentifier(p.workspaceId);
  jobIdentifier(p.jobId);
  jobSha256(p.jobSha256);
  jobSha256(p.sourceSha256);
  jobSha256(p.sha256);
  const settled = validateOwnedCommandJob(p.settled),
    target = validateQueueTarget(p.target);
  assertSettled(settled);
  if (
    p.workspaceId !== settled.source.workspaceId ||
    p.jobId !== settled.jobId ||
    p.jobSha256 !== settled.sha256 ||
    p.sourceSha256 !== settled.source.sha256 ||
    target.workspaceId !== p.workspaceId ||
    target.sessionId !== settled.source.sessionId ||
    knowledgeHash(target) !== knowledgeHash(p.target)
  )
    invalid();
  const { sha256, ...body } = p;
  if (knowledgeHash(body) !== sha256)
    invalid("OWNED_COMMAND_DELIVERY_HASH_MISMATCH");
  return jobJson(
    { ...p, settled, target },
    OWNED_COMMAND_RESULT_LIMITS.proofBytes,
  ) as unknown as OwnedCommandDeliveryTargetProof;
}

/** Complete quoted advisory DATA; command text, cwd and absolute artifact paths never become model input. */
export function formatOwnedCommandJobResult(
  input: OwnedCommandJobRecord,
  inputProof: OwnedCommandDeliveryTargetProof,
): string {
  const proof = validateOwnedCommandDeliveryTargetProof(inputProof),
    job = validateOwnedCommandJob(input);
  assertSettled(job);
  if (
    job.jobId !== proof.jobId ||
    job.sha256 !== proof.jobSha256 ||
    knowledgeHash(job) !== knowledgeHash(proof.settled)
  )
    invalid("OWNED_COMMAND_DELIVERY_STALE");
  const c = job.completion!,
    source = job.source,
    stream = (value: typeof c.stdout) => ({
      sha256: value.sha256,
      observedBytes: value.observedBytes,
      artifactBytes: value.artifactBytes,
      truncated: value.truncated,
    });
  // A diagnostic can mention a sealed file; retain the diagnostic without exposing those physical paths.
  const error =
    c.outcome.error === undefined
      ? null
      : c.outcome.error
          .replaceAll(c.stdout.path, "[sealed stdout artifact]")
          .replaceAll(c.stderr.path, "[sealed stderr artifact]");
  const data = jobJson(
    {
      schemaVersion: 1,
      authority: "untrusted-command-observation",
      executionAuthority: false,
      jobId: job.jobId,
      jobSha256: job.sha256,
      sourceSha256: source.sha256,
      source: {
        workspaceId: source.workspaceId,
        sessionId: source.sessionId,
        runId: source.runId,
        turnId: source.turnId,
        attemptId: source.attemptId,
        toolCallId: source.toolCallId,
      },
      state: job.state,
      outcome: {
        exitCode: c.outcome.exitCode,
        signal: c.outcome.signal,
        cancelled: c.outcome.cancelled,
        timedOut: c.outcome.timedOut,
        cleanupConfirmed: c.outcome.cleanupConfirmed,
        started: c.outcome.started,
        outputDiscarded: c.outcome.outputDiscarded ?? false,
        error,
      },
      checkpoint: {
        id: c.checkpoint.id,
        kind: c.checkpoint.kind,
        createdAt: c.checkpoint.createdAt,
        incomplete: c.checkpoint.incomplete,
        sha256: c.checkpoint.sha256,
      },
      sealedStreams: { stdout: stream(c.stdout), stderr: stream(c.stderr) },
    },
    OWNED_COMMAND_RESULT_LIMITS.promptBytes,
  );
  const result =
    "[Moodcode Run-owned command result v1]\n" + JSON.stringify(data);
  if (Buffer.byteLength(result) > OWNED_COMMAND_RESULT_LIMITS.promptBytes)
    invalid("OWNED_COMMAND_RESULT_LIMIT");
  return result;
}
