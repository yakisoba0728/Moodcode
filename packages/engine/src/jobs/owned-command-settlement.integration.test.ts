import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { RunConfig, RunReceipt } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../ports.js";
import { jobCommand, jobFixture, jobInvoke, jobUntil } from "./fixtures/job.js";
import type { OwnedCommandJobRecord } from "./owned-command-records.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20_000,
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function approvedCommand(t: TestContext) {
  const f = await jobFixture(t, { createTerminal: false, jobs: true });
  const marker = join(f.root, "settlement.pid"),
    release = join(f.root, "settlement.release"),
    count = join(f.root, "settlement.count"),
    script = join(f.root, "settlement.mjs");
  writeFileSync(
    script,
    `import{writeFileSync,readFileSync,existsSync}from'node:fs';
writeFileSync(${JSON.stringify(count)},String(existsSync(${JSON.stringify(count)})?Number(readFileSync(${JSON.stringify(count)},'utf8'))+1:1));
writeFileSync(${JSON.stringify(marker)},String(process.pid));
process.stdout.write('SETTLEMENT_READY\\n');
const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('SETTLEMENT_DONE\\n',()=>process.exit(0));}},10);
`,
  );
  let providerCalls = 0;
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(): AsyncIterable<ProviderEvent> {
      providerCalls++;
      if (providerCalls === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "settlement-command",
            name: "run_command",
            input: {
              command: `${quote(process.execPath)} ${quote(script)}`,
              timeoutMs: 8_000,
            },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield { type: "finish", reason: "stop" };
    },
  };
  (
    Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
  ).set(provider.id, provider);
  const profile = {
    id: "settlement-command-profile",
    description: "Actual settlement fault regression",
    instructions: "Execute only the explicitly approved command",
    tools: ["run_command"],
  };
  f.engine.profiles.register(profile);
  const config: RunConfig = {
    ...f.config,
    agentProfileId: profile.id,
    mode: "build",
    limits: {
      ...f.config.limits,
      maxTurns: 2,
      maxToolCalls: 1,
      maxOutputBytes: 131_072,
      toolTimeoutMs: 10_000,
    },
    budgets: { ...f.config.budgets!, turnAllowance: 2, maxProviderAttempts: 1 },
  };
  const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
    sessionId: f.session.id,
    requestId: randomUUID(),
    prompt:
      "Execute the actual approved command before testing receipt failure",
    config: JSON.parse(JSON.stringify(config)),
  });
  await jobUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some(
          (a) => a.runId === receipt.runId && a.status === "pending",
        ),
    "The actual command must request its native approval",
  );
  const approval = f.engine.store
    .getSnapshot(f.session.id)
    .approvals.find(
      (a) => a.runId === receipt.runId && a.status === "pending",
    )!;
  f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
  await jobUntil(() => {
    const run = f.engine.store.getRun(receipt.runId);
    assert.ok(
      !["completed", "failed", "cancelled", "interrupted"].includes(run.state),
      `Run ended before the approved command spawn: ${JSON.stringify({ run, tools: f.rows("tools"), docs: (Reflect.get(f.engine.store, "db") as DatabaseSync).prepare("SELECT kind,data FROM session_documents WHERE kind LIKE 'command.job.%'").all() })}`,
    );
    return existsSync(marker);
  }, "The genuinely approved command must start before the settlement fault");
  const jobs = () =>
    jobInvoke<OwnedCommandJobRecord[]>(
      f.engine,
      "inspectOwnedCommandJobs",
      f.workspace.id,
      f.session.id,
    );
  await jobUntil(
    () => jobs().some((j) => j.state === "running"),
    "Missing actual running job",
  );
  const job = jobs()[0]!;
  assert.equal(job.source.approvalId, approval.id);
  assert.equal(job.source.approvalFingerprint, approval.fingerprint);
  assert.equal(job.source.runId, receipt.runId);
  return {
    ...f,
    marker,
    release,
    count,
    profile,
    receipt,
    job,
    jobs,
    calls: () => providerCalls,
  };
}

function nativeResults(db: DatabaseSync, runId: string, toolId: string) {
  return {
    tools: Number(
      db.prepare("SELECT count(*) n FROM tools WHERE run_id=?").get(runId)!.n,
    ),
    results: Number(
      db
        .prepare(
          "SELECT count(*) n FROM messages WHERE run_id=? AND json_extract(data,'$.role')='tool'",
        )
        .get(runId)!.n,
    ),
    parts: Number(
      db
        .prepare(
          "SELECT count(*) n FROM message_parts WHERE run_id=? AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.toolCallId')=? AND state='completed'",
        )
        .get(runId, toolId)!.n,
    ),
    events: Number(
      db
        .prepare(
          "SELECT count(*) n FROM events WHERE run_id=? AND type IN ('tool.completed','tool.failed')",
        )
        .get(runId)!.n,
    ),
  };
}

for (const persistent of [false, true]) {
  test(
    `${persistent ? "persistent" : "one failed"} actual completed job transaction never duplicates the durable Tool result or replays its command`,
    posix,
    async (t) => {
      const f = await approvedCommand(t),
        store = f.engine.store;
      const db = Reflect.get(store, "db") as DatabaseSync;
      const original = store.putOwnedCommandJob.bind(store);
      const transaction = Reflect.get(store, "transaction") as <T>(
        operation: () => T,
      ) => T;
      let completedWrites = 0,
        rolledBackWrites = 0;
      const initialJobRevision = f.job.revision;
      store.putOwnedCommandJob = (source, jobId, expectedRevision, data) => {
        if (
          data.state !== "completed" &&
          !(persistent && data.state === "uncertain")
        )
          return original(source, jobId, expectedRevision, data);
        if (data.state === "completed") completedWrites++;
        assert.deepEqual(
          nativeResults(db, f.receipt.runId, f.job.source.toolCallId),
          {
            tools: 1,
            results: 1,
            parts: 1,
            events: 1,
          },
          "The fault boundary must follow the actual terminal Tool Part commit",
        );
        return Reflect.apply(transaction, store, [
          () => {
            const saved = original(source, jobId, expectedRevision, data);
            assert.equal(saved.data.state, data.state);
            rolledBackWrites++;
            throw new Error(
              "Actual completed SessionDocument transaction failed after its native write",
            );
          },
        ]);
      };
      writeFileSync(f.release, "Allow the actual command to exit cleanly\n");
      await f.engine.waitForRun(f.receipt.runId);
      store.putOwnedCommandJob = original;
      const run = store.getRun(f.receipt.runId);
      assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
      assert.notEqual(run.state, "completed");
      assert.equal(completedWrites, 1);
      assert.equal(rolledBackWrites, persistent ? 2 : 1);
      assert.equal(
        f.calls(),
        1,
        "Receipt failure must not become a second provider turn",
      );
      assert.equal(readFileSync(f.count, "utf8"), "1");
      assert.deepEqual(nativeResults(db, run.id, f.job.source.toolCallId), {
        tools: 1,
        results: 1,
        parts: 1,
        events: 1,
      });
      assert.equal(
        store.getToolCall(f.job.source.toolCallId).state,
        "completed",
      );
      const after = f.jobs()[0]!;
      assert.equal(after.state, persistent ? "settling" : "uncertain");
      assert.ok(after.completion?.outcome.cleanupConfirmed);
      assert.equal(after.completion?.outcome.exitCode, 0);
      assert.equal(after.revision, initialJobRevision + (persistent ? 1 : 2));
      assert.throws(
        () => process.kill(Number(readFileSync(f.marker, "utf8")), 0),
        (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
      );
      await f.engine.close();
      const reopened = createEngine({
        ...f.configuration,
        agentProfiles: [...f.configuration.agentProfiles!, f.profile],
      });
      f.engines.add(reopened);
      const recovered = jobInvoke<OwnedCommandJobRecord[]>(
        reopened,
        "inspectOwnedCommandJobs",
        f.workspace.id,
        f.session.id,
      )[0]!;
      assert.equal(recovered.state, "uncertain");
      assert.equal(recovered.source.sha256, after.source.sha256);
      assert.deepEqual(recovered.completion, after.completion);
      await reopened.dispatchSession({
        schemaVersion: 2,
        commandId: randomUUID(),
        type: "session.resume",
        payload: { sessionId: f.session.id },
      });
      assert.equal(
        f.providerCalls.length,
        0,
        "Reopen/resume must not dispatch a provider for unresolved command history",
      );
      assert.equal(readFileSync(f.count, "utf8"), "1");
      const reopenedDb = Reflect.get(reopened.store, "db") as DatabaseSync;
      assert.deepEqual(
        nativeResults(reopenedDb, run.id, f.job.source.toolCallId),
        {
          tools: 1,
          results: 1,
          parts: 1,
          events: 1,
        },
      );
      assert.equal(reopened.store.getSnapshot(f.session.id).runs.length, 1);
    },
  );
}
