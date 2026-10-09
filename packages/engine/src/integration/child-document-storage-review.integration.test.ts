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
import { childStorageKind, validateChildStorageRecord } from '../child-tasks/storage-binding.js';
import { retainBackendFixture } from '../agent-backends/fixtures/backend.js';
import { nativeTeam } from '../teams/fixtures/native-team.js';
import { residentUntil } from '../teams/fixtures/resident.js';
import { createChildDocumentReadFrame, openChildDocumentReader, readChildDocumentIndex } from '../storage/child-document-reader.js';

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
  t.after(async () => { release.resolve(); childRelease.resolve(); await retainBackendFixture(t,root,new Set([engine,...(childEngine?[childEngine]:[])])); });
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


test('genuine multi-Run resident JSON consumes one shared budget before body reads and across children', async t => {
  // The canonical fixture supplies the actual scheduler, managed worktrees and
  // close proofs. Its deleting after hook is replaced by owned-handle retention.
  const canonicalAfter: unknown[] = [];
  const f = await nativeTeam({ after(callback: unknown) { canonicalAfter.push(callback); } } as TestContext, {
    engine: { residentTeams: true, teamModelTools: true },
    resident: { idleTimeoutMs: 5000, allocation: { turns: 3, toolCalls: 2, outputBytes: 8192, durationMs: 10000 } },
    streamChild: async function* () { yield { type: 'finish', reason: 'stop' }; },
  });
  t.after(async () => {
    f.parentRelease.resolve(); f.childRelease.resolve();
    for (const release of f.childReleases) release.resolve();
    await retainBackendFixture(t,f.base,new Set([...f.children,...f.engines]));
  });
  assert.equal(canonicalAfter.length,1);
  const children: Awaited<ReturnType<typeof f.child>>[] = [];
  for (let index=0; index<2; index++) {
    const child=await f.child(`budget-worker-${index}`); children.push(child);
    f.engine.bindTeamModelTools({ rootSessionId:f.session.id,teamId:f.created.record.id,memberId:child.member.memberId,generation:child.member.generation,childTaskId:child.task.id });
    await residentUntil(()=>f.engine.inspectResidentChildTask(f.session.id,child.task.id)?.state==='idle','initial native resident Run');
    f.send(child.member.memberId,child.member.generation,'Actual second untrusted resident input.',`budget-message-${index}`);
    const page=f.read(child.member.memberId,child.member.generation);
    f.engine.resumeChildTurn({ workspaceId:f.workspace.id,requestId:`budget-resume-${index}`,approved:true,page,expectedCursorRevision:page.cursor.revision });
    await residentUntil(()=>{const resident=f.engine.inspectResidentChildTask(f.session.id,child.task.id);return resident?.state==='idle'&&resident.runs.length===2&&resident.runs.every(run=>run.state==='completed');},'second actual resident Run');
    await f.engine.stopResidentChildTask(f.session.id,child.task.id);
    assert.equal((Reflect.get(child.child.store,'db') as DatabaseSync).isOpen,false,'original child handle closed by the host');
  }
  f.parentRelease.resolve(); assert.equal((await f.engine.waitForRun(f.parent.runId)).state,'completed');
  const records=children.map(child=>validateChildStorageRecord(f.engine.store.getSessionDocument(f.session.id,childStorageKind(child.task.id))!.data));
  const bodyEvidence=records.map(record=>{
    const database=record.binding.physical.database.path, original=fs.readFileSync(database), owner=fs.readFileSync(record.binding.physical.owner.path);
    assert.ok(record.confirmedClose);
    const db=new DatabaseSync(':memory:');
    try {
      const uri=pathToFileURL(database);uri.search='?mode=ro&immutable=1';db.prepare('ATTACH DATABASE ? AS proof').run(uri.href);
      assert.equal(db.prepare('PRAGMA proof.user_version').get()!.user_version,23);
      const resident=db.prepare("SELECT length(CAST(data AS BLOB)) AS bytes,data FROM proof.session_documents WHERE kind='engine.resident_child'").get()!;
      const retained=JSON.parse(String(resident.data));
      assert.equal(retained.runs.length,2);
      const runs=retained.runs.map((run:{runId:string})=>db.prepare('SELECT length(CAST(data AS BLOB)) AS bytes,data FROM proof.runs WHERE id=?').get(run.runId)!);
      assert.equal(Number(resident.bytes),Buffer.byteLength(String(resident.data)));
      for (const run of runs) assert.equal(Number(run.bytes),Buffer.byteLength(String(run.data)));
      return {database,original,owner,residentBytes:Number(resident.bytes),runBytes:runs.map((run:{bytes:unknown})=>Number(run.bytes)) as number[]};
    } finally {db.close();}
  });
  const input={sessionId:f.session.id,sourceRunId:f.parent.runId,taskIds:children.map(child=>child.task.id)};
  const full=await f.engine.getChildDocumentStorageUsage(input);
  assert.equal(full.complete,true,JSON.stringify(full)); assert.equal(full.observedChildren,2);
  const nativeProofBytes=bodyEvidence.reduce((bytes,child)=>bytes+child.residentBytes+child.runBytes.reduce((a,b)=>a+b,0),0);
  const oldUnchargedBudget=full.stats.selectedMetadataBytes-nativeProofBytes+1;
  const limited=await f.engine.getChildDocumentStorageUsage({...input,limits:{maxMetadataBytes:oldUnchargedBudget}});
  assert.equal(limited.complete,false); assert.ok(limited.children.some(child=>child.reasons.includes('CHILD_DOCUMENT_STORAGE_METADATA_LIMIT')));
  assert.equal(limited.stats.exhaustedReason,'CHILD_DOCUMENT_STORAGE_METADATA_LIMIT'); assert.ok(limited.stats.selectedMetadataBytes<=oldUnchargedBudget);
  assert.equal(limited.declaredReferenceBytes.children,null); assert.equal(limited.declaredReferenceBytes.sum,null);

  const originalPrepare=DatabaseSync.prototype.prepare;
  const selectedBodies:string[]=[];
  t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
    const statement=Reflect.apply(originalPrepare,this,[sql]);
    return new Proxy(statement,{get(target,key){
      const value=Reflect.get(target,key,target);
      if(key==='get')return (...parameters:unknown[])=>{const row=Reflect.apply(value,target,parameters) as ReturnType<typeof target.get>;if(typeof row?.data==='string'&&(sql.includes("kind='engine.resident_child'")||sql.includes('state,data FROM child.runs')))selectedBodies.push(sql);return row;};
      return typeof value==='function'?value.bind(target):value;
    }});
  });
  try {
    const proof=bodyEvidence[0]!, caps=[proof.residentBytes-1,proof.residentBytes+proof.runBytes[0]!-1,proof.residentBytes+proof.runBytes[0]!+proof.runBytes[1]!-1];
    for (let index=0;index<caps.length;index++) {
      selectedBodies.length=0;
      const frame=createChildDocumentReadFrame({limits:{maxMetadataBytes:caps[index]!}});
      const result=readChildDocumentIndex({mode:'source',record:records[0]!},frame);
      assert.equal(result.status,'unchecked'); assert.deepEqual(result.reasons,['CHILD_DOCUMENT_STORAGE_METADATA_LIMIT']);
      assert.equal(selectedBodies.length,index,'the body that exceeds remaining bytes must never reach a native get');
      assert.ok(frame.stats().selectedMetadataBytes<=caps[index]!);
    }
  } finally {t.mock.restoreAll();}
  const costs=records.map(record=>{const frame=createChildDocumentReadFrame();assert.equal(readChildDocumentIndex({mode:'source',record},frame).status,'observed');return frame.stats().selectedMetadataBytes;});
  const shared=createChildDocumentReadFrame({limits:{maxMetadataBytes:costs[0]!+costs[1]!-1}});
  assert.equal(readChildDocumentIndex({mode:'source',record:records[0]!},shared).status,'observed');
  const last=readChildDocumentIndex({mode:'source',record:records[1]!},shared);
  assert.equal(last.status,'unchecked'); assert.deepEqual(last.reasons,['CHILD_DOCUMENT_STORAGE_METADATA_LIMIT']);
  assert.ok(shared.stats().selectedMetadataBytes<=shared.limits.maxMetadataBytes);
  const cacheFrame=createChildDocumentReadFrame(),reader=openChildDocumentReader({mode:'source',record:records[0]!},cacheFrame);
  try {const index=reader.readIndex(),before=cacheFrame.stats();assert.deepEqual(reader.readIndex(),index);const after=cacheFrame.stats();assert.equal(after.selectedMetadataBytes,before.selectedMetadataBytes);assert.equal(after.selectedRows,before.selectedRows);} finally {reader.close();}
  for (const proof of bodyEvidence) {assert.deepEqual(fs.readFileSync(proof.database),proof.original);assert.deepEqual(fs.readFileSync(proof.database+'.owner.sqlite'),proof.owner);}
  assert.equal((await f.engine.getChildDocumentStorageUsage(input)).complete,true);
});
