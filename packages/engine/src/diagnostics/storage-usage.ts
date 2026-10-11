import { constants, type BigIntStats, type Dir } from 'node:fs';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EngineError } from '@moodcode/contracts';
import { errnoCode, sameRegularFile, stableStat } from '../shared/fs.js';

export type StorageUsageGroup = 'managed' | 'input-media' | 'input-documents' | 'children' | 'terminals' | 'other' | 'database';
export type StorageStopReason = 'aborted' | 'time_limit' | 'entry_limit' | 'directory_limit' | 'depth_limit' | 'operation_limit'
  | 'root_missing' | 'unsafe_path' | 'io_error' | 'changed_entry' | 'symlink_skipped' | 'special_file_skipped' | 'unsafe_byte_count';
export interface StorageUsageLimits {
  maxEntries: number; maxDirectories: number; maxDepth: number; maxDurationMs: number; maxOperations: number;
  maxSamples: number; maxSamplePathBytes: number; maxReportBytes: number; maxImageIds: number; maxDocumentIds: number;
}
export const DEFAULT_STORAGE_USAGE_LIMITS: Readonly<StorageUsageLimits> = Object.freeze({
  maxEntries: 10_000, maxDirectories: 1_024, maxDepth: 12, maxDurationMs: 2_000, maxOperations: 100_000,
  maxSamples: 64, maxSamplePathBytes: 256, maxReportBytes: 32_768, maxImageIds: 2_048, maxDocumentIds: 2_048,
});
/** Structural slice of the bounded primary database index; a partial index cannot identify orphan candidates. */
export interface StorageImageIndex {
  scope: 'primary-database-only'; complete: boolean; observedAt: string; imageIds: readonly string[];
}
export interface StorageDocumentIndex {
  scope: 'primary-database-only'; complete: boolean; observedAt: string; documentIds: readonly string[];
}
export interface StorageUsageOptions {
  artifactDir: string; dbPath?: string; signal?: AbortSignal; limits?: Partial<StorageUsageLimits>; imageIndex?: StorageImageIndex; documentIndex?: StorageDocumentIndex;
}
export interface StorageGroupUsage {
  entries: number; directories: number; regularFiles: number; stableFiles: number; logicalPathBytes: number;
  symlinks: number; hardlinkedFiles: number; specialFiles: number; changedEntries: number; errors: number;
}
export interface StorageUsageSample {
  root: 'artifacts' | 'database'; path: string; pathTruncated: boolean; group: StorageUsageGroup;
  kind: 'file' | 'directory' | 'symlink' | 'special' | 'changed' | 'error'; bytes?: number; hardlinked?: boolean;
}
export interface StorageUsageReport {
  schemaVersion: 1; startedAt: string; observedAt: string; elapsedMs: number; complete: boolean;
  stopReason: StorageStopReason | null; stopReasons: StorageStopReason[]; limits: StorageUsageLimits;
  logicalPathBytes: number; uniqueObservedInodeBytes: number; duplicateInodePaths: number;
  observedEntries: number; observedDirectories: number; observedRegularFiles: number; stableFiles: number; operations: number;
  skippedDepthDirectories: number; unvisitedEntries: number | null;
  roots: { artifacts: 'observed' | 'missing' | 'unsafe' | 'not_visited'; database: 'not_requested' | 'observed' | 'missing' | 'unsafe' | 'not_visited' };
  groups: Record<StorageUsageGroup, StorageGroupUsage>; samples: StorageUsageSample[]; samplesOmitted: number; reportTruncated: boolean;
  images: {
    indexStatus: 'absent' | 'incomplete' | 'invalid' | 'complete'; indexObservedAt: string | null; indexedIds: number;
    coverage: 'root-input-media-only'; complete: boolean; candidateFiles: number; candidateBytes: number;
    candidates: { path: string; pathTruncated: boolean; id: string; bytes: number }[]; candidatesOmitted: number;
    assessment: 'unreferenced-in-primary-index-snapshot-only'; deletionPerformed: false;
  };  documents: {
    indexStatus: 'absent' | 'incomplete' | 'invalid' | 'complete'; indexObservedAt: string | null; indexedIds: number;
    coverage: 'root-input-documents-only'; complete: boolean; candidateFiles: number; candidateBytes: number;
    candidates: { path: string; pathTruncated: boolean; id: string; bytes: number }[]; candidatesOmitted: number;
    assessment: 'unreferenced-in-primary-index-snapshot-only'; deletionPerformed: false;
  };
  coverage: {
    accounting: 'regular-file-logical-size'; physicalAllocatedBytes: null; contentsRead: false; databaseOpened: false;
    symlinkTargets: 'not-scanned'; specialFileContents: 'not-read'; hardlinks: 'path-bytes-and-observed-inode-dedup';
    snapshot: 'non-atomic-with-identity-and-size-rechecks'; pathRaceIsolation: 'not-a-filesystem-sandbox';
    deadline: 'cooperative-between-filesystem-operations'; databaseScope: 'explicit-main-wal-shm-only';
    externalStorage: 'not-discovered'; childImageIndexes: 'not-read'; childDocumentIndexes: 'not-read'; cleanup: 'not-performed';
  };
}

type Phase = 'before_lstat' | 'before_file_recheck' | 'before_directory_open' | 'before_directory_read' | 'before_directory_recheck';
/** @internal Deterministic scheduling seam for real-filesystem fixtures, not exposed by the package barrel. */
export interface StorageUsageTestHooks { beforeOperation?: (phase: Phase, relativePath: string) => void | Promise<void>; now?: () => number }
/** @internal The production entrypoint never accepts hooks. */
export function createStorageInspectorForTesting(hooks: StorageUsageTestHooks): (options: StorageUsageOptions) => Promise<StorageUsageReport> {
  return options => inspect(options, hooks);
}

const groups: StorageUsageGroup[] = ['managed', 'input-media', 'input-documents', 'children', 'terminals', 'other', 'database'];
const MAX_PATH_BYTES = 4_096;
const ranges: Record<keyof StorageUsageLimits, readonly [number, number]> = {
  maxEntries: [1, 100_000], maxDirectories: [1, 10_000], maxDepth: [0, 32], maxDurationMs: [1, 30_000], maxOperations: [1, 1_000_000],
  maxSamples: [0, 256], maxSamplePathBytes: [32, 2_048], maxReportBytes: [4_096, 131_072], maxImageIds: [1, 65_536], maxDocumentIds: [1, 65_536],
};
function invalid(): never { throw new EngineError('INVALID_STORAGE_USAGE_OPTIONS', 'Storage inspection options are invalid.'); }
function validate(input: StorageUsageOptions): StorageUsageOptions & { limits: StorageUsageLimits } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['artifactDir', 'dbPath', 'signal', 'limits', 'imageIndex', 'documentIndex'].includes(key))) invalid();
  for (const path of [input.artifactDir, input.dbPath]) if (path !== undefined && (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || path.includes('\0') || Buffer.byteLength(path) > MAX_PATH_BYTES)) invalid();
  if (typeof input.artifactDir !== 'string') invalid();
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) invalid();
  if (input.limits !== undefined && (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits) || Object.keys(input.limits).some(key => !Object.hasOwn(ranges, key)))) invalid();
  const limits = { ...DEFAULT_STORAGE_USAGE_LIMITS, ...input.limits };
  for (const key of Object.keys(ranges) as (keyof StorageUsageLimits)[]) {
    const [min, max] = ranges[key]; if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max) invalid();
  }
  return { ...input, limits };
}
function blankGroup(): StorageGroupUsage { return { entries: 0, directories: 0, regularFiles: 0, stableFiles: 0, logicalPathBytes: 0, symlinks: 0, hardlinkedFiles: 0, specialFiles: 0, changedEntries: 0, errors: 0 }; }
function safeSample(value: string, maxBytes: number): { path: string; pathTruncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { path: value, pathTruncated: false };
  // UTF-8 truncation can replace a partial final character; it never exposes an absolute root.
  let path = Buffer.from(value).subarray(0, maxBytes - 3).toString('utf8');
  while (Buffer.byteLength(path) + 3 > maxBytes) path = path.slice(0, -1);
  return { path: path + '…', pathTruncated: true };
}
class StopScan extends Error {}
interface PinnedDirectory { path: string; stat: BigIntStats }

/** No file contents are opened or read. All sizes are logical observations, not disk allocation or deletion advice. */
export async function inspectEngineStorage(options: StorageUsageOptions): Promise<StorageUsageReport> { return inspect(options, {}); }

async function inspect(options: StorageUsageOptions, hooks: StorageUsageTestHooks): Promise<StorageUsageReport> {
  const selected = validate(options), limits = selected.limits, now = hooks.now ?? (() => performance.now()), start = now();
  const report: StorageUsageReport = {
    schemaVersion: 1, startedAt: new Date().toISOString(), observedAt: '', elapsedMs: 0, complete: true, stopReason: null, stopReasons: [], limits: { ...limits },
    logicalPathBytes: 0, uniqueObservedInodeBytes: 0, duplicateInodePaths: 0, observedEntries: 0, observedDirectories: 0, observedRegularFiles: 0, stableFiles: 0, operations: 0,
    skippedDepthDirectories: 0, unvisitedEntries: 0, roots: { artifacts: 'not_visited', database: selected.dbPath === undefined ? 'not_requested' : 'not_visited' },
    groups: Object.fromEntries(groups.map(group => [group, blankGroup()])) as Record<StorageUsageGroup, StorageGroupUsage>, samples: [], samplesOmitted: 0, reportTruncated: false,
    images: { indexStatus: 'absent', indexObservedAt: null, indexedIds: 0, coverage: 'root-input-media-only', complete: false, candidateFiles: 0, candidateBytes: 0, candidates: [], candidatesOmitted: 0, assessment: 'unreferenced-in-primary-index-snapshot-only', deletionPerformed: false },    documents: { indexStatus: 'absent', indexObservedAt: null, indexedIds: 0, coverage: 'root-input-documents-only', complete: false, candidateFiles: 0, candidateBytes: 0, candidates: [], candidatesOmitted: 0, assessment: 'unreferenced-in-primary-index-snapshot-only', deletionPerformed: false },
    coverage: { accounting: 'regular-file-logical-size', physicalAllocatedBytes: null, contentsRead: false, databaseOpened: false, symlinkTargets: 'not-scanned', specialFileContents: 'not-read', hardlinks: 'path-bytes-and-observed-inode-dedup', snapshot: 'non-atomic-with-identity-and-size-rechecks', pathRaceIsolation: 'not-a-filesystem-sandbox', deadline: 'cooperative-between-filesystem-operations', databaseScope: 'explicit-main-wal-shm-only', externalStorage: 'not-discovered', childImageIndexes: 'not-read', childDocumentIndexes: 'not-read', cleanup: 'not-performed' },
  };
  const fail = (reason: StorageStopReason): void => {
    report.complete = false; report.unvisitedEntries = null;
    if (!report.stopReasons.includes(reason)) report.stopReasons.push(reason);
    report.stopReason ??= reason;
  };
  const halt = (reason: StorageStopReason): never => { fail(reason); report.stopReason = reason; throw new StopScan(); };
  const check = (): void => {
    if (selected.signal?.aborted) halt('aborted');
    if (now() - start >= limits.maxDurationMs) halt('time_limit');
  };
  const operation = async <T>(fn: () => Promise<T>, checkAfter = true): Promise<T> => {
    check(); if (report.operations >= limits.maxOperations) halt('operation_limit');
    report.operations++; const result = await fn(); if (checkAfter) check(); return result;
  };
  const hook = async (phase: Phase, relativePath: string): Promise<void> => { check(); await hooks.beforeOperation?.(phase, relativePath); check(); };
  const sample = (root: StorageUsageSample['root'], path: string, group: StorageUsageGroup, kind: StorageUsageSample['kind'], extra: Pick<StorageUsageSample, 'bytes' | 'hardlinked'> = {}): void => {
    if (report.samples.length >= limits.maxSamples) { report.samplesOmitted++; report.reportTruncated = true; return; }
    report.samples.push({ root, ...safeSample(path, limits.maxSamplePathBytes), group, kind, ...extra });
  };
  const imageIds = new Set<string>(), index = selected.imageIndex;
  if (index !== undefined) {
    if (!index || typeof index !== 'object' || index.scope !== 'primary-database-only' || typeof index.complete !== 'boolean' || !Array.isArray(index.imageIds)
      || index.imageIds.length > limits.maxImageIds || typeof index.observedAt !== 'string' || index.observedAt.length > 32 || !Number.isFinite(Date.parse(index.observedAt))
      || index.imageIds.some(id => typeof id !== 'string' || !/^img_[0-9a-f]{32}$/u.test(id)) || new Set(index.imageIds).size !== index.imageIds.length) report.images.indexStatus = 'invalid';
    else {
      report.images.indexStatus = index.complete ? 'complete' : 'incomplete'; report.images.indexObservedAt = index.observedAt; report.images.indexedIds = index.imageIds.length;
      if (index.complete) for (const id of index.imageIds) imageIds.add(id);
    }
  }
  const documentIds = new Set<string>(), docIndex = selected.documentIndex;
  if (docIndex !== undefined) {
    if (!docIndex || typeof docIndex !== 'object' || docIndex.scope !== 'primary-database-only' || typeof docIndex.complete !== 'boolean' || !Array.isArray(docIndex.documentIds)
      || docIndex.documentIds.length > limits.maxDocumentIds || typeof docIndex.observedAt !== 'string' || docIndex.observedAt.length > 32 || !Number.isFinite(Date.parse(docIndex.observedAt))
      || docIndex.documentIds.some(id => typeof id !== 'string' || !/^doc_[0-9a-f]{32}$/u.test(id)) || new Set(docIndex.documentIds).size !== docIndex.documentIds.length) report.documents.indexStatus = 'invalid';
    else {
      report.documents.indexStatus = docIndex.complete ? 'complete' : 'incomplete'; report.documents.indexObservedAt = docIndex.observedAt; report.documents.indexedIds = docIndex.documentIds.length;
      if (docIndex.complete) for (const id of docIndex.documentIds) documentIds.add(id);
    }
  }
  const dbPaths = selected.dbPath === undefined ? [] : [selected.dbPath, selected.dbPath + '-wal', selected.dbPath + '-shm'];
  const dbLabels = new Map(dbPaths.map((path, index) => [path, ['main', 'wal', 'shm'][index]!]));
  const databaseStatus = (status: 'observed' | 'missing' | 'unsafe'): void => {
    const rank = { not_requested: 0, not_visited: 0, observed: 1, missing: 2, unsafe: 3 };
    if (rank[status] > rank[report.roots.database]) report.roots.database = status;
  };
  const visitedPaths = new Set<string>(), observedInodes = new Map<string, number>();
  const classify = (path: string, relativePath: string): StorageUsageGroup => {
    if (dbLabels.has(path)) return 'database';
    const top = relativePath.split('/')[0];
    if (top === 'managed' || top === 'input-media' || top === 'input-documents' || top === 'children') return top;
    if (top === 'terminals' || top === 'terminals.sqlite' || top === 'terminals.sqlite-wal' || top === 'terminals.sqlite-shm') return 'terminals';
    return 'other';
  };
  const changed = (root: StorageUsageSample['root'], relativePath: string, group: StorageUsageGroup): void => { report.groups[group].changedEntries++; fail('changed_entry'); sample(root, relativePath, group, 'changed'); };
  const guard = async (chain: readonly PinnedDirectory[]): Promise<boolean> => {
    for (const item of chain) {
      try { const current = await operation(() => lstat(item.path, { bigint: true })); if (!current.isDirectory() || current.isSymbolicLink() || !stableStat(item.stat, current)) return false; }
      catch (error) { if (error instanceof StopScan) throw error; return false; }
    }
    return true;
  };
  const ancestors = async (path: string): Promise<PinnedDirectory[] | null> => {
    let current = parse(path).root; const chain: PinnedDirectory[] = [];
    for (const component of ['', ...path.slice(current.length).split(sep).filter(Boolean)]) {
      if (component) current = join(current, component);
      const info = await operation(() => lstat(current, { bigint: true }));
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
      chain.push({ path: current, stat: info });
    }
    return chain;
  };
  const recordFile = async (path: string, relativePath: string, root: StorageUsageSample['root'], group: StorageUsageGroup, info: BigIntStats, chain: readonly PinnedDirectory[]): Promise<void> => {
    const stats = report.groups[group]; report.observedRegularFiles++; stats.regularFiles++;
    if (info.nlink > 1n) stats.hardlinkedFiles++;
    await hook('before_file_recheck', relativePath);
    try {
      const after = await operation(() => lstat(path, { bigint: true }));
      if (!sameRegularFile(info, after) || !(await guard(chain))) { changed(root, relativePath, group); return; }
    } catch (error) { if (error instanceof StopScan) throw error; changed(root, relativePath, group); return; }
    if (info.size < 0n || info.size > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(report.logicalPathBytes) + info.size > BigInt(Number.MAX_SAFE_INTEGER)) { fail('unsafe_byte_count'); stats.errors++; sample(root, relativePath, group, 'error'); return; }
    const bytes = Number(info.size), identity = `${info.dev}:${info.ino}`;
    report.stableFiles++; stats.stableFiles++; stats.logicalPathBytes += bytes; report.logicalPathBytes += bytes;
    if (observedInodes.has(identity)) { report.duplicateInodePaths++; if (observedInodes.get(identity) !== bytes) fail('changed_entry'); }
    else { observedInodes.set(identity, bytes); report.uniqueObservedInodeBytes += bytes; }
    sample(root, relativePath, group, 'file', { bytes, ...(info.nlink > 1n ? { hardlinked: true } : {}) });
    // A published blob can precede the index CAS; this is an observation, never permission to delete.
    const generated = root === 'artifacts' ? /^input-media\/(img_[0-9a-f]{32})\.blob$/u.exec(relativePath) : null;
    if (generated && info.nlink === 1n && report.images.indexStatus === 'complete' && !imageIds.has(generated[1]!)) {
      report.images.candidateFiles++; report.images.candidateBytes += bytes;
      if (report.images.candidates.length < limits.maxSamples) report.images.candidates.push({ ...safeSample(relativePath, limits.maxSamplePathBytes), id: generated[1]!, bytes });
      else { report.images.candidatesOmitted++; report.reportTruncated = true; }
    }    const generatedDocument = root === 'artifacts' ? /^input-documents\/(doc_[0-9a-f]{32})\.blob$/u.exec(relativePath) : null;
    if (generatedDocument && info.nlink === 1n && report.documents.indexStatus === 'complete' && !documentIds.has(generatedDocument[1]!)) {
      report.documents.candidateFiles++; report.documents.candidateBytes += bytes;
      if (report.documents.candidates.length < limits.maxSamples) report.documents.candidates.push({ ...safeSample(relativePath, limits.maxSamplePathBytes), id: generatedDocument[1]!, bytes });
      else { report.documents.candidatesOmitted++; report.reportTruncated = true; }
    }
  };
  const visit = async (path: string, relativePath: string, root: StorageUsageSample['root'], depth: number, chain: readonly PinnedDirectory[], known?: BigIntStats): Promise<void> => {
    check(); if (visitedPaths.has(path)) return;
    if (report.observedEntries >= limits.maxEntries) halt('entry_limit');
    if (!(await guard(chain))) { changed(root, relativePath, root === 'database' ? 'database' : classify(path, relativePath)); return; }
    visitedPaths.add(path); report.observedEntries++;
    const group = root === 'database' ? 'database' : classify(path, relativePath), stats = report.groups[group]; stats.entries++;
    await hook('before_lstat', relativePath);
    let info: BigIntStats;
    try { info = known ?? await operation(() => lstat(path, { bigint: true })); }
    catch (error) { if (error instanceof StopScan) throw error; if (group === 'database') databaseStatus('unsafe'); stats.errors++; fail('io_error'); sample(root, relativePath, group, 'error'); return; }
    if (group === 'database') {
      if (!info.isFile() || info.isSymbolicLink()) { databaseStatus('unsafe'); fail('unsafe_path'); sample(root, relativePath, group, info.isSymbolicLink() ? 'symlink' : 'error'); return; }
      databaseStatus('observed');
    }
    if (info.isSymbolicLink()) { stats.symlinks++; fail('symlink_skipped'); sample(root, relativePath, group, 'symlink'); return; }
    if (info.isFile()) { await recordFile(path, relativePath, root, group, info, chain); return; }
    if (!info.isDirectory()) { stats.specialFiles++; fail('special_file_skipped'); sample(root, relativePath, group, 'special'); return; }
    if (report.observedDirectories >= limits.maxDirectories) halt('directory_limit');
    report.observedDirectories++; stats.directories++; sample(root, relativePath, group, 'directory');
    if (depth >= limits.maxDepth) { report.skippedDepthDirectories++; fail('depth_limit'); return; }
    const nextChain = [...chain, { path, stat: info }]; let handle: FileHandle | undefined, directory: Dir | undefined;
    try {
      await hook('before_directory_open', relativePath);
      if (!(await guard(nextChain))) { changed(root, relativePath, group); return; }
      // Pin the observed inode without following the last component. Path-based enumeration remains non-atomic.
      handle = await operation(() => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0)), false); check();
      const opened = await operation(() => handle!.stat({ bigint: true }));
      if (!opened.isDirectory() || !stableStat(info, opened)) { changed(root, relativePath, group); return; }
      directory = await operation(() => opendir(path, { bufferSize: 1 }), false); check();
      if (!(await guard(nextChain))) { changed(root, relativePath, group); return; }
      while (true) {
        await hook('before_directory_read', relativePath);
        if (!(await guard(nextChain))) { changed(root, relativePath, group); return; }
        const entry = await operation(() => directory!.read()); if (!entry) break;
        if (entry.name === '.' || entry.name === '..' || entry.name.includes(sep) || entry.name.includes('\0')) { fail('unsafe_path'); continue; }
        await visit(join(path, entry.name), relativePath === '.' ? entry.name : relativePath + '/' + entry.name, root, depth + 1, nextChain);
      }
      await hook('before_directory_recheck', relativePath);
      const pinned = await operation(() => handle!.stat({ bigint: true }));
      if (!stableStat(info, pinned, ['mtime', 'ctime']) || !(await guard(nextChain))) changed(root, relativePath, group);
    } catch (error) {
      if (error instanceof StopScan) throw error;
      if (['ELOOP', 'ENOTDIR', 'ENOENT'].includes(errnoCode(error) ?? '')) changed(root, relativePath, group);
      else { stats.errors++; fail('io_error'); sample(root, relativePath, group, 'error'); }
    } finally {
      // Never race a read with a timer-driven close. Every acquired handle is joined before returning.
      try { await directory?.close(); } catch { stats.errors++; fail('io_error'); }
      try { await handle?.close(); } catch { stats.errors++; fail('io_error'); }
    }
  };
  try {
    check(); let chain: PinnedDirectory[] | null;
    try { chain = await ancestors(selected.artifactDir); }
    catch (error) {
      if (error instanceof StopScan) throw error;
      report.roots.artifacts = errnoCode(error) === 'ENOENT' ? 'missing' : 'unsafe'; fail(errnoCode(error) === 'ENOENT' ? 'root_missing' : 'io_error'); chain = null;
    }
    if (chain === null) { if (report.roots.artifacts === 'not_visited') { report.roots.artifacts = 'unsafe'; fail('unsafe_path'); } }
    else { report.roots.artifacts = 'observed'; await visit(selected.artifactDir, '.', 'artifacts', 0, chain.slice(0, -1), chain.at(-1)!.stat); }
    for (const path of dbPaths) {
      check(); if (visitedPaths.has(path)) continue;
      const label = dbLabels.get(path)!; let info: BigIntStats;
      try { info = await operation(() => lstat(path, { bigint: true })); }
      catch (error) {
        if (error instanceof StopScan) throw error;
        if (errnoCode(error) === 'ENOENT' && path !== selected.dbPath) continue;
        databaseStatus(errnoCode(error) === 'ENOENT' ? 'missing' : 'unsafe'); fail(errnoCode(error) === 'ENOENT' ? 'root_missing' : 'io_error'); continue;
      }
      let parents: PinnedDirectory[] | null;
      try { parents = await ancestors(resolve(path, '..')); }
      catch (error) { if (error instanceof StopScan) throw error; parents = null; }
      if (parents === null || !info.isFile() || info.isSymbolicLink()) { databaseStatus('unsafe'); fail('unsafe_path'); continue; }
      databaseStatus('observed'); await visit(path, label, 'database', 0, parents, info);
    }
  } catch (error) { if (!(error instanceof StopScan)) throw error; }
  try { check(); } catch (error) { if (!(error instanceof StopScan)) throw error; }
  report.images.complete = report.complete && report.images.indexStatus === 'complete';
  report.documents.complete = report.complete && report.documents.indexStatus === 'complete';
  report.observedAt = new Date().toISOString(); report.elapsedMs = Math.max(0, Math.ceil(now() - start));
  const fits = (): boolean => Buffer.byteLength(JSON.stringify(report)) <= limits.maxReportBytes;
  while (!fits() && report.samples.length) { report.samples.pop(); report.samplesOmitted++; report.reportTruncated = true; }
  while (!fits() && report.images.candidates.length) { report.images.candidates.pop(); report.images.candidatesOmitted++; report.reportTruncated = true; }
  while (!fits() && report.documents.candidates.length) { report.documents.candidates.pop(); report.documents.candidatesOmitted++; report.reportTruncated = true; }
  if (!fits()) throw new EngineError('STORAGE_USAGE_REPORT_LIMIT', 'Storage metadata exceeds the report byte budget.');
  return report;
}
