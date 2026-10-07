import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type JsonValue,
} from "@moodcode/contracts";
import type {
  PreparedTool,
  ProviderEvent,
  ToolContext,
  ToolDefinition,
} from "../ports.js";
import type { EngineOptions } from "../engine.js";
import { CommandPreflightRegistry } from "../permission/preflight.js";
import {
  ScopedToolRuntime,
  type ScopedToolRuntimeOptions,
} from "../tools/runtime/index.js";
import {
  CHANGED,
  ORIGINAL,
  digest,
  observationFixture,
  stop,
} from "./fixtures/execution-observation.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((yes) => {
    release = yes;
  });
  return { promise, release };
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof EngineError && error.code === expected;
}
function unit(t: TestContext, name = "read_file", requiresApproval = false) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "moodcode-observer-runtime-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const context: ToolContext = {
    workspace: {
      id: "workspace",
      root,
      gitRoot: root,
      branch: null,
      createdAt: new Date().toISOString(),
    },
    sessionId: "session",
    runId: "run",
    toolCallId: "call",
    turnId: "turn",
    attemptId: "attempt",
    signal: controller.signal,
    limits: { ...DEFAULT_LIMITS },
    artifactDir: root,
    recordCheckpoint() {},
  };
  const counts = {
    prepare: 0,
    execute: 0,
    revalidate: 0,
    observe: 0,
    commit: 0,
  };
  let original: PreparedTool | undefined,
    actualExecuted: PreparedTool | undefined;
  const producer: ToolDefinition = {
    name,
    description: "Original runtime boundary fixture",
    inputSchema: { type: "object" },
    async prepare(input) {
      counts.prepare++;
      original = {
        name,
        input: structuredClone(input) as JsonValue,
        fingerprint: "original-producer",
        requiresApproval,
        preview: {},
      };
      return original;
    },
    async execute(prepared) {
      counts.execute++;
      actualExecuted = prepared;
      return { content: "original producer result" };
    },
  };
  const revalidate = async () => {
    counts.revalidate++;
  };
  return {
    root,
    context,
    controller,
    counts,
    producer,
    revalidate,
    original: () => original,
    executed: () => actualExecuted,
  };
}

test("observer metadata pins exact original normalized input and registration, invokes no producer, and final callback immediately precedes the sole original execution", async (t) => {
  const f = unit(t),
    order: string[] = [];
  const originalExecute = f.producer.execute;
  f.producer.execute = async (prepared, context) => {
    order.push("producer");
    return originalExecute(prepared, context);
  };
  let runtime!: ScopedToolRuntime;
  runtime = new ScopedToolRuntime({
    workspaceSourceTools: [f.producer],
    async beforeProducer(prepared, context) {
      f.counts.observe++;
      order.push("observe");
      assert.strictEqual(context, f.context);
      const metadata = runtime.getExecutionMetadata(prepared);
      assert.equal(metadata.workspaceSource, true);
      assert.equal(Object.isFrozen(metadata), true);
      assert.equal(
        metadata.effectiveInputSha256,
        createHash("sha256")
          .update(JSON.stringify(f.original()!.input))
          .digest("hex"),
      );
      assert.deepEqual(f.counts, {
        prepare: 1,
        execute: 0,
        revalidate: 0,
        observe: 1,
        commit: 0,
      });
      return () => {
        order.push("commit");
        f.counts.commit++;
      };
    },
  });
  runtime.register("engine", f.producer);
  const prepared = await runtime
    .delegate("engine", f.producer.name)
    .prepare({ path: "source.ts" }, f.context);
  assert.throws(
    () => runtime.getExecutionMetadata({ ...prepared }),
    code("INVALID_PREPARED_TOOL"),
  );
  await runtime.execute(prepared, f.context);
  assert.deepEqual(order, ["observe", "commit", "producer"]);
  assert.strictEqual(f.executed(), f.original());
  assert.deepEqual(f.counts, {
    prepare: 1,
    execute: 1,
    revalidate: 0,
    observe: 1,
    commit: 1,
  });
  const another = new ScopedToolRuntime({ workspaceSourceTools: [f.producer] }),
    clonedDefinition = { ...f.producer };
  another.register("engine", clonedDefinition);
  const custom = await another
    .delegate("engine", clonedDefinition.name)
    .prepare({}, f.context);
  assert.equal(another.getExecutionMetadata(custom).workspaceSource, false);
});

for (const changed of [
  "policy",
  "catalogue",
  "outer",
  "inner",
  "owner",
  "cancel",
] as const)
  test(`runtime ${changed} change during the original observer await has zero dispatch callback and zero producer`, async (t) => {
    const f = unit(t),
      entered = gate(),
      resume = gate();
    const runtime = new ScopedToolRuntime({
      async beforeProducer() {
        f.counts.observe++;
        entered.release();
        await resume.promise;
        return () => {
          f.counts.commit++;
        };
      },
    });
    const unregister = runtime.register("engine", f.producer);
    const prepared = await runtime
        .delegate("engine", f.producer.name)
        .prepare({}, f.context),
      execution = runtime.execute(prepared, f.context);
    const rejection = assert.rejects(execution);
    await entered.promise;
    if (changed === "policy")
      runtime.policy.replace([{ tool: "read_file", decision: "deny" }]);
    if (changed === "catalogue") {
      unregister();
      runtime.register("engine", f.producer);
    }
    if (changed === "outer") prepared.input = { changed: true };
    if (changed === "inner") f.original()!.input = { changed: true };
    if (changed === "owner") f.context.runId = "foreign-run";
    if (changed === "cancel") f.controller.abort();
    resume.release();
    await rejection;
    assert.deepEqual(f.counts, {
      prepare: 1,
      execute: 0,
      revalidate: 0,
      observe: 1,
      commit: 0,
    });
  });

test("approval denial never calls an observer or producer, and original grant revalidation is performed only once", async (t) => {
  const denied = unit(t, "read_file", true),
    runtime = new ScopedToolRuntime({
      async beforeProducer() {
        denied.counts.observe++;
        return () => {
          denied.counts.commit++;
        };
      },
    });
  runtime.register("engine", denied.producer);
  const prepared = await runtime
    .delegate("engine", "read_file")
    .prepare({}, denied.context);
  await assert.rejects(
    runtime.executeApproved(prepared, denied.context, {
      async request(input) {
        return {
          ...input,
          id: "approval",
          status: "denied",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      decide() {
        throw new Error("Unrequested approval decision");
      },
      cancelRun() {},
    }),
    code("TOOL_APPROVAL_DENIED"),
  );
  assert.deepEqual(denied.counts, {
    prepare: 1,
    execute: 0,
    revalidate: 0,
    observe: 0,
    commit: 0,
  });
  const granted = unit(t, "read_file", true),
    allowed = new ScopedToolRuntime({
      async beforeProducer() {
        granted.counts.observe++;
        return () => {
          granted.counts.commit++;
        };
      },
    });
  allowed.register("engine", granted.producer, {
    revalidate: granted.revalidate,
  });
  allowed.grants.issue({
    workspaceId: "workspace",
    sessionId: "session",
    toolName: "read_file",
    effect: "read",
    policyVersion: allowed.policy.version,
    ttlMs: 10000,
    maxUses: 1,
  });
  const retained = await allowed
    .delegate("engine", "read_file")
    .prepare({}, granted.context);
  await allowed.execute(retained, granted.context);
  assert.deepEqual(granted.counts, {
    prepare: 1,
    execute: 1,
    revalidate: 1,
    observe: 1,
    commit: 1,
  });
});

test("preflight source revision changed during the observer's physical await rejects before dispatch and preserves the sole analyzer invocation", async (t) => {
  const f = unit(t, "run_command", true),
    registry = new CommandPreflightRegistry(),
    entered = gate(),
    resume = gate();
  let sourceRevision = "actual-source-1",
    analyses = 0;
  registry.register({
    id: "actual-analyzer",
    revision: 1,
    sourceSha256: "a".repeat(64),
    async analyze() {
      analyses++;
      return { decision: "allow", findings: [] };
    },
  });
  const commandPreflight: ScopedToolRuntimeOptions["commandPreflight"] = {
    registry,
    selectAnalyzer: () => "actual-analyzer",
    resolveSourceRevision: () => sourceRevision,
  };
  const runtime = new ScopedToolRuntime({
    commandPreflight,
    async beforeProducer() {
      f.counts.observe++;
      entered.release();
      await resume.promise;
      return () => {
        f.counts.commit++;
      };
    },
  });
  runtime.register("engine", f.producer);
  const prepared = await runtime
      .delegate("engine", "run_command")
      .prepare({ command: "actual retained command", cwd: f.root }, f.context),
    execution = runtime.execute(prepared, f.context);
  const rejection = assert.rejects(execution, code("COMMAND_PREFLIGHT_STALE"));
  await entered.promise;
  sourceRevision = "actual-source-2";
  resume.release();
  await rejection;
  assert.equal(analyses, 1);
  assert.deepEqual(f.counts, {
    prepare: 1,
    execute: 0,
    revalidate: 0,
    observe: 1,
    commit: 0,
  });
});

test("actual approved core patch whose source changes after preview has zero native diagnostic dispatch, epoch, and checkpoint", async (t) => {
  const f = await observationFixture(t, {
    script: async function* (request): AsyncGenerator<ProviderEvent> {
      if (request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: {
            id: "stale-after-source-preview",
            name: "apply_patch",
            input: {
              changes: [
                {
                  path: "source.ts",
                  expectedHash: digest(ORIGINAL),
                  content: CHANGED,
                },
              ],
            },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield stop;
    },
  });
  const submitted = await f.submit(),
    pending = await f.approval(submitted.runId),
    external = "actual external edit before approved producer\n";
  writeFileSync(join(f.root, "source.ts"), external);
  await f.decide(pending);
  const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed");
  assert.equal(f.page(run.id).items.length, 0);
  assert.equal(f.epoch(), 0);
  assert.equal(f.engine.store.listCheckpoints(run.id).length, 0);
  assert.equal(readFileSync(join(f.root, "source.ts"), "utf8"), external);
});

test("actual native read page capped by its authored line limit remains an incomplete result even when every returned JSON byte is retained", async (t) => {
  const f = await observationFixture(t, {
    setup(root) {
      writeFileSync(join(root, "source.ts"), "x\n".repeat(3000));
    },
    script: async function* (request): AsyncGenerator<ProviderEvent> {
      if (request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-capped-read",
            name: "read_file",
            input: { path: "source.ts" },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield stop;
    },
  });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId),
    rows = f.page(run.id).items;
  assert.equal(run.state, "completed");
  assert.equal(rows.length, 1);
  const row = rows[0]!,
    actualTool = f.engine.store.getToolCall(row.toolCallId),
    actualOutput = JSON.parse(actualTool.output!) as {
      truncated: boolean;
      continuation?: string;
    };
  assert.equal(actualOutput.truncated, true);
  assert.ok(actualOutput.continuation);
  assert.ok(
    Buffer.byteLength(actualTool.output!) < 32768,
    "The actual full returned JSON fits below model projection caps",
  );
  assert.equal(row.resultComplete, false);
  assert.equal(row.sourceBefore.completeness, "full");
  assert.equal(row.sourceAfter?.completeness, "full");
});

test("actual Engine database, WAL and artifacts inside its workspace remain exactly excluded from repeated physical source identity", async (t) => {
  const extra: Partial<EngineOptions> = {};
  const f = await observationFixture(t, {
    extra,
    setup(root) {
      extra.dbPath = join(root, "owned-engine.sqlite");
      extra.artifactDir = join(root, "owned-engine-artifacts");
      writeFileSync(
        join(root, "source.ts"),
        "actual first line\nactual second line\n",
      );
    },
    script: async function* (request): AsyncGenerator<ProviderEvent> {
      if (request.turnIndex < 2) {
        yield {
          type: "tool.call",
          call: {
            id: `owned-storage-read-${request.turnIndex}`,
            name: "read_file",
            input: {
              path: "source.ts",
              startLine: request.turnIndex + 1,
              endLine: request.turnIndex + 1,
            },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield stop;
    },
  });
  const submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId),
    rows = f.page(run.id).items;
  assert.equal(run.state, "completed");
  assert.equal(rows.length, 2);
  const original = rows[0]!.sourceBefore.sha256;
  assert.ok(original);
  for (const row of rows) {
    assert.equal(row.sourceBefore.completeness, "full");
    assert.equal(row.sourceBefore.sha256, original);
    assert.equal(row.sourceAfter?.sha256, original);
    assert.equal(row.effectEpochBefore, 0);
    assert.equal(row.effectEpochDispatch, 0);
    assert.equal(row.effectEpochAfter, 0);
    assert.equal(row.resultComplete, true);
  }
  assert.notEqual(rows[0]!.effectiveInputSha256, rows[1]!.effectiveInputSha256);
  const db = Reflect.get(f.engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  assert.equal(
    db
      .prepare(
        "SELECT epoch FROM diagnostic_effect_epochs WHERE workspace_id=?",
      )
      .get(f.workspace.id)?.epoch,
    0,
  );
  assert.equal(f.requests.length, 3);
});
