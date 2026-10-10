import { createHash } from "node:crypto";
import { types } from "node:util";
import { EngineError, type Run } from "@moodcode/contracts";
import {
  createCodingEvidenceManifest,
  type CodingEvidenceManifest,
} from "./attempt-manifest.js";
import {
  exportTrajectory,
  validateTrajectoryOptions,
  type TrajectoryOptions,
  type TrajectoryReader,
} from "./trajectory.js";
import {
  validateDiagnosticExecutionObservationArchiveRow,
  DIAGNOSTIC_EXECUTION_OBSERVATION_LIMITS,
} from "./execution-observation-store.js";
import type {
  DiagnosticExecutionObservation,
  DiagnosticExecutionPage,
  DiagnosticExecutionPageOptions,
} from "./execution-observation-types.js";

export const NATIVE_CODING_EVIDENCE_LIMITS = Object.freeze({
  outputBytes: 65536,
  observationRows: 100,
  observationBytes: 1048576,
});
export type NativeCodingEvidenceOptions = Omit<
  TrajectoryOptions,
  "sessionId" | "runId"
> & {
  readonly execution?: DiagnosticExecutionPageOptions;
  readonly includeSummary?: boolean;
};
export interface NativeCodingEvidenceReader extends TrajectoryReader {
  getRun(runId: string): Run;
  listExecutionObservations(
    workspaceId: string,
    runId: string,
    options: DiagnosticExecutionPageOptions,
  ): DiagnosticExecutionPage;
  /** Trusted host port: all methods above must consume this same synchronous primary read transaction. */
  readCoherentSnapshot<T>(operation: () => T): T;
}
export interface ExtractiveDiagnosticSummary {
  readonly schemaVersion: 1;
  readonly projection: "extractive-diagnostic-metadata-v1";
  readonly implementation: "deterministic-metadata-only";
  readonly runState: Run["state"];
  readonly providerAttemptStates: Readonly<Record<string, number>>;
  readonly partialOutputs: number;
  readonly executionStates: Readonly<Record<string, number>>;
  readonly unknownSources: number;
  readonly providerCalls: 0;
  readonly toolCalls: 0;
  readonly generatedTokens: 0;
  readonly externalGeneration: "not-implemented";
  readonly taskSuccess: "not-established";
}
type CoherentCodingProjection = Omit<CodingEvidenceManifest, "coverage"> & {
  coverage: Omit<CodingEvidenceManifest["coverage"], "sourceClock"> & {
    sourceClock: "coherent-primary-read-transaction";
  };
};
export interface NativeCodingEvidenceManifest {
  readonly schemaVersion: 1;
  readonly projection: "native-coding-evidence-manifest-v1";
  readonly coding: CoherentCodingProjection;
  readonly execution: {
    readonly items: readonly DiagnosticExecutionObservation[];
    readonly sourcePageSha256: string;
    readonly afterOrdinal: number;
    readonly throughOrdinal: number;
    readonly next: number | null;
    readonly returnedRecords: number;
    readonly omittedSelectedRecords: number;
    readonly sourceBytes: number;
    readonly source: "bounded-native-execution-observation-page";
    readonly sourceCoverage: "past-authenticated-execution-boundaries-only";
    readonly currentWorkspaceFreshness: "not-scanned";
    readonly completeRunHistory: "not-established";
  };
  readonly budget: {
    readonly authority: "original-run-config-only";
    readonly originalLimits: Record<string, number>;
    readonly originalBudgets: Record<string, number> | null;
    readonly remaining: null;
    readonly remainingReason: "native-budget-account-authority-not-available";
    readonly providerRetryAuthority: false;
  };
  readonly summary: ExtractiveDiagnosticSummary | null;
  readonly coverage: {
    readonly snapshot: "coherent-primary-read-transaction";
    readonly records: "selected-bounded-pages-only";
    readonly omittedProviderAttempts: number;
    readonly omittedOutputs: number;
    readonly truncated: boolean;
    readonly rawPromptResultAndFileBytes: "not-exported";
    readonly credentialReplayAndAttachments: "not-read";
    readonly providerEffects: "not-executed";
    readonly toolEffects: "not-executed";
    readonly taskSuccess: "not-established";
    readonly replayAuthority: false;
  };
  readonly manifestSha256: string;
}
function fail(message: string): never {
  throw new EngineError("INVALID_NATIVE_CODING_EVIDENCE", message);
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function plain(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("Native evidence options require ordinary data");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    required.some((key) => !Object.hasOwn(fields, key)) ||
    Reflect.ownKeys(fields).some(
      (key) =>
        typeof key !== "string" ||
        !allowed.includes(key) ||
        !fields[key]!.enumerable ||
        !Object.hasOwn(fields[key]!, "value"),
    )
  )
    fail("Native evidence rejects unknown fields, symbols and accessors");
}
function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    fail("Native evidence page bound is invalid");
}
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail("Native evidence requires a bounded owner identity");
}
/** Validates before readNativeCodingEvidence destructures options. */
function validateNativeCodingEvidenceOptions(
  input: NativeCodingEvidenceOptions,
): void {
  plain(input, [
    "afterSeq",
    "throughSeq",
    "limit",
    "maxBytes",
    "execution",
    "includeSummary",
  ]);
  const { execution, includeSummary, ...journal } = input;
  validateTrajectoryOptions({ sessionId: "validation-only", ...journal });
  if (includeSummary !== undefined && typeof includeSummary !== "boolean")
    fail("Extractive metadata summary requires an explicit boolean");
  if (execution !== undefined) {
    plain(execution, ["afterOrdinal", "throughOrdinal", "limit", "maxBytes"]);
    if (execution.afterOrdinal !== undefined)
      integer(execution.afterOrdinal, 0, Number.MAX_SAFE_INTEGER);
    if (execution.throughOrdinal !== undefined)
      integer(
        execution.throughOrdinal,
        execution.afterOrdinal ?? 0,
        Number.MAX_SAFE_INTEGER,
      );
    if (execution.limit !== undefined)
      integer(
        execution.limit,
        1,
        NATIVE_CODING_EVIDENCE_LIMITS.observationRows,
      );
    if (execution.maxBytes !== undefined)
      integer(
        execution.maxBytes,
        256,
        NATIVE_CODING_EVIDENCE_LIMITS.observationBytes,
      );
  }
}
function counts(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values)
    Object.defineProperty(counts, value, {
      value: (counts[value] ?? 0) + 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return Object.freeze(counts);
}
function summary(
  coding: CoherentCodingProjection,
  records: readonly DiagnosticExecutionObservation[],
): ExtractiveDiagnosticSummary {
  return {
    schemaVersion: 1,
    projection: "extractive-diagnostic-metadata-v1",
    implementation: "deterministic-metadata-only",
    runState: coding.runObservation.state,
    providerAttemptStates: counts(
      coding.providerAttempts.map((attempt) => attempt.state ?? "unknown"),
    ),
    partialOutputs: coding.outputs.filter((output) => output.partial).length,
    executionStates: counts(records.map((record) => record.state)),
    unknownSources: records.filter(
      (record) =>
        record.sourceBefore.completeness === "unknown" ||
        record.sourceAfter?.completeness !== "full",
    ).length,
    providerCalls: 0,
    toolCalls: 0,
    generatedTokens: 0,
    externalGeneration: "not-implemented",
    taskSuccess: "not-established",
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function checkedPage(
  page: DiagnosticExecutionPage,
  run: Run,
  options: DiagnosticExecutionPageOptions,
): DiagnosticExecutionPage {
  plain(
    page,
    ["items", "next", "throughOrdinal", "bytes"],
    ["items", "next", "throughOrdinal", "bytes"],
  );
  integer(
    page.throughOrdinal,
    options.afterOrdinal ?? 0,
    Number.MAX_SAFE_INTEGER,
  );
  integer(
    page.bytes,
    0,
    options.maxBytes ?? NATIVE_CODING_EVIDENCE_LIMITS.observationBytes,
  );
  if (
    !Array.isArray(page.items) ||
    types.isProxy(page.items) ||
    page.items.length > (options.limit ?? 100)
  )
    fail("Native observation reader exceeded its selected count");
  const properties = Object.getOwnPropertyDescriptors(page.items);
  if (
    Reflect.ownKeys(properties).some(
      (key) =>
        key !== "length" && (typeof key !== "string" || !/^\d+$/u.test(key)),
    ) ||
    Object.keys(properties).length !== page.items.length + 1
  )
    fail("Native observation page must be dense ordinary data");
  const items: DiagnosticExecutionObservation[] = [];
  let previous = options.afterOrdinal ?? 0;
  for (let i = 0; i < page.items.length; i++) {
    const property = properties[String(i)];
    if (!property?.enumerable || !Object.hasOwn(property, "value"))
      fail("Native observation page rejects accessors");
    const input = property.value;
    plain(input, [
      "workspaceId",
      "sessionId",
      "runId",
      "toolCallId",
      "turnId",
      "attemptId",
      "schemaVersion",
      "id",
      "ordinal",
      "runtimeEpoch",
      "revision",
      "state",
      "toolName",
      "effectClass",
      "inputSha256",
      "effectiveInputSha256",
      "dispatchToolSha256",
      "settledToolSha256",
      "resultSha256",
      "resultComplete",
      "outcome",
      "sourceBefore",
      "sourceAfter",
      "effectEpochBefore",
      "effectEpochDispatch",
      "effectEpochAfter",
      "dispatchedAt",
      "settledAt",
      "sha256",
    ]);
    const record = validateDiagnosticExecutionObservationArchiveRow({
      table: "diagnostic_execution_observations",
      key: input.id as string,
      workspaceId: run.workspaceId,
      data: input as unknown as DiagnosticExecutionObservation,
    }).data as DiagnosticExecutionObservation;
    if (
      record.runId !== run.id ||
      record.sessionId !== run.sessionId ||
      record.workspaceId !== run.workspaceId ||
      record.ordinal <= previous ||
      record.ordinal > page.throughOrdinal
    )
      fail("Native observation page has foreign or unordered ownership");
    items.push(record);
    previous = record.ordinal;
  }
  if (
    (page.next !== null && page.next !== previous) ||
    (options.throughOrdinal !== undefined &&
      page.throughOrdinal > options.throughOrdinal) ||
    Buffer.byteLength(JSON.stringify(items)) >
      DIAGNOSTIC_EXECUTION_OBSERVATION_LIMITS.pageBytes + 1024
  )
    fail("Native observation page frontier exceeds its selected bound");
  return {
    items,
    next: page.next,
    throughOrdinal: page.throughOrdinal,
    bytes: page.bytes,
  };
}
/** No effects or provider admission: original Run/journal/native observation reads share the trusted host snapshot. */
export function readNativeCodingEvidence(
  reader: NativeCodingEvidenceReader,
  runId: string,
  options: NativeCodingEvidenceOptions = {},
): NativeCodingEvidenceManifest {
  identifier(runId);
  validateNativeCodingEvidenceOptions(options);
  const { execution = {}, includeSummary = false, ...journal } = options,
    selected = { ...execution },
    bounds = { ...journal };
  let called = false,
    result: NativeCodingEvidenceManifest | undefined;
  const returned = reader.readCoherentSnapshot(() => {
    if (called) fail("A native evidence snapshot may be consumed only once");
    called = true;
    const run = reader.getRun(runId);
    if (run.id !== runId) fail("Native reader returned another Run");
    const trajectory = exportTrajectory(reader, {
        ...bounds,
        sessionId: run.sessionId,
        runId,
      }),
      original = createCodingEvidenceManifest(run, trajectory);
    const page = checkedPage(
      reader.listExecutionObservations(run.workspaceId, run.id, selected),
      run,
      selected,
    );
    const coding: CoherentCodingProjection = {
      ...original,
      providerAttempts: [...original.providerAttempts],
      outputs: [...original.outputs],
      coverage: {
        ...original.coverage,
        sourceClock: "coherent-primary-read-transaction",
        mutableRunStateMayBeNewerThanJournal: true,
      },
    };
    const items = [...page.items];
    const output = {
      schemaVersion: 1 as const,
      projection: "native-coding-evidence-manifest-v1" as const,
      coding,
      execution: {
        items,
        sourcePageSha256: hash(page),
        afterOrdinal: selected.afterOrdinal ?? 0,
        throughOrdinal: page.throughOrdinal,
        next: page.next,
        returnedRecords: items.length,
        omittedSelectedRecords: 0,
        sourceBytes: page.bytes,
        source: "bounded-native-execution-observation-page" as const,
        sourceCoverage: "past-authenticated-execution-boundaries-only" as const,
        currentWorkspaceFreshness: "not-scanned" as const,
        completeRunHistory: "not-established" as const,
      },
      budget: {
        authority: "original-run-config-only" as const,
        originalLimits: original.configuration.limits,
        originalBudgets: original.configuration.budgets,
        remaining: null,
        remainingReason:
          "native-budget-account-authority-not-available" as const,
        providerRetryAuthority: false as const,
      },
      summary: includeSummary ? summary(coding, items) : null,
      coverage: {
        snapshot: "coherent-primary-read-transaction" as const,
        records: "selected-bounded-pages-only" as const,
        omittedProviderAttempts: 0,
        omittedOutputs: 0,
        truncated: trajectory.coverage.truncated || page.next !== null,
        rawPromptResultAndFileBytes: "not-exported" as const,
        credentialReplayAndAttachments: "not-read" as const,
        providerEffects: "not-executed" as const,
        toolEffects: "not-executed" as const,
        taskSuccess: "not-established" as const,
        replayAuthority: false as const,
      },
      manifestSha256: "0".repeat(64),
    };
    const seal = () => {
      const { manifestSha256: _codingHash, ...codingBody } = coding;
      coding.manifestSha256 = hash(codingBody);
      output.execution.returnedRecords = items.length;
      output.execution.omittedSelectedRecords =
        page.items.length - items.length;
      output.summary = includeSummary ? summary(coding, items) : null;
      const { manifestSha256: _hash, ...body } = output;
      output.manifestSha256 = hash(body);
    };
    for (;;) {
      seal();
      if (
        Buffer.byteLength(JSON.stringify(output)) <=
        NATIVE_CODING_EVIDENCE_LIMITS.outputBytes
      )
        break;
      output.coverage.truncated = true;
      if (items.length) {
        items.pop();
        output.execution.next =
          items.at(-1)?.ordinal ?? selected.afterOrdinal ?? 0;
      } else if (coding.outputs.length) {
        coding.outputs.pop();
        output.coverage.omittedOutputs++;
      } else if (coding.providerAttempts.length) {
        coding.providerAttempts.pop();
        output.coverage.omittedProviderAttempts++;
      } else
        throw new EngineError(
          "NATIVE_CODING_EVIDENCE_LIMIT",
          "Whole native evidence identity and metadata exceed 64KiB",
        );
    }
    result = freeze(output);
    return result;
  });
  if (!called || returned !== result || types.isPromise(returned))
    fail("Native evidence requires one synchronous original snapshot result");
  return returned;
}
