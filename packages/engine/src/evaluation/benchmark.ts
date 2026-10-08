import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type {
  SessionHistoryPage,
  RunReceipt,
  Session,
  Workspace,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter, TurnRequest } from "../ports.js";
import { ScriptedProvider } from "../provider/scripted.js";
import { measureSummarySql } from "../storage/fixtures/summary-hotpath-benchmark.js";
import {
  cleanup,
  command,
  directoryBytes,
  distribution,
  failureCode,
  git,
  integer,
  jsonDigest,
  rounded,
  seeded,
} from "./runtime.js";

export interface BenchmarkOptions {
  runs: number;
  messageBytes: number;
  samples: number;
  warmup: number;
  seed: number;
}
interface Measurement {
  latency: ReturnType<typeof distribution>;
  resultBytes: { min: number; max: number };
  memory: {
    before: NodeJS.MemoryUsage;
    after: NodeJS.MemoryUsage;
    peakRssBytes: number;
    peakHeapUsedBytes: number;
    retainedHeapDeltaBytes: number;
    note: string;
  };
}
async function measure(
  options: BenchmarkOptions,
  operation: () => Promise<unknown> | unknown,
): Promise<Measurement> {
  for (let index = 0; index < options.warmup; index++) await operation();
  const before = process.memoryUsage(),
    durations: number[] = [],
    bytes: number[] = [];
  let peakRssBytes = before.rss,
    peakHeapUsedBytes = before.heapUsed;
  for (let index = 0; index < options.samples; index++) {
    const start = performance.now(),
      result = await operation();
    durations.push(performance.now() - start);
    bytes.push(Buffer.byteLength(JSON.stringify(result)));
    const current = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, current.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, current.heapUsed);
  }
  const after = process.memoryUsage();
  return {
    latency: distribution(durations),
    resultBytes: { min: Math.min(...bytes), max: Math.max(...bytes) },
    memory: {
      before,
      after,
      peakRssBytes,
      peakHeapUsedBytes,
      retainedHeapDeltaBytes: after.heapUsed - before.heapUsed,
      note: "sampled process memory; not allocator peak, leak proof or controlled-GC retained size",
    },
  };
}
export async function runEngineBenchmark(options: BenchmarkOptions) {
  integer(options.runs, 8, 1000);
  integer(options.messageBytes, 256, 2048);
  integer(options.samples, 3, 100);
  integer(options.warmup, 0, 10);
  integer(options.seed, 0, 0xffffffff);
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-engine-baseline-")),
    ),
    root = join(directory, "repository");
  const measurements: Record<string, Measurement> = {};
  const report: {
    passed: boolean;
    failure: string | null;
    scope: string;
    fixture: Record<string, unknown>;
    measurements: typeof measurements;
    summary: Record<string, unknown> | null;
    usage: unknown;
    cost: unknown;
    cleanup: Awaited<ReturnType<typeof cleanup>> | null;
    durationMs: number;
  } = {
    passed: false,
    failure: null,
    scope:
      "actual native Engine admission/Run/context/history/events/summary; no bulk fixture SQL; no model-quality/SLA/I/O claim",
    fixture: {},
    measurements,
    summary: null,
    usage: null,
    cost: {
      amount: null,
      currency: null,
      reason: "scripted local providers; no billing observation",
    },
    cleanup: null,
    durationMs: 0,
  };
  let engine: ReturnType<typeof createEngine> | undefined;
  const started = performance.now();
  try {
    await mkdir(root);
    git(root, "init", "--quiet", "--template=");
    await writeFile(
      join(root, "baseline.txt"),
      "Read-only native benchmark workspace.\n",
    );
    const random = seeded(options.seed),
      prompt =
        "x".repeat(options.messageBytes - 10) +
        String(Math.floor(random() * 1e9)).padStart(10, "0");
    const ordinary = new ScriptedProvider([
      {
        events: [
          { type: "text.delta", delta: "y".repeat(options.messageBytes) },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const summary = new ScriptedProvider([
      {
        events: [
          {
            type: "text.delta",
            delta:
              "Historical deterministic conversation preserved. No command, file or approval grant is inferred from this memory.",
          },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    let ordinaryRequestBytes = 0,
      summaryRequestBytes = 0;
    const provider: ProviderAdapter = {
      id: "scripted",
      streamTurn(request: TurnRequest, signal: AbortSignal) {
        if (request.tools.length === 0) {
          summaryRequestBytes += Buffer.byteLength(JSON.stringify(request));
          return summary.streamTurn(request, signal);
        }
        ordinaryRequestBytes += Buffer.byteLength(JSON.stringify(request));
        return ordinary.streamTurn(request, signal);
      },
    };
    const engineOptions = {
      dbPath: join(directory, "engine.sqlite"),
      artifactDir: join(directory, "artifacts"),
      providers: [provider],
      defaults: {
        providerId: "scripted",
        modelId: "local",
        mode: "plan" as const,
        limits: {
          maxDurationMs: 20_000,
          maxContextBytes: 2_097_152,
          maxOutputBytes: 65_536,
        },
        budgets: { maxSummaryBytes: 1_048_576 },
      },
      agentProfiles: [
        {
          id: "benchmark-text",
          description: "Native text benchmark",
          instructions: "Return the deterministic fixture text.",
          tools: ["read_file"],
        },
      ],
    };
    engine = createEngine(engineOptions);
    const active = engine;
    const workspace = await command<Workspace>(active, "workspace.open", {
        path: root,
      }),
      session = await command<Session>(active, "session.create", {
        workspaceId: workspace.id,
        title: "Native history benchmark",
      });
    const runIds: string[] = [],
      runDurations: number[] = [];
    async function submit(id: string) {
      const receipt = await command<RunReceipt>(active, "run.submit", {
        sessionId: session.id,
        requestId: id,
        prompt,
        config: { agentProfileId: "benchmark-text" },
      });
      const run = await active.waitForRun(receipt.runId);
      if (run.state !== "completed")
        throw new Error(run.error?.code ?? "BENCHMARK_RUN_FAILED");
      runIds.push(run.id);
      return { runId: run.id, state: run.state };
    }
    const seedStart = performance.now();
    for (let index = 0; index < options.runs; index++) {
      const start = performance.now();
      await submit(`history-${options.seed}-${index}`);
      runDurations.push(performance.now() - start);
    }
    assert.equal(summary.callCount, 0, "SEED_HISTORY_UNEXPECTED_SUMMARY");
    report.fixture = {
      seed: options.seed,
      inputRuns: options.runs,
      persistedMessages: options.runs * 2,
      messageUtf8Bytes: options.messageBytes,
      promptSha256: jsonDigest(prompt),
      seedElapsedMs: rounded(performance.now() - seedStart),
      seedRunLatency: distribution(runDurations),
      creation: "actual Engine run.submit/waitForRun; no direct SQL writes",
      dbAndArtifactLogicalBytes: await directoryBytes(directory),
    };
    measurements.history = await measure(options, async () => {
      const page = await command<SessionHistoryPage>(
        active,
        "session.getHistory",
        { sessionId: session.id, limit: 20 },
      );
      assert.deepEqual(
        page.snapshot.runs.map((run) => run.id),
        runIds.slice(-20),
      );
      assert.equal(
        page.snapshot.messages.length,
        Math.min(20, options.runs) * 2,
      );
      assert.equal(page.hasMore, options.runs > 20);
      return page;
    });
    // Every pagination cursor is consumed once; no duplicated or silently lost Run.
    let cursor: string | undefined;
    const pagedIds: string[] = [];
    for (let index = 0; index <= Math.ceil(options.runs / 20); index++) {
      const page = await command<SessionHistoryPage>(
        active,
        "session.getHistory",
        {
          sessionId: session.id,
          ...(cursor ? { beforeRunId: cursor } : {}),
          limit: 20,
        },
      );
      pagedIds.unshift(...page.snapshot.runs.map((run) => run.id));
      if (!page.hasMore) break;
      assert.ok(page.beforeRunId && page.beforeRunId !== cursor);
      cursor = page.beforeRunId!;
    }
    assert.deepEqual(pagedIds, runIds);
    report.fixture.historyPaginationExact = true;
    measurements.modelHistory = await measure(options, () => {
      const page = active.store.readModelHistory(session.id, 128, 2_097_152);
      assert.ok(page.snapshot.messages.length <= 128);
      assert.ok(page.snapshot.runs.every((run) => runIds.includes(run.id)));
      return page;
    });
    let contextCounter = 0;
    measurements.contextRun = await measure(options, async () => {
      await submit(`context-${options.seed}-${contextCounter++}`);
      const response = await command<Record<string, unknown>>(
        active,
        "session.getContext",
        { sessionId: session.id },
        true,
      );
      assert.ok(response?.revisionId);
      return response;
    });
    measurements.contextObservation = await measure(options, () =>
      command(active, "session.getContext", { sessionId: session.id }, true),
    );
    measurements.metrics = await measure(options, async () => {
      const result = await command<{
        metrics: {
          runs: { total: number };
          attemptUsage: { samples: number };
          summaryAttempts: { total: number };
        };
      }>(active, "session.getDiagnostics", { sessionId: session.id }, true);
      assert.equal(result.metrics.runs.total, runIds.length);
      assert.equal(result.metrics.attemptUsage.samples, 0);
      return result;
    });
    let afterSeq = 0,
      eventCount = 0;
    for (;;) {
      const page = active.store.readSessionEvents(session.id, afterSeq, 100);
      if (!page.length) break;
      assert.ok(page[0]!.seq > afterSeq);
      afterSeq = page.at(-1)!.seq;
      eventCount += page.length;
      assert.ok(eventCount <= 100_000, "BENCHMARK_EVENT_LIMIT");
    }
    const fence = afterSeq;
    assert.ok(fence > 0);
    measurements.eventReplay = await measure(options, async () => {
      const abort = new AbortController();
      let last = 0,
        count = 0,
        bytes = 0;
      try {
        for await (const event of active.subscribeSession(
          session.id,
          0,
          abort.signal,
        )) {
          assert.ok(event.seq > last);
          last = event.seq;
          count++;
          bytes += Buffer.byteLength(JSON.stringify(event));
          if (event.seq === fence) {
            abort.abort();
            break;
          }
          assert.ok(
            event.seq < fence && count <= eventCount,
            "BENCHMARK_EVENT_GAP",
          );
        }
      } finally {
        abort.abort();
      }
      assert.equal(last, fence);
      assert.equal(count, eventCount);
      return {
        count,
        throughSeq: last,
        eventJsonBytes: bytes,
        cursorGap: false,
        actualSubscriptionClosed: true,
      };
    });
    report.fixture.nativeEventsReplayedPerSample = eventCount;
    // A fixture model window forces the real owned completed-history summary
    // path. This is host metadata for a local provider, not a model capability claim.
    active.context.models.put({
      providerId: "scripted",
      modelId: "local",
      contextWindow: Math.max(1536, options.messageBytes * 4),
      maxOutputTokens: null,
      modalities: ["text"],
      inputFileTypes: [],
      tools: true,
      reasoning: false,
      nativeReplay: false,
      source: {
        kind: "fixture",
        observedAt: new Date().toISOString(),
        reference: "native-baseline-forced-summary-window-v1",
      },
    });
    const summaryStart = performance.now();
    await submit(`summary-${options.seed}`);
    const summaryDurationMs = performance.now() - summaryStart,
      attempts = active.listSummaryAttempts(session.id, { limit: 16 });
    assert.equal(attempts.attempts.length, 1, "BENCHMARK_SUMMARY_NOT_CONSUMED");
    const attempt = attempts.attempts[0]!;
    assert.equal(attempt.state, "completed");
    assert.equal(attempt.publication, "activated");
    assert.equal(attempt.cleanupConfirmed, true);
    assert.equal(summary.callCount, 1);
    const db = Reflect.get(active.store, "db") as DatabaseSync;
    const hotpath = measureSummarySql(db, () =>
      active.getSummaryUsage(session.id, attempt.id),
    );
    assert.equal(hotpath.measurement.summaryFullPayloadReads, 0);
    assert.equal(hotpath.result?.usage.inputTokens ?? null, null);
    assert.equal(hotpath.result?.usage.outputTokens ?? null, null);
    measurements.summaryUsage = await measure(options, () =>
      active.getSummaryUsage(session.id, attempt.id),
    );
    measurements.summaryAttempt = await measure(options, () =>
      active.getSummaryAttempt(session.id, attempt.id),
    );
    measurements.summaryList = await measure(options, () =>
      active.listSummaryAttempts(session.id, { limit: 16 }),
    );
    report.summary = {
      durationMs: rounded(summaryDurationMs),
      measuredActivations: 1,
      attemptId: attempt.id,
      state: attempt.state,
      publication: attempt.publication,
      cleanupConfirmed: attempt.cleanupConfirmed,
      requestBytes: attempt.requestBytes,
      sourceMessages: attempt.sourceMessageIds?.length ?? 0,
      observedOutputBytes: attempt.observedOutputBytes,
      retainedTextBytes: attempt.retainedTextBytes,
      fixtureContextWindowTokens: Math.max(1536, options.messageBytes * 4),
      readUsageSql: hotpath.measurement,
      sqlAccounting: "SQL values returned to JavaScript; not physical I/O",
      usage: hotpath.result?.usage ?? null,
    };
    measurements.storageInspection = await measure(options, () =>
      active.getStorageUsage(),
    );
    const metrics = await command<{
      metrics: {
        runs: { total: number };
        turns: { total: number };
        attempts: { total: number };
        summaryAttempts: { total: number };
        recovery: { uncertainAttempts: number; uncertainSummaries: number };
      };
    }>(active, "session.getDiagnostics", { sessionId: session.id }, true);
    assert.equal(metrics.metrics.runs.total, runIds.length);
    assert.equal(metrics.metrics.attempts.total, ordinary.callCount);
    assert.equal(metrics.metrics.summaryAttempts.total, 1);
    assert.equal(metrics.metrics.recovery.uncertainAttempts, 0);
    assert.equal(metrics.metrics.recovery.uncertainSummaries, 0);
    assert.equal(active.store.getSnapshot(session.id).tools.length, 0);
    assert.equal(active.store.listCheckpoints(runIds.at(-1)!).length, 0);
    assert.equal(active.integrityCheck().ok, true);
    report.usage = {
      inputTokens: null,
      outputTokens: null,
      billedTokens: null,
      reason: "actual scripted ordinary/summary streams emit no token events",
      ordinaryRequests: ordinary.callCount,
      summaryRequests: summary.callCount,
      ordinaryRequestJsonBytes: ordinaryRequestBytes,
      summaryRequestJsonBytes: summaryRequestBytes,
    };
    report.fixture.actualRuns = runIds.length;
    report.fixture.tools = 0;
    report.fixture.integrityOk = true;
    await active.close();
    const priorCalls = ordinary.callCount + summary.callCount;
    engine = createEngine(engineOptions);
    assert.equal(
      engine.store.getSnapshot(session.id).runs.length,
      runIds.length,
    );
    assert.equal(
      engine.getSummaryAttempt(session.id, attempt.id).state,
      "completed",
    );
    assert.equal(ordinary.callCount + summary.callCount, priorCalls);
    report.fixture.reopenedWithoutProviderReplay = true;
    report.passed = true;
  } catch (error) {
    report.failure = failureCode(error);
  } finally {
    report.cleanup = await cleanup(engine, directory);
    if (!report.cleanup.engineClosed || !report.cleanup.temporaryFilesRemoved) {
      report.passed = false;
      report.failure = report.cleanup.failure;
    }
    report.durationMs = rounded(performance.now() - started);
  }
  return report;
}
