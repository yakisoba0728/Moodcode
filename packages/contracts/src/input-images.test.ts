import assert from 'node:assert/strict';
import test from 'node:test';
import { INPUT_IMAGE_LIMITS, type InputImageAttachment } from './index.js';
import { normalizeAcceptInput, normalizeImageAttachments, normalizeSubmitInput, validateCommand, validateSessionCommand } from './validation.js';

const image = (index = 1): InputImageAttachment => ({ id: 'img_' + index.toString(16).padStart(32, '0'), kind: 'image', mimeType: 'image/png', bytes: 80, sha256: 'a'.repeat(64) });
const input = { sessionId: 'session', requestId: 'request', prompt: 'Inspect the attached image' };
test('image references survive both command versions and remain isolated from caller mutation', () => {
  const refs = [image()], normalized = normalizeSubmitInput({ ...input, attachments: refs });
  refs[0]!.bytes = 90; assert.equal(normalized.attachments?.[0]?.bytes, 80);
  assert.deepEqual(normalizeAcceptInput({ ...input, attachments: [image()], delivery: 'queue' }).attachments, [image()]);
  assert.deepEqual(validateCommand({ schemaVersion: 1, commandId: 'command', type: 'run.submit', payload: { ...input, attachments: [image()] } }).payload.attachments, [image()]);
  assert.deepEqual(validateSessionCommand({ schemaVersion: 2, commandId: 'command', type: 'input.accept', payload: { ...input, attachments: [image()] } }, { enabledCommands: ['input.accept'] }).payload.attachments, [image()]);
  assert.equal(Object.hasOwn(normalizeSubmitInput(input), 'attachments'), false);
  assert.deepEqual(normalizeSubmitInput({ ...input, attachments: [] }).attachments, []);
});
test('references reject external locations, media bytes and unknown identity fields', () => {
  for (const bad of [{ ...image(), url: 'https://image.invalid/x' }, { ...image(), path: '/tmp/x' }, { ...image(), data: 'base64' },
    { ...image(), id: '../image' }, { ...image(), mimeType: 'image/svg+xml' }, { ...image(), sha256: 'A'.repeat(64) }, { ...image(), kind: 'audio' }]) assert.throws(() => normalizeImageAttachments([bad]));
});
test('reference count, byte totals and duplicate IDs are bounded', () => {
  assert.throws(() => normalizeImageAttachments([image(), image()]));
  assert.throws(() => normalizeImageAttachments([1, 2, 3, 4, 5].map(image)));
  assert.throws(() => normalizeImageAttachments([{ ...image(), bytes: INPUT_IMAGE_LIMITS.maxImageBytes + 1 }]));
  assert.throws(() => normalizeImageAttachments([1, 2, 3].map(index => ({ ...image(index), bytes: INPUT_IMAGE_LIMITS.maxImageBytes }))));
  for (const bytes of [0, -1, 1.2, Number.MAX_SAFE_INTEGER]) assert.throws(() => normalizeImageAttachments([{ ...image(), bytes }]));
});
test('malformed arrays and accessors are rejected without evaluating getters', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'id', { enumerable: true, get() { calls++; return image().id; } });
  const getterArray = Object.defineProperty([], '0', { enumerable: true, get() { calls++; return image(); } });
  for (const value of [undefined, null, new Array(1), getterArray, [getter], Object.assign([image()], { extra: true })]) assert.throws(() => normalizeImageAttachments(value));
  assert.equal(calls, 0);
  assert.throws(() => normalizeSubmitInput({ ...input, attachments: undefined }));
});
