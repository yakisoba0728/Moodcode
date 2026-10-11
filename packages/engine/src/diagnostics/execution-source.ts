import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { types } from "node:util";
import { EngineError, type Workspace } from "@moodcode/contracts";
import { jsonTextSha256 } from "../shared/canonical.js";
import { runGit } from "../workspace/git.js";

/** Entire physical workspace outside .git metadata; ignored files are also charged. */
export interface ExecutionSourceSnapshot {
  readonly schemaVersion: 1;
  readonly completeness: "full" | "unknown";
  readonly sha256: string | null;
  readonly fileCount: number;
  readonly bytes: number;
}
export interface WorkspaceExecutionSourceCapture {
  readonly id: string;
}
export interface WorkspaceExecutionSourceLimits {
  readonly entries: number;
  readonly files: number;
  readonly bytes: number;
  readonly fileBytes: number;
  readonly depth: number;
  readonly durationMs: number;
}
const DEFAULT_EXECUTION_SOURCE_LIMITS: WorkspaceExecutionSourceLimits =
  Object.freeze({
    entries: 8192,
    files: 1024,
    bytes: 16 * 1024 * 1024,
    fileBytes: 2 * 1024 * 1024,
    depth: 32,
    durationMs: 1500,
  });
export interface WorkspaceExecutionSourceOptions {
  readonly checkWorkspaceBinding: (workspace: Workspace) => void;
  readonly limits?: Partial<WorkspaceExecutionSourceLimits>;
  /** Exact host storage paths; directory exclusions cover only that original physical directory. */
  readonly excludedPaths?: readonly {
    readonly path: string;
    readonly kind: "file" | "directory";
  }[];
}
interface Owned {
  readonly workspace: Workspace;
  readonly snapshot: ExecutionSourceSnapshot;
}
function fail(code: string): never {
  throw new EngineError(
    code,
    "Execution source requires a current original bounded physical capture",
  );
}
function plain(input: unknown): asserts input is Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Array.isArray(input)
  )
    fail("INVALID_EXECUTION_SOURCE");
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail("INVALID_EXECUTION_SOURCE");
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    )
      fail("INVALID_EXECUTION_SOURCE");
  }
}
function workspaceSnapshot(input: Workspace): Workspace {
  plain(input);
  if (
    Object.keys(input).sort().join(",") !==
      "branch,createdAt,gitRoot,id,root" ||
    typeof input.id !== "string" ||
    !input.id ||
    input.id.length > 256 ||
    typeof input.root !== "string" ||
    !isAbsolute(input.root) ||
    input.root.length > 4096 ||
    typeof input.gitRoot !== "string" ||
    !isAbsolute(input.gitRoot) ||
    input.gitRoot.length > 4096 ||
    (input.branch !== null &&
      (typeof input.branch !== "string" || input.branch.length > 1024)) ||
    typeof input.createdAt !== "string" ||
    input.createdAt.length > 64
  )
    fail("INVALID_EXECUTION_SOURCE");
  return Object.freeze({
    id: input.id,
    root: input.root,
    gitRoot: input.gitRoot,
    branch: input.branch,
    createdAt: input.createdAt,
  });
}
function limitsSnapshot(
  input?: Partial<WorkspaceExecutionSourceLimits>,
): WorkspaceExecutionSourceLimits {
  if (input !== undefined) plain(input);
  const limits = { ...DEFAULT_EXECUTION_SOURCE_LIMITS };
  for (const key of Object.keys(input ?? {})) {
    if (!Object.hasOwn(limits, key)) fail("INVALID_EXECUTION_SOURCE_LIMIT");
    const name = key as keyof WorkspaceExecutionSourceLimits,
      value = input![name];
    if (
      !Number.isSafeInteger(value) ||
      value! < 1 ||
      value! > DEFAULT_EXECUTION_SOURCE_LIMITS[name]
    )
      fail("INVALID_EXECUTION_SOURCE_LIMIT");
    limits[name] = value!;
  }
  return Object.freeze(limits);
}
function identity(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.size,
    info.mode,
    info.mtimeNs,
    info.ctimeNs,
    info.nlink,
  ].join(":");
}

/** Observation only: invokes no tool producer, prepared revalidation, provider, or model callback. */
export class WorkspaceExecutionSource {
  readonly #limits: WorkspaceExecutionSourceLimits;
  readonly #checkBinding: (workspace: Workspace) => void;
  readonly #excludedPaths: readonly {
    readonly path: string;
    readonly kind: "file" | "directory";
  }[];
  readonly #captures = new WeakMap<WorkspaceExecutionSourceCapture, Owned>();
  readonly #handles = new Set<WorkspaceExecutionSourceCapture>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #slots = new Set<() => void>();
  readonly #close = new AbortController();
  constructor(options: WorkspaceExecutionSourceOptions) {
    plain(options);
    if (
      Object.keys(options).some(
        (key) =>
          key !== "checkWorkspaceBinding" &&
          key !== "limits" &&
          key !== "excludedPaths",
      ) ||
      typeof options.checkWorkspaceBinding !== "function"
    )
      fail("INVALID_EXECUTION_SOURCE");
    this.#checkBinding = options.checkWorkspaceBinding;
    this.#limits = limitsSnapshot(options.limits);
    if (
      options.excludedPaths !== undefined &&
      (!Array.isArray(options.excludedPaths) ||
        types.isProxy(options.excludedPaths) ||
        options.excludedPaths.length > 32)
    )
      fail("INVALID_EXECUTION_SOURCE");
    if (options.excludedPaths !== undefined) {
      if (Object.getPrototypeOf(options.excludedPaths) !== Array.prototype)
        fail("INVALID_EXECUTION_SOURCE");
      for (const key of Reflect.ownKeys(options.excludedPaths)) {
        const descriptor = Object.getOwnPropertyDescriptor(
          options.excludedPaths,
          key,
        );
        if (
          typeof key !== "string" ||
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))
        )
          fail("INVALID_EXECUTION_SOURCE");
      }
      for (let index = 0; index < options.excludedPaths.length; index++)
        if (!Object.hasOwn(options.excludedPaths, index))
          fail("INVALID_EXECUTION_SOURCE");
    }
    this.#excludedPaths = Object.freeze(
      (options.excludedPaths ?? []).map((item) => {
        plain(item);
        if (
          Object.keys(item).sort().join(",") !== "kind,path" ||
          typeof item.path !== "string" ||
          !isAbsolute(item.path) ||
          resolve(item.path) !== item.path ||
          item.path.includes("\0") ||
          item.path.length > 4096 ||
          (item.kind !== "file" && item.kind !== "directory")
        )
          fail("INVALID_EXECUTION_SOURCE");
        return Object.freeze({ path: item.path, kind: item.kind });
      }),
    );
  }
  /** Lexical scope narrowing only; performs no file reads or binding callbacks. */
  coversWorkspacePath(
    input: Workspace,
    path: string,
    recursive = false,
  ): boolean {
    try {
      const workspace = workspaceSnapshot(input);
      if (
        typeof recursive !== "boolean" ||
        typeof path !== "string" ||
        !path ||
        Buffer.byteLength(path) > 4096 ||
        isAbsolute(path) ||
        win32.isAbsolute(path) ||
        /[\u0000-\u001f\u007f\\:]/u.test(path) ||
        Buffer.from(path).toString() !== path ||
        path.split("/").includes("..")
      )
        return false;
      const normalized = posix.normalize(path);
      if (
        (normalized === "." && !recursive) ||
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.split("/").some((part) => part.toLowerCase() === ".git")
      )
        return false;
      const absolute = resolve(workspace.root, normalized);
      if (
        !absolute.startsWith(`${workspace.root}/`) &&
        !(recursive && absolute === workspace.root)
      )
        return false;
      // Case folding conservatively rejects aliases on case-insensitive workspaces.
      // On case-sensitive filesystems this can only omit diagnostic coverage.
      const folded = absolute.toLowerCase();
      return !this.#excludedPaths.some((item) => {
        const excluded = item.path.toLowerCase();
        return (
          folded === excluded ||
          folded.startsWith(`${excluded}/`) ||
          (recursive && excluded.startsWith(`${folded}/`))
        );
      });
    } catch {
      return false;
    }
  }
  /** With wait, a full in-flight limit waits abortably for a slot; the retained limit always rejects. */
  capture(
    input: Workspace,
    signal: AbortSignal,
    wait = false,
  ): Promise<{
    readonly capture: WorkspaceExecutionSourceCapture;
    readonly metadata: ExecutionSourceSnapshot;
  }> {
    const workspace = workspaceSnapshot(input);
    if (signal.aborted || this.#close.signal.aborted)
      return Promise.reject(
        new EngineError("CANCELLED", "Execution source observation cancelled"),
      );
    if (
      this.#handles.size + this.#pending.size >= 128 ||
      (!wait && this.#pending.size >= 8)
    )
      return Promise.reject(
        new EngineError(
          "EXECUTION_SOURCE_CAPACITY",
          "Execution source capture capacity exceeded",
        ),
      );
    if (this.#pending.size >= 8)
      return this.#slot(signal).then(() =>
        this.capture(workspace, signal, true),
      );
    const promise = this.#capture(workspace, signal);
    this.#pending.add(promise);
    void promise
      .finally(() => {
        this.#pending.delete(promise);
        for (const wake of this.#slots) wake();
      })
      .catch(() => {});
    return promise;
  }
  #slot(signal: AbortSignal): Promise<void> {
    const cancelled = AbortSignal.any([signal, this.#close.signal]);
    return new Promise((resolve) => {
      const wake = () => {
        this.#slots.delete(wake);
        cancelled.removeEventListener("abort", wake);
        resolve();
      };
      this.#slots.add(wake);
      cancelled.addEventListener("abort", wake);
    });
  }
  async #capture(workspace: Workspace, signal: AbortSignal) {
    const deadline = new AbortController(),
      timer = setTimeout(() => deadline.abort(), this.#limits.durationMs),
      observedSignal = AbortSignal.any([
        signal,
        deadline.signal,
        this.#close.signal,
      ]);
    let files = 0,
      bytes = 0,
      entries = 0;
    const check = () => {
      if (observedSignal.aborted) fail("EXECUTION_SOURCE_INCOMPLETE");
    };
    let metadata: ExecutionSourceSnapshot;
    try {
      this.#checkBinding(workspace);
      check();
      const root = await lstat(workspace.root, { bigint: true });
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        (await realpath(workspace.root)) !== workspace.root
      )
        fail("EXECUTION_SOURCE_UNSAFE");
      const exclusions: {
        path: string;
        kind: "file" | "directory";
        physicalParent: string;
        physicalDirectory: string | null;
      }[] = [];
      const exclusionPins = async () => {
        const result: typeof exclusions = [];
        for (const item of this.#excludedPaths) {
          if (item.path === workspace.root) fail("INVALID_EXECUTION_SOURCE");
          if (!item.path.startsWith(`${workspace.root}/`)) continue;
          check();
          const parent = dirname(item.path),
            info = await lstat(parent, { bigint: true });
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            (await realpath(parent)) !== parent
          )
            fail("EXECUTION_SOURCE_UNSAFE");
          let physicalDirectory: string | null = null;
          try {
            const child = await lstat(item.path, { bigint: true });
            if (
              child.isSymbolicLink() ||
              (item.kind === "file"
                ? !child.isFile() || child.nlink !== 1n
                : !child.isDirectory())
            )
              fail("EXECUTION_SOURCE_UNSAFE");
            if (item.kind === "directory")
              physicalDirectory = `${child.dev}:${child.ino}`;
          } catch (error) {
            if (
              !(
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "ENOENT"
              ) ||
              item.kind === "directory"
            )
              throw error;
          }
          result.push({
            ...item,
            physicalParent: `${info.dev}:${info.ino}`,
            physicalDirectory,
          });
        }
        return result;
      };
      exclusions.push(...(await exclusionPins()));
      const directories = new Map<string, string>(),
        filePins = new Map<string, string>(),
        contents: { path: string; sha256: string }[] = [];
      const read = async (
        absolute: string,
      ): Promise<{ pin: string; sha256: string }> => {
        check();
        const named = await lstat(absolute, { bigint: true });
        if (
          !named.isFile() ||
          named.isSymbolicLink() ||
          named.nlink !== 1n ||
          named.size > BigInt(this.#limits.fileBytes) ||
          (await realpath(absolute)) !== absolute
        )
          fail("EXECUTION_SOURCE_UNSAFE");
        if (bytes + Number(named.size) > this.#limits.bytes)
          fail("EXECUTION_SOURCE_LIMIT");
        const handle = await open(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const before = await handle.stat({ bigint: true });
          if (
            identity(before) !== identity(named) ||
            !before.isFile() ||
            before.nlink !== 1n
          )
            fail("EXECUTION_SOURCE_STALE");
          const hash = createHash("sha256"),
            buffer = Buffer.alloc(Math.min(65536, Number(before.size) + 1));
          let position = 0;
          while (position <= Number(before.size)) {
            check();
            const result = await handle.read(
              buffer,
              0,
              Math.min(buffer.length, Number(before.size) + 1 - position),
              position,
            );
            if (!result.bytesRead) break;
            hash.update(buffer.subarray(0, result.bytesRead));
            position += result.bytesRead;
          }
          const after = await handle.stat({ bigint: true }),
            current = await lstat(absolute, { bigint: true });
          if (
            position !== Number(before.size) ||
            identity(before) !== identity(after) ||
            identity(before) !== identity(current)
          )
            fail("EXECUTION_SOURCE_STALE");
          bytes += position;
          return { pin: identity(after), sha256: hash.digest("hex") };
        } finally {
          await handle.close();
        }
      };
      const git = async (): Promise<string> => {
        check();
        const result = await runGit(
          workspace.root,
          ["rev-parse", "--show-toplevel", "--absolute-git-dir"],
          { signal: observedSignal, timeoutMs: this.#limits.durationMs },
        );
        if (result.code !== 0) fail("EXECUTION_SOURCE_GIT_UNKNOWN");
        const [top, gitDirectory] = result.stdout
          .toString("utf8")
          .trimEnd()
          .split("\n");
        if (
          top !== workspace.gitRoot ||
          !gitDirectory ||
          !isAbsolute(gitDirectory)
        )
          fail("EXECUTION_SOURCE_GIT_UNKNOWN");
        const info = await lstat(gitDirectory, { bigint: true });
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (await realpath(gitDirectory)) !== gitDirectory
        )
          fail("EXECUTION_SOURCE_UNSAFE");
        const values = await Promise.allSettled([
          runGit(workspace.root, ["rev-parse", "--verify", "HEAD"], {
            signal: observedSignal,
            timeoutMs: this.#limits.durationMs,
          }),
          runGit(workspace.root, ["symbolic-ref", "--quiet", "HEAD"], {
            signal: observedSignal,
            timeoutMs: this.#limits.durationMs,
          }),
        ]);
        const results = values.map((value) => {
          if (value.status === "rejected") throw value.reason;
          return value.value;
        });
        if (
          ![0, 128].includes(results[0]!.code) ||
          ![0, 1].includes(results[1]!.code) ||
          (results[0]!.code === 128 && results[1]!.code !== 0)
        )
          fail("EXECUTION_SOURCE_GIT_UNKNOWN");
        const pins: { path: string; pin: string; sha256: string }[] = [];
        for (const path of ["HEAD", "config", "info/exclude"]) {
          try {
            pins.push({ path, ...(await read(join(gitDirectory, path))) });
          } catch (error) {
            if (!(
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ENOENT"
            ))
              throw error;
          }
        }
        return jsonTextSha256({
          top,
          gitDirectory,
          root: [info.dev.toString(), info.ino.toString()],
          head:
            results[0]!.code === 0
              ? results[0]!.stdout.toString("utf8").trim()
              : null,
          branch:
            results[1]!.code === 0
              ? results[1]!.stdout.toString("utf8").trim()
              : null,
          pins,
        });
      };
      const beforeGit = await git();
      const walk = async (relative: string, depth: number): Promise<void> => {
        check();
        if (depth > this.#limits.depth) fail("EXECUTION_SOURCE_LIMIT");
        const absolute = relative
            ? join(workspace.root, relative)
            : workspace.root,
          before = await lstat(absolute, { bigint: true });
        if (
          !before.isDirectory() ||
          before.isSymbolicLink() ||
          (await realpath(absolute)) !== absolute
        )
          fail("EXECUTION_SOURCE_UNSAFE");
        directories.set(relative, identity(before));
        const directory = await opendir(absolute);
        const children: string[] = [];
        try {
          for await (const child of directory) {
            check();
            if (++entries > this.#limits.entries)
              fail("EXECUTION_SOURCE_LIMIT");
            if (child.name === ".git") continue;
            if (
              child.name.includes("\\") ||
              /[\u0000-\u001f\u007f]/u.test(child.name) ||
              Buffer.from(child.name).toString() !== child.name
            )
              fail("EXECUTION_SOURCE_UNSAFE");
            children.push(relative ? `${relative}/${child.name}` : child.name);
          }
        } finally {
          await directory.close().catch((error: unknown) => {
            if (!(
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "ERR_DIR_CLOSED"
            ))
              throw error;
          });
        }
        children.sort();
        for (const path of children) {
          check();
          if (
            exclusions.some((item) => item.path === join(workspace.root, path))
          )
            continue;
          const info = await lstat(join(workspace.root, path), {
            bigint: true,
          });
          if (info.isDirectory() && !info.isSymbolicLink())
            await walk(path, depth + 1);
          else {
            if (++files > this.#limits.files) fail("EXECUTION_SOURCE_LIMIT");
            const result = await read(join(workspace.root, path));
            filePins.set(path, result.pin);
            contents.push({ path, sha256: result.sha256 });
          }
        }
      };
      await walk("", 0);
      for (const [path, pin] of [...directories, ...filePins]) {
        check();
        if (
          identity(
            await lstat(path ? join(workspace.root, path) : workspace.root, {
              bigint: true,
            }),
          ) !== pin
        )
          fail("EXECUTION_SOURCE_STALE");
      }
      if ((await git()) !== beforeGit) fail("EXECUTION_SOURCE_STALE");
      this.#checkBinding(workspace);
      check();
      for (const [path, pin] of [...directories, ...filePins]) {
        check();
        if (
          identity(
            await lstat(path ? join(workspace.root, path) : workspace.root, {
              bigint: true,
            }),
          ) !== pin
        )
          fail("EXECUTION_SOURCE_STALE");
      }
      if (jsonTextSha256(await exclusionPins()) !== jsonTextSha256(exclusions))
        fail("EXECUTION_SOURCE_STALE");
      check();
      if (
        identity(await lstat(workspace.root, { bigint: true })) !==
        identity(root)
      )
        fail("EXECUTION_SOURCE_STALE");
      metadata = Object.freeze({
        schemaVersion: 1,
        completeness: "full",
        sha256: jsonTextSha256({
          scope: "workspace-files-except-git-metadata-v1",
          root: workspace.root,
          physicalRoot: [root.dev.toString(), root.ino.toString()],
          git: beforeGit,
          exclusions,
          contents,
        }),
        fileCount: files,
        bytes,
      });
    } catch {
      if (signal.aborted || this.#close.signal.aborted)
        throw new EngineError(
          "CANCELLED",
          "Execution source observation cancelled after owned readers joined",
        );
      metadata = Object.freeze({
        schemaVersion: 1,
        completeness: "unknown",
        sha256: null,
        fileCount: files,
        bytes,
      });
    } finally {
      clearTimeout(timer);
    }
    const capture = Object.freeze({ id: randomUUID() });
    this.#captures.set(capture, { workspace, snapshot: metadata });
    this.#handles.add(capture);
    return Object.freeze({ capture, metadata });
  }
  getSnapshot(
    capture: WorkspaceExecutionSourceCapture,
  ): ExecutionSourceSnapshot {
    const owned = this.#captures.get(capture);
    if (!owned) fail("EXECUTION_SOURCE_CAPTURE_INVALID");
    return owned.snapshot;
  }
  async assertFresh(
    capture: WorkspaceExecutionSourceCapture,
    signal: AbortSignal,
  ): Promise<void> {
    const owned = this.#captures.get(capture);
    if (!owned) fail("EXECUTION_SOURCE_CAPTURE_INVALID");
    if (owned.snapshot.completeness !== "full")
      fail("EXECUTION_SOURCE_UNKNOWN");
    const current = await this.capture(owned.workspace, signal, true);
    try {
      if (!this.#captures.has(capture))
        fail("EXECUTION_SOURCE_CAPTURE_INVALID");
      if (
        current.metadata.completeness !== "full" ||
        current.metadata.sha256 !== owned.snapshot.sha256
      )
        fail("EXECUTION_SOURCE_STALE");
    } finally {
      this.release(current.capture);
    }
  }
  release(capture: WorkspaceExecutionSourceCapture): void {
    this.#captures.delete(capture);
    this.#handles.delete(capture);
  }
  async join(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
  async close(): Promise<void> {
    this.#close.abort();
    await this.join();
    for (const capture of this.#handles) this.release(capture);
  }
}
