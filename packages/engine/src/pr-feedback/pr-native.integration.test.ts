import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EngineError } from "@moodcode/contracts";
import { createHash } from "node:crypto";
import { prFixture } from "./fixtures/pr.js";
import {
  prInputKind,
  prOccurrenceKind,
  prWatchKind,
  validatePrFeedbackDatabase,
} from "./records.js";
import { prSign } from "./types.js";
const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
  timeout: 20000,
};
const rawSha = (s: string) => createHash("sha256").update(s).digest("hex");
function savepoint(db: DatabaseSync, op: () => void) {
  db.exec("SAVEPOINT native_probe");
  try {
    op();
    assert.throws(() => validatePrFeedbackDatabase(db), EngineError);
  } finally {
    db.exec("ROLLBACK TO native_probe");
    db.exec("RELEASE native_probe");
  }
  validatePrFeedbackDatabase(db);
}
test(
  "native receipt rejects removed link, alias input and appended media despite valid mutable input JSON",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const r = await f.engine.pollPrWatch(f.pollInput()),
      db = Reflect.get(f.engine.store, "db") as DatabaseSync,
      input = f.engine.store.getInput(r.occurrence!.accepted!.inputId);
    savepoint(db, () =>
      db
        .prepare("DELETE FROM session_documents WHERE session_id=? AND kind=?")
        .run(f.session.id, prInputKind(input.id)),
    );
    savepoint(db, () => {
      const body = { ...input, documents: [] };
      db.prepare("UPDATE session_inputs SET data=? WHERE id=?").run(
        JSON.stringify(body),
        input.id,
      );
    });
    savepoint(db, () => {
      db.prepare(
        "UPDATE session_inputs SET request_id=?,data=? WHERE id=?",
      ).run(
        "ordinary-alias",
        JSON.stringify({ ...input, requestId: "ordinary-alias" }),
        input.id,
      );
    });
  },
);
test(
  "rehashed repair counter/latest document/transition cannot erase actual accepted allocation",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const r = await f.engine.pollPrWatch(f.pollInput()),
      db = Reflect.get(f.engine.store, "db") as DatabaseSync;
    savepoint(db, () => {
      const changed = prSign({ ...r.watch, repairInputs: 0 }),
        raw = JSON.stringify(changed);
      db.prepare(
        "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
      ).run(raw, f.session.id, prWatchKind("watch"));
      const update = db
        .prepare(
          "SELECT seq,data FROM session_events WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=?",
        )
        .get(f.session.id, prWatchKind("watch"), r.watch.revision)!;
      const u = JSON.parse(String(update.data));
      u.payload.sha256 = rawSha(raw);
      db.prepare(
        "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
      ).run(JSON.stringify(u), f.session.id, update.seq!);
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
    });
  },
);
test(
  "actual source verification Tool cleanup/approval proof tampering cannot grant repair from a reloaded watcher",
  posix,
  async (t) => {
    const f = await prFixture(t);
    f.engine.store.setSessionPaused(f.session.id, true, "user");
    await f.register();
    const db = Reflect.get(f.engine.store, "db") as DatabaseSync;
    savepoint(db, () => {
      db.prepare(
        "UPDATE approvals SET status='denied',data=json_set(data,'$.status','denied') WHERE run_id=?",
      ).run(f.sourceRun.id);
    });
    savepoint(db, () => {
      db.prepare(
        "UPDATE events SET data=json_set(data,'$.payload.cleanupConfirmed',0) WHERE run_id=? AND type='tool.completed'",
      ).run(f.sourceRun.id);
    });
  },
);
test(
  "metadata bounds reject oversized records before parsing and unknown reserved namespaces",
  posix,
  async (t) => {
    const f = await prFixture(t);
    await f.register();
    const db = Reflect.get(f.engine.store, "db") as DatabaseSync;
    savepoint(db, () =>
      db
        .prepare(
          "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
        )
        .run("x".repeat(131073), f.session.id, prWatchKind("watch")),
    );
    savepoint(db, () =>
      f.engine.store.putSessionDocument(f.session.id, "pr.unknown", 0, {
        authority: "none",
      }),
    );
  },
);
