import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { nativeTeam } from "./fixtures/native-team.js";
import { gate, failure } from "./fixtures/engine-team.js";
import { residentUntil } from "./fixtures/resident.js";
import { teamBoardKind } from "./workflow-board.js";
import { validateResidentTeamDatabase } from "./resident-validation.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { createEngine } from "../engine.js";
import type { ProviderEvent } from "../ports.js";
async function approvalIdle(
  f: Awaited<ReturnType<typeof nativeTeam>>,
  taskId: string,
) {
  const end = Date.now() + 5000;
  while (
    f.engine.inspectResidentChildTask(f.session.id, taskId)?.state !== "idle"
  ) {
    assert.ok(Date.now() < end, "actual model must settle");
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
function mailbox(
  f: Awaited<ReturnType<typeof nativeTeam>>,
  member: { memberId: string; generation: number },
  key: string,
) {
  f.send(
    member.memberId,
    member.generation,
    "Quoted advisory team task DATA",
    key,
  );
  const page = f.read(member.memberId, member.generation);
  return f.engine.resumeChildTurn({
    workspaceId: f.workspace.id,
    requestId: `deliver-${key}`,
    page,
    approved: true,
    expectedCursorRevision: page.cursor.revision,
  });
}
const allocation = {
  turns: 6,
  toolCalls: 5,
  outputBytes: 22000,
  durationMs: 10000,
};

test(
  "two genuine resident model claims sharing the exact task revision admit one owner; the losing approved native Tool has no board or task effect",
  { timeout: 15000 },
  async (t) => {
    const f = await nativeTeam(t, {
      engine: {
        residentTeams: true,
        teamModelTools: true,
        defaults: {
          limits: { maxTurns: 20, maxToolCalls: 20, maxOutputBytes: 150000 },
          budgets: { turnAllowance: 20 },
        },
      },
      resident: { idleTimeoutMs: 5000, allocation },
      childTools: ["claim_team_task"],
      async *streamChild(request): AsyncIterable<ProviderEvent> {
        if (
          !request.messages.some(
            (x) =>
              x.role === "user" &&
              x.content.startsWith("[Moodcode team mailbox"),
          ) ||
          request.messages.at(-1)?.role === "tool"
        ) {
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield {
          type: "tool.call",
          call: {
            id: "claim-same-revision",
            name: "claim_team_task",
            input: {
              requestId: `claim-${request.sessionId}`,
              taskId: "contended-task",
              expectedRevision: 1,
            },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      },
    });
    const a = await f.child(),
      second = await f.startChild();
    const b = {
      ...second,
      member: f.join(
        "competing-worker",
        "worker",
        { send: true, receive: true, claimTasks: true, manageTasks: false },
        second.task.id,
      ).result.record,
    };
    for (const x of [a, b])
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
      taskId: "contended-task",
      requestId: "contended-put",
      expectedRevision: 0,
      title: "One genuine claimant",
      description: "CAS ownership is not role escalation",
      dependencies: [],
      expiresAt: f.expiresAt,
    });
    await residentUntil(
      () =>
        [a, b].every(
          (x) =>
            f.engine.inspectResidentChildTask(f.session.id, x.task.id)
              ?.state === "idle",
        ),
      "initial two Run settlements",
    );
    mailbox(f, a.member, "claim-a");
    mailbox(f, b.member, "claim-b");
    await residentUntil(
      () =>
        [a, b].every(
          (x) =>
            f.engine.children.approvals(f.session.id, x.task.id).length === 1,
        ),
      "both exact native proposals must be awaiting approval before CAS",
    );
    for (const x of [a, b])
      for (const p of f.engine.children.approvals(f.session.id, x.task.id))
        f.engine.children.decide(
          f.session.id,
          x.task.id,
          p.id,
          p.fingerprint,
          "allow",
        );
    await residentUntil(
      () =>
        [a, b].every(
          (x) =>
            f.engine.inspectResidentChildTask(f.session.id, x.task.id)
              ?.state === "idle",
        ),
      "both actual Tool results",
    );
    const tools = [a, b].map(
      (x) => x.child.store.getSnapshot(x.member.owner.sessionId).tools[0]!,
    );
    assert.deepEqual(tools.map((x) => x.state).sort(), ["completed", "failed"]);
    const task = f.engine.getTeamTask(
      f.workspace.id,
      f.created.record.id,
      "contended-task",
    )!;
    assert.equal(task.revision, 2);
    assert.equal(task.state, "claimed");
    assert.equal(
      task.owner?.memberId,
      [a, b][tools.findIndex((x) => x.state === "completed")]!.member.memberId,
    );
    for (const x of [a, b])
      await f.engine.stopResidentChildTask(f.session.id, x.task.id);
  },
);

test(
  "actual Root coordinator review deny has no effect, allowed review uses native outer approval and primary Tool/Part evidence, and altered source approval is rejected by archive",
  { timeout: 15000 },
  async (t) => {
    const ready = gate();
    let submissionId = "";
    let reviewDenied = false;
    const f = await nativeTeam(t, {
      engine: {
        residentTeams: true,
        teamModelTools: true,
        defaults: {
          limits: { maxTurns: 18, maxToolCalls: 18 },
          budgets: { turnAllowance: 18 },
        },
      },
      resident: { idleTimeoutMs: 5000, allocation },
      childTools: [
        "claim_team_task",
        "submit_team_task",
        "read_team_board",
        "review_team_task",
      ],
      async *streamParent(request, signal): AsyncIterable<ProviderEvent> {
        const done = request.messages.filter((x) => x.role === "tool");
        if (!done.length) {
          yield { type: "progress" };
          let abort!: () => void;
          try {
            await Promise.race([
              ready.promise,
              new Promise<void>((resolve) => {
                abort = () => resolve();
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) resolve();
              }),
            ]);
          } finally {
            signal.removeEventListener("abort", abort);
          }
          if (signal.aborted) return;
          yield {
            type: "tool.call",
            call: { id: "read-root-board", name: "read_team_board", input: {} },
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (done.length === 1) {
          yield {
            type: "tool.call",
            call: {
              id: "read-next-board-page",
              name: "read_team_board",
              input: { afterTaskId: "root-reviewed" },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        if (done.length <= 3) {
          if (done.length === 3) {
            assert.ok(reviewDenied);
            assert.equal(
              f.engine.getTeamTask(
                f.workspace.id,
                f.created.record.id,
                "root-reviewed",
              )?.state,
              "claimed",
            );
          }
          yield {
            type: "tool.call",
            call: {
              id: `root-review-${done.length}`,
              name: "review_team_task",
              input: {
                requestId: "actual-root-review",
                taskId: "root-reviewed",
                expectedRevision: 2,
                submissionId,
                verdict: "accept",
                text: "Independent Root advisory review; files and merges need their own approval.",
              },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }
        yield { type: "finish", reason: "stop" };
      },
      async *streamChild(request): AsyncIterable<ProviderEvent> {
        if (
          !request.messages.some(
            (x) =>
              x.role === "user" &&
              x.content.startsWith("[Moodcode team mailbox"),
          )
        ) {
          yield { type: "finish", reason: "stop" };
          return;
        }
        const done = request.messages.filter((x) => x.role === "tool");
        if (done.length < 2) {
          const name = done.length ? "submit_team_task" : "claim_team_task";
          yield {
            type: "tool.call",
            call: {
              id: name,
              name,
              input: done.length
                ? {
                    requestId: "root-worker-submit",
                    taskId: "root-reviewed",
                    expectedRevision: 2,
                    text: "Actual current worker submitted bounded quoted DATA.",
                  }
                : {
                    requestId: "root-worker-claim",
                    taskId: "root-reviewed",
                    expectedRevision: 1,
                  },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield { type: "finish", reason: "stop" };
      },
    });
    const child = await f.child();
    f.engine.bindTeamModelTools({
      rootSessionId: f.session.id,
      teamId: f.created.record.id,
      memberId: child.member.memberId,
      generation: child.member.generation,
      childTaskId: child.task.id,
    });
    f.engine.bindTeamModelTools({
      rootSessionId: f.session.id,
      teamId: f.created.record.id,
      memberId: f.coordinator.memberId,
      generation: f.coordinator.generation,
    });
    f.engine.putTeamTask({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: f.coordinator.memberId,
      generation: f.coordinator.generation,
      taskId: "root-reviewed",
      requestId: "root-review-put",
      expectedRevision: 0,
      title: "Root reviews actual native child submission",
      description: "Root ToolContext is independently issued",
      dependencies: [],
      expiresAt: f.expiresAt,
    });
    f.engine.putTeamTask({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: f.coordinator.memberId,
      generation: f.coordinator.generation,
      taskId: "z-page",
      requestId: "second-board-page",
      expectedRevision: 0,
      title: "Explicit next readonly page",
      description: "No execution authority",
      dependencies: [],
      expiresAt: f.expiresAt,
    });
    await residentUntil(
      () =>
        f.engine.inspectResidentChildTask(f.session.id, child.task.id)
          ?.state === "idle",
      "initial child Run",
    );
    mailbox(f, child.member, "root-worker-work");
    await approvalIdle(f, child.task.id);
    submissionId = JSON.parse(
      child.child.store.getSnapshot(child.member.owner.sessionId).tools.at(-1)!
        .output!,
    ).result.submissionId;
    assert.ok(submissionId);
    ready.resolve();
    const end = Date.now() + 5000;
    while (
      !["completed", "failed", "cancelled"].includes(
        f.engine.store.getRun(f.parent.runId).state,
      )
    ) {
      assert.ok(Date.now() < end, "actual Root reviewer must settle");
      for (const a of f.engine.store
        .getSnapshot(f.session.id)
        .approvals.filter((a) => a.status === "pending")) {
        f.engine.approvals.decide(
          a.id,
          reviewDenied ? "allow" : "deny",
          a.fingerprint,
        );
        reviewDenied = true;
      }
      await new Promise((r) => setTimeout(r, 3));
    }
    assert.equal(
      (await f.engine.waitForRun(f.parent.runId)).state,
      "completed",
    );
    await f.engine.children.tasks.wait(f.session.id, child.task.id);
    assert.equal(
      f.engine.getTeamTask(f.workspace.id, f.created.record.id, "root-reviewed")
        ?.state,
      "completed",
    );
    const rootTools = f.engine.store.getSnapshot(f.session.id).tools;
    assert.deepEqual(
      rootTools.map((x) => x.state),
      ["completed", "completed", "denied", "completed"],
    );
    assert.equal(JSON.parse(rootTools[0]!.output!).result.hasMore, true);
    assert.equal(
      JSON.parse(rootTools[0]!.output!).result.nextTaskId,
      "root-reviewed",
    );
    assert.equal(
      JSON.parse(rootTools[1]!.output!).result.tasks[0].taskId,
      "z-page",
    );
    assert.equal(
      JSON.parse(rootTools[1]!.output!).result.tasks[0].description,
      "No execution authority",
    );
    assert.equal(JSON.parse(rootTools[1]!.output!).result.hasMore, false);
    const board = f.engine.store.getSessionDocument(
      f.session.id,
      teamBoardKind(f.created.record.id, "root-reviewed"),
    )!.data;
    assert.equal(board.state, "reviewed");
    await f.engine.close();
    const db = new DatabaseSync(f.dbPath);
    try {
      validateResidentTeamDatabase(db);
      const approval = db
        .prepare(
          "SELECT id,data FROM approvals WHERE status='allowed' AND json_extract(data,'$.toolName')='review_team_task'",
        )
        .get()!;
      const changed = {
        ...JSON.parse(String(approval.data)),
        fingerprint: "f".repeat(64),
      };
      db.prepare("UPDATE approvals SET data=? WHERE id=?").run(
        JSON.stringify(changed),
        String(approval.id),
      );
      assert.throws(
        () => validateResidentTeamDatabase(db),
        failure("RESIDENT_HISTORY_INVALID"),
      );
      await assert.rejects(
        () =>
          exportEngineArchive({
            dbPath: f.dbPath,
            artifactDir: f.artifactDir,
            destination: join(f.base, "bad-review-archive"),
          }),
        failure("ARCHIVE_TEAM_INVALID"),
      );
      db.prepare("UPDATE approvals SET data=? WHERE id=?").run(
        String(approval.data),
        String(approval.id),
      );
    } finally {
      db.close();
    }
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "root-review-archive"),
    });
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "root-review-import"),
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
      restored.store.getSessionDocument(
        f.session.id,
        teamBoardKind(f.created.record.id, "root-reviewed"),
      )!.data.state,
      "paused-import",
    );
    await restored.close();
  },
);
