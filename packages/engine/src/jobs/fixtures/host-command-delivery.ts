import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { jobFixture, jobCommand, jobUntil } from "./job.js";
export async function hostDeliveryFixture(
  t: TestContext,
  options: { exitCode?: number; hold?: boolean } = {},
) {
  const f = await jobFixture(t, {
      createTerminal: false,
      engine: { hostCommands: true, commandJobModelTools: true },
    }),
    marker = join(f.root, "inbox-host.pid"),
    release = join(f.root, "inbox-host.release"),
    script = join(f.root, "inbox-host.mjs");
  writeFileSync(
    script,
    `import{writeFileSync,existsSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));process.stdout.write('HOST_INBOX 한글🙂\\n');${options.hold ? `let timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(${options.exitCode ?? 0});}},10);` : `process.exitCode=${options.exitCode ?? 0};`}`,
  );
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const original = await f.engine.previewHostCommand({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      command: quote(process.execPath) + " " + quote(script),
      limits: { maxDurationMs: 10000, maxOutputBytes: 1048576 },
    }),
    started = await f.engine.startHostCommand({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview: original,
      fingerprint: f.engine.readHostCommandPreview(original).fingerprint,
      approved: true,
    });
  await jobUntil(() => existsSync(marker), "Genuine host process not observed");
  const pid = Number(readFileSync(marker, "utf8"));
  async function complete() {
    if (options.hold) writeFileSync(release, "continue");
    const result = await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    await jobUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, "Actual completed independent host PID was not reaped");
    return result;
  }
  function capture() {
    return f.engine.captureHostCommandJobDeliveryTarget({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
      config: f.config,
    });
  }
  function deliver(target: object, requestId = randomUUID()) {
    return f.engine.deliverHostCommandJobResult({
      workspaceId: f.workspace.id,
      requestId,
      expectedRevision: 0,
      target,
      approved: true,
    });
  }
  function counts() {
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    try {
      return Object.fromEntries(
        ["runs", "tools", "provider_attempts", "session_inputs"]
          .map((table) => [
            table,
            Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
          ])
          .concat(
            ["host.command.delivery.*", "host.command.input.*"].map((kind) => [
              kind,
              Number(
                db
                  .prepare(
                    "SELECT count(*) n FROM session_documents WHERE kind GLOB ?",
                  )
                  .get(kind)!.n,
              ),
            ]),
          ),
      );
    } finally {
      db.close();
    }
  }
  await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
  return {
    ...f,
    marker,
    release,
    script,
    started,
    pid,
    complete,
    capture,
    deliver,
    counts,
  };
}
