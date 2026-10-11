import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
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
import { fileURLToPath } from "node:url";
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
import { git, jsonDigest, shellQuote } from "../evaluation/runtime.js";
import { ScriptedProvider } from "../provider/scripted.js";
import type { ProviderAdapter } from "../ports.js";
import type { OwnedCommandJobRecord } from "../jobs/owned-command-records.js";
import { inspectExecutionLock } from "../tools/command/execution-lock.js";
import { cleanupGroup, groupExists } from "../tools/command/process-control.js";
import type { ResilienceScenario } from "./options.js";

export const COMMAND_PROFILE = {
  id: "resilience-command",
  description: "Local approved resilience command",
  instructions: "Execute only the exact explicitly approved fixture command.",
  tools: ["run_command"],
};
export const OBSERVER_PROFILE = {
  id: "resilience-observer",
  description: "Local queue observer",
  instructions: "Queued text has no command authority.",
  tools: [],
};
export const PROFILES = [COMMAND_PROFILE, OBSERVER_PROFILE];
export const POSIX_SUPPORTED = ["darwin", "linux", "freebsd"].includes(
  process.platform,
);
export const hash = jsonDigest;
export const RUNTIME_EXTENSION = import.meta.url.endsWith(".ts") ? "ts" : "js";
export function newBase(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "moodcode-resilience-")));
}
export class FixtureAdmissionFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly cleanupConfirmed: boolean,
  ) {
    super("Actual resilience fixture admission failed", { cause: original });
  }
}
export function pidAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
export async function bounded<T>(
  operation: Promise<T>,
  timeoutMs: number,
  boundary: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Resilience boundary timed out: ${boundary}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function until(
  check: () => boolean,
  timeoutMs: number,
  boundary: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    assert.ok(performance.now() < deadline, `Boundary timeout: ${boundary}`);
    await new Promise<void>((yes) => setTimeout(yes, 5));
  }
}
export async function command<T>(
  engine: MoodcodeEngine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const response = [
    "input.accept",
    "input.cancel",
    "session.pause",
    "session.resume",
  ].includes(type)
    ? await engine.dispatchSession({
        schemaVersion: 2,
        commandId: randomUUID(),
        type,
        payload,
      })
    : await engine.dispatch({
        schemaVersion: 1,
        commandId: randomUUID(),
        type,
        payload,
      });
  assert.equal(response.ok, true, `Native ${type}: ${response.error?.code}`);
  return response.result as unknown as T;
}
export function tableCounts<T extends string>(
  db: DatabaseSync,
  tables: readonly T[],
): Record<T, number> {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
    ]),
  ) as Record<T, number>;
}
export function nativeSnapshot(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = [
      "runs",
      "tools",
      "checkpoints",
      "session_inputs",
      "session_turns",
      "provider_attempts",
      "message_parts",
      "attempt_cleanup",
    ] as const;
    const counts = tableCounts(db, tables);
    // The full table body is bounded by this isolated scenario, never a user DB.
    const records = tables.map((table) => {
      assert.ok(
        counts[table] <= 128,
        "Fixture native history unexpectedly grew",
      );
      return [
        table,
        db.prepare(`SELECT data FROM ${table} ORDER BY data`).all(),
      ];
    });
    const events = db
      .prepare(
        "SELECT type,count(*) n FROM session_events GROUP BY type ORDER BY type",
      )
      .all()
      .map((row) => ({ type: String(row.type), count: Number(row.n) }));
    return { counts, events, recordsSha256: hash(records) };
  } finally {
    db.close();
  }
}
export interface IterationResult {
  iteration: number;
  seed: number;
  scenario: ResilienceScenario;
  passed: boolean;
  durationMs: number;
  boundariesMs: Record<string, number>;
  providerCalls: { command: number; observer: number; reopened: number };
  processLaunches: number;
  noReplay: boolean;
  cleanup: {
    engineClosed: boolean;
    physicalGroupAbsent: boolean;
    databaseRemoved: boolean;
    retainedEvidencePath: string | null;
  };
  native: null | {
    beforeReopen: ReturnType<typeof nativeSnapshot>;
    afterReopen: ReturnType<typeof nativeSnapshot>;
    job: {
      jobId: string;
      state: string;
      sha256: string;
      completionSha256: string | null;
    };
    sourceRunState: string;
    sourceConfigSha256: string;
    measuredUsage: {
      turns: number;
      toolCalls: number;
      outputBytes: number;
    } | null;
    unknownTokenAttempts: number;
    tokens: null;
    cost: null;
    pendingInputState: string;
    cancelledInputState: string;
    resumeOutcome: "resumed" | "cleanup-pending";
  };
  failure: null | { name: string; code: string | null; message: string };
}
export function resultBase(
  iteration: number,
  seed: number,
  scenario: ResilienceScenario,
): IterationResult {
  return {
    iteration,
    seed,
    scenario,
    passed: false,
    durationMs: 0,
    boundariesMs: {},
    providerCalls: { command: 0, observer: 0, reopened: 0 },
    processLaunches: 0,
    noReplay: false,
    cleanup: {
      engineClosed: false,
      physicalGroupAbsent: false,
      databaseRemoved: false,
      retainedEvidencePath: null,
    },
    native: null,
    failure: null,
  };
}
export function failureOf(error: unknown): IterationResult["failure"] {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    code: error instanceof EngineError ? error.code : null,
    message: (error instanceof Error
      ? error.message
      : "Resilience check failed"
    ).slice(0, 512),
  };
}
export function jobSummary(job: OwnedCommandJobRecord) {
  return {
    jobId: job.jobId,
    state: job.state,
    sha256: job.sha256,
    completionSha256: job.completion ? hash(job.completion) : null,
  };
}
export function localProviders(commandText: string) {
  const commands = new ScriptedProvider([
    {
      events: [
        {
          type: "tool.call",
          call: {
            id: "resilience-owned-command",
            name: "run_command",
            input: { command: commandText, timeoutMs: 60000 },
          },
        },
        { type: "finish", reason: "tool_calls" },
      ],
    },
    { events: [{ type: "finish", reason: "stop" }] },
  ]);
  const observations = new ScriptedProvider([
    {
      events: [
        { type: "text.delta", delta: "Local queued observation completed." },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);
  const observer: ProviderAdapter = {
    id: "resilience-observer",
    streamTurn: (request, signal) => observations.streamTurn(request, signal),
  };
  return {
    providers: [commands, observer],
    calls: () => ({
      command: commands.callCount,
      observer: observations.callCount,
    }),
  };
}
export interface FixturePaths {
  base: string;
  root: string;
  dbPath: string;
  artifactDir: string;
  marker: string;
  launches: string;
  release: string;
}
export function fixturePaths(base: string): FixturePaths {
  const root = join(base, "repository");
  return {
    base,
    root,
    dbPath: join(base, "engine.sqlite"),
    artifactDir: join(base, "artifacts"),
    marker: join(root, "command.pid"),
    launches: join(root, "command.launches"),
    release: join(root, "command.release"),
  };
}
export function launchCount(paths: FixturePaths): number {
  return existsSync(paths.launches)
    ? readFileSync(paths.launches, "utf8").trim().split("\n").length
    : 0;
}
/** Writes the owned fixture command and returns its exact shell command text. */
export function writeCommandScript(
  paths: FixturePaths,
  label: string,
  payloadJs: string,
): string {
  const script = join(paths.root, "command.mjs");
  writeFileSync(
    script,
    `import{appendFileSync,writeFileSync,renameSync,existsSync}from'node:fs';
appendFileSync(${JSON.stringify(paths.launches)},String(process.pid)+'\\n');
writeFileSync(${JSON.stringify(paths.marker + ".tmp")},String(process.pid));
renameSync(${JSON.stringify(paths.marker + ".tmp")},${JSON.stringify(paths.marker)});
process.stdout.write('${label}_READY\\n'+${payloadJs});
const gate=setInterval(()=>{if(existsSync(${JSON.stringify(paths.release)})){clearInterval(gate);process.stdout.write('\\n${label}_DONE\\n',()=>process.exit(0));}},5);
`,
  );
  return `${shellQuote(process.execPath)} ${shellQuote(script)}`;
}
export function initFixtureRepository(
  root: string,
  preservedText: string,
  message: string,
): void {
  writeFileSync(join(root, "preserved.txt"), preservedText);
  git(root, "init", "--quiet", "--template=");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Resilience Fixture",
    "-c",
    "user.email=resilience@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    message,
  );
}
/** Command and observer configs; observerTurns caps observer runs that never take a steer. */
export function fixtureRunConfigs(options: {
  modelId: string;
  observerProviderId: string;
  maxPendingInputs: number;
  observerTurns?: number;
}) {
  const config: RunConfig = {
    providerId: "scripted",
    modelId: options.modelId,
    mode: "build",
    agentProfileId: COMMAND_PROFILE.id,
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
      maxPendingInputs: options.maxPendingInputs,
      maxPendingBytes: 65536,
      maxToolCallsPerTurn: 1,
      maxArtifactBytes: 65536,
      maxProducerBytes: 131072,
      retryBaseDelayMs: 0,
    }),
  };
  const turns = options.observerTurns;
  const observerConfig: RunConfig = {
    ...config,
    providerId: options.observerProviderId,
    mode: "plan",
    agentProfileId: OBSERVER_PROFILE.id,
    ...(turns === undefined
      ? {}
      : {
          limits: { ...config.limits, maxTurns: turns },
          budgets: { ...config.budgets!, turnAllowance: turns },
        }),
  };
  return { config, observerConfig };
}
export function openFixtureEngine(
  paths: Pick<FixturePaths, "dbPath" | "artifactDir">,
  providers: ProviderAdapter[],
  defaults: RunConfig,
  jobs = true,
): MoodcodeEngine {
  return createEngine({
    dbPath: paths.dbPath,
    artifactDir: paths.artifactDir,
    providers,
    defaults,
    agentProfiles: PROFILES,
    jobs,
  });
}
/** Forks a sibling worker module in this runtime mode, keeping a 32 KiB output tail. */
export function forkResilienceWorker(moduleBase: string, args: string[]) {
  const child = fork(
    fileURLToPath(
      new URL(`./${moduleBase}.${RUNTIME_EXTENSION}`, import.meta.url),
    ),
    args,
    {
      silent: true,
      execArgv:
        RUNTIME_EXTENSION === "ts"
          ? [
              "--import",
              fileURLToPath(
                new URL(
                  "../../../../node_modules/tsx/dist/loader.mjs",
                  import.meta.url,
                ),
              ),
            ]
          : [],
    },
  );
  let diagnostics = Buffer.alloc(0),
    exited = false;
  const capture = (data: Buffer) => {
    diagnostics = Buffer.concat([diagnostics, data]).subarray(-32768);
  };
  child.stdout!.on("data", capture);
  child.stderr!.on("data", capture);
  const ended = new Promise<void>((yes, no) => {
    child.once("error", no);
    child.once("exit", () => {
      exited = true;
      yes();
    });
  });
  // Attach a rejection handler while callers wait for their separately bounded readiness.
  void ended.catch(() => {});
  return {
    child,
    ended,
    exited: () => exited,
    diagnosticSha256: () => hash([...diagnostics]),
  };
}
/** In cleanup, attributes a leftover group to the worker only through its readiness or this fixture's exact lock marker. */
export function failedWorkerGroup(
  paths: FixturePaths,
  worker: ChildProcess,
  readyGroupPid: number | undefined,
) {
  const lock = paths.dbPath + ".effects.sqlite";
  const inspection = existsSync(lock) ? inspectExecutionLock(lock) : null;
  const marker = inspection?.marker;
  const groupPid =
    readyGroupPid ??
    (marker && marker.ownerPid === worker.pid ? marker.groupPid : null);
  return { inspection, groupPid };
}
export async function createFixture(
  base: string,
  seed: number,
  timeoutMs: number,
) {
  const paths = fixturePaths(base);
  mkdirSync(paths.root);
  const commandText = writeCommandScript(
    paths,
    "RESILIENCE",
    `'한글🙂'.repeat(${128 + (seed % 1024)})`,
  );
  initFixtureRepository(
    paths.root,
    `Seed ${seed}\n`,
    "Isolated resilience fixture",
  );
  const local = localProviders(commandText);
  const { config, observerConfig } = fixtureRunConfigs({
    modelId: "local-resilience",
    observerProviderId: "resilience-observer",
    maxPendingInputs: 4,
    observerTurns: 1,
  });
  const engine = openFixtureEngine(paths, local.providers, config);
  const engines = new Set([engine]);
  let actualPid = 0,
    actualGroupPid = 0;
  async function cleanup(success: boolean): Promise<void> {
    const results = await Promise.allSettled(
      [...engines].map((e) => bounded(e.close(), timeoutMs, "engine close")),
    );
    const failed = results.find((r) => r.status === "rejected");
    if (actualGroupPid && groupExists(actualGroupPid)) {
      const joined = await cleanupGroup(actualGroupPid);
      assert.equal(
        joined,
        true,
        "Emergency fixture cleanup must really join its process group",
      );
      throw new Error(
        "Engine close left a live command group; emergency cleanup is not a passing Engine cleanup receipt",
      );
    }
    if (actualPid)
      assert.equal(
        pidAbsent(actualPid),
        true,
        "Fixture left a real process alive",
      );
    if (failed?.status === "rejected") throw failed.reason;
    if (success) rmSync(base, { recursive: true, force: true });
  }
  try {
    const workspace = await command<Workspace>(engine, "workspace.open", {
      path: paths.root,
    });
    const session = await command<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
    const sourceInput = {
      sessionId: session.id,
      requestId: "resilience-source",
      prompt: "Execute the exact approved local command once.",
      config,
      delivery: "queue",
    };
    const accepted = await command<InputReceipt>(
      engine,
      "input.accept",
      sourceInput as unknown as JsonObject,
    );
    await until(
      () => !!engine.store.getInput(accepted.inputId).runId,
      timeoutMs,
      "source input promotion",
    );
    const runId = engine.store.getInput(accepted.inputId).runId!;
    await until(
      () => {
        const run = engine.store.getRun(runId);
        assert.ok(
          !["failed", "cancelled", "completed", "interrupted"].includes(
            run.state,
          ),
          `Source ended before approval: ${run.error?.code}`,
        );
        return engine.store
          .getSnapshot(session.id)
          .approvals.some((a) => a.runId === runId && a.status === "pending");
      },
      timeoutMs,
      "original pending approval",
    );
    const approval = engine.store
      .getSnapshot(session.id)
      .approvals.find((a) => a.runId === runId && a.status === "pending")!;
    assert.equal(
      existsSync(paths.marker),
      false,
      "Approval wait must not spawn a process",
    );
    const queuedInput = {
      sessionId: session.id,
      requestId: "resilience-queued-observation",
      prompt: "Observe only after the owned source releases its session.",
      config: observerConfig,
      delivery: "queue",
    };
    const queued = await command<InputReceipt>(
      engine,
      "input.accept",
      queuedInput as unknown as JsonObject,
    );
    const duplicate = await command<InputReceipt>(
      engine,
      "input.accept",
      queuedInput as unknown as JsonObject,
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.inputId, queued.inputId);
    assert.equal(engine.store.getInput(queued.inputId).state, "pending");
    assert.equal(local.calls().observer, 0);
    const cancelled = await command<InputReceipt>(engine, "input.accept", {
      ...queuedInput,
      requestId: "resilience-cancel-before-promotion",
    } as unknown as JsonObject);
    await command(engine, "input.cancel", {
      sessionId: session.id,
      inputId: cancelled.inputId,
    });
    assert.equal(engine.store.getInput(cancelled.inputId).state, "cancelled");
    engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    await until(
      () => {
        if (!existsSync(paths.marker)) return false;
        const raw = readFileSync(paths.marker, "utf8");
        if (!/^\d+$/.test(raw)) return false;
        actualPid = Number(raw);
        return Number.isSafeInteger(actualPid) && actualPid > 0;
      },
      timeoutMs,
      "actual command PID",
    );
    const jobs = () => engine.inspectOwnedCommandJobs(workspace.id, session.id);
    await until(
      () => jobs().some((job) => job.state === "running"),
      timeoutMs,
      "native owned job running",
    );
    const job = jobs()[0]!;
    actualGroupPid = job.groupPid!;
    assert.ok(actualGroupPid > 0 && groupExists(actualGroupPid));
    assert.equal(job.source.runId, runId);
    assert.equal(job.source.approvalId, approval.id);
    assert.equal(job.source.approvalFingerprint, approval.fingerprint);
    assert.equal(
      engine.store.getToolCall(job.source.toolCallId).state,
      "running",
    );
    assert.equal(engine.store.getTurn(job.source.turnId).runId, runId);
    assert.equal(
      engine.store.getAttempt(job.source.attemptId).turnId,
      job.source.turnId,
    );
    const output = engine.captureOwnedCommandJobOutput({
      workspaceId: workspace.id,
      jobId: job.jobId,
    });
    assert.throws(() => engine.readOwnedCommandJobOutput({ ...output }, {}));
    engine.releaseOwnedCommandJobHandle(output);
    assert.throws(() => engine.readOwnedCommandJobOutput(output, {}));
    return {
      ...paths,
      engine,
      engines,
      config,
      commandText,
      workspace,
      session,
      runId,
      job,
      actualPid,
      actualGroupPid,
      accepted,
      queued,
      cancelled,
      queuedInput,
      local,
      finish: () => writeFileSync(paths.release, "Explicit fixture release\n"),
      launchCount: () => launchCount(paths),
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup(false);
    } catch (cleanupError) {
      throw new FixtureAdmissionFailure(
        new AggregateError(
          [error, cleanupError],
          "Fixture admission and cleanup failed",
        ),
        false,
      );
    }
    throw new FixtureAdmissionFailure(error, true);
  }
}
export type ResilienceFixture = Awaited<ReturnType<typeof createFixture>>;
