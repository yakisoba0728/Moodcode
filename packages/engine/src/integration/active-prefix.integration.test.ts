import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type InputImageAttachment, type Message, type ProviderToolCall, type Run } from '@moodcode/contracts';
import { createEngine, type EngineOptions, type MoodcodeEngine } from '../engine.js';
import { ACTIVE_PREFIX_DOCUMENT, ACTIVE_PREFIX_MEMORY_PREFIX, type ActivePrefixCheckpoint, type ActivePrefixPolicy } from '../context/active-prefix.js';
import type { ProviderAdapter, TurnRequest } from '../ports.js';
import { planContext } from '../context/plan.js';
import type { MediaHistoryPolicy } from '../context/media-history.js';
import { png } from '../media/fixtures.js';
import { readActivePrefixSourceDatabase } from '../storage/active-prefix.js';

const policy: ActivePrefixPolicy = { kind: 'active-prefix-semantic', version: 1, maxSourceMessages: 12, maxSourceBytes: 12_000, maxOutputBytes: 2048, keepRecentTurns: 4, maxCoveredMessages: 512 };
const stamp = '2026-10-07T00:00:00.000Z';
function hash(text: string) { return createHash('sha256').update(text).digest('hex'); }
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function waitOrAbort(promise: Promise<void>, signal: AbortSignal) { let abort!: () => void; try { await Promise.race([promise, new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); } finally { signal.removeEventListener('abort', abort); } }
type Facts = { version: number; scope: string; projection: string; messages: { id: string; role: string; content: string; ordinal: number; turnId?: string; attemptId?: string; toolCallId?: string; internalToolCallId?: string; toolOutcome?: string }[] };
interface SummaryObservation { request: TurnRequest; source: Facts; sourceJson: string; text: string; nonce: string | null }
interface FixtureOptions {
  turns?: number; enabled?: boolean; prefixPolicy?: ActivePrefixPolicy; initialPrompt?: string;
  beforeSummary?: (fixture: Fixture, observed: SummaryObservation, index: number, signal: AbortSignal) => Promise<void>;
  summaryText?: (observed: SummaryObservation, index: number) => string;
  summaryFinish?: 'stop' | 'length';
  onMain?: (fixture: Fixture, request: TurnRequest) => void;
  beforeStart?: (fixture: Fixture) => Promise<void>;
  toolCall?: (index: number) => ProviderToolCall;
  mediaHistoryPolicy?: MediaHistoryPolicy;
  stopAfterSummary?: number;
}
interface Fixture {
  engine: MoodcodeEngine; reader: DatabaseSync; root: string; nonce: string; runId: string;
  mainRequests: TurnRequest[]; summaries: SummaryObservation[]; firstAssistantRaw?: string;
  done: Promise<Run>; fullReads(): number; rawNonceMessage(): Message;
}

/** Fixture summary is stateless. Its first nonce can only come from a real quoted tool result. */
function observedSummary(request: TurnRequest): SummaryObservation {
  assert.deepEqual(request.tools, []); assert.ok(request.messages[0]?.content.startsWith('[Moodcode active-prefix summarizer v1]'));
  const sourceJson = request.messages.findLast(message => message.role === 'user')!.content, source = JSON.parse(sourceJson) as Facts;
  assert.equal(source.version, 1); assert.equal(source.scope, 'active-run-prefix'); assert.equal(source.projection, 'text-and-complete-tool-observations-v1');
  assert.ok(Array.isArray(source.messages)); assert.ok(source.messages.length); assert.equal(sourceJson.includes('fixture-only-encrypted-replay'), false);
  const toolNonce = source.messages.filter(message => message.role === 'tool').map(message => message.content.match(/SYNTHETIC_NONCE=([a-f0-9]{32})/u)?.[1]).find(Boolean);
  const previousNonce = request.messages.slice(1, -1).filter(message => message.role === 'user').map(message => message.content.match(/historicalNonce["\s:]+([a-f0-9]{32})/u)?.[1]).find(Boolean);
  const nonce = toolNonce ?? previousNonce ?? null;
  const text = JSON.stringify({ version: 1, historicalObservation: true, currentFileEvidence: false, historicalNonce: nonce, provenance: toolNonce ? 'quoted-tool-observation' : previousNonce ? 'previous-derived-memory' : 'no-nonce-in-supplied-source' });
  return { request: structuredClone(request), source, sourceJson, text, nonce };
}
async function fixture(t: TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-active-prefix-'))), repository = join(root, 'observations'), dbPath = join(root, 'engine.sqlite');
  await mkdir(repository); const turns = options.turns ?? 20, nonce = randomBytes(16).toString('hex');
  await writeFile(join(repository, 'observation-0.txt'), `SYNTHETIC_NONCE=${nonce}\nObserved only in the first local file read.\n`);
  const filler = 'Synthetic historical file observation with no user instruction. '.repeat(31);
  for (let index = 1; index < turns; index++) await writeFile(join(repository, `observation-${index}.txt`), filler);
  const mainRequests: TurnRequest[] = [], summaries: SummaryObservation[] = []; let f!: Fixture, fullReads = 0;
  const provider: ProviderAdapter = { id: 'prefix-fixture', replayProtocol: 'synthetic-responses-v1', inputModalities: ['text', 'image'], async *streamTurn(request, signal) {
    if (!request.tools.length) {
      const observed = observedSummary(request), index = summaries.length; summaries.push(observed);
      yield { type: 'progress' }; await options.beforeSummary?.(f, observed, index, signal); if (signal.aborted) return;
      yield { type: 'text.delta', delta: options.summaryText?.(observed, index) ?? observed.text };
      yield { type: 'usage', inputTokens: 30 + index, outputTokens: 8, cachedInputTokens: 5, reasoningOutputTokens: 2 };
      yield { type: 'finish', reason: options.summaryFinish ?? 'stop' }; return;
    }
    assert.deepEqual(request.tools.map(tool => tool.name), ['read_file']); mainRequests.push(structuredClone(request));
    if (mainRequests.length === 2) f.firstAssistantRaw = String(f.reader.prepare("SELECT data FROM messages WHERE run_id=? AND json_extract(data,'$.role')='assistant' ORDER BY ordinal LIMIT 1").get(request.runId)?.data);
    options.onMain?.(f, request);
    if (request.turnIndex >= turns || options.stopAfterSummary !== undefined && summaries.length >= options.stopAfterSummary) { yield { type: 'text.delta', delta: 'Finished local bounded prefix verification' }; yield { type: 'finish', reason: 'stop' }; return; }
    yield { type: 'tool.call', call: options.toolCall?.(request.turnIndex) ?? { id: `observed-${request.turnIndex}`, name: 'read_file', input: { path: `observation-${request.turnIndex}.txt` } } };
    yield { type: 'finish', reason: 'tool_calls', replayItems: [{ type: 'reasoning', encrypted_content: `fixture-only-encrypted-replay-${request.turnIndex}` }] };
  } };
  const engineOptions: EngineOptions & { activePrefixPolicy?: ActivePrefixPolicy } = { dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    defaults: { providerId: provider.id, modelId: 'prefix-model', mode: 'plan', limits: { maxTurns: Math.min(128, turns + 10), maxToolCalls: turns + 4, maxOutputBytes: 1_048_576, maxContextBytes: 16_384 },
      budgets: { turnAllowance: Math.min(128, turns + 10), maxSummaryCalls: 32, maxSummaryBytes: 65_536 } },
    ...(options.enabled === false ? {} : { activePrefixPolicy: options.prefixPolicy ?? policy }),
    ...(options.mediaHistoryPolicy ? { mediaHistoryPolicy: options.mediaHistoryPolicy } : {}),
  };
  const engine = createEngine(engineOptions), reader = new DatabaseSync(dbPath, { readOnly: true });
  t.after(async () => { try { await engine.close(); } finally { reader.close(); await rm(root, { recursive: true, force: true }); } });
  engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: stamp }); engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Active prefix', createdAt: stamp });
  engine.store.getSnapshot = () => { fullReads++; throw new Error('Active-prefix fixture forbids full session snapshots'); };
  f = { engine, reader, root, nonce, runId: '', mainRequests, summaries, done: undefined!, fullReads: () => fullReads,
    rawNonceMessage() { const row = reader.prepare("SELECT data FROM messages WHERE run_id=? AND json_extract(data,'$.role')='tool' AND instr(json_extract(data,'$.content'),?)>0 ORDER BY ordinal LIMIT 1").get(f.runId, `SYNTHETIC_NONCE=${nonce}`); assert.ok(row); return JSON.parse(String(row.data)) as Message; },
  };
  await options.beforeStart?.(f);
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'primary', prompt: options.initialPrompt ?? 'Exact original goal: preserve observations and continue the local task.', config: engine.getCapabilities().defaults });
  f.runId = receipt.runId; f.done = engine.waitForRun(receipt.runId); return f;
}
function active(f: Fixture): ActivePrefixCheckpoint | undefined { return f.engine.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT)?.data.active as unknown as ActivePrefixCheckpoint | undefined; }
function assertOriginalReplay(f: Fixture) {
  assert.ok(f.firstAssistantRaw); const raw = String(f.reader.prepare("SELECT data FROM messages WHERE run_id=? AND json_extract(data,'$.role')='assistant' ORDER BY ordinal LIMIT 1").get(f.runId)?.data);
  assert.equal(raw, f.firstAssistantRaw); const original = JSON.parse(raw) as Message;
  assert.equal(original.providerReplay?.items[0]?.encrypted_content, 'fixture-only-encrypted-replay-0');
}
async function waitSummary(f: Fixture, entered: ReturnType<typeof gate>): Promise<void> { await Promise.race([entered.promise, f.done.then(run => assert.fail(`Run ended before summary gate: ${run.state}/${run.error?.code}`))]); }

for (const turns of [20, 50]) for (const enabled of [false, true]) test(`actual ${turns}-turn ${enabled ? 'active-prefix' : 'disabled control'} keeps truthful observed nonce provenance`, { timeout: 30000 }, async t => {
  let omittedBeforeSummary = false;
  const f = await fixture(t, { turns, enabled, beforeSummary: async (owned, observed, index, signal) => {
    if (index) return;
    const owner = owned.engine.store.getRun(observed.request.runId), tools = owned.mainRequests.at(-1)!.tools;
    const reservedBytes = Buffer.byteLength(JSON.stringify({ messages: [], tools })) - 2;
    // This is the same bounded source and pure transport planner with memory
    // disabled. It never reads a whole snapshot or launches another model call.
    const baseline = await planContext({ workspace: owned.engine.store.getWorkspace(owner.workspaceId), snapshot: owned.engine.store.readModelHistory('session', 512, owner.config.limits.maxContextBytes * 4).snapshot,
      run: owner, config: owner.config, signal, reservedBytes, instructionSources: [] });
    assert.equal(baseline.selectedMessageIds.includes(owned.rawNonceMessage().id), false);
    assert.equal(JSON.stringify(baseline.messages).includes(owned.nonce), false); omittedBeforeSummary = true;
  } }), run = await f.done; assert.equal(run.state, 'completed', JSON.stringify(run.error));
  assert.equal(f.fullReads(), 0); assert.equal(f.mainRequests.length, turns + 1); assert.equal(f.engine.coordinator.getRunUsage(f.runId).toolCalls, turns);
  const rawNonce = f.rawNonceMessage(), last = f.mainRequests.at(-1)!; assertOriginalReplay(f);
  const diagnostics = f.engine.context.diagnostics('session')!; assert.ok(!diagnostics.plan.selectedMessageIds.includes(rawNonce.id));
  assert.equal(rawNonce.content.includes(f.nonce), true); assert.ok(Buffer.byteLength(JSON.stringify({ messages: last.messages, tools: last.tools })) <= 16_384);
  if (!enabled) { assert.equal(f.summaries.length, 0); assert.equal(active(f), undefined); assert.equal(JSON.stringify(last.messages).includes(f.nonce), false); return; }
  assert.ok(f.summaries.length > 0, JSON.stringify(diagnostics.plan.warnings)); assert.ok(f.summaries.length <= 32); const checkpoint = active(f); assert.ok(checkpoint);
  assert.equal(omittedBeforeSummary, true);
  const first = f.summaries[0]!; assert.equal(first.nonce, f.nonce); assert.ok(first.source.messages.some(message => message.id === rawNonce.id && message.role === 'tool' && message.content.includes(f.nonce)));
  assert.ok(checkpoint.coveredMessageIds.includes(rawNonce.id)); assert.equal(checkpoint.runId, f.runId); assert.equal(checkpoint.sessionId, 'session'); assert.equal(checkpoint.providerId, 'prefix-fixture'); assert.equal(checkpoint.modelId, 'prefix-model');
  const matched = f.summaries.find(observed => observed.request.attemptId === checkpoint.id); assert.ok(matched); assert.equal(checkpoint.factsSha256, hash(matched.sourceJson));
  assert.deepEqual(checkpoint.sourceMessageIds, matched.source.messages.map(message => message.id));
  const revision = f.engine.store.getContextRevision(checkpoint.revisionId); assert.equal(revision.sha256, hash(revision.text)); assert.equal(revision.runId, f.runId);
  assert.ok(checkpoint.sourceMessageIds.every(id => revision.sourceIds.includes(id))); assert.equal(revision.text.includes('fixture-only-encrypted-replay'), false);
  assert.ok(last.messages.some(message => message.content.startsWith(ACTIVE_PREFIX_MEMORY_PREFIX) && message.content.includes(f.nonce)));
  assert.ok(last.messages.some(message => message.content === 'Exact original goal: preserve observations and continue the local task.'));
  for (const assistant of last.messages.filter(message => message.role === 'assistant')) for (const call of assistant.toolCalls ?? []) assert.equal(last.messages.filter(message => message.role === 'tool' && message.toolCallId === call.id).length, 1);
});

test('actual steer arriving during prefix summary blocks stale publication and reaches the next coding request', { timeout: 30000 }, async t => {
  const entered = gate(), release = gate(); let stagedId = '';
  t.after(release.resolve);
  const f = await fixture(t, { stopAfterSummary: 1, beforeSummary: async (_owned, observed, index, signal) => { if (!index) { stagedId = observed.request.attemptId!; entered.resolve(); await waitOrAbort(release.promise, signal); } } });
  await waitSummary(f, entered);
  const steer = f.engine.scheduler.accept({ sessionId: 'session', requestId: 'new-steer', prompt: 'Exact latest steer arrived during summary', delivery: 'steer', config: f.engine.getCapabilities().defaults }); release.resolve();
  assert.equal((await f.done).state, 'completed'); assert.equal(f.fullReads(), 0); assert.equal(f.engine.store.getInput(steer.inputId).state, 'promoted');
  assert.notEqual(active(f)?.id, stagedId);
  // A fresh checkpoint after steering promotion is valid. Only the pre-arrival
  // candidate must be discarded; do not prohibit later owned memory updates.
  if (active(f)) assert.equal(active(f)!.latestUserMessageId, steer.inputId);
  assert.ok(f.mainRequests.at(-1)!.messages.some(message => message.content === 'Exact latest steer arrived during summary'));
  assert.equal(f.engine.store.readEvents('session', 0, 1024).filter(event => event.type === 'summary.completed' && event.payload.summaryAttemptId === stagedId).length, 0);
});

for (const documentKind of [ACTIVE_PREFIX_DOCUMENT, 'context.head']) test(`actual prefix ${documentKind} CAS conflict preserves the winning checkpoint and publishes no orphan summary/context revisions`, { timeout: 30000 }, async t => {
  const entered = gate(), release = gate(); let stagedId = '';
  t.after(release.resolve);
  const f = await fixture(t, { stopAfterSummary: 2, beforeSummary: async (_owned, observed, index, signal) => { if (index === 1) { stagedId = observed.request.attemptId!; entered.resolve(); await waitOrAbort(release.promise, signal); } } });
  await waitSummary(f, entered); const before = f.engine.store.getSessionDocument('session', documentKind); assert.ok(before); const memoryRevision = f.engine.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT)!.revision, winnerId = active(f)!.id;
  const winner = f.engine.store.putSessionDocument('session', documentKind, before.revision, structuredClone(before.data));
  const revisionCount = Number(f.reader.prepare('SELECT count(*) AS count FROM context_revisions WHERE session_id=?').get('session')!.count); release.resolve();
  assert.equal((await f.done).state, 'completed'); assert.equal(f.fullReads(), 0); assert.equal(active(f)!.id, winnerId); assert.notEqual(active(f)!.id, stagedId);
  assert.equal(f.engine.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT)!.revision, documentKind === ACTIVE_PREFIX_DOCUMENT ? winner.revision : memoryRevision);
  const summaryRows = f.reader.prepare("SELECT id FROM context_revisions WHERE session_id=? AND json_extract(data,'$.kind')='summary'").all('session'); assert.equal(summaryRows.length, 1);
  assert.ok(Number(f.reader.prepare('SELECT count(*) AS count FROM context_revisions WHERE session_id=?').get('session')!.count) <= revisionCount + 2);
  assert.equal(f.engine.store.readEvents('session', 0, 1024).filter(event => event.type === 'summary.completed' && event.payload.summaryAttemptId === stagedId).length, 0);
  assertOriginalReplay(f);
});

test('actual cancellation during a held summary preserves prior memory and exact retry dispatches no new provider work', { timeout: 30000 }, async t => {
  const entered = gate(), release = gate(); let stagedId = '';
  t.after(release.resolve);
  const f = await fixture(t, { beforeSummary: async (_owned, observed, index, signal) => { if (index === 1) { stagedId = observed.request.attemptId!; entered.resolve(); await waitOrAbort(release.promise, signal); } } });
  await waitSummary(f, entered); const prior = structuredClone(f.engine.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT)); assert.ok(prior);
  const nativeTurns = f.engine.store.listTurns(f.runId).length; f.engine.coordinator.cancel(f.runId);
  assert.equal((await f.done).state, 'cancelled'); assert.deepEqual(f.engine.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT), prior); assert.equal(f.fullReads(), 0);
  assert.equal(f.engine.store.listTurns(f.runId).length, nativeTurns); assert.ok(f.engine.store.listTurns(f.runId).every(turn => turn.state === 'completed'));
  assert.equal(f.engine.store.readEvents('session', 0, 1024).some(event => event.type === 'summary.completed' && event.payload.summaryAttemptId === stagedId), false);
  const mainBefore = f.mainRequests.length, summaryBefore = f.summaries.length, run = f.engine.store.getRun(f.runId);
  const duplicate = f.engine.coordinator.submit({ sessionId: 'session', requestId: 'primary', prompt: 'Exact original goal: preserve observations and continue the local task.', config: run.config });
  assert.equal(duplicate.runId, f.runId); assert.equal(duplicate.duplicate, true); assert.equal(f.mainRequests.length, mainBefore); assert.equal(f.summaries.length, summaryBefore); assertOriginalReplay(f);
});

test('actual insufficient exact source budget never dispatches or marks a prefix summary complete', { timeout: 30000 }, async t => {
  const f = await fixture(t, { prefixPolicy: { ...policy, maxSourceMessages: 1 } }); assert.equal((await f.done).state, 'completed');
  assert.equal(f.summaries.length, 0); assert.equal(active(f), undefined); assert.equal(f.fullReads(), 0);
  assert.ok(f.engine.context.diagnostics('session')!.plan.warnings.some(warning => warning.includes('ACTIVE_PREFIX_SOURCE_LIMIT')));
  assert.equal(f.engine.store.readEvents('session', 0, 1024).some(event => event.type === 'summary.dispatched' || event.type === 'summary.completed'), false); assertOriginalReplay(f);
});

test('actual truncated summary retains observed usage and output consumption without publishing memory', { timeout: 30000 }, async t => {
  const f = await fixture(t, { stopAfterSummary: 1, summaryFinish: 'length' }); assert.equal((await f.done).state, 'completed');
  assert.equal(f.summaries.length, 1); assert.equal(active(f), undefined); assert.equal(f.fullReads(), 0);
  const events = f.engine.store.readEvents('session', 0, 1024), id = f.summaries[0]!.request.attemptId;
  assert.equal(events.some(event => event.type === 'summary.completed' && event.payload.summaryAttemptId === id), false);
  assert.ok(events.some(event => event.type === 'summary.failed' && event.payload.summaryAttemptId === id && event.payload.code === 'SUMMARY_INCOMPLETE'));
  assert.ok(events.some(event => event.type === 'provider.usage' && event.payload.summaryAttemptId === id && event.payload.outputTokens === 8));
  assert.ok(f.engine.coordinator.getRunUsage(f.runId).outputBytes >= Buffer.byteLength(f.summaries[0]!.text)); assertOriginalReplay(f);
});

test('actual candidate that cannot fit the required model context never activates its prefix summary', { timeout: 30000 }, async t => {
  const f = await fixture(t, { initialPrompt: 'Exact required original constraint '.repeat(210), prefixPolicy: { ...policy, maxOutputBytes: 8192 }, stopAfterSummary: 1,
    summaryText: observed => observed.text + ' x'.repeat(Math.floor((8192 - Buffer.byteLength(observed.text)) / 2)),
  });
  const run = await f.done; assert.equal(run.state, 'completed', JSON.stringify(run.error)); assert.ok(f.summaries.length); assert.equal(active(f), undefined); assert.equal(f.fullReads(), 0);
  assert.equal(f.engine.store.readEvents('session', 0, 1024).some(event => event.type === 'summary.completed' && event.payload.scope === 'active-run-prefix'), false);
  assert.equal(f.reader.prepare("SELECT id FROM context_revisions WHERE session_id=? AND json_extract(data,'$.kind')='summary'").all('session').length, 0);
  assert.ok(f.mainRequests.at(-1)!.messages.some(message => message.content.startsWith('Exact required original constraint ')));
  assert.ok(f.engine.coordinator.getRunUsage(f.runId).outputBytes >= 8191); assertOriginalReplay(f);
});

test('actual failed read and denied proposal remain exact negative observations in a complete prefix exchange', { timeout: 30000 }, async t => {
  const f = await fixture(t, { toolCall: (index): ProviderToolCall => ({ id: `observed-${index}`, name: index === 2 ? 'write_file' : 'read_file',
    input: index === 2 ? { path: 'synthetic-not-written.txt', content: 'must never execute' } : { path: index === 1 ? 'synthetic-missing.txt' : `observation-${index}.txt` },
  }) });
  assert.equal((await f.done).state, 'completed'); assert.equal(f.fullReads(), 0);
  const failures = f.summaries.flatMap(summary => summary.source.messages).filter(message => message.role === 'tool' && ['observed-1', 'observed-2'].includes(message.toolCallId ?? ''));
  assert.equal(failures.length, 2); assert.deepEqual(failures.map(message => message.toolOutcome), ['failed', 'denied']);
  for (const fact of failures) {
    const raw = JSON.parse(String(f.reader.prepare('SELECT data FROM messages WHERE id=? AND run_id=?').get(fact.id, f.runId)!.data)) as Message;
    assert.equal(fact.content, raw.content); assert.ok(fact.internalToolCallId);
    const tool = f.reader.prepare('SELECT state FROM tools WHERE id=? AND run_id=?').get(fact.internalToolCallId, f.runId)!;
    assert.equal(fact.toolOutcome, tool.state);
    const call = f.summaries.flatMap(summary => summary.source.messages).find(message => message.role === 'assistant' && message.turnId === fact.turnId)!;
    assert.ok(call); assert.equal(call.attemptId, fact.attemptId);
  }
  assert.ok(failures.find(message => message.toolOutcome === 'denied')!.content.includes('TOOL_NOT_ALLOWED'));
  assert.equal(f.reader.prepare("SELECT count(*) AS count FROM checkpoints WHERE run_id=?").get(f.runId)!.count, 0);
  assertOriginalReplay(f);
});

for (const mode of ['default', 'opt-in'] as const) test(`actual active-prefix ${mode} media policy protects a middle image and latest text steer without putting pixels into summary facts`, { timeout: 30000 }, async t => {
  const bytes = png(); let image!: InputImageAttachment, imageMessageId = '', latestTextId = '';
  const f = await fixture(t, { turns: 30, ...(mode === 'opt-in' ? { mediaHistoryPolicy: { kind: 'reference-only-older-images', version: 1 } as MediaHistoryPolicy } : {}),
    beforeStart: async owned => { image = await owned.engine.importImage('session', bytes, 'image/png'); },
    onMain: (owned, request) => {
      if (request.turnIndex === 2) imageMessageId = owned.engine.scheduler.accept({ sessionId: 'session', requestId: 'image-steer', prompt: 'Exact image instruction remains an original input', attachments: [image], delivery: 'steer', config: owned.engine.getCapabilities().defaults }).inputId;
      if (request.turnIndex === 25) latestTextId = owned.engine.scheduler.accept({ sessionId: 'session', requestId: 'late-text-steer', prompt: 'Exact latest text instruction remains raw', delivery: 'steer', config: owned.engine.getCapabilities().defaults }).inputId;
    },
  });
  const run = await f.done; assert.equal(run.state, 'completed', JSON.stringify(run.error)); assert.equal(f.fullReads(), 0); assert.ok(f.summaries.length);
  const final = f.mainRequests.at(-1)!, checkpoint = active(f)!;
  assert.deepEqual(final.messages.filter(message => message.attachments?.length).map(message => [message.content, message.attachments]), [['Exact image instruction remains an original input', [image]]]);
  assert.deepEqual(final.resolvedImages, [{ attachment: image, data: bytes.toString('base64') }]);
  assert.ok(final.messages.some(message => message.content === 'Exact latest text instruction remains raw'));
  assert.ok(checkpoint.protectedMessageIds.includes(imageMessageId)); assert.ok(checkpoint.protectedMessageIds.includes(latestTextId)); assert.equal(checkpoint.coveredMessageIds.includes(imageMessageId), false);
  const diagnostics = f.engine.context.diagnostics('session')!; assert.deepEqual(diagnostics.activeWindow?.requiredImageAnchorIds, [imageMessageId]);
  for (const summary of f.summaries) {
    assert.equal(summary.source.messages.some(message => message.id === imageMessageId || message.id === latestTextId), false);
    assert.equal(summary.sourceJson.includes(image.id), false); assert.equal(summary.sourceJson.includes(bytes.toString('base64')), false);
    assert.equal(summary.request.resolvedImages, undefined); assert.equal(summary.request.messages.some(message => message.attachments?.length), false);
  }
  const raw = JSON.parse(String(f.reader.prepare('SELECT data FROM messages WHERE id=? AND run_id=?').get(imageMessageId, f.runId)!.data)) as Message;
  assert.equal(raw.content, 'Exact image instruction remains an original input'); assert.deepEqual(raw.attachments, [image]); assertOriginalReplay(f);
});

for (const scenario of ['part-result', 'tool-input'] as const) test(`actual SQL preflight rejects oversized ${scenario} before returning the raw field to JavaScript`, { timeout: 30000 }, async t => {
  let checked = false;
  const f = await fixture(t, { beforeSummary: async (owned, _observed, index) => {
    if (index) return;
    const writer = new DatabaseSync(join(owned.root, 'engine.sqlite'));
    const part = writer.prepare("SELECT id,data FROM message_parts WHERE run_id=? AND json_extract(data,'$.type')='tool' ORDER BY rowid LIMIT 1").get(owned.runId)!;
    const toolId = String(JSON.parse(String(part.data)).toolCallId), table = scenario === 'part-result' ? 'message_parts' : 'tools', id = scenario === 'part-result' ? String(part.id) : toolId;
    const original = writer.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)!;
    const data = JSON.parse(String(original.data)) as Record<string, unknown>;
    if (scenario === 'part-result') data.result = { output: 'Synthetic oversized observation '.repeat(400), isError: false, truncated: false };
    else data.input = { path: 'Synthetic oversized argument '.repeat(400) };
    writer.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(data), id);
    const prepare = owned.reader.prepare.bind(owned.reader); let rawPartReads = 0, maskedToolInput = false;
    owned.reader.prepare = sql => {
      const statement = prepare(sql);
      if (sql.includes('FROM message_parts') && sql.includes(' AS facts')) rawPartReads++;
      if (sql.includes('CASE WHEN') && sql.includes('input_bytes FROM tools')) {
        const get = statement.get.bind(statement);
        statement.get = (...parameters) => { const row = Reflect.apply(get, statement, parameters) as ReturnType<typeof get>; maskedToolInput = row?.input === null && Number(row.input_bytes) > 2048; return row; };
      }
      return statement;
    };
    try {
      assert.throws(() => readActivePrefixSourceDatabase(owned.reader, owned.engine.store.getRun(owned.runId), {
        stage: 'between-turns', policySha256: owned.engine.context.activePrefix!.policySha256, maxSourceMessages: 12, maxSourceBytes: 2048, keepRecentTurns: 4, maxCoveredMessages: 512,
      }), (error: unknown) => error instanceof EngineError && error.code === (scenario === 'part-result' ? 'ACTIVE_PREFIX_SOURCE_LIMIT' : 'ACTIVE_PREFIX_BINDING_MISMATCH'));
      if (scenario === 'part-result') assert.equal(rawPartReads, 0);
      else assert.equal(maskedToolInput, true);
      checked = true;
    } finally {
      owned.reader.prepare = prepare; writer.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(String(original.data), id); writer.close();
    }
  } });
  assert.equal((await f.done).state, 'completed'); assert.equal(checked, true); assert.equal(f.fullReads(), 0); assertOriginalReplay(f);
});
