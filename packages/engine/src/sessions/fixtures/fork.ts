import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  type RunReceipt,
  type RunConfig,
  type JsonObject,
  type Session,
  type Workspace,
  isTerminal,
} from "@moodcode/contracts";
import { MoodcodeEngine } from "../../engine.js";
import type {
  ProviderAdapter,
  ProviderEvent,
  TurnRequest,
} from "../../ports.js";
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
export async function forkUntil(
  check: () => boolean,
  detail: string,
  timeout = 15000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, detail);
    await new Promise((r) => setTimeout(r, 5));
  }
}
export async function forkCommand<T>(
  engine: MoodcodeEngine,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const response = ["input.accept", "session.pause", "session.resume"].includes(
    type,
  )
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
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result as unknown as T;
}
export function forkCounts(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      sessions: Number(db.prepare("SELECT count(*) n FROM sessions").get()!.n),
      inputs: Number(
        db.prepare("SELECT count(*) n FROM session_inputs").get()!.n,
      ),
      tools: Number(db.prepare("SELECT count(*) n FROM tools").get()!.n),
      forks: Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_documents WHERE kind='conversation.fork.v1'",
          )
          .get()!.n,
      ),
      anchors: Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type='conversation.fork.materialized'",
          )
          .get()!.n,
      ),
    };
  } finally {
    db.close();
  }
}
export async function forkFixture(
  t: TestContext,
  options: { replay?: boolean; enabled?: boolean; skipSource?: boolean } = {},
) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "moodcode-fork-"))),
    root = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  mkdirSync(root);
  writeFileSync(join(root, "seed.txt"), "original\n");
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "add",
    ".",
  ]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "seed",
  ]);
  const held = new Map<
    string,
    { promise: Promise<void>; release: () => void }
  >();
  const entries: TurnRequest[] = [],
    command = `${quote(process.execPath)} -e ${quote("require('node:fs').appendFileSync('effect.txt','effect\\n');console.log('actual effect preserved')")}`;
  let sourceId = "";
  const provider: ProviderAdapter = {
    id: "fork-fixture",
    replayProtocol: "fixture-replay-v1",
    async *streamTurn(request, signal): AsyncIterable<ProviderEvent> {
      entries.push(structuredClone(request));
      if (signal.aborted) throw signal.reason;
      const source =
        request.sessionId === sourceId ||
        request.messages.at(-1)?.content === "write-new";
      if (source && request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: {
            id: `source-call-${request.runId}`,
            name: "run_command",
            input: { command, cwd: ".", timeoutMs: 3000 },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        const text = source
          ? "The approved effect has happened."
          : "Frozen history was consumed by the actual fork provider.";
        yield { type: "text.delta", delta: text };
        if (held.has(request.sessionId ?? ""))
          await held.get(request.sessionId ?? "")!.promise;
        yield {
          type: "finish",
          reason: "stop",
          ...(options.replay
            ? {
                replayItems: [
                  {
                    type: "message",
                    id: `message-${request.runId}`,
                    role: "assistant",
                    content: [{ type: "output_text", text }],
                  },
                ],
              }
            : {}),
        };
      }
    },
  };
  const config: RunConfig = {
    providerId: provider.id,
    modelId: "fork-model",
    mode: "build",
    limits: {
      maxTurns: 3,
      maxToolCalls: 2,
      maxDurationMs: 15000,
      toolTimeoutMs: 5000,
      maxOutputBytes: 65536,
      maxContextBytes: 131072,
    },
    budgets: normalizeEngineBudgets({
      turnAllowance: 3,
      maxProviderAttempts: 3,
      maxSummaryCalls: 1,
      maxToolCallsPerTurn: 2,
      maxPendingInputs: 8,
      maxPendingBytes: 262144,
      providerRequestTimeoutMs: 10000,
      providerInactivityTimeoutMs: 5000,
      maxArtifactBytes: 1048576,
      maxProducerBytes: 2097152,
    }),
  } as RunConfig;
  const engine = new MoodcodeEngine({
    dbPath,
    artifactDir,
    providers: [provider],
    conversationForks: options.enabled ?? true,
    defaults: config,
  });
  t.after(async () => {
    await engine.close();
    rmSync(base, { recursive: true, force: true });
  });
  const workspace = await forkCommand<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await forkCommand<Session>(engine, "session.create", {
      workspaceId: workspace.id,
      title: "Source",
    });
  sourceId = session.id;
  async function source(prompt = "source-effect") {
    const receipt = await forkCommand<RunReceipt>(engine, "run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt,
      config: JSON.parse(JSON.stringify(config)),
    });
    await forkUntil(
      () =>
        engine.store
          .getSnapshot(session.id)
          .approvals.some(
            (a) => a.runId === receipt.runId && a.status === "pending",
          ),
      `No genuine command approval ${JSON.stringify(engine.store.getRun(receipt.runId))}`,
    );
    const a = engine.store
      .getSnapshot(session.id)
      .approvals.find(
        (a) => a.runId === receipt.runId && a.status === "pending",
      )!;
    engine.approvals.decide(a.id, "allow", a.fingerprint);
    await forkUntil(
      () => isTerminal(engine.store.getRun(receipt.runId).state),
      "Source did not settle",
    );
    assert.equal(
      engine.store.getRun(receipt.runId).state,
      "completed",
      JSON.stringify(engine.store.getRun(receipt.runId)),
    );
    assert.equal(
      engine.store
        .getSnapshot(session.id)
        .tools.find((tool) => tool.runId === receipt.runId)!.state,
      "completed",
      JSON.stringify(engine.store.getSnapshot(session.id).tools),
    );
    return receipt;
  }
  const first = options.skipSource ? null : await source();
  return {
    base,
    root,
    dbPath,
    artifactDir,
    engine,
    workspace,
    session,
    config,
    entries,
    provider,
    first,
    source,
    hold: (sessionId: string) => {
      let release!: () => void;
      const promise = new Promise<void>((yes) => (release = yes));
      held.set(sessionId, { promise, release });
      return () => {
        held.delete(sessionId);
        release();
      };
    },
    effects: () => readFileSync(join(root, "effect.txt"), "utf8"),
  };
}
