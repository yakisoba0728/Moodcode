import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { jobFixture } from "./job.js";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export async function lifetimeFixture(t: TestContext) {
  const f = await jobFixture(t, {
    createTerminal: false,
    engine: { hostCommands: true, commandLifetimes: true },
  });
  const marker = join(f.root, "lifetime.pid"),
    script = join(f.root, "lifetime.mjs");
  writeFileSync(
    script,
    `import{writeFileSync,renameSync}from'node:fs';writeFileSync(${JSON.stringify(marker + ".pending")},String(process.pid));renameSync(${JSON.stringify(marker + ".pending")},${JSON.stringify(marker)});process.stdout.write('READY:'+process.pid+'\\n');process.stdin.on('data',b=>process.stdout.write('ECHO:'+b));process.stdin.on('end',()=>process.stdout.write('EOF\\n'));`,
  );
  const preview = await f.engine.previewCommandLifetime({
    workspaceId: f.workspace.id,
    sessionId: f.session.id,
    command: `exec ${quote(process.execPath)} ${quote(script)}`,
    mode: "foreground",
    limits: { maxDurationMs: 10000, maxOutputBytes: 65536 },
  });
  const start = async (approved = true) =>
    f.engine.startCommandLifetime({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview,
      fingerprint: f.engine.readCommandLifetimePreview(preview).fingerprint,
      approved,
    });
  const transfer = (jobId: string, mode: "foreground" | "background") => {
    const original = f.engine.previewCommandLifetimeTransfer({
      workspaceId: f.workspace.id,
      jobId,
      mode,
    });
    return f.engine.transferCommandLifetime({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview: original,
      fingerprint: f.engine.readCommandLifetimeTransfer(original).fingerprint,
      approved: true,
    });
  };
  const input = async (jobId: string, data: string, eof = false) => {
    const original = f.engine.previewCommandLifetimeInput({
      workspaceId: f.workspace.id,
      jobId,
      data,
      eof,
    });
    return f.engine.writeCommandLifetimeInput({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview: original,
      fingerprint:
        f.engine.readCommandLifetimeInputPreview(original).fingerprint,
      approved: true,
    });
  };
  const sql = () => new DatabaseSync(f.dbPath, { readOnly: true });
  return { ...f, marker, preview, start, transfer, input, sql };
}
