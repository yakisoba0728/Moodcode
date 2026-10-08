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
import {
  resolvePersistentSoakOptions,
  type ResolvedPersistentSoakOptions,
} from "./persistent-options.js";
import { failureOf } from "./scenarios.js";

export async function runPersistentLoad(
  f: PersistentFixture,
  options: ResolvedPersistentSoakOptions,
  sample: (phase: string) => void,
  started: number,
  disconnected = () => false,
) {
  sample("baseline");
  await f.cycle(0, "complete");
  await f.cycle(1, "cancel");
  await f.cycle(2, "text");
  sample("mandatory-cases-settled");
  let lastCycleElapsedMs = Math.round(performance.now() - started);
  let checkpoint: Awaited<ReturnType<typeof f.checkpoint>> | undefined;
  const observationStarted = performance.now(),
    deadline = observationStarted + options.durationMs,
    timedLimit = options.maxSamples - 8,
    interval = options.durationMs / (timedLimit + 1),
    optionalCycles = options.maxCycles - 3,
    commandStride = Math.max(1, Math.ceil(options.maxCycles / 88));
  let timedSamples = 0,
    nextSample = timedLimit ? observationStarted + interval : Infinity;
  while (performance.now() < deadline) {
    assert.equal(disconnected(), false, "Persistent parent disconnected");
    if (
      !checkpoint &&
      performance.now() - observationStarted >= options.durationMs / 2
    ) {
      sample("before-graceful-reopen");
      checkpoint = await f.checkpoint();
      sample("after-graceful-reopen");
    }
    const cycle = f.summary().cycles,
      nextCycle =
        observationStarted +
        ((cycle - 3) * options.durationMs) / Math.max(1, optionalCycles);
    if (
      cycle < options.maxCycles &&
      f.canAccept(checkpoint ? 7 : 8) &&
      performance.now() >= nextCycle
    ) {
      const kind =
        cycle % commandStride === 0 && f.summary().commands < 90
          ? "complete"
          : "text";
      await f.cycle(cycle, kind);
      lastCycleElapsedMs = Math.round(performance.now() - started);
    }
    if (performance.now() >= nextSample) {
      sample("timed");
      timedSamples++;
      nextSample =
        timedSamples < timedLimit
          ? observationStarted + (timedSamples + 1) * interval
          : Infinity;
    }
    const nextWork =
      f.summary().cycles < options.maxCycles && f.canAccept(checkpoint ? 7 : 8)
        ? observationStarted +
          ((f.summary().cycles - 3) * options.durationMs) /
            Math.max(1, optionalCycles)
        : deadline;
    const pause = Math.max(
      1,
      Math.min(
        250,
        nextWork - performance.now(),
        nextSample - performance.now(),
        deadline - performance.now(),
      ),
    );
    await new Promise<void>((yes) => setTimeout(yes, pause));
  }
  if (!checkpoint) {
    sample("before-graceful-reopen");
    checkpoint = await f.checkpoint();
    sample("after-graceful-reopen");
  }
  const observationEnded = performance.now(),
    startedElapsedMs = observationStarted - started,
    endedElapsedMs = observationEnded - started,
    observation = {
      startedElapsedMs,
      endedElapsedMs,
      durationMs: endedElapsedMs - startedElapsedMs,
    },
    activeDurationMs = Math.round(observationEnded - started);
  assert.ok(observation.durationMs >= options.durationMs);
  sample("load-complete");
  return { checkpoint, observation, activeDurationMs, lastCycleElapsedMs };
}

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
    const load = await runPersistentLoad(
      f,
      options,
      sample,
      started,
      () => disconnected,
    );
    const ready = await f.crashReady();
    sample("crash-ready");
    process.send!({
      type: "crash-ready",
      ...ready,
      summary: f.summary(),
      samples,
      ...load,
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
