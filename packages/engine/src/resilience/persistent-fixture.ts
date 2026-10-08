import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_LIMITS,
  EngineError,
  type InputReceipt,
  type JsonObject,
  type RunConfig,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import { createEngine, type MoodcodeEngine } from "../engine.js";
import type { ProviderAdapter, TurnRequest } from "../ports.js";
import { ScriptedProvider } from "../provider/scripted.js";
import type { OwnedCommandJobRecord } from "../jobs/owned-command-records.js";
import { git, shellQuote } from "../evaluation/runtime.js";
import {
  bounded,
  command,
  fixturePaths,
  hash,
  pidAbsent,
  PROFILES,
  until,
} from "./fixture.js";
import { groupExists } from "../tools/command/process-control.js";
import {
  persistentNativeCounts,
  persistentNativeDigest,
} from "./persistent-native.js";
import type { ResolvedPersistentSoakOptions } from "./persistent-options.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export function persistentProviders(commandText: string) {
  const commands = new ScriptedProvider([
    {
      events: [
        {
          type: "tool.call",
          call: {
            id: "persistent-command",
            name: "run_command",
            input: { command: commandText, timeoutMs: 60000 },
          },
        },
        { type: "finish", reason: "tool_calls" },
      ],
    },
    {
      events: [
        { type: "text.delta", delta: "Approved local command settled." },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);
  const observations = new ScriptedProvider([
    {
      events: [
        { type: "text.delta", delta: "Persistent local observation." },
        { type: "finish", reason: "stop" },
      ],
    },
    {
      events: [
        { type: "text.delta", delta: "Persistent steer observed." },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);
  let gate:
    | {
        reached: ReturnType<typeof deferred>;
        release: ReturnType<typeof deferred>;
      }
    | undefined;
  const requests = new Map<
    string,
    { runId: string; turnIndex: number; latestPromptSha256: string }
  >();
  const observer: ProviderAdapter = {
    id: "persistent-observer",
    async *streamTurn(request: TurnRequest, signal: AbortSignal) {
      requests.set(request.runId, {
        runId: request.runId,
        turnIndex: request.turnIndex,
        latestPromptSha256: hash(
          request.messages.findLast((message) => message.role === "user")
            ?.content,
        ),
      });
      if (requests.size > 4) requests.delete(requests.keys().next().value!);
      const current = gate;
      gate = undefined;
      if (current) {
        current.reached.resolve();
        const abort = () => current.release.resolve();
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (!signal.aborted) await current.release.promise;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      }
      yield* observations.streamTurn(request, signal);
    },
  };
  return {
    providers: [commands, observer],
    calls: () => ({
      command: commands.callCount,
      observer: observations.callCount,
    }),
    lastRequest: (runId: string) => requests.get(runId),
    gate() {
      assert.equal(gate, undefined);
      const value = { reached: deferred(), release: deferred() };
      gate = value;
      return value;
    },
  };
}
function initializePersistentRepository(
  root: string,
  preservedText: string,
  commitMessage: string,
) {
  writeFileSync(join(root, "preserved.txt"), preservedText);
  git(root, "init", "--quiet", "--template=");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Persistent Fixture",
    "-c",
    "user.email=persistent@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    commitMessage,
  );
}
function persistentRunConfigs() {
  const config: RunConfig = {
    providerId: "scripted",
    modelId: "local-persistent",
    mode: "build",
    agentProfileId: PROFILES[0]!.id,
    limits: {
      ...DEFAULT_LIMITS,
      maxTurns: 2,
      maxToolCalls: 1,
      maxOutputBytes: 65536,
      maxDurationMs: 90000,
      toolTimeoutMs: 65000,
    },
    budgets: normalizeEngineBudgets({
      turnAllowance: 2,
      maxProviderAttempts: 1,
      maxPendingInputs: 8,
      maxPendingBytes: 65536,
      maxToolCallsPerTurn: 1,
      maxArtifactBytes: 65536,
      maxProducerBytes: 131072,
      retryBaseDelayMs: 0,
    }),
  };
  const observerConfig: RunConfig = {
    ...config,
    providerId: "persistent-observer",
    mode: "plan",
    agentProfileId: PROFILES[1]!.id,
  };
  return { config, observerConfig };
}
export async function createPersistentFixture(
  base: string,
  options: ResolvedPersistentSoakOptions,
) {
  const paths = fixturePaths(base);
  mkdirSync(paths.root);
  const script = join(paths.root, "command.mjs");
  writeFileSync(
    script,
    `import{appendFileSync,writeFileSync,renameSync,existsSync}from'node:fs';
appendFileSync(${JSON.stringify(paths.launches)},String(process.pid)+'\\n');
writeFileSync(${JSON.stringify(paths.marker + ".tmp")},String(process.pid));renameSync(${JSON.stringify(paths.marker + ".tmp")},${JSON.stringify(paths.marker)});
process.stdout.write('PERSISTENT_READY\\n'+'local-${options.seed}-'.repeat(128));
const gate=setInterval(()=>{if(existsSync(${JSON.stringify(paths.release)})){clearInterval(gate);process.stdout.write('\\nPERSISTENT_DONE\\n',()=>process.exit(0));}},5);
`,
  );
  initializePersistentRepository(
    paths.root,
    `Persistent seed ${options.seed}\n`,
    "Isolated persistent fixture",
  );
  const commandText = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  const local = persistentProviders(commandText);
  const { config, observerConfig } = persistentRunConfigs();
  const open = () =>
    createEngine({
      dbPath: paths.dbPath,
      artifactDir: paths.artifactDir,
      providers: local.providers,
      defaults: config,
      agentProfiles: PROFILES,
      jobs: true,
    });
  let engine = open(),
    instance = 1;
  const workspace = await command<Workspace>(engine, "workspace.open", {
    path: paths.root,
  });
  const session = await command<Session>(engine, "session.create", {
    workspaceId: workspace.id,
  });
  const cancelRoot = join(base, "cancellation-repository");
  mkdirSync(cancelRoot);
  initializePersistentRepository(
    cancelRoot,
    `Cancellation seed ${options.seed}\n`,
    "Isolated cancellation fixture",
  );
  const cancelWorkspace = await command<Workspace>(engine, "workspace.open", {
    path: cancelRoot,
  });
  const cancelSession = await command<Session>(engine, "session.create", {
    workspaceId: cancelWorkspace.id,
  });
  let scope = { workspace, session };
  let cancellation: null | {
    workspaceId: string;
    sessionId: string;
    runId: string;
    jobId: string;
    jobSha256: string;
    sourceSha256: string;
    approvalId: string;
    approvalFingerprint: string;
    queuedInputId: string;
    steerInputId: string;
    cancelledInputId: string;
    pid: number;
    groupPid: number;
    physicalCleanupConfirmed: boolean;
    nativeCleanupConfirmed: false;
    resumeOutcome: "cleanup-pending";
  } = null;
  let inputs = 0,
    inputBytes = 0,
    commands = 0,
    completedCommands = 0,
    cancelledCommands = 0,
    textCycles = 0,
    completedCycles = 0;
  let evidenceDigest = createHash("sha256"),
    lastPid = 0,
    lastGroupPid = 0;
  const checkpointJobs: Array<{
    workspaceId: string;
    jobId: string;
    state: string;
    sha256: string;
    sourceSha256: string;
  }> = [];
  const prompt = (requestId: string) =>
    `${requestId}:${options.seed}:`.padEnd(options.payloadBytes, "x");
  function canAccept(count: number) {
    return (
      inputs + count <= options.maxInputs &&
      inputBytes + count * options.payloadBytes <= options.maxInputBytes
    );
  }
  async function accept(
    requestId: string,
    runConfig: RunConfig,
    delivery = "queue",
  ) {
    assert.ok(canAccept(1), "Persistent input ceiling exceeded");
    const input = {
      sessionId: scope.session.id,
      requestId,
      prompt: prompt(requestId),
      config: runConfig,
      delivery,
    };
    const receipt = await command<InputReceipt>(
      engine,
      "input.accept",
      input as unknown as JsonObject,
    );
    assert.equal(receipt.duplicate, false);
    inputs++;
    inputBytes += Buffer.byteLength(input.prompt);
    return {
      receipt,
      input,
      configSha256: hash(engine.store.getInput(receipt.inputId).config),
    };
  }
  async function promoted(inputId: string) {
    await until(
      () => !!engine.store.getInput(inputId).runId,
      options.boundaryTimeoutMs,
      "persistent input promotion",
    );
    return engine.store.getInput(inputId).runId!;
  }
  async function startCommand(requestId: string) {
    rmSync(paths.marker, { force: true });
    rmSync(paths.release, { force: true });
    const source = await accept(requestId, config),
      runId = await promoted(source.receipt.inputId);
    await until(
      () => {
        const run = engine.store.getRun(runId);
        assert.ok(
          !["completed", "failed", "cancelled", "interrupted"].includes(
            run.state,
          ),
          `Command ended before approval: ${run.error?.code}`,
        );
        return engine.store.listPendingRunApprovals(runId).length === 1;
      },
      options.boundaryTimeoutMs,
      "persistent original approval",
    );
    const approval = engine.store.listPendingRunApprovals(runId)[0]!;
    assert.equal(existsSync(paths.marker), false);
    assert.equal(launches(), commands);
    return { source, runId, approval };
  }
  async function approve(started: Awaited<ReturnType<typeof startCommand>>) {
    await command(engine, "approval.decide", {
      approvalId: started.approval.id,
      decision: "allow",
      fingerprint: started.approval.fingerprint,
    });
    await until(
      () =>
        existsSync(paths.marker) &&
        /^\d+$/.test(readFileSync(paths.marker, "utf8")),
      options.boundaryTimeoutMs,
      "persistent physical PID",
    );
    lastPid = Number(readFileSync(paths.marker, "utf8"));
    await until(
      () =>
        engine
          .inspectOwnedCommandJobs(scope.workspace.id, scope.session.id)
          .some(
            (job) =>
              job.source.runId === started.runId && job.state === "running",
          ),
      options.boundaryTimeoutMs,
      "persistent native running job",
    );
    const job = engine
      .inspectOwnedCommandJobs(scope.workspace.id, scope.session.id)
      .find((job) => job.source.runId === started.runId)!;
    lastGroupPid = job.groupPid!;
    commands++;
    assert.equal(launches(), commands);
    assert.ok(lastPid > 0 && lastGroupPid > 0 && groupExists(lastGroupPid));
    assert.equal(job.source.approvalId, started.approval.id);
    assert.equal(job.source.approvalFingerprint, started.approval.fingerprint);
    assert.equal(job.source.runId, started.runId);
    assert.equal(engine.store.getTurn(job.source.turnId).runId, started.runId);
    assert.equal(
      engine.store.getAttempt(job.source.attemptId).turnId,
      job.source.turnId,
    );
    assert.equal(
      engine.store.getToolCall(job.source.toolCallId).state,
      "running",
    );
    const output = engine.captureOwnedCommandJobOutput({
      workspaceId: scope.workspace.id,
      jobId: job.jobId,
    });
    assert.throws(() => engine.readOwnedCommandJobOutput({ ...output }, {}));
    engine.releaseOwnedCommandJobHandle(output);
    assert.throws(() => engine.readOwnedCommandJobOutput(output, {}));
    return job;
  }
  function launches() {
    return existsSync(paths.launches)
      ? readFileSync(paths.launches, "utf8").trim().split("\n").length
      : 0;
  }
  function assertBudget(
    runId: string,
    runConfig: RunConfig,
    admittedConfigSha256: string,
  ) {
    assert.equal(hash(engine.store.getRun(runId).config), admittedConfigSha256);
    const usage = engine.coordinator.getRunUsage(runId);
    assert.ok(
      usage.turns <= runConfig.limits.maxTurns &&
        usage.toolCalls <= runConfig.limits.maxToolCalls &&
        usage.outputBytes <= runConfig.limits.maxOutputBytes,
    );
    return usage;
  }
  async function cycle(index: number, kind: "complete" | "cancel" | "text") {
    assert.ok(canAccept(4));
    scope =
      kind === "cancel"
        ? { workspace: cancelWorkspace, session: cancelSession }
        : { workspace, session };
    const gate = kind === "text" ? local.gate() : undefined;
    const started =
      kind === "text" ? null : await startCommand(`cycle-${index}-source`);
    const source =
      started?.source ??
      (await accept(`cycle-${index}-source`, observerConfig));
    const runId = started?.runId ?? (await promoted(source.receipt.inputId)),
      runConfig = started ? config : observerConfig;
    if (gate)
      await bounded(
        gate.reached.promise,
        options.boundaryTimeoutMs,
        "persistent observer gate",
      );
    const queue = await accept(`cycle-${index}-queue`, observerConfig);
    const steer = await accept(`cycle-${index}-steer`, runConfig, "steer");
    const cancelled = await accept(`cycle-${index}-cancelled`, observerConfig);
    const counts = persistentNativeCounts(paths.dbPath);
    const duplicate = await command<InputReceipt>(
      engine,
      "input.accept",
      queue.input as unknown as JsonObject,
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.inputId, queue.receipt.inputId);
    assert.deepEqual(persistentNativeCounts(paths.dbPath), counts);
    for (const input of [queue, steer, cancelled])
      assert.equal(
        engine.store.getInput(input.receipt.inputId).state,
        "pending",
      );
    await command(engine, "input.cancel", {
      sessionId: scope.session.id,
      inputId: cancelled.receipt.inputId,
    });
    let job: OwnedCommandJobRecord | undefined;
    if (started) {
      job = await approve(started);
      if (kind === "cancel")
        await bounded(
          engine.cancelOwnedCommandJob({
            workspaceId: scope.workspace.id,
            jobId: job.jobId,
            requestId: `cycle-${index}-active-cancel`,
            expectedRevision: job.revision,
          }),
          options.boundaryTimeoutMs,
          "persistent native cancel",
        );
      else writeFileSync(paths.release, "Explicit persistent release\n");
    } else gate!.release.resolve();
    const run = await bounded(
      engine.waitForRun(runId),
      options.boundaryTimeoutMs,
      "persistent source settlement",
    );
    assert.equal(run.state, kind === "cancel" ? "cancelled" : "completed");
    if (kind === "cancel") {
      assert.equal(
        engine.store.getSessionControl(scope.session.id).paused,
        true,
      );
      assert.equal(
        engine.store.getInput(queue.receipt.inputId).state,
        "pending",
      );
      assert.equal(
        engine.store.getInput(steer.receipt.inputId).state,
        "pending",
      );
      assert.throws(
        () => engine.scheduler.resume(scope.session.id),
        (error) =>
          error instanceof EngineError && error.code === "CLEANUP_PENDING",
      );
    } else {
      const record = engine.store.getInput(steer.receipt.inputId);
      assert.equal(record.state, "promoted");
      assert.equal(record.runId, runId);
      const turns = engine.store.listTurns(runId);
      assert.equal(turns.length, 2);
      assert.ok(turns[1]!.inputIds.includes(steer.receipt.inputId));
      if (kind === "text") {
        assert.equal(local.lastRequest(runId)?.turnIndex, 1);
        assert.equal(
          local.lastRequest(runId)?.latestPromptSha256,
          hash(steer.input.prompt),
        );
      }
    }
    await bounded(
      engine.scheduler.waitForSession(scope.session.id),
      options.boundaryTimeoutMs,
      "persistent queue settlement",
    );
    const queued = engine.store.getInput(queue.receipt.inputId);
    if (kind !== "cancel") {
      assert.equal(queued.state, "promoted");
      assert.ok(queued.runId && queued.runId !== runId);
      assert.equal(engine.store.getRun(queued.runId).state, "completed");
      assertBudget(queued.runId, observerConfig, queue.configSha256);
    } else assert.equal(queued.state, "pending");
    assert.equal(
      engine.store.getInput(cancelled.receipt.inputId).state,
      "cancelled",
    );
    assert.equal(
      engine.store.getInput(cancelled.receipt.inputId).runId,
      undefined,
    );
    const usage = assertBudget(runId, runConfig, source.configSha256);
    if (job) {
      await until(
        () => pidAbsent(lastPid) && !groupExists(lastGroupPid),
        options.boundaryTimeoutMs,
        "persistent physical cleanup",
      );
      const settled = engine.getOwnedCommandJob(scope.workspace.id, job.jobId)!;
      assert.equal(
        settled.state,
        kind === "cancel" ? "uncertain" : "completed",
      );
      assert.equal(settled.completion!.outcome.cleanupConfirmed, true);
      assert.equal(
        engine.getAttemptCleanup(scope.session.id, job.source.attemptId)
          .cleanupConfirmed,
        true,
      );
      assert.equal(usage.toolCalls, 1);
      if (kind === "complete") {
        assert.equal(settled.completion!.outcome.exitCode, 0);
        assert.equal(settled.completion!.checkpoint.runId, runId);
        assert.equal(
          settled.completion!.checkpoint.toolCallId,
          job.source.toolCallId,
        );
        for (const output of [
          settled.completion!.stdout,
          settled.completion!.stderr,
        ]) {
          assert.ok(
            output.artifactBytes <= config.budgets!.maxArtifactBytes &&
              output.observedBytes <= config.budgets!.maxProducerBytes,
          );
          assert.equal(
            createHash("sha256")
              .update(readFileSync(output.path))
              .digest("hex"),
            output.sha256,
          );
        }
        completedCommands++;
      } else {
        assert.equal(settled.completion!.outcome.cancelled, true);
        cancelledCommands++;
        cancellation = {
          workspaceId: scope.workspace.id,
          sessionId: scope.session.id,
          runId,
          jobId: settled.jobId,
          jobSha256: settled.sha256,
          sourceSha256: settled.source.sha256,
          approvalId: settled.source.approvalId,
          approvalFingerprint: settled.source.approvalFingerprint,
          queuedInputId: queue.receipt.inputId,
          steerInputId: steer.receipt.inputId,
          cancelledInputId: cancelled.receipt.inputId,
          pid: lastPid,
          groupPid: lastGroupPid,
          physicalCleanupConfirmed: true,
          nativeCleanupConfirmed: false,
          resumeOutcome: "cleanup-pending",
        };
      }
      checkpointJobs.push({
        workspaceId: scope.workspace.id,
        jobId: settled.jobId,
        state: settled.state,
        sha256: settled.sha256,
        sourceSha256: settled.source.sha256,
      });
      evidenceDigest.update(
        hash({
          index,
          job: settled,
          source: engine.store.getInput(source.receipt.inputId),
          usage,
        }),
      );
    } else {
      textCycles++;
      evidenceDigest.update(
        hash({
          index,
          run,
          steer: engine.store.getInput(steer.receipt.inputId),
          usage,
        }),
      );
    }
    completedCycles++;
    scope = { workspace, session };
  }
  async function checkpoint() {
    await command(engine, "session.pause", { sessionId: session.id });
    const pending = await accept("graceful-reopen-queue", observerConfig),
      calls = local.calls(),
      launchCount = launches();
    await close();
    const before = persistentNativeDigest(paths.dbPath);
    engine = open();
    instance++;
    const after = persistentNativeDigest(paths.dbPath);
    assert.deepEqual(after, before);
    assert.deepEqual(local.calls(), calls);
    assert.equal(launches(), launchCount);
    if (cancellation) {
      assert.equal(
        engine.getOwnedCommandJob(cancellation.workspaceId, cancellation.jobId)!
          .sha256,
        cancellation.jobSha256,
      );
      assert.equal(
        engine.store.getInput(cancellation.queuedInputId).state,
        "pending",
      );
      assert.equal(
        engine.store.getInput(cancellation.steerInputId).state,
        "pending",
      );
      assert.throws(
        () => engine.scheduler.resume(cancellation!.sessionId),
        (error) =>
          error instanceof EngineError && error.code === "CLEANUP_PENDING",
      );
    }
    assert.equal(
      engine.store.getInput(pending.receipt.inputId).state,
      "pending",
    );
    await bounded(
      engine.scheduler.wake(session.id),
      options.boundaryTimeoutMs,
      "paused checkpoint wake",
    );
    assert.deepEqual(local.calls(), calls);
    await command(engine, "session.resume", { sessionId: session.id });
    await bounded(
      engine.scheduler.waitForSession(session.id),
      options.boundaryTimeoutMs,
      "explicit checkpoint resume",
    );
    assert.equal(local.calls().command, calls.command);
    assert.equal(local.calls().observer, calls.observer + 1);
    assert.equal(launches(), launchCount);
    return {
      before,
      after,
      noAutomaticReplay: true,
      explicitQueueResume: true,
      engineInstance: instance,
    };
  }
  async function crashReady() {
    const started = await startCommand("persistent-crash-source");
    const queue = await accept("persistent-crash-queue", observerConfig),
      cancelled = await accept("persistent-crash-cancelled", observerConfig);
    await command(engine, "input.cancel", {
      sessionId: session.id,
      inputId: cancelled.receipt.inputId,
    });
    const job = await approve(started);
    const proposalPart = engine.store
      .listParts(job.source.turnId)
      .find(
        (part) =>
          part.type === "tool" && part.toolCallId === job.source.toolCallId,
      )!;
    assert.ok(proposalPart && proposalPart.state === "open");
    return {
      workspaceId: workspace.id,
      sessionId: session.id,
      runId: started.runId,
      job,
      proposalPartId: proposalPart.id,
      pid: lastPid,
      groupPid: lastGroupPid,
      config,
      commandText,
      queuedInputId: queue.receipt.inputId,
      cancelledInputId: cancelled.receipt.inputId,
      before: persistentNativeDigest(paths.dbPath),
    };
  }
  async function close() {
    await bounded(
      engine.close(),
      options.boundaryTimeoutMs,
      "persistent Engine close",
    );
  }
  return {
    ...paths,
    workspace,
    session,
    config,
    observerConfig,
    local,
    commandText,
    engine: () => engine,
    instance: () => instance,
    canAccept,
    cycle,
    checkpoint,
    crashReady,
    close,
    launches,
    lastPhysical: () => ({ pid: lastPid, groupPid: lastGroupPid }),
    summary: () => ({
      workspaceId: workspace.id,
      sessionId: session.id,
      cycles: completedCycles,
      inputs,
      inputBytes,
      commands,
      completedCommands,
      cancelledCommands,
      textCycles,
      providerCalls: local.calls(),
      cycleEvidenceSha256: evidenceDigest.copy().digest("hex"),
      jobs: checkpointJobs,
      cancellation,
    }),
  };
}
export type PersistentFixture = Awaited<
  ReturnType<typeof createPersistentFixture>
>;
