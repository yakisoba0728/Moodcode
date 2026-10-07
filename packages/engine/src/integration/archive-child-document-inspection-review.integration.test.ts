import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type InputDocumentAttachment } from '@moodcode/contracts';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import { childStorageKind } from '../child-tasks/storage-binding.js';
import type { ChildTaskRecord } from '../child-tasks/index.js';
import { exportEngineArchive, inspectArchivedChildDocumentStorage } from '../storage/archive.js';
import { ChildDocumentReadFrame } from '../storage/child-document-reader.js';
import { SqliteStore } from '../storage/index.js';
import { RunCoordinator } from '../runner/index.js';
import { InputScheduler } from '../runner/input-scheduler.js';
import { checkDatabase } from '../recovery/snapshot.js';
import { NATIVE_SESSION_TABLES } from '../storage/native-schema.js';
import { SUMMARY_STORAGE_TABLES } from '../storage/summary-attempts.js';
import { SUMMARY_RECOVERY_TABLES } from '../recovery/summary.js';
import { ATTEMPT_CLEANUP_TABLES } from '../storage/attempt-cleanup.js';
import { PROVIDER_RECOVERY_TABLES } from '../recovery/provider.js';
import { MCP_EXECUTION_TABLES } from '../storage/mcp-executions.js';
import { KNOWLEDGE_STORAGE_TABLES } from '../knowledge/validation.js';
import { KNOWLEDGE_GENERATION_TABLES } from '../knowledge/generation-store.js';
import { KNOWLEDGE_PUBLICATION_TABLES } from '../knowledge/publication-store.js';
import { KNOWLEDGE_FILE_PUBLICATION_TABLES } from '../knowledge/file-publication-store.js';
import { KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE } from '../knowledge/file-execution-guards.js';
import { DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES } from '../diagnostics/execution-observation-store.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function hold(promise: Promise<void>, signal: AbortSignal) { let abort!: () => void; try { await Promise.race([promise, new Promise<void>(yes => { abort = yes; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); } finally { signal.removeEventListener('abort', abort); } }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function files(directory: string): Record<string, { sha256: string; bytes: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number }> {
  const result: ReturnType<typeof files> = {};
  for (const item of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, item.name); if (item.isDirectory()) Object.assign(result, files(path)); else { const info = statSync(path); result[path] = { sha256: sha(readFileSync(path)), bytes: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }; } }
  return result;
}
async function fixture(t: TestContext, options: { nested?: boolean; count?: number; documentCount?: number; legacy?: boolean; external?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-archive-child-inspection-review-'))), repository = join(directory, 'repository'), artifactDir = join(directory, 'artifacts'), dbPath = join(directory, 'engine.sqlite');
  mkdirSync(repository); execFileSync('git', ['init', '-q', '--template=', repository]); writeFileSync(join(repository, 'file.txt'), 'Authored standalone historical archive fixture.\n'); execFileSync('git', ['-C', repository, 'add', 'file.txt']); execFileSync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-qm', 'fixture']);
  const rootEntered = gate(), rootRelease = gate(), parentEntered = gate(), parentRelease = gate(), childEngines = new Map<number, MoodcodeEngine>(), references = new Map<string, InputDocumentAttachment[]>(); let calls = 0;
  const provider: ProviderAdapter = { id: 'archive-inspection-review', async *streamTurn(request, signal) {
    calls++; const prompt = request.messages.find(message => message.role === 'user')?.content;
    if (prompt === 'ROOT_HOLDER') { rootEntered.resolve(); yield { type: 'progress' }; await hold(rootRelease.promise, signal); }
    else {
      const depth = prompt === 'GRANDCHILD' ? 2 : 1, engine = childEngines.get(depth); assert.ok(engine); assert.ok(request.sessionId);
      const refs: InputDocumentAttachment[] = [];
      for (let number = 0; number < (options.documentCount ?? 1); number++) refs.push(await engine.importDocument(request.sessionId, Buffer.from(`%PDF-1.7\nAuthored bounded archive fixture ${prompt}/${number}.\n`)));
      references.set(request.runId, refs);
      if (prompt === 'CHILD_HOLDER') { parentEntered.resolve(); yield { type: 'progress' }; await hold(parentRelease.promise, signal); }
    }
    yield { type: 'text.delta', delta: 'Exact authored historical child output.' }; yield { type: 'finish', reason: 'stop' };
  } };
  const engine = createEngine({ dbPath, artifactDir, providers: [provider], tools: [], ...(options.external ? { worktreeDirectory: join(directory, 'external-children') } : {}), defaults: { providerId: provider.id, modelId: 'fixture', mode: 'plan', limits: { maxTurns: 24, maxToolCalls: 24, maxOutputBytes: 131072, maxDurationMs: 45000, toolTimeoutMs: 3000, maxContextBytes: 262144 } }, configureChild(child, task) { childEngines.set(task.depth, child); } });
  t.after(async () => { rootRelease.resolve(); parentRelease.resolve(); try { await engine.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt }); engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Historical inspection', createdAt }); engine.store.createSession({ id: 'other-session', workspaceId: 'workspace', title: 'Foreign selection owner', createdAt });
  t.mock.method(engine.store, 'getSnapshot', () => { throw new Error('Authored setup must not read whole snapshots'); });
  const count = options.count ?? (options.nested ? 2 : 1), worktrees = [];
  for (let index = 0; index < (options.nested ? 1 : count); index++) worktrees.push(await engine.createWorktree('session', `child-worktree-${index}`));
  const grandWorktree = options.nested ? await engine.prepareChildWorktree('session', worktrees[0]!.id, 'grand-worktree') : undefined;
  const root = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'root', prompt: 'ROOT_HOLDER', config: engine.getCapabilities().defaults }); await rootEntered.promise;
  const tasks: ChildTaskRecord[] = [];
  if (options.nested) {
    const first = await engine.startChildTask({ sessionId: 'session', requestId: 'child-parent', parentRunId: root.runId, worktreeId: worktrees[0]!.id, prompt: 'CHILD_HOLDER', tools: [], allocation: { turns: 4, toolCalls: 4, outputBytes: 16384, durationMs: 12000 } }); await parentEntered.promise;
    const parent = engine.children.tasks.get('session', first.id); assert.equal(parent.state, 'running'); assert.ok(parent.childRunId); assert.ok(grandWorktree);
    const second = await engine.startChildTask({ sessionId: 'session', requestId: 'grandchild', parentTaskId: parent.id, parentRunId: parent.childRunId, worktreeId: grandWorktree.id, prompt: 'GRANDCHILD', tools: [], allocation: { turns: 1, toolCalls: 1, outputBytes: 2048, durationMs: 5000 } }); const grandchild = await engine.children.tasks.wait('session', second.id); assert.equal(grandchild.state, 'completed');
    parentRelease.resolve(); const settled = await engine.children.tasks.wait('session', first.id); assert.equal(settled.state, 'completed'); tasks.push(settled, grandchild);
  } else for (const [index, worktree] of worktrees.entries()) {
    const first = await engine.startChildTask({ sessionId: 'session', requestId: `child-${index}`, parentRunId: root.runId, worktreeId: worktree.id, prompt: `CHILD_${index}`, tools: [], allocation: { turns: 1, toolCalls: 1, outputBytes: 2048, durationMs: 3000 } }); const task = await engine.children.tasks.wait('session', first.id); assert.equal(task.state, 'completed', JSON.stringify(task)); tasks.push(task);
  }
  rootRelease.resolve(); assert.equal((await engine.waitForRun(root.runId)).state, 'completed');
  if (options.legacy) { const selected = tasks[0]!; const db = new DatabaseSync(dbPath); try { db.prepare('DELETE FROM session_documents WHERE session_id=? AND kind=?').run('session', childStorageKind(selected.id)); } finally { db.close(); } }
  await engine.close(); const archive = await exportEngineArchive({ dbPath, artifactDir, destination: join(directory, 'archive') });
  const request = { directory: archive.directory, expectedManifestSha256: archive.manifestSha256, sessionId: 'session', sourceRunId: root.runId, taskIds: tasks.map(task => task.id) };
  return { directory, artifactDir, dbPath, archive, request, tasks, references, calls: () => calls, originalFiles: () => files(directory), archiveFiles: () => files(archive.directory) };
}
function engineFree(t: TestContext) {
  t.mock.method(SqliteStore.prototype, 'recoverInterrupted', () => { throw new Error('Historical archive inspection must not create an engine or recover work'); });
  t.mock.method(RunCoordinator.prototype, 'submit', () => { throw new Error('Historical archive inspection must not admit provider work'); });
  t.mock.method(InputScheduler.prototype, 'resume', () => { throw new Error('Historical archive inspection must not resume sessions'); });
}
async function reject(operation: () => unknown, codes: readonly string[]) { await assert.rejects(async () => operation(), error => error instanceof EngineError && codes.includes(error.code)); }
function observeIndexes(t: TestContext, observe: (index: Parameters<ChildDocumentReadFrame['chargeIndex']>[0]) => void) {
  const frames = new Set<ChildDocumentReadFrame>(), get = Object.getOwnPropertyDescriptor(ChildDocumentReadFrame.prototype, 'remainingMetadataBytes')!.get!;
  const probe = t.mock.getter(ChildDocumentReadFrame.prototype, 'remainingMetadataBytes', function(this: ChildDocumentReadFrame) {
    if (!frames.has(this)) { frames.add(this); const charge = this.chargeIndex; this.chargeIndex = index => { charge(index); observe(index); }; }
    return get.call(this) as number;
  });
  return { frames, stop: () => probe.mock.restore() };
}

test('standalone exact historical root child/grandchild inspection is read-only and returns imported PDF metadata', { timeout: 30000 }, async t => {
  const f = await fixture(t, { nested: true }), original = f.originalFiles(), archived = f.archiveFiles(), calls = f.calls(); engineFree(t);
  const report = await inspectArchivedChildDocumentStorage(f.request); assert.equal(report.scope, 'verified-archive-historical'); assert.equal(report.complete, true); assert.equal(report.archiveCoverage, 'complete'); assert.equal(report.manifestSha256, f.archive.manifestSha256); assert.equal(report.archiveId, f.archive.manifest.archiveId); assert.equal(report.observedChildren, 2); assert.equal(report.uncheckedChildren, 0);
  assert.equal(report.children[1]!.lineage?.parentTaskId, f.tasks[0]!.id); assert.equal(report.children[1]!.lineage?.parentRunId, f.tasks[0]!.childRunId); assert.equal(report.children[1]!.lineage?.rootRunId, f.request.sourceRunId);
  for (const child of report.children) for (const ref of f.references.get(child.childRunId!)!) {
    const sample = child.documents.find(item => item.id === ref.id);
    assert.ok(sample, 'An already-verified historical document must be identifiable by bounded metadata'); assert.deepEqual({ id: sample.id, mimeType: sample.mimeType, bytes: sample.bytes, sha256: sample.sha256 }, { id: ref.id, mimeType: ref.mimeType, bytes: ref.bytes, sha256: ref.sha256 });
  }
  assert.equal(JSON.stringify(report).includes(f.directory), false, 'Historical metadata must not expose raw storage paths'); assert.equal(JSON.stringify(report).includes('Authored bounded archive fixture'), false, 'Opaque PDF bytes are not returned as content');
  assert.deepEqual(f.originalFiles(), original); assert.deepEqual(f.archiveFiles(), archived); assert.equal(f.calls(), calls); assert.equal(report.stats.openedChildren, 2);
});

test('report byte and document sample caps mark omissions while preserving verified counts and declared totals', { timeout: 30000 }, async t => {
  const f = await fixture(t, { nested: true, documentCount: 32 }), knownBytes = [...f.references.values()].flat().reduce((sum, ref) => sum + ref.bytes, 0), report = await inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxReportBytes: 4096, maxDocumentSamples: 128 } });
  assert.equal(report.complete, false); assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 4096); assert.equal(report.observedChildren, 2); assert.equal(report.requestedChildren, 2); assert.equal(report.declaredReferenceBytes.children, knownBytes); assert.equal(report.stats.selectedRefs, 64);
  const returnedRefs = report.children.flatMap(child => child.documents);
  assert.ok(returnedRefs.length < 64); assert.equal(report.archiveCoverage, 'complete'); assert.ok(report.reasons.some(reason => /sample|report|omit/.test(reason)));
});

test('one selected child does not reduce the independent full-archive proof count and collector never rereads indexes', { timeout: 30000 }, async t => {
  const f = await fixture(t, { count: 11 }); let indexCharges = 0, indexBodies = 0;
  const probe = observeIndexes(t, () => { indexCharges++; }), prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) { if (sql.includes('SELECT d.session_id,s.workspace_id,w.root,d.data,s.data AS session_data')) indexBodies++; return prepare.call(this, sql); });
  const report = await inspectArchivedChildDocumentStorage({ ...f.request, taskIds: [f.tasks[10]!.id], limits: { maxChildren: 1 } }); assert.equal(report.complete, true); assert.equal(report.requestedChildren, 1); assert.equal(report.observedChildren, 1); assert.equal(report.children[0]!.taskId, f.tasks[10]!.id); assert.equal(report.stats.openedChildren, 11); assert.equal(probe.frames.size, 1); assert.equal(indexCharges, 12); assert.equal(indexBodies, 11);
});

test('selected historical grandchild completeness is independent from an unchecked ancestor archive coverage', { timeout: 30000 }, async t => {
  const f = await fixture(t, { nested: true, legacy: true }), selected = await inspectArchivedChildDocumentStorage({ ...f.request, taskIds: [f.tasks[1]!.id] }); assert.equal(selected.complete, true); assert.equal(selected.archiveCoverage, 'partial'); assert.equal(selected.observedChildren, 1); assert.equal(selected.uncheckedChildren, 0); assert.ok(selected.declaredReferenceBytes.children! > 0);
  const both = await inspectArchivedChildDocumentStorage(f.request); assert.equal(both.complete, false); assert.equal(both.archiveCoverage, 'partial'); assert.equal(both.uncheckedChildren, 1); assert.equal(both.declaredReferenceBytes.children, null); assert.ok(both.declaredReferenceBytes.observedChildSubtotal > 0);
});

test('external historical child selection remains unchecked with unknown totals and opens no external database', { timeout: 30000 }, async t => {
  const f = await fixture(t, { external: true }), before = files(join(f.directory, 'external-children')); const report = await inspectArchivedChildDocumentStorage(f.request); assert.equal(report.complete, false); assert.equal(report.archiveCoverage, 'partial'); assert.equal(report.observedChildren, 0); assert.equal(report.uncheckedChildren, 1); assert.equal(report.declaredReferenceBytes.children, null); assert.equal(report.stats.openedChildren, 0); assert.deepEqual(files(join(f.directory, 'external-children')), before);
});

test('a caller mutation after async entry cannot replace the validated manifest or task owner', { timeout: 30000 }, async t => {
  const f = await fixture(t, { nested: true }), request = { ...f.request, taskIds: [f.tasks[1]!.id] }, pending = inspectArchivedChildDocumentStorage(request);
  request.sessionId = 'other-session'; request.expectedManifestSha256 = '0'.repeat(64); request.taskIds[0] = `child_${'f'.repeat(32)}`;
  const report = await pending; assert.equal(report.complete, true); assert.equal(report.sessionId, 'session'); assert.equal(report.manifestSha256, f.archive.manifestSha256); assert.equal(report.children[0]!.taskId, f.tasks[1]!.id);
});

test('wrong manifest, foreign session, missing task and zero bounds reject before child index body reads', { timeout: 30000 }, async t => {
  const f = await fixture(t), before = f.archiveFiles(), prepare = DatabaseSync.prototype.prepare; let indexBodies = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) { if (sql.includes('SELECT d.session_id,s.workspace_id,w.root,d.data,s.data AS session_data')) indexBodies++; return prepare.call(this, sql); });
  await reject(() => inspectArchivedChildDocumentStorage({ ...f.request, expectedManifestSha256: '0'.repeat(64) }), ['ARCHIVE_MANIFEST_SHA_MISMATCH']);
  await reject(() => inspectArchivedChildDocumentStorage({ ...f.request, sessionId: 'other-session' }), ['ARCHIVE_CHILD_OWNER_MISMATCH']);
  await reject(() => inspectArchivedChildDocumentStorage({ ...f.request, taskIds: [`child_${'f'.repeat(32)}`] }), ['ARCHIVE_CHILD_TASK_NOT_FOUND']);
  await reject(() => inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxMetadataBytes: 0 } }), ['INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS']); assert.equal(indexBodies, 0); assert.deepEqual(f.archiveFiles(), before);
});

test('cancelled and insufficient caller proof budgets never produce a partial verified report', { timeout: 30000 }, async t => {
  const f = await fixture(t, { nested: true }), before = f.archiveFiles(), aborted = new AbortController(); aborted.abort();
  await reject(() => inspectArchivedChildDocumentStorage({ ...f.request, signal: aborted.signal }), ['ARCHIVE_ABORTED', 'CHILD_DOCUMENT_STORAGE_ABORTED']);
  await reject(() => inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxMetadataBytes: 1 } }), ['ARCHIVE_CHILD_INSPECTION_LIMIT', 'CHILD_DOCUMENT_STORAGE_METADATA_LIMIT', 'ARCHIVE_DOCUMENT_INDEX_INVALID', 'CHILD_STORAGE_SELECTION_LIMIT']);
  assert.deepEqual(f.archiveFiles(), before);
});

test('a shadowed aborted property cannot hide native cancellation from historical inspection', { timeout: 30000 }, async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(); Object.defineProperty(controller.signal, 'aborted', { value: false, enumerable: true });
  const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!; assert.equal(nativeAborted.call(controller.signal), true); assert.equal(controller.signal.aborted, false);
  await reject(() => inspectArchivedChildDocumentStorage({ ...f.request, signal: controller.signal }), ['INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS', 'ARCHIVE_ABORTED', 'CHILD_DOCUMENT_STORAGE_ABORTED']);
});

test('post-entry signal property mutation cannot erase a real cancellation while inspection awaits', { timeout: 30000 }, async t => {
  const f = await fixture(t), controller = new AbortController(), pending = inspectArchivedChildDocumentStorage({ ...f.request, signal: controller.signal });
  controller.abort(); Object.defineProperty(controller.signal, 'aborted', { value: false, enumerable: true });
  await reject(() => pending, ['INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS', 'ARCHIVE_ABORTED', 'CHILD_DOCUMENT_STORAGE_ABORTED']);
});

test('an altered manifest and same-size changed archived PDF cannot be inspected under the old exact digest', { timeout: 30000 }, async t => {
  const f = await fixture(t), path = join(f.archive.directory, 'data', 'manifest.json'), original = readFileSync(path); writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
  await reject(() => inspectArchivedChildDocumentStorage(f.request), ['ARCHIVE_MANIFEST_SHA_MISMATCH']); writeFileSync(path, original);
  const member = f.archive.manifest.documentAudit!.children[0]!, ref = f.references.get(f.tasks[0]!.childRunId!)![0]!, blob = join(f.archive.directory, 'data', member.artifactPrefix, 'input-documents', ref.id + '.blob'), bytes = readFileSync(blob), changed = Buffer.from(bytes); changed[20] = changed[20]! ^ 1; writeFileSync(blob, changed);
  await reject(() => inspectArchivedChildDocumentStorage(f.request), ['ARCHIVE_HASH_MISMATCH']); assert.equal(readFileSync(blob).length, bytes.length);
});

test('cancellation after a verified index and a manifest change during collection discard every candidate report', { timeout: 30000 }, async t => {
  const f = await fixture(t, { nested: true }), controller = new AbortController(); let cancelled = false;
  const cancel = observeIndexes(t, index => { if (index.refs.length && !cancelled) { cancelled = true; controller.abort(); } });
  await reject(() => inspectArchivedChildDocumentStorage({ ...f.request, signal: controller.signal }), ['ARCHIVE_ABORTED', 'CHILD_DOCUMENT_STORAGE_ABORTED']); assert.equal(cancelled, true); cancel.stop();
  const path = join(f.archive.directory, 'data', 'manifest.json'), original = readFileSync(path); let changed = false;
  const change = observeIndexes(t, index => { if (index.refs.length && !changed) { changed = true; writeFileSync(path, Buffer.concat([original, Buffer.from('\n')])); } });
  try { await reject(() => inspectArchivedChildDocumentStorage(f.request), ['ARCHIVE_SOURCE_CHANGED']); assert.equal(changed, true); }
  finally { change.stop(); writeFileSync(path, original); }
});

function resignChildFixture(f: Awaited<ReturnType<typeof fixture>>, mutate: (db: DatabaseSync) => void) {
  const member = f.archive.manifest.documentAudit!.children[0]!, path = join(f.archive.directory, 'data', member.database.file), db = new DatabaseSync(path);
  // Authored fixture construction deliberately runs the full logical-hash
  // reader. Its raw JSON reads are separate from production index-proof caps.
  try { mutate(db); const version = Number(db.prepare('PRAGMA user_version').get()!.user_version); member.database.logicalHash = checkDatabase(db, version, ['workspaces', 'sessions', 'inputs', 'runs', 'messages', 'tools', 'approvals', 'checkpoints', 'events', ...NATIVE_SESSION_TABLES, 'attempt_usage', ...SUMMARY_STORAGE_TABLES, ...SUMMARY_RECOVERY_TABLES, ...ATTEMPT_CLEANUP_TABLES, ...PROVIDER_RECOVERY_TABLES, ...MCP_EXECUTION_TABLES, ...KNOWLEDGE_STORAGE_TABLES, ...(version >= 11 ? KNOWLEDGE_GENERATION_TABLES : []), ...(version >= 12 ? KNOWLEDGE_PUBLICATION_TABLES : []), ...(version >= 13 ? [...KNOWLEDGE_FILE_PUBLICATION_TABLES, KNOWLEDGE_FILE_EXECUTION_GUARD_TABLE] : []), ...(version >= 14 ? DIAGNOSTIC_EXECUTION_OBSERVATION_TABLES : [])], () => {}); }
  finally { db.close(); }
  const bytes = readFileSync(path); member.database.bytes = bytes.length; member.database.sha256 = sha(bytes); Object.assign(f.archive.manifest.artifacts.find(item => item.file === member.database.file)!, { bytes: bytes.length, sha256: sha(bytes) });
  const manifest = Buffer.from(JSON.stringify(f.archive.manifest)); writeFileSync(join(f.archive.directory, 'data', 'manifest.json'), manifest); return { ...f.request, expectedManifestSha256: sha(manifest) };
}
test('a resigned archive with an oversized foreign child owner fails before index-proof bodies despite full logical validation', { timeout: 30000 }, async t => {
  const f = await fixture(t), request = resignChildFixture(f, db => { db.prepare("UPDATE sessions SET data=json_set(data,'$.id',?)").run('foreign_' + 'x'.repeat(9 * 1024 * 1024)); }), prepare = DatabaseSync.prototype.prepare; let indexBodies = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) { if (sql.includes('SELECT d.session_id,s.workspace_id,w.root,d.data,s.data AS session_data')) indexBodies++; return prepare.call(this, sql); });
  await reject(() => inspectArchivedChildDocumentStorage(request), ['CHILD_DOCUMENT_STORAGE_OWNER_MISMATCH']); assert.equal(indexBodies, 0);
});
