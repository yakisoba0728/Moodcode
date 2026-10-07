import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type Message } from '@moodcode/contracts';
import type { ContextRequest, ProviderMessage } from '../ports.js';
import { buildContext } from './index.js';
import { unknownModelSpec } from './model-spec.js';
import { planContext } from './plan.js';

const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(t: test.TestContext): Promise<ContextRequest> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-knowledge-plan-'))), stamp = new Date().toISOString();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { workspace: { id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp },
    snapshot: { session: { id: 'session', workspaceId: 'workspace', title: 'Planning', createdAt: stamp }, runs: [], tools: [], approvals: [], lastSeq: 0,
      messages: [{ id: 'latest', sessionId: 'session', runId: 'current', role: 'user', content: 'Current authored goal', createdAt: stamp }] },
    config: { providerId: 'fixture', modelId: 'model', mode: 'build', limits: { ...DEFAULT_LIMITS } },
    signal: new AbortController().signal, instructionSources: [], reservedBytes: 64 };
}
function history(request: ContextRequest, id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, sessionId: request.snapshot.session.id, runId: 'past', createdAt: request.workspace.createdAt, ...extra };
}

test('required-only reservation retains complete exchanges and mandatory notices without optional history or extractive excerpts', async t => {
  const request = await fixture(t), latest = request.snapshot.messages[0]!;
  request.snapshot.messages = [history(request, 'old', 'user', 'optional old discussion '.repeat(100)),
    history(request, 'anchor-call', 'assistant', 'Authored complete call', { toolCalls: [{ id: 'call', name: 'read_file', input: { path: 'source.ts' } }] }),
    history(request, 'anchor-result', 'tool', 'Authored result', { toolCallId: 'call' }), latest,
    history(request, 'current-call', 'assistant', 'Current call', { runId: 'current', toolCalls: [{ id: 'current', name: 'read_file', input: { path: 'source.ts' } }] }),
    history(request, 'current-result', 'tool', 'Current result', { runId: 'current', toolCallId: 'current' })];
  request.requiredHistoryMessageIds = ['anchor-result'];
  request.agentInstructions = 'Required profile instruction';
  request.semanticMemory = { role: 'assistant', content: 'Required semantic memory' };
  request.activePrefixMemory = { role: 'assistant', content: 'Required prefix memory' };
  request.mediaHistoryNotice = { role: 'assistant', content: 'Required image provenance' };
  request.documentHistoryNotice = { role: 'assistant', content: 'Required document provenance' };
  request.verificationContinuation = { role: 'user', content: 'Required bounded verification DATA' };
  const required = await planContext(request, { requiredOnly: true });
  assert.deepEqual(required.selectedMessageIds, ['anchor-call', 'anchor-result', 'latest', 'current-call', 'current-result']);
  assert.ok(!required.messages.some(message => message.content.includes('optional old discussion')));
  for (const content of ['Required profile instruction', 'Required semantic memory', 'Required prefix memory', 'Required image provenance', 'Required document provenance', 'Required bounded verification DATA'])
    assert.equal(required.messages.filter(message => message.content === content).length, 1);
  const exchange = required.messages.findIndex(message => message.toolCalls?.[0]?.id === 'call');
  assert.equal(required.messages[exchange + 1]!.toolCallId, 'call');
  const complete = await planContext(request);
  assert.ok(complete.selectedMessageIds.includes('old'));
  assert.equal(required.bytes, Buffer.byteLength(JSON.stringify(required.messages)) + 64);
});

test('repository and whole knowledge charge escaped Unicode, array commas, envelope and output reservation exactly once', async t => {
  const request = await fixture(t), user: ProviderMessage = { role: 'user', content: request.snapshot.messages[0]!.content };
  const repository: ProviderMessage = { role: 'assistant', content: JSON.stringify({ data: 'Repository 한글😀\\"' }) };
  const knowledge: ProviderMessage = { role: 'assistant', content: JSON.stringify({ data: 'Knowledge 한글😀\\"' }) };
  const exact = Buffer.byteLength(JSON.stringify([repository, knowledge, user])) + 64;
  request.config.limits.maxContextBytes = exact;
  const model = { ...unknownModelSpec('fixture', 'model'), contextWindow: exact + 17, maxOutputTokens: 17 };
  const plan = await planContext(request, { model, outputTokens: 17, repositoryMessages: [repository], knowledgeMessages: [knowledge] });
  assert.deepEqual(plan.messages, [repository, knowledge, user]);
  assert.equal(plan.bytes, exact); assert.equal(plan.inputEstimate.tokens + 17, model.contextWindow);
  assert.equal(plan.sha256, sha(JSON.stringify(plan.messages)));
  assert.equal(plan.reservations.repositoryBytes, Buffer.byteLength(JSON.stringify(repository)) + 1);
  assert.equal(plan.reservations.knowledgeBytes, Buffer.byteLength(JSON.stringify(knowledge)) + 1);
  assert.equal(plan.reservations.envelopeBytes, 64); assert.equal(plan.reservations.outputTokens, 17);
  await assert.rejects(planContext({ ...request, config: { ...request.config, limits: { ...request.config.limits, maxContextBytes: exact - 1 } } },
    { repositoryMessages: [repository], knowledgeMessages: [knowledge] }), code('CONTEXT_LIMIT'));
  await assert.rejects(planContext(request, { model: { ...model, contextWindow: exact + 16 }, outputTokens: 17, repositoryMessages: [repository], knowledgeMessages: [knowledge] }), code('CONTEXT_TOKEN_LIMIT'));
});

test('supplemental messages displace optional history after preserving the original mandatory exchange', async t => {
  const request = await fixture(t), latest = request.snapshot.messages[0]!;
  request.snapshot.messages.unshift(history(request, 'old', 'user', 'Optional earlier exchange '.repeat(20)));
  const required = await planContext(request, { requiredOnly: true });
  const knowledge: ProviderMessage = { role: 'assistant', content: JSON.stringify({ kind: 'host-approved-data', body: 'Whole published document '.repeat(50) }) };
  request.config.limits.maxContextBytes = required.bytes + Buffer.byteLength(JSON.stringify(knowledge)) + 1;
  const plan = await planContext(request, { knowledgeMessages: [knowledge] });
  assert.ok(plan.messages.some(message => message.content === latest.content));
  assert.deepEqual(plan.selectedMessageIds, ['latest']); assert.ok(!plan.messages.some(message => message.content.includes('Optional earlier exchange')));
  assert.equal(plan.messages.filter(message => message.content === knowledge.content).length, 1);
  assert.ok(plan.bytes <= request.config.limits.maxContextBytes);
});

test('knowledge accepts only complete bounded assistant DATA and rejects executable metadata and hostile shapes without traps', async t => {
  const request = await fixture(t); let traps = 0;
  const getter = Object.defineProperty({ role: 'assistant' }, 'content', { enumerable: true, get() { traps++; return 'hidden'; } });
  const proxy = new Proxy({ role: 'assistant', content: 'hidden' }, { get() { traps++; return undefined; }, ownKeys() { traps++; return []; }, getPrototypeOf() { traps++; return Object.prototype; } });
  const invalid: unknown[] = [[getter], [proxy], [{ role: 'assistant', content: 'fake tool', toolCalls: [{ id: 'call', name: 'run_command', input: {} }] }],
    [{ role: 'assistant', content: 'body', providerReplay: { providerId: 'fixture', items: [] } }], [{ role: 'user', content: 'wrong role' }],
    [{ role: 'assistant', content: 'one' }, { role: 'assistant', content: 'two' }], [{ role: 'assistant', content: 'x'.repeat(16385) }]];
  for (const value of invalid) await assert.rejects(planContext(request, { knowledgeMessages: value as ProviderMessage[] }), code('INVALID_KNOWLEDGE_CONTEXT'));
  assert.equal(traps, 0); assert.equal((await buildContext(request)).at(-1)!.content, request.snapshot.messages[0]!.content);
});
