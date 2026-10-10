import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { EngineError } from "@moodcode/contracts";
import { PrFeedbackHost } from "./host.js";
import type { PrWatchRecord } from "./types.js";

const input = {
  workspaceId: "workspace",
  sessionId: "session",
  watchId: "watch",
  intervalMs: 1000,
};
const hasCode = (code: string) => (error: unknown) =>
  error instanceof EngineError && error.code === code;

/** Exercise the actual loop owner with inert storage and poll ports; no native queue or HTTP proof. */
function fixture(t: TestContext) {
  let watch: Pick<PrWatchRecord, "state" | "revision" | "nextPollAt"> | null = null;
  let enabled = true;
  let polls = 0;
  let failure: EngineError | null = null;
  const lifetime = new AbortController();
  const host = new PrFeedbackHost(
    {} as ConstructorParameters<typeof PrFeedbackHost>[0],
    {
      get(workspaceId: string, sessionId: string, watchId: string) {
        assert.deepEqual([workspaceId, sessionId, watchId], ["workspace", "session", "watch"]);
        return watch;
      },
    } as unknown as ConstructorParameters<typeof PrFeedbackHost>[1],
    () => assert.fail("Loop ownership does not acquire a physical binding"),
    {} as ConstructorParameters<typeof PrFeedbackHost>[3],
    () => enabled,
    false,
    lifetime.signal,
  );
  Object.defineProperty(host, "queue", {
    configurable: true,
    value: async () => {
      polls++;
      if (failure) throw failure;
    },
  });
  t.after(() => host.close());
  return {
    host,
    lifetime,
    register(state: PrWatchRecord["state"] = "active", nextPollAt: string | null = null) { watch = { state, revision: 1, nextPollAt }; },
    failPolls(code: string | null) { failure = code ? new EngineError(code, "Loop poll failed") : null; },
    disableFeature() { enabled = false; },
    enableFeature() { enabled = true; },
    polls: () => polls,
  };
}

test("missing watch start rejects synchronously and later registration can start and restart", async t => {
  const f = fixture(t);
  assert.throws(() => f.host.start(input), hasCode("PR_WATCH_STALE"));
  assert.equal(f.polls(), 0);
  f.register();
  assert.deepEqual(f.host.start(input), { watchId: "watch" });
  await tick();
  assert.equal(f.polls(), 1);
  assert.throws(() => f.host.start(input), hasCode("PR_WATCH_RUNNING"));
  f.host.stop("workspace", "session", "watch");
  await tick();
  assert.deepEqual(f.host.start(input), { watchId: "watch" });
  await tick();
  assert.equal(f.polls(), 2);
});

for (const state of ["denied", "disabled", "paused-import"] as const) {
  test(`inactive ${state} watch start rejects without retaining a loop owner`, async t => {
    const f = fixture(t);
    f.register(state);
    assert.throws(() => f.host.start(input), hasCode("PR_WATCH_STALE"));
    assert.equal(f.polls(), 0);
    f.register();
    assert.deepEqual(f.host.start(input), { watchId: "watch" });
    await tick();
    assert.equal(f.polls(), 1);
  });
}

test("disabled feature rejects start before creating an owner and preserves later opt-in", async t => {
  const f = fixture(t);
  f.register();
  f.disableFeature();
  assert.throws(() => f.host.start(input), hasCode("PR_FEEDBACK_UNSUPPORTED"));
  assert.equal(f.polls(), 0);
  f.enableFeature();
  assert.deepEqual(f.host.start(input), { watchId: "watch" });
  await tick();
  assert.equal(f.polls(), 1);
});

test("an admitted loop that becomes inactive before execution releases its installed owner", async t => {
  const f = fixture(t);
  f.register();
  f.host.start(input);
  f.register("disabled");
  await tick();
  assert.equal(f.polls(), 0);
  f.register();
  assert.deepEqual(f.host.start(input), { watchId: "watch" });
  await tick();
  assert.equal(f.polls(), 1);
});

test("close aborts and drains the original loop poll before returning", async t => {
  const f = fixture(t);
  f.register();
  let entered!: () => void;
  let aborted!: () => void;
  let cleanup!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const abort = new Promise<void>(resolve => { aborted = resolve; });
  const cleaned = new Promise<void>(resolve => { cleanup = resolve; });
  let polls = 0;
  Object.defineProperty(f.host, "queue", {
    configurable: true,
    value: async (_input: unknown, signal: AbortSignal) => {
      polls++;
      signal.addEventListener("abort", aborted, { once: true });
      entered();
      await cleaned;
    },
  });
  f.host.start(input);
  await entry;
  let closed = false;
  const closing = f.host.close().then(() => { closed = true; });
  await abort;
  await tick();
  assert.equal(closed, false);
  cleanup();
  await closing;
  assert.equal(closed, true);
  assert.equal(polls, 1);
  assert.throws(() => f.host.start(input), hasCode("ENGINE_CLOSED"));
});

test("a stale revision keeps the loop running for the next tick", async t => {
  const f = fixture(t);
  f.register();
  f.failPolls("PR_WATCH_STALE");
  f.host.start(input);
  await tick();
  assert.equal(f.polls(), 1);
  assert.throws(() => f.host.start(input), hasCode("PR_WATCH_RUNNING"));
});

test("a loop that stops on an error reports it to the next start, and stop clears it", async t => {
  const f = fixture(t);
  f.register();
  f.failPolls("PR_STORAGE_LIMIT");
  f.host.start(input);
  await tick();
  assert.equal(f.polls(), 1);
  assert.throws(() => f.host.start(input), hasCode("PR_STORAGE_LIMIT"));
  assert.deepEqual(f.host.start(input), { watchId: "watch" });
  await tick();
  assert.equal(f.polls(), 2);
  f.host.stop("workspace", "session", "watch");
  f.failPolls(null);
  assert.deepEqual(f.host.start(input), { watchId: "watch" });
  await tick();
  assert.equal(f.polls(), 3);
});

test("a loop in rate-limit back-off sleeps until the deadline instead of polling", async t => {
  const f = fixture(t);
  f.register("active", new Date(Date.now() + 60000).toISOString());
  f.host.start(input);
  await tick();
  assert.equal(f.polls(), 0);
  assert.throws(() => f.host.start(input), hasCode("PR_WATCH_RUNNING"));
});
