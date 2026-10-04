import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { EngineError } from '@moodcode/contracts';
import type { ArtifactDiagnostic, CommandPlatformAssessment, NodeAssessment, SqliteDiagnostic } from './types.js';

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EngineError('ABORTED', 'Diagnostics cancelled');
}

export function assessNodeVersion(version: string): NodeAssessment {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/.exec(version);
  const major = match === null ? null : Number(match[1]);
  const minor = match === null ? null : Number(match[2]);
  const patch = match === null ? null : Number(match[3]);
  const recognized = major !== null && Number.isSafeInteger(major) && Number.isSafeInteger(minor) && Number.isSafeInteger(patch);
  return {
    actualVersion: version.slice(0, 128), versionRecognized: recognized, requiredVersion: '>=24.0.0',
    meetsMinimum: !recognized ? null : major! > 24 || (major === 24 && (!(minor === 0 && patch === 0) || match?.[4] === undefined)),
    assessment: 'version_comparison',
  };
}

export function assessCommandPlatform(platform: string): CommandPlatformAssessment {
  if (platform === 'win32') return { platform, supported: false, code: 'COMMAND_PLATFORM_UNSUPPORTED', assessment: 'implementation_policy' };
  const knownPosix = ['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos'];
  return knownPosix.includes(platform)
    ? { platform, supported: true, code: 'POSIX_PROCESS_GROUPS', assessment: 'implementation_policy' }
    : { platform: platform.slice(0, 128), supported: null, code: 'UNKNOWN_PLATFORM', assessment: 'implementation_policy' };
}

interface MemoryDatabase {
  prepare(sql: string): { get(): unknown };
  close(): void;
}

/** The optional loader is an isolated test seam; production loads the actual built-in module. */
export async function probeSqlite(load: () => Promise<unknown> = () => import('node:sqlite')): Promise<SqliteDiagnostic> {
  const result: SqliteDiagnostic = { available: false, verified: false, version: null, versionRecognized: false, probe: 'memory_database' };
  let module: unknown;
  try { module = await load(); }
  catch { return { ...result, code: 'SQLITE_MODULE_UNAVAILABLE' }; }
  if (typeof module !== 'object' || module === null || !('DatabaseSync' in module) || typeof module.DatabaseSync !== 'function') {
    return { ...result, code: 'SQLITE_API_UNAVAILABLE' };
  }
  result.available = true;
  let database: MemoryDatabase | undefined;
  try {
    const Constructor = module.DatabaseSync as new (path: string) => MemoryDatabase;
    database = new Constructor(':memory:');
    const row = database.prepare('SELECT sqlite_version() AS version, 40 + 2 AS result').get();
    if (typeof row !== 'object' || row === null || !('result' in row) || row.result !== 42) {
      result.code = 'SQLITE_QUERY_FAILED';
    } else {
      result.verified = true;
      const version = 'version' in row ? row.version : null;
      if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) && version.length <= 64) {
        result.version = version;
        result.versionRecognized = true;
      } else result.code = 'SQLITE_VERSION_UNRECOGNIZED';
    }
  } catch {
    result.code = 'SQLITE_PROBE_FAILED';
  } finally {
    try { database?.close(); }
    catch { result.verified = false; result.code = 'SQLITE_CLOSE_FAILED'; }
  }
  return result;
}

async function permitted(path: string, mode: number, signal?: AbortSignal): Promise<boolean> {
  checkAbort(signal);
  try { await access(path, mode); checkAbort(signal); return true; }
  catch { checkAbort(signal); return false; }
}

/** Observes the nearest existing ancestor without creating the requested parent. */
export async function probeArtifactParent(requested: string, signal?: AbortSignal): Promise<ArtifactDiagnostic> {
  const result: ArtifactDiagnostic = { status: 'failed', requestedParent: requested, createPossible: null, assessment: 'access_checks_only' };
  let candidate = resolve(requested);
  let missing = 0;
  while (true) {
    checkAbort(signal);
    try {
      const lexical = await lstat(candidate);
      checkAbort(signal);
      if (lexical.isSymbolicLink()) {
        try { candidate = await realpath(candidate); }
        catch { return { ...result, code: 'ARTIFACT_ANCESTOR_LINK_UNAVAILABLE' }; }
      }
      const info = await stat(candidate);
      checkAbort(signal);
      if (!info.isDirectory()) return { ...result, createPossible: false, code: 'ARTIFACT_ANCESTOR_NOT_DIRECTORY' };
      const canonical = await realpath(candidate);
      const [readable, writable, searchable] = await Promise.all([
        permitted(canonical, constants.R_OK, signal), permitted(canonical, constants.W_OK, signal),
        process.platform === 'win32' ? Promise.resolve(null) : permitted(canonical, constants.X_OK, signal),
      ]);
      checkAbort(signal);
      return { status: 'observed', requestedParent: requested, existingAncestor: canonical, missingDirectories: missing, mode: (info.mode & 0o7777).toString(8).padStart(4, '0'), readable, writable, searchable, createPossible: process.platform === 'win32' ? null : writable && searchable === true, assessment: 'access_checks_only' };
    } catch (error) {
      checkAbort(signal);
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ...result, code: 'ARTIFACT_ANCESTOR_UNAVAILABLE' };
      const parent = dirname(candidate);
      if (parent === candidate) return { ...result, code: 'ARTIFACT_ANCESTOR_UNAVAILABLE' };
      candidate = parent;
      missing++;
    }
  }
}
