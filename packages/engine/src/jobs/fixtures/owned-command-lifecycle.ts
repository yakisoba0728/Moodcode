import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { RunReceipt } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import type { OwnedCommandJobRecord } from "../owned-command-records.js";
import { jobCommand, jobFixture, jobInvoke, jobUntil } from "./job.js";

export const ownedLifecycleProfile = {
  id: "actual-owned-lifecycle-profile",
  description: "Actual lifecycle approval",
  instructions: "Execute only the actual explicitly approved command.",
  tools: ["run_command"],
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** An actual Root, repository, native model tool call, approval and POSIX command. */
export async function ownedLifecycleFixture(t: TestContext) {
  const f = await jobFixture(t, { createTerminal: false }),
    marker = join(f.root, "owned-lifecycle.pid"),
    launches = join(f.root, "owned-lifecycle.launches"),
    release = join(f.root, "owned-lifecycle.release"),
    script = join(f.root, "owned-lifecycle.mjs");
  writeFileSync(
    script,
    `import{appendFileSync,writeFileSync,renameSync,existsSync}from'node:fs';
appendFileSync(${JSON.stringify(launches)},String(process.pid)+'\\n');
writeFileSync(${JSON.stringify(marker + '.pending')},String(process.pid));
renameSync(${JSON.stringify(marker + '.pending')},${JSON.stringify(marker)});
process.stdout.write('OWNED_LIFECYCLE_READY\\n');
const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('OWNED_LIFECYCLE_COMPLETE\\n',()=>process.exit(0));}},10);
`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  let calls = 0;
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(): AsyncIterable<ProviderEvent> {
      if (++calls === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-owned-lifecycle",
            name: "run_command",
            input: { command, timeoutMs: 15_000 },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield { type: "finish", reason: "stop" };
    },
  };
  (
    Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
  ).set(provider.id, provider);
  f.engine.profiles.register(ownedLifecycleProfile);
  const config = {
    ...f.config,
    agentProfileId: ownedLifecycleProfile.id,
    mode: "build" as const,
    limits: {
      ...f.config.limits,
      maxTurns: 2,
      maxToolCalls: 1,
      maxOutputBytes: 65_536,
      maxDurationMs: 20_000,
      toolTimeoutMs: 17_000,
    },
    budgets: { ...f.config.budgets!, turnAllowance: 2 },
  };
  const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
    sessionId: f.session.id,
    requestId: randomUUID(),
    prompt: "Observe the explicitly approved command lifecycle",
    config: JSON.parse(JSON.stringify(config)),
  });
  await jobUntil(() => {
    const run = f.engine.store.getRun(receipt.runId);
    assert.ok(
      !["failed", "cancelled", "completed"].includes(run.state),
      `Actual run failed before approval: ${JSON.stringify(run)}`,
    );
    return f.engine.store
      .getSnapshot(f.session.id)
      .approvals.some(
        (a) => a.runId === receipt.runId && a.status === "pending",
      );
  }, "Actual lifecycle command did not request approval");
  const approval = f.engine.store
    .getSnapshot(f.session.id)
    .approvals.find(
      (a) => a.runId === receipt.runId && a.status === "pending",
    )!;
  f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
  await jobUntil(
    () => existsSync(marker),
    "Actual lifecycle command did not spawn",
  );
  const pid = Number(readFileSync(marker, "utf8"));
  await jobUntil(
    () =>
      jobInvoke<OwnedCommandJobRecord[]>(
        f.engine,
        "inspectOwnedCommandJobs",
        f.workspace.id,
      ).some((j) => j.state === "running"),
    "Actual command job was not durably admitted",
  );
  const job = jobInvoke<OwnedCommandJobRecord[]>(
    f.engine,
    "inspectOwnedCommandJobs",
    f.workspace.id,
  )[0]!;
  assert.ok(
    Number.isSafeInteger(pid) && pid > 0 && job.groupPid && job.groupPid > 0,
  );
  return {
    ...f,
    config,
    receipt,
    job,
    pid,
    launches,
    release,
    providerCalls: () => calls,
    finish() {
      writeFileSync(release, "Explicit user fixture continuation\n");
    },
  };
}

if (process.argv[2] === "--crash-child") {
  const cleanups: Array<() => void | Promise<void>> = [];
  const scope = {
    after(fn: () => void | Promise<void>) {
      cleanups.push(fn);
    },
  } as unknown as TestContext;
  try {
    const f = await ownedLifecycleFixture(scope);
    assert.ok(process.send);
    process.send({
      type: "ready",
      base: f.base,
      root: f.root,
      dbPath: f.dbPath,
      artifactDir: f.artifactDir,
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      runId: f.receipt.runId,
      job: f.job,
      pid: f.pid,
      launches: f.launches,
      config: f.config,
    });
    await new Promise<never>(() => {});
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
}
