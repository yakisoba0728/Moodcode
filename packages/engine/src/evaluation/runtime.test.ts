import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EngineError,
  type RunReceipt,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine, type MoodcodeEngine } from "../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../ports.js";
import {
  assertIdentityStable,
  cleanup,
  command,
  distribution,
  git,
  seeded,
  sourceRuntimeIdentity,
} from "./runtime.js";

test("empirical percentiles include zero, preserve unsorted inputs, and reject fabricated nonfinite samples", () => {
  const samples = [9, 0, 4, 1, 2],
    before = [...samples],
    result = distribution(samples);
  assert.deepEqual(samples, before);
  assert.equal(result.p50, 2);
  assert.equal(result.p95, 9);
  assert.equal(result.mean, 3.2);
  assert.equal(result.method, "nearest-rank");
  for (const values of [[], [NaN], [Infinity], [-1]])
    assert.throws(() => distribution(values), /INVALID_BASELINE_SAMPLE/);
  assert.deepEqual(
    Array.from({ length: 12 }, seeded(0)),
    Array.from({ length: 12 }, seeded(0)),
  );
  assert.notDeepEqual(
    Array.from({ length: 12 }, seeded(0)),
    Array.from({ length: 12 }, seeded(1)),
  );
});

test("actual source/runtime inventory includes consumed SQL helper and rejects runtime/head/digest drift", async () => {
  const before = await sourceRuntimeIdentity();
  assert.ok(
    before.files.some(
      (pin) =>
        pin.path ===
        "packages/engine/src/storage/fixtures/summary-hotpath-benchmark.ts",
    ),
  );
  if (before.runtime === "compiled")
    assert.ok(
      before.files.some(
        (pin) =>
          pin.path ===
          "packages/engine/dist/storage/fixtures/summary-hotpath-benchmark.js",
      ),
    );
  assert.ok(
    before.files.some(
      (pin) => pin.path === "packages/engine/src/evaluation/coding.ts",
    ),
  );
  assert.ok(
    before.files.some((pin) =>
      pin.path.endsWith(
        "/evaluation/coding." + (before.runtime === "source" ? "ts" : "js"),
      ),
    ),
  );
  assertIdentityStable(before, structuredClone(before));
  for (const after of [
    { ...before, sourceSha256: "0".repeat(64) },
    { ...before, gitHead: "changed-head" },
    { ...before, runtime: "other-runtime" },
  ])
    assert.throws(
      () => assertIdentityStable(before, after),
      /BASELINE_SOURCE_CHANGED/,
    );
});

test("cleanup failure keeps fixture files and refuses confirmed cleanup or deletion credit", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "moodcode-evaluation-cleanup-"),
  );
  await writeFile(
    join(directory, "retained.txt"),
    "native evidence must survive",
  );
  const result = await cleanup(
    {
      async close() {
        throw new Error("CLEANUP_UNCERTAIN");
      },
    } as unknown as MoodcodeEngine,
    directory,
  );
  assert.equal(result.engineClosed, false);
  assert.equal(result.temporaryFilesRemoved, false);
  assert.equal(result.failure, "CLEANUP_UNCERTAIN");
  await access(join(directory, "retained.txt"));
  const settled = await cleanup(undefined, directory);
  assert.equal(settled.engineClosed, true);
  assert.equal(settled.temporaryFilesRemoved, true);
  await assert.rejects(access(directory));
});

test(
  "actual native provider uncertainty and runtime quarantine retain DB/artifacts even when genuine Engine.close resolves",
  { timeout: 20_000 },
  async () => {
    for (const mode of ["native-provider", "runtime-quarantine"] as const) {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "moodcode-evaluation-native-debt-")),
      );
      const artifactPath = join(directory, "native-evidence.txt");
      git(directory, "init", "--quiet", "--template=");
      await writeFile(
        artifactPath,
        "preserve unconfirmed native cleanup evidence",
      );
      let calls = 0,
        returns = 0;
      const provider: ProviderAdapter = {
        id: "baseline-cleanup",
        streamTurn() {
          calls++;
          if (mode === "runtime-quarantine")
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "finish", reason: "stop" } as ProviderEvent;
              },
            };
          return {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<ProviderEvent>> {
                  throw new EngineError(
                    "PROVIDER_TRANSPORT_ERROR",
                    "Local fixture failed before terminal output",
                  );
                },
                async return(): Promise<IteratorResult<ProviderEvent>> {
                  returns++;
                  return { done: false, value: { type: "progress" } };
                },
              };
            },
          };
        },
      };
      const options = {
        dbPath: join(directory, "engine.sqlite"),
        artifactDir: join(directory, "artifacts"),
        providers: [provider],
        allowedToolNames: [],
        defaults: {
          providerId: provider.id,
          modelId: "local",
          mode: "plan" as const,
          budgets: { maxProviderAttempts: 1 },
          limits: { maxDurationMs: 5_000 },
        },
      };
      const engine = createEngine(options);
      let reopened: MoodcodeEngine | undefined;
      try {
        const workspace = await command<Workspace>(engine, "workspace.open", {
          path: directory,
        });
        const session = await command<Session>(engine, "session.create", {
          workspaceId: workspace.id,
        });
        const receipt = await command<RunReceipt>(engine, "run.submit", {
          sessionId: session.id,
          requestId: "actual-cleanup-debt",
          prompt: "Local deterministic cleanup regression",
        });
        const run = await engine.waitForRun(receipt.runId);
        assert.equal(calls, 1);
        if (mode === "native-provider") {
          assert.equal(run.state, "failed");
          assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
          assert.equal(returns, 1);
          const turn = engine.store.listTurns(run.id)[0]!;
          const attempt = engine.store.getLatestAttemptForTurn(turn.id)!;
          assert.equal(attempt.state, "uncertain");
          const nativeCleanup = engine.getAttemptCleanup(
            session.id,
            attempt.id,
          );
          assert.equal(nativeCleanup.state, "uncertain");
          assert.equal(nativeCleanup.cleanupConfirmed, false);
          assert.equal(engine.store.hasUncertainWorkspace(workspace.id), true);
        } else {
          assert.equal(run.state, "completed");
          assert.equal(engine.store.hasUncertainWorkspace(workspace.id), false);
          engine.coordinator.quarantineWorkspace(workspace.id);
        }
        assert.throws(
          () =>
            engine.coordinator.assertWorkspaceCleanupConfirmed(workspace.id),
          (error) =>
            error instanceof EngineError && error.code === "CLEANUP_PENDING",
        );
        const result = await cleanup(engine, directory);
        assert.equal(result.engineClosed, true);
        assert.equal(result.temporaryFilesRemoved, false);
        assert.equal(result.retainedDirectory, directory);
        assert.equal(
          result.failure,
          mode === "native-provider"
            ? "BASELINE_NATIVE_CLEANUP_UNCERTAIN"
            : "CLEANUP_PENDING",
        );
        assert.equal(
          result.nativeCleanupConfirmed,
          mode === "native-provider" ? false : true,
        );
        assert.notEqual(result.runtimeCleanupConfirmed, true);
        await access(options.dbPath);
        assert.equal(
          await readFile(artifactPath, "utf8"),
          "preserve unconfirmed native cleanup evidence",
        );
        await assert.doesNotReject(engine.close()); // resolved original close did not erase debt or evidence
        reopened = createEngine(options);
        assert.equal(reopened.store.getRun(run.id).state, run.state);
        if (mode === "native-provider") {
          assert.equal(
            reopened.store.hasUncertainWorkspace(workspace.id),
            true,
          );
          assert.throws(
            () => reopened!.scheduler.resume(session.id),
            (error) =>
              error instanceof EngineError && error.code === "CLEANUP_PENDING",
          );
        }
        assert.equal(calls, 1);
      } finally {
        await engine.close();
        await reopened?.close();
        // Test-only teardown after preserving and independently reading native unknown evidence.
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);
