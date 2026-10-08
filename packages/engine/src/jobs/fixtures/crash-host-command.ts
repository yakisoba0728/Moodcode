import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createEngine } from "../../engine.js";
import type { HostCommandStorage } from "../host-command-records.js";

const options = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  dbPath: string;
  artifactDir: string;
  workspaceId: string;
  sessionId: string;
  command: string;
  phase: string;
  ready: string;
};
const engine = createEngine({
  dbPath: options.dbPath,
  artifactDir: options.artifactDir,
  hostCommands: true,
  providers: [],
});
const service = Reflect.get(engine, "hostCommands") as {
  native: HostCommandStorage;
};
const storage = Reflect.get(service, "native") as HostCommandStorage;
const append = storage.append.bind(storage);
function stop(phase: string): void {
  writeFileSync(
    `${options.ready}.tmp`,
    JSON.stringify({ phase, pid: process.pid }),
  );
  renameSync(`${options.ready}.tmp`, options.ready);
  process.kill(process.pid, "SIGSTOP");
}
if (options.phase === "before-approval-commit") {
  const ports = Reflect.get(storage, "ports") as {
    appendEvent: (...args: unknown[]) => void;
  };
  const original = ports.appendEvent;
  ports.appendEvent = (...args) => {
    Reflect.apply(original, ports, args);
    if (args[1] === "host.command.approval") stop(options.phase);
  };
} else
  storage.append = (body) => {
    const record = append(body);
    if (body.kind === options.phase) stop(options.phase);
    return record;
  };
const preview = await engine.previewHostCommand({
  workspaceId: options.workspaceId,
  sessionId: options.sessionId,
  command: options.command,
  limits: { maxDurationMs: 15000, maxOutputBytes: 1048576 },
});
const result = await engine.startHostCommand({
  workspaceId: options.workspaceId,
  requestId: `crash-host-${options.phase}`,
  preview,
  fingerprint: engine.readHostCommandPreview(preview).fingerprint,
  approved: true,
});
await engine.waitForHostCommand({
  workspaceId: options.workspaceId,
  jobId: result.jobId,
});
throw Error("Genuine host boundary was not reached");
