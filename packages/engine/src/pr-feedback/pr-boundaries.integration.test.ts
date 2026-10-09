import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { EngineError, type Session, type Workspace } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter } from "../ports.js";
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
const hasCode = (code: string) => (error: unknown) =>
  error instanceof EngineError && error.code === code;
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setImmediate(resolve));
  }
}
/** Real Root/SQLite/HTTP watch lifecycle without a coding Run or verification producer. */
async function watchFixture(t: TestContext, enabled = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "moodcode-pr-watch-")));
  const root = join(base, "repo"), dbPath = join(base, "engine.sqlite");
  await mkdir(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  await writeFile(join(root, "a.ts"), "const passiveWatchSource = 1;\n");
  const head = "a".repeat(40);
  const remote = {
    checks: [{ id: 1, name: "build", app: { id: 10 }, head_sha: head, status: "completed", conclusion: "failure", started_at: "2026-10-01T00:00:00Z", output: { summary: "Observed check failure" } }] as Record<string, unknown>[],
    requests: [] as { method: string; url: string }[],
    onRequest: null as ((request: IncomingMessage, response: ServerResponse) => boolean) | null,
  };
  const server = createServer((request, response) => {
    remote.requests.push({ method: request.method!, url: request.url! });
    if (remote.onRequest?.(request, response)) return;
    const path = request.url!.split("?")[0]!;
    const repository = { id: 100, name: "project", owner: { login: "acme" } };
    let data: unknown;
    if (path.endsWith("/pulls/1"))
      data = { number: 1, state: "open", base: { sha: head, repo: repository }, head: { sha: head, repo: repository } };
    else if (path.endsWith("/check-runs")) data = { total_count: remote.checks.length, check_runs: remote.checks };
    else if (path.endsWith("/statuses") || path.endsWith("/reviews")) data = [];
    else { response.writeHead(404); response.end("{}"); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const apiBase = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  let providerCalls = 0;
  const provider: ProviderAdapter = {
    id: "passive-watch",
    async *streamTurn() { providerCalls++; throw new Error("Passive watch must never enter a provider"); },
  };
  const engine = createEngine({ dbPath, artifactDir: join(base, "artifacts"), prFeedback: enabled, prFeedbackLoopback: true, verificationTools: true, providers: [provider], defaults: { providerId: provider.id, modelId: "fixture", mode: "plan" } });
  t.after(async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(base, { recursive: true, force: true });
  });
  const opened = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: "workspace.open", payload: { path: root } });
  assert.equal(opened.ok, true);
  const workspace = opened.result as unknown as Workspace;
  const created = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: "session.create", payload: { workspaceId: workspace.id } });
  assert.equal(created.ok, true);
  const session = created.result as unknown as Session;
  const preview = (watchId = "watch", sourceRunId: null = null) => engine.previewPrWatch({ sessionId: session.id, watchId, repository: { owner: "acme", name: "project", number: 1 }, policy: { required: [{ kind: "check", name: "build", appId: 10 }], reviews: "observe", maxRepairInputs: 1 }, config: { providerId: provider.id, modelId: "fixture", mode: "plan", limits: engine.getCapabilities().defaults.limits }, sourceRunId, apiBase });
  const registration = (original: object, decision: "allow" | "deny" = "allow") => {
    const description = engine.readPrWatchPreview(original);
    return { workspaceId: workspace.id, sessionId: session.id, watchId: description.id, requestId: "register:" + description.id, expectedRevision: 0 as const, previewSha256: description.sha256, decision };
  };
  const register = async (watchId = "watch", sourceRunId: null = null) => {
    const original = await preview(watchId, sourceRunId);
    return engine.registerPrWatch(original, registration(original));
  };
  const pollInput = (requestId: string, watchId: string) => ({ workspaceId: workspace.id, sessionId: session.id, watchId, requestId, expectedRevision: engine.getPrWatch(workspace.id, session.id, watchId)!.revision });
  return { base, root, dbPath, engine, workspace, session, remote, preview, registration, register, pollInput, get providerCalls() { return providerCalls; } };
}
async function preserveWatchEvidence(
  f: Awaited<ReturnType<typeof watchFixture>>,
  name: string,
) {
  const output = process.env.MOODCODE_PR_WATCH_EVIDENCE_DIR;
  if (!output) return;
  await f.engine.close();
  const directory = join(output, name);
  await mkdir(directory, { recursive: true });
  await copyFile(f.dbPath, join(directory, "engine.sqlite"));
  await copyFile(join(f.root, "a.ts"), join(directory, "source-a.ts"));
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    await writeFile(join(directory, "native-evidence.json"), JSON.stringify({
      sessionId: f.session.id,
      workspaceId: f.workspace.id,
      providerCalls: f.providerCalls,
      httpRequests: f.remote.requests,
      documents: db.prepare("SELECT kind,revision,data FROM session_documents WHERE session_id=? ORDER BY kind").all(f.session.id),
      events: db.prepare("SELECT seq,type,data FROM session_events WHERE session_id=? ORDER BY seq").all(f.session.id),
      inputs: db.prepare("SELECT id,state,data FROM session_inputs WHERE session_id=? ORDER BY id").all(f.session.id),
    }, null, 2) + "\n");
  } finally {
    db.close();
  }
}
function watchCounts(f: Awaited<ReturnType<typeof watchFixture>>) {
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    const events = (type: string) => Number(db.prepare("SELECT count(*) n FROM session_events WHERE session_id=? AND type=?").get(f.session.id, type)!.n);
    return {
      admissions: events("pr.watch.admitted"),
      transitions: events("pr.watch.transition"),
      observations: events("pr.remote.observed"),
      feedback: events("pr.feedback.admitted"),
      duplicates: events("pr.request.duplicate"),
      runs: Number(db.prepare("SELECT count(*) n FROM runs WHERE session_id=?").get(f.session.id)!.n),
      inputs: Number(db.prepare("SELECT count(*) n FROM session_inputs WHERE session_id=?").get(f.session.id)!.n),
    };
  } finally {
    db.close();
  }
}
test(
  "watch startup rejects a missing id and subsequent native registration can start, stop and restart",
  posix,
  async t => {
    const f = await watchFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    const input = { workspaceId: f.workspace.id, sessionId: f.session.id, watchId: "watch", intervalMs: 1000 };
    const calls = f.providerCalls;
    assert.equal(calls, 0);
    assert.throws(() => f.engine.startPrWatch(input), hasCode("PR_WATCH_STALE"));
    assert.equal(f.engine.getPrWatch(f.workspace.id, f.session.id, "watch"), null);
    assert.equal(f.remote.requests.length, 0);
    assert.deepEqual(watchCounts(f), { admissions: 0, transitions: 0, observations: 0, feedback: 0, duplicates: 0, runs: 0, inputs: 0 });
    const registered = await f.register("watch", null);
    assert.equal(registered.cursor, 0);
    assert.deepEqual(f.engine.startPrWatch(input), { watchId: "watch" });
    assert.throws(() => f.engine.startPrWatch(input), hasCode("PR_WATCH_RUNNING"));
    await until(() => f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.cursor === 1, "Original watch did not poll");
    f.engine.stopPrWatch(f.workspace.id, f.session.id, "watch");
    await new Promise(resolve => setImmediate(resolve));
    const requests = f.remote.requests.length;
    f.remote.checks[0]!.id = 2;
    f.remote.checks[0]!.started_at = "2026-10-02T00:00:00Z";
    assert.deepEqual(f.engine.startPrWatch(input), { watchId: "watch" });
    await until(() => f.remote.requests.length > requests, "Restarted watch did not enter HTTP");
    await until(() => f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.cursor === 2, "Restarted watch did not settle");
    f.engine.stopPrWatch(f.workspace.id, f.session.id, "watch");
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
    assert.equal(f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.revision, 3);
    assert.deepEqual(watchCounts(f), { admissions: 1, transitions: 3, observations: 2, feedback: 2, duplicates: 0, runs: 0, inputs: 0 });
    await f.engine.close();
    const stoppedRequests = f.remote.requests.length;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.remote.requests.length, stoppedRequests);
    assert.equal(f.providerCalls, calls);
    await preserveWatchEvidence(f, "missing-register-restart");
  },
);
test(
  "watch startup rejects denied and disabled native watches without HTTP or durable changes",
  posix,
  async t => {
    const f = await watchFixture(t);
    const calls = f.providerCalls;
    assert.equal(calls, 0);
    const deniedPreview = await f.preview("denied", null);
    const denied = f.engine.registerPrWatch(deniedPreview, f.registration(deniedPreview, "deny"));
    await f.register("disabled", null);
    const disabled = f.engine.disablePrWatch(f.pollInput("disable-watch", "disabled"));
    for (const [watchId, original] of [["denied", denied], ["disabled", disabled]] as const) {
      assert.throws(() => f.engine.startPrWatch({ workspaceId: f.workspace.id, sessionId: f.session.id, watchId, intervalMs: 1000 }), hasCode("PR_WATCH_STALE"));
      assert.deepEqual(f.engine.getPrWatch(f.workspace.id, f.session.id, watchId), original);
    }
    assert.equal(f.remote.requests.length, 0);
    assert.equal(f.providerCalls, calls);
    assert.equal(f.engine.store.pendingInputs(f.session.id).length, 0);
    assert.deepEqual(watchCounts(f), { admissions: 2, transitions: 3, observations: 0, feedback: 0, duplicates: 0, runs: 0, inputs: 0 });
    await preserveWatchEvidence(f, "denied-disabled");
  },
);
test(
  "watch startup preserves the public default-off feature error without native admission",
  posix,
  async t => {
    const f = await watchFixture(t, false);
    const calls = f.providerCalls;
    assert.equal(calls, 0);
    assert.throws(() => f.engine.startPrWatch({ workspaceId: f.workspace.id, sessionId: f.session.id, watchId: "watch", intervalMs: 1000 }), hasCode("PR_FEEDBACK_UNSUPPORTED"));
    assert.equal(f.engine.getPrWatch(f.workspace.id, f.session.id, "watch"), null);
    assert.equal(f.remote.requests.length, 0);
    assert.equal(f.providerCalls, calls);
    assert.deepEqual(watchCounts(f), { admissions: 0, transitions: 0, observations: 0, feedback: 0, duplicates: 0, runs: 0, inputs: 0 });
    await preserveWatchEvidence(f, "default-off");
  },
);
test(
  "watch startup loop is drained by Root close without new HTTP or provider replay",
  posix,
  async t => {
    const f = await watchFixture(t);
    await f.register("watch", null);
    const calls = f.providerCalls;
    assert.equal(calls, 0);
    let socketClosed = false;
    f.remote.onRequest = (_request, response) => {
      response.once("close", () => { socketClosed = true; });
      return true;
    };
    f.engine.startPrWatch({ workspaceId: f.workspace.id, sessionId: f.session.id, watchId: "watch", intervalMs: 1000 });
    await until(() => f.remote.requests.length === 1, "Original watch did not enter HTTP");
    await f.engine.close();
    await until(() => socketClosed, "Original HTTP response did not close");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.remote.requests.length, 1);
    assert.equal(f.providerCalls, calls);
    assert.deepEqual(watchCounts(f), { admissions: 1, transitions: 1, observations: 0, feedback: 0, duplicates: 0, runs: 0, inputs: 0 });
    assert.throws(() => f.engine.startPrWatch({ workspaceId: f.workspace.id, sessionId: f.session.id, watchId: "watch", intervalMs: 1000 }), hasCode("ENGINE_CLOSED"));
    await preserveWatchEvidence(f, "root-close");
  },
);
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
