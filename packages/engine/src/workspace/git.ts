import { spawn, type ChildProcess } from 'node:child_process';
import { EngineError } from '@moodcode/contracts';
import { createCommandEnvironment } from '../tools/command/process-control.js';

export interface GitOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const GIT_DETACHED = process.platform !== 'win32';
export const GIT_SAFE_ARGS = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']);

/**
 * Provider credentials and inherited Git selectors/config injections (which can
 * override -C) are not forwarded. Ordinary on-disk Git config remains available.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = createCommandEnvironment();
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  return Object.assign(env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' });
}

/** Kills a Git child spawned with GIT_DETACHED, including its helpers and hooks on POSIX. */
export function killGit(child: ChildProcess): void {
  try { if (GIT_DETACHED && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
  catch { child.kill('SIGKILL'); }
  // A helper that inherited the pipes must not hold cancellation open.
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** Internal bounded, shell-free Git runner. It never refreshes the index. */
export async function runGit(root: string, args: readonly string[], options: GitOperationOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new EngineError('INVALID_LIMIT', 'Git timeoutMs must be an integer from 1 to 60000.');
  }
  if (options.signal?.aborted) throw new EngineError('ABORTED', 'Git operation was aborted.');

  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_SAFE_ARGS, '-C', root, ...args], {
      env: gitEnvironment(), detached: GIT_DETACHED, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: EngineError | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const stop = (error: EngineError) => {
      if (settled || failure) return;
      failure = error;
      killGit(child);
    };
    const abort = () => stop(new EngineError('ABORTED', 'Git operation was aborted.'));
    const timer = setTimeout(() => stop(new EngineError('GIT_TIMEOUT', `Git operation exceeded ${timeoutMs} ms.`)), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (destination: Buffer[]) => (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        stop(new EngineError('GIT_OUTPUT_LIMIT', 'Git output exceeded the 2 MiB limit.'));
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure ?? new EngineError('GIT_UNAVAILABLE', `Could not execute Git: ${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) reject(failure);
      else if (code === null) reject(new EngineError('GIT_FAILED', 'Git terminated without an exit code.'));
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export function gitFailure(result: GitResult, message: string): EngineError {
  const diagnostic = result.stderr.toString('utf8').slice(0, 2048).trim();
  return new EngineError('GIT_FAILED', diagnostic ? `${message}: ${diagnostic}` : message, { exitCode: result.code });
}

export async function readBranch(root: string, options: GitOperationOptions): Promise<string | null> {
  const result = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  if (result.code === 1) return null;
  if (result.code !== 0) throw gitFailure(result, 'Could not read the current Git branch');
  return result.stdout.toString('utf8').replace(/\r?\n$/, '');
}
