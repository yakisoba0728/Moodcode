import assert from "node:assert/strict";
import { join } from "node:path";
import { fork } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EngineOptions } from "../engine.js";
import { backendUntil } from "./fixtures/backend.js";
import test from "node:test";
import { knowledgeHash } from "../knowledge/validation.js";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { groupExists } from "../tools/command/process-control.js";
import { sessionLoadFixture } from "./fixtures/session-load.js";
import {
  validateAgentBackendDatabase,
  type BackendConnectionRevision,
  type BackendTransitionReceipt,
} from "./store.js";

test(
  "actual SIGKILL after committed load replay preserves unknown remote closure and never restores or repeats the load",
  { skip: process.platform === "win32" },
  async (t) => {
    const compiled = new URL(
      "./fixtures/session-load-crash.js",
      import.meta.url,
    );
    const source = new URL("./fixtures/session-load-crash.ts", import.meta.url);
    const child = fork(
      fileURLToPath(existsSync(compiled) ? compiled : source),
      [],
      {
        execArgv: existsSync(compiled)
          ? []
          : [
              "--import",
              fileURLToPath(
                new URL(
                  "../../../../node_modules/tsx/dist/loader.mjs",
                  import.meta.url,
                ),
              ),
            ],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      if (errors.length < 8192)
        errors += String(chunk).slice(0, 8192 - errors.length);
    });
    type Boundary = {
      base: string;
      dbPath: string;
      artifactDir: string;
      configuration: EngineOptions;
      workspaceId: string;
      sessionId: string;
      connectionId: string;
      processId: number;
      replaySha: string;
      logPath: string;
    };
    const boundary = await new Promise<Boundary>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `Actual crash fixture did not reach replay COMMIT: ${errors}`,
          ),
        );
      }, 15000);
      child.once("message", (value) => {
        clearTimeout(timer);
        resolve(value as Boundary);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(
          new Error(
            `Actual crash fixture exited before replay COMMIT: ${errors}`,
          ),
        );
      });
    });
    t.after(() => {
      child.kill("SIGKILL");
      rmSync(boundary.base, { recursive: true, force: true });
    });
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await exited;
    await backendUntil(
      () => !groupExists(boundary.processId),
      "Owned peer group survived the physical Root SIGKILL",
    );
    const logs = readFileSync(boundary.logPath, "utf8");
    let reopened: ReturnType<typeof createEngine> | undefined;
    await backendUntil(() => {
      try {
        reopened = createEngine(boundary.configuration);
        return true;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "CLEANUP_PENDING"
        )
          return false;
        throw error;
      }
    }, "Original supervisor did not release the physical Root cleanup lease");
    const restored = reopened!;
    t.after(() => restored.close());
    const history = restored
      .inspectAgentBackendConnections(boundary.workspaceId)
      .find((r) => r.connectionId === boundary.connectionId)!;
    assert.equal(history.state, "uncertain");
    assert.equal(history.sessionLoad?.state, "dispatching");
    assert.equal(history.sessionLoad.replayHashes.length, 3);
    assert.equal(history.sessionLoad.response, null);
    assert.equal(history.disposal, null);
    assert.equal(
      restored.store.hasUncertainAgentBackend(boundary.workspaceId),
      true,
    );
    assert.equal(
      restored
        .getCapabilities()
        .providerIds.some((id) => id.startsWith("acp:")),
      false,
    );
    const native = Reflect.get(
      restored,
      "backendRecords",
    ) as import("./store.js").AgentBackendStorage;
    assert.equal(
      native.db
        .prepare("SELECT sha256 FROM backend_revisions WHERE sha256=?")
        .get(boundary.replaySha)?.sha256,
      boundary.replaySha,
    );
    validateAgentBackendDatabase(native.db);
    await restored.waitForSession(boundary.sessionId);
    assert.equal(readFileSync(boundary.logPath, "utf8"), logs);
  },
);

function signed<T extends object>(value: T): T & { sha256: string } {
  const { sha256: _sha, ...body } = value as T & { sha256?: string };
  return { ...body, sha256: knowledgeHash(body) } as T & { sha256: string };
}
test("genuine loaded session retains complete native replay lineage across paused import, with no reconstructed live authority", async (t) => {
  const f = await sessionLoadFixture(t);
  const current = await f.submitLoad();
  assert.equal((await current.done).state, "completed");
  validateAgentBackendDatabase(f.native.db);
  const loaded = f.engine
    .inspectAgentBackendConnections(f.workspace.id)
    .find((r) => r.backendId === f.alias)!;
  assert.equal(loaded.sessionLoad?.state, "loaded");
  assert.equal(loaded.sessionLoad.replayHashes.length, 3);
  assert.equal(
    loaded.sessionLoad.response?.wireId,
    (loaded.sessionLoad.message as { id: string }).id,
  );
  assert.equal(loaded.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(loaded.proof.processId), false);
  const beforeLogs = f.logs();
  await f.engine.close();
  const archive = await exportEngineArchive({
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    destination: join(f.base, "loaded-archive"),
  });
  const imported = await importEngineArchive({
    directory: archive.directory,
    destination: join(f.base, "loaded-import"),
  });
  const restored = createEngine({
    ...f.configuration,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
  });
  f.engines.add(restored);
  const history = restored
    .inspectAgentBackendConnections(f.workspace.id)
    .find((r) => r.backendId === f.alias)!;
  assert.equal(history.state, "paused-import");
  assert.deepEqual(history.sessionLoad, loaded.sessionLoad);
  assert.equal(
    restored.getCapabilities().providerIds.includes(f.config.providerId),
    false,
  );
  await restored.waitForSession(f.session.id);
  assert.deepEqual(f.logs(), beforeLogs);
});

test("native load-intent SQL failure commits no intent and sends no session/load, current prompt or fallback", async (t) => {
  const f = await sessionLoadFixture(t);
  f.native.db.exec(
    "CREATE TEMP TRIGGER reject_load_intent BEFORE INSERT ON backend_revisions WHEN NEW.request_scope LIKE '%:load-intent' BEGIN SELECT RAISE(ABORT,'injected load intent failure'); END",
  );
  const current = await f.submitLoad();
  const run = await current.done;
  assert.equal(run.state, "failed");
  assert.equal(
    f
      .logs()
      .some(
        (r) => r.type === "received" && r.message?.method === "session/load",
      ),
    false,
  );
  assert.equal(
    f
      .logs()
      .filter(
        (r) => r.type === "received" && r.message?.method === "session/prompt",
      ).length,
    1,
  );
  assert.equal(
    f.native.db
      .prepare(
        "SELECT count(*) n FROM backend_revisions WHERE request_scope LIKE '%:load-intent'",
      )
      .get()!.n,
    0,
  );
  const connection = f.engine
    .inspectAgentBackendConnections(f.workspace.id)
    .find((r) => r.backendId === f.alias)!;
  assert.equal(connection.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(connection.proof.processId), false);
});

for (const mode of [
  "foreign-session",
  "replay-limit",
  "disconnect",
  "duplicate-ack",
]) {
  test(`actual ${mode} cannot complete loaded history or turn historical bytes into current native effects`, async (t) => {
    const f = await sessionLoadFixture(t, mode);
    const current = await f.submitLoad();
    const run = await current.done;
    assert.equal(run.state, "failed", JSON.stringify(run));
    assert.equal(
      f.engine.store
        .getSnapshot(f.session.id)
        .tools.filter((r) => r.runId === run.id).length,
      0,
    );
    assert.equal(
      f.engine.store
        .getSnapshot(f.session.id)
        .messages.filter((r) => r.runId === run.id)
        .some((r) => r.content.includes("HISTORY")),
      false,
    );
    const c = f.engine
      .inspectAgentBackendConnections(f.workspace.id)
      .find((r) => r.backendId === f.alias)!;
    assert.equal(c.disposal?.cleanupConfirmed, true);
    assert.equal(groupExists(c.proof.processId), false);
    assert.equal(
      f
        .logs()
        .filter(
          (r) => r.type === "received" && r.message?.method === "session/new",
        ).length,
      1,
    );
    if (mode !== "duplicate-ack")
      assert.equal(
        f
          .logs()
          .filter(
            (r) =>
              r.type === "received" && r.message?.method === "session/prompt",
          ).length,
        1,
      );
    assert.equal(
      f.engine
        .inspectAgentBackendRequests(f.workspace.id)
        .filter((r) => r.owner.runId === run.id)
        .some((r) => r.state === "completed"),
      false,
    );
    validateAgentBackendDatabase(f.native.db);
  });
}

test("rehashing genuine loaded native receipts cannot erase replay, replace load-session identity or forge completion before its write", async (t) => {
  const f = await sessionLoadFixture(t);
  assert.equal((await (await f.submitLoad()).done).state, "completed");
  const head = f.engine
    .inspectAgentBackendConnections(f.workspace.id)
    .find((r) => r.backendId === f.alias)!;
  const rows = f.native.db
    .prepare(
      "SELECT data FROM backend_revisions WHERE kind='connection' AND entity_id=? ORDER BY revision",
    )
    .all(head.entityId)
    .map((r) => JSON.parse(String(r.data)) as BackendConnectionRevision);
  const ready = rows.find((r) => r.state === "session-ready")!;
  for (const changed of [
    {
      ...ready,
      sessionLoad: { ...ready.sessionLoad!, replayHashes: [], replayBytes: 0 },
    },
    { ...ready, remoteSessionId: "foreign-native-session" },
    { ...ready, sessionLoad: { ...ready.sessionLoad!, write: null } },
    {
      ...ready,
      sessionLoad: {
        ...ready.sessionLoad!,
        write: signed({ ...ready.sessionLoad!.write!, writtenBytes: 0 }),
      },
    },
    {
      ...ready,
      sessionLoad: {
        ...ready.sessionLoad!,
        write: signed({ ...ready.sessionLoad!.write!, writeOrdinal: 0 }),
      },
    },
  ]) {
    f.native.db.exec("SAVEPOINT load_graph_probe");
    try {
      const record = signed(changed),
        raw = f.native.db
          .prepare("SELECT data FROM backend_revisions WHERE id=?")
          .get(record.lastReceiptId)!;
      const receipt = signed({
        ...(JSON.parse(String(raw.data)) as BackendTransitionReceipt),
        afterSha256: record.sha256,
      });
      f.native.db
        .prepare("UPDATE backend_revisions SET data=?,sha256=? WHERE id=?")
        .run(JSON.stringify(record), record.sha256, record.id);
      f.native.db
        .prepare("UPDATE backend_revisions SET data=?,sha256=? WHERE id=?")
        .run(JSON.stringify(receipt), receipt.sha256, receipt.id);
      f.native.db
        .prepare("UPDATE backend_heads SET sha256=? WHERE revision_id=?")
        .run(record.sha256, record.id);
      assert.throws(() => validateAgentBackendDatabase(f.native.db));
    } finally {
      f.native.db.exec("ROLLBACK TO load_graph_probe");
      f.native.db.exec("RELEASE load_graph_probe");
    }
  }
  validateAgentBackendDatabase(f.native.db);
});
