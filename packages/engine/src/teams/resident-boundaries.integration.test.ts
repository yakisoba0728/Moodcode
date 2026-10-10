import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { residentFixture, residentUntil } from "./fixtures/resident.js";
import { failure, gate, readDatabase } from "./fixtures/engine-team.js";
import { createEngine } from "../engine.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { ProviderEvent } from "../ports.js";

test("resident idle TTL settles actual child close and refuses late delivery without admitting a new Run", async (t) => {
  const f = await residentFixture(t, {
    resident: {
      idleTimeoutMs: 40,
      allocation: {
        turns: 4,
        toolCalls: 3,
        outputBytes: 12000,
        durationMs: 5000,
      },
    },
  });
  const task = await f.engine.children.tasks.wait(f.session.id, f.task.id);
  assert.equal(task.state, "completed");
  assert.equal(
    f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state,
    "closed",
  );
  assert.throws(
    () => f.engine.children.teamBridge.capture(f.session.id, f.task.id),
    failure("TEAM_CHILD_STALE"),
  );
});
test("resident allocation is consumed cumulatively, parent reservation remains fixed, and budget exhaustion closes without another Run", async (t) => {
  const f = await residentFixture(t, {
    resident: {
      idleTimeoutMs: 5000,
      allocation: {
        turns: 3,
        toolCalls: 2,
        outputBytes: 12000,
        durationMs: 5000,
      },
    },
  });
  const before = f.engine.coordinator.getRemainingChildBudget(f.parent.runId);
  const delivery = f.deliver("last-budget").invoke();
  await f.engine.children.tasks.wait(f.session.id, f.task.id);
  const r = f.engine.inspectResidentChildTask(f.session.id, f.task.id)!;
  assert.equal(r.state, "closed");
  assert.equal(r.runs.length, 2);
  assert.equal(
    r.runs.reduce((a, x) => a + x.usage!.turns, 0),
    3,
  );
  const after = f.engine.coordinator.getRemainingChildBudget(f.parent.runId);
  for (const k of ["turns", "toolCalls", "outputBytes"] as const)
    assert.equal(before[k], after[k]);
  assert.equal(delivery.receipt?.input.delivery, "queue");
});
test("actual parent cancellation closes resident provider/engine; lifetime ownership is never inferred from future.cancel", async (t) => {
  const f = await residentFixture(t);
  await f.engine.coordinator.cancel(f.parent.runId);
  const settled = await f.engine.children.tasks.wait(f.session.id, f.task.id);
  assert.equal(settled.state, "cancelled");
  assert.equal(
    f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state,
    "closed",
  );
  assert.throws(
    () => f.engine.children.teamBridge.capture(f.session.id, f.task.id),
    failure("TEAM_CHILD_STALE"),
  );
});
test("registered source profile drift, copied mailbox pages and denied previews admit no continuation provider or input", async (t) => {
  const f = await residentFixture(t);
  const d = f.deliver("stale-profile");
  const before = f.requests.length,
    inputsBefore = f.child.store.listInputs(f.member.owner.sessionId).inputs
      .length;
  assert.throws(
    () =>
      f.engine.resumeChildTurn({
        workspaceId: f.workspace.id,
        requestId: "copy",
        approved: true,
        page: { ...d.page },
        expectedCursorRevision: d.page.cursor.revision,
      }),
    failure("TEAM_PAGE_STALE"),
  );
  const p = f.engine.profiles.list()[0]!;
  const { revision, ...spec } = p;
  f.engine.profiles.register({
    ...spec,
    instructions: "New explicit role request is required.",
  });
  assert.throws(
    () => d.invoke(),
    failure("RESIDENT_SOURCE_STALE", "TEAM_OWNER_STALE", "TEAM_CHILD_STALE"),
  );
  assert.equal(f.requests.length, before);
  assert.equal(
    f.child.store.listInputs(f.member.owner.sessionId).inputs.length,
    inputsBefore,
  );
});
test("SQL ACK failure after genuine child admission launches no next provider and leaves native uncertain debt", async (t) => {
  const f = await residentFixture(t);
  const db = new DatabaseSync(f.dbPath);
  db.exec(
    "CREATE TRIGGER fail_resident_ack BEFORE INSERT ON team_delivery_receipts BEGIN SELECT RAISE(ABORT,'real receipt fault'); END",
  );
  const before = f.requests.length;
  assert.throws(() => f.deliver("sql-ack").invoke(), /real receipt fault/);
  await residentUntil(
    () =>
      f.engine.children.tasks.get(f.session.id, f.task.id).state ===
      "uncertain",
    "actual resident failed ACK must retain uncertain owner",
  );
  db.exec("DROP TRIGGER fail_resident_ack");
  db.close();
  assert.equal(f.requests.length, before);
  const r = f.engine.inspectResidentChildTask(f.session.id, f.task.id)!;
  assert.equal(r.state, "uncertain");
  assert.equal(r.runs.length, 2);
  assert.equal(
    readDatabase(
      f.dbPath,
      (db) =>
        db
          .prepare("SELECT state FROM team_deliveries ORDER BY id LIMIT 1")
          .get()!.state,
    ),
    "uncertain",
  );
  assert.throws(
    () => f.engine.children.teamBridge.capture(f.session.id, f.task.id),
    failure("TEAM_CHILD_STALE"),
  );
});
test("busy resident rejects an early delivery before dispatch and keeps its live child, cursor and next turn", async (t) => {
  const busy = gate();
  t.after(busy.resolve);
  const f = await residentFixture(t, {
    streamChild: async function* (request, signal): AsyncIterable<ProviderEvent> {
      yield { type: "progress" };
      if (
        request.messages.some(
          (x) =>
            x.role === "user" && x.content.startsWith("[Moodcode team mailbox"),
        )
      )
        await busy.promise;
      if (!signal.aborted) yield { type: "finish", reason: "stop" };
    },
  });
  f.deliver("busy-first").invoke();
  assert.equal(
    f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state,
    "running",
  );
  const inputs = f.child.store.listInputs(f.member.owner.sessionId).inputs
    .length;
  assert.throws(
    () => f.deliver("busy-early").invoke(),
    failure("RESIDENT_BUSY"),
  );
  assert.equal(
    f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state,
    "running",
  );
  assert.equal(
    f.engine.children.tasks.get(f.session.id, f.task.id).state,
    "running",
  );
  assert.equal(
    f.child.store.listInputs(f.member.owner.sessionId).inputs.length,
    inputs,
  );
  assert.equal(
    readDatabase(
      f.dbPath,
      (db) =>
        db
          .prepare("SELECT state FROM team_deliveries WHERE request_id=?")
          .get("busy-early")!.state,
    ),
    "cancelled",
  );
  busy.resolve();
  await residentUntil(
    () =>
      f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state ===
      "idle",
    "busy resident must settle its first mailbox Run",
  );
  const next = f.deliver("busy-next");
  assert.equal(next.page.messages.length, 2);
  assert.equal(next.invoke().record.state, "delivered");
});
test("ACK and cancel failures after resident admission still release the child target", async (t) => {
  const f = await residentFixture(t);
  const db = new DatabaseSync(f.dbPath);
  db.exec(
    "CREATE TRIGGER fail_resident_ack BEFORE INSERT ON team_delivery_receipts BEGIN SELECT RAISE(ABORT,'real receipt fault'); END",
  );
  db.exec(
    "CREATE TRIGGER fail_resident_cancel BEFORE UPDATE ON team_deliveries WHEN NEW.state='uncertain' BEGIN SELECT RAISE(ABORT,'real cancel fault'); END",
  );
  assert.throws(
    () => f.deliver("ack-and-cancel").invoke(),
    /real receipt fault/,
  );
  db.exec("DROP TRIGGER fail_resident_ack");
  db.exec("DROP TRIGGER fail_resident_cancel");
  db.close();
  await residentUntil(
    () =>
      f.engine.children.tasks.get(f.session.id, f.task.id).state ===
      "uncertain",
    "released target must abandon the unconfirmed resident",
  );
  assert.equal(
    f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state,
    "uncertain",
  );
});
test("failed resident previews leave no retained slot", async (t) => {
  const f = await residentFixture(t);
  const request = {
    sessionId: f.session.id,
    requestId: "late-resident-preview",
    parentRunId: f.parent.runId,
    worktreeId: f.worktree.id,
    prompt: "late resident",
    tools: ["read_file"],
    allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 },
  };
  for (let index = 0; index < 32; index++)
    assert.throws(
      () =>
        f.engine.previewResidentChildTask({
          ...request,
          worktreeId: "missing-worktree",
        }),
      failure("WORKTREE_NOT_FOUND"),
    );
  f.engine.releaseResidentChildTaskPreview(
    f.engine.previewResidentChildTask(request),
  );
});
test("actual Root close joins a resident lifetime and reopen/default-off returns history without original actor or provider replay", async (t) => {
  const f = await residentFixture(t);
  f.deliver("completed-mailbox").invoke();
  await residentUntil(
    () =>
      f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state ===
      "idle",
    "actual continuation must settle",
  );
  await f.engine.close();
  const calls = f.requests.length;
  const reopened = createEngine({
    ...f.configuration,
    residentTeams: false,
    teams: false,
    teamModelTools: false,
  });
  f.engines.add(reopened);
  const record = reopened.inspectResidentChildTask(f.session.id, f.task.id)!;
  assert.equal(record.state, "closed");
  assert.equal(record.runs.length, 2);
  assert.throws(
    () => reopened.children.describeTeamOwner(f.session.id, f.task.id),
    failure("TEAM_OWNER_UNAVAILABLE"),
  );
  assert.equal(f.requests.length, calls);
});

test(
  "parent cancellation during resident actual run_command waits for native supervisor PID disappearance and genuine cleanup before task settlement",
  { skip: process.platform === "win32", timeout: 15000 },
  async (t) => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    let commandText = "";
    const f = await residentFixture(t, {
      childTools: ["run_command", "read_agent_mailbox"],
      streamChild: async function* (request): AsyncIterable<ProviderEvent> {
        const mailbox = request.messages.some(
          (x) =>
            x.role === "user" && x.content.startsWith("[Moodcode team mailbox"),
        );
        if (!mailbox) {
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield {
          type: "tool.call",
          call: {
            id: "resident-physical-command",
            name: "run_command",
            input: { command: commandText, timeoutMs: 5000 },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      },
    });
    const marker = join(f.worktree.root, "resident-pid");
    const js = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
    const quote = (x: string) => "'" + x.replaceAll("'", "'\"'\"'") + "'";
    commandText = quote(process.execPath) + " -e " + quote(js);
    f.deliver("physical-command").invoke();
    await residentUntil(
      () => f.engine.children.approvals(f.session.id, f.task.id).length > 0,
      "actual command must await approval",
    );
    for (const a of f.engine.children.approvals(f.session.id, f.task.id))
      f.engine.children.decide(
        f.session.id,
        f.task.id,
        a.id,
        a.fingerprint,
        "allow",
      );
    await residentUntil(
      () => existsSync(marker),
      "actual command PID admission",
    );
    const pid = Number(readFileSync(marker, "utf8"));
    assert.ok(pid > 0);
    process.kill(pid, 0);
    await f.engine.coordinator.cancel(f.parent.runId);
    const settled = await f.engine.children.tasks.wait(f.session.id, f.task.id);
    assert.equal(settled.state, "cancelled");
    await residentUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, "actual descendant process must disappear");
    assert.equal(
      f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state,
      "closed",
    );
  },
);

test(
  "resident actual provider iterator cleanup uncertainty retains task/worktree debt and blocks new actor or continuation",
  { timeout: 20000 },
  async (t) => {
    const f = await residentFixture(t, {
      streamChild(request) {
        if (
          !request.messages.some(
            (x) =>
              x.role === "user" &&
              x.content.startsWith("[Moodcode team mailbox"),
          )
        )
          return (async function* () {
            yield { type: "finish", reason: "stop" } as const;
          })();
        let first = true;
        const iterator: AsyncIterator<ProviderEvent> = {
          next() {
            if (first) {
              first = false;
              return Promise.resolve({
                done: false,
                value: { type: "progress" },
              });
            }
            return new Promise(() => {});
          },
          return() {
            return new Promise(() => {});
          },
        };
        return {
          [Symbol.asyncIterator]() {
            return iterator;
          },
        };
      },
    });
    f.deliver("unknown-cleanup").invoke();
    await residentUntil(
      () => f.requests.length >= 3,
      "genuine continuation provider entry",
    );
    await f.engine.coordinator.cancel(f.parent.runId);
    const settled = await f.engine.children.tasks.wait(f.session.id, f.task.id);
    assert.equal(settled.state, "uncertain");
    assert.equal(
      f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state,
      "uncertain",
    );
    assert.throws(
      () => f.engine.children.teamBridge.capture(f.session.id, f.task.id),
      failure("TEAM_CHILD_STALE"),
    );
    const preview = f.engine.previewTeamMember({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: "replacement",
      expectedRevision: 0,
      role: "worker",
      permissions: {
        send: true,
        receive: true,
        claimTasks: true,
        manageTasks: false,
      },
      expiresAt: f.expiresAt,
      rootSessionId: f.session.id,
      childTaskId: f.task.id,
    });
    assert.throws(
      () =>
        f.engine.joinTeamMember({
          workspaceId: f.workspace.id,
          requestId: "replacement-owner",
          approved: true,
          preview,
        }),
      failure(
        "TEAM_OWNER_STALE",
        "TEAM_OWNER_NOT_LIVE",
        "TEAM_OWNER_UNCERTAIN",
        "TEAM_OWNER_UNAVAILABLE",
        "TEAM_OWNER_INACTIVE",
      ),
    );
    f.engine.releaseTeamMemberPreview(preview);
  },
);

test("native parent prompt drift rejects resident continuation before actual input or provider dispatch", async (t) => {
  const f = await residentFixture(t);
  const d = f.deliver("native-parent-drift");
  const db = new DatabaseSync(f.dbPath);
  try {
    const row = db
      .prepare("SELECT data FROM runs WHERE id=?")
      .get(f.parent.runId)!;
    const changed = {
      ...JSON.parse(String(row.data)),
      prompt: "Changed after actual parent coordinator admission",
    };
    db.prepare("UPDATE runs SET data=? WHERE id=?").run(
      JSON.stringify(changed),
      f.parent.runId,
    );
    const count = f.requests.length,
      inputs = f.child.store.listInputs(f.member.owner.sessionId).inputs.length;
    assert.throws(
      () => d.invoke(),
      failure("RUN_OWNER_STALE", "TEAM_OWNER_STALE", "TEAM_CHILD_STALE"),
    );
    assert.equal(f.requests.length, count);
    assert.equal(
      f.child.store.listInputs(f.member.owner.sessionId).inputs.length,
      inputs,
    );
    db.prepare("UPDATE runs SET data=? WHERE id=?").run(
      String(row.data),
      f.parent.runId,
    );
  } finally {
    db.close();
  }
});

test("actual source drift after ACK commit before provider release retains receipt but immediately quarantines the unstarted resident Run", async (t) => {
  const f = await residentFixture(t);
  const native = Reflect.get(f.engine, "teamRecords"),
    complete = Reflect.get(native, "completeDelivery");
  Reflect.set(native, "completeDelivery", function (...args: unknown[]) {
    const result = Reflect.apply(complete, native, args);
    const old = f.engine.profiles.list()[0]!;
    const { revision, ...spec } = old;
    f.engine.profiles.register({
      ...spec,
      instructions: "Actual source changed after committed ACK.",
    });
    return result;
  });
  const count = f.requests.length;
  assert.throws(
    () => f.deliver("after-ack-source-drift").invoke(),
    failure("RESIDENT_SOURCE_STALE", "TEAM_OWNER_STALE", "TEAM_CHILD_STALE"),
  );
  await residentUntil(
    () =>
      f.engine.children.tasks.get(f.session.id, f.task.id).state ===
      "uncertain",
    "unreleased new Run must quarantine immediately rather than await idle TTL",
  );
  assert.equal(f.requests.length, count);
  assert.equal(
    f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state,
    "uncertain",
  );
  assert.equal(
    readDatabase(
      f.dbPath,
      (db) =>
        db.prepare("SELECT count(*) count FROM team_delivery_receipts").get()!
          .count,
    ),
    1,
  );
  assert.throws(
    () => f.engine.children.teamBridge.capture(f.session.id, f.task.id),
    failure("TEAM_CHILD_STALE"),
  );
});
