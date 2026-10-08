import { createRequire } from 'node:module';
import { EngineError } from '@moodcode/contracts';
import type { ShellOutput } from './process-control.js';
import type { WindowsJobHostPort, WindowsOwnedJob, WindowsSuspendedProcess } from './backends.js';

interface NativeOutput {
  stdout: Buffer; stderr: Buffer; stdoutClosed: boolean; stderrClosed: boolean;
  exited: boolean; exitCode: number | null;
}
interface NativeChild {
  readonly pid: number;
  readOutput(maxBytes?: number): NativeOutput;
  terminate(): void;
  close(): void;
}
interface NativeJob {
  spawnSuspended(input: { command: string; cwd: string; environment: Record<string, string> }): NativeChild;
  assign(child: NativeChild): void;
  resume(child: NativeChild): void;
  terminate(): void;
  activeProcessCount(): number;
  close(): void;
}
export interface WindowsJobNativeBinding { createJob(): NativeJob }

const POLL_MS = 10;
const READ_BYTES = 65_536;

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Assignment failure may close a child before the orchestrator awaits it.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function adaptChild(native: NativeChild, output: ShellOutput): WindowsSuspendedProcess {
  const exited = deferred<{ exitCode: number | null }>(), closed = deferred<{ exitCode: number | null }>();
  let stopped = false, discarded = false, pending = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  const dispose = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    native.close();
  };
  const deliver = (stream: 'stdout' | 'stderr', bytes: Buffer): void => {
    if (discarded || bytes.length === 0) return;
    try {
      const result = output(stream, bytes);
      if (result !== undefined) {
        pending++;
        void Promise.resolve(result).then(() => { pending--; }, error => { pending--; if (!discarded) failure = error; });
      }
    } catch (error) { failure = error; }
  };
  const poll = (): void => {
    if (stopped) return;
    try {
      // Poll exit even with a blocked sink. Status-only reads retain pipe bytes
      // in the kernel and keep JavaScript memory bounded to one read batch.
      const state = native.readOutput(pending > 0 && !discarded ? 0 : READ_BYTES);
      if (state.exited) exited.resolve({ exitCode: state.exitCode });
      if (failure !== undefined) throw failure;
      deliver('stdout', state.stdout); deliver('stderr', state.stderr);
      if (failure !== undefined) throw failure;
      if (state.exited && state.stdoutClosed && state.stderrClosed && (discarded || pending === 0)) {
        dispose(); closed.resolve({ exitCode: state.exitCode }); return;
      }
      timer = setTimeout(poll, POLL_MS);
    } catch (error) {
      try { dispose(); } catch { /* Preserve the read/delivery failure. */ }
      exited.reject(error); closed.reject(error);
    }
  };
  timer = setTimeout(poll, 0);
  return {
    pid: native.pid, exited: exited.promise, closed: closed.promise,
    async terminate() { native.terminate(); },
    discardOutput() { discarded = true; },
    async close() {
      if (stopped) return;
      try { dispose(); }
      finally {
        const error = new EngineError('WINDOWS_JOB_OUTPUT_UNSETTLED', 'The native child closed before output settlement');
        exited.reject(error); closed.reject(error);
      }
    },
  };
}

/** Handles live in this Node process, including an Electron engine utility. */
export function createWindowsJobHost(binding: WindowsJobNativeBinding): WindowsJobHostPort {
  return { platform: 'win32', killOnClose: true, suspendedAssignment: true, async createJob(): Promise<WindowsOwnedJob> {
    const job = binding.createJob(), children = new Map<WindowsSuspendedProcess, NativeChild>();
    const own = (child: WindowsSuspendedProcess): NativeChild => {
      const native = children.get(child);
      if (!native) throw new EngineError('WINDOWS_JOB_FOREIGN_PROCESS', 'The suspended child belongs to another job');
      return native;
    };
    return {
      async spawnSuspended(input, environment, output) {
        const filtered: Record<string, string> = {};
        for (const [name, value] of Object.entries(environment)) if (value !== undefined) filtered[name] = value;
        const native = job.spawnSuspended({ command: input.command, cwd: input.cwd, environment: filtered });
        const child = adaptChild(native, output); children.set(child, native); return child;
      },
      async assign(child) { job.assign(own(child)); },
      async resume(child) { job.resume(own(child)); },
      async terminate() { job.terminate(); },
      async activeProcessCount() { return job.activeProcessCount(); },
      async close() {
        // Closing the job first enforces kill-on-close before releasing pipe and
        // process handles. A failed child close cannot skip the other children.
        let failure: unknown;
        try { job.close(); } catch (error) { failure = error; }
        for (const child of children.keys()) try { await child.close?.(); } catch (error) { failure ??= error; }
        children.clear();
        if (failure !== undefined) throw failure;
      },
    };
  } };
}

/** Unavailable or unbuilt native ownership never falls back to a direct child. */
export function loadWindowsJobHost(): WindowsJobHostPort | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const nativeModule: unknown = createRequire(import.meta.url)('@moodcode/windows-job');
    if (!nativeModule || typeof (nativeModule as { loadBinding?: unknown }).loadBinding !== 'function') return undefined;
    const binding: unknown = (nativeModule as { loadBinding(): unknown }).loadBinding();
    if (!binding || typeof (binding as WindowsJobNativeBinding).createJob !== 'function') return undefined;
    return createWindowsJobHost(binding as WindowsJobNativeBinding);
  } catch { return undefined; }
}
