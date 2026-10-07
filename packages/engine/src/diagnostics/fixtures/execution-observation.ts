import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { setImmediate as tick } from "node:timers/promises";
import {
  EngineError,
  type ApprovalRecord,
  type JsonObject,
  type RunReceipt,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
import type { TestContext } from "node:test";
import { createEngine, type EngineOptions } from "../../engine.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  TurnRequest,
} from "../../ports.js";
import type {
  DiagnosticExecutionPage,
  DiagnosticExecutionPageOptions,
} from "../execution-observation-types.js";

export const ORIGINAL =
  'export const actualDiagnosticSource = "private-source-before";\n';
export const CHANGED =
  'export const actualDiagnosticSource = "private-source-after";\n';
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const stop: ProviderEvent = { type: "finish", reason: "stop" };
export async function dispatch<T>(
  engine: ReturnType<typeof createEngine>,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const reply = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.result as unknown as T;
}
export async function until(
  check: () => boolean,
  context = "Actual diagnostic boundary",
): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert.ok(performance.now() < deadline, context);
    await tick();
  }
}
export const errorCode = (expected: string) => (error: unknown) =>
  error instanceof EngineError && error.code === expected;
export function invoke<T>(
  engine: ReturnType<typeof createEngine>,
  method: string,
  ...args: unknown[]
): T {
  const fn = Reflect.get(engine, method);
  assert.equal(typeof fn, "function", `Actual Engine must expose ${method}`);
  return Reflect.apply(fn, engine, args) as T;
}
export interface ObservationFixtureOptions {
  enabled?: boolean;
  extra?: Partial<EngineOptions>;
  setup?: (root: string) => void;
  script: (
    request: TurnRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ProviderEvent>;
}
export async function observationFixture(
  t: TestContext,
  options: ObservationFixtureOptions,
) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-execution-observation-engine-")),
    ),
    root = join(base, "repo"),
    dbPath = join(base, "engine.sqlite");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "source.ts"), ORIGINAL);
  options.setup?.(root);
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: "actual-execution-observation",
    streamTurn(request, signal) {
      requests.push(structuredClone(request));
      return options.script(request, signal);
    },
  };
  const configuration: EngineOptions = {
    dbPath,
    artifactDir: join(base, "artifacts"),
    providers: [provider],
    ...(options.enabled === false ? {} : { diagnosticObservations: true }),
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "build",
      limits: { maxTurns: 8, maxDurationMs: 12000, maxOutputBytes: 65536 },
      budgets: { maxProviderAttempts: 8, retryBaseDelayMs: 0 },
    },
    ...options.extra,
  };
  const engine = createEngine(configuration),
    engines = new Set([engine]);
  t.after(async () => {
    for (const current of engines) await current.close();
    rmSync(base, { recursive: true, force: true });
  });
  const workspace = await dispatch<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await dispatch<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
  const submit = (config: JsonObject = {}) =>
    dispatch<RunReceipt>(engine, "run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt: "private-diagnostic-prompt",
      config,
    });
  const page = (
    runId: string,
    options: DiagnosticExecutionPageOptions = {},
    current = engine,
  ) =>
    invoke<DiagnosticExecutionPage>(current, "getExecutionObservations", {
      workspaceId: workspace.id,
      runId,
      ...options,
    });
  const approval = async (runId: string) => {
    let pending: ApprovalRecord | undefined;
    await until(() => {
      pending = engine.store.listPendingRunApprovals(runId)[0];
      if (!pending)
        assert.ok(
          !["completed", "failed", "cancelled"].includes(
            engine.store.getRun(runId).state,
          ),
          JSON.stringify(engine.store.getRun(runId)),
        );
      return !!pending;
    });
    return pending!;
  };
  const decide = (
    value: ApprovalRecord,
    decision: "allow" | "deny" = "allow",
  ) =>
    dispatch(engine, "approval.decide", {
      approvalId: value.id,
      fingerprint: value.fingerprint,
      decision,
    });
  return {
    base,
    root,
    dbPath,
    engine,
    workspace,
    session,
    requests,
    submit,
    page,
    approval,
    decide,
    epoch() {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return Number(
          db
            .prepare(
              "SELECT epoch FROM diagnostic_effect_epochs WHERE workspace_id=?",
            )
            .get(workspace.id)?.epoch ?? 0,
        );
      } finally {
        db.close();
      }
    },
    reopen() {
      const current = createEngine(configuration);
      engines.add(current);
      return current;
    },
    stall(runId: string) {
      return engine.getStallObservation({ sessionId: session.id, runId });
    },
  };
}
