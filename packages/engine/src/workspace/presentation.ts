import { createHash } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { EngineError, type Workspace } from '@moodcode/contracts';
import { getGitStatus, resolveWorkspacePath, type GitStatusEntry } from './index.js';
import { continuationOffset, continuationToken, excludedDirectory, ignoredWorkspacePaths, snapshotFingerprint, validateContinuation } from './ignore.js';

export const WORKSPACE_PRESENTATION_LIMITS = Object.freeze({
  maxEntries: 1_000, maxScanEntries: 20_000, maxStatusEntries: 1_000, maxJsonBytes: 262_144,
  maxWarnings: 20, maxFileBytes: 524_288, maxPathBytes: 4_096,
});

export interface WorkspacePresentationOptions { signal?: AbortSignal; limit?: number; continuation?: string }
export interface WorkspaceStatusPresentation {
  workspaceId: string;
  branch: string | null;
  clean: boolean;
  dirty: boolean;
  changedFiles: GitStatusEntry[];
  totalChangedFiles: number;
  truncated: boolean;
  warnings: string[];
}
export interface WorkspaceFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  bytes?: number;
}
export interface WorkspaceFilesPresentation {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  warnings: string[];
  continuation?: string;
}
export interface WorkspaceFilePresentation {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
  truncated: false;
}
interface RootAnchor { absolute: string; dev: bigint; ino: bigint }

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineError('ABORTED', 'Workspace presentation request was aborted.');
}

function code(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : 'IO_ERROR';
}

function normalizedPath(value: string, allowRoot: boolean): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') ||
      Buffer.byteLength(value, 'utf8') > WORKSPACE_PRESENTATION_LIMITS.maxPathBytes ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new EngineError('INVALID_WORKSPACE_PATH', 'Use a bounded workspace-relative path with forward slashes.');
  }
  const parts = value.split('/');
  if (parts.includes('..')) throw new EngineError('PATH_OUTSIDE_WORKSPACE', 'Parent traversal is not allowed.');
  const selected = parts.filter((part) => part !== '' && part !== '.');
  if (selected.some(excludedDirectory)) {
    throw new EngineError('PATH_EXCLUDED', 'Git metadata, dependency and build/cache paths are excluded from presentation.');
  }
  const relative = selected.join('/');
  if (!allowRoot && relative.length === 0) throw new EngineError('INVALID_WORKSPACE_PATH', 'A file path is required.');
  return relative;
}

async function rootAnchor(workspace: Workspace, signal?: AbortSignal): Promise<RootAnchor> {
  abort(signal);
  const absolute = await resolveWorkspacePath(workspace, '');
  try {
    const metadata = await lstat(absolute, { bigint: true });
    abort(signal);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new EngineError('WORKSPACE_ROOT_CHANGED', 'Workspace root no longer names its canonical directory.');
    }
    return { absolute, dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError('WORKSPACE_UNAVAILABLE', 'Workspace root is unavailable.');
  }
}

async function checkRoot(workspace: Workspace, before: RootAnchor, signal?: AbortSignal): Promise<void> {
  const after = await rootAnchor(workspace, signal);
  if (after.absolute !== before.absolute || after.dev !== before.dev || after.ino !== before.ino) {
    throw new EngineError('WORKSPACE_ROOT_CHANGED', 'Workspace root identity changed during the request.');
  }
}

/** Presentation refuses all lexical symlink components, including inward links. */
async function checkedPath(workspace: Workspace, relative: string, anchor: RootAnchor, signal?: AbortSignal): Promise<string> {
  abort(signal);
  let lexical = anchor.absolute;
  const parts = relative === '' ? [] : relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    lexical = path.join(lexical, parts[index]!);
    try {
      const metadata = await lstat(lexical, { bigint: true });
      abort(signal);
      if (metadata.isSymbolicLink()) throw new EngineError('SYMLINK_NOT_ALLOWED', 'Presentation does not follow symbolic links.');
      if (index < parts.length - 1 && !metadata.isDirectory()) throw new EngineError('PATH_NOT_DIRECTORY', 'A path component is not a directory.');
    } catch (error) {
      if (error instanceof EngineError) throw error;
      if (code(error) === 'ENOENT') throw new EngineError('PATH_NOT_FOUND', 'Workspace path does not exist.');
      if (code(error) === 'ENOTDIR') throw new EngineError('PATH_NOT_DIRECTORY', 'A path component is not a directory.');
      throw new EngineError('PATH_UNAVAILABLE', 'Workspace path could not be inspected.');
    }
  }
  const absolute = await resolveWorkspacePath(workspace, relative);
  // Native aliases (for example Windows short names) must not bypass exclusions.
  normalizedPath(path.relative(anchor.absolute, absolute).split(path.sep).join('/'), true);
  await checkRoot(workspace, anchor, signal);
  return absolute;
}

function warning(warnings: string[], message: string): void {
  if (warnings.length < WORKSPACE_PRESENTATION_LIMITS.maxWarnings) warnings.push(message);
  else warnings[WORKSPACE_PRESENTATION_LIMITS.maxWarnings - 1] = 'Additional presentation warnings were omitted.';
}

function fitJson<T>(result: T, entries: unknown[], warnings: string[]): boolean {
  const budget = WORKSPACE_PRESENTATION_LIMITS.maxJsonBytes - 512;
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= budget) return false;
  const original = [...entries];
  let low = 0;
  let high = original.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    entries.splice(0, entries.length, ...original.slice(0, middle));
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= budget) low = middle;
    else high = middle - 1;
  }
  entries.splice(0, entries.length, ...original.slice(0, low));
  warning(warnings, 'Presentation JSON byte limit reached; additional entries were omitted.');
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > WORKSPACE_PRESENTATION_LIMITS.maxJsonBytes - 16) {
    throw new EngineError('PRESENTATION_TOO_LARGE', 'Presentation metadata alone exceeds the JSON byte limit.');
  }
  return true;
}

/** Real Git branch/status, independent of Run, approval and journal services. */
export async function getWorkspaceStatus(workspace: Workspace, signal?: AbortSignal): Promise<WorkspaceStatusPresentation> {
  const anchor = await rootAnchor(workspace, signal);
  const status = await getGitStatus(workspace, { signal });
  await checkRoot(workspace, anchor, signal);
  const warnings: string[] = [];
  const changedFiles = status.entries.slice(0, WORKSPACE_PRESENTATION_LIMITS.maxStatusEntries).map((entry) => ({ ...entry }));
  const result: WorkspaceStatusPresentation = {
    workspaceId: workspace.id, branch: status.branch, clean: status.clean, dirty: status.dirty,
    changedFiles, totalChangedFiles: status.entries.length,
    truncated: changedFiles.length !== status.entries.length, warnings,
  };
  if (result.truncated) warning(warnings, 'Git status entry limit reached; additional changed files were omitted.');
  result.truncated = fitJson(result, changedFiles, warnings) || result.truncated;
  abort(signal);
  return result;
}

/** One directory only, with bounded scan and authenticated snapshot continuation. */
async function listFiles(workspace: Workspace, relativePath = '', options: WorkspacePresentationOptions = {}): Promise<WorkspaceFilesPresentation> {
  const { signal } = options;
  abort(signal);
  const limit = options.limit ?? WORKSPACE_PRESENTATION_LIMITS.maxEntries;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_PRESENTATION_LIMITS.maxEntries) throw new EngineError('INVALID_LIMIT', 'Presentation limit must be between 1 and 1000');
  if (options.continuation !== undefined) validateContinuation(options.continuation);
  const relative = normalizedPath(relativePath, true);
  const anchor = await rootAnchor(workspace, signal);
  const absolute = await checkedPath(workspace, relative, anchor, signal);
  const before = await lstat(absolute, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new EngineError('NOT_DIRECTORY', 'Only directories can be listed.');
  if (relative && (await ignoredWorkspacePaths(workspace, [relative], signal)).has(relative)) throw new EngineError('PATH_EXCLUDED', 'This directory is excluded by Git ignore rules');
  const result: WorkspaceFilesPresentation = { path: relative, entries: [], truncated: false, warnings: [] };
  const directory = await opendir(absolute, { bufferSize: 64 });
  let inspected = 0;
  let scanBytes = 0;
  const candidates: Dirent[] = [];
  let safe = true;
  for await (const entry of directory) {
    abort(signal);
    scanBytes += Buffer.byteLength(entry.name) + 64;
    if (inspected >= WORKSPACE_PRESENTATION_LIMITS.maxScanEntries || scanBytes > WORKSPACE_PRESENTATION_LIMITS.maxJsonBytes * 4) {
      result.truncated = true;
      safe = false;
      warning(result.warnings, 'Directory scan limit reached; continuation is unavailable. Narrow the requested directory.');
      break;
    }
    inspected += 1;
    if (!excludedDirectory(entry.name)) candidates.push(entry);
  }
  const ignored = await ignoredWorkspacePaths(workspace, candidates.map(entry => relative ? `${relative}/${entry.name}` : entry.name), signal);
  const observations: string[][] = [];
  for (const entry of candidates) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (ignored.has(child)) continue;
    try {
      normalizedPath(child, false);
      const childAbsolute = await checkedPath(workspace, child, anchor, signal);
      const metadata = await lstat(childAbsolute, { bigint: true });
      abort(signal);
      if (metadata.isSymbolicLink()) throw new EngineError('SYMLINK_NOT_ALLOWED', 'Presentation does not follow symbolic links.');
      observations.push([child, String(metadata.dev), String(metadata.ino), String(metadata.size), String(metadata.mtimeNs), String(metadata.ctimeNs)]);
      if (metadata.isDirectory()) result.entries.push({ path: child, name: entry.name, kind: 'directory' });
      else if (metadata.isFile() && metadata.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
        result.entries.push({ path: child, name: entry.name, kind: 'file', bytes: Number(metadata.size) });
      } else throw new EngineError('NOT_REGULAR_FILE', 'Nonregular files are excluded from presentation.');
    } catch (error) {
      abort(signal);
      if (error instanceof EngineError && (error.code === 'WORKSPACE_ROOT_CHANGED' || error.code === 'WORKSPACE_UNAVAILABLE')) throw error;
      result.truncated = true;
      safe = false;
      // Do not expose absolute host paths or arbitrary OS diagnostics to the GUI.
      warning(result.warnings, `${entry.name}: ${error instanceof EngineError ? error.code : code(error)}`);
    }
  }
  const current = await checkedPath(workspace, relative, anchor, signal);
  const after = await lstat(current, { bigint: true });
  if (current !== absolute || after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory()) {
    throw new EngineError('DIRECTORY_CHANGED', 'Directory identity changed while listing; request a fresh listing.');
  }
  if (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
    result.truncated = true;
    safe = false;
    warning(result.warnings, 'Directory changed during listing; request a fresh listing.');
  }
  result.entries.sort((left, right) => left.kind !== right.kind ? (left.kind === 'directory' ? -1 : 1) : left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  observations.sort((left, right) => left[0]!.localeCompare(right[0]!));
  const scope = snapshotFingerprint({ kind: 'workspace.presentation', workspaceId: workspace.id, root: workspace.root, relative, limit });
  const snapshot = snapshotFingerprint({ observations, dev: String(after.dev), ino: String(after.ino), mtime: String(after.mtimeNs), ctime: String(after.ctimeNs) });
  const offset = continuationOffset(options.continuation, scope, snapshot, result.entries.length);
  const total = result.entries.length;
  result.entries = result.entries.slice(offset, offset + limit);
  if (offset + result.entries.length < total) {
    result.truncated = true;
    warning(result.warnings, safe
      ? 'Directory page entry limit reached; use continuation to request additional entries.'
      : 'Directory page entry limit reached; a safe continuation is unavailable. Narrow the requested directory.');
  }
  if (safe && result.entries.length > 0 && offset + result.entries.length < total) result.continuation = continuationToken(scope, snapshot, offset + result.entries.length);
  result.truncated = fitJson(result, result.entries, result.warnings) || result.truncated;
  delete result.continuation;
  if (safe && result.entries.length > 0 && offset + result.entries.length < total) result.continuation = continuationToken(scope, snapshot, offset + result.entries.length);
  await checkRoot(workspace, anchor, signal);
  return result;
}

/** Strict bounded UTF-8 snapshot; never truncates content or follows a symlink. */
async function readFile(workspace: Workspace, relativePath: string, options: WorkspacePresentationOptions = {}): Promise<WorkspaceFilePresentation> {
  const { signal } = options;
  abort(signal);
  const relative = normalizedPath(relativePath, false);
  const anchor = await rootAnchor(workspace, signal);
  const absolute = await checkedPath(workspace, relative, anchor, signal);
  const candidate = await lstat(absolute, { bigint: true });
  if (candidate.isSymbolicLink()) throw new EngineError('SYMLINK_NOT_ALLOWED', 'Presentation does not follow symbolic links.');
  if (!candidate.isFile()) throw new EngineError('NOT_REGULAR_FILE', 'Only regular files can be read.');
  if (candidate.size > BigInt(WORKSPACE_PRESENTATION_LIMITS.maxFileBytes)) throw new EngineError('FILE_TOO_LARGE', 'File exceeds the 512 KiB presentation limit.');
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    abort(signal);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== candidate.dev || before.ino !== candidate.ino || before.size !== candidate.size ||
        before.mtimeNs !== candidate.mtimeNs || before.ctimeNs !== candidate.ctimeNs) {
      throw new EngineError('FILE_CHANGED', 'File identity or content changed before reading.');
    }
    if (before.size > BigInt(WORKSPACE_PRESENTATION_LIMITS.maxFileBytes)) throw new EngineError('FILE_TOO_LARGE', 'File exceeds the 512 KiB presentation limit.');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      abort(signal);
      const read = await handle.read(buffer, bytes, Math.min(buffer.length - bytes, 65_536), bytes);
      abort(signal);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes > WORKSPACE_PRESENTATION_LIMITS.maxFileBytes) throw new EngineError('FILE_TOO_LARGE', 'File grew beyond the 512 KiB presentation limit.');
    const after = await handle.stat({ bigint: true });
    const current = await checkedPath(workspace, relative, anchor, signal);
    const atPath = await lstat(current, { bigint: true });
    if (current !== absolute || !atPath.isFile() || BigInt(bytes) !== before.size ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        atPath.dev !== before.dev || atPath.ino !== before.ino || atPath.size !== after.size ||
        atPath.mtimeNs !== after.mtimeNs || atPath.ctimeNs !== after.ctimeNs) {
      throw new EngineError('FILE_CHANGED', 'File or path changed while reading; request a fresh read.');
    }
    const data = buffer.subarray(0, bytes);
    if (data.some((byte) => byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b))) {
      throw new EngineError('BINARY_FILE', 'Binary files are not supported in presentation.');
    }
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new EngineError('INVALID_UTF8', 'File is not valid UTF-8 text.'); }
    abort(signal);
    await checkRoot(workspace, anchor, signal);
    return { path: relative, content, bytes, sha256: createHash('sha256').update(data).digest('hex'), truncated: false };
  } finally { await handle.close(); }
}

function filesystemError(error: unknown, directory: boolean): EngineError {
  if (error instanceof EngineError) return error;
  if (code(error) === 'ELOOP') return new EngineError('SYMLINK_NOT_ALLOWED', 'A path changed into a symbolic link.');
  if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') {
    return new EngineError(directory ? 'DIRECTORY_CHANGED' : 'FILE_CHANGED', 'Path disappeared or changed during presentation; request a fresh result.');
  }
  return new EngineError(directory ? 'DIRECTORY_UNREADABLE' : 'FILE_UNREADABLE', 'Workspace path could not be read.');
}

export async function listWorkspaceFiles(workspace: Workspace, relativePath = '', options: WorkspacePresentationOptions = {}): Promise<WorkspaceFilesPresentation> {
  try { return await listFiles(workspace, relativePath, options); }
  catch (error) { abort(options.signal); throw filesystemError(error, true); }
}

export async function readWorkspaceFile(workspace: Workspace, relativePath: string, options: WorkspacePresentationOptions = {}): Promise<WorkspaceFilePresentation> {
  try { return await readFile(workspace, relativePath, options); }
  catch (error) { abort(options.signal); throw filesystemError(error, false); }
}
