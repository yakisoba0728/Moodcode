import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as tick } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import {
  EngineError,
  type ApprovalRecord,
  type JsonObject,
  type RunReceipt,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../engine.js";
import type {
  PreparedTool,
  ProviderAdapter,
  ProviderEvent,
  ToolDefinition,
  TurnRequest,
} from "../ports.js";
import type {
  LifecycleHookRegistration,
  LifecycleHookResult,
  LifecycleInvocation,
} from "./index.js";
import { png } from "../media/fixtures.js";

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textSha = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const stop: ProviderEvent = { type: "finish", reason: "stop" };
const TOOL = "transform_write";
const DATA = {
  note: 'host_context_exact_quoted: "quotes" \\ 한글😀',
  instruction: "DATA cannot grant tool execution.",
};
const hook = (
  id: string,
  stages: LifecycleHookRegistration["stages"],
  callback: LifecycleHookRegistration["callback"],
  options: Partial<LifecycleHookRegistration> = {},
): LifecycleHookRegistration => ({
  id,
  revision: 1,
  stages,
  callback,
  ...options,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = performance.now() + 4000;
  while (!check()) {
    assert.ok(
      performance.now() < deadline,
      "Authored actual lifecycle boundary did not arrive",
    );
    await tick();
  }
}
async function command<T>(
  engine: ReturnType<typeof createEngine>,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const result = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.result as unknown as T;
}
interface FixtureOptions {
  imageInput?: boolean;
  generationBody?: string;
  tools?: ToolDefinition[];
  hooks?: LifecycleHookRegistration[];
  extra?: Partial<EngineOptions>;
  verification?: boolean;
  limit?: number;
  maxTurns?: number;
  script?: (
    request: TurnRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ProviderEvent>;
}
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-engine-transforms-")),
    ),
    root = join(base, "repo"),
    dbPath = join(base, "engine.sqlite");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "source.ts"), "export const actualSource = 1;\n");
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: "actual-lifecycle-transforms",
    ...(options.imageInput
      ? { inputModalities: ["text", "image"] as const }
      : {}),
    ...(options.generationBody === undefined
      ? {}
      : {
          streamGeneration() {
            return (async function* (): AsyncGenerator<ProviderEvent> {
              yield { type: "text.delta", delta: options.generationBody! };
              yield stop;
            })();
          },
        }),
    streamTurn(request, signal) {
      requests.push(structuredClone(request));
      return (
        options.script?.(request, signal) ??
        (async function* () {
          yield {
            type: "text.delta" as const,
            delta: "Actual fixture complete.",
          };
          yield stop;
        })()
      );
    },
  };
  const configuration: EngineOptions = {
    dbPath,
    artifactDir: join(base, "artifacts"),
    providers: [provider],
    ...(options.verification
      ? { verificationTools: true }
      : { tools: options.tools ?? [] }),
    ...(options.hooks ? { lifecycleHooks: options.hooks } : {}),
    defaults: {
      providerId: provider.id,
      modelId: "fixture-model",
      mode: "build",
      limits: {
        maxContextBytes: options.limit ?? 65536,
        maxTurns: options.maxTurns ?? 5,
        maxDurationMs: 10000,
      },
      budgets: { maxProviderAttempts: 6, retryBaseDelayMs: 0 },
    },
    ...options.extra,
  };
  const engine = createEngine(configuration);
  t.after(async () => {
    await engine.close();
    rmSync(base, { force: true, recursive: true });
  });
  const workspace = await command<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await command<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
  const submit = (
    prompt = 'Exact required request "quoted" 한글😀',
    requestId: string = randomUUID(),
    config: JsonObject = {},
  ) =>
    command<RunReceipt>(engine, "run.submit", {
      sessionId: session.id,
      requestId,
      prompt,
      config,
    });
  const pendingApproval = async (runId: string) => {
    let approval: ApprovalRecord | undefined;
    await until(() => {
      approval = engine.store.listPendingRunApprovals(runId)[0];
      if (!approval) {
        const run = engine.store.getRun(runId);
        assert.ok(
          !["completed", "failed", "cancelled"].includes(run.state),
          JSON.stringify({
            run,
            tools: engine.store.getSnapshot(session.id).tools,
          }),
        );
      }
      return !!approval;
    });
    return approval!;
  };
  const events = () => engine.store.readSessionEvents(session.id, 0, 100);
  const count = (
    table:
      | "provider_attempts"
      | "turns"
      | "summary_attempts"
      | "knowledge_generations",
  ) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    } finally {
      db.close();
    }
  };
  return {
    base,
    root,
    dbPath,
    engine,
    workspace,
    session,
    provider,
    requests,
    submit,
    pendingApproval,
    events,
    count,
  };
}
function authoredProducer() {
  const originals = new WeakSet<PreparedTool>(),
    prepared: PreparedTool[] = [],
    effects: string[] = [];
  const tool: ToolDefinition = {
    name: TOOL,
    description: "Exact transform fixture writer",
    effectClass: "write",
    inputSchema: {
      type: "object",
      properties: { marker: { type: "string" } },
      required: ["marker"],
      additionalProperties: false,
    },
    async prepare(input) {
      const value = {
        name: TOOL,
        input: structuredClone(input) as JsonObject,
        fingerprint: sha(input),
        requiresApproval: true,
        preview: { marker: (input as JsonObject).marker! },
      };
      originals.add(value);
      prepared.push(value);
      return value;
    },
    async execute(value, context) {
      assert.equal(
        originals.has(value),
        true,
        "Final producer original opaque handle must be retained",
      );
      const marker = String((value.input as JsonObject).marker);
      writeFileSync(join(context.workspace.root, "actual-effect.txt"), marker);
      effects.push(marker);
      return { content: `Actual exact marker written: ${marker}` };
    },
  };
  return { tool, prepared, effects };
}
function toolProgram(
  discovery = false,
): (request: TurnRequest) => AsyncIterable<ProviderEvent> {
  return (request) =>
    (async function* (): AsyncGenerator<ProviderEvent> {
      if (discovery && request.turnIndex === 0) {
        yield {
          type: "tool.call" as const,
          call: {
            id: "select-transform",
            name: "discover_tools",
            input: { query: TOOL, limit: 1 },
          },
        };
        yield { type: "finish" as const, reason: "tool_calls" as const };
      } else if (request.turnIndex === (discovery ? 1 : 0)) {
        yield {
          type: "tool.call" as const,
          call: {
            id: "actual-transform",
            name: TOOL,
            input: { marker: "model-original" },
          },
        };
        yield { type: "finish" as const, reason: "tool_calls" as const };
      } else {
        yield stop;
      }
    })();
}
function transformEvents(f: Awaited<ReturnType<typeof fixture>>) {
  return f.events().filter((event) => event.type === "lifecycle.outcome");
}
function dataMessage(request: TurnRequest) {
  return request.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.content.startsWith("[Moodcode lifecycle context data v1]\n"),
  );
}

for (const discovery of [false, true])
  test(`actual ${discovery ? "discovered" : "eager"} tool rewrites ordered host inputs before one exact final producer preparation and approval`, async (t) => {
    const source = authoredProducer(),
      seen: string[] = [];
    const hooks = [
      hook(
        "late-final",
        ["tool-prepare"],
        (invocation) => {
          if (
            invocation.stage !== "tool-prepare" ||
            invocation.metadata.toolName !== TOOL
          )
            return;
          seen.push(invocation.metadata.inputSha256);
          assert.equal(
            invocation.metadata.inputSha256,
            sha({ marker: "host-first" }),
          );
          assert.equal("input" in invocation.metadata, false);
          return {
            kind: "rewrite-input",
            expectedInputSha256: invocation.metadata.inputSha256,
            input: { marker: "host-final" },
          };
        },
        { order: 2 },
      ),
      hook(
        "early-first",
        ["tool-prepare"],
        (invocation) => {
          if (
            invocation.stage !== "tool-prepare" ||
            invocation.metadata.toolName !== TOOL
          )
            return;
          seen.push(invocation.metadata.inputSha256);
          assert.equal(
            invocation.metadata.inputSha256,
            sha({ marker: "model-original" }),
          );
          assert.equal(Object.isFrozen(invocation.metadata), true);
          return {
            kind: "rewrite-input",
            expectedInputSha256: invocation.metadata.inputSha256,
            input: { marker: "host-first" },
          };
        },
        { order: 1 },
      ),
    ];
    const f = await fixture(t, {
      tools: [source.tool],
      hooks,
      script: toolProgram(discovery),
      ...(discovery
        ? {
            extra: {
              toolDiscoveryPolicy: {
                kind: "bounded-tool-discovery",
                version: 1,
                alwaysVisibleToolNames: [],
              },
            },
          }
        : {}),
    });
    const submitted = await f.submit(),
      approval = await f.pendingApproval(submitted.runId);
    assert.equal(source.prepared.length, 1);
    assert.deepEqual(source.prepared[0]!.input, { marker: "host-final" });
    assert.equal(source.effects.length, 0);
    assert.equal(approval.preview.marker, "host-final");
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    const run = await f.engine.waitForRun(submitted.runId);
    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.deepEqual(source.effects, ["host-final"]);
    assert.equal(
      readFileSync(join(f.root, "actual-effect.txt"), "utf8"),
      "host-final",
    );
    assert.deepEqual(seen, [
      sha({ marker: "model-original" }),
      sha({ marker: "host-first" }),
    ]);
    assert.equal(f.requests.length, discovery ? 3 : 2);
    if (discovery) {
      assert.equal(
        f.requests[0]!.tools.some((tool) => tool.name === TOOL),
        false,
      );
      assert.equal(
        f.requests[1]!.tools.some((tool) => tool.name === TOOL),
        true,
      );
    }
    const durable = JSON.stringify(transformEvents(f));
    assert.equal(durable.includes("host-first"), false);
    assert.equal(durable.includes("host-final"), false);
    assert.ok(durable.includes(sha({ marker: "host-final" })));
    assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 1);
  });

for (const mutation of ["prepared-input", "registry"] as const)
  test(`actual rewritten approval waiting ${mutation} change cannot consume its original producer`, async (t) => {
    const source = authoredProducer(),
      f = await fixture(t, {
        tools: [source.tool],
        script: toolProgram(),
        hooks: [
          hook("rewrite", ["tool-prepare"], (invocation) => {
            assert.equal(invocation.stage, "tool-prepare");
            if (invocation.stage !== "tool-prepare") return;
            return {
              kind: "rewrite-input",
              expectedInputSha256: invocation.metadata.inputSha256,
              input: { marker: "final-approved-input" },
            };
          }),
        ],
      });
    const submitted = await f.submit(),
      approval = await f.pendingApproval(submitted.runId);
    if (mutation === "prepared-input")
      (source.prepared[0]!.input as JsonObject).marker =
        "changed-after-prepare";
    else
      f.engine.registerLifecycleHook(
        hook("new-current-policy", ["before-model"], () => ({
          kind: "observe",
        })),
      );
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    await f.engine.waitForRun(submitted.runId);
    assert.equal(source.effects.length, 0);
    assert.equal(existsSync(join(f.root, "actual-effect.txt")), false);
    assert.equal(source.prepared.length, 1);
    assert.notEqual(
      f.engine.store
        .getSnapshot(f.session.id)
        .tools.find((tool) => tool.name === TOOL)!.state,
      "completed",
    );
  });

for (const invalid of [
  "wrong-hash",
  "wrong-stage",
  "getter",
  "proxy",
  "oversize",
] as const)
  test(`actual ${invalid} transform result creates no producer intent, approval or effect`, async (t) => {
    const source = authoredProducer();
    let getters = 0;
    const f = await fixture(t, {
      tools: [source.tool],
      script: toolProgram(),
      hooks: [
        hook("invalid-input-transform", ["tool-prepare"], (invocation) => {
          assert.equal(invocation.stage, "tool-prepare");
          if (invocation.stage !== "tool-prepare") return;
          if (invalid === "wrong-hash")
            return {
              kind: "rewrite-input",
              expectedInputSha256: "a".repeat(64),
              input: { marker: "unbound" },
            };
          if (invalid === "wrong-stage")
            return {
              kind: "context-data",
              expectedContextSha256: invocation.metadata.inputSha256,
              data: DATA,
            };
          const input: JsonObject =
            invalid === "oversize"
              ? { marker: "x".repeat(8192) }
              : { marker: "untrusted" };
          if (invalid === "getter")
            Object.defineProperty(input, "marker", {
              enumerable: true,
              get() {
                getters++;
                return "executable-getter";
              },
            });
          const data =
            invalid === "proxy"
              ? new Proxy(input, {
                  get() {
                    getters++;
                    throw new Error("Proxy trap must remain uncalled");
                  },
                })
              : input;
          return {
            kind: "rewrite-input",
            expectedInputSha256: invocation.metadata.inputSha256,
            input: data,
          };
        }),
      ],
    });
    const submitted = await f.submit();
    await f.engine.waitForRun(submitted.runId);
    assert.equal(source.prepared.length, 0);
    assert.equal(source.effects.length, 0);
    assert.equal(getters, 0);
    assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
    assert.equal(existsSync(join(f.root, "actual-effect.txt")), false);
    assert.ok(
      transformEvents(f).some(
        (event) => event.payload.stage === "tool-prepare",
      ),
    );
  });

test("actual model-context host data is quoted assistant content in the final native ContextRevision and owned Attempt request digest", async (t) => {
  let observed: LifecycleInvocation | undefined;
  const f = await fixture(t, {
    hooks: [
      hook("host-context", ["model-context"], (invocation) => {
        observed = invocation;
        assert.equal(invocation.stage, "model-context");
        if (invocation.stage !== "model-context") return;
        assert.equal("messages" in invocation.metadata, false);
        assert.equal("tools" in invocation.metadata, false);
        assert.equal(Object.isFrozen(invocation.metadata), true);
        return {
          kind: "context-data",
          expectedContextSha256: invocation.metadata.contextSha256,
          data: DATA,
        };
      }),
    ],
  });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!,
    message = dataMessage(request);
  assert.ok(message);
  assert.ok(message.content.includes(JSON.stringify(DATA)));
  assert.equal(request.messages.at(-1)!.content, run.prompt);
  assert.equal(request.tools.length, 0);
  const attempt = f.engine.store.getAttempt(request.attemptId!),
    revision = f.engine.store.getContextRevision(attempt.contextRevisionId!);
  assert.equal(revision.text, JSON.stringify(request.messages));
  assert.equal(revision.sha256, textSha(revision.text));
  assert.ok(revision.sourceIds.some((id) => id.includes("lifecycle")));
  const cleanup = f.engine.store.getAttemptCleanup(attempt.id);
  assert.equal(cleanup.requestSha256, sha(request));
  assert.equal(
    cleanup.requestBytes,
    Buffer.byteLength(JSON.stringify(request)),
  );
  assert.equal(cleanup.state, "confirmed");
  assert.equal(observed!.stage, "model-context");
  if (observed!.stage === "model-context")
    assert.equal(
      observed!.metadata.contextSha256,
      sha(request.messages.filter((item) => item !== message)),
    );
  const diagnostics = f.engine.context.diagnostics(f.session.id)!;
  assert.equal(
    diagnostics.lifecycleContext!.messageBytes,
    Buffer.byteLength(JSON.stringify(message)) + 1,
  );
  assert.equal(
    diagnostics.plan.reservations.lifecycleBytes,
    Buffer.byteLength(JSON.stringify(message)) + 1,
  );
  assert.equal(
    diagnostics.lifecycleContext!.dataSha256,
    sha([{ hookId: "host-context", hookRevision: 1, data: DATA }]),
  );
  assert.equal(
    diagnostics.plan.bytes,
    Buffer.byteLength(JSON.stringify(request.messages)) +
      diagnostics.plan.reservations.envelopeBytes,
  );
  assert.equal(JSON.stringify(transformEvents(f)).includes(DATA.note), false);
  assert.equal(f.count("summary_attempts"), 0);
  assert.equal(f.count("knowledge_generations"), 0);
  assert.equal(f.engine.store.listTurns(run.id).length, 1);
  assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 0);
});

test("actual same-Turn retry transforms model context once and freezes exact messages across original producer cleanup", async (t) => {
  let transforms = 0,
    returns = 0,
    calls = 0;
  const f = await fixture(t, {
    hooks: [
      hook("context-once", ["model-context"], (invocation) => {
        assert.equal(invocation.stage, "model-context");
        if (invocation.stage !== "model-context") return;
        transforms++;
        return {
          kind: "context-data",
          expectedContextSha256: invocation.metadata.contextSha256,
          data: DATA,
        };
      }),
    ],
    script() {
      const index = ++calls;
      let emitted = false;
      const iterator: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        async next() {
          if (index === 1)
            throw new EngineError(
              "PROVIDER_HTTP_ERROR",
              "Authored actual retry",
              { status: 429, retryAfterMs: 0 },
            );
          if (emitted) return { done: true, value: undefined };
          emitted = true;
          return { done: false, value: stop };
        },
        async return() {
          returns++;
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
  });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(transforms, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(calls, 2);
  assert.equal(returns, 1);
  assert.deepEqual(f.requests[1]!.messages, f.requests[0]!.messages);
  assert.equal(f.requests[1]!.turnId, f.requests[0]!.turnId);
  const attempts = f.requests.map((request) =>
    f.engine.store.getAttempt(request.attemptId!),
  );
  assert.equal(attempts[0]!.contextRevisionId, attempts[1]!.contextRevisionId);
  assert.equal(
    f.engine.store.getAttemptCleanup(attempts[0]!.id).method,
    "iterator-return-done",
  );
  assert.equal(
    f.engine.store.getAttemptCleanup(attempts[1]!.id).method,
    "iterator-next-done",
  );
  assert.equal(
    f.engine.store.getAttemptCleanup(attempts[0]!.id).state,
    "confirmed",
  );
  assert.equal(
    f.engine.store.getAttemptCleanup(attempts[1]!.id).state,
    "confirmed",
  );
  assert.equal(
    f.engine.store.getContextRevision(attempts[0]!.contextRevisionId!).text,
    JSON.stringify(f.requests[0]!.messages),
  );
  for (const request of f.requests)
    assert.equal(
      f.engine.store.getAttemptCleanup(request.attemptId!).requestSha256,
      sha(request),
    );
});

for (const interruption of ["cancel", "deadline"] as const)
  test(`actual ${interruption} during tool-input transformation cannot prepare or dispatch a late host input`, async (t) => {
    const source = authoredProducer(),
      entered = deferred<void>(),
      release = deferred<LifecycleHookResult>();
    const f = await fixture(t, {
      tools: [source.tool],
      script: toolProgram(),
      hooks: [
        hook(
          "held-input",
          ["tool-prepare"],
          (invocation) => {
            assert.equal(invocation.stage, "tool-prepare");
            entered.resolve();
            return release.promise;
          },
          {
            timeoutMs: interruption === "deadline" ? 15 : 1000,
            failurePolicy: "stop",
          },
        ),
      ],
    });
    const submitted = await f.submit();
    await entered.promise;
    if (interruption === "cancel")
      await command(f.engine, "run.cancel", { runId: submitted.runId });
    const run = await f.engine.waitForRun(submitted.runId);
    assert.equal(run.state, "cancelled");
    assert.equal(source.prepared.length, 0);
    assert.equal(source.effects.length, 0);
    assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 0);
    release.resolve({
      kind: "rewrite-input",
      expectedInputSha256: sha({ marker: "model-original" }),
      input: { marker: "late-after-terminal" },
    });
    await tick();
    assert.equal(f.engine.store.getRun(run.id).state, "cancelled");
    assert.equal(source.prepared.length, 0);
    assert.equal(source.effects.length, 0);
  });

test("actual failed post-effect hook cannot repeat an already completed transformed producer", async (t) => {
  const source = authoredProducer(),
    f = await fixture(t, {
      tools: [source.tool],
      script: toolProgram(),
      hooks: [
        hook("rewrite-effect", ["tool-prepare"], (invocation) => {
          assert.equal(invocation.stage, "tool-prepare");
          if (invocation.stage !== "tool-prepare") return;
          return {
            kind: "rewrite-input",
            expectedInputSha256: invocation.metadata.inputSha256,
            input: { marker: "physical-once" },
          };
        }),
        hook(
          "failed-after-effect",
          ["tool-settled"],
          () => {
            throw new Error("private-host-error-after-real-effect");
          },
          { failurePolicy: "stop" },
        ),
      ],
    });
  const submitted = await f.submit(),
    approval = await f.pendingApproval(submitted.runId);
  f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
  const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "cancelled");
  assert.deepEqual(source.effects, ["physical-once"]);
  assert.equal(source.prepared.length, 1);
  assert.equal(
    readFileSync(join(f.root, "actual-effect.txt"), "utf8"),
    "physical-once",
  );
  assert.equal(
    f.engine.store.getSnapshot(f.session.id).tools[0]!.state,
    "completed",
  );
  assert.equal(f.requests.length, 1);
  assert.equal(
    JSON.stringify(transformEvents(f)).includes(
      "private-host-error-after-real-effect",
    ),
    false,
  );
});

for (const invalid of ["wrong-hash", "getter", "oversize"] as const)
  test(`actual ${invalid} model-context result allocates no native Turn, Attempt or provider dispatch`, async (t) => {
    let getters = 0;
    const f = await fixture(t, {
      hooks: [
        hook("bad-context", ["model-context"], (invocation) => {
          assert.equal(invocation.stage, "model-context");
          if (invocation.stage !== "model-context") return;
          const data: JsonObject =
            invalid === "oversize"
              ? { note: "x".repeat(8192) }
              : { note: "never-admitted" };
          if (invalid === "getter")
            Object.defineProperty(data, "note", {
              enumerable: true,
              get() {
                getters++;
                return "do-not-execute";
              },
            });
          return {
            kind: "context-data",
            expectedContextSha256:
              invalid === "wrong-hash"
                ? "b".repeat(64)
                : invocation.metadata.contextSha256,
            data,
          };
        }),
      ],
    });
    const submitted = await f.submit(),
      run = await f.engine.waitForRun(submitted.runId);
    assert.ok(["failed", "cancelled"].includes(run.state));
    assert.equal(f.requests.length, 0);
    assert.equal(getters, 0);
    assert.equal(f.count("provider_attempts"), 0);
    assert.equal(f.engine.store.listTurns(run.id).length, 0);
    assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 0);
  });

for (const shortage of ["declared-slot", "serialized-entry"] as const)
  test(`actual model-context ${shortage} shortage rejects before provider without truncating host DATA or required input`, async (t) => {
    let callbacks = 0;
    const f = await fixture(t, {
      limit: 2048,
      extra: {
        lifecycleContextSlotBytes: shortage === "declared-slot" ? 8192 : 128,
      },
      hooks: [
        hook("data", ["model-context"], (invocation) => {
          assert.equal(invocation.stage, "model-context");
          if (invocation.stage !== "model-context") return;
          callbacks++;
          return {
            kind: "context-data",
            expectedContextSha256: invocation.metadata.contextSha256,
            data: { note: "whole" },
          };
        }),
      ],
    });
    const submitted = await f.submit(),
      run = await f.engine.waitForRun(submitted.runId);
    assert.equal(run.state, "failed");
    assert.equal(
      run.error?.code,
      shortage === "declared-slot"
        ? "CONTEXT_LIMIT"
        : "LIFECYCLE_CONTEXT_LIMIT",
    );
    assert.equal(callbacks, shortage === "declared-slot" ? 0 : 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.engine.store.listTurns(run.id).length, 0);
    assert.equal(
      f.engine.store
        .getSnapshot(f.session.id)
        .messages.find((message) => message.role === "user")!.content,
      run.prompt,
    );
  });

for (const mutation of [
  "registry",
  "repository",
  "context-head",
  "profile",
] as const)
  test(`actual ${mutation} changed after model-context capture cannot dispatch rewritten frozen context`, async (t) => {
    let f!: Awaited<ReturnType<typeof fixture>>,
      captured = "";
    const hooks = [
      hook("data", ["model-context"], (invocation) => {
        assert.equal(invocation.stage, "model-context");
        if (invocation.stage !== "model-context") return;
        return {
          kind: "context-data",
          expectedContextSha256: invocation.metadata.contextSha256,
          data: DATA,
        };
      }),
      hook("physical-boundary", ["before-model"], (invocation) => {
        assert.equal(invocation.stage, "before-model");
        captured = f.engine.store.getLatestContextRevision(f.session.id)!.text;
        if (mutation === "registry")
          f.engine.registerLifecycleHook(
            hook(
              "registry-changed-after-final-context",
              ["after-model"],
              () => {},
            ),
          );
        if (mutation === "repository")
          writeFileSync(
            join(f.root, "source.ts"),
            "export const actualSource = 9;\n",
          );
        if (mutation === "context-head") {
          const head = f.engine.store.getSessionDocument(
            f.session.id,
            "context.head",
          )!;
          f.engine.store.putSessionDocument(
            f.session.id,
            "context.head",
            head.revision,
            { ...head.data, revisionId: "changed-real-head-owner" },
          );
        }
        if (mutation === "profile") {
          const profile = f.engine.store.getRun(invocation.identity.runId)
            .config.agentProfileRevision!;
          const key = "profile." + sha(["bounded", profile]).slice(0, 32),
            document = f.engine.store.getSessionDocument(f.session.id, key)!;
          assert.ok(document);
          f.engine.store.putSessionDocument(
            f.session.id,
            key,
            document.revision,
            {
              ...document.data,
              instructions: "Changed after final lifecycle data",
            },
          );
        }
      }),
    ];
    f = await fixture(t, {
      hooks,
      extra: {
        ...(mutation === "repository"
          ? {
              repositoryContextPolicy: {
                query: { kind: "symbols", paths: ["source.ts"] },
                slotBytes: 4096,
                exactRanges: [
                  {
                    path: "source.ts",
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 29 },
                    },
                  },
                ],
              },
            }
          : {}),
        ...(mutation === "profile"
          ? {
              agentProfiles: [
                {
                  id: "bounded",
                  description: "Host exact profile",
                  instructions: "Original immutable instructions.",
                  tools: [],
                },
              ],
            }
          : {}),
      },
    });
    const submitted = await f.submit(
        undefined,
        undefined,
        mutation === "profile" ? { agentProfileId: "bounded" } : {},
      ),
      run = await f.engine.waitForRun(submitted.runId);
    assert.equal(
      run.state,
      "failed",
      JSON.stringify(run.error ?? { run, providerCalls: f.requests.length }),
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.count("provider_attempts"), 0);
    assert.equal(
      f.engine.store.getLatestContextRevision(f.session.id)!.text,
      captured,
    );
    assert.ok(captured.includes("host_context_exact_quoted"));
  });

async function verificationFixture(
  t: TestContext,
  input: {
    hook: LifecycleHookRegistration;
    enabled?: boolean;
    maxTurns?: number;
    noCheck?: boolean;
  },
) {
  const f = await fixture(t, {
    verification: true,
    hooks: [input.hook],
    maxTurns: input.maxTurns ?? 5,
    extra: {
      lifecycleContinuation: input.enabled !== false,
      agentProfiles: [
        {
          id: "verifier",
          description: "Actual registered command receipt owner",
          instructions: "Use only the original registered check.",
          tools: ["verify_changes", "run_command"],
        },
      ],
    },
    script(request) {
      return (async function* (): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0 && !input.noCheck) {
          yield {
            type: "tool.call",
            call: {
              id: "native-check",
              name: "verify_changes",
              input: { checkId: "actual-check" },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield {
            type: "text.delta",
            delta: "Actual completed provider boundary.",
          };
          yield stop;
        }
      })();
    },
  });
  const profile = f.engine.profiles.list()[0]!;
  f.engine.registerVerificationCheck({
    id: "actual-check",
    revision: 1,
    workspaceId: f.workspace.id,
    command: "printf verified >> actual-verification-effect.txt",
    cwd: f.root,
    profileId: profile.id,
    profileRevision: profile.revision,
    sourceRevision: "actual-transforms-source-v1",
    timeoutMs: 2000,
    maxOutputBytes: 4096,
    required: true,
  });
  await f.engine.configureVerificationSession(f.session.id, 0, {
    checkIds: ["actual-check"],
    sourcePaths: ["source.ts"],
    maxRepairs: 0,
  });
  async function run(requestId: string = randomUUID()) {
    const submitted = await f.submit(
      "Original verified continuation task.",
      requestId,
      { agentProfileId: "verifier" },
    );
    if (!input.noCheck) {
      const approval = await f.pendingApproval(submitted.runId);
      f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    }
    return { submitted, run: await f.engine.waitForRun(submitted.runId) };
  }
  return { ...f, run };
}

test(
  "actual verified native command receipt admits one same-Run lifecycle continuation with durable dedupe and original tool authority",
  { skip: process.platform === "win32" },
  async (t) => {
    let f!: Awaited<ReturnType<typeof verificationFixture>>,
      stops = 0,
      pinnedSha = "";
    f = await verificationFixture(t, {
      hook: hook(
        "native-verified-continuation",
        ["before-stop"],
        (invocation) => {
          assert.equal(invocation.stage, "before-stop");
          if (invocation.stage !== "before-stop") return;
          stops++;
          assert.equal(
            invocation.metadata.verificationSha256,
            f.engine.getVerificationCompletion(
              f.session.id,
              invocation.identity.runId,
            )!.stateSha256,
          );
          if (invocation.metadata.continuationsUsed) return { kind: "observe" };
          pinnedSha = invocation.metadata.verificationSha256!;
          assert.match(pinnedSha, /^[a-f0-9]{64}$/);
          const state = f.engine.getVerificationState(
            f.session.id,
            invocation.identity.runId,
          )!;
          assert.equal(state.receipts[0]!.status, "pass");
          assert.equal(state.receipts[0]!.observation!.cleanup.confirmed, true);
          return {
            kind: "continue",
            expectedVerificationSha256: pinnedSha,
            data: { note: "actual_native_verified_followup" },
          };
        },
      ),
    });
    const result = await f.run("native-verified-exact-request");
    assert.equal(
      result.run.state,
      "completed",
      JSON.stringify(result.run.error),
    );
    assert.equal(stops, 2);
    assert.equal(f.requests.length, 3);
    assert.equal(new Set(f.requests.map((request) => request.runId)).size, 1);
    assert.equal(f.engine.store.listTurns(result.run.id).length, 3);
    assert.equal(f.engine.store.getSnapshot(f.session.id).runs.length, 1);
    const control = f.requests[2]!.messages.find((message) =>
      message.content.startsWith("[Moodcode lifecycle continuation v1]\n"),
    );
    assert.ok(control);
    assert.equal(control.role, "user");
    const content = JSON.parse(control.content.split("\n").slice(1).join("\n"));
    assert.equal(content.verificationSha256, pinnedSha);
    assert.equal(content.authority, "control-data");
    assert.deepEqual(content.data, { note: "actual_native_verified_followup" });
    assert.deepEqual(
      f.requests[2]!.tools.map((tool) => tool.name),
      f.requests[1]!.tools.map((tool) => tool.name),
    );
    assert.equal(
      readFileSync(join(f.root, "actual-verification-effect.txt"), "utf8"),
      "verified",
    );
    assert.equal(
      f.engine.getVerificationState(f.session.id, result.run.id)!.receipts
        .length,
      1,
    );
    assert.equal(f.engine.store.getSnapshot(f.session.id).approvals.length, 1);
    assert.equal(
      f.engine.getVerificationCompletion(f.session.id, result.run.id)!.result
        .taskVerified,
      true,
    );
    const kind = "lifecycle.continuation." + sha(result.run.id).slice(0, 40),
      document = f.engine.store.getSessionDocument(f.session.id, kind)!;
    assert.ok(document);
    assert.equal(document.revision, 1);
    assert.equal(document.data.continuationsUsed, 1);
    assert.equal(document.data.executionAuthority, "none");
    assert.equal(document.data.verificationSha256, pinnedSha);
    assert.equal(
      JSON.stringify(document.data).includes("actual_native_verified_followup"),
      false,
    );
    await f.engine.waitForSession(f.session.id);
    const duplicate = await f.submit(
      "Original verified continuation task.",
      "native-verified-exact-request",
      { agentProfileId: "verifier" },
    );
    assert.equal(duplicate.runId, result.run.id);
    assert.equal(f.requests.length, 3);
    assert.equal(f.engine.store.listTurns(result.run.id).length, 3);
  },
);

for (const blocked of [
  "no-opt-in",
  "missing-receipt",
  "source-stale",
  "turn-budget",
] as const)
  test(
    `actual ${blocked} cannot allocate a lifecycle continuation Turn from a host claim`,
    { skip: process.platform === "win32" },
    async (t) => {
      let f!: Awaited<ReturnType<typeof verificationFixture>>,
        claimed = 0;
      f = await verificationFixture(t, {
        enabled: blocked !== "no-opt-in",
        noCheck: blocked === "missing-receipt",
        ...(blocked === "turn-budget" ? { maxTurns: 2 } : {}),
        hook: hook(
          "blocked-native-continuation",
          ["before-stop"],
          (invocation) => {
            assert.equal(invocation.stage, "before-stop");
            if (
              invocation.stage !== "before-stop" ||
              invocation.metadata.outcome !== "completed"
            )
              return;
            claimed++;
            const completion = f.engine.getVerificationCompletion(
              f.session.id,
              invocation.identity.runId,
            );
            assert.ok(
              completion,
              "The claim must use an actual controller observation, never synthetic proof",
            );
            const observed =
              invocation.metadata.verificationSha256 ?? completion.stateSha256;
            if (blocked === "source-stale") {
              assert.ok(invocation.metadata.verificationSha256);
              assert.equal(completion!.result.taskVerified, true);
              writeFileSync(
                join(f.root, "source.ts"),
                "export const actualSource = 3;\n",
              );
            }
            return {
              kind: "continue",
              expectedVerificationSha256: observed,
              data: { claim: "does_not_create_execution_authority" },
            };
          },
          { failurePolicy: "observe" },
        ),
      });
      const result = await f.run();
      assert.equal(claimed, 1);
      if (blocked === "no-opt-in" || blocked === "missing-receipt") {
        assert.equal(result.run.state, "completed");
        assert.ok(
          transformEvents(f).some(
            (event) =>
              event.payload.stage === "before-stop" &&
              (event.payload.outcomes as JsonObject[]).some(
                (outcome) => outcome.code === "LIFECYCLE_TRANSFORM_STALE",
              ),
          ),
        );
      }
      assert.equal(f.requests.length, blocked === "missing-receipt" ? 1 : 2);
      assert.equal(
        f.engine.store.listTurns(result.run.id).length,
        f.requests.length,
      );
      assert.equal(
        f.engine.store.getSessionDocument(
          f.session.id,
          "lifecycle.continuation." + sha(result.run.id).slice(0, 40),
        ),
        null,
      );
      if (blocked !== "missing-receipt")
        assert.equal(
          readFileSync(join(f.root, "actual-verification-effect.txt"), "utf8"),
          "verified",
        );
      else
        assert.equal(
          existsSync(join(f.root, "actual-verification-effect.txt")),
          false,
        );
      if (blocked === "source-stale") {
        assert.equal(result.run.state, "failed");
        assert.equal(result.run.error?.code, "LIFECYCLE_CONTINUATION_STALE");
      }
      if (blocked === "turn-budget") {
        assert.equal(result.run.state, "failed");
        assert.equal(result.run.error?.code, "TURN_LIMIT");
      }
    },
  );

test(
  "actual second valid native continuation request cannot reset the original per-Run ceiling",
  { skip: process.platform === "win32" },
  async (t) => {
    let stops = 0;
    const f = await verificationFixture(t, {
      hook: hook(
        "repeat-native-continuation",
        ["before-stop"],
        (invocation) => {
          assert.equal(invocation.stage, "before-stop");
          if (
            invocation.stage !== "before-stop" ||
            invocation.metadata.outcome !== "completed"
          )
            return;
          stops++;
          assert.ok(invocation.metadata.verificationSha256);
          return {
            kind: "continue",
            expectedVerificationSha256: invocation.metadata.verificationSha256,
            data: { ordinal: stops },
          };
        },
      ),
    });
    const result = await f.run();
    assert.equal(result.run.state, "cancelled");
    assert.ok(
      transformEvents(f).some(
        (event) =>
          event.payload.stage === "before-stop" &&
          (event.payload.outcomes as JsonObject[]).some(
            (outcome) => outcome.code === "LIFECYCLE_TRANSFORM_LIMIT",
          ),
      ),
    );
    assert.equal(stops, 2);
    assert.equal(f.requests.length, 3);
    assert.equal(f.engine.store.listTurns(result.run.id).length, 3);
    assert.equal(
      readFileSync(join(f.root, "actual-verification-effect.txt"), "utf8"),
      "verified",
    );
    const receipt = f.engine.store.getSessionDocument(
      f.session.id,
      "lifecycle.continuation." + sha(result.run.id).slice(0, 40),
    )!;
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.data.continuationsUsed, 1);
  },
);

for (const interruption of ["cancel", "deadline"] as const)
  test(`actual ${interruption} in model-context prevents native intent and ignores a late DATA result`, async (t) => {
    const entered = deferred<void>(),
      release = deferred<LifecycleHookResult>();
    let originalSha = "";
    const f = await fixture(t, {
      hooks: [
        hook(
          "pending-model-context",
          ["model-context"],
          (invocation) => {
            assert.equal(invocation.stage, "model-context");
            if (invocation.stage !== "model-context") return;
            originalSha = invocation.metadata.contextSha256;
            entered.resolve();
            return release.promise;
          },
          {
            timeoutMs: interruption === "deadline" ? 15 : 1000,
            failurePolicy: "stop",
          },
        ),
      ],
    });
    const submitted = await f.submit();
    await entered.promise;
    if (interruption === "cancel")
      await command(f.engine, "run.cancel", { runId: submitted.runId });
    const run = await f.engine.waitForRun(submitted.runId);
    assert.equal(run.state, "cancelled");
    assert.equal(f.requests.length, 0);
    assert.equal(f.count("provider_attempts"), 0);
    assert.equal(f.engine.store.listTurns(run.id).length, 0);
    release.resolve({
      kind: "context-data",
      expectedContextSha256: originalSha,
      data: DATA,
    });
    await tick();
    assert.equal(f.requests.length, 0);
    assert.equal(f.engine.store.getRun(run.id).state, "cancelled");
    assert.equal(f.engine.store.getLatestContextRevision(f.session.id), null);
  });

test("actual required imported image and exact user exchange survive lifecycle context reservation without copying bytes into native context", async (t) => {
  const f = await fixture(t, {
    imageInput: true,
    limit: 4096,
    extra: { lifecycleContextSlotBytes: 512 },
    hooks: [
      hook("image-context-data", ["model-context"], (invocation) => {
        assert.equal(invocation.stage, "model-context");
        if (invocation.stage !== "model-context") return;
        assert.equal("attachments" in invocation.metadata, false);
        return {
          kind: "context-data",
          expectedContextSha256: invocation.metadata.contextSha256,
          data: DATA,
        };
      }),
    ],
  });
  const bytes = png(),
    ref = await f.engine.importImage(f.session.id, bytes, "image/png"),
    prompt = "Preserve this exact current image request 한글😀.";
  const submitted = await command<RunReceipt>(f.engine, "run.submit", {
      sessionId: f.session.id,
      requestId: "actual-media-and-transform",
      prompt,
      attachments: [ref] as unknown as JsonObject[],
    }),
    run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!,
    user = request.messages.findLast((message) => message.role === "user")!;
  assert.equal(user.content, prompt);
  assert.deepEqual(user.attachments, [ref]);
  assert.deepEqual(request.resolvedImages, [
    { attachment: ref, data: bytes.toString("base64") },
  ]);
  assert.ok(dataMessage(request));
  const attempt = f.engine.store.getAttempt(request.attemptId!),
    revision = f.engine.store.getContextRevision(attempt.contextRevisionId!);
  assert.equal(revision.text, JSON.stringify(request.messages));
  assert.equal(revision.text.includes(bytes.toString("base64")), false);
  const originalProjection = { ...request };
  delete originalProjection.resolvedImages;
  assert.equal(
    f.engine.store.getAttemptCleanup(attempt.id).requestSha256,
    sha(originalProjection),
  );
  const plan = f.engine.context.diagnostics(f.session.id)!.plan;
  assert.equal(
    plan.bytes,
    Buffer.byteLength(JSON.stringify(request.messages)) +
      plan.reservations.envelopeBytes,
  );
  assert.ok(plan.bytes <= 4096);
});

const KEY = "transforms.native.memory";
const KNOWLEDGE =
  "approved_lifecycle_shared_knowledge: exact original body 한글😀.\n";
async function publishActualKnowledge(f: Awaited<ReturnType<typeof fixture>>) {
  writeFileSync(
    join(f.root, "knowledge-source.ts"),
    "export const actualKnowledgeOrigin = 1;\n",
  );
  writeFileSync(
    join(f.root, "AGENTS.md"),
    "Original independently approved source instructions.\n",
  );
  const sourceRun = await f.submit(
      "Produce real completed source for independent host publication.",
    ),
    completed = await f.engine.waitForRun(sourceRun.runId);
  assert.equal(completed.state, "completed");
  await f.engine.waitForSession(f.session.id);
  const message = f.engine.store
    .getSnapshot(f.session.id)
    .messages.find(
      (item) => item.role === "assistant" && item.runId === sourceRun.runId,
    )!;
  assert.ok(message);
  const trust = await f.engine.setWorkspaceTrust({
    workspaceId: f.workspace.id,
    requestId: "actual-transform-trust",
    expectedRevision: 0,
    decision: "allow",
    preview: f.engine.previewWorkspaceTrust(f.workspace.id, ["AGENTS.md"]),
  });
  const projection = f.engine.captureWorkspaceKnowledgeSources(f.workspace.id, [
    { kind: "file", path: "knowledge-source.ts" },
    {
      kind: "message",
      sessionId: f.session.id,
      runId: sourceRun.runId,
      messageId: message.id,
    },
  ]);
  const request = f.engine.previewWorkspaceKnowledgeGeneration({
    providerId: f.provider.id,
    modelId: "fixture-model",
    projection,
  });
  const plan = await f.engine.prepareWorkspaceKnowledgeGeneration({
    workspaceId: f.workspace.id,
    requestId: "actual-transform-host-plan",
    expectedTrustRevision: trust.revision,
    projection,
    target: f.engine.captureWorkspaceKnowledgeDocumentTarget(
      f.workspace.id,
      KEY,
    ),
    providerId: f.provider.id,
    modelId: "fixture-model",
    requestSha256: request.requestSha256,
    requestBytes: request.requestBytes,
    maxOutputBytes: 4096,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  const generated = await f.engine.generateWorkspaceKnowledge({
    workspaceId: f.workspace.id,
    planId: plan.id,
    requestId: "actual-transform-host-generation",
    projection,
  });
  assert.equal(generated.generation.state, "completed");
  assert.ok(generated.candidate);
  assert.equal(generated.candidate.body, KNOWLEDGE);
  const publication = await f.engine.publishWorkspaceKnowledge({
    workspaceId: f.workspace.id,
    requestId: "actual-transform-host-publish",
    approved: true,
    preview: f.engine.previewWorkspaceKnowledgePublication({
      workspaceId: f.workspace.id,
      candidateId: generated.candidate.id,
    }),
  });
  assert.equal(publication.document.body, KNOWLEDGE);
  return publication;
}

for (const sourceChanged of [false, true])
  test(`actual ${sourceChanged ? "knowledge source changed after capture" : "joint lifecycle repository and knowledge"} context preserves current authority and one shared byte reservation`, async (t) => {
    let f!: Awaited<ReturnType<typeof fixture>>,
      publication:
        Awaited<ReturnType<typeof publishActualKnowledge>> | undefined,
      captured = "";
    f = await fixture(t, {
      generationBody: KNOWLEDGE,
      limit: 16384,
      hooks: [
        hook("joint-host-data", ["model-context"], (invocation) => {
          assert.equal(invocation.stage, "model-context");
          if (invocation.stage !== "model-context") return;
          return {
            kind: "context-data",
            expectedContextSha256: invocation.metadata.contextSha256,
            data: DATA,
          };
        }),
        hook("approved-source-boundary", ["before-model"], () => {
          if (!sourceChanged || !publication) return;
          captured = f.engine.store.getLatestContextRevision(
            f.session.id,
          )!.text;
          writeFileSync(
            join(f.root, "knowledge-source.ts"),
            "export const actualKnowledgeOrigin = 9;\n",
          );
        }),
      ],
      extra: {
        lifecycleContextSlotBytes: 512,
        knowledgeGeneration: true,
        knowledgePublication: true,
        knowledgeContextPolicy: { documentKeys: [KEY], slotBytes: 4096 },
        repositoryContextPolicy: {
          query: { kind: "symbols", paths: ["source.ts"] },
          slotBytes: 4096,
          exactRanges: [
            {
              path: "source.ts",
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 29 },
              },
            },
          ],
        },
      },
    });
    publication = await publishActualKnowledge(f);
    const beforeCodingDispatches = f.requests.length,
      beforeGenerations = f.count("knowledge_generations"),
      submitted = await f.submit(
        'Keep original current consumer goal "quotes" 한글😀.',
      ),
      run = await f.engine.waitForRun(submitted.runId);
    assert.equal(f.count("knowledge_generations"), beforeGenerations);
    assert.equal(beforeGenerations, 1);
    if (sourceChanged) {
      assert.equal(run.state, "failed", JSON.stringify(run.error));
      assert.equal(f.requests.length, beforeCodingDispatches);
      assert.equal(
        f.engine.store.getLatestContextRevision(f.session.id)!.text,
        captured,
      );
      assert.ok(captured.includes("approved_lifecycle_shared_knowledge"));
      assert.ok(captured.includes("host_context_exact_quoted"));
      assert.ok(run.error?.code.startsWith("KNOWLEDGE_"));
      return;
    }
    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.equal(f.requests.length, beforeCodingDispatches + 1);
    const request = f.requests.at(-1)!,
      lifecycle = dataMessage(request)!,
      knowledge = request.messages.find((item) =>
        item.content.includes("approved_lifecycle_shared_knowledge"),
      )!,
      repository = request.messages.find((item) =>
        item.content.startsWith("Observed repository evidence."),
      )!;
    assert.ok(lifecycle);
    assert.ok(knowledge);
    assert.ok(repository);
    assert.equal(knowledge.role, "assistant");
    assert.ok(knowledge.content.includes(JSON.stringify(KNOWLEDGE)));
    assert.equal(request.messages.at(-1)!.content, run.prompt);
    const diagnostics = f.engine.context.diagnostics(f.session.id)!,
      plan = diagnostics.plan;
    assert.equal(
      plan.reservations.lifecycleBytes,
      Buffer.byteLength(JSON.stringify(lifecycle)) + 1,
    );
    assert.equal(
      plan.reservations.knowledgeBytes,
      Buffer.byteLength(JSON.stringify(knowledge)) + 1,
    );
    assert.equal(
      plan.reservations.repositoryBytes,
      Buffer.byteLength(JSON.stringify(repository)) + 1,
    );
    assert.equal(
      plan.bytes,
      Buffer.byteLength(JSON.stringify(request.messages)) +
        plan.reservations.envelopeBytes,
    );
    assert.ok(plan.bytes <= 16384);
    assert.equal(
      diagnostics.knowledgeContext!.documents[0]!.documentRevisionId,
      publication.document.id,
    );
    assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 0);
    assert.equal(f.engine.store.listCheckpoints(run.id).length, 0);
    assert.equal(f.count("summary_attempts"), 0);
  });
