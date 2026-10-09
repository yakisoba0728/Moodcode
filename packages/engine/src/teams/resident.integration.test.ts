import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Session } from "@moodcode/contracts";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { createEngine } from "../engine.js";
import { teamBoardKind } from "./workflow-board.js";
import { validateResidentTeamDatabase } from "./resident-validation.js";
import { validateTeamDatabase } from "./store.js";
import { nativeTeam } from "./fixtures/native-team.js";
import {
  command,
  gate,
  failure,
  readDatabase,
} from "./fixtures/engine-team.js";
import type { ProviderEvent } from "../ports.js";

async function until(check: () => boolean, detail: string) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, detail);
    await new Promise((r) => setTimeout(r, 3));
  }
}
test(
  "one genuine resident child rejects a wrong-session stop and consumes two mailbox inputs as separate native Runs/Tool Parts and ACKs without closing its engine",
  { timeout: 15000 },
  async (t) => {
    const first = gate();
    let entries = 0;
    const f = await nativeTeam(t, {
      engine: { residentTeams: true, teamModelTools: true },
      resident: {
        idleTimeoutMs: 5000,
        allocation: {
          turns: 9,
          toolCalls: 8,
          outputBytes: 30000,
          durationMs: 20000,
        },
      },
      childTools: ["read_file", "read_agent_mailbox"],
      async *streamChild(request, signal): AsyncIterable<ProviderEvent> {
        const mailbox = request.messages.filter(
          (x) =>
            x.role === "user" && x.content.startsWith("[Moodcode team mailbox"),
        );
        if (!mailbox.length) {
          entries++;
          yield { type: "progress" };
          await first.promise;
          yield { type: "finish", reason: "stop" };
          return;
        }
        const tool = request.messages.at(-1)?.role === "tool";
        if (!tool) {
          entries++;
          yield {
            type: "tool.call",
            call: {
              id: `read-${mailbox.length}`,
              name: "read_agent_mailbox",
              input: {},
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield {
            type: "text.delta",
            delta: "Mailbox DATA was observed by the actual current child.",
          };
          yield { type: "finish", reason: "stop" };
        }
      },
    });
    const x = await f.child();
    f.engine.bindTeamModelTools({
      rootSessionId: f.session.id,
      teamId: f.created.record.id,
      memberId: x.member.memberId,
      generation: x.member.generation,
      childTaskId: x.task.id,
    });
    first.resolve();
    await until(
      () =>
        f.engine.inspectResidentChildTask(f.session.id, x.task.id)?.state ===
        "idle",
      "initial child must be idle",
    );
    const initial = x.child.store.getRun(x.task.childRunId!);
    assert.equal(initial.state, "completed");
    assert.equal(
      f.engine.children.tasks.get(f.session.id, x.task.id).state,
      "running",
    );
    const otherSession = await command<Session>(f.engine, "session.create", {
      workspaceId: f.workspace.id,
    });
    const childDbPath = join(
      f.configuration.worktreeDirectory ?? join(f.artifactDir, "children"),
      x.task.id,
      "engine.sqlite",
    );
    const nativeRows = (path: string, sessionId: string) =>
      readDatabase(path, (db) =>
        Object.fromEntries(
          [
            "runs",
            "session_inputs",
            "events",
            "session_events",
            "session_documents",
          ].map((table) => [
            table,
            db
              .prepare(
                `SELECT * FROM ${table} WHERE session_id=? ORDER BY rowid`,
              )
              .all(sessionId),
          ]),
        ),
      );
    const observe = () => {
      // Duration is a ticking deadline; native records pin it while these reservations stay fixed.
      const { turns, toolCalls, outputBytes } =
        f.engine.coordinator.getRemainingChildBudget(f.parent.runId);
      return {
        taskState: f.engine.children.tasks.get(f.session.id, x.task.id).state,
        residentState: f.engine.inspectResidentChildTask(
          f.session.id,
          x.task.id,
        )?.state,
        root: nativeRows(f.dbPath, f.session.id),
        child: nativeRows(childDbPath, x.member.owner.sessionId),
        otherSession: nativeRows(f.dbPath, otherSession.id),
        providerEntries: entries,
        producerReturns: f.getProducerReturns(),
        parentBudget: { turns, toolCalls, outputBytes },
      };
    };
    const beforeWrongSession = observe();
    await assert.rejects(
      f.engine.stopResidentChildTask(otherSession.id, x.task.id),
      failure("CHILD_TASK_NOT_FOUND"),
    );
    const afterWrongSession = observe();
    const beforeRootEvents = beforeWrongSession.root.session_events,
      afterRootEvents = afterWrongSession.root.session_events;
    assert.ok(
      beforeRootEvents,
      "Root native events must exist before rejection",
    );
    assert.ok(afterRootEvents, "Root native events must exist after rejection");
    t.diagnostic(
      JSON.stringify({
        wrongSessionStop: {
          task: [beforeWrongSession.taskState, afterWrongSession.taskState],
          resident: [
            beforeWrongSession.residentState,
            afterWrongSession.residentState,
          ],
          providerEntries: [
            beforeWrongSession.providerEntries,
            afterWrongSession.providerEntries,
          ],
          nativeEvents: [beforeRootEvents.length, afterRootEvents.length],
        },
      }),
    );
    assert.equal(
      afterWrongSession.taskState,
      beforeWrongSession.taskState,
      "a rejected wrong-session stop must not cancel the actual resident task",
    );
    assert.deepEqual(
      afterWrongSession,
      beforeWrongSession,
      "a rejected stop must preserve actual native inputs, Runs, events, storage ownership, provider cleanup and reserved budget",
    );
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      f.send(
        x.member.memberId,
        x.member.generation,
        `advisory message ${i}`,
        `message-${i}`,
      );
      const page = f.read(x.member.memberId, x.member.generation);
      const delivered = f.engine.resumeChildTurn({
        workspaceId: f.workspace.id,
        requestId: `resident-delivery-${i}`,
        approved: true,
        page,
        expectedCursorRevision: page.cursor.revision,
      });
      assert.equal(delivered.record.state, "delivered");
      assert.equal(delivered.receipt?.input.delivery, "queue");
      ids.push(delivered.receipt!.input.runId);
      await until(
        () =>
          f.engine.inspectResidentChildTask(f.session.id, x.task.id)?.state ===
          "idle",
        "mailbox Run must settle",
      );
    }
    assert.equal(new Set([initial.id, ...ids]).size, 3);
    assert.equal(entries, 3);
    const snapshot = x.child.store.getSnapshot(x.member.owner.sessionId);
    assert.equal(snapshot.tools.length, 2);
    assert.ok(
      snapshot.tools.every((x) => x.state === "completed"),
      JSON.stringify(snapshot.tools),
    );
    assert.equal(
      ids
        .flatMap((id) =>
          x.child.store
            .listTurns(id)
            .flatMap((turn) => x.child.store.listParts(turn.id)),
        )
        .filter((x) => x.type === "tool").length,
      2,
    );
    const record = f.engine.inspectResidentChildTask(f.session.id, x.task.id)!;
    assert.equal(record.runs.length, 3);
    assert.ok(record.runs.every((x) => x.usage));
    assert.equal(
      f.read(x.member.memberId, x.member.generation).messages.length,
      0,
    );
    const stopped = await f.engine.stopResidentChildTask(
      f.session.id,
      x.task.id,
    );
    assert.equal(stopped.state, "cancelled");
    assert.equal(
      f.engine.inspectResidentChildTask(f.session.id, x.task.id)?.state,
      "closed",
    );
    assert.throws(
      () => f.engine.children.teamBridge.capture(f.session.id, x.task.id),
      failure("TEAM_CHILD_STALE"),
    );
  },
);

test(
  "resident model claim → actual read_file work → approved submit → independent coordinator model review commits native task and Tool/Part receipts",
  { timeout: 15000 },
  async (t) => {
    const release = gate();
    let taskRevision = 1,
      submissionId = "";
    const f = await nativeTeam(t, {
      engine: {
        residentTeams: true,
        teamModelTools: true,
        defaults: {
          limits: { maxTurns: 25, maxToolCalls: 25, maxOutputBytes: 160000 },
          budgets: { turnAllowance: 25 },
        },
      },
      resident: {
        idleTimeoutMs: 5000,
        allocation: {
          turns: 9,
          toolCalls: 8,
          outputBytes: 30000,
          durationMs: 10000,
        },
      },
      childTools: [
        "complete_team_task",
        "read_file",
        "read_agent_mailbox",
        "read_team_board",
        "claim_team_task",
        "submit_team_task",
        "review_team_task",
      ],
      async *streamChild(request): AsyncIterable<ProviderEvent> {
        const mails = request.messages.filter(
          (x) =>
            x.role === "user" && x.content.startsWith("[Moodcode team mailbox"),
        );
        if (!mails.length) {
          yield { type: "progress" };
          await release.promise;
          yield { type: "finish", reason: "stop" };
          return;
        }
        const work = mails.at(-1)!.content.includes("perform genuine work");
        const done = request.messages.filter((x) => x.role === "tool");
        let name: string, input: Record<string, string | number>;
        if (work && done.length === 0) {
          name = "claim_team_task";
          input = {
            requestId: "model-claim",
            taskId: "resident-task",
            expectedRevision: taskRevision,
          };
        } else if (work && done.length === 1) {
          name = "read_file";
          input = { path: "seed.txt" };
          taskRevision = 2;
        } else if (work && done.length === 2) {
          name = "submit_team_task";
          input = {
            requestId: "model-submit",
            taskId: "resident-task",
            expectedRevision: taskRevision,
            text: "Observed seed file using actual read_file. This advisory submission grants no effects.",
          };
        } else if (work && done.length === 3) {
          name = "complete_team_task";
          input = {
            requestId: "unauthorized-complete",
            taskId: "resident-task",
            expectedRevision: taskRevision,
          };
        } else if (!work && done.length === 0) {
          name = "read_team_board";
          input = {};
        } else if (!work && [1, 2, 3].includes(done.length)) {
          if (done.length === 2) {
            assert.equal(
              f.engine.getTeamTask(
                f.workspace.id,
                f.created.record.id,
                "resident-task",
              )?.state,
              "claimed",
              "failed SQL review must roll back native completed task",
            );
            assert.equal(
              f.engine.store.getSessionDocument(
                f.session.id,
                teamBoardKind(f.created.record.id, "resident-task"),
              )?.data.state,
              "submitted",
            );
            db.exec("DROP TRIGGER fail_review_board");
          }
          name = "review_team_task";
          input = {
            requestId: "model-review",
            taskId: "resident-task",
            expectedRevision: taskRevision,
            submissionId,
            verdict: "accept",
            text: "Accepted advisory observation after independent model review; not an execution grant.",
          };
        } else {
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield {
          type: "tool.call",
          call: { id: `${name}-${done.length}`, name, input },
        };
        yield { type: "finish", reason: "tool_calls" };
      },
    });
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    const worker = await f.child();
    const r = await f.startChild();
    const reviewer = f.join(
      "actual-reviewer",
      "coordinator",
      { send: true, receive: true, claimTasks: true, manageTasks: true },
      r.task.id,
    ).result.record;
    for (const x of [
      { task: worker.task, member: worker.member },
      { task: r.task, member: reviewer },
    ])
      f.engine.bindTeamModelTools({
        rootSessionId: f.session.id,
        teamId: f.created.record.id,
        memberId: x.member.memberId,
        generation: x.member.generation,
        childTaskId: x.task.id,
      });
    f.engine.putTeamTask({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: f.coordinator.memberId,
      generation: f.coordinator.generation,
      taskId: "resident-task",
      requestId: "put-resident-task",
      expectedRevision: 0,
      title: "Read source and submit advisory result",
      description: "No execution policy escalation",
      dependencies: [],
      expiresAt: f.expiresAt,
    });
    release.resolve();
    await until(
      () =>
        [worker, r].every(
          (x) =>
            f.engine.inspectResidentChildTask(f.session.id, x.task.id)
              ?.state === "idle",
        ),
      "both initial Runs must physically settle",
    );
    async function deliver(member: typeof reviewer, text: string, key: string) {
      f.send(member.memberId, member.generation, text, key);
      const page = f.read(member.memberId, member.generation);
      return f.engine.resumeChildTurn({
        workspaceId: f.workspace.id,
        approved: true,
        page,
        requestId: `deliver-${key}`,
        expectedCursorRevision: page.cursor.revision,
      });
    }
    async function approveIdle(taskId: string) {
      const end = Date.now() + 5000;
      while (
        f.engine.inspectResidentChildTask(f.session.id, taskId)?.state !==
        "idle"
      ) {
        assert.ok(Date.now() < end, "actual model execution must reach idle");
        for (const a of f.engine.children.approvals(f.session.id, taskId))
          f.engine.children.decide(
            f.session.id,
            taskId,
            a.id,
            a.fingerprint,
            "allow",
          );
        await new Promise((r) => setTimeout(r, 3));
      }
    }
    const worked = await deliver(worker.member, "perform genuine work", "work");
    await approveIdle(worker.task.id);
    const workTools = worker.child.store.getSnapshot(
      worker.member.owner.sessionId,
    ).tools;
    assert.equal(workTools.length, 4);
    assert.equal(workTools.at(-1)!.state, "failed");
    assert.match(workTools.at(-1)!.output!, /TEAM_REVIEW_REQUIRED/);
    assert.ok(
      workTools.slice(0, 3).every((x) => x.state === "completed"),
      JSON.stringify(workTools),
    );
    submissionId = JSON.parse(workTools[2]!.output!).result.submissionId;
    assert.ok(submissionId);
    assert.equal(
      f.engine.getTeamTask(f.workspace.id, f.created.record.id, "resident-task")
        ?.state,
      "claimed",
    );
    db.exec(
      "CREATE TRIGGER fail_review_board BEFORE UPDATE ON session_documents WHEN OLD.kind GLOB 'team.workflow.*' BEGIN SELECT RAISE(ABORT,'actual review receipt fault'); END",
    );
    const reviewed = await deliver(
      reviewer,
      "review the exact submitted DATA",
      "review",
    );
    await approveIdle(r.task.id);
    const reviewTools = r.child.store.getSnapshot(
      reviewer.owner.sessionId,
    ).tools;
    assert.equal(reviewTools.length, 4);
    assert.equal(reviewTools[1]!.state, "failed");
    assert.equal(
      JSON.parse(reviewTools.at(-1)!.output!).result.duplicate,
      true,
    );
    assert.ok(
      reviewTools
        .filter((_, i) => i !== 1)
        .every((x) => x.state === "completed"),
      JSON.stringify(reviewTools),
    );
    assert.equal(
      f.engine.getTeamTask(f.workspace.id, f.created.record.id, "resident-task")
        ?.state,
      "completed",
    );
    assert.notEqual(worked.receipt!.input.runId, worker.task.childRunId);
    assert.notEqual(reviewed.receipt!.input.runId, r.task.childRunId);
    for (const x of [worker, r])
      await f.engine.stopResidentChildTask(f.session.id, x.task.id);
    assert.equal(
      f.engine.store.getSessionDocument(
        f.session.id,
        teamBoardKind(f.created.record.id, "resident-task"),
      )?.revision,
      2,
      "duplicate review has no board transition",
    );
    f.parentRelease.resolve();
    await f.engine.waitForRun(f.parent.runId);
    await f.engine.close();
    validateTeamDatabase(db);
    validateResidentTeamDatabase(db);
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "workflow-archive"),
    });
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "workflow-import"),
    });
    const restored = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      teams: false,
      teamModelTools: false,
      residentTeams: false,
    });
    f.engines.add(restored);
    assert.equal(
      restored.getTeamTask(f.workspace.id, f.created.record.id, "resident-task")
        ?.state,
      "completed",
    );
    assert.equal(
      restored.store.getSessionDocument(
        f.session.id,
        teamBoardKind(f.created.record.id, "resident-task"),
      )?.data.state,
      "paused-import",
    );
    assert.throws(
      () => restored.children.describeTeamOwner(f.session.id, worker.task.id),
      failure("TEAM_OWNER_UNAVAILABLE"),
    );
    await restored.close();
  },
);
