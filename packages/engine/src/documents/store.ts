import { types } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { EngineError, type InputDocumentAttachment, type JsonObject, type Session, type Workspace } from '@moodcode/contracts';
import type { ResolvedInputDocument } from '../ports.js';
import { attachment, attachments, cancelled, digest, fail, documentLimits, sameAttachment, validateDocumentBytes, type DocumentLimits } from './validation.js';

export const INPUT_DOCUMENT_KIND = 'input_documents';
export interface DocumentDocuments {
  getSession(id: string): Session;
  getWorkspace(id: string): Workspace;
  getSessionDocument(sessionId: string, kind: string): { revision: number; data: JsonObject } | null;
  putSessionDocument(sessionId: string, kind: string, expectedRevision: number, data: JsonObject): { revision: number; data: JsonObject };
}
export interface DocumentAttachmentStoreOptions { directory: string; documents: DocumentDocuments; limits?: Partial<DocumentLimits> }
interface Owner { sessionId: string; workspaceId: string; workspaceRoot: string }
interface Index { revision: number; owner: Owner; attachments: InputDocumentAttachment[] }
function ownerData(value: unknown, keys: readonly string[]): value is Record<string,unknown> { return !types.isProxy(value) && value !== null && typeof value === 'object' && !Array.isArray(value) && keys.every(key => { const property=Object.getOwnPropertyDescriptor(value,key); return property?.enumerable && Object.hasOwn(property,'value'); }); }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function errno(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
function sameOwner(left: Owner, right: Owner): boolean { return left.sessionId === right.sessionId && left.workspaceId === right.workspaceId && left.workspaceRoot === right.workspaceRoot; }
async function directoryPath(path: string, create: boolean): Promise<Stats> {
  let current = parse(path).root, info = await lstat(current);
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { info = await lstat(current); }
    catch (error) {
      if (!create || !errno(error, 'ENOENT')) throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (!errno(error, 'EEXIST')) throw error; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('DOCUMENT_PATH_UNSAFE');
  }
  if (await realpath(path) !== path) fail('DOCUMENT_PATH_UNSAFE');
  return info;
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}
async function safeFile(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('DOCUMENT_PATH_UNSAFE');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const after = await handle.stat(); if (!after.isFile() || after.nlink !== 1 || !sameFile(before, after)) fail('DOCUMENT_PATH_UNSAFE'); return handle; }
  catch (error) { await handle.close(); throw error; }
}
function publicFailure(error: unknown): EngineError {
  if (error instanceof EngineError && (error.code.startsWith('DOCUMENT_') || ['RECORD_SCOPE_MISMATCH', 'RECORD_NOT_FOUND', 'REVISION_CONFLICT'].includes(error.code))) return new EngineError(error.code, 'Document input operation failed.');
  return new EngineError('DOCUMENT_STORAGE_FAILED', 'Document input operation failed.');
}

/** Immutable local blobs; refs become visible only after a successful session-document CAS. */
export class DocumentAttachmentStore {
  readonly limits: Readonly<DocumentLimits>;
  readonly #directory: string;
  readonly #documents: DocumentDocuments;
  #root?: Promise<Stats>;
  constructor(options: DocumentAttachmentStoreOptions) {
    if (types.isProxy(options) || !options || typeof options !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(options))
      || Reflect.ownKeys(options).some(key=> typeof key !== 'string' || !['directory','documents','limits'].includes(key) || !Object.getOwnPropertyDescriptor(options,key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(options,key)!,'value'))) fail('DOCUMENT_INVALID_CONFIG');
    if (typeof options.directory !== 'string' || !isAbsolute(options.directory) || options.directory.includes('\0') || Buffer.byteLength(options.directory) > 4096 || options.directory !== resolve(options.directory)) fail('DOCUMENT_INVALID_CONFIG');
    if (types.isProxy(options.documents) || !options.documents || typeof options.documents !== 'object') fail('DOCUMENT_INVALID_CONFIG');
    this.#directory = options.directory; this.#documents = options.documents; this.limits = documentLimits(options.limits);
  }
  async #managed(signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    const pinned = await (this.#root ??= directoryPath(this.#directory, true));
    const actual = await directoryPath(this.#directory, false);
    if (!sameFile(pinned, actual)) fail('DOCUMENT_PATH_UNSAFE'); cancelled(signal);
  }
  #owner(sessionId: string): Owner {
    if (typeof sessionId !== 'string' || !sessionId || Buffer.byteLength(sessionId) > 256 || /[\u0000-\u001f\u007f]/u.test(sessionId)) fail('DOCUMENT_INVALID_REFERENCE');
    const session = this.#documents.getSession(sessionId);
    if (!ownerData(session,['id','workspaceId']) || typeof session.workspaceId !== 'string') fail('RECORD_SCOPE_MISMATCH');
    const workspace = this.#documents.getWorkspace(session.workspaceId);
    if (!ownerData(workspace,['id','root']) || typeof workspace.root !== 'string' || session.id !== sessionId || workspace.id !== session.workspaceId || !isAbsolute(workspace.root) || resolve(workspace.root) !== workspace.root || workspace.root.includes('\0') || Buffer.byteLength(workspace.root) > 4096) fail('RECORD_SCOPE_MISMATCH');
    return { sessionId, workspaceId: workspace.id, workspaceRoot: workspace.root };
  }
  #index(owner: Owner): Index {
    const document = this.#documents.getSessionDocument(owner.sessionId, INPUT_DOCUMENT_KIND);
    if (!document) return { revision: 0, owner, attachments: [] };
    if (types.isProxy(document) || !document || typeof document !== 'object' || !Object.hasOwn(Object.getOwnPropertyDescriptor(document,'data')??{},'value') || !Object.hasOwn(Object.getOwnPropertyDescriptor(document,'revision')??{},'value')) fail('DOCUMENT_INVALID_INDEX');
    const data = document.data;
    if (types.isProxy(data) || !data || typeof data !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(data)) || Reflect.ownKeys(data).length !== 3
      || ['version','owner','documents'].some(key => !Object.getOwnPropertyDescriptor(data,key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(data,key)!, 'value'))) fail('DOCUMENT_INVALID_INDEX');
    const storedOwner = data.owner;
    if (data.version !== 1 || Object.keys(data).some(key => !['version', 'owner', 'documents'].includes(key))
      || types.isProxy(storedOwner) || storedOwner === null || typeof storedOwner !== 'object' || Array.isArray(storedOwner)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(storedOwner)) || Reflect.ownKeys(storedOwner).length !== 3
      || ['sessionId','workspaceId','workspaceRoot'].some(key => !Object.getOwnPropertyDescriptor(storedOwner,key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(storedOwner,key)!, 'value')) || !sameOwner(owner, storedOwner as unknown as Owner)) fail('RECORD_SCOPE_MISMATCH');
    if (!Number.isSafeInteger(document.revision) || document.revision < 1 || types.isProxy(data.documents) || !Array.isArray(data.documents) || Object.getPrototypeOf(data.documents) !== Array.prototype || Reflect.ownKeys(data.documents).length !== data.documents.length + 1 || data.documents.length > this.limits.maxSessionDocuments) fail('DOCUMENT_INVALID_INDEX');
    for (let i=0;i<data.documents.length;i++) { const descriptor=Object.getOwnPropertyDescriptor(data.documents,String(i)); if(!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) fail('DOCUMENT_INVALID_INDEX'); }
    const items = data.documents.map(item => attachment(item, this.limits)), ids = new Set<string>(); let bytes = 0;
    for (const item of items) { if (ids.has(item.id)) fail('DOCUMENT_INVALID_INDEX'); ids.add(item.id); bytes += item.bytes; }
    if (bytes > this.limits.maxSessionBytes) fail('DOCUMENT_LIMIT_EXCEEDED');
    return { revision: document.revision, owner, attachments: items };
  }
  async import(sessionId: string, data: Uint8Array, signal?: AbortSignal): Promise<InputDocumentAttachment> {
    let staging: string | undefined, published: string | undefined, known: Stats | undefined, committed = false;
    try {
      cancelled(signal);
      if (types.isProxy(data) || !(data instanceof Uint8Array) || data.byteLength > this.limits.maxDocumentBytes) fail('DOCUMENT_LIMIT_EXCEEDED');
      // Copy before the first await so host buffer mutation cannot change accepted bytes.
      const bytes = Buffer.from(data); validateDocumentBytes(bytes, 'application/pdf', this.limits);
      const owner = this.#owner(sessionId); this.#index(owner);
      await this.#managed(signal);
      const ref: InputDocumentAttachment = { id: 'doc_' + randomUUID().replaceAll('-', ''), kind: 'document', mimeType: 'application/pdf', bytes: bytes.byteLength, sha256: digest(bytes) };
      staging = join(this.#directory, '.pending_' + ref.id); const destination = join(this.#directory, ref.id + '.blob');
      const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        known = await handle.stat();
        let position = 0;
        while (position < bytes.length) { cancelled(signal); const written = await handle.write(bytes, position, bytes.length - position, position); if (!written.bytesWritten) fail('DOCUMENT_STORAGE_FAILED'); position += written.bytesWritten; }
        await handle.sync();
      } finally { await handle.close(); }
      await this.#managed(signal);
      const before = await lstat(staging); if (!sameFile(before, known) || !before.isFile() || before.nlink !== 1) fail('DOCUMENT_PATH_UNSAFE');
      // Publish without replacing an existing filename, including a planted symlink.
      await link(staging, destination); published = destination;
      const linked=await lstat(staging); if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink!==2 || !sameFile(linked,known)) fail('DOCUMENT_PATH_UNSAFE');
      await unlink(staging); staging = undefined;
      const final=await lstat(destination); if(!final.isFile() || final.isSymbolicLink() || final.nlink!==1 || !sameFile(final,known) || final.size!==bytes.length) fail('DOCUMENT_PATH_UNSAFE');
      await syncDirectory(this.#directory); await this.#managed(signal);
      // Reads and CAS are synchronous: competing hosts either retry with a fresh index
      // or leave no visible ref. Cancellation after commit reports the durable success.
      for (let attempt = 0; attempt < 8; attempt++) {
        cancelled(signal); if (!sameOwner(owner, this.#owner(sessionId))) fail('RECORD_SCOPE_MISMATCH');
        const index = this.#index(owner);
        if (index.attachments.length >= this.limits.maxSessionDocuments || index.attachments.reduce((total, item) => total + item.bytes, bytes.length) > this.limits.maxSessionBytes) fail('DOCUMENT_LIMIT_EXCEEDED');
        cancelled(signal);
        try {
          this.#documents.putSessionDocument(sessionId, INPUT_DOCUMENT_KIND, index.revision, { version: 1, owner: { ...owner }, documents: [...index.attachments, ref].map(item => ({ ...item })) });
          committed = true; return { ...ref };
        } catch (error) { if (!(error instanceof EngineError && error.code === 'REVISION_CONFLICT') || attempt === 7) throw error; }
      }
      return fail('DOCUMENT_STORAGE_FAILED');
    } catch (error) { throw publicFailure(error); }
    finally {
      if (!committed && known) for (const path of [staging, published]) if (path) {
        // Cleanup is restricted to the one generated inode. Never remove replacements.
        try { await this.#managed(); const actual = await lstat(path); if (actual.isFile() && !actual.isSymbolicLink() && sameFile(actual, known)) await unlink(path); } catch { /* Crash/failure orphans are unindexed and cannot be resolved. */ }
      }
    }
  }
  async resolve(sessionId: string, input: readonly InputDocumentAttachment[], signal?: AbortSignal): Promise<ResolvedInputDocument[]> {
    try {
      cancelled(signal); const refs = attachments(input, this.limits), owner = this.#owner(sessionId), index = this.#index(owner);
      const indexed = new Map(index.attachments.map(item => [item.id, item]));
      for (const ref of refs) if (!indexed.has(ref.id) || !sameAttachment(ref, indexed.get(ref.id)!)) fail('RECORD_SCOPE_MISMATCH');
      if (!refs.length) return [];
      await this.#managed(signal); const result: ResolvedInputDocument[] = [];
      for (const ref of refs) {
        cancelled(signal); const path = join(this.#directory, ref.id + '.blob'), handle = await safeFile(path);
        try {
          const before = await handle.stat(); if (before.size !== ref.bytes) fail('DOCUMENT_INTEGRITY_FAILED');
          // Bounded allocation and explicit position reads, even for a concurrently growing file.
          const bytes = Buffer.alloc(ref.bytes); let position = 0;
          while (position < bytes.length) { cancelled(signal); const read = await handle.read(bytes, position, bytes.length - position, position); if (!read.bytesRead) fail('DOCUMENT_INTEGRITY_FAILED'); position += read.bytesRead; }
          const after = await handle.stat(), current = await lstat(path);
          if (!sameFile(before, after) || !sameFile(before, current) || current.isSymbolicLink() || current.nlink !== 1
            || after.size !== before.size || current.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs
            || digest(bytes) !== ref.sha256) fail('DOCUMENT_INTEGRITY_FAILED');
          validateDocumentBytes(bytes, ref.mimeType, this.limits); result.push({ attachment: { ...ref }, data: bytes.toString('base64') });
        } finally { await handle.close(); }
      }
      await this.#managed(signal); if (!sameOwner(owner, this.#owner(sessionId))) fail('RECORD_SCOPE_MISMATCH');
      const latest = new Map(this.#index(owner).attachments.map(item => [item.id, item]));
      for (const ref of refs) if (!latest.has(ref.id) || !sameAttachment(ref, latest.get(ref.id)!)) fail('RECORD_SCOPE_MISMATCH');
      cancelled(signal);
      return result;
    } catch (error) { throw publicFailure(error); }
  }
}
