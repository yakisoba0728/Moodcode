import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, writeFileSync, writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteTerminalJournal } from "../journal.js";
import { TerminalService } from "../service.js";
import type { TerminalOwner } from "../types.js";

export function processPresent(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
export async function jobGroupUntil(check: () => boolean, detail: string) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    assert.ok(performance.now() < deadline, detail);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}
export function jobGroupProcessInfo(pids: number[], field: string) {
  return childProcess.execFileSync("/bin/ps", ["-o", field.split(",").map(name => `${name}=`).join(","), "-p", pids.join(",")], {
    encoding: "utf8", timeout: 1000, maxBuffer: 4096,
  }).trim();
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function stoppedJobGroupFixture(t: TestContext, label: string) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "moodcode-pty-owned-groups-")));
  const root = join(base, "workspace"), dbPath = join(base, "terminal.sqlite");
  mkdirSync(root, { mode: 0o700 });
  const controlPath = join(base, "release"), readyPath = join(base, "child-ready");
  const control = openSync(controlPath, "wx+", 0o600);
  writeSync(control, Buffer.from([0]), 0, 1, 0);
  const originalControl = fstatSync(control, { bigint: true });
  const originalBase = lstatSync(base, { bigint: true });
  const release = () => {
    const descriptor = fstatSync(control, { bigint: true });
    const named = lstatSync(controlPath, { bigint: true });
    const parent = lstatSync(base, { bigint: true });
    for (const item of [descriptor, named]) {
      assert.equal(item.dev, originalControl.dev);
      assert.equal(item.ino, originalControl.ino);
      assert.equal(item.uid, BigInt(process.getuid!()));
      assert.ok(item.isFile() && item.nlink === 1n && (item.mode & 0o077n) === 0n);
    }
    assert.ok(parent.isDirectory() && parent.dev === originalBase.dev && parent.ino === originalBase.ino);
    assert.equal(parent.uid, BigInt(process.getuid!()));
    assert.equal(parent.mode & 0o077n, 0n);
    writeSync(control, Buffer.from([1]), 0, 1, 0);
  };
  const script = join(root, "background.mjs");
  writeFileSync(script, `import{openSync,readSync,closeSync,writeFileSync,renameSync}from'node:fs';
const fd=openSync(${JSON.stringify(controlPath)},'r'),byte=Buffer.alloc(1);
writeFileSync(${JSON.stringify(readyPath + ".tmp")},String(process.pid),{flag:'wx',mode:0o600});
renameSync(${JSON.stringify(readyPath + ".tmp")},${JSON.stringify(readyPath)});
const timer=setInterval(()=>{readSync(fd,byte,0,1,0);if(byte[0]===1){clearInterval(timer);closeSync(fd);process.exit(0);}},10);
`, { mode: 0o600 });
  const owner: TerminalOwner = { authority: "user", workspaceId: `${label}-workspace`, sessionId: `${label}-session` };
  const journal = new SqliteTerminalJournal(dbPath);
  const service = new TerminalService({ resolveOwner: input => ({ ...input, root }), maxDurationMs: 15_000, journal });
  let terminalId: string | undefined, supervisor: ChildProcess | undefined;
  let closing: Promise<void> | undefined;
  const pids: number[] = [], supervisorEvents: Record<string, unknown>[] = [];
  const save = (phase: string, error?: unknown) => {
    const evidence = {
      schemaVersion: 1, kind: "actual-pty-job-group-owned-fixture", phase, label,
      noLive: true, dbPath, journalVersion: 1,
      native: terminalId ? journal.read(terminalId) : null,
      originalObservedPids: pids, supervisorEvents,
      source: { path: fileURLToPath(import.meta.url), sha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex") },
      controlIdentity: { device: originalControl.dev.toString(), inode: originalControl.ino.toString(), uid: originalControl.uid.toString() },
      ...(error ? { error: String(error).slice(0, 4096) } : {}),
    };
    const raw = JSON.stringify(evidence, null, 2) + "\n";
    assert.ok(Buffer.byteLength(raw) <= 524288, "Native fixture evidence exceeded its finite bound");
    writeFileSync(join(base, `${phase}.json`), raw, { mode: 0o600 });
  };
  const close = () => closing ??= (async () => {
    let failed = false, firstError: unknown;
    const remember = (error: unknown) => {
      if (!failed) { failed = true; firstError = error; }
    };
    try {
      try { save("before-close"); } catch (error) { remember(error); }
      try { await service.close(); } catch (error) { remember(error); }
      try { release(); } catch (error) { remember(error); }
      try {
        await jobGroupUntil(() => pids.every(pid => !processPresent(pid)), "Original PTY jobs exited after owned close/private release");
      } catch (error) { remember(error); }
      try { save(failed ? "close-failure" : "after-close", firstError); }
      catch (error) { remember(error); }
    } finally {
      try { closeSync(control); } catch (error) { remember(error); }
      try { journal.close(); } catch (error) { remember(error); }
      try { t.diagnostic(`Retained actual PTY fixture/journal: ${base}`); }
      catch (error) { remember(error); }
    }
    if (failed) throw firstError;
  })();
  t.after(close);
  const originalFork = childProcess.fork;
  childProcess.fork = ((...args: Parameters<typeof childProcess.fork>) => {
    const child = Reflect.apply(originalFork, childProcess, args) as ChildProcess;
    if (/[/\\]terminals[/\\]supervisor\.(ts|js)$/.test(String(args[0]))) {
      assert.equal(supervisor, undefined);
      supervisor = child;
      for (const event of ["exit", "close"] as const) child.once(event, (code, signal) => {
        assert.ok(supervisorEvents.length < 16);
        supervisorEvents.push({ event, code, signal });
      });
      child.once("disconnect", () => supervisorEvents.push({ event: "disconnect" }));
    }
    return child;
  }) as typeof childProcess.fork;
  syncBuiltinESMExports();
  try {
    const terminal = await service.create({ owner, file: "/bin/zsh", args: ["-f", "-i", "-c",
      `${quote(process.execPath)} ${quote(script)} & child=$!; while [[ ! -f ${quote(readyPath)} ]]; do sleep .01; done; printf "PIDS:%s:%s\\n" "$$" "$child"; kill -STOP $$; wait`,
    ] });
    terminalId = terminal.id;
  } finally { childProcess.fork = originalFork; syncBuiltinESMExports(); }
  await jobGroupUntil(() => {
    const text = service.replay(terminalId!, owner).output.map(event => event.data).join("");
    const match = /PIDS:(\d+):(\d+)/.exec(text);
    if (match) pids.splice(0, pids.length, Number(match[1]), Number(match[2]));
    return pids.length === 2;
  }, "Original shell and separate background job became ready");
  await jobGroupUntil(() => jobGroupProcessInfo([pids[0]!], "stat").includes("T"), "Original shell stopped itself before hangup relay");
  assert.ok(supervisor);
  return {
    base, dbPath, service, owner, terminalId: terminalId!, close,
    observedPids: () => [...pids],
    killSupervisor: () => {
      assert.equal(supervisor!.exitCode, null);
      assert.equal(supervisor!.signalCode, null);
      assert.equal(supervisor!.kill("SIGKILL"), true);
    },
    readJournal: () => {
      const reopened = new SqliteTerminalJournal(dbPath);
      try { return reopened.read(terminalId!); }
      finally { reopened.close(); }
    },
  };
}
