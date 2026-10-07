import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_LIMITS,
  type Checkpoint,
  type JsonValue,
} from "@moodcode/contracts";
import type { ToolContext } from "../ports.js";
import { LspManager, StdioLspConnection, type LspConnection } from "./index.js";
import { createLspFormatTool } from "../formatters/index.js";
import { runGit } from "../workspace/git.js";
const compiled = fileURLToPath(
  new URL("./fixtures/server.js", import.meta.url),
);
const serverFile = existsSync(compiled)
  ? compiled
  : fileURLToPath(new URL("./fixtures/server.ts", import.meta.url));
const signal = () => new AbortController().signal;
const code = (expected: string) => (e: unknown) => {
  assert.equal((e as { code: string }).code, expected);
  return true;
};
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moodcode-lsp-")));
  const workspace = {
    id: "w",
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(root, "a.ts"), "\ufeffbad\r\n😀bad\r\n");
  const lsp = new LspManager();
  const connections: StdioLspConnection[] = [];
  lsp.register("fixture", async (workspace) => {
    const connection = await StdioLspConnection.open({
      command: process.execPath,
      args: [serverFile],
      cwd: workspace.root,
    });
    connections.push(connection);
    return connection;
  });
  t.after(async () => {
    await lsp.close().catch(() => {});
    await Promise.all(connections.map((c) => c.close()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, lsp, connections };
}
test("real LSP stdio spawn is deduplicated and document updates/diagnostics use current UTF16 versions", async (t) => {
  const { root, workspace, lsp, connections } = await fixture(t);
  const [first, same] = await Promise.all([
    lsp.updateFile(workspace, "fixture", "a.ts", "typescript", signal()),
    lsp.updateFile(workspace, "fixture", "a.ts", "typescript", signal()),
  ]);
  assert.equal(connections.length, 1);
  assert.equal(first.version, 1);
  assert.equal(same.version, 1);
  const connection = connections[0]!;
  const state = (await connection.request("fixture/state", {}, signal())) as {
    initialized: boolean;
  };
  assert.equal(state.initialized, true);
  assert.equal(
    lsp.diagnostics(workspace, "fixture", "a.ts")?.diagnostics[0]?.message,
    "opened",
  );
  await writeFile(join(root, "a.ts"), "\ufeffbad changed\r\n😀bad\r\n");
  await lsp.fileChanged(
    workspace,
    "fixture",
    "a.ts",
    "typescript",
    "changed",
    signal(),
  );
  const second = (await connection.request("fixture/state", {}, signal())) as {
    documents: { version: number }[];
    watched: number;
  };
  assert.equal(second.documents[0]?.version, 2);
  assert.equal(second.watched, 1);
  assert.equal(
    lsp.diagnostics(workspace, "fixture", "a.ts")?.documentVersion,
    2,
  );
  assert.equal(
    lsp.diagnostics(workspace, "fixture", "a.ts")?.diagnostics[0]?.message,
    "updated",
  );
  await lsp.closeDocument(workspace, "fixture", "a.ts", signal());
  assert.equal(lsp.diagnostics(workspace, "fixture", "a.ts"), null);
});
test("LSP format proposal applies only through approved checkpoint patch and preserves BOM/untouched CRLF", async (t) => {
  const { root, workspace, lsp } = await fixture(t);
  const checkpoints: Checkpoint[] = [];
  const context: ToolContext = {
    workspace,
    sessionId: "s",
    runId: "r",
    toolCallId: "format",
    signal: signal(),
    limits: { ...DEFAULT_LIMITS },
    artifactDir: root,
    recordCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
  };
  const tool = createLspFormatTool(lsp);
  const prepared = await tool.prepare(
    { path: "a.ts", serverId: "fixture", languageId: "typescript" },
    context,
  );
  assert.equal(prepared.requiresApproval, true);
  assert.equal(
    await readFile(join(root, "a.ts"), "utf8"),
    "\ufeffbad\r\n😀bad\r\n",
  );
  await tool.execute(prepared, context);
  assert.equal(
    await readFile(join(root, "a.ts"), "utf8"),
    "\ufeffgood\r\n😀bad\r\n",
  );
  assert.equal(checkpoints.length, 1);
  assert.equal(
    checkpoints[0]?.files[0]?.beforeHash,
    prepared.preview.files &&
      (prepared.preview.files as { beforeHash: string }[])[0]?.beforeHash,
  );
});
test("real stdio navigation synchronizes UTF16 documents and returns bounded source-checked symbols and locations", async (t) => {
  const { workspace, lsp } = await fixture(t);
  await runGit(workspace.root, ["init", "-q"]);
  const symbols = await lsp.querySymbols(
    workspace,
    "fixture",
    "a.ts",
    "typescript",
    signal(),
  );
  assert.equal(symbols.items[0]?.name, "fixtureDocument");
  assert.equal(symbols.items[0]?.hash, symbols.documentHash);
  const definition = await lsp.queryDefinitions(
    workspace,
    "fixture",
    "a.ts",
    "typescript",
    { line: 1, character: 2 },
    signal(),
  );
  assert.equal(definition.items[0]?.path, "a.ts");
  const references = await lsp.queryReferences(
    workspace,
    "fixture",
    "a.ts",
    "typescript",
    { line: 0, character: 1 },
    signal(),
  );
  assert.equal(references.complete, true);
  assert.equal(references.documentVersion, 1);
});
test("LSP timeout/cancel remains usable and malformed or oversized frames disconnect", async (t) => {
  const { workspace, lsp, connections } = await fixture(t);
  await lsp.updateFile(workspace, "fixture", "a.ts", "typescript", signal());
  const connection = connections[0]!;
  const controller = new AbortController();
  const hanging = connection.request("fixture/hang", {}, controller.signal);
  const before = (await connection.request("fixture/state", {}, signal())) as {
    hanging: number;
  };
  assert.equal(before.hanging, 1);
  controller.abort();
  await assert.rejects(hanging, code("CANCELLED"));
  assert.equal(
    (
      (await connection.request("fixture/state", {}, signal())) as {
        cancelled: number;
      }
    ).cancelled,
    1,
  );
  await assert.rejects(
    connection.request("fixture/hang", {}, signal(), 20),
    code("LSP_TIMEOUT"),
  );
  assert.equal(
    (
      (await connection.request("fixture/state", {}, signal())) as {
        cancelled: number;
      }
    ).cancelled,
    2,
  );
  await assert.rejects(
    connection.request("fixture/malformed", {}, signal()),
    code("INVALID_LSP_FRAME"),
  );
  const other = await StdioLspConnection.open({
    command: process.execPath,
    args: [serverFile],
    cwd: workspace.root,
  });
  t.after(() => other.close());
  await assert.rejects(
    other.request("fixture/oversize", {}, signal()),
    code("LSP_FRAME_LIMIT"),
  );
});
test("LSP server cannot apply workspace effects and receives no inherited fixture secret", async (t) => {
  const previous = process.env.MOODCODE_LSP_FIXTURE_SECRET;
  process.env.MOODCODE_LSP_FIXTURE_SECRET = "parent-fixture-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.MOODCODE_LSP_FIXTURE_SECRET;
    else process.env.MOODCODE_LSP_FIXTURE_SECRET = previous;
  });
  const { root, workspace, lsp, connections } = await fixture(t);
  await lsp.updateFile(workspace, "fixture", "a.ts", "typescript", signal());
  const connection = connections[0]!;
  assert.equal(
    (
      (await connection.request("fixture/env", {}, signal())) as {
        parentSecret: string;
      }
    ).parentSecret,
    "absent",
  );
  await connection.request("fixture/server_effect", {}, signal());
  assert.equal(
    await readFile(join(root, "a.ts"), "utf8"),
    "\ufeffbad\r\n😀bad\r\n",
  );
});
test(
  "LSP close terminates its owned POSIX descendant group",
  { skip: process.platform === "win32" },
  async (t) => {
    const { workspace, lsp, connections } = await fixture(t);
    await lsp.updateFile(workspace, "fixture", "a.ts", "typescript", signal());
    const { pid } = (await connections[0]!.request(
      "fixture/descendant",
      {},
      signal(),
    )) as { pid: number };
    assert.ok(pid > 0);
    await lsp.close();
    let alive = true;
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive, false);
  },
);
function fake(): LspConnection & {
  emit(method: string, params: JsonValue): void;
  calls: string[];
  closed: boolean;
} {
  const listeners = new Set<(m: string, p: JsonValue) => void>();
  const result = {
    calls: [] as string[],
    closed: false,
    async request(method: string): Promise<JsonValue> {
      result.calls.push(method);
      return method === "initialize"
        ? {
            capabilities: {
              textDocumentSync: 1,
              documentFormattingProvider: true,
            },
          }
        : null;
    },
    async notify(method: string) {
      result.calls.push(method);
    },
    onNotification(listener: (m: string, p: JsonValue) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      result.closed = true;
    },
    emit(method: string, params: JsonValue) {
      for (const listener of listeners) listener(method, params);
    },
  };
  return result;
}
test("cancelled startup caller does not abort shared spawn, and stale/unowned diagnostics are dropped", async (t) => {
  const { root, workspace } = await fixture(t);
  const lsp = new LspManager();
  t.after(() => lsp.close());
  const connection = fake();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  lsp.register("slow", async (_, ownedSignal) => {
    calls++;
    await gate;
    assert.equal(ownedSignal.aborted, false);
    return connection;
  });
  const controller = new AbortController();
  const first = lsp.updateFile(
    workspace,
    "slow",
    "a.ts",
    "typescript",
    controller.signal,
  );
  const second = lsp.updateFile(
    workspace,
    "slow",
    "a.ts",
    "typescript",
    signal(),
  );
  controller.abort();
  await assert.rejects(first, code("CANCELLED"));
  release();
  await second;
  assert.equal(calls, 1);
  const uri = pathToFileURL(join(root, "a.ts")).href;
  const diagnostic = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: "fresh",
  };
  connection.emit("textDocument/publishDiagnostics", {
    uri,
    version: 1,
    diagnostics: [diagnostic],
  });
  assert.equal(
    lsp.diagnostics(workspace, "slow", "a.ts")?.diagnostics[0]?.message,
    "fresh",
  );
  await writeFile(join(root, "a.ts"), "changed");
  await lsp.updateFile(workspace, "slow", "a.ts", "typescript", signal());
  connection.emit("textDocument/publishDiagnostics", {
    uri,
    version: 1,
    diagnostics: [diagnostic],
  });
  connection.emit("textDocument/publishDiagnostics", {
    uri: "file:///outside",
    version: 2,
    diagnostics: [diagnostic],
  });
  connection.emit("textDocument/publishDiagnostics", {
    uri,
    diagnostics: [diagnostic],
  });
  assert.equal(lsp.diagnostics(workspace, "slow", "a.ts"), null);
});
test("formatting response for externally changed file is rejected before preview/effects", async (t) => {
  const { root, workspace } = await fixture(t);
  const lsp = new LspManager();
  t.after(() => lsp.close());
  const connection = fake();
  let reply!: (value: JsonValue) => void;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = connection.request;
  connection.request = async (method) => {
    if (method !== "textDocument/formatting")
      return original(method, null, signal());
    entered();
    return new Promise((resolve) => {
      reply = resolve;
    });
  };
  lsp.register("fake", async () => connection);
  const proposal = lsp.formatting(
    workspace,
    "fake",
    "a.ts",
    "typescript",
    signal(),
  );
  await entry;
  await writeFile(join(root, "a.ts"), "external");
  reply([]);
  await assert.rejects(proposal, code("FORMAT_PREIMAGE_STALE"));
  assert.equal(await readFile(join(root, "a.ts"), "utf8"), "external");
});
test("noncooperative LSP startup returns timeout and close reports uncertain until late connection is disposed", async (t) => {
  const { workspace } = await fixture(t);
  const lsp = new LspManager({ startupTimeoutMs: 10, cleanupTimeoutMs: 20 });
  const connection = fake();
  let late!: (connection: LspConnection) => void;
  lsp.register(
    "late",
    () =>
      new Promise((resolve) => {
        late = resolve;
      }),
  );
  await assert.rejects(
    lsp.updateFile(workspace, "late", "a.ts", "typescript", signal()),
    code("LSP_START_TIMEOUT"),
  );
  await assert.rejects(lsp.close(), code("LSP_CLEANUP_UNCERTAIN"));
  late(connection);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.closed, true);
});
test("unsupported UTF16 encoding or missing text sync are explicit capabilities and host request deadlines are bounded", async (t) => {
  const { workspace } = await fixture(t);
  const lsp = new LspManager({ requestTimeoutMs: 10 });
  t.after(() => lsp.close());
  const wrong = fake();
  wrong.request = async () => ({
    capabilities: { positionEncoding: "utf-8", textDocumentSync: 1 },
  });
  lsp.register("encoding", async () => wrong);
  await assert.rejects(
    lsp.updateFile(workspace, "encoding", "a.ts", "typescript", signal()),
    code("LSP_ENCODING_UNSUPPORTED"),
  );
  const missing = fake();
  missing.request = async () => ({ capabilities: { textDocumentSync: 0 } });
  lsp.register("sync", async () => missing);
  await assert.rejects(
    lsp.updateFile(workspace, "sync", "a.ts", "typescript", signal()),
    code("LSP_SYNC_UNSUPPORTED"),
  );
  const hang = fake();
  const request = hang.request;
  hang.request = (method) =>
    method === "textDocument/formatting"
      ? new Promise(() => {})
      : request(method, null, signal());
  lsp.register("hang", async () => hang);
  await assert.rejects(
    lsp.formatting(workspace, "hang", "a.ts", "typescript", signal()),
    code("LSP_TIMEOUT"),
  );
});
