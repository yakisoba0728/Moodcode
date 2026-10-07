import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type {
  ApprovalRecord,
  JsonObject,
  Run,
  RunReceipt,
} from "@moodcode/contracts";
import { createEngine } from "../engine.js";
import type {
  LifecycleContinuationCapture,
  LifecycleContinuationRequest,
  ProviderAdapter,
} from "../ports.js";
import type { RunCoordinator } from "../runner/index.js";
import type { VerificationBoundary } from "../verification/completion.js";
import type { VerificationHostService } from "../verification/host.js";
import { verificationHash } from "../verification/types.js";
import { verificationDocumentKind } from "../verification/plans.js";
import { verificationControllerDocumentKind } from "../verification/controller.js";
import {
  createLifecycleContinuationPort,
  lifecycleContinuationDocumentKind,
  type LifecycleContinuationPorts,
} from "./continuation.js";
import { LifecycleHookRegistry } from "./registry.js";

const signal = () => new AbortController().signal;
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;
type Port = ReturnType<typeof createLifecycleContinuationPort>;
type Engine = ReturnType<typeof createEngine>;
interface BoundaryFixture {
  engine: Engine;
  run: Run;
  boundary: VerificationBoundary;
  port: Port;
  ports: LifecycleContinuationPorts;
  source: string;
  removeCheck(): void;
}

/** Every positive graph here comes from an approved actual verify_changes command and native provider iteration. */
async function actual(
  t: test.TestContext,
  atStop: (fixture: BoundaryFixture, signal: AbortSignal) => Promise<void>,
  options: {
    deny?: boolean;
    verification?: boolean;
    maxTurns?: number;
    maxToolCalls?: number;
  } = {},
) {
  const base = await realpath(
      await mkdtemp(join(tmpdir(), "moodcode-lifecycle-continuation-")),
    ),
    root = join(base, "repository"),
    source = join(root, "a.ts");
  await mkdir(root);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  await writeFile(source, "export const source = 1;\n");
  let engine!: Engine,
    observed = 0,
    caught: unknown,
    removeCheck = () => {};
  const hooks = new LifecycleHookRegistry({
    maxHookTimeoutMs: 5000,
    maxDispatchMs: 5000,
  });
  const provider: ProviderAdapter = {
    id: "continuation-fixture",
    async *streamTurn(request) {
      if (options.verification !== false && request.turnIndex === 0) {
        yield {
          type: "tool.call",
          call: {
            id: "actual-check",
            name: "verify_changes",
            input: { checkId: "check" },
          },
        };
        yield { type: "finish", reason: "tool_calls" };
      } else {
        yield {
          type: "text.delta",
          delta:
            "The model claims all checks passed. This string carries no verification authority.",
        };
        yield { type: "finish", reason: "stop" };
      }
    },
  };
  engine = createEngine({
    dbPath: join(base, "engine.sqlite"),
    artifactDir: join(base, "artifacts"),
    providers: [provider],
    verificationTools: true,
    defaults: {
      providerId: provider.id,
      modelId: "fixture",
      mode: "build",
      limits: {
        maxTurns: options.maxTurns ?? 5,
        maxDurationMs: 15000,
        ...(options.maxToolCalls !== undefined
          ? { maxToolCalls: options.maxToolCalls }
          : {}),
      },
    },
    agentProfiles: [
      {
        id: "verifier",
        description: "Actual host verification",
        instructions: "Use the host check.",
        tools: ["verify_changes", "run_command"],
      },
    ],
    lifecycleHookRegistry: hooks,
  });
  hooks.register({
    id: "service-observer",
    revision: 1,
    stages: ["before-stop"],
    timeoutMs: 5000,
    callback: async (event, callbackSignal) => {
      try {
        const run = engine.store.getRun(event.identity.runId),
          completion = engine.getVerificationCompletion(run.sessionId, run.id);
        const turn = engine.store.listTurns(run.id).at(-1)!;
        const boundary: VerificationBoundary = {
          id: turn.id,
          phase: "stop",
          turnId: turn.id,
          providerTerminal: true,
          nativeTurnCompleted: true,
        };
        if (completion?.result.taskVerified)
          assert.equal(completion.result.turnId, turn.id);
        const runtime = engine as unknown as {
          coordinator: RunCoordinator;
          verificationHost: VerificationHostService;
        };
        const ports: LifecycleContinuationPorts = {
          store: engine.store,
          controller: engine.verificationController,
          plans: engine.verificationPlans,
          observeSource: (current, supplied) =>
            runtime.verificationHost.observe(
              {
                sessionId: current.sessionId,
                runId: current.id,
                workspace: engine.store.getWorkspace(current.workspaceId),
              },
              supplied,
            ),
          readCurrentProfile: (current) => {
            const profile = engine.profiles.forRun(
              current.sessionId,
              current.config,
            );
            return profile
              ? { id: profile.id, revision: profile.revision }
              : null;
          },
          assertBoundaryCurrent: (current, bound) =>
            runtime.coordinator.assertVerificationBoundaryCurrent(
              current,
              bound,
            ),
          readRemainingBudget: (current) => {
            const budget =
              runtime.coordinator.verificationRemainingBudget(current);
            return {
              turns: budget.turns,
              toolCalls: budget.toolCalls,
              outputBytes: budget.outputBytes,
              durationMs: budget.durationMs,
            };
          },
        };
        await atStop(
          {
            engine,
            run,
            boundary,
            port: createLifecycleContinuationPort(ports),
            ports,
            source,
            removeCheck,
          },
          callbackSignal,
        );
        observed++;
      } catch (error) {
        caught = error;
        throw error;
      }
    },
  });
  t.after(async () => {
    await engine.close();
    await rm(base, { recursive: true, force: true });
  });
  engine.store.putWorkspace({
    id: "workspace",
    root,
    gitRoot: root,
    branch: null,
    createdAt: new Date().toISOString(),
  });
  engine.store.createSession({
    id: "session",
    workspaceId: "workspace",
    title: "Actual continuation service",
    createdAt: new Date().toISOString(),
  });
  const profile = engine.profiles.list()[0]!;
  removeCheck = engine.registerVerificationCheck({
    id: "check",
    revision: 1,
    workspaceId: "workspace",
    command: "printf observed > actual-check-effect.txt",
    cwd: root,
    profileId: profile.id,
    profileRevision: profile.revision,
    sourceRevision: "host-actual-v1",
    timeoutMs: 2000,
    maxOutputBytes: 8192,
    required: true,
  });
  await engine.configureVerificationSession("session", 0, {
    checkIds: ["check"],
    sourcePaths: ["a.ts"],
    maxRepairs: 0,
  });
  const accepted = await engine.dispatch({
    schemaVersion: 1,
    commandId: randomUUID(),
    type: "run.submit",
    payload: {
      sessionId: "session",
      requestId: randomUUID(),
      prompt: "Perform the actual host check.",
      config: { agentProfileId: "verifier" },
    },
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
  const receipt = accepted.result as unknown as RunReceipt;
  if (options.verification !== false) {
    let approval: ApprovalRecord | undefined;
    const deadline = Date.now() + 5000;
    while (
      !(approval = engine.store
        .getSnapshot("session")
        .approvals.find((item) => item.status === "pending"))
    ) {
      assert.ok(
        Date.now() < deadline,
        "Actual verification approval did not arrive",
      );
      await tick();
    }
    engine.approvals.decide(
      approval.id,
      options.deny ? "deny" : "allow",
      approval.fingerprint,
    );
  }
  const run = await engine.waitForRun(receipt.runId);
  if (caught) throw caught;
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(observed, 1);
  assert.equal(
    existsSync(join(root, "actual-check-effect.txt")),
    options.verification !== false && !options.deny,
  );
  if (options.verification !== false && !options.deny)
    assert.equal(
      await readFile(join(root, "actual-check-effect.txt"), "utf8"),
      "observed",
    );
  return {
    engine,
    run,
    dbPath: join(base, "engine.sqlite"),
    artifactDir: join(base, "artifacts"),
  };
}
function request(
  verificationSha256: string,
  data: JsonObject = { note: "quoted continuation data" },
): LifecycleContinuationRequest {
  return { verificationSha256, data, sha256: verificationHash(data) };
}

test(
  "actual native verified graph admits one detached USER control capture and original replay does not grant a second admission",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    let retained!: LifecycleContinuationCapture, retainedPort!: Port;
    const finished = await actual(t, async (f) => {
      const receipt = await f.port.capture(f.run, f.boundary, signal());
      assert.ok(receipt);
      const originalController = f.engine.verificationController.get(
        f.run.sessionId,
        f.run.id,
      )!;
      const data: JsonObject = {
        note: "original control",
        nested: { value: 1 },
      };
      retained = await f.port.admit(
        f.run,
        f.boundary,
        request(receipt.verificationSha256, data),
        signal(),
      );
      retainedPort = f.port;
      data.note = "changed caller data";
      await f.port.assertFresh(f.run, retained, signal());
      assert.equal(retained.message.role, "user");
      assert.ok(
        retained.message.content.startsWith(
          "[Moodcode lifecycle continuation v1]\n",
        ),
      );
      const body = JSON.parse(
        retained.message.content.split("\n").slice(1).join("\n"),
      );
      assert.equal(body.authority, "control-data");
      assert.equal(body.data.note, "original control");
      assert.equal(Object.isFrozen(retained.message), true);
      assert.deepEqual(
        f.engine.verificationController.get(f.run.sessionId, f.run.id),
        originalController,
        "Freshness never reevaluates or rewrites controller",
      );
      const durable = f.engine.store.getSessionDocument(
        f.run.sessionId,
        lifecycleContinuationDocumentKind(f.run.id),
      )!;
      assert.equal(durable.revision, 1);
      assert.equal(durable.data.continuationsUsed, 1);
      assert.equal(durable.data.executionAuthority, "none");
      assert.equal(
        JSON.stringify(durable.data).includes("original control"),
        false,
      );
      await assert.rejects(
        f.port.admit(
          f.run,
          f.boundary,
          request(receipt.verificationSha256),
          signal(),
        ),
        code("LIFECYCLE_CONTINUATION_LIMIT"),
      );
      const reopenedPort = createLifecycleContinuationPort(f.ports);
      await assert.rejects(
        reopenedPort.admit(
          f.run,
          f.boundary,
          request(receipt.verificationSha256),
          signal(),
        ),
        code("LIFECYCLE_CONTINUATION_LIMIT"),
      );
      assert.equal(
        f.engine.store.getSessionDocument(
          f.run.sessionId,
          lifecycleContinuationDocumentKind(f.run.id),
        )!.revision,
        1,
      );
    });
    await assert.rejects(
      retainedPort.assertFresh(finished.run, retained, signal()),
      code("LIFECYCLE_CONTINUATION_STALE"),
    );
  },
);

test(
  "model proof strings and native outer denial without a pass receipt capture no continuation authority",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    for (const options of [{ verification: false }, { deny: true }])
      await actual(
        t,
        async (f) => {
          assert.equal(await f.port.capture(f.run, f.boundary, signal()), null);
          await assert.rejects(
            f.port.admit(f.run, f.boundary, request("a".repeat(64)), signal()),
            code("LIFECYCLE_CONTINUATION_STALE"),
          );
          assert.equal(
            f.engine.store.getSessionDocument(
              f.run.sessionId,
              lifecycleContinuationDocumentKind(f.run.id),
            ),
            null,
          );
        },
        options,
      );
  },
);

test(
  "original continuation capture rejects copied, foreign, proxy and changed durable observations without getter effects",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    await actual(t, async (f) => {
      const receipt = await f.port.capture(f.run, f.boundary, signal());
      assert.ok(receipt);
      const capture = await f.port.admit(
        f.run,
        f.boundary,
        request(receipt.verificationSha256),
        signal(),
      );
      let traps = 0;
      for (const invalid of [
        structuredClone(capture),
        new Proxy(capture, {
          get() {
            traps++;
            throw new Error("trap");
          },
          ownKeys() {
            traps++;
            throw new Error("trap");
          },
        }),
      ])
        await assert.rejects(
          f.port.assertFresh(f.run, invalid, signal()),
          code("INVALID_LIFECYCLE_CONTINUATION_CAPTURE"),
        );
      await assert.rejects(
        createLifecycleContinuationPort(f.ports).assertFresh(
          f.run,
          capture,
          signal(),
        ),
        code("INVALID_LIFECYCLE_CONTINUATION_CAPTURE"),
      );
      assert.equal(traps, 0);
      const kind = lifecycleContinuationDocumentKind(f.run.id),
        document = f.engine.store.getSessionDocument(f.run.sessionId, kind)!;
      f.engine.store.putSessionDocument(
        f.run.sessionId,
        kind,
        document.revision,
        document.data,
      );
      await assert.rejects(
        f.port.assertFresh(f.run, capture, signal()),
        code("LIFECYCLE_CONTINUATION_STALE"),
      );
      await assert.rejects(
        f.port.admit(
          f.run,
          f.boundary,
          request(receipt.verificationSha256),
          signal(),
        ),
        code("LIFECYCLE_CONTINUATION_LIMIT"),
      );
    });
  },
);

test(
  "request hashes, hostile payloads and exhausted original turn budget cannot consume native admission",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    await actual(t, async (f) => {
      const receipt = await f.port.capture(f.run, f.boundary, signal());
      assert.ok(receipt);
      let traps = 0;
      const getter = Object.defineProperty({}, "note", {
        enumerable: true,
        get() {
          traps++;
          return "not read";
        },
      });
      const proxy = new Proxy(
        {},
        {
          ownKeys() {
            traps++;
            throw new Error("trap");
          },
        },
      );
      for (const value of [
        {
          verificationSha256: receipt.verificationSha256,
          data: getter,
          sha256: "a".repeat(64),
        },
        {
          verificationSha256: receipt.verificationSha256,
          data: { proxy },
          sha256: "a".repeat(64),
        },
        { ...request(receipt.verificationSha256), sha256: "a".repeat(64) },
        request(receipt.verificationSha256, { text: "x".repeat(8200) }),
      ])
        await assert.rejects(f.port.admit(f.run, f.boundary, value, signal()));
      assert.equal(traps, 0);
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        f.port.admit(
          f.run,
          f.boundary,
          request(receipt.verificationSha256),
          cancelled.signal,
        ),
        code("CANCELLED"),
      );
      assert.equal(
        f.engine.store.getSessionDocument(
          f.run.sessionId,
          lifecycleContinuationDocumentKind(f.run.id),
        ),
        null,
      );
    });
    await actual(
      t,
      async (f) => {
        const receipt = await f.port.capture(f.run, f.boundary, signal());
        assert.ok(receipt);
        await assert.rejects(
          f.port.admit(
            f.run,
            f.boundary,
            request(receipt.verificationSha256),
            signal(),
          ),
          code("LIFECYCLE_CONTINUATION_BUDGET"),
        );
        assert.equal(
          f.engine.store.getSessionDocument(
            f.run.sessionId,
            lifecycleContinuationDocumentKind(f.run.id),
          ),
          null,
        );
      },
      { maxTurns: 2 },
    );
  },
);

test(
  "source, profile, check registration and controller revision changes reject original verified continuation evidence",
  { timeout: 25000, skip: process.platform === "win32" },
  async (t) => {
    for (const mutation of [
      "source",
      "profile",
      "check",
      "controller",
    ] as const)
      await actual(t, async (f) => {
        const receipt = await f.port.capture(f.run, f.boundary, signal());
        assert.ok(receipt);
        const capture = await f.port.admit(
          f.run,
          f.boundary,
          request(receipt.verificationSha256),
          signal(),
        );
        if (mutation === "source")
          await writeFile(f.source, "export const source = 2;\n");
        else if (mutation === "profile")
          f.ports.readCurrentProfile = () => ({
            id: "verifier",
            revision: "changed",
          });
        else if (mutation === "check") f.removeCheck();
        else {
          const kind =
              "verification.controller." +
              verificationHash(f.run.id).slice(0, 40),
            doc = f.engine.store.getSessionDocument(f.run.sessionId, kind)!;
          f.engine.store.putSessionDocument(
            f.run.sessionId,
            kind,
            doc.revision,
            doc.data,
          );
        }
        await assert.rejects(f.port.assertFresh(f.run, capture, signal()));
        assert.equal(
          f.engine.store.getSessionDocument(
            f.run.sessionId,
            lifecycleContinuationDocumentKind(f.run.id),
          )!.revision,
          1,
        );
      });
  },
);

test(
  "freshness permits the last already-reserved turn at zero remaining while rejecting a budget increase",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    await actual(t, async (f) => {
      const receipt = await f.port.capture(f.run, f.boundary, signal());
      assert.ok(receipt);
      const nativeBudget = f.ports.readRemainingBudget.bind(f.ports);
      // This isolates the host budget-read seam; the native verified graph is real.
      f.ports.readRemainingBudget = (run) => ({
        ...nativeBudget(run),
        turns: 1,
      });
      const capture = await f.port.admit(
        f.run,
        f.boundary,
        request(receipt.verificationSha256),
        signal(),
      );
      f.ports.readRemainingBudget = (run) => ({
        ...nativeBudget(run),
        turns: 0,
      });
      await f.port.assertFresh(f.run, capture, signal());
      f.ports.readRemainingBudget = (run) => ({
        ...nativeBudget(run),
        turns: 2,
      });
      await assert.rejects(
        f.port.assertFresh(f.run, capture, signal()),
        code("LIFECYCLE_CONTINUATION_BUDGET"),
      );
      f.ports.readRemainingBudget = (run) => ({
        ...nativeBudget(run),
        turns: 0,
        durationMs: 0,
      });
      await assert.rejects(
        f.port.assertFresh(f.run, capture, signal()),
        code("LIFECYCLE_CONTINUATION_BUDGET"),
      );
    });
  },
);

test(
  "native admission CAS rejects actual controller or verification revision changes at the write boundary",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    for (const changed of ["controller", "verification"] as const)
      await actual(t, async (f) => {
        const receipt = await f.port.capture(f.run, f.boundary, signal());
        assert.ok(receipt);
        const original = f.engine.store.putActiveLifecycleContinuationDocument;
        f.engine.store.putActiveLifecycleContinuationDocument = function (
          ...args
        ) {
          const actualKind =
            changed === "controller"
              ? verificationControllerDocumentKind(f.run.id)
              : verificationDocumentKind(f.run.id);
          const saved = this.getSessionDocument(f.run.sessionId, actualKind);
          assert.ok(saved, actualKind);
          this.putSessionDocument(
            f.run.sessionId,
            actualKind,
            saved.revision,
            saved.data,
          );
          return original.apply(this, args);
        };
        try {
          await assert.rejects(
            f.port.admit(
              f.run,
              f.boundary,
              request(receipt.verificationSha256),
              signal(),
            ),
            code("LIFECYCLE_CONTINUATION_STALE"),
          );
          assert.equal(
            f.engine.store.getSessionDocument(
              f.run.sessionId,
              lifecycleContinuationDocumentKind(f.run.id),
            ),
            null,
          );
        } finally {
          f.engine.store.putActiveLifecycleContinuationDocument = original;
        }
      });
  },
);

test(
  "concurrent services consume exactly one native original-Run continuation document",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    await actual(t, async (f) => {
      const receipt = await f.port.capture(f.run, f.boundary, signal());
      assert.ok(receipt);
      const other = createLifecycleContinuationPort(f.ports),
        value = request(receipt.verificationSha256);
      const results = await Promise.allSettled([
        f.port.admit(f.run, f.boundary, value, signal()),
        other.admit(f.run, f.boundary, value, signal()),
      ]);
      assert.equal(
        results.filter((item) => item.status === "fulfilled").length,
        1,
      );
      const rejected = results.find((item) => item.status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.ok(
        ["LIFECYCLE_CONTINUATION_LIMIT", "REVISION_CONFLICT"].includes(
          (rejected.reason as { code: string }).code,
        ),
      );
      assert.equal(
        f.engine.store.getSessionDocument(
          f.run.sessionId,
          lifecycleContinuationDocumentKind(f.run.id),
        )!.revision,
        1,
      );
    });
  },
);

test(
  "cancellation immediately after the actual admission commit preserves the consumed document and returned observation",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    await actual(t, async (f) => {
      const receipt = await f.port.capture(f.run, f.boundary, signal());
      assert.ok(receipt);
      const original = f.engine.store.putActiveLifecycleContinuationDocument,
        abort = new AbortController();
      f.engine.store.putActiveLifecycleContinuationDocument = function (
        ...args
      ) {
        const observed = original.apply(this, args);
        abort.abort();
        return observed;
      };
      try {
        const captured = await f.port.admit(
          f.run,
          f.boundary,
          request(receipt.verificationSha256),
          abort.signal,
        );
        assert.ok(captured.id);
        assert.equal(abort.signal.aborted, true);
        assert.equal(
          f.engine.store.getSessionDocument(
            f.run.sessionId,
            lifecycleContinuationDocumentKind(f.run.id),
          )!.revision,
          1,
        );
        await assert.rejects(
          f.port.assertFresh(f.run, captured, abort.signal),
          code("CANCELLED"),
        );
        await assert.rejects(
          createLifecycleContinuationPort(f.ports).admit(
            f.run,
            f.boundary,
            request(receipt.verificationSha256),
            signal(),
          ),
          code("LIFECYCLE_CONTINUATION_LIMIT"),
        );
      } finally {
        f.engine.store.putActiveLifecycleContinuationDocument = original;
      }
    });
  },
);

test(
  "actual last permitted verification tool leaves provider-only continuation legal without renewing tool allowance",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    await actual(
      t,
      async (f) => {
        const receipt = await f.port.capture(f.run, f.boundary, signal());
        assert.ok(receipt);
        assert.equal(f.ports.readRemainingBudget(f.run).toolCalls, 0);
        const capture = await f.port.admit(
          f.run,
          f.boundary,
          request(receipt.verificationSha256),
          signal(),
        );
        await f.port.assertFresh(f.run, capture, signal());
        assert.equal(f.ports.readRemainingBudget(f.run).toolCalls, 0);
        const saved = f.engine.store.getSessionDocument(
          f.run.sessionId,
          lifecycleContinuationDocumentKind(f.run.id),
        )!;
        assert.equal((saved.data.originalBudget as JsonObject).toolCalls, 0);
        assert.equal(
          f.engine.store.getSnapshot(f.run.sessionId).tools.length,
          1,
        );
      },
      { maxToolCalls: 1 },
    );
  },
);

test(
  "normal Engine close and same-DB reopen retain consumed continuation observation without restoring handles or provider execution",
  { timeout: 20000, skip: process.platform === "win32" },
  async (t) => {
    let retained!: LifecycleContinuationCapture,
      boundary!: VerificationBoundary;
    const finished = await actual(t, async (f) => {
      const receipt = await f.port.capture(f.run, f.boundary, signal());
      assert.ok(receipt);
      retained = await f.port.admit(
        f.run,
        f.boundary,
        request(receipt.verificationSha256, {
          note: "ephemeral callback data must not be restored",
        }),
        signal(),
      );
      boundary = f.boundary;
      await f.port.assertFresh(f.run, retained, signal());
    });
    const kind = lifecycleContinuationDocumentKind(finished.run.id),
      original = finished.engine.store.getSessionDocument(
        finished.run.sessionId,
        kind,
      )!;
    assert.equal(original.data.continuationsUsed, 1);
    assert.equal(original.data.executionAuthority, "none");
    assert.equal(
      JSON.stringify(original.data).includes("ephemeral callback data"),
      false,
    );
    const ledgerSha256 = verificationHash(original);
    await finished.engine.close();
    let providerCalls = 0,
      sourceCalls = 0,
      boundaryCalls = 0,
      budgetCalls = 0;
    const provider: ProviderAdapter = {
      id: "continuation-fixture",
      async *streamTurn() {
        providerCalls++;
        yield { type: "finish", reason: "stop" };
      },
    };
    const reopened = createEngine({
      dbPath: finished.dbPath,
      artifactDir: finished.artifactDir,
      providers: [provider],
    });
    try {
      const restored = reopened.store.getSessionDocument(
        finished.run.sessionId,
        kind,
      )!;
      assert.deepEqual(restored, original);
      assert.equal(verificationHash(restored), ledgerSha256);
      assert.equal(restored.data.runId, finished.run.id);
      assert.equal(restored.data.sessionId, finished.run.sessionId);
      assert.equal(restored.data.workspaceId, finished.run.workspaceId);
      assert.equal(
        restored.data.verificationSha256,
        retained.verificationSha256,
      );
      assert.equal(Object.hasOwn(restored.data, "callback"), false);
      assert.equal(Object.hasOwn(restored.data, "data"), false);
      assert.equal(reopened.store.getRun(finished.run.id).state, "completed");
      assert.equal(
        reopened.lifecycleHooks.list().length,
        0,
        "Old in-memory host callbacks are not restored from the ledger",
      );
      const port = createLifecycleContinuationPort({
        store: reopened.store,
        controller: reopened.verificationController,
        plans: reopened.verificationPlans,
        observeSource: async () => {
          sourceCalls++;
          throw new Error("Historical state must not observe live source");
        },
        readCurrentProfile: () => null,
        assertBoundaryCurrent: () => {
          boundaryCalls++;
          throw new Error("Historical state must not claim a live boundary");
        },
        readRemainingBudget: () => {
          budgetCalls++;
          throw new Error("Historical state must not allocate a budget");
        },
      });
      await assert.rejects(
        port.assertFresh(finished.run, retained, signal()),
        code("INVALID_LIFECYCLE_CONTINUATION_CAPTURE"),
      );
      await assert.rejects(
        port.assertFresh(finished.run, structuredClone(retained), signal()),
        code("INVALID_LIFECYCLE_CONTINUATION_CAPTURE"),
      );
      await assert.rejects(
        port.capture(finished.run, boundary, signal()),
        code("LIFECYCLE_CONTINUATION_STALE"),
      );
      await assert.rejects(
        port.admit(
          finished.run,
          boundary,
          request(retained.verificationSha256),
          signal(),
        ),
        code("LIFECYCLE_CONTINUATION_STALE"),
      );
      await tick();
      await tick();
      assert.equal(providerCalls, 0);
      assert.equal(sourceCalls, 0);
      assert.equal(boundaryCalls, 0);
      assert.equal(budgetCalls, 0);
      assert.equal(
        reopened.store.getSessionDocument(finished.run.sessionId, kind)!
          .revision,
        1,
      );
      assert.equal(
        reopened.store.getSnapshot(finished.run.sessionId).tools.length,
        1,
        "No command effect is replayed",
      );
    } finally {
      await reopened.close();
    }
  },
);
