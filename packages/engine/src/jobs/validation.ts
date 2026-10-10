import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  JOB_LIMITS,
  type JobOwnerProof,
  type JobOutputCursor,
  type JobOutputPage,
  type JobOutputSnapshot,
  type TerminalClosedOutcomeProof,
  type TerminalJobSourceProof,
  type TerminalObservationProof,
} from "./types.js";

type ObjectValue = Record<string, unknown>;
export function jobError(code: string, message: string): never {
  throw new EngineError(code, message);
}
/** A checked path or one of its parents was removed or replaced. */
export function jobPathGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["ENOENT", "ENOTDIR", "ELOOP"].includes(
      String((error as NodeJS.ErrnoException).code),
    )
  );
}
function invalid(message: string): never {
  return jobError("INVALID_JOB", message);
}
/** Descriptor-safe bounded DATA cloning; no caller serializer or getter runs. */
export function jobJson<T>(
  input: T,
  maximum: number = JOB_LIMITS.metadataBytes,
): T {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > JOB_LIMITS.snapshotBytes
  )
    jobError("JOB_LIMIT", "Job DATA byte limit is invalid");
  let bytes = 0,
    nodes = 0;
  const visiting = new Set<object>();
  const account = (count: number): void => {
    bytes += count;
    if (bytes > maximum)
      jobError("JOB_LIMIT", "Job DATA exceeds its encoded byte bound");
  };
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 1_048_576 || depth > JOB_LIMITS.depth)
      jobError("JOB_LIMIT", "Job DATA structure exceeds its bound");
    if (value === null || typeof value === "boolean") {
      account(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === "string") {
      if (Buffer.from(value).toString("utf8") !== value)
        invalid("Job text must contain valid Unicode");
      account(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      account(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (
      !value ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      visiting.has(value)
    )
      invalid("Job DATA must be ordinary JSON");
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      invalid("Job DATA cannot use custom prototypes");
    if (array && value.length > JOB_LIMITS.snapshotEvents)
      jobError("JOB_LIMIT", "Job DATA array exceeds its count bound");
    visiting.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string"))
      invalid("Job DATA cannot contain symbol keys");
    if (Object.values(descriptors).some((item) => !("value" in item)))
      invalid("Job DATA cannot contain accessors");
    account(2 + Math.max(0, keys.length - (array ? 2 : 1)));
    let result: unknown;
    if (array) {
      if (!descriptors.length || keys.length !== value.length + 1)
        invalid("Job arrays must be dense with no extra fields");
      const target: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor?.enumerable)
          invalid("Job arrays must contain ordinary dense data");
        target.push(visit(descriptor.value, depth + 1));
      }
      result = target;
    } else {
      const target: ObjectValue = Object.create(null) as ObjectValue;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || ["__proto__", "toJSON"].includes(key))
          invalid("Job properties must be ordinary enumerable data");
        account(Buffer.byteLength(JSON.stringify(key)) + 1);
        target[key] = visit(descriptor.value, depth + 1);
      }
      result = target;
    }
    visiting.delete(value);
    return Object.freeze(result);
  }
  return visit(input, 0) as T;
}
export function jobObject(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
  maximum: number = JOB_LIMITS.metadataBytes,
): ObjectValue {
  const copy = jobJson(value, maximum);
  if (!copy || typeof copy !== "object" || Array.isArray(copy))
    invalid("Expected a job object");
  const result = copy as ObjectValue,
    keys = Object.keys(result);
  if (
    keys.some((key) => !fields.includes(key) && !optional.includes(key)) ||
    fields.some((key) => !Object.hasOwn(result, key))
  )
    invalid("Job object fields do not match the contract");
  return result;
}
export function jobIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > JOB_LIMITS.idBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid("Job identities require bounded text");
  return value as string;
}
export function jobInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  )
    invalid("Job counts must be bounded nonnegative integers");
  return value as number;
}
export function jobSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    invalid("Job digests require lowercase SHA-256");
  return value as string;
}
export function isCanonicalJobTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function stamp(value: unknown): string {
  if (!isCanonicalJobTime(value))
    invalid("Job time requires canonical UTC ISO text");
  return value;
}
function nullableText(value: unknown): void {
  if (value !== null) jobIdentifier(value);
}
function nullableExit(value: unknown): void {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) ||
      (value as number) < -2_147_483_648 ||
      (value as number) > 2_147_483_647)
  )
    invalid("Job exit code must be a nullable signed integer");
}
export function signJobData<T extends object>(
  value: T,
  maximum: number = JOB_LIMITS.metadataBytes,
): T & { readonly sha256: string } {
  const safe = jobJson(value, maximum),
    { sha256: _old, ...body } = safe as T & { sha256?: string };
  return jobJson({ ...body, sha256: knowledgeHash(body) }, maximum) as T & {
    readonly sha256: string;
  };
}
function digest(value: ObjectValue): void {
  const { sha256, ...body } = value;
  jobSha256(sha256);
  if (knowledgeHash(body) !== sha256)
    jobError("JOB_HASH_MISMATCH", "Job DATA does not match its checksum");
}
export function validateTerminalJobSourceProof(
  value: unknown,
): TerminalJobSourceProof {
  const p = jobObject(value, [
    "terminalId",
    "workspaceId",
    "sessionId",
    "serviceEpoch",
    "entryBirthNonce",
    "journalBindingSha256",
    "launchSha256",
    "createdAt",
    "authority",
    "sha256",
  ]);
  for (const key of [
    "terminalId",
    "workspaceId",
    "sessionId",
    "serviceEpoch",
    "entryBirthNonce",
  ])
    jobIdentifier(p[key]);
  jobSha256(p.journalBindingSha256);
  jobSha256(p.launchSha256);
  stamp(p.createdAt);
  if (!["current-physical", "retained-current"].includes(String(p.authority)))
    invalid("Restored terminal history cannot be a current source proof");
  digest(p);
  return p as unknown as TerminalJobSourceProof;
}
export const validateTerminalSourcePin = validateTerminalJobSourceProof;
export function validateJobOwnerProof(value: unknown): JobOwnerProof {
  const p = jobObject(value, [
    "workspaceId",
    "sessionId",
    "rootBindingSha256",
    "ownerEpoch",
    "sourceSha256",
    "sha256",
  ]);
  jobIdentifier(p.workspaceId);
  jobIdentifier(p.sessionId);
  jobSha256(p.rootBindingSha256);
  jobSha256(p.ownerEpoch);
  jobSha256(p.sourceSha256);
  digest(p);
  return p as unknown as JobOwnerProof;
}
const states = [
  "starting",
  "running",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
  "uncertain",
];
function counters(value: ObjectValue, seqKey = "outputSeq"): void {
  const through = jobInteger(value[seqKey], Number.MAX_SAFE_INTEGER - 1),
    oldest = jobInteger(value.oldestSeq, through + 1),
    retained = jobInteger(value.retainedBytes, JOB_LIMITS.retainedBytes),
    observed = jobInteger(value.observedBytes);
  if (
    oldest < 1 ||
    observed < retained ||
    observed < through ||
    retained < through - oldest + 1 ||
    observed - retained < oldest - 1
  )
    invalid("Job output counters are inconsistent");
}
export function validateTerminalObservationProof(
  value: unknown,
): TerminalObservationProof {
  const p = jobObject(value, [
    "sourceSha256",
    "state",
    "outputSeq",
    "oldestSeq",
    "observedBytes",
    "retainedBytes",
    "cleanupConfirmed",
    "exitCode",
    "reason",
    "updatedAt",
    "sha256",
  ]);
  jobSha256(p.sourceSha256);
  counters(p);
  nullableExit(p.exitCode);
  nullableText(p.reason);
  stamp(p.updatedAt);
  if (
    !states.includes(String(p.state)) ||
    (p.cleanupConfirmed !== null && typeof p.cleanupConfirmed !== "boolean")
  )
    invalid("Job terminal observation is invalid");
  if (
    ["starting", "running"].includes(String(p.state)) &&
    (p.cleanupConfirmed !== null || p.exitCode !== null)
  )
    invalid("A live terminal cannot claim completed cleanup");
  if (
    ["completed", "cancelled", "failed"].includes(String(p.state)) &&
    p.cleanupConfirmed !== true
  )
    invalid("A settled terminal requires confirmed cleanup");
  if (p.state === "completed" && p.exitCode !== 0)
    invalid("Terminal result contradicts cleanup or exit status");
  digest(p);
  return p as unknown as TerminalObservationProof;
}
export function validateTerminalClosedOutcomeProof(
  value: unknown,
): TerminalClosedOutcomeProof {
  const p = jobObject(value, [
    "sourceSha256",
    "state",
    "exitCode",
    "cancelled",
    "timedOut",
    "cleanupConfirmed",
    "reason",
    "closedAt",
    "sha256",
  ]);
  jobSha256(p.sourceSha256);
  nullableExit(p.exitCode);
  nullableText(p.reason);
  stamp(p.closedAt);
  if (
    !states.slice(2).includes(String(p.state)) ||
    [p.cancelled, p.timedOut, p.cleanupConfirmed].some(
      (v) => typeof v !== "boolean",
    )
  )
    invalid("A closed terminal outcome must be exact observation data");
  if (
    p.cleanupConfirmed !== true &&
    p.state !== "uncertain" &&
    p.state !== "interrupted"
  )
    invalid("Terminal outcome contradicts its cleanup proof");
  if (
    p.state === "completed" &&
    (p.exitCode !== 0 || p.cancelled || p.timedOut)
  )
    invalid(
      "Successful terminal cleanup cannot imply a cancelled or failed command",
    );
  if (p.state === "cancelled" && !p.cancelled && !p.timedOut)
    invalid("Cancelled terminal requires an observed cancellation or timeout");
  digest(p);
  return p as unknown as TerminalClosedOutcomeProof;
}
export function validateJobOutputSnapshot(value: unknown): JobOutputSnapshot {
  const p = jobObject(
    value,
    [
      "version",
      "source",
      "throughSeq",
      "oldestSeq",
      "observedBytes",
      "retainedBytes",
      "output",
      "sha256",
    ],
    [],
    JOB_LIMITS.snapshotBytes,
  );
  if (
    p.version !== 1 ||
    !Array.isArray(p.output) ||
    p.output.length > JOB_LIMITS.snapshotEvents
  )
    invalid("Unsupported terminal output snapshot");
  validateTerminalJobSourceProof(p.source);
  counters(p, "throughSeq");
  let seq = (p.oldestSeq as number) - 1,
    bytes = 0;
  for (const value of p.output) {
    const event = jobObject(
      value,
      ["seq", "data", "bytes"],
      [],
      JOB_LIMITS.pageEncodedBytes * 2,
    );
    if (
      jobInteger(event.seq) !== ++seq ||
      seq > (p.throughSeq as number) ||
      typeof event.data !== "string" ||
      !event.data ||
      Buffer.byteLength(event.data) !==
        jobInteger(event.bytes, JOB_LIMITS.eventBytes)
    )
      invalid("Job snapshot output must be contiguous exact UTF-8 events");
    bytes += event.bytes as number;
  }
  if (bytes !== p.retainedBytes || seq !== p.throughSeq)
    invalid("Job snapshot retention and sequence accounting disagree");
  digest(p);
  return p as unknown as JobOutputSnapshot;
}
export function validateJobOutputCursor(value: unknown): JobOutputCursor {
  const p = jobObject(value, [
    "version",
    "jobId",
    "jobRevisionId",
    "sourceSha256",
    "snapshotSha256",
    "throughSeq",
    "eventSeq",
    "byteOffset",
    "sha256",
  ]);
  const through = jobInteger(p.throughSeq, Number.MAX_SAFE_INTEGER - 1),
    seq = jobInteger(p.eventSeq, through + 1),
    offset = jobInteger(p.byteOffset, JOB_LIMITS.eventBytes);
  if (p.version !== 1 || seq < 1 || (seq === through + 1 && offset !== 0))
    invalid("Job cursor has an invalid event or EOF position");
  jobIdentifier(p.jobId);
  jobIdentifier(p.jobRevisionId);
  jobSha256(p.sourceSha256);
  jobSha256(p.snapshotSha256);
  digest(p);
  return p as unknown as JobOutputCursor;
}
export function validateJobOutputPage(value: unknown): JobOutputPage {
  const p = jobObject(
    value,
    [
      "version",
      "jobId",
      "jobRevisionId",
      "sourceSha256",
      "snapshotSha256",
      "throughSeq",
      "fragments",
      "nextCursor",
      "gap",
      "hasMore",
      "rawBytes",
      "sha256",
    ],
    [],
    JOB_LIMITS.pageEncodedBytes,
  );
  if (
    p.version !== 1 ||
    !Array.isArray(p.fragments) ||
    p.fragments.length > JOB_LIMITS.pageFragments ||
    typeof p.hasMore !== "boolean"
  )
    invalid("Job output page must have bounded fragments");
  jobIdentifier(p.jobId);
  jobIdentifier(p.jobRevisionId);
  jobSha256(p.sourceSha256);
  jobSha256(p.snapshotSha256);
  jobInteger(p.throughSeq, Number.MAX_SAFE_INTEGER - 1);
  const next = validateJobOutputCursor(p.nextCursor);
  for (const key of [
    "jobId",
    "jobRevisionId",
    "sourceSha256",
    "snapshotSha256",
    "throughSeq",
  ] as const)
    if (next[key] !== p[key])
      jobError(
        "JOB_OUTPUT_CURSOR_STALE",
        "Output page and cursor scopes disagree",
      );
  if (
    p.hasMore !== next.eventSeq <= (p.throughSeq as number) ||
    (p.hasMore && p.fragments.length === 0)
  )
    invalid("Job page has an inconsistent EOF or progress flag");
  let bytes = 0,
    previous: { seq: number; byteOffset: number; bytes: number } | undefined;
  for (const value of p.fragments) {
    const f = jobObject(
        value,
        ["seq", "byteOffset", "data", "bytes"],
        [],
        JOB_LIMITS.pageEncodedBytes,
      ),
      seq = jobInteger(f.seq, p.throughSeq as number),
      offset = jobInteger(f.byteOffset, JOB_LIMITS.eventBytes),
      size = jobInteger(f.bytes, JOB_LIMITS.pageRawBytes);
    if (
      seq < 1 ||
      !size ||
      offset + size > JOB_LIMITS.eventBytes ||
      typeof f.data !== "string" ||
      Buffer.byteLength(f.data) !== size
    )
      invalid("Output fragments must contain exact bounded UTF-8 bytes");
    if (
      previous &&
      !(
        (seq === previous.seq &&
          offset === previous.byteOffset + previous.bytes) ||
        (seq === previous.seq + 1 && offset === 0)
      )
    )
      invalid("Output fragment positions are not contiguous");
    bytes += size;
    previous = { seq, byteOffset: offset, bytes: size };
  }
  if (bytes !== jobInteger(p.rawBytes, JOB_LIMITS.pageRawBytes))
    invalid("Output page byte accounting disagrees");
  if (
    previous &&
    !(
      (next.eventSeq === previous.seq &&
        next.byteOffset === previous.byteOffset + previous.bytes) ||
      (next.eventSeq === previous.seq + 1 && next.byteOffset === 0)
    )
  )
    invalid("Output cursor does not follow the last fragment");
  if (p.gap !== null) {
    const gap = jobObject(p.gap, [
        "fromSeq",
        "fromByteOffset",
        "toSeq",
        "oldestSeq",
      ]),
      from = jobInteger(gap.fromSeq),
      to = jobInteger(gap.toSeq, p.throughSeq as number),
      oldest = jobInteger(gap.oldestSeq, (p.throughSeq as number) + 1);
    jobInteger(gap.fromByteOffset, JOB_LIMITS.eventBytes);
    if (
      from < 1 ||
      from > to ||
      oldest !== to + 1 ||
      (previous &&
        (p.fragments[0] as Record<string, unknown>).seq !== oldest) ||
      (!previous && next.eventSeq !== oldest)
    )
      invalid("Output loss must describe the exact missing prefix");
  }
  digest(p);
  return p as unknown as JobOutputPage;
}
