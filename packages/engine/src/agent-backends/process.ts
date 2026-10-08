import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineError } from "@moodcode/contracts";
import {
  immutableKnowledgeJson,
  knowledgeHash,
} from "../knowledge/validation.js";
import {
  cleanupGroup,
  createCommandEnvironment,
} from "../tools/command/process-control.js";
import type { TurnRequest } from "../ports.js";
import type { AcpV1Message, AgentBackendSpec } from "./types.js";
import { encodeAcpV1Message, parseAcpV1Message } from "./protocol.js";

/** Root authenticates the native Attempt and pins actual launch files and credentials. */
export interface BackendLaunchProof {
  workspaceId: string;
  backendId: string;
  backendSha256: string;
  backendRevisionId: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  executionLockPath: string;
  launchSha256: string;
  ownerSha256: string;
  sha256: string;
}
export interface BackendLaunchPort {
  captureLaunch(
    originalTurn: TurnRequest,
    spec: AgentBackendSpec,
    backendRevisionId: string,
  ): object;
  readLaunch(original: object): BackendLaunchProof;
  assertLaunchCurrent(original: object): void;
  releaseLaunch(original: object): void;
}
export interface BackendConnectionProof {
  workspaceId: string;
  backendId: string;
  backendRevisionId: string;
  backendSha256: string;
  connectionId: string;
  epoch: string;
  processId: number;
  birthNonce: string;
  launchSha256: string;
  ownerSha256: string;
  sha256: string;
}
export interface BackendPeerObservationProof {
  workspaceId: string;
  backendId: string;
  connectionId: string;
  epoch: string;
  receiveOrdinal: number;
  wireId: string | number | null;
  frameSha256: string;
  message: AcpV1Message;
  sha256: string;
}
export interface BackendWriteProof {
  workspaceId: string;
  backendId: string;
  connectionId: string;
  epoch: string;
  writeOrdinal: number;
  frameSha256: string;
  writtenBytes: number;
  sha256: string;
}
export interface BackendDisposalProof {
  workspaceId: string;
  backendId: string;
  connectionId: string;
  epoch: string;
  processId: number;
  cleanupConfirmed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sha256: string;
}

/** A trusted constructed producer owns every returned handle; structural copies confer no authority. */
export interface BackendProcessPort {
  launch(
    originalTurn: TurnRequest,
    spec: AgentBackendSpec,
    backendRevisionId: string,
    signal: AbortSignal,
  ): Promise<object>;
  readConnection(original: object): BackendConnectionProof;
  assertConnectionCurrent(original: object): void;
  frames(original: object, signal: AbortSignal): AsyncIterable<object>;
  readPeerObservation(original: object): BackendPeerObservationProof;
  releasePeerObservation(original: object): void;
  write(
    originalConnection: object,
    message: AcpV1Message,
    signal: AbortSignal,
  ): Promise<object>;
  readWrite(original: object): BackendWriteProof;
  releaseWrite(original: object): void;
  dispose(originalConnection: object): Promise<object>;
  readDisposal(original: object): BackendDisposalProof;
  releaseDisposal(original: object): void;
  close(): Promise<void>;
}

const MAX_FRAME = 65_536;
const MAX_BUFFERED_FRAMES = 64;
const MAX_RECEIVED_BYTES = 2_097_152;
const MAX_FRAMES = 4_096;
interface ProcessState {
  readonly handle: object;
  readonly launch: object;
  readonly child: ChildProcess;
  proof: BackendConnectionProof;
  readonly frames: object[];
  wake?: () => void;
  error?: EngineError;
  closePromise: Promise<void>;
  closed: boolean;
  consuming: boolean;
  disposing?: Promise<object>;
  outcome?: {
    cleanupConfirmed: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  };
  receiveOrdinal: number;
  writeOrdinal: number;
  receivedBytes: number;
  writeTail: Promise<void>;
  pendingWrite?: {
    ordinal: number;
    resolve(bytes: number): void;
    reject(error: EngineError): void;
  };
  removeAbort(): void;
}
function signed<T extends object>(body: T): T & { sha256: string } {
  return immutableKnowledgeJson({ ...body, sha256: knowledgeHash(body) });
}
function loaderArguments(): string[] {
  const options = [
    "--import",
    "--loader",
    "--experimental-loader",
    "--require",
    "-r",
    "--conditions",
  ];
  const result: string[] = [];
  const resolveLoader = (option: string, value: string): string => {
    if (option === "--conditions") return value;
    if (value.startsWith(".") || isAbsolute(value)) {
      const path = resolve(process.cwd(), value);
      return ["--require", "-r"].includes(option)
        ? path
        : pathToFileURL(path).href;
    }
    if (["--require", "-r"].includes(option))
      return createRequire(import.meta.url).resolve(value);
    return import.meta.resolve(value);
  };
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]!;
    if (options.includes(argument)) {
      const next = process.execArgv[++index];
      if (next !== undefined)
        result.push(argument, resolveLoader(argument, next));
    } else {
      const option = options.find((option) =>
        argument.startsWith(`${option}=`),
      );
      if (option)
        result.push(
          `${option}=${resolveLoader(option, argument.slice(option.length + 1))}`,
        );
    }
  }
  return [...result, "--no-warnings"];
}
async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    throw (
      signal.reason ??
      new EngineError("CANCELLED", "Backend operation cancelled")
    );
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(
        signal.reason ??
          new EngineError("CANCELLED", "Backend operation cancelled"),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Owned IPC supervisor; only Root's original launch producer can authorize spawn. */
export class OwnedBackendProcesses implements BackendProcessPort {
  private readonly connections = new WeakMap<object, ProcessState>();
  private readonly active = new Set<ProcessState>();
  private readonly attemptedTurns = new WeakSet<object>();
  private readonly observations = new WeakMap<
    object,
    BackendPeerObservationProof
  >();
  private readonly writes = new WeakMap<object, BackendWriteProof>();
  private readonly disposals = new WeakMap<object, BackendDisposalProof>();
  private closed = false;
  constructor(private readonly launches: BackendLaunchPort) {}

  async launch(
    originalTurn: TurnRequest,
    spec: AgentBackendSpec,
    backendRevisionId: string,
    signal: AbortSignal,
  ): Promise<object> {
    if (this.closed || signal.aborted)
      throw new EngineError(
        "BACKEND_CLOSED",
        "The owned backend process host is closed",
      );
    if (!["darwin", "linux", "freebsd"].includes(process.platform))
      throw new EngineError(
        "BACKEND_PLATFORM_UNSUPPORTED",
        "The backend requires owned POSIX process groups",
      );
    if (this.active.size >= 32)
      throw new EngineError(
        "BACKEND_PROCESS_LIMIT",
        "The owned backend process limit was reached",
      );
    const launch = this.launches.captureLaunch(
      originalTurn,
      spec,
      backendRevisionId,
    );
    if (this.attemptedTurns.has(originalTurn)) {
      this.launches.releaseLaunch(launch);
      throw new EngineError(
        "BACKEND_ATTEMPT_ALREADY_BOUND",
        "The native provider Attempt cannot launch another backend process",
      );
    }
    this.attemptedTurns.add(originalTurn);
    let child: ChildProcess | undefined;
    try {
      const actual = this.launches.readLaunch(launch);
      this.launches.assertLaunchCurrent(launch);
      if (
        actual.workspaceId !== spec.target.workspaceId ||
        actual.backendId !== spec.id ||
        actual.backendRevisionId !== backendRevisionId ||
        actual.backendSha256 !== spec.sha256 ||
        !isAbsolute(actual.command) ||
        !isAbsolute(actual.cwd) ||
        !isAbsolute(actual.executionLockPath)
      )
        throw new EngineError(
          "BACKEND_LAUNCH_STALE",
          "Actual launch pins do not match the registered backend",
        );
      const compiled = fileURLToPath(
        new URL("./process-supervisor.js", import.meta.url),
      );
      const source = fileURLToPath(
        new URL("./process-supervisor.ts", import.meta.url),
      );
      child = fork(existsSync(compiled) ? compiled : source, [], {
        cwd: actual.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        execPath: process.execPath,
        execArgv: loaderArguments(),
        env: { ...createCommandEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
      });
      let started!: (pid: number) => void,
        failed!: (error: EngineError) => void,
        resolveClosed!: () => void;
      const startedPromise = new Promise<number>((resolve, reject) => {
        started = resolve;
        failed = reject;
      });
      const closePromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const handle = Object.freeze({
        kind: "backend-process",
        id: randomUUID(),
      });
      const proof = signed({
        workspaceId: actual.workspaceId,
        backendId: actual.backendId,
        backendRevisionId,
        backendSha256: actual.backendSha256,
        connectionId: randomUUID(),
        epoch: randomUUID(),
        processId: 0,
        birthNonce: randomUUID(),
        launchSha256: actual.launchSha256,
        ownerSha256: actual.ownerSha256,
      });
      const state: ProcessState = {
        handle,
        launch,
        child,
        proof,
        frames: [],
        closePromise,
        closed: false,
        consuming: false,
        receiveOrdinal: 0,
        writeOrdinal: 0,
        receivedBytes: 0,
        writeTail: Promise.resolve(),
        removeAbort: () => {},
      };
      this.connections.set(handle, state);
      this.active.add(state);
      const fail = (code: string): void => {
        state.error ??= new EngineError(
          code,
          "The owned backend transport did not complete its protocol",
        );
        failed(state.error);
        state.pendingWrite?.reject(state.error);
        state.wake?.();
      };
      let buffer = Buffer.alloc(0);
      child.stdout?.on("data", (bytes: Buffer) => {
        if (state.disposing) return;
        try {
          state.receivedBytes += bytes.length;
          if (state.receivedBytes > MAX_RECEIVED_BYTES)
            throw new EngineError(
              "BACKEND_FRAME_LIMIT",
              "Backend output exceeded the transport budget",
            );
          let offset = 0;
          while (offset < bytes.length) {
            const newline = bytes.indexOf(10, offset);
            const end = newline < 0 ? bytes.length : newline;
            if (buffer.length + end - offset > MAX_FRAME)
              throw new EngineError(
                "BACKEND_FRAME_LIMIT",
                "Backend JSON-RPC frame exceeded its byte limit",
              );
            buffer = Buffer.concat([buffer, bytes.subarray(offset, end)]);
            offset = newline < 0 ? bytes.length : newline + 1;
            if (newline < 0) break;
            if (
              state.frames.length >= MAX_BUFFERED_FRAMES ||
              state.receiveOrdinal >= MAX_FRAMES
            )
              throw new EngineError(
                "BACKEND_FRAME_LIMIT",
                "Backend receive queue exceeded its limit",
              );
            const content =
              buffer.at(-1) === 13 ? buffer.subarray(0, -1) : buffer;
            if (
              !content.length ||
              !Buffer.from(content.toString("utf8")).equals(content)
            )
              throw new EngineError(
                "ACP_INVALID_MESSAGE",
                "Backend frames must contain strict UTF-8 JSON",
              );
            const message = parseAcpV1Message(content.toString("utf8"));
            const original = Object.freeze({
              kind: "backend-frame",
              ordinal: ++state.receiveOrdinal,
            });
            const frame = signed({
              workspaceId: state.proof.workspaceId,
              backendId: state.proof.backendId,
              connectionId: state.proof.connectionId,
              epoch: state.proof.epoch,
              receiveOrdinal: state.receiveOrdinal,
              wireId: "id" in message ? message.id : null,
              frameSha256: knowledgeHash(message),
              message,
            });
            this.observations.set(original, frame);
            state.frames.push(original);
            buffer = Buffer.alloc(0);
            state.wake?.();
          }
        } catch (error) {
          fail(
            error instanceof EngineError ? error.code : "ACP_INVALID_MESSAGE",
          );
          void this.dispose(handle).catch(() => {});
        }
      });
      child.stdout?.once("end", () => {
        if (!state.disposing)
          fail(
            buffer.length ? "BACKEND_FRAME_INCOMPLETE" : "BACKEND_DISCONNECTED",
          );
      });
      child.stderr?.on("data", () => {});
      child.stdout?.on("error", () => fail("BACKEND_DISCONNECTED"));
      child.stderr?.on("error", () => fail("BACKEND_DISCONNECTED"));
      child.on("error", () => fail("BACKEND_PROCESS_START_FAILED"));
      child.once("close", () => {
        state.closed = true;
        fail("BACKEND_DISCONNECTED");
        resolveClosed();
      });
      child.on("message", (packet: unknown) => {
        if (!packet || typeof packet !== "object") return;
        const value = packet as Record<string, unknown>;
        if (
          value.type === "started" &&
          Number.isSafeInteger(value.pid) &&
          Number(value.pid) > 0
        )
          started(Number(value.pid));
        else if (value.type === "failure")
          fail(
            typeof value.code === "string"
              ? value.code
              : "BACKEND_DISCONNECTED",
          );
        else if (value.type === "written") {
          const pending = state.pendingWrite;
          if (
            !pending ||
            value.ordinal !== pending.ordinal ||
            !Number.isSafeInteger(value.bytes)
          )
            fail("BACKEND_PIPE_WRITE_FAILED");
          else {
            state.pendingWrite = undefined;
            pending.resolve(Number(value.bytes));
          }
        } else if (
          value.type === "result" &&
          typeof value.cleanupConfirmed === "boolean"
        ) {
          state.outcome = {
            cleanupConfirmed: value.cleanupConfirmed,
            exitCode:
              typeof value.exitCode === "number" ? value.exitCode : null,
            signal:
              typeof value.signal === "string"
                ? (value.signal as NodeJS.Signals)
                : null,
          };
        }
      });
      const cancel = (): void => {
        void this.dispose(handle).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      state.removeAbort = () => signal.removeEventListener("abort", cancel);
      this.send(state, {
        type: "init",
        launch: {
          command: actual.command,
          args: [...actual.args],
          cwd: actual.cwd,
          env: { ...actual.env },
          executionLockPath: actual.executionLockPath,
        },
      });
      const pid = await abortable(
        startedPromise,
        AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      );
      this.launches.assertLaunchCurrent(launch);
      const { sha256: _placeholder, ...birth } = proof;
      state.proof = signed({ ...birth, processId: pid });
      if (state.disposing || signal.aborted || this.closed)
        throw new EngineError(
          "BACKEND_CLOSED",
          "Backend launch was cancelled before admission",
        );
      return handle;
    } catch (error) {
      const state = [...this.active].find((item) => item.launch === launch);
      if (state) {
        const disposal = await this.dispose(state.handle);
        const confirmed = this.readDisposal(disposal).cleanupConfirmed;
        this.releaseDisposal(disposal);
        if (!confirmed)
          throw new EngineError(
            "CLEANUP_UNCERTAIN",
            "The failed backend launch did not confirm process cleanup",
          );
      } else {
        child?.kill("SIGTERM");
        this.launches.releaseLaunch(launch);
      }
      throw error;
    }
  }
  private state(original: object): ProcessState {
    const state = this.connections.get(original);
    if (!state)
      throw new EngineError(
        "BACKEND_ORIGINAL_REQUIRED",
        "The backend handle is foreign or copied",
      );
    return state;
  }
  private send(state: ProcessState, packet: object): void {
    if (!state.child.connected)
      throw new EngineError(
        "BACKEND_DISCONNECTED",
        "The owned supervisor IPC channel is closed",
      );
    state.child.send(packet, (error) => {
      if (error) {
        state.error ??= new EngineError(
          "BACKEND_DISCONNECTED",
          "The owned supervisor IPC write failed",
        );
        state.pendingWrite?.reject(state.error);
        state.wake?.();
      }
    });
  }
  readConnection(original: object): BackendConnectionProof {
    return immutableKnowledgeJson(this.state(original).proof);
  }
  assertConnectionCurrent(original: object): void {
    const state = this.state(original);
    if (state.disposing || state.closed || state.error || this.closed)
      throw (
        state.error ??
        new EngineError(
          "BACKEND_DISCONNECTED",
          "The backend process is no longer current",
        )
      );
    this.launches.assertLaunchCurrent(state.launch);
  }
  async *frames(original: object, signal: AbortSignal): AsyncGenerator<object> {
    const state = this.state(original);
    if (state.consuming)
      throw new EngineError(
        "BACKEND_FRAME_CONSUMER_EXISTS",
        "Only one owner may consume backend frames",
      );
    state.consuming = true;
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        if (state.frames.length) {
          yield state.frames.shift()!;
          continue;
        }
        if (state.error || state.closed || state.disposing)
          throw (
            state.error ??
            new EngineError("BACKEND_DISCONNECTED", "Backend output closed")
          );
        await abortable(
          new Promise<void>((resolve) => {
            state.wake = resolve;
          }),
          signal,
        );
        state.wake = undefined;
      }
    } finally {
      state.consuming = false;
      state.wake = undefined;
    }
  }
  readPeerObservation(original: object): BackendPeerObservationProof {
    const proof = this.observations.get(original);
    if (!proof)
      throw new EngineError(
        "BACKEND_ORIGINAL_REQUIRED",
        "The backend frame is foreign or released",
      );
    return immutableKnowledgeJson(proof);
  }
  releasePeerObservation(original: object): void {
    this.observations.delete(original);
  }
  async write(
    originalConnection: object,
    message: AcpV1Message,
    signal: AbortSignal,
  ): Promise<object> {
    const state = this.state(originalConnection);
    const text = encodeAcpV1Message(message);
    let release!: () => void;
    const previous = state.writeTail;
    state.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await abortable(previous, signal);
      this.assertConnectionCurrent(originalConnection);
      if (signal.aborted) throw signal.reason;
      const ordinal = ++state.writeOrdinal;
      const operation = new Promise<number>((resolve, reject) => {
        state.pendingWrite = { ordinal, resolve, reject };
      });
      this.send(state, { type: "write", ordinal, text });
      const bytes = await abortable(operation, signal);
      if (bytes !== Buffer.byteLength(text))
        throw new EngineError(
          "BACKEND_PIPE_WRITE_FAILED",
          "The backend write receipt did not cover the complete frame",
        );
      const handle = Object.freeze({ kind: "backend-write", ordinal });
      this.writes.set(
        handle,
        signed({
          workspaceId: state.proof.workspaceId,
          backendId: state.proof.backendId,
          connectionId: state.proof.connectionId,
          epoch: state.proof.epoch,
          writeOrdinal: ordinal,
          frameSha256: knowledgeHash(parseAcpV1Message(text.slice(0, -1))),
          writtenBytes: bytes,
        }),
      );
      return handle;
    } finally {
      release();
    }
  }
  readWrite(original: object): BackendWriteProof {
    const proof = this.writes.get(original);
    if (!proof)
      throw new EngineError(
        "BACKEND_ORIGINAL_REQUIRED",
        "The backend write is foreign or released",
      );
    return immutableKnowledgeJson(proof);
  }
  releaseWrite(original: object): void {
    this.writes.delete(original);
  }
  dispose(originalConnection: object): Promise<object> {
    const state = this.state(originalConnection);
    return (state.disposing ??= (async () => {
      state.removeAbort();
      state.wake?.();
      if (!state.closed) {
        try {
          this.send(state, { type: "stop" });
        } catch {
          /* Native cleanup observation follows. */
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          state.closePromise,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 3_000);
          }),
        ]);
        clearTimeout(timeout);
      }
      let confirmed = state.outcome?.cleanupConfirmed === true && state.closed;
      if (!confirmed && state.proof.processId > 0) {
        // The original peer can outlive a killed supervisor. Terminate its
        // actual group, but missing lock-release evidence remains uncertainty.
        try {
          await cleanupGroup(state.proof.processId);
        } catch {
          /* Persist uncertainty below. */
        }
      }
      if (!state.closed) {
        state.child.kill("SIGTERM");
        await Promise.race([
          state.closePromise,
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
        if (!state.closed) state.child.kill("SIGKILL");
        confirmed = state.outcome?.cleanupConfirmed === true && state.closed;
      }
      this.active.delete(state);
      this.launches.releaseLaunch(state.launch);
      for (const frame of state.frames) this.observations.delete(frame);
      state.frames.length = 0;
      const handle = Object.freeze({
        kind: "backend-disposal",
        id: state.proof.connectionId,
      });
      this.disposals.set(
        handle,
        signed({
          workspaceId: state.proof.workspaceId,
          backendId: state.proof.backendId,
          connectionId: state.proof.connectionId,
          epoch: state.proof.epoch,
          processId: state.proof.processId,
          cleanupConfirmed: confirmed,
          exitCode: state.outcome?.exitCode ?? null,
          signal: state.outcome?.signal ?? null,
        }),
      );
      if (!state.closed) {
        state.child.stdout?.destroy();
        state.child.stderr?.destroy();
        state.child.unref();
      }
      return handle;
    })());
  }
  readDisposal(original: object): BackendDisposalProof {
    const proof = this.disposals.get(original);
    if (!proof)
      throw new EngineError(
        "BACKEND_ORIGINAL_REQUIRED",
        "The backend disposal is foreign or released",
      );
    return immutableKnowledgeJson(proof);
  }
  releaseDisposal(original: object): void {
    this.disposals.delete(original);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(
      [...this.active].map((state) => this.dispose(state.handle)),
    );
  }
}
