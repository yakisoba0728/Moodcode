import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { groupExists } from "../tools/command/process-control.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
import { backendFixture } from "./fixtures/backend.js";
import type {
  BackendConnectionProof,
  OwnedBackendProcesses,
} from "./process.js";

test("actual SQL admission failure rolls back both connection anchors and terminates the originally launched peer", async (t) => {
  const f = await backendFixture(t);
  f.register();
  const db = new DatabaseSync(f.dbPath);
  const processes = Reflect.get(
    f.engine,
    "backendProcesses",
  ) as OwnedBackendProcesses;
  const originalRead = processes.readConnection;
  let launched: BackendConnectionProof | undefined;
  // Observe the real private process producer without replacing its proof.
  processes.readConnection = function (original) {
    const proof = originalRead.call(this, original);
    launched = proof;
    return proof;
  };
  db.exec(`CREATE TRIGGER reject_backend_connection_admission
    BEFORE INSERT ON backend_revisions WHEN NEW.kind='connection'
    BEGIN SELECT RAISE(ABORT, 'Actual connection admission SQL failure'); END;`);
  try {
    const { runId, done } = await f.submit();
    const run = await done;
    assert.equal(run.state, "failed", JSON.stringify(run));
    assert.ok(
      launched,
      "The actual owned peer must launch before the SQL fault",
    );
    assert.ok(launched.processId > 0);
    assert.equal(
      groupExists(launched.processId),
      false,
      "The original peer process group must be absent after admission failure",
    );
    for (const table of ["session_events", "events"]) {
      assert.equal(
        Number(
          db
            .prepare(
              `SELECT count(*) n FROM ${table} WHERE run_id=? AND type='backend.connection_admitted'`,
            )
            .get(runId)!.n,
        ),
        0,
        `${table} must roll back the independent connection anchor`,
      );
      assert.equal(
        Number(
          db
            .prepare(
              `SELECT count(*) n FROM ${table} WHERE run_id=? AND type='backend.launch_reserved'`,
            )
            .get(runId)!.n,
        ),
        1,
        `${table} must retain the real earlier launch reservation`,
      );
    }
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM backend_revisions WHERE kind IN ('connection','request','client-effect')",
          )
          .get()!.n,
      ),
      0,
    );
    assert.equal(
      Number(
        db
          .prepare("SELECT count(*) n FROM backend_heads WHERE kind<>'backend'")
          .get()!.n,
      ),
      0,
    );
    assert.deepEqual(
      f.engine.inspectAgentBackendConnections(f.workspace.id),
      [],
    );
    assert.deepEqual(f.engine.inspectAgentBackendRequests(f.workspace.id), []);
    assert.deepEqual(f.engine.inspectAgentBackendEffects(f.workspace.id), []);
    assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 0);
    assert.equal(
      f
        .logs()
        .filter((line) =>
          ["session/new", "session/prompt"].includes(
            String(line.message?.method),
          ),
        ).length,
      0,
    );
    const attempts = f
      .rows("provider_attempts")
      .filter((row) => row.run_id === runId);
    assert.equal(attempts.length, 1);
    const cleanup = f.engine.store.getAttemptCleanup(String(attempts[0]!.id));
    assert.equal(
      cleanup.state,
      "uncertain",
      "A launched process without a durable native disposal receipt must retain uncertainty",
    );
    assert.equal(cleanup.cleanupConfirmed, false);
    // Inspect only: the original supervisor owns any physical lock release.
    const lock = inspectExecutionLock(
      Reflect.get(f.engine, "executionLockPath") as string,
    );
    assert.notEqual(lock.status, "busy");
  } finally {
    processes.readConnection = originalRead;
    db.exec("DROP TRIGGER reject_backend_connection_admission");
    db.close();
  }
});
