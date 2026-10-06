import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createEngine, CodexProvider, getCodexAuthStatus } from '@moodcode/engine';

if (!process.argv.includes('--live')) throw new Error('Use --live for actual Codex account verification.');
const auth = await getCodexAuthStatus(); assert.equal(auth.state, 'ready'); assert.ok(auth.modelId);
const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-session-image-live-')));
const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const observations = [], transport = new CodexProvider({ timeoutMs: 90_000 });
let engine, fullSnapshotReads = 0;
const provider = { id: transport.id, inputModalities: transport.inputModalities, replayProtocol: transport.replayProtocol, retryableHttpStatuses: transport.retryableHttpStatuses,
  async *streamTurn(request, signal) {
    assert.equal(request.tools.length, 0);
    const observation = { imageOccurrences: request.messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0),
      resolvedImages: request.resolvedImages?.length ?? 0, latestUserContainsImage: Boolean(request.messages.findLast(message => message.role === 'user')?.attachments?.length), finalUsage: null };
    observations.push(observation);
    for await (const event of transport.streamTurn(request, signal)) { if (event.type === 'usage') observation.finalUsage = { ...observation.finalUsage, ...event }; yield event; }
  } };
const report = { kind: 'session-image-restart-live', implementationCommit, timestamp: new Date().toISOString(), providerId: provider.id, modelId: auth.modelId,
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, actualRequests: observations, passed: false, cleanupConfirmed: false };
function chunk(name, data) {
  const value = Buffer.alloc(data.length + 12); value.writeUInt32BE(data.length); value.write(name, 4, 4, 'ascii'); data.copy(value, 8);
  let state = 0xffffffff; for (const byte of value.subarray(4, -4)) { state ^= byte; for (let bit = 0; bit < 8; bit++) state = state >>> 1 ^ (state & 1 ? 0xedb88320 : 0); }
  value.writeUInt32BE((state ^ 0xffffffff) >>> 0, value.length - 4); return value;
}
function redImage() {
  const size = 64, header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(size * (1 + 3 * size)); for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) pixels[row * (1 + size * 3) + 1 + column * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
try {
  const options = { dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], tools: [],
    defaults: { providerId: provider.id, modelId: auth.modelId, limits: { maxTurns: 2, maxToolCalls: 1, maxContextBytes: 8192, maxOutputBytes: 16_384, maxDurationMs: 90_000 } } };
  engine = createEngine(options); const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Live session image fixture', createdAt });
  const bytes = redImage(), ref = await engine.importImage('session', bytes, 'image/png');
  const submit = async (requestId, prompt, attachments) => {
    const response = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'run.submit', payload: { sessionId: 'session', requestId, prompt, ...(attachments ? { attachments } : {}) } });
    assert.equal(response.ok, true, response.error?.code); const run = await engine.waitForRun(response.result.runId); assert.equal(run.state, 'completed', run.error?.code); return run;
  };
  const old = await submit('image', 'Keep this image as visual context. Reply only READY, without naming its colors.', [ref]);
  assert.match(engine.store.getLastRunAssistantContent(old.id).trim(), /^READY[.!]?$/u);
  const originalMessageId = engine.context.diagnostics('session').sessionImageAnchor.messageId;
  await engine.close(); engine = createEngine(options);
  engine.store.getSnapshot = () => { fullSnapshotReads++; throw new Error('Cross-Run verification forbids full snapshot reads'); };
  const current = await submit('new-text', 'This new user message has no attachment. Name the predominant color of the earlier image using exactly one English color word.');
  assert.match(engine.store.getLastRunAssistantContent(current.id).trim(), /^red[.!]?$/iu);
  assert.equal(observations.length, 2); assert.deepEqual(observations.map(item => item.imageOccurrences), [1, 1]);
  assert.deepEqual(observations.map(item => item.resolvedImages), [1, 1]); assert.deepEqual(observations.map(item => item.latestUserContainsImage), [true, false]);
  const diagnostics = engine.context.diagnostics('session'); assert.equal(diagnostics.sessionImageAnchor.messageId, originalMessageId);
  assert.equal(diagnostics.sessionImageAnchor.runId, old.id); assert.equal(fullSnapshotReads, 0);
  const page = engine.store.readModelHistory('session', 512, 32768);
  assert.equal(page.snapshot.messages.filter(message => message.attachments?.length).length, 1);
  assert.equal(JSON.stringify(page.snapshot).includes(bytes.toString('base64')), false);
  assert.equal(engine.store.getLatestContextRevision('session').text.includes(bytes.toString('base64')), false);
  report.result = { firstRun: old.state, restartedTextRun: current.state, predominantColor: 'red', oldAssistantNamedColor: false,
    currentRunHasNoImageAttachment: true, rawImageMessages: 1, referenceSha256: ref.sha256, imageBytesSha256: createHash('sha256').update(bytes).digest('hex'),
    anchorMatchesOriginalMessage: true, anchorOwnerIsEarlierRun: true, fullSnapshotReads, rawPixelsInTranscript: false,
    contextBytes: diagnostics.plan.bytes, contextByteLimit: diagnostics.plan.byteLimit, imageTokenCost: diagnostics.plan.inputEstimate.imageTokens ?? null };
  report.usage = engine.store.getNativeMetrics('session').attemptUsage; report.passed = true;
} catch (error) { report.failure = error?.code ?? 'LIVE_VERIFICATION_FAILED'; process.exitCode = 1; }
finally {
  try { if (engine) await engine.close(); }
  catch (error) { report.cleanupFailure = error?.code ?? 'CLEANUP_UNCERTAIN'; process.exitCode = 1; }
  finally { await rm(root, { recursive: true, force: true }); report.cleanupConfirmed = report.cleanupFailure === undefined; }
}
console.log(JSON.stringify(report, null, 2));
