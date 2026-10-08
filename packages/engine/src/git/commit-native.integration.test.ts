import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { knowledgeHash } from "../knowledge/validation.js";
import { commitFixture } from "./fixtures/commit.js";
import {
  gitCommitDocumentKind,
  validateGitCommitDatabase,
} from "./commit-receipts.js";
import { gitSha } from "./types.js";
test(
  "actual independently anchored Git source and physical outcome reject self-consistent native aliases, PID erasure and caps",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t),
      original = await f.preview(),
      input = f.input(original);
    const settled = await f.engine.commitReviewedChanges(original, input);
    assert.equal(settled.receipt.state, "committed");
    const db = new DatabaseSync(f.dbPath);
    t.after(() => db.close());
    const kind = gitCommitDocumentKind(input.requestId);
    for (const mutation of [
      (r: any) => {
        r.outcome.groupPid = null;
      },
      (r: any) => {
        r.preview.ownerEpoch = "1".repeat(64);
        const { sha256, ...p } = r.preview;
        r.preview.sha256 = knowledgeHash(p);
      },
      (r: any) => {
        r.outcome.cleanupConfirmed = false;
        r.state = "uncertain";
      },
      (r: any) => {
        r.outcome.stdout = "x".repeat(140000);
      },
    ]) {
      db.exec("SAVEPOINT independent_native_probe");
      try {
        const r = JSON.parse(
          String(
            db
              .prepare(
                "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
              )
              .get(f.session.id, kind)!.data,
          ),
        );
        mutation(r);
        const { sha256, ...body } = r;
        r.sha256 = knowledgeHash(body);
        const raw = JSON.stringify(r);
        db.prepare(
          "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
        ).run(raw, f.session.id, kind);
        db.prepare(
          "UPDATE session_events SET data=json_set(data,'$.payload.sha256',?) WHERE session_id=? AND type='session.document.updated' AND json_extract(data,'$.payload.kind')=? AND json_extract(data,'$.payload.revision')=?",
        ).run(gitSha(raw), f.session.id, kind, r.revision);
        db.prepare(
          "UPDATE session_events SET data=json_set(data,'$.payload.record',json(?)) WHERE session_id=? AND type='git.commit.transition' AND json_extract(data,'$.payload.id')=? AND json_extract(data,'$.payload.record.revision')=?",
        ).run(raw, f.session.id, r.id, r.revision);
        assert.throws(() => validateGitCommitDatabase(db));
      } finally {
        db.exec(
          "ROLLBACK TO independent_native_probe; RELEASE independent_native_probe",
        );
      }
    }
    validateGitCommitDatabase(db);
    const originalRaw = String(
        db
          .prepare(
            "SELECT data FROM session_documents WHERE session_id=? AND kind=?",
          )
          .get(f.session.id, kind)!.data,
      ),
      changed = JSON.parse(originalRaw);
    changed.outcome.groupPid = null;
    const { sha256: _oldSha, ...changedBody } = changed;
    changed.sha256 = knowledgeHash(changedBody);
    db.prepare(
      "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
    ).run(JSON.stringify(changed), f.session.id, kind);
    try {
      assert.throws(() =>
        f.engine.getGitCommitReceipt(
          f.workspace.id,
          f.session.id,
          input.requestId,
        ),
      );
      assert.throws(() => f.engine.inspectGitCommitReceipts(f.workspace.id));
    } finally {
      db.prepare(
        "UPDATE session_documents SET data=? WHERE session_id=? AND kind=?",
      ).run(originalRaw, f.session.id, kind);
    }
    validateGitCommitDatabase(db);
  },
);
test(
  "working-tree commit refuses an overlapping actual user stage while preserving its exact index",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await commitFixture(t);
    await assert.rejects(
      f.preview(undefined, "working-tree"),
      (e: unknown) =>
        (e as { code: string }).code === "GIT_COMMIT_STAGED_SELECTION_CONFLICT",
    );
    assert.equal(f.engine.inspectGitCommitReceipts(f.workspace.id).length, 0);
  },
);
