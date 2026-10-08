import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { EngineError, type JsonObject } from '@moodcode/contracts';

const MAX_FILES = 32;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_PREVIEW_BYTES = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export const PHYSICAL_PATCH_LIMITS = Object.freeze({ files: MAX_FILES, fileBytes: MAX_FILE_BYTES, combinedBytes: MAX_TOTAL_BYTES });
export interface PhysicalPatchBinding { readonly workspaceId: string; readonly root: string; readonly rootDevice: string; readonly rootInode: string }
export interface PhysicalPatchChange { readonly path: string; readonly expectedHash: string | null; readonly content: string | null }
export interface PhysicalPatchCapture { readonly id: string }
export interface PhysicalPatchResult { readonly id: string }
export interface PhysicalPatchObservation {
  readonly state: 'applied' | 'partial' | 'uncertain';
  readonly files: readonly { readonly path: string; readonly attempted: boolean; readonly before: string | null; readonly beforeHash: string | null;
    readonly after: string | null; readonly afterHash: string | null; readonly mayHaveChanged: boolean; readonly observationComplete: boolean }[];
  readonly createdParentCount: number; readonly createdParents: readonly string[]; readonly createdParentsComplete: boolean;
  readonly attemptedFileCount: number; readonly incomplete: boolean; readonly cleanupConfirmed: boolean;
  readonly warnings: readonly string[]; readonly errorCode: string | null; readonly errorMessage: string | null;
}

interface Change { path: string; expectedHash: string | null; content: string | null }
interface Image { content: string | null; hash: string | null; stat?: Stats }
interface PhysicalOperation { signal: AbortSignal }
interface IoTracker { opened: Set<FileHandle>; cleanupConfirmed: boolean }
interface PhysicalRecord {
  binding: PhysicalPatchBinding; changes: Change[]; before: Image[]; pins: unknown;
  sourceSha256: string; physicalPinsSha256: string; state: 'prepared' | 'applying' | 'finished' | 'released';
}
async function closeHandle(handle: FileHandle, tracker: IoTracker): Promise<void> {
  try { await handle.close(); tracker.opened.delete(handle); }
  catch (error) { tracker.cleanupConfirmed = false; throw new EngineError('PATCH_CLEANUP_UNCERTAIN', 'An original patch descriptor could not be confirmed closed', { cause: errorText(error) }); }
}

function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hash(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }
function assertActive(context: PhysicalOperation): void {
  if (context.signal.aborted) throw new EngineError('CANCELLED', 'Patch was cancelled');
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !types.isProxy(value) && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === expected.length && expected.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key]!, 'value'));
}
function parts(relative: string): string[] {
  if (!relative || Buffer.byteLength(relative, 'utf8') > MAX_PATH_BYTES || Buffer.from(relative, 'utf8').toString('utf8') !== relative || relative.includes('\0') || relative.includes('\\') || relative.includes(':') || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new EngineError('INVALID_PATCH_PATH', 'Patch paths must be bounded workspace-relative paths');
  }
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || ['.git', 'node_modules'].includes(segment.toLowerCase()))) {
    throw new EngineError('INVALID_PATCH_PATH', 'Patch path contains an unsafe or excluded component');
  }
  return segments;
}
function parse(input: unknown): Change[] {
  if (!object(input) || !keys(input, ['changes']) || !Array.isArray(input.changes) || types.isProxy(input.changes) || input.changes.length === 0 || input.changes.length > MAX_FILES) {
    throw new EngineError('INVALID_PATCH_INPUT', `A patch requires between 1 and ${MAX_FILES} full-content changes`);
  }
  if (types.isProxy(input.changes) || Object.getPrototypeOf(input.changes) !== Array.prototype) throw new EngineError('INVALID_PATCH_INPUT', 'Patch changes must be original plain data');
  const descriptors = Object.getOwnPropertyDescriptors(input.changes);
  if (Reflect.ownKeys(descriptors).length !== input.changes.length + 1 || Array.from({length:input.changes.length}, (_,i) => descriptors[String(i)]).some(d => !d?.enumerable || !Object.hasOwn(d, 'value'))) throw new EngineError('INVALID_PATCH_INPUT', 'Patch changes must have complete data entries');
  const changes: Change[] = [];
  let bytes = 0;
  for (const item of input.changes) {
    if (!object(item) || !keys(item, ['path', 'expectedHash', 'content']) || typeof item.path !== 'string'
      || !(item.expectedHash === null || typeof item.expectedHash === 'string' && SHA256.test(item.expectedHash))
      || !(item.content === null || typeof item.content === 'string')) {
      throw new EngineError('INVALID_PATCH_INPUT', 'Each change requires path, expectedHash (SHA-256 or null), and content (string or null)');
    }
    parts(item.path);
    if (item.expectedHash === null && item.content === null) throw new EngineError('INVALID_PATCH_INPUT', 'Deleting an absent file is not a supported change');
    if (typeof item.content === 'string') {
      const encoded = Buffer.from(item.content, 'utf8');
      if (item.content.includes('\0') || encoded.toString('utf8') !== item.content) throw new EngineError('INVALID_PATCH_INPUT', 'Patch content must be valid UTF-8 text without NUL bytes');
      bytes += encoded.byteLength;
      if (encoded.byteLength > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) throw new EngineError('PATCH_LIMIT_EXCEEDED', 'Patch content exceeds the byte limit');
    }
    const candidate = item.path.toLowerCase();
    if (changes.some((change) => {
      const other = change.path.toLowerCase();
      return candidate === other || candidate.startsWith(`${other}/`) || other.startsWith(`${candidate}/`);
    })) throw new EngineError('INVALID_PATCH_INPUT', 'Patch targets overlap or repeat (including case aliases)');
    changes.push({ path: item.path, expectedHash: item.expectedHash, content: item.content });
  }
  return changes;
}

async function rootIsSafe(root: string): Promise<void> {
  const info = await fs.lstat(root);
  if (path.resolve(root) !== root || info.isSymbolicLink() || !info.isDirectory() || await fs.realpath(root) !== root) {
    throw new EngineError('UNSAFE_PATCH_PATH', 'Workspace root is no longer its canonical directory');
  }
}
async function targetPath(root: string, relative: string, createParents = false, context?: PhysicalOperation, onDirectoryCreated?: (relative: string) => void): Promise<string> {
  const segments = parts(relative);
  await rootIsSafe(root);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (context) assertActive(context);
    current = path.join(current, segment);
    let info: Stats;
    try { info = await fs.lstat(current); }
    catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      if (!createParents) continue;
      if (context) assertActive(context);
      try { await fs.mkdir(current); onDirectoryCreated?.(path.relative(root, current).split(path.sep).join('/')); }
      catch (mkdirError) { if (code(mkdirError) !== 'EEXIST') throw mkdirError; }
      if (context) assertActive(context);
      info = await fs.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new EngineError('UNSAFE_PATCH_PATH', 'Patch parent is a symlink or is not a directory');
  }
  return path.join(root, ...segments);
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameObservation(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.nlink === 1;
}
async function readHandle(handle: FileHandle): Promise<Image> {
  const initial = await handle.stat();
  if (!initial.isFile() || initial.nlink !== 1) throw new EngineError('UNSAFE_PATCH_PATH', 'Patch target must be a regular file with a single link');
  if (initial.size > MAX_FILE_BYTES) throw new EngineError('PATCH_LIMIT_EXCEEDED', 'Existing target exceeds the file byte limit');
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_FILE_BYTES) throw new EngineError('PATCH_LIMIT_EXCEEDED', 'Existing target exceeds the file byte limit');
  const bytes = buffer.subarray(0, offset);
  const content = bytes.toString('utf8');
  if (content.includes('\0') || !Buffer.from(content, 'utf8').equals(bytes)) throw new EngineError('UNSUPPORTED_PATCH_FILE', 'Patch targets must contain valid UTF-8 text without NUL bytes');
  const observed = await handle.stat();
  if (!sameObservation(initial, observed)) throw new EngineError('PATCH_PREIMAGE_MISMATCH', 'Target changed while its content was being read');
  return { content, hash: hash(content), stat: observed };
}
async function openImage(root: string, relative: string, tracker: IoTracker, writable = false): Promise<{ absolute: string; image: Image; handle?: FileHandle }> {
  const absolute = await targetPath(root, relative);
  let initial: Stats;
  try { initial = await fs.lstat(absolute); }
  catch (error) { if (code(error) === 'ENOENT') return { absolute, image: { content: null, hash: null } }; throw error; }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new EngineError('UNSAFE_PATCH_PATH', 'Patch target must be a regular file with a single link');
  let handle: FileHandle;
  try { handle = await fs.open(absolute, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK); tracker.opened.add(handle); }
  catch (error) {
    if (['ELOOP', 'ENOENT', 'EISDIR'].includes(code(error) ?? '')) throw new EngineError('PATCH_PREIMAGE_MISMATCH', 'Target changed while it was being opened');
    throw error;
  }
  try {
    if (!sameFile(initial, await handle.stat())) throw new EngineError('PATCH_PREIMAGE_MISMATCH', 'Target identity changed while it was being opened');
    const image = await readHandle(handle);
    await targetPath(root, relative);
    const current = await fs.lstat(absolute);
    if (!image.stat || !current.isFile() || !sameObservation(image.stat, current)) throw new EngineError('PATCH_PREIMAGE_MISMATCH', 'Target path or content changed while being checked');
    return { absolute, image, handle };
  } catch (error) { await closeHandle(handle, tracker); throw error; }
}
async function observe(root: string, relative: string, tracker: IoTracker): Promise<Image> {
  const target = await openImage(root, relative, tracker);
  if (target.handle) await closeHandle(target.handle, tracker);
  return target.image;
}
function checkExpected(change: Change, image: Image, preparedBefore?: Image): void {
  if (image.hash !== change.expectedHash || preparedBefore && image.content !== preparedBefore.content) {
    throw new EngineError('PATCH_PREIMAGE_MISMATCH', `Current content of ${change.path} does not match the expected preimage; existing edits were preserved`);
  }
  if (preparedBefore?.stat && (!image.stat || !sameFile(preparedBefore.stat, image.stat))) {
    throw new EngineError('PATCH_PREIMAGE_MISMATCH', `Target identity of ${change.path} changed after preparation`);
  }
}
function imageLines(content: string | null, prefix: string): string {
  if (content === null) return '';
  const lines = content.split('\n');
  return lines.slice(0, 8).map((line) => `${prefix}${line.slice(0, 160)}`).join('\n')
    + (lines.length > 8 ? `\n${prefix}… (${lines.length - 8} more lines)` : '');
}
function preview(changes: Change[], before: Image[]): JsonObject {
  const files: JsonObject[] = changes.map((change, index) => {
    const image = before[index]!;
    return {
      path: change.path, operation: image.hash === null ? 'create' : change.content === null ? 'delete' : 'update',
      beforeHash: image.hash, afterHash: change.content === null ? null : hash(change.content),
      beforeBytes: image.content === null ? 0 : Buffer.byteLength(image.content, 'utf8'),
      afterBytes: change.content === null ? 0 : Buffer.byteLength(change.content, 'utf8'),
      diff: `--- ${image.content === null ? '/dev/null' : `a/${change.path}`}\n+++ ${change.content === null ? '/dev/null' : `b/${change.path}`}\n${imageLines(image.content, '-')}${image.content !== null && change.content !== null ? '\n' : ''}${imageLines(change.content, '+')}`,
    };
  });
  const result: JsonObject = { format: 'bounded full-content preview', fileCount: files.length, files, truncated: changes.some((change, index) => (change.content?.split('\n').length ?? 0) > 8 || (before[index]!.content?.split('\n').length ?? 0) > 8 || (change.content?.split('\n') ?? []).some((line) => line.length > 160) || (before[index]!.content?.split('\n') ?? []).some((line) => line.length > 160)) };
  for (let index = files.length - 1; Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PREVIEW_BYTES && index >= 0; index--) {
    files[index]!.diff = '(preview omitted to stay within the byte limit)';
    result.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PREVIEW_BYTES) throw new EngineError('PATCH_LIMIT_EXCEEDED', 'Patch target metadata exceeds the approval preview byte limit; use a smaller batch');
  return result;
}

async function apply(change: Change, before: Image, request: PhysicalRecord, context: PhysicalOperation, tracker: IoTracker, effectStarted: () => void, directoryCreated: (relative: string) => void): Promise<void> {
  assertActive(context);
  const target = await openImage(request.binding.root, change.path, tracker, change.content !== null && before.hash !== null);
  try {
    checkExpected(change, target.image, before);
    if (change.content === before.content) return;
    assertActive(context);
    if (before.hash === null) {
      const absolute = await targetPath(request.binding.root, change.path, true, context, directoryCreated);
      assertActive(context);
      let handle: FileHandle;
      try { handle = await fs.open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666); tracker.opened.add(handle); }
      catch (error) {
        if (['EEXIST', 'ELOOP', 'ENOENT'].includes(code(error) ?? '')) throw new EngineError('PATCH_PREIMAGE_MISMATCH', `Target ${change.path} or its parent changed before creation`);
        throw error;
      }
      effectStarted();
      try { await handle.writeFile(change.content!, 'utf8'); await handle.sync(); }
      finally { await closeHandle(handle, tracker); }
    } else if (target.handle && target.image.stat) {
      await targetPath(request.binding.root, change.path);
      const current = await fs.lstat(target.absolute);
      if (!sameObservation(target.image.stat, current) || !sameObservation(target.image.stat, await target.handle.stat())) throw new EngineError('PATCH_PREIMAGE_MISMATCH', `Target ${change.path} changed immediately before application`);
      assertActive(context);
      if (change.content === null) { effectStarted(); await fs.unlink(target.absolute); }
      else {
        const content = Buffer.from(change.content, 'utf8');
        let offset = 0;
        while (offset < content.length) {
          assertActive(context);
          effectStarted();
          const result = await target.handle.write(content, offset, content.length - offset, offset);
          if (result.bytesWritten === 0) throw new Error('Patch write made no progress');
          offset += result.bytesWritten;
        }
        effectStarted();
        await target.handle.truncate(content.length);
        await target.handle.sync();
      }
    }
  } finally { if (target.handle) await closeHandle(target.handle, tracker); }
}

/** Original physical capabilities contain no Session, Run, approval or SQL owner. */
export class PhysicalPatchProducer {
  readonly limits = PHYSICAL_PATCH_LIMITS;
  readonly #captures = new WeakMap<object, PhysicalRecord>();
  readonly #results = new WeakMap<object, PhysicalPatchObservation>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #unclosed = new Set<FileHandle>();
  readonly #closing = new AbortController();

  private original(original: object): PhysicalRecord {
    const record = this.#captures.get(original);
    if (!record || record.state === 'released' || this.#closing.signal.aborted) throw new EngineError('INVALID_PREPARED_PATCH', 'An original live physical patch capture is required');
    return record;
  }
  private task<T>(signal: AbortSignal, operation: (signal: AbortSignal, tracker: IoTracker) => Promise<T>): Promise<T> {
    if (this.#closing.signal.aborted) return Promise.reject(new EngineError('ENGINE_CLOSED', 'Physical patch producer is closing'));
    if (this.#pending.size >= 64) return Promise.reject(new EngineError('PATCH_LIMIT_EXCEEDED', 'Physical patch producer capacity is exhausted'));
    const combined = AbortSignal.any([signal, this.#closing.signal]);
    const tracker: IoTracker = { opened: new Set(), cleanupConfirmed: true };
    const task = operation(combined, tracker).finally(() => { for (const handle of tracker.opened) this.#unclosed.add(handle); });
    this.#pending.add(task); void task.finally(() => this.#pending.delete(task)).catch(() => {});
    return task;
  }
  private async bindingCurrent(binding: PhysicalPatchBinding): Promise<void> {
    await rootIsSafe(binding.root);
    const root = await fs.lstat(binding.root);
    if (String(root.dev) !== binding.rootDevice || String(root.ino) !== binding.rootInode) throw new EngineError('PATCH_APPROVAL_STALE', 'The original physical workspace root changed');
  }
  private async pins(binding: PhysicalPatchBinding, changes: readonly Change[], before: readonly Image[]): Promise<unknown> {
    await this.bindingCurrent(binding);
    const parents: { path: string; dev: string | null; ino: string | null }[] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      await targetPath(binding.root, change.path);
      const segments = parts(change.path);
      for (let count = 1; count < segments.length; count++) {
        const relative = segments.slice(0, count).join('/'); if (seen.has(relative)) continue; seen.add(relative);
        try { const parent = await fs.lstat(path.join(binding.root, relative));
          if (!parent.isDirectory() || parent.isSymbolicLink()) throw new EngineError('UNSAFE_PATCH_PATH', 'Patch parent changed');
          parents.push({ path: relative, dev: String(parent.dev), ino: String(parent.ino) });
        } catch (error) { if (code(error) !== 'ENOENT') throw error; parents.push({ path: relative, dev: null, ino: null }); }
      }
    }
    return { binding, parents, files: before.map(image => image.stat ? { dev: String(image.stat.dev), ino: String(image.stat.ino), size: image.stat.size, mtimeMs: image.stat.mtimeMs, ctimeMs: image.stat.ctimeMs } : null) };
  }
  prepare(binding: PhysicalPatchBinding, changes: readonly PhysicalPatchChange[], signal: AbortSignal): Promise<PhysicalPatchCapture> {
    return this.task(signal, async (current, tracker) => {
      assertActive({ signal: current });
      if (!object(binding) || !keys(binding as unknown as Record<string, unknown>, ['workspaceId','root','rootDevice','rootInode'])
        || typeof binding.workspaceId !== 'string' || !binding.workspaceId || typeof binding.root !== 'string'
        || typeof binding.rootDevice !== 'string' || !/^\d+$/u.test(binding.rootDevice) || typeof binding.rootInode !== 'string' || !/^\d+$/u.test(binding.rootInode)) throw new EngineError('INVALID_PATCH_INPUT', 'Physical patch binding must be exact bounded host data');
      const ownedBinding = { ...binding }, validated = parse({ changes }), before: Image[] = [];
      await this.bindingCurrent(ownedBinding); let bytes = 0;
      for (const change of validated) {
        assertActive({ signal: current }); const image = await observe(ownedBinding.root, change.path, tracker); checkExpected(change, image);
        bytes += Buffer.byteLength(image.content ?? '', 'utf8') + Buffer.byteLength(change.content ?? '', 'utf8');
        if (bytes > MAX_TOTAL_BYTES) throw new EngineError('PATCH_LIMIT_EXCEEDED', 'Combined patch preimages and replacements exceed the byte limit');
        if (image.stat && before.some(other => other.stat && sameFile(other.stat, image.stat!))) throw new EngineError('INVALID_PATCH_INPUT', 'Patch paths alias the same file');
        before.push(image);
      }
      const pins = await this.pins(ownedBinding, validated, before); assertActive({ signal: current });
      const original = Object.freeze({ id: randomUUID() });
      this.#captures.set(original, { binding: ownedBinding, changes: validated, before, pins,
        sourceSha256: hash(JSON.stringify({ binding: ownedBinding, changes: validated, before: before.map(image => ({ content: image.content, hash: image.hash })) })),
        physicalPinsSha256: hash(JSON.stringify(pins)), state: 'prepared' });
      return original;
    });
  }
  read(original: object) {
    const record = this.original(original);
    return structuredClone({ binding: record.binding, changes: record.changes, sourceSha256: record.sourceSha256,
      physicalPinsSha256: record.physicalPinsSha256, preview: preview(record.changes, record.before) });
  }
  private async fresh(record: PhysicalRecord, signal: AbortSignal, tracker: IoTracker): Promise<void> {
    assertActive({ signal }); await this.bindingCurrent(record.binding); const observations: Image[] = [];
    for (let index = 0; index < record.changes.length; index++) {
      assertActive({ signal }); const image = await observe(record.binding.root, record.changes[index]!.path, tracker);
      checkExpected(record.changes[index]!, image, record.before[index]); observations.push(image);
    }
    if (hash(JSON.stringify(await this.pins(record.binding, record.changes, observations))) !== record.physicalPinsSha256) throw new EngineError('PATCH_APPROVAL_STALE', 'Original physical patch identities changed');
    assertActive({ signal });
  }
  assertFresh(original: object, signal: AbortSignal): Promise<void> {
    return this.task(signal, (current, tracker) => this.fresh(this.original(original), current, tracker));
  }
  apply(original: object, options: { readonly signal: AbortSignal; readonly beforeEffect: () => Promise<void> }): Promise<PhysicalPatchResult> {
    return this.task(options.signal, async (signal, tracker) => {
      const record = this.original(original);
      if (record.state !== 'prepared') throw new EngineError('INVALID_PREPARED_PATCH', 'A physical patch can be applied only once');
      record.state = 'applying';
      try {
        await this.fresh(record, signal, tracker);
        await options.beforeEffect();
        let failure: unknown, createdParentCount = 0;
        const createdParents: string[] = [], warnings: string[] = [];
        const attempted: { change: Change; index: number; mayHaveChanged: boolean }[] = [];
        // The callback may acquire a lock or await host state; recheck all sources afterward.
        try { await this.fresh(record, signal, tracker); }
        catch (error) { failure = error; }
        if (failure === undefined) for (let index = 0; index < record.changes.length; index++) {
          const change = record.changes[index]!, attempt = { change, index, mayHaveChanged: false }; attempted.push(attempt);
          try { await apply(change, record.before[index]!, record, { signal }, tracker, () => { attempt.mayHaveChanged = true; }, relative => { createdParentCount++; if (createdParents.length < 16) createdParents.push(relative); }); }
          catch (error) { failure = error; break; }
        }
        // Original accounting continues through cancellation and close so observed effects survive.
        const files: PhysicalPatchObservation['files'][number][] = []; let incomplete = failure !== undefined;
        for (let index = 0; index < record.changes.length; index++) {
          const change = record.changes[index]!, before = record.before[index]!, attempt = attempted[index], mayHaveChanged = attempt?.mayHaveChanged ?? false;
          try {
            const after = await observe(record.binding.root, change.path, tracker);
            if (!mayHaveChanged && after.content !== before.content) {
              warnings.push(`An external edit to ${change.path} was detected before patch effects; it was omitted from the recorded patch changes.`);
            }
            files.push({ path: change.path, attempted: attempt !== undefined, before: before.content, beforeHash: before.hash, after: after.content, afterHash: after.hash, mayHaveChanged, observationComplete: true });
            if (mayHaveChanged && after.content !== change.content) {
              incomplete = true; warnings.push(`Observed postimage of ${change.path} differs from the requested content; a partial write or concurrent external edit may have occurred.`);
              failure ??= new EngineError('PATCH_POSTIMAGE_MISMATCH', `Observed postimage of ${change.path} differs from the requested content`);
            }
          } catch (error) {
            incomplete = true; files.push({ path: change.path, attempted: attempt !== undefined, before: before.content, beforeHash: before.hash, after: null, afterHash: null, mayHaveChanged, observationComplete: false });
            warnings.push(`Could not capture postimage of ${change.path}: ${errorText(error)}. Filesystem effects may be present.`);
            failure ??= new EngineError('PATCH_CHECKPOINT_INCOMPLETE', `Could not capture postimage of ${change.path}: ${errorText(error)}`);
          }
        }
        if (createdParentCount > 0) warnings.push(`Created ${createdParentCount} parent directory/directories, which content restoration does not remove: ${createdParents.join(', ')}${createdParentCount > createdParents.length ? ', …' : ''}.`);
        if (failure !== undefined) { incomplete = true; warnings.push(`Patch stopped after ${attempted.length} of ${record.changes.length} targets: ${errorText(failure)}. Applied effects were not rolled back.`); }
        const cleanupConfirmed = tracker.cleanupConfirmed && tracker.opened.size === 0;
        const result = Object.freeze({ id: randomUUID() });
        this.#results.set(result, { state: cleanupConfirmed && files.every(file => file.observationComplete) ? incomplete ? 'partial' : 'applied' : 'uncertain',
          files, createdParentCount, createdParents, createdParentsComplete: createdParentCount === createdParents.length, attemptedFileCount: attempted.length,
          incomplete: incomplete || !cleanupConfirmed, cleanupConfirmed, warnings,
          errorCode: failure instanceof EngineError ? failure.code : failure === undefined ? null : 'PATCH_FAILED', errorMessage: failure === undefined ? null : errorText(failure) });
        return result;
      } finally { record.state = 'finished'; }
    });
  }
  readResult(original: object): PhysicalPatchObservation {
    const result = this.#results.get(original);
    if (!result) throw new EngineError('INVALID_PATCH_RESULT', 'Only an original observed physical result supplies effect evidence');
    return structuredClone(result);
  }
  release(original: object): void { const record = this.#captures.get(original); if (record && record.state !== 'applying') record.state = 'released'; }
  async close(): Promise<void> {
    this.#closing.abort(); await Promise.allSettled([...this.#pending]);
    if (this.#unclosed.size) throw new EngineError('PATCH_CLEANUP_UNCERTAIN', 'Original patch descriptors remain without confirmed cleanup');
  }
}
