import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type JsonObject,
  type RunReceipt,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import {
  createEngine,
  type EngineOptions,
  type MoodcodeEngine,
} from "../engine.js";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";

async function command<T>(
  engine: MoodcodeEngine,
  type: string,
  payload: JsonObject,
  native = false,
): Promise<T> {
  const envelope = {
    schemaVersion: native ? 2 : 1,
    commandId: randomUUID(),
    type,
    payload,
  };
  const result = native
    ? await engine.dispatchSession(envelope)
    : await engine.dispatch(envelope);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.result as unknown as T;
}
async function fixture(
  t: TestContext,
  provider: ProviderAdapter,
  overrides: Pick<EngineOptions, "allowedToolNames"> = {},
) {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-accounting-review-")),
    ),
    repository = join(directory, "repository");
  await mkdir(repository);
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(repository, "sample.txt"), "fixture observation\n");
  const dbPath = join(directory, "engine.sqlite"),
    options = {
      dbPath,
      artifactDir: join(directory, "artifacts"),
      providers: [provider],
      ...overrides,
    };
  let engine = createEngine(options);
  t.after(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = await command<Workspace>(engine, "workspace.open", {
      path: repository,
    }),
    session = await command<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
  const submit = (requestId: string, limits: JsonObject = {}) =>
    command<RunReceipt>(engine, "run.submit", {
      sessionId: session.id,
      requestId,
      prompt: "ROOT_GOAL: retain the original user constraint",
      config: {
        providerId: provider.id,
        modelId: "fixture",
        mode: "plan",
        limits: {
          ...DEFAULT_LIMITS,
          maxOutputBytes: 1_048_576,
          maxDurationMs: 30_000,
          ...limits,
        },
      },
    });
  return {
    directory,
    repository,
    dbPath,
    session,
    get engine() {
      return engine;
    },
    submit,
    async reopen() {
      await engine.close();
      engine = createEngine(options);
    },
  };
}
function completePairs(request: TurnRequest) {
  for (let index = 0; index < request.messages.length; index++) {
    const message = request.messages[index]!;
    if (!message.toolCalls?.length) continue;
    const results = request.messages.slice(
      index + 1,
      index + 1 + message.toolCalls.length,
    );
    assert.equal(results.length, message.toolCalls.length);
    assert.ok(results.every((result) => result.role === "tool"));
    assert.deepEqual(
      new Set(results.map((result) => result.toolCallId)),
      new Set(message.toolCalls.map((call) => call.id)),
    );
  }
}

test(
  "real long coding loop retains original/latest-steer anchors and recent call/result pairs with durable latest-per-attempt usage after restart",
  { timeout: 40_000 },
  async (t) => {
    let f!: Awaited<ReturnType<typeof fixture>>,
      calls = 0,
      sawWindow = false;
    const providerErrors: unknown[] = [];
    const queries: Array<{
      elapsedMs: number;
      snapshotJsonBytes: number;
      queryPayloadJsonBytes: number;
      physicalReadBytes: null;
    }> = [];
    const provider: ProviderAdapter = {
      id: "accounting-loop",
      async *streamTurn(request): AsyncGenerator<ProviderEvent> {
        calls++;
        try {
          assert.ok(request.turnId);
          assert.ok(request.attemptId);
          assert.ok(
            request.messages.some(
              (message) =>
                message.role === "user" &&
                message.content.includes("ROOT_GOAL"),
            ),
            "original user anchor must reach the actual provider",
          );
          if (request.turnIndex >= 6)
            assert.ok(
              request.messages.some(
                (message) =>
                  message.role === "user" &&
                  message.content ===
                    "LATEST_STEER: preserve the second user constraint",
              ),
            );
          completePairs(request);
          const diagnostics = f.engine.context.diagnostics(f.session.id);
          if (
            diagnostics?.activeWindow &&
            diagnostics.activeWindow.omittedMessages > 0
          ) {
            sawWindow = true;
            assert.equal(diagnostics.activeWindow.summarized, false);
            assert.ok(diagnostics.activeWindow.omittedMessages > 0);
            if (queries.length === 0)
              for (let sample = 0; sample < 3; sample++) {
                const start = performance.now(),
                  page = f.engine.store.readModelHistory(
                    f.session.id,
                    512,
                    524_288,
                  );
                queries.push({
                  elapsedMs: performance.now() - start,
                  snapshotJsonBytes: Buffer.byteLength(
                    JSON.stringify(page.snapshot),
                  ),
                  queryPayloadJsonBytes: Buffer.byteLength(
                    JSON.stringify(page),
                  ),
                  physicalReadBytes: null,
                });
              }
          }
          if (request.turnIndex === 4)
            await command(
              f.engine,
              "input.accept",
              {
                sessionId: f.session.id,
                requestId: "latest-steer",
                prompt: "LATEST_STEER: preserve the second user constraint",
                delivery: "steer",
                config: f.engine.store.getRun(request.runId)
                  .config as unknown as JsonObject,
              },
              true,
            );
          yield {
            type: "usage",
            inputTokens: 10 + request.turnIndex,
            outputTokens: 0,
          };
          if (request.turnIndex < 35)
            for (let index = 0; index < 16; index++)
              yield {
                type: "tool.call",
                call: {
                  id: `read-${request.turnIndex}-${index}`,
                  name: "read_file",
                  input: {
                    path: "sample.txt",
                    startLine: request.turnIndex * 16 + index + 1,
                    endLine: request.turnIndex * 16 + index + 1,
                  },
                },
              };
          else yield { type: "text.delta", delta: "Completed the fixture." };
          const usage = {
            type: "usage" as const,
            inputTokens: 20 + request.turnIndex,
            outputTokens: 2,
            cachedInputTokens: 5,
            reasoningOutputTokens: 1,
          };
          yield usage;
          yield { ...usage };
          yield {
            type: "finish",
            reason: request.turnIndex < 35 ? "tool_calls" : "stop",
            replayItems: [
              {
                type: "reasoning",
                encrypted_content: `opaque-${request.turnIndex}`,
              },
            ],
          };
          yield { type: "usage", outputTokens: 3, reasoningOutputTokens: 2 };
        } catch (error) {
          providerErrors.push(error);
          throw error;
        }
      },
    };
    f = await fixture(t, provider);
    await writeFile(
      join(f.repository, "sample.txt"),
      Array.from(
        { length: 560 },
        (_, index) => `fixture observation ${index}\n`,
      ).join(""),
    );
    const receipt = await f.submit("long-loop", {
      maxTurns: 40,
      maxToolCalls: 1024,
      maxContextBytes: 131_072,
    });
    const run = await f.engine.waitForRun(receipt.runId);
    if (providerErrors.length) throw providerErrors[0];
    assert.equal(
      run.state,
      "completed",
      JSON.stringify({ error: run.error, calls }),
    );
    assert.equal(calls, 36);
    assert.equal(sawWindow, true);
    assert.equal(queries.length, 3);
    t.diagnostic(
      JSON.stringify({
        scenario: "actual-long-coding-loop",
        samples: 3,
        queries,
        currentPrefixSummarized: false,
      }),
    );
    const original = f.engine.store.getSnapshot(f.session.id);
    assert.ok(original.messages.length > 512);
    assert.equal(original.tools.length, 560);
    assert.ok(original.tools.every((tool) => tool.state === "completed"));
    assert.equal(
      original.messages.filter(
        (message) => message.role === "assistant" && message.providerReplay,
      ).length,
      36,
    );
    const metrics = f.engine.store.getNativeMetrics(f.session.id),
      expectedInput = 36 * 20 + (35 * 36) / 2;
    assert.equal(metrics.attemptUsage.samples, 36);
    assert.equal(metrics.attemptUsage.inputTokens.tokens, expectedInput);
    assert.equal(metrics.attemptUsage.outputTokens.tokens, 108);
    assert.equal(metrics.attemptUsage.cachedInputTokens.tokens, 180);
    assert.equal(metrics.attemptUsage.reasoningOutputTokens.tokens, 72);
    assert.equal(
      metrics.providerUsage.inputTokens.tokens,
      36 * 50 + 3 * ((35 * 36) / 2),
    );
    assert.equal(metrics.providerUsage.outputTokens.tokens, 36 * 7);
    const turns = f.engine.store.listTurns(receipt.runId);
    assert.equal(turns.length, 36);
    const finalAttempt = f.engine.store
      .readSessionEvents(f.session.id, 0, 100)
      .find((event) => event.type === "provider.attempt.usage");
    assert.ok(finalAttempt);
    await f.reopen();
    assert.equal(calls, 36);
    assert.deepEqual(f.engine.store.getSnapshot(f.session.id), original);
    assert.deepEqual(
      f.engine.store.getNativeMetrics(f.session.id).attemptUsage,
      metrics.attemptUsage,
    );
  },
);

test(
  "actual no-steer coding loop keeps its initial constraint and newest whole exchange under a small context cap",
  { timeout: 20_000 },
  async (t) => {
    let f!: Awaited<ReturnType<typeof fixture>>;
    let calls = 0,
      providerOmissions = 0,
      databaseOmissions = 0;
    const errors: unknown[] = [];
    const provider: ProviderAdapter = {
      id: "small-current-context",
      async *streamTurn(request): AsyncGenerator<ProviderEvent> {
        calls++;
        try {
          assert.ok(
            request.messages.some(
              (message) =>
                message.role === "user" &&
                message.content.includes("ROOT_GOAL"),
            ),
          );
          completePairs(request);
          if (request.turnIndex > 0) {
            const previousIds = Array.from(
              { length: 4 },
              (_, index) => `bounded-${request.turnIndex - 1}-${index}`,
            );
            assert.deepEqual(
              new Set(
                request.messages
                  .filter(
                    (message) =>
                      message.role === "tool" &&
                      previousIds.includes(message.toolCallId ?? ""),
                  )
                  .map((message) => message.toolCallId),
              ),
              new Set(previousIds),
              "the latest four-call exchange must remain whole",
            );
          }
          const diagnostics = f.engine.context.diagnostics(f.session.id);
          assert.ok(diagnostics);
          assert.ok(diagnostics.plan.bytes <= 8192);
          assert.ok(
            Buffer.byteLength(JSON.stringify(request.messages)) +
              diagnostics.plan.reservations.envelopeBytes <=
              8192,
          );
          providerOmissions = Math.max(
            providerOmissions,
            diagnostics.plan.omittedMessageCount,
          );
          databaseOmissions = Math.max(
            databaseOmissions,
            diagnostics.omittedDatabaseMessages,
          );
          if (diagnostics.activeWindow)
            assert.equal(diagnostics.activeWindow.summarized, false);
          if (request.turnIndex < 23)
            for (let index = 0; index < 4; index++)
              yield {
                type: "tool.call",
                call: {
                  id: `bounded-${request.turnIndex}-${index}`,
                  name: "read_file",
                  input: {
                    path: "sample.txt",
                    startLine: request.turnIndex * 4 + index + 1,
                    endLine: request.turnIndex * 4 + index + 1,
                  },
                },
              };
          else yield { type: "text.delta", delta: "Done." };
          yield {
            type: "finish",
            reason: request.turnIndex < 23 ? "tool_calls" : "stop",
          };
        } catch (error) {
          errors.push(error);
          throw error;
        }
      },
    };
    f = await fixture(t, provider, { allowedToolNames: ["read_file"] });
    await writeFile(
      join(f.repository, "sample.txt"),
      Array.from(
        { length: 92 },
        () => "durable tool evidence: ".repeat(16) + "\n",
      ).join(""),
    );
    const receipt = await f.submit("small-no-steer", {
      maxTurns: 28,
      maxToolCalls: 128,
      maxContextBytes: 8192,
    });
    const run = await f.engine.waitForRun(receipt.runId);
    if (errors.length) throw errors[0];
    assert.equal(
      run.state,
      "completed",
      JSON.stringify({ error: run.error, calls }),
    );
    assert.equal(calls, 24);
    assert.ok(
      providerOmissions > 0,
      "provider projection must report its own omitted message count",
    );
    assert.ok(
      databaseOmissions > 0,
      "the SQL window must report its separate omitted source count",
    );
    const original = f.engine.store.getSnapshot(f.session.id);
    assert.equal(original.tools.length, 92);
    assert.ok(original.tools.every((tool) => tool.state === "completed"));
    assert.equal(
      original.messages.filter((message) => message.role === "tool").length,
      92,
    );
    assert.ok(
      original.messages
        .filter((message) => message.role === "tool")
        .every((message) => message.content.includes("durable tool evidence:")),
      JSON.stringify(
        original.messages
          .filter(
            (message) =>
              message.role === "tool" &&
              !message.content.includes("durable tool evidence:"),
          )
          .slice(0, 2),
      ),
    );
    assert.equal(
      f.engine.store.getSessionDocument(f.session.id, "context.memory"),
      null,
    );
    t.diagnostic(
      JSON.stringify({
        scenario: "actual-small-context-no-steer",
        providerCalls: calls,
        tools: 92,
        byteCap: 8192,
        providerOmissions,
        databaseOmissions,
        currentPrefixSummarized: false,
      }),
    );
    await f.reopen();
    assert.equal(calls, 24);
    assert.deepEqual(f.engine.store.getSnapshot(f.session.id), original);
  },
);

test("actual safe HTTP retry keeps missing usage unknown and accounts the successful durable attempt once", async (t) => {
  const requests: Array<{ turnId: string; attemptId: string }> = [];
  const provider: ProviderAdapter = {
    id: "retry-accounting",
    async *streamTurn(request): AsyncGenerator<ProviderEvent> {
      assert.ok(request.turnId && request.attemptId);
      requests.push({ turnId: request.turnId, attemptId: request.attemptId });
      if (requests.length === 1)
        throw new EngineError(
          "PROVIDER_HTTP_ERROR",
          "Fixture rejected before observations",
          { status: 429, retryAfterMs: 0 },
        );
      yield {
        type: "usage",
        inputTokens: 9,
        outputTokens: 2,
        cachedInputTokens: 4,
        reasoningOutputTokens: 1,
      };
      yield { type: "usage", inputTokens: 9, outputTokens: 2 };
      yield { type: "text.delta", delta: "Retry settled." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const f = await fixture(t, provider),
    receipt = await f.submit("safe-retry");
  assert.equal((await f.engine.waitForRun(receipt.runId)).state, "completed");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.turnId, requests[1]!.turnId);
  assert.notEqual(requests[0]!.attemptId, requests[1]!.attemptId);
  assert.equal(
    f.engine.store.getAttempt(requests[0]!.attemptId).state,
    "failed",
  );
  assert.equal(
    f.engine.store.getAttempt(requests[1]!.attemptId).state,
    "completed",
  );
  const metrics = f.engine.store.getNativeMetrics(f.session.id);
  assert.equal(metrics.attempts.total, 2);
  assert.equal(metrics.attempts.retries, 1);
  assert.equal(metrics.attemptUsage.attemptsWithoutUsage, 1);
  assert.equal(metrics.attemptUsage.attemptsWithUsage, 1);
  assert.equal(metrics.attemptUsage.inputTokens.tokens, 9);
  assert.equal(metrics.attemptUsage.outputTokens.tokens, 2);
  assert.equal(metrics.attemptUsage.cachedInputTokens.tokens, 4);
  assert.equal(metrics.attemptUsage.reasoningOutputTokens.tokens, 1);
  assert.equal(metrics.providerUsage.inputTokens.tokens, 18);
  assert.equal(
    f.engine.store
      .readSessionEvents(f.session.id, 0, 100)
      .filter((event) => event.type === "provider.attempt.usage").length,
    1,
  );
  await f.reopen();
  assert.equal(requests.length, 2);
  assert.deepEqual(
    f.engine.store.getNativeMetrics(f.session.id).attemptUsage,
    metrics.attemptUsage,
  );
});

for (const outcome of ["failure", "abort"] as const)
  test(`actual provider ${outcome} retains observed usage once and settles terminal attempt without automatic replay`, async (t) => {
    let release!: () => void;
    const observed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const provider: ProviderAdapter = {
      id: `accounting-${outcome}`,
      async *streamTurn(_request, signal): AsyncGenerator<ProviderEvent> {
        calls++;
        yield {
          type: "usage",
          inputTokens: 11,
          outputTokens: 2,
          cachedInputTokens: 3,
          reasoningOutputTokens: 1,
        };
        yield { type: "usage", inputTokens: 11, outputTokens: 2 };
        release();
        if (outcome === "failure")
          throw new EngineError(
            "PROVIDER_TRANSPORT_ERROR",
            "Fixture disconnected after an observation",
          );
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          if (signal.aborted) resolve();
        });
      },
    };
    const f = await fixture(t, provider),
      receipt = await f.submit(outcome);
    await observed;
    if (outcome === "abort")
      await command(f.engine, "run.cancel", { runId: receipt.runId });
    const run = await f.engine.waitForRun(receipt.runId);
    assert.equal(run.state, outcome === "abort" ? "cancelled" : "failed");
    assert.equal(calls, 1);
    const metrics = f.engine.store.getNativeMetrics(f.session.id);
    assert.equal(metrics.attemptUsage.samples, 1);
    assert.equal(metrics.attemptUsage.inputTokens.tokens, 11);
    assert.equal(metrics.providerUsage.inputTokens.tokens, 22);
    const attemptId = f.engine.store
      .readSessionEvents(f.session.id, 0, 100)
      .find((event) => event.type === "provider.attempt.usage")?.attemptId;
    assert.ok(attemptId);
    assert.equal(
      f.engine.store.getAttempt(attemptId).state,
      outcome === "failure" ? "uncertain" : "interrupted",
    );
    assert.equal(
      f.engine.store.putAttemptUsage(attemptId, { inputTokens: 11 }).revision,
      1,
    );
    assert.throws(
      () => f.engine.store.putAttemptUsage(attemptId, { inputTokens: 12 }),
      (error) =>
        error instanceof EngineError &&
        error.code === "ATTEMPT_USAGE_IMMUTABLE",
    );
    await f.reopen();
    assert.equal(calls, 1);
    assert.deepEqual(
      f.engine.store.getNativeMetrics(f.session.id).attemptUsage,
      metrics.attemptUsage,
    );
  });

for (const journal of ["native", "legacy"] as const)
  test(`actual ${journal} usage journal failure cannot turn partial observation into success or automatic provider retry`, async (t) => {
    let calls = 0;
    const provider: ProviderAdapter = {
      id: `usage-publication-${journal}`,
      async *streamTurn(): AsyncGenerator<ProviderEvent> {
        calls++;
        yield { type: "usage", inputTokens: 0, outputTokens: 0 };
        yield { type: "text.delta", delta: "must not be delivered" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const f = await fixture(t, provider),
      writer = new DatabaseSync(f.dbPath);
    t.after(() => writer.close());
    writer.exec(
      journal === "native"
        ? "CREATE TRIGGER reject_accounting BEFORE INSERT ON session_events WHEN NEW.type='provider.attempt.usage' BEGIN SELECT RAISE(ABORT,'native usage rejected'); END"
        : "CREATE TRIGGER reject_accounting BEFORE INSERT ON events WHEN NEW.type='run.usage' BEGIN SELECT RAISE(ABORT,'legacy usage rejected'); END",
    );
    const receipt = await f.submit(journal),
      run = await f.engine.waitForRun(receipt.runId);
    assert.equal(run.state, "failed");
    assert.equal(calls, 1);
    const turns = f.engine.store.listTurns(receipt.runId);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.state, "failed");
    const attemptId = f.engine.store
      .readSessionEvents(f.session.id, 0, 100)
      .find((event) => event.type === "provider.attempt.prepared")?.attemptId;
    assert.ok(attemptId);
    assert.equal(f.engine.store.getAttempt(attemptId).state, "failed");
    const metrics = f.engine.store.getNativeMetrics(f.session.id);
    assert.equal(metrics.attemptUsage.samples, journal === "native" ? 0 : 1);
    assert.equal(metrics.providerUsage.samples, 0);
    assert.equal(
      metrics.attemptUsage.inputTokens.tokens,
      journal === "native" ? null : 0,
    );
    assert.ok(
      f.engine.store
        .getSnapshot(f.session.id)
        .messages.every(
          (message) => !message.content.includes("must not be delivered"),
        ),
    );
    assert.equal(
      f.engine.store
        .readEvents(f.session.id, 0, 100)
        .filter((event) => event.type === "run.failed").length,
      1,
    );
  });
