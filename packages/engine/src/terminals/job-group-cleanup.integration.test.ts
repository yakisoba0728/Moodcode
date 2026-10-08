import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TerminalService } from "./service.js";
import type { TerminalOwner } from "./types.js";

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function until(check: () => boolean, detail: string): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!check()) {
    assert.ok(performance.now() < deadline, detail);
    await delay(10);
  }
}

test(
  "stopped interactive PTY shell cannot turn a live separate job group into confirmed cleanup",
  { skip: process.platform !== "darwin", timeout: 10_000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-pty-job-groups-")),
    );
    const owner: TerminalOwner = {
      authority: "user",
      workspaceId: "job-groups-workspace",
      sessionId: "job-groups-session",
    };
    const service = new TerminalService({
      resolveOwner: (input) => ({ ...input, root }),
      maxDurationMs: 15_000,
    });
    let pids: number[] = [];
    t.after(async () => {
      for (const pid of pids) {
        if (exists(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      await service.close();
      await rm(root, { recursive: true, force: true });
    });
    const terminal = await service.create({
      owner,
      file: "/bin/zsh",
      args: [
        "-f",
        "-i",
        "-c",
        'sleep 60 & printf "PIDS:%s:%s\\n" "$$" "$!"; wait',
      ],
    });
    await until(() => {
      const output = service
        .replay(terminal.id, owner)
        .output.map((item) => item.data)
        .join("");
      const match = /PIDS:(\d+):(\d+)/.exec(output);
      if (match) pids = [Number(match[1]), Number(match[2])];
      return pids.length === 2;
    }, "the real interactive shell and background job became ready");
    const groups = execFileSync(
      "/bin/ps",
      ["-o", "pid=,pgid=", "-p", pids.join(",")],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    assert.equal(groups.length, 2);
    assert.notEqual(groups[0]![1], groups[1]![1]);
    process.kill(pids[0]!, "SIGSTOP");
    await until(
      () =>
        execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pids[0])], {
          encoding: "utf8",
        }).includes("T"),
      "the actual shell was stopped before its hangup relay",
    );
    await service.cancel(terminal.id, owner);
    const result = service.get(terminal.id, owner);
    await until(
      () => pids.every((pid) => !exists(pid)),
      "every originally observed PTY job group must be physically absent",
    );
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.state, "cancelled");
  },
);

test(
  "losing the actual PTY supervisor cannot reconstruct confirmed cleanup from its original group",
  { skip: process.platform !== "darwin", timeout: 10_000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-pty-lost-supervisor-")),
    );
    const owner: TerminalOwner = {
      authority: "user",
      workspaceId: "lost-supervisor-workspace",
      sessionId: "lost-supervisor-session",
    };
    const service = new TerminalService({
      resolveOwner: (input) => ({ ...input, root }),
      maxDurationMs: 15_000,
    });
    let pids: number[] = [];
    t.after(async () => {
      for (const pid of pids) {
        if (exists(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      await service.close();
      await rm(root, { recursive: true, force: true });
    });
    const terminal = await service.create({
      owner,
      file: "/bin/zsh",
      args: [
        "-f",
        "-i",
        "-c",
        'sleep 60 & printf "PIDS:%s:%s\\n" "$$" "$!"; wait',
      ],
    });
    await until(() => {
      const match = /PIDS:(\d+):(\d+)/.exec(
        service
          .replay(terminal.id, owner)
          .output.map((event) => event.data)
          .join(""),
      );
      if (match) pids = [Number(match[1]), Number(match[2])];
      return pids.length === 2;
    }, "the real PTY job became ready before supervisor loss");
    const supervisorPid = Number(
      execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pids[0])], {
        encoding: "utf8",
      }).trim(),
    );
    assert.ok(
      Number.isSafeInteger(supervisorPid) &&
        supervisorPid > 1 &&
        supervisorPid !== process.pid,
    );
    process.kill(pids[0]!, "SIGSTOP");
    await until(
      () =>
        execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pids[0])], {
          encoding: "utf8",
        }).includes("T"),
      "the actual shell cannot relay a hangup after supervisor loss",
    );
    process.kill(supervisorPid, "SIGKILL");
    await until(
      () => service.get(terminal.id, owner).state !== "running",
      "the actual supervisor loss settled the source",
    );
    const result = service.get(terminal.id, owner);
    assert.equal(result.state, "uncertain");
    assert.equal(result.cleanupConfirmed, false);
    assert.equal(result.reason, "supervisor_lost");
  },
);
