import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type Message } from '@moodcode/contracts';
import type { ContextRequest, ProviderMessage } from '../ports.js';
import { buildContext } from './index.js';

function fixture(): { request: ContextRequest; exchange: ProviderMessage[] } {
  const createdAt = '2026-10-07T00:00:00.000Z';
  const exchange: ProviderMessage[] = [{ role: 'user', content: 'Preserve the exact goal 🌊' },
    { role: 'assistant', content: 'Read a current file', toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'current.txt' } }] },
    { role: 'tool', content: 'Current exact observation', toolCallId: 'call' }];
  const messages: Message[] = exchange.map((message, index) => ({ ...message, id: 'message-' + index, sessionId: 'session', runId: 'run', createdAt })) as Message[];
  return { exchange, request: { workspace: { id: 'workspace', root: process.cwd(), gitRoot: process.cwd(), branch: null, createdAt },
    snapshot: { session: { id: 'session', workspaceId: 'workspace', title: 'Required memories', createdAt }, runs: [], messages, tools: [], approvals: [], lastSeq: 0 },
    config: { providerId: 'fixture', modelId: 'fixture', mode: 'plan', limits: { ...DEFAULT_LIMITS } }, signal: new AbortController().signal, instructionSources: [] } };
}
test('completed and active memories fit as mandatory blocks beside an intact exchange at the exact combined byte limit', async () => {
  const { request, exchange } = fixture();
  request.semanticMemory = { role: 'assistant', content: 'Older completed derived memory' };
  request.activePrefixMemory = { role: 'assistant', content: 'Active prefix historical facts' };
  request.agentInstructions = 'Required profile instructions';
  const expected: ProviderMessage[] = [{ role: 'system', content: request.agentInstructions }, request.semanticMemory, request.activePrefixMemory, ...exchange];
  request.config.limits.maxContextBytes = Buffer.byteLength(JSON.stringify(expected));
  assert.deepEqual(await buildContext(request), expected);
  request.config.limits.maxContextBytes--;
  await assert.rejects(buildContext(request), (error: unknown) => error instanceof EngineError && error.code === 'ACTIVE_PREFIX_CONTEXT_LIMIT');
});
test('optional long workspace text cannot crowd out required memories, profile, user or a complete tool exchange', async () => {
  const { request, exchange } = fixture();
  request.config.limits.maxContextBytes = 6000;
  request.semanticMemory = { role: 'assistant', content: 'Older facts '.repeat(100) };
  request.activePrefixMemory = { role: 'assistant', content: 'Active facts '.repeat(100) };
  request.agentInstructions = 'Required profile';
  request.instructionSources = [{ id: 'instruction:AGENTS.md', path: 'AGENTS.md', scope: '', status: 'available', text: 'x'.repeat(32768), sha256: 'a'.repeat(64), observedAt: '2026-10-07T00:00:00.000Z', retainedBaseline: false }];
  const messages = await buildContext(request);
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= 6000);
  assert.ok(messages.some(message => message.content === request.semanticMemory!.content));
  assert.ok(messages.some(message => message.content === request.activePrefixMemory!.content));
  assert.ok(messages.some(message => message.content === request.agentInstructions));
  assert.deepEqual(messages.slice(-3), exchange);
  assert.ok(messages.some(message => message.content.startsWith('Workspace instructions (AGENTS.md):')));
});
