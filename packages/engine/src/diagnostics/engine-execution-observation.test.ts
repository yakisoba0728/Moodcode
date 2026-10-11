import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ProviderEvent, ToolDefinition } from "../ports.js";
import {
  CHANGED,
  ORIGINAL,
  digest,
  dispatch,
  errorCode,
  invoke,
  observationFixture,
  stop,
} from "./fixtures/execution-observation.js";
import type {
  DiagnosticExecutionObservation,
  DiagnosticExecutionPage,
} from "./execution-observation-types.js";

async function* readOnce(request: {
  turnIndex: number;
}): AsyncGenerator<ProviderEvent> {
  if (request.turnIndex === 0) {
    yield {
      type: "tool.call",
      call: {
        id: "actual-read",
        name: "read_file",
        input: { path: "source.ts" },
      },
    };
    yield { type: "finish", reason: "tool_calls" };
  } else {
    yield { type: "text.delta", delta: "private-completion-text" };
    yield stop;
  }
}
test("actual core read records bounded immutable before/after source and original native ownership without an effect bump", async (t) => {
  const f = await observationFixture(t, { script: readOnce }),
    submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed");
  const page = f.page(run.id);
  assert.equal(page.items.length, 1);
  const row = page.items[0]!;
  assert.equal(row.workspaceId, f.workspace.id);
  assert.equal(row.sessionId, f.session.id);
  assert.equal(row.runId, run.id);
  assert.equal(f.engine.store.getToolCall(row.toolCallId).state, "completed");
  assert.equal(f.engine.store.getAttempt(row.attemptId).runId, run.id);
  assert.equal(f.engine.store.getTurn(row.turnId).runId, run.id);
  assert.equal(row.toolName, "read_file");
  assert.equal(row.effectClass, "read");
  assert.equal(row.state, "settled");
  assert.equal(row.outcome, "completed");
  assert.equal(row.resultComplete, true);
  assert.equal(row.sourceBefore.completeness, "full");
  assert.equal(row.sourceAfter?.completeness, "full");
  assert.match(row.sourceBefore.sha256!, /^[a-f0-9]{64}$/);
  assert.equal(row.sourceAfter?.sha256, row.sourceBefore.sha256);
  assert.equal(row.effectEpochBefore, row.effectEpochDispatch);
  assert.equal(row.effectEpochAfter, row.effectEpochDispatch);
  assert.match(row.resultSha256!, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(page.items), true);
  for (const privateText of [
    ORIGINAL.trim(),
    "private-diagnostic-prompt",
    "private-completion-text",
  ])
    assert.ok(!JSON.stringify(page).includes(privateText));
  const stall = f.stall(run.id);
  assert.equal(stall.automaticAction, "none");
  assert.equal(stall.retryAuthority, false);
  assert.equal(stall.taskSuccess, "not-assessed");
});
test("diagnostic opt-in is off by default for actual coding reads", async (t) => {
  const f = await observationFixture(t, { enabled: false, script: readOnce }),
    submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed");
  assert.equal(f.page(run.id).items.length, 0);
  assert.equal(f.stall(run.id).taskSuccess, "not-assessed");
});
test("actual equivalent unchanged core reads do not execute twice or claim task success from a stall advisory", async (t) => {
  const f = await observationFixture(t, {
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex < 3) {
          yield {
            type: "tool.call",
            call: {
              id: `same-${request.turnIndex}`,
              name: "read_file",
              input: { path: "source.ts" },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed");
  assert.equal(f.page(run.id).items.length, 1);
  const tools = f.engine.store.getSnapshot(f.session.id).tools;
  assert.equal(tools.filter((row) => row.state === "completed").length, 1);
  assert.equal(
    tools.filter((row) => row.output?.includes("REPEATED_READ_TOOL_CALL"))
      .length,
    2,
  );
  assert.equal(f.stall(run.id).automaticAction, "none");
  assert.equal(f.stall(run.id).taskSuccess, "not-assessed");
});
test("actual parallel core reads beyond the in-flight capture limit complete instead of failing for source capacity", async (t) => {
  const paths = Array.from({ length: 12 }, (_, index) => `parallel-${index}.ts`);
  const f = await observationFixture(t, {
      setup(root) {
        for (const path of paths)
          writeFileSync(join(root, path), `export const value = "${path}";\n`);
      },
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0) {
          for (const path of paths)
            yield {
              type: "tool.call",
              call: { id: path, name: "read_file", input: { path } },
            };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    submitted = await f.submit({ budgets: { maxReadConcurrency: 12 } }),
    run = await f.engine.waitForRun(submitted.runId),
    tools = f.engine.store.getSnapshot(f.session.id).tools;
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(tools.length, paths.length);
  assert.ok(
    tools.every((row) => row.state === "completed"),
    JSON.stringify(tools.map((row) => [row.state, row.output])),
  );
  assert.equal(f.page(run.id).items.length, paths.length);
});
test("actual stall advisory joins a late journal window with observations past the first inspector page", async (t) => {
  const paths = Array.from({ length: 100 }, (_, index) => `early-${index}.ts`);
  const f = await observationFixture(t, {
      setup(root) {
        for (const path of [...paths, "late.ts"])
          writeFileSync(join(root, path), `export const value = "${path}";\n`);
      },
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0) {
          for (const path of paths)
            yield {
              type: "tool.call",
              call: { id: path, name: "read_file", input: { path } },
            };
          yield { type: "finish", reason: "tool_calls" };
        } else if (request.turnIndex === 1) {
          yield {
            type: "tool.call",
            call: { id: "late", name: "read_file", input: { path: "late.ts" } },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    // 101 observed reads take several seconds on hosted runners; the fixture's 12 s budget is too tight.
    submitted = await f.submit({
      limits: { maxToolCalls: 128, maxDurationMs: 60000 },
      budgets: { maxToolCallsPerTurn: 128, maxReadConcurrency: 16 },
    }),
    run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  // Pages stop at 100 rows or 1 MiB, and row size depends on which reads got a source capture.
  const first = f.page(run.id),
    items = [...first.items];
  for (let next = first.next; next !== null; ) {
    const page = f.page(run.id, { afterOrdinal: next });
    items.push(...page.items);
    next = page.next;
  }
  assert.equal(items.length, 101);
  const late = items.at(-1)!.toolCallId;
  assert.ok(!first.items.some((item) => item.toolCallId === late));
  let lateSeq = 0;
  for (let afterSeq = 0, cursor = true; cursor; ) {
    const page = f.engine.getTrajectory({
      sessionId: f.session.id,
      runId: run.id,
      afterSeq,
      limit: 100,
      maxBytes: 262_144,
    });
    for (const event of page.events)
      if (event.tool?.toolCallId === late) lateSeq = event.seq;
    cursor = page.range.inspectedThroughSeq > afterSeq;
    afterSeq = page.range.inspectedThroughSeq;
  }
  assert.ok(lateSeq > 40);
  const stall = f.engine.getStallObservation({
    sessionId: f.session.id,
    runId: run.id,
    afterSeq: lateSeq - 40,
    limit: 100,
    maxBytes: 262_144,
  });
  assert.equal(stall.signal, "no-signal");
  assert.equal(stall.reason, "changed-observation");
  assert.equal(stall.lastSeq, lateSeq);
  assert.match(stall.sourceSha256!, /^[a-f0-9]{64}$/);
});
test("actual external requested-file edit permits a fresh core read rather than the old input-only repeat guard", async (t) => {
  const f = await observationFixture(t, {
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 1)
          writeFileSync(join(f.root, "source.ts"), CHANGED);
        if (request.turnIndex < 2) {
          yield {
            type: "tool.call",
            call: {
              id: `changed-${request.turnIndex}`,
              name: "read_file",
              input: { path: "source.ts" },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId),
    rows = f.page(run.id).items;
  assert.equal(run.state, "completed");
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.sourceBefore.sha256, rows[1]!.sourceBefore.sha256);
  assert.equal(rows[0]!.effectEpochDispatch, rows[1]!.effectEpochDispatch);
  assert.notEqual(rows[0]!.resultSha256, rows[1]!.resultSha256);
  assert.equal(
    f.engine.store
      .getSnapshot(f.session.id)
      .tools.filter((row) => row.state === "completed").length,
    2,
  );
});
test("actual approved patch pins changed physical source and bumps the epoch once before its native checkpoint", async (t) => {
  const f = await observationFixture(t, {
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0) {
          yield {
            type: "tool.call",
            call: {
              id: "actual-patch",
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
    }),
    submitted = await f.submit(),
    pending = await f.approval(submitted.runId);
  const db = Reflect.get(f.engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  const originalExec = db.exec;
  let observedActualDispatch = 0;
  db.exec = (sql) => {
    originalExec.call(db, sql);
    if (observedActualDispatch !== 0 || sql.trim().toUpperCase() !== "COMMIT")
      return;
    const entry = db
      .prepare(
        "SELECT data FROM diagnostic_execution_observations WHERE run_id=? AND state=?",
      )
      .get(submitted.runId, "dispatched");
    if (!entry) return;
    const actual = JSON.parse(
      String(entry.data),
    ) as DiagnosticExecutionObservation;
    if (actual.toolName !== "apply_patch") return;
    observedActualDispatch++;
    assert.equal(actual.effectEpochDispatch, actual.effectEpochBefore + 1);
    assert.equal(
      readFileSync(join(f.root, "source.ts"), "utf8"),
      ORIGINAL,
      "Native dispatch must commit before the first physical patch effect",
    );
  };
  t.after(() => {
    db.exec = originalExec;
  });
  assert.equal(f.page(submitted.runId).items.length, 0);
  assert.equal(readFileSync(join(f.root, "source.ts"), "utf8"), ORIGINAL);
  await f.decide(pending);
  const run = await f.engine.waitForRun(submitted.runId),
    rows = f.page(run.id).items;
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.effectClass, "write");
  assert.equal(row.effectEpochDispatch, row.effectEpochBefore + 1);
  assert.equal(row.effectEpochAfter, row.effectEpochDispatch);
  assert.notEqual(row.sourceBefore.sha256, row.sourceAfter?.sha256);
  assert.equal(readFileSync(join(f.root, "source.ts"), "utf8"), CHANGED);
  assert.equal(f.engine.store.listCheckpoints(run.id).length, 1);
  assert.equal(f.stall(run.id).signal, "unknown");
  assert.equal(observedActualDispatch, 1);
});
test("actual approval denial creates no execution observation and no workspace epoch advance", async (t) => {
  const f = await observationFixture(t, {
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0) {
          yield {
            type: "tool.call",
            call: {
              id: "denied-patch",
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
    }),
    submitted = await f.submit();
  await f.decide(await f.approval(submitted.runId), "deny");
  const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(f.page(run.id).items.length, 0);
  assert.equal(readFileSync(join(f.root, "source.ts"), "utf8"), ORIGINAL);
  assert.equal(f.engine.store.listCheckpoints(run.id).length, 0);
  assert.equal(f.epoch(), 0);
});
test("actual custom producer cannot manufacture workspace source or epoch proof through its result data", async (t) => {
  let producers = 0;
  const custom: ToolDefinition = {
    name: "custom_unknown",
    description: "Independent host fixture",
    inputSchema: { type: "object" },
    async prepare(input, context) {
      return {
        name: "custom_unknown",
        input: input as {},
        fingerprint: `owned-${context.toolCallId}`,
        requiresApproval: false,
        preview: {},
      };
    },
    async execute(_prepared, context) {
      producers++;
      const actual = f.page(context.runId).items[0]!;
      assert.equal(actual.state, "dispatched");
      assert.equal(actual.effectEpochDispatch, actual.effectEpochBefore + 1);
      assert.equal(existsSync(join(f.root, "custom-effect.txt")), false);
      writeFileSync(
        join(f.root, "custom-effect.txt"),
        "actual custom producer effect",
      );
      return {
        content: "actual-custom-result",
        data: {
          sourceBefore: { completeness: "full", sha256: "f".repeat(64) },
          effectEpochDispatch: 999999,
          taskSuccess: true,
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
            call: { id: "unknown-proposal", name: custom.name, input: {} },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    submitted = await f.submit();
  await f.decide(await f.approval(submitted.runId));
  const run = await f.engine.waitForRun(submitted.runId),
    row = f.page(run.id).items[0]!;
  assert.equal(producers, 1);
  assert.equal(row.effectClass, "unknown");
  assert.equal(row.sourceBefore.completeness, "unknown");
  assert.equal(row.sourceBefore.sha256, null);
  assert.equal(row.effectEpochDispatch, row.effectEpochBefore + 1);
  assert.notEqual(row.effectEpochDispatch, 999999);
  assert.equal(f.stall(run.id).signal, "unknown");
  assert.equal(f.stall(run.id).taskSuccess, "not-assessed");
  assert.equal(
    readFileSync(join(f.root, "custom-effect.txt"), "utf8"),
    "actual custom producer effect",
  );
});

test(
  "actual read patch command sequence shares one durable workspace clock and uses actual owned command cleanup",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await observationFixture(t, {
        script: async function* (request): AsyncGenerator<ProviderEvent> {
          const index = request.turnIndex;
          if (index === 1)
            yield {
              type: "tool.call",
              call: {
                id: "clock-patch",
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
          else if (index === 3)
            yield {
              type: "tool.call",
              call: {
                id: "clock-command",
                name: "run_command",
                input: {
                  command: "printf actual-command > command-effect.txt",
                },
              },
            };
          else if (index < 5)
            yield {
              type: "tool.call",
              call: {
                id: `clock-read-${index}`,
                name: "read_file",
                input: { path: "source.ts" },
              },
            };
          if (index < 5) yield { type: "finish", reason: "tool_calls" };
          else yield stop;
        },
      }),
      submitted = await f.submit();
    await f.decide(await f.approval(submitted.runId));
    await f.decide(await f.approval(submitted.runId));
    const run = await f.engine.waitForRun(submitted.runId),
      rows = f.page(run.id).items;
    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.deepEqual(
      rows.map((row) => row.effectEpochDispatch),
      [0, 1, 1, 2, 2],
    );
    assert.deepEqual(
      rows.map((row) => row.toolName),
      ["read_file", "apply_patch", "read_file", "run_command", "read_file"],
    );
    assert.equal(
      rows.every((row) => row.state === "settled"),
      true,
    );
    assert.equal(
      rows.every((row) => row.sourceBefore.completeness === "full"),
      true,
    );
    assert.equal(
      readFileSync(join(f.root, "command-effect.txt"), "utf8"),
      "actual-command",
    );
    assert.equal(f.epoch(), 2);
    const checkpoint = f.engine.store
      .listCheckpoints(run.id)
      .find((value) => value.kind === "command");
    assert.ok(checkpoint);
    assert.notEqual(checkpoint.incomplete, true);
  },
);

test("actual Run cancellation before effect approval produces zero diagnostic dispatches and no epoch bump", async (t) => {
  const f = await observationFixture(t, {
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0) {
          yield {
            type: "tool.call",
            call: {
              id: "cancel-before-approval",
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
    }),
    submitted = await f.submit();
  await f.approval(submitted.runId);
  await dispatch(f.engine, "run.cancel", { runId: submitted.runId });
  const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "cancelled");
  assert.equal(f.page(run.id).items.length, 0);
  assert.equal(f.epoch(), 0);
  assert.equal(readFileSync(join(f.root, "source.ts"), "utf8"), ORIGINAL);
});

for (const mode of ["large", "symlink", "many-files"] as const)
  test(`actual ${mode} workspace source keeps nullable unknown provenance rather than inventing complete hashes`, async (t) => {
    const f = await observationFixture(t, {
        script: readOnce,
        setup(root) {
          if (mode === "large")
            writeFileSync(
              join(root, "oversize.bin"),
              Buffer.alloc(2 * 1024 * 1024 + 1),
            );
          if (mode === "symlink")
            symlinkSync("source.ts", join(root, "alias.ts"));
          if (mode === "many-files") {
            mkdirSync(join(root, "many"));
            for (let i = 0; i < 1025; i++)
              writeFileSync(join(root, `many/source-${i}.ts`), "");
          }
        },
      }),
      submitted = await f.submit(),
      run = await f.engine.waitForRun(submitted.runId),
      row = f.page(run.id).items[0]!;
    assert.equal(run.state, "completed");
    assert.equal(row.sourceBefore.completeness, "unknown");
    assert.equal(row.sourceBefore.sha256, null);
    assert.equal(row.sourceAfter?.completeness, "unknown");
    assert.equal(row.effectEpochDispatch, row.effectEpochBefore);
    assert.equal(f.stall(run.id).signal, "unknown");
  });

test("actual inspector pages stay bounded and never read full session snapshots, run recovery, prepare or execute producers", async (t) => {
  const f = await observationFixture(t, {
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex < 3) {
          yield {
            type: "tool.call",
            call: {
              id: `bounded-${request.turnIndex}`,
              name: "read_file",
              input: { path: "source.ts", startLine: request.turnIndex + 1 },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  const originalSnapshot = f.engine.store.getSnapshot,
    originalRecovery = f.engine.store.recoverInterrupted;
  let forbidden = 0;
  f.engine.store.getSnapshot = () => {
    forbidden++;
    throw new Error("Full snapshot forbidden");
  };
  f.engine.store.recoverInterrupted = () => {
    forbidden++;
    throw new Error("Recovery forbidden");
  };
  t.after(() => {
    f.engine.store.getSnapshot = originalSnapshot;
    f.engine.store.recoverInterrupted = originalRecovery;
  });
  const first = f.page(run.id, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.next !== null);
  const rest = f.page(run.id, {
    afterOrdinal: first.next!,
    throughOrdinal: first.throughOrdinal,
    limit: 100,
  });
  assert.equal(rest.items.length, 2);
  assert.equal(
    new Set([...first.items, ...rest.items].map((row) => row.id)).size,
    3,
  );
  assert.ok(first.bytes <= 1048576);
  assert.equal(forbidden, 0);
  assert.equal(f.requests.length, 4);
  f.stall(run.id);
  assert.equal(forbidden, 0);
});

test("actual inspector rejects foreign Run selection and hostile selection accessors before reading or invoking their values", async (t) => {
  const f = await observationFixture(t, { script: readOnce }),
    submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId);
  const selection = { workspaceId: f.workspace.id, runId: run.id };
  let traps = 0;
  Object.defineProperty(selection, "runId", {
    enumerable: true,
    get() {
      traps++;
      throw new Error("Getter");
    },
  });
  assert.throws(() =>
    invoke<DiagnosticExecutionPage>(
      f.engine,
      "getExecutionObservations",
      selection,
    ),
  );
  assert.throws(() =>
    invoke<DiagnosticExecutionPage>(
      f.engine,
      "getExecutionObservations",
      new Proxy(
        {},
        {
          ownKeys() {
            traps++;
            throw new Error("Proxy");
          },
        },
      ),
    ),
  );
  assert.equal(traps, 0);
  assert.throws(
    () =>
      invoke<DiagnosticExecutionPage>(
        f.engine,
        "getExecutionObservations",
        Object.defineProperty(
          { workspaceId: f.workspace.id, runId: run.id },
          "limit",
          { value: 1 },
        ),
      ),
    errorCode("INVALID_EXECUTION_OBSERVATION"),
  );
  const other = await observationFixture(t, { script: readOnce });
  assert.throws(
    () =>
      invoke<DiagnosticExecutionPage>(f.engine, "getExecutionObservations", {
        workspaceId: other.workspace.id,
        runId: run.id,
      }),
    errorCode("RECORD_SCOPE_MISMATCH"),
  );
});

for (const boundary of ["dispatched", "produced"] as const)
  test(
    `actual SIGKILL after ${boundary} diagnostic boundary preserves its epoch and native uncertainty without tool replay`,
    { skip: process.platform === "win32", timeout: 15000 },
    async (t) => {
      const f = await observationFixture(t, { script: readOnce });
      await f.engine.close();
      const here = dirname(fileURLToPath(import.meta.url)),
        ready = join(f.base, `actual-${boundary}-ready.json`),
        childPath = join(
          here,
          `fixtures/execution-observation-crash-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
        ),
        loader = resolve(here, "../../../../node_modules/tsx/dist/loader.mjs");
      const child = spawn(
        process.execPath,
        [
          "--import",
          loader,
          childPath,
          f.dbPath,
          join(f.base, "artifacts"),
          f.workspace.id,
          f.session.id,
          ready,
          boundary,
        ],
        { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (value) => {
        stderr += String(value);
      });
      child.stdout.resume();
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      const ended = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((yes, no) => {
        child.once("error", no);
        child.once("exit", (code, signal) => yes({ code, signal }));
      });
      clearTimeout(timer);
      assert.equal(ended.signal, "SIGKILL", stderr);
      assert.equal(existsSync(ready), true, stderr);
      const actual = JSON.parse(readFileSync(ready, "utf8")) as {
        boundary: string;
        observationId: string;
        runId: string;
        toolCallId: string;
        epoch: number;
      };
      assert.equal(actual.boundary, boundary);
      assert.equal(actual.epoch, 1);
      const db = new DatabaseSync(f.dbPath, { readOnly: true });
      try {
        const data = db
          .prepare(
            "SELECT data FROM diagnostic_execution_observations WHERE id=?",
          )
          .get(actual.observationId);
        assert.ok(data);
        const row = JSON.parse(
          String(data.data),
        ) as DiagnosticExecutionObservation;
        assert.equal(row.state, "dispatched");
        assert.equal(row.effectEpochDispatch, 1);
      } finally {
        db.close();
      }
      const reopened = f.reopen(),
        row = f.page(actual.runId, {}, reopened).items[0]!;
      assert.equal(row.state, "interrupted");
      assert.equal(row.outcome, "unknown");
      assert.equal(row.resultComplete, false);
      assert.equal(row.resultSha256, null);
      assert.equal(row.sourceAfter, null);
      assert.equal(row.effectEpochDispatch, 1);
      assert.equal(f.epoch(), 1);
      assert.equal(
        readFileSync(join(f.root, "source.ts"), "utf8"),
        boundary === "dispatched" ? ORIGINAL : CHANGED,
      );
      assert.equal(f.requests.length, 0);
      assert.equal(reopened.store.getRun(actual.runId).state, "interrupted");
    },
  );
test("actual settled observation survives same physical Engine close and restart with no producer replay", async (t) => {
  const f = await observationFixture(t, { script: readOnce }),
    submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId),
    before = f.page(run.id);
  await f.engine.close();
  const reopened = f.reopen();
  assert.deepEqual(f.page(run.id, {}, reopened), before);
  assert.equal(f.requests.length, 2);
});

test("actual active custom execution remains incomplete and cannot produce a no-stall or success claim", async (t) => {
  let start!: () => void,
    release!: () => void,
    producers = 0;
  const ready = new Promise<void>((resolve) => {
      start = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const custom: ToolDefinition = {
    name: "actual_pending_unknown",
    description: "Real host producer pending original promise",
    inputSchema: { type: "object" },
    async prepare(_input, context) {
      return {
        name: "actual_pending_unknown",
        input: {},
        fingerprint: context.toolCallId,
        requiresApproval: true,
        preview: {},
      };
    },
    async execute() {
      producers++;
      start();
      await gate;
      return { content: "Real original producer settled." };
    },
  };
  const f = await observationFixture(t, {
      extra: { tools: [custom] },
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0) {
          yield {
            type: "tool.call",
            call: { id: "actual-pending", name: custom.name, input: {} },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    submitted = await f.submit();
  await f.decide(await f.approval(submitted.runId));
  await ready;
  try {
    const row = f.page(submitted.runId).items[0]!;
    assert.equal(row.state, "dispatched");
    assert.equal(row.resultComplete, false);
    assert.equal(row.resultSha256, null);
    assert.equal(row.sourceAfter, null);
    const stall = f.stall(submitted.runId);
    assert.equal(stall.signal, "unknown");
    assert.equal(stall.automaticAction, "none");
    assert.equal(stall.taskSuccess, "not-assessed");
    assert.equal(producers, 1);
    assert.equal(f.requests.length, 1);
  } finally {
    release();
  }
  const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed");
  assert.equal(producers, 1);
  assert.equal(f.page(run.id).items[0]!.state, "settled");
});

test("actual host custom read declaration cannot turn repeated result strings into authenticated core source coverage", async (t) => {
  let producers = 0;
  const custom: ToolDefinition = {
    name: "custom_declared_read",
    effectClass: "read",
    description: "Custom source cannot be authenticated by a model result",
    inputSchema: { type: "object" },
    async prepare(_input, context) {
      return {
        name: "custom_declared_read",
        input: {},
        fingerprint: context.toolCallId,
        requiresApproval: false,
        preview: {},
      };
    },
    async execute() {
      producers++;
      return {
        content: "same-custom-read-result",
        data: { sourceSha256: "a".repeat(64), completeness: "full" },
      };
    },
  };
  const f = await observationFixture(t, {
      extra: { tools: [custom] },
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex < 3) {
          yield {
            type: "tool.call",
            call: {
              id: `custom-read-${request.turnIndex}`,
              name: custom.name,
              input: {},
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield stop;
      },
    }),
    submitted = await f.submit(),
    run = await f.engine.waitForRun(submitted.runId),
    rows = f.page(run.id).items;
  assert.equal(run.state, "completed");
  assert.equal(producers, 3);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.inputSha256)).size, 1);
  assert.equal(new Set(rows.map((row) => row.resultSha256)).size, 1);
  assert.equal(
    rows.every(
      (row) =>
        row.sourceBefore.completeness === "unknown" &&
        row.sourceBefore.sha256 === null &&
        row.effectEpochDispatch === 0,
    ),
    true,
  );
  const stall = f.stall(run.id);
  assert.equal(stall.signal, "unknown");
  assert.equal(stall.reason, "incomplete-provenance");
  assert.equal(stall.taskSuccess, "not-assessed");
});

test("actual source change while exact patch approval is pending rejects dispatch before its producer and epoch mutation", async (t) => {
  const f = await observationFixture(t, {
      setup(root) {
        writeFileSync(
          join(root, "independent.ts"),
          "export const independent = 1;\n",
        );
      },
      script: async function* (request): AsyncGenerator<ProviderEvent> {
        if (request.turnIndex === 0) {
          yield {
            type: "tool.call",
            call: {
              id: "stale-source-patch",
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
    }),
    submitted = await f.submit(),
    approval = await f.approval(submitted.runId);
  writeFileSync(
    join(f.root, "independent.ts"),
    "export const independent = 2;\n",
  );
  await f.decide(approval);
  const run = await f.engine.waitForRun(submitted.runId);
  assert.equal(f.page(run.id).items.length, 0);
  assert.equal(f.epoch(), 0);
  assert.equal(f.engine.store.listCheckpoints(run.id).length, 0);
  assert.equal(readFileSync(join(f.root, "source.ts"), "utf8"), ORIGINAL);
  const tool = f.engine.store
    .getSnapshot(f.session.id)
    .tools.find((value) => value.name === "apply_patch");
  assert.ok(tool);
  assert.equal(tool.state, "failed");
  assert.ok(tool.output?.includes("EXECUTION_SOURCE_STALE"));
});
