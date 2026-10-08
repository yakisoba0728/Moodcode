import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { TestContext } from "node:test";
import {
  DEFAULT_LIMITS,
  type JsonObject,
  type RunConfig,
  type Workspace,
  type Session,
  type RunReceipt,
  type ProviderToolCall,
} from "@moodcode/contracts";
import { createEngine, type EngineOptions } from "../../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const patch = (
  id: string,
  path: string,
  before: string,
  after: string,
): ProviderToolCall => ({
  id,
  name: "apply_patch",
  input: { changes: [{ path, expectedHash: hash(before), content: after }] },
});
export async function until(
  check: () => boolean,
  detail: string,
  timeout = 10000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, detail);
    await new Promise((r) => setTimeout(r, 3));
  }
}
export async function command<T>(
  engine: ReturnType<typeof createEngine>,
  type: string,
  payload: JsonObject,
): Promise<T> {
  const response = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type,
    payload,
  });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result as T;
}
export async function batchFixture(
  t: Pick<TestContext, "after">,
  options: {
    calls?: ProviderToolCall[];
    enabled?: boolean;
    profileTools?: string[];
    directory?: string;
    engineOptions?: Partial<EngineOptions>;
  } = {},
) {
  const directory =
      options.directory ??
      realpathSync(mkdtempSync(join(tmpdir(), "moodcode-effects-"))),
    root = join(directory, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.txt"), "a");
  writeFileSync(join(root, "b.txt"), "b");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "Initial files",
    ],
    { cwd: root },
  );
  let entries = 0;
  const provider: ProviderAdapter = {
    id: "effect-fixture",
    async *streamTurn(): AsyncIterable<ProviderEvent> {
      if (++entries === 1) {
        for (const call of options.calls ?? [
          patch("a", "a.txt", "a", "A"),
          patch("b", "b.txt", "b", "B"),
        ])
          yield { type: "tool.call", call };
        yield { type: "finish", reason: "tool_calls" };
      } else yield { type: "finish", reason: "stop" };
    },
  };
  const dbPath = join(directory, "engine.sqlite"),
    artifactDir = join(directory, "artifacts");
  const engine = createEngine({
    dbPath,
    artifactDir,
    providers: [provider],
    effectBatches: options.enabled !== false,
    ...options.engineOptions,
  });
  t.after(async () => {
    await engine.close();
    if (!options.directory) rmSync(directory, { recursive: true, force: true });
  });
  const workspace = await command<Workspace>(engine, "workspace.open", {
      path: root,
    }),
    session = await command<Session>(engine, "session.create", {
      workspaceId: workspace.id,
    });
  engine.profiles.register({
    id: "effect-fixture-profile",
    description: "Bounded actual file effects",
    instructions: "Apply only the requested independently approved changes.",
    tools: options.profileTools ?? [
      "apply_patch",
      "edit_file",
      "rename_file",
      "delete_file",
      "run_command",
      "read_file",
    ],
  });
  const config: RunConfig = {
    providerId: provider.id,
    modelId: "local-fixture",
    mode: "build",
    agentProfileId: "effect-fixture-profile",
    limits: {
      ...DEFAULT_LIMITS,
      maxTurns: 3,
      maxToolCalls: 8,
      toolTimeoutMs: 15000,
      maxOutputBytes: 65536,
    },
  };
  const submit = () =>
    command<RunReceipt>(engine, "run.submit", {
      sessionId: session.id,
      requestId: randomUUID(),
      prompt: "Apply the original exact file proposals",
      config: JSON.parse(JSON.stringify(config)),
    });
  const pending = () =>
    engine.store
      .getSnapshot(session.id)
      .approvals.filter((a) => a.status === "pending");
  const approve = () => {
    for (const a of pending())
      engine.approvals.decide(a.id, "allow", a.fingerprint);
  };
  return {
    directory,
    root,
    dbPath,
    artifactDir,
    engine,
    workspace,
    session,
    config,
    provider,
    entries: () => entries,
    submit,
    pending,
    approve,
    records: () => engine.inspectEffectBatches(workspace.id, session.id),
  };
}
