import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import type { RunConfig, RunReceipt } from "@moodcode/contracts";
import type { ProviderAdapter, ProviderEvent } from "../../ports.js";
import type { OwnedCommandJobRecord } from "../owned-command-records.js";
import type { OwnedCommandDeliveryResult } from "../owned-command-delivery-records.js";
import { jobCommand, jobFixture, jobInvoke, jobUntil } from "./job.js";

export const ownedDeliveryProfile = {
  id: "actual-owned-delivery-command",
  description: "Actual command source",
  instructions: "Execute only the explicitly approved source command.",
  tools: ["run_command"],
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function ownedDeliveryCounts(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      inputs: Number(
        db.prepare("SELECT count(*) n FROM session_inputs").get()!.n,
      ),
      deliveries: Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_documents WHERE kind GLOB 'command.delivery.*'",
          )
          .get()!.n,
      ),
      links: Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_documents WHERE kind GLOB 'command.input.*'",
          )
          .get()!.n,
      ),
      anchors: Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type='command.job.result_admitted'",
          )
          .get()!.n,
      ),
      inputEvents: Number(
        db
          .prepare(
            "SELECT count(*) n FROM session_events WHERE type='input.accepted'",
          )
          .get()!.n,
      ),
      turns: Number(
        db.prepare("SELECT count(*) n FROM session_turns").get()!.n,
      ),
      attempts: Number(
        db.prepare("SELECT count(*) n FROM provider_attempts").get()!.n,
      ),
    };
  } finally {
    db.close();
  }
}
export async function ownedDeliveryFixture(
  t: TestContext,
  options: {
    exitCode?: number;
    holdSourceFinish?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const f = await jobFixture(t, { createTerminal: false }),
    marker = join(f.root, "owned-delivery.pid"),
    release = join(f.root, "owned-delivery.release"),
    script = join(f.root, "owned-delivery.mjs");
  writeFileSync(
    script,
    `import{writeFileSync,existsSync,renameSync}from'node:fs';
writeFileSync(${JSON.stringify(marker + ".tmp")},String(process.pid));renameSync(${JSON.stringify(marker + ".tmp")},${JSON.stringify(marker)});process.stdout.write('ACTUAL_OWNED_DELIVERY_READY\\n');
const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write('ACTUAL_OWNED_DELIVERY_RESULT\\n',()=>process.exit(${options.exitCode ?? 0}));}},10);
`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  let entries = 0,
    finishSource!: () => void;
  const sourceGate = new Promise<void>((yes) => {
    finishSource = yes;
  });
  if (!options.holdSourceFinish) finishSource();
  t.after(() => finishSource());
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(): AsyncIterable<ProviderEvent> {
      const entry = ++entries;
      if (entry === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-owned-delivery-command",
            name: "run_command",
            input: { command, timeoutMs: options.timeoutMs ?? 10_000 },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        if (entry === 2) await sourceGate;
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  (
    Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
  ).set(provider.id, provider);
  f.engine.profiles.register(ownedDeliveryProfile);
  const sourceConfig: RunConfig = {
    ...f.config,
    agentProfileId: ownedDeliveryProfile.id,
    mode: "build",
    limits: {
      ...f.config.limits,
      maxTurns: 2,
      maxToolCalls: 1,
      toolTimeoutMs: 12_000,
    },
    budgets: { ...f.config.budgets!, turnAllowance: 2 },
  };
  const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
    sessionId: f.session.id,
    requestId: randomUUID(),
    prompt: "Execute the actual approved command source",
    config: JSON.parse(JSON.stringify(sourceConfig)),
  });
  await jobUntil(
    () =>
      f.engine.store
        .getSnapshot(f.session.id)
        .approvals.some(
          (a) => a.runId === receipt.runId && a.status === "pending",
        ),
    "Actual source did not request approval",
  );
  const approval = f.engine.store
    .getSnapshot(f.session.id)
    .approvals.find(
      (a) => a.runId === receipt.runId && a.status === "pending",
    )!;
  f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
  let pid = 0;
  await jobUntil(() => {
    if (!existsSync(marker)) return false;
    const text = readFileSync(marker, "utf8").trim();
    if (!/^\d+$/.test(text)) return false;
    const actual = Number(text);
    if (!Number.isSafeInteger(actual) || actual < 1) return false;
    pid = actual;
    return true;
  }, "Actual source command did not publish a complete positive PID");
  const inspect = () =>
    jobInvoke<OwnedCommandJobRecord[]>(
      f.engine,
      "inspectOwnedCommandJobs",
      f.workspace.id,
    );
  await jobUntil(
    () => inspect().some((j) => j.state === "running"),
    "Actual source job did not durably start",
  );
  const jobId = inspect()[0]!.jobId;
  function settled() {
    return jobInvoke<OwnedCommandJobRecord>(
      f.engine,
      "getOwnedCommandJob",
      f.workspace.id,
      jobId,
    );
  }
  function finishCommand() {
    writeFileSync(release, "Explicit fixture continuation\n");
  }
  async function complete() {
    finishCommand();
    finishSource();
    await f.engine.waitForRun(receipt.runId);
    await jobCommand(f.engine, "session.pause", { sessionId: f.session.id });
    const current = settled();
    assert.ok(["completed", "failed", "cancelled"].includes(current.state));
    assert.equal(current.completion?.outcome.cleanupConfirmed, true);
    return current;
  }
  const targetConfig = f.config;
  function capture(config = targetConfig) {
    return jobInvoke<object>(f.engine, "captureOwnedCommandJobDeliveryTarget", {
      workspaceId: f.workspace.id,
      jobId,
      config,
    });
  }
  function deliver(target: object, requestId = randomUUID()) {
    return jobInvoke<OwnedCommandDeliveryResult>(
      f.engine,
      "deliverOwnedCommandJobResult",
      {
        workspaceId: f.workspace.id,
        requestId,
        expectedRevision: 0,
        target,
        approved: true,
      },
    );
  }
  return {
    ...f,
    providerEntries: () => entries,
    receipt,
    pid,
    jobId,
    sourceConfig,
    targetConfig,
    complete,
    settled,
    finishCommand,
    finishSource,
    capture,
    deliver,
  };
}
