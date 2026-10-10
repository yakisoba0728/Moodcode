import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError, type JsonObject, type JsonValue } from '@moodcode/contracts';
import type { ProviderMessage } from '../ports.js';
import { validateReplayBinding, validateReplayItems, type ReplayValidationOptions } from './replay.js';

const SECRET = 'sk-replay-fixture-private';
const limits: ReplayValidationOptions = { maxItems: 16, maxBytes: 65_536, maxToolArgumentBytes: 8192, maxToolCalls: 8 };
function message(text = 'answer', extra: JsonObject = {}): JsonObject {
  return { id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }], ...extra };
}
function call(args = '{"path":"file.txt"}', extra: JsonObject = {}): JsonObject {
  return { id: 'fc-1', type: 'function_call', status: 'completed', call_id: 'call-1', name: 'read_file', arguments: args, ...extra };
}
function reasoning(extra: JsonObject = {}): JsonObject {
  return { id: 'rs-1', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'opaque summary' }], content: [{ type: 'reasoning_text', text: 'opaque reasoning' }], encrypted_content: 'ciphertext-preserved', ...extra };
}
function invalid(operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'PROVIDER_INVALID_REPLAY');
    assert.equal(error.message, 'Provider replay is invalid.');
    assert.equal(error.cause, undefined);
    assert.equal(error.details, undefined);
    assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /sk-replay-fixture-private/);
    return true;
  });
}
function nested(depth: number): JsonValue {
  let value: JsonValue = 'leaf';
  for (let index = 0; index < depth; index++) value = { next: value };
  return value;
}

test('native replay preserves order, phases, opaque reasoning and all JSON fields in isolated copies', () => {
  const source = [
    reasoning({ metadata: { future: ['preserved', null, true] } }),
    message('checking', { phase: 'commentary', future: { arbitrary: 1 } }),
    call(' { "path" : "file.txt" } '),
    message('final', { id: 'msg-2', phase: 'final_answer' }),
    message('', { id: 'msg-3', phase: null }),
  ];
  const safe = validateReplayItems(source, limits);
  assert.deepEqual(safe, source);
  assert.equal(JSON.stringify(safe), JSON.stringify(source));
  assert.notEqual(safe, source);
  assert.notEqual(safe[0], source[0]);
  (safe[0]!.metadata as JsonObject).future = 'mutated';
  assert.deepEqual((source[0]!.metadata as JsonObject).future, ['preserved', null, true]);
});

test('optional status and empty native output are accepted', () => {
  const item = message(); delete item.status;
  assert.deepEqual(validateReplayItems([item], limits), [item]);
  assert.deepEqual(validateReplayItems([], { ...limits, maxItems: 0, maxBytes: 2, maxToolCalls: 0, maxToolArgumentBytes: 0 }), []);
});

test('binding concatenates output text and refusal in native item order and ignores opaque reasoning', () => {
  const replay = validateReplayItems([
    reasoning(), message('checking', { phase: 'commentary' }), call(),
    message('', { id: 'msg-2', phase: 'final_answer', content: [{ type: 'refusal', refusal: 'declined' }, { type: 'output_text', text: 'done' }] }),
  ], limits);
  validateReplayBinding({ role: 'assistant', content: 'checkingdeclineddone', toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'file.txt' } }] }, replay);
  invalid(() => validateReplayBinding({ role: 'assistant', content: 'opaque summarycheckingdeclineddone', toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'file.txt' } }] }, replay));
});

test('function argument formatting, numeric exponents and object key order bind with JSON semantics', () => {
  for (const args of ['1e10', '1e-6', '{"n":1e20}', '{"b":[1,{"z":2,"a":3}],"a":-0}']) {
    const replay = validateReplayItems([call(args)], limits);
    assert.equal(replay[0]!.arguments, args);
    const parsed = JSON.parse(args) as JsonValue;
    const input = args.includes('"b"') ? { a: 0, b: [1, { a: 3, z: 2 }] } : parsed;
    validateReplayBinding({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', input }] }, replay);
  }
  const items = validateReplayItems([call('{"a":[1,2]}')], limits);
  invalid(() => validateReplayBinding({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', input: { a: [2, 1] } }] }, items));
});

test('argument redaction covers parsed JSON escapes, keys and nested values and binds normalized calls', () => {
  const encoded = JSON.stringify({ credential: SECRET, [SECRET]: [SECRET] }).replaceAll('sk-replay', 'sk-\\u0072eplay');
  const safe = validateReplayItems([call(encoded, { call_id: `call-${SECRET}`, name: `read-${SECRET}`, extra: { [SECRET]: SECRET } })], { ...limits, secrets: [SECRET] });
  assert.doesNotMatch(JSON.stringify(safe), /sk-replay-fixture-private/);
  assert.deepEqual(JSON.parse(safe[0]!.arguments as string), { credential: '[REDACTED]', '[REDACTED]': ['[REDACTED]'] });
  validateReplayBinding({ role: 'assistant', content: '', toolCalls: [{ id: 'call-[REDACTED]', name: 'read-[REDACTED]', input: { credential: '[REDACTED]', '[REDACTED]': ['[REDACTED]'] } }] }, safe);
});

test('ordinary native text, metadata and reasoning summaries are redacted while ciphertext stays byte exact', () => {
  const cipher = 'random-opaque-ciphertext+/=';
  const safe = validateReplayItems([
    reasoning({ encrypted_content: cipher, summary: [{ type: 'summary_text', text: SECRET }], content: [{ type: 'reasoning_text', text: SECRET }] }),
    message(SECRET, { metadata: { [SECRET]: SECRET } }),
  ], { ...limits, secrets: [SECRET] });
  assert.equal(safe[0]!.encrypted_content, cipher);
  assert.doesNotMatch(JSON.stringify(safe), /sk-replay-fixture-private/);
  validateReplayBinding({ role: 'assistant', content: '[REDACTED]' }, safe);
});

test('ciphertext containing the injected key fails instead of changing opaque state', () => {
  for (const encrypted_content of [SECRET, `prefix-${SECRET}-suffix`]) invalid(() => validateReplayItems([reasoning({ encrypted_content })], { ...limits, secrets: [SECRET] }));
  const original = reasoning({ encrypted_content: null });
  assert.deepEqual(validateReplayItems([original], { ...limits, secrets: [SECRET] }), [original]);
});

test('replacement marker cannot reflect short or bracket-containing injected keys', () => {
  for (const secret of ['REDACTED', '[', ']']) {
    const safe = validateReplayItems([message(`before ${secret} after`), call(JSON.stringify({ value: secret }))], { ...limits, secrets: [secret] });
    assert.ok(!(safe[0]!.content as JsonObject[])[0]!.text!.toString().includes(secret));
    assert.ok(!(JSON.parse(safe[1]!.arguments as string) as { value: string }).value.includes(secret));
  }
});

test('byte bounds include full JSON escaping and Unicode before redaction', () => {
  for (const text of ['한글🌊', '\u0000\n"\\\ud800\udfff', 'plain']) {
    const items = [message(text)];
    const bytes = Buffer.byteLength(JSON.stringify(items), 'utf8');
    assert.deepEqual(validateReplayItems(items, { ...limits, maxBytes: bytes }), items);
    invalid(() => validateReplayItems(items, { ...limits, maxBytes: bytes - 1 }));
  }
});

test('byte and aggregate argument limits are applied again after redaction expands strings', () => {
  const items = [message('XY')];
  const rawBytes = Buffer.byteLength(JSON.stringify(items), 'utf8');
  invalid(() => validateReplayItems(items, { ...limits, secrets: ['XY'], maxBytes: rawBytes }));
  assert.equal((validateReplayItems(items, { ...limits, secrets: ['XY'], maxBytes: rawBytes + 8 })[0]!.content as JsonObject[])[0]!.text, '[REDACTED]');
  const rawArguments = '{"value":"XY"}';
  invalid(() => validateReplayItems([call(rawArguments)], { ...limits, secrets: ['XY'], maxToolArgumentBytes: Buffer.byteLength(rawArguments) }));
  const two = [call('{}'), call('{}', { id: 'fc-2', call_id: 'call-2' })];
  assert.deepEqual(validateReplayItems(two, { ...limits, maxToolArgumentBytes: 4, maxToolCalls: 2 }), two);
  invalid(() => validateReplayItems(two, { ...limits, maxToolArgumentBytes: 3 }));
  invalid(() => validateReplayItems(two, { ...limits, maxToolCalls: 1 }));
  invalid(() => validateReplayItems(two, { ...limits, maxItems: 1 }));
});

test('raw and redacted item IDs, call IDs and JSON keys remain unique', () => {
  for (const items of [
    [message(), message('other')],
    [call(), call('{}', { id: 'fc-2' })],
    [message('a', { id: SECRET }), message('b', { id: '[REDACTED]' })],
    [call('{}', { call_id: SECRET }), call('{}', { id: 'fc-2', call_id: '[REDACTED]' })],
    [message('', { metadata: { [SECRET]: 1, '[REDACTED]': 2 } })],
    [call(JSON.stringify({ [SECRET]: 1, '[REDACTED]': 2 }))],
  ]) invalid(() => validateReplayItems(items, { ...limits, secrets: [SECRET] }));
});

test('unknown or malformed native fields are rejected', () => {
  const bad: unknown[] = [null, {}, [null], [message('', { id: '' })], [message('', { role: 'user' })],
    [message('', { type: 'web_search_call' })], [message('', { status: 'incomplete' })], [message('', { status: null })],
    [message('', { phase: 'other' })], [message('', { content: {} })], [message('', { content: [{ type: 'output_text', text: 1 }] })],
    [message('', { content: [{ type: 'refusal', refusal: null }] })], [message('', { content: [{ type: 'output_text', text: '', annotations: {} }] })],
    [reasoning({ summary: [{ type: 'reasoning_text', text: 'x' }] })], [reasoning({ content: [{ type: 'reasoning_text', text: 1 }] })],
    [reasoning({ encrypted_content: 1 })], [call('{}', { call_id: '' })], [call('{}', { name: '' })], [call('{}', { arguments: {} })],
    [call('{')], [call('1e400')]];
  for (const value of bad) invalid(() => validateReplayItems(value, limits));
});

test('required limits are finite integers and cannot be omitted', () => {
  for (const value of [NaN, Infinity, -1, 1.5, 2_147_483_648]) invalid(() => validateReplayItems([], { ...limits, maxBytes: value }));
  invalid(() => validateReplayItems([], { ...limits, maxBytes: 0 }));
  for (const field of ['maxItems', 'maxBytes', 'maxToolArgumentBytes', 'maxToolCalls']) {
    const missing = { ...limits } as unknown as Record<string, unknown>; delete missing[field];
    invalid(() => validateReplayItems([], missing as unknown as ReplayValidationOptions));
  }
});

test('JSON-only cloning rejects cycles, exotic prototypes, accessors and non-JSON values', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const sparse = Array(1);
  const extraArray = [1]; Object.defineProperty(extraArray, 'extra', { value: 2, enumerable: true });
  const symbol = { [Symbol('hidden')]: true };
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 1 });
  let invoked = 0;
  const getter = {}; Object.defineProperty(getter, 'secret', { enumerable: true, get() { invoked++; throw new Error(SECRET); } });
  const toJSON = { toJSON() { invoked++; throw new Error(SECRET); } };
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, Symbol('x'), new Date(), new Map(), new Uint8Array([1]), Object.create({ inherited: 1 }), cyclic, sparse, extraArray, symbol, hidden, getter, toJSON]) {
    invalid(() => validateReplayItems([{ ...message(), extra: value }], limits));
  }
  assert.equal(invoked, 0);
});

test('depth is bounded at 64 for native JSON and parsed arguments; shared acyclic values clone', () => {
  validateReplayItems([message('', { extra: nested(62) })], limits);
  invalid(() => validateReplayItems([message('', { extra: nested(63) })], limits));
  const args = JSON.stringify(nested(64));
  const replay = validateReplayItems([call(args)], limits);
  validateReplayBinding({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', input: nested(64) }] }, replay);
  invalid(() => validateReplayItems([call(JSON.stringify(nested(65)))], limits));
  const shared = { preserved: 1 };
  const safe = validateReplayItems([message('', { extra: [shared, shared] })], limits);
  const extra = safe[0]!.extra as JsonObject[];
  assert.deepEqual(extra[0], extra[1]); assert.notEqual(extra[0], extra[1]);
});

test('__proto__ keys stay own JSON data and do not alter prototypes', () => {
  const items = [message('', { extra: JSON.parse('{"__proto__":{"polluted":true}}') as JsonObject }), call('{"__proto__":{"x":1}}')];
  const safe = validateReplayItems(items, limits);
  assert.equal(Object.getPrototypeOf(safe[0]!.extra), Object.prototype);
  assert.ok(Object.hasOwn(safe[0]!.extra as JsonObject, '__proto__'));
  validateReplayBinding({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', input: JSON.parse('{"__proto__":{"x":1}}') as JsonValue }] }, safe);
});

test('binding rejects changed text, roles, call count, order, identifiers, names and inputs', () => {
  const items = validateReplayItems([message('answer'), call(), call('{}', { id: 'fc-2', call_id: 'call-2', name: 'other' })], limits);
  const valid: ProviderMessage = { role: 'assistant', content: 'answer', toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'file.txt' } }, { id: 'call-2', name: 'other', input: {} }] };
  validateReplayBinding(valid, items);
  for (const changed of [
    { ...valid, role: 'user' }, { ...valid, content: 'changed' }, { ...valid, toolCalls: undefined },
    { ...valid, toolCalls: valid.toolCalls!.slice().reverse() }, { ...valid, toolCalls: valid.toolCalls!.slice(0, 1) },
    { ...valid, toolCalls: [{ id: 'wrong', name: 'read_file', input: { path: 'file.txt' } }, valid.toolCalls![1]!] },
    { ...valid, toolCalls: [{ id: 'call-1', name: 'wrong', input: { path: 'file.txt' } }, valid.toolCalls![1]!] },
    { ...valid, toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'wrong' } }, valid.toolCalls![1]!] },
  ]) invalid(() => validateReplayBinding(changed as ProviderMessage, items));
});

test('binding rejects getters without invoking normalized message or tool-call hooks', () => {
  let invoked = 0;
  const getter = () => { invoked++; return 'answer'; };
  const bad = { role: 'assistant' }; Object.defineProperty(bad, 'content', { enumerable: true, get: getter });
  invalid(() => validateReplayBinding(bad as ProviderMessage, [message()]));
  const tool = { id: 'call-1', input: { path: 'file.txt' } }; Object.defineProperty(tool, 'name', { enumerable: true, get: getter });
  invalid(() => validateReplayBinding({ role: 'assistant', content: '', toolCalls: [tool] } as unknown as ProviderMessage, [call()]));
  assert.equal(invoked, 0);
});
