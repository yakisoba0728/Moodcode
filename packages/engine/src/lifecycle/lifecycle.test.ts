import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import { EngineError } from '@moodcode/contracts';
import { LifecycleHookRegistry, dispatchLifecycleHooks, type LifecycleCapture, type LifecycleHookRegistration, type LifecycleHookResult, type LifecycleInvocation } from './index.js';

const identity = { workspaceId: 'workspace', sessionId: 'session', runId: 'run' };
const signal = () => new AbortController().signal;
const invocation = (id = 'invoke'): LifecycleInvocation<'before-model'> => ({ invocationId: id, stage: 'before-model', identity: { ...identity }, metadata: { providerId: 'provider', modelId: 'model', turnIndex: 0, contextBytes: 1_024, toolCount: 3, requestSha256: 'a'.repeat(64) } });
const hook = (id: string, callback: LifecycleHookRegistration['callback'], extra: Partial<LifecycleHookRegistration> = {}): LifecycleHookRegistration => ({ id, revision: 1, stages: ['before-model'], callback, ...extra });
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('host hook registration validates IDs, revisions, stages, deadlines, failure policies and accessors', () => {
  const registry = new LifecycleHookRegistry();
  for (const invalid of [hook('bad id', () => {}), hook('invalid', () => {}, { revision: 0 }), hook('invalid', () => {}, { stages: [] }), hook('invalid', () => {}, { stages: ['before-model', 'before-model'] }), hook('invalid', () => {}, { stages: ['after-model'], failurePolicy: 'deny' }), hook('invalid', () => {}, { timeoutMs: 1_001 }), hook('invalid', () => {}, { order: NaN }), hook('invalid', () => {}, { stages: ['wrong'] as never }), hook('invalid', () => {}, { callback: null as never }), hook('invalid', () => {}, { failurePolicy: 'allow' as never })]) assert.throws(() => registry.register(invalid), code('INVALID_LIFECYCLE_HOOK'));
  let reads = 0;
  const withGetter = Object.defineProperty(hook('getter', () => {}), 'order', { get() { reads++; return 0; }, enumerable: true });
  assert.throws(() => registry.register(withGetter), code('INVALID_LIFECYCLE_HOOK')); assert.equal(reads, 0);
  const stages = Object.defineProperty(['before-model'], '0', { get() { reads++; return 'before-model'; }, enumerable: true });
  assert.throws(() => registry.register(hook('stageGetter', () => {}, { stages: stages as never })), code('INVALID_LIFECYCLE_HOOK')); assert.equal(reads, 0);
});

test('registrations are detached, ordered and revision-bound; disposal cannot remove a later generation', async () => {
  const registry = new LifecycleHookRegistry(), seen: string[] = [];
  const source = hook('first', () => { seen.push('first'); });
  const dispose = registry.register(source);
  source.stages = ['after-model']; source.callback = () => { throw new Error('changed callback'); }; source.order = -1_000;
  registry.register(hook('earlier', () => { seen.push('earlier'); }, { order: -1 }));
  registry.register(hook('sameOrder', () => { seen.push('sameOrder'); }));
  const capture = registry.capture(identity);
  assert.equal(Object.isFrozen(capture), true); assert.equal(Object.isFrozen(capture.hooks[0]!.stages), true);
  assert.deepEqual(capture.hooks.map(item => item.id), ['earlier', 'first', 'sameOrder']);
  assert.equal((await registry.dispatch(capture, invocation(), signal())).action, 'observe');
  assert.deepEqual(seen, ['earlier', 'first', 'sameOrder']);
  assert.throws(() => registry.register(hook('first', () => {})), code('LIFECYCLE_HOOK_DUPLICATE'));
  dispose(); assert.throws(() => registry.register(hook('first', () => {})), code('LIFECYCLE_HOOK_REVISION'));
  registry.register(hook('first', () => {}, { revision: 2 })); dispose();
  assert.equal(registry.list().find(item => item.id === 'first')!.revision, 2);
});

test('active registry, revision identity and invocation caches have independent limits', async () => {
  assert.throws(() => new LifecycleHookRegistry({ maxHooks: 3, maxHookIdentities: 2 }), code('INVALID_LIFECYCLE_LIMIT'));
  assert.throws(() => new LifecycleHookRegistry({ maxDispatchMs: 0 }), code('INVALID_LIFECYCLE_LIMIT'));
  assert.throws(() => new LifecycleHookRegistry({ unknown: 1 } as never), code('INVALID_LIFECYCLE_LIMIT'));
  const registry = new LifecycleHookRegistry({ maxHooks: 1, maxHookIdentities: 2, maxInvocationsPerCapture: 1 });
  const remove = registry.register(hook('first', () => {}));
  assert.throws(() => registry.register(hook('second', () => {})), code('LIFECYCLE_HOOK_LIMIT'));
  remove(); const removeSecond = registry.register(hook('second', () => {})); removeSecond();
  assert.throws(() => registry.register(hook('third', () => {})), code('LIFECYCLE_HOOK_IDENTITY_LIMIT'));
  const capture = registry.capture(identity); await registry.dispatch(capture, invocation(), signal());
  assert.throws(() => registry.dispatch(capture, invocation('second'), signal()), code('LIFECYCLE_INVOCATION_LIMIT'));
});

test('Run captures bound invocations by their own turn and tool limits within the hard maximum', async () => {
  const admitted = async (registry: LifecycleHookRegistry, capture: LifecycleCapture) => {
    let count = 0;
    for (;; count++) {
      try { await registry.dispatch(capture, invocation(`invoke-${count}`), signal()); }
      catch (error) { assert.equal(code('LIFECYCLE_INVOCATION_LIMIT')(error), true); return count; }
    }
  };
  const registry = new LifecycleHookRegistry(); registry.register(hook('observer', () => {}));
  assert.equal(await admitted(registry, registry.capture(identity)), 1_024);
  assert.equal(await admitted(registry, registry.capture(identity, { maxTurns: 128, maxToolCalls: 1_024 })), 35 * 128 + 3 * 1_024 + 3);
  assert.equal(await admitted(registry, registry.capture(identity, { maxTurns: 1, maxToolCalls: 1 })), 1_024);
  assert.equal(await admitted(registry, registry.capture(identity, { maxTurns: Number.MAX_SAFE_INTEGER, maxToolCalls: Number.MAX_SAFE_INTEGER })), 8_192);
  const small = new LifecycleHookRegistry({ maxInvocationsPerCapture: 8 });
  assert.equal(await admitted(small, small.capture(identity, { maxTurns: 0, maxToolCalls: 0 })), 8);
  assert.equal(await admitted(small, small.capture(identity, { maxTurns: 1, maxToolCalls: 2 })), 35 + 6 + 3);
  for (const limits of [{ maxTurns: -1, maxToolCalls: 1 }, { maxTurns: 1.5, maxToolCalls: 1 }, { maxTurns: 1, maxToolCalls: NaN }, { maxTurns: 1 }, null])
    assert.throws(() => registry.capture(identity, limits as never), code('INVALID_LIFECYCLE_LIMIT'));
});

test('forged captures, cross-registry handles, other Run identities and stale captures are rejected before callbacks', () => {
  let called = 0;
  const registry = new LifecycleHookRegistry(); registry.register(hook('observer', () => { called++; }));
  const capture = registry.capture(identity);
  assert.throws(() => registry.dispatch(structuredClone(capture), invocation(), signal()), code('INVALID_LIFECYCLE_CAPTURE'));
  assert.throws(() => new LifecycleHookRegistry().dispatch(capture, invocation(), signal()), code('INVALID_LIFECYCLE_CAPTURE'));
  assert.throws(() => registry.dispatch(capture, { ...invocation(), identity: { ...identity, runId: 'another' } }, signal()), code('LIFECYCLE_IDENTITY_MISMATCH'));
  registry.register(hook('later', () => {}));
  assert.throws(() => registry.dispatch(capture, invocation(), signal()), code('LIFECYCLE_REGISTRY_STALE')); assert.equal(called, 0);
});

test('only scalar stage metadata reaches hooks; secrets, replay, raw requests, sparse data and getters are rejected', () => {
  const registry = new LifecycleHookRegistry(); const capture = registry.capture(identity);
  for (const field of ['credentials', 'messages', 'input', 'providerReplay', 'constructor', '__proto__']) {
    const event = invocation(); Object.defineProperty(event.metadata, field, { value: 'secret', enumerable: true });
    assert.throws(() => registry.dispatch(capture, event, signal()), code('INVALID_LIFECYCLE_METADATA'));
  }
  let read = 0;
  const event = invocation(); Object.defineProperty(event.metadata, 'providerId', { get() { read++; return 'secret'; }, enumerable: true });
  assert.throws(() => registry.dispatch(capture, event, signal()), code('INVALID_LIFECYCLE_METADATA')); assert.equal(read, 0);
  assert.throws(() => registry.capture({ ...identity, token: 'secret' } as never), code('INVALID_LIFECYCLE_IDENTITY'));
  assert.throws(() => registry.dispatch(capture, { ...invocation(), metadata: { ...invocation().metadata, requestSha256: 'not sha' } }, signal()), code('INVALID_LIFECYCLE_METADATA'));
});

test('hook invocation and result data are recursively frozen detached copies', async () => {
  const registry = new LifecycleHookRegistry(), external = { nested: { values: [1, 2] } };
  let received: LifecycleInvocation | undefined;
  registry.register(hook('immutable', data => {
    received = data;
    assert.throws(() => { (data.identity as { runId: string }).runId = 'changed'; }, TypeError);
    assert.throws(() => { (data.metadata as { providerId: string }).providerId = 'changed'; }, TypeError);
    return { kind: 'observe', metadata: external };
  }));
  const event = invocation(), output = await registry.dispatch(registry.capture(identity), event, signal());
  assert.notEqual(received, event); assert.equal(event.identity.runId, 'run');
  external.nested.values.push(3);
  assert.deepEqual(output.outcomes[0]!.metadata, { nested: { values: [1, 2] } });
  assert.equal(Object.isFrozen(output.outcomes[0]!.metadata!.nested), true);
  assert.throws(() => { (output.outcomes as unknown[]).push('mutation'); }, TypeError);
});

test('duplicate invocation reuses in-flight and accepted outcome without repeating callback; changed metadata conflicts', async () => {
  const wait = deferred<LifecycleHookResult>(), registry = new LifecycleHookRegistry(); let called = 0;
  registry.register(hook('once', () => { called++; return wait.promise; }));
  const capture = registry.capture(identity), first = registry.dispatch(capture, invocation(), signal()), duplicate = registry.dispatch(capture, invocation(), signal());
  assert.equal(first, duplicate);
  assert.throws(() => registry.dispatch(capture, { ...invocation(), metadata: { ...invocation().metadata, toolCount: 4 } }, signal()), code('LIFECYCLE_INVOCATION_CONFLICT'));
  await tick(); assert.equal(called, 1); wait.resolve({ kind: 'observe' });
  const output = await first; assert.equal(await registry.dispatch(capture, invocation(), signal()), output); assert.equal(called, 1);
});

test('deny and stop are typed decisions and short-circuit later hooks without taking engine actions', async () => {
  for (const action of ['deny', 'stop'] as const) {
    const registry = new LifecycleHookRegistry(), later: string[] = [];
    registry.register(hook('control', () => ({ kind: action, code: 'HOST_POLICY', reason: 'Host policy requests this decision' })));
    registry.register(hook('later', () => { later.push('called'); }));
    const result = await dispatchLifecycleHooks(registry, registry.capture(identity), invocation(), signal());
    assert.equal(result.action, action); assert.equal(result.code, 'HOST_POLICY'); assert.equal(result.outcomes.length, 1); assert.deepEqual(later, []);
  }
});

test('throw and rejection follow failure policy without publishing error text', async () => {
  for (const policy of ['observe', 'deny', 'stop'] as const) {
    const registry = new LifecycleHookRegistry(); let later = false;
    registry.register(hook('failure', () => { throw new Error('secret bearer token'); }, { failurePolicy: policy }));
    registry.register(hook('next', () => { later = true; }));
    const output = await registry.dispatch(registry.capture(identity), invocation(), signal());
    assert.equal(output.action, policy); assert.equal(output.outcomes[0]!.status, 'failed'); assert.equal(output.outcomes[0]!.code, 'LIFECYCLE_HOOK_FAILED');
    assert.equal(JSON.stringify(output).includes('secret bearer token'), false); assert.equal(later, policy === 'observe');
  }
  const registry = new LifecycleHookRegistry(); registry.register(hook('reject', () => Promise.reject(new Error('secret'))));
  assert.equal((await registry.dispatch(registry.capture(identity), invocation(), signal())).outcomes[0]!.status, 'failed');
});

test('a deadline aborts the callback signal, records timeout and rejects late control results', async () => {
  const wait = deferred<LifecycleHookResult>(), registry = new LifecycleHookRegistry(); let callbackSignal: AbortSignal | undefined;
  registry.register(hook('slow', (_input, supplied) => { callbackSignal = supplied; return wait.promise; }, { timeoutMs: 15, failurePolicy: 'observe' }));
  const capture = registry.capture(identity), output = await registry.dispatch(capture, invocation(), signal());
  assert.equal(output.action, 'observe'); assert.equal(output.outcomes[0]!.status, 'timed-out'); assert.equal(callbackSignal!.aborted, true);
  wait.resolve({ kind: 'deny', code: 'LATE', reason: 'Late result must not become an approval gate' }); await tick();
  assert.equal(await registry.dispatch(capture, invocation(), signal()), output); assert.equal(JSON.stringify(output).includes('LATE'), false);
});

test('late callback rejection after deadline is consumed', async () => {
  const wait = deferred<LifecycleHookResult>(), registry = new LifecycleHookRegistry();
  registry.register(hook('slow', () => wait.promise, { timeoutMs: 10 }));
  assert.equal((await registry.dispatch(registry.capture(identity), invocation(), signal())).action, 'stop');
  wait.reject(new Error('late failure')); await tick(); await tick();
});

test('synchronous callbacks that block beyond the deadline cannot publish a control result', async () => {
  const registry = new LifecycleHookRegistry(); let suppliedSignal: AbortSignal | undefined;
  registry.register(hook('blocking', (_input, supplied) => {
    suppliedSignal = supplied;
    const until = performance.now() + 20;
    while (performance.now() < until) { /* Trusted host callback simulates synchronous work. */ }
    return { kind: 'deny', code: 'LATE', reason: 'Late synchronous result' };
  }, { timeoutMs: 5, failurePolicy: 'observe' }));
  const output = await registry.dispatch(registry.capture(identity), invocation(), signal());
  assert.equal(output.action, 'observe'); assert.equal(output.outcomes[0]!.status, 'timed-out'); assert.equal(suppliedSignal!.aborted, true);
});

test('dispatch deadline bounds sequential observers rather than giving every hook a fresh total budget', async () => {
  const registry = new LifecycleHookRegistry({ maxDispatchMs: 30 }); let later = false;
  registry.register(hook('first', async () => { await sleep(20); }, { failurePolicy: 'observe' }));
  registry.register(hook('second', () => new Promise(() => {}), { failurePolicy: 'stop' }));
  registry.register(hook('third', () => { later = true; }));
  const started = performance.now(), output = await registry.dispatch(registry.capture(identity), invocation(), signal());
  assert.equal(output.action, 'stop'); assert.equal(output.outcomes.at(-1)!.status, 'timed-out'); assert.equal(later, false);
  assert.ok(performance.now() - started < 300);
});

test('pre-dispatch cancellation invokes no callbacks; callback cancellation rejects late results and later hooks', async () => {
  const registry = new LifecycleHookRegistry(), cancelled = new AbortController(); let called = 0;
  registry.register(hook('observer', () => { called++; })); cancelled.abort();
  const output = await registry.dispatch(registry.capture(identity), invocation(), cancelled.signal);
  assert.equal(output.status, 'cancelled'); assert.equal(output.action, 'stop'); assert.equal(called, 0);
  const wait = deferred<LifecycleHookResult>(), active = new LifecycleHookRegistry(), abort = new AbortController(); let seenSignal: AbortSignal | undefined, later = false;
  active.register(hook('pending', (_input, supplied) => { seenSignal = supplied; return wait.promise; })); active.register(hook('later', () => { later = true; }));
  const task = active.dispatch(active.capture(identity), invocation(), abort.signal); await tick(); abort.abort(new Error('cancelled'));
  const result = await task; assert.equal(result.status, 'cancelled'); assert.equal(result.outcomes[0]!.status, 'cancelled'); assert.equal(seenSignal!.aborted, true); assert.equal(later, false);
  wait.resolve({ kind: 'deny', code: 'LATE', reason: 'Late decision' }); await tick(); assert.equal(result.code, 'LIFECYCLE_CANCELLED');
});

test('registry changes during callback discard its result and stop subsequent hook dispatch', async () => {
  const wait = deferred<LifecycleHookResult>(), registry = new LifecycleHookRegistry(); let later = false;
  const remove = registry.register(hook('pending', () => wait.promise)); registry.register(hook('later', () => { later = true; }));
  const capture = registry.capture(identity), task = registry.dispatch(capture, invocation(), signal()); await tick(); remove();
  wait.resolve({ kind: 'observe', metadata: { shouldBeIgnored: true } });
  const output = await task; assert.equal(output.status, 'stale'); assert.equal(output.action, 'stop'); assert.equal(output.outcomes[0]!.status, 'stale'); assert.equal(later, false); assert.equal(JSON.stringify(output).includes('shouldBeIgnored'), false);
});

test('releasing a capture is idempotent and cancels acceptance of an active callback', async () => {
  const registry = new LifecycleHookRegistry(), wait = deferred<LifecycleHookResult>(); let callbackSignal: AbortSignal | undefined;
  registry.register(hook('pending', (_input, supplied) => { callbackSignal = supplied; return wait.promise; }));
  const capture = registry.capture(identity), task = registry.dispatch(capture, invocation(), signal()); await tick(); registry.release(capture); registry.release(capture);
  const output = await task; assert.equal(output.status, 'cancelled'); assert.equal(callbackSignal!.aborted, true);
  assert.throws(() => registry.dispatch(capture, invocation(), signal()), code('LIFECYCLE_CAPTURE_RELEASED'));
  wait.resolve({ kind: 'observe' }); await tick();
});

test('oversized metadata is rejected before callback and oversized result uses configured failure policy', async () => {
  const small = new LifecycleHookRegistry({ maxMetadataBytes: 32 }), capture = small.capture(identity);
  assert.throws(() => small.dispatch(capture, invocation(), signal()), code('LIFECYCLE_METADATA_LIMIT'));
  const registry = new LifecycleHookRegistry({ maxResultBytes: 128 }); registry.register(hook('large', () => ({ kind: 'observe', metadata: { text: 'x'.repeat(129) } }), { failurePolicy: 'deny' }));
  const output = await registry.dispatch(registry.capture(identity), invocation(), signal());
  assert.equal(output.action, 'deny'); assert.equal(output.outcomes[0]!.status, 'failed'); assert.equal(output.outcomes[0]!.code, 'LIFECYCLE_METADATA_LIMIT');
});

test('non-JSON, getters, excessive depth/member counts and sparse arrays cannot become hook outcomes', async () => {
  let getterReads = 0;
  const sparse: unknown[] = new Array(2);
  const accessor = Object.defineProperty({}, 'secret', { get() { getterReads++; return 'secret'; }, enumerable: true });
  const circular: Record<string, unknown> = {}; circular.self = circular;
  let deep: unknown = {}; for (let index = 0; index < 9; index++) deep = { next: deep };
  for (const metadata of [{ value: undefined }, { value: NaN }, { value: new Date() }, { value: sparse }, accessor, circular, { value: deep }, { value: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [String(index), 1])) }, { value: Symbol('value') }]) {
    const registry = new LifecycleHookRegistry(); registry.register(hook('invalid', () => ({ kind: 'observe', metadata: metadata as never })));
    const output = await registry.dispatch(registry.capture(identity), invocation(), signal()); assert.equal(output.action, 'stop'); assert.equal(output.outcomes[0]!.status, 'failed');
  }
  assert.equal(getterReads, 0);
});

test('proxy metadata and registration are rejected without invoking traps', async () => {
  let traps = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; } });
  const registry = new LifecycleHookRegistry();
  assert.throws(() => registry.register(proxy as LifecycleHookRegistration), code('INVALID_LIFECYCLE_HOOK'));
  registry.register(hook('proxyResult', () => ({ kind: 'observe', metadata: { nested: proxy } })));
  const output = await registry.dispatch(registry.capture(identity), invocation(), signal());
  assert.equal(output.outcomes[0]!.code, 'INVALID_LIFECYCLE_METADATA'); assert.equal(traps, 0);
});

test('effect-settled callbacks cannot deny or rewrite arguments after an effect', async () => {
  for (const result of [{ kind: 'deny', code: 'AFTER_EFFECT', reason: 'Cannot retroactively deny' }, { kind: 'context', content: 'new context' }, { kind: 'observe', input: { changed: true } }, { kind: 'stop', code: 'STOP', reason: '' }]) {
    const registry = new LifecycleHookRegistry(); registry.register(hook('invalid', () => result as LifecycleHookResult, { stages: ['tool-settled'] }));
    const event: LifecycleInvocation<'tool-settled'> = { invocationId: 'settled', identity, stage: 'tool-settled', metadata: { toolCallId: 'tool-call', toolName: 'write_file', outcome: 'completed', outputBytes: 20, cleanup: 'confirmed' } };
    const output = await registry.dispatch(registry.capture(identity), event, signal()); assert.equal(output.action, 'stop'); assert.equal(output.outcomes[0]!.status, 'failed'); assert.equal(output.outcomes[0]!.code, 'INVALID_LIFECYCLE_RESULT');
  }
});

test('all lifecycle stages select their registered callbacks and validate stage-specific summaries', async () => {
  const events: LifecycleInvocation[] = [invocation('model'), { invocationId: 'after', identity, stage: 'after-model', metadata: { providerId: 'provider', modelId: 'model', turnIndex: 0, finishReason: 'tool_calls', toolCallCount: 1, outputBytes: 42 } }, { invocationId: 'prepared', identity, stage: 'tool-prepared', metadata: { toolCallId: 'tool-call', toolName: 'run_command', fingerprint: 'bound-fingerprint', requiresApproval: true, effectClass: 'execute' } }, { invocationId: 'settled', identity, stage: 'tool-settled', metadata: { toolCallId: 'tool-call', toolName: 'run_command', outcome: 'completed', outputBytes: 40, cleanup: 'confirmed' } }, { invocationId: 'stop', identity, stage: 'before-stop', metadata: { outcome: 'completed', turnCount: 1, toolCallCount: 1, outputBytes: 100 } }];
  const registry = new LifecycleHookRegistry(), stages: string[] = [];
  registry.register(hook('all', event => { stages.push(event.stage); }, { stages: ['before-model', 'after-model', 'tool-prepared', 'tool-settled', 'before-stop'] }));
  const capture: LifecycleCapture = registry.capture(identity);
  for (const event of events) assert.equal((await registry.dispatch(capture, event, signal())).action, 'observe');
  assert.deepEqual(stages, events.map(event => event.stage));
});
