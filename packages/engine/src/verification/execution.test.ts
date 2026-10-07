import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type Checkpoint, type JsonObject } from '@moodcode/contracts';
import type { ToolContext, ToolResult } from '../ports.js';
import { SqliteStore } from '../storage/index.js';
import { ArtifactStore } from '../artifacts/store.js';
import { createToolResultEnvelope } from '../artifacts/result.js';
import { createArtifactReadTool } from '../tools/session/artifact.js';
import { ScopedToolRuntime } from '../tools/runtime/index.js';
import { VerificationCheckRegistry, VerificationPlanService } from './plans.js';
import { VerificationReceiptService } from './receipts.js';
import { importOwnedCommandEvidence, observeOwnedCommandResult, verificationNestedContext, verificationResult, type VerificationToolHost } from './execution.js';

const stamp = '2026-10-07T01:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (value: string) => (error: unknown) => error instanceof EngineError && error.code === value;
async function fixture(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-verification-evidence-'))), root = join(base, 'workspace'), rawDir = join(base, 'raw');
  await mkdir(root); await mkdir(rawDir); await mkdir(join(rawDir, 'command-owner'));
  const stdout = join(rawDir, 'command-owner', 'stdout.log'), stderr = join(rawDir, 'command-owner', 'stderr.log');
  await writeFile(stdout, 'original stdout'); await writeFile(stderr, 'original stderr');
  const store = new SqliteStore(join(base, 'engine.sqlite')); t.after(async () => { store.close(); await rm(base, { recursive: true, force: true }); });
  const workspace = store.putWorkspace({ id: 'workspace', root, gitRoot: root, branch: null, createdAt: stamp }); store.createSession({ id: 'session', workspaceId: workspace.id, title: 'Evidence', createdAt: stamp });
  const input = store.acceptInput({ sessionId: 'session', requestId: 'request', prompt: 'verify', delivery: 'queue', config: { providerId: 'fixture', modelId: 'fixture', mode: 'build', limits: { ...DEFAULT_LIMITS, toolTimeoutMs: 1000 } } });
  const run = store.promoteInput(input.inputId).run; store.commit(run.id, 'run.started', {}, { run: { state: 'running' } });
  store.commit(run.id, 'tool.requested', {}, { tool: { id: 'owned-command', sessionId: 'session', runId: run.id, name: 'verify_changes', input: { checkId: 'tests' }, state: 'running' } });
  const registry = new VerificationCheckRegistry(), definition = { id: 'tests', revision: 1, workspaceId: workspace.id, command: 'host-owned-command-fixture', cwd: root, profileId: 'builder', profileRevision: 'profile-1', sourceRevision: 'host-check-1', timeoutMs: 1000, maxOutputBytes: 4096, required: true };
  registry.register(definition); const check = registry.capture('tests');
  const plans = new VerificationPlanService(store, registry), receipts = new VerificationReceiptService(plans), source = { sha256: sha('actual source'), revision: 'source-1', checkpointId: null };
  const plan = plans.create('session', run.id, 0, { checkIds: ['tests'], source });
  const pending = receipts.begin('session', run.id, plan.revision, { checkId: check.id, toolCallId: 'owned-command', preparedFingerprint: sha('opaque prepared'), source });
  const dispatched = receipts.dispatch('session', run.id, pending.revision, pending.receipt.id, source);
  const published: Checkpoint[] = [];
  const context: ToolContext = { workspace, sessionId: 'session', runId: run.id, toolCallId: 'owned-command', signal: new AbortController().signal, limits: { ...run.config.limits }, artifactDir: rawDir,
    recordCheckpoint(cp) { store.commit(run.id, 'workspace.changed', { checkpointId: cp.id }, { checkpoint: cp }); published.push(cp); } };
  const checkpoint: Checkpoint = { id: 'actual-checkpoint', runId: run.id, toolCallId: context.toolCallId, kind: 'command', createdAt: stamp, files: [], warnings: [] }; context.recordCheckpoint(checkpoint);
  const output = (text: string) => ({ text, totalBytes: Buffer.byteLength(text), observedBytes: Buffer.byteLength(text), capturedBytes: Buffer.byteLength(text), captureTruncatedBytes: 0, modelBytes: Buffer.byteLength(text), modelSourceBytes: Buffer.byteLength(text), modelTruncatedBytes: 0, artifactBytes: Buffer.byteLength(text), artifactTruncatedBytes: 0 });
  const result: ToolResult = { content: 'actual command model prefix', data: { status: 'completed', command: check.command, cwd: root, timeoutMs: 1000, exitCode: 0, signal: null, started: true, cancelled: false, timedOut: false, cleanupConfirmed: true, terminationScope: 'posix-process-group', outputAccountingComplete: true, stdout: output('original stdout'), stderr: output('original stderr'), checkpointId: checkpoint.id }, artifacts: [{ path: stdout, bytes: 15, truncated: false }, { path: stderr, bytes: 15, truncated: false }] };
  const artifacts = await ArtifactStore.open({ directory: join(base, 'managed') });
  const runtime = new ScopedToolRuntime();
  const host: VerificationToolHost = { plans, receipts, getRun: id => store.getRun(id), sourceObservation: async () => source, commandRuntime: runtime, captureCatalogue: () => runtime.catalogue('empty'), artifacts };
  const observed = () => observeOwnedCommandResult(result, check, dispatched.receipt, context, published, source);
  return { base, rawDir, stdout, stderr, store, run, context, check, receipt: dispatched.receipt, dispatched, result, source, artifacts, host, observed, receipts, plans, published };
}

test('bounded physically read original logs become native read_artifact inputs that actually read their stored bytes', async t => {
  const f = await fixture(t), owned = f.observed(); owned.observation.artifactRefs = await importOwnedCommandEvidence(f.host, owned, f.result, f.receipt, f.context);
  const settled = f.receipts.settle('session', f.run.id, f.dispatched.revision, f.receipt.id, owned.observation).receipt;
  const result = verificationResult(f.result, settled, 'saved', f.context), header = JSON.parse(result.content.split('\n')[0]!);
  assert.equal(header.verification.status, 'pass'); assert.equal(header.read_artifact[0].artifactId, settled.observation!.artifactRefs[0]!.id);
  const read = createArtifactReadTool(f.store, async () => f.artifacts), ctx = { ...f.context, toolCallId: 'reader', recordCheckpoint() { assert.fail('Historical artifact read must never produce a checkpoint'); } };
  const readResult = await read.execute(await read.prepare(header.read_artifact[0], ctx), ctx), page = JSON.parse(readResult.content);
  assert.equal(Buffer.from(page.bytes, 'base64').toString('utf8'), 'original stdout'); assert.equal(page.historicalObservation, true);
});

test('raw path, replaced byte count and hard-link substitution cannot be imported as original command evidence', async t => {
  const f = await fixture(t), owned = f.observed(); await writeFile(f.stdout, 'changed size');
  await assert.rejects(importOwnedCommandEvidence(f.host, owned, f.result, f.receipt, f.context), code('VERIFICATION_LOG_INTEGRITY_FAILED'));
  await writeFile(f.stdout, 'original stdout'); await link(f.stdout, join(f.base, 'second-name'));
  await assert.rejects(importOwnedCommandEvidence(f.host, f.observed(), f.result, f.receipt, f.context), code('VERIFICATION_LOG_INTEGRITY_FAILED'));
  await unlink(join(f.base, 'second-name')); await unlink(f.stdout); await writeFile(join(f.base, 'outside'), 'original stdout'); await symlink(join(f.base, 'outside'), f.stdout);
  await assert.rejects(importOwnedCommandEvidence(f.host, f.observed(), f.result, f.receipt, f.context), code('VERIFICATION_LOG_PATH_UNSAFE'));
});

test('unpublished or foreign checkpoint IDs never become cleanup evidence or a passing observation', async t => {
  const f = await fixture(t); (f.result.data as JsonObject).checkpointId = 'invented-checkpoint'; const absent = f.observed();
  assert.equal(absent.observation.executionCheckpointId, null); assert.equal(absent.observation.cleanup.evidenceSha256, null); assert.equal(absent.observation.executionComplete, false);
  (f.result.data as JsonObject).checkpointId = f.published[0]!.id; f.published[0] = { ...f.published[0]!, toolCallId: 'foreign' };
  assert.throws(f.observed, code('VERIFICATION_CHECKPOINT_MISMATCH'));
});

test('managed artifact references must match physically hashed stored content and current execution ownership', async t => {
  const f = await fixture(t), artifact = await f.artifacts.put({ identity: { sessionId: 'session', runId: f.run.id, toolCallId: 'other-tool' }, content: 'foreign evidence' });
  f.result.structuredResult = createToolResultEnvelope({ displayContent: f.result.content, artifactRefs: [artifact.reference] });
  const owned = f.observed(); await assert.rejects(importOwnedCommandEvidence(f.host, owned, f.result, f.receipt, f.context), code('ARTIFACT_OWNER_MISMATCH'));
  // Earlier original logs remain truthful partial evidence when a later managed reference fails.
  assert.equal(owned.observation.artifactRefs.length, 2);
});

test('model projection preserves actual source byte accounting while explicitly bounding Unicode original command text', async t => {
  const f = await fixture(t), owned = f.observed(), receipt = f.receipts.settle('session', f.run.id, f.dispatched.revision, f.receipt.id, owned.observation).receipt;
  const original = { ...f.result, content: '가'.repeat(500), structuredResult: createToolResultEnvelope({ displayContent: '가'.repeat(500) }) };
  const projected = verificationResult(original, receipt, 'saved', { ...f.context, limits: { ...f.context.limits, maxOutputBytes: 300 } });
  assert.ok(Buffer.byteLength(projected.content) <= 300); assert.equal(projected.content.includes('\ufffd'), false);
  const accounting = projected.structuredResult!.metadata!.verificationProjection as JsonObject;
  assert.equal(accounting.originalCommandModelBytes, 1500); assert.equal((accounting.retainedCommandModelBytes as number) + (accounting.omittedCommandModelBytes as number), 1500);
  assert.deepEqual((projected.data as JsonObject).stdout, (f.result.data as JsonObject).stdout); assert.equal(JSON.parse(projected.content.split('\n')[0]!).verification.status, 'pass');
});

test('unresolved evidence getter is bounded and eventual resolution cannot import logs after deadline', async t => {
  const f = await fixture(t); let release!: (value: ArtifactStore) => void, puts = 0;
  const put = f.artifacts.put.bind(f.artifacts); f.artifacts.put = async input => { puts++; return put(input); };
  f.host.artifacts = () => new Promise<ArtifactStore>(done => { release = done; });
  await assert.rejects(importOwnedCommandEvidence(f.host, f.observed(), f.result, f.receipt, f.context)); release(f.artifacts);
  await new Promise(done => setTimeout(done, 10)); assert.equal(puts, 0);
});

test('derived command context preserves owner signal, budgets, lock and forwards publication before capture', async t => {
  const f = await fixture(t), calls: string[] = [], original = { ...f.context, executionLockPath: join(f.base, 'lock'), budgets: { maxArtifactBytes: 4096 } as ToolContext['budgets'], recordCheckpoint() { calls.push('publish'); } };
  const nested = verificationNestedContext(original, { ...f.check, timeoutMs: 100, maxOutputBytes: 200 }, () => calls.push('capture'));
  assert.equal(nested.signal, original.signal); assert.equal(nested.budgets, original.budgets); assert.equal(nested.executionLockPath, original.executionLockPath); assert.equal(nested.runId, original.runId); assert.equal(nested.toolCallId, original.toolCallId); assert.equal(nested.limits.maxOutputBytes, 200); assert.equal(nested.limits.toolTimeoutMs, 100); assert.equal(original.limits.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes);
  nested.recordCheckpoint(f.published[0]!); assert.deepEqual(calls, ['publish', 'capture']);
  const rejected = verificationNestedContext({ ...original, recordCheckpoint() { throw new Error('publication failed'); } }, f.check, () => assert.fail('Failed publication cannot become captured evidence'));
  assert.throws(() => rejected.recordCheckpoint(f.published[0]!));
});
