import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  type RunConfig,
  type RunReceipt,
  type Workspace,
  type Session,
} from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import { createEngine, type EngineOptions } from "../../engine.js";
import type { ProviderAdapter, TurnRequest } from "../../ports.js";
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function until(
  predicate: () => boolean,
  message: string,
  ms = 15000,
) {
  const end = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < end, message);
    await new Promise((r) => setTimeout(r, 5));
  }
}
export async function fixture(
  t: TestContext,
  extra: Partial<EngineOptions> = {},
  storageInsideWorkspace = false,
) {
  const base = realpathSync(
      mkdtempSync(join(tmpdir(), "moodcode-real-sandbox-")),
    ),
    root = join(base, "repo"),
    outside = join(base, "outside"),
    dbPath = join(storageInsideWorkspace ? root : base, "engine.sqlite"),
    artifactDir = join(storageInsideWorkspace ? root : base, "artifacts");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, "seed"), "workspace");
  writeFileSync(join(outside, "secret"), "outside");
  execFileSync("git", ["init", "-q", "--template=", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "seed",
  ]);
  let command = "printf allowed";
  let timeoutMs: number | undefined;
  const calls: TurnRequest[] = [];
  let tools = ["run_command"];
  const seen = new Set<string>();
  const provider: ProviderAdapter = {
    id: "sandbox-fixture",
    async *streamTurn(req) {
      calls.push(req);
      if (!seen.has(req.runId)) {
        seen.add(req.runId);
        yield {
          type: "tool.call",
          call: {
            id: "physical-sandbox-command",
            name: "run_command",
            input: {
              command,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text.delta", delta: "observed actual kernel effect" };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const config: RunConfig = {
    providerId: provider.id,
    modelId: "fixture",
    mode: "build",
    limits: {
      ...DEFAULT_LIMITS,
      maxTurns: 2,
      maxToolCalls: 2,
      maxDurationMs: 20000,
      maxOutputBytes: 65536,
      toolTimeoutMs: 4000,
    },
    budgets: normalizeEngineBudgets({
      turnAllowance: 2,
      maxProviderAttempts: 1,
      retryBaseDelayMs: 0,
    }),
  };
  const options: EngineOptions = {
    dbPath,
    artifactDir,
    defaults: config,
    providers: [provider],
    osSandbox: true,
    jobs: true,
    hostCommands: true,
    ...extra,
  };
  const engines = new Set<ReturnType<typeof createEngine>>();
  let engine = createEngine(options);
  engines.add(engine);
  t.after(async () => {
    for (const e of engines) await e.close().catch(() => {});
    rmSync(base, { recursive: true, force: true });
  });
  const dispatch = async <T>(type: string, payload: object) => {
    const r = await engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type,
      payload: payload as any,
    });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    return r.result as unknown as T;
  };
  const workspace = await dispatch<Workspace>("workspace.open", { path: root }),
    session = await dispatch<Session>("session.create", {
      workspaceId: workspace.id,
    });
  const grant = async (
    readPaths = [root],
    writePaths = [root],
    requestId: string = randomUUID(),
  ) => {
    await engine.registerSandboxBackend();
    const p = await engine.previewSandboxGrant({
      workspaceId: workspace.id,
      sessionId: session.id,
      config,
      readPaths,
      writePaths,
      network: "deny",
    });
    const g = engine.readSandboxGrant(p);
    return engine.approveSandboxGrant({
      workspaceId: workspace.id,
      requestId,
      expectedRevision: 0,
      preview: p,
      fingerprint: g.sha256,
      approved: true,
    });
  };
  const submit = async (cmd: string, timeout?: number) => {
    command = cmd;
    timeoutMs = timeout;
    return dispatch<RunReceipt>("run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt: "Run actual sandbox fixture",
      config,
    });
  };
  const approval = async (receipt: RunReceipt) => {
    await until(() => {
      const run = engine.store.getRun(receipt.runId);
      if (
        ["failed", "cancelled", "interrupted", "completed"].includes(run.state)
      )
        throw new Error(JSON.stringify(run));
      return engine.store
        .getSnapshot(session.id)
        .approvals.some(
          (a) => a.runId === receipt.runId && a.status === "pending",
        );
    }, "approval missing");
    return engine.store
      .getSnapshot(session.id)
      .approvals.find(
        (a) => a.runId === receipt.runId && a.status === "pending",
      )!;
  };
  const wait = async (receipt: RunReceipt) => {
    await until(
      () =>
        ["failed", "completed", "cancelled", "interrupted"].includes(
          engine.store.getRun(receipt.runId).state,
        ),
      "actual Run terminal",
    );
    return engine.store.getRun(receipt.runId);
  };
  const execute = async (
    cmd: string,
    decision: "allow" | "deny" = "allow",
    timeout?: number,
  ) => {
    const r = await submit(cmd, timeout),
      a = await approval(r);
    engine.approvals.decide(a.id, decision, a.fingerprint);
    return { run: await wait(r), approval: a, receipt: r };
  };
  return {
    base,
    root,
    outside,
    dbPath,
    artifactDir,
    config,
    workspace,
    session,
    get engine() {
      return engine;
    },
    calls,
    grant,
    submit,
    approval,
    wait,
    execute,
    dispatch,
    reopen: async () => {
      await engine.close();
      engine = createEngine(options);
      engines.add(engine);
      return engine;
    },
  };
}
