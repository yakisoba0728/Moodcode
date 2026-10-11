import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { types } from "node:util";
import { EngineError, type JsonObject } from "@moodcode/contracts";
import type { ToolContext } from "../ports.js";
import type { EngineRuntime } from "../engine-runtime.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import { assertPhysicalKnowledgeRoot } from "../workspace/trust.js";
import { commandBackendCapability } from "../tools/command/backends.js";
import { reserveExecutionLock, readExecutionLockReservation } from "../tools/command/execution-lock.js";
import { captureWorkspace, type WorkspaceCapture } from "../workspace/index.js";
import {
  executePhysicalCommand,
  preparePhysicalCommand,
  type PhysicalCommandResult,
  type PhysicalCommandScope,
} from "../tools/command/index.js";
import {
  CommandOutputRing,
  verifySealedCommandArtifacts,
  type CommandOutputRingSnapshot,
  type CommandOutputStream,
  type CommandArtifactDescriptor,
  type CommandProcessControl,
} from "../tools/command/observation.js";
import {
  HostCommandStorage,
  HOST_COMMAND_LIMITS,
  type HostCommandPreview,
  type HostCommandRecord,
  type HostCommandState,
} from "./host-command-records.js";
import {
  jobHostAbort,
  jobHostRecord,
  jobIdentifier,
  jobJson,
  jobObject,
  jobPathGone,
  signJobData,
} from "./validation.js";

export interface PreviewHostCommandInput {
  workspaceId: string;
  sessionId: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  limits: { maxDurationMs: number; maxOutputBytes: number };
}
export interface StartHostCommandInput {
  workspaceId: string;
  requestId: string;
  preview: object;
  fingerprint: string;
  approved: boolean;
  signal?: AbortSignal;
}
export interface HostCommandOutputCursor {
  version: 1;
  jobId: string;
  snapshotSha256: string;
  eventSeq: number;
  byteOffset: number;
  sha256: string;
}
export interface HostCommandOutputPage {
  version: 1;
  jobId: string;
  snapshotSha256: string;
  fragments: readonly {
    seq: number;
    stream: CommandOutputStream;
    data: string;
    bytes: number;
    byteOffset: number;
  }[];
  gap: null | { fromSeq: number; throughSeq: number };
  nextCursor: HostCommandOutputCursor;
  hasMore: boolean;
  rawBytes: number;
  sha256: string;
}
interface PreviewEntry {
  proof: HostCommandPreview;
  binding: KnowledgeHostBinding;
}
interface Flight {
  record: HostCommandRecord;
  abort: AbortController;
  ring: CommandOutputRing;
  done: Promise<HostCommandRecord>;
}
interface FrozenOutput {
  jobId: string;
  epoch: string;
  binding: KnowledgeHostBinding;
  snapshot: CommandOutputRingSnapshot;
  sha256: string;
}
function fail(code: string): never {
  throw new EngineError(
    code,
    "Independent host command original ownership, approval or observation is unavailable or changed",
  );
}
function cwdIdentity(path: string): string {
  try {
    const st = lstatSync(path, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path)
      fail("HOST_COMMAND_TARGET_STALE");
    return knowledgeHash({
      path,
      dev: st.dev.toString(),
      ino: st.ino.toString(),
    });
  } catch (error) {
    if (jobPathGone(error)) fail("HOST_COMMAND_TARGET_STALE");
    throw error;
  }
}
/** Content-free before-effects manifest; capture may include ignored files. */
function checkpointBefore(before: WorkspaceCapture): JsonObject {
  return jobJson(
    {
      files: [...before.files.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, file]) => ({
          path,
          sha256: file.hash,
          bytes: Buffer.byteLength(file.content),
        })),
      warnings: before.warnings,
    },
    HOST_COMMAND_LIMITS.rowBytes,
  ) as unknown as JsonObject;
}
export class HostCommandService {
  private readonly epoch = knowledgeHash({ nonce: randomUUID() });
  private readonly previews = new WeakMap<object, PreviewEntry>();
  private readonly handles = new Set<object>();
  private readonly output = new WeakMap<object, FrozenOutput>();
  private readonly retained = new Map<string, Flight>();
  private readonly pending = new Map<
    string,
    { sha: string; admitted: Promise<HostCommandRecord> }
  >();
  private closed = false;
  constructor(
    private readonly engine: Pick<
      EngineRuntime,
      "store" | "coordinator" | "toolRuntime"
    >,
    private readonly native: HostCommandStorage,
    private readonly checkBinding: (id: string) => KnowledgeHostBinding,
    private readonly options: {
      enabled: () => boolean;
      unsupportedPolicy: boolean;
      artifactDir: string;
      executionLockPath: string;
      lifetime: AbortSignal;
      sandbox?:(ws:string,session:string)=>import('../sandbox/types.js').SandboxLaunch;
    },
  ) {
    native.recover();
  }
  private open(): void {
    if (this.closed) fail("ENGINE_CLOSED");
  }
  private active(): void {
    this.open();
    if (!commandBackendCapability().available)
      fail("HOST_COMMAND_PLATFORM_UNSUPPORTED");
    if (!this.options.enabled()) fail("HOST_COMMANDS_DISABLED");
    if (this.options.unsupportedPolicy) fail("HOST_COMMAND_POLICY_UNSUPPORTED");
  }
  private binding(workspaceId: string): KnowledgeHostBinding {
    const b = jobJson(this.checkBinding(workspaceId));
    assertPhysicalKnowledgeRoot(b);
    return b;
  }
  private policy(input: HostCommandPreview["input"]): number {
    const policy = this.engine.toolRuntime.policy.evaluate({
      toolName: "run_command",
      effect: "execute",
      mode: "build",
      requiresApproval: true,
      resources: [`command:${input.command}`, `path:${input.cwd}`],
    });
    if (policy.decision === "deny") fail("HOST_COMMAND_POLICY_DENIED");
    return policy.version;
  }
  private current(p: PreviewEntry): void {
    this.active();
    if (
      knowledgeHash(this.binding(p.proof.workspaceId)) !==
        knowledgeHash(p.binding) ||
      cwdIdentity(p.proof.input.cwd) !== p.proof.cwdIdentitySha256 ||
      this.policy(p.proof.input) !== p.proof.policyVersion
    )
      fail("HOST_COMMAND_TARGET_STALE");
    if(this.options.sandbox&&knowledgeHash(this.options.sandbox(p.proof.workspaceId,p.proof.sessionId))!==knowledgeHash(p.proof.sandbox))fail("HOST_COMMAND_TARGET_STALE");
    const session = this.engine.store.getSession(p.proof.sessionId);
    if (session.workspaceId !== p.proof.workspaceId)
      fail("HOST_COMMAND_TARGET_STALE");
  }
  private original(handle: object): PreviewEntry {
    this.active();
    if (
      !handle ||
      typeof handle !== "object" ||
      types.isProxy(handle) ||
      !this.handles.has(handle)
    )
      fail("HOST_COMMAND_ORIGINAL_REQUIRED");
    const p = this.previews.get(handle);
    if (!p) fail("HOST_COMMAND_ORIGINAL_REQUIRED");
    this.current(p);
    return p;
  }
  async preview(input: PreviewHostCommandInput): Promise<object> {
    this.active();
    jobHostRecord(
      input,
      ["workspaceId", "sessionId", "command", "limits"],
      ["cwd", "timeoutMs"],
    );
    const x = jobJson(input, 131072);
    jobIdentifier(x.workspaceId);
    jobIdentifier(x.sessionId);
    const limits = jobObject(x.limits, ["maxDurationMs", "maxOutputBytes"]);
    for (const k of ["maxDurationMs", "maxOutputBytes"])
      if (
        !Number.isSafeInteger(limits[k]) ||
        Number(limits[k]) < 1 ||
        Number(limits[k]) >
          (k === "maxDurationMs" ? 300000 : HOST_COMMAND_LIMITS.outputBytes)
      )
        fail("INVALID_HOST_COMMAND_LIMIT");
    const workspace = this.engine.store.getWorkspace(x.workspaceId),
      session = this.engine.store.getSession(x.sessionId);
    if (session.workspaceId !== workspace.id) fail("HOST_COMMAND_TARGET_STALE");
    const binding = this.binding(x.workspaceId),
      command = await preparePhysicalCommand(
        {
          command: x.command,
          ...(x.cwd === undefined ? {} : { cwd: x.cwd }),
          ...(x.timeoutMs === undefined ? {} : { timeoutMs: x.timeoutMs }),
        },
        {
          workspace,
          signal: this.options.lifetime,
          limits: {
            toolTimeoutMs: x.limits.maxDurationMs,
            maxOutputBytes: x.limits.maxOutputBytes,
          },
          artifactDir: this.options.artifactDir,
        },
      );
    const body = {
      version: 1 as const,
      workspaceId: workspace.id,
      sessionId: session.id,
      input: command,
      rootBindingSha256: knowledgeHash(binding),
      cwdIdentitySha256: cwdIdentity(command.cwd),
      platform: process.platform,
      policyVersion: this.policy(command),
      limits: x.limits,
      ...(this.options.sandbox?{sandbox:this.options.sandbox(workspace.id,session.id)}:{}),
    };
    const proof = jobJson(
        { ...body, fingerprint: knowledgeHash(body) },
        131072,
      ),
      entry = { proof, binding };
    this.current(entry);
    if (this.handles.size >= 128) fail("HOST_COMMAND_LIMIT");
    const handle = Object.freeze({});
    this.previews.set(handle, entry);
    this.handles.add(handle);
    return handle;
  }
  readPreview(original: object): HostCommandPreview {
    return structuredClone(this.original(original).proof);
  }
  async start(input: StartHostCommandInput): Promise<HostCommandRecord> {
    return this.startInternal(input);
  }
  /** Internal original model owner only; host callers cannot select a lease callback. */
  async startLifetime(input: StartHostCommandInput, control: (control: CommandProcessControl) => void, context?: ToolContext): Promise<HostCommandRecord> {
    if (context) this.engine.coordinator.readOwnedCommandContext(context, "start");
    return this.startInternal(input, {control, ...(context ? {context} : {})});
  }
  private async startInternal(input: StartHostCommandInput, lifetime?: {control: (control: CommandProcessControl) => void; context?: ToolContext}): Promise<HostCommandRecord> {
    this.active();
    jobHostRecord(
      input,
      ["workspaceId", "requestId", "preview", "fingerprint", "approved"],
      ["signal"],
    );
    jobHostAbort(input.signal);
    jobIdentifier(input.workspaceId);
    jobIdentifier(input.requestId);
    if (typeof input.approved !== "boolean")
      fail("INVALID_HOST_COMMAND_APPROVAL");
    const p = this.original(input.preview);
    if (
      p.proof.workspaceId !== input.workspaceId ||
      p.proof.fingerprint !== input.fingerprint
    )
      fail("HOST_COMMAND_APPROVAL_MISMATCH");
    const requestSha256 = knowledgeHash({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        fingerprint: input.fingerprint,
        approved: input.approved,
      }),
      key = knowledgeHash([input.workspaceId, input.requestId]);
    const prior = this.native.find(input.workspaceId, input.requestId);
    if (prior) {
      if (prior.requestSha256 !== requestSha256) fail("REQUEST_ID_CONFLICT");
      return structuredClone(prior);
    }
    const cached = this.pending.get(key);
    if (cached) {
      if (cached.sha !== requestSha256) fail("REQUEST_ID_CONFLICT");
      return structuredClone(await cached.admitted);
    }
    let admit!: (r: HostCommandRecord) => void, reject!: (e: unknown) => void;
    const admitted = new Promise<HostCommandRecord>((yes, no) => {
      admit = yes;
      reject = no;
    });
    void admitted.catch(() => {});
    this.pending.set(key, { sha: requestSha256, admitted });
    const jobId = `host_command_${knowledgeHash([input.workspaceId, input.requestId, requestSha256]).slice(0, 32)}`;
    const initial = (
      snapshot: JsonObject,
      state: "approved" | "denied",
    ): HostCommandRecord =>
      this.native.append({
        version: 1,
        id: randomUUID(),
        jobId,
        workspaceId: input.workspaceId,
        sessionId: p.proof.sessionId,
        revision: 1,
        previousId: null,
        kind: state,
        state,
        requestId: input.requestId,
        requestSha256,
        preview: p.proof,
        owner: {
          epoch: this.epoch,
          rootBindingSha256: p.proof.rootBindingSha256,
          beforeSnapshotSha256: knowledgeHash(snapshot),
        },
        pid: null,
        completion: null,
        outputSeq: 0,
        outputObservedBytes: 0,
        outputStoredBytes: 0,
        payload: snapshot,
        createdAt: new Date().toISOString(),
      });
    if (!input.approved) {
      try {
        const denied = initial({ decision: "deny" }, "denied");
        admit(denied);
        return structuredClone(denied);
      } catch (e) {
        reject(e);
        throw e;
      } finally {
        this.pending.delete(key);
      }
    }
    const abort = new AbortController(),
      ring = new CommandOutputRing();
    let flight: Flight | undefined;
    let didAdmit = false,
      journalGap = false;
    const lease = lifetime?.context ? (operation: (signal: AbortSignal) => Promise<HostCommandRecord>) => this.engine.coordinator.withCommandWorkspaceLease(lifetime.context!, operation) : (operation: (signal: AbortSignal) => Promise<HostCommandRecord>) => this.engine.coordinator.withWorkspaceLease(input.workspaceId, operation);
    const done = lease(
      async (leaseSignal) => {
        const signal = AbortSignal.any([
          leaseSignal,
          abort.signal,
          this.options.lifetime,
          AbortSignal.timeout(p.proof.limits.maxDurationMs),
          ...(input.signal ? [input.signal] : []),
        ]);
        const workspace = this.engine.store.getWorkspace(input.workspaceId),
          scope: PhysicalCommandScope = {
            workspace,
            signal,
            limits: {
              toolTimeoutMs: p.proof.limits.maxDurationMs,
              maxOutputBytes: p.proof.limits.maxOutputBytes,
            },
            artifactDir: this.options.artifactDir,
            executionLockPath: this.options.executionLockPath,
            ...(process.platform === "win32" ? { executionLockReservation: reserveExecutionLock(this.options.executionLockPath) } : {}),
            ...(p.proof.sandbox?{sandbox:p.proof.sandbox}:{}),
          };
        try {
          jobHostAbort(signal);
          this.current(p);
          const checked = await preparePhysicalCommand(p.proof.input, scope);
          if (knowledgeHash(checked) !== knowledgeHash(p.proof.input))
            fail("HOST_COMMAND_TARGET_STALE");
          const before = await captureWorkspace(workspace, {
            signal,
            maxFiles: 128,
            maxFileBytes: 8192,
            maxTotalBytes: HOST_COMMAND_LIMITS.snapshotBytes,
          });
          jobHostAbort(signal);
          this.current(p);
          const snapshot = checkpointBefore(before);
          // Bind the committed crash marker before the native owner opens a job.
          // Its process-group update is intentionally rolled back on a crash.
          const record = initial(scope.executionLockReservation ? {
            ...snapshot,
            executionLock: { path: this.options.executionLockPath, marker: { ...readExecutionLockReservation(scope.executionLockReservation) } },
          } : snapshot, "approved");
          flight = { record, abort, ring, done };
          this.retained.set(jobId, flight);
          const update = (
            kind: string,
            state: HostCommandState,
            payload: JsonObject,
            extra: Partial<HostCommandRecord> = {},
          ) => {
            if (
              knowledgeHash(this.binding(input.workspaceId)) !==
              p.proof.rootBindingSha256
            )
              fail("HOST_COMMAND_TARGET_STALE");
            const current = flight!.record;
            const next = this.native.append({
              ...current,
              ...extra,
              id: randomUUID(),
              revision: current.revision + 1,
              previousId: current.id,
              kind,
              state,
              payload,
              createdAt: new Date().toISOString(),
            });
            flight!.record = next;
            return next;
          };
          const persistOutput = (
            emitted: ReturnType<CommandOutputRing["push"]>,
            observed: number,
          ) => {
            for (const event of emitted) {
              if (
                flight!.record.outputStoredBytes + event.bytes >
                p.proof.limits.maxOutputBytes
              ) {
                journalGap = true;
                continue;
              }
              if (journalGap) continue;
              try {
                update(
                  "output",
                  "running",
                  {
                    seq: flight!.record.outputSeq + 1,
                    stream: event.stream,
                    data: event.data,
                    bytes: event.bytes,
                  },
                  {
                    outputSeq: flight!.record.outputSeq + 1,
                    outputObservedBytes: observed,
                    outputStoredBytes:
                      flight!.record.outputStoredBytes + event.bytes,
                  },
                );
              } catch (error) {
                if (
                  error instanceof EngineError &&
                  error.code === "HOST_COMMAND_LIMIT"
                ) {
                  journalGap = true;
                  continue;
                }
                throw error;
              }
            }
          };
          const events = (stream: CommandOutputStream, bytes: Buffer) => {
            const emitted = ring.push(stream, bytes),
              observed = ring.snapshot().observedBytes;
            persistOutput(emitted, observed);
            if (observed > p.proof.limits.maxOutputBytes)
              abort.abort(
                new EngineError(
                  "HOST_COMMAND_OUTPUT_LIMIT",
                  "Independent command output exceeded its approved budget",
                ),
              );
          };
          const original = Object.freeze({});
          const result = await executePhysicalCommand(
            p.proof.input,
            scope,
            before,
            {
              started: (actual, pid) => {
                if (actual !== original) fail("HOST_COMMAND_ORIGINAL_REQUIRED");
                const started = update("running", "running", { pid }, { pid });
                didAdmit = true;
                admit(started);
              },
              ...(lifetime ? {control:(actual: object, handle: CommandProcessControl) => { if (actual !== original) fail("HOST_COMMAND_ORIGINAL_REQUIRED"); lifetime.control(handle); }} : {}),
              output: (actual, stream, bytes) => {
                if (actual !== original) fail("HOST_COMMAND_ORIGINAL_REQUIRED");
                events(stream, bytes);
              },
              failed: () => {
                abort.abort(
                  new EngineError(
                    "HOST_COMMAND_OBSERVATION_FAILED",
                    "Original physical command observation failed",
                  ),
                );
              },
            },
            () => {
              jobHostAbort(signal);
              this.current(p);
              if(lifetime?.context)this.engine.coordinator.readOwnedCommandContext(lifetime.context,"start");
              return original;
            },
          );
          persistOutput(ring.end("stdout"), ring.snapshot().observedBytes);
          persistOutput(ring.end("stderr"), ring.snapshot().observedBytes);
          update("checkpoint", flight.record.state, {
            files: result.files,
            warnings: [...result.warnings],
            incomplete: result.incomplete,
            sha256: knowledgeHash({
              files: result.files,
              warnings: result.warnings,
              incomplete: result.incomplete,
            }),
          } as unknown as JsonObject);
          const state: HostCommandState =
            !result.outcome.cleanupConfirmed || result.observationFailure
              ? "uncertain"
              : result.outcome.cancelled || result.outcome.timedOut
                ? "cancelled"
                : result.outcome.exitCode === 0 && !result.outcome.error
                  ? "completed"
                  : "failed";
          const closed = update(
            "closed",
            state,
            {
              completionSha256: knowledgeHash(result),
              outputJournalGap: journalGap,
            },
            {
              completion: result,
              outputObservedBytes: ring.snapshot().observedBytes,
            },
          );
          if (!didAdmit && result.outcome.started)
            reject(
              new EngineError(
                "CLEANUP_UNCERTAIN",
                "Independent command process admission was not committed",
              ),
            );
          else admit(closed);
          if (state === "uncertain")
            this.engine.coordinator.quarantineWorkspace(input.workspaceId);
          return closed;
        } catch (error) {
          if (!flight) {
            reject(error);
            throw error;
          }
          try {
            flight.record = this.native.control(flight.record, "recovery", {
              reason: "HOST_COMMAND_EXECUTION_UNCERTAIN",
            });
          } catch {}
          this.engine.coordinator.quarantineWorkspace(input.workspaceId);
          const uncertain = new EngineError(
            "CLEANUP_UNCERTAIN",
            "Independent command completion remains unconfirmed in its native evidence",
          );
          reject(uncertain);
          throw uncertain;
        }
      },
    );
    void done
      .catch((error) => {
        reject(error);
      })
      .finally(() => {
        this.pending.delete(key);
      });
    return structuredClone(await admitted);
  }
  async wait(input: {
    workspaceId: string;
    jobId: string;
  }): Promise<HostCommandRecord> {
    jobHostRecord(input, ["workspaceId", "jobId"]);
    const record = this.native.get(input.workspaceId, input.jobId);
    if (!record) fail("HOST_COMMAND_NOT_FOUND");
    const flight = this.retained.get(input.jobId);
    if (flight) return structuredClone(await flight.done);
    if (["approved", "running"].includes(record.state))
      fail("HOST_COMMAND_OWNER_UNAVAILABLE");
    return structuredClone(record);
  }
  async cancel(input: {
    workspaceId: string;
    jobId: string;
  }): Promise<HostCommandRecord> {
    this.active();
    jobHostRecord(input, ["workspaceId", "jobId"]);
    const record = this.native.get(input.workspaceId, input.jobId);
    if (!record) fail("HOST_COMMAND_NOT_FOUND");
    const f = this.retained.get(input.jobId);
    if (!f || record.owner.epoch !== this.epoch)
      fail("HOST_COMMAND_OWNER_UNAVAILABLE");
    f.abort.abort(
      new EngineError(
        "HOST_COMMAND_CANCELLED",
        "The host cancelled its original command",
      ),
    );
    return structuredClone(await f.done);
  }
  inspect(workspaceId: string) {
    this.open();
    return structuredClone(this.native.inspect(workspaceId));
  }
  get(workspaceId: string, jobId: string) {
    this.open();
    const r = this.native.get(workspaceId, jobId);
    return r ? structuredClone(r) : undefined;
  }
  private checkArtifacts(result: PhysicalCommandResult): void {
    verifySealedCommandArtifacts(result, () =>
      fail("HOST_COMMAND_ARTIFACT_STALE"),
    );
  }
  artifacts(input: { workspaceId: string; jobId: string }): {
    stdout: CommandArtifactDescriptor;
    stderr: CommandArtifactDescriptor;
  } {
    this.active();
    jobHostRecord(input, ["workspaceId", "jobId"]);
    const f = this.retained.get(input.jobId),
      r = this.native.get(input.workspaceId, input.jobId);
    if (
      !f ||
      !r ||
      r.sha256 !== f.record.sha256 ||
      r.owner.epoch !== this.epoch ||
      !r.completion
    )
      fail("HOST_COMMAND_OWNER_UNAVAILABLE");
    if (
      knowledgeHash(this.binding(input.workspaceId)) !==
      r.owner.rootBindingSha256
    )
      fail("HOST_COMMAND_TARGET_STALE");
    this.checkArtifacts(r.completion);
    return structuredClone({
      stdout: r.completion.stdout,
      stderr: r.completion.stderr,
    });
  }
  assertLifetimeCurrent(workspaceId:string,jobId:string):void{
    this.active();const flight=this.retained.get(jobId),r=this.native.get(workspaceId,jobId);
    if(!flight||!r||r.owner.epoch!==this.epoch||r.sha256!==flight.record.sha256||r.state!=='running'||knowledgeHash(this.binding(workspaceId))!==r.owner.rootBindingSha256||cwdIdentity(r.preview.input.cwd)!==r.preview.cwdIdentitySha256||this.policy(r.preview.input)!==r.preview.policyVersion)fail('HOST_COMMAND_TARGET_STALE');
  }
  captureOutput(input: { workspaceId: string; jobId: string }): object {
    this.active();
    jobHostRecord(input, ["workspaceId", "jobId"]);
    const f = this.retained.get(input.jobId);
    if (
      !f ||
      f.record.workspaceId !== input.workspaceId ||
      f.record.owner.epoch !== this.epoch
    )
      fail("HOST_COMMAND_OWNER_UNAVAILABLE");
    const binding = this.binding(input.workspaceId);
    if (knowledgeHash(binding) !== f.record.owner.rootBindingSha256)
      fail("HOST_COMMAND_TARGET_STALE");
    if (f.record.completion) this.checkArtifacts(f.record.completion);
    if (this.handles.size >= 128) fail("HOST_COMMAND_LIMIT");
    const snapshot = f.ring.snapshot(),
      sha256 = knowledgeHash({
        jobId: input.jobId,
        epoch: this.epoch,
        snapshot,
      }),
      original = Object.freeze({});
    this.output.set(original, {
      jobId: input.jobId,
      epoch: this.epoch,
      binding,
      snapshot,
      sha256,
    });
    this.handles.add(original);
    return original;
  }
  readOutput(
    original: object,
    input: { cursor?: HostCommandOutputCursor } = {},
  ): HostCommandOutputPage {
    this.open();
    jobHostRecord(input, [], ["cursor"]);
    if (!original || types.isProxy(original) || !this.handles.has(original))
      fail("HOST_COMMAND_ORIGINAL_REQUIRED");
    const s = this.output.get(original);
    if (
      !s ||
      s.epoch !== this.epoch ||
      knowledgeHash(this.binding(s.binding.workspaceId)) !==
        knowledgeHash(s.binding)
    )
      fail("HOST_COMMAND_TARGET_STALE");
    let seq = 1,
      offset = 0;
    if (input.cursor) {
      const c = jobObject(input.cursor, [
        "version",
        "jobId",
        "snapshotSha256",
        "eventSeq",
        "byteOffset",
        "sha256",
      ]);
      const { sha256, ...body } = c;
      if (
        knowledgeHash(body) !== sha256 ||
        c.version !== 1 ||
        c.jobId !== s.jobId ||
        c.snapshotSha256 !== s.sha256 ||
        !Number.isSafeInteger(c.eventSeq) ||
        Number(c.eventSeq) < 1 ||
        Number(c.eventSeq) > s.snapshot.outputSeq + 1 ||
        !Number.isSafeInteger(c.byteOffset) ||
        Number(c.byteOffset) < 0
      )
        fail("HOST_COMMAND_CURSOR_STALE");
      seq = Number(c.eventSeq);
      offset = Number(c.byteOffset);
    }
    const gap =
      seq < s.snapshot.oldestSeq
        ? { fromSeq: seq, throughSeq: s.snapshot.oldestSeq - 1 }
        : null;
    if (gap) {
      seq = s.snapshot.oldestSeq;
      offset = 0;
    }
    const fragments: {
      seq: number;
      stream: CommandOutputStream;
      data: string;
      bytes: number;
      byteOffset: number;
    }[] = [];
    let bytes = 0,
      encodedTextBytes = 0;
    for (const event of s.snapshot.output) {
      if (event.seq < seq) continue;
      const raw = Buffer.from(event.data);
      if (
        offset > raw.length ||
        (offset < raw.length && (raw[offset]! & 0xc0) === 0x80)
      )
        fail("HOST_COMMAND_CURSOR_STALE");
      let end = Math.min(raw.length, offset + 16384 - bytes);
      while (end > offset && end < raw.length && (raw[end]! & 0xc0) === 0x80)
        end--;
      if (end === offset) break;
      let data = raw.subarray(offset, end).toString("utf8"),
        allowedBytes = 0,
        encodedBytes = 0;
      for (const char of data) {
        const encoded = Buffer.byteLength(JSON.stringify(char)) - 2;
        if (encodedTextBytes + encodedBytes + encoded > 32768) break;
        allowedBytes += Buffer.byteLength(char);
        encodedBytes += encoded;
      }
      if (allowedBytes === 0) break;
      end = offset + allowedBytes;
      data = raw.subarray(offset, end).toString("utf8");
      encodedTextBytes += encodedBytes;
      fragments.push({
        seq: event.seq,
        stream: event.stream,
        data,
        bytes: end - offset,
        byteOffset: offset,
      });
      bytes += end - offset;
      seq = end === raw.length ? event.seq + 1 : event.seq;
      offset = end === raw.length ? 0 : end;
      if (bytes >= 16384 || fragments.length >= 64 || end < raw.length) break;
    }
    if (seq === s.snapshot.outputSeq + 1 && offset !== 0)
      fail("HOST_COMMAND_CURSOR_STALE");
    const nextCursor = signJobData({
      version: 1 as const,
      jobId: s.jobId,
      snapshotSha256: s.sha256,
      eventSeq: seq,
      byteOffset: offset,
    });
    return signJobData(
      {
        version: 1 as const,
        jobId: s.jobId,
        snapshotSha256: s.sha256,
        fragments,
        gap,
        nextCursor,
        hasMore: seq <= s.snapshot.outputSeq,
        rawBytes: bytes,
      },
      65536,
    );
  }
  release(original: object): void {
    this.handles.delete(original);
    this.previews.delete(original);
    this.output.delete(original);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.retained.values())
      f.abort.abort(
        new EngineError("ENGINE_CLOSED", "Root closed its independent command"),
      );
    const results = await Promise.allSettled(
      [...this.retained.values()].map((f) => f.done),
    );
    this.handles.clear();
    if (
      results.some(
        (r) => r.status === "rejected" || r.value.state === "uncertain",
      )
    )
      fail("CLEANUP_UNCERTAIN");
  }
}
