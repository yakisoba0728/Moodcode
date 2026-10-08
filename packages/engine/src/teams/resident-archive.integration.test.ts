import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { residentFixture, residentUntil } from "./fixtures/resident.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { createEngine } from "../engine.js";
import { failure } from "./fixtures/engine-team.js";
test("actual resident multi-Run child/ACK history archives with authentic child SQL and imports paused without live actor or wake", async (t) => {
  const f = await residentFixture(t);
  const receipt = f.deliver("archive-resident").invoke();
  await residentUntil(
    () =>
      f.engine.inspectResidentChildTask(f.session.id, f.task.id)?.state ===
      "idle",
    "actual child completion",
  );
  await f.engine.stopResidentChildTask(f.session.id, f.task.id);
  f.parentRelease.resolve();
  await f.engine.waitForRun(f.parent.runId);
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
  const calls = f.requests.length;
  for (const enabled of [false, true]) {
    const engine = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      teams: enabled,
      teamModelTools: enabled,
      residentTeams: enabled,
    });
    f.engines.add(engine);
    const history = engine.inspectResidentChildTask(f.session.id, f.task.id)!;
    assert.equal(history.state, "paused-import");
    assert.equal(history.runs.length, 2);
    assert.equal(
      engine.getTeamDelivery(f.workspace.id, receipt.record.id)?.receipt?.input
        .runId,
      receipt.receipt!.input.runId,
    );
    assert.throws(
      () => engine.children.describeTeamOwner(f.session.id, f.task.id),
      failure("TEAM_OWNER_UNAVAILABLE"),
    );
    assert.equal(f.requests.length, calls);
    await engine.close();
  }
});
