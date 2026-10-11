import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { EngineError } from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "./types.js";
import type {
  FileParentPin,
  FilePhysicalObservation,
  FilePublicationCheckpoint,
} from "./file-publication-types.js";
import {
  assertKnowledgeSignal,
  exactKnowledgePath,
  identifier,
  immutableKnowledgeJson,
  knowledgeError as fail,
  knowledgeHostRecord,
  sameKnowledge as same,
  sha256,
  validateBinding,
} from "./validation.js";

/** Descriptive fields grant no authority; only the issuing host retains its identity. */
export interface FileKnowledgePublicationCapture {
  readonly id: string;
}
export interface FileKnowledgeTargetCapture {
  readonly capture: FileKnowledgePublicationCapture;
  readonly observation: FilePhysicalObservation;
  readonly beforeContent: string | null;
  readonly revision: number;
}
export interface FileKnowledgePublicationApplyResult {
  readonly state: "applied" | "uncertain";
  readonly after: FilePhysicalObservation | null;
  readonly checkpoint: FilePublicationCheckpoint;
  readonly cleanupConfirmed: boolean;
  readonly errorCode?: string;
}
export interface FileKnowledgePublicationApplyInput {
  readonly operation: "publish" | "revoke";
  readonly body: string;
  readonly publicationId: string;
  readonly signal?: AbortSignal;
  readonly deadline: number;
  /** Must durably dispatch the exact approved native owner BEFORE any file effect. */
  readonly beforeEffect: () => void | Promise<void>;
}
export interface FileKnowledgePublicationHostPorts {
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
  readonly readTargetRevision: (
    binding: KnowledgeHostBinding,
    path: string,
  ) => number;
  /** Root injects the real common execution lock. This module invents no process/Run owner. */
  readonly acquireExecutionGuard: (
    binding: KnowledgeHostBinding,
    publicationId: string,
  ) => { release(cleanupConfirmed: boolean): void };
}
interface CaptureState {
  readonly observation: FilePhysicalObservation;
  readonly revision: number;
  readonly signal?: AbortSignal;
  used: boolean;
}
const MAX_BODY = 16_384,
  MAX_CAPTURES = 128;
function check(signal?: AbortSignal, deadline?: number): void {
  if (signal?.aborted)
    fail("KNOWLEDGE_FILE_CANCELLED", "File publication was cancelled");
  if (deadline !== undefined && Date.now() >= deadline)
    fail(
      "KNOWLEDGE_FILE_DEADLINE",
      "Original file publication deadline expired",
    );
}
function metadata(value: BigIntStats) {
  return {
    device: value.dev.toString(),
    inode: value.ino.toString(),
    mode: Number(value.mode & 0o777n),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
  };
}
function stable(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function ordinary(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  knowledgeHostRecord(
    value,
    required,
    optional,
    "INVALID_KNOWLEDGE_FILE",
    "File publication input must be plain data",
    "File publication input cannot contain unknown fields or accessors",
  );
}
function actualSignal(signal?: AbortSignal): void {
  if (signal !== undefined)
    assertKnowledgeSignal(
      signal,
      "INVALID_KNOWLEDGE_FILE",
      "File publication needs an actual AbortSignal",
      "File cancellation observations cannot be overridden",
    );
}

/** Actual physical file executor; root paths and parent components are checked without following links. */
export class FileKnowledgePublicationHost {
  readonly #ports: FileKnowledgePublicationHostPorts;
  readonly #captures = new WeakMap<object, CaptureState>();
  readonly #active = new Set<object>();
  #capturing = 0;
  constructor(ports: FileKnowledgePublicationHostPorts) {
    ordinary(ports, [
      "checkBinding",
      "readTargetRevision",
      "acquireExecutionGuard",
    ]);
    if (
      typeof ports.checkBinding !== "function" ||
      typeof ports.readTargetRevision !== "function" ||
      typeof ports.acquireExecutionGuard !== "function"
    )
      fail(
        "INVALID_KNOWLEDGE_FILE",
        "File host requires actual binding, native revision and execution guard ports",
      );
    this.#ports = Object.freeze({ ...ports });
  }
  private current(binding: KnowledgeHostBinding): void {
    if (
      !same(
        validateBinding(this.#ports.checkBinding(binding.workspaceId)),
        binding,
      )
    )
      fail(
        "KNOWLEDGE_BINDING_MISMATCH",
        "File publication host binding changed",
      );
  }
  private async root(binding: KnowledgeHostBinding): Promise<FileParentPin> {
    this.current(binding);
    const value = await lstat(binding.root, { bigint: true });
    if (
      !value.isDirectory() ||
      value.isSymbolicLink() ||
      value.dev.toString() !== binding.rootDevice ||
      value.ino.toString() !== binding.rootInode ||
      (await realpath(binding.root)) !== binding.root
    )
      fail(
        "KNOWLEDGE_BINDING_MISMATCH",
        "File publication requires the original canonical physical root",
      );
    this.current(binding);
    return Object.freeze({ path: ".", ...metadata(value) });
  }
  private revision(binding: KnowledgeHostBinding, relative: string): number {
    const value = this.#ports.readTargetRevision(binding, relative);
    if (!Number.isSafeInteger(value) || value < 0)
      fail(
        "INVALID_KNOWLEDGE_FILE",
        "Native file revision must be a nonnegative safe integer",
      );
    return value;
  }
  /** Raw physical read for the existing synchronous host target API. Never calls readTargetRevision. */
  observeTargetSync(
    inputBinding: KnowledgeHostBinding,
    inputPath: string,
  ): FilePhysicalObservation {
    const binding = validateBinding(inputBinding),
      relative = exactKnowledgePath(inputPath);
    this.current(binding);
    const physicalRoot = () => {
      const value = lstatSync(binding.root, { bigint: true });
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        value.dev.toString() !== binding.rootDevice ||
        value.ino.toString() !== binding.rootInode ||
        realpathSync(binding.root) !== binding.root
      )
        fail("KNOWLEDGE_BINDING_MISMATCH", "Physical file root changed");
      return { path: ".", ...metadata(value) };
    };
    const root = physicalRoot(),
      parentPins: FileParentPin[] = [root],
      missingParents: string[] = [],
      components = relative.split("/");
    let missing = false;
    if (components.length > 64)
      fail(
        "KNOWLEDGE_FILE_LIMIT",
        "File parent observations are bounded to 64 components",
      );
    for (let index = 1; index < components.length; index++) {
      const selected = components.slice(0, index).join("/"),
        absolute = path.join(binding.root, selected);
      if (missing) {
        missingParents.push(selected);
        continue;
      }
      try {
        const value = lstatSync(absolute, { bigint: true });
        if (
          !value.isDirectory() ||
          value.isSymbolicLink() ||
          realpathSync(absolute) !== absolute
        )
          fail(
            "KNOWLEDGE_FILE_UNSAFE",
            "File parent must be an ordinary canonical directory",
          );
        parentPins.push({ path: selected, ...metadata(value) });
      } catch (error) {
        if (!absent(error)) throw error;
        missing = true;
        missingParents.push(selected);
      }
    }
    const empty: FilePhysicalObservation = {
      binding,
      path: relative,
      present: false,
      sha256: null,
      bytes: 0,
      device: null,
      inode: null,
      mode: null,
      mtimeNs: null,
      ctimeNs: null,
      parentPins,
      missingParents,
    };
    let observation = empty;
    if (!missing) {
      const absolute = path.join(binding.root, relative);
      let initial: BigIntStats | undefined;
      try {
        initial = lstatSync(absolute, { bigint: true });
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (initial) {
        if (
          !initial.isFile() ||
          initial.isSymbolicLink() ||
          initial.nlink !== 1n ||
          initial.size > BigInt(MAX_BODY) ||
          realpathSync(absolute) !== absolute
        )
          fail(
            "KNOWLEDGE_FILE_UNSAFE",
            "File must be bounded ordinary single-link text",
          );
        const descriptor = openSync(
          absolute,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const before = fstatSync(descriptor, { bigint: true });
          if (!stable(initial, before))
            fail(
              "KNOWLEDGE_FILE_STALE",
              "File changed before descriptor opened",
            );
          const buffer = Buffer.alloc(MAX_BODY + 1);
          let bytes = 0;
          while (bytes < buffer.length) {
            const count = readSync(
              descriptor,
              buffer,
              bytes,
              buffer.length - bytes,
              bytes,
            );
            bytes += count;
            if (!count) break;
          }
          const after = fstatSync(descriptor, { bigint: true }),
            current = lstatSync(absolute, { bigint: true }),
            raw = buffer.subarray(0, bytes),
            body = raw.toString("utf8");
          if (
            bytes > MAX_BODY ||
            BigInt(bytes) !== after.size ||
            !stable(before, after) ||
            !stable(after, current) ||
            current.isSymbolicLink()
          )
            fail(
              "KNOWLEDGE_FILE_STALE",
              "File changed during physical observation",
            );
          if (!Buffer.from(body).equals(raw) || body.includes("\0"))
            fail(
              "KNOWLEDGE_FILE_UNSAFE",
              "File must contain complete plain UTF-8 text",
            );
          observation = {
            ...empty,
            present: true,
            sha256: sha256(body),
            bytes,
            ...metadata(after),
          };
        } finally {
          closeSync(descriptor);
        }
      }
    }
    this.current(binding);
    if (!same(root, physicalRoot()))
      fail("KNOWLEDGE_FILE_STALE", "Physical root changed during observation");
    for (const pin of parentPins.slice(1)) {
      const absolute = path.join(binding.root, pin.path),
        value = lstatSync(absolute, { bigint: true });
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        realpathSync(absolute) !== absolute ||
        !same(pin, { path: pin.path, ...metadata(value) })
      )
        fail(
          "KNOWLEDGE_FILE_STALE",
          "Physical parent changed during observation",
        );
    }
    return immutableKnowledgeJson(observation);
  }
  private async observe(
    binding: KnowledgeHostBinding,
    relative: string,
    signal?: AbortSignal,
  ): Promise<{
    observation: FilePhysicalObservation;
    beforeContent: string | null;
  }> {
    check(signal);
    const root = await this.root(binding),
      parentPins: FileParentPin[] = [root],
      missingParents: string[] = [];
    const components = relative.split("/");
    let missing = false;
    if (components.length > 64)
      fail(
        "KNOWLEDGE_FILE_LIMIT",
        "File parent observations are bounded to 64 components",
      );
    for (let index = 1; index < components.length; index++) {
      check(signal);
      const selected = components.slice(0, index).join("/"),
        absolute = path.join(binding.root, selected);
      if (missing) {
        missingParents.push(selected);
        continue;
      }
      try {
        const value = await lstat(absolute, { bigint: true });
        if (
          !value.isDirectory() ||
          value.isSymbolicLink() ||
          (await realpath(absolute)) !== absolute
        )
          fail(
            "KNOWLEDGE_FILE_UNSAFE",
            "File publication parent must be an ordinary canonical directory",
          );
        parentPins.push(Object.freeze({ path: selected, ...metadata(value) }));
      } catch (error) {
        if (!absent(error)) throw error;
        missing = true;
        missingParents.push(selected);
      }
    }
    const empty = {
      binding,
      path: relative,
      present: false,
      sha256: null,
      bytes: 0,
      device: null,
      inode: null,
      mode: null,
      mtimeNs: null,
      ctimeNs: null,
      parentPins,
      missingParents,
    };
    let beforeContent: string | null = null,
      observation: FilePhysicalObservation = empty;
    if (!missing) {
      const absolute = path.join(binding.root, relative);
      let initial: BigIntStats | undefined;
      try {
        initial = await lstat(absolute, { bigint: true });
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (initial) {
        if (
          !initial.isFile() ||
          initial.isSymbolicLink() ||
          initial.nlink !== 1n ||
          initial.size > BigInt(MAX_BODY) ||
          (await realpath(absolute)) !== absolute
        )
          fail(
            "KNOWLEDGE_FILE_UNSAFE",
            "File publication requires a bounded ordinary file with one link",
          );
        const handle = await open(
          absolute,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const before = await handle.stat({ bigint: true });
          if (!stable(initial, before))
            fail(
              "KNOWLEDGE_FILE_STALE",
              "File identity changed before descriptor observation",
            );
          const buffer = Buffer.alloc(MAX_BODY + 1);
          let bytes = 0;
          for (;;) {
            check(signal);
            const read = await handle.read(
              buffer,
              bytes,
              buffer.length - bytes,
              bytes,
            );
            bytes += read.bytesRead;
            if (!read.bytesRead || bytes === buffer.length) break;
          }
          const after = await handle.stat({ bigint: true }),
            current = await lstat(absolute, { bigint: true });
          if (
            bytes > MAX_BODY ||
            BigInt(bytes) !== after.size ||
            !stable(before, after) ||
            !stable(after, current) ||
            current.isSymbolicLink()
          )
            fail(
              "KNOWLEDGE_FILE_STALE",
              "File changed during bounded descriptor observation",
            );
          const raw = buffer.subarray(0, bytes),
            body = raw.toString("utf8");
          if (!Buffer.from(body).equals(raw) || body.includes("\0"))
            fail(
              "KNOWLEDGE_FILE_UNSAFE",
              "File publication requires complete plain UTF-8 text",
            );
          beforeContent = body;
          observation = {
            ...empty,
            present: true,
            sha256: sha256(body),
            bytes,
            ...metadata(after),
          };
        } finally {
          await handle.close();
        }
      }
    }
    check(signal);
    const endRoot = await this.root(binding);
    if (!same(root, endRoot))
      fail("KNOWLEDGE_FILE_STALE", "Root changed during capture");
    for (const pin of parentPins.slice(1)) {
      const value = await lstat(path.join(binding.root, pin.path), {
        bigint: true,
      });
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        !same(pin, { path: pin.path, ...metadata(value) })
      )
        fail("KNOWLEDGE_FILE_STALE", "Parent changed during capture");
    }
    return { observation: immutableKnowledgeJson(observation), beforeContent };
  }
  async captureTarget(
    inputBinding: KnowledgeHostBinding,
    inputPath: string,
    signal?: AbortSignal,
  ): Promise<FileKnowledgeTargetCapture> {
    const binding = validateBinding(inputBinding),
      relative = exactKnowledgePath(inputPath);
    actualSignal(signal);
    check(signal);
    if (this.#active.size + this.#capturing >= MAX_CAPTURES)
      fail(
        "KNOWLEDGE_FILE_LIMIT",
        "Release old file captures before preparing more",
      );
    this.#capturing++;
    try {
      const revision = this.revision(binding, relative),
        observed = await this.observe(binding, relative, signal);
      check(signal);
      if (this.revision(binding, relative) !== revision)
        fail(
          "KNOWLEDGE_FILE_STALE",
          "Native target revision changed during capture",
        );
      const capture = Object.freeze({ id: randomUUID() });
      this.#captures.set(capture, {
        observation: observed.observation,
        revision,
        ...(signal ? { signal } : {}),
        used: false,
      });
      this.#active.add(capture);
      return Object.freeze({ capture, ...observed, revision });
    } finally {
      this.#capturing--;
    }
  }
  private owned(capture: FileKnowledgePublicationCapture): CaptureState {
    if (!capture || typeof capture !== "object" || !this.#active.has(capture))
      fail(
        "KNOWLEDGE_FILE_CAPTURE_INVALID",
        "File capture is foreign, copied, released or never issued",
      );
    return (
      this.#captures.get(capture) ??
      fail("KNOWLEDGE_FILE_CAPTURE_INVALID", "File capture has no host owner")
    );
  }
  async assertFresh(
    capture: FileKnowledgePublicationCapture,
    signal?: AbortSignal,
  ): Promise<void> {
    actualSignal(signal);
    const state = this.owned(capture);
    if (state.used)
      fail("KNOWLEDGE_FILE_CAPTURE_USED", "File capture was already consumed");
    check(state.signal);
    check(signal);
    const observed = await this.observe(
      state.observation.binding,
      state.observation.path,
      signal,
    );
    check(state.signal);
    check(signal);
    this.owned(capture);
    if (state.used)
      fail(
        "KNOWLEDGE_FILE_CAPTURE_USED",
        "Concurrent operation already consumed the file capture",
      );
    if (
      !same(observed.observation, state.observation) ||
      this.revision(state.observation.binding, state.observation.path) !==
        state.revision
    )
      fail(
        "KNOWLEDGE_FILE_STALE",
        "Original approved file, parent or native revision changed",
      );
  }
  releaseCapture(capture: FileKnowledgePublicationCapture): void {
    this.owned(capture);
    this.#active.delete(capture);
    this.#captures.delete(capture);
  }
  /**
   * Node has no portable openat/renameat compare-and-swap. Parent and preimage guards
   * narrow each effect boundary; the final hash check cannot detect an external edit
   * overwritten between the last preimage read and rename/unlink. New targets use
   * link(EXCL semantics), so an appeared destination is never overwritten.
   */
  async apply(
    capture: FileKnowledgePublicationCapture,
    input: FileKnowledgePublicationApplyInput,
  ): Promise<FileKnowledgePublicationApplyResult> {
    ordinary(
      input,
      ["operation", "body", "publicationId", "deadline", "beforeEffect"],
      ["signal"],
    );
    const data = immutableKnowledgeJson({
      operation: input.operation,
      body: input.body,
      publicationId: input.publicationId,
      deadline: input.deadline,
    });
    const beforeEffect = input.beforeEffect,
      signal = input.signal;
    actualSignal(signal);
    if (
      !["publish", "revoke"].includes(data.operation) ||
      typeof data.body !== "string" ||
      Buffer.byteLength(data.body) > MAX_BODY ||
      Buffer.from(data.body).toString("utf8") !== data.body ||
      data.body.includes("\0") ||
      (data.operation === "revoke" && data.body !== "") ||
      !Number.isSafeInteger(data.deadline) ||
      data.deadline < 0 ||
      typeof beforeEffect !== "function"
    )
      fail(
        "INVALID_KNOWLEDGE_FILE",
        "File effect must use one bounded exact operation and original deadline",
      );
    identifier(data.publicationId);
    check(signal, data.deadline);
    const state = this.owned(capture),
      original = state.observation,
      binding = original.binding,
      relative = original.path;
    if (data.operation === "revoke" && !original.present)
      fail(
        "KNOWLEDGE_FILE_STALE",
        "Revocation requires its original existing file",
      );
    if (
      original.missingParents.length &&
      !/^\.moodcode\/skills\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/SKILL\.md$/.test(
        relative,
      )
    )
      fail(
        "KNOWLEDGE_FILE_PARENT_UNSUPPORTED",
        "Only an explicit skill target may create missing parent directories",
      );
    await this.assertFresh(capture, signal);
    check(state.signal, data.deadline);
    check(signal, data.deadline);
    if (state.used)
      fail("KNOWLEDGE_FILE_CAPTURE_USED", "File capture already consumed");
    state.used = true;
    const guard = this.#ports.acquireExecutionGuard(
      binding,
      data.publicationId,
    );
    ordinary(guard, ["release"], ["recordGroup"]);
    if (typeof guard.release !== "function")
      fail(
        "INVALID_KNOWLEDGE_FILE",
        "Execution guard must expose original synchronous release",
      );
    const handles = new Set<Awaited<ReturnType<typeof open>>>(),
      effects = {
        createdParents: [] as string[],
        createdFiles: [] as string[],
        removedFiles: [] as string[],
        replacedFiles: [] as string[],
        partial: false,
      };
    const expected = new Map(original.parentPins.map((pin) => [pin.path, pin]));
    let dispatched = false,
      cleanupConfirmed = true,
      applied = false,
      after: FilePhysicalObservation | null = null,
      errorCode: string | undefined,
      temp: string | undefined,
      tempIdentity: { device: string; inode: string } | undefined;
    const parent = (selected: string) => {
      const value = path.posix.dirname(selected);
      return value === "." ? "." : value;
    };
    const absolute = (selected: string) =>
      selected === "." ? binding.root : path.join(binding.root, selected);
    const alive = () => {
      this.owned(capture);
      check(state.signal, data.deadline);
      check(signal, data.deadline);
      this.current(binding);
    };
    const directoryPin = async (selected: string): Promise<FileParentPin> => {
      const target = absolute(selected),
        value = await lstat(target, { bigint: true });
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        (await realpath(target)) !== target
      )
        fail(
          "KNOWLEDGE_FILE_UNSAFE",
          "File effect parent ceased to be an ordinary directory",
        );
      return { path: selected, ...metadata(value) };
    };
    const refresh = async (selected: string) => {
      this.current(binding);
      await this.root(binding);
      const next = await directoryPin(selected),
        old = expected.get(selected);
      if (
        old &&
        (old.device !== next.device ||
          old.inode !== next.inode ||
          old.mode !== next.mode)
      )
        fail(
          "KNOWLEDGE_FILE_STALE",
          "Parent physical identity changed across the owned effect",
        );
      expected.set(selected, next);
    };
    const directories = async () => {
      alive();
      await this.root(binding);
      for (const [selected, pin] of expected) {
        const actual = await directoryPin(selected);
        if (!same(pin, actual))
          fail(
            "KNOWLEDGE_FILE_STALE",
            "Parent changed before the next file effect",
          );
      }
      alive();
    };
    const target = async () => {
      const current = (await this.observe(binding, relative)).observation;
      const file = (v: FilePhysicalObservation) => ({
        present: v.present,
        sha256: v.sha256,
        bytes: v.bytes,
        device: v.device,
        inode: v.inode,
        mode: v.mode,
        mtimeNs: v.mtimeNs,
        ctimeNs: v.ctimeNs,
      });
      if (!same(file(current), file(original)))
        fail(
          "KNOWLEDGE_FILE_STALE",
          "Original file preimage changed before publication",
        );
      alive();
    };
    const close = async (handle: Awaited<ReturnType<typeof open>>) => {
      try {
        await handle.close();
        handles.delete(handle);
      } catch (error) {
        cleanupConfirmed = false;
        throw error;
      }
    };
    const syncDirectory = async () => {
      await directories();
      const handle = await open(
        absolute(parent(relative)),
        constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      handles.add(handle);
      try {
        const pin = expected.get(parent(relative))!,
          value = await handle.stat({ bigint: true });
        if (
          !value.isDirectory() ||
          value.dev.toString() !== pin.device ||
          value.ino.toString() !== pin.inode
        )
          fail(
            "KNOWLEDGE_FILE_STALE",
            "Directory descriptor belongs to another parent",
          );
        await handle.sync();
      } finally {
        await close(handle);
      }
    };
    try {
      alive();
      await beforeEffect();
      dispatched = true;
      alive();
      // Revalidate after the awaited durable intent callback, before any mkdir/open-write.
      await directories();
      await target();
      for (const selected of original.missingParents) {
        await directories();
        alive();
        await mkdir(absolute(selected), { mode: 0o700 });
        effects.createdParents.push(selected);
        await refresh(parent(selected));
        await refresh(selected);
        alive();
      }
      if (data.operation === "publish") {
        await directories();
        await target();
        alive();
        const selectedTemp = path.posix.join(
          parent(relative),
          `.moodcode-publication-${sha256(data.publicationId).slice(0, 16)}-${randomUUID()}.tmp`,
        );
        const handle = await open(
          absolute(selectedTemp),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0),
          original.mode ?? 0o600,
        );
        temp = selectedTemp;
        handles.add(handle);
        effects.createdFiles.push(selectedTemp);
        const initial = await handle.stat({ bigint: true });
        tempIdentity = {
          device: initial.dev.toString(),
          inode: initial.ino.toString(),
        };
        await handle.chmod(original.mode ?? 0o600);
        await refresh(parent(relative));
        const bytes = Buffer.from(data.body);
        let written = 0;
        try {
          while (written < bytes.length) {
            alive();
            const next = await handle.write(
              bytes,
              written,
              bytes.length - written,
              written,
            );
            if (!next.bytesWritten)
              fail(
                "KNOWLEDGE_FILE_WRITE_FAILED",
                "Owned file write made no progress",
              );
            written += next.bytesWritten;
          }
          alive();
          await handle.sync();
          const value = await handle.stat({ bigint: true });
          if (
            !value.isFile() ||
            value.nlink !== 1n ||
            value.size !== BigInt(bytes.length) ||
            value.dev !== initial.dev ||
            value.ino !== initial.ino
          )
            fail(
              "KNOWLEDGE_FILE_STALE",
              "Owned temporary file changed during write",
            );
        } finally {
          await close(handle);
        }
        await directories();
        await target();
        alive();
        if (original.present) {
          await rename(absolute(selectedTemp), absolute(relative));
          effects.removedFiles.push(selectedTemp);
          effects.replacedFiles.push(relative);
          temp = undefined;
        } else {
          await link(absolute(selectedTemp), absolute(relative));
          effects.createdFiles.push(relative);
          await refresh(parent(relative));
          alive();
          await unlink(absolute(selectedTemp));
          effects.removedFiles.push(selectedTemp);
          temp = undefined;
        }
        await refresh(parent(relative));
        await syncDirectory();
        alive();
        after = (await this.observe(binding, relative)).observation;
        if (
          !after.present ||
          after.sha256 !== sha256(data.body) ||
          after.bytes !== bytes.length ||
          after.device !== tempIdentity.device ||
          after.inode !== tempIdentity.inode
        )
          fail(
            "KNOWLEDGE_FILE_AFTERIMAGE_MISMATCH",
            "Actual publication afterimage differs from the owned written inode",
          );
      } else {
        await directories();
        await target();
        alive();
        await unlink(absolute(relative));
        effects.removedFiles.push(relative);
        await refresh(parent(relative));
        await syncDirectory();
        alive();
        after = (await this.observe(binding, relative)).observation;
        if (after.present)
          fail(
            "KNOWLEDGE_FILE_AFTERIMAGE_MISMATCH",
            "Revoked target is still present",
          );
      }
      alive();
      applied = true;
    } catch (error) {
      errorCode =
        error instanceof EngineError ? error.code : "KNOWLEDGE_FILE_IO_FAILED";
      if (!dispatched) throw error;
      effects.partial = true;
    } finally {
      for (const handle of handles) {
        try {
          await close(handle);
        } catch {
          cleanupConfirmed = false;
        }
      }
      if (temp && tempIdentity) {
        try {
          this.current(binding);
          await this.root(binding);
          for (const [selected, pin] of expected) {
            const actual = await directoryPin(selected);
            if (actual.device !== pin.device || actual.inode !== pin.inode)
              fail(
                "KNOWLEDGE_FILE_STALE",
                "Cleanup parent physical identity changed",
              );
          }
          const value = await lstat(absolute(temp), { bigint: true });
          if (
            !value.isFile() ||
            value.isSymbolicLink() ||
            value.dev.toString() !== tempIdentity.device ||
            value.ino.toString() !== tempIdentity.inode
          )
            fail(
              "KNOWLEDGE_FILE_STALE",
              "Temporary path no longer belongs to this effect",
            );
          await unlink(absolute(temp));
          effects.removedFiles.push(temp);
          temp = undefined;
        } catch {
          cleanupConfirmed = false;
          errorCode ??= "KNOWLEDGE_FILE_CLEANUP_UNCERTAIN";
          effects.partial = true;
        }
      } else if (temp) {
        cleanupConfirmed = false;
        errorCode ??= "KNOWLEDGE_FILE_CLEANUP_UNCERTAIN";
        effects.partial = true;
      }
      if (dispatched && !applied) {
        try {
          after = (await this.observe(binding, relative)).observation;
        } catch {
          after = null;
        }
      }
      try {
        guard.release(cleanupConfirmed);
      } catch {
        cleanupConfirmed = false;
        applied = false;
        errorCode = "KNOWLEDGE_FILE_CLEANUP_UNCERTAIN";
        effects.partial = true;
      }
      if (!dispatched && !cleanupConfirmed)
        fail(
          "KNOWLEDGE_FILE_CLEANUP_UNCERTAIN",
          "Execution guard release failed before dispatch",
        );
    }
    return immutableKnowledgeJson({
      state: applied && cleanupConfirmed ? "applied" : "uncertain",
      after,
      checkpoint: effects,
      cleanupConfirmed,
      ...(errorCode ? { errorCode } : {}),
    });
  }
}
