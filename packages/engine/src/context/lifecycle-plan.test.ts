import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { DEFAULT_LIMITS } from "@moodcode/contracts";
import type { ContextRequest, ProviderMessage } from "../ports.js";
import { planContext, withSyntheticEntries } from "./plan.js";

async function fixture(t: TestContext): Promise<ContextRequest> {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-lifecycle-plan-")),
    ),
    createdAt = new Date().toISOString();
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    workspace: {
      id: "workspace",
      root,
      gitRoot: root,
      branch: null,
      createdAt,
    },
    snapshot: {
      session: {
        id: "session",
        workspaceId: "workspace",
        title: "Plan bounds",
        createdAt,
      },
      runs: [],
      tools: [],
      approvals: [],
      lastSeq: 0,
      messages: [
        {
          id: "current",
          sessionId: "session",
          runId: "current-run",
          role: "user",
          content: "Preserve this exact current request.",
          createdAt,
        },
      ],
    },
    config: {
      providerId: "scripted",
      modelId: "local",
      mode: "build",
      limits: { ...DEFAULT_LIMITS },
    },
    signal: new AbortController().signal,
    reservedBytes: 123,
  };
}
const data: ProviderMessage = {
  role: "assistant",
  content:
    '[Moodcode lifecycle context data v1]\n{"schemaVersion":1,"authority":"data-only","items":[]}',
};

test("whole lifecycle data is inserted before the transcript and charged once beside the envelope", async (t) => {
  const request = await fixture(t),
    base = await planContext(request),
    plan = withSyntheticEntries(base.messages, [data], 123);
  assert.deepEqual(base.selectedMessageIds, ["current"]);
  assert.equal(
    plan.messages.indexOf(data),
    base.messages.findIndex((message) => message.role !== "system"),
  );
  assert.equal(
    plan.messages.at(-1)!.content,
    request.snapshot.messages[0]!.content,
  );
  assert.equal(
    plan.bytes,
    base.bytes + Buffer.byteLength(JSON.stringify(data)) + 1,
  );
  assert.equal(
    plan.bytes,
    Buffer.byteLength(JSON.stringify(plan.messages)) + 123,
  );
  assert.equal(plan.inputEstimate.tokens, plan.bytes);
  assert.equal(
    plan.sha256,
    createHash("sha256").update(JSON.stringify(plan.messages)).digest("hex"),
  );
});

test("supplemental data equal to an omitted historical assistant cannot invent a selected transcript source", async (t) => {
  const request = await fixture(t),
    current = request.snapshot.messages[0]!;
  request.snapshot.messages.unshift(
    { ...current, id: "omitted-user", runId: "old", content: "Old request" },
    {
      ...current,
      id: "omitted-assistant",
      runId: "old",
      role: "assistant",
      content: data.content,
    },
  );
  for (const options of [
    { knowledgeMessages: [data] },
    { repositoryMessages: [data] },
  ]) {
    const plan = await planContext(request, { ...options, requiredOnly: true });
    assert.deepEqual(plan.selectedMessageIds, ["current"]);
    assert.equal(plan.omittedMessageCount, 2);
    assert.equal(
      plan.messages.filter((message) => message.content === data.content)
        .length,
      1,
    );
  }
});
