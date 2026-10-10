import { types } from "node:util";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  EngineError,
  type InputMediaAttachment,
  type JsonObject,
  type Session,
  type Workspace,
} from "@moodcode/contracts";
export interface ResolvedInputMediaSource {
  attachment: InputMediaAttachment;
  data: string;
}
import {
  attachment,
  attachments,
  cancelled,
  digest,
  fail,
  DEFAULT_SEGMENT_LIMITS,
  sameAttachment,
  validateMediaBytes,
} from "./segment-validation.js";

export const SEGMENT_DOCUMENT_KIND = "input_media_segments";
export interface ImageDocuments {
  getSession(id: string): Session;
  getWorkspace(id: string): Workspace;
  getSessionDocument(
    sessionId: string,
    kind: string,
  ): { revision: number; data: JsonObject } | null;
  putSessionDocument(
    sessionId: string,
    kind: string,
    expectedRevision: number,
    data: JsonObject,
  ): { revision: number; data: JsonObject };
}
interface MediaSegmentStoreOptions {
  directory: string;
  documents: ImageDocuments;
  limits?: never;
}
interface Owner {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
}
interface Index {
  revision: number;
  owner: Owner;
  attachments: InputMediaAttachment[];
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function sameOwner(left: Owner, right: Owner): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceRoot === right.workspaceRoot
  );
}
async function directoryPath(path: string, create: boolean): Promise<Stats> {
  let current = parse(path).root,
    info = await lstat(current);
  for (const component of path
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, component);
    try {
      info = await lstat(current);
    } catch (error) {
      if (!create || !errno(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!errno(error, "EEXIST")) throw error;
      }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail("MEDIA_PATH_UNSAFE");
  }
  if ((await realpath(path)) !== path) fail("MEDIA_PATH_UNSAFE");
  return info;
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function safeFile(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    fail("MEDIA_PATH_UNSAFE");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || !sameFile(before, after))
      fail("MEDIA_PATH_UNSAFE");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function publicFailure(error: unknown): EngineError {
  if (
    error instanceof EngineError &&
    (error.code.startsWith("MEDIA_") ||
      [
        "RECORD_SCOPE_MISMATCH",
        "RECORD_NOT_FOUND",
        "REVISION_CONFLICT",
      ].includes(error.code))
  )
    return new EngineError(error.code, "Local media input operation failed.");
  return new EngineError(
    "MEDIA_STORAGE_FAILED",
    "Local media input operation failed.",
  );
}

/** Immutable local blobs; refs become visible only after a successful session-document CAS. */
export class MediaSegmentStore {
  readonly limits: Readonly<typeof DEFAULT_SEGMENT_LIMITS>;
  readonly #directory: string;
  readonly #documents: ImageDocuments;
  #root?: Promise<Stats>;
  constructor(options: MediaSegmentStoreOptions) {
    if (
      typeof options.directory !== "string" ||
      !isAbsolute(options.directory) ||
      options.directory.includes("\0") ||
      options.directory !== resolve(options.directory)
    )
      fail("MEDIA_INVALID_CONFIG");
    this.#directory = options.directory;
    this.#documents = options.documents;
    this.limits = DEFAULT_SEGMENT_LIMITS;
  }
  async #managed(signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    const pinned = await (this.#root ??= directoryPath(this.#directory, true));
    const actual = await directoryPath(this.#directory, false);
    if (!sameFile(pinned, actual)) fail("MEDIA_PATH_UNSAFE");
    cancelled(signal);
  }
  #owner(sessionId: string): Owner {
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      sessionId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(sessionId)
    )
      fail("MEDIA_INVALID_REFERENCE");
    const session = this.#documents.getSession(sessionId),
      workspace = this.#documents.getWorkspace(session.workspaceId);
    if (session.id !== sessionId || workspace.id !== session.workspaceId)
      fail("RECORD_SCOPE_MISMATCH");
    return {
      sessionId,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
    };
  }
  #index(owner: Owner): Index {
    const document = this.#documents.getSessionDocument(
      owner.sessionId,
      SEGMENT_DOCUMENT_KIND,
    );
    if (!document) return { revision: 0, owner, attachments: [] };
    const data = document.data,
      storedOwner = data.owner;
    if (
      data.version !== 1 ||
      Object.keys(data).some(
        (key) => !["version", "owner", "attachments"].includes(key),
      ) ||
      storedOwner === null ||
      typeof storedOwner !== "object" ||
      Array.isArray(storedOwner) ||
      Object.keys(storedOwner).length !== 3 ||
      !sameOwner(owner, storedOwner as unknown as Owner)
    )
      fail("RECORD_SCOPE_MISMATCH");
    if (
      !Number.isSafeInteger(document.revision) ||
      document.revision < 1 ||
      !Array.isArray(data.attachments) ||
      data.attachments.length > this.limits.maxSessionImages
    )
      fail("MEDIA_INVALID_INDEX");
    const items = data.attachments.map((item) => attachment(item)),
      ids = new Set<string>();
    let bytes = 0;
    for (const item of items) {
      if (ids.has(item.id)) fail("MEDIA_INVALID_INDEX");
      ids.add(item.id);
      bytes += item.bytes;
    }
    if (bytes > this.limits.maxSessionBytes) fail("MEDIA_LIMIT_EXCEEDED");
    return { revision: document.revision, owner, attachments: items };
  }
  async import(
    sessionId: string,
    data: Uint8Array,
    mimeType: InputMediaAttachment["mimeType"],
    segments: readonly import("@moodcode/contracts").InputMediaSegment[],
    signal?: AbortSignal,
  ): Promise<InputMediaAttachment> {
    let staging: string | undefined,
      published: string | undefined,
      known: Stats | undefined,
      committed = false;
    try {
      cancelled(signal);
      if (
        types.isProxy(data) ||
        !(data instanceof Uint8Array) ||
        data.byteLength > this.limits.maxImageBytes
      )
        fail("MEDIA_LIMIT_EXCEEDED");
      // Copy before the first await so host buffer mutation cannot change accepted bytes.
      const bytes = Buffer.from(data);
      const checked = attachment({
        id: "med_" + "0".repeat(32),
        kind: mimeType === "audio/wav" ? "audio" : "video",
        mimeType,
        bytes: bytes.length,
        sha256: digest(bytes),
        decoder: mimeType === "audio/wav" ? "wav-pcm16-v1" : "avi-rgb24-v1",
        segments,
      });
      segments = checked.segments;
      validateMediaBytes(bytes, mimeType, segments);
      const owner = this.#owner(sessionId);
      this.#index(owner);
      await this.#managed(signal);
      const ref: InputMediaAttachment = attachment({
        id: "med_" + randomUUID().replaceAll("-", ""),
        kind: mimeType === "audio/wav" ? "audio" : "video",
        mimeType,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
        decoder: mimeType === "audio/wav" ? "wav-pcm16-v1" : "avi-rgb24-v1",
        segments,
      });
      staging = join(this.#directory, ".pending_" + ref.id);
      const destination = join(this.#directory, ref.id + ".blob");
      const handle = await open(
        staging,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        known = await handle.stat();
        let position = 0;
        while (position < bytes.length) {
          cancelled(signal);
          const written = await handle.write(
            bytes,
            position,
            bytes.length - position,
            position,
          );
          if (!written.bytesWritten) fail("MEDIA_STORAGE_FAILED");
          position += written.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#managed(signal);
      const before = await lstat(staging);
      if (!sameFile(before, known) || !before.isFile() || before.nlink !== 1)
        fail("MEDIA_PATH_UNSAFE");
      // Publish without replacing an existing filename, including a planted symlink.
      await link(staging, destination);
      published = destination;
      await unlink(staging);
      staging = undefined;
      await syncDirectory(this.#directory);
      await this.#managed(signal);
      // Reads and CAS are synchronous: competing hosts either retry with a fresh index
      // or leave no visible ref. Cancellation after commit reports the durable success.
      for (let attempt = 0; attempt < 8; attempt++) {
        cancelled(signal);
        if (!sameOwner(owner, this.#owner(sessionId)))
          fail("RECORD_SCOPE_MISMATCH");
        const index = this.#index(owner);
        if (
          index.attachments.length >= this.limits.maxSessionImages ||
          index.attachments.reduce(
            (total, item) => total + item.bytes,
            bytes.length,
          ) > this.limits.maxSessionBytes
        )
          fail("MEDIA_LIMIT_EXCEEDED");
        cancelled(signal);
        try {
          this.#documents.putSessionDocument(
            sessionId,
            SEGMENT_DOCUMENT_KIND,
            index.revision,
            {
              version: 1,
              owner: { ...owner },
              attachments: [...index.attachments, ref].map((item) => ({
                ...item,
                segments: item.segments.map((s) => ({ ...s })),
              })),
            },
          );
          committed = true;
          return { ...ref };
        } catch (error) {
          if (
            !(
              error instanceof EngineError && error.code === "REVISION_CONFLICT"
            ) ||
            attempt === 7
          )
            throw error;
        }
      }
      return fail("MEDIA_STORAGE_FAILED");
    } catch (error) {
      throw publicFailure(error);
    } finally {
      if (!committed && known)
        for (const path of [staging, published])
          if (path) {
            // Cleanup is restricted to the one generated inode. Never remove replacements.
            try {
              await this.#managed();
              const actual = await lstat(path);
              if (
                actual.isFile() &&
                !actual.isSymbolicLink() &&
                sameFile(actual, known)
              )
                await unlink(path);
            } catch {
              /* Crash/failure orphans are unindexed and cannot be resolved. */
            }
          }
    }
  }
  async resolve(
    sessionId: string,
    input: readonly InputMediaAttachment[],
    signal?: AbortSignal,
  ): Promise<ResolvedInputMediaSource[]> {
    try {
      cancelled(signal);
      const refs = attachments(input),
        owner = this.#owner(sessionId),
        index = this.#index(owner);
      const indexed = new Map(index.attachments.map((item) => [item.id, item]));
      for (const ref of refs)
        if (!indexed.has(ref.id) || !sameAttachment(ref, indexed.get(ref.id)!))
          fail("RECORD_SCOPE_MISMATCH");
      if (!refs.length) return [];
      await this.#managed(signal);
      const result: ResolvedInputMediaSource[] = [];
      for (const ref of refs) {
        cancelled(signal);
        const path = join(this.#directory, ref.id + ".blob"),
          handle = await safeFile(path);
        try {
          const before = await handle.stat();
          if (before.size !== ref.bytes) fail("MEDIA_INTEGRITY_FAILED");
          // Bounded allocation and explicit position reads, even for a concurrently growing file.
          const bytes = Buffer.alloc(ref.bytes);
          let position = 0;
          while (position < bytes.length) {
            cancelled(signal);
            const read = await handle.read(
              bytes,
              position,
              bytes.length - position,
              position,
            );
            if (!read.bytesRead) fail("MEDIA_INTEGRITY_FAILED");
            position += read.bytesRead;
          }
          const after = await handle.stat(),
            current = await lstat(path);
          if (
            !sameFile(before, after) ||
            !sameFile(before, current) ||
            current.isSymbolicLink() ||
            current.nlink !== 1 ||
            after.size !== before.size ||
            current.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            current.mtimeMs !== before.mtimeMs ||
            current.ctimeMs !== before.ctimeMs ||
            digest(bytes) !== ref.sha256
          )
            fail("MEDIA_INTEGRITY_FAILED");
          validateMediaBytes(bytes, ref.mimeType, ref.segments);
          result.push({
            attachment: { ...ref },
            data: bytes.toString("base64"),
          });
        } finally {
          await handle.close();
        }
      }
      await this.#managed(signal);
      if (!sameOwner(owner, this.#owner(sessionId)))
        fail("RECORD_SCOPE_MISMATCH");
      const latest = new Map(
        this.#index(owner).attachments.map((item) => [item.id, item]),
      );
      for (const ref of refs)
        if (!latest.has(ref.id) || !sameAttachment(ref, latest.get(ref.id)!))
          fail("RECORD_SCOPE_MISMATCH");
      cancelled(signal);
      return result;
    } catch (error) {
      throw publicFailure(error);
    }
  }
}
