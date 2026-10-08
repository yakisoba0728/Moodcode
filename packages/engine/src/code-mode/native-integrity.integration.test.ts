import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, program, literal, call } from "./fixtures/engine.js";
import { CodeModeStorage, codeModeRecordKind } from "./records.js";
import { codeSign } from "./types.js";
import { OwnedCodeModeProcess } from "./process.js";
import { createHash } from "node:crypto";
const actual = { skip: process.platform !== "darwin", timeout: 45000 };
test(
  "original source/approval SQL admission failure starts zero isolated processes",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    let starts = 0;
    const start = OwnedCodeModeProcess.prototype.start;
    OwnedCodeModeProcess.prototype.start = function (...args) {
      starts++;
      return Reflect.apply(start, this, args);
    };
    t.after(() => {
      OwnedCodeModeProcess.prototype.start = start;
    });
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    db.exec(
      "CREATE TRIGGER fail_code_source BEFORE INSERT ON session_documents WHEN NEW.kind GLOB 'code.mode.*' BEGIN SELECT RAISE(ABORT,'source fault'); END",
    );
    const r = await f.submit();
    await f.allow(r);
    await f.wait(r);
    assert.equal(starts, 0);
    assert.equal(f.engine.inspectCodeMode(f.workspace.id).length, 0);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type GLOB 'code.mode.*'",
          )
          .get()!.n,
      ),
      0,
    );
  },
);
test(
  "actual nested call intent COMMIT fault prevents command dispatch and preserves known joined runtime",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    db.exec(
      `CREATE TRIGGER fail_code_call BEFORE UPDATE ON session_documents WHEN NEW.kind GLOB 'code.mode.*' AND json_extract(NEW.data,'$.pendingCall') IS NOT NULL BEGIN SELECT RAISE(ABORT,'call intent fault'); END`,
    );
    const r = await f.submit(
      program([
        call("write", "run_command", { command: "printf invalid > fault" }),
        { op: "return", value: literal(true) },
      ]),
    );
    await f.allow(r);
    await f.wait(r);
    assert.equal(existsSync(join(f.root, "fault")), false);
    assert.equal(
      f.engine.store
        .getSnapshot(f.session.id)
        .tools.filter((x) => x.name === "run_command").length,
      0,
    );
    const record = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(record.outcome?.cleanupConfirmed, true);
    assert.equal(record.state, "failed");
  },
);
test(
  "actual process admission journal fault joins actual isolated PID and preserves uncertain native history",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    let pid = 0;
    const start = OwnedCodeModeProcess.prototype.start;
    OwnedCodeModeProcess.prototype.start = async function (...args) {
      const proof = await Reflect.apply(start, this, args);
      pid = proof.processId;
      return proof;
    };
    t.after(() => {
      OwnedCodeModeProcess.prototype.start = start;
    });
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    db.exec(
      "CREATE TRIGGER fail_code_pid BEFORE INSERT ON session_events WHEN NEW.type='code.mode.process_admitted' BEGIN SELECT RAISE(ABORT,'process fault'); END",
    );
    const r = await f.submit();
    await f.allow(r);
    const run = await f.wait(r);
    assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0));
    assert.equal(
      f.engine.inspectCodeMode(f.workspace.id)[0]!.state,
      "uncertain",
    );
  },
);
test(
  "generic CAS and fully rehashed PID/outcome/result cannot contradict independent native record/process/closed anchors",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const r = await f.submit();
    await f.allow(r);
    assert.equal((await f.wait(r)).state, "completed");
    const original = f.engine.inspectCodeMode(f.workspace.id)[0]!,
      db = Reflect.get(f.engine.store, "db") as DatabaseSync;
    const kind = codeModeRecordKind(original.id);
    for (const changes of [
      { result: "forged" },
      { process: {} },
      { state: "uncertain" },
    ]) {
      db.exec("BEGIN");
      try {
        const { sha256, ...body } = original;
        let c: any = changes;
        if (c.process) {
          const { sha256, ...p } = original.process!;
          c = { process: codeSign({ ...p, processId: p.processId + 1 }) };
        }
        const forged = codeSign({ ...body, ...c });
        const raw = JSON.stringify(forged),
          digest = createHash("sha256").update(raw).digest("hex");
        db.prepare(
          "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
        ).run(raw, f.session.id, kind);
        const head = db
          .prepare(
            "SELECT seq,data FROM session_events WHERE session_id=? AND type='session.document.updated' AND instr(data,?)>0 ORDER BY seq DESC LIMIT 1",
          )
          .get(f.session.id, kind)!;
        const event = JSON.parse(String(head.data));
        event.payload.sha256 = digest;
        db.prepare(
          "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
        ).run(JSON.stringify(event), f.session.id, head.seq!);
        assert.throws(() => f.engine.inspectCodeMode(f.workspace.id));
      } finally {
        db.exec("ROLLBACK");
      }
    }
    assert.equal(
      f.engine.inspectCodeMode(f.workspace.id)[0]!.sha256,
      original.sha256,
    );
    assert.throws(() =>
      f.engine.store
        .createCodeModeStorage()
        .put({}, original, original.revision),
    );
  },
);
test(
  "native outer Part is committed once before failed final receipt CAS; uncertainty never creates a duplicate result",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const original = CodeModeStorage.prototype.put;
    CodeModeStorage.prototype.put = function (owner, record, revision) {
      if (record.state === "completed")
        throw new Error("actual final receipt fault");
      return Reflect.apply(original, this, [owner, record, revision]);
    };
    t.after(() => {
      CodeModeStorage.prototype.put = original;
    });
    const r = await f.submit();
    await f.allow(r);
    const run = await f.wait(r);
    assert.equal(run.error?.code, "CLEANUP_UNCERTAIN");
    const row = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(row.state, "uncertain");
    assert.equal(row.outcome?.cleanupConfirmed, true);
    const tool = f.engine.store.getSnapshot(f.session.id).tools[0]!;
    assert.equal(tool.state, "completed");
    const db = Reflect.get(f.engine.store, "db") as DatabaseSync;
    const parts = db
      .prepare(
        "SELECT data FROM message_parts WHERE run_id=? AND instr(data,?)>0",
      )
      .all(r.runId, tool.id)
      .map((p) => JSON.parse(String(p.data)))
      .filter((p) => p.type === "tool" && p.toolCallId === tool.id);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].state, "completed");
    assert.equal(f.requests.length, 1);
  },
);
test(
  "actual physical workspace source replacement after approval preparation starts zero runtimes",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const r = await f.submit(),
      approval = await f.approval(r);
    const { renameSync, mkdirSync } = await import("node:fs");
    renameSync(f.root, f.root + "-old");
    mkdirSync(f.root);
    let starts = 0;
    const start = OwnedCodeModeProcess.prototype.start;
    OwnedCodeModeProcess.prototype.start = function (...args) {
      starts++;
      return Reflect.apply(start, this, args);
    };
    t.after(() => {
      OwnedCodeModeProcess.prototype.start = start;
    });
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    await f.wait(r);
    assert.equal(starts, 0);
    assert.deepEqual(f.engine.inspectCodeMode(f.workspace.id), []);
  },
);
test(
  "copied Root Flight and accessor record cannot invoke data getters or acquire an execution grant",
  actual,
  async (t) => {
    const f = await fixture(t);
    let hits = 0;
    const record = {
      get source() {
        hits++;
        throw new Error("getter invoked");
      },
    };
    const host = Reflect.get(f.engine, "codeModeHost");
    assert.throws(() => host.assertRecordOwner({}, record, 0), {
      code: "CODE_MODE_ORIGINAL_REQUIRED",
    });
    assert.equal(hits, 0);
    assert.throws(
      () => f.engine.store.createCodeModeStorage().put({}, record as any, 0),
      { code: "CODE_MODE_ORIGINAL_REQUIRED" },
    );
    assert.equal(hits, 0);
  },
);
