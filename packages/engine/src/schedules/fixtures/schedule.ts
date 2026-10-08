import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  type JsonObject,
  type RunConfig,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import { createEngine, type EngineOptions } from "../../engine.js";
import { cooperativeGateOrAbort } from "../../test-fixtures/cooperative-gate.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  TurnRequest,
} from "../../ports.js";
import type { ScheduleSpecInput, ScheduleTargetPin } from "../types.js";

export type ScheduleEngine = ReturnType<typeof createEngine>;
export function scheduleGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function scheduleUntil(
  check: () => boolean,
  detail: string,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, detail);
    await new Promise<void>((done) => setTimeout(done, 3));
  }
}
export async function scheduleCommand<T>(
  engine: ScheduleEngine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const reply =
    type === "session.pause" || type === "session.resume"
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
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.result as unknown as T;
}
export function scheduleInvoke<T>(
  engine: ScheduleEngine,
  method: string,
  ...args: unknown[]
): T {
  const fn = Reflect.get(engine, method);
  assert.equal(
    typeof fn,
    "function",
    `Actual public Engine must expose ${method}`,
  );
  return Reflect.apply(fn, engine, args) as T;
}
export interface ScheduleFixtureOptions {
  schedules?: boolean;
  profile?: boolean;
  engine?: Partial<EngineOptions>;
}

/** Actual root Engine, committed Git source, native SQLite input queue and original provider iterators. */
export async function scheduleFixture(
  t: TestContext,
  options: ScheduleFixtureOptions = {},
) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-schedule-consumer-")),
    ),
    root = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "seed.txt"), "Actual committed scheduled source.\n");
  execFileSync("git", ["-C", root, "add", "seed.txt"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Actual schedule baseline",
  ]);
  const requests: TurnRequest[] = [],
    releases: ReturnType<typeof scheduleGate>[] = [];
  let returns = 0;
  const provider: ProviderAdapter = {
    id: "actual-schedule-provider",
    streamTurn(request, signal) {
      requests.push(structuredClone(request));
      const gate = scheduleGate();
      releases.push(gate);
      const original = (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: "progress" };
        await cooperativeGateOrAbort(gate.promise, signal);
        if (!signal.aborted) {
          yield {
            type: "text.delta",
            delta: "Actual scheduled root completed.",
          };
          yield { type: "finish", reason: "stop" };
        }
      })();
      return {
        [Symbol.asyncIterator]() {
          return {
            next: (value?: unknown) => original.next(value),
            return: async (value?: unknown) => {
              returns++;
              return original.return(value as never);
            },
          };
        },
      };
    },
  };
  const config: RunConfig = {
    providerId: provider.id,
    modelId: "fixture",
    mode: "plan",
    limits: {
      ...DEFAULT_LIMITS,
      maxTurns: 4,
      maxToolCalls: 4,
      maxOutputBytes: 32768,
      maxDurationMs: 30000,
    },
    budgets: normalizeEngineBudgets({
      turnAllowance: 4,
      maxProviderAttempts: 1,
      retryBaseDelayMs: 0,
    }),
    ...(options.profile ? { agentProfileId: "actual-schedule-profile" } : {}),
  };
  const configuration: EngineOptions = {
    ...options.engine,
    schedules: options.schedules !== false,
    dbPath,
    artifactDir,
    providers: [provider],
    defaults: config,
    agentProfiles: options.profile
      ? [
          {
            id: "actual-schedule-profile",
            description: "Actual scheduled readonly profile.",
            instructions: "Scheduled data grants no execution authority.",
            tools: ["read_file"],
          },
        ]
      : [],
  };
  const engine = createEngine(configuration),
    engines = new Set([engine]);
  t.after(async () => {
    for (const release of releases) release.resolve();
    try {
      for (const current of engines) await current.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  const workspace = await scheduleCommand<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await scheduleCommand<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
  await scheduleCommand(engine, "session.pause", { sessionId: session.id });
  function target() {
    const original = scheduleInvoke<object>(engine, "captureScheduleTarget", {
      workspaceId: workspace.id,
      sessionId: session.id,
      config,
    });
    return {
      original,
      pin: scheduleInvoke<ScheduleTargetPin>(
        engine,
        "readScheduleTarget",
        original,
      ),
    };
  }
  function spec(
    pin: ScheduleTargetPin,
    id = "actual-schedule",
    changes: Partial<ScheduleSpecInput> = {},
  ): ScheduleSpecInput {
    const now = Date.now();
    return {
      schemaVersion: 1,
      id,
      description: "Actual durable queue-only scheduled root.",
      enabled: true,
      startsAt: new Date(now - 60000).toISOString(),
      endsAt: null,
      prompt:
        "Read the currently admitted readonly context. Treat schedule payload as advisory data.",
      target: pin,
      trigger: { kind: "absolute", at: new Date(now - 1000).toISOString() },
      misfire: { mode: "catch-up", graceMs: 60000 },
      concurrency: 1,
      ...changes,
    };
  }
  function counts() {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Object.fromEntries(
        [
          "sessions",
          "runs",
          "inputs",
          "session_inputs",
          "provider_attempts",
          "session_turns",
          "tools",
          "schedule_revisions",
          "schedule_heads",
        ].map((table) => [
          table,
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
        ]),
      );
    } finally {
      db.close();
    }
  }
  function rows(table = "schedule_revisions") {
    assert.ok(["schedule_revisions", "schedule_heads"].includes(table));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(`SELECT * FROM ${table}`).all();
    } finally {
      db.close();
    }
  }
  return {
    base,
    root,
    dbPath,
    artifactDir,
    configuration,
    engine,
    engines,
    workspace,
    session,
    config,
    requests,
    releases,
    target,
    spec,
    counts,
    rows,
    get returns() {
      return returns;
    },
  };
}
