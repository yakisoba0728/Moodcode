import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, type ArtifactReference, type Message, type SessionSnapshot } from '@moodcode/contracts';
import { ArtifactStore } from '../artifacts/store.js';
import { SqliteStore } from '../storage/index.js';
import { buildContext } from './index.js';
import { projectToolHistory, TOOL_HISTORY_PREFIX } from './tool-history.js';

const createdAt = '2026-10-07T00:00:00.000Z';
const config = { providerId: 'scripted', modelId: 'fixture', mode: 'plan' as const, limits: { ...DEFAULT_LIMITS } };
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function projection(message: Message): Record<string, unknown> { assert.ok(message.content.startsWith(`${TOOL_HISTORY_PREFIX}\n`)); return JSON.parse(message.content.slice(TOOL_HISTORY_PREFIX.length + 1)) as Record<string, unknown>; }

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-tool-history-'))), store = new SqliteStore(join(root, 'engine.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  const session = store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Fixture', createdAt });
  const old = store.admit({ sessionId: session.id, requestId: 'old', prompt: 'read old files', config });
  const artifacts = await ArtifactStore.open({ directory: join(root, 'artifacts') });
  const long = '한글 🌊 historical observation\r\n'.repeat(200) + 'OLD_TAIL';
  const refs = await Promise.all(['internal-a', 'internal-b'].map(toolCallId => artifacts.put({ identity: { sessionId: session.id, runId: old.runId, toolCallId, turnId: 'past-turn', attemptId: 'past-attempt' }, content: long })));
  const assistant: Message = { id: 'assistant-old', sessionId: session.id, runId: old.runId, role: 'assistant', content: 'Inspecting both files', createdAt,
    toolCalls: [{ id: 'provider-a', name: 'read_file', input: { path: 'a.txt' } }, { id: 'provider-b', name: 'read_file', input: { path: 'b.txt' } }] };
  const results: Message[] = refs.map((item, index) => ({ id: `result-${index}`, sessionId: session.id, runId: old.runId, role: 'tool', content: long, toolCallId: `provider-${index === 0 ? 'a' : 'b'}`, createdAt,
    toolResult: { artifactRefs: [item.reference], warnings: ['Historical output'], outcome: 'completed' } }));
  store.commit(old.runId, 'assistant.fixture', {}, { message: assistant });
  for (const message of results) store.commit(old.runId, 'tool.fixture', {}, { message });
  store.commit(old.runId, 'run.started', {}, { run: { state: 'running' } }); store.commit(old.runId, 'run.completed', {}, { run: { state: 'completed' } });
  const current = store.admit({ sessionId: session.id, requestId: 'current', prompt: 'Use old observations carefully', config });
  const currentResult: Message = { ...results[0]!, id: 'result-current', runId: current.runId, content: long + 'CURRENT_TAIL', toolCallId: 'provider-current',
    toolResult: { ...results[0]!.toolResult!, artifactRefs: [{ ...refs[0]!.reference, identity: { ...refs[0]!.reference.identity, runId: current.runId } }] } };
  store.commit(current.runId, 'tool.fixture', {}, { message: currentResult });
  return { root, store, artifacts, workspace, session, oldRunId: old.runId, currentRunId: current.runId, long, refs: refs.map(item => item.reference), results, snapshot: store.getSnapshot(session.id) };
}

test('past result projection bounds excerpts, labels historical evidence and preserves full old identity', async t => {
  const f = await fixture(t); const projected = projectToolHistory(f.snapshot, f.currentRunId);
  for (const message of projected.messages.filter(message => message.role === 'tool' && message.runId === f.oldRunId)) {
    const value = projection(message); assert.equal(value.historicalObservation, true); assert.equal(value.currentFileEvidence, false);
    assert.equal(value.toolCallId, message.toolCallId); assert.ok(Buffer.byteLength(value.excerpt as string) <= 1024);
    assert.ok(!(value.excerpt as string).includes('�')); assert.equal(value.omittedContentBytes, Buffer.byteLength(f.long) - Buffer.byteLength(value.excerpt as string));
    assert.ok(Buffer.byteLength(message.content) < Buffer.byteLength(f.long)); assert.ok(Buffer.byteLength(message.content) <= 8192);
    const ref = (value.artifacts as { id: string; identity: unknown; sha256: string }[])[0]!;
    const original = f.refs.find(item => item.id === ref.id)!; assert.deepEqual(ref.identity, original.identity); assert.equal(ref.sha256, original.sha256);
    assert.notEqual(original.identity.toolCallId, message.toolCallId, 'internal artifact identity and provider result ID remain separate');
    assert.equal((await f.artifacts.read(ref.id, { identity: original.identity, limit: 8 })).bytes.length, 8);
  }
});

test('current Run results and original SQLite snapshot/messages remain unchanged', async t => {
  const f = await fixture(t), before = structuredClone(f.snapshot); freeze(f.snapshot);
  const projected = projectToolHistory(f.snapshot, f.currentRunId);
  assert.notEqual(projected, f.snapshot); assert.notEqual(projected.messages, f.snapshot.messages);
  assert.deepEqual(f.snapshot, before); assert.deepEqual(f.store.getSnapshot(f.session.id), before);
  const current = f.snapshot.messages.find(message => message.id === 'result-current')!;
  assert.equal(projected.messages.find(message => message.id === current.id), current);
  assert.ok(current.content.endsWith('CURRENT_TAIL'));
  assert.deepEqual(projected.messages.filter(message => message.role !== 'tool'), before.messages.filter(message => message.role !== 'tool'));
  assert.equal(projected.lastSeq, before.lastSeq); assert.equal(projected.runs, f.snapshot.runs);
});

test('historical shortening keeps assistant calls and contiguous provider results paired in actual context', async t => {
  const f = await fixture(t); const source = structuredClone(f.snapshot), projected = projectToolHistory(f.snapshot, f.currentRunId);
  const messages = await buildContext({ workspace: f.workspace, snapshot: projected, config, signal: new AbortController().signal });
  const index = messages.findIndex(message => message.role === 'assistant' && message.toolCalls?.some(call => call.id === 'provider-a'));
  assert.ok(index >= 0); assert.deepEqual(messages[index]!.toolCalls, f.snapshot.messages.find(message => message.id === 'assistant-old')!.toolCalls);
  const pair = messages.slice(index + 1, index + 3); assert.ok(pair.every(message => message.role === 'tool'));
  assert.deepEqual(pair.map(message => message.toolCallId), ['provider-a', 'provider-b']);
  assert.ok(pair.every(message => message.content.startsWith(TOOL_HISTORY_PREFIX)));
  assert.deepEqual(f.snapshot, source);
});

test('small, missing-reference and invalid envelope results retain their original content', async t => {
  const f = await fixture(t), base = f.results[0]!;
  const candidates: Message[] = [{ ...base, id: 'small', content: 'small content' }, { ...base, id: 'missing', toolResult: undefined },
    { ...base, id: 'no-refs', toolResult: { artifactRefs: [], warnings: [], outcome: 'completed' } },
    { ...base, id: 'bad-outcome', toolResult: { ...base.toolResult!, outcome: 'unknown' as never } },
    { ...base, id: 'bad-ref', toolResult: { ...base.toolResult!, artifactRefs: [{ ...f.refs[0]!, sha256: 'tampered' }] } },
    { ...base, id: 'bad-warning', toolResult: { ...base.toolResult!, warnings: [42 as never] } }];
  const snapshot = { ...f.snapshot, messages: candidates }; const result = projectToolHistory(snapshot, f.currentRunId);
  assert.deepEqual(result.messages, candidates); assert.ok(result.messages.every((message, index) => message === candidates[index]));
});

test('foreign session/run references do not become trusted historical projection', async t => {
  const f = await fixture(t);
  for (const identity of [{ ...f.refs[0]!.identity, sessionId: 'different-session' }, { ...f.refs[0]!.identity, runId: f.currentRunId }]) {
    const message: Message = { ...f.results[0]!, toolResult: { ...f.results[0]!.toolResult!, artifactRefs: [{ ...f.refs[0]!, identity }] } };
    const result = projectToolHistory({ ...f.snapshot, messages: [message] }, f.currentRunId); assert.equal(result.messages[0], message);
  }
});

test('partial outcome and reference completeness are retained rather than promoted to current truth', async t => {
  const f = await fixture(t); const ref = await f.artifacts.put({ identity: f.refs[0]!.identity, content: f.long, outcome: 'interrupted', sourceComplete: false });
  const message: Message = { ...f.results[0]!, toolResult: { artifactRefs: [ref.reference], warnings: ['Output interrupted'], outcome: 'interrupted' } };
  const value = projection(projectToolHistory({ ...f.snapshot, messages: [message] }, f.currentRunId).messages[0]!);
  assert.equal(value.outcome, 'interrupted'); assert.deepEqual(value.warnings, ['Output interrupted']);
  const artifact = (value.artifacts as Record<string, unknown>[])[0]!; assert.equal(artifact.complete, false); assert.equal(artifact.outcome, 'interrupted');
  assert.equal(value.currentFileEvidence, false);
});

test('reference/warning lists are bounded with explicit omitted counts', async t => {
  const f = await fixture(t);
  const refs: ArtifactReference[] = Array.from({ length: 6 }, (_, index) => ({ ...f.refs[0]!, id: `artifact_${index.toString(16).padStart(32, '0')}` }));
  const warnings = Array.from({ length: 10 }, (_, index) => `warning ${index} ${'x'.repeat(240)}`);
  const message: Message = { ...f.results[0]!, content: 'long fixture\n'.repeat(2000), toolResult: { artifactRefs: refs, warnings, outcome: 'completed' } };
  const value = projection(projectToolHistory({ ...f.snapshot, messages: [message] }, f.currentRunId).messages[0]!);
  assert.equal((value.artifacts as unknown[]).length, 4); assert.equal(value.omittedArtifactRefs, 2);
  assert.equal((value.warnings as unknown[]).length, 8); assert.equal(value.omittedWarnings, 2);
});

test('pathological reference identity lengths never inflate the source result', async t => {
  const f = await fixture(t); const refs: ArtifactReference[] = Array.from({ length: 4 }, (_, index) => ({ ...f.refs[0]!, id: `artifact_${index.toString(16).padStart(32, '0')}`,
    identity: { ...f.refs[0]!.identity, toolCallId: 't'.repeat(512), turnId: 'u'.repeat(512), attemptId: 'a'.repeat(512) } }));
  const message: Message = { ...f.results[0]!, content: 'x'.repeat(2500), toolResult: { artifactRefs: refs, warnings: [], outcome: 'completed' } };
  const result = projectToolHistory({ ...f.snapshot, messages: [message] }, f.currentRunId); assert.equal(result.messages[0], message);
});
