import { randomUUID } from "node:crypto";
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
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { EngineError } from "@moodcode/contracts";
import type { KnowledgeHostBinding } from "../knowledge/types.js";
import {
  exactKnowledgePath,
  knowledgeHash,
  validateBinding,
} from "../knowledge/validation.js";
import { sha256Hex } from "../shared/canonical.js";
import { assertNativeSignal, plainRecord } from "../shared/data.js";
import { PROPOSAL_LIMITS, validateProposalSourceManifest } from "./store.js";
import { addDisjointPath, trackPending } from "./validation.js";

const PROPOSAL_SOURCE_LIMITS = Object.freeze({
  files: PROPOSAL_LIMITS.files,
  fileBytes: PROPOSAL_LIMITS.fileBytes,
  totalBytes: PROPOSAL_LIMITS.totalBytes,
  manifestBytes: PROPOSAL_LIMITS.revisionBytes,
  depth: 64,
  handles: 256,
  durationMs: 5_000,
});
export interface ProposalSourceOperation {
  readonly path: string;
  readonly expectedSha256: string | null;
  readonly after: string | null;
}
export interface ProposalPhysicalPin {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}
export interface ProposalSourceFilePin {
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly beforeBytes: number;
  readonly afterSha256: string | null;
  readonly afterBytes: number;
  readonly device: string | null;
  readonly inode: string | null;
  readonly mode: number | null;
  readonly mtimeNs: string | null;
  readonly ctimeNs: string | null;
  readonly parentPins: readonly ProposalPhysicalPin[];
  readonly missingParents: readonly string[];
}
export interface ProposalSourceManifest {
  readonly projection: "proposal-selected-files-v1";
  readonly rootPin: ProposalPhysicalPin;
  readonly files: readonly ProposalSourceFilePin[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly sha256: string;
}
export interface PreparedProposalSourceSnapshot {
  readonly schemaVersion: 1;
  readonly binding: KnowledgeHostBinding;
  readonly manifest: ProposalSourceManifest;
  readonly operations: readonly {
    readonly path: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
}
/** An observation is not approval or effect authority. Only the issuing host owns this identity. */
export interface PreparedProposalSourceCapture {
  readonly id: string;
}
export interface ProposalSourceCaptureHostPorts {
  readonly checkBinding: (workspaceId: string) => KnowledgeHostBinding;
}
interface Observed {
  readonly pin: Omit<ProposalSourceFilePin, "afterSha256" | "afterBytes">;
  readonly body: string | null;
}
function fail(
  code: string,
  message = "Proposal source requires an original current bounded physical capture",
): never {
  throw new EngineError(code, message);
}
function invalid(): never {
  return fail("INVALID_PROPOSAL_SOURCE");
}
function actualSignal(value?: AbortSignal): void {
  if (value !== undefined) assertNativeSignal(value, invalid);
}
function check(
  signal: AbortSignal | undefined,
  close: AbortSignal,
  deadline: number,
): void {
  if (signal?.aborted || close.aborted) fail("PROPOSAL_SOURCE_CANCELLED");
  if (Date.now() >= deadline) fail("PROPOSAL_SOURCE_DEADLINE");
}
function metadata(stat: BigIntStats) {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: Number(stat.mode & 0o777n),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}
function stable(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.nlink === b.nlink &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
/** Each proper ancestor of a relative path, outermost first. */
function ancestorPaths(relative: string): string[] {
  const components = relative.split("/");
  return components
    .slice(1)
    .map((_, i) => components.slice(0, i + 1).join("/"));
}
/** canonical runs only after the stat checks pass. */
function rootPin(
  stat: BigIntStats,
  binding: KnowledgeHostBinding,
  canonical: () => string,
): ProposalPhysicalPin {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev.toString() !== binding.rootDevice ||
    stat.ino.toString() !== binding.rootInode ||
    canonical() !== binding.root
  )
    fail("PROPOSAL_SOURCE_BINDING_CHANGED");
  return Object.freeze({ path: ".", ...metadata(stat) });
}
/** canonical runs only after the stat checks pass, so a dangling symlink is unsafe rather than absent. */
function directoryPin(
  stat: BigIntStats,
  selected: string,
  absolute: string,
  canonical: () => string,
): ProposalPhysicalPin {
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical() !== absolute)
    fail("PROPOSAL_SOURCE_UNSAFE");
  return Object.freeze({ path: selected, ...metadata(stat) });
}
function assertStableRead(
  bytes: number,
  before: BigIntStats,
  observed: BigIntStats,
  current: BigIntStats,
): void {
  if (
    bytes > PROPOSAL_SOURCE_LIMITS.fileBytes ||
    BigInt(bytes) !== observed.size ||
    !stable(before, observed) ||
    !stable(observed, current) ||
    current.isSymbolicLink()
  )
    fail("PROPOSAL_SOURCE_STALE");
}
function pinMatches(
  pin: Observed["pin"],
  original: ProposalSourceFilePin,
): boolean {
  return (
    knowledgeHash({
      ...pin,
      afterSha256: original.afterSha256,
      afterBytes: original.afterBytes,
    }) === knowledgeHash(original)
  );
}
/** Source failures every proposal reader reports as stale rather than unknown. */
export function isProposalSourceStale(error: unknown): boolean {
  return (
    error instanceof EngineError &&
    [
      "PROPOSAL_SOURCE_STALE",
      "PROPOSAL_SOURCE_BINDING_CHANGED",
      "PROPOSAL_SOURCE_UNSAFE",
    ].includes(error.code)
  );
}
function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function text(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > PROPOSAL_SOURCE_LIMITS.fileBytes ||
    Buffer.from(value).toString("utf8") !== value ||
    value.includes("\0")
  )
    fail("PROPOSAL_SOURCE_LIMIT");
  return value;
}
function operationsSnapshot(
  input: readonly ProposalSourceOperation[],
): readonly ProposalSourceOperation[] {
  if (
    !Array.isArray(input) ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > PROPOSAL_SOURCE_LIMITS.files
  )
    fail("INVALID_PROPOSAL_SOURCE");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)) ||
        !Object.hasOwn(descriptors[key as string]!, "value"),
    ) ||
    Object.keys(descriptors).length !== input.length + 1
  )
    fail("INVALID_PROPOSAL_SOURCE");
  let bytes = 0;
  const paths: string[] = [];
  const result = Array.from({ length: input.length }, (_, index) => {
    if (!descriptors[String(index)]?.enumerable)
      fail("INVALID_PROPOSAL_SOURCE");
    const value = plainRecord(
      descriptors[String(index)]!.value,
      ["path", "expectedSha256", "after"],
      [],
      invalid,
    );
    const selected = exactKnowledgePath(value.path),
      expected = value.expectedSha256,
      after = text(value.after);
    if (
      selected.split("/").length > PROPOSAL_SOURCE_LIMITS.depth ||
      (expected !== null &&
        (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected))) ||
      (expected === null && after === null)
    )
      fail("INVALID_PROPOSAL_SOURCE");
    addDisjointPath(paths, selected, invalid);
    bytes += after === null ? 0 : Buffer.byteLength(after);
    if (bytes > PROPOSAL_SOURCE_LIMITS.totalBytes)
      fail("PROPOSAL_SOURCE_LIMIT");
    return Object.freeze({
      path: selected,
      expectedSha256: expected as string | null,
      after,
    });
  });
  return Object.freeze(result);
}
function completeFile(
  stat: BigIntStats,
  absolute: string,
  canonical: string,
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size > BigInt(PROPOSAL_SOURCE_LIMITS.fileBytes) ||
    canonical !== absolute
  )
    fail("PROPOSAL_SOURCE_UNSAFE");
}
function decode(raw: Buffer): string {
  const body = raw.toString("utf8");
  if (!Buffer.from(body).equals(raw) || body.includes("\0"))
    fail("PROPOSAL_SOURCE_UNSAFE");
  return body;
}
function freezeObserved(
  relative: string,
  root: ProposalPhysicalPin,
  parents: ProposalPhysicalPin[],
  missing: string[],
  stat: BigIntStats | undefined,
  body: string | null,
): Observed {
  return Object.freeze({
    body,
    pin: Object.freeze({
      path: relative,
      beforeSha256: body === null ? null : sha256Hex(body),
      beforeBytes: body === null ? 0 : Buffer.byteLength(body),
      device: null,
      inode: null,
      mode: null,
      mtimeNs: null,
      ctimeNs: null,
      ...(stat ? metadata(stat) : {}),
      parentPins: Object.freeze([root, ...parents]),
      missingParents: Object.freeze(missing),
    }),
  });
}

/** Reads actual selected file descriptors. It creates no directories, files, tools, Runs, or approvals. */
export class ProposalSourceCaptureHost {
  readonly #checkBinding: ProposalSourceCaptureHostPorts["checkBinding"];
  readonly #captures = new WeakMap<object, PreparedProposalSourceSnapshot>();
  readonly #active = new Set<object>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #close = new AbortController();
  #reserved = 0;
  constructor(ports: ProposalSourceCaptureHostPorts) {
    plainRecord(ports, ["checkBinding"], [], invalid);
    if (typeof ports.checkBinding !== "function")
      fail("INVALID_PROPOSAL_SOURCE");
    this.#checkBinding = ports.checkBinding;
  }
  private current(binding: KnowledgeHostBinding): void {
    if (
      knowledgeHash(
        validateBinding(this.#checkBinding(binding.workspaceId)),
      ) !== knowledgeHash(binding)
    )
      fail("PROPOSAL_SOURCE_BINDING_CHANGED");
  }
  private rootSync(binding: KnowledgeHostBinding): ProposalPhysicalPin {
    this.current(binding);
    return rootPin(lstatSync(binding.root, { bigint: true }), binding, () =>
      realpathSync(binding.root),
    );
  }
  private async root(
    binding: KnowledgeHostBinding,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<ProposalPhysicalPin> {
    check(signal, this.#close.signal, deadline);
    this.current(binding);
    const stat = await lstat(binding.root, { bigint: true }),
      canonical = await realpath(binding.root);
    check(signal, this.#close.signal, deadline);
    return rootPin(stat, binding, () => canonical);
  }
  private observeSync(
    binding: KnowledgeHostBinding,
    relative: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Observed {
    check(signal, this.#close.signal, deadline);
    const root = this.rootSync(binding),
      parents: ProposalPhysicalPin[] = [],
      missing: string[] = [];
    let absentParent = false;
    for (const selected of ancestorPaths(relative)) {
      check(signal, this.#close.signal, deadline);
      const absolute = path.join(binding.root, selected);
      if (absentParent) {
        missing.push(selected);
        continue;
      }
      try {
        parents.push(
          directoryPin(
            lstatSync(absolute, { bigint: true }),
            selected,
            absolute,
            () => realpathSync(absolute),
          ),
        );
      } catch (error) {
        if (!absent(error)) throw error;
        absentParent = true;
        missing.push(selected);
      }
    }
    const absolute = path.join(binding.root, relative);
    let initial: BigIntStats | undefined,
      body: string | null = null,
      observed: BigIntStats | undefined;
    if (!absentParent) {
      try {
        initial = lstatSync(absolute, { bigint: true });
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (initial) {
        completeFile(initial, absolute, realpathSync(absolute));
        const fd = openSync(
          absolute,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const before = fstatSync(fd, { bigint: true });
          if (!stable(initial, before)) fail("PROPOSAL_SOURCE_STALE");
          const buffer = Buffer.alloc(Number(before.size) + 1);
          let bytes = 0;
          while (bytes < buffer.length) {
            check(signal, this.#close.signal, deadline);
            const count = readSync(
              fd,
              buffer,
              bytes,
              buffer.length - bytes,
              bytes,
            );
            bytes += count;
            if (!count) break;
          }
          observed = fstatSync(fd, { bigint: true });
          assertStableRead(
            bytes,
            before,
            observed,
            lstatSync(absolute, { bigint: true }),
          );
          body = decode(buffer.subarray(0, bytes));
        } finally {
          closeSync(fd);
        }
      }
    }
    const result = freezeObserved(
      relative,
      root,
      parents,
      missing,
      observed,
      body,
    );
    this.current(binding);
    if (knowledgeHash(root) !== knowledgeHash(this.rootSync(binding)))
      fail("PROPOSAL_SOURCE_STALE");
    for (const pin of parents) {
      const absolute = path.join(binding.root, pin.path),
        stat = lstatSync(absolute, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(absolute) !== absolute ||
        knowledgeHash(pin) !==
          knowledgeHash({ path: pin.path, ...metadata(stat) })
      )
        fail("PROPOSAL_SOURCE_STALE");
    }
    return result;
  }
  private async observe(
    binding: KnowledgeHostBinding,
    relative: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<Observed> {
    const root = await this.root(binding, signal, deadline),
      parents: ProposalPhysicalPin[] = [],
      missing: string[] = [];
    let absentParent = false;
    for (const selected of ancestorPaths(relative)) {
      check(signal, this.#close.signal, deadline);
      const absolute = path.join(binding.root, selected);
      if (absentParent) {
        missing.push(selected);
        continue;
      }
      try {
        const stat = await lstat(absolute, { bigint: true }),
          canonical = await realpath(absolute);
        parents.push(directoryPin(stat, selected, absolute, () => canonical));
      } catch (error) {
        if (!absent(error)) throw error;
        absentParent = true;
        missing.push(selected);
      }
    }
    const absolute = path.join(binding.root, relative);
    let initial: BigIntStats | undefined,
      body: string | null = null,
      observed: BigIntStats | undefined;
    if (!absentParent) {
      try {
        initial = await lstat(absolute, { bigint: true });
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (initial) {
        completeFile(initial, absolute, await realpath(absolute));
        check(signal, this.#close.signal, deadline);
        const handle = await open(
          absolute,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          check(signal, this.#close.signal, deadline);
          const before = await handle.stat({ bigint: true });
          if (!stable(initial, before)) fail("PROPOSAL_SOURCE_STALE");
          const buffer = Buffer.alloc(Number(before.size) + 1);
          let bytes = 0;
          while (bytes < buffer.length) {
            check(signal, this.#close.signal, deadline);
            const read = await handle.read(
              buffer,
              bytes,
              buffer.length - bytes,
              bytes,
            );
            bytes += read.bytesRead;
            if (!read.bytesRead) break;
          }
          observed = await handle.stat({ bigint: true });
          assertStableRead(
            bytes,
            before,
            observed,
            await lstat(absolute, { bigint: true }),
          );
          body = decode(buffer.subarray(0, bytes));
        } finally {
          await handle.close();
        }
      }
    }
    check(signal, this.#close.signal, deadline);
    const result = freezeObserved(
      relative,
      root,
      parents,
      missing,
      observed,
      body,
    );
    // A synchronous end sweep also checks parents and missing targets without opening new asynchronous owners.
    const final = this.observeSync(binding, relative, signal, deadline);
    if (knowledgeHash(result) !== knowledgeHash(final))
      fail("PROPOSAL_SOURCE_STALE");
    return result;
  }
  capture(
    inputBinding: KnowledgeHostBinding,
    inputOperations: readonly ProposalSourceOperation[],
    signal?: AbortSignal,
  ): Promise<PreparedProposalSourceCapture> {
    const binding = validateBinding(inputBinding),
      operations = operationsSnapshot(inputOperations);
    actualSignal(signal);
    const deadline = Date.now() + PROPOSAL_SOURCE_LIMITS.durationMs;
    check(signal, this.#close.signal, deadline);
    if (this.#active.size + this.#reserved >= PROPOSAL_SOURCE_LIMITS.handles)
      fail("PROPOSAL_SOURCE_LIMIT");
    this.#reserved++;
    return trackPending(
      this.#pending,
      this.captureOwned(binding, operations, signal, deadline),
    );
  }
  private async captureOwned(
    binding: KnowledgeHostBinding,
    operations: readonly ProposalSourceOperation[],
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<PreparedProposalSourceCapture> {
    try {
      const files: ProposalSourceFilePin[] = [],
        content: PreparedProposalSourceSnapshot["operations"][number][] = [];
      let totalBytes = 0;
      for (const operation of operations) {
        const observed = await this.observe(
          binding,
          operation.path,
          signal,
          deadline,
        );
        if (observed.pin.beforeSha256 !== operation.expectedSha256)
          fail("PROPOSAL_SOURCE_PREIMAGE_MISMATCH");
        if (observed.body === operation.after)
          fail("PROPOSAL_SOURCE_UNCHANGED");
        const afterBytes =
            operation.after === null ? 0 : Buffer.byteLength(operation.after),
          afterSha256 =
            operation.after === null ? null : sha256Hex(operation.after);
        totalBytes += observed.pin.beforeBytes + afterBytes;
        if (totalBytes > PROPOSAL_SOURCE_LIMITS.totalBytes)
          fail("PROPOSAL_SOURCE_LIMIT");
        files.push(Object.freeze({ ...observed.pin, afterBytes, afterSha256 }));
        content.push(
          Object.freeze({
            path: operation.path,
            before: observed.body,
            after: operation.after,
          }),
        );
      }
      const base = Object.freeze({
        projection: "proposal-selected-files-v1" as const,
        rootPin: this.rootSync(binding),
        files: Object.freeze(files),
        fileCount: files.length,
        totalBytes,
      });
      if (
        Buffer.byteLength(JSON.stringify(base)) >
        PROPOSAL_SOURCE_LIMITS.manifestBytes - 128
      )
        fail("PROPOSAL_SOURCE_LIMIT");
      const manifest = Object.freeze({
          ...base,
          sha256: knowledgeHash({ binding, ...base }),
        }),
        snapshot = Object.freeze({
          schemaVersion: 1 as const,
          binding,
          manifest,
          operations: Object.freeze(content),
        });
      this.verifySync(binding, manifest, signal, deadline, content);
      const capture = Object.freeze({ id: randomUUID() });
      this.#captures.set(capture, snapshot);
      this.#active.add(capture);
      return capture;
    } finally {
      this.#reserved--;
    }
  }
  private owned(capture: object): PreparedProposalSourceSnapshot {
    if (
      !capture ||
      typeof capture !== "object" ||
      types.isProxy(capture) ||
      !this.#active.has(capture)
    )
      fail("PROPOSAL_SOURCE_CAPTURE_INVALID");
    return (
      this.#captures.get(capture) ?? fail("PROPOSAL_SOURCE_CAPTURE_INVALID")
    );
  }
  read(capture: object): PreparedProposalSourceSnapshot {
    return this.owned(capture);
  }
  /** Re-observes every manifest file and, when given, its captured before body. */
  private verifySync(
    binding: KnowledgeHostBinding,
    manifest: ProposalSourceManifest,
    signal: AbortSignal | undefined,
    deadline: number,
    bodies?: readonly { readonly before: string | null }[],
  ): void {
    check(signal, this.#close.signal, deadline);
    if (
      knowledgeHash(this.rootSync(binding)) !== knowledgeHash(manifest.rootPin)
    )
      fail("PROPOSAL_SOURCE_STALE");
    for (const [i, original] of manifest.files.entries()) {
      const observed = this.observeSync(
        binding,
        original.path,
        signal,
        deadline,
      );
      if (
        !pinMatches(observed.pin, original) ||
        (bodies && observed.body !== bodies[i]!.before)
      )
        fail("PROPOSAL_SOURCE_STALE");
    }
    check(signal, this.#close.signal, deadline);
    this.current(binding);
  }
  assertFreshSync(
    capture: PreparedProposalSourceCapture,
    signal?: AbortSignal,
  ): void {
    actualSignal(signal);
    const snapshot = this.owned(capture);
    this.verifySync(
      snapshot.binding,
      snapshot.manifest,
      signal,
      Date.now() + PROPOSAL_SOURCE_LIMITS.durationMs,
      snapshot.operations,
    );
  }
  /** Physical observation only; callers (proposal apply preview and approval checks) must separately authenticate native revision/blob ownership. */
  assertStoredManifestCurrentSync(
    inputBinding: KnowledgeHostBinding,
    inputManifest: ProposalSourceManifest,
    signal?: AbortSignal,
  ): void {
    actualSignal(signal);
    const binding = validateBinding(inputBinding),
      manifest = validateProposalSourceManifest(inputManifest, binding);
    this.verifySync(
      binding,
      manifest,
      signal,
      Date.now() + PROPOSAL_SOURCE_LIMITS.durationMs,
    );
  }
  /** Rehydrates no producer/approval identity: it checks only the exact durable native selected-file metadata. */
  assertStoredManifestCurrent(
    inputBinding: KnowledgeHostBinding,
    inputManifest: ProposalSourceManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    actualSignal(signal);
    const binding = validateBinding(inputBinding),
      manifest = validateProposalSourceManifest(inputManifest, binding),
      deadline = Date.now() + PROPOSAL_SOURCE_LIMITS.durationMs;
    const task = (async () => {
      for (const original of manifest.files) {
        const observed = await this.observe(
          binding,
          original.path,
          signal,
          deadline,
        );
        if (!pinMatches(observed.pin, original)) fail("PROPOSAL_SOURCE_STALE");
      }
      this.verifySync(binding, manifest, signal, deadline);
    })();
    return trackPending(this.#pending, task);
  }
  release(capture: PreparedProposalSourceCapture): void {
    this.owned(capture);
    this.#active.delete(capture);
    this.#captures.delete(capture);
  }
  async close(): Promise<void> {
    this.#close.abort();
    await Promise.allSettled([...this.#pending]);
    for (const capture of this.#active) this.#captures.delete(capture);
    this.#active.clear();
  }
}
