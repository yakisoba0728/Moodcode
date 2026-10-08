import assert from "node:assert/strict";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { TeamHostService } from "./host.js";
import { teamMailboxInput } from "./input-port.js";
import type {
  TeamDeliveryRecord,
  TeamDeliveryReceipt,
  TeamMemberRevision,
  TeamRecord,
} from "./types.js";
import { failure, readDatabase, teamFixture } from "./fixtures/engine-team.js";

async function current(t: test.TestContext) {
  const f = await teamFixture(t, { engine: { teams: true } }),
    child = await f.startChild(),
    expiresAt = new Date(Date.now() + 10000).toISOString();
  const team = f.engine.createTeam({
    workspaceId: f.workspace.id,
    requestId: "host-team",
    teamId: "host-team",
    expiresAt,
  }).record;
  const join = (
    memberId: string,
    childTaskId?: string,
    role: "coordinator" | "worker" = "coordinator",
    permissions = {
      send: true,
      receive: true,
      claimTasks: true,
      manageTasks: role === "coordinator",
    },
  ) => {
    const preview = f.engine.previewTeamMember({
      workspaceId: f.workspace.id,
      teamId: team.id,
      memberId,
      expectedRevision: 0,
      role,
      permissions,
      expiresAt,
      rootSessionId: f.session.id,
      ...(childTaskId ? { childTaskId } : {}),
    });
    return f.engine.joinTeamMember({
      workspaceId: f.workspace.id,
      requestId: `join-${memberId}`,
      approved: true,
      preview,
    }).record;
  };
  const rootMember = join("root-member"),
    childMember = join("child-member", child.task.id, "worker");
  const send = (requestId = "message") =>
    f.engine.sendAgentMessage({
      workspaceId: f.workspace.id,
      teamId: team.id,
      senderMemberId: rootMember.memberId,
      senderGeneration: rootMember.generation,
      recipientMemberId: childMember.memberId,
      recipientGeneration: childMember.generation,
      requestId,
      text: "Whole original message; no tool or verification authority.",
      expiresAt,
    });
  const page = () =>
    f.engine.readAgentMailbox({
      workspaceId: f.workspace.id,
      teamId: team.id,
      memberId: childMember.memberId,
      generation: childMember.generation,
    });
  const rows = () =>
    readDatabase(f.dbPath, (db) =>
      Object.fromEntries(
        [
          "team_state_revisions",
          "team_messages",
          "team_operation_receipts",
          "team_deliveries",
          "team_delivery_receipts",
        ].map((table) => [
          table,
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
        ]),
      ),
    );
  return {
    ...f,
    ...child,
    team,
    rootMember,
    childMember,
    expiresAt,
    join,
    send,
    page,
    rows,
  };
}

test("host original member owner wrappers reject copied/proxy/getter descriptions without rerunning host ownership reads", async (t) => {
  const f = await current(t),
    host = Reflect.get(f.engine, "teamHost") as TeamHostService,
    original = host.captureOwner({
      workspaceId: f.workspace.id,
      rootSessionId: f.session.id,
      childTaskId: f.task.id,
    });
  const proof = host.readMemberOwner(original),
    rows = f.rows();
  let traps = 0;
  assert.equal(
    proof.workspaceId,
    f.child.store.getRun(proof.runId).workspaceId,
  );
  assert.notEqual(proof.workspaceId, f.workspace.id);
  assert.equal(
    proof.childStorageSha256,
    f.engine.children.teamBridge.capture(f.session.id, f.task.id)
      .storageBindingSha256,
  );
  assert.throws(
    () => host.readMemberOwner(structuredClone(original)),
    failure("TEAM_OWNER_STALE"),
  );
  assert.throws(
    () =>
      host.readMemberOwner(
        new Proxy(original, {
          get() {
            traps++;
            throw Error("trap");
          },
          getOwnPropertyDescriptor() {
            traps++;
            throw Error("trap");
          },
        }),
      ),
    failure("TEAM_OWNER_STALE"),
  );
  const getter = {};
  Object.defineProperty(getter, "id", {
    enumerable: true,
    get() {
      traps++;
      throw Error("trap");
    },
  });
  assert.throws(
    () => host.readMemberOwner(getter),
    failure("TEAM_OWNER_STALE"),
  );
  host.releaseOwner(original);
  assert.throws(
    () => host.readMemberOwner(original),
    failure("TEAM_OWNER_STALE"),
  );
  assert.equal(traps, 0);
  assert.deepEqual(f.rows(), rows);
});

test("approval inputs reject accessors, nested permission accessors, proxies and false approval before native admission", async (t) => {
  const f = await current(t),
    rows = f.rows();
  let traps = 0;
  const input = {
    workspaceId: f.workspace.id,
    teamId: f.team.id,
    memberId: "fresh",
    expectedRevision: 0,
    role: "worker" as const,
    permissions: {
      send: true,
      receive: true,
      claimTasks: true,
      manageTasks: false,
    },
    expiresAt: f.expiresAt,
    rootSessionId: f.session.id,
    childTaskId: f.task.id,
  };
  const getter = { ...input };
  Object.defineProperty(getter, "permissions", {
    enumerable: true,
    get() {
      traps++;
      return input.permissions;
    },
  });
  assert.throws(() => f.engine.previewTeamMember(getter), failure());
  const permissionGetter = { ...input.permissions };
  Object.defineProperty(permissionGetter, "receive", {
    enumerable: true,
    get() {
      traps++;
      return true;
    },
  });
  assert.throws(
    () =>
      f.engine.previewTeamMember({ ...input, permissions: permissionGetter }),
    failure(),
  );
  assert.throws(
    () =>
      f.engine.previewTeamMember(
        new Proxy(input, {
          ownKeys() {
            traps++;
            return [];
          },
        }),
      ),
    failure(),
  );
  const preview = f.engine.previewTeamMember(input);
  assert.throws(
    () =>
      f.engine.joinTeamMember({
        workspaceId: f.workspace.id,
        requestId: "false",
        approved: false,
        preview,
      }),
    failure("TEAM_APPROVAL_REQUIRED"),
  );
  assert.throws(
    () =>
      f.engine.joinTeamMember({
        workspaceId: f.workspace.id,
        requestId: "copy",
        approved: true,
        preview: structuredClone(preview),
      }),
    failure("TEAM_PREVIEW_STALE"),
  );
  const signal = new AbortController();
  signal.abort();
  assert.throws(
    () =>
      f.engine.joinTeamMember({
        workspaceId: f.workspace.id,
        requestId: "abort",
        approved: true,
        preview,
        signal: signal.signal,
      }),
    failure("TEAM_CANCELLED"),
  );
  f.engine.releaseTeamMemberPreview(preview);
  assert.equal(traps, 0);
  assert.deepEqual(f.rows(), rows);
});

test("exact same original membership approval is historical while changing its request cannot reuse approval", async (t) => {
  const f = await current(t),
    preview = f.engine.previewTeamMember({
      workspaceId: f.workspace.id,
      teamId: f.team.id,
      memberId: "approved-once",
      expectedRevision: 0,
      role: "observer",
      permissions: {
        send: false,
        receive: true,
        claimTasks: false,
        manageTasks: false,
      },
      expiresAt: f.expiresAt,
      rootSessionId: f.session.id,
    });
  const first = f.engine.joinTeamMember({
      workspaceId: f.workspace.id,
      requestId: "once",
      approved: true,
      preview,
    }),
    rows = f.rows();
  const duplicate = f.engine.joinTeamMember({
    workspaceId: f.workspace.id,
    requestId: "once",
    approved: true,
    preview,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.sha256, first.record.sha256);
  assert.equal(duplicate.receipt.sha256, first.receipt.sha256);
  assert.throws(
    () =>
      f.engine.joinTeamMember({
        workspaceId: f.workspace.id,
        requestId: "twice",
        approved: true,
        preview,
      }),
    failure("TEAM_PREVIEW_USED"),
  );
  assert.deepEqual(f.rows(), rows);
});

test("cached original mailbox claim requires exact cursor revision and refuses delivery after claim", async (t) => {
  const f = await current(t);
  f.send();
  const page = f.page(),
    input = {
      workspaceId: f.workspace.id,
      requestId: "claim-once",
      page,
      expectedCursorRevision: page.cursor.revision,
    },
    first = f.engine.claimAgentMailbox(input),
    rows = f.rows();
  assert.equal(f.engine.claimAgentMailbox(input).duplicate, true);
  assert.throws(
    () =>
      f.engine.claimAgentMailbox({
        ...input,
        expectedCursorRevision: input.expectedCursorRevision + 1,
      }),
    failure("TEAM_REQUEST_CONFLICT"),
  );
  assert.throws(
    () =>
      f.engine.resumeChildTurn({
        ...input,
        requestId: "deliver-after-claim",
        approved: true,
      }),
    failure("TEAM_PAGE_USED"),
  );
  assert.equal(first.messages.length, 1);
  assert.deepEqual(f.rows(), rows);
  assert.equal(
    f.child.store.pendingInputs(f.childMember.owner.sessionId, "steer").length,
    0,
  );
});

test("actual accepted child input with failed root settlement remains uncertain; exact replay observes history without a second input", async (t) => {
  const f = await current(t);
  f.send();
  const page = f.page(),
    native = Reflect.get(f.engine, "teamRecords") as {
      completeDelivery(...args: unknown[]): unknown;
    };
  t.mock.method(native, "completeDelivery", () => {
    throw new EngineError(
      "TEAM_SETTLEMENT_FAILED",
      "Injected root transaction failure after original child acceptance",
    );
  });
  const input = {
    workspaceId: f.workspace.id,
    requestId: "cross-store-gap",
    approved: true,
    page,
    expectedCursorRevision: page.cursor.revision,
  };
  assert.throws(
    () => f.engine.resumeChildTurn(input),
    failure("TEAM_SETTLEMENT_FAILED"),
  );
  const inputs = f.child.store.pendingInputs(
    f.childMember.owner.sessionId,
    "steer",
  );
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.requestId.startsWith("team-delivery:"), true);
  const rows = f.rows(),
    counts = f.codingCounts(),
    history = f.engine.resumeChildTurn(input);
  assert.equal(history.duplicate, true);
  assert.equal(history.record.state, "uncertain");
  assert.equal(history.receipt, null);
  assert.deepEqual(f.rows(), rows);
  assert.deepEqual(f.codingCounts(), counts);
  assert.equal(
    f.child.store.pendingInputs(f.childMember.owner.sessionId, "steer").length,
    1,
  );
  assert.throws(
    () => f.engine.resumeChildTurn({ ...input, requestId: "retry-new" }),
    failure("TEAM_PAGE_USED"),
  );
  assert.throws(() => f.page(), failure("TEAM_DELIVERY_UNCERTAIN"));
});

test("same actual owner under two memberships cannot lend coordinator permission to selected worker task actor", async (t) => {
  const f = await current(t),
    worker = f.join("same-owner-worker", undefined, "worker");
  const input = {
      workspaceId: f.workspace.id,
      teamId: f.team.id,
      memberId: worker.memberId,
      generation: worker.generation,
      taskId: "worker-task",
      requestId: "worker-task",
      expectedRevision: 0,
      title: "Host-selected actor",
      description: "No permission borrowing.",
      dependencies: [],
      expiresAt: f.expiresAt,
    },
    rows = f.rows();
  assert.equal(worker.owner.sha256, f.rootMember.owner.sha256);
  assert.throws(() => f.engine.putTeamTask(input), failure("TEAM_PERMISSION"));
  assert.deepEqual(f.rows(), rows);
  const task = f.engine.putTeamTask({
    ...input,
    memberId: f.rootMember.memberId,
    generation: f.rootMember.generation,
    requestId: "coordinator-task",
  });
  assert.equal(task.record.state, "pending");
  assert.equal(task.receipt.actorId, f.rootMember.memberId);
});

test("team quoted input keeps complete text as data and rejects hostile page getters before invoking them", async (t) => {
  const f = await current(t);
  f.send();
  const page = f.page(),
    formatted = teamMailboxInput(page);
  assert.equal(Buffer.byteLength(formatted.prompt) <= 65536, true);
  assert.equal(
    formatted.prompt.startsWith("[Moodcode team mailbox v1]\n"),
    true,
  );
  const decoded = JSON.parse(
    formatted.prompt.slice(formatted.prompt.indexOf("\n") + 1),
  );
  assert.equal(decoded.authority, "untrusted-team-data");
  assert.equal(decoded.messages[0].text, page.messages[0]!.text);
  assert.equal(Object.hasOwn(decoded, "tools"), false);
  let traps = 0;
  const getter = { ...page };
  Object.defineProperty(getter, "messages", {
    enumerable: true,
    get() {
      traps++;
      return [];
    },
  });
  assert.throws(() => teamMailboxInput(getter));
  assert.equal(traps, 0);
  f.engine.releaseAgentMailboxPage(page);
});

test("actual readonly message and board request receipts survive close/reopen without capturing current execution ownership", async (t) => {
  const f = await current(t),
    sendInput = {
      workspaceId: f.workspace.id,
      teamId: f.team.id,
      senderMemberId: f.rootMember.memberId,
      senderGeneration: f.rootMember.generation,
      recipientMemberId: f.childMember.memberId,
      recipientGeneration: f.childMember.generation,
      requestId: "historical-message",
      text: "Historical immutable message.",
      expiresAt: f.expiresAt,
    },
    sent = f.engine.sendAgentMessage(sendInput),
    taskInput = {
      workspaceId: f.workspace.id,
      teamId: f.team.id,
      memberId: f.rootMember.memberId,
      generation: f.rootMember.generation,
      taskId: "historical-task",
      requestId: "historical-task",
      expectedRevision: 0,
      title: "Immutable board history",
      description: "A board claim creates no execution.",
      dependencies: [],
      expiresAt: f.expiresAt,
    },
    task = f.engine.putTeamTask(taskInput),
    claimInput = {
      workspaceId: f.workspace.id,
      teamId: f.team.id,
      memberId: f.childMember.memberId,
      generation: f.childMember.generation,
      taskId: task.record.taskId,
      requestId: "historical-claim",
      expectedRevision: task.record.revision,
    },
    claim = f.engine.claimTeamTask(claimInput),
    completeInput = {
      ...claimInput,
      requestId: "historical-complete",
      expectedRevision: claim.record.revision,
    },
    complete = f.engine.completeTeamTask(completeInput);
  f.childRelease.resolve();
  await f.engine.children.tasks.wait(f.session.id, f.task.id);
  const parent = await f.startParent();
  f.parentRelease.resolve();
  await f.engine.waitForRun(parent.runId);
  await f.engine.close();
  const reopened = createEngine(f.configuration);
  f.engines.add(reopened);
  const host = Reflect.get(reopened, "teamHost") as TeamHostService;
  let reads = 0;
  t.mock.method(host, "captureOwner", () => {
    reads++;
    throw new Error("A historical result attempted current authority");
  });
  const before = f.rows(),
    requests = f.requests.length;
  for (const [actual, original] of [
    [reopened.sendAgentMessage(sendInput), sent],
    [reopened.putTeamTask(taskInput), task],
    [reopened.claimTeamTask(claimInput), claim],
    [reopened.completeTeamTask(completeInput), complete],
  ] as const) {
    assert.equal(actual.duplicate, true);
    assert.equal(actual.record.sha256, original.record.sha256);
    assert.equal(actual.receipt.sha256, original.receipt.sha256);
  }
  assert.throws(
    () =>
      reopened.sendAgentMessage({
        ...sendInput,
        text: "A changed request is not history.",
      }),
    failure("TEAM_REQUEST_CONFLICT"),
  );
  assert.throws(
    () =>
      reopened.completeTeamTask({
        ...completeInput,
        expectedRevision: completeInput.expectedRevision + 1,
      }),
    failure("TEAM_REQUEST_CONFLICT"),
  );
  assert.equal(reads, 0);
  assert.equal(f.requests.length, requests);
  assert.deepEqual(f.rows(), before);
});
