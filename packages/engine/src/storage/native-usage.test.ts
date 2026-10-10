import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  EngineError,
  type ProviderAttempt,
} from "@moodcode/contracts";
import { SqliteStore } from "./index.js";

const date = "2026-10-07T00:00:00.000Z";
const config = {
  providerId: "fixture",
  modelId: "fixture",
  mode: "build" as const,
  limits: { ...DEFAULT_LIMITS },
};
const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "moodcode-attempt-usage-")),
    path = join(directory, "engine.sqlite");
  let store = new SqliteStore(path);
  store.putWorkspace({
    id: "workspace",
    root: directory,
    gitRoot: directory,
    branch: null,
    createdAt: date,
  });
  store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Usage",
    createdAt: date,
  });
  const receipt = store.admit({
    sessionId: "session",
    requestId: "usage",
    prompt: "usage",
    config,
  });
  store.commit(receipt.runId, "run.started", {}, { run: { state: "running" } });
  store.putTurn({
    schemaVersion: 2,
    id: "turn",
    sessionId: "session",
    runId: receipt.runId,
    inputIds: [receipt.inputId],
    index: 0,
    state: "created",
    createdAt: date,
  });
  const first: ProviderAttempt = {
    schemaVersion: 2,
    id: "attempt-0",
    sessionId: "session",
    runId: receipt.runId,
    turnId: "turn",
    index: 0,
    providerId: "fixture",
    modelId: "fixture",
    state: "prepared",
    createdAt: date,
  };
  store.putAttempt(first);
  store.putAttempt({ ...first, state: "dispatched", dispatchedAt: date });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    path,
    first,
    runId: receipt.runId,
    reopen() {
      store.close();
      store = new SqliteStore(path);
    },
  };
}
test("durable attempt snapshots merge, deduplicate and preserve observed usage across failed retry and reopen", (t) => {
  const f = fixture(t),
    first = f.store.putAttemptUsage(f.first.id, {
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 0,
    });
  assert.equal(first.revision, 1);
  const second = f.store.putAttemptUsage(f.first.id, {
    outputTokens: 3,
    reasoningOutputTokens: 2,
  });
  assert.equal(second.revision, 2);
  const events = f.store.readSessionEvents("session", 0);
  assert.deepEqual(
    f.store.putAttemptUsage(f.first.id, { outputTokens: 3 }),
    second,
  );
  assert.deepEqual(f.store.readSessionEvents("session", 0), events);
  f.store.putAttempt({
    ...f.first,
    state: "failed",
    dispatchedAt: date,
    completedAt: date,
  });
  assert.deepEqual(
    f.store.putAttemptUsage(f.first.id, { inputTokens: 10 }),
    second,
  );
  assert.throws(
    () => f.store.putAttemptUsage(f.first.id, { outputTokens: 4 }),
    code("ATTEMPT_USAGE_IMMUTABLE"),
  );
  const retry = { ...f.first, id: "attempt-1", index: 1 };
  f.store.putAttempt(retry);
  f.store.putAttempt({ ...retry, state: "dispatched", dispatchedAt: date });
  f.store.putAttemptUsage(retry.id, {
    inputTokens: 7,
    outputTokens: 1,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
  });
  f.store.commit(f.runId, "run.usage", { inputTokens: 7, outputTokens: 1 });
  f.reopen();
  const metrics = f.store.getNativeMetrics("session");
  assert.equal(metrics.attemptUsage.samples, 2);
  assert.equal(metrics.attemptUsage.inputTokens.tokens, 17);
  assert.equal(metrics.attemptUsage.outputTokens.tokens, 4);
  assert.equal(metrics.attemptUsage.cachedInputTokens.tokens, 4);
  assert.equal(metrics.attemptUsage.reasoningOutputTokens.tokens, 2);
  assert.equal(metrics.providerUsage.inputTokens.tokens, 7);
  assert.equal(metrics.attemptUsage.billedTokens, null);
});
test("invalid usage regression, accessors and inclusive breakdown reject without changing journal or durable snapshots", (t) => {
  const f = fixture(t),
    first = f.store.putAttemptUsage(f.first.id, {
      inputTokens: 8,
      outputTokens: 3,
    });
  const events = f.store.readSessionEvents("session", 0);
  assert.throws(
    () => f.store.putAttemptUsage(f.first.id, { inputTokens: 7 }),
    code("ATTEMPT_USAGE_REGRESSION"),
  );
  for (const usage of [
    { inputTokens: -1 },
    { outputTokens: 1.5 },
    { cachedInputTokens: 9 },
    { reasoningOutputTokens: 4 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(
      () => f.store.putAttemptUsage(f.first.id, usage),
      code("INVALID_ATTEMPT_USAGE"),
    );
  let calls = 0;
  const accessor = Object.defineProperty({}, "inputTokens", {
    enumerable: true,
    get() {
      calls++;
      return 10;
    },
  });
  assert.throws(
    () => f.store.putAttemptUsage(f.first.id, accessor),
    code("INVALID_ATTEMPT_USAGE"),
  );
  assert.equal(calls, 0);
  assert.deepEqual(f.store.readSessionEvents("session", 0), events);
  assert.deepEqual(f.store.putAttemptUsage(f.first.id, {}), first);
});
test("attempt usage and its journal observation roll back together on publication failure", (t) => {
  const f = fixture(t),
    reader = new DatabaseSync(f.path);
  t.after(() => reader.close());
  reader.exec(
    "CREATE TRIGGER fail_usage BEFORE INSERT ON session_events WHEN NEW.type='provider.attempt.usage' BEGIN SELECT RAISE(ABORT,'usage publication failed'); END",
  );
  const events = f.store.readSessionEvents("session", 0);
  assert.throws(
    () => f.store.putAttemptUsage(f.first.id, { inputTokens: 0 }),
    /usage publication failed/,
  );
  assert.equal(
    reader.prepare("SELECT count(*) AS count FROM attempt_usage").get()?.count,
    0,
  );
  assert.deepEqual(f.store.readSessionEvents("session", 0), events);
});
test("stored attempt usage reads back only while open and only when it matches its owner and inclusive totals", (t) => {
  const f = fixture(t),
    stored = f.store.putAttemptUsage(f.first.id, {
      inputTokens: 8,
      cachedInputTokens: 2,
    }),
    writer = new DatabaseSync(f.path);
  t.after(() => writer.close());
  assert.deepEqual(f.store.getAttemptUsage(f.first.id), stored);
  assert.equal(f.store.getAttemptUsage("attempt-without-usage"), null);
  const tamper = (path: string, value: string) =>
    writer
      .prepare(
        `UPDATE attempt_usage SET data=json_set(data,'${path}',json(?)) WHERE attempt_id=?`,
      )
      .run(value, f.first.id);
  tamper("$.runId", '"another-run"');
  assert.throws(
    () => f.store.getAttemptUsage(f.first.id),
    code("RECORD_SCOPE_MISMATCH"),
  );
  tamper("$.runId", JSON.stringify(f.runId));
  tamper("$.usage.cachedInputTokens", "9");
  assert.throws(
    () => f.store.getAttemptUsage(f.first.id),
    code("INVALID_ATTEMPT_USAGE"),
  );
  tamper("$.usage.cachedInputTokens", "2");
  assert.deepEqual(f.store.getAttemptUsage(f.first.id), stored);
  f.store.close();
  assert.throws(
    () => f.store.getAttemptUsage(f.first.id),
    code("STORE_CLOSED"),
  );
});
