import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createEngine } from "../engine.js";
import { knowledgeHash } from "../knowledge/validation.js";
import type { ToolDefinition } from "../ports.js";
import {
  exportEngineArchive,
  importEngineArchive,
} from "../storage/archive.js";
import { groupExists } from "../tools/command/process-control.js";
import { backendFixture } from "./fixtures/backend.js";
import { decideEffect, effectPeerFile } from "./fixtures/effects.js";
import { validateAgentBackendDatabase } from "./store.js";

const policy = [
  { tool: "apply_patch", decision: "ask" as const },
  { tool: "run_command", decision: "ask" as const },
];

async function completedTerminal(t: TestContext, noSpawn: boolean) {
  const f = await backendFixture(t, {
    mode: noSpawn ? "terminal-kill-immediate" : "terminal-kill",
    peerFile: effectPeerFile,
    tools: ["read_file", "apply_patch", "run_command"],
    toolPolicy: policy,
    engine: { agentBackendClientEffects: true, jobs: true },
  });
  let deferredProducerCalls = 0;
  if (noSpawn) {
    const scopes = Reflect.get(f.engine.toolRuntime, "scopes") as Map<
      string,
      Map<string, { definition: ToolDefinition }>
    >;
    const entry = [...scopes.values()]
      .map((entries) => entries.get("run_command"))
      .find((value) => value !== undefined)!;
    assert.ok(entry);
    const execute = entry.definition.execute;
    // Fix the scheduling boundary only. Native prepare, approval, dispatch and
    // the command result still use the genuine unchanged producer and context.
    entry.definition.execute = async (prepared, context) => {
      deferredProducerCalls++;
      assert.equal(prepared.name, "run_command");
      if (!context.signal.aborted)
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            context.signal.removeEventListener("abort", onAbort);
            reject(new Error("Actual immediate terminal/kill did not abort"));
          }, 5_000);
          context.signal.addEventListener("abort", onAbort, { once: true });
          if (context.signal.aborted) onAbort();
        });
      assert.equal(context.signal.aborted, true);
      return Reflect.apply(execute, entry.definition, [prepared, context]);
    };
    t.after(() => {
      entry.definition.execute = execute;
    });
  }
  f.register();
  const submitted = await f.submit();
  await decideEffect({ ...f, ...submitted });
  const run = await submitted.done;
  assert.equal(run.state, "completed", JSON.stringify(run));
  if (noSpawn) assert.equal(deferredProducerCalls, 1);
  const effect = f.engine.inspectAgentBackendEffects(f.workspace.id)[0]!;
  assert.equal(effect.state, "failed");
  assert.equal(effect.completion?.cleanupConfirmed, true);
  assert.deepEqual(
    effect.controls?.map((control) =>
      "method" in control.frame.message ? control.frame.message.method : null,
    ),
    ["terminal/kill", "terminal/output", "terminal/release"],
  );
  const connection = f.engine.inspectAgentBackendConnections(
    f.workspace.id,
  )[0]!;
  assert.equal(connection.state, "closed");
  assert.equal(connection.disposal?.cleanupConfirmed, true);
  assert.equal(groupExists(connection.proof.processId), false);
  const request = f.engine.inspectAgentBackendRequests(f.workspace.id)[0]!;
  assert.equal(request.state, "completed");
  assert.deepEqual(
    request.terminal && "result" in request.terminal.message
      ? request.terminal.message.result
      : null,
    { stopReason: "end_turn" },
  );
  assert.equal(
    f.logs().filter((row) => row.message?.method === "session/prompt").length,
    1,
  );
  const db = Reflect.get(f.engine.store, "db") as DatabaseSync;
  assert.doesNotThrow(() => validateAgentBackendDatabase(db));
  return { f, submitted, effect, db };
}

function outputEvent(db: DatabaseSync) {
  const rows = db
    .prepare(
      "SELECT * FROM session_events WHERE type='backend.terminal_output_observed' LIMIT 2",
    )
    .all();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  return {
    session_id: String(row.session_id),
    seq: Number(row.seq),
    data: String(row.data),
    run_id: row.run_id === null ? null : String(row.run_id),
    input_id: row.input_id === null ? null : String(row.input_id),
    turn_id: row.turn_id === null ? null : String(row.turn_id),
    attempt_id: row.attempt_id === null ? null : String(row.attempt_id),
  };
}

function withRollback(db: DatabaseSync, body: () => void) {
  db.exec("BEGIN");
  try {
    body();
  } finally {
    db.exec("ROLLBACK");
  }
}

test(
  "immediate ACP ACK→kill preserves genuine failed no-spawn Tool/Part and delivers bounded empty output",
  { timeout: 15_000 },
  async (t) => {
    const { f, submitted, effect, db } = await completedTerminal(t, true);
    const snapshot = f.engine.store.getSnapshot(f.session.id);
    assert.equal(snapshot.tools.length, 1);
    assert.equal(snapshot.approvals.length, 1);
    assert.equal(snapshot.approvals[0]!.status, "allowed");
    const tool = snapshot.tools[0]!;
    assert.equal(tool.state, "failed");
    assert.equal(tool.output, "Command cancelled before starting.");
    const part = f.engine.store
      .listTurns(submitted.runId)
      .flatMap((turn) => f.engine.store.listParts(turn.id))
      .find((value) => value.type === "tool" && value.toolCallId === tool.id)!;
    assert.ok(part && part.type === "tool");
    assert.equal(part.state, "failed");
    assert.ok(
      part.result &&
        typeof part.result === "object" &&
        !Array.isArray(part.result),
    );
    assert.equal(part.result.output, tool.output);
    assert.equal(effect.completion?.state, "failed");
    assert.equal(effect.completion?.content, null);
    assert.equal(effect.completion?.checkpoint, null);
    assert.equal(
      effect.completion?.outputBytes,
      Buffer.byteLength(tool.output!),
    );
    assert.deepEqual(effect.completion?.result, {
      status: "cancelled",
      exitCode: null,
      signal: null,
      cancelled: true,
      timedOut: false,
      cleanupConfirmed: true,
      started: false,
    });
    const output = effect.controls!.find(
      (control) =>
        "method" in control.frame.message &&
        control.frame.message.method === "terminal/output",
    )!;
    assert.deepEqual(
      "result" in output.message ? output.message.result : null,
      { output: "", truncated: false },
    );
    assert.equal(f.engine.store.listCheckpoints(submitted.runId).length, 0);
    assert.equal(f.engine.inspectOwnedCommandJobs(f.workspace.id).length, 0);
    for (const name of ["command-pid", "command-child-pid", "command-ready"])
      assert.equal(existsSync(join(f.root, name)), false);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM session_events WHERE type LIKE 'command.job.%'",
        )
        .get()!.n,
      0,
    );
    const row = outputEvent(db);
    const envelope = JSON.parse(String(row.data));
    assert.equal(
      envelope.payload.noProcessCompletionSha256,
      effect.completion!.sha256,
    );
    assert.equal(envelope.payload.toolCallId, tool.id);
    assert.deepEqual(envelope.payload.output, { output: "", truncated: false });
    withRollback(db, () => {
      const changed = structuredClone(envelope);
      changed.payload.noProcessCompletionSha256 = "0".repeat(64);
      db.prepare(
        "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
      ).run(JSON.stringify(changed), row.session_id, row.seq);
      assert.throws(() => validateAgentBackendDatabase(db), {
        code: "BACKEND_DELIVERY_INVALID",
      });
    });
    withRollback(db, () => {
      const seq =
        Number(
          db
            .prepare(
              "SELECT max(seq) seq FROM session_events WHERE session_id=?",
            )
            .get(row.session_id)!.seq,
        ) + 1;
      const jobId = `command-${knowledgeHash({ runId: effect.completion!.runId, toolCallId: tool.id }).slice(0, 32)}`;
      const contradictory = {
        ...envelope,
        eventId: randomUUID(),
        seq,
        type: "command.job.process_admitted",
        payload: { jobId, sourceSha256: "0".repeat(64), groupPid: 12345 },
      };
      db.prepare(
        "INSERT INTO session_events(session_id,seq,event_id,schema_version,run_id,input_id,turn_id,attempt_id,type,data) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        row.session_id,
        seq,
        contradictory.eventId,
        2,
        row.run_id,
        row.input_id,
        row.turn_id,
        row.attempt_id,
        contradictory.type,
        JSON.stringify(contradictory),
      );
      assert.throws(() => validateAgentBackendDatabase(db), {
        code: "BACKEND_EFFECT_COMPLETION_INVALID",
      });
    });
    assert.doesNotThrow(() => validateAgentBackendDatabase(db));
  },
);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test(
  "spawned ACP cancellation keeps the original owned source and rejects a forged no-process output anchor",
  { timeout: 15_000 },
  async (t) => {
    const { f, submitted, effect, db } = await completedTerminal(t, false);
    const result = effect.completion?.result as {
      started: boolean;
      cancelled: boolean;
    };
    assert.equal(result.started, true);
    assert.equal(result.cancelled, true);
    assert.equal(f.engine.inspectOwnedCommandJobs(f.workspace.id).length, 1);
    assert.equal(f.engine.store.listCheckpoints(submitted.runId).length, 1);
    assert.equal(
      readFileSync(join(f.root, "command-ready"), "utf8"),
      "ready\n",
    );
    for (const name of ["command-pid", "command-child-pid"])
      assert.equal(
        pidAlive(Number(readFileSync(join(f.root, name), "utf8"))),
        false,
      );
    const row = outputEvent(db);
    const envelope = JSON.parse(String(row.data));
    assert.equal(envelope.payload.noProcessCompletionSha256, undefined);
    withRollback(db, () => {
      const changed = structuredClone(envelope);
      changed.payload.noProcessCompletionSha256 = effect.completion!.sha256;
      db.prepare(
        "UPDATE session_events SET data=? WHERE session_id=? AND seq=?",
      ).run(JSON.stringify(changed), row.session_id, row.seq);
      assert.throws(() => validateAgentBackendDatabase(db), {
        code: "BACKEND_DELIVERY_INVALID",
      });
    });
    assert.doesNotThrow(() => validateAgentBackendDatabase(db));
  },
);

test(
  "genuine no-spawn completion imports paused without restoring a process or execution authority",
  { timeout: 15_000 },
  async (t) => {
    const { f, submitted, effect } = await completedTerminal(t, true);
    await f.engine.close();
    const before = new DatabaseSync(f.dbPath, { readOnly: true });
    const originalRows = before
      .prepare("SELECT * FROM backend_revisions ORDER BY id")
      .all();
    before.close();
    const archive = await exportEngineArchive({
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      destination: join(f.base, "no-spawn-archive"),
    });
    const imported = await importEngineArchive({
      directory: archive.directory,
      destination: join(f.base, "no-spawn-import"),
    });
    assert.equal(imported.executionResumed, false);
    const engine = createEngine({
      ...f.configuration,
      dbPath: imported.dbPath,
      artifactDir: imported.artifactDir,
      agentBackends: false,
      agentBackendClientEffects: false,
    });
    f.engines.add(engine);
    const importedEffect = engine.inspectAgentBackendEffects(
      f.workspace.id,
    )[0]!;
    assert.equal(importedEffect.state, "paused-import");
    assert.deepEqual(importedEffect.completion, effect.completion);
    assert.deepEqual(importedEffect.controls, effect.controls);
    assert.equal(engine.store.hasUncertainAgentBackend(f.workspace.id), false);
    assert.equal(engine.store.getSessionControl(f.session.id).paused, true);
    assert.equal(
      engine.store.getSnapshot(f.session.id).tools[0]!.state,
      "failed",
    );
    assert.equal(engine.store.getRun(submitted.runId).state, "completed");
    assert.equal(engine.inspectOwnedCommandJobs(f.workspace.id).length, 0);
    assert.equal(engine.store.listCheckpoints(submitted.runId).length, 0);
    assert.equal(
      engine.getCapabilities().providerIds.includes(f.config.providerId),
      false,
    );
    const logs = f.logs();
    await engine.waitForSession(f.session.id);
    assert.deepEqual(f.logs(), logs);
    const after = new DatabaseSync(imported.dbPath, { readOnly: true });
    try {
      assert.doesNotThrow(() => validateAgentBackendDatabase(after));
      const rows = after
        .prepare("SELECT * FROM backend_revisions ORDER BY id")
        .all();
      for (const row of originalRows)
        assert.deepEqual(
          rows.find((value) => value.id === row.id),
          row,
        );
    } finally {
      after.close();
    }
  },
);
