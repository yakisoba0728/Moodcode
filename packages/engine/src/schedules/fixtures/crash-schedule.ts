import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import type { AcceptInput, RunConfig } from "@moodcode/contracts";
import { normalizeSubmitInput } from "@moodcode/contracts/validation";
import { createEngine } from "../../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import * as nativeSchedules from "../store.js";
import {
  dispatchScheduleBoundary,
  prepareScheduleBoundary,
} from "./boundary-schedule.js";
import { scheduleInvoke } from "./schedule.js";
import { readDatabase } from "../../workflows/fixtures/archive-workflow.js";

const [dbPath, artifactDir, workspaceId, sessionId, boundary, readyPath] =
  process.argv.slice(2);
assert.ok(
  dbPath && artifactDir && workspaceId && sessionId && boundary && readyPath,
);
assert.ok(["before-accept", "after-accept"].includes(boundary));
let providerEntries = 0,
  acceptanceCalls = 0;
const provider: ProviderAdapter = {
  id: "actual-schedule-provider",
  streamTurn() {
    providerEntries++;
    const original = (async function* (): AsyncGenerator<ProviderEvent> {
      yield {
        type: "text.delta",
        delta: "Actual original scheduled provider.",
      };
      yield { type: "finish", reason: "stop" };
    })();
    return {
      [Symbol.asyncIterator]: () => ({
        next: (value?: unknown) => original.next(value),
        return: (value?: unknown) => original.return(value as never),
      }),
    };
  },
};
const config = normalizeSubmitInput({
  sessionId,
  requestId: "crash-configuration",
  prompt: "observe",
  config: {
    providerId: provider.id,
    modelId: "fixture",
    mode: "plan",
    limits: {
      maxTurns: 4,
      maxToolCalls: 4,
      maxOutputBytes: 32768,
      maxDurationMs: 30000,
    },
    budgets: { turnAllowance: 4, maxProviderAttempts: 1, retryBaseDelayMs: 0 },
  },
}).config as RunConfig;
const engine = createEngine({
    dbPath,
    artifactDir,
    schedules: true,
    providers: [provider],
    defaults: config,
  }),
  prepared = prepareScheduleBoundary(
    engine,
    workspaceId,
    sessionId,
    config,
    "crash",
    1000,
  );

function freeze() {
  const schedule = scheduleInvoke(
      engine,
      "getSchedule",
      workspaceId!,
      prepared.spec.id,
    ),
    history = scheduleInvoke(engine, "inspectSchedules", workspaceId!),
    revisions = readDatabase(dbPath!, (db) =>
      db.prepare("SELECT * FROM schedule_revisions ORDER BY id").all(),
    ),
    inputs = readDatabase(dbPath!, (db) =>
      db.prepare("SELECT * FROM session_inputs ORDER BY id").all(),
    ),
    runs = readDatabase(dbPath!, (db) =>
      db.prepare("SELECT * FROM runs ORDER BY id").all(),
    );
  const proof = {
    pid: process.pid,
    boundary,
    providerEntries,
    acceptanceCalls,
    schedule,
    history,
    occurrenceId: prepared.claimed.record.occurrenceId,
    inputRequestId: prepared.claimed.record.inputRequestId,
    revisions,
    inputs,
    runs,
  };
  writeFileSync(readyPath! + ".tmp", JSON.stringify(proof));
  renameSync(readyPath! + ".tmp", readyPath!);
  process.kill(process.pid, "SIGSTOP");
}

/** The observer forwards the original operation and freezes only after its actual durable commit. */
if (boundary === "before-accept") {
  const constructor = Reflect.get(nativeSchedules, "ScheduleStorage");
  assert.equal(typeof constructor, "function");
  const prototype = Reflect.get(constructor, "prototype"),
    original = Reflect.get(prototype, "dispatchClaim");
  assert.equal(typeof original, "function");
  Reflect.set(
    prototype,
    "dispatchClaim",
    function (this: object, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      freeze();
      return result;
    },
  );
} else {
  const original = engine.scheduler.accept.bind(engine.scheduler);
  engine.scheduler.accept = (input: AcceptInput) => {
    acceptanceCalls++;
    const receipt = original(input);
    freeze();
    return receipt;
  };
}
dispatchScheduleBoundary(engine, prepared, "crash-dispatch");
throw new Error("Actual crash observer did not reach its durable boundary");
