import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  DEFAULT_LIMITS,
  type CommandEnvelope,
  type CommandResult,
  type SessionSnapshot,
  type Workspace,
} from "@moodcode/contracts";
import type {
  DesktopApi,
  DesktopBootstrap,
  DesktopUpdate,
  HostStatus,
} from "../shared/protocol.js";
import { createDesktopStore } from "./store.js";

// Synthetic transport fixtures: tests never instantiate Electron or contact a provider.
const workspace: Workspace = {
  id: "w",
  root: "/fixture/repository",
  gitRoot: "/fixture/repository",
  branch: "main",
  createdAt: "2026-10-04T00:00:00Z",
};
const sessions = ["s1", "s2"].map((id) => ({
  id,
  workspaceId: "w",
  title: id,
  createdAt: workspace.createdAt,
}));
const settings: DesktopBootstrap["settings"] = {
  providerId: "scripted",
  modelId: "local",
  baseURL: "",
  keyConfigured: false,
  keySource: "none",
  credentialStorage: "unavailable",
};
function snapshot(id: string, lastSeq = 5): SessionSnapshot {
  return {
    session: sessions.find((s) => s.id === id)!,
    runs: ["r1", "r2"].map((runId) => ({
      id: runId,
      inputId: runId,
      sessionId: id,
      workspaceId: "w",
      requestId: runId,
      prompt: "fixture",
      state: "completed",
      config: {
        providerId: "scripted",
        modelId: "local",
        mode: "plan",
        limits: { ...DEFAULT_LIMITS },
      },
      createdAt: workspace.createdAt,
      updatedAt: workspace.createdAt,
    })),
    messages: [],
    tools: [],
    approvals: [],
    lastSeq,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const calls: CommandEnvelope[] = [],
    subscriptions: { id: string; sessionId: string; afterSeq: number }[] = [],
    removed: string[] = [];
  let update: ((value: DesktopUpdate) => void) | undefined,
    host: ((value: HostStatus) => void) | undefined;
  let handler: (command: CommandEnvelope) => Promise<unknown> = async (
    command,
  ) => {
    if (command.type === "session.list") return sessions;
    if (command.type === "session.getSnapshot")
      return snapshot(command.payload.sessionId as string);
    if (command.type === "review.getDiff")
      return {
        runId: command.payload.runId,
        files: [],
        checkpoints: [],
        warnings: [],
      };
    if (command.type === "run.submit")
      return { runId: "r2", inputId: "r2", admittedSeq: 6, duplicate: false };
    throw new Error("Unexpected fixture command");
  };
  let bootstrap: DesktopBootstrap = {
    host: { state: "ready", generation: 1 },
    version: "0.1.0",
    platform: "fixture",
    settings,
    workspaces: [workspace],
  };
  const api: DesktopApi = {
    getBootstrap: async () => bootstrap,
    command: async (command) => {
      calls.push(structuredClone(command));
      const result = await handler(command);
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        ok: true,
        result: JSON.parse(JSON.stringify(result)),
      } as CommandResult;
    },
    subscribe: async (sessionId, afterSeq) => {
      const id = `sub${subscriptions.length + 1}`;
      subscriptions.push({ id, sessionId, afterSeq });
      return id;
    },
    unsubscribe: async (id) => {
      removed.push(id);
    },
    onUpdate: (listener) => {
      update = listener;
      return () => {
        update = undefined;
      };
    },
    onHostState: (listener) => {
      host = listener;
      return () => {
        host = undefined;
      };
    },
    chooseWorkspace: async () => null,
    saveSettings: async () => settings,
    retryEngine: async () => bootstrap.host,
    openExternal: async () => {},
  };
  return {
    api,
    calls,
    subscriptions,
    removed,
    setHandler: (value: typeof handler) => {
      handler = value;
    },
    defaultHandler: (command: CommandEnvelope) => {
      if (command.type === "session.list") return sessions;
      if (command.type === "session.getSnapshot")
        return snapshot(command.payload.sessionId as string);
      if (command.type === "review.getDiff")
        return {
          runId: command.payload.runId,
          files: [],
          checkpoints: [],
          warnings: [],
        };
      return { runId: "r2", inputId: "r2", admittedSeq: 6, duplicate: false };
    },
    setBootstrap: (value: DesktopBootstrap) => {
      bootstrap = value;
    },
    update: (value: DesktopUpdate) => update?.(value),
    host: (value: HostStatus) => host?.(value),
  };
}

test("reinitialize preserves current session, committed cursor and detaches without cancelling a run", async () => {
  const f = fixture(),
    store = createDesktopStore(f.api, { workspaceId: "w", sessionId: "s1" });
  await store.initialize();
  await store.selectSession("s2");
  await store.initialize();
  assert.equal(store.getSnapshot().sessionId, "s2");
  assert.ok(f.subscriptions.every((s) => s.afterSeq === 5));
  await store.stop();
  assert.equal(f.removed.length, f.subscriptions.length);
  assert.ok(!f.calls.some((c) => c.type === "run.cancel"));
});

test("late snapshot and late subscription cannot replace a newly selected session", async () => {
  const f = fixture(),
    late = deferred<SessionSnapshot>(),
    lateSub = deferred<string>();
  f.setHandler(async (command) =>
    command.type === "session.getSnapshot" && command.payload.sessionId === "s1"
      ? late.promise
      : f.defaultHandler(command),
  );
  const store = createDesktopStore(f.api);
  const first = store.selectSession("s1");
  await setImmediate();
  await store.selectSession("s2");
  late.resolve(snapshot("s1", 99));
  await first;
  assert.equal(store.getSnapshot().sessionId, "s2");
  assert.equal(store.getSnapshot().snapshot?.session.id, "s2");
  f.setHandler(async (command) => f.defaultHandler(command));
  const original = f.api.subscribe;
  f.api.subscribe = async (id, seq) =>
    id === "s1" ? lateSub.promise : original(id, seq);
  const subscribing = store.selectSession("s1");
  await setImmediate();
  await store.selectSession("s2");
  lateSub.resolve("orphan-subscription");
  await subscribing;
  assert.ok(f.removed.includes("orphan-subscription"));
  assert.equal(store.getSnapshot().snapshot?.session.id, "s2");
  await store.stop();
});

test("late diff cannot overwrite a different Run chosen during refresh", async () => {
  const f = fixture(),
    store = createDesktopStore(f.api);
  await store.initialize();
  const old = deferred<unknown>();
  let blocked = false;
  f.setHandler(async (command) => {
    if (
      command.type === "review.getDiff" &&
      command.payload.runId === "r2" &&
      !blocked
    ) {
      blocked = true;
      return old.promise;
    }
    return f.defaultHandler(command);
  });
  const refresh = store.refresh();
  await setImmediate();
  await store.chooseReview("r1");
  old.resolve({ runId: "r2", files: [], checkpoints: [], warnings: [] });
  await refresh;
  await setImmediate();
  assert.equal(store.getSnapshot().reviewRunId, "r1");
  assert.equal(store.getSnapshot().review?.runId, "r1");
  await store.stop();
});

test("host failure invalidates pending reads and bootstrap carries initial error details", async () => {
  const f = fixture();
  f.setBootstrap({
    host: {
      state: "failed",
      generation: 1,
      error: { code: "CODEX_AUTH_EXPIRED", message: "Sign in again" },
    },
    workspaces: [],
    settings,
    platform: "fixture",
    version: "0.1.0",
  });
  const store = createDesktopStore(f.api);
  await store.initialize();
  assert.match(store.getSnapshot().error!, /CODEX_AUTH_EXPIRED/);
  f.setBootstrap({
    host: { state: "ready", generation: 1 },
    workspaces: [workspace],
    settings,
    platform: "fixture",
    version: "0.1.0",
  });
  await store.initialize();
  const pending = deferred<SessionSnapshot>();
  f.setHandler(async (command) =>
    command.type === "session.getSnapshot"
      ? pending.promise
      : f.defaultHandler(command),
  );
  const read = store.refresh();
  await setImmediate();
  f.host({
    state: "failed",
    generation: 1,
    error: { code: "ENGINE_EXITED", message: "Fixture exited" },
  });
  pending.resolve(snapshot("s2", 99));
  await read;
  assert.equal(store.getSnapshot().host.state, "failed");
  assert.equal(store.getSnapshot().snapshot?.lastSeq, 5);
  assert.match(store.getSnapshot().error!, /ENGINE_EXITED/);
  await store.stop();
});

test("failed restore retains metadata-recording uncertainty and quarantine warning", async () => {
  const f = fixture();
  f.api.command = async (command) => ({
    schemaVersion: 1,
    commandId: command.commandId,
    ok: false,
    error: {
      code: "RESTORE_FAILED",
      message: "Fixture restore failed",
      details: {
        recordMetadataError: {
          code: "REVIEW_RECORD_FAILED",
          message: "Reconcile quarantined workspace",
        },
      },
    },
  });
  const store = createDesktopStore(f.api);
  await assert.rejects(
    store.command("review.restore", {
      runId: "r1",
      checkpointId: "c",
      previewFingerprint: "0".repeat(64),
    }),
    /추가 작업이 차단/,
  );
  await store.stop();
});

test("a failed admission can retry the exact requestId without inventing another request", async () => {
  const f = fixture(),
    store = createDesktopStore(f.api);
  await store.initialize();
  const original = f.api.command;
  let failed = false;
  f.api.command = async (command) => {
    if (command.type === "run.submit" && !failed) {
      failed = true;
      f.calls.push(structuredClone(command));
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        ok: false,
        error: { code: "WORKSPACE_BUSY", message: "Fixture busy" },
      };
    }
    return original(command);
  };
  assert.equal(
    await store.submit("fixture", { mode: "plan" }, "stable-request"),
    false,
  );
  assert.equal(
    await store.submit("fixture", { mode: "plan" }, "stable-request"),
    true,
  );
  assert.deepEqual(
    f.calls
      .filter((c) => c.type === "run.submit")
      .map((c) => c.payload.requestId),
    ["stable-request", "stable-request"],
  );
  await store.stop();
});
