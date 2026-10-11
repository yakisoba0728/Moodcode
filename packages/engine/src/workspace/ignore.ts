import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EngineError, type Workspace } from '@moodcode/contracts';
import { jsonTextSha256 } from '../shared/canonical.js';
import { GIT_DETACHED, GIT_SAFE_ARGS, gitEnvironment, killGit } from './git.js';
import { resolveWorkspacePath } from './index.js';

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.output', '.svelte-kit', '.cache', 'cache', 'caches', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
]);
const TOKEN_KEY = randomBytes(32);
const MAX_BATCH_BYTES = 16_384;
const MAX_TOKEN_BYTES = 2_048;

export function excludedDirectory(name: string): boolean { return EXCLUDED_DIRECTORIES.has(name.toLowerCase()); }
export function excludedTraversalPath(path: string, directory: boolean): boolean {
  const components = path.split('/');
  return (directory ? components : components.slice(0, -1)).some(excludedDirectory);
}

async function ignoreBatch(root: string, paths: string[], signal?: AbortSignal): Promise<string[]> {
  if (signal?.aborted) throw new EngineError('ABORTED', 'Workspace ignore lookup was aborted');
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_SAFE_ARGS, '-c', 'core.excludesFile=/dev/null', '-C', root, 'check-ignore', '--no-index', '--stdin', '-z'], { env: gitEnvironment(), detached: GIT_DETACHED, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: EngineError | undefined;
    const stop = (error: EngineError) => { failure ??= error; killGit(child); };
    const abort = () => stop(new EngineError('ABORTED', 'Workspace ignore lookup was aborted'));
    const timeout = setTimeout(() => stop(new EngineError('IGNORE_LOOKUP_FAILED', 'Git ignore lookup timed out')), 5_000);
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) stop(new EngineError('IGNORE_LOOKUP_FAILED', 'Git ignore lookup exceeded its output limit'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65_536) stop(new EngineError('IGNORE_LOOKUP_FAILED', 'Git ignore lookup exceeded its output limit')); });
    child.stdin.on('error', () => { /* Early Git failure is reported by its exit. */ });
    child.once('error', () => { cleanup(); reject(failure ?? new EngineError('IGNORE_LOOKUP_FAILED', 'Git ignore lookup could not be started')); });
    child.once('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0 && code !== 1) reject(new EngineError('IGNORE_LOOKUP_FAILED', 'Git ignore rules could not be evaluated'));
      else resolve(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean));
    });
    child.stdin.end(`${paths.join('\0')}\0`);
  });
}

/** Git implements nested patterns, negation and escaping; no shell or index refresh. */
export async function ignoredWorkspacePaths(workspace: Workspace, paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
  if (signal?.aborted) throw new EngineError('ABORTED', 'Workspace ignore lookup was aborted');
  await resolveWorkspacePath(workspace, '.');
  const ignored = new Set<string>();
  let batch: string[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (!batch.length) return;
    const allowed = new Set(batch);
    for (const item of await ignoreBatch(workspace.root, batch, signal)) {
      if (!allowed.has(item)) throw new EngineError('IGNORE_LOOKUP_FAILED', 'Git ignore lookup returned an unexpected path');
      ignored.add(item);
    }
    batch = []; bytes = 0;
  };
  for (const path of paths) {
    if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || Buffer.byteLength(path) > 4_096) {
      throw new EngineError('INVALID_WORKSPACE_PATH', 'Ignore lookup requires bounded workspace-relative paths');
    }
    const size = Buffer.byteLength(path) + 1;
    if (batch.length >= 128 || bytes + size > MAX_BATCH_BYTES) await flush();
    batch.push(path); bytes += size;
  }
  await flush();
  return ignored;
}

/** Outside a Git repository `git check-ignore` fails, and nothing is ignored. */
export async function gitIgnoredPaths(workspace: Workspace, paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
  return workspace.gitRoot ? ignoredWorkspacePaths(workspace, paths, signal) : new Set();
}

/** Paths that are Git-ignored or inside an excluded traversal directory. */
export async function excludedWorkspacePaths(workspace: Workspace, paths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
  const ignored = await gitIgnoredPaths(workspace, paths, signal);
  return new Set(paths.filter(path => ignored.has(path) || excludedTraversalPath(path, false)));
}

export const snapshotFingerprint: (value: unknown) => string = jsonTextSha256;

interface PageToken { scope: string; snapshot: string; offset: number }
function invalidContinuation(): never { throw new EngineError('INVALID_CONTINUATION', 'Continuation is malformed or does not belong to this process; request a fresh page'); }

/** Tokens contain only hashes and offsets; they authorize no paths or external effects. */
export function continuationToken(scope: string, snapshot: string, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 1) return invalidContinuation();
  const body = Buffer.from(JSON.stringify({ scope, snapshot, offset })).toString('base64url');
  return `${body}.${createHmac('sha256', TOKEN_KEY).update(body).digest('base64url')}`;
}

export function validateContinuation(token: string): PageToken {
  if (typeof token !== 'string' || Buffer.byteLength(token) > MAX_TOKEN_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return invalidContinuation();
  const [body, signature] = token.split('.');
  const expected = createHmac('sha256', TOKEN_KEY).update(body!).digest();
  const supplied = Buffer.from(signature!, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return invalidContinuation();
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')); } catch { return invalidContinuation(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalidContinuation();
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'offset,scope,snapshot' || typeof value.scope !== 'string' || !/^[a-f0-9]{64}$/.test(value.scope) || typeof value.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot) || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 1) return invalidContinuation();
  return value as unknown as PageToken;
}

export function continuationOffset(token: string | undefined, scope: string, snapshot: string, total: number): number {
  if (token === undefined) return 0;
  const decoded = validateContinuation(token);
  if (decoded.scope !== scope) throw new EngineError('INVALID_CONTINUATION', 'Continuation does not match this workspace, path or request');
  if (decoded.snapshot !== snapshot) throw new EngineError('STALE_CONTINUATION', 'Files or ignore results changed; request a fresh page');
  if (decoded.offset >= total) return invalidContinuation();
  return decoded.offset;
}
