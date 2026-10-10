import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { JsonObject, Session } from "@moodcode/contracts";
import { fixture } from "./fixtures/engine.js";
import {
  sandboxSign,
  sandboxRecordKind,
  sandboxSha,
  SANDBOX_LIMITS,
  type SandboxRecord,
} from "./types.js";
import { validateSandboxDatabase, type SandboxRecordPorts } from "./records.js";
const actual = { skip: process.platform !== "darwin", timeout: 45000 };
test(
  "genuine completed checkpoint drift is rejected before sandbox history can claim its outcome",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    await f.execute("printf native > checkpoint-effect");
    const row = f.engine
      .observeEnforcement(f.workspace.id)
      .find((r) => r.kind === "command")!;
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    const old = db
      .prepare("SELECT data FROM checkpoints WHERE id=?")
      .get(String(row.completion!.checkpointId))!.data;
    const changed = JSON.parse(String(old));
    changed.incomplete = !changed.incomplete;
    db.prepare("UPDATE checkpoints SET data=? WHERE id=?").run(
      JSON.stringify(changed),
      String(row.completion!.checkpointId),
    );
    assert.throws(() => f.engine.observeEnforcement(f.workspace.id), {
      code: "SANDBOX_COMPLETION_INVALID",
    });
    db.prepare("UPDATE checkpoints SET data=? WHERE id=?").run(
      old!,
      String(row.completion!.checkpointId),
    );
    f.engine.store.validateSandboxes();
  },
);
test(
  "fully rehashed sandbox completion cannot contradict independent actual owned command closure",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    await f.execute("printf original > completion");
    const row = f.engine
        .observeEnforcement(f.workspace.id)
        .find((r) => r.kind === "command")!,
      kind = sandboxRecordKind(row.id);
    const forged = sandboxSign({
      ...row,
      completion: {
        ...row.completion,
        outcome: { ...(row.completion!.outcome as object), exitCode: 97 },
      },
    });
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
      ).run(JSON.stringify(forged), row.sessionId, kind);
      const h = db
        .prepare(
          "SELECT seq,data FROM session_events WHERE session_id=? AND type='sandbox.record' AND json_extract(data,'$.payload.record.id')=? AND json_extract(data,'$.payload.record.revision')=?",
        )
        .get(row.sessionId, row.id, row.revision)!;
      const event = JSON.parse(String(h.data));
      event.payload.record = forged;
      db.prepare(
        "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
      ).run(JSON.stringify(event), row.sessionId, h.seq!);
      const u = db
        .prepare(
          "SELECT seq,data FROM session_events WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=?",
        )
        .get(row.sessionId, kind, row.revision)!;
      const update = JSON.parse(String(u.data));
      update.payload.sha256 = sandboxSha(JSON.stringify(forged));
      db.prepare(
        "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
      ).run(JSON.stringify(update), row.sessionId, u.seq!);
      assert.throws(() => validateSandboxDatabase(db), {
        code: "SANDBOX_COMPLETION_INVALID",
      });
    } finally {
      db.exec("ROLLBACK");
    }
    f.engine.store.validateSandboxes();
  },
);
test(
  "native metadata caps reject oversized rows and fresh grant DTO/accessors cannot issue authority",
  actual,
  async (t) => {
    const f = await fixture(t);
    const approved = await f.grant();
    let traps = 0;
    const input = {
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      config: f.config,
      readPaths: [f.root],
      writePaths: [f.root],
      get network() {
        traps++;
        return "deny" as const;
      },
    };
    await assert.rejects(f.engine.previewSandboxGrant(input));
    await assert.rejects(
      f.engine.previewSandboxGrant(
        new Proxy(input, {
          get() {
            traps++;
            throw new Error("trap");
          },
        }),
      ),
    );
    assert.equal(traps, 0);
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
      ).run(
        JSON.stringify({ ...approved.record, padding: "x".repeat(131072) }),
        approved.record.sessionId,
        sandboxRecordKind(approved.record.id),
      );
      assert.throws(() => validateSandboxDatabase(db), {
        code: "SANDBOX_LIMIT",
      });
    } finally {
      db.exec("ROLLBACK");
    }
    f.engine.store.validateSandboxes();
  },
);
test(
  "widening requires idle physical ownership and fresh approval, and strips arbitrary host environment",
  actual,
  async (t) => {
    const f = await fixture(t);
    mkdirSync(join(f.root, "narrow"));
    await f.grant([join(f.root, "narrow")], [join(f.root, "narrow")]);
    const r = await f.submit("printf forbidden > widening-effect"),
      a = await f.approval(r);
    await assert.rejects(f.grant(), { code: "WORKSPACE_BUSY" });
    f.engine.approvals.decide(a.id, "allow", a.fingerprint);
    await f.wait(r);
    assert.equal(existsSync(join(f.root, "widening-effect")), false);
    assert.equal(
      f.engine
        .observeEnforcement(f.workspace.id)
        .filter((r) => r.kind === "command").length,
      1,
    );
    await f.grant();
    const prior = process.env.ORDINARY_HOST_SECRET;
    process.env.ORDINARY_HOST_SECRET = "host-only-fixture-sentinel";
    try {
      await f.execute('printf "%s" "$ORDINARY_HOST_SECRET" > env-effect');
      assert.equal(readFileSync(join(f.root, "env-effect"), "utf8"), "");
    } finally {
      if (prior === undefined) delete process.env.ORDINARY_HOST_SECRET;
      else process.env.ORDINARY_HOST_SECRET = prior;
    }
  },
);

test(
  "broad workspace mount still kernel denies engine DB, WAL and artifact files inside that workspace",
  actual,
  async (t) => {
    const f = await fixture(t, {}, true);
    await f.grant();
    const protectedPaths = [
      f.dbPath,
      f.dbPath + "-wal",
      f.dbPath + ".owner.sqlite",
    ].filter(existsSync);
    assert.ok(protectedPaths.length >= 2);
    const r = await f.execute(
      protectedPaths.map((p) => `cat '${p}' >/dev/null`).join("; ") +
        `; printf preserved > safe-effect; printf corrupt >> '${f.dbPath}'`,
    );
    assert.equal(
      readFileSync(join(f.root, "safe-effect"), "utf8"),
      "preserved",
    );
    assert.match(
      f.engine.store.getToolCall(r.approval.toolCallId).output!,
      /Operation not permitted/,
    );
    assert.equal(
      (
        f.engine
          .observeEnforcement(f.workspace.id)
          .find((r) => r.kind === "command")!.completion!.outcome as any
      ).cleanupConfirmed,
      true,
    );
    f.engine.store.validateSandboxes();
  },
);

test(
  "standalone opt-in remains enforced without jobs and duplicate archived grant history issues no new grant",
  actual,
  async (t) => {
    const f = await fixture(t, { jobs: false });
    const first = await f.grant([f.root], [f.root], "stable-grant");
    await f.execute("printf once > standalone");
    const before = f.engine.observeEnforcement(f.workspace.id);
    assert.equal(before.filter((r) => r.kind === "command").length, 1);
    await f.reopen();
    const duplicate = await f.engine.approveSandboxGrant({
      workspaceId: f.workspace.id,
      requestId: "stable-grant",
      expectedRevision: 0,
      preview: {},
      fingerprint: first.record.grant.sha256,
      approved: true,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.sha256, first.record.sha256);
    const r = await f.submit("printf forbidden > no-grant-replay");
    await f.wait(r);
    assert.equal(existsSync(join(f.root, "no-grant-replay")), false);
    assert.equal(f.engine.getSandboxCapability(), undefined);
    assert.equal(
      f.engine.observeEnforcement(f.workspace.id).length,
      before.length,
    );
  },
);

test(
  "late host lifecycle registration is denied without invoking callback or provider outside OS scope",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    let callbacks = 0;
    const hook = {
      id: "late-host-effect",
      revision: 1,
      stages: ["model-context"] as const,
      callback() {
        callbacks++;
        writeFileSync(join(f.root, "unsafe-callback"), "forbidden");
      },
    };
    assert.throws(() => f.engine.registerLifecycleHook(hook), {
      code: "SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED",
    });
    f.engine.lifecycleHooks.register(hook);
    const r = await f.submit("printf forbidden > callback-bypass");
    assert.equal(
      (await f.wait(r)).error?.code,
      "SANDBOX_EXTERNAL_EFFECT_UNSUPPORTED",
    );
    assert.equal(callbacks, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(join(f.root, "unsafe-callback")), false);
    assert.equal(existsSync(join(f.root, "callback-bypass")), false);
  },
);

test(
  "full sandbox store admits commands by pruning the oldest closed chains only",
  actual,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    await f.execute("printf first > first-effect");
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    const storage = f.engine.store.createSandboxStorage(),
      ports = Reflect.get(storage, "ports") as SandboxRecordPorts,
      rows = f.engine.observeEnforcement(f.workspace.id),
      grant = rows.find((r) => r.kind === "grant")!,
      first = rows.find((r) => r.kind === "command")!,
      anchors = (id: string) =>
        Number(
          db
            .prepare(
              "SELECT count(*) n FROM session_events WHERE type='sandbox.record' AND json_extract(data,'$.payload.record.id')=?",
            )
            .get(id)!.n,
        ),
      [starting, running, closed] = db
        .prepare(
          "SELECT data FROM session_events WHERE type='sandbox.record' AND json_extract(data,'$.payload.record.id')=? ORDER BY seq",
        )
        .all(first.id)
        .map((e) => JSON.parse(String(e.data)).payload.record as SandboxRecord);
    const chain = (id: string, revisions: SandboxRecord[], minutes: number) => {
      const at = new Date(
        Date.parse(first.updatedAt) - minutes * 60000,
      ).toISOString();
      let previousSha256: string | null = null;
      return revisions.map((r) => {
        const { sha256: _sha, ...body } = r;
        const next = sandboxSign({
          ...body,
          id,
          previousSha256,
          createdAt: at,
          updatedAt: at,
        });
        previousSha256 = next.sha256;
        return next;
      });
    };
    const grantIn = (sessionId: string, id: string) => {
      const { sha256: _sha, ...body } = grant;
      return sandboxSign({
        ...body,
        id,
        requestId: id,
        sessionId,
        grant: sandboxSign({
          ...grant.grant,
          sessionId,
          target: { ...grant.grant.target, sessionId },
        }),
      });
    };
    const uncertain = chain(
        "seed-uncertain",
        [starting!, { ...starting!, revision: 2, state: "uncertain" }],
        60,
      ),
      older = chain("seed-closed", [starting!, running!, closed!], 30),
      seeded: SandboxRecord[] = [...uncertain, ...older];
    for (let i = rows.length + 2; i < SANDBOX_LIMITS.records; i++) {
      const session = await f.dispatch<Session>("session.create", {
        workspaceId: f.workspace.id,
      });
      seeded.push(grantIn(session.id, `seed-grant-${i}`));
    }
    ports.writeTx(() => {
      for (const r of seeded) {
        ports.writeDocument(
          r.sessionId,
          sandboxRecordKind(r.id),
          r.revision - 1,
          r as unknown as JsonObject,
        );
        ports.appendEvent(
          r.sessionId,
          "sandbox.record",
          { record: r as unknown as JsonObject },
          r.kind === "command"
            ? {
                runId: String(r.owner!.runId),
                turnId: String(r.owner!.turnId),
                attemptId: String(r.owner!.attemptId),
              }
            : undefined,
        );
      }
    });
    assert.equal(
      f.engine.observeEnforcement(f.workspace.id).length,
      SANDBOX_LIMITS.records,
    );
    await f.execute("printf second > second-effect");
    assert.equal(readFileSync(join(f.root, "second-effect"), "utf8"), "second");
    const after = f.engine.observeEnforcement(f.workspace.id),
      second = after.find(
        (r) =>
          r.kind === "command" &&
          r.id !== first.id &&
          r.id.startsWith("sandbox-command-"),
      )!;
    assert.equal(after.length, SANDBOX_LIMITS.records);
    assert.equal(second.state, "closed");
    assert.equal(
      after.some((r) => r.id === "seed-closed"),
      false,
    );
    assert.equal(anchors("seed-closed"), 0);
    assert.equal(after.find((r) => r.id === first.id)?.state, "closed");
    assert.equal(
      after.find((r) => r.id === "seed-uncertain")?.state,
      "uncertain",
    );
    f.engine.store.validateSandboxes();
    for (const id of ["extra-0", "extra-1"])
      storage.write(grantIn(f.session.id, id), 0);
    assert.equal(anchors(first.id), 0);
    assert.equal(anchors(second.id), 0);
    assert.throws(() => storage.write(grantIn(f.session.id, "extra-2"), 0), {
      code: "SANDBOX_LIMIT",
    });
    const kept = f.engine.observeEnforcement(f.workspace.id);
    assert.equal(kept.length, SANDBOX_LIMITS.records);
    assert.deepEqual(
      kept.filter((r) => r.kind !== "grant").map((r) => [r.id, r.state]),
      [["seed-uncertain", "uncertain"]],
    );
    f.engine.store.validateSandboxes();
  },
);
