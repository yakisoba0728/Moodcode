import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  fixture,
  program,
  literal,
  variable,
  call,
  until,
} from "./fixtures/engine.js";
const actual = { skip: process.platform !== "darwin", timeout: 45000 };
test(
  "actual OS runtime pure bounded result and original native Tool Part approval receipt",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const r = await f.submit();
    await f.allow(r);
    const run = await f.wait(r);
    assert.equal(run.state, "completed", JSON.stringify(run));
    const records = f.engine.inspectCodeMode(f.workspace.id);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.state, "completed");
    assert.equal(records[0]!.result, 7);
    assert.equal(records[0]!.outcome?.cleanupConfirmed, true);
    assert.ok(records[0]!.process?.processId);
  },
);
test(
  "actual same native Turn read broker uses Run cumulative budget and result data",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const r = await f.submit(
      program([
        call("seed", "read_file", { path: "seed" }),
        { op: "return", value: variable("seed") },
      ]),
    );
    await f.allow(r);
    const run = await f.wait(r);
    assert.equal(run.state, "completed", JSON.stringify(run));
    const record = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(record.calls.length, 1);
    assert.match(JSON.stringify(record.result), /actual seed/);
    assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 2);
  },
);
test(
  "nested actual command requires separate approval and original checkpoint then completes",
  actual,
  async (t) => {
    const f = await fixture(t, {
      jobs: true,
      toolPolicy: [{ tool: "run_command", decision: "allow" }] as any,
    });
    await f.grant();
    const r = await f.submit(
      program([
        call("write", "run_command", { command: "printf nested > actual" }),
        { op: "return", value: variable("write") },
      ]),
    );
    const outer = await f.allow(r);
    const nested = await f.approval(r);
    assert.equal(nested.toolName, "run_command");
    assert.notEqual(nested.id, outer.id);
    assert.equal(existsSync(join(f.root, "actual")), false);
    f.engine.approvals.decide(nested.id, "allow", nested.fingerprint);
    const run = await f.wait(r);
    assert.equal(run.state, "completed", JSON.stringify(run));
    assert.equal(readFileSync(join(f.root, "actual"), "utf8"), "nested");
    assert.equal(f.engine.store.listCheckpoints(r.runId).length, 1);
    assert.equal(
      f.engine.inspectOwnedCommandJobs(f.workspace.id)[0]!.state,
      "completed",
    );
    const record = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(record.calls[0]!.approval?.id, nested.id);
    assert.equal(record.state, "completed");
  },
);
test(
  "denied outer and nested approval produce no command effect or second runtime",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const src = program([
      call("write", "run_command", { command: "printf denied > denied" }),
      { op: "return", value: variable("write") },
    ]);
    const first = await f.submit(src),
      a = await f.approval(first);
    f.engine.approvals.decide(a.id, "deny", a.fingerprint);
    await f.wait(first);
    assert.equal(f.engine.inspectCodeMode(f.workspace.id).length, 0);
    assert.equal(existsSync(join(f.root, "denied")), false);
    const second = await f.submit(src);
    await f.allow(second);
    const b = await f.approval(second);
    f.engine.approvals.decide(b.id, "deny", b.fingerprint);
    const run = await f.wait(second);
    assert.equal(run.state, "completed");
    const row = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(row.calls[0]!.state, "denied");
    assert.equal(row.calls[0]!.approval, null);
    assert.equal(existsSync(join(f.root, "denied")), false);
  },
);
test(
  "same-policy new Original grant during nested wait rejects late approval before physical dispatch",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const r = await f.submit(
      program([
        call("write", "run_command", { command: "printf stale > stale" }),
        { op: "return", value: literal(true) },
      ]),
    );
    await f.allow(r);
    const pending = await f.approval(r);
    const replacement = f.engine.previewCodeModeGrant({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      config: f.config,
    });
    const g = f.engine.readCodeModeGrant(replacement);
    f.engine.approveCodeModeGrant({
      preview: replacement,
      fingerprint: g.sha256,
      approved: true,
    });
    f.engine.approvals.decide(pending.id, "allow", pending.fingerprint);
    await f.wait(r);
    assert.equal(existsSync(join(f.root, "stale")), false);
    assert.equal(
      f.engine.inspectCodeMode(f.workspace.id)[0]!.calls[0]!.state,
      "failed",
    );
  },
);
test(
  "outer parent cancellation joins running command group and restricted runtime with no replay",
  actual,
  async (t) => {
    const f = await fixture(t, { jobs: true });
    await f.grant();
    const r = await f.submit(
      program([
        call("slow", "run_command", {
          command: `printf '%s\\n' $$ > pid.tmp; mv pid.tmp pid; sleep 30`,
        }),
        { op: "return", value: literal(true) },
      ]),
    );
    await f.allow(r);
    const originalApproval = await f.allow(r);
    const marker = join(f.root, "pid");
    await until(
      () =>
        existsSync(marker) && /^[1-9]\d*\n$/.test(readFileSync(marker, "utf8")),
      "complete original child PID publication",
    );
    const originalPid = Number(readFileSync(marker, "utf8"));
    assert.ok(Number.isSafeInteger(originalPid) && originalPid > 1);
    assert.doesNotThrow(() => process.kill(originalPid, 0));
    const originalJob = f.engine.inspectOwnedCommandJobs(f.workspace.id)[0]!;
    assert.equal(originalJob.state, "running");
    assert.equal(originalJob.groupPid, originalPid);
    assert.equal(originalJob.source.runId, r.runId);
    assert.equal(originalJob.source.approvalId, originalApproval.id);
    assert.equal(
      originalJob.source.approvalFingerprint,
      originalApproval.fingerprint,
    );
    await f.dispatch("run.cancel", { runId: r.runId });
    const run = await f.wait(r);
    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
    assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
    const row = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(row.state, "uncertain");
    assert.equal(row.outcome?.cleanupConfirmed, true);
    assert.ok(
      Number.isSafeInteger(row.process!.processId) &&
        row.process!.processId > 1,
    );
    assert.throws(() => process.kill(row.process!.processId, 0), {
      code: "ESRCH",
    });
    const requests = f.requests.length;
    await f.reopen();
    assert.equal(f.requests.length, requests);
    assert.equal(
      f.engine.inspectCodeMode(f.workspace.id)[0]!.state,
      "uncertain",
    );
    const retainedCode = JSON.parse(
        JSON.stringify(f.engine.inspectCodeMode(f.workspace.id)[0]!),
      ),
      retainedJob = JSON.parse(
        JSON.stringify(f.engine.inspectOwnedCommandJobs(f.workspace.id)[0]!),
      );
    t.after(() => {
      assert.ok(
        existsSync(f.dbPath),
        "Passing uncertainty checks retain their native SQLite evidence",
      );
      const db = new DatabaseSync(f.dbPath, { readOnly: true });
      try {
        const documents = db
          .prepare("SELECT data FROM session_documents ORDER BY rowid")
          .all()
          .map((record) => JSON.parse(String(record.data)));
        assert.deepEqual(
          documents.find((record) => record.id === retainedCode.id),
          retainedCode,
        );
        assert.deepEqual(
          documents.find((record) => record.jobId === retainedJob.jobId),
          retainedJob,
        );
      } finally {
        db.close();
      }
      for (const phase of ["before-close", "after-close"]) {
        const captured = JSON.parse(
          readFileSync(join(f.base, `${phase}.json`), "utf8"),
        );
        assert.deepEqual(
          captured.native.session_documents.find(
            (record: { id?: string }) => record.id === retainedCode.id,
          ),
          retainedCode,
        );
        assert.equal(captured.requests.length, requests);
      }
    });
  },
);
async function cancelAfterNestedRead(f: Awaited<ReturnType<typeof fixture>>) {
  const coordinator = f.engine.coordinator,
    original = coordinator.executeCodeModeNested.bind(coordinator);
  coordinator.executeCodeModeNested = async (context, input) => {
    const result = await original(context, input);
    await f.dispatch("run.cancel", { runId: context.runId });
    return result;
  };
  const r = await f.submit(
    program([
      call("read", "read_file", { path: "seed" }),
      { op: "return", value: literal(true) },
    ]),
  );
  await f.allow(r);
  return f.wait(r);
}
test(
  "cancel after a settled nested call with confirmed runtime close settles as cancelled and keeps the workspace usable",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    assert.equal((await cancelAfterNestedRead(f)).state, "cancelled");
    const row = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(row.state, "failed");
    assert.equal(row.errorCode, "CANCELLED");
    assert.equal(row.outcome?.cleanupConfirmed, true);
    assert.equal(row.pendingCall, null);
    assert.equal(row.calls.length, 1);
    assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), false);
    await f.reopen();
    assert.equal(f.engine.inspectCodeMode(f.workspace.id)[0]!.state, "failed");
    assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), false);
    const resumed = await f.engine.dispatchSession({
      schemaVersion: 2,
      commandId: randomUUID(),
      type: "session.resume",
      payload: { sessionId: f.session.id },
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
    await f.grant();
    const next = await f.submit(program([{ op: "return", value: literal(1) }]));
    await f.allow(next);
    assert.equal((await f.wait(next)).state, "completed");
  },
);
test(
  "restart settles a confirmed closed run whose interrupted Tool settlement was lost as cancelled",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    Reflect.set(Reflect.get(f.engine, "codeModeHost"), "toolSettled", () => {});
    await cancelAfterNestedRead(f);
    assert.equal(
      f.engine.inspectCodeMode(f.workspace.id)[0]!.state,
      "settling",
    );
    await f.reopen();
    const row = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(row.state, "failed");
    assert.equal(row.errorCode, "CANCELLED");
    assert.equal(f.engine.store.hasUncertainWorkspace(f.workspace.id), false);
  },
);
test(
  "closed language and actual Run aggregate budget stop excess nested effect without widening",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    let traps = 0;
    assert.throws(() =>
      f.engine.previewCodeModeGrant(
        new Proxy(
          {},
          {
            get() {
              traps++;
              throw new Error("getter reached");
            },
          },
        ),
      ),
    );
    assert.equal(traps, 0);
    assert.throws(
      () =>
        f.engine.approveCodeModeGrant({
          preview: {},
          fingerprint: "0".repeat(64),
          approved: true,
        }),
      { code: "CODE_MODE_ORIGINAL_REQUIRED" },
    );
    const code = program([
      {
        op: "repeat",
        count: 12,
        index: "i",
        body: [call("read", "read_file", { path: "seed" })],
      },
      { op: "return", value: literal(true) },
    ]);
    const r = await f.submit(code);
    await f.allow(r);
    await f.wait(r);
    const row = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.ok(row.calls.length <= 8);
    assert.equal(row.outcome?.cleanupConfirmed, true);
    assert.notEqual(row.state, "completed");
  },
);
test(
  "code allocation timeout cancels pending nested approval before command dispatch and joins runtime",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const r = await f.submit(
      program([
        call("slow", "run_command", { command: "printf unexpected > timeout" }),
        { op: "return", value: literal(true) },
      ]),
    );
    await f.allow(r);
    const pending = await f.approval(r);
    const run = await f.wait(r);
    assert.equal(existsSync(join(f.root, "timeout")), false);
    const row = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(row.outcome?.cleanupConfirmed, true);
    assert.notEqual(row.state, "completed");
    assert.notEqual(f.engine.store.getApproval(pending.id).status, "allowed");
    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "TOOL_TIMEOUT");
  },
);
test(
  "cancel immediately before nested approval denies late dispatch and grants no copied Original context",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const r = await f.submit(
      program([
        call("write", "run_command", { command: "printf forbidden > late" }),
        { op: "return", value: literal(true) },
      ]),
    );
    await f.allow(r);
    const pending = await f.approval(r);
    await f.dispatch("run.cancel", { runId: r.runId });
    await f.wait(r);
    assert.throws(() =>
      f.engine.approvals.decide(pending.id, "allow", pending.fingerprint),
    );
    assert.equal(existsSync(join(f.root, "late")), false);
    assert.throws(
      () => f.engine.coordinator.readCodeModeContext({} as any, "execute"),
      { code: "CODE_MODE_OWNER_STALE" },
    );
  },
);
test(
  "actual patch broker retains native approval and checkpoint while language dynamically selects read result",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const r = await f.submit(
      program([
        call("patch", "apply_patch", {
          changes: [
            {
              path: "created",
              content: "actual code patch\n",
              expectedHash: null,
            },
          ],
        }),
        {
          op: "if",
          condition: {
            op: "equal",
            left: { op: "get", value: variable("patch"), key: "state" },
            right: literal("completed"),
          },
          then: [
            call("read", "read_file", { path: "created" }),
            { op: "return", value: variable("read") },
          ],
          else: [{ op: "return", value: literal("failed") }],
        },
      ]),
    );
    await f.allow(r);
    const patch = await f.approval(r);
    assert.equal(patch.toolName, "apply_patch");
    f.engine.approvals.decide(patch.id, "allow", patch.fingerprint);
    const run = await f.wait(r);
    assert.equal(run.state, "completed", JSON.stringify(run));
    assert.equal(
      readFileSync(join(f.root, "created"), "utf8"),
      "actual code patch\n",
    );
    assert.match(
      JSON.stringify(f.engine.inspectCodeMode(f.workspace.id)[0]!.result),
      /actual code patch/,
    );
    assert.equal(f.engine.store.listCheckpoints(r.runId).length, 1);
  },
);
test(
  "default-off exposes no code tool or live runtime, history lookup remains descriptive",
  actual,
  async (t) => {
    const f = await fixture(t, { codeMode: false });
    assert.equal(
      f.engine.getCapabilities().tools.some((t) => t.name === "execute_code"),
      false,
    );
    assert.equal(f.engine.getCodeModeCapability(), undefined);
    assert.equal(f.engine.getCodeModeSupport().enabled, false);
    await assert.rejects(f.engine.registerCodeModeHost(), {
      code: "CODE_MODE_DISABLED",
    });
    assert.deepEqual(f.engine.inspectCodeMode(f.workspace.id), []);
  },
);
test(
  "duplicate same Original broker request after actual command execution is fenced before second effect",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const coordinator = f.engine.coordinator,
      original = coordinator.executeCodeModeNested.bind(coordinator);
    let first = true;
    coordinator.executeCodeModeNested = async (context, input) => {
      const result = await original(context, input);
      if (first) {
        first = false;
        await assert.rejects(original(context, input), {
          code: "CODE_MODE_DUPLICATE_CALL",
        });
      }
      return result;
    };
    const r = await f.submit(
      program([
        call("once", "run_command", { command: "printf once >> once" }),
        { op: "return", value: literal(true) },
      ]),
    );
    await f.allow(r);
    await f.allow(r);
    assert.equal((await f.wait(r)).state, "completed");
    assert.equal(readFileSync(join(f.root, "once"), "utf8"), "once");
    assert.equal(
      f.engine.store
        .getSnapshot(f.session.id)
        .tools.filter((t) => t.name === "run_command").length,
      1,
    );
  },
);
test(
  "nested verify_changes preserves genuine narrowed Original command scope and actual verification receipt",
  actual,
  async (t) => {
    const f = await fixture(t, {
      verificationTools: true,
      jobs: true,
      agentProfiles: [
        {
          id: "code-verifier",
          description: "fixture checks",
          instructions: "Use actual host check",
          tools: ["execute_code", "verify_changes", "run_command", "read_file"],
        },
      ],
    });
    f.config.agentProfileId = "code-verifier";
    const profile = f.engine.profiles
      .list()
      .find((p) => p.id === "code-verifier")!;
    f.engine.registerVerificationCheck({
      id: "actual-code-check",
      revision: 1,
      workspaceId: f.workspace.id,
      command: "printf verified > verified",
      cwd: f.root,
      profileId: profile.id,
      profileRevision: profile.revision,
      sourceRevision: "actual-fixture-source",
      timeoutMs: 2000,
      maxOutputBytes: 8192,
      required: true,
    });
    await f.engine.configureVerificationSession(f.session.id, 0, {
      checkIds: ["actual-code-check"],
      sourcePaths: ["seed"],
      maxRepairs: 0,
    });
    await f.grant();
    const r = await f.submit(
      program([
        call("verify", "verify_changes", { checkId: "actual-code-check" }),
        { op: "return", value: variable("verify") },
      ]),
    );
    await f.allow(r);
    const check = await f.approval(r);
    assert.equal(check.toolName, "verify_changes");
    f.engine.approvals.decide(check.id, "allow", check.fingerprint);
    const run = await f.wait(r);
    assert.equal(run.state, "completed", JSON.stringify(run));
    assert.equal(readFileSync(join(f.root, "verified"), "utf8"), "verified");
    assert.equal(
      f.engine.getVerificationState(f.session.id, r.runId)!.receipts[0]!.status,
      "pass",
    );
    assert.equal(
      f.engine.inspectCodeMode(f.workspace.id)[0]!.calls[0]!.approval?.id,
      check.id,
    );
  },
);
test(
  "actual step/result caps and shared absolute native Tool budget cannot be reset by the program",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    for (const [code, error] of [
      [
        program([
          {
            op: "repeat",
            count: 64,
            index: "i",
            body: [
              {
                op: "repeat",
                count: 64,
                index: "j",
                body: [{ op: "let", name: "x", value: literal(true) }],
              },
            ],
          },
        ]),
        "CODE_MODE_STEP_LIMIT",
      ],
      [
        program([{ op: "return", value: literal("x".repeat(9000)) }]),
        "CODE_MODE_RESULT_LIMIT",
      ],
    ] as const) {
      const r = await f.submit(code);
      await f.allow(r);
      await f.wait(r);
      const row = f.engine
        .inspectCodeMode(f.workspace.id)
        .find((x) => x.source.runId === r.runId)!;
      assert.equal(row.state, "failed");
      assert.equal(row.errorCode, error);
      assert.equal(row.outcome?.cleanupConfirmed, true);
    }
    f.config.limits.maxToolCalls = 2;
    const p = f.engine.previewCodeModeGrant({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        config: f.config,
      }),
      g = f.engine.readCodeModeGrant(p);
    f.engine.approveCodeModeGrant({
      preview: p,
      fingerprint: g.sha256,
      approved: true,
    });
    const r = await f.submit(
      program([
        call("one", "read_file", { path: "seed" }),
        call("two", "list_files", { path: "." }),
        { op: "return", value: literal(true) },
      ]),
    );
    await f.allow(r);
    await f.wait(r);
    const row = f.engine
      .inspectCodeMode(f.workspace.id)
      .find((x) => x.source.runId === r.runId)!;
    assert.equal(row.calls.length, 1);
    assert.equal(row.state, "failed");
    assert.equal(row.pendingCall, null);
    assert.equal(
      f.engine.store
        .getSnapshot(f.session.id)
        .tools.filter((t) => t.runId === r.runId).length,
      2,
    );
  },
);
