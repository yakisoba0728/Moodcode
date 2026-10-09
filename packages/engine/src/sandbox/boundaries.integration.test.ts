import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fixture, quote, until } from "./fixtures/engine.js";
import { groupExists } from "../tools/command/process-control.js";
const darwin = { skip: process.platform !== "darwin", timeout: 45000 };
test(
  "exact native command approval denied leaves no sandbox command receipt or process",
  darwin,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const x = await f.execute("printf forbidden > denied", "deny");
    assert.equal(existsSync(join(f.root, "denied")), false);
    assert.equal(
      f.engine
        .observeEnforcement(f.workspace.id)
        .filter((r) => r.kind === "command").length,
      0,
    );
    assert.equal(
      f.engine.store.getToolCall(x.approval.toolCallId).state,
      "denied",
    );
  },
);
test(
  "file source replacement after actual approval preparation cannot spawn",
  darwin,
  async (t) => {
    const f = await fixture(t);
    const script = join(f.root, "source.mjs");
    writeFileSync(script, "require('fs').writeFileSync('effect','before')");
    await f.grant([script], [f.root]);
    const r = await f.submit(`${quote(process.execPath)} ${quote(script)}`),
      a = await f.approval(r);
    renameSync(script, script + ".old");
    writeFileSync(script, "require('fs').writeFileSync('effect','after')");
    f.engine.approvals.decide(a.id, "allow", a.fingerprint);
    await f.wait(r);
    assert.equal(existsSync(join(f.root, "effect")), false);
    assert.equal(
      f.engine
        .observeEnforcement(f.workspace.id)
        .filter((r) => r.kind === "command").length,
      0,
    );
  },
);
test(
  "actual effect cancellation settles native checkpoint and proves owned process group absence",
  darwin,
  async (t) => {
    const f = await fixture(t);
    const script = join(f.root, "held.mjs");
    writeFileSync(
      script,
      "import{writeFileSync,renameSync}from'node:fs';writeFileSync('held.pid.tmp',String(process.pid));renameSync('held.pid.tmp','held.pid');setInterval(()=>{},20);",
    );
    await f.grant();
    const r = await f.submit(`${quote(process.execPath)} ${quote(script)}`),
      a = await f.approval(r);
    f.engine.approvals.decide(a.id, "allow", a.fingerprint);
    await until(
      () => existsSync(join(f.root, "held.pid")),
      "owned process absent",
    );
    const pid = Number(readFileSync(join(f.root, "held.pid"), "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "owned process PID must be a positive safe integer");
    await f.dispatch("run.cancel", { runId: r.runId });
    await f.wait(r);
    assert.throws(() => process.kill(pid, 0));
    assert.equal(
      groupExists(
        f.engine
          .observeEnforcement(f.workspace.id)
          .find((r) => r.kind === "command")!.groupPid!,
      ),
      false,
    );
    const e = f.engine
      .observeEnforcement(f.workspace.id)
      .find((r) => r.kind === "command")!;
    assert.equal(e.state, "closed");
    assert.equal((e.completion!.outcome as any).cancelled, true);
    assert.equal((e.completion!.outcome as any).cleanupConfirmed, true);
  },
);
test(
  "timeout and Engine.close retain original sandbox ownership until actual group cleanup",
  darwin,
  async (t) => {
    const f = await fixture(t);
    const script = join(f.root, "timeout.mjs");
    writeFileSync(
      script,
      "import{writeFileSync}from'node:fs';writeFileSync('timeout.pid',String(process.pid));setInterval(()=>{},20);",
    );
    await f.grant();
    await f.execute(
      `${quote(process.execPath)} ${quote(script)}`,
      "allow",
      200,
    );
    const pid = Number(readFileSync(join(f.root, "timeout.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0));
    let e = f.engine
      .observeEnforcement(f.workspace.id)
      .find((r) => r.kind === "command")!;
    assert.equal((e.completion!.outcome as any).timedOut, true);
    const r = await f.submit(`${quote(process.execPath)} ${quote(script)}`),
      a = await f.approval(r);
    f.engine.approvals.decide(a.id, "allow", a.fingerprint);
    await until(
      () =>
        f.engine
          .observeEnforcement(f.workspace.id)
          .filter((x) => x.kind === "command" && x.state === "running")
          .length === 1,
      "close running",
    );
    const running = f.engine
      .observeEnforcement(f.workspace.id)
      .find((x) => x.kind === "command" && x.state === "running")!;
    await f.engine.close();
    assert.equal(groupExists(running.groupPid!), false);
  },
);
test(
  "closed receipt persistent SQL fault preserves actual partial effects and uncertain native ownership",
  darwin,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TRIGGER sandbox_closed_fault BEFORE UPDATE ON session_documents WHEN NEW.kind LIKE 'sandbox.record.%' AND json_extract(NEW.data,'$.kind')='command' AND json_extract(NEW.data,'$.state') IN ('closed','uncertain') BEGIN SELECT RAISE(ABORT,'closed receipt fault'); END",
    );
    const x = await f.execute("printf preserved > partial-native-gap");
    assert.equal(
      readFileSync(join(f.root, "partial-native-gap"), "utf8"),
      "preserved",
    );
    assert.equal(x.run.error?.code, "CLEANUP_UNCERTAIN");
    assert.equal(
      f.engine
        .observeEnforcement(f.workspace.id)
        .find((r) => r.kind === "command")!.state,
      "running",
    );
    db.exec("DROP TRIGGER sandbox_closed_fault");
    db.close();
    await f.reopen();
    assert.equal(
      f.engine
        .observeEnforcement(f.workspace.id)
        .find((r) => r.kind === "command")!.state,
      "uncertain",
    );
  },
);
test(
  "independent host command uses the same real supervisor with approved sandbox restriction and exact native result",
  darwin,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const p = await f.engine.previewHostCommand({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        command: `printf partial > host-partial; cat ${quote(join(f.outside, "secret"))}`,
        limits: { maxDurationMs: 4000, maxOutputBytes: 65536 },
      }),
      proof = f.engine.readHostCommandPreview(p);
    assert.equal(proof.sandbox!.backend, "darwin-seatbelt-v1");
    const a = await f.engine.startHostCommand({
      workspaceId: f.workspace.id,
      requestId: "sandbox-host-command",
      preview: p,
      fingerprint: proof.fingerprint,
      approved: true,
    });
    const r = await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: a.jobId,
    });
    assert.equal(r.state, "failed");
    assert.equal(r.completion!.outcome.cleanupConfirmed, true);
    assert.equal(readFileSync(join(f.root, "host-partial"), "utf8"), "partial");
    assert.match(
      readFileSync(r.completion!.stderr.path, "utf8"),
      /Operation not permitted/,
    );
    assert.equal(groupExists(r.pid!), false);
  },
);
