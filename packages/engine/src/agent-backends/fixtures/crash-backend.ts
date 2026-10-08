import type { TestContext } from "node:test";
import { backendFixture, backendUntil } from "./backend.js";

// This process owns a genuine Engine and remains alive until the parent kills it.
const cleanups: (() => unknown)[] = [];
const lifecycle = {
  after(callback: () => unknown) {
    cleanups.push(callback);
  },
} as TestContext;
try {
  const f = await backendFixture(lifecycle, { mode: "hold" });
  f.register();
  const { runId } = await f.submit();
  await backendUntil(
    () =>
      f.logs().some((row) => row.message?.method === "session/prompt") &&
      f.engine.inspectAgentBackendRequests(f.workspace.id)[0]?.state ===
        "dispatched",
    "Actual remote prompt was not dispatched",
  );
  const connection = f.engine.inspectAgentBackendConnections(
    f.workspace.id,
  )[0]!;
  process.send?.({
    type: "ready",
    base: f.base,
    root: f.root,
    dbPath: f.dbPath,
    artifactDir: f.artifactDir,
    logPath: f.logPath,
    workspaceId: f.workspace.id,
    sessionId: f.session.id,
    runId,
    peerPid: connection.proof.processId,
  });
} catch (error) {
  process.send?.({
    type: "failed",
    message: error instanceof Error ? error.message : "Fixture startup failed",
  });
  for (const cleanup of cleanups.reverse()) await cleanup();
  process.exitCode = 1;
  process.disconnect?.();
}
