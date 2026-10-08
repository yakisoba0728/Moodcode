import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture } from "./fixtures/engine.js";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
test(
  "genuine complete code-mode archive pauses immutable history and grants no runtime or automatic provider replay",
  { skip: process.platform !== "darwin", timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    const receipt = await f.submit();
    await f.allow(receipt);
    assert.equal((await f.wait(receipt)).state, "completed");
    const before = f.engine.inspectCodeMode(f.workspace.id)[0]!;
    await f.engine.close();
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "archive"),
    });
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "imported"),
    });
    let providerCalls = 0;
    const engine = createEngine({
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      codeMode: true,
      providers: [
        {
          id: f.config.providerId,
          async *streamTurn() {
            providerCalls++;
            yield { type: "finish", reason: "stop" };
          },
        },
      ],
      defaults: f.config,
    });
    t.after(() => engine.close());
    const row = engine.inspectCodeMode(f.workspace.id)[0]!;
    assert.equal(row.state, "paused-import");
    assert.equal(row.source.sha256, before.source.sha256);
    assert.deepEqual(row.outcome, before.outcome);
    assert.equal(row.result, before.result);
    assert.equal(providerCalls, 0);
    assert.throws(
      () =>
        engine.previewCodeModeGrant({
          workspaceId: f.workspace.id,
          sessionId: f.session.id,
          config: f.config,
        }),
      { code: "CODE_MODE_RUNTIME_REQUIRED" },
    );
    engine.store.createCodeModeStorage().inspect(f.workspace.id);
    await assert.rejects(async () =>
      engine.approveCodeModeGrant({
        preview: {},
        fingerprint: before.sha256,
        approved: true,
      }),
    );
  },
);
