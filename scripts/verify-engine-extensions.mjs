import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createEngine, CodexProvider, getCodexAuthStatus, SqliteStore } from '@moodcode/engine';

// Explicit opt-in: real account requests, limited to this temporary local fixture.
if (!process.argv.includes('--live')) throw new Error('Use --live for actual Codex account verification.');
const auth = await getCodexAuthStatus();
assert.equal(auth.state, 'ready'); assert.ok(auth.modelId);
const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-extensions-live-')));
const repository = join(root, 'repository'), artifactDir = join(root, 'artifacts');
const nonce = 'observation_' + randomUUID().replaceAll('-', '').slice(0, 12);
const allocation = { turns: 3, toolCalls: 2, outputBytes: 16384, durationMs: 45000 };
const childPrompt = 'Use read_file on observed.txt once. Report its exact marker text. Do not request any other tool or action.';
const requested = { requestId: 'observe-live', prompt: childPrompt, allocation, tools: ['read_file'] };
const report = { kind: 'engine-extensions-live', providerId: 'codex', modelId: auth.modelId, timestamp: new Date().toISOString(), tasks: [], cleanupConfirmed: false };
let engine, pump, approvalFailure;
const abort = new AbortController();
async function command(type, payload) {
  const result = await engine.dispatch({ schemaVersion: 1, commandId: randomUUID(), type, payload });
  if (!result.ok) throw new Error(result.error?.code ?? 'ENGINE_COMMAND_FAILED'); return result.result;
}
function crc(bytes) { let state = 0xffffffff; for (const byte of bytes) { state ^= byte; for (let bit = 0; bit < 8; bit++) state = state >>> 1 ^ (state & 1 ? 0xedb88320 : 0); } return (state ^ 0xffffffff) >>> 0; }
function chunk(name, data) { const value = Buffer.alloc(data.length + 12); value.writeUInt32BE(data.length); value.write(name, 4, 4, 'ascii'); data.copy(value, 8); value.writeUInt32BE(crc(value.subarray(4, -4)), value.length - 4); return value; }
function redImage() {
  const size = 64, header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(size * (1 + 3 * size));
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) pixels[row * (1 + size * 3) + 1 + column * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
try {
  await mkdir(repository); execFileSync('git', ['init', '-q', repository]); await writeFile(join(repository, 'observed.txt'), nonce + '\n');
  execFileSync('git', ['-C', repository, 'add', '.']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Moodcode Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  engine = createEngine({ dbPath: join(root, 'engine.sqlite'), artifactDir, providers: [new CodexProvider({ timeoutMs: 90000 })],
    allowedToolNames: ['delegate_task', 'read_file'], defaults: { providerId: 'codex', modelId: auth.modelId } });
  const workspace = await command('workspace.open', { path: repository });
  const session = await command('session.create', { workspaceId: workspace.id, title: 'Live read-only delegation fixture' });
  pump = (async () => { for await (const event of engine.subscribe(session.id, 0, abort.signal)) {
    if (event.type !== 'approval.requested') continue;
    const snapshot = engine.store.getSnapshot(session.id), approval = snapshot.approvals.find(value => value.id === event.payload.approvalId && value.status === 'pending');
    if (!approval) continue;
    const tool = snapshot.tools.find(value => value.id === approval.toolCallId), input = tool?.input;
    const allow = tool?.name === 'delegate_task' && input?.requestId === requested.requestId && input?.prompt === requested.prompt
      && input?.allocation && Object.keys(input.allocation).length === 4 && Object.keys(allocation).every(key => input.allocation[key] === allocation[key]) && JSON.stringify(input?.tools) === JSON.stringify(requested.tools);
    if (!allow) approvalFailure = 'UNEXPECTED_FIXTURE_APPROVAL';
    await command('approval.decide', { approvalId: approval.id, fingerprint: approval.fingerprint, decision: allow ? 'allow' : 'deny' });
  } })();
  const accepted = await command('run.submit', { sessionId: session.id, requestId: 'delegation-parent',
    prompt: `Call delegate_task exactly once with this exact input JSON: ${JSON.stringify(requested)}. Use its returned child observation to report the marker. Do not read the file directly or request any other action.`,
    config: { mode: 'build', limits: { maxTurns: 8, maxToolCalls: 8, maxDurationMs: 150000, toolTimeoutMs: 60000 } } });
  const run = await engine.waitForRun(accepted.runId); assert.equal(run.state, 'completed', run.error?.code);
  assert.equal(approvalFailure, undefined);
  const tasks = engine.children.tasks.list(session.id); assert.equal(tasks.length, 1); const task = tasks[0];
  assert.equal(task.state, 'completed'); assert.equal(task.deliveryState, 'none'); assert.ok(task.outcome?.content.includes(nonce));
  const child = new SqliteStore(join(artifactDir, 'children', task.id, 'engine.sqlite'));
  let childTools, childUsage;
  try { const childRun = child.getRun(task.childRunId); childTools = child.getSnapshot(childRun.sessionId).tools;
    assert.equal(childRun.state, 'completed'); assert.equal(childTools.length, 1); assert.equal(childTools[0].name, 'read_file'); assert.equal(childTools[0].state, 'completed'); childUsage = child.getNativeMetrics(childRun.sessionId).attemptUsage;
  } finally { await child.closeAsync(); }
  assert.equal(await readFile(join(repository, 'observed.txt'), 'utf8'), nonce + '\n');
  const duplicate = await engine.startChildTask({ sessionId: session.id, requestId: task.requestId, parentRunId: run.id, worktreeId: task.worktreeId,
    prompt: childPrompt, tools: requested.tools, allocation }); assert.equal(duplicate.id, task.id);
  report.tasks.push({ id: 'read-only-delegation', passed: true, runState: run.state, childState: task.state, childReadTools: childTools.length, deliveryState: task.deliveryState,
    duplicateReused: duplicate.id === task.id, usage: engine.store.getNativeMetrics(session.id).attemptUsage, childUsage });
  abort.abort(); await pump; pump = undefined;
  const mediaSession = await command('session.create', { workspaceId: workspace.id, title: 'Live image input fixture' });
  const bytes = redImage(), ref = await engine.importImage(mediaSession.id, bytes, 'image/png');
  const media = await command('run.submit', { sessionId: mediaSession.id, requestId: 'image-color', prompt: 'Name the predominant color in the attached image with exactly one English color word. Do not call tools.', attachments: [ref],
    config: { mode: 'plan', limits: { maxTurns: 2, maxToolCalls: 1, maxDurationMs: 90000 } } });
  const mediaRun = await engine.waitForRun(media.runId); assert.equal(mediaRun.state, 'completed', mediaRun.error?.code);
  const snapshot = engine.store.getSnapshot(mediaSession.id), answer = snapshot.messages.findLast(message => message.role === 'assistant')?.content.trim() ?? '';
  assert.match(answer, /^red[.!]?$/iu); assert.equal(snapshot.tools.length, 0); assert.equal(JSON.stringify(snapshot).includes(bytes.toString('base64')), false);
  report.tasks.push({ id: 'image-color', passed: true, runState: mediaRun.state, recognizedColor: 'red', imageBytes: ref.bytes,
    rawBytesInTranscript: false, estimateComplete: engine.context.diagnostics(mediaSession.id).plan.inputEstimate.complete, usage: engine.store.getNativeMetrics(mediaSession.id).attemptUsage });
} catch (error) {
  report.failure = error?.code ?? error?.message ?? 'LIVE_VERIFICATION_FAILED'; process.exitCode = 1;
} finally {
  abort.abort(); if (pump) await pump.catch(() => { process.exitCode = 1; });
  if (engine) await engine.close(); await rm(root, { recursive: true, force: true }); report.cleanupConfirmed = true;
}
console.log(JSON.stringify(report, null, 2));
