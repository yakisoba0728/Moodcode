import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { EngineError, type JsonObject } from '@moodcode/contracts';
import type { GrantDocumentPort } from '../permission/grants.js';
import type { ChildTaskRecord } from './index.js';
import type { ManagedWorktree } from '../worktrees/index.js';
import { admitChildStorageBinding, CHILD_STORAGE_MIRROR_KIND, childRequestFingerprint, childRequestKind, childStorageBindingSha256, childStorageKind, childStoragePhysicalIdentity, confirmChildStorageClosed, prepareChildStorageBinding, readChildStorageSelection, validateChildStorageRecord, type ChildStorageRecord } from './storage-binding.js';

class Documents implements GrantDocumentPort {
  records = new Map<string, { revision: number; data: JsonObject }>();
  failWrite = false;
  getSessionDocument(sessionId: string, kind: string) { return structuredClone(this.records.get(JSON.stringify([sessionId,kind])) ?? null); }
  putSessionDocument(sessionId: string, kind: string, expectedRevision: number, data: JsonObject) {
    if (this.failWrite) throw new EngineError('FIXTURE_WRITE_FAILED', 'Authored failed mirror write');
    const key = JSON.stringify([sessionId,kind]), prior = this.records.get(key);
    if ((prior?.revision ?? 0) !== expectedRevision) throw new EngineError('REVISION_CONFLICT', 'Fixture CAS mismatch');
    const result = { revision: expectedRevision + 1, data: structuredClone(data) }; this.records.set(key,result); return structuredClone(result);
  }
}
function fixture(t: import('node:test').TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moodcode-storage-binding-'))), artifacts = join(directory,'artifacts'), children = join(artifacts,'children');
  const taskId = `child_${'1'.repeat(32)}`, worktreeId = `worktree_${'2'.repeat(32)}`, worktreeRoot = join(children,'worktrees',worktreeId), childBase = join(children,taskId);
  mkdirSync(join(childBase,'artifacts'),{recursive:true}); mkdirSync(worktreeRoot,{recursive:true});
  for (const file of [join(directory,'engine.sqlite'),join(childBase,'engine.sqlite'),join(childBase,'engine.sqlite.owner.sqlite')]) writeFileSync(file,'Authored physical fixture');
  const root = new Documents(), child = new Documents(), timestamp = new Date().toISOString();
  const task: ChildTaskRecord = { id:taskId, requestId:'child-request',sessionId:'root-session',parentRunId:'root-run',rootRunId:'root-run',depth:1,worktreeId,toolNames:[],budget:{turns:1,toolCalls:1,outputBytes:512,durationMs:1000},state:'starting',fingerprint:'a'.repeat(64),createdAt:timestamp,updatedAt:timestamp,deliveryState:'none',deliveryRequestId:'child-delivery' };
  const worktreeIdentity = childStoragePhysicalIdentity(worktreeRoot,true);
  const worktree: ManagedWorktree = { id:worktreeId,requestId:'worktree-request',sessionId:task.sessionId,workspaceId:'root-workspace',baseRoot:directory,root:worktreeRoot,baseCommit:'b'.repeat(40),reference:'HEAD',state:'ready',revision:1,createdAt:timestamp,updatedAt:timestamp,fingerprint:'c'.repeat(64),device:worktreeIdentity.dev,inode:worktreeIdentity.ino,ownerId:taskId };
  const hostIdentity = { database:childStoragePhysicalIdentity(join(directory,'engine.sqlite')),artifacts:childStoragePhysicalIdentity(artifacts,true) };
  const input = { task,requestFingerprint:'d'.repeat(64),hostIdentity,childrenDirectory:children,worktree,workspace:{id:`workspace_${createHash('sha256').update(worktreeRoot).digest('hex')}`,root:worktreeRoot,gitRoot:worktreeRoot,branch:null,createdAt:timestamp},childSessionId:'child-session' };
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workspaces(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace_id TEXT,data TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,session_id TEXT,workspace_id TEXT,data TEXT); CREATE TABLE session_documents(session_id TEXT,kind TEXT,revision INTEGER,data TEXT,PRIMARY KEY(session_id,kind));');
  db.prepare('INSERT INTO workspaces VALUES(?,?)').run('root-workspace',JSON.stringify({id:'root-workspace'}));
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(task.sessionId,'root-workspace',JSON.stringify({id:task.sessionId,workspaceId:'root-workspace'}));
  db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('root-run',task.sessionId,'root-workspace',JSON.stringify({id:'root-run',sessionId:task.sessionId,workspaceId:'root-workspace'}));
  const put = (kind: string,data: unknown) => db.prepare('INSERT OR REPLACE INTO session_documents VALUES(?,?,1,?)').run(task.sessionId,kind,JSON.stringify(data));
  function persist(record?: ChildStorageRecord) {
    put('engine.child_tasks',{schemaVersion:1,tasks:[task],pools:[]}); put('engine.worktrees',{schemaVersion:1,records:[worktree]}); put(`child.request.${createHash('sha256').update(JSON.stringify(task.requestId)).digest('hex').slice(0,32)}`,{fingerprint:input.requestFingerprint}); if (record) put(childStorageKind(task.id),record);
  }
  const options = {sessionId:task.sessionId,sourceRunId:'root-run',taskIds:[task.id],hostIdentity,childrenDirectory:children};
  t.after(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return {root,child,task,worktree,input,db,put,persist,options};
}
function closed(t: import('node:test').TestContext) {
  const value = fixture(t), prepared = prepareChildStorageBinding(value.root,value.child,value.input), admitted = admitChildStorageBinding(value.root,value.child,prepared,'child-run'), record = confirmChildStorageClosed(value.root,admitted);
  value.task.state = 'completed'; value.task.childRunId = 'child-run'; delete value.worktree.ownerId; value.persist(record); return {...value,prepared,admitted,record};
}
test('child request keys, request fingerprints and binding digests keep their persisted bytes',()=>{
  assert.equal(childRequestKind('child-request'),'child.request.0c2e0f00f4da3e8cf1747a6bdcbd476e');
  assert.equal(childRequestKind('\u00e9"\u{1f600}'),'child.request.f8f6e80e0246d8dc97899e0a0204d5fe');
  const request = { sessionId:'root-session',requestId:'child-request',parentRunId:'root-run',worktreeId:`worktree_${'2'.repeat(32)}`,prompt:'Read \u00e9 and \u{1f600}',tools:['read_file'],allocation:{turns:1,toolCalls:1,outputBytes:512,durationMs:1000} };
  assert.equal(childRequestFingerprint(request),'8c9848794d2fb7336719e6125b7bc85aa5505277785a14c087be162424a885ed');
  assert.equal(childStorageBindingSha256({schemaVersion:1,nonce:'n',phase:'prepared',lineage:{b:2,a:1}} as unknown as ChildStorageRecord['binding']),'0f4fb70152c18d0d64a89b1f73d7fb1cb49b5c6c0ddd74bc2323d28c04dbedd2');
});
test('prepared/admitted mirror and root-only close proof preserve the immutable admitted digest',t=>{
  const value = closed(t);
  assert.equal(value.prepared.binding.phase,'prepared'); assert.equal(value.prepared.binding.child.runId,undefined);
  assert.equal(value.admitted.binding.phase,'admitted'); assert.equal(value.admitted.binding.child.runId,'child-run');
  assert.equal(value.prepared.binding.nonce,value.admitted.binding.nonce); assert.notEqual(value.prepared.sha256,value.admitted.sha256);
  const mirror = validateChildStorageRecord(value.child.getSessionDocument('child-session',CHILD_STORAGE_MIRROR_KIND)!.data);
  assert.deepEqual(mirror,value.admitted); assert.equal(mirror.confirmedClose,undefined); assert.equal(value.record.sha256,mirror.sha256);
  assert.equal(value.record.confirmedClose!.method,'engine-close-resolved'); assert.equal(value.record.confirmedClose!.bindingSha256,mirror.sha256);
  const report = readChildStorageSelection(value.db,value.options);
  assert.equal(report.complete,true); assert.equal(report.selections[0]!.status,'eligible'); assert.equal(report.physicalIO,null);
});
test('failed mirror prepare remains an explicit partial intent and cannot be silently backfilled',t=>{
  const value = fixture(t); value.child.failWrite = true;
  assert.throws(()=>prepareChildStorageBinding(value.root,value.child,value.input),{code:'FIXTURE_WRITE_FAILED'});
  const prepared = validateChildStorageRecord(value.root.getSessionDocument(value.task.sessionId,childStorageKind(value.task.id))!.data);
  assert.equal(prepared.binding.phase,'prepared'); assert.equal(value.child.getSessionDocument('child-session',CHILD_STORAGE_MIRROR_KIND),null);
  value.child.failWrite = false;
  assert.throws(()=>admitChildStorageBinding(value.root,value.child,prepared,'child-run'),{code:'CHILD_STORAGE_BINDING_INVALID'});
  assert.throws(()=>prepareChildStorageBinding(value.root,value.child,value.input),{code:'REVISION_CONFLICT'});
});
test('failed admitted mirror write does not manufacture close proof or hide the two-DB phase difference',t=>{
  const value = fixture(t), prepared = prepareChildStorageBinding(value.root,value.child,value.input); value.child.failWrite = true;
  assert.throws(()=>admitChildStorageBinding(value.root,value.child,prepared,'child-run'),{code:'FIXTURE_WRITE_FAILED'});
  const root = validateChildStorageRecord(value.root.getSessionDocument(value.task.sessionId,childStorageKind(value.task.id))!.data);
  const mirror = validateChildStorageRecord(value.child.getSessionDocument('child-session',CHILD_STORAGE_MIRROR_KIND)!.data);
  assert.equal(root.binding.phase,'admitted'); assert.equal(mirror.binding.phase,'prepared'); assert.equal(root.confirmedClose,undefined);
});
test('binding parser rejects coercion, proxies, digest drift and path traversal without invoking supplied code',t=>{
  const value = closed(t); let traps = 0;
  const invalid = structuredClone(value.record) as unknown as {binding:Record<string,unknown>}; invalid.binding.phase = {toString(){traps++; return 'admitted';}};
  assert.throws(()=>validateChildStorageRecord(invalid),{code:'CHILD_STORAGE_BINDING_INVALID'});
  assert.throws(()=>validateChildStorageRecord(new Proxy(value.record,{getPrototypeOf(){traps++; return Object.prototype;}})),{code:'CHILD_STORAGE_BINDING_INVALID'});
  const accessor = {...value.record}; Object.defineProperty(accessor,'binding',{enumerable:true,get(){traps++; return value.record.binding;}});
  assert.throws(()=>validateChildStorageRecord(accessor),{code:'CHILD_STORAGE_BINDING_INVALID'}); assert.equal(traps,0);
  const drift = structuredClone(value.record); drift.binding.child.sessionId = 'changed-session'; assert.throws(()=>validateChildStorageRecord(drift),{code:'CHILD_STORAGE_BINDING_INVALID'});
  const traversal = structuredClone(value.record); traversal.binding.relativePaths.database = '../engine.sqlite'; assert.throws(()=>validateChildStorageRecord(traversal),{code:'CHILD_STORAGE_BINDING_INVALID'});
});
test('selection classifies active, legacy, foreign, uncertain and copied scope before any child path is opened',t=>{
  const value = closed(t);
  value.task.state = 'running'; value.persist(value.record); assert.equal(readChildStorageSelection(value.db,value.options).selections[0]!.status,'active');
  value.task.state = 'uncertain'; value.persist(value.record); assert.equal(readChildStorageSelection(value.db,value.options).selections[0]!.status,'unconfirmed');
  value.task.state = 'completed'; value.persist(value.record);
  const copied = {...value.options,hostIdentity:{...value.options.hostIdentity,database:{...value.options.hostIdentity.database,ino:'999999'}}};
  assert.equal(readChildStorageSelection(value.db,copied).selections[0]!.status,'relocated');
  value.task.rootRunId = 'other-run'; value.persist(value.record); assert.equal(readChildStorageSelection(value.db,value.options).selections[0]!.status,'foreign');
  value.task.rootRunId = 'root-run'; value.persist(); value.db.prepare('DELETE FROM session_documents WHERE kind=?').run(childStorageKind(value.task.id));
  assert.equal(readChildStorageSelection(value.db,value.options).selections[0]!.status,'legacy');
});
test('archive-historical mode retains original physical proof and never promotes copied worktree ownership',t=>{
  const value = closed(t); value.worktree.root = '/restored/artifacts/children/worktrees/'+value.worktree.id; value.worktree.state = 'uncertain'; value.worktree.relocation = {archiveId:'archive',manifestSha256:'e'.repeat(64),originalRoot:value.record.binding.worktree.root,ownershipVerified:false}; value.persist(value.record);
  assert.equal(readChildStorageSelection(value.db,value.options).selections[0]!.status,'relocated');
  const historical = readChildStorageSelection(value.db,{...value.options,mode:'archive-historical'});
  assert.equal(historical.selections[0]!.status,'historical'); assert.deepEqual(historical.selections[0]!.record!.binding.physical,value.record.binding.physical); assert.equal(value.worktree.relocation.ownershipVerified,false);
});
test('empty selection validates owner without requiring journals and malformed owner scalars stay in SQL',t=>{
  const value = fixture(t); assert.equal(readChildStorageSelection(value.db,{...value.options,taskIds:[]}).complete,true);
  value.db.prepare('UPDATE runs SET data=?').run(JSON.stringify({id:'x'.repeat(9*1024*1024),sessionId:value.task.sessionId,workspaceId:'root-workspace'}));
  assert.throws(()=>readChildStorageSelection(value.db,{...value.options,taskIds:[]}),{code:'CHILD_STORAGE_OWNER_MISMATCH'});
});
test('shared metadata budget, cancellation and sparse filters reject before selected bodies',t=>{
  const value = closed(t); let charged = 0, bodies = 0;
  const prepare = value.db.prepare.bind(value.db);
  value.db.prepare = ((sql:string)=>{if(sql.startsWith('SELECT data FROM session_documents'))bodies++; return prepare(sql);}) as typeof value.db.prepare;
  const report = readChildStorageSelection(value.db,value.options,{get remainingMetadataBytes(){return 256-charged;},charge(bytes){charged+=bytes;}});
  assert.equal(report.complete,false); assert.equal(report.selections[0]!.status,'limit'); assert.equal(bodies,0); assert.ok(charged<256);
  const abort = new AbortController(); abort.abort(); assert.throws(()=>readChildStorageSelection(value.db,{...value.options,signal:abort.signal}),{code:'CANCELLED'});
  const sparse = Array(1) as string[]; assert.throws(()=>readChildStorageSelection(value.db,{...value.options,taskIds:sparse}),{code:'CHILD_STORAGE_BINDING_INVALID'});
});
test('changed-size body after budget callback never crosses the SQL-to-JS boundary',t=>{
  const value = closed(t); let bodyBytes = 0;
  const prepare = value.db.prepare.bind(value.db);
  value.db.prepare = ((sql:string)=>{const statement=prepare(sql);if(sql.startsWith('SELECT data FROM session_documents')){const get=statement.get.bind(statement);statement.get=((...args:Parameters<typeof get>)=>{const row=get(...args);if(typeof row?.data==='string')bodyBytes+=Buffer.byteLength(row.data);return row;}) as typeof statement.get;}return statement;}) as typeof value.db.prepare;
  let charges = 0;
  const report = readChildStorageSelection(value.db,value.options,{charge(){if(++charges===2)value.put('engine.child_tasks',{schemaVersion:1,tasks:['x'.repeat(9*1024*1024)]});}});
  assert.equal(report.complete,false); assert.equal(report.selections[0]!.status,'invalid'); assert.equal(bodyBytes,0);
});
test('nested root-manager flat storage binds the immediate child Run and rejects ancestry drift',t=>{
  const value = closed(t), taskId = `child_${'3'.repeat(32)}`, worktreeId = `worktree_${'4'.repeat(32)}`, root = join(value.input.childrenDirectory,'worktrees',worktreeId), base = join(value.input.childrenDirectory,taskId);
  mkdirSync(root,{recursive:true}); mkdirSync(join(base,'artifacts'),{recursive:true}); writeFileSync(join(base,'engine.sqlite'),'Authored nested primary'); writeFileSync(join(base,'engine.sqlite.owner.sqlite'),'Authored nested owner');
  const identity = childStoragePhysicalIdentity(root,true);
  const task: ChildTaskRecord = {...value.task,id:taskId,requestId:'grandchild-request',parentTaskId:value.task.id,parentRunId:'child-run',depth:2,worktreeId,state:'starting',fingerprint:'f'.repeat(64)}; delete task.childRunId;
  const worktree: ManagedWorktree = {...value.worktree,id:worktreeId,requestId:'nested-worktree',workspaceId:value.input.workspace.id,baseRoot:value.worktree.root,root,ownerId:taskId,device:identity.dev,inode:identity.ino};
  const workspace = {...value.input.workspace,id:`workspace_${createHash('sha256').update(root).digest('hex')}`,root,gitRoot:root};
  const child = new Documents(), prepared = prepareChildStorageBinding(value.root,child,{...value.input,task,worktree,workspace,childSessionId:'grandchild-session'}), admitted = admitChildStorageBinding(value.root,child,prepared,'grandchild-run'), record = confirmChildStorageClosed(value.root,admitted);
  task.state = 'completed'; task.childRunId = 'grandchild-run'; delete worktree.ownerId;
  value.put('engine.child_tasks',{schemaVersion:1,tasks:[value.task,task],pools:[]}); value.put('engine.worktrees',{schemaVersion:1,records:[value.worktree,worktree]}); value.put(childStorageKind(taskId),record);
  value.put(`child.request.${createHash('sha256').update(JSON.stringify(task.requestId)).digest('hex').slice(0,32)}`,{fingerprint:value.input.requestFingerprint});
  const report = readChildStorageSelection(value.db,{...value.options,taskIds:[taskId]});
  assert.equal(report.selections[0]!.status,'eligible',JSON.stringify(report)); assert.equal(record.binding.physical.database.path,join(value.input.childrenDirectory,taskId,'engine.sqlite'));
  value.task.childRunId = 'wrong-parent-run'; value.put('engine.child_tasks',{schemaVersion:1,tasks:[value.task,task],pools:[]});
  assert.equal(readChildStorageSelection(value.db,{...value.options,taskIds:[taskId]}).selections[0]!.status,'invalid');
});
