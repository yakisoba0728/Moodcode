import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, CodexProvider, getCodexAuthStatus, ACTIVE_PREFIX_MEMORY_PREFIX, ACTIVE_PREFIX_DOCUMENT } from '@moodcode/engine';

// Twenty fixture-directed local reads; one real summary and one real final
// answer. This checks memory transport and measured model recall, not whether
// the model autonomously chooses a twenty-turn coding strategy.
if (!process.argv.includes('--live')) throw new Error('Use --live for actual Codex account verification.');
const auth = await getCodexAuthStatus();
assert.equal(auth.state, 'ready'); assert.ok(auth.modelId);
const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-active-prefix-live-')));
const repository = join(root, 'observations'), dbPath = join(root, 'engine.sqlite');
const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sha = text => createHash('sha256').update(text).digest('hex');
const nonce = randomBytes(16).toString('hex'), turns = 20;
const observations = [], transport = new CodexProvider({ timeoutMs: 90_000 });
let engine, reader, mainCalls = 0, summaryCalls = 0, fullSnapshotReads = 0;
const report = { kind: 'active-prefix-hybrid-live', implementationCommit, timestamp: new Date().toISOString(),
  providerId: transport.id, modelId: auth.modelId, runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  scope: { fixtureDirectedLocalReadTurns: turns, requestedRealSummaries: 1, requestedRealFinalAnswers: 1, autonomousCodingStrategyVerified: false },
  actualRequests: observations, passed: false, cleanupConfirmed: false };
const provider = { id: transport.id, inputModalities: transport.inputModalities, replayProtocol: transport.replayProtocol,
  retryableHttpStatuses: transport.retryableHttpStatuses, async *streamTurn(request, signal) {
    if (!request.tools.length) {
      assert.ok(request.messages[0]?.content.startsWith('[Moodcode active-prefix summarizer v1]'));
      const source = request.messages.at(-1).content, facts = JSON.parse(source);
      assert.equal(facts.projection, 'text-and-complete-tool-observations-v1');
      assert.ok(facts.messages.some(message => message.role === 'tool' && message.content.includes(nonce)));
      assert.equal(++summaryCalls, 1);
      const observation = { purpose: 'active-prefix-summary', sourceMessageCount: facts.messages.length, factsSha256: sha(source),
        observedIdentifierInQuotedToolFacts: true, requestBytes: Buffer.byteLength(JSON.stringify(request)), finalUsage: null };
      observations.push(observation);
      for await (const event of transport.streamTurn(request, signal)) {
        if (event.type === 'usage') observation.finalUsage = { ...observation.finalUsage, ...event };
        yield event;
      }
      return;
    }
    mainCalls++;
    if (request.turnIndex < turns) {
      yield { type: 'tool.call', call: { id: 'local-observation-' + request.turnIndex, name: 'read_file', input: { path: `observation-${request.turnIndex}.txt` } } };
      yield { type: 'finish', reason: 'tool_calls' }; return;
    }
    const memory = request.messages.find(message => message.content.startsWith(ACTIVE_PREFIX_MEMORY_PREFIX));
    assert.ok(memory?.content.includes(nonce), 'Actual summary did not retain the exact observed identifier');
    assert.equal(request.messages.some(message => message !== memory && message.content.includes(nonce)), false,
      'The final answer must obtain the identifier from derived memory, not an untrimmed tool result');
    const observation = { purpose: 'final-answer', memoryContainsObservedIdentifier: true, rawIdentifierSourceInMessages: false, finalUsage: null };
    observations.push(observation);
    // The final model request is tool-free; the twenty local reads have settled.
    for await (const event of transport.streamTurn({ ...request, tools: [] }, signal)) {
      if (event.type === 'usage') observation.finalUsage = { ...observation.finalUsage, ...event };
      yield event;
    }
  } };
try {
  await mkdir(repository);
  await writeFile(join(repository, 'observation-0.txt'), `SYNTHETIC_NONCE=${nonce}\nThis exact identifier is a historical tool observation used to verify working memory.\n`);
  for (let index = 1; index < turns; index++) await writeFile(join(repository, `observation-${index}.txt`),
    'Synthetic filler observation; it supplies no replacement identifier and no user instruction. '.repeat(24));
  engine = createEngine({ dbPath, artifactDir: join(root, 'artifacts'), providers: [provider], allowedToolNames: ['read_file'],
    activePrefixPolicy: { kind: 'active-prefix-semantic', version: 1, maxSourceMessages: 12, maxSourceBytes: 12_000, maxOutputBytes: 4096, keepRecentTurns: 2, maxCoveredMessages: 128 },
    defaults: { providerId: provider.id, modelId: auth.modelId, mode: 'plan', limits: { maxTurns: 24, maxToolCalls: 24,
      maxContextBytes: 16_384, maxOutputBytes: 32_768, maxDurationMs: 180_000 },
      budgets: { turnAllowance: 24, maxSummaryCalls: 1, maxSummaryBytes: 65_536, providerRequestTimeoutMs: 90_000 } } });
  reader = new DatabaseSync(dbPath, { readOnly: true });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Live active-prefix fixture', createdAt });
  engine.store.getSnapshot = () => { fullSnapshotReads++; throw new Error('Live fixture forbids full session snapshot materialization'); };
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'read-and-recall',
    prompt: 'After the local file reading sequence finishes, return only the exact 32-character synthetic identifier originally observed in observation-0.txt. Later files are filler. Use historical working memory for that value; perform no additional tools in the final answer.',
    config: engine.getCapabilities().defaults });
  const run = await engine.waitForRun(receipt.runId); report.run = { state: run.state, error: run.error?.code ?? null };
  assert.equal(run.state, 'completed', run.error?.code);
  const answer = engine.store.getLastRunAssistantContent(run.id).trim(); assert.equal(answer, nonce);
  assert.equal(mainCalls, turns + 1); assert.equal(summaryCalls, 1); assert.equal(observations.length, 2); assert.equal(fullSnapshotReads, 0);
  const checkpoint = engine.store.getSessionDocument('session', ACTIVE_PREFIX_DOCUMENT)?.data.active;
  assert.ok(checkpoint); assert.equal(checkpoint.factsSha256, observations[0].factsSha256);
  const original = reader.prepare("SELECT id FROM messages WHERE run_id=? AND json_extract(data,'$.role')='tool' AND instr(json_extract(data,'$.content'),?)>0 ORDER BY ordinal LIMIT 1").get(run.id, nonce);
  assert.ok(original); assert.ok(checkpoint.coveredMessageIds.includes(original.id));
  const diagnostics = engine.context.diagnostics('session'); assert.ok(!diagnostics.plan.selectedMessageIds.includes(original.id));
  assert.equal(diagnostics.activePrefix.checkpointId, checkpoint.id); assert.equal(diagnostics.activePrefix.currentFileEvidence, false);
  assert.equal(engine.store.listTurns(run.id).length, turns + 1);
  report.memory = { nonceMatch: true, nonceSha256: sha(nonce), originalToolResultStillStored: true, rawSourceSelected: false,
    coveredMessageCount: checkpoint.coveredMessageIds.length, factsSha256: checkpoint.factsSha256, manifestSha256: checkpoint.manifestSha256,
    fullSnapshotReads, currentFileEvidence: false, contextBytes: diagnostics.plan.bytes, contextByteLimit: diagnostics.plan.byteLimit };
  report.runUsage = engine.coordinator.getRunUsage(run.id);
  report.regularAttemptUsage = engine.store.getNativeMetrics('session').attemptUsage;
  report.summaryUsage = checkpoint.usage;
  report.summaryUsageIncludedInRegularAttemptTotals = false;
  report.passed = true;
} catch (error) {
  report.failure = error?.code ?? 'LIVE_VERIFICATION_FAILED'; process.exitCode = 1;
} finally {
  try { if (engine) await engine.close(); }
  catch (error) { report.cleanupFailure = error?.code ?? 'CLEANUP_UNCERTAIN'; process.exitCode = 1; }
  finally {
    reader?.close(); await rm(root, { recursive: true, force: true });
    report.cleanupConfirmed = report.cleanupFailure === undefined;
  }
}
console.log(JSON.stringify(report, null, 2));
