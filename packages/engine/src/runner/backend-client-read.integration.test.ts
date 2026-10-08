import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type ApprovalRecord,
  type JsonObject,
  type Run,
  type RunConfig,
  type RunReceipt,
  type Session,
  type SessionSnapshot,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../engine.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  ToolDefinition,
  TurnRequest,
} from "../ports.js";
import type { BackendClientReadProof } from "../agent-backends/client-effects.js";
import { backendReadResponse } from "../agent-backends/client-effects.js";
import { createReadTools } from "../tools/read/index.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { LifecycleHookRegistry } from "../lifecycle/index.js";

type Engine = ReturnType<typeof createEngine>;
interface Fixture {
  engine: Engine;
  root: string;
  workspace: Workspace;
  session: Session;
  originals: TurnRequest[];
  executions(): number;
  submit(): Promise<RunReceipt>;
  finish(receipt: RunReceipt): Promise<Run>;
  snapshot(): SessionSnapshot;
}
const failure =
  (...codes: string[]) =>
  (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.ok(
      codes.includes(error.code),
      `Expected ${codes.join("|")}; received ${error.code}`,
    );
    return true;
  };
async function command<T>(
  engine: Engine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const reply = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.result as unknown as T;
}
async function until(check: () => boolean, detail: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, detail);
    await new Promise<void>((done) => setTimeout(done, 2));
  }
}

/** Real Engine/SQLite/files and the exact original provider request; no invented ToolContext. */
async function fixture(
  t: TestContext,
  inside: (
    f: Fixture,
    request: TurnRequest,
    signal: AbortSignal,
  ) => Promise<void>,
  options: {
    policy?: EngineOptions["toolPolicy"];
    maxToolCalls?: number;
    maxOutputBytes?: number;
    content?: string;
    mode?: "plan" | "build";
    registry?: EngineOptions["lifecycleHookRegistry"];
  } = {},
): Promise<Fixture> {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-backend-native-read-")),
    ),
    root = join(base, "repository");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(
    join(root, "source.txt"),
    options.content ?? "first\nsecond\nthird\nfourth\n",
  );
  let f!: Fixture,
    executeCount = 0,
    providerFailure: unknown;
  const originals: TurnRequest[] = [];
  const tools: ToolDefinition[] = createReadTools().map(
    (tool): ToolDefinition =>
      tool.name !== "read_file"
        ? tool
        : {
            ...tool,
            async execute(prepared, context) {
              executeCount++;
              return tool.execute(prepared, context);
            },
          },
  );
  const provider: ProviderAdapter = {
    id: "actual-backend-native-read",
    async *streamTurn(request, signal): AsyncGenerator<ProviderEvent> {
      originals.push(request);
      try {
        await inside(f, request, signal);
      } catch (error) {
        providerFailure = error;
        throw error;
      }
      if (!signal.aborted) yield { type: "finish", reason: "stop" };
    },
  };
  const engine = createEngine({
    dbPath: join(base, "engine.sqlite"),
    artifactDir: join(base, "artifacts"),
    providers: [provider],
    tools,
    toolPolicy: options.policy,
    lifecycleHookRegistry: options.registry,
  });
  t.after(async () => {
    try {
      await engine.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  const workspace = await command<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await command<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
  const config: RunConfig = {
    providerId: provider.id,
    modelId: "fixture",
    mode: options.mode ?? "plan",
    limits: {
      ...DEFAULT_LIMITS,
      maxTurns: 2,
      maxToolCalls: options.maxToolCalls ?? 4,
      maxOutputBytes: options.maxOutputBytes ?? 32768,
      maxDurationMs: 10000,
      toolTimeoutMs: 5000,
    },
  };
  f = {
    engine,
    root,
    workspace,
    session,
    originals,
    executions: () => executeCount,
    submit: () =>
      command<RunReceipt>(engine, "run.submit", {
        sessionId: session.id,
        requestId: randomUUID(),
        prompt: "Perform one original in-flight client read.",
        config: config as unknown as JsonObject,
      }),
    async finish(receipt: RunReceipt) {
      const run = await engine.waitForRun(receipt.runId);
      if (providerFailure) throw providerFailure;
      return run;
    },
    snapshot: () => engine.store.getSnapshot(session.id),
  };
  return f;
}

test("same Attempt client read creates native proposal, completed Part and raw content without a second provider dispatch", async (t) => {
  let proof: BackendClientReadProof | undefined;
  const f = await fixture(t, async (actual, request, signal) => {
    const runner = actual.engine.coordinator,
      owner = runner.readProviderRequestOwner(request);
    runner.assertProviderRequest(request, "dispatch");
    assert.equal(owner.runId, request.runId);
    assert.equal(owner.turnId, request.turnId);
    assert.equal(owner.attemptId, request.attemptId);
    const handle = await runner.executeProviderClientRead(
      request,
      {
        callId: "peer-read-1",
        path: join(actual.root, "source.txt"),
        line: 2,
        limit: 2,
      },
      signal,
    );
    proof = runner.readProviderClientReadCompletion(handle);
    assert.deepEqual(backendReadResponse(proof), {
      content: "second\nthird\n",
    });
    assert.equal(proof.runId, request.runId);
    assert.equal(proof.attemptId, request.attemptId);
    assert.equal(proof.cleanupConfirmed, true);
    assert.equal(proof.errorCode, null);
    assert.throws(
      () => runner.readProviderClientReadCompletion({ ...handle }),
      failure("BACKEND_ORIGINAL_REQUIRED"),
    );
    const native = actual
      .snapshot()
      .tools.find((tool) => tool.id === proof!.toolCallId)!;
    assert.equal(native.state, "completed");
    assert.equal(proof.inputSha256, knowledgeHash(native.input));
    assert.equal(native.name, "read_file");
    runner.releaseProviderClientReadCompletion(handle);
    assert.throws(
      () => runner.readProviderClientReadCompletion(handle),
      failure("BACKEND_ORIGINAL_REQUIRED"),
    );
    runner.assertProviderRequest(request, "dispatch");
  });
  const receipt = await f.submit();
  assert.equal((await f.finish(receipt)).state, "completed");
  assert.ok(proof);
  assert.equal(f.originals.length, 1);
  assert.equal(f.executions(), 1);
  const turns = f.engine.store.listTurns(receipt.runId);
  assert.equal(turns.length, 1);
  const parts = f.engine.store
    .listParts(turns[0]!.id)
    .filter((part) => part.type === "tool");
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.state, "completed");
  assert.equal(
    f.engine.store
      .readSessionEvents(f.session.id, 0, 100)
      .filter((event) => event.type === "provider.attempt.prepared").length,
    1,
  );
});
test("copied/altered/closed provider requests never create client tool effects", async (t) => {
  const f = await fixture(t, async (actual, request, signal) => {
    const runner = actual.engine.coordinator,
      before = actual.snapshot().tools.length;
    const copy = structuredClone(request);
    assert.throws(
      () => runner.readProviderRequestOwner(copy),
      failure("BACKEND_ORIGINAL_REQUEST_REQUIRED"),
    );
    await assert.rejects(
      runner.executeProviderClientRead(
        copy,
        { callId: "copy", path: join(actual.root, "source.txt") },
        signal,
      ),
      failure("BACKEND_ORIGINAL_REQUEST_REQUIRED"),
    );
    const model = request.modelId;
    request.modelId = "changed";
    try {
      await assert.rejects(
        runner.executeProviderClientRead(
          request,
          { callId: "changed", path: join(actual.root, "source.txt") },
          signal,
        ),
        failure("BACKEND_REQUEST_OWNER_STALE"),
      );
    } finally {
      request.modelId = model;
    }
    await assert.rejects(
      runner.executeProviderClientRead(
        request,
        { callId: "outside", path: join(actual.root, "..", "outside.txt") },
        signal,
      ),
      failure("BACKEND_CLIENT_READ_OUTSIDE"),
    );
    await assert.rejects(
      runner.executeProviderClientRead(
        request,
        {
          callId: "too-wide",
          path: join(actual.root, "source.txt"),
          limit: 2001,
        },
        signal,
      ),
      failure("BACKEND_CLIENT_READ_INVALID"),
    );
    assert.equal(actual.snapshot().tools.length, before);
    assert.equal(actual.executions(), 0);
  });
  const receipt = await f.submit();
  assert.equal((await f.finish(receipt)).state, "completed");
  assert.equal(f.executions(), 0);
  assert.throws(
    () =>
      f.engine.coordinator.assertProviderRequest(f.originals[0]!, "observe"),
    failure("BACKEND_ORIGINAL_REQUEST_REQUIRED"),
  );
  await assert.rejects(
    f.engine.coordinator.executeProviderClientRead(
      f.originals[0]!,
      { callId: "closed", path: join(f.root, "source.txt") },
      new AbortController().signal,
    ),
    failure("BACKEND_ORIGINAL_REQUEST_REQUIRED"),
  );
  assert.equal(f.snapshot().tools.length, 0);
});
test("original request accessors, serializers and nested proxies are rejected without invoking traps or native tools", async (t) => {
  let traps = 0;
  const f = await fixture(t, async (actual, request, signal) => {
    const runner = actual.engine.coordinator;
    const firstMessage = request.messages[0]!;
    const firstTool = request.tools[0]!;
    assert.ok(firstMessage);
    assert.ok(firstTool);
    function installed(
      target: object,
      name: string,
      descriptor: PropertyDescriptor,
    ): () => void {
      const before = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        ...descriptor,
      });
      return () => {
        if (before) Object.defineProperty(target, name, before);
        else Reflect.deleteProperty(target, name);
      };
    }
    const touched = (): never => {
      traps++;
      throw new Error("Executable request metadata was evaluated");
    };
    const mutations: (() => () => void)[] = [
      () => installed(firstMessage, "content", { get: touched }),
      () =>
        installed(firstMessage, "toJSON", { value: touched, writable: true }),
      () => installed(firstTool.inputSchema, "type", { get: touched }),
      () =>
        installed(firstTool.inputSchema, "toJSON", {
          value: touched,
          writable: true,
        }),
      () =>
        installed(firstTool, "inputSchema", {
          value: new Proxy(firstTool.inputSchema, {
            get: touched,
            ownKeys: touched,
            getPrototypeOf: touched,
          }),
          writable: true,
        }),
      () =>
        installed(request, "messages", {
          value: new Proxy(request.messages, {
            get: touched,
            ownKeys: touched,
            getPrototypeOf: touched,
          }),
          writable: true,
        }),
    ];
    for (const mutate of mutations) {
      const restore = mutate();
      try {
        assert.throws(
          () => runner.assertProviderRequest(request, "dispatch"),
          failure("BACKEND_REQUEST_OWNER_STALE"),
        );
        assert.throws(
          () => runner.readProviderRequestOwner(request),
          failure("BACKEND_REQUEST_OWNER_STALE"),
        );
        await assert.rejects(
          runner.executeProviderClientRead(
            request,
            {
              callId: "executable-metadata",
              path: join(actual.root, "source.txt"),
            },
            signal,
          ),
          failure("BACKEND_REQUEST_OWNER_STALE"),
        );
        assert.equal(traps, 0);
        assert.equal(actual.snapshot().tools.length, 0);
        assert.equal(actual.executions(), 0);
      } finally {
        restore();
      }
      runner.assertProviderRequest(request, "dispatch");
    }
    const proxy = new Proxy(request, {
      get: touched,
      ownKeys: touched,
      getPrototypeOf: touched,
    });
    assert.throws(
      () => runner.assertProviderRequest(proxy, "dispatch"),
      failure("BACKEND_ORIGINAL_REQUEST_REQUIRED"),
    );
    await assert.rejects(
      runner.executeProviderClientRead(
        proxy,
        { callId: "proxy-original", path: join(actual.root, "source.txt") },
        signal,
      ),
      failure("BACKEND_ORIGINAL_REQUEST_REQUIRED"),
    );
    assert.equal(traps, 0);
  });
  const receipt = await f.submit();
  assert.equal((await f.finish(receipt)).state, "completed");
  assert.equal(traps, 0);
  assert.equal(f.executions(), 0);
  assert.equal(f.snapshot().tools.length, 0);
  assert.equal(f.originals.length, 1);
});
test("exact policy approval denial and concurrent request rejection preserve zero native read execution", async (t) => {
  let proof: BackendClientReadProof | undefined;
  const f = await fixture(
    t,
    async (actual, request, signal) => {
      const runner = actual.engine.coordinator,
        first = runner.executeProviderClientRead(
          request,
          { callId: "ask-1", path: join(actual.root, "source.txt") },
          signal,
        );
      await assert.rejects(
        runner.executeProviderClientRead(
          request,
          { callId: "ask-2", path: join(actual.root, "source.txt") },
          signal,
        ),
        failure("BACKEND_CLIENT_READ_CONFLICT"),
      );
      const handle = await first;
      proof = runner.readProviderClientReadCompletion(handle);
      assert.equal(proof.state, "denied");
      assert.equal(proof.content, null);
      assert.equal(proof.errorCode, "APPROVAL_DENIED");
      assert.throws(
        () => backendReadResponse(proof!),
        failure("APPROVAL_DENIED"),
      );
      runner.releaseProviderClientReadCompletion(handle);
    },
    { policy: [{ tool: "read_file", decision: "ask" }], mode: "build" },
  );
  const receipt = await f.submit();
  await until(
    () => f.snapshot().approvals.some((item) => item.status === "pending"),
    "actual native approval must be pending",
  );
  const approval = f
    .snapshot()
    .approvals.find((item) => item.status === "pending")!;
  assert.throws(
    () => f.engine.approvals.decide(approval.id, "allow", "wrong-fingerprint"),
    failure("APPROVAL_FINGERPRINT_MISMATCH"),
  );
  assert.equal(f.executions(), 0);
  f.engine.approvals.decide(approval.id, "deny", approval.fingerprint);
  assert.equal((await f.finish(receipt)).state, "completed");
  assert.ok(proof);
  assert.equal(f.executions(), 0);
  assert.equal(f.snapshot().tools.length, 1);
  assert.equal(f.snapshot().approvals[0]!.status, "denied");
});
test("parent cancellation expires pending exact read approval and late permission cannot perform the read", async (t) => {
  let approval: ApprovalRecord | undefined;
  const f = await fixture(
    t,
    async (actual, request, signal) => {
      try {
        const handle =
          await actual.engine.coordinator.executeProviderClientRead(
            request,
            { callId: "cancel-read", path: join(actual.root, "source.txt") },
            signal,
          );
        const proof =
          actual.engine.coordinator.readProviderClientReadCompletion(handle);
        assert.equal(proof.content, null);
        assert.notEqual(proof.state, "completed");
        actual.engine.coordinator.releaseProviderClientReadCompletion(handle);
      } catch (error) {
        assert.ok(signal.aborted);
      }
    },
    { policy: [{ tool: "read_file", decision: "ask" }], mode: "build" },
  );
  const receipt = await f.submit();
  await until(
    () => f.snapshot().approvals.some((item) => item.status === "pending"),
    "actual cancellation approval must be pending",
  );
  approval = f.snapshot().approvals.find((item) => item.status === "pending")!;
  f.engine.coordinator.cancel(receipt.runId);
  assert.equal((await f.finish(receipt)).state, "cancelled");
  assert.equal(f.executions(), 0);
  assert.equal(
    f.snapshot().approvals.find((item) => item.id === approval!.id)!.status,
    "expired",
  );
  assert.throws(
    () =>
      f.engine.approvals.decide(approval!.id, "allow", approval!.fingerprint),
    failure("APPROVAL_EXPIRED", "APPROVAL_STALE"),
  );
  assert.equal(f.snapshot().tools.length, 1);
  assert.equal(f.originals.length, 1);
});
test("native partial output retains its receipt but cannot become a successful ACP content response", async (t) => {
  let proof: BackendClientReadProof | undefined;
  const f = await fixture(
    t,
    async (actual, request, signal) => {
      const runner = actual.engine.coordinator,
        handle = await runner.executeProviderClientRead(
          request,
          { callId: "partial", path: join(actual.root, "source.txt") },
          signal,
        );
      proof = runner.readProviderClientReadCompletion(handle);
      assert.equal(proof.state, "completed");
      assert.equal(proof.content, null);
      assert.equal(proof.errorCode, "BACKEND_CLIENT_READ_PARTIAL");
      assert.throws(
        () => backendReadResponse(proof!),
        failure("BACKEND_CLIENT_READ_PARTIAL"),
      );
      runner.releaseProviderClientReadCompletion(handle);
    },
    {
      content: "한국어🙂 large source line.\n".repeat(3000),
      maxOutputBytes: 2048,
    },
  );
  const receipt = await f.submit();
  assert.equal((await f.finish(receipt)).state, "completed");
  assert.ok(proof);
  assert.equal(f.executions(), 1);
  const tool = f.snapshot().tools[0]!;
  assert.equal(tool.state, "completed");
  assert.equal((JSON.parse(tool.output!) as JsonObject).truncated, true);
});
test("complete native content above the client response cap retains exact SQL output evidence but cannot become ACP success", async (t) => {
  const content = "x".repeat(24577) + "\n";
  let proof: BackendClientReadProof | undefined;
  const f = await fixture(
    t,
    async (actual, request, signal) => {
      const runner = actual.engine.coordinator;
      const handle = await runner.executeProviderClientRead(
        request,
        {
          callId: "full-large-native-read",
          path: join(actual.root, "source.txt"),
        },
        signal,
      );
      try {
        proof = runner.readProviderClientReadCompletion(handle);
        assert.equal(proof.state, "completed");
        assert.equal(proof.cleanupConfirmed, true);
        assert.equal(proof.content, null);
        assert.equal(proof.errorCode, "BACKEND_CLIENT_READ_PARTIAL");
        assert.throws(
          () => backendReadResponse(proof!),
          failure("BACKEND_CLIENT_READ_PARTIAL"),
        );
        const native = actual
          .snapshot()
          .tools.find((tool) => tool.id === proof!.toolCallId)!;
        assert.equal(native.state, "completed");
        const data = JSON.parse(native.output!) as JsonObject;
        assert.equal(data.content, content);
        assert.equal(data.truncated, false);
        assert.equal(data.outputTruncated, false);
        assert.equal(data.hasMore, false);
        assert.equal(proof.outputBytes, Buffer.byteLength(native.output!));
        assert.equal(
          proof.outputSha256,
          createHash("sha256").update(native.output!).digest("hex"),
        );
        assert.ok(proof.outputBytes > 24576);
      } finally {
        runner.releaseProviderClientReadCompletion(handle);
      }
    },
    { content, maxOutputBytes: 65536 },
  );
  const receipt = await f.submit();
  assert.equal((await f.finish(receipt)).state, "completed");
  assert.ok(proof);
  assert.equal(f.executions(), 1);
  assert.equal(f.snapshot().tools.length, 1);
  assert.equal(f.originals.length, 1);
});
test("client reads share the original tool budget and distinct IDs cannot allocate another native call", async (t) => {
  const f = await fixture(
    t,
    async (actual, request, signal) => {
      const runner = actual.engine.coordinator,
        handle = await runner.executeProviderClientRead(
          request,
          { callId: "budget-1", path: join(actual.root, "source.txt") },
          signal,
        );
      assert.equal(
        runner.readProviderClientReadCompletion(handle).content,
        "first\nsecond\nthird\nfourth\n",
      );
      runner.releaseProviderClientReadCompletion(handle);
      await assert.rejects(
        runner.executeProviderClientRead(
          request,
          { callId: "budget-1", path: join(actual.root, "source.txt") },
          signal,
        ),
        failure("BACKEND_CLIENT_READ_CONFLICT"),
      );
      await assert.rejects(
        runner.executeProviderClientRead(
          request,
          { callId: "budget-2", path: join(actual.root, "source.txt") },
          signal,
        ),
        failure("TOOL_CALL_LIMIT"),
      );
      assert.equal(actual.snapshot().tools.length, 1);
    },
    { maxToolCalls: 1 },
  );
  const receipt = await f.submit();
  assert.equal((await f.finish(receipt)).state, "completed");
  assert.equal(f.executions(), 1);
  assert.equal(f.originals.length, 1);
  assert.equal(f.snapshot().tools.length, 1);
});

test("original client read rejects host lifecycle file and range rewrites before a native file executes", async (t) => {
  const registry = new LifecycleHookRegistry(),
    proofs: BackendClientReadProof[] = [];
  let rewrites = 0;
  registry.register({
    id: "client-read-target-rewrite",
    revision: 1,
    stages: ["tool-prepare"],
    callback(invocation) {
      if (
        invocation.stage !== "tool-prepare" ||
        invocation.metadata.toolName !== "read_file"
      )
        return;
      rewrites++;
      return {
        kind: "rewrite-input",
        expectedInputSha256: invocation.metadata.inputSha256,
        input:
          rewrites === 1
            ? { path: "alternate.txt", startLine: 1, endLine: 1 }
            : { path: "source.txt", startLine: 4, endLine: 4 },
      };
    },
  });
  const f = await fixture(
    t,
    async (actual, request, signal) => {
      const runner = actual.engine.coordinator;
      for (const callId of ["exact-file", "exact-range"]) {
        const original = await runner.executeProviderClientRead(
          request,
          {
            callId,
            path: join(actual.root, "source.txt"),
            line: 1,
            limit: 1,
          },
          signal,
        );
        proofs.push(runner.readProviderClientReadCompletion(original));
        runner.releaseProviderClientReadCompletion(original);
        runner.assertProviderRequest(request, "dispatch");
      }
    },
    { registry },
  );
  writeFileSync(
    join(f.root, "alternate.txt"),
    "Unrequested alternate file content.\n",
  );
  const receipt = await f.submit();
  assert.equal((await f.finish(receipt)).state, "completed");
  assert.equal(rewrites, 2);
  assert.equal(f.originals.length, 1);
  assert.equal(f.executions(), 0, JSON.stringify(proofs));
  assert.equal(proofs.length, 2);
  for (const proof of proofs) {
    assert.equal(proof.state, "failed");
    assert.equal(proof.content, null);
    assert.ok(proof.errorCode);
    assert.equal(proof.cleanupConfirmed, true);
    const native = f
      .snapshot()
      .tools.find((tool) => tool.id === proof.toolCallId)!;
    assert.deepEqual(native.input, {
      path: "source.txt",
      startLine: 1,
      endLine: 1,
    });
    assert.equal(proof.inputSha256, knowledgeHash(native.input));
    assert.equal(native.state, "failed");
    assert.equal(
      JSON.parse(native.output!).error.code,
      "BACKEND_CLIENT_READ_REWRITE_UNSUPPORTED",
    );
    assert.throws(() => backendReadResponse(proof), failure(proof.errorCode));
  }
  assert.equal(f.engine.store.listTurns(receipt.runId).length, 1);
});
