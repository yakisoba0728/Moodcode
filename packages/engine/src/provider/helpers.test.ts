import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { redactJson, redactText, TextRedactor } from './helpers.js';

const REGULAR_KEY = 'sk-fixture-redactor-private-1234567890';
const FALLBACK = '█';
const riskyKeys = ['REDACTED', 'R', 'E', 'D', 'A', 'C', 'T', '[', ']', '[REDACTED]', 'R[', '[R', 'x]', ']x', 'x[y', 'x]y'];

function absent(value: string, secret: string): void {
  assert.equal(value.includes(secret), false, 'Redacted output still contains the exact synthetic key.');
}
function absentJson(value: unknown, secret: string): void {
  if (typeof value === 'string') absent(value, secret);
  else if (Array.isArray(value)) for (const item of value) absentJson(item, secret);
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { absent(key, secret); absentJson(item, secret); }
}

function stream(input: string, secret: string | undefined, fragments: string[]): string {
  assert.equal(fragments.join(''), input);
  const redactor = new TextRedactor(secret);
  let result = '';
  for (const fragment of fragments) {
    result += redactor.push(fragment);
    if (secret) absent(result, secret);
  }
  result += redactor.push('', true);
  if (secret) absent(result, secret);
  return result;
}

test('regular key keeps the established text and JSON replacement marker', () => {
  const original = `before ${REGULAR_KEY} after ${REGULAR_KEY}`;
  assert.equal(redactText(original, REGULAR_KEY), 'before [REDACTED] after [REDACTED]');
  assert.equal(stream(original, REGULAR_KEY, [`before ${REGULAR_KEY.slice(0, 8)}`, `${REGULAR_KEY.slice(8)} after ${REGULAR_KEY}`]), 'before [REDACTED] after [REDACTED]');
  assert.deepEqual(redactJson({ [`key-${REGULAR_KEY}`]: [REGULAR_KEY, `value-${REGULAR_KEY}`, 'safe'] }, REGULAR_KEY), {
    'key-[REDACTED]': ['[REDACTED]', 'value-[REDACTED]', 'safe'],
  });
});

test('redaction without a key preserves Unicode, literal markers and JSON values', () => {
  const original = '안녕 🌊 café [REDACTED] █';
  assert.equal(redactText(original, undefined), original);
  assert.equal(stream(original, undefined, ['안녕 ', '🌊 café ', '[REDACTED] █']), original);
  assert.deepEqual(redactJson({ text: original, data: [null, true, false, 17] }, undefined), { text: original, data: [null, true, false, 17] });
});

test('streaming redaction withholds a key prefix until its later completion', () => {
  const redactor = new TextRedactor(REGULAR_KEY);
  assert.equal(redactor.push(`before ${REGULAR_KEY.slice(0, 12)}`), 'before ');
  assert.equal(redactor.push(REGULAR_KEY.slice(12)), '[REDACTED]');
  assert.equal(redactor.push(' after', true), ' after');
  assert.equal(redactor.push('', true), '');
});

test('a trailing partial key is restored only when the stream finishes', () => {
  const prefix = REGULAR_KEY.slice(0, -1);
  const redactor = new TextRedactor(REGULAR_KEY);
  assert.equal(redactor.push(`before ${prefix}`), 'before ');
  assert.equal(redactor.push('', true), prefix);
  assert.equal(redactor.push('', true), '');
});

for (const key of riskyKeys) {
  test(`synthetic key ${JSON.stringify(key)} uses a marker that contains no exact key`, () => {
    const original = `before(${key})after(${key})`;
    assert.equal(redactText(original, key), `before(${FALLBACK})after(${FALLBACK})`);
    absent(redactText(original, key), key);
    // Every split point exercises prefixes and suffixes immediately adjacent to
    // a replacement boundary, rather than only splitting the credential itself.
    for (let index = 0; index <= original.length; index++) {
      assert.equal(stream(original, key, [original.slice(0, index), original.slice(index)]), `before(${FALLBACK})after(${FALLBACK})`);
    }
    assert.equal(stream(original, key, [...original]), `before(${FALLBACK})after(${FALLBACK})`);
    const json = redactJson({ [`key-${key}`]: [key, `value-${key}`, { [`nested-${key}`]: key }] }, key);
    absentJson(json, key);
    assert.deepEqual(json, { [`key-${FALLBACK}`]: [FALLBACK, `value-${FALLBACK}`, { [`nested-${FALLBACK}`]: FALLBACK }] });
  });
}

test('bracket keys cannot be synthesized across the left replacement boundary', () => {
  const key = 'x[';
  const original = `x${key}`;
  assert.equal(redactText(original, key), `x${FALLBACK}`);
  assert.equal(stream(original, key, ['x', 'x', '[']), `x${FALLBACK}`);
  const json = redactJson({ [`x${key}`]: `x${key}` }, key);
  assert.deepEqual(json, { [`x${FALLBACK}`]: `x${FALLBACK}` });
  absentJson(json, key);
});

test('bracket keys cannot be synthesized across the right replacement boundary', () => {
  const key = ']x';
  const original = `${key}x`;
  assert.equal(redactText(original, key), `${FALLBACK}x`);
  assert.equal(stream(original, key, [']', 'x', 'x']), `${FALLBACK}x`);
  const json = redactJson({ [`${key}x`]: `${key}x` }, key);
  assert.deepEqual(json, { [`${FALLBACK}x`]: `${FALLBACK}x` });
  absentJson(json, key);
});

test('fallback markers cannot synthesize a multi-character bracket key between replacements', () => {
  const key = '][';
  const original = `${key}${key}`;
  assert.equal(redactText(original, key), `${FALLBACK}${FALLBACK}`);
  assert.equal(stream(original, key, [']', '[', ']', '[']), `${FALLBACK}${FALLBACK}`);
  absent(redactText(original, key), key);
});

test('safe short keys still use the established marker and support overlapping prefixes', () => {
  assert.equal(redactText('xx', 'x'), '[REDACTED][REDACTED]');
  assert.equal(stream('ababa', 'aba', ['a', 'b', 'a', 'b', 'a']), '[REDACTED]ba');
  assert.equal(stream('aaaaa', 'aa', ['a', 'a', 'a', 'a', 'a']), '[REDACTED][REDACTED]a');
});

test('fallback JSON key collisions reject instead of overwriting a field', () => {
  assert.throws(() => redactJson({ REDACTED: 'private', [FALLBACK]: 'existing' }, 'REDACTED'), error => {
    assert.ok(error instanceof EngineError); assert.equal(error.code, 'PROVIDER_MALFORMED_STREAM'); return true;
  });
});

test('fallback JSON redaction preserves an own __proto__ property safely', () => {
  const input = JSON.parse('{"__proto__":{"REDACTED":"REDACTED"}}') as unknown;
  const output = redactJson(input, 'REDACTED');
  assert.deepEqual(output, JSON.parse(`{"__proto__":{"${FALLBACK}":"${FALLBACK}"}}`));
  assert.ok(output !== null && typeof output === 'object' && !Array.isArray(output));
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.ok(Object.hasOwn(output, '__proto__'));
  absentJson(output, 'REDACTED');
});
