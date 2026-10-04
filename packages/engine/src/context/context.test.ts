import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type JsonObject, type Message, type ProviderReplay, type ProviderToolCall, type SessionSnapshot, type Workspace } from '@moodcode/contracts';
import type { ContextRequest, ProviderMessage, ProviderTool } from '../ports.js';
import { buildContext } from './index.js';

const createdAt = '2026-10-04T00:00:00.000Z';

function history(role: Message['role'], content: string, options: Partial<Message> = {}): Message {
  return { id: `${role}-${content.slice(0, 20)}`, sessionId: 'session', runId: 'run', role, content, createdAt, ...options };
}

function call(id: string, input: ProviderToolCall['input'] = { path: 'src/main.ts' }): ProviderToolCall {
  return { id, name: 'read_file', input };
}

function providerMessage(message: Message): ProviderMessage {
  const result: ProviderMessage = { role: message.role, content: message.content };
  if (message.toolCalls !== undefined) result.toolCalls = message.toolCalls;
  if (message.toolCallId !== undefined) result.toolCallId = message.toolCallId;
  if (message.providerReplay !== undefined) result.providerReplay = message.providerReplay;
  return result;
}

function jsonBytes(messages: readonly ProviderMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

async function fixture(t: TestContext, messages: Message[], maxContextBytes = DEFAULT_LIMITS.maxContextBytes): Promise<ContextRequest> {
  const root = await mkdtemp(join(tmpdir(), 'moodcode-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace: Workspace = { id: 'workspace', root, gitRoot: root, branch: null, createdAt };
  const snapshot: SessionSnapshot = {
    session: { id: 'session', workspaceId: workspace.id, title: 'Context fixture', createdAt },
    runs: [], messages, tools: [], approvals: [], lastSeq: 0,
  };
  return {
    workspace, snapshot,
    config: { providerId: 'scripted', modelId: 'local', mode: 'plan', limits: { ...DEFAULT_LIMITS, maxContextBytes } },
    signal: new AbortController().signal,
  };
}

function assertCompleteToolGroups(messages: readonly ProviderMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    assert.notEqual(message.role, 'tool', 'Every tool result must be consumed by its immediately preceding assistant group');
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    const expected = message.toolCalls.map((tool) => tool.id).sort();
    assert.equal(new Set(expected).size, expected.length, 'A tool-call group must have unique IDs');
    const results = messages.slice(index + 1, index + 1 + expected.length);
    assert.equal(results.length, expected.length, 'Every assistant call must have a result');
    assert.ok(results.every((result) => result.role === 'tool'), 'Tool results must be contiguous after their assistant call');
    assert.deepEqual(results.map((result) => result.toolCallId).sort(), expected);
    index += expected.length;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('buildContext preserves stored user and assistant content in history order', async (t) => {
  const messages = [
    history('user', '처음 요청\nwith a newline'),
    history('assistant', '첫 응답 😀'),
    history('user', 'A follow-up request'),
    history('assistant', 'Follow-up answer'),
  ];
  const request = await fixture(t, messages);
  assert.deepEqual(await buildContext(request), messages.map(providerMessage));
});

test('buildContext includes root AGENTS.md before history and ignores nested instruction files', async (t) => {
  const request = await fixture(t, [history('user', 'Implement the feature')]);
  await writeFile(join(request.workspace.root, 'AGENTS.md'), 'Root guidance: use the local test fixtures.\n');
  await mkdir(join(request.workspace.root, 'src'));
  await writeFile(join(request.workspace.root, 'src', 'AGENTS.md'), 'Nested guidance must not enter root context.');

  const messages: ProviderMessage[] = await buildContext(request);
  assert.equal(messages[0]?.role, 'system');
  assert.ok(messages[0]?.content.includes('Root guidance: use the local test fixtures.'));
  assert.ok(messages.every((message) => !message.content.includes('Nested guidance must not enter root context.')));
  assert.deepEqual(messages.filter((message) => message.role !== 'system'), [{ role: 'user', content: 'Implement the feature' }]);
});

test('buildContext bounds project instructions even when AGENTS.md is much larger than 32 KiB', async (t) => {
  const request = await fixture(t, [history('user', 'Keep this request')]);
  await writeFile(join(request.workspace.root, 'AGENTS.md'), '지침 😀\n'.repeat(20_000) + 'UNBOUNDED_INSTRUCTION_TAIL');

  const messages: ProviderMessage[] = await buildContext(request);
  const instructions = messages.filter((message) => message.role === 'system');
  assert.ok(instructions.length > 0);
  assert.ok(instructions.some((message) => message.content.includes('지침')));
  assert.ok(instructions.every((message) => !message.content.includes('UNBOUNDED_INSTRUCTION_TAIL')));
  assert.ok(instructions.reduce((bytes, message) => bytes + Buffer.byteLength(message.content, 'utf8'), 0) <= 32 * 1024,
    'Project instruction content, including any wrapper, must stay within 32 KiB');
  assert.ok(jsonBytes(messages) <= request.config.limits.maxContextBytes);
  assert.ok(messages.some((message) => message.role === 'user' && message.content === 'Keep this request'));
});

test('buildContext keeps the latest user request when optional instructions exceed the total budget', async (t) => {
  const request = await fixture(t, [history('user', 'Required request 😀')], 256);
  await writeFile(join(request.workspace.root, 'AGENTS.md'), 'Long optional instruction.\n'.repeat(4_000));

  const messages: ProviderMessage[] = await buildContext(request);
  assert.ok(jsonBytes(messages) <= 256);
  assert.ok(messages.some((message) => message.role === 'user' && message.content === 'Required request 😀'));
});

test('buildContext treats a missing AGENTS.md as a normal workspace', async (t) => {
  const request = await fixture(t, [history('user', 'No project instruction file')]);
  assert.deepEqual(await buildContext(request), [{ role: 'user', content: 'No project instruction file' }]);
});

test('buildContext never imports AGENTS.md through a symlink outside the workspace', async (t) => {
  const request = await fixture(t, [history('user', 'Use only workspace instructions')]);
  const externalRoot = await mkdtemp(join(tmpdir(), 'moodcode-context-external-'));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const externalFile = join(externalRoot, 'AGENTS.md');
  await writeFile(externalFile, 'EXTERNAL_INSTRUCTION_MUST_NOT_BE_READ');
  await symlink(externalFile, join(request.workspace.root, 'AGENTS.md'));

  try {
    const messages: ProviderMessage[] = await buildContext(request);
    assert.ok(messages.every((message) => !message.content.includes('EXTERNAL_INSTRUCTION_MUST_NOT_BE_READ')));
    assert.ok(messages.some((message) => message.role === 'user' && message.content === 'Use only workspace instructions'));
  } catch (error) {
    assert.ok(error instanceof EngineError, 'A rejected instruction path must use the engine error contract');
    assert.match(error.code, /PATH|WORKSPACE|CONTEXT|SYMLINK/);
    assert.ok(!error.message.includes('EXTERNAL_INSTRUCTION_MUST_NOT_BE_READ'));
  }
});

test('buildContext preserves complete assistant tool calls and their contiguous results', async (t) => {
  const messages = [
    history('user', 'Read both files'),
    history('assistant', 'Reading the files', { toolCalls: [call('call-a'), call('call-b', { path: 'src/other.ts' })] }),
    history('tool', 'The second file', { toolCallId: 'call-b' }),
    history('tool', 'The first file', { toolCallId: 'call-a' }),
    history('assistant', 'Both files are available'),
  ];
  const request = await fixture(t, messages);
  const result: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(result, messages.map(providerMessage));
  assertCompleteToolGroups(result);
});

test('buildContext drops orphan results and strips unresolved tool calls while preserving assistant text', async (t) => {
  const request = await fixture(t, [
    history('tool', 'Orphan before history', { toolCallId: 'unknown-before' }),
    history('user', 'Current request'),
    history('assistant', 'Partial assistant explanation', { toolCalls: [call('pending-a'), call('pending-b')] }),
    history('tool', 'Only one call completed', { toolCallId: 'pending-a' }),
    history('assistant', '', { toolCalls: [call('empty-pending')] }),
    history('tool', 'Orphan after empty assistant', { toolCallId: 'unknown-after' }),
  ]);
  const messages: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(messages, [
    { role: 'user', content: 'Current request' },
    { role: 'assistant', content: 'Partial assistant explanation' },
  ]);
  assertCompleteToolGroups(messages);
});

test('buildContext does not pair a tool result across an intervening user message', async (t) => {
  const request = await fixture(t, [
    history('user', 'Older request'),
    history('assistant', 'Interrupted tool call', { toolCalls: [call('interrupted')] }),
    history('user', 'New request'),
    history('tool', 'Late stale result', { toolCallId: 'interrupted' }),
  ]);
  const messages: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(messages, [
    { role: 'user', content: 'Older request' },
    { role: 'assistant', content: 'Interrupted tool call' },
    { role: 'user', content: 'New request' },
  ]);
  assertCompleteToolGroups(messages);
});

test('buildContext does not pair an adjacent result from another run even when its call ID is reused', async (t) => {
  const request = await fixture(t, [
    history('user', 'Previous run request', { runId: 'previous-run' }),
    history('assistant', 'Previous run explanation', { runId: 'previous-run', toolCalls: [call('reused-call')] }),
    history('tool', 'Foreign run result', { runId: 'different-run', toolCallId: 'reused-call' }),
    history('user', 'Current run request', { runId: 'current-run' }),
  ]);
  const messages: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(messages, [
    { role: 'user', content: 'Previous run request' },
    { role: 'assistant', content: 'Previous run explanation' },
    { role: 'user', content: 'Current run request' },
  ]);
  assertCompleteToolGroups(messages);
});

test('buildContext omits history messages that belong to a foreign session', async (t) => {
  const request = await fixture(t, [
    history('user', 'Own session request'),
    history('user', 'FOREIGN_SESSION_USER', { sessionId: 'foreign-session' }),
    history('assistant', 'FOREIGN_SESSION_ASSISTANT', { sessionId: 'foreign-session', toolCalls: [call('foreign-call')] }),
    history('tool', 'FOREIGN_SESSION_RESULT', { sessionId: 'foreign-session', toolCallId: 'foreign-call' }),
  ]);
  const messages: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(messages, [{ role: 'user', content: 'Own session request' }]);
  assertCompleteToolGroups(messages);
});

test('buildContext handles duplicate results safely without duplicating a provider tool result', async (t) => {
  const request = await fixture(t, [
    history('user', 'Request before duplicated result'),
    history('assistant', 'Duplicated result explanation', { toolCalls: [call('duplicate')] }),
    history('tool', 'First stored result', { id: 'result-one', toolCallId: 'duplicate' }),
    history('tool', 'Duplicated stored result', { id: 'result-two', toolCallId: 'duplicate' }),
    history('user', 'Latest request after duplicated result'),
  ]);
  const messages: ProviderMessage[] = await buildContext(request);
  assert.ok(messages.some((message) => message.role === 'assistant' && message.content === 'Duplicated result explanation'));
  assert.ok(messages.some((message) => message.role === 'user' && message.content === 'Latest request after duplicated result'));
  assert.ok(messages.filter((message) => message.role === 'tool' && message.toolCallId === 'duplicate').length <= 1);
  assertCompleteToolGroups(messages);
});

test('buildContext preserves a completed current-request group when an unrelated orphan result follows it', async (t) => {
  const completed = [
    history('user', 'Current request with an executed call'),
    history('assistant', 'Executed call explanation', { toolCalls: [call('executed-before-orphan')] }),
    history('tool', 'Valid executed result', { toolCallId: 'executed-before-orphan' }),
  ];
  const request = await fixture(t, [
    ...completed,
    history('tool', 'Unrelated trailing orphan result', { toolCallId: 'unrelated-orphan' }),
  ]);
  const messages: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(messages, completed.map(providerMessage));
  assertCompleteToolGroups(messages);
});

test('buildContext preserves earlier complete groups independently of a later malformed group', async (t) => {
  const complete = [
    history('assistant', 'Completed group', { toolCalls: [call('complete')] }),
    history('tool', 'Completed result', { toolCallId: 'complete' }),
  ];
  const request = await fixture(t, [
    history('user', 'Start request'),
    ...complete,
    history('assistant', 'Incomplete group', { toolCalls: [call('missing'), call('present')] }),
    history('tool', 'One result', { toolCallId: 'present' }),
    history('tool', 'Unexpected result', { toolCallId: 'unrelated' }),
    history('user', 'Follow-up request'),
  ]);
  const messages: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(messages, [
    { role: 'user', content: 'Start request' },
    ...complete.map(providerMessage),
    { role: 'assistant', content: 'Incomplete group' },
    { role: 'user', content: 'Follow-up request' },
  ]);
  assertCompleteToolGroups(messages);
});

test('buildContext retains the latest user and a complete trailing group when trimming older history', async (t) => {
  const latest = history('user', 'Latest request');
  const trailing = [
    history('assistant', 'Read the requested file', { toolCalls: [call('trailing')] }),
    history('tool', 'The file contents', { toolCallId: 'trailing' }),
  ];
  const expected = [latest, ...trailing].map(providerMessage);
  const request = await fixture(t, [
    history('user', 'Old large message '.repeat(1_000)),
    history('assistant', 'Old large answer '.repeat(1_000)),
    latest, ...trailing,
  ], jsonBytes(expected));

  const messages: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(messages, expected);
  assert.ok(jsonBytes(messages) <= request.config.limits.maxContextBytes);
  assertCompleteToolGroups(messages);
});

test('buildContext drops an oversized complete group as a unit without truncating tool metadata', async (t) => {
  const latest = history('user', 'Keep latest request');
  const request = await fixture(t, [
    history('user', 'Earlier request'),
    history('assistant', 'Oversized grouped assistant', { toolCalls: [call('large', { text: '😀\\\"\n'.repeat(2_000) })] }),
    history('tool', 'Oversized tool result '.repeat(300), { toolCallId: 'large' }),
    latest,
  ], jsonBytes([providerMessage(latest)]) + 32);

  const messages: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(messages, [providerMessage(latest)]);
  assert.ok(jsonBytes(messages) <= request.config.limits.maxContextBytes);
  assertCompleteToolGroups(messages);
});

test('buildContext measures UTF-8 JSON bytes including escaped content and tool input metadata', async (t) => {
  const latest = history('user', '한글 😀\n\\\" required prompt');
  const group = [
    history('assistant', '도구 호출 😀', { toolCalls: [call('unicode', { query: '한글 😀\n\\\"'.repeat(100), settings: { enabled: true } })] }),
    history('tool', '결과 😀\n\\\"'.repeat(100), { toolCallId: 'unicode' }),
  ];
  const required = [providerMessage(latest)];
  const target = [...group, latest].map(providerMessage);
  const exactBytes = jsonBytes(target);
  assert.ok(exactBytes > JSON.stringify(target).length, 'Fixture must expose UTF-8 byte/character differences');
  const request = await fixture(t, [...group, latest], exactBytes);

  const exact: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(exact, target);
  assert.equal(jsonBytes(exact), exactBytes);
  assertCompleteToolGroups(exact);

  request.config.limits.maxContextBytes = exactBytes - 1;
  const trimmed: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(trimmed, required, 'An indivisible tool group must be removed when its full JSON representation does not fit');
  assert.ok(jsonBytes(trimmed) <= exactBytes - 1);
  assertCompleteToolGroups(trimmed);
});

test('buildContext rejects a budget that cannot hold the latest user message', async (t) => {
  const latest = history('user', 'Required 😀 request '.repeat(40));
  const requiredBytes = jsonBytes([providerMessage(latest)]);
  const request = await fixture(t, [history('user', 'Earlier small request'), latest], requiredBytes - 1);
  await assert.rejects(buildContext(request), (error: unknown) => error instanceof EngineError && error.code === 'CONTEXT_LIMIT');
});

test('buildContext rejects an overflowing current-request tool group rather than losing executed results', async (t) => {
  const messages = [
    history('user', 'Current request'),
    history('assistant', 'Already executed this call', { toolCalls: [call('executed', { query: '😀'.repeat(200) })] }),
    history('tool', 'Executed tool output '.repeat(100), { toolCallId: 'executed' }),
  ];
  const request = await fixture(t, messages, jsonBytes(messages.map(providerMessage)) - 1);
  await assert.rejects(buildContext(request), (error: unknown) => error instanceof EngineError && error.code === 'CONTEXT_LIMIT');
});

test('buildContext treats omitted, undefined, and zero reservedBytes identically without changing config', async (t) => {
  const messages = [history('user', 'Unreserved request 😀'), history('assistant', 'Unreserved response')];
  const request = await fixture(t, messages);
  const configBefore = JSON.stringify(request.config);
  deepFreeze(request.config);

  const omitted: ProviderMessage[] = await buildContext(request);
  request.reservedBytes = 0;
  const zero: ProviderMessage[] = await buildContext(request);
  request.reservedBytes = undefined;
  const explicitUndefined: ProviderMessage[] = await buildContext(request);

  assert.deepEqual(omitted, messages.map(providerMessage));
  assert.deepEqual(zero, omitted);
  assert.deepEqual(explicitUndefined, omitted);
  assert.equal(JSON.stringify(request.config), configBefore);
});

test('buildContext reserves UTF-8 tool schema and envelope bytes so the complete context object fits', async (t) => {
  const messages = [
    history('user', 'Earlier request '.repeat(200)),
    history('assistant', 'Earlier response '.repeat(200)),
    history('user', 'Latest required request 😀'),
  ];
  const schemas: ProviderTool[] = [{
    name: 'read_file',
    description: '파일 설명 😀\n'.repeat(50),
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '저장소 파일 경로' } } },
  }];
  const target = messages.map(providerMessage);
  const maxContextBytes = jsonBytes(target);
  const emptyEnvelope = JSON.stringify({ messages: [], tools: schemas });
  const reservedBytes = Buffer.byteLength(emptyEnvelope, 'utf8') - 2;
  assert.ok(Buffer.byteLength(emptyEnvelope, 'utf8') > emptyEnvelope.length,
    'Schema fixture must exercise UTF-8 byte accounting');
  assert.ok(jsonBytes([providerMessage(messages[2]!)]) + reservedBytes <= maxContextBytes);
  const request = await fixture(t, messages, maxContextBytes);
  const configBefore = JSON.stringify(request.config);
  deepFreeze(request.config);

  const unreserved: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(unreserved, target);
  assert.ok(Buffer.byteLength(JSON.stringify({ messages: unreserved, tools: schemas }), 'utf8') > maxContextBytes,
    'Messages fitting alone must still expose the envelope overflow');

  request.reservedBytes = reservedBytes;
  const reserved: ProviderMessage[] = await buildContext(request);
  assert.ok(reserved.length < unreserved.length, 'Tool schemas must reduce space available to older history');
  assert.ok(reserved.some((message) => message.role === 'user' && message.content === messages[2]!.content));
  const fullObjectBytes = Buffer.byteLength(JSON.stringify({ messages: reserved, tools: schemas }), 'utf8');
  assert.equal(fullObjectBytes, jsonBytes(reserved) + reservedBytes);
  assert.ok(fullObjectBytes <= maxContextBytes);
  assert.equal(JSON.stringify(request.config), configBefore);
});

test('buildContext honors the exact available boundary and rejects a latest user one byte beyond it', async (t) => {
  const latest = history('user', 'Required reserved request 한글 😀\n\\\"');
  const expected = [providerMessage(latest)];
  const requiredBytes = jsonBytes(expected);
  const reservedBytes = 123;
  const request = await fixture(t, [latest], requiredBytes + reservedBytes);
  request.reservedBytes = reservedBytes;
  const configBefore = JSON.stringify(request.config);
  deepFreeze(request.config);

  const exact: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(exact, expected);
  assert.equal(jsonBytes(exact) + reservedBytes, request.config.limits.maxContextBytes);

  request.reservedBytes = reservedBytes + 1;
  await assert.rejects(buildContext(request), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'CONTEXT_LIMIT');
    assert.deepEqual(error.details, {
      requiredBytes,
      maxContextBytes: requiredBytes + reservedBytes,
      reservedBytes: reservedBytes + 1,
      availableContextBytes: requiredBytes - 1,
    });
    return true;
  });
  assert.equal(JSON.stringify(request.config), configBefore);
});

test('buildContext rejects invalid reservedBytes without numeric coercion', async (t) => {
  const request = await fixture(t, [history('user', 'Validate reserved byte inputs')]);
  const cases: { label: string; value: unknown }[] = [
    { label: 'negative', value: -1 },
    { label: 'fractional', value: 0.5 },
    { label: 'NaN', value: Number.NaN },
    { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'numeric string', value: '0' },
    { label: 'null', value: null },
    { label: 'boolean', value: false },
    { label: 'object', value: {} },
    { label: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const { label, value } of cases) {
    Object.defineProperty(request, 'reservedBytes', { value, writable: true, enumerable: true, configurable: true });
    await assert.rejects(buildContext(request),
      (error: unknown) => error instanceof EngineError && error.code === 'CONTEXT_LIMIT', label);
  }
});

test('buildContext requires two available bytes even for an empty message array', async (t) => {
  const request = await fixture(t, [], 128);
  request.reservedBytes = 126;
  const exact: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(exact, []);
  assert.equal(jsonBytes(exact) + request.reservedBytes, 128);

  for (const reservedBytes of [127, 128, 129, Number.MAX_SAFE_INTEGER]) {
    request.reservedBytes = reservedBytes;
    await assert.rejects(buildContext(request),
      (error: unknown) => error instanceof EngineError && error.code === 'CONTEXT_LIMIT',
      `Reservation ${reservedBytes} must reject exhausted message-array space`);
  }
});

test('buildContext applies reservedBytes when fitting AGENTS.md while preserving the latest user', async (t) => {
  const request = await fixture(t, [history('user', 'Project request 😀')], 1_024);
  await writeFile(join(request.workspace.root, 'AGENTS.md'), '지침 😀\n'.repeat(2_000));
  const unreserved: ProviderMessage[] = await buildContext(request);
  const unreservedInstruction = unreserved.find((message) => message.role === 'system');
  assert.ok(unreservedInstruction);

  request.reservedBytes = 700;
  const reserved: ProviderMessage[] = await buildContext(request);
  const reservedInstruction = reserved.find((message) => message.role === 'system');
  assert.ok(reservedInstruction, 'A bounded optional instruction should fit beside this latest user');
  assert.ok(Buffer.byteLength(reservedInstruction.content, 'utf8') < Buffer.byteLength(unreservedInstruction.content, 'utf8'));
  assert.ok(reserved.some((message) => message.role === 'user' && message.content === 'Project request 😀'));
  assert.ok(jsonBytes(reserved) + request.reservedBytes <= request.config.limits.maxContextBytes);
  assert.equal(request.config.limits.maxContextBytes, 1_024);
});

test('buildContext keeps a current tool group intact with a reservation and rejects a one-byte overflow', async (t) => {
  const messages = [
    history('user', 'Current reserved request'),
    history('assistant', 'Already executed reserved call', { toolCalls: [call('reserved-call', { query: '한글 😀'.repeat(50) })] }),
    history('tool', 'Executed result 😀\n'.repeat(50), { toolCallId: 'reserved-call' }),
  ];
  const expected = messages.map(providerMessage);
  const requiredBytes = jsonBytes(expected);
  const request = await fixture(t, messages, requiredBytes + 80);
  request.reservedBytes = 80;
  const exact: ProviderMessage[] = await buildContext(request);
  assert.deepEqual(exact, expected);
  assertCompleteToolGroups(exact);
  assert.equal(jsonBytes(exact) + request.reservedBytes, request.config.limits.maxContextBytes);

  request.reservedBytes = 81;
  await assert.rejects(buildContext(request), (error: unknown) => error instanceof EngineError && error.code === 'CONTEXT_LIMIT');
});

test('buildContext observes cancellation before reading workspace instructions', async (t) => {
  const request = await fixture(t, [history('user', 'Cancelled request')]);
  await writeFile(join(request.workspace.root, 'AGENTS.md'), 'Project instructions');
  const controller = new AbortController();
  controller.abort();
  request.signal = controller.signal;
  await assert.rejects(buildContext(request), (error: unknown) => error instanceof EngineError && error.code === 'CANCELLED');
});

test('buildContext leaves its snapshot, workspace, and configuration unchanged', async (t) => {
  const request = await fixture(t, [
    history('user', 'Immutable request'),
    history('assistant', 'Immutable tool call', { toolCalls: [call('immutable', { options: { nested: ['😀', true, null] } })] }),
    history('tool', 'Immutable result', { toolCallId: 'immutable' }),
  ]);
  const before = JSON.stringify({ workspace: request.workspace, snapshot: request.snapshot, config: request.config });
  deepFreeze(request.workspace);
  deepFreeze(request.snapshot);
  deepFreeze(request.config);

  const messages: ProviderMessage[] = await buildContext(request);
  assertCompleteToolGroups(messages);
  assert.equal(JSON.stringify({ workspace: request.workspace, snapshot: request.snapshot, config: request.config }), before);
});

function replay(items: JsonObject[] = []): ProviderReplay {
  return { providerId: 'responses-fixture', items };
}

function nativeReplay(): ProviderReplay {
  return replay([
    {
      id: 'reasoning-1', type: 'reasoning', status: 'completed',
      encrypted_content: 'opaque-encrypted-한글-😀-\\\"',
      summary: [{ type: 'summary_text', text: 'Provider reasoning summary' }],
      metadata: { signature: 'opaque-signature', extension: [null, false, 3.25, { future: 'field' }] },
    },
    {
      id: 'message-commentary', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed',
      content: [{ type: 'output_text', text: 'Working 😀\n\\\"', annotations: [{ type: 'future_annotation', nested: { keep: true } }] }],
    },
    {
      id: 'message-final', type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
      content: [{ type: 'output_text', text: 'Done', annotations: [], logprobs: [] }],
    },
    { type: 'future_provider_item', future: { unknown: ['preserve', 7, true, null] } },
  ]);
}

async function assertInvalidReplay(request: ContextRequest, label: string): Promise<void> {
  await assert.rejects(buildContext(request), (error: unknown) => {
    assert.ok(error instanceof EngineError, `${label}: replay corruption must use EngineError`);
    assert.equal(error.code, 'INVALID_CONTEXT', label);
    assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /INVALID_NATIVE_REPLAY_VALUE|NativeReflectionFailure/,
      `${label}: errors must not include opaque input or native reflection messages`);
    return true;
  }, label);
}

test('buildContext preserves opaque completed replay in item order and returns an independent deep copy', async (t) => {
  const native = nativeReplay();
  const protoItem = JSON.parse('{"type":"future_proto_item","__proto__":{"polluted":"opaque-data"}}') as JsonObject;
  native.items.push(protoItem);
  const messages = [history('user', 'Continue the response'), history('assistant', 'Completed answer', { providerReplay: native })];
  const request = await fixture(t, messages);
  request.config.providerId = native.providerId;
  const before = JSON.stringify(request.snapshot);
  deepFreeze(request.snapshot);

  const result = await buildContext(request);
  assert.deepEqual(result, messages.map(providerMessage));
  const copied = result[1]!.providerReplay!;
  assert.notEqual(copied, native);
  assert.notEqual(copied.items, native.items);
  for (let index = 0; index < native.items.length; index += 1) assert.notEqual(copied.items[index], native.items[index]);
  const copiedMetadata = copied.items[0]!.metadata as JsonObject;
  assert.notEqual(copiedMetadata, native.items[0]!.metadata);
  copiedMetadata.changedByProvider = true;
  (copiedMetadata.extension as unknown[]).push('additional provider data');
  copied.items[1]!.phase = 'changed-by-provider';
  copied.items.push({ type: 'new-provider-item' });
  assert.equal(JSON.stringify(request.snapshot), before);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(Object.hasOwn(copied.items[4]!, '__proto__'));
  assert.equal(copied.providerId, request.config.providerId);
});

test('buildContext preserves complete tool-group replay while dropping an unrelated trailing orphan', async (t) => {
  const native = nativeReplay();
  native.items.push(
    { type: 'function_call', id: 'native-a', call_id: 'native-call-a', name: 'read_file', arguments: '{"path":"a.ts"}', status: 'completed' },
    { type: 'function_call', id: 'native-b', call_id: 'native-call-b', name: 'read_file', arguments: '{"path":"b.ts"}', status: 'completed' },
  );
  const valid = [
    history('user', 'Read both native files'),
    history('assistant', 'Reading native files', { toolCalls: [call('native-call-a'), call('native-call-b')], providerReplay: native }),
    history('tool', 'File B', { toolCallId: 'native-call-b' }),
    history('tool', 'File A', { toolCallId: 'native-call-a' }),
  ];
  const request = await fixture(t, [...valid, history('tool', 'Unrelated orphan', { toolCallId: 'orphan-native-call' })]);
  request.config.providerId = native.providerId;
  deepFreeze(request.snapshot);
  const result = await buildContext(request);
  assert.deepEqual(result, valid.map(providerMessage));
  assertCompleteToolGroups(result);
  assert.notEqual(result[1]!.providerReplay!.items[4], native.items[4]);
});

test('buildContext retains empty-text replay with no calls or an empty call list, including empty replay items', async (t) => {
  const request = await fixture(t, []);
  request.config.providerId = 'responses-fixture';
  for (const toolCalls of [undefined, []]) {
    for (const native of [replay(), replay([{ type: 'future_output', value: { opaque: true } }])]) {
      request.snapshot.messages = [history('user', 'Empty output request'), history('assistant', '', { toolCalls, providerReplay: native })];
      assert.deepEqual(await buildContext(request), [
        { role: 'user', content: 'Empty output request' },
        { role: 'assistant', content: '', providerReplay: native },
      ]);
    }
  }
  const boundaryReplay = { providerId: '😀'.repeat(64), items: [] };
  request.config.providerId = boundaryReplay.providerId;
  request.snapshot.messages = [history('assistant', '', { providerReplay: boundaryReplay })];
  assert.equal(Buffer.byteLength(boundaryReplay.providerId, 'utf8'), 256);
  assert.deepEqual(await buildContext(request), [{ role: 'assistant', content: '', providerReplay: boundaryReplay }]);
});

test('buildContext drops all native replay when nonempty or malformed tool calls cannot form a complete group', async (t) => {
  const native = nativeReplay();
  native.items.push({ type: 'function_call', call_id: 'unresolved-native', name: 'read_file', arguments: '{}' });
  const request = await fixture(t, []);
  request.config.providerId = native.providerId;
  const invalidCalls: unknown[] = [
    [call('missing-native')],
    [call('partial-a'), call('partial-b')],
    [{ id: 'invalid-native', name: 'read_file', input: undefined }],
    { malformed: true },
    null,
  ];
  for (const toolCalls of invalidCalls) {
    const assistant = history('assistant', 'Explanation survives incomplete native calls', { providerReplay: native });
    Object.defineProperty(assistant, 'toolCalls', { value: toolCalls, enumerable: true, configurable: true });
    request.snapshot.messages = [
      history('user', 'Request with incomplete native tool exchange'), assistant,
      history('tool', 'Only one result', { toolCallId: 'partial-a' }),
    ];
    assert.deepEqual(await buildContext(request), [
      { role: 'user', content: 'Request with incomplete native tool exchange' },
      { role: 'assistant', content: 'Explanation survives incomplete native calls' },
    ]);
  }
});

test('buildContext counts all serialized opaque replay and reserved bytes when trimming older groups atomically', async (t) => {
  const native = replay([{ type: 'reasoning', encrypted_content: 'opaque-한글😀\n\\\"'.repeat(2_000), signature: 'retain-whole-state' }]);
  const older = [
    history('assistant', 'Earlier replay tool request', { toolCalls: [call('older-replay')], providerReplay: native }),
    history('tool', 'Earlier replay tool result', { toolCallId: 'older-replay' }),
  ];
  const latest = history('user', 'Latest native request');
  const expected = [...older, latest].map(providerMessage);
  const requiredBytes = jsonBytes(expected);
  const reservedBytes = 113;
  const request = await fixture(t, [...older, latest], requiredBytes + reservedBytes);
  request.config.providerId = native.providerId;
  request.reservedBytes = reservedBytes;
  const before = JSON.stringify(request.snapshot);
  deepFreeze(request.snapshot);
  const exact = await buildContext(request);
  assert.deepEqual(exact, expected);
  assert.equal(jsonBytes(exact) + reservedBytes, request.config.limits.maxContextBytes);
  assertCompleteToolGroups(exact);

  request.reservedBytes += 1;
  const trimmed = await buildContext(request);
  assert.deepEqual(trimmed, [providerMessage(latest)]);
  assert.ok(jsonBytes(trimmed) + request.reservedBytes <= request.config.limits.maxContextBytes);
  assert.equal(JSON.stringify(request.snapshot), before, 'Context must not shorten stored encrypted state');
});

test('buildContext preserves a large current encrypted replay whole and rejects a one-byte reserved overflow', async (t) => {
  const encrypted = 'opaque-current-state-😀\\\"'.repeat(12_000);
  const native = replay([{ type: 'reasoning', encrypted_content: encrypted }]);
  const messages = [
    history('user', 'Current replay request'),
    history('assistant', '', { toolCalls: [call('current-replay')], providerReplay: native }),
    history('tool', 'Executed native result', { toolCallId: 'current-replay' }),
  ];
  const expected = messages.map(providerMessage);
  const requiredBytes = jsonBytes(expected);
  const request = await fixture(t, messages, requiredBytes + 79);
  request.config.providerId = native.providerId;
  request.reservedBytes = 79;
  deepFreeze(request.snapshot);
  const exact = await buildContext(request);
  assert.deepEqual(exact, expected);
  assert.equal(exact[1]!.providerReplay!.items[0]!.encrypted_content, encrypted);
  assertCompleteToolGroups(exact);
  request.reservedBytes = 80;
  await assert.rejects(buildContext(request), (error: unknown) => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, 'CONTEXT_LIMIT');
    assert.equal(error.details?.requiredBytes, requiredBytes);
    assert.equal(error.details?.reservedBytes, 80);
    assert.doesNotMatch(error.message, /opaque-current-state/);
    return true;
  });
  assert.equal(messages[1]!.providerReplay!.items[0]!.encrypted_content, encrypted);
});

test('buildContext omits switched-provider encrypted replay before budgeting but preserves the normalized complete exchange', async (t) => {
  const native = replay([{ type: 'reasoning', encrypted_content: 'foreign-provider-opaque-state-😀'.repeat(20_000) }]);
  const normalized: ProviderMessage[] = [
    { role: 'user', content: 'Continue with another provider' },
    { role: 'assistant', content: 'Completed prior-provider work', toolCalls: [call('foreign-replay-tool')] },
    { role: 'tool', content: 'Recorded tool result', toolCallId: 'foreign-replay-tool' },
    { role: 'assistant', content: 'Recorded final text' },
  ];
  const messages = [
    history('user', normalized[0]!.content),
    history('assistant', normalized[1]!.content, { toolCalls: [call('foreign-replay-tool')], providerReplay: native }),
    history('tool', normalized[2]!.content, { toolCallId: 'foreign-replay-tool' }),
    history('assistant', normalized[3]!.content, { providerReplay: replay([{ type: 'future_item', encrypted_content: 'foreign-text-state' }]) }),
  ];
  const reservedBytes = 107;
  const request = await fixture(t, messages, jsonBytes(normalized) + reservedBytes);
  request.reservedBytes = reservedBytes;
  const before = JSON.stringify(request.snapshot);
  deepFreeze(request.snapshot);

  const result = await buildContext(request);
  assert.deepEqual(result, normalized);
  assertCompleteToolGroups(result);
  assert.ok(result.every((message) => !Object.hasOwn(message, 'providerReplay')));
  assert.equal(jsonBytes(result) + reservedBytes, request.config.limits.maxContextBytes);
  assert.equal(JSON.stringify(request.snapshot), before);

  const corruptForeign = history('assistant', 'Foreign malformed native state');
  Object.defineProperty(corruptForeign, 'providerReplay', { value: { providerId: 'other-provider', items: [{ value: undefined }] }, enumerable: true });
  const corruptRequest = await fixture(t, [history('user', 'Reject corrupted foreign state'), corruptForeign]);
  await assertInvalidReplay(corruptRequest, 'Invalid replay from a switched provider');
});

test('buildContext rejects malformed replay envelopes and non-JSON item data with fixed INVALID_CONTEXT errors', async (t) => {
  const cyclic: Record<string, unknown> = { secret: 'INVALID_NATIVE_REPLAY_VALUE' };
  cyclic.self = cyclic;
  class NativeState { state = 'INVALID_NATIVE_REPLAY_VALUE'; }
  const symbolItem = { valid: true, [Symbol('opaque')]: 'INVALID_NATIVE_REPLAY_VALUE' };
  const hiddenItem = Object.defineProperty({ valid: true }, 'hidden', { value: 'INVALID_NATIVE_REPLAY_VALUE', enumerable: false });
  const arraySubclass = new (class NativeItems extends Array<object> {})({ type: 'reasoning' });
  const cases: { label: string; value: unknown }[] = [
    { label: 'null envelope', value: null }, { label: 'array envelope', value: [] },
    { label: 'string envelope', value: 'INVALID_NATIVE_REPLAY_VALUE' },
    { label: 'missing provider ID', value: { items: [] } }, { label: 'missing items', value: { providerId: 'valid' } },
    { label: 'unknown envelope field', value: { providerId: 'valid', items: [], secret: 'INVALID_NATIVE_REPLAY_VALUE' } },
    { label: 'empty provider ID', value: { providerId: '', items: [] } },
    { label: 'nonstring provider ID', value: { providerId: 1, items: [] } },
    { label: 'oversized ASCII provider ID', value: { providerId: 'a'.repeat(257), items: [] } },
    { label: 'oversized UTF-8 provider ID', value: { providerId: '😀'.repeat(65), items: [] } },
    { label: 'control character provider ID', value: { providerId: 'valid\nINVALID_NATIVE_REPLAY_VALUE', items: [] } },
    { label: 'DEL provider ID', value: { providerId: 'valid\u007f', items: [] } },
    { label: 'null items', value: { providerId: 'valid', items: null } },
    { label: 'object items', value: { providerId: 'valid', items: {} } },
    { label: 'null item', value: { providerId: 'valid', items: [null] } },
    { label: 'array item', value: { providerId: 'valid', items: [[]] } },
    { label: 'scalar item', value: { providerId: 'valid', items: [1] } },
    { label: 'undefined item value', value: { providerId: 'valid', items: [{ value: undefined }] } },
    { label: 'NaN item value', value: { providerId: 'valid', items: [{ value: Number.NaN }] } },
    { label: 'infinite item value', value: { providerId: 'valid', items: [{ value: Infinity }] } },
    { label: 'bigint item value', value: { providerId: 'valid', items: [{ value: 1n }] } },
    { label: 'function item value', value: { providerId: 'valid', items: [{ value: () => 'INVALID_NATIVE_REPLAY_VALUE' }] } },
    { label: 'symbol item value', value: { providerId: 'valid', items: [{ value: Symbol('opaque') }] } },
    { label: 'symbol item key', value: { providerId: 'valid', items: [symbolItem] } },
    { label: 'hidden item field', value: { providerId: 'valid', items: [hiddenItem] } },
    { label: 'cyclic item', value: { providerId: 'valid', items: [cyclic] } },
    { label: 'class item', value: { providerId: 'valid', items: [new NativeState()] } },
    { label: 'date item value', value: { providerId: 'valid', items: [{ value: new Date(createdAt) }] } },
    { label: 'array subclass', value: { providerId: 'valid', items: arraySubclass } },
    { label: 'sparse items array', value: { providerId: 'valid', items: new Array(1) } },
  ];
  const request = await fixture(t, []);
  for (const { label, value } of cases) {
    const assistant = history('assistant', 'Corrupted replay assistant');
    Object.defineProperty(assistant, 'providerReplay', { value, enumerable: true, configurable: true });
    request.snapshot.messages = [history('user', 'Validate native replay'), assistant];
    await assertInvalidReplay(request, label);
  }
});

test('buildContext rejects replay getters and reflection traps without invoking accessors or exposing native errors', async (t) => {
  let getterReads = 0;
  let toJsonCalls = 0;
  const itemAccessor = Object.defineProperty({}, 'encrypted_content', { enumerable: true, get() { getterReads += 1; throw new Error('NativeReflectionFailure'); } });
  const envelopeAccessor = Object.defineProperty({ items: [] }, 'providerId', { enumerable: true, get() { getterReads += 1; return 'valid'; } });
  const arrayAccessor = Object.defineProperty([], '0', { enumerable: true, get() { getterReads += 1; return {}; } });
  const trapped = new Proxy({}, { ownKeys() { throw new Error('NativeReflectionFailure'); } });
  const cases: unknown[] = [
    envelopeAccessor, replay([itemAccessor]),
    { providerId: 'valid', items: arrayAccessor },
    replay([{ toJSON() { toJsonCalls += 1; return 'INVALID_NATIVE_REPLAY_VALUE'; } } as unknown as JsonObject]),
    { providerId: 'valid', items: [trapped] },
  ];
  const request = await fixture(t, []);
  for (const [index, value] of cases.entries()) {
    const assistant = history('assistant', 'Accessor replay');
    Object.defineProperty(assistant, 'providerReplay', { value, enumerable: true, configurable: true });
    request.snapshot.messages = [assistant];
    await assertInvalidReplay(request, `Reflection case ${index}`);
  }
  const messageAccessor = history('assistant', 'Accessor on replay property');
  Object.defineProperty(messageAccessor, 'providerReplay', { enumerable: true, get() { getterReads += 1; throw new Error('NativeReflectionFailure'); } });
  request.snapshot.messages = [messageAccessor];
  await assertInvalidReplay(request, 'Message replay accessor');
  assert.equal(getterReads, 0);
  assert.equal(toJsonCalls, 0);
});

test('buildContext validates replay before discarding incomplete exchanges or trimming older history', async (t) => {
  const latest = history('user', 'Latest safe user');
  const request = await fixture(t, []);
  request.config.providerId = 'valid';
  const invalidReplay = { providerId: 'valid', items: [{ value: undefined, secret: 'INVALID_NATIVE_REPLAY_VALUE' }] };
  for (const older of [false, true]) {
    const assistant = history('assistant', 'Invalid native output', { toolCalls: [call('dangling-native')] });
    Object.defineProperty(assistant, 'providerReplay', { value: invalidReplay, enumerable: true });
    request.snapshot.messages = older ? [assistant, latest] : [latest, assistant];
    request.config.limits.maxContextBytes = older ? jsonBytes([providerMessage(latest)]) : DEFAULT_LIMITS.maxContextBytes;
    await assertInvalidReplay(request, older ? 'Older replay would be trimmed' : 'Current replay exchange is incomplete');
  }
});

test('buildContext rejects same-session replay on unsupported roles and on malformed surrounding records', async (t) => {
  const request = await fixture(t, []);
  for (const role of ['user', 'tool'] as const) {
    request.snapshot.messages = [history(role, 'Unsupported native replay role', { providerReplay: replay() })];
    await assertInvalidReplay(request, `Replay attached to ${role}`);
  }
  for (const field of ['content', 'runId'] as const) {
    for (const native of [replay(), { providerId: '', items: [] }]) {
      const assistant = history('assistant', 'Malformed containing record');
      Object.defineProperty(assistant, field, { value: 1, enumerable: true });
      Object.defineProperty(assistant, 'providerReplay', { value: native, enumerable: true });
      request.snapshot.messages = [assistant];
      await assertInvalidReplay(request, `Malformed assistant ${field}`);
    }
    const result = history('tool', 'Consumed malformed result', { toolCallId: 'consumed-native', providerReplay: replay() });
    Object.defineProperty(result, field, { value: 1, enumerable: true });
    request.snapshot.messages = [
      history('assistant', '', { toolCalls: [call('consumed-native')], providerReplay: replay([{ type: 'function_call', call_id: 'consumed-native' }]) }),
      result,
    ];
    await assertInvalidReplay(request, `Consumed replay tool with malformed ${field}`);
  }
  const foreign = history('assistant', 'Foreign invalid replay', { sessionId: 'foreign-session' });
  Object.defineProperty(foreign, 'providerReplay', { value: { providerId: '', items: null }, enumerable: true });
  request.snapshot.messages = [foreign, history('user', 'Keep same-session request')];
  assert.deepEqual(await buildContext(request), [{ role: 'user', content: 'Keep same-session request' }]);
});
