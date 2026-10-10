import { randomUUID, createHash } from "node:crypto";
import { types } from "node:util";
import type {
  JsonObject,
  JsonValue,
  ToolCallRecord,
} from "@moodcode/contracts";
import { normalizeAcceptInput } from "@moodcode/contracts/validation";
import type { MoodcodeEngine } from "../engine.js";
import type { ToolContext, PreparedTool, ToolResult } from "../ports.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { describeEngineQueueTarget } from "../jobs/queue-target.js";
import type { ScheduleTargetPin } from "../schedules/types.js";
import {
  probeCodeModeRuntime,
  assertCodeModeRuntime,
  type CodeModeRuntimeSource,
} from "./runtime.js";
import { OwnedCodeModeProcess } from "./process.js";
import {
  CodeModeStorage,
  type CodeModeSource,
  type CodeModeRecord,
} from "./records.js";
import {
  codeJson,
  codeSign,
  codeModeError,
  parseCodeProgram,
  validateCodeAllocation,
  CODE_MODE_TOOLS,
  type CodeModeAllocation,
  type CodeModeRuntimeCapability,
} from "./types.js";
export interface CodeModeGrant {
  version: 1;
  id: string;
  ownerEpoch: string;
  target: ScheduleTargetPin;
  runtime: CodeModeRuntimeCapability;
  sha256: string;
}
interface Prepared {
  source: string;
  allocation: CodeModeAllocation;
  grant: CodeModeGrant;
  binding: KnowledgeHostBinding;
  fingerprint: string;
  used: boolean;
}
interface Flight {
  context: ToolContext;
  record: CodeModeRecord;
  process?: OwnedCodeModeProcess;
  settlingTool?: ToolCallRecord;
}
export class CodeModeHost {
  private readonly epoch = knowledgeHash({ nonce: randomUUID() });
  private runtime?: CodeModeRuntimeSource;
  private readonly previews = new WeakMap<object, CodeModeGrant>();
  private readonly retained = new Set<object>();
  private readonly grants = new Map<string, CodeModeGrant>();
  private readonly prepared = new WeakMap<PreparedTool, Prepared>();
  private readonly flights = new Map<string, Flight>();
  private closed = false;
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly native: CodeModeStorage,
    private readonly binding: (ws: string) => KnowledgeHostBinding,
    private readonly enabled: boolean,
  ) {
    native.recover();
  }
  private active() {
    if (!this.enabled) codeModeError("CODE_MODE_DISABLED");
    if (this.closed) codeModeError("CODE_MODE_CLOSED");
  }
  getCapability() {
    return this.runtime ? codeJson(this.runtime.capability) : undefined;
  }
  getSupport() {
    return {
      enabled: this.enabled,
      language: "moodcode-json-v1",
      backend:
        process.platform === "darwin" ? "darwin-seatbelt-v1" : "unsupported",
      available: this.runtime?.capability.available ?? false,
      registered: this.runtime !== undefined,
    };
  }
  async registerCodeModeHost() {
    this.active();
    if (this.flights.size) codeModeError("CODE_MODE_BUSY");
    const runtime = await probeCodeModeRuntime();
    this.active();
    this.runtime = runtime;
    this.grants.clear();
    return codeJson(this.runtime.capability);
  }
  private runtimeCurrent() {
    this.active();
    if (!this.runtime) codeModeError("CODE_MODE_RUNTIME_REQUIRED");
    assertCodeModeRuntime(this.runtime);
    return this.runtime;
  }
  previewCodeModeGrant(input: unknown): object {
    this.runtimeCurrent();
    const x = codeJson(input) as any;
    if (
      !x ||
      typeof x.workspaceId !== "string" ||
      typeof x.sessionId !== "string" ||
      Object.keys(x).some(
        (k) => !["workspaceId", "sessionId", "config"].includes(k),
      )
    )
      codeModeError();
    const config = this.engine.profiles.apply(
      x.sessionId,
      normalizeAcceptInput({
        sessionId: x.sessionId,
        requestId: "code-mode-preview",
        prompt: "code-mode-preview",
        config: x.config,
        delivery: "queue",
      }).config,
    );
    const target = describeEngineQueueTarget(
      this.engine,
      this.binding,
      x.workspaceId,
      x.sessionId,
      config,
    );
    assertPhysicalKnowledgeRoot(this.binding(x.workspaceId));
    if (!target.tools.includes("execute_code") || config.mode !== "build")
      codeModeError("CODE_MODE_TOOL_NOT_ALLOWED");
    const grant = codeSign({
      version: 1 as const,
      id: randomUUID(),
      ownerEpoch: this.epoch,
      target,
      runtime: this.runtime!.capability,
    });
    if (this.retained.size >= 128) codeModeError("CODE_MODE_LIMIT");
    const original = Object.freeze({});
    this.previews.set(original, grant);
    this.retained.add(original);
    return original;
  }
  private original(original: object): CodeModeGrant {
    if (!original || types.isProxy(original))
      codeModeError("CODE_MODE_ORIGINAL_REQUIRED");
    const g = this.previews.get(original);
    if (!g || !this.retained.has(original))
      codeModeError("CODE_MODE_ORIGINAL_REQUIRED");
    return g;
  }
  readCodeModeGrant(original: object) {
    return codeJson(this.original(original));
  }
  approveCodeModeGrant(input: unknown) {
    this.active();
    if (!input || types.isProxy(input)) codeModeError();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).length !== 3 ||
      !["preview", "fingerprint", "approved"].every(
        (k) => descriptors[k] && "value" in descriptors[k],
      )
    )
      codeModeError();
    const original = descriptors.preview!.value as object,
      g = this.original(original);
    if (descriptors.approved!.value !== true) codeModeError("CODE_MODE_DENIED");
    if (descriptors.fingerprint!.value !== g.sha256)
      codeModeError("CODE_MODE_GRANT_STALE");
    this.assertGrant(g);
    this.grants.set(g.target.sessionId, g);
    return codeJson(g);
  }
  release(original: object) {
    this.retained.delete(original);
    this.previews.delete(original);
  }
  private assertGrant(g: CodeModeGrant) {
    this.runtimeCurrent();
    if (
      g.ownerEpoch !== this.epoch ||
      g.runtime.sha256 !== this.runtime!.capability.sha256 ||
      knowledgeHash(
        describeEngineQueueTarget(
          this.engine,
          this.binding,
          g.target.workspaceId,
          g.target.sessionId,
          g.target.config,
        ),
      ) !== knowledgeHash(g.target)
    )
      codeModeError("CODE_MODE_GRANT_STALE");
  }
  private grantContext(context: ToolContext, phase: "prepare" | "execute") {
    const proof = this.engine.coordinator.readCodeModeContext(context, phase),
      g = this.grants.get(proof.sessionId);
    if (!g) codeModeError("CODE_MODE_GRANT_REQUIRED");
    this.assertGrant(g);
    if (
      g.target.workspaceId !== proof.workspaceId ||
      g.target.catalogueSha256 !== proof.catalogueSha256 ||
      g.target.runConfigSha256 !== proof.configSha256
    )
      codeModeError("CODE_MODE_GRANT_STALE");
    return { proof, grant: g, binding: this.binding(proof.workspaceId) };
  }
  async prepare(input: unknown, context: ToolContext): Promise<PreparedTool> {
    const x = codeJson(input) as any;
    if (
      !x ||
      Object.keys(x).length !== 2 ||
      !Object.hasOwn(x, "source") ||
      !Object.hasOwn(x, "allocation")
    )
      codeModeError();
    parseCodeProgram(x.source);
    const allocation = validateCodeAllocation(x.allocation),
      c = this.grantContext(context, "prepare");
    if (
      allocation.maxDurationMs > context.limits.toolTimeoutMs ||
      allocation.maxResultBytes > context.limits.maxOutputBytes
    )
      codeModeError("CODE_MODE_BUDGET");
    const sourceSha256 = createHash("sha256").update(x.source).digest("hex"),
      preview = {
        codeModeSourceSha256: sourceSha256,
        codeModeGrantSha256: c.grant.sha256,
        language: "moodcode-json-v1",
        source: x.source,
        runtime: c.grant.runtime,
        allocation,
        tools: CODE_MODE_TOOLS.filter((n) => c.grant.target.tools.includes(n)),
        targetSha256: knowledgeHash(c.grant.target),
      };
    const p: PreparedTool = {
      name: "execute_code",
      input: { source: x.source, allocation } as unknown as JsonObject,
      fingerprint: knowledgeHash(preview),
      requiresApproval: true,
      preview: preview as unknown as JsonObject,
    };
    this.prepared.set(p, {
      source: x.source,
      allocation,
      grant: c.grant,
      binding: c.binding,
      fingerprint: p.fingerprint,
      used: false,
    });
    return p;
  }
  async executePrepared(p: PreparedTool, context: ToolContext) {
    const captured = this.prepared.get(p);
    if (
      !captured ||
      captured.used ||
      p.fingerprint !== captured.fingerprint ||
      knowledgeHash(p.input) !==
        knowledgeHash({
          source: captured.source,
          allocation: captured.allocation,
        })
    )
      codeModeError("CODE_MODE_PREPARED_STALE");
    captured.used = true;
    return this.run(context, captured);
  }
  private update(f: Flight, change: Partial<CodeModeRecord>) {
    const { sha256, ...body } = f.record;
    const r = codeSign({
      ...body,
      ...change,
      revision: f.record.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    f.record = this.native.put(f, r, f.record.revision);
  }
  private async run(
    context: ToolContext,
    captured: Prepared,
  ): Promise<ToolResult> {
    const c = this.grantContext(context, "execute");
    if (
      c.grant !== captured.grant ||
      knowledgeHash(c.binding) !== knowledgeHash(captured.binding)
    )
      codeModeError("CODE_MODE_GRANT_STALE");
    const generation = randomUUID(),
      now = new Date().toISOString();
    const source: CodeModeSource = codeSign({
      ...c.proof,
      approvalId: c.proof.approval!.id,
      approvalFingerprint: c.proof.approval!.fingerprint,
      rootBindingSha256: knowledgeHash(c.binding),
      ownerEpoch: this.epoch,
      grantSha256: c.grant.sha256,
      runtime: c.grant.runtime,
      source: captured.source,
      sourceSha256: createHash("sha256").update(captured.source).digest("hex"),
      allocation: captured.allocation,
      generation,
    });
    const f: Flight = {
      context,
      record: codeSign({
        version: 1 as const,
        id:
          "code-" +
          knowledgeHash([context.runId, context.toolCallId]).slice(0, 32),
        revision: 1,
        source,
        state: "prepared" as const,
        process: null,
        calls: [],
        pendingCall: null,
        outcome: null,
        result: null,
        errorCode: null,
        createdAt: now,
        updatedAt: now,
      }),
    };
    this.flights.set(context.toolCallId, f);
    const deadline = Date.now() + captured.allocation.maxDurationMs,
      timeout = new AbortController(),
      signal = AbortSignal.any([context.signal, timeout.signal]);
    const timer = setTimeout(
      () => timeout.abort(new Error("CODE_MODE_TIMEOUT")),
      captured.allocation.maxDurationMs,
    );
    let error: unknown;
    let admitted = false;
    let result: JsonValue = null;
    const assertCurrent = () => {
      if (signal.aborted) throw signal.reason;
      const now = this.grantContext(context, "execute");
      if (
        now.grant !== captured.grant ||
        knowledgeHash(now.binding) !== source.rootBindingSha256
      )
        codeModeError("CODE_MODE_GRANT_STALE");
    };
    try {
      f.record = this.native.put(f, f.record, 0);
      admitted = true;
      assertCurrent();
      f.process = new OwnedCodeModeProcess(
        this.runtime!,
        generation,
        assertCurrent,
      );
      const process = await f.process.start(signal);
      this.update(f, { state: "running", process });
      await f.process.write(
        {
          version: 1,
          type: "init",
          generation,
          program: parseCodeProgram(captured.source),
          allocation: captured.allocation,
        },
        signal,
      );
      const ids = new Set<string>();
      while (true) {
        const packet = await f.process.next(signal);
        if (packet.version !== 1 || packet.generation !== generation)
          codeModeError("CODE_MODE_PROTOCOL_INVALID");
        if (packet.type === "result") {
          if (
            Object.keys(packet).some(
              (k) =>
                ![
                  "version",
                  "type",
                  "generation",
                  "ok",
                  "value",
                  "steps",
                  "calls",
                  "errorCode",
                ].includes(k),
            ) ||
            !Number.isSafeInteger(packet.steps) ||
            packet.steps < 0 ||
            packet.steps >
              captured.allocation.maxSteps +
                (packet.ok === false &&
                packet.errorCode === "CODE_MODE_STEP_LIMIT"
                  ? 1
                  : 0) ||
            packet.calls !==
              f.record.calls.length +
                (packet.ok === false &&
                packet.errorCode === "CODE_MODE_CALL_LIMIT"
                  ? 1
                  : 0) ||
            (packet.ok !== true && packet.ok !== false)
          )
            codeModeError("CODE_MODE_PROTOCOL_INVALID");
          if (packet.ok !== true)
            codeModeError(
              typeof packet.errorCode === "string"
                ? packet.errorCode
                : "CODE_MODE_RUNTIME_FAILED",
            );
          result = codeJson(packet.value, captured.allocation.maxResultBytes);
          break;
        }
        if (
          packet.type !== "call" ||
          Object.keys(packet).some(
            (k) =>
              ![
                "version",
                "type",
                "generation",
                "id",
                "tool",
                "input",
              ].includes(k),
          ) ||
          typeof packet.id !== "string" ||
          packet.id.length > 256 ||
          ids.has(packet.id) ||
          !(CODE_MODE_TOOLS as readonly string[]).includes(packet.tool) ||
          !packet.input ||
          typeof packet.input !== "object" ||
          Array.isArray(packet.input)
        )
          codeModeError("CODE_MODE_PROTOCOL_INVALID");
        if (ids.size >= captured.allocation.maxNestedCalls)
          codeModeError("CODE_MODE_CALL_LIMIT");
        ids.add(packet.id);
        assertCurrent();
        const callId = "code:" + knowledgeHash([generation, packet.id]);
        this.update(f, {
          pendingCall: { id: callId, name: packet.tool, input: packet.input },
        });
        const actual = await this.engine.coordinator.executeCodeModeNested(
          context,
          {
            id: callId,
            tool: packet.tool,
            input: codeJson(packet.input),
            deadline,
            signal,
            assertCurrent,
          },
        );
        const { content, ...receipt } = actual;
        this.update(f, {
          calls: [...f.record.calls, { id: callId, ...receipt }],
          pendingCall: null,
        });
        const bounded = codeJson(
          { state: actual.state, content },
          captured.allocation.maxResultBytes,
        );
        await f.process.write(
          {
            version: 1,
            type: "reply",
            generation,
            id: packet.id,
            ok: true,
            result: bounded,
          },
          signal,
        );
      }
    } catch (cause) {
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        ["TOOL_LIMIT", "TURN_TOOL_LIMIT", "TOOL_CALL_LIMIT"].includes(
          String(cause.code),
        ) &&
        f.record.pendingCall
      ) {
        try {
          this.update(f, { pendingCall: null });
        } catch {}
      }
      error = cause;
    } finally {
      clearTimeout(timer);
      if (f.process) {
        try {
          const outcome = await f.process.stop();
          this.update(f, {
            outcome,
            result,
            errorCode:
              error instanceof Error && "code" in error
                ? String(error.code)
                : error
                  ? "CODE_MODE_FAILED"
                  : null,
            state:
              outcome.cleanupConfirmed && !f.record.pendingCall
                ? "settling"
                : "uncertain",
          });
        } catch (cause) {
          error = cause;
          try {
            this.update(f, {
              state: "uncertain",
              errorCode: "CODE_MODE_JOURNAL_UNCERTAIN",
            });
          } catch {}
        }
      }
    }
    if (error && !admitted) {
      this.flights.delete(context.toolCallId);
      codeModeError("CODE_MODE_ADMISSION_FAILED");
    }
    if (error) {
      if (
        !f.record.outcome?.cleanupConfirmed ||
        f.record.pendingCall ||
        f.record.state === "uncertain"
      )
        codeModeError("CLEANUP_UNCERTAIN");
      if (context.signal.aborted) throw context.signal.reason;
      return {
        content: JSON.stringify({
          code: f.record.errorCode ?? "CODE_MODE_FAILED",
        }),
        isError: true,
        data: { cleanupConfirmed: true, timedOut: timeout.signal.aborted },
      };
    }
    if (!f.record.outcome?.cleanupConfirmed) codeModeError("CLEANUP_UNCERTAIN");
    return {
      content: JSON.stringify({
        authority: "untrusted-code-result",
        value: result,
        codeModeId: f.record.id,
        nestedCalls: f.record.calls.length,
      }),
      data: { cleanupConfirmed: true },
    };
  }
  assertRecordOwner(
    original: object,
    record: CodeModeRecord,
    expected: number,
  ): void {
    if (!original || types.isProxy(original))
      codeModeError("CODE_MODE_ORIGINAL_REQUIRED");
    if (![...this.flights.values()].includes(original as Flight))
      codeModeError("CODE_MODE_ORIGINAL_REQUIRED");
    record = codeJson(record);
    const f = original as Flight;
    if (
      this.flights.get(record.source.toolCallId) !== f ||
      f.record.source.sha256 !== record.source.sha256 ||
      f.record.id !== record.id ||
      f.record.revision !== Math.max(1, expected)
    )
      codeModeError("CODE_MODE_OWNER_STALE");
    if (!f.settlingTool)
      this.engine.coordinator.readCodeModeContext(f.context, "observe");
    else {
      const actual = this.engine.store.getToolCall(f.settlingTool.id);
      if (
        actual.id !== record.source.toolCallId ||
        actual.runId !== record.source.runId ||
        actual.state !== f.settlingTool.state
      )
        codeModeError("CODE_MODE_OWNER_STALE");
    }
    if (
      record.process &&
      (!f.process ||
        knowledgeHash(f.process.readProof()) !== knowledgeHash(record.process))
    )
      codeModeError("CODE_MODE_PROCESS_INVALID");
    if (
      record.outcome &&
      (!f.process ||
        knowledgeHash(f.process.readOutcome()) !==
          knowledgeHash(record.outcome))
    )
      codeModeError("CODE_MODE_OUTCOME_INVALID");
  }
  toolSettled(tool: ToolCallRecord) {
    const f = this.flights.get(tool.id);
    if (!f) return;
    f.settlingTool = tool;
    const closed = f.record.outcome?.cleanupConfirmed && !f.record.pendingCall;
    try {
      if (closed && ["completed", "failed"].includes(tool.state))
        this.update(f, { state: tool.state as "completed" | "failed" });
      else if (
        closed &&
        f.record.state === "settling" &&
        tool.state === "interrupted"
      )
        this.update(f, { state: "failed", errorCode: "CANCELLED" });
      else
        this.update(f, {
          state: "uncertain",
          errorCode: "CODE_MODE_TOOL_UNCERTAIN",
        });
    } catch {
      try {
        this.update(f, {
          state: "uncertain",
          errorCode: "CODE_MODE_JOURNAL_UNCERTAIN",
        });
      } catch {}
      codeModeError("CLEANUP_UNCERTAIN");
    } finally {
      this.flights.delete(tool.id);
    }
  }
  inspect(workspaceId: string) {
    return this.native.inspect(workspaceId);
  }
  get(workspaceId: string, id: string) {
    return this.native.get(workspaceId, id);
  }
  async close() {
    this.closed = true;
    this.grants.clear();
    this.retained.clear();
    await Promise.all(
      [...this.flights.values()].map((f) => f.process?.stop().catch(() => {})),
    );
  }
}
