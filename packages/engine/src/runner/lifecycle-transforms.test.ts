import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type JsonValue,
  type RunLimits,
} from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import type {
  ContextRequest,
  CoordinatorOptions,
  LifecycleContinuationCapture,
  ProviderAdapter,
  ProviderEvent,
  ToolDefinition,
  TurnRequest,
} from "../ports.js";
import { buildContext } from "../context/index.js";
import {
  LifecycleHookRegistry,
  type LifecycleHookRegistration,
} from "../lifecycle/index.js";
import { ApprovalManager } from "../permission/index.js";
import { SqliteStore } from "../storage/index.js";
import { ScopedToolRuntime } from "../tools/runtime/index.js";
import { openWorkspace } from "../workspace/index.js";
import { RunCoordinator } from "./index.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stop: ProviderEvent = { type: "finish", reason: "stop" };
const toolStop: ProviderEvent = { type: "finish", reason: "tool_calls" };
const call: ProviderEvent = {
  type: "tool.call",
  call: {
    id: "original-model-call",
    name: "transform_fixture",
    input: { value: "original-proposal" },
  },
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(
  t: TestContext,
  hooks: readonly LifecycleHookRegistration[],
  options: {
    approval?: boolean;
    continuation?: boolean;
    events?: readonly ProviderEvent[][];
    retry?: boolean;
    contextError?: EngineError;
  } = {},
) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-runner-transforms-")),
    ),
    root = join(base, "repo");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  const store = new SqliteStore(join(base, "engine.sqlite")),
    approvals = new ApprovalManager(store),
    registry = new LifecycleHookRegistry();
  for (const hook of hooks) registry.register(hook);
  const runtime = new ScopedToolRuntime(),
    preparedInputs: JsonValue[] = [],
    executedInputs: JsonValue[] = [],
    handles = new WeakSet<object>();
  const tool: ToolDefinition = {
    name: "transform_fixture",
    description: "Authored opaque prepared-input regression tool",
    effectClass: "state",
    inputSchema: { type: "object" },
    async prepare(input) {
      const value = structuredClone(input) as JsonValue;
      preparedInputs.push(value);
      const prepared = {
        name: "transform_fixture",
        input: value,
        fingerprint: hash(input),
        requiresApproval: options.approval ?? false,
        preview: { effective: structuredClone(value) },
      };
      handles.add(prepared);
      return prepared;
    },
    async execute(prepared) {
      assert.ok(
        handles.has(prepared),
        "Actual producer receives its original opaque handle",
      );
      executedInputs.push(structuredClone(prepared.input));
      return { content: "Tool completed without external effect." };
    },
  };
  let unregister = runtime.register("engine", tool, { effect: "state" });
  const requests: TurnRequest[] = [],
    contextRequests: ContextRequest[] = [];
  let providerCalls = 0,
    successfulCalls = 0,
    admitted = 0,
    freshCalls = 0,
    staleContinuation = false;
  const provider: ProviderAdapter = {
    id: "runner-transforms",
    async *streamTurn(request) {
      providerCalls++;
      requests.push(structuredClone(request));
      if (options.retry && providerCalls === 2)
        throw new EngineError("PROVIDER_HTTP_ERROR", "Retry fixture", {
          status: 429,
          retryAfterMs: 0,
        });
      const events =
        options.events?.[successfulCalls++] ??
        (providerCalls === 1 ? [call, toolStop] : [stop]);
      for (const event of events) yield structuredClone(event);
    },
  };
  const captures = new WeakSet<object>();
  const continuation: NonNullable<CoordinatorOptions["lifecycleContinuation"]> =
    {
      async capture(run, boundary) {
        assert.ok(boundary.turnId);
        const turn = store.getTurn(boundary.turnId);
        assert.equal(turn.state, "completed");
        assert.equal(turn.runId, run.id);
        return {
          verificationSha256: hash({
            runId: run.id,
            turnId: turn.id,
            completedAt: turn.completedAt,
          }),
        };
      },
      async admit(run, boundary, request) {
        admitted++;
        const receipt = await continuation.capture(
          run,
          boundary,
          new AbortController().signal,
        );
        assert.equal(request.verificationSha256, receipt!.verificationSha256);
        const capture: LifecycleContinuationCapture = Object.freeze({
          id: `original-host-capture-${admitted}`,
          verificationSha256: request.verificationSha256,
          message: {
            role: "user" as const,
            content:
              "[Moodcode lifecycle continuation v1]\n" +
              JSON.stringify(request.data),
          },
        });
        captures.add(capture);
        return capture;
      },
      async assertFresh(_run, capture) {
        freshCalls++;
        assert.ok(captures.has(capture));
        if (staleContinuation)
          throw new EngineError(
            "LIFECYCLE_CONTINUATION_STALE",
            "Original host capture became stale",
          );
      },
    };
  const runner = new RunCoordinator({
    store,
    approvals,
    providers: new Map([[provider.id, provider]]),
    tools: [tool],
    toolRuntime: runtime,
    lifecycleHooks: registry,
    artifactDir: join(base, "artifacts"),
    ...(options.continuation ? { lifecycleContinuation: continuation } : {}),
    async buildContext(request) {
      contextRequests.push(request);
      if (options.contextError) throw options.contextError;
      return buildContext(request);
    },
  });
  t.after(async () => {
    await runner.close();
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  const workspace = store.putWorkspace(await openWorkspace(root)),
    session = store.createSession({
      id: randomUUID(),
      workspaceId: workspace.id,
      title: "Original owner",
      createdAt: new Date().toISOString(),
    });
  const submit = (
    limits: Partial<RunLimits> = {},
    budgets:
      import("@moodcode/contracts").EngineBudgets | undefined = undefined,
  ) =>
    runner.submit({
      sessionId: session.id,
      requestId: randomUUID(),
      prompt: "Complete original requested work.",
      config: {
        providerId: provider.id,
        modelId: "fixture-model",
        mode: "build",
        limits: {
          ...DEFAULT_LIMITS,
          maxTurns: 4,
          maxDurationMs: 15000,
          ...limits,
        },
        ...(budgets ? { budgets } : {}),
      },
    });
  return {
    dbPath: join(base, "engine.sqlite"),
    store,
    approvals,
    registry,
    runtime,
    runner,
    workspace,
    session,
    submit,
    preparedInputs,
    executedInputs,
    requests,
    contextRequests,
    replaceTool() {
      unregister();
      unregister = runtime.register("engine", tool, { effect: "state" });
    },
    staleContinuation() {
      staleContinuation = true;
    },
    counts: () => ({ providerCalls, admitted, freshCalls }),
  };
}
function rewrite(
  id: string,
  value: string,
  order = 0,
): LifecycleHookRegistration {
  return {
    id,
    revision: 1,
    stages: ["tool-prepare"],
    order,
    callback(invocation) {
      assert.equal(invocation.stage, "tool-prepare");
      assert.equal(Object.hasOwn(invocation.metadata, "input"), false);
      if (invocation.stage !== "tool-prepare") return;
      return {
        kind: "rewrite-input",
        expectedInputSha256: invocation.metadata.inputSha256,
        input: { value },
      };
    },
  };
}
function continueOnce(): LifecycleHookRegistration {
  return {
    id: "one-host-continuation",
    revision: 1,
    stages: ["before-stop"],
    callback(invocation) {
      if (
        invocation.stage !== "before-stop" ||
        invocation.metadata.continuationsUsed ||
        !invocation.metadata.verificationSha256
      )
        return;
      return {
        kind: "continue",
        expectedVerificationSha256: invocation.metadata.verificationSha256,
        data: { instruction: "Check the remaining original task once." },
      };
    },
  };
}
async function pendingApproval(f: Fixture, runId: string) {
  const signal = AbortSignal.timeout(5000);
  for await (const event of f.store.subscribe(f.session.id, 0, signal))
    if (event.runId === runId && event.type === "approval.requested") {
      const approval = f.store
        .getSnapshot(f.session.id)
        .approvals.find(
          (row) => row.runId === runId && row.status === "pending",
        );
      assert.ok(approval);
      return approval;
    }
  throw new Error("Expected original native approval");
}

test("context cancellation before the first Turn uses durable cancelling then one terminal cancellation with no producer", async (t) => {
  const f = await fixture(t, [], {
    contextError: new EngineError(
      "RUN_CANCELLED",
      "Authored host context stop",
    ),
  });
  let cancelled = 0;
  f.runner.setSessionHooks({
    boundary: () => false,
    cancelled(run) {
      cancelled++;
      f.store.setSessionPaused(run.sessionId, true, "run_cancelled");
    },
    settled() {},
    workspaceIdle() {},
  });
  const receipt = f.submit();
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "cancelled");
  assert.equal(run.error, undefined);
  assert.deepEqual(f.store.listTurns(run.id), []);
  assert.equal(f.counts().providerCalls, 0);
  assert.deepEqual(f.preparedInputs, []);
  assert.deepEqual(f.executedInputs, []);
  const transitions = f.store
    .readEvents(f.session.id, 0, 100)
    .filter(
      (event) =>
        event.runId === run.id &&
        ["run.cancelling", "run.cancelled", "run.failed"].includes(event.type),
    );
  assert.deepEqual(
    transitions.map((event) => event.type),
    ["run.cancelling", "run.cancelled"],
  );
  assert.equal(cancelled, 1);
  assert.equal(f.store.getSessionControl(f.session.id).paused, true);
});

test("an already cancelling lifecycle stop invokes the standard session cancellation hook only once", async (t) => {
  const f = await fixture(t, [
    {
      id: "before-native-stop",
      revision: 1,
      stages: ["before-model"],
      callback: () => ({
        kind: "stop",
        code: "HOST_STOP",
        reason: "Authored original hook stop",
      }),
    },
  ]);
  let cancelled = 0;
  f.runner.setSessionHooks({
    boundary: () => false,
    cancelled(run) {
      cancelled++;
      f.store.setSessionPaused(run.sessionId, true, "run_cancelled");
    },
    settled() {},
    workspaceIdle() {},
  });
  const receipt = f.submit(),
    run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "cancelled");
  assert.equal(cancelled, 1);
  assert.equal(f.counts().providerCalls, 0);
});

test("a failed session cancellation pause preserves cleanup uncertainty instead of claiming a cancelled Run", async (t) => {
  const f = await fixture(t, [], {
    contextError: new EngineError(
      "RUN_CANCELLED",
      "Authored host context stop",
    ),
  });
  f.runner.setSessionHooks({
    boundary: () => false,
    cancelled() {
      throw new Error("Authored pause storage failure");
    },
    settled() {},
    workspaceIdle() {},
  });
  const receipt = f.submit(),
    run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "failed");
  assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
  assert.equal(f.counts().providerCalls, 0);
  assert.deepEqual(f.store.listTurns(run.id), []);
});

test("ordered input rewrites prepare and execute one opaque final handle while original native proposal stays unchanged", async (t) => {
  const f = await fixture(t, [
      rewrite("first", "first-host-value"),
      rewrite("second", "final-host-value", 1),
    ]),
    receipt = f.submit();
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.deepEqual(f.preparedInputs, [{ value: "final-host-value" }]);
  assert.deepEqual(f.executedInputs, f.preparedInputs);
  const original = f.store.getSnapshot(f.session.id).tools[0]!;
  assert.deepEqual(original.input, { value: "original-proposal" });
  const requested = f.store
    .readEvents(f.session.id, 0, 1024)
    .find((event) => event.type === "tool.requested")!;
  assert.equal(requested.payload.providerToolCallId, "original-model-call");
  assert.equal(requested.payload.name, "transform_fixture");
  const trace = f.store
    .readEvents(f.session.id, 0, 1024)
    .find(
      (event) =>
        event.type === "lifecycle.outcome" &&
        event.payload.stage === "tool-prepare",
    )!;
  assert.equal(
    trace.payload.originalInputSha256,
    hash({ value: "original-proposal" }),
  );
  assert.equal(
    trace.payload.effectiveInputSha256,
    hash({ value: "final-host-value" }),
  );
  assert.equal(
    JSON.stringify(trace.payload).includes("final-host-value"),
    false,
  );
  assert.ok(
    f.contextRequests.every(
      (request) => request.lifecycleCapture?.identity.runId === run.id,
    ),
  );
});

test("approval fingerprint and preview bind the single effective prepared input exactly", async (t) => {
  const f = await fixture(
      t,
      [rewrite("approved-rewrite", "approved-host-value")],
      { approval: true },
    ),
    receipt = f.submit();
  const approval = await pendingApproval(f, receipt.runId);
  assert.deepEqual(approval.preview.effective, {
    value: "approved-host-value",
  });
  assert.equal(f.preparedInputs.length, 1);
  assert.equal(f.executedInputs.length, 0);
  f.approvals.decide(approval.id, "allow", approval.fingerprint);
  assert.equal((await f.runner.waitForRun(receipt.runId)).state, "completed");
  assert.deepEqual(f.executedInputs, [{ value: "approved-host-value" }]);
});

for (const action of [
  "deny",
  "cancel",
  "registry-change",
  "catalogue-change",
] as const)
  test(`${action} before sole prepare yields no prepared producer or effect`, async (t) => {
    let f!: Fixture;
    const hook: LifecycleHookRegistration = {
      id: `prepare-${action}`,
      revision: 1,
      stages: ["tool-prepare"],
      callback(invocation) {
        if (action === "deny")
          return {
            kind: "deny",
            code: "HOST_DENIED",
            reason: "The exact host preparation was denied.",
          };
        if (action === "cancel") f.runner.cancel(invocation.identity.runId);
        if (action === "registry-change")
          f.registry.register({
            id: "new-generation",
            revision: 1,
            stages: ["after-model"],
            callback() {},
          });
        if (action === "catalogue-change") f.replaceTool();
        return { kind: "observe" };
      },
    };
    f = await fixture(t, [hook]);
    const receipt = f.submit();
    await f.runner.waitForRun(receipt.runId);
    assert.equal(f.preparedInputs.length, 0);
    assert.equal(f.executedInputs.length, 0);
    assert.equal(f.store.getSnapshot(f.session.id).approvals.length, 0);
    if (action === "deny")
      assert.equal(f.store.getSnapshot(f.session.id).tools[0]!.state, "denied");
  });

test("registration change during exact approval never executes the captured transformed handle", async (t) => {
  const f = await fixture(
      t,
      [rewrite("approval-capture", "frozen-approved-value")],
      { approval: true },
    ),
    receipt = f.submit(),
    approval = await pendingApproval(f, receipt.runId);
  f.registry.register({
    id: "later-hook",
    revision: 1,
    stages: ["before-model"],
    callback() {},
  });
  f.approvals.decide(approval.id, "allow", approval.fingerprint);
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "failed");
  assert.equal(run.error?.code, "LIFECYCLE_REGISTRY_STALE");
  assert.equal(f.preparedInputs.length, 1);
  assert.equal(f.executedInputs.length, 0);
});

test("one trusted continuation rebuilds the same Run context and preserves native Turn budget", async (t) => {
  const f = await fixture(t, [continueOnce()], {
      continuation: true,
      events: [[stop], [stop]],
    }),
    receipt = f.submit();
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(f.counts().providerCalls, 2);
  assert.equal(f.counts().admitted, 1);
  assert.ok(f.counts().freshCalls >= 2);
  assert.equal(new Set(f.requests.map((request) => request.runId)).size, 1);
  assert.deepEqual(
    f.requests.map((request) => request.turnIndex),
    [0, 1],
  );
  assert.equal(f.store.getSnapshot(f.session.id).runs.length, 1);
  assert.equal(
    f.requests[1]!.messages.filter((message) =>
      message.content.includes("[Moodcode lifecycle continuation v1]"),
    ).length,
    1,
  );
  assert.equal(f.contextRequests[1]!.turnIndex, 1);
  assert.equal(
    f.contextRequests[0]!.lifecycleCapture,
    f.contextRequests[1]!.lifecycleCapture,
  );
});

test("generic continuation freshness is rechecked before every retry without rewriting frozen messages", async (t) => {
  const f = await fixture(t, [continueOnce()], {
      continuation: true,
      retry: true,
      events: [[stop], [stop]],
    }),
    receipt = f.submit();
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(f.counts().providerCalls, 3);
  assert.equal(f.counts().admitted, 1);
  assert.ok(f.counts().freshCalls >= 3);
  assert.deepEqual(f.requests[1]!.messages, f.requests[2]!.messages);
  assert.equal(f.requests[1]!.turnId, f.requests[2]!.turnId);
});

test("original turn exhaustion rejects continuation before host admission or extra native provider dispatch", async (t) => {
  const f = await fixture(t, [continueOnce()], {
      continuation: true,
      events: [[stop]],
    }),
    receipt = f.submit({ maxTurns: 1 });
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "failed");
  assert.equal(run.error?.code, "TURN_LIMIT");
  assert.equal(f.counts().admitted, 0);
  assert.equal(f.counts().providerCalls, 1);
});

test("a continuation becoming stale in before-model rejects extra attempt with native not-dispatched cleanup", async (t) => {
  let f!: Fixture;
  const hook: LifecycleHookRegistration = {
    id: "stale-at-next-model",
    revision: 1,
    stages: ["before-model"],
    callback(invocation) {
      if (
        invocation.stage === "before-model" &&
        invocation.metadata.turnIndex === 1
      )
        f.staleContinuation();
    },
  };
  f = await fixture(t, [continueOnce(), hook], {
    continuation: true,
    events: [[stop], [stop]],
  });
  const receipt = f.submit();
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "failed");
  assert.equal(run.error?.code, "LIFECYCLE_CONTINUATION_STALE");
  assert.equal(f.counts().providerCalls, 1);
  assert.equal(f.counts().admitted, 1);
  const turns = f.store.listTurns(run.id);
  assert.equal(turns.length, 2);
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    const attempts = db
      .prepare("SELECT id FROM provider_attempts WHERE turn_id=?")
      .all(turns[1]!.id);
    assert.equal(attempts.length, 1);
    assert.equal(
      f.store.getAttemptCleanup(String(attempts[0]!.id)).state,
      "not-dispatched",
    );
  } finally {
    db.close();
  }
});

test("original input allowance exhaustion rejects continuation before admitting a new host capture", async (t) => {
  const f = await fixture(t, [continueOnce()], {
    continuation: true,
    events: [[stop]],
  });
  const receipt = f.submit({}, normalizeEngineBudgets({ turnAllowance: 1 }));
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "failed");
  assert.equal(run.error?.code, "TURN_ALLOWANCE");
  assert.equal(f.counts().admitted, 0);
  assert.equal(f.counts().providerCalls, 1);
});

test("original output exhaustion rejects continuation without extra provider dispatch or budget reset", async (t) => {
  const f = await fixture(t, [continueOnce()], {
      continuation: true,
      events: [[{ type: "text.delta", delta: "x".repeat(32) }, stop]],
    }),
    receipt = f.submit({ maxOutputBytes: 32 });
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "failed");
  assert.equal(run.error?.code, "OUTPUT_LIMIT");
  assert.equal(f.counts().admitted, 0);
  assert.equal(f.counts().providerCalls, 1);
});

test("a repeated continuation request has a typed limit failure and cannot admit or dispatch a third turn", async (t) => {
  const always: LifecycleHookRegistration = {
    id: "always-continue",
    revision: 1,
    stages: ["before-stop"],
    callback(invocation) {
      if (
        invocation.stage !== "before-stop" ||
        !invocation.metadata.verificationSha256
      )
        return;
      return {
        kind: "continue",
        expectedVerificationSha256: invocation.metadata.verificationSha256,
        data: { goal: "No fresh Run budget is granted." },
      };
    },
  };
  const f = await fixture(t, [always], {
      continuation: true,
      events: [[stop], [stop], [stop]],
    }),
    receipt = f.submit();
  const run = await f.runner.waitForRun(receipt.runId);
  assert.equal(run.state, "cancelled");
  assert.equal(run.error, undefined);
  assert.equal(f.counts().providerCalls, 2);
  assert.equal(f.counts().admitted, 1);
  const outcomes = f.store
    .readEvents(f.session.id, 0, 1024)
    .filter(
      (event) =>
        event.type === "lifecycle.outcome" &&
        event.payload.stage === "before-stop",
    );
  assert.equal(outcomes.length, 2);
  assert.ok(
    (outcomes[1]!.payload.outcomes as { code?: string }[]).some(
      (outcome) => outcome.code === "LIFECYCLE_TRANSFORM_LIMIT",
    ),
  );
  assert.notEqual(
    outcomes[0]!.payload.invocationId,
    outcomes[1]!.payload.invocationId,
  );
});
