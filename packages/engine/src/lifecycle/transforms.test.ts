import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { JsonObject, JsonValue } from "@moodcode/contracts";
import {
  LifecycleHookRegistry,
  type LifecycleHookRegistration,
  type LifecycleHookResult,
  type LifecycleInvocation,
} from "./index.js";

const identity = {
  workspaceId: "workspace",
  sessionId: "session",
  runId: "run",
};
const signal = () => new AbortController().signal;
const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const originalInput = { command: "original command data", cwd: "/original" };
const tool = (id = "tool"): LifecycleInvocation<"tool-prepare"> => ({
  invocationId: id,
  identity,
  stage: "tool-prepare",
  metadata: {
    toolCallId: "call",
    toolName: "run_command",
    inputSha256: sha(originalInput),
    inputBytes: bytes(originalInput),
    registryRevision: 2,
    policyVersion: 3,
    turnId: "turn",
    attemptId: "attempt",
  },
});
const context = (
  slotBytes = 4096,
  id = "context",
): LifecycleInvocation<"model-context"> => ({
  invocationId: id,
  identity,
  stage: "model-context",
  metadata: {
    providerId: "provider",
    modelId: "model",
    turnIndex: 0,
    contextSha256: sha([{ role: "user", content: "required user exchange" }]),
    contextBytes: 64,
    slotBytes,
  },
});
const stop = (
  outcome: "completed" | "failed" | "cancelled" = "completed",
  id = "stop",
): LifecycleInvocation<"before-stop"> => ({
  invocationId: id,
  identity,
  stage: "before-stop",
  metadata: {
    outcome,
    turnCount: 1,
    toolCallCount: 1,
    outputBytes: 8,
    verificationSha256: sha({
      required: ["check"],
      source: "current",
      budget: "original",
    }),
    continuationsUsed: 0,
  },
});
const registration = (
  id: string,
  stages: LifecycleHookRegistration["stages"],
  callback: LifecycleHookRegistration["callback"],
  extra: Partial<LifecycleHookRegistration> = {},
): LifecycleHookRegistration => ({
  id,
  revision: 1,
  stages,
  callback,
  ...extra,
});
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("ordered tool rewrites detach input, update only later digest metadata, and leave hash-only outcomes", async () => {
  const registry = new LifecycleHookRegistry(),
    seen: LifecycleInvocation[] = [];
  const first: JsonObject = {
      command: "private first rewrite",
      nested: { value: "kept" },
    },
    last: JsonObject = { command: "private effective rewrite" };
  registry.register(
    registration(
      "last",
      ["tool-prepare"],
      (invocation) => {
        assert.equal(invocation.stage, "tool-prepare");
        if (invocation.stage !== "tool-prepare") throw new Error("Wrong stage");
        seen.push(invocation);
        assert.equal(invocation.metadata.inputSha256, sha(first));
        assert.equal(invocation.metadata.inputBytes, bytes(first));
        assert.equal(Object.hasOwn(invocation.metadata, "input"), false);
        assert.equal(Object.isFrozen(invocation.metadata), true);
        return {
          kind: "rewrite-input",
          expectedInputSha256: invocation.metadata.inputSha256,
          input: last,
        };
      },
      { order: 2 },
    ),
  );
  registry.register(
    registration(
      "first",
      ["tool-prepare"],
      (invocation) => {
        assert.equal(invocation.stage, "tool-prepare");
        if (invocation.stage !== "tool-prepare") throw new Error("Wrong stage");
        seen.push(invocation);
        assert.equal(invocation.metadata.inputSha256, sha(originalInput));
        return {
          kind: "rewrite-input",
          expectedInputSha256: invocation.metadata.inputSha256,
          input: first,
        };
      },
      { order: 1 },
    ),
  );
  const original = tool(),
    output = await registry.dispatch(
      registry.capture(identity),
      original,
      signal(),
    );
  assert.equal(output.action, "observe");
  assert.equal(output.status, "completed");
  assert.deepEqual(output.inputRewrite, {
    input: last,
    originalSha256: sha(originalInput),
    effectiveSha256: sha(last),
  });
  assert.equal(output.contextData, undefined);
  assert.equal(output.continuation, undefined);
  assert.deepEqual(
    output.outcomes.map((item) => [item.hookId, item.action, item.status]),
    [
      ["first", "observe", "observed"],
      ["last", "observe", "observed"],
    ],
  );
  assert.equal(JSON.stringify(output.outcomes).includes("private"), false);
  assert.equal(original.metadata.inputSha256, sha(originalInput));
  assert.equal(seen[0]!.invocationId, seen[1]!.invocationId);
  last.command = "changed after callback";
  assert.equal(
    (output.inputRewrite!.input as JsonObject).command,
    "private effective rewrite",
  );
  assert.equal(Object.isFrozen(output.inputRewrite!.input), true);
});

test("rewrite invocation idempotence pins original metadata and cannot grant authority to copied or foreign captures", async () => {
  const registry = new LifecycleHookRegistry(),
    pending = deferred<LifecycleHookResult>();
  let calls = 0;
  registry.register(
    registration("rewrite", ["tool-prepare"], () => {
      calls++;
      return pending.promise;
    }),
  );
  const captured = registry.capture(identity),
    original = tool(),
    first = registry.dispatch(captured, original, signal());
  assert.equal(
    registry.dispatch(captured, structuredClone(original), signal()),
    first,
  );
  assert.throws(
    () =>
      registry.dispatch(
        captured,
        {
          ...original,
          metadata: {
            ...original.metadata,
            inputBytes: original.metadata.inputBytes + 1,
          },
        },
        signal(),
      ),
    code("LIFECYCLE_INVOCATION_CONFLICT"),
  );
  assert.throws(
    () => registry.dispatch(structuredClone(captured), original, signal()),
    code("INVALID_LIFECYCLE_CAPTURE"),
  );
  assert.throws(
    () => new LifecycleHookRegistry().dispatch(captured, original, signal()),
    code("INVALID_LIFECYCLE_CAPTURE"),
  );
  assert.throws(
    () =>
      registry.dispatch(
        captured,
        { ...original, identity: { ...identity, runId: "other" } },
        signal(),
      ),
    code("LIFECYCLE_IDENTITY_MISMATCH"),
  );
  await tick();
  pending.resolve({
    kind: "rewrite-input",
    expectedInputSha256: original.metadata.inputSha256,
    input: { effective: true },
  });
  const output = await first;
  assert.equal(calls, 1);
  assert.equal(await registry.dispatch(captured, original, signal()), output);
});

test("wrong stages, stale rewrite pins and invalid result payloads obey the registered failure policy", async () => {
  const wrong: LifecycleHookResult = {
    kind: "rewrite-input",
    expectedInputSha256: tool().metadata.inputSha256,
    input: { value: 1 },
  };
  const after: LifecycleInvocation<"tool-prepared"> = {
    invocationId: "prepared",
    identity,
    stage: "tool-prepared",
    metadata: {
      toolCallId: "call",
      toolName: "run_command",
      fingerprint: "exact-producer",
      requiresApproval: true,
    },
  };
  const wrongStage = new LifecycleHookRegistry();
  wrongStage.register(registration("invalid", ["tool-prepared"], () => wrong));
  const wrongOutput = await wrongStage.dispatch(
    wrongStage.capture(identity),
    after,
    signal(),
  );
  assert.equal(wrongOutput.outcomes[0]!.code, "INVALID_LIFECYCLE_RESULT");
  assert.equal(wrongOutput.inputRewrite, undefined);
  for (const failurePolicy of ["observe", "deny", "stop"] as const) {
    const registry = new LifecycleHookRegistry();
    registry.register(
      registration(
        "stale",
        ["tool-prepare"],
        () => ({
          kind: "rewrite-input",
          expectedInputSha256: "a".repeat(64),
          input: { value: 1 },
        }),
        { failurePolicy },
      ),
    );
    const output = await registry.dispatch(
      registry.capture(identity),
      tool(),
      signal(),
    );
    assert.equal(output.action, failurePolicy);
    assert.equal(output.outcomes[0]!.code, "LIFECYCLE_TRANSFORM_STALE");
    assert.equal(output.inputRewrite, undefined);
  }
});

test("later deny or stop discards accepted rewrite payload while preserving only its observed digest receipt", async () => {
  for (const kind of ["deny", "stop"] as const) {
    const registry = new LifecycleHookRegistry();
    registry.register(
      registration("rewrite", ["tool-prepare"], () => ({
        kind: "rewrite-input",
        expectedInputSha256: tool().metadata.inputSha256,
        input: { secret: "ephemeral-only" },
      })),
    );
    registry.register(
      registration("gate", ["tool-prepare"], () => ({
        kind,
        code: "HOST_DECISION",
        reason: "Host decision",
      })),
    );
    const output = await registry.dispatch(
      registry.capture(identity),
      tool(),
      signal(),
    );
    assert.equal(output.action, kind);
    assert.equal(output.inputRewrite, undefined);
    assert.equal(output.contextData, undefined);
    assert.equal(output.continuation, undefined);
    assert.equal(output.outcomes[0]!.transform?.kind, "rewrite-input");
    assert.equal(JSON.stringify(output).includes("ephemeral-only"), false);
  }
});

test("context hooks pin one original digest and return detached ordered bounded supplemental data", async () => {
  const registry = new LifecycleHookRegistry(),
    original = context(),
    seen: string[] = [],
    external: JsonObject = { note: "private context payload" };
  for (const [index, data] of [external, { nested: { value: 2 } }].entries())
    registry.register(
      registration(`context${index}`, ["model-context"], (invocation) => {
        if (invocation.stage !== "model-context")
          throw new Error("Wrong stage");
        seen.push(invocation.metadata.contextSha256);
        assert.equal(Object.hasOwn(invocation.metadata, "messages"), false);
        return {
          kind: "context-data",
          expectedContextSha256: invocation.metadata.contextSha256,
          data,
        };
      }),
    );
  const output = await registry.dispatch(
    registry.capture(identity),
    original,
    signal(),
  );
  assert.deepEqual(seen, [
    original.metadata.contextSha256,
    original.metadata.contextSha256,
  ]);
  assert.deepEqual(
    output.contextData!.items.map((item) => item.hookId),
    ["context0", "context1"],
  );
  assert.equal(output.contextData!.sha256, sha(output.contextData!.items));
  assert.ok(bytes(output.contextData!.items) <= registry.limits.maxResultBytes);
  assert.equal(output.inputRewrite, undefined);
  assert.equal(
    JSON.stringify(output.outcomes).includes("private context payload"),
    false,
  );
  external.note = "later changed";
  assert.equal(
    output.contextData!.items[0]!.data.note,
    "private context payload",
  );
  assert.equal(Object.isFrozen(output.contextData!.items[0]!.data), true);
});

test("aggregate context cap and zero reserved slot cannot accept multiple individually bounded payloads", async () => {
  const registry = new LifecycleHookRegistry({ maxResultBytes: 300 });
  for (let index = 0; index < 3; index++)
    registry.register(
      registration(`data${index}`, ["model-context"], () => ({
        kind: "context-data",
        expectedContextSha256: context().metadata.contextSha256,
        data: { value: "x".repeat(60) },
      })),
    );
  const output = await registry.dispatch(
    registry.capture(identity),
    context(300),
    signal(),
  );
  assert.equal(output.action, "stop");
  assert.equal(output.contextData, undefined);
  assert.equal(output.outcomes.at(-1)!.code, "LIFECYCLE_TRANSFORM_LIMIT");
  assert.equal(
    output.outcomes.filter((item) => item.status === "observed").length,
    2,
  );
  const zero = new LifecycleHookRegistry();
  zero.register(
    registration("noSlot", ["model-context"], () => ({
      kind: "context-data",
      expectedContextSha256: context().metadata.contextSha256,
      data: {},
    })),
  );
  const empty = await zero.dispatch(
    zero.capture(identity),
    context(0),
    signal(),
  );
  assert.equal(empty.contextData, undefined);
  assert.equal(empty.outcomes[0]!.code, "LIFECYCLE_TRANSFORM_LIMIT");
});

test("stale context digest and control after context data never expose supplemental payload", async () => {
  for (const stale of [true, false]) {
    const registry = new LifecycleHookRegistry();
    registry.register(
      registration("data", ["model-context"], () => ({
        kind: "context-data",
        expectedContextSha256: stale
          ? "b".repeat(64)
          : context().metadata.contextSha256,
        data: { note: "discarded supplement" },
      })),
    );
    registry.register(
      registration("deny", ["model-context"], () => ({
        kind: "deny",
        code: "HOST_CONTEXT_DENY",
        reason: "Host context denied",
      })),
    );
    const output = await registry.dispatch(
      registry.capture(identity),
      context(),
      signal(),
    );
    assert.equal(output.contextData, undefined);
    assert.equal(
      JSON.stringify(output).includes("discarded supplement"),
      false,
    );
    assert.equal(
      output.code,
      stale ? "LIFECYCLE_TRANSFORM_STALE" : "HOST_CONTEXT_DENY",
    );
  }
});

test("one completed verification-bound continuation is ephemeral and produces no success or command authority", async () => {
  const registry = new LifecycleHookRegistry(),
    original = stop(),
    payload: JsonObject = {
      reason: "continue bounded checks",
      commandLikeData: "quoted data only",
    };
  registry.register(
    registration("continue", ["before-stop"], (invocation) => {
      if (invocation.stage !== "before-stop") throw new Error("Wrong stage");
      assert.equal(invocation.metadata.continuationsUsed, 0);
      return {
        kind: "continue",
        expectedVerificationSha256: invocation.metadata.verificationSha256!,
        data: payload,
      };
    }),
  );
  const output = await registry.dispatch(
    registry.capture(identity),
    original,
    signal(),
  );
  assert.equal(output.action, "observe");
  assert.equal(output.status, "completed");
  assert.deepEqual(output.continuation, {
    verificationSha256: original.metadata.verificationSha256,
    data: payload,
    sha256: sha(payload),
  });
  assert.equal(output.outcomes[0]!.status, "observed");
  assert.equal(output.outcomes[0]!.action, "observe");
  assert.equal(
    JSON.stringify(output.outcomes).includes("quoted data only"),
    false,
  );
  assert.equal(Object.hasOwn(output, "taskVerified"), false);
  assert.equal(Object.hasOwn(output, "requiresApproval"), false);
});

test("continuation requires a completed exact verification digest and at most one result", async () => {
  for (const event of [
    stop("failed"),
    stop("cancelled"),
    {
      ...stop(),
      metadata: {
        outcome: "completed" as const,
        turnCount: 1,
        toolCallCount: 1,
        outputBytes: 8,
      },
    },
    {
      ...stop(),
      metadata: { ...stop().metadata, verificationSha256: "a".repeat(64) },
    },
  ]) {
    const registry = new LifecycleHookRegistry();
    registry.register(
      registration("continue", ["before-stop"], () => ({
        kind: "continue",
        expectedVerificationSha256: stop().metadata.verificationSha256!,
        data: { value: "withheld" },
      })),
    );
    const output = await registry.dispatch(
      registry.capture(identity),
      event,
      signal(),
    );
    assert.equal(output.continuation, undefined);
    assert.equal(output.outcomes[0]!.code, "LIFECYCLE_TRANSFORM_STALE");
  }
  const duplicate = new LifecycleHookRegistry();
  for (const id of ["first", "second"])
    duplicate.register(
      registration(id, ["before-stop"], () => ({
        kind: "continue",
        expectedVerificationSha256: stop().metadata.verificationSha256!,
        data: { id },
      })),
    );
  const limited = await duplicate.dispatch(
    duplicate.capture(identity),
    stop(),
    signal(),
  );
  assert.equal(limited.continuation, undefined);
  assert.equal(limited.outcomes.at(-1)!.code, "LIFECYCLE_CONTINUATION_LIMIT");
  const controlled = new LifecycleHookRegistry();
  controlled.register(
    registration("continue", ["before-stop"], () => ({
      kind: "continue",
      expectedVerificationSha256: stop().metadata.verificationSha256!,
      data: { text: "discarded" },
    })),
  );
  controlled.register(
    registration("stop", ["before-stop"], () => ({
      kind: "stop",
      code: "HOST_STOP",
      reason: "Final stop",
    })),
  );
  const stopped = await controlled.dispatch(
    controlled.capture(identity),
    stop(),
    signal(),
  );
  assert.equal(stopped.continuation, undefined);
  assert.equal(stopped.action, "stop");
});

test("getter, proxy, sparse, oversized and extra transform fields fail without invoking traps or publishing payload", async () => {
  let traps = 0;
  const getter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      traps++;
      return "secret";
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error("get trap");
      },
      ownKeys() {
        traps++;
        throw new Error("keys trap");
      },
    },
  );
  const sparse = new Array<JsonValue>(2);
  const results = [
    {
      kind: "rewrite-input",
      expectedInputSha256: tool().metadata.inputSha256,
      input: getter,
    },
    {
      kind: "rewrite-input",
      expectedInputSha256: tool().metadata.inputSha256,
      input: { proxy },
    },
    {
      kind: "rewrite-input",
      expectedInputSha256: tool().metadata.inputSha256,
      input: sparse,
    },
    {
      kind: "rewrite-input",
      expectedInputSha256: tool().metadata.inputSha256,
      input: { text: "x".repeat(5000) },
    },
    {
      kind: "rewrite-input",
      expectedInputSha256: tool().metadata.inputSha256,
      input: {},
      metadata: { mustNotBecomeDurable: "raw-input" },
    },
  ];
  for (const result of results) {
    const registry = new LifecycleHookRegistry();
    registry.register(
      registration(
        "hostile",
        ["tool-prepare"],
        () => result as LifecycleHookResult,
      ),
    );
    const output = await registry.dispatch(
      registry.capture(identity),
      tool(),
      signal(),
    );
    assert.equal(output.action, "stop");
    assert.equal(output.inputRewrite, undefined);
    assert.equal(output.outcomes[0]!.status, "failed");
  }
  assert.equal(traps, 0);
});

test("transform metadata remains scalar and plain; raw arguments, messages, accessors and proxies reject before callbacks", () => {
  let traps = 0,
    callbacks = 0;
  const registry = new LifecycleHookRegistry();
  registry.register(
    registration("never", ["tool-prepare", "model-context"], () => {
      callbacks++;
    }),
  );
  const captured = registry.capture(identity);
  for (const event of [
    { ...tool(), metadata: { ...tool().metadata, input: originalInput } },
    { ...context(), metadata: { ...context().metadata, messages: [] } },
  ])
    assert.throws(
      () => registry.dispatch(captured, event as LifecycleInvocation, signal()),
      code("INVALID_LIFECYCLE_METADATA"),
    );
  const getter = tool();
  Object.defineProperty(getter.metadata, "inputSha256", {
    enumerable: true,
    get() {
      traps++;
      return sha(originalInput);
    },
  });
  assert.throws(
    () => registry.dispatch(captured, getter, signal()),
    code("INVALID_LIFECYCLE_METADATA"),
  );
  const proxy = new Proxy(tool().metadata, {
    ownKeys() {
      traps++;
      throw new Error("trap");
    },
  });
  assert.throws(
    () => registry.dispatch(captured, { ...tool(), metadata: proxy }, signal()),
    code("INVALID_LIFECYCLE_METADATA"),
  );
  assert.equal(traps, 0);
  assert.equal(callbacks, 0);
});

test("cancellation, registry change and capture release discard accepted earlier rewrites and all late results", async () => {
  for (const interruption of ["abort", "replace", "release"] as const) {
    const registry = new LifecycleHookRegistry(),
      controller = new AbortController(),
      pending = deferred<LifecycleHookResult>();
    registry.register(
      registration("first", ["tool-prepare"], () => ({
        kind: "rewrite-input",
        expectedInputSha256: tool().metadata.inputSha256,
        input: { text: "private earlier" },
      })),
    );
    const remove = registry.register(
      registration("pending", ["tool-prepare"], () => pending.promise),
    );
    const captured = registry.capture(identity),
      task = registry.dispatch(captured, tool(), controller.signal);
    await tick();
    if (interruption === "abort") controller.abort();
    else if (interruption === "release") registry.release(captured);
    else remove();
    pending.resolve({
      kind: "rewrite-input",
      expectedInputSha256: sha({ text: "private earlier" }),
      input: { text: "private late" },
    });
    const output = await task;
    assert.equal(output.action, "stop");
    assert.equal(output.inputRewrite, undefined);
    assert.equal(output.contextData, undefined);
    assert.equal(output.continuation, undefined);
    assert.equal(
      output.status,
      interruption === "replace" ? "stale" : "cancelled",
    );
    assert.equal(JSON.stringify(output).includes("private"), false);
  }
});

test("timed-out transform has no payload authority even when its late result settles and is replayed", async () => {
  const registry = new LifecycleHookRegistry(),
    pending = deferred<LifecycleHookResult>();
  registry.register(
    registration("late", ["model-context"], () => pending.promise, {
      timeoutMs: 10,
      failurePolicy: "observe",
    }),
  );
  const captured = registry.capture(identity),
    original = context(),
    output = await registry.dispatch(captured, original, signal());
  assert.equal(output.action, "observe");
  assert.equal(output.outcomes[0]!.status, "timed-out");
  assert.equal(output.contextData, undefined);
  pending.resolve({
    kind: "context-data",
    expectedContextSha256: original.metadata.contextSha256,
    data: { text: "late secret" },
  });
  await tick();
  assert.equal(await registry.dispatch(captured, original, signal()), output);
  assert.equal(JSON.stringify(output).includes("late secret"), false);
});

test("an authenticated already-consumed Run allowance rejects a new continue result under its failure policy", async () => {
  for (const failurePolicy of ["observe", "stop"] as const) {
    const registry = new LifecycleHookRegistry();
    registry.register(
      registration(
        "repeat",
        ["before-stop"],
        () => ({
          kind: "continue",
          expectedVerificationSha256: stop().metadata.verificationSha256!,
          data: { text: "must not issue a second continuation" },
        }),
        { failurePolicy },
      ),
    );
    const original = stop(),
      event = {
        ...original,
        metadata: { ...original.metadata, continuationsUsed: 1 },
      };
    const output = await registry.dispatch(
      registry.capture(identity),
      event,
      signal(),
    );
    assert.equal(output.action, failurePolicy);
    assert.equal(output.continuation, undefined);
    assert.equal(output.outcomes[0]!.status, "failed");
    assert.equal(output.outcomes[0]!.code, "LIFECYCLE_TRANSFORM_LIMIT");
  }
});
