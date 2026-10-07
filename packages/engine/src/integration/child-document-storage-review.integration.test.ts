import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { InputDocumentAttachment } from '@moodcode/contracts';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import { inspectInputDocumentIndex } from '../storage/input-document-index.js';
import { SqliteStore } from '../storage/index.js';
import { childStorageKind } from '../child-tasks/storage-binding.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function hold(release: ReturnType<typeof deferred>, signal: AbortSignal) {
  let abort!: () => void;
  const cancelled = new Promise<void>(yes => { abort = yes; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  try { await Promise.race([release.promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function fixture(t: TestContext, external: boolean, heldChild = false, customInside = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'moodcode-child-document-scope-'))), repository = join(root, 'repo'), artifacts = join(root, 'artifacts');
  await mkdir(repository);
  execFileSync('git', ['init', '-q', repository]);
  await writeFile(join(repository, 'file.txt'), 'An authored child storage fixture.\n');
  execFileSync('git', ['-C', repository, 'add', 'file.txt']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const childDirectory = external ? join(root, 'external-child-data') : join(artifacts, customInside ? 'custom-children' : 'children'), release = deferred(), parentEntered = deferred(), childRelease = deferred(), childImported = deferred();
  const pdf = Buffer.from('%PDF-1.7\nMoodcode authored opaque child diagnostic bytes.\n', 'ascii');
  let childEngine: MoodcodeEngine | undefined, childSessionId: string | undefined, document: InputDocumentAttachment | undefined, providerCalls = 0;
  const provider: ProviderAdapter = {
    id: 'child-storage-fixture',
    async *streamTurn(request, signal) {
      providerCalls++;
      if (request.messages.some(message => message.role === 'user' && message.content === 'parent')) {
        parentEntered.resolve(); yield { type: 'progress' }; await hold(release, signal);
      } else {
        assert.ok(childEngine); assert.ok(request.sessionId);
        childSessionId = request.sessionId;
        // This is an explicit fixture host import, not a model tool or provider file request.
        document = await childEngine.importDocument(childSessionId, pdf);
        childImported.resolve();
        if (heldChild) await hold(childRelease,signal);
      }
      yield { type: 'text.delta', delta: 'Fixture observation.' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const options = {
    dbPath: join(root, 'engine.sqlite'), artifactDir: artifacts,
    ...(external || customInside ? { worktreeDirectory: childDirectory } : {}),
    providers: [provider], defaults: { providerId: provider.id, modelId: 'fixture', mode: 'build' as const },
    configureChild: (engine: MoodcodeEngine) => { childEngine = engine; },
  };
  const engine = createEngine(options);
  t.after(async () => { release.resolve(); childRelease.resolve(); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const stamp = new Date().toISOString();
  engine.store.putWorkspace({ id: 'workspace', root: repository, gitRoot: repository, branch: null, createdAt: stamp });
  engine.store.createSession({ id: 'parent-session', workspaceId: 'workspace', title: 'Child storage review', createdAt: stamp });
  let fullSnapshots = 0;
  t.mock.method(engine.store, 'getSnapshot', () => { fullSnapshots++; throw new Error('Whole snapshots are outside this fixture'); });
  const worktree = await engine.createWorktree('parent-session', 'worktree');
  const receipt = engine.scheduler.submitLegacy({ sessionId: 'parent-session', requestId: 'parent', prompt: 'parent', config: engine.getCapabilities().defaults });
  await parentEntered.promise;
  const started = await engine.startChildTask({ sessionId: 'parent-session', requestId: 'child', parentRunId: receipt.runId, worktreeId: worktree.id, prompt: 'child', tools: ['read_file'], allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 5000 } });
  await childImported.promise;
  const task = heldChild ? engine.children.tasks.get('parent-session',started.id) : await engine.children.tasks.wait('parent-session', started.id);
  assert.equal(task.state, heldChild ? 'running' : 'completed'); assert.ok(task.childRunId); assert.ok(document); assert.ok(childSessionId); assert.ok(childEngine);
  // The temporary path follows the constructor inputs of this exact fixture.
  // It is not a discovery or authority mechanism proposed for a host API.
  const childDbPath = join(childDirectory, task.id, 'engine.sqlite'), childArtifacts = join(childDirectory, task.id, 'artifacts');
  assert.deepEqual(await readFile(join(childArtifacts, 'input-documents', document.id + '.blob')), pdf);
  if (!heldChild) assert.throws(() => childEngine!.store.getSession(childSessionId!), error => error instanceof Error && 'code' in error && error.code === 'STORE_CLOSED');
  const finishParent = async () => { release.resolve(); assert.equal((await engine.waitForRun(receipt.runId)).state, 'completed'); };
  return { engine, options, root, artifacts, childDirectory, childDbPath, childArtifacts, childSessionId, task, document, pdf, finishParent, childRelease, calls: () => providerCalls, snapshots: () => fullSnapshots };
}

for (const external of [false, true]) {
  test(`actual ${external ? 'external' : 'internal'} child document bytes and primary-only diagnostic coverage are distinct`, async t => {
    const f = await fixture(t, external), rootJournal = f.engine.store.getSessionDocument('parent-session', 'engine.child_tasks'), calls = f.calls();
    assert.equal(f.engine.store.inspectInputDocumentIndex().totalDocuments, 0);
    const childReport=await f.engine.getChildDocumentStorageUsage({sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id]});
    assert.equal(childReport.complete,true,JSON.stringify(childReport));
    assert.equal(childReport.observedChildren,1);assert.equal(childReport.uncheckedChildren,0);
    assert.equal(childReport.children[0]!.childSessionId,f.childSessionId);assert.equal(childReport.children[0]!.indexedReferences,1);
    assert.equal(childReport.children[0]!.storageLocation,external?'host-configured-external':'inside-root-artifacts');
    assert.equal(childReport.declaredReferenceBytes.children,f.pdf.length);assert.equal(childReport.declaredReferenceBytes.sum,f.pdf.length);
    assert.equal(childReport.coverage.parentChildBytes,'not-added');assert.equal(childReport.coverage.blobIntegrity,'not-verified');
    assert.ok(!JSON.stringify(childReport).includes(f.root));
    const child = new DatabaseSync(f.childDbPath, { readOnly: true, timeout: 0 });
    try {
      child.exec('BEGIN');
      const before = inspectInputDocumentIndex(child);
      assert.equal(before.complete, true); assert.equal(before.totalDocuments, 1); assert.equal(before.declaredBytes, f.pdf.byteLength);
      assert.equal(before.refs[0]!.sessionId, f.childSessionId); assert.equal(before.documentIds[0], f.document.id);
      const run = child.prepare('SELECT session_id FROM runs WHERE id=?').get(f.task.childRunId!);
      assert.equal(run?.session_id, f.childSessionId);
      const report = await f.engine.getStorageUsage();
      assert.equal(report.complete, true); assert.equal(report.documents.indexStatus, 'complete');
      assert.equal(report.documents.indexedIds, 0); assert.equal(report.documents.candidateFiles, 0);
      assert.equal(report.documents.coverage, 'root-input-documents-only');
      assert.equal(report.coverage.childDocumentIndexes, 'not-read'); assert.equal(report.coverage.externalStorage, 'not-discovered');
      assert.equal(report.coverage.contentsRead, false); assert.equal(report.coverage.databaseOpened, false);
      if (external) assert.equal(report.groups.children.logicalPathBytes, 0);
      else assert.ok(report.groups.children.logicalPathBytes >= f.pdf.byteLength);
      assert.deepEqual(inspectInputDocumentIndex(child).refs, before.refs);
      assert.deepEqual(f.engine.store.getSessionDocument('parent-session', 'engine.child_tasks'), rootJournal);
      assert.equal(f.calls(), calls); assert.equal(f.snapshots(), 0);
      assert.equal(Object.hasOwn(f.task, 'childSessionId'), false);
      assert.equal(Object.hasOwn(f.task, 'storageAuthority'), false);
      child.exec('COMMIT');
    } finally { child.close(); }
    await f.finishParent();
  });
}

test('restart preserves terminal child and exact durable storage authority without redispatch', async t => {
  const f = await fixture(t, false); await f.finishParent();
  const calls = f.calls(), before = f.engine.children.tasks.get('parent-session', f.task.id);
  await f.engine.close();
  const reopened = createEngine(f.options);
  t.after(() => reopened.close());
  let snapshots = 0;
  t.mock.method(reopened.store, 'getSnapshot', () => { snapshots++; throw new Error('Whole snapshots are outside this fixture'); });
  assert.deepEqual(reopened.children.tasks.get('parent-session', f.task.id), before);
  const childReport=await reopened.getChildDocumentStorageUsage({sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id]});
  assert.equal(childReport.complete,true,JSON.stringify(childReport));assert.equal(childReport.children[0]!.childSessionId,f.childSessionId);
  const report = await reopened.getStorageUsage();
  assert.equal(report.documents.indexedIds, 0); assert.equal(report.coverage.childDocumentIndexes, 'not-read');
  assert.ok(report.groups.children.logicalPathBytes >= f.pdf.byteLength);
  assert.deepEqual(await readFile(join(f.childArtifacts, 'input-documents', f.document.id + '.blob')), f.pdf);
  assert.equal(f.calls(), calls); assert.equal(snapshots, 0);
  const stored = reopened.store.getSessionDocument('parent-session', 'engine.child_tasks')!;
  assert.equal(JSON.stringify(stored).includes(f.childSessionId), false);
  assert.equal(JSON.stringify(stored).includes(f.childDbPath), false);
  assert.ok(JSON.stringify(reopened.store.getSessionDocument('parent-session',childStorageKind(f.task.id))).includes(f.childSessionId));
  await reopened.close();
});

test('active child index is unchecked until confirmed close and diagnostics never change task/provider ownership',async t=>{
  const f=await fixture(t,false,true),before=f.engine.children.tasks.get('parent-session',f.task.id),calls=f.calls();
  const input={sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id]};
  const active=await f.engine.getChildDocumentStorageUsage(input);
  assert.equal(active.complete,false);assert.equal(active.children[0]!.authorityStatus,'active');assert.equal(active.children[0]!.status,'unchecked');
  assert.equal(active.stats.openedChildren,0);assert.equal(active.stats.rawMirrorBytes,0);assert.equal(active.declaredReferenceBytes.children,null);assert.equal(active.declaredReferenceBytes.sum,null);
  assert.deepEqual(f.engine.children.tasks.get('parent-session',f.task.id),before);assert.equal(f.calls(),calls);
  f.childRelease.resolve();assert.equal((await f.engine.children.tasks.wait('parent-session',f.task.id)).state,'completed');
  const closed=await f.engine.getChildDocumentStorageUsage(input);assert.equal(closed.complete,true,JSON.stringify(closed));assert.equal(f.calls(),calls);await f.finishParent();
});

test('reowned and hot-sidecar child storage is unchecked before any child mirror bytes are copied',async t=>{
  const f=await fixture(t,false),input={sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id]};
  const owner=new SqliteStore(f.childDbPath);
  try{const report=await f.engine.getChildDocumentStorageUsage(input);assert.equal(report.complete,false);assert.equal(report.children[0]!.status,'unchecked');assert.ok(report.children[0]!.reasons.some(reason=>/OWNER_BUSY|HOT_DATABASE/u.test(reason)),JSON.stringify(report));assert.equal(report.stats.rawMirrorBytes,0);assert.equal(report.declaredReferenceBytes.sum,null);}
  finally{await owner.closeAsync();}
  await writeFile(f.childDbPath+'-wal',Buffer.alloc(0));
  try{const report=await f.engine.getChildDocumentStorageUsage(input);assert.equal(report.complete,false);assert.ok(report.children[0]!.reasons.includes('CHILD_DOCUMENT_STORAGE_HOT_DATABASE'));assert.equal(report.stats.rawMirrorBytes,0);}
  finally{await rm(f.childDbPath+'-wal');}
  assert.equal((await f.engine.getChildDocumentStorageUsage(input)).complete,true);await f.finishParent();
});

test('root selection and child indexes share metadata cap and retain unknown totals on a truncated observation',async t=>{
  const f=await fixture(t,false),input={sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id]},full=await f.engine.getChildDocumentStorageUsage(input);
  assert.equal(full.complete,true,JSON.stringify(full));
  const maxMetadataBytes=full.stats.selectedMetadataBytes-1,limited=await f.engine.getChildDocumentStorageUsage({...input,limits:{maxMetadataBytes}});
  assert.equal(limited.complete,false);assert.ok(limited.stats.selectedMetadataBytes<=maxMetadataBytes);assert.equal(limited.declaredReferenceBytes.sum,null);assert.equal(limited.declaredReferenceBytes.children,null);
  assert.deepEqual(await readFile(join(f.childArtifacts,'input-documents',f.document.id+'.blob')),f.pdf);
  assert.equal(f.snapshots(),0);assert.equal((await f.engine.getChildDocumentStorageUsage(input)).complete,true);await f.finishParent();
});

test('a configured child base inside artifactDir is reported as internal without changing the filesystem scanner',async t=>{
  const f=await fixture(t,false,false,true),report=await f.engine.getChildDocumentStorageUsage({sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id]});
  assert.equal(report.complete,true,JSON.stringify(report));assert.equal(report.children[0]!.storageLocation,'inside-root-artifacts');assert.equal(report.coverage.parentChildBytes,'not-added');
  assert.equal((await f.engine.getStorageUsage()).coverage.childDocumentIndexes,'not-read');await f.finishParent();
});

test('request cancellation after root selection prevents child copying and does not cancel the parent Run',async t=>{
  const f=await fixture(t,false),before=f.engine.children.tasks.get('parent-session',f.task.id),controller=new AbortController(),calls=f.calls();
  const report=f.engine.getChildDocumentStorageUsage({sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id],signal:controller.signal});controller.abort('authored fixture');
  await assert.rejects(report,error=>error instanceof Error&&'code'in error&&error.code==='CANCELLED');
  assert.equal(f.engine.store.getRun(f.task.rootRunId).state,'running');assert.deepEqual(f.engine.children.tasks.get('parent-session',f.task.id),before);assert.equal(f.calls(),calls);
  assert.equal((await f.engine.getChildDocumentStorageUsage({sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id]})).complete,true);await f.finishParent();
});

test('host close during an actual source mirror read joins owned descriptor, owner lease and temporary mirror cleanup',async t=>{
  const f=await fixture(t,false),actualRead=fs.readSync,actualTemporary=fs.mkdtempSync;let closing:Promise<void>|undefined,temporary:string|undefined;
  t.mock.method(fs,'mkdtempSync',(...args:Parameters<typeof fs.mkdtempSync>)=>{const result=actualTemporary(...args);if(String(args[0]).includes('moodcode-child-document-reader-'))temporary=String(result);return result;});
  t.mock.method(fs,'readSync',(...args:unknown[])=>{const result=Reflect.apply(actualRead,fs,args);if(typeof args[3]==='number'&&args[3]>100&&!closing)closing=f.engine.close();return result;});
  syncBuiltinESMExports();
  try{
    await assert.rejects(f.engine.getChildDocumentStorageUsage({sessionId:'parent-session',sourceRunId:f.task.rootRunId,taskIds:[f.task.id]}),error=>error instanceof Error&&'code'in error&&error.code==='CANCELLED');
    assert.ok(closing);await closing;assert.ok(temporary);await assert.rejects(fs.promises.lstat(temporary),error=>error instanceof Error&&'code'in error&&error.code==='ENOENT');
    const nextOwner=new SqliteStore(f.childDbPath);await nextOwner.closeAsync();
    assert.throws(()=>f.engine.store.getSession('parent-session'),error=>error instanceof Error&&'code'in error&&error.code==='STORE_CLOSED');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();if(closing)await closing;}
});

test('a naive readOnly SQLite connection to a closed WAL child is not a filesystem-no-write diagnostic', async t => {
  const f = await fixture(t, false), directory = join(f.childDirectory, f.task.id);
  const before = await readdir(directory);
  assert.equal(before.includes('engine.sqlite-wal'), false);
  assert.equal(before.includes('engine.sqlite-shm'), false);
  const reader = new DatabaseSync(f.childDbPath, { readOnly: true, timeout: 0 });
  try {
    assert.equal(reader.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    const index = inspectInputDocumentIndex(reader);
    assert.equal(index.documentIds[0], f.document.id);
    const during = await readdir(directory);
    assert.ok(during.includes('engine.sqlite-wal'), 'This fixture must expose the WAL companion opened by SQLite');
    assert.ok(during.includes('engine.sqlite-shm'), 'readOnly must not be mistaken for a filesystem-no-write connection');
  } finally { reader.close(); }
  await f.finishParent();
});

test('an exact existing child owner-file read transaction excludes a new actual storage owner', async t => {
  const f = await fixture(t, false), ownerPath = f.childDbPath + '.owner.sqlite';
  const before = await readFile(ownerPath), directoryBefore = (await readdir(join(f.childDirectory, f.task.id))).sort();
  const lease = new DatabaseSync(ownerPath, { readOnly: true, timeout: 0 });
  try {
    lease.exec('BEGIN');
    lease.prepare('SELECT count(*) AS tables FROM sqlite_schema').get();
    assert.throws(() => new SqliteStore(f.childDbPath), error => error instanceof Error && 'code' in error && error.code === 'DB_LOCKED');
    assert.deepEqual(await readFile(ownerPath), before);
    assert.deepEqual((await readdir(join(f.childDirectory, f.task.id))).sort(), directoryBefore);
    lease.exec('COMMIT');
  } finally { lease.close(); }
  const owner = new SqliteStore(f.childDbPath);
  try { assert.equal(owner.getSession(f.childSessionId).id, f.childSessionId); }
  finally { await owner.closeAsync(); }
  await f.finishParent();
});

test('an immutable attached reader under the child owner-file read lease observes a stopped child without original WAL sidecars', async t => {
  const f = await fixture(t, false), directory = join(f.childDirectory, f.task.id), before = (await readdir(directory)).sort();
  assert.equal(before.includes('engine.sqlite-wal'), false); assert.equal(before.includes('engine.sqlite-shm'), false);
  const lease = new DatabaseSync(f.childDbPath + '.owner.sqlite', { readOnly: true, timeout: 0 }), reader = new DatabaseSync(':memory:', { timeout: 0 });
  try {
    lease.exec('BEGIN'); lease.prepare('SELECT count(*) AS tables FROM sqlite_schema').get();
    const uri = pathToFileURL(f.childDbPath); uri.search = '?mode=ro&immutable=1';
    reader.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    reader.prepare('ATTACH DATABASE ? AS inspected_child').run(uri.href);
    reader.exec('BEGIN');
    const report = inspectInputDocumentIndex(reader);
    assert.equal(report.complete, true); assert.equal(report.documentIds[0], f.document.id); assert.equal(report.refs[0]!.sessionId, f.childSessionId);
    assert.equal(reader.prepare('SELECT session_id FROM runs WHERE id=?').get(f.task.childRunId!)?.session_id, f.childSessionId);
    assert.deepEqual((await readdir(directory)).sort(), before);
    assert.throws(() => new SqliteStore(f.childDbPath), error => error instanceof Error && 'code' in error && error.code === 'DB_LOCKED');
    reader.exec('COMMIT'); lease.exec('COMMIT');
  } finally { reader.close(); lease.close(); }
  await f.finishParent();
});
