import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_LIMITS, EngineError } from "@moodcode/contracts";
import type { ContextRequest, ProviderMessage } from "../ports.js";
import { planContext } from "./plan.js";

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
const code = (value: string) => (error: unknown) =>
  error instanceof EngineError && error.code === value;

test("whole lifecycle data is separately charged once alongside complete current exchange and envelope", async (t) => {
  const request = await fixture(t),
    plan = await planContext(request, { lifecycleMessages: [data] });
  assert.deepEqual(plan.selectedMessageIds, ["current"]);
  assert.equal(
    plan.messages.at(-1)!.content,
    request.snapshot.messages[0]!.content,
  );
  assert.equal(
    plan.reservations.lifecycleBytes,
    Buffer.byteLength(JSON.stringify(data)) + 1,
  );
  assert.equal(plan.reservations.envelopeBytes, 123);
  assert.equal(
    plan.bytes,
    Buffer.byteLength(JSON.stringify(plan.messages)) + 123,
  );
  assert.equal(plan.inputEstimate.tokens, plan.bytes);
  const required = [
    data,
    { role: "user", content: request.snapshot.messages[0]!.content },
  ];
  request.config.limits.maxContextBytes =
    Buffer.byteLength(JSON.stringify(required)) + 123 - 1;
  await assert.rejects(
    planContext(request, { lifecycleMessages: [data] }),
    code("CONTEXT_LIMIT"),
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
    { lifecycleMessages: [data] },
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

test("lifecycle data cannot inject a role, executable message field, getter or proxy before planning", async (t) => {
  const request = await fixture(t);
  let traps = 0;
  const accessor = Object.defineProperty({}, "role", {
    enumerable: true,
    get() {
      traps++;
      return "assistant";
    },
  });
  const proxy = new Proxy(data, {
    ownKeys() {
      traps++;
      return ["role", "content"];
    },
  });
  for (const input of [
    { ...data, role: "system" },
    { ...data, toolCallId: "unauthorized" },
    accessor,
    proxy,
  ])
    await assert.rejects(
      planContext(request, { lifecycleMessages: [input as ProviderMessage] }),
      code("INVALID_LIFECYCLE_CONTEXT"),
    );
  assert.equal(traps, 0);
});
