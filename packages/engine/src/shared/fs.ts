import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync, type BigIntStats, type Stats } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** True when candidate is root or below it; both paths must already be resolved the same way. */
export function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Checks an absolute path component by component, before resolve() can erase a symlink followed by '..'. A missing component throws ENOENT unless allowMissing. */
export function symlinkFreeDirectorySync(path: string, options: { readonly allowMissing?: boolean; readonly onUnsafe: () => never }): string {
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    if (component === '.') continue;
    if (component === '..') { current = dirname(current); continue; }
    current = join(current, component);
    const info = lstatSync(current, { throwIfNoEntry: !options.allowMissing });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) options.onUnsafe();
  }
  return resolve(path);
}

/** Requires a canonical directory path without symlink components, optionally creating missing directories with mode 0700. */
export async function symlinkFreeDirectory(path: string, options: { readonly create?: boolean; readonly onUnsafe: () => never }): Promise<Stats> {
  let current = parse(path).root, info = await lstat(current);
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { info = await lstat(current); }
    catch (error) {
      if (!options.create || errnoCode(error) !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (errnoCode(error) !== 'EEXIST') throw error; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) options.onUnsafe();
  }
  if (await realpath(path) !== path) options.onUnsafe();
  return info;
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export type StableField = 'size' | 'nlink' | 'mode' | 'mtime' | 'ctime';
type FileStats = Stats | BigIntStats;
function statField(info: FileStats, field: StableField): number | bigint {
  if (field === 'mtime') return 'mtimeNs' in info ? info.mtimeNs : info.mtimeMs;
  if (field === 'ctime') return 'ctimeNs' in info ? info.ctimeNs : info.ctimeMs;
  return info[field];
}
/** Same device and inode, and the same value for each listed field; times compare at the precision of the stats given. */
export function stableStat<T extends FileStats>(a: T, b: T | undefined, fields: readonly StableField[] = []): boolean {
  return b !== undefined && a.dev === b.dev && a.ino === b.ino && fields.every(field => statField(a, field) === statField(b, field));
}
/** actual is still the expected regular file: same identity, size, times and link count. */
export function sameRegularFile<T extends FileStats>(expected: T, actual: T | undefined): boolean {
  return Boolean(actual?.isFile()) && stableStat(expected, actual, ['size', 'mtime', 'ctime', 'nlink']);
}

export interface StableFileOptions {
  readonly maxBytes: number;
  /** Fields that must still match the expected stats after the read, on the descriptor and on the path. */
  readonly stable: readonly StableField[];
  readonly check?: () => void;
  readonly requireSingleLink?: boolean;
  /** Created exclusively with mode 0600; the caller removes it on failure. */
  readonly copyTo?: string;
  readonly fsyncCopy?: boolean;
  readonly onChanged: () => never;
  readonly onLimit: () => never;
}
export interface StableFileRead<T extends FileStats> { readonly stats: T; readonly bytes: number; readonly sha256: string }

const CHUNK_BYTES = 1024 * 1024;
/** Hashes, and optionally copies, the regular file the caller already lstat'd as expected, binding the descriptor and the path to it. */
export function streamStableFile<T extends FileStats>(path: string, expected: T, options: StableFileOptions): StableFileRead<T> {
  const { maxBytes, stable, check, requireSingleLink, copyTo, onChanged, onLimit } = options, bigint = typeof expected.size === 'bigint';
  const regular = (info: T | undefined): boolean => Boolean(info?.isFile()) && (!requireSingleLink || Number(info!.nlink) === 1);
  if (Number(expected.size) > maxBytes) onLimit();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let output: number | undefined;
  try {
    const opened = fstatSync(fd, { bigint }) as T;
    if (!stableStat(expected, opened) || !regular(opened)) onChanged();
    if (copyTo !== undefined) output = openSync(copyTo, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes + 1));
    let bytes = 0;
    for (;;) {
      check?.();
      const count = readSync(fd, buffer, 0, buffer.length, bytes);
      if (!count) break;
      bytes += count;
      if (bytes > maxBytes) onLimit();
      digest.update(buffer.subarray(0, count));
      for (let written = 0; output !== undefined && written < count;) {
        const wrote = writeSync(output, buffer, written, count - written);
        if (!wrote) onChanged();
        written += wrote;
      }
    }
    const stats = fstatSync(fd, { bigint }) as T, current = lstatSync(path, { bigint, throwIfNoEntry: false }) as T | undefined;
    if (bytes !== Number(expected.size) || !regular(current) || !stableStat(expected, stats, stable) || !stableStat(expected, current, stable)) onChanged();
    if (output !== undefined && options.fsyncCopy) fsyncSync(output);
    return { stats, bytes, sha256: digest.digest('hex') };
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(fd);
  }
}

/** Pins a canonical regular file at bigint precision; any other file, or one already over maxBytes, fails through onUnsafe (default onChanged). */
export function readStableFile(path: string, options: StableFileOptions & { readonly onUnsafe?: () => never }): StableFileRead<BigIntStats> {
  const expected = lstatSync(path, { bigint: true });
  if (!expected.isFile() || options.requireSingleLink && expected.nlink !== 1n || expected.size > BigInt(options.maxBytes) || realpathSync(path) !== path) (options.onUnsafe ?? options.onChanged)();
  return streamStableFile(path, expected, options);
}
