import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type RunConfig } from '@moodcode/contracts';
import type { ContextRequest, ProviderMessage } from '../ports.js';
import type { KnowledgeContextRequest, KnowledgeContextSourcePort, PreparedKnowledgeContribution } from '../knowledge/context-types.js';
import { SqliteStore } from '../storage/index.js';
import { ContextService } from './service.js';
import { planContext } from './plan.js';

const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;
const signal = () => new AbortController().signal;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

/** This peer proves ContextService handle ownership; actual published provenance is covered by Engine fixtures. */
class PeerSource implements KnowledgeContextSourcePort {
  readonly requests: KnowledgeContextRequest[] = [];
  readonly active = new Set<PreparedKnowledgeContribution>();
  readonly released: PreparedKnowledgeContribution[] = [];
  beforePrepare?: (request: KnowledgeContextRequest) => Promise<void>;
  beforeFresh?: (prepared: PreparedKnowledgeContribution) => Promise<void>;
  messages: readonly { role: 'assistant'; content: string }[] = [];
  async prepare(request: KnowledgeContextRequest): Promise<PreparedKnowledgeContribution> {
    this.requests.push(request); await this.beforePrepare?.(request);
    const contributedBytes = this.messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 1, 0);
    const value: PreparedKnowledgeContribution = Object.freeze({ schemaVersion: 1, id: sha({ owner: request.owner, budget: request.budget }),
      authority: 'read-only', trust: 'host-approved-data', coverage: 'host-selected-document-keys', workspaceId: request.workspace.id,
      owner: Object.freeze(structuredClone(request.owner)), policySha256: sha(request.policy), bindingSha256: sha(request.workspace),
      documents: Object.freeze([]), omissions: Object.freeze([{ documentKey: 'memory', reason: 'missing' as const }]), complete: false,
      messages: Object.freeze(this.messages.map(message => Object.freeze({ ...message }))),
      reservations: Object.freeze({ envelopeBytes: request.budget.reservedBytes, outputTokens: request.budget.outputTokens, slotBytes: request.budget.slotBytes,
        availableBytes: Math.min(request.budget.slotBytes, request.budget.maxContextBytes - request.budget.reservedBytes - request.budget.requiredMessagesBytes), contributedBytes }),
      inputEstimate: Object.freeze({ tokens: null, utf8ByteUpperBound: contributedBytes, estimated: true, source: 'utf8-byte-upper-bound', contextWindow: request.budget.contextWindow }) });
    this.active.add(value); return value;
  }
  async assertFresh(prepared: PreparedKnowledgeContribution, abort: AbortSignal): Promise<void> {
    await this.beforeFresh?.(prepared);
    if (!this.active.has(prepared)) throw new EngineError('KNOWLEDGE_CONTEXT_STALE', 'Released peer capture');
    if (abort.aborted) throw new EngineError('KNOWLEDGE_CONTEXT_CANCELLED', 'Cancelled peer capture');
  }
  release(prepared: PreparedKnowledgeContribution): void {
    assert.ok(this.active.delete(prepared), 'Every original capture is released once'); this.released.push(prepared);
  }
}
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-knowledge-capture-'))), store = new SqliteStore(':memory:'), source = new PeerSource();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const config: RunConfig = { providerId: 'fixture', modelId: 'model', mode: 'build', limits: { ...DEFAULT_LIMITS, maxContextBytes: 4096 } };
  const service = new ContextService(store, undefined, 17, undefined, { knowledgeContext: { source, policy: { documentKeys: ['memory'], slotBytes: 16384 } } });
  const request = async (id: string, running = false): Promise<ContextRequest> => {
    const workspaceRoot = join(root, id); await mkdir(workspaceRoot);
    const stamp = new Date().toISOString(), workspace = store.putWorkspace({ id: `workspace-${id}`, root: workspaceRoot, gitRoot: workspaceRoot, branch: null, createdAt: stamp });
    store.createSession({ id, workspaceId: workspace.id, title: 'Capture fixture', createdAt: stamp });
    const admitted = store.admit({ sessionId: id, requestId: `request-${id}`, prompt: `Original request ${id} 한글😀`, config });
    if (running) store.commit(admitted.runId, 'run.started', {}, { run: { state: 'running' } });
    return { workspace, snapshot: service.snapshot(id, config), config, signal: signal(), ...(running ? { run: store.getRun(admitted.runId) } : {}), reservedBytes: 64 };
  };
  return { root, store, source, config, service, request };
}

test('knowledge-only capture binds actual persisted revision, full messages and Run while replacement releases the original', async t => {
  const f = await fixture(t), request = await f.request('one', true), first = await f.service.build(request), original = [...f.source.active][0]!;
  const revision = f.store.getLatestContextRevision('one')!, diagnostics = f.service.diagnostics('one')!;
  assert.equal(revision.text, JSON.stringify(first)); assert.equal(revision.sha256, createHash('sha256').update(revision.text).digest('hex'));
  assert.equal(diagnostics.plan.sha256, sha(first)); assert.ok(!('messages' in diagnostics.knowledgeContext!));
  assert.ok(revision.sourceIds.includes(`knowledge-policy:${original.policySha256}`));
  await f.service.assertFresh('one', structuredClone(first), signal(), request.run!.id);
  const mutated = structuredClone(first); mutated.at(-1)!.content += ' changed';
  await assert.rejects(f.service.assertFresh('one', mutated, signal(), request.run!.id), code('KNOWLEDGE_CONTEXT_STALE'));
  await assert.rejects(f.service.assertFresh('one', first, signal(), 'different-run'), code('KNOWLEDGE_CONTEXT_STALE'));
  await assert.rejects(f.service.assertFresh('foreign', first, signal(), request.run!.id), code('KNOWLEDGE_CONTEXT_STALE'));
  const second = await f.service.build(request); assert.deepEqual(second, first); assert.equal(f.service.revisionId('one'), revision.id);
  assert.ok(f.source.released.includes(original)); assert.equal(f.source.active.size, 1);
  f.service.releaseContext('one', 'wrong-run'); assert.equal(f.source.active.size, 1);
  f.service.releaseContext('one', request.run!.id); assert.equal(f.source.active.size, 0);
  await assert.rejects(f.service.assertFresh('one', second, signal(), request.run!.id), code('KNOWLEDGE_CONTEXT_STALE'));
});

test('required reservation reaches the source as actual serialized mandatory messages and envelope once', async t => {
  const f = await fixture(t), request = await f.request('budget', true);
  request.verificationContinuation = { role: 'user', content: 'Mandatory verification DATA ' + '한글😀'.repeat(10) };
  const required = await planContext(request, { requiredOnly: true, outputTokens: 17 });
  const messages = await f.service.build(request), prepared = f.source.requests[0]!;
  assert.equal(prepared.budget.requiredMessagesBytes, required.bytes - 64); assert.equal(prepared.budget.reservedBytes, 64);
  assert.equal(prepared.budget.outputTokens, 17); assert.equal(prepared.owner.runId, request.run!.id); assert.equal(prepared.owner.profile, null);
  assert.deepEqual(messages.at(-1), request.verificationContinuation); assert.ok(messages.some(message => message.content === request.run!.prompt));
  f.service.releaseContext('budget');
});

test('external context head replacement is detected even when the service cached revision is unchanged', async t => {
  const f = await fixture(t), request = await f.request('head', true), messages = await f.service.build(request), originalId = f.service.revisionId('head');
  const head = f.store.getSessionDocument('head', 'context.head')!;
  f.store.putSessionDocument('head', 'context.head', head.revision, { ...head.data, revisionId: 'externally-changed-head' });
  assert.equal(f.service.revisionId('head'), originalId);
  await assert.rejects(f.service.assertFresh('head', messages, signal(), request.run!.id), code('KNOWLEDGE_CONTEXT_STALE'));
  f.service.releaseContext('head');
});

test('freshness await cannot authorize a replaced original capture even with the same revision and messages', async t => {
  const f = await fixture(t), request = await f.request('race', true), first = await f.service.build(request), revision = f.service.revisionId('race');
  const entered = deferred(), gate = deferred(); let checks = 0;
  f.source.beforeFresh = async () => { if (++checks === 1) { entered.resolve(); await gate.promise; } };
  const rejected = assert.rejects(f.service.assertFresh('race', first, signal(), request.run!.id), code('KNOWLEDGE_CONTEXT_STALE'));
  await entered.promise; const second = await f.service.build(request); assert.deepEqual(second, first); assert.equal(f.service.revisionId('race'), revision);
  gate.resolve(); await rejected; await f.service.assertFresh('race', second, signal(), request.run!.id); f.service.releaseContext('race');
});

test('construction failure or cancellation after host observation releases captures before any context revision effect', async t => {
  for (const kind of ['malformed', 'cancelled'] as const) {
    const f = await fixture(t), request = await f.request(kind, true), abort = new AbortController(); request.signal = abort.signal;
    if (kind === 'malformed') f.source.messages = [{ role: 'assistant', content: 'x'.repeat(16385) }];
    else f.source.assertFresh = async () => { abort.abort(); };
    await assert.rejects(f.service.build(request), code(kind === 'malformed' ? 'INVALID_KNOWLEDGE_CONTEXT' : 'CANCELLED'));
    assert.equal(f.source.active.size, 0); assert.equal(f.source.released.length, 1); assert.equal(f.store.getLatestContextRevision(kind), null);
    assert.equal(f.store.getSessionDocument(kind, 'context.head'), null);
  }
});

test('concurrent pending reservations enforce the shared 128-owner bound before preparing a 129th source', async t => {
  const f = await fixture(t), requests = await Promise.all(Array.from({ length: 129 }, (_, index) => f.request(`pending-${index}`)));
  const entered = deferred(), gate = deferred(); let count = 0;
  f.source.beforePrepare = async () => { if (++count === 128) entered.resolve(); await gate.promise; };
  const pending = requests.slice(0, 128).map(request => f.service.build(request));
  await entered.promise;
  await assert.rejects(f.service.build(requests[128]!), code('CONTEXT_CAPTURE_LIMIT'));
  await assert.rejects(f.service.build(requests[0]!), code('CONTEXT_CAPTURE_BUSY'));
  assert.equal(f.source.requests.length, 128); gate.resolve(); await Promise.all(pending);
  assert.equal(f.source.active.size, 128);
  for (const request of requests.slice(0, 128)) f.service.releaseContext(request.snapshot.session.id);
  assert.equal(f.source.active.size, 0);
  await f.service.build(requests[128]!); f.service.releaseContext(requests[128]!.snapshot.session.id);
});

test('active actual Run captures are never evicted by a new owner, while a terminal owner can be released', async t => {
  const f = await fixture(t), requests: ContextRequest[] = [], messages: ProviderMessage[][] = [];
  for (let index = 0; index < 127; index++) { const request = await f.request(`active-${index}`, true); requests.push(request); messages.push(await f.service.build(request)); }
  const entered = deferred(), gate = deferred(), preparing = await f.request('active-preparing', true);
  f.source.beforePrepare = async () => { entered.resolve(); await gate.promise; };
  const pending = f.service.build(preparing); await entered.promise;
  const extra = await f.request('active-extra', true), first = requests[0]!;
  await assert.rejects(f.service.build(extra), code('CONTEXT_CAPTURE_LIMIT'));
  assert.equal(f.source.requests.length, 128); assert.equal(f.source.released.length, 0);
  gate.resolve(); await pending; requests.push(preparing); f.source.beforePrepare = undefined;
  await f.service.assertFresh(first.snapshot.session.id, messages[0]!, signal(), first.run!.id);
  f.store.commit(first.run!.id, 'run.completed', {}, { run: { state: 'completed' } });
  await f.service.build(extra); assert.equal(f.source.released.length, 1);
  await assert.rejects(f.service.assertFresh(first.snapshot.session.id, messages[0]!, signal(), first.run!.id), code('KNOWLEDGE_CONTEXT_STALE'));
  for (const request of [...requests, extra]) f.service.releaseContext(request.snapshot.session.id);
  assert.equal(f.source.active.size, 0);
});
