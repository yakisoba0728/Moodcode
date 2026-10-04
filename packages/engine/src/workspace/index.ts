import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { EngineError, type Workspace } from '@moodcode/contracts';
import { gitFailure, readBranch, runGit, type GitOperationOptions } from './git.js';

export { WorkspaceObserver, DEFAULT_WORKSPACE_OBSERVER_OPTIONS } from './observer.js';
export type { WorkspaceObserverOptions, WorkspaceObserverState, WorkspaceObservation, ObservedWorkspaceFile, ObservedWorkspaceChange, ObservedGitStatus } from './observer.js';

export type { GitOperationOptions } from './git.js';

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function validateRoot(workspace: Workspace): Promise<string> {
  try {
    const root = await realpath(workspace.root);
    if (root !== workspace.root || !(await stat(root)).isDirectory()) {
      throw new EngineError('WORKSPACE_ROOT_CHANGED', 'Workspace root no longer matches its canonical directory.');
    }
    return root;
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError('WORKSPACE_UNAVAILABLE', 'Workspace root is unavailable.');
  }
}

/** Opens the canonical Git top-level directory, including unborn repositories. */
export async function openWorkspace(inputPath: string, options: GitOperationOptions = {}): Promise<Workspace> {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.includes('\0')) {
    throw new EngineError('INVALID_WORKSPACE_PATH', 'Workspace path must be a nonempty directory path.');
  }
  let requested: string;
  try {
    requested = await realpath(path.resolve(inputPath));
    if (!(await stat(requested)).isDirectory()) throw new EngineError('INVALID_WORKSPACE_PATH', 'Workspace path must be a directory.');
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError('INVALID_WORKSPACE_PATH', 'Workspace directory is unavailable.');
  }
  const discovery = await runGit(requested, ['rev-parse', '--path-format=absolute', '--show-toplevel'], options);
  if (discovery.code !== 0) {
    throw new EngineError('NOT_GIT_WORKSPACE', 'Workspace path must be inside a Git working tree.');
  }
  const root = await realpath(discovery.stdout.toString('utf8').replace(/\r?\n$/, ''));
  const branch = await readBranch(root, options);
  return {
    id: `workspace_${createHash('sha256').update(root).digest('hex')}`,
    root, gitRoot: root, branch, createdAt: new Date().toISOString(),
  };
}

/**
 * Rechecks existing components on every call. Within-root symlinks are resolved;
 * escaping/dangling links and lexical traversal are rejected. For missing paths,
 * the nearest existing parent is checked. This is not an atomic write primitive:
 * callers must invoke it again immediately before an effect, and parent paths
 * may still race with a separate filesystem process.
 */
export async function resolveWorkspacePath(workspace: Workspace, relative: string, allowMissing = false): Promise<string> {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') ||
      path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new EngineError('INVALID_WORKSPACE_PATH', 'Use a relative workspace path with forward slashes.');
  }
  const segments = relative.split('/');
  if (segments.includes('..')) throw new EngineError('PATH_OUTSIDE_WORKSPACE', 'Parent traversal is not allowed.');
  const components = segments.filter((component) => component !== '' && component !== '.');
  if (process.platform === 'win32' && components.some((component) =>
    /[:<>"|?*\u0001-\u001f]/.test(component) || /[. ]$/.test(component) ||
    /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(component))) {
    throw new EngineError('INVALID_WORKSPACE_PATH', 'Windows paths must use ordinary file components without streams or reserved device names.');
  }
  const root = await validateRoot(workspace);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') {
        if (allowMissing) return path.join(current, ...components.slice(index + 1));
        throw new EngineError('PATH_NOT_FOUND', `Workspace path does not exist: ${relative}`);
      }
      if (codeOf(error) === 'ENOTDIR') throw new EngineError('PATH_NOT_DIRECTORY', 'An existing path component is not a directory.');
      throw new EngineError('PATH_UNAVAILABLE', `Could not inspect workspace path: ${relative}`);
    }
    try {
      current = await realpath(current);
    } catch {
      throw new EngineError('PATH_UNAVAILABLE', `Workspace path has an unavailable or dangling component: ${relative}`);
    }
    if (!within(root, current)) throw new EngineError('PATH_OUTSIDE_WORKSPACE', `Workspace path escapes its root: ${relative}`);
    if (index < components.length - 1 && !metadata.isDirectory()) {
      if (!metadata.isSymbolicLink() || !(await stat(current)).isDirectory()) {
        throw new EngineError('PATH_NOT_DIRECTORY', 'An existing path component is not a directory.');
      }
    }
  }
  return current;
}

export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
  originalPath?: string;
}

export interface GitStatus {
  branch: string | null;
  clean: boolean;
  dirty: boolean;
  entries: GitStatusEntry[];
}

/** Porcelain v1 NUL records preserve filenames containing spaces or newlines. */
export async function getGitStatus(workspace: Workspace, options: GitOperationOptions = {}): Promise<GitStatus> {
  const root = await validateRoot(workspace);
  const result = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], options);
  if (result.code !== 0) throw gitFailure(result, 'Could not read Git status');
  const records = result.stdout.toString('utf8').split('\0');
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record === '' && index === records.length - 1) continue;
    if (record.length < 4 || record[2] !== ' ') throw new EngineError('GIT_INVALID_STATUS', 'Git returned malformed status records.');
    const entry: GitStatusEntry = { path: record.slice(3), index: record[0]!, worktree: record[1]! };
    if (entry.index === 'R' || entry.index === 'C' || entry.worktree === 'R' || entry.worktree === 'C') {
      const originalPath = records[++index];
      if (!originalPath) throw new EngineError('GIT_INVALID_STATUS', 'Git returned an incomplete rename record.');
      entry.originalPath = originalPath;
    }
    entries.push(entry);
  }
  const branch = await readBranch(root, options);
  return { branch, clean: entries.length === 0, dirty: entries.length !== 0, entries };
}

export interface CaptureWorkspaceOptions {
  signal?: AbortSignal;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
}

export interface WorkspaceCapture {
  files: Map<string, { content: string; hash: string }>;
  warnings: string[];
}

export const DEFAULT_CAPTURE_LIMITS = Object.freeze({
  maxFiles: 2_000, maxFileBytes: 1_048_576, maxTotalBytes: 16_777_216, maxEntries: 20_000, maxDepth: 64,
});

function limit(value: number | undefined, fallback: number, name: string, ceiling: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > ceiling) {
    throw new EngineError('INVALID_LIMIT', `${name} must be an integer from 0 to ${ceiling}.`);
  }
  return selected;
}

/** Bounded observation of tracked, untracked and ignored UTF-8 files. */
export async function captureWorkspace(workspace: Workspace, options: CaptureWorkspaceOptions = {}): Promise<WorkspaceCapture> {
  const limits = {
    maxFiles: limit(options.maxFiles, DEFAULT_CAPTURE_LIMITS.maxFiles, 'maxFiles', 100_000),
    maxFileBytes: limit(options.maxFileBytes, DEFAULT_CAPTURE_LIMITS.maxFileBytes, 'maxFileBytes', 67_108_864),
    maxTotalBytes: limit(options.maxTotalBytes, DEFAULT_CAPTURE_LIMITS.maxTotalBytes, 'maxTotalBytes', 268_435_456),
    maxEntries: limit(options.maxEntries, DEFAULT_CAPTURE_LIMITS.maxEntries, 'maxEntries', 500_000),
    maxDepth: limit(options.maxDepth, DEFAULT_CAPTURE_LIMITS.maxDepth, 'maxDepth', 256),
  };
  const files: WorkspaceCapture['files'] = new Map();
  const warnings: string[] = [];
  let visited = 0;
  let totalBytes = 0;
  let entryLimitReached = false;
  let fileLimitReached = false;
  const warn = (message: string) => {
    if (warnings.length < 200) warnings.push(message);
    else warnings[199] = 'Further capture warnings were omitted after the 200-warning limit; capture is incomplete.';
  };
  const checkAbort = () => {
    if (options.signal?.aborted) throw new EngineError('ABORTED', 'Workspace capture was aborted.');
  };
  checkAbort();
  await validateRoot(workspace);

  const captureFile = async (relative: string) => {
    checkAbort();
    if (files.size >= limits.maxFiles) {
      fileLimitReached = true;
      warn(`Capture file limit (${limits.maxFiles}) reached; remaining files were omitted.`);
      return;
    }
    let handle;
    try {
      const absolute = await resolveWorkspacePath(workspace, relative);
      const candidate = await lstat(absolute, { bigint: true });
      if (!candidate.isFile()) { warn(`Skipped nonregular or changed file: ${relative}`); return; }
      handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.ino !== candidate.ino || before.dev !== candidate.dev) {
        warn(`Skipped file whose identity changed during capture: ${relative}`); return;
      }
      const remaining = limits.maxTotalBytes - totalBytes;
      if (before.size > BigInt(limits.maxFileBytes)) { warn(`Skipped oversized file (${limits.maxFileBytes}-byte limit): ${relative}`); return; }
      if (before.size > BigInt(remaining)) { warn(`Skipped file exceeding remaining total byte limit (${limits.maxTotalBytes}): ${relative}`); return; }
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        checkAbort();
        const read = await handle.read(buffer, bytes, Math.min(buffer.length - bytes, 65_536), bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (bytes !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        warn(`Skipped file changed during capture: ${relative}`); return;
      }
      const stillResolved = await resolveWorkspacePath(workspace, relative);
      const stillNamed = await lstat(stillResolved, { bigint: true });
      if (stillResolved !== absolute || !stillNamed.isFile() || stillNamed.dev !== before.dev || stillNamed.ino !== before.ino) {
        warn(`Skipped file whose path changed during capture: ${relative}`); return;
      }
      const data = buffer.subarray(0, bytes);
      if (data.includes(0)) { warn(`Skipped binary file containing NUL bytes: ${relative}`); return; }
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { warn(`Skipped binary or non-UTF-8 file: ${relative}`); return; }
      checkAbort();
      files.set(relative, { content, hash: createHash('sha256').update(data).digest('hex') });
      totalBytes += bytes;
    } catch (error) {
      if (error instanceof EngineError && error.code === 'ABORTED') throw error;
      warn(`Could not capture file ${relative}: ${error instanceof EngineError ? error.code : codeOf(error) ?? 'IO_ERROR'}`);
    } finally {
      await handle?.close();
    }
  };

  const walk = async (relative: string, depth: number): Promise<void> => {
    checkAbort();
    if (entryLimitReached || fileLimitReached) return;
    if (depth > limits.maxDepth) { warn(`Skipped directory beyond capture depth limit (${limits.maxDepth}): ${relative}`); return; }
    const names: string[] = [];
    try {
      const absolute = await resolveWorkspacePath(workspace, relative);
      if ((await lstat(absolute)).isSymbolicLink()) { warn(`Skipped symbolic link: ${relative}`); return; }
      const directory = await opendir(absolute, { bufferSize: 64 });
      for await (const entry of directory) {
        checkAbort();
        if (visited >= limits.maxEntries) {
          entryLimitReached = true;
          warn(`Capture entry limit (${limits.maxEntries}) reached; remaining entries were omitted.`);
          break;
        }
        visited += 1;
        names.push(entry.name);
      }
    } catch (error) {
      if (error instanceof EngineError && error.code === 'ABORTED') throw error;
      warn(`Could not inspect directory ${relative || '.'}: ${error instanceof EngineError ? error.code : codeOf(error) ?? 'IO_ERROR'}`);
      return;
    }
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      checkAbort();
      if (fileLimitReached) return;
      if (name.toLowerCase() === '.git' || name.toLowerCase() === 'node_modules') continue;
      const childRelative = relative ? `${relative}/${name}` : name;
      try {
        // Inspect the lexical entry before resolution so capture never follows
        // a symlink intentionally, including links to another in-root directory.
        const parent = await resolveWorkspacePath(workspace, relative);
        const child = path.join(parent, name);
        const metadata = await lstat(child);
        if (metadata.isSymbolicLink()) warn(`Skipped symbolic link: ${childRelative}`);
        else if (metadata.isDirectory()) {
          if (!entryLimitReached) await walk(childRelative, depth + 1);
        } else if (metadata.isFile()) await captureFile(childRelative);
        else warn(`Skipped nonregular file: ${childRelative}`);
      } catch (error) {
        if (error instanceof EngineError && error.code === 'ABORTED') throw error;
        warn(`Could not inspect path ${childRelative}: ${error instanceof EngineError ? error.code : codeOf(error) ?? 'IO_ERROR'}`);
      }
    }
  };
  await walk('', 0);
  return { files, warnings };
}
