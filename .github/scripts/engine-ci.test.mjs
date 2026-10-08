import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandPlan,
  PROJECTS,
  WINDOWS_STORAGE_TESTS,
  windowsTestFiles,
  validateLocalReport,
} from "./engine-ci.mjs";

test("headless compiler scope contains no desktop project and no GUI launcher", () => {
  assert.deepEqual(PROJECTS, [
    "packages/contracts",
    "packages/engine",
    "apps/engine-harness",
  ]);
  for (const operation of [
    "typecheck",
    "build",
    "test",
    "test-media-local",
    "test-hardening-cli",
    "prepare-pty",
    "eval",
    "resilience",
    "benchmark",
    "db-contract",
    "persistent-soak",
    "pty-repeatability",
    "test-windows",
  ]) {
    const plan = commandPlan(operation);
    assert.equal(plan[0], process.execPath);
    assert.ok(
      !plan.some((argument) =>
        /apps[\\/]desktop|electron(?:\.exe)?$/.test(argument),
      ),
    );
  }
  assert.throws(() => commandPlan("desktop"));
});

test("database report requires the stored catalogue and rejects incomplete or altered claims", async () => {
  const baseline = JSON.parse(
    await readFile(
      new URL(
        "../../docs/moodcode/next-db-contract-baseline.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const result = {
    ...baseline,
    runtime: { ...baseline.runtime, mode: "compiled" },
  };
  assert.equal(validateLocalReport("db-contract", result, baseline), result);
  for (const update of [
    { passed: false },
    { noLive: false },
    { runtime: { mode: "source" } },
    { comparison: { equal: false } },
    { catalogue: { ...baseline.catalogue, objects: [] } },
    { moduleSha256: null },
  ])
    assert.throws(() =>
      validateLocalReport("db-contract", { ...result, ...update }, baseline),
    );
  assert.throws(() => validateLocalReport("db-contract", result));
  const edited = structuredClone(baseline);
  edited.catalogue.objects[0].name = "changed";
  assert.throws(() => validateLocalReport("db-contract", result, edited));
});

test("report acceptance rejects false success, source drift, live claims and incomplete scenario coverage", () => {
  const identity = { runtime: "compiled", sourceSha256: "a".repeat(64) };
  const common = {
    passed: true,
    noLive: true,
    providerId: "scripted",
    modelId: "local",
    accountVerified: false,
    liveRequests: 0,
    credentialsRead: false,
    modelQualityEvaluated: false,
    sourceRuntime: { stable: true, before: identity, after: identity },
  };
  const evaluation = {
    ...common,
    schemaVersion: 2,
    kind: "engine-fixture-evaluation",
    commitMode: "approved",
    tasks: ["addition-bug", "empty-list-boundary", "two-module-change"].map(
      (taskId) => ({
        taskId,
        passed: true,
        verification: { taskVerified: true },
        checks: { processCleanupConfirmed: true },
        cleanup: { engineClosed: true, temporaryFilesRemoved: true },
        commit: {
          requested: true,
          state: "committed",
          sha: "a".repeat(40),
          duplicateNoSecondCommit: true,
        },
      }),
    ),
  };
  assert.equal(validateLocalReport("eval", evaluation), evaluation);
  for (const update of [
    { passed: false },
    { liveRequests: 1 },
    { credentialsRead: true },
    { accountVerified: true },
    { modelQualityEvaluated: true },
    { tasks: evaluation.tasks.slice(0, 2) },
    { tasks: evaluation.tasks.map(() => evaluation.tasks[0]) },
    { commitMode: "none" },
    {
      tasks: evaluation.tasks.map((task) => ({
        ...task,
        verification: { taskVerified: false },
      })),
    },
    {
      sourceRuntime: {
        ...common.sourceRuntime,
        after: { ...identity, sourceSha256: "b".repeat(64) },
      },
    },
  ])
    assert.throws(() =>
      validateLocalReport("eval", { ...evaluation, ...update }),
    );
  const benchmark = {
    ...common,
    schemaVersion: 1,
    kind: "native-engine-performance-baseline",
    absoluteTimingGate: false,
    cleanup: { engineClosed: true, temporaryFilesRemoved: true },
    fixture: {
      historyPaginationExact: true,
      reopenedWithoutProviderReplay: true,
    },
    summary: { state: "completed", cleanupConfirmed: true },
    measurements: Object.fromEntries(
      [
        "history",
        "modelHistory",
        "contextRun",
        "contextObservation",
        "metrics",
        "eventReplay",
        "summaryUsage",
        "summaryAttempt",
        "summaryList",
        "storageInspection",
      ].map((key) => [
        key,
        { latency: { count: 3, min: 0, p50: 1, p95: 2, max: 2 } },
      ]),
    ),
  };
  assert.equal(validateLocalReport("benchmark", benchmark), benchmark);
  assert.throws(() =>
    validateLocalReport("benchmark", { ...benchmark, measurements: {} }),
  );
  assert.throws(() =>
    validateLocalReport("benchmark", {
      ...benchmark,
      sourceRuntime: { ...common.sourceRuntime, stable: false },
    }),
  );
  const resilience = {
    schemaVersion: 1,
    kind: "engine-resilience-soak",
    passed: true,
    noLive: true,
    supported: true,
    runtime: { mode: "compiled" },
    iterations: 3,
    source: {
      harnessEntrySha256: "a".repeat(64),
      engineEntrySha256: "b".repeat(64),
    },
    summary: {
      completed: 3,
      failed: 0,
      cleanupFailures: 0,
      processLaunches: 3,
      providerCalls: 4,
      unknownOutcomes: 2,
    },
    results: ["complete", "cancel", "root-sigkill"].map(
      (scenario, iteration) => ({
        iteration,
        scenario,
        passed: true,
        noReplay: true,
        processLaunches: 1,
        providerCalls: {
          command: 1,
          observer: iteration === 0 ? 1 : 0,
          reopened: 0,
        },
        native: {
          sourceConfigSha256: "a".repeat(64),
          tokens: null,
          cost: null,
          cancelledInputState: "cancelled",
          pendingInputState: iteration === 0 ? "promoted" : "pending",
          resumeOutcome: iteration === 0 ? "resumed" : "cleanup-pending",
          sourceRunState: ["completed", "cancelled", "interrupted"][iteration],
          job: {
            state: iteration === 0 ? "completed" : "uncertain",
            sha256: "c".repeat(64),
            completionSha256: iteration === 2 ? null : "d".repeat(64),
          },
          beforeReopen: {
            recordsSha256: "a".repeat(64),
            counts: { runs: 1, tools: 1, session_inputs: 3 },
          },
          afterReopen: {
            recordsSha256: "b".repeat(64),
            counts: { runs: 1, tools: 1, session_inputs: 3 },
          },
        },
        cleanup: {
          engineClosed: true,
          physicalGroupAbsent: true,
          databaseRemoved: true,
        },
      }),
    ),
  };
  assert.equal(validateLocalReport("resilience", resilience), resilience);
  const knownCancellation = {
    ...resilience,
    summary: { ...resilience.summary, providerCalls: 5, unknownOutcomes: 1 },
    results: resilience.results.map((item) =>
      item.scenario === "cancel"
        ? {
            ...item,
            providerCalls: { ...item.providerCalls, reopened: 1 },
            native: {
              ...item.native,
              job: { ...item.native.job, state: "cancelled" },
              resumeOutcome: "resumed",
              pendingInputState: "promoted",
            },
          }
        : item,
    ),
  };
  assert.equal(
    validateLocalReport("resilience", knownCancellation),
    knownCancellation,
  );
  assert.throws(() =>
    validateLocalReport("resilience", {
      ...knownCancellation,
      results: knownCancellation.results.map((item) =>
        item.scenario === "cancel"
          ? {
              ...item,
              native: {
                ...item.native,
                job: { ...item.native.job, completionSha256: null },
              },
            }
          : item,
      ),
    }),
  );
  assert.throws(() =>
    validateLocalReport("resilience", {
      ...resilience,
      results: resilience.results.map((item) =>
        item.scenario === "root-sigkill"
          ? { ...item, providerCalls: { ...item.providerCalls, reopened: 1 } }
          : item,
      ),
    }),
  );
  for (const update of [
    { source: {} },
    { summary: { ...resilience.summary, processLaunches: 0 } },
    { summary: { ...resilience.summary, failed: 99 } },
    { results: resilience.results.map((item) => ({ ...item, native: null })) },
    {
      results: resilience.results.map((item) => ({
        ...item,
        processLaunches: 0,
      })),
    },
    {
      results: resilience.results.map((item) =>
        item.scenario === "root-sigkill"
          ? {
              ...item,
              native: {
                ...item.native,
                job: { ...item.native.job, state: "completed" },
              },
            }
          : item,
      ),
    },
  ])
    assert.throws(() =>
      validateLocalReport("resilience", { ...resilience, ...update }),
    );
  assert.throws(() =>
    validateLocalReport("resilience", {
      ...resilience,
      results: resilience.results.map(() => resilience.results[0]),
    }),
  );
  assert.throws(() =>
    validateLocalReport("resilience", {
      ...resilience,
      results: resilience.results.map((item) => ({
        ...item,
        cleanup: { ...item.cleanup, physicalGroupAbsent: false },
      })),
    }),
  );
  assert.throws(() =>
    validateLocalReport("resilience", { ...resilience, supported: false }),
  );
  assert.throws(() => validateLocalReport("desktop", evaluation));
});

test("standalone verification scripts trigger both path filters and POSIX checks follow build with LF or CRLF checkout", async () => {
  const source = await readFile(
    new URL("../workflows/engine.yml", import.meta.url),
    "utf8",
  );
  for (const ending of ["\n", "\r\n"]) {
    const checkout = source.replace(/\r\n?/g, "\n").replace(/\n/g, ending);
    const workflow = checkout.replace(/\r\n?/g, "\n");
    for (const event of ["pull_request", "push"]) {
      const block = workflow.split(`  ${event}:\n`)[1].split(/^  \w+:\s*$/m)[0];
      for (const path of [
        "scripts/verify-media-account*.mjs",
        "scripts/verify-provider-coverage*.mjs",
        "scripts/plan-media-verification*.mjs",
        "scripts/verify-engine-resilience*.mjs",
        "scripts/verify-engine-persistent-soak*.mjs",
        "scripts/verify-pty-repeatability*.mjs",
        "scripts/inspect-engine-db-contract*.mjs",
        "scripts/benchmark-engine.mjs",
      ])
        assert.ok(block.includes(`- "${path}"`), `${event}: ${path}`);
    }
    const posix = workflow
      .split("  posix:\n")[1]
      .split("  windows-portable:\n")[0];
    assert.match(posix, /path: artifacts\/engine-ci\/\n\s+include-hidden-files: true/);
    assert.match(
      posix,
      /run: node \.github\/scripts\/engine-ci\.mjs test-media-local/,
    );
    assert.ok(
      posix.indexOf("engine-ci.mjs build") <
        posix.indexOf("engine-ci.mjs test-media-local"),
    );
    for (const mode of [
      "resilience",
      "benchmark",
      "persistent-soak",
      "pty-repeatability",
    ]) {
      assert.ok(
        posix.includes(`run: node .github/scripts/engine-ci.mjs ${mode}`),
      );
      assert.ok(
        posix.indexOf("engine-ci.mjs build") <
          posix.indexOf(`engine-ci.mjs ${mode}`),
      );
      assert.ok(
        !workflow
          .split("  windows-portable:\n")[1]
          .includes(`engine-ci.mjs ${mode}`),
      );
      const plan = commandPlan(mode);
      assert.deepEqual(
        plan.slice(-4),
        mode === "pty-repeatability"
          ? ["--runtime", "compiled", "--iterations", "3"]
          : ["--profile", "quick", "--runtime", "compiled"],
      );
      if (mode === "pty-repeatability") assert.ok(plan.includes("--json"));
      assert.ok(!plan.includes("--live"));
    }
  }
  const plan = commandPlan("test-media-local");
  assert.deepEqual(plan.slice(0, 3), [
    process.execPath,
    "--test",
    "--test-concurrency=1",
  ]);
  assert.deepEqual(
    plan.slice(3).map((path) => path.split(/[\\/]/).at(-1)),
    ["plan-media-verification.test.mjs", "verify-media-account.test.mjs"],
  );
  assert.ok(
    !plan.some(
      (argument) => argument === "--live" || argument === "--api-key-env",
    ),
  );
});

test("Windows selection includes contracts and selected SQLite/port fixtures without POSIX process authority tests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "moodcode-ci-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [
    "packages/contracts/dist/contracts.test.js",
    ...WINDOWS_STORAGE_TESTS.map(
      (name) => `packages/engine/dist/storage/${name}.test.js`,
    ),
    "packages/engine/dist/tools/command/backends.test.js",
    "packages/engine/dist/storage/native-crash.test.js",
    "packages/engine/dist/storage/ownership.test.js",
    "packages/engine/dist/terminals/terminals.test.js",
  ];
  for (const path of paths) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, "");
  }
  const selected = await windowsTestFiles(root);
  assert.equal(selected.length, WINDOWS_STORAGE_TESTS.length + 2);
  assert.ok(
    selected.some((path) =>
      /storage[\\/]fixture-lifetime\.test\.js$/.test(path),
    ),
    "Actual SQLite connection lifetime regression is included in the portable gate",
  );
  assert.ok(
    selected.every(
      (path) => !/(?:native-crash|ownership|terminals)\.test\.js$/.test(path),
    ),
  );
  await rm(join(root, "packages/engine/dist/storage/native-inbox.test.js"));
  await assert.rejects(windowsTestFiles(root), { code: "ENOENT" });
});
