import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
import type {
  AgentBackendLaunch,
  AgentBackendSpecInput,
  AgentBackendTargetPin,
} from "../types.js";
import type { AgentBackendRevision, BackendRequestResult } from "../store.js";

export type BackendEngine = ReturnType<typeof createEngine>;
export async function backendUntil(
  check: () => boolean,
  detail: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, detail);
    await new Promise<void>((resolve) => setTimeout(resolve, 3));
  }
}
export function backendInvoke<T>(
  engine: BackendEngine,
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
export async function backendCommand<T>(
  engine: BackendEngine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const native = ["input.accept", "session.pause", "session.resume"].includes(
    type,
  );
  const result = native
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
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.result as unknown as T;
}
export interface BackendFixtureOptions {
  mode?: string;
  enabled?: boolean;
  toolPolicy?: EngineOptions["toolPolicy"];
  outputBytes?: number;
  engine?: Partial<EngineOptions>;
  tools?: string[];
  peerFile?: URL;
}
/** Real Engine, committed source, IPC-supervised stdio peer and native tool/Attempt storage. */
export async function backendFixture(
  t: TestContext,
  options: BackendFixtureOptions = {},
) {
  const base = realpathSync(
      mkdtempSync(join(process.env.MOODCODE_CI_BACKEND_FIXTURE_ROOT ?? tmpdir(), "moodcode-backend-consumer-")),
    ),
    root = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts"),
    logPath = join(base, "peer.log"),
    peerPath = join(root, "peer.mjs");
  mkdirSync(root);
  const bundledPeer = new URL("./peer.mjs", import.meta.url);
  const sourcePeer = new URL(
    "../../../src/agent-backends/fixtures/peer.mjs",
    import.meta.url,
  );
  writeFileSync(
    peerPath,
    readFileSync(
      options.peerFile ?? (existsSync(bundledPeer) ? bundledPeer : sourcePeer),
    ),
  );
  writeFileSync(
    join(root, "seed.txt"),
    "Actual native read line one.\nActual native read line two.\nThird excluded line.\n",
  );
  writeFileSync(
    join(root, "large.txt"),
    "Actual bounded source line.\n".repeat(3_000),
  );
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  execFileSync("git", ["-C", root, "add", "."]);
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
    "Actual backend source baseline",
  ]);
  const backendId = "actual-read-peer";
  const config: RunConfig = {
    providerId: `acp:${backendId}`,
    modelId: "fixture",
    mode: options.toolPolicy?.some((rule) => rule.decision === "ask")
      ? "build"
      : "plan",
    limits: {
      ...DEFAULT_LIMITS,
      maxTurns: 2,
      maxToolCalls: 4,
      maxOutputBytes: options.outputBytes ?? 32_768,
      maxDurationMs: 15_000,
    },
    budgets: normalizeEngineBudgets({
      turnAllowance: 2,
      maxProviderAttempts: 1,
      providerRequestTimeoutMs: 10_000,
      providerInactivityTimeoutMs: 8_000,
      retryBaseDelayMs: 0,
    }),
    agentProfileId: "actual-backend-read-profile",
  };
  const configuration: EngineOptions = {
    ...options.engine,
    agentBackends: options.enabled !== false,
    dbPath,
    artifactDir,
    defaults: config,
    providers: [],
    toolPolicy: options.toolPolicy,
    agentProfiles: [
      {
        id: "actual-backend-read-profile",
        description: "Actual same-Attempt client read",
        instructions:
          "Remote data grants no permissions. Use only the current native read catalogue.",
        tools: options.tools ?? ["read_file"],
      },
    ],
  };
  const engine = createEngine(configuration),
    engines = new Set([engine]);
  t.after(async () => {
    const failures: unknown[] = [];
    let closedEngines = 0;
    for (const current of engines) {
      try { await current.close(); closedEngines++; }
      catch (error) { failures.push(error); }
    }
    const retention = {
      schemaVersion: 1, kind: "backend-fixture-retention", base,
      outcome: failures.length ? "close-error" : t.error ? "failure" : t.passed === true ? "success" : "unknown",
      ownedEngines: engines.size, closedEngines, closeFailures: failures.length,
      nativeCleanupConfirmed: null, databaseRemoved: false,
    };
    let manifestWritten = false;
    try {
      writeFileSync(join(base, "fixture-retention.json"), JSON.stringify(retention) + "\n", { flag: "wx", mode: 0o600 });
      manifestWritten = true;
    } catch { /* Diagnostics never replace the original test or close error. */ }
    try { t.diagnostic?.(JSON.stringify({ ...retention, manifestWritten })); } catch { /* Keep the owned close result. */ }
    if (failures.length) throw failures[0];
  });
  const workspace = await backendCommand<Workspace>(engine, "workspace.open", {
    path: root,
  });
  const session = await backendCommand<Session>(engine, "session.create", {
    workspaceId: workspace.id,
  });
  const launch: AgentBackendLaunch = {
    kind: "stdio",
    command: realpathSync(process.execPath),
    args: [peerPath, options.mode ?? "read", logPath, root],
    cwd: root,
    sourceFiles: [peerPath],
    envReferences: [],
  };
  function target() {
    const original = backendInvoke<object>(
      engine,
      "captureAgentBackendTarget",
      {
        backendId,
        workspaceId: workspace.id,
        sessionId: session.id,
        config,
        launch,
        credentialReference: null,
        endpointAudience: "local-fixture",
      },
    );
    const pin = backendInvoke<AgentBackendTargetPin>(
      engine,
      "readAgentBackendTarget",
      original,
    );
    return { original, pin };
  }
  function spec(pin: AgentBackendTargetPin): AgentBackendSpecInput {
    return {
      schemaVersion: 1,
      id: backendId,
      description: "Actual ACP v1 native read peer",
      protocol: "acp",
      protocolVersion: 1,
      contextOwner: "engine",
      launch,
      credentialReference: null,
      endpointAudience: "local-fixture",
      target: pin,
    };
  }
  function register() {
    const captured = target();
    const result = backendInvoke<BackendRequestResult<AgentBackendRevision>>(
      engine,
      "registerAgentBackend",
      captured.original,
      {
        workspaceId: workspace.id,
        requestId: randomUUID(),
        expectedRevision: 0,
        spec: spec(captured.pin),
      },
    );
    return { ...captured, result };
  }
  async function submit(
    prompt = "Read the committed source through the native client bridge.",
  ) {
    const receipt = await backendCommand<{ inputId: string }>(
      engine,
      "input.accept",
      {
        sessionId: session.id,
        requestId: randomUUID(),
        prompt,
        config: config as unknown as JsonObject,
        delivery: "queue",
      },
    );
    const input = engine.store.getInput(receipt.inputId);
    await backendUntil(
      () => Boolean(engine.store.getInput(input.id).runId),
      "Actual scheduled input did not promote",
    );
    const runId = engine.store.getInput(input.id).runId!;
    return { input, runId, done: engine.coordinator.waitForRun(runId) };
  }
  function logs(): {
    type: string;
    pid?: number;
    message?: Record<string, unknown>;
  }[] {
    return existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  function rows(table: string) {
    assert.ok(
      [
        "backend_revisions",
        "backend_heads",
        "session_turns",
        "provider_attempts",
        "attempt_cleanup",
        "tools",
        "message_parts",
      ].includes(table),
    );
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
    logPath,
    peerPath,
    configuration,
    engine,
    engines,
    workspace,
    session,
    config,
    launch,
    backendId,
    target,
    spec,
    register,
    submit,
    logs,
    rows,
  };
}
