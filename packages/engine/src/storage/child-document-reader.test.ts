import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test,type TestContext } from 'node:test';
import type { JsonObject } from '@moodcode/contracts';
import { createEngine } from '../engine.js';
import type { ChildTaskRecord } from '../child-tasks/index.js';
import type { ManagedWorktree } from '../worktrees/index.js';
import { admitChildStorageBinding, childStoragePhysicalIdentity, confirmChildStorageClosed, prepareChildStorageBinding, CHILD_STORAGE_MIRROR_KIND } from '../child-tasks/storage-binding.js';
import type { GrantDocumentPort } from '../permission/grants.js';
import { SqliteStore } from './index.js';
import { DB_VERSION } from './migrations.js';
import { createChildDocumentReadFrame, openChildDocumentReader, readChildDocumentIndex,type ChildDocumentHistoricalFiles } from './child-document-reader.js';

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const code=(value:string)=>(error:unknown)=>error instanceof Error&&'code' in error&&error.code===value;
async function fixture(t:TestContext){
  const root=await realpath(await mkdtemp(join(tmpdir(),'moodcode-child-document-reader-test-'))),artifacts=join(root,'artifacts'),children=join(artifacts,'children'),taskId='child_'+randomUUID().replaceAll('-',''),worktreeId='worktree_'+randomUUID().replaceAll('-',''),worktreeRoot=join(children,'worktrees',worktreeId),childRoot=join(children,taskId),childArtifacts=join(childRoot,'artifacts'),dbPath=join(childRoot,'engine.sqlite');
  await mkdir(worktreeRoot,{recursive:true});await writeFile(join(root,'engine.sqlite'),'');
  const engine=createEngine({dbPath,artifactDir:childArtifacts,tools:[]});
  t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
  const createdAt=new Date().toISOString(),workspaceId='workspace_'+sha(worktreeRoot),workspace={id:workspaceId,root:worktreeRoot,gitRoot:worktreeRoot,branch:null,createdAt};
  engine.store.putWorkspace(workspace);engine.store.createSession({id:'child-session',workspaceId,title:'Authored child reader',createdAt});
  const data=new Map<string,{revision:number;data:JsonObject}>();
  const rootPort:GrantDocumentPort={getSessionDocument(session,kind){return structuredClone(data.get(session+':'+kind)??null);},putSessionDocument(session,kind,expectedRevision,value){const key=session+':'+kind,previous=data.get(key);assert.equal(previous?.revision??0,expectedRevision);const record={revision:expectedRevision+1,data:structuredClone(value)};data.set(key,record);return structuredClone(record);}};
  const task={id:taskId,requestId:'source-request',sessionId:'parent-session',parentRunId:'source-run',rootRunId:'source-run',depth:1,worktreeId,toolNames:[],budget:{turns:1,toolCalls:1,outputBytes:4096,durationMs:5000},state:'starting',fingerprint:'a'.repeat(64),createdAt,updatedAt:createdAt,deliveryState:'none',deliveryRequestId:'result'} as ChildTaskRecord;
  const stat=await lstat(worktreeRoot,{bigint:true}),worktree={id:worktreeId,requestId:'worktree',sessionId:task.sessionId,workspaceId:'parent-workspace',baseRoot:root,root:worktreeRoot,baseCommit:'b'.repeat(40),reference:'HEAD',state:'ready',revision:1,createdAt,updatedAt:createdAt,fingerprint:'c'.repeat(64),device:String(stat.dev),inode:String(stat.ino),ownerId:taskId} as ManagedWorktree;
  const prepared=prepareChildStorageBinding(rootPort,engine.store,{task,requestFingerprint:'d'.repeat(64),hostIdentity:{database:childStoragePhysicalIdentity(join(root,'engine.sqlite')),artifacts:childStoragePhysicalIdentity(artifacts,true)},childrenDirectory:children,worktree,workspace,childSessionId:'child-session'});
  const receipt=engine.scheduler.submitLegacy({sessionId:'child-session',requestId:taskId,prompt:'Complete the authored fixture.',config:engine.getCapabilities().defaults});
  const admitted=admitChildStorageBinding(rootPort,engine.store,prepared,receipt.runId);
  const ref=await engine.importDocument('child-session',Buffer.from('%PDF-1.7\nAuthored reader observation.\n'));
  assert.equal((await engine.waitForRun(receipt.runId)).state,'completed');await engine.close();
  const record=confirmChildStorageClosed(rootPort,admitted);
  const mutate=(operation:(db:DatabaseSync)=>void)=>{const db=new DatabaseSync(dbPath);try{operation(db);}finally{db.close();}};
  const historical=async():Promise<ChildDocumentHistoricalFiles>=>{
    const directory=join(root,'copied',taskId),copiedArtifacts=join(directory,'artifacts');await mkdir(copiedArtifacts,{recursive:true});const bytes=await readFile(dbPath);await writeFile(join(directory,'engine.sqlite'),bytes);
    const artifactPrefix=`artifacts/children/${taskId}/artifacts`;
    return {database:{path:join(directory,'engine.sqlite'),bytes:bytes.length,sha256:sha(bytes)},artifacts:{path:copiedArtifacts},artifactPrefix,allowedMembers:[{file:`artifacts/children/${taskId}/engine.sqlite`,bytes:bytes.length,sha256:sha(bytes)}]};
  };
  return{root,dbPath,childArtifacts,childRoot,record,ref,prepared,mutate,historical};
}

test('held source reader shares bounded index, prevents a new owner, and deletes its private mirror on close',async t=>{
  const f=await fixture(t),before=(await readdir(f.childRoot)).sort(),bytes=await readFile(f.dbPath),frame=createChildDocumentReadFrame();
  const reader=openChildDocumentReader({mode:'source',record:f.record},frame);
  const mirror=String(reader.db.prepare('PRAGMA database_list').all().find(row=>row.name==='child')!.file);
  try{
    assert.equal(reader.schemaVersion,DB_VERSION);assert.equal(reader.sourceName,'child');
    const index=reader.readIndex();assert.equal(index.complete,true);assert.deepEqual(index.documentIds,[f.ref.id]);
    const used=frame.stats();assert.deepEqual(reader.readIndex(),index);assert.deepEqual(frame.stats().selectedMetadataBytes,used.selectedMetadataBytes);assert.equal(frame.stats().selectedRefs,1);
    assert.throws(()=>new SqliteStore(f.dbPath),code('DB_LOCKED'));assert.deepEqual((await readdir(f.childRoot)).sort(),before);assert.deepEqual(await readFile(f.dbPath),bytes);
  }finally{reader.close();reader.close();}
  await assert.rejects(lstat(dirname(dirname(mirror))),error=>error instanceof Error&&'code'in error&&error.code==='ENOENT');
  assert.throws(()=>reader.check(),code('CHILD_DOCUMENT_STORAGE_READER_CLOSED'));
  const owner=new SqliteStore(f.dbPath);await owner.closeAsync();
});

test('unconfirmed/prepared binding and an exhausted frame do not open or copy a source database',async t=>{
  const f=await fixture(t),frame=createChildDocumentReadFrame();
  const unconfirmed={...f.record};delete unconfirmed.confirmedClose;
  for(const record of [unconfirmed,f.prepared])assert.equal(readChildDocumentIndex({mode:'source',record},frame).status,'unchecked');
  assert.equal(frame.stats().rawMirrorBytes,0);assert.equal(frame.stats().openedChildren,0);
  const exhausted=createChildDocumentReadFrame();exhausted.charge(exhausted.limits.maxMetadataBytes);
  assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},exhausted),code('CHILD_DOCUMENT_STORAGE_METADATA_LIMIT'));
  assert.equal(exhausted.stats().rawMirrorBytes,0);
});

test('hot files, active physical owner and replaced source inode are rejected before mirror creation',async t=>{
  const f=await fixture(t);
  await writeFile(f.dbPath+'-journal','');
  const hot=createChildDocumentReadFrame();assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},hot),code('CHILD_DOCUMENT_STORAGE_HOT_DATABASE'));assert.equal(hot.stats().rawMirrorBytes,0);await rm(f.dbPath+'-journal');
  const owner=new SqliteStore(f.dbPath);try{assert.equal(readChildDocumentIndex({mode:'source',record:f.record},createChildDocumentReadFrame()).status,'unchecked');}finally{await owner.closeAsync();}
  const old=f.dbPath+'.saved';await rename(f.dbPath,old);await writeFile(f.dbPath,await readFile(old));
  const replaced=createChildDocumentReadFrame();assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},replaced),code('CHILD_DOCUMENT_STORAGE_IDENTITY_CHANGED'));assert.equal(replaced.stats().rawMirrorBytes,0);
});

test('symlinked artifact ancestor and source database cannot be followed',async t=>{
  const f=await fixture(t),old=f.childArtifacts+'.saved';await rename(f.childArtifacts,old);await symlink(old,f.childArtifacts);
  assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},createChildDocumentReadFrame()),code('CHILD_DOCUMENT_STORAGE_UNSAFE_PATH'));
  await rm(f.childArtifacts);await rename(old,f.childArtifacts);
  const saved=f.dbPath+'.saved';await rename(f.dbPath,saved);await symlink(saved,f.dbPath);
  assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},createChildDocumentReadFrame()),code('CHILD_DOCUMENT_STORAGE_UNSAFE_PATH'));
});

test('foreign stored Run owner and foreign oversized index are metadata-only rejections',async t=>{
  const f=await fixture(t);
  f.mutate(db=>db.prepare("UPDATE runs SET data=json_set(data,'$.sessionId','foreign')").run());
  const ownerFrame=createChildDocumentReadFrame();assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},ownerFrame),code('CHILD_DOCUMENT_STORAGE_OWNER_MISMATCH'));assert.equal(ownerFrame.stats().selectedMetadataBytes,0);
  f.mutate(db=>{db.prepare("UPDATE runs SET data=json_set(data,'$.sessionId','child-session')").run();db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');db.prepare("INSERT INTO session_documents(session_id,kind,revision,data)VALUES('foreign','input_documents',1,?)").run('x'.repeat(1_048_576));});
  const foreign=createChildDocumentReadFrame();assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},foreign),code('CHILD_DOCUMENT_STORAGE_FOREIGN_INDEX'));assert.equal(foreign.stats().selectedMetadataBytes,0);
});

test('different Run and malformed schema cannot use a terminal child binding to read JSON',async t=>{
  const f=await fixture(t);f.mutate(db=>db.exec("CREATE VIEW reader_fake AS SELECT 1; DROP TABLE session_documents; CREATE VIEW session_documents AS SELECT * FROM reader_fake"));
  const frame=createChildDocumentReadFrame();assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},frame),code('CHILD_DOCUMENT_STORAGE_INVALID_DATABASE'));assert.equal(frame.stats().selectedMetadataBytes,0);
});

test('mirror binding tamper and row-limit rejection preserve no activation and bounded JSON accounting',async t=>{
  const f=await fixture(t);f.mutate(db=>db.prepare("UPDATE session_documents SET data=json_set(data,'$.binding.nonce','changed') WHERE kind=?").run(CHILD_STORAGE_MIRROR_KIND));
  const frame=createChildDocumentReadFrame(),observation=readChildDocumentIndex({mode:'source',record:f.record},frame);
  assert.equal(observation.status,'unchecked');assert.ok(observation.reasons.some(reason=>/BINDING|MIRROR/u.test(reason)));assert.ok(frame.stats().selectedMetadataBytes<=32_768);
  const rows=createChildDocumentReadFrame({limits:{maxRows:3}});assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},rows),code('CHILD_DOCUMENT_STORAGE_ROW_LIMIT'));assert.equal(rows.stats().selectedMetadataBytes,0);
});

test('historical copied member reads exact mirrored lineage without activating original inode ownership',async t=>{
  const f=await fixture(t),archive=await f.historical(),before=(await readdir(dirname(archive.database.path))).sort();
  await rename(f.childRoot,f.childRoot+'.historical');
  const reader=openChildDocumentReader({mode:'archive-historical',record:f.record,archive},createChildDocumentReadFrame());
  try{assert.deepEqual(reader.readIndex().documentIds,[f.ref.id]);assert.equal(reader.artifactPath,archive.artifacts.path);assert.deepEqual((await readdir(dirname(archive.database.path))).sort(),before);}
  finally{reader.close();}
});

test('archive missing allowlist/hash mismatch is rejected before any selected JSON body',async t=>{
  const f=await fixture(t),archive=await f.historical();
  assert.throws(()=>openChildDocumentReader({mode:'archive-historical',record:f.record,archive:{...archive,allowedMembers:[]}},createChildDocumentReadFrame()),code('CHILD_DOCUMENT_STORAGE_ARCHIVE_SCOPE_INVALID'));
  const frame=createChildDocumentReadFrame(),wrong={...archive,database:{...archive.database,sha256:'0'.repeat(64)},allowedMembers:archive.allowedMembers.map(member=>({...member,sha256:'0'.repeat(64)}))};
  assert.throws(()=>openChildDocumentReader({mode:'archive-historical',record:f.record,archive:wrong},frame),code('CHILD_DOCUMENT_STORAGE_ARCHIVE_HASH_MISMATCH'));assert.equal(frame.stats().selectedMetadataBytes,0);
});

test('reader does not invoke proxy/accessor traps and aborted frame keeps raw mirror count zero',async t=>{
  const f=await fixture(t);let traps=0;const value=new Proxy({mode:'source',record:f.record},{get(){traps++;throw new Error('private fixture');}});
  assert.throws(()=>openChildDocumentReader(value as never,createChildDocumentReadFrame()),code('INVALID_CHILD_DOCUMENT_STORAGE_OPTIONS'));assert.equal(traps,0);
  const controller=new AbortController();controller.abort('private fixture');const frame=createChildDocumentReadFrame({signal:controller.signal});
  assert.throws(()=>openChildDocumentReader({mode:'source',record:f.record},frame),code('CHILD_DOCUMENT_STORAGE_ABORTED'));assert.equal(frame.stats().rawMirrorBytes,0);
});

test('frame has sticky exhaustion and does not reset remaining metadata/reference/row budgets to defaults',()=>{
  const frame=createChildDocumentReadFrame({limits:{maxMetadataBytes:2,maxRefs:1,maxRows:3}});frame.charge(2);assert.equal(frame.remainingMetadataBytes,0);
  assert.throws(()=>frame.charge(1),code('CHILD_DOCUMENT_STORAGE_METADATA_LIMIT'));assert.throws(()=>frame.chargeRefs(0),code('CHILD_DOCUMENT_STORAGE_METADATA_LIMIT'));assert.equal(frame.stats().selectedMetadataBytes,2);
  const refs=createChildDocumentReadFrame({limits:{maxRefs:1}});refs.chargeRefs(1);assert.equal(refs.remainingRefs,0);assert.throws(()=>refs.chargeRefs(1),code('CHILD_DOCUMENT_STORAGE_REFERENCE_LIMIT'));
  const rows=createChildDocumentReadFrame({limits:{maxRows:3}});rows.chargeRows(3);assert.equal(rows.remainingRows,0);assert.throws(()=>rows.chargeRows(1),code('CHILD_DOCUMENT_STORAGE_ROW_LIMIT'));
});
