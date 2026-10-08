import assert from "node:assert/strict";
import { bounded } from "./fixture.js";
import {
  createPersistentFixture,
  type PersistentFixture,
} from "./persistent-fixture.js";
import {
  samplePersistentResources,
  type PersistentResourceSample,
} from "./persistent-native.js";
import { resolvePersistentSoakOptions } from "./persistent-options.js";
import { failureOf } from "./scenarios.js";

if (process.argv[2] === "--persistent-soak-worker") {
  const [base, serialized] = process.argv.slice(3);
  assert.ok(base && serialized && process.send);
  const options = resolvePersistentSoakOptions(JSON.parse(serialized));
  let fixture: PersistentFixture | undefined;
  try {
    fixture = await createPersistentFixture(base, options);
    const f = fixture,
      started = performance.now(),
      samples: PersistentResourceSample[] = [];
    let disconnected = false;
    process.once("disconnect", () => {
      disconnected = true;
      void f.close().then(
        () => process.exit(1),
        () => process.exit(1),
      );
    });
    const sample = (phase: string) => {
      assert.ok(samples.length < options.maxSamples - 2);
      const value = samplePersistentResources(
        f.dbPath,
        f.artifactDir,
        phase,
        performance.now() - started,
        f.instance(),
        f.summary().cycles,
      );
      samples.push(value);
      process.send!({
        type: "progress",
        sample: value,
        cycles: f.summary().cycles,
      });
    };
    sample("baseline");
    await f.cycle(0, "complete");
    await f.cycle(1, "cancel");
    await f.cycle(2, "text");
    sample("mandatory-cases-settled");
    let lastCycleElapsedMs = Math.round(performance.now() - started);
    let checkpoint: Awaited<ReturnType<typeof f.checkpoint>> | undefined;
    const interval = options.durationMs / Math.max(1, options.maxSamples - 8);
    let nextSample = started + interval;
    const commandStride = Math.max(1, Math.ceil(options.maxCycles / 88));
    while (performance.now() - started < options.durationMs) {
      assert.equal(disconnected, false, "Persistent parent disconnected");
      let elapsed = performance.now() - started;
      if (!checkpoint && elapsed >= options.durationMs / 2) {
        sample("before-graceful-reopen");
        checkpoint = await f.checkpoint();
        sample("after-graceful-reopen");
      }
      const cycle = f.summary().cycles;
      const nextCycle =
        started + (cycle * options.durationMs) / options.maxCycles;
      if (
        cycle < options.maxCycles &&
        f.canAccept(checkpoint ? 7 : 8) &&
        performance.now() >= nextCycle
      ) {
        const kind =
          cycle !== 2 &&
          cycle % commandStride === 0 &&
          f.summary().commands < 90
            ? "complete"
            : "text";
        await f.cycle(cycle, kind);
        lastCycleElapsedMs = Math.round(performance.now() - started);
      }
      if (
        performance.now() >= nextSample &&
        samples.length < options.maxSamples - 8 + (checkpoint ? 4 : 2)
      ) {
        sample("timed");
        nextSample += interval;
      }
      elapsed = performance.now() - started;
      const nextWork =
        cycle < options.maxCycles && f.canAccept(checkpoint ? 7 : 8)
          ? nextCycle
          : started + options.durationMs;
      const pause = Math.max(
        1,
        Math.min(
          250,
          nextWork - performance.now(),
          nextSample - performance.now(),
          options.durationMs - elapsed,
        ),
      );
      if (pause > 0) await new Promise<void>((yes) => setTimeout(yes, pause));
    }
    if (!checkpoint) {
      sample("before-graceful-reopen");
      checkpoint = await f.checkpoint();
      sample("after-graceful-reopen");
    }
    const activeDurationMs = Math.round(performance.now() - started);
    assert.ok(activeDurationMs >= options.durationMs);
    sample("load-complete");
    const ready = await f.crashReady();
    sample("crash-ready");
    process.send!({
      type: "crash-ready",
      ...ready,
      summary: f.summary(),
      checkpoint,
      samples,
      activeDurationMs,
      lastCycleElapsedMs,
      loadStoppedBy:
        f.summary().cycles === options.maxCycles
          ? "cycle-ceiling"
          : !f.canAccept(4)
            ? "input-ceiling"
            : "duration",
      engineInstances: f.instance(),
    });
    await new Promise<never>(() => {});
  } catch (error) {
    let cleanupFailure: ReturnType<typeof failureOf> = null;
    if (fixture)
      try {
        await bounded(
          fixture.close(),
          options.boundaryTimeoutMs,
          "failed persistent worker close",
        );
      } catch (cleanupError) {
        cleanupFailure = failureOf(cleanupError);
      }
    if (process.connected)
      process.send!({
        type: "failure",
        failure: failureOf(error),
        cleanupFailure,
        summary: fixture?.summary() ?? null,
      });
    process.exitCode = 1;
    process.disconnect?.();
  }
}
