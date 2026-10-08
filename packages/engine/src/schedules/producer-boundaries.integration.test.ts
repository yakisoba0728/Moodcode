import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../ports.js";
import {
  exportEngineArchive,
  importEngineArchive,
  validateEngineArchive,
} from "../storage/archive.js";
import { DB_VERSION } from "../storage/migrations.js";
import { readDatabase } from "../workflows/fixtures/archive-workflow.js";
import type {
  SchedulerLeaseResult,
  ScheduleRevision,
  TriggerOccurrence,
} from "./store.js";
import {
  dispatchScheduleBoundary,
  prepareScheduleBoundary,
} from "./fixtures/boundary-schedule.js";
import {
  scheduleCommand,
  scheduleFixture,
  scheduleInvoke,
  scheduleUntil,
} from "./fixtures/schedule.js";

type Row = Record<string, unknown>;
const here = dirname(fileURLToPath(import.meta.url)),
  loader = resolve(here, "../../../../node_modules/tsx/dist/loader.mjs"),
  childPath = join(
    here,
    `fixtures/crash-schedule${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  );
function nativeRows(file: string) {
  return readDatabase(file, (db) =>
    Object.fromEntries(
      [
        "schedule_revisions",
        "schedule_heads",
        "session_inputs",
        "runs",
        "provider_attempts",
      ].map((table) => [
        table,
        db
          .prepare(
            `SELECT * FROM ${table} ORDER BY ${table === "schedule_heads" ? "entity_id" : "id"}`,
          )
          .all()
          .map((row) => ({ ...row })),
      ]),
    ),
  );
}
function occurrence(file: string, id: string): TriggerOccurrence {
  return readDatabase(file, (db) => {
    const row = db
      .prepare(
        "SELECT r.data FROM schedule_heads h JOIN schedule_revisions r ON r.id=h.revision_id WHERE h.kind='occurrence' AND h.entity_id=?",
      )
      .get(id);
    assert.ok(row, "Actual native occurrence head exists");
    return JSON.parse(String(row.data)) as TriggerOccurrence;
  });
}
const code =
  (...expected: string[]) =>
  (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.ok(
      expected.includes(error.code),
      `Expected ${expected.join("|")}, received ${error.code}`,
    );
    return true;
  };

for (const boundary of ["before-accept", "after-accept"] as const)
  test(
    `actual SIGKILL ${boundary} leaves native intent uncertain and never replays durable queue delivery after restart`,
    { skip: process.platform === "win32", timeout: 20000 },
    async (t) => {
      const f = await scheduleFixture(t);
      await f.engine.close();
      const ready = join(f.base, "schedule-atomic-ready.json"),
        child = spawn(
          process.execPath,
          [
            "--import",
            loader,
            childPath,
            f.dbPath,
            f.artifactDir,
            f.workspace.id,
            f.session.id,
            boundary,
            ready,
          ],
          { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] },
        );
      let output = "",
        exited = false;
      const collect = (bytes: Buffer) => {
        output = (output + bytes.toString("utf8")).slice(-32768);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const exit = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          exited = true;
          done({ code, signal });
        });
      });
      t.after(async () => {
        if (!exited) child.kill("SIGKILL");
        await exit;
      });
      const deadline = Date.now() + 12000;
      while (!existsSync(ready)) {
        assert.equal(exited, false, output);
        assert.ok(
          Date.now() < deadline,
          "No original durable scheduled boundary: " + output,
        );
        await new Promise((done) => setTimeout(done, 8));
      }
      const proof = JSON.parse(readFileSync(ready, "utf8")) as {
        pid: number;
        boundary: string;
        occurrenceId: string;
        inputRequestId: string;
        providerEntries: number;
        acceptanceCalls: number;
        revisions: Row[];
        inputs: Row[];
        runs: Row[];
      };
      assert.equal(proof.pid, child.pid);
      assert.equal(proof.boundary, boundary);
      assert.equal(proof.providerEntries, 0);
      assert.equal(proof.acceptanceCalls, boundary === "after-accept" ? 1 : 0);
      assert.equal(proof.inputs.length, boundary === "after-accept" ? 1 : 0);
      assert.equal(proof.runs.length, 0);
      assert.equal(
        occurrence(f.dbPath, proof.occurrenceId).state,
        "dispatching",
      );
      const receipts = proof.revisions
        .filter((row) => row.kind === "transition")
        .map((row) => JSON.parse(String(row.data)) as Row);
      assert.ok(receipts.some((row) => row.requestId === "crash-dispatch"));
      assert.equal(
        receipts.some((row) => row.operation === "accepted"),
        false,
      );
      assert.equal(child.kill("SIGKILL"), true);
      assert.equal((await exit).signal, "SIGKILL");
      const baseline = nativeRows(f.dbPath);
      let reopenedProviderEntries = 0;
      const provider: ProviderAdapter = {
        id: "actual-schedule-provider",
        streamTurn() {
          reopenedProviderEntries++;
          const original = (async function* (): AsyncGenerator<ProviderEvent> {
            yield { type: "finish", reason: "stop" };
          })();
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => original.next(),
              return: () => original.return(undefined as never),
            }),
          };
        },
      };
      for (const enabled of [false, true]) {
        const engine = createEngine({
          ...f.configuration,
          providers: [provider],
          schedules: enabled,
        });
        f.engines.add(engine);
        assert.ok(scheduleInvoke(engine, "inspectSchedules", f.workspace.id));
        assert.equal(
          occurrence(f.dbPath, proof.occurrenceId).state,
          "uncertain",
        );
        const actual = nativeRows(f.dbPath);
        for (const row of baseline.schedule_revisions!)
          assert.deepEqual(
            actual.schedule_revisions!.find((current) => current.id === row.id),
            row,
          );
        assert.deepEqual(actual.session_inputs, baseline.session_inputs);
        assert.deepEqual(actual.runs, baseline.runs);
        assert.deepEqual(actual.provider_attempts, baseline.provider_attempts);
        if (enabled) {
          const worker = scheduleInvoke<object>(
              engine,
              "captureScheduleWorker",
              f.workspace.id,
            ),
            current = occurrence(f.dbPath, proof.occurrenceId);
          const expired = readDatabase(
            f.dbPath,
            (db) =>
              JSON.parse(
                String(
                  db
                    .prepare(
                      "SELECT r.data FROM schedule_heads h JOIN schedule_revisions r ON r.id=h.revision_id WHERE h.kind='lease' AND h.workspace_id=?",
                    )
                    .get(f.workspace.id)!.data,
                ),
              ) as { revision: number; expiresAt: string },
          );
          await scheduleUntil(
            () => Date.now() > Date.parse(expired.expiresAt),
            "Real original scheduler lease expires without restoring dispatch authority",
          );
          const leased = scheduleInvoke<SchedulerLeaseResult>(
            engine,
            "acquireSchedulerLease",
            worker,
            {
              workspaceId: f.workspace.id,
              requestId: "fresh-owner-lease",
              expectedRevision: expired.revision,
              ttlMs: 1000,
            },
          );
          assert.ok(leased.lease);
          assert.throws(
            () =>
              scheduleInvoke(
                engine,
                "claimScheduleOccurrence",
                worker,
                leased.lease,
                {
                  workspaceId: f.workspace.id,
                  occurrenceId: proof.occurrenceId,
                  requestId: "no-replay",
                  expectedRevision: current.revision,
                },
              ),
            (error: unknown) => error instanceof EngineError,
          );
          scheduleInvoke(engine, "releaseScheduleHandle", worker);
          scheduleInvoke(engine, "releaseScheduleHandle", leased.lease);
        } else
          assert.throws(
            () =>
              scheduleInvoke(engine, "captureScheduleWorker", f.workspace.id),
            code("SCHEDULES_DISABLED"),
          );
        if (boundary === "after-accept") {
          try {
            engine.scheduler.resume(f.session.id);
            await engine.waitForSession(f.session.id);
          } catch (error) {
            assert.ok(error instanceof EngineError);
          }
          assert.equal(
            engine.store.getInput(String(proof.inputs[0]!.id)).state,
            "pending",
          );
        }
        assert.equal(reopenedProviderEntries, 0);
        assert.equal(
          nativeRows(f.dbPath).session_inputs!.length,
          baseline.session_inputs!.length,
        );
        await engine.close();
      }
    },
  );

test("actual scheduled durable acceptance archives immutable receipts and imports disabled/paused with default-off inspection and no queue promotion", async (t) => {
  const f = await scheduleFixture(t),
    prepared = prepareScheduleBoundary(
      f.engine,
      f.workspace.id,
      f.session.id,
      f.config,
      "archive",
    ),
    accepted = dispatchScheduleBoundary(f.engine, prepared, "archive-dispatch");
  assert.equal(accepted.record.state, "accepted");
  assert.ok(accepted.record.input);
  assert.equal(
    f.engine.store.getInput(accepted.record.input.inputId).state,
    "pending",
  );
  assert.equal(f.requests.length, 0);
  await f.engine.close();
  const rows = nativeRows(f.dbPath).schedule_revisions!,
    archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "archive"),
    });
  assert.ok(validateEngineArchive({ directory: archive.directory }));
  for (const enabled of [false, true]) {
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(
        f.base,
        enabled ? "imported-enabled" : "imported-default",
      ),
    });
    assert.equal(imported.schemaVersion, DB_VERSION);
    assert.equal(imported.executionResumed, false);
    const engine = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      schedules: enabled,
    });
    f.engines.add(engine);
    const schedule = scheduleInvoke<ScheduleRevision>(
        engine,
        "getSchedule",
        f.workspace.id,
        prepared.spec.id,
      ),
      current = occurrence(imported.dbPath, accepted.record.occurrenceId);
    assert.equal(schedule.spec.enabled, false);
    assert.equal(current.state, "paused-import");
    assert.deepEqual(current.input, accepted.record.input);
    assert.equal(engine.store.getSessionControl(f.session.id).paused, true);
    assert.ok(scheduleInvoke(engine, "inspectSchedules", f.workspace.id));
    const importedRows = nativeRows(imported.dbPath).schedule_revisions!;
    for (const row of rows)
      assert.deepEqual(
        importedRows.find((item) => item.id === row.id),
        row,
      );
    try {
      engine.scheduler.resume(f.session.id);
      await engine.waitForSession(f.session.id);
    } catch (error) {
      assert.ok(error instanceof EngineError);
    }
    assert.equal(
      engine.store.getInput(accepted.record.input.inputId).state,
      "pending",
    );
    assert.equal(nativeRows(imported.dbPath).runs!.length, 0);
    assert.equal(f.requests.length, 0);
    await engine.close();
  }
});

test(
  "expired native scheduler lease does not prove a held original provider stopped or authorize another physical root to dispatch",
  { timeout: 15000 },
  async (t) => {
    const f = await scheduleFixture(t),
      prepared = prepareScheduleBoundary(
        f.engine,
        f.workspace.id,
        f.session.id,
        f.config,
        "owner",
        1000,
      ),
      accepted = dispatchScheduleBoundary(f.engine, prepared, "owner-dispatch");
    await scheduleCommand(f.engine, "session.resume", {
      sessionId: f.session.id,
    });
    await scheduleUntil(
      () => f.requests.length === 1,
      "Actual original scheduled provider entered",
    );
    assert.ok(accepted.record.input);
    const input = f.engine.store.getInput(accepted.record.input.inputId);
    assert.equal(input.state, "promoted");
    assert.ok(input.runId);
    assert.equal(f.returns, 0);
    await scheduleUntil(
      () => Date.now() > Date.parse(prepared.leased.record.expiresAt),
      "Actual scheduler lease expired while the original provider is held",
    );
    let secondEntries = 0;
    const secondProvider: ProviderAdapter = {
      id: "actual-schedule-provider",
      streamTurn() {
        secondEntries++;
        const original = (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: "finish", reason: "stop" };
        })();
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => original.next(),
            return: () => original.return(undefined as never),
          }),
        };
      },
    };
    assert.equal(
      f.returns,
      0,
      "The first physical original provider still has not returned",
    );
    const before = nativeRows(f.dbPath);
    assert.throws(
      () => createEngine({ ...f.configuration, providers: [secondProvider] }),
      code("DB_LOCKED"),
    );
    assert.deepEqual(nativeRows(f.dbPath), before);
    assert.equal(f.engine.store.getRun(input.runId).state, "running");
    assert.equal(secondEntries, 0);
    assert.equal(f.requests.length, 1);
    assert.equal(f.returns, 0);
    f.releases[0]!.resolve();
    assert.equal((await f.engine.waitForRun(input.runId)).state, "completed");
  },
);
