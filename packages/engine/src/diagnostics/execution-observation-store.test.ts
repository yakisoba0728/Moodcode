import assert from "node:assert/strict";
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
  DEFAULT_LIMITS,
  EngineError,
  type ToolCallRecord,
} from "@moodcode/contracts";
import { SqliteStore } from "../storage/index.js";
import type { ToolEffectClass } from "../ports.js";
import {
  DiagnosticExecutionObservationStorage,
  DIAGNOSTIC_EXECUTION_OBSERVATION_SCHEMA_SQL,
  validateDiagnosticExecutionObservationDatabase,
} from "./execution-observation-store.js";
import type {
  DiagnosticExecutionIdentity,
  DiagnosticExecutionRuntimeMetadata,
  DiagnosticExecutionObservationPorts,
} from "./execution-observation-types.js";
import { knowledgeHash } from "../knowledge/validation.js";

const stamp = "2026-10-08T12:00:00.000Z",
  hash = (text: string) => createHash("sha256").update(text).digest("hex"),
  code = (value: string) => (e: unknown) =>
    e instanceof EngineError && e.code === value;
function fixture(t: TestContext) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-execution-native-")),
    ),
    root = join(base, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, "source.ts"), "export const fact=1;\n");
  const store = new SqliteStore(join(base, "engine.sqlite")),
    db = Reflect.get(store, "db") as DatabaseSync;
  assert.ok(db instanceof DatabaseSync);
  if (
    !db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='diagnostic_effect_epochs'",
      )
      .get()
  )
    db.exec(DIAGNOSTIC_EXECUTION_OBSERVATION_SCHEMA_SQL);
  store.putWorkspace({
    id: "workspace",
    root,
    gitRoot: root,
    branch: null,
    createdAt: stamp,
  });
  store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Actual native records",
    createdAt: stamp,
  });
  const config = {
      providerId: "scripted",
      modelId: "local",
      mode: "build" as const,
      limits: { ...DEFAULT_LIMITS },
    },
    receipt = store.acceptInput({
      sessionId: "session",
      requestId: "request",
      prompt: "Independently authored native fixture",
      config,
      delivery: "queue",
    }),
    run = store.promoteInput(receipt.inputId).run;
  store.commit(run.id, "run.started", {}, { run: { state: "running" } });
  const turn = {
    schemaVersion: 2 as const,
    id: randomUUID(),
    sessionId: "session",
    runId: run.id,
    inputIds: [receipt.inputId],
    index: 0,
    state: "created" as const,
    createdAt: stamp,
  };
  store.putTurn(turn);
  store.putTurn({ ...turn, state: "streaming" });
  const attempt = {
    schemaVersion: 2 as const,
    id: randomUUID(),
    sessionId: "session",
    runId: run.id,
    turnId: turn.id,
    index: 0,
    providerId: "scripted",
    modelId: "local",
    state: "prepared" as const,
    createdAt: stamp,
  };
  store.putAttempt(attempt);
  store.putAttempt({ ...attempt, state: "dispatched", dispatchedAt: stamp });
  store.putAttempt({
    ...attempt,
    state: "completed",
    dispatchedAt: stamp,
    completedAt: stamp,
  });
  store.putTurn({
    ...turn,
    state: "awaiting_tools",
    finishReason: "tool_calls",
  });
  const handles = new WeakMap<
      object,
      {
        owner: DiagnosticExecutionIdentity;
        effect: ToolEffectClass;
        inputSha: string;
        complete: boolean;
        unknown: boolean;
      }
    >(),
    state = {
      sourceReads: 0,
      now: Date.parse(stamp),
      beforeRead: undefined as
        ((phase: "before" | "after") => void) | undefined,
    };
  const ports: DiagnosticExecutionObservationPorts = {
    writeTx: (op) => {
      if (db.isTransaction) return op();
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = op();
        db.exec("COMMIT");
        return value;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    readSourceSnapshot: (handle, phase) => {
      const issued = handles.get(handle);
      if (!issued)
        throw new EngineError(
          "ORIGINAL_SOURCE_INVALID",
          "Unknown host source handle",
        );
      state.sourceReads++;
      state.beforeRead?.(phase);
      const source = readFileSync(join(root, "source.ts"), "utf8");
      return {
        ...issued.owner,
        effectClass: issued.effect,
        effectiveInputSha256: issued.inputSha,
        source: {
          schemaVersion: 1,
          completeness: issued.unknown ? "unknown" : "full",
          sha256: issued.unknown ? null : hash(source),
          fileCount: 1,
          bytes: Buffer.byteLength(source),
        },
        ...(phase === "after" ? { resultComplete: issued.complete } : {}),
      } as DiagnosticExecutionRuntimeMetadata;
    },
    now: () => state.now,
  };
  let native = new DiagnosticExecutionObservationStorage(db, ports),
    partIndex = 0;
  function tool(
    effect: ToolEffectClass = "read",
    nativeState: ToolCallRecord["state"] = "running",
    complete = true,
    unknown = false,
  ) {
    const id = randomUUID(),
      input = { path: "source.ts" },
      record: ToolCallRecord = {
        id,
        runId: run.id,
        sessionId: "session",
        name: "read_file",
        input,
        state: "requested",
      };
    store.putPart({
      schemaVersion: 2,
      id: randomUUID(),
      sessionId: "session",
      runId: run.id,
      turnId: turn.id,
      messageId: "tools-message",
      index: partIndex++,
      revision: 0,
      type: "tool",
      name: record.name,
      input,
      toolCallId: id,
      providerCallId: "provider-" + id,
      state: "open",
      createdAt: stamp,
    });
    store.commit(run.id, "tool.requested", {}, { tool: record });
    if (nativeState !== "requested")
      store.commit(
        run.id,
        "tool." + nativeState,
        {},
        { tool: { ...record, state: nativeState } },
      );
    const owner: DiagnosticExecutionIdentity = {
        workspaceId: "workspace",
        sessionId: "session",
        runId: run.id,
        toolCallId: id,
        turnId: turn.id,
        attemptId: attempt.id,
      },
      handle = Object.freeze({});
    handles.set(handle, {
      owner,
      effect,
      inputSha: hash(JSON.stringify(input)),
      complete,
      unknown,
    });
    return { owner, handle, record: { ...record, state: nativeState } };
  }
  function settle(
    value: ReturnType<typeof tool>,
    outcome: ToolCallRecord["state"] = "completed",
    output = "Actual complete result",
  ) {
    store.commit(
      run.id,
      "tool." + outcome,
      {},
      {
        tool: {
          ...value.record,
          state: outcome,
          output,
          ...(outcome === "failed" ? { error: "Actual failure" } : {}),
        },
      },
    );
  }
  t.after(() => {
    store.close();
    rmSync(base, { recursive: true, force: true });
  });
  return {
    base,
    root,
    db,
    store,
    run,
    state,
    handles,
    ports,
    tool,
    settle,
    get native() {
      return native;
    },
    successor() {
      native = new DiagnosticExecutionObservationStorage(db, ports);
      return native;
    },
  };
}

test("actual read dispatch records full source and exact native input/result without effect increment", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  assert.equal(dispatch.record.effectEpochDispatch, 0);
  assert.equal(f.native.getEpoch("workspace")!.epoch, 0);
  assert.equal(dispatch.record.state, "dispatched");
  f.settle(tool);
  const result = f.native.settle(dispatch.capture);
  assert.equal(result.state, "settled");
  assert.equal(result.outcome, "completed");
  assert.equal(result.resultComplete, true);
  assert.equal(result.inputSha256, hash(JSON.stringify(tool.record.input)));
  assert.equal(result.sourceBefore.sha256, result.sourceAfter!.sha256);
  assert.equal(result.effectEpochAfter, 0);
  assert.deepEqual(f.native.settle(dispatch.capture), result);
  validateDiagnosticExecutionObservationDatabase(f.db);
  f.native.release(dispatch.capture);
});
test("write execute network and unknown advance workspace epoch once before actual producer effects", (t) => {
  const f = fixture(t);
  for (const [step, effect] of (
    ["write", "execute", "network", "unknown"] as const
  ).entries()) {
    const tool = f.tool(effect),
      dispatch = f.native.dispatch(tool.owner, tool.handle);
    assert.equal(dispatch.record.effectEpochBefore, step);
    assert.equal(dispatch.record.effectEpochDispatch, step + 1);
    assert.equal(
      readFileSync(join(f.root, "source.ts"), "utf8"),
      "export const fact=1;\n",
    );
    assert.throws(
      () => f.native.dispatch(tool.owner, tool.handle),
      code("EXECUTION_OBSERVATION_DUPLICATE"),
    );
    f.settle(tool);
    f.native.settle(dispatch.capture);
    assert.equal(f.native.getEpoch("workspace")!.epoch, step + 1);
  }
  validateDiagnosticExecutionObservationDatabase(f.db);
});
test("state-only bookkeeping is observed without pretending it changes physical effects", (t) => {
  const f = fixture(t),
    tool = f.tool("state"),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  assert.equal(dispatch.record.effectEpochDispatch, 0);
  f.settle(tool);
  assert.equal(f.native.settle(dispatch.capture).effectEpochAfter, 0);
});
test("requested denied approval-waiting invalid owners and malformed getters produce zero observations", (t) => {
  const f = fixture(t);
  for (const state of ["requested", "awaiting_approval", "denied"] as const) {
    const tool = f.tool("write", state);
    assert.throws(
      () => f.native.dispatch(tool.owner, tool.handle),
      code("EXECUTION_OBSERVATION_NOT_DISPATCHABLE"),
    );
  }
  const tool = f.tool(),
    before = f.state.sourceReads;
  assert.throws(
    () => f.native.dispatch({ ...tool.owner, runId: "missing" }, tool.handle),
    code("EXECUTION_OBSERVATION_OWNER_INVALID"),
  );
  let getters = 0;
  const input = Object.defineProperty({ ...tool.owner }, "runId", {
    get() {
      getters++;
      return f.run.id;
    },
    enumerable: true,
  });
  assert.throws(
    () => f.native.dispatch(input, tool.handle),
    code("INVALID_EXECUTION_OBSERVATION"),
  );
  assert.equal(getters, 0);
  assert.equal(f.state.sourceReads, before);
  assert.equal(f.native.getEpoch("workspace"), undefined);
  assert.equal(f.native.listRun("workspace", f.run.id).items.length, 0);
});
test("original source and native capture identities reject copied or foreign execution handles", (t) => {
  const f = fixture(t),
    tool = f.tool();
  assert.throws(
    () => f.native.dispatch(tool.owner, { ...tool.handle }),
    code("ORIGINAL_SOURCE_INVALID"),
  );
  const dispatch = f.native.dispatch(tool.owner, tool.handle);
  assert.throws(
    () => f.native.settle({ ...dispatch.capture }),
    code("EXECUTION_OBSERVATION_CAPTURE_INVALID"),
  );
  const foreign = f.tool();
  assert.throws(
    () => f.native.dispatch(foreign.owner, tool.handle),
    code("EXECUTION_OBSERVATION_SOURCE_INVALID"),
  );
  assert.equal(f.native.listRun("workspace", f.run.id).items.length, 1);
});
test("unknown coverage or host incomplete result cannot become a complete read proof", (t) => {
  const f = fixture(t),
    tool = f.tool("read", "running", false, true),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  assert.equal(dispatch.record.sourceBefore.completeness, "unknown");
  assert.equal(dispatch.record.sourceBefore.sha256, null);
  f.settle(tool);
  const result = f.native.settle(dispatch.capture);
  assert.equal(result.resultComplete, false);
  assert.equal(result.sourceAfter!.sha256, null);
  validateDiagnosticExecutionObservationDatabase(f.db);
});
test("observed source changes after read remain exact different pre/post snapshots", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  writeFileSync(join(f.root, "source.ts"), "export const fact=2;\n");
  f.settle(tool);
  const result = f.native.settle(dispatch.capture);
  assert.notEqual(result.sourceBefore.sha256, result.sourceAfter!.sha256);
  assert.equal(result.effectEpochAfter, 0);
});
test("dispatch SQL rollback preserves epoch and releases no execution capability", (t) => {
  const f = fixture(t),
    tool = f.tool("write");
  f.db.exec(
    "CREATE TRIGGER authored_observation_fail BEFORE INSERT ON diagnostic_execution_observations BEGIN SELECT RAISE(ABORT,'native diagnostic insert failed'); END",
  );
  assert.throws(
    () => f.native.dispatch(tool.owner, tool.handle),
    /native diagnostic insert failed/u,
  );
  assert.equal(f.native.getEpoch("workspace"), undefined);
  assert.equal(
    f.native.getObservation("workspace", tool.owner.toolCallId),
    undefined,
  );
  f.db.exec("DROP TRIGGER authored_observation_fail");
  assert.equal(
    f.native.dispatch(tool.owner, tool.handle).record.effectEpochDispatch,
    1,
  );
});
test("dispatch refuses a host transaction port that skips or detaches the primary transaction", (t) => {
  const f = fixture(t),
    tool = f.tool("write"),
    refused = (message: string) => (e: unknown) =>
      code("EXECUTION_OBSERVATION_TRANSACTION_REQUIRED")(e) &&
      (e as Error).message === message;
  const outside = new DiagnosticExecutionObservationStorage(f.db, {
    ...f.ports,
    writeTx: (op) => op(),
  });
  assert.throws(
    () => outside.dispatch(tool.owner, tool.handle),
    refused("Observation must use exactly one primary transaction"),
  );
  const detached = new DiagnosticExecutionObservationStorage(f.db, {
    ...f.ports,
    writeTx: <T>() => undefined as T,
  });
  assert.throws(
    () => detached.dispatch(tool.owner, tool.handle),
    refused("Observation transaction cannot detach"),
  );
  assert.equal(f.native.getEpoch("workspace"), undefined);
  assert.equal(
    f.native.getObservation("workspace", tool.owner.toolCallId),
    undefined,
  );
});
test("settlement rollback retains original dispatched observation until actual terminal evidence can settle", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  f.settle(tool);
  f.db.exec(
    "CREATE TRIGGER authored_settle_fail BEFORE UPDATE ON diagnostic_execution_observations BEGIN SELECT RAISE(ABORT,'native diagnostic update failed'); END",
  );
  assert.throws(
    () => f.native.settle(dispatch.capture),
    /native diagnostic update failed/u,
  );
  assert.deepEqual(
    f.native.getObservation("workspace", tool.owner.toolCallId),
    dispatch.record,
  );
  f.db.exec("DROP TRIGGER authored_settle_fail");
  assert.equal(f.native.settle(dispatch.capture).resultComplete, true);
});
test("failed actual tool retains exact native outcome while incomplete result cannot establish a repeat", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  f.settle(tool, "failed", "Observed failure");
  const result = f.native.settle(dispatch.capture);
  assert.equal(result.outcome, "failed");
  assert.equal(result.resultComplete, false);
  assert.ok(result.resultSha256);
  validateDiagnosticExecutionObservationDatabase(f.db);
});
test("restart preserves dispatch effect epoch and marks unknown observations without native tool replay", (t) => {
  const f = fixture(t),
    tool = f.tool("execute"),
    dispatch = f.native.dispatch(tool.owner, tool.handle),
    before = f.store.getSnapshot("session");
  assert.equal(f.successor().recoverInterruptedOwners(), 1);
  const recovered = f.native.getObservation(
    "workspace",
    tool.owner.toolCallId,
  )!;
  assert.equal(recovered.state, "interrupted");
  assert.equal(recovered.outcome, "unknown");
  assert.equal(recovered.resultComplete, false);
  assert.equal(recovered.sourceAfter, null);
  assert.equal(recovered.effectEpochDispatch, 1);
  assert.equal(f.native.getEpoch("workspace")!.epoch, 1);
  assert.deepEqual(f.store.getSnapshot("session"), before);
  assert.throws(
    () => f.native.settle(dispatch.capture),
    code("EXECUTION_OBSERVATION_CAPTURE_INVALID"),
  );
  validateDiagnosticExecutionObservationDatabase(f.db);
});
test("release of an unsettled original capture preserves unknown evidence and rejects late callbacks", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  f.native.release(dispatch.capture);
  f.settle(tool);
  assert.throws(
    () => f.native.settle(dispatch.capture),
    code("EXECUTION_OBSERVATION_CAPTURE_INVALID"),
  );
  assert.equal(
    f.native.getObservation("workspace", tool.owner.toolCallId)!.state,
    "interrupted",
  );
  assert.equal(
    f.native.getObservation("workspace", tool.owner.toolCallId)!.resultComplete,
    false,
  );
});
test("frozen exact Run pagination is bounded and excludes later native executions", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    const tool = f.tool(),
      dispatch = f.native.dispatch(tool.owner, tool.handle);
    f.settle(tool);
    f.native.settle(dispatch.capture);
  }
  const first = f.native.listRun("workspace", f.run.id, { limit: 2 }),
    through = first.throughOrdinal;
  assert.equal(first.items.length, 2);
  assert.equal(first.next, 2);
  assert.ok(Object.isFrozen(first.items));
  const tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  f.settle(tool);
  f.native.settle(dispatch.capture);
  const second = f.native.listRun("workspace", f.run.id, {
    afterOrdinal: first.next!,
    throughOrdinal: through,
  });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]!.ordinal, 3);
  assert.equal(second.next, null);
  assert.equal(first.bytes, Buffer.byteLength(JSON.stringify(first)));
  assert.throws(
    () => f.native.listRun("foreign", f.run.id),
    code("EXECUTION_OBSERVATION_OWNER_INVALID"),
  );
  assert.throws(
    () => f.native.listRun("workspace", f.run.id, { maxBytes: 256 }),
    code("EXECUTION_OBSERVATION_LIMIT"),
  );
});
test("another tool awaiting approval does not erase an already running actual tool boundary", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    waiting = f.tool("write", "awaiting_approval");
  f.store.commit(
    f.run.id,
    "run.awaiting_approval",
    { toolCallId: waiting.record.id },
    { run: { state: "awaiting_approval" } },
  );
  assert.equal(
    f.native.dispatch(tool.owner, tool.handle).record.effectEpochDispatch,
    0,
  );
  assert.throws(
    () => f.native.dispatch(waiting.owner, waiting.handle),
    code("EXECUTION_OBSERVATION_NOT_DISPATCHABLE"),
  );
});
test("actual native tool mutation during synchronous source validation rolls back dispatch epoch", (t) => {
  const f = fixture(t),
    tool = f.tool("write");
  f.state.beforeRead = (phase) => {
    if (phase === "before") {
      const record = { ...tool.record, input: { path: "different.ts" } };
      f.db
        .prepare("UPDATE tools SET data=? WHERE id=?")
        .run(JSON.stringify(record), tool.record.id);
    }
  };
  assert.throws(
    () => f.native.dispatch(tool.owner, tool.handle),
    code("EXECUTION_OBSERVATION_OWNER_INVALID"),
  );
  assert.equal(f.native.getEpoch("workspace"), undefined);
  assert.equal(f.native.getObservation("workspace", tool.record.id), undefined);
  assert.deepEqual(
    f.store
      .getSnapshot("session")
      .tools.find((value) => value.id === tool.record.id)!.input,
    tool.record.input,
  );
});
test("oversized native tool is refused before any JavaScript body allocation or source callback", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    original = f.db.prepare.bind(f.db);
  f.db
    .prepare("UPDATE tools SET data=? WHERE id=?")
    .run(" ".repeat(1048577), tool.record.id);
  let bodyReads = 0;
  Object.defineProperty(f.db, "prepare", {
    value: (sql: string) => {
      if (sql.startsWith("SELECT * FROM tools")) bodyReads++;
      return original(sql);
    },
    configurable: true,
  });
  assert.throws(
    () => f.native.dispatch(tool.owner, tool.handle),
    code("EXECUTION_OBSERVATION_READ_LIMIT"),
  );
  assert.equal(bodyReads, 0);
  assert.equal(f.state.sourceReads, 0);
  assert.equal(f.native.getEpoch("workspace"), undefined);
});
test("oversized diagnostic row is refused before loading its body", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  f.db.exec("PRAGMA ignore_check_constraints=ON");
  f.db
    .prepare("UPDATE diagnostic_execution_observations SET data=? WHERE id=?")
    .run(" ".repeat(16385), dispatch.record.id);
  const original = f.db.prepare.bind(f.db);
  let bodyReads = 0;
  Object.defineProperty(f.db, "prepare", {
    value: (sql: string) => {
      if (sql.startsWith("SELECT * FROM diagnostic_execution_observations"))
        bodyReads++;
      return original(sql);
    },
    configurable: true,
  });
  assert.throws(
    () => f.native.getObservation("workspace", tool.record.id),
    code("EXECUTION_OBSERVATION_READ_LIMIT"),
  );
  assert.equal(bodyReads, 0);
});
test("bounded malformed diagnostic JSON uses a typed corruption error", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  f.db
    .prepare("UPDATE diagnostic_execution_observations SET data=? WHERE id=?")
    .run("{invalid}", dispatch.record.id);
  assert.throws(
    () => f.native.getObservation("workspace", tool.record.id),
    code("EXECUTION_OBSERVATION_CORRUPT"),
  );
  assert.throws(
    () => f.successor().recoverInterruptedOwners(),
    code("EXECUTION_OBSERVATION_CORRUPT"),
  );
});
test("archive semantic validator rejects rewritten complete result even if its row digest is recomputed", (t) => {
  const f = fixture(t),
    tool = f.tool(),
    dispatch = f.native.dispatch(tool.owner, tool.handle);
  f.settle(tool);
  const result = f.native.settle(dispatch.capture),
    { sha256: ignored, ...old } = result,
    body = { ...old, resultSha256: hash("fabricated result") },
    changed = { ...body, sha256: knowledgeHash(body) };
  f.db
    .prepare("UPDATE diagnostic_execution_observations SET data=? WHERE id=?")
    .run(JSON.stringify(changed), changed.id);
  assert.throws(
    () => validateDiagnosticExecutionObservationDatabase(f.db),
    code("EXECUTION_OBSERVATION_CORRUPT"),
  );
});
test("archive semantic validator rejects forged epoch bounds without original producer dispatches", (t) => {
  const f = fixture(t),
    tool = f.tool("write");
  f.native.dispatch(tool.owner, tool.handle);
  const before = f.native.getEpoch("workspace")!,
    { sha256: ignored, ...old } = before,
    body = { ...old, epoch: 2 },
    changed = { ...body, sha256: knowledgeHash(body) };
  f.db
    .prepare(
      "UPDATE diagnostic_effect_epochs SET epoch=?,data=? WHERE workspace_id=?",
    )
    .run(2, JSON.stringify(changed), "workspace");
  assert.throws(
    () => validateDiagnosticExecutionObservationDatabase(f.db),
    code("EXECUTION_OBSERVATION_CORRUPT"),
  );
});
test("same primary outer transaction rollback cannot leave a new observation or effect epoch", (t) => {
  const f = fixture(t),
    tool = f.tool("network");
  f.db.exec("BEGIN IMMEDIATE");
  f.native.dispatch(tool.owner, tool.handle);
  assert.equal(f.native.getEpoch("workspace")!.epoch, 1);
  f.db.exec("ROLLBACK");
  assert.equal(f.native.getEpoch("workspace"), undefined);
  assert.equal(f.native.getObservation("workspace", tool.record.id), undefined);
  assert.equal(
    f.native.dispatch(tool.owner, tool.handle).record.effectEpochDispatch,
    1,
  );
});
test("released outer-rollback captures never leak native capacity or rewrite successor dispatches", (t) => {
  const f = fixture(t),
    tool = f.tool("write");
  let stale: ReturnType<typeof f.native.dispatch>["capture"] | undefined;
  for (let index = 0; index < 129; index++) {
    f.db.exec("BEGIN IMMEDIATE");
    const dispatch = f.native.dispatch(tool.owner, tool.handle);
    f.db.exec("ROLLBACK");
    if (index === 0) {
      stale = dispatch.capture;
      continue;
    }
    f.native.release(dispatch.capture);
  }
  const successor = f.native.dispatch(tool.owner, tool.handle);
  f.native.release(stale!);
  assert.deepEqual(
    f.native.getObservation("workspace", tool.owner.toolCallId),
    successor.record,
  );
  assert.equal(f.native.getEpoch("workspace")!.epoch, 1);
  assert.throws(
    () => f.native.settle(stale!),
    code("EXECUTION_OBSERVATION_CAPTURE_INVALID"),
  );
});
