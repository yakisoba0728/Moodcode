import { EngineError } from '@moodcode/contracts';
import { createCommandEnvironment, executeShell, type ProcessOutcome, type ShellInput, type ShellOutput } from './process-control.js';

export interface CommandBackendCapability {
  platform: string; available: boolean; processTree: 'posix-group' | 'windows-job-object' | 'unsupported';
  isolation: 'host-user'; fileIsolation: false; networkIsolation: false; parentCrashCleanup: boolean; code?: string;
}
export interface CommandProcessBackend {
  capability(): CommandBackendCapability;
  execute(input: ShellInput, signal: AbortSignal, output: ShellOutput, started: (pid: number) => void, warn: (message: string) => void): Promise<ProcessOutcome>;
}
export class PosixCommandBackend implements CommandProcessBackend {
  capability(): CommandBackendCapability {
    const available = ['darwin', 'linux', 'freebsd'].includes(process.platform);
    return { platform: process.platform, available, processTree: available ? 'posix-group' : 'unsupported', isolation: 'host-user', fileIsolation: false, networkIsolation: false, parentCrashCleanup: false, ...(!available ? { code: 'COMMAND_PLATFORM_UNSUPPORTED' } : {}) };
  }
  execute(input: ShellInput, signal: AbortSignal, output: ShellOutput, started: (pid: number) => void, warn: (message: string) => void): Promise<ProcessOutcome> {
    if (!this.capability().available) return Promise.reject(new EngineError('COMMAND_PLATFORM_UNSUPPORTED', 'The host has no supported POSIX command backend'));
    return executeShell(input, signal, output, started, warn);
  }
}

/** Native Windows host implementation must use CREATE_SUSPENDED before assign. */
export interface WindowsSuspendedProcess {
  readonly pid: number;
  /** Resolves only after the primary process and forwarded output have settled. */
  readonly closed: Promise<{ exitCode: number | null }>;
  terminate(): Promise<void>;
}
/** Kill-on-close job handles must remain owned by the real engine process. */
export interface WindowsOwnedJob {
  spawnSuspended(input: ShellInput, environment: NodeJS.ProcessEnv, output: ShellOutput): Promise<WindowsSuspendedProcess>;
  assign(process: WindowsSuspendedProcess): Promise<void>;
  resume(process: WindowsSuspendedProcess): Promise<void>;
  terminate(): Promise<void>;
  /** Must be backed by QueryInformationJobObject, never a cached child PID. */
  activeProcessCount(): Promise<number>;
  close(): Promise<void>;
}
export interface WindowsJobHostPort {
  readonly platform: 'win32';
  readonly killOnClose: true;
  readonly suspendedAssignment: true;
  createJob(): Promise<WindowsOwnedJob>;
}
export const WINDOWS_JOB_LIMITS = Object.freeze({ operationMs: 10_000, cleanupMs: 3_000, pollMs: 20 });

/**
 * Orchestrates an injected native Job Object host. There is no taskkill or
 * direct-child fallback: absent native ownership stays explicitly unsupported.
 * This portable module does not itself provide a Windows native binding.
 */
export class WindowsJobCommandBackend implements CommandProcessBackend {
  constructor(private readonly host?: WindowsJobHostPort) {}
  capability(): CommandBackendCapability {
    const available = process.platform === 'win32' && this.host?.platform === 'win32' && this.host.killOnClose === true && this.host.suspendedAssignment === true;
    return { platform: process.platform, available, processTree: available ? 'windows-job-object' : 'unsupported', isolation: 'host-user', fileIsolation: false, networkIsolation: false, parentCrashCleanup: available, ...(!available ? { code: 'WINDOWS_JOB_BACKEND_UNAVAILABLE' } : {}) };
  }
  async execute(input: ShellInput, signal: AbortSignal, output: ShellOutput, started: (pid: number) => void, warn: (message: string) => void): Promise<ProcessOutcome> {
    if (!this.capability().available || !this.host) throw new EngineError('WINDOWS_JOB_BACKEND_UNAVAILABLE', 'A native Windows Job Object host is required');
    return executeOwnedWindowsJob(this.host, input, signal, output, started, warn);
  }
}

/** Exported for host adapter contract tests; actual OS capability stays separate. */
export async function executeOwnedWindowsJob(host: WindowsJobHostPort, input: ShellInput, signal: AbortSignal, output: ShellOutput, started: (pid: number) => void, warn: (message: string) => void): Promise<ProcessOutcome> {
  if (signal.aborted) return { exitCode: null, signal: null, cancelled: true, timedOut: false, cleanupConfirmed: true, started: false };
  let job: WindowsOwnedJob | undefined, child: WindowsSuspendedProcess | undefined;
  let assigned = false, cancelled = false, timedOut = false, exitCode: number | null = null;
  let spawnDispatched = false, spawnSettled = false;
  let cleanupConfirmed = false, error: string | undefined;
  const abort = new AbortController();
  const onAbort = () => { cancelled = true; abort.abort(); };
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, input.timeoutMs);
  const bounded = async <T>(operation: Promise<T>, maxMs: number = WINDOWS_JOB_LIMITS.operationMs): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new EngineError('WINDOWS_JOB_OPERATION_TIMEOUT', 'The native Windows ownership operation timed out')), maxMs); })]); }
    finally { if (timeout) clearTimeout(timeout); }
  };
  const interrupted = async <T>(operation: Promise<T>): Promise<T> => {
    let listener!: () => void;
    try { return await Promise.race([bounded(operation), new Promise<never>((_resolve, reject) => { listener = () => reject(new EngineError('ABORTED', 'Windows command was stopped')); abort.signal.addEventListener('abort', listener, { once: true }); if (abort.signal.aborted) listener(); })]); }
    finally { abort.signal.removeEventListener('abort', listener); }
  };
  const observeEmpty = async (): Promise<boolean> => {
    if (!job) return child === undefined;
    const deadline = performance.now() + WINDOWS_JOB_LIMITS.cleanupMs;
    do {
      const count = await bounded(job.activeProcessCount(), Math.max(1, deadline - performance.now()));
      if (!Number.isSafeInteger(count) || count < 0) return false;
      if (count === 0) return true;
      await new Promise(resolve => setTimeout(resolve, WINDOWS_JOB_LIMITS.pollMs));
    } while (performance.now() < deadline);
    return false;
  };
  try {
    const opening = host.createJob();
    void opening.then(late => { if (abort.signal.aborted && !job) void late.close().catch(() => {}); }, () => {});
    job = await interrupted(opening);
    spawnDispatched = true;
    const spawning = job.spawnSuspended(input, createCommandEnvironment(), output);
    let adopted = false;
    void spawning.then(late => { spawnSettled = true; if (!adopted && abort.signal.aborted) void late.terminate().catch(() => {}); }, () => { spawnSettled = true; });
    child = await interrupted(spawning); adopted = true;
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new EngineError('WINDOWS_JOB_INVALID_PID', 'The native host returned an invalid process identity');
    await interrupted(job.assign(child)); assigned = true;
    // Record ownership before resume: assignment/startup failure must never run
    // the command outside its kill-on-close Job Object.
    started(child.pid);
    await interrupted(job.resume(child));
    const completed = await interrupted(child.closed); exitCode = completed.exitCode;
    if (!await observeEmpty()) { warn('The primary Windows command exited while its owned job retained descendants.'); await bounded(job.terminate(), WINDOWS_JOB_LIMITS.cleanupMs); }
    cleanupConfirmed = await observeEmpty();
  } catch {
    abort.abort(); error = 'Windows command ownership, execution, or cleanup failed.';
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', onAbort);
    try {
      if (!cleanupConfirmed) {
        if (child && !assigned) await bounded(child.terminate(), WINDOWS_JOB_LIMITS.cleanupMs);
        if (job) await bounded(job.terminate(), WINDOWS_JOB_LIMITS.cleanupMs);
        cleanupConfirmed = await observeEmpty() && (!spawnDispatched || spawnSettled);
        if (child) await bounded(child.closed, WINDOWS_JOB_LIMITS.cleanupMs);
      }
    } catch { cleanupConfirmed = false; }
    try { if (job) await bounded(job.close(), WINDOWS_JOB_LIMITS.cleanupMs); }
    catch { cleanupConfirmed = false; }
  }
  return { exitCode, signal: null, cancelled, timedOut, cleanupConfirmed, started: assigned,
    ...(!cleanupConfirmed || error ? { error: error ?? 'Windows process ownership could not be confirmed stopped.' } : {}) };
}
