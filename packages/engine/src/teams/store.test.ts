import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import { TeamStorage, validateTeamDatabase } from "./store.js";
import { TEAM_TABLES } from "./schema.js";
import { RECOVERY_LIMITS } from "../recovery/snapshot.js";
import type {
  TeamMemberRevision,
  TeamRequestResult,
  TeamRecord,
  SendAgentMessageInput,
} from "./types.js";
import { teamFixture, invoke } from "./fixtures/engine-team.js";
function error(code?: string) {
  return (e: unknown) =>
    e instanceof EngineError && (code === undefined || e.code === code);
}
async function fixture(t: Parameters<typeof teamFixture>[0]) {
  const f = await teamFixture(t, { engine: { teams: true } });
  const child = await f.startChild();
  const expiry = new Date(Date.now() + 10000).toISOString();
  const team = invoke<TeamRequestResult<TeamRecord>>(f.engine, "createTeam", {
    workspaceId: f.workspace.id,
    requestId: "native-create-team",
    teamId: "native-team",
    expiresAt: expiry,
  });
  function join(
    memberId: string,
    role: "coordinator" | "worker" | "observer" = "worker",
  ) {
    const preview = invoke(f.engine, "previewTeamMember", {
      workspaceId: f.workspace.id,
      teamId: team.record.id,
      memberId,
      expectedRevision: 0,
      role,
      permissions: {
        send: role !== "observer",
        receive: true,
        claimTasks: role !== "observer",
        manageTasks: role === "coordinator",
      },
      expiresAt: expiry,
      rootSessionId: f.session.id,
      childTaskId: child.task.id,
    });
    return invoke<TeamRequestResult<TeamMemberRevision>>(
      f.engine,
      "joinTeamMember",
      {
        workspaceId: f.workspace.id,
        requestId: `join-${memberId}`,
        approved: true,
        preview,
      },
    );
  }
  const first = join("first", "coordinator"),
    second = join("second");
  const storage = Reflect.get(f.engine, "teamRecords");
  assert.ok(storage instanceof TeamStorage);
  const db = Reflect.get(f.engine.store, "db");
  assert.ok(db instanceof DatabaseSync);
  const host = Reflect.get(f.engine, "teamHost");
  function owner() {
    return host.captureOwner({
      workspaceId: f.workspace.id,
      rootSessionId: f.session.id,
      childTaskId: child.task.id,
    }) as object;
  }
  function sendInput(
    requestId: string = randomUUID(),
    text = "actual native message",
    expiresAt = expiry,
  ): SendAgentMessageInput {
    return {
      workspaceId: f.workspace.id,
      teamId: team.record.id,
      senderMemberId: first.record.memberId,
      senderGeneration: first.record.generation,
      recipientMemberId: second.record.memberId,
      recipientGeneration: second.record.generation,
      requestId,
      text,
      expiresAt,
    };
  }
  function send(requestId?: string, text?: string, expiresAt?: string) {
    const capture = owner();
    try {
      return storage.send(capture, sendInput(requestId, text, expiresAt));
    } finally {
      host.releaseOwner(capture);
    }
  }
  return {
    ...f,
    child,
    team,
    first,
    second,
    storage,
    db,
    host,
    owner,
    send,
    sendInput,
    expiry,
  };
}
test("native seven-table schema fits existing recovery catalog and immutable history validates", async (t) => {
  const f = await fixture(t);
  const catalog = f.db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    )
    .get()!.n;
  assert.ok(Number(catalog) <= RECOVERY_LIMITS.maxSchemaEntries);
  assert.equal(TEAM_TABLES.length, 7);
  f.send();
  assert.doesNotThrow(() => validateTeamDatabase(f.db));
});
test("native malformed send rejects hostile getters and proxy before owner callback or messages", async (t) => {
  const f = await fixture(t);
  let traps = 0,
    owners = 0;
  t.mock.method(f.storage.ports, "readMemberOwner", () => {
    owners++;
    throw Error("must not read owner");
  });
  const getter = Object.defineProperty({}, "workspaceId", {
      enumerable: true,
      get() {
        traps++;
        throw Error("getter");
      },
    }),
    proxy = new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          throw Error("proxy");
        },
      },
    );
  for (const input of [null, [], getter, proxy])
    assert.throws(
      () => f.storage.send({}, input as SendAgentMessageInput),
      error(),
    );
  assert.equal(traps, 0);
  assert.equal(owners, 0);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM team_messages").get()!.n,
    0,
  );
});
test("exact native send duplicate returns history after live source is unavailable and conflict changes no sequence", async (t) => {
  const f = await fixture(t),
    input = f.sendInput("exact-native-history"),
    owner = f.owner();
  const original = f.storage.send(owner, input);
  f.host.releaseOwner(owner);
  t.mock.method(f.storage.ports, "readMemberOwner", () => {
    throw Error("must not recapture historical member");
  });
  const duplicate = f.storage.send({}, input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.sha256, original.record.sha256);
  assert.equal(
    f.storage.findSendRequest(input)?.receipt.sha256,
    original.receipt.sha256,
  );
  const before = f.storage.cursor(f.workspace.id, "native-team", "second", 1);
  assert.throws(
    () => f.storage.findSendRequest({ ...input, text: "different" }),
    error("TEAM_REQUEST_CONFLICT"),
  );
  assert.equal(
    f.storage.cursor(f.workspace.id, "native-team", "second", 1).sha256,
    before.sha256,
  );
});
test("mailbox exact ordering and original page CAS reject copy and post-read append without moving cursor", async (t) => {
  const f = await fixture(t);
  f.send("first-send", "first");
  f.send("second-send", "second");
  const owner = f.owner(),
    page = f.storage.readMailbox(owner, {
      workspaceId: f.workspace.id,
      teamId: "native-team",
      memberId: "second",
      generation: 1,
    });
  assert.deepEqual(
    page.messages.map((m) => [m.seq, m.text]),
    [
      [1, "first"],
      [2, "second"],
    ],
  );
  const before = f.storage.cursor(f.workspace.id, "native-team", "second", 1);
  assert.throws(
    () =>
      f.storage.claimMailbox(
        { ...page },
        { requestId: "copied", expectedCursorRevision: page.cursor.revision },
      ),
    error("TEAM_PAGE_REQUIRED"),
  );
  assert.equal(
    f.storage.cursor(f.workspace.id, "native-team", "second", 1).sha256,
    before.sha256,
  );
  f.send("third-send", "third");
  assert.throws(
    () =>
      f.storage.claimMailbox(page, {
        requestId: "stale",
        expectedCursorRevision: page.cursor.revision,
      }),
    error("TEAM_STALE"),
  );
  f.storage.releasePage(page);
  f.host.releaseOwner(owner);
  const freshOwner = f.owner(),
    fresh = f.storage.readMailbox(freshOwner, {
      workspaceId: f.workspace.id,
      teamId: "native-team",
      memberId: "second",
      generation: 1,
    }),
    claimed = f.storage.claimMailbox(fresh, {
      requestId: "actual-claim",
      expectedCursorRevision: fresh.cursor.revision,
    });
  assert.equal(claimed.cursor.claimedSeq, 3);
  assert.equal(claimed.messages.length, 3);
  f.storage.releasePage(fresh);
  f.host.releaseOwner(freshOwner);
});
test("an expired mailbox head is read as its own page that can be claimed but not delivered", async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  Reflect.set(f.storage.ports, "now", () => clock);
  const short = new Date(clock + 1000).toISOString();
  f.send("expired-first", "expired first", short);
  f.send("live-second", "live second");
  f.send("expired-third", "expired third", short);
  clock += 1000;
  const owner = f.owner(),
    read = () =>
      f.storage.readMailbox(owner, {
        workspaceId: f.workspace.id,
        teamId: "native-team",
        memberId: "second",
        generation: 1,
      }),
    head = read();
  assert.deepEqual(
    head.messages.map((m) => m.text),
    ["expired first"],
  );
  assert.equal(head.hasMore, true);
  assert.throws(
    () =>
      f.storage.prepareDelivery(head, {
        requestId: "expired-delivery",
        expectedCursorRevision: head.cursor.revision,
      }),
    error("TEAM_STALE"),
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM team_deliveries").get()!.n,
    0,
  );
  const acknowledged = f.storage.claimMailbox(head, {
    requestId: "expired-ack",
    expectedCursorRevision: head.cursor.revision,
  });
  assert.equal(acknowledged.cursor.claimedSeq, 1);
  const live = read();
  assert.deepEqual(
    live.messages.map((m) => m.text),
    ["live second"],
  );
  assert.equal(live.hasMore, true);
  f.storage.claimMailbox(live, {
    requestId: "live-claim",
    expectedCursorRevision: live.cursor.revision,
  });
  const tail = read();
  assert.deepEqual(
    tail.messages.map((m) => m.text),
    ["expired third"],
  );
  assert.equal(tail.hasMore, false);
  assert.doesNotThrow(() => validateTeamDatabase(f.db));
  for (const page of [head, live, tail]) f.storage.releasePage(page);
  f.host.releaseOwner(owner);
});
test("native claim replay returns the stored receipt and cursor", async (t) => {
  const f = await fixture(t);
  f.send("replayed-claim-source");
  const owner = f.owner(),
    page = f.storage.readMailbox(owner, {
      workspaceId: f.workspace.id,
      teamId: "native-team",
      memberId: "second",
      generation: 1,
    }),
    input = {
      requestId: "replayed-claim",
      expectedCursorRevision: page.cursor.revision,
    },
    claim = f.storage.claimMailbox(page, input),
    replay = f.storage.claimMailbox(page, input);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.receipt, claim.receipt);
  assert.deepEqual(replay.cursor, claim.cursor);
  assert.deepEqual(replay.messages, claim.messages);
  f.storage.releasePage(page);
  f.host.releaseOwner(owner);
});
test("the team limit counts only active unexpired teams", async (t) => {
  const f = await teamFixture(t, { engine: { teams: true } }),
    storage = Reflect.get(f.engine, "teamRecords");
  assert.ok(storage instanceof TeamStorage);
  let clock = Date.now();
  Reflect.set(storage.ports, "now", () => clock);
  const create = (i: number) =>
    storage.createTeam({
      workspaceId: f.workspace.id,
      requestId: `limited-team-${i}`,
      expiresAt: new Date(clock + 1000).toISOString(),
    });
  for (let i = 0; i < 9; i++) {
    create(i);
    clock += 1000;
  }
  for (let i = 9; i < 17; i++) create(i);
  assert.throws(() => create(17), error("TEAM_LIMIT"));
});
test("a worker sharing the exact real child owner cannot borrow coordinator board permissions", async (t) => {
  const f = await fixture(t),
    owner = f.owner();
  assert.throws(
    () =>
      f.storage.putTask(owner, {
        workspaceId: f.workspace.id,
        teamId: "native-team",
        memberId: "second",
        generation: 1,
        taskId: "worker-no-borrow",
        requestId: "worker-no-borrow",
        expectedRevision: 0,
        title: "bounded task",
        description: "observations only",
        dependencies: [],
        expiresAt: f.expiry,
      }),
    error("TEAM_PERMISSION"),
  );
  assert.equal(
    f.storage.getTask(f.workspace.id, "native-team", "worker-no-borrow"),
    undefined,
  );
  const task = f.storage.putTask(owner, {
    workspaceId: f.workspace.id,
    teamId: "native-team",
    memberId: "first",
    generation: 1,
    taskId: "exact-coordinator",
    requestId: "exact-coordinator",
    expectedRevision: 0,
    title: "bounded task",
    description: "observations only",
    dependencies: [],
    expiresAt: f.expiry,
  });
  assert.equal(task.record.state, "pending");
  f.host.releaseOwner(owner);
});

test("native original mailbox pages enforce finite capacity and release permits a new capture", async (t) => {
  const f = await fixture(t),
    owner = f.owner(),
    pages = [];
  for (let i = 0; i < 128; i++)
    pages.push(
      f.storage.readMailbox(owner, {
        workspaceId: f.workspace.id,
        teamId: "native-team",
        memberId: "second",
        generation: 1,
      }),
    );
  assert.throws(
    () =>
      f.storage.readMailbox(owner, {
        workspaceId: f.workspace.id,
        teamId: "native-team",
        memberId: "second",
        generation: 1,
      }),
    error("TEAM_CAPACITY"),
  );
  f.storage.releasePage(pages[0]!);
  const replacement = f.storage.readMailbox(owner, {
    workspaceId: f.workspace.id,
    teamId: "native-team",
    memberId: "second",
    generation: 1,
  });
  assert.equal(
    replacement.bytes,
    Buffer.byteLength(JSON.stringify(replacement)),
  );
  for (const page of pages) f.storage.releasePage(page);
  f.storage.releasePage(replacement);
  f.host.releaseOwner(owner);
});

test("native claim transaction rollback preserves original cursor and permits exactly one later claim", async (t) => {
  const f = await fixture(t);
  f.send("claim-rollback-source");
  const owner = f.owner(),
    page = f.storage.readMailbox(owner, {
      workspaceId: f.workspace.id,
      teamId: "native-team",
      memberId: "second",
      generation: 1,
    }),
    before = f.storage.cursor(f.workspace.id, "native-team", "second", 1);
  f.db.exec(
    "CREATE TRIGGER authored_claim_failure BEFORE INSERT ON team_operation_receipts WHEN NEW.operation='claim-mailbox' BEGIN SELECT RAISE(ABORT,'owned claim SQL failure'); END",
  );
  assert.throws(() =>
    f.storage.claimMailbox(page, {
      requestId: "claim-rollback",
      expectedCursorRevision: page.cursor.revision,
    }),
  );
  assert.equal(
    f.storage.cursor(f.workspace.id, "native-team", "second", 1).sha256,
    before.sha256,
  );
  f.db.exec("DROP TRIGGER authored_claim_failure");
  const claim = f.storage.claimMailbox(page, {
    requestId: "claim-rollback",
    expectedCursorRevision: page.cursor.revision,
  });
  assert.equal(claim.cursor.claimedSeq, 1);
  assert.doesNotThrow(() => validateTeamDatabase(f.db));
  f.storage.releasePage(page);
  f.host.releaseOwner(owner);
});

test("actual child input accepted before root receipt rollback stays uncertain and prevents member reuse or board claims", async (t) => {
  const f = await fixture(t);
  f.send("uncertain-input-source");
  const page = invoke(f.engine, "readAgentMailbox", {
    workspaceId: f.workspace.id,
    teamId: "native-team",
    memberId: "second",
    generation: 1,
  }) as import("./types.js").TeamMailboxPage;
  f.db.exec(
    "CREATE TRIGGER authored_delivery_failure BEFORE INSERT ON team_delivery_receipts BEGIN SELECT RAISE(ABORT,'owned root receipt SQL failure'); END",
  );
  assert.throws(() =>
    invoke(f.engine, "resumeChildTurn", {
      workspaceId: f.workspace.id,
      requestId: "actual-uncertain-delivery",
      approved: true,
      page,
      expectedCursorRevision: page.cursor.revision,
    }),
  );
  f.db.exec("DROP TRIGGER authored_delivery_failure");
  const cursor = f.storage.cursor(f.workspace.id, "native-team", "second", 1);
  assert.ok(cursor.pendingDeliveryId);
  const record = f.storage.getDelivery(
    f.workspace.id,
    cursor.pendingDeliveryId,
  )!;
  assert.equal(record.state, "uncertain");
  assert.equal(
    f.storage.getDeliveryReceipt(f.workspace.id, record.id),
    undefined,
  );
  assert.equal(
    f.child.child.store.pendingInputs(record.owner.sessionId, "steer").length,
    1,
  );
  const owner = f.owner();
  assert.throws(
    () =>
      f.storage.activeMember(owner, f.workspace.id, "native-team", "second", 1),
    error("TEAM_DELIVERY_UNCERTAIN"),
  );
  assert.throws(
    () =>
      f.storage.activeMember(owner, f.workspace.id, "native-team", "first", 1),
    error("TEAM_DELIVERY_UNCERTAIN"),
  );
  f.host.releaseOwner(owner);
  assert.doesNotThrow(() => validateTeamDatabase(f.db));
});

test("actual message row cannot redirect a native membership pointer even if the JSON hash is re-signed", async (t) => {
  const f = await fixture(t),
    message = f.send("scope-proof").record;
  const row = f.db
    .prepare("SELECT data FROM team_messages WHERE id=?")
    .get(message.id)!;
  const body = JSON.parse(String(row.data));
  body.senderRevisionId = f.second.record.id;
  const { sha256, ...unsigned } = body;
  const { knowledgeHash } = await import("../knowledge/validation.js");
  const corrupted = { ...unsigned, sha256: knowledgeHash(unsigned) };
  f.db
    .prepare("UPDATE team_messages SET data=? WHERE id=?")
    .run(JSON.stringify(corrupted), message.id);
  assert.throws(() => validateTeamDatabase(f.db), error());
});
