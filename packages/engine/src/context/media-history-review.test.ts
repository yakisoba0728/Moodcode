import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_ENGINE_BUDGETS,
  DEFAULT_LIMITS,
  EngineError,
  type InputImageAttachment,
  type Message,
  type RunConfig,
} from "@moodcode/contracts";
import type {
  ContextRequest,
  ProviderAdapter,
  ProviderEvent,
  ProviderMessage,
} from "../ports.js";
import { BudgetAccount } from "../config/budgets.js";
import { imageFixture, png } from "../media/fixtures.js";
import { SqliteStore } from "../storage/index.js";
import {
  MEDIA_HISTORY_NOTICE_PREFIX,
  type MediaHistoryPolicy,
} from "./media-history.js";
import { ContextService } from "./service.js";

const stamp = "2026-10-07T00:00:00.000Z";
const policy: MediaHistoryPolicy = {
  kind: "reference-only-older-images",
  version: 1,
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const code = (value: string) => (error: unknown) =>
  error instanceof EngineError && error.code === value;
const refs = ["a", "b", "c"].map(
  (digit) => imageFixture(png(), "image/png", digit).attachment,
);
function fixture(
  t: TestContext,
  olderText = "Earlier exact text observation.",
) {
  const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-media-context-review-")),
    ),
    dbPath = join(directory, "engine.sqlite");
  let store = new SqliteStore(dbPath);
  store.putWorkspace({
    id: "workspace",
    root: directory,
    gitRoot: directory,
    branch: null,
    createdAt: stamp,
  });
  store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Image context",
    createdAt: stamp,
  });
  const config: RunConfig = {
    providerId: "fixture",
    modelId: "fixture-model",
    mode: "plan",
    limits: { ...DEFAULT_LIMITS, maxContextBytes: 32_768 },
    budgets: { ...DEFAULT_ENGINE_BUDGETS },
  };
  const old = store.admit({
    sessionId: "session",
    requestId: "old",
    prompt: "INITIAL_IMAGE_GOAL: exact old constraint 한글😀",
    config,
    attachments: [refs[0]!],
  });
  store.commit(old.runId, "run.started", {}, { run: { state: "running" } });
  store.commit(
    old.runId,
    "message.completed",
    {},
    {
      message: {
        id: "older-assistant",
        sessionId: "session",
        runId: old.runId,
        role: "assistant",
        content: olderText,
        createdAt: stamp,
        providerReplay: {
          providerId: "fixture",
          modelId: "fixture-model",
          protocol: "responses",
          version: 1,
          items: [
            {
              type: "reasoning",
              encrypted_content: "old opaque replay",
              summary: [],
            },
          ],
        },
      },
    },
  );
  store.commit(old.runId, "run.completed", {}, { run: { state: "completed" } });
  const current = store.admit({
    sessionId: "session",
    requestId: "current",
    prompt: "CURRENT_IMAGE_GOAL: preserve this initial active goal",
    config,
    attachments: [refs[1]!],
  });
  store.commit(current.runId, "run.started", {}, { run: { state: "running" } });
  const steer = store.acceptInput({
    sessionId: "session",
    requestId: "latest-steer",
    prompt: "LATEST_IMAGE_STEER: keep these pixels and exact latest text",
    config,
    delivery: "steer",
    attachments: [refs[2]!],
  });
  store.promoteSteers([steer.inputId], current.runId);
  const assistant: Message = {
    id: "current-assistant",
    sessionId: "session",
    runId: current.runId,
    role: "assistant",
    content: "LATEST_EXCHANGE: observed two file requests",
    createdAt: stamp,
    toolCalls: [
      { id: "latest-a", name: "read_file", input: { path: "a.txt" } },
      { id: "latest-b", name: "read_file", input: { path: "b.txt" } },
    ],
    providerReplay: {
      providerId: "fixture",
      modelId: "fixture-model",
      protocol: "responses",
      version: 1,
      items: [
        {
          type: "reasoning",
          encrypted_content: "latest opaque reasoning",
          summary: [],
        },
        {
          type: "function_call",
          call_id: "latest-a",
          name: "read_file",
          arguments: '{ "path" : "a.txt" }',
        },
        {
          type: "function_call",
          call_id: "latest-b",
          name: "read_file",
          arguments: '{ "path" : "b.txt" }',
        },
      ],
    },
  };
  store.commit(current.runId, "message.completed", {}, { message: assistant });
  for (const id of ["b", "a"])
    store.commit(
      current.runId,
      "message.completed",
      {},
      {
        message: {
          id: "tool-" + id,
          sessionId: "session",
          runId: current.runId,
          role: "tool",
          content: "Recorded exact result " + id,
          toolCallId: "latest-" + id,
          createdAt: stamp,
        },
      },
    );
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (
    service: ContextService,
    nextConfig = config,
  ): ContextRequest => ({
    workspace: store.getWorkspace("workspace"),
    snapshot: service.snapshot("session", nextConfig),
    config: nextConfig,
    signal: new AbortController().signal,
    run: store.getRun(current.runId),
    budget: new BudgetAccount(nextConfig),
    reservedBytes: 79,
  });
  return {
    config,
    current,
    assistant,
    get store() {
      return store;
    },
    request,
    reopen() {
      store.close();
      store = new SqliteStore(dbPath);
    },
  };
}
function notice(messages: ProviderMessage[]) {
  const message = messages.find((message) =>
    message.content.startsWith(MEDIA_HISTORY_NOTICE_PREFIX),
  );
  assert.ok(message);
  assert.equal(message.role, "assistant");
  assert.equal(message.attachments, undefined);
  assert.equal(message.providerReplay, undefined);
  assert.equal(message.toolCalls, undefined);
  return {
    message,
    data: JSON.parse(
      message.content.slice(MEDIA_HISTORY_NOTICE_PREFIX.length),
    ) as Record<string, unknown>,
  };
}
function pixelRefs(messages: ProviderMessage[]): InputImageAttachment[] {
  return messages.flatMap((message) => message.attachments ?? []);
}
function assertLatestExchange(messages: ProviderMessage[], expected: Message) {
  const index = messages.findIndex(
    (message) => message.content === expected.content,
  );
  assert.ok(index >= 0);
  const assistant = messages[index]!;
  assert.deepEqual(assistant.toolCalls, expected.toolCalls);
  assert.deepEqual(assistant.providerReplay, expected.providerReplay);
  const results = messages.slice(index + 1, index + 3);
  assert.ok(results.every((message) => message.role === "tool"));
  assert.deepEqual(
    new Set(results.map((message) => message.toolCallId)),
    new Set(["latest-a", "latest-b"]),
  );
}

test("real ContextService persists owner-bound image provenance and exact provider projection while raw transcript/replay stay unchanged after restart", async (t) => {
  const f = fixture(t),
    service = new ContextService(f.store, undefined, 0, undefined, {
      mediaHistoryPolicy: policy,
    }),
    request = f.request(service),
    original = f.store.getSnapshot("session");
  const messages = await service.build(request),
    n = notice(messages),
    diagnostics = service.diagnostics("session");
  assert.ok(diagnostics?.mediaHistory);
  assert.deepEqual(pixelRefs(messages), [refs[2]]);
  assert.equal(n.data.summarized, false);
  assert.equal(n.data.permissionOrInstruction, false);
  assert.equal(n.data.currentFileEvidence, false);
  for (const text of [
    "INITIAL_IMAGE_GOAL:",
    "CURRENT_IMAGE_GOAL:",
    "LATEST_IMAGE_STEER:",
  ])
    assert.ok(
      messages.some(
        (message) =>
          message.role === "user" && message.content.startsWith(text),
      ),
    );
  assertLatestExchange(messages, f.assistant);
  assert.equal(diagnostics.mediaHistory.sourceImageOccurrences, 3);
  assert.equal(diagnostics.mediaHistory.retainedImageOccurrences, 1);
  assert.equal(diagnostics.mediaHistory.omittedImageOccurrences, 2);
  assert.equal(diagnostics.mediaHistory.summarized, false);
  assert.equal(diagnostics.mediaHistory.activeCutoffCreated, false);
  assert.equal(diagnostics.mediaHistory.imageTokens, null);
  assert.ok(
    Buffer.byteLength(JSON.stringify(messages)) + request.reservedBytes! <=
      request.config.limits.maxContextBytes,
  );
  const revision = f.store.getContextRevision(diagnostics.revisionId);
  assert.equal(revision.sessionId, "session");
  assert.equal(revision.runId, f.current.runId);
  assert.equal(revision.text, JSON.stringify(messages));
  assert.equal(revision.sha256, digest(revision.text));
  assert.equal(diagnostics.plan.sha256, revision.sha256);
  assert.ok(
    revision.sourceIds.includes(
      "image-policy:" + diagnostics.mediaHistory.policySha256,
    ),
  );
  assert.ok(
    revision.sourceIds.includes(
      "image-source:" + diagnostics.mediaHistory.sourceSha256,
    ),
  );
  for (const source of diagnostics.mediaHistory.provenance) {
    const raw = original.messages.find(
      (message) => message.id === source.messageId,
    );
    assert.ok(raw);
    assert.equal(source.sessionId, raw.sessionId);
    assert.equal(source.runId, raw.runId);
    assert.equal(source.sourceContentSha256, digest(raw.content));
    assert.deepEqual(source.attachments, raw.attachments);
    assert.ok(
      revision.sourceIds.includes(
        `image-message:${source.messageId}:${digest(JSON.stringify(source))}`,
      ),
    );
  }
  assert.deepEqual(f.store.getSnapshot("session").messages, original.messages);
  messages.find(
    (message) => message.content === f.assistant.content,
  )!.providerReplay!.items[0]!.encrypted_content = "caller mutation";
  assert.deepEqual(f.store.getSnapshot("session").messages, original.messages);
  f.reopen();
  const restarted = new ContextService(f.store, undefined, 0, undefined, {
    mediaHistoryPolicy: policy,
  });
  assert.equal(restarted.revisionId("session"), revision.id);
  assert.deepEqual(
    restarted.diagnostics("session")!.mediaHistory,
    diagnostics.mediaHistory,
  );
  const rebuilt = await restarted.build(f.request(restarted));
  assert.equal(restarted.revisionId("session"), revision.id);
  assert.equal(JSON.stringify(rebuilt), revision.text);
  assert.deepEqual(f.store.getSnapshot("session").messages, original.messages);
  assert.equal(f.store.getSessionDocument("session", "context.memory"), null);
});

test("required latest pixels, exact text, whole tool exchange and provenance notice fit an exact serialized cap or fail without activating partial context", async (t) => {
  const f = fixture(t),
    service = new ContextService(f.store, undefined, 0, undefined, {
      mediaHistoryPolicy: policy,
    }),
    base = f.request(service),
    full = await service.build(base);
  const minimal = full.filter(
    (message) =>
      message.role === "user" ||
      message.content.startsWith(MEDIA_HISTORY_NOTICE_PREFIX) ||
      message.content === f.assistant.content ||
      message.role === "tool",
  );
  const exact =
      Buffer.byteLength(JSON.stringify(minimal)) + base.reservedBytes!,
    config = {
      ...f.config,
      limits: { ...f.config.limits, maxContextBytes: exact },
    };
  const atBoundary = await service.build({ ...base, config });
  assert.deepEqual(atBoundary, minimal);
  assertLatestExchange(atBoundary, f.assistant);
  assert.deepEqual(pixelRefs(atBoundary), [refs[2]]);
  notice(atBoundary);
  const head = f.store.getSessionDocument("session", "context.head"),
    latest = f.store.getLatestContextRevision("session"),
    raw = f.store.getSnapshot("session").messages;
  await assert.rejects(
    service.build({
      ...base,
      config: {
        ...config,
        limits: { ...config.limits, maxContextBytes: exact - 1 },
      },
    }),
    code("IMAGE_HISTORY_METADATA_LIMIT"),
  );
  assert.deepEqual(f.store.getSessionDocument("session", "context.head"), head);
  assert.deepEqual(f.store.getLatestContextRevision("session"), latest);
  assert.deepEqual(f.store.getSnapshot("session").messages, raw);
  const noNotice = minimal.filter(
    (message) => !message.content.startsWith(MEDIA_HISTORY_NOTICE_PREFIX),
  );
  await assert.rejects(
    service.build({
      ...base,
      config: {
        ...config,
        limits: {
          ...config.limits,
          maxContextBytes:
            Buffer.byteLength(JSON.stringify(noNotice)) +
            base.reservedBytes! -
            1,
        },
      },
    }),
    code("IMAGE_CONTEXT_LIMIT"),
  );
});

test("automatic text summary examines original image history even when its provider projection has reference-only older images", async (t) => {
  const f = fixture(
    t,
    "Historical text omitted from the provider request. ".repeat(160),
  );
  let providerCalls = 0;
  const provider: ProviderAdapter = {
    id: "fixture",
    async *streamTurn(): AsyncGenerator<ProviderEvent> {
      providerCalls++;
      yield {
        type: "text.delta",
        delta: "Unsafe replacement claim about old pixels.",
      };
      yield { type: "finish", reason: "stop" };
    },
  };
  const service = new ContextService(f.store, undefined, 0, () => provider, {
      mediaHistoryPolicy: policy,
    }),
    config = {
      ...f.config,
      limits: { ...f.config.limits, maxContextBytes: 8192 },
    },
    request = f.request(service, config),
    raw = f.store.getSnapshot("session").messages;
  const messages = await service.build(request),
    diagnostics = service.diagnostics("session");
  assert.ok(diagnostics?.mediaHistory);
  assert.equal(providerCalls, 0);
  assert.equal(request.budget!.snapshot().summaryCalls, 0);
  assert.equal(f.store.getSessionDocument("session", "context.memory"), null);
  assert.ok(diagnostics.plan.omittedMessageCount > 0);
  assert.ok(
    diagnostics.plan.warnings.some((warning) =>
      warning.includes("SUMMARY_IMAGE_SOURCE_UNSUPPORTED"),
    ),
  );
  notice(messages);
  assert.deepEqual(pixelRefs(messages), [refs[2]]);
  assertLatestExchange(messages, f.assistant);
  assert.equal(
    f.store
      .readEvents("session", 0, 128)
      .filter(
        (event) =>
          event.type === "summary.prepared" ||
          event.type === "summary.dispatched" ||
          event.type === "summary.completed",
      ).length,
    0,
  );
  assert.deepEqual(f.store.getSnapshot("session").messages, raw);
});

test("default ContextService retains the original image history behavior and creates no opt-in provenance policy", async (t) => {
  const f = fixture(t),
    service = new ContextService(f.store),
    before = f.store.getSnapshot("session").messages,
    messages = await service.build(f.request(service));
  assert.deepEqual(pixelRefs(messages), refs);
  assert.equal(
    messages.some((message) =>
      message.content.startsWith(MEDIA_HISTORY_NOTICE_PREFIX),
    ),
    false,
  );
  assert.equal(service.diagnostics("session")!.mediaHistory, undefined);
  assertLatestExchange(messages, f.assistant);
  assert.deepEqual(f.store.getSnapshot("session").messages, before);
  assert.equal(
    f.store
      .getContextRevision(service.revisionId("session")!)
      .sourceIds.some(
        (id) =>
          id.startsWith("image-policy:") || id.startsWith("image-source:"),
      ),
    false,
  );
});

test("foreign source owners and media-shaped opaque replay fail before context activation or historical rewriting", async (t) => {
  const f = fixture(t),
    service = new ContextService(f.store, undefined, 0, undefined, {
      mediaHistoryPolicy: policy,
    }),
    request = f.request(service),
    raw = f.store.getSnapshot("session").messages;
  const foreign = { ...request, snapshot: structuredClone(request.snapshot) };
  foreign.snapshot.messages[0]!.sessionId = "other-session";
  await assert.rejects(
    service.build(foreign),
    code("IMAGE_HISTORY_INVALID_SOURCE"),
  );
  const replay = { ...request, snapshot: structuredClone(request.snapshot) };
  replay.snapshot.messages
    .find((message) => message.id === "older-assistant")!
    .providerReplay!.items.push({
      type: "input_image",
      image_url: "https://unread.invalid/image.png",
    });
  await assert.rejects(
    service.build(replay),
    code("IMAGE_HISTORY_REPLAY_MEDIA_UNSUPPORTED"),
  );
  assert.equal(f.store.getSessionDocument("session", "context.head"), null);
  assert.equal(f.store.getLatestContextRevision("session"), null);
  assert.deepEqual(f.store.getSnapshot("session").messages, raw);
});
