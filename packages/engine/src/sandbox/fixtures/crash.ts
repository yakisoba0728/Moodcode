import { createEngine } from "../../engine.js";
import type { ProviderAdapter } from "../../ports.js";
import type { RunConfig, RunReceipt } from "@moodcode/contracts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
const args = JSON.parse(process.argv[2]!) as {
  dbPath: string;
  artifactDir: string;
  root: string;
  workspaceId: string;
  sessionId: string;
  config: RunConfig;
  mode: "command" | "mcp";
  script: string;
};
const provider: ProviderAdapter = {
  id: args.config.providerId,
  async *streamTurn() {
    yield {
      type: "tool.call",
      call: {
        id: "crash-effect",
        name: "run_command",
        input: { command: `'${process.execPath}' '${args.script}'` },
      },
    };
    yield { type: "finish", reason: "tool_calls" };
  },
};
const engine = createEngine({
  dbPath: args.dbPath,
  artifactDir: args.artifactDir,
  defaults: args.config,
  providers: [provider],
  osSandbox: true,
  jobs: true,
});
await engine.registerSandboxBackend();
const p = await engine.previewSandboxGrant({
  workspaceId: args.workspaceId,
  sessionId: args.sessionId,
  config: args.config,
  readPaths: [args.root],
  writePaths: [args.root],
  network: "deny",
});
await engine.approveSandboxGrant({
  workspaceId: args.workspaceId,
  requestId: "worker-actual-grant",
  expectedRevision: 0,
  preview: p,
  fingerprint: engine.readSandboxGrant(p).sha256,
  approved: true,
});
if (args.mode === "command") {
  const response = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: "run.submit",
    payload: {
      sessionId: args.sessionId,
      requestId: randomUUID(),
      prompt: "genuine crash command",
      config: args.config as any,
    },
  });
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  const receipt = response.result as unknown as RunReceipt;
  while (
    !engine.store
      .getSnapshot(args.sessionId)
      .approvals.some(
        (a) => a.runId === receipt.runId && a.status === "pending",
      )
  )
    await new Promise((r) => setTimeout(r, 3));
  const a = engine.store
    .getSnapshot(args.sessionId)
    .approvals.find(
      (a) => a.runId === receipt.runId && a.status === "pending",
    )!;
  engine.approvals.decide(a.id, "allow", a.fingerprint);
  while (
    !engine
      .observeEnforcement(args.workspaceId)
      .some((r) => r.kind === "command" && r.groupPid)
  )
    await new Promise((r) => setTimeout(r, 3));
  const r = engine
    .observeEnforcement(args.workspaceId)
    .find((r) => r.kind === "command")!;
  process.stdout.write(JSON.stringify({ pid: r.groupPid, id: r.id }) + "\n");
} else {
  await engine.connectSandboxedMcp({
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    id: "crash_stdio",
    command: process.execPath,
    args: [args.script],
    sourceFiles: [args.script],
  });
  const r = engine
    .observeEnforcement(args.workspaceId)
    .find((r) => r.kind === "mcp")!;
  process.stdout.write(JSON.stringify({ pid: r.groupPid, id: r.id }) + "\n");
}
setInterval(() => {}, 1000);
