import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EngineError } from '@moodcode/contracts';
import { SqliteStore } from '../storage/index.js';
import { DocumentAttachmentStore, INPUT_DOCUMENT_KIND, type DocumentDocuments } from './store.js';
import { digest, type DocumentLimits } from './validation.js';
const pdf=()=>Buffer.from('%PDF-1.7\nOpaque fixture bytes, not a parsed document.\n');
const code=(expected:string)=>(error:unknown)=>{assert.ok(error instanceof EngineError);assert.equal(error.code,expected);assert.equal(error.details,undefined);assert.equal(error.cause,undefined);return true;};
async function fixture(t:TestContext,limits?:Partial<DocumentLimits>){
  const root=await realpath(await mkdtemp(join(tmpdir(),'moodcode-documents-'))),directory=join(root,'artifacts','input-documents'),dbPath=join(root,'engine.sqlite'),documents=new SqliteStore(dbPath);
  for(const id of ['workspace','other-workspace'])documents.putWorkspace({id,root:join(root,id),gitRoot:join(root,id),branch:null,createdAt:new Date().toISOString()});
  for(const [id,workspaceId]of [['session','workspace'],['same-workspace-session','workspace'],['other-session','other-workspace']] as const)documents.createSession({id,workspaceId,title:id,createdAt:new Date().toISOString()});
  t.after(()=>{documents.close();return rm(root,{recursive:true,force:true});});
  const port:DocumentDocuments={getSession:id=>documents.getSession(id),getWorkspace:id=>documents.getWorkspace(id),getSessionDocument:(id,kind)=>documents.getSessionDocument(id,kind),putSessionDocument:(id,kind,revision,data)=>documents.putSessionDocument(id,kind,revision,data)};
  return{root,directory,dbPath,documents,port,store:new DocumentAttachmentStore({directory,documents,limits})};
}
test('PDF refs store metadata only and survive reopening the actual SQLite database',async t=>{
  const f=await fixture(t),bytes=pdf(),ref=await f.store.import('session',bytes);
  assert.match(ref.id,/^doc_[a-f0-9]{32}$/u);assert.equal(ref.sha256,digest(bytes));assert.equal(ref.bytes,bytes.length);
  const index=f.documents.getSessionDocument('session',INPUT_DOCUMENT_KIND)!;assert.deepEqual(index.data.documents,[ref]);assert.equal(index.revision,1);assert.deepEqual(index.data.owner,{sessionId:'session',workspaceId:'workspace',workspaceRoot:join(f.root,'workspace')});
  assert.ok(!JSON.stringify(index).includes(bytes.toString('base64')));assert.equal((await lstat(join(f.directory,ref.id+'.blob'))).mode&0o777,0o600);
  f.documents.close();const reopened=new SqliteStore(f.dbPath);t.after(()=>reopened.close());
  assert.deepEqual(await new DocumentAttachmentStore({directory:f.directory,documents:reopened}).resolve('session',[ref]),[{attachment:ref,data:bytes.toString('base64')}]);
});
test('import captures caller bytes before await and returned refs cannot mutate durable metadata',async t=>{
  const f=await fixture(t),bytes=pdf(),expected=Buffer.from(bytes),pending=f.store.import('session',bytes);bytes.fill(0);const ref=await pending,copy={...ref};ref.sha256='0'.repeat(64);
  assert.deepEqual(Buffer.from((await f.store.resolve('session',[copy]))[0]!.data,'base64'),expected);await assert.rejects(f.store.resolve('session',[ref]),code('RECORD_SCOPE_MISMATCH'));
});
for(const session of ['same-workspace-session','other-session'])test(`document cannot be resolved by ${session}`,async t=>{const f=await fixture(t),ref=await f.store.import('session',pdf());await assert.rejects(f.store.resolve(session,[ref]),code('RECORD_SCOPE_MISMATCH'));});
test('minimal signature and storage quotas fail before visible refs; input count stays one',async t=>{
  const f=await fixture(t,{maxSessionDocuments:2,maxSessionBytes:pdf().length*2});await assert.rejects(f.store.import('session',Buffer.from('private-not-pdf')),code('DOCUMENT_INVALID_FORMAT'));
  const a=await f.store.import('session',pdf()),b=await f.store.import('session',pdf());await assert.rejects(f.store.resolve('session',[a,b]),code('DOCUMENT_LIMIT_EXCEEDED'));await assert.rejects(f.store.import('session',pdf()),code('DOCUMENT_LIMIT_EXCEEDED'));assert.equal((await readdir(f.directory)).length,2);
});
test('session byte cap cleans unpublished blob without removing existing content',async t=>{const f=await fixture(t,{maxSessionBytes:pdf().length});const ref=await f.store.import('session',pdf());await assert.rejects(f.store.import('session',pdf()),code('DOCUMENT_LIMIT_EXCEEDED'));assert.deepEqual(await readdir(f.directory),[ref.id+'.blob']);});
test('size/hash/missing blob and symlink/hardlink substitutions fail closed',async t=>{
  const f=await fixture(t),bytes=pdf(),ref=await f.store.import('session',bytes),path=join(f.directory,ref.id+'.blob');const changed=Buffer.from(bytes);changed[12]=42;await writeFile(path,changed);await assert.rejects(f.store.resolve('session',[ref]),code('DOCUMENT_INTEGRITY_FAILED'));
  await writeFile(path,Buffer.concat([bytes,Buffer.from('growth')]));await assert.rejects(f.store.resolve('session',[ref]),code('DOCUMENT_INTEGRITY_FAILED'));await rm(path);await assert.rejects(f.store.resolve('session',[ref]),code('DOCUMENT_STORAGE_FAILED'));
  const outside=join(f.root,'private.pdf');await writeFile(outside,bytes);await symlink(outside,path);await assert.rejects(f.store.resolve('session',[ref]),code('DOCUMENT_PATH_UNSAFE'));assert.deepEqual(await readFile(outside),bytes);await rm(path);await link(outside,path);await assert.rejects(f.store.resolve('session',[ref]),code('DOCUMENT_PATH_UNSAFE'));
});
test('owner and hash poisoning fail without granting cross-session refs',async t=>{
  const f=await fixture(t),ref=await f.store.import('session',pdf()),before=f.documents.getSessionDocument('session',INPUT_DOCUMENT_KIND)!;
  f.documents.putSessionDocument('session',INPUT_DOCUMENT_KIND,before.revision,{...before.data,owner:{sessionId:'other-session',workspaceId:'workspace',workspaceRoot:join(f.root,'workspace')}});await assert.rejects(f.store.resolve('session',[ref]),code('RECORD_SCOPE_MISMATCH'));
  f.documents.putSessionDocument('session',INPUT_DOCUMENT_KIND,before.revision+1,{...before.data,documents:[{...ref,sha256:'0'.repeat(64)}]});await assert.rejects(f.store.resolve('session',[ref]),code('RECORD_SCOPE_MISMATCH'));await assert.rejects(f.store.resolve('session',[{...ref,sha256:'0'.repeat(64)}]),code('DOCUMENT_INTEGRITY_FAILED'));
});
for(const replacement of ['symlink','directory'])test(`replaced pinned root (${replacement}) never serves document bytes`,async t=>{
  const f=await fixture(t),ref=await f.store.import('session',pdf());await rename(f.directory,f.directory+'-old');if(replacement==='symlink')await symlink(f.directory+'-old',f.directory);else await mkdir(f.directory);
  await assert.rejects(f.store.resolve('session',[ref]),code('DOCUMENT_PATH_UNSAFE'));await assert.rejects(f.store.import('session',pdf()),code('DOCUMENT_PATH_UNSAFE'));
});
test('cancel before CAS cleans own blob; cancel immediately after durable CAS returns receipt',async t=>{
  const f=await fixture(t),before=new AbortController();before.abort();await assert.rejects(f.store.import('session',pdf(),before.signal),code('DOCUMENT_CANCELLED'));
  const controller=new AbortController();let owners=0;const pre=new DocumentAttachmentStore({directory:f.directory,documents:{...f.port,getSession:id=>{if(++owners===2)controller.abort();return f.documents.getSession(id);}}});await assert.rejects(pre.import('session',pdf(),controller.signal),code('DOCUMENT_CANCELLED'));assert.equal(f.documents.getSessionDocument('session',INPUT_DOCUMENT_KIND),null);assert.deepEqual(await readdir(f.directory),[]);
  const after=new AbortController(),post=new DocumentAttachmentStore({directory:f.directory,documents:{...f.port,putSessionDocument:(id,kind,revision,data)=>{const result=f.documents.putSessionDocument(id,kind,revision,data);after.abort();return result;}}});const ref=await post.import('session',pdf(),after.signal);assert.equal((await f.store.resolve('session',[ref])).length,1);
});
test('CAS exhaustion has bounded retries and releases only its generated file',async t=>{
  const f=await fixture(t);let attempts=0;const store=new DocumentAttachmentStore({directory:f.directory,documents:{...f.port,putSessionDocument:()=>{attempts++;throw new EngineError('REVISION_CONFLICT','private implementation');}}});await assert.rejects(store.import('session',pdf()),code('REVISION_CONFLICT'));assert.equal(attempts,8);assert.deepEqual(await readdir(f.directory),[]);
});
test('concurrent hosts preserve both document refs while per-input resolution remains one',async t=>{
  const f=await fixture(t),second=new DocumentAttachmentStore({directory:f.directory,documents:f.documents}),refs=await Promise.all([f.store.import('session',pdf()),second.import('session',pdf())]);assert.equal(f.documents.getSessionDocument('session',INPUT_DOCUMENT_KIND)!.revision,2);for(const ref of refs)assert.equal((await f.store.resolve('session',[ref])).length,1);
});
test('late resolve cancellation never releases pixels or document content',async t=>{
  const f=await fixture(t),ref=await f.store.import('session',pdf()),controller=new AbortController();let owners=0;const store=new DocumentAttachmentStore({directory:f.directory,documents:{...f.port,getSession:id=>{if(++owners===2)controller.abort();return f.documents.getSession(id);}}});await assert.rejects(store.resolve('session',[ref],controller.signal),code('DOCUMENT_CANCELLED'));assert.equal(owners,2);
});
test('host options, index and ref proxies fail before invoking user traps',async t=>{
  const f=await fixture(t),ref=await f.store.import('session',pdf());let traps=0;const trap={get(){traps++;throw new Error('private trap');},getPrototypeOf(){traps++;throw new Error('private trap');}};
  assert.throws(()=>new DocumentAttachmentStore(new Proxy({directory:f.directory,documents:f.documents},trap)),code('DOCUMENT_INVALID_CONFIG'));
  await assert.rejects(f.store.resolve('session',[new Proxy(ref,trap)]),code('DOCUMENT_INVALID_REFERENCE'));
  const store=new DocumentAttachmentStore({directory:f.directory,documents:{...f.port,getSessionDocument:()=>new Proxy({revision:1,data:{}},trap)}});await assert.rejects(store.resolve('session',[ref]),code('DOCUMENT_INVALID_INDEX'));assert.equal(traps,0);
});
