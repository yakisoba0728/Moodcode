import { EngineError } from '@moodcode/contracts';
import type { LifecycleHookRegistry, LifecycleCapturedHook } from './registry.js';
import { freezeLifecycle, lifecycleInvocation, lifecycleResult } from './validation.js';
import type { LifecycleCapture, LifecycleDispatchOutcome, LifecycleHookOutcome, LifecycleHookResult, LifecycleInvocation } from './types.js';

type CallbackSettlement = { kind: 'result'; result: LifecycleHookResult | void } | { kind: 'error' } | { kind: 'timeout' } | { kind: 'cancel' };
async function invoke(hook: LifecycleCapturedHook, invocation: LifecycleInvocation, signal: AbortSignal, timeoutMs: number): Promise<CallbackSettlement> {
  if (signal.aborted) return { kind: 'cancel' };
  const started = performance.now();
  const deadline = new AbortController(), combined = AbortSignal.any([signal, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined, detach = () => {};
  const interruption = new Promise<CallbackSettlement>(resolve => {
    const abort = () => resolve({ kind: 'cancel' });
    signal.addEventListener('abort', abort, { once: true }); detach = () => signal.removeEventListener('abort', abort);
    timer = setTimeout(() => { deadline.abort(new EngineError('LIFECYCLE_HOOK_TIMEOUT', 'Lifecycle callback deadline elapsed')); resolve({ kind: 'timeout' }); }, timeoutMs);
    if (signal.aborted) abort();
  });
  // Both handlers remain attached after the race. A late rejection never escapes
  // as an unhandled rejection, and a late result is never published or cached.
  const callback: Promise<CallbackSettlement> = Promise.resolve().then(async (): Promise<CallbackSettlement> => {
    if (combined.aborted) return { kind: 'cancel' } as const;
    return Promise.resolve(hook.callback(invocation, combined)).then(result => ({ kind: 'result', result }) as const, () => ({ kind: 'error' }) as const);
  }).catch(() => ({ kind: 'error' }) as const);
  try {
    const result = await Promise.race([callback, interruption]);
    // JavaScript cannot preempt a synchronous host callback. Its result still
    // loses authority when it blocked the event loop past its deadline.
    if ((result.kind === 'result' || result.kind === 'error') && performance.now() - started >= timeoutMs) {
      deadline.abort(new EngineError('LIFECYCLE_HOOK_TIMEOUT', 'Lifecycle callback deadline elapsed'));
      return { kind: 'timeout' };
    }
    return result;
  }
  finally { clearTimeout(timer); detach(); }
}

export function dispatchLifecycleHooks(registry: LifecycleHookRegistry, capture: LifecycleCapture, input: LifecycleInvocation, signal: AbortSignal): Promise<LifecycleDispatchOutcome> {
  registry.assertCurrent(capture);
  const invocation = lifecycleInvocation(input, registry.limits.maxMetadataBytes);
  if (['workspaceId', 'sessionId', 'runId'].some(key => invocation.identity[key as keyof typeof invocation.identity] !== capture.identity[key as keyof typeof capture.identity])) throw new EngineError('LIFECYCLE_IDENTITY_MISMATCH', 'Lifecycle invocation does not belong to the captured Run');
  const state = registry.captureState(capture), canonical = JSON.stringify(invocation), previous = state.invocations.get(invocation.invocationId);
  if (previous) {
    if (previous.canonical !== canonical) throw new EngineError('LIFECYCLE_INVOCATION_CONFLICT', 'Lifecycle invocation id was reused with changed metadata');
    return previous.promise;
  }
  if (state.invocations.size >= registry.limits.maxInvocationsPerCapture) throw new EngineError('LIFECYCLE_INVOCATION_LIMIT', 'Lifecycle Run capture reached its bounded invocation limit');
  const task = dispatch(registry, capture, invocation, AbortSignal.any([signal, state.abort.signal]));
  state.invocations.set(invocation.invocationId, { canonical, promise: task });
  return task;
}

async function dispatch(registry: LifecycleHookRegistry, capture: LifecycleCapture, invocation: LifecycleInvocation, signal: AbortSignal): Promise<LifecycleDispatchOutcome> {
  const started = performance.now(), outcomes: LifecycleHookOutcome[] = [];
  const finish = (action: LifecycleDispatchOutcome['action'], status: LifecycleDispatchOutcome['status'], code?: string, reason?: string): LifecycleDispatchOutcome => freezeLifecycle({ invocationId: invocation.invocationId, registryRevision: capture.registryRevision, stage: invocation.stage, status, action, ...(code ? { code } : {}), ...(reason ? { reason } : {}), outcomes });
  for (const hook of registry.captureState(capture).hooks.filter(item => item.descriptor.stages.includes(invocation.stage))) {
    if (signal.aborted) return finish('stop', 'cancelled', 'LIFECYCLE_CANCELLED', 'Lifecycle dispatch was cancelled');
    try { registry.assertCurrent(capture); }
    catch { return finish('stop', 'stale', 'LIFECYCLE_REGISTRY_STALE', 'Lifecycle capture changed before callback dispatch'); }
    const descriptor = hook.descriptor, callbackStarted = performance.now(), remaining = registry.limits.maxDispatchMs - (callbackStarted - started);
    let settled: CallbackSettlement = remaining <= 0 ? { kind: 'timeout' } : await invoke(hook, invocation, signal, Math.min(descriptor.timeoutMs, remaining));
    const base = { hookId: descriptor.id, hookRevision: descriptor.revision, stage: invocation.stage, elapsedMs: Math.max(0, Math.round(performance.now() - callbackStarted)) };
    if (signal.aborted || settled.kind === 'cancel') {
      outcomes.push({ ...base, status: 'cancelled', action: 'stop', code: 'LIFECYCLE_CANCELLED' });
      return finish('stop', 'cancelled', 'LIFECYCLE_CANCELLED', 'Lifecycle callback was cancelled');
    }
    try { registry.assertCurrent(capture); }
    catch {
      outcomes.push({ ...base, status: 'stale', action: 'stop', code: 'LIFECYCLE_REGISTRY_STALE' });
      return finish('stop', 'stale', 'LIFECYCLE_REGISTRY_STALE', 'Lifecycle registry changed while the callback was running');
    }
    let result: LifecycleHookResult | undefined, errorCode: string | undefined;
    if (settled.kind === 'result') {
      try { result = lifecycleResult(settled.result, invocation.stage, registry.limits.maxResultBytes); }
      catch (error) { settled = { kind: 'error' }; errorCode = error instanceof EngineError ? error.code : 'INVALID_LIFECYCLE_RESULT'; }
    }
    if (result) {
      const action = result.kind;
      outcomes.push({ ...base, status: action === 'observe' ? 'observed' : action === 'deny' ? 'denied' : 'stop-requested', action, ...('code' in result ? { code: result.code, reason: result.reason } : {}), ...(result.metadata ? { metadata: result.metadata } : {}) });
      if (action !== 'observe') return finish(action, 'completed', 'code' in result ? result.code : undefined, 'reason' in result ? result.reason : undefined);
    } else {
      const code = errorCode ?? (settled.kind === 'timeout' ? 'LIFECYCLE_HOOK_TIMEOUT' : 'LIFECYCLE_HOOK_FAILED'), action = descriptor.failurePolicy;
      // Do not publish arbitrary callback exception text: it can contain request
      // data or host secrets. The stable typed failure code is sufficient here.
      outcomes.push({ ...base, status: settled.kind === 'timeout' ? 'timed-out' : 'failed', action, code });
      if (action !== 'observe') return finish(action, 'completed', code, 'Lifecycle callback failed under its configured failure policy');
    }
  }
  if (signal.aborted) return finish('stop', 'cancelled', 'LIFECYCLE_CANCELLED', 'Lifecycle dispatch was cancelled');
  try { registry.assertCurrent(capture); }
  catch { return finish('stop', 'stale', 'LIFECYCLE_REGISTRY_STALE', 'Lifecycle capture changed before result acceptance'); }
  return finish('observe', 'completed');
}
