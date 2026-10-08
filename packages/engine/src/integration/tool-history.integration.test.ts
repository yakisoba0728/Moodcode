import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, type ArtifactReference, type JsonObject, type RunReceipt, type Session, type SessionSnapshot, type Workspace } from '@moodcode/contracts';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent, TurnRequest } from '../ports.js';
import { TOOL_HISTORY_PREFIX } from '../context/tool-history.js';

async function command<T>(engine: MoodcodeEngine, type: string, payload: JsonObject): Promise<T> {
  const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result as unknown as T;
}
async function terminal(engine: MoodcodeEngine, sessionId: string, receipt: RunReceipt): Promise<void> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
  try {
    for await (const event of engine.subscribe(sessionId, receipt.admittedSeq - 1, abort.signal)) {
      if (event.runId === receipt.runId && ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)) {
        assert.equal(event.type, 'run.completed', JSON.stringify(engine.store.getRun(receipt.runId))); return;
      }
    }
    assert.fail('Fixture did not complete its run');
  } finally { clearTimeout(timer); abort.abort(); }
}

test('default engine persists read_file artifact, projects only past Run, replays bytes and denies another session', { timeout: 15000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-tool-history-integration-'))), repository = join(root, 'repository');
  await mkdir(repository); execFileSync('git', ['init', '-q', repository]);
  const observed = 'HISTORICAL_PRIVATE_VALUE\n' + 'row observation: '.repeat(450) + '\nTAIL_MARKER\n';
  await writeFile(join(repository, 'history.txt'), observed);
  const requests: TurnRequest[] = [], assertions: unknown[] = [];
  let engine!: MoodcodeEngine, reference!: ArtifactReference, originalToolContent = '';
  const provider: ProviderAdapter = {
    id: 'history-fixture',
    async *streamTurn(request): AsyncGenerator<ProviderEvent> {
      requests.push(structuredClone(request));
      try {
        if (requests.length === 1) {
          assert.ok(request.tools.some(tool => tool.name === 'read_file')); assert.ok(request.tools.some(tool => tool.name === 'read_artifact'));
          yield { type: 'tool.call', call: { id: 'read-file-provider', name: 'read_file', input: { path: 'history.txt' } } }; yield { type: 'finish', reason: 'tool_calls' }; return;
        }
        if (requests.length === 2) {
          const current = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'read-file-provider'); assert.ok(current);
          assert.ok(!current.content.startsWith(TOOL_HISTORY_PREFIX)); assert.equal((JSON.parse(current.content) as JsonObject).content, observed);
          originalToolContent = current.content;
          const stored = engine.store.getSnapshot(engine.store.getRun(request.runId).sessionId).messages.find(message => message.role === 'tool' && message.toolCallId === 'read-file-provider');
          assert.ok(stored?.toolResult?.artifactRefs.length); reference = stored.toolResult.artifactRefs[0]!;
          assert.equal(reference.identity.runId, request.runId); assert.ok(reference.identity.turnId); assert.ok(reference.identity.attemptId);
          yield { type: 'text.delta', delta: 'First observation recorded.' }; yield { type: 'finish', reason: 'stop' }; return;
        }
        if (requests.length === 3) {
          const historical = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'read-file-provider'); assert.ok(historical);
          assert.ok(historical.content.startsWith(`${TOOL_HISTORY_PREFIX}\n`)); assert.ok(historical.content.length < originalToolContent.length);
          const projection = JSON.parse(historical.content.slice(TOOL_HISTORY_PREFIX.length + 1)) as { historicalObservation: boolean; currentFileEvidence: boolean; artifacts: { id: string; identity: unknown }[] };
          assert.equal(projection.historicalObservation, true); assert.equal(projection.currentFileEvidence, false);
          assert.equal(projection.artifacts[0]!.id, reference.id); assert.deepEqual(projection.artifacts[0]!.identity, reference.identity);
          yield { type: 'tool.call', call: { id: 'read-artifact-provider', name: 'read_artifact', input: { artifactId: reference.id, runId: reference.identity.runId,
            toolCallId: reference.identity.toolCallId!, turnId: reference.identity.turnId!, attemptId: reference.identity.attemptId!, offset: 0, limit: 16384 } } };
          yield { type: 'finish', reason: 'tool_calls' }; return;
        }
        if (requests.length === 4) {
          const current = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'read-artifact-provider'); assert.ok(current);
          assert.ok(!current.content.startsWith(TOOL_HISTORY_PREFIX));
          const page = JSON.parse(current.content) as { bytes: string; reference: ArtifactReference; nextOffset: number | null; historicalObservation: boolean };
          assert.equal(page.nextOffset, null); assert.equal(page.historicalObservation, true); assert.deepEqual(page.reference.identity, reference.identity);
          assert.equal(Buffer.from(page.bytes, 'base64').toString('utf8'), originalToolContent);
          assert.equal((JSON.parse(Buffer.from(page.bytes, 'base64').toString('utf8')) as JsonObject).content, observed);
          yield { type: 'text.delta', delta: 'Historical observation recovered.' }; yield { type: 'finish', reason: 'stop' }; return;
        }
        if (requests.length === 5) {
          assert.ok(request.messages.every(message => !message.content.includes('HISTORICAL_PRIVATE_VALUE')));
          yield { type: 'tool.call', call: { id: 'cross-session-provider', name: 'read_artifact', input: { artifactId: reference.id, runId: reference.identity.runId,
            toolCallId: reference.identity.toolCallId!, turnId: reference.identity.turnId!, attemptId: reference.identity.attemptId! } } };
          yield { type: 'finish', reason: 'tool_calls' }; return;
        }
        assert.equal(requests.length, 6);
        const denied = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'cross-session-provider'); assert.ok(denied);
        assert.match(denied.content, /RECORD_SCOPE_MISMATCH/u); assert.ok(!denied.content.includes('HISTORICAL_PRIVATE_VALUE'));
        yield { type: 'text.delta', delta: 'The historical reference belongs to another session.' }; yield { type: 'finish', reason: 'stop' };
      } catch (error) { assertions.push(error); throw error; }
    },
  };
  engine = createEngine({ dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider] });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await command<Workspace>(engine, 'workspace.open', { path: repository });
  const session = await command<Session>(engine, 'session.create', { workspaceId: workspace.id, title: 'Artifact history fixture' });
  const config = { providerId: provider.id, modelId: 'fixture-model', mode: 'plan', limits: { ...DEFAULT_LIMITS, maxDurationMs: 10000, toolTimeoutMs: 3000 } };
  const first = await command<RunReceipt>(engine, 'run.submit', { sessionId: session.id, requestId: 'observe', prompt: 'Read history.txt', config }); await terminal(engine, session.id, first);
  const originalSnapshot = engine.store.getSnapshot(session.id), originalMessages = structuredClone(originalSnapshot.messages);
  // The file changed; recovering the artifact must still return the historical observation.
  await writeFile(join(repository, 'history.txt'), 'CURRENT_FILE_VALUE\n');
  const second = await command<RunReceipt>(engine, 'run.submit', { sessionId: session.id, requestId: 'historical', prompt: 'Recover the old observation', config }); await terminal(engine, session.id, second);
  const later = await command<SessionSnapshot>(engine, 'session.getSnapshot', { sessionId: session.id });
  assert.deepEqual(later.messages.filter(message => message.runId === first.runId), originalMessages);
  assert.deepEqual(originalSnapshot.messages, originalMessages); assert.ok(later.tools.find(tool => tool.name === 'read_artifact' && tool.runId === second.runId && tool.state === 'completed'));
  const other = await command<Session>(engine, 'session.create', { workspaceId: workspace.id, title: 'Other session' });
  const third = await command<RunReceipt>(engine, 'run.submit', { sessionId: other.id, requestId: 'foreign', prompt: 'Attempt known foreign reference', config }); await terminal(engine, other.id, third);
  const foreign = engine.store.getSnapshot(other.id); assert.equal(foreign.tools.find(tool => tool.name === 'read_artifact')?.state, 'failed');
  assert.ok(foreign.messages.every(message => !message.content.includes('HISTORICAL_PRIVATE_VALUE'))); assert.deepEqual(assertions, []); assert.equal(requests.length, 6);
});
