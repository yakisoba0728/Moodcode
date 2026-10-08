import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type InputDocumentAttachment } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import { ChildDocumentReadFrame } from './child-document-reader.js';
import { SqliteStore } from './index.js';
import { exportEngineArchive, inspectArchivedChildDocumentStorage, validateEngineArchive } from './archive.js';
import { restoreV1Fixture } from './fixtures/v1-fixture.js';
import { V1_DATABASE_FIXTURE } from './fixtures/v1-database.js';

const errorCode = (...codes: string[]) => (error: unknown) => error instanceof EngineError && codes.includes(error.code);
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const preparationArchiveBudgetMs = 30000;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => resolve = yes); return { promise, resolve }; }
async function wait(promise: Promise<void>, signal: AbortSignal) {
  if (signal.aborted) throw new Error('Authored fixture cancelled');
  let abort!: () => void;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { abort = () => reject(new Error('Authored fixture cancelled')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); })]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function authoredArchive(t: TestContext, documentCount = 3) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-historical-archive-review-'))), repository = join(directory, 'repo'), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
  mkdirSync(repository); execFileSync('git', ['init', '-q', '--template=', repository]);
  writeFileSync(join(repository, 'source.txt'), 'Authored isolated archive fixture.\n'); execFileSync('git', ['-C', repository, 'add', 'source.txt']);
  execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture']);
  const entered = deferred(), release = deferred(), refs: InputDocumentAttachment[] = []; let calls = 0, childEngine: ReturnType<typeof createEngine> | undefined;
  const provider: ProviderAdapter = { id: 'authored-historical-archive', async *streamTurn(request, signal) {
    calls++;
    if (request.messages.find(message => message.role === 'user')?.content === 'ROOT') { entered.resolve(); yield { type: 'progress' }; await wait(release.promise, signal); }
    else {
      assert.ok(childEngine); assert.ok(request.sessionId);
      for (let number = 0; number < documentCount; number++) refs.push(await childEngine.importDocument(request.sessionId, Buffer.from(`%PDF-1.7\nAuthored document ${number}.\n`)));
    }
    yield { type: 'text.delta', delta: 'Authored local provider result.' }; yield { type: 'finish', reason: 'stop' };
  } };
  const engine = createEngine({ dbPath, artifactDir, providers: [provider], tools: [], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'plan', limits: { maxTurns: 8, maxToolCalls: 8, maxOutputBytes: 65536, maxDurationMs: 30000, toolTimeoutMs: 2000, maxContextBytes: 262144 } }, configureChild(child) { childEngine = child; } });
  t.after(async () => { release.resolve(); try { await engine.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const createdAt = new Date().toISOString(); engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt }); engine.store.createSession({ id: 'session', workspaceId: 'workspace', title: 'Archive fixture', createdAt });
  const worktree = await engine.createWorktree('session', 'archive-child');
  const root = engine.scheduler.submitLegacy({ sessionId: 'session', requestId: 'root', prompt: 'ROOT', config: engine.getCapabilities().defaults }); await entered.promise;
  const task = await engine.startChildTask({ sessionId: 'session', requestId: 'child', parentRunId: root.runId, worktreeId: worktree.id, prompt: 'CHILD', tools: [], allocation: { turns: 1, toolCalls: 1, outputBytes: 2048, durationMs: 5000 } });
  assert.equal((await engine.children.tasks.wait('session', task.id)).state, 'completed'); release.resolve(); assert.equal((await engine.waitForRun(root.runId)).state, 'completed'); await engine.close();
  const archive = await exportEngineArchive({ dbPath, artifactDir, destination: join(directory, 'archive'), archiveDocumentBudgetMs: preparationArchiveBudgetMs });
  return { directory, archive, refs, calls: () => calls, request: { directory: archive.directory, expectedManifestSha256: archive.manifestSha256, sessionId: 'session', sourceRunId: root.runId, taskIds: [task.id] } };
}

test('archive preparation may consume its explicit budget while the historical inspector retains its two-second frame', async t => {
  const clock = performance.now.bind(performance), descriptor = Object.getOwnPropertyDescriptor(ChildDocumentReadFrame.prototype, 'remainingMetadataBytes')!, frames = new Map<ChildDocumentReadFrame, number>(); let offset = 0;
  t.mock.method(performance, 'now', () => clock() + offset);
  Object.defineProperty(ChildDocumentReadFrame.prototype, 'remainingMetadataBytes', { ...descriptor, get(this: ChildDocumentReadFrame) {
    if (!frames.has(this)) {
      frames.set(this, this.limits.maxDurationMs);
      if (this.limits.maxDurationMs === preparationArchiveBudgetMs && offset === 0) offset = 2500;
    }
    return descriptor.get!.call(this);
  } });
  t.after(() => Object.defineProperty(ChildDocumentReadFrame.prototype, 'remainingMetadataBytes', descriptor));
  const f = await authoredArchive(t);
  assert.ok([...frames.values()].includes(preparationArchiveBudgetMs));
  frames.clear();
  assert.equal((await inspectArchivedChildDocumentStorage(f.request)).complete, true);
  assert.equal(frames.size, 1);
  assert.deepEqual([...frames.values()], [2000]);
});

test('historical PDF samples are detached bounded metadata and sample omissions preserve reference subtotals', async t => {
  const f = await authoredArchive(t), before = f.calls(), manifest = readFileSync(join(f.archive.directory, 'data', 'manifest.json'));
  const full = await inspectArchivedChildDocumentStorage(f.request);
  assert.equal(full.complete, true); assert.deepEqual(full.children[0]!.documents, f.refs); assert.equal(full.children[0]!.documentsOmitted, 0);
  const serialized = JSON.stringify(full); assert.equal(serialized.includes(f.directory), false, 'Report does not expose source or copied archive paths'); assert.equal(serialized.includes('%PDF'), false);
  const limited = await inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxDocumentSamples: 1 } });
  assert.equal(limited.complete, false); assert.equal(limited.children[0]!.documents.length, 1); assert.equal(limited.children[0]!.documentsOmitted, 2);
  assert.deepEqual(limited.declaredReferenceBytes, full.declaredReferenceBytes); assert.equal(limited.children[0]!.documentCount, 3);
  const counts = await inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxDocumentSamples: 0 } });
  assert.equal(counts.complete, false); assert.deepEqual(counts.children[0]!.documents, []); assert.equal(counts.children[0]!.documentsOmitted, 3);
  assert.deepEqual(counts.declaredReferenceBytes, full.declaredReferenceBytes);
  full.children[0]!.documents[0]!.sha256 = '0'.repeat(64);
  assert.deepEqual((await inspectArchivedChildDocumentStorage(f.request)).children[0]!.documents, f.refs, 'Mutating a detached report cannot mutate stored proof or another report');
  assert.equal(f.calls(), before); assert.deepEqual(readFileSync(join(f.archive.directory, 'data', 'manifest.json')), manifest);
});

test('historical collector shares the audit frame and validates every PDF index exactly once', async t => {
  const f = await authoredArchive(t), descriptor = Object.getOwnPropertyDescriptor(ChildDocumentReadFrame.prototype, 'remainingMetadataBytes')!, frames = new Set<ChildDocumentReadFrame>(); let indexes = 0;
  Object.defineProperty(ChildDocumentReadFrame.prototype, 'remainingMetadataBytes', { ...descriptor, get(this: ChildDocumentReadFrame) {
    if (!frames.has(this)) { frames.add(this); const original = this.chargeIndex; t.mock.method(this, 'chargeIndex', (index: Parameters<typeof original>[0]) => { indexes++; return original(index); }); }
    return descriptor.get!.call(this);
  } });
  t.after(() => Object.defineProperty(ChildDocumentReadFrame.prototype, 'remainingMetadataBytes', descriptor));
  const report = await inspectArchivedChildDocumentStorage(f.request);
  assert.equal(frames.size, 1); assert.equal(indexes, 2, 'One primary and one child index, with no collector or samples reread'); assert.equal(report.stats.openedChildren, 1); assert.equal(report.stats.selectedRefs, 3);
  assert.equal(report.coverage.executionAuthority, 'not-granted'); assert.equal(report.coverage.cleanup, 'not-performed');
});

test('full historical proof budget exhaustion rejects before copying selected index bodies', async t => {
  const f = await authoredArchive(t), prepare = DatabaseSync.prototype.prepare; let indexBodies = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) { if (sql.includes('SELECT d.session_id,s.workspace_id,w.root,d.data,s.data AS session_data')) indexBodies++; return prepare.call(this, sql); });
  await assert.rejects(inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxMetadataBytes: 1 } }), errorCode('CHILD_DOCUMENT_STORAGE_METADATA_LIMIT'));
  await assert.rejects(inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxRows: 1 } }), errorCode('CHILD_DOCUMENT_STORAGE_ROW_LIMIT'));
  assert.equal(indexBodies, 0);
  await assert.rejects(inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxDatabaseBytes: 100 } }), errorCode('CHILD_DOCUMENT_STORAGE_DATABASE_LIMIT'));
  assert.equal(indexBodies, 0);
  assert.equal((await inspectArchivedChildDocumentStorage(f.request)).complete, true, 'Failed scopes release every SQLite handle and cannot poison a later operation');
});

test('report byte trimming reuses proven references and cannot change the whole audit accounting', async t => {
  const f = await authoredArchive(t, 24), full = await inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxDocumentSamples: 128 } });
  const trimmed = await inspectArchivedChildDocumentStorage({ ...f.request, limits: { maxDocumentSamples: 128, maxReportBytes: 4096 } });
  assert.equal(full.complete, true); assert.equal(full.children[0]!.documents.length, 24);
  assert.equal(trimmed.complete, false); assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 4096); assert.ok(trimmed.reasons.includes('report-byte-limit'));
  assert.equal(trimmed.children[0]!.documentCount, 24); assert.ok(trimmed.children[0]!.documents.length < 24); assert.ok(trimmed.documentsOmitted! > 0);
  assert.deepEqual(trimmed.declaredReferenceBytes, full.declaredReferenceBytes); assert.equal(trimmed.stats.selectedRefs, full.stats.selectedRefs); assert.equal(trimmed.stats.selectedMetadataBytes, full.stats.selectedMetadataBytes); assert.equal(trimmed.stats.rawMirrorBytes, full.stats.rawMirrorBytes);
});

test('root native owner mismatch is rejected without returning its oversized raw JSON or selected proof', async t => {
  const f = await authoredArchive(t), path = join(f.archive.directory, 'data', 'engine.sqlite'), originalBytes = readFileSync(path), writer = new DatabaseSync(path);
  try { writer.prepare("UPDATE runs SET data=json_set(data,'$.sessionId',?) WHERE id=?").run('foreign-' + 'x'.repeat(9 * 1024 * 1024), f.request.sourceRunId); }
  finally { writer.close(); }
  const prepare = DatabaseSync.prototype.prepare; let rawRows = 0, indexes = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) { if (sql.startsWith('SELECT * FROM')) rawRows++; if (sql.includes('SELECT d.session_id,s.workspace_id,w.root,d.data,s.data AS session_data')) indexes++; return prepare.call(this, sql); });
  await assert.rejects(inspectArchivedChildDocumentStorage(f.request), errorCode('ARCHIVE_CHILD_OWNER_MISMATCH')); assert.equal(rawRows, 0); assert.equal(indexes, 0);
  writeFileSync(path, originalBytes); assert.equal((await inspectArchivedChildDocumentStorage(f.request)).complete, true, 'An owner rejection closes the read transaction before a later independently validated inspection');
});

test('existing archive validation starts its document deadline after full hashes while explicit inspection budgets the full operation', async t => {
  const f = await authoredArchive(t), prepare = DatabaseSync.prototype.prepare; let now = 0, advanced = false;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'PRAGMA quick_check(1)' && !advanced) { advanced = true; now += 3000; }
    return prepare.call(this, sql);
  });
  assert.doesNotThrow(() => validateEngineArchive({ directory: f.archive.directory }), 'Existing public validation retains its proof-only two-second deadline boundary'); assert.equal(advanced, true);
  now = 0; advanced = false;
  await assert.rejects(inspectArchivedChildDocumentStorage(f.request), errorCode('CHILD_DOCUMENT_STORAGE_TIME_LIMIT'), 'The explicit inspector keeps the same entry frame through full validation'); assert.equal(advanced, true);
});

test('standalone archive request rejects live authority fields and proxies before filesystem access', async () => {
  let traps = 0; const proxy = new Proxy({}, { get() { traps++; throw new Error('Proxy access'); }, ownKeys() { traps++; throw new Error('Proxy keys'); }, getPrototypeOf() { traps++; throw new Error('Proxy prototype'); } });
  await assert.rejects(inspectArchivedChildDocumentStorage(proxy as never), errorCode('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS')); assert.equal(traps, 0);
  const base = { directory: '/never-open-authored-archive', expectedManifestSha256: 'a'.repeat(64), sessionId: 'session', sourceRunId: 'run', taskIds: [] };
  await assert.rejects(inspectArchivedChildDocumentStorage({ ...base, record: {} } as never), errorCode('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
  await assert.rejects(inspectArchivedChildDocumentStorage({ ...base, currentHostIdentity: {} } as never), errorCode('INVALID_ARCHIVED_CHILD_DOCUMENT_STORAGE_OPTIONS'));
});

test('a genuine v1 archive retains unchecked overall coverage and empty historical selection without engine creation', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-historical-legacy-review-'))), dbPath = join(directory, 'engine.sqlite'), artifactDir = join(directory, 'artifacts');
  mkdirSync(artifactDir); restoreV1Fixture(dbPath, directory); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archive = await exportEngineArchive({ dbPath, artifactDir, destination: join(directory, 'archive'), archiveDocumentBudgetMs: preparationArchiveBudgetMs }), before = readFileSync(join(archive.directory, 'data', 'engine.sqlite'));
  // A pre-audit archive legitimately omitted this optional metadata. Its native
  // v1 schema has no typed child binding that could be downgraded by omission.
  const manifestPath = join(archive.directory, 'data', 'manifest.json'), legacy = JSON.parse(readFileSync(manifestPath, 'utf8')); delete legacy.documentAudit; const legacyBytes = Buffer.from(JSON.stringify(legacy)); writeFileSync(manifestPath, legacyBytes);
  t.mock.method(SqliteStore.prototype, 'recoverInterrupted', () => { throw new Error('Inspection must not instantiate SqliteStore'); });
  const request = { directory: archive.directory, expectedManifestSha256: sha(legacyBytes), sessionId: V1_DATABASE_FIXTURE.ids.sessionId, sourceRunId: V1_DATABASE_FIXTURE.ids.terminalRunId, taskIds: [] };
  const report = await inspectArchivedChildDocumentStorage(request); assert.equal(report.archiveCoverage, 'unchecked'); assert.equal(report.requestedChildren, 0); assert.equal(report.stats.openedChildren, 0);
  await assert.rejects(inspectArchivedChildDocumentStorage({ ...request, taskIds: ['child_' + 'f'.repeat(32)] }), errorCode('ARCHIVE_CHILD_TASK_NOT_FOUND'));
  assert.deepEqual(readFileSync(join(archive.directory, 'data', 'engine.sqlite')), before); assert.equal(sha(before), archive.manifest.databases[0]!.sha256);
});
