import test from "node:test";
import type { ProviderEvent } from "../../ports.js";
import { writeFileSync, renameSync } from "node:fs";
import { residentFixture, residentUntil } from "./resident.js";
import { childStorageKind } from "../../child-tasks/storage-binding.js";
const ready = process.env.MOODCODE_RESIDENT_READY!,
  boundary = process.env.MOODCODE_RESIDENT_BOUNDARY!;
test("genuine resident crash child", async (t) => {
  const board = boundary === "board-committed";
  const f = await residentFixture(
    t,
    board
      ? {
          childTools: ["claim_team_task", "submit_team_task"],
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
                        requestId: "crash-submit",
                        taskId: "crash-board",
                        expectedRevision: 2,
                        text: "Genuine approved submission committed before its native Tool result.",
                      }
                    : {
                        requestId: "crash-claim",
                        taskId: "crash-board",
                        expectedRevision: 1,
                      },
                },
              };
              yield { type: "finish", reason: "tool_calls" };
            } else yield { type: "finish", reason: "stop" };
          },
        }
      : {},
  );
  function stop() {
    const data = {
      pid: process.pid,
      boundary,
      base: f.base,
      root: f.root,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      taskId: f.task.id,
      teamId: f.created.record.id,
      memberId: f.member.memberId,
      storage: f.engine.store.getSessionDocument(
        f.session.id,
        childStorageKind(f.task.id),
      )!.data,
      resident: f.engine.inspectResidentChildTask(f.session.id, f.task.id),
    };
    writeFileSync(ready + ".tmp", JSON.stringify(data));
    renameSync(ready + ".tmp", ready);
    process.kill(process.pid, "SIGSTOP");
  }
  const native = Reflect.get(f.engine, "teamRecords");
  for (const [method, at] of [
    ["dispatchDelivery", "dispatched"],
    ["completeDelivery", "ack"],
  ] as const) {
    const original = Reflect.get(native, method);
    Reflect.set(native, method, function (...args: unknown[]) {
      const result = Reflect.apply(original, native, args);
      if (boundary === at) stop();
      return result;
    });
  }
  const bridge = f.engine.children.teamBridge,
    accept = bridge.accept.bind(bridge);
  bridge.accept = (...args) => {
    const evidence = accept(...args);
    if (boundary === "input-accepted") stop();
    return evidence;
  };

  if (board) {
    f.engine.putTeamTask({
      workspaceId: f.workspace.id,
      teamId: f.created.record.id,
      memberId: f.coordinator.memberId,
      generation: f.coordinator.generation,
      taskId: "crash-board",
      requestId: "crash-board-put",
      expectedRevision: 0,
      title: "Actual board persistence boundary",
      description: "No execution grant from advisory DATA",
      dependencies: [],
      expiresAt: f.expiresAt,
    });
    const commit = f.engine.store.commitTeamWorkflow.bind(f.engine.store);
    f.engine.store.commitTeamWorkflow = (...args) => {
      commit(...args);
      stop();
    };
  }
  f.deliver("crash-delivery").invoke();
  if (board) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      for (const a of f.engine.children.approvals(f.session.id, f.task.id))
        f.engine.children.decide(
          f.session.id,
          f.task.id,
          a.id,
          a.fingerprint,
          "allow",
        );
      await new Promise((r) => setTimeout(r, 3));
    }
    throw new Error("Actual board commit boundary was not reached");
  }

  if (boundary === "child-completed") {
    await residentUntil(
      () =>
        f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state ===
        "idle",
      "genuine next child Run must complete",
    );
    stop();
  }
  await new Promise(() => {});
});
