import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineError } from './index.js';
import { validateCommand } from './validation.js';

const fingerprint = '0123456789abcdef'.repeat(4);
const envelope = (type: string, payload: unknown) => ({ schemaVersion: 1, commandId: 'gui-command', type, payload });
const cases: { type: string; payload: Record<string, unknown> }[] = [
  { type: 'file.list', payload: { workspaceId: 'workspace' } },
  { type: 'file.read', payload: { workspaceId: 'workspace', path: 'src/index.ts' } },
  { type: 'workspace.getStatus', payload: { workspaceId: 'workspace' } },
  { type: 'review.previewRestore', payload: { runId: 'run', checkpointId: 'checkpoint' } },
  { type: 'review.restore', payload: { runId: 'run', checkpointId: 'checkpoint', previewFingerprint: fingerprint } },
  { type: 'review.history', payload: { runId: 'run' } },
];

function rejects(type: string, payload: unknown, path?: string): void {
  assert.throws(() => validateCommand(envelope(type, payload)), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'INVALID_INPUT');
    if (path) assert.equal(error.details?.path, path);
    return true;
  });
}

test('all six GUI commands validate into independent canonical payloads', () => {
  for (const fixture of cases) {
    const input = envelope(fixture.type, { ...fixture.payload });
    const actual = validateCommand(input);
    assert.deepEqual(actual, input);
    assert.notStrictEqual(actual, input);
    assert.notStrictEqual(actual.payload, input.payload);
    actual.payload.extra = 'caller mutation';
    assert.equal((input.payload as Record<string, unknown>).extra, undefined);
  }
});

test('file listing distinguishes omitted root from explicit empty root and reads require a path', () => {
  const omitted = validateCommand(envelope('file.list', { workspaceId: 'workspace' }));
  assert.equal(Object.hasOwn(omitted.payload, 'path'), false);
  assert.deepEqual(validateCommand(envelope('file.list', { workspaceId: 'workspace', path: '' })).payload, { workspaceId: 'workspace', path: '' });
  rejects('file.list', { workspaceId: 'workspace', path: undefined }, 'payload.path');
  rejects('file.read', { workspaceId: 'workspace' }, 'payload.path');
  rejects('file.read', { workspaceId: 'workspace', path: '' }, 'payload.path');
});

test('canonical relative paths preserve spaces, Unicode, dot-prefixed names and valid replacement characters', () => {
  for (const path of ['README.md', 'src/index.ts', '.env', '.hidden/file', '한글/🙂.ts', 'folder with spaces/file name.txt', ' ', '\uFEFFname.txt', 'valid-\uFFFD.txt']) {
    for (const type of ['file.list', 'file.read']) {
      assert.equal(validateCommand(envelope(type, { workspaceId: 'workspace', path })).payload.path, path);
    }
  }
});

test('GUI paths reject host absolute paths, Windows drive paths, traversal and empty or dot segments', () => {
  const paths = [
    '/etc/passwd', '//server/share/file', 'C:/absolute', 'c:relative', 'Z:',
    '\\rooted', '\\\\server\\share', '\\\\?\\C:\\file', 'folder\\file',
    '.', '..', './file', '../file', 'folder/.', 'folder/..', 'folder/../file', 'folder/./file',
    'folder//file', 'folder/', '/folder', 'a///b',
  ];
  for (const path of paths) for (const type of ['file.list', 'file.read']) rejects(type, { workspaceId: 'workspace', path }, 'payload.path');
});

test('GUI paths reject NUL/control characters and malformed UTF-16 rather than replacing invalid UTF-8', () => {
  const paths = [
    ...[0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x85, 0x9f].map((code) => `file${String.fromCharCode(code)}name`),
    '\uD800', '\uDC00', 'prefix\uD800suffix', '\uDC00\uD800', 'prefix\uD800/file',
  ];
  for (const path of paths) for (const type of ['file.list', 'file.read']) rejects(type, { workspaceId: 'workspace', path }, 'payload.path');
});

test('relative path byte limits accept exact UTF-8 boundaries and reject oversized values', () => {
  for (const type of ['file.list', 'file.read']) {
    for (const path of ['x'.repeat(4_096), 'é'.repeat(2_048), `${'가'.repeat(1_365)}x`, '🙂'.repeat(1_024)]) {
      assert.equal(validateCommand(envelope(type, { workspaceId: 'workspace', path })).payload.path, path);
    }
    for (const path of ['x'.repeat(4_097), 'é'.repeat(2_049), '가'.repeat(1_366), `${'🙂'.repeat(1_024)}x`]) {
      rejects(type, { workspaceId: 'workspace', path }, 'payload.path');
    }
  }
});

test('restore requires exactly 64 lowercase SHA-256 hexadecimal characters', () => {
  for (const previewFingerprint of [fingerprint, '0'.repeat(64), 'f'.repeat(64)]) {
    assert.equal(validateCommand(envelope('review.restore', { runId: 'run', checkpointId: 'checkpoint', previewFingerprint })).payload.previewFingerprint, previewFingerprint);
  }
  rejects('review.restore', { runId: 'run', checkpointId: 'checkpoint' }, 'payload.previewFingerprint');
  for (const previewFingerprint of [undefined, null, false, 64, {}, [], '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ` ${'a'.repeat(63)}`, `${'a'.repeat(64)}\n`, `${'a'.repeat(63)}\n`, 'é'.repeat(64)]) {
    rejects('review.restore', { runId: 'run', checkpointId: 'checkpoint', previewFingerprint }, 'payload.previewFingerprint');
  }
  rejects('review.previewRestore', { runId: 'run', checkpointId: 'checkpoint', previewFingerprint: fingerprint }, 'payload');
});

test('GUI identifiers reuse existing required bounded ID rules', () => {
  for (const fixture of cases) {
    for (const key of Object.keys(fixture.payload).filter((key) => key.endsWith('Id'))) {
      const missing = { ...fixture.payload };
      delete missing[key];
      rejects(fixture.type, missing, `payload.${key}`);
      for (const value of [undefined, null, false, 1, {}, [], '', '   ', 'line\nbreak', 'x'.repeat(257), 'é'.repeat(129)]) {
        rejects(fixture.type, { ...fixture.payload, [key]: value }, `payload.${key}`);
      }
      assert.equal(validateCommand(envelope(fixture.type, { ...fixture.payload, [key]: 'é'.repeat(128) })).payload[key], 'é'.repeat(128));
    }
  }
});

test('GUI command payloads reject every unsupported option including explicit undefined', () => {
  for (const fixture of cases) {
    for (const [key, value] of [['options', {}], ['signal', undefined], ['force', false], ['timeoutMs', 10], ['apiKey', 'private-gui-value'], ['unsupportedLimit', 20]] as const) {
      rejects(fixture.type, { ...fixture.payload, [key]: value }, 'payload');
    }
  }
  rejects('workspace.getStatus', { workspaceId: 'workspace', path: '' }, 'payload');
  rejects('review.history', { runId: 'run', checkpointId: 'checkpoint' }, 'payload');
});

test('GUI payload getters, inherited properties, symbols and hidden fields cannot become command data', () => {
  let getterReads = 0;
  for (const fixture of cases) {
    for (const key of Object.keys(fixture.payload)) {
      const getter = Object.defineProperty({ ...fixture.payload }, key, { enumerable: true, get() { getterReads++; return fixture.payload[key]; } });
      rejects(fixture.type, getter, 'payload');
      const hidden = Object.defineProperty({ ...fixture.payload }, key, { value: fixture.payload[key], enumerable: false });
      rejects(fixture.type, hidden, 'payload');
    }
    rejects(fixture.type, Object.create(fixture.payload), 'payload');
    rejects(fixture.type, { ...fixture.payload, [Symbol('private-gui-value')]: 'secret' }, 'payload');
    const nullPrototype = Object.assign(Object.create(null), fixture.payload);
    assert.deepEqual(validateCommand(envelope(fixture.type, nullPrototype)).payload, fixture.payload);
  }
  assert.equal(getterReads, 0);
});

test('non-JSON GUI payloads and field values are rejected without coercion', () => {
  class Payload { workspaceId = 'workspace'; }
  for (const fixture of cases) {
    for (const payload of [undefined, null, [], 'payload', 1, true, new Date(), new Map(), new Set(), new Payload()]) rejects(fixture.type, payload, 'payload');
  }
  let coercions = 0;
  const coercible = { toString() { coercions++; return 'file.txt'; } };
  for (const path of [null, undefined, true, 1, NaN, Infinity, 1n, Symbol('path'), [], {}, coercible, () => 'file.txt']) {
    rejects('file.read', { workspaceId: 'workspace', path }, 'payload.path');
    rejects('file.list', { workspaceId: 'workspace', path }, 'payload.path');
  }
  assert.equal(coercions, 0);
});

test('invalid GUI values and failed object reflection never leak submitted diagnostics', () => {
  const secret = 'private-gui-value';
  const attempts = [
    () => validateCommand(envelope('file.read', { workspaceId: 'workspace', path: `../${secret}` })),
    () => validateCommand(envelope('review.restore', { runId: 'run', checkpointId: 'checkpoint', previewFingerprint: secret })),
    () => validateCommand(envelope('workspace.getStatus', { workspaceId: 'workspace', options: secret })),
    () => validateCommand(envelope('file.list', new Proxy({}, { getPrototypeOf() { throw new Error(secret); } }))),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, 'INVALID_INPUT');
      assert.ok(!`${error.message} ${JSON.stringify(error.details)}`.includes(secret));
      return true;
    });
  }
});
