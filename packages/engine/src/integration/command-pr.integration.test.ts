import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import { prFixture } from "../pr-feedback/fixtures/pr.js";
import { jobUntil, jobCommand } from "../jobs/fixtures/job.js";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
test(
  "actual command cleanup gates PR polling, then host and PR native inbox inputs consume once with independent source evidence",
  {
    timeout: 30000,
    skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  },
  async (t) => {
    const f = await prFixture(t, {
      repair: true,
      engine: { jobs: true, hostCommands: true, commandJobModelTools: true },
    });
    await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
    await f.register();
    const marker = join(f.base, "command.pid");
    const program = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdout.write('INDEPENDENT_COMMAND_SOURCE\\n');setInterval(()=>{},100);`;
    const preview = await f.engine.previewHostCommand({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      command: quote(process.execPath) + " -e " + quote(program),
      limits: { maxDurationMs: 10000, maxOutputBytes: 8192 },
    });
    const started = await f.engine.startHostCommand({
      workspaceId: f.workspace.id,
      requestId: "cross-feature-host",
      preview,
      fingerprint: f.engine.readHostCommandPreview(preview).fingerprint,
      approved: true,
    });
    await jobUntil(() => existsSync(marker), "actual command PID missing");
    const pid = Number(readFileSync(marker, "utf8")),
      remoteBefore = f.remote.requests.length,
      callsBefore = f.providerCalls;
    await assert.rejects(
      () => f.engine.pollPrWatch(f.pollInput("while-owned")),
      EngineError,
    );
    assert.equal(f.remote.requests.length, remoteBefore);
    assert.equal(f.providerCalls, callsBefore);
    assert.equal(f.engine.store.pendingInputs(f.session.id, "queue").length, 0);
    await f.engine.cancelHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    const command = await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.equal(command.state, "cancelled");
    assert.equal(command.completion!.outcome.cleanupConfirmed, true);
    await jobUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, "actual command PID remained alive");
    assert.throws(() => process.kill(pid, 0));
    const target = f.engine.captureHostCommandJobDeliveryTarget({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
      config: f.sourceRun.config,
    });
    const delivered = f.engine.deliverHostCommandJobResult({
      workspaceId: f.workspace.id,
      requestId: "cross-feature-host-input",
      expectedRevision: 0,
      target,
      approved: true,
    });
    assert.equal(delivered.kind, "accepted");
    const feedbackRequest = f.pollInput("after-cleanup");
    const feedback = await f.engine.pollPrWatch(feedbackRequest);
    assert.equal(feedback.occurrence!.state, "accepted");
    const commandInput = delivered.record.accepted.inputId,
      feedbackInput = feedback.occurrence!.accepted!.inputId;
    assert.notEqual(commandInput, feedbackInput);
    assert.equal(f.engine.store.pendingInputs(f.session.id, "queue").length, 2);
    const evidenceDb = new DatabaseSync(f.dbPath, { readOnly: true });
    t.after(() => evidenceDb.close());
    const eventsBefore = Number(
      evidenceDb
        .prepare("SELECT count(*) n FROM session_events WHERE session_id=?")
        .get(f.session.id)!.n,
    );
    assert.equal(
      f.engine.deliverHostCommandJobResult({
        workspaceId: f.workspace.id,
        requestId: "cross-feature-host-input",
        expectedRevision: 0,
        target,
        approved: true,
      }).kind,
      "duplicate",
    );
    assert.equal(
      (await f.engine.pollPrWatch(feedbackRequest)).kind,
      "duplicate",
    );
    assert.equal(
      Number(
        evidenceDb
          .prepare("SELECT count(*) n FROM session_events WHERE session_id=?")
          .get(f.session.id)!.n,
      ),
      eventsBefore,
    );
    const coordinator = f.engine.coordinator;
    const executeNested =
      coordinator.withVerificationCommandContext.bind(coordinator);
    let realNestedExecutions = 0,
      invalidExecutions = 0,
      traps = 0;
    coordinator.withVerificationCommandContext = async (
      outer,
      nested,
      execute,
    ) => {
      const forbidden = async () => {
        invalidExecutions++;
        throw new Error("Invalid nesting reached execution");
      };
      await assert.rejects(
        executeNested({ ...outer }, nested, forbidden),
        EngineError,
      );
      await assert.rejects(
        executeNested(
          outer,
          {
            ...nested,
            limits: {
              ...nested.limits,
              maxOutputBytes: outer.limits.maxOutputBytes + 1,
            },
          },
          forbidden,
        ),
        EngineError,
      );
      await assert.rejects(
        executeNested(
          outer,
          new Proxy(nested, {
            get() {
              traps++;
              throw new Error("Proxy invoked");
            },
          }),
          forbidden,
        ),
        EngineError,
      );
      assert.throws(
        () => coordinator.readOwnedCommandContext({ ...nested }, "start"),
        EngineError,
      );
      try {
        return await executeNested(outer, nested, async () => {
          assert.equal(
            coordinator.readOwnedCommandContext(nested, "start").name,
            "verify_changes",
          );
          realNestedExecutions++;
          return execute();
        });
      } finally {
        assert.throws(
          () => coordinator.readOwnedCommandContext(nested, "settle"),
          EngineError,
        );
      }
    };
    await jobCommand(f.engine, "session.resume", { sessionId: f.session.id });
    const deadline = Date.now() + 15000;
    for (const id of [commandInput, feedbackInput]) {
      await jobUntil(
        () => Boolean(f.engine.store.getInput(id).runId),
        "actual inbox was not promoted",
      );
      const run = await f.finish(f.engine.store.getInput(id).runId!);
      assert.equal(run.state, "completed", JSON.stringify(run.error));
      assert.ok(Date.now() < deadline);
    }
    assert.ok(
      f.prompts.some((p) =>
        p.includes("Moodcode independent host command result v1"),
      ),
    );
    assert.ok(f.prompts.some((p) => p.includes("Moodcode PR feedback v1")));
    assert.equal(f.engine.inspectHostCommands(f.workspace.id).length, 1);
    assert.equal(
      f.engine.getPrWatch(f.workspace.id, f.session.id, "watch")!.repairInputs,
      1,
    );
    const verification = await f.engine.getPrRepairVerification(
      f.workspace.id,
      f.session.id,
      feedback.occurrence!.id,
    );
    assert.equal(verification.status, "verified-local");
    assert.equal(verification.mergeAuthority, false);
    assert.equal(f.engine.store.getRun(f.sourceRun.id).state, "completed");
    assert.equal(realNestedExecutions, 2);
    assert.equal(invalidExecutions, 0);
    assert.equal(traps, 0);
    assert.equal(f.engine.inspectOwnedCommandJobs(f.workspace.id).length, 1);
    f.engine.releaseHostCommandJobDeliveryHandle(target);
  },
);
