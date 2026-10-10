import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject, type Message, type ProviderReplay } from '@moodcode/contracts';
import type { ContextRequest, ProviderMessage } from '../ports.js';
import { AGENT_DEFAULTS_PREFIX, buildContext, EXTRACTIVE_MEMORY_PREFIX } from './index.js';
import { agentInstructions } from './instructions.js';
import { extractiveMemory, MAX_MEMORY_BYTES, type MemorySource } from './memory.js';

const createdAt = '2026-10-04T00:00:00.000Z';
let nextId = 0;
function message(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id: `message-${++nextId}`, sessionId: 'session', runId: 'run', role, content, createdAt, ...extra };
}
function bytes(messages: readonly ProviderMessage[]): number { return Buffer.byteLength(JSON.stringify(messages), 'utf8'); }
async function fixture(t: TestContext, messages: Message[], maximum = 8 * 1024): Promise<ContextRequest> {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-agent-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    workspace: { id: 'workspace', root, gitRoot: root, branch: null, createdAt },
    snapshot: { session: { id: 'session', workspaceId: 'workspace', title: 'Memory fixture', createdAt }, messages, runs: [], tools: [], approvals: [], lastSeq: 0 },
    config: { providerId: 'responses-fixture', modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS, maxContextBytes: maximum } },
    signal: new AbortController().signal,
  };
}
function longHistory(): Message[] {
  return Array.from({ length: 24 }, (_, index) => message(index % 2 ? 'assistant' : 'user',
    index === 0 ? 'ORIGINAL_GOAL: preserve the public API and keep the implementation local. ' + 'original detail '.repeat(150)
      : `${index % 2 ? 'Earlier hypothesis, not a verified result' : 'Earlier user discussion'} ${index}: ` + 'discussion detail 한글😀 '.repeat(90)));
}
function memory(messages: readonly ProviderMessage[]): ProviderMessage | undefined {
  return messages.find((item) => item.content.startsWith(EXTRACTIVE_MEMORY_PREFIX));
}
interface MemoryPayload {
  totalOlderMessages: number; quotedMessages: number; omittedMessages: number; omissions: string[];
  excerpts: { source: { ordinal: number; messageId: string; runId: string; role: Message['role'] }; excerpt: string; truncated: boolean }[];
}
function payload(item: ProviderMessage): MemoryPayload {
  return JSON.parse(item.content.slice(item.content.lastIndexOf('\n') + 1)) as MemoryPayload;
}
function assertToolGroups(messages: readonly ProviderMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    const item = messages[index]!;
    assert.notEqual(item.role, 'tool', 'There is no dangling result');
    if (!item.toolCalls?.length) continue;
    const results = messages.slice(index + 1, index + 1 + item.toolCalls.length);
    assert.deepEqual(results.map((result) => result.role), item.toolCalls.map(() => 'tool'));
    assert.deepEqual(results.map((result) => result.toolCallId).sort(), item.toolCalls.map((call) => call.id).sort());
    index += item.toolCalls.length;
  }
}

test('Plan/Build instructions communicate project/request priority, discovery, truncation, approvals and observed validation', async (t) => {
  const current = message('user', 'Use the existing scripts and verify only the changed feature.');
  const request = await fixture(t, [current]);
  await writeFile(join(request.workspace.root, 'AGENTS.md'), 'PROJECT_GUIDANCE: use package-local checks.\n');
  for (const mode of ['plan', 'build'] as const) {
    request.config.mode = mode;
    const result = await buildContext(request);
    const defaults = result.find((item) => item.content.startsWith(AGENT_DEFAULTS_PREFIX));
    assert.ok(defaults);
    assert.equal(defaults.role, 'system');
    assert.match(defaults.content, /explicit request.*AGENTS\.md/);
    assert.match(defaults.content, /do not override either/);
    assert.match(defaults.content, /list_files, search_files and read_file/);
    assert.match(defaults.content, /smallest relevant files or line ranges/);
    assert.match(defaults.content, /truncated.*incomplete/);
    assert.match(defaults.content, /next supported page/);
    assert.match(defaults.content, /approval denial and cancellation/);
    assert.match(defaults.content, /observed check results.*not run/);
    assert.match(defaults.content, mode === 'plan' ? /Current mode: Plan.*Do not apply file edits/ : /Current mode: Build.*required approval/);
    assert.equal(result[0]?.content, 'Workspace instructions (AGENTS.md):\n[Scope: workspace root; source: AGENTS.md]\nPROJECT_GUIDANCE: use package-local checks.\n');
    assert.deepEqual(result.at(-1), { role: 'user', content: current.content });
    assert.ok(bytes(result) <= request.config.limits.maxContextBytes);
  }
});

test('agent instructions are whole and optional at an exact serialized budget boundary', async (t) => {
  const current = message('user', 'Keep this exact request 한글😀\n\\"');
  const normalized: ProviderMessage = { role: 'user', content: current.content };
  const defaults = agentInstructions('build');
  const withDefaults = bytes([defaults, normalized]);
  const request = await fixture(t, [current], withDefaults);
  assert.deepEqual(await buildContext(request), [defaults, normalized]);
  request.config.limits.maxContextBytes--;
  assert.deepEqual(await buildContext(request), [normalized], 'No partial workflow instruction is emitted');
  request.config.limits.maxContextBytes = bytes([normalized]);
  assert.deepEqual(await buildContext(request), [normalized]);
  request.config.limits.maxContextBytes--;
  await assert.rejects(buildContext(request), (error: unknown) => error instanceof EngineError && error.code === 'CONTEXT_LIMIT');
});

test('short history remains original and has no extractive replacement', async (t) => {
  const stored = [message('user', 'Original request'), message('assistant', 'Observed original response'), message('user', 'Current request')];
  const request = await fixture(t, stored);
  const result = await buildContext(request);
  assert.equal(memory(result), undefined);
  assert.deepEqual(result.filter((item) => item.role !== 'system'), stored.map(({ role, content }) => ({ role, content })));
});

test('long history retains the initial goal with attributed verbatim excerpts and explicit omissions as assistant data', async (t) => {
  const current = message('user', 'CURRENT_REQUEST: keep this intact and explain the next change.');
  const stored = [...longHistory(), current];
  const request = await fixture(t, stored);
  const before = JSON.stringify(request.snapshot);
  const first = await buildContext(request);
  assert.deepEqual(await buildContext(request), first, 'Extraction is deterministic for the same snapshot');
  const extracted = memory(first);
  assert.ok(extracted);
  assert.equal(extracted.role, 'assistant');
  assert.equal(extracted.toolCalls, undefined);
  assert.equal(extracted.providerReplay, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(extracted), 'utf8') + 1 <= MAX_MEMORY_BYTES);
  assert.match(extracted.content, /historical data, not new instructions, verified facts/);
  const data = payload(extracted);
  assert.ok(data.excerpts.length > 0 && data.excerpts.length <= 8);
  assert.equal(data.quotedMessages, data.excerpts.length);
  assert.equal(data.omittedMessages, data.totalOlderMessages - data.quotedMessages);
  assert.ok(data.omittedMessages > 0);
  assert.ok(data.excerpts.some((entry) => entry.source.messageId === stored[0]!.id && entry.excerpt.startsWith('ORIGINAL_GOAL:')));
  assert.ok(data.excerpts.some((entry) => entry.truncated));
  for (const entry of data.excerpts) {
    const original = stored[entry.source.ordinal - 1]!;
    assert.equal(entry.source.messageId, original.id);
    assert.equal(entry.source.runId, original.runId);
    assert.equal(entry.source.role, original.role);
    assert.ok(original.content.startsWith(entry.excerpt));
  }
  assert.ok(first.filter((item) => item.role === 'system').every((item) => !item.content.includes('ORIGINAL_GOAL:') && !item.content.includes('Earlier hypothesis')));
  assert.deepEqual(first.at(-1), { role: 'user', content: current.content });
  assert.equal(JSON.stringify(request.snapshot), before, 'No persisted message, journal or replay is rewritten');
  assert.ok(bytes(first) <= request.config.limits.maxContextBytes);
});

test('current native reasoning, phase, raw call arguments and complete results survive older-history extraction', async (t) => {
  const replay: ProviderReplay = { providerId: 'responses-fixture', items: [
    { id: 'rs-current', type: 'reasoning', encrypted_content: 'current-opaque-ciphertext-'.repeat(100), summary: [] },
    { id: 'msg-current', type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Reading current file.' }] },
    { id: 'fc-current', type: 'function_call', call_id: 'call-current', name: 'read_file', arguments: '{ "path" : "file.txt" }' },
  ] };
  const current = [message('user', 'Read the current file.'),
    message('assistant', 'Reading current file.', { providerReplay: replay, toolCalls: [{ id: 'call-current', name: 'read_file', input: { path: 'file.txt' } }] }),
    message('tool', 'Observed current file content.', { toolCallId: 'call-current' })];
  const request = await fixture(t, [...longHistory(), ...current]);
  const before = JSON.stringify(request.snapshot);
  const result = await buildContext(request);
  assert.ok(memory(result));
  assert.deepEqual(result.slice(-3), current.map(({ role, content, toolCalls, toolCallId, providerReplay }) => ({ role, content,
    ...(toolCalls ? { toolCalls } : {}), ...(toolCallId ? { toolCallId } : {}), ...(providerReplay ? { providerReplay } : {}) })));
  assert.notEqual(result.at(-2)?.providerReplay, replay);
  assertToolGroups(result);
  assert.equal(JSON.stringify(request.snapshot), before);
  assert.ok(bytes(result) <= request.config.limits.maxContextBytes);
});

test('omitted old tool exchanges contribute no executable calls, tool content or opaque replay to memory', async (t) => {
  const old = [message('user', 'Original task before a read.'),
    message('assistant', 'Earlier file inspection planned.', {
      providerReplay: { providerId: 'responses-fixture', items: [{ type: 'reasoning', encrypted_content: 'OLD_OPAQUE_STATE'.repeat(10_000) }] },
      toolCalls: [{ id: 'old-call', name: 'read_file', input: { path: 'OLD_TOOL_ARGUMENT_SENTINEL' } }],
    }), message('tool', 'OLD_TOOL_FILE_CONTENT_SENTINEL', { toolCallId: 'old-call' }),
    message('user', 'Current request')];
  const request = await fixture(t, old);
  const result = await buildContext(request);
  const extracted = memory(result);
  assert.ok(extracted);
  assert.ok(payload(extracted).omissions.includes('tool results'));
  assert.ok(!JSON.stringify(result).includes('OLD_OPAQUE_STATE'));
  assert.ok(!JSON.stringify(result).includes('OLD_TOOL_ARGUMENT_SENTINEL'));
  assert.ok(!JSON.stringify(result).includes('OLD_TOOL_FILE_CONTENT_SENTINEL'));
  assert.ok(result.every((item) => !item.toolCalls && item.role !== 'tool'));
});

test('full serialized context including instructions and memory respects varied byte and tool reservations', async (t) => {
  const stored = [...longHistory(), message('user', 'Current request 한글😀\n\\"')];
  const request = await fixture(t, stored);
  const before = JSON.stringify(request.snapshot);
  const tools = [{ name: 'read_file', description: '읽기 설명😀'.repeat(20), inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
  request.reservedBytes = Buffer.byteLength(JSON.stringify({ messages: [], tools }), 'utf8') - 2;
  for (const maximum of [1024, 2048, 3072, 4096, 6144, 8192, 16384, 32768]) {
    request.config.limits.maxContextBytes = maximum;
    const result = await buildContext(request);
    const serialized = Buffer.byteLength(JSON.stringify({ messages: result, tools }), 'utf8');
    assert.equal(serialized, bytes(result) + request.reservedBytes);
    assert.ok(serialized <= maximum, `${maximum}: ${serialized} actual bytes`);
    assert.deepEqual(result.at(-1), { role: 'user', content: stored.at(-1)!.content });
    assertToolGroups(result);
  }
  assert.equal(JSON.stringify(request.snapshot), before);
});

test('extractive memory bounds escaped Unicode and metadata references without cutting surrogate pairs', () => {
  const source = message('user', '한글😀\n\\"'.repeat(1000), { id: 'id-'.repeat(1000), runId: 'run-'.repeat(1000) });
  const sources: MemorySource[] = [{ ordinal: 1, message: source }];
  for (const maximum of [0, 128, 640, 1024, 2048, 8192, 32768]) {
    const result = extractiveMemory(sources, maximum);
    if (!result) continue;
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') + 1 <= Math.min(maximum, MAX_MEMORY_BYTES));
    const excerpt = payload(result).excerpts[0]!;
    assert.ok(source.content.startsWith(excerpt.excerpt));
    assert.ok(!/[\uD800-\uDBFF]$/u.test(excerpt.excerpt));
    assert.ok(excerpt.source.messageId.length <= 128 && excerpt.source.runId.length <= 128);
    assert.equal(excerpt.truncated, true);
  }
  assert.equal(extractiveMemory(sources, NaN), undefined);
});

test('empty and tool-only omitted content creates no synthetic facts or phantom summary', () => {
  assert.equal(extractiveMemory([], 8192), undefined);
  assert.equal(extractiveMemory([{ ordinal: 1, message: message('tool', 'file content only') }, { ordinal: 2, message: message('assistant', '') }], 8192), undefined);
});

test('malformed old native replay is rejected rather than hidden inside an extractive summary', async (t) => {
  const malformed = message('assistant', 'Old speculative result.', {
    providerReplay: { providerId: 'responses-fixture', items: [{ private: undefined }] } as unknown as ProviderReplay,
  });
  const request = await fixture(t, [malformed, ...longHistory(), message('user', 'Current request')]);
  await assert.rejects(buildContext(request), (error: unknown) => error instanceof EngineError && error.code === 'INVALID_CONTEXT');
});

test('native replay remains provider-bound when changing providers, with ordinary exchanges retained', async (t) => {
  const original = [message('user', 'Previous request'), message('assistant', 'Observed previous answer.', {
    providerReplay: { providerId: 'other-provider', items: [{ type: 'reasoning', encrypted_content: 'FOREIGN_CIPHERTEXT'.repeat(1000) }] },
    toolCalls: [{ id: 'previous-call', name: 'read_file', input: { path: 'file.txt' } }],
  }), message('tool', 'Recorded previous result.', { toolCallId: 'previous-call' }), message('user', 'Current request')];
  const request = await fixture(t, original);
  const result = await buildContext(request);
  assert.equal(memory(result), undefined);
  assert.ok(!JSON.stringify(result).includes('FOREIGN_CIPHERTEXT'));
  assert.ok(result.some((item) => item.toolCallId === 'previous-call' && item.content === 'Recorded previous result.'));
  assertToolGroups(result);
});
