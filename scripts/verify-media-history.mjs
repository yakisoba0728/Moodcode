import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createEngine, CodexProvider, getCodexAuthStatus, MEDIA_HISTORY_NOTICE_PREFIX } from '@moodcode/engine';

// Actual account calls are opt-in, confined to a temporary tool-free fixture.
if (!process.argv.includes('--live')) throw new Error('Use --live for actual Codex account verification.');
const auth = await getCodexAuthStatus();
assert.equal(auth.state, 'ready'); assert.ok(auth.modelId);
const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-media-history-live-')));
const implementationCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const observations = [], transport = new CodexProvider({ timeoutMs: 90_000 });
const provider = { id: transport.id, inputModalities: transport.inputModalities, replayProtocol: transport.replayProtocol, retryableHttpStatuses: transport.retryableHttpStatuses,
  async *streamTurn(request, signal) {
    const notice = request.messages.find(message => message.content.startsWith(MEDIA_HISTORY_NOTICE_PREFIX));
    const provenance = notice ? JSON.parse(notice.content.slice(MEDIA_HISTORY_NOTICE_PREFIX.length)) : null;
    observations.push({ imageOccurrences: request.messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0),
      resolvedImages: request.resolvedImages?.length ?? 0, omittedOccurrences: provenance?.omissions.reduce((sum, item) => sum + item.attachments.length, 0) ?? 0,
      noticeRole: notice?.role ?? null, permissionOrInstruction: provenance?.permissionOrInstruction ?? null, summarized: provenance?.summarized ?? null });
    yield* transport.streamTurn(request, signal);
  } };
const report = { kind: 'media-history-live', implementationCommit, providerId: provider.id, modelId: auth.modelId, timestamp: new Date().toISOString(),
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, runs: [], transport: observations, passed: false, cleanupConfirmed: false };
let engine;
function crc(bytes) { let state = 0xffffffff; for (const byte of bytes) { state ^= byte; for (let bit = 0; bit < 8; bit++) state = state >>> 1 ^ (state & 1 ? 0xedb88320 : 0); } return (state ^ 0xffffffff) >>> 0; }
function chunk(name, data) { const value = Buffer.alloc(data.length + 12); value.writeUInt32BE(data.length); value.write(name, 4, 4, 'ascii'); data.copy(value, 8); value.writeUInt32BE(crc(value.subarray(4, -4)), value.length - 4); return value; }
function redImage() {
  const size = 64, header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(size * (1 + 3 * size));
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) pixels[row * (1 + size * 3) + 1 + column * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
try {
  engine = createEngine({ dbPath: join(root, 'engine.sqlite'), artifactDir: join(root, 'artifacts'), providers: [provider], tools: [],
    defaults: { providerId: provider.id, modelId: auth.modelId, limits: { maxTurns: 2, maxToolCalls: 1, maxContextBytes: 8192, maxOutputBytes: 16_384, maxDurationMs: 90_000 } },
    mediaHistoryPolicy: { kind: 'reference-only-older-images', version: 1 } });
  const createdAt = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt });
  engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Live image history fixture', createdAt });
  const bytes = redImage(), ref = await engine.importImage('session', bytes, 'image/png');
  for (let index = 0; index < 2; index++) {
    const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type: 'run.submit', payload: {
      sessionId: 'session', requestId: 'image-' + index, prompt: 'Name the predominant color of the image attached to this latest user message using exactly one English color word.', attachments: [ref],
    } });
    assert.equal(result.ok, true, result.error?.code);
    const run = await engine.waitForRun(result.result.runId); assert.equal(run.state, 'completed', run.error?.code);
    const answer = engine.store.getLastRunAssistantContent(run.id).trim(); assert.match(answer, /^red[.!]?$/iu);
    report.runs.push({ state: run.state, recognizedColor: 'red' });
  }
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(item => item.imageOccurrences), [1, 1]);
  assert.deepEqual(observations.map(item => item.resolvedImages), [1, 1]);
  assert.deepEqual(observations.map(item => item.omittedOccurrences), [0, 1]);
  assert.equal(observations[1].noticeRole, 'assistant'); assert.equal(observations[1].permissionOrInstruction, false); assert.equal(observations[1].summarized, false);
  const snapshot = engine.store.getSnapshot('session'), diagnostics = engine.context.diagnostics('session');
  assert.equal(snapshot.messages.filter(message => message.attachments?.[0]?.id === ref.id).length, 2);
  assert.equal(snapshot.tools.length, 0);
  assert.equal(JSON.stringify(snapshot).includes(bytes.toString('base64')), false);
  assert.equal(JSON.stringify(engine.store.getLatestContextRevision('session')).includes(bytes.toString('base64')), false);
  const disk = await engine.getStorageUsage({ limits: { maxReportBytes: 4096 } });
  assert.ok(Buffer.byteLength(JSON.stringify(disk)) <= 4096); assert.equal(disk.images.indexStatus, 'complete'); assert.equal(disk.images.candidateFiles, 0);
  report.provenance = { rawImageMessages: 2, rawBytesInTranscript: false, omittedOccurrences: diagnostics.mediaHistory.omittedImageOccurrences, imageTokens: diagnostics.plan.inputEstimate.imageTokens, estimateComplete: diagnostics.plan.inputEstimate.complete };
  report.storage = { complete: disk.complete, indexedIds: disk.images.indexedIds, candidates: disk.images.candidateFiles, deletionPerformed: disk.images.deletionPerformed };
  report.usage = engine.store.getNativeMetrics('session').attemptUsage;
  report.passed = true;
} catch (error) {
  report.failure = error?.code ?? 'LIVE_VERIFICATION_FAILED'; process.exitCode = 1;
} finally {
  if (engine) await engine.close();
  await rm(root, { recursive: true, force: true }); report.cleanupConfirmed = true;
}
console.log(JSON.stringify(report, null, 2));
