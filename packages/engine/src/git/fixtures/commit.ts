import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import type { TestContext } from "node:test";
import type {
  JsonObject,
  Workspace,
  Session,
  RunReceipt,
  ApprovalRecord,
} from "@moodcode/contracts";
import { createEngine } from "../../engine.js";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
export const gitFixture = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
export async function commitFixture(
  t: TestContext,
  options: { enabled?: boolean; hooks?: string; timeoutMs?: number } = {},
) {
  const base = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-approved-git-")),
    ),
    root = join(base, "repository"),
    dbPath = join(base, "engine.sqlite"),
    artifactDir = join(base, "artifacts");
  await mkdir(root);
  gitFixture(root, "init", "--quiet", "--template=");
  await mkdir(join(root, ".git", "hooks"));
  gitFixture(root, "config", "user.name", "Moodcode Fixture");
  gitFixture(root, "config", "user.email", "fixture@example.invalid");
  gitFixture(root, "config", "commit.gpgSign", "false");
  await writeFile(join(root, "a.ts"), "const alpha = 1;\n");
  await writeFile(join(root, "other.ts"), "const other = 1;\n");
  gitFixture(root, "add", ".");
  gitFixture(root, "commit", "-m", "Initial fixture");
  await writeFile(join(root, "a.ts"), "const alpha = 2;\n");
  await writeFile(join(root, "other.ts"), "const other = 2;\n");
  gitFixture(root, "add", "a.ts", "other.ts");
  const provider: ProviderAdapter = {
    id: "commit-fixture",
    async *streamTurn(request): AsyncGenerator<ProviderEvent> {
      if (request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: {
            id: "verify-before-commit",
            name: "verify_changes",
            input: { checkId: "check" },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield { type: "text.delta", delta: "Verification completed." };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  const config = {
    dbPath,
    artifactDir,
    verificationTools: true,
    gitCommits: options.enabled !== false,
    providers: [provider],
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "build" as const,
      limits: { maxTurns: 4, maxDurationMs: 20000, toolTimeoutMs: 10000 },
    },
    agentProfiles: [
      {
        id: "verifier",
        description: "Actual verification",
        instructions: "Use the registered check.",
        tools: ["verify_changes", "run_command"],
      },
    ],
  };
  let engine = createEngine(config);
  t.after(async () => {
    await engine.close();
    await rm(base, { recursive: true, force: true });
  });
  const command = async <T>(type: string, payload: JsonObject): Promise<T> => {
    const result = await engine.dispatch({
      schemaVersion: 1,
      commandId: randomUUID(),
      type,
      payload,
    });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.result as unknown as T;
  };
  const workspace = await command<Workspace>("workspace.open", { path: root }),
    session = await command<Session>("session.create", {
      workspaceId: workspace.id,
    }),
    profile = engine.profiles.list()[0]!;
  engine.registerVerificationCheck({
    id: "check",
    revision: 1,
    workspaceId: workspace.id,
    command: "printf actual-verification",
    cwd: root,
    profileId: profile.id,
    profileRevision: profile.revision,
    sourceRevision: "test",
    timeoutMs: 2000,
    maxOutputBytes: 8192,
    required: true,
  });
  await engine.configureVerificationSession(session.id, 0, {
    checkIds: ["check"],
    sourcePaths: ["a.ts"],
    maxRepairs: 0,
  });
  const submitted = await command<RunReceipt>("run.submit", {
    sessionId: session.id,
    requestId: randomUUID(),
    prompt: "Verify the selected change.",
    config: { agentProfileId: profile.id },
  });
  let approval: ApprovalRecord | undefined;
  const deadline = Date.now() + 10000;
  while (
    !(approval = engine.store
      .getSnapshot(session.id)
      .approvals.find((a) => a.status === "pending"))
  ) {
    assert.ok(Date.now() < deadline);
    await tick();
  }
  await command("approval.decide", {
    approvalId: approval.id,
    fingerprint: approval.fingerprint,
    decision: "allow",
  });
  const run = await engine.waitForRun(submitted.runId);
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(
    engine.getVerificationState(session.id, run.id)!.receipts[0]!.status,
    "pass",
  );
  const preview = async (
    requestId = randomUUID(),
    selection: "staged" | "working-tree" = "staged",
  ) =>
    engine.previewGitCommit({
      sessionId: session.id,
      requestId,
      runId: run.id,
      paths: ["a.ts"],
      message: "Reviewed alpha change",
      selection,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
  const input = (original: object, decision: "allow" | "deny" = "allow") => {
    const p = engine.readGitCommitPreview(original);
    return {
      workspaceId: workspace.id,
      sessionId: session.id,
      requestId: p.requestId,
      previewSha256: p.sha256,
      expectedRevision: 1 as const,
      decision,
    };
  };
  return {
    base,
    root,
    dbPath,
    artifactDir,
    workspace,
    session,
    run,
    config,
    command,
    preview,
    input,
    get engine() {
      return engine;
    },
    async reopen() {
      await engine.close();
      engine = createEngine(config);
      return engine;
    },
  };
}
