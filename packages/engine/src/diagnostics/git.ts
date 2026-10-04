import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { EngineError } from '@moodcode/contracts';
import { checkAbort } from './checks.js';
import type { GitDiagnostic, WorkspaceDiagnostic } from './types.js';

interface GitProbeOptions { executable: string; timeoutMs: number; signal?: AbortSignal }
interface GitProcessResult { exitCode: number | null; stdout: Buffer; code?: string }

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Credential values, Node launch hooks, and Git selector/config injections are not forwarded.
  const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'];
  for (const name of allowed) if (Object.hasOwn(process.env, name)) env[name] = process.env[name];
  return { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_PAGER: 'cat' };
}

/** Runs only caller-selected Git arguments, without a shell or raw error-message output. */
export async function runDiagnosticGit(args: readonly string[], options: GitProbeOptions, cwd?: string, maxBytes = 65_536): Promise<GitProcessResult> {
  checkAbort(options.signal);
  return new Promise((resolveResult, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(options.executable, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'status.submoduleSummary=false', ...args], { cwd, env: gitEnvironment(), detached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | undefined;
    let settled = false;
    const stop = (code: string): void => {
      if (settled || failure !== undefined) return;
      failure = code;
      try { if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const abort = () => stop('ABORTED');
    const timer = setTimeout(() => stop('GIT_TIMEOUT'), options.timeoutMs);
    const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const finish = (exitCode: number | null, code?: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure === 'ABORTED' || options.signal?.aborted) reject(new EngineError('ABORTED', 'Diagnostics cancelled'));
      else resolveResult({ exitCode, stdout: failure === undefined ? Buffer.concat(chunks) : Buffer.alloc(0), ...(failure ?? code ? { code: failure ?? code } : {}) });
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (stdout: boolean) => (chunk: Buffer): void => {
      if (settled || failure !== undefined) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { stop('GIT_OUTPUT_LIMIT'); return; }
      if (stdout) chunks.push(chunk);
    };
    child.stdout.on('data', collect(true));
    child.stderr.on('data', collect(false));
    child.once('error', (error: NodeJS.ErrnoException) => finish(null, error.code === 'ENOENT' ? 'GIT_NOT_FOUND' : 'GIT_SPAWN_FAILED'));
    child.once('close', (code) => finish(code));
  });
}

export async function probeGit(options: GitProbeOptions): Promise<GitDiagnostic> {
  const result = await runDiagnosticGit(['--version'], options, undefined, 1_024);
  const policy = { configuration: 'system_and_global_disabled', automaticFetch: 'disabled', processCleanup: process.platform === 'win32' ? 'direct_child' : 'posix_process_group' } as const;
  if (result.code !== undefined || result.exitCode !== 0) return { available: false, version: null, versionRecognized: false, status: result.code === 'GIT_NOT_FOUND' ? 'missing' : result.code === 'GIT_TIMEOUT' ? 'timeout' : 'failed', executable: options.executable, timeoutMs: options.timeoutMs, ...policy, code: result.code ?? 'GIT_VERSION_COMMAND_FAILED' };
  const match = /^git version (\d+\.\d+(?:\.\d+)?)(?:[\w .()+-]*)\r?\n?$/.exec(result.stdout.toString('utf8'));
  const version = match?.[1] !== undefined && match[1].length <= 64 ? match[1] : null;
  return { available: true, version, versionRecognized: version !== null, status: version === null ? 'unknown_version' : 'available', executable: options.executable, timeoutMs: options.timeoutMs, ...policy, ...(version === null ? { code: 'GIT_VERSION_UNRECOGNIZED' } : {}) };
}

function parseStatus(bytes: Buffer): { statusEntries: number; untrackedEntries: number; conflictedEntries: number } | null {
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0) return null;
  const records = bytes.toString('utf8').split('\0');
  records.pop();
  let statusEntries = 0;
  let untrackedEntries = 0;
  let conflictedEntries = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== ' ' || !/^[ MADRCU?!]{2}$/.test(record.slice(0, 2))) return null;
    const code = record.slice(0, 2);
    statusEntries++;
    if (code === '??') untrackedEntries++;
    if (code.includes('U') || code === 'AA' || code === 'DD') conflictedEntries++;
    if (code.includes('R') || code.includes('C')) {
      if (records[++index] === undefined || records[index] === '') return null;
    }
  }
  return { statusEntries, untrackedEntries, conflictedEntries };
}

export async function probeWorkspace(requested: string, git: GitDiagnostic, options: GitProbeOptions): Promise<WorkspaceDiagnostic> {
  const failure = (code: string): WorkspaceDiagnostic => ({ status: 'failed', requestedPath: requested, dirty: null, code });
  checkAbort(options.signal);
  let directory: string;
  try {
    directory = await realpath(resolve(requested));
    if (!(await stat(directory)).isDirectory()) return failure('WORKSPACE_NOT_DIRECTORY');
  } catch { checkAbort(options.signal); return failure('WORKSPACE_PATH_UNAVAILABLE'); }
  if (!git.available) return { status: 'not_checked', requestedPath: requested, dirty: null, code: 'GIT_UNAVAILABLE' };
  const discovery = await runDiagnosticGit(['rev-parse', '--path-format=absolute', '--show-toplevel'], options, directory, 8_192);
  if (discovery.code !== undefined || discovery.exitCode !== 0) return failure(discovery.code ?? 'GIT_WORKSPACE_DISCOVERY_FAILED');
  const discovered = discovery.stdout.toString('utf8').replace(/\r?\n$/, '');
  if (discovered.length === 0 || discovered.includes('\0') || !isAbsolute(discovered)) return failure('GIT_WORKSPACE_ROOT_INVALID');
  let root: string;
  try { root = await realpath(resolve(directory, discovered)); if (!(await stat(root)).isDirectory()) return failure('GIT_WORKSPACE_ROOT_INVALID'); }
  catch { checkAbort(options.signal); return failure('GIT_WORKSPACE_ROOT_INVALID'); }
  const results = await Promise.allSettled([
    runDiagnosticGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], options, root, 1_024),
    runDiagnosticGit(['config', '--name-only', '--get-regexp', '^(filter\\..*\\.(clean|process)|remote\\..*\\.promisor|extensions\\.partialclone)$'], options, root, 8_192),
    runDiagnosticGit(['ls-files', '--format=%(objectmode)'], options, root),
  ]);
  checkAbort(options.signal);
  const branchResult = results[0]!;
  const filterResult = results[1]!;
  const modesResult = results[2]!;
  if (branchResult.status === 'rejected') throw branchResult.reason;
  if (filterResult.status === 'rejected') throw filterResult.reason;
  if (modesResult.status === 'rejected') throw modesResult.reason;
  const branch = branchResult.value;
  const filters = filterResult.value;
  const modes = modesResult.value;
  if (branch.code !== undefined || (branch.exitCode !== 0 && branch.exitCode !== 1)) return { ...failure(branch.code ?? 'GIT_BRANCH_FAILED'), root };
  const name = branch.exitCode === 1 ? null : branch.stdout.toString('utf8').replace(/\r?\n$/, '');
  if (name === '' || name?.includes('\0')) return { ...failure('GIT_BRANCH_INVALID'), root };
  const unknown = (code: string): WorkspaceDiagnostic => ({ status: 'not_checked', requestedPath: requested, root, branch: name, dirty: null, code });
  if (!git.versionRecognized) return unknown('GIT_VERSION_UNRECOGNIZED');
  if (filters.code !== undefined || (filters.exitCode !== 0 && filters.exitCode !== 1)) return unknown('GIT_STATUS_CONFIG_NOT_VERIFIED');
  // Git status can run clean/process filters during content comparison. Do not invoke them.
  if (filters.stdout.length > 0) {
    const keys = filters.stdout.toString('utf8').split('\n').filter(Boolean);
    if (keys.some(key => /^(remote\..*\.promisor|extensions\.partialclone)$/i.test(key))) return unknown('GIT_PARTIAL_CLONE_STATUS_NOT_CHECKED');
    return unknown('GIT_EXTERNAL_FILTERS_NOT_CHECKED');
  }
  if (modes.code !== undefined || modes.exitCode !== 0) return unknown('GIT_STATUS_INDEX_NOT_VERIFIED');
  const modeLines = modes.stdout.toString('utf8').split('\n');
  if (modeLines.pop() !== '' || modeLines.some(mode => !/^[0-7]{6}$/.test(mode))) return unknown('GIT_STATUS_INDEX_NOT_VERIFIED');
  // Nested module configuration is a separate trust boundary; the doctor does not recurse into it.
  if (modeLines.includes('160000')) return unknown('GIT_SUBMODULE_STATUS_NOT_CHECKED');
  const status = await runDiagnosticGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], options, root);
  checkAbort(options.signal);
  if (status.code !== undefined || status.exitCode !== 0) return { ...failure(status.code ?? 'GIT_STATUS_FAILED'), root };
  const summary = parseStatus(status.stdout);
  if (summary === null) return { ...failure('GIT_STATUS_INVALID'), root };
  return { status: 'available', requestedPath: requested, root, branch: name, dirty: summary.statusEntries > 0, ...summary };
}
