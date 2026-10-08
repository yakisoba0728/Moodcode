import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { fixture } from "./fixtures/engine.js";
const darwin = { skip: process.platform !== "darwin", timeout: 45000 };
test(
  "actual archive import preserves signed sandbox history paused and cannot restore execution grant",
  darwin,
  async (t) => {
    const f = await fixture(t);
    await f.grant();
    await f.execute("printf native > archive-effect");
    const old = f.engine.observeEnforcement(f.workspace.id),
      sourceRows = old.map((x) => x.sha256);
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
    const engine = createEngine({
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      osSandbox: true,
      defaults: f.config,
      providers: [
        {
          id: f.config.providerId,
          async *streamTurn() {
            yield { type: "finish", reason: "stop" };
          },
        },
      ],
    });
    t.after(() => engine.close());
    const rows = engine.observeEnforcement(f.workspace.id);
    assert.equal(rows.length, old.length);
    assert.ok(rows.every((r) => r.state === "paused-import"));
    assert.ok(rows.every((r, i) => r.previousSha256 === sourceRows[i]));
    assert.equal(engine.getSandboxCapability(), undefined);
    const current = rows.find((r) => r.kind === "command")!;
    assert.equal((current.completion!.outcome as any).cleanupConfirmed, true);
    engine.store.validateSandboxes();
    await assert.rejects(
      engine.previewSandboxGrant({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        config: f.config,
        readPaths: [f.root],
        writePaths: [f.root],
        network: "deny",
      }),
    );
    assert.equal(existsSync(join(f.root, "unexpected")), false);
  },
);
