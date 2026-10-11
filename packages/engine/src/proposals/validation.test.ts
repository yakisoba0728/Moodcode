import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalSha256 } from '../shared/canonical.js';
import { assertNotThenable, ownDataFields, proposalChecks, trackPending } from './validation.js';

const fail = (code = 'INVALID'): never => { throw new Error(code); };
const reported = (code: string) => (error: unknown) => error instanceof Error && error.message === code;
const checks = proposalChecks({ fail, limitCode: 'LIMIT', hashCode: 'HASH', rowCode: 'ROW', maxBytes: 128, maxNodes: 8, maxDepth: 2, maxItems: 2 });

test('proposal checks map walker size faults to the limit code and every other fault to the default code', () => {
  const copy = checks.json({ a: ['x'], b: null });
  assert.deepEqual(copy, { a: ['x'], b: null }); assert.ok(Object.isFrozen(copy) && Object.isFrozen(copy.a));
  for (const value of [{ a: { b: { c: 1 } } }, { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1 }, 'x'.repeat(129), '\ud800', { key: 'x'.repeat(120) }])
    assert.throws(() => checks.json(value), reported('LIMIT'));
  assert.throws(() => checks.json({ a: 'x'.repeat(20) }, 16), reported('LIMIT'));
  for (const value of [[1, 2, 3], { a: Number.NaN }, { a: undefined }, new Map(), JSON.parse('{"__proto__":1}'), Object.defineProperty({}, 'a', { get: () => 1, enumerable: true })])
    assert.throws(() => checks.json(value), reported('INVALID'));
});

test('proposal checks seal through the module walker, verify with the hash code and decode rows with the row code', () => {
  const sealed = checks.seal({ id: 'p' });
  assert.equal(sealed.sha256, canonicalSha256({ id: 'p' })); assert.ok(Object.isFrozen(sealed));
  assert.throws(() => checks.verify({ ...sealed, id: 'q' }), reported('HASH'));
  assert.throws(() => checks.stamp('+010000-01-01T00:00:00.000Z'), reported('INVALID'));
  assert.deepEqual(checks.decoded('{"a":1}', 7), { a: 1 });
  assert.throws(() => checks.decoded('{"a":1}', 6), reported('LIMIT'));
  assert.throws(() => checks.decoded(1, 6), reported('LIMIT'));
  assert.throws(() => checks.decoded('{', 6), reported('ROW'));
});

test('own data fields never read a prototype, and a thenable port result is refused', () => {
  let reads = 0;
  Object.defineProperty(Object.prototype, 'optional', { configurable: true, get: () => { reads++; return { value: 'inherited' }; } });
  try {
    const fields = ownDataFields({ required: 1 }, ['required'], ['optional'], () => fail());
    assert.equal(fields.required!.value, 1); assert.equal(fields.optional?.value, undefined);
  } finally { delete (Object.prototype as { optional?: unknown }).optional; }
  assert.equal(reads, 0);
  assert.throws(() => ownDataFields({ required: 1, extra: 2 }, ['required'], ['optional'], () => fail()), reported('INVALID'));
  assertNotThenable(undefined, () => fail()); assertNotThenable({ value: 1 }, () => fail());
  assert.throws(() => assertNotThenable(Promise.resolve(), () => fail('ASYNC')), reported('ASYNC'));
  assert.throws(() => assertNotThenable({ then: undefined }, () => fail('ASYNC')), reported('ASYNC'));
});

test('tracked tasks leave the pending set once settled, including rejected ones', async () => {
  const pending = new Set<Promise<unknown>>();
  const resolved = trackPending(pending, Promise.resolve(1)), rejected = trackPending(pending, Promise.reject(new Error('late')));
  assert.equal(pending.size, 2);
  assert.equal(await resolved, 1); await assert.rejects(rejected, /late/u);
  await Promise.resolve();
  assert.equal(pending.size, 0);
});
