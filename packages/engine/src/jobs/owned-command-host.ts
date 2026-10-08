import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { types } from "node:util";
import {
  EngineError,
  type JsonObject,
  type Run,
  type ToolCallRecord,
  isTerminal,
} from "@moodcode/contracts";
import type { MoodcodeEngine } from "../engine.js";
import type { PreparedTool, ToolContext } from "../ports.js";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import { knowledgeHash } from "../knowledge/validation.js";
import {
  CommandOutputRing,
  validateCommandArtifactDescriptor,
  type CommandExecutionObserver,
  type CommandExecutionCompletion,
  type CommandOutputRingSnapshot,
  type CommandOutputStream,
} from "../tools/command/observation.js";
import { jobHostRecord } from "./host.js";
import { jobIdentifier, jobJson, signJobData } from "./validation.js";
import {
  ownedCommandJobId,
  validateOwnedCommandJob,
  type OwnedCommandCompletion,
  type OwnedCommandJobRecord,
  type OwnedCommandJobSource,
} from "./owned-command-records.js";

interface Entry {
  readonly context: ToolContext;
  readonly source: OwnedCommandJobSource;
  readonly binding: KnowledgeHostBinding;
  readonly ring: CommandOutputRing;
  record: OwnedCommandJobRecord;
}
interface Snapshot {
  readonly entry: Entry;
  readonly data: CommandOutputRingSnapshot;
  readonly sha256: string;
  readonly bytes: number;
}
export interface OwnedCommandOutputPage {
  readonly version: 1;
  readonly jobId: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly throughSeq: number;
  readonly oldestSeq: number;
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly output: CommandOutputRingSnapshot["output"];
  readonly nextAfterSeq: number;
  readonly gap: null | {
    readonly fromSeq: number;
    readonly toSeq: number;
    readonly oldestSeq: number;
  };
  readonly hasMore: boolean;
  readonly rawBytes: number;
  readonly sha256: string;
}
function fail(code: string): never {
  throw new EngineError(
    code,
    "The original native command job observation is unavailable or changed",
  );
}

/** This consumer observes an already approved native command; its Run retains physical ownership. */
export class OwnedCommandJobHost implements CommandExecutionObserver {
  private readonly epoch = knowledgeHash({ nonce: randomUUID() });
  private readonly originals = new WeakMap<object, Entry>();
  private readonly skipped = new WeakSet<object>();
  private readonly entries = new Map<string, Entry>();
  private readonly snapshots = new WeakMap<object, Snapshot>();
  private readonly settledSources = new WeakMap<
    object,
    { entry: Entry; sha256: string }
  >();
  private readonly settledHandles = new Set<object>();
  private readonly handles = new Set<object>();
  private snapshotBytes = 0;
  private readonly cancellations = new Map<
    string,
    { sha256: string; result: Promise<Run> }
  >();
  private isClosed = false;
  constructor(
    private readonly engine: MoodcodeEngine,
    private readonly checkBinding: (
      workspaceId: string,
    ) => KnowledgeHostBinding,
    private readonly enabled: () => boolean,
  ) {}
  private open(): void {
    if (this.isClosed) fail("ENGINE_CLOSED");
  }
  private active(): void {
    this.open();
    if (!this.enabled()) fail("JOBS_DISABLED");
  }
  private current(entry: Entry): void {
    this.open();
    if (
      knowledgeHash(this.checkBinding(entry.source.workspaceId)) !==
      knowledgeHash(entry.binding)
    )
      fail("COMMAND_JOB_SOURCE_STALE");
  }
  private original(original: object): Entry {
    this.open();
    if (!original || types.isProxy(original) || typeof original !== "object")
      fail("COMMAND_JOB_ORIGINAL_REQUIRED");
    const entry = this.originals.get(original);
    if (!entry || this.entries.get(entry.record.jobId) !== entry)
      fail("COMMAND_JOB_ORIGINAL_REQUIRED");
    this.current(entry);
    return entry;
  }
  private write(
    entry: Entry,
    update: Partial<
      Pick<
        OwnedCommandJobRecord,
        "state" | "groupPid" | "completion" | "errorCode"
      >
    >,
  ): void {
    this.current(entry);
    const { sha256: _sha256, ...before } = entry.record;
    const body = {
      ...before,
      ...update,
      revision: before.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const next = validateOwnedCommandJob(signJobData(body, 65536));
    this.engine.store.putOwnedCommandJob(
      next.source,
      next.jobId,
      before.revision,
      next as unknown as JsonObject,
    );
    entry.record = next;
  }
  beforeSpawn(context: ToolContext, prepared: PreparedTool): object {
    this.active();
    const owner = this.engine.coordinator.readOwnedCommandContext(
      context,
      "start",
    );
    if (owner.name !== "run_command") {
      const skipped = Object.freeze({});
      this.skipped.add(skipped);
      return skipped;
    }
    if (this.entries.size >= 128) fail("COMMAND_JOB_LIMIT");
    const binding = jobJson(this.checkBinding(owner.workspaceId)),
      input = jobJson(prepared.input, 65536) as {
        command: string;
        cwd: string;
        timeoutMs: number;
      };
    const { name: _name, ...identity } = owner;
    const source = signJobData(
      {
        ...identity,
        rootBindingSha256: knowledgeHash(binding),
        ownerEpoch: this.epoch,
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        preparedFingerprint: prepared.fingerprint,
        preparedSha256: knowledgeHash(prepared),
      },
      65536,
    );
    const jobId = ownedCommandJobId({
      runId: source.runId,
      toolCallId: source.toolCallId,
    });
    if (
      this.entries.has(jobId) ||
      this.engine.store.getOwnedCommandJob(source.workspaceId, jobId)
    )
      fail("COMMAND_JOB_ALREADY_ADMITTED");
    const now = new Date().toISOString(),
      record = validateOwnedCommandJob(
        signJobData(
          {
            version: 1 as const,
            jobId,
            revision: 1,
            source,
            state: "starting" as const,
            groupPid: null,
            completion: null,
            errorCode: null,
            createdAt: now,
            updatedAt: now,
          },
          65536,
        ),
      );
    const entry: Entry = {
      context,
      source,
      binding,
      ring: new CommandOutputRing(),
      record,
    };
    this.engine.store.putOwnedCommandJob(
      source,
      jobId,
      0,
      record as unknown as JsonObject,
    );
    const original = Object.freeze({});
    this.originals.set(original, entry);
    this.entries.set(jobId, entry);
    return original;
  }
  started(original: object, groupPid: number): void {
    if (this.skipped.has(original)) return;
    const entry = this.original(original);
    this.engine.coordinator.readOwnedCommandContext(entry.context, "start");
    if (
      !Number.isSafeInteger(groupPid) ||
      groupPid <= 1 ||
      entry.record.state !== "starting"
    )
      fail("COMMAND_JOB_ADMISSION_INVALID");
    this.write(entry, { state: "running", groupPid });
  }
  output(original: object, stream: CommandOutputStream, bytes: Buffer): void {
    if (this.skipped.has(original)) return;
    const entry = this.original(original);
    if (entry.record.state !== "running") fail("COMMAND_JOB_OUTPUT_STALE");
    entry.ring.push(stream, bytes);
  }
  private artifacts(
    completion: Pick<CommandExecutionCompletion, "stdout" | "stderr">,
  ): void {
    for (const value of [completion.stdout, completion.stderr]) {
      const descriptor = validateCommandArtifactDescriptor(value),
        path = descriptor.path,
        before = lstatSync(path, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        realpathSync(path) !== path
      )
        fail("COMMAND_JOB_ARTIFACT_STALE");
      const fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = fstatSync(fd, { bigint: true });
        for (const st of [before, opened])
          if (
            st.dev.toString() !== descriptor.device ||
            st.ino.toString() !== descriptor.inode ||
            Number(st.size) !== descriptor.size ||
            st.mtimeNs.toString() !== descriptor.mtimeNs
          )
            fail("COMMAND_JOB_ARTIFACT_STALE");
        const hash = createHash("sha256"),
          buffer = Buffer.alloc(65536);
        let offset = 0;
        while (offset < descriptor.size) {
          const n = readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, descriptor.size - offset),
            offset,
          );
          if (!n) fail("COMMAND_JOB_ARTIFACT_STALE");
          hash.update(buffer.subarray(0, n));
          offset += n;
        }
        const after = fstatSync(fd, { bigint: true }),
          named = lstatSync(path, { bigint: true });
        if (
          hash.digest("hex") !== descriptor.sha256 ||
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeNs !== opened.mtimeNs ||
          named.dev !== opened.dev ||
          named.ino !== opened.ino ||
          named.size !== opened.size ||
          named.mtimeNs !== opened.mtimeNs
        )
          fail("COMMAND_JOB_ARTIFACT_STALE");
      } finally {
        closeSync(fd);
      }
    }
  }
  closed(original: object, value: CommandExecutionCompletion): void {
    if (this.skipped.delete(original)) return;
    const entry = this.original(original);
    this.engine.coordinator.readOwnedCommandContext(entry.context, "settle");
    entry.ring.end("stdout");
    entry.ring.end("stderr");
    this.artifacts(value);
    const checkpoint = value.checkpoint,
      summary: OwnedCommandCompletion = jobJson({
        outcome: value.outcome,
        stdout: value.stdout,
        stderr: value.stderr,
        checkpoint: {
          id: checkpoint.id,
          runId: checkpoint.runId,
          toolCallId: checkpoint.toolCallId!,
          kind: "command",
          createdAt: checkpoint.createdAt,
          incomplete: checkpoint.incomplete === true,
          sha256: knowledgeHash(checkpoint),
        },
        ...(value.observationFailure
          ? { observationFailure: value.observationFailure }
          : {}),
      });
    this.write(entry, {
      state:
        value.observationFailure || !value.outcome.cleanupConfirmed
          ? "uncertain"
          : "settling",
      completion: summary,
      errorCode: value.observationFailure
        ? "COMMAND_JOB_OBSERVATION_FAILED"
        : !value.outcome.cleanupConfirmed
          ? "COMMAND_JOB_CLEANUP_UNCERTAIN"
          : null,
    });
  }
  failed(original: object, error: unknown): void {
    if (this.skipped.delete(original)) return;
    const entry = this.original(original);
    if (
      ["completed", "failed", "cancelled", "paused-import"].includes(
        entry.record.state,
      )
    )
      return;
    this.write(entry, {
      state: "uncertain",
      errorCode:
        error instanceof EngineError
          ? error.code
          : "COMMAND_JOB_OBSERVATION_FAILED",
    });
  }
  toolSettled(tool: ToolCallRecord): void {
    const entry = [...this.entries.values()].find(
      (value) =>
        value.source.toolCallId === tool.id &&
        value.source.runId === tool.runId,
    );
    if (
      !entry ||
      !["starting", "running", "settling"].includes(entry.record.state)
    )
      return;
    try {
      if (tool.state === "interrupted") {
        const completion = entry.record.completion;
        if (
          process.platform === "win32" &&
          entry.record.state === "settling" &&
          completion?.outcome.cleanupConfirmed === true &&
          (completion.outcome.cancelled || completion.outcome.timedOut) &&
          !completion.observationFailure
        ) {
          // write() validates the exact approval/source, physical closed receipt,
          // checkpoint, sealed artifacts and now-interrupted native Tool/Part.
          this.artifacts(completion);
          this.write(entry, { state: "cancelled", errorCode: null });
          return;
        }
        this.write(entry, {
          state: "uncertain",
          errorCode: "COMMAND_JOB_NATIVE_RESULT_UNCERTAIN",
        });
        return;
      }
      if (entry.record.state !== "settling") return;
      const completion = entry.record.completion!;
      const state =
        completion.outcome.cancelled || completion.outcome.timedOut
          ? "cancelled"
          : tool.state === "completed" &&
              completion.outcome.exitCode === 0 &&
              !completion.outcome.error
            ? "completed"
            : "failed";
      this.write(entry, { state });
    } catch {
      // The actual Tool/Part has already settled. Do not write a second result
      // when the independent observation receipt cannot be committed.
      try {
        this.write(entry, {
          state: "uncertain",
          errorCode: "COMMAND_JOB_NATIVE_RESULT_UNCERTAIN",
        });
      } catch {
        /* Persistent journal faults remain unresolved until recovery. */
      }
      throw new EngineError(
        "CLEANUP_UNCERTAIN",
        "The actual command result could not settle its native job observation",
      );
    }
  }
  inspect(
    workspaceId: string,
    sessionId?: string,
  ): readonly OwnedCommandJobRecord[] {
    this.open();
    return this.engine.store.inspectOwnedCommandJobs(workspaceId, sessionId);
  }
  get(workspaceId: string, jobId: string): OwnedCommandJobRecord | undefined {
    this.open();
    return this.engine.store.getOwnedCommandJob(workspaceId, jobId);
  }
  /** Only a genuine current Root observation can issue a settled-source capability. */
  captureSettledSource(input: { workspaceId: string; jobId: string }): object {
    this.active();
    jobHostRecord(input, ["workspaceId", "jobId"]);
    const data = jobJson(input),
      entry = this.entries.get(data.jobId);
    if (!entry || entry.source.workspaceId !== data.workspaceId)
      fail("COMMAND_JOB_SOURCE_UNAVAILABLE");
    if (this.settledHandles.size >= 128) fail("COMMAND_JOB_LIMIT");
    this.assertSettledEntry(entry, entry.record.sha256);
    const original = Object.freeze({});
    this.settledSources.set(original, { entry, sha256: entry.record.sha256 });
    this.settledHandles.add(original);
    return original;
  }
  private assertSettledEntry(
    entry: Entry,
    expected: string,
  ): OwnedCommandJobRecord {
    this.active();
    this.current(entry);
    const record = this.engine.store.getOwnedCommandJob(
      entry.source.workspaceId,
      entry.record.jobId,
    );
    const run = this.engine.store.getRun(entry.source.runId);
    if (
      !record ||
      record.sha256 !== expected ||
      record.sha256 !== entry.record.sha256 ||
      record.source.ownerEpoch !== this.epoch ||
      !isTerminal(run.state) ||
      !["completed", "failed", "cancelled"].includes(record.state) ||
      record.completion?.outcome.cleanupConfirmed !== true ||
      Object.hasOwn(record.completion, "observationFailure")
    )
      fail("OWNED_COMMAND_NOT_SETTLED");
    this.engine.coordinator.assertWorkspaceCleanupConfirmed(
      entry.source.workspaceId,
    );
    this.artifacts(record.completion);
    return record;
  }
  readSettledSource(original: object): OwnedCommandJobRecord {
    this.active();
    if (
      !original ||
      types.isProxy(original) ||
      !this.settledHandles.has(original)
    )
      fail("COMMAND_JOB_ORIGINAL_REQUIRED");
    const source = this.settledSources.get(original);
    if (!source) fail("COMMAND_JOB_ORIGINAL_REQUIRED");
    return structuredClone(
      this.assertSettledEntry(source.entry, source.sha256),
    );
  }
  captureOutput(input: { workspaceId: string; jobId: string }): object {
    this.active();
    jobHostRecord(input, ["workspaceId", "jobId"]);
    const selection = jobJson(input);
    jobIdentifier(selection.workspaceId);
    jobIdentifier(selection.jobId);
    const entry = this.entries.get(selection.jobId);
    if (!entry || entry.source.workspaceId !== selection.workspaceId)
      fail("COMMAND_JOB_SOURCE_UNAVAILABLE");
    this.current(entry);
    if (entry.record.completion) this.artifacts(entry.record.completion);
    const data = structuredClone(entry.ring.snapshot()),
      bytes = Buffer.byteLength(JSON.stringify(data));
    if (this.handles.size >= 32 || bytes > 16_777_216 - this.snapshotBytes)
      fail("COMMAND_JOB_SNAPSHOT_LIMIT");
    const original = Object.freeze({});
    this.snapshots.set(original, {
      entry,
      data,
      sha256: knowledgeHash(data),
      bytes,
    });
    this.handles.add(original);
    this.snapshotBytes += bytes;
    return original;
  }
  readOutput(
    original: object,
    input: { afterSeq?: number; maxBytes?: number } = {},
  ): OwnedCommandOutputPage {
    this.open();
    if (!original || types.isProxy(original))
      fail("COMMAND_JOB_ORIGINAL_REQUIRED");
    const capture = this.snapshots.get(original);
    if (!capture || !this.handles.has(original))
      fail("COMMAND_JOB_ORIGINAL_REQUIRED");
    this.current(capture.entry);
    jobHostRecord(input, [], ["afterSeq", "maxBytes"]);
    const selection = jobJson(input),
      afterSeq = selection.afterSeq ?? 0,
      maxBytes = selection.maxBytes ?? 65536,
      snapshot = capture.data;
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      afterSeq > snapshot.outputSeq ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 16384 ||
      maxBytes > 65536
    )
      fail("COMMAND_JOB_OUTPUT_CURSOR_INVALID");
    const gap =
      afterSeq + 1 < snapshot.oldestSeq
        ? {
            fromSeq: afterSeq + 1,
            toSeq: snapshot.oldestSeq - 1,
            oldestSeq: snapshot.oldestSeq,
          }
        : null;
    const output: CommandOutputRingSnapshot["output"][number][] = [];
    let rawBytes = 0,
      nextAfterSeq = gap ? snapshot.oldestSeq - 1 : afterSeq;
    for (const item of snapshot.output)
      if (item.seq > nextAfterSeq) {
        if (
          item.bytes > maxBytes - rawBytes ||
          output.length >= 64 ||
          Buffer.byteLength(JSON.stringify([...output, item])) > 245760
        )
          break;
        output.push(item);
        rawBytes += item.bytes;
        nextAfterSeq = item.seq;
      }
    return signJobData(
      {
        version: 1 as const,
        jobId: capture.entry.record.jobId,
        sourceSha256: capture.entry.source.sha256,
        snapshotSha256: capture.sha256,
        throughSeq: snapshot.outputSeq,
        oldestSeq: snapshot.oldestSeq,
        observedBytes: snapshot.observedBytes,
        retainedBytes: snapshot.retainedBytes,
        output,
        nextAfterSeq,
        gap,
        hasMore: nextAfterSeq < snapshot.outputSeq,
        rawBytes,
      },
      262144,
    );
  }
  release(original: object): void {
    if (this.settledHandles.delete(original))
      this.settledSources.delete(original);
    const capture = this.snapshots.get(original);
    if (capture) {
      this.snapshotBytes -= capture.bytes;
      this.snapshots.delete(original);
      this.handles.delete(original);
    }
  }
  cancel(input: {
    workspaceId: string;
    jobId: string;
    expectedRevision: number;
    requestId: string;
  }): Promise<Run> {
    this.active();
    jobHostRecord(input, [
      "workspaceId",
      "jobId",
      "expectedRevision",
      "requestId",
    ]);
    const value = jobJson(input);
    jobIdentifier(value.requestId);
    const entry = this.entries.get(value.jobId);
    if (!entry || entry.source.workspaceId !== value.workspaceId)
      fail("COMMAND_JOB_SOURCE_UNAVAILABLE");
    this.current(entry);
    const key = knowledgeHash([value.workspaceId, value.requestId]),
      sha256 = knowledgeHash(value),
      prior = this.cancellations.get(key);
    if (prior) {
      if (prior.sha256 !== sha256) fail("COMMAND_JOB_REQUEST_CONFLICT");
      return prior.result.then((run) => structuredClone(run));
    }
    if (
      !Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision !== entry.record.revision ||
      !["starting", "running"].includes(entry.record.state)
    )
      fail("COMMAND_JOB_REVISION_CONFLICT");
    if (this.cancellations.size >= 128) fail("COMMAND_JOB_LIMIT");
    this.engine.coordinator.cancel(entry.source.runId);
    const result = this.engine.coordinator.waitForRun(entry.source.runId);
    this.cancellations.set(key, { sha256, result });
    return result.then((run) => structuredClone(run));
  }
  close(): void {
    for (const original of this.handles) this.release(original);
    for (const original of this.settledHandles) this.release(original);
    this.isClosed = true;
    this.entries.clear();
    this.cancellations.clear();
  }
}
