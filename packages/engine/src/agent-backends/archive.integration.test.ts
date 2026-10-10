import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { type JsonObject } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { DB_VERSION } from "../storage/migrations.js";
import { groupExists } from "../tools/command/process-control.js";
import { backendFixture, backendUntil } from "./fixtures/backend.js";

function revisionRows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM backend_revisions ORDER BY id").all();
  } finally {
    db.close();
  }
}

async function importedFixture(t: test.TestContext, uncertain: boolean) {
  const f = await backendFixture(t, { mode: uncertain ? "hold" : "read" });
  f.register();
  const submitted = await f.submit();
  if (uncertain) {
    await backendUntil(
      () =>
        f.logs().some((row) => row.message?.method === "session/prompt") ||
        ["failed", "completed", "cancelled", "interrupted"].includes(
          f.engine.store.getRun(submitted.runId).state,
        ),
      "Actual peer did not receive the held original prompt",
    );
    assert.ok(
      f.logs().some((row) => row.message?.method === "session/prompt"),
      JSON.stringify(f.engine.store.getRun(submitted.runId)),
    );
    const connection = f.engine.inspectAgentBackendConnections(
      f.workspace.id,
    )[0]!;
    assert.ok(connection.proof.processId > 0);
    assert.equal(groupExists(connection.proof.processId), true);
    await f.engine.close();
    assert.equal((await submitted.done).state, "cancelled");
    assert.equal(groupExists(connection.proof.processId), false);
  } else {
    const completed = await submitted.done;
    assert.equal(completed.state, "completed", JSON.stringify(completed));
    const effects = f.engine.inspectAgentBackendEffects(f.workspace.id);
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.completion?.state, "completed");
    assert.equal(effects[0]!.completion?.cleanupConfirmed, true);
    assert.equal(
      effects[0]!.completion?.content,
      "Actual native read line one.\nActual native read line two.\n",
    );
    assert.ok(effects[0]!.delivery);
    await f.engine.close();
  }
  const rows = revisionRows(f.dbPath),
    logs = f.logs(),
    archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "actual-backend-archive"),
    }),
    imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "actual-backend-import"),
    });
  assert.equal(imported.schemaVersion, DB_VERSION);
  assert.equal(imported.executionResumed, false);
  const importedRows = revisionRows(imported.dbPath);
  for (const row of rows)
    assert.deepEqual(
      importedRows.find((current) => current.id === row.id),
      row,
    );
  const engine = createEngine({
    ...f.configuration,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
    agentBackends: false,
  });
  f.engines.add(engine);
  return { f, submitted, imported, engine, rows, logs, importedRows };
}

test("completed actual backend read history imports paused and disabled without restoring a provider or inventing uncertain cleanup", async (t) => {
  const { f, submitted, engine, logs, imported, importedRows } =
      await importedFixture(t, false),
    backend = engine.getAgentBackend(f.workspace.id, f.backendId)!,
    connection = engine.inspectAgentBackendConnections(f.workspace.id)[0]!,
    request = engine.inspectAgentBackendRequests(f.workspace.id)[0]!,
    effect = engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(backend.enabled, false);
  assert.equal(connection.state, "paused-import");
  assert.equal(connection.disposal?.cleanupConfirmed, true);
  assert.equal(request.state, "paused-import");
  assert.ok(request.terminal);
  assert.ok("result" in request.terminal.message);
  assert.deepEqual(request.terminal.message.result, { stopReason: "end_turn" });
  assert.equal(effect.state, "paused-import");
  assert.equal(effect.completion?.state, "completed");
  assert.equal(effect.completion?.cleanupConfirmed, true);
  assert.equal(effect.completion?.errorCode, null);
  assert.ok(effect.delivery);
  assert.equal(engine.store.hasUncertainAgentBackend(f.workspace.id), false);
  assert.equal(engine.store.getSessionControl(f.session.id).paused, true);
  assert.equal(engine.store.getRun(submitted.runId).state, "completed");
  assert.equal(
    engine.store.getSnapshot(f.session.id).tools[0]!.state,
    "completed",
  );
  assert.equal(
    engine.getCapabilities().providerIds.includes(f.config.providerId),
    false,
  );
  assert.equal(f.logs().filter((row) => row.type === "started").length, 1);
  await engine.waitForSession(f.session.id);
  assert.deepEqual(f.logs(), logs);
  assert.deepEqual(revisionRows(imported.dbPath), importedRows);
  assert.equal(engine.store.getSnapshot(f.session.id).runs.length, 1);
});

test("cancelled actual backend prompt imports its unknown terminal outcome and cleanup evidence while quarantine continues to block execution", async (t) => {
  const { f, submitted, engine, logs, imported, importedRows } =
      await importedFixture(t, true),
    backend = engine.getAgentBackend(f.workspace.id, f.backendId)!,
    connection = engine.inspectAgentBackendConnections(f.workspace.id)[0]!,
    request = engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
  assert.equal(backend.enabled, false);
  assert.equal(connection.state, "paused-import");
  assert.equal(connection.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(connection.proof.processId), false);
  assert.equal(request.state, "paused-import");
  assert.equal(request.terminal, null);
  assert.equal(engine.inspectAgentBackendEffects(f.workspace.id).length, 0);
  assert.equal(engine.store.hasUncertainAgentBackend(f.workspace.id), true);
  assert.equal(engine.store.hasUncertainWorkspace(f.workspace.id), true);
  assert.equal(engine.store.getSessionControl(f.session.id).paused, true);
  assert.equal(
    engine.getCapabilities().providerIds.includes(f.config.providerId),
    false,
  );
  const { agentProfileId: _profile, ...legacyConfig } = f.config;
  const reply = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: "run.submit",
    payload: {
      sessionId: f.session.id,
      requestId: randomUUID(),
      prompt: "Imported quarantine must retain its original unknown outcome.",
      config: {
        ...legacyConfig,
        providerId: "scripted",
      } as unknown as JsonObject,
    },
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.error?.code, "CLEANUP_PENDING");
  assert.equal(engine.store.getRun(submitted.runId).state, "cancelled");
  assert.equal(engine.store.getSnapshot(f.session.id).runs.length, 1);
  assert.deepEqual(f.logs(), logs);
  assert.deepEqual(revisionRows(imported.dbPath), importedRows);
});

test("an imported backend history exports and imports again, pausing only the backend a second time", async (t) => {
  const { f, engine, imported, importedRows } = await importedFixture(t, false);
  await engine.close();
  f.engines.delete(engine);
  const archive = await exportEngineArchive({
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      destination: join(f.base, "actual-backend-archive-again"),
    }),
    reimported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "actual-backend-import-again"),
    });
  const rows = revisionRows(reimported.dbPath);
  for (const row of importedRows)
    assert.deepEqual(
      rows.find((current) => current.id === row.id),
      row,
    );
  assert.equal(rows.length, importedRows.length + 2);
  const again = createEngine({
    ...f.configuration,
    dbPath: reimported.dbPath,
    artifactDir: reimported.artifactDir,
    agentBackends: false,
  });
  f.engines.add(again);
  assert.equal(
    again.getAgentBackend(f.workspace.id, f.backendId)!.enabled,
    false,
  );
  for (const record of [
    ...again.inspectAgentBackendConnections(f.workspace.id),
    ...again.inspectAgentBackendRequests(f.workspace.id),
    ...again.inspectAgentBackendEffects(f.workspace.id),
  ])
    assert.equal(record.state, "paused-import");
  assert.deepEqual(revisionRows(reimported.dbPath), rows);
});
