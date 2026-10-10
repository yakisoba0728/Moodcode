import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { knowledgeHash } from "../knowledge/validation.js";
import { sqliteFixtureDirectory } from "../storage/fixtures/sqlite-directory.js";
import {
  validateCommandLifetimeRecord,
  type CommandLifetimeRecord,
} from "./command-lifetime-records.js";
import { signJobData } from "./validation.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function sign(body: Omit<CommandLifetimeRecord, "sha256">) {
  return validateCommandLifetimeRecord(signJobData(body, 16384));
}
function admit(jobId: string): CommandLifetimeRecord {
  const at = new Date().toISOString();
  return sign({
    version: 1,
    jobId,
    workspaceId: "workspace",
    sessionId: "session",
    revision: 1,
    state: "starting",
    mode: "foreground",
    rootEpoch: knowledgeHash("epoch"),
    generation: 1,
    hostPreviewSha256: knowledgeHash(jobId),
    origin: null,
    physical: null,
    stdinSeq: 0,
    stdinBytes: 0,
    stdinEof: false,
    transfers: 0,
    completionSha256: null,
    operation: {
      kind: "admit",
      requestId: `${jobId}:admit`,
      requestSha256: knowledgeHash(`${jobId}:admit`),
      approved: true,
    },
    previousSha256: null,
    createdAt: at,
    updatedAt: at,
  });
}
function next(
  previous: CommandLifetimeRecord,
  kind: CommandLifetimeRecord["operation"]["kind"],
  state: CommandLifetimeRecord["state"],
): CommandLifetimeRecord {
  const { sha256: _, ...body } = previous;
  return sign({
    ...body,
    revision: previous.revision + 1,
    previousSha256: previous.sha256,
    state,
    updatedAt: new Date().toISOString(),
    operation: {
      kind,
      requestId: `${previous.jobId}:${previous.revision}`,
      requestSha256: knowledgeHash(`${kind}:${previous.revision}`),
      approved: false,
    },
  });
}

test("lifetime writes leave each lifetime its import revision and each live lifetime its recovery revision", (t) => {
  const resources = sqliteFixtureDirectory(t, "moodcode-lifetime-capacity-"),
    store = resources.openStore(),
    writer = resources.openDatabase();
  const at = new Date().toISOString();
  store.putWorkspace({
    id: "workspace",
    root: resources.directory,
    gitRoot: resources.directory,
    branch: null,
    createdAt: at,
  });
  for (const id of ["session", "filler"])
    store.createSession({
      id,
      workspaceId: "workspace",
      title: id,
      createdAt: at,
    });
  let settled = admit("settled-job"),
    live = admit("live-job");
  store.putCommandLifetime(settled, 0);
  store.putCommandLifetime(live, 0);
  // Unowned revisions only consume the shared journal cap.
  const insert = writer.prepare(
    "INSERT INTO session_events(session_id,seq,event_id,schema_version,type,data) VALUES('filler',?,?,2,'command.lifetime.revision','{}')",
  );
  writer.exec("BEGIN IMMEDIATE");
  for (let seq = 1; seq <= 4090; seq++) insert.run(seq, `filler-${seq}`);
  writer.exec("COMMIT");
  settled = next(settled, "uncertain", "uncertain");
  store.putCommandLifetime(settled, settled.revision - 1);
  const closed = next(settled, "closed", "uncertain");
  assert.throws(
    () => store.putCommandLifetime(closed, closed.revision - 1),
    code("COMMAND_LIFETIME_LIMIT"),
  );
  live = next(live, "recover", "uncertain");
  store.putCommandLifetime(live, live.revision - 1);
  for (const head of [settled, live]) {
    const paused = next(head, "import", "paused-import");
    store.putCommandLifetime(paused, paused.revision - 1);
  }
  store.validateCommandLifetimes();
  assert.deepEqual(
    store
      .inspectCommandLifetimes("workspace")
      .map((r) => r.state)
      .sort(),
    ["paused-import", "paused-import"],
  );
  assert.equal(
    writer
      .prepare(
        "SELECT count(*) n FROM session_events WHERE type='command.lifetime.revision'",
      )
      .get()!.n,
    4096,
  );
});
