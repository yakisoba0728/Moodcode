import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_LIMITS, type RunConfig } from "@moodcode/contracts";
import { ContextService } from "../context/service.js";
import { LifecycleHookRegistry } from "../lifecycle/index.js";
import { SqliteStore } from "../storage/index.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("accepted model-context data attaches to the exact captured base without promoting omitted history during final recount", async (t) => {
  const root = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-lifecycle-base-review-")),
    ),
    store = new SqliteStore(":memory:");
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const stamp = new Date().toISOString();
  const workspace = store.putWorkspace({
    id: "review-workspace",
    root,
    gitRoot: root,
    branch: null,
    createdAt: stamp,
  });
  store.createSession({
    id: "review-session",
    workspaceId: workspace.id,
    title: "Original context owner",
    createdAt: stamp,
  });
  const config: RunConfig = {
    providerId: "review",
    modelId: "model",
    mode: "build",
    limits: { ...DEFAULT_LIMITS, maxContextBytes: 4096 },
  };
  const previous = store.admit({
    sessionId: "review-session",
    requestId: "history",
    prompt: "Historical source context: " + "h".repeat(2200),
    config,
  });
  store.commit(
    previous.runId,
    "run.started",
    {},
    { run: { state: "running" } },
  );
  store.commit(
    previous.runId,
    "run.completed",
    {},
    { run: { state: "completed" } },
  );
  const receipt = store.admit({
    sessionId: "review-session",
    requestId: "current",
    prompt: "Complete the current task.",
    config,
  });
  store.commit(receipt.runId, "run.started", {}, { run: { state: "running" } });
  const run = store.getRun(receipt.runId),
    registry = new LifecycleHookRegistry();
  let baseSha256: string | undefined,
    callbacks = 0;
  registry.register({
    id: "small-data",
    revision: 1,
    stages: ["model-context"],
    callback(invocation) {
      assert.equal(invocation.stage, "model-context");
      if (invocation.stage !== "model-context") return;
      callbacks++;
      baseSha256 = invocation.metadata.contextSha256;
      return {
        kind: "context-data",
        expectedContextSha256: baseSha256,
        data: { note: "One bounded data fact." },
      };
    },
  });
  const capture = registry.capture({
    workspaceId: workspace.id,
    sessionId: run.sessionId,
    runId: run.id,
  });
  const service = new ContextService(store, undefined, 0, undefined, {
    lifecycleHooks: registry,
    lifecycleContextSlotBytes: 2048,
  });
  const messages = await service.build({
    workspace,
    snapshot: service.snapshot(run.sessionId, config),
    config,
    run,
    lifecycleCapture: capture,
    turnIndex: 0,
    signal: new AbortController().signal,
  });
  const baseMessages = messages.filter(
    (message) =>
      !message.content.startsWith("[Moodcode lifecycle context data v1]\n"),
  );
  assert.equal(callbacks, 1);
  assert.equal(
    baseMessages.some(
      (message) => message.content === store.getRun(previous.runId).prompt,
    ),
    false,
  );
  assert.equal(
    service
      .diagnostics(run.sessionId)!
      .plan.selectedMessageIds.includes(previous.inputId),
    false,
  );
  assert.equal(
    hash(baseMessages),
    baseSha256,
    "The accepted data must retain the exact base digest observed by the callback",
  );
  assert.equal(
    service.diagnostics(run.sessionId)!.lifecycleContext!.baseContextSha256,
    baseSha256,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(messages)) <=
      config.limits.maxContextBytes,
  );
  service.releaseContext(run.sessionId, run.id);
  registry.release(capture);
});
