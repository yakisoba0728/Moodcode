import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  EngineError,
  type JsonObject,
  type RunReceipt,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../engine.js";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import type { LifecycleHookRegistration } from "../lifecycle/index.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import type {
  AppendProposalRevisionResult,
  ProposalSelection,
  ProposalPage,
  ProposalSet,
} from "./types.js";
import type {
  PreparedProposalContribution,
  ProposalReadonlyDiff,
} from "./overlay.js";
import { knowledgeHash } from "../knowledge/validation.js";

type Engine = ReturnType<typeof createEngine>;
const ORIGINAL =
  'export const untouchedUserDraft = "original user bytes 한글😀";\n';
const MARKER = "pending_overlay_marker_actual_unapplied";
const PROPOSED = `export const untouchedUserDraft = "${MARKER}";\n`;
const SECOND =
  'export const untouchedUserDraft = "second unapplied proposal";\n';
const ID = "actual-engine-proposal";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stop: ProviderEvent = { type: "finish", reason: "stop" };
const CODE = () => (error: unknown) =>
  error instanceof EngineError && error.code.includes("PROPOSAL");
const capturedText = (value: unknown, body: string) =>
  JSON.stringify(value).includes(JSON.stringify(body).slice(1, -1));
function api<T>(engine: Engine, method: string, ...args: unknown[]): T {
  const fn = Reflect.get(engine, method);
  assert.equal(typeof fn, "function", `Actual Engine must expose ${method}`);
  return Reflect.apply(fn, engine, args) as T;
}
async function command<T>(
  engine: Engine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const result = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.result as unknown as T;
}
function dbRead<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function coreRows(file: string) {
  return dbRead(file, (db) =>
    Object.fromEntries(
      [
        "workspaces",
        "sessions",
        "inputs",
        "runs",
        "messages",
        "tools",
        "approvals",
        "checkpoints",
        "provider_attempts",
        "summary_attempts",
        "knowledge_generations",
      ].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  );
}
function proposalRows(file: string) {
  return dbRead(file, (db) =>
    Object.fromEntries(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'proposal%'",
        )
        .all()
        .map((row) => {
          const table = String(row.name);
          assert.match(table, /^[a-z_]+$/);
          return [
            table,
            db
              .prepare(
                `SELECT * FROM ${table} ORDER BY ${db.prepare("SELECT wr FROM pragma_table_list WHERE name=?").get(table)!.wr === 1 ? "id" : "rowid"}`,
              )
              .all(),
          ];
        }),
    ),
  );
}
interface DraftOptions {
  enabled?: boolean;
  context?: boolean;
  slotBytes?: number;
  maxContextBytes?: number;
  sharedSources?: boolean;
  stream?: (
    request: TurnRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ProviderEvent>;
  beforeModel?: (engine: Engine, runId: string) => Promise<void> | void;
}
async function fixture(t: TestContext, options: DraftOptions = {}) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-proposal-engine-")),
    ),
    root = join(base, "repo"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "source.ts"), ORIGINAL);
  writeFileSync(
    join(root, "unrelated.txt"),
    "Unrelated original user content.\n",
  );
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: "actual-proposal-consumer",
    streamTurn(request, signal) {
      requests.push(structuredClone(request));
      return (
        options.stream?.(request, signal) ??
        (async function* (): AsyncGenerator<ProviderEvent> {
          yield {
            type: "text.delta",
            delta: "Actual coding consumer completed.",
          };
          yield stop;
        })()
      );
    },
  };
  let active!: Engine;
  const hook: LifecycleHookRegistration = {
    id: "actual-proposal-boundary",
    revision: 1,
    stages: ["before-model"],
    timeoutMs: 1000,
    failurePolicy: "stop",
    callback: async (invocation) => {
      await options.beforeModel?.(active, invocation.identity.runId);
      return { kind: "observe" };
    },
  };
  const contextData: LifecycleHookRegistration = {
    id: "actual-proposal-shared-context",
    revision: 1,
    stages: ["model-context"],
    timeoutMs: 1000,
    failurePolicy: "stop",
    callback: (invocation) => {
      assert.equal(invocation.stage, "model-context");
      if (invocation.stage !== "model-context") return { kind: "observe" };
      return {
        kind: "context-data",
        expectedContextSha256: invocation.metadata.contextSha256,
        data: { note: "Exact independently selected lifecycle data." },
      };
    },
  };
  const config: EngineOptions & {
    proposals?: boolean;
    proposalContextPolicy?: { proposalIds: string[]; slotBytes: number };
  } = {
    dbPath,
    artifactDir,
    providers: [provider],
    tools: [],
    ...(options.enabled === false ? {} : { proposals: true }),
    ...(options.context === false
      ? {}
      : {
          proposalContextPolicy: {
            proposalIds: [ID],
            slotBytes: options.slotBytes ?? 16384,
          },
        }),
    ...(options.beforeModel || options.sharedSources
      ? {
          lifecycleHooks: [
            ...(options.beforeModel ? [hook] : []),
            ...(options.sharedSources ? [contextData] : []),
          ],
        }
      : {}),
    ...(options.sharedSources
      ? {
          lifecycleContextSlotBytes: 512,
          repositoryContextPolicy: {
            query: { kind: "symbols", paths: ["source.ts"] },
            slotBytes: 4096,
            exactRanges: [
              {
                path: "source.ts",
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: ORIGINAL.split("\n")[0]!.length },
                },
              },
            ],
          },
        }
      : {}),
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "plan",
      limits: {
        maxTurns: 3,
        maxDurationMs: 12000,
        maxContextBytes: options.maxContextBytes ?? 65536,
      },
      budgets: { maxProviderAttempts: 3, retryBaseDelayMs: 0 },
    },
  };
  active = createEngine(config);
  const engine = active,
    engines = new Set([engine]);
  t.after(async () => {
    for (const current of engines) await current.close();
    rmSync(base, { recursive: true, force: true });
  });
  const workspace = await command<Workspace>(engine, "workspace.open", {
    path: root,
  });
  const stage = (
    input: {
      requestId?: string;
      expectedRevision?: number;
      content?: string;
      proposalId?: string;
      signal?: AbortSignal;
    } = {},
    current = active,
  ) =>
    api<Promise<AppendProposalRevisionResult>>(current, "createProposalSet", {
      workspaceId: workspace.id,
      requestId: input.requestId ?? randomUUID(),
      proposalId: input.proposalId ?? ID,
      expectedRevision: input.expectedRevision ?? 0,
      changes: [
        {
          path: "source.ts",
          expectedHash: sha(ORIGINAL),
          content: input.content ?? PROPOSED,
        },
      ],
      ...(input.signal ? { signal: input.signal } : {}),
    });
  const read = (current = active) => {
    const result = api<ProposalSelection | undefined>(
      current,
      "getProposalSet",
      workspace.id,
      ID,
    );
    assert.ok(result);
    return result;
  };
  const diff = (current = active, extra: Record<string, unknown> = {}) =>
    api<Promise<ProposalReadonlyDiff>>(current, "getProposalDiff", {
      workspaceId: workspace.id,
      proposalId: ID,
      ...extra,
    });
  const consume = async (
    prompt = 'The exact current input must remain "quoted" 한글😀.',
    current = active,
    config: JsonObject = {},
  ) => {
    const session = await command<Session>(current, "session.create", {
        workspaceId: workspace.id,
      }),
      before = requests.length;
    const receipt = await command<RunReceipt>(current, "run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt,
      config,
    });
    const run = await current.waitForRun(receipt.runId);
    await current.waitForSession(session.id);
    return {
      session,
      run,
      request: requests[before],
      newRequests: requests.slice(before),
    };
  };
  const assertUntouched = () => {
    assert.equal(readFileSync(join(root, "source.ts"), "utf8"), ORIGINAL);
    assert.equal(
      readFileSync(join(root, "unrelated.txt"), "utf8"),
      "Unrelated original user content.\n",
    );
  };
  const reopen = (extra: Partial<typeof config> = {}) => {
    active = createEngine({ ...config, ...extra });
    engines.add(active);
    return active;
  };
  return {
    base,
    root,
    dbPath,
    artifactDir,
    config,
    engine,
    workspace,
    requests,
    engines,
    stage,
    read,
    diff,
    consume,
    assertUntouched,
    reopen,
  };
}
const overlay = (request: TurnRequest) =>
  request.messages.filter((message) =>
    message.content.startsWith("[Moodcode pending proposal overlay v1]\n"),
  );

test("actual host-native proposal staging and readonly diff allocate no coding/effect owner and leave user bytes/checkpoints untouched", async (t) => {
  const f = await fixture(t),
    before = coreRows(f.dbPath);
  const created = await f.stage();
  f.assertUntouched();
  assert.equal(created.kind, "created");
  assert.equal(created.set.headRevision, 1);
  assert.equal(created.revision.revision, 1);
  assert.equal(created.set.revisionId, created.revision.id);
  assert.equal(created.set.revisionSha256, created.revision.sha256);
  assert.equal(created.set.status, "pending");
  assert.equal(created.revision.previousId, null);
  assert.equal(created.revision.expectedHeadRevision, 0);
  assert.equal(
    created.revision.totalBytes,
    Buffer.byteLength(ORIGINAL) + Buffer.byteLength(PROPOSED),
  );
  const file = created.revision.files[0]!;
  assert.equal(file.operation, "update");
  assert.equal(file.before!.sha256, sha(ORIGINAL));
  assert.equal(file.after!.sha256, sha(PROPOSED));
  for (const reference of [file.before!, file.after!]) {
    assert.equal(reference.workspaceId, f.workspace.id);
    assert.equal(reference.proposalId, ID);
    assert.equal(reference.revisionId, created.revision.id);
    assert.equal(reference.operationIndex, 0);
    assert.ok(!("runId" in reference));
    assert.ok(!("toolCallId" in reference));
  }
  assert.deepEqual(coreRows(f.dbPath), before);
  assert.equal(f.requests.length, 0);
  const history = proposalRows(f.dbPath),
    result = await f.diff(),
    list = await api<Promise<ProposalPage<ProposalSet>>>(
      f.engine,
      "listProposalSets",
      { workspaceId: f.workspace.id, limit: 1 },
    );
  assert.deepEqual(f.read(), { set: created.set, revision: created.revision });
  assert.deepEqual(list.items, [created.set]);
  assert.equal(list.next, null);
  assert.equal(result.authority, "observation-only");
  assert.equal(result.state, "captured-history");
  assert.equal(result.proposalStatus, "pending");
  assert.equal(result.sourceFreshness, "current");
  assert.equal(result.revisionId, created.revision.id);
  assert.equal(result.revisionSha256, created.revision.sha256);
  assert.equal(
    result.sourceManifestSha256,
    created.revision.sourceManifestSha256,
  );
  assert.equal(result.files[0]!.before, ORIGINAL);
  assert.equal(result.files[0]!.after, PROPOSED);
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result)));
  const prepare = DatabaseSync.prototype.prepare;
  let bodyReads = 0;
  const cappedRead = t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, sql: string) {
      if (/SELECT\s+content\s+FROM\s+proposal_blobs/iu.test(sql)) bodyReads++;
      return prepare.call(this, sql);
    },
  );
  try {
    const capped = await f.diff(f.engine, { maxBytes: result.bytes - 1 });
    assert.equal(capped.files.length, 0);
    assert.deepEqual(capped.omissions, [
      { path: "source.ts", reason: "page-budget" },
    ]);
    assert.ok(capped.bytes <= result.bytes - 1);
    assert.equal(bodyReads, 0);
  } finally {
    cappedRead.mock.restore();
  }
  assert.deepEqual(proposalRows(f.dbPath), history);
  assert.deepEqual(coreRows(f.dbPath), before);
  f.assertUntouched();
});

test("an exact proposal request duplicate preserves original native revision while changed input with the same request rejects", async (t) => {
  const f = await fixture(t);
  await f.stage({ requestId: "exact-stage-request" });
  const original = structuredClone(f.read()),
    rows = proposalRows(f.dbPath);
  const duplicate = await f.stage({ requestId: "exact-stage-request" });
  assert.equal(duplicate.kind, "duplicate");
  assert.deepEqual(duplicate.revision, original.revision);
  assert.deepEqual(f.read(), original);
  assert.deepEqual(proposalRows(f.dbPath), rows);
  await assert.rejects(
    f.stage({ requestId: "exact-stage-request", content: SECOND }),
    CODE(),
  );
  assert.deepEqual(f.read(), original);
  assert.deepEqual(proposalRows(f.dbPath), rows);
  assert.equal(f.requests.length, 0);
  f.assertUntouched();
});

test("an exact historical proposal request remains a readonly duplicate after its captured user source has changed", async (t) => {
  const f = await fixture(t),
    created = await f.stage({
      requestId: "historical-source-independent-duplicate",
    }),
    core = coreRows(f.dbPath),
    rows = proposalRows(f.dbPath);
  writeFileSync(
    join(f.root, "source.ts"),
    "User changed physical source after storing the pending revision.\n",
  );
  const duplicate = await f.stage({
    requestId: "historical-source-independent-duplicate",
  });
  assert.equal(duplicate.kind, "duplicate");
  assert.deepEqual(duplicate.revision, created.revision);
  assert.deepEqual(duplicate.set, created.set);
  assert.deepEqual(proposalRows(f.dbPath), rows);
  assert.deepEqual(coreRows(f.dbPath), core);
  assert.equal(f.requests.length, 0);
  assert.equal(
    readFileSync(join(f.root, "source.ts"), "utf8"),
    "User changed physical source after storing the pending revision.\n",
  );
});

test("actual original proposal revision append uses head CAS and keeps prior captured body immutable", async (t) => {
  const f = await fixture(t);
  await f.stage({ requestId: "first-revision-receipt" });
  const original = structuredClone(f.read()),
    originalDiff = await f.diff();
  await f.stage({ expectedRevision: 1, content: SECOND });
  const updated = structuredClone(f.read()),
    rows = proposalRows(f.dbPath);
  assert.equal(updated.set.headRevision, 2);
  assert.equal(updated.revision.revision, 2);
  assert.equal(updated.revision.previousId, original.revision.id);
  assert.equal(updated.revision.expectedHeadRevision, 1);
  assert.notDeepEqual(updated, original);
  assert.ok(capturedText(await f.diff(), SECOND));
  assert.ok(capturedText(originalDiff, PROPOSED));
  const duplicate = await f.stage({ requestId: "first-revision-receipt" });
  assert.equal(duplicate.kind, "duplicate");
  assert.deepEqual(duplicate.revision, original.revision);
  assert.deepEqual(duplicate.set, updated.set);
  assert.deepEqual(f.read(), updated);
  assert.deepEqual(proposalRows(f.dbPath), rows);
  await assert.rejects(
    f.stage({ expectedRevision: 1, content: "different losing revision" }),
    CODE(),
  );
  assert.deepEqual(f.read(), updated);
  assert.deepEqual(proposalRows(f.dbPath), rows);
  f.assertUntouched();
});

test("readonly proposal diff after a physical external edit retains original preimage and unapplied postimage without allocating effects", async (t) => {
  const f = await fixture(t);
  await f.stage();
  const history = proposalRows(f.dbPath),
    core = coreRows(f.dbPath);
  writeFileSync(join(f.root, "source.ts"), "Actual unrelated external edit.\n");
  const result = await f.diff();
  assert.equal(result.sourceFreshness, "stale");
  assert.equal(result.authority, "observation-only");
  assert.equal(result.state, "captured-history");
  assert.equal(result.proposalStatus, "pending");
  assert.equal(result.files[0]!.before, ORIGINAL);
  assert.equal(result.files[0]!.after, PROPOSED);
  assert.deepEqual(proposalRows(f.dbPath), history);
  assert.deepEqual(coreRows(f.dbPath), core);
  assert.equal(f.requests.length, 0);
  assert.equal(
    readFileSync(join(f.root, "source.ts"), "utf8"),
    "Actual unrelated external edit.\n",
  );
});

test("actual coding pending overlay reaches exact native ContextRevision and Attempt request without making disk content current evidence", async (t) => {
  const f = await fixture(t),
    created = await f.stage(),
    history = proposalRows(f.dbPath),
    result = await f.consume();
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  const messages = overlay(result.request);
  assert.equal(messages.length, 1);
  const data = JSON.parse(messages[0]!.content.split("\n").slice(1).join("\n"));
  assert.equal(data.state, "pending-unapplied");
  assert.equal(data.authority, "read-only");
  assert.equal(data.workspaceId, f.workspace.id);
  assert.ok(messages[0]!.content.includes(MARKER));
  assert.equal(data.proposals[0].revisionId, created.revision.id);
  assert.equal(data.proposals[0].revisionSha256, created.revision.sha256);
  assert.equal(
    data.proposals[0].sourceSha256,
    created.revision.sourceManifestSha256,
  );
  assert.equal(data.proposals[0].files[0].before, ORIGINAL);
  assert.equal(data.proposals[0].files[0].after, PROPOSED);
  assert.equal(result.request.messages.at(-1)!.content, result.run.prompt);
  assert.equal(result.request.tools.length, 0);
  const attempt = f.engine.store.getAttempt(result.request.attemptId!);
  assert.ok(attempt.contextRevisionId);
  const revision = f.engine.store.getContextRevision(attempt.contextRevisionId);
  assert.equal(revision.text, JSON.stringify(result.request.messages));
  assert.equal(revision.sha256, sha(revision.text));
  const exactIds = [
    `proposal:${ID}:${created.set.sha256}`,
    `proposal-head:${ID}:${created.set.headRevision}:${created.set.sha256}`,
    `proposal-revision:${created.revision.id}:${created.revision.sha256}`,
    `proposal-source:${created.revision.sourceManifestSha256}`,
    `proposal-binding:${knowledgeHash(created.revision.binding)}`,
    ...created.revision.files.flatMap((file) =>
      [file.before, file.after]
        .filter((ref) => ref !== null)
        .map(
          (ref) => `proposal-blob:${ref.id}:${ref.sha256}:${ref.headerSha256}`,
        ),
    ),
  ];
  for (const id of exactIds)
    assert.ok(
      revision.sourceIds.includes(id),
      `Native ContextRevision retains original ${id}`,
    );
  const cleanup = f.engine.store.getAttemptCleanup(attempt.id);
  assert.equal(cleanup.requestSha256, sha(JSON.stringify(result.request)));
  assert.equal(cleanup.state, "confirmed");
  const diagnostic = f.engine.context.diagnostics(
    result.session.id,
  )! as NonNullable<ReturnType<typeof f.engine.context.diagnostics>> & {
    proposalContext?: Omit<PreparedProposalContribution, "messages">;
  };
  assert.equal(
    diagnostic.plan.bytes,
    Buffer.byteLength(JSON.stringify(result.request.messages)) +
      diagnostic.plan.reservations.envelopeBytes,
  );
  assert.ok(diagnostic.proposalContext);
  assert.equal(diagnostic.proposalContext.proposals.length, 1);
  assert.equal(
    diagnostic.proposalContext.proposals[0]!.revisionId,
    created.revision.id,
  );
  assert.equal(
    diagnostic.proposalContext.proposals[0]!.setSha256,
    created.set.sha256,
  );
  assert.equal(
    JSON.stringify(diagnostic.proposalContext).includes(MARKER),
    false,
  );
  assert.equal(
    diagnostic.proposalContext.reservations.contributedBytes,
    Buffer.byteLength(JSON.stringify(messages[0])) + 1,
  );
  assert.deepEqual(proposalRows(f.dbPath), history);
  assert.equal(f.engine.store.listCheckpoints(result.run.id).length, 0);
  assert.equal(f.engine.store.getSnapshot(result.session.id).tools.length, 0);
  f.assertUntouched();
});

test("actual same-Turn retry preserves original overlay messages and ContextRevision after real underlying cleanup", async (t) => {
  let calls = 0,
    returned = 0;
  const f = await fixture(t, {
    stream() {
      const call = ++calls;
      let ended = false;
      const iterator: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        async next() {
          if (call === 1)
            throw new EngineError(
              "PROVIDER_HTTP_ERROR",
              "Authored retryable native proposal fixture",
              { status: 429, retryAfterMs: 0 },
            );
          if (ended) return { done: true, value: undefined };
          ended = true;
          return { done: false, value: stop };
        },
        async return() {
          returned++;
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
  });
  await f.stage();
  const result = await f.consume();
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.equal(result.newRequests.length, 2);
  assert.equal(returned, 1);
  assert.deepEqual(
    result.newRequests[0]!.messages,
    result.newRequests[1]!.messages,
  );
  const a = f.engine.store.getAttempt(result.newRequests[0]!.attemptId!),
    b = f.engine.store.getAttempt(result.newRequests[1]!.attemptId!);
  assert.equal(a.turnId, b.turnId);
  assert.equal(a.contextRevisionId, b.contextRevisionId);
  assert.equal(overlay(result.newRequests[0]!).length, 1);
  assert.equal(f.engine.store.getAttemptCleanup(a.id).state, "confirmed");
  assert.equal(f.engine.store.getAttemptCleanup(b.id).state, "confirmed");
  f.assertUntouched();
});

test("a physical source change during original failed-provider cleanup blocks a retry from dispatching the frozen pending overlay again", async (t) => {
  let root = "",
    returned = 0;
  const f = await fixture(t, {
    stream() {
      const iterator: AsyncIterableIterator<ProviderEvent> = {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        async next() {
          throw new EngineError(
            "PROVIDER_HTTP_ERROR",
            "Actual pending overlay retry freshness boundary",
            { status: 429, retryAfterMs: 0 },
          );
        },
        async return() {
          returned++;
          writeFileSync(
            join(root, "source.ts"),
            "Physical source changed while the original provider closed.\n",
          );
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
  });
  root = f.root;
  await f.stage();
  const result = await f.consume();
  assert.equal(result.run.state, "failed");
  assert.equal(result.newRequests.length, 1);
  assert.equal(returned, 1);
  assert.equal(overlay(result.newRequests[0]!).length, 1);
  const attempts = dbRead(f.dbPath, (db) =>
    db
      .prepare(
        "SELECT id FROM provider_attempts WHERE run_id=? ORDER BY attempt_index",
      )
      .all(result.run.id),
  );
  assert.equal(attempts.length, 2);
  const original = f.engine.store.getAttempt(String(attempts[0]!.id)),
    undispatched = f.engine.store.getAttempt(String(attempts[1]!.id));
  assert.equal(original.turnId, undispatched.turnId);
  assert.equal(original.contextRevisionId, undispatched.contextRevisionId);
  assert.equal(undispatched.dispatchedAt, undefined);
  assert.equal(
    f.engine.store.getAttemptCleanup(original.id).state,
    "confirmed",
  );
  assert.equal(
    f.engine.store.getAttemptCleanup(undispatched.id).state,
    "not-dispatched",
  );
});

for (const mutation of ["head", "source"] as const)
  test(`actual ${mutation} change after original overlay ContextPlan capture blocks first provider dispatch without rewriting frozen messages`, async (t) => {
    let saved = "",
      captured = 0;
    const f = await fixture(t, {
      beforeModel: async (engine, runId) => {
        captured++;
        const run = engine.store.getRun(runId);
        saved = engine.store.getLatestContextRevision(run.sessionId)!.text;
        if (mutation === "head")
          await api(engine, "createProposalSet", {
            workspaceId: run.workspaceId,
            requestId: "append-after-capture",
            proposalId: ID,
            expectedRevision: 1,
            changes: [
              {
                path: "source.ts",
                expectedHash: sha(ORIGINAL),
                content: SECOND,
              },
            ],
          });
        else
          writeFileSync(
            join(engine.store.getWorkspace(run.workspaceId).root, "source.ts"),
            "Actual edit after captured proposal.\n",
          );
      },
    });
    await f.stage();
    const result = await f.consume();
    assert.equal(captured, 1);
    assert.equal(result.run.state, "failed", JSON.stringify(result.run.error));
    assert.equal(f.requests.length, 0);
    assert.ok(result.run.error?.code.startsWith("PROPOSAL_"));
    assert.equal(
      f.engine.store.getLatestContextRevision(result.session.id)!.text,
      saved,
    );
    assert.ok(saved.includes(MARKER));
    assert.equal(
      dbRead(f.dbPath, (db) =>
        Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM provider_attempts WHERE run_id=?",
            )
            .get(result.run.id)!.n,
        ),
      ),
      0,
    );
  });

test("a tiny optional proposal slot omits the whole unapplied proposal and preserves exact required current exchange", async (t) => {
  const f = await fixture(t, { slotBytes: 32, maxContextBytes: 2048 });
  await f.stage();
  const history = proposalRows(f.dbPath),
    prompt = 'Required current exchange remains exact "quoted" 한글😀.',
    result = await f.consume(prompt);
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.equal(overlay(result.request).length, 0);
  assert.equal(result.request.messages.at(-1)!.content, prompt);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({
        messages: result.request.messages,
        tools: result.request.tools,
      }),
    ) <= 2048,
  );
  assert.deepEqual(proposalRows(f.dbPath), history);
  f.assertUntouched();
});

test("actual repository, lifecycle data and pending overlay share one final Context byte reservation while preserving the required user exchange", async (t) => {
  const f = await fixture(t, { sharedSources: true, maxContextBytes: 8192 });
  await f.stage();
  const result = await f.consume();
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.equal(result.request.messages.at(-1)!.content, result.run.prompt);
  const proposal = overlay(result.request);
  assert.equal(proposal.length, 1);
  const repository = result.request.messages.filter((message) =>
      message.content.startsWith("Observed repository evidence."),
    ),
    lifecycle = result.request.messages.filter((message) =>
      message.content.startsWith("[Moodcode lifecycle context data v1]\n"),
    );
  assert.equal(repository.length, 1);
  assert.equal(lifecycle.length, 1);
  assert.ok(repository[0]!.content.includes("untouchedUserDraft"));
  assert.ok(
    lifecycle[0]!.content.includes(
      "Exact independently selected lifecycle data.",
    ),
  );
  const plan = f.engine.context.diagnostics(result.session.id)!.plan,
    reservations = plan.reservations as typeof plan.reservations & {
      proposalBytes?: number;
    };
  assert.equal(
    reservations.repositoryBytes,
    Buffer.byteLength(JSON.stringify(repository[0])) + 1,
  );
  assert.equal(
    reservations.lifecycleBytes,
    Buffer.byteLength(JSON.stringify(lifecycle[0])) + 1,
  );
  assert.equal(
    reservations.proposalBytes,
    Buffer.byteLength(JSON.stringify(proposal[0])) + 1,
  );
  assert.equal(
    plan.bytes,
    Buffer.byteLength(JSON.stringify(result.request.messages)) +
      plan.reservations.envelopeBytes,
  );
  assert.ok(plan.bytes <= 8192);
  f.assertUntouched();
});

test("proposal context is disabled unless separately selected and does not activate by merely reading stored proposals", async (t) => {
  const f = await fixture(t, { context: false });
  await f.stage();
  await f.diff();
  f.read();
  const history = proposalRows(f.dbPath),
    result = await f.consume();
  assert.equal(result.run.state, "completed");
  assert.ok(result.request);
  assert.equal(overlay(result.request).length, 0);
  assert.deepEqual(proposalRows(f.dbPath), history);
  f.assertUntouched();
});

test("actual same-physical restart retains native proposal history and consumes fresh source without staging or provider replay", async (t) => {
  const f = await fixture(t);
  await f.stage();
  const original = structuredClone(f.read()),
    history = proposalRows(f.dbPath);
  await f.engine.close();
  const current = f.reopen();
  assert.deepEqual(f.read(current), original);
  assert.equal(f.requests.length, 0);
  const result = await f.consume(undefined, current);
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.equal(overlay(result.request).length, 1);
  assert.deepEqual(proposalRows(f.dbPath), history);
  f.assertUntouched();
});

test("default-off host staging rejects while stored proposal history and captured diff remain readonly after restart", async (t) => {
  const f = await fixture(t);
  await f.stage();
  const original = structuredClone(f.read()),
    history = proposalRows(f.dbPath);
  await f.engine.close();
  const current = f.reopen({
    proposals: undefined,
    proposalContextPolicy: undefined,
  });
  assert.deepEqual(f.read(current), original);
  assert.ok(capturedText(await f.diff(current), PROPOSED));
  await assert.rejects(
    f.stage({ proposalId: "new-disabled" }, current),
    CODE(),
  );
  assert.deepEqual(proposalRows(f.dbPath), history);
  assert.equal(f.requests.length, 0);
  f.assertUntouched();
});

test("actual exported/imported proposal history is readable but paused native heads cannot activate old overlay or accept append", async (t) => {
  const f = await fixture(t);
  await f.stage();
  const original = structuredClone(f.read());
  await f.engine.close();
  const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "archive"),
    }),
    imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "imported"),
    });
  const current = createEngine({
    ...f.config,
    dbPath: imported.dbPath,
    artifactDir: imported.artifactDir,
  });
  f.engines.add(current);
  const paused = f.read(current);
  assert.deepEqual(paused.revision, original.revision);
  assert.equal(paused.set.status, "paused-import");
  assert.equal(paused.set.archiveSha256, archive.manifestSha256);
  const history = proposalRows(imported.dbPath);
  assert.ok(capturedText(await f.diff(current), PROPOSED));
  await assert.rejects(
    f.stage({ expectedRevision: 1, content: SECOND }, current),
    CODE(),
  );
  const result = await f.consume(undefined, current);
  assert.equal(result.run.state, "completed", JSON.stringify(result.run.error));
  assert.ok(result.request);
  assert.equal(overlay(result.request).length, 0);
  assert.deepEqual(proposalRows(imported.dbPath), history);
  f.assertUntouched();
});

test("getter input and genuine already-aborted signal cannot allocate native proposal history or execute any owner", async (t) => {
  const f = await fixture(t),
    core = coreRows(f.dbPath),
    rows = proposalRows(f.dbPath);
  let getters = 0;
  const input = {
    workspaceId: f.workspace.id,
    requestId: "hostile-input",
    get changes() {
      getters++;
      return [
        { path: "source.ts", expectedHash: sha(ORIGINAL), content: PROPOSED },
      ];
    },
  };
  await assert.rejects(
    async () => api(f.engine, "createProposalSet", input),
    CODE(),
  );
  assert.equal(getters, 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.stage({ signal: abort.signal }),
    (error) =>
      error instanceof EngineError && /CANCELLED|ABORT/.test(error.code),
  );
  assert.deepEqual(coreRows(f.dbPath), core);
  assert.deepEqual(proposalRows(f.dbPath), rows);
  assert.equal(f.requests.length, 0);
  f.assertUntouched();
});
