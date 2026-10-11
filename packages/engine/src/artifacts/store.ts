import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { EngineError, type ArtifactIdentity, type ArtifactReference, type JsonObject } from '@moodcode/contracts';
import { raceAbort } from '../shared/runtime.js';
import { artifactLimits, DEFAULT_ARTIFACT_RETENTION_MS, type ArtifactLimits } from './limits.js';
import { ARTIFACT_ID, artifactId, boundedJson, fail, identity, JsonBudgetError, number, positive, reference, sameIdentity, textPrefix } from './validation.js';

export type ArtifactSource = string | Uint8Array | AsyncIterable<string | Uint8Array>;
export interface ArtifactStoreOptions { directory: string; limits?: Partial<ArtifactLimits>; retentionMs?: number; now?: () => number }
export interface ArtifactInput {
  identity: ArtifactIdentity;
  content: ArtifactSource;
  mediaType?: string;
  outcome?: ArtifactReference['outcome'];
  /** False when the producer already lost bytes before calling this store. */
  sourceComplete?: boolean;
  metadata?: JsonObject;
  signal?: AbortSignal;
}
export interface StoredArtifact {
  reference: ArtifactReference;
  displayContent: string;
  modelContent: string;
  warnings: string[];
  truncation: { producerCapturedBytes: number; displayBytes: number; modelBytes: number; displayTruncated: boolean; modelTruncated: boolean };
}
export interface ArtifactPage { reference: ArtifactReference; bytes: Uint8Array; offset: number; nextOffset?: number }
export interface ArtifactReadOptions { identity?: ArtifactIdentity; offset?: number; limit?: number; signal?: AbortSignal }
export interface ArtifactPruneResult { scanned: number; removed: string[]; warnings: string[]; scanTruncated: boolean }
interface Manifest {
  version: 1;
  reference: ArtifactReference;
  mediaType: string;
  sourceComplete: boolean;
  producerCapturedBytes: number;
  metadata?: JsonObject;
}

const LEFTOVER = /^\.(?:stage|retired)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function code(error: unknown): string | undefined { return error instanceof Error && 'code' in error ? String(error.code) : undefined; }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function abort(signal?: AbortSignal): void { if (signal?.aborted) fail('ARTIFACT_CANCELLED', 'Artifact operation was cancelled'); }
function missing(error: unknown): boolean { return code(error) === 'ENOENT'; }

/** Rejects symlinks in the managed root and each existing ancestor. */
async function directoryPath(path: string, create: boolean): Promise<Stats> {
  const root = parse(path).root;
  let current = root;
  let info = await lstat(root);
  for (const segment of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try { info = await lstat(current); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (code(error) !== 'EEXIST') throw error; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('ARTIFACT_PATH_UNSAFE', 'Managed artifact directories must not be symlinks');
  }
  if (await realpath(path) !== path) fail('ARTIFACT_PATH_UNSAFE', 'Managed artifact root must be canonical');
  return info;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset).catch(() => fail('ARTIFACT_WRITE_FAILED', 'Artifact file write failed'));
    if (written.bytesWritten < 1) fail('ARTIFACT_WRITE_FAILED', 'Artifact file write made no progress');
    offset += written.bytesWritten;
  }
}
async function safeFile(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('ARTIFACT_PATH_UNSAFE', 'Managed artifact must be a regular singly linked file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || !sameFile(before, actual)) fail('ARTIFACT_PATH_UNSAFE', 'Artifact file identity changed');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function knownDirectoryCleanup(path: string): Promise<void> {
  // Never recursively remove an unverified tree or follow a replacement symlink.
  const info = await lstat(path).catch(error => { if (missing(error)) return undefined; throw error; });
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
  for (const file of ['content', 'manifest.json']) {
    await unlink(join(path, file)).catch(error => { if (!missing(error)) throw error; });
  }
  await rmdir(path).catch(error => { if (!missing(error) && code(error) !== 'ENOTEMPTY') throw error; });
}

/** Store-owned filenames never use model paths, artifact names, or execution IDs. */
export class ArtifactStore {
  readonly limits: Readonly<ArtifactLimits>;
  private constructor(private readonly directory: string, private readonly rootIdentity: Stats,
    limits: ArtifactLimits, private readonly retentionMs: number, private readonly now: () => number) {
    this.limits = Object.freeze(limits);
  }
  static async open(options: ArtifactStoreOptions): Promise<ArtifactStore> {
    if (typeof options.directory !== 'string' || !options.directory || options.directory.includes('\0')) fail('INVALID_ARTIFACT_OPTIONS', 'Artifact directory is required');
    if (!constants.O_NOFOLLOW) fail('ARTIFACT_PLATFORM_UNSUPPORTED', 'Artifact backend requires no-follow file opens');
    const directory = resolve(options.directory);
    const limits = artifactLimits(options.limits);
    const retentionMs = positive(options.retentionMs ?? DEFAULT_ARTIFACT_RETENTION_MS, 'retentionMs', 365 * 24 * 60 * 60 * 1000);
    return new ArtifactStore(directory, await directoryPath(directory, true), limits, retentionMs, options.now ?? Date.now);
  }
  private async checkRoot(): Promise<void> {
    if (!sameFile(this.rootIdentity, await directoryPath(this.directory, false))) fail('ARTIFACT_PATH_UNSAFE', 'Artifact root identity changed');
  }
  private async artifactDirectory(id: string): Promise<string> {
    await this.checkRoot();
    const path = join(this.directory, artifactId(id));
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) fail('ARTIFACT_PATH_UNSAFE', 'Artifact directory is unsafe');
    return path;
  }

  async put(input: ArtifactInput): Promise<StoredArtifact> {
    abort(input.signal);
    const owner = identity(input.identity);
    const outcome = input.outcome ?? 'completed';
    if (!['completed', 'failed', 'interrupted'].includes(outcome)) fail('INVALID_ARTIFACT', 'Invalid producer outcome');
    const sourceComplete = input.sourceComplete ?? true;
    if (typeof sourceComplete !== 'boolean') fail('INVALID_ARTIFACT', 'sourceComplete must be boolean');
    const mediaType = input.mediaType ?? 'text/plain; charset=utf-8';
    if (typeof mediaType !== 'string' || Buffer.byteLength(mediaType) > 256 || /[\u0000-\u001f\u007f]/.test(mediaType)) fail('INVALID_ARTIFACT', 'Invalid artifact media type');
    let metadata: JsonObject | undefined;
    try { metadata = input.metadata === undefined ? undefined : boundedJson(input.metadata, Math.floor(this.limits.maxMetadataBytes / 2)) as JsonObject; }
    catch (error) { if (!(error instanceof JsonBudgetError)) throw error; fail('ARTIFACT_METADATA_LIMIT', 'Artifact metadata exceeds its storage limit'); }
    if (metadata !== undefined && (metadata === null || Array.isArray(metadata) || typeof metadata !== 'object')) fail('INVALID_ARTIFACT_DATA', 'Artifact metadata must be an object');
    const created = this.now();
    if (!Number.isSafeInteger(created) || created < 0 || created + this.retentionMs > 8_640_000_000_000_000) fail('INVALID_ARTIFACT_OPTIONS', 'Invalid artifact clock');
    await this.checkRoot();
    abort(input.signal);
    const id = `artifact_${randomUUID().replaceAll('-', '')}`;
    const staging = join(this.directory, `.stage-${randomUUID()}`);
    const destination = join(this.directory, id);
    await mkdir(staging, { mode: 0o700 });
    let published = false;
    let handle: FileHandle | undefined;
    let manifestHandle: FileHandle | undefined;
    try {
      handle = await open(join(staging, 'content'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const digest = createHash('sha256');
      let observedBytes = 0;
      let capturedBytes = 0;
      let storedBytes = 0;
      const previewChunks: Buffer[] = [];
      let previewBytes = 0;
      const previewLimit = Math.max(this.limits.maxDisplayBytes, this.limits.maxModelBytes);
      let producerTruncatedBytes: number | null = 0;
      let effectiveOutcome = outcome;
      let completed = sourceComplete;
      const warnings: string[] = [];
      const capture = async (value: string | Uint8Array) => {
        if (typeof value !== 'string' && !(value instanceof Uint8Array)) fail('INVALID_ARTIFACT_DATA', 'Artifact producer must yield bytes or text');
        const length = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;
        observedBytes = number(observedBytes + length, 'observedBytes');
        const count = Math.min(length, this.limits.maxProducerBytes - capturedBytes);
        // Copy only the bounded capture; never retain a producer's reusable buffer.
        const bytes = typeof value === 'string'
          ? Buffer.from(textPrefix(value, count), 'utf8')
          : Buffer.from(value.subarray(0, count));
        capturedBytes += bytes.byteLength;
        const retained = Buffer.from(bytes.subarray(0, this.limits.maxArtifactBytes - storedBytes));
        if (retained.byteLength) { await writeAll(handle!, retained); digest.update(retained); storedBytes += retained.byteLength; }
        if (previewBytes < previewLimit) {
          const preview = Buffer.from(bytes.subarray(0, previewLimit - previewBytes));
          previewChunks.push(preview); previewBytes += preview.byteLength;
        }
        return length > bytes.byteLength;
      };
      if (typeof input.content === 'string' || input.content instanceof Uint8Array) {
        await capture(input.content);
        producerTruncatedBytes = observedBytes - capturedBytes;
      } else {
        if (!input.content || typeof input.content[Symbol.asyncIterator] !== 'function') fail('INVALID_ARTIFACT_DATA', 'Invalid artifact source');
        const iterator = input.content[Symbol.asyncIterator]();
        let exhausted = false;
        let chunks = 0;
        try {
          while (true) {
            let value: string | Uint8Array;
            // Only producer failures are captured; storage and validation errors abort the put.
            try {
              const next = await nextChunk(iterator, input.signal);
              if (next.done) { exhausted = true; break; }
              value = next.value;
            } catch {
              completed = false; producerTruncatedBytes = null;
              effectiveOutcome = input.signal?.aborted ? 'interrupted' : 'failed';
              warnings.push(input.signal?.aborted ? 'Producer was interrupted; only observed bytes were captured.' : 'Producer failed; only observed bytes were captured.');
              break;
            }
            if (++chunks > this.limits.maxProducerChunks) {
              if (typeof value !== 'string' && !(value instanceof Uint8Array)) fail('INVALID_ARTIFACT_DATA', 'Artifact producer must yield bytes or text');
              observedBytes = number(observedBytes + (typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength), 'observedBytes');
              producerTruncatedBytes = null; completed = false;
              warnings.push('Producer chunk limit was reached; remaining output was not observed.');
              break;
            }
            if (await capture(value)) {
              // Further bytes were never observed, so total producer loss is unknown.
              producerTruncatedBytes = null; completed = false; break;
            }
          }
        } finally {
          if (!exhausted && iterator.return) {
            // A producer may ignore cancellation while awaiting next(); cleanup must not wait forever.
            try { void Promise.resolve(iterator.return()).catch(() => {}); } catch {}
          }
        }
      }
      if (input.signal?.aborted) { completed = false; effectiveOutcome = 'interrupted'; }
      if (!completed) producerTruncatedBytes = null;
      const artifactTruncatedBytes = capturedBytes - storedBytes;
      if (producerTruncatedBytes === null || producerTruncatedBytes > 0) warnings.push('Producer capture is incomplete; uncaptured bytes are unavailable.');
      if (artifactTruncatedBytes) warnings.push('Artifact storage limit was reached; the retained artifact is a prefix.');
      const ref = reference({ id, identity: owner, sha256: digest.digest('hex'), storedBytes, observedBytes, producerTruncatedBytes,
        artifactTruncatedBytes, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + this.retentionMs).toISOString(),
        complete: completed && effectiveOutcome === 'completed' && producerTruncatedBytes === 0 && artifactTruncatedBytes === 0, outcome: effectiveOutcome });
      await handle.sync(); await handle.close(); handle = undefined;
      const manifest: Manifest = { version: 1, reference: ref, mediaType, sourceComplete: completed, producerCapturedBytes: capturedBytes, ...(metadata === undefined ? {} : { metadata }) };
      const encoded = Buffer.from(JSON.stringify(manifest));
      if (encoded.byteLength > this.limits.maxMetadataBytes) fail('ARTIFACT_METADATA_LIMIT', 'Artifact manifest exceeds its storage limit');
      manifestHandle = await open(join(staging, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await writeAll(manifestHandle, encoded); await manifestHandle.sync(); await manifestHandle.close(); manifestHandle = undefined;
      await syncDirectory(staging); await this.checkRoot();
      const exists = await lstat(destination).then(() => true, error => { if (missing(error)) return false; throw error; });
      if (exists) fail('ARTIFACT_ID_CONFLICT', 'Artifact destination already exists');
      await rename(staging, destination); published = true; await syncDirectory(this.directory);
      const raw = Buffer.concat(previewChunks, previewBytes).toString('utf8');
      const displayContent = textPrefix(raw, this.limits.maxDisplayBytes);
      const modelContent = textPrefix(raw, this.limits.maxModelBytes);
      const displayBytes = Buffer.byteLength(displayContent);
      const modelBytes = Buffer.byteLength(modelContent);
      return { reference: ref, displayContent, modelContent, warnings, truncation: { producerCapturedBytes: capturedBytes,
        displayBytes, modelBytes, displayTruncated: capturedBytes > previewBytes || displayContent !== raw || producerTruncatedBytes !== 0 || !completed,
        modelTruncated: capturedBytes > previewBytes || modelContent !== raw || producerTruncatedBytes !== 0 || !completed } };
    } finally {
      await handle?.close().catch(() => {}); await manifestHandle?.close().catch(() => {});
      if (!published) await knownDirectoryCleanup(staging);
    }
  }

  private async manifest(id: string, owner?: ArtifactIdentity, allowExpired = false): Promise<Manifest> {
    const path = await this.artifactDirectory(id);
    const handle = await safeFile(join(path, 'manifest.json'));
    let value: unknown;
    try {
      const info = await handle.stat();
      if (info.size > this.limits.maxMetadataBytes) fail('ARTIFACT_METADATA_LIMIT', 'Artifact manifest exceeds its read limit');
      const bytes = Buffer.alloc(this.limits.maxMetadataBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > this.limits.maxMetadataBytes || size !== info.size) fail('INVALID_ARTIFACT', 'Artifact manifest size changed');
      try { value = JSON.parse(bytes.subarray(0, size).toString('utf8')); }
      catch { fail('INVALID_ARTIFACT', 'Artifact manifest is invalid JSON'); }
    } finally { await handle.close(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARTIFACT', 'Invalid artifact manifest');
    const data = value as Manifest;
    if (data.version !== 1 || typeof data.mediaType !== 'string' || typeof data.sourceComplete !== 'boolean') fail('INVALID_ARTIFACT', 'Unsupported artifact manifest');
    const ref = reference(data.reference);
    if (ref.id !== id || ref.storedBytes > this.limits.maxArtifactBytes) fail('INVALID_ARTIFACT', 'Artifact identity or size does not match the store');
    number(data.producerCapturedBytes, 'producerCapturedBytes', this.limits.maxProducerBytes);
    if (data.producerCapturedBytes !== ref.storedBytes + ref.artifactTruncatedBytes || data.producerCapturedBytes > ref.observedBytes) fail('INVALID_ARTIFACT', 'Artifact producer accounting is inconsistent');
    if (owner && !sameIdentity(ref.identity, identity(owner))) fail('ARTIFACT_OWNER_MISMATCH', 'Artifact belongs to a different execution');
    if (!allowExpired && Date.parse(ref.expiresAt) <= this.now()) fail('ARTIFACT_EXPIRED', 'Artifact retention has expired');
    return { ...data, reference: ref };
  }
  async get(id: string, owner?: ArtifactIdentity): Promise<ArtifactReference> {
    return structuredClone((await this.manifest(id, owner)).reference);
  }
  async read(id: string, options: ArtifactReadOptions = {}): Promise<ArtifactPage> {
    abort(options.signal);
    const ref = (await this.manifest(id, options.identity)).reference;
    const offset = number(options.offset ?? 0, 'offset', ref.storedBytes);
    const limit = positive(options.limit ?? this.limits.maxReadBytes, 'limit', this.limits.maxReadBytes);
    const handle = await safeFile(join(await this.artifactDirectory(id), 'content'));
    try {
      const info = await handle.stat();
      if (info.size !== ref.storedBytes) fail('ARTIFACT_INTEGRITY_FAILED', 'Artifact content size differs from its reference');
      const digest = createHash('sha256');
      const wanted = Math.min(limit, ref.storedBytes - offset);
      const page = Buffer.alloc(wanted);
      let position = 0;
      let copied = 0;
      const chunk = Buffer.alloc(64 * 1024);
      while (position < ref.storedBytes) {
        abort(options.signal);
        const next = await handle.read(chunk, 0, Math.min(chunk.length, ref.storedBytes - position), position);
        if (!next.bytesRead) fail('ARTIFACT_INTEGRITY_FAILED', 'Artifact content was truncated during reading');
        digest.update(chunk.subarray(0, next.bytesRead));
        const start = Math.max(offset, position);
        const end = Math.min(offset + wanted, position + next.bytesRead);
        if (end > start) { chunk.copy(page, copied, start - position, end - position); copied += end - start; }
        position += next.bytesRead;
      }
      const after = await handle.stat();
      if (!sameFile(info, after) || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || digest.digest('hex') !== ref.sha256) fail('ARTIFACT_INTEGRITY_FAILED', 'Artifact content integrity check failed');
      const nextOffset = offset + wanted;
      return { reference: structuredClone(ref), bytes: page, offset, ...(nextOffset < ref.storedBytes ? { nextOffset } : {}) };
    } finally { await handle.close(); }
  }
  async prune(options: { signal?: AbortSignal } = {}): Promise<ArtifactPruneResult> {
    abort(options.signal); await this.checkRoot();
    const result: ArtifactPruneResult = { scanned: 0, removed: [], warnings: [], scanTruncated: false };
    const warn = (message: string) => { if (result.warnings.length < 32) result.warnings.push(message); };
    let cleaned = false;
    const entries = await opendir(this.directory);
    for await (const entry of entries) {
      abort(options.signal);
      if (result.scanned >= this.limits.maxScanEntries) { result.scanTruncated = true; break; }
      result.scanned++;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (LEFTOVER.test(entry.name)) {
        // A staging directory may belong to a concurrent put until it outlives the retention window.
        try {
          const path = join(this.directory, entry.name);
          if (entry.name.startsWith('.stage-') && this.now() - (await lstat(path)).mtimeMs <= this.retentionMs) continue;
          await this.checkRoot(); await knownDirectoryCleanup(path); cleaned = true;
        } catch { warn(`Skipped leftover ${entry.name}: its managed path could not be removed.`); }
        continue;
      }
      if (!ARTIFACT_ID.test(entry.name)) continue;
      try {
        const manifest = await this.manifest(entry.name, undefined, true);
        if (Date.parse(manifest.reference.expiresAt) > this.now()) continue;
        const source = await this.artifactDirectory(entry.name);
        const retired = join(this.directory, `.retired-${randomUUID()}`);
        await rename(source, retired);
        await knownDirectoryCleanup(retired);
        result.removed.push(entry.name);
      } catch { warn(`Skipped artifact ${entry.name}: its manifest or managed path could not be verified.`); }
    }
    if (result.removed.length || cleaned) await syncDirectory(this.directory);
    return result;
  }
}

async function nextChunk(iterator: AsyncIterator<string | Uint8Array>, signal?: AbortSignal): Promise<IteratorResult<string | Uint8Array>> {
  abort(signal);
  if (!signal) return iterator.next();
  return raceAbort(Promise.resolve(iterator.next()), signal, () => new EngineError('ARTIFACT_CANCELLED', 'Artifact producer was interrupted'));
}
