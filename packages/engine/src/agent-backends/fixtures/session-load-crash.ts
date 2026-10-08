import type { TestContext } from "node:test";
import { backendUntil } from "./backend.js";
import { sessionLoadFixture } from "./session-load.js";

// The parent kills this genuine Root after durable replay, before load closure.
const f = await sessionLoadFixture(
  { after() {} } as unknown as TestContext,
  "hold-load",
);
void f.submitLoad();
await backendUntil(
  () =>
    f.engine
      .inspectAgentBackendConnections(f.workspace.id)
      .some(
        (r) =>
          r.backendId === f.alias && r.sessionLoad?.replayHashes.length === 3,
      ),
  "Original load replay did not reach its committed crash boundary",
);
const loaded = f.engine
  .inspectAgentBackendConnections(f.workspace.id)
  .find((r) => r.backendId === f.alias)!;
process.send?.({
  base: f.base,
  root: f.root,
  dbPath: f.dbPath,
  artifactDir: f.artifactDir,
  configuration: f.configuration,
  workspaceId: f.workspace.id,
  sessionId: f.session.id,
  alias: f.alias,
  connectionId: loaded.connectionId,
  processId: loaded.proof.processId,
  replaySha: loaded.sha256,
  logPath: f.logPath,
});
await new Promise<void>(() => {});
