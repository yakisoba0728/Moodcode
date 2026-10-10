import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createEngine } from "../engine.js";
import { jobFixture, jobUntil } from "../jobs/fixtures/job.js";
import {
  PTY_DIAGNOSTIC_LIMITS,
  validatePtyDiagnostics,
} from "./diagnostics.js";
import { MemoryTerminalJournal, SqliteTerminalJournal } from "./journal.js";
import { TerminalService } from "./service.js";
import type { PtyDiagnostics, TerminalOwner } from "./types.js";

const posix = {
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
};
const owner: TerminalOwner = {
  authority: "user",
  workspaceId: "actual_workspace",
  sessionId: "actual_session",
};
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;
function checked(data: PtyDiagnostics | undefined): PtyDiagnostics {
  assert.ok(data);
  assert.deepEqual(validatePtyDiagnostics(data), data);
  assert.ok(
    Buffer.byteLength(JSON.stringify(data)) <= PTY_DIAGNOSTIC_LIMITS.bytes,
  );
  assert.equal(data.authority, "observation-only");
  for (const key of [
    "args",
    "env",
    "cwd",
    "file",
    "command",
    "output",
    "credentials",
  ])
    assert.equal(JSON.stringify(data).includes(`"${key}":`), false);
  return data;
}
function absent(pid: number): boolean {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
function serviceFixture(t: TestContext) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "moodcode-pty-diagnostics-")),
  );
  const service = new TerminalService({
    resolveOwner: (input) => ({ ...input, root }),
    maxDurationMs: 15_000,
  });
  t.after(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    service,
    text: (id: string) =>
      service
        .replay(id, owner)
        .output.map((item) => item.data)
        .join(""),
  };
}
function originalSupervisor(
  t: TestContext,
  intercept?: (message: Record<string, unknown>) => void,
) {
  const originalFork = childProcess.fork;
  const captured: ChildProcess[] = [];
  childProcess.fork = ((...args: Parameters<typeof childProcess.fork>) => {
    const child = Reflect.apply(
      originalFork,
      childProcess,
      args,
    ) as ChildProcess;
    if (/[/\\]terminals[/\\]supervisor\.(ts|js)$/.test(String(args[0]))) {
      captured.push(child);
      if (intercept)
        child.on("message", (message) => {
          if (message && typeof message === "object")
            intercept(message as Record<string, unknown>);
        });
    }
    return child;
  }) as typeof childProcess.fork;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.fork = originalFork;
    syncBuiltinESMExports();
  });
  return captured;
}

test(
  "actual Engine PTY native exit and backend close remain inspectable and persisted history grants no restored source",
  posix,
  async (t) => {
    const f = await jobFixture(t, { createTerminal: false });
    const terminal = await f.engine.terminals.create({
      owner: f.owner,
      file: "/bin/sh",
      args: [
        "-c",
        'test -t 0 || exit 9; printf "NATIVE_PID:%s\\n" "$$"; read first; stty size; read second; printf "REPLY:%s:%s\\n" "$first" "$second"',
      ],
      cols: 80,
      rows: 24,
    });
    await jobUntil(
      () => /NATIVE_PID:\d+/.test(f.text(terminal.id)),
      "Actual native PTY readiness",
    );
    const pid = Number(/NATIVE_PID:(\d+)/.exec(f.text(terminal.id))![1]);
    assert.ok(pid > 1);
    await f.engine.terminals.resize(terminal.id, f.owner, 100, 40);
    await f.engine.terminals.write(terminal.id, f.owner, "one\rtwo\r");
    await jobUntil(
      () => f.engine.terminals.get(terminal.id, f.owner).state !== "running",
      "Actual native PTY normal close",
    );
    const replay = f.engine.terminals.replay(terminal.id, f.owner),
      data = checked(replay.terminal.diagnostics);
    assert.equal(replay.terminal.state, "completed");
    assert.equal(replay.terminal.cleanupConfirmed, true);
    assert.match(f.text(terminal.id), /40 100/);
    assert.match(f.text(terminal.id), /REPLY:one:two/);
    assert.equal(data.source.terminalPid, pid);
    assert.ok(data.source.supervisorPid! > 1);
    assert.equal(data.nativeExit.observed, true);
    assert.equal(data.nativeExit.exitCode, 0);
    assert.ok(data.nativeExit.signal === 0 || data.nativeExit.signal === null);
    assert.deepEqual(data.supervisorExit, {
      observed: true,
      closeObserved: true,
      exitCode: 0,
      signal: null,
    });
    assert.equal(data.outcome.reason, replay.terminal.reason ?? null);
    const probe = data.events.find((event) => event.kind === "group-probe");
    assert.equal(probe?.groupPid, pid);
    if (probe?.presence === "absent") {
      assert.equal(data.source.originalGroupPid, null);
      assert.equal(data.cleanup.groupSnapshot, "not-requested");
    }
    assert.equal(absent(pid), true);
    assert.equal(f.providerCalls.length, 0);
    await f.engine.close();
    const reopened = createEngine(f.configuration);
    f.engines.add(reopened);
    assert.deepEqual(
      reopened.terminals.get(terminal.id, f.owner).diagnostics,
      data,
    );
    assert.throws(
      () =>
        reopened.terminals.captureReadSource(
          terminal.id,
          f.owner,
          "0".repeat(64),
        ),
      code("JOB_SOURCE_HISTORY_ONLY"),
    );
    await assert.rejects(
      reopened.terminals.write(terminal.id, f.owner, "must never replay"),
      code("TERMINAL_CLOSED"),
    );

    // The real completed journal row, rather than invented source/cleanup evidence.
    await reopened.close();
    const filename = join(f.artifactDir, "terminals.sqlite"),
      observer = new DatabaseSync(filename);
    try {
      const row = observer
        .prepare("SELECT payload FROM terminals WHERE id=?")
        .get(terminal.id)!;
      const snapshot = JSON.parse(String(row.payload));
      const memory = new MemoryTerminalJournal();
      memory.save(snapshot);
      const invalid = structuredClone(snapshot);
      invalid.record.diagnostics.events.push(
        ...Array.from({ length: 33 }, () => ({ seq: 1, kind: "error" })),
      );
      assert.throws(
        () => memory.save(invalid),
        code("TERMINAL_JOURNAL_INVALID"),
      );
      const legacy = structuredClone(snapshot);
      delete legacy.record.diagnostics;
      memory.save(legacy);
      assert.equal(memory.read(terminal.id)?.record.diagnostics, undefined);
      snapshot.record.diagnostics.source.args = ["untrusted"];
      observer
        .prepare("UPDATE terminals SET payload=? WHERE id=?")
        .run(JSON.stringify(snapshot), terminal.id);
    } finally {
      observer.close();
    }
    const reader = new SqliteTerminalJournal(filename);
    try {
      assert.throws(() => reader.load(), code("TERMINAL_JOURNAL_INVALID"));
    } finally {
      reader.close();
    }
  },
);

test(
  "actual cancel records observed ancestry and native signal without granting cleanup from PID alone",
  posix,
  async (t) => {
    const f = serviceFixture(t);
    const terminal = await f.service.create({
      owner,
      file: "/bin/sh",
      args: ["-c", 'sleep 60 & printf "PIDS:%s:%s\\n" "$$" "$!"; wait'],
    });
    await jobUntil(
      () => /PIDS:\d+:\d+/.test(f.text(terminal.id)),
      "Actual shell and descendant readiness",
    );
    const match = /PIDS:(\d+):(\d+)/.exec(f.text(terminal.id))!,
      pids = [Number(match[1]), Number(match[2])];
    const attachment = f.service.attach(terminal.id, owner);
    const outcome = await f.service.cancel(terminal.id, owner),
      data = checked(f.service.get(terminal.id, owner).diagnostics);
    assert.equal(outcome.cleanupConfirmed, true);
    assert.equal(outcome.state, "cancelled");
    assert.equal(data.outcome.cancelled, true);
    assert.equal(data.nativeExit.observed, true);
    assert.equal(typeof data.nativeExit.signal, "number");
    assert.equal(data.source.terminalPid, pids[0]);
    assert.equal(data.source.originalGroupPid, pids[0]);
    assert.equal(data.cleanup.groupSnapshot, "observed");
    assert.equal(data.cleanup.path, "group-cleanup");
    assert.ok(
      data.events.some(
        (event) => event.kind === "group-cleanup" && event.confirmed === true,
      ),
    );
    assert.equal(data.outcome.reason, "cancel");
    assert.equal(data.supervisorExit.observed, true);
    await jobUntil(
      () => pids.every(absent),
      "Actual native group members disappear after confirmed cancel",
    );
    const states: string[] = [];
    for await (const event of attachment.events)
      if (event.type === "state") states.push(event.terminal.state);
    assert.deepEqual(states, ["cancelled"]);
    assert.deepEqual(await f.service.cancel(terminal.id, owner), outcome);
  },
);

for (const mode of ["disconnect", "kill"] as const)
  test(
    `actual supervisor ${mode} records backend close while native cleanup authority stays uncertain`,
    posix,
    async (t) => {
      const supervisors = originalSupervisor(t),
        f = serviceFixture(t);
      const terminal = await f.service.create({
        owner,
        file: "/bin/sh",
        args: ["-c", 'printf "NATIVE_PID:%s\\n" "$$"; read answer'],
      });
      await jobUntil(
        () => /NATIVE_PID:\d+/.test(f.text(terminal.id)),
        "Original supervised native PID readiness",
      );
      assert.equal(supervisors.length, 1);
      const pid = Number(/NATIVE_PID:(\d+)/.exec(f.text(terminal.id))![1]);
      if (mode === "disconnect") supervisors[0]!.disconnect();
      else assert.equal(supervisors[0]!.kill("SIGKILL"), true);
      await jobUntil(
        () => f.service.get(terminal.id, owner).state !== "running",
        "Actual original supervisor loss settles",
      );
      const record = f.service.get(terminal.id, owner),
        data = checked(record.diagnostics);
      assert.equal(record.state, "uncertain");
      assert.equal(record.reason, "supervisor_lost");
      assert.equal(record.cleanupConfirmed, false);
      assert.equal(data.source.terminalPid, pid);
      assert.equal(data.source.originalGroupPid, null);
      assert.equal(data.nativeExit.observed, false);
      assert.equal(data.nativeExit.exitCode, null);
      assert.equal(data.supervisorExit.observed, true);
      assert.equal(
        data.supervisorExit.signal,
        mode === "kill" ? "SIGKILL" : null,
      );
      assert.equal(data.cleanup.path, "backend-fallback");
      assert.equal(data.cleanup.groupSnapshot, "unavailable");
      assert.ok(data.events.some((event) => event.kind === "supervisor-lost"));
      assert.equal(data.outcome.cleanupConfirmed, false);
      if (!data.supervisorExit.closeObserved)
        assert.ok(
          data.events.some((event) => event.kind === "supervisor-exit"),
        );
      assert.equal(
        supervisors[0]!
          .listeners("exit")
          .some((listener) => listener.name === "observedExit"),
        false,
      );
      assert.equal(
        supervisors[0]!
          .listeners("disconnect")
          .some((listener) => listener.name === "observedDisconnect"),
        false,
      );
      await jobUntil(
        () => absent(pid),
        "Original native PID gone independently of uncertain proof",
      );
      assert.deepEqual(await f.service.cancel(terminal.id, owner), record);
    },
  );

test(
  "actual supervisor loss before PTY start persists the backend's unconfirmed startup outcome",
  posix,
  async (t) => {
    const supervisors = originalSupervisor(t, (packet) => {
      if (packet.type === "ready") supervisors[0]!.kill("SIGKILL");
    });
    const f = serviceFixture(t);
    await assert.rejects(
      f.service.create({ owner, file: "/bin/sh", args: ["-c", "exit 0"] }),
      code("PTY_START_FAILED"),
    );
    assert.equal(supervisors.length, 1);
    const record = f.service.list(owner)[0]!,
      data = checked(record.diagnostics);
    assert.equal(record.state, "uncertain");
    assert.equal(record.reason, "start_failed");
    assert.equal(record.cleanupConfirmed, false);
    assert.equal(data.outcome.cleanupConfirmed, false);
    assert.equal(data.outcome.reason, "supervisor_lost");
    assert.equal(data.source.terminalPid, null);
    assert.equal(data.supervisorExit.signal, "SIGKILL");
    assert.ok(data.events.some((event) => event.kind === "supervisor-lost"));
  },
);

test(
  "corrupted actual supervisor result is rejected instead of substituting successful cleanup",
  posix,
  async (t) => {
    let corrupted = 0;
    let actualResult: Record<string, unknown> | undefined;
    const supervisors = originalSupervisor(t, (packet) => {
      if (packet.type === "result") {
        if (corrupted) return;
        actualResult = structuredClone(packet);
        const outcome = packet.outcome as Record<string, unknown>,
          diagnostics = outcome.diagnostics as Record<string, unknown>;
        diagnostics.output = "untrusted".repeat(8192);
        corrupted++;
      }
    });
    const f = serviceFixture(t),
      terminal = await f.service.create({
        owner,
        file: "/bin/sh",
        args: ["-c", 'printf "NATIVE_PID:%s\\n" "$$"; read answer; exit 0'],
      });
    await jobUntil(
      () => /NATIVE_PID:\d+/.test(f.text(terminal.id)),
      "Genuine PTY before corrupted result",
    );
    const pid = Number(/NATIVE_PID:(\d+)/.exec(f.text(terminal.id))![1]);
    await f.service.write(terminal.id, owner, "finish\r");
    await jobUntil(
      () => f.service.get(terminal.id, owner).state !== "running",
      "Actual corrupt result falls back",
    );
    const record = f.service.get(terminal.id, owner),
      data = checked(record.diagnostics);
    assert.equal(corrupted, 1);
    assert.equal(record.state, "uncertain");
    assert.equal(record.cleanupConfirmed, false);
    assert.equal(record.reason, "supervisor_lost");
    assert.equal(data.nativeExit.observed, true);
    assert.equal(data.nativeExit.exitCode, 0);
    assert.equal(data.supervisorExit.observed, true);
    assert.equal(data.supervisorExit.exitCode, 0);
    assert.ok(
      data.events.some(
        (event) =>
          event.kind === "invalid-diagnostics" &&
          event.errorCode === "PTY_DIAGNOSTICS_INVALID",
      ),
    );
    assert.equal(absent(pid), true);
    assert.ok(actualResult);
    // Re-delivering the retained genuine frame after terminal settlement cannot
    // replace the immutable unknown outcome or cause a second state publication.
    supervisors[0]!.emit("message", actualResult);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.service.get(terminal.id, owner), record);
  },
);
