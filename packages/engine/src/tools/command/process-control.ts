import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EngineError } from '@moodcode/contracts';
import type { CommandProcessBackend } from './backends.js';

export const TERMINATION_LIMITS = Object.freeze({ termGraceMs: 250, killWaitMs: 2_000, pollMs: 20 });
export interface ShellInput { command: string; cwd: string; timeoutMs: number }
export interface ProcessOutcome { exitCode: number | null; signal: NodeJS.Signals | null; cancelled: boolean; timedOut: boolean; cleanupConfirmed: boolean; started: boolean; outputDiscarded?: boolean; error?: string }
export type ShellOutput = (stream: 'stdout' | 'stderr', bytes: Buffer) => void | Promise<void>;

const PROVIDER_SECRET_NAMES = new Set([
  'MOODCODE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_OPENAI_API_KEY', 'MISTRAL_API_KEY',
  'COHERE_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY', 'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY',
  'HUGGINGFACE_API_KEY', 'HF_TOKEN',
]);

/** Copies the environment without the engine's provider credentials. */
export function createCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    const engineSecret = /^MOODCODE_/.test(upper) && /(?:^|_)(?:APIKEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|AUTHORIZATION)(?:_|$)/.test(upper.slice('MOODCODE_'.length));
    const providerSecret = /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE_OPENAI|MISTRAL|COHERE|XAI|GROQ|DEEPSEEK|TOGETHER|OPENROUTER|PERPLEXITY)_(?:API_KEYS?|ACCESS_TOKEN|AUTH_TOKEN|SECRET|TOKEN)(?:_|$)/.test(upper);
    if (upper !== 'ELECTRON_RUN_AS_NODE' && !PROVIDER_SECRET_NAMES.has(upper) && !engineSecret && !providerSecret && value !== undefined) result[key] = value;
  }
  return result;
}

export function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // Permission denial cannot establish absence. Keep observing within the
    // cleanup deadline rather than treating a transient denial as completion.
    if (code === 'EPERM') return true;
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A denied signal is never proof of cleanup; settleGroup must still observe
    // both pipe closure and group absence, or return false at the deadline.
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

async function settleGroup(pid: number, closed: () => boolean, durationMs: number): Promise<boolean> {
  const deadline = performance.now() + durationMs;
  do {
    if (closed() && !groupExists(pid)) return true;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(TERMINATION_LIMITS.pollMs, Math.max(1, deadline - performance.now()))));
  } while (performance.now() < deadline);
  return closed() && !groupExists(pid);
}

async function waitGroupAbsent(pid: number, durationMs: number): Promise<boolean> {
  const deadline = performance.now() + durationMs;
  do {
    if (!groupExists(pid)) return true;
    await new Promise<void>(resolve => setTimeout(resolve, TERMINATION_LIMITS.pollMs));
  } while (performance.now() < deadline);
  return !groupExists(pid);
}

export async function cleanupGroup(pid: number, closed: () => boolean = () => true): Promise<boolean> {
  signalGroup(pid, 'SIGTERM');
  if (await settleGroup(pid, closed, TERMINATION_LIMITS.termGraceMs)) return true;
  signalGroup(pid, 'SIGKILL');
  return settleGroup(pid, closed, TERMINATION_LIMITS.killWaitMs);
}

export async function executeShell(input: ShellInput, signal: AbortSignal, output: ShellOutput, started: (pid: number) => void, warn: (message: string) => void, backend?: CommandProcessBackend): Promise<ProcessOutcome> {
  if (signal.aborted) return { exitCode: null, signal: null, cancelled: true, timedOut: false, cleanupConfirmed: true, started: false };
  if (backend) {
    const capability = backend.capability();
    if (!capability.available || capability.platform !== process.platform || capability.processTree === 'unsupported') throw new EngineError('COMMAND_BACKEND_UNAVAILABLE', 'The injected command backend has no supported ownership on this platform');
    return backend.execute(input, signal, output, started, warn);
  }
  if (!['darwin', 'linux', 'freebsd'].includes(process.platform)) throw new EngineError('COMMAND_PLATFORM_UNSUPPORTED', 'Shell execution requires a supported owned process backend');
  const child = spawn(input.command, { cwd: input.cwd, env: createCommandEnvironment(), shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let closed = false;
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let processError: string | undefined;
  let cancelled = false;
  let timedOut = false;
  let wake: (() => void) | undefined;
  let cleanup: Promise<boolean> | undefined;
  let stopReason: 'cancel' | 'timeout' | 'descendants' | undefined;
  let exitInspected = false;
  let discardOutput = false;
  const pendingOutput = new Set<Promise<void>>();
  const warning = (message: string): void => {
    try { warn(message); }
    catch (error) { processError ??= `Could not report command warning: ${error instanceof Error ? error.message : String(error)}`; }
  };
  const discardAndDrain = (): void => {
    if (discardOutput) return;
    discardOutput = true;
    pendingOutput.clear();
    warning('Output capture is incomplete: only forwarded/observed bytes are available; unread shell output and blocked parent-pipe bytes may have been discarded.');
    // Releasing read backpressure is essential: a paused pipe can otherwise
    // prevent the shell close event even after its process group was killed.
    child.stdout?.resume();
    child.stderr?.resume();
  };
  const terminate = (reason: 'cancel' | 'timeout' | 'descendants'): void => {
    if (cleanup) return;
    stopReason = reason;
    cancelled = reason === 'cancel';
    timedOut = reason === 'timeout';
    discardAndDrain();
    cleanup = child.pid === undefined ? Promise.resolve(closed) : cleanupGroup(child.pid, () => closed).catch(error => {
      processError = `Process group cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    });
    wake?.();
  };
  const attachOutput = (stream: 'stdout' | 'stderr', readable: Readable | null): void => {
    if (!readable) return;
    readable.on('data', (chunk: Buffer) => {
      if (discardOutput) return;
      readable.pause();
      try {
        const delivery = output(stream, chunk);
        if (delivery === undefined) {
          if (!discardOutput) readable.resume();
          return;
        }
        const pending = Promise.resolve(delivery);
        pendingOutput.add(pending);
        const settle = (): void => {
          pendingOutput.delete(pending);
          if (!discardOutput && !readable.destroyed) readable.resume();
          wake?.();
        };
        void pending.then(settle, error => {
          if (!discardOutput) {
            processError = `Command output delivery failed: ${error instanceof Error ? error.message : String(error)}`;
            terminate('descendants');
          }
          settle();
        });
      } catch (error) {
        processError = `Command output delivery failed: ${error instanceof Error ? error.message : String(error)}`;
        terminate('descendants');
      }
    });
  };
  attachOutput('stdout', child.stdout);
  attachOutput('stderr', child.stderr);
  child.stdout?.on('error', error => { processError = error.message; terminate('descendants'); });
  child.stderr?.on('error', error => { processError = error.message; terminate('descendants'); });
  child.on('error', error => { processError = error.message; wake?.(); });
  child.on('exit', (code, exitSignalValue) => { exited = true; exitCode = code; exitSignal = exitSignalValue; wake?.(); });
  child.on('close', (code, exitSignalValue) => { closed = true; exitCode = code; exitSignal = exitSignalValue; wake?.(); });
  if (child.pid !== undefined) {
    try { started(child.pid); }
    catch (error) { processError = `Could not record command group: ${error instanceof Error ? error.message : String(error)}`; terminate('descendants'); }
  }
  const onAbort = (): void => terminate('cancel');
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => terminate('timeout'), input.timeoutMs);
  if (signal.aborted) onAbort();
  try {
    while (!cleanup && (!closed || pendingOutput.size > 0)) {
      await new Promise<void>(resolveWake => {
        wake = resolveWake;
        if (cleanup || processError || (exited && !exitInspected) || (closed && pendingOutput.size === 0)) resolveWake();
      });
      wake = undefined;
      if (exited && !exitInspected && !cleanup) {
        exitInspected = true;
        // A slow output consumer can delay pipe close after the shell exited.
        // Group absence alone identifies whether descendants still need cleanup.
        if (child.pid !== undefined && !await waitGroupAbsent(child.pid, TERMINATION_LIMITS.pollMs)) {
          warning('The shell exited while its process group remained active; remaining descendants were terminated.');
          terminate('descendants');
        }
      }
      if (processError && !cleanup && child.pid !== undefined) terminate('descendants');
      if (processError && child.pid === undefined && !closed) await new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
    }
    if (!cleanup && child.pid !== undefined && groupExists(child.pid)) {
      warning('The shell closed while its process group remained active; remaining descendants were terminated.');
      terminate('descendants');
    }
    const cleanupConfirmed = cleanup ? await cleanup : closed;
    if (!cleanupConfirmed) {
      processError ??= 'The command process group could not be confirmed stopped within the cleanup deadline.';
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
    if (stopReason === 'descendants') processError ??= 'The command left running descendants; they required engine cleanup.';
    return { exitCode, signal: exitSignal, cancelled, timedOut, cleanupConfirmed, started: child.pid !== undefined, ...(discardOutput ? { outputDiscarded: true } : {}), ...(processError ? { error: processError } : {}) };
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', onAbort); }
}
