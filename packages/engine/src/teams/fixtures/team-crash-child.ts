import assert from "node:assert/strict";
import { createEngine } from "../../engine.js";
import { publishCrashEvidence } from "../../test-fixtures/atomic-crash-evidence.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import {
  childStorageKind,
  type ChildStorageRecord,
} from "../../child-tasks/storage-binding.js";
import { TeamStorage } from "../store.js";
import type { TeamDeliveryRecord } from "../types.js";
import { coordinatorPermissions, workerPermissions } from "./native-team.js";
import { command, gate, readDatabase } from "./engine-team.js";
const [rawDbPath, rawArtifactDir, rawWorkspaceId, rawSessionId, rawBoundary, rawReadyPath] =
  process.argv.slice(2);
assert.ok(
  rawDbPath && rawArtifactDir && rawWorkspaceId && rawSessionId && rawBoundary && rawReadyPath,
);
const dbPath: string = rawDbPath;
const artifactDir: string = rawArtifactDir;
const workspaceId: string = rawWorkspaceId;
const sessionId: string = rawSessionId;
const boundary: string = rawBoundary;
const readyPath: string = rawReadyPath;
const held = gate();
let childEngine: ReturnType<typeof createEngine> | undefined;
const provider: ProviderAdapter = {
  id: "team-crash-original-provider",
  async *streamTurn(_request, signal): AsyncGenerator<ProviderEvent> {
    yield { type: "progress" };
    let resolve!: () => void;
    try {
      await Promise.race([
        held.promise,
        new Promise<void>((done) => {
          resolve = done;
          signal.addEventListener("abort", resolve, { once: true });
          if (signal.aborted) resolve();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", resolve);
    }
    if (!signal.aborted) yield { type: "finish", reason: "stop" };
  },
};
const engine = createEngine({
  dbPath,
  artifactDir,
  teams: true,
  providers: [provider],
  configureChild(child) {
    childEngine = child;
  },
  defaults: {
    providerId: provider.id,
    modelId: "fixture",
    mode: "build",
    limits: {
      maxTurns: 8,
      maxToolCalls: 8,
      maxDurationMs: 30000,
      maxOutputBytes: 65536,
    },
  },
});
const worktree = await engine.createWorktree(sessionId, "team-crash-original"),
  parent = await command<{ runId: string }>(engine, "run.submit", {
    sessionId,
    requestId: "team-crash-parent",
    prompt: "Actual crash parent",
  });
const starting = await engine.startChildTask({
  sessionId,
  requestId: "team-crash-child",
  parentRunId: parent.runId,
  worktreeId: worktree.id,
  prompt: "Actual crash child",
  tools: ["read_file"],
  allocation: { turns: 3, toolCalls: 1, outputBytes: 8192, durationMs: 10000 },
});
let task = engine.children.tasks.get(sessionId, starting.id);
const deadline = Date.now() + 4000;
while (task.state !== "running" || !task.childRunId) {
  assert.ok(Date.now() < deadline, JSON.stringify(task));
  await new Promise((done) => setImmediate(done));
  task = engine.children.tasks.get(sessionId, starting.id);
}
assert.ok(childEngine);
const expiresAt = new Date(Date.now() + 60000).toISOString(),
  team = engine.createTeam({
    workspaceId,
    requestId: "team-crash-create",
    teamId: "actual-crash-team",
    expiresAt,
  });
function join(memberId: string, childTaskId?: string) {
  const preview = engine.previewTeamMember({
    workspaceId,
    teamId: team.record.id,
    memberId,
    expectedRevision: 0,
    role: childTaskId ? "worker" : "coordinator",
    permissions: childTaskId ? workerPermissions : coordinatorPermissions,
    expiresAt,
    rootSessionId: sessionId,
    ...(childTaskId ? { childTaskId } : {}),
  });
  return engine.joinTeamMember({
    workspaceId,
    requestId: `team-crash-join-${memberId}`,
    approved: true,
    preview,
  }).record;
}
const root = join("coordinator"),
  child = join("child", task.id),
  message = engine.sendAgentMessage({
    workspaceId,
    teamId: team.record.id,
    senderMemberId: root.memberId,
    senderGeneration: root.generation,
    recipientMemberId: child.memberId,
    recipientGeneration: child.generation,
    requestId: "team-crash-message",
    text: "Actual bounded crash mailbox data.",
    expiresAt,
  }).record,
  page = engine.readAgentMailbox({
    workspaceId,
    teamId: team.record.id,
    memberId: child.memberId,
    generation: child.generation,
  });
const storage = engine.store.getSessionDocument(
  sessionId,
  childStorageKind(task.id),
)!.data as unknown as ChildStorageRecord;
let deliveryId = "";
function freeze(record: TeamDeliveryRecord) {
  const history = engine.getTeamDelivery(workspaceId!, record.id);
  assert.ok(history);
  const childInputs = readDatabase(
    storage.binding.physical.database.path,
    (db) =>
      db
        .prepare("SELECT data FROM session_inputs WHERE request_id=?")
        .all(`team-delivery:${record.id}`)
        .map((row) => JSON.parse(String(row.data))),
  );
  const proof = {
    boundary,
    pid: process.pid,
    delivery: history.record,
    receipt: history.receipt,
    childInputs,
    childStorage: storage,
    message,
    cursor: readDatabase(dbPath!, (db) =>
      JSON.parse(
        String(
          db
            .prepare(
              "SELECT data FROM team_mailbox_cursors WHERE team_id=? AND member_id=? AND generation=?",
            )
            .get(team.record.id, child.memberId, child.generation)!.data,
        ),
      ),
    ),
  };
  publishCrashEvidence(readyPath!, proof);
  process.kill(process.pid, "SIGSTOP");
  throw Error("Parent must SIGKILL original stopped process");
}
const prepare = TeamStorage.prototype.prepareDelivery,
  dispatch = TeamStorage.prototype.dispatchDelivery,
  complete = TeamStorage.prototype.completeDelivery;
TeamStorage.prototype.prepareDelivery = function (
  this: TeamStorage,
  ...args: Parameters<typeof prepare>
) {
  const result = Reflect.apply(prepare, this, args) as ReturnType<
    typeof prepare
  >;
  if (result.kind === "created") {
    deliveryId = result.record.id;
    if (boundary === "prepared") freeze(result.record);
  }
  return result;
};
TeamStorage.prototype.dispatchDelivery = function (
  this: TeamStorage,
  ...args: Parameters<typeof dispatch>
) {
  const result = Reflect.apply(dispatch, this, args) as ReturnType<
    typeof dispatch
  >;
  if (boundary === "dispatched") freeze(result);
  return result;
};
TeamStorage.prototype.completeDelivery = function (
  this: TeamStorage,
  ...args: Parameters<typeof complete>
) {
  const result = Reflect.apply(complete, this, args) as ReturnType<
    typeof complete
  >;
  if (boundary === "delivered") freeze(result.record);
  return result;
};
const accept = engine.children.teamBridge.accept.bind(
  engine.children.teamBridge,
);
engine.children.teamBridge.accept = (...args: Parameters<typeof accept>) => {
  const result = accept(...args);
  if (boundary === "input-accepted") {
    const actual = engine.getTeamDelivery(workspaceId, deliveryId);
    assert.ok(actual);
    freeze(actual.record);
  }
  return result;
};
engine.resumeChildTurn({
  workspaceId,
  requestId: "team-crash-delivery",
  approved: true,
  page,
  expectedCursorRevision: page.cursor.revision,
});
throw Error("Requested actual native crash boundary was not reached");
