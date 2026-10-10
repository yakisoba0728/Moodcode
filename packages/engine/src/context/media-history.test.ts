import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type InputImageAttachment, type JsonObject, type Message, type Run, type SessionSnapshot } from '@moodcode/contracts';
import type { ProviderMessage, TurnRequest } from '../ports.js';
import { imageFixture } from '../media/fixtures.js';
import { providerImages } from '../media/provider.js';
import { ResponsesProvider } from '../provider/responses.js';
import { MEDIA_HISTORY_LIMITS, MEDIA_HISTORY_NOTICE_PREFIX, projectMediaHistory, type MediaHistoryPolicy } from './media-history.js';

const policy: MediaHistoryPolicy = { kind: 'reference-only-older-images', version: 1 };
const createdAt = '2026-10-07T00:00:00.000Z';
const image = imageFixture();
const ref = (digit = 1): InputImageAttachment => ({ ...image.attachment, id: 'img_' + digit.toString(16).padStart(32, '0') });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function user(id: string, runId: string, refs?: InputImageAttachment[], content = 'Exact user text ' + id): Message { return { id, runId, sessionId: 'session', role: 'user', content, createdAt, ...(refs === undefined ? {} : { attachments: refs }) }; }
function assistant(id: string, runId: string, content = 'Historical assistant observation'): Message { return { ...user(id, runId, undefined, content), role: 'assistant' }; }
function snapshot(messages: Message[]): SessionSnapshot {
  const runs: Run[] = [...new Set(messages.map(message => message.runId))].map((id, index) => ({ id, inputId: 'input-' + id, sessionId: 'session', workspaceId: 'workspace', requestId: id, prompt: 'Fixture goal', state: index === new Set(messages.map(message => message.runId)).size - 1 ? 'running' : 'completed', createdAt, updatedAt: createdAt,
    config: { providerId: 'fixture', modelId: 'fixture', mode: 'plan', limits: { ...DEFAULT_LIMITS } } }));
  return { session: { id: 'session', workspaceId: 'workspace', title: 'Fixture', createdAt }, messages, runs, tools: [], approvals: [], lastSeq: messages.length };
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function errorCode(code: string) { return (error: unknown) => { assert.ok(error instanceof EngineError); assert.equal(error.code, code); assert.ok(!JSON.stringify(error).includes(image.data)); return true; }; }
function messages(source: SessionSnapshot): ProviderMessage[] { return source.messages.map(({ role, content, attachments, toolCalls, toolCallId, providerReplay }) => ({ role, content, ...(attachments === undefined ? {} : { attachments }), ...(toolCalls === undefined ? {} : { toolCalls }), ...(toolCallId === undefined ? {} : { toolCallId }), ...(providerReplay === undefined ? {} : { providerReplay }) })); }
function notice(value: ReturnType<typeof projectMediaHistory>): Record<string, unknown> { assert.ok(value.requiredNotice); assert.ok(value.requiredNotice.content.startsWith(MEDIA_HISTORY_NOTICE_PREFIX)); return JSON.parse(value.requiredNotice.content.slice(MEDIA_HISTORY_NOTICE_PREFIX.length)) as Record<string, unknown>; }

test('disabled policy clones raw history, including more than four frames, and activates no omission', () => {
  const source = freeze(snapshot(Array.from({ length: 5 }, (_, index) => user('user-' + index, 'run-' + index, [ref()])))), before = structuredClone(source);
  const result = projectMediaHistory(source, { activeRunId: 'run-4' });
  assert.deepEqual(result.snapshot, before); assert.notEqual(result.snapshot.messages, source.messages); assert.notEqual(result.snapshot.messages[0], source.messages[0]);
  assert.equal(result.requiredNotice, null); assert.deepEqual(result.provenance, []); assert.equal(result.diagnostics.enabled, false); assert.equal(result.diagnostics.activeCutoffCreated, false);
  result.snapshot.messages[0]!.attachments![0]!.bytes++; assert.deepEqual(source, before);
});

test('opt-in omits only old pixels and emits complete reference provenance without changing user text', () => {
  const source = freeze(snapshot([user('goal', 'old', [ref(1)], '사용자 원문 🌊\r\nkeep this exact'), assistant('reply', 'old'), user('latest-image', 'current', [ref(2)]), user('latest-text', 'current', undefined, 'Latest steer text')])), before = structuredClone(source);
  const result = projectMediaHistory(source, { policy, activeRunId: 'current' });
  assert.equal(Object.hasOwn(result.snapshot.messages[0]!, 'attachments'), false); assert.equal(result.snapshot.messages[0]!.content, before.messages[0]!.content);
  assert.deepEqual(result.snapshot.messages.slice(1), before.messages.slice(1)); assert.deepEqual(source, before);
  assert.deepEqual(result.provenance, [{ version: 1, sessionId: 'session', runId: 'old', messageId: 'goal', sourceOrdinal: 1, sourceContentSha256: hash(before.messages[0]!.content), attachments: [ref(1)], pixels: 'unavailable-in-this-request', reason: 'host-reference-only-history', summarized: false, currentFileEvidence: false }]);
  const value = notice(result); assert.equal(result.requiredNotice?.role, 'assistant'); assert.equal(value.permissionOrInstruction, false); assert.equal(value.summarized, false); assert.equal(value.currentFileEvidence, false); assert.match(value.pixels as string, /pixels unavailable in this request/u);
  assert.equal(JSON.stringify(result.requiredNotice).includes(image.data), false); assert.deepEqual(result.requiredTextMessageIds, ['goal', 'latest-image', 'latest-text']);
  assert.equal(result.diagnostics.imageTokens, null); assert.equal(result.diagnostics.summarized, false); assert.equal(result.diagnostics.activeCutoffCreated, false);
});

test('five exact repeated image messages produce one frame and one resolved blob, with four explicit omissions', () => {
  const source = snapshot(Array.from({ length: 5 }, (_, index) => user('user-' + index, 'run-' + index, [ref()]))), result = projectMediaHistory(source, { policy, activeRunId: 'run-4' });
  assert.equal(result.diagnostics.sourceImageOccurrences, 5); assert.equal(result.diagnostics.retainedImageOccurrences, 1); assert.equal(result.diagnostics.omittedImageOccurrences, 4); assert.equal(result.diagnostics.uniqueRetainedImages, 1);
  assert.ok(result.provenance.every(value => value.reason === 'older-exact-reference' && value.attachments[0]!.id === ref().id));
  const request: TurnRequest = { sessionId: 'session', runId: 'run-4', turnIndex: 0, modelId: 'fixture', messages: [result.requiredNotice!, ...messages(result.snapshot)], tools: [], resolvedImages: [{ attachment: ref(), data: image.data }] };
  assert.equal(providerImages(request, true).size, 1);
  assert.throws(() => providerImages({ ...request, messages: messages(source) }, true), errorCode('PROVIDER_LIMIT_EXCEEDED'));
  assert.deepEqual(result.snapshot.messages.map(message => message.id), source.messages.map(message => message.id)); assert.equal(source.messages.filter(message => message.attachments?.length).length, 5);
});

test('latest historical image remains mandatory when the current Run has only text', () => {
  const result = projectMediaHistory(snapshot([user('goal', 'old', [ref(1)]), user('last-image', 'previous', [ref(2)]), user('current-goal', 'current')]), { policy, activeRunId: 'current' });
  assert.deepEqual(result.snapshot.messages[1]!.attachments, [ref(2)]); assert.equal(result.snapshot.messages[0]!.attachments, undefined);
  assert.deepEqual(result.requiredTextMessageIds, ['goal', 'current-goal']); assert.equal(result.diagnostics.retainedImageOccurrences, 1);
});

test('required pixel frame overflow fails rather than evicting latest pixels', () => {
  const source = freeze(snapshot([user('old', 'old', [ref(1), ref(2)]), user('latest', 'current', [ref(3), ref(4), ref(5)])])), before = structuredClone(source);
  assert.throws(() => projectMediaHistory(source, { policy: { ...policy, maxImageOccurrences: 2 } }), errorCode('IMAGE_HISTORY_REQUIRED_LIMIT')); assert.deepEqual(source, before);
  assert.equal(projectMediaHistory(source, { policy: { ...policy, maxImageOccurrences: 3 } }).diagnostics.retainedImageOccurrences, 3);
});

test('required decoded image byte caps can tighten independently of frame counts', () => {
  const source = snapshot([user('old', 'old', [ref()]), user('latest', 'current', [ref(), ref(2)])]);
  assert.throws(() => projectMediaHistory(source, { policy: { ...policy, maxImageBytes: ref().bytes } }), errorCode('IMAGE_HISTORY_REQUIRED_LIMIT'));
  assert.throws(() => projectMediaHistory(source, { policy: { ...policy, maxImageOccurrences: 1 } }), errorCode('IMAGE_HISTORY_REQUIRED_LIMIT'));
  assert.equal(projectMediaHistory(source, { policy: { ...policy, maxImageBytes: ref().bytes * 2 } }).diagnostics.retainedImageBytes, ref().bytes * 2);
});

test('metadata sidecar plus notice have an exact byte boundary and a conservative text estimate', () => {
  const source = snapshot([user('old', 'old', [ref()]), user('latest', 'current', [ref(2)])]); const result = projectMediaHistory(source, { policy });
  assert.ok(result.diagnostics.metadataBytes > result.diagnostics.noticeBytes); assert.equal(result.diagnostics.noticeBytes, Buffer.byteLength(JSON.stringify(result.requiredNotice)) + 1);
  assert.equal(result.diagnostics.metadataTokenEstimate.tokens, result.diagnostics.noticeBytes); assert.equal(result.diagnostics.metadataTokenEstimate.source, 'utf8-byte-upper-bound');
  const exact = projectMediaHistory(source, { policy: { ...policy, maxMetadataBytes: result.diagnostics.metadataBytes } });
  assert.equal(exact.diagnostics.metadataBytes, result.diagnostics.metadataBytes); assert.deepEqual(exact.provenance, result.provenance); assert.deepEqual(exact.snapshot, result.snapshot);
  assert.throws(() => projectMediaHistory(source, { policy: { ...policy, maxMetadataBytes: result.diagnostics.metadataBytes - 1 } }), errorCode('IMAGE_HISTORY_METADATA_LIMIT'));
});

test('large omission lists fail metadata caps with no partial projection or raw-history mutation', () => {
  const source = freeze(snapshot(Array.from({ length: 64 }, (_, index) => user('u-' + index, 'run-' + index, [ref()])))), before = structuredClone(source);
  assert.throws(() => projectMediaHistory(source, { policy }), errorCode('IMAGE_HISTORY_METADATA_LIMIT')); assert.deepEqual(source, before);
});

test('unsupported or broadened host policies are rejected; policy accessors are never evaluated', () => {
  const source = snapshot([user('latest', 'current', [ref()])]);
  for (const value of [null, true, {}, { ...policy, kind: 'automatic' }, { ...policy, version: 2 }, { ...policy, maxImageOccurrences: 5 }, { ...policy, maxImageBytes: 1_048_577 }, { ...policy, maxMetadataBytes: 16_385 }, { ...policy, maxImageOccurrences: 0 }, { ...policy, maxMetadataBytes: 1.5 }, { ...policy, maxImageBytes: undefined }, { ...policy, autoSummary: true }]) assert.throws(() => projectMediaHistory(source, { policy: value as MediaHistoryPolicy }), errorCode('IMAGE_HISTORY_INVALID_POLICY'));
  let invoked = 0; const getter = { ...policy }; Object.defineProperty(getter, 'maxImageBytes', { enumerable: true, get() { invoked++; return 1; } });
  assert.throws(() => projectMediaHistory(source, { policy: getter }), errorCode('IMAGE_HISTORY_INVALID_POLICY')); assert.equal(invoked, 0);
});

test('historical exact-reference conflict is not hidden by omitting old pixels', () => {
  for (const changed of [{ ...ref(), sha256: 'f'.repeat(64) }, { ...ref(), bytes: ref().bytes + 1 }, { ...ref(), mimeType: 'image/jpeg' as const }]) assert.throws(() => projectMediaHistory(snapshot([user('old', 'old', [ref()]), user('latest', 'current', [changed])]), { policy }), errorCode('IMAGE_HISTORY_REFERENCE_CONFLICT'));
});

test('old malformed references, raw data, URLs and non-user attachments cannot become provenance', () => {
  for (const invalid of [{ ...ref(), sha256: 'bad' }, { ...ref(), data: image.data }, { ...ref(), url: 'https://fixture.invalid/image.png' }, { ...ref(), path: '/private/image.png' }, { ...ref(), kind: 'audio' }]) assert.throws(() => projectMediaHistory(snapshot([user('old', 'old', [invalid as InputImageAttachment]), user('latest', 'current', [ref(2)])]), { policy }), errorCode('IMAGE_HISTORY_INVALID_REFERENCE'));
  const nonUser = assistant('bad-image', 'old'); nonUser.attachments = [ref()]; assert.throws(() => projectMediaHistory(snapshot([nonUser, user('latest', 'current', [ref(2)])]), { policy }), errorCode('IMAGE_HISTORY_INVALID_REFERENCE'));
});

test('foreign-session and duplicate message identities fail before derived metadata', () => {
  const foreign = { ...user('old', 'old', [ref()]), sessionId: 'other-session' };
  assert.throws(() => projectMediaHistory(snapshot([foreign]), { policy }), errorCode('IMAGE_HISTORY_INVALID_SOURCE'));
  assert.throws(() => projectMediaHistory(snapshot([user('duplicate', 'a'), user('duplicate', 'b')]), { policy }), errorCode('IMAGE_HISTORY_INVALID_SOURCE'));
});

test('initial goal, current initial goal and latest user text anchors are returned intact', () => {
  const source = snapshot([user('original', 'past', [ref()]), user('current-original', 'current'), user('steer', 'current'), user('latest', 'current', [ref(2)])]);
  const result = projectMediaHistory(source, { policy, activeRunId: 'current' });
  assert.deepEqual(result.requiredTextMessageIds, ['original', 'current-original', 'latest']);
  assert.deepEqual(result.snapshot.messages.map(message => message.content), source.messages.map(message => message.content));
});

test('complete calls/results and opaque reasoning replay remain byte-for-byte while incomplete pairs are not anchors', () => {
  const call = { ...assistant('calls', 'current', 'Reading files'), toolCalls: [{ id: 'a', name: 'read_file', input: { path: 'a.txt' } }, { id: 'b', name: 'read_file', input: { path: 'b.txt' } }], providerReplay: { providerId: 'fixture', modelId: 'fixture', protocol: 'fixture-native', version: 1, items: [{ type: 'reasoning', encrypted_content: 'opaque fixture', summary: [{ type: 'summary_text', text: 'Public summary' }] }] } };
  const results = ['a', 'b'].map(id => ({ ...user('result-' + id, 'current', undefined, 'Original tool result ' + id), role: 'tool' as const, toolCallId: id }));
  const dangling = { ...assistant('dangling', 'current'), toolCalls: [{ id: 'missing', name: 'read_file', input: { path: 'missing.txt' } }] };
  const source = freeze(snapshot([user('old-image', 'old', [ref()]), user('latest-image', 'current', [ref(2)]), call, ...results, dangling])), before = structuredClone(source);
  const result = projectMediaHistory(source, { policy, activeRunId: 'current' });
  assert.deepEqual(result.requiredExchangeMessageIds, ['calls', 'result-a', 'result-b']); assert.deepEqual(result.snapshot.messages.slice(2), before.messages.slice(2)); assert.deepEqual(source, before);
  assert.equal(result.requiredNotice!.content.includes('opaque fixture'), false); assert.equal(result.provenance.some(item => item.messageId === 'calls'), false);
});

test('known media-shaped opaque replay fails explicitly without modifying or interpreting encrypted strings', () => {
  const items: JsonObject[] = [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' }, { type: 'image_generation_call' }, { type: 'unknown', child: { media_type: 'image/png', data: 'fixture' } }, { type: 'input_audio' }];
  for (const item of items) {
    const message = { ...assistant('native', 'current'), providerReplay: { providerId: 'fixture', items: [item] } }, source = snapshot([message]);
    assert.throws(() => projectMediaHistory(source, { policy }), errorCode('IMAGE_HISTORY_REPLAY_MEDIA_UNSUPPORTED')); assert.deepEqual(source.messages[0], message);
  }
  const message = { ...assistant('native', 'current'), providerReplay: { providerId: 'fixture', items: [{ type: 'reasoning', encrypted_content: 'opaque string contains image_url and input_image words' }] } };
  assert.deepEqual(projectMediaHistory(snapshot([message]), { policy }).snapshot.messages[0], message);
});

test('oversized/deep opaque replay and message accessors are bounded and rejected', () => {
  let nested: Record<string, unknown> = {}; for (let index = 0; index < 40; index++) nested = { nested };
  const message = { ...assistant('native', 'current'), providerReplay: { providerId: 'fixture', items: [nested] } };
  assert.throws(() => projectMediaHistory(snapshot([message as Message]), { policy }), errorCode('IMAGE_HISTORY_REPLAY_LIMIT'));
  let invoked = 0; const getter = user('getter', 'current', [ref()]); Object.defineProperty(getter, 'attachments', { enumerable: true, get() { invoked++; return [ref()]; } });
  assert.throws(() => projectMediaHistory(snapshot([getter]), { policy }), errorCode('IMAGE_HISTORY_INVALID_SOURCE')); assert.equal(invoked, 0);
});

test('plain text and empty image lists create no false notice, and enabled policy does not drop messages', () => {
  const source = snapshot([user('goal', 'current', []), assistant('empty', 'current', ''), assistant('latest-complete', 'current')]);
  const result = projectMediaHistory(source, { policy, activeRunId: 'current' }); assert.deepEqual(result.snapshot, source); assert.equal(result.requiredNotice, null);
  assert.deepEqual(result.requiredExchangeMessageIds, ['latest-complete']); assert.equal(result.diagnostics.retainedImageOccurrences, 0); assert.equal(result.diagnostics.omittedImageOccurrences, 0);
});

test('source snapshot/message limits and cancellation fail without partial source mutation', () => {
  const source = freeze(snapshot([user('latest', 'current', [ref()])])), before = structuredClone(source); const controller = new AbortController(); controller.abort('private reason');
  assert.throws(() => projectMediaHistory(source, { policy }, controller.signal), errorCode('CANCELLED')); assert.deepEqual(source, before);
  const huge = snapshot(Array.from({ length: MEDIA_HISTORY_LIMITS.maxSourceMessages + 1 }, (_, index) => user('u-' + index, 'current'))); assert.throws(() => projectMediaHistory(huge, { policy }), errorCode('IMAGE_HISTORY_SOURCE_LIMIT'));
});

test('policy and source hashes are deterministic and bind old reference identities and exact source text', () => {
  const source = snapshot([user('old', 'old', [ref()]), user('latest', 'current', [ref(2)])]), first = projectMediaHistory(source, { policy });
  assert.deepEqual(projectMediaHistory(structuredClone(source), { policy }), first);
  const differentPolicy = projectMediaHistory(source, { policy: { ...policy, maxImageOccurrences: 2 } }); assert.notEqual(differentPolicy.diagnostics.policySha256, first.diagnostics.policySha256);
  source.messages[0]!.content += ' Changed constraint'; assert.notEqual(projectMediaHistory(source, { policy }).diagnostics.sourceSha256, first.diagnostics.sourceSha256);
});

test('mock Responses dispatch encodes only retained pixels while preserving exact old text and notice', async () => {
  const source = snapshot(Array.from({ length: 5 }, (_, index) => user('u-' + index, 'run-' + index, [ref()], 'Exact image request ' + index))), result = projectMediaHistory(source, { policy }); let body: Record<string, unknown> | undefined;
  const provider = new ResponsesProvider({ fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response('data: {"type":"response.created","response":{"id":"fixture","status":"in_progress"}}\n\ndata: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[]}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); } });
  const request: TurnRequest = { sessionId: 'session', runId: 'run-4', turnIndex: 0, modelId: 'fixture', messages: [result.requiredNotice!, ...messages(result.snapshot)], tools: [], resolvedImages: [{ attachment: ref(), data: image.data }] };
  for await (const _event of provider.streamTurn(request, new AbortController().signal)) { /* Drain the original local transport fixture. */ }
  assert.ok(body); const wire = JSON.stringify(body); assert.equal(wire.split('data:image/png;base64,').length - 1, 1);
  assert.ok(wire.includes('Exact image request 0')); assert.ok(wire.includes('pixels unavailable in this request')); assert.equal(source.messages.filter(message => message.attachments?.length).length, 5);
});
