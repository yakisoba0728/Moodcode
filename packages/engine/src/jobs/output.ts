import {
  JOB_LIMITS,
  type JobOutputCursor,
  type JobOutputFragment,
  type JobOutputGap,
  type JobOutputPage,
  type JobOutputSnapshot,
  type ReadJobOutputInput,
} from "./types.js";
import {
  jobError,
  jobIdentifier,
  jobInteger,
  jobObject,
  signJobData,
  validateJobOutputCursor,
  validateJobOutputPage,
  validateJobOutputSnapshot,
} from "./validation.js";

/** DATA slicing only. Root must authenticate its original source and frozen snapshot first. */
export function readJobOutput(
  value: JobOutputSnapshot,
  input: ReadJobOutputInput,
): JobOutputPage {
  const snapshot = validateJobOutputSnapshot(value),
    request = jobObject(
      input,
      ["jobId", "jobRevisionId"],
      ["cursor", "maxBytes", "maxFragments"],
    ),
    jobId = jobIdentifier(request.jobId),
    jobRevisionId = jobIdentifier(request.jobRevisionId),
    maxBytes =
      request.maxBytes === undefined
        ? JOB_LIMITS.pageRawBytes
        : jobInteger(request.maxBytes, JOB_LIMITS.pageRawBytes),
    maxFragments =
      request.maxFragments === undefined
        ? JOB_LIMITS.pageFragments
        : jobInteger(request.maxFragments, JOB_LIMITS.pageFragments);
  if (maxBytes < 4 || maxFragments < 1)
    jobError(
      "INVALID_JOB_OUTPUT_LIMIT",
      "Output needs at least one fragment and four UTF-8 bytes",
    );
  const original =
    request.cursor === undefined
      ? undefined
      : validateJobOutputCursor(request.cursor);
  if (
    original &&
    (original.jobId !== jobId ||
      original.jobRevisionId !== jobRevisionId ||
      original.sourceSha256 !== snapshot.source.sha256 ||
      original.snapshotSha256 !== snapshot.sha256 ||
      original.throughSeq !== snapshot.throughSeq)
  )
    jobError(
      "JOB_OUTPUT_CURSOR_STALE",
      "Output cursor belongs to a different job or frozen source snapshot",
    );
  let seq = original?.eventSeq ?? 1,
    offset = original?.byteOffset ?? 0;
  let gap: JobOutputGap | null = null;
  if (seq < snapshot.oldestSeq) {
    gap = {
      fromSeq: seq,
      fromByteOffset: offset,
      toSeq: snapshot.oldestSeq - 1,
      oldestSeq: snapshot.oldestSeq,
    };
    seq = snapshot.oldestSeq;
    offset = 0;
  }
  const fragments: JobOutputFragment[] = [];
  let rawBytes = 0;
  while (
    seq <= snapshot.throughSeq &&
    fragments.length < maxFragments &&
    rawBytes < maxBytes
  ) {
    const event = snapshot.output[seq - snapshot.oldestSeq];
    if (!event || event.seq !== seq)
      jobError(
        "JOB_OUTPUT_SOURCE_GONE",
        "Frozen output does not contain the exact requested event",
      );
    const bytes = Buffer.from(event.data);
    if (
      offset >= bytes.length ||
      (offset > 0 && (bytes[offset]! & 0xc0) === 0x80)
    )
      jobError(
        "INVALID_JOB_OUTPUT_CURSOR",
        "Output byte offset must start an exact retained UTF-8 codepoint",
      );
    let end = Math.min(bytes.length, offset + maxBytes - rawBytes);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === offset) break;
    const slice = bytes.subarray(offset, end);
    fragments.push({
      seq,
      byteOffset: offset,
      data: slice.toString("utf8"),
      bytes: slice.length,
    });
    rawBytes += slice.length;
    if (end === bytes.length) {
      seq++;
      offset = 0;
    } else offset = end;
  }
  const nextCursor: JobOutputCursor = signJobData({
    version: 1 as const,
    jobId,
    jobRevisionId,
    sourceSha256: snapshot.source.sha256,
    snapshotSha256: snapshot.sha256,
    throughSeq: snapshot.throughSeq,
    eventSeq: seq,
    byteOffset: offset,
  });
  return validateJobOutputPage(
    signJobData(
      {
        version: 1 as const,
        jobId,
        jobRevisionId,
        sourceSha256: snapshot.source.sha256,
        snapshotSha256: snapshot.sha256,
        throughSeq: snapshot.throughSeq,
        fragments,
        nextCursor,
        gap,
        hasMore: seq <= snapshot.throughSeq,
        rawBytes,
      },
      JOB_LIMITS.pageEncodedBytes,
    ),
  );
}
