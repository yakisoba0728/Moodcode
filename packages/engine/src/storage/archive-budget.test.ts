import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { EngineError, type InputDocumentAttachment } from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import {
  exportEngineArchive,
  importEngineArchive,
  inspectArchivedChildDocumentStorage,
  validateEngineArchive,
  type ArchiveDocumentBudgetOptions,
  type ValidateEngineArchiveOptions,
} from "../index.js";
import type { ProviderAdapter } from "../ports.js";
import {
  CHILD_DOCUMENT_READ_LIMITS,
  ChildDocumentReadFrame,
  createArchiveDocumentReadFrame,
  createChildDocumentReadFrame,
  MAX_ARCHIVE_DOCUMENT_BUDGET_MS,
} from "./child-document-reader.js";
import { SqliteStore } from "./index.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-archive-budget-")),
    ),
    repository = join(directory, "repository"),
    dbPath = join(directory, "engine.sqlite"),
    artifactDir = join(directory, "artifacts");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", "--template=", repository]);
  writeFileSync(
    join(repository, "source.txt"),
    "Local native archive budget fixture.\n",
  );
  execFileSync("git", ["-C", repository, "add", "source.txt"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "core.hooksPath=",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Fixture",
  ]);
  const entered = gate(),
    release = gate(),
    refs: InputDocumentAttachment[] = [];
  let child: ReturnType<typeof createEngine> | undefined,
    calls = 0;
  const provider: ProviderAdapter = {
    id: "archive-budget-fixture",
    async *streamTurn(request, signal) {
      calls++;
      if (
        request.messages.find((message) => message.role === "user")?.content ===
        "ROOT"
      ) {
        entered.resolve();
        yield { type: "progress" };
        let abort!: () => void;
        try {
          await Promise.race([
            release.promise,
            new Promise<void>((done) => {
              abort = done;
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
        } finally {
          signal.removeEventListener("abort", abort);
        }
      } else {
        assert.ok(child);
        assert.ok(request.sessionId);
        for (let number = 0; number < 4; number++)
          refs.push(
            await child.importDocument(
              request.sessionId,
              Buffer.from(
                `%PDF-1.7\nActual isolated child document ${number}.\n`,
              ),
            ),
          );
      }
      yield { type: "text.delta", delta: "Actual local provider completed." };
      yield { type: "finish", reason: "stop" };
    },
  };
  const engine = createEngine({
    dbPath,
    artifactDir,
    providers: [provider],
    tools: [],
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "plan",
      limits: {
        maxTurns: 8,
        maxToolCalls: 8,
        maxOutputBytes: 65536,
        maxDurationMs: 30000,
        toolTimeoutMs: 2000,
        maxContextBytes: 262144,
      },
    },
    configureChild(value) {
      child = value;
    },
  });
  t.after(async () => {
    release.resolve();
    try {
      await engine.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({
    id: "workspace",
    root: repository,
    gitRoot: repository,
    branch: null,
    createdAt,
  });
  engine.store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Archive budget",
    createdAt,
  });
  const worktree = await engine.createWorktree("session", "child");
  const root = engine.scheduler.submitLegacy({
    sessionId: "session",
    requestId: "root",
    prompt: "ROOT",
    config: engine.getCapabilities().defaults,
  });
  await entered.promise;
  const task = await engine.startChildTask({
    sessionId: "session",
    requestId: "child",
    parentRunId: root.runId,
    worktreeId: worktree.id,
    prompt: "CHILD",
    tools: [],
    allocation: { turns: 1, toolCalls: 1, outputBytes: 2048, durationMs: 5000 },
  });
  assert.equal(
    (await engine.children.tasks.wait("session", task.id)).state,
    "completed",
  );
  release.resolve();
  assert.equal((await engine.waitForRun(root.runId)).state, "completed");
  await engine.close();
  const opaque = Buffer.alloc(2 * 1024 * 1024, 0x73);
  writeFileSync(join(artifactDir, "large-opaque-fixture.bin"), opaque);
  return {
    directory,
    dbPath,
    artifactDir,
    root,
    task,
    refs,
    opaque,
    calls: () => calls,
    source: { dbPath, artifactDir, destination: join(directory, "archive") },
  };
}
/** Advances one monotonic clock after each real proof frame is born, never resets an operation's clock. */
function elapsedAtProof(t: TestContext, elapsed: number, first?: () => void) {
  let now = 0;
  const frames = new Set<ChildDocumentReadFrame>(),
    descriptor = Object.getOwnPropertyDescriptor(
      ChildDocumentReadFrame.prototype,
      "remainingMetadataBytes",
    )!;
  t.mock.method(performance, "now", () => now);
  t.mock.getter(
    ChildDocumentReadFrame.prototype,
    "remainingMetadataBytes",
    function (this: ChildDocumentReadFrame) {
      if (!frames.has(this)) {
        frames.add(this);
        now += elapsed;
        first?.();
      }
      return descriptor.get!.call(this) as number;
    },
  );
  return frames;
}
function noPartials(directory: string) {
  assert.deepEqual(
    readdirSync(directory).filter((name) =>
      /^\.moodcode-(archive|import)-/.test(name),
    ),
    [],
  );
}
function nativeEvents(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM session_events ORDER BY session_id,seq")
      .all();
  } finally {
    db.close();
  }
}

test("ordinary document frames retain the two-second ceiling and archive frames widen only duration", () => {
  assert.equal(createChildDocumentReadFrame().limits.maxDurationMs, 2000);
  assert.equal(createArchiveDocumentReadFrame().limits.maxDurationMs, 2000);
  assert.throws(
    () => createChildDocumentReadFrame({ limits: { maxDurationMs: 2001 } }),
    code("INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS"),
  );
  assert.throws(
    () =>
      new ChildDocumentReadFrame(
        { limits: { maxDurationMs: 30000 } },
        Symbol("fake archive") as never,
      ),
    code("INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS"),
  );
  const widened = createArchiveDocumentReadFrame({
    archiveDocumentBudgetMs: MAX_ARCHIVE_DOCUMENT_BUDGET_MS,
  });
  assert.deepEqual(widened.limits, {
    ...CHILD_DOCUMENT_READ_LIMITS,
    maxDurationMs: 30000,
  });
  assert.ok(Object.isFrozen(widened.limits));
  for (const value of [0, -1, 1.5, NaN, Infinity, 30001, "30000", null])
    assert.throws(
      () =>
        createArchiveDocumentReadFrame({
          archiveDocumentBudgetMs: value as number,
        }),
      code("INVALID_ARCHIVE_DOCUMENT_BUDGET"),
    );
});

test("public export, validation and import reject invalid budget data before filesystem access or traps", async () => {
  const base = {
    dbPath: "/never-open/engine.sqlite",
    artifactDir: "/never-open/artifacts",
    directory: "/never-open/archive",
    destination: "/never-open/result",
  };
  let traps = 0;
  const accessor = Object.defineProperty(
    { ...base },
    "archiveDocumentBudgetMs",
    {
      enumerable: true,
      get() {
        traps++;
        throw new Error("Budget getter executed");
      },
    },
  );
  const hidden = Object.defineProperty({ ...base }, "archiveDocumentBudgetMs", {
    value: 30000,
    enumerable: false,
  });
  const proxy = new Proxy(base, {
    get() {
      traps++;
      throw new Error("Proxy get");
    },
    ownKeys() {
      traps++;
      throw new Error("Proxy keys");
    },
    getPrototypeOf() {
      traps++;
      throw new Error("Proxy prototype");
    },
  });
  for (const options of [
    ...[0, -1, 1.5, NaN, Infinity, 30001, "30000", null].map((value) => ({
      ...base,
      archiveDocumentBudgetMs: value,
    })),
    accessor,
    hidden,
    proxy,
  ]) {
    await assert.rejects(
      exportEngineArchive(options as never),
      code("INVALID_ARCHIVE_DOCUMENT_BUDGET"),
    );
    assert.throws(
      () => validateEngineArchive(options as never),
      code("INVALID_ARCHIVE_DOCUMENT_BUDGET"),
    );
    await assert.rejects(
      importEngineArchive(options as never),
      code("INVALID_ARCHIVE_DOCUMENT_BUDGET"),
    );
  }
  assert.equal(traps, 0);
});

test("default export expires one real proof frame and leaves no published or partial archive", async (t) => {
  const f = await fixture(t),
    events = nativeEvents(f.dbPath),
    frames = elapsedAtProof(t, 2500);
  await assert.rejects(
    exportEngineArchive(f.source),
    code("CHILD_DOCUMENT_STORAGE_TIME_LIMIT"),
  );
  assert.equal(frames.size, 1);
  assert.equal([...frames][0]!.limits.maxDurationMs, 2000);
  assert.equal(existsSync(f.source.destination), false);
  noPartials(f.directory);
  assert.deepEqual(nativeEvents(f.dbPath), events);
  assert.equal(f.calls(), 2);
});

test("explicit host budget is consumed by real export, validation and import without replay or weakened integrity", async (t) => {
  const f = await fixture(t),
    events = nativeEvents(f.dbPath),
    frames = elapsedAtProof(t, 2500),
    options: ArchiveDocumentBudgetOptions = { archiveDocumentBudgetMs: 30000 };
  const archive = await exportEngineArchive({ ...f.source, ...options });
  const validation: ValidateEngineArchiveOptions = {
    directory: archive.directory,
    ...options,
  };
  assert.equal(
    validateEngineArchive(validation).manifestSha256,
    archive.manifestSha256,
  );
  const imported = await importEngineArchive({
    ...validation,
    destination: join(f.directory, "imported"),
  });
  assert.equal(
    frames.size,
    3,
    "Each operation owns one continuous proof frame, including every child",
  );
  for (const frame of frames)
    assert.deepEqual(frame.limits, {
      ...CHILD_DOCUMENT_READ_LIMITS,
      maxDurationMs: 30000,
    });
  assert.equal(archive.manifest.documentAudit?.coverage, "complete");
  assert.equal(archive.manifest.documentAudit?.children.length, 1);
  assert.equal(imported.executionResumed, false);
  assert.equal(imported.sessionsPaused, 1);
  assert.equal(imported.childSessionsPaused, 1);
  assert.equal(imported.documentAuditCoverage, "complete");
  assert.deepEqual(nativeEvents(f.dbPath), events);
  const importedEvents = nativeEvents(imported.dbPath);
  assert.deepEqual(
    importedEvents.slice(0, events.length),
    events,
    "Import retains exact immutable execution history",
  );
  assert.deepEqual(
    importedEvents.slice(events.length).map((row) => row.type),
    ["session.document.updated", "session.paused"],
  );
  assert.ok(
    importedEvents
      .slice(events.length)
      .every((row) => row.run_id === null && row.attempt_id === null),
    "Relocation and pause do not append execution events",
  );
  assert.deepEqual(
    readFileSync(join(imported.artifactDir, "large-opaque-fixture.bin")),
    f.opaque,
  );
  const member = archive.manifest.documentAudit!.children[0]!;
  for (const ref of f.refs) {
    const path = join(
        imported.directory,
        "data",
        member.artifactPrefix,
        "input-documents",
        ref.id + ".blob",
      ),
      bytes = readFileSync(path);
    assert.equal(bytes.length, ref.bytes);
    assert.equal(sha(bytes), ref.sha256);
  }
  const primary = new SqliteStore(imported.dbPath),
    child = new SqliteStore(
      join(imported.directory, "data", member.database.file),
    );
  try {
    assert.equal(primary.getSessionControl("session").paused, true);
    assert.equal(primary.getRun(f.root.runId).state, "completed");
    assert.equal(
      child.getSessionControl(member.record.binding.child.sessionId).paused,
      true,
    );
    assert.equal(
      child.getRun(member.record.binding.child.runId!).state,
      "completed",
    );
  } finally {
    primary.close();
    child.close();
  }
  assert.equal(f.calls(), 2);
  noPartials(f.directory);
});

test("explicit archive deadline remains finite and does not reset across the proof", async (t) => {
  const f = await fixture(t),
    frames = elapsedAtProof(t, 30000);
  await assert.rejects(
    exportEngineArchive({ ...f.source, archiveDocumentBudgetMs: 30000 }),
    code("CHILD_DOCUMENT_STORAGE_TIME_LIMIT"),
  );
  assert.equal(frames.size, 1);
  assert.equal(existsSync(f.source.destination), false);
  noPartials(f.directory);
});

test("larger archive budget does not suppress cancellation or retain private partial data", async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  await assert.rejects(
    exportEngineArchive({
      ...f.source,
      archiveDocumentBudgetMs: 30000,
      signal: AbortSignal.abort(),
    }),
    code("ARCHIVE_ABORTED"),
  );
  const frames = elapsedAtProof(t, 1, () => controller.abort());
  await assert.rejects(
    exportEngineArchive({
      ...f.source,
      archiveDocumentBudgetMs: 30000,
      signal: controller.signal,
    }),
    code("CHILD_DOCUMENT_STORAGE_ABORTED"),
  );
  assert.equal(frames.size, 1);
  assert.equal(existsSync(f.source.destination), false);
  noPartials(f.directory);
  assert.equal(f.calls(), 2);
});

test("longer host proof retains the exact source PDF integrity guard", async (t) => {
  const f = await fixture(t),
    childPath = join(
      f.artifactDir,
      "children",
      f.task.id,
      "artifacts",
      "input-documents",
      f.refs[0]!.id + ".blob",
    ),
    original = readFileSync(childPath);
  const modified = Buffer.from(original);
  modified[modified.length - 2] = modified[modified.length - 2]! ^ 1;
  writeFileSync(childPath, modified);
  await assert.rejects(
    exportEngineArchive({ ...f.source, archiveDocumentBudgetMs: 30000 }),
    code("ARCHIVE_DOCUMENT_INTEGRITY_FAILED"),
  );
  assert.equal(existsSync(f.source.destination), false);
  noPartials(f.directory);
  assert.equal(f.calls(), 2);
});

test("explicit archive budget cannot widen standalone historical inspection", async (t) => {
  const f = await fixture(t),
    archive = await exportEngineArchive({
      ...f.source,
      archiveDocumentBudgetMs: 30000,
    });
  const request = {
    directory: archive.directory,
    expectedManifestSha256: archive.manifestSha256,
    sessionId: "session",
    sourceRunId: f.root.runId,
    taskIds: [f.task.id],
  };
  await assert.rejects(
    inspectArchivedChildDocumentStorage({
      ...request,
      archiveDocumentBudgetMs: 30000,
    } as never),
    code("INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS"),
  );
  await assert.rejects(
    inspectArchivedChildDocumentStorage({
      ...request,
      limits: { maxDurationMs: 2001 },
    }),
    code("INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS"),
  );
  const frames = elapsedAtProof(t, 2500);
  await assert.rejects(
    inspectArchivedChildDocumentStorage(request),
    code("CHILD_DOCUMENT_STORAGE_TIME_LIMIT"),
  );
  assert.equal(frames.size, 1);
  assert.equal([...frames][0]!.limits.maxDurationMs, 2000);
  assert.equal(f.calls(), 2);
});
