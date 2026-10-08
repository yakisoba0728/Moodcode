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
import { setImmediate as tick } from "node:timers/promises";
import type { TestContext } from "node:test";
import type {
  ApprovalRecord,
  JsonObject,
  RunReceipt,
  Session,
  Workspace,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../../engine.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  ToolDefinition,
  TurnRequest,
} from "../../ports.js";
import type { LifecycleHookRegistration } from "../index.js";

const stop: ProviderEvent = { type: "finish", reason: "stop" };

async function until(check: () => boolean) {
  const deadline = performance.now() + 4000;
  while (!check()) {
    assert.ok(
      performance.now() < deadline,
      "Authored actual lifecycle boundary did not arrive",
    );
    await tick();
  }
}
async function command<T>(
  engine: ReturnType<typeof createEngine>,
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
interface FixtureOptions {
  imageInput?: boolean;
  generationBody?: string;
  tools?: ToolDefinition[];
  hooks?: LifecycleHookRegistration[];
  extra?: Partial<EngineOptions>;
  verification?: boolean;
  limit?: number;
  maxTurns?: number;
  script?: (
    request: TurnRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ProviderEvent>;
}
/** Own one original Engine and native directory for each scenario. */
export async function transformFixture(
  t: TestContext,
  options: FixtureOptions = {},
) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-engine-transforms-")),
    ),
    root = join(base, "repo"),
    dbPath = join(base, "engine.sqlite");
  mkdirSync(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  writeFileSync(join(root, "source.ts"), "export const actualSource = 1;\n");
  const requests: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: "actual-lifecycle-transforms",
    ...(options.imageInput
      ? { inputModalities: ["text", "image"] as const }
      : {}),
    ...(options.generationBody === undefined
      ? {}
      : {
          streamGeneration() {
            return (async function* (): AsyncGenerator<ProviderEvent> {
              yield { type: "text.delta", delta: options.generationBody! };
              yield stop;
            })();
          },
        }),
    streamTurn(request, signal) {
      requests.push(structuredClone(request));
      return (
        options.script?.(request, signal) ??
        (async function* () {
          yield {
            type: "text.delta" as const,
            delta: "Actual fixture complete.",
          };
          yield stop;
        })()
      );
    },
  };
  const configuration: EngineOptions = {
    dbPath,
    artifactDir: join(base, "artifacts"),
    providers: [provider],
    ...(options.verification
      ? { verificationTools: true }
      : { tools: options.tools ?? [] }),
    ...(options.hooks ? { lifecycleHooks: options.hooks } : {}),
    defaults: {
      providerId: provider.id,
      modelId: "fixture-model",
      mode: "build",
      limits: {
        maxContextBytes: options.limit ?? 65536,
        maxTurns: options.maxTurns ?? 5,
        maxDurationMs: 10000,
      },
      budgets: { maxProviderAttempts: 6, retryBaseDelayMs: 0 },
    },
    ...options.extra,
  };
  const engine = createEngine(configuration);
  t.after(async () => {
    await engine.close();
    rmSync(base, { force: true, recursive: true });
  });
  const workspace = await command<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await command<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
  const submit = (
    prompt = 'Exact required request "quoted" 한글😀',
    requestId: string = randomUUID(),
    config: JsonObject = {},
  ) =>
    command<RunReceipt>(engine, "run.submit", {
      sessionId: session.id,
      requestId,
      prompt,
      config,
    });
  const pendingApproval = async (runId: string) => {
    let approval: ApprovalRecord | undefined;
    await until(() => {
      approval = engine.store.listPendingRunApprovals(runId)[0];
      if (!approval) {
        const run = engine.store.getRun(runId);
        assert.ok(
          !["completed", "failed", "cancelled"].includes(run.state),
          JSON.stringify({
            run,
            tools: engine.store.getSnapshot(session.id).tools,
          }),
        );
      }
      return !!approval;
    });
    return approval!;
  };
  const events = () => engine.store.readSessionEvents(session.id, 0, 100);
  const count = (
    table:
      | "provider_attempts"
      | "turns"
      | "summary_attempts"
      | "knowledge_generations",
  ) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    } finally {
      db.close();
    }
  };
  return {
    base,
    root,
    dbPath,
    engine,
    workspace,
    session,
    provider,
    requests,
    submit,
    pendingApproval,
    events,
    count,
  };
}
