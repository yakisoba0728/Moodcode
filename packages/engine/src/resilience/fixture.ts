import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import {
  DEFAULT_LIMITS,
  type InputReceipt,
  type JsonObject,
  type RunConfig,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import { createEngine, type MoodcodeEngine } from "../engine.js";
import { ScriptedProvider } from "../provider/scripted.js";
import type { ProviderAdapter } from "../ports.js";
import type { OwnedCommandJobRecord } from "../jobs/owned-command-records.js";
import { cleanupGroup, groupExists } from "../tools/command/process-control.js";

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
export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
    const counts = Object.fromEntries(
      tables.map((table) => [
        table,
        Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
      ]),
    ) as Record<(typeof tables)[number], number>;
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
export async function createFixture(
  base: string,
  seed: number,
  timeoutMs: number,
) {
  const paths = fixturePaths(base);
  mkdirSync(paths.root);
  const script = join(paths.root, "command.mjs");
  const outputCopies = 128 + (seed % 1024);
  writeFileSync(
    script,
    `import{appendFileSync,writeFileSync,renameSync,existsSync}from'node:fs';
appendFileSync(${JSON.stringify(paths.launches)},String(process.pid)+'\\n');
writeFileSync(${JSON.stringify(paths.marker + ".tmp")},String(process.pid));
renameSync(${JSON.stringify(paths.marker + ".tmp")},${JSON.stringify(paths.marker)});
process.stdout.write('RESILIENCE_READY\\n'+'한글🙂'.repeat(${outputCopies}));
const gate=setInterval(()=>{if(existsSync(${JSON.stringify(paths.release)})){clearInterval(gate);process.stdout.write('\\nRESILIENCE_DONE\\n',()=>process.exit(0));}},5);
`,
  );
  writeFileSync(join(paths.root, "preserved.txt"), `Seed ${seed}\n`);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", paths.root, ...args], {
      timeout: timeoutMs,
      stdio: "pipe",
    });
  git("init", "--quiet", "--template=");
  git("add", ".");
  git(
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
    "Isolated resilience fixture",
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const commandText = `${quote(process.execPath)} ${quote(script)}`;
  const local = localProviders(commandText);
  const config: RunConfig = {
    providerId: "scripted",
    modelId: "local-resilience",
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
      maxPendingInputs: 4,
      maxPendingBytes: 65536,
      maxToolCallsPerTurn: 1,
      maxArtifactBytes: 65536,
      maxProducerBytes: 131072,
      retryBaseDelayMs: 0,
    }),
  };
  const observerConfig: RunConfig = {
    ...config,
    providerId: "resilience-observer",
    mode: "plan",
    agentProfileId: OBSERVER_PROFILE.id,
    limits: { ...config.limits, maxTurns: 1 },
    budgets: { ...config.budgets!, turnAllowance: 1 },
  };
  const engine = createEngine({
    dbPath: paths.dbPath,
    artifactDir: paths.artifactDir,
    providers: local.providers,
    defaults: config,
    agentProfiles: PROFILES,
    jobs: true,
  });
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
      observerConfig,
      commandText,
      workspace,
      session,
      runId,
      approval,
      job,
      actualPid,
      actualGroupPid,
      accepted,
      queued,
      cancelled,
      queuedInput,
      local,
      finish: () => writeFileSync(paths.release, "Explicit fixture release\n"),
      launchCount: () =>
        readFileSync(paths.launches, "utf8").trim().split("\n").length,
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
