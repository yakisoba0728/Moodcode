import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { boundedJson, JsonBudgetError, textPrefix } from '../artifacts/validation.js';
import { jobJson, jobObject } from '../jobs/validation.js';
import { immutableKnowledgeJson } from '../knowledge/validation.js';
import { canonicalSha256 } from './canonical.js';
import { assertNativeSignal, deepFreeze, exactKeys, parseJsonOr, plainJson, plainRecord, recordGuards, utf8Prefix } from './data.js';

const hasCode = (code: string, message?: string) => (error: unknown) => error instanceof EngineError && error.code === code && (message === undefined || error.message === message);
const reported = (fault: string) => (error: unknown) => error instanceof Error && error.message === fault;
const fault = (name: string): never => { throw new Error(name); };

function hostile() {
  let traps = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { traps++; return 1; } });
  const indexed = Object.defineProperty([1], '0', { enumerable: true, get() { traps++; return 1; } });
  const proxy = new Proxy({ value: 1 }, { getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target); } });
  return { getter, indexed, proxy, sparse: [1, , 3], traps: () => traps };
}

test('knowledge and job wrappers keep their codes for accessor, proxy and sparse-array inputs without running traps', () => {
  const inputs = hostile();
  for (const value of [inputs.getter, { nested: inputs.getter }, inputs.indexed, inputs.proxy, [inputs.proxy]]) {
    assert.throws(() => immutableKnowledgeJson(value), hasCode('INVALID_KNOWLEDGE'));
    assert.throws(() => jobJson(value), hasCode('INVALID_JOB'));
  }
  assert.throws(() => immutableKnowledgeJson(inputs.sparse), hasCode('KNOWLEDGE_LIMIT', 'Knowledge arrays must be dense and bounded'));
  assert.throws(() => jobJson(inputs.sparse), hasCode('INVALID_JOB', 'Job arrays must be dense with no extra fields'));
  assert.throws(() => jobJson(Object.defineProperty([1], '0', { value: 1, enumerable: false })), hasCode('INVALID_JOB', 'Job arrays must contain ordinary dense data'));
  assert.equal(inputs.traps(), 0);
  assert.throws(() => immutableKnowledgeJson(JSON.parse('{"__proto__":1}')), hasCode('INVALID_KNOWLEDGE', 'Knowledge object properties must be ordinary data'));
  assert.throws(() => jobJson({ toJSON: 1 }), hasCode('INVALID_JOB', 'Job properties must be ordinary enumerable data'));
  assert.throws(() => immutableKnowledgeJson(Array.from({ length: 257 }, () => 1)), hasCode('KNOWLEDGE_LIMIT'));
  assert.throws(() => immutableKnowledgeJson({ text: '\ud800' }), hasCode('KNOWLEDGE_LIMIT', 'Knowledge text must be bounded valid UTF-8'));
  assert.throws(() => jobJson({ text: '\ud800' }), hasCode('INVALID_JOB', 'Job text must contain valid Unicode'));
});

test('knowledge and job copies are frozen with their own prototypes and job DATA charges its exact JSON length', () => {
  const value = { text: 'é "x"', list: [1.5, null, true, false, { nested: -0 }], empty: {} };
  const knowledge = immutableKnowledgeJson(value), job = jobJson(value);
  assert.deepEqual(JSON.parse(JSON.stringify(knowledge)), JSON.parse(JSON.stringify(value)));
  assert.equal(JSON.stringify(job), JSON.stringify(value));
  assert.ok(Object.isFrozen(knowledge) && Object.isFrozen(knowledge.list) && Object.isFrozen(knowledge.list[4]));
  assert.equal(Object.getPrototypeOf(knowledge), Object.prototype);
  assert.equal(Object.getPrototypeOf(job), null); assert.ok(Object.isFrozen(job.list));
  const bytes = Buffer.byteLength(JSON.stringify(value));
  assert.equal(JSON.stringify(jobJson(value, bytes)), JSON.stringify(value));
  assert.throws(() => jobJson(value, bytes - 1), hasCode('JOB_LIMIT', 'Job DATA exceeds its encoded byte bound'));
  assert.throws(() => jobJson(value, 0), hasCode('JOB_LIMIT', 'Job DATA byte limit is invalid'));
  assert.deepEqual(Object.keys(jobObject({ a: 1, b: 2 }, ['a'], ['b'])), ['a', 'b']);
  assert.throws(() => jobObject({ b: 2 }, ['a'], ['b']), hasCode('INVALID_JOB', 'Job object fields do not match the contract'));
});

test('artifact JSON stays lenient for proxies and hidden fields, rejects getters and holes, and signals its budget', () => {
  const inputs = hostile();
  assert.deepEqual(boundedJson(inputs.proxy, 100), { value: 1 });
  assert.equal(inputs.traps(), 2);
  const hidden = Object.defineProperty({ shown: 1, [Symbol('s')]: 2 }, 'hidden', { value: 3 });
  const extra = Object.assign([1, 2], { extra: true });
  assert.deepEqual(boundedJson(hidden, 100), { shown: 1 }); assert.deepEqual(boundedJson(extra, 100), [1, 2]);
  assert.throws(() => boundedJson(inputs.getter, 100), hasCode('INVALID_ARTIFACT_DATA', 'JSON objects cannot contain accessors'));
  assert.throws(() => boundedJson(inputs.indexed, 100), hasCode('INVALID_ARTIFACT_DATA', 'JSON arrays must be dense data values'));
  assert.throws(() => boundedJson(inputs.sparse, 100), hasCode('INVALID_ARTIFACT_DATA', 'JSON arrays must be dense data values'));
  assert.throws(() => boundedJson({ value: NaN }, 100), hasCode('INVALID_ARTIFACT_DATA', 'JSON result contains a nonfinite number'));
  const copy = boundedJson(JSON.parse('{"__proto__":{"a":1},"b":[true]}'), 100) as Record<string, unknown>;
  assert.ok(Object.hasOwn(copy, '__proto__') && !Object.isFrozen(copy)); assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  const value = { key: 'value', list: [1, 'two', null] }, bytes = Buffer.byteLength(JSON.stringify(value));
  assert.deepEqual(boundedJson(value, bytes), value);
  assert.throws(() => boundedJson(value, bytes - 1), JsonBudgetError);
  assert.throws(() => boundedJson('x'.repeat(1_000), 10), JsonBudgetError);
});

test('the walker reports text and NUL faults, cycles and structural bounds to its caller', () => {
  const options = { maxBytes: 64, maxNodes: 4, maxDepth: 2, maxItems: 2, accounting: 'text', wellFormed: true, rejectNul: true, fail: fault } as const;
  const run = (value: unknown, extra: object = {}) => plainJson(value, { ...options, ...extra });
  assert.deepEqual(run({ a: 'b' }), { a: 'b' });
  assert.ok(Object.is(run(-0), -0)); assert.ok(Object.is((run([-0], { positiveZero: true }) as number[])[0], 0));
  assert.throws(() => run('a\0b'), reported('text'));
  assert.throws(() => run([1, 2, 3]), reported('items'));
  assert.throws(() => run({ a: { b: { c: 1 } } }), reported('structure'));
  assert.deepEqual(run({ a: { b: { c: 1 } } }, { containerDepth: true }), { a: { b: { c: 1 } } });
  assert.throws(() => run({ a: { b: { c: {} } } }, { containerDepth: true }), reported('structure'));
  assert.throws(() => run('x'.repeat(65)), reported('bytes'));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => run(cycle, { maxDepth: 8 }), reported('cycle'));
  assert.throws(() => run(new Date()), reported('prototype'));
  assert.throws(() => run({ [Symbol('s')]: 1 }), reported('symbol'));
  assert.throws(() => run(10n), reported('value'));
});

test('plain-record tiers separate hostile host input from parsed data', () => {
  const fields = (value: unknown, optional: readonly string[] = []) => plainRecord(value, ['id'], optional, fault);
  assert.deepEqual(fields({ id: 1 }), { id: 1 }); assert.deepEqual(fields({ id: 1, note: 'x' }, ['note']), { id: 1, note: 'x' });
  for (const value of [null, [], new Proxy({ id: 1 }, {}), new Date()]) assert.throws(() => fields(value), reported('shape'));
  for (const value of [{}, { id: 1, extra: 2 }, { id: 1, [Symbol('s')]: 2 }]) assert.throws(() => fields(value), reported('fields'));
  assert.throws(() => fields(Object.defineProperty({}, 'id', { enumerable: true, get: () => 1 })), reported('descriptor'));
  assert.throws(() => fields(Object.defineProperty({}, 'id', { value: 1 })), reported('descriptor'));
  assert.ok(exactKeys({ a: 1, b: 2 }, ['a'], ['b'])); assert.ok(exactKeys({ a: 1 }, ['a'], ['b']));
  assert.ok(!exactKeys({ b: 2 }, ['a'], ['b'])); assert.ok(!exactKeys({ a: 1, c: 3 }, ['a']));
});

test('record guards bind one module code set and seal through the module walker', () => {
  const guards = recordGuards({ idBytes: 4, json: <T>(value: T): T => Object.freeze(value), fail: fault });
  assert.equal(guards.id('abcd'), 'abcd');
  for (const value of ['', 'abcde', 'a\u0000', 1]) assert.throws(() => guards.id(value), reported('id'));
  assert.equal(guards.integer(5, 5, 5), 5);
  for (const [value, maximum, minimum] of [[6, 5, 0], [4, 5, 5], [1.5, 5, 0], [-1, 5, 0]] as const) assert.throws(() => guards.integer(value, maximum, minimum), reported('integer'));
  assert.throws(() => guards.sha('A'.repeat(64)), reported('sha'));
  assert.equal(guards.stamp('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
  for (const value of ['2026-01-01T00:00:00Z', '+002026-01-01T00:00:00.000Z', 'not a date at all here!!']) assert.throws(() => guards.stamp(value), reported('stamp'));
  assert.deepEqual(guards.exact({ a: 1 }, ['a']), { a: 1 }); assert.throws(() => guards.exact([], []), reported('exact'));
  const sealed = guards.seal({ id: 'x', sha256: 'stale' });
  assert.equal(sealed.sha256, canonicalSha256({ id: 'x' })); assert.ok(Object.isFrozen(sealed));
  assert.equal(guards.verify(sealed), sealed);
  assert.throws(() => guards.verify({ ...sealed, id: 'y' }), reported('hash'));
  assert.throws(() => guards.verify({ id: 'x', sha256: 'stale' }), reported('sha'));
});

test('native signals must be unmodified AbortSignal instances', () => {
  const controller = new AbortController();
  assertNativeSignal(controller.signal, fault);
  assertNativeSignal(AbortSignal.abort(), fault);
  for (const value of [null, {}, new Proxy(controller.signal, {}), Object.create(AbortSignal.prototype)]) assert.throws(() => assertNativeSignal(value, fault), reported('shape'));
  for (const key of ['aborted', 'reason', 'throwIfAborted', 'addEventListener', 'removeEventListener']) {
    const signal = new AbortController().signal;
    Object.defineProperty(signal, key, { value: false });
    assert.throws(() => assertNativeSignal(signal, fault), reported('override'));
  }
  const accessor = Object.defineProperty(new AbortController().signal, 'custom', { get: () => 1 });
  assert.throws(() => assertNativeSignal(accessor, fault), reported('override'));
});

test('UTF-8 prefixes keep whole scalars and replace unpaired surrogates', () => {
  assert.equal(textPrefix, utf8Prefix);
  assert.equal(utf8Prefix('aé日😀', 0), ''); assert.equal(utf8Prefix('aé日😀', 2), 'a'); assert.equal(utf8Prefix('aé日😀', 3), 'aé');
  assert.equal(utf8Prefix('aé日😀', 5), 'aé'); assert.equal(utf8Prefix('aé日😀', 6), 'aé日'); assert.equal(utf8Prefix('aé日😀', 10), 'aé日😀');
  assert.equal(utf8Prefix('a\ud800b', 4), 'a�'); assert.equal(utf8Prefix('a\ud800b', 5), 'a�b');
});

test('deepFreeze freezes every nested container and parseJsonOr maps malformed text to the caller failure', () => {
  const value = deepFreeze({ list: [{ leaf: 1 }], nested: { empty: {} } });
  for (const part of [value, value.list, value.list[0], value.nested, value.nested.empty]) assert.ok(Object.isFrozen(part));
  assert.equal(deepFreeze('text'), 'text');
  assert.deepEqual(parseJsonOr('{"a":[1]}', () => fault('json')), { a: [1] });
  assert.throws(() => parseJsonOr('{"a":', () => fault('json')), reported('json'));
});
