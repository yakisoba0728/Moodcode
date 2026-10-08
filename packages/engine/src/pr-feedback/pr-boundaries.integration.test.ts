import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { prFixture } from "./fixtures/pr.js";
import {
  prWatchKind,
  prOccurrenceKind,
  validatePrFeedbackDatabase,
} from "./records.js";
import { prSign } from "./types.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 25000,
};
test(
  "outage and rate limit persist explicit gaps/backoff and never reuse old green for repair",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    f.remote.checks[0]!.conclusion = "success";
    let r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.snapshot!.requiredState, "passed");
    f.remote.statusCode = 503;
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.kind, "gap");
    assert.equal(r.watch.gap, "PR_API_OUTAGE");
    assert.equal(r.occurrence, null);
    f.remote.statusCode = 429;
    f.remote.headers = { "retry-after": "60" };
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.watch.gap, "PR_RATE_LIMIT");
    const count = f.remote.requests.length;
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(f.remote.requests.length, count);
    assert.equal(r.kind, "gap");
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
  },
);
test(
  "remote head change during pagination and wrong check SHA fail closed with a gap",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    let pulls = 0;
    f.remote.onRequest = (req) => {
      if (req.url?.endsWith("/pulls/1") && ++pulls === 2)
        f.remote.head = "c".repeat(40);
      return false;
    };
    let r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.kind, "gap");
    assert.equal(r.watch.snapshot, null);
    f.remote.onRequest = null;
    f.remote.head = f.sourceRun
      ? (f.remote.checks[0]!.head_sha as string)
      : f.remote.head;
    f.remote.checks[0]!.head_sha = "d".repeat(40);
    r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.kind, "gap");
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
  },
);
test(
  "actual Input accepted event/link failure rolls back queue, snapshot, cursor and afterCommit wake together",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const db = Reflect.get(f.engine.store, "db") as DatabaseSync,
      calls = f.providerCalls;
    db.exec(
      "CREATE TRIGGER reject_pr_admission BEFORE INSERT ON session_events WHEN NEW.type='pr.feedback.admitted' BEGIN SELECT RAISE(ABORT,'actual admission fault'); END",
    );
    await assert.rejects(f.engine.pollPrWatch(f.pollInput()));
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
    assert.equal(
      f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.cursor,
      0,
    );
    assert.equal(f.providerCalls, calls);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_documents WHERE kind GLOB 'pr.feedback.*'",
          )
          .get()!.n,
      ),
      0,
    );
    db.exec("DROP TRIGGER reject_pr_admission");
    assert.equal(
      (await f.engine.pollPrWatch(f.pollInput())).occurrence!.state,
      "accepted",
    );
  },
);
test(
  "source changes stop queued repair before any provider dispatch",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const r = await f.engine.pollPrWatch(f.pollInput()),
      calls = f.providerCalls;
    await writeFile(join(f.root, "a.ts"), "const external = 3;\n");
    f.engine.store.setSessionPaused(f.session.id, false);
    await assert.rejects(f.engine.scheduler.wake(f.session.id));
    assert.equal(f.providerCalls, calls);
    assert.equal(
      f.engine.store.getInput(r.occurrence!.accepted!.inputId).runId,
      undefined,
    );
  },
);
test(
  "repair input ceiling is enforced across real reruns independently of check text",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register("watch", f.sourceRun.id, 1);
    const a = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(a.occurrence!.repairEligible, true);
    f.remote.checks[0]!.id = 2;
    f.remote.checks[0]!.started_at = "2026-10-03T00:00:00Z";
    const b = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(b.occurrence!.repairEligible, false);
    assert.equal(b.watch.repairInputs, 1);
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 1);
  },
);
test(
  "cancel and Root close abort real delayed HTTP without publication or provider entry",
  posix,
  async (t) => {
    const f = await prFixture(t);
    await f.register();
    const calls = f.providerCalls,
      controller = new AbortController();
    f.remote.delay = true;
    const p = f.engine.pollPrWatch(f.pollInput(), controller.signal);
    while (!f.remote.requests.length)
      await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(p, EngineError);
    assert.equal(
      f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.cursor,
      0,
    );
    const q = f.engine.pollPrWatch(f.pollInput());
    await new Promise((resolve) => setImmediate(resolve));
    await f.engine.close();
    await assert.rejects(q, EngineError);
    assert.equal(f.providerCalls, calls);
  },
);
test(
  "explicit watcher loop stops without replay or waking providers after reopen/default off",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const calls = f.providerCalls;
    f.engine.startPrWatch({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      watchId: "watch",
      intervalMs: 1000,
    });
    while (!f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.cursor)
      await new Promise((resolve) => setImmediate(resolve));
    await f.engine.close();
    const requestCount = f.remote.requests.length;
    await f.reopen(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.remote.requests.length, requestCount);
    assert.equal(f.providerCalls, calls);
    assert.equal(
      f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.cursor,
      1,
    );
    assert.throws(() => f.engine.pollPrWatch(f.pollInput()), EngineError);
  },
);
test(
  "genuine archive imports paused watcher and input history; no replay or fresh repair authority",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const r = await f.engine.pollPrWatch(f.pollInput());
    await f.engine.close();
    const archived = await exportEngineArchive({
        dbPath: f.dbPath,
        artifactDir: f.artifactDir,
        destination: join(f.base, "archive"),
      }),
      imported = await importEngineArchive({
        directory: archived.directory,
        destination: join(f.base, "imported"),
      }),
      engine = createEngine({
        ...f.config,
        dbPath: imported.dbPath,
        artifactDir: imported.artifactDir,
      });
    t.after(() => engine.close());
    assert.equal(
      engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.state,
      "paused-import",
    );
    assert.equal(
      engine.getPrFeedbackOccurrence(
        f.workspace.id,
        f.session.id,
        r.occurrence!.id,
      )!.state,
      "paused-import",
    );
    const requests = f.remote.requests.length;
    await assert.rejects(
      engine.pollPrWatch({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        watchId: "watch",
        requestId: "import-poll",
        expectedRevision: engine.getPrWatch(
          f.workspace.id,
          f.session.id,
          "watch",
        )!.revision,
      }),
      EngineError,
    );
    assert.equal(f.remote.requests.length, requests);
  },
);
test(
  "fully rehashed watch green transition cannot contradict original HTTP snapshot anchor",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const r = await f.engine.pollPrWatch(f.pollInput()),
      db = Reflect.get(f.engine.store, "db") as DatabaseSync;
    db.exec("SAVEPOINT forge");
    try {
      const snapshot = prSign({
        ...r.watch.snapshot!,
        checks: r.watch.snapshot!.checks.map((c) => ({
          ...c,
          state: "passed" as const,
          conclusion: "success",
        })),
        requiredState: "passed" as const,
      });
      const { sha256, semanticSha256, observedAt, ...semantic } = snapshot;
      const final = prSign({
          ...snapshot,
          semanticSha256: knowledgeHash(semantic),
        }),
        changed = prSign({ ...r.watch, snapshot: final });
      const raw = JSON.stringify(changed);
      db.prepare(
        "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
      ).run(raw, f.session.id, prWatchKind("watch"));
      const updated = db
        .prepare(
          "SELECT seq,data FROM session_events WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=?",
        )
        .get(f.session.id, prWatchKind("watch"), r.watch.revision)!;
      const u = JSON.parse(String(updated.data));
      u.payload.sha256 = (await import("node:crypto"))
        .createHash("sha256")
        .update(raw)
        .digest("hex");
      db.prepare(
        "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
      ).run(JSON.stringify(u), f.session.id, updated.seq!);
      const transition = db
        .prepare(
          "SELECT seq,data FROM session_events WHERE session_id=? AND type='pr.watch.transition' AND json_extract(data,'$.payload.record.revision')=?",
        )
        .get(f.session.id, r.watch.revision)!;
      const e = JSON.parse(String(transition.data));
      e.payload.record = changed;
      db.prepare(
        "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
      ).run(JSON.stringify(e), f.session.id, transition.seq!);
      assert.throws(
        () => validatePrFeedbackDatabase(db),
        (err: unknown) =>
          err instanceof EngineError && err.code === "PR_REMOTE_ANCHOR_INVALID",
      );
    } finally {
      db.exec("ROLLBACK TO forge");
      db.exec("RELEASE forge");
    }
    validatePrFeedbackDatabase(db);
  },
);
for (const change of ["profile", "policy", "head"])
  test(
    "actual changed " +
      change +
      " blocks previously queued repair with zero new provider entries",
    posix,
    async (t) => {
      const f = await prFixture(t);
      f.engine.store.setSessionPaused(f.session.id, true, "user");
      await f.register();
      const r = await f.engine.pollPrWatch(f.pollInput()),
        calls = f.providerCalls;
      if (change === "profile")
        f.engine.profiles.register({
          ...f.config.agentProfiles[0]!,
          instructions: "changed profile",
        });
      if (change === "policy")
        await f.engine.configureVerificationSession(f.session.id, 1, {
          checkIds: ["check"],
          sourcePaths: ["a.ts"],
          maxRepairs: 0,
        });
      if (change === "head") {
        f.remote.head = "e".repeat(40);
        f.remote.checks[0]!.head_sha = f.remote.head;
        await f.engine.pollPrWatch(f.pollInput());
      }
      f.engine.store.setSessionPaused(f.session.id, false);
      await assert.rejects(f.engine.scheduler.wake(f.session.id));
      assert.equal(f.providerCalls, calls);
      assert.equal(
        f.engine.store.getInput(r.occurrence!.accepted!.inputId).runId,
        undefined,
      );
    },
  );
test(
  "private endpoints, path escape, credentials and remote redirects are rejected before effects",
  posix,
  async (t) => {
    const f = await prFixture(t);
    const input = {
      sessionId: f.session.id,
      watchId: "unsafe",
      repository: { owner: "acme", name: "project", number: 1 },
      policy: {
        required: [{ kind: "check" as const, name: "build", appId: 10 }],
        reviews: "observe" as const,
        maxRepairInputs: 1,
      },
      config: f.sourceRun.config,
      sourceRunId: null,
    };
    for (const apiBase of [
      "http://example.invalid",
      "https://user:secret@api.github.com",
      "https://api.github.com/other",
      "https://api.github.com?token=secret",
    ])
      await assert.rejects(
        f.engine.previewPrWatch({ ...input, apiBase }),
        EngineError,
      );
    await f.register();
    f.remote.onRequest = (_req, res) => {
      res.writeHead(302, { location: "http://example.invalid/escape" });
      res.end();
      return true;
    };
    const r = await f.engine.pollPrWatch(f.pollInput());
    assert.equal(r.kind, "gap");
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
  },
);
for (const status of [403, 429, 500])
  test(
    "actual streaming HTTP " +
      status +
      " body is cancelled and its response socket closes",
    posix,
    async (t) => {
      const f = await prFixture(t);
      await f.register();
      let closed = false;
      f.remote.onRequest = (_req, res) => {
        res.writeHead(status, {
          "content-type": "application/json",
          "retry-after": "1",
        });
        res.write('{"message":"never-ending');
        const timer = setInterval(() => res.write("x"), 5);
        res.once("close", () => {
          closed = true;
          clearInterval(timer);
        });
        return true;
      };
      const r = await f.engine.pollPrWatch(f.pollInput());
      assert.equal(r.kind, "gap");
      const deadline = Date.now() + 2000;
      while (!closed) {
        assert.ok(
          Date.now() < deadline,
          "remote body connection did not close",
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
    },
  );
