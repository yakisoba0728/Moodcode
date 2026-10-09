import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { JsonObject } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { assertExecutionLockAvailable } from "../tools/command/execution-lock.js";
import { groupExists } from "../tools/command/process-control.js";
import { backendUntil, retainBackendFixture } from "./fixtures/backend.js";

interface Ready {
  type: "ready";
  base: string;
  root: string;
  dbPath: string;
  artifactDir: string;
  logPath: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  peerPid: number;
}

test(
  "SIGKILL of the actual Engine cleans its owned peer while preserving unconfirmed native completion across reopen and archive import",
  { timeout: 25000 },
  async (t) => {
    const compiled = new URL("./fixtures/crash-backend.js", import.meta.url);
    const source = new URL("./fixtures/crash-backend.ts", import.meta.url);
    const { NODE_TEST_CONTEXT: _testContext, ...fixtureEnv } = process.env;
    const child = fork(existsSync(compiled) ? compiled : source, [], {
      execArgv: existsSync(compiled)
        ? []
        : ["--import", import.meta.resolve("tsx")],
      env: fixtureEnv,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let ready: Ready | undefined;
    const engines = new Set<ReturnType<typeof createEngine>>();
    let stderr = "";
    child.stderr?.on("data", (value: Buffer) => {
      stderr = (stderr + value.toString()).slice(-4096);
    });
    t.after(async () => {
      let ownerExitError: { error: unknown } | undefined;
      try {
        if (child.exitCode === null && child.signalCode === null) {
          const ended = once(child, "exit");
          child.kill("SIGKILL");
          await ended;
        }
      } catch (error) { ownerExitError = { error }; }
      await retainBackendFixture(t, ready?.base, engines, {
        originalAfterHookObserved: false, ownerExitError,
      });
    });
    ready = await new Promise<Ready>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Actual Engine did not become ready: ${stderr}`)),
        10000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Fixture exited early ${code}/${signal}: ${stderr}`));
      });
      child.on("message", (value) => {
        const packet = value as Ready | { type: "failed"; message: string };
        clearTimeout(timer);
        if (packet.type === "ready") resolve(packet);
        else
          reject(new Error(`Actual Engine fixture failed: ${packet.message}`));
      });
    });
    const before = readFileSync(ready.logPath, "utf8");
    assert.equal(
      before
        .split("\n")
        .filter((line) => line.includes('"method":"session/prompt"')).length,
      1,
    );
    assert.equal(groupExists(ready.peerPid), true);
    const ended = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    const [exitCode, signal] = await ended;
    assert.equal(exitCode, null);
    assert.equal(signal, "SIGKILL");
    await backendUntil(
      () => {
        if (groupExists(ready!.peerPid)) return false;
        try {
          assertExecutionLockAvailable(`${ready!.dbPath}.effects.sqlite`);
          return true;
        } catch {
          return false;
        }
      },
      "Original supervisor failed to clean the peer and release its actual execution lock",
      8000,
    );

    const reopened = createEngine({
      dbPath: ready.dbPath,
      artifactDir: ready.artifactDir,
      providers: [],
    });
    engines.add(reopened);
    assert.equal(reopened.store.getRun(ready.runId).state, "interrupted");
    const requests = reopened.inspectAgentBackendRequests(ready.workspaceId),
      connections = reopened.inspectAgentBackendConnections(ready.workspaceId);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.state, "uncertain");
    assert.equal(requests[0]!.terminal, null);
    assert.equal(connections.length, 1);
    assert.equal(connections[0]!.state, "uncertain");
    assert.equal(connections[0]!.disposal, null);
    assert.equal(reopened.store.hasUncertainWorkspace(ready.workspaceId), true);
    assert.equal(
      reopened
        .getCapabilities()
        .providerIds.some((id) => id.startsWith("acp:")),
      false,
    );
    const db = new DatabaseSync(ready.dbPath, { readOnly: true });
    try {
      assert.equal(
        db
          .prepare("SELECT state FROM attempt_cleanup WHERE run_id=?")
          .get(ready.runId)?.state,
        "uncertain",
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE run_id=? AND type='backend.connection_admitted'",
          )
          .get(ready.runId)?.n,
        1,
      );
    } finally {
      db.close();
    }
    const reply = await reopened.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type: "run.submit",
      payload: {
        sessionId: ready.sessionId,
        requestId: randomUUID(),
        prompt: "An uncertain remote prompt must remain blocked.",
        config: {
          providerId: "scripted",
          modelId: "fixture",
          mode: "plan",
        } as JsonObject,
      },
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.error?.code, "CLEANUP_PENDING");
    assert.equal(reopened.store.getSnapshot(ready.sessionId).runs.length, 1);
    assert.equal(readFileSync(ready.logPath, "utf8"), before);
    await reopened.close();
    engines.delete(reopened);

    const archive = await exportEngineArchive({
      dbPath: ready.dbPath,
      artifactDir: ready.artifactDir,
      destination: join(ready.base, "archive"),
    });
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(ready.base, "imported"),
    });
    assert.equal(imported.executionResumed, false);
    const historical = createEngine({
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      providers: [],
    });
    engines.add(historical);
    assert.equal(
      historical.inspectAgentBackends(ready.workspaceId)[0]?.enabled,
      false,
    );
    assert.equal(
      historical.inspectAgentBackendRequests(ready.workspaceId)[0]?.state,
      "paused-import",
    );
    assert.equal(
      historical.inspectAgentBackendRequests(ready.workspaceId)[0]?.terminal,
      null,
    );
    assert.equal(
      historical.inspectAgentBackendConnections(ready.workspaceId)[0]?.disposal,
      null,
    );
    assert.equal(
      historical.store.hasUncertainWorkspace(ready.workspaceId),
      true,
    );
    assert.equal(
      historical
        .getCapabilities()
        .providerIds.some((id) => id.startsWith("acp:")),
      false,
    );
    assert.equal(readFileSync(ready.logPath, "utf8"), before);
  },
);
