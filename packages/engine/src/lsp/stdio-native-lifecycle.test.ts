import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonValue } from "@moodcode/contracts";
import { cleanupGroup } from "../shared/runtime.js";
import { StdioLspConnection } from "./stdio.js";
import { createTypeScriptNativeLspFactory } from "./typescript-native.js";

const signal = () => new AbortController().signal;
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const executable = join(
  repositoryRoot,
  "node_modules",
  "@typescript",
  `typescript-${process.platform}-${process.arch}`,
  "lib",
  process.platform === "win32" ? "tsc.exe" : "tsc",
);
const compiledFixture = fileURLToPath(
  new URL("./fixtures/server.js", import.meta.url),
);
const serverFixture = existsSync(compiledFixture)
  ? compiledFixture
  : fileURLToPath(new URL("./fixtures/server.ts", import.meta.url));

function ownedChild(
  connection: StdioLspConnection,
): ChildProcessWithoutNullStreams {
  const child = Reflect.get(
    connection,
    "child",
  ) as ChildProcessWithoutNullStreams;
  assert.equal(typeof child.pid, "number");
  return child;
}

/** Observe the bytes passed to the real writable; never replace an RPC response. */
function observeWire(child: ChildProcessWithoutNullStreams) {
  const frames: Record<string, JsonValue>[] = [];
  const original = child.stdin.write;
  child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    const headerEnd = bytes.indexOf("\r\n\r\n");
    assert.ok(headerEnd > 0, "Original stdio writes one complete frame");
    const length = Number(
      /Content-Length: (\d+)/u.exec(
        bytes.subarray(0, headerEnd).toString("ascii"),
      )?.[1],
    );
    assert.equal(bytes.length - headerEnd - 4, length);
    frames.push(
      JSON.parse(bytes.subarray(headerEnd + 4).toString("utf8")) as Record<
        string,
        JsonValue
      >,
    );
    return Reflect.apply(original, child.stdin, [chunk, ...args]) as boolean;
  }) as typeof child.stdin.write;
  return {
    frames,
    restore: () => {
      child.stdin.write = original;
    },
  };
}

function exitObservation(child: ChildProcessWithoutNullStreams) {
  let observed = child.exitCode !== null || child.signalCode !== null;
  child.once("exit", () => {
    observed = true;
  });
  return () => observed;
}

function assertPidGone(child: ChildProcessWithoutNullStreams) {
  assert.throws(
    () => process.kill(child.pid!, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
}

/** Deny only TERM/KILL sent to the owned group; probes and every other signal stay real. */
function denyOwnedGroupKills(child: ChildProcessWithoutNullStreams) {
  const originalKill = process.kill;
  const denied = { count: 0 };
  process.kill = ((pid: number, requestedSignal?: string | number) => {
    if (
      pid === -child.pid! &&
      (requestedSignal === "SIGTERM" || requestedSignal === "SIGKILL")
    ) {
      denied.count++;
      throw Object.assign(
        new Error("Fixture denies only its own group teardown"),
        { code: "EPERM" },
      );
    }
    return originalKill(pid, requestedSignal);
  }) as typeof process.kill;
  return {
    denied,
    originalKill,
    restore: () => {
      process.kill = originalKill;
    },
  };
}

async function forceOwnedCleanup(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Owned fixture child did not exit")),
      2000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
  else child.kill("SIGKILL");
  await exited;
}

async function workspace(t: test.TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "moodcode-stdio-native-lifecycle-")),
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022" },
      include: ["*.ts"],
    }),
  );
  await writeFile(join(root, "a.ts"), "export const actual = 1;\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    id: "stdio-native-lifecycle",
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  };
}

test(
  "actual native TS7 accepts original initialization and omitted shutdown/exit params, and close confirms its child exit",
  { timeout: 15_000 },
  async (t) => {
    if (!existsSync(executable)) {
      t.skip("Pinned native TS7 executable is not installed on this platform");
      return;
    }
    const scope = await workspace(t);
    const native = createTypeScriptNativeLspFactory({
      executable,
      expectedVersion: "7.0.2",
    });
    const connection = await native(scope, signal());
    assert.ok(connection instanceof StdioLspConnection);
    const child = ownedChild(connection),
      wire = observeWire(child),
      exited = exitObservation(child);
    try {
      const initialize = {
        processId: process.pid,
        rootUri: pathToFileURL(scope.root).href,
        capabilities: {},
        workspaceFolders: [
          { uri: pathToFileURL(scope.root).href, name: "native-lifecycle" },
        ],
      };
      const initialized = (await connection.request(
        "initialize",
        initialize,
        signal(),
        5000,
      )) as { capabilities: JsonValue };
      assert.ok(
        initialized.capabilities,
        "The original native process supplies its observed capabilities",
      );
      await connection.notify("initialized", {});
      assert.equal(
        await connection.request(
          "shutdown",
          { ignoredSentinel: "must-not-be-on-wire" },
          signal(),
          5000,
        ),
        null,
      );
      await connection.notify("exit", {
        ignoredSentinel: "must-not-be-on-wire",
      });
      const closed = connection.close();
      assert.equal(
        closed,
        connection.close(),
        "The original close promise is retained",
      );
      await closed;
      assert.equal(
        exited(),
        true,
        "Close resolves after an observed real exit",
      );
      assertPidGone(child);
      assert.deepEqual(
        wire.frames.find((frame) => frame.method === "initialize")?.params,
        initialize,
      );
      for (const method of ["shutdown", "exit"]) {
        const frame = wire.frames.find((frame) => frame.method === method);
        assert.ok(frame);
        assert.equal(Object.hasOwn(frame, "params"), false, method);
      }
    } finally {
      wire.restore();
      await connection.close().catch(() => {});
      await forceOwnedCleanup(child);
    }
  },
);

test(
  "actual legacy stdio fixture preserves ordinary request and notification params",
  { timeout: 10_000 },
  async (t) => {
    const scope = await workspace(t);
    const connection = await StdioLspConnection.open({
      command: process.execPath,
      args: [serverFixture],
      cwd: scope.root,
    });
    const child = ownedChild(connection),
      wire = observeWire(child),
      exited = exitObservation(child);
    try {
      const initialize = {
        processId: process.pid,
        rootUri: pathToFileURL(scope.root).href,
        capabilities: {},
      };
      await connection.request("initialize", initialize, signal());
      await connection.notify("initialized", {});
      const params = { original: ["legacy", null, 3, false] };
      const result = (await connection.request(
        "fixture/state",
        params,
        signal(),
      )) as { initialized: boolean; watched: number };
      assert.equal(result.initialized, true);
      const changes = {
        changes: [
          { uri: pathToFileURL(join(scope.root, "a.ts")).href, type: 2 },
        ],
      };
      await connection.notify("workspace/didChangeWatchedFiles", changes);
      assert.equal(
        (
          (await connection.request("fixture/state", params, signal())) as {
            watched: number;
          }
        ).watched,
        1,
      );
      assert.deepEqual(
        wire.frames.find((frame) => frame.method === "initialize")?.params,
        initialize,
      );
      assert.deepEqual(
        wire.frames.find((frame) => frame.method === "fixture/state")?.params,
        params,
      );
      assert.deepEqual(
        wire.frames.find(
          (frame) => frame.method === "workspace/didChangeWatchedFiles",
        )?.params,
        changes,
      );
      await connection.request("shutdown", null, signal());
      await connection.notify("exit", null);
      await connection.close();
      assert.equal(exited(), true);
      assertPidGone(child);
    } finally {
      wire.restore();
      await connection.close().catch(() => {});
      await forceOwnedCleanup(child);
    }
  },
);

test(
  "original pending owner preserves cleanup uncertainty and the same close promise when its owned group cannot be terminated",
  { timeout: 10_000, skip: process.platform === "win32" },
  async (t) => {
    const scope = await workspace(t);
    // This actual process intentionally retains its event loop after stdin ends.
    const connection = await StdioLspConnection.open({
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>{});setInterval(()=>{},1000)",
      ],
      cwd: scope.root,
    });
    const child = ownedChild(connection),
      exited = exitObservation(child);
    const pending = connection.request(
      "initialize",
      { capabilities: {} },
      signal(),
      5000,
    );
    const pendingRejected = assert.rejects(
      pending,
      (error: unknown) =>
        (error as { code?: string }).code === "LSP_DISCONNECTED",
    );
    const { denied, originalKill, restore } = denyOwnedGroupKills(child);
    try {
      const first = connection.close(),
        same = connection.close();
      assert.equal(first, same);
      await assert.rejects(
        first,
        (error: unknown) =>
          (error as { code?: string }).code === "LSP_CLEANUP_UNCERTAIN",
      );
      await pendingRejected;
      // The TERM/KILL ladder, then the group cleanup that confirms absence.
      assert.equal(denied.count, 4);
      assert.equal(exited(), false, "No exit observation was fabricated");
      assert.equal(
        originalKill(child.pid!, 0),
        true,
        "The exact owned child is still alive",
      );
      assert.equal(
        connection.close(),
        first,
        "Repeated close must not turn uncertainty into success",
      );
      await assert.rejects(
        connection.close(),
        (error: unknown) =>
          (error as { code?: string }).code === "LSP_CLEANUP_UNCERTAIN",
      );
    } finally {
      restore();
      await forceOwnedCleanup(child);
      assert.equal(exited(), true);
      assertPidGone(child);
    }
  },
);

test(
  "close stays uncertain when the leader exits but a descendant survives in its owned group",
  { timeout: 10_000, skip: process.platform === "win32" },
  async (t) => {
    const scope = await workspace(t);
    // The leader exits once stdin ends and leaves a same-group descendant behind.
    const connection = await StdioLspConnection.open({
      command: process.execPath,
      args: [
        "-e",
        "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.on('spawn',()=>process.stderr.write(c.pid+'\\n'));process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
      ],
      cwd: scope.root,
    });
    const child = ownedChild(connection),
      exited = exitObservation(child);
    const descendant = await new Promise<number>((resolve) => {
      let text = "";
      child.stderr.on("data", (bytes: Buffer) => {
        text += bytes.toString();
        if (text.includes("\n")) resolve(Number(text.trim()));
      });
    });
    const { originalKill, restore } = denyOwnedGroupKills(child);
    try {
      await assert.rejects(
        connection.close(),
        (error: unknown) =>
          (error as { code?: string }).code === "LSP_CLEANUP_UNCERTAIN",
      );
      assert.equal(exited(), true, "The leader itself exited");
      assert.equal(
        originalKill(descendant, 0),
        true,
        "Its descendant still runs in the owned group",
      );
    } finally {
      restore();
      assert.equal(await cleanupGroup(child.pid!), true);
    }
    assert.throws(
      () => process.kill(descendant, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  },
);
