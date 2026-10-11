import type { EngineError } from '@moodcode/contracts';

export const TERMINATION_LIMITS = Object.freeze({ termGraceMs: 250, killWaitMs: 2_000, pollMs: 20 });

const PROVIDER_SECRET_NAMES = new Set([
  'MOODCODE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_ADMIN_KEY', 'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AZURE_OPENAI_API_KEY', 'MISTRAL_API_KEY',
  'COHERE_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY', 'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY',
  'HUGGINGFACE_API_KEY', 'HF_TOKEN',
]);
const HOST_SECRET_NAMES = new Set<string>();

/** Adds host-declared credential variable names for this process; names are never removed. */
export function registerCredentialEnvNames(names: readonly string[]): void {
  for (const name of names) HOST_SECRET_NAMES.add(name.toUpperCase());
}

/** Copies the environment without provider credentials and host-declared credential names. */
export function createCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    const engineSecret = /^MOODCODE_/.test(upper) && /(?:^|_)(?:APIKEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|AUTHORIZATION)(?:_|$)/.test(upper.slice('MOODCODE_'.length));
    const providerSecret = /^(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE_OPENAI|MISTRAL|COHERE|XAI|GROQ|DEEPSEEK|TOGETHER|OPENROUTER|PERPLEXITY)_(?:API_KEYS?|ACCESS_TOKEN|AUTH_TOKEN|SECRET|TOKEN)(?:_|$)/.test(upper);
    if (upper !== 'ELECTRON_RUN_AS_NODE' && !PROVIDER_SECRET_NAMES.has(upper) && !HOST_SECRET_NAMES.has(upper) && !engineSecret && !providerSecret && value !== undefined) result[key] = value;
  }
  return result;
}

export type PidPresence = 'alive' | 'absent' | 'unknown';

/** Signal-0 probe of a pid or its process group. Only ESRCH proves absence; any other failure, and a group probe on Windows, is unknown. */
export function pidPresence(pid: number, { group = false }: { group?: boolean } = {}): { presence: PidPresence; error?: unknown } {
  if (group && process.platform === 'win32') return { presence: 'unknown' };
  try { process.kill(group ? -pid : pid, 0); return { presence: 'alive' }; }
  catch (error) { return { presence: (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown', error }; }
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

export async function cleanupGroup(pid: number, closed: () => boolean = () => true): Promise<boolean> {
  signalGroup(pid, 'SIGTERM');
  if (await settleGroup(pid, closed, TERMINATION_LIMITS.termGraceMs)) return true;
  signalGroup(pid, 'SIGKILL');
  return settleGroup(pid, closed, TERMINATION_LIMITS.killWaitMs);
}

/**
 * Settles like `promise` unless `signal` aborts first, then rejects with the module's coded `onAbort()` error.
 * `propagateReason` rejects with the signal's own reason instead, which may carry private caller context; a nullish reason still gets `onAbort()`.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => EngineError, { propagateReason = false }: { propagateReason?: boolean } = {}): Promise<T> {
  const reason = (): unknown => propagateReason ? signal.reason ?? onAbort() : onAbort();
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(reason());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Whether `promise` settles, either way, within `ms`. Never rejects; the outcome stays on `promise`. */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>(resolve => { timer = setTimeout(resolve, ms, false); }),
  ]).finally(() => clearTimeout(timer));
}
