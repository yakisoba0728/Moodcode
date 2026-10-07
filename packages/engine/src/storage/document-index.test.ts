import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { EngineError, type InputDocumentAttachment } from '@moodcode/contracts';
import { DocumentAttachmentStore } from '../documents/store.js';
import { inspectInputDocumentIndex } from './input-document-index.js';
import { SqliteStore } from './index.js';
const stamp='2026-10-07T00:00:00.000Z';
const code=(expected:string)=>(error:unknown)=>error instanceof EngineError&&error.code===expected;
function fixture(t:TestContext){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'moodcode-document-index-'))),path=join(root,'engine.sqlite'),store=new SqliteStore(path),db=new DatabaseSync(path);
  store.putWorkspace({id:'workspace',root,gitRoot:root,branch:null,createdAt:stamp});const session=(id:string)=>store.createSession({id,workspaceId:'workspace',title:id,createdAt:stamp});session('session');
  const document=(id:string,documents:InputDocumentAttachment[])=>({version:1,owner:{sessionId:id,workspaceId:'workspace',workspaceRoot:root},documents:documents.map(ref=>({...ref}))});
  const put=(id:string,documents:InputDocumentAttachment[])=>store.putSessionDocument(id,'input_documents',0,document(id,documents));
  const ref=(digit:string)=>({id:'doc_'+digit.repeat(32),kind:'document' as const,mimeType:'application/pdf' as const,bytes:9,sha256:'a'.repeat(64)});
  const inspect=(options?:Parameters<typeof inspectInputDocumentIndex>[1])=>{db.exec('BEGIN');try{return inspectInputDocumentIndex(db,options);}finally{db.exec('ROLLBACK');}};
  t.after(()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});});return{root,path,store,db,session,document,put,ref,inspect};
}
test('primary PDF index reports exact metadata/provenance while never reading document bytes or other journals',async t=>{
  const f=fixture(t),bytes=Buffer.from('%PDF-1.7\nprivate content'),ref=await new DocumentAttachmentStore({directory:join(f.root,'artifacts','input-documents'),documents:f.store}).import('session',bytes);
  f.store.putSessionDocument('session','other_private_document',0,{private:'do not inspect'});const before=f.db.prepare('SELECT * FROM session_documents ORDER BY kind').all(),beforeEvents=f.db.prepare('SELECT * FROM session_events').all();
  const report=f.inspect();assert.equal(report.complete,true);assert.deepEqual(report.documentIds,[ref.id]);assert.equal(report.declaredBytes,bytes.length);assert.deepEqual(report.documents,[{sessionId:'session',workspaceId:'workspace',workspaceRoot:f.root,revision:1,referenceCount:1}]);assert.equal(report.coverage.filesystem,'not-read');assert.equal(report.coverage.childDatabases,'not-read');assert.equal(report.coverage.physicalReadBytes,null);
  assert.ok(!JSON.stringify(report).includes(bytes.toString('base64')));assert.deepEqual(f.db.prepare('SELECT * FROM session_documents ORDER BY kind').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM session_events').all(),beforeEvents);
});
test('invalid JSON, owner, version, format and duplicate references make inspection incomplete',t=>{
  const f=fixture(t),ref=f.ref('1');f.put('session',[ref]);
  for(const raw of ['broken JSON',JSON.stringify({...f.document('session',[ref]),version:2}),JSON.stringify(f.document('foreign-session',[ref])),JSON.stringify(f.document('session',[{...ref,mimeType:'image/png'} as unknown as InputDocumentAttachment])),JSON.stringify(f.document('session',[ref,ref]))]){
    f.db.prepare("UPDATE session_documents SET data=? WHERE kind='input_documents'").run(raw);const report=f.inspect();assert.equal(report.complete,false);assert.equal(report.invalidDocuments,1);assert.deepEqual(report.documentIds,[]);
  }
});
test('foreign duplicate generated document IDs across indexes fail closed',t=>{
  const f=fixture(t),ref=f.ref('1');f.put('session',[ref]);f.session('other-session');f.put('other-session',[ref]);const report=f.inspect();assert.equal(report.complete,false);assert.equal(report.invalidDocuments,1);assert.equal(report.invalidReferences,1);
});
test('document/reference/UTF8 bounds disclose incomplete coverage rather than permitting orphan inference',t=>{
  const f=fixture(t);f.put('session',[f.ref('1')]);f.session('other-session');f.put('other-session',[f.ref('2')]);
  const docs=f.inspect({maxDocuments:1});assert.equal(docs.complete,false);assert.equal(docs.omittedDocuments,1);assert.equal(docs.omittedReferences,null);
  const refs=f.inspect({maxRefs:1});assert.equal(refs.complete,false);assert.equal(refs.omittedReferences,1);assert.equal(refs.documentIds.length,1);
  const bytes=f.inspect({maxJsonBytes:1});assert.equal(bytes.complete,false);assert.equal(bytes.sampledJsonBytes,0);assert.equal(bytes.omittedDocuments,2);assert.equal(bytes.omittedReferences,null);
});
test('oversized owner/index bodies are rejected by metadata before any data payload reaches JS',t=>{
  const f=fixture(t);f.put('session',[f.ref('1')]);f.db.prepare("UPDATE sessions SET data=? WHERE id='session'").run(JSON.stringify({private:'x'.repeat(20000)}));
  const original=f.db.prepare.bind(f.db);let rawQueries=0;f.db.prepare=((sql:string)=>{if(sql.includes('s.data AS session_data'))rawQueries++;return original(sql);}) as typeof f.db.prepare;
  const report=f.inspect();assert.equal(report.complete,false);assert.equal(report.invalidDocuments,1);assert.equal(report.sampledJsonBytes,0);assert.equal(rawQueries,0);
});
test('unsafe revision and opaque large rowid retain honest metadata coverage',t=>{
  const f=fixture(t),ref=f.ref('1');f.put('session',[ref]);f.db.prepare("UPDATE session_documents SET revision=? WHERE kind='input_documents'").run(9007199254740992n);assert.equal(f.inspect().complete,false);
  f.db.prepare("UPDATE session_documents SET revision=1,rowid=? WHERE kind='input_documents'").run(9007199254740992n);assert.equal(f.inspect().complete,true);assert.deepEqual(f.inspect().documentIds,[ref.id]);
});
test('cancel/options invalid/proxy boundaries fail before query or trap',t=>{
  const f=fixture(t),controller=new AbortController();controller.abort();assert.throws(()=>f.inspect({signal:controller.signal}),code('CANCELLED'));
  for(const value of [{maxDocuments:65},{maxJsonBytes:0},{signal:{}},{unknown:1}])assert.throws(()=>f.inspect(value as Parameters<typeof inspectInputDocumentIndex>[1]),code('INVALID_DOCUMENT_INDEX_OPTIONS'));
  let traps=0;const proxy=new Proxy({},{get(){traps++;throw new Error('trap');},getPrototypeOf(){traps++;throw new Error('trap');}});assert.throws(()=>f.inspect(proxy),code('INVALID_DOCUMENT_INDEX_OPTIONS'));assert.equal(traps,0);
});
