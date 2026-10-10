import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import {
  EngineError,
  type JsonObject,
  type Workspace,
} from "@moodcode/contracts";
import type { GrantDocumentPort } from "../permission/grants.js";
import { runGit } from "../workspace/git.js";
import { workspaceIdForRoot } from "../workspace/index.js";
import { WORKTREE_JOURNAL, WORKTREE_STATES } from "./journal.js";
import { safeCheckoutArguments } from "./safe-checkout.js";
export type WorktreeState = (typeof WORKTREE_STATES)[number];
export interface ManagedWorktree {
  id: string;
  requestId: string;
  sessionId: string;
  workspaceId: string;
  baseRoot: string;
  root: string;
  baseCommit: string;
  reference: string;
  state: WorktreeState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  device?: string;
  inode?: string;
  ownerId?: string;
  errorCode?: string;
  relocation?: { archiveId: string; manifestSha256: string; originalRoot: string; ownershipVerified: false };
}
export interface WorktreeCreate {
  sessionId: string;
  requestId: string;
  workspace: Workspace;
  reference?: string;
  /** Delegation-only checkout: disable hooks, filters, lazy fetch and automatic helpers. */
  safeCheckout?: boolean;
}
export interface WorktreeManagerOptions {
  directory: string;
  documents: GrantDocumentPort;
  boot?(record: ManagedWorktree, signal: AbortSignal): Promise<void>;
  bootTimeoutMs?: number;
  now?: () => number;
}
async function safeDirectory(directory: string): Promise<void> {
  let current = parse(directory).root;
  for (const component of directory
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new EngineError(
        "UNSAFE_WORKTREE_PATH",
        "Managed worktree directory must have ordinary directory ancestors",
      );
  }
  if ((await realpath(directory)) !== directory)
    throw new EngineError(
      "UNSAFE_WORKTREE_PATH",
      "Managed worktree directory must be canonical",
    );
}
function errorCode(error: unknown): string {
  return error instanceof EngineError
    ? error.code
    : "WORKTREE_OPERATION_FAILED";
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
async function boundedBoot(
  promise: Promise<void>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted)
    throw new EngineError("CANCELLED", "Worktree boot cancelled");
  let timer: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      abort = () =>
        reject(new EngineError("CANCELLED", "Worktree boot cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () =>
          reject(
            new EngineError(
              "WORKTREE_BOOT_TIMEOUT",
              "Worktree boot exceeded its deadline",
            ),
          ),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    clearTimeout(timer!);
    signal.removeEventListener("abort", abort);
  });
}
/** Detached worktrees only; no user branch is created, reset, deleted or implicitly committed. */
export class WorktreeManager {
  readonly directory: string;
  private now: () => number;
  private closing = false;
  private operations = new Map<AbortController, Promise<ManagedWorktree>>();
  private bootPending = new Set<Promise<void>>();
  constructor(private readonly options: WorktreeManagerOptions) {
    if (
      typeof options.directory !== "string" ||
      !options.directory ||
      options.directory.includes("\0") ||
      !Number.isSafeInteger(options.bootTimeoutMs ?? 30_000) ||
      (options.bootTimeoutMs ?? 30_000) < 1 ||
      (options.bootTimeoutMs ?? 30_000) > 60_000
    )
      throw new EngineError(
        "INVALID_WORKTREE_CONFIG",
        "Managed worktree root and bounded boot deadline are required",
      );
    this.directory = resolve(options.directory);
    this.now = options.now ?? Date.now;
  }
  private records(sessionId: string): {
    revision: number;
    records: ManagedWorktree[];
  } {
    const stored = this.options.documents.getSessionDocument(
      sessionId,
      WORKTREE_JOURNAL.kind,
    );
    if (!stored) return { revision: 0, records: [] };
    const items = stored.data.records;
    if (
      stored.data.schemaVersion !== 1 ||
      !Array.isArray(items) ||
      items.length > WORKTREE_JOURNAL.maxRecords
    )
      throw new EngineError(
        "INVALID_WORKTREE_JOURNAL",
        "Worktree journal schema or record limit is invalid",
      );
    const records = items as unknown as ManagedWorktree[];
    if (
      records.some(
        (record) =>
          !record ||
          record.sessionId !== sessionId ||
          !/^worktree_[a-f0-9]{32}$/.test(record.id) ||
          record.root !== join(this.directory, record.id) ||
          !WORKTREE_STATES.includes(record.state) ||
          !Number.isSafeInteger(record.revision) ||
          record.revision < 1 ||
          !/^[a-f0-9]{40,64}$/.test(record.baseCommit),
      ) ||
      new Set(records.map((record) => record.id)).size !== records.length
    )
      throw new EngineError(
        "INVALID_WORKTREE_JOURNAL",
        "Stored worktree ownership, path or state is invalid",
      );
    return { revision: stored.revision, records: clone(records) };
  }
  private commit(
    sessionId: string,
    records: ManagedWorktree[],
    revision: number,
  ): void {
    const data = { schemaVersion: 1, records } as unknown as JsonObject;
    if (Buffer.byteLength(JSON.stringify(data)) > WORKTREE_JOURNAL.maxBytes)
      throw new EngineError(
        "WORKTREE_JOURNAL_LIMIT",
        "Worktree journal exceeds its durable byte limit",
      );
    this.options.documents.putSessionDocument(
      sessionId,
      WORKTREE_JOURNAL.kind,
      revision,
      data,
    );
  }
  private update(
    sessionId: string,
    id: string,
    update: Partial<ManagedWorktree>,
  ): ManagedWorktree {
    const journal = this.records(sessionId);
    const record = journal.records.find((item) => item.id === id);
    if (!record)
      throw new EngineError(
        "WORKTREE_NOT_FOUND",
        "Managed worktree record was not found",
      );
    Object.assign(record, update, {
      revision: record.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
    });
    this.commit(sessionId, journal.records, journal.revision);
    return clone(record);
  }
  list(sessionId: string): ManagedWorktree[] {
    return this.records(sessionId).records;
  }
  get(sessionId: string, id: string): ManagedWorktree {
    const record = this.list(sessionId).find((item) => item.id === id);
    if (!record)
      throw new EngineError(
        "WORKTREE_NOT_FOUND",
        "Worktree does not belong to the requested session",
      );
    return record;
  }
  claimOwnership(
    sessionId: string,
    id: string,
    ownerId: string,
  ): ManagedWorktree {
    const record = this.get(sessionId, id);
    if (
      typeof ownerId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(ownerId)
    )
      throw new EngineError(
        "INVALID_WORKTREE_OWNER",
        "Worktree owner must be an exact bounded execution identity",
      );
    if (
      record.state !== "ready" ||
      (record.ownerId && record.ownerId !== ownerId)
    )
      throw new EngineError(
        "WORKTREE_BUSY",
        "Worktree is not ready or another execution owns its lifecycle",
      );
    if (record.ownerId === ownerId) return record;
    return this.update(sessionId, id, { ownerId });
  }
  /** Call only after the host confirms all owned execution stopped; uncertain owners are retained on restart. */
  releaseOwnership(
    sessionId: string,
    id: string,
    ownerId: string,
  ): ManagedWorktree {
    const record = this.get(sessionId, id);
    if (record.ownerId !== ownerId)
      throw new EngineError(
        "WORKTREE_OWNER_MISMATCH",
        "Only the recorded execution owner can release this worktree",
      );
    const journal = this.records(sessionId);
    const stored = journal.records.find((r) => r.id === id)!;
    delete stored.ownerId;
    stored.revision++;
    stored.updatedAt = new Date(this.now()).toISOString();
    this.commit(sessionId, journal.records, journal.revision);
    return clone(stored);
  }
  create(input: WorktreeCreate, signal: AbortSignal): Promise<ManagedWorktree> {
    if (this.closing)
      return Promise.reject(
        new EngineError("CANCELLED", "Worktree host is closing"),
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const pending = this.createInternal(input, controller.signal);
    this.operations.set(controller, pending);
    pending
      .finally(() => {
        signal.removeEventListener("abort", abort);
        this.operations.delete(controller);
      })
      .catch(() => {});
    return pending;
  }
  private async createInternal(
    input: WorktreeCreate,
    signal: AbortSignal,
  ): Promise<ManagedWorktree> {
    input = clone(input);
    if (
      typeof input.sessionId !== "string" ||
      !input.sessionId ||
      typeof input.requestId !== "string" ||
      !input.requestId ||
      Buffer.byteLength(input.requestId) > 128 ||
      !input.workspace?.id ||
      (input.safeCheckout !== undefined && typeof input.safeCheckout !== "boolean") ||
      signal.aborted
    )
      throw new EngineError(
        signal.aborted ? "CANCELLED" : "INVALID_WORKTREE_INPUT",
        "Worktree requires a live signal and stable session/workspace/request identity",
      );
    const reference = input.reference ?? "HEAD";
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/.test(reference))
      throw new EngineError(
        "INVALID_WORKTREE_REFERENCE",
        "Worktree reference must be an ordinary explicit Git commit or ref",
      );
    const root = await realpath(input.workspace.root);
    if (
      root !== input.workspace.root ||
      root === this.directory ||
      this.directory.startsWith(`${root}${sep}`)
    )
      throw new EngineError(
        "UNSAFE_WORKTREE_PATH",
        "Worktree storage must be outside the canonical parent workspace",
      );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: input.workspace.id,
          root: input.workspace.root,
          reference,
          ...(input.safeCheckout ? { safeCheckout: true } : {}),
        }),
      )
      .digest("hex");
    const prior = this.list(input.sessionId).find(
      (item) => item.requestId === input.requestId,
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new EngineError(
          "WORKTREE_REQUEST_CONFLICT",
          "Worktree request id is bound to a different input",
        );
      return prior;
    }
    await safeDirectory(this.directory);
    const checkoutArgs = input.safeCheckout ? await safeCheckoutArguments(root, signal) : [];
    const resolved = await runGit(
      root,
      [...checkoutArgs, "rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`],
      { signal },
    );
    if (resolved.code !== 0)
      throw new EngineError(
        "WORKTREE_REFERENCE_UNAVAILABLE",
        "Requested worktree commit/ref is unavailable",
      );
    const baseCommit = resolved.stdout.toString().trim();
    if (!/^[a-f0-9]{40,64}$/.test(baseCommit))
      throw new EngineError(
        "WORKTREE_REFERENCE_UNAVAILABLE",
        "Git returned an invalid commit identity",
      );
    const id = `worktree_${randomUUID().replaceAll("-", "")}`;
    const stamp = new Date(this.now()).toISOString();
    let record: ManagedWorktree = {
      id,
      requestId: input.requestId,
      sessionId: input.sessionId,
      workspaceId: input.workspace.id,
      baseRoot: root,
      root: join(this.directory, id),
      baseCommit,
      reference,
      state: "creating",
      revision: 1,
      createdAt: stamp,
      updatedAt: stamp,
      fingerprint,
    };
    const journal = this.records(input.sessionId);
    const concurrent = journal.records.find(
      (item) => item.requestId === input.requestId,
    );
    if (concurrent) {
      if (concurrent.fingerprint !== fingerprint)
        throw new EngineError(
          "WORKTREE_REQUEST_CONFLICT",
          "Concurrent worktree request changed input",
        );
      return clone(concurrent);
    }
    if (signal.aborted)
      throw new EngineError("CANCELLED", "Worktree preparation cancelled");
    if (journal.records.length >= WORKTREE_JOURNAL.maxRecords)
      throw new EngineError(
        "WORKTREE_LIMIT",
        "Session worktree record limit exceeded",
      );
    journal.records.push(record);
    this.commit(input.sessionId, journal.records, journal.revision);
    let gitAttempted = false;
    try {
      if (signal.aborted)
        throw new EngineError("CANCELLED", "Worktree preparation cancelled");
      gitAttempted = true;
      const added = await runGit(
        root,
        [...checkoutArgs, "worktree", "add", "--detach", record.root, baseCommit],
        { signal, timeoutMs: 60_000 },
      );
      if (added.code !== 0)
        throw new EngineError(
          "WORKTREE_CREATE_FAILED",
          "Git worktree creation failed; any partial managed path was preserved",
        );
      const stat = await lstat(record.root, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(record.root)) !== record.root
      )
        throw new EngineError(
          "UNSAFE_WORKTREE_PATH",
          "New worktree path is not its canonical directory",
        );
      record = this.update(input.sessionId, id, {
        state: "booting",
        device: String(stat.dev),
        inode: String(stat.ino),
      });
      await this.verify(record, signal);
      if (this.options.boot) {
        const bootController = new AbortController();
        const abortBoot = () => bootController.abort();
        signal.addEventListener("abort", abortBoot, { once: true });
        if (signal.aborted) abortBoot();
        const boot = Promise.resolve().then(() => {
          if (bootController.signal.aborted)
            throw new EngineError("CANCELLED", "Worktree boot cancelled");
          return this.options.boot!(clone(record), bootController.signal);
        });
        this.bootPending.add(boot);
        boot.finally(() => this.bootPending.delete(boot)).catch(() => {});
        try {
          await boundedBoot(boot, signal, this.options.bootTimeoutMs ?? 30_000);
        } catch (error) {
          bootController.abort();
          throw error;
        } finally {
          signal.removeEventListener("abort", abortBoot);
        }
      }
      if (signal.aborted)
        throw new EngineError("CANCELLED", "Worktree boot cancelled");
      return this.update(input.sessionId, id, { state: "ready" });
    } catch (error) {
      try {
        this.update(input.sessionId, id, {
          state:
            gitAttempted &&
            (signal.aborted ||
              record.state === "creating" ||
              (error instanceof EngineError &&
                error.code === "WORKTREE_BOOT_TIMEOUT"))
              ? "uncertain"
              : "failed",
          errorCode: errorCode(error),
        });
      } catch {
        throw new EngineError(
          "WORKTREE_RECORD_UNCERTAIN",
          "Worktree effects may be present but their durable state could not be settled",
          { worktreeId: id },
        );
      }
      throw error instanceof EngineError
        ? error
        : new EngineError(
            "WORKTREE_BOOT_FAILED",
            "Worktree boot failed; its files were preserved",
          );
    }
  }
  async verify(
    record: ManagedWorktree,
    signal: AbortSignal,
  ): Promise<Workspace> {
    const owned = this.get(record.sessionId, record.id);
    if (owned.relocation) throw new EngineError('WORKTREE_RELOCATION_UNVERIFIED', 'Archived worktree files are historical data; ownership and Git registration have not been rebound');
    if (
      [
        "root",
        "baseRoot",
        "baseCommit",
        "workspaceId",
        "requestId",
        "reference",
        "fingerprint",
      ].some(
        (key) =>
          owned[key as keyof ManagedWorktree] !==
          record[key as keyof ManagedWorktree],
      ) ||
      record.root !== join(this.directory, record.id) ||
      owned.state === "removed"
    )
      throw new EngineError(
        "WORKTREE_OWNER_MISMATCH",
        "Worktree path and base identity are not owned by this journal",
      );
    await safeDirectory(this.directory);
    const stat = await lstat(record.root, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(record.root)) !== record.root ||
      owned.device !== String(stat.dev) ||
      owned.inode !== String(stat.ino)
    )
      throw new EngineError(
        "UNSAFE_WORKTREE_PATH",
        "Managed worktree path identity changed",
      );
    const parentCommon = await runGit(
      record.baseRoot,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { signal },
    );
    const childCommon = await runGit(
      record.root,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { signal },
    );
    const head = await runGit(record.root, ["rev-parse", "--verify", "HEAD"], {
      signal,
    });
    if (
      parentCommon.code !== 0 ||
      childCommon.code !== 0 ||
      head.code !== 0 ||
      (await realpath(parentCommon.stdout.toString().trim())) !==
        (await realpath(childCommon.stdout.toString().trim()))
    )
      throw new EngineError(
        "WORKTREE_REPOSITORY_MISMATCH",
        "Managed worktree no longer belongs to its parent Git repository",
      );
    return {
      id: workspaceIdForRoot(record.root),
      root: record.root,
      gitRoot: record.root,
      branch: null,
      createdAt: record.createdAt,
    };
  }
  async cleanup(
    sessionId: string,
    id: string,
    signal: AbortSignal,
  ): Promise<ManagedWorktree> {
    const record = this.get(sessionId, id);
    if (record.state === "removed") return record;
    if (record.ownerId)
      throw new EngineError(
        "WORKTREE_BUSY",
        "Worktree has a live or uncertain execution owner; cleanup preserves it",
      );
    await this.verify(record, signal);
    const head = await runGit(record.root, ["rev-parse", "--verify", "HEAD"], {
      signal,
    });
    const branch = await runGit(
      record.root,
      ["symbolic-ref", "--quiet", "HEAD"],
      { signal },
    );
    if (
      head.code !== 0 ||
      head.stdout.toString().trim() !== record.baseCommit ||
      branch.code !== 1
    )
      throw new EngineError(
        "WORKTREE_HISTORY_CHANGED",
        "Managed worktree HEAD or branch changed; cleanup preserves commits and user branch ownership",
      );
    const status = await runGit(
      record.root,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"],
      { signal },
    );
    if (status.code !== 0 || status.stdout.length > 0)
      throw new EngineError(
        "WORKTREE_DIRTY",
        "Managed worktree has tracked, untracked or ignored files; cleanup requires preserving user changes",
      );
    const fresh = this.get(sessionId, id);
    if (fresh.ownerId || fresh.revision !== record.revision)
      throw new EngineError(
        "WORKTREE_BUSY",
        "Worktree owner or lifecycle changed during cleanup observation",
      );
    this.update(sessionId, id, { state: "cleaning" });
    try {
      const removed = await runGit(
        record.baseRoot,
        ["worktree", "remove", record.root],
        { signal, timeoutMs: 60_000 },
      );
      if (removed.code !== 0)
        throw new EngineError(
          "WORKTREE_CLEANUP_FAILED",
          "Git refused worktree removal; existing files were preserved",
        );
      return this.update(sessionId, id, { state: "removed" });
    } catch (error) {
      try {
        this.update(sessionId, id, {
          state: signal.aborted ? "uncertain" : "failed",
          errorCode: errorCode(error),
        });
      } catch {
        throw new EngineError(
          "WORKTREE_RECORD_UNCERTAIN",
          "Cleanup effects may be present but durable state could not be settled",
          { worktreeId: id },
        );
      }
      throw error;
    }
  }
  recover(sessionId: string): ManagedWorktree[] {
    const journal = this.records(sessionId);
    const recovered: ManagedWorktree[] = [];
    for (const record of journal.records)
      if (["creating", "booting", "cleaning"].includes(record.state)) {
        record.state = "uncertain";
        record.errorCode = "WORKTREE_INTERRUPTED";
        record.revision++;
        record.updatedAt = new Date(this.now()).toISOString();
        recovered.push(clone(record));
      }
    if (recovered.length)
      this.commit(sessionId, journal.records, journal.revision);
    return recovered;
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.operations.keys()) controller.abort();
    const settled = Promise.allSettled([
      ...this.operations.values(),
      ...this.bootPending,
    ]);
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        settled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new EngineError(
                  "WORKTREE_CLEANUP_UNCERTAIN",
                  "Worktree boot or Git preparation did not confirm teardown",
                ),
              ),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
