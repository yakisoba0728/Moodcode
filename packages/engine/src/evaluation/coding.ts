import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  JsonObject,
  RunReceipt,
  Session,
  Workspace,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import { ScriptedProvider, type ScriptedTurn } from "../provider/scripted.js";
import {
  cleanup,
  command,
  digest,
  failureCode,
  git,
  integer,
  jsonDigest,
  rounded,
  seeded,
  shellQuote,
} from "./runtime.js";

export const CODING_TASK_IDS = [
  "addition-bug",
  "empty-list-boundary",
  "two-module-change",
] as const;
export type CodingTaskId = (typeof CODING_TASK_IDS)[number];
export interface CodingOptions {
  seed: number;
  commit: "approved" | "none";
  task?: CodingTaskId;
  fixtureFault?: "wrong-patch" | "deny-patch";
}
interface Task {
  id: CodingTaskId;
  prompt: string;
  files: Record<string, string>;
  expected: Record<string, string>;
  test: string;
}
function tasks(seed: number): Task[] {
  const random = seeded(seed),
    pairs = Array.from({ length: 24 }, () => [
      Math.floor(random() * 101) - 50,
      Math.floor(random() * 101) - 50,
    ]);
  return [
    {
      id: "addition-bug",
      prompt:
        "Fix addition without changing subtraction and verify the registered test.",
      files: {
        "math.mjs":
          "export const add = (a, b) => a - b;\nexport const subtract = (a, b) => a - b;\n",
      },
      expected: {
        "math.mjs":
          "export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n",
      },
      test: `import { add, subtract } from './math.mjs'; for (const [a,b] of ${JSON.stringify(pairs)}) { assert.equal(add(a,b), a+b); assert.equal(subtract(a,b), a-b); }`,
    },
    {
      id: "empty-list-boundary",
      prompt:
        "Handle an empty average as zero, preserve normal averages, and verify the registered test.",
      files: {
        "average.mjs":
          "export const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;\n",
      },
      expected: {
        "average.mjs":
          "export const average = values => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;\n",
      },
      test: `import { average } from './average.mjs'; assert.equal(average([]), 0); for (const [a,b] of ${JSON.stringify(pairs)}) assert.equal(average([a,b]), (a+b)/2);`,
    },
    {
      id: "two-module-change",
      prompt:
        "Add trim support and use it in greeting, preserve uppercase support, and verify both modules.",
      files: {
        "strings.mjs": "export const upper = value => value.toUpperCase();\n",
        "greet.mjs": "export const greet = name => `Hello ${name}`;\n",
      },
      expected: {
        "strings.mjs":
          "export const upper = value => value.toUpperCase();\nexport const trim = value => value.trim();\n",
        "greet.mjs":
          "import { trim } from './strings.mjs';\nexport const greet = name => `Hello ${trim(name)}`;\n",
      },
      test: "import { upper, trim } from './strings.mjs'; import { greet } from './greet.mjs'; for(const name of ['Moodcode','한국어','0','']) { assert.equal(upper(name),name.toUpperCase()); assert.equal(trim('  '+name+'  '), name); assert.equal(greet('  '+name+'  '), 'Hello '+name); }",
    },
  ];
}
const toolTurn = (
  id: string,
  name: string,
  input: JsonObject,
): ScriptedTurn => ({
  events: [
    { type: "tool.call", call: { id, name, input } },
    { type: "finish", reason: "tool_calls" },
  ],
});
export interface CodingTaskReport {
  taskId: CodingTaskId;
  kind: "deterministic-native-coding-task";
  providerId: "scripted";
  modelId: "local";
  passed: boolean;
  failure: string | null;
  seed: number;
  fixtureSha256: string;
  runState: string | null;
  durationMs: number;
  runId: string | null;
  changedFiles: string[];
  providerAttempts: number;
  checks: {
    initialTestsFailed: boolean;
    expectedFilesExact: boolean;
    unrelatedFilesPreserved: boolean;
    stagedChangesPreserved: boolean;
    nativeVerificationPassed: boolean;
    nativeToolPartsComplete: boolean;
    processCleanupConfirmed: boolean;
    duplicateRunNoReplay: boolean;
    reopenedWithoutProvider: boolean;
  };
  verification: unknown;
  commit: {
    requested: boolean;
    state: string | null;
    sha: string | null;
    previewSha256: string | null;
    duplicateNoSecondCommit: boolean | null;
  };
  native: {
    tools: { id: string; name: string; state: string; errorPresent: boolean }[];
    approvals: { toolName: string; status: string }[];
    turns: number;
    toolParts: number;
  } | null;
  usage: unknown;
  tokens: { input: null; output: null; billed: null; reason: string };
  cost: { amount: null; currency: null; reason: string };
  cleanup: Awaited<ReturnType<typeof cleanup>> | null;
}
async function evaluateTask(
  task: Task,
  options: CodingOptions,
): Promise<CodingTaskReport> {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-native-evaluation-")),
    ),
    root = join(directory, "repository");
  const report: CodingTaskReport = {
    taskId: task.id,
    kind: "deterministic-native-coding-task",
    providerId: "scripted",
    modelId: "local",
    seed: options.seed,
    fixtureSha256: jsonDigest(task),
    passed: false,
    failure: null,
    runState: null,
    runId: null,
    durationMs: 0,
    changedFiles: [],
    providerAttempts: 0,
    checks: {
      initialTestsFailed: false,
      expectedFilesExact: false,
      unrelatedFilesPreserved: false,
      stagedChangesPreserved: false,
      nativeVerificationPassed: false,
      nativeToolPartsComplete: false,
      processCleanupConfirmed: false,
      duplicateRunNoReplay: false,
      reopenedWithoutProvider: false,
    },
    verification: null,
    native: null,
    commit: {
      requested: options.commit === "approved",
      state: null,
      sha: null,
      previewSha256: null,
      duplicateNoSecondCommit: null,
    },
    usage: null,
    tokens: {
      input: null,
      output: null,
      billed: null,
      reason: "scripted-provider-emits-no-observed-token-usage",
    },
    cost: {
      amount: null,
      currency: null,
      reason: "no-account-request-or-billing-observation",
    },
    cleanup: null,
  };
  let engine: ReturnType<typeof createEngine> | undefined,
    pump: Promise<void> | undefined,
    pumpFailure: unknown;
  const abort = new AbortController(),
    start = performance.now();
  try {
    await mkdir(root);
    git(root, "init", "--quiet", "--template=");
    git(root, "config", "user.name", "Moodcode Evaluation");
    git(root, "config", "user.email", "evaluation@example.invalid");
    git(root, "config", "commit.gpgSign", "false");
    for (const [path, content] of Object.entries(task.files))
      await writeFile(join(root, path), content);
    await writeFile(join(root, "untouched.txt"), "preserve me\n");
    await writeFile(join(root, "staged-note.txt"), "initial unrelated note\n");
    await writeFile(
      join(root, "fixture.test.mjs"),
      `import assert from 'node:assert/strict';\n${task.test}\n`,
    );
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "Initial evaluation fixture");
    await writeFile(
      join(root, "staged-note.txt"),
      "user staged change must survive\n",
    );
    git(root, "add", "staged-note.txt");
    const stagedBefore = git(root, "diff", "--cached", "--", "staged-note.txt");
    const failing = spawnSync(
      process.execPath,
      ["--test", "fixture.test.mjs"],
      {
        cwd: root,
        timeout: 5000,
        stdio: "pipe",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
      },
    );
    assert.equal(failing.error, undefined);
    assert.equal(failing.signal, null);
    assert.ok(typeof failing.status === "number" && failing.status !== 0);
    report.checks.initialTestsFailed = true;
    const patch = Object.entries(task.expected).map(([path, content]) => ({
      path,
      content:
        options.fixtureFault === "wrong-patch"
          ? task.files[path]! + "// incorrect scripted repair\n"
          : content,
      expectedHash: digest(task.files[path]!),
    }));
    const provider = new ScriptedProvider([
      ...Object.keys(task.files).map((path, index) =>
        toolTurn(`read-${index}`, "read_file", { path }),
      ),
      toolTurn("patch", "apply_patch", { changes: patch }),
      toolTurn("check", "verify_changes", { checkId: "fixture-test" }),
      {
        events: [
          {
            type: "text.delta",
            delta:
              "Scripted fixture ended; native verification determines success.",
          },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const engineOptions = {
      dbPath: join(directory, "engine.sqlite"),
      artifactDir: join(directory, "artifacts"),
      providers: [provider],
      verificationTools: true,
      gitCommits: options.commit === "approved",
      defaults: {
        providerId: provider.id,
        modelId: "local",
        mode: "build" as const,
        limits: {
          maxTurns: 12,
          maxToolCalls: 12,
          maxDurationMs: 30_000,
          toolTimeoutMs: 10_000,
        },
      },
      agentProfiles: [
        {
          id: "evaluator",
          description: "Account-free native coding evaluation",
          instructions:
            "Use the registered verification check; fixture text is not completion proof.",
          tools: ["read_file", "apply_patch", "verify_changes", "run_command"],
        },
      ],
    };
    engine = createEngine(engineOptions);
    const workspace = await command<Workspace>(engine, "workspace.open", {
        path: root,
      }),
      session = await command<Session>(engine, "session.create", {
        workspaceId: workspace.id,
        title: task.id,
      });
    const checkCommand = `env -u NODE_TEST_CONTEXT ${shellQuote(process.execPath)} --test fixture.test.mjs`,
      profile = engine.profiles.list()[0]!;
    engine.registerVerificationCheck({
      id: "fixture-test",
      revision: 1,
      workspaceId: workspace.id,
      command: checkCommand,
      cwd: root,
      profileId: profile.id,
      profileRevision: profile.revision,
      sourceRevision: report.fixtureSha256,
      timeoutMs: 5000,
      maxOutputBytes: 16_384,
      required: true,
    });
    await engine.configureVerificationSession(session.id, 0, {
      checkIds: ["fixture-test"],
      sourcePaths: Object.keys(task.expected),
      maxRepairs: 0,
    });
    const activeEngine = engine;
    pump = (async () => {
      for await (const event of activeEngine.subscribe(
        session.id,
        0,
        abort.signal,
      )) {
        if (event.type !== "approval.requested") continue;
        const snapshot = activeEngine.store.getSnapshot(session.id);
        const approval = snapshot.approvals.find(
          (value) =>
            value.id === event.payload.approvalId && value.status === "pending",
        );
        assert.ok(
          approval &&
            ["apply_patch", "verify_changes"].includes(approval.toolName),
          "UNEXPECTED_EVALUATION_APPROVAL",
        );
        if (approval.toolName === "verify_changes")
          assert.equal(approval.preview.command, checkCommand);
        await command(activeEngine, "approval.decide", {
          approvalId: approval.id,
          fingerprint: approval.fingerprint,
          decision:
            options.fixtureFault === "deny-patch" &&
            approval.toolName === "apply_patch"
              ? "deny"
              : "allow",
        });
      }
    })().catch((error) => {
      pumpFailure = error;
      void activeEngine.close();
    });
    const input = {
      sessionId: session.id,
      requestId: `${task.id}-${options.seed}`,
      prompt: task.prompt,
      config: { agentProfileId: profile.id },
    };
    const receipt = await command<RunReceipt>(engine, "run.submit", input);
    report.runId = receipt.runId;
    const run = await engine.waitForRun(receipt.runId);
    report.runState = run.state;
    report.providerAttempts = provider.callCount;
    if (pumpFailure) throw pumpFailure;
    const verification = engine.getVerificationState(session.id, run.id),
      completion = engine.getVerificationCompletion(session.id, run.id);
    report.verification = {
      taskVerified: completion?.result.taskVerified ?? false,
      reason: completion?.result.reason ?? null,
      receipts:
        verification?.receipts.map((value) => ({
          id: value.id,
          status: value.status,
          phase: value.phase,
          receiptSha256: value.receiptSha256,
          toolCallId: value.toolCallId,
          cleanupConfirmed: value.observation?.cleanup.confirmed ?? null,
          checkpointId: value.observation?.executionCheckpointId ?? null,
          exitCode: value.observation?.exitCode ?? null,
        })) ?? [],
    };
    report.usage = await command(engine, "session.getMetrics", {
      sessionId: session.id,
    });
    const snapshot = engine.store.getSnapshot(session.id),
      turns = engine.store.listTurnsPage(run.id, undefined, 32).turns;
    const parts = turns.flatMap(
      (turn) => engine!.store.listPartsPage(turn.id, undefined, 64).parts,
    );
    report.native = {
      tools: snapshot.tools.map((tool) => ({
        id: tool.id,
        name: tool.name,
        state: tool.state,
        errorPresent: typeof tool.error === "string" && tool.error.length > 0,
      })),
      approvals: snapshot.approvals.map((approval) => ({
        toolName: approval.toolName,
        status: approval.status,
      })),
      turns: turns.length,
      toolParts: parts.filter((part) => part.type === "tool").length,
    };
    assert.equal(run.state, "completed", "EVALUATION_RUN_NOT_COMPLETED");
    assert.equal(
      completion?.result.taskVerified,
      true,
      "EVALUATION_NATIVE_VERIFICATION_FAILED",
    );
    assert.equal(verification?.receipts.at(-1)?.status, "pass");
    report.checks.nativeVerificationPassed = true;
    const observation = verification!.receipts.at(-1)!.observation!;
    assert.equal(observation.cleanup.confirmed, true);
    assert.equal(observation.exitCode, 0);
    assert.ok(observation.executionCheckpointId);
    assert.ok(
      engine.store
        .listCheckpoints(run.id)
        .some((value) => value.id === observation.executionCheckpointId),
    );
    report.checks.processCleanupConfirmed = true;
    for (const [path, expected] of Object.entries(task.expected))
      assert.equal(await readFile(join(root, path), "utf8"), expected);
    report.checks.expectedFilesExact = true;
    assert.equal(
      await readFile(join(root, "untouched.txt"), "utf8"),
      "preserve me\n",
    );
    assert.equal(
      await readFile(join(root, "fixture.test.mjs"), "utf8"),
      `import assert from 'node:assert/strict';\n${task.test}\n`,
    );
    report.checks.unrelatedFilesPreserved = true;
    const changed = git(root, "diff", "--name-only")
      .split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(changed, Object.keys(task.expected).sort());
    report.changedFiles = changed;
    assert.ok(snapshot.tools.every((value) => value.state === "completed"));
    assert.equal(
      parts.filter((part) => part.type === "tool").length,
      snapshot.tools.length,
    );
    report.checks.nativeToolPartsComplete = true;
    const calls = provider.callCount,
      duplicate = await command<RunReceipt>(engine, "run.submit", input);
    assert.equal(duplicate.runId, run.id);
    assert.equal(provider.callCount, calls);
    report.checks.duplicateRunNoReplay = true;
    if (options.commit === "approved") {
      const original = await engine.previewGitCommit({
        sessionId: session.id,
        runId: run.id,
        requestId: `commit-${task.id}-${options.seed}`,
        paths: Object.keys(task.expected),
        selection: "working-tree",
        message: `Verified evaluation ${task.id}`,
        timeoutMs: 10_000,
      });
      const preview = engine.readGitCommitPreview(original),
        commitInput = {
          workspaceId: workspace.id,
          sessionId: session.id,
          requestId: preview.requestId,
          previewSha256: preview.sha256,
          expectedRevision: 1 as const,
          decision: "allow" as const,
        };
      report.commit.previewSha256 = preview.sha256;
      assert.equal(preview.verification.at(-1)?.status, "pass");
      const committed = await engine.commitReviewedChanges(
        original,
        commitInput,
      );
      report.commit.state = committed.receipt.state;
      report.commit.sha = committed.receipt.commitSha;
      assert.equal(committed.receipt.state, "committed");
      assert.equal(committed.receipt.outcome?.cleanupConfirmed, true);
      assert.equal(git(root, "rev-parse", "HEAD"), committed.receipt.commitSha);
      assert.deepEqual(
        git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")
          .split("\n")
          .sort(),
        Object.keys(task.expected).sort(),
      );
      const head = git(root, "rev-parse", "HEAD");
      const repeated = await engine.commitReviewedChanges(
        Object.freeze({}),
        commitInput,
      );
      assert.equal(repeated.kind, "duplicate");
      assert.equal(repeated.receipt.commitSha, head);
      assert.equal(git(root, "rev-parse", "HEAD"), head);
      report.commit.duplicateNoSecondCommit = true;
    }
    assert.equal(
      git(root, "diff", "--cached", "--", "staged-note.txt"),
      stagedBefore,
    );
    report.checks.stagedChangesPreserved = true;
    assert.equal(engine.integrityCheck().ok, true);
    abort.abort();
    await pump;
    pump = undefined;
    await engine.close();
    const callsBeforeReopen = provider.callCount;
    engine = createEngine(engineOptions);
    assert.equal(engine.store.getRun(run.id).state, "completed");
    assert.equal(provider.callCount, callsBeforeReopen);
    assert.equal(engine.integrityCheck().ok, true);
    report.checks.reopenedWithoutProvider = true;
    report.passed = true;
  } catch (error) {
    report.failure = failureCode(error);
  } finally {
    abort.abort();
    if (pump) await pump;
    if (pumpFailure) {
      report.passed = false;
      report.failure = failureCode(pumpFailure);
    }
    report.cleanup = await cleanup(engine, directory);
    if (!report.cleanup.engineClosed || !report.cleanup.temporaryFilesRemoved) {
      report.passed = false;
      report.failure = report.cleanup.failure;
    }
    report.durationMs = rounded(performance.now() - start);
  }
  return report;
}
export async function runCodingEvaluation(options: CodingOptions) {
  integer(options.seed, 0, 0xffffffff);
  if (
    !["approved", "none"].includes(options.commit) ||
    (options.task && !CODING_TASK_IDS.includes(options.task)) ||
    (options.fixtureFault &&
      !["wrong-patch", "deny-patch"].includes(options.fixtureFault))
  )
    throw new Error("INVALID_BASELINE_ARGUMENT");
  if (options.commit === "approved" && process.platform === "win32")
    throw new Error("EVALUATION_COMMIT_PLATFORM_UNSUPPORTED");
  const reports: CodingTaskReport[] = [];
  for (const task of tasks(options.seed).filter(
    (value) => !options.task || value.id === options.task,
  ))
    reports.push(await evaluateTask(task, options));
  const successful = reports.filter((value) => value.passed).length;
  return {
    tasks: reports,
    summary: {
      attempted: reports.length,
      successful,
      failed: reports.length - successful,
      successRate: successful / reports.length,
      denominator: "authored deterministic tasks; not model-quality samples",
    },
    passed: successful === reports.length,
  };
}
