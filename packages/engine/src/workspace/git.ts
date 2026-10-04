import { spawn } from 'node:child_process';
import { EngineError } from '@moodcode/contracts';

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

/** Internal bounded, shell-free Git runner. It never refreshes the index. */
export async function runGit(root: string, args: readonly string[], options: GitOperationOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new EngineError('INVALID_LIMIT', 'Git timeoutMs must be an integer from 1 to 60000.');
  }
  if (options.signal?.aborted) throw new EngineError('ABORTED', 'Git operation was aborted.');
  const env: NodeJS.ProcessEnv = {};
  // Inherited repository selectors/config injections can override -C and invoke
  // an fsmonitor helper. Ordinary on-disk Git config remains available.
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  Object.assign(env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' });

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
      child.kill('SIGKILL');
      // A helper that inherited the pipes must not hold cancellation open.
      child.stdout.destroy();
      child.stderr.destroy();
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
