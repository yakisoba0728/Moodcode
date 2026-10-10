import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_LIMITS,
  type JsonValue,
  type Workspace,
} from "@moodcode/contracts";
import { LspManager, type LspConnection } from "../lsp/index.js";
import {
  RepositoryContextService,
  repositoryQuery,
  REPOSITORY_CONTEXT_LIMITS,
} from "./index.js";
import { createRepositoryContextTool } from "./tool.js";
import { runGit } from "../workspace/git.js";
import type { ToolContext, ProviderAdapter } from "../ports.js";
import { createEngine } from "../engine.js";
const signal = () => new AbortController().signal;
const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 5 },
};
const symbol = (name = "alpha") => ({
  name,
  kind: 12,
  range,
  selectionRange: range,
});
const code = (name: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, name);
  return true;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class Peer implements LspConnection {
  requests: string[] = [];
  closed = false;
  capabilities: Record<string, JsonValue> = {
    textDocumentSync: 1,
    documentSymbolProvider: true,
    definitionProvider: true,
    referencesProvider: true,
  };
  handler: (
    method: string,
    params: JsonValue,
    signal: AbortSignal,
  ) => Promise<JsonValue> = async () => [symbol()];
  async request(
    method: string,
    params: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    this.requests.push(method);
    if (method === "initialize") return { capabilities: this.capabilities };
    if (method === "shutdown") return null;
    return this.handler(method, params, signal);
  }
  async notify(): Promise<void> {}
  onNotification(): () => void {
    return () => {};
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}
test("symbol and definition selection ranges must remain inside validated enclosing ranges", async (t) => {
  const f = await fixture(t);
  const narrow = { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } };
  f.peer.handler = async () => [{ ...symbol(), range: narrow }];
  await assert.rejects(f.lsp.queryNavigation(f.workspace, "fixture", "a.ts", "typescript", "symbols", signal()), code("INVALID_LSP_NAVIGATION_RESULT"));
  f.peer.handler = async () => [{ targetUri: pathToFileURL(join(f.root, "b.ts")).href, targetRange: narrow, targetSelectionRange: range }];
  await assert.rejects(f.lsp.queryNavigation(f.workspace, "fixture", "a.ts", "typescript", "definition", signal(), { line: 0, character: 0 }), code("INVALID_LSP_NAVIGATION_RESULT"));
  f.peer.handler = async () => [{ targetUri: pathToFileURL(join(f.root, "b.ts")).href, targetRange: range, targetSelectionRange: range, originSelectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } } }];
  await assert.rejects(f.lsp.queryNavigation(f.workspace, "fixture", "a.ts", "typescript", "definition", signal(), { line: 0, character: 0 }), code("INVALID_LSP_NAVIGATION_RESULT"));
});
test("concurrent different observations require a fresh generation instead of overwriting the winning cache", { timeout: 5000 }, async (t) => {
  const f = await fixture(t), started = deferred<void>(), release = deferred<void>();
  let calls = 0;
  f.peer.handler = async () => {
    const current = ++calls;
    if (current === 1) { started.resolve(); await release.promise; }
    return [symbol(current === 1 ? "first" : "second")];
  };
  const first = f.repository.query(f.workspace, { kind: "symbols", paths: ["a.ts"] }, signal());
  const rejected = assert.rejects(first, code("REPOSITORY_INDEX_CONFLICT"));
  await started.promise;
  const winning = await f.repository.query(f.workspace, { kind: "symbols", paths: ["a.ts"] }, signal());
  assert.equal(winning.observations[0]!.items[0]!.name, "second");
  release.resolve(); await rejected;
  const fresh = await f.repository.query(f.workspace, { kind: "symbols", paths: ["a.ts"] }, signal());
  assert.equal(fresh.generation, winning.generation);
});
async function fixture(
  t: test.TestContext,
  options: {
    committed?: boolean;
    lspOptions?: ConstructorParameters<typeof LspManager>[0];
  } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "moodcode-repository-")),
  );
  await runGit(root, ["init", "-q"]);
  await writeFile(join(root, "a.ts"), "alpha 😀\n");
  await writeFile(join(root, "b.ts"), "beta declaration\n");
  if (options.committed) {
    await runGit(root, ["add", "a.ts", "b.ts"]);
    await runGit(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
  }
  const workspace: Workspace = {
    id: "w",
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  };
  const peer = new Peer();
  const lsp = new LspManager(options.lspOptions);
  let starts = 0;
  lsp.register("fixture", async () => {
    starts++;
    return peer;
  });
  const repository = new RepositoryContextService(lsp, (path) =>
    path.endsWith(".ts")
      ? {
          serverId: "fixture",
          languageId: "typescript",
          revision: "fixture-v1",
        }
      : null,
  );
  t.after(async () => {
    await lsp.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, peer, lsp, repository, starts: () => starts };
}
test("hierarchical symbols and cross-file definition links carry immutable source hashes and UTF16 ranges", async (t) => {
  const f = await fixture(t);
  f.peer.handler = async (method) =>
    method === "textDocument/documentSymbol"
      ? [{ ...symbol("outer"), children: [symbol("inner")] }]
      : [
          {
            targetUri: pathToFileURL(join(f.root, "b.ts")).href,
            targetRange: range,
            targetSelectionRange: range,
          },
        ];
  const symbols = await f.lsp.queryNavigation(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    "symbols",
    signal(),
  );
  assert.deepEqual(
    symbols.items.map((x) => [x.name, x.depth]),
    [
      ["outer", 0],
      ["inner", 1],
    ],
  );
  assert.equal(symbols.documentVersion, 1);
  const definition = await f.lsp.queryNavigation(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    "definition",
    signal(),
    { line: 0, character: 2 },
  );
  assert.equal(definition.items[0]?.path, "b.ts");
  assert.equal(definition.sources.length, 2);
  assert.notEqual(definition.items[0]?.hash, definition.documentHash);
  assert.equal(f.starts(), 1);
});
test("navigation deduplicates locations and never returns external, ignored or symlink target contents", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".gitignore"), "hidden.ts\n");
  await writeFile(join(f.root, "hidden.ts"), "private source\n");
  await symlink("b.ts", join(f.root, "linked.ts"));
  const uri = (path: string) => pathToFileURL(join(f.root, path)).href;
  const location = { uri: uri("b.ts"), range };
  f.peer.handler = async () => [
    location,
    location,
    { uri: "file:///outside/not-read", range },
    { uri: "https://example.invalid/source", range },
    { uri: uri("hidden.ts"), range },
    { uri: uri("linked.ts"), range },
  ];
  const result = await f.lsp.queryNavigation(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    "references",
    signal(),
    { line: 0, character: 1 },
  );
  assert.deepEqual(
    result.items.map((x) => x.path),
    ["b.ts"],
  );
  assert.equal(result.omitted.outsideWorkspace, 2);
  assert.equal(result.omitted.ignored, 1);
  assert.equal(result.omitted.unavailable, 1);
  assert.equal(result.complete, false);
  assert(!JSON.stringify(result).includes("private source"));
});
test("unsupported capabilities do not send navigation requests and source mutation cannot publish stale observations", async (t) => {
  const f = await fixture(t);
  f.peer.capabilities.definitionProvider = false;
  await assert.rejects(
    f.lsp.queryNavigation(
      f.workspace,
      "fixture",
      "a.ts",
      "typescript",
      "definition",
      signal(),
      { line: 0, character: 0 },
    ),
    code("LSP_NAVIGATION_UNSUPPORTED"),
  );
  assert(!f.peer.requests.includes("textDocument/definition"));
  const ready = deferred<void>(),
    response = deferred<JsonValue>();
  f.peer.handler = async () => {
    ready.resolve();
    return response.promise;
  };
  const pending = f.lsp.queryNavigation(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    "symbols",
    signal(),
  );
  await ready.promise;
  await writeFile(join(f.root, "a.ts"), "changed source\n");
  response.resolve([symbol()]);
  await assert.rejects(pending, code("LSP_NAVIGATION_STALE"));
});
test("same content across a newer synchronized version is still rejected as a stale navigation query", async (t) => {
  const f = await fixture(t);
  const ready = deferred<void>(),
    response = deferred<JsonValue>();
  f.peer.handler = async () => {
    ready.resolve();
    return response.promise;
  };
  const pending = f.lsp.queryNavigation(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    "symbols",
    signal(),
  );
  await ready.promise;
  await writeFile(join(f.root, "a.ts"), "other source\n");
  await f.lsp.updateFile(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    signal(),
  );
  await writeFile(join(f.root, "a.ts"), "alpha 😀\n");
  await f.lsp.updateFile(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    signal(),
  );
  response.resolve([symbol()]);
  await assert.rejects(pending, code("LSP_NAVIGATION_STALE"));
});
test("caller cancellation and peer timeout ignore late results and preserve host cleanup", async (t) => {
  const f = await fixture(t, {
    lspOptions: { requestTimeoutMs: 30, startupTimeoutMs: 1000 },
  });
  const ready = deferred<void>(),
    response = deferred<JsonValue>();
  f.peer.handler = async () => {
    ready.resolve();
    return response.promise;
  };
  const controller = new AbortController();
  const pending = f.lsp.queryNavigation(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    "symbols",
    controller.signal,
  );
  await ready.promise;
  controller.abort();
  await assert.rejects(pending, code("CANCELLED"));
  const timed = f.lsp.queryNavigation(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    "symbols",
    signal(),
  );
  await assert.rejects(timed, code("LSP_TIMEOUT"));
  response.resolve([symbol()]);
  await f.lsp.close();
  assert(f.peer.closed);
});
test("malformed ranges, split UTF16 surrogate positions and bounded response overflow are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.lsp.queryNavigation(
      f.workspace,
      "fixture",
      "a.ts",
      "typescript",
      "definition",
      signal(),
      { line: 0, character: 7 },
    ),
    code("INVALID_FORMAT_RANGE"),
  );
  f.peer.handler = async () => [
    {
      ...symbol(),
      range: {
        start: { line: 999, character: 0 },
        end: { line: 999, character: 1 },
      },
      selectionRange: null,
    },
  ];
  await assert.rejects(
    f.lsp.queryNavigation(
      f.workspace,
      "fixture",
      "a.ts",
      "typescript",
      "symbols",
      signal(),
    ),
    code("INVALID_LSP_NAVIGATION_RESULT"),
  );
  f.peer.handler = async () => "x".repeat(65_537);
  await assert.rejects(
    f.lsp.queryNavigation(
      f.workspace,
      "fixture",
      "a.ts",
      "typescript",
      "symbols",
      signal(),
    ),
    code("LSP_NAVIGATION_LIMIT"),
  );
});
test("symbol response count, depth and UTF8 byte caps expose omissions instead of claiming completeness", async (t) => {
  const f = await fixture(t);
  f.peer.handler = async () =>
    Array.from({ length: 100 }, (_, i) => symbol("심볼".repeat(30) + i));
  const result = await f.lsp.queryNavigation(
    f.workspace,
    "fixture",
    "a.ts",
    "typescript",
    "symbols",
    signal(),
  );
  assert(result.items.length < 64);
  assert(result.omitted.limits > 0 && !result.complete);
  assert(Buffer.byteLength(JSON.stringify(result)) <= 16_384);
  let tree: JsonValue = symbol();
  for (let i = 0; i < 18; i++) tree = { ...symbol(), children: [tree] };
  f.peer.handler = async () => [tree];
  await assert.rejects(
    f.lsp.queryNavigation(
      f.workspace,
      "fixture",
      "a.ts",
      "typescript",
      "symbols",
      signal(),
    ),
    code("LSP_NAVIGATION_LIMIT"),
  );
});
test("repository manifests are stable for an identical snapshot, replace changed generations and clone cached observations", async (t) => {
  const f = await fixture(t, { committed: true });
  const query = { kind: "symbols" as const, paths: ["a.ts"] };
  const first = await f.repository.query(f.workspace, query, signal());
  const second = await f.repository.query(f.workspace, query, signal());
  assert.equal(first.generation, second.generation);
  assert.match(first.manifest.gitHead!, /^[a-f0-9]{40}$/);
  first.observations[0]!.items[0]!.name = "mutated caller result";
  const third = await f.repository.query(f.workspace, query, signal());
  assert.equal(third.observations[0]!.items[0]?.name, "alpha");
  await writeFile(join(f.root, "a.ts"), "alpha changed\n");
  const changed = await f.repository.query(f.workspace, query, signal());
  assert.notEqual(changed.generation, second.generation);
  assert.notEqual(
    changed.manifest.files[0]?.hash,
    second.manifest.files[0]?.hash,
  );
});
test("ignored input is refused before starting a server and unsupported language maps remain explicitly partial", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".gitignore"), "a.ts\n");
  await assert.rejects(
    f.repository.query(
      f.workspace,
      { kind: "symbols", paths: ["a.ts"] },
      signal(),
    ),
    code("REPOSITORY_PATH_IGNORED"),
  );
  assert.equal(f.starts(), 0);
  await writeFile(join(f.root, "note.txt"), "documentation\n");
  const result = await f.repository.query(
    f.workspace,
    { kind: "symbols", paths: ["note.txt"] },
    signal(),
  );
  assert.deepEqual(result.unsupportedPaths, ["note.txt"]);
  assert.equal(result.complete, false);
  assert.equal(f.starts(), 0);
});
test("Git branch changes and ignore changes during a query invalidate the complete repository snapshot", async (t) => {
  const f = await fixture(t, { committed: true });
  for (const change of ["branch", "ignore"]) {
    const ready = deferred<void>(),
      response = deferred<JsonValue>();
    f.peer.handler = async () => {
      ready.resolve();
      return response.promise;
    };
    const pending = f.repository.query(
      f.workspace,
      { kind: "symbols", paths: ["a.ts"] },
      signal(),
    );
    await ready.promise;
    if (change === "branch")
      await runGit(f.root, ["checkout", "-qb", "different-branch"]);
    else await writeFile(join(f.root, ".gitignore"), "a.ts\n");
    response.resolve([symbol()]);
    await assert.rejects(pending, (error) =>
      ["REPOSITORY_SOURCE_STALE", "REPOSITORY_PATH_IGNORED"].includes(
        (error as { code: string }).code,
      ),
    );
  }
});
test("routing revision changes and overlapping workspaces do not share a prepared snapshot", async (t) => {
  const f = await fixture(t);
  let revision = "v1";
  const repository = new RepositoryContextService(f.lsp, () => ({
    serverId: "fixture",
    languageId: "typescript",
    revision,
  }));
  const query = { kind: "symbols" as const, paths: ["a.ts"] };
  const preview = await repository.preview(f.workspace, query, signal());
  revision = "v2";
  await assert.rejects(
    repository.query(f.workspace, query, signal(), preview.fingerprint),
    code("REPOSITORY_SOURCE_STALE"),
  );
  revision = "v1";
  await assert.rejects(
    repository.query(
      { ...f.workspace, id: "another-worktree" },
      query,
      signal(),
      preview.fingerprint,
    ),
    code("REPOSITORY_SOURCE_STALE"),
  );
});
test("read tool binds prepare to source, owner and exact request while rejecting reuse and mutation", async (t) => {
  const f = await fixture(t);
  const tool = createRepositoryContextTool(f.repository);
  const context: ToolContext = {
    workspace: f.workspace,
    sessionId: "s",
    runId: "r",
    toolCallId: "c",
    signal: signal(),
    limits: { ...DEFAULT_LIMITS },
    artifactDir: f.root,
    recordCheckpoint() {
      throw new Error("read must not write a checkpoint");
    },
  };
  const query = { kind: "symbols", paths: ["a.ts"] };
  const prepared = await tool.prepare(query, context);
  assert.equal(prepared.requiresApproval, false);
  await assert.rejects(
    tool.execute(prepared, { ...context, runId: "other" }),
    code("REPOSITORY_REQUEST_STALE"),
  );
  const result = await tool.execute(prepared, context);
  assert.equal((result.data as { complete: boolean }).complete, true);
  assert(result.content.includes("alpha"));
  await assert.rejects(
    tool.execute(prepared, context),
    code("REPOSITORY_REQUEST_STALE"),
  );
  const stale = await tool.prepare(query, context);
  await writeFile(join(f.root, "a.ts"), "changed text\n");
  await assert.rejects(
    tool.execute(stale, context),
    code("REPOSITORY_SOURCE_STALE"),
  );
  const altered = await tool.prepare(query, context);
  altered.input = { kind: "symbols", paths: ["b.ts"] };
  await assert.rejects(
    tool.execute(altered, context),
    code("REPOSITORY_REQUEST_STALE"),
  );
});
test("repository JSON boundary rejects unknown executable/server fields, ambiguous positions and duplicate paths", () => {
  for (const query of [
    null,
    { kind: "symbols", paths: ["a.ts"], command: "anything" },
    { kind: "symbols", paths: ["a.ts"], serverId: "model-selected" },
    { kind: "definition", paths: ["a.ts"] },
    { kind: "symbols", paths: ["a.ts", "a.ts"] },
    { kind: "symbols", paths: ["a.ts"], position: { line: 0, character: 0 } },
    {
      kind: "references",
      paths: ["a.ts"],
      position: { line: -1, character: 0 },
    },
  ])
    assert.throws(
      () => repositoryQuery(query),
      code("INVALID_REPOSITORY_QUERY"),
    );
  assert.throws(
    () => repositoryQuery({ kind: "symbols", paths: ["../escape"] }),
    code("INVALID_FILE_ACTION_PATH"),
  );
});
test("host API routes registered languages and the default 21-tool catalogue remains unchanged", async (t) => {
  const f = await fixture(t);
  const defaults = createEngine({ dbPath: join(f.root, "default.sqlite") });
  const enabled = createEngine({
    dbPath: join(f.root, "enabled.sqlite"),
    repositoryContextTools: true,
  });
  t.after(async () => {
    await defaults.close();
    await enabled.close();
  });
  assert.equal(defaults.getCapabilities().tools.length, 21);
  assert(
    !defaults
      .getCapabilities()
      .tools.some((x) => x.name === "repository_context"),
  );
  assert(
    enabled
      .getCapabilities()
      .tools.some((x) => x.name === "repository_context"),
  );
  enabled.store.putWorkspace(f.workspace);
  enabled.registerLanguageServer(
    "fixture",
    async () => new Peer(),
    (path) => (path.endsWith(".ts") ? "typescript" : null),
    "v1",
  );
  const result = await enabled.getRepositoryContext("w", {
    kind: "symbols",
    paths: ["a.ts"],
  });
  assert.equal(result.observations[0]?.items[0]?.name, "alpha");
  enabled.registerLanguageServer(
    "overlap",
    async () => new Peer(),
    () => "typescript",
  );
  await assert.rejects(
    enabled.getRepositoryContext("w", { kind: "symbols", paths: ["a.ts"] }),
    code("REPOSITORY_SERVER_AMBIGUOUS"),
  );
  await enabled.close();
  assert.throws(
    () =>
      enabled.getRepositoryContext("w", { kind: "symbols", paths: ["a.ts"] }),
    code("ENGINE_CLOSED"),
  );
});
test("model tool results traverse native Turn/Part/history and the same bounded captured ContextPlan", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const provider: ProviderAdapter = {
    id: "repository-fixture",
    async *streamTurn(request) {
      requests++;
      assert(request.tools.some((tool) => tool.name === "repository_context"));
      if (requests === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "symbols",
            name: "repository_context",
            input: { kind: "symbols", paths: ["a.ts"] },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        const output = request.messages.find(
          (message) => message.role === "tool",
        );
        assert(output?.content.includes("alpha"));
        assert(output?.content.includes("observed-file-snapshot"));
        assert(Buffer.byteLength(JSON.stringify(request.messages)) < 65_536);
        yield { type: "text.delta", delta: "Repository symbol located." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const engine = createEngine({
    dbPath: join(f.root, "engine.sqlite"),
    repositoryContextTools: true,
    providers: [provider],
  });
  t.after(() => engine.close());
  engine.store.putWorkspace(f.workspace);
  engine.store.createSession({
    id: "s",
    workspaceId: "w",
    title: "repo",
    createdAt: new Date().toISOString(),
  });
  engine.registerLanguageServer(
    "fixture",
    async () => new Peer(),
    () => "typescript",
  );
  const reply = await engine.dispatch({
    schemaVersion: 1,
    commandId: "run",
    type: "run.submit",
    payload: {
      sessionId: "s",
      requestId: "request",
      prompt: "Find alpha.",
      config: {
        providerId: provider.id,
        modelId: "fixture",
        mode: "plan",
        limits: { maxContextBytes: 65_536 },
      },
    },
  });
  assert(reply.ok, JSON.stringify(reply.error));
  const run = await engine.waitForRun(
    (reply.result as { runId: string }).runId,
  );
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(requests, 2);
  const snapshot = engine.store.getSnapshot("s");
  assert.equal(snapshot.tools[0]?.name, "repository_context");
  assert.equal(snapshot.tools[0]?.state, "completed");
  assert(
    snapshot.messages.some(
      (message) =>
        message.role === "tool" && message.content.includes("documentHash"),
    ),
  );
  const plan = engine.context.diagnostics("s")!.plan;
  assert(plan.bytes <= plan.byteLimit);
  assert.equal(await readFile(join(f.root, "a.ts"), "utf8"), "alpha 😀\n");
});
test("host close cancels an admitted repository query, joins it and refuses new calls", async (t) => {
  const f = await fixture(t);
  const engine = createEngine({ dbPath: join(f.root, "closing.sqlite") });
  engine.store.putWorkspace(f.workspace);
  const ready = deferred<void>(),
    response = deferred<JsonValue>();
  const peer = new Peer();
  peer.handler = async () => {
    ready.resolve();
    return response.promise;
  };
  engine.registerLanguageServer(
    "fixture",
    async () => peer,
    () => "typescript",
  );
  const pending = engine.getRepositoryContext("w", {
    kind: "symbols",
    paths: ["a.ts"],
  });
  const rejected = assert.rejects(pending, (error) =>
    ["CANCELLED", "ABORTED"].includes((error as { code: string }).code),
  );
  await ready.promise;
  await engine.close();
  await rejected;
  assert(peer.closed);
  response.resolve([symbol()]);
  assert.throws(
    () =>
      engine.getRepositoryContext("w", { kind: "symbols", paths: ["a.ts"] }),
    code("ENGINE_CLOSED"),
  );
});
