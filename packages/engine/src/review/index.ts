import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { EngineError, isTerminal, type Checkpoint, type CheckpointFile, type FileDiff, type ReviewDiff, type Workspace } from '@moodcode/contracts';
import type { EngineStore } from '../ports.js';
import { acquireExecutionLock, assertExecutionLockAvailable } from '../tools/command/execution-lock.js';

const MAX_SESSIONS = 1_000;
const MAX_RUNS = 10_000;
const MAX_CHECKPOINTS = 50_000;
const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_REVIEW_BYTES = 64 * 1024 * 1024;
const MAX_RESTORE_METADATA_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RestoreOptions {
  executionLockPath?: string;
  signal?: AbortSignal;
  /** Bind execution to an earlier readonly preview; a stale preview makes no effects. */
  previewFingerprint?: string;
}
export interface RestorePreviewFile {
  path: string;
  operation: 'create' | 'update' | 'delete' | 'noop';
  postimageHash: string | null;
  restoreHash: string | null;
  currentHash?: string | null;
  status: 'ready' | 'conflict' | 'failed';
  reason?: string;
}
export interface RestorePreview {
  checkpointId: string;
  workspaceId: string;
  fingerprint: string;
  files: RestorePreviewFile[];
  activeRunIds: string[];
  canRestore: boolean;
  warnings: string[];
  limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxMetadataBytes: number };
  totalBytes: number;
}
export interface RestoreObservation {
  path: string;
  state: 'present' | 'absent' | 'unobserved';
  currentHash?: string | null;
  bytes?: number;
  error?: string;
}

export interface RestoreConflict { path: string; reason: string }
export interface RestoreFailure { path: string; error: string; mayHaveChanged: boolean }
export interface RestoreResult {
  checkpointId: string;
  restored: string[];
  conflicts: RestoreConflict[];
  failed: RestoreFailure[];
  warnings: string[];
  cancelled: boolean;
  observations: RestoreObservation[];
  effectsUncertain: boolean;
  executionBlocked: boolean;
}

class RestoreConflictError extends Error {}

function assertRestoreActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineError('CANCELLED', 'Checkpoint restoration was cancelled');
}
function validateRestoreOptions(options: RestoreOptions): void {
  if (typeof options !== 'object' || options === null || Array.isArray(options)
    || options.executionLockPath !== undefined && (typeof options.executionLockPath !== 'string' || !path.isAbsolute(options.executionLockPath) || options.executionLockPath.includes('\0'))
    || options.previewFingerprint !== undefined && (typeof options.previewFingerprint !== 'string' || !SHA256.test(options.previewFingerprint))
    || options.signal !== undefined && (typeof options.signal !== 'object' || options.signal === null || typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function')) {
    throw new EngineError('INVALID_RESTORE_OPTIONS', 'Restore options require an absolute lock path, AbortSignal, and optional SHA-256 preview fingerprint');
  }
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function imageProblem(content: string | null, expectedHash: string | null): string | undefined {
  if (content === null) return expectedHash === null ? undefined : 'Absent image has a non-null hash';
  if (typeof content !== 'string' || typeof expectedHash !== 'string' || !SHA256.test(expectedHash)) return 'Invalid content image or SHA-256 hash';
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return 'Content image exceeds the per-file restoration limit';
  if (Buffer.from(content, 'utf8').toString('utf8') !== content) return 'Recorded content is not representable as exact UTF-8 text';
  return hash(content) === expectedHash ? undefined : 'Recorded content does not match its SHA-256 hash';
}

function recordProblem(file: CheckpointFile): string | undefined {
  return imageProblem(file.before, file.beforeHash) ?? imageProblem(file.after, file.afterHash);
}

/** Build observed change chains without reading Git's unrelated working-tree diff. */
export function getReviewDiff(store: EngineStore, runId: string): ReviewDiff {
  const run = store.getRun(runId);
  const checkpoints = store.listCheckpoints(runId);
  if (checkpoints.length > MAX_CHECKPOINTS) throw new EngineError('REVIEW_LIMIT_EXCEEDED', 'Too many checkpoints to review safely');
  let reviewBytes = 0;
  const charge = (bytes: number): void => {
    reviewBytes += bytes;
    if (reviewBytes > MAX_REVIEW_BYTES) throw new EngineError('REVIEW_LIMIT_EXCEEDED', 'Review history and returned content exceed the 64 MiB aggregate byte limit');
  };
  const chargeText = (value: string | null): void => { if (value !== null) charge(Buffer.byteLength(value, 'utf8')); };
  const chargeFile = (file: FileDiff): void => {
    charge(128); // Reserve the fixed structure and scalar field overhead.
    for (const value of [file.path, file.before, file.after, file.beforeHash, file.afterHash]) chargeText(value);
  };
  chargeText(runId);
  let recordedFiles = 0;
  // Bound already-loaded history before sorting or hashing. The store port returns
  // a full array: truly streaming memory bounds need a paged checkpoint lookup.
  for (const checkpoint of checkpoints) {
    charge(256);
    for (const value of [checkpoint.id, checkpoint.runId, checkpoint.toolCallId, checkpoint.kind, checkpoint.createdAt]) chargeText(value);
    for (const warning of checkpoint.warnings) { charge(16); chargeText(warning); }
    for (const file of checkpoint.files) {
      if (++recordedFiles > MAX_CHECKPOINTS) throw new EngineError('REVIEW_LIMIT_EXCEEDED', 'Too many recorded file changes to review safely');
      chargeFile(file);
    }
  }
  const tools = store.getSnapshot(run.sessionId).tools;
  if (tools.length > MAX_CHECKPOINTS) throw new EngineError('REVIEW_LIMIT_EXCEEDED', 'Too many tool records to review safely');
  const warnings = new Set<string>();
  const checkpointTools = new Set(checkpoints.map((checkpoint) => checkpoint.toolCallId));
  for (const tool of tools) {
    if (tool.runId !== runId || !['apply_patch', 'run_command'].includes(tool.name) || !['running', 'interrupted'].includes(tool.state)) continue;
    if (!checkpointTools.has(tool.id) || tool.output === undefined) warnings.add(`Tool ${tool.id} (${tool.name}) is ${tool.state}; effects may exist outside recorded checkpoints because ${checkpointTools.has(tool.id) ? 'the execution result is unresolved' : 'no checkpoint was recorded'}.`);
  }
  const chains = new Map<string, FileDiff>();
  const files: FileDiff[] = [];
  // Storage order breaks timestamp ties, including multiple tools in one millisecond.
  const ordered = checkpoints.map((checkpoint, index) => ({ checkpoint, index }))
    .sort((left, right) => left.checkpoint.createdAt.localeCompare(right.checkpoint.createdAt) || left.index - right.index)
    .map(({ checkpoint }) => checkpoint);
  for (const checkpoint of ordered) {
    for (const warning of checkpoint.warnings) warnings.add(warning);
    if (checkpoint.incomplete) warnings.add(`Checkpoint ${checkpoint.id} has an incomplete filesystem capture; additional changes may be missing.`);
    if (checkpoint.kind === 'command') warnings.add(`Command checkpoint ${checkpoint.id} records observed file changes; concurrent external edits and effects outside the capture cannot be attributed or restored reliably.`);
    const seen = new Set<string>();
    for (const file of checkpoint.files) {
      const problem = recordProblem(file);
      if (problem) {
        warnings.add(`Checkpoint ${checkpoint.id}, ${file.path}: ${problem}; omitted from the review diff.`);
        chains.delete(file.path);
        continue;
      }
      const previous = chains.get(file.path);
      const continuous = previous && previous.afterHash === file.beforeHash && previous.after === file.before;
      if (seen.has(file.path)) warnings.add(`Checkpoint ${checkpoint.id} repeats ${file.path}; its observations are ambiguous.`);
      seen.add(file.path);
      if (previous && !continuous) warnings.add(`Discontinuous change chain for ${file.path} at checkpoint ${checkpoint.id}; an external edit or missing observation may intervene. Changes are shown as separate segments.`);
      if (continuous) {
        previous.after = file.after;
        previous.afterHash = file.afterHash;
      } else {
        const segment: FileDiff = { ...file };
        files.push(segment);
        chains.set(file.path, segment);
      }
    }
  }
  const changedFiles = files.filter((file) => file.beforeHash !== file.afterHash || file.before !== file.after);
  // ReviewDiff returns both raw checkpoints and merged files; charge both copies.
  for (const file of changedFiles) chargeFile(file);
  for (const warning of warnings) { charge(16); chargeText(warning); }
  return {
    runId,
    files: changedFiles,
    checkpoints: ordered,
    warnings: [...warnings],
  };
}

function locateCheckpoint(store: EngineStore, workspace: Workspace, checkpointId: string, signal?: AbortSignal): { checkpoint: Checkpoint; activeRunIds: string[] } {
  if (typeof checkpointId !== 'string' || checkpointId.length === 0 || checkpointId.length > 512) throw new EngineError('INVALID_CHECKPOINT_ID', 'A bounded checkpoint ID is required');
  const sessions = store.listSessions(workspace.id);
  if (sessions.length > MAX_SESSIONS) throw new EngineError('RESTORE_LOOKUP_LIMIT_EXCEEDED', 'Workspace has too many sessions for checkpoint lookup');
  let runCount = 0;
  let checkpointCount = 0;
  const seenRuns = new Set<string>();
  let found: Checkpoint | undefined;
  const activeRunIds: string[] = [];
  for (const session of sessions) {
    assertRestoreActive(signal);
    if (session.workspaceId !== workspace.id) throw new EngineError('CHECKPOINT_WORKSPACE_MISMATCH', 'Store returned a session from another workspace');
    const snapshot = store.getSnapshot(session.id);
    for (const run of snapshot.runs) {
      if (++runCount > MAX_RUNS) throw new EngineError('RESTORE_LOOKUP_LIMIT_EXCEEDED', 'Workspace has too many runs for checkpoint lookup');
      if (run.workspaceId !== workspace.id || run.sessionId !== session.id) throw new EngineError('CHECKPOINT_WORKSPACE_MISMATCH', 'Store returned a run from another workspace or session');
      if (seenRuns.has(run.id)) continue;
      seenRuns.add(run.id);
      if (!isTerminal(run.state)) activeRunIds.push(run.id);
      const checkpoints = store.listCheckpoints(run.id);
      checkpointCount += checkpoints.length;
      if (checkpointCount > MAX_CHECKPOINTS) throw new EngineError('RESTORE_LOOKUP_LIMIT_EXCEEDED', 'Workspace has too many checkpoints for lookup');
      for (const checkpoint of checkpoints) {
        if (checkpoint.id !== checkpointId) continue;
        if (checkpoint.runId !== run.id) throw new EngineError('CHECKPOINT_WORKSPACE_MISMATCH', 'Checkpoint belongs to a different run');
        if (found) throw new EngineError('AMBIGUOUS_CHECKPOINT', 'Checkpoint ID is not unique in this workspace');
        found = checkpoint;
      }
    }
  }
  if (!found) throw new EngineError('CHECKPOINT_NOT_FOUND', 'Checkpoint was not found in the requested workspace');
  return { checkpoint: found, activeRunIds };
}

function activeWorkspaceRuns(store: EngineStore, workspace: Workspace): string[] {
  const sessions = store.listSessions(workspace.id);
  if (sessions.length > MAX_SESSIONS) throw new EngineError('RESTORE_LOOKUP_LIMIT_EXCEEDED', 'Workspace has too many sessions for an execution check');
  const active = new Set<string>();
  let count = 0;
  for (const session of sessions) {
    if (session.workspaceId !== workspace.id) throw new EngineError('CHECKPOINT_WORKSPACE_MISMATCH', 'Store returned a session from another workspace');
    for (const run of store.getSnapshot(session.id).runs) {
      if (++count > MAX_RUNS) throw new EngineError('RESTORE_LOOKUP_LIMIT_EXCEEDED', 'Workspace has too many runs for an execution check');
      if (run.workspaceId !== workspace.id || run.sessionId !== session.id) throw new EngineError('CHECKPOINT_WORKSPACE_MISMATCH', 'Store returned a run from another workspace or session');
      if (!isTerminal(run.state)) active.add(run.id);
    }
  }
  return [...active];
}
function assertWorkspaceIdle(store: EngineStore, workspace: Workspace): void {
  const activeRunIds = activeWorkspaceRuns(store, workspace);
  if (activeRunIds.length) throw new EngineError('RESTORE_WORKSPACE_BUSY', 'An active workspace Run prevents checkpoint restoration', { activeRunIds });
}
function checkpointBounds(checkpoint: Checkpoint): number {
  if (checkpoint.files.length > MAX_FILES) throw new EngineError('RESTORE_LIMIT_EXCEEDED', 'Checkpoint has too many files to restore');
  let bytes = 0;
  let metadata = 256 + checkpoint.files.length * 256;
  for (const value of [checkpoint.id, checkpoint.runId, checkpoint.toolCallId, checkpoint.createdAt, ...checkpoint.warnings]) metadata += Buffer.byteLength(value, 'utf8');
  for (const file of checkpoint.files) {
    bytes += typeof file.before === 'string' ? Buffer.byteLength(file.before, 'utf8') : 0;
    bytes += typeof file.after === 'string' ? Buffer.byteLength(file.after, 'utf8') : 0;
    for (const value of [file.path, file.beforeHash, file.afterHash]) metadata += typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
  }
  if (bytes > MAX_TOTAL_BYTES || metadata > MAX_RESTORE_METADATA_BYTES) throw new EngineError('RESTORE_LIMIT_EXCEEDED', 'Checkpoint exceeds the restoration image or metadata byte limit');
  return bytes;
}
function loadRestore(store: EngineStore, workspace: Workspace, checkpointId: string, signal?: AbortSignal) {
  assertRestoreActive(signal);
  const storedWorkspace = store.getWorkspace(workspace.id);
  if (storedWorkspace.root !== workspace.root || path.resolve(workspace.root) !== workspace.root) throw new EngineError('CHECKPOINT_WORKSPACE_MISMATCH', 'Workspace root does not match the recorded workspace');
  const located = locateCheckpoint(store, workspace, checkpointId, signal);
  const totalBytes = checkpointBounds(located.checkpoint);
  return { ...located, checkpoint: structuredClone(located.checkpoint), totalBytes };
}
function restoreWarnings(checkpoint: Checkpoint): string[] {
  const warnings = [...checkpoint.warnings];
  if (checkpoint.incomplete) warnings.push('Checkpoint capture was incomplete; only recorded files can be restored.');
  if (checkpoint.kind === 'command') warnings.push('Restoration covers recorded text files only; command process, directory, permission, binary-file and external effects are not undone.');
  return warnings;
}
function operation(file: CheckpointFile): RestorePreviewFile['operation'] {
  return file.beforeHash === file.afterHash && file.before === file.after ? 'noop' : file.before === null ? 'delete' : file.after === null ? 'create' : 'update';
}

function validRelativePath(relative: string): string[] {
  if (typeof relative !== 'string' || relative.length === 0 || Buffer.byteLength(relative, 'utf8') > 4_096 || Buffer.from(relative, 'utf8').toString('utf8') !== relative || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new RestoreConflictError('Invalid workspace-relative path');
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.toLowerCase() === 'node_modules')) throw new RestoreConflictError('Path contains an unsafe or excluded component');
  return parts;
}

async function assertRoot(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(root) !== root) throw new RestoreConflictError('Workspace root is no longer the recorded canonical directory');
}

async function safeTarget(root: string, relative: string, signal?: AbortSignal): Promise<string> {
  assertRestoreActive(signal);
  const parts = validRelativePath(relative);
  await assertRoot(root);
  let current = root;
  for (const component of parts.slice(0, -1)) {
    assertRestoreActive(signal);
    current = path.join(current, component);
    let info: Stats;
    try { info = await lstat(current); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') throw new RestoreConflictError('Parent directory is missing; directory effects are outside this checkpoint');
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RestoreConflictError('Parent path is a symlink or is no longer a directory');
  }
  return path.join(root, ...parts);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameObservation(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.nlink === 1;
}

async function checkedLstat(absolute: string): Promise<Stats> {
  try { return await lstat(absolute); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') throw new RestoreConflictError('Target disappeared after its content was checked');
    throw error;
  }
}

async function guardPresent(root: string, file: CheckpointFile, writable: boolean, signal?: AbortSignal) {
  const absolute = await safeTarget(root, file.path, signal);
  let initial: Stats;
  try { initial = await lstat(absolute); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') throw new RestoreConflictError('Current file is missing; it does not match the recorded postimage');
    throw error;
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new RestoreConflictError('Current target is not a regular file with a single link');
  let handle;
  try { handle = await open(absolute, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (['ENOENT', 'ELOOP', 'EISDIR'].includes(errorCode(error) ?? '')) throw new RestoreConflictError('Current target changed while it was being opened');
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(initial, opened)) throw new RestoreConflictError('Current target changed while it was being opened');
    if (opened.size !== Buffer.byteLength(file.after ?? '', 'utf8')) throw new RestoreConflictError('Current file size does not match the recorded postimage; external edits were preserved');
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (true) {
      assertRestoreActive(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > MAX_FILE_BYTES) throw new RestoreConflictError('Current file exceeds the restoration read limit');
      digest.update(buffer.subarray(0, bytesRead));
    }
    const observed = await handle.stat();
    if (digest.digest('hex') !== file.afterHash || observed.size !== opened.size || observed.mtimeMs !== opened.mtimeMs || observed.ctimeMs !== opened.ctimeMs || observed.nlink !== 1) throw new RestoreConflictError('Current content does not match the recorded postimage; external edits were preserved');
    await safeTarget(root, file.path, signal);
    const current = await checkedLstat(absolute);
    if (!current.isFile() || !sameObservation(observed, current)) throw new RestoreConflictError('Target path or content changed after its postimage was checked');
    return { absolute, handle, observed };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function guardAbsent(root: string, file: CheckpointFile, signal?: AbortSignal): Promise<string> {
  const absolute = await safeTarget(root, file.path, signal);
  try { await lstat(absolute); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return absolute;
    throw error;
  }
  throw new RestoreConflictError('Current path exists; it does not match the recorded absent postimage');
}

/** Raw-byte observation also represents known partial writes that broke UTF-8. */
async function observeCurrent(root: string, relative: string, signal?: AbortSignal): Promise<{ observation: RestoreObservation; stat?: Stats }> {
  const absolute = await safeTarget(root, relative, signal);
  let initial: Stats;
  try { initial = await lstat(absolute); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { observation: { path: relative, state: 'absent', currentHash: null, bytes: 0 } };
    throw error;
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) throw new RestoreConflictError('Current target is not a regular file with a single link');
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(initial, opened)) throw new RestoreConflictError('Target identity changed during observation');
    if (opened.size > MAX_FILE_BYTES) throw new RestoreConflictError('Current file exceeds the restoration read limit');
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      assertRestoreActive(signal);
      const read = await handle.read(buffer, 0, buffer.length, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > MAX_FILE_BYTES) throw new RestoreConflictError('Current file exceeds the restoration read limit');
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    const observed = await handle.stat();
    if (!sameObservation(opened, observed)) throw new RestoreConflictError('File changed during observation');
    await safeTarget(root, relative, signal);
    const current = await checkedLstat(absolute);
    if (!current.isFile() || !sameObservation(observed, current)) throw new RestoreConflictError('Target path or content changed during observation');
    return { observation: { path: relative, state: 'present', currentHash: digest.digest('hex'), bytes }, stat: observed };
  } finally { await handle.close(); }
}

async function buildRestorePreview(workspace: Workspace, checkpoint: Checkpoint, activeRunIds: string[], totalBytes: number, options: RestoreOptions): Promise<RestorePreview> {
  const counts = new Map<string, number>();
  for (const file of checkpoint.files) counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
  const files: RestorePreviewFile[] = [];
  const identities: unknown[] = [];
  for (const file of checkpoint.files) {
    assertRestoreActive(options.signal);
    const entry: RestorePreviewFile = { path: file.path, operation: operation(file), postimageHash: file.afterHash, restoreHash: file.beforeHash, status: 'ready' };
    let identity: unknown = null;
    try {
      if ((counts.get(file.path) ?? 0) > 1) throw new RestoreConflictError('Checkpoint repeats this path; restoration is ambiguous');
      const problem = recordProblem(file);
      if (problem) throw new RestoreConflictError(problem);
      const { observation, stat } = await observeCurrent(workspace.root, file.path, options.signal);
      entry.currentHash = observation.currentHash;
      identity = stat ? { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } : null;
      if (observation.currentHash !== file.afterHash) throw new RestoreConflictError('Current content does not match the recorded postimage; external edits were preserved');
    } catch (error) {
      if (error instanceof EngineError && error.code === 'CANCELLED') throw error;
      entry.status = error instanceof RestoreConflictError ? 'conflict' : 'failed';
      entry.reason = errorText(error);
    }
    files.push(entry);
    identities.push(identity);
  }
  assertRestoreActive(options.signal);
  const warnings = restoreWarnings(checkpoint);
  if (activeRunIds.length) warnings.push('An active workspace Run prevents restoration; the readonly preview made no effects.');
  if (!options.executionLockPath) warnings.push('No shared execution lock is configured; the caller must serialize restoration with workspace effects.');
  const sortedRuns = [...activeRunIds].sort();
  // The fingerprint binds restore targets and observed state. A caller may add
  // the shared lease after a readonly preview without changing those targets.
  const fingerprint = hash(JSON.stringify({ version: 1, workspaceId: workspace.id, root: workspace.root, checkpointId: checkpoint.id, runId: checkpoint.runId, toolCallId: checkpoint.toolCallId, files, identities, activeRunIds: sortedRuns, warnings: restoreWarnings(checkpoint) }));
  return { checkpointId: checkpoint.id, workspaceId: workspace.id, fingerprint, files, activeRunIds: sortedRuns, canRestore: !sortedRuns.length && files.every((file) => file.status === 'ready'), warnings,
    limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxMetadataBytes: MAX_RESTORE_METADATA_BYTES }, totalBytes };
}

/** Readonly service: does not acquire/create an execution lock or write journal rows. */
export async function previewRestoreCheckpoint(store: EngineStore, workspace: Workspace, checkpointId: string, options: RestoreOptions = {}): Promise<RestorePreview> {
  validateRestoreOptions(options);
  const checkedOptions = { ...options };
  const checkedWorkspace = { ...workspace };
  const loaded = loadRestore(store, checkedWorkspace, checkpointId, checkedOptions.signal);
  return buildRestorePreview(checkedWorkspace, loaded.checkpoint, loaded.activeRunIds, loaded.totalBytes, checkedOptions);
}

/** Service-level restore; optional lock coordinates with patch/command effects. */
export async function restoreCheckpoint(store: EngineStore, workspace: Workspace, checkpointId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  validateRestoreOptions(options);
  const checkedOptions = { ...options };
  const checkedWorkspace = { ...workspace };
  const { checkpoint, activeRunIds, totalBytes } = loadRestore(store, checkedWorkspace, checkpointId, checkedOptions.signal);
  if (activeRunIds.length) throw new EngineError('RESTORE_WORKSPACE_BUSY', 'An active workspace Run prevents checkpoint restoration', { activeRunIds });
  const result: RestoreResult = { checkpointId, restored: [], conflicts: [], failed: [], warnings: restoreWarnings(checkpoint), cancelled: false, observations: [], effectsUncertain: false, executionBlocked: false };
  const counts = new Map<string, number>();
  for (const file of checkpoint.files) counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
  const duplicates = new Set<string>();
  const ready: CheckpointFile[] = [];
  const preflightIdentity = new Map<CheckpointFile, Stats>();
  // Read and validate every target before acquiring the effect lease.
  for (const file of checkpoint.files) {
    assertRestoreActive(checkedOptions.signal);
    try {
      if ((counts.get(file.path) ?? 0) > 1) {
        if (!duplicates.has(file.path)) result.conflicts.push({ path: file.path, reason: 'Checkpoint repeats this path; restoration is ambiguous' });
        duplicates.add(file.path);
        continue;
      }
      const problem = recordProblem(file);
      if (problem) throw new RestoreConflictError(problem);
      if (file.afterHash === null) await guardAbsent(checkedWorkspace.root, file, checkedOptions.signal);
      else {
        const target = await guardPresent(checkedWorkspace.root, file, false, checkedOptions.signal);
        preflightIdentity.set(file, target.observed);
        await target.handle.close();
      }
      ready.push(file);
    } catch (error) {
      if (error instanceof EngineError && error.code === 'CANCELLED') throw error;
      if (error instanceof RestoreConflictError) result.conflicts.push({ path: file.path, reason: error.message });
      else result.failed.push({ path: file.path, error: errorText(error), mayHaveChanged: false });
    }
  }
  assertRestoreActive(checkedOptions.signal);
  assertWorkspaceIdle(store, checkedWorkspace);
  // Nothing eligible means no effect lease/marker needs to be created.
  if (!ready.length && !checkedOptions.previewFingerprint) {
    if (checkedOptions.executionLockPath) assertExecutionLockAvailable(checkedOptions.executionLockPath);
    return result;
  }
  const lock = checkedOptions.executionLockPath ? acquireExecutionLock(checkedOptions.executionLockPath) : undefined;
  const attempted: { file: CheckpointFile; mayHaveChanged: boolean; closeUncertain: boolean }[] = [];
  try {
    assertRestoreActive(checkedOptions.signal);
    assertWorkspaceIdle(store, checkedWorkspace);
    if (checkedOptions.previewFingerprint) {
      const currentPreview = await buildRestorePreview(checkedWorkspace, checkpoint, [], totalBytes, checkedOptions);
      if (currentPreview.fingerprint !== checkedOptions.previewFingerprint) throw new EngineError('RESTORE_PREVIEW_STALE', 'Current restore targets differ from the preview; refresh it before restoring');
    }
    for (const file of ready) {
      const attempt = { file, mayHaveChanged: false, closeUncertain: false };
      attempted.push(attempt);
      const close = async (handle: Awaited<ReturnType<typeof open>>): Promise<void> => {
        try { await handle.close(); }
        catch (error) { attempt.closeUncertain = attempt.mayHaveChanged; throw error; }
      };
      try {
        assertRestoreActive(checkedOptions.signal);
        assertWorkspaceIdle(store, checkedWorkspace);
        // Recheck after lease acquisition and immediately before every effect.
        if (file.afterHash === null) {
          const absolute = await guardAbsent(checkedWorkspace.root, file, checkedOptions.signal);
          assertRestoreActive(checkedOptions.signal);
          assertWorkspaceIdle(store, checkedWorkspace);
          if (file.before !== null) {
            let handle;
            try { handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
            catch (error) {
              if (['EEXIST', 'ELOOP', 'ENOENT'].includes(errorCode(error) ?? '')) throw new RestoreConflictError('Target or parent changed before restoration');
              throw error;
            }
            attempt.mayHaveChanged = true; // exclusive open created the empty file
            try {
              const content = Buffer.from(file.before, 'utf8');
              let offset = 0;
              while (offset < content.length) {
                assertRestoreActive(checkedOptions.signal);
                const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
                if (bytesWritten === 0) throw new Error('Restoration made no progress while writing');
                offset += bytesWritten;
              }
              assertRestoreActive(checkedOptions.signal);
              await handle.sync();
            } finally { await close(handle); }
          }
        } else {
          const target = await guardPresent(checkedWorkspace.root, file, file.before !== null, checkedOptions.signal);
          try {
            const initial = preflightIdentity.get(file);
            if (initial && !sameFile(initial, target.observed)) throw new RestoreConflictError('Target identity changed after restoration preflight; the replacement file was preserved');
            if (file.before === null) {
              await safeTarget(checkedWorkspace.root, file.path, checkedOptions.signal);
              const current = await checkedLstat(target.absolute);
              if (!sameObservation(target.observed, current) || current.isSymbolicLink()) throw new RestoreConflictError('Target path or content changed immediately before deletion');
              assertRestoreActive(checkedOptions.signal);
              assertWorkspaceIdle(store, checkedWorkspace);
              attempt.mayHaveChanged = true;
              await unlink(target.absolute);
            } else if (operation(file) !== 'noop') {
              const content = Buffer.from(file.before, 'utf8');
              if (!sameObservation(target.observed, await target.handle.stat())) throw new RestoreConflictError('Target content changed immediately before restoration');
              assertRestoreActive(checkedOptions.signal);
              assertWorkspaceIdle(store, checkedWorkspace);
              let offset = 0;
              while (offset < content.length) {
                assertRestoreActive(checkedOptions.signal);
                attempt.mayHaveChanged = true;
                const { bytesWritten } = await target.handle.write(content, offset, content.length - offset, offset);
                if (bytesWritten === 0) throw new Error('Restoration made no progress while writing');
                offset += bytesWritten;
              }
              assertRestoreActive(checkedOptions.signal);
              attempt.mayHaveChanged = true;
              await target.handle.truncate(content.length);
              await target.handle.sync();
            }
          } finally { await close(target.handle); }
        }
        result.restored.push(file.path);
      } catch (error) {
        if (error instanceof EngineError && error.code === 'CANCELLED') {
          if (!attempted.some((entry) => entry.mayHaveChanged)) throw error;
          result.cancelled = true;
          if (attempt.mayHaveChanged) result.failed.push({ path: file.path, error: error.message, mayHaveChanged: true });
          result.warnings.push('Restoration was cancelled after filesystem effects; completed and partial effects were not rolled back.');
          break;
        }
        if (error instanceof EngineError && error.code === 'RESTORE_WORKSPACE_BUSY') {
          if (!attempted.some((entry) => entry.mayHaveChanged)) throw error;
          result.failed.push({ path: file.path, error: error.message, mayHaveChanged: attempt.mayHaveChanged });
          result.warnings.push('A workspace Run became active during restoration; remaining effects were stopped.');
          break;
        }
        if (error instanceof RestoreConflictError && !attempt.mayHaveChanged) result.conflicts.push({ path: file.path, reason: error.message });
        else result.failed.push({ path: file.path, error: errorText(error), mayHaveChanged: attempt.mayHaveChanged });
      }
    }
    if (checkedOptions.signal?.aborted && attempted.some((attempt) => attempt.mayHaveChanged)) result.cancelled = true;
    return result;
  } finally {
    // Ignore abort during accounting: every started effect must settle and be
    // observed before a known partial failure/cancellation releases the marker.
    for (const attempt of attempted) {
      if (!attempt.mayHaveChanged) continue;
      try {
        const { observation } = await observeCurrent(checkedWorkspace.root, attempt.file.path);
        result.observations.push(observation);
        if (observation.currentHash !== attempt.file.beforeHash) result.warnings.push(`Observed ${attempt.file.path} differs from the restoration preimage; a partial effect or concurrent external edit is present.`);
      } catch (error) {
        result.observations.push({ path: attempt.file.path, state: 'unobserved', error: errorText(error) });
        result.effectsUncertain = true;
        result.warnings.push(`Could not observe restoration effects for ${attempt.file.path}: ${errorText(error)}.`);
      }
      if (attempt.closeUncertain) {
        result.effectsUncertain = true;
        result.warnings.push(`Filesystem handle cleanup for ${attempt.file.path} is uncertain.`);
      }
    }
    if (checkedOptions.signal?.aborted && attempted.some((attempt) => attempt.mayHaveChanged)) {
      if (!result.cancelled) result.warnings.push('Cancellation arrived while completed effects were being observed; those effects were not rolled back.');
      result.cancelled = true;
    }
    if (result.failed.some((failure) => failure.mayHaveChanged)) result.warnings.push('Restoration partially failed after filesystem effects; inspect the observed paths before retrying.');
    result.executionBlocked = Boolean(lock && result.effectsUncertain);
    if (result.executionBlocked) result.warnings.push('The durable execution marker remains active because restoration effects are uncertain; reconcile them before starting further effects.');
    lock?.release(!result.effectsUncertain);
  }
}
