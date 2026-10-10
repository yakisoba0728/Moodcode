import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { fixture, quote, until } from "./fixtures/engine.js";
import { sandboxSign, sandboxRecordKind } from "./types.js";
const darwin = { skip: process.platform !== "darwin", timeout: 45000 };
test(
  "genuine Engine command uses exact approved kernel sandbox and native Tool/Part/checkpoint",
  darwin,
  async (t) => {
    const f = await fixture(t);
    const g = await f.grant();
    assert.equal(g.record.grant.backend.fileIsolation, true);
    assert.equal(g.record.grant.backend.networkIsolation, true);
    const x = await f.execute("cat seed; printf kernel > actual");
    assert.equal(x.run.state, "completed");
    assert.equal(readFileSync(join(f.root, "actual"), "utf8"), "kernel");
    const records = f.engine.observeEnforcement(f.workspace.id),
      r = records.find((r) => r.kind === "command")!;
    assert.equal(r.state, "closed");
    assert.ok(r.groupPid);
    assert.equal((r.completion!.outcome as any).cleanupConfirmed, true);
    assert.equal(
      f.engine.store.getToolCall(x.approval.toolCallId).state,
      "completed",
    );
    assert.ok(
      f.engine.store
        .listCheckpoints(x.run.id)
        .some((c) => c.id === r.completion!.checkpointId),
    );
    f.engine.store.validateSandboxes();
  },
);
test(
  "outside file read/write, symlink target and descendants are kernel denied; partial local effect preserved",
  darwin,
  async (t) => {
    const f = await fixture(t);
    symlinkSync(f.outside, join(f.root, "escape"));
    await f.grant();
    const x = await f.execute(
      `printf partial > before-denial; /bin/sh -c ${quote(`cat ${quote(join(f.root, "escape", "secret"))}; printf forbidden > ${quote(join(f.outside, "written"))}`)}`,
    );
    assert.equal(
      readFileSync(join(f.root, "before-denial"), "utf8"),
      "partial",
    );
    assert.equal(existsSync(join(f.outside, "written")), false);
    const tool = f.engine.store.getToolCall(x.approval.toolCallId);
    assert.match(tool.output!, /Operation not permitted/);
    const r = f.engine
      .observeEnforcement(f.workspace.id)
      .find((r) => r.kind === "command")!;
    assert.equal(f.engine.store.listCheckpoints(x.run.id).length, 1);
    assert.notEqual((r.completion!.outcome as any).exitCode, 0);
    assert.equal((r.completion!.outcome as any).cleanupConfirmed, true);
  },
);
test(
  "workspace Git control paths stay readable but kernel deny sandboxed writes",
  darwin,
  async (t) => {
    const f = await fixture(t);
    const git = join(f.root, ".git"),
      config = readFileSync(join(git, "config"), "utf8");
    await f.grant();
    const x = await f.execute(
      [
        "cat .git/config",
        "printf allowed > .git/sandbox-probe",
        "mkdir .git/hooks",
        "printf hook > .git/hooks/pre-commit",
        `printf '[filter "x"]' >> .git/config`,
        "printf '[core]' >> .git/config.worktree",
        "printf ../planted > .git/commondir",
        "mkdir .git/info .git/modules",
        "mv .git moved-git",
        "printf kept > after-git",
      ].join("; "),
    );
    assert.equal(existsSync(join(f.root, "moved-git")), false);
    assert.equal(readFileSync(join(git, "config"), "utf8"), config);
    for (const p of [
      "config.worktree",
      "hooks",
      "commondir",
      "info",
      "modules",
    ])
      assert.equal(existsSync(join(git, p)), false, p);
    assert.equal(readFileSync(join(git, "sandbox-probe"), "utf8"), "allowed");
    assert.equal(readFileSync(join(f.root, "after-git"), "utf8"), "kept");
    const output = f.engine.store.getToolCall(x.approval.toolCallId).output!;
    assert.match(output, /repositoryformatversion/);
    assert.match(output, /Operation not permitted/);
  },
);
test(
  "actual local network blocked for effect and child process without unsandboxed retry",
  darwin,
  async (t) => {
    const f = await fixture(t);
    let connected = 0;
    const s = createServer((_req, res) => {
      connected++;
      res.end("forbidden");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    t.after(() => new Promise<void>((r) => s.close(() => r())));
    const port = (s.address() as { port: number }).port;
    await f.grant();
    const x = await f.execute(
      `${quote(process.execPath)} -e ${quote(`require('child_process').execFileSync('/usr/bin/curl',['--silent','--max-time','1','http://127.0.0.1:${port}'],{stdio:'inherit'})`)}`,
    );
    assert.equal(connected, 0);
    assert.notEqual(
      (
        f.engine
          .observeEnforcement(f.workspace.id)
          .find((r) => r.kind === "command")!.completion!.outcome as any
      ).exitCode,
      0,
    );
    assert.ok(x.run.state === "completed" || x.run.state === "failed");
  },
);
test(
  "grant Original, denial and exact fresh widened reapproval; old approval becomes stale",
  darwin,
  async (t) => {
    const f = await fixture(t);
    const a = join(f.root, "allowed"),
      b = join(f.root, "blocked");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "a"), "A");
    writeFileSync(join(b, "b"), "B");
    await f.grant([a], [a]);
    const denied = await f.execute(`cat ${quote(join(b, "b"))}`);
    assert.match(
      f.engine.store.getToolCall(denied.approval.toolCallId).output!,
      /Operation not permitted/,
    );
    const p = await f.engine.previewSandboxGrant({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        config: f.config,
        readPaths: [a, b],
        writePaths: [a],
        network: "deny",
      }),
      g = f.engine.readSandboxGrant(p);
    await assert.rejects(
      f.engine.approveSandboxGrant({
        workspaceId: f.workspace.id,
        requestId: "copied",
        expectedRevision: 0,
        preview: { ...p },
        fingerprint: g.sha256,
        approved: true,
      }),
    );
    await assert.rejects(
      f.engine.approveSandboxGrant({
        workspaceId: f.workspace.id,
        requestId: "denied",
        expectedRevision: 0,
        preview: p,
        fingerprint: g.sha256,
        approved: false,
      }),
    );
    await f.engine.approveSandboxGrant({
      workspaceId: f.workspace.id,
      requestId: "widened",
      expectedRevision: 0,
      preview: p,
      fingerprint: g.sha256,
      approved: true,
    });
    const x = await f.execute(`cat ${quote(join(b, "b"))}`);
    assert.match(
      f.engine.store.getToolCall(x.approval.toolCallId).output!,
      /B/,
    );
  },
);
test(
  "actual native receipt insertion fault prevents spawn, generic rehashed document tamper fails independent anchors",
  darwin,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const db = new DatabaseSync(f.dbPath);
    db.exec(
      "CREATE TRIGGER sandbox_fault BEFORE INSERT ON session_documents WHEN NEW.kind LIKE 'sandbox.record.%' AND json_extract(NEW.data,'$.kind')='command' BEGIN SELECT RAISE(ABORT,'receipt fault'); END",
    );
    const x = await f.execute("printf forbidden > no-spawn");
    assert.equal(existsSync(join(f.root, "no-spawn")), false);
    assert.equal(x.run.state, "completed");
    db.exec("DROP TRIGGER sandbox_fault");
    await f.execute("printf allowed > normal");
    const r = f.engine
      .observeEnforcement(f.workspace.id)
      .find((r) => r.kind === "command")!;
    const { sha256: _sha, ...body } = r;
    const changed = sandboxSign({ ...body, groupPid: r.groupPid! + 100 });
    f.engine.store.putSessionDocument(
      r.sessionId,
      sandboxRecordKind(r.id),
      r.revision,
      changed as any,
    );
    assert.throws(() => f.engine.observeEnforcement(f.workspace.id));
    db.close();
  },
);
test(
  "reopen does not reconstruct a live grant or replay any command",
  darwin,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    await f.execute("printf original > once");
    const before = f.calls.length;
    await f.reopen();
    assert.ok(
      f.engine
        .observeEnforcement(f.workspace.id)
        .some((r) => r.kind === "command"),
    );
    const r = await f.submit("printf replay > never");
    await f.wait(r);
    assert.equal(existsSync(join(f.root, "never")), false);
    assert.equal(f.calls.length, before + 2);
  },
);
