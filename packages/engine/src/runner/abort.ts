import { EngineError } from '@moodcode/contracts';

const UNSAFE_EFFECT_ERRORS = new Set([
  'CLEANUP_UNCERTAIN', 'PROCESS_CLEANUP_FAILED', 'COMMAND_CLEANUP_UNCERTAIN',
  'COMMAND_EFFECTS_LOCK_FAILED', 'PATCH_CHECKPOINT_FAILED', 'PATCH_CLEANUP_UNCERTAIN',
]);

export function uncertain(value: unknown): boolean {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string' && UNSAFE_EFFECT_ERRORS.has(record.code)) return true;
    if (record.cleanupConfirmed === false || record.cleanupUncertain === true || record.effectsUncertain === true || record.executionBlocked === true) return true;
    pending.push(record.data, record.details);
  }
  return false;
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new EngineError('RUN_CANCELLED', 'Run was cancelled');
}
