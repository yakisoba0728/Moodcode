import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type InputDocumentAttachment } from '@moodcode/contracts';
import { createEngine, type MoodcodeEngine } from '../engine.js';
import type { ProviderAdapter } from '../ports.js';
import { childStorageBindingSha256, childStorageKind, validateChildStorageRecord } from '../child-tasks/storage-binding.js';
import { SqliteStore } from '../storage/index.js';
import { exportEngineArchive, importEngineArchive, validateEngineArchive } from '../storage/archive.js';

function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function hold(promise: Promise<void>, signal: AbortSignal) { let abort!: () => void; try { await Promise.race([promise,new Promise<void>(yes=>{abort=yes;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]); } finally {signal.removeEventListener('abort',abort);} }
function files(directory: string): Record<string,{sha256:string;bytes:number;ino:number;mtimeMs:number;ctimeMs:number}> {
  const result: ReturnType<typeof files> = {};
  for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())Object.assign(result,files(path));else{const info=statSync(path);result[path]={sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),bytes:info.size,ino:info.ino,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs};}}
  return result;
}
async function nested(t: TestContext) {
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'moodcode-child-document-wiring-review-'))),repo=join(directory,'repo'),artifactDir=join(directory,'artifacts'),dbPath=join(directory,'engine.sqlite');mkdirSync(repo);
  execFileSync('git',['init','-q','--template=',repo]);writeFileSync(join(repo,'fixture.txt'),'Authored independent nested engine fixture.\n');execFileSync('git',['-C',repo,'add','fixture.txt']);execFileSync('git',['-C',repo,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=','commit','-qm','fixture']);
  const rootEntered=gate(),childEntered=gate(),rootRelease=gate(),childRelease=gate(),engines=new Map<number,MoodcodeEngine>(),documents=new Map<number,InputDocumentAttachment>(),sessions=new Map<number,string>();let calls=0;
  const provider:ProviderAdapter={id:'nested-document-wiring',async *streamTurn(request,signal){calls++;const prompt=request.messages.find(message=>message.role==='user')?.content;
    if(prompt==='root-parent'){rootEntered.resolve();yield{type:'progress'};await hold(rootRelease.promise,signal);}
    else if(prompt==='child-parent'||prompt==='grandchild'){const depth=prompt==='child-parent'?1:2,engine=engines.get(depth);assert.ok(engine);assert.ok(request.sessionId);sessions.set(depth,request.sessionId);documents.set(depth,await engine.importDocument(request.sessionId,Buffer.from(`%PDF-1.7\nAuthored document at nesting depth ${depth}.\n`)));if(depth===1){childEntered.resolve();yield{type:'progress'};await hold(childRelease.promise,signal);}}
    yield{type:'text.delta',delta:'Bound independent child observation.'};yield{type:'finish',reason:'stop'};
  }};
  const options={dbPath,artifactDir,providers:[provider],tools:[],defaults:{providerId:provider.id,modelId:'fixture',mode:'plan' as const,limits:{maxTurns:12,maxToolCalls:12,maxOutputBytes:65536,maxDurationMs:20000,toolTimeoutMs:3000,maxContextBytes:262144}},configureChild:(engine:MoodcodeEngine,task:{depth:number})=>{engines.set(task.depth,engine);}};
  const engine=createEngine(options);t.after(async()=>{rootRelease.resolve();childRelease.resolve();try{await engine.close();}finally{rmSync(directory,{recursive:true,force:true});}});
  const stamp=new Date().toISOString();engine.store.putWorkspace({id:'workspace',root:repo,gitRoot:repo,branch:null,createdAt:stamp});engine.store.createSession({id:'root-session',workspaceId:'workspace',title:'Nested audit',createdAt:stamp});
  t.mock.method(engine.store,'getSnapshot',()=>{throw new Error('Independent audit must not use full snapshots');});
  const parentWorktree=await engine.createWorktree('root-session','parent-worktree'),grandWorktree=await engine.prepareChildWorktree('root-session',parentWorktree.id,'grand-worktree');
  const rootRun=engine.scheduler.submitLegacy({sessionId:'root-session',requestId:'root',prompt:'root-parent',config:engine.getCapabilities().defaults});await rootEntered.promise;
  let parent=await engine.startChildTask({sessionId:'root-session',requestId:'child-parent',parentRunId:rootRun.runId,worktreeId:parentWorktree.id,prompt:'child-parent',tools:[],allocation:{turns:4,toolCalls:4,outputBytes:8192,durationMs:10000}});await childEntered.promise;parent=engine.children.tasks.get('root-session',parent.id);assert.ok(parent.childRunId);assert.equal(parent.state,'running');
  const starting=await engine.startChildTask({sessionId:'root-session',requestId:'grandchild',parentRunId:parent.childRunId,parentTaskId:parent.id,worktreeId:grandWorktree.id,prompt:'grandchild',tools:[],allocation:{turns:1,toolCalls:1,outputBytes:1024,durationMs:3000}}),grandchild=await engine.children.tasks.wait('root-session',starting.id);assert.equal(grandchild.state,'completed',JSON.stringify(grandchild));assert.ok(grandchild.childRunId);
  const path=(taskId:string)=>join(artifactDir,'children',taskId),usage=(taskIds:string[],limits?:{maxMetadataBytes:number})=>engine.getChildDocumentStorageUsage({sessionId:'root-session',sourceRunId:rootRun.runId,taskIds,...(limits?{limits}:{})});
  const finish=async()=>{childRelease.resolve();parent=await engine.children.tasks.wait('root-session',parent.id);assert.equal(parent.state,'completed');rootRelease.resolve();await engine.waitForRun(rootRun.runId);};
  return{engine,options,directory,artifactDir,dbPath,rootRun,parent,grandchild,documents,sessions,path,usage,finish,calls:()=>calls};
}

test('actual flat child/grandchild binding is observed exactly; active ancestors are not opened',async t=>{
  const f=await nested(t),before=files(f.path(f.grandchild.id)),calls=f.calls();
  const grand=await f.usage([f.grandchild.id]);assert.equal(grand.complete,true,JSON.stringify(grand));assert.equal(grand.children[0]!.childSessionId,f.sessions.get(2));assert.equal(grand.children[0]!.childRunId,f.grandchild.childRunId);assert.equal(grand.children[0]!.blobHashes,'not-read');assert.equal(grand.coverage.blobIntegrity,'not-verified');assert.equal(grand.stats.openedChildren,1);
  const active=await f.usage([f.parent.id]);assert.equal(active.complete,false);assert.equal(active.children[0]!.authorityStatus,'active');assert.equal(active.stats.openedChildren,0);assert.equal(active.stats.rawMirrorBytes,0);assert.equal(active.declaredReferenceBytes.sum,null);
  assert.deepEqual(files(f.path(f.grandchild.id)),before);assert.equal(f.calls(),calls);
  await f.finish();await f.engine.close();const archive=await exportEngineArchive({dbPath:f.dbPath,artifactDir:f.artifactDir,destination:join(f.directory,'archive')});
  assert.equal(archive.manifest.documentAudit!.coverage,'complete');assert.deepEqual(new Set(archive.manifest.documentAudit!.children.map(item=>item.taskId)),new Set([f.parent.id,f.grandchild.id]));
  const member=archive.manifest.documentAudit!.children.find(item=>item.taskId===f.grandchild.id)!;
  assert.equal(member.record.binding.lineage.parentTaskId,f.parent.id);assert.equal(member.record.binding.lineage.parentRunId,f.parent.childRunId);assert.equal(member.record.binding.lineage.sourceRunId,f.rootRun.runId);assert.equal(member.database.file,`artifacts/children/${f.grandchild.id}/engine.sqlite`);
  const manifestPath=join(archive.directory,'data','manifest.json'),raw=readFileSync(manifestPath,'utf8'),downgrade=JSON.parse(raw);downgrade.documentAudit.children=downgrade.documentAudit.children.filter((item:{taskId:string})=>item.taskId!==f.grandchild.id);downgrade.documentAudit.unchecked=[{taskId:f.grandchild.id,reason:'legacy-unbound'}];downgrade.documentAudit.coverage='partial';writeFileSync(manifestPath,JSON.stringify(downgrade));
  assert.throws(()=>validateEngineArchive({directory:archive.directory}),error=>error instanceof EngineError&&error.code==='ARCHIVE_CHILD_INVALID');writeFileSync(manifestPath,raw);
  const imported=await importEngineArchive({directory:archive.directory,destination:join(f.directory,'imported')});assert.equal(imported.childSessionsPaused,2);assert.equal(imported.executionResumed,false);
  const restored=createEngine({...f.options,dbPath:imported.dbPath,artifactDir:imported.artifactDir});try{
    const report=await restored.getChildDocumentStorageUsage({sessionId:'root-session',sourceRunId:f.rootRun.runId,taskIds:[f.parent.id,f.grandchild.id]});assert.equal(report.complete,false);assert.equal(report.stats.openedChildren,0);assert.ok(report.children.every(item=>item.authorityStatus==='relocated'));assert.equal(report.declaredReferenceBytes.sum,null);
    const stored=validateChildStorageRecord(restored.store.getSessionDocument('root-session',childStorageKind(f.grandchild.id))!.data);assert.deepEqual(stored.binding,member.record.binding);
  }finally{await restored.close();}
});

test('cumulative nested metadata cap retains observed subtotal and leaves unknown totals without original file writes',async t=>{
  const f=await nested(t);await f.finish();const parent=engineRecord(f.engine,f.parent.id),grand=engineRecord(f.engine,f.grandchild.id);assert.equal(parent.binding.phase,'admitted');assert.equal(grand.binding.phase,'admitted');
  const paths=[f.parent.id,f.grandchild.id],before=Object.assign({},...paths.map(id=>files(f.path(id)))),full=await f.usage(paths);assert.equal(full.complete,true,JSON.stringify(full));
  const limit=full.stats.selectedMetadataBytes-1,bounded=await f.usage(paths,{maxMetadataBytes:limit});assert.equal(bounded.complete,false,JSON.stringify(bounded));assert.equal(bounded.declaredReferenceBytes.children,null);assert.equal(bounded.declaredReferenceBytes.sum,null);assert.ok(bounded.declaredReferenceBytes.observedChildSubtotal>0);assert.ok(bounded.stats.selectedMetadataBytes<=limit);assert.equal(bounded.coverage.blobContents,'not-read');assert.deepEqual(Object.assign({},...paths.map(id=>files(f.path(id)))),before);
});
function engineRecord(engine:MoodcodeEngine,taskId:string){return validateChildStorageRecord(engine.store.getSessionDocument('root-session',childStorageKind(taskId))!.data);}

test('phase gaps and reowned native child stores stay unchecked; oversized foreign payload cannot become a known total',async t=>{
  const f=await nested(t);await f.finish();const original=f.engine.store.getSessionDocument('root-session',childStorageKind(f.grandchild.id))!,record=validateChildStorageRecord(original.data),prepared=structuredClone(record);prepared.binding.phase='prepared';delete prepared.binding.child.runId;delete prepared.binding.admittedAt;delete prepared.confirmedClose;prepared.sha256=childStorageBindingSha256(prepared.binding);
  f.engine.store.putSessionDocument('root-session',childStorageKind(f.grandchild.id),original.revision,prepared as unknown as import('@moodcode/contracts').JsonObject);
  const phase=await f.usage([f.grandchild.id]);assert.equal(phase.children[0]!.authorityStatus,'unconfirmed');assert.equal(phase.stats.openedChildren,0);assert.equal(phase.stats.rawMirrorBytes,0);
  f.engine.store.putSessionDocument('root-session',childStorageKind(f.grandchild.id),original.revision+1,original.data);
  const childPath=join(f.path(f.grandchild.id),'engine.sqlite'),owner=new SqliteStore(childPath);try{
    const before=files(f.path(f.grandchild.id)),reowned=await f.usage([f.grandchild.id]);assert.equal(reowned.complete,false);assert.equal(reowned.children[0]!.status,'unchecked');assert.equal(reowned.declaredReferenceBytes.children,null);assert.deepEqual(files(f.path(f.grandchild.id)),before);
  }finally{await owner.closeAsync();}
  // Deliberately damaged fixture: ordinary host writes cannot exceed the table's JSON CHECK.
  const writer=new DatabaseSync(childPath);try{writer.exec('PRAGMA ignore_check_constraints=ON');const data={version:1,owner:{sessionId:'foreign',workspaceId:record.binding.child.workspaceId,workspaceRoot:record.binding.child.root},documents:[],opaque:'x'.repeat(9*1024*1024)};writer.prepare("UPDATE session_documents SET data=? WHERE session_id=? AND kind='input_documents'").run(JSON.stringify(data),f.sessions.get(2)!);}finally{writer.close();}
  const before=files(f.path(f.grandchild.id)),foreign=await f.usage([f.grandchild.id]);assert.equal(foreign.complete,false);assert.equal(foreign.children[0]!.indexComplete,false);assert.equal(foreign.children[0]!.declaredBytes,null);assert.equal(foreign.declaredReferenceBytes.sum,null);assert.ok(foreign.stats.selectedMetadataBytes<65536);assert.ok(foreign.stats.rawMirrorBytes>9*1024*1024);assert.deepEqual(files(f.path(f.grandchild.id)),before);
});

test('a host blob change after source validation cannot publish an archive inconsistent with its immutable document reference',async t=>{
  const f=await nested(t);await f.finish();await f.engine.close();
  const reference=f.documents.get(2)!,blob=join(f.path(f.grandchild.id),'artifacts','input-documents',reference.id+'.blob'),target=statSync(blob),originalClose=fs.closeSync,original=readFileSync(blob),changed=Buffer.from(original);changed[20]=changed[20]!^1;
  let scheduled=false,mutated=false;
  const close=t.mock.method(fs,'closeSync',(fd:number)=>{
    let selected=false;try{const current=fs.fstatSync(fd);selected=current.dev===target.dev&&current.ino===target.ino;}catch{}
    originalClose(fd);
    if(selected&&!scheduled){scheduled=true;queueMicrotask(()=>{writeFileSync(blob,changed);mutated=true;});}
  });
  syncBuiltinESMExports();
  try {
    const destination=join(f.directory,'changed-after-validation');let published:Awaited<ReturnType<typeof exportEngineArchive>>|undefined,rejection:unknown;
    try{published=await exportEngineArchive({dbPath:f.dbPath,artifactDir:f.artifactDir,destination});}catch(error){rejection=error;}
    assert.equal(scheduled,true);assert.equal(mutated,true);
    if(published){let validationCode:string|undefined;try{validateEngineArchive({directory:published.directory});}catch(error){if(error instanceof EngineError)validationCode=error.code;else throw error;}
      const copied=published.manifest.artifacts.find(member=>member.file===`artifacts/children/${f.grandchild.id}/artifacts/input-documents/${reference.id}.blob`);
      assert.fail(JSON.stringify({publishedAfterMutation:true,validationCode,originalReferenceSha256:reference.sha256,capturedBlobSha256:copied?.sha256}));
    }
    assert.ok(rejection instanceof EngineError&&['ARCHIVE_DOCUMENT_INTEGRITY_FAILED','ARCHIVE_DOCUMENT_REFERENCE_INVALID','ARCHIVE_SOURCE_CHANGED'].includes(rejection.code),String(rejection));assert.throws(()=>statSync(destination),{code:'ENOENT'});
  } finally {close.mock.restore();syncBuiltinESMExports();}
});
