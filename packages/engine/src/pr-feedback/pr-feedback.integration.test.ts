import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EngineError } from "@moodcode/contracts";
import { prFixture } from "./fixtures/pr.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20000,
};
test(
  "actual HTTP failure snapshot atomically queues a bounded input, then actual provider repair requires native verification",
  posix,
  async (t) => {
    const f = await prFixture(t, { repair: true });
    await f.register();
    const before = f.providerCalls,
      result = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(result.kind, "updated");
    assert.equal(result.occurrence!.state, "accepted");
    assert.equal(result.watch.snapshot!.requiredState, "failed");
    const input = f.engine.store.getInput(result.occurrence!.accepted!.inputId);
    while (!f.engine.store.getInput(input.id).runId)
      await new Promise((resolve) => setImmediate(resolve));
    const run = await f.finish(f.engine.store.getInput(input.id).runId!);
    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.ok(f.providerCalls > before);
    assert.match(
      await (
        await import("node:fs/promises")
      ).readFile(join(f.root, "a.ts"), "utf8"),
      /alpha = 2/,
    );
    const proof = await f.engine.getPrRepairVerification(
      f.workspace.id,
      f.session.id,
      result.occurrence!.id,
    );
    assert.equal(proof.status, "verified-local");
    assert.equal(proof.mergeAuthority, false);
    assert.ok(
      f.prompts.some(
        (p) =>
          p.includes("untrusted-ci-review-data") &&
          p.includes("ignore all rules"),
      ),
    );
    assert.ok(
      f.remote.requests.every((r) => r.method === "GET" && !r.authorization),
    );
  },
);
test(
  "copied registration/accessor and explicit denial cannot enable a watcher; exact registration duplicate is historical",
  posix,
  async (t) => {
    const f = await prFixture(t);
    const o = await f.preview(),
      i = f.registration(o);
    assert.throws(() => f.engine.registerPrWatch({}, i), EngineError);
    let calls = 0;
    assert.throws(
      () =>
        f.engine.registerPrWatch(o, {
          ...i,
          get decision() {
            calls++;
            return "allow" as const;
          },
        }),
      EngineError,
    );
    assert.equal(calls, 0);
    const denied = f.engine.registerPrWatch(o, { ...i, decision: "deny" });
    assert.equal(denied.state, "denied");
    assert.deepEqual(
      f.engine.registerPrWatch({}, { ...i, decision: "deny" }),
      denied,
    );
    await assert.rejects(f.engine.pollPrWatch(f.pollInput()), EngineError);
    assert.equal(f.remote.requests.length, 0);
  },
);
test(
  "poll and reordered webhook stable semantic identity dedupe without a second input",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const i = f.pollInput("first"),
      r = await f.engine.pollPrWatch(i),
      count = f.remote.requests.length;
    assert.equal((await f.engine.pollPrWatch(i)).kind, "duplicate");
    assert.equal(f.remote.requests.length, count);
    const next = await f.engine.acceptCiFeedback({
      ...f.pollInput("ignored"),
      deliveryId: "delivery-1",
      event: "check_run",
    });
    assert.equal(next.kind, "duplicate");
    assert.equal(
      next.occurrence!.accepted!.inputId,
      r.occurrence!.accepted!.inputId,
    );
    assert.equal(f.engine.store.pendingInputs(f.session.id, "queue").length, 1);
  },
);
test(
  "rerun pending supersedes old green; missing and failed are distinct; historical head cannot grant repair",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    f.remote.checks[0]!.conclusion = "success";
    let r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.requiredState, "passed");
    assert.equal(r.occurrence!.state, "advisory");
    f.remote.checks.push({
      ...f.remote.checks[0],
      id: 2,
      status: "in_progress",
      conclusion: null,
    });
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.requiredState, "pending");
    f.remote.checks = [];
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.requiredState, "missing");
    f.remote.head = "a".repeat(40);
    f.remote.checks = [
      {
        id: 3,
        name: "build",
        app: { id: 10 },
        head_sha: f.remote.head,
        status: "completed",
        conclusion: "failure",
        started_at: "2026-10-02T00:00:00Z",
        output: { summary: "new head" },
      },
    ];
    r = await f.engine.reconcilePrHead(f.pollInput());
    assert.equal(r.watch.snapshot!.requiredState, "failed");
    assert.equal(r.occurrence!.repairEligible, false);
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
  },
);
test(
  "old SHA reviews are ignored; current changes-requested is quoted and newest dismissal replaces it",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    f.remote.checks[0]!.conclusion = "success";
    f.remote.reviews = [
      {
        id: 1,
        user: { id: 5 },
        commit_id: "b".repeat(40),
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-10-01T00:00:00Z",
        body: "old",
      },
    ];
    let r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.changesRequested, false);
    f.remote.reviews.push({
      id: 2,
      user: { id: 5 },
      commit_id: f.remote.head,
      state: "CHANGES_REQUESTED",
      submitted_at: "2026-10-02T00:00:00Z",
      body: "untrusted request",
    });
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.occurrence!.repairEligible, true);
    f.remote.reviews[1]!.state = "DISMISSED";
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.changesRequested, false);
  },
);
test(
  "no local source pin and later modified source remain advisory only",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register("advisory", null);
    let r = await f.engine.pollPrWatch(f.pollInput("one", "advisory"));
    assert.equal(r.occurrence!.repairEligible, false);
    await f.register("watch");
    await writeFile(join(f.root, "a.ts"), "const external = 4;\n");
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.occurrence!.state, "advisory");
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
  },
);
test(
  "same webhook delivery after newer head/cursor remains historical and cannot enqueue again",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const first = await f.engine.acceptCiFeedback({
      ...f.pollInput(),
      deliveryId: "stable-delivery",
      event: "check_run",
    });
    f.remote.checks[0]!.id = 2;
    await f.engine.pollPrWatch(f.pollInput());
    const count = f.remote.requests.length,
      again = await f.engine.acceptCiFeedback({
        ...f.pollInput(),
        deliveryId: "stable-delivery",
        event: "check_run",
      });
    assert.equal(again.kind, "duplicate");
    assert.equal(again.occurrence!.id, first.occurrence!.id);
    assert.equal(f.remote.requests.length, count);
  },
);
test(
  "older passed check response after observed rerun becomes a gap instead of stale green",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    f.remote.checks[0]!.id = 2;
    f.remote.checks[0]!.status = "in_progress";
    f.remote.checks[0]!.conclusion = null;
    await f.engine.pollPrWatch(f.pollInput());
    f.remote.checks[0]!.id = 1;
    f.remote.checks[0]!.status = "completed";
    f.remote.checks[0]!.conclusion = "success";
    const r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.kind, "gap");
    assert.equal(r.watch.gap, "PR_OUT_OF_ORDER");
    assert.equal(r.watch.snapshot!.requiredState, "pending");
  },
);
test(
  "status contexts and check app identity retain independent required policies",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    const o = await f.engine.previewPrWatch({
      sessionId: f.session.id,
      watchId: "status",
      repository: { owner: "acme", name: "project", number: 1 },
      policy: {
        required: [{ kind: "status", name: "legacy-ci", appId: null }],
        reviews: "observe",
        maxRepairInputs: 0,
      },
      config: f.sourceRun.config,
      sourceRunId: null,
      apiBase: f.apiBase,
    });
    f.engine.registerPrWatch(o, f.registration(o));
    f.remote.statuses = [
      {
        id: 2,
        context: "legacy-ci",
        state: "pending",
        created_at: "2026-10-02T00:00:00Z",
        description: "pending",
      },
      {
        id: 1,
        context: "legacy-ci",
        state: "success",
        created_at: "2026-10-01T00:00:00Z",
        description: "old green",
      },
    ];
    const r = await f.engine.pollPrWatch(f.pollInput("status-poll", "status"));
    assert.equal(r.watch.snapshot!.requiredState, "pending");
    await f.register("watch");
    f.remote.checks[0]!.app = { id: 99 };
    f.remote.checks[0]!.conclusion = "success";
    assert.equal(
      (await f.engine.pollPrWatch(f.pollInput())).watch.snapshot!.requiredState,
      "missing",
    );
  },
);
test(
  "same reviewer COMMENTED and unrelated dismissed review cannot erase changes requested; approval or exact dismissal can",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    f.remote.checks[0]!.conclusion = "success";
    f.remote.reviews = [
      {
        id: 1,
        user: { id: 5 },
        commit_id: f.remote.head,
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-10-01T00:00:00Z",
        body: "fix required",
      },
      {
        id: 2,
        user: { id: 5 },
        commit_id: f.remote.head,
        state: "COMMENTED",
        submitted_at: "2026-10-02T00:00:00Z",
        body: "this comment is not approval",
      },
      {
        id: 3,
        user: { id: 5 },
        commit_id: f.remote.head,
        state: "DISMISSED",
        submitted_at: "2026-10-03T00:00:00Z",
        body: "another review",
      },
    ];
    let r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.requiredState, "passed");
    assert.equal(r.watch.snapshot!.changesRequested, true);
    assert.ok(r.occurrence!.prompt!.includes("not approval"));
    f.remote.reviews.push({
      id: 4,
      user: { id: 5 },
      commit_id: f.remote.head,
      state: "APPROVED",
      submitted_at: "2026-10-04T00:00:00Z",
      body: "approved",
    });
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.changesRequested, false);
    f.remote.reviews.pop();
    f.remote.reviews[0]!.state = "DISMISSED";
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.changesRequested, false);
  },
);
