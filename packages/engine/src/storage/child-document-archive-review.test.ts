import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DEFAULT_LIMITS, EngineError, type InputDocumentAttachment, type RunReceipt, type Session, type Workspace } from '@moodcode/contracts';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createEngine } from '../engine.js';
import type { ProviderAdapter, ProviderEvent } from '../ports.js';
import { acquireRecoveryLease } from '../recovery/index.js';
import { inspectInputDocumentIndex } from './input-document-index.js';
import { SqliteStore } from './index.js';
import { exportEngineArchive, importEngineArchive, validateEngineArchive } from './archive.js';

const exec=promisify(execFile);
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>resolve=yes);return{promise,resolve};}
async function hold(promise:Promise<void>,signal:AbortSignal):Promise<void>{
  if(signal.aborted)throw new Error('fixture cancelled');let abort!:()=>void;
  try{await Promise.race([promise,new Promise<never>((_,reject)=>{abort=()=>reject(new Error('fixture cancelled'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener('abort',abort);}
}
async function command<T>(engine:ReturnType<typeof createEngine>,type:string,payload:Record<string,string>):Promise<T>{
  const result=await engine.dispatch({schemaVersion:1,commandId:'review-'+type,type,payload});assert.equal(result.ok,true,JSON.stringify(result.error));return result.result as unknown as T;
}
async function stoppedOwnedChild(t:TestContext,external:boolean|'internal'=false){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'moodcode-child-doc-archive-review-'))),repository=join(directory,'repository'),artifactDir=join(directory,'artifacts'),dbPath=join(directory,'engine.sqlite');await mkdir(repository);
  await exec('git',['init','--quiet','--template=',repository]);await writeFile(join(repository,'file.txt'),'unchanged\n');await exec('git',['-C',repository,'add','file.txt']);await exec('git',['-C',repository,'-c','user.name=Moodcode Test','-c','user.email=test@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=','commit','--quiet','-m','Archive fixture']);
  const parentEntered=gate(),parentRelease=gate(),childEntered=gate(),childRelease=gate();let childEngine:ReturnType<typeof createEngine>|undefined,providerCalls=0;
  const provider:ProviderAdapter={id:'child-document-archive-review',async *streamTurn(request,signal):AsyncGenerator<ProviderEvent>{
    providerCalls++;
    const child=request.messages.some(message=>message.role==='user'&&message.content==='child');(child?childEntered:parentEntered).resolve();yield{type:'progress'};await hold((child?childRelease:parentRelease).promise,signal);yield{type:'text.delta',delta:child?'child done':'root done'};yield{type:'finish',reason:'stop'};
  }};
  const childrenDirectory=external==='internal'?join(artifactDir,'custom-children'):external?join(directory,'outside-children'):join(artifactDir,'children');
  const engine=createEngine({dbPath,artifactDir,...(external?{worktreeDirectory:childrenDirectory}:{}),providers:[provider],defaults:{providerId:provider.id,modelId:'fixture',mode:'build',limits:{...DEFAULT_LIMITS,maxTurns:8,maxToolCalls:8,maxOutputBytes:65536,maxDurationMs:20000}},configureChild:child=>{childEngine=child;}});
  t.after(async()=>{parentRelease.resolve();childRelease.resolve();await engine.close();await rm(directory,{recursive:true,force:true});});
  const workspace=await command<Workspace>(engine,'workspace.open',{path:repository}),session=await command<Session>(engine,'session.create',{workspaceId:workspace.id}),worktree=await engine.createWorktree(session.id,'review-child-worktree');
  const parent=await command<RunReceipt>(engine,'run.submit',{sessionId:session.id,requestId:'parent',prompt:'parent'});await parentEntered.promise;
  let task=await engine.startChildTask({sessionId:session.id,requestId:'child',parentRunId:parent.runId,worktreeId:worktree.id,prompt:'child',tools:['read_file'],allocation:{turns:2,toolCalls:1,outputBytes:4096,durationMs:10000}});await childEntered.promise;assert.ok(childEngine);
  for(let attempt=0;!task.childRunId&&attempt<100;attempt++){await new Promise(resolve=>setTimeout(resolve,5));task=engine.children.tasks.get(session.id,task.id);}
  assert.ok(task.childRunId);
  const childSession=childEngine.store.getRun(task.childRunId).sessionId,bytes=Buffer.from('%PDF-1.7\nActual isolated child document\n'),ref:InputDocumentAttachment=await childEngine.importDocument(childSession,bytes);
  childRelease.resolve();const outcome=await engine.children.tasks.wait(session.id,task.id);assert.equal(outcome.state,'completed');parentRelease.resolve();assert.equal((await engine.waitForRun(parent.runId)).state,'completed');const internalStorage=external==='internal'?await engine.getChildDocumentStorageUsage({sessionId:session.id,sourceRunId:parent.runId,taskIds:[task.id]}):undefined;await engine.close();
  const childDir=join(childrenDirectory,task.id),childDb=join(childDir,'engine.sqlite'),childArtifacts=join(childDir,'artifacts'),childBlob=join(childArtifacts,'input-documents',ref.id+'.blob');
  const primary=new DatabaseSync(dbPath,{readOnly:true});try{const journal=JSON.parse(String(primary.prepare("SELECT data FROM session_documents WHERE session_id=? AND kind='engine.child_tasks'").get(session.id)!.data));assert.equal(journal.tasks.find((record:{id:string})=>record.id===task.id).childRunId,task.childRunId);}finally{primary.close();}
  return{directory,dbPath,artifactDir,childDb,childDir,childArtifacts,childBlob,childSession,rootSession:session.id,ref,bytes,task,internalStorage,providerCalls:()=>providerCalls,source:{dbPath,artifactDir,destination:join(directory,'archive')}};
}

const rejected=(error:unknown)=>error instanceof EngineError;
function immutableDatabase(path:string):DatabaseSync{const db=new DatabaseSync(':memory:');const uri=pathToFileURL(path);uri.search='?mode=ro&immutable=1';db.prepare('ATTACH DATABASE ? AS original').run(uri.href);db.exec('PRAGMA query_only=ON');return db;}
async function treeFiles(directory:string):Promise<Record<string,{sha256:string;dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number}>> {
  const result:Awaited<ReturnType<typeof treeFiles>>={};
  for(const entry of await readdir(directory,{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isDirectory())Object.assign(result,await treeFiles(file));else{const info=await lstat(file);result[file]={sha256:createHash('sha256').update(await readFile(file)).digest('hex'),dev:info.dev,ino:info.ino,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs};}}
  return result;
}
test('stopped owned child PDF index corruption is rejected before archive publication',async t=>{
  const f=await stoppedOwnedChild(t),writer=new DatabaseSync(f.childDb);try{
    const current=JSON.parse(String(writer.prepare("SELECT data FROM session_documents WHERE session_id=? AND kind='input_documents'").get(f.childSession)!.data));current.owner.sessionId='foreign-owner';writer.prepare("UPDATE session_documents SET data=? WHERE session_id=? AND kind='input_documents'").run(JSON.stringify(current),f.childSession);
    assert.equal(inspectInputDocumentIndex(writer).complete,false);
  }finally{writer.close();}
  await assert.rejects(exportEngineArchive(f.source),rejected);await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});
});
test('changed indexed child PDF bytes are rejected rather than assigned a fresh archive hash',async t=>{
  const f=await stoppedOwnedChild(t),changed=Buffer.from(f.bytes);changed[20]=changed[20]!^1;await writeFile(f.childBlob,changed);
  await assert.rejects(exportEngineArchive(f.source),rejected);await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});
});
test('root owner/source leases do not prevent an independently owned child database write',async t=>{
  const f=await stoppedOwnedChild(t),leases=[acquireRecoveryLease(f.dbPath+'.owner.sqlite','owner'),acquireRecoveryLease(f.dbPath+'.review.sqlite.owner.sqlite','owner'),acquireRecoveryLease(f.dbPath,'source')];const child=new DatabaseSync(f.childDb);
  try{child.exec('BEGIN IMMEDIATE');child.prepare("UPDATE session_documents SET revision=revision+1 WHERE session_id=? AND kind='input_documents'").run(f.childSession);child.exec('COMMIT');assert.equal(child.prepare("SELECT revision FROM session_documents WHERE session_id=? AND kind='input_documents'").get(f.childSession)?.revision,2);}finally{child.close();for(const lease of leases.reverse())lease.release();}
});

test('a reowned child SQLite with live WAL is rejected before archive publication',async t=>{
  const f=await stoppedOwnedChild(t),child=new SqliteStore(f.childDb);
  try {
    const document=child.getSessionDocument(f.childSession,'input_documents')!;child.putSessionDocument(f.childSession,'input_documents',document.revision,document.data);
    assert.throws(()=>new SqliteStore(f.childDb),error=>error instanceof Error&&'code' in error&&error.code==='DB_LOCKED');
    await assert.rejects(exportEngineArchive(f.source),rejected);await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});
  } finally {await child.closeAsync();}
});
test('closed owned child PDF survives standalone archive and inactive import with unchanged source files',async t=>{
  const f=await stoppedOwnedChild(t),before=await treeFiles(f.childDir),originalOwner=await readFile(join(f.childDir,'engine.sqlite.owner.sqlite'));
  const original=immutableDatabase(f.childDb);let originalProofs:unknown[];try{originalProofs=['provider_attempts','attempt_cleanup','attempt_usage','summary_attempts','summary_usage','summary_recovery_acknowledgments','provider_recovery_acknowledgments'].map(table=>original.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());}finally{original.close();}
  const archive=await exportEngineArchive(f.source);assert.deepEqual(await treeFiles(f.childDir),before,'Capture leaves original child files and SQLite sidecars unchanged');
  assert.equal(archive.manifest.documentAudit?.coverage,'complete');assert.equal(archive.manifest.documentAudit?.children.length,1);
  const member=archive.manifest.documentAudit!.children[0]!;assert.equal(member.taskId,f.task.id);assert.equal(member.record.confirmedClose?.method,'engine-close-resolved');
  assert.ok(archive.manifest.artifacts.some(item=>item.file===member.database.file));assert.equal(archive.manifest.artifacts.some(item=>item.file.startsWith(member.database.file+'-')||item.file.startsWith(member.database.file+'.owner.sqlite')),false);
  const copied=await readFile(join(archive.directory,'data',member.database.file));assert.equal(copied[18],1);assert.equal(copied[19],1);
  assert.deepEqual(validateEngineArchive({directory:f.source.destination}).manifest,archive.manifest);
  const imported=await importEngineArchive({directory:f.source.destination,destination:join(f.directory,'imported-verified')});assert.equal(imported.childSessionsPaused,1);assert.equal(imported.documentAuditCoverage,'complete');assert.equal(imported.executionResumed,false);
  const child=new SqliteStore(join(imported.artifactDir,'children',f.task.id,'engine.sqlite'));
  try{assert.equal(child.getSessionControl(f.childSession).paused,true);assert.equal(child.getSessionControl(f.childSession).reason,'recovery_required');assert.equal(child.inspectInputDocumentIndex().complete,true);assert.deepEqual(child.getSessionDocument(f.childSession,'engine.child_owner')?.data.binding,member.record.binding);}
  finally{await child.closeAsync();}
  const restored=immutableDatabase(join(imported.artifactDir,'children',f.task.id,'engine.sqlite'));try{assert.deepEqual(['provider_attempts','attempt_cleanup','attempt_usage','summary_attempts','summary_usage','summary_recovery_acknowledgments','provider_recovery_acknowledgments'].map(table=>restored.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),originalProofs);}finally{restored.close();}
  assert.equal(f.providerCalls(),2,'Export, validation and import dispatch no model calls');
  await assert.rejects(exportEngineArchive({dbPath:imported.dbPath,artifactDir:imported.artifactDir,destination:join(f.directory,'reexport-imported')}),error=>error instanceof EngineError&&error.code==='ARCHIVE_CHILD_INVALID','Imported physical owner proof is historical and never silently downgraded');
  assert.deepEqual(await readFile(join(imported.artifactDir,'children',f.task.id,'artifacts','input-documents',f.ref.id+'.blob')),f.bytes);assert.deepEqual(await readFile(join(f.childDir,'engine.sqlite.owner.sqlite')),originalOwner);
});
test('owned child archive requires its audit, exact indexed member and immutable mirror provenance',async t=>{
  const f=await stoppedOwnedChild(t),archive=await exportEngineArchive(f.source),manifestPath=join(archive.directory,'data','manifest.json'),original=await readFile(manifestPath,'utf8');
  const write=async(value:unknown)=>writeFile(manifestPath,JSON.stringify(value,null,2)+'\n');
  const noAudit=JSON.parse(original);delete noAudit.documentAudit;await write(noAudit);assert.throws(()=>validateEngineArchive({directory:archive.directory}),error=>error instanceof EngineError&&error.code==='ARCHIVE_CHILD_AUDIT_REQUIRED');
  const noBlob=JSON.parse(original);noBlob.artifacts=noBlob.artifacts.filter((member:{file:string})=>!member.file.endsWith(f.ref.id+'.blob'));await write(noBlob);assert.throws(()=>validateEngineArchive({directory:archive.directory}),error=>error instanceof EngineError&&error.code==='ARCHIVE_DOCUMENT_REFERENCE_INVALID');
  const unknown=JSON.parse(original);unknown.documentAudit.children[0].unverified=true;await write(unknown);assert.throws(()=>validateEngineArchive({directory:archive.directory}),error=>error instanceof EngineError&&error.code==='ARCHIVE_MANIFEST_INVALID');
  const altered=JSON.parse(original);altered.documentAudit.children[0].record.confirmedClose.closedAt='2000-01-01T00:00:00.000Z';await write(altered);assert.throws(()=>validateEngineArchive({directory:archive.directory}),error=>error instanceof EngineError&&error.code==='ARCHIVE_CHILD_INVALID');
  await writeFile(manifestPath,original);assert.equal(validateEngineArchive({directory:archive.directory}).manifest.documentAudit?.coverage,'complete');
});
test('legacy child storage stays explicitly unchecked and retains old manifest compatibility',async t=>{
  const f=await stoppedOwnedChild(t),root=new DatabaseSync(f.dbPath);try{root.prepare('DELETE FROM session_documents WHERE session_id=? AND kind=?').run(f.rootSession,'child.storage.'+f.task.id);}finally{root.close();}
  const archive=await exportEngineArchive(f.source);assert.equal(archive.manifest.documentAudit?.coverage,'partial');assert.deepEqual(archive.manifest.documentAudit?.unchecked,[{taskId:f.task.id,reason:'legacy-unbound'}]);assert.equal(archive.manifest.documentAudit?.children.length,0);assert.equal(validateEngineArchive({directory:archive.directory}).manifest.documentAudit?.coverage,'partial');
  const path=join(archive.directory,'data','manifest.json'),legacy=JSON.parse(await readFile(path,'utf8'));delete legacy.documentAudit;await writeFile(path,JSON.stringify(legacy,null,2)+'\n');assert.equal(validateEngineArchive({directory:archive.directory}).manifest.documentAudit,undefined);
  const imported=await importEngineArchive({directory:archive.directory,destination:join(f.directory,'legacy-import')});assert.equal(imported.documentAuditCoverage,'unchecked');assert.equal(imported.childSessionsPaused,0);
});
test('missing or hot bound child storage fails before publication and releases all root leases',async t=>{
  const f=await stoppedOwnedChild(t);await writeFile(f.childDb+'-journal','unverified hot journal');await assert.rejects(exportEngineArchive(f.source),error=>error instanceof EngineError&&error.code==='CHILD_DOCUMENT_STORAGE_HOT_DATABASE');await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});await rm(f.childDb+'-journal');await rm(f.childDb);
  await assert.rejects(exportEngineArchive(f.source),error=>error instanceof EngineError&&error.code==='CHILD_DOCUMENT_STORAGE_MISSING');await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});
  const owner=new SqliteStore(f.dbPath);await owner.closeAsync();
});
test('external custom child storage is explicitly outside archive document coverage',async t=>{
  const f=await stoppedOwnedChild(t,true),archive=await exportEngineArchive(f.source);assert.equal(archive.manifest.documentAudit?.coverage,'partial');assert.deepEqual(archive.manifest.documentAudit?.unchecked,[{taskId:f.task.id,reason:'external-child-storage'}]);assert.equal(archive.manifest.documentAudit?.children.length,0);assert.equal(archive.manifest.artifacts.some(member=>member.file.includes(f.task.id)),false);
  assert.equal(validateEngineArchive({directory:archive.directory}).manifest.documentAudit?.coverage,'partial');
});
test('internal custom child storage remains observable but unsupported archive mapping never becomes opaque',async t=>{
  const f=await stoppedOwnedChild(t,'internal');assert.equal(f.internalStorage?.complete,true);
  await assert.rejects(exportEngineArchive(f.source),error=>error instanceof EngineError&&error.code==='ARCHIVE_CHILD_INVALID');await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});
});
test('typed child bindings in a foreign root session cannot hide behind an existing task ID',async t=>{
  const f=await stoppedOwnedChild(t),root=new SqliteStore(f.dbPath);try{const owner=root.getSession(f.rootSession);root.createSession({id:'foreign-child-binding',workspaceId:owner.workspaceId,title:'Foreign',createdAt:new Date().toISOString()});const binding=root.getSessionDocument(f.rootSession,'child.storage.'+f.task.id)!;root.putSessionDocument('foreign-child-binding','child.storage.'+f.task.id,0,binding.data);}finally{await root.closeAsync();}
  await assert.rejects(exportEngineArchive(f.source),error=>error instanceof EngineError&&error.code==='ARCHIVE_CHILD_JOURNAL_INVALID');await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});
});
test('closed-child owner read leases remain held through atomic archive publication',async t=>{
  const f=await stoppedOwnedChild(t),rename=fs.renameSync;let observed=0;
  fs.renameSync=((from,to)=>{if(String(from).includes('.moodcode-archive-')){observed++;assert.throws(()=>new SqliteStore(f.childDb),error=>error instanceof EngineError&&error.code==='DB_LOCKED');assert.throws(()=>new SqliteStore(f.dbPath),error=>error instanceof EngineError&&error.code==='DB_LOCKED');}return rename(from,to);}) as typeof fs.renameSync;syncBuiltinESMExports();
  try{await exportEngineArchive(f.source);}finally{fs.renameSync=rename;syncBuiltinESMExports();}
  assert.equal(observed,1);const child=new SqliteStore(f.childDb);await child.closeAsync();const root=new SqliteStore(f.dbPath);await root.closeAsync();
});
test('cancellation during child PDF capture removes partial data and releases root and child leases',async t=>{
  const f=await stoppedOwnedChild(t),controller=new AbortController(),read=fs.readSync,blob=await lstat(f.childBlob);let aborted=false;
  fs.readSync=((...args:Parameters<typeof fs.readSync>)=>{const fd=args[0],info=fs.fstatSync(fd);if(info.dev===blob.dev&&info.ino===blob.ino&&!aborted){aborted=true;controller.abort();}return Reflect.apply(read,fs,args);}) as typeof fs.readSync;syncBuiltinESMExports();
  try{await assert.rejects(exportEngineArchive({...f.source,signal:controller.signal}),error=>error instanceof EngineError&&error.code==='ARCHIVE_ABORTED');}finally{fs.readSync=read;syncBuiltinESMExports();}
  assert.equal(aborted,true);await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});assert.equal((await readdir(f.directory)).some(path=>path.startsWith('.moodcode-archive-')),false);
  const child=new SqliteStore(f.childDb);await child.closeAsync();const root=new SqliteStore(f.dbPath);await root.closeAsync();
});
test('an unfinished native observation in the original stopped child cannot reuse old close proof',async t=>{
  const f=await stoppedOwnedChild(t),writer=new DatabaseSync(f.childDb);
  try{
    const originalTurn=writer.prepare('SELECT id,data FROM session_turns WHERE run_id=? LIMIT 1').get(f.task.childRunId!)!,turn=JSON.parse(String(originalTurn.data));turn.state='streaming';delete turn.completedAt;delete turn.finishReason;writer.prepare('UPDATE session_turns SET state=?,data=? WHERE id=?').run('streaming',JSON.stringify(turn),String(originalTurn.id));
    const originalAttempt=writer.prepare('SELECT id,data FROM provider_attempts WHERE turn_id=? LIMIT 1').get(String(originalTurn.id))!,attempt=JSON.parse(String(originalAttempt.data));attempt.state='dispatched';delete attempt.completedAt;writer.prepare('UPDATE provider_attempts SET state=?,data=? WHERE id=?').run('dispatched',JSON.stringify(attempt),String(originalAttempt.id));
  }finally{writer.close();}
  await assert.rejects(exportEngineArchive(f.source),error=>error instanceof EngineError&&error.code==='CHILD_DOCUMENT_STORAGE_NOT_QUIESCENT');await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});
});
test('a primary PDF changed during awaited child backup cannot acquire a replacement manifest hash',async t=>{
  const f=await stoppedOwnedChild(t),root=new SqliteStore(f.dbPath),{DocumentAttachmentStore}=await import('../documents/store.js');const bytes=Buffer.from('%PDF-1.7\nPrimary source race fixture\n');
  let ref:InputDocumentAttachment;try{ref=await new DocumentAttachmentStore({directory:join(f.artifactDir,'input-documents'),documents:root}).import(f.rootSession,bytes);}finally{await root.closeAsync();}
  const blob=join(f.artifactDir,'input-documents',ref.id+'.blob'),identity=await lstat(blob),close=fs.closeSync,changed=Buffer.from(bytes);changed[20]=changed[20]!^1;let scheduled=false,mutated=false;
  fs.closeSync=((fd:number)=>{const current=fs.fstatSync(fd);close(fd);if(!scheduled&&current.dev===identity.dev&&current.ino===identity.ino){scheduled=true;queueMicrotask(()=>{fs.writeFileSync(blob,changed);mutated=true;});}}) as typeof fs.closeSync;syncBuiltinESMExports();
  try{await assert.rejects(exportEngineArchive(f.source),error=>error instanceof EngineError&&error.code==='ARCHIVE_DOCUMENT_INTEGRITY_FAILED');}finally{fs.closeSync=close;syncBuiltinESMExports();}
  assert.equal(scheduled,true);assert.equal(mutated,true);await assert.rejects(lstat(f.source.destination),{code:'ENOENT'});assert.equal((await readdir(f.directory)).some(path=>path.startsWith('.moodcode-archive-')),false);
  const rootCheck=new SqliteStore(f.dbPath);try{const index=rootCheck.getSessionDocument(f.rootSession,'input_documents')!;assert.deepEqual(index.data.documents,[ref]);}finally{await rootCheck.closeAsync();}
  const childCheck=new SqliteStore(f.childDb);await childCheck.closeAsync();assert.equal(f.providerCalls(),2);
});
