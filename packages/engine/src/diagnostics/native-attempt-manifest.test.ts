import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import type { ProviderEvent, ToolDefinition } from "../ports.js";
import {
  NATIVE_CODING_EVIDENCE_LIMITS,
  readNativeCodingEvidence,
  type NativeCodingEvidenceManifest,
  type NativeCodingEvidenceOptions,
  type NativeCodingEvidenceReader,
} from "./native-attempt-manifest.js";
import {
  ORIGINAL,
  observationFixture,
  stop,
} from "./fixtures/execution-observation.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function assertSealed(value: NativeCodingEvidenceManifest): void {
  const { manifestSha256, ...body } = value;
  const { manifestSha256: nestedHash, ...coding } = value.coding;
  assert.equal(manifestSha256, digest(body));
  assert.equal(nestedHash, digest(coding));
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.coding.providerAttempts), true);
  assert.equal(Object.isFrozen(value.execution.items), true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(value)) <=
      NATIVE_CODING_EVIDENCE_LIMITS.outputBytes,
  );
}
async function* readOnce(request: {
  turnIndex: number;
}): AsyncGenerator<ProviderEvent> {
  if (request.turnIndex === 0) {
    yield {
      type: "tool.call",
      call: {
        id: "manifest-read",
        name: "read_file",
        input: { path: "source.ts" },
      },
    };
    yield { type: "finish", reason: "tool_calls" };
  } else {
    yield { type: "text.delta", delta: "private-manifest-completion" };
    yield stop;
  }
}

test("actual Engine evidence consumes original Run and native source/effect records through the same bounded read transaction", async (t) => {
  const f = await observationFixture(t, { script: readOnce });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  const originalRead = f.engine.store.readExecutionObservationEvidence.bind(
    f.engine.store,
  );
  const originalSnapshot = f.engine.store.getSnapshot,
    originalRecovery = f.engine.store.recoverInterrupted;
  let reads = 0,
    forbidden = 0;
  f.engine.store.readExecutionObservationEvidence = (operation) => {
    reads++;
    return originalRead(operation);
  };
  f.engine.store.getSnapshot = () => {
    forbidden++;
    throw new Error("Full session reads are forbidden");
  };
  f.engine.store.recoverInterrupted = () => {
    forbidden++;
    throw new Error("Recovery admission is forbidden");
  };
  try {
    const beforeRequests = f.requests.length,
      beforeEpoch = f.epoch();
    const value = f.engine.getCodingEvidence(run.id, {
      limit: 100,
      maxBytes: 262144,
      execution: { limit: 100 },
    });
    assertSealed(value);
    assert.equal(reads, 1);
    assert.equal(forbidden, 0);
    assert.equal(value.coding.codingRunId, run.id);
    assert.equal(value.coding.sessionId, f.session.id);
    assert.equal(value.coding.workspaceId, f.workspace.id);
    assert.equal(value.coding.runObservation.state, "completed");
    assert.equal(
      value.coding.coverage.sourceClock,
      "coherent-primary-read-transaction",
    );
    assert.equal(
      value.coding.coverage.mutableRunStateMayBeNewerThanJournal,
      true,
    );
    assert.equal(value.coding.source.kind, "not-observed");
    assert.equal(value.coding.source.filesystemVerified, false);
    assert.deepEqual(
      value.execution.items,
      f.page(run.id, { limit: 100 }).items,
    );
    assert.equal(value.execution.items[0]!.sourceBefore.completeness, "full");
    assert.equal(
      value.execution.items[0]!.sourceAfter?.sha256,
      value.execution.items[0]!.sourceBefore.sha256,
    );
    assert.equal(value.execution.items[0]!.effectEpochDispatch, 0);
    assert.equal(value.execution.currentWorkspaceFreshness, "not-scanned");
    assert.equal(value.execution.completeRunHistory, "not-established");
    assert.equal(value.budget.remaining, null);
    assert.equal(
      value.budget.remainingReason,
      "native-budget-account-authority-not-available",
    );
    assert.deepEqual(value.budget.originalLimits, run.config.limits);
    assert.deepEqual(value.budget.originalBudgets, run.config.budgets);
    assert.equal(value.budget.providerRetryAuthority, false);
    assert.equal(value.summary, null);
    assert.equal(value.coverage.taskSuccess, "not-established");
    assert.equal(value.coverage.replayAuthority, false);
    assert.equal(f.requests.length, beforeRequests);
    assert.equal(f.epoch(), beforeEpoch);
    for (const secret of [
      ORIGINAL.trim(),
      "private-diagnostic-prompt",
      "private-manifest-completion",
    ])
      assert.ok(!JSON.stringify(value).includes(secret));
  } finally {
    f.engine.store.getSnapshot = originalSnapshot;
    f.engine.store.recoverInterrupted = originalRecovery;
  }
});

test("actual failed provider keeps partial output and distinguishes unknown usage from measured zero without redispatch", async (t) => {
  const f = await observationFixture(t, {
    script: async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: "text.delta", delta: "private-partial-output" };
      yield { type: "usage", inputTokens: 0 };
      throw new EngineError(
        "MANIFEST_PROVIDER_FAILED",
        "private-failure-details",
      );
    },
  });
  const submitted = await f.submit({ budgets: { maxProviderAttempts: 1 } });
  const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "failed");
  assert.equal(f.requests.length, 1);
  const before = f.engine.store.readSessionEvents(f.session.id, 0, 100);
  const value = f.engine.getCodingEvidence(run.id, {
    limit: 100,
    maxBytes: 262144,
    includeSummary: true,
  });
  assertSealed(value);
  assert.equal(value.coding.runObservation.state, "failed");
  assert.equal(
    value.coding.runObservation.errorCode,
    "MANIFEST_PROVIDER_FAILED",
  );
  assert.ok(
    value.coding.outputs.some(
      (output) =>
        output.partial &&
        output.sha256 ===
          createHash("sha256").update("private-partial-output").digest("hex"),
    ),
  );
  const attempt = value.coding.providerAttempts.find(
    (item) => item.usage !== null,
  )!;
  assert.ok(attempt);
  assert.equal(attempt.state, "failed");
  assert.equal(attempt.usage!.inputTokens, 0);
  assert.equal(attempt.usage!.outputTokens, null);
  assert.equal(attempt.usage!.cachedInputTokens, null);
  assert.equal(attempt.usage!.reasoningOutputTokens, null);
  assert.equal(value.coding.outcome.billedTokens, null);
  assert.equal(value.budget.remaining, null);
  assert.equal(value.summary!.runState, "failed");
  assert.ok(value.summary!.partialOutputs >= 1);
  assert.equal(value.summary!.providerCalls, 0);
  assert.equal(value.summary!.toolCalls, 0);
  assert.equal(value.summary!.generatedTokens, 0);
  assert.equal(value.summary!.externalGeneration, "not-implemented");
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    f.engine.store.readSessionEvents(f.session.id, 0, 100),
    before,
  );
  for (const secret of [
    "private-partial-output",
    "private-failure-details",
    "private-diagnostic-prompt",
  ])
    assert.ok(!JSON.stringify(value).includes(secret));
});

test("an old bounded journal page retains the current Run observation without claiming the selected journal covers that observation", async (t) => {
  const f = await observationFixture(t, { script: readOnce });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  const event = f.engine.store.readSessionEvents(f.session.id, 0, 1)[0]!;
  const value = f.engine.getCodingEvidence(run.id, {
    throughSeq: event.seq,
    limit: 1,
  });
  assertSealed(value);
  assert.equal(value.coding.runObservation.state, "completed");
  assert.equal(value.coding.journal.throughSeq, event.seq);
  assert.equal(value.coding.journal.sessionFrontier, "unknown");
  assert.equal(
    value.coding.coverage.mutableRunStateMayBeNewerThanJournal,
    true,
  );
  assert.equal(value.coding.providerAttempts.length, 0);
  assert.equal(value.budget.remaining, null);
});

test("extractive summary is explicit opt-in metadata and retains unknown custom source without granting task or retry authority", async (t) => {
  let producers = 0;
  const custom: ToolDefinition = {
    name: "manifest_custom_read",
    effectClass: "read",
    description: "Host owned fixture",
    inputSchema: { type: "object" },
    async prepare(input, context) {
      return {
        name: this.name,
        input: input as {},
        fingerprint: context.toolCallId,
        requiresApproval: false,
        preview: {},
      };
    },
    async execute() {
      producers++;
      return {
        content: "private-custom-result",
        data: {
          taskSuccess: true,
          sourceBefore: { completeness: "full", sha256: "f".repeat(64) },
        },
      };
    },
  };
  const f = await observationFixture(t, {
    extra: { tools: [custom] },
    script: async function* (request): AsyncGenerator<ProviderEvent> {
      if (request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: { id: "custom-metadata", name: custom.name, input: {} },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield stop;
    },
  });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  assert.equal(producers, 1);
  const before = f.requests.length;
  assert.equal(f.engine.getCodingEvidence(run.id).summary, null);
  const value = f.engine.getCodingEvidence(run.id, { includeSummary: true });
  assertSealed(value);
  assert.equal(value.summary!.implementation, "deterministic-metadata-only");
  assert.equal(value.summary!.unknownSources, 1);
  assert.equal(value.execution.items[0]!.sourceBefore.completeness, "unknown");
  assert.equal(value.execution.items[0]!.sourceBefore.sha256, null);
  assert.equal(value.summary!.taskSuccess, "not-established");
  assert.equal(
    value.summary!.providerCalls +
      value.summary!.toolCalls +
      value.summary!.generatedTokens,
    0,
  );
  assert.equal(value.budget.providerRetryAuthority, false);
  assert.equal(producers, 1);
  assert.equal(f.requests.length, before);
  assert.ok(!JSON.stringify(value).includes("private-custom-result"));
});

test("actual native observation page bounds freeze their frontier and advance only across returned records", async (t) => {
  const f = await observationFixture(t, {
    script: async function* (request): AsyncGenerator<ProviderEvent> {
      if (request.turnIndex < 3) {
        yield {
          type: "tool.call",
          call: {
            id: `window-${request.turnIndex}`,
            name: "read_file",
            input: { path: "source.ts", startLine: request.turnIndex + 1 },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield stop;
    },
  });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  const all = f.page(run.id).items;
  assert.equal(all.length, 3);
  const first = f.engine.getCodingEvidence(run.id, { execution: { limit: 1 } });
  assertSealed(first);
  assert.deepEqual(
    first.execution.items.map((row) => row.ordinal),
    [all[0]!.ordinal],
  );
  assert.equal(first.execution.throughOrdinal, all[2]!.ordinal);
  assert.equal(first.execution.next, all[0]!.ordinal);
  assert.equal(first.coverage.truncated, true);
  const next = f.engine.getCodingEvidence(run.id, {
    execution: {
      afterOrdinal: first.execution.next!,
      throughOrdinal: first.execution.throughOrdinal,
      limit: 1,
    },
  });
  assertSealed(next);
  assert.deepEqual(
    next.execution.items.map((row) => row.ordinal),
    [all[1]!.ordinal],
  );
  assert.equal(next.execution.next, all[1]!.ordinal);
});

test("actual oversized native page is reduced only at whole-record boundaries with accurate cursors and resealed coding hash", async (t) => {
  let producers = 0;
  const custom: ToolDefinition = {
    name: "bounded_manifest_read",
    effectClass: "read",
    description: "Actual bounded fixture",
    inputSchema: { type: "object" },
    async prepare(input, context) {
      return {
        name: this.name,
        input: input as {},
        fingerprint: context.toolCallId,
        requiresApproval: false,
        preview: {},
      };
    },
    async execute() {
      producers++;
      return { content: "actual bounded metadata result" };
    },
  };
  const f = await observationFixture(t, {
    extra: { tools: [custom] },
    script: async function* (request): AsyncGenerator<ProviderEvent> {
      if (request.turnIndex === 0) {
        for (let i = 0; i < 60; i++)
          yield {
            type: "tool.call",
            call: {
              id: `bounded-manifest-${i}`,
              name: custom.name,
              input: { ordinal: i },
            },
          };
        yield { type: "finish", reason: "tool_calls" };
      } else yield stop;
    },
  });
  const submitted = await f.submit({
    limits: { maxToolCalls: 64 },
    budgets: { maxToolCallsPerTurn: 64 },
  });
  const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(producers, 60);
  const originalPage = f.page(run.id, { limit: 100 });
  assert.equal(originalPage.items.length, 60);
  assert.ok(
    Buffer.byteLength(JSON.stringify(originalPage.items)) >
      NATIVE_CODING_EVIDENCE_LIMITS.outputBytes,
  );
  const value = f.engine.getCodingEvidence(run.id, {
    limit: 100,
    maxBytes: 262144,
    execution: { limit: 100 },
    includeSummary: true,
  });
  assertSealed(value);
  assert.equal(value.execution.sourcePageSha256, digest(originalPage));
  assert.equal(value.execution.throughOrdinal, originalPage.throughOrdinal);
  assert.ok(
    value.execution.items.length > 0 && value.execution.items.length < 60,
  );
  assert.equal(
    value.execution.omittedSelectedRecords,
    60 - value.execution.items.length,
  );
  assert.equal(value.execution.returnedRecords, value.execution.items.length);
  assert.equal(value.execution.next, value.execution.items.at(-1)!.ordinal);
  assert.deepEqual(
    value.execution.items,
    originalPage.items.slice(0, value.execution.items.length),
  );
  assert.equal(value.coverage.truncated, true);
  assert.equal(value.summary!.unknownSources, value.execution.items.length);
  assert.equal(producers, 60);
  assert.equal(f.requests.length, 2);
});

test("native evidence default-off observations remain explicitly absent through actual close and restart", async (t) => {
  const f = await observationFixture(t, { enabled: false, script: readOnce });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  const first = f.engine.getCodingEvidence(run.id, { includeSummary: true });
  assert.equal(first.execution.items.length, 0);
  assert.equal(first.summary!.unknownSources, 0);
  assert.equal(first.execution.completeRunHistory, "not-established");
  await f.engine.close();
  assert.throws(
    () => f.engine.getCodingEvidence(run.id),
    (error) => error instanceof EngineError && error.code === "ENGINE_CLOSED",
  );
  const reopened = f.reopen();
  const second = reopened.getCodingEvidence(run.id, { includeSummary: true });
  assertSealed(second);
  assert.equal(second.manifestSha256, first.manifestSha256);
  assert.equal(f.requests.length, 2);
});

test("exact options reject caller source, executable getters, proxies and invalid native bounds before any reader or trap", () => {
  let reads = 0,
    traps = 0;
  const reader = new Proxy(
    {},
    {
      get() {
        reads++;
        throw new Error("No reader access permitted");
      },
    },
  ) as NativeCodingEvidenceReader;
  const getter = Object.defineProperty({}, "includeSummary", {
    enumerable: true,
    get() {
      traps++;
      return true;
    },
  });
  const nestedGetter = {
    execution: Object.defineProperty({}, "limit", {
      enumerable: true,
      get() {
        traps++;
        return 1;
      },
    }),
  };
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps++;
        return Object.prototype;
      },
      ownKeys() {
        traps++;
        return [];
      },
      get() {
        traps++;
        return undefined;
      },
    },
  );
  const cases: unknown[] = [
    getter,
    nestedGetter,
    proxy,
    { execution: proxy },
    { source: { sha256: "f".repeat(64), revision: "asserted" } },
    { runId: "foreign" },
    { sessionId: "foreign" },
    { includeSummary: "true" },
    { includeSummary: 1 },
    { execution: { limit: 101 } },
    { execution: { limit: 0 } },
    { execution: { maxBytes: 255 } },
    { execution: { maxBytes: 1048577 } },
    { execution: { afterOrdinal: -1 } },
    { execution: { afterOrdinal: 2, throughOrdinal: 1 } },
    { execution: { before: 1 } },
    { [Symbol("opaque")]: true },
    [],
    null,
    { limit: NaN },
  ];
  for (const value of cases)
    assert.throws(
      () =>
        readNativeCodingEvidence(
          reader,
          "real-run",
          value as NativeCodingEvidenceOptions,
        ),
      EngineError,
    );
  assert.throws(() => readNativeCodingEvidence(reader, ""), EngineError);
  assert.equal(reads, 0);
  assert.equal(traps, 0);
});

test("actual Engine rejects forged source and hostile option metadata before entering its primary snapshot", async (t) => {
  const f = await observationFixture(t, { script: readOnce });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  const read = f.engine.store.readExecutionObservationEvidence.bind(
    f.engine.store,
  );
  let snapshots = 0,
    getters = 0;
  f.engine.store.readExecutionObservationEvidence = (operation) => {
    snapshots++;
    return read(operation);
  };
  const input = Object.defineProperty({}, "execution", {
    enumerable: true,
    get() {
      getters++;
      return {};
    },
  });
  assert.throws(() => f.engine.getCodingEvidence(run.id, input), EngineError);
  assert.throws(
    () =>
      f.engine.getCodingEvidence(run.id, {
        source: { sha256: "f".repeat(64), revision: "forged" },
      } as NativeCodingEvidenceOptions),
    EngineError,
  );
  assert.equal(snapshots, 0);
  assert.equal(getters, 0);
  assert.equal(f.requests.length, 2);
});
