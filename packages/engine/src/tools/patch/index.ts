import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { EngineError, type Checkpoint, type CheckpointFile, type JsonObject, type JsonValue } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition, ToolResult } from '../../ports.js';
import { acquireExecutionLock } from '../command/execution-lock.js';

const MAX_FILES = 32;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_PREVIEW_BYTES = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

interface Change { path: string; expectedHash: string | null; content: string | null }
interface Image { content: string | null; hash: string | null; stat?: Stats }
interface BoundRequest {
  workspaceId: string; root: string; sessionId: string; runId: string; toolCallId: string;
  executionLockPath?: string;
  changes: Change[]; before: Image[]; fingerprint: string; preview: string; used: boolean;
}

function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hash(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }
function assertActive(context: ToolContext): void {
  if (context.signal.aborted) throw new EngineError('CANCELLED', 'Patch was cancelled');
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
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
  if (!object(input) || !keys(input, ['changes']) || !Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > MAX_FILES) {
    throw new EngineError('INVALID_PATCH_INPUT', `A patch requires between 1 and ${MAX_FILES} full-content changes`);
  }
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
async function targetPath(root: string, relative: string, createParents = false, context?: ToolContext, onDirectoryCreated?: (relative: string) => void): Promise<string> {
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
async function openImage(root: string, relative: string, writable = false): Promise<{ absolute: string; image: Image; handle?: FileHandle }> {
  const absolute = await targetPath(root, relative);
  let initial: Stats;
  try { initial = await fs.lstat(absolute); }
  catch (error) { if (code(error) === 'ENOENT') return { absolute, image: { content: null, hash: null } }; throw error; }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new EngineError('UNSAFE_PATCH_PATH', 'Patch target must be a regular file with a single link');
  let handle: FileHandle;
  try { handle = await fs.open(absolute, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
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
  } catch (error) { await handle.close(); throw error; }
}
async function observe(root: string, relative: string): Promise<Image> {
  const target = await openImage(root, relative);
  if (target.handle) await target.handle.close();
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
function fingerprint(request: Omit<BoundRequest, 'fingerprint' | 'preview' | 'used'>): string {
  return hash(JSON.stringify({ name: 'apply_patch', workspaceId: request.workspaceId, root: request.root, sessionId: request.sessionId, runId: request.runId, toolCallId: request.toolCallId, executionLockPath: request.executionLockPath, changes: request.changes }));
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

async function apply(change: Change, before: Image, request: BoundRequest, context: ToolContext, effectStarted: () => void, directoryCreated: (relative: string) => void): Promise<void> {
  assertActive(context);
  const target = await openImage(request.root, change.path, change.content !== null && before.hash !== null);
  try {
    checkExpected(change, target.image, before);
    if (change.content === before.content) return;
    assertActive(context);
    if (before.hash === null) {
      const absolute = await targetPath(request.root, change.path, true, context, directoryCreated);
      assertActive(context);
      let handle: FileHandle;
      try { handle = await fs.open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666); }
      catch (error) {
        if (['EEXIST', 'ELOOP', 'ENOENT'].includes(code(error) ?? '')) throw new EngineError('PATCH_PREIMAGE_MISMATCH', `Target ${change.path} or its parent changed before creation`);
        throw error;
      }
      effectStarted();
      try { await handle.writeFile(change.content!, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
    } else if (target.handle && target.image.stat) {
      await targetPath(request.root, change.path);
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
  } finally { if (target.handle) await target.handle.close(); }
}

/** Full replacements only; the coordinator is responsible for granting approval. */
export function createPatchTool(): ToolDefinition {
  const requests = new WeakMap<PreparedTool, BoundRequest>();
  return {
    name: 'apply_patch',
    description: 'Propose bounded create, update, or delete changes using full UTF-8 file contents and expected SHA-256 hashes. Requires approval.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['changes'],
      properties: { changes: { type: 'array', minItems: 1, maxItems: MAX_FILES, items: { type: 'object', additionalProperties: false, required: ['path', 'expectedHash', 'content'], properties: { path: { type: 'string', maxLength: MAX_PATH_BYTES }, expectedHash: { anyOf: [{ type: 'string', pattern: '^[a-f0-9]{64}$' }, { type: 'null' }] }, content: { anyOf: [{ type: 'string' }, { type: 'null' }] } } } } },
    },
    async prepare(input, context) {
      assertActive(context);
      const changes = parse(input);
      const before: Image[] = [];
      let bytes = 0;
      for (const change of changes) {
        assertActive(context);
        const image = await observe(context.workspace.root, change.path);
        checkExpected(change, image);
        bytes += Buffer.byteLength(image.content ?? '', 'utf8') + Buffer.byteLength(change.content ?? '', 'utf8');
        if (bytes > MAX_TOTAL_BYTES) throw new EngineError('PATCH_LIMIT_EXCEEDED', 'Combined patch preimages and replacements exceed the byte limit');
        if (image.stat && before.some((other) => other.stat && sameFile(other.stat, image.stat!))) throw new EngineError('INVALID_PATCH_INPUT', 'Patch paths alias the same file');
        before.push(image);
      }
      assertActive(context);
      const request = { workspaceId: context.workspace.id, root: context.workspace.root, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId, executionLockPath: context.executionLockPath, changes, before };
      const prepared: PreparedTool = { name: 'apply_patch', input: { changes: changes.map((change) => ({ ...change })) }, fingerprint: fingerprint(request), requiresApproval: true, preview: preview(changes, before) };
      requests.set(prepared, { ...request, fingerprint: prepared.fingerprint, preview: JSON.stringify(prepared.preview), used: false });
      return prepared;
    },
    async execute(prepared, context): Promise<ToolResult> {
      assertActive(context);
      const request = requests.get(prepared);
      if (!request || request.used) throw new EngineError('INVALID_PREPARED_PATCH', 'A patch must be prepared by this tool and can be executed only once');
      request.used = true;
      const validated = parse(prepared.input);
      const actual = fingerprint({ ...request, changes: validated });
      if (prepared.name !== 'apply_patch' || !prepared.requiresApproval || prepared.fingerprint !== request.fingerprint || actual !== request.fingerprint || JSON.stringify(prepared.preview) !== request.preview
        || context.workspace.id !== request.workspaceId || context.workspace.root !== request.root || context.sessionId !== request.sessionId || context.runId !== request.runId || context.toolCallId !== request.toolCallId || context.executionLockPath !== request.executionLockPath) {
        throw new EngineError('PATCH_APPROVAL_STALE', 'Prepared patch or approval context changed; a new preview and approval are required');
      }
      // Validate every target before making the first filesystem change.
      for (let index = 0; index < request.changes.length; index++) {
        assertActive(context);
        checkExpected(request.changes[index]!, await observe(request.root, request.changes[index]!.path), request.before[index]);
      }
      const lock = request.executionLockPath ? acquireExecutionLock(request.executionLockPath) : undefined;
      let accountingComplete = false;
      try {
        const checkpoint: Checkpoint = { id: randomUUID(), runId: context.runId, toolCallId: context.toolCallId, kind: 'patch', createdAt: new Date().toISOString(), files: [], warnings: [] };
        let failure: unknown;
        let directoriesCreated = 0;
        const directoryExamples: string[] = [];
        const attempted: { change: Change; index: number; mayHaveChanged: boolean }[] = [];
        for (let index = 0; index < request.changes.length; index++) {
          const change = request.changes[index]!;
          const attempt = { change, index, mayHaveChanged: false };
          attempted.push(attempt);
          try { await apply(change, request.before[index]!, request, context, () => { attempt.mayHaveChanged = true; }, (relative) => { directoriesCreated++; if (directoryExamples.length < 16) directoryExamples.push(relative); }); }
          catch (error) { failure = error; break; }
        }
        // Ignore cancellation during accounting: effects already made must remain reviewable.
        for (const { change, index, mayHaveChanged } of attempted) {
          const before = request.before[index]!;
          try {
            const after = await observe(request.root, change.path);
            if (!mayHaveChanged && after.content !== before.content) {
              checkpoint.warnings.push(`An external edit to ${change.path} was detected before patch effects; it was omitted from the recorded patch changes.`);
              continue;
            }
            const file: CheckpointFile = { path: change.path, before: before.content, after: after.content, beforeHash: before.hash, afterHash: after.hash };
            if (file.before !== file.after || file.beforeHash !== file.afterHash) checkpoint.files.push(file);
            if (mayHaveChanged && after.content !== change.content) {
              checkpoint.incomplete = true;
              checkpoint.warnings.push(`Observed postimage of ${change.path} differs from the requested content; a partial write or concurrent external edit may have occurred.`);
              failure ??= new EngineError('PATCH_POSTIMAGE_MISMATCH', `Observed postimage of ${change.path} differs from the requested content`);
            }
          } catch (error) {
            checkpoint.incomplete = true;
            checkpoint.warnings.push(`Could not capture postimage of ${change.path}: ${errorText(error)}. Filesystem effects may be present.`);
            failure ??= new EngineError('PATCH_CHECKPOINT_INCOMPLETE', `Could not capture postimage of ${change.path}: ${errorText(error)}`);
          }
        }
        if (directoriesCreated > 0) checkpoint.warnings.push(`Created ${directoriesCreated} parent directory/directories, which content restoration does not remove: ${directoryExamples.join(', ')}${directoriesCreated > directoryExamples.length ? ', …' : ''}.`);
        if (failure !== undefined) {
          checkpoint.incomplete = true;
          checkpoint.warnings.push(`Patch stopped after ${attempted.length} of ${request.changes.length} targets: ${errorText(failure)}. Applied effects were not rolled back.`);
        }
        try { context.recordCheckpoint(checkpoint); }
        catch (error) { throw new EngineError('PATCH_CHECKPOINT_FAILED', 'Filesystem effects may be present, but the checkpoint could not be persisted', { checkpointId: checkpoint.id, cause: errorText(error) }); }
        accountingComplete = true;
        const data: JsonValue = { checkpointId: checkpoint.id, changedFiles: checkpoint.files.map((file) => file.path), incomplete: checkpoint.incomplete ?? false, warnings: checkpoint.warnings };
        const summary = failure === undefined ? `Applied patch to ${checkpoint.files.length} file(s).` : `Patch partially failed: ${errorText(failure)}`;
        const limit = Math.max(0, Math.min(context.limits.maxOutputBytes, 4096));
        let content = Buffer.from(summary, 'utf8').subarray(0, limit).toString('utf8');
        while (Buffer.byteLength(content, 'utf8') > limit) content = content.slice(0, -1);
        return { content, ...(failure === undefined ? {} : { isError: true }), data };
      } finally {
        // A crash or persistence gap leaves the durable marker active. Settled
        // partial effects with a persisted checkpoint can release the lease.
        lock?.release(accountingComplete);
      }
    },
  };
}
