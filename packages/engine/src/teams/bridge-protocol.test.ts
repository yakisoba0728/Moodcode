import assert from "node:assert/strict";
import test from "node:test";
import { TeamHostService } from "./host.js";
import { TeamStorage } from "./store.js";
import { failure, readDatabase, teamFixture } from "./fixtures/engine-team.js";
import { nativeTeam, workerPermissions } from "./fixtures/native-team.js";

const PROMPT =
  "[Moodcode team mailbox v1]\n" +
  JSON.stringify({
    schemaVersion: 1,
    authority: "untrusted-team-data",
    text: "Original actual child input proof only.",
  });

test("original child target accessor, proxy and extra object mutations reject without invoking traps or admitting native inputs", async (t) => {
  const f = await teamFixture(t),
    { task, child } = await f.startChild(),
    bridge = f.engine.children.teamBridge,
    requests = structuredClone(f.requests),
    counts = f.codingCounts();
  let traps = 0;
  const getter = bridge.capture(f.session.id, task.id),
    runId = getter.childRunId,
    inputs = child.store.listInputs(getter.childSessionId);
  Object.defineProperty(getter, "childRunId", {
    enumerable: true,
    configurable: true,
    get() {
      traps++;
      return runId;
    },
  });
  assert.throws(() => bridge.readTarget(getter), failure("TEAM_CHILD_STALE"));
  assert.throws(
    () => bridge.accept(getter, { requestId: "getter-target", prompt: PROMPT }),
    failure("TEAM_CHILD_STALE"),
  );
  const nested = bridge.capture(f.session.id, task.id);
  Object.defineProperty(nested, "extra", {
    enumerable: true,
    value: {
      toJSON() {
        traps++;
        return "extra";
      },
    },
  });
  assert.throws(
    () => bridge.assertCurrent(nested),
    failure("TEAM_CHILD_STALE"),
  );
  assert.throws(
    () => bridge.accept(nested, { requestId: "object-target", prompt: PROMPT }),
    failure("TEAM_CHILD_STALE"),
  );
  const original = bridge.capture(f.session.id, task.id),
    proxy = new Proxy(original, {
      getPrototypeOf() {
        traps++;
        return Object.prototype;
      },
      get() {
        traps++;
        throw Error("trap");
      },
      ownKeys() {
        traps++;
        return [];
      },
    });
  assert.throws(
    () => bridge.accept(proxy, { requestId: "proxy-target", prompt: PROMPT }),
    failure("TEAM_CHILD_STALE"),
  );
  assert.equal(traps, 0);
  assert.deepEqual(child.store.listInputs(original.childSessionId), inputs);
  assert.equal(
    child.store.pendingInputs(original.childSessionId, "steer").length,
    0,
  );
  assert.deepEqual(f.requests, requests);
  assert.deepEqual(f.codingCounts(), counts);
});

test("original accepted input evidence and bridge argument accessors cannot rerun protocol code or add a second child input", async (t) => {
  const f = await teamFixture(t),
    { task, child } = await f.startChild(),
    bridge = f.engine.children.teamBridge,
    target = bridge.capture(f.session.id, task.id),
    accepted = bridge.accept(target, {
      requestId: "actual-first",
      prompt: PROMPT,
    }),
    inputs = child.store.listInputs(target.childSessionId),
    requests = structuredClone(f.requests);
  let traps = 0;
  const inputId = accepted.inputId;
  Object.defineProperty(accepted, "inputId", {
    enumerable: true,
    configurable: true,
    get() {
      traps++;
      return inputId;
    },
  });
  assert.throws(
    () => bridge.readReceipt(accepted),
    failure("TEAM_CHILD_STALE"),
  );
  assert.throws(
    () => bridge.readAccepted(target, accepted),
    failure("TEAM_CHILD_STALE"),
  );
  const proxy = new Proxy(accepted, {
    getPrototypeOf() {
      traps++;
      return Object.prototype;
    },
    ownKeys() {
      traps++;
      return [];
    },
  });
  assert.throws(() => bridge.readReceipt(proxy), failure("TEAM_CHILD_STALE"));
  const getter = { requestId: "getter-input", prompt: PROMPT };
  Object.defineProperty(getter, "prompt", {
    enumerable: true,
    get() {
      traps++;
      return PROMPT;
    },
  });
  assert.throws(
    () => bridge.accept(target, getter),
    failure("TEAM_CHILD_STALE"),
  );
  const extra = {
    requestId: "object-input",
    prompt: PROMPT,
    extra: {
      toJSON() {
        traps++;
        return "object";
      },
    },
  };
  assert.throws(
    () => bridge.accept(target, extra),
    failure("TEAM_CHILD_STALE"),
  );
  const argumentProxy = new Proxy(
    { requestId: "proxy-input", prompt: PROMPT },
    {
      getPrototypeOf() {
        traps++;
        return Object.prototype;
      },
    },
  );
  assert.throws(
    () => bridge.accept(target, argumentProxy),
    failure("TEAM_CHILD_STALE"),
  );
  assert.equal(traps, 0);
  assert.deepEqual(child.store.listInputs(target.childSessionId), inputs);
  assert.equal(
    child.store.pendingInputs(target.childSessionId, "steer").length,
    1,
  );
  assert.deepEqual(f.requests, requests);
});

test("native membership same request cannot bind a different actual child owner even when its other approval fields match", async (t) => {
  const f = await nativeTeam(t),
    first = await f.startChild(),
    second = await f.startChild(),
    host = Reflect.get(f.engine, "teamHost"),
    native = Reflect.get(f.engine, "teamRecords");
  assert.ok(host instanceof TeamHostService);
  assert.ok(native instanceof TeamStorage);
  const a = host.captureOwner({
      workspaceId: f.workspace.id,
      rootSessionId: f.session.id,
      childTaskId: first.task.id,
    }),
    b = host.captureOwner({
      workspaceId: f.workspace.id,
      rootSessionId: f.session.id,
      childTaskId: second.task.id,
    });
  try {
    const ownerA = host.readMemberOwner(a),
      ownerB = host.readMemberOwner(b);
    assert.notEqual(ownerA.sha256, ownerB.sha256);
    assert.notEqual(ownerA.runId, ownerB.runId);
    assert.notEqual(ownerA.childStorageSha256, ownerB.childStorageSha256);
    const input = {
        workspaceId: f.workspace.id,
        teamId: f.created.record.id,
        memberId: "exact-original-child",
        requestId: "native-original-owner-request",
        expectedRevision: 0,
        role: "worker" as const,
        permissions: workerPermissions,
        expiresAt: f.expiresAt,
        ownerSha256: ownerA.sha256,
      },
      record = native.registerMember(a, input),
      counts = () =>
        readDatabase(f.dbPath, (db) =>
          Object.fromEntries(
            [
              "team_state_revisions",
              "team_state_heads",
              "team_mailbox_cursors",
              "team_operation_receipts",
              "team_deliveries",
            ].map((table) => [
              table,
              db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
            ]),
          ),
        ),
      before = counts(),
      requests = structuredClone(f.requests),
      inputsA = first.child.store.listInputs(ownerA.sessionId),
      inputsB = second.child.store.listInputs(ownerB.sessionId);
    assert.throws(
      () => native.registerMember(b, { ...input, ownerSha256: ownerB.sha256 }),
      failure("TEAM_REQUEST_CONFLICT"),
    );
    assert.equal(
      native.getMember(f.workspace.id, f.created.record.id, input.memberId)
        ?.owner.sha256,
      record.record.owner.sha256,
    );
    assert.deepEqual(counts(), before);
    assert.deepEqual(first.child.store.listInputs(ownerA.sessionId), inputsA);
    assert.deepEqual(second.child.store.listInputs(ownerB.sessionId), inputsB);
    assert.deepEqual(f.requests, requests);
  } finally {
    host.releaseOwner(a);
    host.releaseOwner(b);
  }
});
