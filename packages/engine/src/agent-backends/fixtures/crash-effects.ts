import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { approvedEffect, decideEffect } from "./effects.js";
import { backendUntil } from "./backend.js";
import type { AgentBackendStorage } from "../store.js";
const cleanups: (() => unknown)[] = [];
const t = {
  after: (fn: () => unknown) => cleanups.push(fn),
} as unknown as TestContext;
try {
  const mode = process.argv[2] ?? "terminal-hold",
    f = await approvedEffect(t, mode);
  const ready = () => {
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
      runId: f.runId,
      peerPid: connection.proof.processId,
      commandPid: existsSync(join(f.root, "command-pid"))
        ? Number(readFileSync(join(f.root, "command-pid"), "utf8"))
        : null,
    });
  };
  if (mode === "direct-write") {
    const native = Reflect.get(
        f.engine,
        "backendRecords",
      ) as AgentBackendStorage,
      original = native.settleClientRead.bind(native);
    native.settleClientRead = (...args) => {
      ready();
      process.kill(process.pid, "SIGSTOP");
      return original(...args);
    };
    await decideEffect(f);
  } else {
    await decideEffect(f);
    await backendUntil(
      () =>
        existsSync(join(f.root, "command-pid")) &&
        f
          .logs()
          .some((v) => v.message?.id === "create" && Boolean(v.message.result)),
      "Actual command and wire acknowledgement missing",
    );
    ready();
  }
} catch (error) {
  process.send?.({
    type: "failed",
    message: error instanceof Error ? error.stack : "fixture failed",
  });
  for (const fn of cleanups.reverse()) await fn();
  process.exitCode = 1;
  process.disconnect?.();
}
