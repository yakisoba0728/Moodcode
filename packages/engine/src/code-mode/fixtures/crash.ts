import { createEngine } from "../../engine.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { until, program, call, literal } from "./engine.js";
const p = JSON.parse(process.argv[2]!),
  seen = new Set<string>();
const engine = createEngine({
  dbPath: p.dbPath,
  artifactDir: p.artifactDir,
  defaults: p.config,
  codeMode: true,
  jobs: true,
  providers: [
    {
      id: p.config.providerId,
      async *streamTurn(req) {
        if (seen.has(req.runId)) {
          yield { type: "finish", reason: "stop" };
          return;
        }
        seen.add(req.runId);
        yield {
          type: "tool.call",
          call: {
            id: "crash-code",
            name: "execute_code",
            input: {
              source: program([
                call("sleep", "run_command", {
                  command:
                    "printf once > crash-effect; printf %s $$ > crash-pid; sleep 30",
                }),
                { op: "return", value: literal(true) },
              ]),
              allocation: {
                maxSteps: 100,
                maxNestedCalls: 1,
                maxResultBytes: 1024,
                maxDurationMs: 7000,
              },
            },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      },
    },
  ],
});
await engine.registerCodeModeHost();
const original = engine.previewCodeModeGrant({
    workspaceId: p.workspaceId,
    sessionId: p.sessionId,
    config: p.config,
  }),
  g = engine.readCodeModeGrant(original);
engine.approveCodeModeGrant({
  preview: original,
  fingerprint: g.sha256,
  approved: true,
});
const response = await engine.dispatch({
  schemaVersion: 1,
  commandId: randomUUID(),
  type: "run.submit",
  payload: {
    sessionId: p.sessionId,
    requestId: randomUUID(),
    prompt: "crash actual code owner",
    config: p.config,
  },
});
if (!response.ok) throw new Error(JSON.stringify(response.error));
const receipt = response.result as any;
for (let i = 0; i < 2; i++) {
  await until(
    () =>
      engine.store
        .getSnapshot(p.sessionId)
        .approvals.some(
          (a) => a.runId === receipt.runId && a.status === "pending",
        ),
    "crash approval",
  );
  const a = engine.store
    .getSnapshot(p.sessionId)
    .approvals.find(
      (a) => a.runId === receipt.runId && a.status === "pending",
    )!;
  engine.approvals.decide(a.id, "allow", a.fingerprint);
}
await until(
  () =>
    existsSync(join(p.root, "crash-pid")) &&
    /^\d+$/.test(readFileSync(join(p.root, "crash-pid"), "utf8")),
  "actual crash process",
);
const row = engine.inspectCodeMode(p.workspaceId)[0]!;
process.stdout.write(
  JSON.stringify({
    runtimePid: row.process!.processId,
    commandPid: Number(readFileSync(join(p.root, "crash-pid"), "utf8")),
    runId: receipt.runId,
    id: row.id,
  }) + "\n",
);
await new Promise(() => {});
