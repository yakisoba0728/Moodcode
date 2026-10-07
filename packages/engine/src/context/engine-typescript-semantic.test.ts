import assert from "node:assert/strict";
import {
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  EngineError,
  type JsonObject,
  type Session,
  type RunReceipt,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../engine.js";
import { StdioLspConnection } from "../lsp/stdio.js";
import { createTypeScriptNativeLspFactory } from "../lsp/typescript-native.js";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import type { LifecycleHookRegistration } from "../lifecycle/index.js";
import type { RepositoryQuery } from "../repository/index.js";

type Engine = ReturnType<typeof createEngine>;
const SERVER = "actual-native-typescript";
const SOURCE =
  "export function duplicate(value: number) { return value + 1; }\n";
const CONSUMER =
  'import { duplicate } from "./barrel.js";\nexport const result = duplicate(1);\n';
const QUERY: RepositoryQuery = {
  kind: "definition",
  paths: ["consumer.ts"],
  position: { line: 1, character: 23 },
};
const nativePackage = fileURLToPath(
  import.meta.resolve(
    `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
  ),
);
const executable = join(
  dirname(nativePackage),
  "lib",
  process.platform === "win32" ? "tsc.exe" : "tsc",
);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}
async function command<T>(
  engine: Engine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const response = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result as unknown as T;
}
function repositoryEntry(request: TurnRequest) {
  return request.messages.find(
    (message) =>
      message.role === "assistant" &&
      message.content.startsWith("Observed repository evidence."),
  );
}
function repositoryData(request: TurnRequest) {
  const entry = repositoryEntry(request);
  assert.ok(entry);
  return JSON.parse(entry.content.slice(entry.content.indexOf("\n") + 1)) as {
    snippets: { path: string; text: string; sourceHash: string }[];
    generation: string;
  };
}
interface FixtureOptions {
  registered?: boolean;
  context?: boolean;
  readTool?: boolean;
  emptyTools?: boolean;
  slotBytes?: number;
  maxContextBytes?: number;
  beforeModel?: (
    engine: Engine,
    workspace: Workspace,
    runId: string,
  ) => void | Promise<void>;
  stream?: (
    request: TurnRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ProviderEvent>;
}
async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-native-semantic-engine-")),
    ),
    root = join(base, "repo"),
    dbPath = join(base, "engine.sqlite");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "nodenext", target: "es2025", strict: true },
      include: ["*.ts"],
    }),
  );
  writeFileSync(join(root, "a.ts"), SOURCE);
  writeFileSync(join(root, "b.ts"), SOURCE.replace("+ 1", "+ 2"));
  writeFileSync(
    join(root, "barrel.ts"),
    'export { duplicate } from "./a.js";\n',
  );
  writeFileSync(join(root, "consumer.ts"), CONSUMER);
  writeFileSync(
    join(root, "unsupported.py"),
    "def duplicate(value): return value + 9\n",
  );
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-qm",
    "Actual semantic Engine fixture",
  );
  const children: ChildProcessWithoutNullStreams[] = [],
    opens: string[][] = [],
    requests: TurnRequest[] = [];
  const originalOpen = StdioLspConnection.open;
  t.mock.method(
    StdioLspConnection,
    "open",
    async function (configuration: Parameters<typeof originalOpen>[0]) {
      const connection = await originalOpen.call(
        StdioLspConnection,
        configuration,
      );
      if (configuration.command === executable) {
        children.push(
          Reflect.get(connection, "child") as ChildProcessWithoutNullStreams,
        );
        opens.push([
          configuration.command,
          ...(configuration.args ?? []),
          configuration.cwd,
        ]);
      }
      return connection;
    },
  );
  const provider: ProviderAdapter = {
    id: "actual-typescript-consumer",
    streamTurn(request, signal) {
      requests.push(structuredClone(request));
      return (
        options.stream?.(request, signal) ??
        (async function* () {
          yield {
            type: "text.delta" as const,
            delta: "Actual semantic consumer complete.",
          };
          yield { type: "finish" as const, reason: "stop" as const };
        })()
      );
    },
  };
  let engine!: Engine, workspace!: Workspace;
  const hook: LifecycleHookRegistration = {
    id: "actual-semantic-source-boundary",
    revision: 1,
    stages: ["before-model"],
    timeoutMs: 1000,
    failurePolicy: "stop",
    callback: async (invocation) => {
      await options.beforeModel?.(engine, workspace, invocation.identity.runId);
      return { kind: "observe" };
    },
  };
  const configuration: EngineOptions = {
    dbPath,
    artifactDir: join(base, "artifacts"),
    providers: [provider],
    ...(options.emptyTools ? { tools: [] } : {}),
    ...(options.readTool ? { repositoryContextTools: true } : {}),
    ...(options.context === false
      ? {}
      : {
          repositoryContextPolicy: {
            query: QUERY,
            slotBytes: options.slotBytes ?? 8192,
          },
        }),
    ...(options.beforeModel ? { lifecycleHooks: [hook] } : {}),
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "build",
      limits: {
        maxContextBytes: options.maxContextBytes ?? 65536,
        maxTurns: 4,
        maxDurationMs: 15000,
      },
      budgets: { maxProviderAttempts: 3, retryBaseDelayMs: 0 },
    },
  };
  engine = createEngine(configuration);
  const engines = new Set([engine]);
  async function closeAndAssert() {
    for (const current of engines) await current.close();
    for (const child of children) {
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        "Original native child must actually exit before host close resolves",
      );
      if (child.pid)
        assert.throws(
          () => process.kill(child.pid!, 0),
          (error) => (error as NodeJS.ErrnoException).code === "ESRCH",
        );
    }
  }
  t.after(async () => {
    try {
      await closeAndAssert();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  function register(target = engine) {
    target.registerLanguageServer(
      SERVER,
      createTypeScriptNativeLspFactory({
        executable,
        expectedVersion: "7.0.2",
      }),
      (path) => (/\.(?:ts|tsx|mts|cts)$/.test(path) ? "typescript" : null),
      "7.0.2",
    );
  }
  if (options.registered !== false) register();
  workspace = await command<Workspace>(engine, "workspace.open", {
    path: root,
  });
  async function consume(
    prompt = "Explain the exact host-selected definition.",
  ) {
    const session = await command<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
    const receipt = await command<RunReceipt>(engine, "run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt,
    });
    const run = await engine.waitForRun(receipt.runId);
    await engine.waitForSession(session.id);
    return {
      session,
      run,
      request: requests.find((request) => request.runId === run.id),
    };
  }
  function tableRows(runId: string) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT id FROM provider_attempts WHERE run_id=? ORDER BY attempt_index",
        )
        .all(runId)
        .map((row) => engine.store.getAttempt(String(row.id)));
    } finally {
      db.close();
    }
  }
  return {
    base,
    root,
    dbPath,
    engine,
    engines,
    configuration,
    workspace,
    children,
    opens,
    requests,
    register,
    consume,
    tableRows,
    closeAndAssert,
  };
}

test("actual native factory and Engine select the correct same-name definition and persist exact coding context provenance", async (t) => {
  const f = await fixture(t),
    observed = await f.engine.getRepositoryContext(f.workspace.id, QUERY);
  assert.equal(observed.complete, true);
  assert.deepEqual(
    observed.observations[0]!.items.map((item) => [item.path, item.range]),
    [
      [
        "a.ts",
        { start: { line: 0, character: 16 }, end: { line: 0, character: 25 } },
      ],
    ],
  );
  const result = await f.consume();
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  const data = repositoryData(result.request);
  assert.deepEqual(
    data.snippets.map((snippet) => [snippet.path, snippet.text]),
    [["a.ts", "duplicate"]],
  );
  assert.equal(result.request.tools.length, 21);
  assert.equal(result.request.messages.at(-1)!.content, result.run.prompt);
  const attempt = f.engine.store.getAttempt(result.request.attemptId!),
    revision = f.engine.store.getContextRevision(attempt.contextRevisionId!);
  assert.equal(attempt.state, "completed");
  assert.equal(attempt.runId, result.run.id);
  assert.equal(revision.text, JSON.stringify(result.request.messages));
  assert.equal(revision.sha256, sha(revision.text));
  assert.ok(revision.sourceIds.some((id) => id.includes("repository")));
  const cleanup = f.engine.store.getAttemptCleanup(attempt.id);
  assert.equal(cleanup.requestSha256, sha(JSON.stringify(result.request)));
  assert.equal(
    cleanup.requestBytes,
    Buffer.byteLength(JSON.stringify(result.request)),
  );
  assert.equal(cleanup.state, "confirmed");
  const diagnostic = f.engine.context.diagnostics(result.session.id)!;
  assert.equal(
    diagnostic.plan.reservations.repositoryBytes,
    Buffer.byteLength(JSON.stringify(repositoryEntry(result.request))) + 1,
  );
  assert.equal(
    diagnostic.plan.bytes,
    Buffer.byteLength(JSON.stringify(result.request.messages)) +
      diagnostic.plan.reservations.envelopeBytes,
  );
  assert.deepEqual(
    diagnostic.repositoryContext!.sourceManifest.projectSources,
    observed.manifest.projectSources,
  );
  assert.ok(
    revision.sourceIds.includes(
      `repository-generation:${diagnostic.repositoryContext!.generation}`,
    ),
  );
  assert.ok(
    revision.sourceIds.includes(
      `repository-project:${SERVER}:${observed.manifest.projectSources![0]!.sha256}`,
    ),
  );
  const persisted = f.engine.store.getSessionDocument(
    result.session.id,
    "context.head",
  )!;
  assert.ok(persisted);
  assert.ok(
    JSON.stringify(persisted.data).includes(
      observed.manifest.projectSources![0]!.sha256,
    ),
  );
  assert.equal(f.engine.store.listCheckpoints(result.run.id).length, 0);
  assert.equal(f.engine.store.getSnapshot(result.session.id).tools.length, 0);
  assert.equal(f.children.length, 1);
  await f.closeAndAssert();
});

for (const inactive of ["unregistered-native", "context-policy-off"] as const)
  test(`actual ${inactive} preserves the default catalogue and does not grant automatic repository snippets`, async (t) => {
    const f = await fixture(t, {
        registered: inactive !== "unregistered-native",
        context: inactive !== "context-policy-off",
      }),
      result = await f.consume();
    assert.equal(
      result.run.state,
      "completed",
      JSON.stringify(result.run.error),
    );
    assert.ok(result.request);
    assert.equal(result.request.tools.length, 21);
    assert.equal(f.children.length, 0);
    if (inactive === "unregistered-native") {
      assert.equal(repositoryData(result.request).snippets.length, 0);
      assert.deepEqual(
        f.engine.context.diagnostics(result.session.id)!.repositoryContext!
          .omissions.unsupportedPaths,
        ["consumer.ts"],
      );
    } else assert.equal(repositoryEntry(result.request), undefined);
  });

for (const mutation of [
  "query",
  "target",
  "barrel-comment",
  "barrel-retarget",
  "deleted-dependency",
  "tsconfig",
  "branch",
] as const)
  test(`actual ${mutation} after native context capture blocks provider dispatch and retains the original frozen messages`, async (t) => {
    let captured = "";
    const f = await fixture(t, {
      beforeModel(engine, workspace, runId) {
        captured = engine.store.getLatestContextRevision(
          engine.store.getRun(runId).sessionId,
        )!.text;
        if (mutation === "query")
          writeFileSync(
            join(workspace.root, "consumer.ts"),
            "// current query changed\n" + CONSUMER,
          );
        if (mutation === "target")
          writeFileSync(
            join(workspace.root, "a.ts"),
            SOURCE.replace("+ 1", "+ 7"),
          );
        if (mutation === "barrel-comment")
          writeFileSync(
            join(workspace.root, "barrel.ts"),
            '// changed actual unopened dependency\nexport { duplicate } from "./a.js";\n',
          );
        if (mutation === "barrel-retarget")
          writeFileSync(
            join(workspace.root, "barrel.ts"),
            'export { duplicate } from "./b.js";\n',
          );
        if (mutation === "deleted-dependency")
          unlinkSync(join(workspace.root, "a.ts"));
        if (mutation === "tsconfig")
          writeFileSync(
            join(workspace.root, "tsconfig.json"),
            JSON.stringify({
              compilerOptions: {
                module: "nodenext",
                target: "es2025",
                strict: false,
              },
              include: ["*.ts"],
            }),
          );
        if (mutation === "branch")
          git(workspace.root, "switch", "--quiet", "-c", "after-capture");
      },
    });
    const result = await f.consume();
    assert.equal(result.run.state, "failed", JSON.stringify(result.run.error));
    assert.equal(f.requests.length, 0);
    assert.ok(
      result.run.error?.code.startsWith("REPOSITORY_") ||
        result.run.error?.code.startsWith("LSP_"),
    );
    assert.equal(
      f.engine.store.getLatestContextRevision(result.session.id)!.text,
      captured,
    );
    assert.ok(captured.includes("repository-evidence"));
    assert.ok(captured.includes("a.ts"));
    assert.equal(f.tableRows(result.run.id).length, 0);
    await f.closeAndAssert();
  });

test("actual same-Turn provider retry cannot dispatch original frozen semantic input after confirmed cleanup changes an unopened dependency", async (t) => {
  let root = "",
    returns = 0;
  const f = await fixture(t, {
    stream() {
      const iterator: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        async next() {
          throw new EngineError(
            "PROVIDER_HTTP_ERROR",
            "Actual semantic retry boundary",
            { status: 429, retryAfterMs: 0 },
          );
        },
        async return() {
          returns++;
          writeFileSync(
            join(root, "barrel.ts"),
            '// source identity changed during original cleanup\nexport { duplicate } from "./a.js";\n',
          );
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
  });
  root = f.root;
  const result = await f.consume();
  assert.equal(result.run.state, "failed");
  assert.equal(f.requests.length, 1);
  assert.equal(returns, 1);
  assert.deepEqual(
    repositoryData(f.requests[0]!).snippets.map((snippet) => snippet.path),
    ["a.ts"],
  );
  const attempts = f.tableRows(result.run.id);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.turnId, attempts[1]!.turnId);
  assert.equal(attempts[0]!.contextRevisionId, attempts[1]!.contextRevisionId);
  assert.equal(attempts[1]!.dispatchedAt, undefined);
  assert.equal(
    f.engine.store.getAttemptCleanup(attempts[0]!.id).state,
    "confirmed",
  );
  assert.equal(
    f.engine.store.getAttemptCleanup(attempts[1]!.id).state,
    "not-dispatched",
  );
  assert.equal(
    f.engine.store.getContextRevision(attempts[0]!.contextRevisionId!).text,
    JSON.stringify(f.requests[0]!.messages),
  );
  await f.closeAndAssert();
});

test("actual explicit repository read tool consumes native locations under its original native tool and Attempt owner", async (t) => {
  const f = await fixture(t, {
    readTool: true,
    stream(request) {
      return (async function* () {
        if (request.turnIndex === 0) {
          yield {
            type: "tool.call" as const,
            call: {
              id: "actual-native-definition",
              name: "repository_context",
              input: QUERY as unknown as JsonObject,
            },
          };
          yield { type: "finish" as const, reason: "tool_calls" as const };
        } else {
          yield {
            type: "text.delta" as const,
            delta: "Actual native read observed.",
          };
          yield { type: "finish" as const, reason: "stop" as const };
        }
      })();
    },
  });
  const result = await f.consume();
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0]!.tools.length, 22);
  assert.ok(
    f.requests[0]!.tools.some((tool) => tool.name === "repository_context"),
  );
  const toolMessage = f.requests[1]!.messages.find(
    (message) =>
      message.role === "tool" &&
      message.toolCallId === "actual-native-definition",
  );
  assert.ok(toolMessage);
  assert.ok(toolMessage.content.includes("a.ts"));
  assert.equal(toolMessage.content.includes("b.ts"), false);
  const snapshot = f.engine.store.getSnapshot(result.session.id);
  assert.equal(snapshot.tools.length, 1);
  assert.equal(snapshot.tools[0]!.state, "completed");
  assert.equal(snapshot.tools[0]!.runId, result.run.id);
  assert.equal(snapshot.approvals.length, 0);
  assert.equal(f.engine.store.listCheckpoints(result.run.id).length, 0);
  const turns = f.engine.store.listTurns(result.run.id),
    firstAttempt = f.engine.store.getAttempt(f.requests[0]!.attemptId!);
  assert.equal(turns[0]!.id, firstAttempt.turnId);
  const part = f.engine.store
    .listParts(turns[0]!.id)
    .find(
      (part) =>
        part.type === "tool" &&
        part.providerCallId === "actual-native-definition",
    );
  assert.ok(part && part.type === "tool");
  assert.equal(part.name, "repository_context");
  assert.equal(part.state, "completed");
  assert.equal(part.runId, result.run.id);
  assert.equal(part.sessionId, result.session.id);
  assert.equal(part.toolCallId, snapshot.tools[0]!.id);
  await f.closeAndAssert();
});

test("actual native semantic snapshots distinguish branch/head and separate worktree roots without reusing stale targets", async (t) => {
  const f = await fixture(t, { context: false }),
    branch = git(f.root, "branch", "--show-current"),
    original = await f.engine.getRepositoryContext(f.workspace.id, QUERY),
    worktreeRoot = join(f.base, "independent-worktree");
  git(f.root, "worktree", "add", "--quiet", "--detach", worktreeRoot, "HEAD");
  const worktree = await command<Workspace>(f.engine, "workspace.open", {
    path: worktreeRoot,
  });
  git(f.root, "switch", "--quiet", "-c", "alternate");
  writeFileSync(
    join(f.root, "barrel.ts"),
    'export { duplicate } from "./b.js";\n',
  );
  git(f.root, "add", "barrel.ts");
  git(
    f.root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-qm",
    "Actual alternate semantic source",
  );
  const alternate = await f.engine.getRepositoryContext(f.workspace.id, QUERY),
    isolated = await f.engine.getRepositoryContext(worktree.id, QUERY);
  assert.equal(alternate.observations[0]!.items[0]!.path, "b.ts");
  assert.equal(isolated.observations[0]!.items[0]!.path, "a.ts");
  assert.equal(alternate.manifest.branch, "alternate");
  assert.notEqual(alternate.manifest.gitHead, original.manifest.gitHead);
  assert.equal(isolated.manifest.root, worktree.root);
  assert.notEqual(
    isolated.manifest.workspaceId,
    alternate.manifest.workspaceId,
  );
  assert.notEqual(alternate.generation, original.generation);
  git(f.root, "switch", "--quiet", branch);
  const restored = await f.engine.getRepositoryContext(f.workspace.id, QUERY);
  assert.equal(restored.observations[0]!.items[0]!.path, "a.ts");
  assert.equal(restored.manifest.branch, branch);
  assert.equal(f.requests.length, 0);
  assert.ok(new Set(f.children.map((child) => child.pid)).size >= 2);
  await f.closeAndAssert();
});

test("actual unopened dependency source identity restarts native project observations and fresh retargeting returns the new same-name declaration", async (t) => {
  const f = await fixture(t, { context: false }),
    before = await f.engine.getRepositoryContext(f.workspace.id, QUERY);
  assert.equal(before.manifest.projectSources?.length, 1);
  assert.equal(before.manifest.projectSources![0]!.serverId, SERVER);
  assert.equal(before.manifest.projectSources![0]!.fileCount, 5);
  assert.ok(/^[a-f0-9]{64}$/.test(before.manifest.projectSources![0]!.sha256));
  writeFileSync(
    join(f.root, "barrel.ts"),
    '// unchanged locations but changed actual dependency\nexport { duplicate } from "./a.js";\n',
  );
  const identity = await f.engine.getRepositoryContext(f.workspace.id, QUERY);
  assert.equal(identity.observations[0]!.items[0]!.path, "a.ts");
  assert.notEqual(
    identity.manifest.projectSources![0]!.sha256,
    before.manifest.projectSources![0]!.sha256,
  );
  assert.notEqual(identity.generation, before.generation);
  assert.equal(f.children.length, 2);
  assert.ok(
    f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null,
    "Old actual native project is closed before the replacement starts",
  );
  writeFileSync(
    join(f.root, "barrel.ts"),
    'export { duplicate } from "./b.js";\n',
  );
  const current = await f.engine.getRepositoryContext(f.workspace.id, QUERY);
  assert.equal(current.observations[0]!.items[0]!.path, "b.ts");
  assert.equal(
    current.observations[0]!.items[0]!.hash,
    sha(SOURCE.replace("+ 1", "+ 2")),
  );
  assert.equal(f.children.length, 3);
  assert.equal(f.requests.length, 0);
  await f.closeAndAssert();
});

test("actual same physical database restart takes new native semantic source evidence instead of reusing prior frozen context", async (t) => {
  const f = await fixture(t),
    first = await f.consume();
  assert.equal(first.run.state, "completed");
  assert.ok(first.request);
  const original = f.engine.store.getLatestContextRevision(first.session.id)!;
  assert.deepEqual(
    repositoryData(first.request).snippets.map((snippet) => snippet.path),
    ["a.ts"],
  );
  await f.engine.close();
  writeFileSync(
    join(f.root, "barrel.ts"),
    'export { duplicate } from "./b.js";\n',
  );
  const restarted = createEngine(f.configuration);
  f.engines.add(restarted);
  f.register(restarted);
  const session = await command<Session>(restarted, "session.create", {
      workspaceId: f.workspace.id,
    }),
    receipt = await command<RunReceipt>(restarted, "run.submit", {
      sessionId: session.id,
      requestId: "actual-reopened-native-source",
      prompt: "Use current independently captured semantic source.",
    });
  const run = await restarted.waitForRun(receipt.runId);
  await restarted.waitForSession(session.id);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  const request = f.requests.find((request) => request.runId === run.id)!;
  assert.ok(request);
  assert.deepEqual(
    repositoryData(request).snippets.map((snippet) => snippet.path),
    ["b.ts"],
  );
  assert.equal(
    restarted.store.getContextRevision(original.id).text,
    original.text,
  );
  assert.notEqual(
    restarted.store.getLatestContextRevision(session.id)!.sha256,
    original.sha256,
  );
  assert.equal(f.requests.length, 2);
  await f.closeAndAssert();
});

test("actual newly accepted steer does not rewrite a captured native semantic request or authorize a changed unopened dependency", async (t) => {
  let captured = "",
    steerId = "";
  const f = await fixture(t, {
    beforeModel(engine, workspace, runId) {
      const run = engine.store.getRun(runId);
      captured = engine.store.getLatestContextRevision(run.sessionId)!.text;
      engine.scheduler.pause(run.sessionId);
      steerId = engine.scheduler.accept({
        sessionId: run.sessionId,
        requestId: "after-semantic-capture",
        prompt: "New exact semantic steering constraint.",
        delivery: "steer",
        config: run.config,
      }).inputId;
      writeFileSync(
        join(workspace.root, "barrel.ts"),
        '// original project source identity changed\nexport { duplicate } from "./a.js";\n',
      );
    },
  });
  const result = await f.consume();
  assert.equal(result.run.state, "failed", JSON.stringify(result.run.error));
  assert.equal(f.requests.length, 0);
  assert.equal(
    f.engine.store.getLatestContextRevision(result.session.id)!.text,
    captured,
  );
  assert.equal(
    captured.includes("New exact semantic steering constraint."),
    false,
  );
  assert.equal(f.engine.store.getInput(steerId).state, "pending");
  assert.equal(
    f.engine.store.getInput(steerId).prompt,
    "New exact semantic steering constraint.",
  );
  await f.closeAndAssert();
});

test("actual native in-flight navigation cancellation rejects its original read and Engine close joins the physical producer", async (t) => {
  const f = await fixture(t, { context: false }),
    cancel = new AbortController(),
    original = StdioLspConnection.prototype.request;
  let entered = 0;
  t.mock.method(
    StdioLspConnection.prototype,
    "request",
    function (this: StdioLspConnection, ...args: Parameters<typeof original>) {
      const pending = original.apply(this, args);
      if (args[0] === "textDocument/definition") {
        entered++;
        cancel.abort();
      }
      return pending;
    },
  );
  await assert.rejects(
    f.engine.getRepositoryContext(f.workspace.id, QUERY, cancel.signal),
    (error) => error instanceof EngineError && error.code === "CANCELLED",
  );
  assert.equal(
    entered,
    1,
    "Original native request method is actually called before cancellation",
  );
  assert.equal(f.children.length, 1);
  assert.equal(f.requests.length, 0);
  await f.closeAndAssert();
});

test("actual mixed native and unsupported paths report partial coverage while tiny shared context preserves the required user exchange", async (t) => {
  const f = await fixture(t, {
    slotBytes: 32,
    maxContextBytes: 2048,
    emptyTools: true,
  });
  const partial = await f.engine.getRepositoryContext(f.workspace.id, {
    kind: "symbols",
    paths: ["a.ts", "unsupported.py"],
  });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.unsupportedPaths, ["unsupported.py"]);
  assert.equal(partial.observations.length, 1);
  assert.equal(partial.observations[0]!.items[0]!.name, "duplicate");
  const prompt = 'Exact required current request "quotes" 한글😀',
    result = await f.consume(prompt);
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.equal(result.request.messages.at(-1)!.content, prompt);
  assert.equal(repositoryEntry(result.request), undefined);
  const diagnostic = f.engine.context.diagnostics(result.session.id)!;
  assert.equal(diagnostic.repositoryContext!.omissions.message, true);
  assert.ok(diagnostic.plan.bytes <= 2048);
  assert.equal(
    diagnostic.plan.bytes,
    Buffer.byteLength(JSON.stringify(result.request.messages)) +
      diagnostic.plan.reservations.envelopeBytes,
  );
  await f.closeAndAssert();
});

test("actual already-cancelled repository caller does not start a native semantic producer or coding owner", async (t) => {
  const f = await fixture(t, { context: false }),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.engine.getRepositoryContext(f.workspace.id, QUERY, controller.signal),
    (error) => error instanceof EngineError && error.code === "ABORTED",
  );
  assert.equal(f.children.length, 0);
  assert.equal(f.requests.length, 0);
  await f.closeAndAssert();
});

test("actual cancelled native project source read drains its original physical FileHandle before Engine close resolves", async (t) => {
  const f = await fixture(t, { context: false });
  let markEntered!: () => void;
  let releaseRead!: () => void;
  let markPhysicallyClosed!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const physicallyClosed = new Promise<void>((resolve) => {
    markPhysicallyClosed = resolve;
  });
  let held = false;
  let actualBytesRead = 0;
  let handleClosed = false;
  const originalOpen = fsPromises.open;
  const openMock = t.mock.method(
    fsPromises,
    "open",
    async function (...args: Parameters<typeof originalOpen>) {
      const handle = await originalOpen.apply(fsPromises, args);
      if (String(args[0]) === join(f.root, "a.ts")) {
        const originalRead = handle.read;
        const originalClose = handle.close;
        t.mock.method(handle, "read", async function (...readArgs: unknown[]) {
          const result = await Reflect.apply(originalRead, handle, readArgs);
          if (!held && result.bytesRead > 0) {
            held = true;
            actualBytesRead = result.bytesRead;
            markEntered();
            await readGate;
          }
          return result;
        });
        t.mock.method(handle, "close", async function () {
          await originalClose.call(handle);
          handleClosed = true;
          markPhysicallyClosed();
        });
      }
      return handle;
    },
  );
  syncBuiltinESMExports();
  const cancel = new AbortController();
  const observation = f.engine.lsp.projectSources(
    f.workspace,
    SERVER,
    cancel.signal,
  );
  // Observe cancellation immediately; the successful original OS read remains held.
  const rejected = assert.rejects(
    observation,
    (error) => error instanceof EngineError && error.code === "CANCELLED",
  );
  let closing: Promise<void> | undefined;
  let closeResolved = false;
  try {
    await entered;
    assert.equal(actualBytesRead, Buffer.byteLength(SOURCE));
    cancel.abort();
    await rejected;
    assert.equal(handleClosed, false);
    closing = f.engine.close().then(() => {
      closeResolved = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(
      closeResolved,
      false,
      "Host close must join the original read, not only its cancelled caller wrapper",
    );
    assert.equal(handleClosed, false);
    releaseRead();
    await closing;
    assert.equal(
      handleClosed,
      true,
      "Original physical FileHandle.close must succeed before host close resolves",
    );
    assert.equal(closeResolved, true);
    assert.equal(
      f.children.length,
      0,
      "Pure project source capture starts no native semantic producer",
    );
    assert.equal(f.requests.length, 0);
  } finally {
    releaseRead();
    if (held) await physicallyClosed;
    await closing;
    openMock.mock.restore();
    syncBuiltinESMExports();
  }
});
