import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { ProviderAdapter, ProviderEvent, TurnRequest } from "../ports.js";
import type { JsonObject, RunConfig, RunReceipt } from "@moodcode/contracts";
import { normalizeEngineBudgets } from "@moodcode/contracts/validation";
import { jobFixture, jobCommand } from "./fixtures/job.js";
import { ownedDeliveryFixture } from "./fixtures/owned-command-delivery.js";
const options = {
  timeout: 25000,
  skip: !["darwin", "linux", "freebsd"].includes(process.platform),
};
const profile = {
  id: "command-model-reader",
  instructions: "Read only the host-selected command DATA.",
  description: "Selected command reader",
  tools: ["read_command_job", "read_command_job_output"],
};
async function readModel(
  f: Awaited<ReturnType<typeof jobFixture>>,
  selection: Parameters<
    typeof f.engine.bindCommandJobModelTools
  >[0]["jobs"][number],
  badInput?: Record<string, unknown>,
  maxOutputBytes = 32768,
) {
  f.engine.profiles.register(profile);
  const p = f.engine.profiles.list().find((x) => x.id === profile.id)!;
  const original = f.engine.bindCommandJobModelTools({
    workspaceId: f.workspace.id,
    sessionId: f.session.id,
    profile: { id: p.id, revision: p.revision },
    jobs: [selection],
  });
  const calls: TurnRequest[] = [];
  const provider: ProviderAdapter = {
    id: f.config.providerId,
    async *streamTurn(request): AsyncIterable<ProviderEvent> {
      calls.push(request);
      const i = calls.length;
      if (i === 1) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-status",
            name: "read_command_job",
            input: { alias: "chosen", ...badInput },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else if (i === 2) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-output",
            name: "read_command_job_output",
            input: { alias: "chosen" },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else yield { type: "finish", reason: "stop" };
    },
  };
  (
    Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
  ).set(provider.id, provider);
  const config: RunConfig = {
    ...f.config,
    agentProfileId: p.id,
    limits: {
      ...f.config.limits,
      maxTurns: 3,
      maxToolCalls: 3,
      maxOutputBytes,
    },
    budgets: normalizeEngineBudgets({
      turnAllowance: 3,
      maxProviderAttempts: 3,
      retryBaseDelayMs: 0,
    }),
  };
  const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
    sessionId: f.session.id,
    requestId: randomUUID(),
    prompt: "Read chosen command data",
    config: JSON.parse(JSON.stringify(config)),
  });
  await f.engine.waitForRun(receipt.runId);
  const tools = f.engine.store
    .getSnapshot(f.session.id)
    .tools.filter((x) => x.runId === receipt.runId);
  const parts = f.engine.store
    .listTurns(receipt.runId)
    .flatMap((turn) => f.engine.store.listParts(turn.id));
  for (const tool of tools.filter((x) => x.state === "completed")) {
    const part = parts.find(
      (p) => p.type === "tool" && p.toolCallId === tool.id,
    );
    assert.ok(part && part.type === "tool");
    assert.equal(part.state, "completed");
    const partResult = part.result;
    assert.ok(
      partResult &&
        typeof partResult === "object" &&
        !Array.isArray(partResult),
    );
    assert.equal(partResult.output, tool.output);
    assert.equal(typeof partResult.output, "string");
    assert.ok(Buffer.byteLength(partResult.output as string) <= maxOutputBytes);
  }
  f.engine.releaseCommandJobModelTools(original);
  return { receipt, tools, calls };
}
test(
  "actual readonly provider consumes PTY pages into native Tool/Part using only approved alias",
  options,
  async (t) => {
    const f = await jobFixture(t, { engine: { commandJobModelTools: true } });
    const s = f.attach();
    await f.write("unicode");
    await new Promise((r) => setTimeout(r, 80));
    const before = f
      .rows("session_events")
      .filter((x) => String(x.type).startsWith("terminal."));
    const result = await readModel(f, {
      alias: "chosen",
      kind: "user-terminal",
      jobId: s.result.record.jobId,
      source: s.original,
    });
    assert.equal(result.tools.length, 2);
    assert.equal(
      result.tools.every((x) => x.state === "completed"),
      true,
      JSON.stringify(result.tools),
    );
    const page = JSON.parse(result.tools[1]!.output!);
    assert.ok(JSON.stringify(page).includes("한글"));
    assert.ok(Buffer.byteLength(result.tools[1]!.output!) <= 32768);
    assert.deepEqual(
      f
        .rows("session_events")
        .filter((x) => String(x.type).startsWith("terminal.")),
      before,
    );
    assert.equal(
      result.calls[0]!.tools.some((x) => x.name === "run_command"),
      false,
    );
    await f.finish();
  },
);
test(
  "actual readonly provider consumes independent completed host without source Run/Tool identities",
  options,
  async (t) => {
    const f = await jobFixture(t, {
      createTerminal: false,
      engine: { hostCommands: true, commandJobModelTools: true },
    });
    const original = await f.engine.previewHostCommand({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      limits: { maxDurationMs: 10000, maxOutputBytes: 1048576 },
      command: `'${process.execPath}' -e 'process.stdout.write("HOST_MODEL 한글🙂")'`,
    });
    const started = await f.engine.startHostCommand({
      workspaceId: f.workspace.id,
      requestId: randomUUID(),
      preview: original,
      fingerprint: f.engine.readHostCommandPreview(original).fingerprint,
      approved: true,
    });
    const job = await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    const result = await readModel(f, {
      alias: "chosen",
      kind: "host-command",
      jobId: job.jobId,
    });
    assert.equal(
      result.tools.every((x) => x.state === "completed"),
      true,
      JSON.stringify(result.tools),
    );
    assert.ok(result.tools[1]!.output!.includes("HOST_MODEL"));
    assert.equal(f.engine.inspectHostCommands(f.workspace.id).length, 1);
  },
);
test(
  "default off, model-supplied job identity and cross-session host selections have zero read authority",
  options,
  async (t) => {
    const f = await jobFixture(t, { createTerminal: false });
    f.engine.profiles.register(profile);
    const p = f.engine.profiles.list().find((x) => x.id === profile.id)!;
    assert.throws(() =>
      f.engine.bindCommandJobModelTools({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        profile: p,
        jobs: [{ alias: "chosen", kind: "host-command", jobId: "missing" }],
      }),
    );
    const enabled = await jobFixture(t, {
      engine: { commandJobModelTools: true },
    });
    const s = enabled.attach();
    const result = await readModel(
      enabled,
      {
        alias: "chosen",
        kind: "user-terminal",
        jobId: s.result.record.jobId,
        source: s.original,
      },
      { jobId: s.result.record.jobId },
    );
    assert.equal(result.tools[0]!.state, "failed");
    assert.match(
      result.tools[0]!.output!,
      /invalid|unsupported|property|fields|schema/i,
    );
    await enabled.finish();
  },
);
test(
  "Run-owned completed physical source is read by a separate genuine model Run without rewriting source events",
  options,
  async (t) => {
    const f = await jobFixture(t, {
      createTerminal: false,
      engine: { commandJobModelTools: true },
    });
    const sourceProfile = {
      id: "command-source-profile",
      description: "Actual physical source",
      instructions: "Use the approved command",
      tools: ["run_command"],
    };
    f.engine.profiles.register(sourceProfile);
    let entries = 0;
    const sourceProvider: ProviderAdapter = {
      id: f.config.providerId,
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        if (++entries === 1) {
          yield {
            type: "tool.call" as const,
            call: {
              id: "actual-source",
              name: "run_command",
              input: {
                command: `'${process.execPath}' -e 'process.stdout.write("RUN_COMMAND_MODEL 한글🙂")'`,
              },
            },
          };
          yield { type: "finish" as const, reason: "tool_calls" as const };
        } else yield { type: "finish" as const, reason: "stop" as const };
      },
    };
    (
      Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
    ).set(sourceProvider.id, sourceProvider);
    const config = {
      ...f.config,
      agentProfileId: sourceProfile.id,
      mode: "build" as const,
      limits: { ...f.config.limits, maxTurns: 2 },
      budgets: normalizeEngineBudgets({
        turnAllowance: 2,
        maxProviderAttempts: 2,
        retryBaseDelayMs: 0,
      }),
    };
    const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
      sessionId: f.session.id,
      requestId: randomUUID(),
      prompt: "Execute physical source",
      config: JSON.parse(JSON.stringify(config)),
    });
    await import("./fixtures/job.js").then(({ jobUntil }) =>
      jobUntil(
        () =>
          f.engine.store
            .getSnapshot(f.session.id)
            .approvals.some((x) => x.status === "pending"),
        "Actual source approval missing",
      ),
    );
    const approval = f.engine.store
      .getSnapshot(f.session.id)
      .approvals.find((x) => x.status === "pending")!;
    f.engine.approvals.decide(approval.id, "allow", approval.fingerprint);
    await f.engine.waitForRun(receipt.runId);
    const job = f.engine.inspectOwnedCommandJobs(f.workspace.id)[0]!;
    assert.equal(job.state, "completed");
    const sourceEvents = f
      .rows("session_events")
      .filter((x) => x.run_id === receipt.runId);
    const result = await readModel(f, {
      alias: "chosen",
      kind: "run-command",
      jobId: job.jobId,
    });
    assert.equal(
      result.tools.every((x) => x.state === "completed"),
      true,
      JSON.stringify(result.tools),
    );
    assert.ok(result.tools[1]!.output!.includes("RUN_COMMAND_MODEL"));
    assert.deepEqual(
      f.rows("session_events").filter((x) => x.run_id === receipt.runId),
      sourceEvents,
    );
  },
);
test(
  "genuine PTY output cursor survives newer bytes, stays alias-bound, reports loss and stores bounded native pages",
  options,
  async (t) => {
    const f = await jobFixture(t, { engine: { commandJobModelTools: true } }),
      s = f.attach();
    await f.write("overflow");
    await import("./fixtures/job.js").then(({ jobUntil }) =>
      jobUntil(
        () =>
          f.engine.terminals.get(f.terminal!.id, f.owner).observedBytes >
            300000 &&
          f.engine.terminals.get(f.terminal!.id, f.owner).oldestSeq > 1,
        "Actual overflow not observed",
      ),
    );
    f.engine.profiles.register(profile);
    const p = f.engine.profiles.list().find((x) => x.id === profile.id)!;
    const binding = f.engine.bindCommandJobModelTools({
      workspaceId: f.workspace.id,
      sessionId: f.session.id,
      profile: { id: p.id, revision: p.revision },
      jobs: [
        {
          alias: "chosen",
          kind: "user-terminal",
          jobId: s.result.record.jobId,
          source: s.original,
        },
      ],
    });
    const pages: Record<string, unknown>[] = [];
    let entries = 0;
    const provider: ProviderAdapter = {
      id: f.config.providerId,
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        const i = ++entries;
        if (i > 1) {
          const tool = f.engine.store
            .getSnapshot(f.session.id)
            .tools.filter((x) => x.name === "read_command_job_output")
            .at(-1)!;
          pages.push(JSON.parse(tool.output!));
        }
        if (i <= 2) {
          if (i === 2) {
            await f.write("new snapshot bytes");
          }
          yield {
            type: "tool.call",
            call: {
              id: `page${i}`,
              name: "read_command_job_output",
              input: {
                alias: "chosen",
                ...(i === 2 ? { cursor: pages[0]!.nextCursor as never } : {}),
              } as unknown as JsonObject,
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield { type: "finish", reason: "stop" };
      },
    };
    (
      Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
    ).set(provider.id, provider);
    const config = {
      ...f.config,
      agentProfileId: p.id,
      limits: { ...f.config.limits, maxTurns: 3, maxOutputBytes: 32768 },
      budgets: normalizeEngineBudgets({
        turnAllowance: 3,
        maxProviderAttempts: 3,
        retryBaseDelayMs: 0,
      }),
    };
    const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
      sessionId: f.session.id,
      requestId: randomUUID(),
      prompt: "Read fixed snapshot pages",
      config: JSON.parse(JSON.stringify(config)),
    });
    await f.engine.waitForRun(receipt.runId);
    assert.equal(pages.length, 2);
    assert.ok(pages[0]!.gap);
    assert.equal(pages[0]!.snapshotSha256, pages[1]!.snapshotSha256);
    assert.equal(pages[0]!.throughSeq, pages[1]!.throughSeq);
    for (const page of pages) {
      assert.ok(Number(page.rawBytes) <= 8192);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32768);
      assert.ok(!JSON.stringify(page).includes("new snapshot bytes"));
    }
    f.engine.releaseCommandJobModelTools(binding);
    await f.finish();
  },
);
test(
  "failed first actual source read releases original witness; host alias audience and accessor/proxy envelope traps stay bounded",
  options,
  async (t) => {
    const f = await jobFixture(t, {
      createTerminal: false,
      engine: { hostCommands: true, commandJobModelTools: true },
    });
    const preview = await f.engine.previewHostCommand({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        command: `'${process.execPath}' -e 'process.stdout.write("WITNESS")'`,
        limits: { maxDurationMs: 10000, maxOutputBytes: 1048576 },
      }),
      started = await f.engine.startHostCommand({
        workspaceId: f.workspace.id,
        preview,
        fingerprint: f.engine.readHostCommandPreview(preview).fingerprint,
        approved: true,
        requestId: randomUUID(),
      });
    await f.engine.waitForHostCommand({
      workspaceId: f.workspace.id,
      jobId: started.jobId,
    });
    f.engine.profiles.register(profile);
    const p = f.engine.profiles.list().find((x) => x.id === profile.id)!,
      input = {
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        profile: { id: p.id, revision: p.revision },
        jobs: [
          {
            alias: "chosen",
            kind: "host-command" as const,
            jobId: started.jobId,
          },
        ],
      };
    const handles = Reflect.get(
        Reflect.get(f.engine, "hostCommands"),
        "handles",
      ) as Set<object>,
      before = handles.size,
      original = f.engine.readHostCommandOutput;
    f.engine.readHostCommandOutput = () => {
      throw new Error("Actual first native reader fault after genuine capture");
    };
    for (let i = 0; i < 5; i++) {
      assert.throws(() => f.engine.bindCommandJobModelTools(input));
      assert.equal(handles.size, before);
    }
    f.engine.readHostCommandOutput = original;
    let traps = 0;
    const array = Object.defineProperty([], "0", {
      enumerable: true,
      get() {
        traps++;
        return input.jobs[0];
      },
    });
    assert.throws(() =>
      f.engine.bindCommandJobModelTools({ ...input, jobs: array }),
    );
    assert.throws(() =>
      f.engine.bindCommandJobModelTools(
        new Proxy(input, {
          ownKeys() {
            traps++;
            return [];
          },
        }),
      ),
    );
    assert.equal(traps, 0);
    const foreign = await jobCommand<{ id: string }>(
      f.engine,
      "session.create",
      { workspaceId: f.workspace.id },
    );
    assert.throws(() =>
      f.engine.bindCommandJobModelTools({ ...input, sessionId: foreign.id }),
    );
    assert.equal(handles.size, before);
  },
);
test(
  "readonly tools consume original native owner only; copied/current-accessor contexts are denied before source read",
  options,
  async (t) => {
    const f = await jobFixture(t, { engine: { commandJobModelTools: true } }),
      s = f.attach();
    const host = Reflect.get(f.engine, "commandJobModelHost") as {
        prepare: (...args: unknown[]) => unknown;
      },
      original = host.prepare;
    let checks = 0,
      traps = 0;
    host.prepare = function (operation, input, context) {
      const ctx = context as import("../ports.js").ToolContext;
      assert.throws(() =>
        f.engine.coordinator.readCommandJobToolContext({ ...ctx }, "prepare"),
      );
      assert.throws(() =>
        f.engine.coordinator.readCommandJobToolContext(
          new Proxy(ctx, {
            get() {
              traps++;
              return undefined;
            },
          }),
          "prepare",
        ),
      );
      const descriptor = Object.getOwnPropertyDescriptor(ctx, "limits")!;
      Object.defineProperty(ctx, "limits", {
        enumerable: true,
        configurable: true,
        get() {
          traps++;
          return descriptor.value;
        },
      });
      assert.throws(() =>
        f.engine.coordinator.readCommandJobToolContext(ctx, "prepare"),
      );
      Object.defineProperty(ctx, "limits", descriptor);
      checks++;
      return Reflect.apply(original, host, [operation, input, context]);
    };
    const result = await readModel(f, {
      alias: "chosen",
      kind: "user-terminal",
      jobId: s.result.record.jobId,
      source: s.original,
    });
    assert.equal(
      result.tools.every((x) => x.state === "completed"),
      true,
    );
    assert.equal(checks, 2);
    assert.equal(traps, 0);
    await f.finish();
  },
);
test(
  "actual readonly model output respects remaining output allocation and never captures an oversized page",
  options,
  async (t) => {
    const f = await jobFixture(t, { engine: { commandJobModelTools: true } }),
      s = f.attach();
    const host = Reflect.get(f.engine, "commandJobModelHost");
    assert.equal(Reflect.get(host, "snapshotCount"), 0);
    const result = await readModel(
      f,
      {
        alias: "chosen",
        kind: "user-terminal",
        jobId: s.result.record.jobId,
        source: s.original,
      },
      undefined,
      1024,
    );
    assert.equal(result.tools[1]!.state, "failed");
    assert.ok(
      result.tools[1]!.output!.includes("COMMAND_JOB_MODEL_OUTPUT_LIMIT"),
    );
    assert.equal(Reflect.get(host, "snapshotCount"), 0);
    await f.finish();
  },
);
test(
  "actual registered role policy denies readonly model data even when the host bound its source alias",
  options,
  async (t) => {
    const { RoleResourcePolicy } =
      await import("../permission/role-resources.js");
    const f = await jobFixture(t, {
        engine: {
          commandJobModelTools: true,
          roleResourcePolicy: new RoleResourcePolicy({
            revision: 1,
            rules: [
              {
                id: "deny-command-observation",
                roleId: profile.id,
                effect: "read",
                resource: { kind: "all" },
                decision: "deny",
              },
            ],
          }),
        },
      }),
      s = f.attach();
    const result = await readModel(f, {
      alias: "chosen",
      kind: "user-terminal",
      jobId: s.result.record.jobId,
      source: s.original,
    });
    assert.equal(
      result.tools.every((x) => x.state === "denied"),
      true,
      JSON.stringify(result.tools),
    );
    assert.equal(
      result.tools.some((x) => x.output?.includes("JOB_READY")),
      false,
    );
    await f.finish();
  },
);
test(
  "35 actual model polls reuse one unchanged frozen Original without exhausting byte or source handle capacity",
  options,
  async (t) => {
    const f = await jobFixture(t, { engine: { commandJobModelTools: true } }),
      s = f.attach();
    f.engine.profiles.register(profile);
    const p = f.engine.profiles.list().find((x) => x.id === profile.id)!,
      binding = f.engine.bindCommandJobModelTools({
        workspaceId: f.workspace.id,
        sessionId: f.session.id,
        profile: { id: p.id, revision: p.revision },
        jobs: [
          {
            alias: "chosen",
            kind: "user-terminal",
            jobId: s.result.record.jobId,
            source: s.original,
          },
        ],
      });
    let entries = 0;
    const provider: ProviderAdapter = {
      id: f.config.providerId,
      async *streamTurn(): AsyncIterable<ProviderEvent> {
        if (++entries <= 35) {
          yield {
            type: "tool.call",
            call: {
              id: `poll-${entries}`,
              name: "read_command_job_output",
              input: { alias: "chosen" },
            },
          };
          yield { type: "finish", reason: "tool_calls" };
        } else yield { type: "finish", reason: "stop" };
      },
    };
    (
      Reflect.get(f.engine, "runtimeProviders") as Map<string, ProviderAdapter>
    ).set(provider.id, provider);
    const config = {
      ...f.config,
      agentProfileId: p.id,
      limits: {
        ...f.config.limits,
        maxTurns: 36,
        maxToolCalls: 35,
        maxOutputBytes: 131072,
      },
      budgets: normalizeEngineBudgets({
        turnAllowance: 36,
        maxProviderAttempts: 1,
        retryBaseDelayMs: 0,
      }),
    };
    const receipt = await jobCommand<RunReceipt>(f.engine, "run.submit", {
      sessionId: f.session.id,
      requestId: randomUUID(),
      prompt:
        "Repeatedly observe the explicitly selected current frozen source",
      config: JSON.parse(JSON.stringify(config)),
    });
    await f.engine.waitForRun(receipt.runId);
    const tools = f.engine.store
      .getSnapshot(f.session.id)
      .tools.filter((x) => x.runId === receipt.runId);
    assert.equal(tools.length, 35);
    assert.equal(
      tools.every((x) => x.state === "completed"),
      true,
      JSON.stringify(tools.filter((x) => x.state !== "completed")),
    );
    const host = Reflect.get(f.engine, "commandJobModelHost");
    assert.equal(Reflect.get(host, "snapshotCount"), 1);
    assert.ok(Number(Reflect.get(host, "snapshotBytes")) < 16384);
    const freezeIds = new Set(
      tools.map((x) => JSON.parse(x.output!).nextCursor.freezeId),
    );
    assert.equal(freezeIds.size, 1);
    const physicalSnapshots = Reflect.get(
      f.engine.terminals,
      "retainedReadSnapshots",
    ) as Set<object>;
    assert.equal(physicalSnapshots.size, 1);
    f.engine.releaseCommandJobModelTools(binding);
    assert.equal(Reflect.get(host, "snapshotCount"), 0);
    assert.equal(Reflect.get(host, "snapshotBytes"), 0);
    assert.equal(physicalSnapshots.size, 0);
    await f.finish();
  },
);
