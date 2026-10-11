import { types } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { EngineError, type JsonObject, type JsonValue, type Session, type Workspace } from '@moodcode/contracts';
import { sha256Hex } from '../shared/canonical.js';
import { isBoundedId, isPlainArray, plainRecord } from '../shared/data.js';
import { openSingleLinkFile, stableStat, symlinkFreeDirectory, syncDirectoryAsync } from '../shared/fs.js';

export interface SessionBlobDocuments {
  getSession(id: string): Session;
  getWorkspace(id: string): Workspace;
  getSessionDocument(sessionId: string, kind: string): { revision: number; data: JsonObject } | null;
  putSessionDocument(sessionId: string, kind: string, expectedRevision: number, data: JsonObject): { revision: number; data: JsonObject };
}
interface BlobRef { id: string; bytes: number; sha256: string }
interface BlobBounds { maxBlobBytes: number; maxSessionItems: number; maxSessionBytes: number }
/** One attachment kind. documentKind, indexKey and idPrefix are persisted and stay fixed per kind. */
export interface SessionBlobKind<A extends BlobRef, L> {
  /** Error code prefix, such as DOCUMENT in DOCUMENT_PATH_UNSAFE. */
  readonly code: string;
  /** Message of every error that import and resolve throw. */
  readonly message: string;
  readonly documentKind: string;
  readonly indexKey: string;
  readonly idPrefix: string;
  readonly fail: (code: string) => never;
  readonly cancelled: (signal?: AbortSignal) => void;
  readonly limits: (input?: Partial<L>) => Readonly<L>;
  readonly bounds: (limits: Readonly<L>) => BlobBounds;
  /** Parses one stored index entry. */
  readonly item: (value: unknown, limits: Readonly<L>) => A;
  /** Parses caller refs under the per-input bounds. */
  readonly refs: (value: unknown, limits: Readonly<L>) => A[];
  readonly same: (left: A, right: A) => boolean;
  readonly validate: (bytes: Buffer, ref: A, limits: Readonly<L>) => void;
}
interface Owner { sessionId: string; workspaceId: string; workspaceRoot: string }
const OWNER_KEYS = ['sessionId', 'workspaceId', 'workspaceRoot'];
function ownerData(value: unknown, keys: readonly string[]): value is Record<string,unknown> { return !types.isProxy(value) && value !== null && typeof value === 'object' && !Array.isArray(value) && keys.every(key => { const property=Object.getOwnPropertyDescriptor(value,key); return property?.enumerable && Object.hasOwn(property,'value'); }); }
function sameOwner(left: Owner, right: Owner): boolean { return left.sessionId === right.sessionId && left.workspaceId === right.workspaceId && left.workspaceRoot === right.workspaceRoot; }
function canonicalPath(value: unknown): value is string { return typeof value === 'string' && isAbsolute(value) && !value.includes('\0') && Buffer.byteLength(value) <= 4096 && resolve(value) === value; }

/** Immutable local blobs; refs become visible only after a successful session-document CAS. */
export class SessionBlobStore<A extends BlobRef, L> {
  readonly limits: Readonly<L>;
  readonly #directory: string;
  readonly #documents: SessionBlobDocuments;
  readonly #kind: SessionBlobKind<A, L>;
  readonly #bounds: BlobBounds;
  #root?: Promise<Stats>;
  constructor(options: { directory: string; documents: SessionBlobDocuments; limits?: Partial<L> }, kind: SessionBlobKind<A, L>) {
    const config = (): never => kind.fail(kind.code + '_INVALID_CONFIG');
    plainRecord(options, ['directory', 'documents'], ['limits'], config);
    if (!canonicalPath(options.directory) || types.isProxy(options.documents) || !options.documents || typeof options.documents !== 'object') config();
    this.#directory = options.directory; this.#documents = options.documents; this.#kind = kind;
    this.limits = kind.limits(options.limits); this.#bounds = kind.bounds(this.limits);
  }
  #fail(code: string): never { return this.#kind.fail(this.#kind.code + '_' + code); }
  #mismatch(): never { return this.#kind.fail('RECORD_SCOPE_MISMATCH'); }
  #publicFailure(error: unknown): EngineError {
    const { code, message } = this.#kind;
    if (error instanceof EngineError && (error.code.startsWith(code + '_') || ['RECORD_SCOPE_MISMATCH', 'RECORD_NOT_FOUND', 'REVISION_CONFLICT'].includes(error.code))) return new EngineError(error.code, message);
    return new EngineError(code + '_STORAGE_FAILED', message);
  }
  async #managed(signal?: AbortSignal): Promise<void> {
    this.#kind.cancelled(signal);
    const onUnsafe = (): never => this.#fail('PATH_UNSAFE');
    const pinned = await (this.#root ??= symlinkFreeDirectory(this.#directory, { create: true, onUnsafe }));
    if (!stableStat(pinned, await symlinkFreeDirectory(this.#directory, { onUnsafe }))) onUnsafe();
    this.#kind.cancelled(signal);
  }
  #owner(sessionId: string): Owner {
    if (!isBoundedId(sessionId)) this.#fail('INVALID_REFERENCE');
    const session = this.#documents.getSession(sessionId);
    if (!ownerData(session,['id','workspaceId']) || typeof session.workspaceId !== 'string') this.#mismatch();
    const workspace = this.#documents.getWorkspace(session.workspaceId);
    if (!ownerData(workspace,['id','root']) || !canonicalPath(workspace.root) || session.id !== sessionId || workspace.id !== session.workspaceId) this.#mismatch();
    return { sessionId, workspaceId: workspace.id, workspaceRoot: workspace.root };
  }
  #index(owner: Owner): { revision: number; attachments: A[] } {
    const { documentKind, indexKey } = this.#kind, invalid: () => never = () => this.#fail('INVALID_INDEX');
    const document = this.#documents.getSessionDocument(owner.sessionId, documentKind);
    if (!document) return { revision: 0, attachments: [] };
    if (types.isProxy(document) || typeof document !== 'object' || !Object.hasOwn(Object.getOwnPropertyDescriptor(document,'data')??{},'value') || !Object.hasOwn(Object.getOwnPropertyDescriptor(document,'revision')??{},'value')) invalid();
    const data = plainRecord(document.data, ['version', 'owner', indexKey], [], invalid), items = data[indexKey];
    if (data.version !== 1 || !sameOwner(owner, plainRecord(data.owner, OWNER_KEYS, [], () => this.#mismatch()) as unknown as Owner)) this.#mismatch();
    if (!Number.isSafeInteger(document.revision) || document.revision < 1 || !isPlainArray(items) || items.length > this.#bounds.maxSessionItems) invalid();
    for (let i=0;i<items.length;i++) { const descriptor=Object.getOwnPropertyDescriptor(items,String(i)); if(!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) invalid(); }
    const attachments = items.map(item => this.#kind.item(item, this.limits)), ids = new Set<string>(); let bytes = 0;
    for (const item of attachments) { if (ids.has(item.id)) invalid(); ids.add(item.id); bytes += item.bytes; }
    if (bytes > this.#bounds.maxSessionBytes) this.#fail('LIMIT_EXCEEDED');
    return { revision: document.revision, attachments };
  }
  /** Every ref must be indexed for owner with exactly the same fields. */
  #indexed(owner: Owner, refs: readonly A[]): void {
    const indexed = new Map(this.#index(owner).attachments.map(item => [item.id, item]));
    for (const ref of refs) { const item = indexed.get(ref.id); if (!item || !this.#kind.same(ref, item)) this.#mismatch(); }
  }
  /** prepare validates the private copy of data and returns the ref builder for the generated id. */
  async import(sessionId: string, data: Uint8Array, signal: AbortSignal | undefined, prepare: (bytes: Buffer) => (id: string) => A): Promise<A> {
    const { cancelled } = this.#kind;
    let staging: string | undefined, published: string | undefined, known: Stats | undefined, committed = false;
    try {
      cancelled(signal);
      if (types.isProxy(data) || !(data instanceof Uint8Array) || data.byteLength > this.#bounds.maxBlobBytes) this.#fail('LIMIT_EXCEEDED');
      // Copy before the first await so host buffer mutation cannot change accepted bytes.
      const bytes = Buffer.from(data), draft = prepare(bytes);
      const owner = this.#owner(sessionId); this.#index(owner);
      await this.#managed(signal);
      const ref = draft(this.#kind.idPrefix + randomUUID().replaceAll('-', ''));
      staging = join(this.#directory, '.pending_' + ref.id); const destination = join(this.#directory, ref.id + '.blob');
      const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        known = await handle.stat();
        let position = 0;
        while (position < bytes.length) { cancelled(signal); const written = await handle.write(bytes, position, bytes.length - position, position); if (!written.bytesWritten) this.#fail('STORAGE_FAILED'); position += written.bytesWritten; }
        await handle.sync();
      } finally { await handle.close(); }
      await this.#managed(signal);
      const before = await lstat(staging); if (!stableStat(before, known) || !before.isFile() || before.nlink !== 1) this.#fail('PATH_UNSAFE');
      // Publish without replacing an existing filename, including a planted symlink.
      await link(staging, destination); published = destination;
      const linked=await lstat(staging); if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink!==2 || !stableStat(linked,known)) this.#fail('PATH_UNSAFE');
      await unlink(staging); staging = undefined;
      const final=await lstat(destination); if(!final.isFile() || final.isSymbolicLink() || final.nlink!==1 || !stableStat(final,known) || final.size!==bytes.length) this.#fail('PATH_UNSAFE');
      await syncDirectoryAsync(this.#directory); await this.#managed(signal);
      // Reads and CAS are synchronous: competing hosts either retry with a fresh index
      // or leave no visible ref. Cancellation after commit reports the durable success.
      for (let attempt = 0; attempt < 8; attempt++) {
        cancelled(signal); if (!sameOwner(owner, this.#owner(sessionId))) this.#mismatch();
        const index = this.#index(owner);
        if (index.attachments.length >= this.#bounds.maxSessionItems || index.attachments.reduce((total, item) => total + item.bytes, bytes.length) > this.#bounds.maxSessionBytes) this.#fail('LIMIT_EXCEEDED');
        const records: JsonValue[] = JSON.parse(JSON.stringify([...index.attachments, ref]));
        cancelled(signal);
        try {
          this.#documents.putSessionDocument(sessionId, this.#kind.documentKind, index.revision, { version: 1, owner: { ...owner }, [this.#kind.indexKey]: records });
          committed = true; return { ...ref };
        } catch (error) { if (!(error instanceof EngineError && error.code === 'REVISION_CONFLICT') || attempt === 7) throw error; }
      }
      return this.#fail('STORAGE_FAILED');
    } catch (error) { throw this.#publicFailure(error); }
    finally {
      if (!committed && known) for (const path of [staging, published]) if (path) {
        // Cleanup is restricted to the one generated inode. Never remove replacements.
        try { await this.#managed(); const actual = await lstat(path); if (actual.isFile() && !actual.isSymbolicLink() && stableStat(actual, known)) await unlink(path); } catch { /* Crash/failure orphans are unindexed and cannot be resolved. */ }
      }
    }
  }
  async resolve(sessionId: string, input: readonly A[], signal?: AbortSignal): Promise<{ attachment: A; data: string }[]> {
    const { cancelled } = this.#kind;
    try {
      cancelled(signal); const refs = this.#kind.refs(input, this.limits), owner = this.#owner(sessionId);
      this.#indexed(owner, refs);
      if (!refs.length) return [];
      await this.#managed(signal); const result: { attachment: A; data: string }[] = [];
      for (const ref of refs) {
        cancelled(signal); const path = join(this.#directory, ref.id + '.blob'), handle = await openSingleLinkFile(path, () => this.#fail('PATH_UNSAFE'));
        try {
          const before = await handle.stat(); if (before.size !== ref.bytes) this.#fail('INTEGRITY_FAILED');
          // Bounded allocation and explicit position reads, even for a concurrently growing file.
          const bytes = Buffer.alloc(ref.bytes); let position = 0;
          while (position < bytes.length) { cancelled(signal); const read = await handle.read(bytes, position, bytes.length - position, position); if (!read.bytesRead) this.#fail('INTEGRITY_FAILED'); position += read.bytesRead; }
          const after = await handle.stat(), current = await lstat(path);
          if (!stableStat(before, after, ['size', 'mtime', 'ctime']) || !stableStat(before, current, ['size', 'mtime', 'ctime']) || current.isSymbolicLink() || current.nlink !== 1
            || sha256Hex(bytes) !== ref.sha256) this.#fail('INTEGRITY_FAILED');
          this.#kind.validate(bytes, ref, this.limits); result.push({ attachment: { ...ref }, data: bytes.toString('base64') });
        } finally { await handle.close(); }
      }
      await this.#managed(signal); if (!sameOwner(owner, this.#owner(sessionId))) this.#mismatch();
      this.#indexed(owner, refs);
      cancelled(signal);
      return result;
    } catch (error) { throw this.#publicFailure(error); }
  }
}
