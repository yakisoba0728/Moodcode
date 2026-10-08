import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EngineError } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import { commitFixture, gitFixture } from "../git/fixtures/commit.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const busy = (error: unknown) =>
  error instanceof EngineError &&
  ["WORKSPACE_BUSY", "CLEANUP_PENDING", "FORK_SOURCE_STALE"].includes(
    error.code,
  );
async function until(check: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, detail);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function sourceEvents(dbPath: string, runId: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      db
        .prepare("SELECT count(*) n FROM session_events WHERE run_id=?")
        .get(runId)!.n,
    );
  } finally {
    db.close();
  }
}

test(
  "one actual workspace owner fences Git commit and fork admission; settled ownership permits both without source replay",
  {
    skip: !["darwin", "linux", "freebsd"].includes(process.platform),
    timeout: 30000,
  },
  async (t) => {
    const f = await commitFixture(t);
    const entries: TurnRequest[] = [];
    const source = f.config.providers[0]!,
      sourceStream = source.streamTurn.bind(source);
    const provider: ProviderAdapter = {
      ...source,
      async *streamTurn(request, signal): AsyncGenerator<ProviderEvent> {
        entries.push(structuredClone(request));
        if (
          request.messages.at(-1)?.content ===
          "Consume frozen history in the new session."
        ) {
          yield {
            type: "text.delta",
            delta: "The new session consumed its frozen history.",
          };
          yield { type: "finish", reason: "stop" };
        } else {
          yield* sourceStream(request, signal);
        }
      },
    };
    Object.assign(f.config, {
      hostCommands: true,
      conversationForks: true,
      providers: [provider],
    });
    await f.reopen();
    const profile = f.engine.profiles.list().find((p) => p.id === "verifier")!;
    f.engine.registerVerificationCheck({
      id: "check",
      revision: 1,
      workspaceId: f.workspace.id,
      command: "printf actual-verification",
      cwd: f.root,
      profileId: profile.id,
      profileRevision: profile.revision,
      sourceRevision: "test",
      timeoutMs: 2000,
      maxOutputBytes: 8192,
      required: true,
    });
    const gitOriginal = await f.preview(),
      gitInput = f.input(gitOriginal);
    const forkInput = {
      sourceSessionId: f.session.id,
      prompt: "Consume frozen history in the new session.",
      disposition: "semantic" as const,
      config: {
        providerId: provider.id,
        modelId: "fixture",
        mode: "plan" as const,
      },
    };
    const forkOriginal = await f.engine.captureForkPreview(forkInput),
      forkProof = f.engine.readForkPreview(forkOriginal);
    const pidPath = join(f.base, "cross-feature.pid");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));console.log('ACTUAL_HOST_READY');setInterval(()=>{},50);`;
    const original = await f.engine.previewHostCommand({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      command: `exec ${quote(process.execPath)} -e ${quote(script)}`,
      limits: { maxDurationMs: 15000, maxOutputBytes: 65536 },
    });
    const started = await f.engine.startHostCommand({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview: original,
      fingerprint: f.engine.readHostCommandPreview(original).fingerprint,
      approved: true,
    });
    await until(
      () => existsSync(pidPath),
      "Actual independently owned process did not run",
    );
    const pid = Number(readFileSync(pidPath, "utf8")),
      head = gitFixture(f.root, "rev-parse", "HEAD");
    const beforeSessions = f.engine.store.listSessions(f.workspace.id).length;
    await assert.rejects(
      f.engine.commitReviewedChanges(gitOriginal, gitInput),
      busy,
    );
    await assert.rejects(
      async () =>
        f.engine.forkConversationView({
          preview: forkOriginal,
          requestId: randomUUID(),
          approved: true,
          approvalFingerprint: forkProof.sha256,
        }),
      busy,
    );
    assert.equal(gitFixture(f.root, "rev-parse", "HEAD"), head);
    assert.equal(
      f.engine.store.listSessions(f.workspace.id).length,
      beforeSessions,
    );
    assert.equal(entries.length, 0);
    assert.equal(
      f.engine.getGitCommitReceipt(
        f.workspace.id,
        f.session.id,
        gitInput.requestId,
      )!.state,
      "prepared",
    );
    const closed = await f.engine.cancelHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    assert.equal(closed.state, "cancelled");
    assert.equal(closed.completion?.outcome.cleanupConfirmed, true);
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
    const committed = await f.engine.commitReviewedChanges(
      gitOriginal,
      gitInput,
    );
    assert.equal(committed.receipt.state, "committed");
    assert.deepEqual(
      gitFixture(f.root, "diff", "--cached", "--name-only").split("\n"),
      ["other.ts"],
    );
    const committedHead = gitFixture(f.root, "rev-parse", "HEAD");
    const currentFork = await f.engine.captureForkPreview(forkInput),
      currentProof = f.engine.readForkPreview(currentFork);
    const beforeSourceEvents = sourceEvents(f.dbPath, f.run.id);
    const result = await f.engine.forkConversationView({
      preview: currentFork,
      requestId: randomUUID(),
      approved: true,
      approvalFingerprint: currentProof.sha256,
    });
    await until(
      () => Boolean(f.engine.store.getInput(result.record.input.inputId).runId),
      "Fork input did not promote",
    );
    const input = f.engine.store.getInput(result.record.input.inputId),
      run = await f.engine.waitForRun(input.runId!);
    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.equal(run.config.mode, "plan");
    assert.equal(
      f.engine.store.getSnapshot(result.record.sessionId).tools.length,
      0,
    );
    assert.equal(entries.length, 1);
    assert.ok(
      entries[0]!.messages.some((message) =>
        message.content.includes("[Frozen conversation quoted DATA]"),
      ),
    );
    assert.equal(sourceEvents(f.dbPath, f.run.id), beforeSourceEvents);
    assert.equal(gitFixture(f.root, "rev-parse", "HEAD"), committedHead);
    assert.equal(f.engine.store.getSnapshot(f.session.id).tools.length, 1);
    assert.equal(
      f.engine.getHostCommand(f.workspace.id, started.jobId)!.state,
      "cancelled",
    );
  },
);
