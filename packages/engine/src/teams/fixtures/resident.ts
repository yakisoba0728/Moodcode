import type { TestContext } from "node:test";
import type { ProviderEvent } from "../../ports.js";
import { nativeTeam } from "./native-team.js";
import { gate, type TeamFixtureOptions } from "./engine-team.js";
import assert from "node:assert/strict";
export async function residentUntil(
  check: () => boolean,
  detail: string,
  ms = 5000,
) {
  const end = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < end, detail);
    await new Promise((r) => setTimeout(r, 3));
  }
}
export async function residentFixture(
  t: TestContext,
  options: TeamFixtureOptions = {},
) {
  const release = gate();
  const f = await nativeTeam(t, {
    ...options,
    engine: { ...options.engine, residentTeams: true, teamModelTools: true },
    resident: options.resident ?? {
      idleTimeoutMs: 5000,
      allocation: {
        turns: 6,
        toolCalls: 5,
        outputBytes: 16000,
        durationMs: 10000,
      },
    },
    childTools: options.childTools ?? ["read_file", "read_agent_mailbox"],
    streamChild:
      options.streamChild ??
      async function* (request, signal): AsyncIterable<ProviderEvent> {
        const mailbox = request.messages.some(
          (x) =>
            x.role === "user" && x.content.startsWith("[Moodcode team mailbox"),
        );
        if (!mailbox) {
          yield { type: "progress" };
          await release.promise;
          if (!signal.aborted) yield { type: "finish", reason: "stop" };
          return;
        }
        if (request.messages.at(-1)?.role !== "tool") {
          yield {
            type: "tool.call",
            call: {
              id: "actual-mailbox-read",
              name: "read_agent_mailbox",
              input: {},
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "finish", reason: "stop" };
        }
      },
  });
  const x = await f.child();
  const binding = f.engine.bindTeamModelTools({
    rootSessionId: f.session.id,
    teamId: f.created.record.id,
    memberId: x.member.memberId,
    generation: x.member.generation,
    childTaskId: x.task.id,
  });
  release.resolve();
  await residentUntil(
    () =>
      f.engine.inspectResidentChildTask(f.session.id, x.task.id)?.state ===
      "idle",
    "genuine resident initial Run must settle",
  );
  function deliver(
    requestId: string,
    text = "Explicit untrusted mailbox DATA",
  ) {
    f.send(
      x.member.memberId,
      x.member.generation,
      text,
      `message-${requestId}`,
    );
    const page = f.read(x.member.memberId, x.member.generation);
    return {
      page,
      invoke: () =>
        f.engine.resumeChildTurn({
          workspaceId: f.workspace.id,
          requestId,
          approved: true,
          page,
          expectedCursorRevision: page.cursor.revision,
        }),
    };
  }
  return { ...f, ...x, binding, deliver };
}
